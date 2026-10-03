// Inbound Unipile event processing (F2 handlers).
import { admin, log, rpc, emitEvent, audit, randInt } from "./supabase.ts";
import { webchatMailHook } from "./webchat.ts";
import { notifyReturned } from "./ai_reply.ts";
import { unipile, unipileConfigured, UnipileError, distanceToRelation, invitationPending, hostedBrowserOptions } from "./unipile.ts";
import { notifySender } from "./notify.ts";
import { healthForSender } from "./health.ts";
import { dropConnectorAccount } from "./disconnect.ts";
import { fillChatPicture, persistPictureUrl } from "./avatars.ts";
import { instagramHandle, phoneDigits, phoneFromAttendeeId, whatsappPhoneOf, isWhatsappGroup, visibleName, PROVIDER_WARNING_RE } from "./channels.ts";

type Sender = Record<string, any>;
type Row = Record<string, any>;

const CHANNEL = (p: unknown): boolean => p === "INSTAGRAM" || p === "WHATSAPP";
const isAudio = (a: any): boolean => String(a?.type ?? a?.attachment_type ?? "").toLowerCase() === "audio" || String(a?.mimetype ?? a?.mime ?? "").toLowerCase().startsWith("audio/");

// Windows-1252 characters 0x80–0x9F → their byte (the rest of Latin-1 maps to itself).
const CP1252: Record<string, number> = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };
const MOJIBAKE_RE = /[ÃÂâð][\u0080-¿Œ-ƒˆ˜–-™\udc80-\udcff]/;

/**
 * Instagram texts sometimes arrive as UTF-8 that was read as Windows-1252 ("â€œmathâ€" for “math”). Undo that when the
 * text looks like it and decodes cleanly as UTF-8; anything else is returned unchanged.
 */
export function fixMojibake<T extends string | null | undefined>(s: T): T {
  if (!s || !MOJIBAKE_RE.test(s)) return s;
  const bytes: number[] = [];
  for (const ch of s as string) {
    const c = ch.codePointAt(0)!;
    if (c < 0x100) bytes.push(c);
    else if (CP1252[ch] !== undefined) bytes.push(CP1252[ch]);
    else if (c >= 0xdc80 && c <= 0xdcff) bytes.push(c - 0xdc00);   // an undefined 1252 byte kept as a lone surrogate
    else return s;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes)) as T; } catch { return s; }
}

/**
 * The connector's stand-in text for a message type it cannot read yet ("-- Unipile cannot display this type of message
 * yet …"). It names the vendor, so it is never stored or passed on: the DB trigger from 031 drops it and flags the
 * message `unsupported`; webhook events and the classifier skip it here.
 */
export function isUnsupportedPlaceholder(s: unknown): boolean {
  return typeof s === "string" && /unipile cannot display/i.test(s);
}

/**
 * One stored attachment from either payload shape: the messages API ({id, type, mimetype, file_name, file_size}) or the
 * messaging webhook ({attachment_id, attachment_type, attachment_name, attachment_size}). Instagram shares of a post or
 * reel ("media_share") carry the post link, kept as `link` so the inbox can show it.
 */
export function storedAttachment(a: any, unipileMessageId: string | null): Row {
  const size = a.file_size ?? a.attachment_size ?? (typeof a.size === "number" ? a.size : null);
  const link = a.post?.url ?? a.cta?.url ?? null;
  const out: Row = {
    id: a.id ?? a.attachment_id ?? null, type: a.type ?? a.attachment_type ?? null, mimetype: a.mimetype ?? a.mime ?? null,
    name: a.file_name ?? a.attachment_name ?? (typeof a.name === "string" ? a.name : null), size: typeof size === "number" ? size : null,
    unipile_message_id: unipileMessageId,
  };
  if (a.unavailable === true || a.attachment_unavailable === true) out.unavailable = true;
  if (link) out.link = { url: String(link), author: a.post?.author ?? null, text: fixMojibake(a.cta?.text && a.cta.text !== a.post?.author ? String(a.cta.text).slice(0, 300) : null) };
  if (isAudio(a)) { out.voice_note = true; out.duration_s = a.duration ?? a.duration_s ?? null; }
  // WhatsApp detail the thread renders like the app does: stickers without a bubble, GIFs looping, contact cards
  if (a.sticker === true || a.sticker === 1) out.sticker = true;
  if (a.gif === true || a.gif === 1) out.gif = true;
  if (a.type === "contact_card" || a.attachment_type === "contact_card") {
    out.contact = { name: a.display_name ?? null, phones: (Array.isArray(a.phones) ? a.phones : []).map((p: any) => String(p?.number ?? p ?? "")).filter(Boolean).slice(0, 5) };
  }
  // a LinkedIn post shared in the chat: keep the post's own address (a CDN file link expires, a post link does not)
  if (out.type === "linkedin_post" && !out.link && typeof a.url === "string" && /^https:\/\/(www\.)?linkedin\.com\//i.test(a.url)) out.link = { url: a.url, author: null, text: null };
  // LinkedIn video meeting invite: when it starts / ends, so the inbox can show a meeting card
  if (out.type === "video_meeting") {
    out.meeting = { starts_at: a.starts_at ?? null, expires_at: a.expires_at ?? null, time_range: a.time_range ?? null, url: typeof a.url === "string" && /^https:\/\//.test(a.url) && !a.url_expires_at ? a.url : null };
  }
  return out;
}

/**
 * What the thread shows besides the text, kept on `content_attributes` (049, every row has it): the connector's
 * `message_type` when it is not a plain message (INMAIL, INVITATION, STORY_REPLY, STORY_MENTION …), an InMail's subject,
 * view-once media. Empty for an ordinary message.
 */
export function messageMeta(m: any, keepSubject: boolean): Row {
  const out: Row = {};
  const type = String(m?.message_type ?? "").toUpperCase();
  if (type && type !== "MESSAGE") out.msg_type = type;
  if (keepSubject && typeof m?.subject === "string" && m.subject.trim()) out.subject = fixMojibake(m.subject.trim().slice(0, 300));
  if (m?.is_view_once === true || m?.is_view_once === 1) out.view_once = true;
  return out;
}

/** LinkedIn chat kind (InMail / sponsored / job offer) and which inbox it sits in (Sales Navigator, Recruiter, a page). */
export function linkedinChatMeta(c: any): Row | null {
  const content = typeof c?.content_type === "string" ? c.content_type : (typeof c?.chat_content_type === "string" ? c.chat_content_type : null);
  const folders: string[] = (Array.isArray(c?.folder) ? c.folder : typeof c?.folder === "string" ? [c.folder] : []).map(String);
  const inbox = folders.includes("INBOX_LINKEDIN_SALES_NAVIGATOR") ? "sales_navigator" : folders.includes("INBOX_LINKEDIN_RECRUITER") ? "recruiter" : folders.includes("INBOX_LINKEDIN_ORGANIZATION") ? "organization" : null;
  if (!content && !inbox) return null;
  return { content_type: content, inbox };
}

type MailPerson = { name: string | null; email: string };
const mailPeople = (list: any): MailPerson[] => (Array.isArray(list) ? list : [])
  .map((a: any) => ({ name: visibleName(a?.display_name) ?? null, email: String(a?.identifier ?? "").trim().toLowerCase() }))
  .filter((a) => a.email).slice(0, 50);

/** The people on an email (from / to / cc / bcc / reply-to) and its subject, as the thread's mail header shows them. */
export function emailMeta(p: any): Row {
  const from = mailPeople([p?.from_attendee])[0] ?? null;
  return { from, to: mailPeople(p?.to_attendees), cc: mailPeople(p?.cc_attendees), bcc: mailPeople(p?.bcc_attendees), reply_to: mailPeople(p?.reply_to_attendees), subject: p?.subject ? String(p.subject).slice(0, 500) : null };
}

/**
 * Stop intent in an inbound WhatsApp / Instagram message (multi-language). "STOP" alone, the listed words at the start
 * of the message, or a short message (≤ 40 chars) that says unsubscribe / opt out / remove me.
 */
export function isStopIntent(text: string | null | undefined): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/^stop[.!]*$/i.test(t)) return true;
  // a letter/digit lookahead instead of \b: \b is ASCII-only and never matches after Devanagari
  if (/^\s*(stop|unsubscribe|remove me|no more|opt out|arr[êe]t|stopp|basta|para|detener|rok|band karo|बंद|nahi chahiye)(?![\p{L}\p{N}])/iu.test(t)) return true;
  if (t.length <= 40 && /(unsubscribe|opt[ -]?out|remove me)/i.test(t)) return true;
  return false;
}

export function deriveSource(p: any): { source: string; event_type: string | null; account_id: string | null } {
  if (p?.AccountStatus) return { source: "account_status", event_type: String(p.AccountStatus.message ?? "").toUpperCase(), account_id: p.AccountStatus.account_id ?? null };
  if (p?.event === "new_relation") return { source: "users", event_type: "new_relation", account_id: p.account_id ?? null };
  if (p?.tracking_id && p?.event && String(p.event).startsWith("mail_") && (p.event === "mail_opened" || p.event === "mail_link_clicked")) return { source: "mail_tracking", event_type: p.event, account_id: p.account_id ?? null };
  if (p?.email_id) return { source: "mail", event_type: p.event ?? "mail_received", account_id: p.account_id ?? null };
  if (p?.message_id || p?.chat_id) return { source: "messaging", event_type: p.event ?? "message_received", account_id: p.account_id ?? null };
  if (p?.event_id || String(p?.event ?? "").startsWith("calendar_")) return { source: "calendar", event_type: p.event ?? null, account_id: p.account_id ?? null };
  if (p?.status && p?.account_id && p?.name) return { source: "hosted_notify", event_type: String(p.status).toUpperCase(), account_id: p.account_id };
  return { source: "unknown", event_type: p?.event ?? null, account_id: p?.account_id ?? null };
}

async function senderByAccount(accountId: string | null): Promise<Sender | null> {
  if (!accountId) return null;
  const { data } = await admin.from("outreach_senders").select("*").eq("unipile_account_id", accountId).maybeSingle();
  return data ?? null;
}

