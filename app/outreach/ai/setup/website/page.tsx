'use client';

import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import HubFrame, { SETUP_BACK } from '@/components/outreach/ai/hub/HubFrame';
import WebsiteModes from '@/components/outreach/ai/hub/setup/WebsiteModes';
import { SetupHeading } from '@/components/outreach/ai/hub/setup/parts';
import { FEATURE_HELP, FEATURE_LABEL } from '@/lib/outreach/aiHub';
import { PageLoader, useToast } from '@/components/outreach/ui';

/** /outreach/ai/setup/website: every website with the assistant's mode and When. The rest of the assistant is set on the website itself. */
function WebsiteView() {
  const { workspace } = useWorkspace();
  const toast = useToast();
  if (!workspace) return <PageLoader />;
  return (
    <>
      <div className="space-y-5">
        <SetupHeading title={FEATURE_LABEL.website} help={`${FEATURE_HELP.website} Pick the mode per website here. Click a website for the rest: what the assistant knows, how it talks and when it hands over.`} />
        <WebsiteModes ws={workspace.id} notify={toast.show} />
      </div>
      {toast.node}
    </>
  );
}

export default function AiSetupWebsitePage() {
  return (
    <HubFrame back={SETUP_BACK} subtitle="Setup: Website assistant. Every website with its mode.">
      <WebsiteView />
    </HubFrame>
  );
}
