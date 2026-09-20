// Secondary workers: reconnect (F6), imports (F7), withdraw (F8), relations poll (F9), outbound webhooks (F23), billing (F25), classify (F18).
import { admin, log, rpc, emitEvent, localParts, zonedToUtc, randInt, rand, audit } from "./supabase.ts";
import { unipile, unipileConfigured, UnipileError, distanceToRelation, invitationPending } from "./unipile.ts";
import { decrypt, hmacSha256Hex } from "./crypto.ts";
import { notifySender } from "./notify.ts";
import { classifyMessage, aiConfigured } from "./ai.ts";
import { _internal as inboundInternal } from "./inbound.ts";
import { sources, postIdFromUrl, companyIdentFromUrl, engagementAuthorToItem } from "./unipile_sources.ts";

type Row = Record<string, any>;

// ---------------------------------------------------------------------------
// F6 reconnect
// ---------------------------------------------------------------------------
export async function reconnectSender(sender: Row): Promise<{ ok: boolean; reason?: string }> {
  const { data: sec } = await admin.from("outreach_sender_secrets").select("*").eq("sender_id", sender.id).maybeSingle();
  if (!sec?.li_at_enc) return { ok: false, reason: "no_cookie" };
  await admin.from("outreach_secret_access_log").insert({ sender_id: sender.id, fn: "worker-reconnect" });
  const li_at = await decrypt(sec.li_at_enc);
  const li_a = sec.li_a_enc ? await decrypt(sec.li_a_enc) : undefined;
  const body: Record<string, unknown> = { provider: "LINKEDIN", access_token: li_at, user_agent: sec.cookie_user_agent ?? sender.user_agent };
  if (li_a) body.premium_token = li_a;
  if (sender.proxy_country) body.country = sender.proxy_country;
  try {
    await unipile.accounts.reconnect(sender.unipile_account_id, body);
    await admin.from("outreach_senders").update({ last_reconnect_at: new Date().toISOString(), reconnect_attempts: (sender.reconnect_attempts ?? 0) + 1 }).eq("id", sender.id);
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { method: "cookie", result: "requested" } });
    return { ok: true };
  } catch (e) {
    const code = e instanceof UnipileError ? e.code : String(e);
    await admin.from("outreach_senders").update({ last_reconnect_at: new Date().toISOString(), reconnect_attempts: (sender.reconnect_attempts ?? 0) + 1 }).eq("id", sender.id);
    await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "reconnect", data: { method: "cookie", result: "failed", code } });
    if (e instanceof UnipileError && e.code === "checkpoint_error") await admin.from("outreach_sender_events").insert({ sender_id: sender.id, kind: "checkpoint", data: { code } });
    return { ok: false, reason: code };
  }
}

