'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import Link from '@/lib/outreach/nav';
import { rpc } from '@/lib/outreach/api';
import { Card, timeAgo } from '@/components/outreach/ui';
import { STATUS_DOT, STATUS_LABELS, type HealthOverview } from '@/lib/outreach/health';
import { cn } from '@/lib/utils';

/** The Health item in the platform-admin tool, with a coloured dot showing the current verdict (health-page-PRD.md §3.1). */
export default function HealthEntryCard() {
  const q = useQuery({ queryKey: ['health-overview'], queryFn: () => rpc<HealthOverview>('health_overview'), refetchInterval: 60_000, retry: false });
  const o = q.data;
  const verdict = o?.stale ? 'act' : o?.verdict ?? 'unknown';
  return (
    <Card title={<span className="inline-flex items-center gap-2"><span className={cn('inline-block w-2.5 h-2.5 rounded-full', STATUS_DOT[verdict])} title={STATUS_LABELS[verdict]} />Health</span>}>
      <p className="text-sm text-gray-600">
        {q.isError ? 'Could not read the checks.' : !o ? 'Reading the checks…' : o.stale ? 'The checks have stopped running.' : `${o.counts.act} needs action · ${o.counts.watch} to watch · ${o.counts.ok} fine · ${o.counts.unknown} couldn't check`}
        {o?.last_run_at && <span className="text-gray-400"> · checked {timeAgo(o.last_run_at)}</span>}
      </p>
      <Link href="/outreach/settings/admin/health" className="inline-flex items-center gap-1 mt-3 text-sm text-indigo-600 hover:underline">Open Health <ArrowUpRight className="w-3.5 h-3.5" /></Link>
    </Card>
  );
}
