'use client';

import { supabase } from '@/utils/supabase/client';
import { parseError } from '@/lib/outreach/api';

/**
 * Merge a patch into `outreach_workspaces.settings` (owner only, RLS).
 * Reads the row first so a second open tab cannot silently undo another setting.
 * `ai_auto_send` was removed in migration 015; it is dropped here too in case a cached copy still carries it.
 */
export async function saveWorkspaceSettings(workspaceId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const cur = await supabase.from('outreach_workspaces').select('settings').eq('id', workspaceId).single();
  if (cur.error) throw parseError(cur.error);
  const next: Record<string, unknown> = { ...((cur.data?.settings as Record<string, unknown> | null) ?? {}), ...patch };
  delete next.ai_auto_send;
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const { data, error } = await supabase.from('outreach_workspaces').update({ settings: next }).eq('id', workspaceId).select('id');
  if (error) throw parseError(error);
  if (!data?.length) throw parseError(new Error('E_FORBIDDEN: only the workspace owner can change these settings'));
  return next;
}

const FALLBACK_TIMEZONES = [
  'UTC', 'America/Los_Angeles', 'America/Denver', 'America/Chicago', 'America/New_York', 'America/Toronto', 'America/Mexico_City', 'America/Sao_Paulo',
  'Europe/London', 'Europe/Dublin', 'Europe/Lisbon', 'Europe/Madrid', 'Europe/Paris', 'Europe/Amsterdam', 'Europe/Berlin', 'Europe/Rome', 'Europe/Stockholm',
  'Europe/Warsaw', 'Europe/Athens', 'Europe/Istanbul', 'Africa/Lagos', 'Africa/Cairo', 'Africa/Johannesburg', 'Asia/Dubai', 'Asia/Karachi', 'Asia/Kolkata',
  'Asia/Dhaka', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Perth', 'Australia/Sydney', 'Pacific/Auckland',
];

/** IANA names the browser knows. `UTC` is always first. */
export function timezoneOptions(current?: string | null): string[] {
  let list: string[] = [];
  try { list = ((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone')) ?? []; } catch { list = []; }
  if (!list.length) list = FALLBACK_TIMEZONES;
  const set = new Set<string>(['UTC', ...list]);
  if (current) set.add(current);
  return [...set];
}

export function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

export function nowIn(tz: string): string {
  try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(new Date()); } catch { return ''; }
}

export const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'SGD', 'AED', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'ZAR', 'JPY', 'NZD'];
