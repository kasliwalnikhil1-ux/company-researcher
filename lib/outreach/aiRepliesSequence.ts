'use client';

// AI replies v2 (docs/outreach/AI-REPLIES-V2-CONTRACT.md §5–§7b): the sequence-card hooks (settings, prompt, scenarios,
// Q&A, knowledge, unanswered questions, simulate, test conversations) and the settings-page hooks (workspace defaults,
// library prompts, consent list). The inbox hooks and the shared v1.1 types stay in ./aiReplies.ts.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { db } from '@/lib/outreach/backend';
import { callFn, parseError, rpc } from './api';
import type {
  Decision, FactUsed, MasterPrompt, Metrics, PromptSections, PromptSettings, PromptVersion, RegressionResult, ReplyMode,
  RunDetail, RunListItem, Scenario, SimState, SimThreadMsg, SimulateResult,
} from './aiReplies';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** v2 guided sections: the Situations text stays for prompts that were never converted to cards; `stop` is new. */
export interface PromptSectionsV2 extends PromptSections { stop: string }

export interface ScenarioCard { id: string; position: number; title: string; when_text: string; do_text: string; enabled: boolean; updated_at?: string | null }
export interface ScenarioDraft { id?: string | null; title: string; when_text: string; do_text: string; enabled: boolean }

export interface Faq { id: string; question: string; answer: string; source: 'manual' | 'unanswered' | 'import'; enabled: boolean; created_at: string }

export type KnowledgeStatus = 'pending' | 'crawling' | 'ready' | 'error';
export interface KnowledgeRef {
  id: string; kind: 'website' | 'document' | 'text'; title: string; url: string | null; status: KnowledgeStatus; error: string | null;
  pages: number | null; chunks: number | null; crawled_at: string | null;
}
/** A row of the workspace's library. 'catalogue' = a product catalogue (migration 068): websites use it, a sequence never does. */
export interface KnowledgeSource extends Omit<KnowledgeRef, 'kind'> {
  kind: KnowledgeRef['kind'] | 'catalogue';
  storage_path: string | null; content_type: string | null; refresh_days: number | null; created_at: string; updated_at: string | null; used_by: number;
}

export interface PromptTemplateV2 { editor_mode: 'guided'; body: string; sections: PromptSectionsV2; settings: PromptSettings; scenarios: ScenarioDraft[] }

/** master_prompt_get / library_get / update / copy shape. */
export interface MasterPromptV2 extends Omit<MasterPrompt, 'scope' | 'sections' | 'template' | 'inherited'> {
  scope: 'sequence' | 'library';
  name: string | null;
  sequence_id: string | null;
  sections: PromptSectionsV2 | null;
  current_version: number;
  copied_from_prompt_id: string | null;
  copied_from_version: number | null;
  scenarios: ScenarioCard[];
  faqs: Faq[];
  knowledge: KnowledgeRef[];
  knowledge_source_ids: string[];
  stop_present: boolean;
  situations_text_convertible: boolean;
  template: PromptTemplateV2;
  inherited: null;
}

export interface PromptVersionV2 extends PromptVersion { scenarios: ScenarioCard[]; faqs: Faq[] }

export type SenderConsentState = 'granted' | 'pending' | 'missing';
export interface SequenceSender {
  sender_id: string; sender_name: string | null; owner_email: string | null; owner_is_me: boolean;
  consent: SenderConsentState; consent_id: string | null; granted_via: string | null; pending_link_id: string | null; pending_link_expires_at: string | null;
}

export interface StageCount { stage: string; label: string; n: number }

