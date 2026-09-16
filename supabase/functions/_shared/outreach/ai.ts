// AI layer: classification, drafting, sequence QA, weekly report.
// Uses Google Gemini via the REST API, matching the conventions in utils/azureOpenAiHelper.ts
// (system instruction separated, thinkingConfig MEDIUM + responseMimeType for JSON, thought parts skipped).
import { admin, log, sha256Hex } from "./supabase.ts";
import { CLASSIFY_SYSTEM, DRAFT_SYSTEM, SEQUENCE_QA_SYSTEM, WEEKLY_REPORT_SYSTEM, REPLY_DRAFT_SYSTEM, PROMPT_VERSION } from "./prompts.ts";

const API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
export const AI_MODEL = Deno.env.get("OUTREACH_AI_MODEL") ?? Deno.env.get("GEMINI_MODEL_ID") ?? "gemini-3-flash-preview";
const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}";

export function aiConfigured(): boolean { return !!API_KEY; }

export type Intent = "interested" | "question" | "not_now" | "not_interested" | "ooo" | "wrong_person" | "unclear";
const INTENTS: Intent[] = ["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear"];

interface CallOpts { purpose: string; workspaceId: string | null; system: string; user: string; maxTokens: number; temperature: number; json: boolean; thinking?: "LOW" | "MEDIUM" | "HIGH" }

/** Strip markdown code fences that Gemini sometimes wraps JSON in. */
function cleanJsonResponse(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

/** One request/response round trip. Returns the answer text plus usage + finish reason. */
async function once(o: CallOpts, maxTokens: number, thinkingLevel: string): Promise<{ text: string; usage: any; finishReason: string }> {
  const generationConfig: Record<string, unknown> = {
    temperature: o.temperature,
    // Thinking tokens are drawn from maxOutputTokens, so this budget must cover reasoning AND the answer.
    maxOutputTokens: maxTokens,
    thinkingConfig: { thinkingLevel },
  };
  if (o.json) generationConfig.responseMimeType = "application/json";

  const body = {
    systemInstruction: { parts: [{ text: `${o.system}\n\n[prompt-version ${PROMPT_VERSION}]` }] },
    contents: [{ role: "user", parts: [{ text: o.user }] }],
    generationConfig,
  };

  const url = ENDPOINT.replace("{model}", AI_MODEL).replace("{key}", API_KEY);
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
      if ((r.status === 429 || r.status >= 500) && attempt < 2) { lastErr = new Error(`Gemini ${r.status}`); await new Promise((x) => setTimeout(x, 1000 * (attempt + 1))); continue; }
      if (!r.ok) throw new Error(`Gemini API returned ${r.status}: ${(await r.text()).slice(0, 400)}`);
      res = r; lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt >= 2) break;
      await new Promise((x) => setTimeout(x, 1000 * (attempt + 1)));
    }
  }
  if (!res) throw lastErr ?? new Error("Gemini request failed");
  const data = await res.json();

  const candidate = data.candidates?.[0];
  if (!candidate) throw new Error("No candidates in Gemini response");
  const finishReason = String(candidate.finishReason ?? "");
  if (finishReason === "SAFETY" || finishReason === "PROHIBITED_CONTENT") throw new Error(`Gemini declined the request (${finishReason})`);
  const parts: Array<{ text?: string; thought?: boolean }> = candidate.content?.parts ?? [];
  // Thinking models emit thought parts first; the answer is the last non-thought part.
  let text = "";
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].text && !parts[i].thought) { text = parts[i].text!; break; }
  }
  if (!text) text = parts[0]?.text ?? "";
  return { text: text.trim(), usage: data.usageMetadata ?? {}, finishReason };
}

