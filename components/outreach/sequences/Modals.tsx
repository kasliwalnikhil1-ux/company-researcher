'use client';

import { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Sparkles, X, XCircle } from 'lucide-react';
import { Button, ErrorBox, Modal, Spinner } from '@/components/outreach/ui';
import type { GraphIssue } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
import { nodeTitle } from './helpers';

export interface QaState { loading: boolean; errors: GraphIssue[]; warnings: GraphIssue[]; ai_available: boolean; failed?: string | null; activating?: boolean }

export function IssueList({ items, level, graph, onFocus }: { items: GraphIssue[]; level: 'error' | 'warning'; graph: Graph; onFocus: (id: string) => void }) {
  if (items.length === 0) return null;
  const err = level === 'error';
  return (
    <div className={err ? 'rounded-lg border border-red-200 bg-red-50' : 'rounded-lg border border-amber-200 bg-amber-50'}>
      <div className={`px-3 py-2 text-xs font-semibold flex items-center gap-1.5 ${err ? 'text-red-800' : 'text-amber-800'}`}>
        {err ? <XCircle className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
        {items.length} {err ? 'blocking error' : 'warning'}{items.length === 1 ? '' : 's'}
      </div>
      <ul className="divide-y divide-white/60">
        {items.map((i, idx) => (
          <li key={idx} className={`px-3 py-1.5 text-xs ${err ? 'text-red-900' : 'text-amber-900'}`}>
            {i.node_id && graph.nodes[i.node_id] ? <button type="button" onClick={() => onFocus(i.node_id!)} className="font-medium underline-offset-2 hover:underline mr-1">{nodeTitle(graph.nodes[i.node_id])}:</button> : null}
            {i.message}
            <span className="opacity-60 ml-1">({i.code})</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function QaModal({ qa, graph, onClose, onActivate, onFocus }: { qa: QaState | null; graph: Graph; onClose: () => void; onActivate: () => void; onFocus: (id: string) => void }) {
  if (!qa) return null;
  const blocked = qa.errors.length > 0;
  return (
    <Modal open onClose={onClose} title="Pre-activation check" size="lg" footer={
      <>
        <Button variant="secondary" onClick={onClose}>{blocked ? 'Fix issues' : 'Cancel'}</Button>
        {!blocked && !qa.loading && <Button loading={qa.activating} onClick={onActivate}>{qa.warnings.length ? 'Activate anyway' : 'Activate'}</Button>}
      </>
    }>
      {qa.loading ? (
        <div className="py-6 text-center">
          <Spinner className="py-2" />
          <p className="text-sm text-gray-600">Validating the graph and reviewing copy with AI…</p>
        </div>
      ) : (
        <div className="space-y-3">
          {qa.failed && <ErrorBox message={`The QA service could not be reached (${qa.failed}). The server still validates the graph when you activate.`} />}
          {!blocked && qa.warnings.length === 0 && !qa.failed && (
            <div className="flex items-center gap-2 text-sm text-green-800 bg-green-50 rounded-lg px-3 py-2"><CheckCircle2 className="w-4 h-4" /> No issues found. The sequence is ready to run.</div>
          )}
          <IssueList items={qa.errors} level="error" graph={graph} onFocus={(id) => { onFocus(id); onClose(); }} />
          <IssueList items={qa.warnings} level="warning" graph={graph} onFocus={(id) => { onFocus(id); onClose(); }} />
          <p className="text-xs text-gray-500 flex items-center gap-1"><Sparkles className="w-3.5 h-3.5" />{qa.ai_available ? 'Warnings include AI suggestions on tone, length and personalisation.' : 'AI review is not configured for this workspace; only static checks ran.'}</p>
          {blocked && <p className="text-xs text-gray-600">Blocking errors must be fixed before the sequence can be activated. Activation also requires every pool sender to be connected.</p>}
        </div>
      )}
    </Modal>
  );
}

export function ConfirmModal({ open, title, body, confirmLabel, danger, busy, onClose, onConfirm }: { open: boolean; title: string; body: React.ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onClose: () => void; onConfirm: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" footer={<><Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button><Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>{confirmLabel}</Button></>}>
      <div className="text-sm text-gray-700 space-y-2">{body}</div>
    </Modal>
  );
}

/**
 * Leaving the builder. The graph is auto-saved as a draft, so this only shows when the draft write failed
 * or when name / settings / pool changes (which the draft does not carry) would be lost.
 */
export function UnsavedModal({ open, busy, draftFailed, metaLabels, primaryLabel, onCancel, onLeave, onPrimary }: {
  open: boolean; busy: boolean; draftFailed: boolean; metaLabels: string[]; primaryLabel: string;
  onCancel: () => void; onLeave: () => void; onPrimary: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} title="Changes not saved yet" size="sm" footer={<><Button variant="secondary" onClick={onCancel} disabled={busy}>Stay</Button><Button variant="danger" onClick={onLeave} disabled={busy}>Leave anyway</Button><Button loading={busy} onClick={onPrimary} autoFocus>{primaryLabel}</Button></>}>
      <div className="text-sm text-gray-700 space-y-2">
        {draftFailed && <p>The draft could not be saved to the server. A copy is kept in this browser, and you can restore it when you come back.</p>}
        {metaLabels.length > 0 && <p>These changes are not part of the saved draft: <span className="font-medium">{metaLabels.join(', ')}</span>. They are kept in this browser only until you {primaryLabel.toLowerCase().startsWith('save') ? 'save' : 'publish'}.</p>}
      </div>
    </Modal>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-hand drawer: focus moves in on open, Tab stays inside, Escape closes, focus returns on close. */
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 'max-w-2xl' }: { open: boolean; onClose: () => void; title: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; width?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // a modal opened from inside the drawer (confirmations) owns the keyboard while it is up
      if (document.querySelector('.fixed.inset-0.z-50')) return;
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); return; }
      if (e.key !== 'Tab' || !panel.current) return;
      const items = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0], last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); prev?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end nokey" data-outreach-drawer>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div ref={panel} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1} className={`relative bg-white shadow-2xl w-full ${width} h-full flex flex-col focus:outline-none`}>
        <div className="flex items-start justify-between gap-3 px-5 py-3 border-b border-gray-100">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-gray-900 truncate">{title}</h3>
            {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="px-5 py-3 border-t border-gray-100 flex flex-wrap items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
