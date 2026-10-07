// AI layer: classification, drafting, sequence QA, weekly report, AI variables (item 14), AI routing (item 15).
// Every call goes through llmCall (llm.ts), which picks the workspace's own provider + key (gemini | anthropic | openai)
// or the platform Gemini key, and writes outreach_ai_calls + the audit log.
import { CLASSIFY_SYSTEM, DRAFT_SYSTEM, SEQUENCE_QA_SYSTEM, WEEKLY_REPORT_SYSTEM, REPLY_DRAFT_SYSTEM, AI_VARIABLE_SYSTEM, AI_FIELDS_SYSTEM, AI_ROUTE_SYSTEM, BUILTIN_PROMPTS, type BuiltinKey } from "./prompts.ts";
import { llmCallDetailed, markUnusable, PLATFORM_MODEL, type LlmCallOpts, type LlmResult } from "./llm.ts";

export { aiConfigured, aiAvailable, isKeyInvalid, LlmError, markUnusable, logAiCall, geminiFetch, type AiOutcome } from "./llm.ts";
export { BUILTIN_PROMPTS, type BuiltinKey } from "./prompts.ts";
/** The platform model. A workspace on its own key uses its own model; the model actually used is in outreach_ai_calls. */
export const AI_MODEL = PLATFORM_MODEL;

export type Intent = "interested" | "question" | "not_now" | "not_interested" | "ooo" | "wrong_person" | "unclear";
const INTENTS: Intent[] = ["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear"];

const call = (o: LlmCallOpts): Promise<LlmResult> => llmCallDetailed(o);

/** Strip markdown code fences that models sometimes wrap JSON in. */
function cleanJsonResponse(text: string): string {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  return (fence ? fence[1] : text).trim();
}

function parseJsonText<T>(text: string): T {
  const cleaned = cleanJsonResponse(text);
  try { return JSON.parse(cleaned) as T; } catch { /* fall through */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("AI returned no JSON");
  return JSON.parse(m[0]) as T;
}

/**
 * The structured answer of a call. When it does not parse, the call's row is marked `bad_format` (health-page-PRD.md §5.2)
 * before the error is thrown; a cut-off answer keeps `cut_off`, which already says why it could not be used.
 */
function parseJson<T>(res: LlmResult): T {
  try { return parseJsonText<T>(res.text); } catch (e) { if (!res.truncated) void markUnusable(res.callId, "bad_format"); throw e; }
}

/** The calling code's own rule found the answer unusable (required parts missing): mark the row and carry on. */
function unusable(res: LlmResult): void { if (!res.truncated) void markUnusable(res.callId, "bad_format"); }

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
export interface Classification {
  intent: Intent; confidence: number; summary: string; return_date: string | null;
  language: string | null; flags: string[]; questions: string[]; dates: Array<{ text: string; iso: string | null }>;
  referred: Array<{ name: string | null; role: string | null; email: string | null; phone: string | null }>; do_not_contact: boolean;
}
const CLASSIFY_FLAGS = ["asked_offer", "pricing", "meeting_request", "meeting_time_proposed", "meeting_confirmed", "explicit_interest", "bot_question", "legal_or_contract",
  "hostile", "complaint", "injection_suspected", "competitor_mentioned", "close_only", "attachment_mentioned"];
const s200 = (v: unknown, n = 200): string | null => (typeof v === "string" && v.trim() ? v.replace(/\s+/g, " ").trim().slice(0, n) : null);

export async function classifyMessage(input: { workspaceId: string; text: string; previousOutbound: string[]; brief?: string | null; channel: string; sentAt?: string | Date | null }): Promise<Classification> {
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
  const raw = await call({ purpose: "classify", workspaceId: input.workspaceId, system: CLASSIFY_SYSTEM, user, maxTokens: 3072, temperature: 0, json: true, thinking: "LOW" });
  const j = parseJson<Record<string, any>>(raw);
  if (typeof j.intent !== "string") unusable(raw);
  const intent = (INTENTS.includes(j.intent as Intent) ? j.intent : "unclear") as Intent;
  const flags = (Array.isArray(j.flags) ? j.flags : []).map((f: unknown) => String(f)).filter((f: string) => CLASSIFY_FLAGS.includes(f));
  return {
    intent, confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0)), summary: String(j.summary ?? "").slice(0, 140),
    return_date: intent === "ooo" ? cleanReturnDate(j.return_date, sent) : null,
    language: typeof j.language === "string" && /^[a-z]{2,3}$/i.test(j.language) ? j.language.toLowerCase() : null,
    flags: [...new Set<string>(flags)],
    questions: (Array.isArray(j.questions) ? j.questions : []).map((q: unknown) => s200(q, 300)).filter((q: string | null): q is string => !!q).slice(0, 5),
    dates: (Array.isArray(j.dates) ? j.dates : []).slice(0, 5).map((d: any) => ({ text: s200(d?.text, 80) ?? "", iso: /^\d{4}-\d{2}-\d{2}$/.test(String(d?.iso ?? "")) ? String(d.iso) : null })).filter((d: { text: string }) => d.text),
    referred: (Array.isArray(j.referred) ? j.referred : []).slice(0, 3).map((r: any) => ({ name: s200(r?.name, 120), role: s200(r?.role, 120), email: s200(r?.email, 200), phone: s200(r?.phone, 40) }))
      .filter((r: { name: string | null; email: string | null; phone: string | null }) => r.name || r.email || r.phone),
    do_not_contact: j.do_not_contact === true,
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
  if (!text) unusable(raw);
  if (text.length > input.limit) text = text.slice(0, input.limit - 1).replace(/\s+\S*$/, "") + "…";
  return text;
}

