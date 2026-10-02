/**
 * The dashboard (outreach_dashboard, 013 + the in-place patches of 027 / 044 / 063): today's and the last 7 days'
 * totals from the shared facts, every sender with today's budgets (the derived budgets table, so the Senders page
 * shows the same "used / cap"), the attention list, and the counters the sidebar badges read.
 */
import type { DemoStore, Row } from '../store';
import { rebuildBudgets } from '../sim/derived';
import { localParts } from '../sim/caps';
import { addDays, RUNNING_ENROLLMENT, sentCount, todayIn, totalsOf, wsTz } from './facts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');
/** to_char(ts, 'Mon DD HH24:MI') / 'Mon DD' (UTC, like the database session). */
function monDd(iso: string, withTime: boolean): string {
  const d = new Date(iso);
  return `${MONTHS[d.getUTCMonth()]} ${pad(d.getUTCDate())}${withTime ? ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : ''}`;
}

/** outreach_sender_today: today's budget row per action type, in the sender's own timezone. */
export function senderToday(store: DemoStore, sender: Row): Record<string, { used: number; reserved: number; cap: number }> {
  rebuildBudgets(store);
  const today = localParts(Date.now(), sender.timezone ?? 'UTC').day;
  const out: Record<string, { used: number; reserved: number; cap: number }> = {};
  for (const b of store.t('outreach_sender_budgets')) if (b.sender_id === sender.id && b.day === today) out[b.action_type] = { used: b.used ?? 0, reserved: b.reserved ?? 0, cap: b.cap ?? 0 };
  return out;
}

