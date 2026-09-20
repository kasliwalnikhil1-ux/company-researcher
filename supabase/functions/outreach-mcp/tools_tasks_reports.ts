// outreach-mcp/tools_tasks_reports.ts — tasks (PRD §5.6) and reporting (PRD §5.7).
//
// Reporting rule (product plan item 2, "one source of numbers"): every figure a report
// tool returns comes from an outreach_report_* / outreach_dashboard SQL function, the
// same ones the dashboard, the Reports page and the public API call. This file never
// counts rows, never divides, never re-derives a rate. The `summary` strings only
// quote values that are already in the RPC result.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, type Membership, tool, z, wsParam, resolveWs, requireRole, urpc, unwrap, McpError, gate, callFn, untrusted, periodSchema, period, wsTz, short } from "./ctx.ts";

type Row = Record<string, any>;

const pctText = (v: unknown) => (v === null || v === undefined ? "n/a" : `${v}%`);
const plural = (n: unknown, one: string, many: string) => `${n ?? 0} ${Number(n) === 1 ? one : many}`;

/** One quotable sentence built ONLY from a totals object returned by the database. */
function totalsSentence(t: Row | null | undefined): string {
  if (!t) return "No activity in this period.";
  return `${plural(t.invites, "invitation", "invitations")} sent and ${t.accepted ?? 0} accepted (acceptance rate ${pctText(t.acceptance_rate)}); ${plural(t.touches, "touch", "touches")} (${t.messages ?? 0} messages, ${t.inmails ?? 0} InMails, ${t.emails ?? 0} emails, ${t.invites_with_note ?? 0} invitations with a note) brought ${plural(t.replies, "reply", "replies")} (reply rate ${pctText(t.reply_rate)}), of which ${t.interested ?? 0} interested (positive reply rate ${pctText(t.positive_reply_rate)}, negative ${pctText(t.negative_reply_rate)}); ${plural(t.meetings, "meeting", "meetings")}, ${t.won ?? 0} won.`;
}

const periodText = (p: Row | undefined) => (p ? `${p.from} to ${p.to}${p.timezone ? ` (${p.timezone})` : ""}` : "the period");
const filterShape = { sequence_id: z.string().optional(), sender_id: z.string().optional() };
const cleanFilters = (f: Record<string, unknown>) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** Workspace membership of an entity (sequence / sender / client): the period is cut in that workspace's timezone. */
async function wsOf(ctx: Ctx, table: "outreach_sequences" | "outreach_senders" | "outreach_clients", id: string, what: string): Promise<Membership> {
  const { data } = await ctx.user.from(table).select("workspace_id").eq("id", id).maybeSingle();
  if (!data) throw new McpError("E_NOT_FOUND", `${what} not found or not visible`);
  return resolveWs(ctx, (data as Row).workspace_id);
}

