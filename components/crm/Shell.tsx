'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useCrm } from '@/contexts/CrmContext';
import { useSidebarCollapsed } from '@/contexts/SidebarContext';
import { useGoShortcuts } from './ui';
import { Sunrise, Kanban, Building2, ClipboardCheck, Filter, Settings, GraduationCap } from 'lucide-react';

// Six screens + Settings. Resist adding more. (Sales Coach = every coached call + what repeats across them.)
const NAV = [
  { href: '/crm', label: 'Standup', icon: Sunrise, exact: true, key: 's' },
  { href: '/crm/pipeline', label: 'Pipeline', icon: Kanban, key: 'p' },
  { href: '/crm/companies', label: 'Companies', icon: Building2, key: 'c' },
  { href: '/crm/coach', label: 'Sales Coach', icon: GraduationCap, key: 'o' },
  { href: '/crm/capture', label: 'Capture', icon: ClipboardCheck, key: 'k' },
  { href: '/crm/funnel', label: 'Funnel', icon: Filter, key: 'f' },
  { href: '/crm/settings', label: 'Settings', icon: Settings, key: 't' },
];

const isActive = (pathname: string, n: (typeof NAV)[number]) => (n.exact ? pathname === n.href : pathname.startsWith(n.href));

/** CRM screens rendered under "Sales CRM" in the main sidebar. */
export function CrmSidebarNav() {
  const pathname = usePathname();
  const collapsed = useSidebarCollapsed();
  const { me, timezone } = useCrm();

  if (collapsed) {
    return (
      <div className="space-y-1 py-1 border-y border-gray-100">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} title={`${n.label} (g ${n.key})`} aria-label={n.label} aria-current={isActive(pathname, n) ? 'page' : undefined}
            className={cn('flex items-center justify-center py-2 rounded-lg', isActive(pathname, n) ? 'bg-indigo-50 text-indigo-700' : 'text-gray-500 hover:bg-gray-50')}>
            <n.icon className="w-4 h-4" />
          </Link>
        ))}
      </div>
    );
  }

  return (
    <div className="ml-6 pl-3 border-l border-gray-200 space-y-1 py-1">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} title={`g ${n.key}`} aria-current={isActive(pathname, n) ? 'page' : undefined} className={cn('flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium', isActive(pathname, n) ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
          <n.icon className="w-4 h-4" />
          {n.label}
        </Link>
      ))}
      {me && <div className="px-3 pt-1 text-xs text-gray-500 truncate" title={`${me.display_name} · ${timezone}`}>{me.display_name} · {timezone}</div>}
    </div>
  );
}

export default function CrmShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  const shortcuts = useMemo(() => Object.fromEntries(NAV.map((n) => [n.key, () => router.push(n.href)])), [router]);
  useGoShortcuts(shortcuts);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      {/* The CRM screens live under "Sales CRM" in the main sidebar. */}
      <div className="flex-1 overflow-auto">
        <div className="px-3 md:px-5 py-3 max-w-[1700px] mx-auto w-full">{children}</div>
      </div>
    </div>
  );
}
