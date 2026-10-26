'use client';

/**
 * Custom sending domain + email log (custom-sending-domain-PRD.md §4, §8): types, hooks and the calls to the
 * `sending-domain` function and the `email_log_search` / `email_types_by_rule` / `email_platform_stats` RPCs.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { callFn, rpc } from './api';

export type DomainState = 'setup' | 'verifying' | 'ready' | 'active' | 'paused' | 'failed' | 'removed';
export type PausedReason = 'send_error' | 'dns' | 'bounces' | 'complaints' | 'manual' | 'plan';
export type RecordStatus = 'not_started' | 'pending' | 'verified' | 'failed' | 'temporary_failure';

export interface DnsRecord { record: 'SPF' | 'DKIM' | 'DMARC' | string; type: string; name: string; value: string; priority?: number | null; ttl?: string | null; status: RecordStatus | string; hint?: 'not_found_public_dns' | string | null }

export interface SendingDomain {
  id: string; workspace_id: string; client_id: string | null; domain: string; region: string;
  state: DomainState; resend_status: string | null; records: DnsRecord[];
  from_name: string | null; from_local_part: string; reply_to: string | null; branding: { logo_path?: string | null; accent?: string | null; footer?: string | null };
  dmarc_found: boolean | null; verified_at: string | null; activated_at: string | null; paused_at: string | null; paused_reason: PausedReason | null; paused_detail: string | null;
  warmup_started_at: string | null; daily_cap: number | null; last_checked_at: string | null; failed_at: string | null; created_at: string;
  sent_today?: number; last7?: { sent: number; delivered: number; bounced: number; complained: number }; fallbacks7?: number; from_address?: string;
  warnings?: string[];
}

export interface DomainList { domains: SendingDomain[]; feature: boolean; client_domains: boolean; client_domain_limit: number | null; min_plan: string }
export interface DomainCheck { ok: boolean; domain: string; errors: string[]; warnings: string[]; root: string | null }
export interface EmailTypeRow { key: string; audience: 'team' | 'holder' | 'client' | 'auth' | 'platform'; safety_critical: boolean; note: string | null }
export interface EmailTypes { brand: EmailTypeRow[]; platform: EmailTypeRow[]; auth: string[] }
export interface TestResult { ok: boolean; outbox_id: string | null; from: string | null; fell_back: boolean; error: string | null }
export interface DmarcResult { found: boolean; record: string | null; policy: string | null; root: string; error?: string }

export type DeliveryStatus = 'sent' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'failed' | 'suppressed';
export interface EmailLogRow {
  id: string; at: string; type: string; audience: string; subject: string; to: string; from: string; fell_back: boolean; fallback_reason: string | null;
  status: DeliveryStatus; bounce_type: string | null; events: Array<{ event: string; at: string; detail?: unknown }>; sender_id: string | null; client_id: string | null; domain: string | null;
}
export interface EmailLogResult { total: number; rows: EmailLogRow[] }
export interface EmailLogFilters { to?: string; type?: string; status?: DeliveryStatus | ''; since?: string; until?: string; limit?: number; offset?: number }

export interface EmailPlatformStats {
  domains: Record<string, number>; outbox_backlog: number; outbox_overdue: number; failed_24h: number; sent_24h: number;
  fell_back_7d: number; brand_7d: number; bounced_7d: number; complained_7d: number; auth_failed_24h: number; auth_sent_24h: number;
}

export const ek = {
  domains: (ws: string, client: string | null) => ['email-sending', 'domains', ws, client ?? ''] as const,
  types: () => ['email-sending', 'types'] as const,
  log: (ws: string, f: EmailLogFilters) => ['email-sending', 'log', ws, f] as const,
  stats: () => ['email-sending', 'platform-stats'] as const,
};

/** The effective state shown to people: a paused domain keeps state 'active' and has paused_at set. */
export function displayState(d: SendingDomain): DomainState {
  return d.paused_at ? 'paused' : d.state;
}

export const STATE_LABEL: Record<DomainState, string> = { setup: 'Setup', verifying: 'Verifying', ready: 'Ready', active: 'Active', paused: 'Paused', failed: 'Failed', removed: 'Removed' };
export const STATE_TONE: Record<DomainState, 'gray' | 'green' | 'red' | 'amber' | 'blue'> = { setup: 'gray', verifying: 'blue', ready: 'blue', active: 'green', paused: 'amber', failed: 'red', removed: 'gray' };

export const RECORD_LABEL: Record<string, string> = { not_started: 'Not found', pending: 'Pending', verified: 'Verified', failed: 'Failed', temporary_failure: 'Pending' };
export const RECORD_TONE: Record<string, 'gray' | 'green' | 'red' | 'amber' | 'blue'> = { not_started: 'gray', pending: 'blue', verified: 'green', failed: 'red', temporary_failure: 'amber' };

export const STATUS_LABEL: Record<DeliveryStatus, string> = { sent: 'Sent', delivered: 'Delivered', delayed: 'Delayed', bounced: 'Bounced', complained: 'Complained', failed: 'Failed', suppressed: 'Suppressed' };
export const STATUS_TONE: Record<DeliveryStatus, 'gray' | 'green' | 'red' | 'amber' | 'blue'> = { sent: 'blue', delivered: 'green', delayed: 'amber', bounced: 'red', complained: 'red', failed: 'red', suppressed: 'amber' };

