'use client';

// AI replies v2 — shared client types, labels, query keys and the inbox hooks.
// Every name and payload here is fixed by docs/outreach/AI-REPLIES-V2-CONTRACT.md (§5 RPCs, §6 edge actions, §7b hook split).
// Sequence-card and settings-page hooks live in lib/outreach/aiRepliesSequence.ts.
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { callFn, rpc } from './api';
import { qk } from './queries';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ReplyMode = 'off' | 'draft' | 'autopilot';
export type RunStatus =
  | 'debouncing' | 'drafting' | 'draft_ready' | 'scheduled' | 'sending' | 'sent'
  | 'escalated' | 'no_reply' | 'superseded' | 'cancelled' | 'failed' | 'expired';
export type Decision = 'send' | 'escalate' | 'no_reply';
export type AutopilotState = 'active' | 'paused_escalated' | 'paused_bot';
export type CancelReason = 'wrong_facts' | 'wrong_tone' | 'too_early_to_pitch' | 'shouldnt_reply' | 'answer_myself' | 'other' | 'dismissed';
/** v2: a prompt belongs to one sequence, or sits in the workspace library. */
export type PromptScope = 'sequence' | 'library';
export type Move = 'answer' | 'ask' | 'relate' | 'insight' | 'pitch' | 'cta' | 'schedule' | 'close' | 'acknowledge';
export type RunTrigger = 'auto' | 'manual';
export type SessionKind = 'normal' | 'returning' | 'dormant';
export type HandoffReason = 'human_replied' | 'meeting_confirmed' | 'calendar_sent' | 'stop_rule' | 'max_replies' | 'stage' | 'booking' | 'manual';
/** Why a chat is in its effective mode (`ChatAiState.reason_code`). */
export type AiReasonCode =
  | 'channel_not_supported' | 'handed_off' | 'no_sequence' | 'off' | 'sequence_paused' | 'sequence_archived' | 'sequence_draft'
  | 'consent_missing' | 'paused_escalated' | 'paused_bot' | (string & {});

export const ACTIVE_STATUSES: RunStatus[] = ['debouncing', 'drafting', 'draft_ready', 'scheduled', 'sending'];

/** A check that did not block a manual draft (Draft with AI) or an Improve / Translate result. */
export interface RunWarning { code: string; text: string }

export interface SideEffect {
  type: 'task' | 'archive' | 'mark_read' | 'set_tag';
  kind?: 'follow_up' | 'contact_referral';
  due?: string | null;
  note?: string | null;
  name?: string | null;
  contact?: string | null;
  tag?: string | null;
}

export interface FactUsed { claim: string; source: string }

export interface RunSummary {
  id: string;
  chat_id: string;
  status: RunStatus;
  decision: Decision | null;
  mode: ReplyMode | null;
  draft_text: string | null;
  final_text: string | null;
  stage_before: string | null;
  stage_after: string | null;
  move: Move | null;
  rule_applied: string | null;
  escalation_reasons: string[];
  gate_failures: string[];
  side_effects: SideEffect[] | null;
  facts_used: FactUsed[] | null;
  draft_confidence: number | null;
  validator: { ok: boolean; failures?: Array<{ rule: string; detail: string }> } | null;
  verifier: { supported: boolean; unsupported_claims: string[]; follows_rule: boolean; answers_their_questions: boolean; note?: string } | null;
  scheduled_send_at: string | null;
  master_prompt_id: string | null;
  master_prompt_version: number | null;
  sent_origin: string | null;
  cancel_reason: string | null;
  cancel_note: string | null;
  flags?: string[] | null;
  intent?: string | null;
  redrafts?: number | null;
  /** v2: who asked for the run and what the model decided about the Stop when rules. */
  trigger: RunTrigger;
  requested_by: string | null;
  guidance: string | null;
  variants?: unknown;
  stop_after_send: boolean;
  stop_rule: string | null;
  scenario_id: string | null;
  scenario_title: string | null;
  gap_days: number | null;
  session_kind: SessionKind | null;
  warnings: RunWarning[];
  created_at: string;
  updated_at: string;
  /** `warmup`: the hold is the sequence's warm-up wait (30–40 min) rather than the normal delay. */
  timings: { inbound_at?: string; drafted_at?: string; scheduled_at?: string; sent_at?: string; warmup?: boolean } | null;
}