// ---------------------------------------------------------------------------
// account_status
// ---------------------------------------------------------------------------
export async function syncOwnProfile(sender: Sender): Promise<Sender> {
  if (!sender.unipile_account_id || !unipileConfigured()) return sender;
  const patch: Record<string, unknown> = {};
  try {
    if (sender.provider === "LINKEDIN") {
      const me = await unipile.users.me(sender.unipile_account_id);
      patch.public_identifier = me.public_identifier ?? sender.public_identifier;
      patch.provider_user_id = me.provider_id ?? sender.provider_user_id;
      patch.display_name = sender.display_name ?? [me.first_name, me.last_name].filter(Boolean).join(" ") ?? sender.display_name;
      if (!sender.display_name || sender.display_name === "LinkedIn sender") patch.display_name = [me.first_name, me.last_name].filter(Boolean).join(" ") || sender.display_name;
      patch.picture_url = typeof me.profile_picture_url === "string" ? me.profile_picture_url : sender.picture_url;
      patch.is_premium = !!me.premium;
      patch.has_sales_nav = !!me.sales_navigator;
      patch.has_recruiter = !!me.recruiter;
      if (!sender.owner_email && me.email) patch.owner_email = String(me.email).trim().toLowerCase();
      // connections_count comes from the full profile
      try {
        const ident = me.public_identifier ?? me.provider_id;
        if (ident) {
          const prof = await unipile.users.profile(sender.unipile_account_id, ident, { linkedin_sections: "*_preview" });
          if (typeof prof.connections_count === "number") patch.connections_count = prof.connections_count;
          if (!patch.picture_url && prof.profile_picture_url) patch.picture_url = prof.profile_picture_url;
        }
      } catch (e) { log({ fn: "syncOwnProfile", warn: "profile fetch failed", error: String(e) }); }
    } else if (sender.provider === "INSTAGRAM") {
      // users/me on Instagram: username → public identifier, the user id, the display name and the picture
      const me = await unipile.users.me(sender.unipile_account_id);
      const handle = instagramHandle(me.username ?? me.public_identifier ?? null);
      patch.public_identifier = handle ?? sender.public_identifier;
      patch.provider_user_id = me.provider_id ?? me.id ?? sender.provider_user_id;
      const name = String(me.full_name ?? me.name ?? "").trim();
      if (!sender.display_name || sender.display_name === "Instagram account") patch.display_name = name || (handle ? `@${handle}` : null) || sender.display_name;
      // Instagram CDN pictures are blocked cross-site in browsers: keep a stored copy
      if (typeof me.profile_picture_url === "string") patch.picture_url = (await persistPictureUrl(me.profile_picture_url, sender.workspace_id, `sender-${sender.id}`)) ?? sender.picture_url;
      if (typeof me.followers_count === "number") patch.connections_count = me.followers_count;
    } else if (sender.provider === "WHATSAPP") {
      // users/me on WhatsApp: the number as +digits, the profile name, the id the messaging payloads use for "us"
      const me = await unipile.users.me(sender.unipile_account_id);
      const digits = phoneDigits(me.phone_number ?? me.phone ?? phoneFromAttendeeId(me.id ?? me.provider_id) ?? "");
      patch.public_identifier = digits ? `+${digits}` : sender.public_identifier;
      patch.provider_user_id = me.id ?? me.provider_id ?? (digits ? `${digits}@s.whatsapp.net` : sender.provider_user_id);
      const name = String(me.name ?? me.display_name ?? "").trim();
      if (!sender.display_name || sender.display_name === "WhatsApp number") patch.display_name = name || (digits ? `+${digits}` : null) || sender.display_name;
      // WhatsApp picture links expire: keep a stored copy
      if (typeof me.profile_picture_url === "string") patch.picture_url = (await persistPictureUrl(me.profile_picture_url, sender.workspace_id, `sender-${sender.id}`)) ?? sender.picture_url;
    } else {
      const me = await unipile.users.me(sender.unipile_account_id);
      patch.public_identifier = me.email ? String(me.email).trim().toLowerCase() : sender.public_identifier;
      patch.display_name = sender.display_name ?? me.display_name ?? me.email ?? sender.display_name;
      if (!sender.owner_email && me.email) patch.owner_email = String(me.email).trim().toLowerCase();
    }
    // account connection method (cookies vs credentials) from Unipile
    try {
      const acc = await unipile.accounts.get(sender.unipile_account_id);
      const method = acc?.connection_params?.im?.connection_method;
      // "browser" (extension sign-in) is chosen at connect time and is not reported here; keep it.
      if (sender.auth_method !== "browser") {
        if (method === "cookies") patch.auth_method = "cookie";
        else if (method === "credentials") patch.auth_method = "credentials";
      }
      const proxyHost = acc?.connection_params?.im?.proxy?.host;
      if (proxyHost && !sender.proxy_country) patch.proxy_ip_hint = null;
    } catch { /* ignore */ }
  } catch (e) {
    log({ fn: "syncOwnProfile", error: String(e), sender_id: sender.id });
  }
  if (Object.keys(patch).length) {
    const { data } = await admin.from("outreach_senders").update(patch).eq("id", sender.id).select("*").single();
    return data ?? { ...sender, ...patch };
  }
  return sender;
}

/**
 * A LinkedIn/mailbox identity may only exist once per workspace. When a freshly connected sender turns out to be the
 * same account as an existing (non-deleted) sender — typically the owner used "Connect an account" instead of
 * "Reconnect" after a re-login prompt — fold the new connection into the existing row: it takes over the new Unipile
 * account id and profile fields, keeps its chats / lead state / enrollments / schedule, and the new row becomes a
 * tombstone (deleted_at set, status_reason "merged_into:<id>") so the hosted-auth redirect can forward to the survivor.
 * Returns the sender that now owns the account (the survivor, or `sender` unchanged when there is no duplicate).
 */
export async function absorbDuplicateSender(sender: Sender): Promise<Sender> {
  if (!sender.provider_user_id || !sender.unipile_account_id) return sender;
  const { data: twins } = await admin.from("outreach_senders").select("*")
    .eq("workspace_id", sender.workspace_id).eq("provider", sender.provider).eq("provider_user_id", sender.provider_user_id)
    .neq("id", sender.id).is("deleted_at", null).order("created_at");
  const survivor = (twins ?? [])[0];
  if (!survivor) return sender;
  const newAccountId = sender.unipile_account_id as string;
  const oldAccountId = survivor.unipile_account_id as string | null;
  const now = new Date().toISOString();
  // 1. free the unique unipile_account_id on the duplicate and tombstone it
  const { error: e1 } = await admin.from("outreach_senders").update({
    unipile_account_id: null, status: "disabled", status_reason: `merged_into:${survivor.id}`, deleted_at: now,
  }).eq("id", sender.id);
  if (e1) { log({ fn: "absorbDuplicateSender", error: e1.message, sender_id: sender.id }); return sender; }
  // 2. the survivor takes over the new account and the fresh profile snapshot
  const patch: Record<string, unknown> = {
    unipile_account_id: newAccountId, status: survivor.status === "disabled" ? "disabled" : "connecting", status_reason: null,
    auth_method: sender.auth_method ?? survivor.auth_method, public_identifier: sender.public_identifier ?? survivor.public_identifier,
    picture_url: sender.picture_url ?? survivor.picture_url, is_premium: sender.is_premium ?? survivor.is_premium,
    has_sales_nav: sender.has_sales_nav ?? survivor.has_sales_nav, has_recruiter: sender.has_recruiter ?? survivor.has_recruiter,
    connections_count: sender.connections_count ?? survivor.connections_count, owner_email: survivor.owner_email ?? sender.owner_email,
    client_id: survivor.client_id ?? sender.client_id, connected_at: survivor.connected_at ?? now, last_ok_at: now,
    reconnect_attempts: 0, consecutive_errors: 0, paused_until: null,
  };
  const { data: merged, error: e2 } = await admin.from("outreach_senders").update(patch).eq("id", survivor.id).select("*").single();
  if (e2) { log({ fn: "absorbDuplicateSender", error: e2.message, sender_id: survivor.id }); return sender; }
  // 3. keep the connection history on the survivor; the old Unipile account (if still on the DSN) is now orphaned
  await admin.from("outreach_sender_events").update({ sender_id: survivor.id }).eq("sender_id", sender.id);
  await admin.from("outreach_sender_events").insert({ sender_id: survivor.id, kind: "reconnect", data: { method: "merged_duplicate", merged_sender_id: sender.id, previous_account_id: oldAccountId, account_id: newAccountId } });
  if (oldAccountId && oldAccountId !== newAccountId) {
    try { if (await accountExistsOnDsn(oldAccountId)) await unipile.accounts.delete(oldAccountId); } catch (e) { log({ fn: "absorbDuplicateSender", warn: "old account cleanup failed", error: String(e) }); }
  }
  await audit(survivor.workspace_id, "sender.merged_duplicate", "sender", survivor.id, { merged_sender_id: sender.id, previous_account_id: oldAccountId, account_id: newAccountId });
  log({ fn: "absorbDuplicateSender", merged: sender.id, into: survivor.id });
  return merged ?? { ...survivor, ...patch };
}

/** Onboarding gate (§13.4): thin/unknown accounts locked at level 0 for 28 days; free accounts capped at level 1. */
export async function applyOnboardingGate(sender: Sender): Promise<void> {
  const conns = sender.connections_count;
  const patch: Record<string, unknown> = {};
  if (sender.provider === "LINKEDIN" && (conns == null || conns < 150) && !sender.warmup_locked_until) {
    const until = new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);
    patch.warmup_level = 0;
    patch.warmup_locked_until = until;
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "warmup", data: { reason: "thin_account", connections_count: conns, locked_until: until } });
  }
  if (sender.provider === "LINKEDIN" && !sender.is_premium && sender.warmup_level > 1) patch.warmup_level = 1;
  // Instagram: every account starts at level 0 (follow / like / view only) for 14 days; the 14-day health rule lifts it afterwards
  if (sender.provider === "INSTAGRAM" && !sender.warmup_locked_until && !sender.connected_at) {
    const until = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
    patch.warmup_level = 0;
    patch.warmup_locked_until = until;
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "warmup", data: { reason: "instagram_onboarding", locked_until: until } });
  }
  // WhatsApp: level 0 (2 new chats a day) until the number's age is attested; the governor (outreach_wa_governor) promotes from there
  if (sender.provider === "WHATSAPP" && !sender.account_age_attested_at && (sender.warmup_level ?? 0) > 0) {
    patch.warmup_level = 0;
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "warmup", data: { reason: "account_age_not_attested" } });
  }
  if (Object.keys(patch).length) await admin.from("outreach_senders").update(patch).eq("id", sender.id);
}

/** Instagram "We suspect automated behavior": an account-status payload (PERMISSIONS / ERROR) whose text matches. The connector's
 *  docs say it can be ignored, so it is only logged: no pause, no level drop, and the status is not treated as an error. */
