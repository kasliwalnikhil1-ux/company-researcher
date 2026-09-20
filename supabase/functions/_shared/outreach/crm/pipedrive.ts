// Pipedrive: OAuth (Basic client auth, api_domain per company), API v2 for persons / organizations / deals,
// API v1 for notes, filters, personFields and users/me (those have no v2 yet).
import { bearer, crmRequest, type CrmRequest } from "./http.ts";
import { activityHtml, emailDomain, mapFields, NOTE_FALLBACK_FIELDS, splitName, unmappedOwned } from "./mapping.ts";
import { CrmError, type ActivityInput, type BlacklistPage, type CrmProvider, type CrmTokens, type DealInput, type ImportedLead, type ProviderEnv, type Segment, type SegmentPage, type StageTarget, type UpsertOptions, type UpsertResult } from "./types.ts";

const AUTHORIZE = "https://oauth.pipedrive.com/oauth/authorize";
const TOKEN_URL = "https://oauth.pipedrive.com/oauth/token";

// Scopes are ticked in the Pipedrive Developer Hub app, not sent on the authorize URL.
export const PIPEDRIVE_SCOPES = ["base", "contacts:full", "deals:full", "search:read", "admin (optional: lets us create the 'LinkedIn URL' and 'Outreach stage' person fields)"];

const pdTime = (iso: string): string => new Date(iso || Date.now()).toISOString().slice(0, 19).replace("T", " ");

