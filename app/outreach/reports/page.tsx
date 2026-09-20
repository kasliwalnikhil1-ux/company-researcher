'use client';

import React, { Suspense, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { CalendarClock, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients } from '@/lib/outreach/queries';
import { Button, PageHeader, Spinner, useToast } from '@/components/outreach/ui';
import { isIsoDay, presetRange, validRange, type DateRange } from '@/lib/outreach/reports';
import RangePicker from '@/components/outreach/reports/RangePicker';
import OverviewTab from '@/components/outreach/reports/OverviewTab';
import FunnelTab from '@/components/outreach/reports/FunnelTab';
import RepliesTab from '@/components/outreach/reports/RepliesTab';
import SequencesTab from '@/components/outreach/reports/SequencesTab';
import SendersTab from '@/components/outreach/reports/SendersTab';
import ClientsTab from '@/components/outreach/reports/ClientsTab';
import CostTab from '@/components/outreach/reports/CostTab';
import SchedulesDrawer from '@/components/outreach/reports/SchedulesDrawer';

const TABS = [
  { key: 'overview', label: 'Overview' }, { key: 'funnel', label: 'Funnel' }, { key: 'replies', label: 'Replies' }, { key: 'sequences', label: 'Sequences' },
  { key: 'senders', label: 'Senders' }, { key: 'clients', label: 'Clients' }, { key: 'cost', label: 'Cost' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

function ReportsPage() {
  const { workspace, isManager, role } = useWorkspace();
  const ws = workspace?.id ?? '';
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const toast = useToast();
  const clients = useClients(ws || null);
  const [schedulesOpen, setSchedulesOpen] = useState(false);

  const timezone = (typeof workspace?.settings?.timezone === 'string' && workspace.settings.timezone) || 'UTC';
  const isViewer = role === 'client_viewer';
  const hasClients = (clients.data?.length ?? 0) > 0;
  const tabs = useMemo(() => TABS.filter((t) => (t.key !== 'clients' || hasClients) && (t.key !== 'cost' || !isViewer)), [hasClients, isViewer]);

  // Everything that defines the view lives in the URL, so a link to a report is a link to these numbers.
  const rawTab = params.get('tab');
  const tab: TabKey = tabs.some((t) => t.key === rawTab) ? (rawTab as TabKey) : 'overview';
  const from = params.get('from'); const to = params.get('to');
  const range: DateRange = useMemo(() => {
    const r = isIsoDay(from) && isIsoDay(to) ? { from, to } : null;
    return r && !validRange(r) ? r : presetRange('30d', timezone);
  }, [from, to, timezone]);
  const rawClient = params.get('client');
  const client = rawClient && (clients.data ?? []).some((c) => c.id === rawClient) ? rawClient : null;

  const setParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) { if (v === null || v === '') next.delete(k); else next.set(k, v); }
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }, [params, pathname, router]);

  const showToast = toast.show;
  const notice = useCallback((m: string, t?: 'success' | 'error') => showToast(m, t), [showToast]);
  if (!workspace) return <Spinner />;
  const props = { ws, client, range };

  return (
    <div>
      <PageHeader title="Reports" subtitle="One set of numbers for the dashboard, the client portal, the connector and the API."
        actions={isManager ? <Button variant="secondary" onClick={() => setSchedulesOpen(true)}><CalendarClock className="w-4 h-4" /> Schedules</Button> : undefined} />

      <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <RangePicker value={range} timezone={timezone} workspaceId={ws} onNotice={notice} onChange={(r) => setParams({ from: r.from, to: r.to })} />
        <div className="flex flex-wrap items-center gap-4">
          {hasClients && (
            <label className="flex items-center gap-2 text-sm text-gray-600">Client
              <select value={client ?? ''} onChange={(e) => setParams({ client: e.target.value || null })} className="px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 max-w-[220px] focus:outline-none focus:ring-2 focus:ring-indigo-500">
                <option value="">All clients</option>{(clients.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </label>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-500"><Globe className="w-3.5 h-3.5" /> Numbers are in {timezone} time.
            {isManager && <Link href="/outreach/settings/workspace" className="underline underline-offset-2 hover:text-gray-900">Change timezone</Link>}
          </span>
        </div>
      </div>

      <div role="tablist" aria-label="Report" className="flex gap-1 border-b border-gray-200 mb-6 overflow-x-auto">
        {tabs.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} onClick={() => setParams({ tab: t.key === 'overview' ? null : t.key })}
            className={cn('px-3.5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors', tab === t.key ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')}>{t.label}</button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'overview' && <OverviewTab {...props} />}
        {tab === 'funnel' && <FunnelTab {...props} />}
        {tab === 'replies' && <RepliesTab {...props} onNotice={notice} />}
        {tab === 'sequences' && <SequencesTab {...props} canPromote={isManager} />}
        {tab === 'senders' && <SendersTab {...props} />}
        {tab === 'clients' && <ClientsTab ws={ws} range={range} onFilterClient={(id) => setParams({ client: id, tab: null })} />}
        {tab === 'cost' && <CostTab {...props} onNotice={notice} />}
      </div>

      {isManager && <SchedulesDrawer open={schedulesOpen} onClose={() => setSchedulesOpen(false)} ws={ws} onNotice={notice} />}
      {toast.node}
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<Spinner />}><ReportsPage /></Suspense>;
}
