// F21 — Validate + create an import job. kinds: search_url {url, sender_id, max_results?}, csv {storage_path, mapping, row_count}, relations {sender_id}
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, HttpError, rpc, audit } from "../_shared/outreach/supabase.ts";
import { parseSearchUrl } from "../_shared/outreach/workers.ts";

serve("imports-create", async (req) => {
  const user = await requireUser(req);
  const body = await readJson<{ workspace_id: string; kind: "search_url" | "csv" | "relations"; client_id?: string | null; sender_id?: string | null; list_id?: string | null; tag_ids?: string[]; url?: string; max_results?: number; storage_path?: string; mapping?: Record<string, string>; row_count?: number; dry_run?: boolean }>(req);
  if (!body.workspace_id || !body.kind) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and kind required");
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "member");
  if (!clientVisible(m, body.client_id ?? null)) throw new HttpError(403, "E_FORBIDDEN");

  let params: Record<string, unknown> = {};
  let total: number | null = null;
  let estimate: Record<string, unknown> = {};
  if (body.kind === "search_url" || body.kind === "relations") {
    if (!body.sender_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "sender_id required");
    const { data: s } = await admin.from("outreach_senders").select("id, status, provider, workspace_id, warmup_level, display_name").eq("id", body.sender_id).maybeSingle();
    if (!s || s.workspace_id !== body.workspace_id) throw new HttpError(404, "E_NOT_FOUND", "sender");
    if (s.provider !== "LINKEDIN") throw new HttpError(400, "E_PAYLOAD_INVALID", "imports need a LinkedIn sender");
    if (s.status !== "ok") throw new HttpError(409, "E_SENDER_NOT_OK", "sender must be connected");
    const cap = await rpc<number>("effective_cap", { p_sender: s.id, p_type: "search_page" });
    if (body.kind === "search_url") {
      const url = (body.url ?? "").trim();
      if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(url)) throw new HttpError(400, "E_PAYLOAD_INVALID", "paste a linkedin.com search URL");
      const meta = parseSearchUrl(url);
      if (meta.category !== "people") throw new HttpError(400, "E_PAYLOAD_INVALID", "only people searches can be imported as leads");
      const perPage = meta.api === "classic" ? 10 : 50;
      const maxRows = Math.min(body.max_results ?? meta.cap, meta.cap);
      const pagesPerDay = Math.max(1, cap);
      const days = Math.ceil(maxRows / (pagesPerDay * perPage));
      params = { url, api: meta.api, category: meta.category, max_results: maxRows };
      total = maxRows;
      estimate = { api: meta.api, cap: meta.cap, per_page: perPage, pages_per_day: pagesPerDay, estimated_days: days, sender: s.display_name };
    } else {
      params = {};
      estimate = { note: "1 page (≤100 relations) per hour" };
    }
  } else if (body.kind === "csv") {
    if (!body.storage_path || !body.mapping) throw new HttpError(400, "E_PAYLOAD_INVALID", "storage_path and mapping required");
    if (!body.storage_path.startsWith(`${body.workspace_id}/`)) throw new HttpError(403, "E_FORBIDDEN", "bad storage path");
    const fields = new Set(Object.values(body.mapping));
    if (!fields.has("public_identifier") && !fields.has("linkedin_url") && !fields.has("email_work") && !fields.has("email_personal")) throw new HttpError(400, "E_PAYLOAD_INVALID", "map a LinkedIn URL or an email column");
    params = { storage_path: body.storage_path, mapping: body.mapping };
    total = body.row_count ?? null;
    estimate = { rows: total };
  }
  if (body.dry_run) return json({ ok: true, estimate, params });
  const { data: job, error } = await admin.from("outreach_import_jobs").insert({
    workspace_id: body.workspace_id, client_id: body.client_id ?? null, sender_id: body.sender_id ?? null, kind: body.kind, params, total_expected: total,
    list_id: body.list_id ?? null, tag_ids: body.tag_ids ?? [], created_by: user.id, next_run_at: new Date().toISOString(),
  }).select("*").single();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  await audit(body.workspace_id, "import.created", "import_job", job.id, { kind: body.kind, ...estimate }, "user");
  return json({ ok: true, job, estimate });
});
