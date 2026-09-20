'use client';

// "Why isn't this sending?" (plan item 3). Renders rpc why_not_sending for a sequence, a sender or one enrolment.
// Exported for the sender page and the lead panel: <WhyNotSendingDialog open onClose sequenceId|senderId|enrollmentId />.
import Link from 'next/link';
import { AlertOctagon, CheckCircle2, Clock, Info, RefreshCw } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { Button, ErrorBox, fmtDate, Modal, Spinner } from '@/components/outreach/ui';
import { useWhyNotSending } from './hooks';
import type { WhyCause } from './publishTypes';

export interface WhyNotSendingProps { open: boolean; onClose: () => void; sequenceId?: string | null; senderId?: string | null; enrollmentId?: string | null }

function Cause({ c }: { c: WhyCause }) {
  const blocking = c.blocking;
  return (
    <li className={`rounded-lg border px-3 py-2.5 ${blocking ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start gap-2">
        {blocking ? <AlertOctagon className="w-4 h-4 mt-0.5 text-red-600 flex-shrink-0" /> : <Info className="w-4 h-4 mt-0.5 text-gray-400 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <p className={`text-sm ${blocking ? 'text-red-900 font-medium' : 'text-gray-800'}`}>{c.detail}</p>
          {c.remedy && <p className={`text-xs mt-0.5 ${blocking ? 'text-red-800' : 'text-gray-600'}`}><span className="font-medium">What to do:</span> {c.remedy}</p>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-[11px] text-gray-500">
            {c.next_capacity && <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> Next capacity {fmtDate(c.next_capacity)}</span>}
            {c.partial && <span>Other senders in the pool keep sending.</span>}
            {c.sender_id && <Link href={`/outreach/senders/${c.sender_id}`} className="text-indigo-600 hover:underline">Open {c.sender || 'sender'}</Link>}
            {c.task_id && <Link href="/outreach/tasks" className="text-indigo-600 hover:underline">Open tasks</Link>}
            <span className="font-mono opacity-70">{c.code}</span>
          </div>
        </div>
      </div>
    </li>
  );
}

export function WhyNotSendingDialog({ open, onClose, sequenceId, senderId, enrollmentId }: WhyNotSendingProps) {
  const q = useWhyNotSending({ sequenceId, senderId, enrollmentId }, open);
  if (!open) return null;
  const d = q.data;
  const blocking = (d?.causes ?? []).filter((c) => c.blocking);
  const info = (d?.causes ?? []).filter((c) => !c.blocking);
  return (
    <Modal open onClose={onClose} title="Why isn't this sending?" size="lg" footer={
      <>
        <Button variant="secondary" size="sm" className="mr-auto" onClick={() => q.refetch()} loading={q.isFetching && !q.isLoading}><RefreshCw className="w-3.5 h-3.5" /> Check again</Button>
        <Button onClick={onClose} autoFocus>Close</Button>
      </>
    }>
      {q.isLoading ? (
        <div className="py-8 text-center"><Spinner className="py-2" /><p className="text-sm text-gray-600">Checking senders, caps, schedules and leads…</p></div>
      ) : q.error ? (
        <ErrorBox message={parseError(q.error).message} />
      ) : d ? (
        <div className="space-y-4" aria-live="polite">
          <div className={`flex items-start gap-2 rounded-lg px-3 py-2.5 ${d.blocked ? 'bg-red-50 text-red-900' : 'bg-green-50 text-green-900'}`}>
            {d.blocked ? <AlertOctagon className="w-5 h-5 mt-0.5 flex-shrink-0" /> : <CheckCircle2 className="w-5 h-5 mt-0.5 flex-shrink-0" />}
            <div className="min-w-0">
              {d.target && <p className="text-xs opacity-80">{d.target}</p>}
              <p className="text-sm font-semibold">{d.reason}</p>
            </div>
          </div>

          {blocking.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Blocking ({blocking.length})</h4>
              <ul className="space-y-2">{blocking.map((c, i) => <Cause key={`b${i}`} c={c} />)}</ul>
            </section>
          )}
          {info.length > 0 && (
            <section>
              <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Good to know ({info.length})</h4>
              <ul className="space-y-2">{info.map((c, i) => <Cause key={`i${i}`} c={c} />)}</ul>
            </section>
          )}
          {blocking.length === 0 && info.length === 0 && <p className="text-sm text-gray-600">No cap, schedule, health or lead issue was found.</p>}

          {(d.notes?.length ?? 0) > 0 && <p className="text-xs text-gray-500">{d.notes.join(' · ')}</p>}
          <p className="text-xs text-gray-500">Caps, schedules and health limits protect the LinkedIn accounts. When one of them blocks sending, wait or fix the cause. Do not raise volume somewhere else.</p>
        </div>
      ) : null}
    </Modal>
  );
}

export default WhyNotSendingDialog;
