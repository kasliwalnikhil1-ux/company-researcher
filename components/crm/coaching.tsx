'use client';

import { useState, type ReactNode } from 'react';
import { RATING_LABELS, READINESS_LABELS, type CoachEvidence, type CoachRating, type CoachReadiness, type CoachCounts, type Coaching, type CoachLens } from '@/lib/crm/types';
import { Badge, Button, EmptyState, type Tone } from './ui';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Copy, Dumbbell, HelpCircle, ListChecks, Play, Sparkles, ThumbsUp } from 'lucide-react';
import { cn } from '@/lib/utils';

// The sales coach report for one call, as written by the crm skill (save_call_coaching) and read back with get_coaching.
// Short report first (what the salesperson should read in two minutes), the full analysis folded below it.
// Every timestamp is a button when a player is on the page (onSeek) — the coaching is only as good as the moment it points at.

export const clockS = (s: number | null | undefined) => { if (s == null) return ''; const t = Math.floor(s); const h = Math.floor(t / 3600); const mm = String(Math.floor((t % 3600) / 60)).padStart(h ? 2 : 1, '0'); return `${h ? `${h}:` : ''}${mm}:${String(t % 60).padStart(2, '0')}`; };

const RATING_TONE: Record<CoachRating, Tone> = { met: 'green', partial: 'amber', missed: 'red', na: 'gray', insufficient: 'blue' };
const RATING_DOT: Record<CoachRating, string> = { met: 'bg-green-500', partial: 'bg-amber-400', missed: 'bg-red-500', na: 'bg-gray-300', insufficient: 'bg-blue-300' };
const READINESS_TONE: Record<CoachReadiness['stage'], Tone> = { not_a_fit: 'red', early: 'blue', price_blocked: 'amber', advancing: 'indigo', ready: 'green', unknown: 'gray' };
const INTEREST_LABEL = { polite: 'polite', interested: 'interested', committed: 'committed', unknown: 'interest unknown' } as const;
const STATUS_TONE = { confirmed: 'green', unclear: 'amber', not_discussed: 'gray' } as const satisfies Record<string, Tone>;
const STATUS_LABEL = { confirmed: 'Confirmed', unclear: 'Unclear', not_discussed: 'Not discussed' } as const;
const BRIEF_LABELS: Record<string, string> = { problem: 'Problem', desired_outcome: 'Desired outcome', scope: 'Scope', deadline: 'Deadline', awareness: 'Awareness', decision_process: 'Decision process', budget: 'Budget' };

export function RatingBadge({ rating, className }: { rating: CoachRating; className?: string }) {
  return <Badge tone={RATING_TONE[rating]} className={className}>{RATING_LABELS[rating]}</Badge>;
}

export function ReadinessBadge({ r, withInterest = true }: { r: CoachReadiness | null | undefined; withInterest?: boolean }) {
  if (!r) return null;
  return <span className="inline-flex items-center gap-1"><Badge tone={READINESS_TONE[r.stage] ?? 'gray'}>{READINESS_LABELS[r.stage] ?? r.stage}</Badge>{withInterest && r.interest && r.interest !== 'unknown' && <span className="text-[11px] text-gray-500">buyer {INTEREST_LABEL[r.interest]}</span>}</span>;
}

/** Execution score as a small ring. Green ≥ 70, amber ≥ 45, red below — the thresholds are a reading aid, not a rule. */
export function ScoreRing({ score, size = 56, className }: { score: number | null | undefined; size?: number; className?: string }) {
  const r = (size - 6) / 2, c = 2 * Math.PI * r;
  const v = score ?? 0;
  const color = score == null ? '#d1d5db' : score >= 70 ? '#16a34a' : score >= 45 ? '#d97706' : '#dc2626';
  return (
    <div className={cn('relative shrink-0', className)} style={{ width: size, height: size }} title="Execution score: (met + partly met ÷ 2) over the criteria that applied">
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#e5e7eb" strokeWidth={5} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums text-gray-900">{score ?? '—'}</div>
    </div>
  );
}

export function CountsLine({ counts }: { counts: CoachCounts | null | undefined }) {
  if (!counts) return null;
  return <span className="text-[11px] text-gray-500 tabular-nums"><span className="text-green-700">{counts.met} met</span> · <span className="text-amber-700">{counts.partial} partly</span> · <span className="text-red-700">{counts.missed} missed</span>{counts.na ? ` · ${counts.na} n/a` : ''}{counts.insufficient ? ` · ${counts.insufficient} unclear` : ''}</span>;
}

