'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronDown, ChevronRight, FlaskConical, GitBranch, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, Button, EmptyState, Modal, Table, Td, Th } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import {
  csvFileName, downloadCsv, fmtInt, fmtRate, totalsCsvColumns, usePromoteVariant, useReportSequence, useReportSequences,
  type AbTest, type AbVariant, type DateRange, type SequenceRow, type StepRow,
} from '@/lib/outreach/reports';
import { useSequence } from '@/lib/outreach/queries';
import type { Graph } from '@/lib/outreach/types';
import { CountRate, DetailRow, ExportButton, InfoTip, MetricLabel, Refreshing, RetryError, Skeleton, SortTh, TableSkeleton, useElementWidth, useSort } from './primitives';
import { MiniBar } from './charts';
import type { TabProps } from './OverviewTab';

const STATUS_TONE: Record<string, 'green' | 'amber' | 'gray' | 'blue'> = { active: 'green', paused: 'amber', draft: 'gray', archived: 'gray' };
const words = (s: string) => s.replace(/_/g, ' ');
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The report lists steps in no particular order; walk the graph from the start so they read top to bottom. */
function orderSteps(steps: StepRow[], graph: Graph | undefined): StepRow[] {
  if (!graph?.nodes || !graph.start) return steps;
  const rank = new Map<string, number>(); const queue = [graph.start];
  while (queue.length) {
    const id = queue.shift()!;
    if (rank.has(id) || !graph.nodes[id]) continue;
    rank.set(id, rank.size);
    const n = graph.nodes[id];
    if (n.next) queue.push(n.next);
    for (const b of Object.values(n.branches ?? {})) if (b) queue.push(b);
  }
  return [...steps].sort((a, b) => (rank.get(a.node_id) ?? 9999) - (rank.get(b.node_id) ?? 9999));
}

const EXIT_LABELS: Record<string, string> = {
  completed: 'Finished every step', exited_replied: 'Replied', exited_manual: 'Removed by a teammate', exited_suppressed: 'Blacklisted', exited_condition: 'Left through a condition', failed: 'Failed',
};
function exitLabel(key: string): string {
  const [status, reason] = key.split(':');
  const base = EXIT_LABELS[status] ?? words(status);
  return reason ? `${base} (${words(reason)})` : base;
}

function StepCallout({ kind, step }: { kind: 'best' | 'worst'; step: StepRow }) {
  return (
    <div className="rounded-lg border border-gray-200 px-3 py-2.5">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{kind === 'best' ? 'Best step' : 'Weakest step'}</div>
      <div className="text-sm font-medium text-gray-900 mt-0.5 truncate">{sentence(step.label)}</div>
      <div className="text-xs text-gray-600 mt-0.5">{fmtRate(step.reply_rate)} reply rate · {fmtInt(step.replies)} replies from {fmtInt(step.sent)} sent</div>
    </div>
  );
}

function VariantTable({ test }: { test: AbTest }) {
  const judged = test.judged_on === 'accepted' ? 'acceptance rate' : 'interested replies';
  return (
    <Table>
      <thead><tr><Th>Variant</Th><Th className="text-right">Split</Th><Th className="text-right">Sent</Th><Th className="text-right">Accepted</Th><Th className="text-right">Replies</Th><Th className="text-right">Interested</Th><Th>Verdict</Th></tr></thead>
      <tbody>{test.variants.map((v) => (
        <tr key={v.variant_id}>
          <Td className="font-medium text-gray-900"><span className="inline-flex items-center gap-1.5">{v.label}{v.is_leading && test.enough_data && <InfoTip text={`Leading on ${judged}.`}><Trophy className="w-3.5 h-3.5 text-amber-500" aria-label="Leading" /></InfoTip>}</span></Td>
          <Td className="text-right tabular-nums">{v.weight === null || v.weight === undefined ? '—' : `${fmtInt(v.weight)}%`}</Td>
          <Td className="text-right tabular-nums">{fmtInt(v.sent)}</Td>
          <Td className="text-right"><CountRate count={fmtInt(v.accepted)} rate={fmtRate(v.acceptance_rate)} /></Td>
          <Td className="text-right"><CountRate count={fmtInt(v.replies)} rate={fmtRate(v.reply_rate)} /></Td>
          <Td className="text-right"><CountRate count={fmtInt(v.interested)} rate={fmtRate(v.interested_rate)} /></Td>
          <Td className="text-xs text-gray-600">
            {!test.enough_data ? <span className="text-gray-500">Not enough data yet</span> : v.is_leading ? <span className="font-medium text-gray-900">Leader</span> : (
              <>{v.verdict_vs_leader ?? '—'}{v.confidence_vs_leader !== null && <span className="text-gray-400"> · {v.confidence_vs_leader.toFixed(1)}% confidence</span>}</>
            )}
          </Td>
        </tr>
      ))}</tbody>
    </Table>
  );
}

