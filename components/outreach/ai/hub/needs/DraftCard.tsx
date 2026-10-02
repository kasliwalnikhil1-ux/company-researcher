'use client';

import { useState } from 'react';
import { RefreshCw, Sparkles, SkipForward } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { approveStepDraft, regenerateStepDraft, skipStepDraft } from '@/lib/outreach/aiHub';
import { useSender } from '@/lib/outreach/queries';
import { Button, Textarea } from '@/components/outreach/ui';
import { draftLimit } from '@/components/outreach/tasks/TaskDrawer';
import NeedCard, { ClampText, Part } from './NeedCard';
import { metaText, type CardProps } from './types';

/**
 * Step draft: the message of a sequence step that the AI writes and a person approves. The lead waits at the step, so
 * the text is always editable: when no draft arrives, a person writes it here.
 */
export default function DraftCard({ row, hidden, api }: CardProps) {
  const [edit, setEdit] = useState<string | undefined>(undefined);
  // A fresh draft from Regenerate, shown until the list brings the same text (`base` = what the list had back then).
  const [fresh, setFresh] = useState<{ text: string; base: string | null } | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const kind = metaText(row, 'draft_kind');
  // Only an invitation note depends on the sender's LinkedIn plan (200 or 300 characters).
  const sender = useSender(kind === 'invite_note' ? metaText(row, 'sender_id') : null);
  const limit = draftLimit(kind, sender.data?.is_premium);
  const text = edit ?? (fresh && fresh.base === row.ai_text ? fresh.text : row.ai_text ?? '');
  const over = text.length > limit;
  const drafting = row.state === 'drafting' && !text.trim() && !regenerating;
  const name = row.who_name ?? 'this lead';

  const regenerate = async () => {
    setRegenerating(true);
    try {
      const r = await regenerateStepDraft(row.id);
      if (r?.text) { setFresh({ text: r.text, base: row.ai_text }); setEdit(undefined); }
      api.notify('Draft written again.');
      api.refresh();
    } catch (e) { api.notify(parseError(e).message, 'error'); }
    finally { setRegenerating(false); }
  };

  return (
    <NeedCard row={row} hidden={hidden} busy={drafting || regenerating}
      reason={regenerating ? 'The AI is writing this draft again' : undefined}
      trigger={row.trigger_text ? <Part label="Brief:"><ClampText text={row.trigger_text} className="text-gray-700" /></Part> : undefined}
      ai={api.canWrite ? (
        <Textarea label={`Draft${kind ? ` (${kind.replace(/_/g, ' ')})` : ''} for ${name}`} value={text} onChange={(e) => setEdit(e.target.value)} rows={4} className="min-h-[96px]"
          counter={{ max: limit, value: text.length }} placeholder={row.state === 'review' ? undefined : 'Write the message yourself, or wait for the draft'} />
      ) : text.trim() ? (
        <Part label="Draft:"><ClampText text={text} /></Part>
      ) : undefined}
      actions={api.canWrite ? (
        <>
          <Button size="sm" disabled={!text.trim() || over || regenerating} title={over ? `The text is over the limit of ${limit.toLocaleString()} characters` : undefined}
            onClick={() => void api.act(row, () => approveStepDraft(row.id, text), 'Approved. The message is queued for sending.')}><Sparkles className="w-3.5 h-3.5" /> Approve &amp; send</Button>
          <Button size="sm" variant="secondary" loading={regenerating} onClick={regenerate}>{!regenerating && <RefreshCw className="w-3.5 h-3.5" />} Regenerate</Button>
          <Button size="sm" variant="ghost" disabled={regenerating} onClick={() => api.defer(row, 'Step skipped', () => skipStepDraft(row.id))} title="The lead moves on without this message"><SkipForward className="w-3.5 h-3.5" /> Skip step</Button>
        </>
      ) : undefined} />
  );
}
