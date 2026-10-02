// Profile enrichment helpers (item 13), shared by the executor (free path: the fetch a step already makes) and
// outreach-worker-enrich (budgeted path: leftover profile views). Every LinkedIn call here sits behind a database budget.
import { admin, log, rpc, localParts, zonedToUtc, addDays, randInt } from "./supabase.ts";
import { unipile, unipileRequest, UnipileError, FULL_PROFILE_SECTIONS, PREVIEW_SECTIONS } from "./unipile.ts";

type Row = Record<string, any>;

/** True while LinkedIn is throttling this sender's full-section requests (two all-empty answers in a row → 6 hours). */
export function enrichBackoff(sender: Row): boolean {
  return !!sender?.enrich_backoff_until && new Date(sender.enrich_backoff_until).getTime() > Date.now();
}

/** Sections to ask for on any profile fetch: the named full sections we store, or previews while the sender is backed off. */
export function sectionsFor(sender: Row): { query: string | string[]; full: boolean; requested: string[] } {
  if (enrichBackoff(sender)) return { query: PREVIEW_SECTIONS, full: false, requested: [] };
  return { query: [...FULL_PROFILE_SECTIONS], full: true, requested: [...FULL_PROFILE_SECTIONS] };
}

/** Unipile dates come as "M/D/YYYY", "YYYY-MM-DD", "M/YYYY", "YYYY" or an ISO timestamp. Returns YYYY-MM-DD or null. */
export function toIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const pad = (n: string | number) => String(n).padStart(2, "0");
  const ok = (y: number, m: number, d: number) => (y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null);
  let m = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);
  if (m) return ok(+m[1], +m[2], +(m[3] ?? 1));
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ok(+m[3], +m[1], +m[2]);
  m = /^(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return ok(+m[2], +m[1], 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return ok(+m[1], 1, 1);
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

const clip = (v: unknown, n: number): string | null => { const s = String(v ?? "").trim(); return s ? s.slice(0, n) : null; };
const num = (v: unknown): number | null => { const n = Number(v); return v === null || v === undefined || v === "" || !isFinite(n) ? null : Math.trunc(n); };

/**
 * Map a Unipile LinkedIn profile to the p_profile shape of outreach_save_lead_profile (014):
 *   {about, current_title, current_company, current_started_on, experience[], education[], skills[], languages[],
 *    profile_language, follower_count, connections_count, requested_sections[]}
 * A section we asked for and got back empty is passed as EMPTY ("" / []): the SQL reads that as "unknown, try again later"
 * (LinkedIn throttles full sections silently) and never lets it overwrite stored data.
 */
export function profileToEnrichment(prof: Row, requestedSections: readonly string[]): Row {
  const work: Row[] = Array.isArray(prof?.work_experience) ? prof.work_experience : [];
  const experience = work.map((w) => {
    const end = toIsoDate(w.end);
    return {
      company: clip(w.company, 200), title: clip(w.position, 200), company_id: w.company_id ?? null,
      start: toIsoDate(w.start), end, current: typeof w.current === "boolean" ? w.current : !end && !!toIsoDate(w.start),
      location: clip(w.location, 200), description: clip(w.description, 600),
    };
  }).filter((w) => w.company || w.title);
  const current = experience.find((w) => w.current) ?? null;
  const education = (Array.isArray(prof?.education) ? prof.education as Row[] : []).map((e) => ({
    school: clip(e.school, 200), degree: clip(e.degree, 200), field: clip(e.field_of_study, 200), start: toIsoDate(e.start), end: toIsoDate(e.end),
  })).filter((e) => e.school);
  const names = (list: unknown): string[] => (Array.isArray(list) ? list : []).map((x: any) => clip(typeof x === "string" ? x : x?.name, 120)).filter((x): x is string => !!x);
  return {
    about: clip(prof?.summary, 4000) ?? "",
    current_title: current?.title ?? null,
    current_company: current?.company ?? null,
    current_started_on: current?.start ?? null,
    experience, education,
    skills: [...new Set(names(prof?.skills))].slice(0, 50),
    languages: [...new Set(names(prof?.languages))].slice(0, 20),
    profile_language: clip(prof?.primary_locale?.language, 20),
    follower_count: num(prof?.follower_count),
    connections_count: num(prof?.connections_count),
    linkedin: profileFacts(prof),
    requested_sections: [...requestedSections],
  };
}

const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const strs = (list: unknown, n: number, max = 10): string[] | null => {
  const out = (Array.isArray(list) ? list : []).map((x) => clip(x, n)).filter((x): x is string => !!x).slice(0, max);
  return out.length ? out : null;
};

/**
 * The top-level facts of a Unipile LinkedIn profile (033 `linkedin` column). Null means "not in this answer" and never
 * replaces a stored value. network_distance, shared_connections_count, can_send_inmail and connected_at are the fetching sender's view.
 */
export function profileFacts(prof: Row): Row {
  const ci = prof?.contact_info ?? {};
  const bd = prof?.birthdate;
  const cw = prof?.creator_website;
  const connectedAt = num(prof?.connected_at);
  const socials = (Array.isArray(ci.socials) ? ci.socials as Row[] : []).map((s) => ({ type: clip(s?.type, 40), name: clip(s?.name, 200) })).filter((s) => s.name).slice(0, 10);
  return {
    is_open_profile: bool(prof?.is_open_profile), is_premium: bool(prof?.is_premium), can_send_inmail: bool(prof?.can_send_inmail),
    is_open_to_work: bool(prof?.is_open_to_work), is_hiring: bool(prof?.is_hiring), is_creator: bool(prof?.is_creator), is_influencer: bool(prof?.is_influencer),
    network_distance: clip(prof?.network_distance, 20), shared_connections_count: num(prof?.shared_connections_count),
    connected_at: connectedAt ? new Date(connectedAt).toISOString() : null,
    websites: strs(prof?.websites, 300), hashtags: strs(prof?.hashtags, 80, 20),
    creator_website: cw?.url ? { url: clip(cw.url, 300), description: clip(cw.description, 200) } : null,
    emails: strs(ci.emails, 200)?.map((e) => e.toLowerCase()) ?? null, phones: strs(ci.phones, 40), addresses: strs(ci.adresses ?? ci.addresses, 300, 5),
    socials: socials.length ? socials : null,
    birthdate: bd && (num(bd.month) || num(bd.day)) ? { month: num(bd.month), day: num(bd.day) } : null,
    country: clip(prof?.primary_locale?.country, 10), pronoun: clip(prof?.pronoun, 40),
    // {{ sn_id }} (067 reads linkedin->>'sales_navigator_id'): only a Sales Navigator fetch carries it; empty until then
    sales_navigator_id: clip(prof?.sales_navigator_id ?? prof?.sales_navigator?.id, 80),
  };
}

// ---------------------------------------------------------------------------
// The lead's current company (migration 067, outreach_companies): the Account variables of a message
// ---------------------------------------------------------------------------
const txt = (v: unknown, n: number): string | undefined => (typeof v === "string" || typeof v === "number" ? clip(v, n) ?? undefined : undefined);
const firstText = (n: number, ...vals: unknown[]): string | undefined => { for (const v of vals) { const s = txt(v, n); if (s) return s; } return undefined; };
/** Hosts that are a page on someone else's site, not the company's own domain. */
const NOT_A_COMPANY_DOMAIN = /(^|\.)(linkedin\.com|facebook\.com|instagram\.com|twitter\.com|x\.com|youtube\.com|linktr\.ee|bit\.ly|t\.me|wa\.me|google\.com)$/;

function domainOf(website: string | undefined): string | undefined {
  if (!website) return undefined;
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(website) ? website : `https://${website}`).hostname.toLowerCase().replace(/^www\./, "");
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) && !NOT_A_COMPANY_DOMAIN.test(host) ? host : undefined;
  } catch { return undefined; }
}

