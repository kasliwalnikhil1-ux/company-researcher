'use client';

// The Sequences list (sequence-stats-PRD.md §6): results counted in people with a rate next to each — Contacted ·
// Accepted · Replied · Positive — plus a progress ring; a period selector (All time · 7d · 14d · 30d · 90d · Custom)
// and channel chips above the table; sortable result columns. Every number comes from outreach_report_sequences.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from '@/lib/outreach/nav';
import { useRouter } from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, Copy, ExternalLink, FilePlus2, GitBranch, LayoutTemplate, MoreHorizontal, Plus, Search, Trash2, UserX, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError, rpc } from '@/lib/outreach/api';
import { normalizeGraph } from '@/lib/outreach/graph';
import { qk, useClients, useSenders, useSequences } from '@/lib/outreach/queries';
import { fmtInt, useReportSequences, type SequenceRow } from '@/lib/outreach/reports';
import {
  acceptedTip, contactedTip, periodFromString, periodRange, periodToString, positiveTip, progressTip, rateSortValue, repliedTip,
  STATS_CHANNEL_LABEL, type StatsChannel, type StatsPeriod,
} from '@/lib/outreach/sequenceStats';
import type { Sequence, SequenceStatus } from '@/lib/outreach/types';
import { Avatar, Badge, Button, EmptyState, ErrorBox, Input, Modal, PageHeader, Select, Spinner, Table, Td, Th, timeAgo, useToast } from '@/components/outreach/ui';
import { ConfirmModal } from '@/components/outreach/sequences/Modals';
import { DeleteSequenceModal } from '@/components/outreach/sequences/DeleteSequenceModal';
import { useFailedCounts } from '@/components/outreach/sequences/hooks';
import FailedLeadsDrawer from '@/components/outreach/sequences/FailedLeadsDrawer';
import TemplatePicker from '@/components/outreach/sequences/TemplatePicker';
import { WhyNotSendingDialog } from '@/components/outreach/sequences/WhyNotSendingDialog';
import { type SequenceExt } from '@/components/outreach/sequences/publishTypes';
import { formatGraphError, nodeCount, senderName, STATUS_TONE } from '@/components/outreach/sequences/helpers';
import StatsPeriodPicker from '@/components/outreach/sequences/stats/StatsPeriodPicker';
import { ProgressRing } from '@/components/outreach/sequences/stats/ProgressRing';
import { ChannelGlyphs } from '@/components/outreach/sequences/stats/ChannelGlyphs';
import { Dash, MetricCell } from '@/components/outreach/sequences/stats/MetricCell';
import { sanitizeLike, usePersistedFilters } from '@/lib/outreach/persistedFilters';
import { PaginationBar, usePagedRows } from '@/components/outreach/Pagination';

const STATUSES: SequenceStatus[] = ['draft', 'active', 'paused', 'archived'];
const CHANNELS: StatsChannel[] = ['linkedin', 'instagram', 'whatsapp', 'email'];

/** Same compact control as the leads filter bar. */
const SEL = 'px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 focus:outline-none focus:ring-2 focus:ring-indigo-500';

const MENU_ITEM = 'w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-gray-700';

