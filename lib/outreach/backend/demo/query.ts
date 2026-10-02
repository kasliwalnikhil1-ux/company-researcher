/**
 * `db.from(table)` in demo mode: a query builder over the demo tables with the same chain and result shape as
 * supabase-js / PostgREST, for exactly the operations the outreach UI uses:
 *
 *   select (column lists, `*`, aliases, embedded relations incl. `!inner`, `{ count, head }`)
 *   eq neq gt gte lt lte like ilike is in contains match not or filter
 *   order (Postgres null ordering, `referencedTable`) range limit single maybeSingle
 *   insert update upsert delete (+ `.select()` to return rows)
 *
 * Anything else throws E_DEMO_QUERY naming the table and the operator, so the demo check finds it.
 */
import { clone, type DemoStore, type Row } from './store';

type Pred = (r: Row) => boolean;
type Embed = { alias: string; table: string; inner: boolean; cols: SelectItem[] };
type SelectItem = { kind: 'all' } | { kind: 'col'; name: string; alias: string } | { kind: 'embed'; embed: Embed };
type Order = { col: string; asc: boolean; nullsFirst: boolean; table?: string };
type Result = { data: unknown; error: unknown; count: number | null; status: number; statusText: string };

export class DemoQueryError extends Error {
  code = 'E_DEMO_QUERY';
  constructor(table: string, what: string) { super(`E_DEMO_QUERY: ${table}: ${what} is not supported by the demo query builder`); }
}

/** Write hooks: defaults on insert and side effects (counters, derived columns). Filled by the handlers. */
export interface TableHooks {
  beforeInsert?: (row: Row, store: DemoStore) => Row;
  afterWrite?: (kind: 'insert' | 'update' | 'delete', rows: Row[], store: DemoStore) => void;
  /** Columns a visitor may not change through `db.from()` (they are kept). */
  readOnly?: string[];
  /** Refreshes a derived table (counters the real database keeps) before it is read. */
  beforeRead?: (store: DemoStore) => void;
}
export const tableHooks: Record<string, TableHooks> = {};

/** Embedded relations that the naming rule (`<singular>_id`) does not find. Key: `<parent>.<embed>`. */
export const RELATIONS: Record<string, { kind: 'one' | 'many'; fk: string; ref?: string }> = {
  'outreach_ai_values.outreach_ai_variables': { kind: 'one', fk: 'variable_id' },
  'outreach_ai_outputs.outreach_ai_variables': { kind: 'one', fk: 'variable_id' },
  'outreach_leads.outreach_lead_tags': { kind: 'many', fk: 'lead_id' },
  'outreach_leads.outreach_lead_identities': { kind: 'many', fk: 'lead_id' },
  'outreach_lead_tags.outreach_leads': { kind: 'one', fk: 'lead_id' },
  'outreach_lead_tags.outreach_tags': { kind: 'one', fk: 'tag_id' },
};

const singular = (table: string) => {
  const base = table.replace(/^outreach_/, '');
  const last = base.split('_').pop()!;
  const s = (w: string) => (w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.endsWith('ses') ? w.slice(0, -2) : w.endsWith('s') ? w.slice(0, -1) : w);
  return { full: s(base), last: s(last) };
};

function relation(store: DemoStore, parent: string, embed: string): { kind: 'one' | 'many'; fk: string } {
  const explicit = RELATIONS[`${parent}.${embed}`];
  if (explicit) return explicit;
  const e = singular(embed);
  const p = singular(parent);
  const parentRows = store.t(parent);
  const childRows = store.t(embed);
  const hasCol = (rows: Row[], c: string) => rows.some((r) => c in r);
  for (const fk of [`${e.full}_id`, `${e.last}_id`]) if (hasCol(parentRows, fk)) return { kind: 'one', fk };
  for (const fk of [`${p.full}_id`, `${p.last}_id`]) if (hasCol(childRows, fk)) return { kind: 'many', fk };
  // empty tables: fall back on the name
  return parentRows.length === 0 && childRows.length > 0 ? { kind: 'many', fk: `${p.last}_id` } : { kind: 'one', fk: `${e.last}_id` };
}

