// Typed Unipile client (subset used by the outreach platform).
// Base: https://{DSN}/api/v1 ; header X-API-KEY.
import { log } from "./supabase.ts";

const DSN = (Deno.env.get("UNIPILE_DSN") ?? "").replace(/\/+$/, "");
const API_KEY = Deno.env.get("UNIPILE_API_KEY") ?? "";
// White-label hosted-auth domain (optional): a CNAME such as auth.yourapp.com -> account.unipile.com, validated by Unipile support.
// When set, every hosted-auth URL is rewritten to this host before it reaches a user, so the provider is never visible.
const HOSTED_AUTH_DOMAIN = (Deno.env.get("OUTREACH_HOSTED_AUTH_DOMAIN") ?? "").replace(/^https?:\/\//, "").replace(/\/+$/, "").trim();
// Name shown by the browser extension (UniLogin) when a user approves access; also the tab label.
export const APP_NAME = (Deno.env.get("OUTREACH_APP_NAME") ?? "Outreach").trim().slice(0, 60);

export function unipileConfigured(): boolean { return !!DSN && !!API_KEY; }
export function unipileBase(): string { return DSN.startsWith("http") ? DSN : `https://${DSN}`; }
export function hostedAuthDomain(): string | null { return HOSTED_AUTH_DOMAIN || null; }

/** Rewrite the hosted-auth URL onto the white-label domain when one is configured (docs: "Custom Domain URL"). */
export function hostedAuthUrl(url: string): string {
  if (!HOSTED_AUTH_DOMAIN) return url;
  try { const u = new URL(url); u.host = HOSTED_AUTH_DOMAIN; return u.toString(); } catch { return url; }
}

/** Options for the "signed-in browser" connection method (UniLogin): the wizard connects the LinkedIn account already
 *  logged in to the user's browser through a store extension; we receive an account id, never cookies. */
export function hostedBrowserOptions(): Pick<HostedLinkInput, "unilogin" | "disabled_options"> {
  return { unilogin: { publisher_name: APP_NAME, tab_name: `Connect to ${APP_NAME}`.slice(0, 60) }, disabled_options: ["credentials_auth", "cookie_auth"] };
}

export class UnipileError extends Error {
  status: number;
  type: string;         // e.g. errors/cannot_resend_yet
  code: string;         // short: cannot_resend_yet
  body: unknown;
  network: boolean;
  constructor(status: number, type: string, detail: string, body: unknown, network = false) {
    super(detail || type || `unipile ${status}`);
    this.status = status;
    this.type = type;
    this.code = (type || "").replace(/^errors\//, "") || (network ? "network" : `http_${status}`);
    this.body = body;
    this.network = network;
  }
}

export interface ReqOpts { method?: string; query?: Record<string, unknown>; body?: unknown; form?: FormData; timeoutMs?: number; retries?: number; raw?: boolean; accountId?: string }

/** Low-level request. Exported so new call sites (lead sources, enrichment) can add endpoints without editing this file's typed client. */
export async function unipileRequest<T = any>(path: string, opts: ReqOpts = {}): Promise<T> { return request<T>(path, opts); }

async function request<T = any>(path: string, opts: ReqOpts = {}): Promise<T> {
  if (!unipileConfigured()) throw new UnipileError(503, "errors/not_configured", "UNIPILE_DSN / UNIPILE_API_KEY not set", null);
  const url = new URL(`${unipileBase()}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { for (const x of v) url.searchParams.append(k, String(x)); continue; }   // OpenAPI array params (linkedin_sections) are repeated
    url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "X-API-KEY": API_KEY, accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["content-type"] = "application/json"; body = JSON.stringify(opts.body); }
  const retries = opts.retries ?? 2;
  let attempt = 0;
  while (true) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
    try {
      const res = await fetch(url, { method: opts.method ?? "GET", headers, body, signal: ctrl.signal });
      clearTimeout(timer);
      log({ fn: "unipile", endpoint: `${opts.method ?? "GET"} ${path}`, account_id: opts.accountId, status: res.status, latency_ms: Date.now() - t0 });
      if (opts.raw) return res as unknown as T;
      const text = await res.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
      if (!res.ok) throw new UnipileError(res.status, data?.type ?? "", data?.detail ?? data?.title ?? text?.slice(0, 200), data);
      return data as T;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof UnipileError) throw e;
      // network / abort
      attempt++;
      log({ fn: "unipile", endpoint: path, network_error: String(e), attempt });
      if (attempt > retries) throw new UnipileError(0, "errors/network", String((e as any)?.message ?? e), null, true);
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
}

function form(fields: Record<string, unknown>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) { for (const x of v) f.append(k, x); continue; }
    if (v instanceof Blob) { f.append(k, v); continue; }
    if (typeof v === "object") { f.append(k, JSON.stringify(v)); continue; }
    f.append(k, String(v));
  }
  return f;
}

export interface HostedLinkInput {
  type: "create" | "reconnect";
  providers?: string[];
  expiresOn: string;
  notify_url?: string;
  name?: string;
  success_redirect_url?: string;
  failure_redirect_url?: string;
  reconnect_account?: string;
  disabled_features?: string[];
  disabled_options?: string[];
  bypass_success_screen?: boolean;
  proxy?: { protocol: string; host: string; port: number; username?: string; password?: string };
  sync_limit?: unknown;
  /** Present (even empty) = offer the browser-extension sign-in (UniLogin) after credentials/cookies. */
  unilogin?: { publisher_name?: string; tab_name?: string; track_last_visited_page?: boolean };
}

export const unipile = {
  hosted: {
    link: async (input: HostedLinkInput) => {
      const r = await request<{ object: string; url: string }>("/hosted/accounts/link", { method: "POST", body: { ...input, api_url: unipileBase() } });
      return { ...r, url: hostedAuthUrl(r.url) };
    },
  },
  accounts: {
    list: () => request<{ items: any[] }>("/accounts", { query: { limit: 250 } }),
    get: (id: string) => request<any>(`/accounts/${encodeURIComponent(id)}`, { accountId: id }),
    delete: (id: string) => request<any>(`/accounts/${encodeURIComponent(id)}`, { method: "DELETE", accountId: id }),
    resync: (id: string) => request<any>(`/accounts/${encodeURIComponent(id)}/sync`, { accountId: id, timeoutMs: 30000 }),
    reconnect: (id: string, body: Record<string, unknown>) => request<any>(`/accounts/${encodeURIComponent(id)}`, { method: "POST", body, accountId: id, timeoutMs: 60000, retries: 0 }),
    patch: (id: string, body: Record<string, unknown>) => request<any>(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body, accountId: id }),
    solveCheckpoint: (body: { provider: string; account_id: string; code: string }) => request<any>("/accounts/checkpoint", { method: "POST", body, timeoutMs: 60000, retries: 0 }),
  },
  users: {
    me: (accountId: string) => request<any>("/users/me", { query: { account_id: accountId }, accountId }),
    // linkedin_sections: "*_preview" (cheap) or the named full sections we store (FULL_PROFILE_SECTIONS). Never "*": LinkedIn throttles it.
    profile: (accountId: string, identifier: string, q: { notify?: boolean; linkedin_api?: string; linkedin_sections?: string | string[] } = {}) =>
      request<any>(`/users/${encodeURIComponent(identifier)}`, { query: { account_id: accountId, ...q }, accountId, timeoutMs: 30000 }),
    invite: (body: { account_id: string; provider_id: string; message?: string; user_email?: string }) => request<{ invitation_id: string; usage?: number }>("/users/invite", { method: "POST", body, accountId: body.account_id, retries: 0 }),
    cancelInvite: (accountId: string, invitationId: string) => request<any>(`/users/invite/sent/${encodeURIComponent(invitationId)}`, { method: "DELETE", query: { account_id: accountId }, accountId, retries: 0 }),
    invitationsSent: (accountId: string, cursor?: string, limit = 100) => request<{ items: any[]; cursor: string | null }>("/users/invite/sent", { query: { account_id: accountId, cursor, limit }, accountId }),
    relations: (accountId: string, cursor?: string, limit = 100) => request<{ items: any[]; cursor: string | null }>("/users/relations", { query: { account_id: accountId, cursor, limit }, accountId }),
    posts: (accountId: string, identifier: string, limit = 5) => request<{ items: any[]; cursor: string | null }>(`/users/${encodeURIComponent(identifier)}/posts`, { query: { account_id: accountId, limit }, accountId }),
    // Instagram: the account's own followers / following, newest first, at most 25 per page. Items {id, username, name, profile_picture_url, is_private, is_verified}.
    followers: (accountId: string, q: { user_id?: string; cursor?: string; limit?: number } = {}) => request<{ items: any[]; cursor: string | null }>("/users/followers", { query: { account_id: accountId, limit: 25, ...q }, accountId }),
    following: (accountId: string, q: { user_id?: string; cursor?: string; limit?: number } = {}) => request<{ items: any[]; cursor: string | null }>("/users/following", { query: { account_id: accountId, limit: 25, ...q }, accountId }),
    // Instagram: following someone is POST /users/invite with the user's id or username as provider_id (LinkedIn has no follow endpoint).
    follow: (accountId: string, identifier: string) => request<any>("/users/invite", { method: "POST", body: { account_id: accountId, provider_id: identifier }, accountId, retries: 0 }),
    // Edit own profile (Profile Studio). The multipart body comes ONLY from profile_serialiser.ts; never retried (identity endpoint).
    editProfile: (accountId: string, form: FormData) => request<{ object: string }>("/users/me/edit", { method: "PATCH", form, accountId, retries: 0, timeoutMs: 60000 }),
  },
  linkedin: {
    endorse: (body: { account_id: string; profile_id: string; skill_endorsement_id: number }) => request<any>("/linkedin/profile/endorse", { method: "POST", body, accountId: body.account_id, retries: 0 }),
    search: (accountId: string, body: Record<string, unknown>, q: { cursor?: string; limit?: number } = {}) => request<any>("/linkedin/search", { method: "POST", body, query: { account_id: accountId, ...q }, accountId, timeoutMs: 45000, retries: 0 }),
    inmailBalance: (accountId: string) => request<any>("/linkedin/inmail_balance", { query: { account_id: accountId }, accountId }),
    company: (accountId: string, identifier: string) => request<any>(`/linkedin/company/${encodeURIComponent(identifier)}`, { query: { account_id: accountId }, accountId }),
  },
  posts: {
    react: (body: { account_id: string; post_id: string; reaction_type?: string }) => request<any>("/posts/reaction", { method: "POST", body, accountId: body.account_id, retries: 0 }),
    comment: (postId: string, fields: { account_id: string; text: string }) => request<any>(`/posts/${encodeURIComponent(postId)}/comments`, { method: "POST", form: form(fields), accountId: fields.account_id, retries: 0 }),
  },
  chats: {
    list: (accountId: string, q: { cursor?: string; limit?: number; after?: string; before?: string } = {}) => request<{ items: any[]; cursor: string | null }>("/chats", { query: { account_id: accountId, limit: 100, ...q }, accountId }),
    get: (chatId: string) => request<any>(`/chats/${encodeURIComponent(chatId)}`),
    // Messaging data only (no LinkedIn profile view is triggered).
    attendees: (chatId: string) => request<{ items: any[] }>(`/chats/${encodeURIComponent(chatId)}/attendees`),
    // voice_message: (LinkedIn | WhatsApp) a file sent as a voice note; LinkedIn prefers .m4a. Pass a File so the name/extension survives.
    start: (fields: { account_id: string; attendees_ids: string[]; text?: string; subject?: string; linkedin?: Record<string, unknown>; voice_message?: Blob }) =>
      request<{ chat_id: string | null; message_id: string | null }>("/chats", { method: "POST", form: form(fields), accountId: fields.account_id, retries: 0, timeoutMs: 30000 }),
    messages: (chatId: string, q: { cursor?: string; limit?: number; after?: string } = {}) => request<{ items: any[]; cursor: string | null }>(`/chats/${encodeURIComponent(chatId)}/messages`, { query: { limit: 100, ...q } }),
    send: (chatId: string, fields: { account_id?: string; text?: string; attachments?: Blob[]; voice_message?: Blob }) => {
      const f = form({ account_id: fields.account_id, text: fields.text, voice_message: fields.voice_message });
      for (const a of fields.attachments ?? []) f.append("attachments", a);
      return request<{ message_id: string | null }>(`/chats/${encodeURIComponent(chatId)}/messages`, { method: "POST", form: f, accountId: fields.account_id, retries: 0, timeoutMs: 30000 });
    },
  },
  messages: {
    edit: (messageId: string, text: string) => request<any>(`/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: { text }, retries: 0 }),
    delete: (messageId: string) => request<any>(`/messages/${encodeURIComponent(messageId)}`, { method: "DELETE", retries: 0 }),
    attachment: (messageId: string, attachmentId: string) => request<Response>(`/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`, { raw: true, timeoutMs: 60000 }),
  },
  mails: {
    // custom_headers: Unipile only accepts names starting with X- plus List-Unsubscribe, List-Unsubscribe-Post, Reply-To, Content-Type.
    send: (fields: { account_id: string; to: Array<{ identifier: string; display_name?: string }>; cc?: Array<{ identifier: string; display_name?: string }>; bcc?: Array<{ identifier: string; display_name?: string }>; subject?: string; body: string; reply_to?: string; tracking_options?: Record<string, unknown>; from?: Record<string, unknown>; custom_headers?: Array<{ name: string; value: string }> }) =>
      request<{ tracking_id: string; provider_id: string | null }>("/emails", { method: "POST", form: form(fields), accountId: fields.account_id, retries: 0, timeoutMs: 30000 }),
    list: (accountId: string, q: Record<string, unknown> = {}) => request<{ items: any[]; cursor: string | null }>("/emails", { query: { account_id: accountId, limit: 50, ...q }, accountId }),
    get: (emailId: string, accountId?: string) => request<any>(`/emails/${encodeURIComponent(emailId)}`, { query: { account_id: accountId } }),
    attachment: (emailId: string, attachmentId: string, accountId?: string) => request<Response>(`/emails/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`, { raw: true, query: { account_id: accountId }, timeoutMs: 60000 }),
  },
  webhooks: {
    list: () => request<{ items: any[] }>("/webhooks"),
    create: (body: Record<string, unknown>) => request<{ webhook_id: string }>("/webhooks", { method: "POST", body }),
    delete: (id: string) => request<any>(`/webhooks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  },
};

/** The full profile sections enrichment stores (item 13). Named sections, never "*". */
export const FULL_PROFILE_SECTIONS = ["about", "experience", "education", "skills", "languages"] as const;
export const PREVIEW_SECTIONS = "*_preview";

/** Normalise LinkedIn network distance strings to our relation enum. */
export function distanceToRelation(d: unknown): "first" | "none" | null {
  const s = String(d ?? "").toUpperCase();
  if (!s) return null;
  if (s.includes("FIRST") || s === "DISTANCE_1" || s === "1") return "first";
  if (s.includes("SELF")) return null;
  return "none";
}

export function invitationPending(profile: any): boolean {
  const inv = profile?.invitation;
  if (!inv) return !!profile?.pending_invitation;
  const st = String(inv.status ?? "").toUpperCase();
  return st.includes("PENDING") || st === "SENT";
}
