// supabase/functions/outreach-api/index.ts
//
// Public REST API for the outreach platform (plan item 21), versioned at /v1.
//
//   Base URL:  https://<project>.supabase.co/functions/v1/outreach-api/v1/...
//   Auth:      Authorization: Bearer ok_live_…      (or  X-API-Key: ok_live_…)
//
// A second front door onto the same database functions the web app and the connector use:
//   key -> outreach_api_authenticate -> outreach_api_dispatch(key_id, fn, args)
// The dispatcher runs the whitelisted outreach_* function AS the member who created the key, narrowed to the
// key's role and client scope. Caps, schedules, warm-up, reply-stop and suppression stay in the database, so
// the API cannot out-send the app. The workspace always comes from the key, never from the URL.
//
// Deploy with verify_jwt DISABLED (an API key is not a JWT; auth is enforced here for every /v1 route).
//
// Request pipeline for /v1/*:
//   request id -> authenticate -> rate limit (read 600/h, write 300/h, spend 60/h per key)
//   -> body parse -> idempotency (Idempotency-Key on POST/PUT/PATCH/DELETE) -> route -> error mapping -> log

import { Hono } from "npm:hono@4.9.7";
import { admin, CORS, log, rpc, sha256Hex } from "../_shared/outreach/supabase.ts";
import { type Env, type KeyCtx, HttpError, toHttpError, errorBody } from "./dispatch.ts";
import { registerPlatform } from "./routes_platform.ts";
import { registerLeads } from "./routes_leads.ts";
import { registerEnrollments } from "./routes_enrollments.ts";
import { registerSequences } from "./routes_sequences.ts";
import { registerInbox } from "./routes_inbox.ts";
import { registerSenders } from "./routes_senders.ts";
import { registerReports } from "./routes_reports.ts";

const BASE = "/outreach-api";
const API_VERSION = "2026-09-20";
const MAX_BODY_BYTES = 2_000_000;
const WINDOW_SECS = 3600;
const LIMITS = { read: 600, write: 300, spend: 60 } as const;
type RateClass = keyof typeof LIMITS;

const API_CORS: Record<string, string> = {
  ...CORS,
  "access-control-allow-headers": `${CORS["access-control-allow-headers"]}, x-api-key, idempotency-key`,
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-expose-headers": "x-request-id, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after, idempotent-replayed",
};

/** Calls that start spending a sender's LinkedIn or mailbox budget. They count against "write" AND "spend". */
const SPEND_ROUTES: RegExp[] = [
  /^\/v1\/enrollments$/, /^\/v1\/enrollments\/recover$/, /^\/v1\/leads\/enrich$/, /^\/v1\/threads\/[^/]+\/reply$/, /^\/v1\/sequences\/[^/]+\/activate$/,
];
/** POSTs that change nothing. They count as reads. */
const READ_POSTS: RegExp[] = [/^\/v1\/enrollments\/preview$/];

function rateClasses(method: string, route: string): RateClass[] {
  if (method === "GET" || method === "HEAD" || READ_POSTS.some((r) => r.test(route))) return ["read"];
  return SPEND_ROUTES.some((r) => r.test(route)) ? ["write", "spend"] : ["write"];
}

async function limitState(key: string): Promise<{ count: number; resetSecs: number } | null> {
  try {
    const { data } = await admin.from("outreach_rate_limits").select("count, window_end").eq("key", key).maybeSingle();
    if (!data) return null;
    return { count: Number(data.count), resetSecs: Math.max(1, Math.ceil((new Date(data.window_end).getTime() - Date.now()) / 1000)) };
  } catch { return null; }
}

const app = new Hono<Env>().basePath(BASE);

app.options("*", () => new Response(null, { status: 204, headers: API_CORS }));

