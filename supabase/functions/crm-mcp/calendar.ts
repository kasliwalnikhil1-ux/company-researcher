// crm-mcp/calendar.ts — Google Calendar for the CRM team. One service used by BOTH the /crm/calendar screen (HTTP
// routes, calendar_routes.ts) and the connector tools (tools_calendar.ts), so the app and Claude/ChatGPT behave the same.
//
// Sign-in: Desk's own Google OAuth client (desk-by-kaptured-ai, a Desktop client) by default — CRM_GOOGLE_CLIENT_ID /
// CRM_GOOGLE_CLIENT_SECRET edge secrets — or a Web client (CRM_GOOGLE_CLIENT_KIND=web). See "Sign-in" below for the two
// return paths. finishConnect() exchanges the code (PKCE), asks Google who signed in, pulls the calendar list and stores
// the refresh token AES-256-GCM encrypted (key = CRM_TOKEN_KEY) in crm_calendar_accounts. Tokens never reach a client:
// every Google call happens here, with a per-instance access-token cache.
//
// Accounts: a member may connect several Google accounts (work, personal, …) with one default; each account has a
// calendar list. The whole active team sees every connected account's events; only the owner's accounts can write.
// Meetings: a CRM meeting can be linked to one Google event (crm_meeting_calendar_events). Booking a CRM meeting creates
// the event (Meet link + invites); an event booked on the Calendar screen can be attached to a company/deal (creates the
// CRM meeting); moving/cancelling a linked event keeps the CRM meeting in step and the reverse (syncMeetingToEvent).
import { admin, type Ctx, McpError, SUPABASE_URL, WEB_ORIGIN, log, compact } from "./ctx.ts";
import { BRANDS } from "../_shared/brands.ts";
import { inviteDescription, inviteTitle, type InviteVars } from "./invite_template.ts";

type Row = Record<string, any>;

const CLIENT_ID = Deno.env.get("CRM_GOOGLE_CLIENT_ID") ?? "";
const CLIENT_SECRET = Deno.env.get("CRM_GOOGLE_CLIENT_SECRET") ?? "";
const TOKEN_KEY = Deno.env.get("CRM_TOKEN_KEY") ?? "";
export const CLIENT_KIND: "desktop" | "web" = (Deno.env.get("CRM_GOOGLE_CLIENT_KIND") ?? "desktop").toLowerCase() === "web" ? "web" : "desktop";
export const CALLBACK_URL = `${SUPABASE_URL}/functions/v1/crm-mcp/calendar/callback`;
/** Desktop-client return address when the app is not on localhost: nothing listens there, the member pastes it back. */
export const PASTE_REDIRECT = "http://127.0.0.1:53682/";
export const DEFAULT_RETURN_TO = `${WEB_ORIGIN}/crm/calendar`;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
const API = "https://www.googleapis.com/calendar/v3";
export const WRITE_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";
// exactly what Desk asks for, so the consent screen needs no new scopes; guests' free/busy is best effort (not_visible)
const SCOPES = ["openid", "email", WRITE_SCOPE, LIST_SCOPE];

export const DEFAULT_TZ = "Asia/Kolkata";
const DEFAULT_DURATION_MIN = 30;
const DEFAULT_WINDOW = "10:00-19:00";
const STATE_TTL_S = 15 * 60;

export type Notify = "all" | "externalOnly" | "none";

export function isConfigured(): boolean { return !!(CLIENT_ID && CLIENT_SECRET && TOKEN_KEY); }
function requireConfigured(): void {
  if (!isConfigured()) throw new McpError("E_CALENDAR_NOT_CONFIGURED", "Google Calendar is not set up on the server yet (CRM_GOOGLE_CLIENT_ID / CRM_GOOGLE_CLIENT_SECRET / CRM_TOKEN_KEY).", "Tell the user: an admin runs scripts/crm-set-calendar-secrets.sh (see docs/crm/SETUP.md → Google Calendar). Everything else in the CRM works without it.");
}

// ---------------------------------------------------------------------------
// Crypto: refresh tokens at rest, signed OAuth state
// ---------------------------------------------------------------------------
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string) => unb64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4));

let aesKey: CryptoKey | null = null;
async function keys(): Promise<{ aes: CryptoKey }> {
  requireConfigured();
  if (!aesKey) {
    const raw = await crypto.subtle.digest("SHA-256", enc.encode(TOKEN_KEY));                 // any long random string works as CRM_TOKEN_KEY
    aesKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  return { aes: aesKey };
}
export async function encrypt(plain: string): Promise<string> {
  const { aes } = await keys();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, enc.encode(plain)));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64(out);
}
export async function decrypt(blob: string): Promise<string> {
  const { aes } = await keys();
  const u = unb64(blob);
  return dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, aes, u.slice(12)));
}
/** OAuth state: AES-GCM sealed (it carries the PKCE verifier), url-safe. Tampering fails decryption. */
async function sealState(payload: Row): Promise<string> {
  const { aes } = await keys();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("crm-cal-state") }, aes, enc.encode(JSON.stringify(payload))));
  const out = new Uint8Array(iv.length + ct.length); out.set(iv); out.set(ct, iv.length);
  return b64url(out);
}
async function openState(state: string): Promise<Row> {
  const { aes } = await keys();
  let p: Row;
  try {
    const u = unb64url(state);
    p = JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12), additionalData: enc.encode("crm-cal-state") }, aes, u.slice(12)))) as Row;
  } catch { throw new McpError("E_PAYLOAD_INVALID", "That sign-in address is not from a link this CRM issued (or it was cut off). Start the connection again."); }
  if (typeof p.e !== "number" || p.e < Date.now() / 1000) throw new McpError("E_PAYLOAD_INVALID", `That sign-in link has expired (${STATE_TTL_S / 60} minutes). Start the connection again.`);
  return p;
}

// ---------------------------------------------------------------------------
// Google HTTP
// ---------------------------------------------------------------------------
export class GoogleError extends Error { code: string; status: number; reasons: string[]; constructor(code: string, status: number, message: string, reasons: string[] = []) { super(message); this.code = code; this.status = status; this.reasons = reasons; } }
const RATE = ["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded"];

async function gfetch(method: string, url: string, token: string | null, body?: unknown, form?: Record<string, string>): Promise<Row> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (form) { payload = new URLSearchParams(form).toString(); headers["content-type"] = "application/x-www-form-urlencoded"; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers["content-type"] = "application/json; charset=utf-8"; }
  for (let attempt = 0; attempt < 4; attempt++) {
    let r: Response;
    try { r = await fetch(url, { method, headers, body: payload }); }
    catch (e) { throw new GoogleError("E_GOOGLE_NETWORK", 0, `Could not reach Google: ${e instanceof Error ? e.message : String(e)}`); }
    const text = await r.text();
    const json = text.trim() ? (() => { try { return JSON.parse(text); } catch { return { raw: text }; } })() : {};
    if (r.ok) return json as Row;
    const err = (json as Row).error;
    if (typeof err === "string") {                                     // token endpoint shape
      if (err === "invalid_grant") throw new GoogleError("E_CALENDAR_RECONNECT", r.status, `Google no longer accepts the saved sign-in (${(json as Row).error_description ?? "invalid_grant"}).`);
      throw new GoogleError("E_GOOGLE", r.status, `${err}: ${(json as Row).error_description ?? ""}`.trim());
    }
    const e = (err && typeof err === "object" ? err : {}) as Row;
    const msg = e.message ?? `HTTP ${r.status}`;
    const reasons = [...(e.errors ?? []), ...(e.details ?? [])].map((d: Row) => String(d?.reason ?? "")).filter(Boolean);
    if (r.status === 403 && (reasons.includes("insufficientPermissions") || reasons.includes("ACCESS_TOKEN_SCOPE_INSUFFICIENT") || /insufficient authentication scopes/i.test(msg))) throw new GoogleError("E_CALENDAR_SCOPE", 403, msg, reasons);
    if (r.status === 401) throw new GoogleError("E_GOOGLE_UNAUTHORIZED", 401, msg, reasons);
    if (r.status === 404) throw new GoogleError("E_NOT_FOUND", 404, `Google: ${msg} (wrong event id, or the event lives on another calendar/account)`, reasons);
    const limited = r.status === 429 || (r.status === 403 && reasons.some((x) => RATE.includes(x)));
    if (limited && attempt < 3) { await new Promise((res) => setTimeout(res, 500 * 2 ** attempt)); continue; }
    throw new GoogleError("E_GOOGLE", r.status, `Google HTTP ${r.status}: ${msg}`, reasons);
  }
  throw new GoogleError("E_GOOGLE", 0, "Gave up after retries");
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------
export interface CalendarInfo { id: string; summary: string; primary: boolean; access_role?: string; background_color?: string; timezone?: string }
export interface Account {
  id: string; member_id: string; member_name: string; mine: boolean; email: string; label: string | null; aliases: string[]; is_default: boolean;
  can_write: boolean; calendars: CalendarInfo[]; timezone: string | null; auth_state: string; auth_error: string | null; connected_at: string; last_used_at: string | null;
}

