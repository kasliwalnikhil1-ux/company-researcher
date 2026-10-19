// Health scoring (PRD §8.2 F5 / §13.5). The maths lives in health_score.ts (pure, unit-tested): every category counts
// (weighted average) and the weakest category only caps the score. This file applies the effects: pause below 50,
// level-up at ≥ 85 for 14 days, the WhatsApp governor, events and notifications.
import { admin, log, rpc, emitEvent } from "./supabase.ts";
import { notifySender } from "./notify.ts";
import { scoreHealth, type HealthInputs, type HealthResult } from "./health_score.ts";
export { scoreHealth, scoreCategories, combineHealth, healthCap, HEALTH_WEIGHTS, type HealthInputs, type HealthResult } from "./health_score.ts";

/** Recompute health for one sender and apply effects. trigger: 'nightly' | 'disconnect' | 'reject' | 'reconnect' */
export async function healthForSender(senderId: string, trigger: string): Promise<HealthResult | null> {
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s || s.deleted_at || s.status === "disabled" || s.status === "disconnected") return null;
  if (trigger !== "nightly") {
    // debounce inline recomputes to once per 10 minutes
    const { data: last } = await admin.from("outreach_sender_events").select("at").eq("sender_id", senderId).eq("kind", "health").order("at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - new Date(last.at).getTime() < 10 * 60_000) return null;
  }
  const inputs = await rpc<HealthInputs>("health_inputs", { p_sender: senderId });
  const result = scoreHealth(inputs);
  const { score, breakdown, average, cap, limited_by } = result;
  const today = new Date().toISOString().slice(0, 10);
  const patch: Record<string, unknown> = { health_score: score, health_breakdown: { ...breakdown, average, cap, limited_by, computed_at: new Date().toISOString(), trigger } };

  if (score >= 85) patch.health_high_since = s.health_high_since ?? today;
  else patch.health_high_since = null;

  if (score < 50) {
    const until = new Date(Date.now() + 24 * 3600_000).toISOString();
    if (!s.paused_until || new Date(s.paused_until).getTime() < Date.now()) {
      patch.paused_until = until;
      patch.status_reason = `health ${score} < 50`;
      await notifySender(senderId, "sender_paused", { reason: `health score ${score} (< 50)`, until });
    }
  } else if (s.paused_until && new Date(s.paused_until).getTime() > Date.now() && String(s.status_reason ?? "").startsWith("health")) {
    patch.paused_until = null; patch.status_reason = null;
  }

  // WhatsApp: the new-chat governor (PRD §7.4) owns the level, promotion nightly and demotion any time; no LinkedIn level-up rule
  if (trigger === "nightly" && s.provider === "WHATSAPP") {
    try {
      const g = await rpc<Record<string, unknown>>("wa_governor", { p_sender: senderId });
      log({ fn: "health", sender_id: senderId, wa_governor: g });
      if (g && g.level_after != null && g.level_before != null && g.level_after !== g.level_before) {
        if (Number(g.level_after) > Number(g.level_before)) await notifySender(senderId, "level_up", { level: Number(g.level_after) });
        await emitEvent(s.workspace_id, "sender.warmup", { id: senderId, ...g });
      }
    } catch (e) { log({ fn: "health", sender_id: senderId, warn: `wa_governor: ${String((e as any)?.message ?? e)}` }); }
  }
  // level-up: ≥85 for 14 consecutive days and onboarding lock passed (LinkedIn max 1 for free accounts; Instagram levels 0–5)
  const highSince = (patch.health_high_since as string | null) ?? null;
  if (trigger === "nightly" && highSince && score >= 85 && s.provider !== "WHATSAPP") {
    const days = (Date.parse(today) - Date.parse(highSince)) / 86400000;
    const locked = s.warmup_locked_until && s.warmup_locked_until >= today;
    const maxLevel = s.is_premium || s.provider !== "LINKEDIN" ? 5 : 1;
    // Profile Studio (PRD §10.2): a critical profile QA failure (no photo, under 150 connections) caps warm-up promotion.
    const { data: qa } = await admin.from("outreach_profile_qa").select("checks").eq("sender_id", senderId).maybeSingle();
    const qaCritical = ((qa?.checks ?? []) as Array<{ severity?: string; pass?: boolean | null; code?: string }>).filter((c) => c.severity === "critical" && c.pass === false).map((c) => c.code);
    if (qaCritical.length && days >= 14 && !locked && s.warmup_level < maxLevel) log({ fn: "health", sender_id: senderId, level_up_blocked: qaCritical });
    if (days >= 14 && !locked && s.warmup_level < maxLevel && !qaCritical.length) {
      patch.warmup_level = s.warmup_level + 1;
      patch.health_high_since = today;
      await notifySender(senderId, "level_up", { level: s.warmup_level + 1 });
    }
  }
  await admin.from("outreach_senders").update(patch).eq("id", senderId);
  if (score !== s.health_score) await emitEvent(s.workspace_id, "sender.health", { id: senderId, score, breakdown, trigger });
  log({ fn: "health", sender_id: senderId, score, average, cap, limited_by, trigger });
  return result;
}

/** Reject burst rule: ≥3 × (429/500) within 1h → pause 24h. Returns true if paused now. */
export async function recordReject(senderId: string): Promise<boolean> {
  const { data: s } = await admin.from("outreach_senders").select("rejects_1h, rejects_1h_reset_at, paused_until, workspace_id").eq("id", senderId).single();
  const resetAt = s?.rejects_1h_reset_at ? new Date(s.rejects_1h_reset_at).getTime() : 0;
  const fresh = Date.now() > resetAt;
  const count = fresh ? 1 : (s?.rejects_1h ?? 0) + 1;
  const patch: Record<string, unknown> = { rejects_1h: count, rejects_1h_reset_at: fresh ? new Date(Date.now() + 3600_000).toISOString() : s?.rejects_1h_reset_at };
  let paused = false;
  if (count >= 3 && !(s?.paused_until && new Date(s.paused_until).getTime() > Date.now())) {
    patch.paused_until = new Date(Date.now() + 24 * 3600_000).toISOString();
    patch.status_reason = "3 provider rejections within 1h";
    paused = true;
  }
  await admin.from("outreach_senders").update(patch).eq("id", senderId);
  if (paused) {
    await notifySender(senderId, "sender_paused", { reason: "3 provider rejections (429/5xx) within one hour", until: patch.paused_until });
    await healthForSender(senderId, "reject");
  }
  return paused;
}
