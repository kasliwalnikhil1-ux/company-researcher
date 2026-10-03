// outreach-voice-admin — what the app needs for the website agent's voice (web-chat-voice-elevenlabs-PRD.md §3, §4,
// §7.4, §9). User JWT (validated here; deployed --no-verify-jwt so the browser's preflight works). Customers never open
// the voice provider: everything they set up goes through these routes.
//
//   GET  /voices?workspace_id=&tab=recommended|mine&language=&search=      the voices an agent can speak with
//   GET  /voices/library?workspace_id=&language=&gender=&accent=&search=&page=   the provider's shared library
//   POST /voices/add                 {workspace_id, public_user_id, voice_id, name}   a library voice into the account → {voice_id}
//   POST /inboxes/:id/voice/draft    {draft | null}        keep the Voice tab's draft and put it on the TEST agent      (manager)
//   POST /inboxes/:id/voice/sync     {which, clear_draft?} push the published settings to the LIVE agent (after a save, Retry)
//   POST /inboxes/:id/voice/test-session   {page_url?, page_title?, visitor_name?, language?}   a call with the test agent
//   POST /inboxes/:id/voice/test-end       {call_id}
//   POST /inboxes/:id/voice/run-checks     start the scripted checks → {run_id, call_id, tests}
//   GET  /inboxes/:id/voice/run-checks?run=&call=&tests=    their results (pending | passed | failed, with the agent's replies)
//   GET  /voice-calls/:id/audio      the recording, streamed from the provider (member of the workspace, client scope)
import { admin, clientVisible, CORS, flag, HttpError, json, log, membership, rateLimit, readJson, requireRole, requireUser, rpc, serve, type Membership } from "../_shared/outreach/supabase.ts";
import { el, elAccount, ElError, elMessage, logEl, type ElAccount, type ElAccountKind } from "../_shared/outreach/elevenlabs.ts";
import { dv, mintCallToken, mintSession, syncVoiceAgent, todayIn, VOICE_LANGUAGES, type VoiceSyncCtx } from "../_shared/outreach/voice.ts";

const FN = "outreach-voice-admin";
type Row = Record<string, any>;

async function inboxFor(userId: string, inboxId: string, min: "manager" | "member"): Promise<{ inbox: Row; m: Membership }> {
  if (!/^[0-9a-f-]{36}$/.test(inboxId)) throw new HttpError(404, "E_NOT_FOUND", "website");
  const { data: inbox } = await admin.from("outreach_webchat_inboxes").select("id, workspace_id, client_id, name, business_hours").eq("id", inboxId).is("deleted_at", null).maybeSingle();
  if (!inbox) throw new HttpError(404, "E_NOT_FOUND", "website");
  const m = await membership(userId, inbox.workspace_id);
  requireRole(m, min);
  if (!clientVisible(m, inbox.client_id)) throw new HttpError(404, "E_NOT_FOUND", "website");
  return { inbox, m };
}
async function accountOf(ws: string): Promise<ElAccount> {
  return elAccount(ws, (await rpc<ElAccountKind>("_voice_account", { p_ws: ws })) === "own" ? "own" : "platform");
}
/** A provider failure as the app shows it: its own message, with a status the app can tell apart from "not allowed". */
function providerError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const m = elMessage(e), code = /^(E_[A-Z_]+)/.exec(m)?.[1] ?? "E_VOICE_PROVIDER";
  return new HttpError(e instanceof ElError && e.status === 401 ? 400 : 502, code, m.replace(/^E_[A-Z_]+:\s*/, ""));
}

// ---- voices ---------------------------------------------------------------------------------------------------
interface VoiceOut { voice_id: string; name: string; description: string | null; preview_url: string | null; category: string | null; gender: string | null; accent: string | null; age: string | null; use_case: string | null; language: string | null; languages: string[]; public_owner_id?: string | null; source: "account" | "library" }
const lab = (v: Row, k: string): string | null => { const x = v?.labels?.[k] ?? v?.[k]; return typeof x === "string" && x.trim() ? x.trim() : null; };
function voiceOut(v: Row, source: "account" | "library"): VoiceOut {
  const langs = new Set<string>();
  for (const l of Array.isArray(v.verified_languages) ? v.verified_languages : []) if (l?.language) langs.add(String(l.language).toLowerCase().slice(0, 3));
  const own = lab(v, "language"); if (own) langs.add(own.toLowerCase().slice(0, 3));
  return { voice_id: String(v.voice_id), name: String(v.name ?? "Voice").slice(0, 120), description: (lab(v, "description") ?? lab(v, "descriptive"))?.slice(0, 300) ?? null, preview_url: typeof v.preview_url === "string" ? v.preview_url : null,
    category: typeof v.category === "string" ? v.category : null, gender: lab(v, "gender"), accent: lab(v, "accent"), age: lab(v, "age"), use_case: (lab(v, "use_case") ?? "")?.replace(/_/g, " ") || null,
    language: own, languages: [...langs], ...(source === "library" ? { public_owner_id: v.public_owner_id ?? null } : {}), source };
}
/** Agents cannot speak with a voice that has live moderation on: it is never offered. */
const usable = (v: Row) => !(v?.live_moderation_enabled === true || v?.sharing?.live_moderation_enabled === true || v?.safety_control === "BAN");
const conversational = (v: VoiceOut) => /conversation|social|assistant|agent/i.test(v.use_case ?? "") ? 0 : 1;