export async function listAccounts(ctx: Ctx): Promise<Account[]> {
  const { data, error } = await ctx.user.rpc("crm_calendar_accounts_list");
  if (error) throw new Error(error.message);
  return (data ?? []) as Account[];
}

const tokenCache = new Map<string, { token: string; exp: number }>();

/** Access token for an account (service role reads the encrypted refresh token; nothing leaves this function). */
async function accessToken(accountId: string): Promise<string> {
  const hit = tokenCache.get(accountId);
  if (hit && hit.exp > Date.now() + 60_000) return hit.token;
  const { data, error } = await admin.from("crm_calendar_accounts").select("id, email, refresh_token_enc").eq("id", accountId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new McpError("E_NOT_FOUND", "calendar account not found (disconnected?)");
  const refresh = await decrypt((data as Row).refresh_token_enc);
  try {
    const tok = await gfetch("POST", TOKEN_URL, null, undefined, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token", refresh_token: refresh });
    tokenCache.set(accountId, { token: tok.access_token, exp: Date.now() + Math.max(60, Number(tok.expires_in ?? 3600) - 60) * 1000 });
    admin.from("crm_calendar_accounts").update({ last_used_at: new Date().toISOString(), auth_state: "ok", auth_error: null }).eq("id", accountId).then(() => {}, () => {});
    return tok.access_token;
  } catch (e) {
    if (e instanceof GoogleError && e.code === "E_CALENDAR_RECONNECT") {
      await admin.from("crm_calendar_accounts").update({ auth_state: "revoked", auth_error: e.message, updated_at: new Date().toISOString() }).eq("id", accountId);
      throw new McpError("E_CALENDAR_RECONNECT", `${(data as Row).email}: ${e.message}`, `Reconnect that Google account: CRM → Calendar → Reconnect, or calendar_connect_link(hint: "${(data as Row).email}").`);
    }
    throw e;
  }
}

/** Google API call as an account; a 401 clears the cached token and retries once. */
async function gapi(accountId: string, method: string, url: string, body?: unknown): Promise<Row> {
  try { return await gfetch(method, url, await accessToken(accountId), body); }
  catch (e) {
    if (e instanceof GoogleError && e.code === "E_GOOGLE_UNAUTHORIZED") { tokenCache.delete(accountId); return await gfetch(method, url, await accessToken(accountId), body); }
    if (e instanceof GoogleError && e.code === "E_CALENDAR_SCOPE") throw new McpError("E_CALENDAR_SCOPE", e.message, "The account was connected without 'view and edit events'. Reconnect it (CRM → Calendar → Reconnect, or calendar_connect_link) and allow every calendar permission.");
    throw e;
  }
}

/** Resolve an account reference: undefined → my default; else id, email, label, alias, or a unique substring. write=true → must be mine. */
export async function resolveAccount(ctx: Ctx, ref: string | null | undefined, opts: { write?: boolean; accounts?: Account[] } = {}): Promise<Account> {
  requireConfigured();
  const all = opts.accounts ?? await listAccounts(ctx);
  const mine = all.filter((a) => a.mine);
  const pool = opts.write ? mine : all;
  const notConnected = () => new McpError("E_CALENDAR_NOT_CONNECTED", "No Google Calendar is connected for this account yet.", "Connect one: CRM → Calendar → Connect Google Calendar, or call calendar_connect_link and give the user the link.");
  if (!ref) {
    if (mine.length === 0) throw notConnected();
    return mine.find((a) => a.is_default) ?? mine[0];
  }
  const key = ref.trim().toLowerCase();
  const hit = pool.find((a) => a.id === key) ?? pool.find((a) => a.email.toLowerCase() === key)
    ?? pool.find((a) => (a.label ?? "").toLowerCase() === key || a.aliases.map((x) => x.toLowerCase()).includes(key))
    ?? pool.find((a) => a.member_name.toLowerCase() === key || a.email.split("@")[0].toLowerCase() === key);
  if (hit) return hit;
  const subs = pool.filter((a) => a.email.toLowerCase().includes(key) || a.member_name.toLowerCase().includes(key));
  if (subs.length === 1) return subs[0];
  if (opts.write && all.some((a) => !a.mine && (a.email.toLowerCase() === key || a.email.toLowerCase().includes(key)))) throw new McpError("E_CALENDAR_READONLY", `${ref} is a teammate's calendar — you can see it but only they can book on it.`, "Book on one of your own accounts, or ask that teammate to book it.");
  if (pool.length === 0) throw notConnected();
  throw new McpError("E_NOT_FOUND", `Unknown calendar account '${ref}'. ${opts.write ? "Yours" : "Connected"}: ${pool.map((a) => a.email + (a.label ? ` (${a.label})` : "")).join(", ")}`);
}

/** The account's timezone → the team timezone → IST. */
export function tzFor(ctx: Ctx, account?: Account | null, override?: string | null): string {
  if (override) return override;
  return account?.timezone || ctx.crm.timezone || DEFAULT_TZ;
}

// ---------------------------------------------------------------------------
// Sign-in
//
// Two client kinds (CRM_GOOGLE_CLIENT_KIND):
//   desktop (default) — Desk's own OAuth client (desk-by-kaptured-ai, type "installed"). Google only lets it return to a
//     loopback address, so:  app opened on localhost/127.0.0.1 → Google returns straight to {that origin}/crm/calendar/google
//     (mode "auto");  hosted app, Claude, ChatGPT → Google returns to http://127.0.0.1:53682/ which does not load, and the
//     member pastes that address back (Calendar screen, or calendar_connect_finish in chat) (mode "paste").
//   web — a "Web application" client whose redirect URI is CALLBACK_URL; Google returns to the server, fully automatic.
// The state is AES-GCM sealed (not just signed) because it carries the PKCE verifier; finishing requires the same member.
// ---------------------------------------------------------------------------
function isLocal(u: URL): boolean { return (u.hostname === "localhost" || u.hostname === "127.0.0.1") && u.protocol === "http:"; }

function allowedReturn(url: string | null | undefined): string {
  if (!url) return DEFAULT_RETURN_TO;
  let u: URL;
  try { u = new URL(url); } catch { return DEFAULT_RETURN_TO; }
  const extra = (Deno.env.get("CRM_CALENDAR_RETURN_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const origins = new Set([...Object.values(BRANDS).map((b) => b.appOrigin), ...extra]);
  if (!isLocal(u) && !origins.has(u.origin)) return DEFAULT_RETURN_TO;
  u.search = ""; u.hash = "";
  return u.toString();
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier))));
  return { verifier, challenge };
}

export type ConnectMode = "auto" | "paste";

/** The Google consent link for the calling member. mode "auto": the browser comes back to the app by itself; "paste": the
 *  member copies the address the browser lands on (it will not load) and hands it back to finishConnect. */
