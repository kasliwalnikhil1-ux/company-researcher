'use client';

import { useEffect, useState } from 'react';
import { useCrm } from '@/contexts/CrmContext';
import { useChannelCosts } from '@/lib/crm/queries';
import type { Lookup, LookupKind, Member } from '@/lib/crm/types';
import { Badge, Button, Card, ErrorBox, Input, PageHeader, Select, Table, Td, Th, fmtDate } from '@/components/crm/ui';
import { TZ_OPTIONS, useWrite } from '@/components/crm/forms';
import { ArrowDown, ArrowUp, Pencil, Plus, UserPlus } from 'lucide-react';
import { cn } from '@/lib/utils';

// Small settings screen for the lookup lists, team, timezone, FX and channel spend.
// Adding a new ICP segment or channel must never require a developer.

const KINDS: Array<{ kind: LookupKind; title: string; hint: string }> = [
  { kind: 'icp_segment', title: 'ICP segments', hint: 'Deactivate instead of deleting so old deals keep their segment.' },
  { kind: 'source_channel', title: 'Source channels', hint: 'New channels appear in the scoreboard automatically.' },
  { kind: 'activity_type', title: 'Activity types', hint: '"Counts as" tells the scoreboard what the type feeds.' },
];
const COUNTS_AS = ['', 'dial', 'linkedin_message', 'linkedin_connect', 'email', 'meeting'];

// One panel for the three lookup lists: count tabs on top, one scrolling list below.
function LookupsCard() {
  const { lookups } = useCrm();
  const [kind, setKind] = useState<LookupKind>('icp_segment');
  const active = KINDS.find((k) => k.kind === kind) ?? KINDS[0];
  return (
    <Card dense title="Lists" actions={
      <div className="flex items-center gap-1 flex-wrap justify-end">
        {KINDS.map((k) => (
          <button key={k.kind} onClick={() => setKind(k.kind)} className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors', k.kind === kind ? 'bg-indigo-50 text-indigo-800 border-indigo-200' : 'border-transparent text-gray-600 hover:bg-gray-100')}>
            {k.title} <span className="tabular-nums font-bold">{lookups(k.kind, true).length}</span>
          </button>
        ))}
      </div>
    }>
      <LookupList key={active.kind} {...active} />
    </Card>
  );
}

