// Private notes — cron worker (private-notes-PRD.md §10). {mode} picks the job:
//   emails  (every minute)  F45: mentions unread past the person's delay → one email per person per conversation
//   purge   (daily 03:40)   F46: hard-delete bodies + files of notes deleted > 30 days ago
// Scheduled by migrations/outreach/047_chat_notes_cron.sql through outreach_invoke().
import { json, serve, requireCron, readJson, log } from "../_shared/outreach/supabase.ts";
import { runMentionEmails, runNotesPurge } from "../_shared/outreach/notes.ts";

type Mode = "emails" | "purge";

serve("notes-worker", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: Mode }>(req);
  const mode: Mode = body.mode ?? "emails";
  const t0 = Date.now();
  let result: Record<string, unknown>;
  switch (mode) {
    case "emails": result = await runMentionEmails(); break;
    case "purge": result = await runNotesPurge(); break;
    default: return json({ ok: false, error: `unknown mode ${String(mode)}` }, 400);
  }
  log({ fn: "notes-worker", mode, duration_ms: Date.now() - t0, ...result });
  return json({ ok: true, mode, ...result });
});
