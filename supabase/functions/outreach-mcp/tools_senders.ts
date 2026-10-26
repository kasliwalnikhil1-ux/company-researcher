// outreach-mcp/tools_senders.ts — sender reads (PRD §5.1). All read-only, any member.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, wsParam, resolveWs, urpc, unwrap, McpError, short, callFn, gate } from "./ctx.ts";

type Row = Record<string, any>;
const LIST_COLS = "id, workspace_id, client_id, display_name, provider, status, status_reason, health_score, warmup_level, is_premium, has_sales_nav, timezone, paused_until, invite_blocked_until, connections_count, last_ok_at, updated_at, outreach_allowed_from, provider_warning, pause_resume_at, disabled_at, auto_remove_at, removed_at, removed_via, erase_scheduled_at, removal_requested_at, disconnected_at, holder_notified_at, holder_reminders_sent, holder_email_held_until, pause_reason, owner_user_id, owner_email";
const STATUSES = ["connecting", "ok", "credentials", "error", "paused", "disabled", "removed", "erased", "disconnected"] as const;
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
    // lifecycle (sender-lifecycle-PRD.md): a person's pause with its auto-resume, a disabled sender's auto-remove date,
    // a removal (history kept; Reconnect brings it back), a scheduled erase
    pause_resume_at: s.status === "paused" ? future(s.pause_resume_at) : undefined,
    disabled_at: s.status === "disabled" ? s.disabled_at ?? undefined : undefined,
    auto_remove_at: s.status === "disabled" ? s.auto_remove_at ?? undefined : undefined,
    removal_pending: s.removal_requested_at && s.status !== "removed" && s.status !== "erased" ? true : undefined,
    removed_at: s.status === "removed" ? s.removed_at ?? undefined : undefined,
    removed_via: s.status === "removed" ? s.removed_via ?? undefined : undefined,
    erase_scheduled_at: future(s.erase_scheduled_at),
    pause_reason: s.status === "paused" ? s.pause_reason ?? undefined : undefined,
    // disconnect alerts (sender-lifecycle-PRD v1.2 §5.8): when it dropped, who was emailed, whether a mass-disconnect hold delays the email
    disconnected_at: s.status === "credentials" || s.status === "error" ? s.disconnected_at ?? undefined : undefined,
    holder_notified_at: s.status === "credentials" || s.status === "error" ? s.holder_notified_at ?? undefined : undefined,
    holder_reminders_sent: s.status === "credentials" || s.status === "error" ? s.holder_reminders_sent ?? undefined : undefined,
    holder_email_held_until: future(s.holder_email_held_until),
    holder: s.owner_user_id ? { kind: "member", user_id: s.owner_user_id } : s.connected_by ? { kind: "member", user_id: s.connected_by } : undefined,
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
    description: "List the sender accounts of a workspace (LinkedIn, Instagram, WhatsApp, mailboxes) with status, health, level and today's used/cap per action type. Statuses: ok, paused (a person paused it; `pause_resume_at` when it resumes by itself; manual replies still go out), disabled (leads left its sequences, late replies still arrive, removed automatically on `auto_remove_at`), removed (connector account unlinked, history kept, Reconnect in the app brings it back; hidden unless include_removed), credentials / error (needs a sign-in), connecting. (`new_chat` = conversations that did not exist yet, metered on every channel). Instagram rows carry `hour` (10 metered actions an hour); WhatsApp rows carry `quiet_until` while a freshly connected number waits 24 h, and `level` is the new-chat governor level (0–4 = 2/5/10/20/35 new chats a day). `provider_warning` = the provider flagged automated behaviour; the sender rests 48 h and only a human may resume it. ≤50 rows. Start here for any capacity or health question; channel_capacity gives the per-channel remaining view.",
    input: { ...wsParam, status: z.enum(STATUSES).optional(), client_id: z.string().optional(), provider: z.enum(PROVIDERS).optional(), include_removed: z.boolean().optional().describe("Also list removed senders (hidden by default)") },
  }, async (a) => {
    const ws = resolveWs(ctx, a.workspace_id);
    let q = ctx.user.from("outreach_senders").select(LIST_COLS).eq("workspace_id", ws.id).is("deleted_at", null).order("display_name").limit(50);
    if (a.status) q = q.eq("status", a.status);
    else if (!a.include_removed) q = q.not("status", "in", "(removed,erased,disconnected)");
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
    name: "sender_reconnect_link", title: "Sign-in link for a sender", cls: "write", minRole: "manager",
    description: "A sign-in link for the owner of a sender that is signed out (`credentials`, `error`) or `removed` (its connector account was unlinked: a manager removed it, the trial ended, billing, the owner disconnected it, or it was disabled for too long). Give the link to the account owner; they sign in and the same sender comes back with its conversations, contacted record and reports. A removed sender needs an active plan with a free account (E_ACCOUNT_LIMIT / E_PLAN_SUSPENDED otherwise: an owner fixes that on the Billing page) and must be reconnected with the SAME account. The link works for about an hour.",
    input: { sender_id: z.string() },
  }, async (a) => {
    const s = unwrap<Row | null>(await ctx.user.from("outreach_senders").select("id, display_name, provider, status, status_reason").eq("id", a.sender_id).is("deleted_at", null).maybeSingle());
    if (!s) throw new McpError("E_NOT_FOUND", "no such sender (or it is not visible to you)");
    if (s.status === "ok" || s.status === "paused") return { sender: s.display_name, status: s.status, note: "This sender is connected; no sign-in is needed." };
    if (s.status === "disabled") throw new McpError("E_SENDER_DISABLED", "This sender is disabled and still connected. A manager enables it in the app (Account tab).");
    if (s.status === "erased") throw new McpError("E_SENDER_REMOVED", "This sender was erased. Connect the account again as a new sender in the app.");
    const r = await callFn<Row>(ctx, "sender-manage", { sender_id: s.id, action: "reconnect_link", mode: "copy" });
    return { sender: s.display_name, provider: s.provider, status: s.status, reason: s.status_reason ?? undefined, link: r.link,
      note: s.status === "removed" || s.status === "disconnected" ? "Valid for about an hour. The owner must sign in with the same account this sender had; a different account is refused. Its history comes back on sign-in." : "Valid for about an hour. Send it to the account owner now." };
  });

  // sender-lifecycle-PRD.md §9: pause / resume are the only lifecycle actions here. Disable, remove and erase stay app-only:
  // ending someone's account connection is a human act.
  tool(server, ctx, {
    name: "sender_pause", title: "Pause a sender (confirmation required)", cls: "gated", minRole: "manager",
    description: "Pause a connected sender: sequence and AI sends stop, queued actions wait, leads STAY in their sequences and continue on resume, manual replies from the inbox still go out. Optional resume_at (ISO time) resumes it automatically. First call returns the effect summary (queued actions, leads affected) and a confirmation token. Disable, remove and erase are not available here: a human does those in the app.",
    input: { sender_id: z.string(), resume_at: z.string().optional().describe("ISO date-time at which the sender resumes by itself"), confirmation_token: z.string().optional() },
    annotations: { destructiveHint: false },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id, "id, display_name, status, status_reason, workspace_id, provider");
    if (s.provider === "WEBCHAT") throw new McpError("E_PAYLOAD_INVALID", "A website inbox is switched off from its Website agents page in the app.");
    if (s.status !== "ok") throw new McpError("E_SENDER_NOT_OK", `${s.display_name ?? "This sender"} is ${s.status}; only a connected sender can be paused.`);
    if (a.resume_at && !(new Date(a.resume_at).getTime() > Date.now())) throw new McpError("E_PAYLOAD_INVALID", "resume_at must be a future ISO date-time");
    const pv = await urpc<Row>(ctx, "sender_lifecycle_preview", { p_sender: s.id, p_action: "pause" });
    const g = await gate(ctx, "sender_pause", a as Record<string, unknown>,
      `Pause ${s.display_name ?? "sender"}: ${pv.queued_actions ?? 0} queued action(s) wait, ${pv.live_enrollments ?? 0} lead(s) stay in their sequences, manual replies still allowed${a.resume_at ? `, resumes automatically at ${a.resume_at}` : ""}.`, s.workspace_id);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "sender_pause", { p_sender: s.id, p_resume_at: a.resume_at ?? null });
    return { ok: true, sender: s.display_name, status: "paused", pause_resume_at: r?.pause_resume_at ?? null, ai_runs_to_draft: r?.ai_runs_to_draft ?? 0, note: "Sequence and AI sends stop; replies from the inbox still go out. Resume with sender_resume." };
  });

  tool(server, ctx, {
    name: "sender_resume", title: "Resume a paused sender (confirmation required)", cls: "gated", minRole: "manager",
    description: "Resume a sender a person paused. Overdue actions are spread over the following days inside its daily caps (never a burst). Refused for pauses that are not a person's to lift: a plan limit (E_ACCOUNT_LIMIT), billing (E_PLAN_SUSPENDED) or a provider warning (E_PROVIDER_WARNING: the banner in the app). A disabled or removed sender is not resumed here; a human enables or reconnects it in the app.",
    input: { sender_id: z.string(), confirmation_token: z.string().optional() },
    annotations: { destructiveHint: false },
  }, async (a) => {
    const s = await loadSender(ctx, a.sender_id, "id, display_name, status, status_reason, workspace_id");
    if (s.status !== "paused") throw new McpError(s.status === "disabled" ? "E_SENDER_DISABLED" : s.status === "removed" || s.status === "erased" ? "E_SENDER_REMOVED" : "E_SENDER_NOT_OK", `${s.display_name ?? "This sender"} is ${s.status}, not paused.`);
    const pv = await urpc<Row>(ctx, "sender_lifecycle_preview", { p_sender: s.id, p_action: "resume" });
    const g = await gate(ctx, "sender_resume", a as Record<string, unknown>, `Resume ${s.display_name ?? "sender"}: ${pv.queued_actions ?? 0} queued action(s) start again inside the daily caps; ${pv.live_enrollments ?? 0} lead(s) continue where they stopped.`, s.workspace_id);
    if (!g.proceed) return g.result;
    const r = await urpc<Row>(ctx, "sender_resume", { p_sender: s.id });
    return { ok: true, sender: s.display_name, status: "ok", backlog_spread: r?.backlog_spread ?? 0 };
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
    description: "Health score (0–100: a weighted average of six categories, held to a ceiling set by the weakest one; the breakdown carries average, cap and limited_by), the per-category breakdown, the platform's own rule-based recommendations (severity, area, text: never AI, the same lines the sender page shows) and the 14-day score trend. Below 50 every allowance is 0; below 70 allowances drop to 60%. For warm-up progress, headroom and the invites-vs-cap chart use sender_insights.",
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
