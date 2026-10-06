/**
 * The demo sequence engine. It moves enrollments through their sequence graph the way the real planner does, on
 * fictional leads: every executed step writes an `outreach_actions` row (sent / skipped / failed), messages land in the
 * lead's conversation, invitations are accepted and leads reply at fixed seeded rates. The seed runs it over the last
 * 60 days to build the history; the simulator (./clock.ts) runs it as the demo's time moves.
 *
 * Rates (docs/outreach/PRODUCT-TOUR.md §4.4): accepted 38%, reply after a message 14%, email opened 55%, bounced 2%,
 * follow-back 30%. Daily caps and working hours are respected (./caps.ts), so "Why not sending" has real answers.
 */
import { nodeExits } from '../../../nodes';
import type { DemoStore, Row } from '../store';
import { inSchedule, Ledger, localParts, simWallClock } from './caps';
import { renderFor } from './render';
import { FOLLOW_UP_REPLIES, INTENT_WEIGHTS, REPLY_BANK, SUMMARIES, type ReplyIntent } from './replies';

export const RATES = { accept: 0.38, reply: 0.14, open: 0.55, bounce: 0.02, followBack: 0.3, answerAgain: 0.3 };

export const LIVE = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'];
const RUNNABLE = new Set(['active', 'waiting_connection', 'waiting_delay']);
const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);
const H = 3_600_000;
const D = 86_400_000;

/** Internal table of things that happen later (a reply arriving). Shifts with the clock like every timestamp. */
export const EVENTS = '_demo_sim_events';

const ACTION_OF: Record<string, string> = {
  visit_profile: 'profile_view', refresh_profile: 'profile_view', like_latest_post: 'like', comment_latest_post: 'comment', endorse_skills: 'endorse',
  follow_profile: 'follow', follow: 'follow', unfollow: 'unfollow', like_recent_posts: 'like', comment_post: 'comment', find_email: 'find_email',
  check_identifier: 'identifier_check', call_api: 'call_api',
};

/** Steps that send something a person receives: the planner gives these a time ahead (Sent · Scheduled lists them). */
const SEND_STEP: Record<string, string> = { send_invite: 'invite', send_message: 'message', send_inmail: 'inmail', send_voice_note: 'message', send_email: 'email' };
const SLOT_STEP = 15 * 60_000;

type Hook = (store: DemoStore, info: { chat: Row; message: Row; lead: Row | undefined; enrollment: Row | undefined; intent: ReplyIntent }) => void;
/** Other areas react to the simulation (AI drafts on a reply, notifications …) by adding a hook here. */
export const simHooks: { onReply: Hook[]; onSent: Array<(store: DemoStore, action: Row) => void> } = { onReply: [], onSent: [] };

const iso = (ms: number) => new Date(ms).toISOString();

export class Engine {
  ledger: Ledger;
  /** Actions done per sender in the current run, for pacing inside one clock step. */
  private perRun = new Map<string, number>();
  private chatSeq: number;
  /** Queued actions by `enrollment|node` (the planner's open slots), so the engine never scans the whole actions table. */
  private queuedIdx: Map<string, Row> | null = null;
  private chatIdx: Map<string, Row> | null = null;

  constructor(private store: DemoStore) {
    this.ledger = new Ledger(store);
    this.chatSeq = store.meta('chatSeq', () => 1000);
  }

  private queued(e: Row, nodeId: string): Row | undefined {
    if (!this.queuedIdx) {
      this.queuedIdx = new Map();
      for (const a of this.store.t('outreach_actions')) if (a.status === 'queued' && a.enrollment_id) this.queuedIdx.set(`${a.enrollment_id}|${a.node_id}`, a);
    }
    const k = `${e.id}|${nodeId}`;
    const r = this.queuedIdx.get(k);
    if (r && r.status !== 'queued') { this.queuedIdx.delete(k); return undefined; }
    return r;
  }
  /** Forget the indexes (after other code changed actions or chats directly). */
  resetIndexes() { this.queuedIdx = null; this.chatIdx = null; }

  // --- lookups ---------------------------------------------------------------
  sender(id: string | null | undefined): Row | undefined { return this.store.get('outreach_senders', id); }
  lead(id: string): Row | undefined { return this.store.get('outreach_leads', id); }
  sequence(id: string): Row | undefined { return this.store.get('outreach_sequences', id); }
  state(leadId: string, senderId: string): Row {
    const t = this.store.t('outreach_lead_sender_state');
    let r = t.find((x) => x.lead_id === leadId && x.sender_id === senderId);
    if (!r) {
      r = this.store.insert('outreach_lead_sender_state', {
        lead_id: leadId, sender_id: senderId, relation: 'none', invitation_id: null, invite_sent_at: null, invite_accepted_at: null, invite_detected_at: null,
        invite_withdrawn_at: null, invite_had_note: null, unipile_chat_id: null, last_outbound_at: null, last_inbound_at: null, replied: false, email_bounced: false,
      }, { silent: true })[0];
    }
    return r;
  }
  graphOf(e: Row): Row | null {
    const seq = this.sequence(e.sequence_id);
    if (!seq) return null;
    const pinned = e.pinned_version ?? null;
    if (pinned) {
      const v = this.store.t('outreach_sequence_versions').find((x) => x.sequence_id === seq.id && x.version === pinned);
      if (v) return v.graph;
    }
    return seq.graph;
  }

  available(sender: Row | undefined, now: number): boolean {
    if (!sender || sender.deleted_at || sender.status !== 'ok') return false;
    if (sender.paused_until && Date.parse(sender.paused_until) > now) return false;
    if (sender.outreach_allowed_from && Date.parse(sender.outreach_allowed_from) > now) return false;
    return true;
  }

