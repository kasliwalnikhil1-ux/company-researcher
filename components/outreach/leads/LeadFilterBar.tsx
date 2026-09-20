'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeadFilters } from '@/lib/outreach/queries';
import type { IntelLeadFilters, TimeInRole } from '@/lib/outreach/intel';
import type { Client, List, Stage, Tag } from '@/lib/outreach/types';
import { Button, Input, Modal, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Bookmark, BookmarkPlus, Search, Settings2, SlidersHorizontal, X } from 'lucide-react';
import type { ToastFn } from './helpers';
import type { TaxonomyKind } from './ManageTaxonomy';

export type ViewFilters = Pick<LeadFilters, 'search' | 'client_id' | 'list_id' | 'stage_id' | 'tag_id' | 'dnc'> & IntelLeadFilters;
export interface SavedView { id: string; name: string; filters: ViewFilters }

export const EMPTY_FILTERS: ViewFilters = {
  search: '', client_id: null, list_id: null, stage_id: null, tag_id: null, dnc: null,
  enriched: null, replied: null, posted_30d: null, min_followers: null, time_in_role: null, past_company: null, skill: null, language: null,
};
const FILTER_KEYS = Object.keys(EMPTY_FILTERS) as (keyof ViewFilters)[];
const PROFILE_KEYS: (keyof ViewFilters)[] = ['enriched', 'replied', 'posted_30d', 'min_followers', 'time_in_role', 'past_company', 'skill', 'language'];
const isSet = (v: unknown) => v != null && v !== '' && v !== false;

function storageKey(ws: string) { return `outreach-lead-views:${ws}`; }

export function useSavedViews(ws: string | undefined) {
  const [views, setViews] = useState<SavedView[]>([]);
  useEffect(() => {
    if (!ws) return;
    try {
      const raw = localStorage.getItem(storageKey(ws));
      const parsed = raw ? (JSON.parse(raw) as SavedView[]) : [];
      setViews(Array.isArray(parsed) ? parsed.filter((v) => v && typeof v.id === 'string' && typeof v.name === 'string' && v.filters) : []);
    } catch { setViews([]); }
  }, [ws]);
  const persist = useCallback((next: SavedView[]) => {
    setViews(next);
    if (!ws) return;
    try { localStorage.setItem(storageKey(ws), JSON.stringify(next)); } catch { /* storage unavailable */ }
  }, [ws]);
  const save = useCallback((name: string, filters: ViewFilters) => {
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    persist([...views, { id, name, filters }]);
    return id;
  }, [views, persist]);
  const remove = useCallback((id: string) => persist(views.filter((v) => v.id !== id)), [views, persist]);
  return { views, save, remove };
}

export function isFilterEmpty(f: ViewFilters): boolean {
  return FILTER_KEYS.every((k) => (k === 'dnc' || k === 'enriched' || k === 'replied' ? f[k] == null : !isSet(f[k])));
}

function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  const norm = (v: unknown) => (v == null || v === '' || v === false ? null : v);
  return FILTER_KEYS.every((k) => (k === 'dnc' || k === 'enriched' || k === 'replied' ? (a[k] ?? null) === (b[k] ?? null) : norm(a[k]) === norm(b[k])));
}

