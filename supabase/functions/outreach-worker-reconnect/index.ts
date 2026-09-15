// F6 — Reconnect loop (cron every 15 min).
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runReconnect } from "../_shared/outreach/workers.ts";

serve("worker-reconnect", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runReconnect()) });
});
