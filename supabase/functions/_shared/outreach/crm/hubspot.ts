// HubSpot: OAuth (v3 token endpoint; v1 is switched off on 16 Feb 2027), CRM v3 objects, v4 default associations,
// notes / communications / emails for the timeline, lists for import, lifecycle + open deals for the blacklist.
import { bearer, crmRequest, type CrmRequest } from "./http.ts";
import { activityHtml, activityText, emailDomain, mapFields, NOTE_FALLBACK_FIELDS, splitName, unmappedOwned } from "./mapping.ts";
import { CrmError, type ActivityInput, type BlacklistPage, type CrmLead, type CrmProvider, type CrmTokens, type DealInput, type ImportedLead, type ProviderEnv, type Segment, type SegmentPage, type StageTarget, type UpsertOptions, type UpsertResult } from "./types.ts";

const API = "https://api.hubapi.com";
const AUTHORIZE = "https://app.hubspot.com/oauth/authorize";
const TOKEN_URL = "https://api.hubspot.com/oauth/v3/token";

export const HUBSPOT_SCOPES = [
  "oauth",
  "crm.objects.contacts.read", "crm.objects.contacts.write",
  "crm.objects.companies.read", "crm.objects.companies.write",
  "crm.objects.deals.read", "crm.objects.deals.write",
  "crm.lists.read",
  "crm.schemas.contacts.write", // lets us create the "Outreach stage" text property
];

const IMPORT_PROPS = ["firstname", "lastname", "email", "jobtitle", "company", "hs_linkedin_url", "phone", "associatedcompanyid"];

