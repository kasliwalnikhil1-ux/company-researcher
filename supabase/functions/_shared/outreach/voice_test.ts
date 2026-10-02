// deno test --no-config --allow-env --allow-net --allow-read supabase/functions/_shared/outreach/voice_test.ts
// The code side of the website assistant's voice: the agent we build, the prompt, the tools, the session token the
// tools trust, the webhook signature, and a finished conversation as the database takes it. voice.ts builds a database
// client at load, so the settings it reads get a stand-in.
import { assert, assertEquals } from "jsr:@std/assert@1";
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");
Deno.env.set("OUTREACH_WEBCHAT_TOKEN_KEY", "unit-test-token-key");
const V = await import("./voice.ts");
const E = await import("./elevenlabs.ts");
type Ctx = import("./voice.ts").VoiceSyncCtx;

const ctx = (o: Partial<Ctx> = {}, voice: Record<string, unknown> = {}): Ctx => ({
  ok: true, inbox_id: "11111111-1111-1111-1111-111111111111", workspace_id: "22222222-2222-2222-2222-222222222222", which: "live", deleted: false, wanted: true, name: "Polki Stories", workspace_name: "Aurum",
  account: "platform", brand: "Polki Stories", persona: "Warm and brief.", allowed_topics: "jewellery, orders, shipping", keywords: ["pricing quote", "refund"], products: true, email_form: true,
  voice: { enabled: true, voice_id: null, voice_name: null, speed: 1, stability: 0.5, language: null, languages: [], auto_language: true, hinglish: false, greeting: {}, instructions: "Offer to text links instead of reading them.",
    max_minutes: 5, silence_end_s: 20, model: "fast", tool_sound: "typing", collect: ["name", "phone", "need"], record: true, retention_days: 30, consent_text: null, ui: {}, ...voice } as Ctx["voice"],
  languages: ["en"], qa: [{ question: "Do you ship to Dubai?", answer: "Yes, in 5 to 7 days." }], limits: { included: 100, max_minutes: 5, concurrency: 5, own_key: true }, agent: null, ...o,
});
const opts = { llm: "gemini-2.5-flash", defaultVoice: "EXAVITQu4vr4xnSDxMaL" };

Deno.test("prompt: spoken style, the assistant's own persona and topics, Q&A, handoff words, the page variables", () => {
  const p = V.buildVoicePrompt(ctx());
  assert(/voice assistant for Polki Stories/.test(p) && /1–3 short sentences/.test(p));
  assert(p.includes("Warm and brief.") && p.includes("Only talk about: jewellery, orders, shipping"));
  assert(p.includes("Offer to text links instead of reading them."));
  assert(/QUICK ANSWERS[\s\S]*Q: Do you ship to Dubai\?\nA: Yes, in 5 to 7 days\./.test(p));
  assert(p.includes("Also when they mention: pricing quote; refund."));
  assert(p.includes("{{page_title}} ({{page_url}})") && p.includes("{{recent_chat}}") && p.includes("{{today}}"));
  assert(p.includes("call find_products") && p.includes("call show_email_form"));
  assert(!V.buildVoicePrompt(ctx({ products: false })).includes("find_products"));
});

Deno.test("prompt: at most 30 Q&A pairs and 8,000 characters", () => {
  const many = Array.from({ length: 50 }, (_, i) => ({ question: `Question ${i}?`, answer: "x".repeat(400) }));
  const block = V.qaBlock(many);
  assert(block.length <= 8000, String(block.length));
  assert(block.split("\n\n").length <= 30 && block.includes("Question 0?") && !block.includes("Question 40?"));
});

