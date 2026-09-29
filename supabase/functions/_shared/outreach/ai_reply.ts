// AI replies engine (ai-auto-reply-PRD.md): F32 worker, F33 dispatcher, maintenance (expire / breakers / graduation /
// digests), the simulator + regression set, consent links and the notification emails.
// The database decides state (036/037: every transition is a compare-and-set in SQL); this file does the model calls,
// the code checks (ai_reply_rules.ts) and the connector send (reply.ts deliverChatMessage, shared with a person's send).
import { admin, log, rpc, sha256Hex, HttpError, WEB_ORIGIN, membership, requireRole, clientVisible, type AuthedUser } from "./supabase.ts";
import { llmCallDetailed } from "./llm.ts";
import { classifyMessage, aiAvailable, type Classification } from "./ai.ts";
import { AI_REPLY_FLOOR, AI_REPLY_DRAFT_SYSTEM, AI_REPLY_VERIFY_SYSTEM } from "./prompts.ts";
import { deliverChatMessage } from "./reply.ts";
import { classifyMessageById } from "./workers.ts";
import { UnipileError } from "./unipile.ts";
import { sendEmail, layout, button, esc, workspaceBranding, workspaceRecipients, emailConfigured } from "./notify.ts";
import {
  computeSendAt, evaluateGates, floorPrecheck, minMode, nextWindowStart, parseCountry, parseDraft, strictest, validateDraft, CLOSING,
  type DraftOutput, type Mode, type PromptSettings, type Schedule, type Failure,
} from "./ai_reply_rules.ts";

type Row = Record<string, any>;
/** v1 policy: AI replies on LinkedIn only (PRD §2.2). The SQL resolver enforces the same. */
export const CHANNELS_V1 = ["LINKEDIN"];
const VERIFY_MODEL = Deno.env.get("OUTREACH_AI_VERIFY_MODEL") ?? null;
const MIN_CONFIDENCE = 0.75;

export const DEFAULT_SETTINGS: PromptSettings = {
  stages: [
    { key: "engage", label: "Engage", early: true }, { key: "relate", label: "Relate", early: true },
    { key: "pitch", label: "Pitch", pitch: true }, { key: "next_step", label: "Next step" },
  ],
  min_exchanges_before_pitch: 2, skip_to_pitch_when: ["asked_offer", "pricing", "meeting_request", "meeting_time_proposed", "explicit_interest"],
  vary_moves_in_early_stages: true, max_ai_replies_per_chat: 6, languages: ["en"], allow_language_switch: false, bot_question: "escalate",
  handoff_stage_id: null, knowledge_source_ids: [], max_length: 600,
};
const settingsOf = (s: unknown): PromptSettings => ({ ...DEFAULT_SETTINGS, ...((s && typeof s === "object") ? s as Partial<PromptSettings> : {}) });

let floorShaCache: string | null = null;
async function floorSha(): Promise<string> { return floorShaCache ??= await sha256Hex(AI_REPLY_FLOOR); }

// ============================================================================================ context (§9.3)
export interface ThreadLine { from: "prospect" | "us" | "teammate" | "ai" | "us_sequence" | "us_ai" | "us_teammate"; text: string; at?: string; step?: string | null; answered?: boolean }
export interface DraftState { stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number; stage_stale?: boolean }

interface DraftCtx {
  workspaceId: string;
  settings: PromptSettings;
  editorMode: "guided" | "raw";
  promptBody: string;
  promptVersion: number;
  senderName: string;
  tz: string;
  lead: Row | null;
  thread: ThreadLine[];
  state: DraftState;
  classification: Array<Partial<Classification>>;
  flags: string[];
  firstStep: string | null;
  knowledge: string[];
  purpose: "reply_draft" | "reply_simulate";
}

/** Whole-word template variables the master prompt may use for the sender. Anything else stays as written. */
function fillPrompt(body: string, senderName: string): string {
  const first = senderName.trim().split(/\s+/)[0] || senderName;
  return body.replace(/\{\{\s*sender\.first_name\s*\}\}/g, first).replace(/\{\{\s*sender\.(?:name|full_name)\s*\}\}/g, senderName);
}

