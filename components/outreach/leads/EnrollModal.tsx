'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useSenders, useSequences } from '@/lib/outreach/queries';
import { parseError } from '@/lib/outreach/api';
import { SEQUENCE_ASSIGNMENTS, type EnrollResult } from '@/lib/outreach/types';
import { Button, ErrorBox, Modal, Select, Spinner, StatusPill } from '@/components/outreach/ui';
import {
  commitEnrollment, EnrollOptions, EnrollPreviewPanel, EnrollResultPanel, requestAiLines, useEnrollPreview, useSequenceAiVariables,
  type AiBatchLink, type EnrollOptionsValue,
} from '@/app/outreach/sequences/[id]/enroll/EnrollGuard';
import { BULK_CAP, type ToastFn } from './helpers';

export function EnrollModal({ open, onClose, leadIds, toast, onDone }: { open: boolean; onClose: () => void; leadIds: string[]; toast: ToastFn; onDone?: () => void }) {
  const { workspace } = useWorkspace();
  const ws = workspace?.id ?? null;
  const qc = useQueryClient();
  const sequences = useSequences(ws);
  const senders = useSenders(ws);
  const [sequenceId, setSequenceId] = useState('');
  const [senderId, setSenderId] = useState('');
  const [priority, setPriority] = useState(100);
  const [includeReplied, setIncludeReplied] = useState(false);
  const [options, setOptions] = useState<EnrollOptionsValue | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [result, setResult] = useState<EnrollResult | null>(null);
  const [aiBatches, setAiBatches] = useState<AiBatchLink[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);

  const active = useMemo(() => (sequences.data ?? []).filter((s) => s.status === 'active'), [sequences.data]);
  const sequence = active.find((s) => s.id === sequenceId) ?? null;
  const poolSenders = useMemo(() => {
    if (!sequence) return [];
    return sequence.sender_pool.map((id) => senders.data?.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
  }, [sequence, senders.data]);

  useEffect(() => { if (open) { setResult(null); setError(null); setPartialError(null); setSenderId(''); setIncludeReplied(false); setOptions(null); setAiBatches([]); setAiError(null); } }, [open]);
  useEffect(() => { setSenderId(''); setIncludeReplied(false); setOptions(null); setError(null); }, [sequenceId]);

  const overCap = leadIds.length > BULK_CAP;
  const busy = progress != null;
  const ai = useSequenceAiVariables(ws, sequence?.graph);
  const guard = useEnrollPreview(sequence?.id ?? null, leadIds, senderId || null, includeReplied, open && !!sequence && !overCap && !result && poolSenders.length > 0);
  const eligible = guard.preview?.eligible ?? 0;
  const opts: EnrollOptionsValue = options ?? { waitEnrichment: !!sequence?.settings?.wait_for_enrichment, generateAi: true };
  const rule = SEQUENCE_ASSIGNMENTS.find((a) => a.value === sequence?.assignment);

  const submit = async () => {
    if (!sequence || !ws || overCap || !guard.preview || eligible === 0) return;
    const enrolledIds = guard.preview.eligible_ids;
    setError(null); setPartialError(null); setAiError(null); setAiBatches([]);
    setProgress({ done: 0, total: leadIds.length });
    let total: EnrollResult | null = null;
    try {
      total = await commitEnrollment(sequence.id, leadIds, { senderId: senderId || null, priority, includeReplied, waitEnrichment: opts.waitEnrichment, onProgress: (done, all) => setProgress({ done, total: all }) });
    } catch (e) {
      const partial = (e as { partial?: EnrollResult }).partial;
      if (partial && partial.enrolled > 0) { total = partial; setPartialError(parseError(e).message); }
      else setError(parseError(e).message);
    }
    if (total) {
      if (opts.generateAi && ai.used.length > 0 && total.enrolled > 0 && enrolledIds.length > 0) {
        try { setAiBatches(await requestAiLines(ws, sequence.id, ai.used, enrolledIds)); }
        catch (e) { setAiError(parseError(e).message); }
      }
      setResult(total);
      qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
      for (const id of leadIds.slice(0, 50)) qc.invalidateQueries({ queryKey: ['outreach', 'lead', id] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'dashboard'] });
      toast(`Enrolled ${total.enrolled.toLocaleString()} lead${total.enrolled === 1 ? '' : 's'} into ${sequence.name}`);
      onDone?.();
    }
    setProgress(null);
  };

  return (
    <Modal open={open} onClose={() => { if (!busy) onClose(); }} title={`Enrol ${leadIds.length.toLocaleString()} lead${leadIds.length === 1 ? '' : 's'} in a sequence`} size="lg"
      footer={result ? <Button onClick={onClose}>Done</Button> : (
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={submit} loading={busy} disabled={!sequence || overCap || leadIds.length === 0 || guard.loading || !guard.preview || eligible === 0}>
            {guard.preview ? `Enrol ${eligible.toLocaleString()} lead${eligible === 1 ? '' : 's'}` : 'Enrol'}
          </Button>
        </>
      )}>
      {sequences.isLoading ? <Spinner /> : sequences.error ? <ErrorBox message={parseError(sequences.error).message} /> : result ? (
        <EnrollResultPanel result={result} aiBatches={aiBatches} aiError={aiError} partialError={partialError} />
      ) : (
        <div className="space-y-4">
          {overCap && <ErrorBox message={`You selected ${leadIds.length.toLocaleString()} leads. The most you can enrol at once is ${BULK_CAP.toLocaleString()}. Narrow the selection.`} />}
          {active.length === 0 ? (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 text-amber-800 text-sm"><AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden /><span>No active sequences. <Link href="/outreach/sequences" className="underline">Activate a sequence</Link> first, then enrol leads.</span></div>
          ) : (
            <Select label="Sequence" value={sequenceId} onChange={(e) => setSequenceId(e.target.value)} disabled={busy}>
              <option value="">Choose an active sequence…</option>
              {active.map((s) => <option key={s.id} value={s.id}>{s.name}{s.throttled_reason ? ' (throttled)' : ''}{s.stalled_at ? ' (stalled)' : ''}</option>)}
            </Select>
          )}
          {sequence && (
            <>
              <fieldset disabled={busy}>
                <legend className="block text-xs font-medium text-gray-600 mb-1">Sender</legend>
                {poolSenders.length === 0 ? (
                  <p className="text-xs text-red-600">This sequence has no senders in its pool. Add one in the builder first.</p>
                ) : (
                  <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-sm text-gray-700">
                      <input type="radio" name="enrol-sender" checked={senderId === ''} onChange={() => setSenderId('')} className="text-indigo-600" />
                      Use the assignment rule ({rule?.label.toLowerCase() ?? sequence.assignment.replace(/_/g, ' ')})
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
              </fieldset>
              <label className="block">
                <span className="block text-xs font-medium text-gray-600 mb-1">Priority <span className="text-gray-400 font-normal">(lower runs first, default 100)</span></span>
                <input type="number" min={1} max={1000} value={priority} disabled={busy} onChange={(e) => setPriority(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))} className="w-32 px-3 py-2 text-sm rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
              </label>
              {poolSenders.length > 0 && !overCap && (
                <div className="border-t border-gray-100 pt-4 space-y-4">
                  <EnrollPreviewPanel preview={guard.preview} loading={guard.loading} error={guard.error} includeReplied={includeReplied} onIncludeReplied={setIncludeReplied} compact />
                  {guard.error && <Button variant="secondary" size="sm" onClick={guard.refresh}>Try again</Button>}
                  {guard.preview && eligible > 0 && <EnrollOptions sequence={sequence} value={opts} onChange={setOptions} ai={ai} disabled={busy} />}
                </div>
              )}
              {progress && leadIds.length > 500 && (
                <div role="status" aria-live="polite">
                  <div className="h-2 bg-gray-200 rounded-full overflow-hidden"><div className="h-full bg-indigo-600 transition-all" style={{ width: `${Math.round((progress.done / Math.max(1, progress.total)) * 100)}%` }} /></div>
                  <div className="text-xs text-gray-500 mt-1">Enrolling {progress.done.toLocaleString()} / {progress.total.toLocaleString()}…</div>
                </div>
              )}
              <p className="text-xs text-gray-500">Messages are scheduled inside each sender&apos;s daily limits and working hours.</p>
            </>
          )}
          {error && <ErrorBox message={error} />}
        </div>
      )}
    </Modal>
  );
}
