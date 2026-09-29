'use client';

import { useState } from 'react';
import { Button, ErrorBox, Modal, Textarea } from '@/components/outreach/ui';
import { Note } from '@/components/outreach/settings/shared';
import { cn } from '@/lib/utils';
import { suggestKind } from './promptModel';

export type ChangeKind = 'style' | 'substantive';

const KINDS: Array<{ key: ChangeKind; title: string; text: string }> = [
  { key: 'style', title: 'Style only', text: 'Wording or tone. What the AI says and when stays the same. Autopilot keeps running.' },
  { key: 'substantive', title: 'Substantive', text: 'Situations, facts, stages or settings changed. Sender owners must approve autopilot again before it resumes on their accounts.' },
];

/** Mount with a fresh `key` each time it opens so the suggestion is recomputed. */
export default function SaveDialog({ open, onClose, isFirst, parts, loading, error, conflict, onReload, onConfirm }: {
  open: boolean;
  onClose: () => void;
  isFirst: boolean;
  parts: string[];
  loading: boolean;
  error: string | null;
  conflict: boolean;
  onReload: () => void;
  onConfirm: (kind: ChangeKind, note: string | null) => void;
}) {
  const suggested = isFirst ? 'substantive' : suggestKind(parts);
  const [kind, setKind] = useState<ChangeKind>(suggested);
  const [note, setNote] = useState('');

  return (
    <Modal open={open} onClose={loading ? () => undefined : onClose} title={isFirst ? 'Save master prompt' : 'Save changes'} size="md"
      footer={conflict ? (
        <><Button variant="secondary" onClick={onClose}>Keep editing</Button><Button onClick={onReload}>Load their version</Button></>
      ) : (
        <><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button loading={loading} onClick={() => onConfirm(isFirst ? 'substantive' : kind, note.trim() || null)}>Save</Button></>
      )}>
      <div className="space-y-4">
        {conflict ? (
          <Note tone="amber">
            Someone else saved this prompt while you were editing. Load their version to see it (your edits here will be lost),
            or keep editing and copy what you need first.
          </Note>
        ) : (
          <>
            {isFirst ? (
              <p className="text-sm text-gray-700">
                This is the first version. Once it is saved, AI drafts start for chats that use it. Sender owners approve autopilot for their accounts separately.
              </p>
            ) : (
              <fieldset>
                <legend className="text-sm font-medium text-gray-900">Is this a style-only change or a substantive one?</legend>
                {parts.length > 0 && <p className="text-xs text-gray-500 mt-0.5">Changed: {parts.join(', ')}.</p>}
                <div className="mt-2 space-y-2">
                  {KINDS.map((k) => (
                    <label key={k.key} className={cn('flex items-start gap-3 rounded-lg border p-3 cursor-pointer', kind === k.key ? 'border-indigo-400 bg-indigo-50/50' : 'border-gray-200 hover:bg-gray-50')}>
                      <input type="radio" name="change-kind" value={k.key} checked={kind === k.key} onChange={() => setKind(k.key)} className="mt-0.5" />
                      <span>
                        <span className="text-sm font-medium text-gray-900">{k.title}{k.key === suggested && <span className="ml-2 text-xs font-normal text-indigo-700">Suggested</span>}</span>
                        <span className="block text-xs text-gray-600 mt-0.5">{k.text}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {kind === 'style' && suggested === 'substantive' && (
                  <Note tone="amber" className="mt-2">You changed more than the Style section. Only call it style-only if the AI&apos;s answers really stay the same.</Note>
                )}
              </fieldset>
            )}
            <Textarea label="Note (optional)" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="What changed and why, for the version history" className="min-h-0" />
            {error && <ErrorBox message={error} />}
          </>
        )}
      </div>
    </Modal>
  );
}
