// Pure rules of the CRM sync: field mapping, stage mapping, event → operations, log throttling, blacklist diff.
// No env, no network: everything here is unit-tested in crm.test.ts.
import type { ActivityInput, CrmLead, FieldMapping, IntegrationSettings, ProviderName, StageMapping, StageTarget } from "./types.ts";

// ---------------------------------------------------------------------------
// Field mapping
// ---------------------------------------------------------------------------
/** Our side of the mapping (same keys as the settings page). `custom.<key>` is also accepted. */
export const OUR_FIELDS = ["first_name", "last_name", "full_name", "email_work", "email_personal", "phone", "title", "headline", "company", "location", "linkedin_url", "stage", "last_intent", "sequence_name", "sender_name"] as const;

/** Fields we own in the CRM: safe to write on a contact that existed before us. */
export const OWNED_FIELDS = ["stage", "linkedin_url", "last_intent", "sequence_name", "sender_name"];
/** Owned fields that fall back to a note when the CRM has no field for them. */
export const NOTE_FALLBACK_FIELDS = ["stage", "linkedin_url"];

/**
 * Defaults per CRM: the same maps the settings page shows (components/outreach/settings/crm.ts), plus the Pipedrive LinkedIn field.
 * Targets:
 *  - HubSpot: contact property names.
 *  - Pipedrive: `name`, `email`, `phone`, `job_title`, `org_name` (organisation by name), `custom:<Field name>` (text field, created on first use), or a raw field key.
 *  - Salesforce: Lead field API names. On a Contact, `Company` means the Account and `City` means MailingCity.
 */
export const DEFAULT_FIELD_MAPPING: Record<ProviderName, Record<string, string>> = {
  hubspot: { first_name: "firstname", last_name: "lastname", email_work: "email", phone: "phone", title: "jobtitle", company: "company", location: "city", linkedin_url: "hs_linkedin_url" },
  pipedrive: { full_name: "name", email_work: "email", phone: "phone", title: "job_title", company: "org_name", linkedin_url: "custom:LinkedIn URL" },
  salesforce: { first_name: "FirstName", last_name: "LastName", email_work: "Email", phone: "Phone", title: "Title", company: "Company", location: "City" },
};

/** The "Outreach stage" text property is written even when `stage` is not in the field mapping (settings.write_outreach_stage = false switches it off). Salesforce has no field we may create, so there it goes in a note. */
export const IMPLICIT_STAGE_TARGET: Record<ProviderName, string | null> = { hubspot: "outreach_stage", pipedrive: "custom:Outreach stage", salesforce: null };

/** Labels for values that end up in a note because the CRM has no field for them. */
export const FIELD_LABELS: Record<string, string> = { linkedin_url: "LinkedIn", stage: "Outreach stage", title: "Job title", company: "Company", phone: "Phone", location: "Location", headline: "Headline" };

export function effectiveMapping(provider: ProviderName, overrides: FieldMapping | null | undefined, settings: { write_outreach_stage?: boolean } = {}): Record<string, string> {
  const given = Object.entries(overrides ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== "") as [string, string][];
  const hasOverrides = Object.keys(overrides ?? {}).length > 0;
  const out: Record<string, string> = hasOverrides ? Object.fromEntries(given.map(([k, v]) => [k, v.trim()])) : { ...DEFAULT_FIELD_MAPPING[provider] };
  const implicit = IMPLICIT_STAGE_TARGET[provider];
  const stageSwitchedOff = hasOverrides && Object.prototype.hasOwnProperty.call(overrides, "stage") && !out.stage;
  if (!out.stage && implicit && settings.write_outreach_stage !== false && !stageSwitchedOff) out.stage = implicit;
  return out;
}

/** true when the mapping needs the extra lookups (last intent, sequence and sender names). */
export const mappingNeedsContext = (mapping: Record<string, string>): boolean => ["last_intent", "sequence_name", "sender_name"].some((k) => !!mapping[k]);