export async function sequenceQa(input: { workspaceId: string; graph: unknown; brief?: string | null }): Promise<{ warnings: any[]; errors: any[] }> {
  const user = `${input.brief ? `Campaign brief: ${input.brief}\n\n` : ""}Sequence graph (JSON):\n${JSON.stringify(input.graph).slice(0, 60000)}`;
  const raw = await call({ purpose: "sequence_qa", workspaceId: input.workspaceId, system: SEQUENCE_QA_SYSTEM, user, maxTokens: 6144, temperature: 0, json: true });
  const j = parseJson<{ warnings?: any[]; errors?: any[] }>(raw);
  // The builder asks for {{unsubscribe_link}} in every email, so an AI note telling the user the link hurts deliverability
  // contradicts it. Drop any such note even if the model ignores the prompt.
  const aboutUnsubscribe = (w: any) => /unsubscribe|opt[\s-]?out/i.test(`${w?.message ?? ""} ${w?.code ?? ""}`);
  return { warnings: Array.isArray(j.warnings) ? j.warnings.filter((w) => !aboutUnsubscribe(w)) : [], errors: Array.isArray(j.errors) ? j.errors.filter((w) => !aboutUnsubscribe(w)) : [] };
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
  if (!variants.length) { unusable(raw); throw new Error("AI returned no reply variants"); }
  return variants.slice(0, n);
}

