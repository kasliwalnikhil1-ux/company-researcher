/**
 * One sequence's report (outreach_report_sequence, 013): totals, per-step numbers, best / worst step, A/B blocks and
 * exits. Every count comes from the shared facts (./facts.ts), so a step here shows the same number as the reports
 * page and the dashboard. A/B blocks follow outreach_ab_results (judged on positive replies; invitations on acceptance).
 */
import { EXECUTABLE_TYPES } from '../../../nodes';
import type { DemoStore, Row } from '../store';
import { dayIn, grouped, groupedMetrics, LIVE_ENROLLMENT, MILESTONES, rate, totalsFrom, type Metrics } from './facts';

const STEP_EXTRA = new Set(['wait_connection', 'ab_split', 'ai_route', 'manual_task', 'call_task']);
const NUMBERED_EXTRA = new Set(['manual_task', 'call_task', 'ai_draft_approval']);
const EXECUTABLE = new Set<string>(EXECUTABLE_TYPES);

/** outreach_graph_step_numbers: breadth-first from the start, numbering executable steps and task steps. */
export function stepNumbers(graph: Row | null | undefined): Record<string, number> {
  const res: Record<string, number> = {};
  if (!graph?.nodes) return res;
  const queue: string[] = [graph.start];
  const seen = new Set<string>();
  let i = 0;
  while (queue.length) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);
    const n = graph.nodes[cur];
    if (!n) continue;
    if (EXECUTABLE.has(n.type) || NUMBERED_EXTRA.has(n.type)) res[cur] = ++i;
    if (n.next) queue.push(n.next);
    if (n.branches && typeof n.branches === 'object') for (const v of Object.values(n.branches)) if (typeof v === 'string') queue.push(v);
  }
  return res;
}

/**
 * Everything the step did (outreach_report_sequence adds invites … follows; the demo also counts withdrawals, new chats,
 * unfollows and the other executed types, so a step here always equals the step number the sequence canvas shows).
 */
const NOT_SENT = new Set(['failed', 'skipped', 'manual_reply', 'invite_with_note', 'accepted', 'reply', 'inbound', 'enrolled', 'meeting', 'won', 'lost', 'won_value', 'email_opened', 'email_clicked', 'email_bounced', 'limit_hit', 'block']);
function sentOf(m: Metrics | undefined): number {
  let n = 0;
  for (const [k, v] of Object.entries(m ?? {})) if (!NOT_SENT.has(k) && !k.startsWith('reply_')) n += v;
  return n;
}

export function sequenceReport(store: DemoStore, ws: string, seq: Row, from: string, to: string, tz: string): Row {
  const nodeMetrics = groupedMetrics(store, ws, { from, to, group: 'node', filters: { sequence_id: seq.id } });
  const totals = grouped(store, ws, { from, to, group: 'none', filters: { sequence_id: seq.id } }).get('all') ?? totalsFrom({});
  const nums = stepNumbers(seq.graph);
  const enr = store.t('outreach_enrollments').filter((e) => e.sequence_id === seq.id);
  const steps: Row[] = [];
  for (const [key, node] of Object.entries<Row>(seq.graph?.nodes ?? {})) {
    if (!EXECUTABLE.has(node.type) && !STEP_EXTRA.has(node.type)) continue;
    const m = nodeMetrics.get(`${seq.id}|${key}`);
    const g = m ? totalsFrom(m) : undefined;
    steps.push({
      node_id: key, step_number: nums[key] ?? null, type: node.type, label: node.label || String(node.type).replace(/_/g, ' '),
      sent: sentOf(m), failed: g?.failed ?? 0, skipped: g?.skipped ?? 0, accepted: g?.accepted ?? 0,
      replies: g?.replies ?? 0, interested: g?.interested ?? 0,
      reply_rate: g?.reply_rate ?? null, positive_reply_rate: g?.positive_reply_rate ?? null, acceptance_rate: g?.acceptance_rate ?? null,
      leads_here: enr.filter((e) => e.current_node_id === key && LIVE_ENROLLMENT.includes(e.status)).length,
      failed_here: enr.filter((e) => e.current_node_id === key && e.status === 'failed').length,
    });
  }
  steps.sort((a, b) => (a.step_number ?? Infinity) - (b.step_number ?? Infinity) || String(a.node_id).localeCompare(String(b.node_id)));
  const ranked = steps.filter((s) => s.sent >= 20 && s.reply_rate != null);
  const best = ranked.length ? ranked.reduce((x, y) => (y.reply_rate > x.reply_rate ? y : x)) : null;
  const worst = ranked.length ? ranked.reduce((x, y) => (y.reply_rate < x.reply_rate ? y : x)) : null;
  const distinct = best !== worst;
  const ab: Row[] = [];
  for (const [k, nd] of Object.entries<Row>(seq.graph?.nodes ?? {})) {
    if (nd.type === 'ab_split' || (Array.isArray(nd.config?.variants) && nd.config.variants.length > 1)) ab.push(abResults(store, seq, k, from, to, tz));
  }
  const exits: Record<string, number> = {};
  for (const e of enr) {
    if (!e.completed_at) continue;
    const d = dayIn(Date.parse(e.completed_at), tz);
    if (d < from || d > to) continue;
    const k = `${e.status}${e.exit_reason ? `:${e.exit_reason}` : ''}`;
    exits[k] = (exits[k] ?? 0) + 1;
  }
  return {
    sequence: { id: seq.id, name: seq.name, status: seq.status, head_version: seq.head_version ?? 1, stalled_reason: seq.stalled_reason ?? null },
    period: { from, to, timezone: tz }, totals, steps,
    best_step: distinct ? best : null, worst_step: distinct ? worst : null, ab_tests: ab, exits,
    live: enr.filter((e) => LIVE_ENROLLMENT.includes(e.status)).length,
  };
}

