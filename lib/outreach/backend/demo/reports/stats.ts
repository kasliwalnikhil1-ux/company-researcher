/**
 * Sequence stats for the product tour (migrations/outreach/089_sequence_stats.sql): the lead-level and per-channel
 * facts of a sequence computed from the demo tables with the same rules as outreach__stats_truth_leads /
 * outreach__stats_truth_channels, then the list row (outreach__stats_row), the channel blocks and the channels.
 * Nothing here is a second definition: the rules are copied from the migration, in order, with the same names.
 */
import type { DemoStore, Row } from '../store';
import { channelOf, dayIn, LIVE_ENROLLMENT, MILESTONES, rate, syncMilestones } from './facts';
import { stepNumbers } from './sequence';

type Channel = 'linkedin' | 'instagram' | 'whatsapp' | 'email';
const CHANNELS: Channel[] = ['linkedin', 'instagram', 'whatsapp', 'email'];

interface LeadFact {
  enrollment_id: string; sequence_id: string; lead_id: string; sender_id: string;
  first_attempt_at: string; first_contacted_at: string | null; first_contact_channel: Channel | null; last_touch_at: string | null;
  invited_at: string | null; invite_channel: Channel | null; accepted_at: string | null; invite_closed_at: string | null; invite_closed_reason: 'withdrawn' | 'declined' | null;
  replied_at: string | null; reply_channel: Channel | null; reply_message_id: string | null; auto_replied_at: string | null; positive_at: string | null; meeting_at: string | null;
}
interface ChannelFact {
  enrollment_id: string; channel: Channel; sequence_id: string; lead_id: string;
  contacted_at: string | null; invited_at: string | null; accepted_at: string | null; messaged_at: string | null; seen_at: string | null; replied_at: string | null; bounced_at: string | null;
}
interface Touch { id: string; enrollment_id: string; lead_id: string; sender_id: string; at: string; ch: Channel; kind: 'invite' | 'message' }

const actionChannel = (type: string, provider: string | null | undefined): Channel => (type === 'email' ? 'email' : (channelOf(provider) as Channel));
function touchKind(type: string, ch: Channel): 'invite' | 'message' | null {
  if (ch === 'linkedin' && type === 'invite') return 'invite';
  if (ch === 'linkedin' && (type === 'message' || type === 'inmail')) return 'message';
  if (ch === 'instagram' && type === 'follow') return 'invite';
  if (ch === 'instagram' && (type === 'new_chat' || type === 'message')) return 'message';
  if (ch === 'whatsapp' && (type === 'new_chat' || type === 'message')) return 'message';
  if (ch === 'email' && type === 'email') return 'message';
  return null;
}
/** outreach__msg_kind: person | auto | bounce | ours | null */
function msgKind(m: Row): 'person' | 'auto' | 'bounce' | 'ours' | null {
  if (m.event_type != null || ['event', 'csat'].includes(m.content_type ?? 'text') || m.sender_type === 'system') return null;
  if (m.direction === 'out') return 'ours';
  if (m.is_bounce) return 'bounce';
  if (m.is_auto_reply || m.intent === 'ooo') return 'auto';
  return 'person';
}
const minIso = (a: string | null, b: string | null) => (a === null ? b : b === null ? a : a < b ? a : b);
const plusMinutes = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60000).toISOString();
const plusDays = (iso: string, d: number) => new Date(Date.parse(iso) + d * 86400000).toISOString();

interface Facts { leads: LeadFact[]; channels: ChannelFact[] }
interface Cache { rev: number; bySeq: Map<string, Facts> }
const caches = new WeakMap<DemoStore, Cache>();

/** The facts of one sequence (its enrolments; credit decisions look at every enrolment of each lead). Cached per store revision. */
export function sequenceFacts(store: DemoStore, sequenceId: string): Facts {
  syncMilestones(store);
  let c = caches.get(store);
  if (!c || c.rev !== store.rev) { c = { rev: store.rev, bySeq: new Map() }; caches.set(store, c); }
  const hit = c.bySeq.get(sequenceId);
  if (hit) return hit;
  const f = computeFacts(store, sequenceId);
  c.bySeq.set(sequenceId, f);
  return f;
}

