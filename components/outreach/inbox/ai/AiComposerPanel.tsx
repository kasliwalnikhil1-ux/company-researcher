'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Clock, Hand, Loader2, MessageSquareOff, Send, Pencil, X, Square, RefreshCw, Sparkles, Languages, Undo2, ChevronDown, AlertTriangle, Eye, Flag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import {
  CANCEL_REASONS, fmtCountdown, stopText, warningText, useApplyNoReply, useCancelRun, useComposeAssist, useDraftNow, useSendNow, useStopAi, useTakeManual,
  type CancelReason, type ChatAiState, type DraftNowDraft, type DraftNowResult, type RunSummary, type RunWarning,
} from '@/lib/outreach/aiReplies';
import type { Chat } from '@/lib/outreach/types';
import { Button, Input, Modal, Select, Textarea } from '@/components/outreach/ui';
import { useNow } from '../hooks';
import { escalationText, humanizeKey, languageName, runStageText, sideEffectText, type ComposerAi } from './useAiInbox';

interface PanelProps {
  ai: ComposerAi;
  chat: Pick<Chat, 'id' | 'workspace_id' | 'last_direction'>;
  /** The composer can send (reply permission, sender connected, workspace active). */
  canCompose: boolean;
  onError: (msg: string) => void;
  /** Regenerate on a scheduled auto run: cancels the send first (take_manual), then drafts again. */
  onRegenerate?: () => void;
  regenerating?: boolean;
}

