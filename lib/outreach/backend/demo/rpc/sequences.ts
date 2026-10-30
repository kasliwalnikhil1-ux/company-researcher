/**
 * Demo handlers: Sequences, versions, publishing, enrolment, enrollments, queued actions, A/B results, auto-enrol rules, tasks.
 * Owns: ab_results, complete_task, create_sequence, delete_auto_enroll_rule, delete_sequence, discard_draft, enroll_leads, enroll_preview, enrollment_recover, exit_enrollment, failed_leads, move_to_latest, node_queued_actions, pause_enrollment, project_sequence, promote_variant, publish_impact, publish_sequence, rebalance_preview, render_context, reschedule_action, resume_enrollment, rule_match_count, save_auto_enroll_rule, save_draft, save_sequence, save_voice_clip, sender_today, sequence_summary, set_action_text, set_pool, set_sequence_status, skip_action, upsert_lead, version_usage
 *
 * Shapes follow the last migration that defines each outreach_<name> function (012, 011, 013, 026 …). Everything is
 * computed from the demo tables, so the list, the builder, the dashboard and the reports read the same numbers.
 */
import { NODE_CATALOG } from '../../../nodes';
import type { Graph } from '../../../types';
import { demoError, type Ctx, type RpcArea } from '../ctx';
import { upsertLead } from '../leads/upsert';
import { tableHooks } from '../query';
import { localParts } from '../sim/caps';
import { rebuildBudgets, rebuildNodeStats } from '../sim/derived';
import { engineFor, LIVE } from '../sim/engine';
import { renderContextJson } from '../sim/render';
import type { Row } from '../store';
import {
  D, LIVE_SET, MAIL, RUNNABLE, advance, assertValid, changeCount, clone, enrollPlan, enrollmentGraph, finish, graphDiff, iso, liveEnrollments,
  pickWeighted, poolsByProvider, project, reasonText, sameJson, sendNow, sentCount, seqOr404, stepNow, validate,
} from '../sequences/core';
import { EDITS_KEY, installSendOverrides } from '../sequences/overrides';
import { ruleCandidates, runRule } from '../sequences/rules';

type Args = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any

const START_GRAPH: Graph = {
  version: 1, start: 'start',
  nodes: { start: { id: 'start', type: 'start', position: { x: 80, y: 200 }, next: 'end' }, end: { id: 'end', type: 'end', position: { x: 520, y: 200 }, config: {} } },
};
const DEFAULT_SETTINGS = { stop_on_reply: true, withdraw_after_days: 21 };

const asArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

// ---------------------------------------------------------------------------
// save / publish core (outreach_save_sequence)
// ---------------------------------------------------------------------------
interface SaveArgs { graph: Graph; pool?: string[] | null; settings?: Row | null; name?: string | null; assignment?: string | null; useSenderSchedule?: boolean | null; clientId?: string | null; brief?: string | null }

function saveSequence(ctx: Ctx, s: Row, a: SaveArgs): number {
  const store = ctx.store;
  const pool = a.pool ?? s.sender_pool ?? [];
  assertValid(store, a.graph, pool, s.status === 'active', a.settings ?? s.settings);
  if (a.pool && a.pool.some((pid) => store.get('outreach_senders', pid)?.workspace_id !== s.workspace_id)) demoError('E_SENDER_NOT_IN_POOL', 'sender outside workspace');
  const newv = sameJson(s.graph, a.graph) ? s.head_version : (s.head_version ?? 0) + 1;
  const graph = clone(a.graph);
  store.update('outreach_sequences', s.id, {
    graph, head_version: newv,
    sender_pool: a.pool ?? s.sender_pool, sender_pools: poolsByProvider(store, a.pool ?? s.sender_pool ?? []),
    settings: a.settings ?? s.settings, name: str(a.name) ?? s.name, assignment: str(a.assignment) ?? s.assignment,
    use_sender_schedule: a.useSenderSchedule ?? s.use_sender_schedule, client_id: a.clientId ?? s.client_id, brief: a.brief ?? s.brief,
    draft_graph: null, draft_updated_at: null, draft_updated_by: null, draft_base_version: null,
  });
  const existing = store.t('outreach_sequence_versions').find((v) => v.sequence_id === s.id && v.version === newv);
  if (existing) existing.graph = clone(graph);
  else store.insert('outreach_sequence_versions', { sequence_id: s.id, version: newv, graph: clone(graph), created_by: ctx.userId, created_at: ctx.now(), note: null, publish_mode: null }, { noId: true });
  return newv;
}

/** "Update them too": queued copy re-renders from the published step (edited and approved copies are kept). */
function refreshQueuedText(ctx: Ctx, seqId: string, nodeId: string): number {
  let n = 0;
  const edits = ctx.store.meta<Record<string, Row>>(EDITS_KEY, () => ({}));
  for (const a of ctx.store.t('outreach_actions')) {
    if (a.status !== 'queued' || a.node_id !== nodeId || !a.enrollment_id) continue;
    const e = ctx.store.get('outreach_enrollments', a.enrollment_id);
    if (!e || e.sequence_id !== seqId || e.pinned_version != null) continue;
    if (a.payload?.approved_task_id || a.payload?.edited_by || edits[a.id]) continue;
    const { text: _t, note: _n, subject: _s, html: _h, variant_id: _v, ...rest } = a.payload ?? {};
    void _t; void _n; void _s; void _h; void _v;
    ctx.store.update('outreach_actions', a.id, { payload: rest, variant_id: null });
    n++;
  }
  return n;
}

function rescheduleDelay(ctx: Ctx, s: Row, nodeId: string): number {
  const n = s.graph?.nodes?.[nodeId];
  if (!n || n.type !== 'delay') return 0;
  const amt = Number(n.config?.amount ?? 1);
  const unit = n.config?.unit ?? 'days';
  const ms = amt * (unit === 'minutes' ? 60_000 : unit === 'hours' ? 3_600_000 : D);
  let c = 0;
  for (const e of ctx.store.t('outreach_enrollments')) {
    if (e.sequence_id !== s.id || e.pinned_version != null || e.status !== 'waiting_delay' || e.current_node_id !== nodeId) continue;
    ctx.store.update('outreach_enrollments', e.id, { wait_until: iso(Date.parse(e.node_entered_at ?? ctx.now()) + ms) });
    c++;
  }
  return c;
}

// ---------------------------------------------------------------------------
// enrollments
// ---------------------------------------------------------------------------
function enrollmentOr404(ctx: Ctx, id: unknown): Row {
  const e = ctx.store.get('outreach_enrollments', typeof id === 'string' ? id : null);
  if (!e || e.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Enrollment not found');
  return e;
}

function closeHoldTasks(ctx: Ctx, enrollmentId: string, decision: 'exit' | 'resume') {
  ctx.store.update('outreach_tasks', (t) => t.enrollment_id === enrollmentId && t.kind === 'reply_hold' && !t.completed_at, { completed_at: ctx.now(), completed_by: ctx.userId, result: { decision } });
}

// ---------------------------------------------------------------------------
// Sequence lead filters, bulk unenroll & Analytics (migration 101). Same vocabulary as outreach__lead_filter_statuses.
// ---------------------------------------------------------------------------
const LEAD_FILTER_STATUSES: Record<string, string[] | null> = {
  live: ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused'], all: null,
  active: ['active', 'waiting_delay'], invite_sent: ['waiting_connection'], waiting_task: ['waiting_task'], paused: ['paused'],
  completed: ['completed'], handoff: ['exited_replied'], stopped_by_teammate: ['exited_manual'], sender_disabled: ['exited_sender_disabled'],
  failed: ['failed'], unenrolled: ['cancelled'], stopped: ['exited_manual', 'exited_sender_disabled', 'exited_suppressed'], do_not_contact: ['exited_suppressed'],
};
const ENDED = new Set(['completed', 'exited_replied', 'exited_manual', 'exited_suppressed', 'exited_sender_disabled', 'failed', 'cancelled']);
const PASSIVE_NODES = new Set(['start', 'end', 'delay', 'wait_connection', 'wait_for_reply', 'wait_follow_back', 'condition', 'ab_split', 'ai_route', 'switch_channel', 'note', 'goto', 'end_step']);
const day = (iso: string | null | undefined) => (iso ? String(iso).slice(0, 10) : '');
const inWindow = (iso: string | null | undefined, from: string | null, to: string | null) => !!iso && (!from || day(iso) >= from) && (!to || day(iso) <= to);
const pctOf = (n: number, d: number) => (d > 0 ? Math.round((n * 1000) / d) / 10 : null);
function tbl(ctx: Ctx, name: string): Row[] { try { return ctx.store.t(name); } catch { return []; } }

/** 1-based step numbers of the sending / task steps, walking the graph from the start (outreach_graph_step_numbers). */
function stepNumbers(graph: Row | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (!graph?.nodes) return out;
  const seen = new Set<string>(); const queue: string[] = [graph.start]; let i = 0;
  while (queue.length && seen.size < 1000) {
    const cur = queue.shift()!; if (!cur || seen.has(cur)) continue; seen.add(cur);
    const n = graph.nodes[cur]; if (!n) continue;
    if (!PASSIVE_NODES.has(n.type)) out[cur] = ++i;
    if (n.next) queue.push(n.next);
    for (const b of Object.values(n.branches ?? {})) if (typeof b === 'string') queue.push(b);
  }
  return out;
}
const nodeLabel = (graph: Row | null | undefined, id: string | null | undefined) => {
  const n = id ? graph?.nodes?.[id] : null;
  return n ? (n.label ?? String(n.type ?? '').replace(/_/g, ' ').replace(/^\w/, (c: string) => c.toUpperCase())) : null;
};
function memberName(ctx: Ctx, userId: string | null | undefined): string | null {
  if (!userId) return null;
  const m = tbl(ctx, 'outreach_members').find((x) => x.user_id === userId);
  return m ? (m.display_name ?? m.email ?? 'Teammate') : 'Former teammate';
}
function leadRowsFor(ctx: Ctx, s: Row, a: Args): Row[] {
  const filter = str(a.p_filter) ?? 'live';
  if (!(filter in LEAD_FILTER_STATUSES)) demoError('E_PAYLOAD_INVALID', `unknown filter ${filter}`);
  const sts = LEAD_FILTER_STATUSES[filter]; const teammate = str(a.p_teammate); const from = str(a.p_from); const to = str(a.p_to); const q = (str(a.p_search) ?? '').toLowerCase();
  if ((from && !to) || (!from && to)) demoError('E_PAYLOAD_INVALID', 'from/to must be dates with from <= to, or both empty');
  return ctx.store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id && (!sts || sts.includes(e.status)) && (!teammate || e.status_changed_by === teammate) && (!from || inWindow(e.created_at, from, to))
    && (!q || (() => { const l = ctx.store.get('outreach_leads', e.lead_id); return !!l && [l.full_name, l.company, l.public_identifier, l.email_work].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)); })()))
    .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)) || String(x.id).localeCompare(String(y.id)));
}
function chatMessages(ctx: Ctx, leadId: string, senderId: string, direction: 'in' | 'out', since: string): Row[] {
  const chats = new Set(tbl(ctx, 'outreach_chats').filter((c) => c.lead_id === leadId && c.sender_id === senderId).map((c) => c.id));
  return tbl(ctx, 'outreach_messages').filter((m) => chats.has(m.chat_id) && m.direction === direction && !m.deleted_at && String(m.sent_at) >= since).sort((x, y) => String(y.sent_at).localeCompare(String(x.sent_at)));
}
const snippet = (m: Row | undefined, chat: Row | undefined) => (m ? { text: String(m.text ?? m.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 140) || null, at: m.sent_at, chat_id: m.chat_id, intent: chat?.intent ?? null } : null);
function leadRow(ctx: Ctx, s: Row, e: Row, nums: Record<string, number>, stepTotal: number): Row {
  const lead = ctx.store.get('outreach_leads', e.lead_id); const sender = ctx.store.get('outreach_senders', e.sender_id);
  const live = !ENDED.has(e.status);
  const queued = ctx.store.t('outreach_actions').filter((x) => x.enrollment_id === e.id && (x.status === 'queued' || x.status === 'reserved') && !x.payload?.prefetch && !x.payload?.subtask).sort((x, y) => String(x.scheduled_for).localeCompare(String(y.scheduled_for)))[0];
  const graph = s.graph as Row;
  let next: Row | null = null;
  if (live) {
    if (queued) next = { kind: 'action', type: queued.action_type, node_id: queued.node_id, label: nodeLabel(graph, queued.node_id) ?? String(queued.action_type), at: queued.scheduled_for, status: queued.status };
    else if (e.status === 'waiting_connection') next = { kind: 'wait', type: 'wait_connection', label: 'Waiting for the invitation to be accepted', at: e.wait_until };
    else if (e.status === 'waiting_delay') next = { kind: 'wait', type: 'delay', label: 'Next step', at: e.wait_until, node_id: e.current_node_id };
    else if (e.status === 'waiting_task') next = { kind: 'task', type: e.wait_reason ?? 'task', label: e.wait_reason === 'enrichment' ? 'Waiting for enrichment' : e.wait_reason === 'ai_review' ? 'Waiting for AI review' : e.wait_reason === 'ai_route' ? 'Waiting for the AI route' : 'Waiting on a task', at: null };
    else if (e.status === 'paused') next = { kind: 'paused', label: e.held_at ? 'Held for review' : 'Paused', at: null };
  }
  const out = chatMessages(ctx, e.lead_id, e.sender_id, 'out', e.created_at)[0]; const inn = chatMessages(ctx, e.lead_id, e.sender_id, 'in', e.created_at)[0];
  const chat = inn ? ctx.store.get('outreach_chats', inn.chat_id) : undefined;
  return {
    id: e.id, lead_id: e.lead_id, sender_id: e.sender_id, status: e.status, exit_reason: e.exit_reason ?? null, current_node_id: e.current_node_id ?? null, node_entered_at: e.node_entered_at ?? e.created_at,
    wait_until: e.wait_until ?? null, created_at: e.created_at, completed_at: e.completed_at ?? null, held_at: e.held_at ?? null, hold_reason: e.hold_reason ?? null, wait_reason: e.wait_reason ?? null, paused_from: e.paused_from ?? null,
    lead: lead ? { id: lead.id, full_name: lead.full_name ?? null, company: lead.company ?? null, headline: lead.headline ?? null, public_identifier: lead.public_identifier ?? null, picture_url: lead.picture_url ?? null } : null,
    sender: { id: sender?.id ?? null, display_name: sender?.display_name ?? null, status: sender?.status ?? null },
    step_index: (e.current_node_id ? nums[e.current_node_id] : undefined) ?? (() => { const sent = ctx.store.t('outreach_actions').filter((x) => x.enrollment_id === e.id && x.status === 'sent' && x.node_id && nums[x.node_id]).map((x) => nums[x.node_id]); return sent.length ? Math.max(...sent) : null; })(), step_total: stepTotal, step_label: nodeLabel(graph, e.current_node_id), step_type: e.current_node_id ? graph?.nodes?.[e.current_node_id]?.type ?? null : null,
    next, last_message: snippet(out, undefined), last_reply: snippet(inn, chat),
    changed_by: e.status_changed_by ? { id: e.status_changed_by, name: memberName(ctx, e.status_changed_by) } : null, changed_at: e.status_changed_at ?? null,
  };
}
function bulkCan(action: string, e: Row): boolean {
  if (action === 'unenroll') return !ENDED.has(e.status);
  if (action === 'pause') return ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(e.status);
  return e.status === 'paused' && !e.held_at;
}
function bulkTargets(ctx: Ctx, s: Row, a: Args): Row[] {
  const ids = Array.isArray(a.p_ids) ? asArr(a.p_ids) : null;
  if (ids) return ids.map((id) => ctx.store.get('outreach_enrollments', id)).filter((e): e is Row => !!e && e.sequence_id === s.id);
  if (!str(a.p_filter)) demoError('E_PAYLOAD_INVALID', 'pass ids or a filter');
  return leadRowsFor(ctx, s, a);
}
const UNDO_KEY = 'sequence_bulk_undo';
function markChanged(ctx: Ctx, id: string) { ctx.store.update('outreach_enrollments', id, { status_changed_by: ctx.userId, status_changed_at: ctx.now() }); }

