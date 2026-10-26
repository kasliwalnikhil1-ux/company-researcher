'use client';

import { useCallback, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import AnchoredMenu, { FieldButton, MenuFooter } from './AnchoredMenu';

export type ChipTone = 'gray' | 'green' | 'red' | 'amber' | 'blue' | 'indigo' | 'purple' | 'pink';

export interface SelectOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Set for tag-like options (reply intents): the row and the field then show the same coloured tag as a conversation row. */
  tone?: ChipTone;
  title?: string;
}

const TAG: Record<ChipTone, string> = {
  gray: 'bg-gray-100 text-gray-700', green: 'bg-green-100 text-green-800', red: 'bg-red-100 text-red-800', amber: 'bg-amber-100 text-amber-800',
  blue: 'bg-blue-100 text-blue-800', indigo: 'bg-indigo-100 text-indigo-800', purple: 'bg-purple-100 text-purple-800', pink: 'bg-pink-100 text-pink-800',
};

/** A tag the way the conversation rows draw it (IntentBadge), reused in the dropdown rows and the closed field. */
export function Tag({ tone, children, small }: { tone: ChipTone; children: ReactNode; small?: boolean }) {
  return <span className={cn('inline-flex items-center rounded-full font-medium whitespace-nowrap', small ? 'px-1.5 py-px text-[11px]' : 'px-2 py-0.5 text-xs', TAG[tone])}>{children}</span>;
}

/**
 * A multi-select dropdown: the closed field names what is picked ("Any", one label, "A, B", or "3 channels"), the menu
 * lists every option with a checkbox. A conversation matches when it has any of the picked values.
 */
export default function MultiSelect<T extends string>({ label, options, value, onChange, anyLabel = 'Any', noun, icon }: {
  label: string; options: SelectOption<T>[]; value: T[]; onChange: (next: T[]) => void; anyLabel?: string; /** "channel" → "3 channels", "Showing every channel." */ noun: string; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const anchor = useRef<HTMLDivElement>(null);
  const on = new Set(value);
  const picked = options.filter((o) => on.has(o.value));
  const toggle = (v: T) => onChange(on.has(v) ? value.filter((x) => x !== v) : [...value, v]);
  const plural = (n: number) => `${n} ${noun}${n === 1 ? '' : 's'}`;
  const summary = picked.length === 0 ? anyLabel
    : picked.length > 2 ? plural(picked.length)
      : picked.map((o) => (o.tone ? <Tag key={o.value} tone={o.tone} small>{o.label}</Tag> : <span key={o.value} className="inline-flex items-center gap-1 truncate">{o.icon}{o.label}</span>));

  return (
    <div>
      <span className="block text-[11px] font-medium text-gray-500 mb-1">{label}</span>
      {/* menus open from the field box, not the label above it */}
      <div ref={anchor}><FieldButton label={label} summary={summary} picked={picked.length > 0} icon={icon} open={open} onOpen={() => setOpen((o) => !o)} onClear={() => onChange([])} /></div>
      {open && (
        <AnchoredMenu anchorRef={anchor} onClose={close} label={label} width={240}>
          <div className="py-1 overflow-y-auto" role="listbox" aria-multiselectable="true">
            {options.map((o) => {
              const checked = on.has(o.value);
              return (
                <label key={o.value} title={o.title} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer">
                  <input type="checkbox" checked={checked} onChange={() => toggle(o.value)} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500" />
                  {o.tone ? <Tag tone={o.tone}>{o.label}</Tag> : (<>{o.icon}<span className="truncate text-gray-800">{o.label}</span></>)}
                </label>
              );
            })}
          </div>
          <MenuFooter picked={picked.length} total={options.length} noun={noun} onClear={() => onChange([])} onDone={close} />
        </AnchoredMenu>
      )}
    </div>
  );
}
