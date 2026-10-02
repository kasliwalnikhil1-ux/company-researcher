/**
 * The seam between the outreach UI and its data (docs/outreach/PRODUCT-TOUR.md).
 *
 * Every read and write of the outreach UI goes through one `OutreachBackend` (`db` in ./index.ts). Two providers
 * implement it: `real` (Supabase, the product) and `demo` (in-browser data for `/product-tour`). The names the UI may
 * use come from contract.names.ts (generated from the source), so:
 *   - an RPC, edge function or table the contract does not list is a type error at the call site, and
 *   - the demo handler maps are typed over these lists, so a listed name without a demo handler is a type error too.
 */
import type { supabase } from '@/utils/supabase/client';
import { FN_NAMES, RPC_NAMES, TABLE_NAMES } from './contract.names';

export { FN_NAMES, RPC_NAMES, TABLE_NAMES };

/** SQL RPC without the `outreach_` prefix. */
export type RpcName = (typeof RPC_NAMES)[number];
/** Edge function without the `outreach-` prefix. */
export type FnName = (typeof FN_NAMES)[number];
/** A function name, optionally followed by a sub-path or a query string (`voice-admin/inboxes/…`, `imports-create?…`). */
export type FnCall = FnName | `${FnName}/${string}` | `${FnName}?${string}`;
export type TableName = (typeof TABLE_NAMES)[number];

export type RpcArgs = Record<string, unknown>;
export type FnBody = Record<string, unknown>;

export interface FnOpts {
  method?: string;
  /** Return the raw `Response` (downloads, streams). */
  raw?: boolean;
  /** Query string parameters (GET calls). Empty values are dropped. */
  query?: Record<string, string | number | boolean | null | undefined>;
}

type Supabase = typeof supabase;

export interface OutreachBackend {
  readonly kind: 'real' | 'demo';
  /** Same builder API as `supabase.from` (select / insert / update / upsert / delete and the filters the app uses). */
  from(table: TableName): ReturnType<Supabase['from']>;
  /** Resolves with the RPC's data, or rejects with the raw error (`rpc()` in api.ts parses it). */
  rpc(name: RpcName, args: RpcArgs): Promise<{ data: unknown; error: unknown }>;
  /** Calls an edge function: resolves with the parsed JSON (or the Response with `raw`), rejects with an OutreachError. */
  fn(name: FnCall, body: FnBody, opts: FnOpts): Promise<unknown>;
  readonly storage: Supabase['storage'];
  channel(name: string): ReturnType<Supabase['channel']>;
  removeChannel(ch: ReturnType<Supabase['channel']>): Promise<unknown>;
  readonly auth: { getUser(): Promise<{ data: { user: { id: string; email?: string | null } | null } }> };
}
