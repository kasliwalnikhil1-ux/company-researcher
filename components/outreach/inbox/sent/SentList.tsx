'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, SlidersHorizontal, Loader2, Send, MoreHorizontal, Download, CalendarClock, AlertTriangle, Bot, Smartphone, User } from 'lucide-react';
import Link from '@/lib/outreach/nav';
import { cn } from '@/lib/utils';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import { Avatar, Button, EmptyState, ErrorBox, Spinner } from '@/components/outreach/ui';
import { WhyNotSendingDialog } from '@/components/outreach/sequences/WhyNotSendingDialog';
import type { Client, Sender, Sequence } from '@/lib/outreach/types';
import {
  CHANNEL_LABEL, SEGMENT_LABEL, SEGMENT_TOOLTIP, SENT_EMPTY, SENT_RANGE_LABEL, SOURCE_LABEL, STATUS_TONE, TYPE_LABEL,
  dayKey, dayLabel, exportSentCsv, fmtTime, sentFiltersActive, sourceLine, statusLabel, typePrefix,
  type SentChannel, type SentFilters, type SentItem, type SentRange, type SentSegment, type SentSource, type SentType,
} from '@/lib/outreach/inboxSent';
import { rowActions, useSentRowActions, type RowActionKey } from './SentActions';

export interface SentListProps {
  ws: string;
  segment: SentSegment;
  onSegment: (s: SentSegment) => void;
  counts: { scheduled: number; failed: number } | null;
  rows: SentItem[] | undefined;
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  filters: SentFilters;
  onFilters: (patch: Partial<SentFilters>) => void;
  search: string;
  onSearch: (v: string) => void;
  senders: Sender[] | undefined;
  clients: Client[] | undefined;
  sequences: Sequence[] | undefined;
  selectedId: string | null;
  onSelect: (it: SentItem) => void;
  onOpenChat: (it: SentItem) => void;
  onOpenLead: (it: SentItem) => void;
  canWrite: boolean;
  isManager: boolean;
  tz: string | null;
  toast: (m: string, kind?: 'error') => void;
}

const EMPTY = new Set<string>();
const SOURCE_ICON: Record<SentSource, React.ComponentType<{ className?: string }>> = { sequence: Send, teammate: User, ai: Bot, outside_app: Smartphone };

function StatusPill({ it, tz }: { it: SentItem; tz: string | null }) {
  const label = statusLabel(it, tz);
  return (
    <span title={it.status_text ?? label} className={cn('inline-flex items-center max-w-full truncate text-[10px] leading-4 px-1.5 rounded border whitespace-nowrap', STATUS_TONE[it.status])}>
      {label}
    </span>
  );
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cn('w-full text-sm rounded-md border bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500', value ? 'border-indigo-300 text-gray-900' : 'border-gray-200 text-gray-600')}>
        {children}
      </select>
    </label>
  );
}

const senderName = (s: Sender) => s.display_name ?? s.public_identifier ?? s.provider;

