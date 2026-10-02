/**
 * "Why is nothing sending?" (outreach_why_not_sending + outreach__sender_causes, 026) and the sender insights
 * (outreach_sender_insights), computed from the demo store: sender status, schedule, today's budget from the actions,
 * queued actions and sequence status. Same codes and sentences as the SQL.
 */
import { NODE_CATALOG } from '../../../nodes';
import { demoError, inWs, type Ctx } from '../ctx';
import type { DemoStore, Row } from '../store';
import { capFor, localParts, simWallClock } from '../sim/caps';
import {
  ceilingProvider, channelCaps, channelTotal, D, fmtTime, H, inHours, iso, nextInSchedule, PROVIDER_LABEL, scopesToday, todayBudgets,
} from './util';

type Cause = Row;
const ACTION_LABEL: Record<string, string> = {
  invite: 'invitations', message: 'messages', inmail: 'InMails', profile_view: 'profile views', like: 'likes', comment: 'comments', endorse: 'endorsements',
  email: 'emails', follow: 'follows', unfollow: 'unfollows', new_chat: 'new conversations', withdraw: 'withdrawals', identifier_check: 'number checks', search_page: 'search pages',
};
const actionLabel = (t: string) => ACTION_LABEL[t] ?? t.replace(/_/g, ' ');
const STATUS_LIVE = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'];

export function defaultNeed(provider: string): string[] {
  if (provider === 'INSTAGRAM') return ['new_chat', 'message', 'follow', 'like', 'comment', 'profile_view'];
  if (provider === 'WHATSAPP') return ['new_chat', 'message', 'identifier_check'];
  if (provider === 'LINKEDIN') return ['invite', 'message'];
  return ['email'];
}

/** Week of p_day (Monday start) invitations used: sent / reserved invite actions on sender-local days of that week. */
export function weeklyInvitesUsed(store: DemoStore, s: Row, day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date();
  const wd = (d.getUTCDay() + 6) % 7;   // Monday = 0
  const monday = new Date(d.getTime() - wd * D).toISOString().slice(0, 10);
  const next = new Date(d.getTime() + (7 - wd) * D).toISOString().slice(0, 10);
  const tz = s.timezone ?? 'UTC';
  let n = 0;
  for (const a of store.t('outreach_actions')) {
    if (a.sender_id !== s.id || a.action_type !== 'invite' || (a.status !== 'sent' && a.status !== 'reserved') || !a.executed_at) continue;
    const ld = localParts(Date.parse(a.executed_at), tz).day;
    if (ld >= monday && ld < next) n++;
  }
  return n;
}

