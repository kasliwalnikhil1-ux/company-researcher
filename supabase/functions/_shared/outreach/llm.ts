// LLM transport with bring-your-own key (item 14) and a switchable platform provider.
// A workspace may store its own provider + key in outreach_workspace_secrets (service only). Without one the platform
// default provider is used: the flag `ai_platform_provider` (Settings → Admin → AI provider), else OUTREACH_AI_PROVIDER,
// else the first provider that has a platform key (Gemini, then Anthropic, then OpenAI). Platform keys: GEMINI_API_KEY,
// ANTHROPIC_API_KEY (+ ANTHROPIC_WORKSPACE_ID for a key that is not scoped to a workspace), OPENAI_API_KEY.
// Three transports, plain fetch, no SDKs: Gemini generateContent, Anthropic Messages, OpenAI Chat Completions.
// A workspace key that the provider rejects NEVER falls back to the platform key: it raises E_AI_KEY_INVALID.
import { admin, log, sha256Hex } from "./supabase.ts";
import { decrypt } from "./crypto.ts";
import { PROMPT_VERSION } from "./prompts.ts";
import { fetchWithHealth, noteCallError } from "../health.ts";

export type LlmProvider = "gemini" | "anthropic" | "openai";
export type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH";
export const LLM_PROVIDERS: LlmProvider[] = ["gemini", "anthropic", "openai"];
export const isLlmProvider = (v: unknown): v is LlmProvider => typeof v === "string" && (LLM_PROVIDERS as string[]).includes(v);

/** One platform key per provider. A provider without a key cannot be the platform default. */
const PLATFORM_KEYS: Record<LlmProvider, string> = {
  gemini: Deno.env.get("GEMINI_API_KEY") ?? "",
  anthropic: Deno.env.get("ANTHROPIC_API_KEY") ?? "",
  openai: Deno.env.get("OPENAI_API_KEY") ?? "",
};
/** An Anthropic user / service-account key that is not scoped to a workspace must name one on every request. */
const ANTHROPIC_WORKSPACE_ID = Deno.env.get("ANTHROPIC_WORKSPACE_ID") ?? "";
/** The platform default provider from the environment; the flag `ai_platform_provider` wins over it. */
const ENV_PROVIDER = (Deno.env.get("OUTREACH_AI_PROVIDER") ?? "").trim().toLowerCase();
/** When neither the flag nor the env names a provider: the first of these with a key. */
const PLATFORM_ORDER: LlmProvider[] = ["gemini", "anthropic", "openai"];

/** The platform Gemini model. Transports that are Gemini-only (audio transcription) use it whatever the default provider is. */
export const GEMINI_MODEL = Deno.env.get("OUTREACH_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL_ID") ?? "gemini-3-flash-preview";
/** Per-provider default model (env), used for the platform key and for a workspace key saved without a model. The flag `ai_platform_models` overrides the platform side. */
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gemini: GEMINI_MODEL,
  anthropic: Deno.env.get("OUTREACH_ANTHROPIC_MODEL") ?? "claude-sonnet-5-5",
  openai: Deno.env.get("OUTREACH_OPENAI_MODEL") ?? "gpt-5-mini",
};
/**
 * The model that writes a reply to a prospect (tier "reply": the inbox reply draft and the auto-reply engine's draft).
 * Worth a stronger model than classification, lines and QA. The flag `ai_platform_reply_models` overrides the platform side.
 */
export const REPLY_MODELS: Record<LlmProvider, string> = {
  gemini: Deno.env.get("OUTREACH_GEMINI_REPLY_MODEL") ?? GEMINI_MODEL,
  anthropic: Deno.env.get("OUTREACH_ANTHROPIC_REPLY_MODEL") ?? "claude-opus-5-5",
  openai: Deno.env.get("OUTREACH_OPENAI_REPLY_MODEL") ?? (Deno.env.get("OUTREACH_OPENAI_MODEL") ?? "gpt-5-mini"),
};
/** Which model a call gets on the platform key: "reply" = a message written for a prospect; everything else is "default". */
export type LlmTier = "default" | "reply";
export const PROVIDER_NAMES: Record<LlmProvider, string> = { gemini: "Google Gemini", anthropic: "Anthropic Claude", openai: "OpenAI" };

// The only file that may name an AI provider's host (health-page-PRD.md D11; scripts/check-health-coverage.mjs enforces it).
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models/";
const GEMINI_URL = `${GEMINI_BASE}{model}:generateContent`;
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

