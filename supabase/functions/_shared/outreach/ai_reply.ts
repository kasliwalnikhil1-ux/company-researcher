// AI replies v2 (ai-auto-reply-PRD.md + ai-replies-changes.md; docs/outreach/AI-REPLIES-V2-CONTRACT.md): the cron worker (F32),
// the dispatcher (F33), Draft with AI (F38), compose assist (F40), lead notes (F39), inactivity (F41), knowledge crawl,
// unanswered questions (F42), maintenance / breakers / digests, the simulator + test conversations, consent links and emails.
// The database decides state (040–042: every transition is a compare-and-set in SQL); this file does the model calls
// (ai_reply_engine.ts), the code checks (ai_reply_rules.ts) and the connector send (reply.ts deliverChatMessage).
import { admin, log, rpc, HttpError, WEB_ORIGIN, membership, requireRole, clientVisible, type AuthedUser } from "./supabase.ts";
import { llmCallDetailed, AI_BUSY_MESSAGE } from "./llm.ts";
import { classifyMessage, aiAvailable, type Classification } from "./ai.ts";
import { AI_LEAD_NOTES_SYSTEM, AI_COMPOSE_IMPROVE_SYSTEM, AI_COMPOSE_TRANSLATE_SYSTEM, AI_UNANSWERED_CANONICAL_SYSTEM } from "./prompts.ts";
import { deliverChatMessage } from "./reply.ts";
import { classifyMessageById } from "./workers.ts";
import { UnipileError } from "./unipile.ts";
import { sendEmail, layout, button, esc, workspaceBranding, workspaceRecipients, emailConfigured } from "./notify.ts";
import { computeSendAt, evaluateGates, floorPrecheck, minMode, nextWindowStart, parseCountry, validateDraft, factsOf, CLOSING, type Mode, type Schedule } from "./ai_reply_rules.ts";
import {
  runEngine, contextFromFacts, patchFromResult, floorSha, settingsOf, parseJsonLoose, stopRulesOf, effectiveBody, fillPrompt,
  type EngineInput, type EngineOpts, type ThreadLine, type DraftState, type ScenarioCard, type Faq, type PipelineResult,
} from "./ai_reply_engine.ts";
import { BATCH as CATALOGUE_BATCH, CATALOGUE_MAX_PRODUCTS, CatalogueError, productsFromHtml, syncCatalogue, type CatalogueProduct, type SyncCursor, type SyncIo } from "./catalogue.ts";

type Row = Record<string, any>;
/** v1 policy: AI replies on LinkedIn only (PRD §2.2). The SQL resolver enforces the same. */
export const CHANNELS_V1 = ["LINKEDIN"];
export { DEFAULT_SETTINGS, settingsOf } from "./ai_reply_engine.ts";

let domainsCache: { at: number; rows: Array<{ host: string; path_prefix: string | null }> } | null = null;
async function schedulingDomains(): Promise<Array<{ host: string; path_prefix: string | null }>> {
  if (domainsCache && Date.now() - domainsCache.at < 10 * 60_000) return domainsCache.rows;
  const { data } = await admin.from("outreach_scheduling_domains").select("host, path_prefix");
  domainsCache = { at: Date.now(), rows: (data ?? []) as any };
  return domainsCache.rows;
}

// ============================================================================================ F32 worker
export async function runDraftWorker(budgetMs = 40_000): Promise<Row> {
  const started = Date.now();
  const runs = await rpc<Row[]>("ai_reply_claim", { p_limit: 25 });
  let done = 0, failed = 0;
  const queue = [...(runs ?? [])];
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
        const attempts = Number(run.attempts ?? 1);
        if (attempts < 3) await rpc("ai_reply_finalize", { p_run: run.id, p_to: "debouncing", p_patch: { error: msg, next_attempt_at: new Date(Date.now() + (attempts <= 1 ? 5_000 : 20_000)).toISOString() } }).catch(() => null);
        else await rpc("ai_reply_finalize", { p_run: run.id, p_to: "failed", p_patch: { error: msg, escalation_reasons: ["model_error"] } }).catch(() => null);
      }
    }
  }));
  return { claimed: runs?.length ?? 0, done, failed, ms: Date.now() - started };
}

async function classifyInline(facts: Row, runId: string): Promise<Row> {
  const unclassified = (facts.burst ?? []).filter((m: Row) => !m.classified && !m.deleted && (String(m.text ?? "").trim() || String(m.transcript ?? "").trim()));
  if (!unclassified.length) return facts;
  for (const m of unclassified) {
    try { await classifyMessageById(m.id); await admin.from("outreach_ai_classify_queue").delete().eq("message_id", m.id); }
    catch (e) { log({ fn: "ai-reply-worker", warn: `inline classify: ${String((e as any)?.message ?? e)}`, message_id: m.id }); }
  }
  return await rpc<Row>("ai_reply_gate_facts", { p_run: runId });
}

export async function processRun(run: Row): Promise<void> {
  let facts = await rpc<Row>("ai_reply_gate_facts", { p_run: run.id });
  if (!facts) return;
  facts = await classifyInline(facts, run.id);
  const eff = facts.effective as Row;
  const chat = facts.chat as Row, sender = facts.sender as Row, lead = facts.lead as Row | null, srs = facts.settings_row as Row | null;
  const settings = settingsOf(eff?.settings);
  const pol = (eff?.policy ?? {}) as Row;
  const mode = (eff?.mode ?? "off") as Mode;
  const burst = (facts.burst ?? []) as Row[];
  const newest = burst.map((m) => m.sent_at).sort().pop() ?? null;
  const language = burst.map((m) => m.classification?.language).filter(Boolean).pop() ?? null;
  const common = { policy_snapshot: pol, mode, timings: { drafted_at: new Date().toISOString() } };

  if (!CHANNELS_V1.includes(String(chat.provider)) || mode === "off" || !eff?.master_prompt || chat.handed_off_at) {
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
  // T5 / T6 (§2.2): the reply limit or the hand-off stage ends the AI conversation with no reply; a person takes over
  if (gates.escalate.includes("turn_limit") || gates.escalate.includes("stage")) {
    const reason = gates.escalate.includes("stage") ? "stage" : "max_replies";
    const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "cancelled", p_patch: { ...common, cancel_reason: `handoff:${reason}`, gate_failures: gates.failures, handoff_reason: reason } });
    if (f?.handoff?.ok && !f.handoff.already) await notifyHandoff(run.chat_id, f.handoff).catch((e) => log({ fn: "ai-reply-worker", warn: `notify handoff: ${String(e)}` }));
    return;
  }
  const unlabelled = burst.some((m) => (String(m.text ?? "").trim() || String(m.transcript ?? "").trim()) && (!m.classification || m.classification.fallback === true));
  if (unlabelled) gates.failures.push("unclassified");
  let effMode = unlabelled ? minMode(minMode(mode, gates.maxMode), "draft") : minMode(mode, gates.maxMode);
  // §3: replies received before the sequence resumed stay drafts
  const resumedAt = eff?.sequence_resumed_at ? new Date(eff.sequence_resumed_at).getTime() : 0;
  if (effMode === "autopilot" && resumedAt && newest && new Date(newest).getTime() < resumedAt) { effMode = "draft"; gates.failures.push("before_resume"); }
  const floor = floorPrecheck(burst.map((m) => ({ text: m.text, transcript: m.transcript, attachments: m.attachments, unsupported: m.unsupported, deleted: m.deleted, classification: m.classification, flags: m.flags })), settings);
  const mp = facts.master_prompt as Row;
  const base = {
    ...common, mode: effMode, flags: floor.flags, language, intent: burst.map((m) => m.intent).filter(Boolean).pop() ?? null, gate_failures: gates.failures,
    master_prompt_id: mp.id, master_prompt_version: mp.version, floor_sha256: await floorSha(),
  };
  // the floor decides alone in autopilot (opt-out, attachments, injection, bot question): no model call
  if (floor.decision && effMode === "autopilot") {
    if (floor.decision === "no_reply") {
      await rpc("ai_reply_finalize", { p_run: run.id, p_to: "no_reply", p_patch: { ...base, decision: "no_reply", rule_applied: "Safety rule: they asked not to be contacted", side_effects: [{ type: "opt_out" }] } });
    } else {
      const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "escalated", p_patch: { ...base, decision: "escalate", escalation_reasons: floor.reasons, rule_applied: "Safety rule" } });
      if (f?.ok) await notifyEscalation(run.id).catch((e) => log({ fn: "ai-reply-worker", warn: `notify: ${String(e)}` }));
    }
    return;
  }
  const ctx = contextFromFacts(facts, floor.flags, await schedulingDomains(), "reply_draft");
  const res = await runEngine(ctx, { trigger: "auto" }, gates.escalate, floor);
  // T2: they confirmed a meeting → this reply is the last one (as the prompt says: e.g. one-line thanks)
  const meetingConfirmed = floor.flags.includes("meeting_confirmed");
  const patch: Row = { ...base, ...patchFromResult(res, ctx) };
  if (meetingConfirmed && res.final.decision === "send" && !patch.stop_after_send) { patch.stop_after_send = true; patch.stop_rule = "meeting confirmed"; }
  // §9.3: a question the prompt / knowledge could not answer
  if (res.draft.unanswered_question || (res.final.reasons.includes("verifier") && res.verifier && !res.verifier.answers_their_questions)) {
    await recordUnanswered(run.id, res.draft.unanswered_question ?? burst.map((m) => m.text).filter(Boolean).join(" ").slice(0, 300), burst[0]?.id ?? null).catch((e) => log({ fn: "ai-reply-worker", warn: `unanswered: ${String(e)}` }));
  }
  if (effMode === "draft") { await rpc("ai_reply_finalize", { p_run: run.id, p_to: "draft_ready", p_patch: patch }); return; }
  if (res.final.decision === "escalate") {
    const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "escalated", p_patch: patch });
    if (f?.ok) await notifyEscalation(run.id).catch((e) => log({ fn: "ai-reply-worker", warn: `notify: ${String(e)}` }));
    return;
  }
  if (res.final.decision === "no_reply") {
    // T4 with no reply: a Stop rule met by what they said → hand off now
    const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "no_reply", p_patch: res.stop_after_send ? { ...patch, handoff_reason: "stop_rule" } : patch });
    if (f?.handoff?.ok && !f.handoff.already) await notifyHandoff(run.chat_id, f.handoff).catch(() => null);
    return;
  }
  // send → hold (§7). Never the "live" fast delay for the first reply of a new session (§6); warm-up: 30–40 min (§4.3)
  const thread = ctx.thread;
  const firstAnswered = thread.find((l) => l.answered);
  const lastOurs = [...thread].reverse().find((l) => l.from !== "prospect" && firstAnswered && (l.at ?? "") < (firstAnswered.at ?? ""));
  const newSession = ctx.state.session_kind !== "normal" && Number(chat.ai_replies_count ?? 0) === 0;
  const live = !newSession && !!(firstAnswered?.at && lastOurs?.at && new Date(firstAnswered.at).getTime() - new Date(lastOurs.at).getTime() < 5 * 60_000);
  const warmup = Number(srs?.warmup_remaining ?? 0) > 0;
  const sendAt = warmup
    ? computeSendAt({ now: new Date(), delayMinS: 30 * 60, delayMaxS: 40 * 60, draftLength: 0, live: false, schedule: sender.schedule as Schedule, tz: sender.timezone ?? "UTC" })
    : computeSendAt({ now: new Date(), delayMinS: Number(pol.delay_min_s ?? 240), delayMaxS: Number(pol.delay_max_s ?? 1200), draftLength: (res.draft.text ?? "").length, live, schedule: sender.schedule as Schedule, tz: sender.timezone ?? "UTC" });
  if (run.lead_id) {
    const lo = new Date(sendAt.getTime() - 30 * 60_000).toISOString(), hi = new Date(sendAt.getTime() + 30 * 60_000).toISOString();
    const { data: other } = await admin.from("outreach_ai_reply_runs").select("id").eq("lead_id", run.lead_id).neq("chat_id", run.chat_id)
      .or(`and(status.eq.scheduled,scheduled_send_at.gte.${lo},scheduled_send_at.lte.${hi}),and(status.in.(sending,sent),updated_at.gte.${new Date(Date.now() - 30 * 60_000).toISOString()})`).limit(1);
    if (other?.length) { await rpc("ai_reply_finalize", { p_run: run.id, p_to: "draft_ready", p_patch: { ...patch, mode: "draft", gate_failures: [...gates.failures, "other_sender"] } }); return; }
  }
  const f = await rpc<Row>("ai_reply_finalize", { p_run: run.id, p_to: "scheduled", p_patch: { ...patch, scheduled_send_at: sendAt.toISOString(), timings: { drafted_at: new Date().toISOString(), scheduled_at: new Date().toISOString(), warmup } } });
  if (f?.ok && warmup) await notifyWarmupHold(run.id, sendAt, Number(srs?.warmup_remaining ?? 0)).catch((e) => log({ fn: "ai-reply-worker", warn: `warmup notify: ${String(e)}` }));
}