export function leadValue(lead: CrmLead, field: string): string | null {
  let v: unknown;
  if (field.startsWith("custom.")) v = lead.custom?.[field.slice(7)];
  else if (field === "email_work") v = lead.email_work ?? lead.email;
  else if (field === "full_name") v = lead.full_name ?? ([lead.first_name, lead.last_name].filter(Boolean).join(" ") || null);
  else v = (lead as unknown as Record<string, unknown>)[field];
  if (v === null || v === undefined) return null;
  const s = (typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v)).trim();
  return s === "" ? null : s.slice(0, 1000);
}

/** CRM property → value. Empty values are never sent (we do not blank CRM fields). `ownedOnly` keeps just the fields we own. */
export function mapFields(lead: CrmLead, mapping: Record<string, string>, opts: { ownedOnly?: boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ours, theirs] of Object.entries(mapping)) {
    if (!theirs) continue;
    if (opts.ownedOnly && !OWNED_FIELDS.includes(ours)) continue;
    const v = leadValue(lead, ours);
    if (v !== null) out[theirs] = v;
  }
  return out;
}

/** Stage and LinkedIn URL that have a value but no target in the mapping: they go in the first note instead. */
export function unmappedOwned(lead: CrmLead, mapping: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of NOTE_FALLBACK_FIELDS) {
    if (mapping[f]) continue;
    const v = leadValue(lead, f);
    if (v !== null) out[f] = v;
  }
  return out;
}

export function leftoverNote(leftover: Record<string, string>): string {
  return Object.entries(leftover).map(([k, v]) => `${FIELD_LABELS[k] ?? k}: ${v}`).join("\n");
}

export function splitName(lead: Pick<CrmLead, "first_name" | "last_name" | "full_name">): { first: string | null; last: string | null; full: string } {
  let first = lead.first_name?.trim() || null, last = lead.last_name?.trim() || null;
  if (!first && !last && lead.full_name) {
    const parts = lead.full_name.trim().split(/\s+/);
    first = parts.length > 1 ? parts.slice(0, -1).join(" ") : null;
    last = parts[parts.length - 1] ?? null;
  }
  const full = (lead.full_name?.trim() || [first, last].filter(Boolean).join(" ")) || "Unknown";
  return { first, last, full };
}

// ---------------------------------------------------------------------------
// Stage mapping
// ---------------------------------------------------------------------------
export interface StageInfo { id: string; name: string; kind: string | null }

/** Same defaults the settings page shows. Pipedrive stage ids and Salesforce lead statuses differ per account, so they start empty. */
export const DEFAULT_STAGE_MAPPING: Record<ProviderName, Record<string, string>> = {
  hubspot: { replied: "lead", interested: "marketingqualifiedlead", meeting: "salesqualifiedlead", won: "customer" },
  pipedrive: {},
  salesforce: {},
};

/** A deal we created follows our won / lost stage even when the admin mapped nothing for the deal. */
export const NATIVE_DEAL_OUTCOME: Record<ProviderName, { won: string; lost: string }> = {
  hubspot: { won: "closedwon", lost: "closedlost" },
  pipedrive: { won: "won", lost: "lost" },
  salesforce: { won: "Closed Won", lost: "Closed Lost" },
};

function asTarget(v: StageTarget | string | null | undefined, provider: ProviderName): StageTarget {
  if (v === null || v === undefined || v === "") return {};
  // a plain string is the person's lifecycle stage / lead status, except in Pipedrive where stages only exist on deals
  if (typeof v === "string") return provider === "pipedrive" ? { deal: v.trim() } : { contact: v.trim() };
  const t: StageTarget = {};
  if (v.contact) t.contact = String(v.contact).trim();
  if (v.deal) t.deal = String(v.deal).trim();
  return t;
}

/** `{}` = defaults, a non-empty map is used as it is. Lookup order inside the map: stage id, stage name (lower case), stage kind. */
export function resolveStage(stage: StageInfo | null, provider: ProviderName, overrides: StageMapping | null | undefined): StageTarget | null {
  if (!stage) return null;
  const map: StageMapping = overrides && Object.keys(overrides).length > 0 ? overrides : DEFAULT_STAGE_MAPPING[provider];
  const keys = [stage.id, stage.name?.trim().toLowerCase(), stage.kind ?? undefined].filter((k): k is string => !!k);
  let target: StageTarget = {};
  for (const k of keys) if (Object.prototype.hasOwnProperty.call(map, k)) { target = asTarget(map[k], provider); break; }
  if (!target.deal && (stage.kind === "won" || stage.kind === "lost")) target.deal = NATIVE_DEAL_OUTCOME[provider][stage.kind];
  return target.contact || target.deal ? target : null;
}

