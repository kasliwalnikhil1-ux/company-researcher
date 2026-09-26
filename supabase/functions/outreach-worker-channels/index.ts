// Instagram / WhatsApp channel workers (cron). {mode} picks the job:
//   followers_poll   (35 * * * *)   IG follow-back detection through the sender's own followers list
//   identifier_check (*/30 * * * *) WA "is this number on WhatsApp?" for leads about to get a new chat ({sender_id} narrows it)
//   block_detect     (55 * * * *)   block signals inferred from failed sends after one-way chats
//   transcribe       (* * * * *)    voice notes → transcript → classification
//   wa_governor      (on demand; worker-health runs it nightly)
import { json, serve, requireCron, readJson, log } from "../_shared/outreach/supabase.ts";
import { runFollowersPoll, runIdentifierCheck, runBlockDetect, runTranscribe, runWaGovernor } from "../_shared/outreach/channel_workers.ts";

type Mode = "followers_poll" | "identifier_check" | "block_detect" | "transcribe" | "wa_governor";

serve("worker-channels", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: Mode; sender_id?: string; limit?: number }>(req);
  const mode: Mode = body.mode ?? "transcribe";
  const t0 = Date.now();
  let result: Record<string, unknown>;
  switch (mode) {
    case "followers_poll": result = await runFollowersPoll(); break;
    case "identifier_check": result = await runIdentifierCheck(body.sender_id); break;
    case "block_detect": result = await runBlockDetect(); break;
    case "transcribe": result = await runTranscribe(Math.max(1, Math.min(50, Number(body.limit ?? 10) || 10))); break;
    case "wa_governor": result = await runWaGovernor(); break;
    default: return json({ ok: false, error: `unknown mode ${String(mode)}` }, 400);
  }
  log({ fn: "worker-channels", mode, duration_ms: Date.now() - t0, ...result });
  return json({ ok: true, mode, ...result });
});
