'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Contact } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, HealthBar, StatusPill, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtDay, fmtInt, fmtRate, totalsCsvColumns, useReportSender, useReportSenders, type DateRange, type SenderReport, type SenderRow } from '@/lib/outreach/reports';
import { CountRate, DetailRow, ExportButton, MetricLabel, Refreshing, RetryError, Skeleton, SortTh, TableSkeleton, useElementWidth, useSort } from './primitives';
import { MiniBar, SERIES, Sparkline } from './charts';
import type { TabProps } from './OverviewTab';

const PROVIDERS: Record<string, string> = { LINKEDIN: 'LinkedIn', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'Email (IMAP)' };
const color = (key: string) => SERIES.find((s) => s.key === key)?.color ?? '#4f46e5';
const future = (v: string | null) => !!v && new Date(v).getTime() > Date.now();

function restrictionText(e: SenderReport['restrictions'][number]): string {
  const d = e.data as Record<string, string | undefined>;
  if (e.kind === 'checkpoint') return 'LinkedIn asked for verification';
  if (e.kind === 'reject') return d.decision === 'sender_cap_hit' || d.limit_hit ? 'LinkedIn’s own limit was hit' : `LinkedIn refused an action${d.error_code ? ` (${String(d.error_code).replace(/_/g, ' ').toLowerCase()})` : ''}`;
  if (d.paused_until) return `Rested until ${fmtDate(d.paused_until)}`;
  if (d.to === 'credentials') return 'Disconnected: login needed';
  if (d.to === 'error') return 'Provider error';
  if (d.to === 'paused') return 'Paused';
  return 'Status changed';
}

function SenderDetail({ row, range }: { row: SenderRow; range: DateRange }) {
  const q = useReportSender(row.sender_id, range);
  if (q.isLoading) return <div className="grid grid-cols-3 gap-4 py-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20" />)}</div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const trend = r.health_trend.filter((h) => h.score !== null).map((h) => ({ day: h.at.slice(0, 10), score: h.score as number }));
  const failures = Object.entries(r.failures_by_reason).sort((a, b) => b[1] - a[1]); const maxFail = Math.max(0, ...failures.map(([, n]) => n));
  const sparks: Array<{ key: 'invites' | 'accepted' | 'replies'; label: string; value: string }> = [
    { key: 'invites', label: 'Invites per day', value: fmtInt(r.totals.invites) }, { key: 'accepted', label: 'Accepted per day', value: fmtInt(r.totals.accepted) }, { key: 'replies', label: 'Replies per day', value: fmtInt(r.totals.replies) },
  ];
  const exportDaily = () => downloadCsv(csvFileName('senders', range, `${row.name ?? 'sender'}-daily`), [
    { header: 'Day', value: (p) => p.day }, { header: 'Invites', value: (p) => p.invites }, { header: 'Accepted', value: (p) => p.accepted }, { header: 'Touches', value: (p) => p.touches },
    { header: 'Replies', value: (p) => p.replies }, { header: 'Interested', value: (p) => p.interested }, { header: 'Failed', value: (p) => p.failed }, { header: 'LinkedIn limit hits', value: (p) => p.limit_hits },
  ], r.series);

  return (
    <div className="space-y-5 py-1">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs text-gray-500">Days with no activity are left out of the trend lines.</div>
        <div className="flex items-center gap-2"><ExportButton onClick={exportDaily} disabled={!r.series.length} /><Link href={`/outreach/senders/${row.sender_id}`}><Button size="sm" variant="ghost">Open sender</Button></Link></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        {sparks.map((s) => (
          <div key={s.key} className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
            <div className="flex items-baseline justify-between"><span className="text-xs text-gray-500">{s.label}</span><span className="text-sm font-semibold text-gray-900 tabular-nums">{s.value}</span></div>
            <Sparkline data={r.series} dataKey={s.key} label={s.label.replace(' per day', '')} color={color(s.key)} />
          </div>
        ))}
        <div className="rounded-lg border border-gray-200 bg-white px-3 py-2.5">
          <div className="flex items-baseline justify-between"><span className="text-xs text-gray-500">Health score</span><span className="text-sm font-semibold text-gray-900 tabular-nums">{fmtInt(r.sender.health)}</span></div>
          {trend.length >= 2 ? <Sparkline data={trend} dataKey="score" label="Health" color="#4f46e5" /> : <div className="text-xs text-gray-400 h-11 flex items-center">Health did not change in this period</div>}
        </div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Restrictions in this period</h4>
          {!r.restrictions.length ? <p className="text-sm text-gray-500">None. LinkedIn did not refuse or limit this sender.</p> : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg bg-white max-h-56 overflow-y-auto">{r.restrictions.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex items-center justify-between gap-3 px-3 py-2 text-sm"><span className="text-gray-700">{restrictionText(e)}</span><span className="text-xs text-gray-400 whitespace-nowrap">{fmtDate(e.at)}</span></li>
            ))}</ul>
          )}
        </div>
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Failed actions by reason</h4>
          {!failures.length ? <p className="text-sm text-gray-500">No action failed in this period.</p> : (
            <ul className="space-y-1.5">{failures.map(([reason, n]) => (
              <li key={reason} className="grid grid-cols-[minmax(0,1fr)_120px_40px] items-center gap-3 text-sm"><span className="text-gray-700 truncate" title={reason}>{reason}</span><MiniBar value={n} max={maxFail} /><span className="text-right tabular-nums text-gray-900">{fmtInt(n)}</span></li>
            ))}</ul>
          )}
        </div>
      </div>
    </div>
  );
}