function RowMenu({ s, canManage, onDuplicate, onArchive, onDelete }: { s: Sequence; canManage: boolean; onDuplicate: () => void; onArchive: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // The table scrolls horizontally, so an absolutely positioned menu gets clipped by the
  // card. Render it in a portal and anchor it to the button in viewport coordinates.
  const place = useCallback(() => {
    const anchor = btnRef.current?.getBoundingClientRect();
    if (!anchor) return;
    const menu = menuRef.current?.getBoundingClientRect();
    const w = menu?.width || 176;
    const h = menu?.height || 160;
    const gap = 4;
    const edge = 8;
    const left = Math.min(Math.max(edge, anchor.right - w), window.innerWidth - w - edge);
    const below = anchor.bottom + gap;
    const top = below + h > window.innerHeight - edge ? Math.max(edge, anchor.top - h - gap) : below;
    setPos({ top, left });
  }, []);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = () => setOpen(false);

  return (
    <>
      <button ref={btnRef} type="button" onClick={() => setOpen((o) => !o)} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500" aria-label="Actions" aria-haspopup="menu" aria-expanded={open}><MoreHorizontal className="w-4 h-4" /></button>
      {open && typeof document !== 'undefined' && createPortal(
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div ref={menuRef} role="menu" style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
            className="fixed z-50 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
            <Link href={`/outreach/sequences/${s.id}`} className={MENU_ITEM} role="menuitem" onClick={close}><ExternalLink className="w-4 h-4 flex-shrink-0" /> Open</Link>
            <Link href={`/outreach/sequences/${s.id}?tab=results`} className={MENU_ITEM} role="menuitem" onClick={close}><GitBranch className="w-4 h-4 flex-shrink-0" /> Analytics</Link>
            {canManage && <button type="button" onClick={() => { close(); onDuplicate(); }} className={MENU_ITEM} role="menuitem"><Copy className="w-4 h-4 flex-shrink-0" /> Duplicate</button>}
            {canManage && s.status !== 'archived' && <button type="button" onClick={() => { close(); onArchive(); }} className={MENU_ITEM} role="menuitem"><Archive className="w-4 h-4 flex-shrink-0" /> Archive</button>}
            {canManage && <button type="button" onClick={() => { close(); onDelete(); }} className={cn(MENU_ITEM, 'hover:bg-red-50 text-red-600')} role="menuitem"><Trash2 className="w-4 h-4 flex-shrink-0" /> Delete</button>}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/** One "New sequence" button; the dropdown offers a ready-made template or a blank canvas. */
function NewSequenceMenu({ onTemplate, onBlank }: { onTemplate: () => void; onBlank: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('mousedown', onDown); };
  }, [open]);

  const choose = (fn: () => void) => { setOpen(false); fn(); };

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open}><Plus className="w-4 h-4" /> New sequence <ChevronDown className="w-4 h-4 -mr-1" /></Button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-40 w-64 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
          <button type="button" role="menuitem" onClick={() => choose(onTemplate)} className={cn(MENU_ITEM, 'items-start')}>
            <LayoutTemplate className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span><span className="block font-medium text-gray-900">Start from a template</span><span className="block text-xs text-gray-500">Connect, follow up, rotate senders, nurture</span></span>
          </button>
          <button type="button" role="menuitem" onClick={() => choose(onBlank)} className={cn(MENU_ITEM, 'items-start')}>
            <FilePlus2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span><span className="block font-medium text-gray-900">Build from scratch</span><span className="block text-xs text-gray-500">An empty canvas with just a start and an end</span></span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sorting the result columns (count or rate; small bases last)
// ---------------------------------------------------------------------------
type SortKey = 'name' | 'progress' | 'contacted' | 'accepted' | 'accepted_rate' | 'replied' | 'replied_rate' | 'positive' | 'positive_rate' | 'updated';
interface SortState { key: SortKey; dir: 'asc' | 'desc' }

function sortValue(key: SortKey, s: Sequence, st: SequenceRow | undefined, dir: 'asc' | 'desc'): number | string {
  if (key === 'name') return s.name.toLowerCase();
  if (key === 'updated') return s.updated_at;
  if (!st || s.status === 'draft') return dir === 'desc' ? -2 : Number.MAX_SAFE_INTEGER;   // drafts have no results: always last
  switch (key) {
    case 'progress': return st.progress.pct_done ?? -1;
    case 'contacted': return st.contacted;
    case 'accepted': return st.na.accepted ? -1 : st.accepted;
    case 'accepted_rate': return st.na.accepted ? (dir === 'desc' ? -2 : Number.MAX_SAFE_INTEGER) : rateSortValue(st.accepted_rate, st.invited, dir);
    case 'replied': return st.replied;
    case 'replied_rate': return rateSortValue(st.replied_rate, st.contacted, dir);
    case 'positive': return st.positive;
    case 'positive_rate': return rateSortValue(st.positive_rate, st.replied, dir);
  }
}

function SortableTh({ label, k, rateKey, sort, onSort, title, className }: { label: string; k: SortKey; rateKey?: SortKey; sort: SortState; onSort: (k: SortKey) => void; title?: string; className?: string }) {
  const active = sort.key === k || (!!rateKey && sort.key === rateKey);
  const Icon = !active ? ArrowUpDown : sort.dir === 'desc' ? ArrowDown : ArrowUp;
  return (
    <Th className={cn('text-right', className)} title={title}>
      <span className="inline-flex items-center gap-1">
        <button type="button" onClick={() => onSort(k)} aria-sort={sort.key === k ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined} className={cn('inline-flex items-center gap-1 hover:text-gray-900', sort.key === k && 'text-gray-900')} title={`Sort by ${label.toLowerCase()}`}>
          {label}<Icon className={cn('w-3 h-3', sort.key === k ? 'text-gray-700' : 'text-gray-300')} aria-hidden />
        </button>
        {rateKey && <button type="button" onClick={() => onSort(rateKey)} className={cn('text-[10px] font-medium rounded px-1 border', sort.key === rateKey ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'text-gray-400 border-gray-200 hover:text-gray-700')} title={`Sort by ${label.toLowerCase()} rate`}>%</button>}
      </span>
    </Th>
  );
}

export default function SequencesPage() {
  const { workspace, isManager, canWrite, suspended, timezone } = useWorkspace();
  const ws = workspace?.id ?? null;
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const seqs = useSequences(ws);
  const failedCounts = useFailedCounts(ws);
  const [whyFor, setWhyFor] = useState<string | null>(null);
  const [failedFor, setFailedFor] = useState<Sequence | null>(null);
  const senders = useSenders(ws);
  const clients = useClients(ws);
  const canManage = isManager && !suspended;

  // Status, client, period and channel are remembered per workspace in this browser; the search is not.
  const { filters: listFilters, patch: patchListFilters } = usePersistedFilters<{ status: '' | SequenceStatus; client: string; period: string; channel: '' | StatsChannel }>('sequences', ws, { status: '', client: '', period: 'all', channel: '' }, {
    sanitize: (raw, d) => {
      const v = sanitizeLike(raw, d);
      if (v.status && !(STATUSES as readonly string[]).includes(v.status)) v.status = '';
      if (v.channel && !(CHANNELS as readonly string[]).includes(v.channel)) v.channel = '';
      v.period = periodToString(periodFromString(v.period));
      return v;
    },
  });
  const { status, client, channel } = listFilters;
  const period: StatsPeriod = useMemo(() => periodFromString(listFilters.period), [listFilters.period]);
  const setStatus = (v: '' | SequenceStatus) => patchListFilters({ status: v });
  const setClient = (v: string) => patchListFilters({ client: v });
  const setPeriod = (p: StatsPeriod) => patchListFilters({ period: periodToString(p) });
  const setChannel = (c: '' | StatsChannel) => patchListFilters({ channel: c });
  const range = periodRange(period, timezone);
  // Results for every status (archived included): the status filter is applied client-side with the search.
  const stats = useReportSequences({ ws, range, status: 'all', refetchInterval: 30000 });
  const statsMap = useMemo(() => Object.fromEntries((stats.data ?? []).map((r) => [r.sequence_id, r])), [stats.data]);
  const usedChannels = useMemo(() => CHANNELS.filter((c) => (stats.data ?? []).some((r) => r.channels.some((x) => x.channel === c))), [stats.data]);

  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<SortState>({ key: 'replied', dir: 'desc' });
  const onSort = (k: SortKey) => setSort((s) => (s.key === k ? { key: k, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: k, dir: k === 'name' ? 'asc' : 'desc' }));
  const [createOpen, setCreateOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newClient, setNewClient] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ kind: 'archive' | 'delete'; s: Sequence } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (seqs.data ?? []).filter((s) => (!status || s.status === status) && (!client || s.client_id === client) && (!needle || s.name.toLowerCase().includes(needle))
      && (!channel || (statsMap[s.id]?.channels ?? []).some((c) => c.channel === channel)));
    const sign = sort.dir === 'desc' ? -1 : 1;
    return [...list].sort((a, b) => {
      const va = sortValue(sort.key, a, statsMap[a.id], sort.dir), vb = sortValue(sort.key, b, statsMap[b.id], sort.dir);
      if (va === vb) return a.name.localeCompare(b.name);
      return (va < vb ? -1 : 1) * sign;
    });
  }, [seqs.data, status, client, channel, search, sort, statsMap]);
  const { pageRows, ...pager } = usePagedRows(rows, [ws, search.trim().toLowerCase(), status, client, channel, sort.key, sort.dir].join('|'));
  const filtered = !!(search.trim() || status || client || channel);
  const clearFilters = () => { setSearch(''); patchListFilters({ status: '', client: '', channel: '' }); };

  const invalidate = () => { if (ws) { qc.invalidateQueries({ queryKey: qk.sequences(ws) }); qc.invalidateQueries({ queryKey: ['outreach', ws, 'reports', 'sequences'] }); } };

  const create = async () => {
    if (!ws || !newName.trim()) return;
    setCreating(true);
    try {
      const id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: newName.trim(), p_client_id: newClient || null });
      invalidate();
      router.push(`/outreach/sequences/${id}`);
    } catch (e) { toast.show(parseError(e).message, 'error'); setCreating(false); }
  };

  const duplicate = async (s: Sequence) => {
    if (!ws) return;
    setBusyId(s.id);
    try {
      const id = await rpc<string>('create_sequence', { p_workspace: ws, p_name: `${s.name} (copy)`, p_client_id: s.client_id });
      await rpc('save_sequence', { p_id: id, p_graph: normalizeGraph(s.graph), p_pool: s.sender_pool, p_settings: s.settings, p_assignment: s.assignment, p_use_sender_schedule: s.use_sender_schedule, p_brief: s.brief ?? '' });
      invalidate();
      toast.show(`Duplicated “${s.name}”`);
    } catch (e) { toast.show(formatGraphError(e), 'error'); }
    finally { setBusyId(null); }
  };

  const runConfirm = async () => {
    if (confirm?.kind !== 'archive') return;
    const { s } = confirm;
    setBusyId(s.id);
    try {
      await rpc('set_sequence_status', { p_id: s.id, p_status: 'archived' });
      toast.show(`Archived “${s.name}”`);
      invalidate();
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setBusyId(null); setConfirm(null); }
  };

  // Any status: leads still in it are taken out first (outreach_delete_sequence). A wrong name keeps the dialog open
  // with the reason; a sequence someone else already deleted just leaves the list.
  const runDelete = async (typedName: string) => {
    if (confirm?.kind !== 'delete') return;
    const { s } = confirm;
    setBusyId(s.id);
    setDeleteError(null);
    try {
      const res = await rpc<{ exited: number }>('delete_sequence', { p_id: s.id, p_confirm: typedName });
      toast.show(res?.exited ? `Deleted “${s.name}” and took ${fmtInt(res.exited)} ${res.exited === 1 ? 'lead' : 'leads'} out of it` : `Deleted “${s.name}”`);
      setConfirm(null);
      invalidate();
    } catch (e) {
      const err = parseError(e);
      if (err.code === 'E_NOT_FOUND') { toast.show(`“${s.name}” was already deleted`); setConfirm(null); invalidate(); }
      else if (err.code === 'E_PAYLOAD_INVALID') { setDeleteError('The name you typed does not match. It may have just been renamed: close this and try again.'); invalidate(); }
      else setDeleteError(err.message);
    } finally { setBusyId(null); }
  };

  const chip = (active: boolean) => cn('px-2.5 py-1 text-xs font-medium rounded-full border transition-colors', active ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50');

  return (
    <div>
      <PageHeader title="Sequences" subtitle="Multi-step LinkedIn, Instagram, WhatsApp and email flows run by your sender pool."
        actions={canManage && <NewSequenceMenu onTemplate={() => setTemplateOpen(true)} onBlank={() => { setNewName(''); setNewClient(''); setCreateOpen(true); }} />} />

      <div className="flex flex-wrap items-center gap-2 mb-3">
        <label className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input aria-label="Search sequences" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search sequences…" className={cn(SEL, 'w-full pl-8')} />
        </label>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as '' | SequenceStatus)} className={SEL}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
        </select>
        {(clients.data?.length ?? 0) > 0 && (
          <select aria-label="Client" value={client} onChange={(e) => setClient(e.target.value)} className={SEL}>
            <option value="">All clients</option>
            {clients.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        {filtered && <Button variant="ghost" size="sm" onClick={clearFilters}><X className="w-3.5 h-3.5" /> Clear</Button>}
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <StatsPeriodPicker value={period} onChange={setPeriod} timezone={timezone} compact />
        {usedChannels.length > 0 && (
          <div className="inline-flex flex-wrap items-center gap-1" role="group" aria-label="Channel">
            <button type="button" aria-pressed={!channel} onClick={() => setChannel('')} className={chip(!channel)}>All channels</button>
            {usedChannels.map((c) => <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(channel === c ? '' : c)} className={chip(channel === c)}>{STATS_CHANNEL_LABEL[c]}</button>)}
          </div>
        )}
      </div>

      {seqs.isLoading ? <Spinner className="min-h-[50vh]" /> : seqs.error ? <ErrorBox message={parseError(seqs.error).message} /> : rows.length === 0 ? (
        <EmptyState icon={<GitBranch className="w-6 h-6" />} title={seqs.data?.length ? 'No sequences match these filters' : 'No sequences yet'}
          description={seqs.data?.length ? 'Try a different status, client, channel or search.' : 'Start from a ready-made flow (connect, follow up, rotate senders, nurture) or build your own: invitation, wait for connection, follow-up messages, and CRM updates.'}
          action={seqs.data?.length ? <Button variant="secondary" onClick={clearFilters}>Clear filters</Button> : canManage ? <NewSequenceMenu onTemplate={() => setTemplateOpen(true)} onBlank={() => { setNewName(''); setNewClient(''); setCreateOpen(true); }} /> : undefined} />
      ) : (
        <>
        {stats.error && <ErrorBox className="mb-3" message={`Results could not be loaded: ${parseError(stats.error).message}`} />}
        <div className={cn(stats.isPlaceholderData && 'opacity-70 transition-opacity')}>
        <Table>
          <thead>
            <tr>
              <Th title="The ring shows the share of enrolments that are done: finished, replied, removed or failed."><button type="button" onClick={() => onSort('name')} className={cn('inline-flex items-center gap-1 hover:text-gray-900', sort.key === 'name' && 'text-gray-900')}>Sequence {sort.key === 'name' ? (sort.dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />) : <ArrowUpDown className="w-3 h-3 text-gray-300" />}</button><button type="button" onClick={() => onSort('progress')} className={cn('ml-1.5 text-[10px] font-medium rounded px-1 border normal-case tracking-normal', sort.key === 'progress' ? 'bg-indigo-50 text-indigo-700 border-indigo-200' : 'text-gray-400 border-gray-200 hover:text-gray-700')} title="Sort by progress: the share of enrolments that are done (the ring)">Progress{sort.key === 'progress' ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</button></Th>
              <Th>Status</Th>
              <SortableTh label="Contacted" k="contacted" sort={sort} onSort={onSort} title="People who got at least one invite, follow or message from this sequence. Visits and likes don't count." />
              <SortableTh label="Accepted" k="accepted" rateKey="accepted_rate" sort={sort} onSort={onSort} title="LinkedIn invitations accepted and Instagram follows followed back. Rate: accepted ÷ invited, with the number still pending." />
              <SortableTh label="Replied" k="replied" rateKey="replied_rate" sort={sort} onSort={onSort} title="People who wrote back as a person after this sequence contacted them, counted once. Out-of-office and auto-replies don't count. Rate: replied ÷ contacted." />
              <SortableTh label="Positive" k="positive" rateKey="positive_rate" sort={sort} onSort={onSort} title="Replies classified interested or question, plus meetings booked. Rate: positive ÷ replied." />
              <Th title="The senders this sequence sends from. A ! means at least one of them isn't connected.">Senders</Th>
              <Th title="The client this sequence runs for, if any.">Client</Th>
              <Th className="w-10"></Th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((s) => {
              const st = statsMap[s.id];
              const ext = s as SequenceExt;
              const draft = s.status === 'draft';
              const failed = failedCounts.data?.[s.id] ?? st?.ops.failed_leads ?? 0;
              const pool = s.sender_pool.map((id) => senders.data?.find((x) => x.id === id)).filter(Boolean) as NonNullable<typeof senders.data>;
              const clientName = clients.data?.find((c) => c.id === s.client_id)?.name;
              return (
                <tr key={s.id} className={cn('hover:bg-gray-50', busyId === s.id && 'opacity-50')}>
                  <Td className="min-w-[260px] max-w-[400px]">
                    <div className="flex items-center gap-3 min-w-0">
                      <ProgressRing pct={draft || !st ? undefined : st.progress.pct_done} title={draft ? 'Not started yet' : st ? progressTip(st) : undefined} />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <Link href={`/outreach/sequences/${s.id}`} className="font-medium text-gray-900 hover:text-indigo-700 truncate" title={s.name}>{s.name}</Link>
                          {st && <ChannelGlyphs channels={st.channels} />}
                        </div>
                        <div className="text-xs text-gray-400 whitespace-nowrap">{nodeCount(s.graph)} steps · v{s.head_version} · <span title={s.updated_at}>updated {timeAgo(s.updated_at)}</span></div>
                      </div>
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <Badge tone={STATUS_TONE[s.status]} className="capitalize">{s.status}</Badge>
                      {ext.stalled_at && s.status === 'active' && (
                        <button type="button" onClick={() => setWhyFor(s.id)} title={`${ext.stalled_reason ?? 'Nothing was sent in the last sending window'}. Stalled ${timeAgo(ext.stalled_at)}. Click to see why.`} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800 hover:bg-red-200 whitespace-nowrap"><AlertTriangle className="w-3 h-3" /> Stalled</button>
                      )}
                      {s.throttled_reason && <Badge tone="amber" className="cursor-help whitespace-nowrap"><span title={s.throttled_reason} className="inline-flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Throttled</span></Badge>}
                      {failed > 0 && (
                        <button type="button" onClick={() => setFailedFor(s)} title="Leads that failed a step. Click to see why and to retry, skip or exit them." className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700 border border-red-200 hover:bg-red-100 tabular-nums whitespace-nowrap"><UserX className="w-3 h-3" /> {fmtInt(failed)}{failed >= 5000 ? '+' : ''} failed</button>
                      )}
                    </div>
                  </Td>
                  <Td className="text-right">{st ? <MetricCell count={st.contacted} draft={draft} tip={contactedTip(st)} /> : <Dash />}</Td>
                  <Td className="text-right">{st ? <MetricCell count={st.accepted} rate={st.accepted_rate} denominator={st.invited} pending={st.pending} early={st.accepted_early} na={st.na.accepted} draft={draft} tip={acceptedTip(st)} /> : <Dash />}</Td>
                  <Td className="text-right">{st ? <MetricCell count={st.replied} rate={st.replied_rate} denominator={st.contacted} draft={draft} tip={repliedTip(st)} /> : <Dash />}</Td>
                  <Td className="text-right">{st ? <MetricCell count={st.positive} rate={st.positive_rate} denominator={st.replied} draft={draft} tip={positiveTip(st)} /> : <Dash />}</Td>
                  <Td>
                    {pool.length === 0 ? <span className="text-xs text-gray-400">Empty</span> : (
                      <div className="flex items-center gap-1.5 whitespace-nowrap" title={pool.map(senderName).join(', ')}>
                        {/* Explicit width: the table under-measures a stack built from negative margins, and the label then spills into the next column. */}
                        <span className="relative h-6 shrink-0" style={{ width: 24 + (Math.min(pool.length, 4) - 1) * 16 }}>
                          {pool.slice(0, 4).map((p, i) => <span key={p.id} className="absolute top-0 ring-2 ring-white rounded-full" style={{ left: i * 16, zIndex: 4 - i }}><Avatar src={p.picture_url} name={senderName(p)} size={6} /></span>)}
                        </span>
                        <span className="text-xs text-gray-600 whitespace-nowrap">{pool.length === 1 ? senderName(pool[0]) : `${pool.length} senders`}</span>
                        {pool.some((p) => p.status !== 'ok') && <span className="text-xs text-amber-700" title="Some senders are not connected">!</span>}
                      </div>
                    )}
                  </Td>
                  <Td className="text-gray-600 whitespace-nowrap">{clientName ?? <span className="text-gray-400">—</span>}</Td>
                  <Td className="text-right"><RowMenu s={s} canManage={canManage} onDuplicate={() => duplicate(s)} onArchive={() => setConfirm({ kind: 'archive', s })} onDelete={() => setConfirm({ kind: 'delete', s })} /></Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
        </div>
        <PaginationBar {...pager} />
        <p className="text-xs text-gray-400 mt-2">People, counted once. The percent next to each count is its rate: accepted ÷ invited, replied ÷ contacted, positive ÷ replied. A dotted underline means the rate rests on fewer than 20 people or on invites that are mostly still pending. Hover a number for the full sentence.</p>
        </>
      )}

      <Modal open={createOpen} onClose={() => !creating && setCreateOpen(false)} title="New sequence" size="sm"
        footer={<><Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button><Button loading={creating} disabled={!newName.trim()} onClick={create}>Create and open</Button></>}>
        <div className="space-y-3">
          <Input label="Name" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Founders — invite + 2 follow-ups" autoFocus onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
          <Select label="Client (optional)" value={newClient} onChange={(e) => setNewClient(e.target.value)}>
            <option value="">No client</option>
            {(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </div>
      </Modal>

      <TemplatePicker open={templateOpen} onClose={() => setTemplateOpen(false)} />

      <ConfirmModal open={confirm?.kind === 'archive'} title="Archive sequence" confirmLabel="Archive" danger busy={!!busyId} onClose={() => setConfirm(null)} onConfirm={runConfirm}
        body={<p>Archiving “{confirm?.s.name}” takes all {statsMap[confirm?.s.id ?? '']?.progress.live ?? 0} leads currently in it out of the sequence and stops sending. The steps and history are kept.</p>} />
      <DeleteSequenceModal sequence={confirm?.kind === 'delete' ? confirm.s : null} liveLeads={confirm?.kind === 'delete' ? statsMap[confirm.s.id]?.progress.live : undefined}
        busy={!!busyId} error={deleteError} onClose={() => { setConfirm(null); setDeleteError(null); }} onConfirm={runDelete} />
      <WhyNotSendingDialog open={!!whyFor} onClose={() => setWhyFor(null)} sequenceId={whyFor} />
      <FailedLeadsDrawer open={!!failedFor} onClose={() => setFailedFor(null)} sequenceId={failedFor?.id ?? ''} nodeLabel={undefined} graph={failedFor?.graph ?? null} canWrite={canWrite} />
      {toast.node}
    </div>
  );
}
