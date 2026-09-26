'use client';

// Senders → Profiles: the part of Profile Studio that spans senders (linkedin-profile-management-PRD.md): pending
// changes, templates + bulk apply, experiments, and the profile-score vs acceptance view. Per-sender editing lives
// on each sender's Profile tab. Reached from the Senders page, not from the main navigation.
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { ErrorBox, PageHeader, PageLoader, useToast } from '@/components/outreach/ui';
import { SendersSubnav } from '@/components/outreach/senders/SendersSubnav';
import PendingPanel from '@/components/outreach/profile/PendingPanel';
import TemplatesPanel from '@/components/outreach/profile/TemplatesPanel';
import ExperimentsPanel from '@/components/outreach/profile/ExperimentsPanel';
import InsightsPanel from '@/components/outreach/profile/InsightsPanel';
import { cn } from '@/lib/utils';

const TABS = ['Changes', 'Templates', 'Experiments', 'Insights'] as const;
type Tab = (typeof TABS)[number];

function ProfilesInner() {
  const { workspace, isManager, canWrite, role } = useWorkspace();
  const router = useRouter();
  const search = useSearchParams();
  const initial = (TABS as readonly string[]).includes(search.get('tab') ?? '') ? (search.get('tab') as Tab) : 'Changes';
  const [tab, setTab] = useState<Tab>(initial);
  const toast = useToast();
  if (!workspace) return <PageLoader />;
  if (role === 'client_viewer') return <ErrorBox message="Client viewers cannot open this page." />;
  const select = (t: Tab) => { setTab(t); router.replace(`/outreach/senders/profiles${t !== 'Changes' ? `?tab=${t}` : ''}`); };
  return (
    <div>
      <PageHeader title="Senders" subtitle="What prospects see when they click a sender: headlines, About sections and photos, kept in step with your offer and tested against acceptance" />
      <SendersSubnav />
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex flex-wrap gap-1 -mb-px" role="tablist">
          {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => select(t)} className={cn('px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', tab === t ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>{t}</button>)}
        </nav>
      </div>
      {tab === 'Changes' && <PendingPanel ws={workspace.id} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Templates' && <TemplatesPanel ws={workspace.id} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Experiments' && <ExperimentsPanel ws={workspace.id} isManager={isManager} canWrite={canWrite} notify={toast.show} />}
      {tab === 'Insights' && <InsightsPanel ws={workspace.id} />}
      {toast.node}
    </div>
  );
}

export default function ProfilesPage() {
  return <Suspense fallback={<PageLoader />}><ProfilesInner /></Suspense>;
}
