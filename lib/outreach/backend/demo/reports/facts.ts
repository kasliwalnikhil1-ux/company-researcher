/**
 * The one definition of every number in the demo (the equivalent of outreach__facts + outreach__grouped +
 * outreach__totals_from in migrations/outreach/013_reports.sql, as redefined by 026). The dashboard, every report tab,
 * the sender report and the client portal read their totals from `grouped()`, so they cannot disagree.
 *
 * Facts are computed from the store rows (actions, lead/sender state, messages, chats, enrollments, milestones,
 * sender events) and bucketed into calendar days of the WORKSPACE timezone. They are cached per store revision.
 */
import type { DemoStore, Row } from '../store';
import { localParts } from '../sim/caps';

export type Rate = number | null;
export type Metrics = Record<string, number>;

export interface Fact {
  day: string;
  client: string | null;
  seq: string | null;
  node: string | null;
  variant: string | null;
  sender: string | null;
  channel: string;
  metric: string;
  n: number;
}

export type Group = 'none' | 'day' | 'channel' | 'sequence' | 'node' | 'variant' | 'sender' | 'client';
export interface FactFilters { sequence_id?: string | null; sender_id?: string | null; node_id?: string | null; channel?: string | null }

export const LIVE_ENROLLMENT = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'];
export const RUNNING_ENROLLMENT = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'];
const MAIL = new Set(['GMAIL', 'OUTLOOK', 'IMAP']);

// ---------------------------------------------------------------------------
// days and timezone
// ---------------------------------------------------------------------------
const tzOk = new Map<string, boolean>();
function validTz(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  let ok = tzOk.get(tz);
  if (ok === undefined) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); ok = true; } catch { ok = false; } tzOk.set(tz, ok); }
  return ok;
}

/** outreach_ws_tz: settings.timezone when it is a real zone, else UTC. */
export function wsTz(store: DemoStore, ws: string): string {
  const tz = store.get('outreach_workspaces', ws)?.settings?.timezone;
  return validTz(tz) ? tz : 'UTC';
}

export const dayIn = (ms: number, tz: string) => localParts(ms, tz).day;
export const todayIn = (tz: string) => dayIn(Date.now(), tz);

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export function asDay(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, 10);
  return ISO_DAY.test(s) && !isNaN(Date.parse(`${s}T00:00:00Z`)) ? s : null;
}

/** outreach__check_range */
export function checkRange(from: string, to: string): void {
  if (!from || !to || to < from) throw Object.assign(new Error('E_PAYLOAD_INVALID: from/to must be dates with from <= to'), { code: 'E_PAYLOAD_INVALID' });
  if (daysBetween(from, to) > 731) throw Object.assign(new Error('E_PAYLOAD_INVALID: range is limited to 2 years'), { code: 'E_PAYLOAD_INVALID' });
}

/** The report functions' defaults: to = today, from = to - (span - 1). */
export function resolveRange(store: DemoStore, ws: string, pFrom: unknown, pTo: unknown, defaultDays: number): { from: string; to: string; tz: string } {
  const tz = wsTz(store, ws);
  const to = asDay(pTo) ?? todayIn(tz);
  const from = asDay(pFrom) ?? addDays(to, -(defaultDays - 1));
  checkRange(from, to);
  return { from, to, tz };
}

// ---------------------------------------------------------------------------
// channels and providers
// ---------------------------------------------------------------------------
/** outreach__channel_of */
export function channelOf(provider: string | null | undefined): string {
  if (!provider) return 'linkedin';
  if (provider === 'LINKEDIN' || provider === 'INSTAGRAM' || provider === 'WHATSAPP') return provider.toLowerCase();
  return 'email';
}
export const isMail = (provider: string | null | undefined) => !!provider && MAIL.has(provider);

// ---------------------------------------------------------------------------
// milestones (meeting booked, won, lost, interested): the real database writes one row per lead and kind when the
// lead's stage changes (outreach_record_milestone). The demo engine and the UI move stages with plain updates, so the
// rows are written here, lazily, the first time a report sees a lead at that stage.
// ---------------------------------------------------------------------------
export const MILESTONES = 'outreach_lead_milestones';
const MILESTONE_KINDS = new Set(['interested', 'meeting', 'won', 'lost']);