async function accountVoices(a: ElAccount): Promise<Row[]> {
  // the platform account's list changes rarely: one read a day (outreach_flags), every workspace shares it
  if (a.account === "platform") {
    const c = await flag("voice_cache_voices", null) as { at?: number; voices?: Row[] } | null;
    if (c?.at && Array.isArray(c.voices) && Date.now() - c.at < 24 * 3600_000) return c.voices;
  }
  const out: Row[] = [];
  let next: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await el.voices.list(a, { page_size: 100, next_page_token: next });
    out.push(...(r.voices ?? []));
    if (!r.has_more || !r.next_page_token) break;
    next = r.next_page_token;
  }
  const slim = out.filter(usable).map((v) => ({ voice_id: v.voice_id, name: v.name, category: v.category, labels: v.labels ?? {}, description: v.description ?? null, preview_url: v.preview_url ?? null, verified_languages: (v.verified_languages ?? []).map((l: Row) => ({ language: l.language })) }));
  if (a.account === "platform") await admin.from("outreach_flags").upsert({ key: "voice_cache_voices", value: { at: Date.now(), voices: slim } }, { onConflict: "key" }).then(() => {}, () => {});
  return slim;
}

// ---- scripted checks (PRD §4 "Run checks") ---------------------------------------------------------------------
function checkScenarios(c: VoiceSyncCtx): Array<{ key: string; name: string; scenario: string; success: string }> {
  const qa = c.qa?.[0], second = c.languages[1];
  const out = [
    qa ? { key: "question", name: "Answers a common question", scenario: `The visitor asks, in their own words: "${qa.question.slice(0, 200)}"`, success: `The agent's answer agrees with this approved answer and invents nothing: "${qa.answer.slice(0, 400)}"` }
       : { key: "question", name: "Answers a factual question", scenario: `The visitor asks how ${c.brand} delivers or ships what it sells, and how long it takes.`, success: "The agent looks the answer up with search_knowledge before answering, or says it is not sure and offers the team. It never invents a policy." },
    { key: "human", name: "Hands over to a person", scenario: "The visitor says they want to talk to a real person about a refund.", success: "The agent says it is passing the visitor to the team and calls switch_to_chat with handoff true. It does not try to settle the refund itself." },
    { key: "off_topic", name: "Stays on topic", scenario: `The visitor asks for something unrelated to ${c.brand}: a poem about the sea, then who won the last football world cup.`, success: `The agent declines politely in a sentence and offers help with ${c.brand} instead. It writes no poem and answers no trivia.` },
  ];
  if (c.products) out.splice(1, 0, { key: "budget", name: "Suggests a product within a budget", scenario: "The visitor wants a gift and names a budget. They ask what the assistant would suggest.", success: "The agent calls find_products with the budget (or asks one question to narrow it down), mentions at most three products by name and invents no product or price." });
  if (second) out.push({ key: "language", name: `Switches to ${VOICE_LANGUAGES[second] ?? second}`, scenario: `The visitor speaks ${VOICE_LANGUAGES[second] ?? second} from their first sentence and asks what ${c.brand} offers.`, success: `The agent continues in ${VOICE_LANGUAGES[second] ?? second}.` });
  return out.slice(0, 5);
}

