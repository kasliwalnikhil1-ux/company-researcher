/**
 * Tables the real database keeps as counters, computed here from the rows they count, so every screen agrees:
 *   outreach_node_stats      ← actions, enrollments, replies   (sequence step numbers)
 *   outreach_sender_budgets  ← actions                         (Senders → limits and today's use)
 * They are rebuilt before a read whenever the store changed (`tableHooks.beforeRead`).
 */
import { tableHooks } from '../query';
import type { DemoStore, Row } from '../store';
import { capFor, localParts, METERED } from './caps';
import { LIVE } from './engine';

let nodeRev = -1;
let budgetRev = -1;

export function rebuildNodeStats(store: DemoStore) {
  if (nodeRev === store.rev) return;
  nodeRev = store.rev;
  const seqOf = new Map(store.t('outreach_enrollments').map((e) => [e.id, e.sequence_id]));
  const stats = new Map<string, Row>();
  const row = (seq: string, node: string, variant = '') => {
    const k = `${seq}|${node}|${variant}`;
    let r = stats.get(k);
    if (!r) { r = { sequence_id: seq, node_id: node, variant_id: variant, queued: 0, sent: 0, failed: 0, skipped: 0, accepted: 0, replied: 0, interested: 0, updated_at: new Date().toISOString() }; stats.set(k, r); }
    return r;
  };
  for (const e of store.t('outreach_enrollments')) if (LIVE.includes(e.status) && e.current_node_id) row(e.sequence_id, e.current_node_id).queued++;
  const states = new Map(store.t('outreach_lead_sender_state').map((s) => [`${s.lead_id}|${s.sender_id}`, s]));
  const byAction = new Map<string, Row>();
  for (const a of store.t('outreach_actions')) {
    const seq = a.enrollment_id ? seqOf.get(a.enrollment_id) : null;
    if (!seq || !a.node_id) continue;
    const r = row(seq, a.node_id, a.variant_id ?? '');
    if (a.status === 'sent') r.sent++;
    else if (a.status === 'failed') r.failed++;
    else if (a.status === 'skipped') r.skipped++;
    if (a.status === 'sent' && a.action_type === 'invite') {
      const st = states.get(`${a.lead_id}|${a.sender_id}`);
      if (st?.invite_accepted_at && a.executed_at && st.invite_accepted_at >= a.executed_at) r.accepted++;
    }
    byAction.set(a.id, r);
  }
  const counted = new Set<string>();
  for (const m of store.t('outreach_messages')) {
    if (m.direction !== 'in' || !m.replied_to_action_id || counted.has(m.replied_to_action_id)) continue;
    const r = byAction.get(m.replied_to_action_id);
    if (!r) continue;
    counted.add(m.replied_to_action_id);
    r.replied++;
    if (m.intent === 'interested') r.interested++;
  }
  store.state.tables.outreach_node_stats = [...stats.values()];
}

export function rebuildBudgets(store: DemoStore) {
  if (budgetRev === store.rev) return;
  budgetRev = store.rev;
  const now = Date.now();
  const used = new Map<string, number>();
  const senders = store.t('outreach_senders').filter((s) => !s.deleted_at);
  const tz = new Map(senders.map((s) => [s.id, s.timezone ?? 'UTC']));
  const oldest = now - 14 * 86_400_000;
  for (const a of store.t('outreach_actions')) {
    if (!a.executed_at || !METERED.has(a.action_type) || (a.status !== 'sent' && a.status !== 'reserved')) continue;
    const t = Date.parse(a.executed_at);
    if (t < oldest) continue;
    const k = `${a.sender_id}|${localParts(t, tz.get(a.sender_id) ?? 'UTC').day}|${a.action_type}`;
    used.set(k, (used.get(k) ?? 0) + 1);
  }
  const rows: Row[] = [];
  for (const s of senders) {
    const today = localParts(now, s.timezone ?? 'UTC').day;
    const types = s.provider === 'LINKEDIN' ? ['invite', 'message', 'profile_view', 'like', 'withdraw', 'inmail', 'new_chat']
      : s.provider === 'INSTAGRAM' ? ['follow', 'like', 'message', 'new_chat', 'profile_view', 'comment']
        : s.provider === 'WHATSAPP' ? ['message', 'new_chat', 'identifier_check'] : ['email'];
    for (const type of types) rows.push({ sender_id: s.id, day: today, action_type: type, cap: capFor(store, s, type), used: used.get(`${s.id}|${today}|${type}`) ?? 0, reserved: 0 });
    for (const [k, v] of used) {
      const [sid, day, type] = k.split('|');
      if (sid !== s.id || day === today) continue;
      rows.push({ sender_id: s.id, day, action_type: type, cap: Math.max(v, capFor(store, s, type)), used: v, reserved: 0 });
    }
  }
  store.state.tables.outreach_sender_budgets = rows;
}

export function registerDerivedTables() {
  tableHooks.outreach_node_stats = { ...(tableHooks.outreach_node_stats ?? {}), beforeRead: rebuildNodeStats };
  tableHooks.outreach_sender_budgets = { ...(tableHooks.outreach_sender_budgets ?? {}), beforeRead: rebuildBudgets };
}
