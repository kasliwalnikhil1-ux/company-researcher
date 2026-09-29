'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Bot, Clock, Hand, Loader2, MessageSquareOff, Send, Pencil, X, Power } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError } from '@/lib/outreach/api';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { CANCEL_REASONS, fmtCountdown, useApplyNoReply, useCancelRun, useSendNow, useSetChatMode, type CancelReason, type RunSummary } from '@/lib/outreach/aiReplies';
import type { Chat } from '@/lib/outreach/types';
import { Button, Modal, Select, Textarea } from '@/components/outreach/ui';
import { useNow } from '../hooks';
import { escalationText, runStageText, sideEffectText, type ComposerAi } from './useAiInbox';

interface PanelProps {
  ai: ComposerAi;
  chat: Pick<Chat, 'id' | 'workspace_id' | 'last_direction'>;
  /** The composer can send (reply permission, sender connected, workspace active). */
  canCompose: boolean;
  onError: (msg: string) => void;
}

function SideEffects({ run, dark }: { run: RunSummary; dark?: boolean }) {
  if (!run.side_effects?.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className={cn('text-[11px]', dark ? 'text-amber-800' : 'text-gray-500')}>Also:</span>
      {run.side_effects.map((e, i) => <span key={i} className="text-[11px] px-1.5 py-0.5 rounded bg-white/80 border border-gray-200 text-gray-700">{sideEffectText(e)}</span>)}
    </div>
  );
}

function Meta({ run, ai }: { run: RunSummary; ai: ComposerAi }) {
  const parts = [runStageText(run, ai.state), run.rule_applied].filter(Boolean);
  return parts.length ? <span className="text-gray-500">{parts.join(' · ')}</span> : null;
}

function DraftText({ text }: { text: string }) {
  return <div className="text-sm text-gray-800 whitespace-pre-wrap break-words [overflow-wrap:anywhere] max-h-40 overflow-y-auto rounded-md bg-white/80 border border-gray-200 px-2.5 py-1.5">{text}</div>;
}

/** Cancel a scheduled AI reply: a reason is required (it feeds the master-prompt review), the note is optional. */
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
        <p className="text-sm text-gray-600">The reply won&apos;t be sent. Your reason helps improve the master prompt.</p>
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
 * What the AI is doing in this chat, shown above the composer: waiting / drafting, the scheduled hold with its countdown,
 * a suggestion to hand over or not reply, and a draft that is ready while the composer holds something else.
 * Client viewers (and members without write access) see the state without the buttons.
 */