export async function connectUrl(ctx: Ctx, opts: { hint?: string | null; return_to?: string | null } = {}): Promise<{ url: string; mode: ConnectMode; return_to: string; expires_in: number; instructions: string }> {
  requireConfigured();
  if (!ctx.isMember) throw new McpError("E_FORBIDDEN", "not on the CRM team");
  const return_to = allowedReturn(opts.return_to);
  const rt = new URL(return_to);
  let redirect_uri: string, mode: ConnectMode;
  if (CLIENT_KIND === "web") { redirect_uri = CALLBACK_URL; mode = "auto"; }
  else if (opts.return_to && isLocal(rt)) { redirect_uri = `${rt.origin}/crm/calendar/google`; mode = "auto"; }
  else { redirect_uri = PASTE_REDIRECT; mode = "paste"; }
  const { verifier, challenge } = await pkce();
  const state = await sealState({ u: ctx.userId, r: return_to, h: opts.hint ?? null, ru: redirect_uri, v: verifier, e: Math.floor(Date.now() / 1000) + STATE_TTL_S });
  const p = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: opts.hint ? "consent" : "consent select_account", include_granted_scopes: "true", state, code_challenge: challenge, code_challenge_method: "S256" });
  if (opts.hint) p.set("login_hint", opts.hint);
  const instructions = mode === "paste"
    ? `Open the link, pick ${opts.hint ?? "the Google account"} and allow every calendar permission (it must include view and edit events). Google then sends the browser to an address starting with ${PASTE_REDIRECT} — that page will not load, which is expected. Copy the whole address from the address bar and paste it back. The link works once and expires in ${STATE_TTL_S / 60} minutes.`
    : `Open the link, pick ${opts.hint ?? "the Google account"} and allow every calendar permission; the browser comes back to the CRM by itself.`;
  return { url: `${AUTH_URL}?${p}`, mode, return_to, expires_in: STATE_TTL_S, instructions };
}

/** Pull code + state (or error) out of what the member pasted / what Google appended to the redirect. */
function parseReturn(input: string | URLSearchParams): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  const text = String(input ?? "").trim().replace(/^["'<]+|["'>]+$/g, "");
  const q = text.includes("?") ? text.slice(text.indexOf("?") + 1).split("#")[0] : text;
  const params = new URLSearchParams(q);
  if (!params.get("code") && !params.get("error")) throw new McpError("E_PAYLOAD_INVALID", "No sign-in code in that address. Paste the full address the browser landed on — it contains ?state=…&code=… .");
  return params;
}

export interface Connected { email: string; calendars: number; can_write: boolean; is_default: boolean; return_to: string; warning?: string; note?: string }

/** Finish a sign-in: verify the sealed state (and, when given, that the same member is finishing), exchange the code,
 *  learn which Google account signed in, pull its calendars and store the refresh token encrypted. */
export async function finishConnect(input: string | URLSearchParams, ctx?: Ctx | null): Promise<Connected> {
  requireConfigured();
  const q = parseReturn(input);
  const st = await openState(q.get("state") ?? "");
  if (ctx && ctx.userId !== st.u) throw new McpError("E_FORBIDDEN", "That sign-in link was started by a different CRM member. Start the connection again from your own account.");
  const err = q.get("error");
  if (err) throw new McpError("E_PAYLOAD_INVALID", err === "access_denied" ? "Access was not granted on Google's consent screen." : `Google refused the sign-in: ${err}`);
  const { data: mem } = await admin.from("crm_members").select("user_id, is_active").eq("user_id", st.u).maybeSingle();
  if (!mem || !(mem as Row).is_active) throw new McpError("E_FORBIDDEN", "This account is not on the CRM team.");

  let tok: Row;
  try { tok = await gfetch("POST", TOKEN_URL, null, undefined, { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: q.get("code") ?? "", code_verifier: st.v, grant_type: "authorization_code", redirect_uri: st.ru }); }
  catch (e) { if (e instanceof GoogleError && e.code === "E_CALENDAR_RECONNECT") throw new McpError("E_PAYLOAD_INVALID", "Google did not accept that code (already used or expired). Start the connection again for a fresh link."); throw e; }
  if (!tok.refresh_token) throw new McpError("E_PAYLOAD_INVALID", "Google returned no long-lived sign-in. Start again and make sure you press Allow.");
  const scopes = String(tok.scope ?? "").split(/\s+/).filter(Boolean);
  const who = await gfetch("GET", USERINFO_URL, tok.access_token);
  const email = String(who.email ?? "").trim().toLowerCase();
  if (!email) throw new McpError("E_PAYLOAD_INVALID", "Google did not say which account signed in (email permission missing).");
  let calendars: CalendarInfo[] = [];
  try { calendars = await pullCalendarList(tok.access_token); } catch (e) { log({ fn: "crm-mcp", calendar: "connect", warn: "calendarList failed", error: String(e) }); }
  const primary = calendars.find((c) => c.primary);
  const { data: existing } = await admin.from("crm_calendar_accounts").select("id, email").eq("member_id", st.u);
  const rows = (existing ?? []) as Row[];
  const first = rows.filter((r) => r.email !== email).length === 0;
  const row = { member_id: st.u, email, scopes, calendars, timezone: primary?.timezone ?? null, refresh_token_enc: await encrypt(tok.refresh_token), auth_state: "ok", auth_error: null, updated_at: new Date().toISOString() };
  const { data: saved, error } = await admin.from("crm_calendar_accounts").upsert({ ...row, ...(first ? { is_default: true } : {}) }, { onConflict: "member_id,email" }).select("id, is_default").single();
  if (error) throw new Error(error.message);
  tokenCache.delete((saved as Row).id);
  const can_write = scopes.includes(WRITE_SCOPE);
  log({ fn: "crm-mcp", calendar: "connect", status: "ok", member: st.u, calendars: calendars.length, write: can_write, via: st.ru === PASTE_REDIRECT ? "paste" : st.ru === CALLBACK_URL ? "web" : "loopback" });
  return {
    email, calendars: calendars.length, can_write, is_default: !!(saved as Row).is_default, return_to: st.r || DEFAULT_RETURN_TO,
    warning: can_write ? undefined : "Connected READ-ONLY: booking will fail. Reconnect and tick every calendar permission.",
    note: st.h && String(st.h).toLowerCase() !== email ? `You asked to connect ${st.h} but ${email} signed in.` : undefined,
  };
}

/** Web-client callback (Google → server). Returns where to send the browser; never throws. */
export async function handleCallback(query: URLSearchParams): Promise<string> {
  let return_to = DEFAULT_RETURN_TO;
  try { return_to = (await openState(query.get("state") ?? "")).r || DEFAULT_RETURN_TO; } catch { /* reported below */ }
  const back = (params: Record<string, string | undefined>) => { const u = new URL(return_to); for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v); return u.toString(); };
  try {
    const r = await finishConnect(query, null);
    return back({ calendar: "connected", account: r.email, warning: r.warning, note: r.note });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log({ fn: "crm-mcp", route: "calendar/callback", status: "error", error: msg });
    return back({ calendar: "error", reason: msg.slice(0, 300) });
  }
}

async function pullCalendarList(token: string): Promise<CalendarInfo[]> {
  const data = await gfetch("GET", `${API}/users/me/calendarList?minAccessRole=reader&maxResults=250`, token);
  return ((data.items ?? []) as Row[]).map((c) => ({ id: c.id, summary: c.summaryOverride || c.summary || c.id, primary: !!c.primary, access_role: c.accessRole, background_color: c.backgroundColor, timezone: c.timeZone }));
}

