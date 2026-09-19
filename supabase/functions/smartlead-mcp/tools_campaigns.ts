// smartlead-mcp/tools_campaigns.ts — campaigns: reads, pause/resume, schedule, settings, sequences, draft creation.
//
// PRD §6.4: nothing here can START a campaign that this team did not pause.
// New campaigns land in DRAFTED; resume_campaign refuses anything that is not PAUSED.
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, type Row, tool, z, McpError, campaignId, confirmParam, rawParam, dateParam, gate, mapPool, trim, pct, short, log } from "./ctx.ts";
import { sl, body, rowsOf, pick, totalOf, campaignBrief, fetchCampaign, isLive, htmlToText } from "./smartlead.ts";

// ---------------------------------------------------------------------------
// Sequences: normalise Smartlead → compact steps, and back
// ---------------------------------------------------------------------------

interface Variant { id?: number; variant_label?: string; subject: string; email_body: string; distribution_pct?: number }
interface Step { id?: number; seq_number: number; delay_in_days: number; subject: string; email_body: string; variants?: Variant[]; _src?: Row }

export function normaliseSteps(r: unknown): Step[] {
  return rowsOf(r, "sequences").map((s): Step => {
    const vs = (pick(s, "sequence_variants", "seq_variants", "variants") ?? []) as Row[];
    const active = vs.filter((v) => v && v.is_deleted !== true);
    return {
      id: s.id != null ? Number(s.id) : undefined,
      seq_number: Number(s.seq_number),
      delay_in_days: Number(pick(s, "seq_delay_details.delay_in_days", "seq_delay_details.delayInDays", "delay_in_days") ?? 0),
      subject: String(s.subject ?? ""),
      email_body: String(s.email_body ?? ""),
      variants: active.length ? active.map((v) => ({ id: v.id != null ? Number(v.id) : undefined, variant_label: pick(v, "variant_label", "variant_name"), subject: String(v.subject ?? ""), email_body: String(v.email_body ?? ""), distribution_pct: pick(v, "variant_distribution_percentage") })) : undefined,
      _src: s,
    };
  }).sort((a, b) => a.seq_number - b.seq_number);
}

const stepOut = (s: Step, format: "html" | "text") => ({
  step_id: s.id, seq_number: s.seq_number, delay_in_days: s.delay_in_days,
  subject: s.subject, threads_as_reply: s.seq_number > 1 && s.subject.trim() === "" ? true : undefined,
  email_body: format === "text" ? htmlToText(s.email_body) : s.email_body,
  variants: s.variants?.map((v) => ({ variant_id: v.id, variant_label: v.variant_label, subject: v.subject, email_body: format === "text" ? htmlToText(v.email_body) : v.email_body, distribution_pct: v.distribution_pct })),
});

const stepInput = z.object({
  id: z.number().int().positive().optional().describe("step_id from get_campaign_sequences for an existing step (filled in from seq_number when omitted); leave out for a new step"),
  seq_number: z.number().int().min(1).max(20),
  delay_in_days: z.number().int().min(0).max(90).describe("Days after the previous step (step 1: days after the lead is added, normally 0)"),
  subject: z.string().max(300).describe("Subject. On step 2+ an EMPTY string is deliberate: it threads the mail as a reply to step 1. Send it back empty."),
  email_body: z.string().max(50_000).describe("HTML body. Smartlead variables like {{first_name}} are kept as they are."),
  variants: z.array(z.object({ id: z.number().int().positive().optional(), variant_label: z.string().max(10).describe("A, B, C …"), subject: z.string().max(300), email_body: z.string().max(50_000) })).max(5).optional().describe("A/B variants. When present they carry the copy and the step-level subject/body are ignored by Smartlead."),
});

