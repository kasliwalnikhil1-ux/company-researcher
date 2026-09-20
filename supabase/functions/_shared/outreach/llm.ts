// LLM transport with bring-your-own key (item 14).
// A workspace may store its own provider + key in outreach_workspace_secrets (service only). Without one the platform
// Gemini key is used. Three transports, plain fetch, no SDKs: Gemini generateContent, Anthropic Messages, OpenAI Chat Completions.
// A workspace key that the provider rejects NEVER falls back to the platform key: it raises E_AI_KEY_INVALID.
import { admin, log, sha256Hex } from "./supabase.ts";
import { decrypt } from "./crypto.ts";
import { PROMPT_VERSION } from "./prompts.ts";

export type LlmProvider = "gemini" | "anthropic" | "openai";
export type ThinkingLevel = "LOW" | "MEDIUM" | "HIGH";
export const LLM_PROVIDERS: LlmProvider[] = ["gemini", "anthropic", "openai"];

const PLATFORM_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
/** The platform (Gemini) model. Workspaces on their own key use their own model. */
export const PLATFORM_MODEL = Deno.env.get("OUTREACH_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL_ID") ?? "gemini-3-flash-preview";
export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gemini: PLATFORM_MODEL,
  anthropic: Deno.env.get("OUTREACH_ANTHROPIC_MODEL") ?? "claude-sonnet-5",
  openai: Deno.env.get("OUTREACH_OPENAI_MODEL") ?? "gpt-5-mini",
};

const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

export interface LlmConfig { provider: LlmProvider; model: string; key: string; own: boolean }
export interface LlmCallOpts { workspaceId: string | null; purpose: string; system: string; user: string; maxTokens: number; temperature: number; json: boolean; thinking?: ThinkingLevel }
export interface LlmResult { text: string; provider: LlmProvider; model: string; ownKey: boolean }

/** Errors carry an `E_CODE: message` text so errorResponse() and parseError() map them. */
export class LlmError extends Error {
  code: string; status: number | null; provider: LlmProvider | null;
  constructor(code: string, message: string, status: number | null = null, provider: LlmProvider | null = null) {
    super(`${code}: ${message}`);
    this.code = code; this.status = status; this.provider = provider;
  }
}
export function isKeyInvalid(e: unknown): boolean { return (e as any)?.code === "E_AI_KEY_INVALID" || /^E_AI_KEY_INVALID\b/.test(String((e as any)?.message ?? "")); }

// ---------------------------------------------------------------------------
// Per-workspace config, cached for 60 s in module memory
// ---------------------------------------------------------------------------
const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; cfg: LlmConfig | null }>();

function platformConfig(): LlmConfig | null {
  return PLATFORM_KEY ? { provider: "gemini", model: PLATFORM_MODEL, key: PLATFORM_KEY, own: false } : null;
}

export function clearLlmCache(workspaceId?: string): void { if (workspaceId) cache.delete(workspaceId); else cache.clear(); }

/** The provider this workspace's calls go to: its own key when it has one, else the platform Gemini key, else null. */
export async function resolveLlm(workspaceId: string | null): Promise<LlmConfig | null> {
  if (!workspaceId) return platformConfig();
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.cfg;
  const { data, error } = await admin.from("outreach_workspace_secrets").select("llm_provider, llm_model, llm_key_enc").eq("workspace_id", workspaceId).maybeSingle();
  if (error) throw new LlmError("E_AI_UNAVAILABLE", `could not read the workspace AI settings: ${error.message}`);
  let cfg: LlmConfig | null;
  if (data?.llm_key_enc && LLM_PROVIDERS.includes(data.llm_provider)) {
    let key: string;
    // A stored key we cannot read is a broken workspace key, not a reason to bill the platform key.
    try { key = await decrypt(data.llm_key_enc); } catch { throw new LlmError("E_AI_KEY_INVALID", "the workspace's saved AI key cannot be read. Enter it again in Settings, AI.", null, data.llm_provider); }
    const provider = data.llm_provider as LlmProvider;
    cfg = { provider, model: String(data.llm_model ?? "").trim() || DEFAULT_MODELS[provider], key, own: true };
  } else {
    cfg = platformConfig();
  }
  cache.set(workspaceId, { at: Date.now(), cfg });
  return cfg;
}

/** Sync check. True when the platform key exists, or this workspace's own key is already in the 60 s cache. Prefer `aiAvailable` when you have a workspace. */
export function aiConfigured(workspaceId?: string | null): boolean {
  if (PLATFORM_KEY) return true;
  if (!workspaceId) return false;
  const hit = cache.get(workspaceId);
  return !!(hit && Date.now() - hit.at < CACHE_MS && hit.cfg);
}

