// F55 — Lead summary (leads-relationships-PRD.md §8.4; migration 094).
// tick      (dispatcher row `lead-summary`, every 30 s, only when outreach_lead_summary_queue has rows): drains the queue in
//           batches of 200 through outreach_lead_summary_process until it is empty or 40 s have passed.
// reconcile (pg_cron outreach-lead-summary-reconcile, 03:30 UTC): recomputes every lead with activity in the last 7 days
//           (and every lead with no summary row) through outreach_lead_summary_reconcile, and logs how many rows drifted.
// The worker holds no logic of its own: the database decides the status ladder, the connections and the channels.
import { json, serve, requireCron, readJson, log, rpc } from "../_shared/outreach/supabase.ts";

type Row = Record<string, any>;
const RUN_BUDGET_MS = 40_000;

serve("worker-lead-summary", async (req) => {
  requireCron(req);
  const url = new URL(req.url);
  const body = await readJson(req).catch(() => ({} as Row));
  const mode = String(body?.mode ?? url.searchParams.get("mode") ?? "tick");
  const t0 = Date.now();

  if (mode === "reconcile") {
    const days = Number(body?.days ?? url.searchParams.get("days") ?? 7) || 7;
    const r = await rpc<Row>("lead_summary_reconcile", { p_days: days, p_limit: 5000 });
    log({ fn: "worker-lead-summary", mode, ...r, duration_ms: Date.now() - t0 });
    return json({ ok: true, mode, ...r });
  }

  let processed = 0, changed = 0, failed = 0, remaining = 0, rounds = 0;
  while (Date.now() - t0 < RUN_BUDGET_MS) {
    const r = await rpc<Row>("lead_summary_process", { p_limit: 200 });
    rounds++;
    processed += Number(r?.processed ?? 0); changed += Number(r?.changed ?? 0); failed += Number(r?.failed ?? 0);
    remaining = Number(r?.remaining ?? 0);
    if (!r || Number(r.processed ?? 0) === 0) break;
  }
  if (processed || failed) log({ fn: "worker-lead-summary", mode, processed, changed, failed, remaining, rounds, duration_ms: Date.now() - t0 });
  return json({ ok: true, mode, processed, changed, failed, remaining });
});