function SideEffects({ run, dark }: { run: Pick<RunSummary, 'side_effects'>; dark?: boolean }) {
  if (!run.side_effects?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className={cn('text-[11px]', dark ? 'text-amber-800' : 'text-gray-500')}>Also:</span>
      {run.side_effects.map((e, i) => <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-white/80 border border-gray-200 text-gray-700">{sideEffectText(e)}</span>)}
    </div>
  );
}

function Meta({ run, ai }: { run: RunSummary; ai: ComposerAi }) {
  const parts = [runStageText(run, ai.state), run.scenario_title, run.rule_applied].filter(Boolean);
  return parts.length ? <span className="text-gray-500">{parts.join(' · ')}</span> : null;
}

function DraftText({ text }: { text: string }) {
  return <div className="text-sm text-gray-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-28 overflow-y-auto rounded-md bg-white/80 border border-gray-200 px-2.5 py-1.5">{text}</div>;
}

/** Cancel a scheduled AI reply: a reason is required (it feeds the prompt review), the note is optional. */
export function CancelRunModal({ open, onClose, onConfirm, busy }: { open: boolean; onClose: () => void; onConfirm: (reason: Exclude<CancelReason, 'dismissed'>, note: string | null) => void; busy: boolean }) {
  const [reason, setReason] = useState<Exclude<CancelReason, 'dismissed'> | ''>('');
  const [note, setNote] = useState('');
  const close = () => { setReason(''); setNote(''); onClose(); };
  return (
    <Modal open={open} onClose={close} title="Cancel this AI reply" size="sm" footer={<>
      <Button variant="secondary" onClick={close}>Keep it</Button>
      <Button variant="danger" loading={busy} disabled={!reason} onClick={() => reason && onConfirm(reason, note.trim() || null)}>Cancel reply</Button>
    </>}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">The reply won&apos;t be sent. Your reason helps improve the prompt.</p>
        <Select label="Why?" value={reason} onChange={(e) => setReason(e.target.value as Exclude<CancelReason, 'dismissed'>)} autoFocus>
          <option value="">Pick a reason…</option>
          {CANCEL_REASONS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </Select>
        <Textarea label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} placeholder="What was wrong with it?" className="min-h-[72px]" />
      </div>
    </Modal>
  );
}

/**
 * What the AI is doing in this chat, shown above the composer: waiting / drafting, the scheduled hold with its countdown
 * (warm-up holds say so), a suggestion to hand over or not reply, and the "AI draft ready · View" pill while the composer
 * holds something else. Client viewers (and members without write access) see the state without the buttons.
 */
export default function AiComposerPanel({ ai, chat, canCompose, onError, onRegenerate, regenerating }: PanelProps) {
  const qc = useQueryClient();
  const { canWrite } = useWorkspace();
  const cancel = useCancelRun();
  const applyNoReply = useApplyNoReply();
  const sendNow = useSendNow();
  const takeManual = useTakeManual();
  const stopAi = useStopAi();
  // the run a modal was opened for: a newer run in the same chat never inherits an open modal
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [stopFor, setStopFor] = useState<string | null>(null);
  const { run, last, tag } = ai;
  const scheduled = run?.status === 'scheduled';
  const now = useNow(1000, scheduled);

  const fail = (e: unknown) => onError(parseError(e).message);
  const dismiss = (r: RunSummary) => cancel.mutate({ chatId: chat.id, runId: r.id, reason: 'dismissed' }, { onSuccess: () => ai.discardDraft(r.id), onError: fail });
  // Edit on a scheduled auto run: the send is cancelled first (draft_ready), then the text goes into the box. Never a double send.
  const editScheduled = (r: RunSummary) => takeManual.mutate({ chatId: chat.id, runId: r.id }, { onSuccess: () => ai.takeDraft({ ...r, status: 'draft_ready', scheduled_send_at: null }), onError: fail });

  if (run?.status === 'debouncing' || run?.status === 'drafting' || run?.status === 'sending') {
    const label = run.status === 'debouncing' ? 'AI is waiting for them to finish typing…' : run.status === 'drafting' ? 'AI is drafting a reply…' : 'AI is sending the reply…';
    return <div className="flex items-center gap-1.5 text-xs text-gray-500 px-1"><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />{label}{run.status !== 'sending' && canWrite && canCompose && onRegenerate && <span className="text-gray-400">· Draft with AI skips the wait</span>}</div>;
  }

  if (run && scheduled) {
    const left = run.scheduled_send_at ? new Date(run.scheduled_send_at).getTime() - now : 0;
    const warmup = !!run.timings?.warmup;
    return (
      <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2 space-y-1.5" role="status">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-indigo-900"><Clock className="w-3.5 h-3.5" />{left > 0 ? `AI will send in ${fmtCountdown(left)}` : 'AI is about to send'}</span>
          {warmup && <span className="text-indigo-800">Warm-up: waits so you can check it</span>}
          <Meta run={run} ai={ai} />
        </div>
        {run.draft_text && <DraftText text={run.draft_text} />}
        {run.stop_after_send && <div className="text-[11px] text-amber-800">{stopText(run.stop_rule)}</div>}
        <SideEffects run={run} />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canCompose && <Button size="sm" loading={sendNow.isPending} disabled={takeManual.isPending || !!regenerating} onClick={() => sendNow.mutate({ chatId: chat.id, runId: run.id }, { onError: fail })}><Send className="w-3.5 h-3.5" /> Send now</Button>}
            {canCompose && run.draft_text && <Button size="sm" variant="secondary" loading={takeManual.isPending} disabled={!!regenerating} onClick={() => editScheduled(run)} title="Cancels the automatic send, then puts the text in the box for you"><Pencil className="w-3.5 h-3.5" /> Edit</Button>}
            {canCompose && onRegenerate && <Button size="sm" variant="secondary" loading={!!regenerating} disabled={takeManual.isPending} onClick={onRegenerate} title="Cancels the automatic send, then drafts again for you to send"><RefreshCw className="w-3.5 h-3.5" /> Regenerate</Button>}
            <Button size="sm" variant="secondary" onClick={() => setCancelFor(run.id)}><X className="w-3.5 h-3.5" /> Cancel</Button>
            <Button size="sm" variant="ghost" onClick={() => setStopFor(run.id)}><Square className="w-3.5 h-3.5" /> Stop AI in this chat</Button>
          </div>
        )}
        <CancelRunModal open={cancelFor === run.id} onClose={() => setCancelFor(null)} busy={cancel.isPending} onConfirm={(reason, note) => cancel.mutate({ chatId: chat.id, runId: run.id, reason, note }, {
          onSuccess: () => { setCancelFor(null); ai.discardDraft(run.id); },
          onError: fail,
        })} />
        <Modal open={stopFor === run.id} onClose={() => setStopFor(null)} title="Stop AI in this chat?" size="sm" footer={<>
          <Button variant="secondary" onClick={() => setStopFor(null)}>Keep it on</Button>
          <Button variant="danger" loading={stopAi.isPending} onClick={() => stopAi.mutate({ chatId: chat.id }, { onSuccess: () => { setStopFor(null); ai.discardDraft(run.id); }, onError: fail })}>Stop AI</Button>
        </>}>
          <p className="text-sm text-gray-600">The scheduled reply won&apos;t be sent and the AI stops drafting in this chat. A manager can resume it from the AI menu at the top; Draft with AI keeps working.</p>
        </Modal>
      </div>
    );
  }

  if (run?.status === 'draft_ready' && run.decision === 'escalate') {
    // Once the draft sits in the composer, the strip above the box shows the reason, side effects and Dismiss: no second card.
    if (tag?.runId === run.id) return null;
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-amber-900"><Hand className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span><span className="font-medium">AI suggests handing this to a person:</span> {escalationText(run.escalation_reasons)}</span></div>
        {run.draft_text && <DraftText text={run.draft_text} />}
        <SideEffects run={run} dark />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canCompose && run.draft_text && <Button size="sm" variant="secondary" onClick={() => ai.takeDraft(run)}><Pencil className="w-3.5 h-3.5" /> Use draft</Button>}
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => dismiss(run)}>Dismiss</Button>
          </div>
        )}
      </div>
    );
  }

  if (run?.status === 'draft_ready' && run.decision === 'no_reply') {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-gray-800"><MessageSquareOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-500" /><span><span className="font-medium">AI suggests not replying</span>{run.rule_applied ? `: ${run.rule_applied}` : ''}</span></div>
        <SideEffects run={run} />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" loading={applyNoReply.isPending} title={run.side_effects?.length ? 'Do what the AI suggests (listed above)' : 'Close this suggestion without replying'}
              onClick={() => applyNoReply.mutate({ chatId: chat.id, runId: run.id }, { onSuccess: () => qc.invalidateQueries({ queryKey: ['outreach', chat.workspace_id, 'chats'] }), onError: fail })}>Apply</Button>
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => dismiss(run)}>Dismiss</Button>
          </div>
        )}
      </div>
    );
  }

  // A draft is ready but the composer holds something the user typed: a small pill, never an overwrite.
  if (run?.status === 'draft_ready' && run.decision === 'send' && run.draft_text && tag?.runId !== run.id) {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-full border border-indigo-100 bg-indigo-50/70 pl-2.5 pr-1.5 py-1 text-xs w-fit max-w-full" role="status">
        <span className="inline-flex items-center gap-1 font-medium text-indigo-900"><Bot className="w-3.5 h-3.5" />AI draft ready</span>
        <span className="text-gray-600 truncate max-w-[260px]" title={run.draft_text}>{run.draft_text}</span>
        {canWrite && canCompose && <button type="button" onClick={() => ai.takeDraft(run)} className="inline-flex items-center gap-1 rounded-full bg-white border border-indigo-200 px-2 py-0.5 text-indigo-700 hover:bg-indigo-100"><Eye className="w-3 h-3" /> View</button>}
        {canWrite && <button type="button" disabled={cancel.isPending} onClick={() => dismiss(run)} className="text-gray-500 hover:text-gray-800 px-1">Dismiss</button>}
      </div>
    );
  }

  // The AI handed the chat over on an escalation; shown until someone answers the prospect.
  if (!run && last?.status === 'escalated' && chat.last_direction !== 'out') {
    if (tag?.runId === last.id) return null; // the strip above the box says "AI handed off" and why
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-amber-900"><Hand className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span><span className="font-medium">Handed to a person:</span> {escalationText(last.escalation_reasons)}</span></div>
        {last.draft_text && <DraftText text={last.draft_text} />}
        {canWrite && canCompose && last.draft_text && (
          <div><Button size="sm" variant="secondary" onClick={() => ai.takeDraft(last)}><Pencil className="w-3.5 h-3.5" /> Send this draft</Button></div>
        )}
      </div>
    );
  }

  // A handed-off chat: the header chip says why; nothing else to show here.
  return null;
}

