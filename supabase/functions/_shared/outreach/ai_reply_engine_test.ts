// SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x deno test -A --node-modules-dir=none supabase/functions/_shared/outreach/ai_reply_engine_test.ts
// (the engine imports supabase.ts, which reads its env at load time; no database is touched)
// Parity rule (docs/outreach/AI-REPLIES-V2-CONTRACT.md §7): the auto and manual prompts for the same context differ only in
// the STATE block's Trigger line and the optional GUIDANCE block. No network: buildDraftPrompt is pure.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { buildDraftPrompt, stopRulesOf, effectiveBody, DEFAULT_SETTINGS, type EngineInput } from "./ai_reply_engine.ts";

const BODY = `## Who I am
I'm Naman, founder at Kaptured.
## Situations
- Pricing question: when they ask what it costs → say projects start at ₹50,000
## Stop when
Stop replying after any of these. A person takes over from there.
- I've shared my calendar link, or we've agreed a meeting time.
- They ask to speak to someone directly.
## Facts I can use
- Calendar: https://cal.com/naman/15min
## Style
- Short.`;

function ctx(o: Partial<EngineInput> = {}): EngineInput {
  return {
    workspaceId: "ws", settings: DEFAULT_SETTINGS, editorMode: "guided", promptBody: BODY, promptVersion: 7, promptId: "mp",
    scenarios: [{ id: "c1", title: "Pricing question", when_text: "they ask what it costs", do_text: "say projects start at ₹50,000", enabled: true }, { id: "c2", title: "Off", when_text: "x", do_text: "y", enabled: false }],
    faqs: [{ id: "f1", question: "Do you shoot on location?", answer: "Yes." }], knowledgeSourceIds: [], leadNotes: { summary: "Budget ~2L", items: [{ id: "n1", key: "budget", text: "around 2 lakh" }] },
    senderName: "Naman Jain", tz: "Asia/Kolkata", lead: { full_name: "Ann", title: "CMO", company: "Brewly", location: "Mumbai" },
    thread: [{ from: "us_sequence", text: "Hi Ann", at: "2026-09-29T10:00:00Z" }, { from: "prospect", text: "What does it cost?", at: "2026-09-30T10:00:00Z", answered: true }],
    state: { stage: "engage", exchanges: 0, last_move: null, ai_replies_count: 0, session_kind: "normal" },
    classification: [{ intent: "question", flags: ["pricing"], questions: ["What does it cost?"], language: "en" } as any], flags: ["pricing"], firstStep: "message (n1)",
    schedulingDomains: [{ host: "cal.com", path_prefix: null }], purpose: "reply_draft", ...o,
  };
}

Deno.test("parity: auto vs manual differ only in the Trigger line and the GUIDANCE block", () => {
  const c = ctx();
  const a = buildDraftPrompt(c, { trigger: "auto" }, [], c.faqs).user.split("\n");
  const m = buildDraftPrompt(c, { trigger: "manual", guidance: "shorter, ask about budget" }, [], c.faqs).user.split("\n");
  const onlyA = a.filter((l) => !m.includes(l)), onlyM = m.filter((l) => !a.includes(l));
  assertEquals(onlyA, ["- Trigger: auto"]);
  assertEquals(onlyM.length, 3);
  assert(onlyM[0].startsWith("- Trigger: manual"));
  assert(onlyM[1].startsWith("GUIDANCE from the person asking"));
  assertEquals(onlyM[2], "shorter, ask about budget");
  assertEquals(buildDraftPrompt(c, { trigger: "auto" }, [], []).system, buildDraftPrompt(c, { trigger: "manual" }, [], []).system);
});

Deno.test("manual without guidance adds only the Trigger line", () => {
  const c = ctx();
  const a = buildDraftPrompt(c, { trigger: "auto" }, [], []).user.split("\n");
  const m = buildDraftPrompt(c, { trigger: "manual" }, [], []).user.split("\n");
  assertEquals(m.filter((l) => !a.includes(l)).length, 1);
});

Deno.test("STATE block carries session, cards (enabled only), stop rules, lead notes; knowledge block lists Q&A", () => {
  const c = ctx({ state: { stage: null, exchanges: 0, last_move: null, ai_replies_count: 0, session_kind: "dormant", gap_days: 45, previous_stage: "relate" } });
  const u = buildDraftPrompt(c, { trigger: "auto" }, [{ text: "A three-film package costs ₹1,20,000", title: "Rate card" }], c.faqs).user;
  assert(u.includes("- Session: dormant, back after 45 days → Re-engage"));
  assert(u.includes("- Conversation stage: Re-engage"));
  assert(u.includes("- Previous stage: relate"));
  assert(u.includes("- Situation cards (id · title): c1 · Pricing question"));
  assert(!u.includes("c2 · Off"));
  assert(u.includes("- Stop when rules: [1] I've shared my calendar link, or we've agreed a meeting time. [2] They ask to speak to someone directly."));
  assert(u.includes("summary: Budget ~2L") && u.includes("- budget: around 2 lakh"));
  assert(u.includes("KNOWLEDGE") && u.includes("Q: Do you shoot on location?") && u.includes("[Rate card] A three-film package"));
  assert(u.includes("at least 1 before pitching"), "dormant sessions pitch after one exchange");
});

Deno.test("stopRulesOf parses the Stop when section; effectiveBody appends cards to a raw prompt without Situations", () => {
  assertEquals(stopRulesOf(BODY), ["I've shared my calendar link, or we've agreed a meeting time.", "They ask to speak to someone directly."]);
  assertEquals(stopRulesOf("## Facts\n- x"), []);
  const raw = effectiveBody({ promptBody: "## Who I am\nMe.", editorMode: "raw", scenarios: ctx().scenarios });
  assert(raw.includes("## Situations\n- Pricing question: when they ask what it costs → say projects start at ₹50,000"));
  assert(!raw.includes("Off"));
  assertEquals(effectiveBody({ promptBody: BODY, editorMode: "raw", scenarios: ctx().scenarios }), BODY, "a raw prompt with its own Situations is left alone");
  assertEquals(effectiveBody({ promptBody: BODY, editorMode: "guided", scenarios: ctx().scenarios }), BODY, "guided prompts are compiled server-side");
});