/** sequence_ai_replies_get. */
export interface SequenceAiSettings {
  sequence_id: string; sequence_name: string; sequence_status: 'draft' | 'active' | 'paused' | 'archived';
  mode: ReplyMode; effective_mode: ReplyMode; master_prompt_id: string; prompt: MasterPromptV2;
  pitch_after_replies: number; max_ai_replies_per_chat: number; warmup_remaining: number; handoff_stage_id: string | null;
  delay_min_s: number; delay_max_s: number; debounce_quiet_s: number; debounce_max_s: number; stale_after_h: number;
  languages: string[]; disclosure: string | null; blocked_countries: string[] | null; blocked_countries_default: string[];
  returning_after_days: number; dormant_after_days: number; inactivity_days: number | null;
  downgraded_at: string | null; downgrade_reason: string | null; updated_at: string | null;
  senders: SequenceSender[]; workspace_cap: number | null;
  open_conversations: number; open_by_stage: StageCount[]; handed_off_7d: number; handed_off_open: number; drafts_waiting: number; unanswered_open: number;
}

export interface SequenceAiSummary { mode: ReplyMode; effective_mode: ReplyMode; warmup_remaining: number; downgraded_at: string | null; open_conversations: number; open_by_stage: StageCount[]; handed_off_7d: number; handed_off_open: number; drafts_waiting: number; unanswered_open: number }

export interface SequenceAiPatch {
  mode?: ReplyMode; pitch_after_replies?: number; max_ai_replies_per_chat?: number; handoff_stage_id?: string | null;
  delay_min_s?: number; delay_max_s?: number; debounce_quiet_s?: number; debounce_max_s?: number; stale_after_h?: number;
  languages?: string[]; disclosure?: string | null; blocked_countries?: string[] | null; returning_after_days?: number; dormant_after_days?: number; inactivity_days?: number | null;
}

export interface ConsentRequested { sender_id: string; sender_name: string | null; emailed: boolean; link?: string | null }
export interface AiRepliesSetResult { settings: SequenceAiSettings & { applies_to?: number; demoted?: number }; consent: { granted: string[]; requested: ConsentRequested[] } }

export interface UnansweredExample { run_id: string | null; chat_id: string | null; message_id: string | null; text: string; at: string }
export interface UnansweredGroup {
  id: string; canonical: string; count_total: number; count_30d: number; first_seen_at: string; last_seen_at: string;
  status: 'open' | 'answered' | 'dismissed'; examples: UnansweredExample[]; answered_faq_id: string | null; dismissed_reason: string | null;
}

export interface WorkspaceReplySettings { workspace_id: string; max_ai_sends_per_sender_day: number; default_prompt_id: string | null; default_prompt_name: string | null; updated_at: string | null }
export interface LibraryPromptRow { id: string; name: string; version: number; editor_mode: 'guided' | 'raw'; updated_at: string; is_default: boolean; used_by: number }

/** ai_consent_list (one consent per sender). */
export interface ConsentSenderV2 {
  sender_id: string; sender_name: string | null; provider: string; owner_email: string | null; owner_is_me: boolean;
  consent: { id: string; valid: boolean; granted_via: 'signed_link' | 'owner_is_operator'; granted_by_email: string | null; granted_at: string; expires_at: string; scope: { daily_cap?: number; grant?: string } | null } | null;
  pending_link: { id: string; email: string | null; created_at: string; expires_at: string } | null;
  sequences_on_auto: Array<{ id: string; name: string }>;
  ai_sent_7d: number;
}

/** What the simulator and the drafter get when testing unsaved edits. */
export interface DraftPromptV2 { editor_mode: 'guided' | 'raw'; body: string; sections: PromptSectionsV2 | null; settings: PromptSettings; scenarios?: ScenarioDraft[]; faqs?: Array<{ id?: string | null; question: string; answer: string }> }

export interface SimulateInputV2 {
  workspace_id: string; sequence_id?: string | null; sender_id?: string | null;
  lead?: { full_name?: string; title?: string; company?: string; location?: string };
  draft_prompt?: DraftPromptV2; version?: number | null; state?: SimState; thread: SimThreadMsg[];
}
export interface KnowledgeUsed { title: string | null; url: string | null; heading: string | null; text: string }
/** v1.1 result plus the v2 fields (optional so a plain SimulateResult still fits). */
export interface SimulateResultV2 extends SimulateResult {
  scenario_id?: string | null; scenario_title?: string | null; would_stop?: boolean; stop_rule?: string | null;
  knowledge_used?: KnowledgeUsed[]; faqs_used?: string[]; lead_notes_used?: boolean; session?: string | null; unanswered_question?: string | null;
}
export interface RegressionInput { sequence_id?: string | null; master_prompt_id?: string | null; draft_prompt?: DraftPromptV2 }

