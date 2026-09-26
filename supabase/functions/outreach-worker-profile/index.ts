// Profile Studio worker (cron). {mode:"tick"} every 5 min: expire stale approvals/previews, post-verify applied changes
// (≥60 s after the PATCH, one selective read each), email owners with the diff + revert link, advance experiments.
// {mode:"weekly"}: staggered drift re-read for senders the studio is used on, QA recompute. {sender_id} = snapshot one sender.
import { admin, json, serve, requireCron, readJson, log, rpc } from "../_shared/outreach/supabase.ts";
import { verifyDueChanges, notifyPendingChanges, weeklyDriftAndQa, snapshotSender } from "../_shared/outreach/profile.ts";

serve("worker-profile", async (req) => {
  requireCron(req);
  const body = await readJson<{ mode?: string; sender_id?: string }>(req);
  const mode = body.mode ?? "tick";
  if (body.sender_id) {
    const { data: s } = await admin.from("outreach_senders").select("*").eq("id", body.sender_id).maybeSingle();
    if (!s) return json({ ok: false, error: "sender not found" }, 404);
    return json({ ok: true, snapshot: await snapshotSender(s, "baseline") });
  }
  if (mode === "weekly") {
    const r = await weeklyDriftAndQa();
    log({ fn: "worker-profile", mode, ...r });
    return json({ ok: true, ...r });
  }
  const expired = await rpc("profile_expire").catch((e) => ({ error: String(e) }));
  const verified = await verifyDueChanges(20).catch((e) => ({ error: String(e) }));
  const notified = await notifyPendingChanges(30).catch((e) => ({ error: String(e) }));
  const experiments = await rpc("profile_experiment_advance").catch((e) => ({ error: String(e) }));
  log({ fn: "worker-profile", mode, expired, verified, notified, experiments });
  return json({ ok: true, expired, verified, notified, experiments });
});