// --- parsing ---------------------------------------------------------------
/** Split on commas that are not inside parentheses or double quotes. */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, quote = false, cur = '';
  for (const c of s) {
    if (c === '"') quote = !quote;
    if (!quote && c === '(') depth++;
    if (!quote && c === ')') depth--;
    if (!quote && depth === 0 && c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

function parseSelect(table: string, s: string): SelectItem[] {
  const items: SelectItem[] = [];
  for (const raw of splitTop(s.replace(/\s+/g, ' '))) {
    const part = raw.trim();
    if (part === '*') { items.push({ kind: 'all' }); continue; }
    const m = /^(?:([\w]+):)?([\w]+)(!inner|!left|![\w]+)?\s*\((.*)\)$/s.exec(part);
    if (m) {
      const [, alias, name, hint, inner] = m;
      items.push({ kind: 'embed', embed: { alias: alias ?? name, table: name, inner: hint === '!inner', cols: parseSelect(name, inner || '*') } });
      continue;
    }
    const c = /^(?:([\w]+):)?([\w]+)(?:::[\w]+)?$/.exec(part);
    if (!c) throw new DemoQueryError(table, `select "${part}"`);
    items.push({ kind: 'col', name: c[2], alias: c[1] ?? c[2] });
  }
  return items;
}

// --- values ----------------------------------------------------------------
function norm(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v;
}
function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (typeof a === 'number' && typeof b !== 'number' && b != null && !Number.isNaN(Number(b))) b = Number(b);
  if (typeof b === 'number' && typeof a !== 'number' && a != null && !Number.isNaN(Number(a))) a = Number(a);
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) return Date.parse(a) - Date.parse(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') { a = String(a); b = String(b); }
  return (a as any) < (b as any) ? -1 : (a as any) > (b as any) ? 1 : 0;   // eslint-disable-line @typescript-eslint/no-explicit-any
}
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function eq(a: unknown, b: unknown): boolean {
  a = norm(a); b = norm(b);
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) return Date.parse(a) === Date.parse(b);
  return String(a) === String(b);
}
function likeRe(pattern: string, ci: boolean): RegExp {
  const esc = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/[%*]/g, '.*').replace(/_/g, '.');
  return new RegExp(`^${esc}$`, ci ? 'is' : 's');
}
function contains(hay: unknown, needle: unknown): boolean {
  if (typeof needle === 'string') { try { needle = JSON.parse(needle); } catch { /* plain */ } }
  if (Array.isArray(hay)) {
    const n = Array.isArray(needle) ? needle : [needle];
    return n.every((x) => hay.some((h) => (typeof x === 'object' && x !== null ? contains(h, x) : eq(h, x))));
  }
  if (hay && typeof hay === 'object' && needle && typeof needle === 'object') {
    return Object.entries(needle as Row).every(([k, v]) => (v && typeof v === 'object' ? contains((hay as Row)[k], v) : eq((hay as Row)[k], v)));
  }
  return eq(hay, needle);
}
/** `(a,b,"c d")` → ['a','b','c d'] */
function parseList(v: string): string[] {
  const s = v.trim().replace(/^\(/, '').replace(/\)$/, '');
  return splitTop(s).map((x) => x.replace(/^"(.*)"$/, '$1'));
}
function coerce(v: string): unknown {
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.replace(/^"(.*)"$/, '$1');
}

function readPath(row: Row, col: string): unknown {
  // `settings->>key` / `settings->key`
  const j = /^(\w+)->>?(\w+)$/.exec(col);
  if (j) { const base = row[j[1]]; return base && typeof base === 'object' ? (base as Row)[j[2]] : undefined; }
  return row[col];
}

