'use client';

import { supabase } from '@/utils/supabase/client';

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
  if (m) return new CrmError(m[2] || humanize(m[1]), m[1], (err as any)?.details);
  return new CrmError(String(raw), 'E_UNKNOWN', err);
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
