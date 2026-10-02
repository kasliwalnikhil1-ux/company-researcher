'use client';

// Page frame for AI Website Chatbots (/outreach/websites, its own sidebar item): header and the role gate.

import React from 'react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { ErrorBox, PageHeader, PageLoader } from '@/components/outreach/ui';
import { roleAtLeast } from '@/components/outreach/settings/SettingsTabs';

export const WEBSITES_PATH = '/outreach/websites';
export const WEBSITES_TITLE = 'Website assistant';

export default function WebsitesFrame({ children, subtitle, actions }: { children: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode }) {
  const { workspace, role } = useWorkspace();
  if (!workspace) return <PageLoader />;
  return (
    <div>
      <PageHeader title={WEBSITES_TITLE} subtitle={subtitle} actions={actions} />
      {roleAtLeast(role, 'member') ? children : <ErrorBox message="Only workspace members can open this page." />}
    </div>
  );
}