function computeFacts(store: DemoStore, sequenceId: string): Facts {
  const scope = store.t('outreach_enrollments').filter((e) => e.sequence_id === sequenceId);
  const leadIds = new Set(scope.map((e) => e.lead_id));
  const en = store.t('outreach_enrollments').filter((e) => leadIds.has(e.lead_id));
  const enById = new Map(en.map((e) => [e.id, e]));
  const senders = new Map(store.t('outreach_senders').map((s) => [s.id, s]));
  const isMain = (a: Row) => !(a.payload?.prefetch === true || a.payload?.subtask === true);

  // tk: every sent touch of those leads' enrolments
  const tk: Touch[] = [];
  const checks = new Map<string, string>();   // enrollment → first failed WhatsApp number check
  const withdraws: Row[] = [];
  for (const a of store.t('outreach_actions')) {
    if (!a.executed_at) continue;
    if (a.action_type === 'withdraw' && a.status === 'sent' && leadIds.has(a.lead_id)) withdraws.push(a);
    if (!a.enrollment_id || !enById.has(a.enrollment_id)) continue;
    if (a.action_type === 'identifier_check' && a.status === 'skipped' && a.error_code === 'E_IDENTIFIER_INVALID') {
      checks.set(a.enrollment_id, minIso(checks.get(a.enrollment_id) ?? null, a.executed_at)!);
      continue;
    }
    if (a.status !== 'sent' || !isMain(a)) continue;
    const ch = actionChannel(a.action_type, senders.get(a.sender_id)?.provider);
    const kind = touchKind(a.action_type, ch);
    if (!kind) continue;
    tk.push({ id: a.id, enrollment_id: a.enrollment_id, lead_id: a.lead_id ?? enById.get(a.enrollment_id)!.lead_id, sender_id: a.sender_id, at: a.executed_at, ch, kind });
  }
  tk.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : 1));
  const tkByEnrollment = new Map<string, Touch[]>();
  const tkByLead = new Map<string, Touch[]>();
  for (const t of tk) {
    (tkByEnrollment.get(t.enrollment_id) ?? tkByEnrollment.set(t.enrollment_id, []).get(t.enrollment_id)!).push(t);
    (tkByLead.get(t.lead_id) ?? tkByLead.set(t.lead_id, []).get(t.lead_id)!).push(t);
  }

  // lf: per enrolment (all enrolments of the leads)
  interface Lf { enrollment_id: string; lead_id: string; sender_id: string; first: string | null; firstCh: Channel | null; last: string | null; invited: string | null; inviteCh: Channel | null }
  const lf = new Map<string, Lf>();
  for (const e of en) {
    const ts = tkByEnrollment.get(e.id) ?? [];
    const inv = ts.find((t) => t.kind === 'invite') ?? null;
    lf.set(e.id, { enrollment_id: e.id, lead_id: e.lead_id, sender_id: e.sender_id, first: ts[0]?.at ?? null, firstCh: ts[0]?.ch ?? null, last: ts.length ? ts[ts.length - 1].at : null, invited: inv?.at ?? null, inviteCh: inv?.ch ?? null });
  }
  const lss = new Map(store.t('outreach_lead_sender_state').map((x) => [`${x.lead_id}|${x.sender_id}`, x]));

  // acc / wd / dc
  const accepted = new Map<string, string>();
  const closed = new Map<string, { at: string; reason: 'withdrawn' | 'declined' }>();
  for (const f of lf.values()) {
    if (!f.invited) continue;
    const x = lss.get(`${f.lead_id}|${f.sender_id}`);
    if (x?.invite_accepted_at && x.invite_accepted_at >= plusMinutes(f.invited, -1)) {
      const later = [...lf.values()].some((l2) => l2.lead_id === f.lead_id && l2.sender_id === f.sender_id && l2.enrollment_id !== f.enrollment_id && !!l2.invited && l2.invited > f.invited! && l2.invited <= plusMinutes(x.invite_accepted_at, 1));
      if (!later) accepted.set(f.enrollment_id, x.invite_accepted_at);
    }
    if (!accepted.has(f.enrollment_id)) {
      const wd = withdraws.filter((a) => a.lead_id === f.lead_id && a.sender_id === f.sender_id && a.executed_at > f.invited!).map((a) => a.executed_at as string).sort()[0];
      if (wd) closed.set(f.enrollment_id, { at: wd, reason: 'withdrawn' });
      else if (x?.invite_withdrawn_at && x.invite_withdrawn_at > f.invited) closed.set(f.enrollment_id, { at: x.invite_withdrawn_at, reason: 'declined' });
    }
  }

  // inb / cred: what the other side wrote, credited to the latest touch before it (any sequence, any sender)
  const chats = new Map(store.t('outreach_chats').map((c) => [c.id, c]));
  interface Inb { id: string; at: string; lead_id: string; ch: Channel; kind: 'person' | 'auto'; intent: string | null; enrollment_id: string | null }
  const inb: Inb[] = [];
  const bounces: Array<{ lead_id: string; at: string; ch: Channel }> = [];
  for (const m of store.t('outreach_messages')) {
    const c = chats.get(m.chat_id);
    if (!c || !c.lead_id || !leadIds.has(c.lead_id) || m.direction !== 'in' || m.deleted_at || c.provider === 'WEBCHAT' || !m.sent_at) continue;
    const kind = msgKind(m);
    const ch = channelOf(c.provider) as Channel;
    if (kind === 'bounce') { bounces.push({ lead_id: c.lead_id, at: m.sent_at, ch }); continue; }
    if (kind !== 'person' && kind !== 'auto') continue;
    let cred: Touch | null = null;
    for (const t of tkByLead.get(c.lead_id) ?? []) { if (t.at < m.sent_at) cred = t; else break; }
    inb.push({ id: m.id, at: m.sent_at, lead_id: c.lead_id, ch, kind, intent: m.intent ?? null, enrollment_id: cred?.enrollment_id ?? null });
  }
  inb.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : x.id < y.id ? -1 : 1));
  const rep1 = new Map<string, Inb>();      // first human reply per enrolment
  const aut = new Map<string, string>();
  const repByChannel = new Map<string, string>();   // `${enrollment}|${ch}` → first human reply
  for (const i of inb) {
    if (!i.enrollment_id) continue;
    if (i.kind === 'person') {
      if (!rep1.has(i.enrollment_id)) rep1.set(i.enrollment_id, i);
      const k = `${i.enrollment_id}|${i.ch}`; if (!repByChannel.has(k)) repByChannel.set(k, i.at);
    } else if (!aut.has(i.enrollment_id)) aut.set(i.enrollment_id, i.at);
  }
  const pos = new Map<string, string>();
  for (const [eid, r] of rep1) {
    const hits = inb.filter((i) => i.lead_id === r.lead_id && i.kind === 'person' && (i.intent === 'interested' || i.intent === 'question') && (i.id === r.id || (i.at >= r.at && i.at <= plusDays(r.at, 30))));
    if (hits.length) pos.set(eid, hits[0].at);
  }
  const meet = new Map<string, string>();
  for (const ms of store.t(MILESTONES)) {
    if (ms.kind !== 'meeting' || !leadIds.has(ms.lead_id) || !ms.at) continue;
    const credited = [...rep1.values()].filter((r) => r.lead_id === ms.lead_id && r.at <= ms.at).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
    const eid = credited?.enrollment_id ?? [...lf.values()].filter((f) => f.lead_id === ms.lead_id && !!f.first && f.first <= ms.at).sort((a, b) => (a.first! < b.first! ? 1 : -1))[0]?.enrollment_id ?? null;
    if (eid) meet.set(eid, ms.at);
  }

  const leads: LeadFact[] = [];
  for (const e of scope) {
    const f = lf.get(e.id)!;
    const firstAttempt = minIso(f.first, checks.get(e.id) ?? null);
    if (!firstAttempt) continue;
    const acc = accepted.get(e.id) ?? null;
    const cl = acc ? null : closed.get(e.id) ?? null;
    const r = rep1.get(e.id) ?? null;
    const p = pos.get(e.id) ?? null; const mt = meet.get(e.id) ?? null;
    leads.push({
      enrollment_id: e.id, sequence_id: e.sequence_id, lead_id: e.lead_id, sender_id: e.sender_id,
      first_attempt_at: firstAttempt, first_contacted_at: f.first, first_contact_channel: f.firstCh, last_touch_at: f.last, invited_at: f.invited, invite_channel: f.inviteCh,
      accepted_at: acc, invite_closed_at: cl?.at ?? null, invite_closed_reason: cl?.reason ?? null,
      replied_at: r?.at ?? null, reply_channel: r?.ch ?? null, reply_message_id: r?.id ?? null, auto_replied_at: aut.get(e.id) ?? null, positive_at: minIso(p, mt), meeting_at: mt,
    });
  }

  // channel facts
  const msgsByAction = new Map<string, Row[]>();
  for (const m of store.t('outreach_messages')) if (m.action_id && m.direction === 'out') (msgsByAction.get(m.action_id) ?? msgsByAction.set(m.action_id, []).get(m.action_id)!).push(m);
  const channels: ChannelFact[] = [];
  for (const e of scope) {
    const rows = new Map<Channel, ChannelFact>();
    const row = (ch: Channel) => rows.get(ch) ?? rows.set(ch, { enrollment_id: e.id, channel: ch, sequence_id: e.sequence_id, lead_id: e.lead_id, contacted_at: null, invited_at: null, accepted_at: null, messaged_at: null, seen_at: null, replied_at: null, bounced_at: null }).get(ch)!;
    const lead = leads.find((l) => l.enrollment_id === e.id);
    for (const t of tkByEnrollment.get(e.id) ?? []) {
      const r = row(t.ch);
      r.contacted_at = minIso(r.contacted_at, t.at);
      if (t.kind === 'invite') r.invited_at = minIso(r.invited_at, t.at); else r.messaged_at = minIso(r.messaged_at, t.at);
      for (const m of msgsByAction.get(t.id) ?? []) {
        if (m.read_at) r.seen_at = minIso(r.seen_at, m.read_at);
        if (t.ch === 'email' && m.bounced_at) r.bounced_at = minIso(r.bounced_at, m.bounced_at);
      }
      if (t.ch === 'email') for (const b of bounces) if (b.lead_id === e.lead_id && b.ch === 'email' && b.at >= t.at && b.at < plusDays(t.at, 3)) r.bounced_at = minIso(r.bounced_at, b.at);
    }
    const chk = checks.get(e.id);
    if (chk) row('whatsapp').bounced_at = minIso(row('whatsapp').bounced_at, chk);
    for (const ch of CHANNELS) { const at = repByChannel.get(`${e.id}|${ch}`); if (at) row(ch).replied_at = at; }
    if (lead?.invite_channel && lead.accepted_at && rows.has(lead.invite_channel)) rows.get(lead.invite_channel)!.accepted_at = lead.accepted_at;
    channels.push(...rows.values());
  }
  return { leads, channels };
}

