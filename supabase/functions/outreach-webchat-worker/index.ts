// outreach-webchat-worker — cron worker for web chat (x-cron-secret via outreach_invoke; migration 051).
//   {"mode":"continuity"}   every minute: send owed continuity digests (PRD §9: first email 5 min after the visitor went
//                           quiet, one digest per conversation, at most one per 15 min)
//   {"mode":"maintenance"}  every 5 min: wake snoozed conversations, unassign agents who went offline (per-inbox setting),
//                           purge stale uploads and old page views
import { json, readJson, requireCron, rpc, serve } from "../_shared/outreach/supabase.ts";
import { runContinuity } from "../_shared/outreach/webchat.ts";

serve("outreach-webchat-worker", async (req) => {
  requireCron(req);
  const { mode = "continuity" } = await readJson<{ mode?: string }>(req);
  if (mode === "continuity") return json({ ok: true, mode, ...(await runContinuity()) });
  if (mode === "maintenance") return json({ ok: true, mode, ...(await rpc<Record<string, unknown>>("webchat_maintenance")) });
  return json({ error: "unknown mode", code: "E_PAYLOAD_INVALID" }, 400);
});
