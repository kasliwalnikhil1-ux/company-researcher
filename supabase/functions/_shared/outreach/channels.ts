// Channel capability descriptors (docs/outreach/CHANNELS-BUILD-CONTRACT.md §2 / §4).
// The engine reads capabilities from outreach_channel_capabilities (seeded, one row per provider) instead of branching
// on provider names. The table is the source of truth; the defaults below only cover a missing row so a worker keeps
// running (with the safest numbers) while the seed is being applied.
import { admin, log, randInt } from "./supabase.ts";

export type Provider = "LINKEDIN" | "INSTAGRAM" | "WHATSAPP" | "GMAIL" | "OUTLOOK" | "IMAP";

export const MAIL_PROVIDERS: Provider[] = ["GMAIL", "OUTLOOK", "IMAP"];
export const CHANNEL_PROVIDERS: Provider[] = ["LINKEDIN", "INSTAGRAM", "WHATSAPP"];
export const isMailProvider = (p: string | null | undefined): boolean => MAIL_PROVIDERS.includes(String(p ?? "") as Provider);

export interface ChannelCapabilities {
  provider: Provider;
  identifier_kind: "slug" | "handle" | "phone_e164" | "email";
  has_connection_graph: boolean;
  connection_is_permission: boolean;
  acceptance_webhook: boolean;
  can_validate_identifier: boolean;
  supports: {
    invite: boolean; inmail: boolean; follow: boolean; post_react: boolean; post_comment: boolean; profile_view: boolean;
    voice_note: boolean; attachment: boolean; embed_video: boolean; search_people: "full" | "partial" | "none";
  };
  ledger: {
    hourly: { scope: string; cap: number; types: string[] } | null;
    daily_scope: { scope: string; types: string[] } | null;
    min_gap_seconds: [number, number];
    post_connect_quiet_hours: number;
  };
  consent: { required_for_first_contact: boolean; accepted_bases: string[] };
}

const IG_METERED = ["follow", "unfollow", "new_chat", "message", "like", "comment", "profile_view", "followers_poll", "post_fetch"];

/** Fallbacks for a provider whose row is missing (mirrors the 025 seed). */
const DEFAULTS: Record<Provider, ChannelCapabilities> = {
  LINKEDIN: {
    provider: "LINKEDIN", identifier_kind: "slug", has_connection_graph: true, connection_is_permission: true, acceptance_webhook: true, can_validate_identifier: false,
    supports: { invite: true, inmail: true, follow: false, post_react: true, post_comment: true, profile_view: true, voice_note: true, attachment: true, embed_video: false, search_people: "full" },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [90, 400], post_connect_quiet_hours: 0 },
    consent: { required_for_first_contact: false, accepted_bases: [] },
  },
  INSTAGRAM: {
    provider: "INSTAGRAM", identifier_kind: "handle", has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false,
    supports: { invite: false, inmail: false, follow: true, post_react: true, post_comment: true, profile_view: true, voice_note: false, attachment: true, embed_video: false, search_people: "partial" },
    ledger: { hourly: { scope: "all_metered", cap: 10, types: IG_METERED }, daily_scope: { scope: "all_metered", types: IG_METERED }, min_gap_seconds: [60, 240], post_connect_quiet_hours: 0 },
    consent: { required_for_first_contact: false, accepted_bases: [] },
  },
  WHATSAPP: {
    provider: "WHATSAPP", identifier_kind: "phone_e164", has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: true,
    supports: { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: false, voice_note: true, attachment: true, embed_video: false, search_people: "none" },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [10, 20], post_connect_quiet_hours: 24 },
    consent: { required_for_first_contact: true, accepted_bases: ["inbound", "form_optin", "existing_customer", "linkedin_reply", "explicit_share", "imported_attested"] },
  },
  GMAIL: {
    provider: "GMAIL", identifier_kind: "email", has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false,
    supports: { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: false, voice_note: false, attachment: true, embed_video: false, search_people: "none" },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [30, 120], post_connect_quiet_hours: 0 },
    consent: { required_for_first_contact: false, accepted_bases: [] },
  },
  OUTLOOK: {
    provider: "OUTLOOK", identifier_kind: "email", has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false,
    supports: { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: false, voice_note: false, attachment: true, embed_video: false, search_people: "none" },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [30, 120], post_connect_quiet_hours: 0 },
    consent: { required_for_first_contact: false, accepted_bases: [] },
  },
  IMAP: {
    provider: "IMAP", identifier_kind: "email", has_connection_graph: false, connection_is_permission: false, acceptance_webhook: false, can_validate_identifier: false,
    supports: { invite: false, inmail: false, follow: false, post_react: false, post_comment: false, profile_view: false, voice_note: false, attachment: true, embed_video: false, search_people: "none" },
    ledger: { hourly: null, daily_scope: null, min_gap_seconds: [30, 120], post_connect_quiet_hours: 0 },
    consent: { required_for_first_contact: false, accepted_bases: [] },
  },
};

