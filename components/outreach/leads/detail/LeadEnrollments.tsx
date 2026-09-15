'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { qk, useSenders, useSequences } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import { NODE_CATALOG } from '@/lib/outreach/nodes';
import { LIVE_ENROLLMENT_STATUSES, type Enrollment } from '@/lib/outreach/types';
import { Button, Card, EmptyState, EnrollmentBadge, Modal, fmtDate } from '@/components/outreach/ui';
import { GitBranch, LogOut, Pause, Play } from 'lucide-react';
import type { ToastFn } from '../helpers';

export function LeadEnrollments({ leadId, enrollments, onEnroll, toast }: { leadId: string; enrollments: Enrollment[]; onEnroll: () => void; toast: ToastFn }) {
  const { workspace, canWrite } = useWorkspace();
  const qc = useQueryClient();
  const sequences = useSequences(workspace?.id);
  const senders = useSenders(workspace?.id);
  const [busy, setBusy] = useState<string | null>(null);
  const [exitTarget, setExitTarget] = useState<Enrollment | null>(null);
  const [reason, setReason] = useState('');

  const invalidate = () => { qc.invalidateQueries({ queryKey: qk.lead(leadId) }); qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] }); if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'dashboard'] }); };
  const act = async (e: Enrollment, fn: 'pause_enrollment' | 'resume_enrollment' | 'exit_enrollment', args: Record<string, unknown>, msg: string) => {
    setBusy(e.id);
    try { await rpc(fn, { p_id: e.id, ...args }); invalidate(); toast(msg); setExitTarget(null); setReason(''); }
    catch (err) { toast(parseError(err).message, 'error'); }
    finally { setBusy(null); }
  };

  const nodeLabel = (e: Enrollment) => {
    const seq = sequences.data?.find((s) => s.id === e.sequence_id);
    if (!seq || !e.current_node_id) return null;
    const node = seq.graph?.nodes?.[e.current_node_id];
    if (!node) return e.current_node_id;
    return node.label || NODE_CATALOG[node.type]?.label || node.type;
  };

  return (
    <Card title="Sequence enrollments" actions={canWrite ? <Button size="sm" onClick={onEnroll}><GitBranch className="w-3.5 h-3.5" /> Enrol</Button> : undefined}>
      {enrollments.length === 0 ? <EmptyState title="Not enrolled in any sequence" description="Enrol this lead to start automated outreach." action={canWrite ? <Button variant="secondary" onClick={onEnroll}>Enrol in a sequence</Button> : undefined} /> : (
        <ul className="divide-y divide-gray-100 -mx-5 -my-5">
          {enrollments.map((e) => {
            const seq = sequences.data?.find((s) => s.id === e.sequence_id);
            const sender = senders.data?.find((s) => s.id === e.sender_id);
            const live = LIVE_ENROLLMENT_STATUSES.includes(e.status);
            const label = nodeLabel(e);
            return (
              <li key={e.id} className="px-5 py-3 flex flex-col md:flex-row md:items-center gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    {seq ? <Link href={`/outreach/sequences/${seq.id}`} className="font-medium text-gray-900 hover:text-indigo-700 truncate">{seq.name}</Link> : <span className="font-medium text-gray-500">Deleted sequence</span>}
                    <EnrollmentBadge status={e.status} />
                    <span className="text-xs text-gray-400">v{e.sequence_version}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>Sender: {sender ? (sender.display_name ?? sender.public_identifier ?? 'Sender') : '—'}</span>
                    {label && live && <span>Step: <span className="text-gray-700">{label}</span></span>}
                    {e.wait_until && live && <span>Waiting until {fmtDate(e.wait_until)}</span>}
                    {e.exit_reason && <span>Reason: {e.exit_reason}</span>}
                    {e.rotation_count > 0 && <span>Rotations: {e.rotation_count}</span>}
                    <span>Started {fmtDate(e.created_at)}</span>
                    {e.completed_at && <span>Ended {fmtDate(e.completed_at)}</span>}
                  </div>
                </div>
                {canWrite && live && (
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {e.status === 'paused'
                      ? <Button size="sm" variant="secondary" loading={busy === e.id} onClick={() => act(e, 'resume_enrollment', {}, 'Enrollment resumed')}><Play className="w-3.5 h-3.5" /> Resume</Button>
                      : <Button size="sm" variant="secondary" loading={busy === e.id} onClick={() => act(e, 'pause_enrollment', {}, 'Enrollment paused')}><Pause className="w-3.5 h-3.5" /> Pause</Button>}
                    <Button size="sm" variant="ghost" className="text-red-600" disabled={busy === e.id} onClick={() => setExitTarget(e)}><LogOut className="w-3.5 h-3.5" /> Exit</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Modal open={!!exitTarget} onClose={() => setExitTarget(null)} title="Exit this enrollment?" size="sm"
        footer={<><Button variant="secondary" onClick={() => setExitTarget(null)}>Cancel</Button><Button variant="danger" loading={!!exitTarget && busy === exitTarget.id} onClick={() => exitTarget && act(exitTarget, 'exit_enrollment', { p_reason: reason.trim() || 'manual' }, 'Enrollment exited')}>Exit enrollment</Button></>}>
        <p className="text-sm text-gray-600 mb-3">Queued actions are cancelled and the lead leaves the sequence. You can re-enrol later.</p>
        <label className="block">
          <span className="block text-xs font-medium text-gray-600 mb-1">Reason (optional)</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. booked a meeting" className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </label>
      </Modal>
    </Card>
  );
}
