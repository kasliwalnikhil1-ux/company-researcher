'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowUpRight, Wrench } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useIsLocalhost } from '@/lib/outreach/platformAdmin';
import { Card, PageHeader, PageLoader } from '@/components/outreach/ui';
import SettingsTabs from '@/components/outreach/settings/SettingsTabs';
import PlatformSetupCard from '@/components/outreach/settings/admin/PlatformSetupCard';
import PlatformLimits from '@/components/outreach/settings/admin/PlatformLimits';
import AiReplyAdmin from '@/components/outreach/settings/admin/AiReplyAdmin';

/**
 * Settings → Admin: everything that is the same for every workspace, sender and user. Rendered only when the app runs on
 * localhost; on a deployed host the tab is hidden and this route sends you back to Settings → Workspace.
 */
export default function AdminSettingsPage() {
  const { workspace } = useWorkspace();
  const local = useIsLocalhost();
  const router = useRouter();

  useEffect(() => { if (local === false) router.replace('/outreach/settings/workspace'); }, [local, router]);

  if (!workspace || local !== true) return <PageLoader />;

  return (
    <div>
      <PageHeader title="Settings" subtitle={workspace.name} />
      <SettingsTabs />
      <div className="flex items-start gap-2 p-3 mb-6 rounded-lg bg-amber-50 text-amber-900 text-sm border border-amber-200">
        <Wrench className="w-4 h-4 mt-0.5 flex-shrink-0" />
        <span>Platform admin. This tab only appears when the app runs on localhost. Everything here applies to every workspace, sender and user, not just {workspace.name}.</span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        <div className="lg:col-span-2"><PlatformSetupCard /></div>
        <Card title="Accounts and workspaces">
          <p className="text-sm text-gray-600">Approve or block sign-ups, set plans and credits, turn features on per account, suspend outreach workspaces and manage the CRM team.</p>
          <Link href="/admin" className="inline-flex items-center gap-1 mt-3 text-sm text-indigo-600 hover:underline">Open the admin console <ArrowUpRight className="w-3.5 h-3.5" /></Link>
        </Card>
      </div>

      <PlatformLimits />
      <AiReplyAdmin />
    </div>
  );
}