// ---------------------------------------------------------------------------
// Draft with AI (contract §6 draft_now; changes doc §5.5 composer)
// ---------------------------------------------------------------------------
/** What the meta strip shows for the draft in the box, from a run summary or a draft_now result. */
export interface DraftMeta {
  runId: string;
  stageBefore: string | null;
  stageAfter: string | null;
  scenarioTitle: string | null;
  version: number | null;
  warnings: RunWarning[];
  wouldStop: boolean;
  stopRule: string | null;
  ruleApplied: string | null;
  trigger: 'auto' | 'manual';
  guidance: string | null;
  status: string;
  decision: string | null;
  escalationReasons: string[];
  sideEffects: RunSummary['side_effects'];
  createdAt: string | null;
}

export function metaFromRun(r: RunSummary): DraftMeta {
  return {
    runId: r.id, stageBefore: r.stage_before, stageAfter: r.stage_after, scenarioTitle: r.scenario_title ?? null, version: r.master_prompt_version,
    warnings: r.warnings ?? [], wouldStop: !!r.stop_after_send, stopRule: r.stop_rule, ruleApplied: r.rule_applied, trigger: r.trigger ?? 'auto', guidance: r.guidance,
    status: r.status, decision: r.decision, escalationReasons: r.escalation_reasons ?? [], sideEffects: r.side_effects, createdAt: r.created_at,
  };
}

