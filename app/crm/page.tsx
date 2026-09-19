'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useStandup } from '@/lib/crm/queries';
import { SCORE_KEYS, fmtMoney, type AttentionDeal, type TodayMeeting } from '@/lib/crm/types';
import { Badge, Button, Card, EmptyState, ErrorBox, Spinner, StageBadge, fmtDate, fmtTime, daysAgo, todayISO, addDaysISO } from '@/components/crm/ui';
import { CommitmentForm, NextStepModal } from '@/components/crm/forms';
import { cn } from '@/lib/utils';
import { AlertTriangle, ChevronLeft, ChevronRight, ClipboardCheck, RefreshCw } from 'lucide-react';

// The only screen open during the daily meeting. Yesterday's numbers → today's meetings → stuck/stale/slipping → commitments.
// Tall middle row with internal scrolling per panel (commitments sit below it), readable across a room.

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

type AttentionTone = 'amber' | 'red' | 'pink';
interface AttentionGroup { key: string; label: string; hint: string; tone: AttentionTone; rows: AttentionDeal[]; render: (d: AttentionDeal) => React.ReactNode }

const ATTENTION_TONE: Record<AttentionTone, { stripe: string; head: string; tabOn: string }> = {
  amber: { stripe: 'border-l-amber-400', head: 'bg-amber-50 text-amber-800', tabOn: 'bg-amber-100 text-amber-900 border-amber-300' },
  red: { stripe: 'border-l-red-400', head: 'bg-red-50 text-red-800', tabOn: 'bg-red-100 text-red-900 border-red-300' },
  pink: { stripe: 'border-l-pink-400', head: 'bg-pink-50 text-pink-800', tabOn: 'bg-pink-100 text-pink-900 border-pink-300' },
};

