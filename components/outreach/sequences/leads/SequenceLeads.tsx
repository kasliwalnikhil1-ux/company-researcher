'use client';

// The table of everyone in a sequence (PRD "Sequence lead filters, bulk unenroll & Analytics", feature 1 + 2 + the new
// columns). One status filter in two groups with live counts, five of them as tabs; a teammate sub-filter under
// Stopped by teammate; a Stopped by column; the Leads-page selection pattern (header checkbox menu: this page / all /
// first N, the indigo bulk bar, "Showing a–b of N · k selected"); a confirm and a 10-second Undo.
// Counts, rows and the bulk predicate all come from the same SQL (migration 101), so a number here equals the table.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { useSearchParams } from '@/lib/outreach/nav';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, LogOut, Pause, Play, Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { parseError } from '@/lib/outreach/api';
import { useSenders } from '@/lib/outreach/queries';
import type { Sequence } from '@/lib/outreach/types';
import { exitReasonText } from '@/lib/outreach/reasons';
import { fmtCohortRange, isIsoDay } from '@/lib/outreach/sequenceStats';
import {
  BULK_ACTION_LABEL, EMPTY_COUNTS, LEAD_FILTERS, LEAD_FILTER_BY_KEY, LEAD_FILTER_GROUP_LABEL, STOPPED_BY_FILTERS, bulkEligible, isEnded, isLeadFilter, stepShare, stepText,
  type BulkAction, type BulkPreview, type LeadCounts, type LeadFilter, type LeadListQuery, type SequenceLeadRow,
} from '@/lib/outreach/sequenceLeads';
import { Avatar, Button, Card, EmptyState, EnrollmentBadge, ErrorBox, Select, Spinner, Table, Td, Th, fmtDate, timeAgo, useToast } from '@/components/outreach/ui';
import { InfoTip } from '@/components/ui/Tooltip';
import { SelectionMenu, type SelectionRequest } from '@/components/outreach/leads/SelectionMenu';
import { FailedLeadsPanel } from '../FailedLeadsDrawer';
import type { FailedKind } from '../publishTypes';
import { SEQUENCE_LEADS_PAGE, fetchSequenceLeadIds, previewBulk, runBulk, undoBulk, useFailedCount, useSequenceLeadCounts, useSequenceLeads, type BulkTarget, type EnrolledRange } from '../hooks';
import { BulkBar, ConfirmBulkModal, UndoToast, type BulkProgress, type UndoState } from './BulkControls';

/** A request from Analytics (or a link): open the table on this filter, optionally only leads enrolled in a window. */
export interface LeadsLink { filter: LeadFilter; from?: string | null; to?: string | null; teammate?: string | null; nonce?: number }

const TAB_FILTERS = LEAD_FILTERS.filter((o) => o.tab);
/** "First N" selections fetch ids over the pages; beyond this the server-side "all matching" target is used. */
const FIRST_N_CAP = 10000;
const countOf = (c: LeadCounts | undefined, k: LeadFilter) => (c ? c[k] : undefined);
const fmtCount = (n: number | undefined) => (typeof n === 'number' ? n.toLocaleString() : '…');

function clockText(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso); const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const tomorrow = new Date(now); tomorrow.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return fmtDate(iso);
}

function ProgressCell({ r }: { r: SequenceLeadRow }) {
  const share = stepShare(r.step_index, r.step_total);
  const ended = isEnded(r.status);
  return (
    <div className="min-w-[120px]" title={r.step_label ? `${stepText(r)} · ${r.step_label}` : stepText(r)}>
      <div className="flex gap-0.5" aria-hidden>
        {Array.from({ length: Math.max(1, Math.min(r.step_total, 12)) }).map((_, i) => {
          const filled = r.step_total > 0 && (i + 1) / Math.min(r.step_total, 12) <= share + 1e-9;
          return <span key={i} className={cn('h-1.5 flex-1 rounded-sm', filled ? (ended ? 'bg-gray-400' : 'bg-indigo-500') : 'bg-gray-200')} />;
        })}
      </div>
      <div className="text-xs text-gray-600 mt-1 whitespace-nowrap">{stepText(r)}</div>
    </div>
  );
}

