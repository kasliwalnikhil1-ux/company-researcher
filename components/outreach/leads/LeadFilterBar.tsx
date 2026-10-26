'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LeadFilters } from '@/lib/outreach/queries';
import type { IntelLeadFilters, TimeInRole } from '@/lib/outreach/intel';
import { CHANNEL_PROVIDERS, type Client, type LeadKind, type LeadOrigin, type LeadStatus, type List, type Provider, type RelationSource, type Sender, type Stage, type Tag } from '@/lib/outreach/types';
import { channelLabel } from '@/lib/outreach/channels';
import { Button, Input, Modal } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Bookmark, BookmarkPlus, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ToastFn } from './helpers';
import { usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { kv } from '@/lib/outreach/storage';
import { KIND_LABEL, LEAD_STATUSES, ORIGIN_LABEL, SOURCE_FILTER_LABEL, STATUS_META } from '@/lib/outreach/leadsRelationships';
import SenderMultiSelect from '@/components/outreach/inbox/filters/SenderMultiSelect';
import { MENU_ATTR } from '@/components/outreach/inbox/filters/AnchoredMenu';

/** The tab is not a filter: it lives in the URL (page.tsx) and is sent alongside these. */
export type ViewFilters = Pick<LeadFilters, 'search' | 'client_id' | 'list_id' | 'stage_id' | 'tag_id' | 'dnc'> & Omit<IntelLeadFilters, 'tab'>;
export interface SavedView { id: string; name: string; filters: ViewFilters }

export const EMPTY_FILTERS: ViewFilters = {
  search: '', client_id: null, list_id: null, stage_id: null, tag_id: null, dnc: null, channel: null,
  enriched: null, replied: null, posted_30d: null, min_followers: null, time_in_role: null, past_company: null, skill: null, language: null,
  // 094
  hidden: null, status: null, connected_via: null, pending_with: null, not_connected: null, connection_source: null, channel_used: null, channel_replied: null, origin: null, kind: null, include_removed: null,
};
const FILTER_KEYS = Object.keys(EMPTY_FILTERS) as (keyof ViewFilters)[];
const BOOL_KEYS: (keyof ViewFilters)[] = ['dnc', 'enriched', 'replied', 'posted_30d', 'hidden', 'not_connected', 'include_removed'];
const LIST_KEYS: (keyof ViewFilters)[] = ['status', 'connected_via', 'pending_with', 'origin', 'kind'];
const TIME_IN_ROLE_VALUES: TimeInRole[] = ['lt6', '6to12', '1to3', 'gt3'];
const TIME_IN_ROLE_LABEL: Record<string, string> = { lt6: 'Under 6 months', '6to12': '6 to 12 months', '1to3': '1 to 3 years', gt3: 'Over 3 years' };
const SOURCES: RelationSource[] = ['our_invite', 'their_invite', 'pre_existing', 'unknown'];
const ORIGINS: LeadOrigin[] = ['import', 'manual', 'api', 'search', 'inbound'];
const KINDS: LeadKind[] = ['person', 'company_page', 'automated'];
const ALL_CHANNELS: Provider[] = ['LINKEDIN', 'INSTAGRAM', 'WHATSAPP', 'GMAIL'];
const channelFilterLabel = (p: Provider | string) => (p === 'GMAIL' || p === 'OUTLOOK' || p === 'IMAP' ? 'Email' : channelLabel(p));
const isSet = (v: unknown) => v != null && v !== '' && v !== false && !(Array.isArray(v) && v.length === 0);

function storageKey(ws: string) { return `outreach-lead-views:${ws}`; }

export function useSavedViews(ws: string | undefined) {
  const [views, setViews] = useState<SavedView[]>([]);
  useEffect(() => {
    if (!ws) return;
    try {
      const raw = kv.getItem(storageKey(ws));
      const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
      setViews(Array.isArray(parsed) ? parsed.filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.filters) : []);
    } catch { setViews([]); }
  }, [ws]);
  const persist = useCallback((next: SavedView[]) => {
    setViews(next);
    if (!ws) return;
    try { kv.setItem(storageKey(ws), JSON.stringify(next)); } catch { /* storage unavailable */ }
  }, [ws]);
  const save = useCallback((name: string, filters: ViewFilters) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    persist([...views, { id, name, filters }]);
    return id;
  }, [views, persist]);
  const remove = useCallback((id: string) => persist(views.filter((v) => v.id !== id)), [views, persist]);
  return { views, save, remove };
}

