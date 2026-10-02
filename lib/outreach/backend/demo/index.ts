/**
 * The demo provider (`/product-tour`): the same `OutreachBackend` interface as the real one, answered entirely in the
 * browser. Loaded lazily by backend/index.ts, so none of this (seed, handlers, simulator) ships with `/outreach`.
 *
 * This folder must never reach a production service: no imports of `@/utils/supabase/client`, `@/lib/api` or
 * `backend/real`, and no `fetch` / XHR / WebSocket / sendBeacon (ESLint rules + the import-graph check in
 * scripts/outreach-demo-check.ts). Relative imports only.
 */
import { OutreachError } from '../../errors';
import type { FnBody, FnCall, FnOpts, OutreachBackend, RpcArgs, RpcName } from '../contract';
import { makeCtx, type Ctx } from './ctx';

export { notYetCalls } from './ctx';
import { fnHandlers } from './fn';
import { DemoQuery, DemoQueryError } from './query';
import { DemoChannel } from './realtime';
import { registerAll, rpcHandlers } from './rpc';
import { buildSeed } from './seed';
import { DEMO_USER_EMAIL, DEMO_USER_ID } from './seed/ids';
import { registerDerivedTables } from './sim/derived';
import { Simulator } from './sim/clock';
import { engineFor } from './sim/engine';
import { demoStorage } from './storage';
import { clone, DemoStore } from './store';

export interface DemoRuntime {
  store: DemoStore;
  sim: Simulator;
  ctx: Ctx;
  /** Clears every saved `gxdemo:` key and rebuilds the starting data in place. */
  reset(): void;
}

let runtime: DemoRuntime | null = null;

function boot(): DemoRuntime {
  registerDerivedTables();
  registerAll();
  const saved = typeof window !== 'undefined' ? DemoStore.load() : null;
  const store = new DemoStore(saved ?? buildSeed());
  if (!saved) store.flush();
  const sim = new Simulator(store);
  const ctx = makeCtx(store);
  engineFor(store);
  const rt: DemoRuntime = {
    store, sim, ctx,
    reset() {
      DemoStore.clearSaved();
      const fresh = buildSeed();
      store.state = fresh;
      store.rev++;
      store.persistent = true;
      store.flush();
      sim.setMode('on');
    },
  };
  if (typeof window !== 'undefined') {
    // a full-page navigation inside the demo (connect screens, checkout returns) keeps the visitor's changes
    window.addEventListener('pagehide', () => store.flush());
  }
  return rt;
}

export function demoRuntime(): DemoRuntime {
  if (!runtime) runtime = boot();
  return runtime;
}

/** A short pause, like a round trip, so loading states and optimistic updates behave as in the product. */
let calls = 0;
const latency = () => new Promise((r) => setTimeout(r, 40 + ((calls++ * 37) % 80)));

function parseFnCall(name: FnCall): { base: string; path: string; query: URLSearchParams } {
  const q = name.indexOf('?');
  const head = q >= 0 ? name.slice(0, q) : name;
  const query = new URLSearchParams(q >= 0 ? name.slice(q + 1) : '');
  const slash = head.indexOf('/');
  return { base: slash >= 0 ? head.slice(0, slash) : head, path: slash >= 0 ? head.slice(slash) : '', query };
}

export function createDemoBackend(): OutreachBackend {
  const rt = demoRuntime();
  const storage = demoStorage();
  return {
    kind: 'demo',
    from: (table) => new DemoQuery(rt.store, table) as never,
    async rpc(name: RpcName, args: RpcArgs) {
      await latency();
      const h = rpcHandlers[name];
      if (!h) return { data: null, error: { message: `E_DEMO_MISSING: no demo handler for ${name}` } };
      try {
        const data = await h(args ?? {}, rt.ctx);
        return { data: clone(data === undefined ? null : data), error: null };
      } catch (e) {
        const err = e as { message?: string; code?: string };
        if (e instanceof DemoQueryError) console.error(e.message);
        return { data: null, error: { message: err.message ?? String(e), code: err.code } };
      }
    },
    async fn(name: FnCall, body: FnBody, opts: FnOpts) {
      await latency();
      const { base, path, query } = parseFnCall(name);
      for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== null && v !== undefined && v !== '') query.set(k, String(v));
      const h = (fnHandlers as Record<string, (typeof fnHandlers)[keyof typeof fnHandlers]>)[base];
      if (!h) throw new OutreachError(`No demo handler for ${base}`, 'E_DEMO_MISSING');
      try {
        const out = await h({ body: (body ?? {}) as Record<string, unknown>, path, query, method: opts.method ?? 'POST', raw: !!opts.raw }, rt.ctx);
        if (opts.raw) return out instanceof Response ? out : new Response(JSON.stringify(out ?? null), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return clone(out === undefined ? null : out);
      } catch (e) {
        if (e instanceof OutreachError) throw e;
        const msg = (e as Error).message ?? String(e);
        const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(msg);
        throw new OutreachError(m ? (m[2] || m[1]) : msg, m ? m[1] : 'E_DEMO');
      }
    },
    storage: storage as never,
    channel: (name: string) => new DemoChannel(rt.store, name) as never,
    removeChannel: (ch) => (ch as unknown as DemoChannel).unsubscribe(),
    auth: { getUser: async () => ({ data: { user: { id: DEMO_USER_ID, email: DEMO_USER_EMAIL } } }) },
  };
}
