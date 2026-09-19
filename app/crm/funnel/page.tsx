'use client';

import { Fragment, useMemo, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useChannelCosts, useFunnel } from '@/lib/crm/queries';
import { STAGE_LABELS, fmtMoney, type DealStage, type FunnelChannel } from '@/lib/crm/types';
import { Button, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, fmtDate, todayISO } from '@/components/crm/ui';
import { useWrite } from '@/components/crm/forms';
import { cn } from '@/lib/utils';
import { ChevronDown, ChevronRight, Pencil } from 'lucide-react';

// Funnel tracker: one row per source channel — leads → conversion → cost → CAC → LTV → revenue.
// Everything is derived from deals; the only hand-entered number is monthly channel spend.

const FUNNEL_STAGES: Array<Exclude<DealStage, 'new' | 'lost'>> = ['contacted', 'replied', 'meeting_booked', 'meeting_held', 'proposal_sent', 'negotiation', 'won'];

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PRESETS: Array<{ key: string; label: string; range: () => { from: string; to: string } }> = [
  { key: 'month', label: 'This month', range: () => { const n = new Date(); return { from: iso(new Date(n.getFullYear(), n.getMonth(), 1)), to: todayISO() }; } },
  { key: 'last_month', label: 'Last month', range: () => { const n = new Date(); return { from: iso(new Date(n.getFullYear(), n.getMonth() - 1, 1)), to: iso(new Date(n.getFullYear(), n.getMonth(), 0)) }; } },
  { key: 'quarter', label: 'Last 3 months', range: () => { const n = new Date(); return { from: iso(new Date(n.getFullYear(), n.getMonth() - 2, 1)), to: todayISO() }; } },
  { key: 'year', label: 'This year', range: () => ({ from: `${new Date().getFullYear()}-01-01`, to: todayISO() }) },
  { key: 'all', label: 'All time', range: () => ({ from: '2000-01-01', to: todayISO() }) },
];

const EMPTY: Omit<FunnelChannel, 'source_channel_id' | 'slug' | 'label'> = {
  leads: 0, contacted: 0, replied: 0, meeting_booked: 0, meeting_held: 0, proposal_sent: 0, negotiation: 0, won: 0, lost: 0,
  won_value_monthly_usd: 0, won_customers: 0, revenue_usd: 0, cost_usd: null, cac_usd: null, ltv_usd: null, conversion_pct: {},
};

const pct = (n: number, of: number) => (of > 0 ? `${((100 * n) / of).toFixed(n === of || n === 0 ? 0 : 1)}%` : '—');

