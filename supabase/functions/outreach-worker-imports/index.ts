// F7 — Import jobs (cron every 5 min).
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runImports } from "../_shared/outreach/workers.ts";

serve("worker-imports", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runImports()) });
});