export function syncMilestones(store: DemoStore): void {
  const stages = new Map(store.t('outreach_stages').map((s) => [s.id, s]));
  const have = new Set(store.t(MILESTONES).map((m) => `${m.lead_id}|${m.kind}`));
  let interestedAt: Map<string, string> | null = null;
  const firstInterested = (leadId: string): string | undefined => {
    if (!interestedAt) {
      interestedAt = new Map();
      const leadOfChat = new Map(store.t('outreach_chats').map((c) => [c.id, c.lead_id]));
      for (const m of store.t('outreach_messages')) {
        if (m.direction !== 'in' || m.intent !== 'interested') continue;
        const lid = leadOfChat.get(m.chat_id);
        if (lid && (!interestedAt.has(lid) || m.sent_at < interestedAt.get(lid)!)) interestedAt.set(lid, m.sent_at);
      }
    }
    return interestedAt.get(leadId);
  };
  const add: Row[] = [];
  const nowIso = new Date().toISOString();
  for (const l of store.t('outreach_leads')) {
    const st = stages.get(l.stage_id);
    if (!st || !MILESTONE_KINDS.has(st.kind) || have.has(`${l.id}|${st.kind}`)) continue;
    let at: string = (st.kind === 'interested' ? firstInterested(l.id) : undefined) ?? l.updated_at ?? nowIso;
    if (at > nowIso) at = nowIso;
    add.push(milestoneRow(store, l, st, at, st.kind === 'interested' ? 'intent' : 'stage'));
    have.add(`${l.id}|${st.kind}`);
  }
  if (add.length) store.insert(MILESTONES, add, { silent: true });
}

/** A milestone row the way outreach_record_milestone writes it (latest enrollment's sequence and sender). */
export function milestoneRow(store: DemoStore, lead: Row, stage: Row, at: string, source: string): Row {
  let latest: Row | undefined;
  for (const e of store.t('outreach_enrollments')) if (e.lead_id === lead.id && (!latest || e.created_at > latest.created_at)) latest = e;
  const seq = latest ? store.get('outreach_sequences', latest.sequence_id) : undefined;
  return {
    workspace_id: lead.workspace_id, lead_id: lead.id, kind: stage.kind, at, client_id: seq?.client_id ?? lead.client_id ?? null,
    sequence_id: latest?.sequence_id ?? null, sender_id: latest?.sender_id ?? null, enrollment_id: latest?.id ?? null, source,
    value: stage.kind === 'won' ? (stage.deal_value ?? null) : null, currency: stage.kind === 'won' && stage.deal_value != null ? 'USD' : null,
  };
}

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------
interface Cache { rev: number; tz: string; ws: string; facts: Fact[] }
const caches = new WeakMap<DemoStore, Cache>();

/** Every fact of the workspace (all time). Cached until the store changes. */
export function allFacts(store: DemoStore, ws: string): Fact[] {
  syncMilestones(store);
  const tz = wsTz(store, ws);
  const hit = caches.get(store);
  if (hit && hit.rev === store.rev && hit.tz === tz && hit.ws === ws) return hit.facts;
  const facts = computeFacts(store, ws, tz);
  caches.set(store, { rev: store.rev, tz, ws, facts });
  return facts;
}

