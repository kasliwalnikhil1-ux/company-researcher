'use client';

// AI replies in the inbox: helpers and hooks that sit on top of lib/outreach/aiReplies.ts (contract:
// docs/outreach/AI-REPLIES-V2-CONTRACT.md §8). Labels are customer copy: plain, short, never the connector vendor's name.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiChatFilter } from '@/lib/outreach/queries';
import { useChatAiState, ESCALATION_LABEL, HANDOFF_LABEL, MODE_LABEL, type ChatAiState, type RunSummary, type SideEffect, type StageDef } from '@/lib/outreach/aiReplies';

// ---------------------------------------------------------------------------
// Chat list filters
// ---------------------------------------------------------------------------
export type { AiChatFilter };

export const AI_FILTER_LABEL: Record<AiChatFilter, string> = {
  scheduled: 'Scheduled by AI',
  escalated: 'Handed to a person',
  draft_ready: 'AI draft ready',
  manual_drafts: 'My AI drafts',
  handed_off: 'Handed off by AI',
  sent_by_ai: 'Sent by AI',
};
export const AI_FILTERS = Object.keys(AI_FILTER_LABEL) as AiChatFilter[];

/** The contract's default stages; `closing` is always allowed as a terminal stage. */
export const DEFAULT_STAGES: StageDef[] = [
  { key: 'engage', label: 'Engage' }, { key: 'relate', label: 'Relate' }, { key: 'pitch', label: 'Pitch' }, { key: 'next_step', label: 'Next step' },
];
const CLOSING: StageDef = { key: 'closing', label: 'Closing' };

