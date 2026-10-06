/**
 * AI replies in the demo: runs (one per inbound burst), the chat's AI state, and the local "engine" that drafts a reply
 * from the conversation (draftReply in ../ai.ts + the seeded Q&A). No model is called: every draft is sample output
 * (`model: 'demo-sample'`).
 *
 *   openRun()       a prospect replied in a chat whose sequence has AI replies on: Review → draft_ready, Auto → scheduled
 *   chatState()     `outreach_ai_reply_chat_state` (also used by the inbox's chat_ai_stop / chat_ai_resume)
 *   attachAi()      watches new messages: our reply in a chat with a waiting draft marks the run sent (or edited);
 *                   a person writing their own answer hands the chat off, as the real engine does
 */
import { draftReply, websiteAnswer } from '../ai';
import { engineFor } from '../sim/engine';
import type { DemoStore, Row } from '../store';
import { DEMO_MODEL, addJob, setSendHook } from './jobs';
import { defaultSettings } from './prompt';
import { ACTIVE_RUN_STATUSES } from './views';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const ACTIVE = ACTIVE_RUN_STATUSES;

// ---------------------------------------------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------------------------------------------
export function runJson(store: DemoStore, r: Row | undefined | null): Row | null {
  if (!r) return null;
  return {
    id: r.id, chat_id: r.chat_id, status: r.status, decision: r.decision ?? null, mode: r.mode ?? null, draft_text: r.draft_text ?? null, final_text: r.final_text ?? null,
    stage_before: r.stage_before ?? null, stage_after: r.stage_after ?? null, move: r.move ?? null, rule_applied: r.rule_applied ?? null,
    escalation_reasons: r.escalation_reasons ?? [], gate_failures: r.gate_failures ?? [], side_effects: r.side_effects ?? [], facts_used: r.facts_used ?? [],
    draft_confidence: r.draft_confidence ?? null, validator: r.validator ?? null, verifier: r.verifier ?? null, scheduled_send_at: r.scheduled_send_at ?? null,
    master_prompt_id: r.master_prompt_id ?? null, master_prompt_version: r.master_prompt_version ?? null, sent_origin: r.sent_origin ?? null,
    cancel_reason: r.cancel_reason ?? null, cancel_note: r.cancel_note ?? null, flags: r.flags ?? [], intent: r.intent ?? null, redrafts: r.redrafts ?? 0,
    trigger: r.trigger_kind ?? 'auto', requested_by: r.requested_by ?? null, guidance: r.guidance ?? null, variants: r.variants ?? null,
    stop_after_send: !!r.stop_after_send, stop_rule: r.stop_rule ?? null, scenario_id: r.scenario_id ?? null,
    scenario_title: r.scenario_id ? store.get('outreach_master_prompt_scenarios', r.scenario_id)?.title ?? null : null,
    gap_days: r.gap_days ?? null, session_kind: r.session_kind ?? null, warnings: r.warnings ?? [], created_at: r.created_at, updated_at: r.updated_at, timings: r.timings ?? {},
  };
}

