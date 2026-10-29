'use client';

import { supabase } from '@/utils/supabase/client';
import { friendlyErrorText } from '@/lib/aiErrorMessage';

export class CrmError extends Error {
  code: string;
  details?: unknown;
  constructor(message: string, code = 'E_UNKNOWN', details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Parse `E_CODE: message` style errors raised by the crm_* SQL functions and triggers. */
export function parseError(err: unknown): CrmError {
  if (err instanceof CrmError) return err;
  const raw = (err as any)?.message ?? (err as any)?.error ?? String(err);
  const m = /^(E_[A-Z_]+)(?::\s*([\s\S]*))?$/.exec(String(raw).trim());
  if (m) return new CrmError(friendlyErrorText(m[2] || humanize(m[1])), m[1], (err as any)?.details);
  return new CrmError(friendlyErrorText(String(raw)), 'E_UNKNOWN', err);
}

export function humanize(code: string): string {
  const map: Record<string, string> = {
    E_FORBIDDEN: 'You are not on the CRM team',
    E_UNAUTHORIZED: 'Please sign in again',
    E_NOT_FOUND: 'Not found',
    E_PAYLOAD_INVALID: 'Invalid input',
    E_CAPTURE_INCOMPLETE: 'The capture is missing required fields',
    E_CAPTURE_REQUIRED: 'Capture the meeting first',
    E_CAPTURE_MISMATCH: 'Capture outcome does not match',
    E_ALREADY_CAPTURED: 'This meeting already has a capture',
    E_CAPTURE_LOCKED: 'Captures of held/no-show meetings cannot be deleted',
    E_MEETING_CANCELLED: 'The meeting is cancelled',
    E_STAGE_BACKWARD: 'Moving a deal backwards needs a reason',
    E_UNKNOWN_CURRENCY: 'Unknown currency — add an FX rate in Settings',
    E_LAST_MEMBER: 'At least one active member must remain',
  };
  return map[code] ?? code;
}

/**
 * POST to a crm-mcp edge-function route with the member's access token.
 *
 * PostgREST only checks the JWT signature and expiry, but crm-mcp verifies the token with the auth
 * server, which also checks that the session still exists. A session can be deleted under a token
 * that is still valid for hours (sign-out on another device, revoked by an admin), so the rest of
 * the CRM keeps working while every calendar / recording call answers E_UNAUTHORIZED. When that
 * happens we refresh the session once and retry; if the refresh fails too the sign-in is gone for
 * good, so we end it locally and send the member to the login page instead of leaving a half-dead app.
 */
export async function callFunction<T = any>(base: string, op: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  let token = data.session?.access_token;
  if (!token) throw new CrmError('Please sign in again', 'E_UNAUTHORIZED');
  const attempt = async (t: string) => {
    const r = await fetch(`${base}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  let { r, j } = await attempt(token);
  if (r.status === 401 || j?.code === 'E_UNAUTHORIZED') {
    const { data: refreshed, error } = await supabase.auth.refreshSession();
    if (refreshed?.session?.access_token && !error) {
      token = refreshed.session.access_token;
      ({ r, j } = await attempt(token));
    }
    if (r.status === 401 || j?.code === 'E_UNAUTHORIZED') {
      await endSession();
      throw new CrmError('Your sign-in ended (signed out on another device, or the session was revoked). Please sign in again.', 'E_UNAUTHORIZED');
    }
  }
  if (!r.ok || j.error) throw new CrmError(friendlyErrorText(j.message ?? `Request failed (${r.status})`), j.code ?? 'E_UNKNOWN', j.remedy);
  return j as T;
}

let ending = false;
async function endSession(): Promise<void> {
  if (ending || typeof window === 'undefined') return;
  ending = true;
  try { await supabase.auth.signOut({ scope: 'local' }); } catch { /* the server already dropped it */ }
  const next = window.location.pathname + window.location.search;
  // a full navigation on purpose: the whole React tree (queries, CRM context) belongs to the dead session
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign(`/login?error=session_ended&next=${encodeURIComponent(next)}`);
}

/** Call a crm_* SQL RPC (name without the `crm_` prefix). */
export async function rpc<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(`crm_${name}` as any, args as any);
  if (error) throw parseError(error);
  return data as T;
}

/** Drop undefined keys so jsonb payloads only carry what was set (key presence = "set this field"). */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  const r: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r as Partial<T>;
}
