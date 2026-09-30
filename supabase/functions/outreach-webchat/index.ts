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
//   POST /uploads                               GET  /attachments/:conversation/:attachment
//   POST /chat  (SSE: meta, token, done)        POST /feedback           POST /campaigns/:id/hit
//   GET  /continuity/stop?t=                    GET  /resume?t=  (standalone page deep link from continuity emails)
import { admin, ANON_KEY, CORS, HttpError, json, log, rateLimit, readJson, rpc, serve, SUPABASE_URL, timingSafeEqual, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { hmacSha256Hex } from "../_shared/outreach/crypto.ts";
import { buildAnswerPrompt, clientIp, parseAnswer, requestMeta, retrieveForInbox, sanitizeQuery, sendTranscript, signVisitorToken, streamAnswer, verifyResumeToken, verifyVisitorToken, type AiContext } from "../_shared/outreach/webchat.ts";

const FN = "outreach-webchat";
const API_VERSION = "1.0.0";
const REALTIME_URL = SUPABASE_URL.replace(/^http/, "ws") + "/realtime/v1/websocket";
const TURNSTILE_SECRET = Deno.env.get("OUTREACH_TURNSTILE_SECRET") ?? "";
const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "text/csv", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation"]);
const BLOCKED_EXT = /\.(exe|msi|bat|cmd|com|scr|ps1|sh|js|jar|vbs|dll|apk|dmg|pkg|deb|rpm|html?|svg)$/i;

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

async function verifyTurnstile(token: string | undefined, ip: string): Promise<boolean> {
  if (!TURNSTILE_SECRET) return true;   // not configured on the platform → cannot enforce
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: TURNSTILE_SECRET, response: token, remoteip: ip }) });
    const j = await r.json();
    return !!j?.success;
  } catch { return false; }
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
    return json({ ...full, api_version: API_VERSION, realtime: { url: REALTIME_URL, anon_key: ANON_KEY } }, 200, { "cache-control": "public, max-age=300", vary: "Origin" });
  }

  await ipLimits(req, inbox);
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
    if (inbox.settings?.security?.turnstile_enabled && !(await verifyTurnstile(b.turnstile_token, clientIp(req)))) throw new HttpError(403, "E_TURNSTILE", "verification failed");
    const r = await rpc<any>("webchat_v_conversation_start", { p_inbox: inbox.id, p_visitor: vid, p_form: b.form ?? null, p_source: ["launcher", "popup", "campaign", "sdk", "standalone", "email"].includes(b.source) ? b.source : "launcher", p_page: b.page ?? null });
    return json(r);
  }
  const conv = path.match(/^\/conversations\/([0-9a-f-]{36})(?:\/([a-z]+))?$/);
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
      const r = await rpc<any>("webchat_v_message", { p_visitor: vid, p_chat: chat, p_echo: b.echo_id ? String(b.echo_id).slice(0, 64) : null, p_text: b.text ?? null, p_attachments: attachments, p_content_type: b.content_type ?? "text", p_attrs: b.content_attributes ?? {}, p_source: "widget" });
      return json(r);
    }
    if (m === "POST" && action === "typing") { const b = await readJson<any>(req); await rpc("webchat_v_typing", { p_visitor: vid, p_chat: chat, p_on: !!b.on, p_preview: b.preview ?? null }); return json({ ok: true }); }
    if (m === "POST" && action === "read") { await rpc("webchat_v_read", { p_visitor: vid, p_chat: chat }); return json({ ok: true }); }
    if (m === "POST" && action === "heartbeat") return json(await rpc("webchat_v_heartbeat", { p_visitor: vid, p_chat: chat }));
    if (m === "POST" && action === "resolve") return json({ conversation: await rpc("webchat_v_resolve", { p_visitor: vid, p_chat: chat }) });
    if (m === "POST" && action === "csat") { const b = await readJson<any>(req); return json({ conversation: await rpc("webchat_v_csat", { p_visitor: vid, p_chat: chat, p_rating: Number(b.rating), p_comment: b.comment ?? null }) }); }
    if (m === "POST" && action === "transcript") {
      await rateLimit(`webchat:tr:${chat}`, 1, 15);
      if (!inbox.settings?.features?.transcript && inbox.settings?.features?.transcript !== undefined) throw new HttpError(403, "E_FORBIDDEN", "transcripts are off");
      const b = await readJson<any>(req);
      if (b.email) await rpc("webchat_v_attrs", { p_visitor: vid, p_chat: null, p_custom: null, p_delete: null, p_conv_custom: null, p_conv_delete: null, p_add_labels: null, p_remove_labels: null }).catch(() => {});
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
    const page = b.page && typeof b.page === "object" ? { url: String(b.page.url ?? "").slice(0, 2000), title: String(b.page.title ?? "").slice(0, 300), text: String(b.page.text ?? "").slice(0, 4000) } : null;
    const stream = new ReadableStream({
      async start(c) {
        try {
          let answer = "", confidence = "high", handoff = false, sources: Array<{ url: string | null; title: string }> = [], model = "rules", usage = { tokens_in: null as number | null, tokens_out: null as number | null };
          if (!clean.ok) {
            answer = clean.reason === "injection" ? `I can only help with questions about ${ctx.brand}.` : "Could you say a bit more? I didn't catch that.";
            confidence = "refused";
            c.enqueue(sse("meta", { sources: [] })); c.enqueue(sse("token", answer));
          } else {
            const chunks = await retrieveForInbox(ctx, clean.query, 6);
            const prompt = buildAnswerPrompt(ctx, chunks, page);
            const seen = new Set<string>();
            sources = ctx.show_sources ? chunks.filter((k) => { const key = k.url ?? k.title; if (!key || seen.has(key)) return false; seen.add(key); return true; }).map((k) => ({ url: k.url, title: k.title })) : [];
            c.enqueue(sse("meta", { sources }));
            const r = await streamAnswer(ctx, prompt, (delta) => { answer += delta; c.enqueue(sse("token", delta)); });
            const parsed = parseAnswer(r.raw);
            if (parsed.answer && parsed.answer !== answer) { answer = parsed.answer; }
            confidence = parsed.confidence; handoff = parsed.handoff; model = r.model; usage = { tokens_in: r.tokens_in, tokens_out: r.tokens_out };
            if (parsed.used_sources.length) sources = parsed.used_sources.map((n) => chunks[n - 1]).filter(Boolean).map((k) => ({ url: k.url, title: k.title }));
          }
          // "agent message wins": a person may have answered while we streamed
          const again = await rpc<AiContext>("webchat_v_ai_context", { p_chat: chat, p_message: qid });
          if (!again?.ok) { c.enqueue(sse("cancelled", { reason: "agent_replied" })); c.close(); return; }
          const lowStreak = (ctx.recent_low ?? 0) + (confidence !== "high" ? 1 : 0) >= (ctx.low_confidence_streak ?? 2);
          const doHandoff = handoff || lowStreak;
          const rec = await rpc<any>("webchat_v_ai_record", { p_chat: chat, p_message: qid, p_turn: { query: ctx.query, answer, sources, confidence, handoff: doHandoff ? (handoff ? "intent" : "low_confidence") : null, page_url: page?.url ?? ctx.page_url, model, latency_ms: Date.now() - started, ...usage } });
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