async function detectProviderWarning(sender: Sender, st: any, message: string): Promise<boolean> {
  if (sender.provider !== "INSTAGRAM" || !(message === "PERMISSIONS" || message === "ERROR")) return false;
  let blob = "";
  try { blob = JSON.stringify(st ?? {}); } catch { blob = String(st ?? ""); }
  if (!PROVIDER_WARNING_RE.test(blob)) return false;
  const text = String(st?.reason ?? st?.detail ?? st?.error ?? st?.description ?? st?.text ?? "We suspect automated behavior on your account").slice(0, 500);
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "provider_warning", data: { text, ignored: true, status: message } });
  return true;
}

export async function handleAccountStatus(payload: any): Promise<void> {
  const st = payload.AccountStatus ?? payload;
  const accountId = st.account_id;
  const message = String(st.message ?? "").toUpperCase();
  let sender = await senderByAccount(accountId);
  if (!sender) { log({ fn: "account_status", warn: "unknown account", accountId, message }); return; }
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "unipile", data: { message, product: st.product ?? null } });
  // the quiet period after a (re)connect is set by the database trigger on status → ok; here only the provider warning is detected
  const warned = await detectProviderWarning(sender, st, message);

  switch (message) {
    case "CREATION_SUCCESS": {
      sender = await syncOwnProfile(sender);
      sender = await absorbDuplicateSender(sender);
      await applyOnboardingGate(sender);
      // the hosted-auth notify usually lands first and may already have polled the account to ok: never move it back to connecting
      const keep = sender.status === "disabled" || sender.status === "ok" || sender.status === "paused";
      await admin.from("outreach_senders").update({ status: keep ? sender.status : "connecting", status_reason: keep ? sender.status_reason : null, connected_at: sender.connected_at ?? new Date().toISOString() }).eq("id", sender.id);
      break;
    }
    case "OK": {
      const wasCred = sender.status === "credentials" || sender.status === "error";
      await admin.from("outreach_senders").update({ status: sender.status === "paused" || sender.status === "disabled" ? sender.status : "ok", status_reason: null, last_ok_at: new Date().toISOString() }).eq("id", sender.id);
      if (!sender.provider_user_id || !sender.public_identifier) await syncOwnProfile(sender);
      if (wasCred) await healthForSender(sender.id, "reconnect");
      break;
    }
    case "RECONNECTED": {
      await admin.from("outreach_senders").update({ status: sender.status === "paused" || sender.status === "disabled" ? sender.status : "ok", status_reason: null, last_ok_at: new Date().toISOString(), reconnect_attempts: 0 }).eq("id", sender.id);
      await reconnectQuietPeriod(sender);
      await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { result: "reconnected" } });
      break;
    }
    case "SYNC_SUCCESS": {
      await admin.from("outreach_senders").update({ last_synced_at: new Date().toISOString() }).eq("id", sender.id);
      if (!st.product || String(st.product).toLowerCase() === "classic") await backfillChats(sender, 3);
      break;
    }
    case "CREDENTIALS": {
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "credentials", status_reason: "CREDENTIALS", last_disconnect_at: new Date().toISOString(), reconnect_attempts: 0 }).eq("id", sender.id);
      await healthForSender(sender.id, "disconnect");
      // LinkedIn cookie senders are retried by the reconnect worker first; every other sender is emailed a re-login link now
      if (!(sender.auth_method === "cookie" && sender.provider === "LINKEDIN")) {
        const link = await reloginUrl(sender).catch(() => null);
        await notifySender(sender.id, "reconnect_needed", { link });
        await admin.from("outreach_senders").update({ reconnect_notified_at: new Date().toISOString(), reconnect_reminders: 0 }).eq("id", sender.id);
      }
      break;
    }
    case "ERROR":
    case "STOPPED": {
      if (warned) break;   // a provider warning is a pause (level −1, 48 h), not a broken connection
      const errs = (sender.consecutive_errors ?? 0) + 1;
      await admin.from("outreach_senders").update({ status: sender.status === "disabled" ? "disabled" : "error", status_reason: message, consecutive_errors: errs }).eq("id", sender.id);
      if (errs >= 2) await notifySender(sender.id, "sender_error", { reason: message });
      break;
    }
    case "CONNECTING": break;
    case "DELETED": {
      await admin.from("outreach_senders").update({ status: "disabled", status_reason: "DELETED", deleted_at: sender.deleted_at ?? null }).eq("id", sender.id);
      break;
    }
    case "PERMISSIONS": {
      if (warned) break;
      await admin.from("outreach_senders").update({ status_reason: "PERMISSIONS" }).eq("id", sender.id);
      break;
    }
    case "CREATION_FAIL": {
      await admin.from("outreach_senders").update({ status: "error", status_reason: "CREATION_FAIL" }).eq("id", sender.id);
      break;
    }
    default:
      log({ fn: "account_status", warn: "unhandled", message });
  }
}

/** True when the sender's account id is still known to the configured DSN. */
async function accountExistsOnDsn(accountId: string): Promise<boolean> {
  try { await unipile.accounts.get(accountId); return true; }
  catch (e) {
    if (e instanceof UnipileError && (e.status === 404 || e.status === 401 || e.status === 403)) return false;
    throw e;
  }
}

/**
 * Hosted-auth link for an existing sender. Normally a `reconnect` link for its account; when the account is no
 * longer on the configured DSN (account deleted, or the platform moved to a new Unipile account) it falls back
 * to a `create` link bound to the same sender row via `name`, so the hosted-auth notify re-binds the new
 * account id and the sender keeps its chats, lead state and enrollments.
 */
/** Lifetime of a hosted sign-in link. It is created when the owner opens it (outreach-relogin, or "Sign in now"). */
export const RECONNECT_LINK_TTL_MIN = 60;
/** Lifetime of the re-login link that is emailed or copied. The emails and the sender page say "7 days". */
export const RELOGIN_URL_TTL_DAYS = 7;

/** Durable re-login link (hosted-auth docs, "Reconnecting an account"): it points at our own outreach-relogin endpoint, which
 *  creates a fresh hosted sign-in link when it is opened and redirects to it, so the email never carries an expired link. */
export async function reloginUrl(sender: Sender, method?: "credentials" | "browser"): Promise<string> {
  const { FUNCTIONS_BASE } = await import("./supabase.ts");
  const { reloginToken } = await import("./crypto.ts");
  const exp = Math.floor(Date.now() / 1000) + RELOGIN_URL_TTL_DAYS * 86400;
  const m = method ?? "";
  const q = new URLSearchParams({ s: sender.id, e: String(exp), t: await reloginToken(sender.id, exp, m) });
  if (m) q.set("m", m);
  return `${FUNCTIONS_BASE}outreach-relogin?${q}`;
}

/** `method` (LinkedIn, chosen by a manager) picks password vs signed-in-browser sign-in; omitted, the sender's own method is kept.
 *  The choice is recorded as a reconnect event so the hosted-auth callback can store it as the sender's auth_method. */
