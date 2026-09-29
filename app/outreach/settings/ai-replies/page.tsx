'use client';

import { Suspense, useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { SettingsFrame } from '@/components/outreach/settings/shared';
import { PageLoader, useToast } from '@/components/outreach/ui';
import type { PolicyScope, PromptScope } from '@/lib/outreach/aiReplies';
import { AiPromptDraftProvider } from '@/components/outreach/settings/ai-replies/prompt/draftContext';
import MasterPromptPanel from '@/components/outreach/settings/ai-replies/prompt/MasterPromptPanel';
import SimulatorPanel from '@/components/outreach/settings/ai-replies/simulator/SimulatorPanel';
import AiRepliesIntro from '@/components/outreach/settings/ai-replies/AiRepliesIntro';
import AiRepliesTabNav from '@/components/outreach/settings/ai-replies/AiRepliesTabNav';
import PoliciesPanel from '@/components/outreach/settings/ai-replies/policies/PoliciesPanel';
import ConsentPanel from '@/components/outreach/settings/ai-replies/consent/ConsentPanel';
import GraduationPanel from '@/components/outreach/settings/ai-replies/GraduationPanel';
import ActivityPanel from '@/components/outreach/settings/ai-replies/activity/ActivityPanel';
import ReportsPanel from '@/components/outreach/settings/ai-replies/reports/ReportsPanel';
import { isAiTab, type AiTab } from '@/components/outreach/settings/ai-replies/format';

const PROMPT_SCOPES: PromptScope[] = ['workspace', 'client', 'sequence'];
const POLICY_SCOPES: PolicyScope[] = ['workspace', 'client', 'sequence', 'sender'];

/**
 * URL: `?tab=<prompt|simulator|policies|consent|graduation|activity|reports>`.
 * `run=<id>` opens a run (Simulator: "Why did it say that?"; Activity: the run drawer).
 * `scope=<client|sequence|sender>&scope_id=<id>` preselects a scope (links from sequence settings).
 */
function AiRepliesView() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const toast = useToast();

  const rawTab = search.get('tab');
  const tab: AiTab = isAiTab(rawTab) ? rawTab : 'prompt';
  const runId = search.get('run');
  const rawScope = search.get('scope');
  const scopeId = search.get('scope_id');
  const promptScope = PROMPT_SCOPES.includes(rawScope as PromptScope) && (rawScope === 'workspace' || scopeId)
    ? { scope: rawScope as PromptScope, scopeId: rawScope === 'workspace' ? null : scopeId } : undefined;
  const policyScope = POLICY_SCOPES.includes(rawScope as PolicyScope) && (rawScope === 'workspace' || scopeId)
    ? { scope: rawScope as PolicyScope, scopeId: rawScope === 'workspace' ? null : scopeId } : null;

  const go = useCallback((next: Record<string, string | null>, mode: 'push' | 'replace' = 'replace') => {
    const p = new URLSearchParams(search.toString());
    for (const [k, v] of Object.entries(next)) { if (v == null || v === '') p.delete(k); else p.set(k, v); }
    if (p.get('tab') === 'prompt') p.delete('tab');
    const qs = p.toString();
    const url = qs ? `${pathname}?${qs}` : pathname;
    if (mode === 'push') router.push(url, { scroll: false }); else router.replace(url, { scroll: false });
  }, [pathname, router, search]);
  const openSimulator = useCallback(() => go({ tab: 'simulator' }), [go]);

  if (!workspace) return <PageLoader />;
  const ws = workspace.id;
  const canEdit = isManager && canWrite;

  return (
    <AiPromptDraftProvider onOpenSimulator={openSimulator}>
      <div className="space-y-5">
        <AiRepliesIntro ws={ws} />
        <AiRepliesTabNav tab={tab} onSelect={(t) => go({ tab: t, run: null })} />
        {tab === 'prompt' && <MasterPromptPanel ws={ws} canEdit={canEdit} initialScope={promptScope} />}
        {tab === 'simulator' && <SimulatorPanel ws={ws} canEdit={canEdit} runId={runId} scope={promptScope} />}
        {tab === 'policies' && <PoliciesPanel ws={ws} canEdit={canEdit} focus={policyScope} notify={toast.show} />}
        {tab === 'consent' && <ConsentPanel ws={ws} canEdit={canEdit} isManager={isManager} notify={toast.show} />}
        {tab === 'graduation' && <GraduationPanel ws={ws} onOpenPrompt={() => go({ tab: 'prompt' })} onOpenSimulator={() => go({ tab: 'simulator' })} />}
        {tab === 'activity' && (
          <ActivityPanel ws={ws} openRunId={runId}
            onOpenRun={(id) => go({ run: id })}
            onWhy={(id) => go({ tab: 'simulator', run: id }, 'push')} />
        )}
        {tab === 'reports' && (
          <ReportsPanel ws={ws}
            onOpenPrompt={() => go({ tab: 'prompt', run: null })}
            onOpenRun={(id) => go({ tab: 'activity', run: id }, 'push')} />
        )}
      </div>
      {toast.node}
    </AiPromptDraftProvider>
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
