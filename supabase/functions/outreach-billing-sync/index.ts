// F25 — Billing sync (cron daily): usage rows, past-due suspension, Stripe quantity.
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runBillingSync } from "../_shared/outreach/workers.ts";

serve("billing-sync", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runBillingSync()) });
});
