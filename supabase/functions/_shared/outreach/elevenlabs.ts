// Voice provider client (web-chat-voice-elevenlabs-PRD.md §9): the Agents API calls the voice feature makes, and
// nothing else. One function per call; every call names the account it runs on.
//
//   accounts   `platform` = our own account (OUTREACH_ELEVENLABS_API_KEY); `own` = the key a workspace saved in
//              Settings → AI → Keys (outreach_workspace_secrets.elevenlabs_key_enc, AES-GCM like the LLM keys).
//   host       OUTREACH_ELEVENLABS_API_BASE (default https://api.elevenlabs.io). An account carries its host, so a
//              residency workspace (another host) can be added without touching the callers.
//   retries    429 and 5xx are retried twice with a short backoff (Retry-After honoured up to 3 s); a 4xx is final.
//   errors     ElError: status + the provider's own message, never the key.
import { admin, log, sleep } from "./supabase.ts";
import { decrypt, hmacSha256Hex } from "./crypto.ts";

const PLATFORM_KEY = Deno.env.get("OUTREACH_ELEVENLABS_API_KEY") ?? "";
const API_BASE = (Deno.env.get("OUTREACH_ELEVENLABS_API_BASE") ?? "https://api.elevenlabs.io").replace(/\/+$/, "");

export type ElAccountKind = "platform" | "own";
export interface ElAccount { account: ElAccountKind; key: string; base: string }

export class ElError extends Error {
  status: number; detail: unknown;
  constructor(status: number, message: string, detail?: unknown) { super(message); this.status = status; this.detail = detail; }
}

export function platformVoiceConfigured(): boolean { return !!PLATFORM_KEY; }

/** The account a workspace's voice runs on. `kind` comes from SQL (outreach__voice_account): plan + saved key. */
export async function elAccount(workspaceId: string | null, kind: ElAccountKind): Promise<ElAccount> {
  if (kind === "own") {
    if (!workspaceId) throw new ElError(400, "E_VOICE_KEY: no workspace for this voice key");
    const { data } = await admin.from("outreach_workspace_secrets").select("elevenlabs_key_enc").eq("workspace_id", workspaceId).maybeSingle();
    if (!data?.elevenlabs_key_enc) throw new ElError(400, "E_VOICE_KEY: the workspace's voice key is missing");
    let key: string;
    try { key = await decrypt(data.elevenlabs_key_enc); } catch { throw new ElError(400, "E_VOICE_KEY: the saved voice key cannot be read any more. Enter the key again."); }
    return { account: "own", key, base: API_BASE };
  }
  if (!PLATFORM_KEY) throw new ElError(503, "E_VOICE_UNAVAILABLE: voice is not set up on this platform yet");
  return { account: "platform", key: PLATFORM_KEY, base: API_BASE };
}
/** An account from a key in hand (verifying a key before it is saved). */
export function elAccountFromKey(key: string): ElAccount { return { account: "own", key, base: API_BASE }; }

function messageOf(body: any, status: number): string {
  const d = body?.detail;
  const m = typeof d === "string" ? d : d?.message ?? (Array.isArray(d) ? d.map((x: any) => `${(x?.loc ?? []).join(".")}: ${x?.msg ?? ""}`).join("; ") : null) ?? body?.message ?? body?.error;
  return String(m || `voice provider answered ${status}`).slice(0, 400);
}

interface CallOpts { timeoutMs?: number; retries?: number; query?: Record<string, string | number | boolean | null | undefined> }

