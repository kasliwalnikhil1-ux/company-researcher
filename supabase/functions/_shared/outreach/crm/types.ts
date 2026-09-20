// CRM sync (plan item 22): the small provider interface every CRM implements.
// This file is pure (no env, no network) so tests and other modules can import it freely.

export type ProviderName = "hubspot" | "pipedrive" | "salesforce";
export const PROVIDERS: ProviderName[] = ["hubspot", "pipedrive", "salesforce"];

/** OAuth tokens in plain text. They only exist in memory; at rest they are encrypted in outreach_integration_secrets. */
export interface CrmTokens {
  access_token: string;
  refresh_token: string | null;
  /** ISO timestamp, null when the CRM does not tell us (Salesforce). */
  expires_at: string | null;
  /** Salesforce instance URL / Pipedrive api_domain. Null for HubSpot. */
  instance_url: string | null;
}

/** `unsupported` = the CRM has no such concept for this record (logged as skipped, not as an error). */
export type CrmErrorKind = "auth" | "rate_limit" | "not_found" | "validation" | "forbidden" | "transient" | "config" | "unsupported";

export class CrmError extends Error {
  kind: CrmErrorKind;
  status: number;
  provider: string;
  retryAfter: number | null;
  body: string;
  constructor(provider: string, kind: CrmErrorKind, status: number, message: string, body = "", retryAfter: number | null = null) {
    super(message);
    this.provider = provider;
    this.kind = kind;
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter;
  }
}

/** The lead as the CRM layer sees it (one flat shape for the three providers). */
export interface CrmLead {
  id: string;
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  /** best address we have: work first, then personal */
  email: string | null;
  email_work: string | null;
  email_personal: string | null;
  title: string | null;
  company: string | null;
  linkedin_url: string | null;
  phone: string | null;
  location: string | null;
  headline: string | null;
  /** Our stage name, e.g. "Interested". Written to the "Outreach stage" text property. */
  stage: string | null;
  /** Only loaded when the field mapping asks for them. */
  last_intent?: string | null;
  sequence_name?: string | null;
  sender_name?: string | null;
  custom: Record<string, unknown>;
}

/** { "<our field>": "<CRM property>" }. `{}` = the provider defaults; a non-empty map is used as it is ("" or null switches one field off). */
export type FieldMapping = Record<string, string | null>;

/** What a stage maps to in the CRM. `contact` = lifecycle / status value on the person, `deal` = deal stage (or won / lost). */
export interface StageTarget { contact?: string | null; deal?: string | null }
/**
 * Keys: our stage kind (new, contacted, connected, replied, interested, meeting, won, lost); a stage id or lower-case stage name also works.
 * `{}` = the provider defaults; a non-empty map is used as it is, and a kind that is missing is not pushed.
 * A plain string means: HubSpot lifecycle stage, Pipedrive deal stage id, Salesforce lead status.
 */
export type StageMapping = Record<string, StageTarget | string | null>;

export interface IntegrationSettings {
  sync_rule?: "replied" | "interested" | "enrolled";
  log_messages?: boolean;
  create_deal_on_interested?: boolean;
  suppress_customers?: boolean;
  /** false (default): on a contact that already exists in the CRM we only write the fields we own (Outreach stage, LinkedIn URL). */
  overwrite_existing?: boolean;
  /** Optional deal defaults. */
  deal_pipeline?: string | null;
  deal_stage?: string | null;
  deal_amount?: number | null;
  /** false switches off the automatic "Outreach stage" text property (HubSpot, Pipedrive). */
  write_outreach_stage?: boolean;
  /** Salesforce only: create new people as "Lead" (default) or "Contact". An existing contact with the same email is always reused. */
  salesforce_object?: "Lead" | "Contact";
  /** Salesforce only: API name of an external-id field (e.g. Outreach_Lead_Id__c) to upsert by. */
  salesforce_external_id_field?: string | null;
  [k: string]: unknown;
}

export interface UpsertOptions {
  mapping: FieldMapping;
  /** ids we already stored for this lead */
  existing?: { contactId?: string | null; companyId?: string | null };
  overwriteExisting?: boolean;
  settings?: IntegrationSettings;
}

export interface UpsertResult {
  contactId: string;
  companyId?: string | null;
  created: boolean;
  /** Values we could not store in a field (no such property and it could not be created). The engine puts them in a note. */
  leftover: Record<string, string>;
}

export interface ActivityInput {
  direction: "out" | "in";
  channel: "linkedin" | "email";
  text: string;
  subject?: string | null;
  at: string;
  sequence?: string | null;
  step?: number | null;
  /** "Note" style entries (meeting booked, conversation so far, details we could not map). */
  note?: boolean;
  title?: string | null;
  dealId?: string | null;
}

export interface DealInput { name: string; stage?: string | null; pipeline?: string | null; amount?: number | null; companyId?: string | null }

export interface Segment { id: string; name: string; kind: string; size: number | null }

export interface ImportedLead {
  crm_contact_id: string;
  crm_company_id?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  email?: string | null;
  title?: string | null;
  company?: string | null;
  linkedin_url?: string | null;
  phone?: string | null;
}

export interface SegmentPage { leads: ImportedLead[]; next: string | null }
export interface BlacklistPage { emails: string[]; domains: string[]; companies: string[]; next: string | null }

export interface CrmProvider {
  name: ProviderName;
  label: string;
  /** false when the platform operator has not set the client id / secret for this CRM */
  configured(): boolean;
  /** scopes the OAuth app must be allowed to request */
  scopes: string[];
  authorizeUrl(state: string, redirectUri: string, codeChallenge?: string): string;
  exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<CrmTokens>;
  refresh(tokens: CrmTokens): Promise<CrmTokens>;
  accountLabel(tokens: CrmTokens): Promise<string>;
  upsertContact(tokens: CrmTokens, lead: CrmLead, opts: UpsertOptions): Promise<UpsertResult>;
  logActivity(tokens: CrmTokens, contactId: string, activity: ActivityInput): Promise<{ id: string | null }>;
  /** Returns what was changed; nothing mapped → both false. */
  setStage(tokens: CrmTokens, ids: { contactId: string; dealId?: string | null }, target: StageTarget): Promise<{ contact: boolean; deal: boolean }>;
  createDeal(tokens: CrmTokens, contactId: string, deal: DealInput): Promise<{ dealId: string }>;
  listSegments(tokens: CrmTokens): Promise<Segment[]>;
  importSegment(tokens: CrmTokens, segmentId: string, cursor: string | null): Promise<SegmentPage>;
  listCustomersAndOpenDeals(tokens: CrmTokens, cursor: string | null): Promise<BlacklistPage>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export interface ProviderEnv { clientId: string; clientSecret: string; fetch?: FetchLike; extra?: Record<string, string | undefined> }
