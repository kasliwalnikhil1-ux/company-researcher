/**
 * The demo "database": one in-memory object of tables (the production table names), a seeded random generator and
 * the simulation clock. Saved to sessionStorage (debounced) so a reload keeps the visitor's changes; a new tab starts
 * fresh. Every write emits a change event: the demo realtime channels forward it, exactly like Postgres changes.
 *
 * Nothing here talks to the network (lint rule + import-graph check, docs/outreach/PRODUCT-TOUR.md §3.4).
 */

export type Row = Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
export type Tables = Record<string, Row[]>;

/** Bump when the seed changes shape: older saved states are discarded. */
export const SEED_VERSION = 6;
const STATE_KEY = `gxdemo:v${SEED_VERSION}:state`;

export interface DemoState {
  v: number;
  tables: Tables;
  /** Simulated time minus real time, in ms. The simulator advances it; rows are stamped with real time. */
  simOffsetMs: number;
  /** Random generator state (mulberry32). */
  rng: number;
  /** Counter behind `uid()`. */
  seq: number;
  /** Small values the handlers keep (settings blobs, flags, the simulator's day counter …). */
  meta: Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  /** When the seed was built (real time). */
  builtAt: number;
}

export type ChangeEvent = { table: string; eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new: Row | null; old: Row | null };
type Listener = (e: ChangeEvent) => void;

function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uuid-shaped id from a counter: stable for the same seed and the same clicks. */
export function idFrom(n: number, salt = 0): string {
  const h = (x: number) => (x >>> 0).toString(16).padStart(8, '0');
  const a = Math.imul(n + 0x9e3779b9, 0x85ebca6b) ^ salt;
  const b = Math.imul(n ^ 0xc2b2ae35, 0x27d4eb2f);
  const c = Math.imul(n + 0x165667b1, 0xd3a2646c) ^ (salt * 31);
  const p = `${h(a)}${h(b)}${h(c)}${h(n)}`;
  return `${p.slice(0, 8)}-${p.slice(8, 12)}-4${p.slice(13, 16)}-8${p.slice(17, 20)}-${p.slice(20, 32)}`;
}

export const clone = <T,>(v: T): T => (v == null ? v : structuredClone(v));

export class DemoStore {
  state: DemoState;
  private listeners = new Set<Listener>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private rand: () => number;
  persistent = true;
  /** Bumped on every change: derived tables (node stats, budgets) recompute when it moves. */
  rev = 0;

  constructor(state: DemoState) {
    this.state = state;
    this.rand = this.makeRand();
  }

  private makeRand() {
    // the generator state lives in `state.rng` so a reload continues the same sequence
    return () => {
      const r = mulberry32(this.state.rng)();
      this.state.rng = (this.state.rng + 0x6d2b79f5) | 0;
      return r;
    };
  }