async function raw(a: ElAccount, method: string, path: string, body?: unknown, o: CallOpts = {}): Promise<Response> {
  const qs = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  const url = `${a.base}${path}${qs ? `?${qs}` : ""}`;
  const tries = 1 + (o.retries ?? 2);
  let last: Response | null = null, err: unknown = null;
  for (let i = 0; i < tries; i++) {
    try {
      last = await fetch(url, { method, headers: { "xi-api-key": a.key, ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(o.timeoutMs ?? 15_000) });
      if (last.status !== 429 && last.status < 500) return last;
      err = null;
      if (i < tries - 1) { const ra = Number(last.headers.get("retry-after")); await last.body?.cancel().catch(() => {}); await sleep(Math.min(3000, ra > 0 ? ra * 1000 : 400 * (i + 1) * (i + 1))); }
    } catch (e) {
      err = e; last = null;
      if (i < tries - 1) await sleep(400 * (i + 1));
    }
  }
  if (last) return last;
  throw new ElError(503, `E_VOICE_UNAVAILABLE: ${String((err as any)?.message ?? err).slice(0, 200)}`);
}

async function call<T = any>(a: ElAccount, method: string, path: string, body?: unknown, o: CallOpts = {}): Promise<T> {
  const res = await raw(a, method, path, body, o);
  const text = await res.text();
  let j: any = null;
  try { j = text ? JSON.parse(text) : null; } catch { j = { detail: text.slice(0, 300) }; }
  if (!res.ok) throw new ElError(res.status, messageOf(j, res.status), j);
  return j as T;
}

const id = (s: string) => encodeURIComponent(s);
/** DELETE that treats "already gone" as done. */
async function gone(a: ElAccount, path: string): Promise<void> {
  try { await call(a, "DELETE", path, undefined, { retries: 1 }); } catch (e) { if (!(e instanceof ElError) || e.status !== 404) throw e; }
}

export const el = {
  agents: {
    create: async (a: ElAccount, body: unknown): Promise<string> => (await call<{ agent_id: string }>(a, "POST", "/v1/convai/agents/create", body)).agent_id,
    update: (a: ElAccount, agentId: string, body: unknown) => call(a, "PATCH", `/v1/convai/agents/${id(agentId)}`, body),
    get: (a: ElAccount, agentId: string) => call<any>(a, "GET", `/v1/convai/agents/${id(agentId)}`),
    remove: (a: ElAccount, agentId: string) => gone(a, `/v1/convai/agents/${id(agentId)}`),
    /** One row is enough to prove a key can see agents. */
    probe: (a: ElAccount) => call<any>(a, "GET", "/v1/convai/agents", undefined, { query: { page_size: 1 }, retries: 0 }),
  },
  tools: {
    create: async (a: ElAccount, toolConfig: unknown): Promise<string> => (await call<{ id: string }>(a, "POST", "/v1/convai/tools", { tool_config: toolConfig })).id,
    update: (a: ElAccount, toolId: string, toolConfig: unknown) => call(a, "PATCH", `/v1/convai/tools/${id(toolId)}`, { tool_config: toolConfig }),
    /**
     * A deleted agent's branch keeps naming its tools, so a plain delete answers 409 for good. Forced only when no live
     * agent uses the tool and every branch that names it belongs to an agent that is gone.
     */
    remove: async (a: ElAccount, toolId: string): Promise<void> => {
      try { await gone(a, `/v1/convai/tools/${id(toolId)}`); return; }
      catch (e) { if (!(e instanceof ElError) || e.status !== 409) throw e; }
      const d = await call<{ agents?: unknown[]; branches?: Array<{ agent_id?: string }> }>(a, "GET", `/v1/convai/tools/${id(toolId)}/dependent-agents`);
      if ((d?.agents ?? []).length) throw new ElError(409, "the tool is still used by an agent");
      for (const b of d?.branches ?? []) {
        if (!b.agent_id) continue;
        const alive = await call(a, "GET", `/v1/convai/agents/${id(b.agent_id)}`).then(() => true, (e) => { if (e instanceof ElError && e.status === 404) return false; throw e; });
        if (alive) throw new ElError(409, "the tool is still used by an agent");
      }
      try { await call(a, "DELETE", `/v1/convai/tools/${id(toolId)}`, undefined, { query: { force: true }, retries: 1 }); }
      catch (e) { if (!(e instanceof ElError) || e.status !== 404) throw e; }
    },
  },
  secrets: {
    create: async (a: ElAccount, name: string, value: string): Promise<string> => (await call<{ secret_id: string }>(a, "POST", "/v1/convai/secrets", { type: "new", name, value })).secret_id,
    remove: (a: ElAccount, secretId: string) => gone(a, `/v1/convai/secrets/${id(secretId)}`),
  },
  /** A WebRTC conversation token for a private agent, and the conversation id it will have. */
  token: (a: ElAccount, agentId: string, participant: string) =>
    call<{ token: string; conversation_id?: string }>(a, "GET", "/v1/convai/conversation/token", undefined, { query: { agent_id: agentId, participant_name: participant }, timeoutMs: 8000, retries: 1 }),
  conversations: {
    get: (a: ElAccount, conversationId: string) => call<any>(a, "GET", `/v1/convai/conversations/${id(conversationId)}`),
    /** The recording as the provider streams it (the caller pipes the body through). */
    audio: (a: ElAccount, conversationId: string) => raw(a, "GET", `/v1/convai/conversations/${id(conversationId)}/audio`, undefined, { timeoutMs: 30_000, retries: 1 }),
    remove: (a: ElAccount, conversationId: string) => gone(a, `/v1/convai/conversations/${id(conversationId)}`),
  },
  voices: {
    /** The account's voices (premade, cloned, added from the library). */
    list: (a: ElAccount, q: { search?: string; page_size?: number; next_page_token?: string; category?: string } = {}) =>
      call<{ voices: any[]; has_more?: boolean; next_page_token?: string | null }>(a, "GET", "/v2/voices", undefined, { query: { page_size: q.page_size ?? 100, search: q.search, next_page_token: q.next_page_token, category: q.category, include_total_count: false } }),
    library: (a: ElAccount, q: { search?: string; language?: string; gender?: string; accent?: string; use_cases?: string; page?: number; page_size?: number } = {}) =>
      call<{ voices: any[]; has_more?: boolean }>(a, "GET", "/v1/shared-voices", undefined, { query: { page_size: q.page_size ?? 30, page: q.page ?? 0, search: q.search, language: q.language, gender: q.gender, accent: q.accent, use_cases: q.use_cases } }),
    /** A library voice has to be in the account before an agent can speak with it. Returns the account's voice id. */
    add: async (a: ElAccount, publicUserId: string, voiceId: string, name: string): Promise<string> =>
      (await call<{ voice_id: string }>(a, "POST", `/v1/voices/add/${id(publicUserId)}/${id(voiceId)}`, { new_name: name.slice(0, 80) })).voice_id,
  },
  webhooks: {
    /** A workspace webhook signed with HMAC. The secret is returned once. */
    create: (a: ElAccount, name: string, url: string) =>
      call<{ webhook_id: string; webhook_secret?: string }>(a, "POST", "/v1/workspace/webhooks", { settings: { auth_type: "hmac", name, webhook_url: url } }),
    list: (a: ElAccount) => call<{ webhooks: any[] }>(a, "GET", "/v1/workspace/webhooks"),
  },
  settings: {
    get: (a: ElAccount) => call<any>(a, "GET", "/v1/convai/settings"),
    /** Bind the post-call webhook for every agent of the account (the platform account only: never a customer's). */
    bindPostCall: (a: ElAccount, webhookId: string) => call(a, "PATCH", "/v1/convai/settings", { webhooks: { post_call_webhook_id: webhookId, events: ["transcript"], send_audio: false } }),
  },
  tests: {
    create: async (a: ElAccount, body: unknown): Promise<string> => (await call<{ id: string }>(a, "POST", "/v1/convai/agent-testing/create", body)).id,
    remove: (a: ElAccount, testId: string) => gone(a, `/v1/convai/agent-testing/${id(testId)}`),
    run: (a: ElAccount, agentId: string, testIds: string[]) => call<any>(a, "POST", `/v1/convai/agents/${id(agentId)}/run-tests`, { tests: testIds.map((t) => ({ test_id: t })) }, { timeoutMs: 20_000 }),
    invocation: (a: ElAccount, invocationId: string) => call<any>(a, "GET", `/v1/convai/test-invocations/${id(invocationId)}`),
  },
};

// ---------------------------------------------------------------------------
// Post-call webhook signature: `ElevenLabs-Signature: t=<unix>,v0=<hex>`, HMAC-SHA256 of "<t>.<raw body>" with the
// webhook's secret. Several v0 values may be present (secret rotation): any one matching is valid. 30 minutes of
// tolerance on the timestamp, the provider's own replay window.
// ---------------------------------------------------------------------------
export async function verifyElSignature(rawBody: string, header: string | null, secret: string, toleranceSec = 1800, now = Date.now()): Promise<boolean> {
  if (!header || !secret) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim(), v = part.slice(i + 1).trim();
    if (k === "t") t = v; else if (k === "v0") sigs.push(v.toLowerCase());
  }
  if (!/^\d{9,13}$/.test(t) || !sigs.length) return false;
  const ts = Number(t) * (t.length > 10 ? 1 : 1000);
  if (Math.abs(now - ts) > toleranceSec * 1000) return false;
  const want = await hmacSha256Hex(secret, `${t}.${rawBody}`);
  let ok = false;
  for (const s of sigs) {
    if (s.length !== want.length) continue;
    let diff = 0;
    for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ s.charCodeAt(i);
    if (diff === 0) ok = true;
  }
  return ok;
}

