'use client';

import React, { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EmptyState, Select, Table, Td, Th } from '@/components/outreach/ui';
import { parseError } from '@/lib/outreach/api';
import { useSenders, useSequences } from '@/lib/outreach/queries';
import {
  INTENT_KEYS, INTENT_LABELS, MAX_INBOX_CHATS, csvFileName, downloadCsv, fetchReplyThreads, fmtInt, fmtRange, fmtRate, inboxThreadsHref, useReportIntents,
  type IntentGroup, type IntentKey, type IntentRow, type ReportFilters,
} from '@/lib/outreach/reports';
import { ChartSkeleton, ExportButton, KpiTile, MetricLabel, Refreshing, RetryError, Section, TableSkeleton, TilesSkeleton } from './primitives';
import { IntentBar, IntentLegend, IntentStackChart } from './charts';
import type { TabProps } from './OverviewTab';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';

const GROUPS: Array<{ key: IntentGroup; label: string; column: string }> = [
  { key: 'sequence', label: 'Sequence', column: 'Sequence' }, { key: 'step', label: 'Step', column: 'Step' },
  { key: 'sender', label: 'Sender', column: 'Sender' }, { key: 'variant', label: 'Variant', column: 'Step and variant' },
];

function NumberLink({ value, onClick, busy, label }: { value: number; onClick: () => void; busy: boolean; label: string }) {
  if (!value) return <span className="tabular-nums text-gray-300">0</span>;
  return <button type="button" disabled={busy} onClick={onClick} aria-label={label} title="Open these threads in the inbox" className="tabular-nums text-gray-900 underline decoration-gray-300 underline-offset-4 hover:decoration-gray-900 disabled:opacity-50">{fmtInt(value)}</button>;
}