function SpendModal({ channel, month, open, onClose }: { channel: FunnelChannel | null; month: string; open: boolean; onClose: () => void }) {
  const { currencies, data } = useCrm();
  const { write, busy, error } = useWrite();
  const costs = useChannelCosts();
  const defCur = String(data?.settings?.default_currency ?? 'USD');
  const [f, setF] = useState({ month, cost: '', currency: defCur, notes: '' }); // remounted per channel (key) so this resets
  const rows = (costs.data ?? []).filter((c) => c.source_channel_id === channel?.source_channel_id);
  const save = async () => { if (!channel) return; const r = await write('set_channel_cost', { p_source_channel: channel.source_channel_id, p_month: `${f.month}-01`, p_cost: Number(f.cost), p_currency: f.currency, p_notes: f.notes || null }); if (r) setF({ ...f, cost: '', notes: '' }); };
  return (
    <Modal open={open} onClose={onClose} title={`Spend — ${channel?.label ?? ''}`} footer={<Button size="sm" variant="secondary" onClick={onClose}>Done</Button>}>
      <div className="flex items-end gap-2 flex-wrap">
        <Input label="Month" type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
        <Input label="Spend" type="number" min="0" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} className="w-28" autoFocus />
        <Select label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Input label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="w-40" />
        <Button size="sm" onClick={save} loading={busy} disabled={!f.month || f.cost === '' || Number(f.cost) < 0}>Save</Button>
      </div>
      <p className="text-[11px] text-gray-400 mt-1.5">One figure per channel per month — saving the same month again replaces it. Include salaries, tools and ad spend you attribute to this channel.</p>
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
      <div className="mt-3 border-t border-gray-100 pt-2">
        <div className="text-[11px] uppercase tracking-wide text-gray-500 mb-1">Entered so far</div>
        {rows.length === 0 ? <p className="text-sm text-gray-400">Nothing yet.</p> : (
          <ul className="text-sm divide-y divide-gray-100">
            {rows.map((c) => (
              <li key={c.id} className="py-1 flex items-center gap-2">
                <span className="w-24 text-gray-600">{fmtDate(c.month).replace(/^\d+\s/, '')}</span>
                <span className="tabular-nums font-medium text-gray-900">{fmtMoney(Number(c.cost), c.currency)}</span>
                <span className="text-gray-500 truncate flex-1">{c.notes}</span>
                <button className="text-xs text-indigo-700 hover:underline" onClick={() => setF({ month: c.month.slice(0, 7), cost: String(c.cost), currency: c.currency, notes: c.notes ?? '' })}>edit</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function StageBars({ c }: { c: FunnelChannel }) {
  return (
    <div className="grid grid-cols-[130px_1fr_150px] gap-x-3 gap-y-1 items-center text-xs max-w-3xl">
      <span className="text-gray-600">Leads</span>
      <div className="h-4 rounded bg-indigo-500" style={{ width: '100%' }} />
      <span className="tabular-nums text-gray-700">{c.leads}</span>
      {FUNNEL_STAGES.map((s, i) => {
        const n = c[s]; const prev = i === 0 ? c.leads : c[FUNNEL_STAGES[i - 1]];
        return (
          <Fragment key={s}>
            <span className="text-gray-600">{STAGE_LABELS[s]}</span>
            <div className="h-4 rounded bg-gray-100"><div className={cn('h-4 rounded', s === 'won' ? 'bg-green-500' : 'bg-indigo-400')} style={{ width: `${c.leads > 0 ? Math.max(n > 0 ? 2 : 0, (100 * n) / c.leads) : 0}%` }} /></div>
            <span className="tabular-nums text-gray-700">{n} <span className="text-gray-400">· {pct(n, prev)} of previous</span></span>
          </Fragment>
        );
      })}
      <span className="text-gray-600">Lost</span>
      <div className="h-4 rounded bg-gray-100"><div className="h-4 rounded bg-red-300" style={{ width: `${c.leads > 0 ? (100 * c.lost) / c.leads : 0}%` }} /></div>
      <span className="tabular-nums text-gray-700">{c.lost} <span className="text-gray-400">· {pct(c.lost, c.leads)} of leads</span></span>
    </div>
  );
}

export default function FunnelPage() {
  const { lookups, fxRates, data } = useCrm();
  const defCur = String(data?.settings?.default_currency ?? 'USD');
  const [preset, setPreset] = useState('year');
  const [range, setRange] = useState(() => PRESETS.find((p) => p.key === 'year')!.range());
  const [cur, setCur] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [spendFor, setSpendFor] = useState<FunnelChannel | null>(null);
  const q = useFunnel(range.from, range.to);

  const showCur = cur ?? defCur;
  const money = (usd: number | null | undefined) => (usd == null ? '—' : fmtMoney(Number(usd) / (fxRates[showCur] || 1), showCur));

  // Every active channel gets a row, even with nothing in the period — the sheet is meant to be filled in.
  const rows = useMemo<FunnelChannel[]>(() => {
    const got = q.data?.channels ?? [];
    const bySlug = new Map(got.map((c) => [c.slug, c]));
    const known = lookups('source_channel').map((l) => bySlug.get(l.slug) ?? { ...EMPTY, source_channel_id: l.id, slug: l.slug, label: l.label });
    const extra = got.filter((c) => !known.some((k) => k.slug === c.slug));
    return [...known, ...extra];
  }, [q.data, lookups]);

  const total = useMemo(() => {
    const sum = (k: 'leads' | 'won' | 'won_customers' | 'revenue_usd' | 'won_value_monthly_usd') => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
    const hasCost = rows.some((r) => r.cost_usd != null);
    const cost = hasCost ? rows.reduce((n, r) => n + Number(r.cost_usd ?? 0), 0) : null;
    const won = sum('won'); const customers = sum('won_customers'); const revenue = sum('revenue_usd');
    return { leads: sum('leads'), won, cost, cac: cost != null && won > 0 ? cost / won : null, ltv: customers > 0 ? revenue / customers : null, revenue, mrr: sum('won_value_monthly_usd') };
  }, [rows]);

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorBox message={(q.error as Error).message} />;

  const num = 'text-right tabular-nums whitespace-nowrap';
  return (
    <div className="space-y-3">
      <PageHeader title="Funnel" subtitle={`Deals created ${fmtDate(range.from)} – ${fmtDate(range.to)}, by source channel`}
        actions={<>
          <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5">
            {PRESETS.map((p) => <button key={p.key} onClick={() => { setPreset(p.key); setRange(p.range()); }} className={cn('px-2 py-1 rounded text-xs font-medium', preset === p.key ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{p.label}</button>)}
          </div>
          <input type="date" aria-label="From" value={range.from} max={range.to} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange({ ...range, from: e.target.value }); } }} className="px-2 py-1 text-xs rounded-md border border-gray-300" />
          <input type="date" aria-label="To" value={range.to} min={range.from} onChange={(e) => { if (e.target.value) { setPreset('custom'); setRange({ ...range, to: e.target.value }); } }} className="px-2 py-1 text-xs rounded-md border border-gray-300" />
          {defCur !== 'USD' && (
            <div className="flex items-center gap-0.5 rounded-md border border-gray-200 bg-white p-0.5">
              {[defCur, 'USD'].map((c) => <button key={c} onClick={() => setCur(c)} className={cn('px-2 py-1 rounded text-xs font-medium', showCur === c ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{c}</button>)}
            </div>
          )}
        </>} />

      <Table className={cn(q.isFetching && 'opacity-70')}>
        <thead>
          <tr><Th>Channel</Th><Th className="text-right"># Leads</Th><Th className="text-right">Conv.</Th><Th className="text-right">Cost</Th><Th className="text-right">CAC</Th><Th className="text-right">LTV</Th><Th className="text-right">Revenue</Th></tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const isOpen = open === c.slug; const empty = c.leads === 0 && c.cost_usd == null;
            const ratio = c.ltv_usd != null && c.cac_usd != null && c.cac_usd > 0 ? c.ltv_usd / c.cac_usd : null;
            return (
              <Fragment key={c.slug}>
                <tr className={cn('hover:bg-gray-50 cursor-pointer', empty && 'text-gray-400')} onClick={() => setOpen(isOpen ? null : c.slug)}>
                  <Td className="font-medium text-gray-900"><span className="inline-flex items-center gap-1">{isOpen ? <ChevronDown className="w-3.5 h-3.5 text-gray-400" /> : <ChevronRight className="w-3.5 h-3.5 text-gray-400" />}{c.label}</span></Td>
                  <Td className={num}>{c.leads}</Td>
                  <Td className={num}><span className="font-medium text-gray-900">{pct(c.won, c.leads)}</span><div className="text-[11px] text-gray-400">{c.won} won of {c.leads}</div></Td>
                  <Td className={num}>
                    {c.source_channel_id ? (
                      <button className="inline-flex items-center gap-1 hover:text-indigo-700 group" title="Enter monthly spend" onClick={(e) => { e.stopPropagation(); setSpendFor(c); }}>
                        {c.cost_usd == null ? <span className="text-amber-700 underline">add spend</span> : money(c.cost_usd)}<Pencil className="w-3 h-3 text-gray-300 group-hover:text-indigo-600" />
                      </button>
                    ) : '—'}
                  </Td>
                  <Td className={num}>{money(c.cac_usd)}{c.cost_usd != null && c.won === 0 && <div className="text-[11px] text-gray-400">no wins yet</div>}</Td>
                  <Td className={num}>{money(c.ltv_usd)}{ratio != null && <div className={cn('text-[11px]', ratio >= 3 ? 'text-green-700' : ratio >= 1 ? 'text-amber-700' : 'text-red-700')}>{ratio.toFixed(1)}× CAC</div>}</Td>
                  <Td className={num}><span className="font-medium text-gray-900">{c.won > 0 ? money(c.revenue_usd) : '—'}</span>{c.won > 0 && <div className="text-[11px] text-gray-400">{money(c.won_value_monthly_usd)}/mo now</div>}</Td>
                </tr>
                {isOpen && <tr className="bg-gray-50/70"><Td colSpan={7} className="px-5 py-3">{c.leads > 0 ? <StageBars c={c} /> : <span className="text-sm text-gray-400">No deals from this channel were created in this period.</span>}</Td></tr>}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="bg-gray-50 font-semibold text-gray-900">
            <Td className="border-b-0">Total</Td><Td className={cn(num, 'border-b-0')}>{total.leads}</Td><Td className={cn(num, 'border-b-0')}>{pct(total.won, total.leads)}</Td>
            <Td className={cn(num, 'border-b-0')}>{money(total.cost)}</Td><Td className={cn(num, 'border-b-0')}>{money(total.cac)}</Td><Td className={cn(num, 'border-b-0')}>{money(total.ltv)}</Td>
            <Td className={cn(num, 'border-b-0')}>{total.won > 0 ? money(total.revenue) : '—'}{total.won > 0 && <div className="text-[11px] font-normal text-gray-400">{money(total.mrr)}/mo now</div>}</Td>
          </tr>
        </tfoot>
      </Table>

      <div className="text-xs text-gray-500 space-y-0.5 px-1">
        <p><span className="font-medium text-gray-700">Leads</span> = deals created in the period. <span className="font-medium text-gray-700">Conv.</span> = won ÷ leads (click a row for stage-by-stage). <span className="font-medium text-gray-700">Cost</span> = the monthly spend you enter for the months in the period. <span className="font-medium text-gray-700">CAC</span> = cost ÷ won deals.</p>
        <p><span className="font-medium text-gray-700">Revenue</span> = each won deal&apos;s monthly value × months since it was won (the month it was won counts; a won deal is assumed still active). <span className="font-medium text-gray-700">LTV</span> = that revenue per won customer, so it grows as clients stay. Amounts are converted with the rates in Settings.</p>
      </div>

      <SpendModal key={spendFor?.slug ?? 'closed'} channel={spendFor} month={range.to.slice(0, 7)} open={!!spendFor} onClose={() => setSpendFor(null)} />
    </div>
  );
}
