// outreach-mcp/tools_diag.ts — workspace context, dashboard, why_not_sending and open alerts (PRD §5.8).
//
// The diagnosis lives in the database (outreach_why_not_sending, migration 013) so the
// health worker, the "Why isn't this sending?" button in the app and this connector all
// say the same sentence. Nothing is diagnosed in TypeScript here.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, type Membership, tool, z, wsParam, resolveWs, urpc, unwrap, McpError } from "./ctx.ts";

type Row = Record<string, any>;

export async function workspaceContext(ctx: Ctx, ws: Membership) {
  const [{ data: clients }, { data: stages }, { data: tags }, { data: lists }, members] = await Promise.all([
    ctx.user.from("outreach_clients").select("id, name, timezone").eq("workspace_id", ws.id).order("name"),
    ctx.user.from("outreach_stages").select("id, name, position").eq("workspace_id", ws.id).order("position"),
    ctx.user.from("outreach_tags").select("id, name").eq("workspace_id", ws.id).order("name"),
    ctx.user.from("outreach_lists").select("id, name, client_id").eq("workspace_id", ws.id).order("name"),
    urpc<Row[]>(ctx, "workspace_members", { p_ws: ws.id }).catch(() => null),
  ]);
  return {
    workspace: { id: ws.id, name: ws.name, slug: ws.slug, plan: ws.plan, settings: ws.settings },
    you: { user_id: ctx.userId, email: ctx.email, role: ws.role, can_reply: ws.can_reply, client_scope: ws.client_ids.length ? ws.client_ids : "all" },
    clients: clients ?? [], stages: stages ?? [], tags: tags ?? [], lists: lists ?? [],
    members: members ? members.map((m) => ({ user_id: m.user_id, email: m.email, name: m.display_name, role: m.role })) : undefined,
    other_workspaces: ctx.memberships.filter((m) => m.id !== ws.id).map((m) => ({ id: m.id, name: m.name, role: m.role })),
  };
}

const ATTENTION_NEXT: Record<string, string> = {
  sender: "A human reconnects or resumes the sender in the app; why_not_sending(sender_id) has the detail.",
  sequence: "The pool cannot keep up with demand (throttled): add a healthy sender or accept the longer projection.",
  sequence_stalled: "An active sequence with live leads sent nothing in a full working window and has nothing planned: why_not_sending(sequence_id) gives the reason.",
  sender_running_dry: "The sender has under two days of new leads queued: enrol more leads or add an auto-enrol rule (auto_enroll_rules_save).",
  import_failed: "An import stopped with an error: import_status(job_id) shows it.",
  held_leads: "Leads replied and are held for review: enrollment_hold_list(sequence_id), then resume or exit each one after the human decides.",
  failed_leads: "Failed leads need a decision: enrollments_failed(sequence_id), then enrollment_recover (retry, skip or exit).",
  ai_review: "AI-written lines wait for a person: ai_review_list, show the lines, approve only what the human approves.",
};