/**
 * One raw Gemini request for a transport this file does not own (audio transcription, the website assistant's SSE stream),
 * measured under the given purpose. `own` marks a workspace key (counted apart, D13). The caller reads the Response.
 */
export function geminiFetch(purpose: string, model: string, method: "generateContent" | "streamGenerateContent", key: string, body: unknown, opts: { own?: boolean; stream?: boolean; timeoutMs?: number } = {}): Promise<Response> {
  const url = `${GEMINI_BASE}${encodeURIComponent(model)}:${method}${opts.stream ? "?alt=sse" : ""}`;
  return fetchWithHealth("ai", purpose, url, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000) }, { own: opts.own });
}

export interface LlmConfig {
  provider: LlmProvider; model: string; key: string; own: boolean;
  /** Extra request headers the key needs (the platform Anthropic key's workspace id). Never stored. */
  headers?: Record<string, string>;
}
export interface LlmCallOpts {
  workspaceId: string | null; purpose: string; system: string; user: string; maxTokens: number; temperature: number; json: boolean; thinking?: ThinkingLevel;
  /** "reply" for a message written to a prospect: the platform's reply model (REPLY_MODELS / flag). A workspace on its own key always uses its own model. */
  tier?: LlmTier;
  /** A different model on the PLATFORM key only (e.g. a cheaper verifier); it must belong to the platform provider. A workspace on its own key always uses its own model. */
  platformModel?: string | null;
}
export interface LlmResult { text: string; provider: LlmProvider; model: string; ownKey: boolean; callId: number | null; truncated: boolean }

/** What became of an AI call (health-page-PRD.md §5.2). The first three are the provider's doing; the rest are "answered, but unusable". */
export type AiOutcome = "ok" | "provider_error" | "timeout" | "empty" | "cut_off" | "refused" | "bad_format";

export interface AiCallLog {
  workspaceId: string | null; purpose: string; model: string | null; outcome: AiOutcome; httpStatus?: number | null; attempts?: number;
  ownKey?: boolean; promptSha?: string | null; responseSha?: string | null; tokensIn?: number | null; tokensOut?: number | null; latencyMs?: number | null;
}

/** One outreach_ai_calls row. Never throws. Returns the row id so the caller can mark the answer unusable later. */
export async function logAiCall(c: AiCallLog): Promise<number | null> {
  try {
    const { data, error } = await admin.from("outreach_ai_calls").insert({
      workspace_id: c.workspaceId, purpose: c.purpose, model: c.model, prompt_sha256: c.promptSha ?? null, response_sha256: c.responseSha ?? null,
      tokens_in: c.tokensIn || null, tokens_out: c.tokensOut || null, latency_ms: c.latencyMs ?? null,
      outcome: c.outcome, http_status: c.httpStatus ?? null, attempts: Math.max(1, c.attempts ?? 1), own_key: !!c.ownKey,
    }).select("id").single();
    if (error) throw error;
    return data?.id ?? null;
  } catch (e) { log({ fn: "llm", warn: "ai_calls insert failed", error: String((e as any)?.message ?? e) }); return null; }
}

/**
 * The calling code found the answer unusable by its own rules (required parts missing, a value outside its limits): the
 * row's outcome becomes `bad_format` (or the given one) and the AI check counts it. Never throws.
 */
export async function markUnusable(callId: number | null | undefined, outcome: Exclude<AiOutcome, "ok"> = "bad_format"): Promise<void> {
  if (!callId) return;
  try { await admin.from("outreach_ai_calls").update({ outcome }).eq("id", callId); } catch (e) { log({ fn: "llm", warn: "markUnusable failed", error: String(e) }); }
}

/** Errors carry an `E_CODE: message` text so errorResponse() and parseError() map them. */
export class LlmError extends Error {
  code: string; status: number | null; provider: LlmProvider | null;
  constructor(code: string, message: string, status: number | null = null, provider: LlmProvider | null = null) {
    super(`${code}: ${message}`);
    this.code = code; this.status = status; this.provider = provider;
  }
}
export function isKeyInvalid(e: unknown): boolean { return (e as any)?.code === "E_AI_KEY_INVALID" || /^E_AI_KEY_INVALID\b/.test(String((e as any)?.message ?? "")); }