/** Run fields added in v2 (RunSummary as v1.1 plus these). */
export interface RunV2Fields {
  trigger?: 'auto' | 'manual' | null; requested_by?: string | null; guidance?: string | null; stop_after_send?: boolean; stop_rule?: string | null;
  scenario_id?: string | null; scenario_title?: string | null; gap_days?: number | null; session_kind?: 'normal' | 'returning' | 'dormant' | null;
  warnings?: Array<{ code?: string; text?: string } | string>;
}
export type RunListItemV2 = RunListItem & RunV2Fields;
export type RunDetailV2 = RunDetail & RunV2Fields;

export interface MetricsV2 extends Metrics { handed_off?: number; handoff_reasons?: Array<{ reason: string; n: number }> }
export type MetricsGroup = 'none' | 'sequence' | 'sender' | 'stage' | 'master_prompt' | 'client' | 'trigger' | 'scenario';

export interface Pool { month: string; used: number; limit: number | null; own_key: boolean; ok: boolean }

// ---------------------------------------------------------------------------
// Labels (customer copy never names the connector vendor; mode labels are Off · Review · Auto, `draft` is stored)
// ---------------------------------------------------------------------------
export const MODE_LABEL_V2: Record<ReplyMode, string> = { off: 'Off', draft: 'Review', autopilot: 'Auto' };
export const MODES: ReplyMode[] = ['off', 'draft', 'autopilot'];

export const HANDOFF_REASON_LABEL: Record<string, string> = {
  human_replied: 'A person replied', meeting_confirmed: 'Meeting confirmed', calendar_sent: 'Calendar link sent', stop_rule: 'A Stop rule was met',
  max_replies: 'Reply limit reached', stage: 'Lead reached the hand-off stage', booking: 'Booking received', manual: 'Stopped by a person',
};

export const SESSION_LABEL: Record<string, string> = { normal: 'Normal', returning: 'Returning', dormant: 'Dormant (Re-engage)' };

export const KNOWLEDGE_STATUS_LABEL: Record<KnowledgeStatus, string> = { pending: 'Waiting', crawling: 'Reading', ready: 'Ready', error: 'Failed' };

/** Text of a run warning ({code, text} or a plain string). */
export function warningText(w: { code?: string; text?: string } | string): string {
  if (typeof w === 'string') return w;
  return w.text || w.code || '';
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
export const aisqk = {
  seqSettings: (seq: string) => ['outreach', 'sequence', seq, 'ai-replies'] as const,
  seqSummary: (seq: string) => ['outreach', 'sequence', seq, 'ai-summary'] as const,
  unanswered: (seq: string, status: string) => ['outreach', 'sequence', seq, 'ai-unanswered', status] as const,
  versions: (mp: string) => ['outreach', 'ai-prompt-versions', mp] as const,
  library: (ws: string) => ['outreach', ws, 'ai-library'] as const,
  libraryPrompt: (id: string) => ['outreach', 'ai-library-prompt', id] as const,
  knowledge: (ws: string) => ['outreach', ws, 'ai-knowledge'] as const,
  wsSettings: (ws: string) => ['outreach', ws, 'ai-workspace-settings'] as const,
  consent: (ws: string) => ['outreach', ws, 'ai-consent'] as const,
  tests: (ws: string, mp: string | null) => ['outreach', ws, 'ai-scenarios', mp] as const,
  runs: (ws: string, f: unknown) => ['outreach', ws, 'ai-runs', f] as const,
  run: (id: string) => ['outreach', 'ai-run', id] as const,
  metrics: (ws: string, f: unknown) => ['outreach', ws, 'ai-metrics', f] as const,
  cancelReport: (ws: string, days: number) => ['outreach', ws, 'ai-cancel-report', days] as const,
  pool: (ws: string) => ['outreach', ws, 'ai-pool'] as const,
};

// ---------------------------------------------------------------------------
// Sequence card: settings
// ---------------------------------------------------------------------------
export function useSequenceAiReplies(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: aisqk.seqSettings(sequenceId ?? ''), enabled: !!sequenceId,
    queryFn: () => rpc<SequenceAiSettings>('sequence_ai_replies_get', { p_sequence: sequenceId }),
  });
}

