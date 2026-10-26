'use client';

import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/** Marks a menu (and its backdrop) so the Filters popover's outside-click handler leaves clicks inside them alone. */
export const MENU_ATTR = 'data-inbox-filter-menu';

/**
 * A dropdown menu rendered in a portal, fixed under its field. The Filters popover scrolls and clips its content, so a
 * menu positioned inside it would be cut off; this one floats above everything, is kept inside the viewport, and closes
 * when the page scrolls or resizes (its position would be stale) or on Escape / a click on the backdrop.
 */
export default function AnchoredMenu({ anchorRef, onClose, width = 'anchor', maxHeight = 384, label, children, className }: {
  anchorRef: RefObject<HTMLElement | null>; onClose: () => void; width?: number | 'anchor'; maxHeight?: number; label: string; children: ReactNode; className?: string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  // `top` when the menu opens downwards, `bottom` (distance from the viewport's bottom edge) when it opens upwards, so an
  // upward menu hugs its field whatever its real height is
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; width: number; maxH: number } | null>(null);

  useLayoutEffect(() => {
    const el = anchorRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.min(width === 'anchor' ? r.width : Math.max(width, r.width), window.innerWidth - 16);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 8 - w));
    const below = window.innerHeight - r.bottom - 12;
    // not enough room under the field: open upwards from it
    const up = below < 200 && r.top > below;
    const maxH = Math.max(160, Math.min(maxHeight, up ? r.top - 12 : below));
    setPos(up ? { bottom: window.innerHeight - r.top + 4, left, width: w, maxH } : { top: r.bottom + 4, left, width: w, maxH });
    const onScroll = (e: Event) => { if (e.target instanceof Node && menuRef.current?.contains(e.target)) return; onClose(); };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', onClose); };
  }, [anchorRef, onClose, width, maxHeight]);

  if (typeof document === 'undefined' || !pos) return null;
  const attr = { [MENU_ATTR]: '' };
  return createPortal(
    <>
      <div {...attr} className="fixed inset-0 z-40" onMouseDown={(e) => { e.stopPropagation(); onClose(); }} />
      <div {...attr} ref={menuRef} role="dialog" aria-label={label} style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, width: pos.width, maxHeight: pos.maxH }}
        className={cn('z-50 bg-white border border-gray-200 rounded-lg shadow-lg flex flex-col', className)}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
        {children}
      </div>
    </>,
    document.body,
  );
}

/** The closed field of a filter dropdown: label above, summary inside, a clear cross when something is picked, a chevron. */
export function FieldButton({ label, summary, picked, icon, onOpen, onClear, open, title }: {
  label: string; summary: ReactNode; picked: boolean; icon?: ReactNode; onOpen: () => void; onClear: () => void; open: boolean; title?: string;
}) {
  return (
    // "Filter by reply intent", but an acronym label ("AI replies") keeps its case
    <button type="button" onClick={onOpen} aria-haspopup="dialog" aria-expanded={open} title={title ?? `Filter by ${label.slice(1) === label.slice(1).toLowerCase() ? label.toLowerCase() : label}`}
      className={cn('w-full inline-flex items-center gap-2 text-sm rounded-md border bg-white px-2 py-1.5 text-left focus:outline-none focus:ring-2 focus:ring-indigo-500', picked ? 'border-indigo-300 text-gray-900' : 'border-gray-200 text-gray-600')}>
      {icon}
      <span className="flex-1 min-w-0 flex items-center gap-1.5 truncate">{summary}</span>
      {picked && (
        <span role="button" tabIndex={0} aria-label={`Clear ${label} filter`} title={`Clear ${label} filter`}
          onClick={(e) => { e.stopPropagation(); onClear(); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onClear(); } }}
          className="p-0.5 rounded-full text-gray-400 hover:text-gray-700 hover:bg-gray-100 flex-shrink-0">
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </span>
      )}
      <svg viewBox="0 0 24 24" className="w-4 h-4 text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
    </button>
  );
}

/** The menu's footer: what is picked, Clear, Done. */
export function MenuFooter({ picked, total, noun, onClear, onDone }: { picked: number; total: number; noun: string; onClear: () => void; onDone: () => void }) {
  return (
    <div className="border-t border-gray-100 px-3 py-2 flex items-center gap-2 whitespace-nowrap">
      <p className="text-[11px] text-gray-500 flex-1 min-w-0 truncate tabular-nums">{picked === 0 ? `Every ${noun}` : `${picked} of ${total} picked`}</p>
      {picked > 0 && <button type="button" onClick={onClear} className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded-md hover:bg-gray-100 flex-shrink-0">Clear</button>}
      <button type="button" onClick={onDone} className="text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 px-2.5 py-1 rounded-md flex-shrink-0">Done</button>
    </div>
  );
}
