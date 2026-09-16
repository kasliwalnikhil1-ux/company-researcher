// outreach-mcp/tools_sequences.ts — sequences (PRD §5.3). Reads for all members; writes manager+.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { renderTemplate } from "../_shared/outreach/render.ts";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, callFn, roleAtLeast, short } from "./ctx.ts";
import { compileSteps, renderGraph, TEMPLATES, templateByKey, parseWait, type Graph, type GraphNode } from "./steps.ts";

type Row = Record<string, any>;
const SEQ_COLS = "id, workspace_id, client_id, name, status, head_version, sender_pool, assignment, use_sender_schedule, settings, throttled_reason, brief, created_at, updated_at";

export async function loadSequence(ctx: Ctx, id: string, cols = "*"): Promise<Row> {
  const { data, error } = await ctx.user.from("outreach_sequences").select(cols).eq("id", id).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new McpError("E_NOT_FOUND", `sequence ${id} not found or not visible`);
  return data as Row;
}

const graphInput = {
  steps: z.array(z.record(z.string(), z.unknown())).optional().describe('Compact step list, e.g. [{"do":"visit_profile"},{"do":"invite","note":"Hi {{first_name|there}}…"},{"do":"wait_connection","window_days":14,"connected":[{"do":"message","wait":"1d","text":"…"}],"no_connect":[{"do":"withdraw"},{"do":"end"}]}]. Verbs: visit_profile, like_post, comment_post, endorse, invite, wait_connection, withdraw, message, inmail, email, delay, condition, tag, untag, list, stage, webhook, api, send_to_sequence, manual_task, ai_draft, end. `wait` like "2h"/"3d" delays that step. Variables: {{first_name|fallback}}, {{company}}, {{sender.first_name}}, {{custom.key}}.'),
  graph: z.record(z.string(), z.unknown()).optional().describe("Canonical graph JSON (advanced; prefer steps)"),
  from_template: z.string().optional().describe("Template key from sequence_templates"),
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
  switch (n.type) { case "send_invite": return "note"; case "send_message": case "send_inmail": case "comment_latest_post": return "text"; case "send_email": return "html"; default: return null; }
}

