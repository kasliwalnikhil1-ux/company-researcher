'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Underline tabs: switch between sections of a page (Instructions · Settings · Activity, Sources · Q&A). They never
 * change data. A choice of value (Off · Review · Auto, Open / Completed, 30 days) is a segmented toggle instead: boxed
 * white track, indigo-50 pill on the selected option.
 *
 * The strip's rule is an inset shadow, not a border, so the active tab's 2px underline sits on it while the strip
 * scrolls sideways (a -mb-px tab under overflow-x-auto gets clipped).
 */
export const tabStripClass = 'flex gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] shadow-[inset_0_-1px_0_theme(colors.gray.200)]';

export function tabClass(active: boolean, fill = false) {
  return cn(
    'inline-flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-40',
    fill && 'flex-1 justify-center',
    active ? 'border-indigo-600 text-indigo-700 font-medium' : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-800',
  );
}

/** Button tabs. For tabs that are links (their own URL), render `<nav className={tabStripClass}>` with `tabClass` on each link. */
export function Tabs<T extends string>({ value, onChange, items, label, fill, disabled, className }: {
  value: T;
  onChange: (v: T) => void;
  items: Array<{ value: T; label: ReactNode; title?: string; disabled?: boolean }>;
  label: string;
  /** Tabs share the full width (narrow columns such as the inbox list). */
  fill?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn(tabStripClass, className)}>
      {items.map((t) => (
        <button key={t.value} type="button" role="tab" aria-selected={value === t.value} title={t.title} disabled={disabled || t.disabled}
          onClick={() => value !== t.value && onChange(t.value)} className={tabClass(value === t.value, fill)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
