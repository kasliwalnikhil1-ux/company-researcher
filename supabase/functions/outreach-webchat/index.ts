// outreach-webchat — the PUBLIC widget API (web-chat-PRD.md §13.1). Deployed --no-verify-jwt: every request is
// authenticated here, never by the gateway:
//   1. website token (?token= or x-website-token)  → inbox; 2. Origin ∈ inbox allowed domains (403, no body otherwise);
//   3. visitor token (Authorization: Bearer <HS256 JWT minted by /visitor>) for everything after /config and /visitor;
//   4. rate limits per IP and per inbox here, per visitor inside the SQL functions.
// Every SQL call goes through outreach_webchat_v_* functions that take explicit ids and re-check ownership (051).
//
// Routes (path after /outreach-webchat):
//   GET  /config?token=                         POST /visitor            POST /visitor/identify      PATCH /visitor/attributes
//   POST /visitor/reset                         POST /page-view          POST /events
//   GET  /conversations                         POST /conversations      GET  /conversations/:id     GET  /conversations/:id/messages
//   POST /conversations/:id/messages            POST /conversations/:id/typing|read|heartbeat|resolve|csat|transcript
//   POST /conversations/:id/voice/start|turns|switch|end   (voice calls with the website agent; docs/outreach/WEBCHAT.md "Voice")
//   GET  /conversations/:id/transcript          (every message, for the widget's "Download transcript")
//   POST /uploads                               GET  /attachments/:conversation/:attachment
//   POST /chat  (SSE: meta, token, products, done)   POST /feedback      POST /campaigns/:id/hit
//   GET  /continuity/stop?t=                    GET  /resume?t=  (standalone page deep link from continuity emails)
import { admin, ANON_KEY, CORS, HttpError, json, log, rateLimit, readJson, rpc, serve, SUPABASE_URL, timingSafeEqual, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { hmacSha256Hex } from "../_shared/outreach/crypto.ts";
import { elAccount, ElError, logEl } from "../_shared/outreach/elevenlabs.ts";
import { dv, mintCallToken, mintSession, todayIn } from "../_shared/outreach/voice.ts";
import { buildAnswerPrompt, clientIp, parseAnswer, pickCards, recommendProducts, requestMeta, retrieveForInbox, sanitizeQuery, sendTranscript, signVisitorToken, stripCardLinks, streamAnswer, verifyResumeToken, verifyVisitorToken, writeSuggestion, type AiContext, type ProductCard } from "../_shared/outreach/webchat.ts";

const FN = "outreach-webchat";
const API_VERSION = "1.0.0";
const REALTIME_URL = SUPABASE_URL.replace(/^http/, "ws") + "/realtime/v1/websocket";
const TURNSTILE_SECRET = Deno.env.get("OUTREACH_TURNSTILE_SECRET") ?? "";
// One platform secret pairs with one Cloudflare widget, so its site key is the default for every inbox that sets none.
const TURNSTILE_SITE_KEY = Deno.env.get("OUTREACH_TURNSTILE_SITE_KEY") ?? "";
const TURNSTILE_ACTION = "webchat_start";   // the widget renders with this action; siteverify echoes it
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|jar|vbs|dll|apk|dmg|pkg|deb|rpm|html?|svg)$/i;

// How a conversation started (outreach_chats.source): the launcher and its nudges, the site's own buttons / inputs / links
// and the Ask AI buttons the widget places (web-chat-buttons-products-changes.md §2–§4).
const SOURCES = ["launcher", "popup", "campaign", "sdk", "standalone", "email", "button", "ask", "input", "link", "header_button", "element_button", "selection", "voice"];   // voice: the conversation began with a call
/** A short text field from the widget: trimmed, control characters out, cut to `max`; null when empty. */
function textField(v: unknown, max: number): string | null {
  const s = typeof v === "string" ? [...v].filter((ch) => ch === "\n" || ch === "\t" || ch.charCodeAt(0) >= 32).join("").trim().slice(0, max) : "";
  return s || null;
}

interface Inbox { id: string; workspace_id: string; is_active: boolean; enforce_identity: boolean; hmac_token: string; settings: Record<string, any>; website_token: string }
const inboxCache = new Map<string, { at: number; inbox: Inbox | null }>();

