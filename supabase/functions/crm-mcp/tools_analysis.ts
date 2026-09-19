// crm-mcp/tools_analysis.ts — pipeline & analysis tools, plus settings/lookup management
// (everything the Settings screen can do, so adding a segment never needs a developer).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, rpc, compact, dateParam, stageEnum, lookupRef, memberRef, companyRef, untrusted, money } from "./ctx.ts";

type Row = Record<string, any>;

export function registerAnalysis(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "pipeline", title: "Pipeline by stage", cls: "read",
    description: "Open deals grouped by stage with count, value (USD-normalised) and per-deal age in stage, next step and stale/stuck/slipping flags. Filters: owner, icp_segment, source_channel, stages[], include_closed.",
    input: { owner: memberRef, icp_segment: lookupRef("ICP segment"), source_channel: lookupRef("Source channel"), stages: z.array(stageEnum).optional(), include_closed: z.boolean().optional() },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "pipeline", { p: compact(a) });
    return { ...r, summary: (r.stages ?? []).filter((s: Row) => s.count > 0).map((s: Row) => `${s.stage}: ${s.count} deal(s), $${Math.round(s.value_monthly_usd).toLocaleString("en-US")}/mo`).join(" · ") };
  });

  tool(server, ctx, {
    name: "funnel", title: "Funnel by channel", cls: "read",
    description: "Cohort funnel for deals created in a date range, per source channel (or one channel): leads → contacted → replied → meeting_booked → meeting_held → proposal_sent → negotiation → won, with stage-to-stage conversion %, cost (if channel spend was entered), CAC, revenue_usd (won deals' monthly value x months since won) and ltv_usd (that revenue per won customer).",
    input: { from: dateParam("Range start"), to: dateParam("Range end (default today)").optional(), source_channel: lookupRef("Source channel") },
  }, async (a) => rpc(ctx, "funnel", { p_from: a.from, p_to: a.to ?? null, p_source_channel: a.source_channel ?? null }));

  tool(server, ctx, {
    name: "top_pain_points", title: "Top pain points", cls: "read",
    description: "Ranked pain-point tags from meeting captures (mentions, distinct deals, won deals, ICP-segment breakdown, up to 3 verbatims each) plus the most common objections. Filter by date range and ICP segment. Feeds messaging and showreel decisions.",
    input: { from: dateParam("Range start").optional(), to: dateParam("Range end").optional(), icp_segment: lookupRef("ICP segment"), limit: z.number().int().min(1).max(100).optional() },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "top_pain_points", { p_from: a.from ?? null, p_to: a.to ?? null, p_icp_segment: a.icp_segment ?? null, p_limit: a.limit ?? 25 });
    return { ...r, tags: (r.tags ?? []).map((t: Row) => ({ ...t, verbatims: (t.verbatims ?? []).map((v: string) => untrusted("pain_point", v, 300)) })) };
  });

  tool(server, ctx, {
    name: "channel_quality", title: "Channel quality", cls: "read",
    description: "Per source channel over a date range: deals created, meetings booked, held, no-shows, NO-SHOW RATE (the lead-quality signal — channels sorted worst first), won/lost, close rate, average won deal value (USD).",
    input: { from: dateParam("Range start"), to: dateParam("Range end (default today)").optional() },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "channel_quality", { p_from: a.from, p_to: a.to ?? null });
    return { ...r, summary: (r.channels ?? []).filter((c: Row) => c.meetings_booked > 0 || c.deals_created > 0).map((c: Row) => `${c.label}: ${c.meetings_booked} booked, ${c.no_shows} no-show (${c.no_show_rate_pct ?? "n/a"}%), ${c.won} won (${c.close_rate_pct ?? "n/a"}%)`).join("\n") };
  });

  tool(server, ctx, {
    name: "company_brief", title: "Company brief", cls: "read",
    description: "Everything known about one company (by id, domain or name): profile + notes, contacts, deals with full stage history, every meeting with its capture, the whole activity timeline, all pain points/tags, objections, commercials discussed, open next steps, linked delivery projects. Clean enough to feed a proposal or deck.",
    input: { company: companyRef },
  }, async (a) => {
    const r = await rpc<Row>(ctx, "company_brief", { p_company: a.company });
    return {
      ...r,
      company: r.company ? { ...r.company, notes: untrusted("company_notes", r.company.notes, 3000) } : r.company,
      activities: (r.activities ?? []).map((x: Row) => ({ ...x, body: untrusted("activity_body", x.body, 600) })),
      pain_points: (r.pain_points ?? []).map((p: string) => untrusted("pain_point", p, 300)),
      objections: (r.objections ?? []).map((p: string) => untrusted("objection", p, 300)),
    };
  });

  tool(server, ctx, {
    name: "search", title: "Search companies, contacts, deals", cls: "read",
    description: "Fuzzy search by name/domain/email/role/next step. Returns ids to use with other tools.",
    input: { q: z.string().min(1).max(100), limit: z.number().int().min(1).max(50).optional() },
  }, async (a) => rpc(ctx, "search", { p_q: a.q, p_limit: a.limit ?? 10 }));

  tool(server, ctx, {
    name: "companies_list", title: "List companies", cls: "read",
    description: "Companies with their ICP segment, source channel, open-deal count and last activity. Filter by segment/channel/country; paginated.",
    input: { icp_segment: lookupRef("ICP segment"), source_channel: lookupRef("Source channel"), country: z.string().optional(), q: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), offset: z.number().int().min(0).optional() },
  }, async (a) => {
    const c = ctx.crm;
    const segId = a.icp_segment ? c.icp_segments.find((s) => s.id === a.icp_segment || s.slug === a.icp_segment || s.label.toLowerCase() === a.icp_segment!.toLowerCase())?.id : undefined;
    const chId = a.source_channel ? c.source_channels.find((s) => s.id === a.source_channel || s.slug === a.source_channel || s.label.toLowerCase() === a.source_channel!.toLowerCase())?.id : undefined;
    let q = ctx.user.from("crm_companies").select("id, name, domain, country, timezone, notes, created_at, crm_icp_segments(label), crm_source_channels(label), crm_deals(id, stage, value_monthly, currency, last_activity_at)").order("name").range(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 50) - 1);
    if (segId) q = q.eq("icp_segment_id", segId);
    if (chId) q = q.eq("source_channel_id", chId);
    if (a.country) q = q.ilike("country", `%${a.country}%`);
    if (a.q) q = q.or(`name.ilike.%${a.q}%,domain.ilike.%${a.q}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return { count: (data ?? []).length, companies: (data ?? []).map((x: Row) => ({ company_id: x.id, name: x.name, domain: x.domain, country: x.country, icp_segment: x.crm_icp_segments?.label, source_channel: x.crm_source_channels?.label, open_deals: (x.crm_deals ?? []).filter((d: Row) => !["won", "lost"].includes(d.stage)).map((d: Row) => `${d.stage} ${money(d.value_monthly, d.currency)}`), last_activity_at: (x.crm_deals ?? []).map((d: Row) => d.last_activity_at).filter(Boolean).sort().pop() })) };
  });

  // ---------------------------------------------------------------- settings / lookups (Settings screen parity)
  tool(server, ctx, {
    name: "lookup_save", title: "Add or edit a lookup value", cls: "write",
    description: "Add an ICP segment, source channel or activity type — or rename / deactivate / reorder one. Never delete: deactivate with is_active=false so historical deals keep their label. For activity types, counts_as tells the scoreboard what the type feeds: dial | linkedin_message | linkedin_connect | email | meeting (or omit).",
    input: { kind: z.enum(["icp_segment", "source_channel", "activity_type"]), label: z.string().min(1).max(80), slug: z.string().max(60).optional(), sort_order: z.number().int().optional(), is_active: z.boolean().optional(), notes: z.string().max(500).optional(), counts_as: z.enum(["dial", "linkedin_message", "linkedin_connect", "email", "meeting"]).optional() },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "lookup_save", { p_kind: a.kind, p_label: a.label, p_slug: a.slug ?? null, p_sort_order: a.sort_order ?? null, p_is_active: a.is_active ?? null, p_notes: a.notes ?? null, p_counts_as: a.counts_as ?? null }));

  tool(server, ctx, {
    name: "lookup_reorder", title: "Reorder a lookup list", cls: "write",
    description: "Set the display order of a lookup list by passing its slugs in the desired order.",
    input: { kind: z.enum(["icp_segment", "source_channel", "activity_type"]), slugs: z.array(z.string()).min(1).max(100) },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "lookup_reorder", { p_kind: a.kind, p_slugs: a.slugs }));

  tool(server, ctx, {
    name: "set_fx_rate", title: "Set an FX rate", cls: "write",
    description: "Add/update a currency's USD rate (usd_per_unit) so deal values in that currency sum in USD. Recomputes existing deals in that currency.",
    input: { currency: z.string().length(3), usd_per_unit: z.number().positive() },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "set_fx_rate", { p_currency: a.currency, p_usd_per_unit: a.usd_per_unit }));

  tool(server, ctx, {
    name: "set_channel_cost", title: "Enter channel spend for a month", cls: "write",
    description: "Manual monthly spend per source channel (feeds funnel cost and CAC). month = any date in that month.",
    input: { source_channel: z.string(), month: dateParam("Any date in the month"), cost: z.number().min(0), currency: z.string().length(3).optional(), notes: z.string().max(300).optional() },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "set_channel_cost", { p_source_channel: a.source_channel, p_month: a.month, p_cost: a.cost, p_currency: a.currency ?? "USD", p_notes: a.notes ?? null }));

  tool(server, ctx, {
    name: "set_setting", title: "Change a CRM setting", cls: "write",
    description: "default_timezone (IANA), stale_after_days (int), default_currency (ISO code), studio_name.",
    input: { key: z.enum(["default_timezone", "stale_after_days", "default_currency", "studio_name"]), value: z.union([z.string(), z.number()]) },
  }, async (a) => rpc(ctx, "set_setting", { p_key: a.key, p_value: a.value }));

  tool(server, ctx, {
    name: "add_team_member", title: "Add a team member", cls: "write",
    description: "Give a CapitalxAI account access to the CRM (they must have signed up). Everyone on the team sees everything.",
    input: { email: z.string().email(), display_name: z.string().max(80).optional() },
  }, async (a) => rpc(ctx, "add_member", { p_email: a.email, p_display_name: a.display_name ?? null }));

  tool(server, ctx, {
    name: "set_team_member", title: "Rename / deactivate a team member", cls: "write",
    description: "Rename a member or set is_active=false to remove their access (history keeps their name).",
    input: { user_id: z.string().uuid(), display_name: z.string().max(80).optional(), is_active: z.boolean().optional() },
  }, async (a) => rpc(ctx, "set_member", { p_user_id: a.user_id, p_display_name: a.display_name ?? null, p_is_active: a.is_active ?? null }));
}