function stageLine(s: PromptSettings, key: string | null): string {
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

export function buildDraftPrompt(c: DraftCtx, violation?: Failure[]): { system: string; user: string } {
  const todayFmt = new Intl.DateTimeFormat("en-GB", { timeZone: c.tz || "UTC", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: c.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const skip = c.flags.filter((f) => c.settings.skip_to_pitch_when.includes(f));
  const botLine = c.settings.bot_question === "disclose"
    ? `If they ask whether this is a bot or AI, answer honestly, e.g. "I use an AI assistant to keep up with messages; happy to jump on a call with ${c.senderName.split(" ")[0]} directly".`
    : `If they ask whether this is a bot or AI, decide "escalate".`;
  const state = [
    "STATE",
    `- Today: ${todayIso} (${todayFmt}) in the sender's time zone (${c.tz || "UTC"})`,
    `- Conversation stage: ${c.state.stage_stale ? `${stageLine(c.settings, c.state.stage)} — a teammate wrote since, infer the current stage from the thread` : stageLine(c.settings, c.state.stage)}`,
    `- Exchanges so far: ${c.state.exchanges} (at least ${c.settings.min_exchanges_before_pitch} before pitching, a link or a price, unless a skip flag is raised)`,
    `- Previous AI move: ${c.state.last_move ?? "none"}${c.settings.vary_moves_in_early_stages ? " (use a different move in early stages)" : ""}`,
    `- Skip-ahead flags raised: ${skip.length ? skip.join(", ") : "none"}`,
    `- All classifier flags: ${c.flags.length ? c.flags.join(", ") : "none"}`,
    `- Stage keys in order: ${c.settings.stages.map((s) => `${s.key}${s.early ? "(early)" : ""}${s.pitch ? "(pitch)" : ""}`).join(" → ")} → closing`,
    `- The prospect first answered: ${c.firstStep ?? "unknown step"}`,
    `- AI replies left in this chat: ${Math.max(0, c.settings.max_ai_replies_per_chat - c.state.ai_replies_count)}`,
    `- Allowed reply languages: ${c.settings.languages.join(", ")}${c.settings.allow_language_switch ? " (may differ from theirs)" : " (reply in their language)"}`,
    `- Maximum reply length: ${c.settings.max_length} characters`,
    `- Bot question: ${botLine}`,
    `- Classifier on their unanswered messages: ${JSON.stringify(c.classification.map((x) => ({ intent: x.intent, flags: x.flags, questions: x.questions, dates: x.dates, referred: x.referred, language: x.language, do_not_contact: x.do_not_contact })))}`,
  ].join("\n");
  const lead = c.lead ? JSON.stringify({ untrusted_content: true, name: c.lead.full_name ?? null, title: c.lead.title ?? null, company: c.lead.company ?? null, location: c.lead.location ?? null }) : "unknown";
  const thread = c.thread.slice(-12).map((l) => {
    const at = l.at ? `[${String(l.at).slice(0, 16).replace("T", " ")}] ` : "";
    const body = l.from === "prospect" ? JSON.stringify({ untrusted_content: true, text: String(l.text ?? "").slice(0, 2000) }) : String(l.text ?? "").slice(0, 2000);
    return `${at}${lineLabel(l)}${l.answered ? " (unanswered)" : ""}: ${body}`;
  }).join("\n");
  const user = [
    `MASTER PROMPT (version ${c.promptVersion}, written by the sender's team):\n"""\n${fillPrompt(c.promptBody, c.senderName).slice(0, 30000)}\n"""`,
    state,
    c.knowledge.length ? `KNOWLEDGE:\n${c.knowledge.map((k, i) => `[${i + 1}] ${k}`).join("\n")}` : "",
    `SENDER: ${c.senderName}`,
    `LEAD: ${lead}`,
    `THREAD (oldest first):\n${thread}`,
    violation?.length ? `YOUR PREVIOUS DRAFT BROKE THESE RULES — write it again without breaking them:\n${violation.map((f) => `- ${f.rule}: ${f.detail}`).join("\n")}` : "",
  ].filter(Boolean).join("\n\n");
  return { system: `${AI_REPLY_FLOOR}\n\n${AI_REPLY_DRAFT_SYSTEM}`, user };
}

function parseJsonLoose(text: string): Record<string, unknown> {
  const fence = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  const t = (fence ? fence[1] : text).trim();
  try { return JSON.parse(t); } catch { /* fall through */ }
  // the first balanced {...} (models sometimes add a second object or prose after the answer)
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

async function draftCall(c: DraftCtx, violation?: Failure[]): Promise<{ draft: DraftOutput; model: string }> {
  const p = buildDraftPrompt(c, violation);
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: c.tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const r = await llmCallDetailed({ purpose: c.purpose, workspaceId: c.workspaceId, system: p.system, user: p.user, maxTokens: 8192, temperature: 0.4, json: true, thinking: "MEDIUM" });
  return { draft: parseDraft(parseJsonLoose(r.text), c.settings, todayIso), model: r.model };
}

async function verifyCall(c: DraftCtx, d: DraftOutput): Promise<{ supported: boolean; unsupported_claims: string[]; follows_rule: boolean; answers_their_questions: boolean; note: string | null }> {
  const unanswered = c.thread.filter((l) => l.answered || (l.from === "prospect" && !c.thread.some((x) => x !== l && x.from !== "prospect" && (x.at ?? "") > (l.at ?? ""))));
  const user = [
    `MASTER PROMPT:\n"""\n${fillPrompt(c.promptBody, c.senderName).slice(0, 30000)}\n"""`,
    c.knowledge.length ? `KNOWLEDGE:\n${c.knowledge.join("\n")}` : "",
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

/** Knowledge-source retrieval (PRD §8.2, P3). The web-chat knowledge tables do not exist yet, so nothing is retrieved. */
async function retrieveKnowledge(_workspaceId: string, ids: string[], _questions: string[]): Promise<string[]> {
  if (!ids?.length) return [];
  return [];
}

export interface PipelineResult {
  draft: DraftOutput;
  validator: { ok: boolean; failures: Failure[] };
  verifier: Awaited<ReturnType<typeof verifyCall>> | null;
  final: { decision: "send" | "escalate" | "no_reply"; reasons: string[] };
  redrafted: boolean;
  model: string | null;
}

/** Draft → validate (+1 redraft on a stage rule) → verify → strictest outcome. Shared by the worker and the simulator. */
async function runPipeline(c: DraftCtx, floor: ReturnType<typeof floorPrecheck>, gateEscalations: string[]): Promise<PipelineResult> {
  const prospectText = c.thread.filter((l) => l.from === "prospect").map((l) => l.text).join("\n");
  const ourEarlier = c.thread.filter((l) => l.from !== "prospect").map((l) => l.text).filter(Boolean);
  const vctx = {
    settings: c.settings, editorMode: c.editorMode, allowedText: [c.promptBody, ...c.knowledge].join("\n"), prospectText,
    prospectLanguage: (c.classification.map((x) => x.language).filter(Boolean).pop() as string | undefined) ?? null,
    exchanges: c.state.exchanges, flags: c.flags, prevMove: c.state.last_move, ourEarlierTexts: ourEarlier, stageBefore: c.state.stage,
  };
  let { draft, model } = await draftCall(c);
  let v = validateDraft(draft, vctx);
  let redrafted = false;
  if (v.stageViolation) {
    redrafted = true;
    ({ draft, model } = await draftCall(c, v.failures));
    v = validateDraft(draft, vctx);
  }
  const verifier = draft.decision === "send" && v.ok && draft.text ? await verifyCall(c, draft) : null;
  const final = strictest({ floor, gateEscalations, draft, validator: v, verifier, minConfidence: MIN_CONFIDENCE });
  return { draft, validator: { ok: v.ok, failures: v.failures }, verifier, final, redrafted, model };
}

// ============================================================================================ F32 worker
export async function runDraftWorker(budgetMs = 40_000): Promise<Row> {
  const started = Date.now();
  const runs = await rpc<Row[]>("ai_reply_claim", { p_limit: 25 });
  let done = 0, failed = 0;
  const queue = [...(runs ?? [])];
  // a few in parallel: every run is two or three network-bound model calls
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length) {
      const run = queue.shift()!;
      if (Date.now() - started > budgetMs) {
        await rpc("ai_reply_finalize", { p_run: run.id, p_to: "debouncing", p_patch: { next_attempt_at: new Date().toISOString(), attempts: Math.max(0, (run.attempts ?? 1) - 1) } }).catch(() => null);
        continue;
      }
      try { await processRun(run); done++; }
      catch (e) {
        failed++;
        const msg = String((e as any)?.message ?? e).slice(0, 500);
        log({ fn: "ai-reply-worker", run_id: run.id, error: msg });
        // retry twice (5 s, 20 s), then failed; a failed run never blocks a person's reply (§12.3)
        const attempts = Number(run.attempts ?? 1);
        if (attempts < 3) await rpc("ai_reply_finalize", { p_run: run.id, p_to: "debouncing", p_patch: { error: msg, next_attempt_at: new Date(Date.now() + (attempts <= 1 ? 5_000 : 20_000)).toISOString() } }).catch(() => null);
        else await rpc("ai_reply_finalize", { p_run: run.id, p_to: "failed", p_patch: { error: msg, escalation_reasons: ["model_error"] } }).catch(() => null);
      }
    }
  }));
  return { claimed: runs?.length ?? 0, done, failed, ms: Date.now() - started };
}

function threadFromFacts(facts: Row): ThreadLine[] {
  return (facts.thread ?? []).map((t: Row) => ({ from: t.from, text: String(t.text ?? ""), at: t.at, step: t.action_type ?? null, answered: !!t.answered }));
}

export async function processRun(run: Row): Promise<void> {
  let facts = await rpc<Row>("ai_reply_gate_facts", { p_run: run.id });
  if (!facts) return;
  // F18 has had 60 s; classify what it has not reached yet, inline (§6.2)
  const unclassified = (facts.burst ?? []).filter((m: Row) => !m.classified && !m.deleted && (String(m.text ?? "").trim() || String(m.transcript ?? "").trim()));
  if (unclassified.length) {
    for (const m of unclassified) {
      try { await classifyMessageById(m.id); await admin.from("outreach_ai_classify_queue").delete().eq("message_id", m.id); }
      catch (e) { log({ fn: "ai-reply-worker", warn: `inline classify: ${String((e as any)?.message ?? e)}`, message_id: m.id }); }
    }
    facts = await rpc<Row>("ai_reply_gate_facts", { p_run: run.id });
  }
  const eff = facts.effective as Row;
  const chat = facts.chat as Row, sender = facts.sender as Row, lead = facts.lead as Row | null;
  const settings = settingsOf(eff?.settings);
  const pol = (eff?.policy ?? {}) as Row;
  const mode = (eff?.mode ?? "off") as Mode;
  const burst = (facts.burst ?? []) as Row[];
  const newest = burst.map((m) => m.sent_at).sort().pop() ?? null;
  const language = burst.map((m) => m.classification?.language).filter(Boolean).pop() ?? null;
  const common = { policy_snapshot: pol, mode, timings: { drafted_at: new Date().toISOString() } };

  if (!CHANNELS_V1.includes(String(chat.provider)) || mode === "off" || !eff?.master_prompt) {
    await rpc("ai_reply_finalize", { p_run: run.id, p_to: "cancelled", p_patch: { ...common, cancel_reason: `skipped:${eff?.reason_code ?? "off"}`, gate_failures: ["G1"] } });
    return;
  }
  const gates = evaluateGates({
    mode, provider: chat.provider, isGroup: !!chat.is_group, contactedFirst: !!facts.contacted_first, suppression: lead?.suppression ?? null,
    doNotContact: !!lead?.do_not_contact, archived: !!chat.archived,
    autopilotPaused: chat.autopilot_state !== "active" && (!chat.autopilot_paused_until || new Date(chat.autopilot_paused_until) > new Date()),
    senderStatus: sender.status, newestInboundAt: newest, staleAfterH: Number(pol.stale_after_h ?? 12), language, languages: settings.languages,
    aiRepliesCount: Number(chat.ai_replies_count ?? 0), maxAiRepliesPerChat: settings.max_ai_replies_per_chat,
    aiSendsToday: Number(facts.ai_sends_today ?? 0), maxAiSendsPerDay: Math.min(40, Number(pol.max_ai_sends_per_sender_day ?? 25)),
    poolOk: facts.pool?.ok !== false, leadStagePosition: lead?.stage_position ?? null, handoffStagePosition: facts.handoff_stage_position ?? null,
    leadTags: (lead?.tags ?? []) as string[], leadCountry: parseCountry(lead?.location), disclosure: pol.disclosure ?? null,
    blockedCountries: Array.isArray(pol.blocked_countries) ? pol.blocked_countries : [], now: new Date(),
  });
  if (gates.skip) {
    await rpc("ai_reply_finalize", { p_run: run.id, p_to: "cancelled", p_patch: { ...common, cancel_reason: `skipped:${gates.skip}`, gate_failures: gates.failures } });
    return;
  }
  // the fixed safety checks read the classifier; a message it never labelled cannot be trusted to autopilot
  const unlabelled = burst.some((m) => (String(m.text ?? "").trim() || String(m.transcript ?? "").trim()) && (!m.classification || m.classification.fallback === true));
  if (unlabelled) gates.failures.push("unclassified");
  const effMode = unlabelled ? minMode(minMode(mode, gates.maxMode), "draft") : minMode(mode, gates.maxMode);
  const floor = floorPrecheck(burst.map((m) => ({ text: m.text, transcript: m.transcript, attachments: m.attachments, unsupported: m.unsupported, deleted: m.deleted, classification: m.classification, flags: m.flags })), settings);
  const mp = eff.master_prompt as Row;
  const { data: mpRow } = await admin.from("outreach_master_prompts").select("id, version, body, editor_mode, settings").eq("id", mp.id).single();
  const base = {
    ...common, mode: effMode, flags: floor.flags, language, intent: burst.map((m) => m.intent).filter(Boolean).pop() ?? null, gate_failures: gates.failures,
    master_prompt_id: mpRow!.id, master_prompt_version: mpRow!.version, floor_sha256: await floorSha(),
  };
  // the floor decides alone in autopilot (opt-out, attachments, injection, bot question): no model call (§12.3)
  if (floor.decision && effMode === "autopilot") {
    if (floor.decision === "no_reply") {
      await rpc("ai_reply_finalize", { p_run: run.id, p_to: "no_reply", p_patch: { ...base, decision: "no_reply", rule_applied: "Safety rule: they asked not to be contacted", side_effects: [{ type: "opt_out" }] } });
    } else {
      const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "escalated", p_patch: { ...base, decision: "escalate", escalation_reasons: floor.reasons, rule_applied: "Safety rule" } });
      if (f?.ok) await notifyEscalation(run.id).catch((e) => log({ fn: "ai-reply-worker", warn: `notify: ${String(e)}` }));
    }
    return;
  }
  const state: DraftState = { stage: chat.stage ?? null, exchanges: Number(chat.exchanges ?? 0), last_move: chat.last_ai_move ?? null, ai_replies_count: Number(chat.ai_replies_count ?? 0), stage_stale: !!chat.stage_stale };
  const thread = threadFromFacts(facts);
  const classification = burst.map((m) => m.classification).filter(Boolean);
  const ctx: DraftCtx = {
    workspaceId: run.workspace_id, settings: settingsOf(mpRow!.settings), editorMode: mpRow!.editor_mode, promptBody: mpRow!.body, promptVersion: mpRow!.version,
    senderName: sender.display_name ?? "the sender", tz: sender.timezone ?? "UTC", lead, thread, state, classification, flags: floor.flags,
    firstStep: facts.first_step ? `${facts.first_step.action_type ?? "step"}${facts.first_step.node_id ? ` (${facts.first_step.node_id})` : ""}` : null,
    knowledge: await retrieveKnowledge(run.workspace_id, settings.knowledge_source_ids, classification.flatMap((x: Row) => x.questions ?? [])),
    purpose: "reply_draft",
  };
  const res = await runPipeline(ctx, floor, gates.escalate);
  const d = res.draft;
  const patch: Row = {
    ...base, model: res.model, decision: res.final.decision, draft_text: d.text, stage_before: d.stage_before ?? state.stage, stage_after: d.stage_after ?? d.stage_before ?? state.stage,
    move: d.move, rule_applied: d.rule_applied, side_effects: floor.optOut ? [{ type: "opt_out" }] : d.side_effects, facts_used: d.facts_used, draft_confidence: d.confidence,
    validator: res.validator, verifier: res.verifier, redrafts: res.redrafted ? 1 : 0, escalation_reasons: res.final.reasons,
    context: { thread, state, classification, lead: lead ? { full_name: lead.full_name, title: lead.title, company: lead.company, location: lead.location } : null, first_step: ctx.firstStep },
  };
  // draft mode: a person decides, the draft (and any reason) waits in the composer
  if (effMode === "draft") { await rpc("ai_reply_finalize", { p_run: run.id, p_to: "draft_ready", p_patch: patch }); return; }
  if (res.final.decision === "escalate") {
    // a run superseded while drafting (new message, human reply) loses the compare-and-set: no email then
    const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "escalated", p_patch: patch });
    if (f?.ok) await notifyEscalation(run.id).catch((e) => log({ fn: "ai-reply-worker", warn: `notify: ${String(e)}` }));
    return;
  }
  if (res.final.decision === "no_reply") { await rpc("ai_reply_finalize", { p_run: run.id, p_to: "no_reply", p_patch: patch }); return; }
  // send → hold (§7)
  const firstAnswered = thread.find((l) => l.answered);
  const lastOurs = [...thread].reverse().find((l) => l.from !== "prospect" && firstAnswered && (l.at ?? "") < (firstAnswered.at ?? ""));
  const live = !!(firstAnswered?.at && lastOurs?.at && new Date(firstAnswered.at).getTime() - new Date(lastOurs.at).getTime() < 5 * 60_000);
  const sendAt = computeSendAt({ now: new Date(), delayMinS: Number(pol.delay_min_s ?? 240), delayMaxS: Number(pol.delay_max_s ?? 1200), draftLength: (d.text ?? "").length, live, schedule: sender.schedule as Schedule, tz: sender.timezone ?? "UTC" });
  // the same lead answering two senders: the later of two sends within 30 minutes waits for a person (§15)
  if (run.lead_id) {
    const lo = new Date(sendAt.getTime() - 30 * 60_000).toISOString(), hi = new Date(sendAt.getTime() + 30 * 60_000).toISOString();
    const { data: other } = await admin.from("outreach_ai_reply_runs").select("id").eq("lead_id", run.lead_id).neq("chat_id", run.chat_id)
      .or(`and(status.eq.scheduled,scheduled_send_at.gte.${lo},scheduled_send_at.lte.${hi}),and(status.in.(sending,sent),updated_at.gte.${new Date(Date.now() - 30 * 60_000).toISOString()})`).limit(1);
    if (other?.length) { await rpc("ai_reply_finalize", { p_run: run.id, p_to: "draft_ready", p_patch: { ...patch, mode: "draft", gate_failures: [...gates.failures, "other_sender"] } }); return; }
  }
  await rpc("ai_reply_finalize", { p_run: run.id, p_to: "scheduled", p_patch: { ...patch, scheduled_send_at: sendAt.toISOString(), timings: { drafted_at: new Date().toISOString(), scheduled_at: new Date().toISOString() } } });
}

