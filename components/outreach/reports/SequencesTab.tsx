'use client';

// Reports → Sequences: one row per sequence with the people-level results of sequence-stats-PRD.md (Contacted ·
// Accepted · Replied · Positive · Meetings), the same numbers as the Sequences list and the sequence page. A row opens
// to the header funnel, the per-channel blocks and the step / A/B / exit tables.
import React, { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { AlertTriangle, ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, Table, Td, Th } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtInt, useReportSequence, useReportSequences, type DateRange, type SequenceRow } from '@/lib/outreach/reports';
import { useSequence } from '@/lib/outreach/queries';
import { acceptedTip, contactedTip, positiveTip, rateSortValue, repliedTip, type StatsChannel } from '@/lib/outreach/sequenceStats';
import type { AnalyticsStep } from '@/lib/outreach/sequenceLeads';
import { useSequenceAnalytics } from '@/components/outreach/sequences/hooks';
import { ChannelGlyphs } from '@/components/outreach/sequences/stats/ChannelGlyphs';
import { MetricCell } from '@/components/outreach/sequences/stats/MetricCell';
import FunnelTiles from '@/components/outreach/sequences/stats/FunnelTiles';
import ChannelBlocks from '@/components/outreach/sequences/stats/ChannelBlocks';
import { ActivityByDayCard, StepTable } from '@/components/outreach/sequences/stats/SequenceAnalytics';
import SequenceStepTables from './SequenceStepTables';
import { DetailRow, ExportButton, MetricLabel, Refreshing, RetryError, Skeleton, SortTh, TableSkeleton, useElementWidth, useSort } from './primitives';
import type { TabProps } from './OverviewTab';

const STATUS_TONE: Record<string, 'green' | 'amber' | 'gray' | 'blue'> = { active: 'green', paused: 'amber', draft: 'gray', archived: 'gray' };
const words = (s: string) => s.replace(/_/g, ' ');

function SequenceDetail({ row, range, canPromote }: { row: SequenceRow; range: DateRange; canPromote: boolean }) {
  const q = useReportSequence(row.sequence_id, range);
  const seq = useSequence(row.sequence_id);
  // the sequence page's Analytics tab, same window: its Steps table (with the copy each step sends) and Activity by day (with the leads behind each day)
  const an = useSequenceAnalytics(row.sequence_id, range);
  if (q.isLoading) return <div className="space-y-2 py-2"><Skeleton className="h-4 w-56" /><Skeleton className="h-24 w-full" /></div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const graph = seq.data?.graph;
  const exportSteps = () => downloadCsv<AnalyticsStep>(csvFileName('sequences', range, `${row.name}-steps`), [
    { header: 'Step', value: (s) => (s.step_number ? `${s.step_number}. ` : '') + s.label }, { header: 'Type', value: (s) => words(s.type) }, { header: 'Sent', value: (s) => s.sent },
    { header: 'Accepted', value: (s) => s.accepted }, { header: 'Accepted rate %', value: (s) => s.accepted_rate }, { header: 'Read', value: (s) => s.read }, { header: 'Read rate %', value: (s) => s.read_rate },
    { header: 'Replied', value: (s) => s.replied }, { header: 'Replied rate %', value: (s) => s.replied_rate }, { header: 'Skipped', value: (s) => s.skipped }, { header: 'Failed', value: (s) => s.failed }, { header: 'Leads here now', value: (s) => s.leads_here },
  ], an.data?.steps ?? []);
  const analytics = (render: (a: NonNullable<typeof an.data>) => React.ReactNode) =>
    an.isLoading && !an.data ? <Skeleton className="h-24 w-full" /> : an.isError ? <RetryError error={an.error} onRetry={() => an.refetch()} /> : an.data ? render(an.data) : null;
  return (
    <div className="space-y-5 py-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">{fmtInt(r.live)} leads in progress · version {r.sequence.head_version}</div>
        <Link href={`/outreach/sequences/${row.sequence_id}?tab=analytics`}><Button size="sm" variant="ghost">Open sequence</Button></Link>
      </div>
      <FunnelTiles f={r.funnel} draft={row.status === 'draft'} other={r.replied_other_channel} />
      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Steps</h4>
            <p className="text-xs text-gray-500 mt-0.5">Each sending step in the period. Click a step to see what it sends. Accepted is for invitations and follows; read receipts for messages.</p>
          </div>
          <ExportButton onClick={exportSteps} disabled={!an.data?.steps.length} />
        </div>
        {analytics((a) => <StepTable steps={a.steps} graph={graph} />)}
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Activity by day</h4>
        <p className="text-xs text-gray-500 mt-0.5 mb-2">Each day&apos;s bar stacks what went out and what came back that day. The grey bar behind is what the engine had planned. Click a day to see the people behind it.</p>
        {analytics((a) => <ActivityByDayCard sequenceId={row.sequence_id} d={a.daily} graph={graph} />)}
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">By channel</h4>
        <ChannelBlocks channels={r.channels} seenSince={r.seen_since} seenPartial={r.seen_partial} />
      </div>
      <SequenceStepTables r={r} graph={graph} sequenceId={row.sequence_id} sequenceName={row.name} range={range} canPromote={canPromote} only="extras" />
    </div>
  );
}

