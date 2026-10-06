/**
 * Inbox Sent in the demo (migration 075): the rows of the `outreach_sent_items` view, `outreach_inbox_sent_list` and
 * `outreach_inbox_counts`, computed from the demo tables with the same rules (docs/outreach/INBOX-REPLIES-SENT.md).
 *
 * Sources (`src`):
 *   message (sent)      our messages: not website chat, not system events, sent since the sender was connected, not bounced,
 *                       not the note of a connection request (the request row stands for it)
 *   invite (sent)       connection requests that went out
 *   queued (scheduled)  send steps with a planned time that have not gone out (the engine's planner, sim/engine.ts)
 *   ai_hold (scheduled) AI replies in their hold (or going out)
 *   failed (failed)     send steps that did not go out and were not retried since
 *   bounce (failed)     our emails that came back
 */
import { NODE_CATALOG } from '../../../nodes';
import type { NodeType } from '../../../types';
import { demoError, type Ctx } from '../ctx';
import { attachAi, sendDueHolds } from '../aihub/replies';
import { pump } from '../aihub/jobs';
import { tableHooks } from '../query';
import { pickWeighted, reasonText } from '../sequences/core';
import { senderCauses } from '../senders/diagnosis';
import { renderFor } from '../sim/render';
import type { DemoStore, Row } from '../store';
import { ensureInboxViews } from './direction';
import { memberOf } from './shared';

const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);
const SEND_TYPES = new Set(['invite', 'message', 'inmail', 'email', 'new_chat', 'reply']);
const FAILED_TYPES = new Set([...SEND_TYPES, 'ai_reply']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN = 60_000;
const D = 86_400_000;

export type SentSrc = 'message' | 'invite' | 'queued' | 'ai_hold' | 'failed' | 'bounce';
const SEGMENT_SOURCES: Record<string, SentSrc[]> = { sent: ['message', 'invite'], scheduled: ['queued', 'ai_hold'], failed: ['failed', 'bounce'] };

const iso = (ms: number) => new Date(ms).toISOString();
const squash = (s: unknown) => String(s ?? '').replace(/\s+/g, ' ');
const stripHtml = (h: unknown) => String(h ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
const nz = (s: unknown): string | null => (typeof s === 'string' && s !== '' ? s : null);
const channelOf = (provider: unknown) => (MAIL.has(String(provider)) ? 'EMAIL' : String(provider));
const ms = (s: unknown) => (typeof s === 'string' ? Date.parse(s) : NaN);
const initcap = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

/** = outreach_graph_step_numbers: the action steps in walk order from the start (manual / call / approval steps count). */
export function stepNumbers(graph: Row | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!graph?.nodes) return out;
  const queue: string[] = [graph.start];
  const seen = new Set<string>();
  let i = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const n = graph.nodes[cur];
    if (!n) continue;
    const meta = NODE_CATALOG[n.type as NodeType];
    if ((meta && meta.actionType) || ['manual_task', 'call_task', 'ai_draft_approval'].includes(n.type)) out[cur] = ++i;
    if (n.next) queue.push(n.next);
    if (n.branches && typeof n.branches === 'object') for (const v of Object.values(n.branches)) if (typeof v === 'string') queue.push(v);
  }
  return out;
}

/** One row of the view (075 §7), plus the demo-only `body` the list returns. */
export interface SentRow {
  id: string; src: SentSrc; segment: 'sent' | 'scheduled' | 'failed'; workspace_id: string; client_id: string | null; sender_id: string; lead_id: string | null;
  chat_id: string | null; message_id: string | null; action_id: string | null; ai_reply_run_id: string | null; enrollment_id: string | null;
  channel: string; type: string; action_type: string; source: string; sequence_id: string | null; node_id: string | null; variant_id: string | null;
  sent_by: string | null; from_ai_draft: boolean; subject: string | null; preview: string; status: string; status_reason: string | null; at: string;
  replied_at: string | null; deleted: boolean; edited: boolean; recipient_name: string | null; body: string | null;
}