// ---------------------------------------------------------------------------
// A/B results (outreach_ab_results)
// ---------------------------------------------------------------------------
/** Abramowitz–Stegun 7.1.26 (outreach_norm_cdf). */
function normCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return Math.round(0.5 * (1 + Math.sign(z) * erf) * 1e6) / 1e6;
}

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export function abResults(store: DemoStore, seq: Row, nodeId: string, from: string, to: string, tz: string): Row {
  const n: Row | undefined = seq.graph?.nodes?.[nodeId];
  if (!n) throw Object.assign(new Error('E_NOT_FOUND: node'), { code: 'E_NOT_FOUND' });
  const isSplit = n.type === 'ab_split';
  const inRange = (iso: string | null | undefined) => { if (!iso) return false; const d = dayIn(Date.parse(iso), tz); return d >= from && d <= to; };
  const states = new Map(store.t('outreach_lead_sender_state').map((s) => [`${s.lead_id}|${s.sender_id}`, s]));
  const chats = new Map(store.t('outreach_chats').map((c) => [c.id, c]));
  const firstReplyByAction = new Map<string, Row>();
  for (const m of store.t('outreach_messages')) if (m.is_first_reply && m.replied_to_action_id && !firstReplyByAction.has(m.replied_to_action_id)) firstReplyByAction.set(m.replied_to_action_id, m);
  const interestedReply = (m: Row | undefined) => !!m && chats.get(m.chat_id)?.intent === 'interested';
  let rows: Row[];
  let metric: 'accepted' | 'interested';

  if (isSplit) {
    const branches: Row[] = Array.isArray(n.config?.branches) ? n.config.branches : [];
    const labelOf = (id: string) => branches.find((b) => b.id === id)?.label ?? id;
    const enr = store.t('outreach_enrollments').filter((e) => e.sequence_id === seq.id);
    const actionsByEnr = new Map<string, Row[]>();
    for (const a of store.t('outreach_actions')) if (a.enrollment_id) { const l = actionsByEnr.get(a.enrollment_id); if (l) l.push(a); else actionsByEnr.set(a.enrollment_id, [a]); }
    // who went through the split: recorded assignments, else the engine's own pick for every enrollment that acted after it
    const recorded = store.t('outreach_split_assignments').filter((x) => x.sequence_id === seq.id && x.node_id === nodeId);
    const assigned: Array<{ e: Row; branch: string; at: string }> = [];
    if (recorded.length) {
      for (const x of recorded) { const e = enr.find((y) => y.id === x.enrollment_id); if (e) assigned.push({ e, branch: x.branch, at: x.at }); }
    } else {
      const after = reachable(seq.graph, Object.values(n.branches ?? {}).filter((v): v is string => typeof v === 'string'));
      const total = branches.reduce((s, b) => s + Math.max(0, Number(b.weight) || 0), 0) || 1;
      for (const e of enr) {
        const acts = (actionsByEnr.get(e.id) ?? []).filter((a) => after.has(a.node_id));
        if (!acts.length) continue;
        let x = fnv(`${e.id}:${nodeId}`) * total, pick = branches[0]?.id ?? 'a';
        for (const b of branches) { x -= Math.max(0, Number(b.weight) || 0); if (x <= 0) { pick = b.id; break; } }
        const at = acts.map((a) => a.executed_at ?? a.created_at).filter(Boolean).sort()[0] ?? e.created_at;
        assigned.push({ e, branch: pick, at });
      }
    }
    const milestones = store.t(MILESTONES);
    const by = new Map<string, Row>();
    for (const { e, branch, at } of assigned) {
      if (!inRange(at)) continue;
      const r = by.get(branch) ?? { branch, leads: 0, accepted: 0, replies: 0, interested: 0, meetings: 0 };
      r.leads++;
      const st = states.get(`${e.lead_id}|${e.sender_id}`);
      if (st?.invite_accepted_at && st.invite_accepted_at >= e.created_at) r.accepted++;
      const replies = (actionsByEnr.get(e.id) ?? []).map((a) => firstReplyByAction.get(a.id)).filter(Boolean) as Row[];
      if (replies.length) r.replies++;
      if (replies.some(interestedReply)) r.interested++;
      if (milestones.some((m) => m.lead_id === e.lead_id && m.kind === 'meeting' && m.at >= e.created_at)) r.meetings++;
      by.set(branch, r);
    }
    rows = [...by.values()].sort((a, b) => String(a.branch).localeCompare(String(b.branch))).map((b) => ({
      variant_id: b.branch, label: labelOf(b.branch), leads: b.leads, sent: b.leads, accepted: b.accepted, replies: b.replies, interested: b.interested, meetings: b.meetings,
      acceptance_rate: rate(b.accepted, b.leads), reply_rate: rate(b.replies, b.leads), interested_rate: rate(b.interested, b.leads),
    }));
    metric = 'interested';
  } else {
    const variants: Row[] = Array.isArray(n.config?.variants) ? n.config.variants : [];
    const enrIds = new Set(store.t('outreach_enrollments').filter((e) => e.sequence_id === seq.id).map((e) => e.id));
    const by = new Map<string, Row>();
    for (const a of store.t('outreach_actions')) {
      if (!enrIds.has(a.enrollment_id) || a.node_id !== nodeId || a.status !== 'sent' || a.payload?.prefetch === true || !inRange(a.executed_at)) continue;
      const vid = a.variant_id ?? '';
      const r = by.get(vid) ?? { vid, sent: 0, accepted: 0, replies: 0, interested: 0 };
      r.sent++;
      if (a.action_type === 'invite') { const st = states.get(`${a.lead_id}|${a.sender_id}`); if (st?.invite_accepted_at && st.invite_accepted_at >= a.executed_at) r.accepted++; }
      const m = firstReplyByAction.get(a.id);
      if (m) r.replies++;
      if (interestedReply(m)) r.interested++;
      by.set(vid, r);
    }
    rows = [...by.values()].sort((a, b) => String(a.vid).localeCompare(String(b.vid))).map((v) => {
      const def = variants.find((x) => x.id === v.vid);
      return {
        variant_id: v.vid, label: def?.label ?? (v.vid || 'No variant'), weight: def?.weight ?? null, sent: v.sent, accepted: v.accepted, replies: v.replies, interested: v.interested,
        acceptance_rate: rate(v.accepted, v.sent), reply_rate: rate(v.replies, v.sent), interested_rate: rate(v.interested, v.sent),
      };
    });
    metric = n.type === 'send_invite' ? 'accepted' : 'interested';
  }

  const score = (r: Row) => (r.sent > 0 ? r[metric] / r.sent : -1);
  const best = rows.length ? [...rows].sort((a, b) => score(b) - score(a) || b.sent - a.sent)[0] : null;
  const enough = rows.every((r) => r.sent >= 100);
  const out = rows.map((r) => {
    let conf: number | null = null;
    let label: string | null = null;
    if (best && r.variant_id !== best.variant_id && r.sent > 0 && best.sent > 0) {
      const n1 = best.sent, n2 = r.sent, p1 = best[metric] / n1, p2 = r[metric] / n2;
      const pp = (best[metric] + r[metric]) / (n1 + n2);
      const se = Math.sqrt(Math.max(pp * (1 - pp) * (1 / n1 + 1 / n2), 0));
      if (se > 0) conf = Math.round(100 * (2 * normCdf((p1 - p2) / se) - 1) * 10) / 10;
      label = !enough ? 'Not enough data yet' : conf == null ? 'No difference' : conf >= 99 ? 'Very confident' : conf >= 95 ? 'Confident' : conf >= 90 ? 'Likely' : 'No clear difference';
    }
    return { ...r, is_leading: !!best && r.variant_id === best.variant_id, confidence_vs_leader: conf, verdict_vs_leader: label };
  });
  const ok = enough && rows.length >= 2;
  return {
    sequence_id: seq.id, node_id: nodeId, node_type: n.type, judged_on: metric, period: { from, to },
    enough_data: ok, min_sends_per_variant: 100, variants: out, leader: ok ? best?.variant_id ?? null : null,
    can_promote: ok && !isSplit && !out.some((x) => !x.is_leading && (x.confidence_vs_leader ?? 0) < 90),
  };
}

function reachable(graph: Row, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...starts];
  while (queue.length) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const n = graph?.nodes?.[cur];
    if (!n) continue;
    if (n.next) queue.push(n.next);
    if (n.branches) for (const v of Object.values(n.branches)) if (typeof v === 'string') queue.push(v);
  }
  return seen;
}
