'use client';

// The sequence Analytics tab (PRD "Sequence lead filters, bulk unenroll & Analytics", feature 3): seven sections under
// one date range (default: the last 30 days), every count of sections 1, 2 and 6 opening the Leads tab on the matching
// filter. Below them, the per-channel blocks and A/B tests of the Results report for the same range.
import React, { useMemo, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ExternalLink, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useMembers, useSenders } from '@/lib/outreach/queries';
import { useReportSequence } from '@/lib/outreach/reports';
import { fmtDay, fmtInt, fmtRate } from '@/lib/outreach/reports';
import { parseError } from '@/lib/outreach/api';
import { periodFromString, periodRange, periodToString, type StatsPeriod } from '@/lib/outreach/sequenceStats';
import { PROGRESS_SEGMENTS, type AnalyticsDay, type AnalyticsStep, type LeadFilter, type SequenceAnalytics as Analytics } from '@/lib/outreach/sequenceLeads';
import type { Graph, Sequence, SenderStatus } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, Spinner, StatusPill, Table, Td, Th, fmtDate } from '@/components/outreach/ui';
import { KpiTile, Section } from '@/components/outreach/reports/primitives';
import { MiniBar } from '@/components/outreach/reports/charts';
import SequenceStepTables from '@/components/outreach/reports/SequenceStepTables';
import ChannelBlocks from './ChannelBlocks';
import StatsPeriodPicker from './StatsPeriodPicker';
import { MemberChip } from '@/components/outreach/members';
import { SEQUENCE_LEADS_PAGE, useSequenceAnalytics, useSequenceAnalyticsLeads, type EnrolledRange } from '../hooks';
import type { LeadsLink } from '../leads/SequenceLeads';

const KEY = (id: string) => `outreach-sequence-analytics-period:${id}`;
function readPeriod(id: string): StatsPeriod {
  try { const v = window.sessionStorage.getItem(KEY(id)); return v ? periodFromString(v) : { kind: '30d' }; } catch { return { kind: '30d' }; }
}
const pct = (n: number | null | undefined) => (typeof n === 'number' ? `${Math.round(n)}%` : 'n/a');
/** The step table's hidden Variant column (PRD: room for A/B variants without a redesign). Flip to show it. */
const SHOW_VARIANT_COLUMN = false;

