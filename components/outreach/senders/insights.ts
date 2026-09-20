'use client';

/**
 * Types and hooks for the sender insights, activity report, diagnosis, running-dry state and tracking domains.
 * Every number and every sentence comes from an `outreach_*` RPC: nothing is re-computed here.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from '@/lib/outreach/api';
import type { ActionType, Sender, SenderStatus } from '@/lib/outreach/types';

// ---------------------------------------------------------------------------
// Sender columns added by migrations 010 / 015 (the shared Sender type may not list them yet)
// ---------------------------------------------------------------------------
export type SenderV2 = Sender & {
  alert_emails?: string[] | null;
  booking_link?: string | null;
  signature?: string | null;
  bcc_address?: string | null;
  monthly_cost?: number | string | null;
  parent_sender_id?: string | null;
  track_replies?: boolean | null;
  running_dry_at?: string | null;
};

export const isMailbox = (s: Pick<Sender, 'provider'>) => s.provider !== 'LINKEDIN';
export const hasInMail = (s: Pick<Sender, 'provider' | 'is_premium' | 'has_sales_nav' | 'has_recruiter'>) => s.provider === 'LINKEDIN' && (s.is_premium || s.has_sales_nav || s.has_recruiter);

// ---------------------------------------------------------------------------
// sender_insights
// ---------------------------------------------------------------------------
export type Severity = 'high' | 'medium' | 'low' | 'ok';
export interface Recommendation { severity: Severity; area: string; text: string }
export interface InvitesVsCapPoint { day: string; sent: number; cap: number }

export interface SenderInsights {
  sender: { id: string; name: string | null; status: SenderStatus; health: number; level: number };
  health_breakdown: Record<string, number>;
  recommendations: Recommendation[];
  warmup: {
    level: number; max_level: number; locked_until: string | null; health_high_since: string | null; next_level_on: string | null; unlocks: string;
    caps_now: Partial<Record<ActionType, number>>; caps_next: Partial<Record<ActionType, number>>;
  };
  last_30_days: {
    headroom_pct: number | null; limit_hits: number; acceptance_rate: number | null; acceptance_rate_previous: number | null;
    network_growth: number | null; network_growth_source: 'connections_count' | 'accepted_invitations';
    invites: number; accepted: number; replies: number; reply_rate: number | null;
  };
  invites_vs_cap: InvitesVsCapPoint[];
  inmail_guard: { max_today: number | null; rule: string };
}

// ---------------------------------------------------------------------------
// report_sender (totals keys are the shared ones from outreach__totals_from)
// ---------------------------------------------------------------------------
export interface ReportTotals {
  enrolled: number; invites: number; invites_with_note: number; accepted: number; acceptance_rate: number | null;
  messages: number; inmails: number; emails: number; touches: number; replies: number; reply_rate: number | null;
  interested: number; interested_rate: number | null; positive_reply_rate: number | null; negative_reply_rate: number | null;
  intents: Record<string, number>; meetings: number; won: number; lost: number; won_value: number; inbound_messages: number;
  profile_views: number; likes: number; comments: number; endorsements: number; follows: number; withdrawn: number; post_fetches: number;
  failed: number; skipped: number; limit_hits: number; email_opened: number; email_clicked: number; email_bounced: number;
  open_rate: number | null; click_rate: number | null; bounce_rate: number | null;
}

export interface SenderRestriction { at: string; kind: 'reject' | 'checkpoint' | 'status' | string; data: Record<string, unknown> | null }

export interface SenderReport {
  sender: SenderInsights['sender'];
  period: { from: string; to: string; timezone: string };
  totals: ReportTotals;
  series: Array<{ day: string } & Partial<ReportTotals>>;
  health_trend: Array<{ at: string; score: number }>;
  restrictions: SenderRestriction[];
  failures_by_reason: Record<string, number>;
}

// ---------------------------------------------------------------------------
// why_not_sending
// ---------------------------------------------------------------------------
export interface DiagnosisCause {
  code: string; blocking: boolean; detail: string; remedy: string;
  sender?: string; sender_id?: string; next_capacity?: string | null; partial?: boolean; task_id?: string;
}
export interface Diagnosis { target: string; blocked: boolean; reason: string; causes: DiagnosisCause[]; notes: string[]; rule: string }

// ---------------------------------------------------------------------------
// alerts, tracking domains
// ---------------------------------------------------------------------------
export interface RunningDryAlert {
  id: string; entity_id: string; label: string | null; reason: string | null; opened_at: string;
  detail: { backlog?: number; per_day?: number; days_left?: number } | null;
}

export type TrackingDomainStatus = 'pending_dns' | 'awaiting_approval' | 'active' | 'failed';
export interface TrackingDomain {
  id: string; workspace_id: string; sender_id: string | null; hostname: string; status: TrackingDomainStatus; cname_target: string;
  checked_at: string | null; approved_at: string | null; note: string | null; created_at: string;
}

export const sk = {
  insights: (id: string) => ['outreach', 'sender', id, 'insights'] as const,
  report: (id: string, from: string, to: string) => ['outreach', 'sender', id, 'report', from, to] as const,
  diagnosis: (id: string) => ['outreach', 'sender', id, 'diagnosis'] as const,
  runningDry: (ws: string) => ['outreach', ws, 'alerts', 'sender_running_dry'] as const,
  trackingDomains: (ws: string) => ['outreach', ws, 'tracking-domains'] as const,
  senderSequences: (id: string) => ['outreach', 'sender', id, 'sequences'] as const,
};

export function useSenderInsights(id: string | null | undefined) {
  return useQuery({ queryKey: sk.insights(id ?? ''), enabled: !!id, staleTime: 60_000, queryFn: () => rpc<SenderInsights>('sender_insights', { p_sender: id }) });
}

export function useSenderReport(id: string | null | undefined, from: string, to: string) {
  return useQuery({
    queryKey: sk.report(id ?? '', from, to), enabled: !!id && !!from && !!to && from <= to, staleTime: 60_000, placeholderData: (prev) => prev,
    queryFn: () => rpc<SenderReport>('report_sender', { p_sender: id, p_from: from, p_to: to }),
  });
}

export function useSenderDiagnosis(id: string | null | undefined, enabled: boolean) {
  return useQuery({ queryKey: sk.diagnosis(id ?? ''), enabled: !!id && enabled, staleTime: 0, gcTime: 0, queryFn: () => rpc<Diagnosis>('why_not_sending', { p_sender: id }) });
}

/** Open "running dry" alerts of the workspace, keyed by sender id. */
export function useRunningDryAlerts(ws: string | null | undefined) {
  return useQuery({
    queryKey: sk.runningDry(ws ?? ''), enabled: !!ws, refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_alerts').select('id, entity_id, label, reason, opened_at, detail')
        .eq('workspace_id', ws!).eq('kind', 'sender_running_dry').is('resolved_at', null).order('opened_at', { ascending: false });
      if (error) throw parseError(error);
      const m = new Map<string, RunningDryAlert>();
      for (const a of (data ?? []) as RunningDryAlert[]) if (!m.has(a.entity_id)) m.set(a.entity_id, a);
      return m;
    },
  });
}

