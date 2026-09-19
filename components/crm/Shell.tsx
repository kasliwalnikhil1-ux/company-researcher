'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useCrm } from '@/contexts/CrmContext';
import { useGoShortcuts } from './ui';
import { Sunrise, Kanban, Building2, ClipboardCheck, Filter, Settings } from 'lucide-react';

// Five screens + Settings. Resist adding more.
const NAV = [
  { href: '/crm', label: 'Standup', icon: Sunrise, exact: true, key: 's' },
  { href: '/crm/pipeline', label: 'Pipeline', icon: Kanban, key: 'p' },
  { href: '/crm/companies', label: 'Companies', icon: Building2, key: 'c' },
  { href: '/crm/capture', label: 'Capture', icon: ClipboardCheck, key: 'k' },
  { href: '/crm/funnel', label: 'Funnel', icon: Filter, key: 'f' },
  { href: '/crm/settings', label: 'Settings', icon: Settings, key: 't' },
];

const isActive = (pathname: string, n: (typeof NAV)[number]) => (n.exact ? pathname === n.href : pathname.startsWith(n.href));

/** Mobile-only: CRM screens rendered under "Sales CRM" in the main sidebar. */
export function CrmSidebarNav() {
  const pathname = usePathname();
  return (
    <div className="ml-6 pl-3 border-l border-gray-200 space-y-1 py-1">
      {NAV.map((n) => (
        <Link key={n.href} href={n.href} className={cn('flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium', isActive(pathname, n) ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
          <n.icon className="w-4 h-4" />
          {n.label}
        </Link>
      ))}
    </div>
  );
}

export default function CrmShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, timezone } = useCrm();

  const shortcuts = useMemo(() => Object.fromEntries(NAV.map((n) => [n.key, () => router.push(n.href)])), [router]);
  useGoShortcuts(shortcuts);

  return (
    <div className="flex-1 flex flex-col min-h-screen bg-gray-50">
      {/* Desktop top bar. On mobile the CRM screens live under "Sales CRM" in the main sidebar. */}
      <div className="hidden md:block bg-white border-b border-gray-200 px-3 md:px-5">
        <div className="flex items-center gap-3 h-11">
          <nav className="flex items-center gap-0.5 overflow-x-auto flex-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} title={`g ${n.key}`} className={cn('flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-sm font-medium whitespace-nowrap', isActive(pathname, n) ? 'bg-indigo-50 text-indigo-700' : 'text-gray-600 hover:bg-gray-50')}>
                <n.icon className="w-4 h-4" />
                {n.label}
              </Link>
            ))}
          </nav>
          <div className="text-xs text-gray-500 whitespace-nowrap">{me?.display_name} · {timezone}</div>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        <div className="px-3 md:px-5 py-3 max-w-[1700px] mx-auto w-full">{children}</div>
      </div>
    </div>
  );
}