  // --- random ---------------------------------------------------------------
  random(): number { return this.rand(); }
  chance(p: number): boolean { return this.rand() < p; }
  int(min: number, max: number): number { return min + Math.floor(this.rand() * (max - min + 1)); }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(this.rand() * xs.length)]; }
  uid(): string { this.state.seq += 1; return idFrom(this.state.seq, 7); }

  // --- time -----------------------------------------------------------------
  /** Real now. Rows are stamped with it, so the UI's "2 minutes ago" stays true. */
  now(): Date { return new Date(); }
  nowIso(): string { return new Date().toISOString(); }
  /** Simulated now: what the simulator compares due times against. */
  simNow(): number { return Date.now() + this.state.simOffsetMs; }

  // --- tables ---------------------------------------------------------------
  t(name: string): Row[] {
    if (!this.state.tables[name]) this.state.tables[name] = [];
    return this.state.tables[name];
  }
  has(name: string): boolean { return !!this.state.tables[name]; }
  get(name: string, id: string | null | undefined, key = 'id'): Row | undefined {
    if (id == null) return undefined;
    return this.t(name).find((r) => r[key] === id);
  }
  where(name: string, pred: (r: Row) => boolean): Row[] { return this.t(name).filter(pred); }

  /** Inserts rows (an `id`, `created_at` and `updated_at` are filled in when the table uses them and they are missing). */
  insert(name: string, rows: Row | Row[], opts: { noId?: boolean; silent?: boolean } = {}): Row[] {
    const list = Array.isArray(rows) ? rows : [rows];
    const now = this.nowIso();
    const out: Row[] = [];
    for (const r0 of list) {
      const r: Row = { ...r0 };
      if (!opts.noId && r.id === undefined && !NO_ID_TABLES.has(name)) r.id = this.uid();
      if (r.created_at === undefined && !NO_TIMESTAMP_TABLES.has(name)) r.created_at = now;
      if (r.updated_at === undefined && UPDATED_AT_TABLES.has(name)) r.updated_at = now;
      this.t(name).push(r);
      out.push(r);
      if (!opts.silent) this.emit({ table: name, eventType: 'INSERT', new: r, old: null });
    }
    this.touch();
    return out;
  }

  /** Updates every row that matches; returns the updated rows. */
  update(name: string, pred: ((r: Row) => boolean) | string, patch: Row | ((r: Row) => Row), opts: { silent?: boolean } = {}): Row[] {
    const match = typeof pred === 'string' ? (r: Row) => r.id === pred : pred;
    const out: Row[] = [];
    const now = this.nowIso();
    for (const r of this.t(name)) {
      if (!match(r)) continue;
      const old = { ...r };
      Object.assign(r, typeof patch === 'function' ? patch(r) : patch);
      if (UPDATED_AT_TABLES.has(name) && !(typeof patch === 'object' && 'updated_at' in patch)) r.updated_at = now;
      out.push(r);
      if (!opts.silent) this.emit({ table: name, eventType: 'UPDATE', new: r, old });
    }
    if (out.length) this.touch();
    return out;
  }

  remove(name: string, pred: ((r: Row) => boolean) | string, opts: { silent?: boolean } = {}): Row[] {
    const match = typeof pred === 'string' ? (r: Row) => r.id === pred : pred;
    const rows = this.t(name);
    const removed: Row[] = [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (match(rows[i])) { removed.push(rows[i]); rows.splice(i, 1); }
    }
    if (removed.length) {
      if (!opts.silent) for (const r of removed) this.emit({ table: name, eventType: 'DELETE', new: null, old: r });
      this.touch();
    }
    return removed;
  }

  /** Insert, or merge into the row with the same key columns. */
  upsert(name: string, row: Row, keys: string[] = ['id']): Row {
    const existing = this.t(name).find((r) => keys.every((k) => r[k] === row[k]));
    if (existing) return this.update(name, (r) => r === existing, row)[0];
    return this.insert(name, row)[0];
  }

  meta<T>(key: string, init: () => T): T {
    if (!(key in this.state.meta)) this.state.meta[key] = init();
    return this.state.meta[key] as T;
  }
  setMeta(key: string, value: unknown): void { this.state.meta[key] = value; this.touch(); }

  // --- events ---------------------------------------------------------------
  subscribe(fn: Listener): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(e: ChangeEvent): void { for (const l of this.listeners) { try { l(e); } catch (err) { console.error('[demo] listener failed', err); } } }

  // --- persistence ----------------------------------------------------------
  /** Marks the state changed: saved to sessionStorage 500 ms after the last change. */
  touch(): void {
    this.rev++;
    if (!this.persistent || typeof window === 'undefined') return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 500);
  }

  /** Saves now (also called on pagehide, so a full-page navigation inside the demo keeps the changes). */
  flush(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.persistent || typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(STATE_KEY, JSON.stringify(encodeState(this.state)));
    } catch (e) {
      // full or blocked: keep working in memory only
      console.warn('[demo] sessionStorage unavailable, the demo keeps its changes in memory only', e);
      this.persistent = false;
    }
  }

  static load(): DemoState | null {
    try {
      const raw = window.sessionStorage.getItem(STATE_KEY);
      if (!raw) return null;
      const s = decodeState(JSON.parse(raw));
      return s && s.v === SEED_VERSION && s.tables ? s : null;
    } catch { return null; }
  }

  /** Removes every `gxdemo:` key (state, saved filters, tour progress). */
  static clearSaved(): void {
    try {
      const keys: string[] = [];
      for (let i = 0; i < window.sessionStorage.length; i++) { const k = window.sessionStorage.key(i); if (k && k.startsWith('gxdemo:')) keys.push(k); }
      for (const k of keys) window.sessionStorage.removeItem(k);
    } catch { /* storage blocked */ }
  }
}

/**
 * Saved form of the state: each table as `{ c: columns, r: rows of values }`, so key names are not repeated on every
 * row (about a third smaller, which matters against the sessionStorage quota).
 */
type Encoded = Omit<DemoState, 'tables'> & { tables: Record<string, { c: string[]; r: unknown[][] }> };
function encodeState(st: DemoState): Encoded {
  const tables: Encoded['tables'] = {};
  for (const [t, rows] of Object.entries(st.tables)) {
    const cols: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    tables[t] = { c: cols, r: rows.map((r) => cols.map((c) => (c in r ? r[c] : null))) };
  }
  return { ...st, tables };
}
function decodeState(e: Encoded | null): DemoState | null {
  if (!e || !e.tables) return null;
  const tables: Tables = {};
  for (const [t, { c, r }] of Object.entries(e.tables)) tables[t] = r.map((vals) => { const o: Row = {}; c.forEach((k, i) => { o[k] = vals[i]; }); return o; });
  return { ...e, tables };
}

/** Tables keyed by something other than a generated `id`. */
const NO_ID_TABLES = new Set([
  'outreach_lead_tags', 'outreach_lead_sender_state', 'outreach_sender_budgets', 'outreach_node_stats', 'outreach_lead_profiles',
  'outreach_sequence_versions', 'outreach_platform_ceilings', 'outreach_warmup_caps', 'outreach_channel_capabilities', 'outreach_voice_clips',
  'outreach_billing_usage', 'outreach_members',
]);
const NO_TIMESTAMP_TABLES = new Set(['outreach_lead_tags', 'outreach_sender_budgets', 'outreach_node_stats', 'outreach_platform_ceilings', 'outreach_warmup_caps', 'outreach_channel_capabilities']);
const UPDATED_AT_TABLES = new Set([
  'outreach_leads', 'outreach_senders', 'outreach_sequences', 'outreach_ai_variables', 'outreach_ai_values', 'outreach_lead_profiles',
  'outreach_lead_sender_state', 'outreach_integrations', 'outreach_webchat_inboxes', 'outreach_workspaces',
]);
