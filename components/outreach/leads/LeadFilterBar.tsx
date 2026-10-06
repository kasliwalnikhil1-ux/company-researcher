'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LeadFilters } from '@/lib/outreach/queries';
import type { IntelLeadFilters, TimeInRole } from '@/lib/outreach/intel';
import { CHANNEL_PROVIDERS, type Client, type List, type Provider, type Stage, type Tag } from '@/lib/outreach/types';
import { channelLabel } from '@/lib/outreach/channels';
import { Button, Input, Modal } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Bookmark, BookmarkPlus, Search, SlidersHorizontal, X } from 'lucide-react';
import type { ToastFn } from './helpers';
import { usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { kv } from '@/lib/outreach/storage';

export type ViewFilters = Pick<LeadFilters, 'search' | 'client_id' | 'list_id' | 'stage_id' | 'tag_id' | 'dnc'> & IntelLeadFilters;
export interface SavedView { id: string; name: string; filters: ViewFilters }

export const EMPTY_FILTERS: ViewFilters = {
  search: '', client_id: null, list_id: null, stage_id: null, tag_id: null, dnc: null, channel: null,
  enriched: null, replied: null, posted_30d: null, min_followers: null, time_in_role: null, past_company: null, skill: null, language: null,
};
const FILTER_KEYS = Object.keys(EMPTY_FILTERS) as (keyof ViewFilters)[];
const BOOL_KEYS: (keyof ViewFilters)[] = ['dnc', 'enriched', 'replied', 'posted_30d'];
const TIME_IN_ROLE_VALUES: TimeInRole[] = ['lt6', '6to12', '1to3', 'gt3'];
const TIME_IN_ROLE_LABEL: Record<string, string> = { lt6: 'Under 6 months', '6to12': '6 to 12 months', '1to3': '1 to 3 years', gt3: 'Over 3 years' };
const isSet = (v: unknown) => v != null && v !== '' && v !== false;

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
    else if (k === 'min_followers') { if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.min_followers = v; }
    else if (k === 'time_in_role') { if (typeof v === 'string' && TIME_IN_ROLE_VALUES.includes(v as TimeInRole)) out.time_in_role = v as TimeInRole; }
    else if (k === 'channel') { if (typeof v === 'string' && CHANNEL_PROVIDERS.includes(v as Provider)) out.channel = v as Provider; }
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
  const norm = (v: unknown) => (v == null || v === '' || v === false ? null : v);
  return FILTER_KEYS.every((k) => (k === 'dnc' || k === 'enriched' || k === 'replied' ? (a[k] ?? null) === (b[k] ?? null) : norm(a[k]) === norm(b[k])));
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

export function LeadFilterBar({ filters, onChange, clients, lists, stages, tags, ws, toast }: {
  /** Accepts an updater so delayed text commits always build on the latest filters. */
  filters: ViewFilters; onChange: (f: ViewFilters | ((prev: ViewFilters) => ViewFilters)) => void;
  clients?: Client[]; lists?: List[]; stages?: Stage[]; tags?: Tag[];
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
    const onDown = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const activeView = useMemo(() => views.find((v) => sameFilters(v.filters, filters)), [views, filters]);
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
                {!!clients?.length && (
                  <FilterSelect label="Client" value={filters.client_id ?? ''} onChange={(v) => set('client_id', v || null)}>
                    <option value="">All clients</option>
                    {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </FilterSelect>
                )}
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
