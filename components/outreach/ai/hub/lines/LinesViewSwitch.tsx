'use client';

import Link from '@/lib/outreach/nav';
import { FEATURE_LABEL, hubHref } from '@/lib/outreach/aiHub';
import { tabClass, tabStripClass } from '@/components/ui/Tabs';

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
      <nav aria-label="Views of Personalized lines" className={tabStripClass}>
        {items.map((i) => (
          <Link key={i.id} href={i.href} aria-current={view === i.id ? 'page' : undefined} className={tabClass(view === i.id)}>
            {i.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