export async function runReconnect(): Promise<Row> {
  const { data: senders } = await admin.from("outreach_senders").select("*").eq("status", "credentials").is("deleted_at", null).eq("provider", "LINKEDIN");
  const out: Row = { attempted: 0, notified: 0 };
  for (const s of senders ?? []) {
    const lastAt = s.last_reconnect_at ? new Date(s.last_reconnect_at).getTime() : 0;
    if (s.auth_method === "cookie") {
      if ((s.reconnect_attempts ?? 0) < 4) {
        if (Date.now() - lastAt < 3600_000) continue;
        out.attempted++;
        await reconnectSender(s);
      } else if (!s.reconnect_notified_at || Date.now() - new Date(s.reconnect_notified_at).getTime() > 86400_000) {
        if ((s.reconnect_reminders ?? 0) < 4) {
          await notifySender(s.id, "reconnect_needed_manual", { attempts: s.reconnect_attempts });
          await admin.from("outreach_senders").update({ reconnect_notified_at: new Date().toISOString(), reconnect_reminders: (s.reconnect_reminders ?? 0) + 1 }).eq("id", s.id);
          out.notified++;
        }
      }
    } else if (!s.reconnect_notified_at || (Date.now() - new Date(s.reconnect_notified_at).getTime() > 86400_000 && (s.reconnect_reminders ?? 0) < 3)) {
      const { reconnectLink } = await import("./inbound.ts");
      const link = await reconnectLink(s).catch(() => null);
      await notifySender(s.id, "reconnect_needed", { link });
      await admin.from("outreach_senders").update({ reconnect_notified_at: new Date().toISOString(), reconnect_reminders: (s.reconnect_reminders ?? 0) + 1 }).eq("id", s.id);
      out.notified++;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// F7 imports
// ---------------------------------------------------------------------------
function parseSearchUrl(url: string): { api: "classic" | "sales_navigator" | "recruiter"; category: "people" | "companies"; cap: number } {
  const u = url.toLowerCase();
  const api = u.includes("/sales/") ? "sales_navigator" : u.includes("/talent/") || u.includes("recruiter") ? "recruiter" : "classic";
  const category = u.includes("/company") || u.includes("companies") || u.includes("/search/results/companies") ? "companies" : "people";
  return { api, category, cap: api === "classic" ? 1000 : category === "companies" ? 1000 : 2500 };
}

export { parseSearchUrl };

async function upsertLeadsFromItems(job: Row, items: Row[], source: string): Promise<{ created: number; updated: number }> {
  let created = 0, updated = 0;
  for (const it of items) {
    if (it.type && String(it.type).toUpperCase() === "COMPANY") continue;
    let pub = it.public_identifier ?? inboundInternal.pubIdFromUrl(it.public_profile_url ?? it.profile_url);
    let provider_id = it.id ?? it.provider_id ?? it.member_id ?? null;
    // engagement / Sales Navigator rows often carry the opaque member id in the profile URL (linkedin.com/in/ACoAA…): that is a provider id, not a vanity name
    if (pub && /^aco[a-z0-9_-]{15,}$/i.test(String(pub))) { provider_id = provider_id ?? String(it.public_profile_url ?? it.profile_url ?? "").match(/\/in\/([^/?#]+)/)?.[1] ?? null; pub = null; }
    if (!pub && !provider_id) continue;
    const cur = (it.current_positions ?? [])[0];
    const custom: Row = {};
    for (const [k, v] of Object.entries({ network_distance: it.network_distance, premium: it.premium, ...(it._custom ?? {}) })) if (v !== undefined && v !== null && v !== "") custom[k] = v;
    const lead = {
      public_identifier: pub ? String(pub).toLowerCase() : null, provider_id, profile_url: it.public_profile_url ?? it.profile_url ?? null,
      first_name: it.first_name ?? null, last_name: it.last_name ?? null, full_name: it.name ?? ([it.first_name, it.last_name].filter(Boolean).join(" ") || null),
      headline: it.headline ?? null, location: it.location ?? null, picture_url: it.profile_picture_url ?? null,
      company: cur?.company ?? it.current_company ?? it._company ?? null, title: cur?.role ?? cur?.title ?? null, is_open_profile: typeof it.open_profile === "boolean" ? it.open_profile : null,
      client_id: job.client_id, list_id: job.list_id, custom,
    };
    try {
      const r = await rpc<any>("upsert_lead", { p_ws: job.workspace_id, p_lead: lead, p_source: source, p_import_job: job.id });
      const row = Array.isArray(r) ? r[0] : r;
      if (row?.created) created++; else updated++;
      if (row?.id && job.tag_ids?.length) await admin.from("outreach_lead_tags").upsert(job.tag_ids.map((t: string) => ({ lead_id: row.id, tag_id: t })), { onConflict: "lead_id,tag_id", ignoreDuplicates: true });
      if (row?.id && job.sender_id && it.network_distance) {
        const rel = distanceToRelation(it.network_distance);
        if (rel === "first") { await admin.from("outreach_lead_sender_state").upsert({ lead_id: row.id, sender_id: job.sender_id, relation: "first" }, { onConflict: "lead_id,sender_id" }); }
        else if (it.pending_invitation) { await admin.from("outreach_lead_sender_state").upsert({ lead_id: row.id, sender_id: job.sender_id, relation: "pending_out" }, { onConflict: "lead_id,sender_id" }); }
      }
    } catch (e) { log({ fn: "imports", warn: String(e) }); }
  }
  return { created, updated };
}

/** A failure that retrying cannot fix. The message is shown to the user as is (plan section 13: imports must show a real error). */
class ImportFatal extends Error {}
/** The sender's search allowance for today is used up: not an error, try again later. */
class NoBudget extends Error {}

const LINKEDIN_KINDS = ["search_url", "relations", "post_engagement", "sn_saved_search", "sn_lead_list", "company_people"];
const SOURCE_LABEL: Record<string, string> = {
  search_url: "search import", relations: "connections import", post_engagement: "post engagement import", sn_saved_search: "Sales Navigator saved search import",
  sn_lead_list: "Sales Navigator lead list import", company_people: "people-in-companies import", conversations: "conversations import", csv: "CSV import",
};

/** Plain-words version of whatever went wrong. `fatal` = stop the job now. */
function explainImportError(e: unknown, job: Row): { message: string; fatal: boolean } {
  if (e instanceof ImportFatal) return { message: e.message, fatal: true };
  if (e instanceof UnipileError) {
    const detail = String(e.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    const sn = job.kind === "sn_saved_search" || job.kind === "sn_lead_list" || String(job.params?.api ?? "") === "sales_navigator";
    if (e.network || e.status === 0) return { message: "LinkedIn could not be reached. We will try again within the hour.", fatal: false };
    if (e.status === 401 || /disconnected|credentials|invalid_account/i.test(e.code)) return { message: "The LinkedIn session of this sender ended. Reconnect the sender; the import continues on its own afterwards.", fatal: false };
    if (e.status === 429 || e.status >= 500) return { message: `LinkedIn is limiting requests right now (${e.status}). The import waits and tries again within the hour.`, fatal: false };
    if (e.status === 403) return { message: sn ? "LinkedIn refused this request. The sender needs an active Sales Navigator seat for this import." : `LinkedIn refused this request (${e.code}). Check that this sender can open the page in a browser.`, fatal: true };
    if (e.status === 404) return { message: job.kind === "post_engagement" ? "LinkedIn could not find this post. Check that the URL opens for the sender and that the post is not private or deleted." : sn ? "LinkedIn could not find this saved search or list. It may have been deleted in Sales Navigator; pick it again." : `LinkedIn could not find what this import points to (${e.code}).`, fatal: true };
    return { message: `LinkedIn rejected the request: ${detail || e.code}. Check the ${job.kind === "search_url" ? "search URL" : "import settings"} and start the import again.`, fatal: [400, 422].includes(e.status) };
  }
  const raw = String((e as any)?.message ?? e).replace(/^E_[A-Z_]+:\s*/, "");
  return { message: `The ${SOURCE_LABEL[job.kind] ?? "import"} hit an unexpected error: ${raw.slice(0, 240)}`, fatal: false };
}

const stateOf = (job: Row): Row => ({ ...((job.params ?? {})._state ?? {}) });
const withState = (job: Row, st: Row): Row => ({ ...(job.params ?? {}), _state: st });

async function updateJob(job: Row, patch: Row): Promise<void> {
  const { error } = await admin.from("outreach_import_jobs").update(patch).eq("id", job.id);
  if (error) log({ fn: "imports", job: job.id, error: `job update failed: ${error.message}` });
}

/** One budgeted LinkedIn call: reserve search_page, call, consume; release on failure (contract rule 2). */
async function searchBudgeted<T>(senderId: string, day: string, call: () => Promise<T>): Promise<T> {
  const ok = await rpc<boolean>("reserve_budget", { p_sender: senderId, p_day: day, p_type: "search_page" });
  if (!ok) throw new NoBudget();
  try {
    const r = await call();
    await rpc("consume_budget", { p_sender: senderId, p_day: day, p_type: "search_page" });
    return r;
  } catch (e) {
    await rpc("release_budget", { p_sender: senderId, p_day: day, p_type: "search_page" });
    throw e;
  }
}

/** Same pacing as search_url: one page, then 20 to 90 minutes of quiet. */
const nextPageAt = () => new Date(Date.now() + randInt(20, 90) * 60_000).toISOString();

/** Queue background enrichment for the leads this job created, when the job or the workspace asks for it. */
async function enrichAfterImport(job: Row): Promise<void> {
  try {
    let wanted = !!job.enrich, reason = "import";
    if (!wanted) {
      const { data: ws } = await admin.from("outreach_workspaces").select("settings").eq("id", job.workspace_id).maybeSingle();
      if (ws?.settings?.enrich_on_import === true) { wanted = true; reason = "setting"; }
    }
    if (!wanted) return;
    let queued = 0;
    for (let from = 0; from < 20000; from += 1000) {
      const { data: rows } = await admin.from("outreach_leads").select("id").eq("import_job_id", job.id).order("id").range(from, from + 999);
      if (!rows?.length) break;
      // same rules as the UI button (fresh profiles skipped, do-not-contact skipped); the service role passes the membership check
      const r = await rpc<Row>("request_enrichment", { p_ws: job.workspace_id, p_lead_ids: rows.map((x) => x.id), p_want_posts: false, p_force: false, p_reason: reason });
      queued += Number(r?.queued ?? 0);
      if (rows.length < 1000) break;
    }
    log({ fn: "imports", job: job.id, enrich_queued: queued, reason });
  } catch (e) { log({ fn: "imports", job: job.id, warn: `enrichment request failed: ${String((e as any)?.message ?? e)}` }); }
}

/** Marks a job finished. Every source ends here so enrichment and counters behave the same (also for jobs made by a repeating schedule). */
async function finishJob(job: Row, patch: Row = {}): Promise<void> {
  await updateJob(job, { status: "done", finished_at: new Date().toISOString(), next_run_at: null, error: null, ...patch });
  await enrichAfterImport(job);
}

export async function runImportJob(job: Row): Promise<void> {
  try {
    if (job.kind === "csv") { await runCsvImport(job); return; }
    if (job.kind === "conversations") {
      // no LinkedIn call: the chats are already in the database
      await rpc("import_conversations", { p_job: job.id });
      await enrichAfterImport(job);
      return;
    }
    if (!LINKEDIN_KINDS.includes(job.kind)) throw new ImportFatal(`This import type (${job.kind}) is not supported by this version of the worker.`);
    if (!job.sender_id) throw new ImportFatal("The sender this import used was removed. Start the import again with another sender.");
    const { data: sender } = await admin.from("outreach_senders").select("*").eq("id", job.sender_id).single();
    if (!sender || sender.deleted_at || sender.status === "disabled") throw new ImportFatal("The sender this import used was removed or disabled. Start the import again with another sender.");
    if (sender.status !== "ok" || !sender.unipile_account_id) {
      if (Date.now() - new Date(job.created_at).getTime() > 7 * 86400_000) throw new ImportFatal(`${sender.display_name ?? "The sender"} has been disconnected for more than 7 days, so this import was stopped. Reconnect the sender and start it again.`);
      await updateJob(job, { status: "running", error: `Waiting: ${sender.display_name ?? "the sender"} is not connected (${sender.status}). The import continues once it is reconnected.`, next_run_at: new Date(Date.now() + 30 * 60_000).toISOString() });
      return;
    }
    if ((job.kind === "sn_saved_search" || job.kind === "sn_lead_list") && !sender.has_sales_nav) throw new ImportFatal(`${sender.display_name ?? "This sender"} has no Sales Navigator seat. Pick a sender that has one.`);
    const inSched = await rpc<boolean>("in_schedule", { p_sender: sender.id, p_at: new Date().toISOString() });
    if (!inSched) { await updateJob(job, { next_run_at: new Date(Date.now() + 30 * 60_000).toISOString() }); return; }
    const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
    const p = job.params ?? {};
    const st = stateOf(job);
    st.errors = 0;

    if (job.kind === "search_url" || job.kind === "sn_saved_search" || job.kind === "sn_lead_list") {
      const meta = job.kind === "search_url" ? parseSearchUrl(p.url ?? "") : { api: "sales_navigator" as const, category: "people" as const, cap: 2500 };
      const api = p.api ?? meta.api;
      const limit = api === "classic" ? 10 : 50;
      const q = { cursor: job.cursor ?? undefined, limit };
      if (job.kind === "sn_saved_search" && !p.saved_search_id) throw new ImportFatal("This import has no saved search selected.");
      if (job.kind === "sn_lead_list" && !p.lead_list_id) throw new ImportFatal("This import has no lead list selected.");
      const res: Row = await searchBudgeted(sender.id, day, () => {
        if (job.kind === "sn_saved_search") return sources.searchSavedSearch(sender.unipile_account_id, String(p.saved_search_id), q);
        if (job.kind === "sn_lead_list") return sources.searchLeadList(sender.unipile_account_id, String(p.lead_list_id), q);
        const body: Row = p.url ? { url: p.url } : { api, category: p.category ?? "people", ...(p.filters ?? {}) };
        if (p.url && p.api) body.api = p.api;
        return unipile.linkedin.search(sender.unipile_account_id, body, q);
      });
      const items: Row[] = res.items ?? [];
      const { created, updated } = await upsertLeadsFromItems(job, items, job.kind);
      const fetched = (job.fetched ?? 0) + items.length;
      const cap = meta.cap;
      const done = !res.cursor || items.length === 0 || fetched >= cap || (p.max_results && fetched >= p.max_results);
      const patch: Row = {
        fetched, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated,
        cursor: res.cursor ?? null, next_offset: fetched, total_expected: res.paging?.total_count ?? job.total_expected, capped: fetched >= cap, params: withState(job, st),
      };
      if (done) await finishJob(job, patch); else await updateJob(job, { ...patch, status: "running", next_run_at: nextPageAt(), error: null });
      return;
    }

    if (job.kind === "relations") {
      const res = await unipile.users.relations(sender.unipile_account_id, job.cursor ?? undefined, 100);
      const items = (res.items ?? []).map((r: Row) => ({ ...r, id: r.member_id, name: [r.first_name, r.last_name].filter(Boolean).join(" "), network_distance: "FIRST_DEGREE" }));
      const { created, updated } = await upsertLeadsFromItems(job, items, "relations");
      const fetched = (job.fetched ?? 0) + items.length;
      const done = !res.cursor || items.length === 0;
      const patch: Row = { fetched, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated, cursor: res.cursor ?? null, params: withState(job, st) };
      if (done) await finishJob(job, patch); else await updateJob(job, { ...patch, status: "running", next_run_at: new Date(Date.now() + 3600_000 + randInt(0, 20) * 60_000).toISOString(), error: null });
      return;
    }

    if (job.kind === "post_engagement") {
      // phases: resolve the post, then reactions pages, then comments pages. One budgeted page per run.
      const include: string[] = (Array.isArray(p.include) && p.include.length ? p.include : ["reactions", "comments"]).filter((x: string) => x === "reactions" || x === "comments");
      if (!include.length) throw new ImportFatal("LinkedIn does not share who reposted a post, so there is nothing to import. Include reactions or comments.");
      if (!st.social_id) {
        const postId = postIdFromUrl(p.post_url ?? "");
        if (!postId) throw new ImportFatal("This does not look like a LinkedIn post URL. Open the post, use \"Copy link to post\" and paste that link.");
        const post: Row = await searchBudgeted(sender.id, day, () => sources.getPost(sender.unipile_account_id, postId));
        st.social_id = post?.social_id ?? post?.id ?? null;
        if (!st.social_id) throw new ImportFatal("LinkedIn returned the post without an id we can use. Try the link from \"Copy link to post\".");
        st.phase = include[0];
        const expected = (include.includes("reactions") ? Number(post.reaction_counter ?? 0) : 0) + (include.includes("comments") ? Number(post.comment_counter ?? 0) : 0);
        await updateJob(job, { status: "running", params: withState(job, st), total_expected: Math.min(expected || 0, Number(p.max_results ?? 5000)) || job.total_expected, next_run_at: new Date(Date.now() + randInt(3, 10) * 60_000).toISOString(), error: null });
        return;
      }
      const phase: "reactions" | "comments" = st.phase === "comments" ? "comments" : "reactions";
      const page = await searchBudgeted(sender.id, day, () => phase === "reactions"
        ? sources.postReactions(sender.unipile_account_id, st.social_id, { cursor: job.cursor ?? undefined })
        : sources.postComments(sender.unipile_account_id, st.social_id, { cursor: job.cursor ?? undefined }));
      const items = page.items.map((x) => engagementAuthorToItem(x, phase === "reactions" ? "reacted" : "commented")).filter(Boolean) as Row[];
      const { created, updated } = await upsertLeadsFromItems(job, items, "post_engagement");
      const fetched = (job.fetched ?? 0) + page.items.length;
      const maxed = fetched >= Number(p.max_results ?? 5000);
      let cursor: string | null = page.cursor;
      let done = false;
      if (!cursor || page.items.length === 0 || maxed) {
        const next = include[include.indexOf(phase) + 1];
        if (next && !maxed) { st.phase = next; cursor = null; } else done = true;
      }
      const patch: Row = { fetched, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated, cursor: done ? null : cursor, capped: maxed, params: withState(job, st) };
      if (done) await finishJob(job, patch); else await updateJob(job, { ...patch, status: "running", next_run_at: nextPageAt(), error: null });
      return;
    }

    if (job.kind === "company_people") {
      // The slowest source: per company one lookup (unless an id was given) plus up to 3 classic pages of 10, each a paced, budgeted call.
      const companies: Row[] = Array.isArray(p.companies) ? p.companies : [];
      const perCompany = Math.max(1, Math.min(25, Number(p.per_company ?? 10)));
      const titles: string[] = Array.isArray(p.title_keywords) ? p.title_keywords.map(String) : [];
      const idx = Number(st.idx ?? 0);
      if (idx >= companies.length) { await finishJob(job, { params: withState(job, st) }); return; }
      const c = companies[idx];
      const advance = () => { st.idx = idx + 1; st.company_id = null; st.company_name = null; st.got = 0; };
      if (!st.company_id) {
        const needsCall = !(c.company_id && /^\d+$/.test(String(c.company_id))) && !/^\d+$/.test(String(companyIdentFromUrl(c.linkedin_url ?? "") ?? ""));
        const found = needsCall ? await searchBudgeted(sender.id, day, () => sources.resolveCompany(sender.unipile_account_id, c)) : await sources.resolveCompany(sender.unipile_account_id, c);
        if (!found) { st.not_found = [...(st.not_found ?? []), c.name ?? c.linkedin_url ?? c.company_id ?? `#${idx + 1}`].slice(-50); advance(); }
        else { st.company_id = found.id; st.company_name = found.name ?? c.name ?? null; st.got = 0; }
        if (needsCall || !found) {
          const finished = !found && idx + 1 >= companies.length;
          if (finished) { await finishJob(job, { params: withState(job, st), cursor: null, next_offset: idx + 1 }); return; }
          await updateJob(job, { status: "running", params: withState(job, st), cursor: null, next_offset: Number(st.idx ?? idx), next_run_at: new Date(Date.now() + randInt(5, 15) * 60_000).toISOString(), error: null });
          return;
        }
      }
      const res: Row = await searchBudgeted(sender.id, day, () => sources.searchCompanyPeople(sender.unipile_account_id, String(st.company_id), titles, { cursor: job.cursor ?? undefined }));
      const room = perCompany - Number(st.got ?? 0);
      const items: Row[] = (res.items ?? []).slice(0, Math.max(0, room)).map((it: Row) => ({ ...it, _company: st.company_name, _custom: { source_company: st.company_name, source_company_id: st.company_id } }));
      const { created, updated } = await upsertLeadsFromItems(job, items, "company_people");
      st.got = Number(st.got ?? 0) + items.length;
      let cursor: string | null = res.cursor ?? null;
      if (!cursor || !(res.items ?? []).length || st.got >= perCompany) { advance(); cursor = null; }
      const done = Number(st.idx ?? idx) >= companies.length;
      const patch: Row = { fetched: (job.fetched ?? 0) + items.length, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated, cursor, next_offset: Number(st.idx ?? idx), params: withState(job, st) };
      if (done) await finishJob(job, patch); else await updateJob(job, { ...patch, status: "running", next_run_at: nextPageAt(), error: null });
      return;
    }
  } catch (e) {
    if (e instanceof NoBudget) {
      await updateJob(job, { status: "running", next_run_at: new Date(Date.now() + 3 * 3600_000).toISOString(), error: null });
      return;
    }
    const ex = explainImportError(e, job);
    const st = stateOf(job);
    st.errors = Number(st.errors ?? 0) + 1;
    // six failed attempts in a row is a failure, not a delay: say so instead of retrying quietly forever
    const fatal = ex.fatal || st.errors >= 6;
    const message = !ex.fatal && fatal ? `${ex.message} Stopped after ${st.errors} attempts.` : ex.message;
    log({ fn: "imports", job: job.id, kind: job.kind, error: e instanceof UnipileError ? `${e.status}:${e.code} ${e.message}` : String((e as any)?.message ?? e), fatal });
    await updateJob(job, { status: fatal ? "failed" : "running", error: message, params: withState(job, st), next_run_at: fatal ? null : new Date(Date.now() + 60 * 60_000).toISOString(), finished_at: fatal ? new Date().toISOString() : null });
  }
}

async function runCsvImport(job: Row): Promise<void> {
  const p = job.params ?? {};
  const path = p.storage_path as string;
  const mapping = (p.mapping ?? {}) as Record<string, string>; // csv column → lead field
  if (!path) throw new ImportFatal("This CSV import has no file attached. Upload the file again.");
  const { data: file, error } = await admin.storage.from("outreach-imports").download(path);
  if (error || !file) throw new ImportFatal(`The uploaded CSV file could not be read (${error?.message ?? "file missing"}). Upload it again.`);
  const text = await file.text();
  const rows = parseCsv(text);
  if (!rows.length) { await finishJob(job, { total_expected: 0 }); return; }
  const header = rows[0];
  const fieldIdx: Record<string, number> = {};
  header.forEach((h, i) => { const f = mapping[h] ?? mapping[h.trim()]; if (f) fieldIdx[f] = i; });
  const updateOnly = job.mode === "update_only";
  const hasKey = ["public_identifier", "linkedin_url", "email_work", "email_personal", "email"].some((f) => f in fieldIdx);
  if (!hasKey) throw new ImportFatal("None of the mapped columns exist in this file. Map the LinkedIn URL or the email column and start again.");
  const allowed: string[] = (job.update_fields ?? []).map(String);
  if (updateOnly && !allowed.length) throw new ImportFatal("Update mode needs at least one column to update. Choose the columns and start again.");
  let created = 0, updated = 0, fetched = 0, notFound = 0, rowErrors = 0;
  let firstError: string | null = null;
  const start = job.next_offset ?? 0;
  for (let i = 1 + start; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((c) => !c)) continue;
    const lead: Row = { client_id: job.client_id, list_id: job.list_id, custom: {} };
    const flat: Record<string, string> = {};   // update mode: field → value, custom fields keep their "custom." prefix
    for (const [field, idx] of Object.entries(fieldIdx)) {
      const v = (r[idx] ?? "").trim();
      if (!v) continue;
      if (field.startsWith("custom.")) { lead.custom[field.slice(7)] = v; flat[field] = v; }
      else if (field === "linkedin_url" || field === "public_identifier") lead.public_identifier = inboundInternal.pubIdFromUrl(v) ?? v.replace(/^in\//, "").toLowerCase();
      else { lead[field] = v; flat[field] = v; }
    }
    const email = lead.email_work ?? lead.email_personal ?? lead.email ?? null;
    if (lead.public_identifier || email) {
      try {
        if (updateOnly) {
          // match on LinkedIn URL or email and change ONLY the chosen columns; never creates a lead, never blanks a field
          const ok = await rpc<boolean>("update_lead_fields", { p_ws: job.workspace_id, p_match: { public_identifier: lead.public_identifier ?? null, email }, p_fields: flat, p_allowed: allowed });
          if (ok) updated++; else notFound++;
        } else {
          const res = await rpc<any>("upsert_lead", { p_ws: job.workspace_id, p_lead: lead, p_source: "csv", p_import_job: job.id });
          const row = Array.isArray(res) ? res[0] : res;
          if (row?.created) created++; else updated++;
          if (row?.id && job.tag_ids?.length) await admin.from("outreach_lead_tags").upsert(job.tag_ids.map((t: string) => ({ lead_id: row.id, tag_id: t })), { onConflict: "lead_id,tag_id", ignoreDuplicates: true });
        }
      } catch (e) { rowErrors++; firstError = firstError ?? String((e as any)?.message ?? e).slice(0, 160); log({ fn: "csv", warn: String(e) }); }
    }
    fetched++;
    if (fetched % 500 === 0) await updateJob(job, { fetched: (job.fetched ?? 0) + fetched, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated, next_offset: i, status: "running" });
  }
  const st = stateOf(job);
  if (updateOnly) { st.updated = Number(st.updated ?? 0) + updated; st.not_found = Number(st.not_found ?? 0) + notFound; }
  if (rowErrors) { st.row_errors = Number(st.row_errors ?? 0) + rowErrors; st.first_row_error = st.first_row_error ?? firstError; }
  if (fetched > 0 && rowErrors === fetched) throw new ImportFatal(`No row of this file could be imported. First error: ${firstError ?? "unknown"}`);
  await finishJob(job, { fetched: (job.fetched ?? 0) + fetched, created_leads: (job.created_leads ?? 0) + created, updated_leads: (job.updated_leads ?? 0) + updated, total_expected: rows.length - 1, params: withState(job, st) });
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

export async function runImports(): Promise<Row> {
  const { data: jobs } = await admin.from("outreach_import_jobs").select("*").in("status", ["queued", "running"]).lte("next_run_at", new Date().toISOString()).order("next_run_at").limit(20);
  let ran = 0;
  for (const j of jobs ?? []) { await runImportJob(j); ran++; }
  return { ran };
}

// ---------------------------------------------------------------------------
// F8 withdraw stale invites
// ---------------------------------------------------------------------------
export async function runWithdraw(): Promise<Row> {
  const { data: senders } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).eq("provider", "LINKEDIN");
  let queued = 0;
  for (const s of senders ?? []) {
    const lp = localParts(s.timezone ?? "UTC");
    if (lp.hour < 10 || lp.hour >= 16) continue;
    const day = lp.date;
    const { data: plan } = await admin.from("outreach_plans").select("sender_id").eq("sender_id", s.id).eq("day", day).eq("kind", "withdraw").maybeSingle();
    if (plan) continue;
    // random slot in the hour: only proceed with 1/6 probability per hourly run inside the window (≈ one run per day)
    if (Math.random() > 0.35 && lp.hour < 15) continue;
    await admin.from("outreach_plans").upsert({ sender_id: s.id, day, kind: "withdraw", actions: 0 }, { onConflict: "sender_id,day,kind" });
    const { data: seqs } = await admin.from("outreach_sequences").select("id, settings").eq("workspace_id", s.workspace_id).contains("sender_pool", [s.id]);
    const days = Math.min(...(seqs ?? []).map((q) => Number(q.settings?.withdraw_after_days ?? 21)), 21);
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    const { data: stale } = await admin.from("outreach_lead_sender_state").select("lead_id, invitation_id").eq("sender_id", s.id).eq("relation", "pending_out").lt("invite_sent_at", cutoff).not("invitation_id", "is", null).limit(50);
    const budgets = await rpc<Row[]>("plan_budgets", { p_sender: s.id, p_day: day });
    const cap = Math.min(budgets.find((b) => b.action_type === "withdraw")?.cap ?? 0, Number(s.manual_caps?.withdraw ?? 10));
    const windows = await rpc<Row[]>("schedule_windows", { p_sender: s.id, p_day: day });
    if (!windows?.length) continue;
    const end = Math.max(...windows.map((w) => new Date(w.end_at).getTime()));
    let n = 0;
    for (const st of stale ?? []) {
      if (n >= cap) break;
      const { data: live } = await admin.from("outreach_enrollments").select("id").eq("lead_id", st.lead_id).eq("sender_id", s.id).in("status", ["waiting_connection"]).maybeSingle();
      if (live) continue;
      const at = Date.now() + rand(10, Math.max(11, (end - Date.now()) / 60_000)) * 60_000;
      await rpc("queue_action", { p_enrollment: null, p_node_id: null, p_type: "withdraw", p_scheduled_for: new Date(Math.min(at, end)).toISOString(), p_payload: { auto_withdraw: true }, p_sender: s.id, p_lead: st.lead_id, p_workspace: s.workspace_id });
      n++; queued++;
    }
    await admin.from("outreach_plans").update({ actions: n }).eq("sender_id", s.id).eq("day", day).eq("kind", "withdraw");
  }
  return { queued };
}

// ---------------------------------------------------------------------------
// F9 relations poll (no-note invites): ≤3/day at random offsets
// ---------------------------------------------------------------------------
export async function runRelationsPoll(): Promise<Row> {
  const { data: senders } = await admin.from("outreach_senders").select("*").eq("status", "ok").is("deleted_at", null).eq("provider", "LINKEDIN");
  let polled = 0;
  for (const s of senders ?? []) {
    const { count } = await admin.from("outreach_lead_sender_state").select("lead_id", { count: "exact", head: true }).eq("sender_id", s.id).eq("relation", "pending_out").eq("invite_had_note", false);
    if (!count) continue;
    const lp = localParts(s.timezone ?? "UTC");
    const day = lp.date;
    let { data: plan } = await admin.from("outreach_poll_plan").select("*").eq("sender_id", s.id).eq("day", day).maybeSingle();
    if (!plan) {
      const windows = await rpc<Row[]>("schedule_windows", { p_sender: s.id, p_day: day });
      if (!windows?.length) continue;
      const times: string[] = [];
      for (let i = 0; i < 3; i++) {
        const w = windows[randInt(0, windows.length - 1)];
        const st = new Date(w.start_at).getTime() + 30 * 60_000, en = new Date(w.end_at).getTime() - 30 * 60_000;
        if (en > st) times.push(new Date(st + rand(0, en - st)).toISOString());
      }
      times.sort();
      const { data: p } = await admin.from("outreach_poll_plan").insert({ sender_id: s.id, day, times }).select("*").single();
      plan = p;
    }
    if (!plan) continue;
    const due = (plan.times ?? []).filter((t: string) => new Date(t).getTime() <= Date.now()).length;
    if (due <= (plan.done ?? 0)) continue;
    const dayStr = await rpc<string>("sender_local_date", { p_sender: s.id, p_at: new Date().toISOString() });
    const ok = await rpc<boolean>("reserve_budget", { p_sender: s.id, p_day: dayStr, p_type: "relations_poll" });
    if (!ok) continue;
    try {
      const sent = await unipile.users.invitationsSent(s.unipile_account_id, undefined, 100);
      await rpc("consume_budget", { p_sender: s.id, p_day: dayStr, p_type: "relations_poll" });
      const pendingIds = new Set((sent.items ?? []).map((i: Row) => i.invited_user_id ?? i.invited_user_public_id).filter(Boolean).map(String));
      const pendingPubs = new Set((sent.items ?? []).map((i: Row) => i.invited_user_public_id).filter(Boolean).map((x: string) => x.toLowerCase()));
      const { data: ours } = await admin.from("outreach_lead_sender_state").select("lead_id, outreach_leads(provider_id, public_identifier)").eq("sender_id", s.id).eq("relation", "pending_out").eq("invite_had_note", false).limit(200);
      for (const o of ours ?? []) {
        const l = (o as any).outreach_leads;
        if (!l) continue;
        const stillPending = (l.provider_id && pendingIds.has(l.provider_id)) || (l.public_identifier && pendingPubs.has(String(l.public_identifier).toLowerCase()));
        if (stillPending) continue;
        // absent → verify via profile fetch (profile_view budget)
        const pv = await rpc<boolean>("reserve_budget", { p_sender: s.id, p_day: dayStr, p_type: "profile_view" });
        if (!pv) break;
        try {
          const prof = await unipile.users.profile(s.unipile_account_id, l.provider_id ?? l.public_identifier, { linkedin_sections: "*_preview" });
          await rpc("consume_budget", { p_sender: s.id, p_day: dayStr, p_type: "profile_view" });
          const rel = distanceToRelation(prof.network_distance);
          const now = new Date().toISOString();
          if (rel === "first") await admin.from("outreach_lead_sender_state").update({ relation: "first", invite_accepted_at: now, invite_detected_at: now, updated_at: now }).eq("lead_id", o.lead_id).eq("sender_id", s.id);
          else if (!invitationPending(prof)) await admin.from("outreach_lead_sender_state").update({ relation: "none", invite_withdrawn_at: now, updated_at: now }).eq("lead_id", o.lead_id).eq("sender_id", s.id);
          await admin.from("outreach_leads").update({ last_profile_fetch_at: now, provider_id: prof.provider_id ?? l.provider_id }).eq("id", o.lead_id);
        } catch (e) { await rpc("release_budget", { p_sender: s.id, p_day: dayStr, p_type: "profile_view" }); log({ fn: "relations-poll", warn: String(e) }); }
      }
      polled++;
    } catch (e) {
      await rpc("release_budget", { p_sender: s.id, p_day: dayStr, p_type: "relations_poll" });
      log({ fn: "relations-poll", error: String(e) });
    }
    await admin.from("outreach_poll_plan").update({ done: (plan.done ?? 0) + 1 }).eq("sender_id", s.id).eq("day", day);
  }
  return { polled };
}

// ---------------------------------------------------------------------------
// F23 outbound webhooks
// ---------------------------------------------------------------------------
export async function runOutboundWebhooks(): Promise<Row> {
  const { data: rows } = await admin.from("outreach_outbound_webhook_deliveries").select("*, outreach_outbound_webhooks(url, secret, active, failures)").is("delivered_at", null).lte("next_at", new Date().toISOString()).lt("attempts", 5).order("next_at").limit(50);
  let delivered = 0, failed = 0;
  for (const d of rows ?? []) {
    const wh = (d as any).outreach_outbound_webhooks;
    if (!wh || !wh.active) { await admin.from("outreach_outbound_webhook_deliveries").update({ attempts: 5, last_error: "webhook inactive" }).eq("id", d.id); continue; }
    const body = JSON.stringify(d.payload ?? {});
    const sig = await hmacSha256Hex(wh.secret, body);
    let status = 0, err: string | null = null;
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(wh.url, { method: "POST", headers: { "content-type": "application/json", "x-signature": sig, "x-event": d.event ?? "", "x-delivery-id": String(d.id) }, body, signal: ctrl.signal });
      clearTimeout(t);
      status = res.status;
      if (!res.ok) err = `http ${res.status}`;
    } catch (e) { err = String((e as any)?.message ?? e); }
    if (!err) {
      delivered++;
      await admin.from("outreach_outbound_webhook_deliveries").update({ status, delivered_at: new Date().toISOString(), attempts: d.attempts + 1 }).eq("id", d.id);
      if (wh.failures > 0) await admin.from("outreach_outbound_webhooks").update({ failures: 0 }).eq("id", d.webhook_id);
    } else {
      failed++;
      const attempts = d.attempts + 1;
      const backoff = Math.min(60 * 2 ** attempts, 3600) * 1000;
      await admin.from("outreach_outbound_webhook_deliveries").update({ status, attempts, last_error: err, next_at: new Date(Date.now() + backoff).toISOString() }).eq("id", d.id);
      const failures = (wh.failures ?? 0) + 1;
      await admin.from("outreach_outbound_webhooks").update({ failures, active: failures < 50 }).eq("id", d.webhook_id);
    }
  }
  return { delivered, failed };
}

// ---------------------------------------------------------------------------
// F18 classify
// ---------------------------------------------------------------------------
export async function runClassify(limit = 20): Promise<Row> {
  const { data: q, error: qErr } = await admin.from("outreach_ai_classify_queue").select("*").lt("attempts", 3).or(`locked_at.is.null,locked_at.lt.${new Date(Date.now() - 5 * 60_000).toISOString()}`).order("id").limit(limit);
  if (qErr) return { done: 0, failed: 0, errors: [`queue read: ${qErr.message}`] };
  let done = 0, failed = 0;
  const errors: string[] = [];
  const started = Date.now();
  const queue = [...(q ?? [])];
  // Classification is a network-bound LLM call; run a few in parallel so the 15s cron keeps up with bursts.
  const runOne = async (item: Row): Promise<void> => {
    await admin.from("outreach_ai_classify_queue").update({ locked_at: new Date().toISOString(), attempts: item.attempts + 1 }).eq("id", item.id);
    try {
      const { data: msg } = await admin.from("outreach_messages").select("*, outreach_chats(*)").eq("id", item.message_id).single();
      if (!msg || msg.direction !== "in") { await admin.from("outreach_ai_classify_queue").delete().eq("id", item.id); return; }
      const chat = (msg as any).outreach_chats;
      const { data: prev } = await admin.from("outreach_messages").select("text").eq("chat_id", msg.chat_id).eq("direction", "out").lt("sent_at", msg.sent_at).order("sent_at", { ascending: false }).limit(3);
      let brief: string | null = null;
      if (chat?.lead_id) {
        const { data: enr } = await admin.from("outreach_enrollments").select("outreach_sequences(brief, name)").eq("lead_id", chat.lead_id).eq("sender_id", chat.sender_id).order("created_at", { ascending: false }).limit(1).maybeSingle();
        brief = (enr as any)?.outreach_sequences?.brief ?? (enr as any)?.outreach_sequences?.name ?? null;
      }
      let result: { intent: string; confidence: number; summary: string; return_date?: string | null };
      if (aiConfigured() && (msg.text ?? "").trim()) {
        // sentAt lets the classifier turn "back on Monday" into a date (item 1: an out-of-office resumes on the return date).
        const input = { workspaceId: msg.workspace_id, text: msg.text ?? "", previousOutbound: (prev ?? []).map((p) => p.text ?? "").filter(Boolean).reverse(), brief, channel: chat?.provider ?? "LINKEDIN", sentAt: msg.sent_at as string | null };
        result = await classifyMessage(input);
      } else {
        result = { intent: "unclear", confidence: 0, summary: (msg.text ?? "").slice(0, 140) };
      }
      await admin.from("outreach_messages").update({ intent: result.intent, intent_confidence: result.confidence, summary: result.summary, classified_at: new Date().toISOString() }).eq("id", msg.id);
      await admin.from("outreach_chats").update({ intent: result.intent }).eq("id", msg.chat_id);
      // Consequences live in the database: re-open out-of-office exits, stage interested leads, record the milestone.
      const returnDate = /^\d{4}-\d{2}-\d{2}/.test(String(result.return_date ?? "")) ? String(result.return_date).slice(0, 10) : null;
      let consequences: unknown = null;
      try { consequences = await rpc("apply_reply_intent", { p_message: msg.id, p_intent: result.intent, p_return_date: returnDate }); }
      catch (e) { log({ fn: "classify", warn: "apply_reply_intent failed", message_id: msg.id, error: String((e as any)?.message ?? e) }); }
      // `ooo` never creates a follow-up task: the sequence resumes on its own.
      if (["interested", "question"].includes(result.intent) && chat) {
        const { data: existing } = await admin.from("outreach_tasks").select("id").eq("chat_id", chat.id).eq("kind", "follow_up").is("completed_at", null).maybeSingle();
        if (!existing) {
          await admin.from("outreach_tasks").insert({
            workspace_id: msg.workspace_id, client_id: chat.client_id, kind: "follow_up", lead_id: chat.lead_id, sender_id: chat.sender_id, chat_id: chat.id,
            title: `${result.intent === "interested" ? "Interested" : "Question"}: ${chat.attendee_name ?? "lead"}`, body: result.summary, assigned_to: chat.assigned_to, due_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
          });
        }
      }
      await emitEvent(msg.workspace_id, "message.classified", { id: msg.id, chat_id: msg.chat_id, lead_id: chat?.lead_id ?? null, intent: result.intent, confidence: result.confidence, summary: result.summary, return_date: returnDate, consequences });
      await admin.from("outreach_ai_classify_queue").delete().eq("id", item.id);
      done++;
    } catch (e) {
      failed++;
      const msg = String((e as any)?.message ?? e);
      if (errors.length < 3) errors.push(msg.slice(0, 300));
      log({ fn: "classify", error: msg, message_id: item.message_id });
      if (item.attempts + 1 >= 3) await admin.from("outreach_ai_classify_queue").delete().eq("id", item.id);
    }
  };
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (queue.length && Date.now() - started < 40_000) await runOne(queue.shift()!);
  }));
  return errors.length ? { done, failed, errors } : { done, failed };
}

// ---------------------------------------------------------------------------
// F25 billing sync (usage → Stripe quantity)
// ---------------------------------------------------------------------------
const STRIPE_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

export async function stripeRequest(method: string, path: string, params?: Record<string, string>): Promise<any> {
  if (!STRIPE_KEY) throw new Error("STRIPE_SECRET_KEY not set");
  const res = await fetch(`https://api.stripe.com/v1${path}`, { method, headers: { authorization: `Bearer ${STRIPE_KEY}`, "content-type": "application/x-www-form-urlencoded" }, body: params ? new URLSearchParams(params).toString() : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `stripe ${res.status}`);
  return data;
}

export async function runBillingSync(): Promise<Row> {
  const today = new Date().toISOString().slice(0, 10);
  const { data: workspaces } = await admin.from("outreach_workspaces").select("id, plan, settings, stripe_subscription_id, stripe_status, past_due_since, trial_ends_at").is("deleted_at", null);
  let synced = 0, suspended = 0;
  for (const w of workspaces ?? []) {
    const { data: senders } = await admin.from("outreach_senders").select("provider, status").eq("workspace_id", w.id).is("deleted_at", null).neq("status", "disabled");
    const li = (senders ?? []).filter((s) => s.provider === "LINKEDIN").length;
    const mb = (senders ?? []).length - li;
    await admin.from("outreach_billing_usage").upsert({ workspace_id: w.id, day: today, active_senders: li, active_mailboxes: mb }, { onConflict: "workspace_id,day" });
    // Billing enforcement only runs when Stripe is configured; otherwise usage is recorded but nothing is suspended.
    if (!STRIPE_KEY) continue;
    // past-due → suspend after 7 days (senders paused, not deleted)
    if (w.stripe_status === "past_due" && w.past_due_since && Date.now() - new Date(w.past_due_since).getTime() > 7 * 86400_000 && w.plan !== "suspended") {
      // remember the plan so outreach_resume_after_billing can put it back when the payment recovers
      await admin.from("outreach_workspaces").update({ plan: "suspended", settings: { ...(w.settings ?? {}), ...(w.plan && w.plan !== "trial" ? { plan_before_suspension: w.plan } : {}) } }).eq("id", w.id);
      await admin.from("outreach_senders").update({ status: "paused", status_reason: "billing_suspended" }).eq("workspace_id", w.id).eq("status", "ok");
      await audit(w.id, "workspace.suspended", "workspace", w.id, { reason: "past_due_7d" });
      suspended++;
    }
    // trial expiry: pause senders beyond trial (no card): mark suspended-lite? keep read-only via plan
    if (w.plan === "trial" && w.trial_ends_at && new Date(w.trial_ends_at).getTime() < Date.now() && !w.stripe_subscription_id) {
      await admin.from("outreach_workspaces").update({ plan: "suspended" }).eq("id", w.id);
      await admin.from("outreach_senders").update({ status: "paused", status_reason: "trial_expired" }).eq("workspace_id", w.id).eq("status", "ok");
      await audit(w.id, "workspace.trial_expired", "workspace", w.id);
      suspended++;
    }
    if (w.stripe_subscription_id && STRIPE_KEY) {
      try {
        // peak active senders in the current period
        const sub = await stripeRequest("GET", `/subscriptions/${w.stripe_subscription_id}`);
        const start = new Date((sub.current_period_start ?? 0) * 1000).toISOString().slice(0, 10);
        const { data: usage } = await admin.from("outreach_billing_usage").select("active_senders, active_mailboxes").eq("workspace_id", w.id).gte("day", start);
        const peak = Math.max(0, ...(usage ?? []).map((u) => u.active_senders));
        const peakMb = Math.max(0, ...(usage ?? []).map((u) => u.active_mailboxes));
        for (const item of sub.items?.data ?? []) {
          const lookup = item.price?.lookup_key ?? item.price?.nickname ?? "";
          const qty = /mailbox/i.test(lookup) ? peakMb : peak;
          if (item.quantity !== qty) await stripeRequest("POST", `/subscription_items/${item.id}`, { quantity: String(qty), proration_behavior: "none" });
        }
        synced++;
      } catch (e) { log({ fn: "billing", workspace: w.id, error: String(e) }); }
    }
  }
  return { synced, suspended };
}
