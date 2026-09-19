// F5 — Health (cron hourly; senders at local 02:xx) + on demand {sender_id}.
import { admin, json, serve, requireCron, readJson, localParts, log } from "../_shared/outreach/supabase.ts";
import { healthForSender } from "../_shared/outreach/health.ts";
import { backfillChatPictures } from "../_shared/outreach/avatars.ts";

serve("worker-health", async (req) => {
  requireCron(req);
  const body = await readJson<{ sender_id?: string; all?: boolean }>(req);
  const q = admin.from("outreach_senders").select("id, timezone, status").is("deleted_at", null).neq("status", "disabled");
  const { data: senders } = body.sender_id ? await q.eq("id", body.sender_id) : await q;
  const out: unknown[] = [];
  for (const s of senders ?? []) {
    if (!body.sender_id && !body.all && localParts(s.timezone ?? "UTC").hour !== 2) continue;
    try { out.push({ id: s.id, ...(await healthForSender(s.id, "nightly")) }); } catch (e) { log({ fn: "health", sender_id: s.id, error: String(e) }); }
  }
  let pictures = 0;
  if (!body.sender_id) { try { pictures = await backfillChatPictures(); } catch (e) { log({ fn: "health", avatars_error: String(e) }); } }
  return json({ ok: true, computed: out.length, pictures, results: out });
});
