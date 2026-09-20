// Items 14 + 15 — AI variables and AI routing.
// Cron (every minute, x-cron-secret): writes pending {{ai.<key>}} lines and decides pending ai_route steps.
// User (JWT, manager): {action:"route_test"} = "test on 20 leads" (nothing stored), {action:"preview_variable"} = try a prompt on one lead (nothing stored).
import { admin, json, serve, requireUser, requireCron, membership, requireRole, readJson, HttpError, rateLimit, rpc, log, errorResponse } from "../_shared/outreach/supabase.ts";
import { generateAiVariable, routeLead, aiAvailable, isKeyInvalid, type AiRoute } from "../_shared/outreach/ai.ts";

type Row = Record<string, any>;
const PARALLEL = 4;
const GUARD_MS = 45_000;
const errText = (e: unknown) => String((e as any)?.message ?? e).slice(0, 300);
/** Errors that another try cannot fix: the workspace key is rejected, or no AI is configured at all. */
const isFinal = (e: unknown) => isKeyInvalid(e) || /^E_AI_UNAVAILABLE: AI is not configured/.test(errText(e));
const clampInt = (v: unknown, dflt: number, min: number, max: number) => Math.max(min, Math.min(max, Math.floor(Number(v)) || dflt));

async function leadFacts(leadId: string): Promise<Record<string, unknown>> {
  return (await rpc<Record<string, unknown>>("lead_ai_facts", { p_lead: leadId })) ?? {};
}

/** Run `job` over `items`, `PARALLEL` at a time, until the items or the time run out. */
async function pool<T>(items: T[], started: number, job: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (queue.length && Date.now() - started < GUARD_MS) await job(queue.shift()!);
  }));
}

// ---------------------------------------------------------------------------
// Cron: AI variables
// ---------------------------------------------------------------------------
// Rows are claimed one at a time by each of the parallel workers (the claim is `for update skip locked`), so a run that
// hits the time guard never leaves claimed-but-untouched rows locked for 10 minutes.
async function runVariables(limit: number, started: number): Promise<Row> {
  let generated = 0, blank = 0, failed = 0, retry_later = 0, taken = 0;
  const errors: string[] = [];
  const deadWorkspaces = new Map<string, string>();   // workspace → final error seen in this run: do not call again

  const one = async (v: Row): Promise<void> => {
    const dead = deadWorkspaces.get(v.workspace_id);
    if (dead) { await rpc("ai_value_result", { p_id: v.value_id, p_text: null, p_facts: [], p_model: null, p_error: dead }); failed++; return; }
    try {
      const facts = await leadFacts(v.lead_id);
      const out = await generateAiVariable({ workspaceId: v.workspace_id, prompt: v.prompt, maxChars: v.max_chars, facts, needsPosts: !!v.needs_posts });
      // text null → stored as "blank": needs no review, the fallback is used, the lead is not kept waiting
      await rpc("ai_value_result", { p_id: v.value_id, p_text: out.text, p_facts: out.facts, p_model: out.model, p_error: null });
      if (out.text) generated++; else blank++;
    } catch (e) {
      const msg = errText(e);
      if (errors.length < 3) errors.push(msg);
      log({ fn: "ai-variables", phase: "variable", value_id: v.value_id, workspace_id: v.workspace_id, error: msg });
      let final = isFinal(e);
      if (final) deadWorkspaces.set(v.workspace_id, msg);
      if (!final) {
        // Transient: the row stays pending and its lock (10 min) is the back-off. There is no attempts counter on
        // outreach_ai_values, so give up after two hours rather than retrying for ever: the fallback is used.
        const { data: row } = await admin.from("outreach_ai_values").select("updated_at").eq("id", v.value_id).maybeSingle();
        final = !!row?.updated_at && Date.now() - new Date(row.updated_at).getTime() > 2 * 3600_000;
      }
      if (final) {
        try { await rpc("ai_value_result", { p_id: v.value_id, p_text: null, p_facts: [], p_model: null, p_error: msg }); failed++; } catch (e2) { log({ fn: "ai-variables", warn: "ai_value_result failed", error: errText(e2) }); }
      } else retry_later++;
    }
  };

  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (taken < limit && Date.now() - started < GUARD_MS) {
      taken++;
      const rows = await rpc<Row[]>("ai_claim_pending", { p_limit: 1 });
      if (!rows?.length) { taken = limit; break; }
      await one(rows[0]);
    }
  }));
  return { generated, blank, failed, retry_later, ...(errors.length ? { errors } : {}) };
}