function computeFacts(store: DemoStore, ws: string, tz: string): Fact[] {
  const out: Fact[] = [];
  const day = (iso: string) => dayIn(Date.parse(iso), tz);
  const senders = new Map(store.t('outreach_senders').filter((s) => !s.workspace_id || s.workspace_id === ws).map((s) => [s.id, s]));
  const sequences = new Map(store.t('outreach_sequences').map((q) => [q.id, q]));
  const enrollments = new Map(store.t('outreach_enrollments').map((e) => [e.id, e]));
  const actions = new Map<string, Row>();
  const chats = new Map(store.t('outreach_chats').map((c) => [c.id, c]));
  const push = (f: Omit<Fact, 'n'> & { n?: number }) => out.push({ n: 1, ...f });
  const seqOfAction = (a: Row | undefined): Row | undefined => {
    const e = a?.enrollment_id ? enrollments.get(a.enrollment_id) : undefined;
    return e ? sequences.get(e.sequence_id) : undefined;
  };

  // 1. action volume
  const invitesBy = new Map<string, Row[]>();
  for (const a of store.t('outreach_actions')) {
    actions.set(a.id, a);
    if (a.workspace_id && a.workspace_id !== ws) continue;
    const s = senders.get(a.sender_id);
    if (!s || !a.executed_at || !['sent', 'failed', 'skipped'].includes(a.status)) continue;
    if (a.status === 'sent' && a.action_type === 'invite') {
      const k = `${a.lead_id}|${a.sender_id}`;
      const list = invitesBy.get(k);
      if (list) list.push(a); else invitesBy.set(k, [a]);
    }
    const p = a.payload ?? {};
    if (a.status !== 'sent' && (p.prefetch === true || p.subtask === true)) continue;
    const e = a.enrollment_id ? enrollments.get(a.enrollment_id) : undefined;
    const q = e ? sequences.get(e.sequence_id) : undefined;
    const base = {
      day: day(a.executed_at), client: q?.client_id ?? s.client_id ?? null, seq: e?.sequence_id ?? null, node: a.node_id ?? null, variant: a.variant_id ?? null,
      sender: a.sender_id, channel: a.action_type === 'email' ? 'email' : channelOf(s.provider),
    };
    push({ ...base, metric: a.status !== 'sent' ? a.status : a.action_type === 'reply' ? 'manual_reply' : a.action_type });
    if (a.status === 'sent' && a.action_type === 'invite' && (Number(a.response?.note_length ?? 0) > 0 || (typeof p.note === 'string' && p.note.trim() !== ''))) push({ ...base, metric: 'invite_with_note' });
    // a bounce is a failed email (the real database dates it from the lead/sender state; the demo from the attempt)
    if (a.status === 'failed' && a.action_type === 'email' && /bounce/i.test(String(a.error_code ?? ''))) push({ ...base, channel: 'email', seq: null, node: null, variant: null, metric: 'email_bounced', client: s.client_id ?? null });
  }

  // 2. accepted: dated by acceptance, attributed to the invite that was accepted
  for (const x of store.t('outreach_lead_sender_state')) {
    if (!x.invite_accepted_at || !x.invite_sent_at) continue;
    const s = senders.get(x.sender_id);
    if (!s) continue;
    let ia: Row | undefined;
    for (const a of invitesBy.get(`${x.lead_id}|${x.sender_id}`) ?? []) if (a.executed_at <= x.invite_accepted_at && (!ia || a.executed_at > ia.executed_at)) ia = a;
    const e = ia?.enrollment_id ? enrollments.get(ia.enrollment_id) : undefined;
    const q = e ? sequences.get(e.sequence_id) : undefined;
    push({ day: day(x.invite_accepted_at), client: q?.client_id ?? s.client_id ?? null, seq: e?.sequence_id ?? null, node: ia?.node_id ?? null, variant: ia?.variant_id ?? null, sender: x.sender_id, channel: 'linkedin', metric: 'accepted' });
  }

  // 3. replies (a thread's first reply to an automated step) and 4. every inbound message, 7. email engagement
  for (const m of store.t('outreach_messages')) {
    if (m.workspace_id && m.workspace_id !== ws) continue;
    const c = chats.get(m.chat_id);
    if (!c || !m.sent_at) continue;
    const d = day(m.sent_at);
    if (m.direction === 'in') {
      push({ day: d, client: c.client_id ?? null, seq: null, node: null, variant: null, sender: c.sender_id ?? null, channel: channelOf(c.provider), metric: 'inbound' });
      const a = m.is_first_reply && m.replied_to_action_id ? actions.get(m.replied_to_action_id) : undefined;
      if (a) {
        const e = a.enrollment_id ? enrollments.get(a.enrollment_id) : undefined;
        const q = e ? sequences.get(e.sequence_id) : undefined;
        const intent = threadIntent(c, m);
        const base = { day: d, client: q?.client_id ?? c.client_id ?? null, seq: e?.sequence_id ?? null, node: a.node_id ?? null, variant: a.variant_id ?? null, sender: c.sender_id ?? null, channel: channelOf(c.provider) };
        push({ ...base, metric: 'reply' });
        push({ ...base, metric: `reply_${intent}` });
      }
    } else if (m.direction === 'out' && isMail(c.provider) && ((m.opens ?? 0) > 0 || (m.clicks ?? 0) > 0)) {
      const a = m.action_id ? actions.get(m.action_id) : undefined;
      const q = seqOfAction(a);
      const base = { day: d, client: c.client_id ?? null, seq: q?.id ?? null, node: a?.node_id ?? null, variant: a?.variant_id ?? null, sender: c.sender_id ?? null, channel: 'email' };
      if ((m.opens ?? 0) > 0) push({ ...base, metric: 'email_opened' });
      if ((m.clicks ?? 0) > 0) push({ ...base, metric: 'email_clicked' });
    }
  }

  // 5. enrolled
  for (const e of store.t('outreach_enrollments')) {
    if (e.workspace_id && e.workspace_id !== ws) continue;
    const q = sequences.get(e.sequence_id);
    if (!q || !e.created_at) continue;
    push({ day: day(e.created_at), client: q.client_id ?? null, seq: q.id, node: null, variant: null, sender: e.sender_id ?? null, channel: channelOf(senders.get(e.sender_id)?.provider), metric: 'enrolled' });
  }

  // 6. milestones (meeting booked, won, lost) and won value
  // once per lead and kind (the table's unique key), the earliest if two writers recorded it
  const firstMs = new Map<string, Row>();
  for (const ms of store.t(MILESTONES)) {
    if ((ms.workspace_id && ms.workspace_id !== ws) || !['meeting', 'won', 'lost'].includes(ms.kind) || !ms.at) continue;
    const k = `${ms.lead_id}|${ms.kind}`;
    const cur = firstMs.get(k);
    if (!cur || ms.at < cur.at) firstMs.set(k, ms);
  }
  for (const ms of firstMs.values()) {
    const base = { day: day(ms.at), client: ms.client_id ?? null, seq: ms.sequence_id ?? null, node: null, variant: null, sender: ms.sender_id ?? null, channel: channelOf(senders.get(ms.sender_id)?.provider) };
    push({ ...base, metric: ms.kind });
    if (ms.kind === 'won' && ms.value != null) push({ ...base, metric: 'won_value', n: Number(ms.value) || 0 });
  }

  // 8. provider limit hits, 9. blocks
  for (const ev of store.t('outreach_sender_events')) {
    const s = senders.get(ev.sender_id);
    if (!s || !ev.at) continue;
    const limit = ev.kind === 'reject' && (ev.data?.decision === 'sender_cap_hit' || ev.data?.limit_hit === true);
    if (!limit && ev.kind !== 'block') continue;
    push({ day: day(ev.at), client: s.client_id ?? null, seq: null, node: null, variant: null, sender: s.id, channel: channelOf(s.provider), metric: limit ? 'limit_hit' : 'block' });
  }
  return out;
}

