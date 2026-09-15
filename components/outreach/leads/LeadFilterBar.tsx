'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LeadFilters } from '@/lib/outreach/queries';
import type { Client, List, Stage, Tag } from '@/lib/outreach/types';
import { Button, Input, Modal, Select } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Bookmark, BookmarkPlus, Search, Settings2, X } from 'lucide-react';
import type { ToastFn } from './helpers';
import type { TaxonomyKind } from './ManageTaxonomy';

export type ViewFilters = Pick<LeadFilters, 'search' | 'client_id' | 'list_id' | 'stage_id' | 'tag_id' | 'dnc'>;
export interface SavedView { id: string; name: string; filters: ViewFilters }

export const EMPTY_FILTERS: ViewFilters = { search: '', client_id: null, list_id: null, stage_id: null, tag_id: null, dnc: null };

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
  return !f.search && !f.client_id && !f.list_id && !f.stage_id && !f.tag_id && f.dnc == null;
}

function sameFilters(a: ViewFilters, b: ViewFilters): boolean {
  return (a.search ?? '') === (b.search ?? '') && (a.client_id ?? null) === (b.client_id ?? null) && (a.list_id ?? null) === (b.list_id ?? null)
    && (a.stage_id ?? null) === (b.stage_id ?? null) && (a.tag_id ?? null) === (b.tag_id ?? null) && (a.dnc ?? null) === (b.dnc ?? null);
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
