'use client';

import { Suspense } from 'react';
import { useSearchParams } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame, { SETUP_BACK } from '@/components/outreach/ai/hub/HubFrame';
import RepliesIntro from '@/components/outreach/ai/hub/setup/RepliesIntro';
import RepliesSequences from '@/components/outreach/ai/hub/setup/RepliesSequences';
import { SetupHeading, SubTabs } from '@/components/outreach/ai/hub/setup/parts';
import ReportsPanel from '@/components/outreach/settings/ai-replies/reports/ReportsPanel';
import { FEATURE_HELP, FEATURE_LABEL, hubHref } from '@/lib/outreach/aiHub';
import { PageLoader, useToast } from '@/components/outreach/ui';

const TABS = [
  { key: 'sequences', label: 'Sequences', href: hubHref.setupReplies() },
  { key: 'reports', label: 'Reports', href: hubHref.setupReplies('reports') },
] as const;
type Tab = typeof TABS[number]['key'];

/**
 * /outreach/ai/setup/replies: AI replies across the workspace.
 *   (default)       every sequence with its mode, switchable inline; the prompt and limits stay on the sequence's AI tab
 *   ?tab=reports    reply metrics, hand-offs and cancel reasons
 */
function RepliesView() {
  const { workspace } = useWorkspace();
  const search = useSearchParams();
  const toast = useToast();
  const raw = search.get('tab');
  const tab: Tab = raw === 'reports' ? raw : 'sequences';

  if (!workspace) return <PageLoader />;
  const ws = workspace.id;
  return (
    <>
      <div className="space-y-5">
        <SetupHeading title={FEATURE_LABEL.reply} help={FEATURE_HELP.reply} />
        <RepliesIntro ws={ws} />
        <SubTabs items={[...TABS]} active={tab} label="AI replies sections" />
        {tab === 'sequences' && <RepliesSequences ws={ws} notify={toast.show} />}
        {tab === 'reports' && <ReportsPanel ws={ws} />}
      </div>
      {toast.node}
    </>
  );
}

export default function AiSetupRepliesPage() {
  return (
    <HubFrame back={SETUP_BACK} subtitle="Setup: AI replies. Every sequence with its mode and the reports.">
      <Suspense fallback={<PageLoader />}>
        <RepliesView />
      </Suspense>
    </HubFrame>
  );
}
