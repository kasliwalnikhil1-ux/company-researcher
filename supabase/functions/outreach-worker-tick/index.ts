// F3 — Tick (cron every minute): release waits, claim due actions, execute, settle.
import { admin, json, serve, requireCron, log, rpc, flag } from "../_shared/outreach/supabase.ts";
import { executeAction, settle } from "../_shared/outreach/execute.ts";
import { fillPendingDrafts } from "../_shared/outreach/drafts.ts";

serve("worker-tick", async (req) => {
  requireCron(req);
  if ((await flag("tick_enabled", true)) === false) return json({ ok: true, skipped: "tick_disabled" });
  // advisory lock via flags row to avoid overlapping ticks
  const lockKey = "lock:tick";
  const now = Date.now();
  const { data: lock } = await admin.from("outreach_flags").select("value").eq("key", lockKey).maybeSingle();
  if (lock && typeof lock.value === "number" && now - (lock.value as number) < 55_000) return json({ ok: true, skipped: "locked" });
  await admin.from("outreach_flags").upsert({ key: lockKey, value: now as any });

  const t0 = Date.now();
  const released = await rpc<number>("release_waits").catch((e) => { log({ fn: "tick", warn: String(e) }); return 0; });
  const rows = await rpc<any[]>("claim_due_actions", { p_limit: 200 });
  let done = 0, failed = 0;
  // parallel across senders (already one-per-sender by claim), bounded concurrency
  const queue = [...(rows ?? [])];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length && Date.now() - t0 < 45_000) {
      const a = queue.shift()!;
      try {
        const res = await executeAction(a);
        await settle(a, res);
        if (res.ok) done++; else failed++;
      } catch (e) {
        failed++;
        log({ fn: "tick", action_id: a.id, error: String(e) });
        try { await rpc("fail_action", { p_id: a.id, p_code: String((e as any)?.message ?? e).slice(0, 120), p_decision: "retry", p_retry_at: new Date(Date.now() + 15 * 60_000).toISOString(), p_branch: null }); } catch { /* ignore */ }
      }
    }
  });
  await Promise.all(workers);
  // return unprocessed reservations to the queue (sweeper also handles this)
  for (const a of queue) { try { await rpc("fail_action", { p_id: a.id, p_code: "tick_timeout", p_decision: "retry", p_retry_at: new Date(Date.now() + 60_000).toISOString(), p_branch: null }); } catch { /* ignore */ } }
  const drafts = await fillPendingDrafts(3).catch(() => 0);
  await admin.from("outreach_flags").upsert({ key: lockKey, value: 0 as any });
  log({ fn: "tick", claimed: rows?.length ?? 0, done, failed, released, drafts, duration_ms: Date.now() - t0 });
  return json({ ok: true, claimed: rows?.length ?? 0, done, failed, released, drafts });
});
