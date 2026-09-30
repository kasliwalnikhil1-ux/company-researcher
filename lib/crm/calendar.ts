'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { CrmError } from './api';

// Google Calendar for the CRM team. The browser never talks to Google: crm-mcp holds the sign-ins (encrypted) and
// proxies every call (supabase/functions/crm-mcp/calendar.ts — the same service the connector tools use).

const BASE = `${process.env.NEXT_PUBLIC_SUPABASE_URL || ''}/functions/v1/crm-mcp/calendar`;

export interface CalendarInfo { id: string; summary: string; primary: boolean; access_role?: string; background_color?: string; timezone?: string }
export interface CalendarAccount {
  id: string; member_id: string; member_name: string; mine: boolean; email: string; label: string | null; aliases: string[]; is_default: boolean;
  can_write: boolean; calendars: CalendarInfo[]; timezone: string | null; auth_state: 'ok' | 'revoked' | string; auth_error: string | null; connected_at: string; last_used_at: string | null;
}
export interface Attendee { email: string; name?: string; response?: 'accepted' | 'declined' | 'tentative' | 'needsAction' | string; organizer?: boolean; self?: boolean; optional?: boolean }
export interface CalendarEvent {
  id: string; account_id: string; account_email: string; member_name: string; mine: boolean; calendar_id: string; calendar_name?: string;
  title: string; start: string; end: string; all_day: boolean; day: string; start_min: number; end_min: number; when: string; tz: string;
  status: string; busy: boolean; organizer: string; organizer_self: boolean; self_response?: string;
  attendees: Attendee[]; meet: string; location: string; html_link: string; description: string; recurring: boolean;
  crm?: { meeting_id: string; company_id?: string; company?: string; contact?: string; status?: string; has_capture?: boolean; deal_id?: string };
}
export type Notify = 'all' | 'externalOnly' | 'none';
export interface FreeSlot { day: string; start: string; end: string; label: string }

