// outreach-mcp/tools_enrollments.ts — enrol preview → commit (two gates), enrollment reads and control (PRD §5.4).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { admin } from "../_shared/outreach/supabase.ts";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, randomToken, isoNow, decodeCursor, encodeCursor, chunk } from "./ctx.ts";
import { leadFilterShape, searchLeads, leadsByIds } from "./tools_leads.ts";
import { loadSequence } from "./tools_sequences.ts";

type Row = Record<string, any>;
const LIVE = ["active", "waiting_connection", "waiting_delay", "waiting_task", "paused"];

async function suppressionSets(ctx: Ctx, wsId: string) {
  const { data } = await ctx.user.from("outreach_suppressions").select("kind, value").eq("workspace_id", wsId).limit(10000);
  const sets = { domain: new Set<string>(), email: new Set<string>(), public_identifier: new Set<string>() };
  for (const s of data ?? []) sets[s.kind as keyof typeof sets]?.add(String(s.value).toLowerCase());
  return sets;
}

function isSuppressed(l: Row, sets: Awaited<ReturnType<typeof suppressionSets>>): string | null {
  if (l.do_not_contact) return "do_not_contact";
  if (l.unsubscribed) return "unsubscribed";
  if (l.public_identifier && sets.public_identifier.has(String(l.public_identifier).toLowerCase())) return "suppression_rule:public_identifier";
  for (const e of [l.email_work, l.email_personal].filter(Boolean)) {
    const em = String(e).toLowerCase();
    if (sets.email.has(em)) return "suppression_rule:email";
    const dom = em.split("@")[1];
    if (dom && sets.domain.has(dom)) return "suppression_rule:domain";
  }
  return null;
}