const ACCESSORS: Record<string, (r: SenderRow) => string | number | null> = {
  name: (r) => (r.name ?? '').toLowerCase(), health: (r) => r.health, level: (r) => r.level, invites: (r) => r.totals.invites, acceptance_rate: (r) => r.totals.acceptance_rate, touches: (r) => r.totals.touches,
  replies: (r) => r.totals.replies, reply_rate: (r) => r.totals.reply_rate, interested: (r) => r.totals.interested, limit_hits: (r) => r.totals.limit_hits,
};

export default function SendersTab({ ws, client, range }: TabProps) {
  const q = useReportSenders({ ws, client, range });
  const { sorted, sort, toggle } = useSort(q.data, { key: 'replies', dir: 'desc' }, ACCESSORS);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const box = useElementWidth<HTMLDivElement>();
  const flip = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (q.isLoading) return <TableSkeleton cols={9} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<Contact className="w-6 h-6" />} title="No senders to report on" description={client ? 'This client has no senders yet. Clear the client filter to see every sender.' : 'Connect a LinkedIn account or a mailbox. Its numbers show up here once it sends.'} /></div>;

  const exportCsv = () => downloadCsv<SenderRow>(csvFileName('senders', range), [
    { header: 'Sender', value: (r) => r.name }, { header: 'Provider', value: (r) => PROVIDERS[r.provider] ?? r.provider }, { header: 'Status', value: (r) => r.status }, { header: 'Health', value: (r) => r.health }, { header: 'Warm-up level', value: (r) => r.level },
    ...totalsCsvColumns<SenderRow>((r) => r.totals), { header: 'LinkedIn limit hits', value: (r) => r.totals.limit_hits }, { header: 'Failed actions', value: (r) => r.totals.failed },
    { header: 'Resting until', value: (r) => (future(r.paused_until) ? r.paused_until : '') }, { header: 'Invitations blocked until', value: (r) => (future(r.invite_blocked_until) ? r.invite_blocked_until : '') }, { header: 'Running dry', value: (r) => (r.running_dry ? 'yes' : 'no') },
  ], sorted);

  const th = { sort, onSort: toggle };
  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-gray-500">Sorted by replies, so the accounts that carry the results come first. Open a row for the daily trend.</p>
        <ExportButton onClick={exportCsv} />
      </div>
      <div ref={box.ref} className="[&_td]:px-3 [&_th]:px-3"><Table>
        <thead><tr>
          <Th className="w-8" /><SortTh label="Sender" sortKey="name" align="left" firstDir="asc" {...th} /><SortTh label="Health" sortKey="health" align="left" {...th} />
          <SortTh label="Invites" sortKey="invites" metric="invites" {...th} /><SortTh label="Acceptance" sortKey="acceptance_rate" metric="acceptance_rate" {...th} /><SortTh label="Touches" sortKey="touches" metric="touches" {...th} />
          <SortTh label="Replies" sortKey="replies" metric="replies" {...th} /><SortTh label="Interested" sortKey="interested" metric="interested" {...th} /><SortTh label="Restrictions" sortKey="limit_hits" align="left" {...th} />
        </tr></thead>
        <tbody>{sorted.map((r) => {
          const isOpen = open.has(r.sender_id); const t = r.totals; const name = r.name ?? 'Unnamed sender';
          return (
            <React.Fragment key={r.sender_id}>
              <tr className={cn('hover:bg-gray-50', isOpen && 'bg-gray-50')}>
                <Td className="pr-0"><button type="button" onClick={() => flip(r.sender_id)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the trend for ${name}`} className="p-1 rounded hover:bg-gray-200 text-gray-500">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                <Td className="min-w-[200px]">
                  <div className="flex items-center gap-2 flex-wrap"><button type="button" onClick={() => flip(r.sender_id)} className="font-medium text-gray-900 hover:underline text-left">{name}</button><StatusPill status={r.status} /></div>
                  <div className="text-xs text-gray-500">{PROVIDERS[r.provider] ?? r.provider}</div>
                </Td>
                <Td><HealthBar score={r.health} /><div className="text-xs text-gray-500 mt-0.5">Warm-up level {fmtInt(r.level)}</div></Td>
                <Td className="text-right tabular-nums">{fmtInt(t.invites)}</Td>
                <Td className="text-right"><CountRate count={fmtInt(t.accepted)} rate={fmtRate(t.acceptance_rate)} /></Td>
                <Td className="text-right tabular-nums">{fmtInt(t.touches)}</Td>
                <Td className="text-right"><CountRate count={fmtInt(t.replies)} rate={fmtRate(t.reply_rate)} /></Td>
                <Td className="text-right"><CountRate count={fmtInt(t.interested)} rate={fmtRate(t.positive_reply_rate)} /></Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {future(r.paused_until) && <Badge tone="amber">Resting until {fmtDay(r.paused_until!.slice(0, 10))}</Badge>}
                    {future(r.invite_blocked_until) && <Badge tone="red">Invitations blocked until {fmtDay(r.invite_blocked_until!.slice(0, 10))}</Badge>}
                    {t.limit_hits > 0 && <Badge tone="amber">{fmtInt(t.limit_hits)} LinkedIn limit {t.limit_hits === 1 ? 'hit' : 'hits'}</Badge>}
                    {r.running_dry && <Badge tone="amber">Running out of leads</Badge>}
                    {!future(r.paused_until) && !future(r.invite_blocked_until) && !r.running_dry && !t.limit_hits && <span className="text-xs text-gray-400">None</span>}
                  </div>
                </Td>
              </tr>
              {isOpen && <DetailRow colSpan={9} width={box.width}><SenderDetail row={r} range={range} /></DetailRow>}
            </React.Fragment>
          );
        })}</tbody>
      </Table></div>
      <p className="text-xs text-gray-400 mt-2">Under each count: <MetricLabel metric="acceptance_rate">acceptance rate</MetricLabel>, <MetricLabel metric="reply_rate">reply rate</MetricLabel> and <MetricLabel metric="positive_reply_rate">positive reply rate</MetricLabel>.</p>
    </Refreshing>
  );
}
