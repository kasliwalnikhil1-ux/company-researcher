'use client';

import { useState } from 'react';
import { Button, ErrorBox, Input, Modal, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { projectSequence, type ProjectionRow } from './hooks';
import { formatDays } from './helpers';

const ACTION_LABEL: Record<string, string> = { invite: 'Invitations', message: 'Messages', inmail: 'InMails', profile_view: 'Profile views', like: 'Likes', comment: 'Comments', endorse: 'Endorsements', email: 'Emails', withdraw: 'Withdrawals', call_api: 'API calls' };

export function ProjectionView({ row, leadCount }: { row: ProjectionRow; leadCount: number }) {
  const d = row.details ?? {};
  const pool = Number(d.pool_size ?? 0);
  const waitDays = Number(d.wait_days ?? 0);
  const rows = Object.entries(d).filter(([k, v]) => v && typeof v === 'object' && 'total' in (v as object)) as Array<[string, { total: number; per_day: number; days: number }]>;
  return (
    <div className="space-y-3">
      <div className="rounded-lg bg-indigo-50 text-indigo-900 px-4 py-3 text-sm">
        <span className="font-semibold">{leadCount.toLocaleString()} leads ≈ {formatDays(row.estimated_days)}</span> on {pool} sender{pool === 1 ? '' : 's'}
        {row.bottleneck && <>; bottleneck: <span className="font-semibold">{(ACTION_LABEL[row.bottleneck] ?? row.bottleneck).toLowerCase()}</span></>}
        {pool === 0 && <span className="block text-xs mt-1 text-indigo-700">Add senders to the pool — nothing can be scheduled without one.</span>}
      </div>
      {rows.length > 0 ? (
        <Table>
          <thead><tr><Th>Action</Th><Th className="text-right">Total</Th><Th className="text-right">Pool capacity / day</Th><Th className="text-right">Days</Th></tr></thead>
          <tbody>
            {rows.sort((a, b) => b[1].days - a[1].days).map(([k, v]) => (
              <tr key={k} className={k === row.bottleneck ? 'bg-amber-50' : ''}>
                <Td>{ACTION_LABEL[k] ?? k}</Td>
                <Td className="text-right tabular-nums">{Number(v.total).toLocaleString()}</Td>
                <Td className="text-right tabular-nums">{Number(v.per_day).toLocaleString()}</Td>
                <Td className="text-right tabular-nums">{Number(v.days) >= 9999 ? '∞' : Number(v.days).toLocaleString()}</Td>
              </tr>
            ))}
            {waitDays > 0 && <tr><Td className="text-gray-500" colSpan={3}>Waits and delays along the longest path</Td><Td className="text-right tabular-nums">{waitDays}</Td></tr>}
          </tbody>
        </Table>
      ) : (
        <p className="text-xs text-gray-500">This sequence has no sending steps, so its length only depends on waits and delays.</p>
      )}
      <p className="text-xs text-gray-500">Capacity comes from each sender’s warm-up level, account health, the limits you set and their working days, plus LinkedIn’s weekly invitation ceiling. Real speed also depends on how many leads accept and reply.</p>
    </div>
  );
}

export function ProjectionModal({ open, onClose, sequenceId, defaultCount = 1000, beforeRun }: { open: boolean; onClose: () => void; sequenceId: string; defaultCount?: number; beforeRun?: () => Promise<boolean> }) {
  const [count, setCount] = useState(defaultCount);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ row: ProjectionRow; count: number } | null>(null);

  const run = async () => {
    setBusy(true); setError(null);
    try {
      if (beforeRun && !(await beforeRun())) { setBusy(false); return; }
      const row = await projectSequence(sequenceId, Math.max(1, count));
      if (!row) setError('No projection available for this sequence.');
      else setResult({ row, count: Math.max(1, count) });
    } catch (e) { setError(parseError(e).message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open={open} onClose={onClose} title="Projection" size="lg" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button loading={busy} onClick={run}>{result ? 'Recalculate' : 'Project'}</Button></>}>
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <Input type="number" min={1} max={100000} label="Number of leads" value={count} onChange={(e) => setCount(Number(e.target.value) || 0)} className="max-w-[160px]" onKeyDown={(e) => { if (e.key === 'Enter') run(); }} />
          <span className="text-xs text-gray-500 pb-2.5">Estimated from the saved sequence and the current sender pool.</span>
        </div>
        {error && <ErrorBox message={error} />}
        {busy && !result && <Spinner className="py-6" />}
        {result && <ProjectionView row={result.row} leadCount={result.count} />}
      </div>
    </Modal>
  );
}
