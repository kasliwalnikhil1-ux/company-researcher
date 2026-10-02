'use client';

// Saved table layouts: the column order and widths a person picked for a table, per workspace.
// The copy in this browser is shown at once; the saved copy (outreach_table_layouts, migration 054) then replaces it, so the same
// layout follows the person to another device. Every change is written to both.

import { useCallback, useEffect, useRef, useState } from 'react';
import { rpc } from './api';
import { kv } from '@/lib/outreach/storage';

export interface TableLayout { order: string[]; widths: Record<string, number> }

export const EMPTY_LAYOUT: TableLayout = { order: [], widths: {} };
export const MIN_COL_WIDTH = 60;
export const MAX_COL_WIDTH = 900;
const SAVE_DELAY_MS = 600;

export function isLayoutEmpty(l: TableLayout): boolean { return l.order.length === 0 && Object.keys(l.widths).length === 0; }

/** Only accepts the known shape, so a stale or hand-edited entry cannot break the table. */
function sanitize(raw: unknown): TableLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { order?: unknown; widths?: unknown };
  const order = Array.isArray(r.order) ? [...new Set(r.order.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 120))].slice(0, 200) : [];
  const widths: Record<string, number> = {};
  if (r.widths && typeof r.widths === 'object') {
    for (const [k, v] of Object.entries(r.widths as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) widths[k] = Math.round(Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, v)));
    }
  }
  return { order, widths };
}

function storageKey(table: string, ws: string) { return `outreach-table-layout:${table}:${ws}`; }

function readLocal(table: string, ws: string): TableLayout {
  try { return sanitize(JSON.parse(kv.getItem(storageKey(table, ws)) ?? 'null')) ?? EMPTY_LAYOUT; } catch { return EMPTY_LAYOUT; }
}
function writeLocal(table: string, ws: string, l: TableLayout) {
  try {
    if (isLayoutEmpty(l)) kv.removeItem(storageKey(table, ws)); else kv.setItem(storageKey(table, ws), JSON.stringify(l));
  } catch { /* storage unavailable */ }
}

/**
 * The saved layout of one table in one workspace. `setLayout` stores the new layout (browser now, account after a short pause);
 * `reset` goes back to the default order and widths.
 */
export function useTableLayout(ws: string | null | undefined, table: string) {
  // Tagged with its workspace, so the layout of the previous workspace is never shown for the next one.
  const [state, setState] = useState<{ ws: string | null; layout: TableLayout }>({ ws: null, layout: EMPTY_LAYOUT });
  // The copy kept in this browser is shown straight away, before the saved one arrives.
  if (ws && state.ws !== ws) setState({ ws, layout: readLocal(table, ws) });
  const pending = useRef<{ ws: string; layout: TableLayout; timer: ReturnType<typeof setTimeout> } | null>(null);
  const touched = useRef(false);

  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    clearTimeout(p.timer);
    pending.current = null;
    // A failed save keeps the browser copy; the next change tries again.
    rpc('table_layout_set', { p_ws: p.ws, p_table: table, p_layout: isLayoutEmpty(p.layout) ? null : p.layout }).catch(() => {});
  }, [table]);

  useEffect(() => {
    if (!ws) return;
    let off = false;
    touched.current = false;
    rpc<unknown>('table_layout_get', { p_ws: ws, p_table: table }).then((saved) => {
      const s = sanitize(saved);
      // A change made while the saved copy was loading wins over it.
      if (off || touched.current || !s) return;
      setState({ ws, layout: s });
      writeLocal(table, ws, s);
    }).catch(() => {});
    return () => { off = true; flush(); };
  }, [ws, table, flush]);

  const setLayout = useCallback((next: TableLayout) => {
    if (!ws) return;
    touched.current = true;
    setState({ ws, layout: next });
    writeLocal(table, ws, next);
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { ws, layout: next, timer: setTimeout(flush, SAVE_DELAY_MS) };
  }, [ws, table, flush]);

  const reset = useCallback(() => setLayout(EMPTY_LAYOUT), [setLayout]);

  return { layout: ws && state.ws === ws ? state.layout : EMPTY_LAYOUT, setLayout, reset };
}

/**
 * Column ids in display order: the saved order first, then every column the saved order does not mention, each placed after the
 * column that precedes it by default. Ids the table does not have right now (a custom field still loading) keep their place.
 */
export function mergeColumnOrder(saved: string[], defaults: string[]): string[] {
  const out = [...new Set(saved)];
  defaults.forEach((id, i) => {
    if (out.includes(id)) return;
    let at = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.indexOf(defaults[j]); if (p >= 0) { at = p + 1; break; } }
    out.splice(at, 0, id);
  });
  return out;
}

/** Move `id` next to `target` (before it, or after it) inside `order`. */
export function moveColumn(order: string[], id: string, target: string, after: boolean): string[] {
  if (id === target) return order;
  const out = order.filter((x) => x !== id);
  const at = out.indexOf(target);
  if (at < 0) return order;
  out.splice(after ? at + 1 : at, 0, id);
  return out;
}
