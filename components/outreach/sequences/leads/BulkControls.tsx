'use client';

// The bulk bar, the confirmation and the undo toast of the sequence Leads tab (PRD feature 2), in the same look as the
// Leads page: the indigo sticky bar with action chips and a close button, progress in the bar while a run goes, and a
// 10-second Undo toast.
import { useEffect, useState } from 'react';
import { Loader2, LogOut, Pause, Play, Undo2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Modal } from '@/components/outreach/ui';
import { BULK_ACTION_LABEL, UNDO_SECONDS, unenrollConfirmText, type BulkAction, type BulkPreview } from '@/lib/outreach/sequenceLeads';

/** Same chip as the Leads page bulk bar. */
function BulkBtn({ children, onClick, danger, title, disabled }: { children: React.ReactNode; onClick: () => void; danger?: boolean; title?: string; disabled?: boolean }) {
  return <button type="button" onClick={onClick} title={title} disabled={disabled} className={cn('inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap disabled:opacity-60 disabled:cursor-not-allowed', danger ? 'bg-red-500/90 hover:bg-red-500' : 'bg-white/15 hover:bg-white/25')}>{children}</button>;
}

export interface BulkProgress { action: BulkAction; done: number; total: number }

export function BulkBar({ count, enabled, progress, onAction, onClear }: {
  count: number; enabled: Record<BulkAction, boolean>; progress: BulkProgress | null; onAction: (a: BulkAction) => void; onClear: () => void;
}) {
  if (count === 0 && !progress) return null;
  const verb: Record<BulkAction, string> = { unenroll: 'Unenrolling', pause: 'Pausing', resume: 'Resuming' };
  return (
    <div className="sticky top-0 z-10 bg-indigo-600 text-white rounded-xl px-4 py-2.5 flex items-center gap-2 shadow-md" role="toolbar" aria-label="Actions on the selected leads">
      {progress ? (
        <>
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
          <span className="text-sm font-medium tabular-nums">{verb[progress.action]} {progress.done.toLocaleString()} / {progress.total.toLocaleString()}…</span>
          <div className="flex-1 min-w-[120px] h-1.5 bg-white/20 rounded-full overflow-hidden"><div className="h-full bg-white transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
        </>
      ) : (
        <>
          <span className="text-sm font-medium mr-2 shrink-0 tabular-nums">{count.toLocaleString()} selected</span>
          <div className="flex flex-1 min-w-0 flex-wrap items-center gap-1.5">
            <BulkBtn danger disabled={!enabled.unenroll} onClick={() => onAction('unenroll')} title={enabled.unenroll ? 'Take the selected leads out of the sequence' : 'None of the selected leads is still in progress'}><LogOut className="w-3.5 h-3.5" /> Unenroll</BulkBtn>
            <BulkBtn disabled={!enabled.pause} onClick={() => onAction('pause')} title={enabled.pause ? 'Pause the selected leads' : 'None of the selected leads is running'}><Pause className="w-3.5 h-3.5" /> Pause</BulkBtn>
            <BulkBtn disabled={!enabled.resume} onClick={() => onAction('resume')} title={enabled.resume ? 'Resume the selected leads' : 'None of the selected leads is paused'}><Play className="w-3.5 h-3.5" /> Resume</BulkBtn>
          </div>
          <button type="button" onClick={onClear} title="Clear selection" className="ml-auto shrink-0 self-center p-1 rounded-md hover:bg-white/15"><X className="w-4 h-4" /></button>
        </>
      )}
    </div>
  );
}

/** "Unenroll 12 leads from <sequence>? …" with the skipped count from the preview RPC. Pause / resume confirm inline. */
export function ConfirmBulkModal({ action, count, sequenceName, preview, loading, onConfirm, onClose }: {
  action: BulkAction | null; count: number; sequenceName: string; preview: BulkPreview | null; loading: boolean; onConfirm: () => void; onClose: () => void;
}) {
  if (!action) return null;
  const skipped = preview?.skipped ?? 0;
  const eligible = preview ? preview.eligible : count;
  const text = action === 'unenroll' ? unenrollConfirmText(preview ? preview.total : count, sequenceName, skipped) : {
    title: `${BULK_ACTION_LABEL[action]} ${eligible.toLocaleString()} lead${eligible === 1 ? '' : 's'}?`,
    body: action === 'pause'
      ? `Their next steps wait until you resume them.${skipped ? ` ${skipped.toLocaleString()} lead${skipped === 1 ? ' that is' : 's that are'} not running will be skipped.` : ''}`
      : `They carry on from the step they were paused at.${skipped ? ` ${skipped.toLocaleString()} lead${skipped === 1 ? ' that is' : 's that are'} not paused will be skipped.` : ''}`,
  };
  return (
    <Modal open onClose={onClose} title={text.title} size="sm"
      footer={<><Button variant="secondary" onClick={onClose} disabled={loading}>Cancel</Button><Button variant={action === 'unenroll' ? 'danger' : 'primary'} loading={loading} disabled={!preview || eligible === 0} onClick={onConfirm}>{BULK_ACTION_LABEL[action]}</Button></>}>
      <p className="text-sm text-gray-700">{preview ? text.body : 'Checking the selected leads…'}</p>
      {action === 'unenroll' && preview && <p className="text-xs text-gray-500 mt-2">Unenroll never deletes the lead or the conversation. You can undo for {UNDO_SECONDS} seconds, and enrol them again later from the Leads page.</p>}
    </Modal>
  );
}

export interface UndoState { batchId: string; count: number }

/** "12 leads unenrolled · Undo", for 10 seconds from the moment the toast appears. Mount it with `key={batchId}` so a new batch starts a fresh countdown. */
export function UndoToast({ state, busy, onUndo, onExpire }: { state: UndoState | null; busy: boolean; onUndo: () => void; onExpire: () => void }) {
  const [left, setLeft] = useState(UNDO_SECONDS);
  useEffect(() => {
    if (!state) return;
    const expiresAt = Date.now() + UNDO_SECONDS * 1000;
    const t = setInterval(() => {
      const s = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) onExpire();
    }, 250);
    return () => clearInterval(t);
  }, [state, onExpire]);
  if (!state) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60]" role="status" aria-live="polite">
      <div className="px-4 py-3 rounded-lg shadow-lg text-sm text-white bg-gray-900 flex items-center gap-3 max-w-md">
        <span>{state.count.toLocaleString()} lead{state.count === 1 ? '' : 's'} unenrolled</span>
        <span className="text-gray-500">·</span>
        <button type="button" onClick={onUndo} disabled={busy} className={cn('inline-flex items-center gap-1 font-medium underline underline-offset-2 hover:text-indigo-200', busy && 'opacity-60')}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Undo2 className="w-3.5 h-3.5" />} Undo <span className="tabular-nums text-gray-400">({left}s)</span>
        </button>
      </div>
    </div>
  );
}
