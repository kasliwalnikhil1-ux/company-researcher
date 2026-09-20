// Types for the settings screens. They mirror migrations/outreach/010, 014 and 015.
import type { Role } from '@/lib/outreach/types';

// ---- workspace -------------------------------------------------------------
export type StageKind = 'new' | 'contacted' | 'connected' | 'replied' | 'interested' | 'meeting' | 'won' | 'lost';
export const STAGE_KINDS: Array<{ value: StageKind; label: string; hint: string }> = [
  { value: 'new', label: 'New', hint: 'Not contacted yet' },
  { value: 'contacted', label: 'Contacted', hint: 'An invite, message or email went out' },
  { value: 'connected', label: 'Connected', hint: 'The invite was accepted' },
  { value: 'replied', label: 'Replied', hint: 'The lead answered' },
  { value: 'interested', label: 'Interested', hint: 'A reply was classified interested' },
  { value: 'meeting', label: 'Meeting', hint: 'A meeting is booked' },
  { value: 'won', label: 'Won', hint: 'Deal closed' },
  { value: 'lost', label: 'Lost', hint: 'Deal lost' },
];
export interface StageRow { id: string; workspace_id: string; name: string; position: number; color: string | null; kind: StageKind | null; deal_value: number | null }

// ---- blacklists (item 17) --------------------------------------------------
export type BlacklistKind = 'domain' | 'email' | 'public_identifier' | 'company';
export type BlacklistScope = 'workspace' | 'client' | 'sequence';
export interface BlacklistRow {
  id: string; workspace_id: string; client_id: string | null; sequence_id: string | null;
  kind: BlacklistKind; value: string; reason: string | null; source: string; created_at: string;
}
export interface AddSuppressionsResult { added: number; skipped: number }

// ---- AI & data (items 14, 26) ----------------------------------------------
export type LlmProvider = 'gemini' | 'anthropic' | 'openai';
export type FinderProvider = 'hunter' | 'prospeo' | 'findymail';
export type VerifierProvider = 'zerobounce' | 'reacher';
export interface KeyHint<P extends string = string> { provider: P; hint: string | null }
export interface AiSettings {
  llm_provider: 'platform' | LlmProvider;
  llm_model: string | null;
  llm_key_hint: string | null;
  uses_own_key: boolean;
  finders: Array<KeyHint<FinderProvider>>;
  verifier: KeyHint<VerifierProvider> | null;
  booking_webhook_secret: string | null;   // owner only
}
export interface AiVariable {
  id: string; workspace_id: string; key: string; name: string; prompt: string; fallback: string;
  needs_posts: boolean; max_chars: number; created_at: string; updated_at: string;
}

// ---- email (item 20) -------------------------------------------------------
export type TrackingDomainStatus = 'pending_dns' | 'awaiting_approval' | 'active' | 'failed';
export interface TrackingDomain {
  id: string; workspace_id: string; sender_id: string | null; hostname: string; status: TrackingDomainStatus;
  cname_target: string; checked_at: string | null; approved_at: string | null; note: string | null; created_at: string;
}

// ---- API & webhooks (item 21) ----------------------------------------------
export interface ApiKeyRow {
  id: string; workspace_id: string; user_id: string; name: string; prefix: string; role: Role; client_ids: string[];
  last_used_at: string | null; expires_at: string | null; revoked_at: string | null; created_at: string;
}
export interface CreatedApiKey { id: string; key: string; prefix: string }
export interface Delivery {
  id: number; webhook_id: string | null; event: string | null; status: number | null; attempts: number;
  created_at: string; delivered_at: string | null; last_error: string | null; replay_of: number | null; payload: unknown;
}
/** Events added by the v2 migrations. `EVENT_NAMES` in lib/outreach/types.ts holds the older ones. */
export const NEW_EVENT_NAMES = [
  'sequence.stalled', 'sequence.recovered', 'sequence.published', 'sender.running_dry',
  'enrollment.held', 'enrollment.resumed', 'enrollment.recovered',
  'meeting.booked', 'lead.unsubscribed', 'workspace.billing_recovered',
] as const;

// ---- integrations (item 22) ------------------------------------------------
export type CrmProvider = 'hubspot' | 'pipedrive' | 'salesforce';
export type SyncRule = 'replied' | 'interested' | 'enrolled';
export interface IntegrationSettings { sync_rule?: SyncRule; log_messages?: boolean; create_deal_on_interested?: boolean; suppress_customers?: boolean }
export interface Integration {
  id: string; workspace_id: string; provider: CrmProvider; status: 'connecting' | 'active' | 'error' | 'disconnected';
  account_label: string | null; settings: IntegrationSettings; field_mapping: Record<string, string>; stage_mapping: Record<string, string>;
  last_sync_at: string | null; last_pull_at: string | null; last_error: string | null; created_at: string;
}
export interface SyncLogRow {
  id: number; integration_id: string; workspace_id: string; lead_id: string | null; direction: 'push' | 'pull';
  op: string; status: 'ok' | 'skipped' | 'error'; detail: string | null; at: string;
  outreach_leads?: { id: string; full_name: string | null } | null;
}
export interface CrmSegment { id: string; name: string; count?: number | null }

// ---- white-label (item 23) -------------------------------------------------
export interface DnsRecord { type: 'CNAME' | 'TXT'; name: string; value: string | null }
export interface DomainRow {
  id: string; hostname: string; client_id: string | null; status: 'pending_dns' | 'verifying' | 'active' | 'failed';
  verified_at: string | null; last_checked_at: string | null; last_error: string | null; dns: DnsRecord[];
}
