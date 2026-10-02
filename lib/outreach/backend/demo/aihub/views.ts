/**
 * The two views of the AI hub (063, as patched by 066), rebuilt from their source tables before a read:
 *   outreach_ai_outputs     Activity: one row per text the AI wrote
 *   outreach_ai_needs_you   Needs you: one row per AI output that waits for a person
 * Like the derived tables of sim/derived.ts they are recomputed whenever the store changed, so they never drift.
 */
import type { DemoStore, Row } from '../store';

let outRev = -1;
let needRev = -1;

const nonEmpty = (t: unknown) => typeof t === 'string' && t.trim() !== '';
const visitorName = (v: Row | undefined) => (v?.name && String(v.name).trim() ? String(v.name).trim() : 'Visitor');

function idx(store: DemoStore, table: string): Map<string, Row> {
  return new Map(store.t(table).map((r) => [r.id, r]));
}

export function rebuildOutputs(store: DemoStore): void {
  if (outRev === store.rev) return;
  outRev = store.rev;
  const chats = idx(store, 'outreach_chats'), seqs = idx(store, 'outreach_sequences'), leads = idx(store, 'outreach_leads');
  const vars = idx(store, 'outreach_ai_variables'), enr = idx(store, 'outreach_enrollments'), inboxes = idx(store, 'outreach_webchat_inboxes');
  const visitors = idx(store, 'outreach_webchat_visitors'), senders = idx(store, 'outreach_senders');
  const out: Row[] = [];
  for (const r of store.t('outreach_ai_reply_runs')) {
    const text = r.final_text ?? r.draft_text;
    const c = chats.get(r.chat_id);
    if (text == null || !c) continue;
    const l = r.lead_id ? leads.get(r.lead_id) : undefined;
    out.push({ id: r.id, workspace_id: r.workspace_id, feature: 'reply', created_at: r.created_at, where_kind: 'sequence', where_id: r.sequence_id ?? null, where_name: seqs.get(r.sequence_id)?.name ?? null, who_kind: 'lead', who_id: r.lead_id ?? null, who_name: l?.full_name ?? c.attendee_name ?? null, who_detail: l?.company ?? null, text, chat_id: r.chat_id });
  }
  for (const v of store.t('outreach_ai_values')) {
    const av = vars.get(v.variable_id);
    if (!av || !nonEmpty(v.text)) continue;
    const l = leads.get(v.lead_id);
    out.push({ id: v.id, workspace_id: v.workspace_id, feature: 'line', created_at: v.generated_at ?? v.updated_at, where_kind: 'variable', where_id: v.variable_id, where_name: av.key, who_kind: 'lead', who_id: v.lead_id, who_name: l?.full_name ?? null, who_detail: l?.company ?? null, text: v.text, chat_id: null });
  }
  for (const t of store.t('outreach_tasks')) {
    if (t.kind !== 'review_ai_draft' || !nonEmpty(t.ai_draft)) continue;
    const e = t.enrollment_id ? enr.get(t.enrollment_id) : undefined;
    const l = t.lead_id ? leads.get(t.lead_id) : undefined;
    out.push({ id: t.id, workspace_id: t.workspace_id, feature: 'draft', created_at: t.created_at, where_kind: 'sequence', where_id: e?.sequence_id ?? null, where_name: e ? seqs.get(e.sequence_id)?.name ?? null : null, who_kind: 'lead', who_id: t.lead_id ?? null, who_name: l?.full_name ?? null, who_detail: l?.company ?? null, text: t.ai_draft, chat_id: t.chat_id ?? null });
  }
  for (const a of store.t('outreach_webchat_ai_turns')) {
    const w = inboxes.get(a.inbox_id);
    if (!w || !nonEmpty(a.answer)) continue;
    const vi = a.visitor_id ? visitors.get(a.visitor_id) : undefined;
    out.push({ id: a.id, workspace_id: a.workspace_id, feature: 'website', created_at: a.created_at, where_kind: 'website', where_id: a.inbox_id, where_name: w.name ?? null, who_kind: 'visitor', who_id: a.visitor_id ?? null, who_name: visitorName(vi), who_detail: vi?.city ?? null, text: a.answer, chat_id: a.chat_id ?? null });
  }
  for (const g of store.t('outreach_webchat_ai_suggestions')) {
    const c = chats.get(g.chat_id), w = inboxes.get(g.inbox_id);
    if (!c || !w || g.text == null) continue;
    const vi = c.visitor_id ? visitors.get(c.visitor_id) : undefined;
    out.push({ id: g.id, workspace_id: g.workspace_id, feature: 'website', created_at: g.ready_at ?? g.created_at, where_kind: 'website', where_id: g.inbox_id, where_name: w.name ?? null, who_kind: 'visitor', who_id: c.visitor_id ?? null, who_name: visitorName(vi), who_detail: vi?.city ?? null, text: g.text, chat_id: g.chat_id });
  }
  for (const p of store.t('outreach_profile_changes')) {
    const text = p.payload?.headline ?? p.payload?.summary;
    const sd = senders.get(p.sender_id);
    if (p.source !== 'ai_draft' || text == null || !sd) continue;
    out.push({ id: p.id, workspace_id: p.workspace_id, feature: 'profile', created_at: p.created_at, where_kind: 'sender', where_id: p.sender_id, where_name: sd.display_name ?? null, who_kind: 'sender', who_id: p.sender_id, who_name: sd.display_name ?? null, who_detail: null, text, chat_id: null });
  }
  store.state.tables.outreach_ai_outputs = out;
}

