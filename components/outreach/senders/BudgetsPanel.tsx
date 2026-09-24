'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { parseError, rpc } from '@/lib/outreach/api';
import { qk, useCeilings, useSenderBudgets, useWarmupCaps } from '@/lib/outreach/queries';
import { Badge, Button, Card, ErrorBox, Spinner, Table, Td, Th } from '@/components/outreach/ui';
import { ACTION_LABELS, BUDGET_ACTION_TYPES, localDate } from './helpers';
import { cn } from '@/lib/utils';
import type { ActionType, Sender, SenderBudget } from '@/lib/outreach/types';

type Notify = (message: string, type?: 'success' | 'error') => void;

export default function BudgetsPanel({ sender, isManager, canWrite, notify }: { sender: Sender; isManager: boolean; canWrite: boolean; notify: Notify }) {
  const qc = useQueryClient();
  const canEdit = isManager && canWrite;
  const budgets = useSenderBudgets(sender.id);
  const ceilings = useCeilings();
  const warmup = useWarmupCaps();
  const today = localDate(sender.timezone || 'UTC');
  const weekly = useQuery({ queryKey: ['outreach', 'sender', sender.id, 'weekly', today], queryFn: () => rpc<number>('weekly_invites_used', { p_sender: sender.id, p_day: today }), refetchInterval: 60000 });

  const [caps, setCaps] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { const init: Record<string, string> = {}; for (const [k, v] of Object.entries(sender.manual_caps ?? {})) if (typeof v === 'number') init[k] = String(v); setCaps(init); }, [sender.id, sender.manual_caps]);

  const ceilingByType = useMemo(() => new Map((ceilings.data ?? []).map((c) => [c.action_type, c])), [ceilings.data]);
  const levelCaps = useMemo(() => new Map((warmup.data ?? []).filter((w) => w.level === sender.warmup_level).map((w) => [w.action_type, w.per_day])), [warmup.data, sender.warmup_level]);
  const todayRows = useMemo(() => (budgets.data ?? []).filter((b) => b.day === today), [budgets.data, today]);
  const history = useMemo(() => {
    const byDay = new Map<string, Partial<Record<ActionType, SenderBudget>>>();
    for (const b of budgets.data ?? []) { if (b.day === today) continue; const m = byDay.get(b.day) ?? {}; m[b.action_type] = b; byDay.set(b.day, m); }
    return [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14);
  }, [budgets.data, today]);
  const historyTypes = useMemo(() => BUDGET_ACTION_TYPES.filter((t) => history.some(([, m]) => m[t])), [history]);

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
                {BUDGET_ACTION_TYPES.concat(todayRows.map((r) => r.action_type).filter((t) => !BUDGET_ACTION_TYPES.includes(t))).map((t) => {
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
        <Card title="Weekly invitations">
          <div className="text-3xl font-bold text-gray-900 tabular-nums">{weekly.isLoading ? '…' : weeklyUsed}<span className="text-base font-normal text-gray-400"> / {weeklyCeiling}</span></div>
          <div className="h-2 mt-3 bg-gray-100 rounded-full overflow-hidden"><div className={cn('h-full', weeklyUsed >= weeklyCeiling ? 'bg-red-500' : weeklyUsed >= weeklyCeiling * 0.8 ? 'bg-amber-500' : 'bg-green-500')} style={{ width: `${Math.min(100, Math.round((weeklyUsed / Math.max(1, weeklyCeiling)) * 100))}%` }} /></div>
          <p className="text-xs text-gray-500 mt-3">LinkedIn's rolling weekly limit, enforced across every sequence on this sender. Counts sent plus reserved for the week starting Monday.</p>
        </Card>
      </div>

      <Card title="Manual caps" actions={canEdit ? <Button size="sm" onClick={saveCaps} loading={saving} disabled={!capsDirty || hasErrors}><Save className="w-3.5 h-3.5" /> Save caps</Button> : undefined}>
        <p className="text-sm text-gray-500 mb-4">Optional per-day limits you set by hand. The effective cap is the <em>lowest</em> of the platform ceiling, the warm-up level cap, and your manual cap (then scaled by health). Leave a field empty to use the automatic value. Caps above the platform ceiling are rejected.</p>
        {ceilings.isLoading || warmup.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>Action</Th><Th className="text-right">Level {sender.warmup_level} cap</Th><Th className="text-right">Platform ceiling</Th><Th>Manual cap</Th></tr></thead>
            <tbody>
              {BUDGET_ACTION_TYPES.map((t) => {
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
        <p className="text-sm text-gray-500 mb-3">Read-only. Levels advance automatically when health stays ≥85 for 14 days. New or small accounts stay at level 0 for at least 28 days.</p>
        {warmup.isLoading ? <Spinner /> : (
          <Table>
            <thead><tr><Th>Level</Th>{BUDGET_ACTION_TYPES.map((t) => <Th key={t} className="text-right">{ACTION_LABELS[t]}</Th>)}</tr></thead>
            <tbody>
              {[0, 1, 2, 3, 4, 5].map((lvl) => (
                <tr key={lvl} className={lvl === sender.warmup_level ? 'bg-indigo-50' : ''}>
                  <Td className="font-medium text-gray-900">L{lvl}</Td>
                  {BUDGET_ACTION_TYPES.map((t) => { const w = (warmup.data ?? []).find((x) => x.level === lvl && x.action_type === t); return <Td key={t} className="text-right tabular-nums">{w?.per_day ?? '—'}</Td>; })}
                </tr>
              ))}
              <tr className="bg-gray-50">
                <Td className="font-medium text-gray-900">Ceiling</Td>
                {BUDGET_ACTION_TYPES.map((t) => <Td key={t} className="text-right tabular-nums font-medium">{ceilingByType.get(t)?.per_day ?? '—'}</Td>)}
              </tr>
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
