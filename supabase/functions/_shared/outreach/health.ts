// Health scoring (PRD §8.2 F5 / §13.5). score = min(categories).
import { admin, log, rpc, emitEvent } from "./supabase.ts";
import { notifySender } from "./notify.ts";

export interface HealthInputs {
  currently_ok: boolean; disconnects_14d: number; checkpoints_30d: number; rejects_14d: number; actions_14d: number;
  invites_14d: number; accepted_14d: number; messages_14d: number; replies_14d: number; daily_actions_14d: number[];
  today_actions: number; idle_days_before_today: number; health_score: number; health_high_since: string | null;
  warmup_level: number; warmup_locked_until: string | null; is_premium: boolean;
  // channels (026): only read for INSTAGRAM / WHATSAPP senders; a LinkedIn breakdown never contains the two categories below
  provider?: string; blocks_30d?: number; new_chats_14d?: number; new_chats_replied_14d?: number;
  new_chats_all?: number; new_chats_replied_all?: number; days_connected?: number; inbound_conversations?: number;
  account_age_attested?: boolean; disconnect_within_24h_of_outreach?: boolean; provider_warning?: boolean;
}

export function scoreHealth(i: HealthInputs): { score: number; breakdown: Record<string, number> } {
  const b: Record<string, number> = {};
  const provider = String(i.provider ?? "LINKEDIN").toUpperCase();
  if (provider === "INSTAGRAM" || provider === "WHATSAPP") {
    // block_signals: 0 blocks → 100, −30 per detected block in 30 days, floor 0
    b.block_signals = Math.max(0, 100 - 30 * Number(i.blocks_30d ?? 0));
  }
  if (provider === "WHATSAPP") {
    // new_chat_reply_rate: the governor's input, surfaced as a health category (≥ 25 new chats in 14 days; fewer → 100)
    const n = Number(i.new_chats_14d ?? 0);
    if (n >= 25) {
      const rate = Number(i.new_chats_replied_14d ?? 0) / n;
      b.new_chat_reply_rate = rate >= 0.5 ? 100 : rate >= 0.4 ? 85 : rate >= 0.25 ? 60 : 30;
    } else b.new_chat_reply_rate = 100;
  }
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
