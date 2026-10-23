// SUPABASE_URL=http://localhost:54321 SUPABASE_SERVICE_ROLE_KEY=test SUPABASE_ANON_KEY=test deno test --allow-env --node-modules-dir=none _shared/outreach/llm_test.ts
// (from supabase/functions; no network, no database). The Anthropic request shape per model, the model tiers, what the
// website assistant reads out of each provider's stream frames, and how a Claude answer is parsed as JSON.
import { assertEquals, assert, assertThrows } from "jsr:@std/assert@1";
import { anthropicRequest, DEFAULT_MODELS, REPLY_MODELS, isLlmProvider, LLM_PROVIDERS } from "./llm.ts";
import { readStreamFrame } from "./webchat.ts";
import { parseJsonText } from "./ai.ts";
import { parseJsonLoose } from "./ai_reply_engine.ts";

const q = { system: "sys", user: "hi", maxTokens: 1000, temperature: 0.4, json: false, level: "MEDIUM" as const };

Deno.test("current Claude models take effort, no temperature, and the refusal fallback", () => {
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]) {
    const { body, headers } = anthropicRequest(model, q);
    assertEquals(body.output_config, { effort: "medium" }, model);
    assertEquals(body.temperature, undefined, model);
    assertEquals(body.fallbacks, "default", model);
    assertEquals(headers["anthropic-beta"], "server-side-fallback-2026-07-01", model);
    assertEquals(body.stream, undefined);
  }
});

Deno.test("older Claude models take temperature and nothing the API would reject", () => {
  for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5", "claude-3-5-sonnet-20241022", "claude-sonnet-4-20250514"]) {
    const { body, headers } = anthropicRequest(model, q);
    assertEquals(body.temperature, 0.4, model);
    assertEquals(body.output_config, undefined, model);
    assertEquals(body.fallbacks, undefined, model);
    assertEquals(headers["anthropic-beta"], undefined, model);
  }
});

Deno.test("4.6 / 4.7 / Sonnet 5 take effort but not the fallback parameter", () => {
  for (const model of ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-5"]) {
    const { body } = anthropicRequest(model, q);
    assertEquals(body.output_config, { effort: "medium" }, model);
    assertEquals(body.fallbacks, undefined, model);
  }
});

Deno.test("a JSON call tells Claude to answer with JSON only; streaming sets stream", () => {
  const { body } = anthropicRequest("claude-sonnet-5-5", { ...q, json: true }, true);
  assert(String(body.system).startsWith("sys\n\n"));
  assert(/JSON object and nothing else/.test(String(body.system)));
  assertEquals(body.stream, true);
  assertEquals(body.max_tokens, 1000);
  assertEquals(anthropicRequest("claude-sonnet-5-5", q).body.system, "sys");
});

Deno.test("everyday calls default to Sonnet 5.5; replies to prospects to Opus 5.5", () => {
  assertEquals(DEFAULT_MODELS.anthropic, "claude-sonnet-5-5");
  assertEquals(REPLY_MODELS.anthropic, "claude-opus-5-5");
  assertEquals(REPLY_MODELS.gemini, DEFAULT_MODELS.gemini);
  assertEquals(REPLY_MODELS.openai, DEFAULT_MODELS.openai);
  assertEquals(LLM_PROVIDERS, ["gemini", "anthropic", "openai"]);
  assert(isLlmProvider("anthropic") && !isLlmProvider("claude") && !isLlmProvider(null));
});

Deno.test("Anthropic stream frames: text deltas, usage, refusal", () => {
  assertEquals(readStreamFrame("anthropic", { type: "content_block_delta", delta: { type: "text_delta", text: "he" } }).text, "he");
  assertEquals(readStreamFrame("anthropic", { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "x" } }).text, "");
  assertEquals(readStreamFrame("anthropic", { type: "message_start", message: { usage: { input_tokens: 14 } } }).tokens_in, 14);
  const end = readStreamFrame("anthropic", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { input_tokens: 14, output_tokens: 5 } });
  assertEquals([end.tokens_in, end.tokens_out, end.refused], [14, 5, false]);
  assert(readStreamFrame("anthropic", { type: "message_delta", delta: { stop_reason: "refusal" }, usage: {} }).refused);
  assertEquals(readStreamFrame("anthropic", { type: "ping" }).text, "");
});

Deno.test("Gemini stream frames: answer parts only, usage, safety stop", () => {
  const f = readStreamFrame("gemini", { candidates: [{ content: { parts: [{ text: "t", thought: true }, { text: "a" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } });
  assertEquals([f.text, f.tokens_in, f.tokens_out, f.refused], ["a", 3, 2, false]);
  assert(readStreamFrame("gemini", { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] }).refused);
  assert(readStreamFrame("gemini", { promptFeedback: { blockReason: "OTHER" } }).refused);
});

// What Claude actually returns for a JSON task is the bare object (verified live on Sonnet 5.5 and Opus 5.5). The parsers
// also accept the shapes a model might fall into: a code fence, a sentence before the object, and whitespace.
const CLAUDE_CLEAN = '{"intent":"interested","confidence":0.93,"summary":"Asks for pricing for Q1."}';
const CLAUDE_FENCED = "```json\n{\n  \"intent\": \"not_interested\",\n  \"confidence\": 0.8,\n  \"summary\": \"Declines.\"\n}\n```";
const CLAUDE_PROSE = 'Here is the classification:\n\n{"intent":"ooo","confidence":0.7,"summary":"Out of office until the 3rd (back \\"soon\\")."}\n\nLet me know if you need more.';
const NESTED = '{"variants":[{"text":"Hi {{first_name}}, happy to share pricing. Which plan size are you looking at?","rationale":"answers the ask"}],"notes":{"tone":"warm"}}';

Deno.test("parseJsonText reads a bare object, a fenced one and one wrapped in prose", () => {
  assertEquals(parseJsonText<{ intent: string }>(CLAUDE_CLEAN).intent, "interested");
  assertEquals(parseJsonText<{ intent: string }>(CLAUDE_FENCED).intent, "not_interested");
  assertEquals(parseJsonText<{ summary: string }>(CLAUDE_PROSE).summary, 'Out of office until the 3rd (back "soon").');
  assertEquals(parseJsonText<{ variants: Array<{ text: string }> }>(NESTED).variants[0].text.startsWith("Hi {{first_name}}"), true);
  assertEquals(parseJsonText<{ confidence: number }>("  \n" + CLAUDE_CLEAN + "\n ").confidence, 0.93);
  assertThrows(() => parseJsonText("I cannot classify this."), Error, "AI returned no JSON");
});

Deno.test("parseJsonLoose (auto-reply engine) handles the same shapes and ignores braces inside strings", () => {
  assertEquals(parseJsonLoose(CLAUDE_CLEAN).intent, "interested");
  assertEquals(parseJsonLoose(CLAUDE_FENCED).intent, "not_interested");
  assertEquals((parseJsonLoose(CLAUDE_PROSE) as { summary: string }).summary, 'Out of office until the 3rd (back "soon").');
  const r = parseJsonLoose('Sure: {"reply":"Use {{first_name}} and a } in text","ok":true} done.') as { reply: string; ok: boolean };
  assertEquals([r.reply, r.ok], ["Use {{first_name}} and a } in text", true]);
  assertThrows(() => parseJsonLoose('{"reply":"cut off'), Error, "incomplete JSON");
});
