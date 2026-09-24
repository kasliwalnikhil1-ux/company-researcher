'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Filters that are remembered in this browser, per workspace, and restored when the page opens again.
 *
 * - The value is stored under `outreach-<name>-filters:<workspace id>`; the entry is removed when the value is back to the defaults.
 * - `ready` is false until the stored value for the current workspace has been read. Pages that fetch on the server
 *   pass `ready ? ws : null` to their query hook so the list is not fetched unfiltered first.
 * - `sanitize` receives whatever was stored (possibly stale or hand-edited) and returns a valid value; the default keeps
 *   only the keys that exist in `defaults` and only values of the same primitive type (or any primitive when the default is null).
 * - `overrides` (e.g. from URL params) win over the stored value when it is read.
 * - `omit` lists keys that are never written (e.g. a free-text search), so they always start from the default.
 */
export function usePersistedFilters<T extends object>(name: string, ws: string | null | undefined, defaults: T, opts?: {
  sanitize?: (raw: unknown, defaults: T) => T;
  overrides?: Partial<T> | null;
  omit?: (keyof T)[];
}) {
  const [state, setState] = useState<{ ws: string | null; value: T }>({ ws: null, value: defaults });
  // Options are read through a ref so callers can pass inline objects without re-triggering the load.
  // This effect is declared first so it runs before the load effect below in the same commit.
  const optsRef = useRef({ defaults, sanitize: opts?.sanitize, overrides: opts?.overrides, omit: opts?.omit });
  useEffect(() => { optsRef.current = { defaults, sanitize: opts?.sanitize, overrides: opts?.overrides, omit: opts?.omit }; });

  useEffect(() => {
    if (!ws) return;
    const { defaults: d, sanitize, overrides } = optsRef.current;
    let value = d;
    try {
      const raw = localStorage.getItem(filtersKey(name, ws));
      if (raw) value = (sanitize ?? sanitizeLike)(JSON.parse(raw), d);
    } catch { /* storage unavailable or unreadable */ }
    if (overrides) value = { ...value, ...overrides };
    setState({ ws, value });
  }, [ws, name]);

  const setFilters = useCallback((next: T | ((v: T) => T)) => {
    setState((s) => {
      const value = typeof next === 'function' ? (next as (v: T) => T)(s.value) : next;
      if (s.ws) {
        try {
          const { defaults: d, omit } = optsRef.current;
          const stored = { ...value } as Record<string, unknown>;
          for (const k of omit ?? []) stored[k as string] = (d as Record<string, unknown>)[k as string];
          if (isDefault(stored as T, d)) localStorage.removeItem(filtersKey(name, s.ws));
          else localStorage.setItem(filtersKey(name, s.ws), JSON.stringify(stored));
        } catch { /* storage unavailable */ }
      }
      return { ...s, value };
    });
  }, [name]);
  const patch = useCallback((p: Partial<T>) => setFilters((v) => ({ ...v, ...p })), [setFilters]);
  const reset = useCallback(() => setFilters(optsRef.current.defaults), [setFilters]);

  return { filters: state.value, setFilters, patch, reset, ready: !!ws && state.ws === ws };
}

export function filtersKey(name: string, ws: string) { return `outreach-${name}-filters:${ws}`; }

/** Keeps only the keys of `defaults`, each with a value of the default's primitive type (any primitive when the default is null). */
export function sanitizeLike<T extends object>(raw: unknown, defaults: T): T {
  const out = { ...defaults } as Record<string, unknown>;
  if (!raw || typeof raw !== 'object') return out as T;
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(defaults)) {
    const v = r[k];
    const d = (defaults as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (v === null) { if (d === null || d === undefined) out[k] = null; continue; }
    const t = typeof v;
    if (t !== 'string' && t !== 'number' && t !== 'boolean') continue;
    if (d == null || typeof d === t) out[k] = v;
  }
  return out as T;
}

function isDefault<T extends object>(value: T, defaults: T): boolean {
  const norm = (v: unknown) => (v == null || v === '' || v === false ? null : v);
  return Object.keys(defaults).every((k) => norm((value as Record<string, unknown>)[k]) === norm((defaults as Record<string, unknown>)[k]))
    && Object.keys(value).every((k) => k in defaults || norm((value as Record<string, unknown>)[k]) === null);
}
