'use client';

import type { ReactNode } from 'react';
import { AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, CheckCircle2, Info, Lock, RefreshCw, Zap } from 'lucide-react';
import { parseError } from '@/lib/outreach/api';
import { Badge, Button, Card, ErrorBox, Spinner, fmtDate } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { ActionType } from '@/lib/outreach/types';
import { ACTION_LABELS, HEALTH_KEYS, healthTone, isFuture } from './helpers';
import { fmtDay, hasInMail, isMailbox, num, pct, useSenderInsights, type Recommendation, type SenderInsights as Insights, type SenderV2, type Severity } from './insights';
import InvitesVsCapChart from './InvitesVsCapChart';

const SEVERITY: Record<Severity, { label: string; row: string; icon: ReactNode; tone: 'red' | 'amber' | 'blue' | 'green' }> = {
  high: { label: 'Fix now', row: 'border-red-200 bg-red-50', icon: <AlertTriangle className="w-4 h-4 text-red-600" aria-hidden />, tone: 'red' },
  medium: { label: 'Worth fixing', row: 'border-amber-200 bg-amber-50', icon: <AlertTriangle className="w-4 h-4 text-amber-600" aria-hidden />, tone: 'amber' },
  low: { label: 'Tip', row: 'border-blue-200 bg-blue-50', icon: <Info className="w-4 h-4 text-blue-600" aria-hidden />, tone: 'blue' },
  ok: { label: 'All good', row: 'border-green-200 bg-green-50', icon: <CheckCircle2 className="w-4 h-4 text-green-600" aria-hidden />, tone: 'green' },
};
const ORDER: Severity[] = ['high', 'medium', 'low', 'ok'];

function Recommendations({ items }: { items: Recommendation[] }) {
  const sorted = [...items].sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  return (
    <ul className="space-y-2">
      {sorted.map((r, i) => {
        const s = SEVERITY[r.severity] ?? SEVERITY.low;
        return (
          <li key={`${r.area}-${i}`} className={cn('flex items-start gap-2.5 rounded-lg border p-3', s.row)}>
            <span className="mt-0.5 flex-shrink-0">{s.icon}</span>
            <div className="min-w-0 flex-1 text-sm text-gray-800">{r.text}</div>
            <Badge tone={s.tone} className="flex-shrink-0">{s.label}</Badge>
          </li>
        );
      })}
    </ul>
  );
}

function ScoreBars({ breakdown }: { breakdown: Record<string, number> }) {
  return (
    <dl className="space-y-2.5">
      {HEALTH_KEYS.map((k) => {
        const raw = breakdown?.[k.key];
        const v = typeof raw === 'number' ? Math.round(raw) : null;
        const tone = v == null ? null : healthTone(v);
        return (
          <div key={k.key} title={k.hint}>
            <div className="flex justify-between text-xs text-gray-600"><dt>{k.label}</dt><dd className="tabular-nums text-gray-900">{v ?? '—'}</dd></div>
            <div className="h-1.5 mt-1 bg-gray-100 rounded-full overflow-hidden" role="presentation">
              <div className={cn('h-full rounded-full', tone == null ? 'bg-gray-300' : tone === 'green' ? 'bg-green-500' : tone === 'lime' ? 'bg-lime-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-red-500')} style={{ width: `${v ?? 0}%` }} />
            </div>
          </div>
        );
      })}
    </dl>
  );
}