// What people see when an AI call fails. Never the provider's name, status or raw message: those go to the logs only.
export const AI_BUSY_MESSAGE = "AI is busy right now. Please try again later.";
export const AI_KEY_MESSAGE = "Your AI key didn't work. Check it in AI → Setup.";

// ---------------------------------------------------------------------------
// The platform default: which provider, which model, and why (cached for 60 s in module memory)
// ---------------------------------------------------------------------------
const CACHE_MS = 60_000;

export interface PlatformAi {
  /** The provider platform calls go to right now, or null when no platform key exists at all. */
  provider: LlmProvider | null;
  model: string | null;
  /** Where the choice came from: the admin flag, the env, the first configured provider, or nothing is configured. */
  source: "flag" | "env" | "auto" | "none";
  /** The provider the flag / env asked for, when it differs from `provider` because it has no key. */
  wanted: LlmProvider | null;
  fallback_reason: string | null;
  /** Which providers have a platform key. */
  configured: Record<LlmProvider, boolean>;
  /** The model each provider would use as the platform default (flag override, else env default). */
  models: Record<LlmProvider, string>;
  /** The env / built-in default per provider, for the admin screen's placeholders. */
  default_models: Record<LlmProvider, string>;
  /** The model that writes replies to prospects, per provider (flag override, else env default), and the env defaults. */
  reply_models: Record<LlmProvider, string>;
  default_reply_models: Record<LlmProvider, string>;
  /** The reply model of the provider in use. */
  reply_model: string | null;
}

let platformCache: { at: number; p: PlatformAi } | null = null;

/** True when at least one platform key exists (the sync part of `aiConfigured`). */
const PLATFORM_ANY_KEY = PLATFORM_ORDER.some((p) => !!PLATFORM_KEYS[p]);

/** Read the platform default. Flag reads that fail fall back to the env so a database blip never turns AI off. */
export async function platformAi(): Promise<PlatformAi> {
  if (platformCache && Date.now() - platformCache.at < CACHE_MS) return platformCache.p;
  let flagProvider: string | null = null;
  let flagModels: Record<string, unknown> = {};
  let flagReplyModels: Record<string, unknown> = {};
  const asMap = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  try {
    const { data, error } = await admin.from("outreach_flags").select("key, value").in("key", ["ai_platform_provider", "ai_platform_models", "ai_platform_reply_models"]);
    if (error) throw error;
    for (const r of data ?? []) {
      if (r.key === "ai_platform_provider" && typeof r.value === "string") flagProvider = r.value.trim().toLowerCase();
      else if (r.key === "ai_platform_models") flagModels = asMap(r.value);
      else if (r.key === "ai_platform_reply_models") flagReplyModels = asMap(r.value);
    }
  } catch (e) { log({ fn: "llm", warn: "could not read the platform AI flags; using the environment", error: String((e as any)?.message ?? e) }); }

  const models = { ...DEFAULT_MODELS };
  const reply_models = { ...REPLY_MODELS };
  for (const p of LLM_PROVIDERS) {
    const m = typeof flagModels[p] === "string" ? String(flagModels[p]).trim() : "";
    if (m) models[p] = m;
    const rm = typeof flagReplyModels[p] === "string" ? String(flagReplyModels[p]).trim() : "";
    if (rm) reply_models[p] = rm;
  }
  const configured: Record<LlmProvider, boolean> = { gemini: !!PLATFORM_KEYS.gemini, anthropic: !!PLATFORM_KEYS.anthropic, openai: !!PLATFORM_KEYS.openai };
  let wanted: LlmProvider | null = null;
  let source: PlatformAi["source"] = "auto";
  if (isLlmProvider(flagProvider)) { wanted = flagProvider; source = "flag"; }
  else if (isLlmProvider(ENV_PROVIDER)) { wanted = ENV_PROVIDER; source = "env"; }
  let provider: LlmProvider | null = wanted && configured[wanted] ? wanted : null;
  let fallback_reason: string | null = null;
  if (!provider) {
    provider = PLATFORM_ORDER.find((p) => configured[p]) ?? null;
    if (wanted) {
      fallback_reason = `${PROVIDER_NAMES[wanted]} is the default but has no platform key${provider ? `; using ${PROVIDER_NAMES[provider]}` : ""}`;
      log({ fn: "llm", warn: fallback_reason, wanted, using: provider });
    }
    if (!provider) source = "none";
  }
  const p: PlatformAi = {
    provider, model: provider ? models[provider] : null, source, wanted: wanted && wanted !== provider ? wanted : null, fallback_reason, configured,
    models, default_models: { ...DEFAULT_MODELS }, reply_models, default_reply_models: { ...REPLY_MODELS }, reply_model: provider ? reply_models[provider] : null,
  };
  platformCache = { at: Date.now(), p };
  return p;
}

