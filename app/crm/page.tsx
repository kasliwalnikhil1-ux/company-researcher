'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useStandup } from '@/lib/crm/queries';
import { SCORE_KEYS, fmtMoney, type AttentionDeal, type TodayMeeting } from '@/lib/crm/types';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner, StageBadge, fmtDate, fmtTime, daysAgo, todayISO } from '@/components/crm/ui';
import { CommitmentForm, NextStepModal } from '@/components/crm/forms';
import { cn } from '@/lib/utils';
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, RefreshCw } from 'lucide-react';

// The only screen open during the daily meeting. Yesterday's numbers → today's meetings → stuck/stale/slipping → commitments.
// One screen, internal scrolling per panel, readable across a room.

function Tile({ label, value, avg, warn }: { label: string; value: number; avg: number; warn?: boolean }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2 min-w-0', warn ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white')}>
      <div className="text-[11px] uppercase tracking-wide text-gray-500 truncate">{label}</div>
      <div className="flex items-baseline gap-2">
        <span className={cn('text-3xl font-bold tabular-nums leading-tight', warn ? 'text-red-700' : 'text-gray-900')}>{value}</span>
        <span className="text-xs text-gray-500 tabular-nums">7d avg {avg.toFixed(1)}</span>
      </div>
    </div>
  );
}

