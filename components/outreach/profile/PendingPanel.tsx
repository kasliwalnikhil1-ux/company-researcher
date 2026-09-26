'use client';

// Workspace-wide view of profile changes: what is waiting for an owner, what is scheduled, what landed or failed.
import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { parseError, rpc } from '@/lib/outreach/api';
import { reasonText } from '@/lib/outreach/reasons';
import { Avatar, Badge, Button, EmptyState, Spinner, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { GROUP_LABELS, SOURCE_LABELS, STATUS_LABELS, STATUS_TONE, pqk, useProfileChanges, type ChangeStatus } from '@/lib/outreach/profile';
import { cn } from '@/lib/utils';

type Notify = (message: string, type?: 'success' | 'error') => void;
const VIEWS: Array<{ key: string; label: string; statuses: ChangeStatus[] | null }> = [
  { key: 'open', label: 'Open', statuses: ['draft', 'awaiting_owner', 'approved', 'queued'] },
  { key: 'done', label: 'Applied', statuses: ['applied', 'partially_applied', 'reverted'] },
  { key: 'failed', label: 'Failed / cancelled', statuses: ['failed', 'cancelled'] },
  { key: 'all', label: 'All', statuses: null },
];

export default function PendingPanel({ ws, canWrite, notify }: { ws: string; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const [view, setView] = useState('open');
  const v = VIEWS.find((x) => x.key === view)!;
  const q = useProfileChanges(ws, v.statuses);
  async function cancel(id: string) {
    try { await rpc('profile_cancel_change', { p_change: id, p_reason: 'cancelled from the Profiles page' }); notify('Change cancelled.'); qc.invalidateQueries({ queryKey: pqk.changes(ws, v.statuses) }); qc.invalidateQueries({ queryKey: ['outreach', 'profile'] }); }
    catch (e) { notify(parseError(e).message, 'error'); }
  }
  return (
    <div>
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 mb-4" role="tablist">
        {VIEWS.map((x) => <button key={x.key} role="tab" aria-selected={view === x.key} onClick={() => setView(x.key)} className={cn('px-3 py-1.5 text-sm font-medium rounded-md', view === x.key ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{x.label}</button>)}
      </div>
      {q.isLoading ? <Spinner /> : (q.data ?? []).length === 0 ? <EmptyState title="Nothing here" description="Profile changes are drafted on each sender's Profile tab, from a template, or by an experiment." /> : (
        <Table>
          <thead><tr><Th>Sender</Th><Th>Status</Th><Th>Fields</Th><Th>From</Th><Th>When</Th><Th /></tr></thead>
          <tbody>
            {(q.data ?? []).map((c) => (
              <tr key={c.id}>
                <Td><Link href={`/outreach/senders/${c.sender_id}?tab=Profile`} className="flex items-center gap-2 text-gray-900 hover:text-indigo-700"><Avatar src={c.sender_picture} name={c.sender_name} size={6} /><span className="font-medium">{c.sender_name ?? 'Sender'}</span></Link></Td>
                <Td><Badge tone={STATUS_TONE[c.status]}>{STATUS_LABELS[c.status]}</Badge>{c.status === 'awaiting_owner' && <div className="text-[11px] text-gray-500 mt-0.5">{c.owner_email ?? 'no owner email'}</div>}{c.error_code && <div className="text-[11px] text-amber-700 mt-0.5">{reasonText(c.error_code)}</div>}</Td>
                <Td>{c.field_groups.map((g) => GROUP_LABELS[g]).join(', ')}</Td>
                <Td className="text-gray-600">{SOURCE_LABELS[c.source] ?? c.source}</Td>
                <Td className="whitespace-nowrap text-gray-600">{fmtDate(c.applied_at ?? c.scheduled_for ?? c.created_at)}</Td>
                <Td className="text-right">{canWrite && ['draft', 'awaiting_owner', 'approved', 'queued'].includes(c.status) && <Button size="sm" variant="ghost" onClick={() => cancel(c.id)}>Cancel</Button>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </div>
  );
}
