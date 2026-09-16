// outreach-mcp/tools_tasks_reports.ts — tasks (PRD §5.6) and reporting (PRD §5.7).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, callFn, untrusted, periodSchema, period, short } from "./ctx.ts";

type Row = Record<string, any>;
const pct = (a: number, b: number) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);

/** Sent/failed actions in a period (≤10k rows, aggregated in code). */
async function actionsIn(ctx: Ctx, wsId: string, p: { from: string; to: string }, extra?: (q: any) => any): Promise<{ rows: Row[]; truncated: boolean }> {
  let q = ctx.user.from("outreach_actions").select("action_type, status, sender_id, node_id, enrollment_id, error_code, executed_at").eq("workspace_id", wsId).gte("executed_at", p.from).lte("executed_at", p.to).in("status", ["sent", "failed", "skipped"]).limit(10000);
  if (extra) q = extra(q);
  const rows = unwrap<Row[]>(await q);
  return { rows, truncated: rows.length >= 10000 };
}

function countBy(rows: Row[], key: string, filter?: (r: Row) => boolean): Record<string, number> {
  const o: Record<string, number> = {};
  for (const r of rows) { if (filter && !filter(r)) continue; const k = String(r[key] ?? "unknown"); o[k] = (o[k] ?? 0) + 1; }
  return o;
}