function WarmupCard({ sender, w }: { sender: SenderV2; w: Insights['warmup'] }) {
  const atTop = w.level >= w.max_level;
  const freeCeiling = sender.provider === 'LINKEDIN' && w.max_level < 5;
  const locked = isFuture(w.locked_until);
  const types: ActionType[] = isMailbox(sender) ? ['email'] : (['invite', 'message', 'profile_view', ...(hasInMail(sender) ? ['inmail'] : [])] as ActionType[]);

  return (
    <Card title="Warm-up">
      <div className="flex items-baseline gap-2">
        <div className="text-3xl font-bold text-gray-900">Level {w.level}</div>
        <div className="text-sm text-gray-500">of {w.max_level}{freeCeiling ? ' on a free account' : ''}</div>
      </div>

      <ol className="mt-3 flex items-center gap-1" aria-label={`Warm-up ladder: level ${w.level} of 5${freeCeiling ? `, limited to ${w.max_level} on a free account` : ''}`}>
        {[0, 1, 2, 3, 4, 5].map((l) => {
          const reached = l <= w.level; const blocked = l > w.max_level; const next = l === w.level + 1 && !blocked;
          return (
            <li key={l} className="flex-1" title={blocked ? 'Needs a Premium or Sales Navigator seat' : reached ? 'Reached' : next ? 'Next level' : 'Later'}>
              <div className={cn('h-2 rounded-full', reached ? 'bg-indigo-600' : next ? 'bg-indigo-200' : blocked ? 'bg-gray-100 border border-dashed border-gray-300' : 'bg-gray-200')} />
              <div className={cn('mt-1 text-[11px] text-center tabular-nums', reached ? 'text-gray-900 font-medium' : 'text-gray-400')}>{blocked ? <Lock className="w-3 h-3 inline" aria-label={`Level ${l} locked`} /> : l}</div>
            </li>
          );
        })}
      </ol>

      <p className="mt-3 text-sm text-gray-700">{w.unlocks}</p>
      <dl className="mt-3 space-y-1.5 text-sm">
        {!atTop && <div className="flex justify-between gap-3"><dt className="text-gray-500">Next level can unlock on</dt><dd className="text-gray-900 text-right">{w.next_level_on ? fmtDay(w.next_level_on) : 'No date yet'}</dd></div>}
        {w.health_high_since && !atTop && <div className="flex justify-between gap-3"><dt className="text-gray-500">Health 85 or higher since</dt><dd className="text-gray-900 text-right">{fmtDay(w.health_high_since)}</dd></div>}
        {locked && <div className="flex justify-between gap-3"><dt className="text-gray-500 flex items-center gap-1"><Lock className="w-3 h-3" aria-hidden /> Level-up locked until</dt><dd className="text-gray-900 text-right">{fmtDate(w.locked_until, false)}</dd></div>}
      </dl>
      {locked && <p className="text-xs text-gray-500 mt-1">New or small accounts stay on their level for a fixed period first. The lock lifts on its own.</p>}
      {freeCeiling && <p className="mt-2 text-xs text-gray-600 rounded-lg bg-gray-50 border border-gray-200 p-2.5">Free LinkedIn accounts stop at level 1. LinkedIn watches them more closely, so the daily allowances stay low. A Premium or Sales Navigator seat unlocks levels 2 to 5.</p>}

      <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
        <table className="min-w-full text-sm">
          <caption className="sr-only">Daily warm-up allowance now and at the next level</caption>
          <thead><tr className="bg-gray-50 text-xs text-gray-500"><th scope="col" className="text-left font-semibold px-3 py-2">Per day</th><th scope="col" className="text-right font-semibold px-3 py-2">Now</th>{!atTop && <th scope="col" className="text-right font-semibold px-3 py-2">Level {w.level + 1}</th>}</tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t} className="border-t border-gray-100">
                <th scope="row" className="text-left font-normal text-gray-700 px-3 py-1.5">{ACTION_LABELS[t]}</th>
                <td className="text-right tabular-nums text-gray-900 px-3 py-1.5">{num(w.caps_now?.[t])}</td>
                {!atTop && <td className="text-right tabular-nums text-gray-900 px-3 py-1.5"><span className="inline-flex items-center gap-1 justify-end"><ArrowRight className="w-3 h-3 text-gray-400" aria-hidden />{num(w.caps_next?.[t])}</span></td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-gray-500 mt-2">These are the warm-up allowances. Health and manual caps can lower the real allowance for today: see the Budgets tab.</p>
    </Card>
  );
}

function Tile({ label, value, children, hint }: { label: string; value: ReactNode; children?: ReactNode; hint?: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3" title={hint}>
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-semibold text-gray-900 mt-0.5">{value}</div>
      <div className="text-xs text-gray-500 mt-1 min-h-[1rem]">{children}</div>
    </div>
  );
}

