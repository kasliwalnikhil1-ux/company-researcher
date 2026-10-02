'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { useLocalhostOnly } from '@/lib/outreach/platformAdmin';
import { cn } from '@/lib/utils';
import type { Role } from '@/lib/outreach/types';

const ROLE_RANK: Record<Role, number> = { owner: 0, manager: 1, member: 2, client_viewer: 3 };
export function roleAtLeast(role: Role | null, min: Role): boolean { return !!role && ROLE_RANK[role] <= ROLE_RANK[min]; }

/**
 * `min` is the lowest role that can use the page. `also` lists sibling routes that keep the tab active.
 * `localOnly` tabs render only when the app runs on localhost (platform admin; see lib/outreach/platformAdmin.ts).
 */
export const SETTINGS_TABS: Array<{ href: string; label: string; min: Role; also?: string[]; localOnly?: boolean }> = [
  { href: '/outreach/settings/workspace', label: 'Workspace', min: 'member' },
  { href: '/outreach/settings/members', label: 'Members', min: 'owner' },
  { href: '/outreach/settings/safety', label: 'Safety', min: 'member' },
  { href: '/outreach/settings/suppressions', label: 'Blacklists', min: 'member' },
  { href: '/outreach/settings/notifications', label: 'Notifications', min: 'client_viewer' },
  { href: '/outreach/settings/email', label: 'Email & booking', min: 'manager' },
  { href: '/outreach/settings/integrations', label: 'Integrations', min: 'manager', also: ['/outreach/settings/api', '/outreach/settings/webhooks'] },
  { href: '/outreach/settings/branding', label: 'White-label', min: 'owner' },
  { href: '/outreach/settings/admin', label: 'Admin', min: 'member', localOnly: true },
];

export default function SettingsTabs() {
  const pathname = usePathname();
  const { role } = useWorkspace();
  const local = useLocalhostOnly();
  const on = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  return (
    <div className="border-b border-gray-200 mb-6">
      <nav className="flex flex-wrap gap-1 -mb-px" aria-label="Settings sections">
        {SETTINGS_TABS.filter((t) => roleAtLeast(role, t.min) && (!t.localOnly || local)).map((t) => {
          const active = on(t.href) || (t.also ?? []).some(on);
          return (
            <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
              className={cn('inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Second-level switch between the three parts of "Integrations": connected apps, API keys and webhooks. */
export function IntegrationsSubTabs() {
  const pathname = usePathname();
  const items = [{ href: '/outreach/settings/integrations', label: 'Connected apps' }, { href: '/outreach/settings/api', label: 'API keys' }, { href: '/outreach/settings/webhooks', label: 'Webhooks' }];
  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 mb-5" role="tablist" aria-label="Integrations sections">
      {items.map((i) => {
        const active = pathname === i.href;
        return <Link key={i.href} href={i.href} role="tab" aria-selected={active} className={cn('px-3 py-1.5 text-sm font-medium rounded-md', active ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>{i.label}</Link>;
      })}
    </div>
  );
}
