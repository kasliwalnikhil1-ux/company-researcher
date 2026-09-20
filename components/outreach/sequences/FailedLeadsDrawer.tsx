'use client';

// Failed and skipped leads for a step or a whole sequence (plan item 8).
// Lists rpc failed_leads with the plain-language reason, and recovers failed leads in bulk with rpc enrollment_recover.
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, LogOut, RotateCw, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk } from '@/lib/outreach/queries';
import type { Graph } from '@/lib/outreach/types';
import { Badge, Button, EmptyState, ErrorBox, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { ConfirmModal, Drawer } from './Modals';
import { FAILED_PAGE, useFailedLeads } from './hooks';
import { nodeTitle } from './helpers';
import { fmtInt, plural, REFUSED_REASON, type FailedKind, type FailedLeadRow, type RecoverAction, type RecoverResult } from './publishTypes';

const MAX_SELECT = 500;

const ACTION_COPY: Record<RecoverAction, { label: string; verb: string; done: string; body: string }> = {
  retry: { label: 'Retry this step', verb: 'Retry', done: 'queued again', body: 'The same step is queued again for each lead. It goes through the normal daily limits, so it may not send today.' },
  skip: { label: 'Skip this step', verb: 'Skip', done: 'moved to the next step', body: 'Each lead moves on to the step after the one that failed.' },
  exit: { label: 'Exit', verb: 'Exit', done: 'exited', body: 'Each lead leaves the sequence for good. History and chats are kept.' },
};

interface PanelProps {
  sequenceId: string;
  nodeId?: string | null;
  kind: FailedKind;
  onKindChange?: (k: FailedKind) => void;
  graph?: Graph | null;
  canWrite: boolean;
  /** Counts shown on the tabs when the caller already has them (canvas badges). */
  counts?: { failed?: number; skipped?: number };
  active?: boolean;
}

export function FailedLeadsPanel({ sequenceId, nodeId = null, kind, onKindChange, graph, canWrite, counts, active = true }: PanelProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Map<string, FailedLeadRow>>(new Map());
  const [confirm, setConfirm] = useState<RecoverAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ action: RecoverAction; result: RecoverResult; names: Record<string, string> } | null>(null);
  const q = useFailedLeads(sequenceId, nodeId, kind, page, active);
  const rows = q.data ?? [];
  const selectable = kind === 'failed' && canWrite;

  useEffect(() => { setPage(0); setSelected(new Map()); setOutcome(null); }, [kind, nodeId, sequenceId]);

  const pageIds = useMemo(() => rows.map((r) => r.enrollment_id), [rows]);
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const toggle = (r: FailedLeadRow) => setSelected((prev) => {
    const next = new Map(prev);
    if (next.has(r.enrollment_id)) next.delete(r.enrollment_id);
    else if (next.size < MAX_SELECT) next.set(r.enrollment_id, r);
    else toast.show(`You can act on up to ${MAX_SELECT} leads at a time`, 'error');
    return next;
  });
  const togglePage = () => setSelected((prev) => {
    const next = new Map(prev);
    if (allOnPage) { for (const id of pageIds) next.delete(id); return next; }
    for (const r of rows) { if (next.size >= MAX_SELECT) break; next.set(r.enrollment_id, r); }
    return next;
  });

  const run = async () => {
    if (!confirm || selected.size === 0) return;
    const action = confirm;
    const ids = Array.from(selected.keys());
    const names = Object.fromEntries(Array.from(selected.values()).map((r) => [r.enrollment_id, r.lead_name || 'Lead']));
    setBusy(true);
    try {
      const result = await rpc<RecoverResult>('enrollment_recover', { p_enrollment_ids: ids, p_action: action });
      const refused = result.refused ?? [];
      setOutcome({ action, result: { ...result, refused }, names });
      setSelected(new Map());
      toast.show(`${fmtInt(result.done)} ${plural(result.done, 'lead')} ${ACTION_COPY[action].done}${refused.length ? `. ${fmtInt(refused.length)} could not be changed, see the list.` : ''}`, refused.length && !result.done ? 'error' : 'success');
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      qc.invalidateQueries({ queryKey: qk.nodeStats(sequenceId) });
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(false); setConfirm(null); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {onKindChange && (
          <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs" role="tablist" aria-label="Failed or skipped">
            {(['failed', 'skipped'] as FailedKind[]).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={kind === k} onClick={() => onKindChange(k)} className={cn('px-3 py-1.5 capitalize', kind === k ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>
                {k}{counts?.[k] != null ? ` (${fmtInt(counts[k])})` : ''}
              </button>
            ))}
          </div>
        )}
        {selectable && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-gray-500 tabular-nums mr-1" aria-live="polite">{fmtInt(selected.size)} selected</span>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('retry')}><RotateCw className="w-3.5 h-3.5" /> Retry this step</Button>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('skip')}><SkipForward className="w-3.5 h-3.5" /> Skip this step</Button>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('exit')} className="text-red-700"><LogOut className="w-3.5 h-3.5" /> Exit</Button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">
        {kind === 'failed'
          ? 'To run a lead through again, enrol them again. The preview warns about leads already contacted.'
          : 'A skipped step needs no action. The lead moved on to the next step.'}
      </p>

      {outcome && outcome.result.refused.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <p className="font-medium mb-1">{fmtInt(outcome.result.refused.length)} {plural(outcome.result.refused.length, 'lead')} could not be changed</p>
          <ul className="space-y-0.5 max-h-28 overflow-y-auto">
            {outcome.result.refused.map((r) => <li key={r.id}><span className="font-medium">{outcome.names[r.id] ?? 'Lead'}</span>: {REFUSED_REASON[r.reason] ?? r.reason.replace(/_/g, ' ')}</li>)}
          </ul>
          <button type="button" onClick={() => setOutcome(null)} className="mt-1 underline underline-offset-2">Dismiss</button>
        </div>
      )}

      {q.isLoading ? <Spinner /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : rows.length === 0 ? (
        <EmptyState title={page > 0 ? 'No more leads' : kind === 'failed' ? 'No failed leads' : 'No skipped steps'} description={page > 0 ? undefined : kind === 'failed' ? 'Nothing needs recovering here.' : 'No step was skipped here.'} />
      ) : (
        <Table className={cn(q.isFetching && 'opacity-70')}>
          <thead>
            <tr>
              {selectable && <Th className="w-8"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Th>}
              <Th>Lead</Th><Th>Reason</Th>{!nodeId && <Th>Step</Th>}<Th>Sender</Th><Th>When</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const checked = selected.has(r.enrollment_id);
              return (
                <tr key={`${r.enrollment_id}:${r.node_id ?? ''}:${i}`} className={cn(checked && 'bg-indigo-50/50')}>
                  {selectable && <Td><input type="checkbox" checked={checked} onChange={() => toggle(r)} aria-label={`Select ${r.lead_name || 'lead'}`} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>}
                  <Td>
                    <Link href={`/outreach/leads/${r.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700 block truncate max-w-[180px]">{r.lead_name || 'Lead'}</Link>
                    {r.company && <span className="block text-xs text-gray-500 truncate max-w-[180px]">{r.company}</span>}
                  </Td>
                  <Td>
                    <span className="block text-gray-800">{r.reason}</span>
                    {kind === 'failed' && !r.recoverable && <Badge tone="gray" className="mt-0.5">Cannot be retried</Badge>}
                  </Td>
                  {!nodeId && <Td className="text-gray-600">{r.node_id ? nodeTitle(graph?.nodes[r.node_id]) : '—'}</Td>}
                  <Td className="text-gray-600 whitespace-nowrap">{r.sender_name ?? '—'}</Td>
                  <Td className="text-gray-500 whitespace-nowrap" title={r.at ?? undefined}>{timeAgo(r.at)}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {(page > 0 || rows.length === FAILED_PAGE) && (
        <div className="flex items-center justify-end gap-2 text-xs text-gray-500">
          <span className="tabular-nums">{fmtInt(page * FAILED_PAGE + 1)}–{fmtInt(page * FAILED_PAGE + rows.length)}</span>
          <Button size="sm" variant="secondary" disabled={page === 0 || q.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))} aria-label="Previous page"><ChevronLeft className="w-3.5 h-3.5" /></Button>
          <Button size="sm" variant="secondary" disabled={rows.length < FAILED_PAGE || q.isFetching} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight className="w-3.5 h-3.5" /></Button>
        </div>
      )}

      <ConfirmModal
        open={!!confirm} busy={busy} danger={confirm === 'exit'} onClose={() => setConfirm(null)} onConfirm={run}
        title={confirm ? `${ACTION_COPY[confirm].verb} ${fmtInt(selected.size)} ${plural(selected.size, 'lead')}` : ''}
        confirmLabel={confirm ? ACTION_COPY[confirm].label : ''}
        body={confirm ? <><p>{ACTION_COPY[confirm].body}</p>{confirm !== 'exit' && <p className="text-xs text-gray-500">Leads on a do-not-contact list, leads already running again and leads whose sender is gone are left as they are. You get the list afterwards.</p>}</> : null}
      />
      {toast.node}
    </div>
  );
}

export default function FailedLeadsDrawer({ open, onClose, sequenceId, nodeId, nodeLabel, initialKind = 'failed', graph, canWrite, counts }: {
  open: boolean; onClose: () => void; sequenceId: string; nodeId?: string | null; nodeLabel?: string; initialKind?: FailedKind; graph?: Graph | null; canWrite: boolean; counts?: { failed?: number; skipped?: number };
}) {
  const [kind, setKind] = useState<FailedKind>(initialKind);
  useEffect(() => { if (open) setKind(initialKind); }, [open, initialKind, nodeId]);
  return (
    <Drawer open={open} onClose={onClose} width="max-w-3xl" title={nodeLabel ? `Failed and skipped at “${nodeLabel}”` : 'Failed and skipped leads'} subtitle="Each lead shows why the step did not go through.">
      {open && <FailedLeadsPanel sequenceId={sequenceId} nodeId={nodeId ?? null} kind={kind} onKindChange={setKind} graph={graph} canWrite={canWrite} counts={counts} />}
    </Drawer>
  );
}