// ---------------------------------------------------------------------------
// reading (outreach__stats_block, outreach__stats_channel_blocks, outreach__sequence_channels, outreach__stats_progress)
// ---------------------------------------------------------------------------
export interface Bounds { from: string; to: string }   // inclusive calendar days in the workspace timezone
const inCohort = (f: LeadFact, b: Bounds | null, tz: string) => { if (!b) return true; const d = dayIn(Date.parse(f.first_attempt_at), tz); return d >= b.from && d <= b.to; };
const uniq = <T>(xs: T[]) => new Set(xs).size;

export function statsBlock(store: DemoStore, sequenceId: string, b: Bounds | null, tz: string): Row {
  const { leads } = sequenceFacts(store, sequenceId);
  const cohortRows = leads.filter((f) => inCohort(f, b, tz));
  const byLead = new Map<string, LeadFact[]>();
  for (const f of cohortRows) (byLead.get(f.lead_id) ?? byLead.set(f.lead_id, []).get(f.lead_id)!).push(f);
  // the cohort's leads, every enrolment of each (a lead re-enrolled counts once)
  const all = leads.filter((f) => byLead.has(f.lead_id));
  const per = new Map<string, LeadFact[]>();
  for (const f of all) (per.get(f.lead_id) ?? per.set(f.lead_id, []).get(f.lead_id)!).push(f);
  let contacted = 0, invited = 0, acc = 0, pending = 0, replied = 0, auto = 0, positive = 0, meetings = 0;
  const repCh: Record<string, number> = {};
  const split: Record<string, { invited: Set<string>; accepted: Set<string>; pending: Set<string> }> = {};
  for (const [lead, fs] of per) {
    if (fs.some((f) => f.first_contacted_at)) contacted++;
    const inv = fs.some((f) => f.invited_at), ac = fs.some((f) => f.accepted_at);
    if (inv) invited++; if (ac) acc++;
    if (inv && !ac && fs.some((f) => f.invited_at && !f.accepted_at && !f.invite_closed_at)) pending++;
    const r = fs.filter((f) => f.replied_at).sort((x, y) => (x.replied_at! < y.replied_at! ? -1 : 1))[0];
    if (r) { replied++; repCh[r.reply_channel!] = (repCh[r.reply_channel!] ?? 0) + 1; } else if (fs.some((f) => f.auto_replied_at)) auto++;
    if (fs.some((f) => f.positive_at)) positive++;
    if (fs.some((f) => f.meeting_at)) meetings++;
    for (const f of fs) {
      if (!f.invite_channel) continue;
      const s = split[f.invite_channel] ?? (split[f.invite_channel] = { invited: new Set(), accepted: new Set(), pending: new Set() });
      s.invited.add(lead); if (f.accepted_at) s.accepted.add(lead); if (!f.accepted_at && !f.invite_closed_at) s.pending.add(lead);
    }
  }
  return {
    contacted, invited, accepted: acc, accepted_rate: rate(acc, invited), pending, accepted_early: invited > 0 && pending * 2 > invited,
    accepted_split: Object.fromEntries(Object.entries(split).map(([ch, s]) => [ch, { invited: s.invited.size, accepted: s.accepted.size, pending: s.pending.size, accepted_rate: rate(s.accepted.size, s.invited.size) }])),
    replied, replied_rate: rate(replied, contacted), auto_replied: auto, positive, positive_rate: rate(positive, replied), meetings,
    replied_by_channel: repCh, cohort: per.size,
  };
}