export function registerTasksReports(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------------- tasks
  tool(server, ctx, {
    name: "tasks_list", title: "List tasks", cls: "read", minRole: "client_viewer",
    description: "Open (default) or completed tasks: follow_up (created from interested/question replies), review_ai_draft (AI copy awaiting approval), manual_node, reconnect. Filter by kind, assignee ('me'), lead.",
    input: { ...wsParam, open: z.boolean().optional(), kind: z.enum(["manual_node", "follow_up", "review_ai_draft", "reconnect"]).optional(), assigned_to: z.string().optional(), lead_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_tasks").select("id, kind, title, due_at, assigned_to, lead_id, sender_id, chat_id, enrollment_id, node_id, created_at, completed_at, outreach_leads(full_name, company), outreach_senders(display_name)").eq("workspace_id", ws.id).order("due_at", { ascending: true, nullsFirst: false }).limit(a.limit ?? 50);
    q = a.open === false ? q.not("completed_at", "is", null) : q.is("completed_at", null);
    if (a.kind) q = q.eq("kind", a.kind);
    if (a.assigned_to) q = q.eq("assigned_to", a.assigned_to === "me" ? ctx.userId : a.assigned_to);
    if (a.lead_id) q = q.eq("lead_id", a.lead_id);
    const rows = unwrap<Row[]>(await q);
    return { workspace: ws.name, count: rows.length, tasks: rows.map((t) => ({ id: t.id, kind: t.kind, title: short(t.title, 100), due_at: t.due_at, assigned_to: t.assigned_to, lead_id: t.lead_id, lead: t.outreach_leads?.full_name, company: t.outreach_leads?.company, sender: t.outreach_senders?.display_name, chat_id: t.chat_id, enrollment_id: t.enrollment_id, completed_at: t.completed_at })) };
  });

  tool(server, ctx, {
    name: "task_get", title: "Get task", cls: "read", minRole: "client_viewer",
    description: "One task in full, including the AI draft awaiting review (review_ai_draft) and the node it belongs to.",
    input: { task_id: z.string() },
  }, async (a) => {
    const t = unwrap<Row | null>(await ctx.user.from("outreach_tasks").select("*, outreach_leads(full_name, company, headline), outreach_senders(display_name, is_premium)").eq("id", a.task_id).maybeSingle());
    if (!t) throw new McpError("E_NOT_FOUND", "task not found");
    return { id: t.id, kind: t.kind, title: t.title, body: t.body, due_at: t.due_at, assigned_to: t.assigned_to, lead: t.lead_id ? { id: t.lead_id, name: t.outreach_leads?.full_name, company: t.outreach_leads?.company, headline: untrusted("linkedin_profile", t.outreach_leads?.headline, 200) } : undefined, sender: t.sender_id ? { id: t.sender_id, name: t.outreach_senders?.display_name, premium: t.outreach_senders?.is_premium } : undefined, chat_id: t.chat_id, enrollment_id: t.enrollment_id, node_id: t.node_id, draft_kind: t.draft_kind, ai_draft: t.ai_draft, result: t.result, completed_at: t.completed_at, completed_by: t.completed_by, created_at: t.created_at, note: t.kind === "review_ai_draft" && !t.completed_at ? "Approve with task_complete(decision:'approve', result_text: <edited or omitted to send the ai_draft as is>) or reject with decision:'reject'. Approval queues the real action through the normal budget path." : undefined };
  });

  tool(server, ctx, {
    name: "task_create", title: "Create task", cls: "write", minRole: "member",
    description: "Create a follow_up task (e.g. from triage) optionally linked to a lead / chat, with due date and assignee ('me' or user id).",
    input: { ...wsParam, title: z.string().min(1), body: z.string().optional(), lead_id: z.string().optional(), chat_id: z.string().optional(), sender_id: z.string().optional(), client_id: z.string().optional(), due_at: z.string().optional().describe("ISO date/time"), assigned_to: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id); requireRole(ws, "member");
    const ins = await ctx.user.from("outreach_tasks").insert({ workspace_id: ws.id, kind: "follow_up", title: a.title, body: a.body ?? null, lead_id: a.lead_id ?? null, chat_id: a.chat_id ?? null, sender_id: a.sender_id ?? null, client_id: a.client_id ?? null, due_at: a.due_at ?? null, assigned_to: a.assigned_to === "me" ? ctx.userId : a.assigned_to ?? null }).select("id").single();
    if (ins.error) throw new Error(ins.error.message);
    return { task_id: ins.data.id };
  });

  tool(server, ctx, {
    name: "task_complete", title: "Complete task", cls: "write", minRole: "member",
    description: "Complete a task. For review_ai_draft: decision 'approve' queues the real invite/message/comment with result_text (or the stored ai_draft when omitted) through the normal budget + schedule path; 'reject' skips that node. For manual_node the enrollment continues (result_text overrides the node's copy). Idempotent.",
    input: { task_id: z.string(), result_text: z.string().max(8000).optional(), decision: z.enum(["approve", "reject"]).optional() },
  }, async (a) => {
    const { data: t } = await ctx.user.from("outreach_tasks").select("id, kind, completed_at, ai_draft").eq("id", a.task_id).maybeSingle();
    if (!t) throw new McpError("E_NOT_FOUND", "task not found");
    if (t.completed_at) return { task_id: t.id, already_completed_at: t.completed_at };
    if (t.kind === "review_ai_draft" && a.decision === "reject") { await urpc(ctx, "complete_task", { p_id: t.id, p_text: null, p_result: { decision: "reject", by: "agent" } }); return { task_id: t.id, completed: true, decision: "reject", effect: "node skipped; enrollment advanced" }; }
    if (t.kind === "review_ai_draft" && !a.result_text && !t.ai_draft) throw new McpError("E_PAYLOAD_INVALID", "no AI draft on this task yet — pass result_text");
    await urpc(ctx, "complete_task", { p_id: t.id, p_text: a.result_text?.trim() || null, p_result: null });
    return { task_id: t.id, completed: true, kind: t.kind, effect: t.kind === "review_ai_draft" ? "real action queued (subject to caps and schedule)" : t.kind === "manual_node" ? "enrollment continues" : "closed" };
  });

  // ---------------------------------------------------------------- reports
  tool(server, ctx, {
    name: "report_overview", title: "Workspace overview report", cls: "read", minRole: "client_viewer",
    description: "Workspace numbers for a period: senders by status and health band, actions sent by type, acceptance and reply rates, interested count, live enrollments, top sequences — plus a one-paragraph plain-language summary you can quote.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period);
    const [{ data: senders }, acts, { count: replies }, { count: interested }, dash] = await Promise.all([
      (() => { let q = ctx.user.from("outreach_senders").select("id, display_name, status, health_score, client_id").eq("workspace_id", ws.id).is("deleted_at", null); if (a.client_id) q = q.eq("client_id", a.client_id); return q; })(),
      actionsIn(ctx, ws.id, p),
      ctx.user.from("outreach_messages").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("direction", "in").gte("sent_at", p.from).lte("sent_at", p.to),
      (() => { let q = ctx.user.from("outreach_chats").select("id", { count: "exact", head: true }).eq("workspace_id", ws.id).eq("intent", "interested").gte("last_message_at", p.from).lte("last_message_at", p.to); if (a.client_id) q = q.eq("client_id", a.client_id); return q; })(),
      urpc<Row>(ctx, "dashboard", { p_ws: ws.id }).catch((): Row => ({})),
    ]);
    const senderIds = new Set((senders ?? []).map((s: Row) => s.id));
    const rows = a.client_id ? acts.rows.filter((r) => senderIds.has(r.sender_id)) : acts.rows;
    const sent = rows.filter((r) => r.status === "sent");
    const byType = countBy(sent, "action_type");
    const failedBy = countBy(rows.filter((r) => r.status === "failed"), "error_code");
    const { count: accepted } = await ctx.user.from("outreach_lead_sender_state").select("lead_id", { count: "exact", head: true }).in("sender_id", [...senderIds].slice(0, 200)).gte("invite_accepted_at", p.from).lte("invite_accepted_at", p.to);
    const invites = byType.invite ?? 0, messages = (byType.message ?? 0) + (byType.inmail ?? 0) + (byType.email ?? 0);
    const health = { healthy_85_plus: 0, ok_70_84: 0, reduced_50_69: 0, paused_below_50: 0 };
    for (const s of senders ?? []) { const h = s.health_score; if (h >= 85) health.healthy_85_plus++; else if (h >= 70) health.ok_70_84++; else if (h >= 50) health.reduced_50_69++; else health.paused_below_50++; }
    const summary = await urpc<Row[]>(ctx, "sequence_summary", { p_ws: ws.id }).catch(() => []);
    const { data: seqs } = await ctx.user.from("outreach_sequences").select("id, name, status, client_id").eq("workspace_id", ws.id).neq("status", "archived");
    const top = (summary ?? []).map((s: Row): Row => ({ ...s, seq: (seqs ?? []).find((x: Row) => x.id === s.sequence_id) })).filter((s: Row) => s.seq && (!a.client_id || s.seq.client_id === a.client_id)).sort((x: Row, y: Row) => (y.replied ?? 0) - (x.replied ?? 0) || (y.sent ?? 0) - (x.sent ?? 0)).slice(0, 5).map((s: Row) => ({ id: s.sequence_id, name: s.seq.name, status: s.seq.status, live: s.live, sent: s.sent, replied: s.replied }));
    const text = `Over ${p.label}, ${senders?.length ?? 0} sender(s) (${countBy(senders ?? [], "status").ok ?? 0} connected) sent ${invites} invitation(s) and ${messages} message(s); ${accepted ?? 0} invitation(s) were accepted (${pct(accepted ?? 0, invites) ?? "n/a"}%), ${replies ?? 0} repl${replies === 1 ? "y" : "ies"} came in (${pct(replies ?? 0, messages) ?? "n/a"}% of messages) and ${interested ?? 0} thread(s) are classified interested. ${health.paused_below_50 + health.reduced_50_69 > 0 ? `${health.paused_below_50 + health.reduced_50_69} sender(s) run at reduced or zero capacity because of health.` : "All senders are at full capacity."}${acts.truncated ? " (Action counts are capped at 10,000 rows — use report_export for exact totals.)" : ""}`;
    return { workspace: ws.name, period: p.label, senders: { total: senders?.length ?? 0, by_status: countBy(senders ?? [], "status"), health }, actions_sent: byType, failures_by_code: Object.keys(failedBy).length ? failedBy : undefined, rates: { acceptance_pct: pct(accepted ?? 0, invites), reply_pct: pct(replies ?? 0, messages) }, accepted: accepted ?? 0, replies: replies ?? 0, interested: interested ?? 0, live_enrollments: dash.enrollments_live, replies_awaiting: dash.replies_awaiting, tasks_open: dash.tasks_open, top_sequences: top, summary: text };
  });

  tool(server, ctx, {
    name: "report_client", title: "Client report", cls: "read", minRole: "client_viewer",
    description: "Client-facing numbers for one client (agency model): leads, senders, touches, connections, replies, interested, live enrollments — 30-day stats from the platform plus period counts and a quotable summary.",
    input: { client_id: z.string(), period: periodSchema },
  }, async (a) => {
    const stats = await urpc<Row>(ctx, "client_stats", { p_client: a.client_id });
    const { data: client } = await ctx.user.from("outreach_clients").select("id, name, workspace_id").eq("id", a.client_id).maybeSingle();
    if (!client) throw new McpError("E_NOT_FOUND", "client not found");
    const p = period(a.period);
    const { data: senders } = await ctx.user.from("outreach_senders").select("id, display_name, status, health_score").eq("client_id", a.client_id).is("deleted_at", null);
    const ids = (senders ?? []).map((s: Row) => s.id);
    const acts = ids.length ? await actionsIn(ctx, client.workspace_id, p, (q) => q.in("sender_id", ids)) : { rows: [], truncated: false };
    const sent = countBy(acts.rows.filter((r) => r.status === "sent"), "action_type");
    const [{ count: accepted }, { count: replies }, { count: interested }] = await Promise.all([
      ids.length ? ctx.user.from("outreach_lead_sender_state").select("lead_id", { count: "exact", head: true }).in("sender_id", ids).gte("invite_accepted_at", p.from).lte("invite_accepted_at", p.to) : Promise.resolve({ count: 0 }),
      ctx.user.from("outreach_messages").select("id, outreach_chats!inner(client_id)", { count: "exact", head: true }).eq("outreach_chats.client_id", a.client_id).eq("direction", "in").gte("sent_at", p.from).lte("sent_at", p.to),
      ctx.user.from("outreach_chats").select("id", { count: "exact", head: true }).eq("client_id", a.client_id).eq("intent", "interested").gte("last_message_at", p.from).lte("last_message_at", p.to),
    ]);
    const invites = sent.invite ?? 0, messages = (sent.message ?? 0) + (sent.inmail ?? 0) + (sent.email ?? 0);
    return {
      client: client.name, period: p.label, senders: (senders ?? []).map((s: Row) => ({ name: s.display_name, status: s.status, health: s.health_score })),
      period_counts: { invites, accepted: accepted ?? 0, acceptance_pct: pct(accepted ?? 0, invites), messages, replies: replies ?? 0, reply_pct: pct(replies ?? 0, messages), interested: interested ?? 0, profile_views: sent.profile_view ?? 0 },
      last_30_days: stats,
      summary: `For ${client.name} over ${p.label}: ${invites} invitation(s) sent, ${accepted ?? 0} accepted (${pct(accepted ?? 0, invites) ?? "n/a"}%), ${messages} message(s) sent, ${replies ?? 0} repl${replies === 1 ? "y" : "ies"} (${pct(replies ?? 0, messages) ?? "n/a"}%), ${interested ?? 0} interested conversation(s). ${stats?.enrollments_live ?? 0} lead(s) are currently in sequences across ${senders?.length ?? 0} sender(s).`,
    };
  });

  tool(server, ctx, {
    name: "report_sequence", title: "Sequence report", cls: "read", minRole: "client_viewer",
    description: "Per-sequence performance over a period: enrollments started, actions sent/failed/skipped per node, exits by reason, replied and interested counts.",
    input: { sequence_id: z.string(), period: periodSchema },
  }, async (a) => {
    const { data: s } = await ctx.user.from("outreach_sequences").select("id, name, status, workspace_id, graph").eq("id", a.sequence_id).maybeSingle();
    if (!s) throw new McpError("E_NOT_FOUND", "sequence not found");
    const p = period(a.period);
    const [{ data: enr }, { data: exits }] = await Promise.all([
      ctx.user.from("outreach_enrollments").select("id, lead_id, status, created_at").eq("sequence_id", s.id).gte("created_at", p.from).lte("created_at", p.to).limit(10000),
      ctx.user.from("outreach_enrollments").select("status, exit_reason").eq("sequence_id", s.id).gte("completed_at", p.from).lte("completed_at", p.to).limit(10000),
    ]);
    const { data: enrAll } = await ctx.user.from("outreach_enrollments").select("id").eq("sequence_id", s.id).limit(10000);
    const enrIds = (enrAll ?? []).map((e: Row) => e.id);
    const acts = enrIds.length ? await actionsIn(ctx, s.workspace_id, p, (q) => q.in("enrollment_id", enrIds.slice(0, 1000))) : { rows: [], truncated: false };
    const perNode: Record<string, Row> = {};
    for (const r of acts.rows) { const n = (perNode[r.node_id ?? "?"] ??= { node_id: r.node_id, type: s.graph?.nodes?.[r.node_id]?.type, sent: 0, failed: 0, skipped: 0 }); n[r.status] = (n[r.status] ?? 0) + 1; }
    const leadIds = [...new Set((enr ?? []).map((e: Row) => e.lead_id))];
    const { count: interested } = leadIds.length ? await ctx.user.from("outreach_chats").select("id", { count: "exact", head: true }).in("lead_id", leadIds.slice(0, 5000)).eq("intent", "interested") : { count: 0 };
    return { sequence: s.name, status: s.status, period: p.label, enrollments_started: (enr ?? []).length, exits_by_status: countBy(exits ?? [], "status"), exit_reasons: countBy(exits ?? [], "exit_reason"), replied: (exits ?? []).filter((e: Row) => e.status === "exited_replied").length, interested: interested ?? 0, per_node: Object.values(perNode), note: enrIds.length > 1000 ? "per_node covers the first 1000 enrollments" : undefined };
  });

  tool(server, ctx, {
    name: "report_sender", title: "Sender report", cls: "read", minRole: "client_viewer",
    description: "One sender over a period: volumes by action type, failures/rejects by code, health trend, status events, current caps.",
    input: { sender_id: z.string(), period: periodSchema },
  }, async (a) => {
    const { data: s } = await ctx.user.from("outreach_senders").select("id, display_name, status, health_score, warmup_level, workspace_id").eq("id", a.sender_id).maybeSingle();
    if (!s) throw new McpError("E_NOT_FOUND", "sender not found");
    const p = period(a.period);
    const [acts, { data: ev }, { count: replies }, { count: accepted }] = await Promise.all([
      actionsIn(ctx, s.workspace_id, p, (q) => q.eq("sender_id", s.id)),
      ctx.user.from("outreach_sender_events").select("kind, data, at").eq("sender_id", s.id).gte("at", p.from).lte("at", p.to).order("at", { ascending: false }).limit(200),
      ctx.user.from("outreach_messages").select("id, outreach_chats!inner(sender_id)", { count: "exact", head: true }).eq("outreach_chats.sender_id", s.id).eq("direction", "in").gte("sent_at", p.from).lte("sent_at", p.to),
      ctx.user.from("outreach_lead_sender_state").select("lead_id", { count: "exact", head: true }).eq("sender_id", s.id).gte("invite_accepted_at", p.from).lte("invite_accepted_at", p.to),
    ]);
    const sent = countBy(acts.rows.filter((r) => r.status === "sent"), "action_type");
    const failed = countBy(acts.rows.filter((r) => r.status === "failed"), "error_code");
    const health = (ev ?? []).filter((e: Row) => e.kind === "health").map((e: Row) => ({ at: e.at.slice(0, 10), score: e.data?.score })).filter((x) => typeof x.score === "number");
    const statusEv = (ev ?? []).filter((e: Row) => ["status", "reject", "checkpoint", "reconnect", "warmup"].includes(e.kind)).slice(0, 20).map((e: Row) => ({ at: e.at, kind: e.kind, ...e.data }));
    return { sender: s.display_name, status: s.status, health: s.health_score, level: s.warmup_level, period: p.label, sent, accepted: accepted ?? 0, acceptance_pct: pct(accepted ?? 0, sent.invite ?? 0), replies: replies ?? 0, failures_by_code: failed, rejects: acts.rows.filter((r) => /^(429|5\d\d):/.test(r.error_code ?? "")).length, health_trend: health, events: statusEv };
  });

  tool(server, ctx, {
    name: "report_deliverability", title: "Email deliverability", cls: "read", minRole: "client_viewer",
    description: "Email channel over a period: sent, opens, clicks, bounces per mailbox sender.",
    input: { ...wsParam, period: periodSchema },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period);
    const { data: boxes } = await ctx.user.from("outreach_senders").select("id, display_name, provider, status").eq("workspace_id", ws.id).in("provider", ["GMAIL", "OUTLOOK", "IMAP"]).is("deleted_at", null);
    if (!boxes?.length) return { workspace: ws.name, period: p.label, mailboxes: [], note: "No mailbox senders connected." };
    const out: Row[] = [];
    for (const b of boxes) {
      const [{ data: msgs }, { count: bounced }] = await Promise.all([
        ctx.user.from("outreach_messages").select("opens, clicks, outreach_chats!inner(sender_id)").eq("outreach_chats.sender_id", b.id).eq("direction", "out").gte("sent_at", p.from).lte("sent_at", p.to).limit(10000),
        ctx.user.from("outreach_lead_sender_state").select("lead_id", { count: "exact", head: true }).eq("sender_id", b.id).eq("email_bounced", true).gte("updated_at", p.from),
      ]);
      const sent = msgs?.length ?? 0, opened = (msgs ?? []).filter((m: Row) => m.opens > 0).length, clicked = (msgs ?? []).filter((m: Row) => m.clicks > 0).length;
      out.push({ mailbox: b.display_name, provider: b.provider, status: b.status, sent, opened, open_pct: pct(opened, sent), clicked, click_pct: pct(clicked, sent), bounced: bounced ?? 0, bounce_pct: pct(bounced ?? 0, sent) });
    }
    return { workspace: ws.name, period: p.label, mailboxes: out };
  });

  tool(server, ctx, {
    name: "report_export", title: "Export CSV (confirmation required)", cls: "gated", minRole: "manager",
    description: "Export leads | messages | actions | audit of a workspace as CSV to private storage and return a signed URL (1 h). Two-step confirmation (the export contains personal data).",
    input: { ...wsParam, kind: z.enum(["leads", "messages", "actions", "audit"]), client_id: z.string().optional(), confirmation_token: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id); requireRole(ws, "manager");
    const g = await gate(ctx, "report_export", a as Record<string, unknown>, `Export all ${a.kind}${a.client_id ? ` of client ${a.client_id}` : ""} from "${ws.name}" as CSV (personal data) to a private bucket; a signed download link valid for 1 hour is returned to this conversation.`, ws.id);
    if (!g.proceed) return g.result;
    const r = await callFn<Row>(ctx, "exports-create", { workspace_id: ws.id, kind: a.kind, client_id: a.client_id ?? null });
    return { url: r.url, rows: r.rows, expires_in_seconds: 3600, path: r.path };
  });
}
