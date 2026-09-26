'use client';

// Channels (Instagram / WhatsApp): hooks, labels and helpers shared by senders, inbox, leads, reports and settings.
// Every hook maps to exactly one RPC named in docs/outreach/CHANNELS-BUILD-CONTRACT.md §3. Nothing here recomputes a number.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/utils/supabase/client';
import { parseError, rpc } from './api';
import { qk } from './queries';
import type { ChannelCapabilities, ConsentBasis, LeadConsent, LeadIdentity, Provider, SenderStatus } from './types';
import { CHANNEL_PROVIDERS, MAIL_PROVIDERS } from './types';

export { CHANNEL_PROVIDERS, MAIL_PROVIDERS };

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
export const CHANNEL_LABELS: Record<Provider, string> = { LINKEDIN: 'LinkedIn', INSTAGRAM: 'Instagram', WHATSAPP: 'WhatsApp', GMAIL: 'Gmail', OUTLOOK: 'Outlook', IMAP: 'Email' };

export function channelLabel(provider: Provider | string | null | undefined): string {
  if (!provider) return 'Unknown channel';
  return CHANNEL_LABELS[provider as Provider] ?? String(provider);
}

export function isMailProvider(provider: Provider | string | null | undefined): boolean {
  return !!provider && (MAIL_PROVIDERS as string[]).includes(provider);
}

/** Lower-case channel key the reports use: linkedin | instagram | whatsapp | email. */
export function channelKey(provider: Provider | string | null | undefined): string {
  if (!provider) return 'unknown';
  return isMailProvider(provider) ? 'email' : String(provider).toLowerCase();
}

