'use client';

import React, { useMemo, useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { EmptyState, Table, Td, Th } from '@/components/outreach/ui';
import { countChange, csvFileName, downloadCsv, fmtDay, fmtInt, fmtRate, rateChange, useReportOverview, type DateRange, type OverviewReport, type SeriesPoint, type Totals } from '@/lib/outreach/reports';
import { ChartSkeleton, ExportButton, KpiTile, MetricLabel, Refreshing, RetryError, Section, TilesSkeleton } from './primitives';
import { SERIES, SeriesToggles, TimeSeriesChart, type SeriesKey } from './charts';

export interface TabProps { ws: string; client: string | null; range: DateRange }

export function hasActivity(t: Totals): boolean {
  return t.enrolled + t.invites + t.touches + t.accepted + t.replies + t.meetings + t.profile_views > 0;
}

/** Headline tiles: shared by the Overview tab and the client portal. */
export function HeadlineTiles({ report }: { report: OverviewReport }) {
  const t = report.totals; const p = report.previous;
  const versus = `vs ${fmtDay(report.period.previous_from)} – ${fmtDay(report.period.previous_to)}`;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      <KpiTile label="Sent touches" metric="touches" value={fmtInt(t.touches)} sub={`${fmtInt(t.invites)} invites sent`} change={countChange(t.touches, p.touches)} versus={versus} />
      <KpiTile label="Accepted" metric="accepted" value={fmtInt(t.accepted)} sub={<><MetricLabel metric="acceptance_rate">Acceptance rate</MetricLabel> {fmtRate(t.acceptance_rate)}</>} change={rateChange(t.acceptance_rate, p.acceptance_rate)} versus={versus} />
      <KpiTile label="Replies" metric="replies" value={fmtInt(t.replies)} sub={<><MetricLabel metric="reply_rate">Reply rate</MetricLabel> {fmtRate(t.reply_rate)}</>} change={rateChange(t.reply_rate, p.reply_rate)} versus={versus} />
      <KpiTile label="Interested" metric="interested" value={fmtInt(t.interested)} sub={<><MetricLabel metric="positive_reply_rate">Positive reply rate</MetricLabel> {fmtRate(t.positive_reply_rate)}</>} change={rateChange(t.positive_reply_rate, p.positive_reply_rate)} versus={versus} />
      <KpiTile label="Meetings" metric="meetings" value={fmtInt(t.meetings)} sub={`${fmtInt(t.won)} won`} change={countChange(t.meetings, p.meetings)} versus={versus} />
    </div>
  );
}

const DAILY_COLUMNS: Array<{ key: keyof Totals; label: string; rate?: boolean }> = [
  { key: 'invites', label: 'Invites' }, { key: 'accepted', label: 'Accepted' }, { key: 'messages', label: 'Messages' }, { key: 'emails', label: 'Emails' },
  { key: 'touches', label: 'Touches' }, { key: 'replies', label: 'Replies' }, { key: 'reply_rate', label: 'Reply rate', rate: true }, { key: 'interested', label: 'Interested' }, { key: 'meetings', label: 'Meetings' },
];

/** Time series with series toggles and the same numbers as a table. Shared with the client portal. */
export function ActivityOverTime({ report, fileName }: { report: OverviewReport; fileName: string }) {
  const hasEmail = (report.totals.emails ?? 0) > 0;
  const series = useMemo(() => SERIES.filter((s) => s.key !== 'emails' || hasEmail), [hasEmail]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showTable, setShowTable] = useState(false);
  const toggle = (k: SeriesKey) => setHidden((h) => { const n = new Set(h); if (n.has(k)) n.delete(k); else if (n.size < series.length - 1) n.add(k); return n; });
  const cols = DAILY_COLUMNS.filter((c) => c.key !== 'emails' || hasEmail);
  const exportCsv = () => downloadCsv<SeriesPoint>(fileName, [{ header: 'Day', value: (r) => r.day }, ...cols.map((c) => ({ header: c.rate ? `${c.label} %` : c.label, value: (r: SeriesPoint) => r[c.key] as number | null }))], report.series);
  return (
    <Section title="Activity over time" description={`One point per day, ${report.period.timezone} time.`}
      actions={<><button type="button" className="text-xs text-gray-600 hover:text-gray-900 underline underline-offset-2" onClick={() => setShowTable((v) => !v)}>{showTable ? 'Hide daily table' : 'Show daily table'}</button><ExportButton onClick={exportCsv} /></>}>
      <div className="mb-3"><SeriesToggles series={series} hidden={hidden} onToggle={toggle} /></div>
      <TimeSeriesChart data={report.series} series={series} hidden={hidden} />
      {showTable && (
        <Table className="mt-4 max-h-80 overflow-y-auto">
          <thead><tr><Th>Day</Th>{cols.map((c) => <Th key={c.key} className="text-right">{c.label}</Th>)}</tr></thead>
          <tbody>{report.series.map((r) => (
            <tr key={r.day}><Td className="whitespace-nowrap">{fmtDay(r.day, true)}</Td>{cols.map((c) => <Td key={c.key} className="text-right tabular-nums">{c.rate ? fmtRate(r[c.key] as number | null) : fmtInt(r[c.key] as number)}</Td>)}</tr>
          ))}</tbody>
        </Table>
      )}
    </Section>
  );
}

