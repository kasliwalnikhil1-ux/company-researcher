'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** What the menu asks for: the rows of this page, every lead under the current filters, the first `count` of them, or nothing. */
export type SelectionRequest = { kind: 'page' } | { kind: 'all' } | { kind: 'first'; count: number } | { kind: 'none' };

const MENU_WIDTH = 248;

/**
 * The checkbox in the header of the leads table. It does not tick the page by itself: it opens a menu to select this page, every
 * lead that matches the filters, or a number of leads counted from the top of the list.
 */
export function SelectionMenu({ pageRows, total, selectedCount, allOnPage, someOnPage, busy, onSelect }: {
  /** Leads on this page, and under the current filters. */
  pageRows: number; total: number;
  selectedCount: number; allOnPage: boolean; someOnPage: boolean;
  /** True while the ids of a selection are being collected. */
  busy?: boolean;
  onSelect: (req: SelectionRequest) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [count, setCount] = useState('');
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ top: r.bottom + 6, left: Math.max(8, Math.min(r.left, window.innerWidth - MENU_WIDTH - 8)) });
  };
  const toggle = () => { if (open) setOpen(false); else { place(); setOpen(true); } };
  const close = () => { setOpen(false); buttonRef.current?.focus(); };
  const pick = (req: SelectionRequest) => { onSelect(req); close(); };

  const n = Math.floor(Number(count));
  const validCount = count.trim() !== '' && Number.isFinite(n) && n >= 1;
  const apply = () => { if (validCount) pick({ kind: 'first', count: Math.min(n, total) }); };

  useLayoutEffect(() => { if (open) panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { const t = e.target as Node; if (!panelRef.current?.contains(t) && !triggerRef.current?.contains(t)) setOpen(false); };
    const onScroll = (e: Event) => { if (!panelRef.current?.contains(e.target as Node)) place(); };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onScroll, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('resize', place); window.removeEventListener('scroll', onScroll, true); };
  }, [open]);

  const item = 'w-full text-left px-3 py-2 text-sm text-gray-800 rounded-md hover:bg-gray-100 focus:outline-none focus-visible:bg-gray-100';

  const panel = open && pos && typeof document !== 'undefined' ? createPortal(
    <div ref={panelRef} id={`${id}-menu`} role="menu" aria-label="Select leads" style={{ position: 'fixed', top: pos.top, left: pos.left, width: MENU_WIDTH }}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } }}
      className="z-[70] rounded-xl border border-gray-200 bg-white shadow-xl p-1.5">
      <button type="button" role="menuitem" className={item} onClick={() => pick({ kind: 'page' })}>Select this page <span className="text-gray-500">({pageRows.toLocaleString()})</span></button>
      <button type="button" role="menuitem" className={item} onClick={() => pick({ kind: 'all' })}>Select all <span className="text-gray-500">({total.toLocaleString()})</span></button>
      <button type="button" role="menuitem" aria-expanded={advanced} aria-controls={`${id}-advanced`} className={cn(item, 'flex items-center justify-between font-medium')} onClick={() => setAdvanced((a) => !a)}>
        Advanced selection {advanced ? <ChevronUp className="w-4 h-4 text-gray-500" /> : <ChevronDown className="w-4 h-4 text-gray-500" />}
      </button>
      {advanced && (
        <div id={`${id}-advanced`} className="px-3 pt-1 pb-2 space-y-2">
          <label className="flex items-center justify-between gap-3 text-sm text-gray-800">
            <span>Number of leads</span>
            <input type="number" inputMode="numeric" min={1} max={total} step={1} value={count} placeholder="10" autoFocus
              onChange={(e) => setCount(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
              className="w-24 px-2.5 py-1.5 text-sm rounded-lg border border-gray-300 bg-white text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500" />
          </label>
          <p className="text-xs text-gray-500">Counted from the top of the list, first page first.</p>
          <button type="button" onClick={apply} disabled={!validCount} className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed">Apply</button>
        </div>
      )}
      {selectedCount > 0 && (
        <>
          <div className="my-1 border-t border-gray-100" />
          <button type="button" role="menuitem" className={item} onClick={() => pick({ kind: 'none' })}>Clear selection <span className="text-gray-500">({selectedCount.toLocaleString()})</span></button>
        </>
      )}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <div ref={triggerRef} className="flex items-center gap-0.5">
        {busy ? <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" aria-label="Selecting leads" /> : (
          // The box shows the state and opens the menu on a click; the button next to it is the menu's trigger for keyboard and screen readers.
          <input ref={(el) => { if (el) el.indeterminate = !allOnPage && (someOnPage || selectedCount > 0); }} type="checkbox" tabIndex={-1} aria-hidden
            checked={allOnPage} onChange={toggle} className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer" />
        )}
        <button ref={buttonRef} type="button" aria-label="Select leads" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} onClick={toggle} disabled={busy}
          className="rounded text-gray-400 hover:text-gray-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"><ChevronDown className="w-3 h-3" /></button>
      </div>
      {panel}
    </>
  );
}
