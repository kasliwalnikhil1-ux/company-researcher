/**
 * What every demo handler gets, and the types that make the handler maps complete (docs/outreach/PRODUCT-TOUR.md §6):
 * `RpcHandlers` has one key per name in contract.names.ts, so a new RPC without a demo handler does not compile.
 */
import { demoUi } from '../../demoUi';
import type { FnName, RpcName } from '../contract';
import type { DemoStore, Row } from './store';
import { DEMO_USER_ID, DEMO_WS_ID } from './seed/ids';

export interface Ctx {
  store: DemoStore;
  /** The demo workspace. */
  ws: string;
  /** The demo user (the workspace owner). */
  userId: string;
  ui: typeof demoUi;
  /** The real current time, ISO. Rows are stamped with it. */
  now(): string;
}

export interface FnRequest {
  body: Record<string, any>;   // eslint-disable-line @typescript-eslint/no-explicit-any
  /** Sub-path after the function name, e.g. `/inboxes/<id>/voice/draft` for `voice-admin/inboxes/<id>/voice/draft`. */
  path: string;
  query: URLSearchParams;
  method: string;
  /** The caller wants a Response (downloads, streams). */
  raw: boolean;
}

export type RpcHandler = (args: Record<string, any>, ctx: Ctx) => unknown;   // eslint-disable-line @typescript-eslint/no-explicit-any
export type FnHandler = (req: FnRequest, ctx: Ctx) => unknown;
/** Complete maps: the build fails if a contract name has no handler. */
export type RpcHandlers = { [K in RpcName]: RpcHandler };
export type FnHandlers = { [K in FnName]: FnHandler };
/** One area's share of the map (rpc/<area>.ts): only contract names, checked when the areas are combined. */
export type RpcArea = Partial<RpcHandlers>;
export type FnArea = Partial<FnHandlers>;

export function makeCtx(store: DemoStore): Ctx {
  return { store, ws: DEMO_WS_ID, userId: DEMO_USER_ID, ui: demoUi, now: () => store.nowIso() };
}

/** Throws the way the database does: `E_CODE: message` (parseError in api.ts turns it into an OutreachError). */
export function demoError(code: string, message?: string): never {
  throw Object.assign(new Error(message ? `${code}: ${message}` : code), { code });
}

/** Rows of `table` in the demo workspace. */
export function inWs(ctx: Ctx, table: string, pred: (r: Row) => boolean = () => true): Row[] {
  return ctx.store.t(table).filter((r) => (r.workspace_id === undefined || r.workspace_id === ctx.ws) && pred(r));
}

/** Count of `notYet` handlers called (the demo check reports it; must be 0 once the build-out is finished). */
export const notYetCalls = new Map<string, number>();
/**
 * Build-out marker: a correctly typed empty result plus a "Not in the demo yet" note. The demo check counts these; the
 * allowed number after Phase 3 is 0 (scripts/outreach-demo-check.ts).
 */
export function notYet<T>(name: string, value: T): T {
  notYetCalls.set(name, (notYetCalls.get(name) ?? 0) + 1);
  demoUi.toast('Not in the demo yet');
  return value;
}

export const NOT_YET_MARKER = 'notYet(';

/** Days → ms. */
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
export const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();
export const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
/** YYYY-MM-DD in UTC. */
export const dayOf = (d: Date | string | number = Date.now()) => new Date(d).toISOString().slice(0, 10);