export interface RunListItem extends RunSummary {
  sender_id: string;
  lead_id: string | null;
  lead_name: string | null;
  sender_name: string | null;
  sequence_id: string | null;
  sequence_name: string | null;
  inbound_text: string | null;
}

export interface RunDetail extends RunListItem {
  context: {
    thread?: Array<{ from: 'prospect' | 'us' | 'teammate' | 'ai'; text: string; at: string; step?: number | null }>;
    state?: { stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number; stage_stale?: boolean };
    classification?: unknown[];
    lead?: Record<string, unknown>;
  } | null;
  policy_snapshot: Record<string, unknown> | null;
  master_prompt: { id: string; version: number; body: string; editor_mode: 'guided' | 'raw' } | null;
}

export type SequenceStatus = 'draft' | 'active' | 'paused' | 'archived';

/** `ai_reply_chat_state` (042): `outreach__ai_effective` minus policy / settings, plus the chat's stage and runs. */
export interface ChatAiState {
  chat_id: string;
  mode: ReplyMode;
  requested_mode: ReplyMode;
  reason_code: AiReasonCode | null;
  reason: string;
  /** `sequence` when the chat belongs to a sequence (`reply_sequence_id`), else `none`. */
  source: 'sequence' | 'none';
  source_label: string | null;
  can_autopilot: boolean;
  sequence_id: string | null;
  sequence_name: string | null;
  sequence_status: SequenceStatus | null;
  sequence_resumed_at?: string | null;
  handed_off: { at: string; reason: HandoffReason; rule: string | null; run_id: string | null } | null;
  session: { kind: SessionKind; started_at: string | null; count: number };
  autopilot_state: AutopilotState;
  paused_reason: string | null;
  warmup_remaining: number | null;
  returning_after_days?: number;
  dormant_after_days?: number;
  /** Draft with AI on a chat without a sequence prompt: which prompt it falls back to. */
  fallback: null | 'workspace_default' | 'template';
  master_prompt: { id: string; name: string | null; version: number; editor_mode: 'guided' | 'raw'; scope?: PromptScope; sequence_id?: string | null; substantive_version?: number | null } | null;
  /** `{key:'re_engage', label:'Re-engage', position:0}` for a dormant session with no stage yet. */
  stage: { key: string; label: string; position: number; total: number } | null;
  stages: StageDef[];
  exchanges: number;
  ai_replies_count: number;
  max_ai_replies: number;
  lead_notes_summary: string | null;
  run: RunSummary | null;
  last_run: RunSummary | null;
}

// ---------------------------------------------------------------------------
// Draft with AI / compose assist / lead notes (contract §5, §6)
// ---------------------------------------------------------------------------
export interface DraftNowDraft {
  run_id: string;
  text: string | null;
  decision: Decision | null;
  stage_before: string | null;
  stage_after: string | null;
  move: Move | null;
  rule_applied: string | null;
  scenario_id: string | null;
  scenario_title?: string | null;
  facts_used: FactUsed[];
  side_effects: SideEffect[];
  warnings: RunWarning[];
  would_stop: boolean;
  stop_rule: string | null;
  escalation_reasons: string[];
  version: number | null;
  status: RunStatus;
  scheduled_send_at: string | null;
  trigger: RunTrigger;
  guidance: string | null;
  /** An extra variant (temperature 0.7) of the same run. */
  variant?: boolean;
}

export interface DraftNowResult {
  run_id: string;
  source: 'existing_auto' | 'existing_manual' | 'new';
  status: RunStatus;
  prompt: { sequence: string | null; version: number | null; fallback: null | 'workspace_default' | 'template' };
  drafts: DraftNowDraft[];
}

export interface DraftNowInput { chatId: string; guidance?: string | null; variants?: number; regenerate?: boolean }

export type ComposeAssistKind = 'improve' | 'translate_out' | 'translate_in';
export interface ComposeAssistInput { chatId: string; kind: ComposeAssistKind; text?: string; messageId?: string; language?: string | null }
export interface ComposeAssistResult { text: string; language: string | null; warnings: RunWarning[]; cached?: boolean }

export type LeadNoteKey = 'budget' | 'timeline' | 'current_solution' | 'pain' | 'objection' | 'decision_maker' | 'interest' | 'other';
export interface LeadNoteItem {
  id: string;
  key: LeadNoteKey;
  text: string;
  source_message_id: string | null;
  updated_at: string | null;
  edited_by: string | null;
  /** A person edited it: the AI may add new items but never changes this one. */
  locked: boolean;
  history: Array<{ text: string; at: string | null }>;
}
export interface LeadNotes { lead_id: string; summary: string | null; items: LeadNoteItem[]; updated_at: string | null }