export function hubspotProvider(env: ProviderEnv): CrmProvider {
  const tokenUrl = env.extra?.tokenUrl || TOKEN_URL;
  const call = <T = any>(tokens: CrmTokens, path: string, req: CrmRequest = {}) =>
    crmRequest<T>(env.fetch, "hubspot", `${API}${path}`, { ...req, headers: { ...bearer(tokens.access_token), ...(req.headers ?? {}) } });

  function toTokens(r: any, previous?: CrmTokens): CrmTokens {
    if (!r?.access_token) throw new CrmError("hubspot", "auth", 400, "HubSpot did not return an access token");
    return {
      access_token: r.access_token,
      refresh_token: r.refresh_token ?? previous?.refresh_token ?? null,
      expires_at: new Date(Date.now() + (Number(r.expires_in) || 1800) * 1000).toISOString(),
      instance_url: null,
    };
  }

  const associate = (tokens: CrmTokens, fromType: string, fromId: string, toType: string, toId: string) =>
    call(tokens, `/crm/v4/objects/${fromType}/${fromId}/associations/default/${toType}/${toId}`, { method: "PUT" });

  async function search(tokens: CrmTokens, object: string, property: string, value: string, properties: string[] = []): Promise<any | null> {
    const r = await call(tokens, `/crm/v3/objects/${object}/search`, { json: { filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }], properties, limit: 1 } });
    return r?.results?.[0] ?? null;
  }

  /** Names of properties HubSpot says do not exist, read from a 400 body. */
  function missingProperties(e: CrmError): string[] {
    if (!/PROPERTY_DOESNT_EXIST/.test(e.body) && !/does not exist/i.test(e.body)) return [];
    const names = new Set<string>();
    for (const m of e.body.matchAll(/\\?"name\\?"\s*:\s*\\?"([A-Za-z0-9_]+)\\?"/g)) names.add(m[1]);
    for (const m of e.body.matchAll(/Property \\?"([A-Za-z0-9_]+)\\?" does not exist/g)) names.add(m[1]);
    return [...names];
  }

  async function ensureCompany(tokens: CrmTokens, lead: CrmLead, name: string): Promise<string | null> {
    const domain = emailDomain(lead.email);
    const found = (domain ? await search(tokens, "companies", "domain", domain) : null) ?? await search(tokens, "companies", "name", name);
    if (found?.id) return String(found.id);
    const created = await call(tokens, "/crm/v3/objects/companies", { json: { properties: domain ? { name, domain } : { name } } });
    return created?.id ? String(created.id) : null;
  }

  return {
    name: "hubspot",
    label: "HubSpot",
    scopes: HUBSPOT_SCOPES,
    configured: () => !!env.clientId && !!env.clientSecret,

    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: env.clientId, redirect_uri: redirectUri, scope: HUBSPOT_SCOPES.join(" "), state });
      return `${AUTHORIZE}?${q}`;
    },

    async exchangeCode(code, redirectUri) {
      const r = await crmRequest(env.fetch, "hubspot", tokenUrl, { form: { grant_type: "authorization_code", client_id: env.clientId, client_secret: env.clientSecret, redirect_uri: redirectUri, code } });
      return toTokens(r);
    },

    async refresh(tokens) {
      if (!tokens.refresh_token) throw new CrmError("hubspot", "auth", 401, "no refresh token stored");
      const r = await crmRequest(env.fetch, "hubspot", tokenUrl, { form: { grant_type: "refresh_token", client_id: env.clientId, client_secret: env.clientSecret, refresh_token: tokens.refresh_token } });
      return toTokens(r, tokens);
    },

    async accountLabel(tokens) {
      // account-info works with any OAuth token and doubles as the "is the token alive" check
      const a = await call(tokens, "/account-info/v3/details");
      let domain: string | null = null;
      try {
        const i = await crmRequest(env.fetch, "hubspot", `${tokenUrl}/introspect`, { form: { client_id: env.clientId, client_secret: env.clientSecret, token_type_hint: "access_token", token: tokens.access_token } });
        domain = i?.hub_domain ?? null;
      } catch { /* label falls back to the portal id */ }
      return domain ? `${domain} (${a?.portalId ?? "HubSpot"})` : `HubSpot account ${a?.portalId ?? ""}`.trim();
    },

    async upsertContact(tokens, lead, opts: UpsertOptions): Promise<UpsertResult> {
      const mapping = opts.mapping as Record<string, string>;
      const inverse: Record<string, string> = Object.fromEntries(Object.entries(mapping).map(([ours, theirs]) => [theirs, ours]));
      const leftover: Record<string, string> = unmappedOwned(lead, mapping);
      const all = mapFields(lead, mapping);
      if (!all.firstname && !all.lastname && !all.email) {
        const n = splitName(lead);
        if (n.first) all.firstname = n.first;
        all.lastname = n.last ?? n.full;
      }
      const owned = mapFields(lead, mapping, { ownedOnly: true });
      let triedCreateProperty = false;

      // send with self-healing for properties that do not exist in this portal
      const send = async (path: string, method: string, props: Record<string, string>): Promise<any> => {
        const p = { ...props };
        for (let attempt = 0; attempt < 4; attempt++) {
          if (method === "PATCH" && Object.keys(p).length === 0) return null;
          try { return await call(tokens, path, { method, json: { properties: p } }); }
          catch (e) {
            if (!(e instanceof CrmError) || e.kind !== "validation") throw e;
            const missing = missingProperties(e).filter((n) => n in p);
            if (!missing.length) throw e;
            const stageProp = mapping.stage;
            if (stageProp && missing.includes(stageProp) && !triedCreateProperty) {
              triedCreateProperty = true;
              try {
                await call(tokens, "/crm/v3/properties/contacts", { json: { groupName: "contactinformation", name: stageProp, label: "Outreach stage", type: "string", fieldType: "text", description: "Stage of this person in CapitalxAI Outreach" } });
                continue; // property exists now: retry with it
              } catch { /* no schema scope or no permission: the value goes in a note */ }
            }
            for (const n of missing) { if (inverse[n] && NOTE_FALLBACK_FIELDS.includes(inverse[n])) leftover[inverse[n]] = p[n]; delete p[n]; }
          }
        }
        throw new CrmError("hubspot", "validation", 400, "HubSpot kept rejecting the contact properties");
      };

      const update = async (id: string): Promise<boolean> => {
        try { await send(`/crm/v3/objects/contacts/${id}`, "PATCH", opts.overwriteExisting ? all : owned); return true; }
        catch (e) { if (e instanceof CrmError && e.kind === "not_found") return false; throw e; }
      };

      if (opts.existing?.contactId && await update(opts.existing.contactId)) {
        return { contactId: opts.existing.contactId, companyId: opts.existing.companyId ?? null, created: false, leftover };
      }
      const liProp = mapping.linkedin_url;
      let found = lead.email ? await search(tokens, "contacts", "email", lead.email, ["associatedcompanyid"]) : null;
      if (!found && liProp && lead.linkedin_url) {
        try { found = await search(tokens, "contacts", liProp, lead.linkedin_url, ["associatedcompanyid"]); } catch (e) { if (!(e instanceof CrmError) || e.kind !== "validation") throw e; }
      }
      if (found?.id && await update(String(found.id))) {
        return { contactId: String(found.id), companyId: found.properties?.associatedcompanyid ?? null, created: false, leftover };
      }
      let contactId: string;
      try {
        const created = await send("/crm/v3/objects/contacts", "POST", all);
        contactId = String(created.id);
      } catch (e) {
        // 409: someone created the same email a moment ago
        const m = e instanceof CrmError && e.status === 409 ? /Existing ID:\s*(\d+)/i.exec(e.body) : null;
        if (!m) throw e;
        await update(m[1]);
        return { contactId: m[1], companyId: null, created: false, leftover };
      }
      // a company is only created / linked for contacts we created: existing CRM records keep their associations
      let companyId: string | null = null;
      if (lead.company && mapping.company) {
        try {
          companyId = await ensureCompany(tokens, lead, lead.company);
          if (companyId) await associate(tokens, "contacts", contactId, "companies", companyId);
        } catch (e) { if (e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit")) throw e; companyId = null; }
      }
      return { contactId, companyId, created: true, leftover };
    },

    async logActivity(tokens, contactId, a: ActivityInput) {
      const at = new Date(a.at || Date.now()).toISOString();
      const note = async () => {
        const r = await call(tokens, "/crm/v3/objects/notes", { json: { properties: { hs_timestamp: at, hs_note_body: activityHtml(a) }, associations: [{ to: { id: contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }] } });
        if (a.dealId && r?.id) { try { await associate(tokens, "notes", String(r.id), "deals", a.dealId); } catch { /* the note is on the contact already */ } }
        return { id: r?.id ? String(r.id) : null };
      };
      if (a.note) return await note();
      try {
        const object = a.channel === "email" ? "emails" : "communications";
        const properties: Record<string, string> = a.channel === "email"
          ? { hs_timestamp: at, hs_email_direction: a.direction === "in" ? "INCOMING_EMAIL" : "EMAIL", hs_email_status: "SENT", hs_email_subject: a.subject ?? "", hs_email_text: activityText(a) }
          : { hs_timestamp: at, hs_communication_channel_type: "LINKEDIN_MESSAGE", hs_communication_logged_from: "CRM", hs_communication_body: activityHtml(a) };
        const r = await call(tokens, `/crm/v3/objects/${object}`, { json: { properties } });
        const id = String(r.id);
        try { await associate(tokens, object, id, "contacts", contactId); }
        catch (e) {
          // never leave an engagement nobody can see: remove it and fall back to a note
          try { await call(tokens, `/crm/v3/objects/${object}/${id}`, { method: "DELETE" }); } catch { /* ignore */ }
          throw e;
        }
        return { id };
      } catch (e) {
        if (e instanceof CrmError && (e.kind === "validation" || e.kind === "forbidden" || e.kind === "not_found")) return await note();
        throw e;
      }
    },

    async setStage(tokens, ids, target: StageTarget) {
      const done = { contact: false, deal: false };
      if (target.contact) {
        // HubSpot only moves the lifecycle stage forward through the API; a backward move is ignored by HubSpot.
        await call(tokens, `/crm/v3/objects/contacts/${ids.contactId}`, { method: "PATCH", json: { properties: { lifecyclestage: target.contact } } });
        done.contact = true;
      }
      if (target.deal && ids.dealId) {
        await call(tokens, `/crm/v3/objects/deals/${ids.dealId}`, { method: "PATCH", json: { properties: { dealstage: target.deal } } });
        done.deal = true;
      }
      return done;
    },

    async createDeal(tokens, contactId, deal: DealInput) {
      let pipeline = deal.pipeline ?? null, stage = deal.stage ?? null;
      if (!stage || !pipeline) {
        const p = await call(tokens, "/crm/v3/pipelines/deals");
        const pipes = [...(p?.results ?? [])].sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));
        const pipe = pipes.find((x: any) => x.id === pipeline) ?? (stage ? pipes.find((x: any) => (x.stages ?? []).some((s: any) => s.id === stage)) : null) ?? pipes[0];
        if (!pipe) throw new CrmError("hubspot", "validation", 400, "this HubSpot account has no deal pipeline");
        pipeline = pipe.id;
        if (!stage) stage = [...(pipe.stages ?? [])].sort((a: any, b: any) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0))[0]?.id ?? null;
      }
      const properties: Record<string, string> = { dealname: deal.name, pipeline: String(pipeline), dealstage: String(stage) };
      if (deal.amount != null) properties.amount = String(deal.amount);
      const r = await call(tokens, "/crm/v3/objects/deals", { json: { properties } });
      const dealId = String(r.id);
      await associate(tokens, "deals", dealId, "contacts", contactId);
      if (deal.companyId) { try { await associate(tokens, "deals", dealId, "companies", deal.companyId); } catch { /* optional */ } }
      return { dealId };
    },

    async listSegments(tokens): Promise<Segment[]> {
      const out: Segment[] = [];
      let offset = 0;
      for (let page = 0; page < 5; page++) {
        const r = await call(tokens, "/crm/v3/lists/search", { json: { objectTypeId: "0-1", count: 200, offset, additionalProperties: ["hs_list_size"] } });
        for (const l of r?.lists ?? []) {
          const size = Number(l.size ?? l.additionalProperties?.hs_list_size);
          out.push({ id: String(l.listId), name: l.name, kind: l.processingType === "DYNAMIC" ? "Active list" : "Static list", size: Number.isFinite(size) ? size : null });
        }
        if (!r?.hasMore) break;
        offset = Number(r.offset ?? offset + 200);
      }
      return out;
    },

    async importSegment(tokens, segmentId, cursor): Promise<SegmentPage> {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("after", cursor);
      const m = await call(tokens, `/crm/v3/lists/${encodeURIComponent(segmentId)}/memberships?${q}`);
      const ids: string[] = (m?.results ?? []).map((x: any) => String(x.recordId ?? x)).filter(Boolean);
      const next = m?.paging?.next?.after ?? null;
      if (!ids.length) return { leads: [], next };
      const b = await call(tokens, "/crm/v3/objects/contacts/batch/read", { json: { properties: IMPORT_PROPS, inputs: ids.map((id) => ({ id })) } });
      const leads: ImportedLead[] = (b?.results ?? []).map((c: any) => {
        const p = c.properties ?? {};
        return { crm_contact_id: String(c.id), crm_company_id: p.associatedcompanyid || null, first_name: p.firstname || null, last_name: p.lastname || null, email: p.email || null, title: p.jobtitle || null, company: p.company || null, linkedin_url: p.hs_linkedin_url || null, phone: p.phone || null };
      });
      return { leads, next };
    },

    async listCustomersAndOpenDeals(tokens, cursor): Promise<BlacklistPage> {
      // cursor = { phase, after }: 0 customer contacts, 1 customer companies, 2 open deals (their contacts + companies)
      const c: { phase: number; after: string | null } = cursor ? JSON.parse(cursor) : { phase: 0, after: null };
      const page: BlacklistPage = { emails: [], domains: [], companies: [], next: null };
      const searchPage = (object: string, filter: Record<string, string>, properties: string[]) =>
        call(tokens, `/crm/v3/objects/${object}/search`, { json: { filterGroups: [{ filters: [filter] }], properties, limit: 100, ...(c.after ? { after: c.after } : {}) } });
      const advance = (r: any) => {
        const after = r?.paging?.next?.after ?? null;
        // the search API stops at 10,000 results per query
        if (after && Number(after) < 10_000) page.next = JSON.stringify({ phase: c.phase, after: String(after) });
        else page.next = c.phase < 2 ? JSON.stringify({ phase: c.phase + 1, after: null }) : null;
      };
      if (c.phase === 0) {
        const r = await searchPage("contacts", { propertyName: "lifecyclestage", operator: "EQ", value: "customer" }, ["email"]);
        for (const x of r?.results ?? []) if (x.properties?.email) page.emails.push(x.properties.email);
        advance(r);
      } else if (c.phase === 1) {
        const r = await searchPage("companies", { propertyName: "lifecyclestage", operator: "EQ", value: "customer" }, ["domain", "name"]);
        for (const x of r?.results ?? []) { if (x.properties?.domain) page.domains.push(x.properties.domain); if (x.properties?.name) page.companies.push(x.properties.name); }
        advance(r);
      } else {
        const r = await searchPage("deals", { propertyName: "hs_is_closed", operator: "EQ", value: "false" }, ["dealname"]);
        const dealIds: string[] = (r?.results ?? []).map((d: any) => String(d.id));
        if (dealIds.length) {
          const linked = async (to: string): Promise<string[]> => {
            const a = await call(tokens, `/crm/v4/associations/deals/${to}/batch/read`, { json: { inputs: dealIds.map((id) => ({ id })) } });
            const ids = new Set<string>();
            for (const row of a?.results ?? []) for (const t of row.to ?? []) ids.add(String(t.toObjectId));
            return [...ids];
          };
          const read = async (object: string, ids: string[], properties: string[]): Promise<any[]> => {
            const out: any[] = [];
            for (let i = 0; i < ids.length; i += 100) {
              const b = await call(tokens, `/crm/v3/objects/${object}/batch/read`, { json: { properties, inputs: ids.slice(i, i + 100).map((id) => ({ id })) } });
              out.push(...(b?.results ?? []));
            }
            return out;
          };
          for (const co of await read("companies", await linked("companies"), ["domain", "name"])) { if (co.properties?.domain) page.domains.push(co.properties.domain); if (co.properties?.name) page.companies.push(co.properties.name); }
          for (const ct of await read("contacts", await linked("contacts"), ["email"])) if (ct.properties?.email) page.emails.push(ct.properties.email);
        }
        advance(r);
      }
      return page;
    },
  };
}