/** Async check that reads the workspace's own key: true when the platform key OR the workspace key exists. */
export async function aiAvailable(workspaceId?: string | null): Promise<boolean> {
  if (PLATFORM_KEY) return true;
  if (!workspaceId) return false;
  try { return !!(await resolveLlm(workspaceId)); } catch (e) { return isKeyInvalid(e); /* a key exists, it is just broken: let the call surface E_AI_KEY_INVALID */ }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------
interface TransportReq { system: string; user: string; maxTokens: number; temperature: number; json: boolean; level: ThinkingLevel }
interface TransportRes { text: string; tokensIn: number | null; tokensOut: number | null; truncated: boolean; finish: string }

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
async function post(provider: LlmProvider, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 2) {
        lastErr = new HttpFail(NAMES[provider], r.status, await r.text());
        // OpenAI answers 429 for an empty wallet too; retrying cannot fix that.
        if (/insufficient_quota|exceeded your current quota/i.test((lastErr as HttpFail).message)) throw lastErr;
        await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
        continue;
      }
      if (!r.ok) throw new HttpFail(NAMES[provider], r.status, await r.text());
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
  });
  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error(`No candidates in Gemini response${data.promptFeedback?.blockReason ? ` (${data.promptFeedback.blockReason})` : ""}`);
  const finish = String(candidate.finishReason ?? "");
  if (finish === "SAFETY" || finish === "PROHIBITED_CONTENT") throw new Error(`Gemini declined the request (${finish})`);
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

// Anthropic: current models (Sonnet 5, Opus 4.7+) reject temperature / top_p and budget_tokens, think adaptively by
// default, and take their depth from output_config.effort. Haiku 4.5 and older take temperature and have no effort.
const ANTHROPIC_LEGACY = /haiku|claude-3|claude-(sonnet|opus)-4-(0|1|5)\b|claude-(sonnet|opus)-4-20\d{6}/i;