async function recordUnanswered(runId: string, question: string, messageId: string | null): Promise<void> {
  if (!question?.trim()) return;
  const { data: r } = await admin.from("outreach_ai_reply_runs").select("workspace_id").eq("id", runId).single();
  let canonical = question.trim().slice(0, 300);
  try {
    const c = await llmCallDetailed({ purpose: "unanswered_canonical", workspaceId: r!.workspace_id, system: AI_UNANSWERED_CANONICAL_SYSTEM, user: JSON.stringify({ questions: [question] }), maxTokens: 512, temperature: 0, json: true, thinking: "LOW" });
    const j = parseJsonLoose(c.text);
    if (Array.isArray(j.canonical) && typeof j.canonical[0] === "string" && j.canonical[0].trim()) canonical = j.canonical[0].trim().slice(0, 300);
  } catch (e) { log({ fn: "ai-reply-worker", warn: `canonical: ${String((e as any)?.message ?? e)}` }); }
  await rpc("ai_unanswered_add", { p_run: runId, p_canonical: canonical, p_text: question.slice(0, 500), p_message: messageId });
}

// ============================================================================================ F38 Draft with AI (§5)
export interface DraftNowBody { chat_id: string; guidance?: string | null; variants?: number; regenerate?: boolean; via?: "inbox" | "mcp" }