// ---------------------------------------------------------------------------
// Remembered filters (per workspace, this browser). The search text is not remembered.
// ---------------------------------------------------------------------------

/** Only accepts known keys with the right shape, so a stale or hand-edited entry cannot break the page. */
function sanitizeStored(raw: unknown): ViewFilters {
  const out: ViewFilters = { ...EMPTY_FILTERS };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  const o = out as Record<string, unknown>;
  for (const k of FILTER_KEYS) {
    if (k === 'search') continue;
    const v = r[k];
    if (v == null) continue;
    if (BOOL_KEYS.includes(k)) { if (typeof v === 'boolean') o[k] = v; }
    else if (LIST_KEYS.includes(k)) {
      if (!Array.isArray(v)) continue;
      const allowed: readonly string[] | null = k === 'status' ? LEAD_STATUSES : k === 'origin' ? ORIGINS : k === 'kind' ? KINDS : null;
      const list = v.filter((x): x is string => typeof x === 'string' && !!x.trim() && (!allowed || allowed.includes(x)));
      if (list.length) o[k] = list;
    }
    else if (k === 'min_followers') { if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.min_followers = v; }
    else if (k === 'time_in_role') { if (typeof v === 'string' && TIME_IN_ROLE_VALUES.includes(v as TimeInRole)) out.time_in_role = v as TimeInRole; }
    else if (k === 'channel' || k === 'channel_used' || k === 'channel_replied') { if (typeof v === 'string' && ALL_CHANNELS.includes(v as Provider)) o[k] = v; }
    else if (k === 'connection_source') { if (typeof v === 'string' && SOURCES.includes(v as RelationSource)) out.connection_source = v as RelationSource; }
    else if (typeof v === 'string' && v.trim()) o[k] = v;
  }
  return out;
}

/**
 * Lead filters that survive navigation: stored in localStorage per workspace and restored when the page opens again.
 * `ready` is false until the stored filters for the current workspace have been read, so the list is not fetched unfiltered first.
 */
export function usePersistedLeadFilters(ws: string | undefined) {
  const { filters, setFilters, ready } = usePersistedFilters<ViewFilters>('leads', ws, EMPTY_FILTERS, { sanitize: sanitizeStored, omit: ['search'] });
  return { filters, setFilters, ready };
}

export function isFilterEmpty(f: ViewFilters): boolean {
  return FILTER_KEYS.every((k) => (k === 'dnc' || k === 'enriched' || k === 'replied' ? f[k] == null : !isSet(f[k])));
}

function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  const norm = (v: unknown) => (v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0) ? null : Array.isArray(v) ? [...v].sort().join(',') : v);
  return FILTER_KEYS.every((k) => (k === 'dnc' || k === 'enriched' || k === 'replied' ? (a[k] ?? null) === (b[k] ?? null) : norm(a[k]) === norm(b[k])));
}

/** Toggle one value in a list filter. */
function toggleIn<T extends string>(list: T[] | null | undefined, v: T): T[] | null {
  const next = (list ?? []).includes(v) ? (list ?? []).filter((x) => x !== v) : [...(list ?? []), v];
  return next.length ? next : null;
}

const yesNo = (v: boolean | null | undefined) => (v == null ? '' : v ? 'yes' : 'no');
const fromYesNo = (v: string) => (v === '' ? null : v === 'yes');
const fieldCls = (on: boolean) => cn('w-full text-sm rounded-md border bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500', on ? 'border-indigo-300 text-gray-900' : 'border-gray-200 text-gray-600');

