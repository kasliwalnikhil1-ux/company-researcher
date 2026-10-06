'use client';

import { useState, type ReactNode } from 'react';
import { Bot, ChevronDown, ExternalLink, Hand, PauseCircle, Play, Square } from 'lucide-react';
import Link from '@/lib/outreach/nav';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { MODE_LABEL, useChatAiState, useResumeAi, useStopAi, type ChatAiState, type ReplyMode, type SessionKind } from '@/lib/outreach/aiReplies';
import { Button, Modal } from '@/components/outreach/ui';
import { aiHidden, DEFAULT_STAGES, handoffLine, isPaused, modeWhy, pausedText } from './useAiInbox';

const MODE_TONE: Record<ReplyMode, string> = {
  off: 'bg-white border-gray-200 text-gray-600',
  draft: 'bg-indigo-50 border-indigo-200 text-indigo-800',
  autopilot: 'bg-emerald-50 border-emerald-200 text-emerald-800',
};

/** One plain sentence per mode: what the AI does with a new message in this chat. */
const MODE_HELP: Record<ReplyMode, string> = {
  off: "The AI doesn't reply in this chat. Draft with AI still works when you ask for it.",
  draft: 'The AI drafts an answer to each new message. Nothing is sent until you send it.',
  autopilot: 'The AI answers new messages on its own.',
};

const SESSION_HELP: Record<Exclude<SessionKind, 'normal'>, string> = {
  returning: 'They came back after a break',
  dormant: 'They went quiet, so the AI is re-engaging them',
};

const capitalize = (s: string | null) => (s ? s[0].toUpperCase() + s.slice(1) : null);

function Row({ label, tip, children }: { label: string; tip?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <dt className={cn('w-14 flex-shrink-0 text-gray-400', tip && 'cursor-help underline decoration-dotted decoration-gray-300 underline-offset-2')} title={tip}>{label}</dt>
      <dd className="min-w-0 flex-1 text-gray-700">{children}</dd>
    </div>
  );
}

/**
 * Where the AI is in the sequence's reply flow, as steps (Engage → Relate → Pitch → Next step) instead of "Stage 1 · Engage".
 * A stage outside the list (Closing, Re-engage) is named under the bar.
 */
function StageProgress({ s }: { s: ChatAiState }) {
  const stages = s.stages?.length ? s.stages : DEFAULT_STAGES;
  const key = s.stage?.key ?? null;
  const at = key ? stages.findIndex((x) => x.key === key) : -1;
  const done = at >= 0 ? at : key && s.stage && s.stage.position > stages.length ? stages.length : -1;
  const note = !s.stage
    ? 'Starts when the AI first replies.'
    : at < 0 ? (key === 're_engage' ? 'Re-engaging: they went quiet for a while.' : `Now: ${s.stage.label}`) : null;
  return (
    <div>
      <div className="text-[11px] text-gray-400 mb-1 cursor-help w-max underline decoration-dotted decoration-gray-300 underline-offset-2"
        title={'The steps the AI follows to move the conversation toward a meeting. You set them on the sequence\'s AI tab.'}>Progress</div>
      <ol className="flex items-start" aria-label="Conversation progress">
        {stages.map((x, i) => {
          const state = i < done ? 'done' : i === at ? 'now' : 'next';
          return (
            <li key={x.key} className="flex-1 min-w-0 flex flex-col items-center" aria-current={state === 'now' ? 'step' : undefined}>
              <div className="w-full flex items-center">
                <span className={cn('h-px flex-1', i === 0 ? 'opacity-0' : i <= done || i === at ? 'bg-indigo-400' : 'bg-gray-200')} />
                <span className={cn('w-2.5 h-2.5 rounded-full flex-shrink-0 border-2', state === 'done' ? 'bg-indigo-500 border-indigo-500' : state === 'now' ? 'bg-white border-indigo-600 ring-2 ring-indigo-100' : 'bg-white border-gray-300')} />
                <span className={cn('h-px flex-1', i === stages.length - 1 ? 'opacity-0' : i < done ? 'bg-indigo-400' : 'bg-gray-200')} />
              </div>
              <span className={cn('mt-1 text-[10px] leading-tight text-center truncate max-w-full px-0.5', state === 'now' ? 'font-semibold text-indigo-700' : state === 'done' ? 'text-gray-600' : 'text-gray-400')} title={x.label}>{x.label}</span>
            </li>
          );
        })}
      </ol>
      {note && <div className="mt-1 text-[11px] text-gray-500">{note}</div>}
    </div>
  );
}

/**
 * Thread header: "AI replies: Review" and a card that explains it in plain words: what the mode does, how far the
 * conversation has got (step bar), how many AI replies are left, and which sequence sets it (link to its AI tab), with
 * Stop AI in this chat / Resume AI. A handed-off chat shows "AI handed off · <reason> · <date>".
 * The mode itself is a sequence setting (no per-chat override).
 */
/** `cramped`: the reason is cut shorter and the replies-left count moves into the menu; `narrow`: the chip shows the mode only. */
export type ChipDensity = 'full' | 'cramped' | 'narrow';