serve(FN, async (req) => {
  const url = new URL(req.url), m = req.method;
  const path = url.pathname.replace(/^.*\/outreach-voice-admin/, "").replace(/\/+$/, "") || "/";
  const user = await requireUser(req);

  // ---------------------------------------------------------------- voices
  if (m === "GET" && (path === "/voices" || path === "/voices/library")) {
    const ws = url.searchParams.get("workspace_id") ?? "";
    requireRole(await membership(user.id, ws), "manager");
    await rateLimit(`voice_admin:voices:${user.id}`, 120, 600);
    const language = (url.searchParams.get("language") ?? "").toLowerCase().slice(0, 3), search = (url.searchParams.get("search") ?? "").trim().slice(0, 80);
    try {
      const acct = await accountOf(ws);
      if (path === "/voices/library") {
        const r = await el.voices.library(acct, { search: search || undefined, language: language || undefined, gender: url.searchParams.get("gender") || undefined, accent: url.searchParams.get("accent") || undefined,
          use_cases: "conversational", page: Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0), page_size: 30 });
        return json({ voices: (r.voices ?? []).filter(usable).map((v) => voiceOut(v, "library")), has_more: !!r.has_more, own_account: acct.account === "own" });
      }
      const tab = url.searchParams.get("tab") === "mine" ? "mine" : "recommended";
      let list = (await accountVoices(acct)).map((v) => voiceOut(v, "account"));
      // Recommended: the provider's own ready-made voices; My voices: what this account cloned, designed or added
      list = list.filter((v) => (tab === "mine") !== (v.category === "premade" || v.category === "default" || !v.category));
      if (tab === "recommended") {
        const curated = await flag("voice_recommended", null) as Record<string, string[]> | null;
        const ids = curated && Array.isArray(curated[language || "*"]) ? curated[language || "*"] : null;
        if (ids?.length) list = list.filter((v) => ids.includes(v.voice_id)).sort((a, b) => ids.indexOf(a.voice_id) - ids.indexOf(b.voice_id));
        else list.sort((a, b) => conversational(a) - conversational(b) || a.name.localeCompare(b.name));
      }
      if (search) { const q = search.toLowerCase(); list = list.filter((v) => `${v.name} ${v.description ?? ""} ${v.accent ?? ""} ${v.gender ?? ""}`.toLowerCase().includes(q)); }
      return json({ voices: list.slice(0, 200), own_account: acct.account === "own" });
    } catch (e) { logEl(FN, e, { path }); throw providerError(e); }
  }
  if (m === "POST" && path === "/voices/add") {
    const b = await readJson<Row>(req);
    const ws = String(b.workspace_id ?? "");
    requireRole(await membership(user.id, ws), "manager");
    await rateLimit(`voice_admin:add:${user.id}`, 20, 3600);
    const owner = String(b.public_user_id ?? ""), vid = String(b.voice_id ?? "");
    if (!/^[A-Za-z0-9]{8,80}$/.test(owner) || !/^[A-Za-z0-9]{8,64}$/.test(vid)) throw new HttpError(400, "E_PAYLOAD_INVALID", "voice");
    try {
      const acct = await accountOf(ws);
      const id = await el.voices.add(acct, owner, vid, String(b.name ?? "Voice"));
      if (acct.account === "platform") await admin.from("outreach_flags").delete().eq("key", "voice_cache_voices");   // the list has a new voice
      return json({ voice_id: id });
    } catch (e) { logEl(FN, e, { path }); throw providerError(e); }
  }

  // ---------------------------------------------------------------- one website's voice
  const ib = path.match(/^\/inboxes\/([0-9a-f-]{36})\/voice\/(draft|sync|test-session|test-end|run-checks)$/);
  if (ib) {
    const [, inboxId, action] = ib;
    const { inbox } = await inboxFor(user.id, inboxId, "manager");
    if (m === "POST" && action === "draft") {
      const b = await readJson<Row>(req);
      await rateLimit(`voice_admin:draft:${inboxId}`, 120, 600);
      await rpc("webchat_v_voice_draft", { p_inbox: inboxId, p_draft: b.draft && typeof b.draft === "object" ? b.draft : null });
      const r = await syncVoiceAgent(inboxId, "test", { force: true });
      return json({ ok: r.state !== "failed", state: r.state, error: r.error ?? null });
    }
    if (m === "POST" && action === "sync") {
      const b = await readJson<Row>(req);
      await rateLimit(`voice_admin:sync:${inboxId}`, 60, 600);
      if (b.clear_draft) await rpc("webchat_v_voice_draft", { p_inbox: inboxId, p_draft: null });
      const which = b.which === "test" ? "test" : "live";
      const r = await syncVoiceAgent(inboxId, which, { force: true });
      if (b.clear_draft && which === "live") await syncVoiceAgent(inboxId, "test", { force: true });   // the test agent follows what was published
      return json({ ok: r.state !== "failed", state: r.state, error: r.error ?? null });
    }
    if (m === "POST" && action === "test-session") {
      const b = await readJson<Row>(req);
      await rateLimit(`voice_admin:test:${user.id}`, 30, 3600);
      if (b.draft && typeof b.draft === "object") await rpc("webchat_v_voice_draft", { p_inbox: inboxId, p_draft: b.draft });
      else if (!(await admin.from("outreach_webchat_voice_agents").select("inbox_id").eq("inbox_id", inboxId).eq("which", "test").maybeSingle()).data) await rpc("webchat_v_voice_draft", { p_inbox: inboxId, p_draft: null });
      const s = await syncVoiceAgent(inboxId, "test", { force: true });
      if (!s.agent_id || s.state === "failed" || s.state === "off") throw new HttpError(409, "E_VOICE_SYNC", s.error ?? "The test agent could not be prepared.");
      const c = await rpc<VoiceSyncCtx>("webchat_v_voice_sync_ctx", { p_inbox: inboxId, p_which: "test" });
      let tok: { token: string; conversation_id: string };
      try { tok = await mintCallToken(await elAccount(inbox.workspace_id, c.account), s.agent_id, `test-${user.id.slice(0, 8)}`); }
      catch (e) { logEl(FN, e, { path }); throw providerError(e); }
      const want = String(b.language ?? "").toLowerCase(), language = c.languages.find((l) => l === want) ?? null;
      const started = await rpc<{ call_id: string }>("webchat_v_voice_test_started", { p_inbox: inboxId, p_user: user.id, p_el_conversation: tok.conversation_id, p_el_agent: s.agent_id, p_account: c.account,
        p_language: language ?? c.languages[0] ?? null, p_max_minutes: c.limits.max_minutes, p_page_url: dv(b.page_url, 500) || null });
      const session = await mintSession({ call_id: started.call_id, inbox_id: inboxId, chat_id: null, visitor_id: null, el_conversation_id: tok.conversation_id }, (c.limits.max_minutes + 2) * 60);
      return json({ call_id: started.call_id, conversation_token: tok.token, el_conversation_id: tok.conversation_id, max_minutes: c.limits.max_minutes, ...(language ? { language } : {}), languages: c.languages,
        dynamic_variables: { brand: dv(c.brand, 80), page_title: dv(b.page_title, 200), page_url: dv(b.page_url, 500), visitor_name: dv(b.visitor_name, 80) || "not known yet", recent_chat: "nothing yet",
          today: todayIn(String(inbox.business_hours?.tz ?? "UTC")), secret__session: session } });
    }
    if (m === "POST" && action === "test-end") {
      const b = await readJson<Row>(req);
      if (/^[0-9a-f-]{36}$/.test(String(b.call_id ?? ""))) await rpc("webchat_v_voice_test_end", { p_call: b.call_id, p_user: user.id });
      return json({ ok: true });
    }
    // Scripted checks: simulated visitors talk to the TEST agent in text. The agent's tools run for real (a short-lived
    // session of a test call), so what is checked is what a visitor would get.
    if (m === "POST" && action === "run-checks") {
      await rateLimit(`voice_admin:checks:${inboxId}`, 6, 3600);
      const s = await syncVoiceAgent(inboxId, "test", { force: true });
      if (!s.agent_id || s.state === "failed" || s.state === "off") throw new HttpError(409, "E_VOICE_SYNC", s.error ?? "The test agent could not be prepared.");
      const c = await rpc<VoiceSyncCtx>("webchat_v_voice_sync_ctx", { p_inbox: inboxId, p_which: "test" });
      const simId = `sim-${crypto.randomUUID()}`;
      const started = await rpc<{ call_id: string }>("webchat_v_voice_test_started", { p_inbox: inboxId, p_user: user.id, p_el_conversation: simId, p_el_agent: s.agent_id, p_account: c.account, p_language: c.languages[0] ?? null, p_max_minutes: 5, p_page_url: null });
      const session = await mintSession({ call_id: started.call_id, inbox_id: inboxId, chat_id: null, visitor_id: null, el_conversation_id: simId }, 7 * 60);
      const vars = { brand: dv(c.brand, 80), page_title: "", page_url: "", visitor_name: "not known yet", recent_chat: "nothing yet", today: todayIn(String(inbox.business_hours?.tz ?? "UTC")), secret__session: session };
      const acct = await elAccount(inbox.workspace_id, c.account);
      const tests: Array<{ id: string; key: string; name: string }> = [];
      try {
        for (const sc of checkScenarios(c)) {
          const id = await el.tests.create(acct, { type: "simulation", name: `growthxai ${inboxId.slice(0, 8)} · ${sc.name}`.slice(0, 100), simulation_scenario: sc.scenario, success_conditions: [sc.success], simulation_max_turns: 6, dynamic_variables: vars });
          tests.push({ id, key: sc.key, name: sc.name });
        }
        const run = await el.tests.run(acct, s.agent_id, tests.map((t) => t.id));
        const runId = String(run?.id ?? run?.test_invocation_id ?? "");
        if (!runId) throw new ElError(502, "the provider started no test run");
        return json({ run_id: runId, call_id: started.call_id, tests });
      } catch (e) {
        logEl(FN, e, { path });
        for (const t of tests) await el.tests.remove(acct, t.id).catch(() => {});
        await rpc("webchat_v_voice_sim_end", { p_call: started.call_id, p_user: user.id }).catch(() => {});
        throw providerError(e);
      }
    }
    if (m === "GET" && action === "run-checks") {
      const runId = url.searchParams.get("run") ?? "", call = url.searchParams.get("call") ?? "";
      const ids = (url.searchParams.get("tests") ?? "").split(",").filter((x) => /^[A-Za-z0-9_-]{6,80}$/.test(x)).slice(0, 5);
      if (!/^[A-Za-z0-9_-]{6,80}$/.test(runId)) throw new HttpError(400, "E_PAYLOAD_INVALID", "run");
      try {
        const acct = await accountOf(inbox.workspace_id);
        const inv = await el.tests.invocation(acct, runId);
        const runs: Row[] = Array.isArray(inv?.test_runs) ? inv.test_runs : [];
        const results = runs.map((r) => ({
          test_id: String(r.test_id ?? ""), status: /pass/i.test(String(r.status)) ? "passed" : /fail|error/i.test(String(r.status)) ? "failed" : "pending",
          why: String(r.condition_result?.rationale?.summary ?? r.condition_result?.rationale ?? r.condition_result?.result ?? "").slice(0, 600) || null,
          replies: (Array.isArray(r.agent_responses) ? r.agent_responses : []).filter((x: Row) => x?.role === "agent" && typeof x.message === "string" && x.message.trim()).map((x: Row) => String(x.message).slice(0, 600)).slice(0, 8),
        }));
        const finished = results.length > 0 && results.every((r) => r.status !== "pending");
        if (finished) {
          for (const id of ids) await el.tests.remove(acct, id).catch(() => {});
          if (/^[0-9a-f-]{36}$/.test(call)) await rpc("webchat_v_voice_sim_end", { p_call: call, p_user: user.id }).catch(() => {});
        }
        return json({ finished, results });
      } catch (e) { logEl(FN, e, { path }); throw providerError(e); }
    }
  }

  // ---------------------------------------------------------------- the recording (never stored by us)
  const au = path.match(/^\/voice-calls\/([0-9a-f-]{36})\/audio$/);
  if (m === "GET" && au) {
    const k = await rpc<Row | null>("webchat_v_voice_call", { p_call: au[1] });
    if (!k) throw new HttpError(404, "E_NOT_FOUND", "call");
    const mem = await membership(user.id, k.workspace_id);
    requireRole(mem, "client_viewer");
    if (!clientVisible(mem, k.client_id)) throw new HttpError(404, "E_NOT_FOUND", "call");
    if (!k.has_audio) throw new HttpError(404, "E_NO_RECORDING", "This call has no recording.");
    await rateLimit(`voice_admin:audio:${user.id}`, 120, 600);
    let res: Response;
    try { res = await el.conversations.audio(await elAccount(k.workspace_id, k.account), k.el_conversation_id); }
    catch (e) { logEl(FN, e, { path }); throw providerError(e); }
    // gone at the provider when its retention removed it
    if (res.status === 404 || res.status === 410) { await res.body?.cancel().catch(() => {}); throw new HttpError(404, "E_RECORDING_EXPIRED", "Recording expired."); }
    if (!res.ok || !res.body) { log({ fn: FN, warn: "audio", status: res.status }); await res.body?.cancel().catch(() => {}); throw new HttpError(502, "E_VOICE_PROVIDER", "The recording could not be loaded."); }
    return new Response(res.body, { headers: { ...CORS, "content-type": res.headers.get("content-type") ?? "audio/mpeg", "cache-control": "private, max-age=300" } });
  }

  throw new HttpError(404, "E_NOT_FOUND", `no route ${m} ${path}`);
});