export function runListItem(store: DemoStore, r: Row): Row {
  const c = store.get('outreach_chats', r.chat_id);
  const l = r.lead_id ? store.get('outreach_leads', r.lead_id) : undefined;
  const inbound = (r.inbound_message_ids ?? []).map((id: string) => store.get('outreach_messages', id)).filter(Boolean) as Row[];
  return {
    ...runJson(store, r), sender_id: r.sender_id, lead_id: r.lead_id ?? null, lead_name: l?.full_name ?? c?.attendee_name ?? null,
    sender_name: store.get('outreach_senders', r.sender_id)?.display_name ?? null, sequence_id: r.sequence_id ?? null,
    sequence_name: r.sequence_id ? store.get('outreach_sequences', r.sequence_id)?.name ?? null : null,
    inbound_text: inbound.map((m) => m.text ?? '[attachment]').join(' / ').slice(0, 300) || null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Effective mode of a chat (`outreach__ai_effective`) and its state
// ---------------------------------------------------------------------------------------------------------------
function reasonText(mode: string, code: string | null, label: string | null): string {
  const m = mode === 'autopilot' ? 'Auto' : mode === 'draft' ? 'Draft' : 'Off';
  const t: Record<string, string> = {
    no_sequence: 'this conversation is not part of a sequence; Draft with AI still works', handed_off: 'handed off to a person',
    channel_not_supported: 'AI replies are LinkedIn only for now', consent_missing: 'the sender has not approved AI replies yet',
    sequence_paused: 'the sequence is paused, replies are drafts', sequence_archived: 'the sequence is archived, replies are drafts',
    sequence_draft: 'the sequence is not live yet, replies are drafts', paused_escalated: 'paused after an upset reply', paused_bot: 'paused, the other side looks automated',
    off: `turned off for ${label ?? 'this sequence'}`,
  };
  return `${m} — ${code && t[code] ? t[code] : `from ${label ?? 'the sequence'}`}`;
}

/** Mirrors migration 079: a sender in the pool replies on Auto, no owner approval. */
export function consentValid(store: DemoStore, senderId: string): boolean {
  void store; void senderId;
  return true;
}

/** The sequence a chat's replies belong to: the chat's own link, else the lead's latest enrollment with that sender. */
export function chatSequence(store: DemoStore, chat: Row): string | null {
  if (chat.reply_sequence_id) return chat.reply_sequence_id;
  if (!chat.lead_id) return null;
  const e = store.t('outreach_enrollments').filter((x) => x.lead_id === chat.lead_id && (!x.sender_id || x.sender_id === chat.sender_id))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return e?.sequence_id ?? null;
}

export function effective(store: DemoStore, chat: Row): Row {
  const wrs = store.get('outreach_workspace_reply_settings', chat.workspace_id, 'workspace_id');
  const seqId = chat.reply_sequence_id ?? null;
  const q = seqId ? store.get('outreach_sequences', seqId) : undefined;
  const srs = seqId ? store.get('outreach_sequence_reply_settings', seqId, 'sequence_id') : undefined;
  let mp = srs?.master_prompt_id ? store.get('outreach_master_prompts', srs.master_prompt_id) : undefined;
  let fallback: string | null = null;
  if (!mp) {
    mp = wrs?.default_prompt_id ? store.get('outreach_master_prompts', wrs.default_prompt_id) : undefined;
    fallback = mp ? 'workspace_default' : 'template';
  }
  const req = srs?.mode ?? 'off';
  let md = req;
  let code: string | null = null;
  const paused = chat.autopilot_state === 'paused_escalated' || chat.autopilot_state === 'paused_bot';
  if (chat.provider !== 'LINKEDIN') { md = 'off'; code = 'channel_not_supported'; }
  else if (chat.ai_handed_off_at) { md = 'off'; code = 'handed_off'; }
  else if (!srs) { md = 'off'; code = 'no_sequence'; }
  else if (req === 'off') code = 'off';
  else if (q && q.status !== 'active') { if (md === 'autopilot') md = 'draft'; code = `sequence_${q.status}`; }
  const ok = consentValid(store, chat.sender_id);
  if (md === 'autopilot') {
    if (!ok) { md = 'draft'; code = 'consent_missing'; }
    else if (paused) { md = 'draft'; code = chat.autopilot_state; }
  }
  const label = q ? `sequence ${q.name}` : null;
  const settings = mp ? { ...defaultSettings(), ...(mp.settings ?? {}), ...(srs ? { min_exchanges_before_pitch: srs.pitch_after_replies, max_ai_replies_per_chat: srs.max_ai_replies_per_chat, handoff_stage_id: srs.handoff_stage_id, languages: srs.languages } : {}) } : null;
  return {
    chat_id: chat.id, mode: md, requested_mode: req, reason_code: code, reason: reasonText(md, code, label),
    source: srs ? 'sequence' : 'none', source_label: label,
    can_autopilot: chat.provider === 'LINKEDIN' && !!srs && !chat.ai_handed_off_at && ok && q?.status === 'active',
    sequence_id: srs?.sequence_id ?? null, sequence_name: q?.name ?? null, sequence_status: q?.status ?? null, sequence_resumed_at: q?.resumed_at ?? null,
    handed_off: chat.ai_handed_off_at ? { at: chat.ai_handed_off_at, reason: chat.ai_handoff_reason, rule: chat.ai_handoff_rule ?? null, run_id: chat.ai_handoff_run_id ?? null } : null,
    session: { kind: chat.ai_session_kind ?? 'normal', started_at: chat.ai_session_started_at ?? null, count: chat.ai_session_count ?? 1 },
    autopilot_state: paused ? chat.autopilot_state : 'active', paused_reason: paused ? chat.autopilot_paused_reason ?? null : null,
    consent_valid: ok, warmup_remaining: srs?.warmup_remaining ?? null,
    returning_after_days: srs?.returning_after_days ?? 3, dormant_after_days: srs?.dormant_after_days ?? 30,
    fallback,
    master_prompt: mp ? { id: mp.id, scope: mp.scope, sequence_id: mp.sequence_id ?? null, name: mp.name ?? null, version: mp.version, substantive_version: mp.substantive_version, editor_mode: mp.editor_mode } : null,
    settings, srs: srs ?? null, mp: mp ?? null,
  };
}

/** `outreach_ai_reply_chat_state`. Exported for the inbox area (chat_ai_stop / chat_ai_resume return it). */
export function chatState(store: DemoStore, chatId: string): Row {
  const c = store.get('outreach_chats', chatId);
  if (!c) throw Object.assign(new Error('E_NOT_FOUND'), { code: 'E_NOT_FOUND' });
  const eff = effective(store, c);
  const stages: Row[] = eff.settings?.stages ?? defaultSettings().stages;
  let stage: Row | null = null;
  if (c.conversation_stage) {
    const i = stages.findIndex((s) => s.key === c.conversation_stage);
    if (i >= 0) stage = { key: c.conversation_stage, label: stages[i].label, position: i + 1, total: stages.length };
    else if (c.conversation_stage === 'closing') stage = { key: 'closing', label: 'Closing', position: stages.length + 1, total: stages.length };
  } else if (c.ai_session_kind === 'dormant') stage = { key: 're_engage', label: 'Re-engage', position: 0, total: stages.length };
  const runs = store.t('outreach_ai_reply_runs').filter((r) => r.chat_id === chatId);
  const act = runs.find((r) => ACTIVE.includes(r.status));
  const last = runs.filter((r) => !ACTIVE.includes(r.status) && r.status !== 'superseded').sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))[0];
  const notes = c.lead_id ? store.get('outreach_lead_ai_notes', c.lead_id, 'lead_id') : undefined;
  const { settings, srs, mp, consent_valid, ...rest } = eff;
  void srs; void mp; void consent_valid;
  return {
    ...rest, stage, exchanges: c.conversation_exchanges ?? 0, ai_replies_count: c.ai_replies_count ?? 0,
    max_ai_replies: Number(settings?.max_ai_replies_per_chat ?? 6), stages, lead_notes_summary: notes?.summary ?? null,
    run: runJson(store, act), last_run: runJson(store, last),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The local drafter
// ---------------------------------------------------------------------------------------------------------------
export function classify(text: string): string {
  const t = text.toLowerCase();
  if (/out of (the )?office|on leave|auto-?reply|travelling|vacation|holiday/.test(t)) return 'ooo';
  if (/not interested|remove me|unsubscribe|all set|we will pass|no thanks|not for us/.test(t)) return 'not_interested';
  if (/not (a priority|now|the right time)|next (quarter|year)|in a (few|couple of) months|revisit|budget is frozen|later/.test(t)) return 'not_now';
  if (/wrong person|not the right person|you should (talk|speak) to|handles this|reach out to/.test(t)) return 'wrong_person';
  if (/call|meet|calendar|slot|tuesday|wednesday|thursday|friday|monday|interested|keen|sounds (good|interesting)|let us set up|happy to chat/.test(t)) return 'interested';
  if (/\?|how |what |does |do you|can you|who /.test(t)) return 'question';
  return 'unclear';
}

const ESCALATE = /contract|invoice|legal|nda|discount|refund|lawyer|terms and conditions/i;

export interface Plan {
  decision: 'send' | 'escalate' | 'no_reply'; text: string | null; intent: string; move: string | null; stage_before: string | null; stage_after: string | null;
  side_effects: Row[]; facts_used: Row[]; escalation_reasons: string[]; rule_applied: string | null; scenario_id: string | null;
  stop_after_send: boolean; stop_rule: string | null; confidence: number; flags: string[]; warnings: Row[];
}

/** Q&A pairs a sequence's replies can use: its prompt's own and the shared library pairs that apply to it. */
export function qaFor(store: DemoStore, sequenceId: string | null, mpId: string | null): Array<{ id: string; question: string; answer: string }> {
  const links = store.t('outreach_knowledge_qa_links');
  return store.t('outreach_master_prompt_faqs').filter((f) => f.enabled !== false && (
    (mpId && f.master_prompt_id === mpId)
    || (!f.master_prompt_id && (!links.some((k) => k.qa_id === f.id) || links.some((k) => k.qa_id === f.id && k.target_kind === 'sequence' && k.target_id === sequenceId)))
  )).map((f) => ({ id: f.id, question: f.question, answer: f.answer }));
}

export function planReply(store: DemoStore, chat: Row, inbound: Row[], opts: { mpId?: string | null; sequenceId?: string | null; guidance?: string | null } = {}): Plan {
  const text = inbound.map((m) => m.text ?? '').join('\n');
  const intent = String(inbound[inbound.length - 1]?.intent ?? classify(text));
  const scen = opts.mpId ? store.t('outreach_master_prompt_scenarios').filter((s) => s.master_prompt_id === opts.mpId && s.enabled !== false) : [];
  const scenario = (title: RegExp) => scen.find((s) => title.test(String(s.title)));
  const stageBefore = chat.conversation_stage ?? 'engage';
  const base: Plan = {
    decision: 'send', text: null, intent, move: 'answer', stage_before: stageBefore, stage_after: stageBefore, side_effects: [], facts_used: [], escalation_reasons: [],
    rule_applied: null, scenario_id: null, stop_after_send: false, stop_rule: null, confidence: 0.86, flags: [], warnings: [],
  };
  if (ESCALATE.test(text)) {
    return { ...base, decision: 'escalate', escalation_reasons: ['legal_or_contract'], flags: ['legal_or_contract'], move: null, confidence: 0.4, rule_applied: 'Hand to a person when: contract, invoice or legal terms' };
  }
  if (intent === 'not_interested') {
    const s = scenario(/not interested/i);
    return { ...base, decision: 'no_reply', move: null, side_effects: [{ type: 'archive' }], scenario_id: s?.id ?? null, rule_applied: s ? `Scenario: ${s.title}` : 'Not interested → don\'t reply. Archive.', confidence: 0.93 };
  }
  if (intent === 'ooo') {
    const s = scenario(/out of office/i);
    return { ...base, decision: 'no_reply', move: null, side_effects: [{ type: 'mark_read' }], scenario_id: s?.id ?? null, rule_applied: s ? `Scenario: ${s.title}` : 'Out-of-office → don\'t reply.', confidence: 0.95 };
  }
  let draft = draftReply(store, chat, { intent, lastText: text });
  let move: string = 'answer', after = stageBefore;
  if (intent === 'question') {
    const ans = websiteAnswer(store, text, qaFor(store, opts.sequenceId ?? null, opts.mpId ?? null));
    if (ans.matched) {
      const lead = chat.lead_id ? store.get('outreach_leads', chat.lead_id) : undefined;
      const name = String(lead?.first_name ?? 'there');
      draft = `Good question, ${name}. ${ans.answer} Would it help to see it on a short call this week?`;
      base.facts_used = [{ claim: ans.answer.slice(0, 120), source: 'Q&A' }];
    }
    after = stageBefore === 'engage' ? 'relate' : 'pitch';
    base.flags = ['asked_offer'];
  } else if (intent === 'interested') {
    move = 'schedule'; after = 'next_step'; base.flags = ['meeting_request'];
    base.stop_after_send = true; base.stop_rule = 'calendar link shared';
    const s = scenario(/meeting/i); base.scenario_id = s?.id ?? null; base.rule_applied = s ? `Scenario: ${s.title}` : null;
  } else if (intent === 'not_now') {
    move = 'close'; base.side_effects = [{ type: 'task', kind: 'follow_up', due: iso(Date.now() + 60 * 86_400_000).slice(0, 10), note: 'Check back as agreed' }];
    const s = scenario(/not now/i); base.scenario_id = s?.id ?? null; base.rule_applied = s ? `Scenario: ${s.title}` : null;
  } else if (intent === 'wrong_person') {
    move = 'ask'; base.side_effects = [{ type: 'task', kind: 'contact_referral', note: 'Reach out to the person they named', contact: null }];
    const s = scenario(/wrong person/i); base.scenario_id = s?.id ?? null; base.rule_applied = s ? `Scenario: ${s.title}` : null;
  } else { move = 'ask'; }
  return { ...base, text: draft, move, stage_after: after };
}

// ---------------------------------------------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------------------------------------------
function mirror(store: DemoStore, chatId: string): void {
  const runs = store.t('outreach_ai_reply_runs').filter((r) => r.chat_id === chatId).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const r = runs.find((x) => ACTIVE.includes(x.status)) ?? runs[0];
  store.update('outreach_chats', chatId, {
    ai_run_id: r?.id ?? null, ai_run_status: r?.status ?? null, ai_run_decision: r?.decision ?? null,
    ai_scheduled_send_at: r?.status === 'scheduled' ? r.scheduled_send_at : null, ai_escalation_reason: r?.status === 'escalated' ? r.escalation_reasons?.[0] ?? null : null,
  });
}

export function updateRun(store: DemoStore, runId: string, patch: Row): Row | undefined {
  const r = store.update('outreach_ai_reply_runs', runId, { ...patch, updated_at: patch.updated_at ?? iso() })[0];
  if (r) mirror(store, r.chat_id);
  return r;
}

/** Opens a run for the chat's latest inbound burst. `mode` = the effective mode (draft | autopilot). */
export function openRun(store: DemoStore, chat: Row, inbound: Row[], o: { mode: string; trigger?: 'auto' | 'manual'; requestedBy?: string | null; guidance?: string | null; at?: number; sequenceId?: string | null } ): Row {
  const seqId = o.sequenceId ?? chat.reply_sequence_id ?? null;
  const srs = seqId ? store.get('outreach_sequence_reply_settings', seqId, 'sequence_id') : undefined;
  const wrs = store.get('outreach_workspace_reply_settings', chat.workspace_id, 'workspace_id');
  const mp = srs?.master_prompt_id ? store.get('outreach_master_prompts', srs.master_prompt_id) : (wrs?.default_prompt_id ? store.get('outreach_master_prompts', wrs.default_prompt_id) : undefined);
  // one pending run per chat: an older one is replaced
  for (const old of store.t('outreach_ai_reply_runs').filter((r) => r.chat_id === chat.id && ACTIVE.includes(r.status))) updateRun(store, old.id, { status: 'superseded', error: 'newer_inbound' });
  const at = o.at ?? Date.now();
  const plan = planReply(store, chat, inbound, { mpId: mp?.id ?? null, sequenceId: seqId, guidance: o.guidance });
  const auto = o.mode === 'autopilot' && (o.trigger ?? 'auto') === 'auto';
  const warm = auto && (srs?.warmup_remaining ?? 0) > 0;
  const delay = warm ? (30 + Math.floor(store.random() * 10)) * 60_000 : ((srs?.delay_min_s ?? 240) + Math.floor(store.random() * ((srs?.delay_max_s ?? 1200) - (srs?.delay_min_s ?? 240)))) * 1000;
  const drafted = at + 40_000 + Math.floor(store.random() * 50_000);
  const status = plan.decision === 'escalate' ? 'escalated' : auto && plan.decision === 'send' ? 'scheduled' : plan.decision === 'no_reply' && auto ? 'no_reply' : 'draft_ready';
  const sendAt = status === 'scheduled' ? drafted + delay : null;
  const lead = chat.lead_id ? store.get('outreach_leads', chat.lead_id) : undefined;
  const r = store.insert('outreach_ai_reply_runs', {
    workspace_id: chat.workspace_id, client_id: chat.client_id ?? null, chat_id: chat.id, sender_id: chat.sender_id, lead_id: chat.lead_id ?? null, sequence_id: seqId,
    provider: chat.provider, inbound_message_ids: inbound.map((m) => m.id), followup_inbound_ids: [], debounce_until: iso(at + 120_000), debounce_hard_until: iso(at + 600_000),
    attempts: 1, send_attempts: 0, next_attempt_at: null, mode: o.mode === 'autopilot' ? 'autopilot' : 'draft', policy_snapshot: { mode: o.mode, delay_min_s: srs?.delay_min_s ?? 240, delay_max_s: srs?.delay_max_s ?? 1200 },
    master_prompt_id: mp?.id ?? null, master_prompt_version: mp?.version ?? null, floor_sha256: null, model: DEMO_MODEL, status, decision: plan.decision,
    intent: ['interested', 'question', 'not_now', 'not_interested', 'ooo', 'wrong_person'].includes(plan.intent) ? plan.intent : 'unclassified',
    flags: plan.flags, language: 'en', stage_before: plan.stage_before, stage_after: plan.stage_after, move: plan.move, rule_applied: plan.rule_applied,
    side_effects: plan.side_effects, draft_confidence: plan.confidence, draft_text: plan.text, final_text: null, facts_used: plan.facts_used,
    validator: { ok: true }, verifier: plan.text ? { supported: true, unsupported_claims: [], follows_rule: true, answers_their_questions: true } : null, redrafts: 0,
    gate_failures: [], escalation_reasons: plan.escalation_reasons,
    context: { thread: threadOf(store, chat.id), state: { stage: plan.stage_before, exchanges: chat.conversation_exchanges ?? 0, last_move: chat.last_ai_move ?? null, ai_replies_count: chat.ai_replies_count ?? 0 }, lead: lead ? { name: lead.full_name, title: lead.title, company: lead.company } : {} },
    scheduled_send_at: sendAt ? iso(sendAt) : null, sent_message_id: null, action_id: null, sent_origin: null, dispatched_by: null, cancelled_by: null, cancel_reason: null, cancel_note: null,
    edit_distance: null, facts_changed: null, reply_latency_s: null, drew_bot_question: false, drew_hostile: false, error: null,
    timings: { inbound_at: iso(at), drafted_at: iso(drafted), ...(sendAt ? { scheduled_at: iso(drafted), warmup: warm } : {}) },
    trigger_kind: o.trigger ?? 'auto', requested_by: o.requestedBy ?? null, requested_via: o.trigger === 'manual' ? 'inbox' : null, guidance: o.guidance ?? null, variants: null,
    stop_after_send: plan.stop_after_send, stop_rule: plan.stop_rule, scenario_id: plan.scenario_id, gap_days: null, session_kind: chat.ai_session_kind ?? 'normal', warnings: plan.warnings,
    created_at: iso(at), updated_at: iso(drafted),
  })[0];
  store.update('outreach_chats', chat.id, (c) => ({
    reply_sequence_id: c.reply_sequence_id ?? seqId, ai_session_started_at: c.ai_session_started_at ?? iso(at), ai_session_kind: c.ai_session_kind ?? 'normal',
    conversation_stage: c.conversation_stage ?? plan.stage_before,
  }));
  mirror(store, chat.id);
  if (status === 'scheduled' && sendAt) addJob(store, { kind: 'send', id: r.id, due: sendAt });
  if (status === 'no_reply') applySideEffects(store, r);
  return r;
}

function threadOf(store: DemoStore, chatId: string): Row[] {
  return store.t('outreach_messages').filter((m) => m.chat_id === chatId && !m.deleted_at).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at))).slice(-6)
    .map((m) => ({ from: m.direction === 'in' ? 'prospect' : m.origin?.startsWith?.('ai_') ? 'ai' : 'us', text: String(m.text ?? '').slice(0, 300), at: m.sent_at }));
}