export default function AiModeChip({ chatId, onError, onNotice, density = 'full' }: { chatId: string; onError: (msg: string) => void; onNotice?: (msg: string) => void; density?: ChipDensity }) {
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

  // something that holds the AI back here ("sequence X is paused", "sender consent missing"); the plain sequence case is the "Set by" row
  const issue = st.reason_code && st.reason_code !== 'handed_off' && st.reason_code !== 'off' ? capitalize(modeWhy(st)) : null;
  const left = Math.max(0, (st.max_ai_replies ?? 0) - (st.ai_replies_count ?? 0));
  const handoff = handoffLine(st);
  // a pause only matters where auto is asked for; draft-mode chats never send by themselves anyway
  const paused = isPaused(st) && st.requested_mode === 'autopilot' ? st : null;
  const busy = stop.isPending || resume.isPending;
  const fail = (e: unknown) => onError(parseError(e).message);
  const doStop = () => stop.mutate({ chatId }, { onSuccess: () => { setStopOpen(false); onNotice?.('AI stopped in this chat. A manager can resume it from the AI menu.'); }, onError: fail });
  const doResume = () => resume.mutate({ chatId }, { onSuccess: () => { setResumeOpen(false); onNotice?.('AI resumed in this chat'); }, onError: fail });
  const canStop = canWrite && !st.handed_off && st.mode !== 'off';
  const canResume = isManager && (!!st.handed_off || !!paused);
  const sessionNote = st.session?.kind && st.session.kind !== 'normal' ? `${SESSION_HELP[st.session.kind]} (conversation ${st.session.count})` : null;

  return (
    <>
      <div className="relative">
        <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}
          title={st.handed_off ? `${handoff}\nClick for details.` : `AI replies: ${MODE_LABEL[st.mode]}\n${MODE_HELP[st.mode]}${issue ? `\n${issue}` : ''}\nClick for details.`}
          className={cn('inline-flex items-center gap-1.5 text-xs pl-1.5 pr-1.5 py-1 rounded-full border min-w-0', density === 'full' ? 'max-w-[340px]' : density === 'cramped' ? 'max-w-[220px]' : 'max-w-[160px]', st.handed_off ? 'bg-amber-50 border-amber-200 text-amber-900' : MODE_TONE[st.mode])}>
          {busy ? <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin flex-shrink-0" /> : st.handed_off ? <Hand className="w-3.5 h-3.5 flex-shrink-0" /> : <Bot className="w-3.5 h-3.5 flex-shrink-0" />}
          {st.handed_off
            ? <span className="truncate font-medium">{handoff}</span>
            : <span className="truncate"><span className="opacity-75">{density === 'narrow' ? 'AI:' : 'AI replies:'}</span> <span className="font-medium">{MODE_LABEL[st.mode]}</span></span>}
          {issue && !st.handed_off && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 flex-shrink-0" aria-hidden />}
          <ChevronDown className="w-3 h-3 flex-shrink-0 opacity-60" />
        </button>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <div className="absolute z-30 left-0 mt-1 w-80 bg-white border border-gray-200 rounded-lg shadow-lg py-1" role="menu">
              <div className="px-3 py-2.5 border-b border-gray-100 space-y-2">
                <div className="space-y-0.5">
                  {st.handed_off
                    ? <div className="text-xs font-semibold text-amber-900">{handoff}</div>
                    : <div className="text-xs font-semibold text-gray-900">AI replies: {MODE_LABEL[st.mode]}</div>}
                  <div className="text-[11px] text-gray-600 leading-snug">{st.handed_off ? 'The AI stopped answering in this chat. You reply from here on.' : MODE_HELP[st.mode]}</div>
                  {st.handed_off?.rule && <div className="text-[11px] text-gray-500">Rule: {st.handed_off.rule}</div>}
                  {issue && <div className="text-[11px] text-amber-700 leading-snug">{issue}</div>}
                  {st.requested_mode !== st.mode && !st.handed_off && <div className="text-[11px] text-amber-700 leading-snug">The sequence asks for {MODE_LABEL[st.requested_mode]}, so this chat runs as {MODE_LABEL[st.mode]} for now: {st.reason}</div>}
                </div>
                {!st.handed_off && <StageProgress s={st} />}
                <dl className="space-y-1 text-[11px]">
                  {st.mode !== 'off' && !st.handed_off && (
                    <Row label="Limit" tip="The most replies the AI sends in one chat. After that it stops and leaves the chat to you.">
                      {left} of {st.max_ai_replies ?? 0} AI replies left in this chat
                    </Row>
                  )}
                  {st.sequence_id && st.sequence_name && (
                    <Row label="Set by">
                      <Link href={`/outreach/sequences/${st.sequence_id}?tab=ai`} onClick={() => setOpen(false)} className="inline-flex items-center gap-1 min-w-0 text-indigo-700 hover:underline"
                        title={`Open this sequence's AI tab to change the mode, limit or instructions.${st.master_prompt ? `\nUsing its instructions, version ${st.master_prompt.version}.` : ''}`}>
                        <span className="truncate">{st.sequence_name}</span><ExternalLink className="w-3 h-3 flex-shrink-0" />
                      </Link>
                    </Row>
                  )}
                </dl>
                {sessionNote && <div className="text-[11px] text-gray-500">{sessionNote}</div>}
                {st.warmup_remaining != null && st.warmup_remaining > 0 && st.requested_mode === 'autopilot' && <div className="text-[11px] text-gray-500">Warm-up: the next {st.warmup_remaining} replies wait 30 min so you can check them</div>}
                {!st.master_prompt && st.fallback && <div className="text-[11px] text-gray-400">Draft with AI uses {st.fallback === 'template' ? 'the built-in template' : 'the workspace default instructions'}</div>}
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
                  {st.handed_off ? 'Only owners and managers can resume the AI in a handed-off chat.' : st.mode === 'off' ? 'AI replies are turned on per sequence, on its AI tab.' : 'You can view this setting but not change it.'}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {paused && !st.handed_off && (
        <span className="inline-flex items-center gap-1 text-[11px] text-amber-800 px-1.5 py-0.5 rounded bg-amber-50 border border-amber-200 min-w-0">
          <PauseCircle className="w-3 h-3 flex-shrink-0" /><span className={cn('truncate', density === 'full' ? 'max-w-[260px]' : 'max-w-[120px]')} title={pausedText(paused)}>{pausedText(paused)}</span>
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