export function registerDiag(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "workspace_context", title: "Workspace context", cls: "read", minRole: "client_viewer",
    description: "Start here: your workspaces and role, and for the selected one its clients, pipeline stages, tags, lists and members (ids you need for other tools).",
    input: { ...wsParam },
  }, async (a) => {
    if (!a.workspace_id && ctx.memberships.length !== 1) return { workspaces: ctx.memberships.map((m) => ({ id: m.id, name: m.name, slug: m.slug, role: m.role, plan: m.plan })), next: ctx.memberships.length ? "Pass workspace_id to every tool (or ask the user which workspace)." : "No workspace yet: open /outreach in the app once to create one." };
    return await workspaceContext(ctx, resolveWs(ctx, a.workspace_id));
  });

  tool(server, ctx, {
    name: "dashboard", title: "Dashboard", cls: "read", minRole: "client_viewer",
    description: "The app's dashboard, from the same database function the app calls: senders with today's usage and a running_dry flag; `today` and `last_7_days` (full totals objects with the same keys and formulas as report_overview, so the numbers always match); unread / replies_awaiting, tasks_open, drafts_awaiting, ai_lines_awaiting, enrollments_live, sent_today, queued_today, leads_total; and `attention`, a list of {kind, id, label, reason, next}. Attention kinds: sender (disconnected, paused, invites blocked), sequence (throttled), sequence_stalled (active, live leads, nothing sent in a full working window and nothing planned), sender_running_dry (under 2 days of new leads queued), import_failed, held_leads (replied, held for review), failed_leads (need retry / skip / exit), ai_review (AI lines waiting for a person). stats_7d is a legacy copy of last_7_days.",
    input: { ...wsParam },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const d = await urpc<Row>(ctx, "dashboard", { p_ws: ws.id });
    const { stats_7d: _legacy, ...rest } = d;
    return {
      workspace: ws.name, ...rest,
      attention: (d.attention ?? []).map((x: Row) => ({ ...x, next: ATTENTION_NEXT[x.kind] })),
      senders: (d.senders ?? []).map((s: Row) => ({ id: s.id, name: s.display_name, status: s.status, reason: s.status_reason, health: s.health_score, level: s.warmup_level, running_dry: s.running_dry || undefined, today: Object.fromEntries(Object.entries(s.today ?? {}).filter(([, v]: [string, any]) => v.cap > 0 || v.used > 0).map(([k, v]: [string, any]) => [k, `${v.used}/${v.cap}`])) })),
    };
  });

  tool(server, ctx, {
    name: "why_not_sending", title: "Why is nothing sending?", cls: "read", minRole: "client_viewer",
    description: "Diagnose a sequence, a sender or one enrollment with the platform's own diagnosis (the same one behind the app's \"Why isn't this sending?\" button and the stall alerts). Returns target, blocked, reason (one plain sentence you can quote), causes [{code, blocking, detail, remedy, sender, sender_id, next_capacity, partial}] and notes. blocking:true stops sending; partial:true means one sender of several is blocked while the sequence keeps sending through the others; W_ codes only explain timing. Call this BEFORE concluding something is broken: the usual answer is an allowance, working hours, warm-up or health, none of which may be worked around.",
    input: { sequence_id: z.string().optional(), sender_id: z.string().optional(), enrollment_id: z.string().optional() },
  }, async (a) => {
    if (!a.sequence_id && !a.sender_id && !a.enrollment_id) throw new McpError("E_PAYLOAD_INVALID", "sequence_id, sender_id or enrollment_id required");
    return await urpc<Row>(ctx, "why_not_sending", { p_sequence: a.sequence_id ?? null, p_sender: a.sender_id ?? null, p_enrollment: a.enrollment_id ?? null });
  });

  tool(server, ctx, {
    name: "alerts_list", title: "Open alerts", cls: "read", minRole: "client_viewer",
    description: "Alerts the platform raised on its own: sequence_stalled, sender_running_dry, import_failed, hold_expiring. Each has the entity, a label, the plain reason (the same sentence why_not_sending gives) and when it opened. Open alerts only by default; an alert closes by itself when the cause is gone, and owners and managers were already emailed once per occurrence. include_resolved adds the recent history.",
    input: { ...wsParam, kind: z.enum(["sequence_stalled", "sender_running_dry", "import_failed", "hold_expiring"]).optional(), include_resolved: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_alerts").select("id, kind, entity, entity_id, client_id, label, reason, detail, opened_at, notified_at, resolved_at").eq("workspace_id", ws.id).order("opened_at", { ascending: false }).limit(a.limit ?? 50);
    if (!a.include_resolved) q = q.is("resolved_at", null);
    if (a.kind) q = q.eq("kind", a.kind);
    const rows = unwrap<Row[]>(await q);
    return {
      workspace: ws.name, count: rows.length,
      alerts: rows.map((r) => ({ id: r.id, kind: r.kind, entity: r.entity, entity_id: r.entity_id, label: r.label, reason: r.reason, detail: Object.keys(r.detail ?? {}).length ? r.detail : undefined, opened_at: r.opened_at, emailed: r.notified_at ? true : undefined, resolved_at: r.resolved_at })),
      next: rows.length ? "For a stalled sequence or a sender, why_not_sending gives the current causes and remedies. Never answer an alert by raising volume elsewhere." : "No open alerts.",
    };
  });
}
