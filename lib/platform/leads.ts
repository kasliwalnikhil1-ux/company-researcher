'use client';

/** Leads (website forms + app sign-ups) for /admin → Leads. SQL side: migrations/platform/002_leads.sql. */
import { getValidAccessToken } from '@/lib/api';
import { rpc, PlatformError, type AccessStatus } from '@/lib/platform/access';

export type LeadSource = 'website_waitlist' | 'website_demo' | 'website_integration' | 'website_contact' | 'website_other' | 'app_signup';
export type LeadStatus = 'new' | 'contacted' | 'booked' | 'converted' | 'ignored';
export const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'booked', 'converted', 'ignored'];

/** Where new sign-ups book their onboarding call (the account gate embeds it). */
export const ONBOARDING_CALENDLY_URL = process.env.NEXT_PUBLIC_ONBOARDING_CALENDLY_URL || 'https://calendly.com/founders-growthxai/20min';

export const SOURCE_LABEL: Record<LeadSource, string> = {
  website_waitlist: 'Waitlist form',
  website_demo: 'Demo request',
  website_integration: 'Integration request',
  website_contact: 'Contact form',
  website_other: 'Website form',
  app_signup: 'App sign-up',
};

export interface LeadAccount { id: string; email: string | null; created_at: string; last_sign_in_at: string | null; status: AccessStatus; is_admin: boolean }

export interface Lead {
  id: string;
  source: LeadSource;
  email: string | null;
  name: string | null;
  company: string | null;
  answers: Record<string, unknown>;
  page: string | null;
  referrer: string | null;
  utm: Record<string, string>;
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  user_agent: string | null;
  status: LeadStatus;
  note: string | null;
  booked_at: string | null;
  booking: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  user_id: string | null;
  account: LeadAccount | null;
  /** other leads with the same email */
  related: number;
}

export interface LeadDetail extends Lead { timeline: Lead[] }

export interface LeadsOverview {
  total: number; forms: number; forms_7d: number; signups: number; signups_7d: number; booked: number; new: number; located: number;
  by_source: Partial<Record<LeadSource, number>>;
  by_country: { country: string; n: number }[];
}

export interface LeadFilter { source?: LeadSource | 'website' | ''; status?: LeadStatus | ''; account?: 'yes' | 'no' | ''; days?: number | ''; country?: string }

export const leadsApi = {
  overview: () => rpc<LeadsOverview>('admin_leads_overview'),
  list: (search: string, filter: LeadFilter, limit = 50, offset = 0) =>
    rpc<{ total: number; rows: Lead[] }>('admin_list_leads', { p_search: search || null, p_filter: filter, p_limit: limit, p_offset: offset }),
  get: (id: string) => rpc<LeadDetail>('admin_get_lead', { p_id: id }),
  set: (id: string, patch: { status?: LeadStatus; note?: string }) => rpc<Lead>('admin_set_lead', { p_id: id, p_patch: patch }),
  remove: (id: string) => rpc<void>('admin_delete_lead', { p_id: id }),
};

/**
 * The signed-in user's own sign-up row: records location on first visit to the gate, and the booked onboarding call.
 * Fire-and-forget; failures are swallowed (the account still works without a lead row).
 */
export async function trackMySignup(body: { booked?: boolean; booking?: { event?: string | null; invitee?: string | null } } = {}): Promise<void> {
  try {
    const token = await getValidAccessToken();
    if (!token) throw new PlatformError('no session', 'E_UNAUTHORIZED');
    const tz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; } })();
    await fetch('/api/leads/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ...body, timezone: tz, referrer: typeof document !== 'undefined' ? document.referrer || undefined : undefined }),
      keepalive: true,
    });
  } catch (e) {
    console.warn('[leads] track failed:', e);
  }
}

/** "IN" → 🇮🇳 (empty for unknown) */
export function flag(country: string | null | undefined): string {
  if (!country || !/^[A-Za-z]{2}$/.test(country)) return '';
  return String.fromCodePoint(...country.toUpperCase().split('').map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "Jaipur, Rajasthan, IN" with whatever is known; "—" when nothing is. */
export function placeOf(l: Pick<Lead, 'city' | 'region' | 'country'>): string {
  const parts = [l.city, l.region, l.country].filter(Boolean) as string[];
  return parts.length ? parts.join(', ') : '—';
}

const ANSWER_LABEL: Record<string, string> = {
  company_type: 'Type', senders: 'Sending accounts', current_tool: 'Current tool', goal: 'Goal', tool: 'Tool requested', route: 'Routed to', mode: 'Call type',
  tier: 'Waitlist tier', message: 'Message', provider: 'Signed up with', form: 'Form',
};
export function answerLabel(key: string): string {
  return ANSWER_LABEL[key] ?? key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
export function answerText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}
