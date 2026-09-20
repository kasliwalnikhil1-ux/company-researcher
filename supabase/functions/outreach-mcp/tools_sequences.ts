// outreach-mcp/tools_sequences.ts — sequences (PRD §5.3; product plan items 5–7, 9, 11, 16, 19).
// Reads for all members; writes manager+.
//
// Editing rule: a sequence that was never activated (status draft) is saved directly. Anything
// else goes through PUBLISH: outreach_publish_impact says who a change touches, the human sees
// it, outreach_publish_sequence applies it (optionally pinning in-flight leads to the version
// they are on). Queued text is never re-rendered in TypeScript: outreach_refresh_queued_text
// drops the pre-rendered copy so the step renders again at send time, with the one renderer.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, callFn, roleAtLeast, short, todayIn, wsTz, untrusted } from "./ctx.ts";
import { compileSteps, renderGraph, TEMPLATES, templateByKey, parseWait, type Graph, type GraphNode } from "./steps.ts";

type Row = Record<string, any>;
const SEQ_COLS = "id, workspace_id, client_id, name, status, head_version, sender_pool, assignment, use_sender_schedule, settings, throttled_reason, stalled_at, stalled_reason, draft_updated_at, draft_base_version, brief, created_at, updated_at";
const ASSIGNMENT = z.enum(["round_robin", "least_loaded", "fixed", "fresh_sender", "same_sender"]).describe("round_robin (default) | least_loaded | fixed | fresh_sender (only a sender that never invited or messaged this lead; leads with none left are skipped with reason no_fresh_sender) | same_sender (whoever last spoke to the lead, to keep the conversation in one place)");
const SETTINGS = z.object({
  stop_on_reply: z.boolean().optional().describe("Default true"),
  stop_on_reply_scope: z.enum(["lead", "sender"]).optional().describe("lead (default): a reply to ANY sender or channel stops this lead everywhere. sender: only the sender they replied to"),
  on_reply: z.enum(["exit", "hold"]).optional().describe("exit (default): leave cleanly, tag the intent, create the follow-up task. hold: pause the lead for a human decision (enrollment_hold_list)"),
  resume_after_ooo: z.boolean().optional().describe("Default true: an out-of-office reply re-opens the lead after the return date"),
  ooo_resume_days: z.number().int().min(1).max(60).optional().describe("Default 7, when the auto-reply names no date"),
  hold_max_days: z.number().int().min(1).max(90).optional().describe("Default 30"),
  wait_for_enrichment: z.boolean().optional().describe("Leads start only once their profile is enriched (or after 72 h)"),
  hold_for_ai_review: z.boolean().optional().describe("Leads start only once their {{ai.*}} lines are approved by a person"),
  withdraw_after_days: z.number().int().min(1).max(60).optional(),
}).passthrough();

export async function loadSequence(ctx: Ctx, id: string, cols = "*"): Promise<Row> {
  const { data, error } = await ctx.user.from("outreach_sequences").select(cols).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new McpError("E_NOT_FOUND", `sequence ${id} not found or not visible`);
  return data as Row;
}

const graphInput = {
  steps: z.array(z.record(z.string(), z.unknown())).optional().describe('Compact step list, e.g. [{"do":"visit_profile"},{"do":"invite","note":"Hi {{first_name|there}}…"},{"do":"wait_connection","window_days":14,"connected":[{"do":"message","wait":"1d","text":"…"}],"no_connect":[{"do":"withdraw"},{"do":"end"}]}]. Verbs: visit_profile, refresh_profile, like_post, comment_post, endorse, follow, invite, wait_connection, withdraw, message, inmail, email, delay, condition, tag, untag, list, stage, webhook, api, send_to_sequence, manual_task, ai_draft, end. `wait` like "2h"/"3d" delays that step. A/B test: add variants [{id,label,text,subject?,weight}] (2–5) to invite / message / inmail / email. Text: {{first_name|fallback}}, {{company}}, {{sender.first_name}}, {{sender.booking_link}}, {{custom.key}}, {{enrich.about|…}}, {{enrich.recent_post}}, {{ai.<key>|fallback}} (only a person-approved line is used, else the fallback), {{unsubscribe_link}}, spintax {Hi|Hello|Hey}, {{#if company}}at {{company}}{{/if}}.'),
  graph: z.record(z.string(), z.unknown()).optional().describe("Canonical graph JSON (advanced; prefer steps). Needed for ab_split, ai_route, call_task, find_email and voice-note steps."),
  from_template: z.string().optional().describe("Template key from sequence_templates"),
};

const publishInput = {
  mode: z.enum(["all", "new_only"]).optional().describe("all (default): every lead that has not reached a changed step yet follows the new version. new_only: leads already in flight are pinned to the version they are on; only leads enrolled from now on get the new one."),
  update_queued: z.boolean().optional().describe("Mode all: messages already queued with the old text are re-rendered from the new text at send time (default false = they go out as queued). Hand-edited and approved texts are never touched."),
  reschedule_delays: z.boolean().optional().describe("Mode all: leads waiting in a delay you changed get their wait recomputed from when they entered it (default false)"),
  removed_mode: z.enum(["skip", "exit"]).optional().describe("Leads sitting on a step you removed: skip (default) moves them to the next step of the old version, exit ends them"),
  note: z.string().max(200).optional().describe("Version note shown in sequence_versions"),
  force: z.boolean().optional().describe("Publish although someone else published since this draft started (E_DRAFT_STALE). Only after the human reviewed the fresh impact."),
  allow_warnings: z.boolean().optional(),
  confirmation_token: z.string().optional(),
};

function graphFrom(a: { steps?: unknown; graph?: unknown; from_template?: string }): { graph: Graph | null; errors: Row[]; source: string } {
  if (a.graph) return { graph: a.graph as Graph, errors: [], source: "graph" };
  if (a.steps) { const c = compileSteps(a.steps); return { graph: c.graph, errors: c.errors, source: "steps" }; }
  if (a.from_template) { const t = templateByKey(a.from_template); const c = compileSteps(t.steps); return { graph: c.graph, errors: c.errors, source: `template:${t.key}` }; }
  return { graph: null, errors: [], source: "none" };
}

async function validate(ctx: Ctx, graph: Graph, pool: string[], strict: boolean): Promise<{ errors: Row[]; warnings: Row[] }> {
  const v = await urpc<{ errors: Row[]; warnings: Row[] }>(ctx, "validate_graph", { p_graph: graph, p_pool: pool, p_strict: strict });
  return { errors: v?.errors ?? [], warnings: v?.warnings ?? [] };
}

