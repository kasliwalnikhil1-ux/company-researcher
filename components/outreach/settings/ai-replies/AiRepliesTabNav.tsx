'use client';

import { cn } from '@/lib/utils';
import { AI_TABS, type AiTab } from './format';

/** Second-level tabs of Settings → AI replies. The selection lives in the URL (`?tab=`). */
export default function AiRepliesTabNav({ tab, onSelect }: { tab: AiTab; onSelect: (t: AiTab) => void }) {
  return (
    <div className="border-b border-gray-200">
      <nav className="flex flex-wrap gap-1 -mb-px" role="tablist" aria-label="AI replies sections">
        {AI_TABS.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => onSelect(t.key)}
            className={cn('px-3 py-2 text-sm font-medium border-b-2 whitespace-nowrap',
              tab === t.key ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-gray-500 hover:text-gray-800')}>
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