export const LEAD_NOTE_KEYS: LeadNoteKey[] = ['budget', 'timeline', 'current_solution', 'pain', 'objection', 'decision_maker', 'interest', 'other'];
export const LEAD_NOTE_LABEL: Record<LeadNoteKey, string> = {
  budget: 'Budget', timeline: 'Timeline', current_solution: 'Current solution', pain: 'Pain', objection: 'Objection', decision_maker: 'Decision maker', interest: 'Interest', other: 'Other',
};

export interface StageDef { key: string; label: string; instructions?: string; early?: boolean; pitch?: boolean }

export interface PromptSettings {
  stages: StageDef[];
  min_exchanges_before_pitch: number;
  skip_to_pitch_when: string[];
  vary_moves_in_early_stages: boolean;
  max_ai_replies_per_chat: number;
  languages: string[];
  allow_language_switch: boolean;
  bot_question: 'escalate' | 'disclose';
  handoff_stage_id: string | null;
  knowledge_source_ids: string[];
  max_length: number;
}

export interface PromptSections { who: string; flow: string; situations: string; handoff: string; facts: string; style: string }

export interface PromptScenario { id: string; master_prompt_id?: string; position: number; title: string; when_text: string; do_text: string; enabled: boolean; updated_at?: string | null }
export interface PromptFaq { id: string; master_prompt_id?: string; question: string; answer: string; source: 'manual' | 'unanswered' | 'import'; enabled: boolean; created_at: string }
export interface PromptKnowledge { id: string; kind: 'website' | 'document' | 'text'; title: string | null; url: string | null; status: 'pending' | 'crawling' | 'ready' | 'error'; chunks: number | null }

/** `master_prompt_get(p_sequence)` (042): the sequence's own prompt, or the library prompt it would copy. */
export interface MasterPrompt {
  exists: boolean;
  id: string | null;
  scope: PromptScope;
  scope_id: string | null;
  scope_label: string | null;
  name: string | null;
  sequence_id: string | null;
  editor_mode: 'guided' | 'raw';
  version: number;
  body: string;
  sections: PromptSections | null;
  settings: PromptSettings;
  substantive_version: number | null;
  updated_at: string | null;
  updated_by_name: string | null;
  scenarios: PromptScenario[];
  faqs: PromptFaq[];
  knowledge: PromptKnowledge[];
  stop_present: boolean;
  situations_text_convertible: boolean;
  template: { editor_mode: 'guided'; body: string; sections: PromptSections; settings: PromptSettings };
}

export interface PromptVersion {
  version: number;
  change_kind: 'style' | 'substantive';
  note: string | null;
  editor_mode: 'guided' | 'raw';
  body: string;
  sections: PromptSections | null;
  settings: PromptSettings;
  scenarios?: PromptScenario[] | null;
  faqs?: PromptFaq[] | null;
  created_at: string;
  created_by_name: string | null;
}

export interface ConsentRow {
  id: string; master_prompt_id: string | null; scope_label: string | null; master_prompt_version: number | null; valid: boolean; needs_reconsent: boolean;
  granted_via: 'signed_link' | 'owner_is_operator'; granted_by_email: string; granted_at: string; expires_at: string;
  scope: { daily_cap: number; delay_min_s: number; delay_max_s: number };
}
export interface ConsentSender {
  sender_id: string; sender_name: string; provider: string; owner_email: string | null; owner_is_me: boolean;
  consents: ConsentRow[];
  pending_links: Array<{ id: string; master_prompt_id: string | null; email: string | null; created_at: string; expires_at: string }>;
}

export interface Graduation {
  eligible: boolean; graduated_at: string | null; bypass: boolean; window_days: number; since_version: number;
  drafts_sent: number; light_edits: number; light_edit_share: number | null; facts_changed: number;
  regression: { total: number; passed: number; last_run_at: string | null };
  requirements: { min_drafts: number; min_share: number };
  missing: string[];
}

