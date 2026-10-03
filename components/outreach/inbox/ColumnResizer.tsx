'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { cn } from '@/lib/utils';
import { kv } from '@/lib/outreach/storage';

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/** A pane width (px) remembered in this browser; null = the layout's default width. */
export function usePaneWidth(key: string, min: number, max: number) {
  const storageKey = `outreach:inbox:pane:${key}`;
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    try {
      const n = Number(kv.getItem(storageKey));
      // eslint-disable-next-line react-hooks/set-state-in-effect -- restore after mount so the server render matches
      if (n) setWidth(clamp(n, min, max));
    } catch { /* blocked storage: default width */ }
  }, [storageKey, min, max]);
  const save = useCallback((w: number | null) => {
    setWidth(w);
    try { if (w == null) kv.removeItem(storageKey); else kv.setItem(storageKey, String(Math.round(w))); } catch { /* not remembered */ }
  }, [storageKey]);
  return [width, save] as const;
}

/**
 * Vertical drag handle between two columns. `edge` is the side of the pane it sits on:
 * 'right' (pane on the left, dragging right grows it) or 'left' (pane on the right, dragging right shrinks it).
 * Double-click resets to the default width; arrow keys nudge it when focused.
 */
export default function ColumnResizer({ paneRef, edge, min, max, onResize, className }: {
  paneRef: RefObject<HTMLElement | null>;
  edge: 'left' | 'right';
  min: number;
  /** Upper bound, read at drag time so it can depend on the space left for the other columns. */
  max: () => number;
  onResize: (width: number | null) => void;
  className?: string;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; w: number; max: number } | null>(null);
  const dir = edge === 'right' ? 1 : -1;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const pane = paneRef.current;
    if (!pane || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: pane.getBoundingClientRect().width, max: Math.max(min, max()) };
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    onResize(clamp(s.w + (e.clientX - s.x) * dir, min, s.max));
  };
  const end = () => { start.current = null; setDragging(false); };

  // While dragging, keep the resize cursor everywhere and stop text selection in the thread.
  useEffect(() => {
    if (!dragging) return;
    const { cursor, userSelect } = document.body.style;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => { document.body.style.cursor = cursor; document.body.style.userSelect = userSelect; };
  }, [dragging]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const pane = paneRef.current;
    if (!pane) return;
    e.preventDefault();
    const step = (e.shiftKey ? 64 : 16) * (e.key === 'ArrowRight' ? 1 : -1) * dir;
    onResize(clamp(pane.getBoundingClientRect().width + step, min, Math.max(min, max())));
  };

  return (
    <div className={cn('relative w-0 flex-shrink-0 z-10', className)}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize column (double-click to reset)"
        title="Drag to resize · double-click to reset"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={() => onResize(null)}
        onKeyDown={onKeyDown}
        className="group absolute inset-y-0 -left-1.5 w-3 cursor-col-resize touch-none outline-none"
      >
        <div className={cn('mx-auto h-full w-0.5 transition-colors', dragging ? 'bg-blue-500' : 'bg-transparent group-hover:bg-blue-400 group-focus-visible:bg-blue-400')} />
      </div>
    </div>
  );
}