/** "next_step" → "Next step" (a stage key the loaded stage list does not know). */
export function humanizeKey(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

/**
 * Stage filter options. v2 has no workspace prompt: the list shows the default stages plus `closing`; a filter value the
 * list does not know is still offered (humanised) by ChatList. `extra` lets a caller merge the open chat's stages in.
 */
export function useStageOptions(_ws: string | null | undefined, extra?: StageDef[] | null): StageDef[] {
  return useMemo(() => {
    const stages = extra?.length ? extra : DEFAULT_STAGES;
    return stages.some((s) => s.key === CLOSING.key) ? stages : [...stages, CLOSING];
  }, [extra]);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
/** Why the chat is in its mode: "from sequence Fintech CFOs", "not part of a sequence", "sender consent missing". */
export function modeWhy(s: ChatAiState): string | null {
  if (s.reason_code === 'handed_off') return s.handed_off ? `handed off · ${HANDOFF_LABEL[s.handed_off.reason] ?? humanizeKey(s.handed_off.reason)}` : 'handed off';
  if (s.reason_code === 'no_sequence') return 'not part of a sequence';
  if (s.reason_code === 'channel_not_supported') return 'LinkedIn only for now';
  if (s.reason_code === 'consent_missing') return s.sequence_name ? `from sequence ${s.sequence_name} · sender consent missing` : 'sender consent missing';
  if (s.reason_code === 'sequence_paused' || s.reason_code === 'sequence_archived' || s.reason_code === 'sequence_draft') {
    const what = s.reason_code === 'sequence_paused' ? 'paused' : s.reason_code === 'sequence_archived' ? 'archived' : 'not live yet';
    return s.sequence_name ? `sequence ${s.sequence_name} is ${what}` : `sequence is ${what}`;
  }
  if (s.reason_code === 'paused_escalated') return 'paused · handed to a person';
  if (s.reason_code === 'paused_bot') return 'paused · they asked if this is a bot';
  if (s.source === 'sequence' && s.sequence_name) return `from sequence ${s.sequence_name}`;
  if (s.reason && s.reason_code) return s.reason;
  return null;
}

/** "Draft · from sequence Fintech CFOs" */
export function modeLine(s: ChatAiState): string {
  const why = modeWhy(s);
  return why ? `${MODE_LABEL[s.mode]} · ${why}` : MODE_LABEL[s.mode];
}

/** AI replies are LinkedIn only: other channels get no header chip at all. */
export function aiHidden(s: ChatAiState | null | undefined): boolean {
  return !s || (s.mode === 'off' && s.reason_code === 'channel_not_supported');
}

export const PAUSE_WHY: Record<Exclude<ChatAiState['autopilot_state'], 'active'>, string> = {
  paused_escalated: 'handed to a person', paused_bot: 'they asked if this is a bot',
};

export function isPaused(s: ChatAiState | null | undefined): s is ChatAiState & { autopilot_state: Exclude<ChatAiState['autopilot_state'], 'active'> } {
  return !!s && s.autopilot_state !== 'active';
}

/** "Paused: they asked if this is a bot" */
const PAUSE_REASON: Record<string, string> = {
  hostile_after_ai: 'they reacted badly to an AI reply', fast_replies: 'the other side answers like a bot', auto_responder: 'the other side looks like an auto-responder',
};

export function pausedText(s: ChatAiState & { autopilot_state: Exclude<ChatAiState['autopilot_state'], 'active'> }): string {
  const why = (s.paused_reason && (PAUSE_REASON[s.paused_reason] ?? humanizeKey(s.paused_reason))) || PAUSE_WHY[s.autopilot_state];
  return `Paused: ${why}`;
}

/** "AI handed off · calendar link sent · 2 Oct" */
export function handoffLine(s: ChatAiState): string | null {
  if (!s.handed_off) return null;
  const when = new Date(s.handed_off.at);
  const date = Number.isNaN(when.getTime()) ? '' : when.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return ['AI handed off', HANDOFF_LABEL[s.handed_off.reason] ?? humanizeKey(s.handed_off.reason), date].filter(Boolean).join(' · ');
}

/** "Relate", "Re-engage" (dormant session), null when the conversation has no stage yet. No "Stage 2 ·": the step bar shows the order. */
export function stageShort(s: ChatAiState): string | null {
  return s.stage?.label ?? null;
}

/** "Relate · 2 exchanges" */
export function stageLine(s: ChatAiState): string | null {
  const st = stageShort(s);
  if (!st) return null;
  return `${st} · ${s.exchanges} exchange${s.exchanges === 1 ? '' : 's'}`;
}

/** "AI replies left 4/6" */
export function repliesLeftText(s: ChatAiState): string {
  const left = Math.max(0, (s.max_ai_replies ?? 0) - (s.ai_replies_count ?? 0));
  return `AI replies left ${left}/${s.max_ai_replies ?? 0}`;
}

/** The stage a draft was written in: the chat's stage, plus where the draft moves it ("Engage → Relate"). */
export function runStageText(run: RunSummary, s: ChatAiState | null | undefined): string | null {
  const cur = s?.stage ? stageShort(s) : run.stage_before ? humanizeKey(run.stage_before) : null;
  const curKey = s?.stage?.key ?? run.stage_before;
  const next = run.stage_after && run.stage_after !== curKey ? humanizeKey(run.stage_after) : null;
  if (cur && next) return `${cur} → ${next}`;
  return cur ?? next;
}

const LANGUAGE_NAME: Record<string, string> = {
  en: 'English', hi: 'Hindi', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', nl: 'Dutch', ar: 'Arabic', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
  ru: 'Russian', tr: 'Turkish', id: 'Indonesian', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', pl: 'Polish', he: 'Hebrew', th: 'Thai', vi: 'Vietnamese', ta: 'Tamil', te: 'Telugu', mr: 'Marathi', bn: 'Bengali',
};
/** "fr" → "French"; an unknown code is shown upper-cased. */
export function languageName(code: string | null | undefined): string {
  const c = (code ?? '').toLowerCase();
  return c ? (LANGUAGE_NAME[c] ?? c.toUpperCase()) : 'their language';
}

export function escalationText(reasons: string[] | null | undefined): string {
  const list = (reasons ?? []).map((r) => ESCALATION_LABEL[r] ?? humanizeKey(r));
  return list.length ? list.join('; ') : 'The AI thinks a person should answer this one';
}

function shortDate(iso: string): string {
  const d = new Date(`${iso.length === 10 ? `${iso}T12:00:00` : iso}`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Follow-up task · 15 Nov · Check back after Diwali", "Archive the chat". */
export function sideEffectText(e: SideEffect): string {
  switch (e.type) {
    case 'task': {
      const head = e.kind === 'contact_referral' ? `Task: contact ${e.name ?? 'the person they referred'}` : 'Follow-up task';
      return [head, e.due ? shortDate(e.due) : null, e.note].filter(Boolean).join(' · ');
    }
    case 'archive': return 'Archive the chat';
    case 'mark_read': return 'Mark as read';
    case 'set_tag': return e.tag ? `Tag: ${e.tag}` : 'Add a tag';
    default: return humanizeKey(String((e as { type?: string }).type ?? 'action'));
  }
}

// ---------------------------------------------------------------------------
// Composer: the AI draft that fills the reply box
// ---------------------------------------------------------------------------
export interface DraftTag { runId: string; original: string }

/**
 * Keeps the composer and the chat's AI run in step.
 * - A `draft_ready` run whose decision is `send` pre-fills an empty composer once per run id (never over typed text;
 *   the previous run's untouched draft counts as empty, so a newer draft replaces it). When the box holds typed text
 *   AiComposerPanel offers the new automatic draft as an "AI draft ready · View" pill instead.
 * - `tag` remembers which run the composer text came from; `runIdForSend()` returns it only while that run can still be
 *   answered (draft ready, scheduled or escalated), so send-reply gets `ai_run_id` only for text that started as that draft.
 * - When the run ends elsewhere (sent, cancelled, superseded), an untouched draft is cleared from the composer so it is not sent twice.
 * - `placeDraft(runId, text)` puts a Draft with AI result in the box, tagged with its run (Regenerate / Shorter / Instruction…).
 */
export function useComposerAi(chatId: string, text: string, setText: (t: string) => void) {
  const q = useChatAiState(chatId);
  const state = q.data ?? null;
  const run = state?.run ?? null;
  const last = state?.last_run ?? null;
  const [tag, setTag] = useState<DraftTag | null>(null);
  /** The AI sent its own version of the reply the user was editing: the next send needs a confirmation. */
  const [aiSent, setAiSent] = useState(false);

  // Runs the composer may send a draft of.
  const answerable = useMemo(() => {
    const ids = new Set<string>();
    if (run && (run.status === 'draft_ready' || run.status === 'scheduled')) ids.add(run.id);
    if (last && last.status === 'escalated') ids.add(last.id);
    return ids;
  }, [run, last]);

  // Latest text / tag for the effects below, without re-running them on every keystroke.
  const live = useRef({ text, tag });
  useEffect(() => { live.current = { text, tag }; });

  const prefill = run && run.status === 'draft_ready' && run.decision === 'send' && run.draft_text ? { id: run.id, text: run.draft_text } : null;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!prefill || seen.current === prefill.id) return;
    seen.current = prefill.id;
    const { text: cur, tag: t } = live.current;
    // never overwrite what the user typed: AiComposerPanel offers the draft as an "AI draft ready · View" pill instead
    if (cur.trim() && !(t && cur === t.original)) return;
    setText(prefill.text);
    setTag({ runId: prefill.id, original: prefill.text });
  }, [prefill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // The run the composer text came from is over: drop the tag, and the draft itself when it was not edited.
  useEffect(() => {
    const t = live.current.tag;
    if (!state || !t || answerable.has(t.runId)) return;
    if (live.current.text === t.original) setText('');
    else if (last?.id === t.runId && last.status === 'sent' && last.sent_origin === 'ai_autopilot') setAiSent(true);
    setTag(null);
  }, [state, answerable]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Put a draft in the composer (Use draft / Edit / Send this draft / View). Asks before replacing typed text. */
  const takeDraft = useCallback((r: RunSummary) => {
    const draft = r.draft_text ?? '';
    const { text: cur, tag: t } = live.current;
    if (cur.trim() && !(t && cur === t.original) && cur !== draft && !window.confirm('Replace what you typed with the AI draft?')) return false;
    seen.current = r.id;
    setText(draft);
    setTag({ runId: r.id, original: draft });
    return true;
  }, [setText]);

  /** Place a Draft with AI result (no confirmation: the caller already asked Replace / Insert below). */
  const placeDraft = useCallback((runId: string, draft: string, mode: 'replace' | 'insert' = 'replace') => {
    seen.current = runId;
    const next = mode === 'insert' && live.current.text.trim() ? `${live.current.text.replace(/\s+$/, '')}\n\n${draft}` : draft;
    setText(next);
    setTag({ runId, original: next });
  }, [setText]);

  const dropTag = useCallback(() => setTag(null), []);
  /** Clears the composer when it still holds this run's untouched draft (after Dismiss / Cancel). */
  const discardDraft = useCallback((runId: string) => {
    const { text: cur, tag: t } = live.current;
    if (t?.runId !== runId) return;
    if (cur === t.original) setText('');
    setTag(null);
  }, [setText]);
  const runIdForSend = useCallback((): string | null => {
    const t = live.current.tag;
    return t && answerable.has(t.runId) && live.current.text.trim() ? t.runId : null;
  }, [answerable]);

  const clearAiSent = useCallback(() => setAiSent(false), []);
  return { query: q, state, run, last, tag, takeDraft, placeDraft, dropTag, discardDraft, runIdForSend, aiSent, clearAiSent };
}
export type ComposerAi = ReturnType<typeof useComposerAi>;
