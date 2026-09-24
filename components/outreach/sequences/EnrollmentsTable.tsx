'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { LogOut, Pause, Play } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { useEnrollments } from '@/lib/outreach/queries';
import { LIVE_ENROLLMENT_STATUSES, type EnrollmentStatus, type Sequence } from '@/lib/outreach/types';
import { Avatar, Button, Card, EmptyState, EnrollmentBadge, ErrorBox, fmtDate, Select, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { nodeTitle } from './helpers';
import { useFailedCount } from './hooks';
import { FailedLeadsPanel } from './FailedLeadsDrawer';
import type { FailedKind } from './publishTypes';

const ALL_STATUSES: EnrollmentStatus[] = ['active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused', 'completed', 'exited_replied', 'exited_manual', 'exited_suppressed', 'exited_sender_disabled', 'failed', 'cancelled'];

export default function EnrollmentsTable({ sequence, canWrite }: { sequence: Sequence; canWrite: boolean }) {
  const [filter, setFilter] = useState<'all' | 'live' | EnrollmentStatus>('live');
  // "Failed" is its own view: it shows why each lead failed and offers retry / skip / exit in bulk.
  const [view, setView] = useState<'list' | 'failed'>('list');
  const [failedKind, setFailedKind] = useState<FailedKind>('failed');
  const failedCount = useFailedCount(sequence.id);
  const status = filter === 'all' ? undefined : filter === 'live' ? LIVE_ENROLLMENT_STATUSES : [filter];
  const q = useEnrollments({ sequence_id: view === 'list' ? sequence.id : undefined, status, limit: 200 });
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, kind: 'exit' | 'pause' | 'resume') => {
    setBusy(id);
    try {
      if (kind === 'exit') await rpc('exit_enrollment', { p_id: id, p_reason: 'manual' });
      else if (kind === 'pause') await rpc('pause_enrollment', { p_id: id });
      else await rpc('resume_enrollment', { p_id: id });
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      qc.invalidateQueries({ queryKey: ['outreach', sequence.workspace_id, 'sequence_summary'] });
      toast.show(kind === 'exit' ? 'Lead taken out of the sequence' : kind === 'pause' ? 'Lead paused' : 'Lead resumed');
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusy(null); }
  };

  const rows = q.data ?? [];
  return (
    <Card title={view === 'failed' ? 'Failed and skipped leads' : `Leads in this sequence${q.data ? ` (${rows.length}${rows.length === 200 ? '+' : ''})` : ''}`} actions={
      <>
        <div className="inline-flex rounded-lg border border-gray-300 overflow-hidden text-xs" role="tablist" aria-label="Which leads to show">
          <button type="button" role="tab" aria-selected={view === 'list'} onClick={() => setView('list')} className={cn('px-3 py-1', view === 'list' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>Enrollments</button>
          <button type="button" role="tab" aria-selected={view === 'failed'} onClick={() => setView('failed')} className={cn('px-3 py-1 tabular-nums', view === 'failed' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-700 hover:bg-gray-50')}>Failed{failedCount.data ? ` (${failedCount.data.toLocaleString()})` : ''}</button>
        </div>
        {view === 'list' && (
          <Select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label="Filter enrollments" className="!py-1 !text-xs w-auto">
            <option value="live">Live</option>
            <option value="all">All</option>
            {ALL_STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </Select>
        )}
      </>
    }>
      {view === 'failed' ? (
        <FailedLeadsPanel sequenceId={sequence.id} kind={failedKind} onKindChange={setFailedKind} graph={sequence.graph} canWrite={canWrite} />
      ) : q.isLoading ? <Spinner /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : rows.length === 0 ? (
        <EmptyState title="No leads here" description={filter === 'live' ? 'No leads are currently live in this sequence.' : 'Nothing matches this filter.'} />
      ) : (
        <Table className="border-0">
          <thead><tr><Th>Lead</Th><Th>Sender</Th><Th>Status</Th><Th>Current step</Th><Th>Entered</Th><Th>Waits until</Th><Th className="text-right">Actions</Th></tr></thead>
          <tbody>
            {rows.map((e) => {
              const live = LIVE_ENROLLMENT_STATUSES.includes(e.status);
              const lead = e.outreach_leads;
              return (
                <tr key={e.id} className={busy === e.id ? 'opacity-50' : ''}>
                  <Td>
                    <Link href={`/outreach/leads/${e.lead_id}`} className="flex items-center gap-2 hover:text-indigo-700">
                      <Avatar src={lead?.picture_url} name={lead?.full_name} size={8} />
                      <span className="min-w-0"><span className="block font-medium text-gray-900 truncate max-w-[200px]">{lead?.full_name || lead?.public_identifier || 'Lead'}</span><span className="block text-xs text-gray-500 truncate max-w-[200px]">{lead?.company}</span></span>
                    </Link>
                  </Td>
                  <Td className="text-gray-600">{e.outreach_senders?.display_name ?? '—'}</Td>
                  <Td><EnrollmentBadge status={e.status} />{e.exit_reason && <span className="block text-[11px] text-gray-400 mt-0.5">{e.exit_reason}</span>}</Td>
                  <Td className="text-gray-600">{e.current_node_id ? nodeTitle(sequence.graph.nodes[e.current_node_id]) : '—'}</Td>
                  <Td className="text-gray-500 whitespace-nowrap" title={e.node_entered_at}>{timeAgo(e.node_entered_at)}</Td>
                  <Td className="text-gray-500 whitespace-nowrap">{e.wait_until ? fmtDate(e.wait_until) : '—'}</Td>
                  <Td>
                    {canWrite && live && (
                      <div className="flex items-center justify-end gap-1">
                        {e.status === 'paused'
                          ? <Button variant="ghost" size="sm" title="Resume" onClick={() => act(e.id, 'resume')}><Play className="w-3.5 h-3.5" /></Button>
                          : <Button variant="ghost" size="sm" title="Pause" onClick={() => act(e.id, 'pause')}><Pause className="w-3.5 h-3.5" /></Button>}
                        <Button variant="ghost" size="sm" title="Exit sequence" className="text-red-600" onClick={() => act(e.id, 'exit')}><LogOut className="w-3.5 h-3.5" /></Button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {toast.node}
    </Card>
  );
}
