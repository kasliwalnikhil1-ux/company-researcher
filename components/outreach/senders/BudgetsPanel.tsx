'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useCeilings, useSenderBudgets, useWarmupCaps } from '@/lib/outreach/queries';
import { Badge, Button, Card, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { ACTION_LABELS, BUDGET_ACTION_TYPES, localDate } from './helpers';
import { cn } from '@/lib/utils';
import type { ActionType, PlatformCeiling, Provider, Sender, SenderBudget, WarmupCap } from '@/lib/outreach/types';
import { WA_GOVERNOR_DEMOTION, WA_GOVERNOR_LEVELS, useSenderScopes } from '@/lib/outreach/channels';

type Notify = (message: string, type?: 'success' | 'error') => void;
// 025 adds a `provider` column to both tables; rows without one are LinkedIn (the pre-channels seed).
type CeilingRow = PlatformCeiling & { provider?: Provider };
type WarmupRow = WarmupCap & { provider?: Provider };
const rowProvider = (r: { provider?: Provider }) => r.provider ?? 'LINKEDIN';

function ScopeCard({ title, hint, scope, loading }: { title: string; hint: string; scope: { cap: number; used: number; reserved: number; remaining: number } | null | undefined; loading: boolean }) {
  const used = scope ? scope.used + scope.reserved : 0;
  const cap = scope?.cap ?? 0;
  const pct = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
  return (
    <Card title={title}>
      {loading ? <div className="text-sm text-gray-400">…</div> : !scope ? <div className="text-sm text-gray-500">Nothing reserved yet this hour.</div> : (
        <>
          <div className="text-3xl font-bold text-gray-900 tabular-nums">{used}<span className="text-base font-normal text-gray-400"> / {cap}</span></div>
          <div className="h-2 mt-3 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-green-500')} style={{ width: `${pct}%` }} /></div>
          <div className="text-xs text-gray-600 mt-2 tabular-nums">{Math.max(0, scope.remaining)} left{cap === 0 ? ' (health below 50: no allowance this hour)' : ''}</div>
        </>
      )}
      <p className="text-xs text-gray-500 mt-3">{hint}</p>
    </Card>
  );
}

export default function BudgetsPanel({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const canEdit = isManager && canWrite;
  const budgets = useSenderBudgets(sender.id);
  const ceilings = useCeilings();
  const warmup = useWarmupCaps();
  const today = localDate(sender.timezone || 'UTC');
  const isLinkedIn = sender.provider === 'LINKEDIN';
  const isInstagram = sender.provider === 'INSTAGRAM';
  const isWhatsApp = sender.provider === 'WHATSAPP';
  const weekly = useQuery({ queryKey: ['outreach', 'sender', sender.id, 'weekly', today], enabled: isLinkedIn, queryFn: () => rpc<number>('weekly_invites_used', { p_sender: sender.id, p_day: today }), refetchInterval: 60000 });
  const scopes = useSenderScopes(sender.id, isInstagram || isWhatsApp);

  const [caps, setCaps] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { const init: Record<string, string> = {}; for (const [k, v] of Object.entries(sender.manual_caps ?? {})) if (typeof v === 'number') init[k] = String(v); setCaps(init); }, [sender.id, sender.manual_caps]);

  // Ceilings and warm-up caps are per channel; only this sender's channel is shown.
  const providerCeilings = useMemo(() => ((ceilings.data ?? []) as CeilingRow[]).filter((c) => rowProvider(c) === sender.provider), [ceilings.data, sender.provider]);
  const providerWarmup = useMemo(() => ((warmup.data ?? []) as WarmupRow[]).filter((w) => rowProvider(w) === sender.provider), [warmup.data, sender.provider]);
  const ceilingByType = useMemo(() => new Map(providerCeilings.map((c) => [c.action_type, c])), [providerCeilings]);
  const levelCaps = useMemo(() => new Map(providerWarmup.filter((w) => w.level === sender.warmup_level).map((w) => [w.action_type, w.per_day])), [providerWarmup, sender.warmup_level]);
  // Action types that matter for this channel, in display order (the internal "unlimited" ceilings are left out).
  const types = useMemo<ActionType[]>(() => {
    const t = BUDGET_ACTION_TYPES.filter((x) => { const c = ceilingByType.get(x); return c && c.per_day < 100000; });
    return t.length ? t : BUDGET_ACTION_TYPES;
  }, [ceilingByType]);
  const levels = isWhatsApp ? [0, 1, 2, 3, 4] : [0, 1, 2, 3, 4, 5];
  const dayScope = scopes.data?.day ?? null;
  const hourScope = scopes.data?.hour ?? null;
  const todayRows = useMemo(() => (budgets.data ?? []).filter((b) => b.day === today), [budgets.data, today]);
  const history = useMemo(() => {
    const byDay = new Map<string, Partial<Record<ActionType, SenderBudget>>>();
    for (const b of budgets.data ?? []) { if (b.day === today) continue; const m = byDay.get(b.day) ?? {}; m[b.action_type] = b; byDay.set(b.day, m); }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  }, [budgets.data, today]);
  const historyTypes = useMemo(() => types.filter((t) => history.some(([, m]) => m[t])), [history, types]);

  const capErrors = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(caps)) {
      if (v === '') continue;
      const n = Number(v);
      const ceil = ceilingByType.get(k as ActionType)?.per_day;
      if (!Number.isInteger(n) || n < 0) out[k] = 'Whole number ≥ 0';
      else if (ceil != null && n > ceil) out[k] = `Above platform ceiling (${ceil})`;
    }
    return out;
  }, [caps, ceilingByType]);
  const hasErrors = Object.keys(capErrors).length > 0;
  const capsDirty = useMemo(() => {
    const cur: Record<string, number> = {}; for (const [k, v] of Object.entries(caps)) if (v !== '') cur[k] = Number(v);
    const orig: Record<string, number> = {}; for (const [k, v] of Object.entries(sender.manual_caps ?? {})) if (typeof v === 'number') orig[k] = v;
    return JSON.stringify(cur) !== JSON.stringify(orig);
  }, [caps, sender.manual_caps]);

  async function saveCaps() {
    if (hasErrors) return;
    const p_caps: Record<string, number> = {}; for (const [k, v] of Object.entries(caps)) if (v !== '') p_caps[k] = Number(v);
    setSaving(true);
    try {
      await rpc('set_manual_caps', { p_sender: sender.id, p_caps });
      notify('Manual caps saved. They apply from the next planner run.');
      qc.invalidateQueries({ queryKey: qk.sender(sender.id) }); qc.invalidateQueries({ queryKey: qk.senderEvents(sender.id) });
    } catch (e) {
      const err = parseError(e);
      notify(err.code === 'E_CAP_ABOVE_CEILING' ? `Rejected: ${err.message}` : err.message, 'error');
    } finally { setSaving(false); }
  }

  const weeklyCeiling = ceilingByType.get('invite')?.per_week ?? 150;
  const weeklyUsed = weekly.data ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2" title={<span>Today <span className="font-normal text-gray-400">({today}, sender-local)</span></span>}>
          {budgets.isLoading ? <Spinner /> : budgets.isError ? <ErrorBox message={(budgets.error as Error).message} /> : todayRows.length === 0 ? (
            <div className="text-sm text-gray-500 py-4">No budget rows for today yet. The planner creates them at the start of the sender's day, or when you click “Schedule today's actions” on the Overview tab.</div>
          ) : (
            <Table>
              <thead><tr><Th>Action</Th><Th className="text-right">Used</Th><Th className="text-right">Reserved</Th><Th className="text-right">Cap</Th><Th>Progress</Th></tr></thead>
              <tbody>
                {isInstagram && dayScope && (
                  <tr className="bg-fuchsia-50/60">
                    <Td className="font-medium text-gray-900">Total actions today <span className="text-xs font-normal text-gray-500">(all metered actions)</span></Td>
                    <Td className="text-right tabular-nums">{dayScope.used}</Td>
                    <Td className="text-right tabular-nums text-gray-500">{dayScope.reserved}</Td>
                    <Td className="text-right tabular-nums">{dayScope.cap}</Td>
                    <Td><div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', dayScope.cap > 0 && dayScope.used + dayScope.reserved >= dayScope.cap ? 'bg-amber-500' : 'bg-fuchsia-500')} style={{ width: `${dayScope.cap > 0 ? Math.min(100, Math.round(((dayScope.used + dayScope.reserved) / dayScope.cap) * 100)) : 0}%` }} /></div></Td>
                  </tr>
                )}
                {types.concat(todayRows.map((r) => r.action_type).filter((t) => !types.includes(t))).map((t) => {
                  const r = todayRows.find((x) => x.action_type === t); if (!r) return null;
                  const pct = r.cap > 0 ? Math.min(100, Math.round(((r.used + r.reserved) / r.cap) * 100)) : 0;
                  return (
                    <tr key={t}>
                      <Td className="font-medium text-gray-900">{ACTION_LABELS[t] ?? t}</Td>
                      <Td className="text-right tabular-nums">{r.used}</Td>
                      <Td className="text-right tabular-nums text-gray-500">{r.reserved}</Td>
                      <Td className="text-right tabular-nums">{r.cap}</Td>
                      <Td><div className="w-32 h-2 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', pct >= 100 ? 'bg-amber-500' : 'bg-indigo-500')} style={{ width: `${pct}%` }} /></div></Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          )}
        </Card>
        {isLinkedIn && (
          <Card title="Weekly invitations">
            <div className="text-3xl font-bold text-gray-900 tabular-nums">{weekly.isLoading ? '…' : weeklyUsed}<span className="text-base font-normal text-gray-400"> / {weeklyCeiling}</span></div>
            <div className="h-2 mt-3 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', weeklyUsed >= weeklyCeiling ? 'bg-red-500' : weeklyUsed >= weeklyCeiling * 0.8 ? 'bg-amber-500' : 'bg-green-500')} style={{ width: `${Math.min(100, Math.round((weeklyUsed / Math.max(1, weeklyCeiling)) * 100))}%` }} /></div>
            <p className="text-xs text-gray-500 mt-3">LinkedIn's rolling weekly limit, enforced across every sequence on this sender. Counts sent plus reserved for the week starting Monday.</p>
          </Card>
        )}
        {isInstagram && (
          <ScopeCard title="This hour" loading={scopes.isLoading} scope={hourScope}
            hint="Instagram allows at most 10 metered actions an hour (follows, likes, comments, profile views, new conversations, messages). When the hour is used up, the rest moves to the next hour on its own. Replies never count." />
        )}
        {isWhatsApp && (
          <Card title="New-conversation governor">
            <p className="text-xs text-gray-500 mb-3">WhatsApp watches new conversations that get no reply, so the daily allowance rises with the reply rate instead of with time. The current level is highlighted.</p>
            <ul className="space-y-1.5">
              {WA_GOVERNOR_LEVELS.map((l) => (
                <li key={l.level} className={cn('rounded-lg border px-3 py-2 text-xs', l.level === sender.warmup_level ? 'border-indigo-300 bg-indigo-50' : 'border-gray-100')}>
                  <div className="flex items-center justify-between gap-2"><span className="font-medium text-gray-900">Level {l.level}</span><span className="tabular-nums text-gray-700">{l.new_chats} new conversations a day</span></div>
                  <div className="text-gray-500 mt-0.5">{l.level < 4 ? `To reach level ${l.level + 1}: ${WA_GOVERNOR_LEVELS[l.level + 1].promotion}` : l.promotion}</div>
                  {l.level === 0 && <div className="text-gray-500 mt-0.5">Leaving level 0 needs: {l.promotion}.</div>}
                </li>
              ))}
            </ul>
            <p className="text-xs text-amber-800 mt-3">{WA_GOVERNOR_DEMOTION}</p>
          </Card>
        )}
      </div>

      <Card title="Manual caps" actions={canEdit ? <Button size="sm" onClick={saveCaps} loading={saving} disabled={!capsDirty || hasErrors}><Save className="w-3.5 h-3.5" /> Save caps</Button> : undefined}>
        <p className="text-sm text-gray-500 mb-4">Optional per-day limits you set by hand. The effective cap is the <em>lowest</em> of the platform ceiling, the warm-up level cap, and your manual cap (then scaled by health). Leave a field empty to use the automatic value. Caps above the platform ceiling are rejected.</p>
        {ceilings.isLoading || warmup.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>Action</Th><Th className="text-right">Level {sender.warmup_level} cap</Th><Th className="text-right">Platform ceiling</Th><Th>Manual cap</Th></tr></thead>
            <tbody>
              {types.map((t) => {
                const ceil = ceilingByType.get(t); const lvl = levelCaps.get(t); const v = caps[t] ?? ''; const err = capErrors[t];
                const aboveLevel = v !== '' && lvl != null && Number(v) > lvl && !err;
                return (
                  <tr key={t}>
                    <Td className="font-medium text-gray-900">{ACTION_LABELS[t]}</Td>
                    <Td className="text-right tabular-nums">{lvl ?? '—'}</Td>
                    <Td className="text-right tabular-nums">{ceil?.per_day ?? '—'}{ceil?.per_week ? <span className="text-xs text-gray-400"> / {ceil.per_week} wk</span> : null}</Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        <input type="number" min={0} max={ceil?.per_day} inputMode="numeric" aria-label={`Manual cap for ${ACTION_LABELS[t]}`} placeholder="auto" value={v} disabled={!canEdit}
                          onChange={(e) => setCaps({ ...caps, [t]: e.target.value })}
                          className={cn('w-24 px-2 py-1.5 text-sm rounded-lg border bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-gray-50', err ? 'border-red-400' : 'border-gray-300')} />
                        {err && <span className="text-xs text-red-600">{err}</span>}
                        {aboveLevel && <span className="text-xs text-amber-600">Above the level cap; the level cap ({lvl}) still applies</span>}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title="Last 14 days">
        {budgets.isLoading ? <Spinner /> : history.length === 0 ? <div className="text-sm text-gray-500 py-4">No history yet.</div> : (
          <Table>
            <thead><tr><Th>Day</Th>{historyTypes.map((t) => <Th key={t} className="text-right">{ACTION_LABELS[t]}</Th>)}</tr></thead>
            <tbody>
              {history.map(([day, m]) => (
                <tr key={day}>
                  <Td className="whitespace-nowrap font-medium text-gray-900">{day}</Td>
                  {historyTypes.map((t) => { const b = m[t]; return <Td key={t} className="text-right tabular-nums">{b ? <span className={b.used >= b.cap && b.cap > 0 ? 'text-amber-700' : ''}>{b.used}<span className="text-gray-400">/{b.cap}</span></span> : <span className="text-gray-300">—</span>}</Td>; })}
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Card title={<span>Warm-up caps <Badge tone="indigo" className="ml-2">current level {sender.warmup_level}</Badge></span>}>
        <p className="text-sm text-gray-500 mb-3">
          {isWhatsApp ? 'Read-only. WhatsApp levels follow the new-conversation governor above: they rise with the reply rate and drop straight away on a block or a poor fortnight.'
            : isInstagram ? 'Read-only. Levels advance automatically when health stays ≥85 for 14 days. Level 0 can follow, like and view but not send direct messages. Every level keeps to 10 actions an hour.'
              : 'Read-only. Levels advance automatically when health stays ≥85 for 14 days. New or small accounts stay at level 0 for at least 28 days.'}
        </p>
        {warmup.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>Level</Th>{types.map((t) => <Th key={t} className="text-right">{ACTION_LABELS[t]}</Th>)}</tr></thead>
            <tbody>
              {levels.map((lvl) => (
                <tr key={lvl} className={lvl === sender.warmup_level ? 'bg-indigo-50' : ''}>
                  <Td className="font-medium text-gray-900">L{lvl}</Td>
                  {types.map((t) => { const w = providerWarmup.find((x) => x.level === lvl && x.action_type === t); return <Td key={t} className="text-right tabular-nums">{w?.per_day ?? '—'}</Td>; })}
                </tr>
              ))}
              <tr className="bg-gray-50">
                <Td className="font-medium text-gray-900">Ceiling</Td>
                {types.map((t) => <Td key={t} className="text-right tabular-nums font-medium">{ceilingByType.get(t)?.per_day ?? '—'}</Td>)}
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