  // --- conversations ---------------------------------------------------------
  /** The lead's conversation with a sender (created on the first message). */
  ensureChat(lead: Row, sender: Row, now: number, subject?: string | null, id?: string): Row {
    if (!this.chatIdx) { this.chatIdx = new Map(); for (const c of this.store.t('outreach_chats')) if (c.lead_id && !c.webchat_inbox_id) this.chatIdx.set(`${c.lead_id}|${c.sender_id}`, c); }
    const existing = this.chatIdx.get(`${lead.id}|${sender.id}`);
    if (existing && this.store.get('outreach_chats', existing.id) === existing) return existing;
    this.chatSeq += 1;
    this.store.setMeta('chatSeq', this.chatSeq);
    // an email thread is with the lead's address (the bounce rules of 075 match on it), LinkedIn with the profile
    const mailTo = MAIL.has(sender.provider) ? String(lead.email_work ?? lead.email_personal ?? '').toLowerCase() || null : null;
    const chat = this.store.insert('outreach_chats', {
      ...(id ? { id } : {}), workspace_id: lead.workspace_id, client_id: lead.client_id ?? sender.client_id ?? null, sender_id: sender.id, lead_id: lead.id,
      unipile_chat_id: `demo-chat-${this.chatSeq}`, provider: sender.provider, attendee_provider_id: mailTo ?? lead.provider_id, attendee_public_identifier: mailTo ?? lead.public_identifier,
      attendee_name: lead.full_name, attendee_picture_url: lead.picture_url, subject: subject ?? null, last_message_at: null, last_message_preview: null,
      last_direction: null, unread: false, unread_count: 0, assigned_to: null, intent: 'unclassified', archived: false, is_request: false, last_note_at: null,
      status: 'open', labels: [], custom_attributes: {}, autopilot_state: 'active', conversation_stage: null, conversation_exchanges: 0, ai_replies_count: 0,
      ai_run_id: null, ai_run_status: null, ai_run_decision: null, reply_sequence_id: null, ai_handed_off_at: null, created_at: iso(now),
    })[0];
    this.chatIdx.set(`${lead.id}|${sender.id}`, chat);
    return chat;
  }

  /** Adds a message to a conversation and updates the conversation's preview, unread state and last direction. */
  appendMessage(chat: Row, m: { direction: 'in' | 'out'; text: string; html?: string | null; at: number; origin?: string; action_id?: string | null; replied_to_action_id?: string | null; intent?: string | null; summary?: string | null; sent_by?: string | null; attachments?: Row[]; opens?: number; is_invite_note?: boolean }): Row {
    const first = m.direction === 'in' && !this.store.t('outreach_messages').some((x) => x.chat_id === chat.id && x.direction === 'in');
    const msg = this.store.insert('outreach_messages', {
      workspace_id: chat.workspace_id, chat_id: chat.id, unipile_message_id: `demo-msg-${this.store.uid().slice(0, 8)}`, direction: m.direction,
      text: m.text, html: m.html ?? null, attachments: m.attachments ?? [], sent_at: iso(m.at), is_invite_note: !!m.is_invite_note, reactions: [], read_at: null,
      transcript: null, transcript_status: null, intent: m.intent ?? null, intent_confidence: m.intent ? 0.92 : null, summary: m.summary ?? null,
      classified_at: m.intent ? iso(m.at + 60_000) : null, opens: m.opens ?? 0, clicks: 0, edited_at: null, deleted_at: null, action_id: m.action_id ?? null,
      replied_to_action_id: m.replied_to_action_id ?? null, is_first_reply: first, sent_by: m.sent_by ?? null, origin: m.origin ?? (m.direction === 'in' ? 'prospect' : 'sequence'),
      ai_flags: [], classification: m.intent ? { intent: m.intent, summary: m.summary } : null, content_type: 'text', content_attributes: {}, sender_type: null, created_at: iso(m.at),
    })[0];
    const preview = m.text.replace(/\s+/g, ' ').slice(0, 140);
    const isIn = m.direction === 'in';
    this.store.update('outreach_chats', chat.id, (c) => ({
      last_message_at: iso(m.at), last_message_preview: preview, last_direction: m.direction,
      unread: isIn ? true : c.unread, unread_count: isIn ? (c.unread_count ?? 0) + 1 : c.unread_count,
      intent: m.intent ?? c.intent, archived: isIn ? false : c.archived,
      conversation_exchanges: (c.conversation_exchanges ?? 0) + (isIn ? 1 : 0),
      subject: c.subject ?? null,
    }));
    return msg;
  }

  // --- actions ---------------------------------------------------------------
  private act(e: Row, sender: Row, node: Row, type: string, now: number, extra: { status?: string; payload?: Row; error_code?: string | null; response?: Row | null } = {}): Row {
    // a queued row the planner created earlier becomes the executed one
    const queued = this.queued(e, node.id);
    const status = extra.status ?? 'sent';
    const fields = {
      status, executed_at: status === 'queued' ? null : iso(now), reserved_at: status === 'queued' ? null : iso(now - 60_000), payload: extra.payload ?? {},
      response: extra.response ?? (status === 'sent' ? { ok: true } : null), error_code: extra.error_code ?? null, action_type: type, sender_id: sender.id,
    };
    let row: Row;
    if (queued) { Object.assign(queued, fields); row = queued; this.store.emit({ table: 'outreach_actions', eventType: 'UPDATE', new: row, old: null }); this.store.touch(); }
    else row = this.store.insert('outreach_actions', {
      workspace_id: e.workspace_id, enrollment_id: e.id, import_job_id: null, lead_id: e.lead_id, node_id: node.id, variant_id: null,
      scheduled_for: iso(now), attempt: 1, decision: null, created_at: iso(now - 5 * 60_000), ...fields,
    })[0];
    if (status === 'queued') this.queuedIdx?.set(`${e.id}|${node.id}`, row);
    if (status === 'sent') {
      this.ledger.add(sender, now, type);
      this.perRun.set(sender.id, (this.perRun.get(sender.id) ?? 0) + 1);
      for (const h of simHooks.onSent) h(this.store, row);
    }
    return row;
  }

  /** Can this sender do one more `type` now (status, hours, daily cap, pacing inside one clock step)? */
  private canAct(sender: Row | undefined, type: string, now: number, ignoreSchedule = false): boolean {
    if (!this.available(sender, now)) return false;
    if (!ignoreSchedule && !inSchedule(sender!, simWallClock(this.store, now))) return false;
    if (this.ledger.room(sender!, now, type) <= 0) return false;
    if ((this.perRun.get(sender!.id) ?? 0) >= 8) return false;
    return true;
  }

