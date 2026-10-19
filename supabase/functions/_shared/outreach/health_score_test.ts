// deno test supabase/functions/_shared/outreach/health_score_test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { combineHealth, healthCap, scoreHealth, type HealthInputs } from "./health_score.ts";

const base: HealthInputs = {
  currently_ok: true, disconnects_14d: 0, checkpoints_30d: 0, rejects_14d: 0, actions_14d: 200,
  invites_14d: 0, accepted_14d: 0, messages_14d: 0, replies_14d: 0, daily_actions_14d: [],
  today_actions: 0, idle_days_before_today: 0, health_score: 100, health_high_since: null,
  warmup_level: 1, warmup_locked_until: null, is_premium: false,
};

Deno.test("all categories at 100 → 100, nothing limits", () => {
  const r = scoreHealth(base);
  assertEquals(r.score, 100); assertEquals(r.average, 100); assertEquals(r.limited_by, null);
  assertEquals(Object.keys(r.breakdown).sort(), ["acceptance_rate", "consistency", "rejection_rate", "reply_rate", "session_stability", "verification"]);
});

Deno.test("the screenshot: five at 100, rejection rate 20 → 60 held by rejection rate (was 20)", () => {
  const r = scoreHealth({ ...base, rejects_14d: 30, actions_14d: 200 }); // 15 % rejected
  assertEquals(r.breakdown.rejection_rate, 20);
  assertEquals(r.average, 80);
  assertEquals(r.cap, 60);
  assertEquals(r.score, 60);
  assertEquals(r.limited_by, "rejection_rate");
});

Deno.test("one checkpoint (verification 70) → 95, average stands", () => {
  const r = scoreHealth({ ...base, checkpoints_30d: 1 });
  assertEquals(r.breakdown.verification, 70);
  assertEquals(r.average, 96); // 100 - 30*15/100 = 95.5 → 96
  assertEquals(r.score, 90); // cap(70) = 90
  assertEquals(r.limited_by, "verification");
});

Deno.test("burst after idle days (consistency 10) still pauses", () => {
  const r = scoreHealth({ ...base, daily_actions_14d: [10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], idle_days_before_today: 6, today_actions: 80 });
  assertEquals(r.breakdown.consistency, 10);
  assertEquals(r.cap, 40);
  assertEquals(r.score, 40);
  assertEquals(r.score < 50, true);
});

Deno.test("disconnected with four drops (session 0) still pauses", () => {
  const r = scoreHealth({ ...base, currently_ok: false, disconnects_14d: 4 });
  assertEquals(r.breakdown.session_stability, 0);
  assertEquals(r.score, 40);
  assertEquals(r.limited_by, "session_stability");
});

Deno.test("two weak categories both count in the average", () => {
  // rejection 60 (4 %) + acceptance 45 (10 % of 50 invites): average = 100 - (40*25 + 55*15)/100 = 100 - 18.25 → 82; cap(45) = 75
  const r = scoreHealth({ ...base, rejects_14d: 8, actions_14d: 200, invites_14d: 50, accepted_14d: 5 });
  assertEquals(r.breakdown.rejection_rate, 60); assertEquals(r.breakdown.acceptance_rate, 45);
  assertEquals(r.average, 82); assertEquals(r.score, 75); assertEquals(r.limited_by, "acceptance_rate");
});

Deno.test("WhatsApp adds block_signals + new_chat_reply_rate and they weigh in", () => {
  const r = scoreHealth({ ...base, provider: "WHATSAPP", blocks_30d: 1, new_chats_14d: 40, new_chats_replied_14d: 20 });
  assertEquals(r.breakdown.block_signals, 70); assertEquals(r.breakdown.new_chat_reply_rate, 100);
  assertEquals(Object.keys(r.breakdown).length, 8);
  assertEquals(r.average, 96); // weights sum 135: 100 - 30*20/135 = 95.56 → 96
  assertEquals(r.score, 90); // cap(70) = 90
  assertEquals(r.limited_by, "block_signals");
});

Deno.test("caps are monotone and the average alone never exceeds the lowest cap", () => {
  assertEquals([100, 85, 84, 60, 59, 40, 39, 20, 19, 0].map(healthCap), [100, 100, 90, 90, 75, 75, 60, 60, 40, 40]);
  const r = combineHealth({ a: 100, b: 100, c: 0 });
  assertEquals(r.cap, 40); assertEquals(r.score, 40); assertEquals(r.limited_by, "c");
  const s = combineHealth({ a: 90, b: 90 });
  assertEquals(s.score, 90); assertEquals(s.limited_by, null);
});