async function call(o: CallOpts): Promise<string> {
  if (!API_KEY) throw new Error("GEMINI_API_KEY not set");
  const t0 = Date.now();

  let { text, usage, finishReason } = await once(o, o.maxTokens, o.thinking ?? (o.json ? "MEDIUM" : "HIGH"));
  // Reasoning can eat the whole budget and leave the answer truncated or empty: retry once with more
  // room and shallower thinking, which is enough for these structured tasks.
  const truncated = finishReason === "MAX_TOKENS" || !text || (o.json && !text.includes("{"));
  if (truncated) {
    log({ fn: "ai", purpose: o.purpose, retry: "budget", finish_reason: finishReason, chars: text.length });
    const retry = await once(o, o.maxTokens * 4, "LOW");
    if (retry.text) {
      text = retry.text;
      finishReason = retry.finishReason;
      usage = { promptTokenCount: (usage.promptTokenCount ?? 0) + (retry.usage.promptTokenCount ?? 0), candidatesTokenCount: (usage.candidatesTokenCount ?? 0) + (retry.usage.candidatesTokenCount ?? 0) };
    }
  }
  if (!text) throw new Error(`Empty Gemini response (finish_reason=${finishReason})`);

  const [ph, rh] = await Promise.all([sha256Hex(o.system + "\n" + o.user), sha256Hex(text)]);
  try {
    await admin.from("outreach_ai_calls").insert({
      workspace_id: o.workspaceId, purpose: o.purpose, model: AI_MODEL, prompt_sha256: ph, response_sha256: rh,
      tokens_in: usage.promptTokenCount ?? null, tokens_out: usage.candidatesTokenCount ?? null, latency_ms: Date.now() - t0,
    });
    if (o.workspaceId) {
      await admin.from("outreach_audit_log").insert({ workspace_id: o.workspaceId, actor_type: "ai", action: `ai.${o.purpose}`, entity: "ai_call", entity_id: rh.slice(0, 16), diff: { prompt_sha256: ph, response_sha256: rh, model: AI_MODEL } });
    }
  } catch (e) { log({ fn: "ai", warn: "ai_calls insert failed", error: String(e) }); }
  return text;
}

function parseJson<T>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI returned no JSON");
  return JSON.parse(m[0]) as T;
}

