'use client';

// The leads behind a step's numbers (queued, sent, accepted, replied, failed, skipped), or a whole sequence's failed
// and skipped leads (plan item 8). Lists rpc failed_leads (098 added the other kinds), and recovers failed leads in
// bulk with rpc enrollment_recover.
import { useEffect, useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, LogOut, RotateCw, SkipForward } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { db } from '@/lib/outreach/backend';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useSenders } from '@/lib/outreach/queries';
import type { Graph } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { senderName } from './helpers';
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

/** Per kind: the hint above the list, the extra column (header), the "when" column header and the empty state. */
const KIND_COPY: Record<FailedKind, { hint: string; detail: string | null; when: string; empty: string; emptyBody: string }> = {
  queued: { hint: 'Waiting to go out. Each sender sends within their daily limits and working hours, so some may go out on a later day.', detail: 'Status', when: 'Due', empty: 'Nothing queued', emptyBody: 'No lead is waiting at this step.' },
  sent: { hint: 'This step went out to these leads.', detail: null, when: 'Sent', empty: 'Nothing sent yet', emptyBody: 'This step has not gone out to anyone.' },
  accepted: { hint: 'These leads accepted the invitation while waiting here, and moved on to the next step.', detail: null, when: 'Accepted', empty: 'No acceptances yet', emptyBody: 'No one has accepted while waiting here.' },
  replied: { hint: 'The first reply to this step. Open a lead to see the whole conversation.', detail: 'Reply', when: 'Replied', empty: 'No replies yet', emptyBody: 'No one has replied to this step.' },
  failed: { hint: 'To run a lead through again, enrol them again. The preview warns about leads already contacted.', detail: 'Reason', when: 'When', empty: 'No failed leads', emptyBody: 'Nothing needs recovering here.' },
  skipped: { hint: 'A skipped step needs no action. The lead moved on to the next step.', detail: 'Reason', when: 'When', empty: 'No skipped steps', emptyBody: 'No step was skipped here.' },
};
const STEP_KINDS: FailedKind[] = ['queued', 'sent', 'accepted', 'replied', 'failed', 'skipped'];
const RECOVERY_KINDS: FailedKind[] = ['failed', 'skipped'];

/** "in 3h" for a due time still ahead, otherwise the usual "3h ago". */
function whenText(at: string | null): string {
  if (!at) return '—';
  const m = Math.round((new Date(at).getTime() - Date.now()) / 60000);
  if (m < 1) return timeAgo(at);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  return h < 24 ? `in ${h}h` : `in ${Math.round(h / 24)}d`;
}

interface PanelProps {
  sequenceId: string;
  nodeId?: string | null;
  kind: FailedKind;
  onKindChange?: (k: FailedKind) => void;
  /** The tabs to offer, in order. Defaults to failed and skipped. */
  kinds?: FailedKind[];
  graph?: Graph | null;
  canWrite: boolean;
  /** Counts shown on the tabs when the caller already has them (canvas badges). Kinds at 0 are hidden. */
  counts?: Partial<Record<FailedKind, number>>;
  active?: boolean;
}