Deno.test("agent: what we own, exactly as the PRD lists it", () => {
  const a = V.buildAgentConfig(ctx(), ["t1", "t2"], opts) as any;
  assertEquals(a.tags, ["growthxai", "ws:22222222-2222-2222-2222-222222222222", "inbox:11111111-1111-1111-1111-111111111111", "live"]);
  assertEquals(a.platform_settings.auth, { enable_auth: true });
  assertEquals(a.platform_settings.overrides, { conversation_config_override: { agent: { language: true } } });   // nothing else can be overridden from a browser
  assertEquals(a.platform_settings.call_limits.bursting_enabled, false);
  assertEquals(a.platform_settings.queueing_config, { enabled: false });
  assertEquals(a.platform_settings.privacy, { record_voice: true, retention_days: 30 });
  assertEquals(Object.keys(a.platform_settings.data_collection), ["visitor_name", "visitor_phone", "need"]);
  assertEquals(a.conversation_config.agent.prompt.knowledge_base, []);
  assertEquals(a.conversation_config.agent.prompt.tool_ids, ["t1", "t2"]);
  assertEquals(Object.keys(a.conversation_config.agent.prompt.built_in_tools), ["end_call"]);   // language detection only with a second language
  assertEquals(a.conversation_config.tts, { model_id: "eleven_flash_v2", voice_id: "EXAVITQu4vr4xnSDxMaL", speed: 1, stability: 0.5, similarity_boost: 0.8 });
  assertEquals(a.conversation_config.conversation.max_duration_seconds, 300);
  assert(!a.conversation_config.conversation.client_events.includes("agent_tool_request"));
  assert(a.conversation_config.agent.first_message.includes("Polki Stories"));
  assert("secret__session" in a.conversation_config.agent.dynamic_variables.dynamic_variable_placeholders);
});

Deno.test("agent: a second language switches the speech model, adds a preset and language detection; the test agent sees tool events", () => {
  const a = V.buildAgentConfig(ctx({ which: "test", languages: ["hi", "en"] }, { hinglish: true, greeting: { en: "Hello there!" }, record: false, retention_days: 7, speed: 9, model: "smart" }), [], { ...opts, llm: "claude-sonnet-4-5", webhookId: "wh_1" }) as any;
  assertEquals(a.conversation_config.tts.model_id, "eleven_flash_v2_5");
  assertEquals(a.conversation_config.tts.speed, 1.2);   // clamped
  assertEquals(a.conversation_config.agent.language, "hi");
  assertEquals(a.conversation_config.agent.hinglish_mode, true);
  assertEquals(a.conversation_config.language_presets.en.overrides.agent, { first_message: "Hello there!", language: "en" });
  assertEquals(a.conversation_config.language_presets.en.overrides.tts, { model_id: "eleven_flash_v2" });
  // the provider refuses an English main language on the multilingual model: English keeps flash v2, Hindi gets its own
  const b = V.buildAgentConfig(ctx({ languages: ["en", "hi"] }), [], opts) as any;
  assertEquals(b.conversation_config.tts.model_id, "eleven_flash_v2");
  assertEquals(b.conversation_config.language_presets.hi.overrides.tts, { model_id: "eleven_flash_v2_5" });
  assert("language_detection" in a.conversation_config.agent.prompt.built_in_tools);
  assert(a.conversation_config.conversation.client_events.includes("agent_tool_request") && a.conversation_config.conversation.client_events.includes("agent_tool_response"));
  assertEquals(a.platform_settings.privacy, { record_voice: false, retention_days: 7 });
  assertEquals(a.platform_settings.workspace_overrides.webhooks.post_call_webhook_id, "wh_1");
  assert(a.name.endsWith("(test)") && a.tags.includes("test"));
});

Deno.test("tools: webhook tools carry the secret and the session; switch_to_chat is the widget's; products and email only when the website has them", () => {
  const t = V.toolConfigs(ctx(), "sec_1") as any;
  assertEquals(Object.keys(t).sort(), ["find_products", "save_contact", "search_knowledge", "show_email_form", "switch_to_chat"]);
  assertEquals(t.search_knowledge.api_schema.request_headers, { Authorization: { secret_id: "sec_1" }, "X-GX-Session": { variable_name: "secret__session" } });
  assertEquals(t.search_knowledge.response_timeout_secs, 8);
  assertEquals(t.search_knowledge.tool_call_sound, "typing");
  assert(t.search_knowledge.api_schema.url.endsWith("/outreach-voice-tools/knowledge"));
  assertEquals(t.switch_to_chat.type, "client");
  assertEquals(t.switch_to_chat.expects_response, false);
  assertEquals(t.switch_to_chat.parameters.required, ["handoff", "reason"]);
  const bare = V.toolConfigs(ctx({ products: false, email_form: false }, { tool_sound: "none" }), "sec_1") as any;
  assertEquals(Object.keys(bare).sort(), ["save_contact", "search_knowledge", "switch_to_chat"]);
  assert(!("tool_call_sound" in bare.search_knowledge));
});