function LookupList({ kind, title, hint }: { kind: LookupKind; title: string; hint: string }) {
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
    <>
      <ul className="divide-y divide-gray-100 max-h-[420px] overflow-auto">
        {rows.length === 0 && <li className="px-3 py-6 text-sm text-gray-400 text-center">Nothing here yet — add the first one below.</li>}
        {rows.map((r: Lookup, i) => (
          <li key={r.id} className="group px-3 py-2 flex items-center gap-3 text-sm hover:bg-gray-50">
            <span className="w-5 text-right text-xs tabular-nums text-gray-400 flex-shrink-0">{i + 1}</span>
            <div className="flex items-center flex-shrink-0 opacity-40 group-hover:opacity-100 focus-within:opacity-100 transition-opacity"><button className="p-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-transparent" disabled={i === 0 || busy} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp className="w-3.5 h-3.5" /></button><button className="p-1 rounded text-gray-500 hover:text-gray-900 hover:bg-gray-200 disabled:opacity-30 disabled:hover:bg-transparent" disabled={i === rows.length - 1 || busy} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown className="w-3.5 h-3.5" /></button></div>
            <div className={cn('flex-1 min-w-0', !r.is_active && 'opacity-50')}>
              {editing?.slug === r.slug ? <input autoFocus className="w-full px-2 py-1 text-sm rounded border border-gray-300 focus:outline-none focus:ring-2 focus:ring-indigo-500/30 focus:border-indigo-500" value={editing.label} onChange={(e) => setEditing({ ...editing, label: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setEditing(null); }} onBlur={rename} /> : (
                <button className="max-w-full flex items-center gap-1.5 text-left font-medium text-gray-900 hover:text-indigo-700" onClick={() => setEditing({ slug: r.slug, label: r.label })} title="Click to rename"><span className="truncate">{r.label}</span><Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100 flex-shrink-0" aria-hidden /></button>
              )}
              <div className="text-[11px] text-gray-400 font-mono truncate">{r.slug}</div>
            </div>
            {kind === 'activity_type' && (
              <label className="flex items-center gap-1.5 text-[11px] text-gray-500 flex-shrink-0">counts as
                <select className={cn('text-xs border rounded-md px-1.5 py-1 bg-white', r.counts_as ? 'border-indigo-200 text-indigo-800 font-medium' : 'border-gray-300 text-gray-500')} value={r.counts_as ?? ''} disabled={busy} onChange={(e) => save({ slug: r.slug, counts_as: e.target.value || null })}>{COUNTS_AS.map((c) => <option key={c} value={c}>{c ? c.replace(/_/g, ' ') : 'nothing'}</option>)}</select>
              </label>
            )}
            <span className={cn('text-[11px] font-medium w-12 text-right flex-shrink-0', r.is_active ? 'text-green-700' : 'text-gray-400')}>{r.is_active ? 'Active' : 'Inactive'}</span>
            <button type="button" role="switch" aria-checked={r.is_active} aria-label={`${r.label} is ${r.is_active ? 'active' : 'inactive'}`} title={r.is_active ? 'Deactivate — hides it from pickers, keeps history' : 'Reactivate'} disabled={busy} onClick={() => save({ slug: r.slug, is_active: !r.is_active })} className={cn('relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:opacity-50', r.is_active ? 'bg-green-500' : 'bg-gray-300')}>
              <span className={cn('absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform', r.is_active && 'translate-x-[14px]')} />
            </button>
          </li>
        ))}
      </ul>
      <div className="px-3 py-2.5 border-t border-gray-100 bg-gray-50/60 flex items-end gap-2">
        <Input label={`Add ${title.toLowerCase().replace(/s$/, '')}`} value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} className="flex-1" />
        {kind === 'activity_type' && <Select label="Counts as" value={countsAs} onChange={(e) => setCountsAs(e.target.value)}>{COUNTS_AS.map((c) => <option key={c} value={c}>{c ? c.replace(/_/g, ' ') : '—'}</option>)}</Select>}
        <Button size="sm" onClick={add} loading={busy} disabled={!label.trim()}><Plus className="w-3.5 h-3.5" /> Add</Button>
      </div>
      <div className="px-3 py-2 text-[11px] text-gray-400">{hint} Click a name to rename it; arrows change the order in pickers.</div>
      {error && <div className="px-3 pb-2"><ErrorBox message={error} /></div>}
    </>
  );
}

const AVATAR_TONES = ['bg-indigo-100 text-indigo-700', 'bg-emerald-100 text-emerald-700', 'bg-amber-100 text-amber-800', 'bg-pink-100 text-pink-700', 'bg-sky-100 text-sky-700', 'bg-purple-100 text-purple-700'];
const initials = (name: string) => { const p = name.trim().split(/[\s._-]+/).filter(Boolean); return ((p.length > 1 ? p[0][0] + p[1][0] : name.trim().slice(0, 2)) || '?').toUpperCase(); };
const avatarTone = (key: string) => AVATAR_TONES[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR_TONES.length];

function MemberRow({ m, isMe, busy, onRename, onToggle }: { m: Member; isMe: boolean; busy: boolean; onRename: (name: string) => void; onToggle: () => void }) {
  const [name, setName] = useState(m.display_name);
  useEffect(() => setName(m.display_name), [m.display_name]);
  const commit = () => { const v = name.trim(); if (v && v !== m.display_name) onRename(v); else setName(m.display_name); };
  return (
    <li className="group px-3 py-2 flex items-center gap-3 text-sm hover:bg-gray-50">
      <div className={cn('w-8 h-8 rounded-full flex items-center justify-center text-[11px] font-semibold flex-shrink-0', m.is_active ? avatarTone(m.email ?? m.user_id) : 'bg-gray-100 text-gray-400')}>{initials(m.display_name)}</div>
      <div className={cn('flex-1 min-w-0', !m.is_active && 'opacity-60')}>
        <div className="flex items-center gap-1.5">
          {/* Hidden mirror span sizes the input to its text so the pencil / You badge sit right after the name. */}
          <span className="inline-grid min-w-0 -mx-1 font-medium">
            <span aria-hidden className="invisible col-start-1 row-start-1 whitespace-pre px-1 py-0.5 border border-transparent min-w-[3rem] overflow-hidden">{name || ' '}</span>
            <input aria-label={`Display name for ${m.email ?? m.display_name}`} size={1} className="col-start-1 row-start-1 w-full min-w-0 font-medium text-gray-900 bg-transparent rounded px-1 py-0.5 border border-transparent hover:border-gray-300 focus:border-indigo-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500/30" value={name} onChange={(e) => setName(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setName(m.display_name); e.currentTarget.blur(); } }} />
          </span>
          <Pencil className="w-3 h-3 text-gray-300 opacity-0 group-hover:opacity-100 flex-shrink-0" aria-hidden />
          {isMe && <Badge tone="indigo">You</Badge>}
        </div>
        <div className="text-xs text-gray-500 truncate">{m.email}</div>
      </div>
      <span className={cn('text-[11px] font-medium w-12 text-right', m.is_active ? 'text-green-700' : 'text-gray-400')}>{m.is_active ? 'Active' : 'Inactive'}</span>
      <button type="button" role="switch" aria-checked={m.is_active} aria-label={`${m.display_name} is ${m.is_active ? 'active' : 'inactive'}`} title={m.is_active ? 'Deactivate — removes CRM access, keeps their history' : 'Reactivate'} disabled={busy} onClick={onToggle} className={cn('relative w-8 h-[18px] rounded-full transition-colors flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 disabled:opacity-50', m.is_active ? 'bg-green-500' : 'bg-gray-300')}>
        <span className={cn('absolute top-0.5 left-0.5 w-3.5 h-3.5 rounded-full bg-white shadow transition-transform', m.is_active && 'translate-x-[14px]')} />
      </button>
    </li>
  );
}