// ---------------------------------------------------------------------------
// Events → operations
// ---------------------------------------------------------------------------
export interface IntegrationEvent { id: number; event: string; payload: Record<string, any>; at: string }

export type PlannedOp =
  | { op: "ensure_contact"; force: boolean }
  | { op: "log_message" }
  | { op: "set_stage"; stageId: string | null; kind?: string }
  | { op: "create_deal" }
  | { op: "note"; title: string; text: string };

export interface EventPlan { leadId: string | null; ops: PlannedOp[]; ignore?: string }

export function eventLeadId(ev: IntegrationEvent): string | null {
  const p = ev.payload ?? {};
  if (ev.event.startsWith("lead.")) return p.id ?? p.lead_id ?? null;
  return p.lead_id ?? null;
}

/** What one event means for the CRM. Pure: the engine decides later whether the lead may sync at all. */
export function planEvent(ev: IntegrationEvent, settings: IntegrationSettings): EventPlan {
  const leadId = eventLeadId(ev);
  if (!leadId) return { leadId: null, ops: [], ignore: "no lead on this event" };
  const p = ev.payload ?? {};
  const logMessages = settings.log_messages !== false;
  switch (ev.event) {
    case "message.sent":
    case "message.received":
    case "email.sent":
      return { leadId, ops: logMessages ? [{ op: "ensure_contact", force: false }, { op: "log_message" }] : [{ op: "ensure_contact", force: false }] };
    case "lead.updated":
      // emitted on stage, list and do-not-contact changes; the engine drops the stage op when the stage did not change
      return { leadId, ops: p.stage_id ? [{ op: "ensure_contact", force: true }, { op: "set_stage", stageId: p.stage_id }] : [{ op: "ensure_contact", force: false }] };
    case "message.classified":
      if (p.intent === "interested" && settings.create_deal_on_interested === true) return { leadId, ops: [{ op: "ensure_contact", force: false }, { op: "create_deal" }] };
      return { leadId, ops: p.intent === "interested" ? [{ op: "ensure_contact", force: false }] : [], ignore: p.intent === "interested" ? undefined : "intent is not interested" };
    case "meeting.booked": {
      const when = p.starts_at ? ` for ${String(p.starts_at).replace("T", " ").slice(0, 16)} UTC` : "";
      const via = p.provider ? ` (${p.provider})` : "";
      return { leadId, ops: [{ op: "ensure_contact", force: false }, { op: "note", title: "Meeting booked", text: `Meeting booked${when}${via}.` }, { op: "set_stage", stageId: null, kind: "meeting" }] };
    }
    case "enrollment.started":
    case "invite.accepted":
    case "lead.created":
      return { leadId, ops: [{ op: "ensure_contact", force: false }] };
    default:
      return { leadId, ops: [], ignore: "event is not synced" };
  }
}

// ---------------------------------------------------------------------------
// Sync log helpers
// ---------------------------------------------------------------------------
export interface LastLog { status: string; at: string }

/** "Skipped" is logged once per lead per day at most: stay silent when the lead's newest row is already today's skip. */
export function shouldLogSkip(last: LastLog | null, now: Date = new Date()): boolean {
  if (!last || last.status !== "skipped") return true;
  return String(last.at).slice(0, 10) !== now.toISOString().slice(0, 10);
}

export function skipDetail(rule: string | undefined): string {
  if (rule === "interested") return "Not synced: the sync rule is 'only interested leads' and this lead is not marked interested yet.";
  if (rule === "enrolled") return "Not synced: the sync rule is 'everyone enrolled' and this lead is not in a sequence.";
  return "Not synced: the sync rule is 'only leads who replied' and this lead has not replied yet.";
}

/** Marker stored in the log detail so one message is never logged twice (events are processed at least once). */
export const messageMarker = (messageId: string): string => `msg:${messageId.replace(/-/g, "").slice(0, 10)}`;

