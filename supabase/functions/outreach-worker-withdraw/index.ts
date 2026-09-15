// F8 — Withdraw stale invitations (cron hourly; acts once per sender-day inside 10:00–16:00 local).
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runWithdraw } from "../_shared/outreach/workers.ts";

serve("worker-withdraw", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runWithdraw()) });
});
