// F18 — Intent classification consumer (cron every 15s).
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runClassify } from "../_shared/outreach/workers.ts";

serve("ai-classify", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runClassify(20)) });
});