/** The run's side effects (task, archive, mark read, tag), as `outreach__ai_apply_side_effects` does. */
export function applySideEffects(store: DemoStore, r: Row): void {
  const chat = store.get('outreach_chats', r.chat_id);
  if (!chat) return;
  for (const fx of r.side_effects ?? []) {
    if (fx.type === 'archive') store.update('outreach_chats', chat.id, { archived: true, unread: false, unread_count: 0 });
    else if (fx.type === 'mark_read') store.update('outreach_chats', chat.id, { unread: false, unread_count: 0 });
    else if (fx.type === 'task') {
      store.insert('outreach_tasks', {
        workspace_id: chat.workspace_id, client_id: chat.client_id ?? null, lead_id: chat.lead_id ?? null, chat_id: chat.id, sender_id: chat.sender_id, enrollment_id: null, node_id: null,
        kind: 'follow_up', title: fx.kind === 'contact_referral' ? 'Reach out to the person they named' : 'Follow up as agreed',
        body: fx.note ?? null, due_at: fx.due ? new Date(`${fx.due}T09:00:00Z`).toISOString() : iso(Date.now() + 86_400_000), assigned_to: chat.assigned_to ?? null,
        completed_at: null, completed_by: null, result: null, source: 'ai', ai_draft: null, draft_kind: null,
      });
    }
  }
}

