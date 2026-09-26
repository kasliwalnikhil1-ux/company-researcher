'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Inbox, X, Filter } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CHANNEL_PROVIDERS, MAIL_PROVIDERS, channelLabel } from '@/lib/outreach/channels';
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
  return c.attendee_name || c.outreach_leads?.full_name || c.attendee_public_identifier || 'Unknown';
}

function MiniSelect({ value, onChange, children, title }: { value: string; onChange: (v: string) => void; children: React.ReactNode; title: string }) {
  return (
    <select title={title} aria-label={title} value={value} onChange={(e) => onChange(e.target.value)} className="text-xs rounded-md border border-gray-200 bg-white text-gray-700 px-1.5 py-1 max-w-[9rem] focus:outline-none focus:ring-2 focus:ring-indigo-500">
      {children}
    </select>
  );
}

function Chip({ active, onClick, children, title }: { active: boolean; onClick: () => void; children: React.ReactNode; title: string }) {
  return (
    <button type="button" title={title} aria-pressed={active} onClick={onClick} className={cn('text-xs px-2 py-1 rounded-md border whitespace-nowrap', active ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50')}>
      {children}
    </button>
  );
}

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
        <label className="relative block">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search conversations" aria-label="Search conversations" className="w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border border-gray-200 bg-white placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        </label>
        <div className="flex flex-wrap gap-1.5">
          <MiniSelect title="Sender" value={filters.sender_id ?? ''} onChange={(v) => onFilters({ sender_id: v || null })}>
            <option value="">All senders</option>
            {senders?.map((s) => <option key={s.id} value={s.id}>{s.display_name ?? s.public_identifier ?? s.provider}</option>)}
          </MiniSelect>
          {!!clients?.length && (
            <MiniSelect title="Client" value={filters.client_id ?? ''} onChange={(v) => onFilters({ client_id: v || null })}>
              <option value="">All clients</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </MiniSelect>
          )}
          {onSequence && !!sequences?.length && (
            <MiniSelect title="Sequence" value={sequenceId ?? ''} onChange={(v) => onSequence(v || null)}>
              <option value="">All sequences</option>
              {sequences.filter((q) => q.status !== 'archived' || q.id === sequenceId).map((q) => <option key={q.id} value={q.id}>{q.name}</option>)}
            </MiniSelect>
          )}
          <MiniSelect title="Intent" value={filters.intent ?? ''} onChange={(v) => onFilters({ intent: v || null })}>
            <option value="">Any intent</option>
            {INTENTS.map((i) => <option key={i} value={i}>{INTENT_LABELS[i]}</option>)}
          </MiniSelect>
          <MiniSelect title="Channel" value={filters.provider ?? ''} onChange={(v) => onFilters({ provider: v || null })}>
            <option value="">All channels</option>
            {CHANNEL_PROVIDERS.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}
            {MAIL_PROVIDERS.map((p) => <option key={p} value={p}>{channelLabel(p)}</option>)}
          </MiniSelect>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip title="Only unread" active={!!filters.unread} onClick={() => onFilters({ unread: filters.unread ? null : true })}>Unread</Chip>
          <Chip title="Assigned to me" active={!!filters.assigned_to && filters.assigned_to === currentUserId} onClick={() => onFilters({ assigned_to: filters.assigned_to === currentUserId ? null : currentUserId })}>Mine</Chip>
          <Chip title="Show archived conversations" active={!!filters.archived} onClick={() => onFilters({ archived: !filters.archived })}>Archived</Chip>
        </div>
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
                const preview = c.last_message_preview ? `${c.last_direction === 'out' ? 'You: ' : ''}${c.last_message_preview}` : (c.subject ?? '');
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => onSelect(c.id)}
                    style={{ height: ROW_H, contentVisibility: 'auto', containIntrinsicSize: `${ROW_H}px` } as React.CSSProperties}
                    className={cn('w-full text-left px-3 flex items-start gap-2.5 border-b border-gray-100 border-l-2', active ? 'bg-indigo-50/70 border-l-indigo-600' : 'border-l-transparent hover:bg-gray-50', c.unread && !active && 'bg-white')}
                  >
                    <div className="pt-3"><Avatar src={c.attendee_picture_url ?? c.outreach_leads?.picture_url} name={name} size={9} /></div>
                    <div className="flex-1 min-w-0 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className={cn('text-sm truncate', c.unread ? 'font-semibold text-gray-900' : 'font-medium text-gray-800')}>{name}</span>
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