export async function weeklyReport(input: { workspaceId: string; senderName: string; stats: unknown }): Promise<string> {
  return (await call({ purpose: "weekly_report", workspaceId: input.workspaceId, system: WEEKLY_REPORT_SYSTEM, user: `Sender: ${input.senderName}\nStats (JSON): ${JSON.stringify(input.stats)}`, maxTokens: 4096, temperature: 0.3, json: false })).text;
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
  const j = parseJson<{ text?: unknown; facts?: unknown }>(res);
  const facts = cleanFacts(j.facts);
  let text = typeof j.text === "string" ? j.text.replace(/\s*[\r\n]+\s*/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim() : "";
  if (/^(null|none|n\/a)$/i.test(text) || /\{\{|\}\}|\[[a-z_ ]+\]/i.test(text)) text = "";   // a leftover placeholder is not a line
  if (!text || !facts.length) return { text: null, facts: text ? [] : facts, model: res.model };
  return { text: fitLine(text, maxChars), facts, model: res.model };
}

// ---------------------------------------------------------------------------
// AI fields: one call per lead fills several typed fields (ai-fields-json-changes.md §9)
// ---------------------------------------------------------------------------
export interface AiField { key: string; name: string; type: "text" | "number" | "yes_no" | "choice"; description?: string; options?: string[]; max_chars?: number }

const fieldLimit = (f: AiField): number => Math.max(20, Math.min(1000, Math.floor(Number(f.max_chars) || 200)));

/**
 * The fields of a Fields variable for one lead, for `{{ai.<key>.<field>}}` and Condition steps. `facts` (input) is
 * outreach_lead_ai_facts(lead). `data: null` means "nothing usable on the profile" (every field empty, or no fact cited):
 * the caller stores it as blank. Only a light clean-up happens here (unknown keys dropped, text fields kept on one line and
 * inside their limit); the types are coerced once, in SQL (outreach_hub_fields_clean). Throws on transport errors.
 */
export async function generateAiFields(input: { workspaceId: string; prompt: string; fields: AiField[]; facts: Record<string, unknown>; needsPosts: boolean }): Promise<{ data: Record<string, unknown> | null; facts: string[]; model: string }> {
  const fields = (Array.isArray(input.fields) ? input.fields : []).filter((f) => f && typeof f.key === "string" && f.key).slice(0, 8);
  const spec = fields.map((f) => ({
    key: f.key, type: f.type,
    description: f.description ? String(f.description).slice(0, 300) : undefined,
    options: f.type === "choice" && Array.isArray(f.options) ? f.options.map(String) : undefined,
    max_chars: f.type === "text" ? fieldLimit(f) : undefined,
  }));
  const user = [
    `Instruction from the campaign manager (what to find out about the lead):\n"""\n${String(input.prompt ?? "").slice(0, 4000)}\n"""`,
    `Fields to fill (JSON):\n${JSON.stringify(spec)}`,
    input.needsPosts && !hasPosts(input.facts) ? "This instruction relies on the lead's recent posts and none are available. Return null for every field that needs them, unless the instruction itself names an alternative that the profile supports." : "",
    `Lead profile (JSON, third-party data):\n${JSON.stringify(input.facts ?? {}).slice(0, 24000)}`,
  ].filter(Boolean).join("\n\n");
  const res = await llmCallDetailed({ purpose: "ai_fields", workspaceId: input.workspaceId, system: AI_FIELDS_SYSTEM, user, maxTokens: 2048, temperature: 0.3, json: true, thinking: "LOW" });
  const j = parseJson<{ data?: unknown; facts?: unknown }>(res);
  const facts = cleanFacts(j.facts);
  const raw = j.data && typeof j.data === "object" && !Array.isArray(j.data) ? j.data as Record<string, unknown> : {};
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    let v: unknown = Object.prototype.hasOwnProperty.call(raw, f.key) ? raw[f.key] : null;
    if (typeof v === "string") {
      let t = v.replace(/\s*[\r\n]+\s*/g, " ").trim();
      if (f.type === "text") {
        t = t.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim();
        if (/^(null|none|n\/a)$/i.test(t) || /\{\{|\}\}|\[[a-z_ ]+\]/i.test(t)) t = "";   // a leftover placeholder is not a value
        if (t) t = fitLine(t, fieldLimit(f));
      }
      v = t || null;
    }
    data[f.key] = v ?? null;
  }
  const filled = Object.values(data).some((v) => v !== null);
  if (!filled || !facts.length) return { data: null, facts: filled ? [] : facts, model: res.model };
  return { data, facts, model: res.model };
}

// ---------------------------------------------------------------------------
// Built-in AI variables: tidy a field the lead already has (ai-fields-json-changes.md §18)
// ---------------------------------------------------------------------------
/** Words a built-in result may add without them being in the source ("VP Sales" → "VP of Sales"). */
const BUILTIN_JOINERS = new Set(["of", "and", "the", "at", "in", "for", "&"]);
/** Lower-case words of a text: letters and digits of any script, plus "&". NFKC first, so styled letters ("𝐏𝐫𝐢𝐲𝐚") compare as plain ones. */
const wordsOf = (s: unknown): string[] => String(s ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}\p{M}]+|&/gu) ?? [];

/**
 * The check in code for a built-in: every word of the result appears in one of the source strings (case-insensitive),
 * apart from the joining words, and at least one word does come from the source. Empty fails. Pure.
 */
