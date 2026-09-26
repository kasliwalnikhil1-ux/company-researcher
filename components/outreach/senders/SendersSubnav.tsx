'use client';

// Second-level switch inside Senders: the account list, and Profiles (changes, templates, experiments, insights that
// span senders). Profile Studio has no entry of its own in the main navigation on purpose.
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/outreach/senders', label: 'Accounts', exact: true },
  { href: '/outreach/senders/profiles', label: 'Profiles', exact: false },
];

export function SendersSubnav() {
  const pathname = usePathname();
  return (
    <div className="flex flex-wrap gap-1 border-b border-gray-200 mb-4" role="tablist" aria-label="Senders sections">
      {ITEMS.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
        return <Link key={i.href} href={i.href} role="tab" aria-selected={active} className={cn('px-3.5 py-2.5 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors', active ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-800')}>{i.label}</Link>;
      })}
    </div>
  );
}