/** Re-pull one of my accounts' calendar list (a newly created calendar shows up). */
export async function refreshAccount(ctx: Ctx, accountRef: string): Promise<Account> {
  const a = await resolveAccount(ctx, accountRef, { write: true });
  const calendars = await pullCalendarList(await accessToken(a.id));
  const primary = calendars.find((c) => c.primary);
  await admin.from("crm_calendar_accounts").update({ calendars, timezone: primary?.timezone ?? a.timezone, updated_at: new Date().toISOString() }).eq("id", a.id);
  return { ...a, calendars, timezone: primary?.timezone ?? a.timezone };
}

/** Forget one of my accounts (DB row) and revoke the grant at Google, best effort. */
export async function disconnectAccount(ctx: Ctx, accountRef: string): Promise<Row> {
  const a = await resolveAccount(ctx, accountRef, { write: true });
  const { data } = await admin.from("crm_calendar_accounts").select("refresh_token_enc").eq("id", a.id).maybeSingle();
  const { data: res, error } = await ctx.user.rpc("crm_calendar_account_delete", { p_account_id: a.id });
  if (error) throw new Error(error.message);
  tokenCache.delete(a.id);
  let revoked = false;
  try { if (data) { await gfetch("POST", `${REVOKE_URL}?token=${encodeURIComponent(await decrypt((data as Row).refresh_token_enc))}`, null, undefined, {}); revoked = true; } } catch { /* the grant can also be removed at myaccount.google.com/permissions */ }
  return { ...(res as Row), revoked };
}

// ---------------------------------------------------------------------------
// Time helpers (IANA timezones via Intl; no libraries)
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");

function tzParts(d: Date, tz: string): { y: number; m: number; d: number; hh: number; mm: number; ss: number; wd: number } {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const p: Row = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour % 24, mm: +p.minute, ss: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}
function tzOffsetMin(d: Date, tz: string): number {
  const p = tzParts(d, tz);
  return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(d.getTime() / 1000) * 1000) / 60000;
}
/** Wall-clock time in tz → instant. */
export function zoned(y: number, m: number, d: number, hh: number, mm: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - tzOffsetMin(new Date(guess), tz) * 60000;
  t = guess - tzOffsetMin(new Date(t), tz) * 60000;
  return new Date(t);
}
export function validTz(tz: string): boolean { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; } }
export const dayKey = (d: Date, tz: string) => { const p = tzParts(d, tz); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; };
const minutesOfDay = (d: Date, tz: string) => { const p = tzParts(d, tz); return p.hh * 60 + p.mm; };
const addDays = (d: Date, n: number, tz: string) => { const p = tzParts(d, tz); return zoned(p.y, p.m, p.d + n, p.hh, p.mm, tz); };

export function fmtWhen(start: Date, end: Date, allDay: boolean, tz: string): string {
  const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", year: "numeric" }).format(d).replace(/,/g, "");
  const hm = (d: Date) => { const p = tzParts(d, tz); return `${pad(p.hh)}:${pad(p.mm)}`; };
  if (allDay) {
    const last = new Date(end.getTime() - 86400_000);
    return dayKey(last, tz) <= dayKey(start, tz) ? `${day(start)} (all day)` : `${day(start)} – ${day(last)} (all day)`;
  }
  return dayKey(start, tz) === dayKey(end, tz) ? `${day(start)} ${hm(start)}–${hm(end)}` : `${day(start)} ${hm(start)} – ${day(end)} ${hm(end)}`;
}

const TIME_RE = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\s*(z|[+-]\d{2}:?\d{2})?$/i;
export interface When { at: Date; hasTime: boolean; day: string }

/** 'today', 'tomorrow', 'YYYY-MM-DD', 'YYYY-MM-DD HH:MM', 'YYYY-MM-DDTHH:MM[:SS][+05:30|Z]', 'tomorrow 3pm', '16:30' → instant in tz. */
export function parseWhen(text: string | null | undefined, tz: string, now = new Date()): When {
  let s = String(text ?? "").trim();
  const low = s.toLowerCase();
  let ymd: [number, number, number] | null = null;
  for (const [word, delta] of [["today", 0], ["tomorrow", 1]] as const) {
    if (low.startsWith(word)) { const p = tzParts(addDays(now, delta, tz), tz); ymd = [p.y, p.m, p.d]; s = s.slice(word.length).trim(); break; }
  }
  if (!ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ]\s*(.*))?$/.exec(s);
    if (m) { ymd = [+m[1], +m[2], +m[3]]; s = (m[4] ?? "").trim(); }
    else { const p = tzParts(now, tz); ymd = [p.y, p.m, p.d]; }
  }
  const [y, mo, d] = ymd;
  if (!s) return { at: zoned(y, mo, d, 0, 0, tz), hasTime: false, day: `${y}-${pad(mo)}-${pad(d)}` };
  const m = TIME_RE.exec(s);
  if (!m) throw new McpError("E_PAYLOAD_INVALID", `Cannot read date/time '${text}'. Use 'YYYY-MM-DD HH:MM' (${tz}) or an ISO timestamp with offset.`);
  let hh = +m[1]; const mm = +(m[2] ?? 0);
  const ampm = (m[4] ?? "").toLowerCase(), off = m[5];
  if (ampm === "pm" && hh < 12) hh += 12; else if (ampm === "am" && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) throw new McpError("E_PAYLOAD_INVALID", `Cannot read time '${text}'.`);
  let at: Date;
  if (off) {
    const offMin = off.toLowerCase() === "z" ? 0 : (off[0] === "-" ? -1 : 1) * (parseInt(off.slice(1, 3), 10) * 60 + parseInt(off.replace(":", "").slice(3, 5) || "0", 10));
    at = new Date(Date.UTC(y, mo - 1, d, hh, mm) - offMin * 60000);
  } else at = zoned(y, mo, d, hh, mm, tz);
  return { at, hasTime: true, day: dayKey(at, tz) };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------
export interface EventRow {
  id: string; account_id: string; account_email: string; member_name: string; mine: boolean; calendar_id: string; calendar_name?: string;
  title: string; start: string; end: string; all_day: boolean; day: string; start_min: number; end_min: number; when: string; tz: string;
  status: string; busy: boolean; organizer: string; organizer_self: boolean; self_response?: string;
  attendees: Array<{ email: string; name?: string; response?: string; organizer?: boolean; self?: boolean; optional?: boolean }>;
  meet: string; location: string; html_link: string; description: string; recurring: boolean;
  crm?: { meeting_id: string; company_id?: string; company?: string; contact?: string; status?: string; has_capture?: boolean; deal_id?: string };
}

const calPath = (calendarId: string) => `${API}/calendars/${encodeURIComponent(calendarId)}/events`;
const rfc3339 = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
export function meetLink(ev: Row): string {
  if (ev.hangoutLink) return ev.hangoutLink;
  for (const ep of ev.conferenceData?.entryPoints ?? []) if (ep.entryPointType === "video") return ep.uri ?? "";
  return "";
}
export function eventSpan(ev: Row, tz: string): { start: Date; end: Date; allDay: boolean } {
  const s = ev.start ?? {}, e = ev.end ?? {};
  if (s.date) {
    const [y0, m0, d0] = String(s.date).split("-").map(Number), [y1, m1, d1] = String(e.date ?? s.date).split("-").map(Number);
    return { start: zoned(y0, m0, d0, 0, 0, tz), end: zoned(y1, m1, d1, 0, 0, tz), allDay: true };
  }
  const start = new Date(s.dateTime), end = new Date(e.dateTime ?? s.dateTime);
  return { start, end, allDay: false };
}
function isBusy(ev: Row, email: string): boolean {
  if (ev.transparency === "transparent" || ev.start?.date) return false;
  for (const a of ev.attendees ?? []) if (a.self || String(a.email ?? "").toLowerCase() === email) return a.responseStatus !== "declined";
  return true;
}