  /**
   * Leaves (or keeps) a queued action at the step, so the lead's "Queued" list, "Why not sending" and Sent · Scheduled
   * have something to show. Like the planner, the row gets the next slot the sender can use (working hours, today's
   * allowance); a slot that passed while the step was still blocked is planned again. A sender that cannot send at all
   * (disconnected, paused) keeps the row where it is: Scheduled shows it as Held.
   */
  private queue(e: Row, sender: Row | undefined, node: Row, type: string, now: number) {
    if (!sender) return;
    const q = this.queued(e, node.id);
    if (!q) {
      if (this.available(sender, now)) this.plan(e, sender, node, type, now, now);
      else this.act(e, sender, node, type, now + H, { status: 'queued' });
    } else if (this.available(sender, now) && Date.parse(q.scheduled_for) < now - 2 * 60_000) {
      const slot = this.nextSlot(sender, now, type, `${e.id}:${node.id}`);
      Object.assign(q, { scheduled_for: iso(slot.at), decision: slot.deferred ? 'budget_deferred' : null, sender_id: sender.id });
      this.store.touch();
    }
    if (e.status !== 'active') this.store.update('outreach_enrollments', e.id, { status: 'active', wait_until: null });
  }

  /** The planner's slot from `from`: inside the sender's working hours (the demo's wall clock) with allowance left that day, spread by `key`. */
  nextSlot(sender: Row, from: number, type: string, key: string): { at: number; deferred: boolean } {
    let deferred = false;
    let t = Math.ceil(from / 60_000) * 60_000;
    for (let i = 0; i < 8 * 96; i++, t += SLOT_STEP) {
      if (!inSchedule(sender, simWallClock(this.store, t))) continue;
      if (this.ledger.room(sender, t, type) <= 0) { deferred = true; continue; }
      // sends of one sender do not all go at the top of the window
      const at = t + Math.floor(this.hash(key) * 100) * 60_000;
      return { at: inSchedule(sender, simWallClock(this.store, at)) ? at : t, deferred };
    }
    return { at: from + H, deferred };
  }

  /** A queued action at `node` with its planned slot (and the text the step will send, filled in at send time). */
  private plan(e: Row, sender: Row, node: Row, type: string, from: number, now: number): Row {
    const slot = this.nextSlot(sender, from, type, `${e.id}:${node.id}`);
    const row = this.store.insert('outreach_actions', {
      workspace_id: e.workspace_id, enrollment_id: e.id, import_job_id: null, lead_id: e.lead_id, node_id: node.id, variant_id: null,
      scheduled_for: iso(slot.at), attempt: 1, decision: slot.deferred ? 'budget_deferred' : null, created_at: iso(now), status: 'queued', executed_at: null,
      reserved_at: null, payload: {}, response: null, error_code: null, action_type: type, sender_id: sender.id,
    })[0];
    this.queuedIdx?.set(`${e.id}|${node.id}`, row);
    return row;
  }

  /** End of the next working day after today in the sender's timezone (the planner looks that far ahead). */
  private horizon(sender: Row, now: number): number {
    const tz = sender.timezone ?? 'UTC';
    const wall = simWallClock(this.store, now);
    const endToday = now + (24 * 60 - localParts(wall, tz).minutes) * 60_000;
    const sched = sender.schedule as Record<string, unknown[]> | undefined;
    for (let k = 0; k < 7; k++) {
      const dayStart = endToday + k * D;
      const wd = localParts(simWallClock(this.store, dayStart + 60_000), tz).wd;
      if (!sched || (sched[wd] ?? []).length) return dayStart + D;
    }
    return endToday + D;
  }

  /**
   * The planner's look-ahead: a lead whose wait ends before the end of the next working day gets its next send planned
   * now (a delay → the step after it; waiting for a reply → the follow-up when nobody answers). A reply before then
   * cancels it (stop on reply), so it leaves Scheduled again.
   */
  planAhead(now: number) {
    const active = new Set(this.store.t('outreach_sequences').filter((s) => s.status === 'active').map((s) => s.id));
    for (const e of this.store.t('outreach_enrollments')) {
      if (e.status !== 'waiting_delay' || !e.wait_until || !active.has(e.sequence_id)) continue;
      const graph = this.graphOf(e);
      const cur: Row | undefined = graph?.nodes?.[e.current_node_id ?? ''];
      if (!cur) continue;
      const nextId: string | null = cur.type === 'delay' ? (cur.next ?? cur.branches?.next ?? null) : cur.type === 'wait_for_reply' ? (cur.branches?.no_reply ?? null) : null;
      const node: Row | undefined = nextId ? graph!.nodes[nextId] : undefined;
      const type = node && node.mode !== 'manual' ? SEND_STEP[node.type] : undefined;
      if (!node || !type || this.queued(e, node.id)) continue;
      const seq = this.sequence(e.sequence_id)!;
      const lead = this.lead(e.lead_id);
      if (!lead || lead.do_not_contact) continue;
      let actor: Row | undefined;
      if (type === 'email') {
        if (!lead.email_work && !lead.email_personal) continue;
        actor = (node.config?.mailbox_sender_id && this.sender(node.config.mailbox_sender_id)) || this.channelSender(e, seq, 'MAIL');
      } else {
        const channel: string = node.config?.channel ?? 'LINKEDIN';
        actor = channel === 'LINKEDIN' ? this.sender(e.sender_id) : this.channelSender(e, seq, channel) ?? this.sender(e.sender_id);
        if (channel === 'LINKEDIN' && type === 'message' && this.state(lead.id, actor?.id ?? e.sender_id).relation !== 'first') continue;
        if (type === 'invite' && this.state(lead.id, actor?.id ?? e.sender_id).relation === 'first') continue;
      }
      if (!actor || !this.available(actor, now)) continue;
      const due = Date.parse(e.wait_until);
      if (due > this.horizon(actor, now)) continue;
      this.plan(e, actor, node, type, Math.max(due, now), now);
    }
  }