function sentence(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

function ProgressBar({ a, onOpen }: { a: Analytics['progress']; onOpen: (f: LeadFilter) => void }) {
  const total = a.total || 0;
  if (!total) return <p className="text-sm text-gray-500">No lead was enrolled in this period.</p>;
  return (
    <div>
      <div className="flex h-4 rounded-full overflow-hidden bg-gray-100" role="img" aria-label={PROGRESS_SEGMENTS.map((s) => `${s.label} ${a[s.key]}`).join(', ')}>
        {PROGRESS_SEGMENTS.map((s) => a[s.key] > 0 && <span key={s.key} style={{ width: `${(a[s.key] / total) * 100}%`, background: s.color }} title={`${s.label}: ${fmtInt(a[s.key])}`} />)}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 mt-2.5 text-sm">
        {PROGRESS_SEGMENTS.map((s) => (
          <li key={s.key}>
            <button type="button" onClick={() => onOpen(s.filter)} title={`Open the Leads tab on ${s.label}`} className="inline-flex items-center gap-1.5 hover:underline decoration-gray-300 underline-offset-4">
              <span className="w-2.5 h-2.5 rounded-sm" style={{ background: s.color }} aria-hidden /><span className="text-gray-700">{s.label}</span><span className="font-medium text-gray-900 tabular-nums">{fmtInt(a[s.key])}</span>
            </button>
          </li>
        ))}
        <li className="text-gray-500">of {fmtInt(total)} enrolled</li>
      </ul>
    </div>
  );
}

function StepTable({ steps }: { steps: AnalyticsStep[] }) {
  const maxSent = Math.max(0, ...steps.map((s) => s.sent));
  if (!steps.length) return <p className="text-sm text-gray-500">This sequence has no sending steps yet.</p>;
  const isInvite = (s: AnalyticsStep) => s.type === 'send_invite' || s.type === 'follow';
  // read receipts exist only for messages (LinkedIn / Instagram / WhatsApp chats; email opens are not tracked)
  const isMessage = (s: AnalyticsStep) => /message|inmail|chat|voice/.test(s.type);
  return (
    <Table>
      <thead><tr>
        <Th>Step</Th>
        {SHOW_VARIANT_COLUMN && <Th>Variant</Th>}
        <Th className="w-[24%]">Sent</Th>
        <Th className="text-right">Accepted or read</Th>
        <Th className="text-right">Replied</Th>
        <Th className="text-right">Skipped</Th>
        <Th className="text-right">Failed</Th>
      </tr></thead>
      <tbody>{steps.map((s) => (
        <tr key={s.node_id}>
          <Td><div className="font-medium text-gray-900 truncate max-w-[240px]" title={s.label}>{s.step_number ? `${s.step_number}. ` : ''}{sentence(s.label)}</div><div className="text-xs text-gray-500">{s.type.replace(/_/g, ' ')}{s.has_variants ? ' · A/B' : ''}{s.leads_here ? ` · ${fmtInt(s.leads_here)} here now` : ''}</div></Td>
          {SHOW_VARIANT_COLUMN && <Td className="text-xs text-gray-500">{s.variant_id ?? 'All'}</Td>}
          <Td><div className="flex items-center gap-2"><MiniBar value={s.sent} max={maxSent} className="flex-1" /><span className="w-12 text-right tabular-nums text-gray-900">{fmtInt(s.sent)}</span></div></Td>
          <Td className="text-right tabular-nums">{isInvite(s) ? <>{fmtInt(s.accepted)} <span className="text-gray-500">· {fmtRate(s.accepted_rate)}</span></> : isMessage(s) ? <>{fmtInt(s.read)} <span className="text-gray-500">· {fmtRate(s.read_rate)}</span></> : <span className="text-gray-300">—</span>}</Td>
          <Td className="text-right tabular-nums">{fmtInt(s.replied)} <span className="text-gray-500">· {fmtRate(s.replied_rate)}</span></Td>
          <Td className="text-right tabular-nums">{fmtInt(s.skipped)} <span className="text-gray-500">· {fmtRate(s.skipped_rate)}</span></Td>
          <Td className="text-right tabular-nums">{s.failed > 0 ? <span className="text-red-700">{fmtInt(s.failed)} <span className="text-gray-500">· {fmtRate(s.failed_rate)}</span></span> : <span className="text-gray-300">—</span>}</Td>
        </tr>
      ))}</tbody>
    </Table>
  );
}

const GRID = '#eef0f3';
const TICK = { fontSize: 11, fill: '#6b7280' };
function PlannedVsSent({ d }: { d: Analytics['daily'] }) {
  const data = d.days.map((x) => ({ ...x, label: fmtDay(x.day) }));
  const gap = d.gap_pct;
  return (
    <div>
      <div style={{ height: 220 }} role="img" aria-label="Planned actions against actual sends per day">
        <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 600, height: 220 }}>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="day" tickFormatter={(v: string) => fmtDay(v)} tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={28} />
            <YAxis allowDecimals={false} tick={TICK} tickLine={false} axisLine={false} width={40} tickFormatter={(v: number) => fmtInt(v)} />
            <Tooltip cursor={{ fill: '#f3f4f6' }} isAnimationActive={false} content={(p: { active?: boolean; label?: unknown; payload?: ReadonlyArray<{ payload?: AnalyticsDay }> }) => (p?.active && p.payload?.length ? (
              <div className="rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-lg text-xs min-w-[150px]">
                <div className="font-semibold text-gray-900 mb-1">{fmtDay(String(p.label ?? ''), true)}</div>
                <div className="flex justify-between gap-4"><span className="text-gray-600">Planned</span><span className="font-medium tabular-nums">{fmtInt(p.payload[0]?.payload?.planned)}</span></div>
                <div className="flex justify-between gap-4"><span className="text-gray-600">Sent</span><span className="font-medium tabular-nums">{fmtInt(p.payload[0]?.payload?.sent)}</span></div>
                {!p.payload[0]?.payload?.snapshot && <div className="mt-1 pt-1 border-t border-gray-100 text-gray-500">Planned = actions scheduled that day</div>}
              </div>) : null)} />
            <Bar dataKey="planned" name="Planned" fill="#c7d2fe" radius={[3, 3, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="sent" name="Sent" fill="#4f46e5" radius={[3, 3, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-xs text-gray-600">
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-200" />Planned</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-indigo-600" />Sent</span>
        <span className="text-gray-400">·</span>
        <span>Today: <span className="font-medium text-gray-900 tabular-nums">{fmtInt(d.today_sent)}</span> of <span className="font-medium text-gray-900 tabular-nums">{fmtInt(d.today_planned)}</span> planned{gap !== null && gap > 0 ? ` (${Math.round(gap)}% behind)` : ''}</span>
        {d.gap_reason && <span className="inline-flex items-center gap-1 text-amber-800"><AlertTriangle className="w-3.5 h-3.5" /> {d.gap_reason}</span>}
      </div>
    </div>
  );
}

function LeadTable({ sequenceId, range }: { sequenceId: string; range: EnrolledRange }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const senderById = useMemo(() => new Map((senders.data ?? []).map((x) => [x.id, x])), [senders.data]);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [text, setText] = useState('');
  const q = useSequenceAnalyticsLeads(sequenceId, range, page, search);
  const rows = q.data?.rows ?? []; const total = q.data?.total ?? 0; const pageCount = Math.max(1, Math.ceil(total / SEQUENCE_LEADS_PAGE));
  const tick = (at: string | null) => (at ? <span className="inline-flex items-center gap-1 text-green-700" title={fmtDate(at)}><Check className="w-3.5 h-3.5" /><span className="sr-only">yes</span></span> : <span className="text-gray-300">—</span>);
  return (
    <div>
      <form className="mb-3" onSubmit={(e) => { e.preventDefault(); setSearch(text.trim()); setPage(0); }}>
        <input type="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Search by name or company" aria-label="Search leads" className="w-full max-w-xs px-3 py-1.5 text-sm rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
      </form>
      {q.isLoading && !q.data ? <Spinner /> : q.error ? <ErrorBox message={parseError(q.error).message} /> : rows.length === 0 ? <p className="text-sm text-gray-500">No lead matches.</p> : (
        <div className={q.isFetching ? 'opacity-70 transition-opacity' : ''}>
          <Table>
            <thead><tr><Th>Lead</Th><Th>Sender</Th><Th>Step reached</Th><Th>Accepted</Th><Th>Replied</Th><Th>Interested</Th><Th>Meeting</Th><Th>Enrolled</Th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}>
                <Td>
                  {(() => {
                    // Same cell as the Leads tab: the name opens the LinkedIn profile in a new tab, "Lead page" opens the lead.
                    const url = r.lead?.public_identifier ? `https://www.linkedin.com/in/${r.lead.public_identifier}` : null;
                    const name = r.lead?.full_name || r.lead?.public_identifier || 'Lead';
                    return (
                      <div className="flex items-center gap-2 min-w-0">
                        <Avatar src={r.lead?.picture_url} name={name} size={7} />
                        <span className="min-w-0">
                          {url
                            ? <a href={url} target="_blank" rel="noopener noreferrer" title="Open the LinkedIn profile in a new tab" className="font-medium text-gray-900 hover:text-indigo-700 inline-flex items-center gap-1 max-w-[200px]"><span className="truncate">{name}</span><ExternalLink className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /></a>
                            : <Link href={`/outreach/leads/${r.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700 block truncate max-w-[200px]">{name}</Link>}
                          <span className="block text-xs text-gray-500 truncate max-w-[200px]">{r.lead?.company}{r.lead?.company && url ? ' · ' : ''}{url && <Link href={`/outreach/leads/${r.lead_id}`} className="hover:text-indigo-700">Lead page</Link>}</span>
                        </span>
                      </div>
                    );
                  })()}
                </Td>
                <Td className="text-gray-600 whitespace-nowrap">{r.sender?.display_name ? <span className="inline-flex items-center gap-2"><Avatar src={r.sender.id ? senderById.get(r.sender.id)?.picture_url : undefined} name={r.sender.display_name} size={6} />{r.sender.display_name}</span> : '—'}</Td>
                <Td><div className="flex items-center gap-2 min-w-[120px]"><MiniBar value={r.step_reached} max={Math.max(1, r.step_total)} className="flex-1" /><span className="text-xs text-gray-600 whitespace-nowrap"><span className="tabular-nums">{r.step_reached}</span> of <span className="tabular-nums">{r.step_total}</span></span></div></Td>
                <Td>{tick(r.accepted_at)}</Td><Td>{tick(r.replied_at)}</Td><Td>{tick(r.positive_at)}</Td><Td>{tick(r.meeting_at)}</Td>
                <Td className="text-gray-500 whitespace-nowrap text-xs">{fmtDate(r.created_at, false)}</Td>
              </tr>
            ))}</tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-sm text-gray-600">
            <span>Showing <span className="font-medium text-gray-900 tabular-nums">{total === 0 ? 0 : page * SEQUENCE_LEADS_PAGE + 1}–{Math.min(total, (page + 1) * SEQUENCE_LEADS_PAGE)}</span> of <span className="font-medium text-gray-900 tabular-nums">{total.toLocaleString()}</span></span>
            <div className="flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="w-4 h-4" /> Prev</Button>
              <span className="px-2">Page <span className="tabular-nums">{page + 1} / {pageCount}</span></span>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next <ChevronRight className="w-4 h-4" /></Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function SequenceAnalytics({ sequence, graph, canPromote, onOpenLeads }: { sequence: Sequence; graph: Graph | null | undefined; canPromote: boolean; onOpenLeads: (link: LeadsLink) => void }) {
  const { timezone, workspace } = useWorkspace();
  const members = useMembers(workspace?.id);
  const [period, setPeriodState] = useState<StatsPeriod>(() => (typeof window === 'undefined' ? { kind: '30d' } : readPeriod(sequence.id)));
  const setPeriod = (p: StatsPeriod) => { setPeriodState(p); try { window.sessionStorage.setItem(KEY(sequence.id), periodToString(p)); } catch { /* private window */ } };
  // "All time" = since the sequence was created (the RPC's own default is the last 30 days)
  const range: EnrolledRange = useMemo(() => {
    const r = periodRange(period, timezone);
    if (r) return r;
    const today = periodRange({ kind: '7d' }, timezone)!.to;
    return { from: sequence.created_at.slice(0, 10), to: today };
  }, [period, timezone, sequence.created_at]);
  const q = useSequenceAnalytics(sequence.id, range);
  const report = useReportSequence(sequence.id, range);
  const a = q.data;
  const open = (filter: LeadFilter, teammate?: string | null) => onOpenLeads({ filter, from: range.from, to: range.to, teammate: teammate ?? null, nonce: Date.now() });
  const caption = `Leads enrolled ${range.from === range.to ? 'on' : 'between'} ${fmtDay(range.from, true)}${range.from === range.to ? '' : ` and ${fmtDay(range.to, true)}`}, and what happened to them. Steps, sends and team actions are counted in the same window.`;

  return (
    <div className="space-y-5">
      <StatsPeriodPicker value={period} onChange={setPeriod} timezone={timezone} caption={caption} />
      {q.isLoading && !a ? <Spinner className="min-h-[30vh]" /> : q.isError ? <ErrorBox message={parseError(q.error).message} /> : a ? a.empty ? (
        <EmptyState title="Analytics appear after the first step runs." description={sequence.status === 'draft' ? 'Activate the sequence and enrol leads to start.' : 'Nothing has gone out from this sequence yet.'} />
      ) : (
        <div className={cn('space-y-5', q.isPlaceholderData && 'opacity-60 transition-opacity')}>
          {/* 1. stat cards */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <KpiTile label="Enrolled" value={fmtInt(a.cards.enrolled)} sub="in the period" onClick={() => open('all')} />
            <KpiTile label="Invites sent" value={fmtInt(a.cards.invites_sent)} sub={a.cards.contacted ? `${fmtInt(a.cards.contacted)} contacted` : undefined} />
            <KpiTile label="Accepted" value={fmtInt(a.cards.accepted)} sub={`${pct(a.cards.accepted_rate)} of sent`} />
            <KpiTile label="Replied" value={fmtInt(a.cards.replied)} sub={a.cards.invites_sent ? `${pct(a.cards.replied_rate)} of accepted` : `${pct(a.cards.replied_of_contacted_rate)} of contacted`} onClick={() => open('handoff')} />
            <KpiTile label="Interested" value={fmtInt(a.cards.interested)} sub={`${pct(a.cards.interested_rate)} of replied`} />
            <KpiTile label="Meetings" value={fmtInt(a.cards.meetings)} sub="booked" />
          </div>

          {/* 2. lead progress */}
          <Section title="Lead progress" description="Where everyone enrolled in the period is now. Click a group to open it on the Leads tab.">
            <ProgressBar a={a.progress} onOpen={(f) => open(f)} />
          </Section>

          {/* 3. step table */}
          <Section title="Steps" description="Each sending step in the period. Accepted is for invitations and follows; read receipts for messages (people can turn those off).">
            <StepTable steps={a.steps} />
          </Section>

          {/* 4. planned vs sent */}
          <Section title="Planned vs sent" description="Actions the engine had planned for each day against what went out.">
            <PlannedVsSent d={a.daily} />
          </Section>

          {/* 5. senders */}
          <Section title="Sender accounts" description="The accounts that send this sequence. Status is the same as on the Senders page.">
            {a.senders.length === 0 ? <p className="text-sm text-gray-500">No sender has sent for this sequence in the period.</p> : (
              <Table>
                <thead><tr><Th>Sender</Th><Th>Status</Th><Th className="text-right">Actions sent</Th><Th className="text-right">Acceptance</Th><Th className="text-right">Replies</Th><Th className="text-right">Failed</Th><Th className="text-right">Live leads</Th></tr></thead>
                <tbody>{a.senders.map((s) => (
                  <tr key={s.id}>
                    <Td><Link href={`/outreach/senders/${s.id}`} className="font-medium text-gray-900 hover:text-indigo-700">{s.name}</Link>{!s.in_pool && <span className="block text-[11px] text-gray-400">No longer in the pool</span>}</Td>
                    <Td><span className="inline-flex items-center gap-1.5"><StatusPill status={s.status as SenderStatus} reason={s.status_reason} />{s.limited && <Badge tone="amber" className="cursor-help"><span title="Today's invite or message allowance is used up">Limited</span></Badge>}</span></Td>
                    <Td className="text-right tabular-nums">{fmtInt(s.sent)}</Td>
                    <Td className="text-right tabular-nums">{s.invites ? <>{fmtRate(s.accepted_rate)} <span className="text-gray-500">· {fmtInt(s.accepted)} of {fmtInt(s.invites)}</span></> : <span className="text-gray-300">—</span>}</Td>
                    <Td className="text-right tabular-nums">{fmtRate(s.replied_rate)} <span className="text-gray-500">· {fmtInt(s.replied)}</span></Td>
                    <Td className="text-right tabular-nums">{s.failed ? <span className="text-red-700">{fmtInt(s.failed)}</span> : <span className="text-gray-300">—</span>}</Td>
                    <Td className="text-right tabular-nums">{fmtInt(s.live)}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            )}
          </Section>

          {/* 6. team */}
          <Section title="Team" description="What teammates did with this sequence's leads in the period. Handoffs taken = a teammate wrote to a lead after the sequence handed them over.">
            {a.team.length === 0 ? <p className="text-sm text-gray-500">No teammate action in the period.{a.handoffs_untaken > 0 && <> <button type="button" className="underline underline-offset-2 text-indigo-700" onClick={() => open('handoff')}>{fmtInt(a.handoffs_untaken)} handoff{a.handoffs_untaken === 1 ? '' : 's'}</button> nobody has answered yet.</>}</p> : (
              <>
                <Table>
                  <thead><tr><Th>Teammate</Th><Th className="text-right">Handoffs taken</Th><Th className="text-right">Leads stopped</Th><Th className="text-right">Leads unenrolled</Th></tr></thead>
                  <tbody>{a.team.map((t) => (
                    <tr key={t.user_id}>
                      <Td><MemberChip userId={t.user_id} members={members.data} fallback={t.name} /></Td>
                      <Td className="text-right tabular-nums"><button type="button" className="hover:underline decoration-gray-300 underline-offset-4" onClick={() => open('handoff')}>{fmtInt(t.handoffs_taken)}</button></Td>
                      <Td className="text-right tabular-nums"><button type="button" className="hover:underline decoration-gray-300 underline-offset-4" onClick={() => open('stopped_by_teammate', t.user_id)}>{fmtInt(t.stopped)}</button></Td>
                      <Td className="text-right tabular-nums"><button type="button" className="hover:underline decoration-gray-300 underline-offset-4" onClick={() => open('unenrolled')}>{fmtInt(t.unenrolled)}</button></Td>
                    </tr>
                  ))}</tbody>
                </Table>
                {a.handoffs_untaken > 0 && <p className="text-xs text-gray-600 mt-2 inline-flex items-center gap-1"><X className="w-3.5 h-3.5 text-amber-600" /> <button type="button" className="underline underline-offset-2 text-indigo-700" onClick={() => open('handoff')}>{fmtInt(a.handoffs_untaken)} handoff{a.handoffs_untaken === 1 ? '' : 's'}</button> nobody has answered yet.</p>}
              </>
            )}
          </Section>

          {/* 7. lead table */}
          <Section title="Leads" description="Everyone enrolled in the period: how far they got and what they did.">
            <LeadTable sequenceId={sequence.id} range={range} />
          </Section>

          {/* the per-channel blocks and A/B tests of the Results report, same window */}
          {report.data && (
            <Section title="By channel" description="The same leads, per channel: contacted, accepted, messaged, seen, replied.">
              <ChannelBlocks channels={report.data.channels} seenSince={report.data.seen_since} seenPartial={report.data.seen_partial} />
              {report.data.ab_tests.length > 0 && <div className="mt-5"><SequenceStepTables r={report.data} graph={graph} sequenceId={sequence.id} sequenceName={sequence.name} range={range} canPromote={canPromote} only="ab" /></div>}
            </Section>
          )}
        </div>
      ) : null}
    </div>
  );
}