/** The intent a reply counts under: the thread's current intent (override or classification), else the message's. */
export function threadIntent(chat: Row, msg: Row): string {
  return chat.intent && chat.intent !== 'unclassified' ? chat.intent : (msg.intent ?? 'unclassified');
}

// ---------------------------------------------------------------------------
// grouping (outreach__grouped)
// ---------------------------------------------------------------------------
export interface GroupArgs { from: string; to: string; client?: string | null; group?: Group; filters?: FactFilters | null }

function keyOf(f: Fact, g: Group): string | null {
  switch (g) {
    case 'day': return f.day;
    case 'channel': return f.channel;
    case 'sequence': return f.seq;
    case 'node': return f.seq && f.node ? `${f.seq}|${f.node}` : null;
    case 'variant': return f.seq && f.node ? `${f.seq}|${f.node}|${f.variant ?? ''}` : null;
    case 'sender': return f.sender;
    case 'client': return f.client;
    default: return 'all';
  }
}

/** Metric sums per group key (only groups that have at least one fact). */
export function groupedMetrics(store: DemoStore, ws: string, a: GroupArgs): Map<string, Metrics> {
  const g = a.group ?? 'none';
  const fl = a.filters ?? {};
  const out = new Map<string, Metrics>();
  for (const f of allFacts(store, ws)) {
    if (f.day < a.from || f.day > a.to) continue;
    if (a.client && f.client !== a.client) continue;
    if (fl.sequence_id && f.seq !== fl.sequence_id) continue;
    if (fl.sender_id && f.sender !== fl.sender_id) continue;
    if (fl.node_id && f.node !== fl.node_id) continue;
    if (fl.channel && f.channel !== fl.channel) continue;
    const k = keyOf(f, g);
    if (k == null) continue;
    let m = out.get(k);
    if (!m) { m = {}; out.set(k, m); }
    m[f.metric] = (m[f.metric] ?? 0) + f.n;
  }
  return out;
}

/** Totals per group key. */
export function grouped(store: DemoStore, ws: string, a: GroupArgs): Map<string, Totals> {
  const out = new Map<string, Totals>();
  for (const [k, m] of groupedMetrics(store, ws, a)) out.set(k, totalsFrom(m));
  return out;
}