function exitEnrollment(ctx: Ctx, e: Row, reason: string) {
  if (!LIVE_SET.has(e.status)) return;
  finish(ctx.store, e, e.held_at && e.hold_reason === 'replied' ? 'exited_replied' : 'exited_manual', reason);
  ctx.store.update('outreach_enrollments', e.id, { held_at: null });
  closeHoldTasks(ctx, e.id, 'exit');
}

function resumeEnrollment(ctx: Ctx, e: Row) {
  const held = !!e.held_at;
  if (e.status === 'paused') {
    const to = e.paused_from ?? 'active';
    const now = Date.now();
    ctx.store.update('outreach_enrollments', e.id, (r) => ({
      status: to, paused_from: null, held_at: null, hold_reason: null,
      reply_ignored_before: held ? ctx.now() : r.reply_ignored_before ?? null,
      wait_until: to === 'active' || to === 'waiting_delay' ? iso(Math.max(Date.parse(r.wait_until ?? '') || now, now)) : r.wait_until,
    }));
  }
  if (held) {
    ctx.store.update('outreach_lead_sender_state', (r) => r.lead_id === e.lead_id && r.replied, { replied: false });
    closeHoldTasks(ctx, e.id, 'resume');
  }
  stepNow(ctx.store, ctx.store.get('outreach_enrollments', e.id));
}

// ---------------------------------------------------------------------------
// A/B results (outreach_ab_results, 013)
// ---------------------------------------------------------------------------
const rate = (num: number, den: number) => (den > 0 ? Math.round((1000 * num) / den) / 10 : null);
function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

function reachable(graph: Graph, from: Array<string | null | undefined>): Set<string> {
  const seen = new Set<string>();
  const q = from.filter((x): x is string => !!x);
  while (q.length) {
    const id = q.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = graph.nodes[id];
    if (!n) continue;
    for (const t of [n.next, ...Object.values(n.branches ?? {})]) if (t && !seen.has(t)) q.push(t);
  }
  return seen;
}

function abResults(ctx: Ctx, a: Args) {
  const store = ctx.store;
  const s = seqOr404(ctx, a.p_sequence);
  const node = s.graph?.nodes?.[a.p_node_id];
  if (!node) demoError('E_NOT_FOUND', 'node');
  const from = typeof a.p_from === 'string' ? a.p_from : String(s.created_at).slice(0, 10);
  const to = typeof a.p_to === 'string' ? a.p_to : new Date().toISOString().slice(0, 10);
  const lo = Date.parse(`${from}T00:00:00Z`), hi = Date.parse(`${to}T00:00:00Z`) + D;
  const isSplit = node.type === 'ab_split';
  const enr = store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id);
  const enrIds = new Set(enr.map((e) => e.id));
  const firstReplies = new Map<string, Row>();
  for (const m of store.t('outreach_messages')) if (m.direction === 'in' && m.is_first_reply && m.replied_to_action_id) firstReplies.set(m.replied_to_action_id, m);
  const chatIntent = (chatId: string) => store.get('outreach_chats', chatId)?.intent;
  const stateOf = new Map(store.t('outreach_lead_sender_state').map((x) => [`${x.lead_id}|${x.sender_id}`, x]));
  let rows: Row[] = [];
  let metric: 'accepted' | 'interested';
  if (isSplit) {
    const branches: Row[] = Array.isArray(node.config?.branches) ? node.config.branches : [];
    const actionsBy = new Map<string, Set<string>>();
    for (const x of store.t('outreach_actions')) if (x.enrollment_id && enrIds.has(x.enrollment_id)) { if (!actionsBy.has(x.enrollment_id)) actionsBy.set(x.enrollment_id, new Set()); actionsBy.get(x.enrollment_id)!.add(x.node_id); }
    const after = reachable(s.graph, Object.values(node.branches ?? {}));
    const cohort = new Map<string, Row[]>();
    for (const e of enr) {
      const passed = (e.current_node_id && after.has(e.current_node_id)) || [...(actionsBy.get(e.id) ?? [])].some((n) => after.has(n));
      if (!passed) continue;
      const at = Date.parse(e.created_at);
      if (at < lo || at >= hi) continue;
      const b = pickWeighted(branches, `${e.id}:${node.id}`)?.id ?? 'a';
      if (!cohort.has(b)) cohort.set(b, []);
      cohort.get(b)!.push(e);
    }
    const repliedEnr = new Map<string, Row>();
    for (const x of store.t('outreach_actions')) { const m = firstReplies.get(x.id); if (m && x.enrollment_id && !repliedEnr.has(x.enrollment_id)) repliedEnr.set(x.enrollment_id, m); }
    rows = [...cohort.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([b, list]) => {
      const accepted = list.filter((e) => { const st = stateOf.get(`${e.lead_id}|${e.sender_id}`); return st?.invite_accepted_at && st.invite_accepted_at >= e.created_at; }).length;
      const replies = list.filter((e) => repliedEnr.has(e.id)).length;
      const interested = list.filter((e) => { const m = repliedEnr.get(e.id); return m && chatIntent(m.chat_id) === 'interested'; }).length;
      const meetings = list.filter((e) => store.t('outreach_lead_milestones').some((ms) => ms.lead_id === e.lead_id && ms.kind === 'meeting' && ms.at >= e.created_at)
        || ['meeting', 'won'].includes(store.get('outreach_stages', store.get('outreach_leads', e.lead_id)?.stage_id)?.kind)).length;
      const label = branches.find((x) => x.id === b)?.label ?? b;
      return { variant_id: b, label, leads: list.length, sent: list.length, accepted, replies, interested, meetings, acceptance_rate: rate(accepted, list.length), reply_rate: rate(replies, list.length), interested_rate: rate(interested, list.length) };
    });
    metric = 'interested';
  } else {
    const variants: Row[] = Array.isArray(node.config?.variants) ? node.config.variants : [];
    const groups = new Map<string, Row[]>();
    for (const x of store.t('outreach_actions')) {
      if (x.node_id !== node.id || x.status !== 'sent' || !x.enrollment_id || !enrIds.has(x.enrollment_id) || x.payload?.prefetch) continue;
      const t = Date.parse(x.executed_at ?? '');
      if (!(t >= lo && t < hi)) continue;
      const k = x.variant_id ?? '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(x);
    }
    rows = [...groups.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([vid, list]) => {
      const accepted = list.filter((x) => { if (x.action_type !== 'invite') return false; const st = stateOf.get(`${x.lead_id}|${x.sender_id}`); return st?.invite_accepted_at && x.executed_at && st.invite_accepted_at >= x.executed_at; }).length;
      const replies = list.filter((x) => firstReplies.has(x.id)).length;
      const interested = list.filter((x) => { const m = firstReplies.get(x.id); return m && chatIntent(m.chat_id) === 'interested'; }).length;
      const v = variants.find((y) => y.id === vid);
      return { variant_id: vid, label: v?.label ?? (vid || 'No variant'), weight: v?.weight ?? null, sent: list.length, accepted, replies, interested, acceptance_rate: rate(accepted, list.length), reply_rate: rate(replies, list.length), interested_rate: rate(interested, list.length) };
    });
    metric = node.type === 'send_invite' ? 'accepted' : 'interested';
  }
  const score = (r: Row) => (r.sent > 0 ? r[metric] / r.sent : -1);
  const best = [...rows].sort((x, y) => score(y) - score(x) || y.sent - x.sent)[0] ?? null;
  const enough = rows.every((r) => r.sent >= 100);
  const out = rows.map((r) => {
    let conf: number | null = null; let label: string | null = null;
    if (best && r.variant_id !== best.variant_id && r.sent > 0 && best.sent > 0) {
      const n1 = best.sent, n2 = r.sent, p1 = best[metric] / n1, p2 = r[metric] / n2;
      const pp = (best[metric] + r[metric]) / (n1 + n2);
      const se = Math.sqrt(Math.max(pp * (1 - pp) * (1 / n1 + 1 / n2), 0));
      if (se > 0) conf = Math.round(1000 * (2 * normCdf((p1 - p2) / se) - 1)) / 10;
      label = !enough ? 'Not enough data yet' : conf == null ? 'No difference' : conf >= 99 ? 'Very confident' : conf >= 95 ? 'Confident' : conf >= 90 ? 'Likely' : 'No clear difference';
    }
    return { ...r, is_leading: !!best && r.variant_id === best.variant_id, confidence_vs_leader: conf, verdict_vs_leader: label };
  });
  const decided = enough && rows.length >= 2;
  return {
    sequence_id: s.id, node_id: node.id, node_type: node.type, judged_on: metric, period: { from, to }, enough_data: decided, min_sends_per_variant: 100, variants: out,
    leader: decided ? best?.variant_id ?? null : null,
    can_promote: decided && !isSplit && !out.some((x) => !x.is_leading && (x.confidence_vs_leader ?? 0) < 90),
  };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------
