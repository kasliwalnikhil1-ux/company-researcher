// Health scoring (PRD §8.2 F5 / §13.5). score = min(categories).
import { admin, log, rpc, emitEvent } from "./supabase.ts";
import { notifySender } from "./notify.ts";

export interface HealthInputs {
  currently_ok: boolean; disconnects_14d: number; checkpoints_30d: number; rejects_14d: number; actions_14d: number;
  invites_14d: number; accepted_14d: number; messages_14d: number; replies_14d: number; daily_actions_14d: number[];
  today_actions: number; idle_days_before_today: number; health_score: number; health_high_since: string | null;
  warmup_level: number; warmup_locked_until: string | null; is_premium: boolean;
}

export function scoreHealth(i: HealthInputs): { score: number; breakdown: Record<string, number> } {
  const b: Record<string, number> = {};
  b.session_stability = Math.max(0, 100 - 25 * i.disconnects_14d) - (i.currently_ok ? 0 : 20);
  b.session_stability = Math.max(0, b.session_stability);
  const rr = i.actions_14d > 0 ? i.rejects_14d / i.actions_14d : 0;
  b.rejection_rate = rr < 0.01 ? 100 : rr < 0.03 ? 80 : rr < 0.06 ? 60 : rr < 0.10 ? 40 : 20;
  if (i.invites_14d >= 20) {
    const ar = i.accepted_14d / i.invites_14d;
    b.acceptance_rate = ar >= 0.35 ? 100 : ar >= 0.25 ? 85 : ar >= 0.15 ? 65 : ar >= 0.08 ? 45 : 25;
  } else b.acceptance_rate = 100;
  if (i.messages_14d >= 20) {
    const pr = i.replies_14d / i.messages_14d;
    b.reply_rate = pr >= 0.15 ? 100 : pr >= 0.08 ? 80 : pr >= 0.04 ? 60 : 40;
  } else b.reply_rate = 100;
  const daily = i.daily_actions_14d ?? [];
  const active = daily.filter((d) => d > 0);
  if (active.length >= 3) {
    const mean = daily.reduce((a, c) => a + c, 0) / daily.length;
    const sd = Math.sqrt(daily.reduce((a, c) => a + (c - mean) ** 2, 0) / daily.length);
    const cv = mean > 0 ? sd / mean : 0;
    b.consistency = cv < 0.5 ? 100 : cv < 1.0 ? 75 : 50;
  } else b.consistency = 100;
  const trailing = daily.filter((d) => d > 0);
  const trailingAvg = trailing.length ? trailing.reduce((a, c) => a + c, 0) / trailing.length : 0;
  if (i.idle_days_before_today >= 5 && trailingAvg > 0 && i.today_actions > 3 * trailingAvg) b.consistency = 10;
  b.verification = i.checkpoints_30d === 0 ? 100 : i.checkpoints_30d === 1 ? 70 : 40;
  const score = Math.max(0, Math.min(100, Math.round(Math.min(...Object.values(b)))));
  return { score, breakdown: b };
}

/** Recompute health for one sender and apply effects. trigger: 'nightly' | 'disconnect' | 'reject' | 'reconnect' */
export async function healthForSender(senderId: string, trigger: string): Promise<{ score: number; breakdown: Record<string, number> } | null> {
  const { data: s } = await admin.from("outreach_senders").select("*").eq("id", senderId).maybeSingle();
  if (!s || s.deleted_at || s.status === "disabled") return null;
  if (trigger !== "nightly") {
    // debounce inline recomputes to once per 10 minutes
    const { data: last } = await admin.from("outreach_sender_events").select("at").eq("sender_id", senderId).eq("kind", "health").order("at", { ascending: false }).limit(1).maybeSingle();
    if (last && Date.now() - new Date(last.at).getTime() < 10 * 60_000) return null;
  }
  const inputs = await rpc<HealthInputs>("health_inputs", { p_sender: senderId });
  const { score, breakdown } = scoreHealth(inputs);
  const today = new Date().toISOString().slice(0, 10);
  const patch: Record<string, unknown> = { health_score: score, health_breakdown: { ...breakdown, computed_at: new Date().toISOString(), trigger } };

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

  // level-up: ≥85 for 14 consecutive days and onboarding lock passed
  const highSince = (patch.health_high_since as string | null) ?? null;
  if (trigger === "nightly" && highSince && score >= 85) {
    const days = (Date.parse(today) - Date.parse(highSince)) / 86400000;
    const locked = s.warmup_locked_until && s.warmup_locked_until >= today;
    const maxLevel = s.is_premium || s.provider !== "LINKEDIN" ? 5 : 1;
    if (days >= 14 && !locked && s.warmup_level < maxLevel) {
      patch.warmup_level = s.warmup_level + 1;
      patch.health_high_since = today;
      await notifySender(senderId, "level_up", { level: s.warmup_level + 1 });
    }
  }
  await admin.from("outreach_senders").update(patch).eq("id", senderId);
  if (score !== s.health_score) await emitEvent(s.workspace_id, "sender.health", { id: senderId, score, breakdown, trigger });
  log({ fn: "health", sender_id: senderId, score, trigger });
  return { score, breakdown };
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