/** Sends a run's text as our message (Auto after the hold, or Send now). */
export function sendRun(store: DemoStore, runId: string, opts: { by?: string | null; origin?: string; text?: string | null } = {}): Row | undefined {
  const r = store.get('outreach_ai_reply_runs', runId);
  if (!r || !['scheduled', 'draft_ready', 'sending'].includes(r.status)) return undefined;
  const chat = store.get('outreach_chats', r.chat_id);
  if (!chat) return undefined;
  const text = opts.text ?? r.draft_text;
  if (!text) return undefined;
  const origin = opts.origin ?? 'ai_autopilot';
  sending.add(chat.id);
  let msg: Row;
  try { msg = engineFor(store).appendMessage(chat, { direction: 'out', text, at: Date.now(), origin, sent_by: opts.by ?? null }); }
  finally { sending.delete(chat.id); }
  markSent(store, r, msg, origin, opts.by ?? null);
  if (origin === 'ai_autopilot') {
    const srs = r.sequence_id ? store.get('outreach_sequence_reply_settings', r.sequence_id, 'sequence_id') : undefined;
    if (srs && (srs.warmup_remaining ?? 0) > 0) store.update('outreach_sequence_reply_settings', (x) => x === srs, { warmup_remaining: srs.warmup_remaining - 1, updated_at: iso() });
  }
  engineFor(store).scheduleProspectAnswer(store.get('outreach_chats', chat.id)!);
  return msg;
}

