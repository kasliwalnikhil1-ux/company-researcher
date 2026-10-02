'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, RefreshCw, SkipForward, X } from 'lucide-react';
import { reviewLines, whoText, type NeedsYouRow } from '@/lib/outreach/aiHub';
import { Button, Modal } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/settings/shared';
import type { CardApi } from './types';

const lines = (n: number) => `${n.toLocaleString()} line${n === 1 ? '' : 's'}`;

/**
 * Bulk actions, lines only: "n selected: Approve · Skip · Regenerate". Approve lists the lines before it confirms.
 * A line with an unsaved inline edit is left out of an approve: approving it would send the text the person was changing.
 */
export default function BulkBar({ rows, dirty, api, onClear }: {
  /** The selected line cards that are still on screen. */
  rows: NeedsYouRow[];
  /** Ids of lines with an unsaved inline edit. */
  dirty: Set<string>;
  api: CardApi; onClear: () => void;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  if (rows.length === 0) return null;
  const approvable = rows.filter((r) => !dirty.has(r.id) && !!(r.ai_text ?? '').trim());
  const unsaved = rows.length - approvable.length;
  const ids = rows.map((r) => r.id);

  const approve = () => {
    setApproveOpen(false);
    const picked = approvable;
    void api.act(picked, () => reviewLines(picked.map((r) => r.id), 'approve'),
      (n) => `${lines(n)} approved.${n < picked.length ? ` ${lines(picked.length - n)} had already been handled.` : ''}`);
  };
  const regenerate = () => {
    setRegenerateOpen(false);
    void api.act(rows, () => reviewLines(ids, 'regenerate'), (n) => `${lines(n)} ${n === 1 ? 'is' : 'are'} being written again.`);
  };

  return (
    <div role="region" aria-label="Selected lines" className="flex flex-wrap items-center gap-2 rounded-xl border border-indigo-200 bg-white shadow-lg px-3 py-2 w-full max-w-2xl">
      <span className="text-sm font-medium text-gray-900 tabular-nums" aria-live="polite">{rows.length.toLocaleString()} selected:</span>
      <Button size="sm" disabled={approvable.length === 0} onClick={() => setApproveOpen(true)} title={approvable.length === 0 ? 'Every selected line has an unsaved edit' : undefined}><Check className="w-3.5 h-3.5" /> Approve</Button>
      <Button size="sm" variant="secondary" onClick={() => api.defer(rows, `${lines(rows.length)} skipped`, () => reviewLines(ids, 'skip'))} title="The fallback is used for these leads"><SkipForward className="w-3.5 h-3.5" /> Skip</Button>
      <Button size="sm" variant="secondary" onClick={() => setRegenerateOpen(true)}><RefreshCw className="w-3.5 h-3.5" /> Regenerate</Button>
      <div className="flex-1" />
      <button type="button" onClick={onClear} aria-label="Clear the selection" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><X className="w-4 h-4" /></button>

      {/* The bar is sticky (its own stacking context), so the dialogs go to the body to sit above the rest of the app. */}
      {approveOpen && createPortal(
        <Modal open onClose={() => setApproveOpen(false)} title={`Approve ${lines(approvable.length)}?`} size="lg"
          footer={<><Button variant="secondary" onClick={() => setApproveOpen(false)}>Cancel</Button><Button disabled={approvable.length === 0} onClick={approve}>Approve</Button></>}>
          <div className="space-y-3 text-sm text-gray-700">
            <p>Once approved, a sequence step that uses the variable can send these lines.</p>
            {unsaved > 0 && <p className="text-amber-800">{lines(unsaved)} {unsaved === 1 ? 'has' : 'have'} an edit you have not saved. {unsaved === 1 ? 'It is' : 'They are'} left out. Use “Save and approve” on {unsaved === 1 ? 'that card' : 'those cards'}.</p>}
            <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
              {approvable.map((r) => (
                <li key={r.id} className="px-3 py-2">
                  <div className="text-xs text-gray-500">{whoText(r) || 'Unnamed lead'}{r.where_name ? ` · ${r.where_name}` : ''}</div>
                  <div className="text-gray-900 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{r.ai_text}</div>
                </li>
              ))}
            </ul>
          </div>
        </Modal>,
        document.body,
      )}
      {regenerateOpen && createPortal(
        <ConfirmModal open onClose={() => setRegenerateOpen(false)} onConfirm={regenerate} title={`Write ${lines(rows.length)} again?`} confirmLabel="Regenerate" danger={false}>
          <p>The current {rows.length === 1 ? 'line is' : 'lines are'} replaced. Each new line comes back here when it is ready.</p>
        </ConfirmModal>,
        document.body,
      )}
    </div>
  );
}