export const sequencesRpc = {
  ab_results: (a, ctx) => abResults(ctx, a),

  complete_task: (a, ctx) => {
    const store = ctx.store;
    const t = store.get('outreach_tasks', a.p_id);
    if (!t || t.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Task not found');
    if (t.completed_at) return null;
    const result: Row | null = a.p_result && typeof a.p_result === 'object' ? a.p_result : null;
    const text: string | null = typeof a.p_text === 'string' ? a.p_text : null;
    let outcome = '';
    if (t.kind === 'call') {
      outcome = String(result?.outcome ?? '');
      if (!['connected', 'voicemail', 'no_answer', 'wrong_number'].includes(outcome)) demoError('E_PAYLOAD_INVALID', 'outcome must be connected, voicemail, no_answer or wrong_number');
    }
    store.update('outreach_tasks', t.id, { completed_at: ctx.now(), completed_by: ctx.userId, result: result ?? { text }, ai_draft: text ?? t.ai_draft });
    if (!t.enrollment_id) return null;
    const e = store.get('outreach_enrollments', t.enrollment_id);
    if (!e) return null;
    const eng = engineFor(store);
    if (t.kind === 'reply_hold') {
      if ((result?.decision ?? 'resume') === 'exit') exitEnrollment(ctx, e, 'replied'); else resumeEnrollment(ctx, e);
      return null;
    }
    if (e.status !== 'waiting_task') return null;
    const g = enrollmentGraph(store, e);
    const node = g?.nodes?.[t.node_id] as Row | undefined;
    if (!node) { advance(store, e, t.node_id, null, g); stepNow(store, e); return null; }
    if (t.kind === 'call') { eng.afterTask(e.id, outcome); return null; }
    if (t.kind === 'review_ai_draft') {
      if ((result?.decision ?? 'approve') !== 'reject') {
        const kind = t.draft_kind ?? node.config?.kind;
        const actionType = node.type === 'ai_draft_approval' ? (kind === 'invite_note' ? 'invite' : kind === 'comment' ? 'comment' : 'message') : undefined;
        sendNow(ctx, e, node, { text: text ?? t.ai_draft ?? '', actionType, taskId: t.id });
      }
      eng.afterTask(e.id, null);
      return null;
    }
    if (t.kind === 'manual_node') {
      const meta = NODE_CATALOG[node.type as keyof typeof NODE_CATALOG];
      if (meta?.actionType && ['message', 'inmail', 'email', 'invite', 'comment'].includes(meta.actionType)) {
        const body = text ?? (node.type === 'send_email' ? node.config?.html : node.type === 'send_invite' ? node.config?.note : node.config?.text) ?? '';
        sendNow(ctx, e, node, { text: body, taskId: t.id });
      }
      eng.afterTask(e.id, null);
    }
    return null;
  },

  create_sequence: (a, ctx) => {
    if (a.p_workspace !== ctx.ws) demoError('E_FORBIDDEN', 'Not a member of this workspace');
    const name = str(a.p_name);
    if (!name) demoError('E_PAYLOAD_INVALID', 'name required');
    const row = ctx.store.insert('outreach_sequences', {
      workspace_id: ctx.ws, client_id: str(a.p_client_id), name: name.trim(), status: 'draft', head_version: 1, graph: clone(START_GRAPH),
      sender_pool: [], sender_pools: {}, assignment: 'round_robin', use_sender_schedule: true, settings: { ...DEFAULT_SETTINGS }, throttled_reason: null, brief: null,
      draft_graph: null, draft_updated_at: null, draft_updated_by: null, draft_base_version: null, stalled_at: null, stalled_reason: null, archived_at: null, created_by: ctx.userId,
    })[0];
    ctx.store.insert('outreach_sequence_versions', { sequence_id: row.id, version: 1, graph: clone(START_GRAPH), created_by: ctx.userId, created_at: ctx.now(), note: null, publish_mode: null }, { noId: true });
    return row.id;
  },

  delete_auto_enroll_rule: (a, ctx) => {
    const r = ctx.store.get('outreach_auto_enroll_rules', a.p_id);
    if (!r || r.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Rule not found');
    ctx.store.remove('outreach_auto_enroll_rules', r.id);
    ctx.store.remove('outreach_auto_enroll_log', (l) => l.rule_id === r.id);
    return null;
  },

  discard_draft: (a, ctx) => {
    const s = seqOr404(ctx, a.p_id);
    ctx.store.update('outreach_sequences', s.id, { draft_graph: null, draft_updated_at: null, draft_updated_by: null, draft_base_version: null });
    return null;
  },

  enroll_leads: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const leadIds = asArr(a.p_lead_ids);
    if (leadIds.length > 10000) demoError('E_TOO_MANY', 'max 10000 per request');
    const res = { enrolled: 0, skipped_active: 0, skipped_suppressed: 0, skipped_other: 0, skipped_replied: 0, waiting: 0 };
    if (!leadIds.length) return [res];
    const plan = enrollPlan(ctx, s, leadIds, str(a.p_sender), a.p_include_replied === true);
    const eng = engineFor(store);
    const now = Date.now();
    const before = sentCount(store);
    const created: string[] = [];
    for (const p of plan) {
      if (!p.sender_id) {
        if (p.reason?.startsWith('suppressed:')) res.skipped_suppressed++;
        else if (p.reason === 'replied_recently') res.skipped_replied++;
        else if (p.reason === 'already_enrolled') res.skipped_active++;
        else res.skipped_other++;
        continue;
      }
      // "replied" in conditions means "replied during this enrolment": a deliberate re-enrol starts clean
      const st = eng.state(p.lead_id, p.sender_id);
      if (st.replied) store.update('outreach_lead_sender_state', (r) => r === st, { replied: false });
      const r = eng.enroll(s.id, [p.lead_id], { senderId: p.sender_id, includeReplied: true, ruleId: str(a.p_rule), now });
      if (!r.enrollment_ids.length) { res.skipped_active++; continue; }
      res.enrolled++;
      const id = r.enrollment_ids[0];
      store.update('outreach_enrollments', id, { priority: Number.isFinite(Number(a.p_priority)) ? Number(a.p_priority) : 100, created_by: ctx.userId, paused_from: null, sequence_version: s.head_version });
      created.push(id);
    }
    for (const id of created) stepNow(store, store.get('outreach_enrollments', id), now);
    if (sentCount(store) > before) ctx.ui.simulated();
    return [res];
  },

  enroll_preview: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const leadIds = asArr(a.p_lead_ids);
    if (!leadIds.length) demoError('E_PAYLOAD_INVALID', 'lead_ids required');
    if (leadIds.length > 10000) demoError('E_TOO_MANY', 'max 10000 per request');
    const includeReplied = a.p_include_replied === true;
    const warnings: string[] = [];
    for (const id of s.sender_pool ?? []) {
      const sd = store.get('outreach_senders', id);
      if (sd && !sd.deleted_at && sd.status !== 'ok') warnings.push(`Sender "${sd.display_name}" is ${sd.status} and will not send until it is reconnected or resumed`);
    }
    if (s.status !== 'active') warnings.push(`The sequence is ${s.status}: leads wait at the start until it is activated`);
    const plan = enrollPlan(ctx, s, leadIds, str(a.p_sender), includeReplied);
    const ok = plan.filter((p) => p.sender_id);
    const excluded: Record<string, { count: number; sample_ids: string[] }> = {};
    for (const p of plan) if (!p.sender_id) { const x = (excluded[p.reason!] ??= { count: 0, sample_ids: [] }); x.count++; if (x.sample_ids.length < 10) x.sample_ids.push(p.lead_id); }
    const replied = plan.filter((p) => p.reason === 'replied_recently').slice(0, 50).map((p) => store.get('outreach_leads', p.lead_id)!).filter(Boolean)
      .map((l) => ({ id: l.id, name: l.full_name, company: l.company, last_replied_at: l.last_replied_at, channel: l.last_replied_channel }))
      .sort((x, y) => (x.last_replied_at < y.last_replied_at ? 1 : -1));
    const bySender = new Map<string, number>();
    for (const p of ok) bySender.set(p.sender_id!, (bySender.get(p.sender_id!) ?? 0) + 1);
    const effects: Record<string, number> = {};
    for (const p of plan) if (p.note) effects[p.note] = (effects[p.note] ?? 0) + 1;
    const res: Row = {
      requested: plan.length, eligible: ok.length, eligible_ids: ok.map((p) => p.lead_id), excluded, replied_recently: replied,
      assignment: [...bySender.entries()].map(([sid, n]) => { const sd = store.get('outreach_senders', sid); return { sender_id: sid, name: sd?.display_name ?? null, status: sd?.status ?? 'ok', leads: n }; }),
      assignment_rule: s.assignment, rule_effects: effects,
    };
    if (ok.length > 0) { const pj = project(store, s, ok.length); res.projection = { estimated_days: pj.estimated_days, bottleneck: pj.bottleneck }; }
    if ((effects.contacted_before_by_this_sender ?? 0) > 0) warnings.push(`${effects.contacted_before_by_this_sender} lead(s) were contacted before by the sender they are assigned to`);
    return { ...res, sequence_id: s.id, sequence_status: s.status, include_replied: includeReplied, warnings };
  },

  enrollment_recover: (a, ctx) => {
    const store = ctx.store;
    const action = String(a.p_action ?? '');
    if (!['retry', 'skip', 'exit'].includes(action)) demoError('E_PAYLOAD_INVALID', 'action must be retry, skip or exit');
    const ids = asArr(a.p_enrollment_ids);
    const refused: Array<{ id: string; reason: string }> = [];
    if (!ids.length) return { done: 0, refused };
    if (ids.length > 500) demoError('E_TOO_MANY', 'max 500 per request');
    let done = 0;
    const before = sentCount(store);
    for (const id of ids) {
      const e = store.get('outreach_enrollments', id);
      if (!e || e.workspace_id !== ctx.ws) { refused.push({ id, reason: 'not_found' }); continue; }
      if (e.status !== 'failed') { refused.push({ id, reason: 'not_failed' }); continue; }
      if (action === 'exit') { store.update('outreach_enrollments', id, { status: 'exited_manual', exit_reason: `recovered:exit:${e.exit_reason ?? ''}` }); done++; continue; }
      const lead = store.get('outreach_leads', e.lead_id);
      const s = store.get('outreach_sequences', e.sequence_id);
      const st = store.t('outreach_lead_sender_state').find((x) => x.lead_id === e.lead_id && x.sender_id === e.sender_id);
      const sd = store.get('outreach_senders', e.sender_id);
      let why: string | null = null;
      if (lead && (lead.do_not_contact || lead.unsubscribed)) why = 'lead_suppressed';
      else if (st && ['invalid', 'blocked'].includes(st.relation) && action === 'retry') why = 'profile_invalid';
      else if (store.t('outreach_enrollments').some((x) => x.lead_id === e.lead_id && x.sender_id === e.sender_id && x.id !== id && LIVE_SET.has(x.status))) why = 'already_enrolled_again';
      else if (!sd || sd.deleted_at || sd.status === 'disabled') why = 'sender_gone';
      if (why) { refused.push({ id, reason: why }); continue; }
      store.update('outreach_enrollments', id, { status: 'active', completed_at: null, wait_until: ctx.now(), wait_reason: null, exit_reason: null, restart_count: (e.restart_count ?? 0) + 1 });
      if (action === 'skip') advance(store, e, e.current_node_id, null);
      if (s?.status === 'active') stepNow(store, store.get('outreach_enrollments', id));
      done++;
    }
    if (sentCount(store) > before) ctx.ui.simulated();
    return { done, action, refused };
  },

  exit_enrollment: (a, ctx) => { exitEnrollment(ctx, enrollmentOr404(ctx, a.p_id), str(a.p_reason) ?? 'manual'); return null; },

  failed_leads: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const limit = Math.min(Number(a.p_limit ?? 200) || 200, 500);
    const offset = Number(a.p_offset ?? 0) || 0;
    const node = str(a.p_node_id);
    // 106: an optional day window (one date alone = that day), applied to each row's own moment
    const from = str(a.p_from) ?? str(a.p_to); const to = str(a.p_to) ?? str(a.p_from);
    if (from && to && from > to) demoError('E_PAYLOAD_INVALID', 'from/to must be dates with from <= to');
    const finish = <T extends { at: string | null }>(rows: T[]): T[] => (from ? rows.filter((r) => inWindow(r.at, from, to)) : rows).slice(offset, offset + limit);
    const enr = new Map(store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id).map((e) => [e.id, e]));
    const lead = (id: string) => store.get('outreach_leads', id);
    const sender = (id: string) => store.get('outreach_senders', id);
    if (a.p_kind === 'skipped') {
      const rows = store.t('outreach_actions').filter((x) => x.status === 'skipped' && x.enrollment_id && enr.has(x.enrollment_id) && (!node || x.node_id === node) && !x.payload?.prefetch && !x.payload?.subtask)
        .sort((x, y) => String(y.executed_at ?? '').localeCompare(String(x.executed_at ?? '')));
      return finish(rows.map((x) => {
        const e = enr.get(x.enrollment_id)!; const l = lead(e.lead_id); const sd = sender(x.sender_id);
        return { enrollment_id: e.id, lead_id: e.lead_id, lead_name: l?.full_name ?? null, company: l?.company ?? null, sender_id: x.sender_id, sender_name: sd?.display_name ?? null, node_id: x.node_id, error_code: x.error_code ?? null, reason: reasonText(x.error_code), at: (x.executed_at ?? null) as string | null, recoverable: false };
      }).filter((r) => r.lead_name !== undefined));
    }
    // the other chips (098): the same rows sim/derived.ts counts for outreach_node_stats
    const kind = a.p_kind;
    if (kind === 'queued' || kind === 'sent' || kind === 'accepted' || kind === 'replied' || kind === 'interested' || kind === 'meetings') {
      const row = (e: Row, senderId: string, nodeId: string | null, reason: string | null, at: string | null) => {
        const l = lead(e.lead_id);
        return { enrollment_id: e.id, lead_id: e.lead_id, lead_name: l?.full_name ?? null, company: l?.company ?? null, sender_id: senderId, sender_name: sender(senderId)?.display_name ?? null, node_id: nodeId, error_code: null, reason, at, recoverable: false };
      };
      const firstReply = (e: Row) => { const m = chatMessages(ctx, e.lead_id, e.sender_id, 'in', '').pop(); return m ? String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null : null; };
      let rows: ReturnType<typeof row>[];
      if (kind === 'queued') {
        rows = [...enr.values()].filter((e) => LIVE.includes(e.status) && e.current_node_id && (!node || e.current_node_id === node))
          .map((e) => row(e, e.sender_id, e.current_node_id, 'Waiting to send', e.wait_until ?? null))
          .sort((x, y) => String(x.at ?? '').localeCompare(String(y.at ?? '')));
      } else if (kind === 'interested' || kind === 'meetings' || (kind === 'replied' && !node)) {
        // 106: sequence-wide outcomes, the same events sequence_analytics counts per day (its facts stand-ins)
        const chats = tbl(ctx, 'outreach_chats');
        const replied = [...enr.values()].filter((e) => e.status === 'exited_replied');
        if (kind === 'meetings') {
          rows = tbl(ctx, 'outreach_lead_milestones').filter((m) => m.kind === 'meeting').flatMap((m) => {
            const e = [...enr.values()].find((x) => x.lead_id === m.lead_id);
            return e ? [row(e, e.sender_id, null, null, m.at ?? null)] : [];
          });
        } else {
          const list = kind === 'replied' ? replied : replied.filter((e) => chats.some((c) => c.lead_id === e.lead_id && c.sender_id === e.sender_id && c.intent === 'interested'));
          rows = list.map((e) => row(e, e.sender_id, null, firstReply(e), e.completed_at ?? null));
        }
        rows.sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')));
      } else {
        const acts = store.t('outreach_actions').filter((x) => x.enrollment_id && enr.has(x.enrollment_id) && x.node_id && x.status === 'sent' && (!node || x.node_id === node));
        if (kind === 'sent') rows = acts.map((x) => row(enr.get(x.enrollment_id)!, x.sender_id, x.node_id, null, x.executed_at ?? null));
        else if (kind === 'accepted') {
          const states = new Map(store.t('outreach_lead_sender_state').map((st) => [`${st.lead_id}|${st.sender_id}`, st]));
          rows = acts.filter((x) => x.action_type === 'invite').flatMap((x) => {
            const st = states.get(`${x.lead_id}|${x.sender_id}`);
            return st?.invite_accepted_at && x.executed_at && st.invite_accepted_at >= x.executed_at ? [row(enr.get(x.enrollment_id)!, x.sender_id, x.node_id, null, st.invite_accepted_at)] : [];
          });
        } else {
          const byId = new Map(acts.map((x) => [x.id, x]));
          const seen = new Set<string>();
          rows = store.t('outreach_messages').filter((m) => m.direction === 'in' && m.replied_to_action_id && byId.has(m.replied_to_action_id))
            .sort((x, y) => String(x.sent_at ?? '').localeCompare(String(y.sent_at ?? '')))
            .flatMap((m) => {
              if (seen.has(m.replied_to_action_id)) return [];
              seen.add(m.replied_to_action_id);
              const x = byId.get(m.replied_to_action_id)!;
              return [row(enr.get(x.enrollment_id)!, x.sender_id, x.node_id, String(m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) || null, m.sent_at ?? null)];
            });
        }
        rows.sort((x, y) => String(y.at ?? '').localeCompare(String(x.at ?? '')));
      }
      return finish(rows);
    }
    const failedAction =(eid: string) => store.t('outreach_actions').filter((x) => x.enrollment_id === eid && x.status === 'failed').sort((x, y) => String(y.executed_at ?? '').localeCompare(String(x.executed_at ?? '')))[0];
    const rows = [...enr.values()].filter((e) => e.status === 'failed' && (!node || e.current_node_id === node)).sort((x, y) => String(y.completed_at ?? '').localeCompare(String(x.completed_at ?? '')));
    return finish(rows.map((e) => {
      const l = lead(e.lead_id); const sd = sender(e.sender_id); const fa = failedAction(e.id);
      const code = fa?.error_code ?? e.exit_reason ?? null;
      return { enrollment_id: e.id, lead_id: e.lead_id, lead_name: l?.full_name ?? null, company: l?.company ?? null, sender_id: e.sender_id, sender_name: sd?.display_name ?? null, node_id: e.current_node_id, error_code: code, reason: reasonText(code), at: (e.completed_at ?? null) as string | null, recoverable: !!l && !(l.do_not_contact || l.unsubscribed) && (fa?.decision ?? '') !== 'mark_lead_invalid' };
    }));
  },

  move_to_latest: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const version = Number(a.p_version);
    let moved = 0, kept = 0;
    for (const e of liveEnrollments(store, s.id)) {
      if (e.pinned_version !== version) continue;
      if (s.graph?.nodes?.[e.current_node_id ?? '']) {
        store.update('outreach_enrollments', e.id, { pinned_version: null, sequence_version: s.head_version });
        for (const x of store.t('outreach_actions')) {
          if (x.enrollment_id !== e.id || x.status !== 'queued' || x.payload?.approved_task_id) continue;
          const { text: _t, note: _n, subject: _s, html: _h, variant_id: _v, ...rest } = x.payload ?? {};
          void _t; void _n; void _s; void _h; void _v;
          store.update('outreach_actions', x.id, { payload: rest, variant_id: null });
        }
        moved++;
      } else kept++;
    }
    return { moved, kept_on_old_version: kept };
  },

  node_queued_actions: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const enr = new Set(store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id).map((e) => e.id));
    return store.t('outreach_actions').filter((x) => x.status === 'queued' && x.node_id === a.p_node_id && x.enrollment_id && enr.has(x.enrollment_id) && !x.payload?.prefetch)
      .sort((x, y) => String(x.scheduled_for).localeCompare(String(y.scheduled_for))).slice(0, 2000)
      .map((x) => ({ action_id: x.id, lead_id: x.lead_id, lead_name: store.get('outreach_leads', x.lead_id)?.full_name ?? null, sender_id: x.sender_id, payload: x.payload ?? {}, scheduled_for: x.scheduled_for, variant_id: x.variant_id ?? null }));
  },

  pause_enrollment: (a, ctx) => {
    const e = enrollmentOr404(ctx, a.p_id);
    if (['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(e.status)) ctx.store.update('outreach_enrollments', e.id, { paused_from: e.status, status: 'paused' });
    return null;
  },

  project_sequence: (a, ctx) => {
    const s = ctx.store.get('outreach_sequences', a.p_sequence);
    if (!s || s.workspace_id !== ctx.ws) return [];
    return [project(ctx.store, s, Math.max(0, Number(a.p_lead_count) || 0))];
  },

  promote_variant: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence);
    const nodeId = String(a.p_node_id ?? '');
    const vars = s.graph?.nodes?.[nodeId]?.config?.variants;
    if (!Array.isArray(vars)) demoError('E_PAYLOAD_INVALID', 'step has no variants');
    if (!vars.some((v: Row) => v.id === a.p_variant)) demoError('E_NOT_FOUND', 'variant');
    const nv = vars.map((v: Row) => (v.id === a.p_variant ? { ...v, weight: 100, promoted_at: ctx.now() } : { ...v, weight: 0 }));
    const g = clone(s.graph) as Graph;
    g.nodes[nodeId].config = { ...(g.nodes[nodeId].config ?? {}), variants: nv };
    if (s.draft_graph?.nodes?.[nodeId]) {
      const dg = clone(s.draft_graph);
      dg.nodes[nodeId].config = { ...(dg.nodes[nodeId].config ?? {}), variants: nv };
      ctx.store.update('outreach_sequences', s.id, { draft_graph: dg, draft_base_version: (s.head_version ?? 0) + 1 });
    }
    const draft = ctx.store.get('outreach_sequences', s.id)!.draft_graph;
    const draftBase = ctx.store.get('outreach_sequences', s.id)!.draft_base_version;
    const version = saveSequence(ctx, ctx.store.get('outreach_sequences', s.id)!, { graph: g });
    // an open draft stays a draft
    if (draft) ctx.store.update('outreach_sequences', s.id, { draft_graph: draft, draft_updated_at: ctx.now(), draft_base_version: draftBase });
    ctx.store.update('outreach_sequence_versions', (v) => v.sequence_id === s.id && v.version === version, { note: `Promoted variant ${a.p_variant} on ${nodeId}`, publish_mode: 'all' });
    refreshQueuedText(ctx, s.id, nodeId);
    return { version, promoted: a.p_variant };
  },

  publish_impact: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_id);
    const g: Graph = a.p_graph ?? s.draft_graph ?? s.graph;
    const diff = graphDiff(s.graph, g);
    const changed = new Set(diff.filter((d) => d.change !== 'added').map((d) => d.node_id));
    const texty = new Set(diff.filter((d) => d.text_changed).map((d) => d.node_id));
    const delays = new Set(diff.filter((d) => d.delay_changed).map((d) => d.node_id));
    const live = liveEnrollments(store, s.id);
    const unpinned = live.filter((e) => e.pinned_version == null);
    const enrSet = new Map(store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id).map((e) => [e.id, e]));
    const acts = store.t('outreach_actions').filter((x) => x.enrollment_id && enrSet.has(x.enrollment_id) && !x.payload?.prefetch);
    const onChanged = live.filter((e) => changed.has(e.current_node_id)).length;
    const pastIds = new Set<string>();
    for (const x of acts) {
      if (!changed.has(x.node_id) || !['sent', 'skipped'].includes(x.status)) continue;
      const e = enrSet.get(x.enrollment_id)!;
      if (LIVE_SET.has(e.status) && e.pinned_version == null && !changed.has(e.current_node_id)) pastIds.add(e.id);
    }
    const pinned = live.filter((e) => e.pinned_version != null).length;
    const queuedOld = acts.filter((x) => x.status === 'queued' && texty.has(x.node_id) && enrSet.get(x.enrollment_id)!.pinned_version == null).length;
    const waitingDelay = unpinned.filter((e) => e.status === 'waiting_delay' && delays.has(e.current_node_id)).length;
    const nodes = diff.map((d) => ({
      node_id: d.node_id, change: d.change, type: d.node_type, text_changed: d.text_changed, delay_changed: d.delay_changed,
      leads_here: unpinned.filter((e) => e.current_node_id === d.node_id).length,
      queued: acts.filter((x) => x.status === 'queued' && x.node_id === d.node_id && enrSet.get(x.enrollment_id)!.pinned_version == null).length,
    }));
    const past = pastIds.size;
    return {
      head_version: s.head_version, draft_base_version: s.draft_base_version ?? null, stale: s.draft_base_version != null && s.draft_base_version !== s.head_version,
      changes: diff.length, in_flight: live.length, already_pinned: pinned, on_changed_step: onChanged, past_changed_step: past,
      on_or_after_changed: onChanged + past, before_changed_step: Math.max(live.length - pinned - onChanged - past, 0),
      queued_with_old_text: queuedOld, waiting_on_changed_delay: waitingDelay, removed_nodes: diff.filter((d) => d.change === 'removed').map((d) => d.node_id),
      nodes, validation: validate(store, g, s.sender_pool ?? [], s.status === 'active', s.settings),
    };
  },

  publish_sequence: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_id);
    const mode = a.p_mode ?? 'all';
    const removedMode = a.p_removed_mode ?? 'skip';
    if (!['all', 'new_only'].includes(mode)) demoError('E_PAYLOAD_INVALID', 'mode must be all or new_only');
    if (!['skip', 'exit'].includes(removedMode)) demoError('E_PAYLOAD_INVALID', 'removed_mode must be skip or exit');
    const g: Graph | null = a.p_graph ?? s.draft_graph ?? null;
    if (!g) demoError('E_PAYLOAD_INVALID', 'nothing to publish');
    if (!a.p_force && s.draft_base_version != null && s.draft_base_version !== s.head_version) {
      demoError('E_DRAFT_STALE', `version ${s.head_version} was published while you were editing (your draft started from version ${s.draft_base_version})`);
    }
    // validate before anything moves (the real function raises inside the same transaction)
    assertValid(store, g, a.p_pool ?? s.sender_pool ?? [], s.status === 'active', a.p_settings ?? s.settings);
    if (!store.t('outreach_sequence_versions').some((v) => v.sequence_id === s.id && v.version === s.head_version)) {
      store.insert('outreach_sequence_versions', { sequence_id: s.id, version: s.head_version, graph: clone(s.graph), created_by: ctx.userId, created_at: ctx.now(), note: null, publish_mode: null }, { noId: true });
    }
    const oldGraph = clone(s.graph) as Graph;
    const diff = graphDiff(oldGraph, g);
    let pinnedN = 0, removedN = 0;
    if (mode === 'new_only') {
      for (const e of liveEnrollments(store, s.id)) if (e.pinned_version == null) { store.update('outreach_enrollments', e.id, { pinned_version: s.head_version }); pinnedN++; }
    } else {
      for (const d of diff.filter((x) => x.change === 'removed')) {
        for (const e of liveEnrollments(store, s.id).filter((x) => x.pinned_version == null && x.current_node_id === d.node_id)) {
          removedN++;
          if (removedMode === 'skip') {
            for (const x of store.t('outreach_actions')) if (x.enrollment_id === e.id && (x.status === 'queued' || x.status === 'reserved')) { x.status = 'cancelled'; x.decision = 'node_deleted'; }
            store.update('outreach_tasks', (t) => t.enrollment_id === e.id && t.node_id === d.node_id && !t.completed_at, { completed_at: ctx.now(), completed_by: ctx.userId, result: { decision: 'node_deleted' } });
            advance(store, e, d.node_id, null, oldGraph);
          } else finish(store, e, 'exited_manual', 'node_deleted');
        }
      }
      engineFor(store).resetIndexes();
    }
    const newv = saveSequence(ctx, store.get('outreach_sequences', s.id)!, {
      graph: g, pool: Array.isArray(a.p_pool) ? a.p_pool : null, settings: a.p_settings ?? null, name: a.p_name ?? null, assignment: a.p_assignment ?? null,
      useSenderSchedule: typeof a.p_use_sender_schedule === 'boolean' ? a.p_use_sender_schedule : null, clientId: str(a.p_client_id), brief: typeof a.p_brief === 'string' ? a.p_brief : null,
    });
    store.update('outreach_sequence_versions', (v) => v.sequence_id === s.id && v.version === newv, { note: str(a.p_note), publish_mode: mode });
    let upd = 0, resched = 0;
    if (mode === 'all') {
      const cur = store.get('outreach_sequences', s.id)!;
      if (a.p_update_queued) for (const d of diff.filter((x) => x.text_changed)) upd += refreshQueuedText(ctx, s.id, d.node_id);
      if (a.p_reschedule_delays) for (const d of diff.filter((x) => x.delay_changed && x.node_type === 'delay')) resched += rescheduleDelay(ctx, cur, d.node_id);
    }
    store.update('outreach_sequences', s.id, { draft_graph: null, draft_updated_at: null, draft_updated_by: null, draft_base_version: null });
    return { version: newv, mode, pinned: pinnedN, queued_updated: upd, rescheduled: resched, removed_step_leads: removedN };
  },

  rebalance_preview: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const cur: string[] = s.sender_pool ?? [];
    const pool: string[] = Array.isArray(a.p_pool) ? asArr(a.p_pool) : cur;
    const added = pool.filter((x) => !cur.includes(x));
    const removed = cur.filter((x) => !pool.includes(x));
    const n = pool.length;
    const untouched = untouchedEnrollments(ctx, s.id);
    const movable = untouched.length;
    const target = n > 0 ? Math.ceil(movable / n) : 0;
    const untouchedIds = new Set(untouched.map((u) => u.id));
    const live = liveEnrollments(store, s.id);
    const senders = Array.from(new Set([...pool, ...cur])).map((sid) => store.get('outreach_senders', sid)).filter((x): x is Row => !!x).map((sd) => {
      const u = untouched.filter((e) => e.sender_id === sd.id).length;
      const inPool = pool.includes(sd.id);
      return { sender_id: sd.id, name: sd.display_name ?? null, status: sd.status, in_pool: inPool, untouched: u, contacted: live.filter((e) => e.sender_id === sd.id && !untouchedIds.has(e.id)).length, after: inPool ? Math.min(Math.max(u, 0), target) : 0 };
    });
    const wouldMove = senders.reduce((m, r) => m + (r.in_pool ? Math.max(r.untouched - target, 0) : r.untouched), 0);
    return {
      pool_size: n, added, removed, untouched_total: movable, would_move: wouldMove, target_per_sender: target, senders,
      contacted_on_removed: senders.filter((r) => !r.in_pool).reduce((m, r) => m + r.contacted, 0),
      note: 'Only leads with nothing sent and no invite pending can move. Leads a sender already contacted stay with that sender.',
    };
  },

  render_context: (a, ctx) => {
    const l = ctx.store.get('outreach_leads', a.p_lead);
    if (!l || l.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Lead not found');
    const sender = str(a.p_sender);
    return renderContextJson(ctx.store, l.id, sender && ctx.store.get('outreach_senders', sender)?.workspace_id === ctx.ws ? sender : null, str(a.p_enrollment));
  },

  reschedule_action: (a, ctx) => {
    const x = ctx.store.get('outreach_actions', a.p_action);
    if (!x || x.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Action not found');
    if (x.status !== 'queued') demoError('E_PAYLOAD_INVALID', 'only queued actions can be moved');
    const at = Date.parse(String(a.p_at ?? ''));
    if (!Number.isFinite(at) || at < Date.now() - 60_000 || at > Date.now() + 60 * D) demoError('E_PAYLOAD_INVALID', 'pick a time within the next 60 days');
    ctx.store.update('outreach_actions', x.id, { scheduled_for: iso(at), decision: 'user_rescheduled' });
    return null;
  },

  resume_enrollment: (a, ctx) => { resumeEnrollment(ctx, enrollmentOr404(ctx, a.p_id)); return null; },

  // ---- sequence lead filters, bulk unenroll & Analytics (101)
  sequence_lead_counts: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence);
    const rows = leadRowsFor(ctx, s, { ...a, p_filter: 'all', p_teammate: null, p_search: null });
    const n = (sts: string[]) => rows.filter((e) => sts.includes(e.status)).length;
    const byUser = new Map<string, number>();
    for (const e of rows) if (e.status === 'exited_manual' && e.status_changed_by) byUser.set(e.status_changed_by, (byUser.get(e.status_changed_by) ?? 0) + 1);
    return {
      all: rows.length, live: n(LEAD_FILTER_STATUSES.live!), active: n(LEAD_FILTER_STATUSES.active!), invite_sent: n(['waiting_connection']), waiting_task: n(['waiting_task']), paused: n(['paused']),
      completed: n(['completed']), handoff: n(['exited_replied']), stopped_by_teammate: n(['exited_manual']), sender_disabled: n(['exited_sender_disabled']), failed: n(['failed']), unenrolled: n(['cancelled']), do_not_contact: n(['exited_suppressed']),
      teammates: [...byUser].map(([user_id, count]) => ({ user_id, name: memberName(ctx, user_id) ?? 'Teammate', count })).sort((x, y) => y.count - x.count),
      stopped_by_system: rows.filter((e) => e.status === 'exited_manual' && !e.status_changed_by).length,
    };
  },

  sequence_leads: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence);
    const limit = Math.min(Math.max(Number(a.p_limit ?? 50) || 50, 1), 200); const offset = Math.max(Number(a.p_offset ?? 0) || 0, 0);
    const nums = stepNumbers(s.graph); const stepTotal = Math.max(0, ...Object.values(nums));
    const all = leadRowsFor(ctx, s, a);
    return { total: all.length, limit, offset, step_total: stepTotal, rows: all.slice(offset, offset + limit).map((e) => leadRow(ctx, s, e, nums, stepTotal)) };
  },

  sequence_bulk_preview: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence); const action = str(a.p_action) ?? '';
    if (!['unenroll', 'pause', 'resume'].includes(action)) demoError('E_PAYLOAD_INVALID', 'action must be unenroll, pause or resume');
    const t = bulkTargets(ctx, s, a); const ok = t.filter((e) => bulkCan(action, e)).length;
    return { total: t.length, eligible: ok, skipped: t.length - ok, sequence_name: s.name };
  },

  sequence_bulk: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence); const action = str(a.p_action) ?? '';
    if (!['unenroll', 'pause', 'resume'].includes(action)) demoError('E_PAYLOAD_INVALID', 'action must be unenroll, pause or resume');
    const byIds = Array.isArray(a.p_ids);
    if (byIds && asArr(a.p_ids).length > 500) demoError('E_TOO_MANY', 'max 500 ids per call; pass a filter for more');
    const limit = Math.min(Math.max(Number(a.p_limit ?? 500) || 500, 1), 500);
    const batch = str(a.p_batch) ?? crypto.randomUUID();
    const targets = bulkTargets(ctx, s, a);
    const eligible = byIds ? targets : targets.filter((e) => bulkCan(action, e)).slice(0, limit);
    let done = 0; let skipped = 0;
    const undo = ctx.store.meta<Record<string, Row[]>>(UNDO_KEY, () => ({}));
    for (const e0 of eligible) {
      const e = ctx.store.get('outreach_enrollments', e0.id)!;
      if (!bulkCan(action, e)) { skipped++; continue; }
      if (action === 'unenroll') {
        const actionIds = ctx.store.t('outreach_actions').filter((x) => x.enrollment_id === e.id && (x.status === 'queued' || x.status === 'reserved')).map((x) => x.id);
        (undo[batch] ??= []).push({ enrollment_id: e.id, prev_status: e.status, prev_paused_from: e.paused_from ?? null, prev_wait_until: e.wait_until ?? null, prev_node_id: e.current_node_id ?? null, prev_node_entered: e.node_entered_at ?? null, prev_exit_reason: e.exit_reason ?? null, prev_held_at: e.held_at ?? null, prev_hold_reason: e.hold_reason ?? null, action_ids: actionIds, at: ctx.now() });
        finish(ctx.store, e, 'cancelled', 'unenrolled');
        ctx.store.update('outreach_enrollments', e.id, { held_at: null, hold_reason: null, paused_from: null });
        ctx.store.update('outreach_actions', (x) => actionIds.includes(x.id) && x.status !== 'sent', { status: 'cancelled', decision: 'enrollment_cancelled' });
        closeHoldTasks(ctx, e.id, 'exit');
      } else if (action === 'pause') {
        ctx.store.update('outreach_enrollments', e.id, { paused_from: e.status, status: 'paused' });
      } else {
        resumeEnrollment(ctx, e);
      }
      markChanged(ctx, e.id);
      done++;
    }
    const remaining = byIds ? 0 : leadRowsFor(ctx, s, a).filter((e) => bulkCan(action, e)).length;
    return { batch_id: batch, action, done, skipped: byIds ? skipped + (targets.length - eligible.length) : skipped, remaining };
  },

  sequence_bulk_undo: (a, ctx) => {
    const batch = str(a.p_batch) ?? '';
    const undo = ctx.store.meta<Record<string, Row[]>>(UNDO_KEY, () => ({}));
    const rows = undo[batch]; if (!rows) demoError('E_NOT_FOUND', 'batch');
    if (rows.length && Date.parse(rows[0].at) < Date.now() - 15 * 60_000) demoError('E_UNDO_EXPIRED', 'this can no longer be undone');
    let restored = 0; let skipped = 0;
    for (const u of rows) {
      if (u.restored_at) continue;
      const e = ctx.store.get('outreach_enrollments', u.enrollment_id);
      if (!e || e.status !== 'cancelled' || e.exit_reason !== 'unenrolled') { skipped++; continue; }
      if (ctx.store.t('outreach_enrollments').some((x) => x.lead_id === e.lead_id && x.sender_id === e.sender_id && x.id !== e.id && LIVE_SET.has(x.status))) { skipped++; continue; }
      ctx.store.update('outreach_enrollments', e.id, { status: u.prev_status, paused_from: u.prev_paused_from, wait_until: u.prev_wait_until, current_node_id: u.prev_node_id, node_entered_at: u.prev_node_entered ?? e.node_entered_at, exit_reason: u.prev_exit_reason, completed_at: null, held_at: u.prev_held_at, hold_reason: u.prev_hold_reason });
      ctx.store.update('outreach_actions', (x) => (u.action_ids as string[]).includes(x.id) && x.status === 'cancelled' && x.decision === 'enrollment_cancelled', { status: 'queued', decision: null, reserved_at: null });
      markChanged(ctx, e.id);
      u.restored_at = ctx.now();
      restored++;
    }
    engineFor(ctx.store).resetIndexes();
    return { batch_id: batch, restored, skipped };
  },

  sequence_analytics: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence);
    const today = day(ctx.now());
    const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const to = str(a.p_to) ?? today; const from = str(a.p_from) ?? addDays(to, -29);
    if ((str(a.p_from) && !str(a.p_to)) || (!str(a.p_from) && str(a.p_to))) demoError('E_PAYLOAD_INVALID', 'from/to must be dates with from <= to, or both empty');
    if (from > to) demoError('E_PAYLOAD_INVALID', 'from/to must be dates with from <= to');
    const enr = ctx.store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id); const enrIds = new Set(enr.map((e) => e.id));
    const inRange = enr.filter((e) => inWindow(e.created_at, from, to));
    const acts = ctx.store.t('outreach_actions').filter((x) => x.enrollment_id && enrIds.has(x.enrollment_id) && !x.payload?.prefetch && !x.payload?.subtask);
    const sentActs = acts.filter((x) => x.status === 'sent' && inWindow(x.executed_at, from, to));
    const lssOf = (e: Row) => tbl(ctx, 'outreach_lead_sender_state').find((l) => l.lead_id === e.lead_id && l.sender_id === e.sender_id);
    const invited = sentActs.filter((x) => x.action_type === 'invite' || x.action_type === 'follow');
    const accepted = enr.filter((e) => { const l = lssOf(e); return !!l && inWindow(l.invite_accepted_at, from, to); });
    const replied = enr.filter((e) => e.status === 'exited_replied' && inWindow(e.completed_at, from, to));
    const chats = tbl(ctx, 'outreach_chats');
    const interested = replied.filter((e) => chats.some((c) => c.lead_id === e.lead_id && c.sender_id === e.sender_id && c.intent === 'interested'));
    const meetings = tbl(ctx, 'outreach_lead_milestones').filter((m) => m.kind === 'meeting' && inWindow(m.at, from, to) && enr.some((e) => e.lead_id === m.lead_id));
    const contacted = new Set(sentActs.filter((x) => ['invite', 'message', 'inmail', 'email', 'new_chat', 'follow'].includes(x.action_type)).map((x) => x.enrollment_id)).size;
    const cards = { enrolled: inRange.length, invites_sent: invited.length, accepted: accepted.length, replied: replied.length, interested: interested.length, meetings: meetings.length, contacted,
      accepted_rate: pctOf(accepted.length, invited.length), replied_rate: pctOf(replied.length, accepted.length), replied_of_contacted_rate: pctOf(replied.length, contacted), interested_rate: pctOf(interested.length, replied.length) };
    const cnt = (sts: string[]) => inRange.filter((e) => sts.includes(e.status)).length;
    const progress = { live: cnt(LEAD_FILTER_STATUSES.live!), completed: cnt(['completed']), handoff: cnt(['exited_replied']), stopped: cnt(LEAD_FILTER_STATUSES.stopped!), failed: cnt(['failed']), unenrolled: cnt(['cancelled']), total: inRange.length };
    const graph = s.graph as Row; const nums = stepNumbers(graph);
    const msgs = tbl(ctx, 'outreach_messages');
    const steps = Object.entries(graph?.nodes ?? {}).filter(([, n]) => !PASSIVE_NODES.has((n as Row).type)).map(([id, n0]) => {
      const n = n0 as Row;
      const mine = acts.filter((x) => x.node_id === id && inWindow(x.executed_at, from, to));
      const sent = mine.filter((x) => x.status === 'sent').length; const skipped = mine.filter((x) => x.status === 'skipped').length; const failed = mine.filter((x) => x.status === 'failed').length;
      const acc = n.type === 'send_invite' || n.type === 'follow' ? accepted.filter((e) => acts.some((x) => x.enrollment_id === e.id && x.node_id === id && x.status === 'sent')).length : 0;
      const read = msgs.filter((m) => m.read_at && m.action_id && mine.some((x) => x.id === m.action_id)).length;
      const rep = replied.filter((e) => e.current_node_id === id).length;
      const denom = sent + skipped + failed;
      return { node_id: id, step_number: nums[id] ?? null, type: n.type, label: nodeLabel(graph, id) ?? n.type, variant_id: null, has_variants: Array.isArray(n.config?.variants) && n.config.variants.length > 1,
        sent, accepted: acc, read, replied: rep, skipped, failed, accepted_rate: pctOf(acc, sent), read_rate: pctOf(read, sent), replied_rate: pctOf(rep, sent), skipped_rate: pctOf(skipped, denom), failed_rate: pctOf(failed, denom),
        leads_here: enr.filter((e) => e.current_node_id === id && LIVE_SET.has(e.status)).length };
    }).sort((x, y) => (x.step_number ?? 9999) - (y.step_number ?? 9999));
    const days: Row[] = [];
    // 105: each day also carries what came back that day (the same events as the cards, so the days add up to them)
    for (let d = from; d <= to; d = addDays(d, 1)) days.push({
      day: d, planned: acts.filter((x) => day(x.scheduled_for) === d && x.status !== 'cancelled').length, sent: acts.filter((x) => x.status === 'sent' && day(x.executed_at) === d).length, snapshot: false,
      accepted: accepted.filter((e) => day(lssOf(e)?.invite_accepted_at) === d).length, replied: replied.filter((e) => day(e.completed_at) === d).length,
      interested: interested.filter((e) => day(e.completed_at) === d).length, meetings: meetings.filter((m) => day(m.at) === d).length,
    });
    const td = days.find((x) => x.day === today); const gap = td && td.planned > 0 ? Math.round(((td.planned - td.sent) * 1000) / td.planned) / 10 : null;
    const pool = new Set<string>(s.sender_pool ?? []); for (const x of sentActs) pool.add(x.sender_id);
    const senders = [...pool].map((sid) => ctx.store.get('outreach_senders', sid)).filter((x): x is Row => !!x).map((sd) => {
      const mine = sentActs.filter((x) => x.sender_id === sd.id); const inv = mine.filter((x) => x.action_type === 'invite' || x.action_type === 'follow').length;
      const acc = accepted.filter((e) => e.sender_id === sd.id).length; const rep = replied.filter((e) => e.sender_id === sd.id).length;
      const touches = mine.filter((x) => ['invite', 'message', 'inmail', 'email', 'new_chat'].includes(x.action_type)).length;
      return { id: sd.id, name: sd.display_name ?? sd.owner_email ?? 'Sender', provider: sd.provider, status: sd.status, status_reason: sd.status_reason ?? null, in_pool: (s.sender_pool ?? []).includes(sd.id),
        sent: mine.length, invites: inv, accepted: acc, replied: rep, failed: acts.filter((x) => x.sender_id === sd.id && x.status === 'failed' && inWindow(x.executed_at, from, to)).length,
        accepted_rate: pctOf(acc, inv), replied_rate: pctOf(rep, touches), limited: false, live: enr.filter((e) => e.sender_id === sd.id && LIVE_SET.has(e.status)).length };
    }).sort((x, y) => y.sent - x.sent);
    const team = new Map<string, { handoffs_taken: number; stopped: number; unenrolled: number }>();
    const bump = (u: string | null | undefined, k: 'handoffs_taken' | 'stopped' | 'unenrolled') => { if (!u) return; const t = team.get(u) ?? { handoffs_taken: 0, stopped: 0, unenrolled: 0 }; t[k]++; team.set(u, t); };
    for (const e of enr) {
      if (e.status === 'exited_manual' && inWindow(e.status_changed_at ?? e.completed_at, from, to)) bump(e.status_changed_by, 'stopped');
      if (e.status === 'cancelled' && e.exit_reason === 'unenrolled' && inWindow(e.status_changed_at ?? e.completed_at, from, to)) bump(e.status_changed_by, 'unenrolled');
      if (e.status === 'exited_replied' && inWindow(e.completed_at, from, to)) { const m = chatMessages(ctx, e.lead_id, e.sender_id, 'out', e.completed_at).find((x) => x.sent_by); bump(m?.sent_by, 'handoffs_taken'); }
    }
    const untaken = replied.filter((e) => !chatMessages(ctx, e.lead_id, e.sender_id, 'out', e.completed_at).some((x) => x.sent_by)).length;
    const first = acts.filter((x) => x.status === 'sent' && x.executed_at).map((x) => String(x.executed_at)).sort()[0] ?? null;
    return {
      sequence: { id: s.id, name: s.name, status: s.status, head_version: s.head_version }, period: { from, to, timezone: 'UTC', default: !str(a.p_from) && !str(a.p_to) },
      first_run_at: first, empty: !first, cards, progress, steps,
      daily: { days, today, today_planned: td?.planned ?? 0, today_sent: td?.sent ?? 0, gap_pct: gap, gap_reason: gap !== null && gap > 20 ? (s.status === 'paused' ? 'The sequence is paused' : 'The day is not over: sends continue in each sender’s working hours') : null },
      senders, team: [...team].map(([user_id, t]) => ({ user_id, name: memberName(ctx, user_id) ?? 'Teammate', ...t })), handoffs_untaken: untaken, definitions_version: 2,
    };
  },

  sequence_analytics_leads: (a, ctx) => {
    const s = seqOr404(ctx, a.p_sequence);
    const today = day(ctx.now());
    const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
    const to = str(a.p_to) ?? today; const from = str(a.p_from) ?? addDays(to, -29);
    const limit = Math.min(Math.max(Number(a.p_limit ?? 50) || 50, 1), 200); const offset = Math.max(Number(a.p_offset ?? 0) || 0, 0); const q = (str(a.p_search) ?? '').toLowerCase();
    const nums = stepNumbers(s.graph); const stepTotal = Math.max(0, ...Object.values(nums));
    const all = ctx.store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id && inWindow(e.created_at, from, to) && (!q || (() => { const l = ctx.store.get('outreach_leads', e.lead_id); return !!l && [l.full_name, l.company].some((v) => typeof v === 'string' && v.toLowerCase().includes(q)); })()))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
    const rows = all.slice(offset, offset + limit).map((e) => {
      const lead = ctx.store.get('outreach_leads', e.lead_id); const sender = ctx.store.get('outreach_senders', e.sender_id);
      const lss = tbl(ctx, 'outreach_lead_sender_state').find((l) => l.lead_id === e.lead_id && l.sender_id === e.sender_id);
      const sentNodes = ctx.store.t('outreach_actions').filter((x) => x.enrollment_id === e.id && x.status === 'sent' && x.node_id).map((x) => nums[x.node_id] ?? 0);
      const chat = tbl(ctx, 'outreach_chats').find((c) => c.lead_id === e.lead_id && c.sender_id === e.sender_id);
      return { id: e.id, lead_id: e.lead_id, status: e.status, created_at: e.created_at, completed_at: e.completed_at ?? null,
        lead: lead ? { id: lead.id, full_name: lead.full_name ?? null, company: lead.company ?? null, public_identifier: lead.public_identifier ?? null, picture_url: lead.picture_url ?? null } : null,
        sender: { id: sender?.id ?? null, display_name: sender?.display_name ?? null },
        step_reached: Math.max(0, ...sentNodes, e.current_node_id ? nums[e.current_node_id] ?? 0 : 0), step_total: stepTotal, step_label: nodeLabel(s.graph, e.current_node_id),
        invited_at: lss?.invite_sent_at ?? null, accepted_at: lss?.invite_accepted_at ?? null, replied_at: e.status === 'exited_replied' ? e.completed_at ?? null : null,
        positive_at: e.status === 'exited_replied' && chat?.intent === 'interested' ? e.completed_at ?? null : null, meeting_at: tbl(ctx, 'outreach_lead_milestones').find((m) => m.kind === 'meeting' && m.lead_id === e.lead_id)?.at ?? null };
    });
    return { total: all.length, limit, offset, step_total: stepTotal, rows };
  },

  rule_match_count: (a, ctx) => {
    const r = ctx.store.get('outreach_auto_enroll_rules', a.p_rule);
    if (!r || r.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Rule not found');
    return ruleCandidates(ctx.store, r, 5000).length;
  },

  save_auto_enroll_rule: (a, ctx) => {
    const store = ctx.store;
    const p: Row = a.p_rule && typeof a.p_rule === 'object' ? a.p_rule : {};
    const s = store.get('outreach_sequences', p.sequence_id);
    if (!s || s.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'sequence');
    const filter: Row = p.filter && typeof p.filter === 'object' ? p.filter : {};
    if (!p.id && !p.list_id && Object.keys(filter).length === 0) demoError('E_PAYLOAD_INVALID', 'choose a list or at least one filter');
    if (p.list_id && store.get('outreach_lists', p.list_id)?.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'list');
    const cap = p.daily_cap != null ? Number(p.daily_cap) : null;
    if (cap != null && (!Number.isFinite(cap) || cap < 1 || cap > 1000)) demoError('E_PAYLOAD_INVALID', 'daily cap must be between 1 and 1000');
    let id: string;
    if (p.id) {
      const r = store.get('outreach_auto_enroll_rules', p.id);
      if (!r || r.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'rule');
      store.update('outreach_auto_enroll_rules', r.id, {
        name: p.name ?? r.name, list_id: 'list_id' in p ? p.list_id ?? null : r.list_id, filter: 'filter' in p ? filter : r.filter,
        daily_cap: cap ?? r.daily_cap, active: typeof p.active === 'boolean' ? p.active : r.active, last_run_at: null,
      });
      id = r.id;
    } else {
      id = store.insert('outreach_auto_enroll_rules', {
        workspace_id: ctx.ws, sequence_id: s.id, name: str(p.name) ?? 'Auto-enrol rule', list_id: p.list_id ?? null, filter, daily_cap: cap ?? 50,
        active: typeof p.active === 'boolean' ? p.active : true, last_run_at: null, created_by: ctx.userId,
      })[0].id;
    }
    // "run me next": the real cron picks a saved rule up within minutes; the demo runs it right away
    const r = store.get('outreach_auto_enroll_rules', id)!;
    if (r.active && s.status === 'active') {
      const before = sentCount(store);
      runRule(store, r, ctx.userId);
      if (sentCount(store) > before) ctx.ui.simulated();
    }
    return id;
  },

  save_draft: (a, ctx) => {
    const s = seqOr404(ctx, a.p_id);
    const g = a.p_graph;
    if (!g || typeof g !== 'object' || Array.isArray(g) || !g.nodes || typeof g.nodes !== 'object' || Array.isArray(g.nodes)) demoError('E_GRAPH_INVALID', 'graph.nodes missing');
    if (JSON.stringify(g).length > 2_000_000) demoError('E_PAYLOAD_INVALID', 'graph too large');
    const base = s.draft_graph == null ? s.head_version : (s.draft_base_version ?? s.head_version);
    const now = ctx.now();
    ctx.store.update('outreach_sequences', s.id, { draft_graph: clone(g), draft_updated_at: now, draft_updated_by: ctx.userId, draft_base_version: base });
    return { saved_at: now, base_version: base, head_version: s.head_version, stale: base !== s.head_version, unpublished_changes: changeCount(s.graph, g) };
  },

  save_sequence: (a, ctx) => {
    const s = seqOr404(ctx, a.p_id);
    if (!a.p_graph || typeof a.p_graph !== 'object') demoError('E_GRAPH_INVALID', JSON.stringify([{ code: 'E_GRAPH_INVALID', message: 'graph.nodes missing' }]));
    return saveSequence(ctx, s, {
      graph: a.p_graph, pool: Array.isArray(a.p_pool) ? asArr(a.p_pool) : null, settings: a.p_settings ?? null, name: a.p_name ?? null, assignment: a.p_assignment ?? null,
      useSenderSchedule: typeof a.p_use_sender_schedule === 'boolean' ? a.p_use_sender_schedule : null, clientId: str(a.p_client_id), brief: typeof a.p_brief === 'string' ? a.p_brief : null,
    });
  },

  save_voice_clip: (a, ctx) => {
    const store = ctx.store;
    const q = store.get('outreach_sequences', a.p_sequence);
    const sd = store.get('outreach_senders', a.p_sender);
    if (!q || !sd || q.workspace_id !== ctx.ws || sd.workspace_id !== q.workspace_id) demoError('E_NOT_FOUND');
    const mimes = ['audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'audio/wav', 'audio/x-wav'];
    if (!mimes.includes(a.p_mime)) demoError('E_PAYLOAD_INVALID', 'unsupported audio type');
    if (Number(a.p_duration ?? 0) > 60) demoError('E_PAYLOAD_INVALID', 'voice notes are limited to 60 seconds');
    if (typeof a.p_path !== 'string' || !a.p_path.startsWith(`${q.workspace_id}/voice/`)) demoError('E_PAYLOAD_INVALID', 'bad storage path');
    store.upsert('outreach_voice_clips', {
      sequence_id: q.id, node_id: String(a.p_node_id), sender_id: sd.id, workspace_id: q.workspace_id, path: a.p_path, mime: a.p_mime,
      duration_s: a.p_duration ?? null, size_bytes: a.p_size ?? null, created_by: ctx.userId, created_at: ctx.now(),
    }, ['sequence_id', 'node_id', 'sender_id']);
    return null;
  },

  sender_today: (a, ctx) => {
    const store = ctx.store;
    const sd = store.get('outreach_senders', a.p_sender);
    if (!sd || sd.workspace_id !== ctx.ws) return {};
    rebuildBudgets(store);
    const day = localParts(Date.now(), sd.timezone ?? 'UTC').day;
    const out: Record<string, { used: number; reserved: number; cap: number }> = {};
    for (const b of store.t('outreach_sender_budgets')) if (b.sender_id === sd.id && b.day === day) out[b.action_type] = { used: b.used, reserved: b.reserved ?? 0, cap: b.cap };
    return out;
  },

  sequence_summary: (a, ctx) => {
    const store = ctx.store;
    if (a.p_ws !== ctx.ws) return [];
    rebuildNodeStats(store);
    const stats = new Map<string, { sent: number; queued: number }>();
    for (const n of store.t('outreach_node_stats')) { const r = stats.get(n.sequence_id) ?? { sent: 0, queued: 0 }; r.sent += n.sent ?? 0; r.queued += n.queued ?? 0; stats.set(n.sequence_id, r); }
    const counts = new Map<string, { live: number; completed: number; replied: number }>();
    for (const e of store.t('outreach_enrollments')) {
      const r = counts.get(e.sequence_id) ?? { live: 0, completed: 0, replied: 0 };
      if (LIVE_SET.has(e.status)) r.live++; else if (e.status === 'completed') r.completed++; else if (e.status === 'exited_replied') r.replied++;
      counts.set(e.sequence_id, r);
    }
    return store.t('outreach_sequences').filter((s) => s.workspace_id === ctx.ws).map((s) => ({
      sequence_id: s.id, ...(counts.get(s.id) ?? { live: 0, completed: 0, replied: 0 }), ...(stats.get(s.id) ?? { sent: 0, queued: 0 }),
    }));
  },

  set_action_text: (a, ctx) => {
    const x = ctx.store.get('outreach_actions', a.p_action);
    if (!x || x.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Action not found');
    if (x.status !== 'queued') return false;
    const text = typeof a.p_text === 'string' ? a.p_text : '';
    const lim = x.action_type === 'invite' ? 300 : x.action_type === 'message' ? 8000 : x.action_type === 'inmail' ? 1900 : x.action_type === 'comment' ? 1250 : 100000;
    if (text.length > lim) demoError('E_PAYLOAD_INVALID', `text exceeds ${lim} characters`);
    const subject = str(a.p_subject);
    ctx.store.update('outreach_actions', x.id, (r) => ({
      payload: { ...(r.payload ?? {}), text, edited_by: ctx.userId, edited_at: ctx.now(), ...(subject ? { subject } : {}), ...(r.action_type === 'email' ? { html: text } : {}), ...(r.action_type === 'invite' ? { note: text } : {}) },
    }));
    const edits = ctx.store.meta<Record<string, Row>>(EDITS_KEY, () => ({}));
    edits[x.id] = { text, subject };
    ctx.store.setMeta(EDITS_KEY, edits);
    return true;
  },

  set_pool: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const pool = asArr(a.p_pool);
    const contacted = a.p_contacted ?? 'keep';
    if (!['keep', 'exit'].includes(contacted)) demoError('E_PAYLOAD_INVALID', 'contacted must be keep or exit');
    if (pool.some((pid) => { const x = store.get('outreach_senders', pid); return !x || x.workspace_id !== s.workspace_id || x.deleted_at; })) demoError('E_SENDER_NOT_IN_POOL', 'sender outside workspace');
    const n = pool.length;
    if (n === 0 && s.status === 'active') demoError('E_POOL_EMPTY', 'The sender pool is empty');
    const removed = (s.sender_pool ?? []).filter((x: string) => !pool.includes(x));
    store.update('outreach_sequences', s.id, { sender_pool: pool, sender_pools: poolsByProvider(store, pool) });
    let moved = 0, exited = 0;
    if (n > 0 && (a.p_rebalance === true || removed.length > 0)) {
      const untouched = untouchedEnrollments(ctx, s.id);
      const target = Math.ceil(untouched.length / n);
      const countOn = (sid: string) => untouchedEnrollments(ctx, s.id).filter((u) => u.sender_id === sid).length;
      const rank = new Map<string, number>();
      const candidates = untouched.filter((u) => { const k = rank.get(u.sender_id) ?? 0; rank.set(u.sender_id, k + 1); return removed.includes(u.sender_id) || (a.p_rebalance === true && k + 1 > target); });
      for (const u of candidates) {
        const lead = u.lead_id;
        const dest = pool.filter((sid) => sid !== u.sender_id && store.get('outreach_senders', sid)?.status !== 'disabled'
          && !store.t('outreach_enrollments').some((e2) => e2.lead_id === lead && e2.sender_id === sid && LIVE_SET.has(e2.status))
          && !store.t('outreach_lead_sender_state').some((h) => h.lead_id === lead && h.sender_id === sid && (h.last_outbound_at || h.invite_sent_at)))
          .sort((x, y) => countOn(x) - countOn(y) || x.localeCompare(y))[0];
        if (!dest) continue;
        if (!removed.includes(u.sender_id) && countOn(dest) >= target) continue;
        for (const x of store.t('outreach_actions')) if (x.enrollment_id === u.id && (x.status === 'queued' || x.status === 'reserved')) { x.status = 'cancelled'; x.decision = 'rebalanced'; }
        engineFor(store).state(lead, dest);
        const provider = store.get('outreach_senders', dest)?.provider;
        store.update('outreach_enrollments', u.id, (r) => ({ sender_id: dest, channel_sender_map: { ...(r.channel_sender_map ?? {}), ...(provider ? { [provider]: dest } : {}) } }));
        moved++;
      }
      engineFor(store).resetIndexes();
    }
    if (contacted === 'exit' && removed.length) {
      for (const e of liveEnrollments(store, s.id).filter((x) => removed.includes(x.sender_id))) { finish(store, e, 'exited_manual', 'sender_removed_from_pool'); exited++; }
    }
    return { pool, moved, exited };
  },

  set_sequence_status: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_id);
    const to = String(a.p_status ?? '');
    let warnings: unknown[] = [];
    if (to === 'active') {
      const pool: string[] = s.sender_pool ?? [];
      if (!pool.length) demoError('E_POOL_EMPTY', 'Add at least one sender to the pool first');
      const notOk = pool.filter((id) => { const x = store.get('outreach_senders', id); return !x || x.status !== 'ok' || x.deleted_at; }).length;
      if (notOk > 0) demoError('E_SENDER_NOT_OK', `${notOk} sender(s) in pool are not connected`);
      warnings = assertValid(store, s.graph, pool, true, s.settings).warnings;
      if (s.status === 'paused') {
        for (const e of store.t('outreach_enrollments')) if (e.sequence_id === s.id && e.status === 'paused' && !e.exit_reason && !e.held_at) store.update('outreach_enrollments', e.id, { status: e.paused_from ?? 'active', paused_from: null });
      }
      store.update('outreach_sequences', s.id, { status: 'active', throttled_reason: null });
      // the leads that are due take their next step now (the simulator carries on from there)
      const before = sentCount(store);
      const now = Date.now();
      for (const e of liveEnrollments(store, s.id)) if (RUNNABLE.has(e.status) && (!e.wait_until || Date.parse(e.wait_until) <= now || e.status === 'waiting_connection')) stepNow(store, e, now);
      if (sentCount(store) > before) ctx.ui.simulated();
    } else if (to === 'paused') {
      for (const e of store.t('outreach_enrollments')) if (e.sequence_id === s.id && ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(e.status)) store.update('outreach_enrollments', e.id, { paused_from: e.status, status: 'paused' });
      store.update('outreach_sequences', s.id, { status: 'paused' });
    } else if (to === 'archived') {
      for (const e of liveEnrollments(store, s.id)) finish(store, e, 'exited_manual', 'sequence_archived');
      store.update('outreach_sequences', s.id, { status: 'archived', archived_at: ctx.now() });
    } else if (to === 'draft') {
      if (liveEnrollments(store, s.id).length) demoError('E_INFLIGHT', 'pause or archive first');
      store.update('outreach_sequences', s.id, { status: 'draft' });
    } else demoError('E_PAYLOAD_INVALID', 'unknown status');
    return { status: to, warnings };
  },

  // outreach_delete_sequence (104): any status, confirmed by the name; live leads exit first, then the cascade hook below
  delete_sequence: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_id);
    const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();
    if (norm(a.p_confirm) !== norm(s.name)) demoError('E_PAYLOAD_INVALID', 'type the sequence name to confirm');
    const leads = new Set(store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id).map((e) => e.lead_id)).size;
    let exited = 0;
    for (const e of liveEnrollments(store, s.id)) { finish(store, e, 'exited_manual', 'sequence_deleted'); exited++; }
    const removed = store.remove('outreach_sequences', (r) => r.id === s.id);
    tableHooks.outreach_sequences?.afterWrite?.('delete', removed, store);
    return { deleted: true, status: s.status, leads, exited };
  },

  skip_action: (a, ctx) => {
    const store = ctx.store;
    const x = store.get('outreach_actions', a.p_action);
    if (!x || x.workspace_id !== ctx.ws) demoError('E_NOT_FOUND', 'Action not found');
    if (x.status !== 'queued') demoError('E_PAYLOAD_INVALID', 'only queued actions can be skipped');
    store.update('outreach_actions', x.id, { status: 'skipped', executed_at: ctx.now(), decision: 'user_skipped', error_code: 'user_skipped' });
    engineFor(store).resetIndexes();
    if (x.enrollment_id && !x.payload?.subtask) {
      const e = store.get('outreach_enrollments', x.enrollment_id);
      if (e && LIVE_SET.has(e.status) && e.current_node_id === x.node_id) {
        const wasPaused = e.status === 'paused';
        advance(store, e, x.node_id, null);
        if (wasPaused) store.update('outreach_enrollments', e.id, (r) => (LIVE_SET.has(r.status) && r.status !== 'paused' ? { paused_from: r.status, status: 'paused' } : {}));
        else {
          const before = sentCount(store);
          stepNow(store, store.get('outreach_enrollments', e.id));
          if (sentCount(store) > before) ctx.ui.simulated();
        }
      }
    }
    return null;
  },

  upsert_lead: (a, ctx) => upsertLeadRpc(ctx, a),

  version_usage: (a, ctx) => {
    const store = ctx.store;
    const s = seqOr404(ctx, a.p_sequence);
    const live = liveEnrollments(store, s.id);
    return store.t('outreach_sequence_versions').filter((v) => v.sequence_id === s.id).sort((x, y) => y.version - x.version).map((v) => ({
      version: v.version, created_at: v.created_at, note: v.note ?? null, publish_mode: v.publish_mode ?? null, is_head: v.version === s.head_version,
      live_leads: live.filter((e) => (e.pinned_version ?? s.head_version) === v.version).length,
    }));
  },
} satisfies RpcArea;