// ---------------------------------------------------------------------------
// Cron: AI routing
// ---------------------------------------------------------------------------
// ai_route_pending counts an attempt at claim time, so rows are claimed one at a time here too: an attempt is only
// spent on a row we really try. SQL stops offering a row after 3 attempts and its sweep sends it to "else" after 6 h;
// we do that at once on the third failure so the lead does not sit for hours.
async function runRoutes(limit: number, started: number): Promise<Row> {
  let decided = 0, to_else_on_error = 0, retry_later = 0, taken = 0;
  const errors: string[] = [];
  const split: Record<string, number> = {};

  const one = async (r: Row): Promise<void> => {
    try {
      const routes: AiRoute[] = Array.isArray(r.routes) ? r.routes : [];
      const facts = routes.length ? await leadFacts(r.lead_id) : {};
      const out = await routeLead({ workspaceId: r.workspace_id, routes, facts });
      await rpc("ai_route_decide", { p_enrollment: r.enrollment_id, p_node_id: r.node_id, p_branch: out.branch, p_reason: out.reason, p_facts: out.facts, p_model: out.model });
      split[out.branch] = (split[out.branch] ?? 0) + 1;
      decided++;
    } catch (e) {
      const msg = errText(e);
      if (errors.length < 3) errors.push(msg);
      log({ fn: "ai-variables", phase: "route", enrollment_id: r.enrollment_id, node_id: r.node_id, attempts: r.attempts, error: msg });
      if (Number(r.attempts) >= 3) {
        const why = isKeyInvalid(e) ? "The workspace's AI key was rejected" : "The AI could not decide after 3 tries";
        try { await rpc("ai_route_decide", { p_enrollment: r.enrollment_id, p_node_id: r.node_id, p_branch: "else", p_reason: `${why}; used the fallback branch.`, p_facts: [], p_model: null }); to_else_on_error++; } catch (e2) { log({ fn: "ai-variables", warn: "ai_route_decide failed", error: errText(e2) }); }
      } else retry_later++;
    }
  };

  await Promise.all(Array.from({ length: PARALLEL }, async () => {
    while (taken < limit && Date.now() - started < GUARD_MS) {
      taken++;
      const rows = await rpc<Row[]>("ai_route_pending", { p_limit: 1 });
      if (!rows?.length) { taken = limit; break; }
      await one(rows[0]);
    }
  }));
  return { decided, to_else_on_error, retry_later, split, ...(errors.length ? { errors } : {}) };
}

// ---------------------------------------------------------------------------
// User: "test on 20 leads"
// ---------------------------------------------------------------------------
function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

function cleanRoutes(value: unknown): AiRoute[] {
  if (!Array.isArray(value)) return [];
  return value.filter((r) => r && typeof r.id === "string" && r.id.trim()).map((r) => ({ id: String(r.id), label: r.label == null ? null : String(r.label), description: r.description == null ? null : String(r.description) })).slice(0, 12);
}