export function channelBlocks(store: DemoStore, sequenceId: string, b: Bounds | null, tz: string): Record<string, Row> {
  const { leads, channels } = sequenceFacts(store, sequenceId);
  const cohort = new Set(leads.filter((f) => inCohort(f, b, tz)).map((f) => f.lead_id));
  const out: Record<string, Row> = {};
  for (const ch of CHANNELS) {
    const rows = channels.filter((c) => c.channel === ch && cohort.has(c.lead_id));
    if (!rows.length) continue;
    const n = (p: (c: ChannelFact) => boolean) => uniq(rows.filter(p).map((c) => c.lead_id));
    const contacted = n((c) => !!c.contacted_at && (ch !== 'email' || !c.bounced_at));
    const invitedN = n((c) => !!c.invited_at), accepted = n((c) => !!c.accepted_at), messaged = n((c) => !!c.messaged_at), seen = n((c) => !!c.seen_at);
    const replied = n((c) => !!c.replied_at), roa = n((c) => !!c.replied_at && !!c.accepted_at), bounced = n((c) => !!c.bounced_at);
    out[ch] = ch === 'linkedin' ? { contacted, invited: invitedN, accepted, accepted_rate: rate(accepted, invitedN), messaged, seen, replied, replied_rate: rate(replied, contacted), replied_of_accepted: roa, replied_of_accepted_rate: rate(roa, accepted) }
      : ch === 'instagram' ? { contacted, invited: invitedN, accepted, accepted_rate: rate(accepted, invitedN), messaged, seen, replied, replied_rate: rate(replied, contacted) }
      : ch === 'whatsapp' ? { contacted, seen, replied, replied_rate: rate(replied, contacted), bounced }
      : { contacted, replied, replied_rate: rate(replied, contacted), bounced };
  }
  return out;
}

