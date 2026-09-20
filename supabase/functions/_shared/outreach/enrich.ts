// Profile enrichment helpers (item 13), shared by the executor (free path: the fetch a step already makes) and
// outreach-worker-enrich (budgeted path: leftover profile views). Every LinkedIn call here sits behind a database budget.
import { admin, log, rpc, localParts, zonedToUtc, addDays, randInt } from "./supabase.ts";
import { unipile, FULL_PROFILE_SECTIONS, PREVIEW_SECTIONS } from "./unipile.ts";

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
    requested_sections: [...requestedSections],
  };
}

export interface SaveProfileResult { saved: boolean; empty_sections: string[]; throttled: boolean }

/** Store what a full-section fetch returned. Preview fetches (requested = []) store nothing: previews are not enrichment. */
export async function saveProfile(lead: Row, prof: Row, sender: Row, source: string, requested: readonly string[]): Promise<SaveProfileResult | null> {
  if (!requested.length) return null;
  try {
    const r = await rpc<SaveProfileResult>("save_lead_profile", { p_lead: lead.id, p_profile: profileToEnrichment(prof, requested), p_sender: sender.id, p_source: source });
    if (r?.throttled) log({ fn: "enrich", sender_id: sender.id, lead_id: lead.id, warn: "all requested sections came back empty (throttled?)" });
    return r;
  } catch (e) { log({ fn: "enrich", lead_id: lead.id, error: `save_lead_profile: ${String((e as any)?.message ?? e)}` }); return null; }
}

/** Post rows for outreach_save_lead_posts: [{id,text,date,reactions,comments,url}]. `id` is the social id a reaction / comment needs. */
export function postsToRows(items: Row[]): Row[] {
  return (items ?? []).filter((p) => !p?.is_repost).map((p) => {
    const raw = p.parsed_datetime ?? p.date ?? null;
    const t = raw ? Date.parse(raw) : NaN;
    return {
      id: String(p.social_id ?? p.id ?? ""), text: String(p.text ?? "").slice(0, 3000), date: isNaN(t) ? "" : new Date(t).toISOString(),
      reactions: num(p.reaction_counter) ?? 0, comments: num(p.comment_counter) ?? 0, url: p.share_url ?? null,
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