/** {from: 51, to: 200} → "51-200"; {from: 10001} → "10001+"; a range already written as text is kept. */
function sizeOf(range: unknown): string | undefined {
  if (typeof range === "string") return txt(range, 40);
  const from = num((range as Row)?.from ?? (range as Row)?.start), to = num((range as Row)?.to ?? (range as Row)?.end);
  if (from === null && to === null) return undefined;
  if (from !== null && to !== null && to >= from) return `${from}-${to}`;
  return from !== null ? `${from}+` : `1-${to}`;
}

function yearOf(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    const m = /(?:^|\D)((?:1[5-9]|20)\d{2})(?:\D|$)/.exec(typeof v === "object" && v !== null ? String((v as Row).year ?? "") : String(v ?? ""));
    if (m) return Number(m[1]);
  }
  return undefined;
}

/** Strings from a list of strings or of {title | name | value} objects, trimmed, without doubles. */
function labels(list: unknown, n: number, max: number): string[] | undefined {
  const out = (Array.isArray(list) ? list : []).map((x) => txt(typeof x === "object" && x !== null ? (x as Row).title ?? (x as Row).name ?? (x as Row).value : x, n)).filter((x): x is string => !!x);
  const uniq = [...new Set(out)].slice(0, max);
  return uniq.length ? uniq : undefined;
}

