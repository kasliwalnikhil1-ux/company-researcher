// F9 — Relations poll for no-note invites (cron hourly; ≤3 runs/day/sender at random offsets).
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { runRelationsPoll } from "../_shared/outreach/workers.ts";

serve("worker-relations-poll", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await runRelationsPoll()) });
});