async function call<T = any>(op: string, body: Record<string, unknown> = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new CrmError('Please sign in again', 'E_UNAUTHORIZED');
  const r = await fetch(`${BASE}/${op}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new CrmError(j.message ?? `Request failed (${r.status})`, j.code ?? 'E_UNKNOWN', j.remedy);
  return j as T;
}

export const calendarApi = {
  status: () => call<{ configured: boolean; client_kind: 'desktop' | 'web'; callback_url: string }>('status'),
  /** mode 'auto': send the browser to url, Google returns to /crm/calendar/google by itself (app on localhost, or a web client).
   *  mode 'paste': open url in a new tab; the member pastes back the address Google lands on (it does not load) → finish(). */
  connectUrl: (hint?: string, return_to?: string) => call<{ url: string; mode: 'auto' | 'paste'; instructions: string; expires_in: number }>('connect-url', { hint, return_to }),
  finish: (address: string) => call<{ email: string; calendars: number; can_write: boolean; is_default: boolean; warning?: string; note?: string }>('finish', { address }),
  accounts: (refresh?: string) => call<{ configured: boolean; timezone: string; accounts: CalendarAccount[] }>('accounts', { refresh }),
  updateAccount: (account_id: string, p: { label?: string | null; aliases?: string[]; is_default?: boolean }) => call<{ account: CalendarAccount }>('account-update', { account_id, ...p }),
  disconnect: (account_id: string) => call<{ deleted: boolean; email: string; revoked: boolean }>('disconnect', { account_id }),
  events: (p: { from: string; to?: string; days?: number; q?: string; accounts?: 'mine' | 'team' | string[]; calendars?: 'primary' | 'all' | string[]; tz?: string }) =>
    call<{ from: string; to: string; tz: string; accounts: string[]; count: number; events: CalendarEvent[]; errors?: Array<{ account: string; calendar: string; code: string; message: string }> }>('events', p),
  event: (event_id: string, account?: string, calendar?: string) => call<{ event: CalendarEvent }>('event', { event_id, account, calendar }),
  create: (p: {
    account?: string; calendar?: string; title: string; start: string; end?: string; duration_min?: number; all_day?: boolean; attendees?: string[]; description?: string; location?: string;
    meet?: boolean; notify?: Notify; allow_duplicate?: boolean; tz?: string; meeting_id?: string; crm?: { deal_id?: string; contact_id?: string; contact_email?: string; company?: string; contact_name?: string; notes?: string };
  }) => call<{ event: CalendarEvent; created: boolean; duplicate_of?: CalendarEvent; overlaps: Array<{ title: string; when: string }>; notify: Notify; meeting?: { id: string; company_name?: string }; crm_error?: string }>('create', p),
  update: (p: { event_id: string; account?: string; calendar?: string; title?: string; start?: string; end?: string; duration_min?: number; attendees?: string[]; add_attendees?: string[]; remove_attendees?: string[]; description?: string; location?: string; meet?: boolean; notify?: Notify; tz?: string }) =>
    call<{ event: CalendarEvent; overlaps: Array<{ title: string; when: string }>; not_organizer: boolean; meeting_updated: boolean }>('update', p),
  remove: (p: { event_id: string; account?: string; calendar?: string; notify?: Notify }) => call<{ deleted: true; title: string; when: string; account: string; meeting_cancelled: boolean }>('delete', p),
  free: (p: { date?: string; days?: number; duration_min?: number; window?: string; with?: string[]; weekdays?: boolean; accounts?: 'mine' | 'team' | string[]; tz?: string }) =>
    call<{ tz: string; window: string; duration_min: number; checked: string[]; not_visible: string[]; slots: FreeSlot[]; summary: string }>('free', p),
  createForMeeting: (meeting_id: string, p: { account?: string; notify?: Notify; title?: string; meet?: boolean } = {}) => call<{ event: CalendarEvent; created: boolean; already_linked?: boolean; crm_error?: string }>('create-for-meeting', { meeting_id, ...p }),
  syncMeeting: (meeting_id: string, changes: { scheduled_at?: string; duration_min?: number; status?: string; attendees?: string[] }) => call<{ note?: string }>('sync-meeting', { meeting_id, ...changes }),
};

export const calKeys = {
  all: ['crm', 'calendar'] as const,
  accounts: () => ['crm', 'calendar', 'accounts'] as const,
  events: (p: unknown) => ['crm', 'calendar', 'events', p] as const,
};

export function useCalendarAccounts() {
  return useQuery({ queryKey: calKeys.accounts(), queryFn: () => calendarApi.accounts(), staleTime: 60_000 });
}

export function useCalendarEvents(p: { from: string; to: string; accounts: 'mine' | 'team' | string[]; calendars: 'primary' | 'all'; tz: string }, enabled = true) {
  return useQuery({ queryKey: calKeys.events(p), queryFn: () => calendarApi.events(p), enabled, refetchInterval: 120_000 });
}

/** Invalidate everything calendar (and the CRM, since linked meetings change with events). */
export function useCalendarInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['crm'] });
}

// ---------------------------------------------------------------- day helpers (all on 'YYYY-MM-DD' strings — no client tz math)
export const todayIn = (tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export const nowMinutesIn = (tz: string): number => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()); const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0); return (g('hour') % 24) * 60 + g('minute'); };
export const shiftDay = (day: string, n: number): string => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
export const weekdayOf = (day: string): number => { const [y, m, d] = day.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday
export const mondayOf = (day: string): string => shiftDay(day, -((weekdayOf(day) + 6) % 7));
export const fmtDay = (day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }): string => { const [y, m, d] = day.split('-').map(Number); return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', ...opts }).format(new Date(Date.UTC(y, m - 1, d))); };
export const hm = (min: number): string => `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
/** Minutes-of-day of an instant in tz. */
export const minutesIn = (iso: string, tz: string): number => { const p = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)); const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0); return (g('hour') % 24) * 60 + g('minute'); };
export const dayIn = (iso: string, tz: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

/** Stable colour per account (by position in the accounts list). */
export const ACCOUNT_COLORS = [
  { bg: 'bg-indigo-100', border: 'border-indigo-300', text: 'text-indigo-900', dot: 'bg-indigo-500' },
  { bg: 'bg-emerald-100', border: 'border-emerald-300', text: 'text-emerald-900', dot: 'bg-emerald-500' },
  { bg: 'bg-amber-100', border: 'border-amber-300', text: 'text-amber-900', dot: 'bg-amber-500' },
  { bg: 'bg-rose-100', border: 'border-rose-300', text: 'text-rose-900', dot: 'bg-rose-500' },
  { bg: 'bg-sky-100', border: 'border-sky-300', text: 'text-sky-900', dot: 'bg-sky-500' },
  { bg: 'bg-violet-100', border: 'border-violet-300', text: 'text-violet-900', dot: 'bg-violet-500' },
  { bg: 'bg-teal-100', border: 'border-teal-300', text: 'text-teal-900', dot: 'bg-teal-500' },
  { bg: 'bg-orange-100', border: 'border-orange-300', text: 'text-orange-900', dot: 'bg-orange-500' },
];
export const RESPONSE_LABEL: Record<string, string> = { accepted: 'yes', declined: 'no', tentative: 'maybe', needsAction: 'no reply' };