/** The lookups every source needs, built once per call. */
class Index {
  chats: Map<string, Row>;
  leads: Map<string, Row>;
  senders: Map<string, Row>;
  actions: Map<string, Row>;
  enrollments: Map<string, Row>;
  sequences: Map<string, Row>;
  private lss: Map<string, Row> | null = null;
  private chatsByPair: Map<string, Row[]> | null = null;
  private msgByAction: Map<string, Row> | null = null;
  private runByAction: Map<string, Row> | null = null;
  constructor(public store: DemoStore) {
    const by = (t: string) => new Map(store.t(t).map((r) => [r.id, r]));
    this.chats = by('outreach_chats'); this.leads = by('outreach_leads'); this.senders = by('outreach_senders'); this.actions = by('outreach_actions');
    this.enrollments = by('outreach_enrollments'); this.sequences = by('outreach_sequences');
  }
  state(lead: string, sender: string): Row | undefined {
    if (!this.lss) this.lss = new Map(this.store.t('outreach_lead_sender_state').map((x) => [`${x.lead_id}|${x.sender_id}`, x]));
    return this.lss.get(`${lead}|${sender}`);
  }
  private pairs(lead: string, sender: string): Row[] {
    if (!this.chatsByPair) {
      this.chatsByPair = new Map();
      for (const c of this.store.t('outreach_chats')) {
        if (!c.lead_id || c.is_group) continue;
        const k = `${c.lead_id}|${c.sender_id}`;
        (this.chatsByPair.get(k) ?? this.chatsByPair.set(k, []).get(k)!).push(c);
      }
    }
    return this.chatsByPair.get(`${lead}|${sender}`) ?? [];
  }
  /** The lead's conversation on this sender, latest message first (queued / failed rows). */
  latestChat(lead: string | null, sender: string): Row | undefined {
    if (!lead) return undefined;
    return [...this.pairs(lead, sender)].sort((a, b) => String(b.last_message_at ?? '').localeCompare(String(a.last_message_at ?? '')))[0];
  }
  /** The first LinkedIn 1:1 conversation of the pair (invite rows). */
  firstLinkedInChat(lead: string | null, sender: string): Row | undefined {
    if (!lead) return undefined;
    return this.pairs(lead, sender).filter((c) => c.provider === 'LINKEDIN').sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0];
  }
  /** Our first message written by an action (an invite's note). */
  messageOf(actionId: string): Row | undefined {
    if (!this.msgByAction) {
      this.msgByAction = new Map();
      for (const m of this.store.t('outreach_messages')) {
        if (m.direction !== 'out' || !m.action_id) continue;
        const cur = this.msgByAction.get(m.action_id);
        if (!cur || m.sent_at < cur.sent_at) this.msgByAction.set(m.action_id, m);
      }
    }
    return this.msgByAction.get(actionId);
  }
  runOf(actionId: string): Row | undefined {
    if (!this.runByAction) this.runByAction = new Map(this.store.t('outreach_ai_reply_runs').filter((r) => r.action_id).map((r) => [r.action_id, r]));
    return this.runByAction.get(actionId);
  }
  graphOf(e: Row | undefined, sequenceId: string | null): Row | null {
    const q = this.sequences.get(e?.sequence_id ?? sequenceId ?? '');
    if (e?.pinned_version != null && q) {
      const v = this.store.t('outreach_sequence_versions').find((x) => x.sequence_id === q.id && x.version === e.pinned_version);
      if (v) return v.graph;
    }
    return q?.graph ?? null;
  }
}

/** `messages.origin` → source (the view's CASE; `aiAction` = the message branch, where an ai_reply action means AI). */
function sourceOf(m: Row, a: Row | undefined, aiAction: boolean): string {
  switch (m.origin) {
    case 'sequence': return 'sequence';
    case 'inbox_user': case 'ai_draft_sent': case 'ai_edited': return 'teammate';
    case 'ai_autopilot': return 'ai';
    case 'external_device': return 'outside_app';
    default:
      if (a?.action_type === 'reply') return 'teammate';
      if (aiAction && a?.action_type === 'ai_reply') return 'ai';
      if (a) return 'sequence';
      return m.sent_by ? 'teammate' : 'outside_app';
  }
}

const isSystem = (m: Row) => m.event_type != null || ['event', 'csat'].includes(String(m.content_type ?? 'text')) || String(m.sender_type ?? '') === 'system';
/** The message's text: the text, else (demo emails stored as HTML only) the HTML's text, else "Attachment". */
const messageText = (m: Row): string => nz(m.text) ?? (nz(m.html) ? stripHtml(m.html) : Array.isArray(m.attachments) && m.attachments.length ? 'Attachment' : '');

