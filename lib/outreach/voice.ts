'use client';

// Voice for the website agent (web-chat-voice-elevenlabs-PRD.md; migration 069): types, hooks and helpers for the
// Voice tab of a website, the voice picker, the test panel, the inbox's call card and the report. Settings are saved
// with the website (settings.voice, outreach_webchat_inbox_update); everything that talks to the voice provider goes
// through the `outreach-voice-admin` edge function, so nobody here ever sees the provider's ids or keys.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { callFn, OutreachError, rpc } from './api';

// ---------------------------------------------------------------------------
// Settings (settings.voice)
// ---------------------------------------------------------------------------
export type VoiceCollect = 'name' | 'phone' | 'need' | 'budget';
export interface VoiceUi {
  start_text: string; start_hint: string; orb_1: string | null; orb_2: string | null; avatar: 'logo' | 'bot' | 'none';
  labels: Partial<Record<'listening' | 'thinking' | 'speaking' | 'muted' | 'connecting' | 'end' | 'mute' | 'switch', string>>;
  captions: boolean; show_on: { home: boolean; composer: boolean; launcher: boolean };
}
export interface VoiceSettings {
  enabled: boolean; voice_id: string | null; voice_name: string | null; speed: number; stability: number;
  /** null = the website's default language */
  language: string | null; languages: string[]; auto_language: boolean; hinglish: boolean;
  greeting: Record<string, string>; instructions: string; max_minutes: number; silence_end_s: number;
  model: 'fast' | 'smart'; tool_sound: 'typing' | 'none'; collect: VoiceCollect[]; record: boolean; retention_days: number; consent_text: string | null;
  ui: VoiceUi;
}
export const VOICE_DEFAULTS: VoiceSettings = {
  enabled: false, voice_id: null, voice_name: null, speed: 1, stability: 0.5, language: null, languages: [], auto_language: true, hinglish: false,
  greeting: {}, instructions: '', max_minutes: 5, silence_end_s: 20, model: 'fast', tool_sound: 'typing', collect: ['name', 'phone', 'need'], record: true, retention_days: 30, consent_text: null,
  ui: { start_text: 'Talk to us', start_hint: 'Speak with our AI assistant', orb_1: null, orb_2: '#c7a3ff', avatar: 'logo', labels: {}, captions: true, show_on: { home: true, composer: true, launcher: false } },
};
/** The stored settings over the defaults (a website saved before a key existed has no value for it). */
export function voiceOf(v: Partial<VoiceSettings> | null | undefined): VoiceSettings {
  const x = v ?? {};
  return { ...VOICE_DEFAULTS, ...x, greeting: { ...(x.greeting ?? {}) }, collect: x.collect ?? VOICE_DEFAULTS.collect, languages: x.languages ?? [],
    ui: { ...VOICE_DEFAULTS.ui, ...(x.ui ?? {}), labels: { ...(x.ui?.labels ?? {}) }, show_on: { ...VOICE_DEFAULTS.ui.show_on, ...(x.ui?.show_on ?? {}) } } };
}
/** The languages voice can speak (the provider's fast multilingual speech model). Codes as migration 069 validates them. */
export const VOICE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'en', label: 'English' }, { code: 'hi', label: 'Hindi' }, { code: 'ar', label: 'Arabic' }, { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'pt', label: 'Portuguese' }, { code: 'it', label: 'Italian' }, { code: 'nl', label: 'Dutch' }, { code: 'ta', label: 'Tamil' }, { code: 'id', label: 'Indonesian' }, { code: 'ms', label: 'Malay' },
  { code: 'fil', label: 'Filipino' }, { code: 'vi', label: 'Vietnamese' }, { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' }, { code: 'zh', label: 'Chinese' }, { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' }, { code: 'uk', label: 'Ukrainian' }, { code: 'pl', label: 'Polish' }, { code: 'cs', label: 'Czech' }, { code: 'sk', label: 'Slovak' }, { code: 'hu', label: 'Hungarian' },
  { code: 'ro', label: 'Romanian' }, { code: 'bg', label: 'Bulgarian' }, { code: 'hr', label: 'Croatian' }, { code: 'el', label: 'Greek' }, { code: 'sv', label: 'Swedish' }, { code: 'da', label: 'Danish' },
  { code: 'no', label: 'Norwegian' }, { code: 'fi', label: 'Finnish' },
];
export const voiceLanguage = (code: string | null | undefined) => VOICE_LANGUAGES.find((l) => l.code === code)?.label ?? code ?? '';
export const MAX_VOICE_LANGUAGES = 10;
export const COLLECT_LABELS: Record<VoiceCollect, string> = { name: 'Name', phone: 'Phone', need: 'What they need', budget: 'Budget' };
export const VOICE_LABEL_KEYS: Array<{ key: keyof VoiceUi['labels']; label: string; placeholder: string }> = [
  { key: 'listening', label: 'Listening', placeholder: 'Listening…' }, { key: 'thinking', label: 'Thinking', placeholder: 'Thinking…' }, { key: 'speaking', label: 'Speaking', placeholder: 'Speaking…' },
  { key: 'muted', label: 'Muted', placeholder: 'Muted' }, { key: 'switch', label: 'Switch to chat', placeholder: 'Switch to chat' }, { key: 'end', label: 'End call', placeholder: 'End' },
];
/** The consent text a visitor sees when the website wrote none. "May be recorded" goes when recording is off. */
export const defaultConsent = (record: boolean) => `You'll be speaking with an AI assistant. ${record ? 'The call may be recorded and transcribed to help us reply.' : 'The call is transcribed to help us reply.'}`;