async function inboxByToken(token: string): Promise<Inbox | null> {
  const hit = inboxCache.get(token);
  if (hit && Date.now() - hit.at < 30_000) return hit.inbox;
  const { data } = await admin.from("outreach_webchat_inboxes").select("id, workspace_id, is_active, enforce_identity, hmac_token, settings, website_token").eq("website_token", token).is("deleted_at", null).maybeSingle();
  const inbox = (data as Inbox | null) ?? null;
  inboxCache.set(token, { at: Date.now(), inbox });
  return inbox;
}

function originOf(req: Request): string {
  const o = req.headers.get("origin");
  if (o) return o;
  // same-origin GETs (the standalone page) carry no Origin: fall back to the Referer's origin
  try { const r = req.headers.get("referer"); if (r) return new URL(r).origin; } catch { /* ignore */ }
  return "";
}

/** Website token + Origin → inbox, or a bodiless 403 / 404 (PRD §7: unknown origin → 403, no body). */
async function requireInbox(req: Request, url: URL): Promise<{ inbox: Inbox; origin: string }> {
  const token = url.searchParams.get("token") ?? req.headers.get("x-website-token") ?? "";
  if (!/^[a-f0-9]{16,64}$/i.test(token)) throw new HttpError(404, "E_NOT_FOUND", "unknown website token");
  const inbox = await inboxByToken(token);
  if (!inbox) throw new HttpError(404, "E_NOT_FOUND", "unknown website token");
  const origin = originOf(req);
  const platform = origin && origin === WEB_ORIGIN;   // the hosted standalone page
  if (!platform) {
    const ok = await rpc<boolean>("webchat__origin_ok", { p_inbox: inbox.id, p_origin: origin });
    if (!ok) throw new HttpError(403, "E_FORBIDDEN", "");
  }
  return { inbox, origin };
}

async function requireVisitor(req: Request, inbox: Inbox): Promise<{ vid: string; tv: number }> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const claims = await verifyVisitorToken(token);
  if (!claims || claims.ib !== inbox.id) throw new HttpError(401, "E_VISITOR_TOKEN", "visitor token missing or invalid");
  return { vid: claims.vid, tv: claims.tv };
}

async function ipLimits(req: Request, inbox: Inbox): Promise<void> {
  const rl = inbox.settings?.security?.rate_limits ?? {};
  const ip = await hmacSha256Hex(inbox.id, clientIp(req));
  await rateLimit(`webchat:ip:${ip}:1m`, Number(rl.ip_1m ?? 20), 60);
  await rateLimit(`webchat:ip:${ip}:1h`, Number(rl.ip_1h ?? 300), 3600);
  await rateLimit(`webchat:i:${inbox.id}:1m`, Number(rl.inbox_1m ?? 2000), 60);
}

function sse(event: string, data: unknown): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** Effective Turnstile site key for an inbox (its own, else the platform's). */
function turnstileSiteKey(inbox: Inbox): string { return String(inbox.settings?.security?.turnstile_site_key ?? "") || TURNSTILE_SITE_KEY; }
/** The check is enforced only when the widget can actually run it: toggle on, a site key to render, a secret to verify. */
function turnstileRequired(inbox: Inbox): boolean { return !!inbox.settings?.security?.turnstile_enabled && !!TURNSTILE_SECRET && !!turnstileSiteKey(inbox); }

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!token || typeof token !== "string" || token.length > 2048) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }), signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    if (!j?.success) { log({ fn: FN, warn: "turnstile rejected", codes: j?.["error-codes"] ?? [] }); return false; }
    if (j.action && j.action !== TURNSTILE_ACTION) return false;   // minted for something other than starting a chat
    return true;
  } catch (e) { log({ fn: FN, warn: "turnstile siteverify failed", error: String((e as any)?.message ?? e) }); return false; }
}

/** Work that outlives the response: the runtime keeps the instance alive for it when it can. */
function background(p: Promise<unknown>): void {
  const rt = (globalThis as any).EdgeRuntime;
  if (rt && typeof rt.waitUntil === "function") rt.waitUntil(p); else p.catch(() => {});
}

function safeName(n: string): string { return String(n ?? "file").replace(/[^\w.\-]+/g, "_").slice(0, 120); }