function MeetingRow({ m, tz }: { m: TodayMeeting; tz: string }) {
  const [open, setOpen] = useState(false);
  const lastTouch = m.activity_history?.[0];
  return (
    <>
      <tr className={cn('border-b border-gray-100 hover:bg-gray-50 cursor-pointer', m.status !== 'scheduled' && 'opacity-60')} onClick={() => setOpen((o) => !o)}>
        <td className="px-3 py-2 whitespace-nowrap"><div className="text-xl font-bold tabular-nums text-gray-900">{m.local_time}</div>{m.prospect_local_time && <div className="text-[11px] text-gray-500">{m.prospect_local_time}</div>}</td>
        <td className="px-3 py-2"><Link href={`/crm/companies/${m.company.id}`} onClick={(e) => e.stopPropagation()} className="text-base font-semibold text-gray-900 hover:text-indigo-700">{m.company.name}</Link><div className="text-sm text-gray-600">{m.contact?.name ?? '—'}{m.contact?.role ? <span className="text-gray-400"> · {m.contact.role}</span> : null}</div></td>
        <td className="px-3 py-2 text-sm text-gray-600 whitespace-nowrap">{m.icp_segment ?? <span className="text-gray-400">unsegmented</span>}<div className="text-xs text-gray-400">via {m.source_channel ?? '?'}</div></td>
        <td className="px-3 py-2 whitespace-nowrap"><StageBadge stage={m.deal.stage} /><div className="text-sm font-medium text-gray-800 mt-0.5">{fmtMoney(m.deal.value_monthly, m.deal.currency)}<span className="text-gray-400 text-xs">/mo</span>{m.deal.videos_per_month ? <span className="text-xs text-gray-500"> · {m.deal.videos_per_month} vid</span> : null}</div></td>
        <td className="px-3 py-2 text-sm text-gray-600">{m.deal.owner ?? '—'}</td>
        <td className="px-3 py-2 text-sm text-gray-600 max-w-[280px]">{m.last_capture ? <span title={(m.last_capture.pain_points ?? []).join(' | ')}>Last: {m.last_capture.next_step ?? (m.last_capture.no_show_reason ? `no-show — ${m.last_capture.no_show_reason}` : 'captured')}</span> : lastTouch ? <span className="truncate block">{lastTouch.direction === 'inbound' ? '← ' : '→ '}{lastTouch.type}{lastTouch.outcome ? ` [${lastTouch.outcome}]` : ''} · {daysAgo(lastTouch.at)}</span> : <span className="text-gray-400">first touch</span>}</td>
        <td className="px-3 py-2 whitespace-nowrap text-right">
          {m.prior_no_shows > 0 && <Badge tone="red" className="mr-1" title="Prior no-shows for this contact">⚠ {m.prior_no_shows} no-show</Badge>}
          {m.status === 'scheduled' ? <Link href={`/crm/capture?meeting=${m.meeting_id}`} onClick={(e) => e.stopPropagation()}><Button size="xs" variant="secondary"><ClipboardCheck className="w-3 h-3" /> Capture</Button></Link> : <Badge tone={m.status === 'held' ? 'green' : m.status === 'no_show' ? 'red' : 'gray'}>{m.status.replace('_', '-')}</Badge>}
        </td>
      </tr>
      {open && (
        <tr className="bg-gray-50/70 border-b border-gray-100">
          <td colSpan={7} className="px-4 py-3">
            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Company notes</div>
                <p className="text-gray-700 whitespace-pre-wrap">{m.company.notes ?? '—'}</p>
                {m.deal.next_step && <p className="mt-2 text-gray-700"><span className="text-gray-500">Next step:</span> {m.deal.next_step} <span className="text-gray-400">({fmtDate(m.deal.next_step_date)})</span></p>}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Last capture {m.last_capture ? `(${fmtDate(m.last_capture.meeting_at)})` : ''}</div>
                {m.last_capture ? (
                  <ul className="list-disc pl-4 text-gray-700 space-y-0.5">
                    {(m.last_capture.pain_points ?? []).map((p, i) => <li key={i}>“{p}”</li>)}
                    {(m.last_capture.objections ?? []).length ? <li className="text-amber-700">Objections: {(m.last_capture.objections ?? []).join('; ')}</li> : null}
                    {m.last_capture.no_show_reason && <li className="text-red-700">No-show: {m.last_capture.no_show_reason}</li>}
                  </ul>
                ) : <p className="text-gray-400">First meeting</p>}
              </div>
              <div>
                <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">History with {m.contact?.name ?? 'this deal'} ({m.activity_history?.length ?? 0})</div>
                <ul className="space-y-0.5 max-h-40 overflow-auto pr-1">
                  {(m.activity_history ?? []).slice(0, 12).map((a, i) => <li key={i} className="text-gray-700"><span className="text-gray-400 tabular-nums">{fmtDate(a.at, { time: true, tz })}</span> {a.direction === 'inbound' ? '←' : '→'} {a.type}{a.channel ? ` (${a.channel})` : ''}{a.outcome ? ` [${a.outcome}]` : ''}{a.body ? `: ${a.body}` : ''}</li>)}
                  {!(m.activity_history ?? []).length && <li className="text-gray-400">No activity logged yet</li>}
                </ul>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AttentionList({ title, tone, rows, render, onFix }: { title: string; tone: 'amber' | 'red' | 'pink'; rows: AttentionDeal[]; render: (d: AttentionDeal) => React.ReactNode; onFix: (d: AttentionDeal) => void }) {
  const border = { amber: 'border-amber-200', red: 'border-red-200', pink: 'border-pink-200' }[tone];
  return (
    <div className={cn('rounded-lg border bg-white flex flex-col min-h-0', border)}>
      <div className="px-3 py-1.5 border-b border-gray-100 flex items-center justify-between"><span className="text-xs font-semibold uppercase tracking-wide text-gray-600">{title}</span><Badge tone={rows.length ? tone : 'gray'}>{rows.length}</Badge></div>
      <ul className="divide-y divide-gray-100 overflow-auto min-h-0 flex-1">
        {rows.length === 0 && <li className="px-3 py-3 text-sm text-gray-400">None 🎉</li>}
        {rows.map((d) => (
          <li key={d.deal_id} className="px-3 py-1.5 flex items-center gap-2 text-sm">
            <div className="flex-1 min-w-0"><span className="font-medium text-gray-900">{d.company}</span> <span className="text-gray-500">· {d.owner ?? '—'}</span><div className="text-xs text-gray-500 truncate">{render(d)}</div></div>
            <StageBadge stage={d.stage} />
            <Button size="xs" variant="secondary" onClick={() => onFix(d)}>Next step</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StandupPage() {
  const { timezone } = useCrm();
  const [date, setDate] = useState<string>(todayISO());
  const q = useStandup(date);
  const s = q.data;
  const [fix, setFix] = useState<AttentionDeal | null>(null);

  const shift = (n: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); setDate(d.toISOString().slice(0, 10)); };
  const day = s?.scoreboard?.day?.totals; const wk = s?.scoreboard?.trailing_7d?.totals;
  const channelRows = useMemo(() => (s?.scoreboard?.day?.channels ?? []).filter((c) => SCORE_KEYS.some((k) => (c[k.key] as number) > 0)), [s]);

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  if (!s) return <EmptyState title="No data" />;

  return (
    <div className="flex flex-col gap-3 h-[calc(100vh-4.5rem)] min-h-[600px]">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-gray-900">Standup</h1>
          <div className="flex items-center gap-1 text-sm text-gray-600">
            <button className="p-1 rounded hover:bg-gray-100" onClick={() => shift(-1)} aria-label="Previous day"><ChevronLeft className="w-4 h-4" /></button>
            <span className="font-medium tabular-nums">{new Date(`${s.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
            <button className="p-1 rounded hover:bg-gray-100" onClick={() => shift(1)} aria-label="Next day"><ChevronRight className="w-4 h-4" /></button>
            {date !== todayISO() && <Button size="xs" variant="ghost" onClick={() => setDate(todayISO())}>today</Button>}
            <span className="text-xs text-gray-400">· {s.timezone}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {s.uncaptured_meetings.length > 0 && (
            <div className="flex items-center gap-2 text-sm bg-red-50 border border-red-200 text-red-800 rounded-md px-3 py-1.5">
              <AlertTriangle className="w-4 h-4" /> {s.uncaptured_meetings.length} past meeting{s.uncaptured_meetings.length > 1 ? 's' : ''} not captured:
              {s.uncaptured_meetings.slice(0, 3).map((m) => <Link key={m.meeting_id} href={`/crm/capture?meeting=${m.meeting_id}`} className="underline font-medium">{m.company}</Link>)}
              {s.uncaptured_meetings.length > 3 && <Link href="/crm/capture" className="underline">+{s.uncaptured_meetings.length - 3} more</Link>}
            </div>
          )}
          <Button size="sm" variant="ghost" onClick={() => q.refetch()} title="Refresh"><RefreshCw className={cn('w-4 h-4', q.isFetching && 'animate-spin')} /></Button>
        </div>
      </div>

      {/* Yesterday's numbers */}
      <div>
        <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
          {SCORE_KEYS.map((k) => <Tile key={k.key} label={k.label} value={Number(day?.[k.key] ?? 0)} avg={Number(wk?.[k.key] ?? 0) / 7} warn={k.key === 'no_shows' && Number(day?.no_shows ?? 0) >= Math.max(1, Number(day?.meetings_held ?? 0))} />)}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-1 text-xs text-gray-500 px-1">
          <span>Yesterday ({fmtDate(s.scoreboard.date)}) vs trailing 7 days · derived from activities, meetings and stage changes</span>
          {channelRows.map((c) => <span key={c.slug}><span className="font-medium text-gray-700">{c.label}:</span> {SCORE_KEYS.filter((k) => (c[k.key] as number) > 0).map((k) => `${c[k.key]} ${k.short.toLowerCase()}`).join(', ')}</span>)}
        </div>
      </div>

      {/* Meetings + attention */}
      <div className="grid lg:grid-cols-[3fr_2fr] gap-3 min-h-0 flex-1">
        <Card title={`Today's meetings (${s.meetings_today.length})`} dense className="min-h-0">
          <div className="overflow-auto h-full">
            {s.meetings_today.length === 0 ? <EmptyState compact title="No meetings today" description="Book one from a company page." /> : (
              <table className="min-w-full text-sm">
                <tbody>{s.meetings_today.map((m) => <MeetingRow key={m.meeting_id} m={m} tz={timezone} />)}</tbody>
              </table>
            )}
          </div>
        </Card>
        <div className="grid grid-rows-3 gap-2 min-h-0">
          <AttentionList title="Stuck — no next step" tone="amber" rows={s.attention.stuck} render={(d) => `${d.days_in_stage}d in stage · missing ${d.missing}`} onFix={setFix} />
          <AttentionList title={`Stale — ${s.attention.stale_after_days}d without activity`} tone="red" rows={s.attention.stale} render={(d) => `last activity ${d.last_activity_at ? daysAgo(d.last_activity_at) : 'never'} · ${fmtMoney(d.value_monthly, d.currency)}`} onFix={setFix} />
          <AttentionList title="Slipping — next step overdue" tone="pink" rows={s.attention.slipping} render={(d) => `${d.days_late}d late: ${d.next_step} (${fmtDate(d.next_step_date)})`} onFix={setFix} />
        </div>
      </div>

      {/* Commitments */}
      <div className="grid lg:grid-cols-2 gap-3">
        <Card title="Today's commitments">
          <div className="flex flex-wrap gap-2 mb-2">
            {s.commitments_today.length === 0 && <span className="text-sm text-gray-400">Nothing committed yet.</span>}
            {s.commitments_today.map((c) => <div key={c.owner_id} className="text-sm bg-gray-50 border border-gray-200 rounded-md px-2.5 py-1"><span className="font-medium text-gray-900">{c.owner}:</span> {Object.entries(c.targets).map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`).join(', ')}{c.notes ? <span className="text-gray-500"> — {c.notes}</span> : null}</div>)}
          </div>
          <CommitmentForm date={s.date} />
        </Card>
        <Card title="Yesterday: committed vs actual">
          {s.yesterday_commitments.length === 0 ? <span className="text-sm text-gray-400">No commitments were logged for yesterday.</span> : (
            <ul className="space-y-1 text-sm">
              {s.yesterday_commitments.map((r) => (
                <li key={r.owner_id} className="flex flex-wrap items-center gap-x-2">
                  <span className="font-medium text-gray-900 w-28 truncate">{r.owner}</span>
                  <Badge tone={r.all_met ? 'green' : 'red'}>{r.all_met ? 'met all' : `missed ${r.metrics_missed}/${r.metrics_committed}`}</Badge>
                  {Object.entries(r.committed).map(([k, v]) => { const a = r.actual?.[k]; const miss = a != null && a < v; return <span key={k} className={cn('tabular-nums', miss ? 'text-red-700 font-medium' : 'text-gray-700')}>{k.replace(/_/g, ' ')} {a ?? '?'}/{v}</span>; })}
                </li>
              ))}
            </ul>
          )}
          <div className="text-xs text-gray-400 mt-2">Actuals come from the activity log — {fmtTime(new Date().toISOString(), timezone)} {timezone}. Keys: dials, connects, linkedin connects/messages, emails, meetings booked, proposals sent, closes.</div>
        </Card>
      </div>

      <NextStepModal deal={fix ? { id: fix.deal_id, company: fix.company, next_step: fix.next_step, next_step_date: fix.next_step_date } : null} open={!!fix} onClose={() => setFix(null)} />
    </div>
  );
}