// ============================================================================================ F33 dispatcher
export async function runDispatch(budgetMs = 45_000): Promise<Row> {
  const started = Date.now();
  const runs = await rpc<Row[]>("ai_reply_dispatch_claim", { p_limit: 25, p_run: null });
  const out = { claimed: runs?.length ?? 0, sent: 0, rescheduled: 0, stopped: 0, failed: 0 };
  for (const run of runs ?? []) {
    if (Date.now() - started > budgetMs) { await rpc("ai_reply_reschedule", { p_run: run.id, p_at: new Date(Date.now() + 60_000).toISOString(), p_why: "dispatch_budget" }).catch(() => null); continue; }
    const r = await sendClaimed(run, false).catch((e) => ({ status: "failed", error: String(e) }));
    if (r.status === "sent") out.sent++; else if (r.status === "rescheduled") out.rescheduled++; else if (r.status === "failed") out.failed++; else out.stopped++;
  }
  return out;
}

/** "Send now" from the hold banner: the §7.3 recheck still runs; only the working-hours window is skipped (a person chose to send). */
export async function sendNow(user: AuthedUser, runId: string): Promise<Row> {
  const { data: run } = await admin.from("outreach_ai_reply_runs").select("id, workspace_id, client_id, status").eq("id", runId).maybeSingle();
  if (!run) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, run.workspace_id);
  requireRole(m, "member");
  if (!m.can_reply) throw new HttpError(403, "E_FORBIDDEN", "replies are disabled for your account");
  if (!clientVisible(m, run.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  if (run.status !== "scheduled") throw new HttpError(409, "E_CONFLICT", "this AI reply is not waiting to be sent any more");
  const claimed = await rpc<Row[]>("ai_reply_dispatch_claim", { p_limit: 1, p_run: runId });
  if (!claimed?.length) throw new HttpError(409, "E_CONFLICT", "this AI reply is already being sent");
  await admin.from("outreach_ai_reply_runs").update({ dispatched_by: user.id }).eq("id", runId);
  const r = await sendClaimed(claimed[0], true);
  if (r.status !== "sent") throw new HttpError(409, "E_CONFLICT", `not sent: ${r.why ?? r.status}`);
  return r;
}

async function nextWindowFor(senderId: string, nextDay: boolean): Promise<Date> {
  const { data: s } = await admin.from("outreach_senders").select("schedule, timezone").eq("id", senderId).single();
  const tz = s?.timezone ?? "UTC";
  let from = new Date();
  if (nextDay) {
    const local = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 24 * 3600_000));
    from = new Date(`${local}T00:00:00Z`);
    from = new Date(from.getTime() - 14 * 3600_000);   // any instant before local midnight works: the next window start is searched from here
    while (new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(from) < local) from = new Date(from.getTime() + 3600_000);
  }
  const next = nextWindowStart(s?.schedule as Schedule, tz, from);
  return next ? new Date(next.getTime() + (15 + Math.random() * 60) * 60_000) : new Date(Date.now() + (nextDay ? 24 : 1) * 3600_000);
}