export function registerTasksReports(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------------- tasks
  tool(server, ctx, {
    name: "tasks_list", title: "List tasks", cls: "read", minRole: "client_viewer",
    description: "Open (default) or completed tasks: follow_up (created from interested/question replies), review_ai_draft (AI copy awaiting approval), manual_node, reconnect, reply_hold (a lead replied in a hold-for-review sequence and waits for resume or exit), call (call-task step with a script). Filter by kind, assignee ('me'), lead.",
    input: { ...wsParam, open: z.boolean().optional(), kind: z.enum(["manual_node", "follow_up", "review_ai_draft", "reconnect", "reply_hold", "call"]).optional(), assigned_to: z.string().optional(), lead_id: z.string().optional(), limit: z.number().int().min(1).max(100).optional() },
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
    description: "Complete a task. review_ai_draft: decision 'approve' queues the real invite/message/comment with result_text (or the stored ai_draft when omitted) through the normal budget + schedule path; 'reject' skips that step. The human decides: show the draft first, approve only after a yes. manual_node: the enrollment continues (result_text overrides the step's copy). reply_hold (the lead replied and is held for review): decision 'resume' continues the sequence, 'exit' ends it as replied. call: pass outcome connected | voicemail | no_answer | wrong_number and the sequence follows that branch. Idempotent.",
    input: { task_id: z.string(), result_text: z.string().max(8000).optional(), decision: z.enum(["approve", "reject", "resume", "exit"]).optional(), outcome: z.enum(["connected", "voicemail", "no_answer", "wrong_number"]).optional().describe("Call tasks only") },
  }, async (a) => {
    const { data: t } = await ctx.user.from("outreach_tasks").select("id, kind, completed_at, ai_draft").eq("id", a.task_id).maybeSingle();
    if (!t) throw new McpError("E_NOT_FOUND", "task not found");
    if (t.completed_at) return { task_id: t.id, already_completed_at: t.completed_at };
    if (t.kind === "reply_hold") {
      if (a.decision !== "resume" && a.decision !== "exit") throw new McpError("E_PAYLOAD_INVALID", "a held lead needs decision 'resume' or 'exit'", "Ask the human: continue the sequence for this lead, or stop it because they replied?");
      await urpc(ctx, "complete_task", { p_id: t.id, p_text: null, p_result: { decision: a.decision, by: "agent" } });
      return { task_id: t.id, completed: true, decision: a.decision, effect: a.decision === "resume" ? "the lead continues from the step it was held at" : "the enrollment ended as replied; history and chat are kept" };
    }
    if (t.kind === "call") {
      if (!a.outcome) throw new McpError("E_PAYLOAD_INVALID", "a call task needs outcome: connected | voicemail | no_answer | wrong_number");
      await urpc(ctx, "complete_task", { p_id: t.id, p_text: a.result_text?.trim() || null, p_result: { outcome: a.outcome, notes: a.result_text?.trim() || undefined, by: "agent" } });
      return { task_id: t.id, completed: true, outcome: a.outcome, effect: `the sequence follows the "${a.outcome}" branch` };
    }
    if (t.kind === "review_ai_draft" && a.decision === "reject") { await urpc(ctx, "complete_task", { p_id: t.id, p_text: null, p_result: { decision: "reject", by: "agent" } }); return { task_id: t.id, completed: true, decision: "reject", effect: "step skipped; enrollment advanced" }; }
    if (t.kind === "review_ai_draft" && !a.result_text && !t.ai_draft) throw new McpError("E_PAYLOAD_INVALID", "no AI draft on this task yet — pass result_text");
    await urpc(ctx, "complete_task", { p_id: t.id, p_text: a.result_text?.trim() || null, p_result: null });
    return { task_id: t.id, completed: true, kind: t.kind, effect: t.kind === "review_ai_draft" ? "real action queued (subject to caps and schedule)" : t.kind === "manual_node" ? "enrollment continues" : "closed" };
  });

  // ---------------------------------------------------------------- reports (thin RPC calls)
  tool(server, ctx, {
    name: "report_overview", title: "Workspace overview report", cls: "read", minRole: "client_viewer",
    description: "Workspace numbers for a period, straight from the platform's report function (identical to the dashboard and the Reports page): totals (invites, accepted, acceptance_rate, messages, inmails, emails, touches, replies, reply_rate, interested, positive/negative reply rate, intents, meetings, won, failed, skipped, limit_hits, email opens/clicks/bounces), the same totals for the previous period of equal length, by_channel {linkedin, email} and a daily series. Optional filters: client, sequence, sender, step (node_id), channel. `summary` is quotable and only repeats these numbers. Use metric_definitions when the user asks what a number means.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), ...filterShape, node_id: z.string().optional(), channel: z.enum(["linkedin", "email"]).optional(), include_series: z.boolean().optional().describe("Daily series (default: only for ranges up to 31 days)") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period, wsTz(ws));
    const r = await urpc<Row>(ctx, "report_overview", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_filters: cleanFilters({ sequence_id: a.sequence_id, sender_id: a.sender_id, node_id: a.node_id, channel: a.channel }) });
    const series = a.include_series === false || (a.include_series === undefined && (r.period?.days ?? 0) > 31) ? undefined : r.series;
    return { workspace: ws.name, period: r.period, totals: r.totals, previous: r.previous, by_channel: r.by_channel, series, summary: `From ${periodText(r.period)}: ${totalsSentence(r.totals)} Previous period (${r.period?.previous_from} to ${r.period?.previous_to}): ${r.previous?.invites ?? 0} invitations, ${r.previous?.replies ?? 0} replies (reply rate ${pctText(r.previous?.reply_rate)}), ${r.previous?.interested ?? 0} interested.` };
  });

  tool(server, ctx, {
    name: "report_funnel", title: "Funnel report", cls: "read", minRole: "client_viewer",
    description: "Cohort funnel: the leads ENROLLED in the period followed through enrolled → invited → accepted → messaged → replied → interested → meeting → won, whenever each stage happened. Per stage: count, pct_of_enrolled, pct_of_previous, median_hours_from_previous. Filters: client, sequence, sender, list, tag. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), ...filterShape, list_id: z.string().optional(), tag_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_funnel", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_filters: cleanFilters({ sequence_id: a.sequence_id, sender_id: a.sender_id, list_id: a.list_id, tag_id: a.tag_id }) });
    return { workspace: ws.name, ...r, summary: `Of ${r.cohort ?? 0} lead(s) enrolled from ${periodText(r.period)}: ${(r.stages ?? []).map((s: Row) => `${s.stage} ${s.count} (${pctText(s.pct_of_enrolled)})`).join(" → ")}.` };
  });

  tool(server, ctx, {
    name: "report_intents", title: "Reply intent report", cls: "read", minRole: "client_viewer",
    description: "Replies broken down by intent (interested, question, not_now, not_interested, ooo, wrong_person, unclear, unclassified) with the headline positive and negative reply rates, grouped by day | sequence | step | sender | variant | channel (default sequence). A reply = a lead answering an automated step for the first time in the period. Follow a number up with report_reply_threads to get the exact threads behind it. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), group: z.enum(["day", "sequence", "step", "sender", "variant", "channel"]).optional(), ...filterShape, node_id: z.string().optional(), channel: z.enum(["linkedin", "email"]).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_intents", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_group: a.group ?? "sequence", p_filters: cleanFilters({ sequence_id: a.sequence_id, sender_id: a.sender_id, node_id: a.node_id, channel: a.channel }) });
    return { workspace: ws.name, ...r, summary: `From ${periodText(r.period)}: ${r.replies ?? 0} replies to ${r.touches ?? 0} touches (reply rate ${pctText(r.reply_rate)}); positive reply rate ${pctText(r.positive_reply_rate)}, negative ${pctText(r.negative_reply_rate)}. Intents: ${Object.entries(r.intents ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")}.` };
  });

  tool(server, ctx, {
    name: "report_reply_threads", title: "Threads behind a reply number", cls: "read", minRole: "client_viewer",
    description: "The exact threads a reply count is made of (the platform returns up to 1000, newest first): chat_id, lead, sender, intent, replied_at, the sequence / step / variant that was answered and a preview. Filter by intent, sequence, sender, step (node_id), variant. Open one with inbox_thread(chat_id). Previews are third-party text. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional(), intent: z.enum(["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear", "unclassified"]).optional(), ...filterShape, node_id: z.string().optional(), variant_id: z.string().optional(), limit: z.number().int().min(1).max(200).optional().describe("Rows to return (default 50)") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const rows = (await urpc<Row[]>(ctx, "report_reply_threads", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_intent: a.intent ?? null, p_filters: cleanFilters({ sequence_id: a.sequence_id, sender_id: a.sender_id, node_id: a.node_id, variant_id: a.variant_id }) })) ?? [];
    const shown = rows.slice(0, a.limit ?? 50);
    return { workspace: ws.name, period: p, threads_found: rows.length, returned: shown.length, threads: shown.map((t) => ({ ...t, preview: untrusted("message_preview", t.preview, 200) })) };
  });

  tool(server, ctx, {
    name: "report_sequences", title: "All sequences report", cls: "read", minRole: "client_viewer",
    description: "One row per sequence with the standard totals for the period, plus live leads, failed_leads, stalled + stalled_reason and has_ab_test. Sorted by replies. Use report_sequence for the per-step view of one. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const rows = (await urpc<Row[]>(ctx, "report_sequences", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to })) ?? [];
    return { workspace: ws.name, period: p, count: rows.length, sequences: rows };
  });

  tool(server, ctx, {
    name: "report_senders", title: "All senders report", cls: "read", minRole: "client_viewer",
    description: "One row per sender with the standard totals for the period, plus status, health, warm-up level, paused_until, invite_blocked_until and running_dry. Shows which accounts carry the results. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const rows = (await urpc<Row[]>(ctx, "report_senders", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to })) ?? [];
    return { workspace: ws.name, period: p, count: rows.length, senders: rows };
  });

  tool(server, ctx, {
    name: "report_clients", title: "All clients report", cls: "read", minRole: "client_viewer",
    description: "Agency view: one row per client you can see, with senders, leads, live enrollments and the standard totals for the period. Default period 30d.",
    input: { ...wsParam, period: periodSchema },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const rows = (await urpc<Row[]>(ctx, "report_clients", { p_ws: ws.id, p_from: p.from, p_to: p.to })) ?? [];
    return { workspace: ws.name, period: p, count: rows.length, clients: rows };
  });

  tool(server, ctx, {
    name: "report_client", title: "Client report", cls: "read", minRole: "client_viewer",
    description: "Client-facing numbers for one client (agency model): the same shape as report_overview (totals, previous, by_channel, series) plus the client's leads, senders and live enrollments, and a quotable summary. This is what the client portal shows.",
    input: { client_id: z.string(), period: periodSchema, include_series: z.boolean().optional() },
  }, async (a) => {
    const ws = await wsOf(ctx, "outreach_clients", a.client_id, "client");
    const p = period(a.period, wsTz(ws));
    const r = await urpc<Row>(ctx, "report_client", { p_client: a.client_id, p_from: p.from, p_to: p.to });
    return { client: r.client, period: r.period, totals: r.totals, previous: r.previous, by_channel: r.by_channel, series: a.include_series === false ? undefined : r.series, leads: r.leads, senders: r.senders, live_enrollments: r.live_enrollments, summary: `For ${r.client?.name ?? "the client"} from ${periodText(r.period)}: ${totalsSentence(r.totals)} ${r.live_enrollments ?? 0} lead(s) are in sequences right now across ${(r.senders ?? []).length} sender(s).` };
  });

  tool(server, ctx, {
    name: "report_sequence", title: "Sequence report", cls: "read", minRole: "client_viewer",
    description: "One sequence over a period: totals, per-step rows (sent, failed, skipped, accepted, replies, interested, reply / positive-reply / acceptance rate, leads_here, failed_here), best_step and worst_step (each needs 20+ sends), ab_tests (same shape as sequence_ab_results), exits by reason and live leads. Default period 30d.",
    input: { sequence_id: z.string(), period: periodSchema },
  }, async (a) => {
    const ws = await wsOf(ctx, "outreach_sequences", a.sequence_id, "sequence");
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_sequence", { p_sequence: a.sequence_id, p_from: p.from, p_to: p.to });
    return { ...r, summary: `"${r.sequence?.name}" (${r.sequence?.status}) from ${periodText(r.period)}: ${totalsSentence(r.totals)} ${r.live ?? 0} lead(s) live.${r.best_step ? ` Best step: ${r.best_step.label} (reply rate ${pctText(r.best_step.reply_rate)}).` : ""}${r.worst_step ? ` Weakest step: ${r.worst_step.label} (reply rate ${pctText(r.worst_step.reply_rate)}).` : ""}${r.sequence?.stalled_reason ? ` Stalled: ${r.sequence.stalled_reason}` : ""}` };
  });

  tool(server, ctx, {
    name: "report_sender", title: "Sender report", cls: "read", minRole: "client_viewer",
    description: "One sender over a period: totals, daily series, health_trend, restrictions (rejects, checkpoints, pauses, disconnects) and failures_by_reason in plain words. For advice and warm-up progress use sender_insights. Default period 30d.",
    input: { sender_id: z.string(), period: periodSchema, include_series: z.boolean().optional() },
  }, async (a) => {
    const ws = await wsOf(ctx, "outreach_senders", a.sender_id, "sender");
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_sender", { p_sender: a.sender_id, p_from: p.from, p_to: p.to });
    return { ...r, series: a.include_series === false ? undefined : r.series, summary: `${r.sender?.name} (${r.sender?.status}, health ${r.sender?.health}, level ${r.sender?.level}) from ${periodText(r.period)}: ${totalsSentence(r.totals)} LinkedIn limit hits: ${r.totals?.limit_hits ?? 0}; failed actions: ${r.totals?.failed ?? 0}.` };
  });

  tool(server, ctx, {
    name: "report_cost", title: "Cost report", cls: "read", minRole: "client_viewer",
    description: "Cost per reply, per interested reply and per meeting for a period. Sender cost = monthly cost × days connected in the period ÷ 30 (the sender's own cost, else the workspace default). return_multiple only appears when the workspace entered deal values: the platform does not guess. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const r = await urpc<Row>(ctx, "report_cost", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to });
    return { workspace: ws.name, ...r, summary: r.cost == null ? String(r.note ?? "No sender cost is set.") : `From ${periodText(r.period)}: ${r.currency} ${r.cost} across ${r.senders} sender(s); cost per reply ${r.cost_per_reply ?? "n/a"}, per interested reply ${r.cost_per_interested ?? "n/a"}, per meeting ${r.cost_per_meeting ?? "n/a"}.${r.return_multiple ? ` Return: ${r.return_multiple}x on ${r.currency} ${r.won_value} won.` : ""}` };
  });

  tool(server, ctx, {
    name: "report_deliverability", title: "Email deliverability", cls: "read", minRole: "client_viewer",
    description: "Email channel over a period, from the same report functions: by_channel.email of report_overview (emails, email_opened / clicked / bounced, open_rate, click_rate, bounce_rate) plus the per-mailbox totals of report_senders. Default period 30d.",
    input: { ...wsParam, period: periodSchema, client_id: z.string().optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    const p = period(a.period ?? "30d", wsTz(ws));
    const [ov, senders] = await Promise.all([
      urpc<Row>(ctx, "report_overview", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to, p_filters: {} }),
      urpc<Row[]>(ctx, "report_senders", { p_ws: ws.id, p_client: a.client_id ?? null, p_from: p.from, p_to: p.to }),
    ]);
    const e: Row | undefined = ov.by_channel?.email;
    const pick = (t: Row) => ({ emails: t.emails, email_opened: t.email_opened, open_rate: t.open_rate, email_clicked: t.email_clicked, click_rate: t.click_rate, email_bounced: t.email_bounced, bounce_rate: t.bounce_rate, replies: t.replies, reply_rate: t.reply_rate });
    const mailboxes = (senders ?? []).filter((s) => s.provider !== "LINKEDIN").map((s) => ({ sender_id: s.sender_id, mailbox: s.name, provider: s.provider, status: s.status, ...pick(s.totals ?? {}) }));
    return { workspace: ws.name, period: ov.period, email: e ? pick(e) : undefined, mailboxes, note: mailboxes.length ? undefined : "No mailbox senders connected.", summary: e ? `From ${periodText(ov.period)}: ${e.emails} email(s) sent, ${e.email_opened} opened (open rate ${pctText(e.open_rate)}), ${e.email_clicked} clicked (${pctText(e.click_rate)}), ${e.email_bounced} bounced (${pctText(e.bounce_rate)}).` : `No email was sent from ${periodText(ov.period)}.` };
  });

  tool(server, ctx, {
    name: "metric_definitions", title: "What each number means", cls: "read", minRole: "client_viewer",
    description: "The written definition of every metric (day, invites, accepted, acceptance_rate, touches, replies, reply_rate, interested, positive / negative reply rate, meetings, won, cost_per_reply, funnel, headroom). The same text the Reports page shows as tooltips. Quote it when a user asks how a number is counted; never improvise a definition.",
    input: {},
  }, async () => ({ definitions: await urpc<Row>(ctx, "metric_definitions", {}), note: "Dashboard, Reports page, this connector and the public API all call the same report functions, so their numbers are identical for the same dates." }));

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