  /** Queued rows the enrollment no longer needs (it moved to another step or ended). */
  private dropPlanned(e: Row, keep: string | null) {
    const nodes = this.graphOf(e)?.nodes;
    if (!nodes) return;
    for (const nid of Object.keys(nodes)) {
      if (nid === keep) continue;
      const q = this.queued(e, nid);
      if (q) { q.status = 'cancelled'; q.decision = q.decision ?? 'not_on_path'; this.queuedIdx?.delete(`${e.id}|${nid}`); }
    }
  }

  // --- moving ----------------------------------------------------------------
  private enter(e: Row, nodeId: string | null | undefined, now: number) {
    if (!nodeId) { this.complete(e, now, null); return; }
    this.dropPlanned(e, nodeId);
    this.store.update('outreach_enrollments', e.id, { current_node_id: nodeId, node_entered_at: iso(now), wait_until: null, status: 'active', wait_reason: null });
  }
  complete(e: Row, now: number, reason: string | null) {
    this.dropPlanned(e, null);
    this.store.update('outreach_enrollments', e.id, { status: 'completed', completed_at: iso(now), wait_until: null, exit_reason: reason });
  }
  exit(e: Row, status: string, reason: string, now: number) {
    this.store.update('outreach_enrollments', e.id, { status, exit_reason: reason, completed_at: iso(now), wait_until: null });
    for (const a of this.store.t('outreach_actions')) if (a.status === 'queued' && a.enrollment_id === e.id) { a.status = 'cancelled'; a.decision = reason; }
  }

  private branch(node: Row, exit: string): string | null {
    if (exit === 'next') return node.next ?? node.branches?.next ?? null;
    if (node.branches && exit in node.branches) return node.branches[exit] ?? null;
    return node.next ?? null;
  }

  private hash(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; }

  private condition(e: Row, node: Row): boolean {
    const rules: Row[] = Array.isArray(node.config?.rules) ? node.config.rules : [];
    if (!rules.length) return true;
    const lead = this.lead(e.lead_id) ?? {};
    const st = this.state(e.lead_id, e.sender_id);
    const tags = new Set(this.store.t('outreach_lead_tags').filter((t) => t.lead_id === e.lead_id).map((t) => t.tag_id));
    const val = (f: string): unknown => {
      switch (f) {
        case 'relation': return st.relation;
        case 'replied': return st.replied;
        case 'accepted': return !!st.invite_accepted_at;
        case 'email_bounced': return st.email_bounced;
        case 'has_email_work': return !!lead.email_work;
        case 'has_email_personal': return !!lead.email_personal;
        case 'has_phone': return !!lead.phone;
        case 'is_open_profile': return !!lead.is_open_profile;
        case 'company': case 'title': case 'headline': case 'location': return lead[f];
        case 'stage_is': return lead.stage_id;
        default: if (f.startsWith('custom.')) return lead.custom?.[f.slice(7)]; return this.hash(`${e.id}:${f}`) < 0.5;
      }
    };
    const test = (r: Row) => {
      if (r.field === 'has_tag') return r.op === 'neq' ? !tags.has(r.value) : tags.has(r.value);
      const v = val(r.field);
      const s = v == null ? '' : String(v).toLowerCase();
      const w = String(r.value ?? '').toLowerCase();
      switch (r.op) {
        case 'eq': return typeof v === 'boolean' ? String(v) === w || (w === '' && v) : s === w;
        case 'neq': return s !== w;
        case 'contains': return s.includes(w);
        case 'not_contains': return !s.includes(w);
        case 'exists': return v != null && v !== '' && v !== false;
        case 'not_exists': return v == null || v === '' || v === false;
        case 'gt': return Number(v) > Number(r.value);
        case 'lt': return Number(v) < Number(r.value);
        case 'gte': return Number(v) >= Number(r.value);
        case 'lte': return Number(v) <= Number(r.value);
        default: return false;
      }
    };
    return node.config?.match === 'any' ? rules.some(test) : rules.every(test);
  }

  private delayMs(node: Row): number {
    const c = node.config ?? node.delay ?? {};
    const n = Number(c.amount ?? 1);
    const unit = c.unit === 'minutes' ? 60_000 : c.unit === 'hours' ? H : D;
    const jitter = Number(c.jitter_pct ?? 0) / 100;
    return Math.max(60_000, n * unit * (1 + (this.store.random() * 2 - 1) * jitter));
  }

  /** The sender that serves a channel for this enrollment (the sender pool decides when the enrollment has none yet). */
  private channelSender(e: Row, seq: Row, provider: string): Row | undefined {
    const mapped = e.channel_sender_map?.[provider];
    if (mapped) return this.sender(mapped);
    const pool: string[] = seq.sender_pool ?? [];
    const candidates = pool.map((id) => this.sender(id)).filter((s): s is Row => !!s && (provider === 'MAIL' ? MAIL.has(s.provider) : s.provider === provider));
    const pick = candidates.length ? candidates[Math.floor(this.hash(e.id) * candidates.length)] : undefined;
    if (pick) this.store.update('outreach_enrollments', e.id, (r) => ({ channel_sender_map: { ...(r.channel_sender_map ?? {}), [pick.provider]: pick.id } }), { silent: true });
    return pick;
  }