/** Only a refusal that proves nothing went out may be retried. A timeout or a server error may have delivered the message,
 *  so it is never resent: the run fails and a person is asked to check the thread (the webhook turns it into `sent` if it
 *  did arrive). */
function provenNotSent(e: unknown): boolean {
  return e instanceof UnipileError && e.status === 429;
}

async function sendClaimed(run: Row, ignoreWindow: boolean): Promise<Row> {
  // G14 is rechecked at send time; the country comes from the lead's free-text location
  let country: string | null = null;
  if (run.lead_id) {
    const { data: l } = await admin.from("outreach_leads").select("location").eq("id", run.lead_id).maybeSingle();
    country = parseCountry(l?.location);
  }
  const prep = await rpc<Row>("ai_reply_prepare_send", { p_run: run.id, p_ignore_window: ignoreWindow, p_country: country });
  if (!prep?.ok) {
    if (prep?.reschedule) {
      // an hourly ledger scope frees up within the hour; everything else waits for the next working window
      const at = prep.why === "ledger_hour" ? new Date(Date.now() + (60 + Math.random() * 20) * 60_000) : await nextWindowFor(run.sender_id, !!prep.next_day);
      await rpc("ai_reply_reschedule", { p_run: run.id, p_at: at.toISOString(), p_why: prep.why });
      return { status: "rescheduled", why: prep.why, at: at.toISOString() };
    }
    return { status: prep?.to ?? "stopped", why: prep?.why };
  }
  const { data: chat } = await admin.from("outreach_chats").select("*, outreach_senders(*)").eq("id", run.chat_id).single();
  const sender = (chat as any)?.outreach_senders;
  let delivered: { msg: Row | null; messageId: string | null };
  try {
    if (!sender?.unipile_account_id) throw new Error("sender has no connected account");
    delivered = await deliverChatMessage({ chat, sender, text: prep.text, actionId: prep.action_id, sentBy: null });
  } catch (e) {
    const code = e instanceof UnipileError ? `${e.status}:${e.code}` : String((e as any)?.message ?? e);
    const retry = provenNotSent(e) ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    const r = await rpc<Row>("ai_reply_send_failed", { p_run: run.id, p_error: code, p_retry_at: retry });
    if (r?.to === "failed") await notifyEscalation(run.id, "The AI reply may not have been sent").catch(() => null);
    log({ fn: "ai-reply-dispatch", run_id: run.id, error: code, to: r?.to });
    return { status: r?.to === "scheduled" ? "rescheduled" : "failed", why: code };
  }
  // the message is out: record it. A database error here must never turn into "could not be sent".
  let messageRow = delivered.msg?.id ?? null;
  if (!messageRow && delivered.messageId) {
    const { data: m } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", delivered.messageId).maybeSingle();
    messageRow = m?.id ?? null;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await rpc("ai_reply_mark_sent", { p_run: run.id, p_message: messageRow, p_unipile_message_id: delivered.messageId });
      return { status: "sent", message_id: messageRow };
    } catch (e) {
      log({ fn: "ai-reply-dispatch", run_id: run.id, error: `mark_sent attempt ${attempt + 1}: ${String((e as any)?.message ?? e)}` });
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  // still `sending`: the stuck-send sweep fails it without resending, and the webhook copy marks it sent (ours_ai)
  return { status: "sent", message_id: messageRow, recorded: false };
}

// ============================================================================================ maintenance
export async function runMaintenance(mode: "maintenance" | "breakers" | "daily"): Promise<Row> {
  if (mode === "maintenance") return { expire: await rpc("ai_reply_expire") };
  if (mode === "breakers") {
    const items = await rpc<Row[]>("ai_reply_breakers");
    for (const it of items ?? []) await notifyBreaker(it).catch((e) => log({ fn: "ai-reply-breakers", warn: String(e) }));
    return { notices: items?.length ?? 0 };
  }
  const grad = await rpc<Row[]>("ai_reply_graduation_refresh");
  for (const g of grad ?? []) await notifyGraduation(g).catch((e) => log({ fn: "ai-reply-daily", warn: String(e) }));
  const digests = await sendManagerDigests().catch((e) => { log({ fn: "ai-reply-daily", warn: String(e) }); return 0; });
  const owner = new Date().getUTCDay() === 1 ? await sendOwnerDigests().catch((e) => { log({ fn: "ai-reply-daily", warn: String(e) }); return 0; }) : 0;
  return { graduation: grad?.length ?? 0, manager_digests: digests, owner_digests: owner };
}

// ============================================================================================ notifications (§13.3)
async function notifyEscalation(runId: string, headline?: string): Promise<void> {
  const { data: r } = await admin.from("outreach_ai_reply_runs").select("id, workspace_id, client_id, chat_id, sender_id, draft_text, escalation_reasons, inbound_message_ids, rule_applied").eq("id", runId).single();
  if (!r) return;
  const { data: chat } = await admin.from("outreach_chats").select("id, attendee_name, assigned_to, client_id").eq("id", r.chat_id).single();
  const { data: msgs } = await admin.from("outreach_messages").select("text, transcript, sent_at").in("id", r.inbound_message_ids ?? []).order("sent_at");
  let recipients: string[] = [];
  if (chat?.assigned_to) {
    const { data: m } = await admin.from("outreach_members").select("email").eq("workspace_id", r.workspace_id).eq("user_id", chat.assigned_to).maybeSingle();
    if (m?.email) recipients = [String(m.email).toLowerCase()];
  }
  if (!recipients.length) recipients = await workspaceRecipients(r.workspace_id, { senderId: r.sender_id, clientId: chat?.client_id ?? null });
  if (!recipients.length) return;
  const branding = await workspaceBranding(r.workspace_id);
  const who = chat?.attendee_name ?? "a lead";
  const url = `${WEB_ORIGIN}/outreach/inbox/${r.chat_id}`;
  const words = (msgs ?? []).map((m) => `<p style="margin:0 0 6px;padding:10px 12px;background:#f6f6f7;border-radius:8px">${esc(m.text ?? m.transcript ?? "[attachment]")}</p>`).join("");
  const why = (r.escalation_reasons ?? []).map((x: string) => esc(REASON_TEXT[x] ?? x.replace(/_/g, " "))).join(", ") || "Your master prompt says to hand this over";
  const html = layout(esc(headline ?? `The AI handed ${who} to you`),
    `<p><b>Why:</b> ${why}.</p><p><b>They wrote:</b></p>${words}${r.draft_text ? `<p style="margin-top:14px"><b>The AI's draft</b> (not sent):</p><p style="padding:10px 12px;border:1px solid #e4e4e7;border-radius:8px">${esc(r.draft_text)}</p>` : ""}
     <p style="margin-top:18px">${button(url, r.draft_text ? "Review and send the draft" : "Open the conversation", branding)}</p>`, branding, { audience: "team" });
  for (const to of recipients) await sendEmail(to, `${headline ?? "AI handed over a conversation"}: ${who}`, html, undefined, { branding });
}

const REASON_TEXT: Record<string, string> = {
  attachment: "they sent an attachment, image or voice note", language: "they wrote in a language your prompt does not allow", turn_limit: "the AI reached its reply limit for this chat",
  stage: "the lead is at or past your hand-off stage", vip: "the lead is tagged VIP / manual only", bot_question: "they asked whether they are talking to a bot",
  injection_suspected: "the message looks like an attempt to instruct the AI", verifier: "a claim in the draft could not be checked against your prompt",
  validator: "the draft broke a rule (link, price, contact or length)", stage_rule: "the draft broke a conversation-stage rule twice", low_confidence: "the AI was not confident enough",
  master_prompt: "your master prompt says to hand this over", model_error: "the AI could not produce a draft",
};

async function managerRecipients(workspaceId: string): Promise<string[]> { return workspaceRecipients(workspaceId, {}); }

async function notifyBreaker(it: Row): Promise<void> {
  const to = await managerRecipients(it.workspace_id);
  if (!to.length) return;
  const branding = await workspaceBranding(it.workspace_id);
  let subject = "", body = "";
  if (it.kind === "downgrade_cancels" || it.kind === "downgrade_bot_questions") {
    const { data: q } = await admin.from("outreach_sequences").select("name").eq("id", it.sequence_id).maybeSingle();
    const name = q?.name ?? "a sequence";
    subject = `Autopilot switched to Draft for ${name}`;
    const reasons = (it.reasons ?? []).map((x: Row) => `<li>${esc(String(x.reason).replace(/_/g, " "))}${x.rule ? ` — rule "${esc(x.rule)}"` : ""}: ${esc(x.n)}</li>`).join("");
    body = it.kind === "downgrade_cancels"
      ? `<p>${esc(it.bad)} of the last ${esc(it.n)} AI replies in <b>${esc(name)}</b> were cancelled or edited during the hold, above the ${Math.round(Number(it.threshold) * 100)}% limit. Replies there are drafts for a person again.</p>${reasons ? `<p>What people changed:</p><ul>${reasons}</ul>` : ""}<p>Fix the master-prompt rules named above, then turn Autopilot back on with a note.</p>`
      : `<p>${esc(it.bot_questions)} of ${esc(it.sent)} AI replies in <b>${esc(name)}</b> drew an "are you a bot?" answer (limit 2%). Replies there are drafts for a person again.</p>`;
  } else if (it.kind === "too_early_to_pitch") {
    subject = "AI replies are pitching too early";
    body = `<p>${esc(it.n)} AI replies were cancelled this week as "too early to pitch". Consider raising <b>exchanges before pitching</b> in your master prompt, or making the early stages ask more.</p>`;
  } else return;
  const html = layout(esc(subject), `${body}<p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/settings/ai-replies?tab=reports`, "Open AI replies", branding)}</p>`, branding, { audience: "team" });
  for (const e of to) await sendEmail(e, subject, html, undefined, { branding });
}

async function notifyGraduation(g: Row): Promise<void> {
  const to = await managerRecipients(g.workspace_id);
  if (!to.length) return;
  const branding = await workspaceBranding(g.workspace_id);
  const gained = g.kind === "graduated";
  const subject = gained ? "Autopilot is unlocked for your master prompt" : "Autopilot is back to Draft for your master prompt";
  const body = gained
    ? `<p>Your team sent enough AI drafts unedited or lightly edited, and the simulator scenarios pass. Autopilot can now be turned on where sender owners have given consent.</p>`
    : `<p>The prompt no longer meets the bar for Autopilot, so replies are drafts again:</p><ul>${(g.missing ?? []).map((x: string) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  const html = layout(esc(subject), `${body}<p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/settings/ai-replies?tab=graduation`, "See graduation", branding)}</p>`, branding, { audience: "team" });
  for (const e of to) await sendEmail(e, subject, html, undefined, { branding });
}

