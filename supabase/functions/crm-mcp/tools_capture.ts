// crm-mcp/tools_capture.ts — after-meeting writes: capture_meeting (the main write),
// update_deal, log_activity, schedule/update meeting, and the entity upserts they need.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z, rpc, compact, dateParam, stageEnum, lookupRef, memberRef, McpError, money } from "./ctx.ts";

type Row = Record<string, any>;

export function registerCapture(server: McpServer, ctx: Ctx): void {
  // ---------------------------------------------------------------- capture
  tool(server, ctx, {
    name: "capture_meeting", title: "Capture a meeting (held / no-show)", cls: "write",
    description: "THE main write after a meeting. outcome=held requires pain_points (prospect's own words), commercials_discussed, and either next_step+next_step_date or is_dead+dead_reason. outcome=no_show requires no_show_reason, follow_up_action, follow_up_date. Anything missing → the call is rejected naming the missing fields; nothing partial is written. On success the meeting flips to held/no_show, the deal advances to meeting_held (or lost when is_dead), its next step is set, and pain points tokenise into tags (pass `tags` to override).",
    input: {
      meeting_id: z.string().uuid(),
      outcome: z.enum(["held", "no_show"]),
      pain_points: z.array(z.string().min(1).max(500)).max(30).optional().describe("held: verbatim, not paraphrased"),
      commercials_discussed: z.object({ price: z.number().optional(), currency: z.string().optional(), volume: z.number().optional(), notes: z.string().optional(), none: z.boolean().optional().describe("true when commercials were explicitly not discussed") }).passthrough().optional(),
      objections: z.array(z.string().max(300)).max(20).optional(),
      next_step: z.string().max(300).optional(),
      next_step_date: dateParam("held: next step date").optional(),
      is_dead: z.boolean().optional(),
      dead_reason: z.string().max(500).optional(),
      no_show_reason: z.string().max(500).optional(),
      follow_up_action: z.string().max(300).optional(),
      follow_up_date: dateParam("no_show: follow-up date").optional(),
      tags: z.array(z.string().max(60)).max(30).optional().describe("Normalised pain-point tags; omit to derive one tag per pain point"),
      raw_notes: z.string().max(4000).optional(),
    },
  }, async (a) => {
    const { meeting_id, outcome, ...rest } = a;
    const r = await rpc<Row>(ctx, "capture_meeting", { p_meeting_id: meeting_id, p_outcome: outcome, p: compact(rest) });
    const d = r.deal ?? {};
    return { ...r, summary: `${r.meeting?.company_name ?? "Meeting"} captured as ${outcome}. Deal now ${d.stage}${d.next_step ? `; next: ${d.next_step} by ${d.next_step_date}` : ""}${r.capture?.is_repeat_no_show ? " ⚠ repeat no-show for this contact" : ""}.` };
  });

  tool(server, ctx, {
    name: "update_capture", title: "Edit an existing capture", cls: "write",
    description: "Change fields of a meeting's existing capture (pain_points, commercials_discussed, objections, next_step(+date), is_dead/dead_reason, no_show_reason, follow_up_action/date, raw_notes). Outcome cannot change. Does not re-tokenise tags.",
    input: {
      meeting_id: z.string().uuid(),
      pain_points: z.array(z.string()).optional(), commercials_discussed: z.record(z.string(), z.unknown()).optional(), objections: z.array(z.string()).optional(),
      next_step: z.string().nullable().optional(), next_step_date: dateParam("next step date").nullable().optional(), is_dead: z.boolean().optional(), dead_reason: z.string().nullable().optional(),
      no_show_reason: z.string().optional(), follow_up_action: z.string().optional(), follow_up_date: dateParam("follow-up date").optional(), raw_notes: z.string().optional(),
    },
  }, async (a) => { const { meeting_id, ...rest } = a; return rpc(ctx, "update_capture", { p_meeting_id: meeting_id, p: compact(rest) }); });

  // ---------------------------------------------------------------- deals
  tool(server, ctx, {
    name: "update_deal", title: "Update a deal", cls: "write",
    description: "Change stage, value (+currency), videos/month, owner, expected close, next step (+date), lost_reason, title, source channel, delivery_project_id. Stage history is written automatically. Stages move forward or to lost; a backwards move is rejected unless `reason` is given (then written to stage_history). Pass null to clear next_step / next_step_date.",
    input: {
      deal_id: z.string().uuid(),
      stage: stageEnum.optional(),
      reason: z.string().max(300).optional().describe("Required for a backwards stage move; also used as lost_reason when moving to lost without one"),
      value_monthly: z.number().nullable().optional(), currency: z.string().length(3).optional(), videos_per_month: z.number().int().nullable().optional(),
      owner: memberRef, expected_close_date: dateParam("expected close").nullable().optional(),
      next_step: z.string().max(300).nullable().optional(), next_step_date: dateParam("next step date").nullable().optional(),
      lost_reason: z.string().max(500).optional(), title: z.string().max(120).nullable().optional(),
      source_channel: lookupRef("Source channel"), delivery_project_id: z.string().uuid().nullable().optional(),
    },
  }, async (a) => {
    const { deal_id, reason, ...rest } = a;
    const r = await rpc<Row>(ctx, "update_deal", { p_deal_id: deal_id, p: compact(rest), p_reason: reason ?? null });
    return { ...r, summary: `${r.company_name}: ${r.stage_changed ? `${r.from_stage} → ${r.stage}` : `stage ${r.stage}`} · ${money(r.value_monthly, r.currency)}/mo${r.next_step ? ` · next: ${r.next_step} (${r.next_step_date ?? "no date"})` : " · ⚠ no next step"}` };
  });

  tool(server, ctx, {
    name: "create_deal", title: "Create a deal", cls: "write",
    description: "Open a new deal for a company (by id, domain or name — create the company first with upsert_company if unknown). Stage defaults to new; owner defaults to you. Give value_monthly WITH currency.",
    input: {
      company: z.string().describe("Company id, domain or name"),
      title: z.string().max(120).optional(), stage: stageEnum.optional(), owner: memberRef,
      value_monthly: z.number().optional(), currency: z.string().length(3).optional(), videos_per_month: z.number().int().optional(),
      expected_close_date: dateParam("expected close").optional(), next_step: z.string().max(300).optional(), next_step_date: dateParam("next step date").optional(),
      source_channel: lookupRef("Source channel (defaults to the company's)"),
    },
  }, async (a) => rpc(ctx, "create_deal", { p: compact(a) }));

  // ---------------------------------------------------------------- companies / contacts
  tool(server, ctx, {
    name: "upsert_company", title: "Add or update a company", cls: "write",
    description: "Create a company or update it (matched by id, then website domain, then exact name). ICP segment and source channel accept slug/label/id. Use append_notes to add to notes without replacing them.",
    input: {
      id: z.string().uuid().optional(), name: z.string().min(1).max(200).optional(), website: z.string().max(300).optional(), country: z.string().max(80).optional(),
      timezone: z.string().max(60).optional().describe("IANA, e.g. Asia/Dubai"), icp_segment: lookupRef("ICP segment"), source_channel: lookupRef("Source channel"),
      notes: z.string().max(4000).optional(), append_notes: z.string().max(2000).optional(),
    },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "upsert_company", { p: compact(a) }));

  tool(server, ctx, {
    name: "upsert_contact", title: "Add or update a contact", cls: "write",
    description: "Create or update a person at a company (matched by id, then email, then company+name). company = id, domain or name.",
    input: {
      id: z.string().uuid().optional(), company: z.string().optional().describe("Company id, domain or name (required for a new contact)"), name: z.string().min(1).max(160).optional(),
      role: z.string().max(120).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional(), linkedin_url: z.string().max(300).optional(),
      timezone: z.string().max(60).optional(), notes: z.string().max(2000).optional(), is_primary: z.boolean().optional(),
    },
    annotations: { idempotentHint: true },
  }, async (a) => rpc(ctx, "upsert_contact", { p: compact(a) }));

  // ---------------------------------------------------------------- activities
  tool(server, ctx, {
    name: "log_activity", title: "Log an activity", cls: "write",
    description: "Any touch on any channel: call, LinkedIn message, LinkedIn connect, email, meeting (activity_type by slug/label). Identify the person by contact_id, contact_email, or company + contact_name; deal defaults to the company's open deal. direction outbound|inbound (inbound = a reply). outcome conventions: connected | no_answer | voicemail | accepted | replied | booked. external_ref makes machine-written activities idempotent.",
    input: {
      contact_id: z.string().uuid().optional(), contact_email: z.string().optional(), company: z.string().optional(), contact_name: z.string().optional(),
      deal_id: z.string().uuid().optional(),
      activity_type: z.string().describe("call | linkedin_message | linkedin_connect | email | meeting | any slug/label from crm_context"),
      direction: z.enum(["outbound", "inbound"]).optional(),
      occurred_at: z.string().optional().describe("ISO timestamp, default now"),
      source_channel: lookupRef("Source channel (defaults to the deal's/company's)"),
      body: z.string().max(4000).optional(), outcome: z.string().max(60).optional(), owner: memberRef, external_ref: z.string().max(200).optional(),
    },
  }, async (a) => rpc(ctx, "log_activity", { p: compact(a) }));

  tool(server, ctx, {
    name: "log_activities_bulk", title: "Log several activities", cls: "write",
    description: "Log up to 50 activities in one call (e.g. a call block: 12 dials, 3 connected). Same fields as log_activity per row; per-row errors are reported, the rest are saved.",
    input: { rows: z.array(z.record(z.string(), z.unknown())).min(1).max(50) },
  }, async (a) => {
    const results: Row[] = [];
    for (const row of a.rows) {
      try { const r = await rpc<Row>(ctx, "log_activity", { p: compact(row as Record<string, unknown>) }); results.push({ ok: true, id: r.id, contact: r.contact_name, type: r.activity_type_slug, outcome: r.outcome }); }
      catch (e) { results.push({ ok: false, row, error: e instanceof Error ? e.message : String(e) }); }
    }
    return { saved: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length, rows: results };
  });

  // ---------------------------------------------------------------- meetings
  tool(server, ctx, {
    name: "schedule_meeting", title: "Schedule a meeting", cls: "write",
    description: "Book a meeting on a deal (deal_id, or a contact/company whose open deal is used — a deal is created if none is open). Moves the deal to meeting_booked when it is earlier. Give scheduled_at as an ISO timestamp with offset (e.g. 2026-09-18T11:00:00+05:30) and the prospect's timezone.",
    input: {
      deal_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), contact_email: z.string().optional(), company: z.string().optional(), contact_name: z.string().optional(),
      scheduled_at: z.string().describe("ISO timestamp with offset"), timezone: z.string().optional(), duration_min: z.number().int().min(5).max(480).optional(),
      attendees: z.array(z.string()).max(20).optional(), notes: z.string().max(2000).optional(),
    },
  }, async (a) => rpc(ctx, "schedule_meeting", { p: compact(a) }));

  tool(server, ctx, {
    name: "update_meeting", title: "Reschedule / cancel a meeting", cls: "write",
    description: "Change scheduled_at, timezone, duration, contact, attendees, notes, or set status=cancelled / back to scheduled. held and no_show are NOT settable here — the database only allows them through capture_meeting.",
    input: {
      meeting_id: z.string().uuid(), scheduled_at: z.string().optional(), timezone: z.string().optional(), duration_min: z.number().int().optional(), contact_id: z.string().uuid().optional(),
      attendees: z.array(z.string()).optional(), notes: z.string().max(2000).optional(), status: z.enum(["scheduled", "cancelled"]).optional(),
    },
  }, async (a) => { const { meeting_id, ...rest } = a; return rpc(ctx, "update_meeting", { p_meeting_id: meeting_id, p: compact(rest) }); });

  tool(server, ctx, {
    name: "meetings_list", title: "List meetings", cls: "read",
    description: "Meetings in a date range (default: past 7 days → next 7 days) with status and whether a capture exists. Use status=scheduled with to<today to find past meetings that were never captured.",
    input: { from: dateParam("Range start").optional(), to: dateParam("Range end").optional(), status: z.enum(["scheduled", "held", "no_show", "cancelled"]).optional(), company: z.string().optional(), limit: z.number().int().min(1).max(200).optional() },
  }, async (a) => {
    const from = a.from ? `${a.from}T00:00:00Z` : new Date(Date.now() - 7 * 86400_000).toISOString();
    const to = a.to ? `${a.to}T23:59:59Z` : new Date(Date.now() + 7 * 86400_000).toISOString();
    let q = ctx.user.from("crm_meetings_v").select("id, deal_id, company_id, company_name, contact_name, contact_role, scheduled_at, timezone, status, has_capture, capture_outcome, deal_stage, value_monthly, currency, attendees, notes").gte("scheduled_at", from).lte("scheduled_at", to).order("scheduled_at").limit(a.limit ?? 100);
    if (a.status) q = q.eq("status", a.status);
    if (a.company) q = q.ilike("company_name", `%${a.company}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Row[];
    return { from, to, count: rows.length, uncaptured_past: rows.filter((m) => m.status === "scheduled" && new Date(m.scheduled_at).getTime() < Date.now()).length, meetings: rows.map((m) => ({ meeting_id: m.id, deal_id: m.deal_id, company: m.company_name, contact: m.contact_name, role: m.contact_role, scheduled_at: m.scheduled_at, timezone: m.timezone, status: m.status, has_capture: m.has_capture, deal_stage: m.deal_stage, value: money(m.value_monthly, m.currency) })) };
  });

  tool(server, ctx, {
    name: "get_deal", title: "Get a deal", cls: "read",
    description: "One deal in full (company, owner, stage, value, next step, stale/stuck/slipping flags) with its stage history and meetings.",
    input: { deal_id: z.string().uuid() },
  }, async (a) => {
    const [{ data: d, error }, { data: hist }, { data: mts }] = await Promise.all([
      ctx.user.from("crm_deals_v").select("*").eq("id", a.deal_id).maybeSingle(),
      ctx.user.from("crm_stage_history").select("from_stage, to_stage, reason, changed_at").eq("deal_id", a.deal_id).order("changed_at"),
      ctx.user.from("crm_meetings_v").select("id, scheduled_at, status, contact_name, has_capture").eq("deal_id", a.deal_id).order("scheduled_at"),
    ]);
    if (error) throw new Error(error.message);
    if (!d) throw new McpError("E_NOT_FOUND", "deal not found");
    return { ...(d as Row), stage_history: hist ?? [], meetings: mts ?? [] };
  });
}
