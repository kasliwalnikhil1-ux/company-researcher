/**
 * `db`: the outreach UI's one door to its data. It picks the provider once per page load from the URL (`IS_DEMO`):
 * the real Supabase provider for `/outreach`, the in-browser demo provider for `/product-tour`.
 *
 * The demo provider (its handlers and seed data) is downloaded only on `/product-tour`: `DemoProvider` awaits
 * `loadDemoBackend()` before it renders any outreach screen. In demo mode `db` never falls back to the real provider.
 */
import { IS_DEMO } from '../mode';
import type { OutreachBackend } from './contract';
import { realBackend } from './real';

let demo: OutreachBackend | null = null;
let loading: Promise<OutreachBackend> | null = null;

export function loadDemoBackend(): Promise<OutreachBackend> {
  if (!IS_DEMO) return Promise.reject(new Error('E_DEMO_MODE: the demo backend only runs on /product-tour'));
  if (!loading) loading = import('./demo').then((m) => (demo = m.createDemoBackend()));
  return loading;
}

function active(): OutreachBackend {
  if (!IS_DEMO) return realBackend;
  if (!demo) throw new Error('E_DEMO_NOT_READY: the demo backend has not loaded yet');
  return demo;
}

export const db: OutreachBackend = {
  get kind() { return active().kind; },
  from: (table) => active().from(table),
  rpc: (name, args) => active().rpc(name, args),
  fn: (name, body, opts) => active().fn(name, body, opts),
  get storage() { return active().storage; },
  channel: (name) => active().channel(name),
  removeChannel: (ch) => active().removeChannel(ch),
  get auth() { return active().auth; },
};
