// F23 — Outbound webhook deliveries (cron every 30s), HMAC-signed with retry.
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runOutboundWebhooks } from "../_shared/outreach/workers.ts";

serve("outbound-webhooks", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runOutboundWebhooks()) });
});
