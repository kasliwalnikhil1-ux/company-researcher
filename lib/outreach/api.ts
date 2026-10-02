'use client';

import { db } from './backend';
import type { FnCall, FnOpts, RpcName } from './backend/contract';
import { parseError } from './errors';

export { OutreachError, parseError, humanize } from './errors';

/**
 * Call an outreach edge function (name without the `outreach-` prefix). Goes through the backend seam: the real
 * provider calls Supabase (with the session token and one 401 retry), the demo provider answers locally.
 */
export async function callFn<T = any>(name: FnCall, body: Record<string, unknown> = {}, opts: FnOpts = {}): Promise<T> {
  return (await db.fn(name, body, opts)) as T;
}

/** Call a SQL RPC (name without the `outreach_` prefix). */
export async function rpc<T = any>(name: RpcName, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(name, args);
  if (error) throw parseError(error);
  return data as T;
}