async function platformConfig(tier: LlmTier = "default"): Promise<LlmConfig | null> {
  const p = await platformAi();
  if (!p.provider || !p.model) return null;
  const cfg: LlmConfig = { provider: p.provider, model: tier === "reply" ? p.reply_models[p.provider] : p.model, key: PLATFORM_KEYS[p.provider], own: false };
  if (p.provider === "anthropic" && ANTHROPIC_WORKSPACE_ID) cfg.headers = { "anthropic-workspace-id": ANTHROPIC_WORKSPACE_ID };
  return cfg;
}

// ---------------------------------------------------------------------------
// Per-workspace config, cached for 60 s in module memory (`null` = the workspace has no key of its own)
// ---------------------------------------------------------------------------
const cache = new Map<string, { at: number; own: LlmConfig | null }>();

/** Forget the cached choices: a workspace's own key, or (no argument) every workspace and the platform default. */
export function clearLlmCache(workspaceId?: string): void {
  if (workspaceId) { cache.delete(workspaceId); return; }
  cache.clear(); platformCache = null;
}

/** The provider this workspace's calls go to: its own key when it has one, else the platform default (the reply model for tier "reply"), else null. */
export async function resolveLlm(workspaceId: string | null, tier: LlmTier = "default"): Promise<LlmConfig | null> {
  if (!workspaceId) return platformConfig(tier);
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.own ?? platformConfig(tier);
  const { data, error } = await admin.from("outreach_workspace_secrets").select("llm_provider, llm_model, llm_key_enc").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new LlmError("E_AI_UNAVAILABLE", `could not read the workspace AI settings: ${error.message}`);
  let own: LlmConfig | null = null;
  if (data?.llm_key_enc && isLlmProvider(data.llm_provider)) {
    let key: string;
    // A stored key we cannot read is a broken workspace key, not a reason to bill the platform key.
    try { key = await decrypt(data.llm_key_enc); } catch { throw new LlmError("E_AI_KEY_INVALID", "the workspace's saved AI key cannot be read. Enter it again in Settings, AI.", null, data.llm_provider); }
    const provider = data.llm_provider;
    own = { provider, model: String(data.llm_model ?? "").trim() || DEFAULT_MODELS[provider], key, own: true };
  }
  cache.set(workspaceId, { at: Date.now(), own });
  return own ?? platformConfig(tier);
}

/** Sync check. True when a platform key exists, or this workspace's own key is already in the 60 s cache. Prefer `aiAvailable` when you have a workspace. */
export function aiConfigured(workspaceId?: string | null): boolean {
  if (PLATFORM_ANY_KEY) return true;
  if (!workspaceId) return false;
  const hit = cache.get(workspaceId);
  return !!(hit && Date.now() - hit.at < CACHE_MS && hit.own);
}

