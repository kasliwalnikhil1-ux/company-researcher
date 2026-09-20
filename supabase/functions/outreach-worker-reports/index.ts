// Scheduled report emails (cron hourly, job `outreach-reports` in 016).
//   sender_report  weekly sender report (Phase 1 checklist: "built, unscheduled") → owners + managers, and each sender's own alert recipients
//   digest         workspace digest: last period vs the one before, top sequences, what needs attention → owners + managers (+ recipients)
//   client_report  branded client report (item 23 level 3) → schedule recipients (+ the client's viewers), with a link to the portal
//
// When: weekly schedules go out on Monday, monthly ones on the 1st, at 08:00–08:59 in the WORKSPACE timezone (settings.timezone).
// If that hour was missed (deploy, outage) the next two hourly runs catch up; `last_sent_at` is claimed atomically before sending so a
// schedule can never go out twice. Manual run: POST {schedule_id, force:true} or {schedule_id, dry_run:true} (returns the HTML, sends nothing).
// Every number in these emails comes from the report RPCs; nothing is counted here.
import { admin, json, serve, requireCron, readJson, localParts, addDays, log, rpc, WEB_ORIGIN } from "../_shared/outreach/supabase.ts";
import { notifyWorkspace, workspaceBranding, workspaceRecipients, brandName, emailConfigured, type Branding, type NotifyResult } from "../_shared/outreach/notify.ts";
import { senderReportHtml, digestHtml, clientReportHtml, type SenderSection } from "../_shared/outreach/reports_email.ts";
import { weeklyReport, aiConfigured } from "../_shared/outreach/ai.ts";

type Row = Record<string, any>;

const SEND_HOUR = 8;
const CATCH_UP_HOURS = 2;          // 09:xx and 10:xx only send what 08:xx did not
const MAX_AI_SUMMARIES = 8;        // per run; the email is complete without them
const TIME_BUDGET_MS = 110_000;

function isDue(s: Row, lp: { date: string; hour: number; weekday: string }): boolean {
  if (lp.hour < SEND_HOUR || lp.hour > SEND_HOUR + CATCH_UP_HOURS) return false;
  if (s.cadence === "monthly" ? !lp.date.endsWith("-01") : lp.weekday !== "mon") return false;
  return !s.last_sent_at || Date.now() - new Date(s.last_sent_at).getTime() > guardMs(s.cadence);
}
const guardMs = (cadence: string) => (cadence === "monthly" ? 20 : 5) * 86400_000;

/** Inclusive dates in the workspace timezone: the 7 days before today, or the calendar month that just ended. */
function periodFor(cadence: string, today: string): { from: string; to: string } {
  const to = addDays(today, -1);
  if (cadence === "monthly") return { from: today.endsWith("-01") ? `${to.slice(0, 8)}01` : addDays(today, -30), to };
  return { from: addDays(today, -7), to };
}

/** Portal link for a client: the workspace's active custom domain when there is one (client-specific first), else the app. */
async function portalUrl(workspaceId: string, clientId: string): Promise<string> {
  const { data } = await admin.from("outreach_workspace_domains").select("hostname, client_id").eq("workspace_id", workspaceId).eq("status", "active");
  const d = (data ?? []).find((x) => x.client_id === clientId) ?? (data ?? []).find((x) => !x.client_id);
  return `${d ? `https://${d.hostname}` : WEB_ORIGIN}/outreach/c/${clientId}`;
}

interface Built { subject: string; title: string; html: string; extra?: Array<{ to: string[]; subject: string; title: string; html: string; senderId: string }> }