/** The four Kaptured questions as dots — enough for a table row. */
export function LensDots({ lens }: { lens: CoachLens[] | null | undefined }) {
  if (!lens?.length) return null;
  return <span className="inline-flex items-center gap-1">{lens.map((l) => <span key={l.key} title={`${l.label}: ${RATING_LABELS[l.rating]}${l.note ? ` — ${l.note}` : ''}`} className={cn('w-2.5 h-2.5 rounded-full', RATING_DOT[l.rating])} />)}</span>;
}

function TimeButton({ t, onSeek, className }: { t: number | null | undefined; onSeek?: (s: number) => void; className?: string }) {
  if (t == null) return null;
  if (!onSeek) return <span className={cn('text-[11px] tabular-nums text-gray-500', className)}>{clockS(t)}</span>;
  return <button onClick={() => onSeek(t)} title="Play this moment" className={cn('inline-flex items-center gap-0.5 text-[11px] tabular-nums text-indigo-600 hover:text-indigo-800 hover:underline', className)}><Play className="w-3 h-3" />{clockS(t)}</button>;
}

function Quote({ e, onSeek }: { e: CoachEvidence; onSeek?: (s: number) => void }) {
  return (
    <div className={cn('text-xs rounded-md px-2.5 py-1.5 border-l-2', e.speaker === 'team' ? 'bg-indigo-50/60 border-indigo-300' : 'bg-green-50/70 border-green-400')}>
      <div className="flex items-center gap-2 mb-0.5"><TimeButton t={e.t} onSeek={onSeek} /><span className={cn('font-medium', e.speaker === 'team' ? 'text-indigo-700' : 'text-green-800')}>{e.speaker === 'team' ? 'Us' : e.speaker === 'prospect' ? 'Buyer' : ''}</span></div>
      <div className="text-gray-800">“{e.quote}”</div>
    </div>
  );
}

function Section({ icon, title, children, tone = 'gray', className }: { icon?: ReactNode; title: ReactNode; children: ReactNode; tone?: 'gray' | 'amber' | 'green' | 'indigo'; className?: string }) {
  const tones = { gray: 'border-gray-200 bg-white', amber: 'border-amber-200 bg-amber-50/40', green: 'border-green-200 bg-green-50/30', indigo: 'border-indigo-200 bg-indigo-50/30' };
  return (
    <section className={cn('rounded-lg border p-3', tones[tone], className)}>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-gray-700 flex items-center gap-1.5 mb-2">{icon}{title}</h4>
      {children}
    </section>
  );
}

function Better({ text }: { text: string | null | undefined }) {
  if (!text) return null;
  return <div className="text-xs rounded-md bg-white border border-green-200 px-2.5 py-1.5 mt-1.5"><span className="font-medium text-green-800">Better: </span><span className="text-gray-800">{text}</span></div>;
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return <Button size="xs" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(text); setOk(true); setTimeout(() => setOk(false), 1500); }}>{ok ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />} {ok ? 'Copied' : 'Copy draft'}</Button>;
}