/**
 * Map a LinkedIn company profile (GET /linkedin/company/{id}) to the p of outreach_company_save:
 *   {linkedin_id, public_identifier, name, domain, website, phone, industry, size, employees_on_linkedin, founded_year,
 *    tagline, about, specialties[], hashtags[], followers, hq: {city, region, country, address}}
 * A field the answer does not carry stays undefined, and SQL then keeps what is stored.
 * Written from the documented shape of the answer, not from a captured one: every field is read defensively.
 */
export function companyFacts(p: Row): Row {
  const id = [p?.id, p?.provider_id, typeof p?.entity_urn === "string" ? p.entity_urn.split(":").pop() : null].map((x) => String(x ?? "").trim()).find((x) => /^\d+$/.test(x));
  const slug = firstText(200, p?.public_identifier, /linkedin\.com\/company\/([^/?#]+)/i.exec(String(p?.profile_url ?? ""))?.[1]);
  const website = firstText(500, p?.website, p?.website_url);
  const industry = Array.isArray(p?.industry) ? firstText(200, ...p.industry) : txt(p?.industry, 200);
  const locations: Row[] = (Array.isArray(p?.locations) ? p.locations : []).filter((l: unknown) => l && typeof l === "object");
  const loc = locations.find((l) => l.is_headquarter === true || l.is_headquarters === true || l.headquarter === true) ?? locations[0];
  let hq: Row | undefined;
  if (loc) {
    const street = Array.isArray(loc.street) ? loc.street.map((s: unknown) => txt(s, 200)).filter(Boolean).join(", ") : txt(loc.street, 200);
    const city = txt(loc.city, 200), region = firstText(200, loc.area, loc.geographic_area, loc.region, loc.state), country = txt(loc.country, 200);
    const address = [street, city, region, firstText(40, loc.postalCode, loc.postal_code), country].filter(Boolean).join(", ").slice(0, 500);
    if (city || region || country || address) hq = { city, region, country, address: address || undefined };
  }
  return {
    linkedin_id: id, public_identifier: slug ? slug.toLowerCase() : undefined,
    name: firstText(300, p?.name, p?.localized_name),
    domain: domainOf(website), website,
    phone: firstText(60, p?.phone, p?.phone?.number),
    industry,
    size: sizeOf(p?.employee_count_range ?? p?.staff_count_range ?? p?.size),
    employees_on_linkedin: num(p?.employee_count ?? p?.staff_count) ?? undefined,
    founded_year: yearOf(p?.foundation_date, p?.founded_year, p?.founded_on, p?.founded),
    tagline: firstText(500, p?.tagline, p?.localized_tagline),
    about: firstText(4000, p?.description, p?.localized_description),
    specialties: labels(p?.specialities ?? p?.specialties ?? p?.activities, 120, 20),
    hashtags: labels(p?.hashtags, 80, 20),
    followers: num(p?.followers_count ?? p?.follower_count) ?? undefined,
    hq,
  };
}

/** "No such company": the answer to remember for 90 days. A missing ACCOUNT (the sender itself) is a different problem. */
function companyNotFound(e: unknown): boolean {
  if (!(e instanceof UnipileError) || e.network) return false;
  const what = `${e.code} ${e.message}`;
  return (e.status === 404 || /not[ _]found/i.test(what)) && !/account/i.test(what);
}

export type EnsureCompanyResult = "saved" | "not_found" | "fresh" | "no_budget" | "skipped" | "error";

/**
 * Fetch and store the lead's current company once per company per 90 days (outreach_company_due / outreach_company_save).
 * Company id = the current role's company_id on the fetched profile, else lead.company_id; numeric ids only.
 * One LinkedIn call behind the search_page budget (the kind the company lookup of imports uses): reserve → call → consume,
 * release on failure. No budget → nothing happens and the next enrichment tries again. Never throws: leads do not wait for
 * company data, and a message that names the company carries a fallback.
 */
export async function ensureCompany(sender: Row, lead: Row, prof: Row): Promise<EnsureCompanyResult> {
  let cid = "";
  try {
    if (String(sender?.provider ?? "").toUpperCase() !== "LINKEDIN" || !sender?.unipile_account_id || !sender?.id) return "skipped";
    const ws = lead?.workspace_id ?? sender.workspace_id;
    const work: Row[] = Array.isArray(prof?.work_experience) ? prof.work_experience : [];
    // "current" as profileToEnrichment stores it, so the row saved here is the one the render context looks up
    const current = work.find((w) => w?.company_id && (typeof w.current === "boolean" ? w.current : !toIsoDate(w.end) && !!toIsoDate(w.start)));
    cid = String(current?.company_id ?? lead?.company_id ?? "").trim();
    if (!ws || !/^\d+$/.test(cid)) return "skipped";
    if (!(await rpc<boolean>("company_due", { p_ws: ws, p_linkedin_id: cid }))) return "fresh";

    const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
    if (!(await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "search_page" }))) return "no_budget";
    let company: Row;
    try {
      // the endpoint of unipile.linkedin.company, with one short attempt: this runs inside a profile fetch and must not hold it up
      company = await unipileRequest<Row>(`/linkedin/company/${encodeURIComponent(cid)}`, { query: { account_id: sender.unipile_account_id }, accountId: sender.unipile_account_id, timeoutMs: 15000, retries: 0 });
    } catch (e) {
      await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "search_page" }).catch(() => null);
      if (!companyNotFound(e)) throw e;
      await rpc("company_save", { p_ws: ws, p: { linkedin_id: cid } });   // looked up, nothing found: no retry for 90 days
      return "not_found";
    }
    await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "search_page" }).catch((e) => log({ fn: "enrich", warn: `consume search_page: ${String(e)}` }));
    // stored under the id we asked for: that is the id the lead's profile carries and the render context matches on
    await rpc("company_save", { p_ws: ws, p: { ...companyFacts(company ?? {}), linkedin_id: cid } });
    return "saved";
  } catch (e) {
    const msg = String((e as any)?.message ?? e);
    if (/could not find the function/i.test(msg)) return "skipped";   // migration 067 is not applied yet: nothing to store into
    log({ fn: "enrich", lead_id: lead?.id, sender_id: sender?.id, company_id: cid || undefined, warn: `company: ${msg.slice(0, 300)}` });
    return "error";
  }
}