async function buildSenderReport(s: Row, branding: Branding, period: { from: string; to: string }, tz: string, ctx: { ai: number; started: number }): Promise<Built | null> {
  let q = admin.from("outreach_senders").select("id, display_name, owner_email, alert_emails, status").eq("workspace_id", s.workspace_id).is("deleted_at", null).neq("status", "disabled").order("display_name");
  if (s.client_id) q = q.eq("client_id", s.client_id);
  const { data: senders } = await q;
  if (!senders?.length) return null;
  const team = new Set(await workspaceRecipients(s.workspace_id, { extra: s.recipients ?? [] }));
  const sections: SenderSection[] = [];
  const extra: Built["extra"] = [];
  for (const sd of senders) {
    try {
      const report = await rpc<Row>("report_sender", { p_sender: sd.id, p_from: period.from, p_to: period.to });
      let insights: Row | null = null;
      try { insights = await rpc<Row>("sender_insights", { p_sender: sd.id }); } catch (e) { log({ fn: "reports", sender_id: sd.id, warn: `insights failed: ${String((e as any)?.message ?? e)}` }); }
      let aiSummary: string | null = null;
      const active = Number(report?.totals?.touches ?? 0) > 0 || Number(report?.totals?.replies ?? 0) > 0;
      if (active && aiConfigured() && ctx.ai < MAX_AI_SUMMARIES && Date.now() - ctx.started < TIME_BUDGET_MS / 2) {
        ctx.ai++;
        try { aiSummary = (await weeklyReport({ workspaceId: s.workspace_id, senderName: sd.display_name ?? "Sender", stats: { period: report.period, totals: report.totals, failures_by_reason: report.failures_by_reason, recommendations: insights?.recommendations ?? [], warmup: insights?.warmup ?? null } })).trim().slice(0, 1200) || null; }
        catch (e) { log({ fn: "reports", sender_id: sd.id, warn: `ai summary skipped: ${String((e as any)?.message ?? e)}` }); }
      }
      const section: SenderSection = { report, insights, aiSummary, url: `${WEB_ORIGIN}/outreach/senders/${sd.id}` };
      sections.push(section);
      // the sender's own alert recipients / owner get just their sender, unless they already receive the full report
      const own = [...new Set([...(sd.alert_emails ?? []), sd.owner_email].filter(Boolean).map((e: string) => String(e).toLowerCase()))].filter((e) => !team.has(e));
      if (own.length) extra.push({ to: own, senderId: sd.id, subject: `Weekly report for ${sd.display_name ?? "your sender"}`, title: `Weekly report: ${sd.display_name ?? "sender"}`, html: senderReportHtml([section], { ...report.period }, branding) });
    } catch (e) { log({ fn: "reports", sender_id: sd.id, error: `sender report failed: ${String((e as any)?.message ?? e)}` }); }
  }
  if (!sections.length) return null;
  return { subject: `Weekly sender report: ${sections.length} sender${sections.length === 1 ? "" : "s"}`, title: "Weekly sender report", html: senderReportHtml(sections, { from: period.from, to: period.to, timezone: tz }, branding), extra };
}

async function buildDigest(s: Row, branding: Branding, period: { from: string; to: string }): Promise<Built> {
  const overview = await rpc<Row>("report_overview", { p_ws: s.workspace_id, p_client: s.client_id ?? null, p_from: period.from, p_to: period.to, p_filters: {} });
  const sequences = await rpc<Row[]>("report_sequences", { p_ws: s.workspace_id, p_client: s.client_id ?? null, p_from: period.from, p_to: period.to });
  let attention: Row[] = [];
  try { attention = ((await rpc<Row>("dashboard", { p_ws: s.workspace_id }))?.attention ?? []) as Row[]; } catch (e) { log({ fn: "reports", warn: `dashboard failed: ${String((e as any)?.message ?? e)}` }); }
  const cadence = s.cadence === "monthly" ? "monthly" : "weekly";
  const t = overview?.totals ?? {};
  return {
    subject: `${cadence === "monthly" ? "Monthly" : "Weekly"} digest: ${Number(t.replies ?? 0)} replies, ${Number(t.interested ?? 0)} interested${attention.length ? `, ${attention.length} to look at` : ""}`,
    title: `${branding.workspace_name ?? brandName(branding)}: ${cadence} digest`,
    html: digestHtml({ overview, sequences: sequences ?? [], attention, origin: WEB_ORIGIN, cadence }, branding),
  };
}

async function buildClientReport(s: Row, branding: Branding, period: { from: string; to: string }): Promise<Built | null> {
  if (!s.client_id) return null;
  const report = await rpc<Row>("report_client", { p_client: s.client_id, p_from: period.from, p_to: period.to });
  const cadence = s.cadence === "monthly" ? "monthly" : "weekly";
  const name = report?.client?.name ?? "Your";
  return { subject: `${name}: ${cadence} outreach report`, title: `${name}: ${cadence} outreach report`, html: clientReportHtml({ report, cadence, portalUrl: await portalUrl(s.workspace_id, s.client_id) }, branding) };
}

