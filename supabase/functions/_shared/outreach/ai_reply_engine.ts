// AI replies v2 — the ONE drafting engine (ai-replies-changes.md §5.1, docs/outreach/AI-REPLIES-V2-CONTRACT.md §7):
//   buildContext → draft → validate → verify → decide
// used by the cron worker (trigger 'auto'), "Draft with AI" (trigger 'manual') and the simulator. Parity rule: for the same
// chat, inbound messages, prompt version, cards, knowledge and lead notes, the auto and manual prompts are byte-identical
// except the `Trigger:` line of the STATE block and the optional GUIDANCE block (ai_reply_engine_test.ts).
// No database writes here; callers persist the result.
import { rpc, sha256Hex } from "./supabase.ts";
import { llmCallDetailed } from "./llm.ts";
import type { Classification } from "./ai.ts";
import { AI_REPLY_FLOOR, AI_REPLY_DRAFT_SYSTEM, AI_REPLY_VERIFY_SYSTEM } from "./prompts.ts";
import {
  parseDraft, strictest, validateDraft, hasSchedulingLink, CLOSING,
  type DraftOutput, type PromptSettings, type Failure,
} from "./ai_reply_rules.ts";

type Row = Record<string, any>;
const VERIFY_MODEL = Deno.env.get("OUTREACH_AI_VERIFY_MODEL") ?? null;
export const MIN_CONFIDENCE = 0.75;

export const DEFAULT_SETTINGS: PromptSettings = {
  stages: [
    { key: "engage", label: "Engage", early: true }, { key: "relate", label: "Relate", early: true },
    { key: "pitch", label: "Pitch", pitch: true }, { key: "next_step", label: "Next step" },
  ],
  min_exchanges_before_pitch: 2, skip_to_pitch_when: ["asked_offer", "pricing", "meeting_request", "meeting_time_proposed", "explicit_interest"],
  vary_moves_in_early_stages: true, max_ai_replies_per_chat: 6, languages: ["en"], allow_language_switch: false, bot_question: "escalate",
  handoff_stage_id: null, knowledge_source_ids: [], max_length: 600,
};
export const settingsOf = (s: unknown): PromptSettings => ({ ...DEFAULT_SETTINGS, ...((s && typeof s === "object") ? s as Partial<PromptSettings> : {}) });

let floorShaCache: string | null = null;
export async function floorSha(): Promise<string> { return floorShaCache ??= await sha256Hex(AI_REPLY_FLOOR); }

// ============================================================================================ context
export interface ThreadLine { from: "prospect" | "us" | "teammate" | "ai" | "us_sequence" | "us_ai" | "us_teammate"; text: string; at?: string; step?: string | null; answered?: boolean }
export interface DraftState {
  stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number; stage_stale?: boolean;
  /** v2 sessions (§6) */
  session_kind?: "normal" | "returning" | "dormant"; gap_days?: number | null; previous_stage?: string | null; session_count?: number;
}
export interface ScenarioCard { id: string; title: string; when_text: string; do_text: string; enabled?: boolean }
export interface Faq { id: string; question: string; answer: string }
export interface LeadNotes { summary: string | null; items: Array<{ id: string; key: string; text: string; locked?: boolean }> }
export interface KnowledgeChunk { chunk_id?: string; source_id?: string; title?: string; url?: string | null; heading?: string | null; text: string }

export interface EngineInput {
  workspaceId: string;
  settings: PromptSettings;
  editorMode: "guided" | "raw";
  promptBody: string;
  promptVersion: number;
  promptId: string | null;
  scenarios: ScenarioCard[];
  faqs: Faq[];
  knowledgeSourceIds: string[];
  leadNotes: LeadNotes | null;
  senderName: string;
  tz: string;
  lead: Row | null;
  thread: ThreadLine[];
  state: DraftState;
  classification: Array<Partial<Classification>>;
  flags: string[];
  firstStep: string | null;
  schedulingDomains: Array<{ host: string; path_prefix: string | null }>;
  purpose: "reply_draft" | "reply_simulate";
}
export interface EngineOpts { trigger: "auto" | "manual"; guidance?: string | null; variants?: number }

