'use client';

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, HelpCircle, Info, RefreshCw } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, Modal, Spinner, fmtDate } from '@/components/outreach/ui';
import { plainText, useSenderDiagnosis, type DiagnosisCause } from './insights';

function nextCapacity(v: string | null | undefined): string | null {
  if (!v) return null;
  const t = new Date(v);
  return isNaN(t.getTime()) ? v : fmtDate(v);   // the database sometimes answers "tomorrow"
}

type CauseGroup = { key: string; details: string[]; remedy: string; next: string | null };

/** Causes that share a code and a remedy (for example one "allowance is 0" per action type) read better as one card. */
function groupCauses(causes: DiagnosisCause[]): CauseGroup[] {
  const out: CauseGroup[] = [];
  for (const c of causes) {
    const key = `${c.code}|${c.remedy}|${c.sender_id ?? ''}`;
    const g = out.find((x) => x.key === key);
    if (g) { g.details.push(c.detail); g.next = g.next ?? nextCapacity(c.next_capacity); }
    else out.push({ key, details: [c.detail], remedy: c.remedy, next: nextCapacity(c.next_capacity) });
  }
  return out;
}

function CauseRow({ g, blocking }: { g: CauseGroup; blocking: boolean }) {
  return (
    <li className={`rounded-lg border p-3 ${blocking ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-gray-50'}`}>
      <div className="flex items-start gap-2">
        {blocking ? <AlertTriangle className="w-4 h-4 mt-0.5 text-red-600 flex-shrink-0" aria-hidden /> : <Info className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" aria-hidden />}
        <div className="min-w-0">
          {g.details.length === 1
            ? <div className={`text-sm ${blocking ? 'text-red-900 font-medium' : 'text-gray-800'}`}>{plainText(g.details[0])}</div>
            : <ul className={`text-sm list-disc pl-4 space-y-0.5 ${blocking ? 'text-red-900 font-medium' : 'text-gray-800'}`}>{g.details.map((d, i) => <li key={i}>{plainText(d)}</li>)}</ul>}
          <div className={`text-sm mt-1 ${blocking ? 'text-red-800' : 'text-gray-600'}`}><span className="font-medium">What to do:</span> {plainText(g.remedy)}</div>
          {g.next && <div className="text-xs text-gray-500 mt-1">Sending can continue: {g.next}</div>}
        </div>
      </div>
    </li>
  );
}

function DiagnosisBody({ senderId }: { senderId: string }) {
  const q = useSenderDiagnosis(senderId, true);
  if (q.isLoading) return <Spinner className="py-8" />;
  if (q.isError) return <ErrorBox message={parseError(q.error).message} />;
  const d = q.data;
  if (!d) return null;
  const blocking = groupCauses(d.causes.filter((c) => c.blocking));
  const info = groupCauses(d.causes.filter((c) => !c.blocking));

  return (
    <div className="space-y-4" aria-live="polite">
      <div className={`flex items-start gap-2 rounded-lg p-3 text-sm ${d.blocked ? 'bg-red-50 text-red-900 border border-red-200' : 'bg-green-50 text-green-900 border border-green-200'}`}>
        {d.blocked ? <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden /> : <CheckCircle2 className="w-4 h-4 mt-0.5 flex-shrink-0" aria-hidden />}
        <div><div className="font-semibold">{d.blocked ? 'Sending is blocked' : 'Nothing is blocking this sender'}</div><div className="mt-0.5">{plainText(d.reason)}</div></div>
      </div>

      {blocking.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Blocking ({blocking.length})</h4>
          <ul className="space-y-2">{blocking.map((g) => <CauseRow key={g.key} g={g} blocking />)}</ul>
        </section>
      )}
      {info.length > 0 && (
        <section>
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Good to know ({info.length})</h4>
          <ul className="space-y-2">{info.map((g) => <CauseRow key={g.key} g={g} blocking={false} />)}</ul>
        </section>
      )}
      {d.notes.length > 0 && <p className="text-xs text-gray-500">{d.notes.join(' · ')}</p>}
      <p className="text-xs text-gray-500 border-t border-gray-100 pt-3">{d.rule}</p>
      <div className="flex justify-end"><Button size="sm" variant="ghost" onClick={() => q.refetch()} loading={q.isFetching}><RefreshCw className="w-3.5 h-3.5" /> Check again</Button></div>
    </div>
  );
}

/** "Why isn't this sending?" for one sender. The answer is `why_not_sending(p_sender)`: the same sentence the alert email and the connector give. */
export default function SenderDiagnosis({ senderId, senderName, size = 'sm' }: { senderId: string; senderName?: string | null; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size={size} variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog"><HelpCircle className="w-3.5 h-3.5" /> Why isn&apos;t this sending?</Button>
      <Modal open={open} onClose={() => setOpen(false)} size="lg" title={senderName ? `Why isn't ${senderName} sending?` : "Why isn't this sending?"}
        footer={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
        {open && <DiagnosisBody senderId={senderId} />}
      </Modal>
    </>
  );
}