// ---------------------------------------------------------------------------
// rebalance: only leads with nothing sent and no invitation pending can move
// ---------------------------------------------------------------------------
function untouchedEnrollments(ctx: Ctx, seqId: string): Row[] {
  const store = ctx.store;
  const states = new Map(store.t('outreach_lead_sender_state').map((x) => [`${x.lead_id}|${x.sender_id}`, x]));
  const sentBy = new Set(store.t('outreach_actions').filter((x) => (x.status === 'sent' || x.status === 'reserved') && !x.payload?.prefetch).map((x) => x.enrollment_id));
  return store.t('outreach_enrollments').filter((e) => {
    if (e.sequence_id !== seqId || !['active', 'waiting_delay', 'waiting_task', 'paused'].includes(e.status) || e.held_at) return false;
    const st = states.get(`${e.lead_id}|${e.sender_id}`);
    if (st && ((st.relation ?? 'none') !== 'none' || st.last_outbound_at || st.invite_sent_at)) return false;
    return !sentBy.has(e.id);
  }).sort((x, y) => x.id.localeCompare(y.id));
}

// ---------------------------------------------------------------------------
// upsert_lead (026): the leads area's faithful port (match by profile, provider id, emails, identities; merge or create)
// ---------------------------------------------------------------------------
function upsertLeadRpc(ctx: Ctx, a: Args) {
  if (a.p_ws !== ctx.ws) demoError('E_FORBIDDEN', 'Not a member of this workspace');
  const p: Row = a.p_lead && typeof a.p_lead === 'object' ? a.p_lead : {};
  return [upsertLead(ctx.store, ctx.ws, p, str(a.p_source), str(a.p_import_job))];
}

