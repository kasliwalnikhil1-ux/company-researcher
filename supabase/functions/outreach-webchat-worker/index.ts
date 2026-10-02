// outreach-webchat-worker — cron worker for web chat (x-cron-secret via outreach_invoke; migration 051).
//   {"mode":"continuity"}   every minute: send owed continuity digests (PRD §9: first email 5 min after the visitor went
//                           quiet, one digest per conversation, at most one per 15 min)
//   {"mode":"maintenance"}  every 5 min: wake snoozed conversations, unassign agents who went offline (per-inbox setting),
//                           purge stale uploads and old page views
//   {"mode":"review"}       every minute (migration 064): Review mode of the website assistant. Writes the suggestions a
//                           request did not finish, expires the ones nobody answered within the website's review timeout
//                           and posts its offline message (docs/outreach/AI-HUB.md §6)
//   {"mode":"voice"}        every minute (migration 070): voice calls of the website assistant. Fetches the calls whose
//                           post-call webhook never arrived, deletes what a removed website / an erased visitor left at
//                           the voice provider, and (every 5th minute, or with "sweep": true) brings every voice agent in
//                           line with its website's settings (docs/outreach/WEBCHAT.md "Voice")
import { json, readJson, requireCron, rpc, serve } from "../_shared/outreach/supabase.ts";
import { runContinuity, runReview } from "../_shared/outreach/webchat.ts";
import { runVoiceWorker } from "../_shared/outreach/voice.ts";

serve("outreach-webchat-worker", async (req) => {
  requireCron(req);
  const { mode = "continuity", sweep } = await readJson<{ mode?: string; sweep?: boolean }>(req);
  if (mode === "continuity") return json({ ok: true, mode, ...(await runContinuity()) });
  if (mode === "maintenance") return json({ ok: true, mode, ...(await rpc<Record<string, unknown>>("webchat_maintenance")) });
  if (mode === "review") return json({ ok: true, mode, ...(await runReview()) });
  if (mode === "voice") return json({ ok: true, mode, ...(await runVoiceWorker({ sweep: sweep ?? new Date().getUTCMinutes() % 5 === 0 })) });
  return json({ error: "unknown mode", code: "E_PAYLOAD_INVALID" }, 400);
});
