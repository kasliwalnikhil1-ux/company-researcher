'use client';

import { useRef, useState } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { BackLink, Card, EmptyState, PageHeader, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Building2, Compass, FileSpreadsheet, MessageSquare, Search, ShieldAlert, ThumbsUp, Users } from 'lucide-react';
import { SearchUrlImport } from '@/components/outreach/leads/import/SearchUrlImport';
import { CsvImport } from '@/components/outreach/leads/import/CsvImport';
import { RelationsImport } from '@/components/outreach/leads/import/RelationsImport';
import { PostEngagementImport } from '@/components/outreach/leads/import/PostEngagementImport';
import { SalesNavImport } from '@/components/outreach/leads/import/SalesNavImport';
import { CompanyPeopleImport } from '@/components/outreach/leads/import/CompanyPeopleImport';
import { ConversationsImport } from '@/components/outreach/leads/import/ConversationsImport';
import { ImportJobsTable } from '@/components/outreach/leads/ImportJobsTable';
import { ImportSchedulesTable } from '@/components/outreach/leads/ImportSchedulesTable';

type Source = 'search_url' | 'post_engagement' | 'sales_nav' | 'company_people' | 'conversations' | 'csv' | 'relations';
type Speed = 'instant' | 'hours' | 'days' | 'slowest';

// Each source says honestly what it costs the sender's LinkedIn account and how long it takes.
const SOURCES: Array<{ id: Source; label: string; description: string; cost: string; speed: Speed; icon: typeof Search }> = [
  { id: 'search_url', label: 'Search URL', description: 'Paste a LinkedIn or Sales Navigator people search.', cost: 'Uses daily search pages', speed: 'days', icon: Search },
  { id: 'post_engagement', label: 'Post engagement', description: 'People who reacted to or commented on a post. High intent.', cost: 'Uses daily search pages, no profile views', speed: 'hours', icon: ThumbsUp },
  { id: 'sales_nav', label: 'Sales Navigator lists', description: 'Pick a saved search or a lead list instead of pasting a link.', cost: 'Uses daily search pages, needs a Sales Navigator seat', speed: 'days', icon: Compass },
  { id: 'company_people', label: 'People in target companies', description: 'Start from a company list and find people by title.', cost: 'One lookup plus up to three searches per company', speed: 'slowest', icon: Building2 },
  { id: 'conversations', label: 'Conversations as leads', description: 'Create leads from inbox conversations that have no lead yet.', cost: 'No LinkedIn calls', speed: 'instant', icon: MessageSquare },
  { id: 'csv', label: 'CSV file', description: 'Create leads from a spreadsheet, or update chosen columns of existing leads.', cost: 'No LinkedIn calls', speed: 'instant', icon: FileSpreadsheet },
  { id: 'relations', label: 'Connections', description: 'A sender’s existing 1st-degree connections.', cost: 'One page of 100 per hour, no invite or message allowance', speed: 'hours', icon: Users },
];
const SPEED: Record<Speed, { label: string; cls: string }> = {
  instant: { label: 'Minutes', cls: 'bg-green-100 text-green-800' },
  hours: { label: 'Hours', cls: 'bg-blue-100 text-blue-800' },
  days: { label: 'Days', cls: 'bg-amber-100 text-amber-800' },
  slowest: { label: 'Slowest', cls: 'bg-red-100 text-red-800' },
};

export default function LeadsImportPage() {
  const { canWrite, suspended } = useWorkspace();
  const toast = useToast();
  const [source, setSource] = useState<Source>('search_url');
  const jobsRef = useRef<HTMLDivElement>(null);
  const onCreated = () => { jobsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  const current = SOURCES.find((s) => s.id === source);

  return (
    <div>
      <BackLink href="/outreach/leads">Back to leads</BackLink>
      <PageHeader title="Import leads" subtitle="Bring people in from LinkedIn searches, posts, Sales Navigator, target companies, your inbox, spreadsheets or your senders' networks. Everything is de-duplicated by LinkedIn identifier, then email." />

      {!canWrite ? (
        <Card><EmptyState icon={<ShieldAlert className="w-6 h-6" />} title={suspended ? 'Workspace is read-only' : 'You cannot import leads'} description={suspended ? 'Imports are disabled while the workspace is suspended.' : 'Ask a workspace owner or manager for the member role to import leads.'} /></Card>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[280px,1fr] gap-4">
          <div className="flex lg:flex-col gap-2 overflow-x-auto lg:overflow-visible pb-1 lg:pb-0" role="tablist" aria-label="Import source" aria-orientation="vertical">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" role="tab" id={`import-tab-${s.id}`} aria-controls="import-panel" aria-selected={source === s.id} onClick={() => setSource(s.id)}
                className={cn('flex-1 lg:flex-none text-left rounded-xl border p-3 transition-colors min-w-[200px] focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500', source === s.id ? 'border-indigo-500 ring-1 ring-inset ring-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <s.icon className={cn('w-4 h-4 flex-shrink-0', source === s.id ? 'text-indigo-600' : 'text-gray-400')} />
                  <span className="flex-1 min-w-0 truncate">{s.label}</span>
                  <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0', SPEED[s.speed].cls)}>{SPEED[s.speed].label}</span>
                </div>
                <p className="text-xs text-gray-500 mt-1 hidden sm:block">{s.description}</p>
                <p className="text-[11px] text-gray-400 mt-0.5 hidden sm:block">{s.cost}</p>
              </button>
            ))}
          </div>
          <div id="import-panel" role="tabpanel" aria-labelledby={`import-tab-${source}`}>
            <Card title={current?.label}>
              {source === 'search_url' && <SearchUrlImport toast={toast.show} onCreated={onCreated} />}
              {source === 'post_engagement' && <PostEngagementImport toast={toast.show} onCreated={onCreated} />}
              {source === 'sales_nav' && <SalesNavImport toast={toast.show} onCreated={onCreated} />}
              {source === 'company_people' && <CompanyPeopleImport toast={toast.show} onCreated={onCreated} />}
              {source === 'conversations' && <ConversationsImport toast={toast.show} onCreated={onCreated} />}
              {source === 'csv' && <CsvImport toast={toast.show} onCreated={onCreated} />}
              {source === 'relations' && <RelationsImport toast={toast.show} onCreated={onCreated} />}
            </Card>
          </div>
        </div>
      )}

      <div className="mt-8 scroll-mt-4" ref={jobsRef}>
        <h2 className="text-base font-semibold text-gray-900 mb-3">Import jobs</h2>
        <ImportJobsTable toast={toast.show} />
      </div>

      <div className="mt-8">
        <h2 className="text-base font-semibold text-gray-900">Repeating imports</h2>
        <p className="text-sm text-gray-500 mb-3">Each run is a normal import job above, under the same daily limits and working hours. Only new people are added.</p>
        <ImportSchedulesTable toast={toast.show} />
      </div>
      {toast.node}
    </div>
  );
}