function AcceptanceTrend({ now, prev }: { now: number | null; prev: number | null }) {
  if (now == null) return <>Not enough invitations yet</>;
  if (prev == null) return <>No figure for the 30 days before</>;
  const diff = Math.round((now - prev) * 10) / 10;
  if (diff === 0) return <>Same as the 30 days before ({pct(prev)})</>;
  const up = diff > 0;
  return (
    <span className="inline-flex items-center gap-1">
      {up ? <ArrowUpRight className="w-3.5 h-3.5 text-green-600" aria-hidden /> : <ArrowDownRight className="w-3.5 h-3.5 text-red-600" aria-hidden />}
      <span className={up ? 'text-green-700 font-medium' : 'text-red-700 font-medium'}>{up ? '+' : '−'}{Math.abs(diff)} pts</span>
      <span>vs the 30 days before ({pct(prev)})</span>
    </span>
  );
}

export default function SenderInsights({ sender }: { sender: SenderV2 }) {
  const q = useSenderInsights(sender.id);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <div className="space-y-3"><ErrorBox message={parseError(q.error).message} /><Button size="sm" variant="secondary" onClick={() => q.refetch()}>Try again</Button></div>;
  const d = q.data;
  if (!d) return null;
  const m = d.last_30_days;
  const linkedIn = sender.provider === 'LINKEDIN';
  const growth = m.network_growth;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <Card className="lg:col-span-2" title="What to do next" actions={<Button size="sm" variant="ghost" onClick={() => q.refetch()} loading={q.isFetching} aria-label="Refresh insights"><RefreshCw className="w-3.5 h-3.5" /> Refresh</Button>}>
          <Recommendations items={d.recommendations} />
          <p className="text-xs text-gray-500 mt-3">Based on the last 14–30 days of activity. These are fixed rules applied to the health scores, not AI.</p>
        </Card>
        <Card title="Health scores" actions={<span className="text-xs text-gray-500">Overall <span className="font-semibold text-gray-900 tabular-nums">{d.sender.health}</span></span>}>
          <ScoreBars breakdown={d.health_breakdown} />
          <p className="text-xs text-gray-500 mt-3">Each score runs from 0 to 100. Higher is safer.</p>
        </Card>
      </div>

      {linkedIn && (
        <section aria-labelledby="sender-30d">
          <h3 id="sender-30d" className="text-sm font-semibold text-gray-900 mb-3">Last 30 days</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
            <Tile label="Headroom" value={pct(m.headroom_pct)} hint="Share of the invitation cap that was not used">{m.headroom_pct == null ? 'No invitation allowance yet' : 'of the invitation cap was not used'}</Tile>
            <Tile label="LinkedIn limit hits" value={num(m.limit_hits)} hint="Times LinkedIn itself refused more invitations">{Number(m.limit_hits) > 0 ? 'Invitations paused until the limit reset' : 'LinkedIn never refused an invitation'}</Tile>
            <Tile label="Acceptance rate" value={pct(m.acceptance_rate)} hint="Accepted invitations divided by invitations sent"><AcceptanceTrend now={m.acceptance_rate} prev={m.acceptance_rate_previous} /></Tile>
            <Tile label="Network growth" value={growth == null ? '—' : `${growth > 0 ? '+' : ''}${num(growth)}`} hint="How much the sender's network grew">
              {m.network_growth_source === 'connections_count' ? 'Change in the LinkedIn connections count' : 'Counted from accepted invitations. A connections count from 30 days ago is not on file yet.'}
            </Tile>
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        {linkedIn && (
          <Card className="lg:col-span-2" title="Invitations sent against the daily cap">
            <InvitesVsCapChart data={d.invites_vs_cap} />
          </Card>
        )}
        <div className={cn('space-y-6', !linkedIn && 'lg:col-span-3')}>
          <WarmupCard sender={sender} w={d.warmup} />
          {hasInMail(sender) && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <div className="flex items-center gap-2 text-sm font-semibold text-gray-900"><Zap className="w-4 h-4 text-indigo-600" aria-hidden /> InMail speed guard</div>
              <p className="text-sm text-gray-700 mt-1.5">At most <span className="font-semibold tabular-nums">{num(d.inmail_guard.max_today)}</span> InMail{d.inmail_guard.max_today === 1 ? '' : 's'} today, even when more credits are left.</p>
              <p className="text-xs text-gray-500 mt-1.5">{d.inmail_guard.rule}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