export interface MetricsTotals {
  runs: number; sent_ai: number; sent_human_draft: number; escalated: number; no_reply: number; cancelled: number; expired: number;
  failed: number; superseded: number; draft_p50_s: number | null; draft_p95_s: number | null; send_p50_s: number | null;
  light_edit_share: number | null; bot_question_rate: number | null; hold_cancel_rate: number | null;
}
export interface Metrics {
  totals: MetricsTotals;
  groups: Array<MetricsTotals & { key: string; label: string }>;
  escalation_reasons: Array<{ reason: string; n: number }>;
  cancel_reasons: Array<{ reason: string; n: number }>;
}

/** v1.1 regression rows, called **test conversations** in the v2 UI (the v2 "Scenarios" are `PromptScenario` cards). */
export interface Scenario {
  id: string; workspace_id: string; master_prompt_id: string | null; name: string;
  turns: Array<{ from: 'prospect' | 'us'; text: string }>;
  expected: Array<{ after_turn: number; decision: Decision; stage_after?: string | null }>;
  last_result: RegressionResult | null; last_version: number | null; last_run_at: string | null; passed: boolean | null;
  created_at: string; updated_at: string;
}

export interface SimThreadMsg { from: 'prospect' | 'us' | 'teammate' | 'ai'; text: string; at?: string }
export interface SimState { stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number }
export interface DraftPrompt { editor_mode: 'guided' | 'raw'; body: string; sections: PromptSections | null; settings: PromptSettings }

export interface SimulateInput {
  workspace_id: string;
  /** v2: the sequence whose prompt, scenarios, knowledge and lead notes the simulation uses. */
  sequence_id?: string | null;
  sender_id?: string | null;
  lead?: { full_name?: string; title?: string; company?: string; location?: string };
  draft_prompt?: DraftPrompt & { scenarios?: Array<Pick<PromptScenario, 'title' | 'when_text' | 'do_text'> & { id?: string; enabled?: boolean }>; faqs?: Array<Pick<PromptFaq, 'question' | 'answer'>> }; version?: number;
  state?: SimState;
  thread: SimThreadMsg[];
}
export interface SimulateResult {
  decision: Decision; final_decision: Decision; text: string | null;
  stage_before: string | null; stage_after: string | null; move: Move | null; rule_applied: string | null;
  side_effects: SideEffect[]; facts_used: FactUsed[]; confidence: number; escalation_reasons: string[];
  validator: RunSummary['validator']; verifier: RunSummary['verifier'];
  classification: Array<Record<string, unknown>>;
  gates: Array<{ gate: string; ok: boolean; detail?: string }>;
  redrafted: boolean; state_after: SimState; model: string | null; ms: number;
  /** v2 additions (contract §6 simulate); `session` is the session kind the simulated state was in. */
  scenario_id?: string | null; scenario_title?: string | null; would_stop?: boolean; stop_rule?: string | null;
  knowledge_used?: Array<{ id?: string; title?: string | null; url?: string | null; heading?: string | null; text?: string; question?: string }>;
  lead_notes_used?: boolean; session?: SessionKind | (string & {}) | null; unanswered_question?: string | null;
}

export interface RegressionResult {
  total: number; passed: number;
  results: Array<{ scenario_id: string; name: string; passed: boolean; turns: Array<{ after_turn: number; expected: { decision: Decision; stage_after?: string | null }; got: { decision: Decision; stage_after: string | null; text: string | null }; prev_text: string | null; changed: boolean }> }>;
}

export interface Pool { month: string; used: number; limit: number | null; own_key: boolean; ok: boolean }

// ---------------------------------------------------------------------------
// Labels (customer copy — never name the connector vendor)
// ---------------------------------------------------------------------------
export const MODE_LABEL: Record<ReplyMode, string> = { off: 'Off', draft: 'Draft', autopilot: 'Auto' };

/** Why the AI stopped in a chat ("AI handed off · calendar link sent · 2 Oct"). */
export const HANDOFF_LABEL: Record<HandoffReason, string> = {
  human_replied: 'a person replied', meeting_confirmed: 'meeting confirmed', calendar_sent: 'calendar link sent', stop_rule: 'stop rule met',
  max_replies: 'reply limit reached', stage: 'reached the hand-off stage', booking: 'meeting booked', manual: 'stopped by a teammate',
};