async function poolInfo(ctx: Ctx, pool: string[]): Promise<Row[]> {
  if (!pool?.length) return [];
  const { data } = await ctx.user.from("outreach_senders").select("id, display_name, provider, status, health_score, warmup_level, is_premium").in("id", pool);
  return (data ?? []).map((s: Row) => ({ id: s.id, name: s.display_name, provider: s.provider, status: s.status, health: s.health_score, level: s.warmup_level, premium: s.is_premium || undefined }));
}

function nodeTextField(n: GraphNode): "text" | "note" | "html" | null {
  switch (n.type) { case "send_invite": return "note"; case "send_message": case "send_inmail": case "comment_latest_post": case "send_voice_note": return "text"; case "send_email": return "html"; default: return null; }
}

/** outreach_node_stats has one row per (node, variant): add the rows of a node together for the step view. */
function statsByNode(rows: Row[]): Record<string, Row> {
  const o: Record<string, Row> = {};
  for (const r of rows) {
    const t = (o[r.node_id] ??= { node_id: r.node_id });
    for (const k of ["sent", "queued", "failed", "skipped", "accepted", "replied", "interested"]) if (typeof r[k] === "number") t[k] = (t[k] ?? 0) + r[k];
  }
  return o;
}

/** The validator's own measure of spintax ({a|b|c}): combinations and the longest result, per text that uses it. */
async function spintaxReport(ctx: Ctx, graph: Graph): Promise<Row[]> {
  const out: Row[] = [];
  const SPIN = /\{[^{}|]*\|[^{}]*\}/;
  for (const [id, n] of Object.entries(graph.nodes ?? {})) {
    const f = nodeTextField(n);
    if (!f) continue;
    const texts: Array<{ variant?: string; text: string }> = [];
    if (typeof n.config?.[f] === "string") texts.push({ text: n.config[f] as string });
    for (const v of (Array.isArray(n.config?.variants) ? n.config!.variants : []) as Row[]) texts.push({ variant: String(v.label ?? v.id), text: String(v[f] ?? v.text ?? "") });
    for (const t of texts) {
      if (!SPIN.test(t.text.replace(/\{\{[\s\S]*?\}\}/g, ""))) continue;
      const r = await urpc<Row[]>(ctx, "spintax_info", { p_text: t.text }).catch(() => null);
      const x = Array.isArray(r) ? r[0] : r;
      if (x) out.push({ node_id: id, variant: t.variant, combinations: x.combinations, longest_chars: x.max_len });
    }
  }
  return out;
}

function impactLine(i: Row): string {
  const nodes: Row[] = i.nodes ?? [];
  const parts = nodes.slice(0, 12).map((n) => `${n.node_id} ${n.change}${n.text_changed ? " (text)" : ""}${n.delay_changed ? " (timing)" : ""}${n.leads_here ? `, ${n.leads_here} lead(s) here` : ""}${n.queued ? `, ${n.queued} queued` : ""}`);
  return parts.join("; ") + (nodes.length > 12 ? `; +${nodes.length - 12} more` : "");
}

/**
 * Publish flow for a sequence that has been live: impact → (human) → publish.
 * `graph` null = publish the stored draft. Returns a tool result.
 */
async function publishFlow(ctx: Ctx, toolName: string, s: Row, graph: Graph | null, a: Row, extra?: { pool?: string[] | null; settings?: Row | null; name?: string | null; brief?: string | null; assignment?: string | null; updateQueuedDefault?: boolean; rescheduleDefault?: boolean; what?: string }): Promise<unknown> {
  const impact = await urpc<Row>(ctx, "publish_impact", { p_id: s.id, p_graph: graph });
  const v = impact.validation ?? {};
  if ((v.errors ?? []).length) return { published: false, errors: v.errors, warnings: v.warnings, next: "Fix the listed steps (sequence_validate shows them again) and retry." };
  if ((v.warnings ?? []).length && !a.allow_warnings) return { published: false, warnings: v.warnings, impact: { ...impact, validation: undefined }, next: "Review the warnings with the human; call again with allow_warnings:true to publish anyway, or fix the steps." };
  if (!impact.changes && !extra?.settings && !extra?.name && !extra?.brief && !extra?.assignment) return { published: false, changes: 0, note: "Nothing differs from the live version, so there is nothing to publish." };
  if (impact.stale && !a.force) throw new McpError("E_DRAFT_STALE", `version ${impact.head_version} was published while this draft was open (the draft started from version ${impact.draft_base_version})`, undefined, { impact: { ...impact, validation: undefined } });

  const mode = a.mode ?? "all", updateQueued = a.update_queued ?? extra?.updateQueuedDefault ?? false, resched = a.reschedule_delays ?? extra?.rescheduleDefault ?? false, removedMode = a.removed_mode ?? "skip";
  const removedLeads = (impact.nodes ?? []).filter((n: Row) => n.change === "removed").reduce((acc: string[], n: Row) => (n.leads_here ? [...acc, `${n.node_id}: ${n.leads_here}`] : acc), [] as string[]);
  const summary = [
    `Publish ${extra?.what ?? "a new version"} of "${s.name}" (${s.status}, live version ${impact.head_version}): ${impact.changes} changed step(s). ${impactLine(impact)}.`,
    `${impact.in_flight} lead(s) in flight: ${impact.on_or_after_changed} on or after a changed step (${impact.on_changed_step} on it, ${impact.past_changed_step} past it), ${impact.before_changed_step} before it, ${impact.already_pinned} already pinned to an older version.`,
    `${impact.queued_with_old_text} message(s) with the old text are already queued; ${impact.waiting_on_changed_delay} lead(s) wait in a delay that changed.`,
    mode === "new_only"
      ? `Mode new_only: all ${impact.in_flight - impact.already_pinned} unpinned lead(s) in flight are pinned to version ${impact.head_version} and finish on it; only leads enrolled from now on get the new version. Queued messages stay as they are.`
      : `Mode all: leads that have not reached a changed step follow the new version from their next step; messages already sent never change. Queued old-text messages: ${updateQueued ? "re-rendered from the new text at send time (hand-edited and approved texts are kept)" : "left as they are"}. Leads in a changed delay: ${resched ? "wait recomputed from when they entered it (some may become due now; allowances and working hours still meter the sends)" : "keep their current wait"}.`,
    removedLeads.length && mode === "all" ? `Leads on removed steps (${removedLeads.join(", ")}) are ${removedMode === "skip" ? "moved to the next step of the old version" : "exited"}.` : "",
    s.draft_updated_at && graph ? `A saved draft from ${String(s.draft_updated_at).slice(0, 16)} exists on this sequence and is discarded by this publish.` : "",
    impact.stale ? `FORCED: version ${impact.head_version} was published by someone else after this draft started (from version ${impact.draft_base_version}); their changes are overwritten where the draft differs.` : "",
  ].filter(Boolean).join(" ");
  const g = await gate(ctx, toolName, a as Record<string, unknown>, summary, s.workspace_id, { impact: { ...impact, validation: undefined } });
  if (!g.proceed) return g.result;
  const r = await urpc<Row>(ctx, "publish_sequence", {
    p_id: s.id, p_graph: graph, p_mode: mode, p_note: a.note ?? null, p_force: a.force === true, p_update_queued: updateQueued, p_reschedule_delays: resched, p_removed_mode: removedMode,
    p_pool: extra?.pool ?? null, p_settings: extra?.settings ?? null, p_name: extra?.name ?? null, p_assignment: extra?.assignment ?? null, p_brief: extra?.brief ?? null,
  });
  return { published: true, sequence_id: s.id, previous_version: impact.head_version, ...r, warnings: v.warnings, next: r.pinned ? "Pinned leads show in sequence_versions (live_leads per version); sequence_move_to_latest brings them forward later." : undefined };
}

