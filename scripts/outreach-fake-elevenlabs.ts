// A pretend voice provider for local tests of the website assistant's voice (scripts/outreach-voice-e2e.ts).
// It speaks the part of the ElevenLabs Agents API the code uses (the shapes read from their docs on 1 Oct 2026) and
// keeps everything in memory. It is NOT a check of the real API: field names the docs do not state stay unverified
// until a call is made with a real key (docs/outreach/WEBCHAT.md "Voice" lists them).
//
//   startFakeElevenLabs(port)  →  { state, close(), failNext(prefix, status, times), callTool(...), finish(...), sign(...) }
//
// What it does like the real one:
//   - secrets are stored and resolved into tool headers ({secret_id} → the value), dynamic variables too ({variable_name})
//   - a conversation token carries the conversation id it will have
//   - a finished conversation is served by GET /v1/convai/conversations/:id and can be delivered as a signed
//     post_call_transcription webhook (ElevenLabs-Signature: t=<unix>,v0=<hmac sha256 of "t.body">)
type Row = Record<string, any>;

export interface FakeEl {
  state: { secrets: Map<string, Row>; tools: Map<string, Row>; agents: Map<string, Row>; conversations: Map<string, Row>; webhooks: Map<string, Row>; tests: Map<string, Row>; ghosts: Map<string, string[]>; settings: Row; calls: Array<{ method: string; path: string; body: any; key: string }>; added: Row[] };
  close(): Promise<void>;
  /** The next `times` requests whose path starts with `prefix` answer `status`. */
  failNext(prefix: string, status: number, times?: number): void;
  clearFails(): void;
  /** Call one of an agent's webhook tools the way the provider does: its URL, the secret and the dynamic variables in the headers. */
  callTool(agentId: string, tool: string, body: Row, vars: Row, o?: { secret?: string; session?: string }): Promise<{ status: number; json: any }>;
  /** A finished conversation: stored for GET, and returned as the webhook payload. */
  finish(conversationId: string, o: { transcript: Array<{ role: string; message?: string; time_in_call_secs?: number }>; duration?: number; summary?: string; title?: string; successful?: string; collected?: Record<string, string>; has_audio?: boolean; cost?: number; cost_fiat?: number; termination_reason?: string; language?: string }): Row;
  sign(body: string, secret: string, at?: number): Promise<string>;
  count(method: string, prefix: string): number;
}

