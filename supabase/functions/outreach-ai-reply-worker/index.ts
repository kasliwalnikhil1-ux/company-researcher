// AI replies — cron worker (ai-auto-reply-PRD.md §12.2). {mode} picks the job:
//   draft        (every 15 s)     F32: due debounced runs → gates → draft → validate → verify → draft_ready / scheduled / escalated / no_reply
//   dispatch     (every minute)   F33: due scheduled runs → §7.3 recheck → ledger → send → sent
//   maintenance  (*/15 * * * *)   F35: expire holds older than 24 h, recover stuck runs, lift ended takeover pauses
//   breakers     (7 * * * *)      F36: §10.3 downgrades + notices
//   daily        (30 3 * * *)     graduation refresh (§16.2), managers' daily summary, owners' weekly digest on Mondays
import { json, serve, requireCron, readJson, log } from "../_shared/outreach/supabase.ts";
import { runDraftWorker, runDispatch, runMaintenance } from "../_shared/outreach/ai_reply.ts";

type Mode = "draft" | "dispatch" | "maintenance" | "breakers" | "daily";

serve("ai-reply-worker", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: Mode }>(req);
  const mode: Mode = body.mode ?? "draft";
  const t0 = Date.now();
  let result: Record<string, unknown>;
  switch (mode) {
    case "draft": result = await runDraftWorker(40_000); break;
    case "dispatch": result = await runDispatch(45_000); break;
    case "maintenance": case "breakers": case "daily": result = await runMaintenance(mode); break;
    default: return json({ ok: false, error: `unknown mode ${String(mode)}` }, 400);
  }
  log({ fn: "ai-reply-worker", mode, duration_ms: Date.now() - t0, ...result });
  return json({ ok: true, mode, ...result });
});