function TeamCard() {
  const { members, me } = useCrm();
  const { write, busy, error } = useWrite();
  const [adding, setAdding] = useState(false);
  const [email, setEmail] = useState(''); const [name, setName] = useState('');
  const emailOk = /^\S+@\S+\.\S+$/.test(email.trim());
  const add = async () => { if (!emailOk) return; const r = await write('add_member', { p_email: email.trim(), p_display_name: name.trim() || null }, { refreshContext: true }); if (r) { setEmail(''); setName(''); setAdding(false); } };
  const toggle = (m: Member) => {
    if (m.is_active && m.user_id === me?.user_id && !window.confirm('Deactivate yourself? You will lose access to the CRM until a teammate reactivates you.')) return;
    write('set_member', { p_user_id: m.user_id, p_display_name: null, p_is_active: !m.is_active }, { refreshContext: true });
  };
  // You first, then active, then inactive — each alphabetical.
  const rank = (m: Member) => (m.user_id === me?.user_id ? 0 : m.is_active ? 1 : 2);
  const sorted = [...members].sort((a, b) => rank(a) - rank(b) || a.display_name.localeCompare(b.display_name));
  const active = members.filter((m) => m.is_active).length;
  return (
    <Card title={<>Team <span className="ml-1 font-normal normal-case tracking-normal text-gray-400">{active} active{members.length > active ? ` · ${members.length - active} inactive` : ''}</span></>} actions={!adding && <Button size="xs" variant="secondary" onClick={() => setAdding(true)}><UserPlus className="w-3.5 h-3.5" /> Add teammate</Button>} dense>
      {adding && (
        <form className="px-3 py-2.5 bg-indigo-50/50 border-b border-gray-100" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <div className="flex items-end gap-2 flex-wrap">
            <div className="flex-1 min-w-[180px]"><Input autoFocus label="Email" type="email" placeholder="teammate@company.com" value={email} onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} /></div>
            <div className="w-40"><Input label="Display name (optional)" placeholder="e.g. Nikhil" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} /></div>
            <Button size="sm" type="submit" loading={busy} disabled={!emailOk}>Add</Button>
            <Button size="sm" type="button" variant="ghost" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
          <div className="mt-1.5 text-[11px] text-gray-500">They need an existing CapitalxAI account with this email. New teammates can see and edit everything.</div>
        </form>
      )}
      <ul className="divide-y divide-gray-100">
        {sorted.map((m) => <MemberRow key={m.user_id} m={m} isMe={m.user_id === me?.user_id} busy={busy} onRename={(v) => write('set_member', { p_user_id: m.user_id, p_display_name: v, p_is_active: null }, { refreshContext: true })} onToggle={() => toggle(m)} />)}
      </ul>
      <div className="px-3 py-2 border-t border-gray-100 text-[11px] text-gray-400">Everyone on the team sees everything. Click a name to rename it; deactivated teammates keep their history but lose access.</div>
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
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start"><LookupsCard /><TeamCard /></div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-start"><GeneralCard /><FxCard /></div>
      <CostsCard />
    </div>
  );
}
