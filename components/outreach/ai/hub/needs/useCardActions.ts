'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseError } from '@/lib/outreach/api';
import { useInvalidateHub, type NeedsYouRow, type NeedsYouType } from '@/lib/outreach/aiHub';
import { cardKey, type CardApi, type Notify } from './types';

export const UNDO_MS = 5000;

export interface PendingUndo { id: number; label: string; count: number }
interface Entry extends PendingUndo { keys: string[]; run: () => Promise<unknown>; timer: ReturnType<typeof setTimeout> }

const keysOf = (rows: NeedsYouRow | NeedsYouRow[]) => (Array.isArray(rows) ? rows : [rows]).map(cardKey);

/**
 * Optimistic removal for Needs you.
 *   act    the card leaves, the call runs now; a failure brings the card back
 *   defer  the card leaves, the call runs after 5 seconds unless Undo is pressed (nothing reaches the server before that)
 * A removed card stays hidden until a list fetched after its call arrives, so it never flashes back in between.
 * Calls still waiting for their 5 seconds are made at once when the page is left (unmount, pagehide).
 */
export function useCardActions(ws: string | null | undefined, notify: Notify, listUpdatedAt: number) {
  const invalidate = useInvalidateHub(ws);
  // card key → 0 while its call is waiting or running, else the time the call finished
  const [gone, setGone] = useState<Record<string, number>>({});
  const [pending, setPending] = useState<PendingUndo[]>([]);
  const entries = useRef(new Map<number, Entry>());
  const seq = useRef(0);
  // timers and the unmount flush need the latest callbacks, not the ones of the render that started them
  const live = useRef({ invalidate, notify });
  useEffect(() => { live.current = { invalidate, notify }; });

  const hide = useCallback((keys: string[]) => setGone((g) => { const n = { ...g }; for (const k of keys) n[k] = 0; return n; }), []);
  const show = useCallback((keys: string[]) => setGone((g) => { const n = { ...g }; for (const k of keys) delete n[k]; return n; }), []);
  const settle = useCallback((keys: string[]) => {
    const at = Date.now();
    setGone((g) => { const n = { ...g }; for (const k of keys) n[k] = at; return n; });
    live.current.invalidate();
  }, []);
  const failed = useCallback((keys: string[], e: unknown) => {
    show(keys);
    live.current.notify(parseError(e).message, 'error');
    live.current.invalidate();   // "already handled" by someone else: the fresh list drops the card
  }, [show]);

  const act = useCallback<CardApi['act']>(async (rows, fn, done) => {
    const keys = keysOf(rows);
    hide(keys);
    try {
      const r = await fn();
      settle(keys);
      if (done) live.current.notify(typeof done === 'function' ? done(r) : done);
      return true;
    } catch (e) {
      failed(keys, e);
      return false;
    }
  }, [hide, settle, failed]);

  const commit = useCallback((id: number) => {
    const e = entries.current.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    entries.current.delete(id);
    setPending((p) => p.filter((x) => x.id !== id));
    e.run().then(() => settle(e.keys), (err) => failed(e.keys, err));
  }, [settle, failed]);

  const defer = useCallback<CardApi['defer']>((rows, label, fn) => {
    const keys = keysOf(rows);
    if (!keys.length) return;
    const id = ++seq.current;
    hide(keys);
    entries.current.set(id, { id, label, count: keys.length, keys, run: fn, timer: setTimeout(() => commit(id), UNDO_MS) });
    setPending((p) => [...p, { id, label, count: keys.length }]);
  }, [hide, commit]);

  const undo = useCallback((id: number) => {
    const e = entries.current.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    entries.current.delete(id);
    setPending((p) => p.filter((x) => x.id !== id));
    show(e.keys);
  }, [show]);

  useEffect(() => {
    const queue = entries.current;
    const flush = () => { for (const id of Array.from(queue.keys())) commit(id); };
    window.addEventListener('pagehide', flush);
    return () => { window.removeEventListener('pagehide', flush); flush(); };
  }, [commit]);

  const isGone = useCallback((key: string) => { const at = gone[key]; return at !== undefined && (at === 0 || at >= listUpdatedAt); }, [gone, listUpdatedAt]);

  /** Cards removed here that the server still counts (their call has not finished), per type: taken off the header counts. */
  const waiting = useMemo(() => {
    const n: Partial<Record<NeedsYouType, number>> = {};
    for (const [key, at] of Object.entries(gone)) {
      if (at !== 0) continue;
      const type = key.slice(0, key.indexOf(':')) as NeedsYouType;
      n[type] = (n[type] ?? 0) + 1;
    }
    return n;
  }, [gone]);

  return { act, defer, undo, pending, isGone, waiting };
}