/** Whole-word template variables the master prompt may use for the sender. Anything else stays as written. */
export function fillPrompt(body: string, senderName: string): string {
  const first = senderName.trim().split(/\s+/)[0] || senderName;
  return body.replace(/\{\{\s*sender\.first_name\s*\}\}/g, first).replace(/\{\{\s*sender\.(?:name|full_name)\s*\}\}/g, senderName);
}

function stageLine(s: PromptSettings, st: DraftState): string {
  if (st.session_kind === "dormant" && !st.stage) return "Re-engage (they came back after a long gap: acknowledge lightly, one-line recap, ask what changed; pitch after 1 exchange or when they ask)";
  const key = st.stage;
  if (!key) return "not started — Stage 1 unless the flags say they asked to skip ahead";
  if (key === CLOSING) return "closing";
  const i = s.stages.findIndex((x) => x.key === key);
  return i >= 0 ? `${key} (Stage ${i + 1} of ${s.stages.length} · ${s.stages[i].label})` : `${key}`;
}

function lineLabel(l: ThreadLine): string {
  if (l.from === "prospect") return "prospect";
  if (l.from === "us_sequence") return `us (sequence${l.step ? ` step: ${l.step}` : ""})`;
  if (l.from === "us_ai" || l.from === "ai") return "us (AI)";
  if (l.from === "us_teammate" || l.from === "teammate") return "us (teammate)";
  return "us";
}

