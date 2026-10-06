'use client';

import { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Check, MessageSquare, Pencil, Send, SkipForward, X } from 'lucide-react';
import { applyNoReply, cancelReply, dismissReply, sendReplyDraft, sendReplyNow } from '@/lib/outreach/aiHub';
import { stopText, warningText } from '@/lib/outreach/aiReplies';
import { Button, Textarea } from '@/components/outreach/ui';
import { CancelRunModal } from '@/components/outreach/inbox/ai/AiComposerPanel';
import NeedCard, { ClampText, Hint, Part, linkButton } from './NeedCard';
import { UNDO_MS } from './useCardActions';
import { metaFlag, metaText, replyWarnings, type CardProps } from './types';

/**
 * Reply: a draft in Review mode, a reply the AI handed to a person, a suggestion not to reply, or an Auto reply on its
 * warm-up hold. Sending here is the inbox's send (send-reply with the run id), so handoff, origin and counts are the same.
 */
export default function ReplyCard({ row, hidden, api }: CardProps) {
  const [edit, setEdit] = useState<string | undefined>(undefined);
  const [cancelOpen, setCancelOpen] = useState(false);
  const draft = (row.ai_text ?? '').trim();
  const editing = edit !== undefined;
  const chatId = row.chat_id;
  const warmup = row.state === 'warmup';
  const noReply = row.state === 'no_reply';
  const canSend = api.canWrite && api.canReply && !!chatId;
  const warnings = replyWarnings(row).slice(0, 2);
  const name = row.who_name ?? 'this lead';

  const send = () => {
    const text = (edit ?? draft).trim();
    if (!text || !chatId) return;
    void api.act(row, async () => {
      // An untouched warm-up reply goes out as the AI's own send. Anything else is a person sending the draft:
      // the server compares the text with the draft and records it as sent as is or edited.
      if (warmup && text === draft) await sendReplyNow(row.id);
      else await sendReplyDraft({ chatId, runId: row.id, text });
    }, 'Reply sent.');
  };

  const cancel = (reason: string, note: string | null) => {
    setCancelOpen(false);
    const call = () => cancelReply(row.id, reason, note);
    // Undo holds the call back for 5 seconds. A reply that is about to go out cannot wait that long: cancel it now.
    const sendsIn = row.send_at ? new Date(row.send_at).getTime() - Date.now() : Number.POSITIVE_INFINITY;
    if (sendsIn < UNDO_MS * 2) void api.act(row, call, 'Reply cancelled.');
    else api.defer(row, 'Reply cancelled', call);
  };

  const openConversation = chatId ? <Link href={`/outreach/inbox/${chatId}`} className={linkButton}><MessageSquare className="w-3.5 h-3.5" aria-hidden="true" /> Open conversation</Link> : null;

  return (
    <NeedCard row={row} hidden={hidden}
      trigger={row.trigger_text ? <Part tone="them" label="They wrote"><ClampText text={row.trigger_text} className="text-gray-700" /></Part> : undefined}
      ai={editing ? (
        <Textarea label={`Your reply to ${name}`} value={edit} onChange={(e) => setEdit(e.target.value)} rows={4} autoFocus className="min-h-[96px]" />
      ) : draft ? (
        <Part tone="ai" label="AI draft"><ClampText text={draft} /></Part>
      ) : noReply ? undefined : (
        <Hint>No draft. The AI left this one to a person.</Hint>
      )}
      extra={(warnings.length > 0 || metaFlag(row, 'stop_after_send') || (api.canWrite && !api.canReply)) ? (
        <>
          {warnings.map((w, i) => <Hint key={i} tone="amber">{warningText(w)}</Hint>)}
          {metaFlag(row, 'stop_after_send') && !noReply && <Hint tone="amber">{stopText(metaText(row, 'stop_rule'))}</Hint>}
          {api.canWrite && !api.canReply && <Hint>Your account cannot send replies. Ask an owner to turn it on for you.</Hint>}
        </>
      ) : undefined}
      actions={api.canWrite ? (
        editing ? (
          <>
            {canSend && <Button size="sm" disabled={!(edit ?? '').trim()} onClick={send}><Send className="w-3.5 h-3.5" /> Send</Button>}
            <Button size="sm" variant="ghost" onClick={() => setEdit(undefined)}>Discard edit</Button>
            {openConversation}
          </>
        ) : (
          <>
            {noReply && <Button size="sm" onClick={() => void api.act(row, () => applyNoReply(row.id), 'Done. Nothing was sent.')} title="Do what the AI suggests: close this without replying"><Check className="w-3.5 h-3.5" /> Apply</Button>}
            {!noReply && canSend && draft && <Button size="sm" onClick={send}><Send className="w-3.5 h-3.5" /> {warmup ? 'Send now' : 'Send'}</Button>}
            {!noReply && canSend && <Button size="sm" variant="secondary" onClick={() => setEdit(draft)}><Pencil className="w-3.5 h-3.5" /> {draft ? 'Edit' : 'Write reply'}</Button>}
            {warmup && <Button size="sm" variant="secondary" onClick={() => setCancelOpen(true)}><X className="w-3.5 h-3.5" /> Cancel</Button>}
            {openConversation}
            {!warmup && <Button size="sm" variant="ghost" onClick={() => api.defer(row, 'Reply skipped', () => dismissReply(row.id))} title="Nothing is sent. The conversation stays in the inbox."><SkipForward className="w-3.5 h-3.5" /> Skip</Button>}
            {cancelOpen && <CancelRunModal open onClose={() => setCancelOpen(false)} busy={false} onConfirm={cancel} />}
          </>
        )
      ) : undefined} />
  );
}