const ACTIVE = ['debouncing', 'drafting', 'draft_ready', 'scheduled', 'sending'];
export { ACTIVE as ACTIVE_RUN_STATUSES };

export function rebuildNeedsYou(store: DemoStore): void {
  if (needRev === store.rev) return;
  needRev = store.rev;
  const chats = idx(store, 'outreach_chats'), seqs = idx(store, 'outreach_sequences'), leads = idx(store, 'outreach_leads');
  const vars = idx(store, 'outreach_ai_variables'), enr = idx(store, 'outreach_enrollments'), inboxes = idx(store, 'outreach_webchat_inboxes');
  const visitors = idx(store, 'outreach_webchat_visitors'), senders = idx(store, 'outreach_senders'), msgs = idx(store, 'outreach_messages');
  const out: Row[] = [];
  const now = Date.now();
  const runs = store.t('outreach_ai_reply_runs');
  const latestByChat = new Map<string, string>();
  for (const r of runs) { const cur = latestByChat.get(r.chat_id); if (!cur || cur < r.created_at) latestByChat.set(r.chat_id, r.created_at); }
  for (const r of runs) {
    const c = chats.get(r.chat_id);
    if (!c || (r.trigger_kind ?? 'auto') !== 'auto' || c.ai_handed_off_at || c.archived) continue;
    const warm = r.status === 'scheduled' && !!r.timings?.warmup;
    const esc = r.status === 'escalated' && c.last_direction !== 'out' && Date.parse(r.created_at) > now - 30 * 86_400_000 && latestByChat.get(r.chat_id) === r.created_at;
    if (!(r.status === 'draft_ready' || warm || esc)) continue;
    const l = r.lead_id ? leads.get(r.lead_id) : undefined;
    const state = r.status === 'scheduled' ? 'warmup' : (r.status === 'escalated' || r.decision === 'escalate') ? 'escalated' : r.decision === 'no_reply' ? 'no_reply' : 'review';
    const reason = r.status === 'scheduled' ? 'warmup' : (r.status === 'escalated' || r.decision === 'escalate') ? (r.escalation_reasons?.[0] ?? 'escalated')
      : r.decision === 'no_reply' ? 'no_reply' : r.gate_failures?.length ? r.gate_failures[0] : 'review';
    const trigger = (r.inbound_message_ids ?? []).map((id: string) => msgs.get(id)).filter(Boolean)
      .sort((a: Row, b: Row) => String(a.sent_at).localeCompare(String(b.sent_at))).map((m: Row) => m.text ?? m.transcript ?? '[attachment]').join('\n').slice(0, 2000) || null;
    out.push({
      id: r.id, workspace_id: r.workspace_id, type: 'reply', state, where_kind: 'sequence', where_id: r.sequence_id ?? null, where_name: seqs.get(r.sequence_id)?.name ?? null,
      who_kind: 'lead', who_id: r.lead_id ?? null, who_name: l?.full_name ?? c.attendee_name ?? null, who_detail: l?.company ?? null, trigger_text: trigger, ai_text: r.draft_text ?? null,
      reason, assignee_id: c.assigned_to ?? null, created_at: r.updated_at ?? r.created_at, chat_id: r.chat_id, lead_id: r.lead_id ?? null, send_at: r.scheduled_send_at ?? null, priority: 1,
      meta: { status: r.status, decision: r.decision ?? null, mode: r.mode ?? null, provider: c.provider, sender_id: r.sender_id, stop_after_send: !!r.stop_after_send, stop_rule: r.stop_rule ?? null, warnings: r.warnings ?? [] },
    });
  }
  for (const v of store.t('outreach_ai_values')) {
    if (v.status !== 'generated' || !nonEmpty(v.text)) continue;
    const av = vars.get(v.variable_id), l = leads.get(v.lead_id);
    if (!av || !l) continue;
    out.push({
      id: v.id, workspace_id: v.workspace_id, type: 'line', state: 'review', where_kind: 'variable', where_id: v.variable_id, where_name: av.key,
      who_kind: 'lead', who_id: v.lead_id, who_name: l.full_name ?? null, who_detail: l.company ?? null, trigger_text: null, ai_text: v.text, reason: 'review',
      assignee_id: null, created_at: v.generated_at ?? v.updated_at, chat_id: null, lead_id: v.lead_id, send_at: null, priority: 1,
      meta: { variable_name: av.name, fallback: av.fallback ?? '', max_chars: av.max_chars, facts: v.facts ?? [], batch_id: v.batch_id ?? null, title: l.title ?? l.headline ?? null, edited: !!v.edited, output: av.output ?? 'text', fields: av.fields ?? [], data: v.data ?? null },
    });
  }
  for (const t of store.t('outreach_tasks')) {
    if (t.kind !== 'review_ai_draft' || t.completed_at) continue;
    const e = t.enrollment_id ? enr.get(t.enrollment_id) : undefined;
    const l = t.lead_id ? leads.get(t.lead_id) : undefined;
    const st = t.ai_draft == null ? 'drafting' : String(t.ai_draft).trim() === '' ? 'no_draft' : 'review';
    out.push({
      id: t.id, workspace_id: t.workspace_id, type: 'draft', state: st, where_kind: 'sequence', where_id: e?.sequence_id ?? null, where_name: e ? seqs.get(e.sequence_id)?.name ?? null : null,
      who_kind: 'lead', who_id: t.lead_id ?? null, who_name: l?.full_name ?? null, who_detail: l?.company ?? null, trigger_text: t.body ?? null, ai_text: nonEmpty(t.ai_draft) ? String(t.ai_draft).trim() : null,
      reason: st, assignee_id: t.assigned_to ?? null, created_at: t.created_at, chat_id: t.chat_id ?? null, lead_id: t.lead_id ?? null, send_at: null, priority: 1,
      meta: { draft_kind: t.draft_kind ?? null, node_id: t.node_id ?? null, sender_id: t.sender_id ?? null, enrollment_id: t.enrollment_id ?? null, title: t.title ?? null },
    });
  }
  for (const g of store.t('outreach_webchat_ai_suggestions')) {
    if (g.status !== 'waiting') continue;
    const c = chats.get(g.chat_id), w = inboxes.get(g.inbox_id), q = msgs.get(g.message_id);
    if (!c || !w || !q) continue;
    const vi = c.visitor_id ? visitors.get(c.visitor_id) : undefined;
    out.push({
      id: g.id, workspace_id: g.workspace_id, type: 'website', state: 'review', where_kind: 'website', where_id: g.inbox_id, where_name: w.name ?? null,
      who_kind: 'visitor', who_id: c.visitor_id ?? null, who_name: visitorName(vi), who_detail: vi?.city ?? null, trigger_text: q.text ?? null, ai_text: g.text ?? null,
      reason: g.confidence === 'low' ? 'low_confidence' : 'review', assignee_id: c.assigned_to ?? null, created_at: g.ready_at ?? g.created_at, chat_id: g.chat_id, lead_id: c.lead_id ?? null,
      send_at: null, priority: 0, meta: { sources: g.sources ?? [], confidence: g.confidence ?? null, message_id: g.message_id },
    });
  }
  for (const u of store.t('outreach_ai_unanswered_questions')) {
    if (u.status !== 'open') continue;
    const examples = [...(u.examples ?? [])].sort((a: Row, b: Row) => String(b.at).localeCompare(String(a.at))).slice(0, 3);
    out.push({
      id: u.id, workspace_id: u.workspace_id, type: 'question', state: 'open', where_kind: u.sequence_id ? 'sequence' : 'website', where_id: u.sequence_id ?? u.inbox_id ?? null,
      where_name: u.sequence_id ? seqs.get(u.sequence_id)?.name ?? null : inboxes.get(u.inbox_id)?.name ?? null, who_kind: null, who_id: null, who_name: null, who_detail: null,
      trigger_text: u.canonical, ai_text: null, reason: 'unanswered', assignee_id: null, created_at: u.first_seen_at, chat_id: null, lead_id: null, send_at: null, priority: 1,
      meta: { count_total: u.count_total, origins: u.origins ?? ['reply'], last_seen_at: u.last_seen_at, examples },
    });
  }
  for (const p of store.t('outreach_profile_changes')) {
    const text = p.payload?.headline ?? p.payload?.summary;
    const sd = senders.get(p.sender_id);
    if (p.source !== 'ai_draft' || p.status !== 'draft' || text == null || !sd) continue;
    out.push({
      id: p.id, workspace_id: p.workspace_id, type: 'profile', state: 'review', where_kind: 'sender', where_id: p.sender_id, where_name: sd.display_name ?? null,
      who_kind: 'sender', who_id: p.sender_id, who_name: sd.display_name ?? null, who_detail: null, trigger_text: p.note ?? null, ai_text: text, reason: 'review',
      assignee_id: p.requested_by ?? null, created_at: p.created_at, chat_id: null, lead_id: null, send_at: null, priority: 1,
      meta: { field: p.payload && 'headline' in p.payload ? 'headline' : 'about' },
    });
  }
  store.state.tables.outreach_ai_needs_you = out;
}

export function needsYouRows(store: DemoStore): Row[] { rebuildNeedsYou(store); return store.t('outreach_ai_needs_you'); }
export function outputRows(store: DemoStore): Row[] { rebuildOutputs(store); return store.t('outreach_ai_outputs'); }
