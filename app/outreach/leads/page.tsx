'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useLists, useStages, useTags } from '@/lib/outreach/queries';
import { useLeadsIntel } from '@/lib/outreach/intel';
import { callFn, parseError } from '@/lib/outreach/api';
import { Button, EmptyState, ErrorBox, PageHeader, Spinner, useToast } from '@/components/outreach/ui';
import { LeadFilterBar, EMPTY_FILTERS, isFilterEmpty, type ViewFilters } from '@/components/outreach/leads/LeadFilterBar';
import { LeadsTable } from '@/components/outreach/leads/LeadsTable';
import { BulkActionsBar } from '@/components/outreach/leads/BulkActionsBar';
import { EnrollModal } from '@/components/outreach/leads/EnrollModal';
import { CreateLeadModal } from '@/components/outreach/leads/CreateLeadModal';
import { ManageTaxonomyModal, type TaxonomyKind } from '@/components/outreach/leads/ManageTaxonomy';
import { ChevronLeft, ChevronRight, Download, Plus, Upload, Users } from 'lucide-react';

const PAGE_SIZE = 50;

export default function LeadsPage() {
  const { workspace, canWrite, isManager } = useWorkspace();
  const ws = workspace?.id;
  const toast = useToast();
  const [filters, setFilters] = useState<ViewFilters>(EMPTY_FILTERS);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [createOpen, setCreateOpen] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [manage, setManage] = useState<TaxonomyKind | null>(null);
  const [exporting, setExporting] = useState(false);

  // Same list as before plus the item-13 filters (replied, enriched, posts, followers, time in role, past company, skill, language).
  const leads = useLeadsIntel(ws, { ...filters, page, pageSize: PAGE_SIZE });
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

  return (
    <div>
      <PageHeader title="Leads" subtitle={leads.data ? `${total.toLocaleString()} lead${total === 1 ? '' : 's'}${isFilterEmpty(filters) ? '' : ' match the current filters'}` : 'Everyone you are reaching out to, across senders and sequences.'}
        actions={<>
          {isManager && <Button variant="secondary" onClick={exportCsv} loading={exporting} title={filters.client_id ? 'Export leads of the selected client' : 'Export all leads'}><Download className="w-4 h-4" /> Export CSV</Button>}
          {canWrite && <Link href="/outreach/leads/import"><Button variant="secondary"><Upload className="w-4 h-4" /> Import</Button></Link>}
          {canWrite && <Button onClick={() => setCreateOpen(true)}><Plus className="w-4 h-4" /> New lead</Button>}
        </>} />

      <div className="space-y-3">
        <LeadFilterBar filters={filters} onChange={setFilters} clients={clients.data} lists={lists.data} stages={stages.data} tags={tags.data} ws={ws} canWrite={canWrite} onManage={setManage} toast={toast.show} />

        {canWrite && <BulkActionsBar selected={selectedIds} onClear={() => setSelected(new Set())} onEnroll={() => setEnrollOpen(true)} toast={toast.show} />}

        {leads.isLoading ? <Spinner className="min-h-[50vh]" /> : leads.error ? <ErrorBox message={parseError(leads.error).message} /> : rows.length === 0 ? (
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

      <CreateLeadModal open={createOpen} onClose={() => setCreateOpen(false)} toast={toast.show} />
      <EnrollModal open={enrollOpen} onClose={() => setEnrollOpen(false)} leadIds={selectedIds} toast={toast.show} />
      {manage && <ManageTaxonomyModal kind={manage} open onClose={() => setManage(null)} toast={toast.show} />}
      {toast.node}
    </div>
  );
}