const id = (p: string) => `${p}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
async function hmac(secret: string, body: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const VOICES = [
  { voice_id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", category: "premade", labels: { gender: "female", accent: "american", use_case: "conversational", description: "warm" }, preview_url: "https://example.test/sarah.mp3", verified_languages: [{ language: "en" }, { language: "hi" }] },
  { voice_id: "cjVigY5qzO86Huf0OWal", name: "Eric", category: "premade", labels: { gender: "male", accent: "american", use_case: "conversational" }, preview_url: "https://example.test/eric.mp3", verified_languages: [{ language: "en" }] },
  { voice_id: "ModeratedVoice0000001", name: "Moderated", category: "premade", labels: {}, sharing: { live_moderation_enabled: true }, preview_url: null },
  { voice_id: "ClonedVoice000000001", name: "My clone", category: "cloned", labels: { gender: "female" }, preview_url: "https://example.test/clone.mp3" },
];

export function startFakeElevenLabs(port: number): FakeEl {
  const state: FakeEl["state"] = { secrets: new Map(), tools: new Map(), agents: new Map(), conversations: new Map(), webhooks: new Map(), tests: new Map(), ghosts: new Map(), settings: {}, calls: [], added: [] };
  const fails: Array<{ prefix: string; status: number; left: number }> = [];
  const j = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  const server = Deno.serve({ port, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const u = new URL(req.url), p = u.pathname, m = req.method;
    const key = req.headers.get("xi-api-key") ?? "";
    let body: any = null;
    if (m !== "GET" && m !== "DELETE") { try { body = await req.json(); } catch { body = null; } }
    state.calls.push({ method: m, path: p, body, key });
    if (!key) return j({ detail: { status: "missing_api_key", message: "API key is missing" } }, 401);
    if (key.startsWith("bad-key")) return j({ detail: { status: "invalid_api_key", message: "Invalid API key" } }, 401);
    const f = fails.find((x) => p.startsWith(x.prefix) && x.left > 0);
    if (f) { f.left--; return j({ detail: { message: `injected ${f.status}` } }, f.status); }

    if (m === "POST" && p === "/v1/convai/secrets") { const sid = id("sec"); state.secrets.set(sid, { name: body?.name, value: body?.value }); return j({ type: "stored", secret_id: sid, name: body?.name }); }
    let x = p.match(/^\/v1\/convai\/secrets\/([^/]+)$/);
    if (m === "DELETE" && x) {
      // like the real one: a secret a tool still names cannot go
      if (state.secrets.has(x[1]) && [...state.tools.values()].some((t) => JSON.stringify(t).includes(x![1]))) return j({ detail: { message: "This secret cannot be deleted because it is still referenced by one or more agents, tools, MCP servers, phone numbers, or settings. Remove all references first." } }, 400);
      return state.secrets.delete(x[1]) ? j({}) : j({ detail: "not found" }, 404);
    }

    if (m === "POST" && p === "/v1/convai/tools") {
      if (!body?.tool_config?.name || !body.tool_config.type) return j({ detail: [{ loc: ["body", "tool_config"], msg: "field required" }] }, 422);
      const tid = id("tool"); state.tools.set(tid, structuredClone(body.tool_config)); return j({ id: tid, tool_config: body.tool_config });
    }
    // like the real one: a deleted agent's branch keeps naming its tools ("Unknown / Main"), so a plain delete is refused
    // until it is forced; the dependents list shows those branches and no live agent
    const users = (tid: string) => [...state.agents.entries()].filter(([, a]) => (a.conversation_config?.agent?.prompt?.tool_ids ?? []).includes(tid)).map(([aid]) => aid);
    const ghostsOf = (tid: string) => [...state.ghosts.entries()].filter(([, ts]) => ts.includes(tid)).map(([aid]) => aid);
    x = p.match(/^\/v1\/convai\/tools\/([^/]+)\/dependent-agents$/);
    if (m === "GET" && x) return j({ agents: users(x[1]).map((a) => ({ agent_id: a, agent_name: "x" })), branches: ghostsOf(x[1]).map((a) => ({ agent_id: a, agent_name: "Unknown", branch_name: "Main", is_main: true })), next_cursor: null, has_more: false });
    x = p.match(/^\/v1\/convai\/tools\/([^/]+)$/);
    if (x) {
      if (!state.tools.has(x[1])) return j({ detail: "tool not found" }, 404);
      if (m === "PATCH") { state.tools.set(x[1], structuredClone(body.tool_config)); return j({ id: x[1], tool_config: body.tool_config }); }
      if (m === "DELETE") {
        if (u.searchParams.get("force") !== "true" && (users(x[1]).length || ghostsOf(x[1]).length)) return j({ detail: { type: "conflict", message: "Tool is still in use by: Unknown / Main. Please remove the dependency or use Force Delete." } }, 409);
        state.tools.delete(x[1]); for (const [aid, ts] of state.ghosts) state.ghosts.set(aid, ts.filter((t) => t !== x![1]));
        return j({});
      }
    }

    if (m === "POST" && p === "/v1/convai/agents/create") {
      if (!body?.conversation_config) return j({ detail: [{ loc: ["body", "conversation_config"], msg: "field required" }] }, 422);
      for (const t of body.conversation_config?.agent?.prompt?.tool_ids ?? []) if (!state.tools.has(t)) return j({ detail: { message: `tool ${t} not found` } }, 400);
      const aid = id("agent"); state.agents.set(aid, structuredClone(body)); return j({ agent_id: aid });
    }
    if (m === "GET" && p === "/v1/convai/agents") return j({ agents: [...state.agents.keys()].slice(0, 1).map((a) => ({ agent_id: a })), has_more: false });
    x = p.match(/^\/v1\/convai\/agents\/([^/]+)$/);
    if (x) {
      const cur = state.agents.get(x[1]);
      if (!cur) return j({ detail: { message: "agent not found" } }, 404);
      if (m === "GET") return j({ agent_id: x[1], ...cur });
      if (m === "DELETE") { state.ghosts.set(x[1], [...(cur.conversation_config?.agent?.prompt?.tool_ids ?? [])]); state.agents.delete(x[1]); return j({}); }
      if (m === "PATCH") {
        // top-level objects are merged one level deep, like a partial update; what we own we always send whole
        const next = { ...cur, ...body, conversation_config: body.conversation_config ?? cur.conversation_config, platform_settings: { ...(cur.platform_settings ?? {}), ...(body.platform_settings ?? {}) } };
        state.agents.set(x[1], structuredClone(next)); return j({ agent_id: x[1] });
      }
    }
    x = p.match(/^\/v1\/convai\/agents\/([^/]+)\/run-tests$/);
    if (m === "POST" && x) { const rid = id("run"); state.tests.set(rid, { run: true, agent: x[1], tests: (body?.tests ?? []).map((t: Row) => t.test_id), polls: 0 }); return j({ id: rid }); }
    if (m === "POST" && p === "/v1/convai/agent-testing/create") { const tid = id("test"); state.tests.set(tid, body); return j({ id: tid }); }
    x = p.match(/^\/v1\/convai\/agent-testing\/([^/]+)$/);
    if (m === "DELETE" && x) { state.tests.delete(x[1]); return j({}); }
    x = p.match(/^\/v1\/convai\/test-invocations\/([^/]+)$/);
    if (m === "GET" && x) {
      const r = state.tests.get(x[1]); if (!r) return j({ detail: "not found" }, 404);
      r.polls++;
      return j({ id: x[1], test_runs: r.tests.map((t: string, i: number) => ({ test_id: t, status: r.polls < 2 ? "pending" : i === 1 ? "failed" : "passed", condition_result: { result: i === 1 ? "failure" : "success", rationale: { summary: i === 1 ? "The agent did not hand over." : "As expected." } },
        agent_responses: [{ role: "agent", message: "Hello from the test agent." }] })) });
    }

    if (m === "GET" && p === "/v1/convai/conversation/token") {
      const a = u.searchParams.get("agent_id") ?? "", ag = state.agents.get(a);
      if (!ag) return j({ detail: { message: "agent not found" } }, 404);
      if (ag.platform_settings?.archived) return j({ detail: { message: "agent is archived" } }, 400);
      const cid = id("conv"); state.conversations.set(cid, { agent_id: a, status: "in-progress", participant: u.searchParams.get("participant_name") });
      return j({ token: `tok_${cid}`, conversation_id: cid });
    }
    x = p.match(/^\/v1\/convai\/conversations\/([^/]+)(\/audio)?$/);
    if (x) {
      const c = state.conversations.get(x[1]);
      if (!c) return j({ detail: { message: "conversation not found" } }, 404);
      if (m === "DELETE") { state.conversations.delete(x[1]); return j({}); }
      if (m === "GET" && x[2]) return c.has_audio && !c.audio_gone ? new Response(new Uint8Array([73, 68, 51, 4, 0, 0, 0, 0, 0, 0]), { headers: { "content-type": "audio/mpeg" } }) : j({ detail: "no audio" }, 404);
      if (m === "GET") return j({ conversation_id: x[1], ...c });
    }

    if (m === "GET" && p === "/v2/voices") { const q = (u.searchParams.get("search") ?? "").toLowerCase(); return j({ voices: [...VOICES, ...state.added].filter((v) => !q || v.name.toLowerCase().includes(q)), has_more: false, next_page_token: null }); }
    if (m === "GET" && p === "/v1/shared-voices") return j({ voices: [{ public_owner_id: "owner0000000000000001", voice_id: "LibraryVoice00000001", name: "Asha", gender: "female", accent: "indian", language: u.searchParams.get("language") ?? "hi", use_case: "conversational", category: "professional", description: "calm", preview_url: "https://example.test/asha.mp3" },
      { public_owner_id: "owner0000000000000002", voice_id: "LibraryVoice00000002", name: "Guarded", gender: "male", live_moderation_enabled: true, preview_url: null }], has_more: false });
    x = p.match(/^\/v1\/voices\/add\/([^/]+)\/([^/]+)$/);
    if (m === "POST" && x) { const v = { voice_id: `Added${x[2].slice(0, 15)}`, name: body?.new_name ?? "Added", category: "professional", labels: {}, preview_url: null }; state.added.push(v); return j({ voice_id: v.voice_id }); }

    if (m === "POST" && p === "/v1/workspace/webhooks") { const wid = id("wh"); const secret = `wsec_${crypto.randomUUID().replace(/-/g, "")}`; state.webhooks.set(wid, { ...body?.settings, secret }); return j({ webhook_id: wid, webhook_secret: secret }); }
    if (m === "GET" && p === "/v1/workspace/webhooks") return j({ webhooks: [...state.webhooks.entries()].map(([webhook_id, w]) => ({ webhook_id, name: w.name, webhook_url: w.webhook_url })) });
    if (p === "/v1/convai/settings") { if (m === "PATCH") state.settings = { ...state.settings, ...body }; return j(state.settings); }
    return j({ detail: { message: `fake: no route ${m} ${p}` } }, 404);
  });

  const api: FakeEl = {
    state,
    close: () => server.shutdown(),
    failNext(prefix, status, times = 1) { fails.push({ prefix, status, left: times }); },
    clearFails() { fails.length = 0; },
    count: (method, prefix) => state.calls.filter((c) => c.method === method && c.path.startsWith(prefix)).length,
    async callTool(agentId, tool, body, vars, o = {}) {
      const ag = state.agents.get(agentId);
      const tid = (ag?.conversation_config?.agent?.prompt?.tool_ids ?? []).find((t: string) => state.tools.get(t)?.name === tool);
      const cfg = tid ? state.tools.get(tid) : null;
      if (!cfg || cfg.type !== "webhook") throw new Error(`fake: agent ${agentId} has no webhook tool ${tool}`);
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const [k, v] of Object.entries(cfg.api_schema.request_headers ?? {})) {
        const val = v as Row | string;
        if (typeof val === "string") headers[k] = val;
        else if (val.secret_id) headers[k] = state.secrets.get(val.secret_id)?.value ?? "";
        else if (val.variable_name) headers[k] = String(vars[val.variable_name] ?? "");
      }
      if (o.secret !== undefined) headers.Authorization = o.secret;
      if (o.session !== undefined) headers["X-GX-Session"] = o.session;
      const res = await fetch(cfg.api_schema.url, { method: cfg.api_schema.method ?? "POST", headers, body: JSON.stringify(body) });
      let out: any = null; try { out = await res.json(); } catch { /* no body */ }
      return { status: res.status, json: out };
    },
    finish(conversationId, o) {
      const c = state.conversations.get(conversationId) ?? { agent_id: "unknown" };
      const data = {
        agent_id: c.agent_id, conversation_id: conversationId, status: "done", has_audio: o.has_audio ?? true, has_user_audio: true, has_response_audio: true,
        transcript: o.transcript.map((t, i) => ({ role: t.role, message: t.message ?? null, time_in_call_secs: t.time_in_call_secs ?? i * 4, tool_calls: t.message ? [] : [{ tool_name: "search_knowledge" }], tool_results: [] })),
        metadata: { start_time_unix_secs: Math.floor(Date.now() / 1000) - (o.duration ?? 60), call_duration_secs: o.duration ?? 60, cost: o.cost ?? 420, cost_fiat: o.cost_fiat ?? 0.0875, termination_reason: o.termination_reason ?? "Client disconnected", main_language: o.language ?? "en" },
        analysis: { transcript_summary: o.summary ?? "The visitor asked about shipping.", call_summary_title: o.title ?? "Shipping question", call_successful: o.successful ?? "success", evaluation_criteria_results: {},
          data_collection_results: Object.fromEntries(Object.entries(o.collected ?? {}).map(([k, v]) => [k, { data_collection_id: k, value: v, rationale: "said by the visitor" }])) },
      };
      state.conversations.set(conversationId, { ...c, ...data });
      return { type: "post_call_transcription", event_timestamp: Math.floor(Date.now() / 1000), data };
    },
    async sign(body, secret, at = Math.floor(Date.now() / 1000)) { return `t=${at},v0=${await hmac(secret, `${at}.${body}`)}`; },
  };
  return api;
}

if (import.meta.main) {
  const port = Number(Deno.args[0] ?? 55997);
  startFakeElevenLabs(port);
  console.log(`fake voice provider on http://127.0.0.1:${port}`);
}