const SPLIT_STAGES: Array<{ key: keyof AbVariant; label: string; rate?: keyof AbVariant }> = [
  { key: 'leads', label: 'Leads' }, { key: 'accepted', label: 'Accepted', rate: 'acceptance_rate' }, { key: 'replies', label: 'Replied', rate: 'reply_rate' },
  { key: 'interested', label: 'Interested', rate: 'interested_rate' }, { key: 'meetings', label: 'Meetings' },
];
function SplitFunnels({ test }: { test: AbTest }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {test.variants.map((v) => {
        const top = v.leads ?? v.sent;
        return (
          <div key={v.variant_id} className="rounded-lg border border-gray-200 p-3">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-medium text-gray-900 truncate">{v.label}</span>
              <span className="text-xs text-gray-500">{!test.enough_data ? 'Not enough data yet' : v.is_leading ? 'Leader' : v.verdict_vs_leader ?? ''}</span>
            </div>
            <div className="space-y-1.5">{SPLIT_STAGES.map((s) => {
              const n = (v[s.key] as number | undefined) ?? 0;
              return (
                <div key={s.key} className="grid grid-cols-[76px_1fr_92px] items-center gap-2 text-xs">
                  <span className="text-gray-600">{s.label}</span><MiniBar value={n} max={top} />
                  <span className="text-right tabular-nums text-gray-900">{fmtInt(n)}{s.rate && <span className="text-gray-500"> · {fmtRate(v[s.rate] as number | null)}</span>}</span>
                </div>
              );
            })}</div>
          </div>
        );
      })}
    </div>
  );
}

function AbBlock({ test, stepLabel, canPromote }: { test: AbTest; stepLabel: string; canPromote: boolean }) {
  const promote = usePromoteVariant();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isSplit = test.node_type === 'ab_split';
  const leader = test.variants.find((v) => v.variant_id === test.leader);
  return (
    <div className="rounded-xl border border-gray-200 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <div className="text-sm font-semibold text-gray-900 flex items-center gap-1.5"><FlaskConical className="w-4 h-4 text-gray-400" />{isSplit ? 'Path test' : 'Message test'} · {stepLabel}</div>
          <p className="text-xs text-gray-500 mt-0.5">Judged on {test.judged_on === 'accepted' ? 'accepted invitations' : 'interested replies'}. {test.enough_data ? '' : `Not enough data yet: a verdict needs ${test.min_sends_per_variant} sends per variant.`}</p>
        </div>
        {canPromote && test.can_promote && leader && <Button size="sm" variant="secondary" onClick={() => { setError(null); setConfirm(true); }}><Trophy className="w-3.5 h-3.5" /> Promote winner</Button>}
      </div>
      {isSplit ? <SplitFunnels test={test} /> : <VariantTable test={test} />}
      <Modal open={confirm} onClose={() => setConfirm(false)} size="sm" title="Promote the winner?"
        footer={<><Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button><Button loading={promote.isPending} onClick={async () => {
          try { await promote.mutateAsync({ sequenceId: test.sequence_id, nodeId: test.node_id, variantId: leader!.variant_id }); setConfirm(false); } catch (e) { setError(parseError(e).message); }
        }}>Promote</Button></>}>
        <p className="text-sm text-gray-700">“{leader?.label}” goes to 100% and a new version of the sequence is published. Messages already queued for this step switch to the winning text.</p>
        {error && <p className="text-sm text-red-600 mt-2">{error}</p>}
      </Modal>
    </div>
  );
}

