'use client';

import { useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useChannelCosts } from '@/lib/crm/queries';
import type { Lookup, LookupKind } from '@/lib/crm/types';
import { Badge, Button, Card, ErrorBox, Input, PageHeader, Select, Table, Td, Th, fmtDate } from '@/components/crm/ui';
import { TZ_OPTIONS, useWrite } from '@/components/crm/forms';
import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Small settings screen for the lookup lists, team, timezone, FX and channel spend.
// Adding a new ICP segment or channel must never require a developer.

const KINDS: Array<{ kind: LookupKind; title: string; hint: string }> = [
  { kind: 'icp_segment', title: 'ICP segments', hint: 'Deactivate instead of deleting so old deals keep their segment.' },
  { kind: 'source_channel', title: 'Source channels', hint: 'New channels appear in the scoreboard automatically.' },
  { kind: 'activity_type', title: 'Activity types', hint: '"Counts as" tells the scoreboard what the type feeds.' },
];
const COUNTS_AS = ['', 'dial', 'linkedin_message', 'linkedin_connect', 'email', 'meeting'];

function LookupCard({ kind, title, hint }: { kind: LookupKind; title: string; hint: string }) {
  const { lookups } = useCrm();
  const { write, busy, error } = useWrite();
  const rows = lookups(kind, true);
  const [label, setLabel] = useState('');
  const [countsAs, setCountsAs] = useState('');
  const [editing, setEditing] = useState<{ slug: string; label: string } | null>(null);

  const save = (args: Record<string, unknown>) => write('lookup_save', { p_kind: kind, p_label: args.label ?? null, p_slug: args.slug ?? null, p_sort_order: null, p_is_active: args.is_active ?? null, p_notes: null, p_counts_as: args.counts_as ?? null }, { refreshContext: true });
  const add = async () => { if (!label.trim()) return; const r = await save({ label: label.trim(), counts_as: kind === 'activity_type' ? countsAs || null : null }); if (r) { setLabel(''); setCountsAs(''); } };
  const move = async (i: number, dir: -1 | 1) => {
    const order = rows.map((r) => r.slug); const j = i + dir; if (j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    await write('lookup_reorder', { p_kind: kind, p_slugs: order }, { refreshContext: true });
  };
  const rename = async () => { if (!editing) return; const r = await save({ slug: editing.slug, label: editing.label }); if (r) setEditing(null); };

  return (
    <Card title={title} dense>
      <ul className="divide-y divide-gray-100">
        {rows.map((r: Lookup, i) => (
          <li key={r.id} className={cn('px-3 py-1.5 flex items-center gap-2 text-sm', !r.is_active && 'opacity-50')}>
            <div className="flex flex-col"><button className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="w-3 h-3" /></button><button className="p-0.5 text-gray-400 hover:text-gray-700 disabled:opacity-30" disabled={i === rows.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="w-3 h-3" /></button></div>
            <div className="flex-1 min-w-0">
              {editing?.slug === r.slug ? <input autoFocus className="w-full px-2 py-1 text-sm rounded border border-gray-300" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditing(null); }} onBlur={rename} /> : <button className="text-left font-medium text-gray-900 hover:text-indigo-700" onClick={() => setEditing({ slug: r.slug, label: r.label })} title="Click to rename">{r.label}</button>}
              <div className="text-[11px] text-gray-400">{r.slug}{kind === 'activity_type' && r.counts_as ? ` · counts as ${r.counts_as}` : ''}</div>
            </div>
            {kind === 'activity_type' && <select className="text-xs border border-gray-300 rounded px-1 py-0.5" value={r.counts_as ?? ''} disabled={busy} onChange={(e) => save({ slug: r.slug, counts_as: e.target.value || null })}>{COUNTS_AS.map((c) => <option key={c} value={c}>{c || 'counts as —'}</option>)}</select>}
            <button className="text-xs" disabled={busy} onClick={() => save({ slug: r.slug, is_active: !r.is_active })}><Badge tone={r.is_active ? 'green' : 'gray'}>{r.is_active ? 'active' : 'inactive'}</Badge></button>
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 border-t border-gray-100 flex items-end gap-2">
        <Input label={`Add ${title.toLowerCase().replace(/s$/, '')}`} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="flex-1" />
        {kind === 'activity_type' && <Select label="Counts as" value={countsAs} onChange={(e) => setCountsAs(e.target.value)}>{COUNTS_AS.map((c) => <option key={c} value={c}>{c || '—'}</option>)}</Select>}
        <Button size="sm" onClick={add} loading={busy} disabled={!label.trim()}><Plus className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="px-3 pb-2 text-[11px] text-gray-400">{hint}</div>
      {error && <div className="px-3 pb-2"><ErrorBox message={error} /></div>}
    </Card>
  );
}

function TeamCard() {
  const { members, me } = useCrm();
  const { write, busy, error } = useWrite();
  const [email, setEmail] = useState(''); const [name, setName] = useState('');
  const add = async () => { const r = await write('add_member', { p_email: email.trim(), p_display_name: name.trim() || null }, { refreshContext: true }); if (r) { setEmail(''); setName(''); } };
  return (
    <Card title="Team" dense>
      <ul className="divide-y divide-gray-100">
        {members.map((m) => (
          <li key={m.user_id} className={cn('px-3 py-1.5 flex items-center gap-2 text-sm', !m.is_active && 'opacity-50')}>
            <div className="flex-1 min-w-0"><input className="font-medium text-gray-900 bg-transparent border-b border-transparent hover:border-gray-300 focus:border-indigo-500 focus:outline-none w-full" defaultValue={m.display_name} onBlur={(e) => { if (e.target.value.trim() && e.target.value !== m.display_name) write('set_member', { p_user_id: m.user_id, p_display_name: e.target.value.trim(), p_is_active: null }, { refreshContext: true }); }} /><div className="text-[11px] text-gray-400">{m.email}{m.user_id === me?.user_id ? ' · you' : ''}</div></div>
            <button disabled={busy} onClick={() => write('set_member', { p_user_id: m.user_id, p_display_name: null, p_is_active: !m.is_active }, { refreshContext: true })}><Badge tone={m.is_active ? 'green' : 'gray'}>{m.is_active ? 'active' : 'inactive'}</Badge></button>
          </li>
        ))}
      </ul>
      <div className="px-3 py-2 border-t border-gray-100 flex items-end gap-2">
        <Input label="Email of an existing CapitalxAI account" value={email} onChange={(e) => setEmail(e.target.value)} className="flex-1" />
        <Input label="Display name" value={name} onChange={(e) => setName(e.target.value)} className="w-36" />
        <Button size="sm" onClick={add} loading={busy} disabled={!email.includes('@')}><Plus className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="px-3 pb-2 text-[11px] text-gray-400">Everyone on the team sees everything. Click a name to rename; toggle to deactivate.</div>
      {error && <div className="px-3 pb-2"><ErrorBox message={error} /></div>}
    </Card>
  );
}

function GeneralCard() {
  const { data, timezone, staleAfterDays, currencies } = useCrm();
  const { write, busy, error } = useWrite();
  const s = data?.settings ?? {};
  const [tz, setTz] = useState(timezone);
  const [stale, setStale] = useState(String(staleAfterDays));
  const [cur, setCur] = useState((s.default_currency as string) ?? 'USD');
  const [studio, setStudio] = useState((s.studio_name as string) ?? '');
  const set = (k: string, v: unknown) => write('set_setting', { p_key: k, p_value: v }, { refreshContext: true });
  return (
    <Card title="General">
      <div className="grid grid-cols-2 gap-3">
        <div className="flex items-end gap-2"><div className="flex-1"><label className="block"><span className="block text-xs font-medium text-gray-600 mb-1">Team timezone (day boundaries)</span><input list="crm-tz-s" className="w-full px-2.5 py-1.5 text-sm rounded-md border border-gray-300" value={tz} onChange={(e) => setTz(e.target.value)} /><datalist id="crm-tz-s">{TZ_OPTIONS.map((t) => <option key={t} value={t} />)}</datalist></label></div><Button size="sm" variant="secondary" loading={busy} onClick={() => set('default_timezone', tz)}>Save</Button></div>
        <div className="flex items-end gap-2"><Input label="Stale after (days without activity)" type="number" value={stale} onChange={(e) => setStale(e.target.value)} className="flex-1" /><Button size="sm" variant="secondary" loading={busy} onClick={() => set('stale_after_days', Number(stale))}>Save</Button></div>
        <div className="flex items-end gap-2"><Select label="Default currency for new deals" value={cur} onChange={(e) => setCur(e.target.value)} className="flex-1">{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select><Button size="sm" variant="secondary" loading={busy} onClick={() => set('default_currency', cur)}>Save</Button></div>
        <div className="flex items-end gap-2"><Input label="Studio name" value={studio} onChange={(e) => setStudio(e.target.value)} className="flex-1" /><Button size="sm" variant="secondary" loading={busy} onClick={() => set('studio_name', studio)}>Save</Button></div>
      </div>
      {error && <div className="mt-2"><ErrorBox message={error} /></div>}
    </Card>
  );
}

function FxCard() {
  const { fxRates } = useCrm();
  const { write, busy, error } = useWrite();
  const [cur, setCur] = useState(''); const [rate, setRate] = useState('');
  const save = async (c: string, r: string) => { const ok = await write('set_fx_rate', { p_currency: c.toUpperCase(), p_usd_per_unit: Number(r) }, { refreshContext: true }); if (ok) { setCur(''); setRate(''); } };
  return (
    <Card title="Currencies (USD per unit)" dense>
      <ul className="divide-y divide-gray-100">
        {Object.entries(fxRates).sort().map(([c, r]) => (
          <li key={c} className="px-3 py-1.5 flex items-center gap-2 text-sm"><span className="font-medium w-12">{c}</span><input type="number" step="0.0001" className="w-28 px-2 py-1 text-sm rounded border border-gray-300 tabular-nums" defaultValue={r} onBlur={(e) => { if (Number(e.target.value) > 0 && Number(e.target.value) !== r) save(c, e.target.value); }} /><span className="text-xs text-gray-400">1 {c} = {r} USD</span></li>
        ))}
      </ul>
      <div className="px-3 py-2 border-t border-gray-100 flex items-end gap-2">
        <Input label="Code" value={cur} onChange={(e) => setCur(e.target.value)} placeholder="SGD" className="w-24 uppercase" maxLength={3} />
        <Input label="USD per unit" type="number" step="0.0001" value={rate} onChange={(e) => setRate(e.target.value)} className="w-32" />
        <Button size="sm" onClick={() => save(cur, rate)} loading={busy} disabled={cur.length !== 3 || !(Number(rate) > 0)}><Plus className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="px-3 pb-2 text-[11px] text-gray-400">Values are always stored with their currency; rates only drive the USD totals. Changing a rate recomputes existing deals.</div>
      {error && <div className="px-3 pb-2"><ErrorBox message={error} /></div>}
    </Card>
  );
}

function CostsCard() {
  const { lookups, lookupLabel, currencies } = useCrm();
  const { write, busy, error } = useWrite();
  const costs = useChannelCosts();
  const chans = lookups('source_channel');
  const [f, setF] = useState({ channel: '', month: new Date().toISOString().slice(0, 7), cost: '', currency: 'USD', notes: '' });
  const save = async () => { const r = await write('set_channel_cost', { p_source_channel: f.channel, p_month: `${f.month}-01`, p_cost: Number(f.cost), p_currency: f.currency, p_notes: f.notes || null }); if (r) setF({ ...f, cost: '', notes: '' }); };
  return (
    <Card title="Channel spend (feeds funnel cost / CAC)" dense>
      <div className="px-3 py-2 flex items-end gap-2 flex-wrap border-b border-gray-100">
        <Select label="Channel" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}><option value="">—</option>{chans.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
        <Input label="Month" type="month" value={f.month} onChange={(e) => setF({ ...f, month: e.target.value })} />
        <Input label="Spend" type="number" value={f.cost} onChange={(e) => setF({ ...f, cost: e.target.value })} className="w-28" />
        <Select label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}>{currencies.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <Input label="Notes" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} className="w-40" />
        <Button size="sm" onClick={save} loading={busy} disabled={!f.channel || !f.month || f.cost === ''}>Save</Button>
      </div>
      {costs.data && costs.data.length > 0 && (
        <Table className="border-0 rounded-none">
          <thead><tr><Th>Month</Th><Th>Channel</Th><Th>Spend</Th><Th>Notes</Th></tr></thead>
          <tbody>{costs.data.map((c) => <tr key={c.id}><Td>{fmtDate(c.month)}</Td><Td>{lookupLabel('source_channel', c.source_channel_id)}</Td><Td className="tabular-nums">{c.currency} {Number(c.cost).toLocaleString()}</Td><Td className="text-gray-500">{c.notes}</Td></tr>)}</tbody>
        </Table>
      )}
      {error && <div className="px-3 py-2"><ErrorBox message={error} /></div>}
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-3">
      <PageHeader title="Settings" subtitle="Lookup lists, team, timezone, currencies, channel spend. Same operations are available to the Claude connector." />
      <div className="grid lg:grid-cols-3 gap-3">{KINDS.map((k) => <LookupCard key={k.kind} {...k} />)}</div>
      <div className="grid lg:grid-cols-2 gap-3"><TeamCard /><GeneralCard /></div>
      <div className="grid lg:grid-cols-2 gap-3"><FxCard /><CostsCard /></div>
    </div>
  );
}