// ---------------------------------------------------------------------------
// State of a website's voice (outreach_hub_voice_state)
// ---------------------------------------------------------------------------
export interface VoiceAgentState { exists: boolean; account: 'platform' | 'own'; synced_at: string | null; sync_error: string | null; sync_attempts: number; archived: boolean; draft_at: string | null }
export interface VoicePool { month: string; used: number; test_used: number; limit: number | null; included: number; extra: number; own_key: boolean; ok: boolean }
export interface VoiceState {
  inbox_id: string; account: 'platform' | 'own'; pool: VoicePool; limits: { included: number; max_minutes: number; concurrency: number; own_key: boolean };
  languages: string[]; agents: Partial<Record<'live' | 'test', VoiceAgentState>>; draft: Partial<VoiceSettings> | null;
  requires: { assistant_auto: boolean; assistant_mode: string; knowledge: boolean; sources: number; qa_pairs: number; active: boolean };
}
export const vk = {
  state: (inbox: string) => ['outreach', 'webchat', 'inbox', inbox, 'voice'] as const,
  voices: (ws: string, tab: string, language: string, search: string) => ['outreach', ws, 'voice', 'voices', tab, language, search] as const,
  calls: (ws: string, inbox: string | null, limit: number) => ['outreach', ws, 'voice', 'calls', inbox, limit] as const,
};
export function useVoiceState(inbox: string | null | undefined) {
  return useQuery({ queryKey: vk.state(inbox ?? ''), enabled: !!inbox, refetchInterval: 60_000, queryFn: () => rpc<VoiceState>('hub_voice_state', { p_inbox: inbox }) });
}
export function useInvalidateVoice(inbox: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: vk.state(inbox) });
}

// ---------------------------------------------------------------------------
// outreach-voice-admin
// ---------------------------------------------------------------------------
/** GET on the admin function with query parameters (callFn posts a JSON body). */
async function adminGet<T>(path: string, params: Record<string, string | number | null | undefined> = {}): Promise<T> {
  const res = await callFn<Response>(`voice-admin${path}` as `voice-admin/${string}`, {}, { method: 'GET', raw: true, query: params });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new OutreachError(data?.error ?? `Request failed (${res.status})`, data?.code ?? `E_HTTP_${res.status}`, data);
  return data as T;
}

