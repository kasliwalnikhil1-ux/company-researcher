'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useClients, useSender } from '@/lib/outreach/queries';
import { Avatar, BackLink, Badge, ErrorBox, HealthBar, PageLoader, StatusPill, useToast } from '@/components/outreach/ui';
import { PROVIDER_LABELS } from '@/components/outreach/senders/helpers';
import SenderOverview from '@/components/outreach/senders/SenderOverview';
import ScheduleEditor from '@/components/outreach/senders/ScheduleEditor';
import BudgetsPanel from '@/components/outreach/senders/BudgetsPanel';
import EventsTimeline from '@/components/outreach/senders/EventsTimeline';
import ExtensionSetup from '@/components/outreach/senders/ExtensionSetup';
import DangerZone from '@/components/outreach/senders/DangerZone';
import SenderInsights from '@/components/outreach/senders/SenderInsights';
import SenderActivityReport from '@/components/outreach/senders/SenderActivityReport';
import SenderSettings from '@/components/outreach/senders/SenderSettings';
import SenderDiagnosis from '@/components/outreach/senders/SenderDiagnosis';
import RunningDryCallout from '@/components/outreach/senders/RunningDry';
import type { SenderV2 } from '@/components/outreach/senders/insights';
import { cn } from '@/lib/utils';

const TABS = ['Overview', 'Insights', 'Activity', 'Schedule', 'Budgets', 'Events', 'Settings', 'Session', 'Danger'] as const;
type Tab = (typeof TABS)[number];

function SenderDetail() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const router = useRouter();
  const search = useSearchParams();
  const connected = search.get('connected');
  const tabParam = search.get('tab') === 'Extension' ? 'Session' : search.get('tab') ?? ''; // old links used ?tab=Extension
  const initialTab = (TABS as readonly string[]).includes(tabParam) ? (tabParam as Tab) : 'Overview';
  const [tab, setTab] = useState<Tab>(initialTab);
  const { workspace, isManager, canWrite, role } = useWorkspace();
  const sender = useSender(id);
  const clients = useClients(workspace?.id);
  const toast = useToast();

  useEffect(() => {
    // strip the one-shot ?connected flag after it has been shown so a refresh does not repeat the banner
    if (connected != null && id) {
      const t = setTimeout(() => router.replace(`/outreach/senders/${id}${tab !== 'Overview' ? `?tab=${tab}` : ''}`), 8000);
      return () => clearTimeout(t);
    }
  }, [connected, id, router, tab]);

  // A connect that turned out to be an already-connected account was folded into that sender; follow it.
  const mergedInto = sender.data?.deleted_at && typeof sender.data.status_reason === 'string' && sender.data.status_reason.startsWith('merged_into:') ? sender.data.status_reason.slice('merged_into:'.length) : null;
  useEffect(() => {
    if (mergedInto) router.replace(`/outreach/senders/${mergedInto}${connected != null ? `?connected=${connected}` : ''}`);
  }, [mergedInto, connected, router]);

  const selectTab = (t: Tab) => { setTab(t); router.replace(`/outreach/senders/${id}${t !== 'Overview' ? `?tab=${t}` : ''}`); };

  if (role === 'client_viewer') return <ErrorBox message="Client viewers cannot open sender pages." />;
  if (sender.isLoading || mergedInto) return <PageLoader />;
  if (sender.isError) return <ErrorBox message={(sender.error as Error).message} />;
  const s = sender.data as SenderV2 | undefined;
  if (!s || s.workspace_id !== workspace?.id) return <div><BackLink href="/outreach/senders">Back to senders</BackLink><ErrorBox message="Sender not found in this workspace." /></div>;

  const visibleTabs = TABS.filter((t) => t !== 'Danger' || isManager);

  return (
    <div>
      <BackLink href="/outreach/senders">Back to senders</BackLink>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar src={s.picture_url} name={s.display_name} size={10} />
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-gray-900 truncate">{s.display_name ?? 'Unnamed sender'}</h1>
            <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500 mt-0.5">
              <span>{PROVIDER_LABELS[s.provider]}</span>
              {s.public_identifier && <span>· {s.public_identifier}</span>}
              {s.client_id && clients.data && <span>· {clients.data.find((c) => c.id === s.client_id)?.name ?? 'client'}</span>}
              <span>· {s.timezone}</span>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {s.status !== 'disabled' && <SenderDiagnosis senderId={s.id} senderName={s.display_name} />}
          <StatusPill status={s.status} reason={s.status_reason} />
          <Badge tone="indigo">Level {s.warmup_level}</Badge>
          <HealthBar score={s.health_score} />
        </div>
      </div>

      <RunningDryCallout sender={s} canWrite={canWrite} />

      <div className="border-b border-gray-200 mb-6">
        <nav className="flex flex-wrap gap-1 -mb-px" role="tablist">
          {visibleTabs.map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => selectTab(t)} className={cn('px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800', t === 'Danger' && tab !== t && 'text-red-500 hover:text-red-700')}>{t}</button>
          ))}
        </nav>
      </div>

      {tab === 'Overview' && <SenderOverview sender={s} clients={clients.data ?? []} isManager={isManager} canWrite={canWrite} connected={connected} notify={toast.show} />}
      {tab === 'Insights' && <SenderInsights sender={s} />}
      {tab === 'Activity' && <SenderActivityReport sender={s} workspaceTimezone={typeof workspace?.settings?.timezone === 'string' ? workspace.settings.timezone : null} />}
      {tab === 'Settings' && <SenderSettings sender={s} isManager={isManager} canWrite={canWrite} notify={toast.show} workspaceSettings={workspace?.settings} />}
      {tab === 'Schedule' && <ScheduleEditor sender={s} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Budgets' && <BudgetsPanel sender={s} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Events' && <EventsTimeline senderId={s.id} />}
      {tab === 'Session' && <ExtensionSetup sender={s} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Danger' && isManager && <DangerZone sender={s} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {toast.node}
    </div>
  );
}

export default function SenderDetailPage() {
  return <Suspense fallback={<PageLoader />}><SenderDetail /></Suspense>;
}