/** Text inputs of the profile filters apply after a short pause, like the search box. */
function DebouncedInput({ value, onCommit, ...rest }: { value: string; onCommit: (v: string) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  useEffect(() => {
    if (v === value) return;
    const t = setTimeout(() => onCommit(v), 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return <input {...rest} value={v} onChange={(e) => setV(e.target.value)} />;
}

export function LeadFilterBar({ filters, onChange, clients, lists, stages, tags, ws, canWrite, onManage, toast }: {
  filters: ViewFilters; onChange: (f: ViewFilters) => void;
  clients?: Client[]; lists?: List[]; stages?: Stage[]; tags?: Tag[];
  ws: string | undefined; canWrite: boolean; onManage: (k: TaxonomyKind) => void; toast: ToastFn;
}) {
  const { views, save, remove } = useSavedViews(ws);
  const [search, setSearch] = useState(filters.search ?? '');
  const [saveOpen, setSaveOpen] = useState(false);
  const [viewName, setViewName] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const profileCount = PROFILE_KEYS.filter((k) => (k === 'enriched' || k === 'replied' ? filters[k] != null : isSet(filters[k]))).length;
  const [moreOpen, setMoreOpen] = useState(false);
  useEffect(() => { if (profileCount > 0) setMoreOpen(true); }, [profileCount]);

  // Debounce free-text search
  useEffect(() => {
    const t = setTimeout(() => { if ((filters.search ?? '') !== search) onChange({ ...filters, search }); }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  useEffect(() => { setSearch(filters.search ?? ''); }, [filters.search]);

  const activeView = useMemo(() => views.find((v) => sameFilters(v.filters, filters)), [views, filters]);
  const set = <K extends keyof ViewFilters>(k: K, v: ViewFilters[K]) => onChange({ ...filters, [k]: v });
  const sel = 'px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

  return (
    <div className="space-y-2">
      {(views.length > 0 || !isFilterEmpty(filters)) && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <button type="button" onClick={() => onChange(EMPTY_FILTERS)} className={cn('px-2.5 py-1 rounded-full text-xs font-medium border', isFilterEmpty(filters) ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50')}>All leads</button>
          {views.map((v) => (
            <span key={v.id} className={cn('inline-flex items-center rounded-full text-xs font-medium border', activeView?.id === v.id ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200')}>
              <button type="button" onClick={() => onChange({ ...EMPTY_FILTERS, ...v.filters })} className="pl-2.5 pr-1 py-1 inline-flex items-center gap-1 hover:text-indigo-700"><Bookmark className="w-3 h-3" />{v.name}</button>
              <button type="button" title={`Remove view "${v.name}"`} onClick={() => { remove(v.id); toast('View removed'); }} className="pr-1.5 pl-0.5 py-1 text-gray-400 hover:text-red-600"><X className="w-3 h-3" /></button>
            </span>
          ))}
          {!isFilterEmpty(filters) && !activeView && (
            <button type="button" onClick={() => { setViewName(''); setSaveOpen(true); }} className="px-2.5 py-1 rounded-full text-xs font-medium border border-dashed border-gray-300 text-gray-600 hover:bg-gray-50 inline-flex items-center gap-1"><BookmarkPlus className="w-3 h-3" /> Save view</button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input aria-label="Search leads" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, company, headline, identifier, email…" className={cn(sel, 'w-full pl-8')} />
        </label>
        {clients && clients.length > 0 && (
          <select aria-label="Client" value={filters.client_id ?? ''} onChange={(e) => set('client_id', e.target.value || null)} className={sel}>
            <option value="">All clients</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <select aria-label="List" value={filters.list_id ?? ''} onChange={(e) => set('list_id', e.target.value || null)} className={sel}>
          <option value="">All lists</option>
          {lists?.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </select>
        <select aria-label="Stage" value={filters.stage_id ?? ''} onChange={(e) => set('stage_id', e.target.value || null)} className={sel}>
          <option value="">All stages</option>
          {stages?.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select aria-label="Tag" value={filters.tag_id ?? ''} onChange={(e) => set('tag_id', e.target.value || null)} className={sel}>
          <option value="">All tags</option>
          {tags?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select aria-label="Do not contact" value={filters.dnc == null ? '' : filters.dnc ? 'yes' : 'no'} onChange={(e) => set('dnc', e.target.value === '' ? null : e.target.value === 'yes')} className={sel}>
          <option value="">DNC: any</option>
          <option value="yes">DNC: yes</option>
          <option value="no">DNC: no</option>
        </select>
        <Button variant={profileCount > 0 ? 'primary' : 'secondary'} size="sm" aria-expanded={moreOpen} aria-controls="lead-profile-filters" onClick={() => setMoreOpen((o) => !o)} title="Filter on replies and enriched profile data"><SlidersHorizontal className="w-3.5 h-3.5" /> Profile filters{profileCount > 0 ? ` (${profileCount})` : ''}</Button>
        {!isFilterEmpty(filters) && <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTERS)}><X className="w-3.5 h-3.5" /> Clear</Button>}
        {canWrite && (
          <div className="relative ml-auto">
            <Button variant="secondary" size="sm" title="Manage lists, stages and tags" aria-haspopup="menu" aria-expanded={manageOpen} onClick={() => setManageOpen((o) => !o)}><Settings2 className="w-3.5 h-3.5" /> Manage</Button>
            {manageOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setManageOpen(false)} />
                <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-40 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
                  {(['lists', 'stages', 'tags'] as TaxonomyKind[]).map((k) => (
                    <button key={k} role="menuitem" type="button" onClick={() => { setManageOpen(false); onManage(k); }} className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 capitalize">{k}</button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {moreOpen && (
        <div id="lead-profile-filters" className="rounded-xl border border-gray-200 bg-white p-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <select aria-label="Enriched" value={filters.enriched == null ? '' : filters.enriched ? 'yes' : 'no'} onChange={(e) => set('enriched', e.target.value === '' ? null : e.target.value === 'yes')} className={sel}>
              <option value="">Enriched: any</option>
              <option value="yes">Enriched: yes</option>
              <option value="no">Enriched: no</option>
            </select>
            <select aria-label="Replied" value={filters.replied == null ? '' : filters.replied ? 'yes' : 'no'} onChange={(e) => set('replied', e.target.value === '' ? null : e.target.value === 'yes')} className={sel}>
              <option value="">Replied: any</option>
              <option value="yes">Has replied</option>
              <option value="no">Never replied</option>
            </select>
            <select aria-label="Time in current role" value={filters.time_in_role ?? ''} onChange={(e) => set('time_in_role', (e.target.value || null) as TimeInRole | null)} className={sel}>
              <option value="">Time in role: any</option>
              <option value="lt6">Under 6 months</option>
              <option value="6to12">6 to 12 months</option>
              <option value="1to3">1 to 3 years</option>
              <option value="gt3">Over 3 years</option>
            </select>
            <label className={cn(sel, 'flex items-center gap-2 cursor-pointer')}>
              <input type="checkbox" checked={!!filters.posted_30d} onChange={(e) => set('posted_30d', e.target.checked ? true : null)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
              Posted in the last 30 days
            </label>
            <DebouncedInput aria-label="Minimum followers" type="number" min={0} inputMode="numeric" placeholder="Followers at least…" value={filters.min_followers != null ? String(filters.min_followers) : ''} onCommit={(v) => { const n = parseInt(v, 10); set('min_followers', Number.isFinite(n) && n > 0 ? n : null); }} className={sel} />
            <DebouncedInput aria-label="Past company" placeholder="Past company" value={filters.past_company ?? ''} onCommit={(v) => set('past_company', v.trim() || null)} className={sel} />
            <DebouncedInput aria-label="Skill" placeholder="Skill" value={filters.skill ?? ''} onCommit={(v) => set('skill', v.trim() || null)} className={sel} />
            <DebouncedInput aria-label="Profile language" placeholder="Profile language, e.g. en" value={filters.language ?? ''} onCommit={(v) => set('language', v.trim() || null)} className={sel} />
          </div>
          <p className="text-xs text-gray-500 mt-2">Time in role, posts, followers, past company, skill and language only match enriched leads.</p>
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
