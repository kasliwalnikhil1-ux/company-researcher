'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders, useSequences } from '@/lib/outreach/queries';
import { parseError, rpc } from '@/lib/outreach/api';
import { Button, ErrorBox, Modal, Select, Spinner, StatusPill } from '@/components/outreach/ui';
import { BULK_CAP, type ToastFn } from './helpers';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

interface EnrollResult { enrolled: number; skipped_active: number; skipped_suppressed: number; skipped_other: number }

export function EnrollModal({ open, onClose, leadIds, toast, onDone }: { open: boolean; onClose: () => void; leadIds: string[]; toast: ToastFn; onDone?: () => void }) {
  const { workspace } = useWorkspace();
  const qc = useQueryClient();
  const sequences = useSequences(workspace?.id);
  const senders = useSenders(workspace?.id);
  const [sequenceId, setSequenceId] = useState('');
  const [senderId, setSenderId] = useState('');
  const [priority, setPriority] = useState(100);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);

  const active = useMemo(() => (sequences.data ?? []).filter((s) => s.status === 'active'), [sequences.data]);
  const sequence = active.find((s) => s.id === sequenceId) ?? null;
  const poolSenders = useMemo(() => {
    if (!sequence) return [];
    return sequence.sender_pool.map((id) => senders.data?.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
  }, [sequence, senders.data]);

  useEffect(() => { if (open) { setResult(null); setError(null); setSenderId(''); } }, [open]);
  useEffect(() => { setSenderId(''); }, [sequenceId]);

  const overCap = leadIds.length > BULK_CAP;

  const submit = async () => {
    if (!sequence || overCap) return;
    setBusy(true); setError(null);
    try {
      const res = await rpc<EnrollResult[] | EnrollResult>('enroll_leads', { p_sequence: sequence.id, p_lead_ids: leadIds, p_sender: senderId || null, p_priority: priority });
      const row = Array.isArray(res) ? res[0] : res;
      setResult(row ?? { enrolled: 0, skipped_active: 0, skipped_suppressed: 0, skipped_other: 0 });
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      for (const id of leadIds.slice(0, 50)) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
      if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'dashboard'] });
      toast(`Enrolled ${row?.enrolled ?? 0} lead${(row?.enrolled ?? 0) === 1 ? '' : 's'} into ${sequence.name}`);
      onDone?.();
    } catch (e) {
      setError(parseError(e).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Enrol ${leadIds.length.toLocaleString()} lead${leadIds.length === 1 ? '' : 's'} in a sequence`} size="md"
      footer={result ? <Button onClick={onClose}>Done</Button> : (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!sequence || overCap || leadIds.length === 0}>Enrol</Button>
        </>
      )}>
      {sequences.isLoading ? <Spinner /> : sequences.error ? <ErrorBox message={parseError(sequences.error).message} /> : result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-gray-900 font-medium"><CheckCircle2 className="w-5 h-5 text-green-600" /> Enrolment finished</div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <dt className="text-gray-500">Enrolled</dt><dd className="font-semibold text-green-700 tabular-nums">{result.enrolled.toLocaleString()}</dd>
            <dt className="text-gray-500">Skipped — already active with this sender</dt><dd className="tabular-nums">{result.skipped_active.toLocaleString()}</dd>
            <dt className="text-gray-500">Skipped — suppressed / do-not-contact</dt><dd className="tabular-nums">{result.skipped_suppressed.toLocaleString()}</dd>
            <dt className="text-gray-500">Skipped — other</dt><dd className="tabular-nums">{result.skipped_other.toLocaleString()}</dd>
          </dl>
        </div>
      ) : (
        <div className="space-y-4">
          {overCap && <ErrorBox message={`You selected ${leadIds.length.toLocaleString()} leads; the maximum per enrolment is ${BULK_CAP.toLocaleString()}. Narrow the selection.`} />}
          {active.length === 0 ? (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" /> No active sequences. Activate a sequence first, then enrol leads.</div>
          ) : (
            <Select label="Sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)}>
              <option value="">Choose an active sequence…</option>
              {active.map((s) => <option key={s.id} value={s.id}>{s.name}{s.throttled_reason ? ' (throttled)' : ''}</option>)}
            </Select>
          )}
          {sequence && (
            <>
              <div>
                <span className="block text-xs font-medium text-gray-600 mb-1">Sender</span>
                {poolSenders.length === 0 ? (
                  <p className="text-xs text-red-600">This sequence has no senders in its pool.</p>
                ) : (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="radio" name="enrol-sender" checked={senderId === ''} onChange={() => setSenderId('')} className="text-indigo-600" />
                      Use pool assignment ({sequence.assignment.replace('_', ' ')})
                    </label>
                    {poolSenders.map((s) => (
                      <label key={s.id} className="flex items-center gap-2 text-sm text-gray-700">
                        <input type="radio" name="enrol-sender" checked={senderId === s.id} onChange={() => setSenderId(s.id)} className="text-indigo-600" />
                        <span className="truncate">{s.display_name ?? s.public_identifier ?? s.owner_email ?? 'Sender'}</span>
                        <StatusPill status={s.status} reason={s.status_reason} />
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">Priority <span className="text-gray-400 font-normal">(lower runs first, default 100)</span></span>
                <input type="number" min={1} max={1000} value={priority} onChange={(e) => setPriority(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))} className="w-32 px-3 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
              <p className="text-xs text-gray-500">Leads already active in a sequence with the chosen sender, and do-not-contact or suppressed leads, are skipped. Actions are scheduled within each sender&apos;s daily caps and working hours.</p>
            </>
          )}
          {error && <ErrorBox message={error} />}
        </div>
      )}
    </Modal>
  );
}