serve(FN, async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/outreach-webchat/, "").replace(/\/+$/, "") || "/";
  const m = req.method;

  // ---------------------------------------------------------------- unauthenticated: continuity stop link, resume link
  if (m === "GET" && path === "/continuity/stop") {
    const t = await verifyResumeToken(url.searchParams.get("t") ?? "");
    if (!t) return new Response("This link has expired.", { status: 400, headers: { "content-type": "text/plain" } });
    await admin.from("outreach_chats").update({ continuity_stopped: true }).eq("id", t.chatId).eq("visitor_id", t.visitorId);
    return new Response("<!doctype html><meta charset=utf-8><body style='font:16px system-ui;padding:40px'>You will no longer receive email updates for this conversation.</body>", { headers: { "content-type": "text/html" } });
  }

  const { inbox, origin } = await requireInbox(req, url);

  // ---------------------------------------------------------------- GET /config
  if (m === "GET" && path === "/config") {
    const cfg = await rpc<any>("webchat_public_config", { p_token: inbox.website_token, p_origin: origin === WEB_ORIGIN ? "" : origin });
    if (cfg?.error === "origin" && origin === WEB_ORIGIN) { /* platform page: allowed */ }
    else if (cfg?.error === "origin") throw new HttpError(403, "E_FORBIDDEN", "");
    if (cfg?.error === "not_found") throw new HttpError(404, "E_NOT_FOUND", "unknown website token");
    if (cfg?.error === "inactive") return json({ ok: false, error: "inactive" }, 200, { "cache-control": "public, max-age=60", vary: "Origin" });
    if (origin && origin !== WEB_ORIGIN) rpc("webchat_public_install_seen", { p_inbox: inbox.id, p_origin: origin }).catch(() => {});
    const full = cfg?.ok ? cfg : await rpc<any>("webchat_public_config", { p_token: inbox.website_token, p_origin: WEB_ORIGIN });
    delete full.hmac_token;
    // Turnstile: fill in the platform site key, and never tell the widget to challenge visitors this server cannot verify.
    if (full.security && typeof full.security === "object") {
      full.security.turnstile_site_key = turnstileSiteKey(inbox) || null;
      full.security.turnstile_enabled = turnstileRequired(inbox);
    }
    return json({ ...full, api_version: API_VERSION, realtime: { url: REALTIME_URL, anon_key: ANON_KEY } }, 200, { "cache-control": "public, max-age=300", vary: "Origin" });
  }

  // the live transcript of a call is many small posts: it has its own limit per call (SQL), not the per-IP one
  if (!(m === "POST" && /\/voice\/turns$/.test(path))) await ipLimits(req, inbox);
  if (!inbox.is_active) throw new HttpError(403, "E_INACTIVE", "widget is off");

  // ---------------------------------------------------------------- GET /resume?t=  (standalone page after a continuity email)
  if (m === "GET" && path === "/resume") {
    const t = await verifyResumeToken(url.searchParams.get("t") ?? "");
    if (!t) throw new HttpError(400, "E_EXPIRED", "link expired");
    const { data: v } = await admin.from("outreach_webchat_visitors").select("id, token_version, inbox_id, merged_into").eq("id", t.visitorId).maybeSingle();
    if (!v || v.inbox_id !== inbox.id) throw new HttpError(404, "E_NOT_FOUND", "visitor");
    const vid = v.merged_into ?? v.id;
    const token = await signVisitorToken({ vid, ib: inbox.id, ws: inbox.workspace_id, tv: v.token_version });
    return json({ visitor_token: token, conversation_id: t.chatId });
  }

  // ---------------------------------------------------------------- POST /visitor  (create / restore)
  if (m === "POST" && path === "/visitor") {
    const body = await readJson<any>(req);
    const prior = await verifyVisitorToken(body.visitor_token);
    const meta = { ...(await requestMeta(req, inbox.id)), locale: String(body.locale ?? "").slice(0, 10) || null, timezone: String(body.timezone ?? "").slice(0, 60) || null,
      referrer: body.referrer ?? null, landing_url: body.landing_url ?? body.page?.url ?? null, utm: body.utm ?? null };
    const r = await rpc<any>("webchat_v_visitor", { p_inbox: inbox.id, p_visitor: prior?.ib === inbox.id ? prior.vid : null, p_token_version: prior?.ib === inbox.id ? prior.tv : null, p_meta: meta });
    const v = r.visitor;
    const token = await signVisitorToken({ vid: v.id, ib: inbox.id, ws: inbox.workspace_id, tv: v.token_version });
    if (body.page?.url) rpc("webchat_v_page_views", { p_visitor: v.id, p_views: [{ url: body.page.url, title: body.page.title, referrer: body.referrer, utm: body.utm, at: new Date().toISOString() }] }).catch(() => {});
    return json({ visitor_token: token, visitor: v, conversations: r.conversations, blocked: r.blocked });
  }

  const { vid } = await requireVisitor(req, inbox);

  // ---------------------------------------------------------------- visitor identity, attributes, tracking
  if (m === "POST" && path === "/visitor/identify") {
    const b = await readJson<any>(req);
    const identifier = b.identifier == null ? null : String(b.identifier).slice(0, 200);
    let verified = false;
    if (identifier && b.identifier_hash) {
      const expected = await hmacSha256Hex(inbox.hmac_token, identifier);
      verified = timingSafeEqual(String(b.identifier_hash).toLowerCase(), expected.toLowerCase());
      if (!verified) { log({ fn: FN, warn: "identity hash mismatch", inbox: inbox.id }); throw new HttpError(401, "E_IDENTITY_INVALID", "identifier_hash does not match"); }
    }
    if (inbox.enforce_identity && identifier && !verified) throw new HttpError(401, "E_IDENTITY_INVALID", "identity validation is enforced: identifier_hash required");
    const attrs = { name: b.name, email: b.email, phone: b.phone ?? b.phone_number, avatar_url: b.avatar_url, company: b.company ?? b.company_name, custom_attributes: b.custom_attributes ?? {} };
    const r = await rpc<any>("webchat_v_identify", { p_inbox: inbox.id, p_visitor: vid, p_identifier: identifier, p_verified: verified, p_attrs: attrs });
    const v = r.visitor;
    const token = v.id !== vid || r.changed ? await signVisitorToken({ vid: v.id, ib: inbox.id, ws: inbox.workspace_id, tv: v.token_version }) : null;
    return json({ visitor: v, verified, conversations: r.conversations, ...(token ? { visitor_token: token } : {}) });
  }
  if (m === "PATCH" && path === "/visitor/attributes") {
    const b = await readJson<any>(req);
    await rpc("webchat_v_attrs", { p_visitor: vid, p_chat: b.conversation_id ?? null, p_custom: b.custom_attributes ?? null, p_delete: b.delete ?? null, p_conv_custom: b.conversation_custom_attributes ?? null, p_conv_delete: b.conversation_delete ?? null, p_add_labels: b.add_labels ?? null, p_remove_labels: b.remove_labels ?? null });
    return json({ ok: true });
  }
  if (m === "POST" && path === "/visitor/reset") { await rpc("webchat_v_reset", { p_visitor: vid }); return json({ ok: true }); }
  if (m === "POST" && path === "/page-view") {
    const b = await readJson<any>(req);
    await rpc("webchat_v_page_views", { p_visitor: vid, p_views: Array.isArray(b.views) ? b.views.slice(0, 50) : [] });
    return json({ ok: true });
  }
  if (m === "POST" && path === "/events") {
    const b = await readJson<any>(req);
    await rateLimit(`webchat:ev:${vid}`, 60, 60);
    await rpc("webchat_v_event", { p_visitor: vid, p_chat: b.conversation_id ?? null, p_name: String(b.name ?? "").slice(0, 100), p_props: b.props ?? {} });
    return json({ ok: true });
  }
  if (m === "POST" && path === "/feedback") {
    const b = await readJson<any>(req);
    await rpc("webchat_v_feedback", { p_visitor: vid, p_turn: b.turn_id, p_value: Number(b.value) >= 0 ? 1 : -1, p_text: b.text ?? null });
    return json({ ok: true });
  }
  const camp = path.match(/^\/campaigns\/([0-9a-f-]{36})\/hit$/);
  if (m === "POST" && camp) {
    const b = await readJson<any>(req);
    await rpc("webchat_v_campaign_hit", { p_inbox: inbox.id, p_campaign: camp[1], p_kind: ["shown", "clicked", "started"].includes(b.kind) ? b.kind : "shown", p_visitor: vid });
    return json({ ok: true });
  }

  // ---------------------------------------------------------------- conversations
  if (m === "GET" && path === "/conversations") return json({ conversations: await rpc("webchat_v_conversations", { p_visitor: vid }) });
  if (m === "POST" && path === "/conversations") {
    const b = await readJson<any>(req);
    await rateLimit(`webchat:cs:${vid}`, 10, 600);
    if (turnstileRequired(inbox) && !(await verifyTurnstile(b.turnstile_token, clientIp(req)))) throw new HttpError(403, "E_TURNSTILE", "verification failed");
    const r = await rpc<any>("webchat_v_conversation_start", { p_inbox: inbox.id, p_visitor: vid, p_form: b.form ?? null, p_source: SOURCES.includes(b.source) ? b.source : "launcher", p_page: b.page ?? null });
    return json(r);
  }
  const conv = path.match(/^\/conversations\/([0-9a-f-]{36})(?:\/([a-z]+(?:\/[a-z]+)?))?$/);
  if (conv) {
    const chat = conv[1], action = conv[2] ?? "";
    if (m === "GET" && !action) return json({ conversation: await rpc("webchat_v_conversation", { p_visitor: vid, p_chat: chat }) });
    if (m === "GET" && action === "messages") {
      const messages = await rpc("webchat_v_messages", { p_visitor: vid, p_chat: chat, p_before: url.searchParams.get("before"), p_after: url.searchParams.get("after"), p_limit: Number(url.searchParams.get("limit") ?? 50) });
      return json({ messages });
    }
    if (m === "POST" && action === "messages") {
      const b = await readJson<any>(req);
      // attachments: ids from /uploads, owned by this visitor, not yet attached
      let attachments: unknown[] = [];
      if (Array.isArray(b.attachments) && b.attachments.length) {
        const ids = b.attachments.map((x: unknown) => String(x)).slice(0, 5);
        const { data: ups } = await admin.from("outreach_webchat_uploads").select("id, path, name, mime, size").in("id", ids).eq("visitor_id", vid).is("message_id", null);
        attachments = (ups ?? []).map((u) => ({ id: u.path, name: u.name, type: u.mime, size: u.size, storage: true }));
        if (!attachments.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "attachments not found");
      }
      // The visitor's own attributes are form answers and nothing else: `products`, `items`, `ai` … on a visitor message
      // would be drawn as cards and links in the agent's inbox. `internal` is written here only: what the button the
      // visitor clicked said about the question (context) and the product the page names; it never goes back to the widget.
      const given = b.content_attributes && typeof b.content_attributes === "object" ? b.content_attributes : {};
      const attrs: Record<string, unknown> = {};
      for (const k of ["form", "values", "message_id"]) if (given[k] !== undefined) attrs[k] = given[k];
      const context = textField(b.context, 700), product = textField(b.product, 300);
      if (context || product) attrs.internal = { ...(context ? { context } : {}), ...(product ? { product } : {}) };
      const r = await rpc<any>("webchat_v_message", { p_visitor: vid, p_chat: chat, p_echo: b.echo_id ? String(b.echo_id).slice(0, 64) : null, p_text: b.text ?? null, p_attachments: attachments, p_content_type: b.content_type ?? "text", p_attrs: attrs, p_source: "widget" });
      // Review mode (docs/outreach/AI-HUB.md §6): the assistant writes a suggestion for the agent once this response has
      // gone out. The widget is told nothing about it (to the visitor the chat is a live chat); the cron worker finishes
      // the suggestion if this instance is shut down first.
      const suggest: string | null = r?.suggest ?? null;
      if (r && typeof r === "object") delete r.suggest;
      if (suggest) background(writeSuggestion(suggest));
      return json(r);
    }
    if (m === "POST" && action === "typing") { const b = await readJson<any>(req); await rpc("webchat_v_typing", { p_visitor: vid, p_chat: chat, p_on: !!b.on, p_preview: b.preview ?? null }); return json({ ok: true }); }
    if (m === "POST" && action === "read") { await rpc("webchat_v_read", { p_visitor: vid, p_chat: chat }); return json({ ok: true }); }
    if (m === "POST" && action === "heartbeat") return json(await rpc("webchat_v_heartbeat", { p_visitor: vid, p_chat: chat }));
    if (m === "POST" && action === "resolve") return json({ conversation: await rpc("webchat_v_resolve", { p_visitor: vid, p_chat: chat }) });
    if (m === "POST" && action === "csat") { const b = await readJson<any>(req); return json({ conversation: await rpc("webchat_v_csat", { p_visitor: vid, p_chat: chat, p_rating: Number(b.rating), p_comment: b.comment ?? null }) }); }
    // ------------------------------------------------------------ voice (web-chat-voice-elevenlabs-PRD.md §5.4, §6, §7.1)
    // start: every check in SQL, then a conversation token from the voice provider; {ok:false, reason} keeps the widget in chat
    if (m === "POST" && action === "voice/start") {
      const b = await readJson<any>(req);
      await rateLimit(`webchat:vs:${vid}`, 12, 600);
      const page = b.page && typeof b.page === "object" ? { url: textField(b.page.url, 500), title: textField(b.page.title, 200) } : {};
      const s = await rpc<any>("webchat_v_voice_start", { p_visitor: vid, p_chat: chat, p_consent: b.consent === true, p_page: page });
      if (!s?.ok) return json({ ok: false, reason: s?.reason ?? "off" });
      let tok: { token: string; conversation_id: string };
      try { tok = await mintCallToken(await elAccount(s.workspace_id, s.account), s.el_agent_id, `visitor-${String(s.visitor_id).slice(0, 8)}`); }
      catch (e) { logEl(FN, e, { chat, step: "voice token" }); return json({ ok: false, reason: e instanceof ElError && e.status === 429 ? "busy" : "unavailable" }); }
      // the visitor's language when the agent speaks it; otherwise the agent's main language
      const want = String(b.locale ?? "").toLowerCase(), langs: string[] = Array.isArray(s.languages) ? s.languages : [];
      const language = langs.find((l) => l === want) ?? langs.find((l) => l === want.split("-")[0]) ?? null;
      const started = await rpc<any>("webchat_v_voice_started", { p_visitor: vid, p_chat: chat, p_el_conversation: tok.conversation_id, p_el_agent: s.el_agent_id, p_account: s.account,
        p_language: language ?? langs[0] ?? null, p_max_minutes: s.max_minutes, p_page_url: s.page_url || null });
      const session = await mintSession({ call_id: started.call_id, inbox_id: s.inbox_id, chat_id: chat, visitor_id: s.visitor_id, el_conversation_id: tok.conversation_id }, (Number(s.max_minutes) + 2) * 60);
      return json({ ok: true, call_id: started.call_id, conversation_token: tok.token, el_conversation_id: tok.conversation_id, max_minutes: s.max_minutes, ...(language ? { language } : {}),
        dynamic_variables: { brand: dv(s.brand, 80), page_title: dv(s.page_title, 200), page_url: dv(s.page_url, 500), visitor_name: dv(s.visitor_name, 80) || "not known yet",
          recent_chat: dv(s.recent_chat, 1500) || "nothing yet", today: todayIn(s.timezone), secret__session: session } });
    }
    if (m === "POST" && (action === "voice/turns" || action === "voice/switch" || action === "voice/end")) {
      const b = await readJson<any>(req);
      const call = String(b.call_id ?? "");
      if (!/^[0-9a-f-]{36}$/.test(call)) throw new HttpError(400, "E_PAYLOAD_INVALID", "call_id");
      if (action === "voice/turns") return json(await rpc("webchat_v_voice_turns", { p_visitor: vid, p_call: call, p_turns: Array.isArray(b.turns) ? b.turns.slice(0, 20) : [] }));
      if (action === "voice/switch") return json(await rpc("webchat_v_voice_switch", { p_visitor: vid, p_call: call, p_handoff: b.handoff === true, p_reason: textField(b.reason, 40) }));
      return json(await rpc("webchat_v_voice_end", { p_visitor: vid, p_call: call, p_reason: textField(b.reason, 40) }));
    }
    if (m === "GET" && action === "transcript") {
      // the whole conversation for the widget's "Download transcript": every message in the /messages shape, oldest first
      if (inbox.settings?.features?.transcript === false) throw new HttpError(403, "E_FORBIDDEN", "transcripts are off");
      await rateLimit(`webchat:trd:${chat}`, 6, 60);
      const all: any[] = [];
      let before: string | null = null;
      for (let page = 0; page < 25; page++) {
        const rows: any[] = (await rpc<any[]>("webchat_v_messages", { p_visitor: vid, p_chat: chat, p_before: before, p_after: null, p_limit: 200 })) ?? [];
        all.unshift(...rows);
        if (rows.length < 200) break;
        before = rows[0].sent_at;
      }
      return json({ messages: all });
    }
    if (m === "POST" && action === "transcript") {
      await rateLimit(`webchat:tr:${chat}`, 1, 15);
      if (!inbox.settings?.features?.transcript && inbox.settings?.features?.transcript !== undefined) throw new HttpError(403, "E_FORBIDDEN", "transcripts are off");
      const b = await readJson<any>(req);
      // the address typed in the widget becomes the visitor's email when they have none (same rule as the in-chat email
      // form, without posting a message: a resolved conversation must not reopen because someone asked for a copy)
      const em = String(b.email ?? "").trim().toLowerCase();
      if (em) {
        if (em.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpError(400, "E_PAYLOAD_INVALID", "email");
        await rpc("webchat_v_conversation", { p_visitor: vid, p_chat: chat });   // ownership
        const { data: ch } = await admin.from("outreach_chats").select("visitor_id").eq("id", chat).maybeSingle();
        if (ch?.visitor_id) {
          const { data: set } = await admin.from("outreach_webchat_visitors").update({ email: em, email_invalid: false }).eq("id", ch.visitor_id).is("email", null).select("id");
          if (set?.length) await rpc("webchat__link_lead", { p_visitor: ch.visitor_id, p_create: false }).catch((e) => log({ fn: FN, warn: "link_lead", error: String((e as any)?.message ?? e) }));
        }
      }
      const ok = await sendTranscript(chat, vid, "transcript");
      return json({ ok });
    }
  }

  // ---------------------------------------------------------------- uploads (PRD §7: allow list, 10 MB, executables blocked)
  if (m === "POST" && path === "/uploads") {
    const b = await readJson<any>(req);
    const feats = inbox.settings?.features ?? {}, sec = inbox.settings?.security?.attachments ?? {};
    if (feats.file_picker === false) throw new HttpError(403, "E_FORBIDDEN", "file uploads are off");
    const name = safeName(b.name), mime = String(b.type ?? "application/octet-stream").toLowerCase(), size = Number(b.size ?? 0);
    const maxBytes = Math.min(Number(sec.max_mb ?? 10), 10) * 1024 * 1024;
    if (!size || size > maxBytes) throw new HttpError(413, "E_TOO_LARGE", `max ${Math.round(maxBytes / 1048576)} MB`);
    if (BLOCKED_EXT.test(name)) throw new HttpError(415, "E_TYPE_BLOCKED", "this file type is not allowed");
    if (!(ALLOWED_MIME.has(mime) || (sec.allow_zip && mime === "application/zip"))) throw new HttpError(415, "E_TYPE_BLOCKED", "this file type is not allowed");
    await rateLimit(`webchat:up:${vid}`, 20, 600);
    const chat = String(b.conversation_id ?? "");
    await rpc("webchat_v_conversation", { p_visitor: vid, p_chat: chat });   // ownership check
    const pathKey = `${inbox.workspace_id}/${chat}/${crypto.randomUUID()}-${name}`;
    const { data: signed, error } = await admin.storage.from("outreach-webchat").createSignedUploadUrl(pathKey);
    if (error || !signed) throw new HttpError(500, "E_INTERNAL", error?.message ?? "upload url");
    const id = await rpc<string>("webchat_v_upload_register", { p_visitor: vid, p_chat: chat, p_path: pathKey, p_name: name, p_mime: mime, p_size: size });
    return json({ upload_id: id, url: signed.signedUrl, path: pathKey });
  }
  const att = path.match(/^\/attachments\/([0-9a-f-]{36})\/(.+)$/);
  if (m === "GET" && att) {
    const p = await rpc<string | null>("webchat_v_attachment_path", { p_visitor: vid, p_chat: att[1], p_attachment: decodeURIComponent(att[2]) });
    if (!p) throw new HttpError(404, "E_NOT_FOUND", "attachment");
    const bucket = p.includes("/voice/") || !p.startsWith(inbox.workspace_id) ? "outreach-attachments" : (await admin.storage.from("outreach-webchat").exists(p)).data ? "outreach-webchat" : "outreach-attachments";
    const { data, error } = await admin.storage.from(bucket).createSignedUrl(p, 600);
    if (error || !data) throw new HttpError(404, "E_NOT_FOUND", "attachment");
    return json({ url: data.signedUrl });
  }

  // ---------------------------------------------------------------- POST /chat  — AI answer as SSE
  if (m === "POST" && path === "/chat") {
    const b = await readJson<any>(req);
    const chat = String(b.conversation_id ?? ""), qid = String(b.message_id ?? "");
    await rpc("webchat_v_conversation", { p_visitor: vid, p_chat: chat });   // ownership
    const started = Date.now();
    const ctx = await rpc<AiContext>("webchat_v_ai_context", { p_chat: chat, p_message: qid });
    const headers = { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" };
    if (!ctx?.ok) return new Response(new ReadableStream({ start(c) { c.enqueue(sse("skip", { reason: "handled" })); c.close(); } }), { headers });
    const clean = sanitizeQuery(ctx.query);
    const jp = b.page?.product && typeof b.page.product === "object" ? b.page.product : null;   // the page's JSON-LD product
    const page = b.page && typeof b.page === "object" ? { url: String(b.page.url ?? "").slice(0, 2000), title: String(b.page.title ?? "").slice(0, 300), text: String(b.page.text ?? "").slice(0, 4000),
      product: jp ? { name: textField(jp.name, 200) ?? undefined, sku: textField(jp.sku, 120) ?? undefined, url: textField(jp.url, 300) ?? undefined } : null } : null;
    // what the button said about this question: stored with the message when it was sent; the request may repeat it
    const context = ctx.context ?? textField(b.context, 700), productRef = ctx.product_ref ?? textField(b.product, 300);
    const stream = new ReadableStream({
      async start(c) {
        try {
          let answer = "", confidence = "high", handoff = false, sources: Array<{ url: string | null; title: string }> = [], model = "rules", usage = { tokens_in: null as number | null, tokens_out: null as number | null };
          let cards: ProductCard[] = [], currentProduct: string | null = null, productSearch: Record<string, unknown> | null = null;
          if (!clean.ok) {
            answer = clean.reason === "injection" ? `I can only help with questions about ${ctx.brand}.` : "Could you say a bit more? I didn't catch that.";
            confidence = "refused";
            c.enqueue(sse("meta", { sources: [] })); c.enqueue(sse("token", answer));
          } else {
            // knowledge and products are looked up together; the one model call that writes the answer also picks the cards
            const [chunks, rec] = await Promise.all([retrieveForInbox(ctx, clean.query, 6), recommendProducts(ctx, clean.query, page, { context, product: productRef })]);
            const prompt = buildAnswerPrompt(ctx, chunks, page, rec, context);
            const seen = new Set<string>();
            sources = ctx.show_sources ? chunks.filter((k) => { const key = k.url ?? k.title; if (!key || seen.has(key)) return false; seen.add(key); return true; }).map((k) => ({ url: k.url, title: k.title })) : [];
            c.enqueue(sse("meta", { sources }));
            const r = await streamAnswer(ctx, prompt, (delta) => { answer += delta; c.enqueue(sse("token", delta)); });
            const parsed = parseAnswer(r.raw);
            if (parsed.answer && parsed.answer !== answer) { answer = parsed.answer; }
            confidence = parsed.confidence; handoff = parsed.handoff; model = r.model; usage = { tokens_in: r.tokens_in, tokens_out: r.tokens_out };
            if (parsed.used_sources.length) sources = parsed.used_sources.map((n) => chunks[n - 1]).filter(Boolean).map((k) => ({ url: k.url, title: k.title }));
            if (rec) {
              cards = pickCards(parsed.products, rec, ctx.products?.max ?? 3, confidence);
              answer = stripCardLinks(answer, cards);
              currentProduct = rec.current?.id ?? null;
              productSearch = { ...rec.search, shopping: parsed.shopping || cards.length > 0 };
              if (cards.length) c.enqueue(sse("products", { items: cards }));
            }
          }
          // "agent message wins": a person may have answered while we streamed
          const again = await rpc<AiContext>("webchat_v_ai_context", { p_chat: chat, p_message: qid });
          if (!again?.ok) { c.enqueue(sse("cancelled", { reason: "agent_replied" })); c.close(); return; }
          const lowStreak = (ctx.recent_low ?? 0) + (confidence !== "high" ? 1 : 0) >= (ctx.low_confidence_streak ?? 2);
          const doHandoff = handoff || lowStreak;
          const rec = await rpc<any>("webchat_v_ai_record", { p_chat: chat, p_message: qid, p_turn: { query: ctx.query, answer, sources, confidence, handoff: doHandoff ? (handoff ? "intent" : "low_confidence") : null, page_url: page?.url ?? ctx.page_url, model, latency_ms: Date.now() - started, ...usage,
            products: cards, context, product_id: currentProduct, product_search: productSearch } });
          let ho: any = null;
          if (doHandoff) ho = await rpc("webchat_v_handoff", { p_chat: chat, p_reason: handoff ? "ai_intent" : "low_confidence" });
          c.enqueue(sse("done", { message: rec?.message ?? null, turn_id: rec?.turn_id ?? null, confidence, handoff: !!ho }));
        } catch (e) {
          log({ fn: FN, error: String((e as any)?.message ?? e), chat });
          // never leave the visitor hanging: hand to a person and say so
          try { await rpc("webchat_v_handoff", { p_chat: chat, p_reason: "ai_error" }); } catch { /* ignore */ }
          c.enqueue(sse("error", { message: "assistant_unavailable" }));
        } finally { try { c.close(); } catch { /* closed */ } }
      },
    });
    return new Response(stream, { headers });
  }

  throw new HttpError(404, "E_NOT_FOUND", `no route ${m} ${path}`);
});