function RowMenu({ actions, onRun }: { actions: Array<{ key: RowActionKey; label: string; danger?: boolean; title?: string }>; onRun: (k: RowActionKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  if (!actions.length) return null;
  return (
    <div ref={ref} className="relative" onClick={(e) => e.stopPropagation()}>
      <button type="button" onClick={() => setOpen((o) => !o)} className="p-1 rounded-md text-gray-400 hover:text-gray-700 hover:bg-gray-100" aria-haspopup="menu" aria-expanded={open} title="Actions" aria-label="Actions">
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-52 rounded-lg border border-gray-200 bg-white shadow-lg py-1">
          {actions.map((a) => (
            <button key={a.key} type="button" role="menuitem" title={a.title} onClick={() => { setOpen(false); onRun(a.key); }}
              className={cn('w-full text-left text-sm px-3 py-1.5 hover:bg-gray-50', a.danger ? 'text-rose-600' : 'text-gray-700')}>{a.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Sent, in the inbox list column (inbox-replies-sent-PRD.md §4.3): one row per send, grouped by day, with the segment
 * toggle Sent · Scheduled · Failed, filters, the date range (Sent / Failed), search, bulk select (Scheduled / Failed)
 * and Export CSV (managers). Clicking a row opens the conversation at that message, or the send's detail pane.
 */
export default function SentList(p: SentListProps) {
  const { segment, filters, rows } = p;
  const scrollRef = useRef<HTMLDivElement>(null);
  // the selection belongs to one list: it is empty again when the segment, the filters or the search change
  const selKey = JSON.stringify([segment, filters, p.search]);
  const [sel, setSel] = useState<{ key: string; ids: Set<string> }>({ key: selKey, ids: new Set() });
  const selected = sel.key === selKey ? sel.ids : EMPTY;
  const setSelected = (f: Set<string> | ((s: Set<string>) => Set<string>)) => setSel((cur) => ({ key: selKey, ids: typeof f === 'function' ? f(cur.key === selKey ? cur.ids : EMPTY) : f }));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [why, setWhy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const actions = useSentRowActions({ ws: p.ws, toast: p.toast, onOpenChat: p.onOpenChat, onOpenLead: p.onOpenLead });
  const can = { write: p.canWrite, manager: p.isManager };
  const bulkAllowed = p.canWrite && (segment === 'scheduled' || segment === 'failed');

  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setFiltersOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFiltersOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [filtersOpen]);

  // infinite scroll: the next page loads while the bottom comes near (and when a short page does not fill the column)
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el || !p.hasMore || p.loadingMore) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 600) p.onLoadMore();
  };
  useEffect(() => { onScroll(); });

  const groups = useMemo(() => {
    const out: Array<{ key: string; label: string; items: SentItem[] }> = [];
    for (const it of rows ?? []) {
      const k = dayKey(it.at, p.tz);
      const last = out[out.length - 1];
      if (last && last.key === k) last.items.push(it); else out.push({ key: k, label: dayLabel(k, p.tz), items: [it] });
    }
    return out;
  }, [rows, p.tz]);

  const selectedItems = useMemo(() => (rows ?? []).filter((r) => selected.has(r.id)), [rows, selected]);
  const selectable = (it: SentItem) => bulkAllowed && !!it.enrollment_id && (segment === 'scheduled' ? it.src === 'queued' && it.status !== 'sending' : it.src === 'failed' && !!it.recoverable);
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelectable = (rows ?? []).filter(selectable);
  const allChecked = allSelectable.length > 0 && allSelectable.every((r) => selected.has(r.id));

  const active: Array<{ key: string; label: string; value: string; clear: () => void }> = [];
  if (filters.sender_ids.length) active.push({ key: 'senders', label: 'Sender', value: filters.sender_ids.length === 1 ? (p.senders?.find((s) => s.id === filters.sender_ids[0]) ? senderName(p.senders.find((s) => s.id === filters.sender_ids[0])!) : 'Selected') : `${filters.sender_ids.length} senders`, clear: () => p.onFilters({ sender_ids: [] }) });
  if (filters.client_id) active.push({ key: 'client', label: 'Client', value: p.clients?.find((c) => c.id === filters.client_id)?.name ?? 'Selected', clear: () => p.onFilters({ client_id: null }) });
  if (filters.channel) active.push({ key: 'channel', label: 'Channel', value: CHANNEL_LABEL[filters.channel], clear: () => p.onFilters({ channel: null }) });
  if (filters.source) active.push({ key: 'source', label: 'From', value: SOURCE_LABEL[filters.source], clear: () => p.onFilters({ source: null }) });
  if (filters.sequence_id) active.push({ key: 'sequence', label: 'Sequence', value: p.sequences?.find((q) => q.id === filters.sequence_id)?.name ?? 'Selected', clear: () => p.onFilters({ sequence_id: null }) });
  if (filters.type) active.push({ key: 'type', label: 'Type', value: TYPE_LABEL[filters.type], clear: () => p.onFilters({ type: null }) });
  if (segment === 'sent' && filters.replied != null) active.push({ key: 'replied', label: 'Got a reply', value: filters.replied ? 'Yes' : 'No', clear: () => p.onFilters({ replied: null }) });
  const periodSet = segment !== 'scheduled' && filters.range !== '7d';
  if (periodSet) active.unshift({ key: 'period', label: 'Period', value: filters.range === 'custom' ? [filters.from, filters.to].filter(Boolean).join(' – ') || 'Custom range' : SENT_RANGE_LABEL[filters.range], clear: () => p.onFilters({ range: '7d', from: null, to: null }) });
  const nActive = sentFiltersActive({ ...filters, replied: segment === 'sent' ? filters.replied : null }) + (periodSet ? 1 : 0);
  const clearAll = () => p.onFilters({ sender_ids: [], my_senders: false, client_id: null, channel: null, source: null, sequence_id: null, type: null, replied: null, range: '7d', from: null, to: null });

  const runExport = async () => {
    setExporting(true);
    try {
      const n = await exportSentCsv(p.ws, segment, filters, p.search, p.tz);
      p.toast(`Exported ${n.toLocaleString()} row${n === 1 ? '' : 's'}`);
    } catch (e) { p.toast(e instanceof Error ? e.message : 'Export failed', 'error'); } finally { setExporting(false); }
  };

  const today = new Date().toISOString().slice(0, 10);
  const segments: SentSegment[] = ['sent', 'scheduled', 'failed'];
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-gray-100 space-y-2">
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5 overflow-x-auto" role="radiogroup" aria-label="Sent segment">
          {segments.map((s) => {
            const n = s === 'scheduled' ? p.counts?.scheduled ?? 0 : s === 'failed' ? p.counts?.failed ?? 0 : 0;
            return (
              <button key={s} type="button" role="radio" aria-checked={segment === s} title={SEGMENT_TOOLTIP[s]} onClick={() => p.onSegment(s)}
                className={cn('flex-1 whitespace-nowrap text-xs py-1 px-2 rounded-md inline-flex items-center justify-center gap-1', segment === s ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>
                {SEGMENT_LABEL[s]}
                {n > 0 && <span className={cn('min-w-[16px] px-1 rounded-full text-[10px] leading-4 tabular-nums', s === 'failed' ? 'bg-rose-500 text-white' : 'bg-gray-200 text-gray-700')}>{n > 999 ? '999+' : n}</span>}
              </button>
            );
          })}
        </div>

        <div ref={popRef} className="relative flex items-center gap-1.5">
          <label className="relative block flex-1 min-w-0">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={p.search} onChange={(e) => p.onSearch(e.target.value)} placeholder="Search recipient or text" aria-label="Search sends" className="w-full pl-8 pr-7 py-1.5 text-sm rounded-lg border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {p.search && <button type="button" onClick={() => p.onSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search" title="Clear search"><X className="w-3.5 h-3.5" /></button>}
          </label>
          <button type="button" onClick={() => setFiltersOpen((o) => !o)} aria-expanded={filtersOpen} aria-haspopup="dialog" title="Filter sends"
            className={cn('relative flex-shrink-0 inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border', filtersOpen || nActive ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}>
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Filters</span>
            {nActive > 0 && <span className="text-[10px] leading-none bg-indigo-600 text-white rounded-full px-1.5 py-0.5 tabular-nums">{nActive}</span>}
          </button>
          {p.isManager && (
            <button type="button" onClick={runExport} disabled={exporting || !rows?.length} title="Export CSV: the visible columns for the current filters" aria-label="Export CSV"
              className="flex-shrink-0 p-1.5 rounded-lg border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            </button>
          )}

          {filtersOpen && (
            <div role="dialog" aria-label="Filters" className="absolute right-0 top-full mt-1.5 z-30 w-72 max-w-[calc(100vw-2rem)] max-h-[70vh] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">Filters</span>
                {nActive > 0 && <button type="button" onClick={clearAll} className="text-xs text-indigo-600 hover:text-indigo-800">Clear all</button>}
              </div>
              {segment !== 'scheduled' && (
                <div>
                  <FilterSelect label="Period" value={filters.range === '7d' ? '' : filters.range} onChange={(v) => p.onFilters({ range: (v || '7d') as SentRange })}>
                    {(Object.keys(SENT_RANGE_LABEL) as SentRange[]).map((r) => <option key={r} value={r === '7d' ? '' : r}>{SENT_RANGE_LABEL[r]}</option>)}
                  </FilterSelect>
                  {filters.range === 'custom' && (
                    <div className="flex items-center gap-1.5 mt-1.5 text-xs">
                      <input type="date" aria-label="From" value={filters.from ?? ''} max={filters.to ?? today} onChange={(e) => p.onFilters({ from: e.target.value || null })} className="min-w-0 flex-1 rounded-md border border-gray-200 px-1.5 py-1 text-gray-700" />
                      <span className="text-gray-400">–</span>
                      <input type="date" aria-label="To" value={filters.to ?? ''} min={filters.from ?? undefined} max={today} onChange={(e) => p.onFilters({ to: e.target.value || null })} className="min-w-0 flex-1 rounded-md border border-gray-200 px-1.5 py-1 text-gray-700" />
                    </div>
                  )}
                  {filters.range === 'custom' && filters.from && filters.to && (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000 > 89 && (
                    <p className="text-[11px] text-amber-700 mt-1">A range covers 90 days at most. Pick a shorter one.</p>
                  )}
                </div>
              )}
              <FilterSelect label="Sender" value={filters.sender_ids[0] ?? ''} onChange={(v) => p.onFilters({ sender_ids: v ? [v] : [], my_senders: false })}>
                <option value="">All senders</option>
                {(p.senders ?? []).filter((s) => s.provider !== 'WEBCHAT').map((s) => <option key={s.id} value={s.id}>{senderName(s)}</option>)}
              </FilterSelect>
              {!!p.clients?.length && (
                <FilterSelect label="Client" value={filters.client_id ?? ''} onChange={(v) => p.onFilters({ client_id: v || null })}>
                  <option value="">All clients</option>
                  {p.clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </FilterSelect>
              )}
              <div className="grid grid-cols-2 gap-2">
                <FilterSelect label="Channel" value={filters.channel ?? ''} onChange={(v) => p.onFilters({ channel: (v || null) as SentChannel | null })}>
                  <option value="">All</option>
                  {(Object.keys(CHANNEL_LABEL) as SentChannel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABEL[c]}</option>)}
                </FilterSelect>
                <FilterSelect label="Type" value={filters.type ?? ''} onChange={(v) => p.onFilters({ type: (v || null) as SentType | null })}>
                  <option value="">All</option>
                  {(Object.keys(TYPE_LABEL) as SentType[]).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                </FilterSelect>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <FilterSelect label="Where it came from" value={filters.source ?? ''} onChange={(v) => p.onFilters({ source: (v || null) as SentSource | null })}>
                  <option value="">Anywhere</option>
                  {(Object.keys(SOURCE_LABEL) as SentSource[]).map((s) => <option key={s} value={s}>{SOURCE_LABEL[s]}</option>)}
                </FilterSelect>
                {segment === 'sent' ? (
                  <FilterSelect label="Got a reply" value={filters.replied == null ? '' : filters.replied ? 'yes' : 'no'} onChange={(v) => p.onFilters({ replied: v === 'yes' ? true : v === 'no' ? false : null })}>
                    <option value="">Either</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </FilterSelect>
                ) : <span />}
              </div>
              {!!p.sequences?.length && (
                <FilterSelect label="Sequence" value={filters.sequence_id ?? ''} onChange={(v) => p.onFilters({ sequence_id: v || null })}>
                  <option value="">All sequences</option>
                  {p.sequences.filter((q) => q.status !== 'archived' || q.id === filters.sequence_id).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </FilterSelect>
              )}
            </div>
          )}
        </div>

        {active.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {active.map((a) => (
              <span key={a.key} className="inline-flex items-center gap-1 max-w-full text-[11px] rounded-full bg-indigo-50 border border-indigo-100 text-indigo-800 pl-2 pr-0.5 py-0.5">
                <span className="truncate"><span className="text-indigo-500">{a.label}:</span> {a.value}</span>
                <button type="button" onClick={a.clear} className="p-0.5 rounded-full hover:bg-indigo-100 flex-shrink-0" aria-label={`Clear ${a.label} filter`} title={`Clear ${a.label} filter`}><X className="w-3 h-3" /></button>
              </span>
            ))}
          </div>
        )}

        {bulkAllowed && allSelectable.length > 0 && (
          <div className="flex items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5 text-gray-600 cursor-pointer">
              <input type="checkbox" className="accent-indigo-600" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(allSelectable.map((r) => r.id)) : new Set())} />
              {selected.size ? `${selectedItems.length} selected` : 'Select'}
            </label>
            {selected.size > 0 && (
              <div className="ml-auto flex items-center gap-1">
                {segment === 'scheduled' ? (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => actions.run('pause_lead', selectedItems)}>Pause leads</Button>
                    <Button size="sm" variant="secondary" onClick={() => actions.run('remove_from_sequence', selectedItems)}>Remove</Button>
                  </>
                ) : (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => actions.run('retry', selectedItems)}>Retry</Button>
                    <Button size="sm" variant="secondary" onClick={() => actions.run('skip', selectedItems)}>Skip</Button>
                    <Button size="sm" variant="secondary" onClick={() => actions.run('remove_failed', selectedItems)}>Remove</Button>
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 min-h-0 overflow-y-auto" role="listbox" aria-label={`${SEGMENT_LABEL[segment]} sends`}>
        {p.error && <ErrorBox message={p.error} className="m-3" />}
        {!p.error && p.loading && !rows && <Spinner />}
        {!p.error && rows && rows.length === 0 && (
          <EmptyState icon={segment === 'scheduled' ? <CalendarClock className="w-6 h-6" /> : segment === 'failed' ? <AlertTriangle className="w-6 h-6" /> : <Send className="w-6 h-6" />}
            title={p.search || nActive ? 'Nothing matches' : SENT_EMPTY[segment]}
            description={p.search || nActive ? 'Try clearing some filters.' : segment === 'sent' ? 'Pick a longer period, or check Scheduled for what goes out next.' : undefined}
            action={segment === 'scheduled' && !p.search ? (
              filters.sender_ids.length === 1 || filters.sequence_id
                ? <Button size="sm" variant="secondary" onClick={() => setWhy(true)}>Why isn&apos;t it sending?</Button>
                : <Link href="/outreach/senders" className="text-sm text-indigo-600 hover:underline">Why isn&apos;t it sending?</Link>
            ) : undefined} />
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="sticky top-0 z-10 bg-gray-50/95 backdrop-blur px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-gray-500 border-b border-gray-100">{g.label}</div>
            {g.items.map((it) => {
              const isActive = it.id === p.selectedId;
              const SourceIcon = SOURCE_ICON[it.source];
              const prefix = typePrefix(it);
              const acts = rowActions(it, can);
              const what = [prefix, it.subject ? `“${it.subject}”` : null].filter(Boolean).join(' · ');
              return (
                <div key={it.id} role="option" aria-selected={isActive} tabIndex={0}
                  onClick={() => p.onSelect(it)} onKeyDown={(e) => { if (e.key === 'Enter') p.onSelect(it); }}
                  style={{ contentVisibility: 'auto', containIntrinsicSize: '84px' } as React.CSSProperties}
                  className={cn('group w-full text-left px-3 py-2 flex items-start gap-2.5 border-b border-l-[3px] cursor-pointer outline-none focus-visible:bg-indigo-50/60', isActive ? 'bg-indigo-100/60 border-l-indigo-600 border-b-indigo-100' : 'border-l-transparent border-b-gray-100 hover:bg-gray-50')}>
                  {selectable(it) ? (
                    <input type="checkbox" className="mt-2.5 accent-indigo-600 flex-shrink-0" checked={selected.has(it.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(it.id)} aria-label={`Select ${it.lead?.name ?? 'row'}`} />
                  ) : null}
                  <div className="pt-0.5 flex-shrink-0"><Avatar src={it.lead?.picture_url} name={it.lead?.name ?? '?'} size={8} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className={cn('text-sm truncate flex-shrink-0 max-w-[70%]', isActive ? 'font-semibold text-indigo-900' : 'font-medium text-gray-900')}>{it.lead?.name ?? 'Unknown recipient'}</span>
                      {it.lead?.company && <span className="text-xs text-gray-500 truncate min-w-0">· {it.lead.company}</span>}
                      <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0 tabular-nums" title={new Date(it.at).toLocaleString()}>{fmtTime(it.at, p.tz)}</span>
                    </div>
                    <p className="text-xs text-gray-600 truncate mt-0.5">
                      {what && <span className="font-medium text-gray-700">{what}{it.preview ? ' · ' : ''}</span>}
                      {it.deleted ? <span className="italic text-gray-400">Deleted</span> : (it.preview ? `“${it.preview}”` : (!what ? '—' : ''))}
                    </p>
                    <div className="flex items-center gap-1.5 mt-1 min-w-0">
                      <SourceIcon className="w-3 h-3 text-gray-400 flex-shrink-0" />
                      <span className="text-[11px] text-gray-500 truncate min-w-0" title={sourceLine(it)}>{sourceLine(it)}</span>
                      {it.from_ai_draft && <span className="text-[10px] px-1 rounded bg-indigo-50 text-indigo-700 flex-shrink-0" title="They sent or edited an AI draft">AI draft</span>}
                      {it.deleted && <span className="text-[10px] px-1 rounded bg-gray-100 text-gray-600 flex-shrink-0">Deleted</span>}
                      <span className="ml-auto flex-shrink-0 max-w-[55%]"><StatusPill it={it} tz={p.tz} /></span>
                    </div>
                    <div className="flex items-center gap-1 mt-0.5 min-w-0 text-[11px] text-gray-400">
                      <ProviderLogo provider={it.sender.provider ?? 'LINKEDIN'} className="w-3 h-3 rounded-[2px] flex-shrink-0" />
                      <span className="truncate">{it.sender.name ?? 'Sender'} · {CHANNEL_LABEL[it.channel] ?? it.channel}</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 -mr-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100">
                    <RowMenu actions={acts} onRun={(k) => actions.run(k, [it])} />
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {rows && rows.length > 0 && (p.hasMore || p.loadingMore) && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-gray-500" role="status" aria-live="polite">
            <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" aria-hidden="true" />
            <span>Loading more…</span>
          </div>
        )}
      </div>
      {actions.modals}
      <WhyNotSendingDialog open={why} onClose={() => setWhy(false)} senderId={!filters.sequence_id && filters.sender_ids.length === 1 ? filters.sender_ids[0] : null} sequenceId={filters.sequence_id} />
    </div>
  );
}