/** outreach__graph_channels + the facts: the channels a sequence uses, steps first, then activity-only ones. */
export function sequenceChannels(store: DemoStore, seq: Row, b: Bounds | null, tz: string): Row[] {
  const nums = stepNumbers(seq.graph);
  const senders = new Map(store.t('outreach_senders').map((s) => [s.id, s]));
  const poolProvs = [...new Set((seq.sender_pool ?? []).map((id: string) => String(senders.get(id)?.provider ?? '').toLowerCase()).filter((p: string) => ['linkedin', 'instagram', 'whatsapp'].includes(p)))] as Channel[];
  const graph = new Map<Channel, { ord: number; invite: boolean }>();
  const nodes = Object.entries<Row>(seq.graph?.nodes ?? {}).sort(([a], [b2]) => (nums[a] ?? 9999) - (nums[b2] ?? 9999) || a.localeCompare(b2));
  let i = 0;
  for (const [, n] of nodes) {
    const t = String(n.type); const c = String(n.config?.channel ?? n.config?.to_channel ?? '').toLowerCase() || null;
    let chans: string[] | null = null;
    if (t === 'send_email') chans = ['email'];
    else if (['send_invite', 'send_inmail', 'withdraw_invite', 'visit_profile', 'refresh_profile', 'like_latest_post', 'comment_latest_post', 'endorse_skills', 'follow_profile'].includes(t)) chans = ['linkedin'];
    else if (t === 'channel_switch') chans = c ? [c] : null;
    else if (t === 'send_message' || t === 'send_voice_note') chans = c ? [c] : poolProvs.length ? poolProvs : ['linkedin'];
    else if (['follow', 'unfollow', 'like_recent_posts', 'comment_post'].includes(t)) chans = [c ?? 'instagram'];
    else if (t === 'check_identifier') chans = [c ?? 'whatsapp'];
    for (const x of chans ?? []) {
      if (!CHANNELS.includes(x as Channel)) continue;
      const cur = graph.get(x as Channel) ?? { ord: ++i, invite: false };
      cur.invite = cur.invite || (t === 'send_invite' && x === 'linkedin') || (t === 'follow' && x === 'instagram');
      graph.set(x as Channel, cur);
    }
  }
  const { leads, channels } = sequenceFacts(store, seq.id);
  const cohort = new Set(leads.filter((f) => inCohort(f, b, tz)).map((f) => f.lead_id));
  const activity = new Map<Channel, string>();
  for (const c of channels) {
    if (!cohort.has(c.lead_id) || (!c.contacted_at && !c.bounced_at)) continue;
    const at = minIso(c.contacted_at, c.bounced_at)!;
    activity.set(c.channel, minIso(activity.get(c.channel) ?? null, at)!);
  }
  const out: Row[] = [];
  for (const [ch, g] of [...graph.entries()].sort((a, b2) => a[1].ord - b2[1].ord)) out.push({ channel: ch, invite_step: g.invite, from_earlier_version: false });
  for (const [ch] of [...activity.entries()].sort((a, b2) => (a[1] < b2[1] ? -1 : 1))) if (!graph.has(ch)) out.push({ channel: ch, invite_step: false, from_earlier_version: true });
  return out;
}

