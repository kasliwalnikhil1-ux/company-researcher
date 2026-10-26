'use client';

// Delete a sequence in any status (migration 104). Like erasing a sender, the button stays off until the name is typed;
// the database checks the same name again, so a stale dialog can't delete a renamed sequence.
import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import type { Sequence } from '@/lib/outreach/types';
import { Button, ErrorBox, Input, Modal } from '@/components/outreach/ui';

/** Trimmed and case-insensitive, matching outreach_delete_sequence. */
export const sequenceNameMatches = (typed: string, name: string) => typed.trim().toLowerCase() === name.trim().toLowerCase();

const n = (k: number, one: string) => `${k.toLocaleString()} ${one}${k === 1 ? '' : 's'}`;

export function DeleteSequenceModal({ sequence, liveLeads, busy, error, onClose, onConfirm }: {
  sequence: Sequence | null;
  /** Leads still moving through it; undefined while the results are loading or failed. */
  liveLeads: number | undefined;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (typedName: string) => void;
}) {
  const [typed, setTyped] = useState('');
  // a new sequence (or closing) starts with an empty box
  const [forId, setForId] = useState<string | null>(null);
  if ((sequence?.id ?? null) !== forId) { setForId(sequence?.id ?? null); setTyped(''); }
  const name = sequence?.name ?? '';
  const ok = !!sequence && sequenceNameMatches(typed, name);
  const sending = sequence?.status === 'active' || sequence?.status === 'paused';

  return (
    <Modal open={!!sequence} onClose={() => !busy && onClose()} title={`Delete “${name}”?`} size="md"
      footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant="danger" loading={busy} disabled={!ok || busy} onClick={() => onConfirm(typed)}>Delete permanently</Button></>}>
      <div className="space-y-4 text-sm text-gray-700">
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>This permanently deletes the sequence, its versions, its step statistics and the history of every lead that went through it. This cannot be undone.</span>
        </div>
        {sending && (
          <p>
            {sequence?.status === 'active' ? 'It is running now: sending stops straight away. ' : 'It is paused. '}
            {liveLeads === undefined ? 'Every lead still in it is taken out and gets nothing more from it.'
              : liveLeads > 0 ? <>{n(liveLeads, 'lead')} still in it {liveLeads === 1 ? 'is' : 'are'} taken out and get{liveLeads === 1 ? 's' : ''} nothing more from it.</>
              : 'No leads are in it right now.'}
            {' '}Their conversations stay in the inbox.
          </p>
        )}
        {!sending && sequence?.status === 'draft' && <p>It is a draft, so no lead has been contacted from it.</p>}
        {sequence?.status !== 'archived' && <p className="text-gray-500">To keep the history and only stop sending, archive it instead.</p>}
        <Input label={`Type “${name.trim()}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
          onKeyDown={(e) => { if (e.key === 'Enter' && ok && !busy) onConfirm(typed); }} disabled={busy} autoComplete="off" spellCheck={false} />
        {error && <ErrorBox message={error} />}
      </div>
    </Modal>
  );
}