export function useTrackingDomains(ws: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: sk.trackingDomains(ws ?? ''), enabled: !!ws && enabled, refetchInterval: 120_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_tracking_domains').select('*').eq('workspace_id', ws!).order('created_at');
      if (error) throw parseError(error);
      return (data ?? []) as TrackingDomain[];
    },
  });
}

/** Active sequences that have this sender in their pool (used for the "add an auto-enrol rule" link). */
export function useSenderSequences(id: string | null | undefined, ws: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: sk.senderSequences(id ?? ''), enabled: !!id && !!ws && enabled, staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_sequences').select('id, name, status').eq('workspace_id', ws!).eq('status', 'active').contains('sender_pool', [id!]).order('name');
      if (error) throw parseError(error);
      return (data ?? []) as Array<{ id: string; name: string; status: string }>;
    },
  });
}

// ---------------------------------------------------------------------------
// small display helpers
// ---------------------------------------------------------------------------
/** YYYY-MM-DD → "Sep 30, 2026" without shifting the day across timezones. */
export function fmtDay(day: string | null | undefined, withYear = true): string {
  if (!day) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: withYear ? 'numeric' : undefined, timeZone: 'UTC' });
}

export function addDays(day: string, n: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const pct = (v: number | null | undefined) => (v == null ? '—' : `${Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`);
export const num = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString());

/** The database writes action types as identifiers ("profile_view"); show them as words. */
export function plainText(s: string | null | undefined): string {
  return (s ?? '').replace(/\b(profile_view|search_page|post_fetch|find_email)\b/g, (m) => m.replace('_', ' '));
}

export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
