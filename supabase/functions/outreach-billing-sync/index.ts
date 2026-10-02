// F25 — Billing job (cron). {mode:"hourly"} trial expiry, suspension, hygiene, emails; {mode:"daily"} usage rows, the
// connector cost report, deletion of workspaces past their date. It never sets a Stripe quantity (billing v2).
import { json, readJson, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runBillingDaily, runBillingHourly } from "../_shared/outreach/billing_sync.ts";

serve("billing-sync", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string }>(req);
  if (body.mode === "daily") return json({ ok: true, ...(await runBillingDaily()) });
  return json({ ok: true, ...(await runBillingHourly()) });
});