export function registerSequences(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "sequences_list", title: "List sequences", cls: "read", minRole: "client_viewer",
    description: "Sequences of a workspace with status, pool size, live/completed/replied counts and throttle reason.",
    input: { ...wsParam, status: z.enum(["draft", "active", "paused", "archived"]).optional(), client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_sequences").select(SEQ_COLS).eq("workspace_id", ws.id).order("updated_at", { ascending: false }).limit(100);
    if (a.status) q = q.eq("status", a.status); else q = q.neq("status", "archived");
    if (a.client_id) q = q.eq("client_id", a.client_id);
    const rows = unwrap<Row[]>(await q);
    const summary = await urpc<Row[]>(ctx, "sequence_summary", { p_ws: ws.id }).catch(() => []);
    const byId = new Map((summary ?? []).map((s: Row) => [s.sequence_id, s]));
    return { workspace: ws.name, count: rows.length, sequences: rows.map((s) => { const m = byId.get(s.id) ?? {}; return { id: s.id, name: s.name, status: s.status, version: s.head_version, pool: s.sender_pool?.length ?? 0, client_id: s.client_id, live: m.live, completed: m.completed, replied: m.replied, sent: m.sent, queued: m.queued, throttled: s.throttled_reason, updated: s.updated_at?.slice(0, 10) }; }) };
  });

  tool(server, ctx, {
    name: "sequence_get", title: "Get sequence", cls: "read", minRole: "client_viewer",
    description: "One sequence: readable step-by-step rendering of the graph (with per-node stats when include_stats), pool senders, settings, brief, version.",
    input: { sequence_id: z.string(), include_stats: z.boolean().optional(), include_graph_json: z.boolean().optional().describe("Also return the raw graph (verbose)") },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    let stats: Record<string, Row> | undefined;
    if (a.include_stats) { const { data } = await ctx.user.from("outreach_node_stats").select("*").eq("sequence_id", s.id); stats = Object.fromEntries((data ?? []).map((n: Row) => [n.node_id, n])); }
    return {
      id: s.id, name: s.name, status: s.status, version: s.head_version, client_id: s.client_id, brief: s.brief, settings: s.settings, assignment: s.assignment, use_sender_schedule: s.use_sender_schedule, throttled: s.throttled_reason,
      pool: await poolInfo(ctx, s.sender_pool), nodes: Object.keys(s.graph?.nodes ?? {}).length, rendered: renderGraph(s.graph, stats), graph: a.include_graph_json ? s.graph : undefined,
    };
  });

  tool(server, ctx, {
    name: "sequence_templates", title: "Sequence templates", cls: "read", minRole: "client_viewer",
    description: "Built-in sequence templates as compact step lists. Use a key with sequence_create.from_template, or copy the steps and adapt the copy.",
    input: { category: z.string().optional() },
  }, async (a) => ({ templates: TEMPLATES.filter((t) => !a.category || t.category === a.category).map((t) => ({ key: t.key, name: t.name, category: t.category, description: t.description, steps: t.steps })) }));

  tool(server, ctx, {
    name: "sequence_validate", title: "Validate sequence", cls: "read", minRole: "client_viewer",
    description: "Run the platform's graph validation (blocking errors + warnings: limits, missing branches, relation prerequisites, reachability) on an existing sequence or on steps/graph you are about to create. With ai:true (managers) also runs the LLM copy QA (pitch-in-first-touch, generic openers, short delays…). Call before every create/update/activate.",
    input: { sequence_id: z.string().optional(), ...graphInput, pool: z.array(z.string()).optional().describe("Sender ids (affects invite-note limits / mailbox checks)"), ai: z.boolean().optional() },
  }, async (a) => {
    let graph: Graph | null = null, pool = a.pool ?? [], compile: Row[] = [], ws: string | null = null, brief: string | null = null;
    if (a.sequence_id) { const s = await loadSequence(ctx, a.sequence_id, "workspace_id, graph, sender_pool, brief"); graph = s.graph; pool = a.pool ?? s.sender_pool ?? []; ws = s.workspace_id; brief = s.brief; }
    else { const g = graphFrom(a); graph = g.graph; compile = g.errors; }
    if (compile.length) return { ok: false, compile_errors: compile, next: "Fix the listed steps and validate again." };
    if (!graph) throw new McpError("E_PAYLOAD_INVALID", "sequence_id, steps, graph or from_template required");
    const v = await validate(ctx, graph, pool, true);
    let ai: Row | undefined;
    if (a.ai) {
      const wsId = ws ?? resolveWs(ctx, undefined).id;
      try { const r = await callFn<Row>(ctx, "ai-sequence-qa", a.sequence_id ? { sequence_id: a.sequence_id } : { graph, workspace_id: wsId, pool, brief }); ai = { available: r.ai_available, warnings: (r.warnings ?? []).filter((w: Row) => String(w.code).startsWith("W_") && !v.warnings.some((x) => x.code === w.code && x.node_id === w.node_id)), errors: r.errors }; }
      catch (e) { ai = { available: false, error: e instanceof Error ? e.message : String(e) }; }
    }
    return { ok: v.errors.length === 0 && !(ai?.errors?.length), errors: v.errors, warnings: v.warnings, ai_qa: ai, rendered: renderGraph(graph) };
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
    description: "Create a sequence (as a draft) from a compact step list, a template, or a graph, with a sender pool and optional brief/settings. Compiles, validates (strict) and saves; returns the id, version, validation result and a readable rendering. Nothing is sent until sequence_activate + enrollments.",
    input: {
      ...wsParam, name: z.string().min(1), ...graphInput,
      pool: z.array(z.string()).optional().describe("Sender ids to send from (required before activation)"),
      brief: z.string().optional().describe("Campaign brief: ICP, offer, tone — used by AI drafting/QA and reply classification"),
      settings: z.object({ stop_on_reply: z.boolean().optional(), withdraw_after_days: z.number().int().min(1).max(60).optional() }).optional(),
      assignment: z.enum(["round_robin", "least_loaded", "fixed"]).optional(), client_id: z.string().optional(),
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
    name: "sequence_update", title: "Update sequence", cls: "write", minRole: "manager",
    description: "Replace the steps/graph and/or change pool, settings, name, brief, assignment. Saves a new version (head). The engine reads the live graph, so leads already enrolled follow the new version from the next node they reach; already-sent touches never change; actions already queued keep their pre-rendered text (use sequence_edit_copy to re-render them). Removing a node that enrollments currently occupy strands them — prefer sequence_edit_copy / sequence_edit_timing for live sequences.",
    input: { sequence_id: z.string(), ...graphInput, pool: z.array(z.string()).optional(), settings: z.record(z.string(), z.unknown()).optional(), name: z.string().optional(), brief: z.string().optional(), assignment: z.enum(["round_robin", "least_loaded", "fixed"]).optional(), allow_warnings: z.boolean().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    const g = graphFrom(a);
    if (g.errors.length) return { updated: false, compile_errors: g.errors };
    const graph = g.graph ?? (s.graph as Graph);
    const pool = a.pool ?? s.sender_pool ?? [];
    const v = await validate(ctx, graph, pool, s.status === "active" || true);
    if (v.errors.length) return { updated: false, errors: v.errors, warnings: v.warnings };
    if (g.graph && v.warnings.length && !a.allow_warnings) return { updated: false, warnings: v.warnings, next: "Call again with allow_warnings:true or fix the steps." };
    let occupied: Row[] = [];
    if (g.graph) {
      const removed = Object.keys(s.graph?.nodes ?? {}).filter((k) => !graph.nodes[k]);
      if (removed.length) { const { data } = await ctx.user.from("outreach_enrollments").select("current_node_id").eq("sequence_id", s.id).in("current_node_id", removed).in("status", ["active", "waiting_connection", "waiting_delay", "waiting_task", "paused"]); occupied = removed.map((n) => ({ node_id: n, live_enrollments: (data ?? []).filter((e: Row) => e.current_node_id === n).length })).filter((x) => x.live_enrollments > 0); }
      if (occupied.length) throw new McpError("E_NODE_OCCUPIED", `removing nodes currently occupied by live enrollments`, "Keep those nodes, or exit/pause the affected enrollments first (enrollments_list with sequence_id).", occupied);
    }
    const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph, p_pool: a.pool ?? null, p_settings: a.settings ?? null, p_name: a.name ?? null, p_brief: a.brief ?? null, p_assignment: a.assignment ?? null });
    return { updated: true, sequence_id: s.id, version, previous_version: s.head_version, graph_changed: !!g.graph, warnings: v.warnings, pool: a.pool ? await poolInfo(ctx, a.pool) : undefined, rendered: g.graph ? renderGraph(graph) : undefined };
  });

  tool(server, ctx, {
    name: "sequence_edit_copy", title: "Edit node copy", cls: "write", minRole: "manager",
    description: "Change the text of one or more nodes (invite note, message, InMail, comment, email) on a live sequence and re-render the already-queued (not yet reserved/sent) actions of those nodes for current lead data. Already-sent touches are never changed. Returns per node: queued actions re-rendered vs skipped_in_flight.",
    input: { sequence_id: z.string(), edits: z.array(z.object({ node_id: z.string(), text: z.string().optional(), subject: z.string().optional() })).min(1).max(20), rerender_queued: z.boolean().optional().describe("Default true") },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    const graph = structuredClone(s.graph) as Graph;
    const report: Row[] = [];
    for (const e of a.edits) {
      const n = graph.nodes[e.node_id];
      if (!n) throw new McpError("E_NOT_FOUND", `node ${e.node_id} not in sequence`);
      const f = nodeTextField(n);
      if (!f) throw new McpError("E_PAYLOAD_INVALID", `node ${e.node_id} (${n.type}) has no editable copy`);
      n.config = { ...(n.config ?? {}) };
      if (e.text !== undefined) n.config[f] = n.type === "send_email" ? e.text.replace(/\n/g, "<br/>") : e.text;
      if (e.subject !== undefined) n.config.subject = e.subject;
      report.push({ node_id: e.node_id, type: n.type, field: f });
    }
    const v = await validate(ctx, graph, s.sender_pool ?? [], true);
    if (v.errors.length) return { updated: false, errors: v.errors };
    const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph });
    if (a.rerender_queued !== false) {
      for (const r of report) {
        const n = graph.nodes[r.node_id];
        const queued = await urpc<Row[]>(ctx, "agent_node_queued_actions", { p_sequence: s.id, p_node_id: r.node_id }).catch(() => []);
        r.queued = queued.length; r.rerendered = 0; r.skipped_in_flight = 0;
        if (!queued.length) continue;
        const leadIds = [...new Set(queued.map((q) => q.lead_id).filter(Boolean))], senderIds = [...new Set(queued.map((q) => q.sender_id))];
        const [{ data: leads }, { data: senders }] = await Promise.all([ctx.user.from("outreach_leads").select("*").in("id", leadIds), ctx.user.from("outreach_senders").select("id, display_name").in("id", senderIds)]);
        const L = new Map((leads ?? []).map((l: Row) => [l.id, l])), S = new Map((senders ?? []).map((x: Row) => [x.id, x]));
        for (const q of queued) {
          const lead = L.get(q.lead_id); if (!lead) { r.skipped_in_flight++; continue; }
          const tpl = String(n.config?.[r.field as string] ?? "");
          const text = renderTemplate(tpl, { lead, sender: S.get(q.sender_id) ?? null });
          const ok = await urpc<boolean>(ctx, "agent_set_action_text", { p_action: q.action_id, p_text: text }).catch(() => false);
          if (ok) r.rerendered++; else r.skipped_in_flight++;
        }
      }
    }
    return { updated: true, version, nodes: report, note: "Sent messages are history and were not touched. Actions reserved by a tick in progress were skipped." };
  });

  tool(server, ctx, {
    name: "sequence_edit_timing", title: "Edit node timing", cls: "write", minRole: "manager",
    description: "Change delays on a live sequence: for a delay node, the wait; for an action node, its per-node `wait` before executing. Enrollments currently waiting in an edited delay node get wait_until recomputed from when they entered it — if the new delay already elapsed they become due now, and the ledger/schedule still meter the actual sends. Actions already queued keep their scheduled time.",
    input: { sequence_id: z.string(), edits: z.array(z.object({ node_id: z.string(), wait: z.string().describe('e.g. "2h", "3d", "0d"') })).min(1).max(20) },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id);
    const graph = structuredClone(s.graph) as Graph;
    const report: Row[] = [];
    for (const e of a.edits) {
      const n = graph.nodes[e.node_id];
      if (!n) throw new McpError("E_NOT_FOUND", `node ${e.node_id} not in sequence`);
      const w = parseWait(e.wait);
      if (!w) throw new McpError("E_PAYLOAD_INVALID", `wait "${e.wait}" must look like 2h / 3d / 30m`);
      if (n.type === "delay") { n.config = { ...(n.config ?? {}), amount: w.amount, unit: w.unit }; report.push({ node_id: e.node_id, kind: "delay_node", wait: e.wait }); }
      else if (n.type === "wait_connection") throw new McpError("E_MIGRATION_UNSAFE", "the wait_connection window is bound to invite_sent_at for leads already waiting", "Edit window_days via sequence_update; it applies to leads that reach the node later.");
      else { n.delay = { amount: w.amount, unit: w.unit, jitter_pct: n.delay?.jitter_pct ?? 20 }; report.push({ node_id: e.node_id, kind: "node_delay", wait: e.wait, note: "applies when enrollments enter this node; queued actions keep their time" }); }
    }
    const v = await validate(ctx, graph, s.sender_pool ?? [], true);
    if (v.errors.length) return { updated: false, errors: v.errors };
    const version = await urpc<number>(ctx, "save_sequence", { p_id: s.id, p_graph: graph });
    for (const r of report) if (r.kind === "delay_node") { const res = await urpc<Row[]>(ctx, "agent_reschedule_delay", { p_sequence: s.id, p_node_id: r.node_id }).catch(() => []); const x = Array.isArray(res) ? res[0] : res; r.rescheduled = x?.rescheduled ?? 0; r.due_now = x?.due_now ?? 0; }
    const proj = await urpc<Row[]>(ctx, "project_sequence", { p_sequence: s.id, p_lead_count: 100 }).catch(() => []);
    return { updated: true, version, nodes: report, new_projection_days_per_100_leads: (Array.isArray(proj) ? proj[0] : proj)?.estimated_days };
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
    if (notOk.length) throw new McpError("E_SENDER_NOT_OK", `pool senders not connected: ${notOk.map((p) => `${p.name} (${p.status})`).join(", ")}`, "Remove them from the pool (sequence_update) or have a human reconnect them.");
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
    description: "Pause a sequence: live enrollments are parked (nothing new is queued; queued actions are held) and resume on the next activate. Safe; prefer this before structural edits.",
    input: { sequence_id: z.string() },
  }, async (a) => { const r = await urpc<Row>(ctx, "set_sequence_status", { p_id: a.sequence_id, p_status: "paused" }); return { status: r?.status ?? "paused" }; });

  tool(server, ctx, {
    name: "sequence_versions", title: "Sequence versions", cls: "read", minRole: "client_viewer",
    description: "Version history of a sequence (version number, created at, node count, executable touches).",
    input: { sequence_id: z.string() },
  }, async (a) => {
    const { data } = await ctx.user.from("outreach_sequence_versions").select("version, created_at, graph").eq("sequence_id", a.sequence_id).order("version", { ascending: false }).limit(30);
    return { versions: (data ?? []).map((v: Row) => ({ version: v.version, created_at: v.created_at, nodes: Object.keys(v.graph?.nodes ?? {}).length, touches: Object.values(v.graph?.nodes ?? {}).filter((n: any) => ["send_invite", "send_message", "send_inmail", "send_email", "comment_latest_post"].includes(n.type)).length })) };
  });

  tool(server, ctx, {
    name: "sequence_restore", title: "Restore version (confirmation required)", cls: "gated", minRole: "manager",
    description: "Re-save an older version's graph as the new head. Two-step confirmation.",
    input: { sequence_id: z.string(), version: z.number().int().min(1), confirmation_token: z.string().optional() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, head_version, status");
    const g = await gate(ctx, "sequence_restore", a as Record<string, unknown>, `Restore "${s.name}" to version ${a.version} (current head v${s.head_version}, status ${s.status}). Live enrollments follow the restored graph from their next node.`, s.workspace_id);
    if (!g.proceed) return g.result;
    const v = await urpc<number>(ctx, "restore_sequence_version", { p_id: s.id, p_version: a.version });
    return { restored_from: a.version, new_version: v };
  });

  tool(server, ctx, {
    name: "sequence_stats", title: "Sequence stats", cls: "read", minRole: "client_viewer",
    description: "Funnel for a sequence: enrollments by status, invites sent → accepted → replied → interested, and per-node sent/failed/skipped/accepted/replied.",
    input: { sequence_id: z.string() },
  }, async (a) => {
    const s = await loadSequence(ctx, a.sequence_id, "id, name, status, graph, workspace_id");
    const [{ data: enr }, { data: ns }] = await Promise.all([
      ctx.user.from("outreach_enrollments").select("status, lead_id").eq("sequence_id", s.id).limit(10000),
      ctx.user.from("outreach_node_stats").select("*").eq("sequence_id", s.id),
    ]);
    const byStatus: Record<string, number> = {};
    for (const e of enr ?? []) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const leadIds = [...new Set((enr ?? []).map((e: Row) => e.lead_id))];
    let interested = 0;
    if (leadIds.length) { const { count } = await ctx.user.from("outreach_chats").select("id", { count: "exact", head: true }).in("lead_id", leadIds.slice(0, 5000)).eq("intent", "interested"); interested = count ?? 0; }
    const nodes = (ns ?? []).map((n: Row) => ({ node_id: n.node_id, type: s.graph?.nodes?.[n.node_id]?.type, sent: n.sent, queued: n.queued, failed: n.failed, skipped: n.skipped, accepted: n.accepted || undefined, replied: n.replied || undefined }));
    const inviteNodes = nodes.filter((n) => n.type === "send_invite"), msgNodes = nodes.filter((n) => ["send_message", "send_inmail", "send_email"].includes(n.type));
    const sum = (arr: Row[], k: string) => arr.reduce((acc, n) => acc + (n[k] ?? 0), 0);
    return {
      sequence: s.name, status: s.status, enrolled_total: (enr ?? []).length, by_status: byStatus,
      funnel: { enrolled: (enr ?? []).length, invites_sent: sum(inviteNodes, "sent"), accepted: sum(inviteNodes, "accepted"), messages_sent: sum(msgNodes, "sent"), replied: byStatus.exited_replied ?? 0, interested },
      nodes,
    };
  });
}

export { roleAtLeast, short };