export function useSequenceAiSummary(sequenceId: string | null | undefined) {
  return useQuery({
    queryKey: aisqk.seqSummary(sequenceId ?? ''), enabled: !!sequenceId, staleTime: 30_000,
    queryFn: () => rpc<SequenceAiSummary>('sequence_ai_summary', { p_sequence: sequenceId }),
  });
}

/** Everything about one sequence's AI replies changed: refetch the card, the badge and the versions. */
export function useInvalidateSequenceAi(sequenceId: string) {
  const qc = useQueryClient();
  return (mp?: string | null) => {
    qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    qc.invalidateQueries({ queryKey: aisqk.seqSummary(sequenceId) });
    if (mp) qc.invalidateQueries({ queryKey: aisqk.versions(mp) });
  };
}

export function useSetSequenceAiReplies(sequenceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { patch: SequenceAiPatch; note?: string | null }) =>
      callFn<AiRepliesSetResult>('ai-reply', { action: 'ai_replies_set', sequence_id: sequenceId, patch: a.patch, note: a.note ?? null }),
    onSuccess: (r) => {
      if (r?.settings) qc.setQueryData(aisqk.seqSettings(sequenceId), r.settings);
      qc.invalidateQueries({ queryKey: aisqk.seqSummary(sequenceId) });
      qc.invalidateQueries({ queryKey: ['outreach', 'chat'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Sequence card: prompt
// ---------------------------------------------------------------------------
export interface SavePromptInputV2 {
  editor_mode: 'guided' | 'raw'; body: string; sections: PromptSectionsV2 | null; settings: PromptSettings;
  change_kind: 'style' | 'substantive'; note?: string | null; base_version?: number | null;
}
export type SavePromptResult = { prompt: MasterPromptV2 & { change_kind: 'style' | 'substantive'; warmup_remaining: number; warnings: string[] }; warnings: string[] };

export function useSaveSequencePrompt(sequenceId: string) {
  const inv = useInvalidateSequenceAi(sequenceId);
  return useMutation({
    mutationFn: (a: SavePromptInputV2) => callFn<SavePromptResult>('ai-reply', { action: 'master_prompt_save', sequence_id: sequenceId, ...a }),
    onSuccess: (r) => inv(r?.prompt?.id ?? null),
  });
}

export function useCopyPrompt(sequenceId: string) {
  const inv = useInvalidateSequenceAi(sequenceId);
  return useMutation({
    mutationFn: (a: { fromSequence?: string | null; fromLibrary?: string | null }) =>
      rpc<MasterPromptV2>('master_prompt_copy', { p_sequence: sequenceId, p_from_sequence: a.fromSequence ?? null, p_from_library: a.fromLibrary ?? null }),
    onSuccess: (r) => inv(r?.id ?? null),
  });
}

export function usePromptVersionsV2(mp: string | null | undefined) {
  return useQuery({ queryKey: aisqk.versions(mp ?? ''), enabled: !!mp, queryFn: () => rpc<PromptVersionV2[]>('master_prompt_versions', { p_mp: mp }) });
}

// ---------------------------------------------------------------------------
// Sequence card: scenarios (situation cards)
// ---------------------------------------------------------------------------
type ScenarioWrite = { id?: string; scenarios: ScenarioCard[]; version: number };

function useAfterScenarioWrite(sequenceId: string) {
  const qc = useQueryClient();
  return (r: ScenarioWrite | undefined) => {
    if (r?.scenarios) {
      qc.setQueryData(aisqk.seqSettings(sequenceId), (old: SequenceAiSettings | undefined) =>
        old ? { ...old, prompt: { ...old.prompt, scenarios: r.scenarios, version: r.version ?? old.prompt.version, current_version: r.version ?? old.prompt.current_version } } : old);
    }
    qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    qc.invalidateQueries({ queryKey: ['outreach', 'ai-prompt-versions'] });
  };
}

export function useScenarioSave(sequenceId: string) {
  const after = useAfterScenarioWrite(sequenceId);
  return useMutation({
    mutationFn: (a: ScenarioDraft) => rpc<ScenarioWrite>('scenario_save', { p_sequence: sequenceId, p_id: a.id ?? null, p_title: a.title, p_when: a.when_text, p_do: a.do_text, p_enabled: a.enabled }),
    onSuccess: after,
  });
}
export function useScenarioToggle(sequenceId: string) {
  const after = useAfterScenarioWrite(sequenceId);
  return useMutation({ mutationFn: (a: { id: string; enabled: boolean }) => rpc<ScenarioWrite>('scenario_toggle', { p_id: a.id, p_enabled: a.enabled }), onSuccess: after });
}
export function useScenarioDelete(sequenceId: string) {
  const after = useAfterScenarioWrite(sequenceId);
  return useMutation({ mutationFn: (id: string) => rpc<ScenarioWrite>('scenario_delete', { p_id: id }), onSuccess: after });
}
export function useScenariosReorder(sequenceId: string) {
  const after = useAfterScenarioWrite(sequenceId);
  return useMutation({ mutationFn: (ids: string[]) => rpc<ScenarioWrite>('scenarios_reorder', { p_sequence: sequenceId, p_ids: ids }), onSuccess: after });
}
/** "Convert to cards": parses "- When → Do" bullets on the server. Nothing is saved. */
export function scenariosFromText(text: string): Promise<ScenarioDraft[]> {
  return rpc<ScenarioDraft[]>('scenarios_from_text', { p_text: text });
}

// ---------------------------------------------------------------------------
// Sequence card: Q&A
// ---------------------------------------------------------------------------
type FaqWrite = { id?: string; faqs: Faq[] };

/** The AI hub (Knowledge, Needs you, Setup) reads the same sources, Q&A and questions: its lists are stale after a write here. */
const invalidateAiHub = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'outreach' && q.queryKey[2] === 'ai-hub' });

function useAfterFaqWrite(sequenceId: string) {
  const qc = useQueryClient();
  return (r: FaqWrite | undefined) => {
    invalidateAiHub(qc);
    if (r?.faqs) qc.setQueryData(aisqk.seqSettings(sequenceId), (old: SequenceAiSettings | undefined) => (old ? { ...old, prompt: { ...old.prompt, faqs: r.faqs } } : old));
    qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    qc.invalidateQueries({ queryKey: ['outreach', 'ai-prompt-versions'] });
  };
}
export function useFaqSave(sequenceId: string) {
  const after = useAfterFaqWrite(sequenceId);
  return useMutation({
    mutationFn: (a: { id?: string | null; question: string; answer: string; enabled?: boolean }) =>
      rpc<FaqWrite>('faq_save', { p_sequence: sequenceId, p_id: a.id ?? null, p_question: a.question, p_answer: a.answer, p_enabled: a.enabled ?? true }),
    onSuccess: after,
  });
}
export function useFaqDelete(sequenceId: string) {
  const after = useAfterFaqWrite(sequenceId);
  return useMutation({ mutationFn: (id: string) => rpc<FaqWrite>('faq_delete', { p_id: id }), onSuccess: after });
}

// ---------------------------------------------------------------------------
// Knowledge sources (workspace-wide, attached per sequence prompt)
// ---------------------------------------------------------------------------
export const KNOWLEDGE_BUCKET = 'outreach-knowledge';
const safeName = (n: string) => n.replace(/[^\w.\-]+/g, '_').slice(-120) || 'file';

export function useKnowledgeSources(ws: string | null | undefined, enabled = true) {
  return useQuery({ queryKey: aisqk.knowledge(ws ?? ''), enabled: !!ws && enabled, queryFn: () => rpc<KnowledgeSource[]>('knowledge_sources_list', { p_ws: ws }) });
}

export interface KnowledgeAddInput { kind: 'website' | 'document' | 'text'; title: string; url?: string | null; storage_path?: string | null; text?: string | null; refresh_days?: number | null }
export function useKnowledgeSourceAdd(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: KnowledgeAddInput) => rpc<KnowledgeSource>('knowledge_source_add', {
      p_ws: ws, p_kind: a.kind, p_title: a.title, p_url: a.url ?? null, p_storage_path: a.storage_path ?? null, p_text: a.text ?? null, p_refresh_days: a.refresh_days ?? null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: aisqk.knowledge(ws) }); invalidateAiHub(qc); },
  });
}
export function useKnowledgeSourceDelete(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc<void>('knowledge_source_delete', { p_id: id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: aisqk.knowledge(ws) }); qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] }); qc.invalidateQueries({ queryKey: ['outreach', 'webchat'] }); invalidateAiHub(qc); },
  });
}
type KnowledgeWrite = { knowledge: KnowledgeRef[] };
function useAfterKnowledgeWrite(sequenceId: string) {
  const qc = useQueryClient();
  return (r: KnowledgeWrite | undefined) => {
    invalidateAiHub(qc);
    if (r?.knowledge) qc.setQueryData(aisqk.seqSettings(sequenceId), (old: SequenceAiSettings | undefined) => (old ? { ...old, prompt: { ...old.prompt, knowledge: r.knowledge, knowledge_source_ids: r.knowledge.map((k) => k.id) } } : old));
    qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    qc.invalidateQueries({ queryKey: ['outreach', 'ai-prompt-versions'] });
  };
}
export function useKnowledgeAttach(sequenceId: string) {
  const after = useAfterKnowledgeWrite(sequenceId);
  return useMutation({ mutationFn: (sourceId: string) => rpc<KnowledgeWrite>('knowledge_attach', { p_sequence: sequenceId, p_source: sourceId }), onSuccess: after });
}
export function useKnowledgeDetach(sequenceId: string) {
  const after = useAfterKnowledgeWrite(sequenceId);
  return useMutation({ mutationFn: (sourceId: string) => rpc<KnowledgeWrite>('knowledge_detach', { p_sequence: sequenceId, p_source: sourceId }), onSuccess: after });
}

