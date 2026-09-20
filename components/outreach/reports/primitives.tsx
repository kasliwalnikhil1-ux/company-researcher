'use client';

import React, { useCallback, useId, useRef, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, ArrowUpDown, ChevronDown, ChevronUp, Download, Minus, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button, Th } from '@/components/outreach/ui';
import { useMetricDefinitions, type Change } from '@/lib/outreach/reports';

/** Accent colour. The client portal overrides --outreach-accent with the workspace's brand colour. */
export const ACCENT = 'var(--outreach-accent, #4f46e5)';
export const ACCENT_SOFT = 'color-mix(in srgb, var(--outreach-accent, #4f46e5) 14%, white)';

// ---------------------------------------------------------------------------
// Tooltip that is not clipped by scrolling tables (fixed position, keyboard reachable)
// ---------------------------------------------------------------------------
export function InfoTip({ text, children, className }: { text?: string | null; children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = useCallback(() => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < 120;
    const x = Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150);
    setPos({ x, y: below ? r.bottom + 6 : r.top - 6, below });
  }, []);
  const hide = useCallback(() => setPos(null), []);
  if (!text) return <span className={className}>{children}</span>;
  return (
    <span ref={ref} tabIndex={0} aria-describedby={pos ? id : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
      className={cn('cursor-help underline decoration-dotted decoration-gray-300 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 rounded-sm', className)}>
      {children}
      {pos && (
        <span id={id} role="tooltip" style={{ left: pos.x, top: pos.y, transform: `translate(-50%, ${pos.below ? '0' : '-100%'})` }}
          className="fixed z-[70] w-72 max-w-[90vw] rounded-lg bg-gray-900 px-3 py-2 text-xs font-normal normal-case tracking-normal leading-relaxed text-white shadow-lg pointer-events-none whitespace-normal text-left">
          {text}
        </span>
      )}
    </span>
  );
}

/** A metric name with its definition from outreach_metric_definitions(). */
export function MetricLabel({ metric, children, className }: { metric: string; children: React.ReactNode; className?: string }) {
  const defs = useMetricDefinitions();
  return <InfoTip text={defs.data?.[metric]} className={className}>{children}</InfoTip>;
}

// ---------------------------------------------------------------------------
// Headline tile
// ---------------------------------------------------------------------------
export function ChangeChip({ change, goodWhenUp = true, versus }: { change: Change; goodWhenUp?: boolean; versus?: string }) {
  if (change.direction === 'none') return <span className="text-xs text-gray-400">{change.text}</span>;
  const good = change.direction === 'flat' ? null : (change.direction === 'up') === goodWhenUp;
  const Icon = change.direction === 'up' ? ArrowUpRight : change.direction === 'down' ? ArrowDownRight : Minus;
  const word = change.direction === 'up' ? 'Up' : change.direction === 'down' ? 'Down' : 'No change';
  return (
    <span className="inline-flex items-center gap-1 text-xs text-gray-500">
      <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', good === null ? 'text-gray-500' : good ? 'text-green-700' : 'text-red-700')}>
        <Icon className="w-3.5 h-3.5" aria-hidden /><span className="sr-only">{word}</span>{change.text}
      </span>
      {versus && <span className="text-gray-400">{versus}</span>}
    </span>
  );
}

export function KpiTile({ label, metric, value, sub, change, goodWhenUp, versus, onClick }: {
  label: string; metric?: string; value: string; sub?: React.ReactNode; change?: Change; goodWhenUp?: boolean; versus?: string; onClick?: () => void;
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3.5 min-w-0">
      <div className="text-xs font-medium text-gray-500">{metric ? <MetricLabel metric={metric}>{label}</MetricLabel> : label}</div>
      <div className="mt-1 text-2xl font-semibold text-gray-900 leading-tight">
        {onClick ? <button type="button" onClick={onClick} className="hover:underline decoration-gray-300 underline-offset-4 text-left">{value}</button> : value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-gray-600">{sub}</div>}
      {change && <div className="mt-1.5"><ChangeChip change={change} goodWhenUp={goodWhenUp} versus={versus} /></div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading, error, section
// ---------------------------------------------------------------------------
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('animate-pulse rounded-lg bg-gray-100', className)} />;
}

export function TilesSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3" role="status" aria-label="Loading numbers">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-white border border-gray-200 rounded-xl px-4 py-3.5"><Skeleton className="h-3 w-20" /><Skeleton className="h-7 w-24 mt-2" /><Skeleton className="h-3 w-28 mt-2" /></div>
      ))}
    </div>
  );
}

export function ChartSkeleton({ height = 280 }: { height?: number }) {
  return <div role="status" aria-label="Loading chart" className="bg-white border border-gray-200 rounded-xl p-5"><Skeleton className="h-4 w-40 mb-4" /><div style={{ height }}><Skeleton className="h-full w-full" /></div></div>;
}