export function pipedriveProvider(env: ProviderEnv): CrmProvider {
  const basic = "Basic " + btoa(`${env.clientId}:${env.clientSecret}`);
  const fieldCache = new Map<string, Promise<Map<string, string>>>(); // per company: field name (lower) → key

  function base(tokens: CrmTokens): string {
    if (!tokens.instance_url) throw new CrmError("pipedrive", "auth", 401, "Pipedrive company domain is missing. Reconnect the integration.");
    return tokens.instance_url.replace(/\/+$/, "");
  }
  const call = <T = any>(tokens: CrmTokens, path: string, req: CrmRequest = {}) =>
    crmRequest<T>(env.fetch, "pipedrive", `${base(tokens)}${path}`, { ...req, headers: { ...bearer(tokens.access_token), ...(req.headers ?? {}) } });

  function toTokens(r: any, previous?: CrmTokens): CrmTokens {
    if (!r?.access_token) throw new CrmError("pipedrive", "auth", 400, "Pipedrive did not return an access token");
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token ?? previous?.refresh_token ?? null,
      expires_at: new Date(Date.now() + (Number(r.expires_in) || 3600) * 1000).toISOString(),
      instance_url: r.api_domain ?? previous?.instance_url ?? null,
    };
  }

  function personFields(tokens: CrmTokens): Promise<Map<string, string>> {
    const k = base(tokens);
    let p = fieldCache.get(k);
    if (!p) {
      p = (async () => {
        const map = new Map<string, string>();
        let start = 0;
        for (let i = 0; i < 5; i++) {
          const r = await call(tokens, `/api/v1/personFields?limit=500&start=${start}`);
          for (const f of r?.data ?? []) map.set(String(f.name).trim().toLowerCase(), String(f.key));
          const pg = r?.additional_data?.pagination;
          if (!pg?.more_items_in_collection) break;
          start = pg.next_start ?? start + 500;
        }
        return map;
      })();
      fieldCache.set(k, p);
      p.catch(() => fieldCache.delete(k));
    }
    return p;
  }

  /** "custom:Field name" → field key, creating the text field when we are allowed to. Null = not available. */
  async function customKey(tokens: CrmTokens, target: string, create: boolean): Promise<string | null> {
    if (!target.startsWith("custom:")) return target; // already a field key
    const name = target.slice(7).trim();
    const fields = await personFields(tokens);
    const hit = fields.get(name.toLowerCase());
    if (hit || !create) return hit ?? null;
    try {
      const r = await call(tokens, "/api/v1/personFields", { json: { name, field_type: "varchar" } });
      const key = r?.data?.key ? String(r.data.key) : null;
      if (key) fields.set(name.toLowerCase(), key);
      return key;
    } catch (e) {
      if (e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit" || e.kind === "transient")) throw e;
      return null; // no admin scope / not an admin user
    }
  }

  async function searchId(tokens: CrmTokens, object: "persons" | "organizations", term: string, fields: string): Promise<string | null> {
    if (term.trim().length < 2) return null;
    const q = new URLSearchParams({ term, fields, exact_match: "true", limit: "1" });
    const r = await call(tokens, `/api/v2/${object}/search?${q}`);
    const id = r?.data?.items?.[0]?.item?.id;
    return id != null ? String(id) : null;
  }

  async function byIds(tokens: CrmTokens, object: "persons" | "organizations", ids: number[]): Promise<any[]> {
    const out: any[] = [];
    const uniq = [...new Set(ids.filter((x) => Number.isFinite(x)))];
    for (let i = 0; i < uniq.length; i += 100) {
      const r = await call(tokens, `/api/v2/${object}?ids=${uniq.slice(i, i + 100).join(",")}&limit=100`);
      out.push(...(r?.data ?? []));
    }
    return out;
  }

  const primaryEmail = (p: any): string | null => {
    const list = Array.isArray(p?.emails) ? p.emails : Array.isArray(p?.email) ? p.email : [];
    const e = list.find((x: any) => x?.primary && x?.value) ?? list.find((x: any) => x?.value);
    return e?.value ? String(e.value).toLowerCase() : null;
  };

  return {
    name: "pipedrive",
    label: "Pipedrive",
    scopes: PIPEDRIVE_SCOPES,
    configured: () => !!env.clientId && !!env.clientSecret,

    authorizeUrl(state, redirectUri) {
      return `${AUTHORIZE}?${new URLSearchParams({ client_id: env.clientId, redirect_uri: redirectUri, state })}`;
    },

    async exchangeCode(code, redirectUri) {
      const r = await crmRequest(env.fetch, "pipedrive", TOKEN_URL, { headers: { authorization: basic }, form: { grant_type: "authorization_code", code, redirect_uri: redirectUri } });
      return toTokens(r);
    },

    async refresh(tokens) {
      if (!tokens.refresh_token) throw new CrmError("pipedrive", "auth", 401, "no refresh token stored");
      const r = await crmRequest(env.fetch, "pipedrive", TOKEN_URL, { headers: { authorization: basic }, form: { grant_type: "refresh_token", refresh_token: tokens.refresh_token } });
      return toTokens(r, tokens);
    },

    async accountLabel(tokens) {
      const r = await call(tokens, "/api/v1/users/me");
      const d = r?.data ?? {};
      return d.company_name ? `${d.company_name}${d.company_domain ? ` (${d.company_domain}.pipedrive.com)` : ""}` : (d.email ?? "Pipedrive");
    },

    async upsertContact(tokens, lead, opts: UpsertOptions): Promise<UpsertResult> {
      const mapping = opts.mapping as Record<string, string>;
      const leftover: Record<string, string> = unmappedOwned(lead, mapping);

      const build = async (ownedOnly: boolean, create: boolean): Promise<Record<string, unknown>> => {
        const body: Record<string, unknown> = {};
        const custom: Record<string, string> = {};
        const inverse: Record<string, string> = Object.fromEntries(Object.entries(mapping).map(([ours, theirs]) => [theirs, ours]));
        for (const [target, value] of Object.entries(mapFields(lead, mapping, { ownedOnly }))) {
          if (target === "name") body.name = value;
          else if (target === "emails" || target === "email") body.emails = [{ value, primary: true, label: "work" }];
          else if (target === "phones" || target === "phone") body.phones = [{ value, primary: true, label: "work" }];
          else if (target === "job_title") body.job_title = value;
          else if (target === "org_name" || target === "org") continue; // handled on create only
          else {
            const key = await customKey(tokens, target, true);
            if (key) custom[key] = value;
            else if (NOTE_FALLBACK_FIELDS.includes(inverse[target])) leftover[inverse[target]] = value;
          }
        }
        if (Object.keys(custom).length) body.custom_fields = custom;
        if (create && !body.name) body.name = splitName(lead).full;
        return body;
      };

      const write = async (path: string, method: string, body: Record<string, unknown>): Promise<any> => {
        try { return await call(tokens, path, { method, json: body }); }
        catch (e) {
          // job_title is not writable in every account: retry without it rather than lose the contact
          if (e instanceof CrmError && e.kind === "validation" && "job_title" in body) { const { job_title: _drop, ...rest } = body; return await call(tokens, path, { method, json: rest }); }
          throw e;
        }
      };

      const update = async (id: string): Promise<boolean> => {
        const body = await build(!opts.overwriteExisting, false);
        if (!Object.keys(body).length) return true;
        try { await write(`/api/v2/persons/${id}`, "PATCH", body); return true; }
        catch (e) { if (e instanceof CrmError && e.kind === "not_found") return false; throw e; }
      };

      if (opts.existing?.contactId && await update(opts.existing.contactId)) return { contactId: opts.existing.contactId, companyId: opts.existing.companyId ?? null, created: false, leftover };

      let found = lead.email ? await searchId(tokens, "persons", lead.email, "email") : null;
      if (!found && lead.linkedin_url && mapping.linkedin_url && await customKey(tokens, mapping.linkedin_url, false)) found = await searchId(tokens, "persons", lead.linkedin_url, "custom_fields");
      if (found && await update(found)) return { contactId: found, companyId: null, created: false, leftover };

      let orgId: string | null = null;
      if (lead.company && (mapping.company === "org_name" || mapping.company === "org")) {
        orgId = await searchId(tokens, "organizations", lead.company, "name");
        if (!orgId) { const o = await call(tokens, "/api/v2/organizations", { json: { name: lead.company } }); orgId = o?.data?.id != null ? String(o.data.id) : null; }
      }
      const body = await build(false, true);
      if (orgId) body.org_id = Number(orgId);
      const r = await write("/api/v2/persons", "POST", body);
      if (r?.data?.id == null) throw new CrmError("pipedrive", "validation", 400, "Pipedrive did not return the new person id");
      return { contactId: String(r.data.id), companyId: orgId, created: true, leftover };
    },

    async logActivity(tokens, contactId, a: ActivityInput) {
      const body: Record<string, unknown> = { content: activityHtml(a), person_id: Number(contactId), add_time: pdTime(a.at) };
      if (a.dealId) body.deal_id = Number(a.dealId);
      const r = await call(tokens, "/api/v1/notes", { json: body });
      return { id: r?.data?.id != null ? String(r.data.id) : null };
    },

    async setStage(tokens, ids, target: StageTarget) {
      // People have no stage in Pipedrive; the pipeline stage lives on the deal. The person's "Outreach stage" field is kept by upsertContact.
      if (!target.deal || !ids.dealId) return { contact: false, deal: false };
      const v = String(target.deal).trim();
      const body = /^(won|lost|open)$/i.test(v) ? { status: v.toLowerCase() } : { stage_id: Number(v) };
      if ("stage_id" in body && !Number.isFinite(body.stage_id)) throw new CrmError("pipedrive", "validation", 400, `"${v}" is not a Pipedrive stage id. Use the numeric stage id, or won / lost.`);
      await call(tokens, `/api/v2/deals/${ids.dealId}`, { method: "PATCH", json: body });
      return { contact: false, deal: true };
    },

    async createDeal(tokens, contactId, deal: DealInput) {
      const body: Record<string, unknown> = { title: deal.name, person_id: Number(contactId) };
      if (deal.companyId) body.org_id = Number(deal.companyId);
      if (deal.stage && Number.isFinite(Number(deal.stage))) body.stage_id = Number(deal.stage);
      else if (deal.pipeline && Number.isFinite(Number(deal.pipeline))) body.pipeline_id = Number(deal.pipeline);
      if (deal.amount != null) body.value = deal.amount;
      const r = await call(tokens, "/api/v2/deals", { json: body });
      if (r?.data?.id == null) throw new CrmError("pipedrive", "validation", 400, "Pipedrive did not return the new deal id");
      return { dealId: String(r.data.id) };
    },

    async listSegments(tokens): Promise<Segment[]> {
      const r = await call(tokens, "/api/v1/filters?type=people");
      return (r?.data ?? []).filter((f: any) => f.active_flag !== false).map((f: any) => ({ id: String(f.id), name: f.name, kind: "People filter", size: null }));
    },

    async importSegment(tokens, segmentId, cursor): Promise<SegmentPage> {
      const q = new URLSearchParams({ filter_id: segmentId, limit: "200" });
      if (cursor) q.set("cursor", cursor);
      const r = await call(tokens, `/api/v2/persons?${q}`);
      const people: any[] = r?.data ?? [];
      const orgs = new Map<string, string>();
      for (const o of await byIds(tokens, "organizations", people.map((p) => Number(p.org_id)).filter(Boolean))) orgs.set(String(o.id), o.name);
      let liKey: string | null = null;
      try { liKey = await customKey(tokens, "custom:LinkedIn URL", false); } catch { liKey = null; }
      const leads: ImportedLead[] = people.map((p) => ({
        crm_contact_id: String(p.id), crm_company_id: p.org_id ? String(p.org_id) : null,
        first_name: p.first_name || null, last_name: p.last_name || null, full_name: p.name || null,
        email: primaryEmail(p), title: p.job_title || null, company: p.org_id ? orgs.get(String(p.org_id)) ?? null : null,
        linkedin_url: liKey && typeof p.custom_fields?.[liKey] === "string" ? p.custom_fields[liKey] : null,
        phone: (Array.isArray(p.phones) ? p.phones.find((x: any) => x?.value)?.value : null) ?? null,
      }));
      return { leads, next: r?.additional_data?.next_cursor ?? null };
    },

    async listCustomersAndOpenDeals(tokens, cursor): Promise<BlacklistPage> {
      // cursor = { phase, cursor }: 0 open deals, 1 won deals (customers)
      const c: { phase: number; cursor: string | null } = cursor ? JSON.parse(cursor) : { phase: 0, cursor: null };
      const q = new URLSearchParams({ status: c.phase === 0 ? "open" : "won", limit: "200" });
      if (c.cursor) q.set("cursor", c.cursor);
      const r = await call(tokens, `/api/v2/deals?${q}`);
      const deals: any[] = r?.data ?? [];
      const page: BlacklistPage = { emails: [], domains: [], companies: [], next: null };
      for (const p of await byIds(tokens, "persons", deals.map((d) => Number(d.person_id)).filter(Boolean))) {
        const e = primaryEmail(p);
        if (e) { page.emails.push(e); const d = emailDomain(e); if (d) page.domains.push(d); }
      }
      for (const o of await byIds(tokens, "organizations", deals.map((d) => Number(d.org_id)).filter(Boolean))) {
        if (o.name) page.companies.push(o.name);
        if (typeof o.website === "string" && o.website) page.domains.push(o.website);
      }
      const nextCursor = r?.additional_data?.next_cursor ?? null;
      page.next = nextCursor ? JSON.stringify({ phase: c.phase, cursor: nextCursor }) : c.phase === 0 ? JSON.stringify({ phase: 1, cursor: null }) : null;
      return page;
    },
  };
}
