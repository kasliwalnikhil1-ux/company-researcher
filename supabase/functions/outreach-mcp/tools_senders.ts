// outreach-mcp/tools_senders.ts — sender reads (PRD §5.1). All read-only, any member.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, urpc, unwrap, McpError, short } from "./ctx.ts";

type Row = Record<string, any>;
const LIST_COLS = "id, workspace_id, client_id, display_name, provider, status, status_reason, health_score, warmup_level, is_premium, has_sales_nav, timezone, paused_until, invite_blocked_until, connections_count, last_ok_at, updated_at, outreach_allowed_from, provider_warning";
// new_chat = a conversation that did not exist yet (metered on every channel); follow / identifier_check are Instagram / WhatsApp
const CAPPED = ["invite", "message", "new_chat", "profile_view", "inmail", "email", "search_page", "like", "comment", "follow", "identifier_check"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const PROVIDERS = ["LINKEDIN", "INSTAGRAM", "WHATSAPP", "GMAIL", "OUTLOOK", "IMAP"] as const;

/** outreach_sender_hour → "3/10 used this hour" (Instagram: 10 metered actions an hour, replies excluded). */
function hourLine(h: Row | null | undefined): string | undefined {
  if (!h || typeof h.cap !== "number") return undefined;
  return `${h.used ?? 0}/${h.cap} used this hour${h.reserved ? ` (+${h.reserved} reserved)` : ""}`;
}

/** The hour ledger only exists for providers with an hourly scope (Instagram); one RPC, never fails the caller. */
export async function senderHour(ctx: Ctx, s: Row): Promise<Row | undefined> {
  if (s.provider !== "INSTAGRAM") return undefined;
  return await urpc<Row>(ctx, "sender_hour", { p_sender: s.id }).catch(() => undefined);
}

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

export function senderBrief(s: Row, today?: Row, hour?: Row) {
  const future = (v: unknown) => (typeof v === "string" && new Date(v) > new Date() ? v : undefined);
  return {
    id: s.id, name: s.display_name, provider: s.provider, channel: s.provider, status: s.status, status_reason: s.status_reason,
    health: s.health_score, level: s.warmup_level, premium: s.is_premium || undefined, sales_nav: s.has_sales_nav || undefined,
    tz: s.timezone, client_id: s.client_id,
    paused_until: future(s.paused_until),
    invite_blocked_until: future(s.invite_blocked_until),
    // channels: a freshly connected WhatsApp number waits 24 h; an Instagram "automated behaviour" notice pauses 48 h until a human resumes
    quiet_until: future(s.outreach_allowed_from),
    provider_warning: s.provider_warning?.text ? { text: String(s.provider_warning.text).slice(0, 300), at: s.provider_warning.at, paused_until: s.provider_warning.paused_until, note: "Only a human may resume this sender in the app." } : undefined,
    today: todayLine(today),
    hour: hourLine(hour),
  };
}

export function registerSenders(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "senders_list", title: "List senders", cls: "read", minRole: "client_viewer",
    description: "List the sender accounts of a workspace (LinkedIn, Instagram, WhatsApp, mailboxes) with status, health, level and today's used/cap per action type (`new_chat` = conversations that did not exist yet, metered on every channel). Instagram rows carry `hour` (10 metered actions an hour); WhatsApp rows carry `quiet_until` while a freshly connected number waits 24 h, and `level` is the new-chat governor level (0–4 = 2/5/10/20/35 new chats a day). `provider_warning` = the provider flagged automated behaviour; the sender rests 48 h and only a human may resume it. ≤50 rows. Start here for any capacity or health question; channel_capacity gives the per-channel remaining view.",
    input: { ...wsParam, status: z.enum(["connecting", "ok", "credentials", "error", "paused", "disabled"]).optional(), client_id: z.string().optional(), provider: z.enum(PROVIDERS).optional() },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_senders").select(LIST_COLS).eq("workspace_id", ws.id).is("deleted_at", null).order("display_name").limit(50);
    if (a.status) q = q.eq("status", a.status);
    if (a.client_id) q = q.eq("client_id", a.client_id);
    if (a.provider) q = q.eq("provider", a.provider);
    const rows = unwrap<Row[]>(await q);
    const [today, hours] = await Promise.all([
      Promise.all(rows.map((r) => urpc<Row>(ctx, "sender_today", { p_sender: r.id }).catch((): Row => ({})))),
      Promise.all(rows.map((r) => senderHour(ctx, r))),
    ]);
    return { workspace: ws.name, count: rows.length, senders: rows.map((r, i) => senderBrief(r, today[i], hours[i])) };
  });

  tool(server, ctx, {
    name: "sender_get", title: "Get sender", cls: "read", minRole: "client_viewer",
    description: "Full detail of one sender: channel, schedule + timezone, warmup / governor level, manual caps, proxy country, connection state, today's budgets, weekly invites used (LinkedIn), whether it is inside its schedule window right now; Instagram: this hour's usage; WhatsApp: quiet_until, the attested account age; any provider warning with its verbatim text.",
    input: { sender_id: z.string() },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id);
    const today = new Date().toISOString().slice(0, 10);
    const [budget, weekly, inSchedule, windows, hour] = await Promise.all([
      urpc<Row>(ctx, "sender_today", { p_sender: s.id }).catch((): Row => ({})),
      urpc<number>(ctx, "weekly_invites_used", { p_sender: s.id, p_day: today }).catch(() => null),
      urpc<boolean>(ctx, "in_schedule", { p_sender: s.id, p_at: new Date().toISOString() }).catch(() => null),
      urpc<Row[]>(ctx, "schedule_windows", { p_sender: s.id, p_day: today }).catch(() => []),
      senderHour(ctx, s),
    ]);
    const { user_agent: _ua, proxy_ip_hint: _ip, ...rest } = s;
    return {
      ...senderBrief(s, budget, hour), status_reason: s.status_reason,
      schedule: s.schedule, schedule_timezone: s.timezone, in_schedule_now: inSchedule, schedule_windows_today_utc: windows,
      warmup: { level: s.warmup_level, locked_until: s.warmup_locked_until, governor: s.provider === "WHATSAPP" ? "WhatsApp new-chat governor: level 0–4 = 2/5/10/20/35 new chats a day, promoted nightly on reply rate, demoted at once on a block, a low reply rate or a disconnect" : undefined }, manual_caps: s.manual_caps, health_breakdown: s.health_breakdown,
      proxy_country: s.proxy_country, connections: s.connections_count, weekly_invites_used: s.provider === "LINKEDIN" ? weekly : undefined,
      account_age: s.provider === "WHATSAPP" ? { months: rest.account_age_months, attested_at: rest.account_age_attested_at, note: rest.account_age_attested_at ? undefined : "Not attested: the governor will not promote above level 0 until a manager attests at least 6 months of real use in the app." } : undefined,
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
    description: "The capacity check: per action type cap / used / reserved / remaining for a sender-local day (default today), plus weekly invites used vs the platform weekly ceiling (LinkedIn) and the sender's effective caps. Instagram: `hour` (this hour's all-metered scope, 10 an hour) and `day_scope` (the daily total across all metered actions). WhatsApp: `governor_level` (0–4 = 2/5/10/20/35 new chats a day) and `quiet_until`. `new_chat` is metered separately from `message` on every channel.",
    input: { sender_id: z.string(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Sender-local day YYYY-MM-DD; default today") },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id, "id, display_name, provider, timezone, status, warmup_level, health_score, outreach_allowed_from");
    const day = a.date ?? await urpc<string>(ctx, "sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
    const [{ data: rows }, weekly, { data: ceil }, scopes] = await Promise.all([
      ctx.user.from("outreach_sender_budgets").select("action_type, cap, used, reserved").eq("sender_id", s.id).eq("day", day),
      s.provider === "LINKEDIN" ? urpc<number>(ctx, "weekly_invites_used", { p_sender: s.id, p_day: day }).catch(() => null) : Promise.resolve(null),
      ctx.user.from("outreach_platform_ceilings").select("action_type, per_day, per_week, provider"),
      s.provider === "INSTAGRAM" || s.provider === "WHATSAPP" ? urpc<Row>(ctx, "sender_scopes_today", { p_sender: s.id }).catch((): Row => ({})) : Promise.resolve({} as Row),
    ]);
    // ceilings are per provider since 025; rows without the column (older database) apply to LinkedIn
    const ceilings = Object.fromEntries((ceil ?? []).filter((c: Row) => (c.provider ?? "LINKEDIN") === s.provider).map((c: Row) => [c.action_type, c]));
    const effective: Record<string, number> = {};
    await Promise.all(CAPPED.map(async (t) => { effective[t] = await urpc<number>(ctx, "effective_cap_checked", { p_sender: s.id, p_type: t }).catch(() => -1); }));
    for (const t of Object.keys(effective)) if (effective[t] < 0) delete effective[t];
    const budgets = (rows ?? []).filter((r: Row) => r.cap > 0 || r.used > 0).map((r: Row) => ({ type: r.action_type, cap: r.cap, used: r.used, reserved: r.reserved, remaining: Math.max(0, r.cap - r.used - r.reserved) }));
    const scoped = (x: Row | null | undefined) => (x && typeof x.cap === "number" ? { cap: x.cap, used: x.used, reserved: x.reserved, remaining: x.remaining ?? Math.max(0, x.cap - x.used - x.reserved), window_start: x.hour_start ?? x.window_start } : undefined);
    return {
      sender: s.display_name, channel: s.provider, day, tz: s.timezone, planned: budgets.length > 0,
      note: budgets.length ? undefined : "No budget rows for this day yet — the planner creates them at local midnight (or on first demand). Effective caps below are what it will use.",
      budgets,
      hour: s.provider === "INSTAGRAM" ? scoped(scopes?.hour) : undefined,
      day_scope: s.provider === "INSTAGRAM" ? scoped(scopes?.day) : undefined,
      governor_level: s.provider === "WHATSAPP" ? s.warmup_level : undefined,
      quiet_until: s.outreach_allowed_from && new Date(s.outreach_allowed_from) > new Date() ? s.outreach_allowed_from : undefined,
      weekly_invites: s.provider === "LINKEDIN" ? { used: weekly, ceiling: ceilings.invite?.per_week ?? 150 } : undefined,
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
    description: "Planning estimate: how many actions (invite/message/new_chat/profile_view/inmail/email) a set of senders can do over the next N days, from the platform's effective caps × scheduled days, minus what is already used or reserved today. A sender the platform reports as blocked (disconnected, paused, no working hours, health below 50, inside its quiet period, resting after a provider warning: the why_not_sending diagnosis) contributes 0 and carries the reason. Instagram and WhatsApp senders are low-volume by design (new_chat per level, 10 actions an hour on Instagram): the estimate shows that honestly. An estimate for choosing a pool, not a reported metric; the ledger enforces the real numbers.",
    input: { sender_ids: z.array(z.string()).min(1).max(50), days: z.number().int().min(1).max(60).optional().describe("Horizon in days (default 7)") },
  }, async (a) => {
    const days = a.days ?? 7;
    const { data: ceil } = await ctx.user.from("outreach_platform_ceilings").select("action_type, per_week");
    const weeklyInvite = (ceil ?? []).find((c: Row) => c.action_type === "invite")?.per_week ?? 150;
    const per: Row[] = [];
    const totals: Record<string, number> = {};
    for (const id of a.sender_ids) {
      const s = await loadSender(ctx, id, "id, display_name, provider, status, schedule, timezone, warmup_level, health_score").catch(() => null);
      if (!s) { per.push({ id, error: "not found / not visible" }); continue; }
      const today = await urpc<Row>(ctx, "sender_today", { p_sender: s.id }).catch((): Row => ({}));
      const sched = (s.schedule ?? {}) as Record<string, unknown[]>;
      let workDays = 0;
      const now = new Date();
      for (let d = 0; d < days; d++) { const w = WEEKDAYS[new Date(now.getTime() + d * 86400_000).getUTCDay()]; if ((sched[w] ?? []).length > 0) workDays++; }
      const row: Row = { id: s.id, name: s.display_name, channel: s.provider, status: s.status, health: s.health_score, level: s.warmup_level, scheduled_days: workDays, available: {} };
      // whether this sender can send at all is the platform's call (the same diagnosis as why_not_sending)
      const diag = await urpc<Row>(ctx, "why_not_sending", { p_sender: s.id }).catch((): Row => ({}));
      const hard = (diag.causes ?? []).filter((c: Row) => c.blocking && c.code !== "E_CAP_ZERO"); // a zero cap for one action type already shows as 0 below
      if (hard.length) { row.blocked = true; row.note = `${hard[0].detail}. Contributes 0 until that is fixed: ${hard[0].remedy}`; per.push(row); continue; }
      for (const t of ["invite", "message", "new_chat", "profile_view", "inmail", "email"]) {
        const cap = await urpc<number>(ctx, "effective_cap_checked", { p_sender: s.id, p_type: t }).catch(() => 0);
        let avail = cap * workDays - (today?.[t]?.used ?? 0) - (today?.[t]?.reserved ?? 0);
        if (t === "invite") avail = Math.min(avail, Math.ceil(days / 7) * weeklyInvite);
        avail = Math.max(0, Math.round(avail));
        if (avail === 0 && t === "new_chat" && s.provider !== "INSTAGRAM" && s.provider !== "WHATSAPP" && !today?.new_chat) continue; // older database rows without a new_chat ceiling: keep the LinkedIn output as before
        row.available[t] = avail; totals[t] = (totals[t] ?? 0) + avail;
      }
      per.push(row);
    }
    return { days, totals, senders: per, note: "Estimates from effective caps (warmup × health × manual caps) and schedule days; the ledger enforces the real numbers at send time." };
  });
}

export { short };
