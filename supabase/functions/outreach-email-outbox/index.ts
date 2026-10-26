// F27 — Email outbox worker (custom-sending-domain-PRD.md §5.3). Dispatched every 15 s by outreach_cron_tick, only when a
// row in outreach_email_outbox is due. Sends with the chosen domain's key, falls back to the platform on a domain error,
// retries transient failures (+30 s, +2 min, +10 min, +1 h), marks invalid recipients failed.
import { json, serve, requireCron, readJson } from "../_shared/outreach/supabase.ts";
import { outboxTick } from "../_shared/outreach/email.ts";

serve("email-outbox", async (req) => {
  requireCron(req);
  const body = await readJson<{ limit?: number }>(req).catch(() => ({} as { limit?: number }));
  return json({ ok: true, ...(await outboxTick(Math.min(200, Math.max(1, Number(body.limit ?? 50))))) });
});