function NextCell({ r }: { r: SequenceLeadRow }) {
  if (!r.next) return <span className="text-gray-300">—</span>;
  const n = r.next;
  const when = n.at ? clockText(n.at) : '';
  return (
    <div className="text-xs min-w-0" title={`${n.label}${when ? ` · ${when}` : ''}`}>
      <div className="text-gray-900 truncate max-w-[180px]">{n.label}</div>
      {when && <div className="text-gray-500 whitespace-nowrap">{n.kind === 'wait' && n.type === 'wait_connection' ? `until ${when}` : when}</div>}
      {n.kind === 'action' && n.status === 'reserved' && <div className="text-indigo-600">Sending now</div>}
    </div>
  );
}

function SnippetCell({ s }: { s: SequenceLeadRow['last_message'] }) {
  if (!s?.text) return <span className="text-gray-300">—</span>;
  return (
    <div className="min-w-0 max-w-[220px]" title={`${s.text}${s.at ? ` · ${fmtDate(s.at)}` : ''}`}>
      <div className="text-xs text-gray-700 truncate">{s.text}</div>
      <div className="text-[11px] text-gray-400 whitespace-nowrap">{timeAgo(s.at)}</div>
    </div>
  );
}

const tabBtn = (active: boolean) => cn('px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors', active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50');

export default function SequenceLeads({ sequence, canWrite, link }: { sequence: Sequence; canWrite: boolean; link?: LeadsLink | null }) {
  const { workspace } = useWorkspace();
  const senders = useSenders(workspace?.id);
  const senderById = useMemo(() => new Map((senders.data ?? []).map((x) => [x.id, x])), [senders.data]);
  const qc = useQueryClient();
  const toast = useToast();
  const params = useSearchParams();

  // the filter, the teammate, the enrolled-in window, the search and the page: one query for the table and the counts.
  // A link from Analytics wins over the URL when the tab mounts with one; later links are applied below.
  const [filter, setFilterState] = useState<LeadFilter>(() => { if (link) return link.filter; const s = params.get('status'); return isLeadFilter(s) ? s : 'live'; });
  const [teammate, setTeammate] = useState<string | null>(() => (link ? link.teammate ?? null : params.get('teammate') || null));
  const [range, setRange] = useState<EnrolledRange>(() => {
    const f = link ? link.from : params.get('from'), t = link ? link.to : params.get('to');
    return isIsoDay(f) && isIsoDay(t) && f <= t ? { from: f, to: t } : null;
  });
  const [searchText, setSearchText] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [view, setView] = useState<'list' | 'failed'>('list');
  const [failedKind, setFailedKind] = useState<FailedKind>('failed');
  // selection: ids the user ticked (any page), or "everything matching this filter" (server-side target)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const selectRun = useRef(0);
  const clearSelection = useCallback(() => { setSelected(new Set()); setAllMatching(false); }, []);
  const [seenLink, setSeenLink] = useState<LeadsLink | null | undefined>(link);
  if (link !== seenLink) {   // a request from Analytics while mounted: apply it once (render-time state update, no effect needed)
    setSeenLink(link);
    if (link) { setFilterState(link.filter); setTeammate(link.teammate ?? null); setRange(link.from && link.to ? { from: link.from, to: link.to } : null); setPage(0); setView('list'); setSelected(new Set()); setAllMatching(false); }
  }
  useEffect(() => { const t = setTimeout(() => { setSearch(searchText.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [searchText]);
  const setFilter = (f: LeadFilter) => { setFilterState(f); if (f !== 'stopped_by_teammate') setTeammate(null); setPage(0); clearSelection(); };

  const query: LeadListQuery = useMemo(() => ({ filter, teammate: filter === 'stopped_by_teammate' ? teammate : null, from: range?.from ?? null, to: range?.to ?? null, search }), [filter, teammate, range, search]);
  const counts = useSequenceLeadCounts(sequence.id, range);
  const failedCount = useFailedCount(sequence.id);
  const pageQ = useSequenceLeads(sequence.id, query, page, view === 'list');
  const c = counts.data ?? EMPTY_COUNTS;
  const rows = useMemo(() => pageQ.data?.rows ?? [], [pageQ.data]);
  const total = pageQ.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / SEQUENCE_LEADS_PAGE));
  if (page > pageCount - 1 && pageQ.data) setPage(pageCount - 1);
  const from = total === 0 ? 0 : page * SEQUENCE_LEADS_PAGE + 1;
  const to = Math.min(total, (page + 1) * SEQUENCE_LEADS_PAGE);

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const allOnPage = rows.length > 0 && rows.every((r) => allMatching || selected.has(r.id));
  const someOnPage = rows.some((r) => allMatching || selected.has(r.id));
  const selectedCount = allMatching ? total : selected.size;
  const toggle = (id: string) => {
    if (allMatching) return;   // "all matching" is cleared from the bar or the menu, not row by row
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  // the header checkbox menu (Leads page): this page adds to the selection; "all" is the server-side filter target;
  // "first N" fetches the ids over the pages
  const select = useCallback(async (req: SelectionRequest) => {
    if (req.kind === 'none') { clearSelection(); return; }
    if (req.kind === 'page') { setAllMatching(false); setSelected((s) => { const n = new Set(s); rows.forEach((r) => n.add(r.id)); return n; }); return; }
    if (req.kind === 'all' || req.count >= total) { setSelected(new Set()); setAllMatching(true); return; }
    const run = ++selectRun.current;
    setSelecting(true);
    try {
      const ids = await fetchSequenceLeadIds(sequence.id, query, Math.min(req.count, FIRST_N_CAP));
      if (run !== selectRun.current) return;
      setAllMatching(false); setSelected(new Set(ids));
    } catch (e) { if (run === selectRun.current) toast.show(parseError(e).message, 'error'); }
    finally { if (run === selectRun.current) setSelecting(false); }
  }, [rows, total, sequence.id, query, clearSelection, toast]);
  const selectedRows = useMemo(() => [...selected].map((id) => rowById.get(id)).filter((r): r is SequenceLeadRow => !!r), [selected, rowById]);
  // an action is offered when at least one selected lead can take it; for "all matching" the filter decides
  const enabled: Record<BulkAction, boolean> = useMemo(() => {
    const opt = LEAD_FILTER_BY_KEY[filter];
    if (allMatching) {
      const st = opt.statuses;
      return {
        unenroll: !st || st.some((s) => !isEnded(s)),
        pause: !st || st.some((s) => ['active', 'waiting_connection', 'waiting_delay', 'waiting_task'].includes(s)),
        resume: !st || st.includes('paused'),
      };
    }
    // rows off the current page are unknown here: allow the action and let the server skip what it cannot touch
    const unknown = selected.size > selectedRows.length;
    return {
      unenroll: unknown || selectedRows.some((r) => bulkEligible('unenroll', r)),
      pause: unknown || selectedRows.some((r) => bulkEligible('pause', r)),
      resume: unknown || selectedRows.some((r) => bulkEligible('resume', r)),
    };
  }, [allMatching, filter, selected.size, selectedRows]);

  // the run: confirm → preview → bulk (chunked, with progress) → undo toast
  const [pending, setPending] = useState<{ action: BulkAction; target: BulkTarget; count: number } | null>(null);
  const [preview, setPreview] = useState<BulkPreview | null>(null);
  const [progress, setProgress] = useState<BulkProgress | null>(null);
  const [undo, setUndo] = useState<UndoState | null>(null);
  const [undoBusy, setUndoBusy] = useState(false);
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] });
    qc.invalidateQueries({ queryKey: ['outreach', 'reports'] });
    if (workspace) qc.invalidateQueries({ queryKey: ['outreach', workspace.id, 'sequence_summary'] });
  }, [qc, workspace]);

  const ask = async (action: BulkAction, target: BulkTarget, count: number) => {
    setPending({ action, target, count }); setPreview(null);
    try { setPreview(await previewBulk(sequence.id, action, target)); }
    catch (e) { setPending(null); toast.show(parseError(e).message, 'error'); }
  };
  const run = async () => {
    if (!pending) return;
    const { action, target, count } = pending;
    setPending(null); setPreview(null);
    if (count > SEQUENCE_LEADS_PAGE) setProgress({ action, done: 0, total: count });
    try {
      const r = await runBulk(sequence.id, action, target, count, (done, tot) => setProgress({ action, done, total: tot }));
      invalidate(); clearSelection();
      const noun = `${r.done.toLocaleString()} lead${r.done === 1 ? '' : 's'}`;
      if (action === 'unenroll') {
        if (r.done > 0) setUndo({ batchId: r.batch_id, count: r.done });
        else toast.show(r.skipped ? 'Nothing to unenroll: every selected lead had already ended' : 'Nothing to unenroll');
      } else {
        toast.show(`${noun} ${action === 'pause' ? 'paused' : 'resumed'}${r.skipped ? ` · ${r.skipped.toLocaleString()} skipped` : ''}`);
      }
    } catch (e) { toast.show(parseError(e).message, 'error'); invalidate(); }
    finally { setProgress(null); }
  };
  const doUndo = async () => {
    if (!undo) return;
    setUndoBusy(true);
    try {
      const r = await undoBulk(undo.batchId);
      setUndo(null); invalidate();
      toast.show(r.restored > 0 ? `${r.restored.toLocaleString()} lead${r.restored === 1 ? '' : 's'} put back${r.skipped ? ` · ${r.skipped.toLocaleString()} could not be (enrolled again in the meantime)` : ''}` : 'Nothing to put back');
    } catch (e) { toast.show(parseError(e).message, 'error'); }
    finally { setUndoBusy(false); }
  };
  const expireUndo = useCallback(() => setUndo(null), []);

  const rowAction = (r: SequenceLeadRow, action: BulkAction) => ask(action, { ids: [r.id] }, 1);
  const barAction = (action: BulkAction) => ask(action, allMatching ? { query } : { ids: [...selected] }, selectedCount);

  const showStoppedBy = STOPPED_BY_FILTERS.includes(filter);
  const showReply = filter === 'handoff' || filter === 'all';
  const opt = LEAD_FILTER_BY_KEY[filter];

  return (
    <Card title={view === 'failed' ? 'Failed and skipped leads' : <span>Enrolled leads <span className="text-gray-400 font-normal tabular-nums">({fmtCount(countOf(counts.data, 'all'))})</span></span>} actions={
      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs" role="radiogroup" aria-label="Which view to show">
        <button type="button" role="radio" aria-checked={view === 'list'} onClick={() => setView('list')} className={cn('px-3 py-1 rounded-md', view === 'list' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>Leads</button>
        <button type="button" role="radio" aria-checked={view === 'failed'} onClick={() => setView('failed')} title="Why each lead failed or was skipped, with retry, skip and exit" className={cn('px-3 py-1 rounded-md', view === 'failed' ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>Failed &amp; skipped{failedCount.data ? <span className="tabular-nums"> ({failedCount.data.toLocaleString()})</span> : null}</button>
      </div>
    }>
      {view === 'failed' ? (
        <FailedLeadsPanel sequenceId={sequence.id} kind={failedKind} onKindChange={setFailedKind} graph={sequence.graph} canWrite={canWrite} />
      ) : (
        <div className="space-y-3">
          {/* one row: the five tabs, the full dropdown, the teammate sub-filter, the window chip, the search */}
          <div className="flex items-center gap-2 min-w-0">
            <div className="inline-flex shrink-0 max-w-full overflow-x-auto [scrollbar-width:none] rounded-lg border border-gray-200 bg-white p-0.5" role="radiogroup" aria-label="Lead status">
              {TAB_FILTERS.map((o) => (
                <button key={o.key} type="button" role="radio" aria-checked={filter === o.key} title={o.help} onClick={() => setFilter(o.key)} className={tabBtn(filter === o.key)}>
                  {o.label} <span className={cn('ml-0.5 tabular-nums', filter === o.key ? 'text-indigo-400' : 'text-gray-400')}>{fmtCount(countOf(counts.data, o.key))}</span>
                </button>
              ))}
            </div>
            <Select value={filter} onChange={(e) => setFilter(e.target.value as LeadFilter)} aria-label="Lead status (all options)" title={opt.help} className="!py-1 !text-xs w-auto shrink-0">
              {LEAD_FILTERS.filter((o) => o.group === 'top').map((o) => <option key={o.key} value={o.key}>{o.label} ({fmtCount(countOf(counts.data, o.key))})</option>)}
              {(['progress', 'ended'] as const).map((g) => (
                <optgroup key={g} label={LEAD_FILTER_GROUP_LABEL[g]}>
                  {LEAD_FILTERS.filter((o) => o.group === g).map((o) => <option key={o.key} value={o.key}>{o.label} ({fmtCount(countOf(counts.data, o.key))})</option>)}
                </optgroup>
              ))}
            </Select>
            {filter === 'stopped_by_teammate' && (
              <Select value={teammate ?? ''} onChange={(e) => { setTeammate(e.target.value || null); setPage(0); clearSelection(); }} aria-label="Teammate" className="!py-1 !text-xs w-auto shrink-0">
                <option value="">Teammate: Anyone ({fmtCount(c.stopped_by_teammate)})</option>
                {c.teammates.map((t) => <option key={t.user_id} value={t.user_id}>{t.name} ({t.count.toLocaleString()})</option>)}
              </Select>
            )}
            {range && (
              <span className="inline-flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700 text-xs" title="Only leads enrolled in this window (from Analytics)">
                Enrolled {fmtCohortRange(range)}
                <button type="button" aria-label="Show every lead, whenever enrolled" onClick={() => { setRange(null); setPage(0); clearSelection(); }} className="rounded-full hover:bg-indigo-100 p-0.5"><X className="w-3 h-3" /></button>
              </span>
            )}
            <label className="relative ml-auto w-40 shrink-0">
              <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
              <input type="search" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="Search" aria-label="Search leads in this sequence" className="w-full pl-8 pr-2 py-1 text-xs rounded-lg border border-gray-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            </label>
          </div>
          {filter === 'stopped_by_teammate' && !teammate && c.stopped_by_system > 0 && (
            <p className="text-xs text-gray-500">{c.stopped_by_system.toLocaleString()} of these were stopped before teammates were recorded, or through the API.</p>
          )}
          {filter === 'failed' && total > 0 && (
            <p className="text-xs text-gray-600 inline-flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5 text-red-500" /> To see why each lead failed and retry, skip or exit them, open <button type="button" className="underline underline-offset-2 text-indigo-700" onClick={() => setView('failed')}>Failed &amp; skipped</button>.</p>
          )}

          {canWrite && <BulkBar count={selectedCount} enabled={enabled} progress={progress} onAction={barAction} onClear={clearSelection} />}

          {pageQ.isLoading && !pageQ.data ? <Spinner /> : pageQ.error ? <ErrorBox message={parseError(pageQ.error).message} /> : rows.length === 0 ? (
            <EmptyState title={filter === 'live' && !search && !range ? 'No leads enrolled right now' : 'No leads here'}
              description={filter === 'live' && !search && !range ? (canWrite ? 'No enrolled leads are live in this sequence. Choose leads above to enrol them.' : 'No enrolled leads are live in this sequence.') : `Nothing matches ${search ? 'this search' : 'this filter'}.`} />
          ) : (
            <div className={cn(pageQ.isPlaceholderData || pageQ.isFetching ? 'opacity-70 transition-opacity' : 'transition-opacity')}>
              <Table className="border-0">
                <thead>
                  <tr>
                    {canWrite && <Th className="w-8"><SelectionMenu pageRows={rows.length} total={total} selectedCount={selectedCount} allOnPage={allOnPage} someOnPage={someOnPage} busy={selecting} onSelect={select} /></Th>}
                    <Th>Lead</Th><Th>Sender</Th><Th>Status</Th>
                    <Th><InfoTip text="How far the lead has got through the sending steps of this sequence.">Sequence progress</InfoTip></Th>
                    <Th><InfoTip text="The next action and when it runs. Blank once the lead has ended.">Next step</InfoTip></Th>
                    <Th><InfoTip text="The last message sent to this lead on this sender.">Last message</InfoTip></Th>
                    {showReply && <Th><InfoTip text="The last thing the lead wrote back.">Reply</InfoTip></Th>}
                    {showStoppedBy && <Th><InfoTip text="The teammate who stopped or unenrolled the lead.">Stopped by</InfoTip></Th>}
                    <Th>Entered</Th>
                    {canWrite && <Th className="text-right">Actions</Th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const lead = r.lead; const isSel = allMatching || selected.has(r.id); const live = !isEnded(r.status);
                    return (
                      <tr key={r.id} className={cn(isSel && 'bg-indigo-50/40')}>
                        {canWrite && <Td><input type="checkbox" aria-label={`Select ${lead?.full_name ?? 'lead'}`} checked={isSel} disabled={allMatching} onChange={() => toggle(r.id)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" /></Td>}
                        <Td>
                          {(() => {
                            // Same cell as Failed & skipped: the name opens the LinkedIn profile in a new tab, "Lead page" opens the lead.
                            const url = lead?.public_identifier ? `https://www.linkedin.com/in/${lead.public_identifier}` : null;
                            const name = lead?.full_name || lead?.public_identifier || 'Lead';
                            return (
                              <div className="flex items-center gap-2 min-w-0">
                                <Avatar src={lead?.picture_url} name={name} size={8} />
                                <span className="min-w-0">
                                  {url
                                    ? <a href={url} target="_blank" rel="noopener noreferrer" title="Open the LinkedIn profile in a new tab" className="font-medium text-gray-900 hover:text-indigo-700 inline-flex items-center gap-1 max-w-[200px]"><span className="truncate">{name}</span><ExternalLink className="w-3 h-3 text-gray-400 flex-shrink-0" aria-hidden /></a>
                                    : <Link href={`/outreach/leads/${r.lead_id}`} className="font-medium text-gray-900 hover:text-indigo-700 block truncate max-w-[200px]">{name}</Link>}
                                  <span className="block text-xs text-gray-500 truncate max-w-[200px]">{lead?.company}{lead?.company && url ? ' · ' : ''}{url && <Link href={`/outreach/leads/${r.lead_id}`} className="hover:text-indigo-700">Lead page</Link>}</span>
                                </span>
                              </div>
                            );
                          })()}
                        </Td>
                        <Td className="text-gray-600 whitespace-nowrap">{r.sender?.display_name ? <span className="inline-flex items-center gap-2"><Avatar src={senderById.get(r.sender_id)?.picture_url} name={r.sender.display_name} size={6} />{r.sender.display_name}</span> : '—'}</Td>
                        <Td>
                          <EnrollmentBadge status={r.status} />
                          {r.exit_reason && r.status !== 'cancelled' && r.exit_reason !== 'replied' && <span className="block text-[11px] text-gray-400 mt-0.5 max-w-[180px] truncate" title={exitReasonText(r.exit_reason) ?? undefined}>{exitReasonText(r.exit_reason)}</span>}
                          {r.status === 'paused' && r.held_at && <span className="block text-[11px] text-gray-400 mt-0.5">Held for review</span>}
                        </Td>
                        <Td><ProgressCell r={r} /></Td>
                        <Td><NextCell r={r} /></Td>
                        <Td><SnippetCell s={r.last_message} /></Td>
                        {showReply && <Td><SnippetCell s={r.last_reply} /></Td>}
                        {showStoppedBy && <Td className="text-gray-700 whitespace-nowrap text-xs">{(r.status === 'exited_manual' || r.status === 'cancelled') ? (r.changed_by ? <span title={r.changed_at ? fmtDate(r.changed_at) : undefined}>{r.changed_by.name}</span> : <span className="text-gray-400">System</span>) : <span className="text-gray-300">—</span>}</Td>}
                        <Td className="text-gray-500 whitespace-nowrap" title={fmtDate(r.created_at)}>{timeAgo(r.created_at)}</Td>
                        {canWrite && (
                          <Td>
                            {live && (
                              <div className="flex items-center justify-end gap-1">
                                {r.status === 'paused'
                                  ? <Button variant="ghost" size="sm" title={r.held_at ? 'Held after a reply: resume it from the inbox' : 'Resume'} disabled={!!r.held_at} onClick={() => rowAction(r, 'resume')}><Play className="w-3.5 h-3.5" /></Button>
                                  : <Button variant="ghost" size="sm" title="Pause" onClick={() => rowAction(r, 'pause')}><Pause className="w-3.5 h-3.5" /></Button>}
                                <Button variant="ghost" size="sm" title={`${BULK_ACTION_LABEL.unenroll}: take the lead out of this sequence`} className="text-red-600" onClick={() => rowAction(r, 'unenroll')}><LogOut className="w-3.5 h-3.5" /></Button>
                              </div>
                            )}
                          </Td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
              {/* the Leads page footer: the range, the selection, the pager */}
              <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-sm text-gray-600">
                <span>Showing <span className="font-medium text-gray-900 tabular-nums">{from.toLocaleString()}–{to.toLocaleString()}</span> of <span className="font-medium text-gray-900 tabular-nums">{total.toLocaleString()}</span>{selectedCount > 0 && <> · {selectedCount.toLocaleString()} selected</>}</span>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="w-4 h-4" /> Prev</Button>
                  <span className="px-2">Page <span className="tabular-nums">{page + 1} / {pageCount}</span></span>
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next <ChevronRight className="w-4 h-4" /></Button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmBulkModal action={pending?.action ?? null} count={pending?.count ?? 0} sequenceName={sequence.name} preview={preview} loading={false} onConfirm={run} onClose={() => { setPending(null); setPreview(null); }} />
      <UndoToast key={undo?.batchId ?? 'none'} state={undo} busy={undoBusy} onUndo={doUndo} onExpire={expireUndo} />
      {toast.node}
    </Card>
  );
}