export function progressOf(store: DemoStore, sequenceId: string): Row {
  const enr = store.t('outreach_enrollments').filter((e) => e.sequence_id === sequenceId);
  const live = enr.filter((e) => LIVE_ENROLLMENT.includes(e.status)).length;
  let queued = 0, sent = 0, failed = 0;
  for (const n of store.t('outreach_node_stats')) if (n.sequence_id === sequenceId) { queued += n.queued ?? 0; sent += n.sent ?? 0; failed += n.failed ?? 0; }
  return {
    progress: { enrolled: uniq(enr.map((e) => e.lead_id)), live, done: enr.length - live, pct_done: enr.length ? Math.round((1000 * (enr.length - live)) / enr.length) / 10 : null },
    ops: { queued, actions_sent: sent, failed, failed_leads: enr.filter((e) => e.status === 'failed').length },
  };
}

function naOf(channels: Row[], block: Row): Row {
  const na: Row = {};
  if (!channels.some((c) => c.invite_step) && (block.invited ?? 0) === 0) na.accepted = "This sequence doesn't send connection requests or follows.";
  if (channels.length > 0 && channels.every((c) => c.channel === 'email')) na.seen = "Email opens aren't tracked.";
  return na;
}

const STEP_TYPES = new Set(['wait_connection', 'ab_split', 'ai_route', 'manual_task', 'call_task', 'channel_switch', 'condition']);
/** outreach__stats_row */
export function statsRow(store: DemoStore, seq: Row, b: Bounds | null, tz: string, executable: (t: string) => boolean): Row {
  const block = statsBlock(store, seq.id, b, tz);
  const channels = sequenceChannels(store, seq, b, tz);
  return {
    sequence_id: seq.id, name: seq.name, status: seq.status, client_id: seq.client_id ?? null, head_version: seq.head_version ?? 1,
    steps: Object.values<Row>(seq.graph?.nodes ?? {}).filter((n) => executable(String(n.type)) || STEP_TYPES.has(String(n.type))).length,
    stalled: !!seq.stalled_at, stalled_reason: seq.stalled_reason ?? null, throttled_reason: seq.throttled_reason ?? null,
    has_ab_test: JSON.stringify(seq.graph ?? {}).includes('"variants"') || JSON.stringify(seq.graph ?? {}).includes('"ab_split"'), updated_at: seq.updated_at ?? seq.created_at ?? null,
    channels, na: naOf(channels, block), cached_at: b ? null : new Date().toISOString(), definitions_version: 2,
    ...block, ...progressOf(store, seq.id),
  };
}