export function TableSkeleton({ rows = 6, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div role="status" aria-label="Loading table" className="border border-gray-200 rounded-xl bg-white overflow-hidden">
      <div className="bg-gray-50 border-b border-gray-200 h-10" />
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 px-4 py-3 border-b border-gray-100 last:border-0">
          {Array.from({ length: cols }).map((_, c) => <Skeleton key={c} className={cn('h-4', c === 0 ? 'w-48' : 'w-16 ml-auto first:ml-0')} />)}
        </div>
      ))}
    </div>
  );
}

export function RetryError({ error, onRetry, className }: { error: unknown; onRetry: () => void; className?: string }) {
  const message = (error as Error)?.message || 'Something went wrong.';
  return (
    <div role="alert" className={cn('flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3', className)}>
      <div className="text-sm text-red-800"><span className="font-medium">We could not load these numbers.</span> <span className="text-red-700">{message}</span></div>
      <Button size="sm" variant="secondary" onClick={onRetry}><RefreshCw className="w-3.5 h-3.5" /> Try again</Button>
    </div>
  );
}

export function Section({ title, description, actions, children, className }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cn('bg-white border border-gray-200 rounded-xl', className)}>
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          {description && <p className="text-xs text-gray-500 mt-0.5 max-w-2xl">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </div>
      <div className="px-5 pb-5">{children}</div>
    </section>
  );
}

export function ExportButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return <Button size="sm" variant="secondary" onClick={onClick} disabled={disabled}><Download className="w-3.5 h-3.5" /> Export CSV</Button>;
}

/** A dimmed overlay while a new range loads over the previous numbers. */
export function Refreshing({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div aria-busy={active} className={cn('transition-opacity', active && 'opacity-60')}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------
export interface SortState { key: string; dir: 'asc' | 'desc' }

export function useSort<T>(rows: T[] | undefined, initial: SortState, accessors: Record<string, (row: T) => string | number | null | undefined>) {
  const [sort, setSort] = useState<SortState>(initial);
  const sorted = React.useMemo(() => {
    const get = accessors[sort.key];
    if (!rows || !get) return rows ?? [];
    const mul = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a); const y = get(b);
      const xn = x === null || x === undefined; const yn = y === null || y === undefined;
      if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;             // empty values always last
      if (typeof x === 'number' && typeof y === 'number') return (x - y) * mul;
      return String(x).localeCompare(String(y)) * mul;
    });
    // accessors are static per table
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sort]);
  const toggle = useCallback((key: string, firstDir: 'asc' | 'desc' = 'desc') => setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: firstDir })), []);
  return { sorted, sort, toggle };
}

export function SortTh({ label, sortKey, sort, onSort, align = 'right', metric, firstDir }: {
  label: string; sortKey: string; sort: SortState; onSort: (key: string, firstDir?: 'asc' | 'desc') => void; align?: 'left' | 'right'; metric?: string; firstDir?: 'asc' | 'desc';
}) {
  const active = sort.key === sortKey;
  const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ChevronUp : ChevronDown;
  return (
    <Th className={cn('whitespace-nowrap px-3', align === 'right' && 'text-right')}>
      <span className={cn('inline-flex items-center gap-1', align === 'right' && 'flex-row-reverse')}>
        <button type="button" onClick={() => onSort(sortKey, firstDir)} aria-label={`Sort by ${label}`} className={cn('p-0.5 rounded hover:bg-gray-200', active ? 'text-gray-700' : 'text-gray-300')}><Icon className="w-3 h-3" /></button>
        {metric ? <MetricLabel metric={metric}>{label}</MetricLabel> : label}
      </span>
    </Th>
  );
}

/** Count with its rate underneath: "128 / 31.2%". */
export function CountRate({ count, rate }: { count: string; rate: string }) {
  return <span className="inline-flex flex-col items-end leading-tight"><span className="tabular-nums text-gray-900">{count}</span><span className="tabular-nums text-xs text-gray-500">{rate}</span></span>;
}

// ---------------------------------------------------------------------------
// Expandable rows in a table that can scroll sideways: the detail keeps the width of the visible
// area (and sticks to its left edge) instead of stretching to the full width of the columns.
// ---------------------------------------------------------------------------
export function useElementWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);      // callback ref: the table mounts after the loading state
  const [width, setWidth] = useState<number | null>(null);
  React.useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el); setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

export function DetailRow({ colSpan, width, children }: { colSpan: number; width: number | null; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="p-0 border-b border-gray-200 bg-gray-50/60">
        <div className="sticky left-0 px-5 py-4" style={width ? { width: Math.max(width - 2, 0) } : undefined}>{children}</div>
      </td>
    </tr>
  );
}