/** Warning codes the engine / compose assist return without text of their own. */
export const WARNING_LABEL: Record<string, string> = {
  verifier_unsupported: 'A claim is not backed by your prompt or knowledge', validator: 'The draft broke a rule (link, number, contact or length)',
  validator_link: 'The draft contains a link that is not in your facts', validator_number: 'The draft contains a number that is not in your facts',
  validator_contact: 'The draft contains contact details that are not in your facts', validator_length: 'The draft is longer than your prompt allows',
  new_fact: 'A number or claim was added that is not in your prompt', not_covered: 'Your prompt does not cover this question', low_confidence: 'The AI was not confident about this draft',
  escalate: 'The AI would have handed this to a person', opt_out: 'They asked not to be contacted', floor: 'A safety rule applies to this conversation',
  stage_rule: 'The draft broke a stage rule', meeting_confirmed: 'They confirmed a meeting', calendar_link: 'The draft contains a calendar link',
  language: 'Their language is not in the allowed list', bot_question: 'They asked if this is a bot', injection_suspected: 'Their message looks like an attempt to instruct the AI',
  handed_off: 'AI handed off: this draft is for you to send', no_sequence: 'This chat is not part of a sequence: the workspace default prompt was used', template: 'No prompt yet: the built-in template was used',
};

/** "⚠ text" copy for a warning: the engine's own text first, then the label for its code. */
export function warningText(w: RunWarning | string): string {
  if (typeof w === 'string') return WARNING_LABEL[w] ?? ESCALATION_LABEL[w] ?? humanizeWarning(w);
  const t = (w.text ?? '').trim();
  return t || (WARNING_LABEL[w.code] ?? ESCALATION_LABEL[w.code] ?? humanizeWarning(w.code));
}
function humanizeWarning(code: string): string {
  const s = String(code ?? '').replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Check this draft';
}

/** "Ends the AI conversation when sent (calendar link)". */
export function stopText(stopRule: string | null | undefined): string {
  const rule = (stopRule ?? '').trim();
  return rule ? `Ends the AI conversation when sent (${rule})` : 'Ends the AI conversation when sent';
}

export const SESSION_LABEL: Record<SessionKind, string> = { normal: 'Ongoing', returning: 'Came back', dormant: 'Re-engage' };

export const STATUS_LABEL: Record<RunStatus, string> = {
  debouncing: 'Waiting for them to finish', drafting: 'Drafting', draft_ready: 'Draft ready', scheduled: 'Scheduled',
  sending: 'Sending', sent: 'Sent', escalated: 'Handed to a person', no_reply: 'No reply needed', superseded: 'Replaced by a newer draft',
  cancelled: 'Cancelled', failed: 'Failed', expired: 'Expired',
};

export const CANCEL_REASONS: Array<{ key: Exclude<CancelReason, 'dismissed'>; label: string }> = [
  { key: 'wrong_facts', label: 'Wrong facts' },
  { key: 'wrong_tone', label: 'Wrong tone' },
  { key: 'too_early_to_pitch', label: 'Too early to pitch' },
  { key: 'shouldnt_reply', label: "Shouldn't reply" },
  { key: 'answer_myself', label: "I'll answer myself" },
  { key: 'other', label: 'Other' },
];

export const ESCALATION_LABEL: Record<string, string> = {
  attachment: 'They sent an attachment, voice note or image', language: 'Language not in the allowed list', turn_limit: 'AI reply limit reached for this chat',
  stage: 'Lead is at or past the hand-off stage', vip: 'Lead is tagged VIP / manual only', bot_question: 'They asked if this is a bot',
  injection_suspected: 'Message looks like an attempt to instruct the AI', verifier: 'A claim could not be checked against your prompt',
  validator: 'The draft broke a rule (link, number, contact or length)', stage_rule: 'The draft broke a stage rule twice',
  low_confidence: 'The AI was not confident enough', master_prompt: 'Your master prompt says to hand this over', legal_or_contract: 'Contract, invoice or legal terms',
  hostile: 'They sound upset', complaint: 'They are complaining', model_error: 'The AI could not produce a draft',
};

export const GATE_LABEL: Record<string, string> = {
  G2: 'Group chat', G3: 'They wrote to us first (inbound cold)', G4: 'Lead is blacklisted or do-not-contact', G5: 'Chat archived or autopilot paused',
  G6: 'Sender not connected', G7: 'Their message is older than the stale limit', G11: 'Sender reached its AI send limit today',
  G12: 'Workspace AI allowance used up', G14: 'Lead is in a region that needs a disclosure line', other_sender: 'Another sender is about to reply to the same lead',
};