/** Upload a document to the private knowledge bucket under `<ws>/<sequence>/<ts>-<name>` and return its storage path. */
export async function uploadKnowledgeFile(ws: string, sequenceId: string, file: File): Promise<string> {
  const path = `${ws}/${sequenceId}/${Date.now()}-${safeName(file.name)}`;
  // the bucket allows a fixed list of plain types; browsers often report '' for .md, so the type follows the extension
  const ext = (file.name.split('.').pop() ?? '').toLowerCase();
  const contentType = ext === 'md' || ext === 'markdown' ? 'text/markdown' : ext === 'html' || ext === 'htm' ? 'text/html' : ext === 'txt' ? 'text/plain'
    : ext === 'pdf' ? 'application/pdf' : ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : (file.type.split(';')[0] || 'application/octet-stream');
  const { error } = await db.storage.from(KNOWLEDGE_BUCKET).upload(path, file, { contentType, upsert: false });
  if (error) throw new Error(`Could not upload ${file.name}: ${parseError(error).message}`);
  return path;
}

// ---------------------------------------------------------------------------
// Unanswered questions
// ---------------------------------------------------------------------------
export function useUnanswered(sequenceId: string | null | undefined, status: 'open' | 'all' = 'open') {
  return useQuery({
    queryKey: aisqk.unanswered(sequenceId ?? '', status), enabled: !!sequenceId,
    queryFn: () => rpc<UnansweredGroup[]>('unanswered_list', { p_sequence: sequenceId, p_status: status }),
  });
}
function useAfterUnansweredWrite(sequenceId: string) {
  const qc = useQueryClient();
  return () => {
    invalidateAiHub(qc);
    qc.invalidateQueries({ queryKey: ['outreach', 'sequence', sequenceId, 'ai-unanswered'] });
    qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    qc.invalidateQueries({ queryKey: aisqk.seqSummary(sequenceId) });
  };
}
export function useUnansweredAnswer(sequenceId: string) {
  const after = useAfterUnansweredWrite(sequenceId);
  return useMutation({ mutationFn: (a: { groupId: string; answer: string }) => rpc<{ faq_id: string; faqs: Faq[] }>('unanswered_answer', { p_group: a.groupId, p_answer: a.answer }), onSuccess: after });
}
export function useUnansweredDismiss(sequenceId: string) {
  const after = useAfterUnansweredWrite(sequenceId);
  return useMutation({ mutationFn: (a: { groupId: string; reason: string | null }) => rpc<{ ok: boolean }>('unanswered_dismiss', { p_group: a.groupId, p_reason: a.reason }), onSuccess: after });
}

