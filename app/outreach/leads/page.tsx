'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useLists, useStages, useTags } from '@/lib/outreach/queries';
import { useLeadsIntel } from '@/lib/outreach/intel';
import { callFn, parseError } from '@/lib/outreach/api';
import { cn } from '@/lib/utils';
import { Button, EmptyState, ErrorBox, PageHeader, PageLoader, Spinner, useToast } from '@/components/outreach/ui';
import { LeadFilterBar, EMPTY_FILTERS, isFilterEmpty, usePersistedLeadFilters } from '@/components/outreach/leads/LeadFilterBar';
import { LeadsTable } from '@/components/outreach/leads/LeadsTable';
import { BulkActionsBar } from '@/components/outreach/leads/BulkActionsBar';
import { EnrollModal } from '@/components/outreach/leads/EnrollModal';
import { CreateLeadModal } from '@/components/outreach/leads/CreateLeadModal';
import { TAXONOMY, TaxonomyPanel, type TaxonomyKind } from '@/components/outreach/leads/TaxonomyPanel';
import { ChevronLeft, ChevronRight, Download, Plus, Upload, Users } from 'lucide-react';

const PAGE_SIZE = 50;
const TAXONOMY_TABS: TaxonomyKind[] = ['lists', 'stages', 'tags'];
type Tab = 'leads' | TaxonomyKind;
const FILTER_KEY: Record<TaxonomyKind, 'list_id' | 'stage_id' | 'tag_id'> = { lists: 'list_id', stages: 'stage_id', tags: 'tag_id' };

function LeadsPage() {
  const { workspace, canWrite, isManager } = useWorkspace();
  const ws = workspace?.id;
  const toast = useToast();
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();

  // The active tab lives in the URL so "Leads › Lists" can be linked to and survives a refresh.
  const rawTab = params.get('tab');
  const tab: Tab = TAXONOMY_TABS.includes(rawTab as TaxonomyKind) ? (rawTab as TaxonomyKind) : 'leads';
  const setTab = useCallback((t: Tab) => {
    const next = new URLSearchParams(params.toString());
    if (t === 'leads') next.delete('tab'); else next.set('tab', t);
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [params, pathname, router]);

  // Filters (not the search) are remembered per workspace in this browser and restored when the page opens again.
  const { filters, setFilters, ready } = usePersistedLeadFilters(ws);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Same list as before plus the item-13 filters (replied, enriched, posts, followers, time in role, past company, skill, language).
  const leads = useLeadsIntel(ready && tab === 'leads' ? ws : undefined, { ...filters, page, pageSize: PAGE_SIZE });
  const clients = useClients(ws);
  const lists = useLists(ws);
  const stages = useStages(ws);
  const tags = useTags(ws);

  // Reset paging + selection when filters or workspace change
  useEffect(() => { setPage(0); setSelected(new Set()); }, [filters, ws]);

  const rows = leads.data?.rows ?? [];
  const total = leads.data?.count ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);

  const toggle = useCallback((id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }), []);
  const toggleAll = useCallback(() => setSelected((s) => {
    const n = new Set(s);
    const all = rows.length > 0 && rows.every((r) => n.has(r.id));
    if (all) rows.forEach((r) => n.delete(r.id)); else rows.forEach((r) => n.add(r.id));
    return n;
  }), [rows]);
  const selectedIds = useMemo(() => Array.from(selected), [selected]);

  /** From a list / stage / tag row: jump back to the lead table filtered on just that row. */
  const viewLeadsIn = (kind: TaxonomyKind, id: string) => {
    setFilters({ ...EMPTY_FILTERS, [FILTER_KEY[kind]]: id });
    setTab('leads');
  };

  const exportCsv = async () => {
    if (!ws) return;
    setExporting(true);
    try {
      const res = await callFn<{ url: string }>('exports-create', { workspace_id: ws, kind: 'leads', client_id: filters.client_id ?? null });
      if (res?.url) { window.open(res.url, '_blank', 'noopener'); toast.show('Export ready — opened in a new tab'); }
      else toast.show('Export created but no download URL was returned', 'error');
    } catch (e) {
      toast.show(parseError(e).message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const subtitle = tab !== 'leads'
    ? `Organise leads with ${tab}. Changes apply everywhere ${tab} are shown.`
    : leads.data ? `${total.toLocaleString()} lead${total === 1 ? '' : 's'}${isFilterEmpty(filters) ? '' : ` match${total === 1 ? 'es' : ''} the current filters`}` : 'Everyone you are reaching out to, across senders and sequences.';

  return (
    <div>
      <PageHeader title="Leads" subtitle={subtitle}
        actions={tab === 'leads' ? <>
          {isManager && <Button variant="secondary" onClick={exportCsv} loading={exporting} title={filters.client_id ? 'Export leads of the selected client' : 'Export all leads'}><Download className="w-4 h-4" /> Export CSV</Button>}
          {canWrite && <Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link>}
          {canWrite && <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button>}
        </> : undefined} />

      <div role="tablist" aria-label="Leads section" className="flex flex-wrap gap-1 border-b border-gray-200 mb-4">
        {(['leads', ...TAXONOMY_TABS] as Tab[]).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cn('px-3.5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors', tab === t ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            {t === 'leads' ? 'All leads' : TAXONOMY[t].label}
          </button>
        ))}
      </div>

      {tab !== 'leads' ? (
        <div role="tabpanel"><TaxonomyPanel key={tab} kind={tab} toast={toast.show} onViewLeads={(id) => viewLeadsIn(tab, id)} /></div>
      ) : (
        <div role="tabpanel" className="space-y-3">
          <LeadFilterBar filters={filters} onChange={setFilters} clients={clients.data} lists={lists.data} stages={stages.data} tags={tags.data} ws={ws} toast={toast.show} />

          {canWrite && <BulkActionsBar selected={selectedIds} onClear={() => setSelected(new Set())} onEnroll={() => setEnrollOpen(true)} toast={toast.show} />}

          {!ready || leads.isLoading ? <Spinner className="min-h-[50vh]" /> : leads.error ? <ErrorBox message={parseError(leads.error).message} /> : rows.length === 0 ? (
            <div className="bg-white border border-gray-200 rounded-xl">
              {isFilterEmpty(filters) ? (
                <EmptyState icon={<Users className="w-6 h-6" />} title="No leads yet" description="Import a LinkedIn search, upload a CSV, or add leads one by one."
                  action={canWrite ? <div className="flex gap-2"><Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link><Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button></div> : undefined} />
              ) : (
                <EmptyState title="No leads match" description="Try a different search or clear the filters." action={<Button variant="secondary" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button>} />
              )}
            </div>
          ) : (
            <>
              <div className={leads.isFetching ? 'opacity-60 transition-opacity' : 'transition-opacity'}>
                <LeadsTable rows={rows} selected={selected} onToggle={toggle} onToggleAll={toggleAll} clients={clients.data} lists={lists.data} stages={stages.data} tags={tags.data} selectable={canWrite} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-gray-600">
                <span>Showing <span className="font-medium text-gray-900">{from.toLocaleString()}–{to.toLocaleString()}</span> of <span className="font-medium text-gray-900">{total.toLocaleString()}</span>{selected.size > 0 && <> · {selected.size.toLocaleString()} selected</>}</span>
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

      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} toast={toast.show} />
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} leadIds={selectedIds} toast={toast.show} />
      {toast.node}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<PageLoader />}><LeadsPage /></Suspense>;
}
