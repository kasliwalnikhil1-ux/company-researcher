'use client';

// Second-level switch inside Senders: the account list, and Profiles (changes, templates, experiments, insights that
// span senders). Profile Studio has no entry of its own in the main navigation on purpose.
import Link from '@/lib/outreach/nav';
import { usePathname } from '@/lib/outreach/nav';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/outreach/senders', label: 'Accounts', exact: true },
  { href: '/outreach/senders/profiles', label: 'Profiles', exact: false },
];

export function SendersSubnav() {
  const pathname = usePathname();
  return (
    <div className="border-b border-gray-200 mb-4">
      <nav className="flex gap-1 -mb-px overflow-x-auto [scrollbar-width:none]" role="tablist" aria-label="Senders sections">
        {ITEMS.map((i) => {
          const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
          return <Link key={i.href} href={i.href} role="tab" aria-selected={active} className={cn('px-3.5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 transition-colors', active ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>{i.label}</Link>;
        })}
      </nav>
    </div>
  );
}
