// F4 — Planner (cron hourly: nightly plans for senders at local 00:xx; every 20 min: intraday top-up).
import { admin, json, serve, requireCron, readJson, flag, log } from "../_shared/outreach/supabase.ts";
import { planSender, selectSenders } from "../_shared/outreach/planner.ts";

serve("worker-planner", async (req) => {
  requireCron(req);
  if ((await flag("planner_enabled", true)) === false) return json({ ok: true, skipped: "planner_disabled" });
  const body = await readJson<{ mode?: "nightly" | "topup"; sender_id?: string }>(req);
  const mode = body.mode === "topup" ? "topup" : "nightly";
  let senders = body.sender_id ? (await admin.from("outreach_senders").select("*").eq("id", body.sender_id)).data ?? [] : await selectSenders(mode);
  const results = [];
  const t0 = Date.now();
  for (const s of senders) {
    if (Date.now() - t0 > 50_000) break;
    try { results.push(await planSender(s, mode)); } catch (e) { log({ fn: "planner", sender_id: s.id, error: String(e) }); results.push({ sender_id: s.id, error: String(e) }); }
  }
  return json({ ok: true, mode, senders: senders.length, results });
});
