// F5 — Health (cron hourly; senders at local 02:xx) + on demand {sender_id}.
// Item 3  — every run: outreach_detect_stalls() → email owners, managers and the sender's alert recipients → mark_alerts_notified.
// Item 12 — nightly branch: refresh connections_count (at most once a day) and write the daily `snapshot` sender event.
import { admin, json, serve, requireCron, readJson, localParts, log, rpc } from "../_shared/outreach/supabase.ts";
import { healthForSender } from "../_shared/outreach/health.ts";
import { backfillChatPictures } from "../_shared/outreach/avatars.ts";
import { syncOwnProfile } from "../_shared/outreach/inbound.ts";
import { notifyWorkspace, emailConfigured, type WorkspaceNotifyKind } from "../_shared/outreach/notify.ts";

type Row = Record<string, any>;

/** Once per sender per day: the connections count the insights page uses for "network growth". */
async function dailySnapshot(senderId: string): Promise<boolean> {
  const since = new Date(Date.now() - 20 * 3600_000).toISOString();
  const { data: recent } = await admin.from("outreach_sender_events").select("id").eq("sender_id", senderId).eq("kind", "snapshot").gte("at", since).limit(1).maybeSingle();
  if (recent) return false;
  let { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s) return false;
  // own-profile read (users/me + own profile preview), LinkedIn senders that are connected only; never more than once a day
  if (s.provider === "LINKEDIN" && s.status === "ok" && s.unipile_account_id) {
    try { s = await syncOwnProfile(s); } catch (e) { log({ fn: "health", sender_id: senderId, warn: `profile refresh failed: ${String(e)}` }); }
  }
  await admin.from("outreach_sender_events").insert({ sender_id: senderId, kind: "snapshot", data: { connections_count: s.connections_count ?? null, health_score: s.health_score ?? null, warmup_level: s.warmup_level ?? null } });
  return true;
}

/** Emails for alerts that were opened and not yet announced (stalls, running dry, failed imports). */
async function announceAlerts(): Promise<Row> {
  const detected = await rpc<Row>("detect_stalls");
  // read from the table rather than only `opened`: failed imports are inserted by detect_stalls without being returned,
  // and an alert whose email could not be sent last hour gets another try (for one day).
  const { data: alerts, error } = await admin.from("outreach_alerts").select("*").is("notified_at", null).is("resolved_at", null)
    .in("kind", ["sequence_stalled", "sender_running_dry", "import_failed"]).gte("opened_at", new Date(Date.now() - 24 * 3600_000).toISOString()).order("opened_at").limit(200);
  if (error) throw new Error(error.message);
  const notified: string[] = [];
  let emails = 0;
  for (const a of alerts ?? []) {
    try {
      const r = await notifyWorkspace(a.workspace_id, a.kind as WorkspaceNotifyKind, { alert_id: a.id, entity_id: a.entity_id, label: a.label, reason: a.reason, detail: a.detail },
        { senderId: a.entity === "sender" ? a.entity_id : undefined, clientId: a.client_id ?? undefined });
      emails += r.sent;
      // done when at least one email left, when there is nobody to tell, or when email is switched off (the dashboard still shows the alert)
      if (r.sent > 0 || r.recipients.length === 0 || !r.configured) notified.push(a.id);
    } catch (e) { log({ fn: "health", alert: a.id, error: `alert email failed: ${String((e as any)?.message ?? e)}` }); }
  }
  if (notified.length) await rpc("mark_alerts_notified", { p_ids: notified });
  return { opened: (detected?.opened ?? []).length, resolved: detected?.resolved ?? 0, announced: notified.length, emails, email_configured: emailConfigured() };
}

serve("worker-health", async (req) => {
  requireCron(req);
  const body = await readJson<{ sender_id?: string; all?: boolean; skip_alerts?: boolean }>(req);
  const q = admin.from("outreach_senders").select("id, timezone, status").is("deleted_at", null).neq("status", "disabled");
  const { data: senders } = body.sender_id ? await q.eq("id", body.sender_id) : await q;
  const out: unknown[] = [];
  let snapshots = 0;
  for (const s of senders ?? []) {
    if (!body.sender_id && !body.all && localParts(s.timezone ?? "UTC").hour !== 2) continue;
    try { out.push({ id: s.id, ...(await healthForSender(s.id, "nightly")) }); } catch (e) { log({ fn: "health", sender_id: s.id, error: String(e) }); }
    try { if (await dailySnapshot(s.id)) snapshots++; } catch (e) { log({ fn: "health", sender_id: s.id, snapshot_error: String(e) }); }
  }
  let alerts: Row = {};
  if (!body.sender_id && !body.skip_alerts) { try { alerts = await announceAlerts(); } catch (e) { alerts = { error: String((e as any)?.message ?? e) }; log({ fn: "health", alerts_error: String(e) }); } }
  let pictures = 0;
  if (!body.sender_id) { try { pictures = await backfillChatPictures(); } catch (e) { log({ fn: "health", avatars_error: String(e) }); } }
  return json({ ok: true, computed: out.length, snapshots, alerts, pictures, results: out });
});
