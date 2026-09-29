'use client';

// AI replies (ai-auto-reply-PRD.md) — shared client types, labels, query keys and hooks.
// Every name and payload here is fixed by docs/outreach/AI-REPLIES-CONTRACT.md.
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
export type AutopilotState = 'active' | 'paused_human' | 'paused_escalated' | 'paused_bot';
export type CancelReason = 'wrong_facts' | 'wrong_tone' | 'too_early_to_pitch' | 'shouldnt_reply' | 'answer_myself' | 'other' | 'dismissed';
export type PolicyScope = 'workspace' | 'client' | 'sequence' | 'sender';
export type PromptScope = 'workspace' | 'client' | 'sequence';
export type Move = 'answer' | 'ask' | 'relate' | 'insight' | 'pitch' | 'cta' | 'schedule' | 'close' | 'acknowledge';

export const ACTIVE_STATUSES: RunStatus[] = ['debouncing', 'drafting', 'draft_ready', 'scheduled', 'sending'];

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
  created_at: string;
  updated_at: string;
  timings: { inbound_at?: string; drafted_at?: string; scheduled_at?: string; sent_at?: string } | null;
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

export interface ChatAiState {
  chat_id: string;
  mode: ReplyMode;
  requested_mode: ReplyMode;
  source: 'chat' | 'sequence' | 'sender' | 'client' | 'workspace' | 'default';
  source_label: string | null;
  reason_code: string | null;
  reason: string;
  can_autopilot: boolean;
  override: ReplyMode | null;
  autopilot_state: AutopilotState;
  paused_until: string | null;
  paused_reason: string | null;
  stage: { key: string; label: string; position: number; total: number } | null;
  exchanges: number;
  ai_replies_count: number;
  max_ai_replies: number;
  master_prompt: { id: string; scope: PromptScope; version: number; editor_mode: 'guided' | 'raw' } | null;
  run: RunSummary | null;
  last_run: RunSummary | null;
}

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

export interface MasterPrompt {
  exists: boolean;
  id: string | null;
  scope: PromptScope;
  scope_id: string | null;
  scope_label: string | null;
  editor_mode: 'guided' | 'raw';
  version: number;
  body: string;
  sections: PromptSections | null;
  settings: PromptSettings;
  substantive_version: number | null;
  updated_at: string | null;
  updated_by_name: string | null;
  graduated: boolean;
  inherited: { scope: PromptScope; id: string; version: number } | null;
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
  created_at: string;
  created_by_name: string | null;
}

export interface PromptListRow { id: string; scope: PromptScope; scope_id: string | null; scope_label: string; version: number; editor_mode: 'guided' | 'raw'; updated_at: string; graduated_at: string | null; graduation: Graduation | null }

export interface PolicyFields {
  mode: ReplyMode | null;
  delay_min_s: number | null;
  delay_max_s: number | null;
  debounce_quiet_s: number | null;
  debounce_max_s: number | null;
  max_ai_sends_per_sender_day: number | null;
  stale_after_h: number | null;
  human_takeover_pause_h: number | null;
  disclosure: string | null;
  blocked_countries: string[] | null;
}
export interface PolicyRow extends PolicyFields {
  id: string; scope: PolicyScope; scope_id: string | null; scope_label: string;
  downgraded_at: string | null; downgrade_reason: string | null; note: string | null; updated_at: string;
}
export interface PolicyList { defaults: Required<{ [K in keyof PolicyFields]: NonNullable<PolicyFields[K]> | null }>; rows: PolicyRow[] }

export interface ConsentRow {
  id: string; master_prompt_id: string; scope_label: string; master_prompt_version: number; valid: boolean; needs_reconsent: boolean;
  granted_via: 'signed_link' | 'owner_is_operator'; granted_by_email: string; granted_at: string; expires_at: string;
  scope: { daily_cap: number; delay_min_s: number; delay_max_s: number };
}
export interface ConsentSender {
  sender_id: string; sender_name: string; provider: string; owner_email: string | null; owner_is_me: boolean;
  consents: ConsentRow[];
  pending_links: Array<{ id: string; master_prompt_id: string; email: string | null; created_at: string; expires_at: string }>;
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
  scope?: PromptScope; scope_id?: string | null; sender_id?: string | null;
  lead?: { full_name?: string; title?: string; company?: string; location?: string };
  draft_prompt?: DraftPrompt; version?: number;
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
}

export interface RegressionResult {
  total: number; passed: number;
  results: Array<{ scenario_id: string; name: string; passed: boolean; turns: Array<{ after_turn: number; expected: { decision: Decision; stage_after?: string | null }; got: { decision: Decision; stage_after: string | null; text: string | null }; prev_text: string | null; changed: boolean }> }>;
}

export interface Pool { month: string; used: number; limit: number | null; own_key: boolean; ok: boolean }

// ---------------------------------------------------------------------------
// Labels (customer copy — never name the connector vendor)
// ---------------------------------------------------------------------------
export const MODE_LABEL: Record<ReplyMode, string> = { off: 'Off', draft: 'Draft', autopilot: 'Autopilot' };

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
  ai_autopilot: 'AI — autopilot', ai_draft_sent: 'AI draft', ai_edited: 'AI draft, edited', external_device: 'Sent from phone',
};

export const FLAG_LABEL: Record<string, string> = {
  asked_offer: 'Asked what we do', pricing: 'Asked the price', meeting_request: 'Asked for a call', meeting_time_proposed: 'Proposed a time',
  explicit_interest: 'Said they are interested', bot_question: 'Asked if this is a bot', legal_or_contract: 'Contract / legal', hostile: 'Hostile',
  complaint: 'Complaint', injection_suspected: 'Instruction attempt', competitor_mentioned: 'Mentioned a competitor', close_only: 'Just closing ("thanks")',
  attachment_mentioned: 'Mentioned an attachment',
};