/** The "## Stop when" rules as a list (guided: from the compiled body; raw: same parse). */
export function stopRulesOf(body: string): string[] {
  const m = body.match(/##\s*Stop when\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i);
  if (!m) return [];
  return m[1].split("\n").map((l) => l.replace(/^\s*[-*•]\s*/, "").trim()).filter((l) => l && !/^stop replying after/i.test(l)).slice(0, 12);
}

/** The prompt the model reads: a raw prompt with cards gets them appended as its Situations (guided prompts compile them server-side). */
export function effectiveBody(input: Pick<EngineInput, "promptBody" | "editorMode" | "scenarios">): string {
  const cards = input.scenarios.filter((c) => c.enabled !== false);
  if (input.editorMode !== "raw" || !cards.length || /##\s*Situations/i.test(input.promptBody)) return input.promptBody;
  return `${input.promptBody.trim()}\n\n## Situations\n${cards.map((c) => `- ${c.title}: when ${c.when_text} → ${c.do_text}`).join("\n")}`;
}

export function buildDraftPrompt(c: EngineInput, opts: EngineOpts, knowledge: KnowledgeChunk[], faqs: Faq[], violation?: Failure[]): { system: string; user: string } {
  const todayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: c.tz || "UTC", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: c.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const skip = c.flags.filter((f) => c.settings.skip_to_pitch_when.includes(f));
  const botLine = c.settings.bot_question === "disclose"
    ? `If they ask whether this is a bot or AI, answer honestly, e.g. "I use an AI assistant to keep up with messages; happy to jump on a call with ${c.senderName.split(" ")[0]} directly".`
    : `If they ask whether this is a bot or AI, decide "escalate".`;
  const st = c.state;
  const session = st.session_kind === "returning" ? `returning after ${st.gap_days ?? "?"} days (new session: counters reset, stage kept; no pitch in this first reply unless they ask or the stage is already past Pitch)`
    : st.session_kind === "dormant" ? `dormant, back after ${st.gap_days ?? "?"} days → Re-engage`
    : "normal";
  const cards = c.scenarios.filter((x) => x.enabled !== false);
  const notes = c.leadNotes && (c.leadNotes.summary || c.leadNotes.items?.length)
    ? [c.leadNotes.summary ? `  summary: ${c.leadNotes.summary}` : "", ...(c.leadNotes.items ?? []).slice(0, 20).map((i) => `  - ${i.key}: ${i.text}`)].filter(Boolean).join("\n")
    : "  none";
  const stops = stopRulesOf(c.promptBody);
  const minEx = st.session_kind === "dormant" ? Math.min(1, c.settings.min_exchanges_before_pitch) : c.settings.min_exchanges_before_pitch;
  const state = [
    "STATE",
    `- Trigger: ${opts.trigger === "manual" ? "manual (a person asked for a draft; they will read it before anything is sent)" : "auto"}`,
    `- Today: ${todayIso} (${todayFmt}) in the sender's time zone (${c.tz || "UTC"})`,
    `- Session: ${session}`,
    `- Conversation stage: ${st.stage_stale ? `${stageLine(c.settings, st)} — a teammate wrote since, infer the current stage from the thread` : stageLine(c.settings, st)}`,
    `- Previous stage: ${st.previous_stage ?? "none"}`,
    `- Exchanges so far: ${st.exchanges} (at least ${minEx} before pitching, a link or a price, unless a skip flag is raised)`,
    `- Previous AI move: ${st.last_move ?? "none"}${c.settings.vary_moves_in_early_stages ? " (use a different move in early stages)" : ""}`,
    `- Skip-ahead flags raised: ${skip.length ? skip.join(", ") : "none"}`,
    `- All classifier flags: ${c.flags.length ? c.flags.join(", ") : "none"}`,
    `- Stage keys in order: ${c.settings.stages.map((s) => `${s.key}${s.early ? "(early)" : ""}${s.pitch ? "(pitch)" : ""}`).join(" → ")} → closing`,
    `- The prospect first answered: ${c.firstStep ?? "unknown step"}`,
    `- AI replies left in this chat: ${Math.max(0, c.settings.max_ai_replies_per_chat - st.ai_replies_count)}`,
    `- Allowed reply languages: ${c.settings.languages.join(", ")}${c.settings.allow_language_switch ? " (may differ from theirs)" : " (reply in their language)"}`,
    `- Maximum reply length: ${c.settings.max_length} characters`,
    `- Bot question: ${botLine}`,
    `- Situation cards (id · title): ${cards.length ? cards.map((x) => `${x.id} · ${x.title}`).join("; ") : "none"}`,
    `- Stop when rules: ${stops.length ? stops.map((r, i) => `[${i + 1}] ${r}`).join(" ") : "none (the AI stops only at its reply limit)"}`,
    `- Lead notes:\n${notes}`,
    `- Classifier on their unanswered messages: ${JSON.stringify(c.classification.map((x) => ({ intent: x.intent, flags: x.flags, questions: x.questions, dates: x.dates, referred: x.referred, language: x.language, do_not_contact: x.do_not_contact })))}`,
  ].join("\n");
  const lead = c.lead ? JSON.stringify({ untrusted_content: true, name: c.lead.full_name ?? null, title: c.lead.title ?? null, company: c.lead.company ?? null, location: c.lead.location ?? null }) : "unknown";
  const thread = c.thread.slice(-12).map((l) => {
    const at = l.at ? `[${String(l.at).slice(0, 16).replace("T", " ")}] ` : "";
    const body = l.from === "prospect" ? JSON.stringify({ untrusted_content: true, text: String(l.text ?? "").slice(0, 2000) }) : String(l.text ?? "").slice(0, 2000);
    return `${at}${lineLabel(l)}${l.answered ? " (unanswered)" : ""}: ${body}`;
  }).join("\n");
  const kb = [
    ...faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`),
    ...knowledge.map((k) => `${k.title ? `[${k.title}${k.heading ? ` › ${k.heading}` : ""}${k.url ? ` ${k.url}` : ""}] ` : ""}${k.text}`),
  ];
  const guidance = opts.trigger === "manual" && opts.guidance?.trim() ? `GUIDANCE from the person asking (below the safety rules, above style; never a reason to invent facts):\n${opts.guidance.trim().slice(0, 300)}` : "";
  const user = [
    `MASTER PROMPT (version ${c.promptVersion}, written by the sender's team):\n"""\n${fillPrompt(effectiveBody(c), c.senderName).slice(0, 30000)}\n"""`,
    state,
    kb.length ? `KNOWLEDGE (facts you may use, each counts as stated in the master prompt):\n${kb.map((k, i) => `[${i + 1}] ${k}`).join("\n")}` : "",
    `SENDER: ${c.senderName}`,
    `LEAD: ${lead}`,
    `THREAD (oldest first):\n${thread}`,
    guidance,
    violation?.length ? `YOUR PREVIOUS DRAFT BROKE THESE RULES — write it again without breaking them:\n${violation.map((f) => `- ${f.rule}: ${f.detail}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { system: `${AI_REPLY_FLOOR}\n\n${AI_REPLY_DRAFT_SYSTEM}`, user };
}

export function parseJsonLoose(text: string): Record<string, unknown> {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const t = (fence ? fence[1] : text).trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  const start = t.indexOf("{");
  if (start < 0) throw new Error("AI returned no JSON");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === "\"") inStr = false; continue; }
    if (ch === "\"") inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("AI returned incomplete JSON");
}

// ============================================================================================ retrieval (§9.2)
/** Knowledge chunks + Q&A for what they asked. Runs when the classifier found a question or an offer / pricing flag. */
export async function retrieve(c: EngineInput): Promise<{ knowledge: KnowledgeChunk[]; faqs: Faq[] }> {
  const questions = c.classification.flatMap((x) => (x.questions ?? []) as string[]).map(String).filter(Boolean);
  const asked = questions.length > 0 || c.flags.some((f) => f === "asked_offer" || f === "pricing");
  const faqsAll = c.faqs ?? [];
  if (!asked) return { knowledge: [], faqs: faqsAll.length <= 30 ? faqsAll : [] };
  const query = (questions.length ? questions : c.thread.filter((l) => l.answered).map((l) => l.text)).join(" ").slice(0, 500);
  let knowledge: KnowledgeChunk[] = [];
  if (c.knowledgeSourceIds.length && query.trim()) {
    knowledge = (await rpc<KnowledgeChunk[]>("knowledge_search", { p_ws: c.workspaceId, p_sources: c.knowledgeSourceIds, p_query: query, p_limit: 5 }).catch(() => [])) ?? [];
  }
  let faqs = faqsAll;
  if (faqsAll.length > 30 && c.promptId) faqs = (await rpc<Faq[]>("_ai_faqs_for", { p_mp: c.promptId, p_question: query }).catch(() => [])) ?? [];
  return { knowledge, faqs };
}

// ============================================================================================ pipeline
export interface PipelineResult {
  draft: DraftOutput;
  validator: { ok: boolean; failures: Failure[] };
  verifier: { supported: boolean; unsupported_claims: string[]; follows_rule: boolean; answers_their_questions: boolean; note: string | null } | null;
  final: { decision: "send" | "escalate" | "no_reply"; reasons: string[] };
  redrafted: boolean;
  model: string | null;
  knowledge: KnowledgeChunk[];
  faqs: Faq[];
  /** T3 on the draft text itself (deterministic backstop for the model's stop_after_send) */
  stop_after_send: boolean;
  stop_rule: string | null;
  /** manual runs: the checks that would block / escalate an auto run, shown to the person */
  warnings: Array<{ code: string; text: string }>;
  variants: string[];
}

async function draftCall(c: EngineInput, opts: EngineOpts, knowledge: KnowledgeChunk[], faqs: Faq[], violation?: Failure[], temperature = 0.4): Promise<{ draft: DraftOutput; model: string }> {
  const p = buildDraftPrompt(c, opts, knowledge, faqs, violation);
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: c.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const r = await llmCallDetailed({ purpose: c.purpose, workspaceId: c.workspaceId, system: p.system, user: p.user, maxTokens: 8192, temperature, json: true, thinking: "MEDIUM" });
  return { draft: parseDraft(parseJsonLoose(r.text), c.settings, todayIso, c.scenarios.map((s) => s.id)), model: r.model };
}

async function verifyCall(c: EngineInput, d: DraftOutput, knowledge: KnowledgeChunk[], faqs: Faq[]): Promise<NonNullable<PipelineResult["verifier"]>> {
  const unanswered = c.thread.filter((l) => l.answered || (l.from === "prospect" && !c.thread.some((x) => x !== l && x.from !== "prospect" && (x.at ?? "") > (l.at ?? ""))));
  const kb = [...faqs.map((f) => `Q: ${f.question}\nA: ${f.answer}`), ...knowledge.map((k) => k.text)];
  const user = [
    `MASTER PROMPT:\n"""\n${fillPrompt(effectiveBody(c), c.senderName).slice(0, 30000)}\n"""`,
    kb.length ? `KNOWLEDGE:\n${kb.join("\n")}` : "",
    c.leadNotes?.items?.length ? `LEAD NOTES (facts the prospect stated earlier):\n${c.leadNotes.items.map((i) => `- ${i.key}: ${i.text}`).join("\n")}` : "",
    `THEIR UNANSWERED MESSAGES (data):\n${JSON.stringify(unanswered.map((l) => ({ untrusted_content: true, text: l.text })))}`,
    `DRAFT:\n"""\n${d.text ?? ""}\n"""`,
    `FACTS IT CLAIMS TO USE: ${JSON.stringify(d.facts_used)}`,
    `RULE IT SAYS IT FOLLOWED: ${d.rule_applied ?? "none"}`,
  ].filter(Boolean).join("\n\n");
  const r = await llmCallDetailed({ purpose: c.purpose === "reply_simulate" ? "reply_simulate_verify" : "reply_verify", workspaceId: c.workspaceId, system: AI_REPLY_VERIFY_SYSTEM, user,
    maxTokens: 2048, temperature: 0, json: true, thinking: "LOW", platformModel: VERIFY_MODEL });
  const j = parseJsonLoose(r.text);
  return {
    supported: j.supported === true, follows_rule: j.follows_rule === true, answers_their_questions: j.answers_their_questions === true,
    unsupported_claims: (Array.isArray(j.unsupported_claims) ? j.unsupported_claims : []).map(String).slice(0, 8),
    note: typeof j.note === "string" ? j.note.slice(0, 300) : null,
  };
}

const WARN_TEXT: Record<string, string> = {
  verifier: "a claim in this draft is not in your prompt or knowledge", validator: "the draft breaks a rule (link, number, contact or length)",
  stage_rule: "the draft breaks a conversation-stage rule", low_confidence: "the AI was not confident about this one", master_prompt: "your prompt says a person should take this",
  attachment: "they sent an attachment the AI cannot see", injection_suspected: "their message looks like an attempt to instruct the AI", bot_question: "they asked whether this is a bot",
  language: "they wrote in a language your prompt does not allow", turn_limit: "the AI has reached its reply limit in this chat", model_error: "the AI could not produce a draft",
  opt_out: "they asked not to be contacted", not_covered: "their question is not covered by the prompt or knowledge",
};

/** Draft → validate (+1 redraft on a stage rule) → verify → strictest outcome. Same for auto, manual and the simulator. */
export async function runEngine(c: EngineInput, opts: EngineOpts, gateEscalations: string[] = [], floor: { decision: "send" | "escalate" | "no_reply" | null; reasons: string[] } = { decision: null, reasons: [] }): Promise<PipelineResult> {
  const { knowledge, faqs } = await retrieve(c);
  const prospectText = c.thread.filter((l) => l.from === "prospect").map((l) => l.text).join("\n");
  const ourEarlier = c.thread.filter((l) => l.from !== "prospect").map((l) => l.text).filter(Boolean);
  const allowed = [effectiveBody(c), ...faqs.map((f) => f.answer), ...knowledge.map((k) => k.text), ...(c.leadNotes?.items ?? []).map((i) => i.text)].join("\n");
  const vctx = {
    settings: { ...c.settings, min_exchanges_before_pitch: c.state.session_kind === "dormant" ? Math.min(1, c.settings.min_exchanges_before_pitch) : c.settings.min_exchanges_before_pitch },
    editorMode: c.editorMode, allowedText: allowed, prospectText,
    prospectLanguage: (c.classification.map((x) => x.language).filter(Boolean).pop() as string | undefined) ?? null,
    exchanges: c.state.exchanges, flags: c.flags, prevMove: c.state.last_move, ourEarlierTexts: ourEarlier, stageBefore: c.state.stage,
  };
  let { draft, model } = await draftCall(c, opts, knowledge, faqs);
  let v = validateDraft(draft, vctx);
  let redrafted = false;
  if (v.stageViolation || v.failures.some((f) => f.rule === "ai_denial")) {
    redrafted = true;
    ({ draft, model } = await draftCall(c, opts, knowledge, faqs, v.failures));
    v = validateDraft(draft, vctx);
  }
  // manual: a person asked for a draft — an escalation without text gets one retry that writes it anyway
  if (opts.trigger === "manual" && draft.decision === "escalate" && !draft.text) {
    const retry = await draftCall(c, { ...opts, guidance: `${opts.guidance ?? ""}\nA person asked for a draft: write the reply you would send if you had to, and list your concerns in escalation_reason.`.trim() }, knowledge, faqs);
    if (retry.draft.text) { draft = { ...retry.draft, decision: "escalate", escalation_reason: retry.draft.escalation_reason ?? draft.escalation_reason }; model = retry.model; v = validateDraft({ ...draft, decision: "send" }, vctx); }
  }
  // an AI denial never reaches a person's composer either
  if (v.failures.some((f) => f.rule === "ai_denial")) { draft = { ...draft, text: null, decision: "escalate", escalation_reason: "the draft denied being AI" }; v = validateDraft(draft, vctx); }
  const verifier = draft.text && (draft.decision === "send" || opts.trigger === "manual") && v.ok ? await verifyCall(c, draft, knowledge, faqs) : null;
  // manual runs: the floor's hard reasons become warnings, never a block
  const final = strictest({ floor: opts.trigger === "manual" ? { decision: null, reasons: [] } : floor, gateEscalations: opts.trigger === "manual" ? [] : gateEscalations, draft, validator: v, verifier, minConfidence: MIN_CONFIDENCE });
  if (opts.trigger === "manual") for (const r of [...floor.reasons, ...gateEscalations]) if (!final.reasons.includes(r)) final.reasons.push(r);
  // T3 on the text (deterministic), then the model's own stop flag
  const linkStop = !!draft.text && hasSchedulingLink(draft.text, c.schedulingDomains);
  const stop_after_send = linkStop || draft.stop_after_send;
  const stop_rule = linkStop ? "calendar link" : draft.stop_after_send ? draft.stop_rule : null;
  const warnings: PipelineResult["warnings"] = [];
  if (opts.trigger === "manual") {
    for (const r of final.reasons) warnings.push({ code: r, text: r === "verifier" && verifier?.unsupported_claims?.length ? `“${verifier.unsupported_claims[0]}” isn't in your prompt or knowledge` : (WARN_TEXT[r] ?? r.replace(/_/g, " ")) });
    for (const f of v.failures) if (!warnings.some((w) => w.code === f.rule)) warnings.push({ code: f.rule, text: f.detail });
    if (draft.escalation_reason && !warnings.some((w) => w.code === "master_prompt")) warnings.push({ code: "master_prompt", text: draft.escalation_reason });
    if (draft.unanswered_question) warnings.push({ code: "not_covered", text: `They asked: “${draft.unanswered_question}” — not covered by the prompt or knowledge` });
  }
  const variants: string[] = [];
  const n = Math.max(1, Math.min(3, opts.variants ?? 1));
  if (opts.trigger === "manual" && draft.text && n > 1) {
    const extra = await Promise.all(Array.from({ length: n - 1 }, () => draftCall(c, opts, knowledge, faqs, undefined, 0.7).catch(() => null)));
    for (const e of extra) if (e?.draft.text && e.draft.text !== draft.text) variants.push(e.draft.text);
  }
  return { draft, validator: { ok: v.ok, failures: v.failures }, verifier, final, redrafted, model, knowledge, faqs, stop_after_send, stop_rule, warnings, variants };
}

// ============================================================================================ context from gate facts
export function threadFromFacts(facts: Row): ThreadLine[] {
  return (facts.thread ?? []).map((t: Row) => ({ from: t.from, text: String(t.text ?? ""), at: t.at, step: t.action_type ?? null, answered: !!t.answered }));
}

/** EngineInput from outreach_ai_reply_gate_facts (worker and Draft with AI). `flags` come from the floor precheck the caller ran. */
export function contextFromFacts(facts: Row, flags: string[], domains: Array<{ host: string; path_prefix: string | null }>, purpose: EngineInput["purpose"] = "reply_draft"): EngineInput {
  const eff = facts.effective as Row; const chat = facts.chat as Row; const sender = facts.sender as Row; const mp = facts.master_prompt as Row;
  const run = facts.run as Row;
  const settings = settingsOf(eff?.settings ?? mp?.settings);
  const classification = ((facts.burst ?? []) as Row[]).map((m) => m.classification).filter(Boolean);
  const state: DraftState = {
    stage: chat.stage ?? null, exchanges: Number(chat.exchanges ?? 0), last_move: chat.last_ai_move ?? null, ai_replies_count: Number(chat.ai_replies_count ?? 0), stage_stale: !!chat.stage_stale,
    session_kind: (run?.session_kind ?? chat.session_kind ?? "normal") as DraftState["session_kind"], gap_days: run?.gap_days != null ? Number(run.gap_days) : null,
    previous_stage: chat.previous_stage ?? null, session_count: Number(chat.session_count ?? 1),
  };
  return {
    workspaceId: run.workspace_id, settings, editorMode: (mp?.editor_mode ?? "guided") as "guided" | "raw", promptBody: String(mp?.body ?? ""), promptVersion: Number(mp?.version ?? 0), promptId: mp?.id ?? null,
    scenarios: ((facts.scenarios ?? []) as ScenarioCard[]), faqs: ((facts.faqs ?? []) as Faq[]), knowledgeSourceIds: (settings.knowledge_source_ids ?? []) as string[],
    leadNotes: facts.lead_notes ? { summary: facts.lead_notes.summary ?? null, items: facts.lead_notes.items ?? [] } : null,
    senderName: sender.display_name ?? "the sender", tz: sender.timezone ?? "UTC", lead: facts.lead ?? null, thread: threadFromFacts(facts), state, classification, flags,
    firstStep: facts.first_step ? `${facts.first_step.action_type ?? "step"}${facts.first_step.node_id ? ` (${facts.first_step.node_id})` : ""}` : null,
    schedulingDomains: domains, purpose,
  };
}

/** Everything a run stores from an engine result (shared by the worker and Draft with AI so the two rows read the same). */
export function patchFromResult(res: PipelineResult, c: EngineInput): Row {
  const d = res.draft;
  return {
    model: res.model, decision: res.final.decision, draft_text: d.text, stage_before: d.stage_before ?? c.state.stage, stage_after: d.stage_after ?? d.stage_before ?? c.state.stage,
    move: d.move, rule_applied: d.rule_applied, side_effects: d.side_effects, facts_used: d.facts_used, draft_confidence: d.confidence,
    validator: res.validator, verifier: res.verifier, redrafts: res.redrafted ? 1 : 0, escalation_reasons: res.final.reasons,
    stop_after_send: res.stop_after_send, stop_rule: res.stop_rule, scenario_id: d.scenario_id, warnings: res.warnings,
    variants: res.variants.length ? { n: res.variants.length + 1, texts: res.variants } : undefined,
    context: {
      thread: c.thread, state: c.state, classification: c.classification, lead: c.lead ? { full_name: c.lead.full_name, title: c.lead.title, company: c.lead.company, location: c.lead.location } : null,
      first_step: c.firstStep, knowledge_used: res.knowledge.map((k) => ({ chunk_id: k.chunk_id, source_id: k.source_id, title: k.title, url: k.url })), faqs_used: res.faqs.map((f) => f.id),
      lead_notes_used: !!(c.leadNotes?.items?.length || c.leadNotes?.summary), scenarios: c.scenarios.filter((s) => s.enabled !== false).map((s) => s.id),
      unanswered_question: d.unanswered_question,
    },
  };
}
