// F21 — Validate + create an import job (user JWT).
//
// POST body {workspace_id, kind, client_id?, list_id?, tag_ids?, enrich?, dry_run?} plus, per kind:
//   search_url       {sender_id, url, max_results?}
//   relations        {sender_id}
//   csv              {storage_path, mapping, row_count?, mode?: 'upsert'|'update_only', update_fields?: string[]}
//   post_engagement  {sender_id, post_url, include?: ['reactions','comments','reposts'], max_results?}   (reposts: LinkedIn does not share who reposted, see below)
//   sn_saved_search  {sender_id, saved_search_id | url (a Sales Navigator URL with savedSearchId=…), name?, max_results?}
//   sn_lead_list     {sender_id, lead_list_id | url (…/sales/lists/people/<id>), name?, max_results?}
//   company_people   {sender_id, companies: [{name? | linkedin_url? | company_id?}] (≤100), title_keywords: string[], per_company ≤ 25}   the slowest source
//   conversations    {sender_id?, only_replied?, max_results?}   no LinkedIn call
// The same `params` object is what a repeating import (outreach_save_import_schedule) stores; `dry_run:true` returns it with the estimate.
//
// GET ?action=sn_options&sender_id=<id>  → {saved_searches:[{id,title}], lead_lists:[{id,title}]} for the picker (needs has_sales_nav).
//   Two budgeted LinkedIn lookups (search_page), cached for 6 hours per sender; `&refresh=1` forces a new lookup.
import { admin, json, serve, requireUser, membership, requireRole, clientVisible, readJson, HttpError, rpc, audit, rateLimit } from "../_shared/outreach/supabase.ts";
import { parseSearchUrl } from "../_shared/outreach/workers.ts";
import { sources, postIdFromUrl, salesNavIdsFromUrl, companyIdentFromUrl, postEngagementSupport } from "../_shared/outreach/unipile_sources.ts";
import { UnipileError } from "../_shared/outreach/unipile.ts";

type Row = Record<string, any>;
type Kind = "search_url" | "csv" | "relations" | "post_engagement" | "conversations" | "sn_saved_search" | "sn_lead_list" | "company_people";
const KINDS: Kind[] = ["search_url", "csv", "relations", "post_engagement", "conversations", "sn_saved_search", "sn_lead_list", "company_people"];
const LINKEDIN_KINDS: Kind[] = ["search_url", "relations", "post_engagement", "sn_saved_search", "sn_lead_list", "company_people"];
const UPDATABLE = ["first_name", "last_name", "full_name", "headline", "company", "title", "location", "email_work", "email_personal", "phone"];

async function loadSender(senderId: string, workspaceId: string): Promise<Row> {
  const { data: s } = await admin.from("outreach_senders").select("id, status, provider, workspace_id, client_id, warmup_level, display_name, has_sales_nav, unipile_account_id, timezone, deleted_at").eq("id", senderId).maybeSingle();
  if (!s || s.deleted_at || s.workspace_id !== workspaceId) throw new HttpError(404, "E_NOT_FOUND", "sender");
  if (s.provider !== "LINKEDIN") throw new HttpError(400, "E_PAYLOAD_INVALID", "Imports need a LinkedIn sender.");
  return s;
}