// ---------------------------------------------------------------------------
// Consent (per sender)
// ---------------------------------------------------------------------------
export type ConsentRequestResult = { granted?: boolean; already?: boolean; skipped?: boolean; link?: string; emailed?: boolean; expires_at?: string; sender_name?: string | null };

export function useConsentList(ws: string | null | undefined) {
  return useQuery({ queryKey: aisqk.consent(ws ?? ''), enabled: !!ws, queryFn: () => rpc<ConsentSenderV2[]>('ai_consent_list', { p_ws: ws }) });
}
/** Ask the sender's owner (a link, emailed when possible); granted at once when the caller owns the account. */
export function useRequestConsentV2(ws: string, sequenceId?: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (senderId: string) => callFn<ConsentRequestResult>('ai-reply', { action: 'consent_request', workspace_id: ws, sender_id: senderId }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: aisqk.consent(ws) });
      if (sequenceId) qc.invalidateQueries({ queryKey: aisqk.seqSettings(sequenceId) });
    },
  });
}
export function useRevokeConsentV2(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { consentId: string; reason: string }) => rpc<void>('ai_consent_revoke', { p_consent: a.consentId, p_reason: a.reason }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: aisqk.consent(ws) }); qc.invalidateQueries({ queryKey: ['outreach', 'sequence'] }); },
  });
}

