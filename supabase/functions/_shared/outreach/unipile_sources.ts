// Unipile endpoints used by the lead sources (plan item 18). Kept out of unipile.ts (owned by ENGINE-SEND); everything
// goes through the exported low-level `unipileRequest`.
//
// Checked against https://developer.unipile.com/reference on 20 Sep 2026:
//   GET  /posts/{post_id}                      post_id = activity id from the URL, or urn:li:ugcPost:… / urn:li:share:… → returns social_id
//   GET  /posts/{social_id}/reactions          account_id, cursor, limit 1–100 → items[].author{id,type,name,headline,profile_url,network_distance}
//   GET  /posts/{social_id}/comments           account_id, cursor, limit 1–100, sort_by → items[].author + author_details{id,headline,profile_url,network_distance}
//   GET  /linkedin/search/parameters           account_id, type (… SAVED_SEARCHES, LEAD_LISTS, COMPANY …), service CLASSIC|SALES_NAVIGATOR|RECRUITER, keywords, limit 1–100
//   POST /linkedin/search                      sales_navigator people: saved_search_id | lead_lists{include[]}; classic people: company[ids], advanced_keywords{title}
//   GET  /linkedin/company/{identifier}        (already in unipile.ts as unipile.linkedin.company)
// There is NO endpoint that lists the people who reposted a post, so "reposts" cannot be imported (see postEngagementSupport).
//
// CALLERS MUST reserve a budget (search_page) before each call here and consume / release it after: these functions do not.
import { unipileRequest, unipile } from "./unipile.ts";

type Row = Record<string, any>;
export interface Page { items: Row[]; cursor: string | null; total?: number | null }

export const postEngagementSupport = { reactions: true, comments: true, reposts: false } as const;

/** Pull the post identifier Unipile's GET /posts accepts out of any LinkedIn post URL (or a bare id / urn). */
export function postIdFromUrl(input: string): string | null {
  let s = String(input ?? "").trim();
  if (!s) return null;
  try { s = decodeURIComponent(s); } catch { /* keep as is */ }
  const urn = /urn:li:(activity|ugcPost|share):(\d{6,})/i.exec(s);
  if (urn) return urn[1].toLowerCase() === "activity" ? urn[2] : `urn:li:${urn[1].toLowerCase() === "ugcpost" ? "ugcPost" : "share"}:${urn[2]}`;
  const slug = /[-_](activity|ugcpost|share)[-_:](\d{6,})/i.exec(s);
  if (slug) { const k = slug[1].toLowerCase(); return k === "activity" ? slug[2] : `urn:li:${k === "ugcpost" ? "ugcPost" : "share"}:${slug[2]}`; }
  if (/^\d{6,}$/.test(s)) return s;
  return null;
}