// One panel for stuck/stale/slipping: count tabs on top, one scrolling list with sticky group headers.
function AttentionPanel({ groups, onFix }: { groups: AttentionGroup[]; onFix: (d: AttentionDeal) => void }) {
  const [tab, setTab] = useState<string>('all');
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const shown = tab === 'all' ? groups.filter((g) => g.rows.length > 0) : groups.filter((g) => g.key === tab);
  const tabCls = (on: boolean, onCls: string) => cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors', on ? onCls : 'border-transparent text-gray-600 hover:bg-gray-100');
  return (
    <div className="rounded-lg border border-gray-200 bg-white flex flex-col min-h-0 max-lg:max-h-[80vh]">
      <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-1 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600 mr-auto">Needs attention</span>
        <button className={tabCls(tab === 'all', 'bg-gray-100 text-gray-900 border-gray-300')} onClick={() => setTab('all')}>All <span className="tabular-nums font-bold">{total}</span></button>
        {groups.map((g) => (
          <button key={g.key} className={tabCls(tab === g.key, ATTENTION_TONE[g.tone].tabOn)} onClick={() => setTab(g.key)} title={g.hint}>
            {g.label} <span className="tabular-nums font-bold">{g.rows.length}</span>
          </button>
        ))}
      </div>
      <div className="overflow-auto min-h-0 flex-1">
        {shown.length === 0 || shown.every((g) => g.rows.length === 0) ? (
          <div className="px-3 py-6 text-sm text-gray-400 text-center">{tab === 'all' ? 'Nothing needs attention 🎉' : 'None 🎉'}</div>
        ) : shown.map((g) => (
          <section key={g.key}>
            <div className={cn('sticky top-0 z-10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide flex items-center justify-between', ATTENTION_TONE[g.tone].head)}>
              <span>{g.label} <span className="font-normal normal-case tracking-normal opacity-80">— {g.hint}</span></span>
              <span className="tabular-nums">{g.rows.length}</span>
            </div>
            <ul className="divide-y divide-gray-100">
              {g.rows.map((d) => (
                <li key={d.deal_id} className={cn('pl-2.5 pr-3 py-2 flex items-center gap-2 text-sm border-l-[3px] hover:bg-gray-50', ATTENTION_TONE[g.tone].stripe)}>
                  <div className="flex-1 min-w-0">
                    <div className="truncate"><span className="font-semibold text-gray-900">{d.company}</span> <span className="text-gray-500">· {d.owner ?? '—'}</span></div>
                    <div className="text-xs text-gray-600 line-clamp-2">{g.render(d)}</div>
                  </div>
                  <StageBadge stage={d.stage} />
                  <Button size="xs" variant="secondary" className="shrink-0" onClick={() => onFix(d)}>Next step</Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

export default function StandupPage() {
  const { timezone } = useCrm();
  const [date, setDate] = useState<string>(todayISO());
  const q = useStandup(date);
  const s = q.data;
  const [fix, setFix] = useState<AttentionDeal | null>(null);
  const [dueTab, setDueTab] = useState<'today' | 'week' | 'next'>('today');

  const shift = (n: number) => { const d = new Date(`${date}T00:00:00`); d.setDate(d.getDate() + n); setDate(d.toISOString().slice(0, 10)); };
  const day = s?.scoreboard?.day?.totals; const wk = s?.scoreboard?.trailing_7d?.totals;
  const channelRows = useMemo(() => (s?.scoreboard?.day?.channels ?? []).filter((c) => SCORE_KEYS.some((k) => (c[k.key] as number) > 0)), [s]);

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;
  if (!s) return <EmptyState title="No data" />;
  // Next steps: the standup day / the rest of its week (to Sunday) / the week after. Overdue ones live under Slipping.
  const upcoming = s.next_steps_upcoming ?? s.next_steps_today ?? [];
  const weekEnd = addDaysISO(6, s.week_start ?? s.date); const nextWeekEnd = addDaysISO(13, s.week_start ?? s.date);
  const inRange = (from: string, to: string) => upcoming.filter((d) => !!d.next_step_date && d.next_step_date >= from && d.next_step_date <= to);
  const dueTabs = [
    { key: 'today' as const, label: s.date === todayISO() ? 'Today' : fmtDate(s.date), hint: 'Due on the standup day', rows: inRange(s.date, s.date) },
    { key: 'week' as const, label: 'This week', hint: `Through ${fmtDate(weekEnd)}`, rows: inRange(s.date, weekEnd) },
    { key: 'next' as const, label: 'Next week', hint: `${fmtDate(addDaysISO(1, weekEnd))} – ${fmtDate(nextWeekEnd)}`, rows: inRange(addDaysISO(1, weekEnd), nextWeekEnd) },
  ];
  const due = dueTabs.find((t) => t.key === dueTab)!.rows;

  return (
    <div className="flex flex-col gap-3">
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
      <div className="grid lg:grid-cols-[3fr_2fr] gap-3 lg:h-[78vh] lg:min-h-[620px]">
        <div className="flex flex-col gap-3 min-h-0 max-lg:h-[80vh]">
          <Card title={`Today's meetings (${s.meetings_today.length})`} dense className="min-h-0 max-h-[50%] shrink-0">
            <div className="overflow-auto h-full">
              {s.meetings_today.length === 0 ? <EmptyState compact title="No meetings today" description="Book one from a company page." /> : (
                <table className="min-w-full text-sm">
                  <tbody>{s.meetings_today.map((m) => <MeetingRow key={m.meeting_id} m={m} tz={timezone} />)}</tbody>
                </table>
              )}
            </div>
          </Card>
          <Card title={`Next steps due (${due.length})`} dense className="min-h-0 flex-1"
            actions={<div className="flex items-center gap-0.5">{dueTabs.map((t) => <button key={t.key} onClick={() => setDueTab(t.key)} title={t.hint} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium transition-colors', dueTab === t.key ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'border-transparent text-gray-600 hover:bg-gray-100')}>{t.label} <span className="tabular-nums font-bold">{t.rows.length}</span></button>)}</div>}>
            <div className="overflow-auto h-full">
              {due.length === 0 ? <div className="px-3 py-3 text-sm text-gray-400">No next steps due {dueTab === 'today' ? (s.date === todayISO() ? 'today' : `on ${fmtDate(s.date)}`) : dueTab === 'week' ? 'in the rest of this week' : 'next week'}.</div> : (
                <ul className="divide-y divide-gray-100">
                  {due.map((d) => (
                    <li key={d.deal_id} className="px-3 py-2 flex items-center gap-2 text-sm hover:bg-gray-50">
                      {dueTab !== 'today' && <div className="w-16 shrink-0 text-xs tabular-nums text-gray-500">{d.next_step_date === s.date ? <span className="font-semibold text-indigo-700">{s.date === todayISO() ? 'Today' : fmtDate(s.date)}</span> : d.next_step_date ? new Date(`${d.next_step_date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '—'}</div>}
                      <div className="flex-1 min-w-0">
                        <div className="truncate"><Link href={`/crm/companies/${d.company_id}`} className="font-semibold text-gray-900 hover:text-indigo-700">{d.company}</Link> <span className="text-gray-500">· {d.owner ?? '—'}</span></div>
                        <div className="text-xs text-gray-600 line-clamp-2">{d.next_step ?? <span className="text-amber-700">date set, no step written</span>}</div>
                      </div>
                      <StageBadge stage={d.stage} />
                      <Button size="xs" variant="secondary" className="shrink-0" onClick={() => setFix(d)}>Next step</Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
        <AttentionPanel
          onFix={setFix}
          groups={[
            { key: 'stuck', label: 'Stuck', hint: 'no next step', tone: 'amber', rows: s.attention.stuck, render: (d) => `${d.days_in_stage}d in stage · missing ${d.missing}` },
            { key: 'stale', label: 'Stale', hint: `${s.attention.stale_after_days}d without activity`, tone: 'red', rows: s.attention.stale, render: (d) => `last activity ${d.last_activity_at ? daysAgo(d.last_activity_at) : 'never'} · ${fmtMoney(d.value_monthly, d.currency)}` },
            { key: 'slipping', label: 'Slipping', hint: 'next step overdue', tone: 'pink', rows: s.attention.slipping, render: (d) => <><span className="font-medium text-pink-700">{d.days_late}d late</span> · {d.next_step} <span className="text-gray-400">({fmtDate(d.next_step_date)})</span></> },
          ]}
        />
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