export function metaFromDraft(d: DraftNowDraft, scenarioTitle: string | null = null): DraftMeta {
  return {
    runId: d.run_id, stageBefore: d.stage_before, stageAfter: d.stage_after, scenarioTitle: d.scenario_title ?? scenarioTitle, version: d.version,
    warnings: d.warnings ?? [], wouldStop: !!d.would_stop, stopRule: d.stop_rule, ruleApplied: d.rule_applied, trigger: d.trigger ?? 'manual', guidance: d.guidance,
    status: d.status, decision: d.decision, escalationReasons: d.escalation_reasons ?? [], sideEffects: d.side_effects, createdAt: null,
  };
}

/** "Stage 2 · Relate" for the stage the draft lands in; "Re-engage" for a dormant session with no stage yet. */
export function metaStage(m: DraftMeta, s: ChatAiState | null): string | null {
  const key = m.stageAfter ?? m.stageBefore ?? s?.stage?.key ?? null;
  if (!key) return s?.stage?.label ?? null;
  if (key === 're_engage') return 'Re-engage';
  const found = (s?.stages ?? []).find((x) => x.key === key);
  if (found) return found.label;
  if (s?.stage?.key === key) return s.stage.label;
  return humanizeKey(key);
}

export type DraftPlacement = 'replace' | 'insert';

/**
 * Draft with AI for one composer: `request()` runs draft_now and places the text; a scheduled auto run is taken over
 * (take_manual) first so it never sends by itself; results are kept per run id for the meta strip until the chat state
 * catches up with the new run.
 */
export function useDraftWithAi(ai: ComposerAi, chatId: string, onError: (msg: string) => void) {
  const draftNow = useDraftNow();
  const takeManual = useTakeManual();
  const [results, setResults] = useState<Record<string, { draft: DraftNowDraft; prompt: DraftNowResult['prompt'] }>>({});
  const [variants, setVariants] = useState<Array<{ runId: string; text: string }>>([]);

  const request = useCallback(async (opts: { guidance?: string | null; regenerate?: boolean; placement?: DraftPlacement; variants?: number } = {}) => {
    const run = ai.run;
    try {
      // a scheduled auto send is cancelled before anything else happens (its text may end up in the box): no double send
      if (run?.status === 'scheduled') await takeManual.mutateAsync({ chatId, runId: run.id });
      // a run still being debounced / drafted is cancelled by the server (taken_manual) when we ask for a fresh draft
      const regenerate = !!opts.regenerate || run?.status === 'debouncing' || run?.status === 'drafting';
      const res = await draftNow.mutateAsync({ chatId, guidance: opts.guidance ?? null, regenerate, variants: opts.variants });
      const d = res.drafts.find((x) => !x.variant) ?? res.drafts[0];
      if (!d?.text) { onError('The AI did not return a draft for this conversation.'); return null; }
      setResults((old) => ({ ...old, [res.run_id]: { draft: d, prompt: res.prompt } }));
      setVariants(res.drafts.filter((x) => x.variant && x.text).map((x) => ({ runId: res.run_id, text: x.text as string })));
      ai.placeDraft(res.run_id, d.text, opts.placement ?? 'replace');
      return res;
    } catch (e) {
      onError(parseError(e).message);
      return null;
    }
  }, [ai, chatId, draftNow, takeManual, onError]);

  /** The meta for the run whose text is in the box: the chat state's run summary when it knows it, else the draft_now result. */
  const meta = useMemo<DraftMeta | null>(() => {
    const id = ai.tag?.runId;
    if (!id) return null;
    const fromState = ai.run?.id === id ? ai.run : ai.last?.id === id ? ai.last : null;
    const local = results[id];
    if (fromState) return { ...metaFromRun(fromState), ...(local && !fromState.warnings?.length && local.draft.warnings?.length ? { warnings: local.draft.warnings } : {}) };
    return local ? metaFromDraft(local.draft) : null;
  }, [ai.tag?.runId, ai.run, ai.last, results]);
  const prompt = ai.tag ? results[ai.tag.runId]?.prompt ?? null : null;

  return { request, meta, prompt, variants, busy: draftNow.isPending || takeManual.isPending };
}
export type DraftWithAi = ReturnType<typeof useDraftWithAi>;

