'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Building2, ExternalLink } from 'lucide-react';
import { useWorkspace } from '@/contexts/OutreachWorkspaceContext';
import { cn } from '@/lib/utils';

const TABS: Array<{ href: string; label: string; owner?: boolean; manager?: boolean; external?: boolean }> = [
  { href: '/outreach/settings/workspace', label: 'Workspace' },
  { href: '/outreach/settings/members', label: 'Members', owner: true },
  { href: '/outreach/settings/billing', label: 'Billing', owner: true },
  { href: '/outreach/settings/webhooks', label: 'Webhooks', owner: true },
  { href: '/outreach/settings/suppressions', label: 'Suppressions' },
  { href: '/outreach/settings/safety', label: 'Safety' },
  { href: '/outreach/clients', label: 'Clients', manager: true, external: true },
];

export default function SettingsTabs() {
  const pathname = usePathname();
  const { isOwner, isManager } = useWorkspace();
  return (
    <div className="border-b border-gray-200 mb-6 overflow-x-auto">
      <nav className="flex gap-1 -mb-px" aria-label="Settings sections">
        {TABS.filter((t) => (!t.owner || isOwner) && (!t.manager || isManager)).map((t) => {
          const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <Link key={t.href} href={t.href} className={cn('inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
              {t.external && <Building2 className="w-3.5 h-3.5" />}{t.label}{t.external && <ExternalLink className="w-3 h-3 text-gray-400" />}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
