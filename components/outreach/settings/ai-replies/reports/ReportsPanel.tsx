'use client';

import { useState } from 'react';
import { parseError } from '@/lib/outreach/api';
import type { MetricsTotals } from '@/lib/outreach/aiReplies';
import { HANDOFF_REASON_LABEL, useAiMetricsV2, type MetricsGroup as Group } from '@/lib/outreach/aiRepliesSequence';
import { Card, ErrorBox, Input, Select, Spinner, Stat, Table, Td, Th } from '@/components/outreach/ui';
import { cancelReasonLabel, daysSince, fmtSeconds, isoDaysAgo, pct, reasonLabel, stageLabel } from '../format';
import { useStageLabels } from '../useStageLabels';
import ReasonBars from './ReasonBars';
import CancelReport from './CancelReport';

const GROUPS: Array<{ v: Group; label: string }> = [
  { v: 'none', label: 'No grouping' }, { v: 'sequence', label: 'Sequence' }, { v: 'sender', label: 'Sender' }, { v: 'stage', label: 'Stage' },
  { v: 'scenario', label: 'Scenario' }, { v: 'trigger', label: 'Trigger' }, { v: 'master_prompt', label: 'Prompt version' }, { v: 'client', label: 'Client' },
];
const TRIGGER_LABEL: Record<string, string> = { auto: 'Automatic', manual: 'Draft with AI' };
const n = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString());

/** AI reply metrics for a date range plus hand-offs and the cancel-reason report by prompt rule. */
export default function ReportsPanel({ ws, onOpenRun }: { ws: string; onOpenRun: (id: string) => void }) {
  const [range, setRange] = useState(() => ({ from: isoDaysAgo(29), to: isoDaysAgo(0) }));
  const [group, setGroup] = useState<Group>('none');
  const bad = !range.from || !range.to || range.from > range.to;
  const q = useAiMetricsV2(bad ? null : ws, range.from, range.to, group);
  const { labels } = useStageLabels(ws);
  const t = q.data?.totals;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end gap-3">
        <Input type="date" label="From" value={range.from} max={range.to || undefined} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} className="py-1.5" />
        <Input type="date" label="To" value={range.to} min={range.from || undefined} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} className="py-1.5" />
        <Select label="Group by" value={group} onChange={(e) => setGroup(e.target.value as Group)} className="py-1.5">
          {GROUPS.map((g) => <option key={g.v} value={g.v}>{g.label}</option>)}
        </Select>
      </div>
      {bad && <ErrorBox message="Pick a start date on or before the end date." />}
      {q.isLoading && !bad && <Spinner />}
      {q.error && <ErrorBox message={parseError(q.error).message} />}

      {t && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <Stat label="AI runs" value={n(t.runs)} />
            <Stat label="Sent by Auto" value={n(t.sent_ai)} />
            <Stat label="Drafts sent by a person" value={n(t.sent_human_draft)} hint={`${pct(t.light_edit_share)} unedited or lightly edited`} />
            <Stat label="Handed to a person" value={n(t.escalated)} hint="Replies the AI would not write" />
            <Stat label="Handed off" value={n(q.data?.handed_off ?? 0)} hint="Conversations a person took over" />
            <Stat label="No reply needed" value={n(t.no_reply)} />
            <Stat label="Cancelled" value={n(t.cancelled)} hint={`${pct(t.hold_cancel_rate)} of Auto holds`} />
            <Stat label="Draft ready (median)" value={fmtSeconds(t.draft_p50_s)} hint={`95th percentile ${fmtSeconds(t.draft_p95_s)}`} />
            <Stat label="Sent (median)" value={fmtSeconds(t.send_p50_s)} hint="From their message" />
            <Stat label="Asked if it's a bot" value={pct(t.bot_question_rate)} hint="Of AI sends" />
            <Stat label="Expired" value={n(t.expired)} />
            <Stat label="Failed" value={n(t.failed)} />
            <Stat label="Replaced by a newer draft" value={n(t.superseded)} />
          </div>

          {group !== 'none' && (
            <Card title={`By ${GROUPS.find((g) => g.v === group)?.label.toLowerCase()}`}>
              {(q.data?.groups ?? []).length === 0 ? <p className="text-sm text-gray-400">No runs in this period.</p> : (
                <Table>
                  <thead>
                    <tr><Th>{GROUPS.find((g) => g.v === group)?.label}</Th><Th className="text-right">Runs</Th><Th className="text-right">Auto</Th><Th className="text-right">Drafts sent</Th>
                      <Th className="text-right">Light edits</Th><Th className="text-right">Handed over</Th><Th className="text-right">Cancelled</Th><Th className="text-right">Draft p50</Th></tr>
                  </thead>
                  <tbody>
                    {(q.data?.groups ?? []).map((g) => <GroupRow key={g.key} label={group === 'stage' ? stageLabel(g.key, labels) : group === 'trigger' ? TRIGGER_LABEL[g.key] ?? g.key : g.label || g.key} t={g} />)}
                  </tbody>
                </Table>
              )}
            </Card>
          )}

          <div className="grid lg:grid-cols-3 gap-5">
            <Card title="Why conversations were handed off">
              <ReasonBars items={q.data?.handoff_reasons ?? []} label={(k) => HANDOFF_REASON_LABEL[k] ?? k.replace(/_/g, ' ')} empty="No hand-offs in this period." />
            </Card>
            <Card title="Why replies were handed to a person">
              <ReasonBars items={q.data?.escalation_reasons ?? []} label={reasonLabel} empty="Nothing handed over in this period." />
            </Card>
            <Card title="Why held replies were cancelled">
              <ReasonBars items={q.data?.cancel_reasons ?? []} label={cancelReasonLabel} empty="Nothing cancelled in this period." />
            </Card>
          </div>
        </>
      )}

      <CancelReport ws={ws} days={bad ? 30 : daysSince(range.from)} onOpenRun={onOpenRun} />
    </div>
  );
}

function GroupRow({ label, t }: { label: string; t: MetricsTotals }) {
  return (
    <tr>
      <Td className="font-medium text-gray-900">{label}</Td>
      <Td className="text-right tabular-nums">{n(t.runs)}</Td>
      <Td className="text-right tabular-nums">{n(t.sent_ai)}</Td>
      <Td className="text-right tabular-nums">{n(t.sent_human_draft)}</Td>
      <Td className="text-right tabular-nums">{pct(t.light_edit_share)}</Td>
      <Td className="text-right tabular-nums">{n(t.escalated)}</Td>
      <Td className="text-right tabular-nums">{n(t.cancelled)}</Td>
      <Td className="text-right tabular-nums">{fmtSeconds(t.draft_p50_s)}</Td>
    </tr>
  );
}