function FilterSelect({ label, value, onChange, title, children }: { label: string; value: string; onChange: (v: string) => void; title?: string; children: React.ReactNode }) {
  return (
    <label className="block min-w-0" title={title}>
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldCls(!!value)}>{children}</select>
    </label>
  );
}

/** Text inputs of the filters apply after a short pause, like the search box (and right away if the popover closes first). */
function FilterText({ label, value, onCommit, ...rest }: { label: string; value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value);
  const pending = useRef<{ v: string; commit: (v: string) => void } | null>(null);
  useEffect(() => { pending.current = v !== value ? { v, commit: onCommit } : null; });
  useEffect(() => { setV(value); }, [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onCommit(v), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  useEffect(() => () => { if (pending.current) pending.current.commit(pending.current.v); }, []);
  return (
    <label className="block min-w-0">
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      <input {...rest} value={v} onChange={(e) => setV(e.target.value)} className={fieldCls(!!value)} />
    </label>
  );
}

function ActiveChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 max-w-full text-xs rounded-full bg-indigo-50 border border-indigo-100 text-indigo-800 pl-2.5 pr-0.5 py-0.5">
      <span className="truncate"><span className="text-indigo-500">{label}:</span> {value}</span>
      <button type="button" onClick={onClear} className="p-0.5 rounded-full hover:bg-indigo-100 flex-shrink-0" aria-label={`Clear ${label} filter`} title={`Clear ${label} filter`}><X className="w-3 h-3" /></button>
    </span>
  );
}