export function summarize(ev: Row, tz: string, a: Account, calendarId: string): EventRow {
  const { start, end, allDay } = eventSpan(ev, tz);
  const self = (ev.attendees ?? []).find((x: Row) => x.self || String(x.email ?? "").toLowerCase() === a.email);
  const calName = a.calendars.find((c) => c.id === calendarId || (calendarId === "primary" && c.primary))?.summary;
  return {
    id: ev.id, account_id: a.id, account_email: a.email, member_name: a.member_name, mine: a.mine, calendar_id: calendarId === "primary" ? a.email : calendarId, calendar_name: calName,
    title: ev.summary || "(no title)", start: start.toISOString(), end: end.toISOString(), all_day: allDay, day: dayKey(start, tz),
    start_min: allDay ? 0 : minutesOfDay(start, tz), end_min: allDay ? 1440 : (dayKey(end, tz) === dayKey(start, tz) ? minutesOfDay(end, tz) : 1440), when: fmtWhen(start, end, allDay, tz), tz,
    status: ev.status ?? "confirmed", busy: isBusy(ev, a.email), organizer: ev.organizer?.email ?? "", organizer_self: !!ev.organizer?.self, self_response: self?.responseStatus,
    attendees: (ev.attendees ?? []).map((x: Row) => compact({ email: x.email, name: x.displayName, response: x.responseStatus, organizer: x.organizer || undefined, self: x.self || undefined, optional: x.optional || undefined })) as EventRow["attendees"],
    meet: meetLink(ev), location: ev.location ?? "", html_link: ev.htmlLink ?? "", description: String(ev.description ?? "").slice(0, 500), recurring: !!ev.recurringEventId,
  };
}

