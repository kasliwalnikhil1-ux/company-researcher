// End-to-end check of the website agent's voice (web-chat-voice-elevenlabs-PRD.md §16) against a LOCAL Supabase
// stack and a pretend voice provider (scripts/outreach-fake-elevenlabs.ts). It starts the real edge functions as child
// processes behind a small proxy, drives them the way the widget, the app, the provider and the cron do, and asserts
// what lands in the database and at the provider.
//
// It does NOT prove the real provider accepts our requests: the pretend one speaks the shapes read from its docs.
// A first call with a real key is still needed (docs/outreach/WEBCHAT.md "Voice" → Verify with a real key).
//
// Needs migration 069 on the local database and a website to use (default: the "Aurum Jewels" fixture of the web chat
// products test, with its owner wbp@test.local). It refuses to run against anything that is not localhost.
//   SUPABASE_URL=http://127.0.0.1:55321 SUPABASE_SERVICE_ROLE_KEY=… SUPABASE_ANON_KEY=… \
//   deno run -A --no-config --node-modules-dir=none scripts/outreach-voice-e2e.ts
import { startFakeElevenLabs } from "./outreach-fake-elevenlabs.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(SUPABASE_URL)) { console.error("This test only runs against a local Supabase stack (SUPABASE_URL must be localhost)."); Deno.exit(2); }
const DB = Deno.env.get("OUTREACH_E2E_DB_CONTAINER") ?? "supabase_db_aireplytest";
const INBOX_NAME = Deno.env.get("OUTREACH_E2E_INBOX") ?? "Aurum Jewels";
const LOGIN = { email: Deno.env.get("OUTREACH_E2E_EMAIL") ?? "wbp@test.local", password: Deno.env.get("OUTREACH_E2E_PASSWORD") ?? "WbpTest-2026" };
const P = { proxy: 4720, fake: 4710 };
const FNS: Record<string, number> = { "outreach-webchat": 4721, "outreach-voice-tools": 4722, "outreach-elevenlabs-webhook": 4723, "outreach-voice-admin": 4724, "outreach-webchat-worker": 4725, "outreach-workspace-secrets": 4726 };
const BASE = `http://127.0.0.1:${P.proxy}`, ORIGIN = "http://localhost:3000", WH_SECRET = "whsec_e2e_secret", CRON = "cron-e2e";
type Row = Record<string, any>;