export function LeadFilterBar({ filters, onChange, clients, lists, stages, tags, senders, ws, toast }: {
  /** Accepts an updater so delayed text commits always build on the latest filters. */
  filters: ViewFilters; onChange: (f: ViewFilters | ((prev: ViewFilters) => ViewFilters)) => void;
  clients?: Client[]; lists?: List[]; stages?: Stage[]; tags?: Tag[];
  /** The workspace's accounts, for the Connected via / Pending with filters (094). */
  senders?: Sender[];
  ws: string | undefined; toast: ToastFn;
}) {
  const { views, save, remove } = useSavedViews(ws);
  const [search, setSearch] = useState(filters.search ?? '');
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');

  // Debounce free-text search
  useEffect(() => {
    const t = setTimeout(() => { if ((filters.search ?? '') !== search) onChange((f) => ({ ...f, search })); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => { setSearch(filters.search ?? ''); }, [filters.search]);

  // Filters popover: close on outside click / Escape.
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    // a click inside one of the floating account menus (portaled to the body) is inside the popover for this purpose
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (t instanceof Element && t.closest(`[${MENU_ATTR}]`)) return;
      if (popRef.current && !popRef.current.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const activeView = useMemo(() => views.find((v) => sameFilters(v.filters, filters)), [views, filters]);
  // connections and pending invites exist on LinkedIn and Instagram only
  const connectable = useMemo(() => (senders ?? []).filter((s) => s.provider === 'LINKEDIN' || s.provider === 'INSTAGRAM'), [senders]);
  const set = <K extends keyof ViewFilters>(k: K, v: ViewFilters[K]) => onChange((f) => ({ ...f, [k]: v }));
  const clearFilters = () => onChange({ ...EMPTY_FILTERS, search: filters.search ?? '' });

  const active: { key: string; label: string; value: string; clear: () => void }[] = [];
  const named = (rows: { id: string; name: string }[] | undefined, id: string) => rows?.find((r) => r.id === id)?.name ?? 'Selected';
  if (filters.client_id) active.push({ key: 'client', label: 'Client', value: named(clients, filters.client_id), clear: () => set('client_id', null) });
  if (filters.channel) active.push({ key: 'channel', label: 'Channel', value: channelLabel(filters.channel), clear: () => set('channel', null) });
  if (filters.list_id) active.push({ key: 'list', label: 'List', value: named(lists, filters.list_id), clear: () => set('list_id', null) });
  if (filters.stage_id) active.push({ key: 'stage', label: 'Stage', value: named(stages, filters.stage_id), clear: () => set('stage_id', null) });
  if (filters.tag_id) active.push({ key: 'tag', label: 'Tag', value: named(tags, filters.tag_id), clear: () => set('tag_id', null) });
  if (filters.dnc != null) active.push({ key: 'dnc', label: 'Do not contact', value: filters.dnc ? 'Yes' : 'No', clear: () => set('dnc', null) });
  if (filters.enriched != null) active.push({ key: 'enriched', label: 'Enriched', value: filters.enriched ? 'Yes' : 'No', clear: () => set('enriched', null) });
  if (filters.replied != null) active.push({ key: 'replied', label: 'Replied', value: filters.replied ? 'Has replied' : 'Never replied', clear: () => set('replied', null) });
  if (filters.time_in_role) active.push({ key: 'role', label: 'Time in role', value: TIME_IN_ROLE_LABEL[filters.time_in_role], clear: () => set('time_in_role', null) });
  if (filters.posted_30d) active.push({ key: 'posted', label: 'Posted', value: 'Last 30 days', clear: () => set('posted_30d', null) });
  if (filters.min_followers) active.push({ key: 'followers', label: 'Followers', value: `${filters.min_followers.toLocaleString()}+`, clear: () => set('min_followers', null) });
  if (filters.past_company) active.push({ key: 'past', label: 'Past company', value: filters.past_company, clear: () => set('past_company', null) });
  if (filters.skill) active.push({ key: 'skill', label: 'Skill', value: filters.skill, clear: () => set('skill', null) });
  if (filters.language) active.push({ key: 'language', label: 'Language', value: filters.language, clear: () => set('language', null) });
  // 094
  const senderName = (id: string) => senders?.find((s) => s.id === id)?.display_name ?? senders?.find((s) => s.id === id)?.public_identifier ?? 'Removed account';
  if (filters.hidden) active.push({ key: 'hidden', label: 'Hidden', value: 'Only hidden leads', clear: () => onChange((f) => ({ ...f, hidden: null, kind: null })) });
  if (filters.status?.length) active.push({ key: 'status', label: 'Status', value: filters.status.map((s) => STATUS_META[s].label).join(', '), clear: () => set('status', null) });
  if (filters.connected_via?.length) active.push({ key: 'connected_via', label: 'Connected via', value: filters.connected_via.map(senderName).join(', '), clear: () => set('connected_via', null) });
  if (filters.pending_with?.length) active.push({ key: 'pending_with', label: 'Pending with', value: filters.pending_with.map(senderName).join(', '), clear: () => set('pending_with', null) });
  if (filters.not_connected) active.push({ key: 'not_connected', label: 'Connections', value: 'Not connected to any account', clear: () => set('not_connected', null) });
  if (filters.connection_source) active.push({ key: 'connection_source', label: 'Connection', value: SOURCE_FILTER_LABEL[filters.connection_source], clear: () => set('connection_source', null) });
  if (filters.channel_used) active.push({ key: 'channel_used', label: 'Used on', value: channelFilterLabel(filters.channel_used), clear: () => set('channel_used', null) });
  if (filters.channel_replied) active.push({ key: 'channel_replied', label: 'Replied on', value: channelFilterLabel(filters.channel_replied), clear: () => set('channel_replied', null) });
  if (filters.origin?.length) active.push({ key: 'origin', label: 'Origin', value: filters.origin.map((o) => ORIGIN_LABEL[o]).join(', '), clear: () => set('origin', null) });
  if (filters.kind?.length) active.push({ key: 'kind', label: 'Kind', value: filters.kind.map((k) => KIND_LABEL[k]).join(', '), clear: () => set('kind', null) });
  if (filters.include_removed) active.push({ key: 'include_removed', label: 'Accounts', value: 'Removed accounts included', clear: () => set('include_removed', null) });

  const chipBase = 'px-2.5 py-1 rounded-full text-xs font-medium border';

  return (
    <div className="space-y-2">
      <div ref={popRef} className="relative flex items-center gap-2">
        <label className="relative flex-1 min-w-0">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, company, headline, identifier, email…" className="w-full pl-8 pr-8 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          {search && <button type="button" onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search" title="Clear search"><X className="w-3.5 h-3.5" /></button>}
        </label>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-haspopup="dialog"
          title="Filter leads"
          className={cn('flex-shrink-0 inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border', open || active.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50')}
        >
          <SlidersHorizontal className="w-4 h-4" />
          <span className="hidden sm:inline">Filters</span>
          {active.length > 0 && <span className="text-[10px] leading-none bg-indigo-600 text-white rounded-full px-1.5 py-0.5 tabular-nums">{active.length}</span>}
        </button>

        {open && (
          <div role="dialog" aria-label="Filters" className="absolute right-0 top-full mt-1.5 z-30 w-[34rem] max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-gray-900">Filters</span>
              {active.length > 0 && <button type="button" onClick={clearFilters} className="text-xs text-indigo-600 hover:text-indigo-800">Clear all</button>}
            </div>

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Lead</h3>
              <div className="grid grid-cols-2 gap-2">
                <FilterSelect label="Channel" title="Leads you can reach on this channel (they have a profile, handle or number for it)" value={filters.channel ?? ''} onChange={(v) => set('channel', (v || null) as Provider | null)}>
                  <option value="">All channels</option>
                  {CHANNEL_PROVIDERS.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}
                </FilterSelect>
                <FilterSelect label="List" value={filters.list_id ?? ''} onChange={(v) => set('list_id', v || null)}>
                  <option value="">All lists</option>
                  {lists?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </FilterSelect>
                <FilterSelect label="Stage" value={filters.stage_id ?? ''} onChange={(v) => set('stage_id', v || null)}>
                  <option value="">All stages</option>
                  {stages?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </FilterSelect>
                <FilterSelect label="Tag" value={filters.tag_id ?? ''} onChange={(v) => set('tag_id', v || null)}>
                  <option value="">All tags</option>
                  {tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </FilterSelect>
                {!!clients?.length && (
                  <FilterSelect label="Client" value={filters.client_id ?? ''} onChange={(v) => set('client_id', v || null)}>
                    <option value="">All clients</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </FilterSelect>
                )}
                <FilterSelect label="Do not contact" title="Leads excluded from outreach" value={yesNo(filters.dnc)} onChange={(v) => set('dnc', fromYesNo(v))}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </FilterSelect>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Profile</h3>
              <div className="grid grid-cols-2 gap-2">
                <FilterSelect label="Enriched" value={yesNo(filters.enriched)} onChange={(v) => set('enriched', fromYesNo(v))}>
                  <option value="">Any</option>
                  <option value="yes">Yes</option>
                  <option value="no">No</option>
                </FilterSelect>
                <FilterSelect label="Replied" value={yesNo(filters.replied)} onChange={(v) => set('replied', fromYesNo(v))}>
                  <option value="">Any</option>
                  <option value="yes">Has replied</option>
                  <option value="no">Never replied</option>
                </FilterSelect>
                <FilterSelect label="Time in current role" value={filters.time_in_role ?? ''} onChange={(v) => set('time_in_role', (v || null) as TimeInRole | null)}>
                  <option value="">Any</option>
                  {TIME_IN_ROLE_VALUES.map((t) => <option key={t} value={t}>{TIME_IN_ROLE_LABEL[t]}</option>)}
                </FilterSelect>
                <FilterText label="Followers at least" type="number" min={0} inputMode="numeric" placeholder="e.g. 1000" value={filters.min_followers != null ? String(filters.min_followers) : ''} onCommit={(v) => { const n = parseInt(v, 10); set('min_followers', Number.isFinite(n) && n > 0 ? n : null); }} />
                <FilterText label="Past company" placeholder="e.g. Google" value={filters.past_company ?? ''} onCommit={(v) => set('past_company', v.trim() || null)} />
                <FilterText label="Skill" placeholder="e.g. Sales" value={filters.skill ?? ''} onCommit={(v) => set('skill', v.trim() || null)} />
                <FilterText label="Profile language" placeholder="e.g. en" value={filters.language ?? ''} onCommit={(v) => set('language', v.trim() || null)} />
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-gray-500 mb-1">Recent posts</span>
                  <label className={cn(fieldCls(!!filters.posted_30d), 'flex items-center gap-2 cursor-pointer')}>
                    <input type="checkbox" checked={!!filters.posted_30d} onChange={(e) => set('posted_30d', e.target.checked ? true : null)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="truncate">Posted in the last 30 days</span>
                  </label>
                </div>
              </div>
              <p className="text-xs text-gray-500">Time in role, posts, followers, past company, skill and language only match enriched leads.</p>
            </section>

            {/* 094 §5.6: status, connections per account, channels, origin, hidden */}
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Status and connections</h3>
              <div className="min-w-0">
                <span className="block text-[11px] font-medium text-gray-500 mb-1">Status</span>
                <div className="flex flex-wrap gap-1">
                  {LEAD_STATUSES.map((s) => {
                    const on = !!filters.status?.includes(s);
                    return <button key={s} type="button" aria-pressed={on} title={STATUS_META[s].help} onClick={() => set('status', toggleIn<LeadStatus>(filters.status, s))} className={cn(chipBase, on ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>{STATUS_META[s].label}</button>;
                  })}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {/* the inbox's sender menu (search, channel switch), so a long account list stays one field each */}
                <div className="min-w-0">
                  <SenderMultiSelect label="Connected via" allLabel="Any account" title="Leads connected to any of the picked accounts"
                    senders={connectable} removed={[]} value={filters.connected_via ?? []} onChange={(ids) => set('connected_via', ids.length ? ids : null)} />
                </div>
                <div className="min-w-0">
                  <SenderMultiSelect label="Pending with" allLabel="Any account" title="Leads with an invite still pending from any of the picked accounts"
                    senders={connectable} removed={[]} value={filters.pending_with ?? []} onChange={(ids) => set('pending_with', ids.length ? ids : null)} />
                </div>
                <FilterSelect label="Connection source" title="How the current connections came about" value={filters.connection_source ?? ''} onChange={(v) => set('connection_source', (v || null) as RelationSource | null)}>
                  <option value="">Any</option>
                  {SOURCES.map((s) => <option key={s} value={s}>{SOURCE_FILTER_LABEL[s]}</option>)}
                </FilterSelect>
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-gray-500 mb-1">Connections</span>
                  <label className={cn(fieldCls(!!filters.not_connected), 'flex items-center gap-2 cursor-pointer')}>
                    <input type="checkbox" checked={!!filters.not_connected} onChange={(e) => set('not_connected', e.target.checked ? true : null)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="truncate">Not connected to any account</span>
                  </label>
                </div>
                <FilterSelect label="Used on" title="A message, invite or email went out on this channel" value={filters.channel_used ?? ''} onChange={(v) => set('channel_used', (v || null) as Provider | null)}>
                  <option value="">Any channel</option>
                  {ALL_CHANNELS.map((p) => <option key={p} value={p}>{channelFilterLabel(p)}</option>)}
                </FilterSelect>
                <FilterSelect label="Replied on" title="They answered on this channel after a touch of ours" value={filters.channel_replied ?? ''} onChange={(v) => set('channel_replied', (v || null) as Provider | null)}>
                  <option value="">Any channel</option>
                  {ALL_CHANNELS.map((p) => <option key={p} value={p}>{channelFilterLabel(p)}</option>)}
                </FilterSelect>
                <div className="min-w-0 col-span-2">
                  <span className="block text-[11px] font-medium text-gray-500 mb-1">Origin</span>
                  <div className="flex flex-wrap gap-1">
                    {ORIGINS.map((o) => {
                      const on = !!filters.origin?.includes(o);
                      return <button key={o} type="button" aria-pressed={on} onClick={() => set('origin', toggleIn<LeadOrigin>(filters.origin, o))} className={cn(chipBase, on ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>{ORIGIN_LABEL[o]}</button>;
                    })}
                  </div>
                </div>
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-gray-500 mb-1">Hidden leads</span>
                  <label className={cn(fieldCls(!!filters.hidden), 'flex items-center gap-2 cursor-pointer')} title="Automated senders, company pages and leads hidden by hand. They are kept, not deleted.">
                    <input type="checkbox" checked={!!filters.hidden} onChange={(e) => onChange((f) => ({ ...f, hidden: e.target.checked ? true : null, kind: e.target.checked ? f.kind : null }))} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="truncate">Show only hidden leads</span>
                  </label>
                </div>
                {filters.hidden && (
                  <div className="min-w-0">
                    <span className="block text-[11px] font-medium text-gray-500 mb-1">Kind</span>
                    <div className="flex flex-wrap gap-1">
                      {KINDS.map((k) => {
                        const on = !!filters.kind?.includes(k);
                        return <button key={k} type="button" aria-pressed={on} onClick={() => set('kind', toggleIn<LeadKind>(filters.kind, k))} className={cn(chipBase, on ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>{KIND_LABEL[k]}</button>;
                      })}
                    </div>
                  </div>
                )}
                <div className="min-w-0">
                  <span className="block text-[11px] font-medium text-gray-500 mb-1">Removed accounts</span>
                  <label className={cn(fieldCls(!!filters.include_removed), 'flex items-center gap-2 cursor-pointer')} title="Count connections and pending invites of accounts that were removed from the workspace.">
                    <input type="checkbox" checked={!!filters.include_removed} onChange={(e) => set('include_removed', e.target.checked ? true : null)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                    <span className="truncate">Include removed accounts</span>
                  </label>
                </div>
              </div>
            </section>
          </div>
        )}
      </div>

      {(views.length > 0 || active.length > 0) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {views.length > 0 && (
            <>
              <button type="button" onClick={() => onChange(EMPTY_FILTERS)} className={cn(chipBase, isFilterEmpty(filters) ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>All leads</button>
              {views.map((v) => (
                <span key={v.id} className={cn('inline-flex items-center rounded-full text-xs font-medium border', activeView?.id === v.id ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200')}>
                  <button type="button" onClick={() => onChange({ ...EMPTY_FILTERS, ...v.filters })} className="pl-2.5 pr-1 py-1 inline-flex items-center gap-1 hover:text-indigo-700"><Bookmark className="w-3 h-3" />{v.name}</button>
                  <button type="button" title={`Remove view "${v.name}"`} onClick={() => { remove(v.id); toast('View removed'); }} className="pr-1.5 pl-0.5 py-1 text-gray-400 hover:text-red-600"><X className="w-3 h-3" /></button>
                </span>
              ))}
              {active.length > 0 && <span className="w-px h-4 bg-gray-200 mx-1" aria-hidden />}
            </>
          )}
          {active.map((a) => <ActiveChip key={a.key} label={a.label} value={a.value} onClear={a.clear} />)}
          {active.length > 0 && !activeView && (
            <button type="button" onClick={() => { setViewName(''); setSaveOpen(true); }} className={cn(chipBase, 'border-dashed border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1')}><BookmarkPlus className="w-3 h-3" /> Save view</button>
          )}
          {active.length > 1 && <button type="button" onClick={clearFilters} className="text-xs text-gray-500 hover:text-gray-800 px-1">Clear all</button>}
        </div>
      )}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save view" size="sm"
        footer={<><Button variant="secondary" onClick={() => setSaveOpen(false)}>Cancel</Button><Button disabled={!viewName.trim()} onClick={() => { save(viewName.trim(), { ...filters }); setSaveOpen(false); toast('View saved'); }}>Save</Button></>}>
        <form onSubmit={(e) => { e.preventDefault(); if (viewName.trim()) { save(viewName.trim(), { ...filters }); setSaveOpen(false); toast('View saved'); } }}>
          <Input label="View name" value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="e.g. Interested · Acme" autoFocus />
          <p className="text-xs text-gray-500 mt-2">Saved views are stored in this browser for the current workspace.</p>
        </form>
      </Modal>
    </div>
  );
}