function SequenceDetail({ row, range, canPromote }: { row: SequenceRow; range: DateRange; canPromote: boolean }) {
  const q = useReportSequence(row.sequence_id, range);
  const seq = useSequence(row.sequence_id);
  if (q.isLoading) return <div className="space-y-2 py-2"><Skeleton className="h-4 w-56" /><Skeleton className="h-24 w-full" /></div>;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  if (!r) return null;
  const steps = orderSteps(r.steps, seq.data?.graph); const maxSent = Math.max(0, ...steps.map((s) => s.sent));
  const stepName = (nodeId: string) => sentence(steps.find((s) => s.node_id === nodeId)?.label ?? nodeId);
  const exits = Object.entries(r.exits).sort((a, b) => b[1] - a[1]); const maxExit = Math.max(0, ...exits.map(([, n]) => n));
  const exportSteps = () => downloadCsv<StepRow>(csvFileName('sequences', range, `${row.name}-steps`), [
    { header: 'Step', value: (s) => s.label }, { header: 'Type', value: (s) => words(s.type) }, { header: 'Sent', value: (s) => s.sent }, { header: 'Failed', value: (s) => s.failed }, { header: 'Skipped', value: (s) => s.skipped },
    { header: 'Accepted', value: (s) => s.accepted }, { header: 'Acceptance rate %', value: (s) => s.acceptance_rate }, { header: 'Replies', value: (s) => s.replies }, { header: 'Reply rate %', value: (s) => s.reply_rate },
    { header: 'Interested', value: (s) => s.interested }, { header: 'Positive reply rate %', value: (s) => s.positive_reply_rate }, { header: 'Leads here now', value: (s) => s.leads_here }, { header: 'Failed here', value: (s) => s.failed_here },
  ], steps);

  return (
    <div className="space-y-5 py-1">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-xs text-gray-500">{fmtInt(r.live)} leads in progress · version {r.sequence.head_version}</div>
        <div className="flex items-center gap-2"><ExportButton onClick={exportSteps} disabled={!steps.length} /><Link href={`/outreach/sequences/${row.sequence_id}`}><Button size="sm" variant="ghost">Open sequence</Button></Link></div>
      </div>

      {(r.best_step || r.worst_step) && <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{r.best_step && <StepCallout kind="best" step={r.best_step} />}{r.worst_step && <StepCallout kind="worst" step={r.worst_step} />}</div>}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Step by step</h4>
        {!steps.length ? <p className="text-sm text-gray-500">This sequence has no sending steps yet.</p> : (
          <Table>
            <thead><tr><Th>Step</Th><Th className="w-[28%]">Sent in this period</Th><Th className="text-right">Accepted</Th><Th className="text-right">Replies</Th><Th className="text-right">Interested</Th><Th className="text-right">Failed</Th><Th className="text-right">Leads here now</Th></tr></thead>
            <tbody>{steps.map((s) => (
              <tr key={s.node_id}>
                <Td><div className="font-medium text-gray-900 truncate max-w-[240px]" title={s.label}>{sentence(s.label)}</div>{s.label.toLowerCase() !== words(s.type) && <div className="text-xs text-gray-500">{sentence(words(s.type))}</div>}</Td>
                <Td><div className="flex items-center gap-2"><MiniBar value={s.sent} max={maxSent} className="flex-1" /><span className="w-14 text-right tabular-nums text-gray-900">{fmtInt(s.sent)}</span></div></Td>
                <Td className="text-right">{s.type === 'send_invite' ? <CountRate count={fmtInt(s.accepted)} rate={fmtRate(s.acceptance_rate)} /> : <span className="text-gray-300">—</span>}</Td>
                <Td className="text-right"><CountRate count={fmtInt(s.replies)} rate={fmtRate(s.reply_rate)} /></Td>
                <Td className="text-right"><CountRate count={fmtInt(s.interested)} rate={fmtRate(s.positive_reply_rate)} /></Td>
                <Td className="text-right tabular-nums">{s.failed_here > 0 ? <Link className="underline decoration-gray-300 underline-offset-4" href={`/outreach/sequences/${row.sequence_id}?failed=1&node=${encodeURIComponent(s.node_id)}`}>{fmtInt(s.failed)}</Link> : fmtInt(s.failed)}</Td>
                <Td className="text-right tabular-nums">{fmtInt(s.leads_here)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </div>

      {r.ab_tests.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">A/B tests</h4>
          {r.ab_tests.map((t) => <AbBlock key={t.node_id} test={t} stepLabel={stepName(t.node_id)} canPromote={canPromote} />)}
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Why leads left in this period</h4>
        {!exits.length ? <p className="text-sm text-gray-500">No lead left this sequence in the period.</p> : (
          <ul className="space-y-1.5 max-w-2xl">{exits.map(([k, n]) => (
            <li key={k} className="grid grid-cols-[minmax(0,260px)_1fr_56px] items-center gap-3 text-sm"><span className="text-gray-700 truncate" title={exitLabel(k)}>{exitLabel(k)}</span><MiniBar value={n} max={maxExit} /><span className="text-right tabular-nums text-gray-900">{fmtInt(n)}</span></li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}

const ACCESSORS: Record<string, (r: SequenceRow) => string | number | null> = {
  name: (r) => r.name.toLowerCase(), live: (r) => r.live, enrolled: (r) => r.totals.enrolled, touches: (r) => r.totals.touches, acceptance_rate: (r) => r.totals.acceptance_rate,
  replies: (r) => r.totals.replies, reply_rate: (r) => r.totals.reply_rate, interested: (r) => r.totals.interested, positive_reply_rate: (r) => r.totals.positive_reply_rate,
  meetings: (r) => r.totals.meetings, failed_leads: (r) => r.failed_leads,
};

export default function SequencesTab({ ws, client, range, canPromote }: TabProps & { canPromote: boolean }) {
  const q = useReportSequences({ ws, client, range });
  const { sorted, sort, toggle } = useSort(q.data, { key: 'replies', dir: 'desc' }, ACCESSORS);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const box = useElementWidth<HTMLDivElement>();
  const flip = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  if (q.isLoading) return <TableSkeleton cols={9} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.length) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<GitBranch className="w-6 h-6" />} title="No sequences to report on" description={client ? 'This client has no sequences yet. Clear the client filter to see every sequence.' : 'Build and activate a sequence. Its numbers show up here as soon as it sends.'} /></div>;

  const exportCsv = () => downloadCsv<SequenceRow>(csvFileName('sequences', range), [
    { header: 'Sequence', value: (r) => r.name }, { header: 'Status', value: (r) => r.status }, { header: 'Stalled reason', value: (r) => r.stalled_reason }, { header: 'Leads in progress', value: (r) => r.live },
    ...totalsCsvColumns<SequenceRow>((r) => r.totals), { header: 'Failed leads', value: (r) => r.failed_leads },
  ], sorted);

  const th = { sort, onSort: toggle };
  return (
    <Refreshing active={q.isPlaceholderData}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-gray-500">Open a row for step drop-off, A/B results and exit reasons.</p>
        <ExportButton onClick={exportCsv} />
      </div>
      <div ref={box.ref} className="[&_td]:px-3 [&_th]:px-3"><Table>
        <thead><tr>
          <Th className="w-8" /><SortTh label="Sequence" sortKey="name" align="left" firstDir="asc" {...th} /><SortTh label="Enrolled" sortKey="enrolled" {...th} />
          <SortTh label="Touches" sortKey="touches" metric="touches" {...th} /><SortTh label="Acceptance" sortKey="acceptance_rate" metric="acceptance_rate" {...th} /><SortTh label="Replies" sortKey="replies" metric="replies" {...th} />
          <SortTh label="Interested" sortKey="interested" metric="interested" {...th} /><SortTh label="Meetings" sortKey="meetings" metric="meetings" {...th} /><SortTh label="Failed leads" sortKey="failed_leads" {...th} />
        </tr></thead>
        <tbody>{sorted.map((r) => {
          const isOpen = open.has(r.sequence_id); const t = r.totals;
          return (
            <React.Fragment key={r.sequence_id}>
              <tr className={cn('hover:bg-gray-50', isOpen && 'bg-gray-50')}>
                <Td className="pr-0"><button type="button" onClick={() => flip(r.sequence_id)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} details for ${r.name}`} className="p-1 rounded hover:bg-gray-200 text-gray-500">{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</button></Td>
                <Td className="min-w-[240px]">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button type="button" onClick={() => flip(r.sequence_id)} className="font-medium text-gray-900 hover:underline text-left">{r.name}</button>
                    <Badge tone={STATUS_TONE[r.status] ?? 'gray'}>{words(r.status)}</Badge>
                    {r.has_ab_test && <Badge tone="indigo">A/B</Badge>}
                    {r.stalled && <Badge tone="red"><AlertTriangle className="w-3 h-3 mr-1" />Stalled</Badge>}
                  </div>
                  {r.stalled && <div className="text-xs text-red-700 mt-1 max-w-md">{r.stalled_reason ?? 'Nothing has been sent for a day.'} <Link href={`/outreach/sequences/${r.sequence_id}?why=1`} className="underline">Why isn’t this sending?</Link></div>}
                </Td>
                <Td className="text-right"><span className="inline-flex flex-col items-end leading-tight"><span className="tabular-nums text-gray-900">{fmtInt(t.enrolled)}</span><span className="text-xs text-gray-500 whitespace-nowrap">{fmtInt(r.live)} in progress</span></span></Td><Td className="text-right tabular-nums">{fmtInt(t.touches)}</Td>
                <Td className="text-right"><CountRate count={fmtInt(t.accepted)} rate={fmtRate(t.acceptance_rate)} /></Td>
                <Td className="text-right"><CountRate count={fmtInt(t.replies)} rate={fmtRate(t.reply_rate)} /></Td>
                <Td className="text-right"><CountRate count={fmtInt(t.interested)} rate={fmtRate(t.positive_reply_rate)} /></Td>
                <Td className="text-right tabular-nums">{fmtInt(t.meetings)}</Td>
                <Td className="text-right tabular-nums">{r.failed_leads > 0 ? <Link href={`/outreach/sequences/${r.sequence_id}?failed=1`} className="underline decoration-gray-300 underline-offset-4">{fmtInt(r.failed_leads)}</Link> : <span className="text-gray-300">0</span>}</Td>
              </tr>
              {isOpen && <DetailRow colSpan={9} width={box.width}><SequenceDetail row={r} range={range} canPromote={canPromote} /></DetailRow>}
            </React.Fragment>
          );
        })}</tbody>
      </Table></div>
      <p className="text-xs text-gray-400 mt-2">Under each count: <MetricLabel metric="acceptance_rate">acceptance rate</MetricLabel>, <MetricLabel metric="reply_rate">reply rate</MetricLabel> and <MetricLabel metric="positive_reply_rate">positive reply rate</MetricLabel>.</p>
    </Refreshing>
  );
}