async function routeTest(userId: string, body: Row): Promise<Response> {
  const ws = String(body.workspace_id ?? "");
  if (!ws) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id required");
  const m = await membership(userId, ws); requireRole(m, "manager");
  await rateLimit("ai_route_test:" + userId, 10, 3600);

  // Routes: what the builder shows right now (body.routes), else the saved draft, else the live graph.
  let routes = cleanRoutes(body.routes);
  if (!routes.length) {
    if (!body.sequence_id || !body.node_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "sequence_id and node_id required");
    const { data: s, error } = await admin.from("outreach_sequences").select("workspace_id, graph, draft_graph").eq("id", body.sequence_id).maybeSingle();
    if (error) throw new HttpError(500, "E_INTERNAL", error.message);
    if (!s || s.workspace_id !== ws) throw new HttpError(404, "E_NOT_FOUND", "sequence not found");
    const node = (s.draft_graph as any)?.nodes?.[body.node_id] ?? (s.graph as any)?.nodes?.[body.node_id];
    if (!node) throw new HttpError(404, "E_NOT_FOUND", "step not found in this sequence. Save the draft first.");
    if (node.type !== "ai_route") throw new HttpError(400, "E_PAYLOAD_INVALID", "this step is not an AI routing step");
    routes = cleanRoutes(node.config?.routes);
  }
  if (!routes.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "describe at least one branch before testing");
  if (!(await aiAvailable(ws))) throw new HttpError(400, "E_AI_UNAVAILABLE", "AI is not set up for this workspace. Add your own key in Settings, AI.");

  // Leads: the given ids, or a random sample of recent leads. Both limited to this workspace and to the clients this member may see.
  const wanted = clampInt(body.sample, 20, 1, 20);
  let q = admin.from("outreach_leads").select("id, full_name, company, client_id").eq("workspace_id", ws);
  const ids: string[] = Array.isArray(body.lead_ids) ? [...new Set(body.lead_ids.map(String))].slice(0, 20) : [];
  q = ids.length ? q.in("id", ids) : q.order("created_at", { ascending: false }).limit(500);
  const { data: found, error: lErr } = await q;
  if (lErr) throw new HttpError(500, "E_INTERNAL", lErr.message);
  let leads = (found ?? []).filter((l) => m.role === "owner" || m.role === "manager" || !l.client_id || m.client_ids.includes(l.client_id));
  if (!ids.length) leads = shuffle(leads).slice(0, wanted);
  if (!leads.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "no leads to test on. Import some leads first.");

  const split: Record<string, number> = Object.fromEntries([...routes.map((r) => [r.id, 0]), ["else", 0]]);
  const results: Row[] = [];
  const failed: Row[] = [];
  let keyError: unknown = null;
  const started = Date.now();
  await pool(leads, started, async (l) => {
    if (keyError) return;
    try {
      const out = await routeLead({ workspaceId: ws, routes, facts: await leadFacts(l.id) });
      split[out.branch] = (split[out.branch] ?? 0) + 1;
      results.push({ lead_id: l.id, name: l.full_name ?? null, company: l.company ?? null, branch: out.branch, reason: out.reason, facts: out.facts });
    } catch (e) {
      if (isKeyInvalid(e)) { keyError = e; return; }
      failed.push({ lead_id: l.id, name: l.full_name ?? null, error: errText(e) });
    }
  });
  if (keyError) throw keyError;                                   // E_AI_KEY_INVALID: the UI says so
  if (!results.length && failed.length) throw new HttpError(502, "E_AI_UNAVAILABLE", `the AI did not answer: ${failed[0].error}`);
  const order = new Map(leads.map((l, i) => [l.id, i]));
  results.sort((a, b) => (order.get(a.lead_id) ?? 0) - (order.get(b.lead_id) ?? 0));
  return json({ split, results, failed, tested: results.length, not_tested: leads.length - results.length - failed.length, routes: routes.map((r) => ({ id: r.id, label: r.label ?? r.id })), stored: false });
}