// ---------------------------------------------------------------------------
// Settings page: workspace defaults + library prompts
// ---------------------------------------------------------------------------
export function useWorkspaceReplySettings(ws: string | null | undefined) {
  return useQuery({ queryKey: aisqk.wsSettings(ws ?? ''), enabled: !!ws, queryFn: () => rpc<WorkspaceReplySettings>('workspace_reply_settings_get', { p_ws: ws }) });
}
export function useSetWorkspaceReplySettings(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: { max_ai_sends_per_sender_day?: number; default_prompt_id?: string | null }) => rpc<WorkspaceReplySettings>('workspace_reply_settings_set', { p_ws: ws, p_patch: patch }),
    onSuccess: (r) => { qc.setQueryData(aisqk.wsSettings(ws), r); qc.invalidateQueries({ queryKey: aisqk.library(ws) }); },
  });
}
export function useLibraryPrompts(ws: string | null | undefined) {
  return useQuery({ queryKey: aisqk.library(ws ?? ''), enabled: !!ws, queryFn: () => rpc<LibraryPromptRow[]>('master_prompt_library_list', { p_ws: ws }) });
}
export function useLibraryPrompt(id: string | null | undefined) {
  return useQuery({ queryKey: aisqk.libraryPrompt(id ?? ''), enabled: !!id, queryFn: () => rpc<MasterPromptV2>('master_prompt_library_get', { p_id: id }) });
}
export interface LibrarySaveInput { id: string | null; name: string; editor_mode: 'guided' | 'raw'; body: string; sections: PromptSectionsV2 | null; settings: PromptSettings; note?: string | null; scenarios?: ScenarioDraft[] | null }
export function useSaveLibraryPrompt(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: LibrarySaveInput) => rpc<MasterPromptV2>('master_prompt_library_save', {
      p_ws: ws, p_id: a.id, p_name: a.name, p_editor_mode: a.editor_mode, p_body: a.body, p_sections: a.sections, p_settings: a.settings, p_note: a.note ?? null, p_scenarios: a.scenarios ?? null,
    }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: aisqk.library(ws) });
      if (r?.id) { qc.setQueryData(aisqk.libraryPrompt(r.id), r); qc.invalidateQueries({ queryKey: aisqk.versions(r.id) }); }
    },
  });
}
export function useDeleteLibraryPrompt(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => rpc<void>('master_prompt_library_delete', { p_id: id }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: aisqk.library(ws) }); qc.invalidateQueries({ queryKey: aisqk.wsSettings(ws) }); },
  });
}
export function useTemplate(ws: string | null | undefined) {
  return useQuery({ queryKey: ['outreach', ws ?? '', 'ai-prompt-template'] as const, enabled: !!ws, staleTime: Infinity, queryFn: () => rpc<PromptTemplateV2>('master_prompt_template') });
}