async function sendManagerDigests(): Promise<number> {
  const rows = await rpc<Row[]>("ai_reply_digest_data", { p_kind: "manager", p_since: new Date(Date.now() - 24 * 3600_000).toISOString() });
  let n = 0;
  for (const w of rows ?? []) {
    const to = await managerRecipients(w.workspace_id);
    if (!to.length) continue;
    const branding = await workspaceBranding(w.workspace_id);
    const reasons = (w.reasons ?? []).map((x: Row) => `<li>${esc(String(x.reason ?? "other").replace(/_/g, " "))}: ${esc(x.n)}</li>`).join("");
    const downs = (w.downgrades ?? []).length ? `<p><b>${(w.downgrades ?? []).length}</b> sequence(s) were switched back to Draft.</p>` : "";
    const html = layout("AI replies — last 24 hours",
      `<p><b>${esc(w.sent_ai)}</b> sent by autopilot · <b>${esc(w.sent_draft)}</b> AI drafts sent by your team · <b>${esc(w.escalated)}</b> handed to a person · <b>${esc(w.cancelled)}</b> cancelled · <b>${esc(w.no_reply)}</b> needed no reply.</p>${reasons ? `<p>Why things were cancelled or handed over:</p><ul>${reasons}</ul>` : ""}${downs}
       <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/settings/ai-replies?tab=activity`, "Open the activity log", branding)}</p>`, branding, { audience: "team" });
    for (const e of to) if (await sendEmail(e, "AI replies: daily summary", html, undefined, { branding })) n++;
  }
  return n;
}

async function sendOwnerDigests(): Promise<number> {
  const rows = await rpc<Row[]>("ai_reply_digest_data", { p_kind: "owner", p_since: new Date(Date.now() - 7 * 24 * 3600_000).toISOString() });
  let n = 0;
  for (const s of rows ?? []) {
    if (!s.owner_email) continue;
    const branding = await workspaceBranding(s.workspace_id);
    const items = (s.items ?? []).slice(0, 100).map((i: Row) =>
      `<li style="margin-bottom:8px"><b>${esc(i.lead ?? "Lead")}</b> — ${esc(String(i.text ?? "").slice(0, 200))} <a href="${WEB_ORIGIN}/outreach/inbox/${i.chat_id}">open</a></li>`).join("");
    const html = layout(`What the AI sent as ${esc(s.sender_name ?? "you")} this week`,
      `<p>These replies went out on your LinkedIn account through Autopilot in the last 7 days:</p><ul>${items}</ul><p>You can turn Autopilot off at any time with the revoke link in your consent email, or ask your team to switch it off.</p>`, branding, { audience: "client" });
    if (await sendEmail(String(s.owner_email), "Your weekly AI reply summary", html, undefined, { branding })) n++;
  }
  return n;
}

// ============================================================================================ simulator (§13.2, F37)
export interface SimulateBody {
  workspace_id: string; scope?: "workspace" | "client" | "sequence"; scope_id?: string | null; sender_id?: string | null;
  lead?: { full_name?: string; title?: string; company?: string; location?: string };
  draft_prompt?: { editor_mode: "guided" | "raw"; body: string; sections: Row | null; settings: Row };
  version?: number | null; master_prompt_id?: string | null;
  state?: { stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number };
  thread: Array<{ from: "prospect" | "us" | "teammate" | "ai"; text: string; at?: string }>;
}

async function requireManager(user: AuthedUser, workspaceId: string): Promise<void> {
  if (!workspaceId) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id required");
  const m = await membership(user.id, workspaceId);
  requireRole(m, "manager");
}

/** The prompt a simulation runs against: an unsaved draft, a saved version, or the one that applies to the scope. */
async function resolveSimPrompt(b: SimulateBody): Promise<{ body: string; settings: PromptSettings; editorMode: "guided" | "raw"; version: number; id: string | null }> {
  if (b.draft_prompt) {
    const settings = await rpc<Row>("_mp_clean_settings", { p_ws: b.workspace_id, p_settings: b.draft_prompt.settings ?? {} }).catch((e) => { throw new HttpError(400, "E_PAYLOAD_INVALID", String(e.message).replace(/^E_PAYLOAD_INVALID:\s*/, "")); });
    const body = b.draft_prompt.editor_mode === "guided"
      ? await rpc<string>("_compile_master_prompt", { p_sections: b.draft_prompt.sections ?? {}, p_settings: settings })
      : String(b.draft_prompt.body ?? "");
    if (body.trim().length < 20) throw new HttpError(400, "E_PAYLOAD_INVALID", "the prompt is too short");
    return { body, settings: settingsOf(settings), editorMode: b.draft_prompt.editor_mode, version: 0, id: null };
  }
  let q = admin.from("outreach_master_prompts").select("id, version, body, editor_mode, settings, scope").eq("workspace_id", b.workspace_id);
  if (b.master_prompt_id) q = q.eq("id", b.master_prompt_id);
  else q = q.eq("scope", b.scope ?? "workspace");
  if (!b.master_prompt_id && b.scope && b.scope !== "workspace") q = q.eq("scope_id", b.scope_id ?? "00000000-0000-0000-0000-000000000000");
  let { data: mp } = await q.maybeSingle();
  if (!mp && !b.master_prompt_id && b.scope && b.scope !== "workspace") ({ data: mp } = await admin.from("outreach_master_prompts").select("id, version, body, editor_mode, settings, scope").eq("workspace_id", b.workspace_id).eq("scope", "workspace").maybeSingle());
  if (!mp) throw new HttpError(409, "E_NO_MASTER_PROMPT", "save a master prompt first, or simulate your unsaved edits");
  if (b.version && b.version !== mp.version) {
    const { data: v } = await admin.from("outreach_master_prompt_versions").select("version, body, editor_mode, settings").eq("master_prompt_id", mp.id).eq("version", b.version).maybeSingle();
    if (!v) throw new HttpError(404, "E_NOT_FOUND", `version ${b.version} not found`);
    return { body: v.body, settings: settingsOf(v.settings), editorMode: v.editor_mode, version: v.version, id: mp.id };
  }
  return { body: mp.body, settings: settingsOf(mp.settings), editorMode: mp.editor_mode, version: mp.version, id: mp.id };
}

export async function simulate(user: AuthedUser | null, b: SimulateBody): Promise<Row> {
  if (user) await requireManager(user, b.workspace_id);
  if (!Array.isArray(b.thread) || !b.thread.length || b.thread.length > 40) throw new HttpError(400, "E_PAYLOAD_INVALID", "thread must have 1–40 lines");
  if (!(await aiAvailable(b.workspace_id))) throw new HttpError(503, "E_AI_UNAVAILABLE", "AI is not configured for this workspace");
  const t0 = Date.now();
  const p = await resolveSimPrompt(b);
  let senderName = "Me", tz = "UTC";
  if (b.sender_id) {
    const { data: s } = await admin.from("outreach_senders").select("display_name, timezone, workspace_id").eq("id", b.sender_id).maybeSingle();
    if (s && s.workspace_id === b.workspace_id) { senderName = s.display_name ?? senderName; tz = s.timezone ?? tz; }
  }
  const lines = b.thread.map((l) => ({ from: (["prospect", "us", "teammate", "ai"].includes(l.from) ? l.from : "prospect") as ThreadLine["from"], text: String(l.text ?? "").slice(0, 4000) }));
  let lastOurs = -1;
  lines.forEach((l, i) => { if (l.from !== "prospect") lastOurs = i; });
  const unansweredIdx = lines.map((_, i) => i).filter((i) => i > lastOurs && lines[i].from === "prospect");
  if (!unansweredIdx.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "the last line must be the prospect's");
  const t = Date.now();
  const thread: ThreadLine[] = lines.map((l, i) => ({ ...l, at: new Date(t - (lines.length - i) * 60_000).toISOString(), answered: unansweredIdx.includes(i) }));
  // state: given, or counted from the thread
  let exchanges = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].from !== "prospect" && lines[i - 1].from === "prospect") exchanges++;
  const state: DraftState = b.state ? { stage: b.state.stage ?? null, exchanges: Number(b.state.exchanges ?? 0), last_move: b.state.last_move ?? null, ai_replies_count: Number(b.state.ai_replies_count ?? 0) }
    : { stage: null, exchanges, last_move: null, ai_replies_count: lines.filter((l) => l.from === "ai").length, stage_stale: lines.some((l) => l.from === "us" || l.from === "teammate") };
  // classify each unanswered prospect line like F18 would
  const prevOut = lines.filter((l) => l.from !== "prospect").map((l) => l.text).slice(-3);
  const classification: Classification[] = [];
  for (const i of unansweredIdx) classification.push(await classifyMessage({ workspaceId: b.workspace_id, text: lines[i].text, previousOutbound: prevOut, channel: "LINKEDIN", sentAt: thread[i].at }));
  const flags = [...new Set(classification.flatMap((c) => c.flags))];
  const burst = unansweredIdx.map((i, k) => ({ text: lines[i].text, classification: classification[k] as unknown as Row, flags: classification[k].flags }));
  const floor = floorPrecheck(burst, p.settings);
  const language = classification.map((c) => c.language).filter(Boolean).pop() ?? null;
  const gateEsc: string[] = [];
  const gates: Array<{ gate: string; ok: boolean; detail?: string }> = [];
  if (language && p.settings.languages.length && !p.settings.languages.includes(language)) { gateEsc.push("language"); gates.push({ gate: "G9", ok: false, detail: `language ${language}` }); } else gates.push({ gate: "G9", ok: true });
  if (state.ai_replies_count >= p.settings.max_ai_replies_per_chat) { gateEsc.push("turn_limit"); gates.push({ gate: "G10", ok: false, detail: `${state.ai_replies_count} AI replies` }); } else gates.push({ gate: "G10", ok: true });
  const stateAfter = (dec: string, d: DraftOutput | null) => ({
    stage: d?.stage_after ?? d?.stage_before ?? state.stage, exchanges: state.exchanges + (dec === "send" ? 1 : 0),
    last_move: dec === "send" ? (d?.move ?? state.last_move) : state.last_move, ai_replies_count: state.ai_replies_count + (dec === "send" ? 1 : 0),
  });
  if (floor.decision) {
    // the floor decides; the simulator shows what autopilot would do (no model call)
    return { decision: floor.decision, final_decision: floor.decision, text: null, stage_before: state.stage, stage_after: state.stage, move: null,
      rule_applied: floor.optOut ? "Safety rule: they asked not to be contacted" : "Safety rule", side_effects: floor.optOut ? [{ type: "archive" }] : [], facts_used: [], confidence: 1,
      escalation_reasons: floor.reasons, validator: null, verifier: null, classification, gates, redrafted: false, state_after: stateAfter(floor.decision, null), model: null, ms: Date.now() - t0 };
  }
  const ctx: DraftCtx = { workspaceId: b.workspace_id, settings: p.settings, editorMode: p.editorMode, promptBody: p.body, promptVersion: p.version, senderName, tz,
    lead: b.lead ? { full_name: b.lead.full_name ?? null, title: b.lead.title ?? null, company: b.lead.company ?? null, location: b.lead.location ?? null } : null,
    thread, state, classification, flags: floor.flags.length ? floor.flags : flags, firstStep: null, knowledge: await retrieveKnowledge(b.workspace_id, p.settings.knowledge_source_ids, classification.flatMap((c) => c.questions)),
    purpose: "reply_simulate" };
  const res = await runPipeline(ctx, floor, gateEsc);
  return {
    decision: res.draft.decision, final_decision: res.final.decision, text: res.draft.text, stage_before: res.draft.stage_before ?? state.stage,
    stage_after: res.draft.stage_after ?? res.draft.stage_before ?? state.stage, move: res.draft.move, rule_applied: res.draft.rule_applied,
    side_effects: res.draft.side_effects, facts_used: res.draft.facts_used, confidence: res.draft.confidence, escalation_reasons: res.final.reasons,
    validator: res.validator, verifier: res.verifier, classification, gates, redrafted: res.redrafted, state_after: stateAfter(res.final.decision, res.draft), model: res.model, ms: Date.now() - t0,
  };
}

// ============================================================================================ regression set
export async function regressionRun(user: AuthedUser, b: { workspace_id: string; master_prompt_id?: string | null; scope?: string; scope_id?: string | null; draft_prompt?: SimulateBody["draft_prompt"] }): Promise<Row> {
  await requireManager(user, b.workspace_id);
  // the prompt the scenarios run against
  let mpId = b.master_prompt_id ?? null, mpScope: string | null = null, mpVersion = 0, substantive = 0;
  if (!mpId) {
    const { data: mp } = await admin.from("outreach_master_prompts").select("id, scope, version, substantive_version").eq("workspace_id", b.workspace_id).eq("scope", b.scope ?? "workspace")
      .filter("scope_id", b.scope && b.scope !== "workspace" ? "eq" : "is", b.scope && b.scope !== "workspace" ? (b.scope_id ?? "") : null).maybeSingle();
    if (mp) { mpId = mp.id; mpScope = mp.scope; mpVersion = mp.version; substantive = mp.substantive_version; }
  } else {
    const { data: mp } = await admin.from("outreach_master_prompts").select("id, scope, version, substantive_version").eq("id", mpId).eq("workspace_id", b.workspace_id).maybeSingle();
    if (!mp) throw new HttpError(404, "E_NOT_FOUND", "master prompt not found");
    mpScope = mp.scope; mpVersion = mp.version; substantive = mp.substantive_version;
  }
  let q = admin.from("outreach_ai_reply_scenarios").select("*").eq("workspace_id", b.workspace_id).order("created_at");
  q = mpId ? (mpScope === "workspace" ? q.or(`master_prompt_id.eq.${mpId},master_prompt_id.is.null`) : q.eq("master_prompt_id", mpId)) : q.is("master_prompt_id", null);
  const { data: scenarios } = await q;
  const results: Row[] = [];
  const list = [...(scenarios ?? [])].slice(0, 20);
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (list.length) {
      const s = list.shift()!;
      const turns = (Array.isArray(s.turns) ? s.turns : []) as Array<{ from: "prospect" | "us"; text: string }>;
      const expected = [...(Array.isArray(s.expected) ? s.expected : [])].sort((a: Row, b: Row) => a.after_turn - b.after_turn);
      const prev = new Map<number, string | null>(((s.last_result?.turns ?? []) as Row[]).map((t) => [Number(t.after_turn), t.got?.text ?? null]));
      let state: SimulateBody["state"] | undefined = undefined;
      const turnResults: Row[] = [];
      let passed = true;
      for (const e of expected) {
        const upto = turns.slice(0, Number(e.after_turn) + 1).map((t) => ({ from: t.from === "us" ? "us" as const : "prospect" as const, text: t.text }));
        try {
          const r = await simulate(null, { workspace_id: b.workspace_id, master_prompt_id: b.draft_prompt ? null : mpId, scope: b.scope as any, scope_id: b.scope_id, draft_prompt: b.draft_prompt, thread: upto, state });
          state = r.state_after;
          const ok = r.final_decision === e.decision && (!e.stage_after || r.stage_after === e.stage_after);
          passed = passed && ok;
          const pt = prev.get(Number(e.after_turn)) ?? null;
          turnResults.push({ after_turn: e.after_turn, expected: { decision: e.decision, stage_after: e.stage_after ?? null }, got: { decision: r.final_decision, stage_after: r.stage_after, text: r.text }, prev_text: pt, changed: pt !== null && pt !== r.text, ok });
        } catch (err) {
          passed = false;
          turnResults.push({ after_turn: e.after_turn, expected: { decision: e.decision, stage_after: e.stage_after ?? null }, got: { decision: "escalate", stage_after: null, text: null }, prev_text: prev.get(Number(e.after_turn)) ?? null, changed: false, ok: false, error: String((err as any)?.message ?? err).slice(0, 300) });
        }
      }
      const one = { scenario_id: s.id, name: s.name, passed, turns: turnResults };
      results.push(one);
      if (!b.draft_prompt) await rpc("ai_reply_scenario_record", { p_id: s.id, p_result: one, p_version: Math.max(mpVersion, substantive), p_passed: passed }).catch((e) => log({ fn: "regression", warn: String(e) }));
    }
  }));
  results.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { total: results.length, passed: results.filter((r) => r.passed).length, results };
}

// ============================================================================================ master prompt save + consent (§4.1)
export async function masterPromptSave(user: AuthedUser, b: Row): Promise<Row> {
  await requireManager(user, b.workspace_id);
  const { data: prompt, error } = await user.client.rpc("outreach_master_prompt_save", {
    p_ws: b.workspace_id, p_scope: b.scope ?? "workspace", p_scope_id: b.scope_id ?? null, p_editor_mode: b.editor_mode, p_body: b.body ?? null,
    p_sections: b.sections ?? null, p_settings: b.settings ?? {}, p_change_kind: b.change_kind, p_note: b.note ?? null, p_base_version: b.base_version ?? null,
  });
  if (error) throw rpcError(error.message);
  const out: Row = { prompt, reconsent: { senders: 0, links: [] as Row[] } };
  if (prompt?.change_kind !== "substantive" || !prompt?.id) return out;
  // a substantive change invalidates every consent on this prompt: ask the owners again (operator-owners re-grant in the app)
  const { data: consents } = await admin.from("outreach_ai_reply_consent").select("sender_id, granted_via, master_prompt_version").eq("master_prompt_id", prompt.id).is("revoked_at", null);
  const senders = [...new Set((consents ?? []).filter((c) => c.master_prompt_version < prompt.substantive_version && c.granted_via === "signed_link").map((c) => c.sender_id))];
  out.reconsent.senders = senders.length;
  for (const sid of senders.slice(0, 5)) {
    try {
      const r = await consentRequest(user, { workspace_id: b.workspace_id, sender_id: sid, master_prompt_id: prompt.id }, true);
      if (r.link) out.reconsent.links.push({ sender_id: sid, sender_name: r.sender_name, url: r.link });
    } catch (e) { log({ fn: "master-prompt-save", warn: `reconsent ${sid}: ${String((e as any)?.message ?? e)}` }); }
  }
  return out;
}

function rpcError(message: string): HttpError {
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(message);
  if (!m) return new HttpError(500, "E_INTERNAL", message);
  const status = m[1] === "E_FORBIDDEN" ? 403 : m[1] === "E_NOT_FOUND" ? 404 : m[1] === "E_CONFLICT" ? 409 : m[1] === "E_PLAN_SUSPENDED" ? 403 : 400;
  return new HttpError(status, m[1], m[2] || m[1]);
}

/** Three example drafts from this sender's own recent threads, for the consent screen (§4.1). Never sends, never writes runs. */
async function consentExamples(workspaceId: string, senderId: string, mpId: string): Promise<Row[]> {
  const { data: chats } = await admin.from("outreach_chats").select("id").eq("sender_id", senderId).eq("provider", "LINKEDIN").eq("last_direction", "in").eq("is_group", false)
    .not("lead_id", "is", null).order("last_message_at", { ascending: false }).limit(6);
  const { data: mp } = await admin.from("outreach_master_prompts").select("settings").eq("id", mpId).single();
  const settings = settingsOf(mp?.settings);
  const out: Row[] = [];
  for (const c of chats ?? []) {
    if (out.length >= 3) break;
    const { data: msgs } = await admin.from("outreach_messages").select("direction, text, sent_at, origin").eq("chat_id", c.id).is("deleted_at", null).is("event_type", null).not("text", "is", null).order("sent_at", { ascending: false }).limit(8);
    const thread = [...(msgs ?? [])].reverse().map((m) => ({ from: m.direction === "in" ? "prospect" as const : "us" as const, text: String(m.text ?? "") }));
    if (!thread.length || thread[thread.length - 1].from !== "prospect") continue;
    try {
      const r = await simulate(null, { workspace_id: workspaceId, master_prompt_id: mpId, sender_id: senderId, thread });
      const stage = settings.stages.find((s) => s.key === r.stage_after);
      out.push({ prospect: thread.filter((l) => l.from === "prospect").slice(-1)[0].text.slice(0, 600), reply: r.final_decision === "send" ? r.text : null,
        decision: r.final_decision, stage: r.stage_after, stage_label: stage?.label ?? (r.stage_after === CLOSING ? "Closing" : null) });
    } catch (e) { log({ fn: "consent-examples", warn: String((e as any)?.message ?? e) }); }
  }
  return out;
}

export async function consentRequest(user: AuthedUser, b: { workspace_id: string; sender_id: string; master_prompt_id: string }, reconsent = false): Promise<Row> {
  await requireManager(user, b.workspace_id);
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, client_id, display_name, owner_email, owner_user_id, provider").eq("id", b.sender_id).is("deleted_at", null).maybeSingle();
  if (!s || s.workspace_id !== b.workspace_id) throw new HttpError(404, "E_NOT_FOUND", "sender not found");
  if (!CHANNELS_V1.includes(s.provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", "AI replies are LinkedIn only for now");
  const m = await membership(user.id, b.workspace_id);
  if (!clientVisible(m, s.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  const { data: mp } = await admin.from("outreach_master_prompts").select("id, workspace_id, version, scope").eq("id", b.master_prompt_id).maybeSingle();
  if (!mp || mp.workspace_id !== b.workspace_id) throw new HttpError(404, "E_NOT_FOUND", "master prompt not found");
  // the owner is the person asking: consent is immediate (§4.1 owner_is_operator)
  const isOwner = s.owner_user_id === user.id || (!!user.email && !!s.owner_email && String(s.owner_email).toLowerCase() === user.email.toLowerCase());
  if (isOwner && !reconsent) {
    const { error } = await user.client.rpc("outreach_ai_consent_grant_operator", { p_sender: s.id, p_mp: mp.id });
    if (error) throw rpcError(error.message);
    return { granted: true, sender_name: s.display_name };
  }
  const { data: pol } = await admin.rpc("outreach__ai_policy", { p_ws: b.workspace_id, p_client: s.client_id, p_sequence: null, p_sender: s.id });
  const scope = { daily_cap: Math.min(40, Number((pol as Row)?.max_ai_sends_per_sender_day ?? 25)), delay_min_s: Number((pol as Row)?.delay_min_s ?? 240), delay_max_s: Number((pol as Row)?.delay_max_s ?? 1200) };
  const examples = await consentExamples(b.workspace_id, s.id, mp.id).catch(() => []);
  const link = await rpc<Row>("ai_consent_link_create", { p_sender: s.id, p_mp: mp.id, p_by: user.id, p_email: s.owner_email, p_scope: scope, p_examples: examples });
  const url = `${WEB_ORIGIN}/ai-reply-consent/${link.token}`;
  let emailed = false;
  if (s.owner_email && emailConfigured()) {
    const branding = await workspaceBranding(b.workspace_id);
    const html = layout(reconsent ? "Your AI reply prompt changed — please review it again" : "Can the AI answer LinkedIn replies as you?",
      `<p>Your team would like to turn on <b>Autopilot</b> for <b>${esc(s.display_name ?? "your LinkedIn account")}</b>: the AI answers replies from prospects as you, after a short hold, following a written prompt. It never claims to be human.</p>
       <p>Before anything is sent, read the exact prompt, the limits (up to ${esc(scope.daily_cap)} replies a day, ${Math.round(scope.delay_min_s / 60)}–${Math.round(scope.delay_max_s / 60)} minutes after their message) and three example replies from your own conversations.</p>
       <p style="margin-top:18px">${button(url, "Review and decide", branding)}</p><p>The link works for 7 days. Nothing changes if you ignore it.</p>`, branding, { audience: "client" });
    emailed = await sendEmail(String(s.owner_email), reconsent ? "Please review the updated AI reply prompt" : "Approve AI replies on your LinkedIn account", html, undefined, { branding });
  }
  // same rule as reconnect / profile links: the operator sees the link only when it could not be emailed (audited in the SQL)
  return { link: emailed ? undefined : url, emailed, expires_at: link.expires_at, sender_name: s.display_name };
}

export async function consentView(token: string): Promise<Row> {
  const v = await rpc<Row>("ai_consent_link_view", { p_token: token });
  if (!v || v.status === "not_found") throw new HttpError(404, "E_NOT_FOUND", "this link is not valid");
  const { workspace_id: _ws, ...rest } = v;
  return rest;
}

export async function consentAccept(token: string, evidence: Row): Promise<Row> {
  let r: Row;
  try { r = await rpc<Row>("ai_consent_link_accept", { p_token: token, p_evidence: evidence }); }
  catch (e) { throw rpcError(String((e as any)?.message ?? e)); }
  const revokeUrl = `${WEB_ORIGIN}/ai-reply-consent/revoke/${r.revoke_token}`;
  if (r.email && emailConfigured()) {
    const branding = await workspaceBranding(r.workspace_id);
    const html = layout("Autopilot is on for your LinkedIn account",
      `<p>Thanks. The AI may now answer LinkedIn replies as you, within the limits you saw. You get a weekly summary of what it sent.</p><p>To turn it off at any time, use this link. It works in one click and cancels any reply waiting to go out:</p><p style="margin-top:14px">${button(revokeUrl, "Turn Autopilot off", branding)}</p>`, branding, { audience: "client" });
    await sendEmail(String(r.email), "Autopilot is on — how to turn it off", html, undefined, { branding }).catch(() => false);
  }
  return { ok: true, revoke_url: revokeUrl };
}

export async function consentRevokeView(token: string): Promise<Row> {
  const v = await rpc<Row>("ai_consent_revoke_view", { p_token: token });
  if (!v || v.status === "not_found") throw new HttpError(404, "E_NOT_FOUND", "this link is not valid");
  return v;
}

export async function consentRevoke(token: string, evidence: Row): Promise<Row> {
  try { return await rpc<Row>("ai_consent_revoke_by_token", { p_token: token, p_evidence: evidence }); }
  catch (e) { throw rpcError(String((e as any)?.message ?? e)); }
}