/** Company slug or numeric id from a LinkedIn company URL. */
export function companyIdentFromUrl(url: string): string | null {
  const m = /linkedin\.com\/(?:company|school|showcase)\/([^/?#]+)/i.exec(String(url ?? ""));
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  const sn = /linkedin\.com\/sales\/company\/(\d+)/i.exec(String(url ?? ""));
  return sn ? sn[1] : null;
}

/** Sales Navigator saved-search / lead-list id from a pasted Sales Navigator URL (fallback when the picker is not used). */
export function salesNavIdsFromUrl(url: string): { saved_search_id?: string; lead_list_id?: string } {
  const s = String(url ?? "");
  const saved = /[?&]savedSearchId=(\d+)/i.exec(s);
  if (saved) return { saved_search_id: saved[1] };
  const list = /\/sales\/lists\/people\/(\d+)/i.exec(s);
  if (list) return { lead_list_id: list[1] };
  return {};
}

export const sources = {
  /** Resolve a post; `social_id` is what the reactions / comments endpoints need. One LinkedIn call. */
  getPost: (accountId: string, postId: string) =>
    unipileRequest<Row>(`/posts/${encodeURIComponent(postId)}`, { query: { account_id: accountId }, accountId, timeoutMs: 30000, retries: 0 }),

  postReactions: async (accountId: string, socialId: string, q: { cursor?: string; limit?: number } = {}): Promise<Page> => {
    const r = await unipileRequest<Row>(`/posts/${encodeURIComponent(socialId)}/reactions`, { query: { account_id: accountId, limit: q.limit ?? 100, cursor: q.cursor }, accountId, timeoutMs: 45000, retries: 0 });
    return { items: r?.items ?? [], cursor: r?.cursor ?? r?.paging?.cursor ?? null, total: r?.total_count ?? r?.paging?.total_count ?? null };
  },

  postComments: async (accountId: string, socialId: string, q: { cursor?: string; limit?: number } = {}): Promise<Page> => {
    const r = await unipileRequest<Row>(`/posts/${encodeURIComponent(socialId)}/comments`, { query: { account_id: accountId, limit: q.limit ?? 100, cursor: q.cursor, sort_by: "MOST_RECENT" }, accountId, timeoutMs: 45000, retries: 0 });
    return { items: r?.items ?? [], cursor: r?.cursor ?? r?.paging?.cursor ?? null, total: r?.total_count ?? r?.paging?.total_count ?? null };
  },

  /** Search parameter lookup (ids for saved searches, lead lists, companies …). One LinkedIn call. */
  searchParameters: async (accountId: string, q: { type: string; service?: "CLASSIC" | "SALES_NAVIGATOR" | "RECRUITER"; keywords?: string; limit?: number }): Promise<Row[]> => {
    const r = await unipileRequest<Row>("/linkedin/search/parameters", { query: { account_id: accountId, type: q.type, service: q.service ?? "CLASSIC", keywords: q.keywords, limit: q.limit ?? 100 }, accountId, timeoutMs: 30000, retries: 0 });
    return (r?.items ?? []).map((i: Row) => ({ id: String(i.id), title: String(i.title ?? i.id), additional_data: i.additional_data ?? null }));
  },

  salesNavSavedSearches: (accountId: string) => sources.searchParameters(accountId, { type: "SAVED_SEARCHES", service: "SALES_NAVIGATOR", limit: 100 }),
  salesNavLeadLists: (accountId: string) => sources.searchParameters(accountId, { type: "LEAD_LISTS", service: "SALES_NAVIGATOR", limit: 100 }),

  /** Sales Navigator people search driven by a saved search (overrides every other filter on LinkedIn's side). */
  searchSavedSearch: (accountId: string, savedSearchId: string, q: { cursor?: string; limit?: number } = {}) =>
    unipile.linkedin.search(accountId, { api: "sales_navigator", category: "people", saved_search_id: savedSearchId }, { cursor: q.cursor, limit: q.limit ?? 50 }),

  searchLeadList: (accountId: string, leadListId: string, q: { cursor?: string; limit?: number } = {}) =>
    unipile.linkedin.search(accountId, { api: "sales_navigator", category: "people", lead_lists: { include: [leadListId] } }, { cursor: q.cursor, limit: q.limit ?? 50 }),

  /** Classic people search inside one company with a title filter. Classic returns 10 per page. */
  searchCompanyPeople: (accountId: string, companyId: string, titleKeywords: string[], q: { cursor?: string } = {}) => {
    const body: Row = { api: "classic", category: "people", company: [companyId] };
    const titles = titleKeywords.map((t) => t.trim()).filter(Boolean);
    if (titles.length) body.advanced_keywords = { title: titles.map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t)).join(" OR ") };
    return unipile.linkedin.search(accountId, body, { cursor: q.cursor, limit: 10 });
  },

  /** Numeric company id from a name / URL / slug. `via` tells the caller which LinkedIn call was made. */
  resolveCompany: async (accountId: string, c: { name?: string; linkedin_url?: string; company_id?: string }): Promise<{ id: string; name: string | null } | null> => {
    if (c.company_id && /^\d+$/.test(String(c.company_id))) return { id: String(c.company_id), name: c.name ?? null };
    const ident = c.linkedin_url ? companyIdentFromUrl(c.linkedin_url) : null;
    if (ident && /^\d+$/.test(ident)) return { id: ident, name: c.name ?? null };
    if (ident) {
      const p = await unipile.linkedin.company(accountId, ident);
      const id = p?.id ?? p?.provider_id ?? p?.entity_urn?.split(":").pop();
      return id && /^\d+$/.test(String(id)) ? { id: String(id), name: p?.name ?? c.name ?? null } : null;
    }
    if (c.name) {
      const found = await sources.searchParameters(accountId, { type: "COMPANY", service: "CLASSIC", keywords: c.name, limit: 5 });
      const exact = found.find((f) => f.title.toLowerCase() === c.name!.toLowerCase()) ?? found[0];
      return exact && /^\d+$/.test(exact.id) ? { id: exact.id, name: exact.title } : null;
    }
    return null;
  },
};

/** Reaction / comment author → the item shape upsertLeadsFromItems understands. Companies are dropped by the caller (type COMPANY). */
export function engagementAuthorToItem(entry: Row, engagement: "reacted" | "commented"): Row | null {
  const a: Row = engagement === "reacted" ? (entry.author ?? {}) : { ...(entry.author_details ?? {}), name: typeof entry.author === "string" ? entry.author : entry.author?.name ?? entry.author_details?.name };
  const id = a.id ?? a.provider_id ?? null;
  const url = a.profile_url ?? a.public_profile_url ?? null;
  if (!id && !url) return null;
  const name = String(a.name ?? "").trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    type: a.type ?? (a.is_company ? "COMPANY" : "INDIVIDUAL"), id, public_profile_url: url, name: name || null,
    first_name: parts[0] ?? null, last_name: parts.slice(1).join(" ") || null, headline: a.headline ?? null,
    profile_picture_url: a.profile_picture_url ?? null, network_distance: a.network_distance ?? null,
    _custom: { engagement, ...(engagement === "reacted" && entry.value ? { reaction: entry.value } : {}) },
  };
}