/** Totals of the whole selection (the 'none' group), zeros when nothing matched. */
export function totalsOf(store: DemoStore, ws: string, a: Omit<GroupArgs, 'group'>): Totals {
  return grouped(store, ws, { ...a, group: 'none' }).get('all') ?? totalsFrom({});
}

/** Only the filter keys outreach__grouped reads, from a p_filters object. */
export function factFilters(p: unknown): FactFilters {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);
  return { sequence_id: s(o.sequence_id), sender_id: s(o.sender_id), node_id: s(o.node_id), channel: s(o.channel) };
}

// ---------------------------------------------------------------------------
// totals (outreach__totals_from, 026)
// ---------------------------------------------------------------------------
/** outreach__rate: round(100 × num ÷ den, 1), null without a base. */
export function rate(num: number | null | undefined, den: number | null | undefined): Rate {
  if (!den || den <= 0) return null;
  const v = (100 * (num ?? 0)) / den;
  return Math.round(v * 10 + (v >= 0 ? 1e-9 : -1e-9)) / 10;
}

export interface Totals {
  enrolled: number; invites: number; invites_with_note: number; accepted: number; acceptance_rate: Rate;
  messages: number; inmails: number; emails: number; new_chats: number; touches: number;
  replies: number; reply_rate: Rate; interested: number; interested_rate: Rate; positive_reply_rate: Rate; negative_reply_rate: Rate;
  intents: Record<'interested' | 'question' | 'not_now' | 'not_interested' | 'ooo' | 'wrong_person' | 'unclear' | 'unclassified', number>;
  meetings: number; won: number; lost: number; won_value: number; inbound_messages: number; manual_replies: number;
  profile_views: number; likes: number; comments: number; endorsements: number; follows: number; unfollows: number; withdrawn: number;
  post_fetches: number; identifier_checks: number; followers_polls: number; blocks: number;
  failed: number; skipped: number; limit_hits: number;
  email_opened: number; email_clicked: number; email_bounced: number; open_rate: Rate; click_rate: Rate; bounce_rate: Rate;
}

export function totalsFrom(m: Metrics): Totals {
  const v = (k: string) => m[k] ?? 0;
  const invites = v('invite'), notes = v('invite_with_note'), accepted = v('accepted'), messages = v('message'), inmails = v('inmail'), emails = v('email');
  const newChats = v('new_chat'), replies = v('reply'), interested = v('reply_interested'), notInterested = v('reply_not_interested'), ooo = v('reply_ooo');
  const touches = messages + inmails + emails + notes + newChats;
  return {
    enrolled: v('enrolled'),
    invites, invites_with_note: notes, accepted, acceptance_rate: rate(accepted, invites),
    messages, inmails, emails, new_chats: newChats, touches,
    replies, reply_rate: rate(replies, touches),
    interested, interested_rate: rate(interested, touches),
    positive_reply_rate: rate(interested, replies - ooo), negative_reply_rate: rate(notInterested, replies - ooo),
    intents: {
      interested, question: v('reply_question'), not_now: v('reply_not_now'), not_interested: notInterested, ooo,
      wrong_person: v('reply_wrong_person'), unclear: v('reply_unclear'), unclassified: v('reply_unclassified'),
    },
    meetings: v('meeting'), won: v('won'), lost: v('lost'), won_value: v('won_value'),
    inbound_messages: v('inbound'), manual_replies: v('manual_reply'),
    profile_views: v('profile_view'), likes: v('like'), comments: v('comment'), endorsements: v('endorse'), follows: v('follow'), unfollows: v('unfollow'), withdrawn: v('withdraw'),
    post_fetches: v('post_fetch'), identifier_checks: v('identifier_check'), followers_polls: v('followers_poll'), blocks: v('block'),
    failed: v('failed'), skipped: v('skipped'), limit_hits: v('limit_hit'),
    email_opened: v('email_opened'), email_clicked: v('email_clicked'), email_bounced: v('email_bounced'),
    open_rate: rate(v('email_opened'), emails), click_rate: rate(v('email_clicked'), emails), bounce_rate: rate(v('email_bounced'), emails),
  };
}

/** Everything a sender did that the dashboard calls "sent" (invites, messages, InMails, emails, views, likes …). */
export function sentCount(t: Totals): number {
  return t.invites + t.messages + t.inmails + t.emails + t.profile_views + t.likes + t.comments + t.endorsements + t.follows + t.withdrawn;
}
