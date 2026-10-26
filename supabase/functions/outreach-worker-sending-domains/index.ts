// F59 — Sending domains worker (custom-sending-domain-PRD.md §4.1 step 4, §5.5, §5.6, §9).
//   {mode:"verify"}  dispatched every 10 min while a domain is verifying (72 h), hourly after, failed after 7 days
//   {mode:"daily"}   04:00 UTC: bounce / complaint / DNS health, warm-up caps, plan pauses and 30-day removals, retention
import { json, serve, requireCron, readJson } from "../_shared/outreach/supabase.ts";
import { verifyTick, dailyRun } from "../_shared/outreach/sending_domains.ts";

serve("worker-sending-domains", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string }>(req).catch(() => ({} as { mode?: string }));
  if (body.mode === "daily") return json({ ok: true, mode: "daily", ...(await dailyRun()) });
  return json({ ok: true, mode: "verify", ...(await verifyTick()) });
});
