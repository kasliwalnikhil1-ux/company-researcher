/**
 * Demo handlers: Sequences, versions, publishing, enrolment, enrollments, queued actions, A/B results, auto-enrol rules, tasks.
 * Owns: ab_results, complete_task, create_sequence, delete_auto_enroll_rule, discard_draft, enroll_leads, enroll_preview, enrollment_recover, exit_enrollment, failed_leads, move_to_latest, node_queued_actions, pause_enrollment, project_sequence, promote_variant, publish_impact, publish_sequence, rebalance_preview, render_context, reschedule_action, resume_enrollment, rule_match_count, save_auto_enroll_rule, save_draft, save_sequence, save_voice_clip, sender_today, sequence_summary, set_action_text, set_pool, set_sequence_status, skip_action, upsert_lead, version_usage
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
import { engineFor } from '../sim/engine';
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
    const enr = new Map(store.t('outreach_enrollments').filter((e) => e.sequence_id === s.id).map((e) => [e.id, e]));
    const lead = (id: string) => store.get('outreach_leads', id);
    const sender = (id: string) => store.get('outreach_senders', id);
    if (a.p_kind === 'skipped') {
      const rows = store.t('outreach_actions').filter((x) => x.status === 'skipped' && x.enrollment_id && enr.has(x.enrollment_id) && (!node || x.node_id === node) && !x.payload?.prefetch && !x.payload?.subtask)
        .sort((x, y) => String(y.executed_at ?? '').localeCompare(String(x.executed_at ?? '')));
      return rows.slice(offset, offset + limit).map((x) => {
        const e = enr.get(x.enrollment_id)!; const l = lead(e.lead_id); const sd = sender(x.sender_id);
        return { enrollment_id: e.id, lead_id: e.lead_id, lead_name: l?.full_name ?? null, company: l?.company ?? null, sender_id: x.sender_id, sender_name: sd?.display_name ?? null, node_id: x.node_id, error_code: x.error_code ?? null, reason: reasonText(x.error_code), at: x.executed_at ?? null, recoverable: false };
      }).filter((r) => r.lead_name !== undefined);
    }
    const failedAction = (eid: string) => store.t('outreach_actions').filter((x) => x.enrollment_id === eid && x.status === 'failed').sort((x, y) => String(y.executed_at ?? '').localeCompare(String(x.executed_at ?? '')))[0];
    const rows = [...enr.values()].filter((e) => e.status === 'failed' && (!node || e.current_node_id === node)).sort((x, y) => String(y.completed_at ?? '').localeCompare(String(x.completed_at ?? '')));
    return rows.slice(offset, offset + limit).map((e) => {
      const l = lead(e.lead_id); const sd = sender(e.sender_id); const fa = failedAction(e.id);
      const code = fa?.error_code ?? e.exit_reason ?? null;
      return { enrollment_id: e.id, lead_id: e.lead_id, lead_name: l?.full_name ?? null, company: l?.company ?? null, sender_id: e.sender_id, sender_name: sd?.display_name ?? null, node_id: e.current_node_id, error_code: code, reason: reasonText(code), at: e.completed_at ?? null, recoverable: !!l && !(l.do_not_contact || l.unsubscribed) && (fa?.decision ?? '') !== 'mark_lead_invalid' };
    });
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