export async function reconnectLink(sender: Sender, method?: "credentials" | "browser"): Promise<string | null> {
  const { FUNCTIONS_BASE, WEB_ORIGIN } = await import("./supabase.ts");
  const browser = sender.provider === "LINKEDIN" && (method ? method === "browser" : sender.auth_method === "browser");
  if (method && sender.provider === "LINKEDIN") {
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { method: "hosted_link", connect_method: browser ? "browser" : "credentials" } });
  }
  const common = {
    // Unipile: keep hosted links short (minutes to a few hours); every link also dies at their daily restart.
    expiresOn: new Date(Date.now() + RECONNECT_LINK_TTL_MIN * 60_000).toISOString(),
    notify_url: `${FUNCTIONS_BASE}outreach-sender-notify?sid=${sender.id}`,
    name: sender.id,
    success_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=1`,
    failure_redirect_url: `${WEB_ORIGIN}/outreach/senders/${sender.id}?connected=0`,
    // Senders connected through the browser extension reconnect the same way (no password prompt).
    ...(browser ? hostedBrowserOptions() : {}),
  };
  // a fresh link restarts the sign-in window: the "not completed" flag comes back through the sweep if this one is abandoned too
  if (sender.status_reason === SIGN_IN_INCOMPLETE || (sender.status_reason === SIGN_IN_FAILED && sender.status === "connecting")) {
    await admin.from("outreach_senders").update({ status_reason: null }).eq("id", sender.id);
  }
  const stillThere = sender.unipile_account_id ? await accountExistsOnDsn(sender.unipile_account_id) : false;
  if (stillThere) {
    const r = await unipile.hosted.link({ type: "reconnect", reconnect_account: sender.unipile_account_id, ...common });
    return r.url;
  }
  // Billing v2: a sender with no live account (disconnected, or its account is gone) needs a free account for the new sign-in.
  // The link holds one for its lifetime; E_ACCOUNT_LIMIT / E_PLAN_SUSPENDED when the workspace has none (the caller shows it).
  await rpc("slot_reserve", { p_ws: sender.workspace_id, p_purpose: "reconnect", p_sender: sender.id, p_minutes: RECONNECT_LINK_TTL_MIN });
  const providers = sender.provider === "LINKEDIN" ? ["LINKEDIN"] : sender.provider === "INSTAGRAM" ? ["INSTAGRAM"] : sender.provider === "WHATSAPP" ? ["WHATSAPP"] : sender.provider === "GMAIL" ? ["GOOGLE"] : sender.provider === "OUTLOOK" ? ["OUTLOOK"] : ["MAIL"];
  const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).maybeSingle();
  const recruiter = !!(ws?.settings?.recruiter_enabled) && !!sender.has_recruiter;
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { method: "fresh_bind", reason: sender.unipile_account_id ? "account_not_on_dsn" : "no_account", previous_account_id: sender.unipile_account_id } });
  const r = await unipile.hosted.link({
    type: "create", providers, ...common,
    disabled_features: sender.provider === "LINKEDIN" && !recruiter ? ["linkedin_recruiter"] : undefined,
  });
  return r.url;
}

/** The connector asks for up to 24 h between (re)connecting a WhatsApp number and new outreach. The status trigger covers
 *  connecting / credentials / error → ok; a re-login while ok or paused changes no status, so set the quiet period here. */
async function reconnectQuietPeriod(sender: Sender): Promise<void> {
  if (!["ok", "paused"].includes(String(sender.status))) return;
  const { data: cap } = await admin.from("outreach_channel_capabilities").select("ledger").eq("provider", sender.provider).maybeSingle();
  const hrs = Number(cap?.ledger?.post_connect_quiet_hours ?? 0);
  if (!(hrs > 0)) return;
  const until = new Date(Date.now() + hrs * 3600_000).toISOString();
  await admin.from("outreach_senders").update({ outreach_allowed_from: until }).eq("id", sender.id);
  await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "quiet_period", data: { until, hours: hrs, from_status: sender.status, reason: "reconnected" } });
}

/** status_reason values written by the sign-in flow itself (not by the provider). The UI turns them into plain words. */
export const SIGN_IN_INCOMPLETE = "SIGN_IN_INCOMPLETE";   // the hosted page was opened (or never opened) and the link expired
export const SIGN_IN_FAILED = "SIGN_IN_FAILED";           // the hosted page reported CREATION_FAIL / a failed reconnect

/** Billing v2 reasons written by the sign-in flow: the plan had no free account when the sign-in finished; a disconnected sender was reconnected with another account. */
export const NO_FREE_ACCOUNT = "NO_FREE_ACCOUNT";
export const RECONNECT_WRONG_ACCOUNT = "RECONNECT_WRONG_ACCOUNT";

/** Does the freshly signed-in account belong to someone other than this sender's own identity? null = same account, or no identity on record to compare. */
async function reconnectIdentityMismatch(s: Sender, accountId: string): Promise<{ expected: string; got: string } | null> {
  const mail = s.provider === "GMAIL" || s.provider === "OUTLOOK" || s.provider === "IMAP";
  const expected = String((mail ? s.public_identifier ?? s.owner_email : s.provider_user_id) ?? "").trim().toLowerCase();
  if (!expected) return null;
  try {
    const me = await unipile.users.me(accountId);
    let got = "";
    if (s.provider === "LINKEDIN") got = String(me.provider_id ?? "");
    else if (s.provider === "INSTAGRAM") got = String(me.provider_id ?? me.id ?? "");
    else if (s.provider === "WHATSAPP") {
      // the id may be a phone id or a privacy id: compare the number when both sides have one
      const digits = phoneDigits(me.phone_number ?? me.phone ?? phoneFromAttendeeId(me.id ?? me.provider_id) ?? "");
      const mine = phoneDigits(String(s.public_identifier ?? ""));
      if (digits && mine) return digits === mine ? null : { expected: `+${mine}`, got: `+${digits}` };
      got = String(me.id ?? me.provider_id ?? "");
    } else got = String(me.email ?? "");
    got = got.trim().toLowerCase();
    if (!got) return null;                       // the connector told us nothing to compare: do not refuse a legitimate reconnect
    return got === expected ? null : { expected, got };
  } catch (e) { log({ fn: "hosted_notify", warn: "identity check failed", error: String(e) }); return null; }
}

/** The hosted page reported a failure. A failed *create* leaves an orphan account on the DSN (it is billed): remove it unless a
 *  sender already owns that id (a failed *reconnect* reports the existing account id, which must stay). */
async function handleHostedFailure(s: Sender, accountId: string | null, status: string): Promise<void> {
  const { data: owner } = accountId ? await admin.from("outreach_senders").select("id").eq("unipile_account_id", accountId).maybeSingle() : { data: null };
  const patch: Record<string, unknown> = { status_reason: SIGN_IN_FAILED };
  // a first sign-in that failed is an error the manager has to act on; a failed re-login keeps its current (credentials/error) status
  if (s.status === "connecting") { patch.status = "error"; patch.status_reason = SIGN_IN_FAILED; }
  await admin.from("outreach_senders").update(patch).eq("id", s.id);
  await rpc("slot_release_sender", { p_sender: s.id, p_reason: "failed" }).catch(() => null);   // the account the link was holding is free again
  await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "reconnect", data: { result: "failed", hosted_status: status, account_id: accountId, orphan_removed: !!accountId && !owner } });
  await audit(s.workspace_id, "sender.hosted_auth", "sender", s.id, { status, account_id: accountId, failed: true });
  if (accountId && !owner) {
    try { if (await accountExistsOnDsn(accountId)) await unipile.accounts.delete(accountId); }
    catch (e) { log({ fn: "hosted_notify", warn: "failed account cleanup", account_id: accountId, error: String(e) }); }
  }
}

/** The account id from the hosted page is already bound to another (live) sender row: this row is a duplicate connect of the
 *  same account (e.g. "Connect" clicked twice, or a re-login link opened for a row that was later merged). Fold it into the owner. */
async function foldIntoAccountOwner(s: Sender, accountId: string, status: string): Promise<boolean> {
  const { data: owner } = await admin.from("outreach_senders").select("*").eq("unipile_account_id", accountId).neq("id", s.id).maybeSingle();
  if (!owner) return false;
  const now = new Date().toISOString();
  if (owner.deleted_at) {
    // the owner is a tombstone: free the id so this row can take it
    await admin.from("outreach_senders").update({ unipile_account_id: null }).eq("id", owner.id);
    return false;
  }
  if (!s.deleted_at && !s.unipile_account_id) {
    await admin.from("outreach_senders").update({ status: "disabled", status_reason: `merged_into:${owner.id}`, deleted_at: now }).eq("id", s.id);
    await admin.from("outreach_sender_events").update({ sender_id: owner.id }).eq("sender_id", s.id);
  }
  const live = owner.status === "paused" || owner.status === "disabled" ? owner.status : "ok";
  if (status === "RECONNECTED" || status === "CREATION_SUCCESS") {
    await admin.from("outreach_senders").update({ status: live, status_reason: null, last_ok_at: now, reconnect_attempts: 0 }).eq("id", owner.id);
  }
  await admin.from("outreach_sender_events").insert({ sender_id: owner.id, kind: "reconnect", data: { method: "merged_duplicate", merged_sender_id: s.id, account_id: accountId, hosted_status: status } });
  await audit(owner.workspace_id, "sender.merged_duplicate", "sender", owner.id, { merged_sender_id: s.id, account_id: accountId, via: "hosted_notify" });
  log({ fn: "hosted_notify", merged: s.id, into: owner.id });
  return true;
}

/** Hosted-auth notify_url payload: {status, account_id, name}. Statuses seen from the hosted page: CREATION_SUCCESS, RECONNECTED and
 *  CREATION_FAIL (the docs list the first two; the third arrives in practice). Anything ending in FAIL is treated as a failure. */
export async function handleHostedNotify(payload: any): Promise<void> {
  const senderId = payload.name;
  const accountId = payload.account_id ?? null;
  if (!senderId) return;
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s) return;
  const status = String(payload.status ?? "").toUpperCase();
  if (/FAIL|ERROR/.test(status)) { await handleHostedFailure(s as Sender, accountId, status); return; }
  if (!accountId) return;
  if (s.unipile_account_id && s.unipile_account_id !== accountId && !s.deleted_at) {
    // this row is bound to another account: only a create-fallback reconnect (account gone from the DSN) may replace it
    log({ fn: "hosted_notify", info: "rebinding account", sender_id: s.id, from: s.unipile_account_id, to: accountId });
  }
  const patch: Record<string, unknown> = { unipile_account_id: accountId };
  if (status === "RECONNECTED") { patch.status = s.status === "paused" || s.status === "disabled" ? s.status : "ok"; patch.status_reason = null; patch.reconnect_attempts = 0; }
  // a first sign-in that completes after an earlier failure / expired link starts the normal connecting → ok path again
  if (status === "CREATION_SUCCESS") { patch.status_reason = null; if (s.status === "error" || s.status === "credentials" || s.status === "disconnected") patch.status = "connecting"; }
  // Reconnecting a disconnected sender must bring back the SAME account: its conversations and relations belong to it
  // (pricing-billing-PRD §12.1, #24e). Another account is refused and removed; it can be connected as a new sender instead.
  if (status === "CREATION_SUCCESS" && (s.status === "disconnected" || s.previous_unipile_account_id) && !s.unipile_account_id) {
    const mismatch = await reconnectIdentityMismatch(s as Sender, accountId);
    if (mismatch) {
      await dropConnectorAccount(accountId, s.workspace_id, "reconnect_wrong_account");
      await rpc("slot_release_sender", { p_sender: s.id, p_reason: "failed" }).catch(() => null);
      await admin.from("outreach_senders").update({ status_reason: RECONNECT_WRONG_ACCOUNT }).eq("id", s.id);
      await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "reconnect", data: { result: "wrong_account", expected: mismatch.expected, got: mismatch.got } });
      await audit(s.workspace_id, "sender.reconnect_wrong_account", "sender", s.id, { account_id: accountId });
      return;
    }
  }
  // A manager-chosen sign-in method on the latest reconnect link (last 25h) becomes the sender's auth_method.
  if ((status === "RECONNECTED" || status === "CREATION_SUCCESS") && s.provider === "LINKEDIN") {
    const { data: ev } = await admin.from("outreach_sender_events").select("data").eq("sender_id", senderId).eq("kind", "reconnect")
      .eq("data->>method", "hosted_link").gte("at", new Date(Date.now() - 25 * 3600 * 1000).toISOString()).order("at", { ascending: false }).limit(1).maybeSingle();
    const chosen = ev?.data?.connect_method;
    if (chosen === "browser") patch.auth_method = "browser";
    else if (chosen === "credentials" && s.auth_method !== "credentials") patch.auth_method = "credentials";
  }
  let { error } = await admin.from("outreach_senders").update(patch).eq("id", senderId);
  if (error && (error.code === "23505" || /unique|duplicate key/i.test(error.message))) {
    // account_id already bound to another sender row (duplicate connect): fold this row into the owner, or retry once the
    // owner turned out to be a tombstone whose id was just freed
    if (await foldIntoAccountOwner(s as Sender, accountId, status)) return;
    ({ error } = await admin.from("outreach_senders").update(patch).eq("id", senderId));
  }
  if (error && /E_ACCOUNT_LIMIT|E_PLAN_SUSPENDED/.test(error.message)) {
    // the sign-in finished after its reservation ran out and the account was taken, or the plan lapsed meanwhile: the new
    // connector account is removed and the owner is told to add an account and connect again (PRD #10)
    await dropConnectorAccount(accountId, s.workspace_id, "no_free_account");
    await admin.from("outreach_senders").update({ status_reason: NO_FREE_ACCOUNT, ...(s.status === "connecting" ? { status: "error" } : {}) }).eq("id", senderId);
    await admin.from("outreach_sender_events").insert({ sender_id: senderId, kind: "reconnect", data: { result: "no_free_account", account_id: accountId, error: error.message.slice(0, 200) } });
    await audit(s.workspace_id, "sender.no_free_account", "sender", senderId, { account_id: accountId });
    return;
  }
  if (error) { log({ fn: "hosted_notify", error: error.message, sender_id: senderId }); return; }
  await audit(s.workspace_id, "sender.hosted_auth", "sender", senderId, { status, account_id: accountId, ...(patch.auth_method ? { auth_method: patch.auth_method } : {}) });
  if (status === "RECONNECTED") await reconnectQuietPeriod(s);
  // A password reconnect may still have used a cookie inside the hosted page; the profile sync reads the real method back.
  if (status === "RECONNECTED" && patch.auth_method === "credentials") await syncOwnProfile({ ...s, ...patch } as Sender).catch(() => null);
  if (status === "CREATION_SUCCESS") {
    // same LinkedIn / mailbox already connected in this workspace → fold into that sender (it now owns accountId)
    const fresh = await absorbDuplicateSender(await syncOwnProfile({ ...s, ...patch, unipile_account_id: accountId }));
    await applyOnboardingGate(fresh);
    // if the webhook OK never arrives (platform webhook missing), poll account once
    try {
      const acc = await unipile.accounts.get(accountId);
      const st = String(acc?.sources?.[0]?.status ?? "").toUpperCase();
      if (st === "OK") await admin.from("outreach_senders").update({ status: fresh.status === "disabled" ? "disabled" : "ok", status_reason: null, last_ok_at: new Date().toISOString() }).eq("id", fresh.id);
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// messaging
// ---------------------------------------------------------------------------
async function matchLead(workspaceId: string, providerId: string | null, publicIdentifier: string | null, name: string | null, createIfMissing: boolean, profileUrl?: string | null): Promise<{ id: string; created: boolean } | null> {
  if (providerId) {
    const { data } = await admin.from("outreach_leads").select("id").eq("workspace_id", workspaceId).eq("provider_id", providerId).maybeSingle();
    if (data) return { id: data.id, created: false };
  }
  if (publicIdentifier) {
    const { data } = await admin.from("outreach_leads").select("id").eq("workspace_id", workspaceId).ilike("public_identifier", publicIdentifier).maybeSingle();
    if (data) {
      if (providerId) await admin.from("outreach_leads").update({ provider_id: providerId }).eq("id", data.id);
      return { id: data.id, created: false };
    }
  }
  if (!createIfMissing || (!providerId && !publicIdentifier)) return null;
  const parts = (name ?? "").trim().split(/\s+/);
  const row = await rpc<{ id: string; created: boolean }[]>("upsert_lead", {
    p_ws: workspaceId,
    p_lead: { public_identifier: publicIdentifier, provider_id: providerId, full_name: name, first_name: parts[0] ?? null, last_name: parts.slice(1).join(" ") || null, profile_url: profileUrl ?? null },
    p_source: "inbound",
  });
  const r = Array.isArray(row) ? row[0] : (row as any);
  return r ? { id: r.id, created: !!r.created } : null;
}

function pubIdFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Provider-aware sibling of matchLead for Instagram / WhatsApp: the lead that owns this identity (outreach_lead_identities
 * by provider + provider_id, then by identifier), else a new lead through outreach_upsert_lead with the identity recorded
 * as verified (source 'inbound': the person wrote to us from it) when the workspace allows.
 */
async function matchLeadByIdentity(workspaceId: string, provider: string, identifier: string | null, providerId: string | null, name: string | null, createIfMissing: boolean): Promise<{ id: string; created: boolean } | null> {
  if (providerId) {
    const { data } = await admin.from("outreach_lead_identities").select("id, lead_id, identifier, verified").eq("workspace_id", workspaceId).eq("provider", provider).eq("provider_id", providerId).limit(1).maybeSingle();
    if (data?.lead_id) {
      if (!data.verified) await admin.from("outreach_lead_identities").update({ verified: true }).eq("id", data.id);
      return { id: data.lead_id, created: false };
    }
  }
  if (identifier) {
    // identifier is citext: eq is case-insensitive (ilike would read "_" in a handle as a wildcard)
    const { data } = await admin.from("outreach_lead_identities").select("id, lead_id, provider_id, verified").eq("workspace_id", workspaceId).eq("provider", provider).eq("identifier", identifier).limit(1).maybeSingle();
    if (data?.lead_id) {
      const patch: Record<string, unknown> = {};
      if (providerId && !data.provider_id) patch.provider_id = providerId;
      if (!data.verified) patch.verified = true;   // an inbound message from this handle / number proves it
      if (Object.keys(patch).length) await admin.from("outreach_lead_identities").update(patch).eq("id", data.id);
      return { id: data.lead_id, created: false };
    }
  }
  if (!createIfMissing || !identifier) return null;
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  const row = await rpc<{ id: string; created: boolean }[]>("upsert_lead", {
    p_ws: workspaceId,
    p_lead: {
      full_name: name || null, first_name: parts[0] ?? null, last_name: parts.slice(1).join(" ") || null,
      profile_url: provider === "INSTAGRAM" ? `https://www.instagram.com/${identifier}` : null,
      identities: [{ provider, identifier, provider_id: providerId, verified: true, source: "inbound" }],
    },
    p_source: "inbound",
  });
  const r = Array.isArray(row) ? row[0] : (row as any);
  return r ? { id: r.id, created: !!r.created } : null;
}

