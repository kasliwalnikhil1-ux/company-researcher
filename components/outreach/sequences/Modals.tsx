'use client';

import { AlertTriangle, CheckCircle2, Sparkles, XCircle } from 'lucide-react';
import { Button, ErrorBox, Modal, Spinner } from '@/components/outreach/ui';
import type { GraphIssue } from '@/lib/outreach/graph';
import type { Graph } from '@/lib/outreach/types';
import { nodeTitle } from './helpers';

export interface QaState { loading: boolean; errors: GraphIssue[]; warnings: GraphIssue[]; ai_available: boolean; failed?: string | null; activating?: boolean }

function IssueList({ items, level, graph, onFocus }: { items: GraphIssue[]; level: 'error' | 'warning'; graph: Graph; onFocus: (id: string) => void }) {
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

export function InflightDeleteModal({ req, busy, onChoose }: { req: { nodeId: string; label: string; count: number } | null; busy: boolean; onChoose: (mode: 'skip' | 'cancel' | null) => void }) {
  if (!req) return null;
  return (
    <Modal open onClose={() => onChoose(null)} title={`Delete “${req.label}”`} size="md" footer={
      <>
        <Button variant="secondary" onClick={() => onChoose(null)} disabled={busy}>Keep step</Button>
        <Button variant="secondary" loading={busy} onClick={() => onChoose('skip')}>Skip in-flight ({req.count})</Button>
        <Button variant="danger" loading={busy} onClick={() => onChoose('cancel')}>Cancel in-flight ({req.count})</Button>
      </>
    }>
      <div className="text-sm text-gray-700 space-y-2">
        <p><span className="font-semibold">{req.count.toLocaleString()}</span> enrollment{req.count === 1 ? ' is' : 's are'} currently at this step.</p>
        <ul className="list-disc pl-5 text-xs text-gray-600 space-y-1">
          <li><span className="font-medium text-gray-800">Skip</span>: queued actions for this step are cancelled and the enrollments move on to the next step immediately.</li>
          <li><span className="font-medium text-gray-800">Cancel</span>: the enrollments exit the sequence (exited manually, reason “node deleted”).</li>
        </ul>
        <p className="text-xs text-gray-500">The choice is applied right away and recorded in the audit log; remember to save the graph afterwards.</p>
      </div>
    </Modal>
  );
}

export function UnsavedModal({ open, busy, onCancel, onDiscard, onSaveAndGo }: { open: boolean; busy: boolean; onCancel: () => void; onDiscard: () => void; onSaveAndGo: () => void }) {
  return (
    <Modal open={open} onClose={onCancel} title="Unsaved changes" size="sm" footer={<><Button variant="secondary" onClick={onCancel} disabled={busy}>Stay</Button><Button variant="danger" onClick={onDiscard} disabled={busy}>Discard</Button><Button loading={busy} onClick={onSaveAndGo}>Save and continue</Button></>}>
      <p className="text-sm text-gray-700">You have unsaved changes to this sequence. Save them before leaving, or discard them.</p>
    </Modal>
  );
}