export const MOVE_LABEL: Record<Move, string> = {
  answer: 'Answer', ask: 'Ask', relate: 'Relate', insight: 'Insight', pitch: 'Pitch', cta: 'Call to action', schedule: 'Schedule', close: 'Close', acknowledge: 'Acknowledge',
};

export const ORIGIN_LABEL: Record<string, string> = {
  ai_autopilot: 'AI · auto', ai_draft_sent: 'AI draft', ai_edited: 'AI draft, edited', external_device: 'Sent from phone',
};

export const FLAG_LABEL: Record<string, string> = {
  asked_offer: 'Asked what we do', pricing: 'Asked the price', meeting_request: 'Asked for a call', meeting_time_proposed: 'Proposed a time',
  explicit_interest: 'Said they are interested', bot_question: 'Asked if this is a bot', legal_or_contract: 'Contract / legal', hostile: 'Hostile',
  complaint: 'Complaint', injection_suspected: 'Instruction attempt', competitor_mentioned: 'Mentioned a competitor', close_only: 'Just closing ("thanks")',
  attachment_mentioned: 'Mentioned an attachment',
};

/** "Stage 2 · Relate", or "Re-engage" for a dormant session (position 0). */
export function stageText(stage: ChatAiState['stage'] | null | undefined): string {
  if (!stage) return 'No stage yet';
  return stage.position > 0 ? `Stage ${stage.position} · ${stage.label}` : stage.label;
}

