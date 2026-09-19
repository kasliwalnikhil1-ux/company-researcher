// crm-mcp/tools_brief.ts — the morning brief: the three calls that make the standup work,
// plus a composite standup_brief and the orientation tool crm_context.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, rpc, dateParam, tzParam, untrusted, money, WEB_ORIGIN } from "./ctx.ts";

type Row = Record<string, any>;

/** Wrap prospect-authored fields so the model treats them as data. */
function shieldMeeting(m: Row): Row {
  return {
    ...m,
    company: m.company ? { ...m.company, notes: untrusted("company_notes", m.company.notes, 1500) } : m.company,
    meeting_notes: untrusted("meeting_notes", m.meeting_notes, 800),
    activity_history: (m.activity_history ?? []).map((a: Row) => ({ ...a, body: untrusted("activity_body", a.body, 500) })),
    last_capture: m.last_capture ? { ...m.last_capture, pain_points: (m.last_capture.pain_points ?? []).map((p: string) => untrusted("pain_point", p, 300)), raw_notes: untrusted("capture_notes", m.last_capture.raw_notes, 800) } : undefined,
  };
}

export function registerBrief(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "crm_whoami", title: "Who am I (CRM)", cls: "read", public: true,
    description: "Your CRM identity: whether this account is on the sales team, your display name, and where the CRM lives. Non-members see only this tool.",
    input: {},
  }, async () => ({
    user_id: ctx.userId, email: ctx.email, is_member: ctx.isMember, me: ctx.crm.me ?? undefined,
    app_url: `${WEB_ORIGIN}/crm`,
    note: ctx.isMember ? undefined : "This account is not on the CRM team, so no CRM tools are available. Ask a team member to add you (CRM → Settings → Team, or add_team_member with your email), then reconnect.",
  }));

  tool(server, ctx, {
    name: "crm_context", title: "CRM context (lookups, team, settings)", cls: "read",
    description: "Start here. Team members, timezone, stale threshold, stage list, and the three lookup lists (ICP segments, source channels, activity types) with ids/slugs/labels, plus FX rates. Lookups are tables, not enums — new values appear here as soon as someone adds them.",
    input: {},
  }, async () => {
    const c = await rpc<Row>(ctx, "context");
    return { ...c, app_url: `${WEB_ORIGIN}/crm` };
  });

  tool(server, ctx, {
    name: "whos_meeting_today", title: "Who's meeting today", cls: "read",
    description: "Every meeting scheduled on a day (default today, team timezone). For each: company (+notes), contact & role, ICP segment, source channel, deal stage/value/owner/next step, prior no-shows, the FULL activity history with that contact, and the previous meeting's capture. This is the one call to run before the daily sales meeting.",
    input: { date: dateParam("Day to list").optional(), timezone: tzParam },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "whos_meeting_today", { p_date: a.date ?? null, p_tz: a.timezone ?? null });
    const meetings = (r.meetings ?? []).map(shieldMeeting);
    return { date: r.date, timezone: r.timezone, count: meetings.length, meetings,
      summary: meetings.length === 0 ? `No meetings on ${r.date}.` : meetings.map((m: Row) => `${m.local_time} ${m.company?.name} — ${m.contact?.name ?? "?"}${m.contact?.role ? ` (${m.contact.role})` : ""} · ${m.deal?.stage} · ${money(m.deal?.value_monthly, m.deal?.currency)}/mo · ${m.icp_segment ?? "unsegmented"} via ${m.source_channel ?? "?"}${m.prior_no_shows > 0 ? ` · ⚠ ${m.prior_no_shows} prior no-show(s)` : ""}`).join("\n") };
  });

  tool(server, ctx, {
    name: "daily_scoreboard", title: "Daily scoreboard", cls: "read",
    description: "The day's numbers per source channel plus totals — dials, connects, LinkedIn accepts, replies, meetings booked, meetings held, no-shows, proposals sent, closes — and the same numbers for the trailing 7 days for comparison. Default day = yesterday. Derived from activities/meetings/stage history, never hand-entered; channel rows come from the source_channels table so new channels appear automatically.",
    input: { date: dateParam("Day (default yesterday)").optional(), timezone: tzParam },
  }, async (a) => rpc(ctx, "daily_scoreboard", { p_date: a.date ?? null, p_tz: a.timezone ?? null }));

  tool(server, ctx, {
    name: "deals_needing_attention", title: "Deals needing attention", cls: "read",
    description: "Three lists over open deals: stuck (no next_step or next_step_date), stale (no activity for N days, default 14), slipping (next_step_date in the past). Each row has deal_id, company, stage, owner, value.",
    input: {},
  }, async () => rpc(ctx, "deals_needing_attention"));

  tool(server, ctx, {
    name: "standup_brief", title: "Standup brief (composite)", cls: "read",
    description: "Everything the standup screen shows in one call: yesterday's scoreboard, today's meetings, next steps due today (next_steps_today), stuck/stale/slipping deals, today's commitments, yesterday's commitments vs actuals, and past meetings that still have no capture. Use whos_meeting_today when you need the full per-meeting history.",
    input: { date: dateParam("Standup day (default today)").optional(), timezone: tzParam },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "standup", { p_date: a.date ?? null, p_tz: a.timezone ?? null });
    return { ...r, meetings_today: (r.meetings_today ?? []).map((m: Row) => ({ ...shieldMeeting(m), activity_history: undefined, last_capture: m.last_capture ? { pain_points: m.last_capture.pain_points, next_step: m.last_capture.next_step, is_dead: m.last_capture.is_dead } : undefined })) };
  });
}