export const MAX_ACTIVITY_TEXT = 2000;
/** our own notes (conversation so far) may be longer than one message */
export const MAX_NOTE_TEXT = 6000;
export function trimText(text: string | null | undefined, max = MAX_ACTIVITY_TEXT): string {
  const t = (text ?? "").replace(/\r\n/g, "\n").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}

export function activityTitle(a: ActivityInput): string {
  if (a.note) return a.title ?? "Outreach note";
  const ch = a.channel === "email" ? "Email" : "LinkedIn message";
  const head = a.direction === "in" ? `${ch} received` : `${ch} sent`;
  const attr = a.sequence ? ` · ${a.sequence}${a.step ? ` · Step ${a.step}` : ""}` : "";
  return head + attr;
}

/** Plain-text body: title line, optional subject, then the text. */
export function activityText(a: ActivityInput): string {
  const lines = [activityTitle(a)];
  if (a.subject) lines.push(`Subject: ${a.subject}`);
  lines.push("", trimText(a.text, a.note ? MAX_NOTE_TEXT : MAX_ACTIVITY_TEXT));
  return lines.join("\n");
}

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Same content for CRMs whose notes are HTML (HubSpot, Pipedrive). */
export function activityHtml(a: ActivityInput): string {
  const parts = [`<strong>${escapeHtml(activityTitle(a))}</strong>`];
  if (a.subject) parts.push(`Subject: ${escapeHtml(a.subject)}`);
  parts.push(escapeHtml(trimText(a.text, a.note ? MAX_NOTE_TEXT : MAX_ACTIVITY_TEXT)).replace(/\n/g, "<br>"));
  return parts.join("<br>");
}

// ---------------------------------------------------------------------------
// Import + blacklist helpers
// ---------------------------------------------------------------------------
export function linkedinIdentifier(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#\s]+)/i.exec(url);
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase(); } catch { return m[1].toLowerCase(); }
}

/** Mail providers are never a company domain: blocking gmail.com would block half the list. */
export const FREE_MAIL = new Set(["gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.co.in", "hotmail.com", "hotmail.co.uk", "outlook.com", "live.com", "msn.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "gmx.de", "mail.com", "zoho.com", "yandex.com", "yandex.ru", "qq.com", "163.com", "rediffmail.com"]);

export function emailDomain(email: string | null | undefined): string | null {
  const m = /@([^@\s]+)$/.exec((email ?? "").trim().toLowerCase());
  return m && !FREE_MAIL.has(m[1]) ? m[1] : null;
}

export type SuppressionKind = "email" | "domain" | "company";

/** Mirrors the normalisation in outreach_add_suppressions so the diff compares like with like. */
export function normaliseSuppression(kind: SuppressionKind, value: string | null | undefined): string | null {
  let v = (value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (kind === "email") return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? v : null;
  if (kind === "domain") {
    v = v.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "");
    if (!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(v) || FREE_MAIL.has(v)) return null;
    return v;
  }
  if (/linkedin\.com\/company\//.test(v)) v = v.replace(/^.*linkedin\.com\/company\//, "").replace(/[/?#].*$/, "");
  return v.length >= 2 ? v.slice(0, 200) : null;
}

export interface SuppressionRow { id: string; kind: string; value: string }

/** What to add and which of our own CRM-sourced rows to remove. Rows from other sources are never touched. */
export function diffSuppressions(existing: SuppressionRow[], fresh: { emails: string[]; domains: string[]; companies: string[] }): { add: { kind: SuppressionKind; value: string }[]; removeIds: string[]; total: number } {
  const want = new Map<string, { kind: SuppressionKind; value: string }>();
  const put = (kind: SuppressionKind, list: string[]) => { for (const raw of list) { const v = normaliseSuppression(kind, raw); if (v) want.set(`${kind}:${v}`, { kind, value: v }); } };
  put("email", fresh.emails); put("domain", fresh.domains); put("company", fresh.companies);
  const have = new Set(existing.map((r) => `${r.kind}:${String(r.value).toLowerCase()}`));
  const add = [...want.entries()].filter(([k]) => !have.has(k)).map(([, v]) => v);
  const removeIds = existing.filter((r) => !want.has(`${r.kind}:${String(r.value).toLowerCase()}`)).map((r) => r.id);
  return { add, removeIds, total: want.size };
}