function Fold({ title, count, children, defaultOpen = false }: { title: string; count?: number | string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border border-gray-200 rounded-lg bg-white">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm font-medium text-gray-800 hover:bg-gray-50 rounded-lg">
        {open ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}{title}{count != null && <span className="text-xs text-gray-400 font-normal">· {count}</span>}
      </button>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}

/** Header strip: score, counts, readiness, purpose. Reused by the page and the modal. */
export function CoachingHeader({ c, compact }: { c: Coaching; compact?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex items-center gap-3">
        <ScoreRing score={c.execution_score} size={compact ? 48 : 60} />
        <div>
          <div className="text-sm font-semibold text-gray-900">Execution <span className="text-gray-400 font-normal">· the salesperson</span></div>
          <CountsLine counts={c.counts} />
        </div>
      </div>
      <div className="h-8 w-px bg-gray-200 hidden sm:block" />
      <div>
        <div className="text-sm font-semibold text-gray-900">Deal readiness <span className="text-gray-400 font-normal">· the buyer</span></div>
        <div className="flex items-center gap-2 mt-0.5"><ReadinessBadge r={c.readiness} /></div>
      </div>
      {c.purpose && <div className="text-xs text-gray-500 sm:ml-auto">Call purpose: <span className="text-gray-800">{c.purpose}</span></div>}
    </div>
  );
}

export function CoachingReport({ c, onSeek }: { c: Coaching; onSeek?: (s: number) => void }) {
  const topMoments = (c.moments ?? []).filter((m) => m.priority != null).sort((a, b) => (a.priority ?? 9) - (b.priority ?? 9));
  const restMoments = (c.moments ?? []).filter((m) => m.priority == null).sort((a, b) => a.t - b.t);
  const brief = Object.entries(c.buyer_brief ?? {}) as Array<[string, { status: keyof typeof STATUS_LABEL; text: string }]>;
  const na = c.next_action;

  return (
    <div className="space-y-3">
      <CoachingHeader c={c} />

      {/* The four Kaptured questions */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {(c.lens ?? []).map((l) => (
          <div key={l.key} className="rounded-lg border border-gray-200 bg-white px-2.5 py-2">
            <div className="flex items-center gap-1.5"><span className={cn('w-2 h-2 rounded-full shrink-0', RATING_DOT[l.rating])} /><span className="text-xs font-medium text-gray-800 leading-tight">{l.label}</span></div>
            <div className="mt-1 flex items-start gap-1"><RatingBadge rating={l.rating} /></div>
            {l.note && <div className="text-[11px] text-gray-600 mt-1 leading-snug">{l.note}</div>}
          </div>
        ))}
      </div>

      <p className="text-sm text-gray-800 whitespace-pre-wrap">{c.summary}</p>

      {c.readiness?.summary && <div className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-md px-3 py-2"><span className="font-medium">Where the deal stands: </span>{c.readiness.summary}{c.readiness.blockers?.length ? <span className="text-gray-500"> · Blockers: {c.readiness.blockers.join('; ')}</span> : null}</div>}

      <div className="grid md:grid-cols-2 gap-3">
        <div className="space-y-3">
          {c.biggest_miss && (
            <Section tone="amber" icon={<AlertTriangle className="w-3.5 h-3.5 text-amber-600" />} title="Biggest missed opportunity">
              <div className="text-sm font-semibold text-gray-900">{c.biggest_miss.title}</div>
              <p className="text-xs text-gray-700 mt-1">{c.biggest_miss.diagnosis}</p>
              <div className="space-y-1.5 mt-2">{c.biggest_miss.evidence?.map((e, i) => <Quote key={i} e={e} onSeek={onSeek} />)}</div>
              <Better text={c.biggest_miss.better} />
            </Section>
          )}

          <Section icon={<ListChecks className="w-3.5 h-3.5 text-indigo-600" />} title={<>Priorities for this call <span className="text-gray-400 font-normal normal-case tracking-normal">· {c.priorities.length} of at most 3</span></>}>
            <ol className="space-y-2">
              {c.priorities.map((p, i) => (
                <li key={i} className="flex gap-2.5 text-xs">
                  <span className="w-5 h-5 rounded-full bg-indigo-600 text-white text-[11px] font-semibold flex items-center justify-center shrink-0">{i + 1}</span>
                  <div><div className="font-medium text-gray-900 text-sm">{p.title} <TimeButton t={p.t} onSeek={onSeek} className="ml-1" /></div><div className="text-gray-600 mt-0.5">{p.why}</div></div>
                </li>
              ))}
            </ol>
          </Section>

          {c.what_worked?.length > 0 && (
            <Section tone="green" icon={<ThumbsUp className="w-3.5 h-3.5 text-green-600" />} title="What worked">
              <ul className="space-y-2.5">
                {c.what_worked.map((w, i) => (
                  <li key={i}><div className="text-sm font-medium text-gray-900">{w.title}</div><div className="text-xs text-gray-700 mt-0.5">{w.why}</div><div className="space-y-1 mt-1.5">{w.evidence?.map((e, k) => <Quote key={k} e={e} onSeek={onSeek} />)}</div></li>
                ))}
              </ul>
            </Section>
          )}
        </div>

        <div className="space-y-3">
          {na?.what && (
            <Section tone="indigo" icon={<Sparkles className="w-3.5 h-3.5 text-indigo-600" />} title={<>Next action{na.before ? <span className="text-gray-400 font-normal normal-case tracking-normal"> · {na.before}</span> : null}</>}>
              <div className="text-sm font-medium text-gray-900">{na.what}</div>
              {na.why && <p className="text-xs text-gray-700 mt-1">{na.why}</p>}
              {na.commitment && <div className="text-xs mt-1.5"><span className="font-medium text-indigo-800">Commitment to ask for: </span><span className="text-gray-800">{na.commitment}</span></div>}
              {na.questions?.length ? <div className="mt-2"><div className="text-[11px] font-medium text-gray-600 uppercase tracking-wide">Still to ask</div><ul className="list-disc pl-4 text-xs text-gray-800 space-y-0.5 mt-0.5">{na.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div> : null}
              {na.proof?.length ? <div className="mt-2"><div className="text-[11px] font-medium text-gray-600 uppercase tracking-wide">Proof to send</div><ul className="list-disc pl-4 text-xs text-gray-800 space-y-0.5 mt-0.5">{na.proof.map((q, i) => <li key={i}>{q}</li>)}</ul></div> : null}
              {na.draft?.text && (
                <div className="mt-2 rounded-md border border-indigo-200 bg-white">
                  <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-indigo-100"><span className="text-[11px] font-medium text-gray-600 uppercase tracking-wide">Follow-up draft · {na.draft.channel}</span><CopyButton text={na.draft.text} /></div>
                  <pre className="text-xs text-gray-800 whitespace-pre-wrap font-sans px-2.5 py-2">{na.draft.text}</pre>
                </div>
              )}
            </Section>
          )}

          {c.uncertainties?.length > 0 && (
            <Section icon={<HelpCircle className="w-3.5 h-3.5 text-gray-500" />} title="Deal uncertainties">
              <ul className="space-y-2">
                {c.uncertainties.map((u, i) => <li key={i} className="text-xs"><div className="font-medium text-gray-900">{u.question}</div><div className="text-gray-600">{u.why_it_matters}{u.how_to_resolve ? <span className="text-gray-800"> → {u.how_to_resolve}</span> : null}</div></li>)}
              </ul>
            </Section>
          )}

          {c.practice?.skill && (
            <Section icon={<Dumbbell className="w-3.5 h-3.5 text-gray-600" />} title="Practise before the next call">
              <div className="text-sm font-medium text-gray-900">{c.practice.skill}</div>
              {c.practice.why && <p className="text-xs text-gray-700 mt-0.5">{c.practice.why}</p>}
              {c.practice.role_play && (
                <div className="mt-2 text-xs rounded-md bg-gray-50 border border-gray-200 px-2.5 py-2 space-y-1">
                  <div><span className="font-medium text-gray-600">Setup: </span>{c.practice.role_play.setup}</div>
                  <div><span className="font-medium text-green-800">Buyer says: </span>“{c.practice.role_play.buyer_says}”</div>
                  <div><span className="font-medium text-gray-600">Aim: </span>{c.practice.role_play.aim}</div>
                  {c.practice.role_play.example && <div><span className="font-medium text-indigo-800">Try: </span>“{c.practice.role_play.example}”</div>}
                </div>
              )}
            </Section>
          )}
        </div>
      </div>

      {topMoments.length > 0 && (
        <Section icon={<Play className="w-3.5 h-3.5 text-gray-600" />} title="Moments to replay">
          <div className="space-y-2">
            {topMoments.map((m, i) => <MomentCard key={i} m={m} onSeek={onSeek} />)}
          </div>
        </Section>
      )}

      {/* Full analysis, on demand */}
      <div className="space-y-2 pt-1">
        <div className="text-[11px] font-medium text-gray-500 uppercase tracking-wide">Full analysis</div>
        <Fold title="All criteria" count={`${c.criteria.length} rated`}>
          <ul className="divide-y divide-gray-100">
            {c.criteria.map((k) => (
              <li key={k.key} className="py-2.5">
                <div className="flex items-start gap-2"><span className={cn('w-2 h-2 rounded-full mt-1.5 shrink-0', RATING_DOT[k.rating])} /><div className="flex-1 min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-gray-900">{k.label}</span><RatingBadge rating={k.rating} /></div><p className="text-xs text-gray-700 mt-1">{k.finding}</p>{k.evidence?.length > 0 && <div className="space-y-1 mt-1.5">{k.evidence.map((e, i) => <Quote key={i} e={e} onSeek={onSeek} />)}</div>}<Better text={k.better} /></div></div>
              </li>
            ))}
          </ul>
        </Fold>
        {brief.length > 0 && (
          <Fold title="Buyer brief" count={`${brief.filter(([, v]) => v?.status === 'confirmed').length} of ${brief.length} confirmed`}>
            <dl className="grid sm:grid-cols-2 gap-x-4 gap-y-2 text-xs">
              {brief.map(([k, v]) => v && <div key={k} className="min-w-0"><dt className="flex items-center gap-1.5 font-medium text-gray-700">{BRIEF_LABELS[k] ?? k}<Badge tone={STATUS_TONE[v.status] ?? 'gray'}>{STATUS_LABEL[v.status] ?? v.status}</Badge></dt><dd className="text-gray-800 mt-0.5">{v.text}</dd></div>)}
            </dl>
          </Fold>
        )}
        {c.qualification?.length > 0 && (
          <Fold title="Qualification" count={`${c.qualification.filter((q) => q.status === 'confirmed').length} of ${c.qualification.length} confirmed`}>
            <table className="w-full text-xs"><tbody className="divide-y divide-gray-100">
              {c.qualification.map((q) => <tr key={q.key}><td className="py-1.5 pr-3 font-medium text-gray-800 whitespace-nowrap align-top">{q.label}</td><td className="py-1.5 pr-3 align-top"><Badge tone={STATUS_TONE[q.status] ?? 'gray'}>{STATUS_LABEL[q.status] ?? q.status}</Badge></td><td className="py-1.5 text-gray-700 align-top">{q.text}{q.evidence?.length ? <span className="ml-1.5 inline-flex gap-1.5">{q.evidence.map((e, i) => <TimeButton key={i} t={e.t} onSeek={onSeek} />)}</span> : null}</td></tr>)}
            </tbody></table>
          </Fold>
        )}
        {restMoments.length > 0 && (
          <Fold title="All coached moments" count={c.moments.length}>
            <div className="space-y-2">{[...topMoments, ...restMoments].sort((a, b) => a.t - b.t).map((m, i) => <MomentCard key={i} m={m} onSeek={onSeek} />)}</div>
          </Fold>
        )}
        {(c.limits?.length > 0 || Object.keys(c.context_used ?? {}).length > 0) && (
          <Fold title="What this recording cannot tell you" count={c.limits?.length}>
            <ul className="list-disc pl-4 text-xs text-gray-700 space-y-1">{c.limits.map((l, i) => <li key={i}>{l}</li>)}</ul>
            {Object.keys(c.context_used ?? {}).length > 0 && <div className="text-[11px] text-gray-500 mt-2">Coached from: {Object.entries(c.context_used).filter(([, v]) => v).map(([k]) => k.replace('_', ' ')).join(', ') || 'transcript'}</div>}
          </Fold>
        )}
        <div className="text-[11px] text-gray-400">Version {c.version} · {c.saved_by ? `by ${c.saved_by} · ` : ''}{new Date(c.updated_at).toLocaleString()}{c.model ? ` · ${c.model}` : ''}</div>
      </div>
    </div>
  );
}

function MomentCard({ m, onSeek }: { m: Coaching['moments'][number]; onSeek?: (s: number) => void }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-2.5 grid md:grid-cols-[1.2fr_1fr_1.2fr] gap-2 text-xs">
      <div>
        <div className="flex items-center gap-2 mb-1"><TimeButton t={m.t} onSeek={onSeek} />{m.priority != null && <Badge tone="indigo">#{m.priority}</Badge>}<span className="text-[11px] text-gray-400 uppercase tracking-wide">Call evidence</span></div>
        <div className="text-green-800"><span className="font-medium">Buyer:</span> “{m.quote}”</div>
        {m.response && <div className="text-indigo-800 mt-0.5"><span className="font-medium">Seller:</span> “{m.response}”</div>}
      </div>
      <div><div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Diagnosis</div><div className="text-gray-800">{m.diagnosis}</div></div>
      <div><div className="text-[11px] text-gray-400 uppercase tracking-wide mb-1">Better response</div><div className="text-gray-900 bg-green-50/70 border border-green-200 rounded px-2 py-1">“{m.better}”</div></div>
    </div>
  );
}

export function NoCoaching({ company }: { company?: string | null }) {
  return <EmptyState compact icon={<Sparkles className="w-5 h-5 text-indigo-500" />} title="No coaching for this call yet" description={`Ask Claude (with the CRM connector): “coach the ${company ?? ''} call”. It reads the transcript, rates the 12 criteria with timestamped evidence, and saves the report here.`} />;
}