/** Async check that reads the workspace's own key: true when a platform key OR the workspace key exists. */
export async function aiAvailable(workspaceId?: string | null): Promise<boolean> {
  if (PLATFORM_ANY_KEY) return true;
  if (!workspaceId) return false;
  try { return !!(await resolveLlm(workspaceId)); } catch (e) { return isKeyInvalid(e); /* a key exists, it is just broken: let the call surface E_AI_KEY_INVALID */ }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
interface TransportReq { system: string; user: string; maxTokens: number; temperature: number; json: boolean; level: ThinkingLevel; purpose: string; own: boolean; meta: CallMeta }
interface TransportRes { text: string; tokensIn: number | null; tokensOut: number | null; truncated: boolean; finish: string }
/** Per-call counters the transports fill in: how many requests went out, and the last HTTP status seen. */
interface CallMeta { attempts: number; status: number | null }

/** The model declined to answer (a safety stop, a refusal): recorded as `refused`, not as a provider error. */
class Refused extends Error { constructor(message: string) { super(message); this.name = "Refused"; } }
const isTimeout = (e: unknown) => (e as any)?.name === "TimeoutError" || (e as any)?.name === "AbortError";

class HttpFail extends Error {
  status: number; providerMessage: string;
  constructor(provider: string, status: number, body: string) {
    let pm = body.slice(0, 400);
    try { const j = JSON.parse(body); pm = String(j?.error?.message ?? j?.error ?? j?.message ?? pm).slice(0, 400); } catch { /* keep raw */ }
    super(`${provider} API returned ${status}: ${pm}`);
    this.status = status; this.providerMessage = pm;
  }
}

const NAMES: Record<LlmProvider, string> = { gemini: "Gemini", anthropic: "Anthropic", openai: "OpenAI" };

/** POST with the shared retry policy: 3 tries, back off on 429 / 5xx / network errors, 60 s timeout each. */
async function post(provider: LlmProvider, url: string, headers: Record<string, string>, body: unknown, q: TransportReq): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      q.meta.attempts++;
      const r = await fetchWithHealth("ai", q.purpose, url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }, { own: q.own });
      q.meta.status = r.status;
      if ((r.status === 429 || r.status >= 500) && attempt < 2) {
        lastErr = new HttpFail(NAMES[provider], r.status, await r.text());
        noteCallError("ai", q.purpose, (lastErr as HttpFail).providerMessage, q.own);
        // OpenAI answers 429 for an empty wallet too; retrying cannot fix that.
        if (/insufficient_quota|exceeded your current quota/i.test((lastErr as HttpFail).message)) throw lastErr;
        await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) { const f = new HttpFail(NAMES[provider], r.status, await r.text()); noteCallError("ai", q.purpose, f.providerMessage, q.own); throw f; }
      return await r.json();
    } catch (e) {
      lastErr = e;
      if (e instanceof HttpFail && e.status !== 429 && e.status < 500) throw e;   // 4xx is final
      if (e instanceof HttpFail && /insufficient_quota|exceeded your current quota/i.test(e.message)) throw e;
      if (attempt >= 2) break;
      await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error(`${NAMES[provider]} request failed`);
}

async function geminiOnce(cfg: LlmConfig, q: TransportReq): Promise<TransportRes> {
  const generationConfig: Record<string, unknown> = {
    temperature: q.temperature,
    // Thinking tokens are drawn from maxOutputTokens, so this budget must cover reasoning AND the answer.
    maxOutputTokens: q.maxTokens,
  };
  if (/gemini-3/i.test(cfg.model)) generationConfig.thinkingConfig = { thinkingLevel: q.level };
  else if (/gemini-2\.5/i.test(cfg.model)) generationConfig.thinkingConfig = { thinkingBudget: q.level === "LOW" ? 512 : q.level === "MEDIUM" ? 2048 : 8192 };
  if (q.json) generationConfig.responseMimeType = "application/json";
  const data = await post("gemini", GEMINI_URL.replace("{model}", encodeURIComponent(cfg.model)), { "x-goog-api-key": cfg.key }, {
    systemInstruction: { parts: [{ text: q.system }] },
    contents: [{ role: "user", parts: [{ text: q.user }] }],
    generationConfig,
  }, q);
  const candidate = data.candidates?.[0];
  if (!candidate) {
    if (data.promptFeedback?.blockReason) throw new Refused(`Gemini declined the request (${data.promptFeedback.blockReason})`);
    throw new Error("No candidates in Gemini response");
  }
  const finish = String(candidate.finishReason ?? "");
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw new Refused(`Gemini declined the request (${finish})`);
  const parts: Array<{ text?: string; thought?: boolean }> = candidate.content?.parts ?? [];
  // Thinking models emit thought parts first; the answer is the last non-thought part.
  let text = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) { text = parts[i].text!; break; }
  }
  if (!text) text = parts[0]?.text ?? "";
  const u = data.usageMetadata ?? {};
  return { text: text.trim(), tokensIn: u.promptTokenCount ?? null, tokensOut: u.candidatesTokenCount ?? null, truncated: finish === "MAX_TOKENS", finish };
}