export function FailedLeadsPanel({ sequenceId, nodeId = null, kind, onKindChange, kinds = RECOVERY_KINDS, graph, canWrite, counts, active = true }: PanelProps) {
  const qc = useQueryClient();
  const toast = useToast();
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Map<string, FailedLeadRow>>(new Map());
  const [confirm, setConfirm] = useState<RecoverAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ action: RecoverAction; result: RecoverResult; names: Record<string, string> } | null>(null);
  const q = useFailedLeads(sequenceId, nodeId, kind, page, active);
  const rows = useMemo(() => q.data ?? [], [q.data]);
  // the row RPC carries names only: the LinkedIn link and the pictures come from the leads and senders themselves
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const leadIds = useMemo(() => [...new Set(rows.map((r) => r.lead_id))].sort(), [rows]);
  const leadInfo = useQuery({
    queryKey: ['outreach', 'lead_links', leadIds],
    enabled: leadIds.length > 0,
    queryFn: async () => {
      const { data, error } = await db.from('outreach_leads').select('id, public_identifier, profile_url, picture_url').in('id', leadIds);
      if (error) throw parseError(error);
      type L = { id: string; public_identifier: string | null; profile_url: string | null; picture_url: string | null };
      return Object.fromEntries(((data ?? []) as unknown as L[]).map((l) => [l.id, l])) as Record<string, L>;
    },
  });
  const linkedinUrl = (leadId: string): string | null => {
    const l = leadInfo.data?.[leadId];
    if (!l) return null;
    return l.profile_url || (l.public_identifier ? `https://www.linkedin.com/in/${l.public_identifier}` : null);
  };
  const selectable = kind === 'failed' && canWrite;
  const copy = KIND_COPY[kind];
  const tabs = counts ? kinds.filter((k) => k === kind || Number(counts[k] ?? 0) > 0) : kinds;

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
        {onKindChange && tabs.length > 1 && (
          <div className="inline-flex flex-wrap rounded-lg border border-gray-200 bg-white p-0.5 text-xs" role="radiogroup" aria-label="Which leads">
            {tabs.map((k) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => onKindChange(k)} className={cn('px-3 py-1 rounded-md capitalize', kind === k ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>
                {k}{counts?.[k] != null ? ` (${fmtInt(counts[k])})` : ''}
              </button>
            ))}
          </div>
        )}
        {selectable && (
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-gray-500 mr-1" aria-live="polite"><span className="tabular-nums">{fmtInt(selected.size)}</span> selected</span>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('retry')}><RotateCw className="w-3.5 h-3.5" /> Retry this step</Button>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('skip')}><SkipForward className="w-3.5 h-3.5" /> Skip this step</Button>
            <Button size="sm" variant="secondary" disabled={selected.size === 0} onClick={() => setConfirm('exit')} className="text-red-700"><LogOut className="w-3.5 h-3.5" /> Exit</Button>
          </div>
        )}
      </div>

      <p className="text-xs text-gray-500">{copy.hint}</p>

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
        <EmptyState title={page > 0 ? 'No more leads' : copy.empty} description={page > 0 ? undefined : copy.emptyBody} />
      ) : (
        <Table className={cn(q.isFetching && 'opacity-70')}>
          <thead>
            <tr>
              {selectable && <Th className="w-8"><input type="checkbox" checked={allOnPage} onChange={togglePage} aria-label="Select all on this page" className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Th>}
              <Th>Lead</Th>{copy.detail && <Th>{copy.detail}</Th>}{!nodeId && <Th>Step</Th>}<Th>Sender</Th><Th>{copy.when}</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const checked = selected.has(r.enrollment_id);
              return (
                <tr key={`${r.enrollment_id}:${r.node_id ?? ''}:${i}`} className={cn(checked && 'bg-indigo-50/50')}>
                  {selectable && <Td><input type="checkbox" checked={checked} onChange={() => toggle(r)} aria-label={`Select ${r.lead_name || 'lead'}`} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>}
                  <Td>
                    {(() => {
                      const url = linkedinUrl(r.lead_id);
                      const name = r.lead_name || 'Lead';
                      return (
                        <div className="flex items-center gap-2 min-w-0">
                          <Avatar src={leadInfo.data?.[r.lead_id]?.picture_url} name={name} size={8} />
                          <span className="min-w-0">
                            {url
                              ? <a href={url} target="_blank" rel="noopener noreferrer" title="Open the LinkedIn profile in a new tab" className="font-medium text-gray-900 hover:text-indigo-700 inline-flex items-center gap-1 max-w-[180px]"><span className="truncate">{name}</span><ExternalLink className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /></a>
                              : <Link href={`/outreach/leads/${r.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700 block truncate max-w-[180px]">{name}</Link>}
                            <span className="block text-xs text-gray-500 truncate max-w-[180px]">{r.company}{r.company && url ? ' · ' : ''}{url && <Link href={`/outreach/leads/${r.lead_id}`} className="hover:text-indigo-700">Lead page</Link>}</span>
                          </span>
                        </div>
                      );
                    })()}
                  </Td>
                  {copy.detail && (
                    <Td>
                      {kind === 'replied'
                        ? <span className="block text-gray-800 line-clamp-2 max-w-[280px]" title={r.reason ?? undefined}>{r.reason ?? <span className="text-gray-400">No text</span>}</span>
                        : <span className="block text-gray-800">{r.reason ?? '—'}</span>}
                      {kind === 'failed' && !r.recoverable && <Badge tone="gray" className="mt-0.5">Cannot be retried</Badge>}
                    </Td>
                  )}
                  {!nodeId && <Td className="text-gray-600">{r.node_id ? nodeTitle(graph?.nodes[r.node_id]) : '—'}</Td>}
                  <Td className="text-gray-600 whitespace-nowrap">
                    {(() => {
                      const s = senders.data?.find((x) => x.id === r.sender_id);
                      const name = s ? senderName(s) : r.sender_name;
                      return name ? <span className="inline-flex items-center gap-2"><Avatar src={s?.picture_url} name={name} size={6} />{name}</span> : '—';
                    })()}
                  </Td>
                  <Td className="text-gray-500 whitespace-nowrap" title={r.at ?? undefined}>{kind === 'queued' ? whenText(r.at) : timeAgo(r.at)}</Td>
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
  open: boolean; onClose: () => void; sequenceId: string; nodeId?: string | null; nodeLabel?: string; initialKind?: FailedKind; graph?: Graph | null; canWrite: boolean; counts?: Partial<Record<FailedKind, number>>;
}) {
  const [kind, setKind] = useState<FailedKind>(initialKind);
  useEffect(() => { if (open) setKind(initialKind); }, [open, initialKind, nodeId]);
  // a step opened from its chips offers every number on it; the sequence-wide list stays failed and skipped
  const step = !!nodeId;
  const recovery = RECOVERY_KINDS.includes(kind);
  return (
    <Drawer
      open={open} onClose={onClose} width="max-w-3xl"
      title={step && nodeLabel ? `Leads at “${nodeLabel}”` : 'Failed and skipped leads'}
      subtitle={recovery ? 'Each lead shows why the step did not go through.' : 'The leads behind this number on the step.'}
    >
      {open && <FailedLeadsPanel sequenceId={sequenceId} nodeId={nodeId ?? null} kind={kind} onKindChange={setKind} kinds={step ? STEP_KINDS : RECOVERY_KINDS} graph={graph} canWrite={canWrite} counts={counts} />}
    </Drawer>
  );
}