/** One operator applied to a value. `op` is a PostgREST operator name. */
function test(table: string, op: string, value: unknown, arg: unknown): boolean {
  switch (op) {
    case 'eq': return eq(value, arg);
    case 'neq': return !eq(value, arg);
    case 'gt': return value != null && cmp(value, arg) > 0;
    case 'gte': return value != null && cmp(value, arg) >= 0;
    case 'lt': return value != null && cmp(value, arg) < 0;
    case 'lte': return value != null && cmp(value, arg) <= 0;
    case 'like': return value != null && likeRe(String(arg), false).test(String(value));
    case 'ilike': return value != null && likeRe(String(arg), true).test(String(value));
    case 'is': {
      const a = typeof arg === 'string' ? coerce(arg) : arg;
      if (a === null) return value == null;
      return value === a;
    }
    case 'in': {
      const list = Array.isArray(arg) ? arg : parseList(String(arg));
      return list.some((x) => eq(value, x));
    }
    case 'cs': case 'contains': return value != null && contains(value, arg);
    case 'cd': case 'containedBy': return Array.isArray(value) && value.every((x) => contains(Array.isArray(arg) ? arg : parseList(String(arg)), x));
    case 'ov': case 'overlaps': { const list = Array.isArray(arg) ? arg : parseList(String(arg)); return Array.isArray(value) && value.some((x) => list.some((y) => eq(x, y))); }
    default: throw new DemoQueryError(table, `filter operator "${op}"`);
  }
}

/** Parses a PostgREST logic string (`a.eq.1,and(b.lt.2,c.is.null)`) into a predicate over a row. */
function parseLogic(table: string, s: string, joiner: 'or' | 'and'): Pred {
  const parts = splitTop(s).map((p) => parseCondition(table, p));
  return joiner === 'or' ? (r) => parts.some((p) => p(r)) : (r) => parts.every((p) => p(r));
}
function parseCondition(table: string, p: string): Pred {
  const logic = /^(not\.)?(and|or)\((.*)\)$/s.exec(p);
  if (logic) { const inner = parseLogic(table, logic[3], logic[2] as 'and' | 'or'); return logic[1] ? (r) => !inner(r) : inner; }
  const m = /^([\w>-]+)\.(not\.)?(\w+)\.(.*)$/s.exec(p);
  if (!m) throw new DemoQueryError(table, `filter "${p}"`);
  const [, col, neg, op, raw] = m;
  const arg = op === 'in' ? parseList(raw) : op === 'is' ? coerce(raw) : coerce(raw);
  return neg ? (r) => !test(table, op, readPath(r, col), arg) : (r) => test(table, op, readPath(r, col), arg);
}

// --- the builder -------------------------------------------------------------
export class DemoQuery implements PromiseLike<Result> {
  private op: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
  private selectStr: string | null = null;
  private returning = false;
  private countMode: string | null = null;
  private head = false;
  private filters: Pred[] = [];
  /** Filters on embedded rows (`outreach_lead_tags.tag_id`) and "embed is (not) null" tests. */
  private embedFilters: Array<{ embed: string; pred: Pred }> = [];
  private embedNull: Array<{ embed: string; isNull: boolean }> = [];
  private orders: Order[] = [];
  private from_: number | null = null;
  private to_: number | null = null;
  private limit_: number | null = null;
  private single_: 'single' | 'maybe' | null = null;
  private payload: Row[] = [];
  private onConflict: string[] = ['id'];
  private ignoreDuplicates = false;

  constructor(private store: DemoStore, private table: string) {}

