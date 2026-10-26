'use client';

// The per-step table, best / worst step, A/B blocks and exit reasons of one sequence (outreach_report_sequence, 013).
// Shared by Reports → Sequences (the expanded row) and the sequence page's Results tab (under the channel blocks).
import React, { useState } from 'react';
import Link from '@/lib/outreach/nav';
import { FlaskConical, Trophy } from 'lucide-react';
import { Button, Modal, Table, Td, Th } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { csvFileName, downloadCsv, fmtInt, fmtRate, usePromoteVariant, type AbTest, type AbVariant, type DateRange, type SequenceReport, type StepRow } from '@/lib/outreach/reports';
import type { Graph } from '@/lib/outreach/types';
import { CountRate, ExportButton, InfoTip } from './primitives';
import { MiniBar } from './charts';

const words = (s: string) => s.replace(/_/g, ' ');
const sentence = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The report lists steps in no particular order; walk the graph from the start so they read top to bottom. */
export function orderSteps(steps: StepRow[], graph: Graph | undefined | null): StepRow[] {
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
  completed: 'Finished every step', exited_replied: 'Human handoff (replied)', exited_manual: 'Stopped by teammate', exited_suppressed: 'Do not contact', exited_sender_disabled: 'Sender disabled',
  exited_condition: 'Left through a condition', failed: 'Failed', cancelled: 'Unenrolled',
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
    <div className="rounded-xl border border-gray-200 p-4 bg-white">
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

/**
 * Steps, A/B tests and exits of one report. `range` names the window the step table was read for (the report's
 * period.steps_from / steps_to for all time) and is only used for the CSV file name.
 */
export default function SequenceStepTables({ r, graph, sequenceId, sequenceName, range, canPromote, only }: {
  r: SequenceReport; graph: Graph | undefined | null; sequenceId: string; sequenceName: string; range: DateRange; canPromote: boolean;
  /** 'ab': only the A/B test blocks (the sequence Analytics tab has its own step table). */
  only?: 'ab';
}) {
  const steps = orderSteps(r.steps, graph); const maxSent = Math.max(0, ...steps.map((s) => s.sent));
  const stepName = (nodeId: string) => sentence(steps.find((s) => s.node_id === nodeId)?.label ?? nodeId);
  if (only === 'ab') {
    return r.ab_tests.length === 0 ? null : (
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">A/B tests</h4>
        {r.ab_tests.map((t) => <AbBlock key={t.node_id} test={t} stepLabel={stepName(t.node_id)} canPromote={canPromote} />)}
      </div>
    );
  }
  const exits = Object.entries(r.exits ?? {}).sort((a, b) => b[1] - a[1]); const maxExit = Math.max(0, ...exits.map(([, n]) => n));
  const exportSteps = () => downloadCsv<StepRow>(csvFileName('sequences', range, `${sequenceName}-steps`), [
    { header: 'Step', value: (s) => s.label }, { header: 'Type', value: (s) => words(s.type) }, { header: 'Sent', value: (s) => s.sent }, { header: 'Failed', value: (s) => s.failed }, { header: 'Skipped', value: (s) => s.skipped },
    { header: 'Accepted', value: (s) => s.accepted }, { header: 'Acceptance rate %', value: (s) => s.acceptance_rate }, { header: 'Replies', value: (s) => s.replies }, { header: 'Reply rate %', value: (s) => s.reply_rate },
    { header: 'Interested', value: (s) => s.interested }, { header: 'Positive reply rate %', value: (s) => s.positive_reply_rate }, { header: 'Leads here now', value: (s) => s.leads_here }, { header: 'Failed here', value: (s) => s.failed_here },
  ], steps);

  return (
    <div className="space-y-5">
      {(r.best_step || r.worst_step) && <div className="grid grid-cols-1 md:grid-cols-2 gap-3">{r.best_step && <StepCallout kind="best" step={r.best_step} />}{r.worst_step && <StepCallout kind="worst" step={r.worst_step} />}</div>}

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Step by step</h4>
          <ExportButton onClick={exportSteps} disabled={!steps.length} />
        </div>
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
                <Td className="text-right tabular-nums">{s.failed_here > 0 ? <Link className="underline decoration-gray-300 underline-offset-4" href={`/outreach/sequences/${sequenceId}?failed=1&node=${encodeURIComponent(s.node_id)}`}>{fmtInt(s.failed)}</Link> : fmtInt(s.failed)}</Td>
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
