// F20 — Sequence QA: static checks (blocking) + LLM warnings (non-blocking). body: {sequence_id} or {graph, workspace_id, pool}
import { admin, json, serve, requireUser, membership, requireRole, readJson, HttpError, rateLimit, rpc } from "../_shared/outreach/supabase.ts";
import { sequenceQa, aiAvailable, isKeyInvalid } from "../_shared/outreach/ai.ts";

serve("ai-sequence-qa", async (req) => {
  const user = await requireUser(req);
  await rateLimit(`user:${user.id}:sequence-qa`, 20, 60);
  const body = await readJson<{ sequence_id?: string; graph?: unknown; workspace_id?: string; pool?: string[]; brief?: string }>(req);
  let graph = body.graph, ws = body.workspace_id, pool = body.pool ?? [], brief = body.brief ?? null;
  if (body.sequence_id) {
    const { data: s } = await admin.from("outreach_sequences").select("workspace_id, graph, sender_pool, brief").eq("id", body.sequence_id).maybeSingle();
    if (!s) throw new HttpError(404, "E_NOT_FOUND");
    graph = s.graph; ws = s.workspace_id; pool = s.sender_pool ?? []; brief = brief ?? s.brief;
  }
  if (!ws || !graph) throw new HttpError(400, "E_PAYLOAD_INVALID", "sequence_id or graph+workspace_id required");
  const m = await membership(user.id, ws); requireRole(m, "manager");
  const stat = await rpc<{ errors: any[]; warnings: any[] }>("validate_graph", { p_graph: graph, p_pool: pool, p_strict: true });
  let llm: { warnings: any[]; errors: any[] } = { warnings: [], errors: [] };
  let ai_available = await aiAvailable(ws);   // platform key or the workspace's own key
  if (ai_available) {
    try { llm = await sequenceQa({ workspaceId: ws, graph, brief }); } catch (e) { ai_available = false; llm = { warnings: [{ code: isKeyInvalid(e) ? "W_AI_KEY_INVALID" : "W_AI_UNAVAILABLE", message: String((e as any)?.message ?? e).replace(/^E_[A-Z_]+:\s*/, "") }], errors: [] }; }
  }
  return json({ errors: [...(stat.errors ?? []), ...llm.errors], warnings: [...(stat.warnings ?? []), ...llm.warnings], ai_available });
});