/**
 * Auto replies whose hold is over go out (what the real worker does when `scheduled_send_at` passes). The job queue
 * runs on real time; this catches the holds the simulator's clock moved past. Returns how many were sent.
 */
export function sendDueHolds(store: DemoStore, now = Date.now()): number {
  let n = 0;
  for (const r of store.t('outreach_ai_reply_runs').filter((x) => x.status === 'scheduled' && x.scheduled_send_at && Date.parse(x.scheduled_send_at) <= now)) {
    if (sendRun(store, r.id)) n++;
  }
  return n;
}

function markSent(store: DemoStore, r: Row, msg: Row, origin: string, by: string | null): void {
  const draft = String(r.draft_text ?? '');
  const dist = editDistance(draft, String(msg.text ?? ''));
  updateRun(store, r.id, {
    status: 'sent', final_text: msg.text, sent_origin: origin, sent_message_id: msg.id, dispatched_by: by, edit_distance: dist, facts_changed: false,
    reply_latency_s: Math.round((Date.now() - Date.parse(r.timings?.inbound_at ?? r.created_at)) / 1000), timings: { ...(r.timings ?? {}), sent_at: msg.sent_at },
  });
  store.update('outreach_messages', msg.id, { origin });
  store.update('outreach_chats', r.chat_id, (c) => ({
    ai_replies_count: (c.ai_replies_count ?? 0) + 1, last_ai_move: r.move ?? c.last_ai_move ?? null, conversation_stage: r.stage_after ?? c.conversation_stage,
    ...(r.stop_after_send ? { ai_handed_off_at: iso(), ai_handoff_reason: 'calendar_sent', ai_handoff_rule: r.stop_rule ?? null, ai_handoff_run_id: r.id } : {}),
  }));
}