const CHANNELS: Array<{ key: 'linkedin' | 'email'; label: string }> = [{ key: 'linkedin', label: 'LinkedIn' }, { key: 'email', label: 'Email' }];

export default function OverviewTab({ ws, client, range }: TabProps) {
  const q = useReportOverview({ ws, client, range });
  if (q.isLoading) return <div className="space-y-6"><TilesSkeleton /><ChartSkeleton /></div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;

  const channelRows = CHANNELS.map((c) => ({ ...c, totals: r.by_channel[c.key] })).filter((c) => !!c.totals) as Array<{ key: string; label: string; totals: Totals }>;
  const exportChannels = () => downloadCsv(csvFileName('overview', range, 'by-channel'), [
    { header: 'Channel', value: (x) => x.label }, { header: 'Touches', value: (x) => x.totals.touches }, { header: 'Invites', value: (x) => x.totals.invites }, { header: 'Accepted', value: (x) => x.totals.accepted },
    { header: 'Acceptance rate %', value: (x) => x.totals.acceptance_rate }, { header: 'Replies', value: (x) => x.totals.replies }, { header: 'Reply rate %', value: (x) => x.totals.reply_rate },
    { header: 'Interested', value: (x) => x.totals.interested }, { header: 'Positive reply rate %', value: (x) => x.totals.positive_reply_rate }, { header: 'Meetings', value: (x) => x.totals.meetings },
  ], channelRows);

  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="space-y-6">
        <HeadlineTiles report={r} />
        {!hasActivity(r.totals) ? (
          <Section title="Activity over time"><EmptyState icon={<BarChart3 className="w-6 h-6" />} title="Nothing was sent in this period" description="Pick a longer range, or check that a sequence is active and has leads. The dashboard shows what is blocking a sequence." /></Section>
        ) : <ActivityOverTime report={r} fileName={csvFileName('overview', range, 'daily')} />}

        <Section title="By channel" description="LinkedIn covers invitations, messages and InMails. Email covers the email steps." actions={<ExportButton onClick={exportChannels} disabled={!channelRows.length} />}>
          {!channelRows.length ? <p className="text-sm text-gray-500">No channel has activity in this period.</p> : (
            <Table>
              <thead><tr>
                <Th>Channel</Th><Th className="text-right"><MetricLabel metric="touches">Touches</MetricLabel></Th><Th className="text-right"><MetricLabel metric="invites">Invites</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="accepted">Accepted</MetricLabel></Th><Th className="text-right"><MetricLabel metric="acceptance_rate">Acceptance rate</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="replies">Replies</MetricLabel></Th><Th className="text-right"><MetricLabel metric="reply_rate">Reply rate</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="interested">Interested</MetricLabel></Th><Th className="text-right"><MetricLabel metric="positive_reply_rate">Positive reply rate</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="meetings">Meetings</MetricLabel></Th>
              </tr></thead>
              <tbody>{channelRows.map((c) => (
                <tr key={c.key}>
                  <Td className="font-medium text-gray-900">{c.label}</Td><Td className="text-right tabular-nums">{fmtInt(c.totals.touches)}</Td><Td className="text-right tabular-nums">{fmtInt(c.totals.invites)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(c.totals.accepted)}</Td><Td className="text-right tabular-nums">{fmtRate(c.totals.acceptance_rate)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(c.totals.replies)}</Td><Td className="text-right tabular-nums">{fmtRate(c.totals.reply_rate)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(c.totals.interested)}</Td><Td className="text-right tabular-nums">{fmtRate(c.totals.positive_reply_rate)}</Td>
                  <Td className="text-right tabular-nums">{fmtInt(c.totals.meetings)}</Td>
                </tr>
              ))}</tbody>
            </Table>
          )}
        </Section>
      </div>
    </Refreshing>
  );
}
