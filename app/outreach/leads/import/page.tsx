'use client';

import { useEffect, useRef, useState } from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { BackLink, Card, EmptyState, PageHeader, useToast } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import { Building2, Check, ChevronDown, Compass, FileSpreadsheet, MessageSquare, Search, ShieldAlert, ThumbsUp, Users, X } from 'lucide-react';
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
  { id: 'csv', label: 'CSV file', description: 'Create leads from a spreadsheet, or update chosen columns of existing leads.', cost: 'No LinkedIn calls', speed: 'instant', icon: FileSpreadsheet },
  { id: 'search_url', label: 'Search URL', description: 'Paste a LinkedIn or Sales Navigator people search.', cost: 'Uses daily search pages', speed: 'days', icon: Search },
  { id: 'post_engagement', label: 'Post engagement', description: 'People who reacted to or commented on a post. High intent.', cost: 'Uses daily search pages, no profile views', speed: 'hours', icon: ThumbsUp },
  { id: 'sales_nav', label: 'Sales Navigator lists', description: 'Pick a saved search or a lead list instead of pasting a link.', cost: 'Uses daily search pages, needs a Sales Navigator seat', speed: 'days', icon: Compass },
  { id: 'company_people', label: 'People in target companies', description: 'Start from a company list and find people by title.', cost: 'One lookup plus up to three searches per company', speed: 'slowest', icon: Building2 },
  { id: 'conversations', label: 'Conversations as leads', description: 'Create leads from inbox conversations that have no lead yet.', cost: 'No LinkedIn calls', speed: 'instant', icon: MessageSquare },
  { id: 'relations', label: 'Connections', description: 'A sender’s existing 1st-degree connections.', cost: 'One page of 100 per hour, no invite or message allowance', speed: 'hours', icon: Users },
];
const SPEED: Record<Speed, { label: string; cls: string }> = {
  instant: { label: 'Minutes', cls: 'bg-green-100 text-green-800' },
  hours: { label: 'Hours', cls: 'bg-blue-100 text-blue-800' },
  days: { label: 'Days', cls: 'bg-amber-100 text-amber-800' },
  slowest: { label: 'Slowest', cls: 'bg-red-100 text-red-800' },
};
type SourceDef = (typeof SOURCES)[number];

function SpeedBadge({ speed }: { speed: Speed }) {
  return <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0', SPEED[speed].cls)}>{SPEED[speed].label}</span>;
}

/** Mobile and tablet: the chosen source as one full-width card. Tapping it opens SourceSheet. */
function SourcePicker({ current, onOpen }: { current: SourceDef; onOpen: () => void }) {
  return (
    <div className="lg:hidden">
      <p className="text-xs font-medium text-gray-500 mb-1.5">Import from</p>
      <button type="button" onClick={onOpen} aria-haspopup="dialog"
        className="w-full flex items-start gap-3 text-left rounded-xl border border-gray-200 bg-white p-3.5 shadow-sm active:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500">
        <span className="w-10 h-10 rounded-lg bg-indigo-50 text-indigo-600 flex items-center justify-center flex-shrink-0"><current.icon className="w-5 h-5" /></span>
        <span className="flex-1 min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-gray-900 truncate">{current.label}</span>
            <SpeedBadge speed={current.speed} />
          </span>
          <span className="block text-xs text-gray-500 mt-0.5">{current.description}</span>
          <span className="block text-[11px] text-gray-400 mt-0.5">{current.cost}</span>
        </span>
        <span className="flex items-center gap-0.5 text-xs font-medium text-indigo-600 flex-shrink-0 self-center">Change<ChevronDown className="w-4 h-4" /></span>
      </button>
    </div>
  );
}

