'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from '@/lib/outreach/nav';
import { usePathname, useRouter, useSearchParams } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useLists, useSenders, useStages, useTags } from '@/lib/outreach/queries';
import { fetchFilteredLeadIds, useLeadCustomKeys, useLeadsIntel } from '@/lib/outreach/intel';
import { isLayoutEmpty, useTableLayout } from '@/lib/outreach/tableLayout';
import { parseError } from '@/lib/outreach/api';
import { cn } from '@/lib/utils';
import { Button, EmptyState, ErrorBox, PageHeader, PageLoader, Spinner, useToast } from '@/components/outreach/ui';
import { LeadFilterBar, EMPTY_FILTERS, isFilterEmpty, usePersistedLeadFilters, type ViewFilters } from '@/components/outreach/leads/LeadFilterBar';
import { LeadsTable } from '@/components/outreach/leads/LeadsTable';
import { BULK_CAP } from '@/components/outreach/leads/helpers';
import type { SelectionRequest } from '@/components/outreach/leads/SelectionMenu';
import { BulkActionsBar } from '@/components/outreach/leads/BulkActionsBar';
import { EnrollModal } from '@/components/outreach/leads/EnrollModal';
import { CreateLeadModal } from '@/components/outreach/leads/CreateLeadModal';
import { TAXONOMY, TaxonomyPanel, type TaxonomyKind } from '@/components/outreach/leads/TaxonomyPanel';
import { ByAccountPanel, TotalsLine } from '@/components/outreach/leads/relationships';
import { LEAD_TABS, type LeadTab } from '@/lib/outreach/leadsRelationships';
import { ChevronDown, ChevronLeft, ChevronRight, EyeOff, Inbox, Layers, List, Plus, Settings2, Tag as TagIcon, Upload, Users } from 'lucide-react';

const PAGE_SIZE = 50;
const TAXONOMY_TABS: TaxonomyKind[] = ['lists', 'stages', 'tags'];
const LEAD_TAB_KEYS: LeadTab[] = ['prospects', 'inbox', 'all'];
/** 094 §5.1: three lead tabs (Outbound · Inbound · All); lists / stages / tags open from the Manage menu. */
type Tab = LeadTab | TaxonomyKind;
const FILTER_KEY: Record<TaxonomyKind, 'list_id' | 'stage_id' | 'tag_id'> = { lists: 'list_id', stages: 'stage_id', tags: 'tag_id' };

const MANAGE_ICON: Record<TaxonomyKind, typeof List> = { lists: List, stages: Layers, tags: TagIcon };
const MENU_ITEM = 'w-full text-left flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-gray-700';