export function channelKeyLabel(key: string): string {
  if (key === 'email') return 'Email';
  if (key === 'linkedin') return 'LinkedIn';
  if (key === 'instagram') return 'Instagram';
  if (key === 'whatsapp') return 'WhatsApp';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export const CONSENT_BASIS_LABELS: Record<ConsentBasis, string> = {
  inbound: 'They messaged first',
  form_optin: 'Opted in on a form',
  existing_customer: 'Existing customer',
  linkedin_reply: 'Shared on LinkedIn',
  explicit_share: 'Gave the number in a conversation',
  imported_attested: 'Attested at import',
};

/** One line per basis for settings and grant forms. */
export const CONSENT_BASIS_HELP: Record<ConsentBasis, string> = {
  inbound: 'The person wrote to one of your accounts first, on any channel. Recorded automatically for WhatsApp.',
  form_optin: 'They ticked a box on a form you run. Keep the form link or a note as evidence.',
  existing_customer: 'They bought from you before. Keep a link to the order or a note as evidence.',
  linkedin_reply: 'They replied to you on LinkedIn and shared or accepted contact by WhatsApp.',
  explicit_share: 'They gave you the number themselves in a conversation you hold.',
  imported_attested: 'Someone on your team attests the list was collected with consent. The weakest basis: it is flagged amber everywhere and appears in the client consent report.',
};

export const CONSENT_BASIS_TONE: Record<ConsentBasis, 'green' | 'blue' | 'amber' | 'gray'> = {
  inbound: 'green', form_optin: 'green', existing_customer: 'blue', linkedin_reply: 'blue', explicit_share: 'blue', imported_attested: 'amber',
};

/** Bases that need a URL or a note in the evidence (the RPC rejects them otherwise). */
export const CONSENT_BASES_NEED_EVIDENCE: ConsentBasis[] = ['form_optin', 'existing_customer'];

export function consentIsActive(c: LeadConsent | null | undefined, now = Date.now()): boolean {
  if (!c || c.revoked_at) return false;
  if (c.expires_at && new Date(c.expires_at).getTime() < now) return false;
  return true;
}

export function evidenceUrl(evidence: Record<string, unknown> | null | undefined): string | null {
  const u = evidence?.url;
  if (typeof u !== 'string') return null;
  try { return /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; }
}

export function evidenceNote(evidence: Record<string, unknown> | null | undefined): string | null {
  const n = evidence?.note;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

/** Message length the composer enforces per channel. */
export function messageMaxLength(provider: Provider | string | null | undefined): number | undefined {
  if (provider === 'INSTAGRAM') return 1000;
  if (provider === 'WHATSAPP') return 4096;
  return undefined;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------
export const ck = {
  caps: () => ['outreach', 'channel-caps'] as const,
  identities: (leadId: string) => ['outreach', 'lead', leadId, 'identities'] as const,
  consent: (leadId: string) => ['outreach', 'lead', leadId, 'consent'] as const,
  consentList: (ws: string, f: unknown) => ['outreach', ws, 'consent-list', f] as const,
  senderScopes: (senderId: string) => ['outreach', 'sender', senderId, 'scopes'] as const,
  capacity: (ws: string, client: string | null) => ['outreach', ws, 'channel-capacity', client] as const,
  reportChannels: (ws: string, ...rest: unknown[]) => ['outreach', ws, 'reports', 'channels', ...rest] as const,
  reportBlocks: (ws: string, ...rest: unknown[]) => ['outreach', ws, 'reports', 'blocks', ...rest] as const,
  reportConsent: (ws: string, ...rest: unknown[]) => ['outreach', ws, 'reports', 'consent', ...rest] as const,
};

// ---------------------------------------------------------------------------
// Return shapes (contract §3)
// ---------------------------------------------------------------------------
export interface ScopeWindow { scope: string; hour_start?: string; day_start?: string; window_start?: string; cap: number; used: number; reserved: number; remaining: number }
export interface SenderScopesToday { day: ScopeWindow | null; hour: ScopeWindow | null }

export interface ChannelCapacityRow {
  sender_id: string; name: string | null; provider: Provider; status: SenderStatus; level: number; quiet_until: string | null;
  today: Record<string, number>; hour: { cap: number; remaining: number } | null;
}

export interface ReportChannelRow {
  channel: string; senders: number; actions: number; new_chats: number; replies: number; replies_per_100_actions: number | null; interested: number; blocks: number; reply_rate: number | null;
}
export interface ReportChannels { period: { from: string; to: string; timezone?: string }; rows: ReportChannelRow[] }

export interface BlockPreceding { at: string; type: string; lead_id?: string | null; lead_name?: string | null }
export interface ReportBlockRow {
  at: string; sender_id: string; sender_name: string | null; provider: Provider; lead_id: string | null; lead_name: string | null; code: string | null; preceding: BlockPreceding[];
}
export interface ReportBlocks { period: { from: string; to: string }; rows: ReportBlockRow[]; by_sender: Array<{ sender_id: string; name: string | null; blocks: number }> }

export interface ConsentReportRow {
  lead_id: string; lead_name: string | null; basis: ConsentBasis; obtained_at: string; evidence: Record<string, unknown>; attested_by_email: string | null; first_new_chat_at: string | null; sender_name: string | null;
}
export interface ConsentReport {
  period: { from: string; to: string };
  contacted: number;
  by_basis: Partial<Record<ConsentBasis, { leads: number; share_pct: number | null }>>;
  imported_attested_share_pct: number | null;
  alert: boolean;
  rows: ConsentReportRow[];
}

export interface ConsentListFilters { lead_id?: string | null; channel?: Provider | null; basis?: ConsentBasis | null; include_revoked?: boolean; limit?: number }

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export function useChannelCaps() {
  return useQuery({
    queryKey: ck.caps(), staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('outreach_channel_capabilities').select('*');
      if (error) throw parseError(error);
      return (data ?? []) as ChannelCapabilities[];
    },
  });
}

export function capsFor(caps: ChannelCapabilities[] | undefined, provider: Provider | null | undefined): ChannelCapabilities | undefined {
  return provider ? caps?.find((c) => c.provider === provider) : undefined;
}

export function useLeadIdentities(leadId: string | null | undefined) {
  return useQuery({ queryKey: ck.identities(leadId ?? ''), enabled: !!leadId, queryFn: () => rpc<LeadIdentity[]>('identity_list', { p_lead: leadId }) });
}

/** Consent rows for one lead (active ones first; revoked included so history is visible). */
export function useLeadConsent(leadId: string | null | undefined, ws?: string | null) {
  return useQuery({
    queryKey: ck.consent(leadId ?? ''), enabled: !!leadId,
    queryFn: async () => {
      const wsId = ws ?? (await leadWorkspace(leadId!));
      const rows = await rpc<LeadConsent[]>('consent_list', { p_ws: wsId, p_lead: leadId, p_include_revoked: true, p_limit: 50 });
      return rows ?? [];
    },
  });
}

async function leadWorkspace(leadId: string): Promise<string> {
  const { data, error } = await supabase.from('outreach_leads').select('workspace_id').eq('id', leadId).single();
  if (error) throw parseError(error);
  return (data as { workspace_id: string }).workspace_id;
}

/** The active consent per channel from a consent list. */
export function activeConsentByChannel(rows: LeadConsent[] | undefined): Partial<Record<Provider, LeadConsent>> {
  const out: Partial<Record<Provider, LeadConsent>> = {};
  for (const c of rows ?? []) if (consentIsActive(c) && !out[c.channel]) out[c.channel] = c;
  return out;
}

export function useConsentList(ws: string | null | undefined, f: ConsentListFilters = {}) {
  return useQuery({
    queryKey: ck.consentList(ws ?? '', f), enabled: !!ws, placeholderData: keepPreviousData,
    queryFn: () => rpc<LeadConsent[]>('consent_list', { p_ws: ws, p_lead: f.lead_id ?? null, p_channel: f.channel ?? null, p_basis: f.basis ?? null, p_include_revoked: !!f.include_revoked, p_limit: f.limit ?? 200 }),
  });
}

export function useSenderScopes(senderId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ck.senderScopes(senderId ?? ''), enabled: !!senderId && enabled, refetchInterval: 60_000,
    queryFn: async () => (await rpc<SenderScopesToday | null>('sender_scopes_today', { p_sender: senderId })) ?? { day: null, hour: null },
  });
}