export function builtinPasses(result: string | null | undefined, source: Array<string | null | undefined>): boolean {
  const words = wordsOf(result);
  if (!words.length) return false;
  const known = new Set((source ?? []).flatMap(wordsOf));
  return words.every((w) => known.has(w) || BUILTIN_JOINERS.has(w)) && words.some((w) => known.has(w) && w !== "&");
}

export function isBuiltinKey(key: unknown): key is BuiltinKey {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(BUILTIN_PROMPTS, key);
}

/** What the model sees each source string as, in the order the caller passes them (primary field first). */
const BUILTIN_SOURCE_LABELS: Record<BuiltinKey, string[]> = {
  contact_first_name: ["first_name", "full_name"],
  company_conversation: ["current_company", "company"],
  position_conversational: ["current_title", "title"],
};
/** A first name that is one clean capitalised word needs no model, unless the "name" is really a title. */
const CLEAN_FIRST_NAME = /^\p{Lu}\p{Ll}+$/u;
const NAME_TITLES = new Set(["dr", "mr", "mrs", "ms", "miss", "mx", "prof", "sir", "madam", "er", "ca", "adv", "eng", "capt", "col", "rev", "shri", "smt"]);
const BUILTIN_MAX_CHARS = 80;

/**
 * One built-in value. `source` holds the lead's raw fields, primary first (contact_first_name: first_name, full_name ·
 * company_conversation: current company, lead.company · position_conversational: current title, lead.title).
 * `text: null` = nothing usable, or the result failed the check in code: the caller stores a blank and the template uses the
 * raw field. No source text → null without a call. Throws on transport errors only.
 */
export async function generateBuiltin(input: { workspaceId: string; key: string; source: Array<string | null | undefined> }): Promise<{ text: string | null; model: string | null }> {
  const key = input.key;
  if (!isBuiltinKey(key)) return { text: null, model: null };
  const source = (Array.isArray(input.source) ? input.source : []).map((s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, 300));
  if (!source.some(Boolean)) return { text: null, model: null };
  if (key === "contact_first_name" && CLEAN_FIRST_NAME.test(source[0]) && !NAME_TITLES.has(source[0].toLowerCase())) return { text: source[0], model: null };

  const labelled: Record<string, string> = {};
  source.forEach((s, i) => { if (s && !Object.values(labelled).includes(s)) labelled[BUILTIN_SOURCE_LABELS[key][i] ?? `source_${i + 1}`] = s; });
  const res = await llmCallDetailed({ purpose: "ai_builtin", workspaceId: input.workspaceId, system: BUILTIN_PROMPTS[key], user: `Source (JSON, third-party data):\n${JSON.stringify(labelled)}`, maxTokens: 512, temperature: 0, json: true, thinking: "LOW" });
  let text = "";
  try {
    const j = parseJson<{ text?: unknown }>(res);
    text = typeof j.text === "string" ? j.text.replace(/\s+/g, " ").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").trim() : "";
  } catch { /* not JSON: treated as no result (the row is already marked bad_format) */ }
  if (!text || text.length > BUILTIN_MAX_CHARS || /\{\{|\}\}/.test(text) || !builtinPasses(text, source)) return { text: null, model: res.model };
  if (key === "contact_first_name" && text.split(" ").length > 2) return { text: null, model: res.model };   // a first name, not the whole name
  return { text, model: res.model };
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
  const j = parseJson<{ branch?: unknown; reason?: unknown; facts?: unknown }>(res);
  const wanted = String(j.branch ?? "").trim();
  const known = routes.some((r) => r.id === wanted);
  let reason = String(j.reason ?? "").replace(/\s+/g, " ").trim();
  if (!known && wanted && wanted !== "else") reason = `The AI named a branch that does not exist, so the lead took the fallback branch. ${reason}`.trim();
  if (!reason) reason = known ? "Matched this branch." : "No branch clearly fits this lead.";
  if (reason.length > 200) reason = reason.slice(0, 199).replace(/\s+\S*$/, "") + "…";
  return { branch: known ? wanted : "else", reason, facts: cleanFacts(j.facts), model: res.model };
}