/** 0 = the same text, 1 = nothing in common (word level). */
export function editDistance(a: string, b: string): number {
  const wa = a.toLowerCase().split(/\s+/).filter(Boolean), wb = b.toLowerCase().split(/\s+/).filter(Boolean);
  if (!wa.length && !wb.length) return 0;
  const sb = new Set(wb);
  const common = wa.filter((w) => sb.has(w)).length;
  return Math.round((1 - (2 * common) / (wa.length + wb.length)) * 1000) / 1000;
}

// ---------------------------------------------------------------------------------------------------------------
// Watching the conversation
// ---------------------------------------------------------------------------------------------------------------
const attached = new WeakSet<DemoStore>();
const sending = new Set<string>();

export function attachAi(store: DemoStore): void {
  if (attached.has(store)) return;
  attached.add(store);
  setSendHook((s, runId) => {
    const r = s.get('outreach_ai_reply_runs', runId);
    if (!r || r.status !== 'scheduled') return;
    if (Date.parse(r.scheduled_send_at ?? '') > Date.now() + 1000) { addJob(s, { kind: 'send', id: runId, due: Date.parse(r.scheduled_send_at) }); return; }
    sendRun(s, runId);
  });
  store.subscribe((e) => {
    if (e.table !== 'outreach_messages' || e.eventType !== 'INSERT' || !e.new) return;
    const m = e.new;
    if (m.direction !== 'out' || sending.has(m.chat_id) || m.is_invite_note || m.origin === 'sequence') return;
    const r = store.t('outreach_ai_reply_runs').find((x) => x.chat_id === m.chat_id && ['draft_ready', 'scheduled'].includes(x.status));
    if (!r) return;
    queueMicrotask(() => {
      const cur = store.get('outreach_ai_reply_runs', r.id);
      if (!cur || !['draft_ready', 'scheduled'].includes(cur.status)) return;
      const dist = editDistance(String(cur.draft_text ?? ''), String(m.text ?? ''));
      const used = m.origin === 'ai_draft_sent' || m.origin === 'ai_edited' || (cur.draft_text && dist <= 0.6);
      if (used) markSent(store, cur, m, m.origin === 'ai_draft_sent' || m.origin === 'ai_edited' ? m.origin : dist <= 0.02 ? 'ai_draft_sent' : 'ai_edited', m.sent_by ?? null);
      else {
        updateRun(store, cur.id, { status: 'cancelled', cancel_reason: 'answer_myself', cancelled_by: m.sent_by ?? null });
        store.update('outreach_chats', m.chat_id, { ai_handed_off_at: iso(), ai_handoff_reason: 'human_replied', ai_handoff_run_id: cur.id });
      }
    });
  });
}

/** The simulator's reply hook: a prospect answered a sequence message. */
export function onSimReply(store: DemoStore, info: { chat: Row; message: Row; enrollment: Row | undefined }): void {
  attachAi(store);
  const chat = store.get('outreach_chats', info.chat.id) ?? info.chat;
  if (chat.provider !== 'LINKEDIN' || chat.ai_handed_off_at) return;
  const seqId = chat.reply_sequence_id ?? info.enrollment?.sequence_id ?? chatSequence(store, chat);
  if (!seqId) return;
  const srs = store.get('outreach_sequence_reply_settings', seqId, 'sequence_id');
  if (!srs || srs.mode === 'off') return;
  if (!chat.reply_sequence_id) store.update('outreach_chats', chat.id, { reply_sequence_id: seqId });
  const eff = effective(store, store.get('outreach_chats', chat.id)!);
  if (eff.mode === 'off') return;
  openRun(store, store.get('outreach_chats', chat.id)!, [info.message], { mode: eff.mode, sequenceId: seqId, at: Date.parse(info.message.sent_at) || Date.now() });
}
