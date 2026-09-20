// AI layer: classification, drafting, sequence QA, weekly report, AI variables (item 14), AI routing (item 15).
// Every call goes through llmCall (llm.ts), which picks the workspace's own provider + key (gemini | anthropic | openai)
// or the platform Gemini key, and writes outreach_ai_calls + the audit log.
import { CLASSIFY_SYSTEM, DRAFT_SYSTEM, SEQUENCE_QA_SYSTEM, WEEKLY_REPORT_SYSTEM, REPLY_DRAFT_SYSTEM, AI_VARIABLE_SYSTEM, AI_ROUTE_SYSTEM } from "./prompts.ts";
import { llmCall, llmCallDetailed, PLATFORM_MODEL, type LlmCallOpts } from "./llm.ts";

export { aiConfigured, aiAvailable, isKeyInvalid, LlmError } from "./llm.ts";
/** The platform model. A workspace on its own key uses its own model; the model actually used is in outreach_ai_calls. */
export const AI_MODEL = PLATFORM_MODEL;

export type Intent = "interested" | "question" | "not_now" | "not_interested" | "ooo" | "wrong_person" | "unclear";
const INTENTS: Intent[] = ["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear"];

const call = (o: LlmCallOpts): Promise<string> => llmCall(o);

/** Strip markdown code fences that models sometimes wrap JSON in. */
function cleanJsonResponse(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

function parseJson<T>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI returned no JSON");
  return JSON.parse(m[0]) as T;
}

