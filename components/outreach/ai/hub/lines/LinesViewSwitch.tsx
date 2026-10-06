'use client';

import Link from '@/lib/outreach/nav';
import { FEATURE_LABEL, hubHref } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

export type LinesView = 'variables' | 'lines';

/** The heading of AI → Setup → Personalized lines with its two views: the variables, and every line they wrote. */
export default function LinesViewSwitch({ view }: { view: LinesView }) {
  const items: Array<{ id: LinesView; label: string; href: string }> = [
    { id: 'variables', label: 'Variables', href: hubHref.setupLines() },
    { id: 'lines', label: 'All lines', href: hubHref.setupLines('lines') },
  ];
  return (
    <div className="flex flex-wrap items-center gap-3">
      <h2 className="text-base font-semibold text-gray-900">{FEATURE_LABEL.line}</h2>
      <nav aria-label="Views of Personalized lines" className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5">
        {items.map((i) => (
          <Link key={i.id} href={i.href} aria-current={view === i.id ? 'page' : undefined}
            className={cn('rounded-md px-3 py-1 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', view === i.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-50')}>
            {i.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