function describeChange(cur: Step | undefined, next: z.infer<typeof stepInput>): string | null {
  if (!cur) return `step ${next.seq_number}: NEW — +${next.delay_in_days}d, subject ${next.subject.trim() === "" ? "(empty → threads as reply)" : JSON.stringify(short(next.subject, 80))}, ${htmlToText(next.email_body).length} chars${next.variants?.length ? `, ${next.variants.length} variants` : ""}`;
  const d: string[] = [];
  if (cur.delay_in_days !== next.delay_in_days) d.push(`delay ${cur.delay_in_days}d → ${next.delay_in_days}d`);
  if (cur.subject !== next.subject) d.push(`subject ${JSON.stringify(short(cur.subject, 60) ?? "")} → ${next.subject.trim() === "" ? "(empty → threads as reply)" : JSON.stringify(short(next.subject, 60))}`);
  if (cur.email_body !== next.email_body) d.push(`body rewritten (${htmlToText(cur.email_body).length} → ${htmlToText(next.email_body).length} chars): "${short(htmlToText(next.email_body).replace(/\s+/g, " "), 140)}"`);
  const cv = cur.variants ?? [], nv = next.variants ?? [];
  if (JSON.stringify(cv.map((v) => [v.variant_label, v.subject, v.email_body])) !== JSON.stringify(nv.map((v) => [v.variant_label, v.subject, v.email_body]))) d.push(`variants ${cv.map((v) => v.variant_label).join("/") || "none"} → ${nv.map((v) => v.variant_label).join("/") || "none"}${nv.length ? " (copy changed)" : ""}`);
  return d.length ? `step ${next.seq_number}: ${d.join("; ")}` : null;
}

function toSmartleadStep(next: z.infer<typeof stepInput>, cur: Step | undefined): Row {
  const o: Row = { seq_number: next.seq_number, seq_delay_details: { delay_in_days: next.delay_in_days } };
  const id = next.id ?? cur?.id;
  if (id) o.id = id;
  if (next.variants?.length) {
    const src = cur?._src ?? {};
    o.variant_distribution_type = pick(src, "variant_distribution_type") ?? "MANUAL_EQUAL";
    if (pick(src, "lead_distribution_percentage") != null) o.lead_distribution_percentage = pick(src, "lead_distribution_percentage");
    if (pick(src, "winning_metric_property") != null) o.winning_metric_property = pick(src, "winning_metric_property");
    o.seq_variants = next.variants.map((v) => {
      const old = cur?.variants?.find((x) => (v.id && x.id === v.id) || x.variant_label === v.variant_label);
      const r: Row = { subject: v.subject, email_body: v.email_body, variant_label: v.variant_label };
      if (v.id ?? old?.id) r.id = v.id ?? old?.id;
      if (old?.distribution_pct != null) r.variant_distribution_percentage = old.distribution_pct;
      return r;
    });
  } else {
    o.subject = next.subject; // never "fixed": an empty subject on step 2+ is how Smartlead threads the follow-up
    o.email_body = next.email_body;
  }
  return o;
}

async function setStatus(id: number, status: "PAUSED" | "START"): Promise<unknown> {
  return await sl("POST", `/campaigns/${id}/status`, { body: { status } });
}

// ---------------------------------------------------------------------------
// Schedule merge (Smartlead's schedule save wants the whole schedule)
// ---------------------------------------------------------------------------

interface SchedulePatch { timezone?: string; days_of_the_week?: number[]; start_hour?: string; end_hour?: string; min_time_btw_emails?: number; max_new_leads_per_day?: number; schedule_start_time?: string }

async function saveSchedule(id: number, patch: SchedulePatch): Promise<{ before: Row; after: Row; campaign: Row }> {
  const c = await fetchCampaign(id);
  const b = campaignBrief(c);
  const before: Row = { timezone: b.schedule?.timezone, days_of_the_week: b.schedule?.days_of_the_week, start_hour: b.schedule?.start_hour, end_hour: b.schedule?.end_hour, min_time_btw_emails: b.min_time_btw_emails, max_new_leads_per_day: b.max_new_leads_per_day };
  const after: Row = { ...before };
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) after[k] = v;
  const missing = ["timezone", "days_of_the_week", "start_hour", "end_hour", "min_time_btw_emails", "max_new_leads_per_day"].filter((k) => after[k] === undefined || after[k] === null);
  if (missing.length) throw new McpError("E_PAYLOAD_INVALID", `this campaign has no complete schedule yet — also pass: ${missing.join(", ")}`);
  if (String(after.start_hour) >= String(after.end_hour)) throw new McpError("E_PAYLOAD_INVALID", "start_hour must be before end_hour (HH:MM, 24h)");
  await sl("POST", `/campaigns/${id}/schedule`, { body: after });
  return { before, after, campaign: c };
}

