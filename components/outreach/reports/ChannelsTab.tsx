'use client';

// Reports → Channels (PRD §12): replies per 100 actions by channel, and the block log with the actions that preceded
// each block. Both come straight from outreach_report_channels / outreach_report_blocks.
import React, { useState } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight, Radio, ShieldAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge, EmptyState, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { csvFileName, downloadCsv, fmtInt, fmtRate } from '@/lib/outreach/reports';
import { channelKeyLabel, channelLabel, useReportBlocks, useReportChannels, type ReportBlockRow, type ReportChannelRow } from '@/lib/outreach/channels';
import { ACTION_LABELS } from '@/components/outreach/senders/helpers';
import { reasonText } from '@/lib/outreach/reasons';
import { CountRate, DetailRow, ExportButton, MetricLabel, Refreshing, RetryError, Section, SortTh, TableSkeleton, useElementWidth, useSort } from './primitives';
import type { TabProps } from './OverviewTab';
import type { ActionType } from '@/lib/outreach/types';

const ACCESSORS: Record<string, (r: ReportChannelRow) => string | number | null> = {
  channel: (r) => r.channel, senders: (r) => r.senders, actions: (r) => r.actions, new_chats: (r) => r.new_chats, replies: (r) => r.replies,
  replies_per_100_actions: (r) => r.replies_per_100_actions, interested: (r) => r.interested, blocks: (r) => r.blocks,
};

function per100(n: number | null | undefined): string { return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(1) : '—'; }
function actionLabel(t: string): string { return ACTION_LABELS[t as ActionType] ?? t.replace(/_/g, ' '); }