export function useChannelCapacity(ws: string | null | undefined, client: string | null = null) {
  return useQuery({ queryKey: ck.capacity(ws ?? '', client), enabled: !!ws, refetchInterval: 60_000, queryFn: () => rpc<ChannelCapacityRow[]>('channel_capacity', { p_ws: ws, p_client: client }) });
}

interface ReportScope { ws: string | null | undefined; client?: string | null; range: { from: string; to: string }; enabled?: boolean }
const base = (s: ReportScope) => ({ p_ws: s.ws, p_client: s.client || null, p_from: s.range.from, p_to: s.range.to });

export function useReportChannels(s: ReportScope) {
  return useQuery({ queryKey: ck.reportChannels(s.ws ?? '', s.client ?? null, s.range), enabled: !!s.ws && s.enabled !== false, placeholderData: keepPreviousData, queryFn: () => rpc<ReportChannels>('report_channels', base(s)) });
}

export function useReportBlocks(s: ReportScope, senderId: string | null = null) {
  return useQuery({ queryKey: ck.reportBlocks(s.ws ?? '', s.client ?? null, s.range, senderId), enabled: !!s.ws && s.enabled !== false, placeholderData: keepPreviousData, queryFn: () => rpc<ReportBlocks>('report_blocks', { ...base(s), p_sender: senderId }) });
}

export function useConsentReport(s: ReportScope) {
  return useQuery({ queryKey: ck.reportConsent(s.ws ?? '', s.client ?? null, s.range), enabled: !!s.ws && s.enabled !== false, placeholderData: keepPreviousData, queryFn: () => rpc<ConsentReport>('consent_report', base(s)) });
}

// ---------------------------------------------------------------------------
// Mutations + invalidation helpers
// ---------------------------------------------------------------------------
export function useInvalidateLeadChannels() {
  const qc = useQueryClient();
  return (leadId: string, ws?: string | null) => {
    qc.invalidateQueries({ queryKey: ck.identities(leadId) });
    qc.invalidateQueries({ queryKey: ck.consent(leadId) });
    qc.invalidateQueries({ queryKey: qk.lead(leadId) });
    if (ws) {
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'consent-list'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'reports', 'consent'] });
      qc.invalidateQueries({ queryKey: ['outreach', ws, 'leads'] });
    }
  };
}