async function listRaw(accountId: string, calendarId: string, tMin: Date, tMax: Date, q?: string | null, limit = 250): Promise<Row[]> {
  const params = new URLSearchParams({ timeMin: rfc3339(tMin), timeMax: rfc3339(tMax), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
  if (q) params.set("q", q);
  const items: Row[] = [];
  for (let page = 0; page < 5; page++) {
    const data = await gapi(accountId, "GET", `${calPath(calendarId)}?${params}`);
    items.push(...((data.items ?? []) as Row[]).filter((ev) => ev.status !== "cancelled"));
    if (!data.nextPageToken || items.length >= limit) break;
    params.set("pageToken", data.nextPageToken);
  }
  return items.slice(0, limit);
}
const getRaw = (accountId: string, calendarId: string, eventId: string) => gapi(accountId, "GET", `${calPath(calendarId)}/${encodeURIComponent(eventId)}`);

/** Attach CRM meeting info to events that are linked. */
async function attachCrm(ctx: Ctx, rows: EventRow[]): Promise<void> {
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return;
  const { data: links } = await ctx.user.from("crm_meeting_calendar_events").select("meeting_id, event_id").in("event_id", ids);
  const byEvent = new Map<string, string>(((links ?? []) as Row[]).map((l) => [l.event_id, l.meeting_id]));
  if (byEvent.size === 0) return;
  const { data: mts } = await ctx.user.from("crm_meetings_v").select("id, deal_id, company_id, company_name, contact_name, status, has_capture").in("id", [...byEvent.values()]);
  const byMeeting = new Map<string, Row>(((mts ?? []) as Row[]).map((m) => [m.id, m]));
  for (const r of rows) {
    const mid = byEvent.get(r.id);
    const m = mid ? byMeeting.get(mid) : undefined;
    if (mid) r.crm = { meeting_id: mid, company_id: m?.company_id, company: m?.company_name, contact: m?.contact_name, status: m?.status, has_capture: m?.has_capture, deal_id: m?.deal_id };
  }
}

export interface ListOpts { from?: string | null; to?: string | null; days?: number | null; q?: string | null; accounts?: "mine" | "team" | string[] | null; calendars?: "primary" | "all" | string[] | null; tz?: string | null; limit?: number | null }

/** Events across accounts × calendars, sorted by start. Default: my accounts, primary calendars, next 7 days. */
export async function listEvents(ctx: Ctx, o: ListOpts): Promise<{ from: string; to: string; tz: string; accounts: string[]; count: number; events: EventRow[]; errors?: Row[] }> {
  requireConfigured();
  const all = await listAccounts(ctx);
  let chosen: Account[];
  if (Array.isArray(o.accounts)) chosen = await Promise.all(o.accounts.map((r) => resolveAccount(ctx, r, { accounts: all })));
  else if (o.accounts === "team") chosen = all;
  else { chosen = all.filter((a) => a.mine); if (chosen.length === 0 && o.accounts !== "mine") chosen = all; }
  if (chosen.length === 0) throw new McpError("E_CALENDAR_NOT_CONNECTED", "No Google Calendar is connected yet.", "Connect one: CRM → Calendar → Connect Google Calendar, or calendar_connect_link.");
  const tz = tzFor(ctx, chosen.find((a) => a.mine) ?? chosen[0], o.tz);
  const now = new Date();
  const tMin = o.from ? parseWhen(o.from, tz, now).at : now;
  let tMax: Date;
  if (o.to) { const w = parseWhen(o.to, tz, now); tMax = w.hasTime ? w.at : addDays(w.at, 1, tz); }
  else tMax = new Date(tMin.getTime() + Math.max(1, Math.min(o.days ?? 7, 92)) * 86400_000);
  if (tMax <= tMin) throw new McpError("E_PAYLOAD_INVALID", "to must be after from");
  const rows: EventRow[] = [], errors: Row[] = [];
  await Promise.all(chosen.map(async (a) => {
    const cals = Array.isArray(o.calendars) ? o.calendars : o.calendars === "all" ? (a.calendars.map((c) => c.id).length ? a.calendars.map((c) => c.id) : ["primary"]) : ["primary"];
    for (const cal of cals) {
      try { for (const ev of await listRaw(a.id, cal, tMin, tMax, o.q, o.limit ?? 250)) rows.push(summarize(ev, tz, a, cal)); }
      catch (e) { errors.push({ account: a.email, calendar: cal, code: (e as Row).code ?? "E_GOOGLE", message: e instanceof Error ? e.message : String(e) }); }
    }
  }));
  // the same event can sit on two connected accounts (both invited): keep one row per event id
  const seen = new Set<string>(); const uniq = rows.filter((r) => { const k = `${r.id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  uniq.sort((x, y) => x.start.localeCompare(y.start) || x.title.localeCompare(y.title));
  await attachCrm(ctx, uniq);
  return { from: tMin.toISOString(), to: tMax.toISOString(), tz, accounts: chosen.map((a) => a.email), count: uniq.length, events: uniq, errors: errors.length ? errors : undefined };
}

export async function getEvent(ctx: Ctx, o: { account?: string | null; calendar?: string | null; event_id: string; tz?: string | null }): Promise<EventRow> {
  const located = await locateEvent(ctx, o.event_id, o.account, o.calendar);
  const ev = await getRaw(located.account.id, located.calendar, o.event_id);
  const row = summarize(ev, tzFor(ctx, located.account, o.tz), located.account, located.calendar);
  await attachCrm(ctx, [row]);
  return row;
}

/** Which account/calendar holds an event: the explicit ref, else the CRM link table, else my default. */
async function locateEvent(ctx: Ctx, eventId: string, accountRef?: string | null, calendar?: string | null, write = false): Promise<{ account: Account; calendar: string; meeting_id?: string }> {
  const all = await listAccounts(ctx);
  const { data: link } = await ctx.user.from("crm_meeting_calendar_events").select("meeting_id, account_id, calendar_id").eq("event_id", eventId).maybeSingle();
  const l = link as Row | null;
  if (accountRef) return { account: await resolveAccount(ctx, accountRef, { write, accounts: all }), calendar: calendar || (l?.calendar_id ?? "primary"), meeting_id: l?.meeting_id };
  if (l?.account_id) {
    const a = all.find((x) => x.id === l.account_id);
    if (a) {
      if (write && !a.mine) throw new McpError("E_CALENDAR_READONLY", `That event is on ${a.email} (${a.member_name}'s calendar); only they can change it.`);
      return { account: a, calendar: calendar || l.calendar_id || "primary", meeting_id: l.meeting_id };
    }
  }
  return { account: await resolveAccount(ctx, null, { write, accounts: all }), calendar: calendar || "primary", meeting_id: l?.meeting_id };
}

const cleanEmails = (values: Array<string | null | undefined> | null | undefined): string[] => {
  const out: string[] = [], seen = new Set<string>();
  for (const v of values ?? []) for (const raw of String(v ?? "").split(/[,\s;]+/)) {
    const e = raw.trim().replace(/^<|>$/g, "");
    if (!e) continue;
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new McpError("E_PAYLOAD_INVALID", `'${e}' is not an email address`);
    if (!seen.has(e.toLowerCase())) { seen.add(e.toLowerCase()); out.push(e); }
  }
  return out;
};
const meetRequest = () => ({ createRequest: { requestId: crypto.randomUUID().replace(/-/g, ""), conferenceSolutionKey: { type: "hangoutsMeet" } } });

interface Times { startObj: Row; endObj: Row; start: Date; end: Date; allDay: boolean }
function computeTimes(o: { start?: string | null; end?: string | null; duration_min?: number | null; all_day?: boolean | null }, tz: string, cur?: { start: Date; end: Date; allDay: boolean }): Times {
  let start: Date, hasTime: boolean;
  if (o.start) { const w = parseWhen(o.start, tz); start = w.at; hasTime = w.hasTime; }
  else if (cur) { start = cur.start; hasTime = !cur.allDay; }
  else throw new McpError("E_PAYLOAD_INVALID", "start is required");
  const allDay = !!o.all_day || !hasTime;
  let end: Date;
  if (allDay) {
    if (o.end) end = addDays(parseWhen(o.end, tz).at, 1, tz);                 // end = last day, inclusive
    else if (cur && !o.start) end = cur.end;
    else end = addDays(start, 1, tz);
    return { startObj: { date: dayKey(start, tz) }, endObj: { date: dayKey(end, tz) }, start, end, allDay };
  }
  if (o.end) end = parseWhen(o.end, tz).at;
  else if (o.duration_min) end = new Date(start.getTime() + o.duration_min * 60000);
  else if (cur) end = new Date(start.getTime() + (cur.end.getTime() - cur.start.getTime()));
  else end = new Date(start.getTime() + DEFAULT_DURATION_MIN * 60000);
  if (end <= start) throw new McpError("E_PAYLOAD_INVALID", "The end must be after the start.");
  return { startObj: { dateTime: start.toISOString(), timeZone: tz }, endObj: { dateTime: end.toISOString(), timeZone: tz }, start, end, allDay };
}

async function overlaps(a: Account, start: Date, end: Date, skipId?: string): Promise<Array<{ title: string; when: string; id: string }>> {
  const tz = a.timezone || DEFAULT_TZ;
  try { return (await listRaw(a.id, "primary", start, end)).filter((ev) => ev.id !== skipId && isBusy(ev, a.email)).map((ev) => { const s = eventSpan(ev, tz); return { id: ev.id, title: ev.summary || "(no title)", when: fmtWhen(s.start, s.end, s.allDay, tz) }; }); }
  catch { return []; }
}

export interface CreateOpts {
  account?: string | null; calendar?: string | null; title: string; start: string; end?: string | null; duration_min?: number | null; all_day?: boolean | null;
  attendees?: string[] | null; description?: string | null; location?: string | null; meet?: boolean | null; notify?: Notify | null; allow_duplicate?: boolean | null; tz?: string | null;
  /** link the new event to this CRM meeting */
  meeting_id?: string | null;
  /** or create a CRM meeting (crm_schedule_meeting payload: deal_id | contact_email | company …) and link it */
  crm?: Row | null;
}

export async function createEvent(ctx: Ctx, o: CreateOpts): Promise<{ event: EventRow; created: boolean; duplicate_of?: EventRow; overlaps: Row[]; notify: Notify; meeting?: Row; crm_error?: string }> {
  const a = await resolveAccount(ctx, o.account, { write: true });
  if (!a.can_write) throw new McpError("E_CALENDAR_SCOPE", `${a.email} was connected read-only.`, "Reconnect it (CRM → Calendar → Reconnect) and allow 'view and edit events'.");
  const tz = tzFor(ctx, a, o.tz);
  if (!validTz(tz)) throw new McpError("E_PAYLOAD_INVALID", `unknown timezone ${tz}`);
  const calendar = o.calendar || "primary";
  const title = o.title.trim();
  if (!title) throw new McpError("E_PAYLOAD_INVALID", "title is required");
  const t = computeTimes(o, tz);
  const attendees = cleanEmails(o.attendees).filter((e) => e.toLowerCase() !== a.email);
  const notify: Notify = o.notify ?? "all";

  if (!o.allow_duplicate) {                                                     // a retry cannot double-book
    for (const ev of await listRaw(a.id, calendar, t.start, t.end)) {
      if (String(ev.summary ?? "").trim().toLowerCase() === title.toLowerCase() && eventSpan(ev, tz).start.getTime() === t.start.getTime()) {
        const dup = summarize(ev, tz, a, calendar);
        await attachCrm(ctx, [dup]);
        return { event: dup, created: false, duplicate_of: dup, overlaps: [], notify };
      }
    }
  }
  const clashes = t.allDay ? [] : await overlaps(a, t.start, t.end);
  const body: Row = { summary: title, start: t.startObj, end: t.endObj };
  if (o.description) body.description = o.description;
  if (o.location) body.location = o.location;
  if (attendees.length) body.attendees = attendees.map((email) => ({ email }));
  const params = new URLSearchParams({ sendUpdates: notify });
  const wantMeet = (o.meet ?? true) && !t.allDay;
  if (wantMeet) { body.conferenceData = meetRequest(); params.set("conferenceDataVersion", "1"); }
  let ev = await gapi(a.id, "POST", `${calPath(calendar)}?${params}`, body);
  if (wantMeet && !meetLink(ev)) { await new Promise((r) => setTimeout(r, 1500)); ev = await getRaw(a.id, calendar, ev.id); }   // the Meet link is sometimes filled in async
  const row = summarize(ev, tz, a, calendar);

  let meeting: Row | undefined, crm_error: string | undefined;
  try {
    let meetingId = o.meeting_id ?? null;
    if (!meetingId && o.crm && Object.keys(o.crm).length) {
      const { data, error } = await ctx.user.rpc("crm_schedule_meeting", { p: compact({ ...o.crm, scheduled_at: t.start.toISOString(), duration_min: Math.round((t.end.getTime() - t.start.getTime()) / 60000), attendees: o.crm.attendees ?? attendees, notes: o.crm.notes ?? o.description ?? undefined }) });
      if (error) throw new Error(error.message);
      meeting = data as Row; meetingId = meeting.id;
    }
    if (meetingId) {
      await linkEvent(ctx, meetingId, a, calendar, ev, row);
      if (!meeting) { const { data } = await ctx.user.from("crm_meetings_v").select("id, company_id, company_name, contact_name, status, scheduled_at").eq("id", meetingId).maybeSingle(); meeting = (data as Row) ?? { id: meetingId }; }
      row.crm = { meeting_id: meetingId, company_id: meeting?.company_id, company: meeting?.company_name, contact: meeting?.contact_name, status: meeting?.status, deal_id: meeting?.deal_id };
    }
  } catch (e) { crm_error = e instanceof Error ? e.message : String(e); }
  log({ fn: "crm-mcp", calendar: "create", account: a.email, meet: !!row.meet, attendees: attendees.length, linked: !!row.crm });
  return { event: row, created: true, overlaps: clashes, notify, meeting, crm_error };
}

async function linkEvent(ctx: Ctx, meetingId: string, a: Account, calendar: string, ev: Row, row: EventRow): Promise<void> {
  const { error } = await ctx.user.rpc("crm_link_calendar_event", { p_meeting_id: meetingId, p: { account_id: a.id, account_email: a.email, calendar_id: calendar, event_id: ev.id, meet_link: row.meet || null, html_link: row.html_link || null, event_start: row.start, event_end: row.end, summary: row.title } });
  if (error) throw new Error(error.message);
}

export interface UpdateOpts {
  event_id: string; account?: string | null; calendar?: string | null; title?: string | null; start?: string | null; end?: string | null; duration_min?: number | null;
  attendees?: string[] | null; add_attendees?: string[] | null; remove_attendees?: string[] | null; description?: string | null; location?: string | null; meet?: boolean | null; notify?: Notify | null; tz?: string | null;
}

export async function updateEvent(ctx: Ctx, o: UpdateOpts): Promise<{ event: EventRow; overlaps: Row[]; not_organizer: boolean; meeting_updated: boolean; notify: Notify }> {
  const loc = await locateEvent(ctx, o.event_id, o.account, o.calendar, true);
  const a = loc.account, calendar = loc.calendar, tz = tzFor(ctx, a, o.tz);
  const ev = await getRaw(a.id, calendar, o.event_id);
  const patch: Row = {}; const params = new URLSearchParams({ sendUpdates: o.notify ?? "all" });
  if (o.title != null) patch.summary = o.title;
  if (o.description != null) patch.description = o.description;
  if (o.location != null) patch.location = o.location;
  let clashes: Row[] = [], timeChanged = false;
  if (o.start || o.end || o.duration_min) {
    const t = computeTimes(o, tz, eventSpan(ev, tz));
    patch.start = t.startObj; patch.end = t.endObj; timeChanged = true;
    if (!t.allDay) clashes = await overlaps(a, t.start, t.end, ev.id);
  }
  if (o.attendees) patch.attendees = cleanEmails(o.attendees).filter((e) => e.toLowerCase() !== a.email).map((email) => ({ email }));
  else if (o.add_attendees?.length || o.remove_attendees?.length) {
    const drop = new Set(cleanEmails(o.remove_attendees).map((e) => e.toLowerCase()));
    const cur = ((ev.attendees ?? []) as Row[]).filter((x) => !drop.has(String(x.email ?? "").toLowerCase()));
    const have = new Set(cur.map((x) => String(x.email ?? "").toLowerCase()));
    for (const e of cleanEmails(o.add_attendees)) if (!have.has(e.toLowerCase()) && e.toLowerCase() !== a.email) cur.push({ email: e });
    patch.attendees = cur;
  }
  if (o.meet && !meetLink(ev)) { patch.conferenceData = meetRequest(); params.set("conferenceDataVersion", "1"); }
  if (Object.keys(patch).length === 0) throw new McpError("E_PAYLOAD_INVALID", "Nothing to change: give title, start/end/duration_min, attendees, description, location or meet.");
  const updated = await gapi(a.id, "PATCH", `${calPath(calendar)}/${encodeURIComponent(o.event_id)}?${params}`, patch);
  const row = summarize(updated, tz, a, calendar);
  let meeting_updated = false;
  if (loc.meeting_id) {
    try {
      await linkEvent(ctx, loc.meeting_id, a, calendar, updated, row);
      if (timeChanged) { const { error } = await ctx.user.rpc("crm_update_meeting", { p_meeting_id: loc.meeting_id, p: { scheduled_at: row.start, duration_min: Math.max(5, Math.round((new Date(row.end).getTime() - new Date(row.start).getTime()) / 60000)) } }); if (error) throw new Error(error.message); meeting_updated = true; }
      row.crm = { meeting_id: loc.meeting_id };
    } catch (e) { log({ fn: "crm-mcp", calendar: "update", warn: "crm sync failed", error: String(e) }); }
  }
  await attachCrm(ctx, [row]);
  return { event: row, overlaps: clashes, not_organizer: !ev.organizer?.self, meeting_updated, notify: (o.notify ?? "all") as Notify };
}

export async function deleteEvent(ctx: Ctx, o: { event_id: string; account?: string | null; calendar?: string | null; notify?: Notify | null; tz?: string | null }): Promise<{ deleted: true; title: string; when: string; account: string; meeting_cancelled: boolean; meeting_id?: string }> {
  const loc = await locateEvent(ctx, o.event_id, o.account, o.calendar, true);
  const a = loc.account, calendar = loc.calendar, tz = tzFor(ctx, a, o.tz);
  const ev = await getRaw(a.id, calendar, o.event_id);
  const s = eventSpan(ev, tz);
  await gapi(a.id, "DELETE", `${calPath(calendar)}/${encodeURIComponent(o.event_id)}?${new URLSearchParams({ sendUpdates: o.notify ?? "all" })}`);
  let meeting_cancelled = false;
  if (loc.meeting_id) {
    try {
      const { data: m } = await ctx.user.from("crm_meetings").select("status").eq("id", loc.meeting_id).maybeSingle();
      if ((m as Row | null)?.status === "scheduled") { const { error } = await ctx.user.rpc("crm_update_meeting", { p_meeting_id: loc.meeting_id, p: { status: "cancelled" } }); if (error) throw new Error(error.message); meeting_cancelled = true; }
      await ctx.user.rpc("crm_unlink_calendar_event", { p_meeting_id: loc.meeting_id });
    } catch (e) { log({ fn: "crm-mcp", calendar: "delete", warn: "crm sync failed", error: String(e) }); }
  }
  return { deleted: true, title: ev.summary || "(no title)", when: fmtWhen(s.start, s.end, s.allDay, tz), account: a.email, meeting_cancelled, meeting_id: loc.meeting_id };
}

// ---------------------------------------------------------------------------
// Free slots
// ---------------------------------------------------------------------------
export interface FreeOpts { date?: string | null; days?: number | null; duration_min?: number | null; window?: string | null; with?: string[] | null; weekdays?: boolean | null; accounts?: "mine" | "team" | string[] | null; tz?: string | null }

export async function freeSlots(ctx: Ctx, o: FreeOpts): Promise<{ tz: string; window: string; duration_min: number; checked: string[]; not_visible: string[]; slots: Array<{ day: string; start: string; end: string; label: string }>; summary: string }> {
  requireConfigured();
  const all = await listAccounts(ctx);
  let chosen: Account[];
  if (Array.isArray(o.accounts)) chosen = await Promise.all(o.accounts.map((r) => resolveAccount(ctx, r, { accounts: all })));
  else if (o.accounts === "team") chosen = all;
  else chosen = all.filter((a) => a.mine);
  if (chosen.length === 0) throw new McpError("E_CALENDAR_NOT_CONNECTED", "No Google Calendar is connected yet.", "Connect one: CRM → Calendar → Connect Google Calendar, or calendar_connect_link.");
  const tz = tzFor(ctx, chosen.find((a) => a.mine) ?? chosen[0], o.tz);
  const now = new Date();
  const first = parseWhen(o.date || "today", tz, now).at;
  const days = Math.max(1, Math.min(o.days ?? 1, 31)), need = (o.duration_min ?? DEFAULT_DURATION_MIN) * 60000;
  const win = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(o.window ?? DEFAULT_WINDOW);
  if (!win) throw new McpError("E_PAYLOAD_INVALID", "window must look like 10:00-19:00");
  const [h0, m0, h1, m1] = [+win[1], +win[2], +win[3], +win[4]];
  const fp = tzParts(first, tz);
  const spanMin = zoned(fp.y, fp.m, fp.d, h0, m0, tz), spanMax = zoned(fp.y, fp.m, fp.d + days - 1, h1, m1, tz);

  const busy: Array<[number, number]> = [];
  await Promise.all(chosen.map(async (a) => {
    for (const ev of await listRaw(a.id, "primary", spanMin, spanMax)) if (isBusy(ev, a.email)) { const s = eventSpan(ev, tz); busy.push([s.start.getTime(), s.end.getTime()]); }
  }));
  const others = cleanEmails(o.with), notVisible: string[] = [];
  if (others.length) {
    try {
      const fb = await gapi(chosen[0].id, "POST", `${API}/freeBusy`, { timeMin: rfc3339(spanMin), timeMax: rfc3339(spanMax), items: others.map((id) => ({ id })) });
      for (const e of others) {
        const cal = fb.calendars?.[e] ?? {};
        if (cal.errors?.length) notVisible.push(e);
        for (const b of cal.busy ?? []) busy.push([new Date(b.start).getTime(), new Date(b.end).getTime()]);
      }
    } catch { notVisible.push(...others); }
  }
  busy.sort((x, y) => x[0] - y[0]);
  const step = 15 * 60000;
  const slots: Array<{ day: string; start: string; end: string; label: string }> = [];
  for (let i = 0; i < days; i++) {
    const dayStart = zoned(fp.y, fp.m, fp.d + i, h0, m0, tz), dayEnd = zoned(fp.y, fp.m, fp.d + i, h1, m1, tz);
    if (o.weekdays && [0, 6].includes(tzParts(dayStart, tz).wd)) continue;
    let cur = dayStart.getTime();
    if (cur < now.getTime()) cur = Math.ceil(now.getTime() / step) * step;
    for (const [s, e] of [...busy, [dayEnd.getTime(), dayEnd.getTime()] as [number, number]]) {
      if (e <= cur) continue;
      if (s - cur >= need && cur < dayEnd.getTime()) {
        const sd = new Date(cur), ed = new Date(Math.min(s, dayEnd.getTime()));
        const ps = tzParts(sd, tz), pe = tzParts(ed, tz);
        slots.push({ day: dayKey(sd, tz), start: sd.toISOString(), end: ed.toISOString(), label: `${new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "2-digit", month: "short" }).format(sd).replace(/,/g, "")} ${pad(ps.hh)}:${pad(ps.mm)}–${pad(pe.hh)}:${pad(pe.mm)}` });
      }
      cur = Math.max(cur, e);
      if (cur >= dayEnd.getTime()) break;
    }
  }
  const checked = [...chosen.map((a) => a.email), ...others.filter((e) => !notVisible.includes(e))];
  const summary = (slots.length ? `Free for ${(o.duration_min ?? DEFAULT_DURATION_MIN)} min (${win[0]} ${tz}): ${slots.slice(0, 6).map((s) => s.label).join("; ")}${slots.length > 6 ? ` … +${slots.length - 6} more` : ""}` : `No free ${(o.duration_min ?? DEFAULT_DURATION_MIN)}-min slot in that range (${win[0]} ${tz}).`)
    + (notVisible.length ? ` Could not see the calendar of ${notVisible.join(", ")}; their busy times are not included.` : "");
  return { tz, window: win[0], duration_min: o.duration_min ?? DEFAULT_DURATION_MIN, checked, not_visible: notVisible, slots, summary };
}

// ---------------------------------------------------------------------------
// CRM meeting → Google event
// ---------------------------------------------------------------------------
/** Create (or return the existing) Google event for a CRM meeting. Title and description come from the team's invite
 *  templates (settings invite_title_template / invite_description_template, default "<Me> <> <contact or company>" and
 *  "<notes>\n\n<company> · <contact>"), plus Meet link and invites. */
export async function createEventForMeeting(ctx: Ctx, meetingId: string, o: { account?: string | null; notify?: Notify | null; title?: string | null; meet?: boolean | null; extra_attendees?: string[] | null } = {}): Promise<Row> {
  const { data: m, error } = await ctx.user.from("crm_meetings_v").select("*").eq("id", meetingId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!m) throw new McpError("E_NOT_FOUND", `meeting ${meetingId} not found`);
  const mv = m as Row;
  if (mv.has_calendar_event) { const a = await listAccounts(ctx); const acc = a.find((x) => x.email === mv.calendar_account); if (acc) return { event: await getEvent(ctx, { event_id: (await ctx.user.from("crm_meeting_calendar_events").select("event_id").eq("meeting_id", meetingId).single()).data!.event_id, account: acc.id }), created: false, already_linked: true }; }
  if (mv.status === "cancelled") throw new McpError("E_MEETING_CANCELLED", "The CRM meeting is cancelled; reschedule it first.");
  const me = ctx.crm.me?.display_name ?? ctx.email ?? "";
  const vars: InviteVars = { me, contact: mv.contact_name, company: mv.company_name, studio: ctx.crm.settings?.studio_name as string | undefined, notes: mv.notes };
  const emails = [mv.contact_email, ...(mv.attendees ?? []), ...(o.extra_attendees ?? [])].filter((x: unknown) => typeof x === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x as string)) as string[];
  const start = new Date(mv.scheduled_at);
  return await createEvent(ctx, {
    account: o.account, title: o.title || inviteTitle(ctx.crm.settings, vars), start: start.toISOString(), duration_min: mv.duration_min ?? DEFAULT_DURATION_MIN,
    attendees: emails, description: inviteDescription(ctx.crm.settings, vars) || undefined,
    meet: o.meet ?? true, notify: o.notify ?? "all", meeting_id: meetingId, allow_duplicate: false,
  });
}

/** After update_meeting: move / cancel the linked Google event to match. Best effort — returns a note, never throws. */
export async function syncMeetingToEvent(ctx: Ctx, meetingId: string, changes: { scheduled_at?: string | null; duration_min?: number | null; status?: string | null; attendees?: string[] | null }): Promise<string | undefined> {
  try {
    const { data: link } = await ctx.user.from("crm_meeting_calendar_events").select("event_id, account_id, calendar_id").eq("meeting_id", meetingId).maybeSingle();
    const l = link as Row | null;
    if (!l?.account_id) return undefined;
    const all = await listAccounts(ctx);
    const a = all.find((x) => x.id === l.account_id);
    if (!a) return "The linked Google event belongs to a disconnected account; it was not changed.";
    if (!a.mine) return `The linked Google event is on ${a.email} (${a.member_name}); only they can change it.`;
    if (changes.status === "cancelled") {
      await gapi(a.id, "DELETE", `${calPath(l.calendar_id || "primary")}/${encodeURIComponent(l.event_id)}?sendUpdates=all`);
      await ctx.user.rpc("crm_unlink_calendar_event", { p_meeting_id: meetingId });
      return "The Google event was cancelled too (guests notified).";
    }
    if (changes.scheduled_at || changes.duration_min || changes.attendees) {
      const { data: m } = await ctx.user.from("crm_meetings_v").select("scheduled_at, duration_min, attendees, contact_email").eq("id", meetingId).single();
      const mv = m as Row;
      const patch: Row = {};
      if (changes.scheduled_at || changes.duration_min) { const s = new Date(mv.scheduled_at), e = new Date(s.getTime() + (mv.duration_min ?? DEFAULT_DURATION_MIN) * 60000); patch.start = { dateTime: s.toISOString() }; patch.end = { dateTime: e.toISOString() }; }
      if (changes.attendees) { const emails = [mv.contact_email, ...(mv.attendees ?? [])].filter((x: unknown) => typeof x === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x as string) && (x as string).toLowerCase() !== a.email) as string[]; patch.attendees = emails.map((email) => ({ email })); }
      const updated = await gapi(a.id, "PATCH", `${calPath(l.calendar_id || "primary")}/${encodeURIComponent(l.event_id)}?sendUpdates=all`, patch);
      const row = summarize(updated, tzFor(ctx, a), a, l.calendar_id || "primary");
      await linkEvent(ctx, meetingId, a, l.calendar_id || "primary", updated, row);
      return `The Google event was moved to ${row.when} (guests notified).`;
    }
    return undefined;
  } catch (e) {
    log({ fn: "crm-mcp", calendar: "sync", warn: "failed", error: String(e) });
    return `The CRM meeting changed but the Google event could not be updated: ${e instanceof Error ? e.message : String(e)}`;
  }
}
