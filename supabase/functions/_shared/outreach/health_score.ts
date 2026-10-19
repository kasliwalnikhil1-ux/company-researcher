// Health scoring (PRD §8.2 F5 / §13.5). Pure: no Deno, no Supabase, so it can be unit-tested with plain `deno test`.
//
// Since 2026-10-19 the score is no longer the lowest category. Every category counts (weighted average) and the weakest
// category can only *cap* the score (the GetSales "Account Health" model: six axes, each with a score and a ceiling it
// puts on the overall). One bad category still pulls the score down, but no longer to its own value:
//   five categories at 100 + rejection rate at 20  →  average 80, held to 60 by rejection rate  →  caps ×0.6, not paused
//   consistency 10 (burst after idle days)          →  cap 40                                     →  paused (< 50)
//   session stability 0 (disconnected, 4 drops)     →  cap 40                                     →  paused (< 50)

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

export interface HealthResult {
  /** 0–100: min(weighted average, lowest category cap) */
  score: number;
  /** category → 0–100 */
  breakdown: Record<string, number>;
  /** the weighted average before any cap */
  average: number;
  /** the lowest category cap */
  cap: number;
  /** the category whose cap held the score below the average, or null when the average stood */
  limited_by: string | null;
}

/** Weight of each category in the average (risk signals weigh more). Missing categories drop out of the denominator. */
export const HEALTH_WEIGHTS: Record<string, number> = {
  session_stability: 20, rejection_rate: 25, acceptance_rate: 15, reply_rate: 10, consistency: 15, verification: 15,
  block_signals: 20, new_chat_reply_rate: 15,
};

/** The ceiling a category score puts on the overall score. Softer than the score itself, but a very low category still pauses. */
export function healthCap(v: number): number {
  return v >= 85 ? 100 : v >= 60 ? 90 : v >= 40 ? 75 : v >= 20 ? 60 : 40;
}

export function scoreCategories(i: HealthInputs): Record<string, number> {
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
  return b;
}

/** Combine a category breakdown into the overall score: weighted average, held to the lowest category cap. */
export function combineHealth(b: Record<string, number>): Omit<HealthResult, "breakdown"> {
  let num = 0, den = 0, cap = 100, limited_by: string | null = null, limitedValue = Infinity;
  for (const [k, raw] of Object.entries(b)) {
    const v = Math.max(0, Math.min(100, Number(raw)));
    if (!Number.isFinite(v)) continue;
    const w = HEALTH_WEIGHTS[k] ?? 10;
    num += v * w; den += w;
    const c = healthCap(v);
    // the lowest cap wins; among equal caps, the lowest category value is the one to name
    if (c < cap || (c === cap && v < limitedValue)) { cap = c; limited_by = k; limitedValue = v; }
  }
  const average = den > 0 ? Math.round(num / den) : 100;
  const score = Math.max(0, Math.min(100, Math.min(average, cap)));
  return { score, average, cap, limited_by: cap < average ? limited_by : null };
}

export function scoreHealth(i: HealthInputs): HealthResult {
  const breakdown = scoreCategories(i);
  return { breakdown, ...combineHealth(breakdown) };
}
