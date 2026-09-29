'use client';

// AI replies in the inbox: helpers and hooks that sit on top of lib/outreach/aiReplies.ts (contract:
// docs/outreach/AI-REPLIES-CONTRACT.md). Labels are customer copy: plain, short, never the connector vendor's name.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AiChatFilter } from '@/lib/outreach/queries';
import { useChatAiState, useMasterPrompt, ESCALATION_LABEL, type ChatAiState, type RunSummary, type SideEffect, type StageDef } from '@/lib/outreach/aiReplies';

// ---------------------------------------------------------------------------
// Chat list filters
// ---------------------------------------------------------------------------
export type { AiChatFilter };

export const AI_FILTER_LABEL: Record<AiChatFilter, string> = {
  scheduled: 'Scheduled by AI',
  escalated: 'Handed to a person',
  draft_ready: 'AI draft ready',
  sent_by_ai: 'Sent by AI',
};
export const AI_FILTERS = Object.keys(AI_FILTER_LABEL) as AiChatFilter[];

/** The contract's default stages (§5); `closing` is always allowed as a terminal stage. */
export const DEFAULT_STAGES: StageDef[] = [
  { key: 'engage', label: 'Engage' }, { key: 'relate', label: 'Relate' }, { key: 'pitch', label: 'Pitch' }, { key: 'next_step', label: 'Next step' },
];
const CLOSING: StageDef = { key: 'closing', label: 'Closing' };

/** "next_step" → "Next step" (a stage key the loaded stage list does not know). */
export function humanizeKey(key: string): string {
  const s = key.replace(/[_-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : key;
}

/** Stage filter options: the workspace master prompt's stages (defaults until one is saved), plus `closing`. */
export function useStageOptions(ws: string | null | undefined): StageDef[] {
  const mp = useMasterPrompt(ws);
  return useMemo(() => {
    const stages = mp.data?.settings?.stages?.length ? mp.data.settings.stages : DEFAULT_STAGES;
    return stages.some((s) => s.key === CLOSING.key) ? stages : [...stages, CLOSING];
  }, [mp.data]);
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------
const SOURCE_TEXT: Record<ChatAiState['source'], string> = {
  chat: 'set for this chat', sequence: 'from sequence', sender: 'from sender', client: 'from client', workspace: 'workspace setting', default: 'default',
};

/** Why the chat is in its mode: "from sequence Fintech CFOs", "sender consent missing", "set for this chat". */
export function modeWhy(s: ChatAiState): string | null {
  if (s.reason_code && s.reason) return s.reason;
  if (s.source === 'sequence' || s.source === 'sender' || s.source === 'client') return s.source_label ? `${SOURCE_TEXT[s.source]} ${s.source_label}` : SOURCE_TEXT[s.source];
  if (s.mode === 'off' && s.source !== 'chat') return null;
  return SOURCE_TEXT[s.source];
}

/** AI replies are LinkedIn only in v1: other channels get no header chip at all. */
export function aiHidden(s: ChatAiState | null | undefined): boolean {
  return !s || (s.mode === 'off' && s.reason_code === 'channel_not_supported');
}

export const PAUSE_WHY: Record<Exclude<ChatAiState['autopilot_state'], 'active'>, string> = {
  paused_human: 'a teammate replied', paused_escalated: 'handed to a person', paused_bot: 'they asked if this is a bot',
};

export function isPaused(s: ChatAiState | null | undefined): s is ChatAiState & { autopilot_state: Exclude<ChatAiState['autopilot_state'], 'active'> } {
  return !!s && s.autopilot_state !== 'active';
}

/** "Paused — a teammate replied until Tue 14:05" */
const PAUSE_REASON: Record<string, string> = {
  teammate_replied: 'a teammate replied', sent_from_phone: 'the sender replied from their phone or LinkedIn',
  hostile_after_ai: 'they reacted badly to an AI reply', fast_replies: 'the other side answers like a bot', auto_responder: 'the other side looks like an auto-responder',
};

export function pausedText(s: ChatAiState & { autopilot_state: Exclude<ChatAiState['autopilot_state'], 'active'> }): string {
  const why = (s.paused_reason && (PAUSE_REASON[s.paused_reason] ?? humanizeKey(s.paused_reason))) || PAUSE_WHY[s.autopilot_state];
  const until = s.paused_until ? ` until ${new Date(s.paused_until).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : '';
  return `Paused — ${why}${until}`;
}

/** "Stage 2 · Relate · 2 exchanges" */
export function stageLine(s: ChatAiState): string | null {
  if (!s.stage) return null;
  return `Stage ${s.stage.position} · ${s.stage.label} · ${s.exchanges} exchange${s.exchanges === 1 ? '' : 's'}`;
}

/** The stage a draft was written in: the chat's stage, plus where the draft moves it ("Stage 1 · Engage → Relate"). */
export function runStageText(run: RunSummary, s: ChatAiState | null | undefined): string | null {
  const cur = s?.stage ? `Stage ${s.stage.position} · ${s.stage.label}` : run.stage_before ? humanizeKey(run.stage_before) : null;
  const curKey = s?.stage?.key ?? run.stage_before;
  const next = run.stage_after && run.stage_after !== curKey ? humanizeKey(run.stage_after) : null;
  if (cur && next) return `${cur} → ${next}`;
  return cur ?? next;
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
 *   the previous run's untouched draft counts as empty, so a newer draft replaces it).
 * - `tag` remembers which run the composer text came from; `runIdForSend()` returns it only while that run can still be
 *   answered (draft ready, scheduled or escalated), so send-reply gets `ai_run_id` only for text that started as that draft.
 * - When the run ends elsewhere (sent, cancelled, superseded), an untouched draft is cleared from the composer so it is not sent twice.
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
    if (cur.trim() && !(t && cur === t.original)) return;   // never overwrite what the user typed
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

  /** Put a draft in the composer (Use draft / Edit / Send this draft). Asks before replacing typed text. */
  const takeDraft = useCallback((r: RunSummary) => {
    const draft = r.draft_text ?? '';
    const { text: cur, tag: t } = live.current;
    if (cur.trim() && !(t && cur === t.original) && cur !== draft && !window.confirm('Replace what you typed with the AI draft?')) return false;
    seen.current = r.id;
    setText(draft);
    setTag({ runId: r.id, original: draft });
    return true;
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
  return { query: q, state, run, last, tag, takeDraft, dropTag, discardDraft, runIdForSend, aiSent, clearAiSent };
}
export type ComposerAi = ReturnType<typeof useComposerAi>;
