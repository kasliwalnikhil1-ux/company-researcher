'use client';

import { useCallback, useRef, useState } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import AnchoredMenu, { FieldButton } from './AnchoredMenu';

/** YYYY-MM-DD of a date in the browser's timezone (the filter stores calendar days, the query turns them into bounds). */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const daysAgo = (n: number) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return ymd(d); };

/** Quick ranges: each ends today and starts `days - 1` days earlier, so "Last 7 days" is today plus the six days before. */
const QUICK: { label: string; days: number }[] = [{ label: 'Today', days: 1 }, { label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }, { label: 'Last 90 days', days: 90 }];

/** Formats a stored range for the field and the active-filter chip: "19 Oct – 26 Oct", "from 1 Oct", "until 26 Oct". */
export function fmtReplyRange(from: string | null | undefined, to: string | null | undefined): string {
  const f = (s: string) => new Date(`${s}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (from && to) return from === to ? f(from) : `${f(from)} – ${f(to)}`;
  if (from) return `from ${f(from)}`;
  if (to) return `until ${f(to)}`;
  return '';
}

/**
 * The inbox's Reply date filter, a dropdown: the day their latest reply came in. Quick ranges fill the From / To days;
 * either end can be left open. The value is calendar days, so the query key (and the cache) stays put between renders.
 */
export default function ReplyDateRange({ from, to, onChange }: { from: string | null; to: string | null; onChange: (next: { replied_from: string | null; replied_to: string | null }) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const anchor = useRef<HTMLDivElement>(null);
  const today = ymd(new Date());
  const quick = QUICK.find((qk) => from === daysAgo(qk.days - 1) && to === today);
  const set = (f: string | null, t: string | null) => onChange({ replied_from: f, replied_to: t });
  const picked = !!(from || to);
  const summary = !picked ? 'Any time' : quick ? quick.label : fmtReplyRange(from, to);
  const row = 'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left hover:bg-gray-50';

  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="block text-[11px] font-medium text-gray-500">Reply date</span>
        <span className="text-[10px] text-gray-400">When they last replied</span>
      </div>
      {/* menus open from the field box, not the label above it */}
      <div ref={anchor}><FieldButton label="Reply date" summary={summary} picked={picked} icon={<CalendarDays className="w-4 h-4 text-gray-400 flex-shrink-0" />} open={open} onOpen={() => setOpen((o) => !o)} onClear={() => set(null, null)} /></div>
      {open && (
        <AnchoredMenu anchorRef={anchor} onClose={close} label="Reply date">
          <div className="py-1" role="radiogroup" aria-label="Reply date">
            <button type="button" role="radio" aria-checked={!picked} onClick={() => { set(null, null); close(); }} className={cn(row, !picked && 'text-indigo-700 font-medium')}>
              <span className="w-4 flex-shrink-0">{!picked && <Check className="w-4 h-4" />}</span>Any time
            </button>
            {QUICK.map((qk) => {
              const on = quick?.days === qk.days;
              return (
                <button key={qk.days} type="button" role="radio" aria-checked={on} onClick={() => { set(daysAgo(qk.days - 1), today); close(); }} title={qk.days === 1 ? 'Replied today' : `Replied in the last ${qk.days} days`} className={cn(row, on && 'text-indigo-700 font-medium')}>
                  <span className="w-4 flex-shrink-0">{on && <Check className="w-4 h-4" />}</span>{qk.label}
                </button>
              );
            })}
          </div>
          <div className="border-t border-gray-100 px-3 py-2 space-y-1.5">
            <p className="text-[11px] font-medium text-gray-500">Custom range</p>
            <div className="flex items-center gap-1.5 text-xs">
              <input type="date" aria-label="Replied from" value={from ?? ''} max={to ?? today} onChange={(e) => set(e.target.value || null, to)}
                className={cn('min-w-0 flex-1 rounded-md border px-1.5 py-1 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500', from ? 'border-indigo-300' : 'border-gray-200')} />
              <span className="text-gray-400">to</span>
              <input type="date" aria-label="Replied until" value={to ?? ''} min={from ?? undefined} max={today} onChange={(e) => set(from, e.target.value || null)}
                className={cn('min-w-0 flex-1 rounded-md border px-1.5 py-1 text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500', to ? 'border-indigo-300' : 'border-gray-200')} />
            </div>
            <div className="flex justify-end">
              <button type="button" onClick={close} className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1 rounded-md">Done</button>
            </div>
          </div>
        </AnchoredMenu>
      )}
    </div>
  );
}