/** A queued step's text: what was planned or edited, else the step rendered for the lead (the variant the send will pick). */
function queuedText(x: Index, a: Row): { text: string; variant: string | null } {
  const p = a.payload ?? {};
  const planned = nz(p.text) ?? nz(p.note) ?? nz(p.body) ?? (nz(p.html) ? stripHtml(p.html) : null);
  if (planned) return { text: planned, variant: nz(a.variant_id) };
  const e = a.enrollment_id ? x.enrollments.get(a.enrollment_id) : undefined;
  const node = x.graphOf(e, null)?.nodes?.[a.node_id ?? ''] as Row | undefined;
  if (!e || !node || !a.lead_id) return { text: '', variant: nz(a.variant_id) };
  const key = node.type === 'send_invite' ? 'note' : node.type === 'send_email' ? 'html' : 'text';
  const variants: Row[] = Array.isArray(node.config?.variants) ? node.config.variants : [];
  const v = variants.length >= 2 ? pickWeighted(variants, `${e.id}:${node.id}:variant`) : undefined;
  const tmpl = nz(v?.[key]) ?? nz(node.config?.[key]) ?? nz(node.config?.text);
  if (!tmpl) return { text: '', variant: v?.id ?? nz(a.variant_id) };
  const out = renderFor(x.store, tmpl, a.lead_id, a.sender_id, e.id);
  return { text: key === 'html' ? stripHtml(out) : out, variant: v?.id ?? nz(a.variant_id) };
}

function queuedSubject(x: Index, a: Row): string | null {
  const s = nz(a.payload?.subject);
  if (s || a.action_type !== 'email') return s;
  const e = a.enrollment_id ? x.enrollments.get(a.enrollment_id) : undefined;
  const node = x.graphOf(e, null)?.nodes?.[a.node_id ?? ''] as Row | undefined;
  return e && node?.config?.subject && a.lead_id ? renderFor(x.store, String(node.config.subject), a.lead_id, a.sender_id, e.id) : null;
}