export function registerCampaigns(server: McpServer, ctx: Ctx): void {
  // ------------------------------------------------------------------ reads
  tool(server, ctx, {
    name: "list_campaigns", title: "List campaigns", cls: "read",
    description: "Campaigns with id, name, status (DRAFTED / ACTIVE / PAUSED / STOPPED / COMPLETED / ARCHIVED), schedule and daily new-lead cap. ACTIVE means cold mail is going out. include_mailboxes:true also lists the mailboxes in each campaign's rotation (one extra call per campaign, first 15 shown campaigns). Archived campaigns are hidden unless status asks for them.",
    input: { status: z.enum(["DRAFTED", "ACTIVE", "PAUSED", "STOPPED", "COMPLETED", "ARCHIVED"]).optional(), search: z.string().optional().describe("Substring of the campaign name"), include_mailboxes: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), ...rawParam },
  }, async (a) => {
    const r = await sl("GET", "/campaigns/");
    let list = rowsOf(r, "campaigns").map(campaignBrief);
    const by: Record<string, number> = {}; for (const c of list) by[String(c.status)] = (by[String(c.status)] ?? 0) + 1;
    list = a.status ? list.filter((c) => String(c.status).toUpperCase() === a.status) : list.filter((c) => String(c.status).toUpperCase() !== "ARCHIVED");
    if (a.search) { const s = a.search.toLowerCase(); list = list.filter((c) => String(c.name ?? "").toLowerCase().includes(s)); }
    list.sort((x, y) => Number(isLive(y.status)) - Number(isLive(x.status)) || String(y.created_at ?? "").localeCompare(String(x.created_at ?? "")));
    const lim = a.limit ?? 25, shown: Row[] = list.slice(0, lim);
    if (a.include_mailboxes) {
      await mapPool(shown.slice(0, 15), 4, async (c) => {
        try { c.mailboxes = rowsOf(await sl("GET", `/campaigns/${c.id}/email-accounts`)).map((m) => ({ id: m.id, email: pick(m, "from_email", "email") })); } catch (e) { c.mailboxes_error = e instanceof Error ? e.message : String(e); }
      });
    }
    return { total: Object.values(by).reduce((s, n) => s + n, 0), by_status: by, shown: shown.length, more: list.length > lim ? list.length - lim : undefined, campaigns: shown, raw: a.raw ? trim(rowsOf(r, "campaigns").slice(0, 2)) : undefined };
  });

  tool(server, ctx, {
    name: "get_campaign_analytics", title: "Campaign analytics", cls: "read",
    description: "Performance of one campaign: sent, opened, clicked, replied, bounced, unsubscribed, lead funnel (not started / in progress / completed / blocked) and positive (interested) replies, with rates computed on sent. from/to limit it to a date range. by_step:true adds sent / replied / bounced per sequence step (step-level reply rate — the input for copy iteration; two small calls per step).",
    input: { campaign_id: campaignId, from: dateParam("Range start").optional(), to: dateParam("Range end").optional(), by_step: z.boolean().optional(), ...rawParam },
  }, async (a) => {
    if ((a.from && !a.to) || (!a.from && a.to)) throw new McpError("E_PAYLOAD_INVALID", "pass both from and to, or neither");
    const r = a.from ? await sl("GET", `/campaigns/${a.campaign_id}/analytics-by-date`, { query: { start_date: a.from, end_date: a.to } }) : await sl("GET", `/campaigns/${a.campaign_id}/analytics`);
    const b = (body(r) ?? {}) as Row;
    const n = (...k: string[]) => { const v = pick(b, ...k); return v == null ? undefined : Number(v); };
    const sent = n("sent_count", "unique_sent_count", "sent", "contacted") ?? 0;
    const replied = n("reply_count", "replied"), bounced = n("bounce_count", "bounced"), opened = n("unique_open_count", "open_count", "opened"), clicked = n("unique_click_count", "click_count", "clicked"), unsub = n("unsubscribed_count", "unsubscribed");
    const ls = (pick(b, "campaign_lead_stats", "lead_stats") ?? {}) as Row;
    const positive = n("campaign_lead_stats.interested", "interested_count", "positive_reply_count");
    const res: Row = {
      campaign_id: a.campaign_id, name: b.name, status: b.status, range: a.from ? `${a.from}..${a.to}` : "all time",
      sent, opened, clicked, replied, positive_replies: positive, bounced, unsubscribed: unsub,
      rates_pct: { open: opened != null ? pct(opened, sent) : undefined, reply: replied != null ? pct(replied, sent) : undefined, positive_reply: positive != null ? pct(positive, sent) : undefined, bounce: bounced != null ? pct(bounced, sent) : undefined },
      leads: Object.keys(ls).length ? ls : undefined, sequence_count: b.sequence_count,
      bounce_alert: bounced != null && sent >= 50 && bounced / sent > ctx.settings.bounce_rate_threshold ? `bounce rate ${pct(bounced, sent)}% is over the ${ctx.settings.bounce_rate_threshold * 100}% threshold — consider pause_campaign and a list check` : undefined,
    };
    if (a.by_step) {
      const steps = normaliseSteps(await sl("GET", `/campaigns/${a.campaign_id}/sequences`));
      const q = (seq: number, status?: string) => sl("GET", `/campaigns/${a.campaign_id}/statistics`, { query: { offset: 0, limit: 1, email_sequence_number: seq, email_status: status, sent_time_start_date: a.from, sent_time_end_date: a.to } }).then(totalOf).catch(() => undefined);
      res.steps = await mapPool(steps, 3, async (s) => {
        const [st, rp, bo] = await Promise.all([q(s.seq_number), q(s.seq_number, "replied"), q(s.seq_number, "bounced")]);
        return { seq_number: s.seq_number, subject: s.subject || (s.variants?.[0]?.subject ?? "") || "(threads as reply)", delay_in_days: s.delay_in_days, variants: s.variants?.map((v) => v.variant_label).join("/"), sent: st, replied: rp, bounced: bo, reply_rate_pct: st != null && rp != null ? pct(rp, st) : undefined };
      });
      if ((res.steps as Row[]).every((s) => s.sent === undefined)) res.steps_note = "Smartlead did not return per-step totals on the statistics endpoint; compare steps in the Smartlead UI, or use raw:true to inspect.";
    }
    if (a.raw) res.raw = trim(r);
    return res;
  });

  tool(server, ctx, {
    name: "get_campaign_sequences", title: "Campaign sequence (steps + copy)", cls: "read",
    description: "The current steps of a campaign: step_id, seq_number, delay_in_days, subject, body and A/B variants. ALWAYS call this immediately before update_campaign_sequences — that save replaces the whole sequence, so you need every step (with its step_id) to send back. format:\"html\" (default) is what you must send back when editing; format:\"text\" is for reading. `threads_as_reply: true` marks a step 2+ whose subject is deliberately empty.",
    input: { campaign_id: campaignId, format: z.enum(["html", "text"]).optional(), ...rawParam },
  }, async (a) => {
    const [r, c] = await Promise.all([sl("GET", `/campaigns/${a.campaign_id}/sequences`), fetchCampaign(a.campaign_id)]);
    const steps = normaliseSteps(r);
    return { campaign_id: a.campaign_id, name: c.name, status: c.status, editable_now: !isLive(c.status), note: isLive(c.status) ? "ACTIVE: Smartlead refuses sequence edits while active — update_campaign_sequences pauses, saves and resumes in one call." : undefined, step_count: steps.length, steps: steps.map((s) => stepOut(s, a.format ?? "html")), raw: a.raw ? trim(r, 5, 300) : undefined };
  });

  tool(server, ctx, {
    name: "get_campaign_settings", title: "Campaign settings", cls: "read",
    description: "How a campaign sends: status, schedule (timezone, days, hours), minutes between emails, max new leads per day (the daily cap), tracking toggles, stop-on-reply rule, plain-text flag, follow-up percentage, and the mailbox rotation set (id + address).",
    input: { campaign_id: campaignId, ...rawParam },
  }, async (a) => {
    const [c, m] = await Promise.all([fetchCampaign(a.campaign_id), sl("GET", `/campaigns/${a.campaign_id}/email-accounts`).catch(() => [])]);
    const boxes = rowsOf(m);
    return {
      ...campaignBrief(c),
      track_settings: c.track_settings, stop_lead_settings: c.stop_lead_settings, send_as_plain_text: c.send_as_plain_text, follow_up_percentage: c.follow_up_percentage, enable_ai_esp_matching: c.enable_ai_esp_matching, unsubscribe_text: short(c.unsubscribe_text, 200),
      rotation: boxes.map((x) => ({ id: x.id, email: pick(x, "from_email", "email"), daily_limit: pick(x, "message_per_day"), sent_today: pick(x, "daily_sent_count"), warmup: pick(x, "warmup_details.status") })),
      rotation_capacity_per_day: boxes.reduce((s, x) => s + (Number(pick(x, "message_per_day")) || 0), 0) || undefined,
      raw: a.raw ? trim(c) : undefined,
    };
  });

  // ------------------------------------------------------------ pause / resume
  tool(server, ctx, {
    name: "pause_campaign", title: "Pause a campaign", cls: "write",
    description: "Stop a campaign's cold sending now (status → PAUSED). Safe and reversible; use it on a burn-check recommendation once the human agrees. Leads keep their position. Returns the status before and after.",
    input: { campaign_id: campaignId, reason: z.string().max(300).optional().describe("Why — kept in the connector log") },
    annotations: { idempotentHint: true },
  }, async (a) => {
    const c = await fetchCampaign(a.campaign_id);
    if (/^PAUSED$/i.test(String(c.status))) return { campaign_id: a.campaign_id, name: c.name, status: "PAUSED", changed: false };
    if (!isLive(c.status)) throw new McpError("E_PAYLOAD_INVALID", `campaign "${c.name}" is ${c.status}, not sending — nothing to pause`);
    await setStatus(a.campaign_id, "PAUSED");
    log({ fn: "smartlead-mcp", event: "pause_campaign", user: ctx.userId, campaign: a.campaign_id, reason: a.reason });
    return { campaign_id: a.campaign_id, name: c.name, before: c.status, status: "PAUSED", changed: true };
  });

  tool(server, ctx, {
    name: "resume_campaign", title: "Resume a paused campaign", cls: "gated",
    description: "Resume a campaign that is currently PAUSED — cold sending restarts at the next schedule window, so this is confirmation-gated (first call returns an effect_summary + confirmation_token; nothing happens until the human says yes). Refuses anything that is not PAUSED: starting a DRAFTED campaign is a human action in the Smartlead UI, by design.",
    input: { campaign_id: campaignId, ...confirmParam },
  }, async (a) => {
    const c = await fetchCampaign(a.campaign_id);
    if (!/^PAUSED$/i.test(String(c.status))) throw new McpError("E_NOT_PAUSED", `campaign "${c.name}" is ${c.status}; only a PAUSED campaign can be resumed from here`);
    const [an, boxes] = await Promise.all([sl("GET", `/campaigns/${a.campaign_id}/analytics`).then((r) => body(r) as Row).catch(() => ({} as Row)), sl("GET", `/campaigns/${a.campaign_id}/email-accounts`).then((r) => rowsOf(r)).catch(() => [] as Row[])]);
    const ls = (pick(an, "campaign_lead_stats") ?? {}) as Row, b = campaignBrief(c);
    const summary = `RESUME COLD SENDING — campaign "${c.name}" (#${a.campaign_id}), currently PAUSED.\nLeads waiting: ${ls.notStarted ?? "?"} not started, ${ls.inprogress ?? "?"} in progress.\nMailboxes in rotation: ${boxes.length}${boxes.length ? ` (${boxes.slice(0, 6).map((x) => pick(x, "from_email", "email")).join(", ")}${boxes.length > 6 ? ", …" : ""})` : ""}.\nSchedule: ${b.schedule ? `${(b.schedule.days_of_the_week ?? []).join(",")} ${b.schedule.start_hour}–${b.schedule.end_hour} ${b.schedule.timezone}` : "?"}, max ${b.max_new_leads_per_day ?? "?"} new leads/day.\nReal emails go out to these leads at the next window.`;
    const g = await gate(ctx, "resume_campaign", a, summary);
    if (!g.proceed) return g.result;
    await setStatus(a.campaign_id, "START");
    log({ fn: "smartlead-mcp", event: "resume_campaign", user: ctx.userId, campaign: a.campaign_id });
    return { campaign_id: a.campaign_id, name: c.name, before: "PAUSED", status: "ACTIVE", changed: true };
  });

  // --------------------------------------------------------- schedule / settings
  tool(server, ctx, {
    name: "update_campaign_schedule", title: "Update when a campaign sends", cls: "write",
    description: "Change WHEN a campaign sends: timezone (IANA), days_of_the_week (0=Sun … 6=Sat; weekdays = [1,2,3,4,5]), start_hour / end_hour (\"09:00\", 24h), min_time_btw_emails (minutes), max_new_leads_per_day (the daily cap). Pass only what changes — the rest is kept from the current schedule. Returns before and after. On an ACTIVE campaign this takes effect immediately: state the change to the human and get a yes first; never raise max_new_leads_per_day or cut min_time_btw_emails to 'catch up' — that is how mailboxes burn.",
    input: {
      campaign_id: campaignId,
      timezone: z.string().optional(), days_of_the_week: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
      start_hour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").optional(), end_hour: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").optional(),
      min_time_btw_emails: z.number().int().min(1).max(1440).optional().describe("Minutes between two emails from the campaign"),
      max_new_leads_per_day: z.number().int().min(1).max(5000).optional(),
      schedule_start_time: z.string().optional().describe("ISO datetime the campaign may start sending from (optional)"),
    },
  }, async (a) => {
    const { campaign_id, ...patch } = a;
    if (Object.values(patch).every((v) => v === undefined)) throw new McpError("E_PAYLOAD_INVALID", "nothing to change — pass at least one schedule field");
    if (patch.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: patch.timezone }); } catch { throw new McpError("E_PAYLOAD_INVALID", `unknown timezone ${patch.timezone} (use IANA, e.g. America/New_York)`); } }
    const r = await saveSchedule(campaign_id, patch);
    return { campaign_id, name: r.campaign.name, status: r.campaign.status, before: r.before, after: r.after, live: isLive(r.campaign.status) ? "campaign is ACTIVE — the new schedule applies from now" : undefined };
  });

  tool(server, ctx, {
    name: "update_campaign_settings", title: "Update campaign settings / rotation", cls: "write",
    description: "Change HOW a campaign sends: tracking toggles (track_opens / track_clicks), stop_lead_settings (when follow-ups stop), send_as_plain_text, follow_up_percentage, max_new_leads_per_day (daily cap — saved on the schedule), and the mailbox rotation set: add_email_account_ids / remove_email_account_ids. Removing a burning mailbox from rotation is the usual burn-check action; it is reversible (add it back). Pass only what changes. Never add a mailbox that is still warming or flagged by get_account_deliverability.",
    input: {
      campaign_id: campaignId,
      track_opens: z.boolean().optional(), track_clicks: z.boolean().optional(),
      stop_lead_settings: z.enum(["REPLY_TO_AN_EMAIL", "CLICK_ON_A_LINK", "OPEN_AN_EMAIL"]).optional(),
      send_as_plain_text: z.boolean().optional(), follow_up_percentage: z.number().int().min(0).max(100).optional(),
      max_new_leads_per_day: z.number().int().min(1).max(5000).optional(),
      add_email_account_ids: z.array(z.number().int().positive()).max(50).optional(), remove_email_account_ids: z.array(z.number().int().positive()).max(50).optional(),
    },
  }, async (a) => {
    const c = await fetchCampaign(a.campaign_id);
    const done: Row = {};
    const touchesSettings = [a.track_opens, a.track_clicks, a.stop_lead_settings, a.send_as_plain_text, a.follow_up_percentage].some((v) => v !== undefined);
    if (!touchesSettings && a.max_new_leads_per_day === undefined && !a.add_email_account_ids?.length && !a.remove_email_account_ids?.length) throw new McpError("E_PAYLOAD_INVALID", "nothing to change");
    const overlap = (a.add_email_account_ids ?? []).filter((x) => (a.remove_email_account_ids ?? []).includes(x));
    if (overlap.length) throw new McpError("E_PAYLOAD_INVALID", `mailbox ids in both add and remove: ${overlap.join(", ")}`);

    if (touchesSettings) {
      const track = new Set<string>(Array.isArray(c.track_settings) ? c.track_settings : []);
      const flag = (on: boolean | undefined, key: string) => { if (on === true) track.delete(key); if (on === false) track.add(key); };
      flag(a.track_opens, "DONT_TRACK_EMAIL_OPEN"); flag(a.track_clicks, "DONT_TRACK_LINK_CLICK");
      const payload: Row = { track_settings: [...track] };
      const keep = (k: string, v: unknown) => { const val = v !== undefined ? v : c[k]; if (val !== undefined && val !== null) payload[k] = val; };
      keep("stop_lead_settings", a.stop_lead_settings); keep("send_as_plain_text", a.send_as_plain_text); keep("follow_up_percentage", a.follow_up_percentage);
      keep("unsubscribe_text", undefined); keep("enable_ai_esp_matching", undefined);
      await sl("POST", `/campaigns/${a.campaign_id}/settings`, { body: payload });
      done.settings = { before: { track_settings: c.track_settings, stop_lead_settings: c.stop_lead_settings, send_as_plain_text: c.send_as_plain_text, follow_up_percentage: c.follow_up_percentage }, after: payload };
    }
    if (a.max_new_leads_per_day !== undefined) { const r = await saveSchedule(a.campaign_id, { max_new_leads_per_day: a.max_new_leads_per_day }); done.daily_cap = { before: r.before.max_new_leads_per_day, after: r.after.max_new_leads_per_day }; }
    if (a.remove_email_account_ids?.length) { await sl("DELETE", `/campaigns/${a.campaign_id}/email-accounts`, { body: { email_account_ids: a.remove_email_account_ids } }); done.removed_from_rotation = a.remove_email_account_ids; }
    if (a.add_email_account_ids?.length) { await sl("POST", `/campaigns/${a.campaign_id}/email-accounts`, { body: { email_account_ids: a.add_email_account_ids } }); done.added_to_rotation = a.add_email_account_ids; }
    if (done.removed_from_rotation || done.added_to_rotation) done.rotation_now = rowsOf(await sl("GET", `/campaigns/${a.campaign_id}/email-accounts`).catch(() => [])).map((x) => ({ id: x.id, email: pick(x, "from_email", "email") }));
    return { campaign_id: a.campaign_id, name: c.name, status: c.status, ...done };
  });

  // ------------------------------------------------------------------ sequences
  tool(server, ctx, {
    name: "update_campaign_sequences", title: "Save a campaign's sequence (copy + spacing)", cls: "gated",
    description: `Replace the steps of a campaign. Three rules, enforced here:
1. THE SAVE REPLACES THE ENTIRE SEQUENCE. Call get_campaign_sequences first and send EVERY step back (changed or not), each with its step id. A step you leave out is deleted — so this tool refuses a save that drops an existing step unless its seq_number is listed in remove_seq_numbers.
2. Smartlead cannot modify an ACTIVE campaign. This tool does pause → save → resume as one operation (it resumes only if it paused). If the resume fails you get E_LEFT_PAUSED — tell the human immediately.
3. AN EMPTY SUBJECT ON STEP 2+ IS DELIBERATE: it threads the follow-up as a reply to step 1. Never fill in a missing subject.
Confirmation-gated: the first call returns a per-step diff as effect_summary + confirmation_token and changes nothing; call again with the same arguments + token after the human approves the copy.`,
    input: {
      campaign_id: campaignId,
      sequences: z.array(stepInput).min(1).max(20).describe("The COMPLETE new sequence, every step"),
      remove_seq_numbers: z.array(z.number().int().min(1)).max(20).optional().describe("Existing steps you are deleting on purpose (the human asked for it)"),
      ...confirmParam,
    },
  }, async (a) => {
    const nums = a.sequences.map((s) => s.seq_number);
    if (new Set(nums).size !== nums.length) throw new McpError("E_PAYLOAD_INVALID", "duplicate seq_number in sequences");
    const sorted = [...a.sequences].sort((x, y) => x.seq_number - y.seq_number);
    if (sorted.some((s, i) => s.seq_number !== i + 1)) throw new McpError("E_PAYLOAD_INVALID", `seq_number must run 1..${sorted.length} without gaps (got ${nums.join(", ")})`);
    const first = sorted[0];
    if (!(first.variants?.length ? first.variants.every((v) => v.subject.trim()) : first.subject.trim())) throw new McpError("E_PAYLOAD_INVALID", "step 1 needs a subject (only step 2+ may be empty, to thread as a reply)");
    for (const s of sorted) if (!(s.variants?.length ? s.variants.every((v) => htmlToText(v.email_body)) : htmlToText(s.email_body))) throw new McpError("E_PAYLOAD_INVALID", `step ${s.seq_number} has an empty body`);

    const [curRaw, c] = await Promise.all([sl("GET", `/campaigns/${a.campaign_id}/sequences`), fetchCampaign(a.campaign_id)]);
    const current = normaliseSteps(curRaw);
    const curBy = new Map(current.map((s) => [s.seq_number, s]));
    // A step "survives" if its id (or, without an id, its seq_number) is sent back.
    const sentIds = new Set(sorted.map((s) => s.id).filter(Boolean));
    const dropped = current.filter((s) => !(s.id && sentIds.has(s.id)) && !sorted.some((n) => !n.id && n.seq_number === s.seq_number));
    const unack = dropped.filter((s) => !(a.remove_seq_numbers ?? []).includes(s.seq_number));
    if (unack.length) throw new McpError("E_SEQUENCE_INCOMPLETE", `this save would delete existing step(s) ${unack.map((s) => `#${s.seq_number} (step_id ${s.id}, "${short(s.subject || htmlToText(s.email_body), 50)}")`).join(", ")}`, undefined, { current_steps: current.map((s) => ({ step_id: s.id, seq_number: s.seq_number })) });
    const curFor = (n: z.infer<typeof stepInput>) => (n.id ? current.find((s) => s.id === n.id) : curBy.get(n.seq_number));
    const unknownIds = sorted.filter((n) => n.id && !current.some((s) => s.id === n.id));
    if (unknownIds.length) throw new McpError("E_PAYLOAD_INVALID", `step id(s) ${unknownIds.map((n) => n.id).join(", ")} are not in this campaign — re-read get_campaign_sequences`);

    const changes = sorted.map((n) => describeChange(curFor(n), n)).filter(Boolean) as string[];
    if (dropped.length) changes.push(...dropped.map((s) => `step ${s.seq_number}: DELETED (step_id ${s.id})`));
    if (changes.length === 0) return { campaign_id: a.campaign_id, name: c.name, changed: false, note: "identical to the current sequence — nothing saved" };

    const live = isLive(c.status);
    const summary = `SAVE SEQUENCE — campaign "${c.name}" (#${a.campaign_id}), status ${c.status}. ${current.length} step(s) now → ${sorted.length} after.\n${changes.join("\n")}\n${live ? "The campaign is ACTIVE: it will be PAUSED, saved and RESUMED in one operation. Leads already past a step are not re-sent it; leads still before it get the new copy." : "The campaign is not sending; it stays " + c.status + "."}`;
    const g = await gate(ctx, "update_campaign_sequences", a, summary);
    if (!g.proceed) return g.result;

    const payload = { sequences: sorted.map((n) => toSmartleadStep(n, curFor(n))) };
    let paused = false, saveError: unknown = null, saved: unknown = null;
    if (live) { await setStatus(a.campaign_id, "PAUSED"); paused = true; }
    try { saved = await sl("POST", `/campaigns/${a.campaign_id}/sequences`, { body: payload }); } catch (e) { saveError = e; }
    if (paused) {
      let resumed = false, resumeErr = "";
      for (let i = 0; i < 2 && !resumed; i++) { try { await setStatus(a.campaign_id, "START"); resumed = true; } catch (e) { resumeErr = e instanceof Error ? e.message : String(e); } }
      if (!resumed) {
        log({ fn: "smartlead-mcp", event: "LEFT_PAUSED", campaign: a.campaign_id, user: ctx.userId, resumeErr });
        throw new McpError("E_LEFT_PAUSED", `campaign "${c.name}" (#${a.campaign_id}) is still PAUSED: the sequence ${saveError ? "save FAILED" : "was saved"} but the resume failed (${resumeErr})`, undefined, { sequence_saved: !saveError, save_error: saveError instanceof Error ? saveError.message : undefined });
      }
    }
    if (saveError) { if (saveError instanceof McpError) { saveError.message = `${saveError.message}${paused ? " — the campaign was resumed with its OLD sequence" : ""}`; } throw saveError; }
    log({ fn: "smartlead-mcp", event: "update_sequences", user: ctx.userId, campaign: a.campaign_id, steps: sorted.length });
    const after = normaliseSteps(await sl("GET", `/campaigns/${a.campaign_id}/sequences`).catch(() => []));
    return { campaign_id: a.campaign_id, name: c.name, changed: true, status: live ? "ACTIVE (paused → saved → resumed)" : c.status, changes, steps_now: after.map((s) => ({ step_id: s.id, seq_number: s.seq_number, delay_in_days: s.delay_in_days, subject: s.subject || "(empty → threads as reply)", variants: s.variants?.map((v) => v.variant_label).join("/") })), smartlead: trim(saved, 5, 200) };
  });

  // ---------------------------------------------------------------- create draft
  tool(server, ctx, {
    name: "create_draft_campaign", title: "Create a draft campaign", cls: "write",
    description: "Create a new, empty campaign. It is always DRAFTED: it sends nothing, and this connector cannot start it — a human presses Start in the Smartlead UI after review. Then set it up with update_campaign_sequences, update_campaign_schedule, update_campaign_settings (add_email_account_ids) and add_leads_to_campaign.",
    input: { name: z.string().min(3).max(120) },
  }, async (a) => {
    const r = body(await sl("POST", "/campaigns/create", { body: { name: a.name.trim() } })) as Row;
    const id = Number(pick(r, "id", "campaign_id"));
    if (!Number.isFinite(id)) throw new McpError("E_SMARTLEAD_HTTP", "Smartlead did not return a campaign id", undefined, trim(r));
    log({ fn: "smartlead-mcp", event: "create_draft_campaign", user: ctx.userId, campaign: id });
    return { campaign_id: id, name: pick(r, "name") ?? a.name.trim(), status: "DRAFTED", next: "Add steps (update_campaign_sequences), a schedule, mailboxes and leads. Starting it is a human action in the Smartlead UI." };
  });
}
