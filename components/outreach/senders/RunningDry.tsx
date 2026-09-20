'use client';

import Link from 'next/link';
import { Hourglass } from 'lucide-react';
import { Badge } from '@/components/outreach/ui';
import { useRunningDryAlerts, useSenderSequences, type RunningDryAlert, type SenderV2 } from './insights';

function daysText(a: RunningDryAlert | undefined): string {
  const d = a?.detail?.days_left;
  if (d == null) return 'Less than 2 days of new leads left';
  const n = Number(d);
  if (n < 1) return 'Less than a day of new leads left';
  return `About ${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? '' : 's'} of new leads left`;
}

/** Compact badge for the senders list. */
export function RunningDryBadge({ alert }: { alert?: RunningDryAlert }) {
  const backlog = alert?.detail?.backlog;
  const title = `${daysText(alert)}${backlog != null ? ` (${backlog} lead${backlog === 1 ? '' : 's'} not contacted yet)` : ''}. Enrol more leads or add an auto-enrol rule.`;
  return <Badge tone="amber" className="gap-1 whitespace-nowrap"><Hourglass className="w-3 h-3" aria-hidden /><span title={title}>Running dry</span></Badge>;
}

/** Callout at the top of the sender page. Renders nothing unless the sender is running dry. */
export default function RunningDryCallout({ sender, canWrite }: { sender: SenderV2; canWrite: boolean }) {
  const alerts = useRunningDryAlerts(sender.workspace_id);
  const alert = alerts.data?.get(sender.id);
  const dry = !!sender.running_dry_at || !!alert;
  const sequences = useSenderSequences(sender.id, sender.workspace_id, dry);
  if (!dry) return null;

  const backlog = alert?.detail?.backlog;
  const perDay = alert?.detail?.per_day;
  const seqs = sequences.data ?? [];
  const ruleHref = seqs.length === 1 ? `/outreach/sequences/${seqs[0].id}` : '/outreach/sequences';

  return (
    <div role="status" className="mb-5 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <Hourglass className="w-5 h-5 text-amber-600 flex-shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-amber-900">{daysText(alert)}</div>
        <p className="text-sm text-amber-800 mt-0.5">
          {backlog != null ? `${backlog} lead${backlog === 1 ? ' has' : 's have'} not been contacted yet` : 'Few leads are waiting for a first step'}
          {perDay != null ? `, and this sender can start about ${perDay} a day.` : '.'} After that it only sends follow-ups.
        </p>
      </div>
      {canWrite && (
        <div className="flex flex-wrap gap-2">
          <Link href="/outreach/leads" className="inline-flex items-center rounded-lg bg-white border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100">Enrol more leads</Link>
          <Link href={ruleHref} className="inline-flex items-center rounded-lg bg-white border border-amber-300 px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100" title={seqs.length === 1 ? `Opens "${seqs[0].name}"` : 'Open a sequence, then add a rule that enrols matching leads every day'}>Add an auto-enrol rule</Link>
        </div>
      )}
    </div>
  );
}