// ---------------------------------------------------------------------------
// Simulator + test conversations (the v1.1 regression set)
// ---------------------------------------------------------------------------
/** Run the full pipeline on a simulated thread. Never sends, never writes runs. */
export function simulateV2(input: SimulateInputV2): Promise<SimulateResultV2> {
  return callFn<SimulateResultV2>('ai-reply', { action: 'simulate', ...input });
}
/** Re-run the saved test conversations of a sequence's prompt (or against unsaved edits). */
export function runRegressionV2(input: { workspace_id: string } & RegressionInput): Promise<RegressionResult> {
  return callFn<RegressionResult>('ai-reply', { action: 'regression_run', ...input });
}
export function useTestConversations(ws: string | null | undefined, mp: string | null) {
  return useQuery({ queryKey: aisqk.tests(ws ?? '', mp), enabled: !!ws, queryFn: () => rpc<Scenario[]>('ai_reply_scenarios_list', { p_ws: ws, p_mp: mp }) });
}
export function useSaveTestConversation(ws: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { id?: string | null; masterPromptId: string | null; name: string; turns: Scenario['turns']; expected: Scenario['expected'] }) =>
      rpc<Scenario>('ai_reply_scenario_save', { p_ws: ws, p_id: a.id ?? null, p_mp: a.masterPromptId, p_name: a.name, p_turns: a.turns, p_expected: a.expected }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-scenarios'] }),
  });
}
export function useDeleteTestConversation(ws: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => rpc<void>('ai_reply_scenario_delete', { p_id: id }), onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-scenarios'] }) });
}

// ---------------------------------------------------------------------------
// Settings page: activity, reports, allowance
// ---------------------------------------------------------------------------
export function useAiRunV2(id: string | null | undefined) {
  return useQuery({ queryKey: aisqk.run(id ?? ''), enabled: !!id, queryFn: () => rpc<RunDetailV2>('ai_reply_run_get', { p_run: id }) });
}
export function useAiMetricsV2(ws: string | null | undefined, from: string, to: string, group: MetricsGroup = 'none') {
  return useQuery({ queryKey: aisqk.metrics(ws ?? '', { from, to, group }), enabled: !!ws, queryFn: () => rpc<MetricsV2>('ai_reply_metrics', { p_ws: ws, p_from: from, p_to: to, p_group: group }) });
}
export function useCancelReportV2(ws: string | null | undefined, days = 30) {
  return useQuery({
    queryKey: aisqk.cancelReport(ws ?? '', days), enabled: !!ws,
    queryFn: () => rpc<Array<{ rule_applied: string | null; reason: string; n: number; run_ids: string[] }>>('ai_reply_cancel_report', { p_ws: ws, p_days: days }),
  });
}
export function usePoolV2(ws: string | null | undefined) {
  return useQuery({ queryKey: aisqk.pool(ws ?? ''), enabled: !!ws, queryFn: () => rpc<Pool>('ai_reply_pool', { p_ws: ws }) });
}

export type { Decision, FactUsed, ReplyMode };
