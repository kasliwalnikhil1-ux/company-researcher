'use client';

import { useState } from 'react';
import { Bot, ChevronDown, Hand, PauseCircle, Play, Square } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { MODE_LABEL, SESSION_LABEL, useChatAiState, useResumeAi, useStopAi, type ChatAiState, type ReplyMode } from '@/lib/outreach/aiReplies';
import { Button, Modal } from '@/components/outreach/ui';
import { aiHidden, handoffLine, isPaused, modeWhy, pausedText, repliesLeftText, stageShort } from './useAiInbox';

const MODE_TONE: Record<ReplyMode, string> = {
  off: 'bg-white border-gray-200 text-gray-600',
  draft: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  autopilot: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

/**
 * Thread header: the chat's effective AI reply mode and why ("Draft · from sequence Fintech CFOs"), its stage
 * ("Stage 2 · Relate" or "Re-engage"), how many AI replies are left, and a menu with Stop AI in this chat / Resume AI.
 * A handed-off chat shows "AI handed off · <reason> · <date>". The mode itself is a sequence setting (no per-chat override).
 */
export default function AiModeChip({ chatId, onError, onNotice }: { chatId: string; onError: (msg: string) => void; onNotice?: (msg: string) => void }) {
  const q = useChatAiState(chatId);
  const s = q.data;
  const { canWrite, isManager } = useWorkspace();
  const stop = useStopAi();
  const resume = useResumeAi();
  const [open, setOpen] = useState(false);
  const [stopOpen, setStopOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  if (aiHidden(s)) return null;
  const st = s as ChatAiState;

  const why = modeWhy(st);
  const stage = stageShort(st);
  const handoff = handoffLine(st);
  // a pause only matters where auto is asked for; draft-mode chats never send by themselves anyway
  const paused = isPaused(st) && st.requested_mode === 'autopilot' ? st : null;
  const busy = stop.isPending || resume.isPending;
  const fail = (e: unknown) => onError(parseError(e).message);
  const doStop = () => stop.mutate({ chatId }, { onSuccess: () => { setStopOpen(false); onNotice?.('AI stopped in this chat. A manager can resume it from the AI menu.'); }, onError: fail });
  const doResume = () => resume.mutate({ chatId }, { onSuccess: () => { setResumeOpen(false); onNotice?.('AI resumed in this chat'); }, onError: fail });
  const canStop = canWrite && !st.handed_off && st.mode !== 'off';
  const canResume = isManager && (!!st.handed_off || !!paused);
  const sessionNote = st.session?.kind && st.session.kind !== 'normal' ? `${SESSION_LABEL[st.session.kind]} · session ${st.session.count}` : null;

  return (
    <>
      <div className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
          title={[`AI Auto Replies: ${MODE_LABEL[st.mode]}`, why, stage, repliesLeftText(st)].filter(Boolean).join(' · ')}
          className={cn('inline-flex items-center gap-1.5 text-xs pl-1.5 pr-1.5 py-1 rounded-full border max-w-[340px] min-w-0', st.handed_off ? 'bg-amber-50 border-amber-200 text-amber-900' : MODE_TONE[st.mode])}>
          {busy ? <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin flex-shrink-0" /> : st.handed_off ? <Hand className="w-3.5 h-3.5 flex-shrink-0" /> : <Bot className="w-3.5 h-3.5 flex-shrink-0" />}
          {st.handed_off
            ? <span className="truncate font-medium">{handoff}</span>
            : <><span className="font-medium flex-shrink-0">{MODE_LABEL[st.mode]}</span>{why && <span className="truncate opacity-80">· {why}</span>}</>}
          <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute z-30 left-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg py-1" role="menu">
              <div className="px-3 py-2 border-b border-gray-100 space-y-0.5">
                {st.handed_off
                  ? <div className="text-xs font-semibold text-amber-900">{handoff}</div>
                  : <div className="text-xs font-semibold text-gray-900">AI Auto Replies: {MODE_LABEL[st.mode]}</div>}
                {st.handed_off?.rule && <div className="text-[11px] text-gray-500">Rule: {st.handed_off.rule}</div>}
                {why && !st.handed_off && <div className="text-[11px] text-gray-500">{why}</div>}
                {st.requested_mode !== st.mode && !st.handed_off && <div className="text-[11px] text-amber-700">Sequence set to {MODE_LABEL[st.requested_mode]}, running as {MODE_LABEL[st.mode]}: {st.reason}</div>}
                <div className="text-[11px] text-gray-500">{stage ?? 'No stage yet'} · {repliesLeftText(st)}</div>
                {sessionNote && <div className="text-[11px] text-gray-500">{sessionNote}</div>}
                {st.warmup_remaining != null && st.warmup_remaining > 0 && st.requested_mode === 'autopilot' && <div className="text-[11px] text-gray-500">Warm-up: {st.warmup_remaining} more replies wait 30 min so you can check them</div>}
                {st.master_prompt && <div className="text-[11px] text-gray-400">Prompt: {st.master_prompt.name ?? (st.sequence_name ? `sequence ${st.sequence_name}` : 'workspace default')} · v{st.master_prompt.version}</div>}
                {!st.master_prompt && st.fallback && <div className="text-[11px] text-gray-400">Draft with AI uses {st.fallback === 'template' ? 'the built-in template' : 'the workspace default prompt'}</div>}
              </div>
              {canResume && (
                <button type="button" role="menuitem" onClick={() => { setOpen(false); setResumeOpen(true); }} className="w-full text-left px-3 py-1.5 text-sm flex items-start gap-2 text-gray-700 hover:bg-gray-50">
                  <Play className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-emerald-600" />
                  <span className="min-w-0"><span className="block">Resume AI</span><span className="block text-[11px] text-gray-500">{st.handed_off ? 'The AI answers their next message again (per the sequence setting)' : 'Clear the pause and let the AI reply again'}</span></span>
                </button>
              )}
              {canStop && (
                <button type="button" role="menuitem" onClick={() => { setOpen(false); setStopOpen(true); }} className="w-full text-left px-3 py-1.5 text-sm flex items-start gap-2 text-gray-700 hover:bg-gray-50">
                  <Square className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-red-600" />
                  <span className="min-w-0"><span className="block">Stop AI in this chat</span><span className="block text-[11px] text-gray-500">No more automatic drafts or sends here. Draft with AI still works.</span></span>
                </button>
              )}
              {!canStop && !canResume && (
                <div className="px-3 py-1.5 text-[11px] text-gray-500">
                  {st.handed_off ? 'Only owners and managers can resume the AI in a handed-off chat.' : st.mode === 'off' ? 'AI Auto Replies are turned on per sequence, in the sequence builder.' : 'You can view this setting but not change it.'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {stage && <span className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded bg-white border border-gray-200 whitespace-nowrap" title="Where this conversation is in the prompt's flow">{stage}</span>}
      {!st.handed_off && st.mode !== 'off' && <span className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded bg-white border border-gray-200 whitespace-nowrap hidden sm:inline" title="AI replies used in this session against the sequence's limit">{repliesLeftText(st)}</span>}
      {paused && !st.handed_off && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-800 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 min-w-0">
          <PauseCircle className="w-3 h-3 flex-shrink-0" /><span className="truncate max-w-[260px]" title={pausedText(paused)}>{pausedText(paused)}</span>
          {isManager && <button type="button" onClick={() => setResumeOpen(true)} className="ml-1 font-medium hover:underline">Resume</button>}
        </span>
      )}
      <Modal open={stopOpen} onClose={() => setStopOpen(false)} title="Stop AI in this chat?" size="sm" footer={<>
        <Button variant="secondary" onClick={() => setStopOpen(false)}>Keep it on</Button>
        <Button variant="danger" loading={stop.isPending} onClick={doStop}>Stop AI</Button>
      </>}>
        <p className="text-sm text-gray-600">Any scheduled AI reply in this chat is cancelled and the AI stops drafting here. You can still ask for a draft with Draft with AI. A manager can resume it later from this menu.</p>
      </Modal>
      <Modal open={resumeOpen} onClose={() => setResumeOpen(false)} title="Resume AI in this chat" size="sm" footer={<>
        <Button variant="secondary" onClick={() => setResumeOpen(false)}>Keep it off</Button>
        <Button loading={resume.isPending} onClick={doResume}>Resume</Button>
      </>}>
        <p className="text-sm text-gray-600">
          {st.handed_off ? `${handoff}. ` : paused ? `${pausedText(paused)}. ` : ''}
          The AI will answer this person&apos;s next message again, following the sequence setting ({MODE_LABEL[st.requested_mode].toLowerCase()}). This is recorded in the audit log.
        </p>
      </Modal>
    </>
  );
}