export default function RepliesTab({ ws, client, range, onNotice }: TabProps & { onNotice: (message: string, type?: 'success' | 'error') => void }) {
  const router = useRouter();
  // Grouping and filters are remembered per workspace in this browser.
  const { filters: remembered, setFilters: setRemembered, patch: patchRemembered } = usePersistedFilters<{ group: IntentGroup } & ReportFilters>('reports-replies', ws,
    { group: 'sequence', sequence_id: undefined, sender_id: undefined, node_id: undefined, channel: undefined, variant_id: undefined },
    { sanitize: (raw, d) => { const v = sanitizeLike(raw, d); if (!GROUPS.some((g) => g.key === v.group)) v.group = 'sequence'; return v; } });
  const group = remembered.group;
  const setGroup = (g: IntentGroup) => patchRemembered({ group: g });
  const pickFilters = (v: ReportFilters): ReportFilters => ({ sequence_id: v.sequence_id, sender_id: v.sender_id, node_id: v.node_id, channel: v.channel, variant_id: v.variant_id });
  const filters = useMemo(() => pickFilters(remembered), [remembered]);
  const setFilters = (next: (f: ReportFilters) => ReportFilters) => setRemembered((v) => ({ ...v, ...next(pickFilters(v)) }));
  const [opening, setOpening] = useState(false);
  const sequences = useSequences(ws); const senders = useSenders(ws);
  const scope = { ws, client, range };

  // Steps and variants are only meaningful inside one sequence (step ids can repeat across sequences).
  const needsSequence = (group === 'step' || group === 'variant') && !filters.sequence_id;
  const byDay = useReportIntents(scope, 'day', filters);
  const grouped = useReportIntents({ ...scope, enabled: !needsSequence }, group, filters);

  const seqOptions = (sequences.data ?? []).filter((s) => s.status !== 'archived' && (!client || s.client_id === client));
  const senderOptions = (senders.data ?? []).filter((s) => !client || s.client_id === client);
  const selectedSequence = useMemo(() => (sequences.data ?? []).find((s) => s.id === filters.sequence_id) ?? null, [sequences.data, filters.sequence_id]);

  function rowLabel(r: IntentRow): string {
    if (group === 'sequence') return r.label ?? 'No sequence';
    if (group === 'sender') return r.label ?? 'Unknown sender';
    const [nodeId, variantId] = r.key.split('|');
    const node = selectedSequence?.graph?.nodes?.[nodeId];
    const step = node ? (node.label || String(node.type).replace(/_/g, ' ')) : nodeId || 'No step';
    if (group === 'step') return step;
    const variants = (node?.config?.variants ?? []) as Array<{ id: string; label?: string }>;
    const v = variantId ? variants.find((x) => x.id === variantId)?.label ?? variantId : 'No variant';
    return `${step} · ${v}`;
  }

  function rowFilters(r: IntentRow): ReportFilters {
    if (group === 'sequence') return { ...filters, sequence_id: r.key };
    if (group === 'sender') return { ...filters, sender_id: r.key };
    const [nodeId, variantId] = r.key.split('|');
    return group === 'step' ? { ...filters, node_id: nodeId } : { ...filters, node_id: nodeId, variant_id: variantId ?? '' };
  }

  async function openThreads(intent: IntentKey | null, f: ReportFilters, what: string) {
    setOpening(true);
    try {
      const threads = await fetchReplyThreads(scope, intent, f);
      const ids = Array.from(new Set(threads.map((t) => t.chat_id)));
      if (!ids.length) { onNotice('No threads are behind this number any more. Refresh the report.', 'error'); return; }
      if (ids.length > MAX_INBOX_CHATS) onNotice(`Showing the first ${MAX_INBOX_CHATS} of ${fmtInt(ids.length)} threads.`);
      router.push(inboxThreadsHref(ids, `${what}, ${fmtRange(range)}`));
    } catch (e) { onNotice(parseError(e).message, 'error'); }
    finally { setOpening(false); }
  }

  const intentWord = (k: IntentKey | null) => (k ? `${INTENT_LABELS[k]} replies` : 'Replies');
  const rows = grouped.data?.rows ?? [];
  const exportCsv = () => downloadCsv<IntentRow>(csvFileName('replies', range, `by-${group}`), [
    { header: GROUPS.find((g) => g.key === group)!.column, value: rowLabel }, { header: 'Touches', value: (r) => r.touches }, { header: 'Replies', value: (r) => r.replies }, { header: 'Reply rate %', value: (r) => r.reply_rate },
    ...INTENT_KEYS.map((k) => ({ header: INTENT_LABELS[k], value: (r: IntentRow) => r.intents[k] })),
    { header: 'Positive reply rate %', value: (r) => r.positive_reply_rate }, { header: 'Negative reply rate %', value: (r) => r.negative_reply_rate },
  ], rows);
  const exportDaily = () => downloadCsv<IntentRow>(csvFileName('replies', range, 'by-day'), [
    { header: 'Day', value: (r) => r.key }, { header: 'Replies', value: (r) => r.replies }, ...INTENT_KEYS.map((k) => ({ header: INTENT_LABELS[k], value: (r: IntentRow) => r.intents[k] })),
  ], byDay.data?.rows ?? []);

  const d = byDay.data;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Select label="Sequence" value={filters.sequence_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, sequence_id: e.target.value || undefined }))}><option value="">All sequences</option>{seqOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select label="Sender" value={filters.sender_id ?? ''} onChange={(e) => setFilters((f) => ({ ...f, sender_id: e.target.value || undefined }))}><option value="">All senders</option>{senderOptions.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? 'Unnamed sender'}</option>)}</Select>
      </div>

      {byDay.isLoading ? <><TilesSkeleton count={4} /><ChartSkeleton height={260} /></> : byDay.isError ? <RetryError error={byDay.error} onRetry={() => byDay.refetch()} /> : !d ? null : (
        <Refreshing active={byDay.isPlaceholderData}>
          <div className="space-y-6">
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
              <KpiTile label="Positive reply rate" metric="positive_reply_rate" value={fmtRate(d.positive_reply_rate)} sub={<span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-700" />{fmtInt(d.intents.interested)} interested</span>} />
              <KpiTile label="Negative reply rate" metric="negative_reply_rate" value={fmtRate(d.negative_reply_rate)} sub={<span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-600" />{fmtInt(d.intents.not_interested)} not interested</span>} />
              <KpiTile label="Replies" metric="replies" value={fmtInt(d.replies)} sub="Open them in the inbox" onClick={d.replies ? () => openThreads(null, filters, 'Replies') : undefined} />
              <KpiTile label="Reply rate" metric="reply_rate" value={fmtRate(d.reply_rate)} sub={<>{fmtInt(d.touches)} <MetricLabel metric="touches">touches</MetricLabel></>} />
            </div>

            {!d.replies ? (
              <Section title="Replies by intent"><EmptyState icon={<MessageSquare className="w-6 h-6" />} title="No replies in this period" description="Try a longer range or clear the filters. A reply counts on the day a lead first answers an automated step." /></Section>
            ) : (
              <Section title="Replies by intent over time" description="Each reply is counted once, on the day the lead first answered, under the thread's current intent. Change an intent in the inbox and this chart follows."
                actions={<ExportButton onClick={exportDaily} />}>
                <div className="mb-3"><IntentLegend counts={d.intents} /></div>
                <IntentStackChart rows={d.rows} />
              </Section>
            )}
          </div>
        </Refreshing>
      )}

      <Section title="Where replies come from" description="Click a number to open exactly those threads in the inbox."
        actions={<>
          <div className="inline-flex rounded-lg border border-gray-300 bg-white p-0.5" role="group" aria-label="Group replies by">
            {GROUPS.map((g) => <button key={g.key} type="button" aria-pressed={group === g.key} onClick={() => setGroup(g.key)} className={cn('px-2.5 py-1 text-xs rounded-md', group === g.key ? 'bg-gray-900 text-white' : 'text-gray-600 hover:bg-gray-100')}>{g.label}</button>)}
          </div>
          <ExportButton onClick={exportCsv} disabled={!rows.length || needsSequence} />
        </>}>
        {needsSequence ? (
          <EmptyState title="Pick a sequence first" description="Steps and variants belong to one sequence. Choose a sequence in the filter above to compare its steps." />
        ) : grouped.isLoading ? <TableSkeleton cols={8} /> : grouped.isError ? <RetryError error={grouped.error} onRetry={() => grouped.refetch()} /> : !rows.length ? (
          <EmptyState icon={<MessageSquare className="w-6 h-6" />} title="No replies in this period" description="Try a longer range or clear the filters." />
        ) : (
          <Refreshing active={grouped.isPlaceholderData}>
            <Table>
              <thead><tr>
                <Th>{GROUPS.find((g) => g.key === group)!.column}</Th>
                <Th className="text-right"><MetricLabel metric="touches">Touches</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="replies">Replies</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="reply_rate">Reply rate</MetricLabel></Th>
                {INTENT_KEYS.map((k) => <Th key={k} className="text-right whitespace-nowrap">{INTENT_LABELS[k]}</Th>)}
                <Th className="text-right"><MetricLabel metric="positive_reply_rate">Positive</MetricLabel></Th>
                <Th className="text-right"><MetricLabel metric="negative_reply_rate">Negative</MetricLabel></Th>
                <Th className="w-32">Mix</Th>
              </tr></thead>
              <tbody>{rows.map((r) => {
                const name = rowLabel(r); const f = rowFilters(r);
                return (
                  <tr key={r.key}>
                    <Td className="font-medium text-gray-900 max-w-[260px] truncate" title={name}>{name}</Td>
                    <Td className="text-right tabular-nums">{fmtInt(r.touches)}</Td>
                    <Td className="text-right"><NumberLink value={r.replies} busy={opening} onClick={() => openThreads(null, f, `Replies · ${name}`)} label={`Open ${r.replies} replies for ${name} in the inbox`} /></Td>
                    <Td className="text-right tabular-nums">{fmtRate(r.reply_rate)}</Td>
                    {INTENT_KEYS.map((k) => <Td key={k} className="text-right"><NumberLink value={r.intents[k]} busy={opening} onClick={() => openThreads(k, f, `${intentWord(k)} · ${name}`)} label={`Open ${r.intents[k]} ${INTENT_LABELS[k].toLowerCase()} replies for ${name} in the inbox`} /></Td>)}
                    <Td className="text-right tabular-nums">{fmtRate(r.positive_reply_rate)}</Td>
                    <Td className="text-right tabular-nums">{fmtRate(r.negative_reply_rate)}</Td>
                    <Td><IntentBar intents={r.intents} total={r.replies} /></Td>
                  </tr>
                );
              })}</tbody>
            </Table>
          </Refreshing>
        )}
      </Section>
    </div>
  );
}
