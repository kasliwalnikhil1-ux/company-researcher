'use client';

// Draft auto-save for the sequence builder (plan item 5).
// - the graph is written to outreach_sequences.draft_graph about 2 s after the last change (rpc save_draft)
// - one write at a time: changes made while a write is in flight are coalesced into the next one
// - a copy is kept in localStorage as the offline fallback
// - failures retry with backoff; the builder keeps its leave-page guard while status is 'error'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseError, rpc } from '@/lib/outreach/api';
import type { Graph } from '@/lib/outreach/types';
import type { SaveDraftResult } from './publishTypes';

export const AUTOSAVE_DELAY_MS = 2000;
const LOCAL_DELAY_MS = 400;
const RETRY_MAX_MS = 30000;
/** Errors that another attempt cannot fix. */
const PERMANENT = new Set(['E_FORBIDDEN', 'E_NOT_FOUND', 'E_GRAPH_INVALID', 'E_PAYLOAD_INVALID', 'E_PLAN_SUSPENDED']);

export function stableStringify(v: unknown): string {
  const stable = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(stable);
    if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, stable((x as Record<string, unknown>)[k])]));
    return x;
  };
  return JSON.stringify(stable(v));
}

// ---------------------------------------------------------------------------
// Local copy
// ---------------------------------------------------------------------------
export interface LocalDraftCopy<M = Record<string, unknown>> { ts: number; graph: Graph; meta?: M }

const localKey = (sequenceId: string) => `outreach:draft:${sequenceId}`;

export function readLocalDraft<M = Record<string, unknown>>(sequenceId: string): LocalDraftCopy<M> | null {
  try {
    const raw = window.localStorage.getItem(localKey(sequenceId));
    if (!raw) return null;
    const v = JSON.parse(raw) as LocalDraftCopy<M>;
    if (!v || typeof v.ts !== 'number' || !v.graph || typeof v.graph !== 'object' || typeof v.graph.nodes !== 'object' || !v.graph.start || !v.graph.nodes[v.graph.start]) return null;
    return v;
  } catch { return null; }
}

export function writeLocalDraft<M>(sequenceId: string, copy: LocalDraftCopy<M>): boolean {
  try { window.localStorage.setItem(localKey(sequenceId), JSON.stringify(copy)); return true; } catch { return false; }
}