export interface IdentityAddInput { leadId: string; provider: Provider; identifier: string; source?: string; verified?: boolean; ws?: string | null }
export function useIdentityAdd() {
  const inv = useInvalidateLeadChannels();
  return useMutation({
    mutationFn: (v: IdentityAddInput) => rpc<string>('identity_add', { p_lead: v.leadId, p_provider: v.provider, p_identifier: v.identifier.trim(), p_source: v.source ?? 'operator', p_verified: v.verified ?? true, p_provider_id: null }),
    onSuccess: (_r, v) => inv(v.leadId, v.ws),
  });
}
export function useIdentityVerify() {
  const inv = useInvalidateLeadChannels();
  return useMutation({ mutationFn: (v: { id: string; leadId: string; ws?: string | null }) => rpc<void>('identity_verify', { p_id: v.id }), onSuccess: (_r, v) => inv(v.leadId, v.ws) });
}
export function useIdentityRemove() {
  const inv = useInvalidateLeadChannels();
  return useMutation({ mutationFn: (v: { id: string; leadId: string; ws?: string | null }) => rpc<void>('identity_remove', { p_id: v.id }), onSuccess: (_r, v) => inv(v.leadId, v.ws) });
}

export interface ConsentGrantInput { leadId: string; channel: Provider; basis: ConsentBasis; evidence?: Record<string, unknown>; obtainedAt?: string | null; expiresAt?: string | null; ws?: string | null }
export function useConsentGrant() {
  const inv = useInvalidateLeadChannels();
  return useMutation({
    mutationFn: (v: ConsentGrantInput) => rpc<string>('consent_grant', { p_lead: v.leadId, p_channel: v.channel, p_basis: v.basis, p_evidence: v.evidence ?? {}, p_obtained_at: v.obtainedAt ?? new Date().toISOString(), p_expires_at: v.expiresAt ?? null }),
    onSuccess: (_r, v) => inv(v.leadId, v.ws),
  });
}
export function useConsentRevoke() {
  const qc = useQueryClient();
  const inv = useInvalidateLeadChannels();
  return useMutation({
    mutationFn: (v: { id: string; leadId: string; reason?: string; ws?: string | null }) => rpc<void>('consent_revoke', { p_id: v.id, p_reason: v.reason ?? 'manual' }),
    onSuccess: (_r, v) => { inv(v.leadId, v.ws); qc.invalidateQueries({ queryKey: ['outreach', 'enrollments'] }); },
  });
}

// ---------------------------------------------------------------------------
// Time helpers for the quiet period / warning countdowns
// ---------------------------------------------------------------------------
/** "17 h", "45 min", "2 days" until an ISO time; null when it is in the past. */
export function untilText(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.round(ms / 3_600_000);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} days`;
}

export function inQuietPeriod(s: { outreach_allowed_from?: string | null }, now = Date.now()): boolean {
  return !!s.outreach_allowed_from && new Date(s.outreach_allowed_from).getTime() > now;
}

export function hasProviderWarning(s: { provider_warning?: { paused_until?: string | null } | null }): boolean {
  return !!s.provider_warning;
}

/** The WhatsApp new-conversation governor (PRD §7.4): what each level allows and what promotes it. */
export const WA_GOVERNOR_LEVELS: Array<{ level: number; new_chats: number; promotion: string }> = [
  { level: 0, new_chats: 2, promotion: '7 days connected, at least 5 conversations started by other people, and the number’s age attested (6+ months)' },
  { level: 1, new_chats: 5, promotion: 'Reply rate of 40% or more over the last 14 days, on at least 10 new conversations' },
  { level: 2, new_chats: 10, promotion: 'Reply rate of 40% or more on at least 25 new conversations' },
  { level: 3, new_chats: 20, promotion: 'Reply rate of 45% or more on at least 50 new conversations' },
  { level: 4, new_chats: 35, promotion: 'Reply rate of 50% or more and no blocks in the last 30 days (top level)' },
];
export const WA_GOVERNOR_DEMOTION = 'Drops one level straight away when the 14-day reply rate falls below 25%, a block is detected, or the number disconnects within 24 hours of outreach.';