export function senderCauses(store: DemoStore, senderId: string, need: string[]): Cause[] {
  const s = store.get('outreach_senders', senderId);
  if (!s || s.deleted_at) return [{ code: 'E_SENDER_NOT_OK', blocking: true, sender_id: senderId, detail: 'This sender no longer exists', remedy: 'Remove it from the pool.' }];
  const c: Cause[] = [];
  const nm = s.display_name ?? 'Sender';
  const tz = s.timezone ?? 'UTC';
  const now = Date.now();
  const base = { sender: nm, sender_id: s.id };
  const caps = channelCaps(store, s.provider);
  const plan = store.get('outreach_workspaces', s.workspace_id)?.plan;
  if (plan === 'suspended') c.push({ code: 'E_PLAN_SUSPENDED', blocking: true, ...base, detail: 'The workspace is suspended (billing)', remedy: 'An owner fixes billing; sending resumes on its own afterwards.' });
  if (s.status !== 'ok') {
    const why = s.status === 'credentials' ? ` is disconnected from ${PROVIDER_LABEL[s.provider] ?? s.provider} (session expired)` : s.status === 'error' ? ` reports a provider error (${s.status_reason ?? 'unknown'})`
      : s.status === 'paused' ? ` is paused (${s.status_reason ?? 'by a teammate'})` : s.status === 'connecting' ? ' is still connecting' : ` is ${s.status}`;
    c.push({ code: 'E_SENDER_NOT_OK', blocking: true, ...base, detail: nm + why, remedy: s.status === 'paused' ? 'A manager resumes it on the sender page.' : 'Reconnect it on the sender page.' });
  }
  const pausedUntil = s.paused_until ? Date.parse(s.paused_until) : 0;
  if (s.provider_warning && pausedUntil > now && s.status_reason === 'provider_warning') {
    c.push({ code: 'E_PROVIDER_WARNING', blocking: true, ...base, next_capacity: s.paused_until, detail: `${nm} is paused after a warning from ${PROVIDER_LABEL[s.provider] ?? s.provider}: "${s.provider_warning?.text ?? ''}"`, remedy: 'Read the warning on the sender page. A manager can resume it early; the pause protects the account.' });
  } else if (pausedUntil > now) {
    c.push({ code: 'E_SENDER_PAUSED', blocking: true, ...base, next_capacity: s.paused_until, detail: `${nm} is resting until ${fmtTime(pausedUntil, tz)} (${s.status_reason ?? 'safety pause'})`, remedy: 'Wait it out. Do not move volume to other senders to compensate.' });
  }
  if (s.outreach_allowed_from && Date.parse(s.outreach_allowed_from) > now) {
    const hrs = Number(caps?.ledger?.post_connect_quiet_hours ?? 24) || 24;
    c.push({ code: 'E_QUIET_PERIOD', blocking: true, ...base, next_capacity: s.outreach_allowed_from, detail: `${nm} connected recently and waits until ${fmtTime(Date.parse(s.outreach_allowed_from), tz)} before outreach (${hrs} h quiet period)`, remedy: 'By design: a number that starts outreach right after connecting looks suspicious. Replies still go out.' });
  }
  if (!inHours(store, s, now)) {
    const nw = nextInSchedule(store, s, now, 8);
    c.push({ code: nw == null ? 'E_NO_SCHEDULE' : 'W_OUT_OF_SCHEDULE', blocking: nw == null, ...base, next_capacity: nw == null ? null : iso(nw),
      detail: nw == null ? `${nm} has no working hours in the next 7 days` : `${nm} is outside working hours; sending resumes ${fmtTime(simWallClock(store, nw), tz, 'weekday_time')} (${tz})`,
      remedy: nw == null ? 'Set working hours on the sender page.' : 'Nothing to fix.' });
  }
  const hasWindowToday = (() => { const wd = localParts(simWallClock(store, now), tz).wd; const sched = s.schedule as Row | undefined; return !sched || (Array.isArray(sched[wd]) && sched[wd].length > 0); })();
  for (const b of todayBudgets(store, s)) {
    if (!need.includes(b.action_type)) continue;
    if (b.cap === 0) {
      if (hasWindowToday) c.push({ code: 'E_CAP_ZERO', blocking: true, ...base, detail: `${nm} has no allowance for ${actionLabel(b.action_type)} today (warm-up level ${s.warmup_level}, health ${s.health_score})`, remedy: 'Allowances rise with warm-up level and health. A manager can check the manual caps.' });
    } else if (b.used + b.reserved >= b.cap) {
      c.push({ code: 'W_BUDGET_EXHAUSTED', blocking: false, ...base, next_capacity: 'tomorrow', detail: `${nm} used today's allowance for ${actionLabel(b.action_type)} (${b.used + b.reserved} of ${b.cap})`, remedy: 'Resumes tomorrow. Add another healthy sender for more volume; do not raise caps.' });
    }
  }
  const scopes = scopesToday(store, s);
  if (scopes.day && scopes.day.cap > 0 && scopes.day.used + scopes.day.reserved >= scopes.day.cap) {
    c.push({ code: 'W_BUDGET_EXHAUSTED', blocking: false, ...base, next_capacity: 'tomorrow', detail: `${nm} used today's total allowance (${scopes.day.used + scopes.day.reserved} of ${scopes.day.cap} actions)`, remedy: 'Resumes tomorrow. Instagram is a low-volume channel; better targeting beats more actions.' });
  }
  if (scopes.hour && scopes.hour.used + scopes.hour.reserved >= scopes.hour.cap) {
    c.push({ code: 'W_HOURLY_CAP', blocking: false, ...base, next_capacity: iso(Math.floor(now / H) * H + H), detail: `${nm} used this hour's allowance (${scopes.hour.used + scopes.hour.reserved} of ${scopes.hour.cap} actions)`, remedy: 'Continues next hour. Nothing to fix.' });
  }
  const gap = Number(caps?.ledger?.min_gap_seconds?.[0] ?? 0);
  if (gap > 0) {
    let last = 0;
    for (const a of store.t('outreach_actions')) if (a.sender_id === s.id && (a.status === 'sent' || a.status === 'failed') && a.action_type !== 'reply' && a.executed_at) { const t = Date.parse(a.executed_at); if (t > last) last = t; }
    if (last && now - last < gap * 1000) c.push({ code: 'W_MIN_GAP', blocking: false, ...base, next_capacity: iso(last + gap * 1000), detail: `${nm} acted ${Math.round((now - last) / 1000)} seconds ago; the next action waits for the ${gap}-second gap`, remedy: 'Nothing to fix.' });
  }
  if (need.includes('invite') && ceilingProvider(s.provider) === 'LINKEDIN') {
    const wk = weeklyInvitesUsed(store, s, localParts(now, tz).day);
    const wkc = store.t('outreach_platform_ceilings').find((x) => x.provider === 'LINKEDIN' && x.action_type === 'invite')?.per_week ?? 150;
    if (wk >= wkc) c.push({ code: 'E_CAP_HIT_WEEKLY', blocking: true, ...base, detail: `${nm} reached the weekly invitation ceiling (${wk} of ${wkc})`, remedy: 'Invitations resume next week; messages continue.' });
    if (s.invite_blocked_until && Date.parse(s.invite_blocked_until) > now) c.push({ code: 'E_INVITE_BLOCKED', blocking: true, ...base, next_capacity: s.invite_blocked_until, detail: `${nm}: LinkedIn refused further invitations until ${fmtTime(Date.parse(s.invite_blocked_until), tz, 'date')}`, remedy: 'Wait. Other steps continue.' });
  }
  const health = Number(s.health_score ?? 100);
  if (health < 50) c.push({ code: 'E_HEALTH_PAUSED', blocking: true, ...base, detail: `${nm} has a health score of ${health}: below 50 every allowance is 0`, remedy: 'Open the sender page for the failing category; recovery takes days of low, steady activity.' });
  else if (health < 70) c.push({ code: 'W_HEALTH_REDUCED', blocking: false, ...base, detail: `${nm} has a health score of ${health}: allowances are reduced to 60%`, remedy: 'Keep volume steady.' });
  return c;
}