export function clearLocalDraft(sequenceId: string): void {
  try { window.localStorage.removeItem(localKey(sequenceId)); } catch { /* storage unavailable */ }
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------
export type DraftSaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error';

export interface DraftSaveState {
  status: DraftSaveStatus;
  savedAt: string | null;
  /** Node-level changes between the live graph and the saved draft, as counted by the database. */
  unpublishedChanges: number | null;
  stale: boolean;
  headVersion: number | null;
  baseVersion: number | null;
  error: string | null;
  retrying: boolean;
}

const INITIAL: DraftSaveState = { status: 'idle', savedAt: null, unpublishedChanges: null, stale: false, headVersion: null, baseVersion: null, error: null, retrying: false };

export interface DraftAutosave extends DraftSaveState {
  /** Save now. Resolves true once the latest graph is on the server. */
  flush: () => Promise<boolean>;
  /** Stop timers and wait for a write that is already in flight, without starting a new one. */
  settle: () => Promise<void>;
  /** Treat `graph` as already saved (after load, publish, save or discard) and forget the local copy. */
  reset: (graph: Graph, seed?: Partial<DraftSaveState>) => void;
  seed: (patch: Partial<DraftSaveState>) => void;
  /** True while the server does not have the latest graph. */
  unsaved: boolean;
}

export function useDraftAutosave<M>({ sequenceId, graph, graphStr, enabled, meta, metaDirty }: {
  sequenceId: string; graph: Graph | null;
  /** stableStringify(graph), computed once by the builder (it needs the same string for its own diff). */
  graphStr: string;
  enabled: boolean; meta: M; metaDirty: boolean;
}): DraftAutosave {
  const [state, setState] = useState<DraftSaveState>(INITIAL);

  const saved = useRef<string | null>(null);
  const latest = useRef<{ graph: Graph | null; str: string }>({ graph, str: graphStr });
  latest.current = { graph, str: graphStr };
  const metaRef = useRef({ meta, metaDirty });
  metaRef.current = { meta, metaDirty };
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inflight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const localTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const set = useCallback((patch: Partial<DraftSaveState> | ((s: DraftSaveState) => DraftSaveState)) => {
    if (!mounted.current) return;
    setState((s) => (typeof patch === 'function' ? patch(s) : { ...s, ...patch }));
  }, []);

  const clearTimer = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };

  const syncLocal = useCallback(() => {
    const cur = latest.current;
    if (!cur.graph || !enabledRef.current) return;
    const graphUnsaved = saved.current !== null && cur.str !== saved.current;
    if (graphUnsaved || metaRef.current.metaDirty) writeLocalDraft(sequenceId, { ts: Date.now(), graph: cur.graph, meta: metaRef.current.meta });
    else clearLocalDraft(sequenceId);
  }, [sequenceId]);

  const flushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true));
  const flush = useCallback((): Promise<boolean> => {
    clearTimer();
    if (inflight.current) return inflight.current.then((ok) => (ok && latest.current.str !== saved.current ? flushRef.current() : ok));
    if (!enabledRef.current || saved.current === null || !latest.current.graph || latest.current.str === saved.current) return Promise.resolve(true);
    const p = (async () => {
      while (enabledRef.current && latest.current.graph && latest.current.str !== saved.current) {
        const snap = latest.current;
        set({ status: 'saving' });
        try {
          const r = await rpc<SaveDraftResult>('save_draft', { p_id: sequenceId, p_graph: snap.graph });
          saved.current = snap.str;
          attempts.current = 0;
          set({ status: latest.current.str === snap.str ? 'saved' : 'pending', savedAt: r.saved_at, unpublishedChanges: r.unpublished_changes, stale: !!r.stale, headVersion: r.head_version, baseVersion: r.base_version, error: null, retrying: false });
          syncLocal();
        } catch (e) {
          const err = parseError(e);
          const permanent = PERMANENT.has(err.code);
          attempts.current += 1;
          set({ status: 'error', error: err.message, retrying: !permanent });
          syncLocal();
          if (!permanent && mounted.current) {
            const wait = Math.min(RETRY_MAX_MS, AUTOSAVE_DELAY_MS * 2 ** (attempts.current - 1));
            clearTimer();
            timer.current = setTimeout(() => { void flushRef.current(); }, wait);
          }
          return false;
        }
      }
      return true;
    })();
    inflight.current = p;
    void p.finally(() => { if (inflight.current === p) inflight.current = null; });
    return p;
  }, [sequenceId, set, syncLocal]);
  flushRef.current = flush;

  // A change: mark pending, keep the local copy fresh, save after the pause.
  useEffect(() => {
    if (!enabled || !graph || saved.current === null) return;
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(syncLocal, LOCAL_DELAY_MS);
    if (graphStr === saved.current) {
      if (!inflight.current) { clearTimer(); set((s) => (s.status === 'pending' ? { ...s, status: s.savedAt ? 'saved' : 'idle' } : s)); }
      return;
    }
    attempts.current = 0;
    set((s) => (s.status === 'saving' ? s : { ...s, status: 'pending' }));
    clearTimer();
    timer.current = setTimeout(() => { void flushRef.current(); }, AUTOSAVE_DELAY_MS);
  }, [graphStr, graph, enabled, set, syncLocal]);

  // name / settings changes only live in the local copy until they are saved or published
  const metaStr = useMemo(() => stableStringify(meta), [meta]);
  useEffect(() => {
    if (!enabled || saved.current === null) return;
    if (localTimer.current) clearTimeout(localTimer.current);
    localTimer.current = setTimeout(syncLocal, LOCAL_DELAY_MS);
  }, [metaStr, metaDirty, enabled, syncLocal]);

  // Tab hidden or closing: write the local copy at once and try to save.
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => { if (document.visibilityState === 'hidden') { syncLocal(); void flushRef.current(); } };
    const onPageHide = () => syncLocal();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onPageHide);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('pagehide', onPageHide); };
  }, [enabled, syncLocal]);

  // Leaving the builder inside the app: last attempt, timers off.
  useEffect(() => () => {
    if (localTimer.current) clearTimeout(localTimer.current);
    if (enabledRef.current && saved.current !== null && latest.current.str !== saved.current) { syncLocal(); void flushRef.current(); }
    else clearTimer();
  }, [syncLocal]);

  const settle = useCallback(async () => {
    clearTimer();
    if (inflight.current) { try { await inflight.current; } catch { /* reported through state */ } }
    clearTimer();
  }, []);

  const reset = useCallback((g: Graph, seed?: Partial<DraftSaveState>) => {
    clearTimer();
    if (localTimer.current) { clearTimeout(localTimer.current); localTimer.current = null; }
    saved.current = stableStringify(g);
    attempts.current = 0;
    clearLocalDraft(sequenceId);
    set({ ...INITIAL, ...seed });
  }, [sequenceId, set]);

  const seed = useCallback((patch: Partial<DraftSaveState>) => set(patch), [set]);

  const unsaved = enabled && saved.current !== null && graphStr !== saved.current;
  return { ...state, flush, settle, reset, seed, unsaved };
}