// Anthropic: current models (Claude 4.6 and later: Opus 5.5, Sonnet 5.5, Haiku 5.5, ...) reject temperature and
// budget_tokens, think adaptively by default, and take their depth from output_config.effort. Haiku 4.5, Opus/Sonnet 4.0,
// 4.1, 4.5, the Claude 3 family and dated snapshots take temperature and have no effort.
const ANTHROPIC_LEGACY = /claude-3|haiku-4|claude-(sonnet|opus)-4-(0|1|5)\b|-20\d{6}$/i;
/** Models that take the server-side refusal fallback: a safety decline is re-run on a sibling model inside the same call (tested on Opus 5.5 and Haiku 5.5). */
const ANTHROPIC_FALLBACKS = /claude-(opus-5|sonnet-5-5|haiku-5-5|fable)/i;
const ANTHROPIC_JSON_RULE = "Answer with one JSON object and nothing else: no prose before or after it, no code fences.";

/** Exported for the tests: the request shape per model. */
export function anthropicRequest(model: string, q: Pick<TransportReq, "system" | "user" | "maxTokens" | "temperature" | "json" | "level">, stream = false): { body: Record<string, unknown>; headers: Record<string, string> } {
  const legacy = ANTHROPIC_LEGACY.test(model);
  const body: Record<string, unknown> = {
    model,
    max_tokens: q.maxTokens,   // adaptive thinking draws from this budget too
    system: q.json ? `${q.system}\n\n${ANTHROPIC_JSON_RULE}` : q.system,
    messages: [{ role: "user", content: q.user }],
  };
  if (stream) body.stream = true;
  if (legacy) body.temperature = Math.max(0, Math.min(1, q.temperature));
  else body.output_config = { effort: q.level.toLowerCase() };
  const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
  if (!legacy && ANTHROPIC_FALLBACKS.test(model)) { body.fallbacks = "default"; headers["anthropic-beta"] = "server-side-fallback-2026-07-01"; }
  return { body, headers };
}

async function anthropicOnce(cfg: LlmConfig, q: TransportReq): Promise<TransportRes> {
  const { body, headers } = anthropicRequest(cfg.model, q);
  const data = await post("anthropic", ANTHROPIC_URL, { "x-api-key": cfg.key, ...headers, ...(cfg.headers ?? {}) }, body, q);
  const finish = String(data.stop_reason ?? "");
  if (finish === "refusal") throw new Refused(`Anthropic declined the request${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}`);
  const blocks: any[] = Array.isArray(data.content) ? data.content : [];
  const served = blocks.find((b) => b?.type === "fallback");
  if (served) log({ fn: "llm", purpose: q.purpose, provider: "anthropic", fallback: `${served.from?.model ?? cfg.model} declined; ${served.to?.model ?? data.model} answered` });
  const text = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
  return { text, tokensIn: data.usage?.input_tokens ?? null, tokensOut: data.usage?.output_tokens ?? null, truncated: finish === "max_tokens", finish };
}

/**
 * One streaming Anthropic request for a transport this file does not own (the website assistant), measured under the
 * given purpose. The caller reads the SSE body: `content_block_delta` events with a `text_delta`, then `message_delta`
 * with the stop reason and usage.
 */
export function anthropicStreamFetch(purpose: string, cfg: LlmConfig, q: Pick<TransportReq, "system" | "user" | "maxTokens" | "temperature" | "json" | "level">, opts: { timeoutMs?: number } = {}): Promise<Response> {
  const { body, headers } = anthropicRequest(cfg.model, q, true);
  return fetchWithHealth("ai", purpose, ANTHROPIC_URL, { method: "POST", headers: { "content-type": "application/json", "x-api-key": cfg.key, ...headers, ...(cfg.headers ?? {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs ?? 90_000) }, { own: cfg.own });
}

// OpenAI: reasoning models (o-series, gpt-5 family) only take the default temperature and spend reasoning tokens
// out of max_completion_tokens.
const OPENAI_REASONING = /^(o\d|gpt-5)/i;

async function openaiOnce(cfg: LlmConfig, q: TransportReq): Promise<TransportRes> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [{ role: "system", content: q.system }, { role: "user", content: q.user }],
    max_completion_tokens: q.maxTokens,
  };
  if (OPENAI_REASONING.test(cfg.model)) body.reasoning_effort = q.level.toLowerCase();
  else body.temperature = q.temperature;
  if (q.json) body.response_format = { type: "json_object" };
  const data = await post("openai", OPENAI_URL, { authorization: `Bearer ${cfg.key}`, ...(cfg.headers ?? {}) }, body, q);
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No choices in OpenAI response");
  const finish = String(choice.finish_reason ?? "");
  if (finish === "content_filter") throw new Refused("OpenAI declined the request (content_filter)");
  if (choice.message?.refusal) throw new Refused("OpenAI declined the request (refusal)");
  return { text: String(choice.message?.content ?? "").trim(), tokensIn: data.usage?.prompt_tokens ?? null, tokensOut: data.usage?.completion_tokens ?? null, truncated: finish === "length", finish };
}