export async function classifyMessage(input: { workspaceId: string; text: string; previousOutbound: string[]; brief?: string | null; channel: string }): Promise<{ intent: Intent; confidence: number; summary: string }> {
  const user = [
    input.brief ? `Campaign context: ${input.brief}` : "",
    input.previousOutbound.length ? `Our previous messages (most recent last):\n${input.previousOutbound.map((t, i) => `${i + 1}. ${t.slice(0, 600)}`).join("\n")}` : "No previous outbound message on record.",
    `Channel: ${input.channel}`,
    `Inbound reply to classify:\n"""\n${input.text.slice(0, 4000)}\n"""`,
  ].filter(Boolean).join("\n\n");
  const raw = await call({ purpose: "classify", workspaceId: input.workspaceId, system: CLASSIFY_SYSTEM, user, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
  const j = parseJson<{ intent: string; confidence: number; summary: string }>(raw);
  const intent = (INTENTS.includes(j.intent as Intent) ? j.intent : "unclear") as Intent;
  return { intent, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), summary: String(j.summary ?? "").slice(0, 140) };
}

export async function draftCopy(input: { workspaceId: string; kind: "invite_note" | "message" | "comment"; brief: string; limit: number; lead: Record<string, unknown>; sender: Record<string, unknown>; posts?: Array<{ text: string; date?: string }> }): Promise<string> {
  const user = [
    `Kind: ${input.kind}. Hard limit: ${input.limit} characters.`,
    `Brief from the campaign manager:\n${input.brief}`,
    `Sender: ${JSON.stringify({ name: input.sender.display_name, headline: input.sender.headline ?? null })}`,
    `Lead: ${JSON.stringify({ name: input.lead.full_name, headline: input.lead.headline, company: input.lead.company, title: input.lead.title, location: input.lead.location, custom: input.lead.custom })}`,
    input.posts?.length ? `Lead's recent posts:\n${input.posts.map((p) => `- (${p.date ?? ""}) ${String(p.text).slice(0, 500)}`).join("\n")}` : "No recent posts available.",
  ].join("\n\n");
  const raw = await call({ purpose: `draft_${input.kind}`, workspaceId: input.workspaceId, system: DRAFT_SYSTEM, user, maxTokens: input.kind === "invite_note" ? 2048 : 3072, temperature: 0.7, json: true });
  const j = parseJson<{ text: string }>(raw);
  let text = String(j.text ?? "").trim();
  if (text.length > input.limit) text = text.slice(0, input.limit - 1).replace(/\s+\S*$/, "") + "…";
  return text;
}

export async function sequenceQa(input: { workspaceId: string; graph: unknown; brief?: string | null }): Promise<{ warnings: any[]; errors: any[] }> {
  const user = `${input.brief ? `Campaign brief: ${input.brief}\n\n` : ""}Sequence graph (JSON):\n${JSON.stringify(input.graph).slice(0, 60000)}`;
  const raw = await call({ purpose: "sequence_qa", workspaceId: input.workspaceId, system: SEQUENCE_QA_SYSTEM, user, maxTokens: 6144, temperature: 0, json: true });
  const j = parseJson<{ warnings?: any[]; errors?: any[] }>(raw);
  return { warnings: Array.isArray(j.warnings) ? j.warnings : [], errors: Array.isArray(j.errors) ? j.errors : [] };
}

/** Draft 1–3 reply variants for an inbound thread (used by outreach-mcp draft_reply). Never sends. */
export async function draftReply(input: {
  workspaceId: string; channel: string; variants: number;
  thread: Array<{ direction: "in" | "out"; text: string; at: string }>;
  lead: Record<string, unknown>; sender: Record<string, unknown>;
  brief?: string | null; guidance?: string | null;
}): Promise<Array<{ text: string; rationale: string }>> {
  const n = Math.max(1, Math.min(3, input.variants || 1));
  const user = [
    `Channel: ${input.channel}. Variants requested: ${n}.`,
    `Sender (write as this person): ${JSON.stringify({ name: input.sender.display_name, headline: input.sender.headline ?? null })}`,
    `Prospect: ${JSON.stringify({ name: input.lead.full_name, headline: input.lead.headline, company: input.lead.company, title: input.lead.title, location: input.lead.location })}`,
    input.brief ? `Campaign brief that produced the original outreach:\n${String(input.brief).slice(0, 1500)}` : "No campaign brief on record.",
    input.guidance ? `Operator guidance for this reply:\n${String(input.guidance).slice(0, 1000)}` : "",
    `Thread, oldest first (out = sender, in = prospect):\n${input.thread.slice(-20).map((m) => `[${m.direction === "in" ? "PROSPECT" : "SENDER"} ${m.at.slice(0, 16)}] ${m.text.slice(0, 1200)}`).join("\n")}`,
  ].filter(Boolean).join("\n\n");
  const raw = await call({ purpose: "draft_reply", workspaceId: input.workspaceId, system: REPLY_DRAFT_SYSTEM, user, maxTokens: 3072, temperature: 0.6, json: true, thinking: "LOW" });
  const j = parseJson<{ variants?: Array<{ text?: string; rationale?: string }> }>(raw);
  const variants = (Array.isArray(j.variants) ? j.variants : []).map((v) => ({ text: String(v.text ?? "").trim().slice(0, 8000), rationale: String(v.rationale ?? "").slice(0, 200) })).filter((v) => v.text);
  if (!variants.length) throw new Error("AI returned no reply variants");
  return variants.slice(0, n);
}

export async function weeklyReport(input: { workspaceId: string; senderName: string; stats: unknown }): Promise<string> {
  return call({ purpose: "weekly_report", workspaceId: input.workspaceId, system: WEEKLY_REPORT_SYSTEM, user: `Sender: ${input.senderName}\nStats (JSON): ${JSON.stringify(input.stats)}`, maxTokens: 4096, temperature: 0.3, json: false });
}
