'use client';

import { Suspense, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { PageLoader, useToast } from '@/components/outreach/ui';
import AiRepliesIntro from '@/components/outreach/settings/ai-replies/AiRepliesIntro';
import AiRepliesTabNav from '@/components/outreach/settings/ai-replies/AiRepliesTabNav';
import DefaultsPanel from '@/components/outreach/settings/ai-replies/defaults/DefaultsPanel';
import ConsentPanel from '@/components/outreach/settings/ai-replies/consent/ConsentPanel';
import ActivityPanel from '@/components/outreach/settings/ai-replies/activity/ActivityPanel';
import ReportsPanel from '@/components/outreach/settings/ai-replies/reports/ReportsPanel';
import { isAiTab, type AiTab } from '@/components/outreach/settings/ai-replies/format';

/**
 * Settings → AI replies (workspace-wide parts only; each sequence's AI replies tab holds the mode, prompt and limits).
 * URL: `?tab=<defaults|consent|activity|reports>`; `run=<id>` opens a run in the Activity drawer.
 */
function AiRepliesView() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();

  const rawTab = search.get('tab');
  const tab: AiTab = isAiTab(rawTab) ? rawTab : 'defaults';
  const runId = search.get('run');

  const go = useCallback((next: Record<string, string | null>, mode: 'push' | 'replace' = 'replace') => {
    const p = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(next)) { if (v == null || v === '') p.delete(k); else p.set(k, v); }
    if (p.get('tab') === 'defaults') p.delete('tab');
    for (const k of ['scope', 'scope_id']) p.delete(k);
    const qs = p.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (mode === 'push') router.push(url, { scroll: false }); else router.replace(url, { scroll: false });
  }, [pathname, router, search]);

  if (!workspace) return <PageLoader />;
  const ws = workspace.id;
  const canEdit = isManager && canWrite;

  return (
    <>
      <div className="space-y-5">
        <AiRepliesIntro ws={ws} />
        <AiRepliesTabNav tab={tab} onSelect={(t) => go({ tab: t, run: null })} />
        {tab === 'defaults' && <DefaultsPanel ws={ws} canEdit={canEdit} notify={toast.show} />}
        {tab === 'consent' && <ConsentPanel ws={ws} canEdit={canEdit} isManager={isManager} notify={toast.show} />}
        {tab === 'activity' && <ActivityPanel ws={ws} openRunId={runId} onOpenRun={(id) => go({ run: id })} />}
        {tab === 'reports' && <ReportsPanel ws={ws} onOpenRun={(id) => go({ tab: 'activity', run: id }, 'push')} />}
      </div>
      {toast.node}
    </>
  );
}

export default function AiRepliesSettingsPage() {
  return (
    <SettingsFrame min="member" deniedMessage="Only workspace members can open this page.">
      <Suspense fallback={<PageLoader />}>
        <AiRepliesView />
      </Suspense>
    </SettingsFrame>
  );
}