function once(cfg: LlmConfig, q: TransportReq): Promise<TransportRes> {
  return cfg.provider === "anthropic" ? anthropicOnce(cfg, q) : cfg.provider === "openai" ? openaiOnce(cfg, q) : geminiOnce(cfg, q);
}

/** Does this provider answer mean "the key is bad"? Gemini says 400 API_KEY_INVALID, the others 401 / 403. */
function authFailure(e: unknown): e is HttpFail {
  if (!(e instanceof HttpFail)) return false;
  return e.status === 401 || e.status === 403 || (e.status === 400 && /API[_ ]KEY[_ ]INVALID|API key not valid|API key expired/i.test(e.message));
}
/** An Anthropic user key that is not bound to a workspace: the platform sends ANTHROPIC_WORKSPACE_ID for its own key, a customer must create a workspace-scoped key. */
function needsWorkspace(e: unknown): e is HttpFail { return e instanceof HttpFail && e.status === 400 && /anthropic-workspace-id|not scoped to a workspace/i.test(e.message); }

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------
/** One LLM call for a workspace. Returns the answer text plus the provider and model that produced it. */
export async function llmCallDetailed(o: LlmCallOpts): Promise<LlmResult> {
  const resolved = await resolveLlm(o.workspaceId, o.tier ?? "default");
  if (!resolved) throw new LlmError("E_AI_UNAVAILABLE", "AI is not configured: no platform key and no workspace key");
  const cfg: LlmConfig = !resolved.own && o.platformModel ? { ...resolved, model: o.platformModel } : resolved;
  const t0 = Date.now();
  const meta: CallMeta = { attempts: 0, status: null };
  const q: TransportReq = { system: `${o.system}\n\n[prompt-version ${PROMPT_VERSION}]`, user: o.user, maxTokens: o.maxTokens, temperature: o.temperature, json: o.json, level: o.thinking ?? (o.json ? "MEDIUM" : "HIGH"), purpose: o.purpose, own: cfg.own, meta };
  // One outreach_ai_calls row per call, written after the last retry whatever happened (health-page-PRD.md §5.2).
  const record = (outcome: AiOutcome, extra: { tokensIn?: number; tokensOut?: number; promptSha?: string; responseSha?: string } = {}) =>
    logAiCall({ workspaceId: o.workspaceId, purpose: o.purpose, model: cfg.model, outcome, httpStatus: meta.status, attempts: meta.attempts, ownKey: cfg.own, latencyMs: Date.now() - t0, ...extra });

  let text = "", finish = "", tokensIn = 0, tokensOut = 0, truncated = false;
  try {
    const first = await once(cfg, q);
    text = first.text; finish = first.finish; tokensIn = first.tokensIn ?? 0; tokensOut = first.tokensOut ?? 0; truncated = first.truncated;
    // Reasoning can eat the whole budget and leave the answer truncated or empty: retry once with more
    // room and shallower thinking, which is enough for these structured tasks.
    if (first.truncated || !text || (o.json && !text.includes("{"))) {
      log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, retry: "budget", finish_reason: finish, chars: text.length });
      const retry = await once(cfg, { ...q, maxTokens: o.maxTokens * 4, level: "LOW" });
      if (retry.text) { text = retry.text; finish = retry.finish; tokensIn += retry.tokensIn ?? 0; tokensOut += retry.tokensOut ?? 0; truncated = retry.truncated; }
    }
  } catch (e) {
    if (e instanceof Refused) {
      log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, workspace_id: o.workspaceId, error: String(e.message).slice(0, 300), refused: true });
      await record("refused");
      throw new LlmError("E_AI_BUSY", AI_BUSY_MESSAGE, meta.status, cfg.provider);
    }
    await record(isTimeout(e) ? "timeout" : "provider_error");
    if (authFailure(e) || needsWorkspace(e)) {
      if (cfg.own) {
        if (o.workspaceId) cache.delete(o.workspaceId);   // pick up a corrected key at once
        log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, workspace_id: o.workspaceId, error: "workspace key rejected", status: e.status, detail: e.providerMessage });
        throw new LlmError("E_AI_KEY_INVALID", AI_KEY_MESSAGE, e.status, cfg.provider);
      }
      log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, error: "platform key rejected", status: e.status, detail: e.providerMessage });
      throw new LlmError("E_AI_UNAVAILABLE", AI_BUSY_MESSAGE, e.status, cfg.provider);
    }
    if (e instanceof LlmError) throw e;
    // Quota, rate limits, outages, refusals, timeouts: log the provider's words, show a plain message.
    log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, workspace_id: o.workspaceId, error: String((e as any)?.message ?? e).slice(0, 500), status: (e as any)?.status ?? null });
    throw new LlmError("E_AI_BUSY", AI_BUSY_MESSAGE, (e as any)?.status ?? null, cfg.provider);
  }
  if (!text) {
    log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, error: "empty response", finish_reason: finish });
    await record("empty", { tokensIn, tokensOut });
    throw new LlmError("E_AI_BUSY", AI_BUSY_MESSAGE, null, cfg.provider);
  }

  const [ph, rh] = await Promise.all([sha256Hex(o.system + "\n" + o.user), sha256Hex(text)]);
  // A truncated answer comes back from the provider as a success (D12): it is recorded as cut_off and still returned,
  // because the caller may be able to use it; if it cannot, markUnusable() keeps cut_off (never downgrades to bad_format).
  const callId = await record(truncated ? "cut_off" : "ok", { tokensIn, tokensOut, promptSha: ph, responseSha: rh });
  try {
    if (o.workspaceId) {
      await admin.from("outreach_audit_log").insert({ workspace_id: o.workspaceId, actor_type: "ai", action: `ai.${o.purpose}`, entity: "ai_call", entity_id: rh.slice(0, 16), diff: { prompt_sha256: ph, response_sha256: rh, model: cfg.model, provider: cfg.provider, own_key: cfg.own } });
    }
  } catch (e) { log({ fn: "llm", warn: "audit insert failed", error: String(e) }); }
  return { text, provider: cfg.provider, model: cfg.model, ownKey: cfg.own, callId, truncated };
}