/** Manage ▾ in the header: opens the lists, stages or tags setup (they used to be tabs next to the lead tabs). */
function ManageMenu({ current, onPick }: { current: TaxonomyKind | null; onPick: (t: TaxonomyKind) => void }) {
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

  return (
    <div ref={rootRef} className="relative inline-block">
      <Button variant="secondary" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Set up lists, stages and tags"><Settings2 className="w-4 h-4" /> Manage <ChevronDown className="w-4 h-4 -mr-1" /></Button>
      {open && (
        <div role="menu" className="absolute right-0 mt-1 z-40 w-44 bg-white border border-gray-200 rounded-lg shadow-lg py-1 text-sm">
          {TAXONOMY_TABS.map((t) => {
            const Icon = MANAGE_ICON[t];
            return (
              <button key={t} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(t); }} className={cn(MENU_ITEM, current === t && 'text-indigo-700 font-medium')}>
                <Icon className="w-4 h-4 flex-shrink-0" /> {TAXONOMY[t].label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LeadsPage() {
  const { workspace, canWrite } = useWorkspace();
  const ws = workspace?.id;
  const toast = useToast();
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();

  // The active tab lives in the URL so "Leads › Lists" or "Leads › From inbox" can be linked to and survives a refresh.
  const rawTab = params.get('tab');
  const tab: Tab = TAXONOMY_TABS.includes(rawTab as TaxonomyKind) ? (rawTab as TaxonomyKind) : LEAD_TAB_KEYS.includes(rawTab as LeadTab) ? (rawTab as LeadTab) : 'prospects';
  const isLeadTab = LEAD_TAB_KEYS.includes(tab as LeadTab);
  const leadTab: LeadTab = isLeadTab ? (tab as LeadTab) : 'prospects';
  const setTab = useCallback((t: Tab) => {
    const next = new URLSearchParams(params.toString());
    if (t === 'prospects') next.delete('tab'); else next.set('tab', t);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  // Filters (not the search) are remembered per workspace in this browser and restored when the page opens again.
  const { filters, setFilters, ready } = usePersistedLeadFilters(ws);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selecting, setSelecting] = useState(false);
  const selectRun = useRef(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [byAccountOpen, setByAccountOpen] = useState(false);

  // Same list as before plus the item-13 filters and the 094 relationship filters; the tab travels with the filters.
  const listFilters = useMemo(() => ({ ...filters, tab: leadTab }), [filters, leadTab]);
  const leads = useLeadsIntel(ready && isLeadTab ? ws : undefined, { ...listFilters, page, pageSize: PAGE_SIZE });
  const clients = useClients(ws);
  const lists = useLists(ws);
  const stages = useStages(ws);
  const tags = useTags(ws);
  const senders = useSenders(ws);
  const customKeys = useLeadCustomKeys(isLeadTab ? ws : undefined);
  const hiddenView = !!filters.hidden;
  /** The totals line and the By account panel apply the clicked number as a filter (094 §5.4, §5.5). */
  const pickFilter = useCallback((patch: Record<string, unknown>) => setFilters((f) => ({ ...f, ...(patch as Partial<ViewFilters>) })), [setFilters]);
  // Column order and widths, saved per person and workspace every time a header is dragged.
  const columns = useTableLayout(ws, 'leads');

  // Reset paging + selection when filters or workspace change
  useEffect(() => { setPage(0); setSelected(new Set()); selectRun.current++; setSelecting(false); }, [filters, ws, leadTab]);

  const rows = leads.data?.rows ?? [];
  const total = leads.data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  // The header checkbox: this page is added to the selection; "all" and "the first N" replace it with leads from every page of the
  // current filters, whose ids are fetched (only one page of rows is loaded). A bulk action takes at most BULK_CAP leads.
  const select = useCallback(async (req: SelectionRequest) => {
    if (req.kind === 'none') { setSelected(new Set()); return; }
    if (req.kind === 'page') { setSelected((s) => { const n = new Set(s); rows.forEach((r) => n.add(r.id)); return n; }); return; }
    if (!ws) return;
    const asked = req.kind === 'all' ? total : Math.min(req.count, total);
    const run = ++selectRun.current;
    setSelecting(true);
    try {
      const ids = await fetchFilteredLeadIds(ws, listFilters, Math.min(asked, BULK_CAP));
      if (run !== selectRun.current) return;   // the filters changed while the ids were on their way
      setSelected(new Set(ids));
      if (asked > BULK_CAP) toast.show(`Selected the first ${BULK_CAP.toLocaleString()} leads. A bulk action takes at most ${BULK_CAP.toLocaleString()} at a time.`);
    } catch (e) {
      if (run === selectRun.current) toast.show(parseError(e).message, 'error');
    } finally {
      if (run === selectRun.current) setSelecting(false);
    }
  }, [rows, ws, total, listFilters, toast]);
  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  /** From a list / stage / tag row: jump back to the lead table filtered on just that row. */
  const viewLeadsIn = (kind: TaxonomyKind, id: string) => {
    setFilters({ ...EMPTY_FILTERS, [FILTER_KEY[kind]]: id });
    setTab('all');
  };

  const tabMeta = LEAD_TABS.find((t) => t.key === leadTab)!;
  const subtitle = !isLeadTab
    ? `Organise leads with ${tab}. Changes apply everywhere ${tab} are shown.`
    : hiddenView ? 'Hidden leads: automated senders, company pages and leads hidden by hand. They are kept, not deleted.'
    : leads.data ? `${total.toLocaleString()} ${leadTab === 'inbox' ? (total === 1 ? 'inbound lead' : 'inbound leads') : leadTab === 'all' ? (total === 1 ? 'person' : 'people') : (total === 1 ? 'outbound lead' : 'outbound leads')}${isFilterEmpty(filters) ? '' : ` match${total === 1 ? 'es' : ''} the current filters`}` : tabMeta.help;

  return (
    <div>
      <PageHeader title="Leads" subtitle={subtitle}
        actions={<>
          {isLeadTab && <>
            <Button variant="secondary" onClick={() => setByAccountOpen(true)} title="How many of the leads in this view are connected, pending, contacted and replied through each account"><Users className="w-4 h-4" /> By account</Button>
            {canWrite && <Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link>}
          </>}
          <ManageMenu current={isLeadTab ? null : (tab as TaxonomyKind)} onPick={setTab} />
          {isLeadTab && canWrite && <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button>}
        </>} />

      {/* Lists / stages / tags are setup, opened from Manage; while one is open it shows as the selected tab after the lead tabs */}
      <div role="tablist" aria-label="Leads section" className="flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] shadow-[inset_0_-1px_0_theme(colors.gray.200)] mb-4">
        {([...LEAD_TAB_KEYS, ...(isLeadTab ? [] : [tab])] as Tab[]).map((t, i) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)} title={LEAD_TABS.find((x) => x.key === t)?.help}
            className={cn('px-3.5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors', i === LEAD_TAB_KEYS.length && 'ml-3 pl-5 border-l border-l-gray-200', tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            {LEAD_TAB_KEYS.includes(t as LeadTab) ? LEAD_TABS.find((x) => x.key === t)!.label : TAXONOMY[t as TaxonomyKind].label}
          </button>
        ))}
      </div>

      {!isLeadTab ? (
        <div role="tabpanel"><TaxonomyPanel key={tab} kind={tab as TaxonomyKind} toast={toast.show} onViewLeads={(id) => viewLeadsIn(tab as TaxonomyKind, id)} /></div>
      ) : (
        <div role="tabpanel" className="space-y-3">
          <LeadFilterBar filters={filters} onChange={setFilters} clients={clients.data} lists={lists.data} stages={stages.data} tags={tags.data} senders={senders.data} ws={ws} toast={toast.show} />

          {/* 094 §5.4: the totals line follows the tab and the filters; each number applies the matching filter */}
          {ready && !hiddenView && <TotalsLine ws={ws} tab={leadTab} filters={filters as Record<string, unknown>} includeRemoved={!!filters.include_removed} onPick={pickFilter} />}
          {hiddenView && <p className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 inline-flex items-center gap-2"><EyeOff className="w-3.5 h-3.5" /> Showing hidden leads only. Unhide or Add to outbound brings one back; Delete removes it for good.</p>}

          {canWrite && <BulkActionsBar selected={selectedIds} onClear={() => setSelected(new Set())} onEnroll={() => setEnrollOpen(true)} toast={toast.show} hiddenView={hiddenView} tab={leadTab} />}

          {!ready || leads.isLoading ? <Spinner className="min-h-[50vh]" /> : leads.error ? <ErrorBox message={parseError(leads.error).message} /> : rows.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl">
              {isFilterEmpty(filters) && leadTab === 'prospects' ? (
                <EmptyState icon={<Users className="w-6 h-6" />} title="No outbound leads yet" description="Import a LinkedIn search, upload a CSV, or add leads one by one. People who write to you first wait under Inbound."
                  action={canWrite ? <div className="flex gap-2"><Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link><Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button></div> : undefined} />
              ) : isFilterEmpty(filters) && leadTab === 'inbox' ? (
                <EmptyState icon={<Inbox className="w-6 h-6" />} title="Nobody is waiting here" description="People who message one of your accounts and haven't been added to outreach yet appear here. Enrol them, add them to a list or stage, or use Add to outbound to move them." />
              ) : isFilterEmpty(filters) ? (
                <EmptyState icon={<Users className="w-6 h-6" />} title="No leads yet" description="Import a LinkedIn search, upload a CSV, or add leads one by one."
                  action={canWrite ? <div className="flex gap-2"><Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link><Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button></div> : undefined} />
              ) : (
                <EmptyState title={hiddenView ? 'No hidden leads' : 'No leads match'} description={hiddenView ? 'Nothing is hidden under these filters.' : 'Try a different search or clear the filters.'} action={<Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>} />
              )}
            </div>
          ) : (
            <>
              <div className={leads.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'} data-tour="leads-table">
                <LeadsTable rows={rows} total={total} selected={selected} onToggle={toggle} onSelect={select} selecting={selecting} clients={clients.data} lists={lists.data} stages={stages.data} tags={tags.data} selectable={canWrite}
                  customKeys={customKeys.data} layout={columns.layout} onLayoutChange={columns.setLayout} senders={senders.data} includeRemoved={!!filters.include_removed} toast={toast.show} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
                <span>Showing <span className="font-medium text-gray-900">{from.toLocaleString()}–{to.toLocaleString()}</span> of <span className="font-medium text-gray-900">{total.toLocaleString()}</span>{selected.size > 0 && <> · {selected.size.toLocaleString()} selected</>}
                  {!isLayoutEmpty(columns.layout) && <> · <button type="button" onClick={columns.reset} className="text-indigo-600 hover:text-indigo-800 hover:underline" title="Back to the default column order and widths">Reset columns</button></>}</span>
                <div className="flex items-center gap-1">
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}><ChevronLeft className="w-4 h-4" /> Prev</Button>
                  <span className="px-2 tabular-nums">Page {page + 1} / {pageCount}</span>
                  <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))} disabled={page >= pageCount - 1}>Next <ChevronRight className="w-4 h-4" /></Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      <ByAccountPanel open={byAccountOpen} onClose={() => setByAccountOpen(false)} ws={ws} tab={leadTab} filters={filters as Record<string, unknown>}
        includeRemoved={!!filters.include_removed} onIncludeRemoved={(v) => setFilters((f) => ({ ...f, include_removed: v ? true : null }))}
        onPick={(patch) => { pickFilter(patch); setByAccountOpen(false); }} />
      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} toast={toast.show} />
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} leadIds={selectedIds} toast={toast.show} />
      {toast.node}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><LeadsPage /></Suspense>;
}
