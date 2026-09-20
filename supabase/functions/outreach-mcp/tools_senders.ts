// outreach-mcp/tools_senders.ts — sender reads (PRD §5.1). All read-only, any member.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, urpc, unwrap, McpError, short } from "./ctx.ts";

type Row = Record<string, any>;
const LIST_COLS = "id, workspace_id, client_id, display_name, provider, status, status_reason, health_score, warmup_level, is_premium, has_sales_nav, timezone, paused_until, invite_blocked_until, connections_count, last_ok_at, updated_at";
const CAPPED = ["invite", "message", "profile_view", "inmail", "email", "search_page", "like", "comment"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** {"invite":{used,reserved,cap},…} → {"invite":"3/9 (1 reserved)"} for capped types only */
function todayLine(t: Row | null | undefined): Record<string, string> | undefined {
  if (!t) return undefined;
  const o: Record<string, string> = {};
  for (const k of CAPPED) { const b = t[k]; if (b && typeof b.cap === "number" && (b.cap > 0 || b.used > 0)) o[k] = `${b.used}/${b.cap}${b.reserved ? ` (+${b.reserved} reserved)` : ""}`; }
  return Object.keys(o).length ? o : undefined;
}

export async function loadSender(ctx: Ctx, senderId: string, cols = "*"): Promise<Row> {
  const { data, error } = await ctx.user.from("outreach_senders").select(cols).eq("id", senderId).is("deleted_at", null).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new McpError("E_NOT_FOUND", `sender ${senderId} not found or not visible to you`);
  return data as Row;
}

export function senderBrief(s: Row, today?: Row) {
  return {
    id: s.id, name: s.display_name, provider: s.provider, status: s.status, status_reason: s.status_reason,
    health: s.health_score, level: s.warmup_level, premium: s.is_premium || undefined, sales_nav: s.has_sales_nav || undefined,
    tz: s.timezone, client_id: s.client_id,
    paused_until: s.paused_until && new Date(s.paused_until) > new Date() ? s.paused_until : undefined,
    invite_blocked_until: s.invite_blocked_until && new Date(s.invite_blocked_until) > new Date() ? s.invite_blocked_until : undefined,
    today: todayLine(today),
  };
}

export function registerSenders(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "senders_list", title: "List senders", cls: "read", minRole: "client_viewer",
    description: "List the LinkedIn/email sender accounts of a workspace with status, health, warmup level and today's used/cap per action type. ≤50 rows. Start here for any capacity or health question.",
    input: { ...wsParam, status: z.enum(["connecting", "ok", "credentials", "error", "paused", "disabled"]).optional(), client_id: z.string().optional(), provider: z.enum(["LINKEDIN", "GMAIL", "OUTLOOK", "IMAP"]).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_senders").select(LIST_COLS).eq("workspace_id", ws.id).is("deleted_at", null).order("display_name").limit(50);
    if (a.status) q = q.eq("status", a.status);
    if (a.client_id) q = q.eq("client_id", a.client_id);
    if (a.provider) q = q.eq("provider", a.provider);
    const rows = unwrap<Row[]>(await q);
    const today = await Promise.all(rows.map((r) => urpc<Row>(ctx, "sender_today", { p_sender: r.id }).catch((): Row => ({}))));
    return { workspace: ws.name, count: rows.length, senders: rows.map((r, i) => senderBrief(r, today[i])) };
  });

  tool(server, ctx, {
    name: "sender_get", title: "Get sender", cls: "read", minRole: "client_viewer",
    description: "Full detail of one sender: schedule + timezone, warmup, manual caps, proxy country, connection state, today's budgets, weekly invites used, whether it is inside its schedule window right now.",
    input: { sender_id: z.string() },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id);
    const today = new Date().toISOString().slice(0, 10);
    const [budget, weekly, inSchedule, windows] = await Promise.all([
      urpc<Row>(ctx, "sender_today", { p_sender: s.id }).catch((): Row => ({})),
      urpc<number>(ctx, "weekly_invites_used", { p_sender: s.id, p_day: today }).catch(() => null),
      urpc<boolean>(ctx, "in_schedule", { p_sender: s.id, p_at: new Date().toISOString() }).catch(() => null),
      urpc<Row[]>(ctx, "schedule_windows", { p_sender: s.id, p_day: today }).catch(() => []),
    ]);
    const { user_agent: _ua, proxy_ip_hint: _ip, ...rest } = s;
    return {
      ...senderBrief(s, budget), status_reason: s.status_reason,
      schedule: s.schedule, schedule_timezone: s.timezone, in_schedule_now: inSchedule, schedule_windows_today_utc: windows,
      warmup: { level: s.warmup_level, locked_until: s.warmup_locked_until }, manual_caps: s.manual_caps, health_breakdown: s.health_breakdown,
      proxy_country: s.proxy_country, connections: s.connections_count, weekly_invites_used: weekly,
      connected_at: rest.connected_at, last_ok_at: rest.last_ok_at, last_disconnect_at: rest.last_disconnect_at, reconnect_attempts: rest.reconnect_attempts,
      owner_email: rest.owner_email, public_identifier: rest.public_identifier,
    };
  });

  tool(server, ctx, {
    name: "sender_health", title: "Sender health", cls: "read", minRole: "client_viewer",
    description: "Health score (0–100 = the lowest of six categories), the per-category breakdown, the platform's own rule-based recommendations (severity, area, text: never AI, the same lines the sender page shows) and the 14-day score trend. Below 50 every allowance is 0; below 70 allowances drop to 60%. For warm-up progress, headroom and the invites-vs-cap chart use sender_insights.",
    input: { sender_id: z.string() },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id, "id, health_high_since, paused_until, status_reason");
    const since = new Date(Date.now() - 14 * 86400_000).toISOString();
    const [ins, { data: ev }] = await Promise.all([
      urpc<Row>(ctx, "sender_insights", { p_sender: s.id }),
      ctx.user.from("outreach_sender_events").select("at, data").eq("sender_id", s.id).eq("kind", "health").gte("at", since).order("at", { ascending: true }).limit(60),
    ]);
    const trend = (ev ?? []).map((e: Row) => ({ at: e.at.slice(0, 16), score: e.data?.to ?? e.data?.score ?? e.data?.health_score })).filter((x) => typeof x.score === "number");
    return { sender: ins.sender?.name, status: ins.sender?.status, score: ins.sender?.health, categories: ins.health_breakdown, recommendations: ins.recommendations, high_since: s.health_high_since, paused_until: s.paused_until && new Date(s.paused_until) > new Date() ? s.paused_until : undefined, status_reason: s.status_reason, trend_14d: trend };
  });

  tool(server, ctx, {
    name: "sender_insights", title: "Sender insights", cls: "read", minRole: "client_viewer",
    description: "Everything the sender page shows, from one database function: health_breakdown; recommendations [{severity high|medium|low|ok, area, text}] written by rules over the breakdown (quote them, do not invent advice); warmup {level, max_level, locked_until, next_level_on, unlocks (plain sentence), caps_now, caps_next}; last_30_days {headroom_pct (unused share of the invitation allowance), limit_hits (LinkedIn's own limit), acceptance_rate and acceptance_rate_previous, network_growth, invites, accepted, replies, reply_rate}; invites_vs_cap [{day, sent, cap}] for 30 days; inmail_guard {max_today, rule}: InMails may grow at most about 50% above last week's daily average. Headroom is room for more leads on this sender, never a reason to raise caps.",
    input: { sender_id: z.string(), include_chart: z.boolean().optional().describe("Include the 30-day invites_vs_cap series (default true)") },
  }, async (a) => {
    const r = await urpc<Row>(ctx, "sender_insights", { p_sender: a.sender_id });
    return { ...r, invites_vs_cap: a.include_chart === false ? undefined : r.invites_vs_cap };
  });

  tool(server, ctx, {
    name: "sender_budgets", title: "Sender budgets", cls: "read", minRole: "client_viewer",
    description: "The capacity check: per action type cap / used / reserved / remaining for a sender-local day (default today), plus weekly invites used vs the platform weekly ceiling and the sender's effective caps.",
    input: { sender_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Sender-local day YYYY-MM-DD; default today") },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id, "id, display_name, timezone, status, warmup_level, health_score");
    const day = a.date ?? await urpc<string>(ctx, "sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
    const [{ data: rows }, weekly, { data: ceil }] = await Promise.all([
      ctx.user.from("outreach_sender_budgets").select("action_type, cap, used, reserved").eq("sender_id", s.id).eq("day", day),
      urpc<number>(ctx, "weekly_invites_used", { p_sender: s.id, p_day: day }).catch(() => null),
      ctx.user.from("outreach_platform_ceilings").select("action_type, per_day, per_week"),
    ]);
    const ceilings = Object.fromEntries((ceil ?? []).map((c: Row) => [c.action_type, c]));
    const effective: Record<string, number> = {};
    await Promise.all(CAPPED.map(async (t) => { effective[t] = await urpc<number>(ctx, "effective_cap_checked", { p_sender: s.id, p_type: t }).catch(() => -1); }));
    const budgets = (rows ?? []).filter((r: Row) => r.cap > 0 || r.used > 0).map((r: Row) => ({ type: r.action_type, cap: r.cap, used: r.used, reserved: r.reserved, remaining: Math.max(0, r.cap - r.used - r.reserved) }));
    return {
      sender: s.display_name, day, tz: s.timezone, planned: budgets.length > 0,
      note: budgets.length ? undefined : "No budget rows for this day yet — the planner creates them at local midnight (or on first demand). Effective caps below are what it will use.",
      budgets, weekly_invites: { used: weekly, ceiling: ceilings.invite?.per_week ?? 150 },
      effective_caps_per_day: effective, platform_ceilings_per_day: Object.fromEntries(Object.entries(ceilings).map(([k, v]) => [k, (v as Row).per_day])),
    };
  });

  tool(server, ctx, {
    name: "sender_events", title: "Sender events", cls: "read", minRole: "client_viewer",
    description: "Status / health / proxy / reject / reconnect / checkpoint / schedule / caps history of a sender, newest first (≤100).",
    input: { sender_id: z.string(), since: z.string().optional().describe("ISO date/time"), kind: z.enum(["status", "health", "proxy", "warmup", "reconnect", "reject", "schedule", "caps", "checkpoint", "unipile"]).optional(), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => {
    await loadSender(ctx, a.sender_id, "id");
    let q = ctx.user.from("outreach_sender_events").select("id, kind, data, at").eq("sender_id", a.sender_id).order("at", { ascending: false }).limit(a.limit ?? 50);
    if (a.since) q = q.gte("at", a.since);
    if (a.kind) q = q.eq("kind", a.kind);
    const rows = unwrap<Row[]>(await q);
    return { count: rows.length, events: rows.map((e) => ({ at: e.at, kind: e.kind, ...e.data })) };
  });

  tool(server, ctx, {
    name: "senders_capacity", title: "Aggregate capacity", cls: "read", minRole: "client_viewer",
    description: "Planning estimate: how many actions (invite/message/profile_view/inmail/email) a set of senders can do over the next N days, from the platform's effective caps × scheduled days, minus what is already used or reserved today. A sender the platform reports as blocked (disconnected, paused, no working hours, health below 50: the why_not_sending diagnosis) contributes 0 and carries the reason. An estimate for choosing a pool, not a reported metric; the ledger enforces the real numbers.",
    input: { sender_ids: z.array(z.string()).min(1).max(50), days: z.number().int().min(1).max(60).optional().describe("Horizon in days (default 7)") },
  }, async (a) => {
    const days = a.days ?? 7;
    const { data: ceil } = await ctx.user.from("outreach_platform_ceilings").select("action_type, per_week");
    const weeklyInvite = (ceil ?? []).find((c: Row) => c.action_type === "invite")?.per_week ?? 150;
    const per: Row[] = [];
    const totals: Record<string, number> = {};
    for (const id of a.sender_ids) {
      const s = await loadSender(ctx, id, "id, display_name, status, schedule, timezone, warmup_level, health_score").catch(() => null);
      if (!s) { per.push({ id, error: "not found / not visible" }); continue; }
      const today = await urpc<Row>(ctx, "sender_today", { p_sender: s.id }).catch((): Row => ({}));
      const sched = (s.schedule ?? {}) as Record<string, unknown[]>;
      let workDays = 0;
      const now = new Date();
      for (let d = 0; d < days; d++) { const w = WEEKDAYS[new Date(now.getTime() + d * 86400_000).getUTCDay()]; if ((sched[w] ?? []).length > 0) workDays++; }
      const row: Row = { id: s.id, name: s.display_name, status: s.status, health: s.health_score, level: s.warmup_level, scheduled_days: workDays, available: {} };
      // whether this sender can send at all is the platform's call (the same diagnosis as why_not_sending)
      const diag = await urpc<Row>(ctx, "why_not_sending", { p_sender: s.id }).catch((): Row => ({}));
      const hard = (diag.causes ?? []).filter((c: Row) => c.blocking && c.code !== "E_CAP_ZERO"); // a zero cap for one action type already shows as 0 below
      if (hard.length) { row.blocked = true; row.note = `${hard[0].detail}. Contributes 0 until that is fixed: ${hard[0].remedy}`; per.push(row); continue; }
      for (const t of ["invite", "message", "profile_view", "inmail", "email"]) {
        const cap = await urpc<number>(ctx, "effective_cap_checked", { p_sender: s.id, p_type: t }).catch(() => 0);
        let avail = cap * workDays - (today?.[t]?.used ?? 0) - (today?.[t]?.reserved ?? 0);
        if (t === "invite") avail = Math.min(avail, Math.ceil(days / 7) * weeklyInvite);
        avail = Math.max(0, Math.round(avail));
        row.available[t] = avail; totals[t] = (totals[t] ?? 0) + avail;
      }
      per.push(row);
    }
    return { days, totals, senders: per, note: "Estimates from effective caps (warmup × health × manual caps) and schedule days; the ledger enforces the real numbers at send time." };
  });
}

export { short };