export interface SaveProfileResult { saved: boolean; empty_sections: string[]; throttled: boolean }

/** Store what a full-section fetch returned. Preview fetches (requested = []) store nothing: previews are not enrichment. */
export async function saveProfile(lead: Row, prof: Row, sender: Row, source: string, requested: readonly string[]): Promise<SaveProfileResult | null> {
  if (!requested.length) return null;
  try {
    const r = await rpc<SaveProfileResult>("save_lead_profile", { p_lead: lead.id, p_profile: profileToEnrichment(prof, requested), p_sender: sender.id, p_source: source });
    if (r?.throttled) log({ fn: "enrich", sender_id: sender.id, lead_id: lead.id, warn: "all requested sections came back empty (throttled?)" });
    // The company of the lead's current role, once per company per 90 days. Never throws; not while LinkedIn throttles this sender.
    if (r?.saved && !r.throttled) await ensureCompany(sender, lead, prof);
    return r;
  } catch (e) { log({ fn: "enrich", lead_id: lead.id, error: `save_lead_profile: ${String((e as any)?.message ?? e)}` }); return null; }
}

/** Post rows for outreach_save_lead_posts: [{id,text,date,reactions,comments,url}]. `id` is the id a reaction / comment needs:
 *  LinkedIn `social_id`; Instagram `provider_id` (its posts carry caption{text,created_at}, like_count, comment_count and no social_id). */
