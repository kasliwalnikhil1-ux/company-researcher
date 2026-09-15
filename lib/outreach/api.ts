'use client';

import { supabase } from '@/utils/supabase/client';
import { getValidAccessToken } from '@/lib/api';

const FUNCTIONS_BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1`;

export class OutreachError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code = 'E_UNKNOWN', details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Parse `E_CODE: message` style errors raised by SQL functions / edge functions. */
export function parseError(err: unknown): OutreachError {
  if (err instanceof OutreachError) return err;
  const raw = (err as any)?.message ?? (err as any)?.error ?? String(err);
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(String(raw).trim());
  if (m) return new OutreachError(m[2] || humanize(m[1]), m[1], (err as any)?.details);
  return new OutreachError(String(raw), 'E_UNKNOWN', err);
}

export function humanize(code: string): string {
  const map: Record<string, string> = {
    E_BUDGET_EXHAUSTED: 'Daily budget exhausted',
    E_OUT_OF_SCHEDULE: 'Outside the sender schedule',
    E_SENDER_NOT_OK: 'Sender is not connected',
    E_LEAD_SUPPRESSED: 'Lead is suppressed',
    E_RELATION_REQUIRED: 'A 1st-degree connection is required',
    E_NOTE_TOO_LONG: 'Invitation note is too long',
    E_NO_MAILBOX: 'No mailbox in the sender pool',
    E_NO_EMAIL: 'Lead has no email',
    E_INMAIL_NO_CREDIT: 'No InMail credits',
    E_CAP_HIT_WEEKLY: 'Weekly invitation cap reached',
    E_PAYLOAD_INVALID: 'Invalid payload',
    E_GRAPH_INVALID: 'Sequence graph is invalid',
    E_POOL_EMPTY: 'Add at least one sender to the pool',
    E_SENDER_NOT_IN_POOL: 'Sender is not in the pool',
    E_DUPLICATE_ENROLLMENT: 'Lead is already enrolled with this sender',
    E_PLAN_SUSPENDED: 'Workspace is suspended (billing)',
    E_RATE_LIMITED: 'Too many requests, slow down',
    E_FORBIDDEN: 'You do not have permission',
    E_NOT_FOUND: 'Not found',
    E_CAP_ABOVE_CEILING: 'Cap is above the platform ceiling',
    E_INFLIGHT: 'Sequence has in-flight enrollments',
    E_INVITE_EXPIRED: 'Invitation expired',
    E_INVITE_USED: 'Invitation already used',
    E_INVITE_EMAIL_MISMATCH: 'Sign in with the invited email address',
  };
  return map[code] ?? code;
}

/** Call an outreach edge function (name without the `outreach-` prefix). */
export async function callFn<T = any>(name: string, body: Record<string, unknown> = {}, opts: { method?: string; raw?: boolean } = {}): Promise<T> {
  const token = await getValidAccessToken();
  if (!token) throw new OutreachError('Not signed in', 'E_FORBIDDEN');
  const res = await fetch(`${FUNCTIONS_BASE}/outreach-${name}`, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
    },
    body: opts.method === 'GET' ? undefined : JSON.stringify(body),
  });
  if (opts.raw) return res as unknown as T;
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) {
    throw new OutreachError(data?.message ?? data?.error ?? `Request failed (${res.status})`, data?.code ?? `E_HTTP_${res.status}`, data);
  }
  return data as T;
}

/** Call a SQL RPC (name without the `outreach_` prefix). */
export async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(`outreach_${name}` as any, args as any);
  if (error) throw parseError(error);
  return data as T;
}

export function fnUrl(name: string): string {
  return `${FUNCTIONS_BASE}/outreach-${name}`;
}
