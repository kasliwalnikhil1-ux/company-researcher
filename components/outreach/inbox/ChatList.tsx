'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Inbox, X, Filter, SlidersHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHANNEL_PROVIDERS, MAIL_PROVIDERS, channelLabel, chatTitle } from '@/lib/outreach/channels';
import { ProviderLogo } from '@/components/outreach/senders/ProviderLogo';
import type { ChatFilters } from '@/lib/outreach/queries';
import type { Chat, Client, Lead, Sender, Sequence } from '@/lib/outreach/types';
import { Avatar, IntentBadge, Spinner, ErrorBox, EmptyState, timeAgo } from '@/components/outreach/ui';
import { INTENTS, INTENT_LABELS } from './hooks';

export type ChatRow = Chat & { outreach_leads: Partial<Lead> | null; outreach_senders: Partial<Sender> | null };

export interface ChatListProps {
  rows: ChatRow[] | undefined;
  loading: boolean;
  error: string | null;
  filters: ChatFilters;
  onFilters: (patch: Partial<ChatFilters>) => void;
  search: string;
  onSearch: (v: string) => void;
  senders: Sender[] | undefined;
  clients: Client[] | undefined;
  currentUserId: string | null;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Item 4: filter by sequence (threads that carry a step of it). */
  sequences?: Sequence[];
  sequenceId?: string | null;
  onSequence?: (id: string | null) => void;
  /** Reports drill-down: only these threads are listed until the chip is dismissed. */
  restrictLabel?: string | null;
  restrictCount?: number;
  onClearRestrict?: () => void;
  note?: string | null;
}

const ROW_H = 76;
const OVERSCAN = 6;

export function chatDisplayName(c: ChatRow): string {
  return chatTitle(c);
}

function FilterField({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={cn('w-full text-sm rounded-md border bg-white px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-indigo-500', value ? 'border-indigo-300 text-gray-900' : 'border-gray-200 text-gray-600')}>
        {children}
      </select>
    </label>
  );
}

function ActiveChip({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 max-w-full text-[11px] rounded-full bg-indigo-50 border border-indigo-100 text-indigo-800 pl-2 pr-0.5 py-0.5">
      <span className="truncate"><span className="text-indigo-500">{label}:</span> {value}</span>
      <button type="button" onClick={onClear} className="p-0.5 rounded-full hover:bg-indigo-100 flex-shrink-0" aria-label={`Clear ${label} filter`} title={`Clear ${label} filter`}><X className="w-3 h-3" /></button>
    </span>
  );
}

type View = 'all' | 'unread' | 'mine' | 'archived';