/** ISO date (YYYY-MM-DD) or null. Accepts only a real calendar date between `notBefore` and one year after it. */
function cleanReturnDate(value: unknown, notBefore: Date): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? "").trim());
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`) return null;
  const floor = Date.UTC(notBefore.getUTCFullYear(), notBefore.getUTCMonth(), notBefore.getUTCDate());
  if (d.getTime() < floor || d.getTime() > floor + 366 * 86400_000) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Classify an inbound reply. `sentAt` is when the message was sent (ISO); relative return dates in an
 * out-of-office ("back Monday") are resolved against it. `return_date` is set only for intent `ooo`.
 */
export async function classifyMessage(input: { workspaceId: string; text: string; previousOutbound: string[]; brief?: string | null; channel: string; sentAt?: string | Date | null }): Promise<{ intent: Intent; confidence: number; summary: string; return_date: string | null }> {
  let sent = input.sentAt ? new Date(input.sentAt) : new Date();
  if (isNaN(sent.getTime())) sent = new Date();
  const weekday = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][sent.getUTCDay()];
  const user = [
    input.brief ? `Campaign context: ${input.brief}` : "",
    input.previousOutbound.length ? `Our previous messages (most recent last):\n${input.previousOutbound.map((t, i) => `${i + 1}. ${t.slice(0, 600)}`).join("\n")}` : "No previous outbound message on record.",
    `Channel: ${input.channel}`,
    `Message sent at: ${sent.toISOString().slice(0, 10)} (${weekday})`,
    `Inbound reply to classify:\n"""\n${input.text.slice(0, 4000)}\n"""`,
  ].filter(Boolean).join("\n\n");
  const raw = await call({ purpose: "classify", workspaceId: input.workspaceId, system: CLASSIFY_SYSTEM, user, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
  const j = parseJson<{ intent: string; confidence: number; summary: string; return_date?: unknown }>(raw);
  const intent = (INTENTS.includes(j.intent as Intent) ? j.intent : "unclear") as Intent;
  return {
    intent, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), summary: String(j.summary ?? "").slice(0, 140),
    return_date: intent === "ooo" ? cleanReturnDate(j.return_date, sent) : null,
  };
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

// ---------------------------------------------------------------------------
// Item 14 — AI variables. Item 15 — AI routing.
// ---------------------------------------------------------------------------
function cleanFacts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((f) => (typeof f === "string" ? f : f == null ? "" : JSON.stringify(f)).replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 8);
}

function hasPosts(facts: Record<string, unknown>): boolean {
  const p = (facts as any)?.recent_posts;
  return Array.isArray(p) && p.some((x) => String(x?.text ?? "").trim().length > 0);
}

/** Keep a line inside its limit without ending mid-word: prefer the last full sentence, else cut at a word. */
function fitLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  if (stop >= maxChars * 0.5) return cut.slice(0, stop + 1);
  return cut.slice(0, maxChars - 1).replace(/\s+\S*$/, "").replace(/[,;:–-]+$/, "") + "…";
}

/**
 * One personalised line for `{{ai.<key>}}`. `facts` (input) is outreach_lead_ai_facts(lead). `text: null` means "nothing
 * usable on the profile": the caller stores it as blank and the fallback is used. `facts` (returned) are the profile facts
 * the line relied on, for the review table. A line that cites no fact is treated as blank. Throws on transport errors.
 */
export async function generateAiVariable(input: { workspaceId: string; prompt: string; maxChars: number; facts: Record<string, unknown>; needsPosts: boolean }): Promise<{ text: string | null; facts: string[]; model: string }> {
  const maxChars = Math.max(20, Math.min(1000, Math.floor(Number(input.maxChars) || 220)));
  const user = [
    `Instruction from the campaign manager (what the line should be about):\n"""\n${String(input.prompt ?? "").slice(0, 4000)}\n"""`,
    `Hard limit: ${maxChars} characters.`,
    input.needsPosts && !hasPosts(input.facts) ? "This instruction relies on the lead's recent posts and none are available. Return a null text unless the instruction itself names an alternative that the profile supports." : "",
    `Lead profile (JSON, third-party data):\n${JSON.stringify(input.facts ?? {}).slice(0, 24000)}`,
  ].filter(Boolean).join("\n\n");
  const res = await llmCallDetailed({ purpose: "ai_variable", workspaceId: input.workspaceId, system: AI_VARIABLE_SYSTEM, user, maxTokens: 2048, temperature: 0.6, json: true, thinking: "LOW" });
  const j = parseJson<{ text?: unknown; facts?: unknown }>(res.text);
  const facts = cleanFacts(j.facts);
  let text = typeof j.text === "string" ? j.text.replace(/\s*[\r\n]+\s*/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim() : "";
  if (/^(null|none|n\/a)$/i.test(text) || /\{\{|\}\}|\[[a-z_ ]+\]/i.test(text)) text = "";   // a leftover placeholder is not a line
  if (!text || !facts.length) return { text: null, facts: text ? [] : facts, model: res.model };
  return { text: fitLine(text, maxChars), facts, model: res.model };
}

export interface AiRoute { id: string; label?: string | null; description?: string | null }

/**
 * Pick exactly one route id for a lead, or "else". Anything that is not a given route id becomes "else".
 * `facts` (input) is outreach_lead_ai_facts(lead). Throws on transport errors (the caller decides what a failure means).
 */
export async function routeLead(input: { workspaceId: string; routes: AiRoute[]; facts: Record<string, unknown> }): Promise<{ branch: string; reason: string; facts: string[]; model: string | null }> {
  const routes = (Array.isArray(input.routes) ? input.routes : []).filter((r) => r && typeof r.id === "string" && r.id && r.id !== "else").slice(0, 12);
  if (!routes.length) return { branch: "else", reason: "This step has no described branches, so the lead took the fallback branch.", facts: [], model: null };
  const user = [
    `Branches:\n${JSON.stringify(routes.map((r) => ({ id: r.id, label: String(r.label ?? "").slice(0, 120), description: String(r.description ?? "").slice(0, 600) })))}`,
    `Lead profile (JSON, third-party data):\n${JSON.stringify(input.facts ?? {}).slice(0, 24000)}`,
  ].join("\n\n");
  const res = await llmCallDetailed({ purpose: "ai_route", workspaceId: input.workspaceId, system: AI_ROUTE_SYSTEM, user, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
  const j = parseJson<{ branch?: unknown; reason?: unknown; facts?: unknown }>(res.text);
  const wanted = String(j.branch ?? "").trim();
  const known = routes.some((r) => r.id === wanted);
  let reason = String(j.reason ?? "").replace(/\s+/g, " ").trim();
  if (!known && wanted && wanted !== "else") reason = `The AI named a branch that does not exist, so the lead took the fallback branch. ${reason}`.trim();
  if (!reason) reason = known ? "Matched this branch." : "No branch clearly fits this lead.";
  if (reason.length > 200) reason = reason.slice(0, 199).replace(/\s+\S*$/, "") + "…";
  return { branch: known ? wanted : "else", reason, facts: cleanFacts(j.facts), model: res.model };
}