// ---------------------------------------------------------------------------
// table hooks
// ---------------------------------------------------------------------------
let registered = false;
/** Table hooks (insert defaults, side effects) for this area's tables. Called once at boot. */
export function registerSequences(): void {
  installSendOverrides();
  if (registered) return;
  registered = true;
  // deleting a sequence (Sequences list → Delete, a template that failed to save) cascades like the foreign keys do
  const prev = tableHooks.outreach_sequences ?? {};
  tableHooks.outreach_sequences = {
    ...prev,
    afterWrite: (kind, rows, store) => {
      prev.afterWrite?.(kind, rows, store);
      if (kind !== 'delete') return;
      const ids = new Set(rows.map((r) => r.id));
      const enr = new Set(store.t('outreach_enrollments').filter((e) => ids.has(e.sequence_id)).map((e) => e.id));
      store.remove('outreach_sequence_versions', (v) => ids.has(v.sequence_id), { silent: true });
      store.remove('outreach_actions', (x) => !!x.enrollment_id && enr.has(x.enrollment_id), { silent: true });
      store.remove('outreach_tasks', (t) => !!t.enrollment_id && enr.has(t.enrollment_id));
      store.remove('outreach_enrollments', (e) => ids.has(e.sequence_id));
      const rules = new Set(store.t('outreach_auto_enroll_rules').filter((r) => ids.has(r.sequence_id)).map((r) => r.id));
      store.remove('outreach_auto_enroll_log', (l) => rules.has(l.rule_id), { silent: true });
      store.remove('outreach_auto_enroll_rules', (r) => ids.has(r.sequence_id));
      store.remove('outreach_voice_clips', (c) => ids.has(c.sequence_id), { silent: true });
      engineFor(store).resetIndexes();
    },
  };
}