/** Bottom sheet listing every source with its description, speed and LinkedIn cost. Only used below lg. */
function SourceSheet({ open, source, onPick, onClose }: { open: boolean; source: Source; onPick: (id: Source) => void; onClose: () => void }) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    selectedRef.current?.focus({ preventScroll: true });
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; };
  }, [open, onClose]);

  return (
    // Closed, the sheet turns invisible only after it has slid away, which also keeps its options out of the tab order.
    <div className={cn('lg:hidden fixed inset-0 z-50 transition-[visibility] duration-300', open ? 'visible' : 'invisible pointer-events-none')} aria-hidden={!open}>
      <div className={cn('absolute inset-0 bg-black/40 transition-opacity duration-200', open ? 'opacity-100' : 'opacity-0')} onClick={onClose} />
      <div role="dialog" aria-modal="true" aria-label="Choose an import source"
        className={cn('absolute inset-x-0 bottom-0 mx-auto sm:max-w-lg bg-white rounded-t-2xl shadow-xl flex flex-col max-h-[calc(85dvh_-_var(--demo-bar,0px))] transition-transform duration-300 ease-out', open ? 'translate-y-0' : 'translate-y-full')}>
        <div className="pt-2.5 pb-1 flex justify-center"><span className="w-10 h-1 rounded-full bg-gray-300" /></div>
        <div className="flex items-center justify-between px-5 pb-3">
          <h3 className="text-base font-semibold text-gray-900">Choose a source</h3>
          <button type="button" onClick={onClose} aria-label="Close" className="p-1.5 -mr-1.5 rounded-md hover:bg-gray-100 text-gray-500"><X className="w-4 h-4" /></button>
        </div>
        <div className="overflow-y-auto overscroll-contain px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] space-y-1.5" role="radiogroup" aria-label="Import source">
          {SOURCES.map((s) => {
            const on = s.id === source;
            return (
              <button key={s.id} ref={on ? selectedRef : undefined} type="button" role="radio" aria-checked={on} onClick={() => onPick(s.id)}
                className={cn('w-full flex items-start gap-3 text-left rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500', on ? 'border-indigo-500 ring-1 ring-inset ring-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white active:bg-gray-50')}>
                <span className={cn('w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0', on ? 'bg-white text-indigo-600' : 'bg-gray-100 text-gray-500')}><s.icon className="w-[18px] h-[18px]" /></span>
                <span className="flex-1 min-w-0">
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-gray-900 truncate">{s.label}</span>
                    <SpeedBadge speed={s.speed} />
                  </span>
                  <span className="block text-xs text-gray-500 mt-0.5">{s.description}</span>
                  <span className="block text-[11px] text-gray-400 mt-0.5">{s.cost}</span>
                </span>
                <span className={cn('w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0 self-center', on ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-gray-300')}>{on && <Check className="w-3 h-3" strokeWidth={3} />}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function LeadsImportPage() {
  const { canWrite, suspended } = useWorkspace();
  const toast = useToast();
  const [source, setSource] = useState<Source>('csv');
  const [pickerOpen, setPickerOpen] = useState(false);
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
          {/* Below lg: one card shows the chosen source, and tapping it opens a bottom sheet with every source. */}
          {current && <SourcePicker current={current} onOpen={() => setPickerOpen(true)} />}
          <div className="hidden lg:flex lg:flex-col gap-2" role="tablist" aria-label="Import source" aria-orientation="vertical" data-tour="import-sources">
            {SOURCES.map((s) => (
              <button key={s.id} type="button" role="tab" id={`import-tab-${s.id}`} aria-controls="import-panel" aria-selected={source === s.id} onClick={() => setSource(s.id)}
                className={cn('text-left rounded-xl border p-3 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500', source === s.id ? 'border-indigo-500 ring-1 ring-inset ring-indigo-500 bg-indigo-50' : 'border-gray-200 bg-white hover:bg-gray-50')}>
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900">
                  <s.icon className={cn('w-4 h-4 flex-shrink-0', source === s.id ? 'text-indigo-600' : 'text-gray-400')} />
                  <span className="flex-1 min-w-0 truncate">{s.label}</span>
                  <SpeedBadge speed={s.speed} />
                </div>
                <p className="text-xs text-gray-500 mt-1">{s.description}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">{s.cost}</p>
              </button>
            ))}
          </div>
          <SourceSheet open={pickerOpen} source={source} onPick={(id) => { setSource(id); setPickerOpen(false); }} onClose={() => setPickerOpen(false)} />
          <div id="import-panel" role="tabpanel" aria-labelledby={`import-tab-${source}`} className="min-w-0">
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