export default function AiComposerPanel({ ai, chat, canCompose, onError }: PanelProps) {
  const qc = useQueryClient();
  const { canWrite } = useWorkspace();
  const cancel = useCancelRun();
  const applyNoReply = useApplyNoReply();
  const sendNow = useSendNow();
  const setMode = useSetChatMode();
  // the run a modal was opened for: a newer run in the same chat never inherits an open modal
  const [cancelFor, setCancelFor] = useState<string | null>(null);
  const [offFor, setOffFor] = useState<string | null>(null);
  const { run, last, tag } = ai;
  const scheduled = run?.status === 'scheduled';
  const now = useNow(1000, scheduled);

  const fail = (e: unknown) => onError(parseError(e).message);
  const dismiss = (r: RunSummary) => cancel.mutate({ chatId: chat.id, runId: r.id, reason: 'dismissed' }, { onSuccess: () => ai.discardDraft(r.id), onError: fail });

  if (run?.status === 'debouncing' || run?.status === 'drafting' || run?.status === 'sending') {
    const label = run.status === 'debouncing' ? 'AI is waiting for them to finish typing…' : run.status === 'drafting' ? 'AI is drafting a reply…' : 'AI is sending the reply…';
    return <div className="flex items-center gap-1.5 text-xs text-gray-500 px-1"><Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />{label}</div>;
  }

  if (run && scheduled) {
    const left = run.scheduled_send_at ? new Date(run.scheduled_send_at).getTime() - now : 0;
    const editing = tag?.runId === run.id;
    return (
      <div className="rounded-lg border border-indigo-200 bg-indigo-50/70 px-3 py-2 space-y-1.5" role="status">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
          <span className="inline-flex items-center gap-1 font-medium text-indigo-900"><Clock className="w-3.5 h-3.5" />{left > 0 ? `AI will send in ${fmtCountdown(left)}` : 'AI is about to send'}</span>
          <Meta run={run} ai={ai} />
        </div>
        {run.draft_text && <DraftText text={run.draft_text} />}
        <SideEffects run={run} />
        {editing && <p className="text-[11px] text-amber-700">Editing: the AI still sends its own version when the timer ends. Send yours first, or press Cancel.</p>}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canCompose && !editing && <Button size="sm" loading={sendNow.isPending} onClick={() => sendNow.mutate({ chatId: chat.id, runId: run.id }, { onError: fail })}><Send className="w-3.5 h-3.5" /> Send now</Button>}
            {canCompose && run.draft_text && !editing && <Button size="sm" variant="secondary" onClick={() => ai.takeDraft(run)}><Pencil className="w-3.5 h-3.5" /> Edit</Button>}
            <Button size="sm" variant="secondary" onClick={() => setCancelFor(run.id)}><X className="w-3.5 h-3.5" /> Cancel</Button>
            <Button size="sm" variant="ghost" onClick={() => setOffFor(run.id)}><Power className="w-3.5 h-3.5" /> Turn off for this chat</Button>
          </div>
        )}
        <CancelRunModal open={cancelFor === run.id} onClose={() => setCancelFor(null)} busy={cancel.isPending} onConfirm={(reason, note) => cancel.mutate({ chatId: chat.id, runId: run.id, reason, note }, {
          onSuccess: () => { setCancelFor(null); ai.discardDraft(run.id); },
          onError: fail,
        })} />
        <Modal open={offFor === run.id} onClose={() => setOffFor(null)} title="Turn off AI replies for this chat?" size="sm" footer={<>
          <Button variant="secondary" onClick={() => setOffFor(null)}>Keep on</Button>
          <Button variant="danger" loading={setMode.isPending} onClick={() => setMode.mutate({ chatId: chat.id, mode: 'off' }, { onSuccess: () => setOffFor(null), onError: fail })}>Turn off</Button>
        </>}>
          <p className="text-sm text-gray-600">The scheduled reply won&apos;t be sent and the AI won&apos;t draft in this chat until someone turns it back on from the AI menu at the top.</p>
        </Modal>
      </div>
    );
  }

  if (run?.status === 'draft_ready' && run.decision === 'escalate') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-amber-900"><Hand className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span><span className="font-medium">AI suggests handing this to a person:</span> {escalationText(run.escalation_reasons)}</span></div>
        {run.draft_text && <DraftText text={run.draft_text} />}
        <SideEffects run={run} dark />
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canCompose && run.draft_text && tag?.runId !== run.id && <Button size="sm" variant="secondary" onClick={() => ai.takeDraft(run)}><Pencil className="w-3.5 h-3.5" /> Use draft</Button>}
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => dismiss(run)}>Dismiss</Button>
          </div>
        )}
      </div>
    );
  }

  if (run?.status === 'draft_ready' && run.decision === 'no_reply') {
    return (
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-gray-800"><MessageSquareOff className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-500" /><span><span className="font-medium">AI suggests not replying</span>{run.rule_applied ? ` — ${run.rule_applied}` : ''}</span></div>
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

  // A draft is ready but the composer holds something the user typed: offer it instead of overwriting.
  if (run?.status === 'draft_ready' && run.decision === 'send' && run.draft_text && tag?.runId !== run.id) {
    return (
      <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 px-3 py-2 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs"><span className="inline-flex items-center gap-1 font-medium text-indigo-900"><Bot className="w-3.5 h-3.5" />AI has a draft ready</span><Meta run={run} ai={ai} /></div>
        <div className="text-xs text-gray-700 line-clamp-2 whitespace-pre-wrap">{run.draft_text}</div>
        {canWrite && (
          <div className="flex flex-wrap items-center gap-1.5">
            {canCompose && <Button size="sm" variant="secondary" onClick={() => ai.takeDraft(run)}><Pencil className="w-3.5 h-3.5" /> Use draft</Button>}
            <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => dismiss(run)}>Dismiss</Button>
          </div>
        )}
      </div>
    );
  }

  // Autopilot handed the chat over; shown until someone answers the prospect.
  if (!run && last?.status === 'escalated' && chat.last_direction !== 'out') {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 space-y-1.5">
        <div className="flex items-start gap-1.5 text-xs text-amber-900"><Hand className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" /><span><span className="font-medium">Handed to a person:</span> {escalationText(last.escalation_reasons)}</span></div>
        {last.draft_text && <DraftText text={last.draft_text} />}
        {canWrite && canCompose && last.draft_text && tag?.runId !== last.id && (
          <div><Button size="sm" variant="secondary" onClick={() => ai.takeDraft(last)}><Pencil className="w-3.5 h-3.5" /> Send this draft</Button></div>
        )}
      </div>
    );
  }

  return null;
}

/** Sits right above the textarea while it holds an AI draft: "AI draft · Stage 1 · Engage · <rule>" and Dismiss. */
export function AiDraftLabel({ ai, chatId, onError }: { ai: ComposerAi; chatId: string; onError: (msg: string) => void }) {
  const { canWrite } = useWorkspace();
  const cancel = useCancelRun();
  const { run, last, tag } = ai;
  const r = tag ? (run?.id === tag.runId ? run : last?.id === tag.runId ? last : null) : null;
  if (!r) return null;
  const stage = runStageText(r, ai.state);
  const canDismiss = canWrite && r.status === 'draft_ready';
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] px-0.5">
      <span className="inline-flex items-center gap-1 font-medium text-indigo-700"><Bot className="w-3.5 h-3.5" />AI draft{stage ? ` · ${stage}` : ''}</span>
      {r.rule_applied && <span className="text-gray-500 truncate max-w-full" title="The part of the master prompt the AI followed">{r.rule_applied}</span>}
      {r.status === 'draft_ready' && <SideEffects run={r} />}
      {canDismiss && (
        <button type="button" className="ml-auto text-gray-500 hover:text-gray-800 hover:underline disabled:opacity-50" disabled={cancel.isPending}
          onClick={() => cancel.mutate({ chatId, runId: r.id, reason: 'dismissed' }, { onSuccess: () => ai.discardDraft(r.id), onError: (e) => onError(parseError(e).message) })}>
          {cancel.isPending ? 'Dismissing…' : 'Dismiss'}
        </button>
      )}
    </div>
  );
}