// ---------------------------------------------------------------------------------------------------- helpers
let passed = 0, failed = 0;
function check(name: string, ok: unknown, detail?: unknown): void {
  if (ok) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? `\n     ${typeof detail === "string" ? detail : JSON.stringify(detail)?.slice(0, 600)}` : ""}`); }
}
async function sql(q: string): Promise<string> {
  const c = new Deno.Command("docker", { args: ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At", "-q"], stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = c.stdin.getWriter(); await w.write(new TextEncoder().encode(q)); await w.close();
  const o = await c.output();
  if (!o.success) throw new Error(`sql: ${new TextDecoder().decode(o.stderr).slice(0, 500)}\n${q.slice(0, 200)}`);
  return new TextDecoder().decode(o.stdout).trim();
}
const sqlJson = async <T = any>(q: string): Promise<T> => { const s = await sql(q); return (s ? JSON.parse(s) : null) as T; };
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any; res: Response }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get("content-type") ?? "";
  let json: any = null;
  if (ct.includes("json")) { try { json = await res.json(); } catch { /* empty */ } } else if (!ct.startsWith("audio/")) await res.text();
  return { status: res.status, json, res };
}
const worker = (sweep = true) => http("POST", "/outreach-webchat-worker", { mode: "voice", sweep }, { "x-cron-secret": CRON });

// ---------------------------------------------------------------------------------------------------- processes
const fake = startFakeElevenLabs(P.fake);
const children: Deno.ChildProcess[] = [];
const childEnv = {
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE, SUPABASE_ANON_KEY: ANON, OUTREACH_FUNCTIONS_BASE_URL: `${BASE}/`, OUTREACH_WEB_ORIGIN: ORIGIN, OUTREACH_CRON_SECRET: CRON,
  OUTREACH_ELEVENLABS_API_KEY: "platform-key-e2e", OUTREACH_ELEVENLABS_API_BASE: `http://127.0.0.1:${P.fake}`, OUTREACH_ELEVENLABS_WEBHOOK_SECRET: WH_SECRET,
  OUTREACH_COOKIE_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))), OUTREACH_WEBCHAT_TOKEN_KEY: "e2e-token-key-0123456789abcdef0123456789",
};
const root = new URL("..", import.meta.url);
for (const [name, port] of Object.entries(FNS)) {
  children.push(new Deno.Command(Deno.execPath(), { args: ["run", "-A", "--no-config", "--node-modules-dir=none", `supabase/functions/${name}/index.ts`], cwd: root, env: { ...childEnv, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}` },
    stdout: Deno.env.get("E2E_VERBOSE") ? "inherit" : "null", stderr: Deno.env.get("E2E_VERBOSE") ? "inherit" : "null" }).spawn());
}
// the functions are reached the way they are in production: <base>/outreach-<name>/<path>
const proxy = Deno.serve({ port: P.proxy, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
  const u = new URL(req.url), name = u.pathname.split("/")[1], port = FNS[name];
  if (!port) return new Response("no such function", { status: 404 });
  try { return await fetch(`http://127.0.0.1:${port}${u.pathname}${u.search}`, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer() }); }
  catch (e) { return new Response(String(e), { status: 502 }); }
});
async function stop(code: number): Promise<never> {
  for (const c of children) { try { c.kill(); } catch { /* gone */ } }
  await proxy.shutdown().catch(() => {}); await fake.close().catch(() => {});
  Deno.exit(code);
}
// wait until every function answers
for (const [name, port] of Object.entries(FNS)) {
  let up = false;
  for (let i = 0; i < 240 && !up; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/${name}`, { method: "OPTIONS" }); await r.body?.cancel(); up = true; } catch { await sleep(500); } }
  if (!up) { console.error(`${name} did not start (run with E2E_VERBOSE=1 to see why)`); await stop(2); }
}

// ---------------------------------------------------------------------------------------------------- fixtures
const inbox = await sqlJson<Row>(`select to_jsonb(i) from outreach_webchat_inboxes i where name = ${lit(INBOX_NAME)} and deleted_at is null limit 1`);
if (!inbox) { console.error(`No website named "${INBOX_NAME}" on the local stack.`); await stop(2); }
const IB: string = inbox.id, WS: string = inbox.workspace_id, TOKEN: string = inbox.website_token;
const original = { settings: inbox.settings, ai_enabled: inbox.ai_enabled, is_active: inbox.is_active };
const flagsBefore = await sqlJson<Row[]>(`select coalesce(jsonb_agg(jsonb_build_object('key', key, 'value', value)), '[]'::jsonb) from outreach_flags where key like 'voice_%'`);
const otherWs = await sql(`select id from outreach_workspaces where id <> ${lit(WS)} limit 1`);
const setSettings = (patch: Row) => sql(`update outreach_webchat_inboxes set settings = outreach_webchat__merge(settings, ${lit(JSON.stringify(patch))}::jsonb), config_version = config_version + 1 where id = ${lit(IB)}`);
const setFlag = (key: string, value: unknown) => sql(`insert into outreach_flags(key, value) values (${lit(key)}, ${lit(JSON.stringify(value))}::jsonb) on conflict (key) do update set value = excluded.value`);
const LIMITS = { minutes: 100, max_minutes: 10, concurrency: 5, own_key: true };

async function cleanup(): Promise<void> {
  await sql(`
    delete from outreach_chats where webchat_inbox_id = ${lit(IB)} and visitor_id in (select id from outreach_webchat_visitors where inbox_id = ${lit(IB)} and custom_attributes ? 'e2e_voice');
    delete from outreach_webchat_visitors where inbox_id = ${lit(IB)} and custom_attributes ? 'e2e_voice';
    delete from outreach_webchat_voice_calls where inbox_id = ${lit(IB)};
    delete from outreach_webchat_voice_agents where inbox_id = ${lit(IB)};
    delete from outreach_webchat_voice_cleanup;
    delete from outreach_knowledge_sources where title like 'e2e voice %';
    delete from outreach_master_prompt_faqs where question like 'e2e voice:%';
    delete from outreach_ai_unanswered_questions where workspace_id = ${lit(WS)} and canonical like '%zzqx%';
    delete from outreach_rate_limits where key like 'webchat:%' or key like 'voice_admin:%' or key like 'workspace_secrets:%';
    update outreach_workspace_secrets set elevenlabs_key_enc = null, elevenlabs_key_hint = null, elevenlabs_webhook_id = null, elevenlabs_webhook_secret_enc = null where workspace_id = ${lit(WS)};
    delete from outreach_flags where key like 'voice_%';
    update outreach_webchat_inboxes set settings = ${lit(JSON.stringify(original.settings))}::jsonb, ai_enabled = ${original.ai_enabled}, is_active = ${original.is_active}, deleted_at = null where id = ${lit(IB)};
    update outreach_senders set status = 'ok', deleted_at = null where id = ${lit(inbox.sender_id)};`);
  for (const f of flagsBefore ?? []) await setFlag(f.key, f.value);
}

try {
  await cleanup();
  await setFlag("voice_default_limits", LIMITS);
  await setFlag("voice_llm_models", { fast: "gemini-2.5-flash", smart: "claude-sonnet-4-5" });
  await setFlag("voice_platform_concurrency", 30);
  // knowledge of this website, a look-alike in another workspace (it must never be found), one Q&A pair
  const src = await sql(`insert into outreach_knowledge_sources(workspace_id, kind, title, status, chunks) values (${lit(WS)}, 'text', 'e2e voice shipping', 'ready', 2) returning id`);
  await sql(`insert into outreach_knowledge_chunks(source_id, workspace_id, seq, heading, text) values
    (${lit(src)}, ${lit(WS)}, 1, 'Shipping to the UAE', 'We ship to Dubai and the rest of the UAE in 5 to 7 working days. Shipping to Dubai costs AED 60.'),
    (${lit(src)}, ${lit(WS)}, 2, 'Returns', 'Returns are accepted within 14 days of delivery.')`);
  if (otherWs) {
    const o = await sql(`insert into outreach_knowledge_sources(workspace_id, kind, title, status, chunks) values (${lit(otherWs)}, 'text', 'e2e voice other workspace', 'ready', 1) returning id`);
    await sql(`insert into outreach_knowledge_chunks(source_id, workspace_id, seq, heading, text) values (${lit(o)}, ${lit(otherWs)}, 1, 'Shipping to Dubai', 'OTHER-WORKSPACE-SECRET: shipping to Dubai takes one day.')`);
  }
  await sql(`insert into outreach_master_prompt_faqs(workspace_id, question, answer) values (${lit(WS)}, 'e2e voice: Do you offer gift wrapping?', 'Yes, gift wrapping is free on every order.')`);
  await sql(`update outreach_webchat_inboxes set ai_enabled = true, is_active = true where id = ${lit(IB)}`);
  await setSettings({ ai: { mode: "first", knowledge_source_ids: [src], persona: "Warm and brief.", handoff: { keywords: ["refund"], max_turns: 50, low_confidence_streak: 2 } },
    voice: { enabled: true }, security: { allow_localhost: true, rate_limits: { ip_1m: 5000, ip_1h: 50000, visitor_10s: 100 } } });

  const login = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: ANON, "content-type": "application/json" }, body: JSON.stringify(LOGIN) }).then((r) => r.json());
  if (!login?.access_token) { console.error("Could not sign in the test user:", JSON.stringify(login).slice(0, 200)); await stop(2); }
  const JWT = { authorization: `Bearer ${login.access_token}` };
  const agentRow = (which: string) => sqlJson<Row>(`select to_jsonb(a) from outreach_webchat_voice_agents a where inbox_id = ${lit(IB)} and which = ${lit(which)}`);
  const callRow = (id: string) => sqlJson<Row>(`select to_jsonb(k) from outreach_webchat_voice_calls k where id = ${lit(id)}`);

  // ================================================================ A. agent sync
  let r = await worker();
  let live = await agentRow("live");
  let ag = fake.state.agents.get(live?.el_agent_id);
  const cfg = ag?.conversation_config, ps = ag?.platform_settings;
  const toolNames = (a: Row) => (a?.conversation_config?.agent?.prompt?.tool_ids ?? []).map((t: string) => fake.state.tools.get(t)?.name);
  check("sync: the live agent is created with its tags", fake.state.agents.size === 1 && ag?.tags?.includes("live") && ag.tags.includes(`inbox:${IB}`) && ag.tags.includes(`ws:${WS}`) && ag.tags.includes("growthxai"), { worker: r.json, tags: ag?.tags });
  check("sync: auth on, only the language can be overridden, no bursting, no queue", ps?.auth?.enable_auth === true && JSON.stringify(ps?.overrides) === JSON.stringify({ conversation_config_override: { agent: { language: true } } })
    && ps?.call_limits?.bursting_enabled === false && ps?.queueing_config?.enabled === false && ps?.call_limits?.agent_concurrency_limit === LIMITS.concurrency, ps);
  check("sync: five tools, the provider's knowledge base unused, tool events off on the live agent", JSON.stringify(toolNames(ag).sort()) === JSON.stringify(["find_products", "save_contact", "search_knowledge", "show_email_form", "switch_to_chat"])
    && Array.isArray(cfg?.agent?.prompt?.knowledge_base) && cfg.agent.prompt.knowledge_base.length === 0 && !cfg?.conversation?.client_events?.includes("agent_tool_request") && cfg?.conversation?.client_events?.includes("agent_chat_response_part"), { tools: toolNames(ag), events: cfg?.conversation?.client_events });
  check("sync: prompt carries the persona, the Q&A and the handoff words; model from the flag; English model; call length", /Warm and brief\./.test(cfg?.agent?.prompt?.prompt ?? "") && /QUICK ANSWERS[\s\S]*gift wrapping is free/.test(cfg.agent.prompt.prompt)
    && /Also when they mention: refund/.test(cfg.agent.prompt.prompt) && cfg.agent.prompt.llm === "gemini-2.5-flash" && cfg.tts.model_id === "eleven_flash_v2" && cfg.conversation.max_duration_seconds === 300 && cfg.turn.silence_end_call_timeout === 20, cfg?.agent?.prompt?.prompt?.slice(0, 300));
  const secret = fake.state.secrets.get(live?.el_secret_id);
  const searchTool = [...fake.state.tools.values()].find((t) => t.name === "search_knowledge");
  check("sync: the tools send the agent's secret and the session variable; we keep the secret's hash only", /^Bearer [0-9a-f]{64}$/.test(secret?.value ?? "") && /^[0-9a-f]{64}$/.test(live?.tool_secret_hash ?? "") && live.tool_secret_hash !== secret.value.slice(7)
    && searchTool?.api_schema?.request_headers?.Authorization?.secret_id === live.el_secret_id && searchTool.api_schema.request_headers["X-GX-Session"]?.variable_name === "secret__session"
    && searchTool.api_schema.url === `${BASE}/outreach-voice-tools/knowledge` && searchTool.response_timeout_secs === 8, searchTool?.api_schema);
  const before = { patches: fake.count("PATCH", "/v1/convai/"), creates: fake.count("POST", "/v1/convai/") };
  r = await worker();
  check("sync: an unchanged website makes no call to the provider", fake.count("PATCH", "/v1/convai/") === before.patches && fake.count("POST", "/v1/convai/") === before.creates, r.json);
  await setSettings({ ai: { persona: "Warm, brief, a little playful." } });
  await worker();
  check("sync: a change of the assistant's settings is one update of the live agent", fake.count("PATCH", "/v1/convai/agents/") === 1 && /a little playful/.test(fake.state.agents.get(live.el_agent_id)?.conversation_config?.agent?.prompt?.prompt ?? ""));

  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/draft`, { draft: { speed: 1.1, languages: ["hi"], greeting: { hi: "नमस्ते! मैं आपकी क्या मदद करूँ?" }, max_minutes: 3 } }, JWT);
  const test = await agentRow("test");
  const tg = fake.state.agents.get(test?.el_agent_id), lg = fake.state.agents.get(live.el_agent_id);
  check("draft: only the test agent changes (speed, second language, tool events); the live agent keeps what is published", r.json?.ok === true && fake.state.agents.size === 2 && tg?.tags?.includes("test") && tg.conversation_config.tts.speed === 1.1
    && tg.conversation_config.tts.model_id === "eleven_flash_v2" && tg.conversation_config.language_presets?.hi?.overrides?.tts?.model_id === "eleven_flash_v2_5" && tg.conversation_config.language_presets?.hi?.overrides?.agent?.first_message?.startsWith("नमस्ते") && !!tg.conversation_config.agent.prompt.built_in_tools.language_detection
    && tg.conversation_config.conversation.client_events.includes("agent_tool_request") && tg.conversation_config.conversation.max_duration_seconds === 180
    && lg.conversation_config.tts.speed === 1 && !lg.conversation_config.language_presets?.hi && test.el_secret_id !== live.el_secret_id, { r: r.json, tts: tg?.conversation_config?.tts });
  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/draft`, { draft: { speed: 9 } }, JWT);
  check("draft: a value outside its range is refused", r.status === 400 && /speed/.test(JSON.stringify(r.json)), r.json);
  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/draft`, { draft: {} });
  check("voice admin: no session, no access", r.status === 401, r.status);

  // the provider is down: the error is kept, the live agent keeps its last good configuration, Retry heals
  const hashBefore = (await agentRow("live")).config_hash;
  fake.failNext("/v1/convai/agents/", 500, 50);
  await setSettings({ ai: { persona: "Formal." } });
  await worker();
  let bad = await agentRow("live");
  check("sync failure: the error shows on the row, the live agent keeps its configuration", !!bad?.sync_error && bad.sync_attempts === 1 && bad.config_hash === hashBefore && bad.config_hash !== bad.want_hash
    && /a little playful/.test(fake.state.agents.get(live.el_agent_id)?.conversation_config?.agent?.prompt?.prompt ?? ""), { error: bad?.sync_error, attempts: bad?.sync_attempts });
  await worker();
  bad = await agentRow("live");
  check("sync failure: the next round waits (backoff)", bad.sync_attempts === 1, bad.sync_attempts);
  fake.clearFails();
  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/sync`, { which: "live" }, JWT);
  bad = await agentRow("live");
  check("sync: Retry (forced) brings the live agent up to date and clears the error", r.json?.ok === true && bad.sync_error === null && bad.sync_attempts === 0 && bad.config_hash === bad.want_hash && /Formal\./.test(fake.state.agents.get(live.el_agent_id)?.conversation_config?.agent?.prompt?.prompt ?? ""), { r: r.json, error: bad?.sync_error });

  // ================================================================ B. starting a call
  const W = { origin: ORIGIN, "x-website-token": TOKEN };
  async function visitor(): Promise<{ vt: string; id: string; h: Record<string, string> }> {
    const v = await http("POST", `/outreach-webchat/visitor?token=${TOKEN}`, { locale: "en", page: { url: "http://localhost:3000/products/polki-choker", title: "Polki choker" } }, W);
    await sql(`update outreach_webchat_visitors set custom_attributes = custom_attributes || '{"e2e_voice": true}' where id = ${lit(v.json.visitor.id)}`);
    return { vt: v.json.visitor_token, id: v.json.visitor.id, h: { ...W, authorization: `Bearer ${v.json.visitor_token}` } };
  }
  const conversation = async (h: Record<string, string>): Promise<string> => (await http("POST", `/outreach-webchat/conversations?token=${TOKEN}`, { source: "launcher", page: { url: "http://localhost:3000/", title: "Home" } }, h)).json.conversation.id;
  const start = (chat: string, h: Record<string, string>, consent = true) => http("POST", `/outreach-webchat/conversations/${chat}/voice/start?token=${TOKEN}`, { consent, locale: "en-US", page: { url: "http://localhost:3000/products/polki-choker", title: "Polki {{choker}}" } }, h);

  const cfgPub = await http("GET", `/outreach-webchat/config?token=${TOKEN}`, undefined, { origin: ORIGIN });
  const pv = cfgPub.json?.settings?.voice;
  check("config: the widget learns that voice is on, the call view's texts and languages, and no id of any kind", pv?.enabled === true && pv.ui?.start_text === "Talk to us" && JSON.stringify(pv.languages) === '["en"]' && pv.record === true
    && !/agent_|voice_id|instructions|collect/.test(JSON.stringify(pv)), pv);

  const v1 = await visitor(), chat1 = await conversation(v1.h);
  r = await start(chat1, v1.h, false);
  check("start: no call before the visitor agreed to the consent text", r.json?.ok === false && r.json.reason === "consent", r.json);
  r = await start(chat1, v1.h);
  const s1 = r.json;
  let k1 = s1?.call_id ? await callRow(s1.call_id) : null;
  const card = await sqlJson<Row>(`select to_jsonb(m) from outreach_messages m where chat_id = ${lit(chat1)} and content_type = 'event' and content_attributes->>'kind' = 'voice_call'`);
  check("start: a token is minted and the call row links the provider's conversation before the call begins", s1?.ok === true && /^tok_conv_/.test(s1.conversation_token) && k1?.el_conversation_id === s1.el_conversation_id && k1.status === "starting"
    && k1.el_agent_id === live.el_agent_id && k1.chat_id === chat1 && k1.max_minutes === 5 && s1.language === "en", s1);
  check("start: the variables carry the page, today and a signed session; braces from the page title cannot reach the prompt", typeof s1?.dynamic_variables?.secret__session === "string" && s1.dynamic_variables.secret__session.includes(".")
    && s1.dynamic_variables.page_title === "Polki choker" && s1.dynamic_variables.brand.length > 0 && /\d{4}$/.test(s1.dynamic_variables.today), s1?.dynamic_variables);
  check("start: the call has its card in the thread, and the visitor's consent is recorded", card?.content_attributes?.status === "live" && card.content_attributes.call_id === s1.call_id
    && (await sql(`select voice_consent_at is not null from outreach_webchat_visitors where id = ${lit(v1.id)}`)) === "t" && (await sql(`select voice_calls from outreach_chats where id = ${lit(chat1)}`)) === "1", card?.content_attributes);

  // ---- every refusal keeps the visitor in chat
  const v2 = await visitor(), chat2 = await conversation(v2.h);
  await setSettings({ ai: { mode: "review" } });
  r = await start(chat2, v2.h);
  const pubReview = (await sqlJson<Row>(`select outreach_webchat_public_config(${lit(TOKEN)}, ${lit(ORIGIN)})`))?.settings?.voice;
  check("blocked: Review mode (a spoken answer cannot wait for approval)", r.json?.ok === false && r.json.reason === "off" && pubReview?.enabled === false, { r: r.json, pubReview });
  await setSettings({ ai: { mode: "first" } });
  await setFlag("voice_default_limits", { ...LIMITS, minutes: 0 });
  r = await start(chat2, v2.h);
  const pubEmpty = (await sqlJson<Row>(`select outreach_webchat_public_config(${lit(TOKEN)}, ${lit(ORIGIN)})`))?.settings?.voice;
  check("blocked: the month's minutes are used up (and the mic hides on the next config)", r.json?.ok === false && r.json.reason === "minutes" && pubEmpty?.enabled === false, { r: r.json, pubEmpty });
  await setFlag("voice_default_limits", { ...LIMITS, concurrency: 1 });
  r = await start(chat2, v2.h);
  check("blocked: every voice line of the workspace is in use", r.json?.ok === false && r.json.reason === "busy", r.json);
  await setFlag("voice_default_limits", LIMITS);
  await sql(`select outreach_webchat_v_handoff(${lit(chat2)}, 'e2e')`);
  r = await start(chat2, v2.h);
  check("blocked: a conversation a teammate holds", r.json?.ok === false && r.json.reason === "handed_off", r.json);
  const starts = [await start(chat1, v1.h), await start(chat1, v1.h), await start(chat1, v1.h)];
  check("blocked: a fourth call within the hour (three are allowed)", starts[0].json?.ok === true && starts[1].json?.ok === true && starts[2].json?.ok === false && starts[2].json.reason === "rate", starts.map((x) => x.json?.reason ?? "ok"));
  k1 = await callRow(s1.call_id);
  check("start again: the call that was still open on this conversation is closed", k1.status === "failed" && k1.ended_reason === "error", { status: k1.status, reason: k1.ended_reason });

  // ================================================================ C. the tools
  const vA = await visitor(), chatA = await conversation(vA.h);
  const sA = (await start(chatA, vA.h)).json;
  const vars = sA.dynamic_variables;
  let t = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "shipping to Dubai" }, vars);
  check("tool search_knowledge: answers from this website's knowledge, never another workspace's", t.status === 200 && t.json.found >= 1 && /5 to 7 working days/.test(JSON.stringify(t.json.passages)) && !/OTHER-WORKSPACE-SECRET/.test(JSON.stringify(t.json))
    && JSON.stringify(t.json.passages).length <= 1900, t.json);
  t = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "gift wrapping" }, vars);
  check("tool search_knowledge: the team's Q&A is searched too", t.json?.found >= 1 && /gift wrapping is free/.test(JSON.stringify(t.json.passages)), t.json);
  const e1 = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "zzqx warranty of the moon rover" }, vars);
  const e2 = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "zzqx second moon rover" }, vars);
  const kA = await callRow(sA.call_id);
  check("tool search_knowledge: two empty searches in a row tell the agent to offer the team; the question is kept as unanswered", e1.json?.found === 0 && !/pass them to the team/.test(e1.json.note) && /pass them to the team/.test(e2.json?.note ?? "") && kA.empty_searches === 2
    && Number(await sql(`select count(*) from outreach_ai_unanswered_questions where workspace_id = ${lit(WS)} and canonical like '%zzqx%'`)) >= 1, { e1: e1.json, e2: e2.json });
  t = await fake.callTool(live.el_agent_id, "find_products", { query: Deno.env.get("OUTREACH_E2E_PRODUCT") ?? "anklet", max_price: 100000 }, vars);
  const cards = await sqlJson<Row>(`select to_jsonb(m) from outreach_messages m where chat_id = ${lit(chatA)} and content_type = 'cards' order by sent_at desc limit 1`);
  check("tool find_products: at most six names to speak, and the same cards posted into the conversation", t.status === 200 && t.json.found >= 1 && t.json.found <= 6 && /^P1 /.test(t.json.products) && t.json.products.split("; ").length === t.json.found
    && cards?.sender_type === "bot" && cards.content_attributes.products.length === t.json.found && cards.content_attributes.voice.call_id === sA.call_id && cards.content_attributes.products.every((p: Row) => p.price == null || p.price <= 100000), t.json);
  t = await fake.callTool(live.el_agent_id, "save_contact", { name: "Asha Rao", phone: "+971 50 123 4567" }, vars);
  check("tool save_contact: the name and phone the visitor said are on the visitor", t.json?.result?.includes("name and phone") && (await sql(`select name || '|' || phone from outreach_webchat_visitors where id = ${lit(vA.id)}`)) === "Asha Rao|+971501234567", t.json);
  t = await fake.callTool(live.el_agent_id, "save_contact", { name: "Someone Else" }, vars);
  check("tool save_contact: a name the visitor already has is never overwritten", (await sql(`select name from outreach_webchat_visitors where id = ${lit(vA.id)}`)) === "Asha Rao", t.json);
  await fake.callTool(live.el_agent_id, "show_email_form", { reason: "to send the quote" }, vars);
  await fake.callTool(live.el_agent_id, "show_email_form", {}, vars);
  check("tool show_email_form: the email form is posted once", (await sql(`select count(*) from outreach_messages where chat_id = ${lit(chatA)} and content_type = 'form' and content_attributes->>'form' = 'email'`)) === "1");
  t = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "shipping" }, vars, { secret: "Bearer " + "0".repeat(64) });
  check("tools: a wrong secret is 401", t.status === 401, t);
  t = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "shipping" }, vars, { session: vars.secret__session.replace(/.$/, (c: string) => (c === "a" ? "b" : "a")) });
  const forged = btoa(JSON.stringify({ c: s1.call_id, i: IB, x: 9999999999 })).replace(/=+$/, "") + "." + vars.secret__session.split(".")[1];
  const t2 = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "shipping" }, vars, { session: forged });
  check("tools: a changed session token is 401 (the signature breaks)", t.status === 401 && t2.status === 401, { t: t.status, t2: t2.status });
  t = await fake.callTool(test.el_agent_id, "search_knowledge", { query: "shipping" }, vars);
  check("tools: another agent's secret does not open this call", t.status === 401, t.status);
  let n429 = 0, last = 0;
  for (let i = 0; i < 30 && !n429; i++) { const x = await fake.callTool(live.el_agent_id, "save_contact", { name: "Asha Rao" }, vars); last = x.status; if (x.status === 429) n429 = (await callRow(sA.call_id)).tool_calls; }
  check("tools: more than 30 calls in one call is 429", n429 === 30 && last === 429, { n429, last });

  // ================================================================ D. live transcript, handover
  const vB = await visitor(), chatB = await conversation(vB.h);
  const sB = (await start(chatB, vB.h)).json;
  const turns = (call: string, chat: string, h: Record<string, string>, list: Row[]) => http("POST", `/outreach-webchat/conversations/${chat}/voice/turns?token=${TOKEN}`, { call_id: call, turns: list }, h);
  const now = () => new Date().toISOString();
  r = await turns(sB.call_id, chatB, vB.h, [{ role: "agent", text: "Hi! What can I help you with today?", event_id: "a1", at: now() }, { role: "user", text: "do you ship to dubai", event_id: "u2", at: now() }, { role: "agent", text: "Yes, we ship to the UAE in five to seven days.", event_id: "a3", at: now() }]);
  await turns(sB.call_id, chatB, vB.h, [{ role: "user", text: "do you ship to dubai", event_id: "u2", at: now() }, { role: "agent", text: "Yes, we ship to the UAE in five to seven days.", event_id: "a3", at: now() }]);
  const liveRows = await sqlJson<Row[]>(`select coalesce(jsonb_agg(jsonb_build_object('d', direction, 's', sender_type, 'src', source, 'v', content_attributes->'voice') order by sent_at), '[]'::jsonb) from outreach_messages where chat_id = ${lit(chatB)} and content_type = 'text' and content_attributes ? 'voice'`);
  check("live transcript: the turns are messages of the conversation, marked live; a retry does not double them", r.json?.ok === true && r.json.handoff === false && liveRows.length === 3 && liveRows.every((x) => x.v.live === true && x.v.call_id === sB.call_id && x.src === "voice")
    && liveRows[1].d === "in" && liveRows[1].s === "visitor" && liveRows[2].s === "bot" && (await callRow(sB.call_id)).status === "in_progress", liveRows);
  check("live transcript: a spoken answer is a turn of the assistant (Activity, max turns)", (await sql(`select count(*) || '|' || max(query) from outreach_webchat_ai_turns where voice_call_id = ${lit(sB.call_id)} and query = 'do you ship to dubai'`)) === "1|do you ship to dubai");
  r = await turns(sB.call_id, chatB, vB.h, [{ role: "user", text: "actually I want a refund for my order", event_id: "u4", at: now() }]);
  check("handover: a handoff keyword in a spoken turn asks the widget to hand over", r.json?.handoff === true && r.json.reason === "keyword", r.json);
  r = await http("POST", `/outreach-webchat/conversations/${chatB}/voice/switch?token=${TOKEN}`, { call_id: sB.call_id, handoff: true, reason: "refund" }, vB.h);
  const kB = await callRow(sB.call_id);
  const cB = await sqlJson<Row>(`select jsonb_build_object('handed', handed_off_at is not null, 'reason', handoff_reason, 'card', (select content_attributes from outreach_messages where id = ${lit(kB.card_message_id)}),
    'msg', (select count(*) from outreach_messages m where m.chat_id = c.id and m.content_attributes->>'handoff' = 'true')) from outreach_chats c where id = ${lit(chatB)}`);
  check("handover: switch with handoff runs the existing handoff (message, assignment) and ends the call", r.json?.ok === true && kB.status === "ended_unconfirmed" && kB.ended_reason === "handoff" && kB.handoff_reason === "refund" && cB.handed === true
    && cB.reason === "voice_refund" && cB.msg === 1 && cB.card.status === "ended" && r.json.conversation.handed_off_at, { r: r.json, cB });
  r = await start(chatB, vB.h);
  check("handover: no new call while a teammate holds the conversation", r.json?.ok === false && r.json.reason === "handed_off", r.json);
  t = await fake.callTool(live.el_agent_id, "search_knowledge", { query: "shipping" }, sB.dynamic_variables);
  check("tools: nothing answers after the call has ended", t.status === 401, t.status);

  const vC = await visitor(), chatC = await conversation(vC.h);
  const sC = (await start(chatC, vC.h)).json;
  await turns(sC.call_id, chatC, vC.h, [{ role: "user", text: "hello there", event_id: "u1", at: now() }]);
  await sql(`insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, sender_type, sender_name, source, origin) values (${lit(WS)}, ${lit(chatC)}, 'out', 'Hi, Naman here. I can help.', now(), 'text', 'agent', 'Naman', 'agent', 'inbox_user')`);
  r = await turns(sC.call_id, chatC, vC.h, [{ role: "user", text: "ok", event_id: "u2", at: now() }]);
  check("takeover: a teammate's reply during the call tells the widget to switch to chat", r.json?.takeover === true, r.json);
  r = await http("POST", `/outreach-webchat/conversations/${chatC}/voice/switch?token=${TOKEN}`, { call_id: sC.call_id, handoff: false, reason: "takeover" }, vC.h);
  check("takeover: the call ends as a takeover", (await callRow(sC.call_id)).ended_reason === "takeover", r.json);
  r = await http("POST", `/outreach-webchat/conversations/${chatB}/voice/turns?token=${TOKEN}`, { call_id: sC.call_id, turns: [] }, vB.h);
  check("ownership: another visitor cannot write into a call", r.status >= 400, r.status);

  // ================================================================ E. after the call
  await http("POST", `/outreach-webchat/conversations/${chatA}/voice/turns?token=${TOKEN}`, { call_id: sA.call_id, turns: [{ role: "agent", text: "Hi!", event_id: "a1", at: now() }, { role: "user", text: "do you ship to dubai", event_id: "u2", at: now() }] }, vA.h);
  r = await http("POST", `/outreach-webchat/conversations/${chatA}/voice/end?token=${TOKEN}`, { call_id: sA.call_id, reason: "visitor" }, vA.h);
  await sql(`update outreach_webchat_visitors set phone = null where id = ${lit(vA.id)}`);
  const hook = fake.finish(sA.el_conversation_id, { duration: 192, summary: "Asked about shipping to Dubai and polki chokers under 1 lakh; left a phone number.", title: "Shipping to Dubai", collected: { visitor_name: "Someone Else", visitor_phone: "+971501234567", need: "A polki choker shipped to Dubai", budget: "None" },
    transcript: [{ role: "agent", message: "Hi! What can I help you with today?", time_in_call_secs: 0 }, { role: "user", message: "Do you ship to Dubai?", time_in_call_secs: 4 }, { role: "agent", time_in_call_secs: 6 },
      { role: "agent", message: "Yes, we ship to the UAE in five to seven working days.", time_in_call_secs: 8 }, { role: "user", message: "(handing over to the team)", time_in_call_secs: 11 }, { role: "user", message: "Great, thanks.", time_in_call_secs: 12 }] });
  const raw = JSON.stringify(hook);
  const post = async (body: string, sig: string | null) => { const res = await fetch(`${BASE}/outreach-elevenlabs-webhook`, { method: "POST", headers: { "content-type": "application/json", ...(sig ? { "elevenlabs-signature": sig } : {}) }, body }); return { status: res.status, json: await res.json().catch(() => null) }; };
  let w = await post(raw, await fake.sign(raw, "not-the-secret"));
  const w0 = await post(raw, null), wOld = await post(raw, await fake.sign(raw, WH_SECRET, Math.floor(Date.now() / 1000) - 3600));
  check("webhook: a bad signature, no signature and a stale one are 401, and nothing is stored", w.status === 401 && w0.status === 401 && wOld.status === 401 && (await callRow(sA.call_id)).finalized_at === null, { w: w.status, w0: w0.status, wOld: wOld.status });
  w = await post(raw, await fake.sign(raw, WH_SECRET));
  const fin = await callRow(sA.call_id);
  const rows = await sqlJson<Row[]>(`select coalesce(jsonb_agg(jsonb_build_object('d', direction, 't', text, 'v', content_attributes->'voice', 'at', sent_at) order by sent_at), '[]'::jsonb) from outreach_messages where chat_id = ${lit(chatA)} and content_type = 'text' and content_attributes ? 'voice'`);
  check("webhook: the signed transcript replaces the live copy (spoken turns only, in order, timed from the call's start)", w.status === 200 && rows.length === 4 && rows.every((x) => x.v.live === false) && rows[1].t === "Do you ship to Dubai?" && rows[1].d === "in"
    && rows[3].t === "Great, thanks." && !rows.some((x) => /handing over/.test(x.t)) && Math.abs((new Date(rows[1].at).getTime() - new Date(fin.started_at).getTime()) / 1000 - 4) < 1, rows);
  check("webhook: duration, cost, summary, title and outcome are on the call", fin.status === "done" && fin.duration_s === 192 && Number(fin.cost_usd) === 0.0875 && fin.cost_credits === 420 && /shipping to Dubai/.test(fin.summary) && fin.title === "Shipping to Dubai"
    && fin.successful === "success" && fin.has_audio === true && fin.ended_reason === "visitor" && fin.agent_turns === 2, fin);
  const vAfter = await sqlJson<Row>(`select to_jsonb(v) from outreach_webchat_visitors v where id = ${lit(vA.id)}`);
  check("webhook: collected details go onto the visitor and never over what is already there; an empty value is not stored", vAfter.phone === "+971501234567" && vAfter.name === "Asha Rao" && vAfter.custom_attributes.voice_need === "A polki choker shipped to Dubai" && !("voice_budget" in vAfter.custom_attributes), vAfter);
  const cardA = await sqlJson<Row>(`select content_attributes from outreach_messages where id = ${lit(fin.card_message_id)}`);
  check("webhook: the call's card carries the summary, the length and the recording flag; cards and the form stay in the thread", cardA.confirmed === true && cardA.duration_s === 192 && cardA.has_audio === true && /Dubai/.test(cardA.summary)
    && (await sql(`select count(*) from outreach_messages where chat_id = ${lit(chatA)} and content_type in ('cards', 'form')`)) === "2", cardA);
  const counts = await sql(`select count(*) from outreach_messages where chat_id = ${lit(chatA)}`);
  w = await post(raw, await fake.sign(raw, WH_SECRET));
  check("webhook: a second delivery changes nothing", w.status === 200 && w.json?.duplicate === true && (await sql(`select count(*) from outreach_messages where chat_id = ${lit(chatA)}`)) === counts, w.json);
  const unknown = JSON.stringify({ type: "post_call_transcription", event_timestamp: 1, data: { conversation_id: "conv_nobody_knows", transcript: [] } });
  w = await post(unknown, await fake.sign(unknown, WH_SECRET));
  check("webhook: an unknown conversation is dropped with 200", w.status === 200 && w.json?.ignored === "unknown conversation", w);

  // the webhook never arrives: the worker fetches the conversation ten minutes after the call ended
  fake.finish(sB.el_conversation_id, { duration: 61, summary: "Wanted a refund; handed to the team.", successful: "failure", transcript: [{ role: "user", message: "I want a refund", time_in_call_secs: 2 }, { role: "agent", message: "I'm passing you to the team.", time_in_call_secs: 4 }] });
  await sql(`update outreach_webchat_voice_calls set next_poll_at = now() - interval '1 minute' where id = ${lit(sB.call_id)}`);
  r = await worker(false);
  const pB = await callRow(sB.call_id);
  check("missed webhook: the worker fetches the conversation and runs the same steps", r.json?.finalized >= 1 && pB.status === "done" && pB.duration_s === 61 && pB.successful === "failure" && pB.ended_reason === "handoff"
    && (await sql(`select count(*) from outreach_messages where chat_id = ${lit(chatB)} and content_type = 'text' and content_attributes#>>'{voice,live}' = 'false'`)) === "2", { worker: r.json, status: pB.status });
  const pool = await sqlJson<Row>(`select outreach__voice_pool(${lit(WS)})`);
  check("minutes: whole minutes per call, rounded up (192 s = 4, 61 s = 2)", pool.used >= 6 && pool.limit === 100 && pool.ok === true && pool.own_key === false, pool);

  // ================================================================ F. the app: test calls, recording, voices, own key
  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/test-session`, { page_url: "https://aurum.shop/products/polki-choker", page_title: "Polki choker", visitor_name: "Tester", language: "hi" }, JWT);
  const ts = r.json;
  const kT = ts?.call_id ? await callRow(ts.call_id) : null;
  check("test panel: a call with the test agent, no conversation in the inbox", r.status === 200 && kT?.test === true && kT.chat_id === null && kT.el_agent_id === test.el_agent_id && ts.language === "hi" && ts.max_minutes === 3 && ts.dynamic_variables.visitor_name === "Tester", ts);
  t = await fake.callTool(test.el_agent_id, "find_products", { query: Deno.env.get("OUTREACH_E2E_PRODUCT") ?? "anklet" }, ts.dynamic_variables);
  check("test panel: the tools answer and post nothing (the cards come back in the result for the log)", t.status === 200 && t.json.found >= 1 && Array.isArray(t.json.cards) && typeof t.json.ms === "number", t.json);
  await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/test-end`, { call_id: ts.call_id }, JWT);
  const hookT = JSON.stringify(fake.finish(ts.el_conversation_id, { duration: 30, transcript: [{ role: "user", message: "test" }, { role: "agent", message: "ok" }] }));
  await post(hookT, await fake.sign(hookT, WH_SECRET));
  const poolT = await sqlJson<Row>(`select outreach__voice_pool(${lit(WS)})`);
  check("test panel: a test call counts toward the minutes, labelled as a test", (await callRow(ts.call_id)).status === "done" && poolT.test_used === 1 && poolT.used === pool.used + 1, poolT);

  let au = await http("GET", `/outreach-voice-admin/voice-calls/${sA.call_id}/audio`, undefined, JWT);
  const bytes = au.status === 200 ? new Uint8Array(await au.res.arrayBuffer()) : new Uint8Array();
  check("recording: streamed through our proxy to a member of the workspace", au.status === 200 && (au.res.headers.get("content-type") ?? "").startsWith("audio/") && bytes.length === 10 && bytes[0] === 73, au.status);
  au = await http("GET", `/outreach-voice-admin/voice-calls/${sA.call_id}/audio`);
  check("recording: not without a session", au.status === 401, au.status);
  fake.state.conversations.get(sA.el_conversation_id)!.audio_gone = true;
  au = await http("GET", `/outreach-voice-admin/voice-calls/${sA.call_id}/audio`, undefined, JWT);
  check("recording: gone at the provider reads as expired", au.status === 404 && au.json?.code === "E_RECORDING_EXPIRED", au.json);

  r = await http("GET", `/outreach-voice-admin/voices?workspace_id=${WS}&tab=recommended`, undefined, JWT);
  const lib = await http("GET", `/outreach-voice-admin/voices/library?workspace_id=${WS}&language=hi`, undefined, JWT);
  check("voices: ready-made voices with a preview; never one with live moderation; the library filtered the same way", r.status === 200 && r.json.voices.some((v: Row) => v.name === "Sarah" && v.preview_url) && !r.json.voices.some((v: Row) => /Moderated|clone/i.test(v.name))
    && lib.json?.voices?.length === 1 && lib.json.voices[0].name === "Asha" && lib.json.voices[0].public_owner_id, { rec: r.json?.voices?.map((v: Row) => v.name), lib: lib.json?.voices?.map((v: Row) => v.name) });
  r = await http("POST", `/outreach-voice-admin/voices/add`, { workspace_id: WS, public_user_id: "owner0000000000000001", voice_id: "LibraryVoice00000001", name: "Asha" }, JWT);
  check("voices: a library voice is added to the account before an agent uses it", r.status === 200 && /^Added/.test(r.json?.voice_id ?? ""), r.json);

  const stateRpc = await fetch(`${SUPABASE_URL}/rest/v1/rpc/outreach_hub_voice_state`, { method: "POST", headers: { apikey: ANON, ...JWT, "content-type": "application/json" }, body: JSON.stringify({ p_inbox: IB }) }).then((x) => x.json());
  check("app: the Voice tab's state (agents, draft, minutes, what voice needs) without any provider id", stateRpc?.agents?.live?.exists === true && stateRpc.agents.test.exists === true && stateRpc.draft?.speed === 1.1 && stateRpc.pool?.limit === 100
    && stateRpc.requires?.assistant_auto === true && stateRpc.requires.knowledge === true && !/agent_[0-9a-f]|sec_|tool_/.test(JSON.stringify(stateRpc)), stateRpc);
  const direct = await fetch(`${SUPABASE_URL}/rest/v1/outreach_webchat_voice_agents?select=el_agent_id,tool_secret_hash`, { headers: { apikey: ANON, ...JWT } });
  check("app: the agents table gives a browser no provider id and no secret hash", direct.status >= 400, direct.status);
  await direct.body?.cancel();

  // own key: refused when wrong; when right, the agents move to that account and the old ones are deleted
  r = await http("POST", `/outreach-workspace-secrets`, { workspace_id: WS, elevenlabs: { key: "bad-key-0000" } }, JWT);
  check("own key: a key the provider rejects is not saved", r.status === 400 && r.json?.code === "E_VOICE_KEY_INVALID", r.json);
  r = await http("POST", `/outreach-workspace-secrets`, { workspace_id: WS, elevenlabs: { key: "own-key-0123456789" } }, JWT);
  const sec = await sqlJson<Row>(`select jsonb_build_object('hint', elevenlabs_key_hint, 'enc', elevenlabs_key_enc is not null and elevenlabs_key_enc not like '%own-key%', 'wh', elevenlabs_webhook_id, 'whs', elevenlabs_webhook_secret_enc is not null) from outreach_workspace_secrets where workspace_id = ${lit(WS)}`);
  check("own key: saved encrypted, only the last four characters shown, our webhook created in that account", r.status === 200 && r.json.settings.elevenlabs_key_hint === "6789" && sec.hint === "6789" && sec.enc === true && !!sec.wh && sec.whs === true && !JSON.stringify(r.json).includes("own-key"), { r: r.json, sec });
  const oldLive = live.el_agent_id;
  await worker();
  live = await agentRow("live");
  const moved = fake.state.agents.get(live.el_agent_id);
  check("own key: the live agent is created again in the workspace's account, with our webhook bound to it; no minute cap", live.account === "own" && live.el_agent_id !== oldLive && fake.state.calls.some((c) => c.method === "POST" && c.path === "/v1/convai/agents/create" && c.key === "own-key-0123456789")
    && moved?.platform_settings?.workspace_overrides?.webhooks?.post_call_webhook_id === sec.wh && (await sqlJson<Row>(`select outreach__voice_pool(${lit(WS)})`)).limit === null, { account: live.account, pool: await sqlJson(`select outreach__voice_pool(${lit(WS)})`) });
  await sql(`update outreach_webchat_voice_cleanup set next_at = now() - interval '1 second' where done_at is null`);
  await worker(false);
  check("own key: the agent, tools and secret left behind in the platform account are deleted there", !fake.state.agents.has(oldLive) && (await sql(`select count(*) from outreach_webchat_voice_cleanup where done_at is null`)) === "0", await sql(`select string_agg(kind || ':' || coalesce(last_error, 'ok'), ', ') from outreach_webchat_voice_cleanup`));
  const vO = await visitor(), chatO = await conversation(vO.h), sO = (await start(chatO, vO.h)).json;
  await http("POST", `/outreach-webchat/conversations/${chatO}/voice/end?token=${TOKEN}`, { call_id: sO.call_id }, vO.h);
  const hookO = JSON.stringify(fake.finish(sO.el_conversation_id, { duration: 20, transcript: [{ role: "user", message: "hi" }, { role: "agent", message: "hello" }] }));
  const ownSecret = fake.state.webhooks.get(sec.wh)?.secret;
  const wBad = await post(hookO, await fake.sign(hookO, "wsec_of_some_other_account")), wOwn = await post(hookO, await fake.sign(hookO, ownSecret));
  check("own key: that account's webhook is verified with the secret of the webhook we created there", sO?.ok === true && wBad.status === 401 && wOwn.status === 200 && (await callRow(sO.call_id)).account === "own" && (await callRow(sO.call_id)).status === "done", { wBad: wBad.status, wOwn: wOwn.status });
  r = await http("POST", `/outreach-workspace-secrets`, { workspace_id: WS, elevenlabs: null }, JWT);
  await worker();
  live = await agentRow("live");
  check("own key: removing it brings voice back to the platform account", r.status === 200 && r.json.settings.elevenlabs_key_hint === null && live.account === "platform" && !!fake.state.agents.get(live.el_agent_id), live?.account);

  // scripted checks
  r = await http("POST", `/outreach-voice-admin/inboxes/${IB}/voice/run-checks`, {}, JWT);
  const run = r.json;
  let res = await http("GET", `/outreach-voice-admin/inboxes/${IB}/voice/run-checks?run=${run?.run_id}&call=${run?.call_id}&tests=${(run?.tests ?? []).map((x: Row) => x.id).join(",")}`, undefined, JWT);
  const pending = res.json?.finished === false;
  res = await http("GET", `/outreach-voice-admin/inboxes/${IB}/voice/run-checks?run=${run?.run_id}&call=${run?.call_id}&tests=${(run?.tests ?? []).map((x: Row) => x.id).join(",")}`, undefined, JWT);
  check("run checks: scenarios built from the website, pass / fail with the agent's replies, nothing left behind", r.status === 200 && run.tests.length >= 4 && run.tests.some((x: Row) => x.key === "budget") && pending && res.json?.finished === true
    && res.json.results.filter((x: Row) => x.status === "passed").length === run.tests.length - 1 && res.json.results[1].why === "The agent did not hand over." && res.json.results[0].replies.length === 1
    && [...fake.state.tests.values()].filter((x) => x.type === "simulation").length === 0 && (await callRow(run.call_id)).status === "failed" && (await callRow(run.call_id)).duration_s === 0, { run, res: res.json });

  // ================================================================ G. off, deleted, erased
  await setSettings({ voice: { enabled: false } });
  await worker();
  const off = await agentRow("live");
  check("voice off: the live agent is archived and no token is minted", off.archived === true && fake.state.agents.get(off.el_agent_id)?.platform_settings?.archived === true && (await start(chatC, vC.h)).json?.reason === "off"
    && (await http("GET", `/outreach-webchat/config?token=${TOKEN}&x=1`, undefined, { origin: ORIGIN })).json?.settings?.voice?.enabled === false, off?.archived);
  await setSettings({ voice: { enabled: true } });
  await worker();
  check("voice on again: the same agent is un-archived", (await agentRow("live")).archived === false && (await agentRow("live")).el_agent_id === off.el_agent_id && fake.state.agents.get(off.el_agent_id)?.platform_settings?.archived === false);

  const convA = sA.el_conversation_id;
  await sql(`delete from outreach_chats where id = ${lit(chatA)}`);
  await sql(`update outreach_webchat_voice_cleanup set next_at = now() - interval '1 second' where done_at is null`);
  await worker(false);
  check("erasure: deleting a conversation removes its calls here and at the provider", (await sql(`select count(*) from outreach_webchat_voice_calls where id = ${lit(sA.call_id)}`)) === "0" && !fake.state.conversations.has(convA), fake.state.conversations.has(convA));

  const ids = [(await agentRow("live")).el_agent_id, (await agentRow("test")).el_agent_id];
  await sql(`update outreach_webchat_inboxes set deleted_at = now(), is_active = false where id = ${lit(IB)}`);
  await sql(`update outreach_webchat_voice_cleanup set next_at = now() - interval '1 second' where done_at is null`);
  await worker(false);
  await sql(`update outreach_webchat_voice_cleanup set next_at = now() - interval '1 second' where done_at is null`);
  await worker(false);
  check("website deleted: both agents, their tools and secrets are deleted at the provider", (await sql(`select count(*) from outreach_webchat_voice_agents where inbox_id = ${lit(IB)}`)) === "0" && !ids.some((a) => fake.state.agents.has(a))
    && fake.state.tools.size === 0 && fake.state.secrets.size === 0, { agents: fake.state.agents.size, tools: fake.state.tools.size, secrets: fake.state.secrets.size, queue: await sql(`select string_agg(kind || ':' || coalesce(last_error, 'ok') || ':' || (done_at is not null), ', ') from outreach_webchat_voice_cleanup`) });
} catch (e) {
  failed++;
  console.log(`FAIL the run stopped: ${(e as Error)?.stack ?? e}`);
} finally {
  try { await cleanup(); } catch (e) { console.log(`cleanup failed: ${e}`); }
}
console.log(`\n${passed} passed, ${failed} failed`);
await stop(failed ? 1 : 0);