const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; caps: ChannelCapabilities }>();

function normalise(provider: Provider, row: Record<string, any> | null): ChannelCapabilities {
  const d = DEFAULTS[provider] ?? DEFAULTS.LINKEDIN;
  if (!row) return d;
  const ledger = row.ledger ?? {};
  const gap = Array.isArray(ledger.min_gap_seconds) && ledger.min_gap_seconds.length === 2 ? [Number(ledger.min_gap_seconds[0]), Number(ledger.min_gap_seconds[1])] as [number, number] : d.ledger.min_gap_seconds;
  return {
    provider,
    identifier_kind: row.identifier_kind ?? d.identifier_kind,
    has_connection_graph: row.has_connection_graph ?? d.has_connection_graph,
    connection_is_permission: row.connection_is_permission ?? d.connection_is_permission,
    acceptance_webhook: row.acceptance_webhook ?? d.acceptance_webhook,
    can_validate_identifier: row.can_validate_identifier ?? d.can_validate_identifier,
    supports: { ...d.supports, ...(row.supports ?? {}) },
    ledger: {
      hourly: ledger.hourly && typeof ledger.hourly === "object" ? { scope: String(ledger.hourly.scope ?? "all_metered"), cap: Number(ledger.hourly.cap ?? 0), types: Array.isArray(ledger.hourly.types) ? ledger.hourly.types.map(String) : [] } : null,
      daily_scope: ledger.daily_scope && typeof ledger.daily_scope === "object" ? { scope: String(ledger.daily_scope.scope ?? "all_metered"), types: Array.isArray(ledger.daily_scope.types) ? ledger.daily_scope.types.map(String) : [] } : null,
      min_gap_seconds: gap,
      post_connect_quiet_hours: Number(ledger.post_connect_quiet_hours ?? d.ledger.post_connect_quiet_hours),
    },
    consent: { required_for_first_contact: row.consent?.required_for_first_contact ?? d.consent.required_for_first_contact, accepted_bases: Array.isArray(row.consent?.accepted_bases) ? row.consent.accepted_bases.map(String) : d.consent.accepted_bases },
  };
}

/** The descriptor for a provider, cached for five minutes. Falls back to the seed defaults when the row is missing. */
export async function capabilitiesFor(provider: string | null | undefined): Promise<ChannelCapabilities> {
  const p = (String(provider ?? "LINKEDIN").toUpperCase() as Provider);
  const hit = cache.get(p);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.caps;
  let row: Record<string, any> | null = null;
  try {
    const { data, error } = await admin.from("outreach_channel_capabilities").select("*").eq("provider", p).maybeSingle();
    if (error) log({ fn: "channels", warn: `capabilities read: ${error.message}` });
    row = data ?? null;
  } catch (e) { log({ fn: "channels", warn: `capabilities read: ${String((e as any)?.message ?? e)}` }); }
  const caps = normalise(p, row);
  cache.set(p, { at: Date.now(), caps });
  return caps;
}

export function clearCapabilitiesCache(): void { cache.clear(); }

/** Digits of an E.164 number (the WhatsApp identifier form): "+91 98765 43210" → "919876543210". */
export function phoneDigits(e164: string | null | undefined): string {
  return String(e164 ?? "").replace(/\D+/g, "");
}

