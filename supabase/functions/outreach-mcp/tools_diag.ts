// outreach-mcp/tools_diag.ts — workspace context, dashboard and why_not_sending (PRD §5.8).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { admin } from "../_shared/outreach/supabase.ts";
import { type Ctx, type Membership, tool, z, wsParam, resolveWs, urpc, unwrap, McpError } from "./ctx.ts";
import { loadSender } from "./tools_senders.ts";

type Row = Record<string, any>;
export interface Cause { code: string; detail: string; next_capacity?: string; remedy: string; sender?: string }
const LIVE = ["active", "waiting_connection", "waiting_delay", "waiting_task"];
const NODE_ACTION: Record<string, string> = { visit_profile: "profile_view", like_latest_post: "like", comment_latest_post: "comment", endorse_skills: "endorse", send_invite: "invite", withdraw_invite: "withdraw", send_message: "message", send_inmail: "inmail", send_email: "email", call_api: "call_api" };

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

async function nextWindow(ctx: Ctx, senderId: string): Promise<string | undefined> {
  const now = Date.now();
  for (let d = 0; d < 8; d++) {
    const day = new Date(now + d * 86400_000).toISOString().slice(0, 10);
    const w = await urpc<Row[]>(ctx, "schedule_windows", { p_sender: senderId, p_day: day }).catch(() => []);
    const hit = (w ?? []).map((x) => x.start_at).filter((s) => new Date(s).getTime() > now).sort()[0];
    if (hit) return hit;
  }
  return undefined;
}

export async function senderCauses(ctx: Ctx, s: Row, need: string[], plan: string): Promise<Cause[]> {
  const c: Cause[] = [];
  const name = s.display_name ?? s.id;
  const push = (x: Omit<Cause, "sender">) => c.push({ ...x, sender: name });
  if (plan === "suspended") push({ code: "E_PLAN_SUSPENDED", detail: "workspace plan is suspended (billing)", remedy: "Only an owner can fix billing in the app; nothing sends until then." });
  if (s.status !== "ok") {
    const why = s.status === "credentials" ? "LinkedIn session expired / needs re-login" : s.status === "error" ? `provider error: ${s.status_reason ?? "unknown"}` : s.status === "paused" ? `paused (${s.status_reason ?? "by a user"})` : s.status;
    push({ code: "E_SENDER_NOT_OK", detail: `status ${s.status}: ${why}`, remedy: s.status === "paused" ? "A manager resumes the sender in the app (Senders → Resume) — the agent cannot." : "A human must reconnect the sender in the app (Senders → Reconnect / hosted login). Do not retry sends." });
  }
  if (s.paused_until && new Date(s.paused_until).getTime() > Date.now()) push({ code: "E_SENDER_PAUSED", detail: `paused until ${s.paused_until} (${s.status_reason ?? "health / provider rejections"})`, next_capacity: s.paused_until, remedy: "Wait it out. Do not move volume to other senders to compensate." });
  const inSched = await urpc<boolean>(ctx, "in_schedule", { p_sender: s.id, p_at: new Date().toISOString() }).catch(() => null);
  if (inSched === false) { const nw = await nextWindow(ctx, s.id); push({ code: "E_OUT_OF_SCHEDULE", detail: `outside the sender's schedule window (tz ${s.timezone})`, next_capacity: nw, remedy: nw ? `Sends resume automatically at ${nw}. Nothing to fix.` : "The schedule has no windows in the next 7 days — a manager must set one in the app." }); }
  const today = await urpc<Row>(ctx, "sender_today", { p_sender: s.id }).catch((): Row => ({}));
  const planned = Object.keys(today ?? {}).length > 0;
  if (!planned) push({ code: "W_NOT_PLANNED", detail: "no budget rows for the sender-local day yet", remedy: "The planner creates them at local midnight and tops up every 20 minutes; the first sends of a new sender can take up to an hour. A manager can force it with 'Plan now' in the app." });
  for (const t of [...new Set(need)]) {
    const b = today?.[t];
    if (!b) continue;
    if (b.cap === 0) push({ code: "E_CAP_ZERO", detail: `${t} cap is 0 today (warmup level ${s.warmup_level}, health ${s.health_score}${s.manual_caps?.[t] === 0 ? ", manual cap 0" : ""})`, remedy: "Caps rise with warmup level and health over time; a manager can adjust manual caps in the app within the platform ceiling." });
    else if (b.used + b.reserved >= b.cap) push({ code: "E_BUDGET_EXHAUSTED", detail: `${t}: ${b.used + b.reserved}/${b.cap} used today`, next_capacity: "next sender-local day", remedy: "Wait for tomorrow's plan, or add another healthy sender to the pool. Do not raise caps." });
  }
  if (need.includes("invite")) {
    const weekly = await urpc<number>(ctx, "weekly_invites_used", { p_sender: s.id, p_day: new Date().toISOString().slice(0, 10) }).catch(() => 0);
    const { data: ceil } = await ctx.user.from("outreach_platform_ceilings").select("per_week").eq("action_type", "invite").maybeSingle();
    if (weekly >= (ceil?.per_week ?? 150)) push({ code: "E_CAP_HIT_WEEKLY", detail: `${weekly}/${ceil?.per_week ?? 150} invites this week`, next_capacity: "next Monday (sender-local)", remedy: "Invites resume next week automatically; messages to existing connections still go out." });
    if (s.invite_blocked_until && new Date(s.invite_blocked_until).getTime() > Date.now()) push({ code: "E_INVITE_BLOCKED", detail: `LinkedIn refused invites (limit) — blocked until ${s.invite_blocked_until}`, next_capacity: s.invite_blocked_until, remedy: "Wait. Other action types continue." });
  }
  if (s.health_score < 50) push({ code: "E_HEALTH_PAUSED", detail: `health ${s.health_score} < 50 → all caps ×0 (auto-paused)`, remedy: "Use sender_health for the failing category; recovery takes days of low, consistent activity." });
  else if (s.health_score < 70) push({ code: "W_HEALTH_REDUCED", detail: `health ${s.health_score} < 70 → caps ×0.6`, remedy: "Keep volume steady; see sender_health." });
  return c;
}