export interface VoiceOption {
  voice_id: string; name: string; description: string | null; preview_url: string | null; category: string | null; gender: string | null; accent: string | null; age: string | null;
  use_case: string | null; language: string | null; languages: string[]; public_owner_id?: string | null; source: 'account' | 'library';
}
export type VoiceTab = 'recommended' | 'library' | 'mine';
export function useVoices(ws: string | null | undefined, tab: VoiceTab, f: { language: string; search: string; gender: string; accent: string }, enabled = true) {
  return useQuery({
    queryKey: [...vk.voices(ws ?? '', tab, f.language, f.search), f.gender, f.accent], enabled: !!ws && enabled, staleTime: 5 * 60_000, retry: false,
    queryFn: () => tab === 'library'
      ? adminGet<{ voices: VoiceOption[]; has_more: boolean; own_account: boolean }>('/voices/library', { workspace_id: ws, language: f.language, search: f.search, gender: f.gender, accent: f.accent })
      : adminGet<{ voices: VoiceOption[]; own_account: boolean }>('/voices', { workspace_id: ws, tab, language: f.language, search: f.search }),
  });
}
/** A library voice has to be in the account before an agent can speak with it: returns the id to save. */
export const addLibraryVoice = (ws: string, v: VoiceOption) => callFn<{ voice_id: string }>('voice-admin/voices/add', { workspace_id: ws, public_user_id: v.public_owner_id, voice_id: v.voice_id, name: v.name });

export interface SyncResult { ok: boolean; state: 'synced' | 'unchanged' | 'off' | 'failed' | 'skipped'; error: string | null }
/** Keep the draft and put it on the test agent (null = discard the draft). */
export const saveVoiceDraft = (inbox: string, draft: Partial<VoiceSettings> | null) => callFn<SyncResult>(`voice-admin/inboxes/${inbox}/voice/draft`, { draft });
/** Push the published settings to the live agent (after a save, or Retry). */
export const syncVoice = (inbox: string, o: { which?: 'live' | 'test'; clear_draft?: boolean } = {}) => callFn<SyncResult>(`voice-admin/inboxes/${inbox}/voice/sync`, { which: o.which ?? 'live', clear_draft: !!o.clear_draft });

export interface TestSession { call_id: string; conversation_token: string; el_conversation_id: string; max_minutes: number; language?: string; languages: string[]; dynamic_variables: Record<string, string> }
export const startTestSession = (inbox: string, o: { page_url?: string; page_title?: string; visitor_name?: string; language?: string; draft?: Partial<VoiceSettings> | null }) =>
  callFn<TestSession>(`voice-admin/inboxes/${inbox}/voice/test-session`, o);
export const endTestSession = (inbox: string, callId: string) => callFn<{ ok: boolean }>(`voice-admin/inboxes/${inbox}/voice/test-end`, { call_id: callId }).catch(() => ({ ok: false }));

export interface CheckRun { run_id: string; call_id: string; tests: Array<{ id: string; key: string; name: string }> }
export interface CheckResult { test_id: string; status: 'pending' | 'passed' | 'failed'; why: string | null; replies: string[] }
export const runVoiceChecks = (inbox: string) => callFn<CheckRun>(`voice-admin/inboxes/${inbox}/voice/run-checks`, {});
export const voiceCheckResults = (inbox: string, run: CheckRun) =>
  adminGet<{ finished: boolean; results: CheckResult[] }>(`/inboxes/${inbox}/voice/run-checks`, { run: run.run_id, call: run.call_id, tests: run.tests.map((t) => t.id).join(',') });

/** The recording of a call as an object URL (streamed through our proxy; never stored by us). Throws E_RECORDING_EXPIRED when the provider no longer has it. */
export async function fetchCallAudio(callId: string): Promise<string> {
  const res = await callFn<Response>(`voice-admin/voice-calls/${callId}/audio`, {}, { method: 'GET', raw: true });
  if (!res.ok) { const j = await res.json().catch(() => null); throw new OutreachError(j?.error ?? 'The recording could not be loaded.', j?.code ?? `E_HTTP_${res.status}`); }
  return URL.createObjectURL(await res.blob());
}