/** The rows of the given sources (the view, one branch per source). */
export function sentRows(store: DemoStore, ws: string, sources: SentSrc[]): SentRow[] {
  ensureInboxViews(store);
  const x = new Index(store);
  const want = new Set(sources);
  const out: SentRow[] = [];
  const now = Date.now();
  const leadName = (id: string | null | undefined) => (id ? x.leads.get(id)?.full_name ?? null : null);

  // message · bounce
  if (want.has('message') || want.has('bounce')) {
    for (const m of store.t('outreach_messages')) {
      if (m.workspace_id !== ws || m.direction !== 'out') continue;
      const c = x.chats.get(m.chat_id);
      if (!c) continue;
      const a = m.action_id ? x.actions.get(m.action_id) : undefined;
      const e = a?.enrollment_id ? x.enrollments.get(a.enrollment_id) : undefined;
      const common = {
        workspace_id: m.workspace_id, client_id: c.client_id ?? null, sender_id: c.sender_id, lead_id: c.lead_id ?? null, chat_id: c.id, message_id: m.id,
        action_id: m.action_id ?? null, ai_reply_run_id: m.ai_reply_run_id ?? null, enrollment_id: a?.enrollment_id ?? null, sequence_id: e?.sequence_id ?? null,
        node_id: a?.node_id ?? null, variant_id: nz(a?.variant_id), sent_by: m.sent_by ?? null, from_ai_draft: m.origin === 'ai_draft_sent' || m.origin === 'ai_edited',
        deleted: !!m.deleted_at, recipient_name: leadName(c.lead_id) ?? c.attendee_name ?? null, body: messageText(m).slice(0, 8000) || null,
      };
      if (m.bounced_at) {
        if (!want.has('bounce')) continue;
        out.push({
          ...common, id: m.id, src: 'bounce', segment: 'failed', channel: 'EMAIL', type: 'email', action_type: a?.action_type ?? 'email', source: sourceOf(m, a, false),
          subject: nz(m.content_attributes?.email?.subject), preview: squash(messageText(m)).slice(0, 140), status: 'bounced', status_reason: 'email_bounced',
          at: m.bounced_at, replied_at: null, edited: false,
        });
        continue;
      }
      if (!want.has('message') || c.provider === 'WEBCHAT' || isSystem(m)) continue;
      const s = x.senders.get(c.sender_id);
      if (!s || (s.created_at && m.sent_at < s.created_at)) continue;
      if (m.is_invite_note && a?.action_type === 'invite') continue;
      const mail = MAIL.has(c.provider);
      out.push({
        ...common, id: m.id, src: 'message', segment: 'sent', channel: channelOf(c.provider),
        type: mail ? 'email' : a?.action_type === 'inmail' || c.custom_attributes?.linkedin?.content_type === 'inmail' ? 'inmail' : 'message',
        action_type: a?.action_type ?? 'message', source: sourceOf(m, a, true),
        subject: nz(m.content_attributes?.email?.subject) ?? nz(m.content_attributes?.subject), preview: squash(messageText(m)).slice(0, 140),
        status: m.replied_at ? 'replied' : m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent', status_reason: null, at: m.sent_at, replied_at: m.replied_at ?? null,
        edited: !!m.edited_at,
      });
    }
  }

  // invite · queued · failed
  if (want.has('invite') || want.has('queued') || want.has('failed')) {
    // failed rows retried since: a newer attempt of the same step was planned or went out
    const newest = new Map<string, string>();
    if (want.has('failed')) {
      for (const b of store.t('outreach_actions')) {
        if (!b.enrollment_id || !b.node_id || !['queued', 'reserved', 'sent'].includes(b.status)) continue;
        const k = `${b.enrollment_id}|${b.node_id}`;
        if (!newest.has(k) || String(b.created_at) > newest.get(k)!) newest.set(k, String(b.created_at));
      }
    }
    for (const a of store.t('outreach_actions')) {
      if (a.workspace_id !== ws || a.payload?.prefetch || a.payload?.subtask) continue;
      const s = x.senders.get(a.sender_id);
      if (!s) continue;
      const e = a.enrollment_id ? x.enrollments.get(a.enrollment_id) : undefined;
      const base = {
        workspace_id: a.workspace_id, client_id: s.client_id ?? null, sender_id: a.sender_id, lead_id: a.lead_id ?? null, action_id: a.id, enrollment_id: a.enrollment_id ?? null,
        sequence_id: e?.sequence_id ?? null, node_id: a.node_id ?? null, recipient_name: leadName(a.lead_id), from_ai_draft: false,
      };
      const typeOf = (t: string) => (t === 'invite' ? 'connection_request' : t === 'inmail' ? 'inmail' : t === 'email' ? 'email' : 'message');

      if (a.status === 'sent' && a.action_type === 'invite' && a.executed_at && want.has('invite')) {
        const ic = x.firstLinkedInChat(a.lead_id, a.sender_id);
        const nm = x.messageOf(a.id);
        const since = iso(ms(a.executed_at) - 5 * MIN);
        const wroteFirst = !nm && !!ic?.first_inbound_at && ic.first_inbound_at >= since && (!ic.first_outbound_at || ic.first_inbound_at < ic.first_outbound_at);
        const st = a.lead_id ? x.state(a.lead_id, a.sender_id) : undefined;
        const text = nz(a.payload?.note) ?? nz(a.payload?.text) ?? nm?.text ?? '';
        out.push({
          ...base, id: a.id, src: 'invite', segment: 'sent', client_id: s.client_id ?? null, chat_id: ic?.id ?? null, message_id: nm?.id ?? null, ai_reply_run_id: null,
          channel: 'LINKEDIN', type: 'connection_request', action_type: 'invite', source: a.enrollment_id || a.import_job_id ? 'sequence' : 'teammate',
          variant_id: nz(a.variant_id), sent_by: nz(a.payload?.created_by), subject: null, preview: squash(text).slice(0, 140),
          status: nm?.replied_at || wroteFirst ? 'replied' : st?.invite_accepted_at && st.invite_accepted_at >= since ? 'accepted' : 'sent', status_reason: null,
          at: a.executed_at, replied_at: nm?.replied_at ?? (wroteFirst ? ic!.first_inbound_at : null), deleted: false, edited: false,
          body: (nm?.text ?? nz(a.payload?.note) ?? nz(a.payload?.text) ?? null)?.slice(0, 8000) ?? null,
        });
        continue;
      }

      if ((a.status === 'queued' || a.status === 'reserved') && SEND_TYPES.has(a.action_type) && want.has('queued')) {
        const q = e ? x.sequences.get(e.sequence_id) : undefined;
        const due = ms(a.scheduled_for) > now - 2 * MIN;
        const pausedUntil = ms(s.paused_until);
        const senderPaused = Number.isFinite(pausedUntil) && pausedUntil > now;
        const seqActive = !q || q.status === 'active';
        const reserved = a.status === 'reserved';
        const status = reserved ? 'sending' : due && s.status === 'ok' && !senderPaused && e?.status !== 'paused' && seqActive ? 'scheduled' : 'held';
        const reason = reserved ? null
          : ['credentials', 'error', 'disconnected', 'connecting'].includes(s.status) ? 'sender_reconnect'
          : ['paused', 'disabled'].includes(s.status) || senderPaused ? 'sender_paused'
          : e?.status === 'paused' || !seqActive ? 'sequence_paused'
          : due ? null : a.decision === 'budget_deferred' ? 'allowance_used' : a.decision === 'hourly_deferred' ? 'hourly_allowance' : 'waiting_slot';
        const { text, variant } = queuedText(x, a);
        out.push({
          ...base, id: a.id, src: 'queued', segment: 'scheduled', chat_id: x.latestChat(a.lead_id, a.sender_id)?.id ?? null, message_id: null, ai_reply_run_id: null,
          channel: channelOf(s.provider), type: typeOf(a.action_type), action_type: a.action_type, source: a.action_type === 'reply' ? 'teammate' : 'sequence',
          variant_id: variant, sent_by: nz(a.payload?.sent_by), subject: queuedSubject(x, a), preview: squash(text).slice(0, 140), status, status_reason: reason,
          at: a.scheduled_for, replied_at: null, deleted: false, edited: a.payload?.edited_at != null, body: text.slice(0, 8000) || null,
        });
        continue;
      }

      if (a.status === 'failed' && a.executed_at && FAILED_TYPES.has(a.action_type) && want.has('failed')) {
        if (a.enrollment_id && a.node_id) { const nb = newest.get(`${a.enrollment_id}|${a.node_id}`); if (nb && nb > String(a.created_at)) continue; }
        const run = x.runOf(a.id);
        const text = nz(a.payload?.text) ?? nz(a.payload?.note) ?? nz(a.payload?.body) ?? (nz(a.payload?.html) ? stripHtml(a.payload.html) : '');
        out.push({
          ...base, id: a.id, src: 'failed', segment: 'failed', chat_id: x.latestChat(a.lead_id, a.sender_id)?.id ?? null, message_id: null, ai_reply_run_id: run?.id ?? null,
          channel: channelOf(s.provider), type: typeOf(a.action_type), action_type: a.action_type,
          source: a.action_type === 'reply' ? 'teammate' : a.action_type === 'ai_reply' ? 'ai' : 'sequence', variant_id: nz(a.variant_id), sent_by: nz(a.payload?.sent_by),
          subject: nz(a.payload?.subject), preview: squash(text).slice(0, 140), status: 'failed', status_reason: a.error_code ?? a.decision ?? null, at: a.executed_at,
          replied_at: null, deleted: false, edited: false, body: (text || nz(run?.final_text) || nz(run?.draft_text) || '').slice(0, 8000) || null,
        });
      }
    }
  }

  // ai_hold
  if (want.has('ai_hold')) {
    for (const r of store.t('outreach_ai_reply_runs')) {
      if (r.workspace_id !== ws || !['scheduled', 'sending'].includes(r.status) || r.provider === 'WEBCHAT') continue;
      const c = x.chats.get(r.chat_id);
      if (!c) continue;
      const text = String(r.final_text ?? r.draft_text ?? '');
      out.push({
        id: r.id, src: 'ai_hold', segment: 'scheduled', workspace_id: r.workspace_id, client_id: r.client_id ?? null, sender_id: r.sender_id, lead_id: r.lead_id ?? null,
        chat_id: r.chat_id, message_id: null, action_id: r.action_id ?? null, ai_reply_run_id: r.id, enrollment_id: null, channel: channelOf(r.provider),
        type: MAIL.has(r.provider) ? 'email' : 'message', action_type: 'ai_reply', source: 'ai', sequence_id: r.sequence_id ?? null, node_id: null, variant_id: null,
        sent_by: null, from_ai_draft: false, subject: null, preview: squash(text).slice(0, 140), status: r.status === 'sending' ? 'sending' : 'scheduled',
        status_reason: r.timings?.warmup ? 'warmup_hold' : null, at: r.scheduled_send_at ?? r.updated_at, replied_at: null, deleted: false, edited: false,
        recipient_name: leadName(r.lead_id) ?? c.attendee_name ?? null, body: (nz(r.final_text) ?? nz(r.draft_text) ?? '').slice(0, 8000) || null,
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ access
function role(ctx: Ctx): string { return String(memberOf(ctx.store, ctx.ws, ctx.userId)?.role ?? 'member'); }

/** outreach_client_visible for the demo user: owners / managers see every client, members the workspace's own rows and their clients, client viewers their clients. */
function clientVisible(ctx: Ctx): (clientId: string | null) => boolean {
  const m = memberOf(ctx.store, ctx.ws, ctx.userId);
  const ids: string[] = Array.isArray(m?.client_ids) ? m!.client_ids : [];
  if (!m) return () => false;
  if (m.role === 'owner' || m.role === 'manager') return () => true;
  if (m.role === 'client_viewer') return (c) => !!c && ids.includes(c);
  return (c) => !c || ids.includes(c);
}

/** outreach__sent_allowed: client viewers see Sent only while the workspace shares it (settings.inbox_show_sent_to_clients, default on). */
export function sentAllowed(ctx: Ctx): boolean {
  if (role(ctx) !== 'client_viewer') return true;
  const v = ctx.store.get('outreach_workspaces', ctx.ws)?.settings?.inbox_show_sent_to_clients;
  return v !== false && v !== 'false';
}

/** outreach__sent_status_text: the "Why isn't it sending" wording for held rows, the reason text for failures. */
export function statusText(store: DemoStore, status: string, reason: string | null, senderId: string | null, actionType: string | null): string | null {
  if (status === 'failed') return reasonText(reason);
  if (status === 'bounced') return 'The email address bounced';
  if (status === 'scheduled' && reason === 'warmup_hold') return 'Warm-up: waits so you can check it';
  if (status !== 'held') return null;
  if (reason && ['sender_reconnect', 'sender_paused', 'waiting_slot'].includes(reason) && senderId) {
    const need = [actionType && actionType !== 'reply' ? actionType : 'message'];
    const d = senderCauses(store, senderId, need).find((c) => c.blocking)?.detail;
    if (d) return String(d);
  }
  switch (reason) {
    case 'sender_reconnect': return 'The sender needs reconnecting';
    case 'sender_paused': return 'The sender is paused';
    case 'sequence_paused': return 'The sequence is paused';
    case 'allowance_used': return "Today's allowance was used; it goes out in the next slot";
    case 'hourly_allowance': return "This hour's allowance was used; moved to the next hour";
    default: return 'Outside working hours or waiting for the next free slot';
  }
}

/** What the real worker would have done by now: AI holds that are over go out, a snoozed conversation wakes up. */
function catchUp(store: DemoStore): void {
  attachAi(store);
  pump(store);
  sendDueHolds(store);
  tableHooks.outreach_chats?.beforeRead?.(store);
  ensureInboxViews(store);
}

const uuidOrNull = (v: unknown): string | null => {
  if (v == null || v === '') return null;
  if (typeof v !== 'string' || !UUID.test(v)) demoError('E_PAYLOAD_INVALID', 'filters');
  return v as string;
};
const timeOrNull = (v: unknown, what: string): number | null => {
  if (v == null || v === '') return null;
  const t = Date.parse(String(v));
  if (!Number.isFinite(t)) demoError('E_PAYLOAD_INVALID', what);
  return t;
};

// ------------------------------------------------------------------------------------------------ outreach_inbox_sent_list
export function inboxSentList(a: Record<string, unknown>, ctx: Ctx): Row {
  const store = ctx.store;
  if (a.p_ws && a.p_ws !== ctx.ws) demoError('E_FORBIDDEN');
  if (!sentAllowed(ctx)) demoError('E_FORBIDDEN', 'Sent is not shared with client viewers in this workspace');
  const seg = String(a.p_segment || 'sent');
  if (!['sent', 'scheduled', 'failed'].includes(seg)) demoError('E_PAYLOAD_INVALID', 'segment must be sent, scheduled or failed');
  const f = (a.p_filters ?? {}) as Row;
  if (typeof f !== 'object' || Array.isArray(f)) demoError('E_PAYLOAD_INVALID', 'filters must be an object');
  const rawLim = a.p_limit == null ? 50 : Number(a.p_limit);
  const lim = Math.min(Math.max(Number.isFinite(rawLim) ? Math.trunc(rawLim) : 50, 1), 100);

  let cAt: number | null = null, cId: string | null = null;
  const cur = a.p_cursor as Row | null | undefined;
  if (cur && typeof cur === 'object' && !Array.isArray(cur) && 'at' in cur) {
    cAt = Date.parse(String(cur.at));
    cId = typeof cur.id === 'string' && UUID.test(cur.id) ? cur.id : null;
    if (!Number.isFinite(cAt) || !cId) demoError('E_PAYLOAD_INVALID', 'cursor');
  }
  const client = uuidOrNull(f.client_id), sequence = uuidOrNull(f.sequence_id), lead = uuidOrNull(f.lead_id);
  let senders: string[] | null = null;
  if (Array.isArray(f.sender_ids) && f.sender_ids.length) senders = f.sender_ids.map((s) => uuidOrNull(s)!).filter(Boolean);
  let from = timeOrNull(f.from, 'filters'), to = timeOrNull(f.to, 'filters');
  const channel = nz(String(f.channel ?? '').toUpperCase());
  const source = nz(f.source), type = nz(f.type);
  const replied = typeof f.replied === 'boolean' ? f.replied : null;
  let search: string | null = String(f.search ?? '').replace(/%/g, '').replace(/_/g, ' ').trim() || null;
  if (search && search.length < 2) search = null;
  if (channel && !['LINKEDIN', 'EMAIL', 'WHATSAPP', 'INSTAGRAM'].includes(channel)) demoError('E_PAYLOAD_INVALID', 'channel');
  if (source && !['sequence', 'teammate', 'ai', 'outside_app'].includes(source)) demoError('E_PAYLOAD_INVALID', 'source');
  if (type && !['connection_request', 'message', 'inmail', 'email'].includes(type)) demoError('E_PAYLOAD_INVALID', 'type');
  if (f.my_senders === true || f.my_senders === 'true') {
    const me = memberOf(store, ctx.ws, ctx.userId);
    const myEmail = String(me?.email ?? '').toLowerCase();
    const mine = store.t('outreach_senders').filter((s) => s.workspace_id === ctx.ws && !s.deleted_at && (s.owner_user_id === ctx.userId || (myEmail && String(s.owner_email ?? '').toLowerCase() === myEmail))).map((s) => s.id);
    senders = senders ? senders.filter((s) => mine.includes(s)) : mine;
    if (!senders.length) senders = ['00000000-0000-0000-0000-000000000000'];
  }
  const now = Date.now();
  if (seg !== 'scheduled') {
    to = to ?? now + MIN;
    from = from ?? to - 7 * D;
    if (from > to) demoError('E_PAYLOAD_INVALID', 'from is after to');
    if (to - from > 90 * D + MIN) demoError('E_PAYLOAD_INVALID', 'the date range is limited to 90 days per query');
  }

  catchUp(store);
  const visible = clientVisible(ctx);
  const needle = search?.toLowerCase() ?? null;
  const asc = seg === 'scheduled';
  const rows = sentRows(store, ctx.ws, SEGMENT_SOURCES[seg]).filter((v) => {
    const at = ms(v.at);
    if (from != null && at < from) return false;
    if (to != null && at >= to) return false;
    if (cAt != null) {
      if (asc ? !(at > cAt || (at === cAt && v.id > cId!)) : !(at < cAt || (at === cAt && v.id < cId!))) return false;
    }
    if (senders && !senders.includes(v.sender_id)) return false;
    if (client && v.client_id !== client) return false;
    if (channel && v.channel !== channel) return false;
    if (source && v.source !== source) return false;
    if (sequence && v.sequence_id !== sequence) return false;
    if (type && v.type !== type) return false;
    if (seg === 'sent' && replied != null && (v.status === 'replied') !== replied) return false;
    if (lead && v.lead_id !== lead) return false;
    if (needle && ![v.recipient_name, v.preview, v.subject].some((t) => t != null && String(t).toLowerCase().includes(needle))) return false;
    return visible(v.client_id);
  });
  rows.sort((p, q) => {
    const d = ms(p.at) - ms(q.at);
    const c = d !== 0 ? d : p.id < q.id ? -1 : p.id > q.id ? 1 : 0;
    return asc ? c : -c;
  });
  const page = rows.slice(0, lim + 1);
  const next = page.length > lim ? { at: page[lim - 1].at, id: page[lim - 1].id } : null;
  return {
    segment: seg,
    items: page.slice(0, lim).map((p) => itemJson(ctx, p)),
    next_cursor: next,
    range: seg !== 'scheduled' ? { from: iso(from!), to: iso(to!) } : null,
  };
}

/** One SentItem (lib/outreach/inboxSent.ts): the row plus the lead, sender, sequence, step and teammate it names. */
function itemJson(ctx: Ctx, p: SentRow): Row {
  const s = ctx.store;
  const ld = p.lead_id ? s.get('outreach_leads', p.lead_id) : undefined;
  const ch = p.chat_id ? s.get('outreach_chats', p.chat_id) : undefined;
  const sd = s.get('outreach_senders', p.sender_id);
  const sq = p.sequence_id ? s.get('outreach_sequences', p.sequence_id) : undefined;
  const en = p.enrollment_id ? s.get('outreach_enrollments', p.enrollment_id) : undefined;
  const mem = p.sent_by ? memberOf(s, ctx.ws, p.sent_by) : undefined;
  let step: Row | null = null;
  if (p.node_id) {
    let graph: Row | null = sq?.graph ?? null;
    if (en?.pinned_version != null) graph = s.t('outreach_sequence_versions').find((v) => v.sequence_id === en.sequence_id && v.version === en.pinned_version)?.graph ?? graph;
    const node = graph?.nodes?.[p.node_id] as Row | undefined;
    const variants: Row[] = Array.isArray(node?.config?.variants) ? node!.config.variants : [];
    step = {
      node_id: p.node_id, number: stepNumbers(graph)[p.node_id] ?? null,
      label: node?.label ?? initcap(String(node?.type ?? p.action_type)), variant: p.variant_id,
      variant_label: variants.find((v) => v.id === p.variant_id)?.label ?? null,
    };
  }
  return {
    id: p.id, src: p.src, segment: p.segment, at: p.at, status: p.status, status_reason: p.status_reason,
    status_text: statusText(s, p.status, p.status_reason, p.sender_id, p.action_type),
    channel: p.channel, type: p.type, action_type: p.action_type, source: p.source, from_ai_draft: p.from_ai_draft,
    subject: p.subject, preview: p.preview, body: p.body, deleted: p.deleted, edited: p.edited, replied_at: p.replied_at,
    chat_id: p.chat_id, message_id: p.message_id, action_id: p.action_id, ai_reply_run_id: p.ai_reply_run_id, enrollment_id: p.enrollment_id,
    enrollment_status: en?.status ?? null, recoverable: en ? en.status === 'failed' : null,
    lead: p.lead_id || p.recipient_name ? { id: p.lead_id, name: ld?.full_name ?? p.recipient_name, company: ld?.company ?? null, headline: ld?.headline ?? null, picture_url: ld?.picture_url ?? ch?.attendee_picture_url ?? null } : null,
    sender: { id: p.sender_id, name: sd?.display_name ?? null, provider: sd?.provider ?? null, picture_url: sd?.picture_url ?? null, status: sd?.status ?? null, identifier: sd?.public_identifier ?? sd?.owner_email ?? null },
    sequence: p.sequence_id ? { id: p.sequence_id, name: sq?.name ?? null, status: sq?.status ?? null } : null,
    step,
    sent_by: p.sent_by ? { id: p.sent_by, name: mem ? (mem.display_name || mem.email || null) : null } : null,
  };
}

// ------------------------------------------------------------------------------------------------ outreach_inbox_counts
export function inboxCounts(a: Record<string, unknown>, ctx: Ctx): Row {
  const store = ctx.store;
  if (a.p_ws && a.p_ws !== ctx.ws) demoError('E_FORBIDDEN');
  const f = (a.p_filters ?? {}) as Row;
  const assigned = uuidOrNull(f.assigned_to), sender = uuidOrNull(f.sender_id), client = uuidOrNull(f.client_id);
  const provider = nz(f.provider);
  catchUp(store);
  const visible = clientVisible(ctx);
  const chats = store.t('outreach_chats').filter((c) => c.workspace_id === ctx.ws && visible(c.client_id ?? null));
  const unread = chats.filter((c) => c.unread && !c.archived).length;
  const needs = chats.filter((c) => c.waiting_on === 'us' && !c.archived && !['resolved', 'snoozed'].includes(String(c.status ?? 'open')) && !c.ai_answering
    && (!assigned || c.assigned_to === assigned) && (!sender || c.sender_id === sender) && (!client || c.client_id === client) && (!provider || c.provider === provider)).length;
  const allowed = sentAllowed(ctx);
  let scheduled = 0, failed = 0;
  if (allowed) {
    scheduled = sentRows(store, ctx.ws, ['queued', 'ai_hold']).filter((v) => visible(v.client_id)).length;
    const since = Date.now() - 7 * D;
    failed = sentRows(store, ctx.ws, ['failed', 'bounce']).filter((v) => {
      if (ms(v.at) < since || !visible(v.client_id)) return false;
      if (v.src === 'bounce') {
        const l = v.lead_id ? store.get('outreach_leads', v.lead_id) : undefined;
        if (!l) return true;
        const addr = String(store.get('outreach_chats', v.chat_id ?? '')?.attendee_provider_id ?? '').toLowerCase();
        return !l.do_not_contact && (addr === String(l.email_work ?? '').toLowerCase() || addr === String(l.email_personal ?? '').toLowerCase());
      }
      return !v.enrollment_id || store.get('outreach_enrollments', v.enrollment_id)?.status === 'failed';
    }).length;
  }
  return { replies_unread: unread, needs_reply: needs, scheduled, failed, show_sent: allowed };
}
