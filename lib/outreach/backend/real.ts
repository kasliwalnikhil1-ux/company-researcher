/**
 * The real provider: the product's Supabase project. This is today's behaviour moved into one file, and the only file
 * of the outreach UI allowed to import the Supabase client or call `fetch` for data (lint rule, demo check).
 */
import { supabase } from '@/utils/supabase/client';
import { getValidAccessToken } from '@/lib/api';
import { OutreachError } from '../errors';
import type { FnBody, FnCall, FnOpts, OutreachBackend, RpcArgs, RpcName, TableName } from './contract';

const FUNCTIONS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1`;

function queryString(q: FnOpts['query']): string {
  if (!q) return '';
  const parts = Object.entries(q)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function fn(name: FnCall, body: FnBody, opts: FnOpts): Promise<unknown> {
  const token = await getValidAccessToken();
  if (!token) throw new OutreachError('Your session has expired. Sign in again.', 'E_FORBIDDEN');
  const method = opts.method ?? 'POST';
  const doFetch = (t: string) => fetch(`${FUNCTIONS_BASE}/outreach-${name}${queryString(opts.query)}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${t}`,
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  let res = await doFetch(token);
  // A token that looks valid locally can still be rejected (session ended elsewhere, clock skew): refresh once and retry.
  if (res.status === 401) {
    const refreshed = await getValidAccessToken({ forceRefresh: true });
    if (!refreshed) throw new OutreachError('Your session has expired. Sign in again.', 'E_FORBIDDEN');
    res = await doFetch(refreshed);
  }
  if (opts.raw) return res;
  const text = await res.text();
  let data: any = null;   // eslint-disable-line @typescript-eslint/no-explicit-any
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    if (res.status === 401) throw new OutreachError('Your session has expired. Sign in again.', 'E_FORBIDDEN', data);
    throw new OutreachError(data?.message ?? data?.error ?? `Request failed (${res.status})`, data?.code ?? `E_HTTP_${res.status}`, data);
  }
  return data;
}

export const realBackend: OutreachBackend = {
  kind: 'real',
  from: (table: TableName) => supabase.from(table),
  rpc: async (name: RpcName, args: RpcArgs) => {
    const { data, error } = await supabase.rpc(`outreach_${name}`, args);
    return { data, error };
  },
  fn,
  storage: supabase.storage,
  channel: (name) => supabase.channel(name),
  removeChannel: (ch) => supabase.removeChannel(ch),
  auth: { getUser: () => supabase.auth.getUser() },
};
