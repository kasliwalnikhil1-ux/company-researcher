'use client';

import React from 'react';
import Link from 'next/link';
import { Building2, ExternalLink } from 'lucide-react';
import { Button, EmptyState, Table, Td, Th } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtInt, fmtRate, totalsCsvColumns, useReportClients, type ClientRow, type DateRange } from '@/lib/outreach/reports';
import { CountRate, ExportButton, MetricLabel, Refreshing, RetryError, SortTh, TableSkeleton, useSort } from './primitives';

const ACCESSORS: Record<string, (r: ClientRow) => string | number | null> = {
  name: (r) => r.name.toLowerCase(), senders: (r) => r.senders, leads: (r) => r.leads, live: (r) => r.live, touches: (r) => r.totals.touches, acceptance_rate: (r) => r.totals.acceptance_rate,
  replies: (r) => r.totals.replies, interested: (r) => r.totals.interested, meetings: (r) => r.totals.meetings,
};

export default function ClientsTab({ ws, range, onFilterClient }: { ws: string; range: DateRange; onFilterClient: (clientId: string) => void }) {
  const q = useReportClients({ ws, range });
  const { sorted, sort, toggle } = useSort(q.data, { key: 'name', dir: 'asc' }, ACCESSORS);

  if (q.isLoading) return <TableSkeleton cols={8} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<Building2 className="w-6 h-6" />} title="No clients yet" description="Clients are optional. Create one per customer to get a report and a portal for each." action={<Link href="/outreach/clients"><Button size="sm">Manage clients</Button></Link>} /></div>;

  const exportCsv = () => downloadCsv<ClientRow>(csvFileName('clients', range), [
    { header: 'Client', value: (r) => r.name }, { header: 'Senders', value: (r) => r.senders }, { header: 'Leads', value: (r) => r.leads }, { header: 'Leads in progress', value: (r) => r.live }, ...totalsCsvColumns<ClientRow>((r) => r.totals),
  ], sorted);

  const th = { sort, onSort: toggle };
  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-gray-500">The portal shows a client the same numbers, with your branding. “Filter reports” narrows every tab on this page to one client.</p>
        <ExportButton onClick={exportCsv} />
      </div>
      <div className="[&_td]:px-3 [&_th]:px-3"><Table>
        <thead><tr>
          <SortTh label="Client" sortKey="name" align="left" firstDir="asc" {...th} /><SortTh label="Senders" sortKey="senders" {...th} /><SortTh label="Leads" sortKey="leads" {...th} /><SortTh label="In progress" sortKey="live" {...th} />
          <SortTh label="Touches" sortKey="touches" metric="touches" {...th} /><SortTh label="Acceptance" sortKey="acceptance_rate" metric="acceptance_rate" {...th} /><SortTh label="Replies" sortKey="replies" metric="replies" {...th} />
          <SortTh label="Interested" sortKey="interested" metric="interested" {...th} /><SortTh label="Meetings" sortKey="meetings" metric="meetings" {...th} /><Th />
        </tr></thead>
        <tbody>{sorted.map((r) => {
          const t = r.totals;
          return (
            <tr key={r.client_id} className="hover:bg-gray-50">
              <Td><Link href={`/outreach/c/${r.client_id}`} className="font-medium text-gray-900 hover:underline">{r.name}</Link></Td>
              <Td className="text-right tabular-nums">{fmtInt(r.senders)}</Td><Td className="text-right tabular-nums">{fmtInt(r.leads)}</Td><Td className="text-right tabular-nums">{fmtInt(r.live)}</Td>
              <Td className="text-right tabular-nums">{fmtInt(t.touches)}</Td>
              <Td className="text-right"><CountRate count={fmtInt(t.accepted)} rate={fmtRate(t.acceptance_rate)} /></Td>
              <Td className="text-right"><CountRate count={fmtInt(t.replies)} rate={fmtRate(t.reply_rate)} /></Td>
              <Td className="text-right"><CountRate count={fmtInt(t.interested)} rate={fmtRate(t.positive_reply_rate)} /></Td>
              <Td className="text-right tabular-nums">{fmtInt(t.meetings)}</Td>
              <Td><div className="flex justify-end gap-1 whitespace-nowrap">
                <Button size="sm" variant="ghost" onClick={() => onFilterClient(r.client_id)}>Filter reports</Button>
                <Link href={`/outreach/c/${r.client_id}`}><Button size="sm" variant="ghost"><ExternalLink className="w-3.5 h-3.5" /> Portal</Button></Link>
              </div></Td>
            </tr>
          );
        })}</tbody>
      </Table></div>
      <p className="text-xs text-gray-400 mt-2">Under each count: <MetricLabel metric="acceptance_rate">acceptance rate</MetricLabel>, <MetricLabel metric="reply_rate">reply rate</MetricLabel> and <MetricLabel metric="positive_reply_rate">positive reply rate</MetricLabel>.</p>
    </Refreshing>
  );
}
