'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, BarChart3, Building2, Globe, Inbox, MessageSquare, Send } from 'lucide-react';
import { supabase } from '@/utils/supabase/client';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { callFn, parseError } from '@/lib/outreach/api';
import { qk, useChats, useMessages } from '@/lib/outreach/queries';
import { Avatar, Button, Card, EmptyState, ErrorBox, fmtDate, IntentBadge, PageLoader, Spinner, StatusPill, Table, Td, Textarea, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { Client } from '@/lib/outreach/types';
import {
  INTENT_KEYS, INTENT_LABELS, csvFileName, downloadCsv, fmtInt, fmtRate, isIsoDay, presetRange, safeAccent, safeHttpsUrl, totalsCsvColumns, useBranding, useReportClient, useReportIntents, useReportSequences, validRange,
  type DateRange, type IntentRow, type SequenceRow,
} from '@/lib/outreach/reports';
import RangePicker from '@/components/outreach/reports/RangePicker';
import { ActivityOverTime, HeadlineTiles, hasActivity } from '@/components/outreach/reports/OverviewTab';
import { ACCENT, ChartSkeleton, CountRate, ExportButton, KpiTile, MetricLabel, Refreshing, RetryError, Section, TableSkeleton, TilesSkeleton } from '@/components/outreach/reports/primitives';
import { IntentLegend, IntentStackChart } from '@/components/outreach/reports/charts';

const PLATFORM_NAME = 'GrowthxAI';

function ClientReport({ ws, clientId, range }: { ws: string; clientId: string; range: DateRange }) {
  const report = useReportClient(clientId, range);
  const intents = useReportIntents({ ws, client: clientId, range }, 'day');
  const sequences = useReportSequences({ ws, client: clientId, range });
  const top = useMemo(() => [...(sequences.data ?? [])].filter((s) => s.totals.touches + s.totals.invites + s.totals.replies > 0).sort((a, b) => b.totals.replies - a.totals.replies || b.totals.touches - a.totals.touches).slice(0, 8), [sequences.data]);

  const exportSequences = () => downloadCsv<SequenceRow>(csvFileName('client-sequences', range, report.data?.client.name), [{ header: 'Sequence', value: (r) => r.name }, { header: 'Status', value: (r) => r.status }, ...totalsCsvColumns<SequenceRow>((r) => r.totals)], top);
  const exportIntents = () => downloadCsv<IntentRow>(csvFileName('client-replies', range, report.data?.client.name), [{ header: 'Day', value: (r) => r.key }, { header: 'Replies', value: (r) => r.replies }, ...INTENT_KEYS.map((k) => ({ header: INTENT_LABELS[k], value: (r: IntentRow) => r.intents[k] }))], intents.data?.rows ?? []);

  return (
    <div className="space-y-6">
      {report.isLoading ? <><TilesSkeleton /><ChartSkeleton /></> : report.isError ? <RetryError error={report.error} onRetry={() => report.refetch()} /> : !report.data ? null : (
        <Refreshing active={report.isPlaceholderData}>
          <div className="space-y-6">
            <HeadlineTiles report={report.data} />
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <KpiTile label="Leads" value={fmtInt(report.data.leads)} sub="People in this account’s lists" />
              <KpiTile label="Leads in progress" value={fmtInt(report.data.live_enrollments)} sub="Currently inside a sequence" />
              <div className="bg-white border border-gray-200 rounded-xl px-4 py-3.5">
                <div className="text-xs font-medium text-gray-500">Senders</div>
                {!report.data.senders.length ? <div className="text-sm text-gray-500 mt-1">No sender is assigned yet.</div> : (
                  <ul className="mt-1.5 space-y-1">{report.data.senders.slice(0, 4).map((s) => <li key={s.id} className="flex items-center justify-between gap-2 text-sm"><span className="text-gray-900 truncate">{s.name ?? 'Unnamed sender'}</span><StatusPill status={s.status} /></li>)}
                    {report.data.senders.length > 4 && <li className="text-xs text-gray-500">and {report.data.senders.length - 4} more</li>}</ul>
                )}
              </div>
            </div>
            {hasActivity(report.data.totals) ? <ActivityOverTime report={report.data} fileName={csvFileName('client-daily', range, report.data.client.name)} /> : (
              <Section title="Activity over time"><EmptyState icon={<BarChart3 className="w-6 h-6" />} title="Nothing was sent in this period" description="Pick a longer range to see earlier activity." /></Section>
            )}
          </div>
        </Refreshing>
      )}

      {intents.isLoading ? <ChartSkeleton height={240} /> : intents.isError ? <RetryError error={intents.error} onRetry={() => intents.refetch()} /> : !intents.data ? null : (
        <Refreshing active={intents.isPlaceholderData}>
          <Section title="What people answered" description="Each reply is counted once, on the day the person first answered." actions={<ExportButton onClick={exportIntents} disabled={!intents.data.replies} />}>
            {!intents.data.replies ? <EmptyState icon={<MessageSquare className="w-6 h-6" />} title="No replies in this period" description="Replies show up here as soon as people answer. Try a longer range." /> : (
              <>
                <div className="flex flex-wrap gap-x-8 gap-y-2 mb-4">
                  <div><div className="text-xs text-gray-500"><MetricLabel metric="positive_reply_rate">Positive reply rate</MetricLabel></div><div className="text-xl font-semibold text-gray-900 tabular-nums">{fmtRate(intents.data.positive_reply_rate)}</div></div>
                  <div><div className="text-xs text-gray-500"><MetricLabel metric="negative_reply_rate">Negative reply rate</MetricLabel></div><div className="text-xl font-semibold text-gray-900 tabular-nums">{fmtRate(intents.data.negative_reply_rate)}</div></div>
                  <div><div className="text-xs text-gray-500"><MetricLabel metric="replies">Replies</MetricLabel></div><div className="text-xl font-semibold text-gray-900 tabular-nums">{fmtInt(intents.data.replies)}</div></div>
                </div>
                <div className="mb-3"><IntentLegend counts={intents.data.intents} /></div>
                <IntentStackChart rows={intents.data.rows} height={240} />
              </>
            )}
          </Section>
        </Refreshing>
      )}

      {sequences.isLoading ? <TableSkeleton cols={6} rows={4} /> : sequences.isError ? <RetryError error={sequences.error} onRetry={() => sequences.refetch()} /> : (
        <Refreshing active={sequences.isPlaceholderData}>
          <Section title="Top sequences" description="Ordered by replies in this period." actions={<ExportButton onClick={exportSequences} disabled={!top.length} />}>
            {!top.length ? <p className="text-sm text-gray-500">No sequence sent anything in this period.</p> : (
              <Table>
                <thead><tr><Th>Sequence</Th><Th className="text-right"><MetricLabel metric="touches">Touches</MetricLabel></Th><Th className="text-right"><MetricLabel metric="accepted">Accepted</MetricLabel></Th><Th className="text-right"><MetricLabel metric="replies">Replies</MetricLabel></Th><Th className="text-right"><MetricLabel metric="interested">Interested</MetricLabel></Th><Th className="text-right"><MetricLabel metric="meetings">Meetings</MetricLabel></Th></tr></thead>
                <tbody>{top.map((s) => (
                  <tr key={s.sequence_id}>
                    <Td className="font-medium text-gray-900">{s.name}</Td><Td className="text-right tabular-nums">{fmtInt(s.totals.touches)}</Td>
                    <Td className="text-right"><CountRate count={fmtInt(s.totals.accepted)} rate={fmtRate(s.totals.acceptance_rate)} /></Td>
                    <Td className="text-right"><CountRate count={fmtInt(s.totals.replies)} rate={fmtRate(s.totals.reply_rate)} /></Td>
                    <Td className="text-right"><CountRate count={fmtInt(s.totals.interested)} rate={fmtRate(s.totals.positive_reply_rate)} /></Td>
                    <Td className="text-right tabular-nums">{fmtInt(s.totals.meetings)}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Section>
        </Refreshing>
      )}
    </div>
  );
}

function ClientViewerPage() {
  const params = useParams<{ clientId: string }>();
  const clientId = params?.clientId;
  const { workspace, canReply, role } = useWorkspace();
  const ws = workspace?.id;
  const qc = useQueryClient();
  const toast = useToast();
  const router = useRouter(); const pathname = usePathname(); const search = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const timezone = (typeof workspace?.settings?.timezone === 'string' && workspace.settings.timezone) || 'UTC';
  const from = search.get('from'); const to = search.get('to');
  const range: DateRange = useMemo(() => {
    const r = isIsoDay(from) && isIsoDay(to) ? { from, to } : null;
    return r && !validRange(r) ? r : presetRange('30d', timezone);
  }, [from, to, timezone]);
  const setRange = useCallback((r: DateRange) => {
    const next = new URLSearchParams(search.toString()); next.set('from', r.from); next.set('to', r.to);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [search, pathname, router]);

  const branding = useBranding(ws);
  const client = useQuery({ queryKey: ['outreach', 'client', clientId ?? ''], enabled: !!clientId, queryFn: async () => { const { data, error } = await supabase.from('outreach_clients').select('*').eq('id', clientId!).maybeSingle(); if (error) throw parseError(error); return data as Client | null; } });
  const chats = useChats(ws, { client_id: clientId });
  const chat = useMemo(() => (chats.data ?? []).find((c) => c.id === selected) ?? null, [chats.data, selected]);
  const messages = useMessages(selected);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.data?.length, selected]);

  // A client viewer only reads: no replies, no read receipts written on their behalf.
  const isViewer = role === 'client_viewer';
  const mayReply = canReply && !isViewer;

  async function markRead() {
    if (!chat || !chat.unread || isViewer) return;
    await supabase.from('outreach_chats').update({ unread: false, unread_count: 0 }).eq('id', chat.id);
    qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'chats'] });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!chat || !text.trim() || !mayReply) return;
    setSending(true);
    try {
      await callFn('send-reply', { chat_id: chat.id, text: text.trim() });
      setText('');
      qc.invalidateQueries({ queryKey: qk.messages(chat.id) }); qc.invalidateQueries({ queryKey: ['outreach', ws ?? '', 'chats'] });
      toast.show('Reply sent.');
    } catch (er) { toast.show(parseError(er).message, 'error'); }
    finally { setSending(false); }
  }

  if (!clientId) return <ErrorBox message="Missing client." />;
  if (client.isLoading) return <PageLoader />;
  if (client.isError) return <ErrorBox message={(client.error as Error).message} />;
  if (!client.data || !ws || client.data.workspace_id !== ws) return <ErrorBox message="This client is not available in the current workspace." />;
  const c = client.data;

  const b = branding.data ?? {};
  const accent = safeAccent(b.accent);
  const logo = safeHttpsUrl(b.logo_url);
  const helpUrl = safeHttpsUrl(b.help_url);
  const hidePlatform = !!b.hide_platform_name;
  const productName = (b.product_name && b.product_name.trim()) || b.workspace_name || workspace?.name || (hidePlatform ? '' : PLATFORM_NAME);
  const showToast = toast.show;

  return (
    <div style={accent ? ({ '--outreach-accent': accent } as React.CSSProperties) : undefined}>
      <header className="flex flex-wrap items-center justify-between gap-4 mb-5 pb-5 border-b border-gray-200">
        <div className="flex items-center gap-3 min-w-0">
          {!isViewer && <Link href="/outreach/clients" className="p-1.5 rounded-md text-gray-500 hover:bg-gray-100" aria-label="Back to clients"><ArrowLeft className="w-4 h-4" /></Link>}
          {logo ? <img src={logo} alt={productName || 'Logo'} referrerPolicy="no-referrer" className="h-10 w-auto max-w-[160px] object-contain" /> : (
            <div className="w-10 h-10 rounded-xl text-white flex items-center justify-center flex-shrink-0" style={{ background: ACCENT }}><Building2 className="w-5 h-5" /></div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900 truncate">{c.name}</h1>
            <div className="text-xs text-gray-500">{productName ? `Outreach report by ${productName}` : 'Outreach report'}</div>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-gray-500"><Globe className="w-3.5 h-3.5" /> Numbers are in {timezone} time.</span>
      </header>

      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 mb-6">
        <RangePicker value={range} onChange={setRange} timezone={timezone} workspaceId={ws} onNotice={(m, t) => showToast(m, t)} />
      </div>

      <ClientReport ws={ws} clientId={clientId} range={range} />

      <Card className="overflow-hidden mt-6" title={<span className="flex items-center gap-2"><Inbox className="w-4 h-4" /> Conversations</span>} actions={<span className="text-xs text-gray-400">{fmtInt(chats.data?.length ?? 0)} threads</span>}>
        <div className="-m-5 grid grid-cols-1 md:grid-cols-[320px_1fr] min-h-[520px]">
          <div className={cn('border-r border-gray-100 overflow-y-auto max-h-[70vh]', selected && 'hidden md:block')}>
            {chats.isLoading ? <Spinner /> : chats.isError ? <div className="p-4"><ErrorBox message={(chats.error as Error).message} /></div> : !chats.data?.length ? <EmptyState title="No conversations yet" description="Replies to this account’s senders appear here." /> : (
              <ul className="divide-y divide-gray-100">
                {chats.data.map((ch) => (
                  <li key={ch.id}>
                    <button type="button" onClick={() => { setSelected(ch.id); }} className={cn('w-full text-left px-4 py-3 hover:bg-gray-50 flex gap-3', selected === ch.id && 'bg-gray-100')}>
                      <Avatar src={ch.attendee_picture_url ?? ch.outreach_leads?.picture_url} name={ch.attendee_name ?? ch.outreach_leads?.full_name} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2"><span className={cn('text-sm truncate', ch.unread ? 'font-semibold text-gray-900' : 'text-gray-800')}>{ch.attendee_name ?? ch.outreach_leads?.full_name ?? 'Unknown'}</span><span className="text-[11px] text-gray-400 whitespace-nowrap">{timeAgo(ch.last_message_at)}</span></div>
                        <div className="text-xs text-gray-500 truncate">{ch.last_direction === 'out' ? 'You: ' : ''}{ch.last_message_preview ?? ch.subject ?? ''}</div>
                        <div className="flex items-center gap-1.5 mt-1"><IntentBadge intent={ch.intent} />{ch.unread && <span className="w-2 h-2 rounded-full" style={{ background: ACCENT }} aria-label="unread" />}</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className={cn('flex flex-col max-h-[70vh]', !selected && 'hidden md:flex')}>
            {!chat ? <EmptyState title="Select a conversation" description="Pick a thread on the left to read it." /> : (
              <>
                <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-3">
                  <button type="button" className="md:hidden p-1 rounded text-gray-500 hover:bg-gray-100" onClick={() => setSelected(null)} aria-label="Back to list"><ArrowLeft className="w-4 h-4" /></button>
                  <Avatar src={chat.attendee_picture_url ?? chat.outreach_leads?.picture_url} name={chat.attendee_name ?? chat.outreach_leads?.full_name} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold text-gray-900 truncate">{chat.attendee_name ?? chat.outreach_leads?.full_name ?? 'Unknown'}</div>
                    <div className="text-xs text-gray-500 truncate">{chat.outreach_leads?.headline ?? chat.outreach_leads?.company ?? chat.subject ?? ''} · via {chat.outreach_senders?.display_name ?? 'sender'}</div>
                  </div>
                  <IntentBadge intent={chat.intent} />
                </div>
                <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 bg-gray-50/60" onMouseEnter={markRead}>
                  {messages.isLoading ? <Spinner /> : messages.isError ? <ErrorBox message={(messages.error as Error).message} /> : !messages.data?.length ? <div className="text-sm text-gray-400 text-center py-8">No messages.</div> : messages.data.map((m) => (
                    <div key={m.id} className={cn('flex', m.direction === 'out' ? 'justify-end' : 'justify-start')}>
                      <div className={cn('max-w-[80%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap break-words', m.direction === 'out' ? 'text-white rounded-br-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-bl-sm', m.deleted_at && 'opacity-50 italic')} style={m.direction === 'out' ? { background: ACCENT } : undefined}>
                        {m.is_invite_note && <div className={cn('text-[10px] uppercase tracking-wide mb-1', m.direction === 'out' ? 'text-white/70' : 'text-gray-400')}>Invitation note</div>}
                        {m.deleted_at ? 'Message deleted' : m.text ?? (m.attachments?.length ? `${m.attachments.length} attachment(s)` : '')}
                        <div className={cn('text-[10px] mt-1', m.direction === 'out' ? 'text-white/70' : 'text-gray-400')}>{fmtDate(m.sent_at)}{m.edited_at ? ' · edited' : ''}</div>
                      </div>
                    </div>
                  ))}
                  <div ref={bottomRef} />
                </div>
                {mayReply ? (
                  <form onSubmit={send} className="border-t border-gray-100 p-3 flex flex-col gap-2">
                    <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a reply…" disabled={sending} className="min-h-[70px]" aria-label="Reply" hint="Sent from the sender that owns this thread. If that sender is disconnected the reply is refused." />
                    <div className="flex justify-end"><Button type="submit" size="sm" loading={sending} disabled={!text.trim()} style={{ background: ACCENT }}><Send className="w-3.5 h-3.5" /> Send reply</Button></div>
                  </form>
                ) : <div className="border-t border-gray-100 px-4 py-3 text-xs text-gray-500">This view is read-only. Your account manager answers these conversations.</div>}
              </>
            )}
          </div>
        </div>
      </Card>

      <footer className="mt-8 pt-4 border-t border-gray-200 flex flex-wrap items-center justify-between gap-3 text-xs text-gray-500">
        <span>
          {b.support_email ? <>Questions about this report? Write to <a className="underline" href={`mailto:${b.support_email}`}>{b.support_email}</a>.</> : productName ? `Report prepared by ${productName}.` : ''}
          {helpUrl && <> <a className="underline ml-2" href={helpUrl} target="_blank" rel="noopener noreferrer">Help</a></>}
        </span>
        {!hidePlatform && <span className="text-gray-400">Powered by {PLATFORM_NAME}</span>}
      </footer>
      {toast.node}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><ClientViewerPage /></Suspense>;
}
