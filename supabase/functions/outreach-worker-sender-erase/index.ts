// F51 — Sender erase tick (sender-lifecycle-PRD.md §5.4, §7.2). Dispatched every 15 min by outreach_cron_tick, only when
// a sender is due: erasures scheduled 24 h earlier (Storage objects first, then outreach_sender_erase_execute; a run
// that stops halfway is finished by the next one from the job row) and pauses whose auto-resume time has come.
import { json, serve, requireCron } from "../_shared/outreach/supabase.ts";
import { eraseTick } from "../_shared/outreach/lifecycle.ts";

serve("worker-sender-erase", async (req) => {
  requireCron(req);
  return json({ ok: true, ...(await eraseTick()) });
});