/** "Stage 2 · Relate" */
export function stageText(stage: ChatAiState['stage'] | null | undefined): string {
  return stage ? `Stage ${stage.position} · ${stage.label}` : 'No stage yet';
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
  runs: (ws: string, f: unknown) => ['outreach', ws, 'ai-runs', f] as const,
  run: (id: string) => ['outreach', 'ai-run', id] as const,
  policies: (ws: string) => ['outreach', ws, 'ai-policies'] as const,
  prompt: (ws: string, scope: string, scopeId: string | null, version?: number | null) => ['outreach', ws, 'ai-prompt', scope, scopeId, version ?? null] as const,
  prompts: (ws: string) => ['outreach', ws, 'ai-prompts'] as const,
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

export function useSetChatMode() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; mode: ReplyMode | null }) => rpc<ChatAiState>('ai_reply_set_chat_mode', { p_chat: a.chatId, p_mode: a.mode }),
    onSuccess: (_r, a) => inv(a.chatId),
  });
}

export function useResumeChat() {
  const inv = useInvalidateChat();
  return useMutation({
    mutationFn: (a: { chatId: string; note: string }) => rpc<ChatAiState>('ai_reply_resume_chat', { p_chat: a.chatId, p_note: a.note }),
    onSuccess: (_r, a) => inv(a.chatId),
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

export function useReplyPolicies(ws: string | null | undefined) {
  return useQuery({ queryKey: aiqk.policies(ws ?? ''), enabled: !!ws, queryFn: () => rpc<PolicyList>('reply_policy_list', { p_ws: ws }) });
}

export function useSetReplyPolicy(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { scope: PolicyScope; scopeId: string | null; patch: Partial<PolicyFields>; note?: string | null }) =>
      rpc<PolicyRow>('reply_policy_set', { p_ws: ws, p_scope: a.scope, p_scope_id: a.scopeId, p_patch: a.patch, p_note: a.note ?? null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: aiqk.policies(ws) }); qc.invalidateQueries({ queryKey: ['outreach', 'chat'] }); },
  });
}

export function useClearReplyPolicy(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { scope: Exclude<PolicyScope, 'workspace'>; scopeId: string }) => rpc<void>('reply_policy_clear', { p_ws: ws, p_scope: a.scope, p_scope_id: a.scopeId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiqk.policies(ws) }),
  });
}

export function useMasterPrompt(ws: string | null | undefined, scope: PromptScope = 'workspace', scopeId: string | null = null, version: number | null = null) {
  return useQuery({
    queryKey: aiqk.prompt(ws ?? '', scope, scopeId, version), enabled: !!ws,
    queryFn: () => rpc<MasterPrompt>('master_prompt_get', { p_ws: ws, p_scope: scope, p_scope_id: scopeId, p_version: version }),
  });
}

export function useMasterPromptList(ws: string | null | undefined) {
  return useQuery({ queryKey: aiqk.prompts(ws ?? ''), enabled: !!ws, queryFn: () => rpc<PromptListRow[]>('master_prompt_list', { p_ws: ws }) });
}

export function usePromptVersions(mp: string | null | undefined) {
  return useQuery({ queryKey: aiqk.versions(mp ?? ''), enabled: !!mp, queryFn: () => rpc<PromptVersion[]>('master_prompt_versions', { p_mp: mp }) });
}

export interface SavePromptInput {
  scope: PromptScope; scope_id: string | null; editor_mode: 'guided' | 'raw'; body: string; sections: PromptSections | null;
  settings: PromptSettings; change_kind: 'style' | 'substantive'; note?: string | null; base_version?: number | null;
}
export function useSaveMasterPrompt(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: SavePromptInput) => callFn<{ prompt: MasterPrompt; reconsent: { senders: number; links: Array<{ sender_id: string; sender_name: string; url: string }> } }>(
      'ai-reply', { action: 'master_prompt_save', workspace_id: ws, ...a }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-prompt'] });
      qc.invalidateQueries({ queryKey: aiqk.prompts(ws) });
      qc.invalidateQueries({ queryKey: aiqk.consent(ws) });
      qc.invalidateQueries({ queryKey: ['outreach', 'ai-prompt-versions'] });
    },
  });
}

export function useDeleteMasterPrompt(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { scope: Exclude<PromptScope, 'workspace'>; scopeId: string }) => rpc<void>('master_prompt_delete', { p_ws: ws, p_scope: a.scope, p_scope_id: a.scopeId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-prompt'] }); qc.invalidateQueries({ queryKey: aiqk.prompts(ws) }); },
  });
}

export function useConsent(ws: string | null | undefined) {
  return useQuery({ queryKey: aiqk.consent(ws ?? ''), enabled: !!ws, queryFn: () => rpc<ConsentSender[]>('ai_consent_list', { p_ws: ws }) });
}

export function useRequestConsent(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { senderId: string; masterPromptId: string }) =>
      callFn<{ granted?: boolean; link?: string; emailed?: boolean; expires_at?: string }>('ai-reply', { action: 'consent_request', workspace_id: ws, sender_id: a.senderId, master_prompt_id: a.masterPromptId }),
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
    mutationFn: (a: { senderId: string; masterPromptId: string }) => rpc<unknown>('ai_consent_grant_operator', { p_sender: a.senderId, p_mp: a.masterPromptId }),
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

/** Re-run the saved scenarios against the saved (or an unsaved) prompt. */
export function runRegression(input: { workspace_id: string; master_prompt_id?: string | null; scope?: PromptScope; scope_id?: string | null; draft_prompt?: DraftPrompt }): Promise<RegressionResult> {
  return callFn<RegressionResult>('ai-reply', { action: 'regression_run', ...input });
}
