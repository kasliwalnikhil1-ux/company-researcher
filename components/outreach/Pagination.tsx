'use client';

import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/outreach/ui';
import { cn } from '@/lib/utils';

export const LIST_PAGE_SIZE = 50;

/**
 * Pages a list that is already fully loaded. `resetKey` is any string that changes with the filters:
 * when it changes the list goes back to page 1, and a page past the end (after a delete) clamps to the last one.
 */
export function usePagedRows<T>(rows: T[], resetKey: string, pageSize = LIST_PAGE_SIZE) {
  const [state, setState] = useState({ key: resetKey, page: 0 });
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const page = Math.min(state.key === resetKey ? state.page : 0, pageCount - 1);
  const pageRows = useMemo(() => rows.slice(page * pageSize, (page + 1) * pageSize), [rows, page, pageSize]);
  const setPage = (p: number) => setState({ key: resetKey, page: Math.max(0, Math.min(pageCount - 1, p)) });
  return { pageRows, page, pageCount, setPage, total: rows.length, from: rows.length === 0 ? 0 : page * pageSize + 1, to: Math.min(rows.length, (page + 1) * pageSize) };
}

/** The "Showing 1–50 of 312 · Prev · Page 1 / 7 · Next" bar under a table, as on the leads page. */
export function PaginationBar({ page, pageCount, setPage, total, from, to, className }: Omit<ReturnType<typeof usePagedRows>, 'pageRows'> & { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-2 mt-3 text-sm text-gray-600', className)}>
      <span>Showing <span className="font-medium text-gray-900 tabular-nums">{from.toLocaleString()}–{to.toLocaleString()}</span> of <span className="font-medium text-gray-900 tabular-nums">{total.toLocaleString()}</span></span>
      <div className="flex items-center gap-1">
        <Button variant="secondary" size="sm" onClick={() => setPage(page - 1)} disabled={page === 0}><ChevronLeft className="w-4 h-4" /> Prev</Button>
        <span className="px-2 tabular-nums">Page {page + 1} / {pageCount}</span>
        <Button variant="secondary" size="sm" onClick={() => setPage(page + 1)} disabled={page >= pageCount - 1}>Next <ChevronRight className="w-4 h-4" /></Button>
      </div>
    </div>
  );
}
