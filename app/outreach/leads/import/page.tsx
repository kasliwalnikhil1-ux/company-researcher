'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { Button, Card, EmptyState, PageHeader, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { ArrowLeft, FileSpreadsheet, Search, Users, ShieldAlert } from 'lucide-react';
import { SearchUrlImport } from '@/components/outreach/leads/import/SearchUrlImport';
import { CsvImport } from '@/components/outreach/leads/import/CsvImport';
import { RelationsImport } from '@/components/outreach/leads/import/RelationsImport';
import { ImportJobsTable } from '@/components/outreach/leads/ImportJobsTable';

type Source = 'search_url' | 'csv' | 'relations';
const SOURCES: Array<{ id: Source; label: string; description: string; icon: typeof Search }> = [
  { id: 'search_url', label: 'Search URL', description: 'Paste a LinkedIn or Sales Navigator people search. Runs over days within safety limits.', icon: Search },
  { id: 'csv', label: 'CSV file', description: 'Upload a spreadsheet, map columns and de-duplicate against existing leads.', icon: FileSpreadsheet },
  { id: 'relations', label: 'Connections', description: 'Import a sender’s existing 1st-degree connections.', icon: Users },
];

export default function LeadsImportPage() {
  const { canWrite, suspended } = useWorkspace();
  const toast = useToast();
  const [source, setSource] = useState<Source>('search_url');
  const jobsRef = useRef<HTMLDivElement>(null);
  const onCreated = () => { jobsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

  return (
    <div>
      <PageHeader title="Import leads" subtitle="Bring people into the workspace from LinkedIn searches, spreadsheets or your senders' networks. Everything is de-duplicated by LinkedIn identifier, then email."
        actions={<Link href="/outreach/leads"><Button variant="secondary"><ArrowLeft className="w-4 h-4" /> Back to leads</Button></Link>} />

      {!canWrite ? (
        <Card><EmptyState icon={<ShieldAlert className="w-6 h-6" />} title={suspended ? 'Workspace is read-only' : 'You cannot import leads'} description={suspended ? 'Imports are disabled while the workspace is suspended.' : 'Ask a workspace owner or manager for the member role to import leads.'} /></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[260px,1fr] gap-4">
          <div className="flex lg:flex-col gap-2 overflow-x-auto" role="tablist" aria-label="Import source">
            {SOURCES.map((s) => (
              <button key={s.id} role="tab" aria-selected={source === s.id} onClick={() => setSource(s.id)}
                className={cn('flex-1 lg:flex-none text-left rounded-xl border p-3 transition-colors min-w-[180px]', source === s.id ? 'border-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900"><s.icon className={cn('w-4 h-4', source === s.id ? 'text-indigo-600' : 'text-gray-400')} /> {s.label}</div>
                <p className="text-xs text-gray-500 mt-1 hidden sm:block">{s.description}</p>
              </button>
            ))}
          </div>
          <Card title={SOURCES.find((s) => s.id === source)?.label}>
            {source === 'search_url' && <SearchUrlImport toast={toast.show} onCreated={onCreated} />}
            {source === 'csv' && <CsvImport toast={toast.show} onCreated={onCreated} />}
            {source === 'relations' && <RelationsImport toast={toast.show} onCreated={onCreated} />}
          </Card>
        </div>
      )}

      <div className="mt-8 scroll-mt-4" ref={jobsRef}>
        <h2 className="text-base font-semibold text-gray-900 mb-3">Import jobs</h2>
        <ImportJobsTable toast={toast.show} />
      </div>
      {toast.node}
    </div>
  );
}