serve("worker-reports", async (req) => {
  requireCron(req);
  const body = await readJson<{ schedule_id?: string; force?: boolean; dry_run?: boolean }>(req);
  const started = Date.now();
  let q = admin.from("outreach_report_schedules").select("*, outreach_workspaces!inner(id, name, plan, settings, deleted_at)").eq("active", true);
  if (body.schedule_id) q = q.eq("id", body.schedule_id);
  const { data: schedules, error } = await q.order("created_at");
  if (error) throw new Error(error.message);
  const ctx = { ai: 0, started };
  const results: Row[] = [];

  for (const s of schedules ?? []) {
    const ws = (s as any).outreach_workspaces;
    if (!ws || ws.deleted_at || ws.plan === "suspended") continue;
    const tz = String(ws.settings?.timezone ?? "UTC");
    let lp: ReturnType<typeof localParts>;
    try { lp = localParts(tz); } catch { lp = localParts("UTC"); }
    const manual = !!body.schedule_id && (!!body.force || !!body.dry_run);
    if (!manual && !isDue(s, lp)) continue;
    if (Date.now() - started > TIME_BUDGET_MS) { results.push({ id: s.id, kind: s.kind, skipped: "out of time, next run catches up" }); continue; }

    // claim first: two overlapping runs can never both send this schedule
    let claimed = false;
    if (!body.dry_run) {
      let claim = admin.from("outreach_report_schedules").update({ last_sent_at: new Date().toISOString() }).eq("id", s.id);
      claim = s.last_sent_at ? claim.eq("last_sent_at", s.last_sent_at) : claim.is("last_sent_at", null);
      const { data: got } = await claim.select("id");
      if (!got?.length) { results.push({ id: s.id, kind: s.kind, skipped: "already claimed" }); continue; }
      claimed = true;
    }
    const release = async () => { if (claimed) await admin.from("outreach_report_schedules").update({ last_sent_at: s.last_sent_at ?? null }).eq("id", s.id); };

    try {
      const branding = await workspaceBranding(s.workspace_id);
      const period = periodFor(s.cadence, lp.date);
      const built = s.kind === "sender_report" ? await buildSenderReport(s, branding, period, tz, ctx) : s.kind === "digest" ? await buildDigest(s, branding, period) : await buildClientReport(s, branding, period);
      if (!built) { results.push({ id: s.id, kind: s.kind, skipped: s.kind === "client_report" ? "no client on this schedule" : "nothing to report" }); continue; }
      if (body.dry_run) { results.push({ id: s.id, kind: s.kind, period, subject: built.subject, html: built.html, extra: (built.extra ?? []).map((x) => ({ to: x.to, subject: x.subject })) }); continue; }

      let r: NotifyResult;
      if (s.kind === "client_report") r = await notifyWorkspace(s.workspace_id, "client_report", { subject: built.subject, title: built.title, html: built.html }, { clientId: s.client_id, recipients: s.recipients ?? [], includeClientViewers: !!s.include_client_viewers, team: false });
      else r = await notifyWorkspace(s.workspace_id, s.kind === "digest" ? "weekly_digest" : "sender_weekly", { subject: built.subject, title: built.title, html: built.html }, { clientId: s.client_id ?? undefined, recipients: s.recipients ?? [] });
      let extraSent = 0;
      for (const x of built.extra ?? []) extraSent += (await notifyWorkspace(s.workspace_id, "sender_weekly", { subject: x.subject, title: x.title, html: x.html, entity_id: x.senderId }, { recipients: x.to, team: false })).sent;
      // A digest with "include client viewers" (plan item 10): viewers never get the team digest (it links into the agency's workspace);
      // each gets the client version for their own client instead.
      if (s.kind === "digest" && s.include_client_viewers) {
        let clientIds: string[] = s.client_id ? [s.client_id] : [];
        if (!s.client_id) {
          const { data: viewers } = await admin.from("outreach_members").select("client_ids").eq("workspace_id", s.workspace_id).eq("role", "client_viewer");
          clientIds = [...new Set((viewers ?? []).flatMap((v) => (v.client_ids ?? []) as string[]))].slice(0, 50);
        }
        for (const cid of clientIds) {
          try {
            const cr = await buildClientReport({ ...s, client_id: cid }, branding, period);
            if (cr) extraSent += (await notifyWorkspace(s.workspace_id, "client_report", { subject: cr.subject, title: cr.title, html: cr.html }, { clientId: cid, includeClientViewers: true, team: false })).sent;
          } catch (e) { log({ fn: "reports", schedule: s.id, client_id: cid, warn: `client copy of the digest failed: ${String((e as any)?.message ?? e)}` }); }
        }
      }
      // configured but nothing left the building: give the catch-up hours another go
      if (r.configured && r.recipients.length > 0 && r.sent === 0) await release();
      results.push({ id: s.id, kind: s.kind, period, recipients: r.recipients.length, sent: r.sent + extraSent, email_configured: r.configured });
    } catch (e) {
      await release();
      log({ fn: "reports", schedule: s.id, error: String((e as any)?.message ?? e) });
      results.push({ id: s.id, kind: s.kind, error: String((e as any)?.message ?? e) });
    }
  }
  return json({ ok: true, email_configured: emailConfigured(), processed: results.length, results });
});