function sequenceNeed(seq: Row): string[] | null {
  const nodes = Object.values((seq.graph?.nodes ?? {}) as Record<string, Row>);
  const need = new Set<string>();
  for (const n of nodes) { const t = (NODE_CATALOG as Record<string, { actionType: string | null }>)[n.type]?.actionType; if (t) need.add(t); }
  if (!need.size) return null;
  if (nodes.some((n) => n.type === 'send_message' || n.type === 'send_voice_note')) need.add('new_chat');
  return [...need];
}

const fmtStatus = (s: string) => s.replace(/_/g, ' ');

export function whyNotSending(ctx: Ctx, args: Row): Row {
  const store = ctx.store;
  let causes: Cause[] = [];
  const notes: string[] = [];
  let target = '';
  let seqId: string | null = args.p_sequence ?? null;
  let e: Row | undefined;
  if (args.p_enrollment) {
    e = store.get('outreach_enrollments', args.p_enrollment);
    if (!e) demoError('E_NOT_FOUND', 'Enrollment not found');
    seqId = e.sequence_id;
  } else if (!seqId && !args.p_sender) demoError('E_PAYLOAD_INVALID', 'sequence, sender or enrollment required');
  const flags = store.meta<Row>('platformFlags', () => ({}));
  for (const k of ['tick_enabled', 'planner_enabled']) if (flags[k] === false) causes.push({ code: 'E_PLATFORM_PAUSED', blocking: true, detail: `Automation is paused platform-wide by the operators (${k})`, remedy: 'Nothing to do in the workspace.' });

  const q = seqId ? store.get('outreach_sequences', seqId) : undefined;
  if (seqId && !q) demoError('E_NOT_FOUND', 'Sequence not found');
  let need: string[] | null = null;
  if (q) {
    target = `Sequence "${q.name}"`;
    if (q.status !== 'active') causes.push({ code: 'E_SEQUENCE_NOT_ACTIVE', blocking: true, detail: `The sequence is ${q.status}`, remedy: 'Activate it.' });
    if (!(q.sender_pool ?? []).length) causes.push({ code: 'E_POOL_EMPTY', blocking: true, detail: 'The sequence has no senders', remedy: 'Add a connected sender to the pool.' });
    need = sequenceNeed(q);
  }

  if (e && q) {
    const l = store.get('outreach_leads', e.lead_id);
    target = `${l?.full_name ?? 'Lead'} in "${q.name}"`;
    const graph = e.pinned_version ? store.t('outreach_sequence_versions').find((v) => v.sequence_id === q.id && v.version === e!.pinned_version)?.graph ?? q.graph : q.graph;
    const n: Row | undefined = graph?.nodes?.[e.current_node_id];
    const at = n ? (NODE_CATALOG as Record<string, { actionType: string | null }>)[n.type]?.actionType : null;
    need = at ? [at] : [];
    const sn = store.get('outreach_senders', e.sender_id);
    if (!STATUS_LIVE.includes(e.status)) {
      causes.push({ code: 'E_ENROLLMENT_NOT_LIVE', blocking: true, detail: e.held_at ? 'The lead replied and is held for review' : `The lead is ${fmtStatus(e.status)}${e.exit_reason ? ` (${fmtStatus(String(e.exit_reason))})` : ''}`,
        remedy: e.held_at ? 'Resume or exit the lead from the task list.' : e.status === 'paused' ? 'Resume the lead.' : e.status === 'failed' ? 'Retry or skip the step from the failed-leads list.' : 'It is finished; enrol the lead again if appropriate.' });
    }
    if (l?.do_not_contact || l?.unsubscribed) causes.push({ code: 'E_LEAD_SUPPRESSED', blocking: true, detail: `The lead is blacklisted (${l.do_not_contact ? 'do not contact' : 'unsubscribed'})`, remedy: 'Nothing will be sent. Do not work around a blacklist.' });
    if (sn && (sn.provider === 'WHATSAPP' || sn.provider === 'INSTAGRAM') && !store.t('outreach_lead_identities').some((x) => x.lead_id === e!.lead_id && x.provider === sn.provider)) {
      causes.push({ code: 'E_NO_IDENTITY', blocking: true, detail: `${l?.full_name ?? 'The lead'} has no ${PROVIDER_LABEL[sn.provider]} ${sn.provider === 'WHATSAPP' ? 'number' : 'handle'} on file`, remedy: 'Add it on the lead page and mark it verified.' });
    }
    const until = e.wait_until ? fmtTime(Date.parse(e.wait_until), sn?.timezone ?? 'UTC') : '';
    if (e.status === 'waiting_delay') {
      causes.push(n?.type === 'wait_for_reply'
        ? { code: 'W_WAITING_REPLY', blocking: false, next_capacity: e.wait_until, detail: `Waiting for a reply until ${until}`, remedy: 'By design; it continues on its own.' }
        : { code: 'W_WAITING_DELAY', blocking: false, next_capacity: e.wait_until, detail: `Waiting in a delay until ${until}`, remedy: 'By design; it continues on its own.' });
    }
    if (e.status === 'waiting_connection') {
      const rel = store.t('outreach_lead_sender_state').find((x) => x.lead_id === e!.lead_id && x.sender_id === e!.sender_id)?.relation;
      const ends = e.wait_until ? fmtTime(Date.parse(e.wait_until), sn?.timezone ?? 'UTC', 'date') : '';
      causes.push(n?.type === 'wait_follow_back'
        ? { code: 'W_WAITING_FOLLOW_BACK', blocking: false, next_capacity: e.wait_until, detail: `Waiting for the lead to follow back; the window ends ${ends}`, remedy: 'By design. The followers list is checked a few times a day.' }
        : { code: 'W_WAITING_CONNECTION', blocking: false, next_capacity: e.wait_until, detail: `Waiting for the invitation to be accepted (${rel ?? 'pending'}); the window ends ${ends}`, remedy: 'By design.' });
    }
    if (e.status === 'waiting_task') {
      if (e.wait_reason === 'enrichment') causes.push({ code: 'W_WAITING_ENRICHMENT', blocking: false, detail: 'Waiting for the profile to be enriched before the first step', remedy: "Happens within the sender's profile-view allowance; starts anyway after 72 hours." });
      else if (e.wait_reason === 'ai_review') causes.push({ code: 'W_WAITING_AI_REVIEW', blocking: true, detail: 'Waiting for someone to approve the AI-written line for this lead', remedy: 'Open AI review and approve, edit or skip it.' });
      else if (e.wait_reason === 'ai_route') causes.push({ code: 'W_WAITING_AI_ROUTE', blocking: false, detail: 'Waiting for the AI routing decision', remedy: 'Decided within minutes; falls back to "everything else" after 6 hours.' });
      else {
        const tk = store.t('outreach_tasks').filter((t) => t.enrollment_id === e!.id && !t.completed_at).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
        causes.push({ code: 'W_WAITING_TASK', blocking: true, detail: `Waiting for a teammate: ${tk?.title ?? 'open task'}`, remedy: 'Complete the task.', task_id: tk?.id ?? null });
      }
    }
    if (e.status === 'active') {
      const nx = store.t('outreach_actions').filter((a) => a.enrollment_id === e!.id && (a.status === 'queued' || a.status === 'reserved')).sort((a, b) => String(a.scheduled_for).localeCompare(String(b.scheduled_for)))[0];
      if (nx) causes.push({ code: 'W_SCHEDULED', blocking: false, next_capacity: nx.scheduled_for, detail: `The next step (${actionLabel(nx.action_type)}) is planned for ${fmtTime(Date.parse(nx.scheduled_for), sn?.timezone ?? 'UTC')}${nx.decision === 'budget_deferred' ? " (moved: today's allowance was used)" : ''}`, remedy: 'Nothing to fix.' });
      else causes.push({ code: 'W_NOT_PLANNED_YET', blocking: false, detail: 'Active with no planned action yet', remedy: 'The planner assigns a slot within 20 minutes when the sender has allowance.' });
    }
    causes = causes.concat(senderCauses(store, e.sender_id, need.length ? need : defaultNeed(sn?.provider ?? 'LINKEDIN')));
  } else if (q) {
    const enr = store.t('outreach_enrollments').filter((x) => x.sequence_id === q.id);
    const live = enr.filter((x) => STATUS_LIVE.includes(x.status)).length;
    const waiting = enr.filter((x) => x.status === 'waiting_task' && x.wait_reason === 'ai_review').length;
    const ids = new Set(enr.map((x) => x.id));
    const queued = store.t('outreach_actions').filter((a) => a.status === 'queued' && a.enrollment_id && ids.has(a.enrollment_id)).length;
    notes.push(`${live} live lead(s), ${queued} planned action(s)`);
    if (live === 0) causes.push({ code: 'E_NO_LEADS', blocking: true, detail: 'No leads are in this sequence', remedy: 'Enrol leads, or add an auto-enrol rule.' });
    if (waiting > 0) causes.push({ code: 'W_WAITING_AI_REVIEW', blocking: waiting === live, detail: `${waiting} lead(s) wait for their AI-written line to be approved`, remedy: 'Open AI review.' });
    let ok = 0;
    for (const sid of (q.sender_pool ?? []) as string[]) {
      const sc = senderCauses(store, sid, need ?? defaultNeed(store.get('outreach_senders', sid)?.provider ?? 'LINKEDIN'));
      if (!sc.some((x) => x.blocking)) ok++;
      causes = causes.concat(sc);
    }
    if (ok > 0) causes = causes.map((x) => (x.sender_id && x.blocking ? { ...x, blocking: false, partial: true } : x));
    if (q.throttled_reason) causes.push({ code: 'W_THROTTLED', blocking: false, detail: q.throttled_reason, remedy: 'The pool cannot keep up with demand: add senders or accept the longer projection.' });
  } else {
    const s = store.get('outreach_senders', args.p_sender);
    if (!s || s.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Sender not found');
    target = `Sender "${s.display_name ?? ''}"`;
    causes = causes.concat(senderCauses(store, s.id, s.provider === 'LINKEDIN' ? ['invite', 'message', 'profile_view', 'inmail', 'email', 'new_chat'] : defaultNeed(s.provider)));
    const live = store.t('outreach_enrollments').filter((x) => x.sender_id === s.id && STATUS_LIVE.includes(x.status)).length;
    const queued = store.t('outreach_actions').filter((a) => a.sender_id === s.id && a.status === 'queued').length;
    notes.push(`${live} live lead(s), ${queued} planned action(s)`);
    if (live === 0) causes.push({ code: 'W_NO_DEMAND', blocking: false, detail: 'No leads are assigned to this sender', remedy: 'Add it to a sequence and enrol leads.' });
  }
  const blocking = causes.filter((x) => x.blocking);
  const first = blocking[0]?.detail ?? causes[0]?.detail;
  return {
    target, blocked: blocking.length > 0,
    reason: blocking.length ? first : causes.length ? `Nothing is blocking. ${first}` : 'Nothing is blocking.',
    causes, notes, rule: 'Never respond to a cap, schedule or health block by raising volume elsewhere.',
  };
}

// ---------------------------------------------------------------------------
// sender_insights
// ---------------------------------------------------------------------------
function totals(store: DemoStore, s: Row, fromMs: number, toMs: number): Row {
  const inRange = (v: string | null | undefined) => !!v && Date.parse(v) >= fromMs && Date.parse(v) < toMs;
  let invites = 0, messages = 0, inmails = 0, emails = 0, newChats = 0, limitHits = 0;
  for (const a of store.t('outreach_actions')) {
    if (a.sender_id !== s.id) continue;
    if (a.status === 'failed' && /limit|cap/i.test(String(a.error_code ?? '')) && inRange(a.executed_at)) limitHits++;
    if (a.status !== 'sent' || !inRange(a.executed_at)) continue;
    if (a.action_type === 'invite') invites++;
    else if (a.action_type === 'message') messages++;
    else if (a.action_type === 'inmail') inmails++;
    else if (a.action_type === 'email') emails++;
    else if (a.action_type === 'new_chat') newChats++;
  }
  const accepted = store.t('outreach_lead_sender_state').filter((x) => x.sender_id === s.id && inRange(x.invite_accepted_at)).length;
  const chats = new Set(store.t('outreach_chats').filter((c) => c.sender_id === s.id).map((c) => c.id));
  const replies = store.t('outreach_messages').filter((m) => m.direction === 'in' && chats.has(m.chat_id) && m.replied_to_action_id && inRange(m.sent_at ?? m.created_at)).length;
  const touches = messages + inmails + emails + newChats;
  const rate = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
  return { invites, accepted, acceptance_rate: rate(accepted, invites), replies, reply_rate: rate(replies, touches || invites), limit_hits: limitHits, new_chats: newChats, blocks: 0 };
}

export function senderInsights(ctx: Ctx, senderId: string): Row {
  const store = ctx.store;
  const s = store.get('outreach_senders', senderId);
  if (!s || s.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Sender not found');
  const now = Date.now();
  const tz = s.timezone ?? 'UTC';
  const cp = ceilingProvider(s.provider);
  const hb: Row = { ...(s.health_breakdown ?? {}) };
  delete hb.computed_at; delete hb.trigger;
  const cur = totals(store, s, now - 30 * D, now + D);
  const prev = totals(store, s, now - 60 * D, now - 30 * D);
  const last14 = totals(store, s, now - 14 * D, now + D);

  // invites per sender-local day, the last 30 days, against the cap
  const capInvite = capFor(store, s, 'invite');
  const byDay = new Map<string, number>();
  for (const a of store.t('outreach_actions')) {
    if (a.sender_id !== s.id || a.action_type !== 'invite' || a.status !== 'sent' || !a.executed_at) continue;
    const t = Date.parse(a.executed_at);
    if (t < now - 31 * D) continue;
    const d = localParts(t, tz).day;
    byDay.set(d, (byDay.get(d) ?? 0) + 1);
  }
  const chart: Row[] = [];
  for (let i = 29; i >= 0; i--) { const d = localParts(now - i * D, tz).day; chart.push({ day: d, sent: byDay.get(d) ?? 0, cap: s.provider === 'LINKEDIN' ? capInvite : 0 }); }
  const capSum = s.provider === 'LINKEDIN' ? chart.reduce((x, r) => x + r.cap, 0) : 0;
  const usedSum = chart.reduce((x, r) => x + r.sent, 0);
  const headroom = capSum > 0 ? Math.round((1000 * (capSum - usedSum)) / capSum) / 10 : null;

  const recs: Row[] = [];
  const ar = last14.invites >= 20 ? Math.round((100 * last14.accepted) / last14.invites) : null;
  const hv = (k: string) => (typeof hb[k] === 'number' ? hb[k] : 100);
  if (s.status === 'credentials' || s.status === 'error') recs.push({ severity: 'high', area: 'session', text: 'This sender is disconnected. Reconnect it before anything else: nothing is being sent.' });
  if (Math.min(hv('acceptance_rate'), hv('acceptance')) < 85 && ar != null) recs.push({ severity: ar < 15 ? 'high' : 'medium', area: 'acceptance_rate', text: `Acceptance rate is ${ar}%. Below 20% LinkedIn notices. Tighten targeting or rewrite the invitation note before raising volume.` });
  if (Math.min(hv('rejection_rate'), hv('rejects')) < 80) recs.push({ severity: 'high', area: 'rejection_rate', text: 'The provider rejected some of the last actions. Keep volume flat for a week; the caps already dropped to protect the account.' });
  if (hv('session_stability') < 75) recs.push({ severity: 'medium', area: 'session_stability', text: 'The session dropped more than once in 14 days. Turn on automatic reconnect (extension) and avoid logging in from new devices or countries.' });
  if (hv('reply_rate') < 80) recs.push({ severity: 'medium', area: 'reply_rate', text: "Few people answer this sender's messages. Test a shorter first message (A/B) before adding follow-ups." });
  if (Math.min(hv('consistency'), hv('activity')) < 75) recs.push({ severity: 'low', area: 'consistency', text: 'Activity is uneven from day to day. Keep leads flowing steadily: a burst after idle days looks automated.' });
  if (cur.limit_hits > 0) recs.push({ severity: 'medium', area: 'limits', text: `The provider's own limit was hit ${cur.limit_hits} time(s) in 30 days. The platform pauses that action until the limit resets; lower the manual cap to stay under it.` });
  if (headroom != null && headroom > 60 && !s.running_dry_at && s.status === 'ok') recs.push({ severity: 'low', area: 'headroom', text: `${Math.round(headroom)}% of the invitation allowance went unused. There is room for more leads on this sender.` });
  if (s.running_dry_at) recs.push({ severity: 'medium', area: 'leads', text: 'This sender has less than two days of new leads queued. Enrol more leads or add an auto-enrol rule.' });
  if (!recs.length) recs.push({ severity: 'ok', area: 'all', text: 'Nothing to fix. Keep volume steady and the next warm-up level unlocks on its own.' });

  const level = Number(s.warmup_level ?? 0);
  const health = Number(s.health_score ?? 0);
  const maxLevel = s.provider === 'WHATSAPP' ? 4 : s.is_premium || s.provider !== 'LINKEDIN' ? 5 : 1;
  const today = new Date(now).toISOString().slice(0, 10);
  const highSince: string | null = s.health_high_since ?? (health >= 85 ? new Date(now - 20 * D).toISOString().slice(0, 10) : null);
  let nextOn: string | null = null;
  if (s.provider !== 'WHATSAPP' && level < maxLevel && health >= 85) {
    const a = Date.parse(`${highSince ?? today}T00:00:00Z`) + 14 * D;
    const b = s.warmup_locked_until ? Date.parse(s.warmup_locked_until) + D : now;
    nextOn = new Date(Math.max(a, b, now)).toISOString().slice(0, 10);
  }
  const unlocks = s.provider === 'WHATSAPP' ? 'WhatsApp levels are set by the reply-rate governor each night: more replies on the chats you start move the number up; blocks and silence move it down.'
    : level >= maxLevel ? (maxLevel === 1 ? 'Free LinkedIn accounts stay at level 1. A Premium or Sales Navigator seat unlocks higher levels.' : 'Top level reached.')
      : health < 85 ? `Health must reach 85 (now ${health}) and stay there for 14 days.` : `Health has been 85+ since ${highSince ?? today}. Level ${level + 1} unlocks on ${nextOn}.`;
  const capsAt = (lv: number) => Object.fromEntries(store.t('outreach_warmup_caps').filter((w) => w.provider === cp && w.level === lv).map((w) => [w.action_type, w.per_day]));
  // InMails may grow ~50% over last week's daily average, never below 3
  const inmail7 = store.t('outreach_actions').filter((a) => a.sender_id === s.id && a.action_type === 'inmail' && a.status === 'sent' && a.executed_at && Date.parse(a.executed_at) > now - 7 * D).length;
  const guard = s.provider === 'LINKEDIN' ? Math.max(3, Math.floor((inmail7 / 7) * 1.5)) : null;

  return {
    sender: { id: s.id, name: s.display_name, status: s.status, health: s.health_score, level, provider: s.provider },
    health_breakdown: hb, recommendations: recs,
    warmup: {
      level, max_level: maxLevel, locked_until: s.warmup_locked_until ?? null, health_high_since: highSince, next_level_on: nextOn, unlocks,
      caps_now: capsAt(level), caps_next: capsAt(Math.min(level + 1, maxLevel)),
      total_now: channelTotal(store, s.provider, level), total_next: channelTotal(store, s.provider, Math.min(level + 1, maxLevel)),
    },
    last_30_days: {
      headroom_pct: headroom, limit_hits: cur.limit_hits, acceptance_rate: cur.acceptance_rate, acceptance_rate_previous: prev.acceptance_rate,
      network_growth: cur.accepted, network_growth_source: 'accepted_invitations',
      invites: cur.invites, accepted: cur.accepted, replies: cur.replies, reply_rate: cur.reply_rate, new_chats: cur.new_chats, blocks: cur.blocks,
    },
    invites_vs_cap: chart,
    inmail_guard: { max_today: guard, rule: "InMails may grow at most ~50% above last week's daily average (never below 3 a day). LinkedIn has blocked senders who jumped from about 3 to 16 a day." },
  };
}

/** channel_capacity rows (LinkedIn, Instagram, WhatsApp senders of the workspace). */
export function channelCapacity(ctx: Ctx, client: string | null): Row[] {
  const store = ctx.store;
  const now = Date.now();
  const rows = inWs(ctx, 'outreach_senders', (s) => !s.deleted_at && ['LINKEDIN', 'INSTAGRAM', 'WHATSAPP'].includes(s.provider) && (!client || s.client_id === client))
    .sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')));
  return rows.map((s) => {
    const today: Row = {};
    for (const b of todayBudgets(store, s)) today[b.action_type] = Math.max(b.cap - b.used - b.reserved, 0);
    const sc = scopesToday(store, s);
    return {
      sender_id: s.id, name: s.display_name, provider: s.provider, status: s.status, level: s.warmup_level,
      quiet_until: s.outreach_allowed_from && Date.parse(s.outreach_allowed_from) > now ? s.outreach_allowed_from : null,
      today, hour: sc.hour ? { cap: sc.hour.cap, remaining: sc.hour.remaining } : null,
    };
  });
}