type DraftChat = Pick<Chat, 'id' | 'last_message_at' | 'last_direction' | 'attendee_name'>;

/** What the composer shows about the AI draft in the box; null while the box holds no AI draft. */
function draftView(ai: ComposerAi, draft: DraftWithAi, chat: DraftChat, text: string) {
  const m = draft.meta;
  if (!m || !ai.tag) return null;
  const s = ai.state;
  const promptNote = draft.prompt?.fallback === 'template' ? 'built-in template' : draft.prompt?.fallback === 'workspace_default' ? 'workspace default prompt' : s?.fallback === 'template' ? 'built-in template' : s?.fallback === 'workspace_default' ? 'workspace default prompt' : null;
  // one line: "Relate · Pricing question · “shorter”"; the instructions version only shows in the hover text
  const details = [metaStage(m, s), m.scenarioTitle, m.guidance ? `“${m.guidance}”` : null, promptNote, m.ruleApplied && !m.scenarioTitle ? m.ruleApplied : null]
    .filter(Boolean).join(' · ');
  const detailsTip = [details, m.version != null ? `Sequence instructions, version ${m.version}` : null].filter(Boolean).join('\n');
  // The engine already emits one warning per escalation reason; fold those into the single "handed to a person" line
  // (keeping the engine's more specific text, e.g. the unsupported claim) instead of listing the same reason twice.
  const escalating = m.decision === 'escalate' && m.escalationReasons.length > 0;
  const reasonSet = new Set(escalating ? m.escalationReasons : []);
  const escalationWarnings = escalating
    ? [{ code: 'escalate', text: `${m.trigger === 'manual' ? 'The AI would have handed this to a person' : 'AI suggests handing this to a person'}: ${m.escalationReasons.map((r) => m.warnings.find((w) => w.code === r)?.text?.trim() || escalationText([r])).join('; ')}` }]
    : [];
  return {
    m,
    details,
    detailsTip,
    edited: text !== ai.tag.original,
    handedOff: !!s?.handed_off,
    // a newer message from them arrived after this manual draft was written: never a silent replace
    newer: !!(m.trigger === 'manual' && m.createdAt && chat.last_direction === 'in' && chat.last_message_at && new Date(chat.last_message_at).getTime() > new Date(m.createdAt).getTime()),
    warnings: [...escalationWarnings, ...m.warnings.filter((w) => !reasonSet.has(w.code))],
  };
}

/**
 * One line beside the Reply / Private note tabs while the box holds an AI draft: "✦ AI draft · Relate",
 * the stop rule as a flag (wide composers), and Dismiss. Warnings sit inside the box (AiDraftNotes); redraft options
 * are on the Draft with AI button's menu.
 */