/** The identity an inbound attendee carries: WhatsApp the phone ("+digits", also behind a "@lid" provider id); Instagram the user id + the handle in the profile URL. */
function attendeeIdentity(provider: string, attendee: any): { identifier: string | null; providerId: string | null } {
  const pid = attendee?.attendee_provider_id ?? attendee?.provider_id ?? attendee?.id ?? null;
  if (provider === "WHATSAPP") return { identifier: whatsappPhoneOf(attendee), providerId: pid ? String(pid) : null };
  if (provider === "INSTAGRAM") {
    const handle = instagramHandle(attendee?.attendee_profile_url ?? attendee?.profile_url ?? attendee?.public_profile_url ?? null) ?? instagramHandle(attendee?.attendee_public_identifier ?? attendee?.public_identifier ?? attendee?.username ?? null);
    return { identifier: handle, providerId: pid ? String(pid) : null };
  }
  return { identifier: null, providerId: pid ? String(pid) : null };
}

/**
 * The message a reply quotes (webhook `quoted` / `reply_to`, messages API `quoted`) in the stored shape. The author is
 * looked up among the chat's attendees by provider id; "You" when it is the sender account.
 */
export function quotedOf(q: any, attendees: any[], isUs: (id: unknown) => boolean): Row | null {
  if (!q || typeof q !== "object") return null;
  const mid = q.message_id ?? q.id ?? null;
  if (!mid && !q.provider_id && !q.text) return null;
  const sid = q.sender_id ?? q.sender_attendee_id ?? null;
  const who = sid ? attendees.find((a) => a && (a.attendee_provider_id === sid || a.provider_id === sid || a.attendee_id === sid || a.id === sid)) : null;
  const att = Array.isArray(q.attachments) ? q.attachments[0] : null;
  return {
    unipile_message_id: mid, provider_id: q.provider_id ?? null, text: q.text ? String(fixMojibake(String(q.text))).slice(0, 500) : null, sender_id: sid,
    sender_name: sid && isUs(sid) ? "You" : (visibleName(who?.attendee_name ?? who?.name) ?? (who ? whatsappPhoneOf(who) : null)),
    attachment_type: att ? (att.attachment_type ?? att.type ?? null) : null,
  };
}

/** Whether a connector chat object sits in Instagram's message-request folder (`folder` may be a string or an array). */
function isRequestFolder(chat: any): boolean {
  const f = chat?.folder ?? chat?.folders ?? chat?.category ?? null;
  if (!f) return false;
  try { return /request|pending/i.test(Array.isArray(f) ? f.map(String).join(" ") : typeof f === "string" ? f : JSON.stringify(f)); } catch { return false; }
}

/** message_reaction / message_read / message_delivered: bookkeeping on the recorded message, never a new lead or chat. */
async function handleMessageState(sender: Sender, payload: any, event: string): Promise<void> {
  const unipileMessageId = payload.message_id ?? null;
  const unipileChatId = payload.chat_id ?? null;
  const now = new Date().toISOString();
  if (event === "message_reaction") {
    if (!unipileMessageId) return;
    const emoji = payload.reaction ?? payload.emoji ?? payload.content ?? payload.value ?? null;
    const { data: msg } = await admin.from("outreach_messages").select("id, reactions, chat_id").eq("unipile_message_id", unipileMessageId).maybeSingle();
    if (!msg) return;
    // the reactor is `reaction_sender`; `sender` is the author of the message that was reacted to
    const reactor = payload.reaction_sender ?? payload.reactor ?? payload.sender ?? null;
    const ownId = payload.account_info?.user_id ?? sender.provider_user_id;
    const byId: string | null = reactor?.attendee_provider_id ?? payload.attendee_provider_id ?? null;
    const ownDigits = phoneDigits(sender.public_identifier);
    const mine = reactor?.is_self === true || reactor?.is_self === 1 || (!!byId && !!ownId && byId === ownId)
      || (sender.provider === "WHATSAPP" && !!ownDigits && phoneDigits(whatsappPhoneOf(reactor)) === ownDigits);
    const by = mine ? "You" : (visibleName(reactor?.attendee_name) ?? whatsappPhoneOf(reactor) ?? byId ?? "them");
    const reactions: Row[] = Array.isArray(msg.reactions) ? [...msg.reactions] : [];
    // an empty reaction is how a removal arrives
    const removed = !emoji || payload.is_removed === true || payload.removed === true || payload.action === "removed";
    const idx = reactions.findIndex((r) => (mine ? r.mine === true || r.by === "us" : (byId ? r.by_id === byId : false) || (!r.by_id && r.by === by)));
    const entry: Row = { emoji: String(emoji ?? ""), by, by_id: byId, mine, at: now };
    if (removed) { if (idx >= 0) reactions.splice(idx, 1); else return; }
    else if (idx >= 0) reactions[idx] = entry;
    else reactions.push(entry);
    await admin.from("outreach_messages").update({ reactions }).eq("id", msg.id);
    await emitEvent(sender.workspace_id, "message.reaction", { message_id: msg.id, chat_id: msg.chat_id, sender_id: sender.id, emoji: String(emoji), by, removed });
    return;
  }
  if (event === "message_read") {
    // a read receipt for one message, or for the whole chat (no message id): our outbound messages up to now are seen
    if (unipileMessageId) { await admin.from("outreach_messages").update({ read_at: now }).eq("unipile_message_id", unipileMessageId).is("read_at", null); return; }
    if (!unipileChatId) return;
    const { data: chat } = await admin.from("outreach_chats").select("id").eq("sender_id", sender.id).eq("unipile_chat_id", unipileChatId).maybeSingle();
    if (chat) await admin.from("outreach_messages").update({ read_at: now }).eq("chat_id", chat.id).eq("direction", "out").is("read_at", null);
    return;
  }
  // message_delivered: delivered_at on the message (two grey ticks), and noted on the action's `response` when there is one
  if (event === "message_delivered" && unipileMessageId) {
    const { data: msg } = await admin.from("outreach_messages").select("id, action_id, delivered_at").eq("unipile_message_id", unipileMessageId).maybeSingle();
    if (msg && !msg.delivered_at) await admin.from("outreach_messages").update({ delivered_at: now }).eq("id", msg.id);
    if (msg?.action_id) {
      const { data: a } = await admin.from("outreach_actions").select("response").eq("id", msg.action_id).maybeSingle();
      if (a && !(a.response as any)?.delivered_at) await admin.from("outreach_actions").update({ response: { ...((a.response as Row) ?? {}), delivered_at: now } }).eq("id", msg.action_id);
    }
  }
}