export async function draftNow(user: AuthedUser, b: DraftNowBody): Promise<Row> {
  if (!b.chat_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id required");
  const { data: chat } = await admin.from("outreach_chats").select("id, workspace_id, client_id, provider").eq("id", b.chat_id).maybeSingle();
  if (!chat) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, chat.workspace_id);
  requireRole(m, "member");
  if (!m.can_reply) throw new HttpError(403, "E_FORBIDDEN", "replies are disabled for your account");
  if (!clientVisible(m, chat.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  if (!CHANNELS_V1.includes(chat.provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", "AI drafts are LinkedIn only for now");
  if (!(await aiAvailable(chat.workspace_id))) throw new HttpError(503, "E_AI_UNAVAILABLE", "AI is not configured for this workspace");
  const guidance = (b.guidance ?? "").toString().trim().slice(0, 300) || null;
  let open: Row;
  try { open = await rpc<Row>("ai_reply_manual_open", { p_chat: chat.id, p_user: user.id, p_via: b.via === "mcp" ? "mcp" : "inbox", p_guidance: guidance, p_variants: b.variants ?? 1, p_regenerate: !!b.regenerate }); }
  catch (e) { throw rpcError(String((e as any)?.message ?? e)); }
  if (open.source !== "new") {
    const { data: run } = await admin.from("outreach_ai_reply_runs").select("*").eq("id", open.run_id).single();
    return { run_id: open.run_id, source: open.source, status: open.status, prompt: open.prompt, drafts: [await draftView(run!)] };
  }
  const { data: run } = await admin.from("outreach_ai_reply_runs").select("*").eq("id", open.run_id).single();
  try {
    let facts = await rpc<Row>("ai_reply_gate_facts", { p_run: run!.id });
    facts = await classifyInline(facts, run!.id);
    const burst = (facts.burst ?? []) as Row[];
    const settings = settingsOf(facts.effective?.settings);
    const floor = floorPrecheck(burst.map((mm) => ({ text: mm.text, transcript: mm.transcript, attachments: mm.attachments, unsupported: mm.unsupported, deleted: mm.deleted, classification: mm.classification, flags: mm.flags })), settings);
    const ctx = contextFromFacts(facts, floor.flags, await schedulingDomains(), "reply_draft");
    const res = await runEngine(ctx, { trigger: "manual", guidance, variants: b.variants ?? 1 }, [], floor);
    const mp = facts.master_prompt as Row;
    const patch: Row = {
      policy_snapshot: facts.effective?.policy ?? {}, mode: "draft", flags: floor.flags, language: burst.map((mm) => mm.classification?.language).filter(Boolean).pop() ?? null,
      intent: burst.map((mm) => mm.intent).filter(Boolean).pop() ?? null, master_prompt_id: mp?.id ?? null, master_prompt_version: mp?.version ?? 0, floor_sha256: await floorSha(),
      timings: { drafted_at: new Date().toISOString() }, ...patchFromResult(res, ctx),
    };
    if (floor.decision === "no_reply" && !res.warnings.some((w) => w.code === "opt_out")) patch.warnings = [...(patch.warnings ?? []), { code: "opt_out", text: "They asked not to be contacted" }];
    const f = await rpc<Row>("ai_reply_finalize", { p_run: run!.id, p_to: "draft_ready", p_patch: patch });
    if (!f?.ok) throw new HttpError(409, "E_CONFLICT", "a new message arrived while drafting — try again");
    if (res.draft.unanswered_question) recordUnanswered(run!.id, res.draft.unanswered_question, burst[0]?.id ?? null).catch(() => null);
    const { data: saved } = await admin.from("outreach_ai_reply_runs").select("*").eq("id", run!.id).single();
    const view = await draftView(saved!);
    return { run_id: run!.id, source: "new", status: "draft_ready", prompt: open.prompt, drafts: [view, ...res.variants.map((t) => ({ ...view, text: t, variant: true }))] };
  } catch (e) {
    const msg = String((e as any)?.message ?? e).slice(0, 500);
    await rpc("ai_reply_finalize", { p_run: run!.id, p_to: "failed", p_patch: { error: msg, escalation_reasons: ["model_error"] } }).catch(() => null);
    if (e instanceof HttpError) throw e;
    log({ fn: "ai_reply", run_id: run!.id, error: msg });
    throw new HttpError(502, "E_AI_BUSY", AI_BUSY_MESSAGE);
  }
}

async function draftView(run: Row): Promise<Row> {
  const title = run.scenario_id ? (await admin.from("outreach_master_prompt_scenarios").select("title").eq("id", run.scenario_id).maybeSingle()).data?.title ?? null : null;
  return {
    run_id: run.id, text: run.draft_text, decision: run.decision, stage_before: run.stage_before, stage_after: run.stage_after, move: run.move,
    rule_applied: run.rule_applied, scenario_id: run.scenario_id, scenario_title: title, facts_used: run.facts_used ?? [], side_effects: run.side_effects ?? [],
    warnings: run.warnings ?? [], would_stop: !!run.stop_after_send, stop_rule: run.stop_rule, escalation_reasons: run.escalation_reasons ?? [],
    version: run.master_prompt_version, status: run.status, scheduled_send_at: run.scheduled_send_at, trigger: run.trigger_kind, guidance: run.guidance,
  };
}

/** "Edit" on a scheduled auto draft: cancel the send before the person types. */
export async function takeManual(user: AuthedUser, runId: string): Promise<Row> {
  const { data: run } = await admin.from("outreach_ai_reply_runs").select("id, workspace_id, client_id, chat_id").eq("id", runId).maybeSingle();
  if (!run) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, run.workspace_id);
  requireRole(m, "member");
  if (!clientVisible(m, run.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  try { return await rpc<Row>("ai_reply_take_manual", { p_run: runId, p_user: user.id }); }
  catch (e) { throw rpcError(String((e as any)?.message ?? e)); }
}

// ============================================================================================ F40 compose assist (§9.5)
export interface ComposeAssistBody { chat_id: string; action: "improve" | "translate_out" | "translate_in"; text?: string; message_id?: string; language?: string | null }

export async function composeAssist(user: AuthedUser, b: ComposeAssistBody): Promise<Row> {
  if (!b.chat_id || !["improve", "translate_out", "translate_in"].includes(b.action)) throw new HttpError(400, "E_PAYLOAD_INVALID", "chat_id and action (improve | translate_out | translate_in) required");
  const { data: chat } = await admin.from("outreach_chats").select("id, workspace_id, client_id, sender_id, reply_sequence_id, attendee_name").eq("id", b.chat_id).maybeSingle();
  if (!chat) throw new HttpError(404, "E_NOT_FOUND");
  const m = await membership(user.id, chat.workspace_id);
  requireRole(m, "member");
  if (!m.can_reply) throw new HttpError(403, "E_FORBIDDEN", "replies are disabled for your account");
  if (!clientVisible(m, chat.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  if (!(await aiAvailable(chat.workspace_id))) throw new HttpError(503, "E_AI_UNAVAILABLE", "AI is not configured for this workspace");
  const { data: msgs } = await admin.from("outreach_messages").select("id, direction, text, transcript, classification, translation, sent_at").eq("chat_id", chat.id).is("deleted_at", null).is("event_type", null).order("sent_at", { ascending: false }).limit(12);
  const thread = [...(msgs ?? [])].reverse();
  const prospectLang = thread.filter((x) => x.direction === "in").map((x) => x.classification?.language).filter(Boolean).pop() ?? null;
  const lang = (b.language ?? "").toString().trim().toLowerCase();
  const target = /^[a-z]{2,3}$/.test(lang) ? lang : null;

  if (b.action === "translate_in") {
    const msg = thread.find((x) => x.id === b.message_id) ?? (msgs ?? []).find((x) => x.id === b.message_id);
    if (!msg) throw new HttpError(404, "E_NOT_FOUND", "message not in this chat");
    const src = String(msg.text ?? msg.transcript ?? "").trim();
    if (!src) throw new HttpError(400, "E_PAYLOAD_INVALID", "nothing to translate");
    const want = target ?? "en";
    if (msg.translation?.lang === want && msg.translation?.text) return { text: msg.translation.text, language: want, cached: true, warnings: [] };
    const r = await llmCallDetailed({ purpose: "compose_assist", workspaceId: chat.workspace_id, system: AI_COMPOSE_TRANSLATE_SYSTEM, user: `Target language: ${want}\n\nMESSAGE (data):\n${JSON.stringify({ untrusted_content: true, text: src.slice(0, 4000) })}`, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
    const j = parseJsonLoose(r.text);
    const out = String(j.text ?? "").trim();
    if (!out) throw new HttpError(502, "E_AI_FAILED", "no translation returned");
    await admin.from("outreach_messages").update({ translation: { lang: want, text: out.slice(0, 8000), at: new Date().toISOString(), source_language: j.source_language ?? null } }).eq("id", msg.id);
    return { text: out, language: want, cached: false, warnings: [] };
  }
  const text = String(b.text ?? "").trim();
  if (!text) throw new HttpError(400, "E_PAYLOAD_INVALID", "text required");
  if (text.length > 4000) throw new HttpError(400, "E_PAYLOAD_INVALID", "text is longer than 4,000 characters");
  const ctxLines = thread.slice(-8).map((x) => `${x.direction === "in" ? "prospect" : "us"}: ${x.direction === "in" ? JSON.stringify({ untrusted_content: true, text: String(x.text ?? x.transcript ?? "").slice(0, 800) }) : String(x.text ?? "").slice(0, 800)}`).join("\n");
  if (b.action === "translate_out") {
    const want = target ?? prospectLang ?? "en";
    const r = await llmCallDetailed({ purpose: "compose_assist", workspaceId: chat.workspace_id, system: AI_COMPOSE_TRANSLATE_SYSTEM, user: `Target language: ${want}\n\nTHREAD (context only):\n${ctxLines}\n\nMESSAGE TO TRANSLATE:\n"""\n${text}\n"""`, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
    const j = parseJsonLoose(r.text);
    const out = String(j.text ?? "").trim();
    if (!out) throw new HttpError(502, "E_AI_FAILED", "no translation returned");
    return { text: out, language: want, warnings: factWarnings(text, out) };
  }
  // improve: the sequence prompt's Style + thread; meaning kept; new facts are a warning
  let style = "- 1–3 short sentences. LinkedIn chat: no subject, no signature.";
  let allowed = "";
  if (chat.reply_sequence_id) {
    const { data: srs } = await admin.from("outreach_sequence_reply_settings").select("master_prompt_id").eq("sequence_id", chat.reply_sequence_id).maybeSingle();
    if (srs?.master_prompt_id) {
      const { data: mp } = await admin.from("outreach_master_prompts").select("body, sections").eq("id", srs.master_prompt_id).maybeSingle();
      const s = (mp?.sections as Row | null)?.style; if (typeof s === "string" && s.trim()) style = s;
      const mm = String(mp?.body ?? "").match(/##\s*Style\s*\n([\s\S]*?)(?=\n##\s|\s*$)/i); if (mm) style = mm[1].trim();
      allowed = String(mp?.body ?? "");
    }
  }
  const r = await llmCallDetailed({ purpose: "compose_assist", workspaceId: chat.workspace_id, system: AI_COMPOSE_IMPROVE_SYSTEM, user: `STYLE:\n${style}\n\nTHREAD (context only):\n${ctxLines}\n\nTEXT TO IMPROVE:\n"""\n${text}\n"""`, maxTokens: 2048, temperature: 0.3, json: true, thinking: "LOW" });
  const j = parseJsonLoose(r.text);
  const out = String(j.text ?? "").trim();
  if (!out) throw new HttpError(502, "E_AI_FAILED", "no rewrite returned");
  const warnings = factWarnings(text, out);
  // facts in the person's own text that the prompt does not state: a warning, never a silent removal
  if (allowed) {
    const v = validateDraft({ decision: "send", text: out, stage_before: null, stage_after: null, move: null, rule_applied: null, side_effects: [], facts_used: [], confidence: 1, escalation_reason: null, language: null, stop_after_send: false, stop_rule: null, scenario_id: null, unanswered_question: null },
      { settings: settingsOf(null), editorMode: "raw", allowedText: allowed, prospectText: thread.filter((x) => x.direction === "in").map((x) => x.text ?? "").join("\n"), prospectLanguage: null, exchanges: 99, flags: [], prevMove: null, ourEarlierTexts: [], stageBefore: null });
    for (const f of v.failures) if (["url", "email", "phone", "figure", "date"].includes(f.rule)) warnings.push({ code: "not_in_prompt", text: f.detail });
  }
  return { text: out, language: typeof j.language === "string" ? j.language : null, warnings };
}

/** A rewrite / translation must not add or drop a number, link, date or contact. */
function factWarnings(before: string, after: string): Array<{ code: string; text: string }> {
  const a = factsOf(before), b = factsOf(after);
  const out: Array<{ code: string; text: string }> = [];
  for (const k of ["urls", "emails", "phones", "money", "percents", "dates"] as const) {
    const added = b[k].filter((x) => !a[k].includes(x)); const removed = a[k].filter((x) => !b[k].includes(x));
    if (added.length) out.push({ code: "fact_added", text: `Added ${k === "money" ? "a figure" : k.slice(0, -1)} not in your text: ${added[0]}` });
    if (removed.length) out.push({ code: "fact_removed", text: `Dropped ${k === "money" ? "a figure" : k.slice(0, -1)} from your text: ${removed[0]}` });
  }
  return out;
}

// ============================================================================================ F39 lead notes (§9.4)
export async function runLeadNotes(budgetMs = 40_000): Promise<Row> {
  const started = Date.now();
  const items = await rpc<Row[]>("ai_lead_notes_claim", { p_limit: 10 });
  let done = 0, failed = 0;
  for (const it of items ?? []) {
    if (Date.now() - started > budgetMs) break;
    try {
      const { data: msgs } = await admin.from("outreach_messages").select("id, text, transcript, sent_at, direction").in("id", it.message_ids ?? []).order("sent_at");
      const texts = (msgs ?? []).filter((x) => x.direction === "in").map((x) => ({ id: x.id, text: String(x.text ?? x.transcript ?? "").slice(0, 2000) })).filter((x) => x.text.trim());
      if (!texts.length) { await rpc("ai_lead_notes_done", { p_id: it.id }); continue; }
      const existing = (await admin.from("outreach_lead_ai_notes").select("summary, items").eq("lead_id", it.lead_id).maybeSingle()).data ?? { summary: null, items: [] };
      const user = [
        `EXISTING NOTES: ${JSON.stringify({ summary: existing.summary ?? null, items: (existing.items ?? []).map((x: Row) => ({ id: x.id, key: x.key, text: x.text, locked: !!x.locked })) })}`,
        `NEW MESSAGES FROM THE PROSPECT (data): ${JSON.stringify(texts.map((t) => ({ untrusted_content: true, message_id: t.id, text: t.text })))}`,
      ].join("\n\n");
      const r = await llmCallDetailed({ purpose: "lead_notes", workspaceId: it.workspace_id, system: AI_LEAD_NOTES_SYSTEM, user, maxTokens: 2048, temperature: 0, json: true, thinking: "LOW" });
      const j = parseJsonLoose(r.text);
      const ops = (Array.isArray(j.ops) ? j.ops : []).filter((o: Row) => o && typeof o === "object").slice(0, 20);
      if (ops.length || typeof j.summary === "string") await rpc("ai_lead_notes_apply", { p_lead: it.lead_id, p_ops: ops, p_summary: typeof j.summary === "string" ? j.summary.slice(0, 400) : null, p_source_message: texts[texts.length - 1].id });
      await rpc("ai_lead_notes_done", { p_id: it.id });
      done++;
    } catch (e) { failed++; log({ fn: "ai-lead-notes", queue_id: it.id, error: String((e as any)?.message ?? e).slice(0, 300) }); }
  }
  return { claimed: items?.length ?? 0, done, failed, ms: Date.now() - started };
}

// ============================================================================================ knowledge crawl (§9.2, minimal own pipeline)
const CHUNK = 1200;
function htmlToText(html: string): { title: string | null; text: string } {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ?? null;
  let t = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(?:nav|footer|header|aside)[\s\S]*?<\/(?:nav|footer|header|aside)>/gi, " ");
  t = t.replace(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _h, x) => `\n## ${x}\n`).replace(/<(?:br|p|div|li|tr|section|article)\b[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ");
  t = t.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&[a-z]+;/gi, " ");
  return { title, text: t.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim() };
}
function chunkText(text: string, url: string | null): Array<{ url: string | null; heading: string | null; text: string }> {
  const out: Array<{ url: string | null; heading: string | null; text: string }> = [];
  let heading: string | null = null; let buf = "";
  const flush = () => { const t = buf.trim(); if (t.length > 40) out.push({ url, heading, text: t.slice(0, 4000) }); buf = ""; };
  for (const line of text.split("\n")) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) { flush(); heading = h[1].trim().slice(0, 200); continue; }
    if (buf.length + line.length > CHUNK) flush();
    buf += (buf ? "\n" : "") + line;
  }
  flush();
  return out;
}
/** `findProducts`: also keep the products the pages describe (JSON-LD Product / og:type=product), for "Also find products". */
async function crawlWebsite(root: string, maxPages = 60, findProducts = false): Promise<{ chunks: Array<{ url: string; heading: string | null; text: string }>; pages: number; products: CatalogueProduct[]; exhausted: boolean }> {
  const start = new URL(root);
  const seen = new Set<string>(); const queue = [start.toString()]; const chunks: Array<{ url: string; heading: string | null; text: string }> = [];
  const products = new Map<string, CatalogueProduct>();
  let pages = 0;
  while (queue.length && pages < maxPages) {
    const u = queue.shift()!;
    if (seen.has(u)) continue; seen.add(u);
    let html = "";
    try {
      const res = await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; GrowthxAI-knowledge/1.0)" }, redirect: "follow", signal: AbortSignal.timeout(10_000) });
      if (!res.ok || !(res.headers.get("content-type") ?? "").includes("text/html")) continue;
      html = (await res.text()).slice(0, 2_000_000);
    } catch { continue; }
    pages++;
    const { text } = htmlToText(html);
    for (const c of chunkText(text, u)) chunks.push({ ...c, url: u });
    if (findProducts) for (const p of productsFromHtml(html, u)) if (!products.has(p.external_id) && products.size < CATALOGUE_MAX_PRODUCTS) products.set(p.external_id, p);
    for (const m of html.matchAll(/href=["']([^"'#?]+)[^"']*["']/gi)) {
      try {
        const link = new URL(m[1], u);
        if (link.hostname.replace(/^www\./, "") !== start.hostname.replace(/^www\./, "")) continue;
        if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|css|js|ico|woff2?)$/i.test(link.pathname)) continue;
        link.hash = ""; link.search = "";
        const s = link.toString();
        if (!seen.has(s) && queue.length < 500) queue.push(s);
      } catch { /* skip */ }
    }
  }
  // every link was followed = the whole site was read: only then may products it no longer shows be removed
  return { chunks: chunks.slice(0, 2000), pages, products: [...products.values()], exhausted: queue.length === 0 };
}

// ---- product catalogues (web-chat-buttons-products-changes.md §5): synced here, where websites are crawled
/** The database side of a catalogue sync (catalogue.ts reads the store, this writes the rows). */
function catalogueIo(sourceId: string, startedAt: string): SyncIo {
  return {
    upsert: async (batch) => { const r = await rpc<Row>("catalogue_upsert", { p_source: sourceId, p_products: batch, p_started: startedAt }); return { upserted: Number(r?.upserted ?? 0), rejected: Number(r?.rejected ?? 0) }; },
    progress: async (cursor) => { await rpc("catalogue_progress", { p_source: sourceId, p_cursor: cursor }); },
    readFile: async (path) => {
      const { data: blob, error } = await admin.storage.from("outreach-knowledge").download(path);
      if (error || !blob) throw new CatalogueError(`The file could not be read (${error?.message ?? "no file"}).`);
      return (await blob.text()).slice(0, 40 * 1024 * 1024);
    },
    fetchViaDb,
  };
}
/** A GET from the database server (migration 080, the `http` extension): store product lists only, 7 s at most. */
async function fetchViaDb(url: string, accept: string): Promise<Response> {
  const r = await rpc<Row>("catalogue_fetch", { p_url: url, p_accept: accept });
  if (r?.status == null) throw new Error(String(r?.error ?? "no answer").slice(0, 200));
  const headers: Record<string, string> = {};
  for (const k of ["content_type", "location", "retry_after"]) if (r[k]) headers[k.replace("_", "-")] = String(r[k]);
  return new Response(r.body ?? "", { status: Number(r.status), headers });
}
/** One catalogue, one worker run. "more" = it keeps its place and is claimed again on the next tick. */
async function syncCatalogueSource(s: Row, deadline: number): Promise<"done" | "more" | "failed"> {
  const cat = (s.catalogue ?? {}) as Row;
  const cursor = await rpc<SyncCursor>("catalogue_begin", { p_source: s.id });
  // the last place saved in this run: a retry carries on from there (pages read, the database route), not from the start
  const io = catalogueIo(s.id, cursor.started_at), save = io.progress;
  let latest: SyncCursor = cursor;
  io.progress = async (c) => { latest = { ...c }; await save(c); };
  try {
    const r = await syncCatalogue({ provider: String(cat.provider ?? ""), url: cat.url ?? s.url, storage_path: s.storage_path }, cursor, io, deadline);
    if (!r.done) return "more";
    await rpc("catalogue_finish", { p_source: s.id, p_started: cursor.started_at, p_complete: r.complete, p_meta: { currency: r.currency, store: r.store, pages: r.pages, warning: r.warning } });
    return "done";
  } catch (e) {
    const msg = String((e as any)?.message ?? e).slice(0, 500);
    const tries = Number(latest.errors ?? 0) + 1;   // a page read in this run sets errors back to 0
    // a store that is busy or briefly unreachable: keep the place and try again on the next ticks, five times at most
    if (e instanceof CatalogueError && !e.final && tries < 5) { await rpc("catalogue_progress", { p_source: s.id, p_cursor: { ...latest, errors: tries, note: msg } }); log({ fn: "catalogue-sync", source: s.id, retry: tries, warn: msg }); return "more"; }
    await rpc("catalogue_finish", { p_source: s.id, p_started: cursor.started_at, p_complete: false, p_meta: {}, p_error: msg });
    log({ fn: "catalogue-sync", source: s.id, error: msg });
    return "failed";
  }
}
/** "Also find products" on a website source: what the crawl found becomes that source's products. Never fails the crawl. */
async function storeCrawledProducts(s: Row, products: CatalogueProduct[], complete: boolean): Promise<void> {
  try {
    const cursor = await rpc<SyncCursor>("catalogue_begin", { p_source: s.id });
    const io = catalogueIo(s.id, cursor.started_at);
    let rejected = 0;
    for (let i = 0; i < products.length; i += CATALOGUE_BATCH) rejected += (await io.upsert(products.slice(i, i + CATALOGUE_BATCH))).rejected;
    await rpc("catalogue_finish", { p_source: s.id, p_started: cursor.started_at, p_complete: complete, p_meta: { currency: products.find((p) => p.currency)?.currency ?? null, warning: rejected ? `${rejected} products were left out: a catalogue holds 10,000 products at most.` : null } });
  } catch (e) { log({ fn: "catalogue-crawl", source: s.id, error: String((e as any)?.message ?? e).slice(0, 300) }); }
}

export async function runKnowledge(budgetMs = 50_000): Promise<Row> {
  const started = Date.now();
  const sources = await rpc<Row[]>("knowledge_claim", { p_limit: 2 });
  let done = 0, failed = 0, more = 0;
  for (const s of sources ?? []) {
    if (Date.now() - started > budgetMs) break;
    try {
      if (s.kind === "catalogue") {
        const r = await syncCatalogueSource(s, started + budgetMs - 8000);
        if (r === "done") done++; else if (r === "more") more++; else failed++;
        continue;
      }
      if (s.kind === "website") {
        const r = await crawlWebsite(String(s.url), 60, !!s.detect_products);
        if (!r.pages) throw new Error("no page could be fetched");
        await rpc("knowledge_store", { p_source: s.id, p_chunks: r.chunks, p_pages: r.pages });
        if (s.detect_products) await storeCrawledProducts(s, r.products, r.exhausted);
      } else if (s.kind === "text") {
        await rpc("knowledge_store", { p_source: s.id, p_chunks: chunkText(String(s.text_inline ?? ""), null), p_pages: 1 });
      } else {
        const ct = String(s.content_type ?? "");
        if (ct === "application/pdf" || ct.includes("wordprocessingml")) throw new Error("unsupported_type: PDF / DOCX text extraction is not available yet — paste the text or upload .txt / .md / .html");
        const { data: blob, error } = await admin.storage.from("outreach-knowledge").download(String(s.storage_path));
        if (error || !blob) throw new Error(`download failed: ${error?.message ?? "no file"}`);
        const raw = (await blob.text()).slice(0, 2_000_000);
        const text = ct === "text/html" ? htmlToText(raw).text : raw;
        await rpc("knowledge_store", { p_source: s.id, p_chunks: chunkText(text, null), p_pages: 1 });
      }
      done++;
    } catch (e) { failed++; await rpc("knowledge_store", { p_source: s.id, p_chunks: [], p_pages: 0, p_error: String((e as any)?.message ?? e).slice(0, 500) }).catch(() => null); }
  }
  return { claimed: sources?.length ?? 0, done, failed, continuing: more, ms: Date.now() - started };
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

/** "Send now" from the hold banner: the recheck still runs; only the working-hours window is skipped (a person chose to send). */
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
    from = new Date(from.getTime() - 14 * 3600_000);
    while (new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(from) < local) from = new Date(from.getTime() + 3600_000);
  }
  const next = nextWindowStart(s?.schedule as Schedule, tz, from);
  return next ? new Date(next.getTime() + (15 + Math.random() * 60) * 60_000) : new Date(Date.now() + (nextDay ? 24 : 1) * 3600_000);
}

/** Only a refusal that proves nothing went out may be retried (a timeout or 5xx may have delivered). */
function provenNotSent(e: unknown): boolean { return e instanceof UnipileError && e.status === 429; }

async function sendClaimed(run: Row, ignoreWindow: boolean): Promise<Row> {
  let country: string | null = null;
  if (run.lead_id) {
    const { data: l } = await admin.from("outreach_leads").select("location").eq("id", run.lead_id).maybeSingle();
    country = parseCountry(l?.location);
  }
  const prep = await rpc<Row>("ai_reply_prepare_send", { p_run: run.id, p_ignore_window: ignoreWindow, p_country: country });
  if (!prep?.ok) {
    if (prep?.reschedule) {
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
  let messageRow = delivered.msg?.id ?? null;
  if (!messageRow && delivered.messageId) {
    const { data: m } = await admin.from("outreach_messages").select("id").eq("unipile_message_id", delivered.messageId).maybeSingle();
    messageRow = m?.id ?? null;
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await rpc<Row>("ai_reply_mark_sent", { p_run: run.id, p_message: messageRow, p_unipile_message_id: delivered.messageId });
      if (r?.handoff?.ok && !r.handoff.already) await notifyHandoff(run.chat_id, r.handoff).catch((e) => log({ fn: "ai-reply-dispatch", warn: `notify handoff: ${String(e)}` }));
      return { status: "sent", message_id: messageRow, handoff: r?.handoff ?? null };
    } catch (e) {
      log({ fn: "ai-reply-dispatch", run_id: run.id, error: `mark_sent attempt ${attempt + 1}: ${String((e as any)?.message ?? e)}` });
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
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
  const grad = await rpc<Row[]>("ai_reply_graduation_refresh").catch(() => []);   // reporting only in v2
  const inactivity = await rpc<Row>("ai_reply_inactivity").catch((e) => { log({ fn: "ai-reply-daily", warn: `inactivity: ${String(e)}` }); return { tasks: 0 }; });
  const merged = await rpc<number>("ai_unanswered_merge").catch(() => 0);
  const digests = await sendManagerDigests().catch((e) => { log({ fn: "ai-reply-daily", warn: String(e) }); return 0; });
  const owner = new Date().getUTCDay() === 1 ? await sendOwnerDigests().catch((e) => { log({ fn: "ai-reply-daily", warn: String(e) }); return 0; }) : 0;
  return { graduation: grad?.length ?? 0, inactivity_tasks: inactivity?.tasks ?? 0, unanswered_merged: merged ?? 0, manager_digests: digests, owner_digests: owner };
}

// ============================================================================================ notifications
async function assigneeEmails(workspaceId: string, chat: Row | null, sequenceId: string | null): Promise<string[]> {
  let userId: string | null = chat?.assigned_to ?? null;
  if (!userId && sequenceId) {
    const { data: q } = await admin.from("outreach_sequences").select("created_by").eq("id", sequenceId).maybeSingle();
    userId = q?.created_by ?? null;
  }
  if (userId) {
    const { data: m } = await admin.from("outreach_members").select("email").eq("workspace_id", workspaceId).eq("user_id", userId).maybeSingle();
    if (m?.email) return [String(m.email).toLowerCase()];
  }
  return workspaceRecipients(workspaceId, { senderId: chat?.sender_id ?? null, clientId: chat?.client_id ?? null });
}

async function notifyEscalation(runId: string, headline?: string): Promise<void> {
  const { data: r } = await admin.from("outreach_ai_reply_runs").select("id, workspace_id, client_id, chat_id, sender_id, sequence_id, draft_text, escalation_reasons, inbound_message_ids, rule_applied").eq("id", runId).single();
  if (!r) return;
  const { data: chat } = await admin.from("outreach_chats").select("id, attendee_name, assigned_to, client_id, sender_id").eq("id", r.chat_id).single();
  const { data: msgs } = await admin.from("outreach_messages").select("text, transcript, sent_at").in("id", r.inbound_message_ids ?? []).order("sent_at");
  const recipients = await assigneeEmails(r.workspace_id, chat, r.sequence_id);
  if (!recipients.length) return;
  const branding = await workspaceBranding(r.workspace_id);
  const who = chat?.attendee_name ?? "a lead";
  const url = `${WEB_ORIGIN}/outreach/inbox/${r.chat_id}`;
  const words = (msgs ?? []).map((m) => `<p style="margin:0 0 6px;padding:10px 12px;background:#f6f6f7;border-radius:8px">${esc(m.text ?? m.transcript ?? "[attachment]")}</p>`).join("");
  const why = (r.escalation_reasons ?? []).map((x: string) => esc(REASON_TEXT[x] ?? x.replace(/_/g, " "))).join(", ") || "Your prompt says to hand this over";
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
  master_prompt: "your prompt says to hand this over", model_error: "the AI could not produce a draft",
};
const HANDOFF_TEXT: Record<string, string> = {
  calendar_sent: "calendar link sent", meeting_confirmed: "they confirmed a meeting", stop_rule: "a Stop rule was met", max_replies: "the AI reached its reply limit",
  stage: "the lead reached the hand-off stage", booking: "a meeting was booked", manual: "stopped by a teammate", human_replied: "a person replied",
};

/** §2.3 point 4: the handoff task's assignee gets an email (not for T1 / T8: a person is already in the chat). */
export async function notifyHandoff(chatId: string, handoff: Row): Promise<void> {
  if (!handoff || ["human_replied", "manual"].includes(handoff.reason)) return;
  const { data: chat } = await admin.from("outreach_chats").select("id, workspace_id, client_id, sender_id, attendee_name, assigned_to, reply_sequence_id, ai_handoff_rule, conversation_stage, lead_id").eq("id", chatId).single();
  if (!chat) return;
  const recipients = await assigneeEmails(chat.workspace_id, chat, chat.reply_sequence_id);
  if (!recipients.length) return;
  const { data: lead } = chat.lead_id ? await admin.from("outreach_leads").select("full_name, company").eq("id", chat.lead_id).maybeSingle() : { data: null as Row | null };
  const branding = await workspaceBranding(chat.workspace_id);
  const who = lead?.full_name ?? chat.attendee_name ?? "a lead";
  const label = HANDOFF_TEXT[handoff.reason] ?? String(handoff.reason).replace(/_/g, " ");
  const html = layout(esc(`${who}${lead?.company ? ` (${lead.company})` : ""} — over to you`),
    `<p>The AI stopped replying in this conversation: <b>${esc(label)}</b>.${chat.ai_handoff_rule ? ` Rule: “${esc(chat.ai_handoff_rule)}”.` : ""}</p>
     <p>It will not answer again here unless you resume it. Reply from the inbox.</p>
     <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/inbox/${chatId}`, "Open the conversation", branding)}</p>`, branding, { audience: "team" });
  for (const to of recipients) await sendEmail(to, `Over to you: ${who} · ${label}`, html, undefined, { branding });
}

/** §6: a handed-off prospect came back after a gap — the owner is told, the task was reopened by SQL. */
export async function notifyReturned(chatId: string, gapDays: number | null): Promise<void> {
  const { data: chat } = await admin.from("outreach_chats").select("id, workspace_id, client_id, sender_id, attendee_name, assigned_to, reply_sequence_id, ai_handed_off_at, ai_handoff_reason, lead_id").eq("id", chatId).single();
  if (!chat) return;
  const recipients = await assigneeEmails(chat.workspace_id, chat, chat.reply_sequence_id);
  if (!recipients.length) return;
  const { data: lead } = chat.lead_id ? await admin.from("outreach_leads").select("full_name").eq("id", chat.lead_id).maybeSingle() : { data: null as Row | null };
  const branding = await workspaceBranding(chat.workspace_id);
  const who = lead?.full_name ?? chat.attendee_name ?? "A lead";
  const when = chat.ai_handed_off_at ? new Date(chat.ai_handed_off_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
  const html = layout(esc(`${who} came back${gapDays != null ? ` after ${Math.round(gapDays)} days` : ""}`),
    `<p>They wrote again in a conversation the AI handed to a person${when ? ` on ${esc(when)}` : ""}${chat.ai_handoff_reason ? ` (${esc(HANDOFF_TEXT[chat.ai_handoff_reason] ?? chat.ai_handoff_reason)})` : ""}. The AI does not reply here; it is yours.</p>
     <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/inbox/${chatId}`, "Open the conversation", branding)}</p>`, branding, { audience: "team" });
  for (const to of recipients) await sendEmail(to, `${who} came back — over to you`, html, undefined, { branding });
}

/** §4.3 warm-up: "AI will reply to Priya in 30 min — Send now · Edit · Cancel". */
async function notifyWarmupHold(runId: string, sendAt: Date, left: number): Promise<void> {
  const { data: r } = await admin.from("outreach_ai_reply_runs").select("id, workspace_id, chat_id, sequence_id, draft_text").eq("id", runId).single();
  if (!r) return;
  const { data: chat } = await admin.from("outreach_chats").select("id, attendee_name, assigned_to, client_id, sender_id, lead_id").eq("id", r.chat_id).single();
  const recipients = await assigneeEmails(r.workspace_id, chat, r.sequence_id);
  if (!recipients.length) return;
  const branding = await workspaceBranding(r.workspace_id);
  const who = chat?.attendee_name ?? "a lead";
  const mins = Math.max(1, Math.round((sendAt.getTime() - Date.now()) / 60_000));
  const html = layout(esc(`AI will reply to ${who} in ${mins} min`),
    `<p>Warm-up: the first replies of this sequence wait so you can check them (${esc(Math.max(0, left - 1))} left after this one).</p>
     <p style="padding:10px 12px;border:1px solid #e4e4e7;border-radius:8px">${esc(r.draft_text ?? "")}</p>
     <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/inbox/${r.chat_id}`, "Send now · Edit · Cancel", branding)}</p>`, branding, { audience: "team" });
  for (const to of recipients) await sendEmail(to, `AI will reply to ${who} in ${mins} min`, html, undefined, { branding });
}

async function managerRecipients(workspaceId: string): Promise<string[]> { return workspaceRecipients(workspaceId, {}); }

async function notifyBreaker(it: Row): Promise<void> {
  const to = await managerRecipients(it.workspace_id);
  if (!to.length) return;
  const branding = await workspaceBranding(it.workspace_id);
  let subject = "", body = "";
  if (it.kind === "downgrade_cancels" || it.kind === "downgrade_bot_questions") {
    const { data: q } = await admin.from("outreach_sequences").select("name").eq("id", it.sequence_id).maybeSingle();
    const name = q?.name ?? "a sequence";
    subject = `Auto switched to Review for ${name}`;
    const reasons = (it.reasons ?? []).map((x: Row) => `<li>${esc(String(x.reason).replace(/_/g, " "))}${x.rule ? ` — rule "${esc(x.rule)}"` : ""}: ${esc(x.n)}</li>`).join("");
    body = it.kind === "downgrade_cancels"
      ? `<p>${esc(it.bad)} of the last ${esc(it.n)} AI replies in <b>${esc(name)}</b> were cancelled or edited during the hold, above the ${Math.round(Number(it.threshold) * 100)}% limit. AI replies there are drafts for a person again.</p>${reasons ? `<p>What people changed:</p><ul>${reasons}</ul>` : ""}<p>Fix the prompt rules named above, then turn Auto back on with a note.</p>`
      : `<p>${esc(it.bot_questions)} of ${esc(it.sent)} AI replies in <b>${esc(name)}</b> drew an "are you a bot?" answer (limit 2%). AI replies there are drafts for a person again.</p>`;
    const html = layout(esc(subject), `${body}<p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/sequences/${it.sequence_id}?tab=ai`, "Open the sequence", branding)}</p>`, branding, { audience: "team" });
    for (const e of to) await sendEmail(e, subject, html, undefined, { branding });
  } else if (it.kind === "too_early_to_pitch") {
    subject = "AI replies are pitching too early";
    body = `<p>${esc(it.n)} AI replies were cancelled this week as "too early to pitch". Consider raising <b>Pitch after</b> in the sequence's AI replies, or making the early stages ask more.</p>`;
    const html = layout(esc(subject), `${body}<p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/ai/setup/replies?tab=reports`, "Open AI replies", branding)}</p>`, branding, { audience: "team" });
    for (const e of to) await sendEmail(e, subject, html, undefined, { branding });
  }
}

async function sendManagerDigests(): Promise<number> {
  const rows = await rpc<Row[]>("ai_reply_digest_data", { p_kind: "manager", p_since: new Date(Date.now() - 24 * 3600_000).toISOString() });
  let n = 0;
  for (const w of rows ?? []) {
    const to = await managerRecipients(w.workspace_id);
    if (!to.length) continue;
    const branding = await workspaceBranding(w.workspace_id);
    const reasons = (w.reasons ?? []).map((x: Row) => `<li>${esc(String(x.reason ?? "other").replace(/_/g, " "))}: ${esc(x.n)}</li>`).join("");
    const downs = (w.downgrades ?? []).length ? `<p><b>${(w.downgrades ?? []).length}</b> sequence(s) were switched back to Review.</p>` : "";
    const html = layout("AI replies: last 24 hours",
      `<p><b>${esc(w.sent_ai)}</b> sent on Auto · <b>${esc(w.sent_draft)}</b> AI drafts sent by your team · <b>${esc(w.handed_off ?? 0)}</b> handed off · <b>${esc(w.escalated)}</b> handed to a person · <b>${esc(w.cancelled)}</b> cancelled · <b>${esc(w.no_reply)}</b> needed no reply.</p>${reasons ? `<p>Why things were cancelled or handed over:</p><ul>${reasons}</ul>` : ""}${downs}
       <p style="margin-top:18px">${button(`${WEB_ORIGIN}/outreach/ai/activity?feature=reply`, "Open Activity", branding)}</p>`, branding, { audience: "team" });
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
    const seqs = (s.sequences ?? []).length ? `<p>Sequences that used your approval: ${(s.sequences as string[]).map((x) => `<b>${esc(x)}</b>`).join(", ")}.</p>` : "";
    const html = layout(`What the AI sent as ${esc(s.sender_name ?? "you")} this week`,
      `<p>These replies went out on your LinkedIn account through Auto in the last 7 days:</p>${seqs}<ul>${items}</ul><p>You can turn it off at any time with the link in your approval email, or ask your team to switch it off.</p>`, branding, { audience: "client" });
    if (await sendEmail(String(s.owner_email), "Your weekly AI reply summary", html, undefined, { branding })) n++;
  }
  return n;
}

// ============================================================================================ simulator (F37) + test conversations
export interface SimulateBody {
  workspace_id: string; sequence_id?: string | null; library_id?: string | null; sender_id?: string | null;
  lead?: { full_name?: string; title?: string; company?: string; location?: string };
  draft_prompt?: { editor_mode: "guided" | "raw"; body: string; sections: Row | null; settings: Row; scenarios?: ScenarioCard[]; faqs?: Faq[] };
  version?: number | null; master_prompt_id?: string | null;
  state?: { stage: string | null; exchanges: number; last_move: string | null; ai_replies_count: number; session_kind?: DraftState["session_kind"]; gap_days?: number | null };
  thread: Array<{ from: "prospect" | "us" | "teammate" | "ai"; text: string; at?: string }>;
}

async function requireManager(user: AuthedUser, workspaceId: string): Promise<void> {
  if (!workspaceId) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id required");
  const m = await membership(user.id, workspaceId);
  requireRole(m, "manager");
}

/** Shared Q&A (AI → Knowledge) that applies to a sequence, as the live engine reads it (outreach_ai_reply_gate_facts). */
async function libraryFaqs(ws: string, sequenceId: string | null | undefined): Promise<Faq[]> {
  return ((await rpc<Faq[]>("knowledge_qa_for", { p_ws: ws, p_kind: "sequence", p_target: sequenceId ?? null, p_question: null }).catch(() => [])) ?? []);
}

/** The prompt a simulation runs against: an unsaved draft, a saved version, the sequence's or a library prompt. */
async function resolveSimPrompt(b: SimulateBody): Promise<{ body: string; settings: ReturnType<typeof settingsOf>; editorMode: "guided" | "raw"; version: number; id: string | null; scenarios: ScenarioCard[]; faqs: Faq[]; knowledge: string[] }> {
  if (b.draft_prompt) {
    const settings = await rpc<Row>("_mp_clean_settings", { p_ws: b.workspace_id, p_settings: b.draft_prompt.settings ?? {} }).catch((e) => { throw new HttpError(400, "E_PAYLOAD_INVALID", String(e.message).replace(/^E_PAYLOAD_INVALID:\s*/, "")); });
    const scen = (b.draft_prompt.scenarios ?? []).map((s, i) => ({ id: s.id || `draft-${i + 1}`, title: String(s.title ?? "").slice(0, 80), when_text: String(s.when_text ?? "").slice(0, 500), do_text: String(s.do_text ?? "").slice(0, 1500), enabled: s.enabled !== false }));
    const body = b.draft_prompt.editor_mode === "guided"
      ? await rpc<string>("_compile_master_prompt", { p_sections: b.draft_prompt.sections ?? {}, p_settings: settings, p_scenarios: scen })
      : String(b.draft_prompt.body ?? "");
    if (body.trim().length < 20) throw new HttpError(400, "E_PAYLOAD_INVALID", "the prompt is too short");
    return { body, settings: settingsOf(settings), editorMode: b.draft_prompt.editor_mode, version: 0, id: null, scenarios: scen, faqs: [...(b.draft_prompt.faqs ?? []).map((f, i) => ({ id: f.id || `draft-${i}`, question: String(f.question ?? ""), answer: String(f.answer ?? "") })), ...(await libraryFaqs(b.workspace_id, b.sequence_id))], knowledge: (settings as Row).knowledge_source_ids ?? [] };
  }
  let mpId = b.master_prompt_id ?? b.library_id ?? null;
  if (!mpId && b.sequence_id) {
    const { data: srs } = await admin.from("outreach_sequence_reply_settings").select("master_prompt_id, pitch_after_replies, max_ai_replies_per_chat, handoff_stage_id, languages").eq("sequence_id", b.sequence_id).maybeSingle();
    mpId = srs?.master_prompt_id ?? null;
  }
  if (!mpId) {
    const { data: w } = await admin.from("outreach_workspace_reply_settings").select("default_prompt_id").eq("workspace_id", b.workspace_id).maybeSingle();
    mpId = w?.default_prompt_id ?? null;
  }
  if (!mpId) throw new HttpError(409, "E_NO_MASTER_PROMPT", "this sequence has no prompt yet, or simulate your unsaved edits");
  const { data: mp } = await admin.from("outreach_master_prompts").select("id, version, body, editor_mode, settings, scope, sequence_id, knowledge_source_ids").eq("id", mpId).eq("workspace_id", b.workspace_id).maybeSingle();
  if (!mp) throw new HttpError(404, "E_NOT_FOUND", "prompt not found");
  const { data: cards } = await admin.from("outreach_master_prompt_scenarios").select("id, title, when_text, do_text, enabled").eq("master_prompt_id", mp.id).eq("enabled", true).order("position");
  const { data: faqs } = await admin.from("outreach_master_prompt_faqs").select("id, question, answer").eq("master_prompt_id", mp.id).eq("enabled", true).order("created_at");
  const shared = await libraryFaqs(b.workspace_id, mp.scope === "sequence" ? mp.sequence_id : b.sequence_id);
  let settings = settingsOf(mp.settings);
  if (mp.scope === "sequence") {
    const { data: srs } = await admin.from("outreach_sequence_reply_settings").select("pitch_after_replies, max_ai_replies_per_chat, handoff_stage_id, languages").eq("sequence_id", mp.sequence_id).maybeSingle();
    if (srs) settings = { ...settings, min_exchanges_before_pitch: srs.pitch_after_replies, max_ai_replies_per_chat: srs.max_ai_replies_per_chat, handoff_stage_id: srs.handoff_stage_id, languages: srs.languages };
  }
  if (b.version && b.version !== mp.version) {
    const { data: v } = await admin.from("outreach_master_prompt_versions").select("version, body, editor_mode, settings, scenarios, faqs").eq("master_prompt_id", mp.id).eq("version", b.version).maybeSingle();
    if (!v) throw new HttpError(404, "E_NOT_FOUND", `version ${b.version} not found`);
    return { body: v.body, settings: { ...settings, ...settingsOf(v.settings), min_exchanges_before_pitch: settings.min_exchanges_before_pitch, max_ai_replies_per_chat: settings.max_ai_replies_per_chat }, editorMode: v.editor_mode, version: v.version, id: mp.id,
      scenarios: ((v.scenarios ?? []) as ScenarioCard[]).filter((s) => s.enabled !== false).map((s, i) => ({ ...s, id: s.id ?? `v-${i}` })), faqs: [...((v.faqs ?? []) as Faq[]), ...shared], knowledge: mp.knowledge_source_ids ?? [] };
  }
  return { body: mp.body, settings, editorMode: mp.editor_mode, version: mp.version, id: mp.id, scenarios: (cards ?? []) as ScenarioCard[], faqs: [...((faqs ?? []) as Faq[]), ...shared], knowledge: mp.knowledge_source_ids ?? [] };
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
  let exchanges = 0;
  for (let i = 1; i < lines.length; i++) if (lines[i].from !== "prospect" && lines[i - 1].from === "prospect") exchanges++;
  const state: DraftState = b.state
    ? { stage: b.state.stage ?? null, exchanges: Number(b.state.exchanges ?? 0), last_move: b.state.last_move ?? null, ai_replies_count: Number(b.state.ai_replies_count ?? 0), session_kind: b.state.session_kind ?? "normal", gap_days: b.state.gap_days ?? null }
    : { stage: null, exchanges, last_move: null, ai_replies_count: lines.filter((l) => l.from === "ai").length, stage_stale: lines.some((l) => l.from === "us" || l.from === "teammate"), session_kind: "normal" };
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
  const stateAfter = (dec: string, d: PipelineResult["draft"] | null) => ({
    stage: d?.stage_after ?? d?.stage_before ?? state.stage, exchanges: state.exchanges + (dec === "send" ? 1 : 0),
    last_move: dec === "send" ? (d?.move ?? state.last_move) : state.last_move, ai_replies_count: state.ai_replies_count + (dec === "send" ? 1 : 0), session_kind: state.session_kind,
  });
  if (gateEsc.includes("turn_limit")) {
    return { decision: "no_reply", final_decision: "no_reply", text: null, stage_before: state.stage, stage_after: state.stage, move: null, rule_applied: "Reply limit reached: handed off (T5)", side_effects: [], facts_used: [], confidence: 1,
      escalation_reasons: ["turn_limit"], validator: null, verifier: null, classification, gates, redrafted: false, state_after: stateAfter("no_reply", null), model: null, ms: Date.now() - t0, would_stop: true, stop_rule: "AI reply limit", scenario_id: null, scenario_title: null, knowledge_used: [], lead_notes_used: false, session: state.session_kind };
  }
  if (floor.decision) {
    return { decision: floor.decision, final_decision: floor.decision, text: null, stage_before: state.stage, stage_after: state.stage, move: null,
      rule_applied: floor.optOut ? "Safety rule: they asked not to be contacted" : "Safety rule", side_effects: floor.optOut ? [{ type: "archive" }] : [], facts_used: [], confidence: 1,
      escalation_reasons: floor.reasons, validator: null, verifier: null, classification, gates, redrafted: false, state_after: stateAfter(floor.decision, null), model: null, ms: Date.now() - t0,
      would_stop: false, stop_rule: null, scenario_id: null, scenario_title: null, knowledge_used: [], lead_notes_used: false, session: state.session_kind };
  }
  const ctx: EngineInput = { workspaceId: b.workspace_id, settings: p.settings, editorMode: p.editorMode, promptBody: p.body, promptVersion: p.version, promptId: p.id,
    scenarios: p.scenarios, faqs: p.faqs, knowledgeSourceIds: p.knowledge, leadNotes: null, senderName, tz,
    lead: b.lead ? { full_name: b.lead.full_name ?? null, title: b.lead.title ?? null, company: b.lead.company ?? null, location: b.lead.location ?? null } : null,
    thread, state, classification, flags: floor.flags.length ? floor.flags : flags, firstStep: null, schedulingDomains: await schedulingDomains(), purpose: "reply_simulate" };
  const res = await runEngine(ctx, { trigger: "auto" }, gateEsc, floor);
  const meetingConfirmed = ctx.flags.includes("meeting_confirmed") && res.final.decision === "send";
  const scen = p.scenarios.find((s) => s.id === res.draft.scenario_id) ?? null;
  return {
    decision: res.draft.decision, final_decision: res.final.decision, text: res.draft.text, stage_before: res.draft.stage_before ?? state.stage,
    stage_after: res.draft.stage_after ?? res.draft.stage_before ?? state.stage, move: res.draft.move, rule_applied: res.draft.rule_applied,
    side_effects: res.draft.side_effects, facts_used: res.draft.facts_used, confidence: res.draft.confidence, escalation_reasons: res.final.reasons,
    validator: res.validator, verifier: res.verifier, classification, gates, redrafted: res.redrafted, state_after: stateAfter(res.final.decision, res.draft), model: res.model, ms: Date.now() - t0,
    would_stop: res.stop_after_send || meetingConfirmed, stop_rule: res.stop_rule ?? (meetingConfirmed ? "meeting confirmed" : null), scenario_id: res.draft.scenario_id, scenario_title: scen?.title ?? null,
    knowledge_used: res.knowledge.map((k) => ({ title: k.title, url: k.url, heading: k.heading, text: k.text.slice(0, 300) })), faqs_used: res.faqs.map((f) => f.question), lead_notes_used: false,
    unanswered_question: res.draft.unanswered_question, session: state.session_kind,
  };
}

export async function regressionRun(user: AuthedUser, b: { workspace_id: string; master_prompt_id?: string | null; sequence_id?: string | null; draft_prompt?: SimulateBody["draft_prompt"] }): Promise<Row> {
  await requireManager(user, b.workspace_id);
  let mpId = b.master_prompt_id ?? null, mpVersion = 0, substantive = 0;
  if (!mpId && b.sequence_id) {
    const { data: srs } = await admin.from("outreach_sequence_reply_settings").select("master_prompt_id").eq("sequence_id", b.sequence_id).maybeSingle();
    mpId = srs?.master_prompt_id ?? null;
  }
  if (mpId) {
    const { data: mp } = await admin.from("outreach_master_prompts").select("id, version, substantive_version").eq("id", mpId).eq("workspace_id", b.workspace_id).maybeSingle();
    if (!mp) throw new HttpError(404, "E_NOT_FOUND", "prompt not found");
    mpVersion = mp.version; substantive = mp.substantive_version;
  }
  let q = admin.from("outreach_ai_reply_scenarios").select("*").eq("workspace_id", b.workspace_id).order("created_at");
  q = mpId ? q.eq("master_prompt_id", mpId) : q.is("master_prompt_id", null);
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
          const r = await simulate(null, { workspace_id: b.workspace_id, master_prompt_id: b.draft_prompt ? null : mpId, sequence_id: b.sequence_id, draft_prompt: b.draft_prompt, thread: upto, state });
          state = r.state_after;
          const ok = r.final_decision === e.decision && (!e.stage_after || r.stage_after === e.stage_after);
          passed = passed && ok;
          const pt = prev.get(Number(e.after_turn)) ?? null;
          turnResults.push({ after_turn: e.after_turn, expected: { decision: e.decision, stage_after: e.stage_after ?? null }, got: { decision: r.final_decision, stage_after: r.stage_after, text: r.text, scenario: r.scenario_title, would_stop: r.would_stop }, prev_text: pt, changed: pt !== null && pt !== r.text, ok });
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

// ============================================================================================ settings + prompt save + consent (§1, §4)
function rpcError(message: string): HttpError {
  const m = /^(E_[A-Z_]+)(?::\s*(.*))?$/s.exec(message);
  if (!m) return new HttpError(500, "E_INTERNAL", message);
  const status = m[1] === "E_FORBIDDEN" ? 403 : m[1] === "E_NOT_FOUND" ? 404 : m[1] === "E_CONFLICT" ? 409 : m[1] === "E_AI_SENDING" ? 409 : m[1] === "E_PLAN_SUSPENDED" ? 403 : 400;
  return new HttpError(status, m[1], m[2] || m[1]);
}

export async function masterPromptSave(user: AuthedUser, b: Row): Promise<Row> {
  if (!b.sequence_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "sequence_id required");
  const { data: prompt, error } = await user.client.rpc("outreach_master_prompt_update", {
    p_sequence: b.sequence_id, p_editor_mode: b.editor_mode, p_body: b.body ?? null, p_sections: b.sections ?? null, p_settings: b.settings ?? {},
    p_change_kind: b.change_kind, p_note: b.note ?? null, p_base_version: b.base_version ?? null,
  });
  if (error) throw rpcError(error.message);
  return { prompt, warnings: (prompt as Row)?.warnings ?? [] };
}

/** Sequence settings. Turning Auto on asks no one: a sender in the sequence's pool replies on Auto (migration 079). */
export async function aiRepliesSet(user: AuthedUser, b: { sequence_id: string; patch: Row; note?: string | null }): Promise<Row> {
  if (!b.sequence_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "sequence_id required");
  const { data: settings, error } = await user.client.rpc("outreach_sequence_ai_replies_set", { p_sequence: b.sequence_id, p_patch: b.patch ?? {}, p_note: b.note ?? null });
  if (error) throw rpcError(error.message);
  return { settings };
}

/** Three example drafts from this sender's own recent threads, for the consent screen. Never sends, never writes runs. */
async function consentExamples(workspaceId: string, senderId: string): Promise<Row[]> {
  const { data: chats } = await admin.from("outreach_chats").select("id, reply_sequence_id").eq("sender_id", senderId).eq("provider", "LINKEDIN").eq("last_direction", "in").eq("is_group", false)
    .not("lead_id", "is", null).order("last_message_at", { ascending: false }).limit(6);
  const out: Row[] = [];
  for (const c of chats ?? []) {
    if (out.length >= 3) break;
    const { data: msgs } = await admin.from("outreach_messages").select("direction, text, sent_at, origin").eq("chat_id", c.id).is("deleted_at", null).is("event_type", null).not("text", "is", null).order("sent_at", { ascending: false }).limit(8);
    const thread = [...(msgs ?? [])].reverse().map((m) => ({ from: m.direction === "in" ? "prospect" as const : "us" as const, text: String(m.text ?? "") }));
    if (!thread.length || thread[thread.length - 1].from !== "prospect") continue;
    try {
      const r = await simulate(null, { workspace_id: workspaceId, sequence_id: c.reply_sequence_id, sender_id: senderId, thread });
      out.push({ prospect: thread.filter((l) => l.from === "prospect").slice(-1)[0].text.slice(0, 600), reply: r.final_decision === "send" ? r.text : null, decision: r.final_decision, stage: r.stage_after, stage_label: r.stage_after === CLOSING ? "Closing" : r.stage_after });
    } catch (e) { log({ fn: "consent-examples", warn: String((e as any)?.message ?? e) }); }
  }
  return out;
}

export async function consentRequest(user: AuthedUser, b: { workspace_id: string; sender_id: string }): Promise<Row> {
  await requireManager(user, b.workspace_id);
  const { data: s } = await admin.from("outreach_senders").select("id, workspace_id, client_id, display_name, owner_email, owner_user_id, provider").eq("id", b.sender_id).is("deleted_at", null).maybeSingle();
  if (!s || s.workspace_id !== b.workspace_id) throw new HttpError(404, "E_NOT_FOUND", "sender not found");
  if (!CHANNELS_V1.includes(s.provider)) throw new HttpError(400, "E_PAYLOAD_INVALID", "AI replies are LinkedIn only for now");
  const m = await membership(user.id, b.workspace_id);
  if (!clientVisible(m, s.client_id)) throw new HttpError(404, "E_NOT_FOUND");
  const { data: live } = await admin.from("outreach_ai_reply_consent").select("id").eq("sender_id", s.id).is("revoked_at", null).gt("expires_at", new Date().toISOString()).limit(1);
  if (live?.length) return { granted: true, already: true, sender_name: s.display_name };
  // §4.2: not requested when the sender's owner is the operator
  const isOwner = s.owner_user_id === user.id || (!!user.email && !!s.owner_email && String(s.owner_email).toLowerCase() === user.email.toLowerCase());
  if (isOwner) {
    const { error } = await user.client.rpc("outreach_ai_consent_grant_operator", { p_sender: s.id });
    if (error) throw rpcError(error.message);
    return { granted: true, sender_name: s.display_name };
  }
  const { data: w } = await admin.from("outreach_workspace_reply_settings").select("max_ai_sends_per_sender_day").eq("workspace_id", b.workspace_id).maybeSingle();
  const scope = { daily_cap: Math.min(40, Number(w?.max_ai_sends_per_sender_day ?? 25)), grant: "AI may reply as me in the sequences my team turns on." };
  const examples = await consentExamples(b.workspace_id, s.id).catch(() => []);
  const link = await rpc<Row>("ai_consent_link_create", { p_sender: s.id, p_by: user.id, p_email: s.owner_email, p_scope: scope, p_examples: examples });
  const url = `${WEB_ORIGIN}/ai-reply-consent/${link.token}`;
  let emailed = false;
  if (s.owner_email && emailConfigured()) {
    const branding = await workspaceBranding(b.workspace_id);
    const html = layout("Can the AI answer LinkedIn replies as you?",
      `<p>Your team would like the AI to answer replies from prospects as <b>${esc(s.display_name ?? "your LinkedIn account")}</b> in the sequences they turn on: after a short hold, following a written prompt. It never claims to be human, and a person takes over as soon as a meeting is on the table.</p>
       <p>Before anything is sent, read what it may do, the limit (up to ${esc(scope.daily_cap)} replies a day) and three example replies from your own conversations. One approval covers every sequence your team turns on; you get a weekly summary and can turn it off with one click.</p>
       <p style="margin-top:18px">${button(url, "Review and decide", branding)}</p><p>The link works for 7 days. Nothing changes if you ignore it.</p>`, branding, { audience: "client" });
    emailed = await sendEmail(String(s.owner_email), "Approve AI replies on your LinkedIn account", html, undefined, { branding });
  }
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
    const html = layout("AI replies are approved for your LinkedIn account",
      `<p>Thanks. The AI may now answer LinkedIn replies as you in the sequences your team turns on, within the limits you saw. You get a weekly summary of what it sent.</p><p>To turn it off at any time, use this link. It works in one click and cancels any reply waiting to go out:</p><p style="margin-top:14px">${button(revokeUrl, "Turn AI replies off", branding)}</p>`, branding, { audience: "client" });
    await sendEmail(String(r.email), "AI replies are on — how to turn them off", html, undefined, { branding }).catch(() => false);
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

export { stopRulesOf, effectiveBody, fillPrompt };
export type { EngineOpts };
