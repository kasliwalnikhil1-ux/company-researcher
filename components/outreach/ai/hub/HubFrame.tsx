'use client';

import Link from '@/lib/outreach/nav';
import { usePathname } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { HUB_TABS, hubHref, useNeedsYouCounts } from '@/lib/outreach/aiHub';
import { BackLink, ErrorBox, PageHeader, PageLoader } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { Role } from '@/lib/outreach/types';
import { roleAtLeast } from '@/components/outreach/settings/SettingsTabs';

/** Needs you · Activity · Knowledge · Setup: the sections of the AI hub (the sidebar has one "AI" item). */
export function HubTabs() {
  const pathname = usePathname();
  const { workspace } = useWorkspace();
  const counts = useNeedsYouCounts(workspace?.id);
  const n = counts.data?.total ?? 0;
  return (
    <div className="border-b border-gray-200 mb-6">
      <nav className="flex flex-wrap gap-1 -mb-px" aria-label="AI sections">
        {HUB_TABS.map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link key={t.key} href={t.href} aria-current={active ? 'page' : undefined}
              className={cn('inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
              {t.label}
              {t.key === 'needs-you' && n > 0 && <span className="text-[10px] bg-indigo-600 text-white rounded-full px-1.5 py-0.5 leading-none tabular-nums">{n > 99 ? '99+' : n}</span>}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * Page frame shared by every screen of the AI hub: header, the four tabs and the role gate.
 * `min` is the lowest role that can use the page (default: member; client viewers never see the hub).
 * `back` puts a "← Setup" style link above the content of a sub-page.
 */
export default function HubFrame({ children, subtitle, actions, min = 'member', back }: {
  children: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; min?: Role; back?: { href: string; label: string };
}) {
  const { workspace, role } = useWorkspace();
  if (!workspace) return <PageLoader />;
  const allowed = roleAtLeast(role, min);
  return (
    <div>
      <PageHeader title="AI" subtitle={subtitle ?? 'Everything the AI writes for you: what needs a person, what it wrote, what it knows and how it is set up.'} actions={allowed ? actions : undefined} />
      <HubTabs />
      {back && allowed && <BackLink href={back.href} className="mb-4">{back.label}</BackLink>}
      {allowed ? children : <ErrorBox message={role === 'client_viewer' ? 'The AI pages are not available for client viewers.' : min === 'manager' ? 'Only owners and managers can open this page.' : 'Only workspace members can open this page.'} />}
    </div>
  );
}

export const SETUP_BACK = { href: hubHref.setup(), label: 'Setup' };