function BlocksLog({ ws, client, range }: TabProps) {
  const q = useReportBlocks({ ws, client, range });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const box = useElementWidth<HTMLDivElement>();
  const key = (r: ReportBlockRow, i: number) => `${r.at}-${r.sender_id}-${i}`;
  const flip = (k: string) => setOpen((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n; });

  if (q.isLoading) return <TableSkeleton cols={5} rows={3} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data?.rows ?? [];
  const exportCsv = () => downloadCsv<ReportBlockRow>(csvFileName('blocks', range), [
    { header: 'When', value: (r) => r.at }, { header: 'Channel', value: (r) => channelLabel(r.provider) }, { header: 'Sender', value: (r) => r.sender_name }, { header: 'Lead', value: (r) => r.lead_name },
    { header: 'Signal', value: (r) => r.code }, { header: 'Preceding actions', value: (r) => (r.preceding ?? []).map((p) => `${p.at} ${p.type}`).join(' | ') },
  ], rows);

  return (
    <Section title={<span className="inline-flex items-center gap-1.5"><ShieldAlert className="w-4 h-4 text-gray-400" /> Blocks and restrictions</span>}
      description="Every detected block, with the five actions that came before it. This is the record the governor thresholds are tuned against, so it is worth reading when a sender keeps getting blocked."
      actions={<ExportButton onClick={exportCsv} disabled={!rows.length} />}>
      {!rows.length ? <p className="text-sm text-gray-500">No blocks detected in this period.</p> : (
        <>
          {!!q.data?.by_sender?.length && (
            <div className="flex flex-wrap gap-1.5 mb-3">
              {q.data.by_sender.map((s) => <Link key={s.sender_id} href={`/outreach/senders/${s.sender_id}`}><Badge tone={s.blocks >= 3 ? 'red' : 'amber'}>{s.name ?? 'Sender'}: {fmtInt(s.blocks)} {s.blocks === 1 ? 'block' : 'blocks'}</Badge></Link>)}
            </div>
          )}
          <div ref={box.ref}><Table>
            <thead><tr><Th className="w-8" /><Th>When</Th><Th>Channel</Th><Th>Sender</Th><Th>Lead</Th><Th>Signal</Th></tr></thead>
            <tbody>{rows.map((r, i) => {
              const k = key(r, i); const isOpen = open.has(k); const pre = r.preceding ?? [];
              return (
                <React.Fragment key={k}>
                  <tr className={cn('hover:bg-gray-50', isOpen && 'bg-gray-50')}>
                    <Td className="pr-0"><button type="button" onClick={() => flip(k)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} the actions before this block`} className="p-1 rounded hover:bg-gray-200 text-gray-500" disabled={!pre.length}>{isOpen ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className={cn('w-4 h-4', !pre.length && 'opacity-30')} />}</button></Td>
                    <Td className="whitespace-nowrap">{fmtDate(r.at)}</Td>
                    <Td>{channelLabel(r.provider)}</Td>
                    <Td>{r.sender_name ? <Link href={`/outreach/senders/${r.sender_id}`} className="text-gray-900 hover:underline">{r.sender_name}</Link> : <span className="text-gray-400">—</span>}</Td>
                    <Td>{r.lead_id ? <Link href={`/outreach/leads/${r.lead_id}`} className="text-gray-900 hover:underline">{r.lead_name ?? 'Lead'}</Link> : <span className="text-gray-400">—</span>}</Td>
                    <Td className="text-xs text-gray-600">{r.code ? reasonText(r.code, null) : 'Blocked'}</Td>
                  </tr>
                  {isOpen && pre.length > 0 && (
                    <DetailRow colSpan={6} width={box.width}>
                      <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">What happened before</div>
                      <ol className="space-y-1 text-sm">
                        {pre.map((p, j) => <li key={`${p.at}-${j}`} className="flex items-center gap-3"><span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">{fmtDate(p.at)}</span><span className="text-gray-800">{actionLabel(p.type)}</span>{p.lead_id && <Link href={`/outreach/leads/${p.lead_id}`} className="text-xs text-indigo-600 hover:underline">{p.lead_name ?? 'lead'}</Link>}</li>)}
                      </ol>
                    </DetailRow>
                  )}
                </React.Fragment>
              );
            })}</tbody>
          </Table></div>
        </>
      )}
    </Section>
  );
}

export default function ChannelsTab(props: TabProps) {
  const { ws, client, range } = props;
  const q = useReportChannels({ ws, client, range });
  const { sorted, sort, toggle } = useSort(q.data?.rows, { key: 'replies_per_100_actions', dir: 'desc' }, ACCESSORS);

  if (q.isLoading) return <TableSkeleton cols={8} rows={4} />;
  if (q.isError) return <RetryError error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data?.rows?.length) return <div className="bg-white border border-gray-200 rounded-xl"><EmptyState icon={<Radio className="w-6 h-6" />} title="No channel activity in this period" description="Connect a LinkedIn, Instagram or WhatsApp account and run a sequence. Each channel's numbers show up here once it sends." /></div>;

  const exportCsv = () => downloadCsv<ReportChannelRow>(csvFileName('channels', range), [
    { header: 'Channel', value: (r) => channelKeyLabel(r.channel) }, { header: 'Accounts', value: (r) => r.senders }, { header: 'Actions', value: (r) => r.actions }, { header: 'New conversations', value: (r) => r.new_chats },
    { header: 'Replies', value: (r) => r.replies }, { header: 'Replies per 100 actions', value: (r) => r.replies_per_100_actions }, { header: 'Reply rate %', value: (r) => r.reply_rate }, { header: 'Interested', value: (r) => r.interested }, { header: 'Blocks', value: (r) => r.blocks },
  ], sorted);
  const th = { sort, onSort: toggle };

  return (
    <div className="space-y-6">
      <Refreshing active={q.isPlaceholderData}>
        <Section title="Channel efficiency"
          description="Instagram and WhatsApp send far less than LinkedIn and convert far better. When a channel's ceiling feels low, the right answer is better targeting, not more accounts."
          actions={<ExportButton onClick={exportCsv} />}>
          <div className="[&_td]:px-3 [&_th]:px-3"><Table>
            <thead><tr>
              <SortTh label="Channel" sortKey="channel" align="left" firstDir="asc" {...th} /><SortTh label="Accounts" sortKey="senders" {...th} /><SortTh label="Actions" sortKey="actions" {...th} />
              <SortTh label="New conversations" sortKey="new_chats" metric="new_chats" {...th} /><SortTh label="Replies" sortKey="replies" metric="replies" {...th} />
              <SortTh label="Replies per 100 actions" sortKey="replies_per_100_actions" metric="replies_per_100_actions" {...th} /><SortTh label="Interested" sortKey="interested" metric="interested" {...th} /><SortTh label="Blocks" sortKey="blocks" metric="blocks" {...th} />
            </tr></thead>
            <tbody>{sorted.map((r) => (
              <tr key={r.channel} className="hover:bg-gray-50">
                <Td className="font-medium text-gray-900">{channelKeyLabel(r.channel)}</Td>
                <Td className="text-right tabular-nums">{fmtInt(r.senders)}</Td>
                <Td className="text-right tabular-nums">{fmtInt(r.actions)}</Td>
                <Td className="text-right tabular-nums">{fmtInt(r.new_chats)}</Td>
                <Td className="text-right"><CountRate count={fmtInt(r.replies)} rate={fmtRate(r.reply_rate)} /></Td>
                <Td className="text-right tabular-nums font-medium text-gray-900">{per100(r.replies_per_100_actions)}</Td>
                <Td className="text-right tabular-nums">{fmtInt(r.interested)}</Td>
                <Td className="text-right tabular-nums">{r.blocks > 0 ? <span className="text-red-700 font-medium">{fmtInt(r.blocks)}</span> : '0'}</Td>
              </tr>
            ))}</tbody>
          </Table></div>
          <p className="text-xs text-gray-400 mt-2">Actions are the metered outbound steps: invitations, new conversations, messages, InMails, emails, likes, comments and follows. Under replies: <MetricLabel metric="reply_rate">reply rate</MetricLabel>.</p>
        </Section>
      </Refreshing>
      <BlocksLog {...props} />
    </div>
  );
}