Deno.test("session token: signed, bound to its call, expires, and any edit breaks it", async () => {
  const s = { call_id: "c1", inbox_id: "i1", chat_id: "h1", visitor_id: "v1", el_conversation_id: "conv_1" };
  const tok = await V.mintSession(s, 600);
  const got = await V.verifySession(tok);
  assertEquals(got && { ...got, exp: 0 }, { ...s, exp: 0 });
  assertEquals(await V.verifySession(tok.slice(0, -1) + (tok.endsWith("a") ? "b" : "a")), null);
  const [body, sig] = tok.split(".");
  const other = btoa(JSON.stringify({ c: "c2", i: "i1", x: 9999999999 })).replace(/=+$/, "");
  assertEquals(await V.verifySession(`${other}.${sig}`), null);
  assertEquals(await V.verifySession(`${body}.`), null);
  assertEquals(await V.verifySession(await V.mintSession(s, -5)), null);
  assertEquals(await V.verifySession(null), null);
});

Deno.test("dynamic variables: no template braces, one line, cut to length", () => {
  assertEquals(V.dv("  Polki {{secret__session}}\nchoker  ", 50), "Polki secret__session choker");
  assertEquals(V.dv("x".repeat(20), 5), "xxxxx");
  assert(/\d{4}$/.test(V.todayIn("Asia/Kolkata")) && /\d{4}$/.test(V.todayIn("Not/AZone")));
});

Deno.test("webhook signature: t=…,v0=… over \"t.body\"; wrong secret, stale timestamp and a changed body fail; any of several v0 passes", async () => {
  const body = '{"type":"post_call_transcription"}', secret = "wsec_test", now = 1_800_000_000_000, t = Math.floor(now / 1000);
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${t}.${body}`)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  assert(await E.verifyElSignature(body, `t=${t},v0=${sig}`, secret, 1800, now));
  assert(await E.verifyElSignature(body, `t=${t},v0=${"0".repeat(64)},v0=${sig}`, secret, 1800, now));
  assert(!(await E.verifyElSignature(body, `t=${t},v0=${sig}`, "another", 1800, now)));
  assert(!(await E.verifyElSignature(body + " ", `t=${t},v0=${sig}`, secret, 1800, now)));
  assert(!(await E.verifyElSignature(body, `t=${t},v0=${sig}`, secret, 1800, now + 1801_000)));
  assert(!(await E.verifyElSignature(body, null, secret)) && !(await E.verifyElSignature(body, "v0=abc", secret)) && !(await E.verifyElSignature(body, `t=${t},v0=${sig}`, "")));
});

Deno.test("a finished conversation: spoken turns only, collected values, cost in both shapes, empty values dropped", () => {
  const n = E.normalizeConversation({
    status: "done", has_audio: true,
    transcript: [{ role: "agent", message: "Hi!", time_in_call_secs: 0 }, { role: "user", message: "Do you ship to Dubai?", time_in_call_secs: 3 }, { role: "agent", message: null, tool_calls: [{}], time_in_call_secs: 4 }, { role: "tool", message: "x" }],
    metadata: { call_duration_secs: 192, cost: 420, cost_fiat: { amount: 0.21, currency: "usd" }, termination_reason: "end_call tool was called", main_language: "en" },
    analysis: { transcript_summary: "Asked about shipping.", call_summary_title: "Shipping", call_successful: "success",
      data_collection_results: { visitor_name: { value: "Asha" }, visitor_phone: { value: "+971501234567" }, need: { value: null }, budget: { value: "None" }, other: { value: "ignored" } } },
  });
  assertEquals(n.transcript.length, 2);
  assertEquals(n.transcript[1], { role: "user", message: "Do you ship to Dubai?", time_in_call_secs: 3 });
  assertEquals([n.duration_s, n.cost_credits, n.cost_usd, n.successful, n.has_audio, n.main_language], [192, 420, 0.21, "success", true, "en"]);
  assertEquals(n.collected, { visitor_name: "Asha", visitor_phone: "+971501234567" });
  assertEquals(E.normalizeConversation({ metadata: { cost_fiat: 0.0875 } }).cost_usd, 0.0875);
  const empty = E.normalizeConversation({});
  assertEquals([empty.transcript.length, empty.duration_s, empty.successful, empty.has_audio], [0, null, null, false]);
});

Deno.test("greeting: the website's own, else ours in that language, else English", () => {
  const c = ctx();
  assertEquals(V.greetingFor({ ...c.voice, greeting: { en: "Welcome!" } }, "en", "Polki"), "Welcome!");
  assert(V.greetingFor(c.voice, "hi", "Polki").startsWith("नमस्ते"));
  assert(V.greetingFor(c.voice, "ta", "Polki").startsWith("Hi! I'm the Polki assistant"));
});