const ACCESSORS: Record<string, (r: SequenceRow) => string | number | null> = {
  name: (r) => r.name.toLowerCase(), enrolled: (r) => r.progress.enrolled, contacted: (r) => r.contacted,
  accepted: (r) => r.accepted, accepted_rate: (r) => rateSortValue(r.accepted_rate, r.invited, 'desc'),
  replied: (r) => r.replied, replied_rate: (r) => rateSortValue(r.replied_rate, r.contacted, 'desc'),
  positive: (r) => r.positive, positive_rate: (r) => rateSortValue(r.positive_rate, r.replied, 'desc'),
  meetings: (r) => r.meetings, failed_leads: (r) => r.ops.failed_leads,
};

export default function SequencesTab({ ws, client, range, canPromote }: TabProps & { canPromote: boolean }) {
  const [channel, setChannel] = useState<StatsChannel | null>(null);
  const q = useReportSequences({ ws, client, range, channel });
  const { sorted, sort, toggle } = useSort(q.data, { key: 'replied', dir: 'desc' }, ACCESSORS);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const box = useElementWidth<HTMLDivElement>();
  const flip = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (q.isLoading) return <TableSkeleton cols={9} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length && !channel) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<GitBranch className="w-6 h-6" />} title="No sequences to report on" description={client ? 'This client has no sequences yet. Clear the client filter to see every sequence.' : 'Build and activate a sequence. Its numbers show up here as soon as it sends.'} /></div>;

  const exportCsv = () => downloadCsv<SequenceRow>(csvFileName('sequences', range), [
    { header: 'Sequence', value: (r) => r.name }, { header: 'Status', value: (r) => r.status }, { header: 'Channels', value: (r) => r.channels.map((c) => c.channel).join(' ') }, { header: 'Stalled reason', value: (r) => r.stalled_reason },
    { header: 'Enrolled', value: (r) => r.progress.enrolled }, { header: 'Live', value: (r) => r.progress.live }, { header: 'Contacted', value: (r) => r.contacted },
    { header: 'Invited', value: (r) => r.invited }, { header: 'Accepted', value: (r) => r.accepted }, { header: 'Accepted rate %', value: (r) => (r.na.accepted ? null : r.accepted_rate) }, { header: 'Pending', value: (r) => r.pending },
    { header: 'Replied', value: (r) => r.replied }, { header: 'Replied rate %', value: (r) => r.replied_rate }, { header: 'Auto-replied', value: (r) => r.auto_replied },
    { header: 'Positive', value: (r) => r.positive }, { header: 'Positive rate %', value: (r) => r.positive_rate }, { header: 'Meetings', value: (r) => r.meetings }, { header: 'Failed leads', value: (r) => r.ops.failed_leads },
  ], sorted);

  const chip = (active: boolean) => cn('px-2.5 py-1 text-xs font-medium rounded-full border transition-colors', active ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50');
  const th = { sort, onSort: toggle };
  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <p className="text-xs text-gray-500">Leads, counted once: leads first contacted in the period and what they did after. Open a row for the channel funnels, step drop-off, A/B results and exit reasons.</p>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center gap-1" role="group" aria-label="Channel">
            <button type="button" aria-pressed={channel === null} onClick={() => setChannel(null)} className={chip(channel === null)}>All channels</button>
            {(['linkedin', 'instagram', 'whatsapp', 'email'] as StatsChannel[]).map((c) => (
              <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(channel === c ? null : c)} className={chip(channel === c)}>{c === 'linkedin' ? 'LinkedIn' : c === 'instagram' ? 'Instagram' : c === 'whatsapp' ? 'WhatsApp' : 'Email'}</button>
            ))}
          </div>
          <ExportButton onClick={exportCsv} />
        </div>
      </div>
      <div ref={box.ref} className="[&_td]:px-3 [&_th]:px-3"><Table>
        <thead><tr>
          <Th className="w-8" /><SortTh label="Sequence" sortKey="name" align="left" firstDir="asc" {...th} /><SortTh label="Enrolled" sortKey="enrolled" metric="progress" {...th} />
          <SortTh label="Contacted" sortKey="contacted" metric="contacted" {...th} /><SortTh label="Accepted" sortKey="accepted" metric="accepted" {...th} /><SortTh label="Replied" sortKey="replied" metric="replied" {...th} />
          <SortTh label="Positive" sortKey="positive" metric="positive" {...th} /><SortTh label="Meetings" sortKey="meetings" metric="meetings" {...th} /><SortTh label="Failed leads" sortKey="failed_leads" {...th} />
        </tr></thead>
        <tbody>{sorted.map((r) => {
          const isOpen = open.has(r.sequence_id); const draft = r.status === 'draft';
          return (
            <React.Fragment key={r.sequence_id}>
              <tr className={cn('hover:bg-gray-50', isOpen && 'bg-gray-50')}>
                <Td className="pr-0"><button type="button" onClick={() => flip(r.sequence_id)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${r.name}`} className="p-1 rounded hover:bg-gray-200 text-gray-500">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                <Td className="min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" onClick={() => flip(r.sequence_id)} className="font-medium text-gray-900 hover:underline text-left">{r.name}</button>
                    <ChannelGlyphs channels={r.channels} />
                    <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{words(r.status)}</Badge>
                    {r.has_ab_test && <Badge tone="indigo">A/B</Badge>}
                    {r.stalled && <Badge tone="red"><AlertTriangle className="w-3 h-3 mr-1" />Stalled</Badge>}
                  </div>
                  {r.stalled && <div className="text-xs text-red-700 mt-1 max-w-md">{r.stalled_reason ?? 'Nothing has been sent for a day.'} <Link href={`/outreach/sequences/${r.sequence_id}?why=1`} className="underline">Why isn’t this sending?</Link></div>}
                </Td>
                <Td className="text-right"><span className="inline-flex flex-col items-end leading-tight"><span className="tabular-nums text-gray-900">{fmtInt(r.progress.enrolled)}</span><span className="text-xs text-gray-500 whitespace-nowrap">{fmtInt(r.progress.live)} live</span></span></Td>
                <Td className="text-right"><MetricCell count={r.contacted} draft={draft} tip={contactedTip(r)} /></Td>
                <Td className="text-right"><MetricCell count={r.accepted} rate={r.accepted_rate} denominator={r.invited} pending={r.pending} early={r.accepted_early} na={r.na.accepted} draft={draft} tip={acceptedTip(r)} /></Td>
                <Td className="text-right"><MetricCell count={r.replied} rate={r.replied_rate} denominator={r.contacted} draft={draft} tip={repliedTip(r)} /></Td>
                <Td className="text-right"><MetricCell count={r.positive} rate={r.positive_rate} denominator={r.replied} draft={draft} tip={positiveTip(r)} /></Td>
                <Td className="text-right tabular-nums">{draft ? <span className="text-gray-300">—</span> : fmtInt(r.meetings)}</Td>
                <Td className="text-right tabular-nums">{r.ops.failed_leads > 0 ? <Link href={`/outreach/sequences/${r.sequence_id}?failed=1`} className="underline decoration-gray-300 underline-offset-4">{fmtInt(r.ops.failed_leads)}</Link> : <span className="text-gray-300">0</span>}</Td>
              </tr>
              {isOpen && <DetailRow colSpan={9} width={box.width}><SequenceDetail row={r} range={range} canPromote={canPromote} /></DetailRow>}
            </React.Fragment>
          );
        })}</tbody>
      </Table></div>
      {!sorted.length && channel && <p className="text-sm text-gray-500 mt-3">No sequence uses that channel.</p>}
      <p className="text-xs text-gray-400 mt-2">The percent next to each count is its rate: <MetricLabel metric="accepted">accepted ÷ invited</MetricLabel> (with the number still pending underneath), <MetricLabel metric="replied">replied ÷ contacted</MetricLabel> and <MetricLabel metric="positive">positive ÷ replied</MetricLabel>. A dotted underline means the rate rests on fewer than 20 people.</p>
    </Refreshing>
  );
}