export function registerSequences(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "sequences_list", title: "List sequences", cls: "read", minRole: "client_viewer",
    description: "Sequences of a workspace with status, pool size, live/completed/replied counts, throttle reason, stalled reason (the stall alert) and whether an unpublished draft exists.",
    input: { ...wsParam, status: z.enum(["draft", "active", "paused", "archived"]).optional(), client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_sequences").select(SEQ_COLS).eq("workspace_id", ws.id).order("updated_at", { ascending: false }).limit(100);
    if (a.status) q = q.eq("status", a.status); else q = q.neq("status", "archived");
    if (a.client_id) q = q.eq("client_id", a.client_id);
    const rows = unwrap<Row[]>(await q);
    const summary = await urpc<Row[]>(ctx, "sequence_summary", { p_ws: ws.id }).catch(() => []);
    const byId = new Map((summary ?? []).map((s: Row) => [s.sequence_id, s]));
    return { workspace: ws.name, count: rows.length, sequences: rows.map((s) => { const m = byId.get(s.id) ?? {}; return { id: s.id, name: s.name, status: s.status, version: s.head_version, pool: s.sender_pool?.length ?? 0, assignment: s.assignment, client_id: s.client_id, live: m.live, completed: m.completed, replied: m.replied, sent: m.sent, queued: m.queued, throttled: s.throttled_reason, stalled: s.stalled_at ? s.stalled_reason ?? true : undefined, unpublished_draft: s.draft_updated_at ? s.draft_updated_at : undefined, updated: s.updated_at?.slice(0, 10) }; }) };
  });

  tool(server, ctx, {
    name: "sequence_get", title: "Get sequence", cls: "read", minRole: "client_viewer",
    description: "One sequence: readable step-by-step rendering of the LIVE graph (with per-step stats when include_stats; A/B variants are added together per step), pool senders, settings (reply stop scope, on_reply, holds, enrichment / AI-review waits), assignment rule, brief, version, stall reason, and whether an unpublished draft exists (include_draft renders it).",
    input: { sequence_id: z.string(), include_stats: z.boolean().optional(), include_graph_json: z.boolean().optional().describe("Also return the raw graph (verbose)"), include_draft: z.boolean().optional().describe("Also render the saved, unpublished draft") },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    let stats: Record<string, Row> | undefined;
    if (a.include_stats) { const { data } = await ctx.user.from("outreach_node_stats").select("*").eq("sequence_id", s.id); stats = statsByNode(data ?? []); }
    return {
      id: s.id, name: s.name, status: s.status, version: s.head_version, client_id: s.client_id, brief: s.brief, settings: s.settings, assignment: s.assignment, use_sender_schedule: s.use_sender_schedule, throttled: s.throttled_reason, stalled: s.stalled_at ? s.stalled_reason : undefined,
      pool: await poolInfo(ctx, s.sender_pool), nodes: Object.keys(s.graph?.nodes ?? {}).length, rendered: renderGraph(s.graph, stats), graph: a.include_graph_json ? s.graph : undefined,
      draft: s.draft_graph ? { saved_at: s.draft_updated_at, base_version: s.draft_base_version, stale: s.draft_base_version != null && s.draft_base_version !== s.head_version, rendered: a.include_draft ? renderGraph(s.draft_graph) : undefined, note: "Nothing in a draft reaches a lead until it is published (sequence_publish)." } : undefined,
    };
  });

  tool(server, ctx, {
    name: "sequence_templates", title: "Sequence templates", cls: "read", minRole: "client_viewer",
    description: "Built-in sequence templates as compact step lists. Use a key with sequence_create.from_template, or copy the steps and adapt the copy.",
    input: { category: z.string().optional() },
  }, async (a) => ({ templates: TEMPLATES.filter((t) => !a.category || t.category === a.category).map((t) => ({ key: t.key, name: t.name, category: t.category, description: t.description, steps: t.steps })) }));

  tool(server, ctx, {
    name: "sequence_validate", title: "Validate sequence", cls: "read", minRole: "client_viewer",
    description: "Run the platform's graph validation (blocking errors + warnings: limits, missing branches, relation prerequisites, reachability, A/B variants, a missing unsubscribe link on email steps) on an existing sequence, its saved draft (draft:true) or on steps/graph you are about to create. Texts that use spintax {a|b|c} are reported under `spintax` with the number of combinations and the LONGEST result: the longest combination is what counts against LinkedIn's limits (an over-length invitation note fails every request). With ai:true (managers) also runs the LLM copy QA (pitch-in-first-touch, generic openers, short delays…). Call before every create/update/activate.",
    input: { sequence_id: z.string().optional(), draft: z.boolean().optional().describe("With sequence_id: validate the saved draft instead of the live graph"), ...graphInput, pool: z.array(z.string()).optional().describe("Sender ids (affects invite-note limits / mailbox checks)"), ai: z.boolean().optional() },
  }, async (a) => {
    let graph: Graph | null = null, pool = a.pool ?? [], compile: Row[] = [], ws: string | null = null, brief: string | null = null;
    if (a.sequence_id) { const s = await loadSequence(ctx, a.sequence_id, "workspace_id, graph, draft_graph, sender_pool, brief"); graph = a.draft && s.draft_graph ? s.draft_graph : s.graph; pool = a.pool ?? s.sender_pool ?? []; ws = s.workspace_id; brief = s.brief; }
    else { const g = graphFrom(a); graph = g.graph; compile = g.errors; }
    if (compile.length) return { ok: false, compile_errors: compile, next: "Fix the listed steps and validate again." };
    if (!graph) throw new McpError("E_PAYLOAD_INVALID", "sequence_id, steps, graph or from_template required");
    const [v, spintax] = await Promise.all([validate(ctx, graph, pool, true), spintaxReport(ctx, graph)]);
    let ai: Row | undefined;
    if (a.ai) {
      const wsId = ws ?? resolveWs(ctx, undefined).id;
      try { const r = await callFn<Row>(ctx, "ai-sequence-qa", a.sequence_id && !a.draft ? { sequence_id: a.sequence_id } : { graph, workspace_id: wsId, pool, brief }); ai = { available: r.ai_available, warnings: (r.warnings ?? []).filter((w: Row) => String(w.code).startsWith("W_") && !v.warnings.some((x) => x.code === w.code && x.node_id === w.node_id)), errors: r.errors }; }
      catch (e) { ai = { available: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    return { ok: v.errors.length === 0 && !(ai?.errors?.length), errors: v.errors, warnings: v.warnings, spintax: spintax.length ? { texts: spintax, note: "combinations = how many different texts the step can produce; longest_chars is checked against the channel limit. The choice is seeded per lead, so the preview is exactly what gets sent." } : undefined, ai_qa: ai, rendered: renderGraph(graph) };
  });

  tool(server, ctx, {
    name: "sequence_project", title: "Project a sequence", cls: "read", minRole: "client_viewer",
    description: "Estimated days to complete N leads through a sequence given the pool's effective caps and schedules, the bottleneck action type, and per-type totals. Run before enrolling.",
    input: { sequence_id: z.string(), lead_count: z.number().int().min(1).max(100000) },
  }, async (a) => {
    const r = await urpc<Row[]>(ctx, "project_sequence", { p_sequence: a.sequence_id, p_lead_count: a.lead_count });
    const p = Array.isArray(r) ? r[0] : r;
    if (!p) throw new McpError("E_NOT_FOUND", "sequence not found");
    return { lead_count: a.lead_count, estimated_days: p.estimated_days, bottleneck: p.bottleneck, details: p.details, note: p.details?.pool_size ? undefined : "Pool is empty — projection is meaningless until senders are added." };
  });

  tool(server, ctx, {
    name: "sequence_create", title: "Create sequence", cls: "write", minRole: "manager",
    description: "Create a sequence (as a draft) from a compact step list, a template, or a graph, with a sender pool and optional brief/settings/assignment rule. Compiles, validates (strict) and saves; returns the id, version, validation result and a readable rendering. Nothing is sent until sequence_activate + enrollments. Defaults worth knowing: a reply stops the lead everywhere (stop_on_reply_scope 'lead') and exits cleanly (on_reply 'exit'); out-of-office replies resume on their own.",
    input: {
      ...wsParam, name: z.string().min(1), ...graphInput,
      pool: z.array(z.string()).optional().describe("Sender ids to send from (required before activation)"),
      brief: z.string().optional().describe("Campaign brief: ICP, offer, tone — used by AI drafting/QA and reply classification"),
      settings: SETTINGS.optional(), assignment: ASSIGNMENT.optional(), client_id: z.string().optional(),
      allow_warnings: z.boolean().optional().describe("Create even when strict validation returns warnings (errors always block)"),
    },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id); requireRole(ws, "manager");
    const g = graphFrom(a);
    if (g.errors.length) return { created: false, compile_errors: g.errors };
    if (!g.graph) throw new McpError("E_PAYLOAD_INVALID", "steps, graph or from_template required");
    const pool = a.pool ?? [];
    const v = await validate(ctx, g.graph, pool, true);
    if (v.errors.length) return { created: false, errors: v.errors, warnings: v.warnings, rendered: renderGraph(g.graph) };
    if (v.warnings.length && !a.allow_warnings) return { created: false, warnings: v.warnings, rendered: renderGraph(g.graph), next: "Review the warnings with the user; call again with allow_warnings:true to create anyway, or fix the steps." };
    const id = await urpc<string>(ctx, "create_sequence", { p_workspace: ws.id, p_name: a.name, p_client_id: a.client_id ?? null });
    const version = await urpc<number>(ctx, "save_sequence", { p_id: id, p_graph: g.graph, p_pool: pool.length ? pool : null, p_settings: a.settings ?? null, p_brief: a.brief ?? null, p_assignment: a.assignment ?? null });
    return { created: true, sequence_id: id, version, status: "draft", source: g.source, warnings: v.warnings, pool: await poolInfo(ctx, pool), rendered: renderGraph(g.graph), next: pool.length ? "sequence_project → enroll_preview → enroll_commit; then sequence_activate (confirmation) when ready." : "Add senders with sequence_update(pool) before activating." };
  });

  tool(server, ctx, {
    name: "sequence_update", title: "Update / publish a sequence", cls: "write", minRole: "manager",
    description: "Replace the steps/graph and/or change settings, name, brief, assignment. A sequence that was never activated (status draft) is saved directly. A sequence that is or was LIVE goes through publish: the first call returns the impact as the effect summary (leads in flight, how many are on / past / before a changed step, messages already queued with the old text, leads waiting in a changed delay, leads on removed steps) and a confirmation_token; show it, then repeat the call with the token. Choose mode 'all' (default: leads that have not reached a changed step follow the new version) or 'new_only' (leads in flight are pinned to their current version; only new leads get the new one). Already-sent messages never change. Changing only settings / name / brief / assignment writes no new version. On a live sequence change the pool with sequence_pool_set (it can rebalance untouched leads safely). To prepare work without publishing use sequence_draft_save.",
    input: { sequence_id: z.string(), ...graphInput, pool: z.array(z.string()).optional().describe("Draft sequences only; live sequences use sequence_pool_set"), settings: SETTINGS.optional().describe("Merged into the current settings"), name: z.string().optional(), brief: z.string().optional(), assignment: ASSIGNMENT.optional(), ...publishInput },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    requireRole(resolveWs(ctx, s.workspace_id), "manager");
    const g = graphFrom(a);
    if (g.errors.length) return { updated: false, compile_errors: g.errors };
    const settings = a.settings ? { ...(s.settings ?? {}), ...a.settings } : null;
    const neverLive = s.status === "draft";
    if (a.pool && !neverLive) throw new McpError("E_PAYLOAD_INVALID", "the pool of a live sequence is changed with sequence_pool_set", "Call sequence_pool_preview(sequence_id, pool) to see who would move, then sequence_pool_set.");

    if (neverLive || !g.graph) {
      // never activated, or no step change at all: a plain save (the same graph writes no new version and leaves an open draft alone)
      const graph = g.graph ?? (s.graph as Graph);
      const pool = a.pool ?? s.sender_pool ?? [];
      const v = await validate(ctx, graph, pool, true);
      if (v.errors.length) return { updated: false, errors: v.errors, warnings: v.warnings };
      if (g.graph && v.warnings.length && !a.allow_warnings) return { updated: false, warnings: v.warnings, next: "Call again with allow_warnings:true or fix the steps." };
      const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph, p_pool: a.pool ?? null, p_settings: settings, p_name: a.name ?? null, p_brief: a.brief ?? null, p_assignment: a.assignment ?? null });
      return { updated: true, sequence_id: s.id, version, previous_version: s.head_version, graph_changed: !!g.graph, warnings: v.warnings, pool: a.pool ? await poolInfo(ctx, a.pool) : undefined, rendered: g.graph ? renderGraph(graph) : undefined };
    }
    return await publishFlow(ctx, "sequence_update", s, g.graph, a as Row, { settings, name: a.name ?? null, brief: a.brief ?? null, assignment: a.assignment ?? null });
  });

  tool(server, ctx, {
    name: "sequence_publish_impact", title: "Who would a publish touch?", cls: "read", minRole: "manager",
    description: "Read-only impact of publishing new steps (steps/graph) or the saved draft (neither given) on a live sequence: head_version, stale (someone else published since the draft started), changes, in_flight, already_pinned, on_changed_step, past_changed_step, on_or_after_changed, before_changed_step, queued_with_old_text, waiting_on_changed_delay, removed_nodes, per-step rows and the validation result. sequence_update / sequence_publish show the same numbers in their confirmation.",
    input: { sequence_id: z.string(), ...graphInput },
  }, async (a) => {
    const g = graphFrom(a);
    if (g.errors.length) return { compile_errors: g.errors };
    return await urpc<Row>(ctx, "publish_impact", { p_id: a.sequence_id, p_graph: g.graph });
  });

  tool(server, ctx, {
    name: "sequence_draft_save", title: "Save a draft (nothing goes live)", cls: "write", minRole: "manager",
    description: "Save steps/graph as the sequence's DRAFT. The engine never reads a draft, so no lead is affected until sequence_publish. Returns saved_at, base_version, head_version, stale (the live version moved on since the draft started) and unpublished_changes. The web builder auto-saves to the same draft, so this overwrites what a teammate has open there.",
    input: { sequence_id: z.string(), ...graphInput },
  }, async (a) => {
    const g = graphFrom(a);
    if (g.errors.length) return { saved: false, compile_errors: g.errors };
    if (!g.graph) throw new McpError("E_PAYLOAD_INVALID", "steps, graph or from_template required");
    const r = await urpc<Row>(ctx, "save_draft", { p_id: a.sequence_id, p_graph: g.graph });
    return { saved: true, ...r, rendered: renderGraph(g.graph), next: "sequence_validate(sequence_id, draft:true) → sequence_publish_impact → sequence_publish." };
  });

  tool(server, ctx, {
    name: "sequence_draft_discard", title: "Discard the draft", cls: "write", minRole: "manager",
    description: "Throw away the saved, unpublished draft of a sequence. The live version and every lead are untouched. Ask first: a teammate may be editing it in the builder.",
    input: { sequence_id: z.string() },
  }, async (a) => { await urpc(ctx, "discard_draft", { p_id: a.sequence_id }); return { discarded: true, sequence_id: a.sequence_id }; });

  tool(server, ctx, {
    name: "sequence_publish", title: "Publish the saved draft (confirmation required)", cls: "gated", minRole: "manager",
    description: "Publish the sequence's saved draft (from sequence_draft_save or the web builder). First call: the impact as the effect summary + confirmation_token; second call with the token publishes. Same options as sequence_update: mode all | new_only, update_queued, reschedule_delays, removed_mode, note. E_DRAFT_STALE = someone else published while the draft was open: show the fresh impact and use force:true only after the human agrees.",
    input: { sequence_id: z.string(), ...publishInput },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    requireRole(resolveWs(ctx, s.workspace_id), "manager");
    if (!s.draft_graph) throw new McpError("E_PAYLOAD_INVALID", "this sequence has no saved draft", "Save one with sequence_draft_save, or publish steps directly with sequence_update.");
    return await publishFlow(ctx, "sequence_publish", s, null, a as Row, { what: "the saved draft" });
  });

  tool(server, ctx, {
    name: "sequence_edit_copy", title: "Edit step copy (confirmation on live sequences)", cls: "write", minRole: "manager",
    description: "Change the text of one or more steps (invite note, message, InMail, comment, email; pass variant_id to edit one A/B variant). On a never-activated sequence it saves directly. On a live sequence it publishes a new version through the same impact + confirmation as sequence_update; update_queued (default true here) makes messages already queued with the old text render again from the new text at send time, with the platform's one renderer, so preview and send stay identical. Hand-edited and human-approved queued texts are kept. Already-sent touches never change.",
    input: { sequence_id: z.string(), edits: z.array(z.object({ node_id: z.string(), variant_id: z.string().optional(), text: z.string().optional(), subject: z.string().optional() })).min(1).max(20), ...publishInput },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    requireRole(resolveWs(ctx, s.workspace_id), "manager");
    const graph = structuredClone(s.graph) as Graph;
    const report: Row[] = [];
    for (const e of a.edits) {
      const n = graph.nodes[e.node_id];
      if (!n) throw new McpError("E_NOT_FOUND", `node ${e.node_id} not in sequence`);
      const f = nodeTextField(n);
      if (!f) throw new McpError("E_PAYLOAD_INVALID", `node ${e.node_id} (${n.type}) has no editable copy`);
      n.config = { ...(n.config ?? {}) };
      const val = e.text === undefined ? undefined : n.type === "send_email" ? e.text.replace(/\n/g, "<br/>") : e.text;
      if (e.variant_id) {
        const vars = (Array.isArray(n.config.variants) ? structuredClone(n.config.variants) : []) as Row[];
        const v = vars.find((x) => x.id === e.variant_id);
        if (!v) throw new McpError("E_VARIANT_INVALID", `variant ${e.variant_id} not found on ${e.node_id}`);
        if (val !== undefined) v[f] = val;
        if (e.subject !== undefined) v.subject = e.subject;
        n.config.variants = vars;
      } else {
        if (val !== undefined) n.config[f] = val;
        if (e.subject !== undefined) n.config.subject = e.subject;
      }
      report.push({ node_id: e.node_id, type: n.type, field: f, variant_id: e.variant_id });
    }
    if (s.status === "draft") {
      const v = await validate(ctx, graph, s.sender_pool ?? [], true);
      if (v.errors.length) return { updated: false, errors: v.errors };
      const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph });
      return { updated: true, version, nodes: report };
    }
    return await publishFlow(ctx, "sequence_edit_copy", s, graph, a as Row, { updateQueuedDefault: true, what: "a copy change" });
  });

  tool(server, ctx, {
    name: "sequence_edit_timing", title: "Edit step timing (confirmation on live sequences)", cls: "write", minRole: "manager",
    description: "Change delays: for a delay step, the wait; for an action step, its own `wait` before executing. On a live sequence it publishes through the same impact + confirmation as sequence_update; reschedule_delays (default true here) recomputes the wait of leads currently sitting in an edited delay from when they entered it. If the new delay already elapsed they become due now, and daily allowances and working hours still meter the sends. Actions already queued keep their time.",
    input: { sequence_id: z.string(), edits: z.array(z.object({ node_id: z.string(), wait: z.string().describe('e.g. "2h", "3d", "0d"') })).min(1).max(20), ...publishInput },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    requireRole(resolveWs(ctx, s.workspace_id), "manager");
    const graph = structuredClone(s.graph) as Graph;
    const report: Row[] = [];
    for (const e of a.edits) {
      const n = graph.nodes[e.node_id];
      if (!n) throw new McpError("E_NOT_FOUND", `node ${e.node_id} not in sequence`);
      const w = parseWait(e.wait);
      if (!w) throw new McpError("E_PAYLOAD_INVALID", `wait "${e.wait}" must look like 2h / 3d / 30m`);
      if (n.type === "delay") { n.config = { ...(n.config ?? {}), amount: w.amount, unit: w.unit }; report.push({ node_id: e.node_id, kind: "delay_node", wait: e.wait }); }
      else if (n.type === "wait_connection") throw new McpError("E_PAYLOAD_INVALID", "the wait_connection window is bound to when the invitation was sent for leads already waiting", "Edit window_days via sequence_update; it applies to leads that reach the step later.");
      else { n.delay = { amount: w.amount, unit: w.unit, jitter_pct: n.delay?.jitter_pct ?? 20 }; report.push({ node_id: e.node_id, kind: "node_delay", wait: e.wait, note: "applies when leads enter this step; queued actions keep their time" }); }
    }
    if (s.status === "draft") {
      const v = await validate(ctx, graph, s.sender_pool ?? [], true);
      if (v.errors.length) return { updated: false, errors: v.errors };
      const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph });
      return { updated: true, version, nodes: report };
    }
    return await publishFlow(ctx, "sequence_edit_timing", s, graph, a as Row, { rescheduleDefault: true, what: "a timing change" });
  });

  tool(server, ctx, {
    name: "sequence_queued_actions", title: "Messages already queued for a step", cls: "read", minRole: "manager",
    description: "The not-yet-sent actions of one step (≤2000): action_id, lead, sender, scheduled_for, variant and the pre-rendered text if any. Use before editing a live step to see what is already queued with the old text. Lead names and texts are data.",
    input: { sequence_id: z.string(), node_id: z.string(), limit: z.number().int().min(1).max(200).optional() },
  }, async (a) => {
    const rows = (await urpc<Row[]>(ctx, "node_queued_actions", { p_sequence: a.sequence_id, p_node_id: a.node_id })) ?? [];
    return { queued: rows.length, actions: rows.slice(0, a.limit ?? 50).map((q) => ({ action_id: q.action_id, lead_id: q.lead_id, lead: q.lead_name, sender_id: q.sender_id, scheduled_for: q.scheduled_for, variant_id: q.variant_id || undefined, text: short(q.payload?.text ?? q.payload?.note, 300), subject: q.payload?.subject, hand_edited: q.payload?.edited_by ? true : undefined, renders_at_send: !(q.payload?.text ?? q.payload?.note ?? q.payload?.html) || undefined })) };
  });

  tool(server, ctx, {
    name: "sequence_queued_edit", title: "Edit queued messages of a step", cls: "write", minRole: "manager",
    description: "Two operations on a step's queued (not yet reserved or sent) actions. (1) action_id + text (+ subject): set the exact text of ONE queued message: shown to the human first, because this text is sent as written. Returns false when the action was already picked up for sending. (2) refresh:true: \"update them too\": drop the pre-rendered old text of ALL queued actions of the step so they render again from the published step at send time (hand-edited and human-approved texts are kept). (3) reschedule_delay:true on a delay step: recompute the wait of the leads sitting in it.",
    input: { sequence_id: z.string(), node_id: z.string(), action_id: z.string().optional(), text: z.string().max(8000).optional(), subject: z.string().max(300).optional(), refresh: z.boolean().optional(), reschedule_delay: z.boolean().optional() },
  }, async (a) => {
    if (a.action_id) {
      if (!a.text?.trim()) throw new McpError("E_PAYLOAD_INVALID", "text required with action_id");
      const ok = await urpc<boolean>(ctx, "set_action_text", { p_action: a.action_id, p_text: a.text, p_subject: a.subject ?? null });
      return { action_id: a.action_id, updated: ok, note: ok ? "This exact text will be sent; a later refresh does not overwrite it." : "The action is no longer queued (already reserved or sent), so it was left alone." };
    }
    if (a.refresh) return { refreshed: await urpc<number>(ctx, "refresh_queued_text", { p_sequence: a.sequence_id, p_node_id: a.node_id }), note: "These actions render again from the live step when they are sent." };
    if (a.reschedule_delay) { const r = await urpc<Row[]>(ctx, "reschedule_delay", { p_sequence: a.sequence_id, p_node_id: a.node_id }); const x = Array.isArray(r) ? r[0] : r; return { rescheduled: x?.rescheduled ?? 0, due_now: x?.due_now ?? 0 }; }
    throw new McpError("E_PAYLOAD_INVALID", "pass action_id + text, refresh:true or reschedule_delay:true");
  });

  tool(server, ctx, {
    name: "sequence_activate", title: "Activate sequence (confirmation required)", cls: "gated", minRole: "manager",
    description: "Start sending: requires a non-empty pool of connected senders and strict validation to pass. Resumes enrollments the previous pause parked. Two-step confirmation with an effect summary (pool, live enrollments, projection).",
    input: { sequence_id: z.string(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    if (s.status === "active") return { status: "active", note: "already active" };
    const pool = await poolInfo(ctx, s.sender_pool ?? []);
    const notOk = pool.filter((p) => p.status !== "ok");
    const v = await validate(ctx, s.graph, s.sender_pool ?? [], true);
    if (!pool.length) throw new McpError("E_POOL_EMPTY", "sequence has no senders in its pool");
    if (notOk.length) throw new McpError("E_SENDER_NOT_OK", `pool senders not connected: ${notOk.map((p) => `${p.name} (${p.status})`).join(", ")}`, "Remove them from the pool or have a human reconnect them.");
    if (v.errors.length) throw new McpError("E_GRAPH_INVALID", "strict validation failed", undefined, v.errors);
    const { count: live } = await ctx.user.from("outreach_enrollments").select("id", { count: "exact", head: true }).eq("sequence_id", s.id).in("status", ["active", "waiting_connection", "waiting_delay", "waiting_task", "paused"]);
    const proj = (await urpc<Row[]>(ctx, "project_sequence", { p_sequence: s.id, p_lead_count: Math.max(live ?? 0, 1) }).catch(() => []))[0];
    const summary = `Activate "${s.name}" (v${s.head_version}) on ${pool.length} sender(s): ${pool.map((p) => `${p.name} [health ${p.health}, level ${p.level}]`).join(", ")}. ${live ?? 0} enrollment(s) currently in it will start/resume; first actions go out at the next planner run inside each sender's schedule window${proj ? `; projected ${proj.estimated_days} day(s) for ${live ?? 0} leads (bottleneck ${proj.bottleneck})` : ""}.${v.warnings.length ? ` Warnings: ${v.warnings.map((w) => w.code).join(", ")}.` : ""}`;
    const g = await gate(ctx, "sequence_activate", a as Record<string, unknown>, summary, s.workspace_id);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "set_sequence_status", { p_id: s.id, p_status: "active" });
    return { status: r?.status ?? "active", warnings: r?.warnings, live_enrollments: live ?? 0 };
  });

  tool(server, ctx, {
    name: "sequence_pause", title: "Pause sequence", cls: "write", minRole: "manager",
    description: "Pause a sequence: live enrollments are parked (nothing new is queued; queued actions are held) and resume on the next activate. Safe. Not needed before editing any more: publishing shows the impact and can pin in-flight leads.",
    input: { sequence_id: z.string() },
  }, async (a) => { const r = await urpc<Row>(ctx, "set_sequence_status", { p_id: a.sequence_id, p_status: "paused" }); return { status: r?.status ?? "paused" }; });

  tool(server, ctx, {
    name: "sequence_versions", title: "Sequence versions", cls: "read", minRole: "client_viewer",
    description: "Version history with usage: version, created_at, note, publish_mode (all | new_only), is_head and live_leads = how many leads still run on that version (leads pinned by a new_only publish). Bring them forward with sequence_move_to_latest.",
    input: { sequence_id: z.string() },
  }, async (a) => {
    const rows = (await urpc<Row[]>(ctx, "version_usage", { p_sequence: a.sequence_id })) ?? [];
    return { versions: rows.slice(0, 40), on_older_versions: rows.filter((v) => !v.is_head && v.live_leads > 0).map((v) => ({ version: v.version, live_leads: v.live_leads })) };
  });

  tool(server, ctx, {
    name: "sequence_move_to_latest", title: "Move pinned leads to the latest version (confirmation required)", cls: "gated", minRole: "manager",
    description: "Leads pinned to an older version (after a new_only publish) move to the latest version. A lead whose current step no longer exists in the latest version stays on the old one and finishes there (kept_on_old_version). Their queued messages render again from the latest text. Nothing already sent is sent again. Two-step confirmation.",
    input: { sequence_id: z.string(), version: z.number().int().min(1).describe("The old version the leads are pinned to (see sequence_versions)"), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, head_version");
    const usage = (await urpc<Row[]>(ctx, "version_usage", { p_sequence: s.id })) ?? [];
    const row = usage.find((v) => v.version === a.version);
    if (!row) throw new McpError("E_NOT_FOUND", `version ${a.version} does not exist`);
    if (row.is_head) return { moved: 0, note: "That is already the latest version." };
    const g = await gate(ctx, "sequence_move_to_latest", a as Record<string, unknown>, `Move the ${row.live_leads} lead(s) still running "${s.name}" version ${a.version} to the latest version ${s.head_version}. Leads whose current step does not exist in version ${s.head_version} stay on version ${a.version}. Their queued messages render again from the latest text; nothing already sent is repeated.`, s.workspace_id);
    if (!g.proceed) return g.result;
    return await urpc<Row>(ctx, "move_to_latest", { p_sequence: s.id, p_version: a.version });
  });

  tool(server, ctx, {
    name: "sequence_restore", title: "Restore version (confirmation required)", cls: "gated", minRole: "manager",
    description: "Re-save an older version's graph as the new head. Two-step confirmation.",
    input: { sequence_id: z.string(), version: z.number().int().min(1), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, head_version, status");
    const g = await gate(ctx, "sequence_restore", a as Record<string, unknown>, `Restore "${s.name}" to version ${a.version} (current head v${s.head_version}, status ${s.status}). Unpinned live leads follow the restored graph from their next step; pinned leads stay on their version.`, s.workspace_id);
    if (!g.proceed) return g.result;
    const v = await urpc<number>(ctx, "restore_sequence_version", { p_id: s.id, p_version: a.version });
    return { restored_from: a.version, new_version: v };
  });

  // ---------------------------------------------------------------- item 9: pool changes that cannot duplicate a touch
  tool(server, ctx, {
    name: "sequence_pool_preview", title: "Preview a pool change / rebalance", cls: "read", minRole: "manager",
    description: "What changing the sender pool of a sequence would do, before anything changes: added / removed senders, untouched_total (leads with nothing sent and no invitation pending: the only ones that may move), would_move, target_per_sender, per sender {untouched, contacted, after} and contacted_on_removed (leads a removed sender already contacted: they stay with it, or exit). Omit pool to preview an even rebalance of the current pool.",
    input: { sequence_id: z.string(), pool: z.array(z.string()).max(50).optional() },
  }, async (a) => await urpc<Row>(ctx, "rebalance_preview", { p_sequence: a.sequence_id, p_pool: a.pool ?? null }));

  tool(server, ctx, {
    name: "sequence_pool_set", title: "Change the pool / rebalance (confirmation required)", cls: "gated", minRole: "manager",
    description: "Set the sender pool of a sequence and optionally even out the untouched leads across it. Only leads with nothing sent and no invitation pending move, so nothing is sent twice and no lead sees two senders. Untouched leads of a removed sender always move. contacted: 'keep' (default: leads a removed sender already contacted finish with it) or 'exit'. Two-step confirmation showing the preview numbers.",
    input: { sequence_id: z.string(), pool: z.array(z.string()).min(1).max(50), rebalance: z.boolean().optional().describe("Also even out untouched leads across the pool (default false)"), contacted: z.enum(["keep", "exit"]).optional(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, status");
    const pv = await urpc<Row>(ctx, "rebalance_preview", { p_sequence: s.id, p_pool: a.pool });
    const nameOf = (id: string) => (pv.senders ?? []).find((x: Row) => x.sender_id === id)?.name ?? id;
    const removedUntouched = (pv.senders ?? []).filter((x: Row) => !x.in_pool).map((x: Row) => `${x.name}: ${x.untouched}`).join(", ");
    const summary = `Set the pool of "${s.name}" (${s.status}) to ${pv.pool_size} sender(s). Added: ${(pv.added ?? []).map(nameOf).join(", ") || "none"}. Removed: ${(pv.removed ?? []).map(nameOf).join(", ") || "none"}. ${pv.untouched_total} untouched lead(s) (nothing sent, no invitation pending) can move. ${a.rebalance ? `Rebalance: about ${pv.would_move} of them move so each sender holds about ${pv.target_per_sender}.` : `No rebalance: only untouched leads of removed senders move${removedUntouched ? ` (${removedUntouched})` : ""}.`} ${pv.contacted_on_removed ? `${pv.contacted_on_removed} lead(s) already contacted by a removed sender ${a.contacted === "exit" ? "are EXITED" : "stay with that sender until they finish"}.` : ""} Leads that were already contacted never change sender, so nothing is sent twice.`;
    const g = await gate(ctx, "sequence_pool_set", a as Record<string, unknown>, summary, s.workspace_id, { preview: pv });
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "set_pool", { p_sequence: s.id, p_pool: a.pool, p_rebalance: a.rebalance === true, p_contacted: a.contacted ?? "keep" });
    return { ...r, pool: await poolInfo(ctx, a.pool) };
  });

  // ---------------------------------------------------------------- item 11: A/B results and promote
  tool(server, ctx, {
    name: "sequence_ab_results", title: "A/B test results", cls: "read", minRole: "client_viewer",
    description: "Results of one A/B test: message variants inside a step, or an ab_split step (whole paths). Per variant: sent, accepted, replies, interested and their rates, is_leading, confidence_vs_leader (two-proportion test, %) and verdict_vs_leader in words. judged_on says what decides: acceptance for invitations, otherwise INTERESTED replies (not just replies). No winner is named under 100 sends per variant (enough_data false, leader empty). can_promote is true only with enough data and at least 90% confidence against every other variant. Quote the verdicts; do not run your own statistics.",
    input: { sequence_id: z.string(), node_id: z.string().describe("The step with variants, or the ab_split step (see sequence_get / report_sequence.ab_tests)"), period: z.object({ from: z.string(), to: z.string().optional() }).optional().describe("Default: the whole life of the sequence") },
  }, async (a) => {
    const r = await urpc<Row>(ctx, "ab_results", { p_sequence: a.sequence_id, p_node_id: a.node_id, p_from: a.period?.from?.slice(0, 10) ?? null, p_to: a.period?.to?.slice(0, 10) ?? null });
    const lead = (r.variants ?? []).find((v: Row) => v.is_leading);
    return { ...r, summary: !r.enough_data ? `Not enough data yet: every variant needs ${r.min_sends_per_variant} sends before a winner is named (${(r.variants ?? []).map((v: Row) => `${v.label}: ${v.sent}`).join(", ")}).` : `Judged on ${r.judged_on}: "${lead?.label}" leads. ${(r.variants ?? []).filter((v: Row) => !v.is_leading).map((v: Row) => `vs "${v.label}": ${v.verdict_vs_leader} (${v.confidence_vs_leader ?? "n/a"}%)`).join("; ")}. ${r.can_promote ? "The leader can be promoted (sequence_promote_variant)." : "Not clear enough to promote yet."}` };
  });

  tool(server, ctx, {
    name: "sequence_promote_variant", title: "Promote the winning variant (confirmation required)", cls: "gated", minRole: "manager",
    description: "Set one message variant to 100% and the others to 0, publish that as a new version, and let queued messages of the step render again from it. The platform only calls a winner with 100+ sends per variant and at least 90% confidence; when can_promote is false the confirmation says so plainly, and the human may still decide to promote. Not available for ab_split steps (edit the branch weights instead). Two-step confirmation.",
    input: { sequence_id: z.string(), node_id: z.string(), variant_id: z.string(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, status, head_version");
    requireRole(resolveWs(ctx, s.workspace_id), "manager");
    const r = await urpc<Row>(ctx, "ab_results", { p_sequence: s.id, p_node_id: a.node_id, p_from: null, p_to: null });
    const v = (r.variants ?? []).find((x: Row) => x.variant_id === a.variant_id);
    if (!v) throw new McpError("E_VARIANT_INVALID", `variant ${a.variant_id} has no results on step ${a.node_id}`, "Check the ids with sequence_ab_results.");
    const summary = `Promote variant "${v.label}" on step ${a.node_id} of "${s.name}": it goes to 100%, every other variant to 0, published as a new version (now v${s.head_version}); queued messages of this step render again from it. Results so far, judged on ${r.judged_on}: ${(r.variants ?? []).map((x: Row) => `"${x.label}" ${x.sent} sent, ${x[r.judged_on]} ${r.judged_on}`).join("; ")}. ${r.can_promote && r.leader === a.variant_id ? "The platform confirms this variant as the winner." : r.can_promote ? `Careful: the platform's winner is "${(r.variants ?? []).find((x: Row) => x.variant_id === r.leader)?.label}", not this one.` : "Careful: the platform does NOT call a winner yet (under 100 sends per variant, or under 90% confidence). Promoting now is a judgement call."}`;
    const g = await gate(ctx, "sequence_promote_variant", a as Record<string, unknown>, summary, s.workspace_id);
    if (!g.proceed) return g.result;
    return await urpc<Row>(ctx, "promote_variant", { p_sequence: s.id, p_node_id: a.node_id, p_variant: a.variant_id });
  });

  tool(server, ctx, {
    name: "sequence_stats", title: "Sequence stats (lifetime)", cls: "read", minRole: "client_viewer",
    description: "Lifetime view of one sequence from the report functions (the same numbers as the Reports page): totals, per-step rows, exits, live leads, plus the cohort funnel enrolled → invited → accepted → messaged → replied → interested → meeting → won for every lead ever enrolled. Covers up to the last 2 years. For a date range use report_sequence / report_funnel.",
    input: { sequence_id: z.string() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, workspace_id, created_at");
    const ws = resolveWs(ctx, s.workspace_id);
    const to = todayIn(wsTz(ws));
    const floor = new Date(`${to}T00:00:00Z`); floor.setUTCDate(floor.getUTCDate() - 730);
    const created = String(s.created_at).slice(0, 10), from = created > floor.toISOString().slice(0, 10) ? created : floor.toISOString().slice(0, 10);
    const [rep, funnel] = await Promise.all([
      urpc<Row>(ctx, "report_sequence", { p_sequence: s.id, p_from: from, p_to: to }),
      urpc<Row>(ctx, "report_funnel", { p_ws: s.workspace_id, p_client: null, p_from: from, p_to: to, p_filters: { sequence_id: s.id } }),
    ]);
    return { sequence: rep.sequence, period: rep.period, live: rep.live, totals: rep.totals, funnel: funnel.stages, steps: rep.steps, best_step: rep.best_step, worst_step: rep.worst_step, exits: rep.exits, ab_tests: (rep.ab_tests ?? []).map((t: Row) => ({ node_id: t.node_id, judged_on: t.judged_on, enough_data: t.enough_data, leader: t.leader, can_promote: t.can_promote })) };
  });
}

export { roleAtLeast, short, untrusted };