/** Handle from an Instagram profile URL or a raw handle: "https://www.instagram.com/some.one/" → "some.one". */
export function instagramHandle(v: string | null | undefined): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const m = /instagram\.com\/([^/?#]+)/i.exec(s);
  const h = (m ? m[1] : s).replace(/^@/, "").replace(/\/+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,60}$/.test(h) ? h : null;
}

/** The WhatsApp attendee id of a phone: "<digits>@s.whatsapp.net". */
export function whatsappAttendeeId(e164OrDigits: string): string {
  const digits = phoneDigits(e164OrDigits);
  return `${digits}@s.whatsapp.net`;
}

/** E.164 from a WhatsApp attendee id ("919876543210@s.whatsapp.net" → "+919876543210"); null for group / non-user ids. */
export function phoneFromAttendeeId(attendeeId: string | null | undefined): string | null {
  const m = /^(\d{6,16})@(?:s\.whatsapp\.net|c\.us)$/i.exec(String(attendeeId ?? "").trim());
  return m ? `+${m[1]}` : null;
}

export interface LeadIdentity { id?: string | null; identifier: string | null; provider_id: string | null; verified?: boolean; is_valid?: boolean | null }

/**
 * The `attendees_ids` entry POST /chats needs for a lead on a provider:
 * LinkedIn the provider id; Instagram the messaging id (stored on the identity's provider_id by the profile read);
 * WhatsApp "<digits>@s.whatsapp.net". null when the identity cannot address a chat yet.
 */
export function attendeeIdFor(provider: string, identity: LeadIdentity | null | undefined): string | null {
  if (!identity) return null;
  switch (String(provider).toUpperCase()) {
    case "WHATSAPP": { const d = phoneDigits(identity.identifier ?? identity.provider_id); return d ? whatsappAttendeeId(d) : null; }
    case "INSTAGRAM": return identity.provider_id ? String(identity.provider_id) : null;
    default: return identity.provider_id ? String(identity.provider_id) : null;
  }
}

/** Outbound action types: gated by the quiet period and the min gap, never replies / reads. */
const OUTBOUND_TYPES = new Set(["new_chat", "message", "follow", "unfollow", "like", "comment", "invite", "inmail", "profile_view", "email", "endorse", "withdraw"]);
export function isOutboundType(type: string): boolean { return OUTBOUND_TYPES.has(String(type)); }

/**
 * The planner's gap range in seconds. WhatsApp's documented floor is 10–20 s; the planner keeps at least 20–90 s
 * between its own actions (the execution-time claim enforces the floor itself).
 */
export function minGapRange(caps: ChannelCapabilities): [number, number] {
  let [lo, hi] = caps.ledger.min_gap_seconds;
  if (!isFinite(lo) || lo < 0) lo = 0;
  if (!isFinite(hi) || hi < lo) hi = lo;
  if (caps.provider === "WHATSAPP") { lo = Math.max(lo, 20); hi = Math.max(hi, 90); }
  return [lo, hi];
}

/** One randomised gap in milliseconds, drawn inside the descriptor's range. */
export function minGapMs(caps: ChannelCapabilities): number {
  const [lo, hi] = minGapRange(caps);
  return randInt(lo, hi) * 1000;
}

/** Whether a type counts against the hourly scope of the descriptor (Instagram: every metered action). */
export function isHourlyMetered(caps: ChannelCapabilities, type: string): boolean {
  const h = caps.ledger.hourly;
  if (!h) return false;
  return h.types.length ? h.types.includes(type) : type !== "reply";
}

/** Whether a type counts against the daily `all_metered` scope. */
export function isDailyScoped(caps: ChannelCapabilities, type: string): boolean {
  const d = caps.ledger.daily_scope;
  if (!d) return false;
  return d.types.length ? d.types.includes(type) : type !== "reply";
}

/** Per-provider text limits for a chat message. */
export function messageLimit(provider: string): number {
  switch (String(provider).toUpperCase()) {
    case "INSTAGRAM": return 1000;
    case "WHATSAPP": return 4096;
    default: return 8000;
  }
}

/** Per-provider comment limits. */
export function commentLimit(provider: string): number {
  return String(provider).toUpperCase() === "INSTAGRAM" ? 2200 : 1250;
}

/** Unipile codes that mean "this number is not on WhatsApp" (or the identifier cannot be addressed). */
export function isNotOnWhatsApp(e: unknown): boolean {
  const status = Number((e as any)?.status ?? 0);
  const code = String((e as any)?.code ?? "");
  return status === 404 || ["invalid_recipient", "user_unreachable", "invalid_account"].includes(code);
}

/** Instagram's "We suspect automated behavior" family of provider warnings. */
export const PROVIDER_WARNING_RE = /automated|suspect/i;
