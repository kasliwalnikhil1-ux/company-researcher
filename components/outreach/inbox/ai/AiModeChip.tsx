'use client';

import { useState } from 'react';
import { Bot, Check, ChevronDown, PauseCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { MODE_LABEL, useChatAiState, useResumeChat, useSetChatMode, type ChatAiState, type ReplyMode } from '@/lib/outreach/aiReplies';
import { Button, Modal, Textarea } from '@/components/outreach/ui';
import { aiHidden, isPaused, modeWhy, pausedText, stageLine } from './useAiInbox';

const MODE_TONE: Record<ReplyMode, string> = {
  off: 'bg-white border-gray-200 text-gray-600',
  draft: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  autopilot: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

const OPTIONS: Array<{ mode: ReplyMode | null; label: string; hint: string }> = [
  { mode: null, label: 'Inherit', hint: 'Use the sequence, sender or workspace setting' },
  { mode: 'off', label: 'Off', hint: 'No AI drafts in this chat' },
  { mode: 'draft', label: 'Draft', hint: 'AI writes a draft, a person sends it' },
  { mode: 'autopilot', label: 'Autopilot', hint: 'AI replies on its own after a short wait' },
];

const AUTOPILOT_LOCKED = 'Autopilot is not available for this chat yet. It needs the sender owner’s consent and a master prompt that has passed its trial in Draft mode.';

/**
 * Thread header: the chat's effective AI reply mode and why ("Autopilot · from sequence Fintech CFOs"), its conversation
 * stage, the autopilot pause, and a menu to override the mode for this chat. Managers may pick Autopilot and resume a
 * paused chat; members pick Inherit / Off / Draft; client viewers only see the state.
 */
export default function AiModeChip({ chatId, onError, onNotice }: { chatId: string; onError: (msg: string) => void; onNotice?: (msg: string) => void }) {
  const q = useChatAiState(chatId);
  const s = q.data;
  const { canWrite, isManager } = useWorkspace();
  const setMode = useSetChatMode();
  const resume = useResumeChat();
  const [open, setOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [note, setNote] = useState('');
  if (aiHidden(s)) return null;
  const st = s as ChatAiState;

  const why = modeWhy(st);
  const stage = stageLine(st);
  // a pause only matters where autopilot is asked for; draft-mode chats pause on every human reply by design
  const paused = isPaused(st) && st.requested_mode === 'autopilot' ? st : null;
  const pick = (mode: ReplyMode | null) => {
    setOpen(false);
    if (mode === st.override) return;
    setMode.mutate({ chatId, mode }, {
      onSuccess: (r) => onNotice?.(mode === null ? `AI replies: back to ${MODE_LABEL[r.mode].toLowerCase()} (inherited)` : `AI replies set to ${MODE_LABEL[mode].toLowerCase()} for this chat`),
      onError: (e) => onError(parseError(e).message),
    });
  };
  const closeResume = () => { setResumeOpen(false); setNote(''); };

  return (
    <>
      <div className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
          title={[`AI replies: ${MODE_LABEL[st.mode]}`, why, stage].filter(Boolean).join(' · ')}
          className={cn('inline-flex items-center gap-1.5 text-xs pl-1.5 pr-1.5 py-1 rounded-full border max-w-[320px] min-w-0', MODE_TONE[st.mode])}>
          {setMode.isPending ? <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin flex-shrink-0" /> : <Bot className="w-3.5 h-3.5 flex-shrink-0" />}
          <span className="font-medium flex-shrink-0">{MODE_LABEL[st.mode]}</span>
          {why && <span className="truncate opacity-80">· {why}</span>}
          <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute z-30 left-0 mt-1 w-72 bg-white border border-gray-200 rounded-lg shadow-lg py-1" role="menu">
              <div className="px-3 py-2 border-b border-gray-100 space-y-0.5">
                <div className="text-xs font-semibold text-gray-900">AI replies: {MODE_LABEL[st.mode]}</div>
                {why && <div className="text-[11px] text-gray-500">{why}</div>}
                {st.requested_mode !== st.mode && <div className="text-[11px] text-amber-700">Set to {MODE_LABEL[st.requested_mode]}, running as {MODE_LABEL[st.mode]}: {st.reason}</div>}
                <div className="text-[11px] text-gray-500">{stage ?? 'No stage yet'} · {st.ai_replies_count}/{st.max_ai_replies} AI replies</div>
                {st.master_prompt && <div className="text-[11px] text-gray-400">Master prompt: {st.master_prompt.scope} · v{st.master_prompt.version}</div>}
              </div>
              {canWrite ? OPTIONS.map((o) => {
                const locked = o.mode === 'autopilot' && (!isManager || !st.can_autopilot);
                const title = o.mode === 'autopilot' && !isManager ? 'Only owners and managers can turn on Autopilot.' : o.mode === 'autopilot' && !st.can_autopilot ? AUTOPILOT_LOCKED : o.hint;
                const selected = o.mode === st.override;
                return (
                  <button key={o.label} type="button" role="menuitemradio" aria-checked={selected} disabled={locked} title={title} onClick={() => pick(o.mode)}
                    className={cn('w-full text-left px-3 py-1.5 text-sm flex items-start gap-2 disabled:opacity-40 disabled:cursor-not-allowed', selected ? 'bg-indigo-50 text-indigo-800' : 'text-gray-700 hover:bg-gray-50')}>
                    <Check className={cn('w-3.5 h-3.5 mt-0.5 flex-shrink-0', selected ? 'opacity-100' : 'opacity-0')} />
                    <span className="min-w-0"><span className="block">{o.label}</span><span className="block text-[11px] text-gray-500">{o.hint}</span></span>
                  </button>
                );
              }) : <div className="px-3 py-1.5 text-[11px] text-gray-500">You can view this setting but not change it.</div>}
            </div>
          </>
        )}
      </div>
      {stage && <span className="text-[11px] text-gray-500 px-1.5 py-0.5 rounded bg-white border border-gray-200 whitespace-nowrap" title="Where this conversation is in your master prompt's flow">{stage}</span>}
      {paused && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-800 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 min-w-0">
          <PauseCircle className="w-3 h-3 flex-shrink-0" /><span className="truncate max-w-[260px]" title={pausedText(paused)}>{pausedText(paused)}</span>
          {isManager && <button type="button" onClick={() => setResumeOpen(true)} className="ml-1 font-medium hover:underline">Resume</button>}
        </span>
      )}
      <Modal open={resumeOpen} onClose={closeResume} title="Resume autopilot in this chat" size="sm" footer={<>
        <Button variant="secondary" onClick={closeResume}>Keep paused</Button>
        <Button loading={resume.isPending} disabled={!note.trim()} onClick={() => resume.mutate({ chatId, note: note.trim() }, {
          onSuccess: () => { closeResume(); onNotice?.('Autopilot resumed for this chat'); },
          onError: (e) => onError(parseError(e).message),
        })}>Resume</Button>
      </>}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">{paused ? `${pausedText(paused)}.` : ''} The AI will answer this person&apos;s next message on its own again.</p>
          <Textarea label="Why is it safe to resume? (required)" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={3} autoFocus placeholder="e.g. I answered their contract question, the rest is routine" className="min-h-[72px]" />
        </div>
      </Modal>
    </>
  );
}
