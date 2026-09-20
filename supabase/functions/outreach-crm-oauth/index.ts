// Item 22 — connect a CRM (HubSpot, Pipedrive, Salesforce) and the actions of the Integrations settings page.
//   POST {action:"start", workspace_id, provider, return_url?}                       → { url }            (manager)
//   GET  /callback?code&state                                                       → 302 to return_url   (public: deploy with --no-verify-jwt)
//   POST {action:"segments", integration_id}                                        → { segments:[{id,name,count,kind}] }
//   POST {action:"import_segment", integration_id, segment_id, segment_name?, list_id?, client_id?, cursor?}
//   POST {action:"sync_now", integration_id}     POST {action:"test", integration_id}
// Tokens are encrypted with crypto.ts and live only in outreach_integration_secrets.
import { admin, audit, CRON_SECRET, FUNCTIONS_BASE, HttpError, json, membership, rateLimit, readJson, requireRole, requireUser, serve, SERVICE_ROLE_KEY, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { hmacSha256Hex } from "../_shared/outreach/crypto.ts";
import { getProvider, isProviderName, notConfiguredMessage, CrmError, type ProviderName } from "../_shared/outreach/crm/index.ts";
import { plainError } from "../_shared/outreach/crm/http.ts";
import { importSegment } from "../_shared/outreach/crm/pull.ts";
import { createSession, loadTokens, markAuthError, saveTokens } from "../_shared/outreach/crm/store.ts";
import { INTEGRATION_COLUMNS, syncIntegration, toIntegration, type IntegrationRow } from "../_shared/outreach/crm/worker.ts";

const REDIRECT_URI = `${FUNCTIONS_BASE}outreach-crm-oauth/callback`;
const DEFAULT_RETURN = `${WEB_ORIGIN.replace(/\/+$/, "")}/outreach/settings/integrations`;
const STATE_TTL_MS = 15 * 60_000;

// ---------------------------------------------------------------------------
// state + PKCE. The state carries its creation time and the page to return to; the whole string must match the stored one.
// ---------------------------------------------------------------------------
const b64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (s: string): string => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

function safeReturnUrl(candidate: unknown): string {
  if (typeof candidate !== "string" || !candidate) return DEFAULT_RETURN;
  try {
    const u = new URL(candidate), base = new URL(WEB_ORIGIN);
    if (u.origin !== base.origin) return DEFAULT_RETURN;
    u.hash = "";
    for (const k of ["connected", "error", "provider"]) u.searchParams.delete(k);
    return u.toString();
  } catch { return DEFAULT_RETURN; }
}

function newState(returnUrl: string): string {
  const rand = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${rand}.${Date.now().toString(36)}.${b64url(new TextEncoder().encode(returnUrl))}`;
}

function parseState(state: string): { createdAt: number; returnUrl: string } {
  const [, ts, ret] = state.split(".");
  let returnUrl = DEFAULT_RETURN;
  try { returnUrl = safeReturnUrl(unb64url(ret ?? "")); } catch { /* default */ }
  return { createdAt: parseInt(ts ?? "0", 36) || 0, returnUrl };
}

/** PKCE verifier derived from the state, so nothing extra has to be stored between start and callback. */
const pkceVerifier = (state: string): Promise<string> => hmacSha256Hex(CRON_SECRET || SERVICE_ROLE_KEY, `crm-pkce:${state}`);
async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

function redirect(returnUrl: string, params: Record<string, string>): Response {
  const u = new URL(returnUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), "cache-control": "no-store" } });
}

// ---------------------------------------------------------------------------
// GET /callback (public)
// ---------------------------------------------------------------------------
async function callback(url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const denied = url.searchParams.get("error");
  if (!state) return redirect(DEFAULT_RETURN, { error: "state_missing" });
  const { createdAt, returnUrl } = parseState(state);

  const { data: secret } = await admin.from("outreach_integration_secrets").select("integration_id").eq("oauth_state", state).maybeSingle();
  if (!secret) return redirect(returnUrl, { error: "state_invalid" });
  const { data: integ } = await admin.from("outreach_integrations").select("id, workspace_id, provider, status, last_event_id").eq("id", secret.integration_id).maybeSingle();
  if (!integ || !isProviderName(integ.provider)) return redirect(returnUrl, { error: "state_invalid" });
  const provider = integ.provider as ProviderName;
  const fail = async (errorCode: string, lastError?: string) => {
    await admin.from("outreach_integration_secrets").update({ oauth_state: null, updated_at: new Date().toISOString() }).eq("integration_id", integ.id);
    if (integ.status === "connecting") await admin.from("outreach_integrations").update({ status: "disconnected", last_error: lastError ?? null }).eq("id", integ.id);
    return redirect(returnUrl, { error: errorCode, provider });
  };

  if (Date.now() - createdAt > STATE_TTL_MS) return await fail("state_expired");
  if (denied) return await fail(denied === "access_denied" ? "access_denied" : denied.slice(0, 60).replace(/[^a-zA-Z0-9_]/g, "_"));
  if (!code) return await fail("code_missing");
  const p = getProvider(provider);
  if (!p.configured()) return await fail("not_configured");

  try {
    const tokens = await p.exchangeCode(code, REDIRECT_URI, provider === "salesforce" ? await pkceVerifier(state) : undefined);
    let accountLabel = p.label;
    try { accountLabel = await p.accountLabel(tokens); } catch { /* the label is a nicety */ }
    await saveTokens(integ.id, tokens, { oauth_state: null });
    const patch: Record<string, unknown> = { status: "active", account_label: accountLabel.slice(0, 200), last_error: null };
    if (Number(integ.last_event_id ?? 0) === 0) {
      // a new connection starts from now: it does not replay what another CRM in this workspace already received
      const { data: last } = await admin.from("outreach_integration_events").select("id").eq("workspace_id", integ.workspace_id).order("id", { ascending: false }).limit(1).maybeSingle();
      if (last?.id) patch.last_event_id = last.id;
    }
    await admin.from("outreach_integrations").update(patch).eq("id", integ.id);
    await audit(integ.workspace_id, "integration.connected", "integration", integ.id, { provider, account: accountLabel });
    return redirect(returnUrl, { connected: provider });
  } catch (e) {
    const msg = plainError(e);
    console.error("crm oauth callback", provider, msg);
    return await fail(e instanceof CrmError && e.kind === "auth" ? "token_exchange_refused" : "token_exchange_failed", msg);
  }
}

// ---------------------------------------------------------------------------
// POST actions (user JWT, manager role)
// ---------------------------------------------------------------------------
async function loadIntegration(id: unknown): Promise<IntegrationRow> {
  if (typeof id !== "string" || !id) throw new HttpError(400, "E_PAYLOAD_INVALID", "integration_id required");
  const { data } = await admin.from("outreach_integrations").select(INTEGRATION_COLUMNS).eq("id", id).maybeSingle();
  if (!data) throw new HttpError(404, "E_NOT_FOUND", "integration not found");
  return toIntegration(data);
}

async function openSession(integ: IntegrationRow) {
  const provider = getProvider(integ.provider);
  if (!provider.configured()) throw new HttpError(503, "E_NOT_CONFIGURED", notConfiguredMessage(integ.provider));
  if (integ.status !== "active" && integ.status !== "error") throw new HttpError(400, "E_NOT_CONNECTED", `${provider.label} is not connected. Connect it first.`);
  const tokens = await loadTokens(integ.id);
  if (!tokens) throw new HttpError(400, "E_NOT_CONNECTED", `${provider.label} is not connected. Connect it first.`);
  return { provider, session: createSession(integ.id, provider, tokens) };
}

/** CRM errors → HTTP errors with a sentence the page can show. A dead token also flips the integration to "error". */
async function crmGuard<T>(integ: IntegrationRow, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (!(e instanceof CrmError)) throw e;
    const msg = plainError(e);
    if (e.kind === "auth") { await markAuthError(integ.id, msg); throw new HttpError(400, "E_CRM_AUTH", msg); }
    if (e.kind === "rate_limit") throw new HttpError(429, "E_RATE_LIMITED", msg);
    throw new HttpError(e.kind === "transient" ? 502 : 400, "E_CRM", msg);
  }
}

serve("crm-oauth", async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.pathname.replace(/\/+$/, "").endsWith("/callback")) return await callback(url);
    throw new HttpError(404, "E_NOT_FOUND", "unknown path");
  }
  if (req.method !== "POST") throw new HttpError(405, "E_PAYLOAD_INVALID", "POST only");

  const user = await requireUser(req);
  const body = await readJson<Record<string, any>>(req);
  const action = String(body.action ?? "");

  if (action === "start") {
    await rateLimit(`user:${user.id}:crm-start`, 20, 60);
    if (!body.workspace_id || !isProviderName(body.provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and provider (hubspot, pipedrive or salesforce) required");
    const providerName: ProviderName = body.provider;
    requireRole(await membership(user.id, body.workspace_id), "manager");
    const provider = getProvider(providerName);
    if (!provider.configured()) throw new HttpError(503, "E_NOT_CONFIGURED", notConfiguredMessage(providerName));
    if (!Deno.env.get("OUTREACH_COOKIE_KEY")) throw new HttpError(503, "E_NOT_CONFIGURED", "The encryption key (OUTREACH_COOKIE_KEY) is not set, so CRM tokens cannot be stored safely.");

    const { data: existing } = await admin.from("outreach_integrations").select("id, status").eq("workspace_id", body.workspace_id).eq("provider", providerName).maybeSingle();
    let integrationId: string;
    if (existing) {
      integrationId = existing.id;
      // reconnecting a working integration keeps it syncing until the new tokens arrive
      if (existing.status !== "active") await admin.from("outreach_integrations").update({ status: "connecting" }).eq("id", existing.id);
    } else {
      const { data: created, error } = await admin.from("outreach_integrations").insert({ workspace_id: body.workspace_id, provider: providerName, status: "connecting", created_by: user.id }).select("id").single();
      if (error || !created) throw new HttpError(500, "E_INTERNAL", error?.message ?? "could not create the integration");
      integrationId = created.id;
    }
    const state = newState(safeReturnUrl(body.return_url));
    const { error: sErr } = await admin.from("outreach_integration_secrets").upsert({ integration_id: integrationId, oauth_state: state, updated_at: new Date().toISOString() }, { onConflict: "integration_id" });
    if (sErr) throw new HttpError(500, "E_INTERNAL", sErr.message);
    const authorizeUrl = provider.authorizeUrl(state, REDIRECT_URI, providerName === "salesforce" ? await pkceChallenge(await pkceVerifier(state)) : undefined);
    await audit(body.workspace_id, "integration.connect_started", "integration", integrationId, { provider: providerName }, "user");
    return json({ url: authorizeUrl, integration_id: integrationId });
  }

  if (!["segments", "import_segment", "sync_now", "test"].includes(action)) throw new HttpError(400, "E_PAYLOAD_INVALID", "action must be start, segments, import_segment, sync_now or test");
  const integ = await loadIntegration(body.integration_id);
  requireRole(await membership(user.id, integ.workspace_id), "manager");

  if (action === "test") {
    await rateLimit(`user:${user.id}:crm-test`, 20, 60);
    const { provider, session } = await openSession(integ);
    const accountLabel = await crmGuard(integ, () => session.call((t) => provider.accountLabel(t)));
    await admin.from("outreach_integrations").update({ account_label: accountLabel.slice(0, 200), status: "active", last_error: null }).eq("id", integ.id);
    return json({ ok: true, account_label: accountLabel, provider: integ.provider });
  }

  if (action === "segments") {
    await rateLimit(`user:${user.id}:crm-segments`, 30, 60);
    const { provider, session } = await openSession(integ);
    const segments = await crmGuard(integ, () => session.call((t) => provider.listSegments(t)));
    return json({ segments: segments.map((s) => ({ id: s.id, name: s.name, kind: s.kind, ...(s.size != null ? { count: s.size } : {}) })) });
  }

  if (action === "import_segment") {
    await rateLimit(`user:${user.id}:crm-import`, 6, 60);
    if (typeof body.segment_id !== "string" && typeof body.segment_id !== "number") throw new HttpError(400, "E_PAYLOAD_INVALID", "segment_id required");
    const listId: string | null = body.list_id || null, clientId: string | null = body.client_id || null;
    if (listId) { const { data } = await admin.from("outreach_lists").select("id").eq("id", listId).eq("workspace_id", integ.workspace_id).maybeSingle(); if (!data) throw new HttpError(404, "E_NOT_FOUND", "list not found in this workspace"); }
    if (clientId) { const { data } = await admin.from("outreach_clients").select("id").eq("id", clientId).eq("workspace_id", integ.workspace_id).maybeSingle(); if (!data) throw new HttpError(404, "E_NOT_FOUND", "client not found in this workspace"); }
    const { provider, session } = await openSession(integ);
    const result = await crmGuard(integ, () => importSegment(integ, provider, session, { segmentId: String(body.segment_id), segmentName: body.segment_name ?? null, listId, clientId, cursor: typeof body.cursor === "string" && body.cursor ? body.cursor : null, deadline: Date.now() + 90_000 }));
    await audit(integ.workspace_id, "integration.segment_imported", "integration", integ.id, { provider: integ.provider, segment_id: String(body.segment_id), imported: result.imported }, "user");
    return json({ ok: true, ...result });
  }

  // sync_now
  await rateLimit(`user:${user.id}:crm-sync-now:${integ.id}`, 2, 60);
  await openSession(integ); // same "is it connected and configured" checks
  const summary = await syncIntegration(integ, { deadline: Date.now() + 45_000, pull: integ.settings.suppress_customers === true ? "force" : "skip" });
  if (integ.status === "error" && summary.stop !== "auth") await admin.from("outreach_integrations").update({ status: "active" }).eq("id", integ.id);
  return json({ ok: summary.stop !== "auth", ...summary });
});