async function anthropicOnce(cfg: LlmConfig, q: TransportReq): Promise<TransportRes> {
  const legacy = ANTHROPIC_LEGACY.test(cfg.model);
  const body: Record<string, unknown> = {
    model: cfg.model,
    max_tokens: q.maxTokens,   // adaptive thinking draws from this budget too
    system: q.system,
    messages: [{ role: "user", content: q.user }],
  };
  if (legacy) body.temperature = Math.max(0, Math.min(1, q.temperature));
  else body.output_config = { effort: q.level.toLowerCase() };
  const data = await post("anthropic", ANTHROPIC_URL, { "x-api-key": cfg.key, "anthropic-version": "2023-06-01" }, body);
  const finish = String(data.stop_reason ?? "");
  if (finish === "refusal") throw new Error(`Anthropic declined the request${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}`);
  const text = (Array.isArray(data.content) ? data.content : []).filter((b: any) => b?.type === "text" && typeof b.text === "string").map((b: any) => b.text).join("").trim();
  return { text, tokensIn: data.usage?.input_tokens ?? null, tokensOut: data.usage?.output_tokens ?? null, truncated: finish === "max_tokens", finish };
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
  const data = await post("openai", OPENAI_URL, { authorization: `Bearer ${cfg.key}` }, body);
  const choice = data.choices?.[0];
  if (!choice) throw new Error("No choices in OpenAI response");
  const finish = String(choice.finish_reason ?? "");
  if (finish === "content_filter") throw new Error("OpenAI declined the request (content_filter)");
  if (choice.message?.refusal) throw new Error("OpenAI declined the request (refusal)");
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

// ---------------------------------------------------------------------------
// Public calls
// ---------------------------------------------------------------------------
/** One LLM call for a workspace. Returns the answer text plus the provider and model that produced it. */
export async function llmCallDetailed(o: LlmCallOpts): Promise<LlmResult> {
  const cfg = await resolveLlm(o.workspaceId);
  if (!cfg) throw new LlmError("E_AI_UNAVAILABLE", "AI is not configured: no platform key and no workspace key");
  const t0 = Date.now();
  const q: TransportReq = { system: `${o.system}\n\n[prompt-version ${PROMPT_VERSION}]`, user: o.user, maxTokens: o.maxTokens, temperature: o.temperature, json: o.json, level: o.thinking ?? (o.json ? "MEDIUM" : "HIGH") };

  let text = "", finish = "", tokensIn = 0, tokensOut = 0;
  try {
    const first = await once(cfg, q);
    text = first.text; finish = first.finish; tokensIn = first.tokensIn ?? 0; tokensOut = first.tokensOut ?? 0;
    // Reasoning can eat the whole budget and leave the answer truncated or empty: retry once with more
    // room and shallower thinking, which is enough for these structured tasks.
    if (first.truncated || !text || (o.json && !text.includes("{"))) {
      log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, retry: "budget", finish_reason: finish, chars: text.length });
      const retry = await once(cfg, { ...q, maxTokens: o.maxTokens * 4, level: "LOW" });
      if (retry.text) { text = retry.text; finish = retry.finish; tokensIn += retry.tokensIn ?? 0; tokensOut += retry.tokensOut ?? 0; }
    }
  } catch (e) {
    if (authFailure(e)) {
      if (cfg.own) {
        if (o.workspaceId) cache.delete(o.workspaceId);   // pick up a corrected key at once
        log({ fn: "llm", purpose: o.purpose, provider: cfg.provider, workspace_id: o.workspaceId, error: "workspace key rejected", status: e.status });
        throw new LlmError("E_AI_KEY_INVALID", `${NAMES[cfg.provider]} rejected this workspace's API key: ${e.providerMessage}`, e.status, cfg.provider);
      }
      throw new LlmError("E_AI_UNAVAILABLE", `the platform AI key was rejected (${e.status})`, e.status, cfg.provider);
    }
    throw e;
  }
  if (!text) throw new Error(`Empty ${NAMES[cfg.provider]} response (finish_reason=${finish})`);

  const [ph, rh] = await Promise.all([sha256Hex(o.system + "\n" + o.user), sha256Hex(text)]);
  try {
    await admin.from("outreach_ai_calls").insert({
      workspace_id: o.workspaceId, purpose: o.purpose, model: cfg.model, prompt_sha256: ph, response_sha256: rh,
      tokens_in: tokensIn || null, tokens_out: tokensOut || null, latency_ms: Date.now() - t0,
    });
    if (o.workspaceId) {
      await admin.from("outreach_audit_log").insert({ workspace_id: o.workspaceId, actor_type: "ai", action: `ai.${o.purpose}`, entity: "ai_call", entity_id: rh.slice(0, 16), diff: { prompt_sha256: ph, response_sha256: rh, model: cfg.model, provider: cfg.provider, own_key: cfg.own } });
    }
  } catch (e) { log({ fn: "llm", warn: "ai_calls insert failed", error: String(e) }); }
  return { text, provider: cfg.provider, model: cfg.model, ownKey: cfg.own };
}

export async function llmCall(o: LlmCallOpts): Promise<string> {
  return (await llmCallDetailed(o)).text;
}

/** One tiny call to prove a key works before it is saved. Nothing is logged or stored. Throws E_AI_KEY_INVALID with the provider's own message. */
export async function llmTestKey(input: { provider: LlmProvider; model?: string | null; key: string }): Promise<{ provider: LlmProvider; model: string }> {
  const cfg: LlmConfig = { provider: input.provider, model: String(input.model ?? "").trim() || DEFAULT_MODELS[input.provider], key: input.key, own: true };
  try {
    // Room for a reasoning model to think a little and still answer; the answer itself does not matter.
    await once(cfg, { system: "You are a connection test.", user: "Reply with the single word: ok", maxTokens: 512, temperature: 0, json: false, level: "LOW" });
  } catch (e) {
    if (e instanceof HttpFail && e.status !== 429 && e.status < 500 || authFailure(e) || (e instanceof HttpFail && /insufficient_quota|exceeded your current quota/i.test(e.message))) {
      const f = e as HttpFail;
      throw new LlmError("E_AI_KEY_INVALID", `${NAMES[cfg.provider]} did not accept this key${authFailure(e) ? "" : ` with model ${cfg.model}`}: ${f.providerMessage}`, f.status, cfg.provider);
    }
    if (e instanceof HttpFail || (e as any)?.name === "TimeoutError" || e instanceof TypeError) throw new LlmError("E_AI_UNAVAILABLE", `could not reach ${NAMES[cfg.provider]} to check the key. Try again in a minute. (${String((e as any)?.message ?? e).slice(0, 200)})`, (e as any)?.status ?? null, cfg.provider);
    // "declined" / "no candidates" on a harmless prompt still proves the key was accepted.
  }
  return { provider: cfg.provider, model: cfg.model };
}
