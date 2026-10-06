'use client';

import Link from '@/lib/outreach/nav';
import { usePathname } from '@/lib/outreach/nav';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { HUB_TABS, hubHref, useNeedsYouCounts } from '@/lib/outreach/aiHub';
import { BackLink, ErrorBox, PageHeader, PageLoader } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';
import type { Role } from '@/lib/outreach/types';
import { roleAtLeast } from '@/components/outreach/settings/SettingsTabs';

/**
 * Needs you · Activity · Knowledge · Setup: the sections of the AI hub (the sidebar has one "AI" item).
 * Under the bar sits one helper line, as on Settings: `helper` when the page gives one, else the open tab's blurb.
 */
export function HubTabs({ helper }: { helper?: React.ReactNode }) {
  const pathname = usePathname();
  const { workspace } = useWorkspace();
  const counts = useNeedsYouCounts(workspace?.id);
  const n = counts.data?.total ?? 0;
  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const line = helper ?? HUB_TABS.find((t) => isActive(t.href))?.blurb;
  return (
    <div className="mb-6">
      <div className="border-b border-gray-200">
        <nav className="flex gap-1 -mb-px overflow-x-auto [scrollbar-width:none]" aria-label="AI sections">
          {HUB_TABS.map((t) => {
            const active = isActive(t.href);
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
      {line && <p className="mt-3 text-sm text-gray-500">{line}</p>}
    </div>
  );
}

/**
 * Page frame shared by every screen of the AI hub: header, the four tabs and the role gate.
 * `subtitle` is the helper line under the tabs for a sub-page; the four tab pages leave it out and get the tab's blurb.
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
      <PageHeader title="AI" subtitle={workspace.name} actions={allowed ? actions : undefined} />
      <HubTabs helper={subtitle} />
      {back && allowed && <BackLink href={back.href} className="mb-4">{back.label}</BackLink>}
      {allowed ? children : <ErrorBox message={role === 'client_viewer' ? 'The AI pages are not available for client viewers.' : min === 'manager' ? 'Only owners and managers can open this page.' : 'Only workspace members can open this page.'} />}
    </div>
  );
}

export const SETUP_BACK = { href: hubHref.setup(), label: 'Setup' };
