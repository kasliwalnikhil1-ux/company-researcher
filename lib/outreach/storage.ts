/**
 * Browser storage for the outreach UI (saved filters, table layouts, drafts, the chosen workspace).
 * Same calls as `localStorage`. Real mode IS `localStorage`; demo mode keeps everything in `sessionStorage` under the
 * `gxdemo:` prefix, so the tour never reads or overwrites a real user's saved state, and "Reset demo" clears it.
 */
import { IS_DEMO } from './mode';

export const DEMO_KEY_PREFIX = 'gxdemo:';

type KV = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const demoKv: KV = {
  getItem: (k) => window.sessionStorage.getItem(DEMO_KEY_PREFIX + k),
  setItem: (k, v) => window.sessionStorage.setItem(DEMO_KEY_PREFIX + k, v),
  removeItem: (k) => window.sessionStorage.removeItem(DEMO_KEY_PREFIX + k),
};

/** Storage-like; every call can throw (blocked storage), exactly like `localStorage`. */
export const kv: KV = {
  getItem: (k) => (IS_DEMO ? demoKv : window.localStorage).getItem(k),
  setItem: (k, v) => (IS_DEMO ? demoKv : window.localStorage).setItem(k, v),
  removeItem: (k) => (IS_DEMO ? demoKv : window.localStorage).removeItem(k),
};
