// F60 — Account alerts (sender-lifecycle-PRD v1.2 §5.8). Dispatched every 15 min by outreach_cron_tick, only when a sender is
// disconnected or a mass-disconnect hold is unannounced: sign-in emails and their two reminders to whoever signs in to the
// account, the combined team email per workspace (4 h after the sign-in email, once a day, final at day 7), "likely an
// outage" emails for holds.
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { accountAlertsTick } from "../_shared/outreach/alerts.ts";

serve("worker-account-alerts", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await accountAlertsTick()) });
});
