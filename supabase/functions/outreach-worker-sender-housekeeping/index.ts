// F52 — Sender housekeeping (sender-lifecycle-PRD.md §5.6, §5.7, §7.2). pg_cron nightly at 02:30 UTC.
//   1. disabled senders 7 days from their auto-remove date: email managers + owner once
//   2. disabled senders past their auto-remove date: Remove (removed_via auto_after_disabled)
//   3. connector deletes that did not confirm: retry (the hourly billing job also drains this queue)
//   4. "removal pending" for more than 6 hours: managers are told once a day
//   5. connector reconciliation: orphans and senders whose account the connector no longer lists. Report-only until the
//      platform flag sender_reconcile_cleanup is true (rollout phase 4); then orphans older than a day are deleted and a
//      sender whose account is confirmed gone (404) is marked removed with its history kept.
// POST {mode:'nightly'} (cron) · {mode:'reconcile'} runs only step 5 (operator use).
import { json, serve, requireCron, readJson } from "../_shared/outreach/supabase.ts";
import { housekeeping, reconcileConnector } from "../_shared/outreach/lifecycle.ts";

serve("worker-sender-housekeeping", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string }>(req).catch(() => ({ mode: "nightly" }));
  if (body.mode === "reconcile") return json({ ok: true, mode: "reconcile", reconcile: await reconcileConnector() });
  return json({ ok: true, mode: "nightly", ...(await housekeeping()) });
});