async function platformFlags(): Promise<Cause[]> {
  const { data } = await admin.from("outreach_flags").select("key, value").in("key", ["tick_enabled", "planner_enabled"]);
  const c: Cause[] = [];
  for (const f of data ?? []) if (f.value === false || f.value === "false") c.push({ code: "E_PLATFORM_PAUSED", detail: `platform flag ${f.key} is off (operator kill switch)`, remedy: "Platform operators paused automation globally; nothing to do in the workspace." });
  return c;
}

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
    description: "The app's dashboard numbers: senders with today's usage, items needing attention, unread / replies awaiting, open tasks and AI drafts, live enrollments, sent/queued today, 7-day stats.",
    input: { ...wsParam },
  }, async (a) => { const ws = resolveWs(ctx, a.workspace_id); const d = await urpc<Row>(ctx, "dashboard", { p_ws: ws.id }); return { workspace: ws.name, ...d, senders: (d.senders ?? []).map((s: Row) => ({ id: s.id, name: s.display_name, status: s.status, reason: s.status_reason, health: s.health_score, level: s.warmup_level, today: Object.fromEntries(Object.entries(s.today ?? {}).filter(([, v]: [string, any]) => v.cap > 0 || v.used > 0).map(([k, v]: [string, any]) => [k, `${v.used}/${v.cap}`])) })) }; });

  tool(server, ctx, {
    name: "why_not_sending", title: "Why is nothing sending?", cls: "read", minRole: "client_viewer",
    description: "Diagnose a sequence, a sender or one enrollment: ordered list of blocking causes with evidence, when capacity returns, and the remedy. Codes starting with E_ block; W_ are informational. Call this BEFORE concluding something is broken — the usual answer is a cap, a schedule window, warmup or health, none of which should be worked around.",
    input: { sequence_id: z.string().optional(), sender_id: z.string().optional(), enrollment_id: z.string().optional() },
  }, async (a) => {
    const causes: Cause[] = [...(await platformFlags())];
    const notes: string[] = [];
    let target = "";
    if (a.enrollment_id) {
      const e = unwrap<Row | null>(await ctx.user.from("outreach_enrollments").select("*, outreach_leads(full_name, do_not_contact, unsubscribed), outreach_sequences(id, name, status, throttled_reason, sender_pool, graph, settings, workspace_id)").eq("id", a.enrollment_id).maybeSingle());
      if (!e) throw new McpError("E_NOT_FOUND", "enrollment not found");
      const seq = e.outreach_sequences; const ws = resolveWs(ctx, seq.workspace_id);
      target = `enrollment of ${e.outreach_leads?.full_name} in "${seq.name}"`;
      if (!LIVE.includes(e.status)) causes.push({ code: "E_ENROLLMENT_NOT_LIVE", detail: `status ${e.status}${e.exit_reason ? ` (${e.exit_reason})` : ""}`, remedy: e.status === "paused" ? "enrollment_resume to continue." : "It is finished; enrol the lead again if appropriate." });
      if (e.outreach_leads?.do_not_contact || e.outreach_leads?.unsubscribed) causes.push({ code: "E_LEAD_SUPPRESSED", detail: "lead is do-not-contact / unsubscribed", remedy: "Nothing will be sent to this lead. Do not work around suppression." });
      const node = seq.graph?.nodes?.[e.current_node_id];
      const need = node ? [NODE_ACTION[node.type]].filter(Boolean) : [];
      if (e.status === "waiting_delay") causes.push({ code: "W_WAITING_DELAY", detail: `in a delay at node ${e.current_node_id} until ${e.wait_until}`, next_capacity: e.wait_until, remedy: "By design; it continues automatically." });
      if (e.status === "waiting_connection") { const { data: lss } = await ctx.user.from("outreach_lead_sender_state").select("relation, invite_sent_at").eq("lead_id", e.lead_id).eq("sender_id", e.sender_id).maybeSingle(); causes.push({ code: "W_WAITING_CONNECTION", detail: `invitation ${lss?.relation ?? "pending"} since ${lss?.invite_sent_at ?? "?"}; window ends ${e.wait_until}`, next_capacity: e.wait_until, remedy: "Waiting for the prospect to accept; the no_connect branch runs when the window ends." }); }
      if (e.status === "waiting_task") { const { data: t } = await ctx.user.from("outreach_tasks").select("id, kind, title").eq("enrollment_id", e.id).is("completed_at", null).limit(1).maybeSingle(); causes.push({ code: "W_WAITING_TASK", detail: `waiting for a human: ${t?.kind ?? "task"} ${t?.id ?? ""} "${t?.title ?? ""}"`, remedy: "Complete it with task_complete (review AI draft / manual step)." }); }
      if (node?.type === "send_message" && !node.config?.send_always) { const { data: lss } = await ctx.user.from("outreach_lead_sender_state").select("relation, replied").eq("lead_id", e.lead_id).eq("sender_id", e.sender_id).maybeSingle(); if (lss && lss.relation !== "first") causes.push({ code: "E_RELATION_REQUIRED", detail: `message node but relation is ${lss.relation} (needs 1st-degree)`, remedy: "Put an invite + wait_connection before messages, or use InMail." }); if (lss?.replied && seq.settings?.stop_on_reply !== false) causes.push({ code: "E_REPLIED", detail: "lead replied; stop_on_reply is on", remedy: "By design — continue the conversation in the inbox." }); }
      if (e.status === "active") { const { data: next } = await ctx.user.from("outreach_actions").select("action_type, scheduled_for, status, decision").eq("enrollment_id", e.id).in("status", ["queued", "reserved"]).order("scheduled_for").limit(1).maybeSingle(); if (next) causes.push({ code: "W_SCHEDULED", detail: `next ${next.action_type} is ${next.status} for ${next.scheduled_for}${next.decision ? ` (${next.decision})` : ""}`, next_capacity: next.scheduled_for, remedy: "Planned; it executes at that time inside the schedule window." }); else causes.push({ code: "W_NOT_PLANNED_YET", detail: "active with no queued action", remedy: "The planner (nightly + every 20 min) assigns a slot when budget exists; check the sender causes below." }); }
      if (seq.status !== "active") causes.push({ code: "E_SEQUENCE_NOT_ACTIVE", detail: `sequence is ${seq.status}`, remedy: "sequence_activate (confirmation) — a manager action." });
      if (seq.throttled_reason) causes.push({ code: "W_THROTTLED", detail: `sequence throttled: ${seq.throttled_reason}`, remedy: "Set by the planner when the pool cannot keep up; add senders or wait." });
      const s = await loadSender(ctx, e.sender_id).catch(() => null);
      if (s) causes.push(...(await senderCauses(ctx, s, need.length ? need : ["invite", "message"], ws.plan)));
    } else if (a.sequence_id) {
      const seq = unwrap<Row | null>(await ctx.user.from("outreach_sequences").select("id, name, status, throttled_reason, sender_pool, graph, workspace_id").eq("id", a.sequence_id).maybeSingle());
      if (!seq) throw new McpError("E_NOT_FOUND", "sequence not found");
      const ws = resolveWs(ctx, seq.workspace_id);
      target = `sequence "${seq.name}"`;
      if (seq.status !== "active") causes.push({ code: "E_SEQUENCE_NOT_ACTIVE", detail: `status ${seq.status}`, remedy: "sequence_activate (confirmation required; manager)." });
      if (seq.throttled_reason) causes.push({ code: "W_THROTTLED", detail: seq.throttled_reason, remedy: "The pool cannot keep up with demand; add senders or accept the longer projection." });
      if (!seq.sender_pool?.length) causes.push({ code: "E_POOL_EMPTY", detail: "no senders in the pool", remedy: "sequence_update with pool." });
      const [{ count: live }, { count: queued }] = await Promise.all([
        ctx.user.from("outreach_enrollments").select("id", { count: "exact", head: true }).eq("sequence_id", seq.id).in("status", LIVE),
        ctx.user.from("outreach_actions").select("id, outreach_enrollments!inner(sequence_id)", { count: "exact", head: true }).eq("outreach_enrollments.sequence_id", seq.id).eq("status", "queued"),
      ]);
      if ((live ?? 0) === 0) causes.push({ code: "W_NO_LIVE_ENROLLMENTS", detail: "no live enrollments", remedy: "enroll_preview → enroll_commit." });
      notes.push(`${live ?? 0} live enrollment(s), ${queued ?? 0} queued action(s)`);
      const need = [...new Set(Object.values(seq.graph?.nodes ?? {}).map((n: any) => NODE_ACTION[n.type]).filter(Boolean))] as string[];
      for (const sid of seq.sender_pool ?? []) { const s = await loadSender(ctx, sid).catch(() => null); if (s) causes.push(...(await senderCauses(ctx, s, need, ws.plan))); else causes.push({ code: "E_SENDER_NOT_OK", detail: `pool sender ${sid} not found / deleted`, remedy: "Remove it from the pool.", sender: sid }); }
    } else if (a.sender_id) {
      const s = await loadSender(ctx, a.sender_id);
      const ws = resolveWs(ctx, s.workspace_id);
      target = `sender "${s.display_name}"`;
      causes.push(...(await senderCauses(ctx, s, ["invite", "message", "profile_view", "inmail", "email"], ws.plan)));
      const { count: queued } = await ctx.user.from("outreach_actions").select("id", { count: "exact", head: true }).eq("sender_id", s.id).eq("status", "queued");
      const { count: live } = await ctx.user.from("outreach_enrollments").select("id", { count: "exact", head: true }).eq("sender_id", s.id).in("status", LIVE);
      notes.push(`${live ?? 0} live enrollment(s), ${queued ?? 0} queued action(s) for this sender`);
      if ((live ?? 0) === 0) causes.push({ code: "W_NO_DEMAND", detail: "no live enrollments use this sender", remedy: "Add it to a sequence pool and enrol leads." });
    } else throw new McpError("E_PAYLOAD_INVALID", "sequence_id, sender_id or enrollment_id required");
    const blocking = causes.filter((c) => c.code.startsWith("E_"));
    return { target, blocked: blocking.length > 0, verdict: blocking.length ? `${blocking.length} blocking cause(s); first: ${blocking[0].code}` : causes.length ? "Nothing is blocking; the informational items explain the timing." : "Nothing is blocking. If still nothing happens within one schedule window, escalate to a platform operator.", causes, notes, rule: "Never respond to a cap, schedule or health block by raising volume elsewhere." };
  });
}