export const PAUSE_TEXT: Record<PausedReason, { cause: string; fix: string }> = {
  send_error: { cause: 'our email provider refused a send from this domain', fix: 'Check the DNS records below, press Check now, then Resume.' },
  dns: { cause: 'a DNS record is no longer found', fix: 'Add the record back, press Check now, then Resume.' },
  bounces: { cause: 'too many emails bounced in the last 7 days', fix: 'Fix the addresses or the list that caused them, then Resume with a note about what changed.' },
  complaints: { cause: 'people marked these emails as spam', fix: 'Look at what was sent and to whom, then Resume with a note about what changed.' },
  manual: { cause: 'someone on your team paused it', fix: 'Press Resume when you want to send from it again.' },
  plan: { cause: 'the plan no longer includes a sending domain', fix: 'Upgrade the plan to send from it again. The domain is removed after 30 days.' },
};

/** The friendly name of a catalogue key. */
export function typeLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** Warm-up (PRD §5.6): 50 a day for 7 days, 200 a day for days 8–14, then no cap. */
export function warmupStage(d: SendingDomain): { label: string; day: number | null; cap: number | null } {
  if (!d.warmup_started_at) return { label: 'Starts when the domain is turned on', day: null, cap: d.daily_cap };
  const day = Math.floor((Date.now() - new Date(d.warmup_started_at).getTime()) / 86_400_000) + 1;
  if (day <= 7) return { label: `Warm-up day ${day} of 14: up to 50 emails a day`, day, cap: 50 };
  if (day <= 14) return { label: `Warm-up day ${day} of 14: up to 200 emails a day`, day, cap: 200 };
  return { label: 'Warm-up done: no daily cap', day, cap: null };
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------
export const sendingDomainApi = {
  list: (ws: string, clientId?: string | null) => callFn<DomainList>('sending-domain', { workspace_id: ws, action: 'list', client_id: clientId ?? null }),
  types: (ws: string) => callFn<EmailTypes>('sending-domain', { workspace_id: ws, action: 'types' }),
  check: (ws: string, domain: string, clientId?: string | null) => callFn<DomainCheck>('sending-domain', { workspace_id: ws, action: 'check', domain, client_id: clientId ?? null }),
  create: (ws: string, domain: string, clientId?: string | null, region?: string | null) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'create', domain, client_id: clientId ?? null, region: region ?? null }),
  verify: (ws: string, id: string) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'verify', id }),
  update: (ws: string, id: string, patch: { from_name?: string | null; from_local_part?: string; reply_to?: string; branding?: { logo_path?: string | null; accent?: string | null; footer?: string | null } }) =>
    callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'update', id, ...patch }),
  test: (ws: string, id: string, to?: string) => callFn<TestResult>('sending-domain', { workspace_id: ws, action: 'test', id, ...(to ? { to } : {}) }),
  activate: (ws: string, id: string) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'activate', id }),
  pause: (ws: string, id: string, note?: string) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'pause', id, note }),
  resume: (ws: string, id: string, note?: string) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'resume', id, note }),
  remove: (ws: string, id: string) => callFn<SendingDomain>('sending-domain', { workspace_id: ws, action: 'remove', id }),
  emailRecords: (ws: string, id: string, to: string) => callFn<{ ok: boolean }>('sending-domain', { workspace_id: ws, action: 'email_records', id, to }),
  dmarc: (ws: string, id: string) => callFn<DmarcResult>('sending-domain', { workspace_id: ws, action: 'dmarc', id }),
};

export function useSendingDomains(ws: string | null | undefined, clientId?: string | null, enabled = true) {
  return useQuery({ queryKey: ek.domains(ws ?? '', clientId ?? null), enabled: !!ws && enabled, queryFn: () => sendingDomainApi.list(ws!, clientId ?? null) });
}

export function useEmailTypes(enabled = true) {
  return useQuery({ queryKey: ek.types(), enabled, staleTime: 3_600_000, queryFn: () => rpc<EmailTypes>('email_types_by_rule') });
}

export function useEmailLog(ws: string | null | undefined, f: EmailLogFilters) {
  return useQuery({
    queryKey: ek.log(ws ?? '', f), enabled: !!ws, placeholderData: (prev) => prev,
    queryFn: () => rpc<EmailLogResult>('email_log_search', { p_ws: ws, p_to: f.to || null, p_type: f.type || null, p_status: f.status || null, p_since: f.since ? new Date(f.since).toISOString() : null, p_until: f.until ? new Date(`${f.until}T23:59:59`).toISOString() : null, p_limit: f.limit ?? 50, p_offset: f.offset ?? 0 }),
  });
}

export function useEmailPlatformStats(enabled = true) {
  return useQuery({ queryKey: ek.stats(), enabled, refetchInterval: 120_000, queryFn: () => rpc<EmailPlatformStats>('email_platform_stats') });
}

export function useInvalidateSendingDomains() {
  const qc = useQueryClient();
  return (ws: string | null | undefined) => { if (ws) qc.invalidateQueries({ queryKey: ['email-sending', 'domains', ws] }); };
}