// ---- outermost: request id, CORS, logging -------------------------------------------------------------------
app.use("*", async (c, next) => {
  const t0 = Date.now();
  const requestId = `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  c.set("ctx", { requestId, key: null as unknown as KeyCtx });
  await next();
  for (const [k, v] of Object.entries(API_CORS)) c.res.headers.set(k, v);
  for (const [k, v] of Object.entries(c.get("rateHeaders") ?? {})) c.res.headers.set(k, v);
  c.res.headers.set("x-request-id", requestId);
  c.res.headers.set("x-api-version", API_VERSION);
  const key = c.get("ctx")?.key;
  log({ fn: "outreach-api", request_id: requestId, method: c.req.method, route: c.req.path.slice(BASE.length), status: c.res.status, duration_ms: Date.now() - t0, key_id: key?.key_id ?? null, workspace_id: key?.workspace_id ?? null });
});

app.get("/", (c) => c.json({ name: "Outreach API", version: "v1", api_version: API_VERSION, auth: "Authorization: Bearer ok_live_…", start_here: "GET /v1/me" }));

// ---- /v1: authenticate, rate limit, body, idempotency ------------------------------------------------------
app.use("/v1/*", async (c, next) => {
  const method = c.req.method.toUpperCase();
  const route = c.req.path.slice(BASE.length).replace(/\/+$/, "");

  // 1. authenticate. The key decides the workspace, the member it acts as, the role and the client scope.
  const presented = (c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || c.req.header("x-api-key") || "").trim();
  if (!presented.startsWith("ok_")) throw new HttpError(401, "E_UNAUTHORIZED", "Send your API key as: Authorization: Bearer ok_live_…");
  const key = await rpc<KeyCtx | null>("api_authenticate", { p_key: presented });
  if (!key?.key_id) throw new HttpError(401, "E_UNAUTHORIZED", "This API key is not valid. It may have been revoked or expired, or the member who created it left the workspace.");
  c.get("ctx").key = key;

  // 2. rate limit, per key and class, on the shared outreach_rate_limit counter
  const classes = rateClasses(method, route);
  const allowed = await Promise.all(classes.map((cl) => rpc<boolean>("rate_limit", { p_key: `api:${key.key_id}:${cl}`, p_limit: LIMITS[cl], p_window_secs: WINDOW_SECS })));
  const blocked = classes.find((_, i) => !allowed[i]);
  const shown = blocked ?? classes[classes.length - 1];   // report the tightest class that applies
  const state = await limitState(`api:${key.key_id}:${shown}`);
  c.set("rateHeaders", {
    "x-ratelimit-limit": String(LIMITS[shown]),
    ...(state ? { "x-ratelimit-remaining": String(Math.max(0, LIMITS[shown] - state.count)), "x-ratelimit-reset": String(state.resetSecs) } : {}),
    ...(blocked ? { "retry-after": String(state?.resetSecs ?? 60) } : {}),
  });
  if (blocked) throw new HttpError(429, "E_RATE_LIMITED", `Too many ${blocked === "spend" ? "calls that spend sender budget" : blocked + " calls"} this hour (limit ${LIMITS[blocked]}). Retry after the number of seconds in Retry-After.`, { class: blocked, limit: LIMITS[blocked], retry_after: state?.resetSecs ?? 60 });

  if (method === "GET" || method === "HEAD") return await next();

  // 3. body, read once
  const raw = await c.req.text();
  if (raw.length > MAX_BODY_BYTES) throw new HttpError(413, "E_TOO_MANY", "Request body is larger than 2 MB. Split it into several calls.");
  let parsed: unknown = {};
  if (raw.trim()) {
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(422, "E_PAYLOAD_INVALID", "The request body is not valid JSON."); }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HttpError(422, "E_PAYLOAD_INVALID", "The request body must be a JSON object.");
  }
  c.set("body", parsed);

  // 4. idempotency: same key + same request replays the stored answer; same key + different request is a 409
  const idem = c.req.header("idempotency-key")?.trim();
  if (!idem) return await next();
  if (idem.length > 255) throw new HttpError(422, "E_PAYLOAD_INVALID", "Idempotency-Key must be at most 255 characters.");
  const hash = await sha256Hex(`${method} ${route}${new URL(c.req.url).search}\n${raw}`);
  const seen = await rpc<{ fresh?: boolean; replay?: boolean; conflict?: boolean; in_progress?: boolean; status?: number; response?: unknown }>("api_idempotent", { p_key_id: key.key_id, p_idem: idem, p_hash: hash });
  if (seen?.conflict) throw new HttpError(409, "E_IDEMPOTENCY_MISMATCH", "This Idempotency-Key was already used with a different request. Use a new key for a new request.");
  if (seen?.in_progress) {
    c.set("rateHeaders", { ...c.get("rateHeaders"), "retry-after": "2" });
    throw new HttpError(409, "E_IN_PROGRESS", "The first request with this Idempotency-Key has not finished yet. Retry in a few seconds.");
  }
  if (seen?.replay) {
    c.set("rateHeaders", { ...c.get("rateHeaders"), "idempotent-replayed": "true" });
    return c.json((seen.response ?? {}) as Record<string, unknown>, (seen.status ?? 200) as 200);
  }

  await next();

  // Store the outcome so a retry gets the same answer. A 5xx is NOT stored: the database call is one
  // transaction, so nothing happened and the caller must be able to retry with the same key.
  try {
    if (c.res.status < 500) {
      const stored = await c.res.clone().json().catch(() => ({}));
      await rpc("api_idempotent", { p_key_id: key.key_id, p_idem: idem, p_hash: hash, p_status: c.res.status, p_response: stored });
    } else {
      await admin.from("outreach_api_idempotency").delete().eq("key_id", key.key_id).eq("idem_key", idem);   // the API's own bookkeeping table, never response data
    }
  } catch (e) { log({ fn: "outreach-api", request_id: c.get("ctx").requestId, idempotency_store_failed: String((e as Error)?.message ?? e) }); }
});

registerPlatform(app);
registerLeads(app);
registerEnrollments(app);
registerSequences(app);
registerInbox(app);
registerSenders(app);
registerReports(app);

app.notFound((c) => c.json(errorBody(new HttpError(404, "E_NOT_FOUND", `No route ${c.req.method} ${c.req.path.slice(BASE.length) || "/"}. See docs/outreach/API.md.`), c.get("ctx")?.requestId ?? ""), 404));

app.onError((e, c) => {
  const err = toHttpError(e);
  const requestId = c.get("ctx")?.requestId ?? "";
  if (err.status >= 500 && err.code !== "E_NOT_IMPLEMENTED") log({ fn: "outreach-api", request_id: requestId, outcome: "error", error: String((err as HttpError & { cause?: unknown }).cause ?? err.message) });
  const headers: Record<string, string> = err.status === 401 ? { "www-authenticate": 'Bearer realm="outreach-api"' } : {};
  return c.json(errorBody(err, requestId), err.status as 400, headers);
});

Deno.serve(app.fetch);