export default function ChatList({ rows, loading, error, filters, onFilters, search, onSearch, senders, clients, currentUserId, selectedId, onSelect, sequences, sequenceId, onSequence, restrictLabel, restrictCount, onClearRestrict, note }: ChatListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const list = rows ?? [];
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(list.length, Math.ceil((scrollTop + height) / ROW_H) + OVERSCAN);
  const visible = useMemo(() => list.slice(start, end), [list, start, end]);

  // Keep the selected row within the viewport (keyboard navigation).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !selectedId) return;
    const idx = list.findIndex((r) => r.id === selectedId);
    if (idx < 0) return;
    const top = idx * ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [selectedId, list]);

  // Filters popover: close on outside click / Escape.
  const [filtersOpen, setFiltersOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filtersOpen) return;
    const onDown = (e: MouseEvent) => { if (popRef.current && !popRef.current.contains(e.target as Node)) setFiltersOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFiltersOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [filtersOpen]);

  const view: View = filters.archived ? 'archived' : filters.assigned_to && filters.assigned_to === currentUserId ? 'mine' : filters.unread ? 'unread' : 'all';
  const setView = (v: View) => onFilters({ archived: v === 'archived', unread: v === 'unread' ? true : null, assigned_to: v === 'mine' ? currentUserId : null });
  const views: { id: View; label: string; title: string }[] = [
    { id: 'all', label: 'All', title: 'All open conversations' },
    { id: 'unread', label: 'Unread', title: 'Only unread' },
    { id: 'mine', label: 'Mine', title: 'Assigned to me' },
    { id: 'archived', label: 'Archived', title: 'Archived conversations' },
  ];

  const senderName = (s: Partial<Sender>) => s.display_name ?? s.public_identifier ?? s.provider ?? 'Sender';
  const active: { key: string; label: string; value: string; clear: () => void }[] = [];
  if (filters.sender_id) { const s = senders?.find((x) => x.id === filters.sender_id); active.push({ key: 'sender', label: 'Sender', value: s ? senderName(s) : 'Selected', clear: () => onFilters({ sender_id: null }) }); }
  if (filters.client_id) active.push({ key: 'client', label: 'Client', value: clients?.find((x) => x.id === filters.client_id)?.name ?? 'Selected', clear: () => onFilters({ client_id: null }) });
  if (sequenceId && onSequence) active.push({ key: 'sequence', label: 'Sequence', value: sequences?.find((x) => x.id === sequenceId)?.name ?? 'Selected', clear: () => onSequence(null) });
  if (filters.intent) active.push({ key: 'intent', label: 'Intent', value: INTENT_LABELS[filters.intent as keyof typeof INTENT_LABELS] ?? filters.intent, clear: () => onFilters({ intent: null }) });
  if (filters.provider) active.push({ key: 'channel', label: 'Channel', value: channelLabel(filters.provider as Parameters<typeof channelLabel>[0]), clear: () => onFilters({ provider: null }) });
  const clearAll = () => { onFilters({ sender_id: null, client_id: null, intent: null, provider: null }); onSequence?.(null); };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 border-b border-gray-100 space-y-2">
        {restrictLabel != null && (
          <div className="flex items-center gap-1.5 rounded-lg bg-indigo-50 border border-indigo-200 text-indigo-800 text-xs pl-2.5 pr-1 py-1" role="status">
            <Filter className="w-3 h-3 flex-shrink-0" />
            <span className="min-w-0 flex-1 truncate" title={restrictLabel}>Showing: <span className="font-medium">{restrictLabel || 'selected conversations'}</span>{restrictCount ? ` (${restrictCount.toLocaleString()})` : ''}</span>
            <button type="button" onClick={onClearRestrict} className="p-1 rounded hover:bg-indigo-100" aria-label="Show all conversations" title="Show all conversations"><X className="w-3 h-3" /></button>
          </div>
        )}
        <div ref={popRef} className="relative flex items-center gap-1.5">
          <label className="relative block flex-1 min-w-0">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="w-full pl-8 pr-7 py-1.5 text-sm rounded-lg border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            {search && <button type="button" onClick={() => onSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded text-gray-400 hover:text-gray-600" aria-label="Clear search" title="Clear search"><X className="w-3.5 h-3.5" /></button>}
          </label>
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            aria-expanded={filtersOpen}
            aria-haspopup="dialog"
            title="Filter conversations"
            className={cn('relative flex-shrink-0 inline-flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border', filtersOpen || active.length ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}
          >
            <SlidersHorizontal className="w-4 h-4" />
            <span className="hidden sm:inline">Filters</span>
            {active.length > 0 && <span className="text-[10px] leading-none bg-indigo-600 text-white rounded-full px-1.5 py-0.5 tabular-nums">{active.length}</span>}
          </button>

          {filtersOpen && (
            <div role="dialog" aria-label="Filters" className="absolute right-0 top-full mt-1.5 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-gray-200 bg-white shadow-lg p-3 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-gray-900">Filters</span>
                {active.length > 0 && <button type="button" onClick={clearAll} className="text-xs text-indigo-600 hover:text-indigo-800">Clear all</button>}
              </div>
              <FilterField label="Sender" value={filters.sender_id ?? ''} onChange={(v) => onFilters({ sender_id: v || null })}>
                <option value="">All senders</option>
                {senders?.map((s) => <option key={s.id} value={s.id}>{senderName(s)}</option>)}
              </FilterField>
              {!!clients?.length && (
                <FilterField label="Client" value={filters.client_id ?? ''} onChange={(v) => onFilters({ client_id: v || null })}>
                  <option value="">All clients</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </FilterField>
              )}
              {onSequence && !!sequences?.length && (
                <FilterField label="Sequence" value={sequenceId ?? ''} onChange={(v) => onSequence(v || null)}>
                  <option value="">All sequences</option>
                  {sequences.filter((q) => q.status !== 'archived' || q.id === sequenceId).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
                </FilterField>
              )}
              <div className="grid grid-cols-2 gap-2">
                <FilterField label="Intent" value={filters.intent ?? ''} onChange={(v) => onFilters({ intent: v || null })}>
                  <option value="">Any</option>
                  {INTENTS.map((i) => <option key={i} value={i}>{INTENT_LABELS[i]}</option>)}
                </FilterField>
                <FilterField label="Channel" value={filters.provider ?? ''} onChange={(v) => onFilters({ provider: v || null })}>
                  <option value="">All</option>
                  {CHANNEL_PROVIDERS.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}
                  {MAIL_PROVIDERS.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}
                </FilterField>
              </div>
            </div>
          )}
        </div>

        <div className="flex p-0.5 rounded-lg bg-gray-100" role="tablist" aria-label="Conversation view">
          {views.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              title={v.title}
              onClick={() => setView(v.id)}
              className={cn('flex-1 text-xs py-1 rounded-md transition-colors', view === v.id ? 'bg-white text-gray-900 font-medium shadow-sm' : 'text-gray-500 hover:text-gray-800')}
            >
              {v.label}
            </button>
          ))}
        </div>

        {active.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            {active.map((a) => <ActiveChip key={a.key} label={a.label} value={a.value} onClear={a.clear} />)}
            {active.length > 1 && <button type="button" onClick={clearAll} className="text-[11px] text-gray-500 hover:text-gray-800 px-1">Clear all</button>}
          </div>
        )}
      </div>

      <div ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="flex-1 min-h-0 overflow-y-auto" role="listbox" aria-label="Conversations">
        {error && <ErrorBox message={error} className="m-3" />}
        {!error && loading && !rows && <Spinner />}
        {!error && rows && rows.length === 0 && (
          <EmptyState icon={<Inbox className="w-6 h-6" />} title={filters.archived ? 'No archived conversations' : 'No conversations'} description={restrictLabel != null ? 'None of the linked conversations match the filters. Close the chip above to see everything.' : sequenceId ? 'No conversation carries a step of this sequence with these filters.' : search || filters.sender_id || filters.intent || filters.unread || filters.assigned_to || filters.provider || filters.client_id ? 'Try clearing some filters.' : 'Replies land here as soon as a sender receives a message.'} />
        )}
        {note && rows && rows.length > 0 && <p className="px-3 py-1.5 text-[11px] text-gray-500 bg-gray-50 border-b border-gray-100">{note}</p>}
        {rows && rows.length > 0 && (
          <div style={{ height: list.length * ROW_H, position: 'relative' }}>
            <div style={{ transform: `translateY(${start * ROW_H}px)` }}>
              {visible.map((c) => {
                const active = c.id === selectedId;
                const name = chatDisplayName(c);
                // WhatsApp shows formatted text without its *bold* / _italic_ / ~strike~ markers in the list
                const plain = c.provider === 'WHATSAPP' && c.last_message_preview ? c.last_message_preview.replace(/(^|[^\w])([*_~]{1,2})(\S(?:[^\n]*?\S)?)\2(?=$|[^\w])/g, '$1$3') : c.last_message_preview;
                const preview = plain ? `${c.last_direction === 'out' ? 'You: ' : ''}${plain}` : (c.subject ?? '');
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => onSelect(c.id)}
                    style={{ height: ROW_H, contentVisibility: 'auto', containIntrinsicSize: `${ROW_H}px` } as React.CSSProperties}
                    className={cn('w-full text-left px-3 flex items-start gap-2.5 border-b border-l-[3px] transition-colors', active ? 'bg-indigo-100/60 border-l-indigo-600 border-b-indigo-100' : 'border-l-transparent border-b-gray-100 hover:bg-gray-50', c.unread && !active && 'bg-white')}
                  >
                    <div className="pt-3"><div className={cn('rounded-full', active && 'ring-2 ring-indigo-500 ring-offset-2 ring-offset-indigo-50')}><Avatar src={c.attendee_picture_url || c.outreach_leads?.picture_url} name={name} size={9} /></div></div>
                    <div className="flex-1 min-w-0 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('text-sm truncate', active ? 'font-semibold text-indigo-900' : c.unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-800')}>{name}</span>
                        <span title={channelLabel(c.provider)} className="flex-shrink-0"><ProviderLogo provider={c.provider} className="w-3 h-3 rounded-[2px]" /></span>
                        <span className="ml-auto text-[11px] text-gray-400 flex-shrink-0 tabular-nums">{timeAgo(c.last_message_at)}</span>
                      </div>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {c.outreach_senders?.display_name && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 truncate max-w-[45%]">{c.outreach_senders.display_name}</span>}
                        {c.is_request && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800" title="Instagram message request: the person has not accepted the conversation yet, so they may not have seen it">Request</span>}
                        {c.intent && c.intent !== 'unclassified' && <IntentBadge intent={c.intent} />}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <p className={cn('text-xs truncate flex-1', c.unread ? 'text-gray-800' : 'text-gray-500')}>{preview || '—'}</p>
                        {c.unread && (
                          c.unread_count > 1
                            ? <span className="text-[10px] bg-indigo-600 text-white rounded-full px-1.5 py-0.5 leading-none flex-shrink-0">{c.unread_count > 99 ? '99+' : c.unread_count}</span>
                            : <span className="w-2 h-2 rounded-full bg-indigo-600 flex-shrink-0" aria-label="Unread" />
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
