// F2 — Inbound event dispatcher (cron every 10s). Dead-letters after 5 attempts.
import { admin, json, serve, requireCron, log } from "../_shared/outreach/supabase.ts";
import { handleAccountStatus, handleMessaging, handleNewRelation, handleMail, handleMailTracking, handleHostedNotify } from "../_shared/outreach/inbound.ts";

serve("process-inbound", async (req) => {
  requireCron(req);
  const started = Date.now();
  let processed = 0, failed = 0;
  while (Date.now() - started < 40_000) {
    const { data: events } = await admin.from("outreach_inbound_events").select("*").is("processed_at", null).eq("dead", false).lt("attempts", 5).order("id").limit(30);
    if (!events?.length) break;
    for (const ev of events) {
      await admin.from("outreach_inbound_events").update({ attempts: ev.attempts + 1 }).eq("id", ev.id);
      try {
        switch (ev.source) {
          case "account_status": await handleAccountStatus(ev.payload); break;
          case "hosted_notify": await handleHostedNotify(ev.payload); break;
          case "messaging": await handleMessaging(ev.payload); break;
          case "users": await handleNewRelation(ev.payload); break;
          case "mail": await handleMail(ev.payload); break;
          case "mail_tracking": await handleMailTracking(ev.payload); break;
          case "calendar": break; // v2
          default: log({ fn: "process-inbound", warn: "unknown source", id: ev.id, source: ev.source });
        }
        await admin.from("outreach_inbound_events").update({ processed_at: new Date().toISOString(), error: null }).eq("id", ev.id);
        processed++;
      } catch (e) {
        failed++;
        const msg = String((e as any)?.message ?? e);
        log({ fn: "process-inbound", id: ev.id, error: msg });
        await admin.from("outreach_inbound_events").update({ error: msg, dead: ev.attempts + 1 >= 5 }).eq("id", ev.id);
      }
    }
    if (events.length < 30) break;
  }
  return json({ ok: true, processed, failed });
});
