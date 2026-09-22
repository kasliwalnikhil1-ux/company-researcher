'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useCoachingList } from '@/lib/crm/queries';
import { RATING_LABELS, READINESS_LABELS, STAGE_LABELS, type CoachRollupRow, type CoachingListRow, type ReadinessStage } from '@/lib/crm/types';
import { Badge, Card, CompanyLogo, EmptyState, ErrorBox, Input, PageHeader, Select, Spinner, Table, Td, Th, TimeRangeFilter, fmtDate, timeWindow, type TimeFilter } from '@/components/crm/ui';
import { LensDots, ReadinessBadge, ScoreRing } from '@/components/crm/coaching';
import { TranscriptModal } from '@/components/crm/transcript';
import { GraduationCap, Search, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

// Sales Coach: every coached call (execution score, readiness, the biggest miss, the 1–3 priorities) and what repeats across
// them — the criteria the team keeps missing, per owner over time. Coaching is written by Claude through the crm skill after
// each recording capture (save_call_coaching); this screen only reads. Click a call to open its report on the transcript.

const READINESS_ORDER: ReadinessStage[] = ['ready', 'advancing', 'early', 'price_blocked', 'not_a_fit', 'unknown'];

/** Stacked met / partly / missed bar for one criterion across the filtered calls. */
function RollupBar({ r }: { r: CoachRollupRow }) {
  const n = r.met + r.partial + r.missed;
  const pct = (v: number) => (n ? `${(100 * v) / n}%` : '0%');
  return (
    <div className="py-1.5">
      <div className="flex items-center justify-between gap-2 text-xs"><span className="text-gray-800 truncate">{r.label}</span><span className="text-gray-500 tabular-nums shrink-0">{r.missed ? <span className="text-red-700">{r.missed} missed</span> : null}{r.missed && r.partial ? ' · ' : ''}{r.partial ? <span className="text-amber-700">{r.partial} partly</span> : null}{!r.missed && !r.partial ? <span className="text-green-700">{r.met ? `${r.met} met` : '—'}</span> : null}</span></div>
      <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden flex" title={`${r.met} met · ${r.partial} partly met · ${r.missed} missed${r.na ? ` · ${r.na} n/a` : ''}${r.insufficient ? ` · ${r.insufficient} insufficient evidence` : ''}`}>
        <div className="bg-green-500 h-full" style={{ width: pct(r.met) }} /><div className="bg-amber-400 h-full" style={{ width: pct(r.partial) }} /><div className="bg-red-500 h-full" style={{ width: pct(r.missed) }} />
      </div>
    </div>
  );
}

/** Scores over time for one owner (oldest → newest). */
function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length < 2) return <span className={cn('text-[11px] text-gray-400', className)}>{values.length === 1 ? 'first call' : ''}</span>;
  const w = 72, h = 20, step = w / (values.length - 1);
  const pts = values.map((v, i) => `${i * step},${h - (h * v) / 100}`).join(' ');
  return <svg width={w} height={h} className={className}><polyline points={pts} fill="none" stroke="#4f46e5" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export default function CoachPage() {
  const { activeMembers } = useCrm();
  const [owner, setOwner] = useState('');
  const [time, setTime] = useState<TimeFilter>({ range: '' });
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const w = timeWindow(time);
  const q = useCoachingList({ owner: owner || undefined, from: w.from, to: w.to, limit: 200 });
  const d = q.data;

  const needle = find.trim().toLowerCase();
  const calls = useMemo(() => (d?.calls ?? []).filter((c) => !needle || c.company.toLowerCase().includes(needle) || (c.contact ?? '').toLowerCase().includes(needle) || (c.purpose ?? '').toLowerCase().includes(needle)), [d, needle]);
  const weakest = useMemo(() => [...(d?.rollup.criteria ?? [])].sort((a, b) => (b.missed * 2 + b.partial) - (a.missed * 2 + a.partial)), [d]);
  const byOwnerScores = useMemo(() => {
    const m = new Map<string, number[]>();
    [...(d?.calls ?? [])].sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).forEach((c) => { if (c.execution_score != null) m.set(c.owner_id ?? '', [...(m.get(c.owner_id ?? '') ?? []), c.execution_score]); });
    return m;
  }, [d]);
  const readinessMix = READINESS_ORDER.filter((k) => (d?.rollup.readiness?.[k] ?? 0) > 0);

  return (
    <div className="space-y-3">
      <PageHeader title="Sales Coach" subtitle="Every coached call: what happened, the one moment to handle better, the next action for that buyer — and what repeats across calls. Claude writes a report after each recording; click a call to read it." />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem]"><Search className="w-3.5 h-3.5 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" /><Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Company, contact, purpose…" className="pl-8" /></div>
        <Select value={owner} onChange={(e) => setOwner(e.target.value)} className="w-44"><option value="">Every owner</option>{activeMembers.map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name}</option>)}</Select>
        <TimeRangeFilter label="Call date" value={time} onChange={setTime} />
        {q.isFetching && <Spinner className="w-4 h-4" />}
      </div>

      {q.isError && <ErrorBox message={(q.error as Error).message} />}
      {q.isLoading && <Spinner className="py-16" />}

      {d && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Card dense className="px-3 py-2.5"><div className="text-[11px] uppercase tracking-wide text-gray-500">Coached calls</div><div className="text-2xl font-semibold text-gray-900 tabular-nums">{d.total}</div><div className="text-[11px] text-gray-500">{d.uncoached.length ? `${d.uncoached.length} with a transcript still to coach` : 'every transcript is coached'}</div></Card>
            <Card dense className="px-3 py-2.5 flex items-center gap-3"><ScoreRing score={d.avg_score} size={48} /><div><div className="text-[11px] uppercase tracking-wide text-gray-500">Average execution</div><div className="text-xs text-gray-600">met + partly met ÷ 2, over what applied</div></div></Card>
            <Card dense className="px-3 py-2.5"><div className="text-[11px] uppercase tracking-wide text-gray-500">Deal readiness</div><div className="flex flex-wrap gap-1 mt-1">{readinessMix.length ? readinessMix.map((k) => <Badge key={k} tone={k === 'ready' ? 'green' : k === 'advancing' ? 'indigo' : k === 'early' ? 'blue' : k === 'price_blocked' ? 'amber' : k === 'not_a_fit' ? 'red' : 'gray'}>{d.rollup.readiness[k]} {READINESS_LABELS[k]}</Badge>) : <span className="text-xs text-gray-400">—</span>}</div></Card>
            <Card dense className="px-3 py-2.5"><div className="text-[11px] uppercase tracking-wide text-gray-500">Weakest criterion</div>{weakest[0] && weakest[0].missed + weakest[0].partial > 0 ? <><div className="text-sm font-semibold text-gray-900 leading-tight mt-0.5">{weakest[0].label}</div><div className="text-[11px] text-gray-500">missed on {weakest[0].missed} of {weakest[0].met + weakest[0].partial + weakest[0].missed} calls where it applied</div></> : <div className="text-xs text-gray-400 mt-1">nothing missed yet</div>}</Card>
          </div>

          <div className="grid lg:grid-cols-[1fr_20rem] gap-3 items-start">
            <div className="space-y-3 min-w-0">
              <Card dense title={<>Coached calls <span className="text-gray-400 font-normal">· {calls.length}</span></>}>
                {calls.length === 0 ? (
                  <div className="p-4"><EmptyState compact icon={<GraduationCap className="w-5 h-5 text-indigo-500" />} title="No coached calls yet" description="After a recording is captured, Claude coaches it through the crm skill (or ask: “coach the elev8 call”). Reports land here." /></div>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <thead><tr><Th>When</Th><Th>Call</Th><Th className="text-center">Execution</Th><Th>Deal</Th><Th>Biggest miss · priorities</Th></tr></thead>
                      <tbody>
                        {calls.map((c: CoachingListRow) => (
                          <tr key={c.meeting_id} onClick={() => setOpen(c.meeting_id)} className="cursor-pointer hover:bg-indigo-50/40 align-top">
                            <Td className="whitespace-nowrap text-gray-600">{fmtDate(c.scheduled_at, { time: true })}<div className="text-[11px] text-gray-400">{c.duration_seconds ? `${Math.round(c.duration_seconds / 60)} min · ` : ''}{c.owner ?? '—'}</div></Td>
                            <Td className="min-w-[12rem]">
                              <div className="flex items-start gap-2 min-w-0"><CompanyLogo name={c.company} size="xs" className="mt-0.5" /><div className="min-w-0"><Link href={`/crm/companies/${c.company_id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-gray-900 hover:text-indigo-700">{c.company}</Link>{c.contact && <span className="text-gray-500"> · {c.contact}</span>}<div className="text-[11px] text-gray-500 line-clamp-2">{c.purpose ?? ''}</div></div></div>
                            </Td>
                            <Td><div className="flex flex-col items-center gap-1" title={c.counts ? `${c.counts.met} met · ${c.counts.partial} partly met · ${c.counts.missed} missed` : undefined}><ScoreRing score={c.execution_score} size={40} /><LensDots lens={c.lens} /></div></Td>
                            <Td className="whitespace-nowrap"><div className="space-y-0.5"><ReadinessBadge r={c.readiness} withInterest={false} />{c.readiness?.interest && c.readiness.interest !== 'unknown' && <div className="text-[11px] text-gray-500">buyer {c.readiness.interest}</div>}<div className="text-[11px] text-gray-400">{STAGE_LABELS[c.deal_stage]}</div></div></Td>
                            <Td className="min-w-[15rem]"><div className="text-gray-900 font-medium leading-snug">{c.biggest_miss ?? '—'}</div><ol className="list-decimal pl-4 text-xs text-gray-600 space-y-0.5 mt-1">{(c.priorities ?? []).map((p, i) => <li key={i} title={p}>{p}</li>)}</ol></Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                )}
              </Card>

              {d.uncoached.length > 0 && (
                <Card dense title={<>Transcripts not coached yet <span className="text-gray-400 font-normal">· {d.uncoached.length}</span></>}>
                  <ul className="divide-y divide-gray-100">
                    {d.uncoached.map((u) => (
                      <li key={u.meeting_id} className="px-3 py-2 text-sm flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-gray-500 tabular-nums">{fmtDate(u.scheduled_at, { time: true })}</span>
                        <Link href={`/crm/companies/${u.company_id}`} className="font-medium text-gray-900 hover:text-indigo-700">{u.company}</Link>{u.contact && <span className="text-gray-500">· {u.contact}</span>}{u.owner && <span className="text-gray-400 text-xs">· {u.owner}</span>}
                        <span className="ml-auto text-[11px] text-gray-500 flex items-center gap-1"><Sparkles className="w-3 h-3 text-indigo-500" /> In Claude: “coach the {u.company} call”</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>

            <div className="space-y-3">
              <Card dense title="What repeats" className="px-3 pb-1">
                {d.total === 0 ? <div className="text-xs text-gray-400 py-3">Patterns appear once calls are coached.</div> : (
                  <>
                    <div className="text-[11px] text-gray-500 py-1.5">Each criterion across the {d.total} call{d.total === 1 ? '' : 's'} shown — the mostly-red ones are the process weakness, not one bad call.</div>
                    <div className="divide-y divide-gray-100">{weakest.map((r) => <RollupBar key={r.key} r={r} />)}</div>
                  </>
                )}
              </Card>
              {d.total > 0 && (
                <Card dense title="The four Kaptured questions" className="px-3 pb-1">
                  <div className="divide-y divide-gray-100">{d.rollup.lens.map((r) => <RollupBar key={r.key} r={r} />)}</div>
                  <div className="text-[11px] text-gray-400 py-1.5">{Object.entries(RATING_LABELS).map(([k, v]) => v).slice(0, 3).join(' · ')}</div>
                </Card>
              )}
              {d.rollup.by_owner.length > 0 && (
                <Card dense title="By salesperson" className="px-3 pb-1">
                  <ul className="divide-y divide-gray-100">
                    {d.rollup.by_owner.map((o) => (
                      <li key={o.owner_id ?? 'none'} className="py-2 flex items-center gap-3 text-xs">
                        <div className="flex-1 min-w-0"><div className="font-medium text-gray-900 truncate">{o.owner ?? '—'}</div><div className="text-gray-500">{o.calls} call{o.calls === 1 ? '' : 's'} · avg {o.avg_score ?? '—'}</div></div>
                        <Sparkline values={byOwnerScores.get(o.owner_id ?? '') ?? []} />
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
            </div>
          </div>
        </>
      )}

      <TranscriptModal meetingId={open} initialTab="coach" onClose={() => setOpen(null)} />
    </div>
  );
}