  // --- select / mutations ---
  select(cols = '*', opts: { count?: string; head?: boolean } = {}): this {
    if (this.op === 'select') { this.selectStr = cols; this.countMode = opts.count ?? null; this.head = !!opts.head; }
    else { this.returning = true; this.selectStr = cols; }
    return this;
  }
  insert(rows: Row | Row[], opts: { count?: string } = {}): this { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; this.countMode = opts.count ?? null; return this; }
  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}): this {
    this.op = 'upsert'; this.payload = Array.isArray(rows) ? rows : [rows];
    if (opts.onConflict) this.onConflict = opts.onConflict.split(',').map((x) => x.trim());
    this.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }
  update(patch: Row, opts: { count?: string } = {}): this { this.op = 'update'; this.payload = [patch]; this.countMode = opts.count ?? null; return this; }
  delete(opts: { count?: string } = {}): this { this.op = 'delete'; this.countMode = opts.count ?? null; return this; }

  // --- filters ---
  private add(col: string, op: string, arg: unknown): this {
    const dot = col.indexOf('.');
    if (dot > 0 && !col.includes('->')) {
      const embed = col.slice(0, dot), c = col.slice(dot + 1);
      this.embedFilters.push({ embed, pred: (r) => test(this.table, op, readPath(r, c), arg) });
      return this;
    }
    this.filters.push((r) => test(this.table, op, readPath(r, col), arg));
    return this;
  }
  eq(c: string, v: unknown) { return this.add(c, 'eq', v); }
  neq(c: string, v: unknown) { return this.add(c, 'neq', v); }
  gt(c: string, v: unknown) { return this.add(c, 'gt', v); }
  gte(c: string, v: unknown) { return this.add(c, 'gte', v); }
  lt(c: string, v: unknown) { return this.add(c, 'lt', v); }
  lte(c: string, v: unknown) { return this.add(c, 'lte', v); }
  like(c: string, v: unknown) { return this.add(c, 'like', v); }
  ilike(c: string, v: unknown) { return this.add(c, 'ilike', v); }
  is(c: string, v: unknown) {
    if (!c.includes('.') && this.isEmbedName(c)) { this.embedNull.push({ embed: c, isNull: v === null }); return this; }
    return this.add(c, 'is', v);
  }
  in(c: string, v: unknown[]) { return this.add(c, 'in', v); }
  contains(c: string, v: unknown) { return this.add(c, 'cs', v); }
  containedBy(c: string, v: unknown) { return this.add(c, 'cd', v); }
  overlaps(c: string, v: unknown) { return this.add(c, 'ov', v); }
  match(obj: Row) { for (const [k, v] of Object.entries(obj)) this.add(k, 'eq', v); return this; }
  filter(c: string, op: string, v: unknown) {
    if (op.startsWith('not.')) return this.not(c, op.slice(4), v);
    return this.add(c, op, typeof v === 'string' ? (op === 'in' ? parseList(v) : coerce(v)) : v);
  }
  not(c: string, op: string, v: unknown) {
    if (op === 'is' && !c.includes('.') && this.isEmbedName(c)) { this.embedNull.push({ embed: c, isNull: v !== null }); return this; }
    const arg = typeof v === 'string' ? (op === 'in' ? parseList(v) : coerce(v)) : v;
    this.filters.push((r) => !test(this.table, op, readPath(r, c), arg));
    return this;
  }
  or(s: string, opts: { referencedTable?: string; foreignTable?: string } = {}) {
    const ref = opts.referencedTable ?? opts.foreignTable;
    const pred = parseLogic(this.table, s, 'or');
    if (ref) this.embedFilters.push({ embed: ref, pred }); else this.filters.push(pred);
    return this;
  }
  textSearch(): this { throw new DemoQueryError(this.table, 'textSearch'); }

  private isEmbedName(name: string): boolean {
    return /^outreach_/.test(name) && !!this.selectStr && this.selectStr.includes(name);
  }

  // --- modifiers ---
  order(col: string, opts: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string } = {}) {
    const asc = opts.ascending !== false;
    this.orders.push({ col, asc, nullsFirst: opts.nullsFirst ?? !asc, table: opts.referencedTable ?? opts.foreignTable });
    return this;
  }
  range(from: number, to: number) { this.from_ = from; this.to_ = to; return this; }
  limit(n: number) { this.limit_ = n; return this; }
  single() { this.single_ = 'single'; return this; }
  maybeSingle() { this.single_ = 'maybe'; return this; }
  returns() { return this; }
  throwOnError() { return this; }
  abortSignal() { return this; }
  csv(): this { throw new DemoQueryError(this.table, 'csv'); }

  // --- run ---
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, fail?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return new Promise<Result>((resolve) => {
      // a macrotask, like a network round trip: React state settles between a write and the refetch it triggers
      setTimeout(() => {
        try { resolve(this.run()); }
        catch (e) {
          if (e instanceof DemoQueryError) { console.error(e.message); if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('gxdemo:error', { detail: e.message })); }
          const msg = e instanceof Error ? e.message : String(e);
          resolve({ data: null, error: { message: msg, code: (e as { code?: string }).code ?? 'E_DEMO' }, count: null, status: 400, statusText: 'Bad Request' });
        }
      }, 0);
    }).then(ok, fail);
  }

  private matches(r: Row): boolean { return this.filters.every((f) => f(r)); }

  private run(): Result {
    const hooks = tableHooks[this.table];
    hooks?.beforeRead?.(this.store);
    const rows = this.store.t(this.table);
    if (this.op === 'insert' || this.op === 'upsert') {
      const written: Row[] = [];
      const inserted: Row[] = [];
      const updated: Row[] = [];
      for (const p of this.payload) {
        const existing = this.op === 'upsert' ? rows.find((r) => this.onConflict.every((k) => eq(r[k], p[k]))) : undefined;
        if (existing) {
          if (this.ignoreDuplicates) continue;
          const u = this.store.update(this.table, (r) => r === existing, stripReadOnly(p, hooks))[0];
          written.push(u); updated.push(u);
        } else {
          const base = hooks?.beforeInsert ? hooks.beforeInsert({ ...p }, this.store) : p;
          const r = this.store.insert(this.table, base)[0];
          written.push(r); inserted.push(r);
        }
      }
      if (inserted.length) hooks?.afterWrite?.('insert', inserted, this.store);
      if (updated.length) hooks?.afterWrite?.('update', updated, this.store);
      return this.result(this.returning ? this.project(written) : null, written.length);
    }
    if (this.op === 'update') {
      const target = rows.filter((r) => this.matches(r));
      const patch = stripReadOnly(this.payload[0], hooks);
      const set = new Set(target);
      const u = this.store.update(this.table, (r) => set.has(r), patch);
      if (u.length) hooks?.afterWrite?.('update', u, this.store);
      return this.result(this.returning ? this.project(u) : null, u.length);
    }
    if (this.op === 'delete') {
      const target = new Set(rows.filter((r) => this.matches(r)));
      const removed = this.store.remove(this.table, (r) => target.has(r));
      if (removed.length) hooks?.afterWrite?.('delete', removed, this.store);
      return this.result(this.returning ? this.project(removed) : null, removed.length);
    }
    // select
    const items = parseSelect(this.table, this.selectStr ?? '*');
    let out = rows.filter((r) => this.matches(r)).map((r) => ({ src: r, embeds: this.embeds(r, items) }));
    for (const { embed, isNull } of this.embedNull) out = out.filter((x) => (isEmpty(x.embeds[embed]) === isNull));
    for (const it of items) if (it.kind === 'embed' && it.embed.inner) out = out.filter((x) => !isEmpty(x.embeds[it.embed.alias]));
    const top = this.orders.filter((o) => !o.table);
    if (top.length) out.sort((a, b) => sortBy(a.src, b.src, top));
    const count = out.length;
    if (this.from_ != null) out = out.slice(this.from_, (this.to_ ?? this.from_) + 1);
    if (this.limit_ != null) out = out.slice(0, this.limit_);
    const data = out.map((x) => this.shape(x.src, items, x.embeds));
    if (this.head) return this.result(null, count);
    return this.result(data, count);
  }

  private embeds(r: Row, items: SelectItem[]): Record<string, Row | Row[] | null> {
    const out: Record<string, Row | Row[] | null> = {};
    for (const it of items) {
      if (it.kind !== 'embed') continue;
      const { table, alias } = it.embed;
      const rel = relation(this.store, this.table, table);
      const filters = this.embedFilters.filter((f) => f.embed === alias || f.embed === table).map((f) => f.pred);
      const ok = (x: Row) => filters.every((f) => f(x));
      if (rel.kind === 'one') {
        const target = r[rel.fk] == null ? undefined : this.store.t(table).find((x) => eq(x.id, r[rel.fk]));
        out[alias] = target && ok(target) ? this.shape(target, it.embed.cols, this.embedsOf(table, target, it.embed.cols)) : null;
      } else {
        let list = this.store.t(table).filter((x) => eq(x[rel.fk], r.id) && ok(x));
        const ord = this.orders.filter((o) => o.table === alias || o.table === table);
        if (ord.length) list = [...list].sort((a, b) => sortBy(a, b, ord));
        out[alias] = list.map((x) => this.shape(x, it.embed.cols, this.embedsOf(table, x, it.embed.cols)));
      }
    }
    return out;
  }
  /** Nested embeds (an embed inside an embed): no filters apply at that level. */
  private embedsOf(table: string, r: Row, items: SelectItem[]): Record<string, Row | Row[] | null> {
    if (!items.some((i) => i.kind === 'embed')) return {};
    return new DemoQuery(this.store, table).embeds(r, items);
  }

  private shape(r: Row, items: SelectItem[], embeds: Record<string, Row | Row[] | null>): Row {
    const o: Row = {};
    for (const it of items) {
      if (it.kind === 'all') Object.assign(o, clone(r));
      else if (it.kind === 'col') o[it.alias] = clone(r[it.name] ?? null);
      else o[it.embed.alias] = embeds[it.embed.alias] ?? null;
    }
    return o;
  }

  private project(rows: Row[]): Row[] {
    const items = parseSelect(this.table, this.selectStr ?? '*');
    return rows.map((r) => this.shape(r, items, this.embeds(r, items)));
  }

  private result(data: unknown, count: number): Result {
    const status = this.op === 'insert' || this.op === 'upsert' ? 201 : this.op === 'select' ? 200 : 204;
    const c = this.countMode ? count : null;
    if (this.single_ && this.op === 'select' || this.single_ && this.returning) {
      const list = (data as Row[] | null) ?? [];
      if (list.length === 1) return { data: list[0], error: null, count: c, status: 200, statusText: 'OK' };
      if (list.length === 0 && this.single_ === 'maybe') return { data: null, error: null, count: c, status: 200, statusText: 'OK' };
      return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${list.length} rows` }, count: c, status: 406, statusText: 'Not Acceptable' };
    }
    return { data, error: null, count: c, status, statusText: 'OK' };
  }
}

function isEmpty(v: Row | Row[] | null | undefined): boolean { return v == null || (Array.isArray(v) && v.length === 0); }

function stripReadOnly(p: Row, hooks?: TableHooks): Row {
  if (!hooks?.readOnly?.length) return p;
  const o = { ...p };
  for (const k of hooks.readOnly) delete o[k];
  return o;
}

function sortBy(a: Row, b: Row, orders: Order[]): number {
  for (const o of orders) {
    const va = readPath(a, o.col), vb = readPath(b, o.col);
    if (va == null && vb == null) continue;
    if (va == null) return o.nullsFirst ? -1 : 1;
    if (vb == null) return o.nullsFirst ? 1 : -1;
    const c = cmp(va, vb);
    if (c !== 0) return o.asc ? c : -c;
  }
  return 0;
}
