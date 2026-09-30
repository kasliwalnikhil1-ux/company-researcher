'use client';

import { useCallback, useSyncExternalStore } from 'react';

// Time zones for the calendar. The grid, agenda and event form can be viewed in any IANA zone; the choice is per
// browser (localStorage) and is sent to crm-mcp as `tz`, which does the actual conversion server-side. Presets cover
// the zones the team works across; "Custom…" searches the full IANA list the browser ships with.

export interface TzOption { tz: string; label: string }
export interface TzGroup { group: string; items: TzOption[] }

const US: TzOption[] = [
  { tz: 'America/New_York', label: 'Eastern · New York' },
  { tz: 'America/Chicago', label: 'Central · Chicago' },
  { tz: 'America/Denver', label: 'Mountain · Denver' },
  { tz: 'America/Los_Angeles', label: 'Pacific · Los Angeles' },
];

export const CUSTOM_TZ = '__custom__';
const STORAGE_KEY = 'crm.calendar.tz';

/** 'Asia/Kolkata' → 'Kolkata', 'America/New_York' → 'New York'. */
export const tzShort = (tz: string): string => (tz.split('/').pop() ?? tz).replace(/_/g, ' ');

export function validTz(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Preset groups: team default, this device (when it is something else), India, US, UK. */
export function tzPresets(teamTz: string): TzGroup[] {
  const groups: TzGroup[] = [{ group: 'Default', items: [{ tz: teamTz, label: `Team default · ${tzShort(teamTz)}` }] }];
  const device = typeof Intl !== 'undefined' ? Intl.DateTimeFormat().resolvedOptions().timeZone : undefined;
  if (device && device !== teamTz && validTz(device)) groups[0].items.push({ tz: device, label: `This device · ${tzShort(device)}` });
  groups.push(
    { group: 'India', items: [{ tz: 'Asia/Kolkata', label: 'India · Kolkata (IST)' }] },
    { group: 'US', items: US },
    { group: 'UK', items: [{ tz: 'Europe/London', label: 'UK · London' }] },
  );
  return groups;
}

let cachedAll: string[] | null = null;
/** Every IANA zone the browser knows (falls back to the presets on very old engines). */
export function allTimezones(): string[] {
  if (cachedAll) return cachedAll;
  const sv = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let list: string[] = [];
  try { list = sv ? sv.call(Intl, 'timeZone') : []; } catch { list = []; }
  if (list.length === 0) list = ['Asia/Kolkata', 'Europe/London', 'UTC', ...US.map((u) => u.tz)];
  if (!list.includes('UTC')) list = ['UTC', ...list];
  cachedAll = list;
  return list;
}

function parts(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: g('year'), m: g('month'), d: g('day'), hh: g('hour') % 24, mm: g('minute'), ss: g('second') };
}

/** Offset of tz from UTC in minutes at instant d (east positive). */
export function tzOffsetMin(tz: string, d = new Date()): number {
  const p = parts(d, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}

/** 'UTC+5:30', 'UTC-4', 'UTC'. */
export function tzOffsetLabel(tz: string, d = new Date()): string {
  const o = tzOffsetMin(tz, d);
  if (o === 0) return 'UTC';
  const sign = o < 0 ? '-' : '+', a = Math.abs(o), h = Math.floor(a / 60), m = a % 60;
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

/** Wall-clock time in tz → instant (same two-pass approach as the server). */
export function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMin(tz, new Date(guess)) * 60000;
  t = guess - tzOffsetMin(tz, new Date(t)) * 60000;
  return new Date(t);
}

/** The same instant as (day, minutes-of-day in fromTz) expressed in toTz. */
export function convertWallClock(day: string, min: number, fromTz: string, toTz: string): { day: string; min: number; dayDelta: number } {
  const [y, m, d] = day.split('-').map(Number);
  const at = zoned(y, m, d, Math.floor(min / 60), min % 60, fromTz);
  const p = parts(at, toTz);
  const outDay = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const dayDelta = Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(y, m - 1, d)) / 86400000);
  return { day: outDay, min: p.hh * 60 + p.mm, dayDelta };
}

// The stored choice as an external store (useSyncExternalStore): no hydration mismatch (the server snapshot is
// "unknown"), and other tabs follow via the storage event. `memory` covers browsers where localStorage throws.
let memory: string | null = null;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => { listeners.add(cb); window.addEventListener('storage', cb); return () => { listeners.delete(cb); window.removeEventListener('storage', cb); }; };
const readStored = (): string | null => { try { return window.localStorage.getItem(STORAGE_KEY) ?? memory; } catch { return memory; } };
const serverSnapshot = (): string | null | undefined => undefined;

/**
 * The zone the calendar is viewed in. Starts as the team zone, remembers the last choice in this browser.
 * `ready` is false during server render / hydration (avoids one wasted fetch in the team zone on first paint).
 */
export function useViewTimezone(teamTz: string): [string, (tz: string) => void, boolean] {
  const stored = useSyncExternalStore(subscribe, readStored, serverSnapshot);
  const setTz = useCallback((next: string) => {
    if (!validTz(next)) return;
    memory = next === teamTz ? null : next;
    try { if (next === teamTz) window.localStorage.removeItem(STORAGE_KEY); else window.localStorage.setItem(STORAGE_KEY, next); } catch { /* memory only */ }
    listeners.forEach((l) => l());
  }, [teamTz]);
  return [validTz(stored) ? stored : teamTz, setTz, stored !== undefined];
}