export function AiDraftSummary({ ai, draft, chat, text, onError, compact, stopInline }: { ai: ComposerAi; draft: DraftWithAi; chat: DraftChat; text: string; onError: (msg: string) => void; compact?: boolean; stopInline?: boolean }) {
  const { canWrite } = useWorkspace();
  const cancel = useCancelRun();
  const v = draftView(ai, draft, chat, text);
  if (!v) return null;
  const { m } = v;
  const canDismiss = canWrite && m.status === 'draft_ready';
  return (
    <div className="ml-auto flex items-center gap-1.5 min-w-0 text-[11px]" role="status">
      <span className="inline-flex items-center gap-1 font-medium text-indigo-700 flex-shrink-0"><Sparkles className="w-3.5 h-3.5" />AI draft{v.edited ? ', edited' : ''}</span>
      {v.details && <span className="truncate text-gray-500 min-w-0" title={v.detailsTip}>· {v.details}</span>}
      {m.wouldStop && stopInline && (
        <span className="inline-flex items-center gap-1 text-amber-800 min-w-0 max-w-[45%]" title={stopText(m.stopRule)}><Flag className="w-3 h-3 flex-shrink-0" /><span className="truncate">{stopText(m.stopRule)}</span></span>
      )}
      {canDismiss && (
        <button type="button" className="flex-shrink-0 ml-1 text-gray-500 hover:text-gray-800 hover:underline disabled:opacity-50" disabled={cancel.isPending} title="Dismiss the AI draft" aria-label="Dismiss the AI draft"
          onClick={() => cancel.mutate({ chatId: chat.id, runId: m.runId, reason: 'dismissed' }, { onSuccess: () => ai.discardDraft(m.runId), onError: (e) => onError(parseError(e).message) })}>
          {cancel.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : compact ? <X className="w-3.5 h-3.5" /> : 'Dismiss'}
        </button>
      )}
    </div>
  );
}

