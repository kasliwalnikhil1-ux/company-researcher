'use client';

import { HUB_MODES, HUB_MODE_LABEL, type HubMode } from '@/lib/outreach/aiHub';
import { cn } from '@/lib/utils';

/**
 * The mode control of every AI feature: a three-way switch (Off · Review · Auto) with one line underneath that explains
 * the selected mode. It looks the same for Replies, Personalized lines and the Website assistant.
 *
 *   lines      the explanation per mode (lib/outreach/aiHub.ts MODE_LINE)
 *   locked     modes that cannot be picked here, with the reason shown as the button's tooltip
 *   compact    no line underneath (table rows); the line is then the tooltip of each button
 */
export default function ModeSwitch({ value, onChange, lines, locked, disabled, busy, compact, label, className }: {
  value: HubMode; onChange: (m: HubMode) => void; lines: Record<HubMode, string>;
  locked?: Partial<Record<HubMode, string>>; disabled?: boolean; busy?: boolean; compact?: boolean; label: string; className?: string;
}) {
  return (
    <div className={cn(compact ? 'inline-flex' : 'space-y-1.5', className)}>
      <div role="radiogroup" aria-label={label} className={cn('inline-flex rounded-lg border border-gray-300 p-0.5 bg-gray-50', busy && 'opacity-70')}>
        {HUB_MODES.map((m) => {
          const on = value === m;
          const why = locked?.[m];
          const off = disabled || busy || (!!why && !on);
          return (
            <button key={m} type="button" role="radio" aria-checked={on} disabled={off} title={why && !on ? why : lines[m]}
              onClick={() => { if (!on && !off) onChange(m); }}
              className={cn('rounded-md transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500', compact ? 'px-2.5 py-0.5 text-xs' : 'px-3.5 py-1 text-sm',
                on ? (m === 'auto' ? 'bg-green-600 text-white shadow-sm font-medium' : m === 'review' ? 'bg-indigo-600 text-white shadow-sm font-medium' : 'bg-white text-gray-700 shadow-sm font-medium')
                   : 'text-gray-600 hover:text-gray-900',
                off && !on && 'cursor-not-allowed', why && !on && 'opacity-50 hover:text-gray-600')}>
              {HUB_MODE_LABEL[m]}
            </button>
          );
        })}
      </div>
      {!compact && <p className="text-xs text-gray-500">{lines[value]}</p>}
    </div>
  );
}