export async function llmCall(o: LlmCallOpts): Promise<string> {
  return (await llmCallDetailed(o)).text;
}

/** One tiny call to prove a key works before it is saved. Nothing is logged or stored. Throws E_AI_KEY_INVALID with the provider's own message. */
export async function llmTestKey(input: { provider: LlmProvider; model?: string | null; key: string }): Promise<{ provider: LlmProvider; model: string }> {
  const cfg: LlmConfig = { provider: input.provider, model: String(input.model ?? "").trim() || DEFAULT_MODELS[input.provider], key: input.key, own: true };
  try {
    // Room for a reasoning model to think a little and still answer; the answer itself does not matter.
    await once(cfg, { system: "You are a connection test.", user: "Reply with the single word: ok", maxTokens: 512, temperature: 0, json: false, level: "LOW", purpose: "test_key", own: true, meta: { attempts: 0, status: null } });
  } catch (e) {
    if (e instanceof HttpFail && e.status !== 429 && e.status < 500 || authFailure(e) || (e instanceof HttpFail && /insufficient_quota|exceeded your current quota/i.test(e.message))) {
      const f = e as HttpFail;
      log({ fn: "llm", purpose: "test_key", provider: cfg.provider, model: cfg.model, status: f.status, detail: f.providerMessage });
      const why = needsWorkspace(e) ? "This Anthropic key is not tied to a workspace. In the Anthropic console, create a key inside a workspace and use that one."
        : authFailure(e) ? "This key didn't work. Check it and try again."
        : "This key didn't work with that model. Check the key and model, then try again.";
      throw new LlmError("E_AI_KEY_INVALID", why, f.status, cfg.provider);
    }
    if (e instanceof HttpFail || (e as any)?.name === "TimeoutError" || e instanceof TypeError) {
      log({ fn: "llm", purpose: "test_key", provider: cfg.provider, error: String((e as any)?.message ?? e).slice(0, 300) });
      throw new LlmError("E_AI_UNAVAILABLE", "Couldn't check the key right now. Try again in a minute.", (e as any)?.status ?? null, cfg.provider);
    }
    // "declined" / "no candidates" on a harmless prompt still proves the key was accepted (a Refused lands here too).
  }
  return { provider: cfg.provider, model: cfg.model };
}