/** Seconds → "12 min", "45 s", "1 h 5 min". */
export function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h${m % 60 ? ` ${m % 60} min` : ''}`;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
export const aiqk = {
  chatState: (chatId: string) => ['outreach', 'chat', chatId, 'ai-state'] as const,
  leadNotes: (leadId: string) => ['outreach', 'lead', leadId, 'ai-notes'] as const,
  runs: (ws: string, f: unknown) => ['outreach', ws, 'ai-runs', f] as const,
  run: (id: string) => ['outreach', 'ai-run', id] as const,
  versions: (mp: string) => ['outreach', 'ai-prompt-versions', mp] as const,
  consent: (ws: string) => ['outreach', ws, 'ai-consent'] as const,
  graduation: (ws: string, mp: string) => ['outreach', ws, 'ai-graduation', mp] as const,
  metrics: (ws: string, f: unknown) => ['outreach', ws, 'ai-metrics', f] as const,
  cancelReport: (ws: string, days: number) => ['outreach', ws, 'ai-cancel-report', days] as const,
  scenarios: (ws: string, mp: string | null) => ['outreach', ws, 'ai-scenarios', mp] as const,
  pool: (ws: string) => ['outreach', ws, 'ai-pool'] as const,
};

// ---------------------------------------------------------------------------
// Hooks — inbox
// ---------------------------------------------------------------------------
export function useChatAiState(chatId: string | null | undefined) {
  return useQuery({
    queryKey: aiqk.chatState(chatId ?? ''), enabled: !!chatId,
    queryFn: () => rpc<ChatAiState>('ai_reply_chat_state', { p_chat: chatId }),
    // the realtime channel refreshes it on run / chat changes; the poll covers a missed event and the countdown's end
    refetchInterval: 30_000,
  });
}

function useInvalidateChat() {
  const qc = useQueryClient();
  return (chatId: string) => {
    qc.invalidateQueries({ queryKey: aiqk.chatState(chatId) });
    qc.invalidateQueries({ queryKey: qk.chat(chatId) });
    qc.invalidateQueries({ queryKey: qk.messages(chatId) });
  };
}

/** "Stop AI in this chat": hands the chat off (`manual`); the AI never auto-replies in it again until a manager resumes it. */
export function useStopAi() {
  const qc = useQueryClient();
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string }) => rpc<ChatAiState>('chat_ai_stop', { p_chat: a.chatId }),
    onSuccess: (r, a) => { qc.setQueryData(aiqk.chatState(a.chatId), r); inv(a.chatId); qc.invalidateQueries({ queryKey: ['outreach'], predicate: (q) => q.queryKey[2] === 'chats' }); },
  });
}

/** "Resume AI" (manager): clears the handoff and any escalation / bot pause. Audited. */
export function useResumeAi() {
  const qc = useQueryClient();
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string }) => rpc<ChatAiState>('chat_ai_resume', { p_chat: a.chatId }),
    onSuccess: (r, a) => { qc.setQueryData(aiqk.chatState(a.chatId), r); inv(a.chatId); qc.invalidateQueries({ queryKey: ['outreach'], predicate: (q) => q.queryKey[2] === 'chats' }); },
  });
}

/**
 * Draft with AI: runs the auto pipeline on demand and never sends. Without `regenerate` an existing draft_ready / scheduled run
 * comes back as is; with it the pending auto run is cancelled (`taken_manual`) and a new manual run is drafted (contract §6).
 */
export function useDraftNow() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: DraftNowInput) => callFn<DraftNowResult>('ai-reply', {
      action: 'draft_now', chat_id: a.chatId, guidance: a.guidance?.trim() || undefined, variants: a.variants ?? undefined, regenerate: !!a.regenerate,
    }),
    onSuccess: (_r, a) => inv(a.chatId),
    onError: (_e, a) => inv(a.chatId),
  });
}

/** Edit / Regenerate on a scheduled auto run: the send is cancelled first, so there is never a double send. */
export function useTakeManual() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; runId: string }) => callFn<{ ok: boolean; status: RunStatus; changed: boolean }>('ai-reply', { action: 'take_manual', run_id: a.runId }),
    onSuccess: (_r, a) => inv(a.chatId),
  });
}

/** Improve my text / Translate (composer) and Translate under a received message. 1 AI action per call. */
export function useComposeAssist() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: ComposeAssistInput) => callFn<ComposeAssistResult>('ai-reply', {
      action: 'compose_assist', chat_id: a.chatId, kind: a.kind, text: a.text, message_id: a.messageId, language: a.language ?? undefined,
    }),
    onSuccess: (_r, a) => { if (a.kind === 'translate_in') qc.invalidateQueries({ queryKey: qk.messages(a.chatId) }); },
  });
}

export function useLeadNotes(leadId: string | null | undefined) {
  return useQuery({ queryKey: aiqk.leadNotes(leadId ?? ''), enabled: !!leadId, queryFn: () => rpc<LeadNotes>('lead_notes_get', { p_lead: leadId }) });
}

/** Sends the full items list; edited or new items come back locked (the AI may add, never change them). */
export function useUpdateLeadNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { leadId: string; items: Array<Pick<LeadNoteItem, 'key' | 'text'> & { id?: string | null }> }) => rpc<LeadNotes>('lead_notes_update', { p_lead: a.leadId, p_items: a.items }),
    onSuccess: (r, a) => { qc.setQueryData(aiqk.leadNotes(a.leadId), r); qc.invalidateQueries({ queryKey: ['outreach', 'chat'], predicate: (q) => q.queryKey[3] === 'ai-state' }); },
  });
}

export function useCancelRun() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; runId: string; reason: CancelReason; note?: string | null }) => rpc<RunSummary>('ai_reply_cancel', { p_run: a.runId, p_reason: a.reason, p_note: a.note ?? null }),
    onSuccess: (_r, a) => inv(a.chatId),
  });
}

export function useApplyNoReply() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; runId: string }) => rpc<RunSummary>('ai_reply_apply_no_reply', { p_run: a.runId }),
    onSuccess: (_r, a) => inv(a.chatId),
  });
}

export function useSendNow() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; runId: string }) => callFn<{ ok: boolean; message: unknown }>('ai-reply', { action: 'send_now', run_id: a.runId }),
    onSuccess: (_r, a) => inv(a.chatId),
  });
}

// ---------------------------------------------------------------------------
// Hooks — settings
// ---------------------------------------------------------------------------
export function useAiRuns(ws: string | null | undefined, filters: Record<string, unknown>, limit = 50) {
  return useQuery({
    queryKey: aiqk.runs(ws ?? '', { ...filters, limit }), enabled: !!ws,
    queryFn: () => rpc<{ items: RunListItem[]; next_before: string | null }>('ai_reply_runs_list', { p_ws: ws, p_filters: filters, p_limit: limit, p_before: null }),
  });
}

export function useAiRun(id: string | null | undefined) {
  return useQuery({ queryKey: aiqk.run(id ?? ''), enabled: !!id, queryFn: () => rpc<RunDetail>('ai_reply_run_get', { p_run: id }) });
}

// v2 dropped `reply_policy_*`, `ai_reply_set_chat_mode`, `ai_reply_resume_chat(p_chat, p_note)`, `master_prompt_get / save (scope)`,
// `master_prompt_list` and `master_prompt_delete`; their hooks are gone. Sequence prompt hooks live in aiRepliesSequence.ts.

export function usePromptVersions(mp: string | null | undefined) {
  return useQuery({ queryKey: aiqk.versions(mp ?? ''), enabled: !!mp, queryFn: () => rpc<PromptVersion[]>('master_prompt_versions', { p_mp: mp }) });
}

export function useConsent(ws: string | null | undefined) {
  return useQuery({ queryKey: aiqk.consent(ws ?? ''), enabled: !!ws, queryFn: () => rpc<ConsentSender[]>('ai_consent_list', { p_ws: ws }) });
}

/** Consent is per sender in v2 (`master_prompt_id` no longer needed). */
export function useRequestConsent(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { senderId: string }) =>
      callFn<{ granted?: boolean; link?: string; emailed?: boolean; expires_at?: string }>('ai-reply', { action: 'consent_request', workspace_id: ws, sender_id: a.senderId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiqk.consent(ws) }),
  });
}

export function useRevokeConsent(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { consentId: string; reason: string }) => rpc<void>('ai_consent_revoke', { p_consent: a.consentId, p_reason: a.reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiqk.consent(ws) }),
  });
}

export function useGrantOperatorConsent(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { senderId: string }) => rpc<unknown>('ai_consent_grant_operator', { p_sender: a.senderId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiqk.consent(ws) }),
  });
}

export function useGraduation(ws: string | null | undefined, mp: string | null | undefined) {
  return useQuery({ queryKey: aiqk.graduation(ws ?? '', mp ?? ''), enabled: !!ws && !!mp, queryFn: () => rpc<Graduation>('ai_reply_graduation', { p_ws: ws, p_mp: mp }) });
}

export function useAiMetrics(ws: string | null | undefined, from: string, to: string, group: 'none' | 'sequence' | 'sender' | 'stage' | 'master_prompt' | 'client' = 'none') {
  return useQuery({
    queryKey: aiqk.metrics(ws ?? '', { from, to, group }), enabled: !!ws,
    queryFn: () => rpc<Metrics>('ai_reply_metrics', { p_ws: ws, p_from: from, p_to: to, p_group: group }),
  });
}

export function useCancelReport(ws: string | null | undefined, days = 30) {
  return useQuery({
    queryKey: aiqk.cancelReport(ws ?? '', days), enabled: !!ws,
    queryFn: () => rpc<Array<{ rule_applied: string | null; reason: string; n: number; run_ids: string[] }>>('ai_reply_cancel_report', { p_ws: ws, p_days: days }),
  });
}

export function useScenarios(ws: string | null | undefined, mp: string | null = null) {
  return useQuery({ queryKey: aiqk.scenarios(ws ?? '', mp), enabled: !!ws, queryFn: () => rpc<Scenario[]>('ai_reply_scenarios_list', { p_ws: ws, p_mp: mp }) });
}

export function useSaveScenario(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id?: string | null; masterPromptId: string | null; name: string; turns: Scenario['turns']; expected: Scenario['expected'] }) =>
      rpc<Scenario>('ai_reply_scenario_save', { p_ws: ws, p_id: a.id ?? null, p_mp: a.masterPromptId, p_name: a.name, p_turns: a.turns, p_expected: a.expected }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-scenarios'] }),
  });
}

export function useDeleteScenario(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc<void>('ai_reply_scenario_delete', { p_id: id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-scenarios'] }),
  });
}

export function usePool(ws: string | null | undefined) {
  return useQuery({ queryKey: aiqk.pool(ws ?? ''), enabled: !!ws, queryFn: () => rpc<Pool>('ai_reply_pool', { p_ws: ws }) });
}

/** Run the full pipeline on a simulated thread. Never sends, never writes runs. */
export function simulate(input: SimulateInput): Promise<SimulateResult> {
  return callFn<SimulateResult>('ai-reply', { action: 'simulate', ...input });
}

/** Re-run the saved test conversations against the saved (or an unsaved) prompt. */
export function runRegression(input: { workspace_id: string; master_prompt_id?: string | null; sequence_id?: string | null; draft_prompt?: SimulateInput['draft_prompt'] }): Promise<RegressionResult> {
  return callFn<RegressionResult>('ai-reply', { action: 'regression_run', ...input });
}
