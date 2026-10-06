'use client';

// Small pieces shared by the screens of AI → Setup.
import Link from '@/lib/outreach/nav';
import { HUB_MODES, HUB_MODE_LABEL, type HubMode } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

export const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** Title and one line of a Setup sub-page (AI replies, Website agents, General). */
export function SetupHeading({ title, help }: { title: string; help?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      {help && <p className="text-sm text-gray-500 mt-0.5">{help}</p>}
    </div>
  );
}

/** A link that looks like the small secondary Button of ui.tsx. */
export function LinkButton({ href, children, className, ariaLabel }: { href: string; children: React.ReactNode; className?: string; ariaLabel?: string }) {
  return (
    <Link href={href} aria-label={ariaLabel}
      className={cn('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors whitespace-nowrap px-2.5 py-1.5 text-xs bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', className)}>
      {children}
    </Link>
  );
}

/** "5 need you": opens Needs you filtered to one place. Renders `none` when nothing waits. */
export function NeedsYouLink({ n, href, none = 'Nothing waiting' }: { n: number | null | undefined; href: string; none?: string }) {
  const count = n ?? 0;
  if (count <= 0) return <span className="text-xs text-gray-400">{none}</span>;
  return <Link href={href} className="text-sm font-medium text-indigo-700 hover:underline whitespace-nowrap">{count.toLocaleString()} {count === 1 ? 'needs' : 'need'} you</Link>;
}

/** Second-level tabs of a Setup sub-page. The selection lives in the URL, so each tab is a link. */
export function SubTabs<K extends string>({ items, active, label }: { items: Array<{ key: K; label: string; href: string }>; active: K; label: string }) {
  return (
    <div className="border-b border-gray-200">
      <nav className="flex gap-1 -mb-px overflow-x-auto [scrollbar-width:none]" aria-label={label}>
        {items.map((t) => (
          <Link key={t.key} href={t.href} scroll={false} aria-current={active === t.key ? 'page' : undefined}
            className={cn('px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap', active === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** What Off, Review and Auto mean for one feature. A compact switch in a table row has no line of its own, so the table carries this once. */
export function ModeLegend({ lines, className }: { lines: Record<HubMode, string>; className?: string }) {
  return (
    <dl className={cn('text-xs text-gray-500 space-y-0.5', className)}>
      {HUB_MODES.map((m) => (
        <div key={m} className="flex gap-1.5">
          <dt className="font-medium text-gray-700 w-12 flex-shrink-0">{HUB_MODE_LABEL[m]}</dt>
          <dd className="min-w-0">{lines[m]}</dd>
        </div>
      ))}
    </dl>
  );
}