// ---------------------------------------------------------------------------
// The voice SDK wrapper the widget uses (public/widget/v1/voice.js): the test panel runs the same code visitors do.
// ---------------------------------------------------------------------------
export interface VoiceHandle { id(): string | null; end(): Promise<void>; mute(b: boolean): void; text(t: string): void; activity(): void; context(t: string): void; level(): number; open(): boolean }
export interface VoiceSessionOptions {
  token: string; language?: string; variables: Record<string, string>;
  clientTools?: Record<string, (p: Record<string, unknown>) => string | void>;
  on: {
    connect?(id: string): void; status?(s: string): void; mode?(m: 'speaking' | 'listening'): void; message?(m: { role: 'user' | 'agent'; text: string; eventId?: number }): void;
    part?(p: { text: string; type: 'start' | 'delta' | 'stop' }): void; tool?(t: { name: string; id: string; type: string }): void; toolResult?(t: { name: string; id: string; error: boolean; result?: string }): void;
    error?(message: string): void; end?(reason: 'user' | 'agent' | 'error'): void;
  };
}
interface VoiceModule { session(o: VoiceSessionOptions): Promise<VoiceHandle> }
let voiceModule: Promise<VoiceModule> | null = null;
export function loadVoiceModule(): Promise<VoiceModule> {
  if (!voiceModule) voiceModule = new Promise<VoiceModule>((resolve, reject) => {
    const w = window as unknown as { __growthxaiWebchatVoice?: VoiceModule };
    if (w.__growthxaiWebchatVoice) return resolve(w.__growthxaiWebchatVoice);
    const s = document.createElement('script');
    s.src = '/widget/v1/voice.js'; s.async = true;
    s.onload = () => (w.__growthxaiWebchatVoice ? resolve(w.__growthxaiWebchatVoice) : reject(new Error('The voice code did not load.')));
    s.onerror = () => { voiceModule = null; reject(new Error('The voice code could not be loaded.')); };
    document.head.appendChild(s);
  });
  return voiceModule;
}

// ---------------------------------------------------------------------------
// Calls: the inbox's call card, the list, the report
// ---------------------------------------------------------------------------
/** content_attributes of the call's `event` message in a thread (kind voice_call), kept current by the server. */
export interface CallCard {
  kind: 'voice_call'; call_id: string; status: 'live' | 'ended' | 'failed'; started_at: string; ended_at?: string; ended_reason?: string; duration_s?: number;
  summary?: string; title?: string; successful?: 'success' | 'failure' | 'unknown'; has_audio?: boolean; language?: string; handoff_reason?: string; confirmed?: boolean;
}
export const isCallCard = (a: unknown): a is CallCard => !!a && typeof a === 'object' && (a as { kind?: unknown }).kind === 'voice_call' && typeof (a as { call_id?: unknown }).call_id === 'string';
export const ENDED_BY: Record<string, string> = {
  visitor: 'ended by the visitor', agent_end_call: 'ended by the assistant', switch: 'switched to chat', handoff: 'handed to the team', takeover: 'a teammate took over',
  silence: 'ended after silence', max_duration: 'reached the time limit', error: 'connection lost',
};
export function fmtCallLength(s: number | null | undefined): string {
  if (s == null) return '';
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
export interface VoiceCall {
  id: string; inbox_id: string; website: string; chat_id: string | null; visitor_id: string | null; visitor_name: string | null; test: boolean; status: string; started_at: string; ended_at: string | null;
  ended_reason: string | null; handoff_reason: string | null; duration_s: number | null; language: string | null; title: string | null; summary: string | null; successful: string | null;
  collected: Record<string, string>; has_audio: boolean; agent_turns: number; account: 'platform' | 'own'; cost_usd: number | null;
}
export function useVoiceCalls(ws: string | null | undefined, inbox: string | null, limit = 20, enabled = true) {
  return useQuery({ queryKey: vk.calls(ws ?? '', inbox, limit), enabled: !!ws && enabled, queryFn: () => rpc<{ total: number; calls: VoiceCall[]; pool: VoicePool }>('hub_voice_calls', { p_ws: ws, p_inbox: inbox, p_limit: limit }) });
}
/** The Voice block of the website report (outreach_webchat_report → voice). */
export interface VoiceReport {
  calls: number; minutes: number; avg_seconds: number | null; per_100_visitors: number | null; switched: number; handed_off: number; handoff_reasons: Record<string, number>; ended_by: Record<string, number>;
  resolved: number; judged: number; with_name: number; with_phone: number; leads: number; languages: Record<string, number>;
  top_questions: Array<{ query: string; n: number }>; unanswered: Array<{ query: string; n: number }>; cost_usd: number | null; pool: VoicePool;
}

export function useSaveVoiceKey(ws: string | null | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string | null) => callFn<{ ok: boolean; settings: { elevenlabs_key_hint: string | null } }>('workspace-secrets', { workspace_id: ws, elevenlabs: key === null ? null : { key } }),
    onSuccess: () => { if (ws) qc.invalidateQueries({ queryKey: ['outreach', ws, 'ai-settings'] }); qc.invalidateQueries({ queryKey: ['outreach', 'webchat', 'inbox'] }); },
  });
}