/** Saved searches and lead lists of a Sales Navigator sender, for the picker. */
async function snOptions(req: Request, url: URL): Promise<Response> {
  const user = await requireUser(req);
  const senderId = url.searchParams.get("sender_id") ?? "";
  if (!senderId) throw new HttpError(400, "E_PAYLOAD_INVALID", "sender_id required");
  const { data: row } = await admin.from("outreach_senders").select("workspace_id").eq("id", senderId).maybeSingle();
  if (!row) throw new HttpError(404, "E_NOT_FOUND", "sender");
  const m = await membership(user.id, row.workspace_id);
  requireRole(m, "member");
  const s = await loadSender(senderId, row.workspace_id);
  if (!clientVisible(m, s.client_id ?? null)) throw new HttpError(403, "E_FORBIDDEN");
  if (!s.has_sales_nav) throw new HttpError(409, "E_NO_SALES_NAV", `${s.display_name ?? "This sender"} has no Sales Navigator seat. Pick a sender that has one, or use a normal search URL.`);
  if (s.status !== "ok" || !s.unipile_account_id) throw new HttpError(409, "E_SENDER_NOT_OK", "Reconnect this sender first.");

  const refresh = url.searchParams.get("refresh") === "1";
  if (!refresh) {
    const { data: cached } = await admin.from("outreach_sender_events").select("data, at").eq("sender_id", s.id).eq("kind", "sn_options").gte("at", new Date(Date.now() - 6 * 3600_000).toISOString()).order("at", { ascending: false }).limit(1).maybeSingle();
    if (cached?.data) return json({ ok: true, cached: true, fetched_at: cached.at, saved_searches: cached.data.saved_searches ?? [], lead_lists: cached.data.lead_lists ?? [] });
  }
  await rateLimit(`sender:${s.id}:sn-options`, 4, 3600);
  const day = await rpc<string>("sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
  const lookup = async (call: () => Promise<Row[]>): Promise<Row[]> => {
    // every LinkedIn call is budgeted, also this one (contract rule 2)
    const ok = await rpc<boolean>("reserve_budget", { p_sender: s.id, p_day: day, p_type: "search_page" });
    if (!ok) throw new HttpError(429, "E_BUDGET_EXHAUSTED", "This sender has used today's search allowance. Try again tomorrow, or paste the Sales Navigator URL instead.");
    try { const r = await call(); await rpc("consume_budget", { p_sender: s.id, p_day: day, p_type: "search_page" }); return r; }
    catch (e) {
      await rpc("release_budget", { p_sender: s.id, p_day: day, p_type: "search_page" });
      if (e instanceof UnipileError) throw new HttpError(e.status === 403 ? 409 : 502, `E_UNIPILE_${e.code.toUpperCase()}`, e.status === 403 ? "LinkedIn refused the request. Check that the Sales Navigator seat of this sender is active." : `LinkedIn did not return the lists (${e.code}). Try again in a few minutes, or paste the Sales Navigator URL instead.`);
      throw e;
    }
  };
  const saved_searches = await lookup(() => sources.salesNavSavedSearches(s.unipile_account_id));
  const lead_lists = await lookup(() => sources.salesNavLeadLists(s.unipile_account_id));
  await admin.from("outreach_sender_events").insert({ sender_id: s.id, kind: "sn_options", data: { saved_searches, lead_lists } });
  return json({ ok: true, cached: false, fetched_at: new Date().toISOString(), saved_searches, lead_lists });
}

serve("imports-create", async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") {
    if (url.searchParams.get("action") === "sn_options") return await snOptions(req, url);
    throw new HttpError(400, "E_PAYLOAD_INVALID", "unknown action");
  }
  const user = await requireUser(req);
  const body = await readJson<{
    workspace_id: string; kind: Kind; client_id?: string | null; sender_id?: string | null; list_id?: string | null; tag_ids?: string[]; enrich?: boolean; dry_run?: boolean;
    url?: string; max_results?: number; storage_path?: string; mapping?: Record<string, string>; row_count?: number; mode?: "upsert" | "update_only"; update_fields?: string[];
    post_url?: string; include?: string[]; saved_search_id?: string; lead_list_id?: string; name?: string;
    companies?: Array<{ name?: string; linkedin_url?: string; company_id?: string }>; title_keywords?: string[]; per_company?: number; only_replied?: boolean;
  }>(req);
  if (!body.workspace_id || !body.kind) throw new HttpError(400, "E_PAYLOAD_INVALID", "workspace_id and kind required");
  if (!KINDS.includes(body.kind)) throw new HttpError(400, "E_PAYLOAD_INVALID", `unknown import kind "${body.kind}"`);
  const m = await membership(user.id, body.workspace_id);
  requireRole(m, "member");
  if (!clientVisible(m, body.client_id ?? null)) throw new HttpError(403, "E_FORBIDDEN");

  let params: Record<string, unknown> = {};
  let total: number | null = null;
  let estimate: Record<string, unknown> = {};
  let mode: "upsert" | "update_only" = "upsert";
  let updateFields: string[] = [];
  const warnings: string[] = [];

  if (LINKEDIN_KINDS.includes(body.kind)) {
    if (!body.sender_id) throw new HttpError(400, "E_PAYLOAD_INVALID", "sender_id required");
    const s = await loadSender(body.sender_id, body.workspace_id);
    if (s.status !== "ok") throw new HttpError(409, "E_SENDER_NOT_OK", "sender must be connected");
    const cap = await rpc<number>("effective_cap", { p_sender: s.id, p_type: "search_page" });
    const pagesPerDay = Math.max(1, cap);

    if (body.kind === "search_url") {
      const u = (body.url ?? "").trim();
      if (!/^https:\/\/(www\.)?linkedin\.com\//i.test(u)) throw new HttpError(400, "E_PAYLOAD_INVALID", "paste a linkedin.com search URL");
      const meta = parseSearchUrl(u);
      if (meta.category !== "people") throw new HttpError(400, "E_PAYLOAD_INVALID", "only people searches can be imported as leads");
      const perPage = meta.api === "classic" ? 10 : 50;
      const maxRows = Math.min(body.max_results ?? meta.cap, meta.cap);
      params = { url: u, api: meta.api, category: meta.category, max_results: maxRows };
      total = maxRows;
      estimate = { api: meta.api, cap: meta.cap, per_page: perPage, pages_per_day: pagesPerDay, estimated_days: Math.ceil(maxRows / (pagesPerDay * perPage)), sender: s.display_name };
    } else if (body.kind === "relations") {
      estimate = { note: "1 page (≤100 relations) per hour" };
    } else if (body.kind === "post_engagement") {
      const postUrl = (body.post_url ?? body.url ?? "").trim();
      if (!postIdFromUrl(postUrl)) throw new HttpError(400, "E_PAYLOAD_INVALID", "This does not look like a LinkedIn post URL. Open the post, choose \"Copy link to post\" and paste that link.");
      const asked = (body.include?.length ? body.include : ["reactions", "comments"]).map((x) => String(x).toLowerCase());
      const include = asked.filter((x) => (x === "reactions" && postEngagementSupport.reactions) || (x === "comments" && postEngagementSupport.comments));
      if (asked.includes("reposts")) warnings.push("LinkedIn does not share who reposted a post, so reposts are not imported. People who reacted or commented are.");
      if (!include.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "Choose reactions or comments. LinkedIn does not share who reposted a post.");
      const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2000)), 5000);
      params = { post_url: postUrl, include, max_results: maxRows };
      total = null;
      estimate = { per_page: 100, pages_per_day: pagesPerDay, max_results: maxRows, estimated_days: Math.ceil((maxRows / 100 + 1) / pagesPerDay), sender: s.display_name, note: "One page of up to 100 people every 20 to 90 minutes, inside the sender's working hours." };
    } else if (body.kind === "sn_saved_search" || body.kind === "sn_lead_list") {
      if (!s.has_sales_nav) throw new HttpError(409, "E_NO_SALES_NAV", `${s.display_name ?? "This sender"} has no Sales Navigator seat. Pick a sender that has one.`);
      const fromUrl = body.url ? salesNavIdsFromUrl(body.url) : {};
      const id = body.kind === "sn_saved_search" ? (body.saved_search_id ?? fromUrl.saved_search_id) : (body.lead_list_id ?? fromUrl.lead_list_id);
      if (!id || !/^\d+$/.test(String(id))) throw new HttpError(400, "E_PAYLOAD_INVALID", body.kind === "sn_saved_search" ? "Pick a saved search (or paste its Sales Navigator URL)." : "Pick a lead list (or paste its Sales Navigator URL).");
      const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2500)), 2500);
      params = { ...(body.kind === "sn_saved_search" ? { saved_search_id: String(id) } : { lead_list_id: String(id) }), api: "sales_navigator", name: body.name ?? null, max_results: maxRows };
      total = maxRows;
      estimate = { api: "sales_navigator", cap: 2500, per_page: 50, pages_per_day: pagesPerDay, estimated_days: Math.ceil(maxRows / (pagesPerDay * 50)), sender: s.display_name };
    } else if (body.kind === "company_people") {
      const companies = (body.companies ?? []).map((c) => ({ name: c.name?.trim() || undefined, linkedin_url: c.linkedin_url?.trim() || undefined, company_id: c.company_id ? String(c.company_id).trim() : undefined }))
        .filter((c) => c.name || c.linkedin_url || c.company_id);
      if (!companies.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "Add at least one company (name, LinkedIn URL or company id).");
      if (companies.length > 100) throw new HttpError(400, "E_TOO_MANY", "At most 100 companies per import. Split the list.");
      const bad = companies.find((c) => c.linkedin_url && !companyIdentFromUrl(c.linkedin_url));
      if (bad) throw new HttpError(400, "E_PAYLOAD_INVALID", `"${bad.linkedin_url}" is not a LinkedIn company URL.`);
      const titles = (body.title_keywords ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 10);
      if (!titles.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "Add at least one job title keyword, for example \"Head of Sales\".");
      const perCompany = Math.max(1, Math.min(25, Number(body.per_company ?? 10)));
      params = { companies, title_keywords: titles, per_company: perCompany };
      total = companies.length * perCompany;
      const calls = companies.reduce((a, c) => a + (c.company_id || /^\d+$/.test(companyIdentFromUrl(c.linkedin_url ?? "") ?? "") ? 0 : 1) + Math.ceil(perCompany / 10), 0);
      estimate = { per_page: 10, pages_per_day: pagesPerDay, linkedin_calls: calls, estimated_days: Math.ceil(calls / pagesPerDay), sender: s.display_name, slowest_source: true,
        note: "This is the slowest source: each company needs one lookup plus up to three search pages of 10, all from the sender's daily search allowance. Give company ids or URLs to skip the lookup." };
    }
  } else if (body.kind === "csv") {
    if (!body.storage_path || !body.mapping) throw new HttpError(400, "E_PAYLOAD_INVALID", "storage_path and mapping required");
    if (!body.storage_path.startsWith(`${body.workspace_id}/`)) throw new HttpError(403, "E_FORBIDDEN", "bad storage path");
    const fields = new Set(Object.values(body.mapping));
    if (!fields.has("public_identifier") && !fields.has("linkedin_url") && !fields.has("email_work") && !fields.has("email_personal")) throw new HttpError(400, "E_PAYLOAD_INVALID", "map a LinkedIn URL or an email column");
    if (body.mode === "update_only") {
      mode = "update_only";
      updateFields = [...new Set((body.update_fields ?? []).map(String))];
      if (!updateFields.length) throw new HttpError(400, "E_PAYLOAD_INVALID", "Choose at least one column to update.");
      const unknown = updateFields.filter((f) => !UPDATABLE.includes(f) && !f.startsWith("custom."));
      if (unknown.length) throw new HttpError(400, "E_PAYLOAD_INVALID", `These fields cannot be updated from a CSV: ${unknown.join(", ")}`);
      const unmapped = updateFields.filter((f) => !fields.has(f));
      if (unmapped.length) throw new HttpError(400, "E_PAYLOAD_INVALID", `No CSV column is mapped to: ${unmapped.join(", ")}`);
    }
    params = { storage_path: body.storage_path, mapping: body.mapping };
    total = body.row_count ?? null;
    estimate = { rows: total, ...(mode === "update_only" ? { note: "Update mode: rows are matched on LinkedIn URL or email. Only the chosen columns change, empty cells never blank a field, and no lead is created." } : {}) };
  } else if (body.kind === "conversations") {
    if (body.sender_id) await loadSender(body.sender_id, body.workspace_id);
    const maxRows = Math.min(Math.max(1, Number(body.max_results ?? 2000)), 5000);
    params = { only_replied: !!body.only_replied, max_results: maxRows };
    let q = admin.from("outreach_chats").select("id", { count: "exact", head: true }).eq("workspace_id", body.workspace_id).is("lead_id", null).eq("provider", "LINKEDIN");
    if (body.sender_id) q = q.eq("sender_id", body.sender_id);
    const { count } = await q;
    total = Math.min(count ?? 0, maxRows);
    estimate = { conversations_without_lead: count ?? 0, note: "No LinkedIn call is made: leads are created from conversations that are already synced." };
  }

  if (body.dry_run) return json({ ok: true, estimate, params, warnings });
  const { data: job, error } = await admin.from("outreach_import_jobs").insert({
    workspace_id: body.workspace_id, client_id: body.client_id ?? null, sender_id: body.sender_id ?? null, kind: body.kind, params, total_expected: total,
    list_id: body.list_id ?? null, tag_ids: body.tag_ids ?? [], created_by: user.id, next_run_at: new Date().toISOString(),
    mode, update_fields: updateFields, enrich: !!body.enrich,
  }).select("*").single();
  if (error) throw new HttpError(500, "E_INTERNAL", error.message);
  await audit(body.workspace_id, "import.created", "import_job", job.id, { kind: body.kind, mode, enrich: !!body.enrich, ...estimate }, "user");
  return json({ ok: true, job, estimate, warnings });
});