  /** Runs one enrollment until it waits, blocks or ends. */
  step(e: Row, now: number): void {
    const seq = this.sequence(e.sequence_id);
    if (!seq || seq.status !== 'active') return;
    const graph = this.graphOf(e);
    if (!graph) return;
    for (let guard = 0; guard < 25; guard++) {
      if (!RUNNABLE.has(e.status)) return;
      const node: Row | undefined = graph.nodes?.[e.current_node_id ?? graph.start];
      if (!e.current_node_id) { this.enter(e, graph.start, now); continue; }
      if (!node) { this.complete(e, now, 'missing_step'); return; }
      const sender = this.sender(e.sender_id);
      const lead = this.lead(e.lead_id);
      if (!lead) { this.complete(e, now, 'lead_deleted'); return; }
      if (lead.do_not_contact) { this.exit(e, 'exited_suppressed', 'do_not_contact', now); return; }
      const go = (exit: string) => this.enter(e, this.branch(node, exit), now);
      const type: string = node.type;

      if (type === 'start') { go('next'); continue; }
      if (type === 'end') { this.complete(e, now, node.config?.reason || null); return; }
      if (type === 'delay') {
        if (e.status !== 'waiting_delay' || !e.wait_until) { this.store.update('outreach_enrollments', e.id, { status: 'waiting_delay', wait_until: iso(now + this.delayMs(node)) }); return; }
        if (Date.parse(e.wait_until) > now) return;
        go('next'); continue;
      }
      if (type === 'condition') { go(this.condition(e, node) ? 'true' : 'false'); continue; }
      if (type === 'ab_split') {
        const list: Row[] = Array.isArray(node.config?.branches) ? node.config.branches : [];
        const total = list.reduce((s, b) => s + Math.max(0, Number(b.weight) || 0), 0) || 1;
        let x = this.hash(`${e.id}:${node.id}`) * total, pick = list[0]?.id ?? 'a';
        for (const b of list) { x -= Math.max(0, Number(b.weight) || 0); if (x <= 0) { pick = b.id; break; } }
        go(pick); continue;
      }
      if (type === 'ai_route') { const routes: Row[] = node.config?.routes ?? []; go(routes.length && this.hash(`${e.id}:r`) < 0.6 ? routes[0].id : 'else'); continue; }
      if (type === 'wait_connection') {
        const st = this.state(e.lead_id, e.sender_id);
        if (st.relation === 'first') { go('connected'); continue; }
        if (e.status !== 'waiting_connection' || !e.wait_until) {
          this.store.update('outreach_enrollments', e.id, { status: 'waiting_connection', wait_until: iso(now + Number(node.config?.window_days ?? 14) * D) });
          return;
        }
        if (Date.parse(e.wait_until) <= now) { go('no_connect'); continue; }
        return;
      }
      if (type === 'wait_follow_back') {
        const st = this.state(e.lead_id, e.sender_id);
        if (st.relation === 'first') { go('followed_back'); continue; }
        if (e.status !== 'waiting_connection' || !e.wait_until) {
          this.store.update('outreach_enrollments', e.id, { status: 'waiting_connection', wait_until: iso(now + Number(node.config?.window_days ?? 5) * D) });
          if (this.store.chance(RATES.followBack)) this.store.update('outreach_lead_sender_state', (r) => r === st, { _accept_at: iso(now + this.store.int(4, 72) * H) }, { silent: true });
          return;
        }
        if (Date.parse(e.wait_until) <= now) { go('no_follow_back'); continue; }
        return;
      }
      if (type === 'wait_for_reply') {
        const st = this.state(e.lead_id, e.sender_id);
        if (st.replied && st.last_inbound_at && Date.parse(st.last_inbound_at) >= Date.parse(e.node_entered_at)) { go('replied'); continue; }
        if (e.status !== 'waiting_delay' || !e.wait_until) { this.store.update('outreach_enrollments', e.id, { status: 'waiting_delay', wait_until: iso(now + Number(node.config?.window_hours ?? 96) * H) }); return; }
        if (Date.parse(e.wait_until) <= now) { go('no_reply'); continue; }
        return;
      }
      if (type === 'manual_task' || type === 'call_task' || type === 'ai_draft_approval') {
        const kind = type === 'call_task' ? 'call' : type === 'ai_draft_approval' ? 'review_ai_draft' : 'manual_node';
        if (!this.store.t('outreach_tasks').some((t) => t.enrollment_id === e.id && t.node_id === node.id && !t.completed_at)) {
          const draft = type === 'ai_draft_approval' || node.mode === 'manual' ? renderFor(this.store, String(node.config?.text ?? node.config?.brief ?? `Hi {{first_name|there}}, thanks for connecting!`), lead.id, e.sender_id, e.id) : null;
          this.store.insert('outreach_tasks', {
            workspace_id: e.workspace_id, client_id: lead.client_id ?? null, kind, lead_id: lead.id, sender_id: e.sender_id, enrollment_id: e.id, node_id: node.id, chat_id: null,
            title: node.config?.title || node.label || (kind === 'call' ? `Call ${lead.full_name}` : `Follow up with ${lead.full_name}`), body: node.config?.body ?? node.config?.script ?? null,
            ai_draft: draft, draft_kind: draft ? 'message' : null, due_at: iso(now + D), assigned_to: null, completed_at: null, completed_by: null, result: null, created_at: iso(now),
          });
        }
        this.store.update('outreach_enrollments', e.id, { status: 'waiting_task' });
        return;
      }
      if (type === 'send_message' && node.mode === 'manual') {
        // a message a teammate writes: a task until it is done
        if (!this.store.t('outreach_tasks').some((t) => t.enrollment_id === e.id && t.node_id === node.id && !t.completed_at)) {
          this.store.insert('outreach_tasks', {
            workspace_id: e.workspace_id, client_id: lead.client_id ?? null, kind: 'manual_node', lead_id: lead.id, sender_id: e.sender_id, enrollment_id: e.id, node_id: node.id, chat_id: null,
            title: `Write a personal follow-up to ${lead.full_name}`, body: node.config?.text ?? null, ai_draft: null, draft_kind: null, due_at: iso(now + D), assigned_to: null,
            completed_at: null, completed_by: null, result: null, created_at: iso(now),
          });
        }
        this.store.update('outreach_enrollments', e.id, { status: 'waiting_task' });
        return;
      }
      if (['add_tag', 'remove_tag', 'change_list', 'change_stage'].includes(type)) {
        const c = node.config ?? {};
        if (type === 'add_tag' && c.tag_id && !this.store.t('outreach_lead_tags').some((t) => t.lead_id === lead.id && t.tag_id === c.tag_id)) this.store.insert('outreach_lead_tags', { lead_id: lead.id, tag_id: c.tag_id });
        if (type === 'remove_tag' && c.tag_id) this.store.remove('outreach_lead_tags', (t) => t.lead_id === lead.id && t.tag_id === c.tag_id);
        if (type === 'change_list' && c.list_id) this.store.update('outreach_leads', lead.id, { list_id: c.list_id });
        if (type === 'change_stage' && c.stage_id) this.store.update('outreach_leads', lead.id, { stage_id: c.stage_id });
        go('next'); continue;
      }
      if (type === 'call_webhook') { go('next'); continue; }
      if (type === 'rotate_sender' || type === 'change_sender') {
        const pool: string[] = (seq.sender_pool ?? []).filter((id: string) => this.sender(id)?.provider === 'LINKEDIN' && id !== e.sender_id);
        const max = Number(node.config?.max_rotations ?? 2);
        if (pool.length && (e.rotation_count ?? 0) < max) {
          const next = pool[(e.rotation_count ?? 0) % pool.length];
          this.store.update('outreach_enrollments', e.id, { sender_id: next, rotation_count: (e.rotation_count ?? 0) + 1 });
          this.enter(e, node.config?.restart_from || graph.start, now); continue;
        }
        go('next'); continue;
      }
      if (type === 'send_to_sequence' || type === 'channel_switch') {
        if (type === 'channel_switch') { this.store.update('outreach_enrollments', e.id, { current_channel: node.config?.to_channel ?? null }); go('next'); continue; }
        this.complete(e, now, 'sent_to_sequence'); return;
      }
      if (type === 'require_consent') {
        const ok = this.store.t('outreach_lead_consent').some((c) => c.lead_id === lead.id && c.channel === 'WHATSAPP' && !c.revoked_at);
        go(ok ? 'has_consent' : 'no_consent'); continue;
      }

      // --- steps that are an action of a sender ---
      // a step the planner gave a time waits for it (that is the time Sent · Scheduled shows)
      const planned = this.queued(e, node.id);
      if (planned && Date.parse(planned.scheduled_for) > now + 60_000 && this.available(this.sender(planned.sender_id), now)) return;
      const channel: string =node.config?.channel ?? (['follow', 'unfollow', 'like_recent_posts', 'comment_post', 'wait_follow_back'].includes(type) ? 'INSTAGRAM' : type === 'check_identifier' ? 'WHATSAPP' : 'LINKEDIN');
      if (type === 'send_email') {
        const mailbox = (node.config?.mailbox_sender_id && this.sender(node.config.mailbox_sender_id)) || this.channelSender(e, seq, 'MAIL');
        if (!lead.email_work && !lead.email_personal) { if (mailbox) this.act(e, mailbox, node, 'email', now, { status: 'skipped', error_code: 'E_NO_EMAIL' }); go(nodeExits(node as never).includes('no_email') ? 'no_email' : 'next'); continue; }
        if (!this.canAct(mailbox, 'email', now)) { this.queue(e, mailbox ?? sender, node, 'email', now); return; }
        const subject = renderFor(this.store, String(node.config?.subject ?? 'Quick question'), lead.id, mailbox!.id, e.id);
        const html = renderFor(this.store, String(node.config?.html ?? node.config?.text ?? ''), lead.id, mailbox!.id, e.id);
        if (this.store.chance(RATES.bounce)) {
          this.act(e, mailbox!, node, 'email', now, { status: 'failed', error_code: 'bounced', payload: { subject } });
          this.store.update('outreach_lead_sender_state', (r) => r.lead_id === lead.id && r.sender_id === mailbox!.id, { email_bounced: true }, { silent: true });
          this.state(lead.id, mailbox!.id).email_bounced = true;
          go(nodeExits(node as never).includes('bounced') ? 'bounced' : 'next'); continue;
        }
        const a = this.act(e, mailbox!, node, 'email', now, { payload: { subject, html } });
        const chat = this.ensureChat(lead, mailbox!, now, subject);
        const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        this.appendMessage(chat, { direction: 'out', text, html, at: now, action_id: a.id, opens: this.store.chance(RATES.open) ? this.store.int(1, 4) : 0 });
        this.afterOutbound(e, lead, mailbox!, chat, a, now);
        go('next'); continue;
      }

      const actor = channel === 'LINKEDIN' ? sender : this.channelSender(e, seq, channel) ?? sender;
      if (type === 'send_invite') {
        const st = this.state(lead.id, actor!.id);
        if (st.relation === 'first') { this.act(e, actor!, node, 'invite', now, { status: 'skipped', error_code: 'E_ALREADY_CONNECTED' }); go('next'); continue; }
        if (!this.canAct(actor, 'invite', now)) { this.queue(e, actor, node, 'invite', now); return; }
        const note = node.config?.note ? renderFor(this.store, String(node.config.note), lead.id, actor!.id, e.id) : '';
        this.act(e, actor!, node, 'invite', now, { payload: note ? { note } : {} });
        const accept = this.store.chance(RATES.accept);
        this.store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'pending_out', invite_sent_at: iso(now), invite_had_note: !!note, invitation_id: `demo-inv-${this.store.uid().slice(0, 6)}`, _accept_at: accept ? iso(now + this.store.int(3, 120) * H) : null });
        go('next'); continue;
      }
      if (type === 'withdraw_invite') {
        const st = this.state(lead.id, actor!.id);
        if (st.relation !== 'pending_out') { go('next'); continue; }
        if (!this.canAct(actor, 'withdraw', now)) { this.queue(e, actor, node, 'withdraw', now); return; }
        this.act(e, actor!, node, 'withdraw', now);
        this.store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'none', invite_withdrawn_at: iso(now), _accept_at: null });
        go('next'); continue;
      }
      if (type === 'send_message' || type === 'send_inmail' || type === 'send_voice_note') {
        const st = this.state(lead.id, actor!.id);
        const actionType = type === 'send_inmail' ? 'inmail' : 'message';
        if (channel === 'LINKEDIN' && type !== 'send_inmail' && st.relation !== 'first') {
          this.act(e, actor!, node, actionType, now, { status: 'skipped', error_code: 'E_RELATION_REQUIRED' });
          go(nodeExits(node as never).includes('no_chat') ? 'no_chat' : 'next'); continue;
        }
        if (!this.canAct(actor, actionType, now)) { this.queue(e, actor, node, actionType, now); return; }
        const text = type === 'send_voice_note' ? 'Voice note' : renderFor(this.store, String(node.config?.text ?? ''), lead.id, actor!.id, e.id);
        const a = this.act(e, actor!, node, actionType, now, { payload: { text } });
        const chat = this.ensureChat(lead, actor!, now, type === 'send_inmail' ? String(node.config?.subject ?? '') || null : null);
        this.appendMessage(chat, { direction: 'out', text, at: now, action_id: a.id, attachments: type === 'send_voice_note' ? [{ id: 'voice', name: 'voice-note.m4a', type: 'audio', voice_note: true, duration_s: 24, mimetype: 'audio/mp4' }] : [] });
        this.afterOutbound(e, lead, actor!, chat, a, now);
        go('next'); continue;
      }
      const at = ACTION_OF[type];
      if (at) {
        if (!this.canAct(actor, at, now)) { this.queue(e, actor, node, at, now); return; }
        this.act(e, actor!, node, at, now);
        if (type === 'find_email') {
          const found = !!lead.email_work || this.store.chance(0.6);
          if (found && !lead.email_work) this.store.update('outreach_leads', lead.id, { email_work: `${String(lead.first_name ?? 'contact').toLowerCase()}.${String(lead.last_name ?? '').toLowerCase()}@example.com`, email_status: 'verified' });
          go(found ? 'found' : 'not_found'); continue;
        }
        if (type === 'check_identifier') { go(lead.phone ? 'valid' : 'invalid'); continue; }
        if (type === 'call_api') { go('next'); continue; }
        go('next'); continue;
      }
      // anything else: move on
      go('next');
    }
  }

  private afterOutbound(e: Row, lead: Row, sender: Row, chat: Row, action: Row, now: number) {
    this.store.update('outreach_lead_sender_state', (r) => r.lead_id === lead.id && r.sender_id === sender.id, { last_outbound_at: iso(now), unipile_chat_id: chat.unipile_chat_id }, { silent: true });
    const stage = this.store.get('outreach_stages', lead.stage_id);
    if (!stage || stage.kind === 'new') {
      const contacted = this.store.t('outreach_stages').find((s) => s.kind === 'contacted');
      if (contacted) this.store.update('outreach_leads', lead.id, { stage_id: contacted.id });
    }
    if (this.store.chance(RATES.reply)) this.scheduleReply({ chat_id: chat.id, lead_id: lead.id, sender_id: sender.id, enrollment_id: e.id, action_id: action.id }, now + this.store.int(1, 30) * H);
  }

  // --- events: accepted invitations, replies ---------------------------------
  scheduleReply(ev: { chat_id: string; lead_id: string; sender_id: string; enrollment_id?: string | null; action_id?: string | null; follow_up?: boolean }, dueMs: number) {
    this.store.insert(EVENTS, { kind: 'reply', due_at: iso(dueMs), ...ev }, { silent: true });
  }

  /** After the visitor answers in the inbox: some prospects write back within two clock steps. */
  scheduleProspectAnswer(chat: Row, now = Date.now()) {
    if (!chat.lead_id || !this.store.chance(RATES.answerAgain)) return;
    this.scheduleReply({ chat_id: chat.id, lead_id: chat.lead_id, sender_id: chat.sender_id, follow_up: true }, now + this.store.int(1, 4) * H);
  }

  processEvents(now: number) {
    // invitations accepted / follow-backs
    for (const st of this.store.t('outreach_lead_sender_state')) {
      if (!st._accept_at || Date.parse(st._accept_at) > now) continue;
      const at = st._accept_at;
      this.store.update('outreach_lead_sender_state', (r) => r === st, { relation: 'first', invite_accepted_at: at, invite_detected_at: iso(Math.min(now, Date.parse(at) + 30 * 60_000)), _accept_at: null });
      const lead = this.lead(st.lead_id);
      const connected = this.store.t('outreach_stages').find((s) => s.kind === 'connected');
      const stage = lead ? this.store.get('outreach_stages', lead.stage_id) : undefined;
      if (lead && connected && (!stage || ['new', 'contacted'].includes(stage.kind))) this.store.update('outreach_leads', lead.id, { stage_id: connected.id });
    }
    const due = this.store.t(EVENTS).filter((x) => Date.parse(x.due_at) <= now);
    for (const ev of due) {
      this.store.remove(EVENTS, (x) => x === ev, { silent: true });
      if (ev.kind === 'reply') this.deliverReply(ev, Math.min(now, Date.parse(ev.due_at)));
    }
  }

  private pickIntent(): ReplyIntent {
    const total = INTENT_WEIGHTS.reduce((s, [, w]) => s + w, 0);
    let x = this.store.random() * total;
    for (const [k, w] of INTENT_WEIGHTS) { x -= w; if (x <= 0) return k; }
    return 'interested';
  }

  deliverReply(ev: Row, at: number): Row | null {
    const chat = this.store.get('outreach_chats', ev.chat_id);
    const lead = this.lead(ev.lead_id);
    const sender = this.sender(ev.sender_id);
    if (!chat || !lead || !sender) return null;
    const mail = MAIL.has(sender.provider);
    // LinkedIn has no out-of-office auto-replies: those prospects just answer later
    let intent: ReplyIntent = ev.follow_up ? 'interested' : this.pickIntent();
    if (!mail && intent === 'ooo') intent = 'not_now';
    const first = String(sender.display_name ?? '').split(' ')[0] || 'there';
    // "thanks for connecting" only makes sense on LinkedIn
    const bank = (ev.follow_up ? FOLLOW_UP_REPLIES : REPLY_BANK[intent]).filter((t) => !mail || !/connect/i.test(t));
    let text = this.store.pick(bank).replace('{first}', first).replace('{company}', lead.company ?? 'our team');
    // an email reply reads like an email: greeting and sign-off, except for auto-replies
    if (mail && intent !== 'ooo') text = `${/^(hi|hello|thanks)\b/i.test(text) ? '' : `Hi ${first},\n\n`}${text}\n\n${lead.first_name ?? ''}`.trim();
    const msg = this.appendMessage(chat, { direction: 'in', text, at, replied_to_action_id: ev.action_id ?? null, intent: ev.follow_up ? null : intent, summary: ev.follow_up ? null : SUMMARIES[intent] });
    this.store.update('outreach_lead_sender_state', (r) => r.lead_id === lead.id && r.sender_id === sender.id, { replied: true, last_inbound_at: iso(at) });
    const channel = mail ? 'email' : String(sender.provider).toLowerCase();
    const stageKind = intent === 'interested' ? 'interested' : 'replied';
    const target = this.store.t('outreach_stages').find((s) => s.kind === stageKind);
    const current = this.store.get('outreach_stages', lead.stage_id);
    const order = ['new', 'contacted', 'connected', 'replied', 'interested', 'meeting', 'won', 'lost'];
    this.store.update('outreach_leads', lead.id, {
      last_replied_at: iso(at), last_replied_channel: channel,
      ...(target && order.indexOf(target.kind) > order.indexOf(current?.kind ?? 'new') && !ev.follow_up ? { stage_id: target.id } : {}),
    });
    // a reply stops the lead's live enrollments (stop on reply is on unless the sequence turned it off)
    let enrollment: Row | undefined;
    for (const e of this.store.t('outreach_enrollments')) {
      if (e.lead_id !== lead.id || !LIVE.includes(e.status)) continue;
      const seq = this.sequence(e.sequence_id);
      if (seq?.settings?.stop_on_reply === false) continue;
      enrollment = e;
      if (intent === 'ooo' && seq?.settings?.resume_after_ooo) continue;
      this.exit(e, 'exited_replied', 'replied', at);
    }
    for (const h of simHooks.onReply) { try { h(this.store, { chat, message: msg, lead, enrollment, intent }); } catch (err) { console.error('[demo] reply hook failed', err); } }
    return msg;
  }

  // --- the run ---------------------------------------------------------------
  /** One clock step: accepted invitations and replies, then every enrollment that is due. */
  run(now: number) {
    this.perRun.clear();
    this.processEvents(now);
    const active = new Set(this.store.t('outreach_sequences').filter((s) => s.status === 'active').map((s) => s.id));
    const due = this.store.t('outreach_enrollments')
      .filter((e) => active.has(e.sequence_id) && RUNNABLE.has(e.status) && (!e.wait_until || Date.parse(e.wait_until) <= now || e.status === 'waiting_connection'))
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100) || String(a.created_at).localeCompare(String(b.created_at)));
    for (const e of due) this.step(e, now);
    this.planAhead(now);
  }

  /**
   * Enrols leads into a sequence (the work of the enroll_leads RPC): one enrollment per lead, the sender chosen by the
   * sequence's assignment rule. Leads already live in the sequence, on do-not-contact, or replied recently are skipped.
   */
  enroll(sequenceId: string, leadIds: string[], opts: { senderId?: string | null; includeReplied?: boolean; ruleId?: string | null; now?: number } = {}) {
    const seq = this.sequence(sequenceId);
    const now = opts.now ?? Date.now();
    const result = { enrolled: 0, skipped_active: 0, skipped_suppressed: 0, skipped_other: 0, skipped_replied: 0, waiting: 0, enrollment_ids: [] as string[] };
    if (!seq) return result;
    const pool: Row[] = (seq.sender_pool ?? []).map((id: string) => this.sender(id)).filter((s: Row | undefined): s is Row => !!s && !s.deleted_at && !MAIL.has(s.provider));
    let rr = this.store.meta(`rr:${seq.id}`, () => 0);
    for (const leadId of leadIds) {
      const lead = this.lead(leadId);
      if (!lead) { result.skipped_other++; continue; }
      if (lead.do_not_contact || lead.unsubscribed) { result.skipped_suppressed++; continue; }
      if (this.store.t('outreach_enrollments').some((e) => e.sequence_id === seq.id && e.lead_id === leadId && LIVE.includes(e.status))) { result.skipped_active++; continue; }
      if (!opts.includeReplied && lead.last_replied_at && now - Date.parse(lead.last_replied_at) < 90 * D) { result.skipped_replied++; continue; }
      let sender = opts.senderId ? this.sender(opts.senderId) : undefined;
      if (!sender) {
        if (!pool.length) { result.skipped_other++; continue; }
        if (seq.assignment === 'least_loaded') {
          const load = (s: Row) => this.store.t('outreach_enrollments').filter((e) => e.sender_id === s.id && LIVE.includes(e.status)).length;
          sender = [...pool].sort((a, b) => load(a) - load(b))[0];
        } else { sender = pool[rr % pool.length]; rr++; }
      }
      const row = this.store.insert('outreach_enrollments', {
        workspace_id: seq.workspace_id, sequence_id: seq.id, sequence_version: seq.head_version ?? 1, lead_id: leadId, sender_id: sender.id, status: 'active',
        current_node_id: null, node_entered_at: iso(now), wait_until: null, exit_reason: null, restart_count: 0, rotation_count: 0, priority: 100,
        pinned_version: null, held_at: null, hold_reason: null, wait_reason: null, rule_id: opts.ruleId ?? null, current_channel: sender.provider,
        channel_sender_map: { [sender.provider]: sender.id }, created_by: null, created_at: iso(now), updated_at: iso(now), completed_at: null,
      })[0];
      result.enrolled++;
      result.enrollment_ids.push(row.id);
    }
    this.store.setMeta(`rr:${seq.id}`, rr);
    return result;
  }

  /** A task at a step was completed (or skipped): the enrollment moves on, a call outcome picks its branch. */
  afterTask(enrollmentId: string, outcome: string | null, now = Date.now()) {
    const e = this.store.get('outreach_enrollments', enrollmentId);
    if (!e || e.status !== 'waiting_task') return;
    const graph = this.graphOf(e);
    const node = graph?.nodes?.[e.current_node_id];
    if (!node) return;
    const target = outcome && node.branches && outcome in node.branches && node.branches[outcome] ? node.branches[outcome] : (node.next ?? node.branches?.next ?? null);
    this.enter(e, target, now);
    this.step(this.store.get('outreach_enrollments', enrollmentId)!, now);
  }
}

/** One engine per store, created on first use. */
const engines = new WeakMap<DemoStore, Engine>();
export function engineFor(store: DemoStore): Engine {
  let e = engines.get(store);
  if (!e) { e = new Engine(store); engines.set(store, e); }
  return e;
}