export function postsToRows(items: Row[]): Row[] {
  return (items ?? []).filter((p) => !p?.is_repost).map((p) => {
    const ig = !p?.social_id && (typeof p?.caption === "object" || p?.like_count !== undefined);
    let t = NaN;
    if (ig) { const c = Number(p.caption?.created_at ?? p.created_at); if (Number.isFinite(c) && c > 0) t = c < 1e12 ? c * 1000 : c; }
    else { const raw = p.parsed_datetime ?? p.date ?? null; t = raw ? Date.parse(raw) : NaN; }
    return {
      id: String((ig ? p.provider_id : p.social_id ?? p.id) ?? ""), text: String((ig ? p.caption?.text : p.text) ?? "").slice(0, 3000), date: isNaN(t) ? "" : new Date(t).toISOString(),
      reactions: num(ig ? p.like_count : p.reaction_counter) ?? 0, comments: num(ig ? p.comment_count : p.comment_counter) ?? 0, url: p.share_url ?? p.url ?? null,
    };
  }).filter((p) => p.id);
}

export type PostsResult = { ok: true; posts: Row[] } | { ok: false; reason: "no_budget" | "no_identifier" };

/** List + store a lead's recent posts. NO budget handling: only for callers whose post_fetch budget is already reserved (a claimed post_fetch action). */
export async function fetchPosts(sender: Row, lead: Row, limit = 5): Promise<Row[]> {
  const res = await unipile.users.posts(sender.unipile_account_id, lead.provider_id, limit);
  const rows = postsToRows(res.items ?? []).slice(0, 5);
  await rpc("save_lead_posts", { p_lead: lead.id, p_posts: rows, p_sender: sender.id }).catch((e) => log({ fn: "enrich", lead_id: lead.id, error: `save_lead_posts: ${String((e as any)?.message ?? e)}` }));
  return rows;
}

/**
 * List a lead's recent posts behind the post_fetch budget: reserve → call → consume (release on failure), then store them.
 * Unipile recommends at most ~100 post retrievals a day per account; the database cap is lower and follows warm-up.
 * Errors from Unipile are re-thrown after the reservation is released, so callers keep their normal error handling.
 */
export async function fetchPostsBudgeted(sender: Row, lead: Row, limit = 5): Promise<PostsResult> {
  if (!lead?.provider_id) return { ok: false, reason: "no_identifier" };   // the posts endpoint needs the provider id, not the public identifier
  const day = await rpc<string>("sender_local_date", { p_sender: sender.id, p_at: new Date().toISOString() });
  const reserved = await rpc<boolean>("reserve_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch((e) => { log({ fn: "enrich", warn: `reserve post_fetch: ${String(e)}` }); return false; });
  if (!reserved) return { ok: false, reason: "no_budget" };
  let rows: Row[];
  try { rows = await fetchPosts(sender, lead, limit); }
  catch (e) {
    await rpc("release_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch(() => null);
    throw e;
  }
  await rpc("consume_budget", { p_sender: sender.id, p_day: day, p_type: "post_fetch" }).catch((e) => log({ fn: "enrich", warn: `consume post_fetch: ${String(e)}` }));
  return { ok: true, posts: rows };
}

/** Posts stored by an earlier fetch (the prefetch, the enrich worker), when they are fresh enough to act on. */
export async function storedPosts(leadId: string, maxAgeHours: number): Promise<Row[] | null> {
  const { data } = await admin.from("outreach_lead_profiles").select("posts, posts_fetched_at").eq("lead_id", leadId).maybeSingle();
  if (!data?.posts_fetched_at) return null;
  if (Date.now() - new Date(data.posts_fetched_at).getTime() > maxAgeHours * 3600_000) return null;
  return Array.isArray(data.posts) ? data.posts : [];
}

/** "Tomorrow morning" in the sender's timezone (08:00–09:30), for work that ran out of today's budget. */
export function tomorrowMorning(tz: string): Date {
  const lp = localParts(tz || "UTC");
  return new Date(zonedToUtc(addDays(lp.date, 1), "08:00", tz || "UTC").getTime() + randInt(0, 90) * 60_000);
}