// ---------------------------------------------------------------------------
// User: try a prompt on one lead
// ---------------------------------------------------------------------------
async function previewVariable(userId: string, body: Row): Promise<Response> {
  const ws = String(body.workspace_id ?? "");
  if (!ws || !body.lead_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and lead_id required");
  const m = await membership(userId, ws); requireRole(m, "manager");
  await rateLimit("ai_preview_variable:" + userId, 60, 3600);

  let prompt = "", maxChars = 220, needsPosts = false, fallback = "";
  if (body.variable_id) {
    const { data: v } = await admin.from("outreach_ai_variables").select("workspace_id, prompt, fallback, needs_posts, max_chars").eq("id", body.variable_id).maybeSingle();
    if (!v || v.workspace_id !== ws) throw new HttpError(404, "E_NOT_FOUND", "variable not found");
    prompt = v.prompt; maxChars = v.max_chars; needsPosts = v.needs_posts; fallback = v.fallback ?? "";
  }
  // Unsaved edits win over the saved variable, so a manager can tune the prompt before saving it.
  const draft: Row = body.variable && typeof body.variable === "object" ? body.variable : body;
  if (typeof draft.prompt === "string" && draft.prompt.trim()) prompt = draft.prompt;
  if (draft.max_chars != null) maxChars = clampInt(draft.max_chars, 220, 20, 1000);
  if (draft.needs_posts != null) needsPosts = !!draft.needs_posts;
  if (typeof draft.fallback === "string") fallback = draft.fallback;
  if (!prompt.trim()) throw new HttpError(400, "E_PAYLOAD_INVALID", "variable_id or prompt required");
  if (prompt.length > 4000) throw new HttpError(400, "E_PAYLOAD_INVALID", "prompt is longer than 4000 characters");

  const { data: lead } = await admin.from("outreach_leads").select("id, workspace_id, full_name").eq("id", body.lead_id).maybeSingle();
  if (!lead || lead.workspace_id !== ws) throw new HttpError(404, "E_NOT_FOUND", "lead not found");
  if (!(await aiAvailable(ws))) throw new HttpError(400, "E_AI_UNAVAILABLE", "AI is not set up for this workspace. Add your own key in Settings, AI.");

  const facts = await leadFacts(lead.id);
  try {
    const out = await generateAiVariable({ workspaceId: ws, prompt, maxChars, facts, needsPosts });
    return json({ lead_id: lead.id, name: lead.full_name ?? null, text: out.text, blank: out.text === null, facts: out.facts, fallback, used: out.text ?? fallback, model: out.model, enriched: !!(facts as any).enriched, stored: false });
  } catch (e) {
    if (isKeyInvalid(e)) throw e;
    throw new HttpError(502, "E_AI_UNAVAILABLE", `the AI did not answer: ${errText(e)}`);
  }
}

/** Same mapping as errorResponse(), plus `message` next to `error`: the web forms read {code, message}. */
async function withMessage(run: () => Promise<Response>): Promise<Response> {
  try { return await run(); } catch (e) {
    const res = errorResponse(e);
    const b = await res.json();
    return json({ ...b, message: b.error }, res.status);
  }
}

serve("ai-variables", async (req) => {
  const body = await readJson<Row>(req);
  if (body.action) {
    return withMessage(async () => {
      const user = await requireUser(req);
      if (body.action === "route_test") return routeTest(user.id, body);
      if (body.action === "preview_variable") return previewVariable(user.id, body);
      throw new HttpError(400, "E_PAYLOAD_INVALID", "action must be route_test or preview_variable");
    });
  }
  requireCron(req);
  const started = Date.now();
  // Routing first in the result, but both run side by side: a long variable backlog must not starve leads waiting at a routing step.
  const [routes, variables] = await Promise.all([
    runRoutes(clampInt(body.routes, 20, 1, 100), started).catch((e) => ({ error: errText(e) })),
    runVariables(clampInt(body.variables, 20, 1, 100), started).catch((e) => ({ error: errText(e) })),
  ]);
  return json({ ok: true, variables, routes, duration_ms: Date.now() - started });
});