export async function handleMessaging(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) { log({ fn: "messaging", warn: "unknown account", account: payload.account_id }); return; }
  const event = payload.event ?? "message_received";
  const unipileChatId = payload.chat_id;
  const unipileMessageId = payload.message_id;
  if (!unipileChatId) return;
  const unsupportedText = isUnsupportedPlaceholder(payload.message);
  if (unsupportedText) payload.message = null;

  if (event === "message_edited" || event === "message_deleted") {
    if (unipileMessageId) {
      const { data: changed } = await admin.from("outreach_messages").update(event === "message_deleted" ? { deleted_at: new Date().toISOString() } : { text: fixMojibake(payload.message) ?? undefined, edited_at: new Date().toISOString() })
        .eq("unipile_message_id", unipileMessageId).select("id, direction").maybeSingle();
      // AI replies §7.3: a message the AI is answering was deleted (cancel) or edited (redraft)
      if (changed?.direction === "in") {
        await rpc("ai_reply_on_message_change", { p_message: changed.id, p_kind: event === "message_deleted" ? "deleted" : "edited" })
          .catch((e) => log({ fn: "messaging", warn: `ai_reply_on_message_change: ${String((e as any)?.message ?? e)}` }));
      }
    }
    return;
  }
  if (event === "message_reaction" || event === "message_read" || event === "message_delivered") { await handleMessageState(sender, payload, event); return; }
  if (event !== "message_received") return;

  // the channel of this chat: the payload's account_type when present, else the sender's provider
  const provider: string = String(payload.account_type ?? sender.provider ?? "LINKEDIN").toUpperCase();
  const channel = CHANNEL(provider);
  const ownId = payload.account_info?.user_id ?? sender.provider_user_id;
  const ownDigits = provider === "WHATSAPP" ? phoneDigits(sender.public_identifier) : "";
  const sameAsUs = (id: unknown): boolean => {
    if (!id) return false;
    if (ownId && String(id) === String(ownId)) return true;
    if (ownDigits && phoneDigits(phoneFromAttendeeId(String(id))) === ownDigits) return true;
    return false;
  };
  // WhatsApp ids are "@lid" privacy ids now: our own attendee is recognised by its public identifier (the phone) too
  const isSelf = (a: any): boolean => sameAsUs(a?.attendee_provider_id) || sameAsUs(a?.attendee_public_identifier);
  const isOut = payload.is_sender === 1 || payload.is_sender === true || payload.sender?.is_self === true || isSelf(payload.sender);
  // a WhatsApp group is named after the group and never matches / creates a lead: its senders are group members, not prospects
  const group = provider === "WHATSAPP" && isWhatsappGroup(payload);
  const attendee = group ? null : isOut ? (payload.attendees ?? []).find((a: any) => !isSelf(a)) ?? payload.attendees?.[0] : payload.sender;
  const attendeeProviderId = group ? (payload.provider_chat_id ?? null) : attendee?.attendee_provider_id ?? null;
  const attendeePub = group ? null : channel ? attendeeIdentity(provider, attendee).identifier : pubIdFromUrl(attendee?.attendee_profile_url);
  const attendeeName = group ? visibleName(payload.subject) : visibleName(attendee?.attendee_name);
  // AI replies G2: only 1:1 conversations are answered. LinkedIn group threads carry more than two attendees.
  const multiParty = group || payload.is_group === true || payload.is_group === 1 || (Array.isArray(payload.attendees) && payload.attendees.length > 2);
  const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).single();
  const createLeads = (ws?.settings?.create_leads_from_inbound ?? true) !== false;

  // chat upsert
  let { data: chat } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("unipile_chat_id", unipileChatId).maybeSingle();
  let lead = chat?.lead_id
    ? { id: chat.lead_id, created: false }
    : group
      ? null
      : channel
        ? await matchLeadByIdentity(sender.workspace_id, provider, attendeePub, attendeeProviderId, attendeeName, createLeads && !isOut)
        : await matchLead(sender.workspace_id, attendeeProviderId, attendeePub, attendeeName, createLeads, attendee?.attendee_profile_url);
  if (!chat) {
    // Instagram: a new chat that sits in the Requests folder (theirs to us, or ours to them) is a message request until answered
    let isRequest = false;
    if (provider === "INSTAGRAM") {
      isRequest = isRequestFolder(payload) || isRequestFolder(payload.chat);
      if (!isRequest) { try { isRequest = isRequestFolder(await unipile.chats.get(unipileChatId)); } catch (e) { log({ fn: "messaging", warn: `chat folder: ${String((e as any)?.message ?? e)}` }); } }
    }
    const row: Row = {
      workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: unipileChatId,
      provider: sender.provider, attendee_provider_id: attendeeProviderId, attendee_public_identifier: attendeePub, attendee_name: attendeeName,
      attendee_picture_url: channel ? null : attendee?.attendee_picture_url ?? null,   // channel pictures are stored by avatars.ts
    };
    if (group) row.subject = payload.subject ?? null;
    if (multiParty) row.is_group = true;
    const li = provider === "LINKEDIN" ? linkedinChatMeta(payload) : null;
    if (li) row.custom_attributes = { linkedin: li };
    if (isRequest) row.is_request = true;
    let { data: c, error: cErr } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    if (cErr && isRequest) { delete row.is_request; ({ data: c } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("*").single()); }
    chat = c;
  } else {
    // a chat first seen by the /chats sync often has no name / phone: the webhook's attendee fills them in
    const patch: Row = {};
    if (!chat.lead_id && lead) patch.lead_id = lead.id;
    if (!visibleName(chat.attendee_name) && attendeeName) patch.attendee_name = attendeeName;
    if (!chat.attendee_public_identifier && attendeePub) patch.attendee_public_identifier = attendeePub;
    if (group && payload.subject && !chat.subject) patch.subject = payload.subject;
    if (multiParty && !chat.is_group) patch.is_group = true;
    if (Object.keys(patch).length) {
      await admin.from("outreach_chats").update(patch).eq("id", chat.id);
      Object.assign(chat, patch);
    }
  }
  if (!chat) return;
  if (chat.attendee_picture_url == null) {
    try { await fillChatPicture({ ...chat, lead_id: chat.lead_id ?? lead?.id ?? null }); } catch (e) { log({ fn: "messaging", avatar_warn: String(e) }); }
  }
  // system events (calls, group changes) are shown in the thread but never count as a reply
  const isEvent = payload.is_event === 1 || payload.is_event === true;

  // first message in chat? (before insert)
  const { count: existing } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("chat_id", chat.id);
  const sentAt = payload.timestamp ? new Date(payload.timestamp).toISOString() : new Date().toISOString();
  // voice notes (type audio / mimetype audio/*) are flagged so the inbox plays them and the transcriber picks them up
  const attachments = (payload.attachments ?? []).map((a: any) => storedAttachment(a, unipileMessageId));
  const hasVoiceNote = attachments.some((a: Row) => a.voice_note === true);

  // dedupe by unipile message id (also catches our own sends already recorded by send-reply / tick)
  if (unipileMessageId) {
    const { data: dup } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", unipileMessageId).maybeSingle();
    if (dup) { await admin.from("outreach_messages").update({ attachments }).eq("id", dup.id); return; }
  }
  const isInviteNote = isOut && (existing ?? 0) === 0;
  const insertRow: Row = {
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: unipileMessageId ?? null, direction: isOut ? "out" : "in",
    text: fixMojibake(payload.message ?? null), attachments, sent_at: sentAt, is_invite_note: false,
    quoted: quotedOf(payload.quoted ?? payload.reply_to, [...(payload.attendees ?? []), payload.sender], sameAsUs),
    is_forwarded: payload.is_forwarded === true || payload.is_forwarded === 1,
    event_type: isEvent ? (Number.isFinite(Number(payload.event_type)) ? Number(payload.event_type) : 0) : null,
  };
  // a group thread's `subject` is its name, not a message subject
  const meta = messageMeta(payload, provider === "LINKEDIN" && !multiParty);
  if (Object.keys(meta).length) insertRow.content_attributes = meta;
  const unsupported = unsupportedText && attachments.length === 0;
  if (unsupported) insertRow.unsupported = true;
  if (!isOut && payload.sender) {
    insertRow.sender_name = visibleName(payload.sender.attendee_name);
    insertRow.sender_identifier = channel ? attendeeIdentity(provider, payload.sender).identifier : null;
  }
  if (hasVoiceNote) insertRow.transcript_status = "pending";
  let { data: msg, error: mErr } = await admin.from("outreach_messages").insert(insertRow).select("id").single();
  if (mErr && hasVoiceNote && !String(mErr.message).includes("duplicate")) { delete insertRow.transcript_status; ({ data: msg, error: mErr } = await admin.from("outreach_messages").insert(insertRow).select("id").single()); }
  if (mErr || !msg) { if (mErr && !String(mErr.message).includes("duplicate")) log({ fn: "messaging", error: mErr.message }); return; }
  if (hasVoiceNote) {
    const { error: qErr } = await admin.from("outreach_transcribe_queue").insert({ message_id: msg.id });
    if (qErr && !String(qErr.message).includes("duplicate")) log({ fn: "messaging", warn: `transcribe queue: ${qErr.message}` });
  }
  // Instagram request bookkeeping: their reply to a chat we started accepts it; our answer to their request accepts it (reply.ts / execute.ts do the latter)
  if (provider === "INSTAGRAM" && chat.is_request && !isOut && (existing ?? 0) > 0) {
    const { data: ours } = await admin.from("outreach_messages").select("id").eq("chat_id", chat.id).eq("direction", "out").limit(1).maybeSingle();
    if (ours) await admin.from("outreach_chats").update({ is_request: false }).eq("id", chat.id);
  }

  if (lead && !isEvent) {
    await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
    if (!isOut) {
      await admin.from("outreach_lead_sender_state").update({ replied: true, last_inbound_at: sentAt, unipile_chat_id: unipileChatId, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
      // a voice note without text is classified once its transcript exists (transcribe.ts re-queues it)
      if (!unsupported && (!hasVoiceNote || String(payload.message ?? "").trim())) await admin.from("outreach_ai_classify_queue").insert({ message_id: msg.id });
      if (provider === "LINKEDIN") {
        // their FIRST message in this conversation: queue a profile read for a lead missing company / location / work email
        // (outreach_enrich_on_reply decides; workspace setting enrich_on_reply, default on). Later messages in a live thread
        // bring no new profile data, so they never spend another profile view.
        const { count: earlierIn } = await admin.from("outreach_messages").select("id", { count: "exact", head: true }).eq("chat_id", chat.id).eq("direction", "in").neq("id", msg.id);
        if ((earlierIn ?? 0) === 0) {
          const r = await rpc<string>("enrich_on_reply", { p_lead: lead.id, p_sender: sender.id }).catch((e) => { log({ fn: "messaging", warn: `enrich_on_reply: ${String((e as any)?.message ?? e)}` }); return null; });
          if (r === "queued") log({ fn: "messaging", lead_id: lead.id, sender_id: sender.id, enrich_on_reply: r });
        }
      }
      if (channel) {
        const text = String(payload.message ?? "");
        if (isStopIntent(text)) {
          // stop request: consent revoked (reason stop_request), suppression row, live enrollments on that channel exited
          await rpc("consent_revoke_stop", { p_lead: lead.id, p_channel: provider, p_message_id: msg.id }).catch((e) => log({ fn: "messaging", warn: `consent_revoke_stop: ${String((e as any)?.message ?? e)}` }));
          await emitEvent(sender.workspace_id, "consent.stop_request", { lead_id: lead.id, sender_id: sender.id, channel: provider, message_id: msg.id });
        } else if (provider === "WHATSAPP") {
          // they wrote to us on WhatsApp: consent basis 'inbound' (PRD §6.4) unless an active basis already exists
          try {
            const has = await rpc<boolean>("lead_has_consent", { p_lead: lead.id, p_channel: "WHATSAPP" });
            if (!has) {
              await rpc("consent_grant_system", { p_lead: lead.id, p_channel: "WHATSAPP", p_basis: "inbound", p_evidence: { chat_id: chat.id, message_id: msg.id, unipile_chat_id: unipileChatId, unipile_message_id: unipileMessageId ?? null } });
              await emitEvent(sender.workspace_id, "consent.granted", { lead_id: lead.id, channel: "WHATSAPP", basis: "inbound", message_id: msg.id });
            }
          } catch (e) { log({ fn: "messaging", warn: `consent capture: ${String((e as any)?.message ?? e)}` }); }
        }
      }
    } else {
      await admin.from("outreach_lead_sender_state").update({ last_outbound_at: sentAt, unipile_chat_id: unipileChatId, updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
      // acceptance via note path: our first message in a new chat while an invite is pending → accepted
      if (isInviteNote) {
        const { data: lss } = await admin.from("outreach_lead_sender_state").select("relation, invite_had_note").eq("lead_id", lead.id).eq("sender_id", sender.id).maybeSingle();
        if (lss?.relation === "pending_out") {
          await admin.from("outreach_messages").update({ is_invite_note: true }).eq("id", msg.id);
          await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: sentAt, invite_detected_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("lead_id", lead.id).eq("sender_id", sender.id);
        }
      }
    }
  }
  // AI replies (§5, §10.4): an inbound message opens / extends the chat's AI run; an outbound message no send of ours
  // recorded first was typed on the sender's phone or LinkedIn web → human takeover. Never blocks inbound processing.
  if (!isEvent) {
    const call = () => isOut ? rpc<Record<string, unknown>>("ai_reply_on_outbound_external", { p_message: msg!.id }) : rpc<Record<string, unknown>>("ai_reply_enqueue", { p_chat: chat!.id, p_message: msg!.id });
    try {
      const r = await call();
      // v2 §6: a handed-off prospect came back after a gap — its owner is told (the task was reopened in SQL)
      if (!isOut && r && typeof r === "object" && (r as any).returned === true) {
        notifyReturned(chat!.id, (r as any).gap_days != null ? Number((r as any).gap_days) : null).catch((e) => log({ fn: "messaging", warn: `notifyReturned: ${String((e as any)?.message ?? e)}` }));
      }
    }
    catch (e) {
      // one retry for a transient lock conflict; the message itself is already stored either way
      if (/deadlock|could not serialize|lock/i.test(String((e as any)?.message ?? e))) {
        try { await call(); } catch (e2) { log({ fn: "messaging", warn: `ai_reply (retry): ${String((e2 as any)?.message ?? e2)}`, chat_id: chat.id }); }
      } else log({ fn: "messaging", warn: `ai_reply: ${String((e as any)?.message ?? e)}`, chat_id: chat.id });
    }
  }
  await emitEvent(sender.workspace_id, isOut ? "message.sent" : "message.received", { id: msg.id, chat_id: chat.id, lead_id: lead?.id ?? null, sender_id: sender.id, text: (payload.message ?? "").slice(0, 500), direction: isOut ? "out" : "in" });
}

// ---------------------------------------------------------------------------
// users (new_relation)
// ---------------------------------------------------------------------------
export async function handleNewRelation(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const lead = await matchLead(sender.workspace_id, payload.user_provider_id ?? null, payload.user_public_identifier ?? null, payload.user_full_name ?? null, false, payload.user_profile_url);
  if (!lead) return;
  const now = new Date().toISOString();
  await admin.from("outreach_lead_sender_state").upsert({ lead_id: lead.id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
  const { data: lss } = await admin.from("outreach_lead_sender_state").select("relation, invite_accepted_at").eq("lead_id", lead.id).eq("sender_id", sender.id).single();
  if (lss?.relation !== "first") {
    await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: lss?.invite_accepted_at ?? now, invite_detected_at: now, updated_at: now }).eq("lead_id", lead.id).eq("sender_id", sender.id);
  }
  if (payload.user_picture_url) await admin.from("outreach_leads").update({ picture_url: payload.user_picture_url, provider_id: payload.user_provider_id ?? undefined }).eq("id", lead.id).is("picture_url", null);
}

// ---------------------------------------------------------------------------
// mail (new_email) + tracking
// ---------------------------------------------------------------------------
export async function handleMail(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const event = payload.event ?? "mail_received";
  if (event === "mail_moved") return;
  // web chat continuity (web-chat-PRD.md §9): our own digests leaving the reply mailbox, and visitors answering them by
  // email, belong to the web-chat conversation, never to a new email thread
  if (await webchatMailHook(payload)) return;
  const isOut = event === "mail_sent";
  const from = payload.from_attendee?.identifier ? String(payload.from_attendee.identifier).toLowerCase() : null;
  const to = (payload.to_attendees ?? []).map((a: any) => String(a.identifier ?? "").toLowerCase()).filter(Boolean);
  const counterpart = isOut ? to[0] : from;
  const counterpartName = isOut ? payload.to_attendees?.[0]?.display_name : payload.from_attendee?.display_name;
  if (!counterpart) return;
  // lead by email
  let leadId: string | null = null;
  const { data: l } = await admin.from("outreach_leads").select("id").eq("workspace_id", sender.workspace_id).or(`email_work.eq.${counterpart},email_personal.eq.${counterpart}`).maybeSingle();
  if (l) leadId = l.id;
  else {
    const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", sender.workspace_id).single();
    if ((ws?.settings?.create_leads_from_inbound ?? true) !== false && !isOut) {
      const r = await rpc<any>("upsert_lead", { p_ws: sender.workspace_id, p_lead: { email_work: counterpart, full_name: counterpartName ?? null }, p_source: "inbound_email" });
      leadId = (Array.isArray(r) ? r[0] : r)?.id ?? null;
    }
  }
  const threadId = payload.thread_id ?? payload.in_reply_to?.id ?? payload.email_id;
  let { data: chat } = await admin.from("outreach_chats").select("*").eq("sender_id", sender.id).eq("unipile_chat_id", threadId).maybeSingle();
  if (!chat) {
    const { data: c } = await admin.from("outreach_chats").upsert({
      workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: leadId, unipile_chat_id: threadId, provider: sender.provider,
      attendee_provider_id: counterpart, attendee_name: counterpartName ?? counterpart, subject: payload.subject ?? null,
    }, { onConflict: "sender_id,unipile_chat_id" }).select("*").single();
    chat = c;
  }
  if (!chat) return;
  const { data: dup } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", payload.email_id).maybeSingle();
  if (dup) return;
  const sentAt = payload.date ? new Date(payload.date).toISOString() : new Date().toISOString();
  const bounced = !isOut && /mailer-daemon|postmaster|delivery (status )?notification|undeliverable|delivery failure/i.test(`${from} ${payload.subject ?? ""}`);
  const { data: msg } = await admin.from("outreach_messages").insert({
    workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: payload.email_id, direction: isOut ? "out" : "in",
    text: payload.body_plain || (payload.body ? String(payload.body).replace(/<[^>]+>/g, " ").trim() : null), html: payload.body ?? null,
    attachments: (payload.attachments ?? []).map((a: any) => ({ id: a.id, name: a.name, size: a.size, type: a.mime ?? a.type, unipile_message_id: payload.email_id, email: true })),
    sent_at: sentAt, content_attributes: { email: emailMeta(payload) },
  }).select("id").single();
  if (leadId) {
    await admin.from("outreach_lead_sender_state").upsert({ lead_id: leadId, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
    if (bounced) {
      await admin.from("outreach_lead_sender_state").update({ email_bounced: true, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
      await emitEvent(sender.workspace_id, "email.bounced", { lead_id: leadId, sender_id: sender.id });
    } else if (!isOut) {
      await admin.from("outreach_lead_sender_state").update({ replied: true, last_inbound_at: sentAt, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
      if (msg) await admin.from("outreach_ai_classify_queue").insert({ message_id: msg.id });
    } else {
      await admin.from("outreach_lead_sender_state").update({ last_outbound_at: sentAt, updated_at: new Date().toISOString() }).eq("lead_id", leadId).eq("sender_id", sender.id);
    }
  }
  await emitEvent(sender.workspace_id, isOut ? "email.sent" : "message.received", { id: msg?.id, chat_id: chat.id, lead_id: leadId, sender_id: sender.id, subject: payload.subject ?? null });
}

export async function handleMailTracking(payload: any): Promise<void> {
  const sender = await senderByAccount(payload.account_id);
  if (!sender) return;
  const isClick = payload.event === "mail_link_clicked";
  const { data: msg } = await admin.from("outreach_messages").select("id, opens, clicks, chat_id").eq("unipile_message_id", payload.email_id).maybeSingle();
  if (msg) {
    await admin.from("outreach_messages").update(isClick ? { clicks: (msg.clicks ?? 0) + 1 } : { opens: (msg.opens ?? 0) + 1 }).eq("id", msg.id);
    const { data: chat } = await admin.from("outreach_chats").select("lead_id").eq("id", msg.chat_id).maybeSingle();
    await emitEvent(sender.workspace_id, isClick ? "email.clicked" : "email.opened", { message_id: msg.id, lead_id: chat?.lead_id ?? null, url: payload.url ?? null, sender_id: sender.id });
  }
}

// ---------------------------------------------------------------------------
// Backfill chats/messages after SYNC_SUCCESS (paged, bounded)
// ---------------------------------------------------------------------------
export async function backfillChats(sender: Sender, maxPages = 3): Promise<number> {
  const channel = CHANNEL(sender.provider);
  if (!sender.unipile_account_id || !unipileConfigured() || (sender.provider !== "LINKEDIN" && !channel)) return 0;
  let cursor: string | undefined;
  let pages = 0, inserted = 0;
  const ownId = sender.provider_user_id;
  do {
    const res = await unipile.chats.list(sender.unipile_account_id, { cursor, limit: 50 });
    for (const c of res.items ?? []) {
      const attendeeId = c.attendee_provider_id ?? null;
      if (!attendeeId) continue;
      if (sender.provider === "WHATSAPP" && isWhatsappGroup(c)) continue;   // WhatsApp groups are not conversations with a lead
      // a 1:1 WhatsApp chat's provider_id is the other side's "<digits>@s.whatsapp.net" when the contact is not behind a "@lid"
      const ident = channel ? attendeeIdentity(sender.provider, { attendee_provider_id: attendeeId, public_identifier: sender.provider === "WHATSAPP" ? c.provider_id : null, attendee_name: c.name ?? null }) : null;
      const name = visibleName(c.name);
      const lead = channel
        ? await matchLeadByIdentity(sender.workspace_id, sender.provider, ident!.identifier, ident!.providerId, name, false)
        : await matchLead(sender.workspace_id, attendeeId, null, name, false);
      const row: Row = {
        workspace_id: sender.workspace_id, client_id: sender.client_id, sender_id: sender.id, lead_id: lead?.id ?? null, unipile_chat_id: c.id, provider: sender.provider,
        attendee_provider_id: attendeeId, attendee_public_identifier: ident?.identifier ?? null, attendee_name: name, subject: c.subject ?? null, unread_count: c.unread_count ?? 0, unread: (c.unread_count ?? 0) > 0,
      };
      // a re-sync never blanks what a webhook / name pass already filled in (an omitted column is only null on insert)
      for (const k of ["lead_id", "attendee_public_identifier", "attendee_name", "subject"]) if (row[k] == null) delete row[k];
      if (sender.provider === "INSTAGRAM" && isRequestFolder(c)) row.is_request = true;
      const li = sender.provider === "LINKEDIN" ? linkedinChatMeta(c) : null;
      if (li) row.custom_attributes = { linkedin: li };
      let { data: chat, error: cErr } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("id, lead_id").single();
      if (cErr && row.is_request) { delete row.is_request; ({ data: chat } = await admin.from("outreach_chats").upsert(row, { onConflict: "sender_id,unipile_chat_id" }).select("id, lead_id").single()); }
      if (!chat) continue;
      try {
        const ms = await unipile.chats.messages(c.id, { limit: 30 });
        for (const m of (ms.items ?? []).reverse()) {
          const isOut = m.is_sender === 1 || m.is_sender === true || (ownId && m.sender_id === ownId);
          if (m.hidden === 1 || m.hidden === true) continue;   // reaction notices and other hidden rows are not messages
          const atts = (m.attachments ?? []).map((a: any) => storedAttachment(a, m.id));
          const sentAt = m.timestamp ? new Date(m.timestamp).toISOString() : new Date().toISOString();
          const reactions = (Array.isArray(m.reactions) ? m.reactions : []).filter((r: any) => r?.value).map((r: any) => {
            const mine = r.is_sender === 1 || r.is_sender === true;
            return { emoji: String(r.value), by: mine ? "You" : "them", by_id: r.sender_id ?? null, mine, at: sentAt };
          });
          const { data: ins, error } = await admin.from("outreach_messages").insert({
            workspace_id: sender.workspace_id, chat_id: chat.id, unipile_message_id: m.id, direction: isOut ? "out" : "in", text: fixMojibake(m.text ?? null),
            attachments: atts, sent_at: sentAt,
            quoted: quotedOf(m.quoted ?? m.reply_to, [], (id) => !!ownId && id === ownId),
            is_forwarded: m.is_forwarded === 1 || m.is_forwarded === true,
            event_type: m.is_event === 1 || m.is_event === true ? (Number(m.event_type) || 0) : null,
            reactions, content_attributes: messageMeta(m, sender.provider === "LINKEDIN" && !(Array.isArray(c.attendees) && c.attendees.length > 2)),
            ...(isOut && (m.seen === 1 || m.seen === true) ? { read_at: sentAt } : {}),
            ...(isOut && (m.delivered === 1 || m.delivered === true) ? { delivered_at: sentAt } : {}),
            ...(m.edited === 1 || m.edited === true ? { edited_at: sentAt } : {}),
            ...(m.deleted === 1 || m.deleted === true ? { deleted_at: sentAt } : {}),
          }).select("id").maybeSingle();
          if (!error) {
            inserted++;
            // backfilled voice notes are transcribed too (bounded by the queue's own pacing)
            if (ins?.id && atts.some((a: Row) => a.voice_note)) await admin.from("outreach_transcribe_queue").insert({ message_id: ins.id }).then(() => null, () => null);
          }
        }
        if (chat.lead_id) {
          const last = ms.items?.[0];
          if (last) {
            const lastIn = (ms.items ?? []).find((m: any) => !(m.is_sender === 1 || m.is_sender === true || (ownId && m.sender_id === ownId)) && !(m.is_event === 1 || m.is_event === true));
            await admin.from("outreach_lead_sender_state").upsert({ lead_id: chat.lead_id, sender_id: sender.id }, { onConflict: "lead_id,sender_id", ignoreDuplicates: true });
            // LinkedIn: a chat means a first-degree connection. Instagram / WhatsApp have no connection graph: only the chat id is recorded.
            await admin.from("outreach_lead_sender_state").update({ unipile_chat_id: c.id, ...(channel ? {} : { relation: "first" }), ...(lastIn ? { last_inbound_at: new Date(lastIn.timestamp).toISOString() } : {}) }).eq("lead_id", chat.lead_id).eq("sender_id", sender.id);
          }
        }
      } catch (e) { log({ fn: "backfill", warn: String(e) }); }
    }
    cursor = res.cursor ?? undefined;
    pages++;
  } while (cursor && pages < maxPages);
  try { await resolveChatNames(sender, 40); } catch (e) { log({ fn: "backfill", warn: `resolveChatNames: ${e}` }); }
  return inserted;
}

/**
 * LinkedIn 1:1 chats come back from /chats without a name. Fill attendee_name / public identifier / picture from
 * the chat's attendee list (a Unipile-side read, no LinkedIn action), newest chats first, bounded per call.
 */
export async function resolveChatNames(sender: Sender, max = 40): Promise<{ checked: number; named: number; linked: number }> {
  const channel = CHANNEL(sender.provider);
  if (!sender.unipile_account_id || !unipileConfigured() || (sender.provider !== "LINKEDIN" && !channel)) return { checked: 0, named: 0, linked: 0 };
  // WhatsApp: a named chat can still miss its phone (a "@lid" contact), so those are revisited too; groups are left alone
  let q = admin.from("outreach_chats").select("id, unipile_chat_id, attendee_provider_id, attendee_name, attendee_public_identifier, lead_id").eq("sender_id", sender.id).not("unipile_chat_id", "is", null);
  q = sender.provider === "WHATSAPP" ? q.or("attendee_name.is.null,attendee_public_identifier.is.null").not("attendee_provider_id", "like", "%@g.us") : q.is("attendee_name", null);
  const { data: chats } = await q.order("last_message_at", { ascending: false, nullsFirst: false }).limit(max);
  let named = 0, linked = 0;
  for (const c of chats ?? []) {
    try {
      const res = await unipile.chats.attendees(c.unipile_chat_id);
      const items = res.items ?? [];
      const a = items.find((x: any) => x.provider_id === c.attendee_provider_id) ?? items.find((x: any) => !(x.is_self === 1 || x.is_self === true) && x.provider_id !== sender.provider_user_id);
      const name = visibleName(a?.name ?? a?.display_name ?? null);
      const ident = channel ? attendeeIdentity(sender.provider, { ...a, attendee_provider_id: a?.provider_id ?? c.attendee_provider_id }) : null;
      const pub = channel ? ident!.identifier : (pubIdFromUrl(a?.profile_url ?? a?.public_profile_url ?? null) ?? a?.public_identifier ?? null);
      if (!name && !pub) continue;
      const patch: Record<string, unknown> = {};
      if (name && !visibleName(c.attendee_name)) patch.attendee_name = name;
      if (pub && !c.attendee_public_identifier) patch.attendee_public_identifier = pub;
      if (!Object.keys(patch).length) continue;
      // WhatsApp / Instagram picture links expire: avatars.ts stores those pictures instead
      if (a?.picture_url && !channel) patch.attendee_picture_url = a.picture_url;
      if (!c.lead_id) {
        const lead = channel
          ? await matchLeadByIdentity(sender.workspace_id, sender.provider, pub, ident!.providerId ?? c.attendee_provider_id, name, false)
          : await matchLead(sender.workspace_id, c.attendee_provider_id, pub, name, false, a?.profile_url ?? undefined);
        if (lead?.id) { patch.lead_id = lead.id; linked++; }
      }
      const { error } = await admin.from("outreach_chats").update(patch).eq("id", c.id);
      if (!error) named++;
    } catch (e) { log({ fn: "resolveChatNames", chat: c.id, warn: String(e) }); }
  }
  return { checked: chats?.length ?? 0, named, linked };
}

export const _internal = { matchLead, matchLeadByIdentity, pubIdFromUrl, isStopIntent, attendeeIdentity, randInt };