export function dashboard(store: DemoStore, ws: string): Row {
  const tz = wsTz(store, ws);
  const today = todayIn(tz);
  const wk = totalsOf(store, ws, { from: addDays(today, -6), to: today });
  const td = totalsOf(store, ws, { from: today, to: today });
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const inWs = (r: Row) => !r.workspace_id || r.workspace_id === ws;
  const senders = store.t('outreach_senders').filter((s) => inWs(s) && !s.deleted_at);
  const sequences = store.t('outreach_sequences').filter(inWs);
  const seqById = new Map(sequences.map((q) => [q.id, q]));

  const attention: Row[] = [];
  for (const s of senders) if (s.status === 'credentials' || s.status === 'error') attention.push({ kind: 'sender', id: s.id, label: s.display_name, reason: s.status });
  for (const s of senders) {
    if (s.status === 'connecting' && !s.unipile_account_id && (s.status_reason || (s.created_at && Date.parse(s.created_at) < now - 60 * 60_000))) {
      attention.push({ kind: 'sender', id: s.id, label: s.display_name, reason: 'The sign-in was not completed. Open the sender and send a fresh sign-in link.' });
    }
  }
  for (const s of senders) if (s.paused_until && s.paused_until > nowIso) attention.push({ kind: 'sender', id: s.id, label: s.display_name, reason: `paused until ${monDd(s.paused_until, true)}` });
  for (const s of senders) if (s.invite_blocked_until && s.invite_blocked_until > nowIso) attention.push({ kind: 'sender', id: s.id, label: s.display_name, reason: `invites blocked until ${monDd(s.invite_blocked_until, false)}` });
  const openAlerts = store.t('outreach_alerts').filter((a) => inWs(a) && !a.resolved_at && ['sequence_stalled', 'sender_running_dry', 'import_failed'].includes(a.kind));
  for (const a of openAlerts) {
    attention.push({ kind: a.entity === 'sequence' ? 'sequence_stalled' : a.entity === 'sender' ? 'sender_running_dry' : 'import_failed', id: a.entity_id, label: a.label ?? null, reason: a.reason });
  }
  // the health worker opens these alerts from the same columns; a demo change that set the column shows at once
  const alerted = new Set(openAlerts.map((a) => `${a.kind}|${a.entity_id}`));
  for (const q of sequences) if (q.stalled_at && q.status === 'active' && !alerted.has(`sequence_stalled|${q.id}`)) attention.push({ kind: 'sequence_stalled', id: q.id, label: q.name, reason: q.stalled_reason ?? 'No step has sent anything for a day.' });
  for (const s of senders) if (s.running_dry_at && !alerted.has(`sender_running_dry|${s.id}`)) attention.push({ kind: 'sender_running_dry', id: s.id, label: s.display_name, reason: 'Less than two days of new leads are queued for this sender.' });
  for (const q of sequences) if (q.status === 'active' && q.throttled_reason && !q.stalled_at) attention.push({ kind: 'sequence', id: q.id, label: q.name, reason: q.throttled_reason });
  const held = new Map<string, number>();
  const failed = new Map<string, number>();
  for (const e of store.t('outreach_enrollments')) {
    if (!inWs(e)) continue;
    const q = seqById.get(e.sequence_id);
    if (!q) continue;
    if (e.held_at && e.status === 'paused') held.set(q.id, (held.get(q.id) ?? 0) + 1);
    if (e.status === 'failed' && e.completed_at && Date.parse(e.completed_at) > now - 30 * 86_400_000 && q.status !== 'archived') failed.set(q.id, (failed.get(q.id) ?? 0) + 1);
  }
  for (const [id, n] of held) attention.push({ kind: 'held_leads', id, label: seqById.get(id)?.name ?? null, reason: `${n} lead(s) replied and are held for review` });
  for (const [id, n] of failed) attention.push({ kind: 'failed_leads', id, label: seqById.get(id)?.name ?? null, reason: `${n} failed lead(s) need a decision (retry, skip or exit)` });
  const vars = new Map(store.t('outreach_ai_variables').map((v) => [v.id, v]));
  for (const b of store.t('outreach_ai_batches')) {
    const v = vars.get(b.variable_id);
    if (inWs(b) && b.status === 'review' && v) attention.push({ kind: 'ai_review', id: b.id, label: v.name, reason: 'Personalized lines are waiting for you' });
  }

  const chats = store.t('outreach_chats').filter(inWs);
  const tasks = store.t('outreach_tasks').filter((t) => inWs(t) && !t.completed_at);
  const queuedBefore = new Date(now + 86_400_000).toISOString();
  const sendersOut = [...senders].sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? ''))).map((s) => ({
    id: s.id, display_name: s.display_name ?? null, picture_url: s.picture_url ?? null, provider: s.provider, status: s.status, status_reason: s.status_reason ?? null,
    has_account: !!s.unipile_account_id, created_at: s.created_at, health_score: s.health_score ?? 0, warmup_level: s.warmup_level ?? 1, client_id: s.client_id ?? null,
    paused_until: s.paused_until ?? null, running_dry: !!s.running_dry_at, today: senderToday(store, s),
  }));
  return {
    senders: sendersOut,
    attention,
    replies_awaiting: chats.filter((c) => c.unread && ['interested', 'question'].includes(c.intent) && !c.archived).length,
    unread: chats.filter((c) => c.unread && !c.archived).length,
    tasks_open: tasks.filter((t) => t.kind !== 'review_ai_draft' && t.kind !== 'ai_escalation').length,
    drafts_awaiting: tasks.filter((t) => t.kind === 'review_ai_draft').length,
    ai_lines_awaiting: store.t('outreach_ai_values').filter((v) => inWs(v) && v.status === 'generated').length,
    enrollments_live: store.t('outreach_enrollments').filter((e) => inWs(e) && RUNNING_ENROLLMENT.includes(e.status) && seqById.has(e.sequence_id)).length,
    sent_today: sentCount(td),
    queued_today: store.t('outreach_actions').filter((a) => inWs(a) && a.status === 'queued' && a.scheduled_for && a.scheduled_for < queuedBefore).length,
    leads_total: store.t('outreach_leads').filter(inWs).length,
    today: td, last_7_days: wk,
    // kept for older clients of this RPC: same numbers, legacy key names
    stats_7d: { invites: wk.invites, messages: wk.messages + wk.inmails + wk.emails, accepted: wk.accepted, replies: wk.replies, interested: wk.interested, reply_rate: wk.reply_rate, acceptance_rate: wk.acceptance_rate },
  };
}
