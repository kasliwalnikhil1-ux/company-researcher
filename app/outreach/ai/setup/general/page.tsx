'use client';

import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame, { SETUP_BACK } from '@/components/outreach/ai/hub/HubFrame';
import UsageCard from '@/components/outreach/ai/hub/setup/UsageCard';
import { SetupHeading } from '@/components/outreach/ai/hub/setup/parts';
import LlmKeyCard from '@/components/outreach/settings/LlmKeyCard';
import FinderKeysCard from '@/components/outreach/settings/FinderKeysCard';
import VoiceKeyCard from '@/components/outreach/settings/VoiceKeyCard';
import DefaultsPanel from '@/components/outreach/settings/ai-replies/defaults/DefaultsPanel';
import { PageLoader, useToast } from '@/components/outreach/ui';

/**
 * /outreach/ai/setup/general: what every AI feature of the workspace shares (moved here from Settings → AI Personalization
 * and Settings → AI Auto Replies → Defaults): the AI provider and key, this month's usage, the per-sender daily cap for
 * AI replies, the default and library prompts, and the email finder keys that lived on the same settings page.
 */
function GeneralView() {
  const { workspace, isManager, canWrite } = useWorkspace();
  const toast = useToast();
  if (!workspace) return <PageLoader />;
  const ws = workspace.id;
  return (
    <>
      <div className="space-y-6 max-w-4xl">
        <SetupHeading title="General" help="What every AI feature of this workspace shares: the AI provider and key, this month's usage and the defaults for AI replies." />
        <LlmKeyCard />
        <VoiceKeyCard />
        <UsageCard ws={ws} />
        <DefaultsPanel ws={ws} canEdit={isManager && canWrite} notify={toast.show} />
        <FinderKeysCard />
      </div>
      {toast.node}
    </>
  );
}

export default function AiSetupGeneralPage() {
  return (
    <HubFrame min="manager" back={SETUP_BACK} subtitle="Setup: General. The AI provider and key, usage and defaults.">
      <GeneralView />
    </HubFrame>
  );
}
