/**
 * `db.channel()` in demo mode: the same `.on('postgres_changes', { table, filter }, cb).subscribe()` API, fed by the
 * demo store's change events instead of a websocket. Filters of the form `col=eq.value` are honoured.
 */
import type { ChangeEvent, DemoStore, Row } from './store';

type Binding = { event: string; table?: string; filter?: { col: string; value: string } | null; cb: (p: unknown) => void };

export class DemoChannel {
  private bindings: Binding[] = [];
  private off: (() => void) | null = null;
  constructor(private store: DemoStore, readonly topic: string) {}

  on(type: string, opts: { event?: string; table?: string; filter?: string } | Record<string, unknown>, cb: (p: unknown) => void): this {
    if (type !== 'postgres_changes') return this;   // broadcast / presence: nothing to deliver in the demo
    const o = opts as { event?: string; table?: string; filter?: string };
    const m = o.filter ? /^(\w+)=eq\.(.+)$/.exec(o.filter) : null;
    this.bindings.push({ event: o.event ?? '*', table: o.table, filter: m ? { col: m[1], value: m[2] } : null, cb });
    return this;
  }

  subscribe(cb?: (status: string) => void): this {
    if (!this.off) this.off = this.store.subscribe((e) => this.deliver(e));
    setTimeout(() => cb?.('SUBSCRIBED'), 0);
    return this;
  }

  unsubscribe(): Promise<'ok'> { this.off?.(); this.off = null; return Promise.resolve('ok'); }

  // supabase-js channel methods some code may call
  send(): Promise<'ok'> { return Promise.resolve('ok'); }
  track(): Promise<'ok'> { return Promise.resolve('ok'); }
  untrack(): Promise<'ok'> { return Promise.resolve('ok'); }
  presenceState(): Record<string, unknown> { return {}; }

  private deliver(e: ChangeEvent) {
    for (const b of this.bindings) {
      if (b.table && b.table !== e.table) continue;
      if (b.event !== '*' && b.event !== e.eventType) continue;
      const row: Row | null = e.new ?? e.old;
      if (b.filter && (!row || String(row[b.filter.col]) !== b.filter.value)) continue;
      // async, like a websocket message
      setTimeout(() => b.cb({ schema: 'public', table: e.table, eventType: e.eventType, commit_timestamp: new Date().toISOString(), new: e.new ?? {}, old: e.old ?? {}, errors: null }), 0);
    }
  }
}