/** Inside the reply box, above the text: what to check before sending this AI draft (only when there is something). */
export function AiDraftNotes({ ai, draft, chat, text, stopInline }: { ai: ComposerAi; draft: DraftWithAi; chat: DraftChat; text: string; stopInline?: boolean }) {
  const v = draftView(ai, draft, chat, text);
  if (!v) return null;
  const { m } = v;
  const stop = m.wouldStop && !stopInline;   // wide composers show it on the summary line instead
  const effects = m.status === 'draft_ready' && !!m.sideEffects?.length;
  if (!v.handedOff && !v.warnings.length && !stop && !v.newer && !effects) return null;
  return (
    <div className="px-3 pt-1.5 space-y-0.5">
      {v.handedOff && <div className="text-[11px] text-amber-800 inline-flex items-center gap-1"><Hand className="w-3 h-3" /> AI handed off: this draft is for you to send</div>}
      {v.warnings.map((w, i) => <div key={i} className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" /><span>{warningText(w)}</span></div>)}
      {stop && <div className="text-[11px] text-amber-800 flex items-start gap-1"><Flag className="w-3 h-3 mt-0.5 flex-shrink-0" /><span>{stopText(m.stopRule)}</span></div>}
      {v.newer && <div className="text-[11px] text-amber-800">New message from {chat.attendee_name ?? 'them'} since this draft was written. Regenerate?</div>}
      {effects && <SideEffects run={{ side_effects: m.sideEffects }} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer buttons: Draft with AI ▾ (redraft options) · Improve my text · Translate ▾
// ---------------------------------------------------------------------------
export interface AssistUndo { prev: string; label: 'Improve my text' | 'Translate'; warnings: RunWarning[]; language?: string | null }

export function AiComposerActions({ ai, draft, chatId, text, setText, prospectLanguage, disabled, onError, undo, setUndo, compact, wide }: {
  ai: ComposerAi; draft: DraftWithAi; chatId: string; text: string; setText: (t: string) => void; prospectLanguage: string | null; disabled?: boolean;
  onError: (msg: string) => void; undo: AssistUndo | null; setUndo: (u: AssistUndo | null) => void;
  /** a narrow composer: icons only (the labels move into the titles) */
  compact?: boolean;
  /** a wide composer: Improve and Translate show their labels (otherwise icons) */
  wide?: boolean;
}) {
  const { canWrite } = useWorkspace();
  const assist = useComposeAssist();
  const [placement, setPlacement] = useState<{ open: boolean; regenerate: boolean }>({ open: false, regenerate: false });
  const [translateOpen, setTranslateOpen] = useState(false);
  const [redraftOpen, setRedraftOpen] = useState(false);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState('');
  const [custom, setCustom] = useState('');
  const typed = text.trim();
  const holdsDraft = !!ai.tag && (typed === ai.tag.original.trim() || typed === '');
  const hasOwnText = !!typed && !holdsDraft;
  const mainLabel = ai.tag && typed ? 'Regenerate' : 'Draft with AI';
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);
  // redraft options (shorter, more formal, an instruction, the other variants) while the box holds an AI draft
  const canRedraft = canWrite && !!draft.meta;
  const variants = draft.meta && draft.variants.length > 0 && draft.variants[0].runId === draft.meta.runId ? draft.variants : [];

  /** Draft with AI (button or ⌘/Ctrl+J): typed text asks Replace / Insert below / Cancel first. */
  const start = useCallback(() => {
    if (disabled || draft.busy) return;
    const regenerate = !!ai.tag && !!text.trim();
    if (hasOwnText) { setPlacement({ open: true, regenerate }); return; }
    void draft.request({ regenerate });
  }, [disabled, draft, ai.tag, text, hasOwnText]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && (e.key === 'j' || e.key === 'J')) { e.preventDefault(); start(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [start]);

  const runAssist = (kind: 'improve' | 'translate_out', language?: string | null) => {
    if (!typed) return;
    assist.mutate({ chatId, kind, text, language }, {
      onSuccess: (r) => {
        setUndo({ prev: text, label: kind === 'improve' ? 'Improve my text' : 'Translate', warnings: r.warnings ?? [], language: r.language });
        setText(r.text);
      },
      onError: (e) => onError(parseError(e).message),
    });
  };
  const redraft = (guidance?: string) => { setRedraftOpen(false); void draft.request({ regenerate: true, guidance }); };
  const langChips = Array.from(new Set([prospectLanguage, 'en'].filter((x): x is string => !!x && x !== 'und')));
  const aiBtn = 'inline-flex items-center gap-1.5 text-xs font-medium py-1.5 border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap';
  const menuItem = 'w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50';

  return (
    <>
      <div className="relative inline-flex">
        <button type="button" disabled={disabled || draft.busy} onClick={start} title={`${mainLabel} (${isMac ? '⌘' : 'Ctrl'}+J)`} aria-label={mainLabel}
          className={cn(aiBtn, compact ? 'px-2' : 'px-2.5', canRedraft ? 'rounded-l-lg' : 'rounded-lg')}>
          {draft.busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}{!compact && mainLabel}
        </button>
        {canRedraft && (
          <button type="button" disabled={disabled || draft.busy} onClick={() => setRedraftOpen((o) => !o)} title="Redraft: shorter, more formal, with an instruction" aria-label="Redraft options" aria-haspopup="menu" aria-expanded={redraftOpen}
            className={cn(aiBtn, 'px-1 rounded-r-lg border-l-0')}>
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
        {redraftOpen && canRedraft && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setRedraftOpen(false)} />
            <div className="absolute z-30 left-0 bottom-full mb-1 w-56 bg-white border border-gray-200 rounded-lg shadow-lg py-1" role="menu">
              <div className="px-3 pt-1 pb-0.5 text-[11px] text-gray-500">Redraft</div>
              <button type="button" role="menuitem" className={cn(menuItem, 'flex items-center gap-2')} onClick={() => redraft()}><RefreshCw className="w-3.5 h-3.5 text-gray-400" /> Regenerate</button>
              <button type="button" role="menuitem" className={menuItem} onClick={() => redraft('shorter')}>Shorter</button>
              <button type="button" role="menuitem" className={menuItem} onClick={() => redraft('more formal')}>More formal</button>
              <button type="button" role="menuitem" className={menuItem} onClick={() => { setRedraftOpen(false); setInstructionOpen(true); }}>With an instruction…</button>
              {variants.length > 0 && (
                <>
                  <div className="px-3 pt-1.5 pb-0.5 mt-1 border-t border-gray-100 text-[11px] text-gray-500">Other versions</div>
                  {variants.map((v, i) => (
                    <button key={i} type="button" role="menuitem" className={cn(menuItem, 'truncate')} title={v.text} onClick={() => { setRedraftOpen(false); ai.placeDraft(v.runId, v.text); }}>Variant {i + 2} <span className="text-gray-400">· {v.text}</span></button>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
      <Button type="button" variant="ghost" size="sm" className={wide ? undefined : 'px-2'} loading={assist.isPending && assist.variables?.kind === 'improve'} disabled={disabled || !typed || assist.isPending} onClick={() => runAssist('improve')} aria-label="Improve my text" title="Improve my text: rewrite what you typed in the prompt's style. Meaning kept; new facts are flagged, never added.">
        <Pencil className="w-4 h-4" />{wide && 'Improve my text'}
      </Button>
      <div className="relative">
        <Button type="button" variant="ghost" size="sm" className={cn('gap-1', !wide && 'px-1.5')} loading={assist.isPending && assist.variables?.kind === 'translate_out'} disabled={disabled || !typed || assist.isPending} onClick={() => setTranslateOpen((o) => !o)} title="Translate what you typed. The original is kept for Undo." aria-label="Translate" aria-haspopup="menu" aria-expanded={translateOpen}>
          <Languages className="w-4 h-4" />{wide && ' Translate'}{!compact && <ChevronDown className="w-3 h-3 opacity-60" />}
        </Button>
        {translateOpen && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setTranslateOpen(false)} />
            <div className="absolute z-30 left-0 bottom-full mb-1 w-64 bg-white border border-gray-200 rounded-lg shadow-lg p-2 space-y-1.5" role="menu">
              <div className="text-[11px] text-gray-500 px-1">Translate to</div>
              <div className="flex flex-wrap gap-1">
                {langChips.map((c) => (
                  <button key={c} type="button" role="menuitem" onClick={() => { setTranslateOpen(false); runAssist('translate_out', c); }} className="text-xs px-2 py-1 rounded-full border border-gray-200 hover:bg-gray-50 text-gray-700">
                    {languageName(c)}{c === prospectLanguage ? ' (theirs)' : ''}
                  </button>
                ))}
              </div>
              <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const c = custom.trim().toLowerCase(); if (/^[a-z]{2,3}$/.test(c)) { setTranslateOpen(false); setCustom(''); runAssist('translate_out', c); } else onError('Use a two-letter language code, like fr or de.'); }}>
                <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="Other code, e.g. fr" aria-label="Language code" className="text-xs py-1" />
                <Button type="submit" size="sm" variant="secondary" disabled={!custom.trim()}>Go</Button>
              </form>
            </div>
          </>
        )}
      </div>
      {undo && (
        <button type="button" onClick={() => { setText(undo.prev); setUndo(null); }} className="inline-flex items-center gap-1 text-[11px] text-gray-600 hover:text-gray-900 hover:underline px-1" title={`Back to your text before ${undo.label}`}>
          <Undo2 className="w-3 h-3" /> Undo
        </button>
      )}
      <Modal open={placement.open} onClose={() => setPlacement({ open: false, regenerate: false })} title="You have text in the box" size="sm" footer={<>
        <Button variant="secondary" onClick={() => setPlacement({ open: false, regenerate: false })}>Cancel</Button>
        <Button variant="secondary" onClick={() => { const r = placement.regenerate; setPlacement({ open: false, regenerate: false }); void draft.request({ regenerate: r, placement: 'insert' }); }}>Insert below</Button>
        <Button onClick={() => { const r = placement.regenerate; setPlacement({ open: false, regenerate: false }); void draft.request({ regenerate: r, placement: 'replace' }); }}>Replace</Button>
      </>}>
        <p className="text-sm text-gray-600">Replace what you typed with the AI draft, or add the draft below it?</p>
      </Modal>
      <Modal open={instructionOpen} onClose={() => setInstructionOpen(false)} title="Redraft with an instruction" size="sm" footer={<>
        <Button variant="secondary" onClick={() => setInstructionOpen(false)}>Cancel</Button>
        <Button loading={draft.busy} disabled={!instruction.trim()} onClick={async () => { const g = instruction.trim(); setInstructionOpen(false); setInstruction(''); await draft.request({ regenerate: true, guidance: g }); }}>Redraft</Button>
      </>}>
        <Textarea label="Instruction (up to 300 characters)" value={instruction} onChange={(e) => setInstruction(e.target.value.slice(0, 300))} rows={3} autoFocus placeholder="e.g. ask about their budget, mention the Thursday slot" counter={{ max: 300, value: instruction.length }} className="min-h-[72px]" />
      </Modal>
    </>
  );
}

/** Warnings from Improve / Translate, shown inside the box under the text until it is emptied or sent. */
export function AssistWarnings({ undo }: { undo: AssistUndo | null }) {
  if (!undo) return null;
  return (
    <div className="px-3 pb-1 space-y-0.5">
      <div className="text-[11px] text-gray-500">{undo.label === 'Translate' ? `Translated to ${languageName(undo.language)}.` : 'Rewritten in the prompt’s style.'} Undo keeps your original.</div>
      {undo.warnings.map((w, i) => <div key={i} className="text-[11px] text-amber-800 flex items-start gap-1"><AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" /><span>{warningText(w)}</span></div>)}
    </div>
  );
}