export function registerEnrollments(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "enroll_preview", title: "Preview enrollment (mandatory before commit)", cls: "read", minRole: "member",
    description: "Dry-run an enrollment: which leads are eligible and which are excluded (already live with a pool sender, suppressed, not in workspace), the per-sender split, and the projected completion. Returns a preview_token (15 min) that enroll_commit requires — an agent cannot enrol without seeing the exclusions first. Pick leads by ids (≤1000) or by the same filters as leads_search (≤1000).",
    input: { sequence_id: z.string(), lead_ids: z.array(z.string()).max(1000).optional(), filters: z.object(leadFilterShape).optional(), sender_id: z.string().optional().describe("Force one pool sender instead of the sequence's assignment rule"), max_leads: z.number().int().min(1).max(1000).optional().describe("Cap when using filters (default 200)") },
  }, async (a) => {
    const seq = await loadSequence(ctx, a.sequence_id, "id, name, workspace_id, status, sender_pool, assignment, graph, head_version");
    const ws = resolveWs(ctx, seq.workspace_id); requireRole(ws, "member");
    const pool: string[] = seq.sender_pool ?? [];
    if (!pool.length) throw new McpError("E_POOL_EMPTY", `sequence "${seq.name}" has no senders in its pool`);
    if (a.sender_id && !pool.includes(a.sender_id)) throw new McpError("E_SENDER_NOT_IN_POOL", "sender_id is not in the sequence pool");
    if (!a.lead_ids?.length && !a.filters) throw new McpError("E_PAYLOAD_INVALID", "lead_ids or filters required");

    let candidates: Row[];
    let requested = 0;
    if (a.lead_ids?.length) { requested = a.lead_ids.length; candidates = await leadsByIds(ctx, ws.id, a.lead_ids); }
    else { const r = await searchLeads(ctx, ws, a.filters ?? {}, a.max_leads ?? 200, 0); candidates = r.rows; requested = r.rows.length; }
    const found = new Set(candidates.map((l) => l.id));
    const excluded: Record<string, string[]> = {};
    const ex = (reason: string, id: string) => { (excluded[reason] ??= []).push(id); };
    for (const id of a.lead_ids ?? []) if (!found.has(id)) ex("not_in_workspace", id);

    const { data: senders } = await ctx.user.from("outreach_senders").select("id, display_name, status, health_score, warmup_level").in("id", pool);
    const okSenders = (senders ?? []).filter((s: Row) => s.status === "ok");
    const targetSenders = a.sender_id ? okSenders.filter((s: Row) => s.id === a.sender_id) : okSenders;
    const warnings: string[] = [];
    for (const s of senders ?? []) if (s.status !== "ok") warnings.push(`pool sender "${s.display_name}" is ${s.status} — it will not send until reconnected/resumed`);
    if (seq.status !== "active") warnings.push(`sequence is ${seq.status}: enrolled leads wait at the start node until sequence_activate`);

    const sets = await suppressionSets(ctx, ws.id);
    const live = new Map<string, Set<string>>();
    for (const part of chunk([...found], 200)) {
      const { data } = await ctx.user.from("outreach_enrollments").select("lead_id, sender_id").in("lead_id", part).in("sender_id", pool).in("status", LIVE);
      for (const e of data ?? []) (live.get(e.lead_id) ?? live.set(e.lead_id, new Set()).get(e.lead_id)!).add(e.sender_id);
    }
    const eligible: Row[] = [];
    for (const l of candidates) {
      const sup = isSuppressed(l, sets);
      if (sup) { ex(`suppressed:${sup}`, l.id); continue; }
      const busy = live.get(l.id) ?? new Set();
      const free = targetSenders.filter((s: Row) => !busy.has(s.id));
      if (targetSenders.length === 0) { ex("no_connected_sender_in_pool", l.id); continue; }
      if (free.length === 0) { ex("already_enrolled_with_pool_senders", l.id); continue; }
      eligible.push(l);
    }
    // round-robin estimate over connected senders (the RPC does the real assignment)
    const assignment: Record<string, number> = {};
    targetSenders.forEach((s: Row, i: number) => { assignment[s.display_name] = Math.floor(eligible.length / targetSenders.length) + (i < eligible.length % targetSenders.length ? 1 : 0); });
    const proj = eligible.length ? (await urpc<Row[]>(ctx, "project_sequence", { p_sequence: seq.id, p_lead_count: eligible.length }).catch(() => []))[0] : undefined;

    const token = randomToken();
    const exclusions = Object.fromEntries(Object.entries(excluded).map(([k, v]) => [k, { count: v.length, sample_ids: v.slice(0, 10) }]));
    await admin.from("outreach_agent_previews").insert({ token, user_id: ctx.userId, workspace_id: ws.id, sequence_id: seq.id, lead_ids: eligible.map((l) => l.id), sender_id: a.sender_id ?? null, assignment, excluded: exclusions, expires_at: new Date(Date.now() + 15 * 60_000).toISOString() });
    return {
      sequence: seq.name, sequence_status: seq.status, requested, eligible: eligible.length, excluded: exclusions, assignment_estimate: assignment,
      projection: proj ? { estimated_days: proj.estimated_days, bottleneck: proj.bottleneck } : undefined, warnings,
      sample_eligible: eligible.slice(0, 5).map((l) => ({ id: l.id, name: l.full_name, company: l.company })),
      preview_token: eligible.length ? token : undefined, expires_in_seconds: 900,
      next: eligible.length ? "Show the counts to the human. On approval call enroll_commit(preview_token) — it will ask for one confirmation." : "Nothing to enrol.",
    };
  });

  tool(server, ctx, {
    name: "enroll_commit", title: "Commit enrollment (confirmation required)", cls: "gated", minRole: "member",
    description: "Enrol the exact lead set of a preview_token. Two gates: the preview token (bound to the lead set, 15 min) and a confirmation token (first call returns the effect summary). Idempotent per preview token. The database enforces caps, schedule, suppression and one live enrollment per lead+sender.",
    input: { preview_token: z.string(), priority: z.number().int().min(1).max(1000).optional().describe("Lower = sooner in the planner (default 100)"), confirmation_token: z.string().optional() },
  }, async (a) => {
    const { data: p } = await admin.from("outreach_agent_previews").select("*").eq("token", a.preview_token).maybeSingle();
    if (!p || p.user_id !== ctx.userId) throw new McpError("E_PREVIEW_EXPIRED", "unknown preview token");
    if (p.committed_at) throw new McpError("E_PREVIEW_EXPIRED", "this preview was already committed", "Run enroll_preview again for a new batch.");
    if (new Date(p.expires_at).getTime() < Date.now()) throw new McpError("E_PREVIEW_EXPIRED", "preview expired (15 min)");
    const seq = await loadSequence(ctx, p.sequence_id, "id, name, status, sender_pool, workspace_id");
    const n = (p.lead_ids as string[]).length;
    const summary = `Enrol ${n} lead(s) into "${seq.name}" (${seq.status}) on ${Object.keys(p.assignment ?? {}).length} sender(s): ${Object.entries(p.assignment ?? {}).map(([k, v]) => `${k}: ${v}`).join(", ")}. ${seq.status === "active" ? "First actions go out at the next planner run inside each sender's schedule window, metered by daily caps." : "The sequence is not active; leads wait until it is activated."} Excluded in preview: ${Object.entries(p.excluded ?? {}).map(([k, v]: [string, any]) => `${k} ${v.count}`).join(", ") || "none"}.`;
    const g = await gate(ctx, "enroll_commit", a as Record<string, unknown>, summary, seq.workspace_id);
    if (!g.proceed) return g.result;
    const res = await urpc<Row[]>(ctx, "enroll_leads", { p_sequence: seq.id, p_lead_ids: p.lead_ids, p_sender: p.sender_id ?? null, p_priority: a.priority ?? 100 });
    const r = Array.isArray(res) ? res[0] : res;
    await admin.from("outreach_agent_previews").update({ committed_at: isoNow() }).eq("token", a.preview_token);
    return { enrolled: r?.enrolled ?? 0, skipped_active: r?.skipped_active ?? 0, skipped_suppressed: r?.skipped_suppressed ?? 0, skipped_other: r?.skipped_other ?? 0, sequence_id: seq.id, sequence_status: seq.status, next: seq.status === "active" ? "Use why_not_sending(sequence_id) if nothing goes out within a schedule window." : "Activate with sequence_activate when ready." };
  });

  tool(server, ctx, {
    name: "enrollments_list", title: "List enrollments", cls: "read", minRole: "client_viewer",
    description: "Enrollments filtered by sequence / sender / lead / status (≤100 per page). Status values: active, waiting_connection, waiting_delay, waiting_task, paused, completed, exited_replied, exited_manual, exited_suppressed, exited_sender_disabled, failed, cancelled.",
    input: { sequence_id: z.string().optional(), sender_id: z.string().optional(), lead_id: z.string().optional(), status: z.array(z.string()).optional(), live_only: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().optional() },
  }, async (a) => {
    if (!a.sequence_id && !a.sender_id && !a.lead_id) throw new McpError("E_PAYLOAD_INVALID", "sequence_id, sender_id or lead_id required");
    const limit = a.limit ?? 50, offset = decodeCursor(a.cursor);
    let q = ctx.user.from("outreach_enrollments").select("id, sequence_id, sender_id, lead_id, status, current_node_id, wait_until, exit_reason, created_at, completed_at, outreach_leads(full_name, company), outreach_senders(display_name), outreach_sequences(name)", { count: "exact" }).order("created_at", { ascending: false }).range(offset, offset + limit - 1);
    if (a.sequence_id) q = q.eq("sequence_id", a.sequence_id);
    if (a.sender_id) q = q.eq("sender_id", a.sender_id);
    if (a.lead_id) q = q.eq("lead_id", a.lead_id);
    if (a.status?.length) q = q.in("status", a.status); else if (a.live_only) q = q.in("status", LIVE);
    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    return { total: count, next_cursor: offset + (data?.length ?? 0) < (count ?? 0) ? encodeCursor(offset + (data?.length ?? 0)) : undefined, enrollments: (data ?? []).map((e: Row) => ({ id: e.id, lead_id: e.lead_id, lead: e.outreach_leads?.full_name, company: e.outreach_leads?.company, sender: e.outreach_senders?.display_name, sequence: a.sequence_id ? undefined : e.outreach_sequences?.name, status: e.status, node: e.current_node_id, wait_until: e.wait_until, exit_reason: e.exit_reason, created: e.created_at?.slice(0, 10) })) };
  });

  tool(server, ctx, {
    name: "enrollment_get", title: "Get enrollment", cls: "read", minRole: "client_viewer",
    description: "One enrollment: current node (with its description), wait_until, next scheduled action and time, and the executed action history.",
    input: { enrollment_id: z.string() },
  }, async (a) => {
    const e = unwrap<Row | null>(await ctx.user.from("outreach_enrollments").select("*, outreach_leads(full_name, company, public_identifier), outreach_senders(display_name, status, timezone), outreach_sequences(name, status, graph)").eq("id", a.enrollment_id).maybeSingle());
    if (!e) throw new McpError("E_NOT_FOUND", "enrollment not found");
    const [{ data: next }, { data: hist }] = await Promise.all([
      ctx.user.from("outreach_actions").select("id, action_type, node_id, scheduled_for, status, decision").eq("enrollment_id", e.id).in("status", ["queued", "reserved"]).order("scheduled_for", { ascending: true }).limit(3),
      ctx.user.from("outreach_actions").select("id, action_type, node_id, status, executed_at, error_code, decision").eq("enrollment_id", e.id).not("executed_at", "is", null).order("executed_at", { ascending: false }).limit(20),
    ]);
    const node = e.outreach_sequences?.graph?.nodes?.[e.current_node_id];
    return {
      id: e.id, status: e.status, sequence: e.outreach_sequences?.name, sequence_status: e.outreach_sequences?.status, sequence_id: e.sequence_id, version: e.sequence_version,
      lead: { id: e.lead_id, name: e.outreach_leads?.full_name, company: e.outreach_leads?.company, li: e.outreach_leads?.public_identifier }, sender: { id: e.sender_id, name: e.outreach_senders?.display_name, status: e.outreach_senders?.status },
      current_node: node ? { id: e.current_node_id, type: node.type, entered_at: e.node_entered_at } : { id: e.current_node_id, entered_at: e.node_entered_at }, wait_until: e.wait_until, exit_reason: e.exit_reason, restart_count: e.restart_count || undefined, rotation_count: e.rotation_count || undefined,
      next_actions: next ?? [], history: hist ?? [], created_at: e.created_at, completed_at: e.completed_at,
    };
  });

  for (const op of ["pause", "resume"] as const) {
    tool(server, ctx, {
      name: `enrollment_${op}`, title: `${op[0].toUpperCase()}${op.slice(1)} enrollments`, cls: "write", minRole: "member",
      description: op === "pause" ? "Pause up to 100 live enrollments (they keep their position; queued actions are held)." : "Resume up to 100 paused enrollments at their previous status.",
      input: { enrollment_ids: z.array(z.string()).min(1).max(100), reason: z.string().optional() },
    }, async (a) => {
      const results: Row[] = [];
      for (const id of a.enrollment_ids) { try { await urpc(ctx, `${op}_enrollment`, { p_id: id }); results.push({ id, ok: true }); } catch (e) { results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) }); } }
      return { [op === "pause" ? "paused" : "resumed"]: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok) };
    });
  }

  tool(server, ctx, {
    name: "enrollment_exit", title: "Exit enrollments (confirmation required)", cls: "gated", minRole: "member",
    description: "DESTRUCTIVE. Exit up to 100 enrollments (status exited_manual; queued actions cancelled). Two-step confirmation.",
    input: { enrollment_ids: z.array(z.string()).min(1).max(100), reason: z.string().min(2), confirmation_token: z.string().optional() },
    annotations: { destructiveHint: true },
  }, async (a) => {
    const { data: rows } = await ctx.user.from("outreach_enrollments").select("id, status, workspace_id, outreach_sequences(name)").in("id", a.enrollment_ids);
    const live = (rows ?? []).filter((r: Row) => LIVE.includes(r.status));
    const g = await gate(ctx, "enrollment_exit", a as Record<string, unknown>, `Exit ${live.length} live enrollment(s) (of ${a.enrollment_ids.length} given) across ${[...new Set(live.map((r: Row) => r.outreach_sequences?.name))].join(", ") || "-"} — reason: ${a.reason}. Their queued actions are cancelled; the leads keep their history and can be re-enrolled later.`, rows?.[0]?.workspace_id ?? null);
    if (!g.proceed) return g.result;
    const results: Row[] = [];
    for (const r of live) { try { await urpc(ctx, "exit_enrollment", { p_id: r.id, p_reason: `agent:${a.reason}`.slice(0, 80) }); results.push({ id: r.id, ok: true }); } catch (e) { results.push({ id: r.id, ok: false, error: e instanceof Error ? e.message : String(e) }); } }
    return { exited: results.filter((r) => r.ok).length, not_live: a.enrollment_ids.length - live.length, failed: results.filter((r) => !r.ok) };
  });
}
