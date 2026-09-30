// AI replies — cron worker (ai-auto-reply-PRD.md §12.2, ai-replies-changes.md §9.7). {mode} picks the job:
//   draft        (every 15 s)     F32: due debounced runs → gates → draft → validate → verify → draft_ready / scheduled / escalated / no_reply
//   dispatch     (every minute)   F33: due scheduled runs → recheck → ledger → send → sent (→ handoff on a Stop rule)
//   maintenance  (*/15 * * * *)   F35: expire holds older than 24 h, recover stuck runs
//   breakers     (7 * * * *)      F36: per-sequence downgrades + notices
//   daily        (30 3 * * *)     graduation stats, gone-quiet tasks (F41), unanswered-question merge (F42), digests
//   lead_notes   (every 30 s)     F39: lead-notes queue
//   knowledge    (every minute)   crawl / parse pending knowledge sources
import { json, serve, requireCron, readJson, log } from "../_shared/outreach/supabase.ts";
import { runDraftWorker, runDispatch, runMaintenance, runLeadNotes, runKnowledge } from "../_shared/outreach/ai_reply.ts";

type Mode = "draft" | "dispatch" | "maintenance" | "breakers" | "daily" | "lead_notes" | "knowledge";

serve("ai-reply-worker", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: Mode }>(req);
  const mode: Mode = body.mode ?? "draft";
  const t0 = Date.now();
  let result: Record<string, unknown>;
  switch (mode) {
    case "draft": result = await runDraftWorker(40_000); break;
    case "dispatch": result = await runDispatch(45_000); break;
    case "lead_notes": result = await runLeadNotes(40_000); break;
    case "knowledge": result = await runKnowledge(50_000); break;
    case "maintenance": case "breakers": case "daily": result = await runMaintenance(mode); break;
    default: return json({ ok: false, error: `unknown mode ${String(mode)}` }, 400);
  }
  log({ fn: "ai-reply-worker", mode, duration_ms: Date.now() - t0, ...result });
  return json({ ok: true, mode, ...result });
});