// ---------------------------------------------------------------------------
// A finished conversation as outreach_webchat_v_voice_finalize takes it. The webhook's `data` and the conversation
// the worker fetches have the same shape.
// ---------------------------------------------------------------------------
export interface FinalPayload {
  status: string | null; transcript: Array<{ role: "user" | "agent"; message: string; time_in_call_secs: number | null }>;
  duration_s: number | null; cost_credits: number | null; cost_usd: number | null; termination_reason: string | null; main_language: string | null;
  summary: string | null; title: string | null; successful: string | null; collected: Record<string, string>; has_audio: boolean;
}
const num = (v: unknown): number | null => { const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN; return Number.isFinite(n) ? n : null; };
const str = (v: unknown, max: number): string | null => { const s = typeof v === "string" ? v.trim() : ""; return s ? s.slice(0, max) : null; };

export function normalizeConversation(d: any): FinalPayload {
  const md = d?.metadata ?? {}, an = d?.analysis ?? {};
  // tool calls and tool results are turns without a spoken message: they are not part of the conversation's text
  const transcript = (Array.isArray(d?.transcript) ? d.transcript : [])
    .filter((t: any) => (t?.role === "user" || t?.role === "agent") && typeof t?.message === "string" && t.message.trim() !== "")
    .map((t: any) => ({ role: t.role as "user" | "agent", message: t.message as string, time_in_call_secs: num(t.time_in_call_secs) }));
  // collected details: {id: {value, ...}}; a value the model could not find is null / "" / "None"
  const collected: Record<string, string> = {};
  const dc = an.data_collection_results && typeof an.data_collection_results === "object" ? an.data_collection_results : {};
  for (const k of ["visitor_name", "visitor_phone", "need", "budget"]) {
    const v = dc[k]?.value ?? (typeof dc[k] === "string" ? dc[k] : null);
    const s = v == null ? "" : String(v).trim();
    if (s && !/^(none|null|n\/a|unknown|not (provided|mentioned|given|specified))\.?$/i.test(s)) collected[k] = s.slice(0, 500);
  }
  // metadata.cost is in credits; the money amount is cost_fiat on newer payloads, as a number or {amount / value, currency}
  const fiat = md.cost_fiat ?? md.charging?.cost_fiat ?? null;
  const usd = typeof fiat === "object" && fiat ? num(fiat.amount ?? fiat.value ?? fiat.usd) : num(fiat);
  const ok = String(an.call_successful ?? "").toLowerCase();
  return {
    status: str(d?.status, 40), transcript, duration_s: num(md.call_duration_secs), cost_credits: num(md.cost), cost_usd: usd,
    termination_reason: str(md.termination_reason, 200), main_language: str(md.main_language, 12),
    summary: str(an.transcript_summary, 4000), title: str(an.call_summary_title, 200),
    successful: ok === "success" || ok === "failure" ? ok : ok ? "unknown" : null, collected, has_audio: d?.has_audio === true,
  };
}

/** Never let a provider failure take a request down with an unreadable error. */
export function elMessage(e: unknown): string {
  const m = String((e as any)?.message ?? e);
  if (e instanceof ElError && !/^E_/.test(m)) return `${e.status}: ${m}`.slice(0, 400);
  return m.slice(0, 400);
}
export function logEl(fn: string, e: unknown, extra: Record<string, unknown> = {}): void { log({ fn, error: elMessage(e), status: e instanceof ElError ? e.status : undefined, ...extra }); }
