// Salesforce: OAuth web-server flow with PKCE (required on connected / external client apps since 2026), REST sObjects + SOQL,
// upsert by external id when the org has one, Tasks for the timeline, list views + campaigns for import.
// New people are created as Leads by default (settings.salesforce_object = "Contact" switches that); an existing Contact is always reused.
import { bearer, crmRequest, type CrmRequest } from "./http.ts";
import { activityText, activityTitle, mapFields, NOTE_FALLBACK_FIELDS, splitName, unmappedOwned } from "./mapping.ts";
import { CrmError, type ActivityInput, type BlacklistPage, type CrmLead, type CrmProvider, type CrmTokens, type DealInput, type ImportedLead, type ProviderEnv, type Segment, type SegmentPage, type StageTarget, type UpsertOptions, type UpsertResult } from "./types.ts";

export const SALESFORCE_SCOPES = ["api", "refresh_token"]; // shown in Salesforce as "Manage user data via APIs" and "Perform requests at any time"

const isLeadId = (id: string) => id.startsWith("00Q");
const q = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
const SF_ID = /^[a-zA-Z0-9]{15,18}$/;

export function salesforceProvider(env: ProviderEnv): CrmProvider {
  const login = (env.extra?.loginUrl || "https://login.salesforce.com").replace(/\/+$/, "");
  const version = env.extra?.apiVersion || "v62.0";

  function base(tokens: CrmTokens): string {
    if (!tokens.instance_url) throw new CrmError("salesforce", "auth", 401, "Salesforce instance URL is missing. Reconnect the integration.");
    return tokens.instance_url.replace(/\/+$/, "");
  }
  const raw = <T = any>(tokens: CrmTokens, path: string, req: CrmRequest = {}) =>
    crmRequest<T>(env.fetch, "salesforce", `${base(tokens)}${path}`, { ...req, headers: { ...bearer(tokens.access_token), ...(req.headers ?? {}) } });
  const data = <T = any>(tokens: CrmTokens, path: string, req: CrmRequest = {}) => raw<T>(tokens, `/services/data/${version}${path}`, req);
  const soql = (tokens: CrmTokens, query: string) => data(tokens, `/query?q=${encodeURIComponent(query)}`);
  const first = async (tokens: CrmTokens, query: string): Promise<any | null> => (await soql(tokens, query))?.records?.[0] ?? null;

  function toTokens(r: any, previous?: CrmTokens): CrmTokens {
    if (!r?.access_token) throw new CrmError("salesforce", "auth", 400, "Salesforce did not return an access token");
    // Salesforce does not say when the access token ends; we refresh on the first 401.
    return { access_token: r.access_token, refresh_token: r.refresh_token ?? previous?.refresh_token ?? null, expires_at: null, instance_url: r.instance_url ?? previous?.instance_url ?? null };
  }

  /** Mapping targets are Lead field names; translate them for the object we write. `account` is returned apart. */
  function fieldsFor(object: "Lead" | "Contact", mapped: Record<string, string>): { fields: Record<string, string>; account: string | null } {
    const fields: Record<string, string> = {};
    let account: string | null = null;
    for (const [target, value] of Object.entries(mapped)) {
      if (target === "Company" || target === "Account") { if (object === "Lead") fields.Company = value.slice(0, 255); else account = value.slice(0, 255); }
      else if (target === "City") fields[object === "Lead" ? "City" : "MailingCity"] = value.slice(0, 40);
      else if (target === "Status" && object === "Contact") continue;
      else fields[target] = value;
    }
    return { fields, account };
  }

  /** Field names Salesforce says it does not know, read from a 400 body. */
  function unknownFields(e: CrmError): string[] {
    const names = new Set<string>();
    for (const m of e.body.matchAll(/No such column '([A-Za-z0-9_]+)'/g)) names.add(m[1]);
    try { for (const row of JSON.parse(e.body)) if (row?.errorCode === "INVALID_FIELD_FOR_INSERT_UPDATE" || row?.errorCode === "INVALID_FIELD") for (const f of row.fields ?? []) names.add(String(f)); } catch { /* not JSON */ }
    return [...names];
  }

  return {
    name: "salesforce",
    label: "Salesforce",
    scopes: SALESFORCE_SCOPES,
    configured: () => !!env.clientId && !!env.clientSecret,

    authorizeUrl(state, redirectUri, codeChallenge) {
      const p = new URLSearchParams({ response_type: "code", client_id: env.clientId, redirect_uri: redirectUri, scope: SALESFORCE_SCOPES.join(" "), state });
      if (codeChallenge) { p.set("code_challenge", codeChallenge); p.set("code_challenge_method", "S256"); }
      return `${login}/services/oauth2/authorize?${p}`;
    },

    async exchangeCode(code, redirectUri, codeVerifier) {
      const form: Record<string, string> = { grant_type: "authorization_code", code, client_id: env.clientId, client_secret: env.clientSecret, redirect_uri: redirectUri };
      if (codeVerifier) form.code_verifier = codeVerifier;
      return toTokens(await crmRequest(env.fetch, "salesforce", `${login}/services/oauth2/token`, { form }));
    },

    async refresh(tokens) {
      if (!tokens.refresh_token) throw new CrmError("salesforce", "auth", 401, "no refresh token stored");
      const r = await crmRequest(env.fetch, "salesforce", `${login}/services/oauth2/token`, { form: { grant_type: "refresh_token", client_id: env.clientId, client_secret: env.clientSecret, refresh_token: tokens.refresh_token } });
      return toTokens(r, tokens);
    },

    async accountLabel(tokens) {
      const u = await raw(tokens, "/services/oauth2/userinfo");
      let org: string | null = null;
      try { org = (await first(tokens, "SELECT Name FROM Organization LIMIT 1"))?.Name ?? null; } catch { /* label falls back to the user */ }
      const who = u?.preferred_username ?? u?.email ?? null;
      return org ? `${org}${who ? ` (${who})` : ""}` : (who ?? "Salesforce");
    },

    async upsertContact(tokens, lead: CrmLead, opts: UpsertOptions): Promise<UpsertResult> {
      const mapping = opts.mapping as Record<string, string>;
      const inverse: Record<string, string> = Object.fromEntries(Object.entries(mapping).map(([ours, theirs]) => [theirs, ours]));
      const leftover: Record<string, string> = unmappedOwned(lead, mapping);
      const all = mapFields(lead, mapping), owned = mapFields(lead, mapping, { ownedOnly: true });

      // write with self-healing: a mapped custom field may exist on Lead but not on Contact (or not at all)
      const write = async (path: string, method: string, fields: Record<string, string>): Promise<any> => {
        const f = { ...fields };
        for (let attempt = 0; attempt < 4; attempt++) {
          if (method === "PATCH" && !path.includes("__c/") && Object.keys(f).length === 0) return null;
          try { return await data(tokens, path, { method, json: f }); }
          catch (e) {
            if (!(e instanceof CrmError) || e.kind !== "validation") throw e;
            const unknown = unknownFields(e).filter((n) => n in f);
            if (!unknown.length) throw e;
            for (const n of unknown) { if (inverse[n] && NOTE_FALLBACK_FIELDS.includes(inverse[n])) leftover[inverse[n]] = f[n]; delete f[n]; }
          }
        }
        throw new CrmError("salesforce", "validation", 400, "Salesforce kept rejecting the mapped fields");
      };

      const update = async (id: string): Promise<boolean> => {
        const object = isLeadId(id) ? "Lead" : "Contact";
        try { await write(`/sobjects/${object}/${id}`, "PATCH", fieldsFor(object, opts.overwriteExisting ? all : owned).fields); return true; }
        catch (e) {
          // deleted, merged or converted since we linked it: look the person up again
          if (e instanceof CrmError && (e.kind === "not_found" || /ENTITY_IS_DELETED|CANNOT_UPDATE_CONVERTED_LEAD/.test(e.body))) return false;
          throw e;
        }
      };

      if (opts.existing?.contactId && await update(opts.existing.contactId)) return { contactId: opts.existing.contactId, companyId: opts.existing.companyId ?? null, created: false, leftover };

      const name = splitName(lead);
      let found: any | null = null;
      if (lead.email) {
        found = await first(tokens, `SELECT Id, AccountId FROM Contact WHERE Email = '${q(lead.email)}' ORDER BY LastModifiedDate DESC LIMIT 1`)
          ?? await first(tokens, `SELECT Id FROM Lead WHERE Email = '${q(lead.email)}' AND IsConverted = false ORDER BY LastModifiedDate DESC LIMIT 1`);
      } else if (name.last && lead.company) {
        const fn = name.first ? ` AND FirstName = '${q(name.first)}'` : "";
        found = await first(tokens, `SELECT Id, AccountId FROM Contact WHERE LastName = '${q(name.last)}'${fn} AND Account.Name = '${q(lead.company)}' LIMIT 1`)
          ?? await first(tokens, `SELECT Id FROM Lead WHERE LastName = '${q(name.last)}'${fn} AND Company = '${q(lead.company)}' AND IsConverted = false LIMIT 1`);
      }
      if (found?.Id && await update(found.Id)) return { contactId: found.Id, companyId: found.AccountId ?? null, created: false, leftover };

      const object: "Lead" | "Contact" = opts.settings?.salesforce_object === "Contact" ? "Contact" : "Lead";
      const { fields, account } = fieldsFor(object, all);
      if (!fields.LastName) { if (name.first && !fields.FirstName) fields.FirstName = name.first; fields.LastName = name.last ?? name.full; }
      let companyId: string | null = null;
      if (object === "Lead") { if (!fields.Company) fields.Company = lead.company ?? "[not provided]"; }
      else if (account) {
        const acc = await first(tokens, `SELECT Id FROM Account WHERE Name = '${q(account)}' LIMIT 1`);
        companyId = acc?.Id ?? (await data(tokens, "/sobjects/Account", { json: { Name: account } }))?.id ?? null;
        if (companyId) fields.AccountId = companyId;
      }
      const ext = opts.settings?.salesforce_external_id_field;
      const r = ext && /^[A-Za-z0-9_]+__c$/.test(ext)
        ? await write(`/sobjects/${object}/${ext}/${encodeURIComponent(lead.id)}`, "PATCH", fields) // upsert by external id: safe to repeat
        : await write(`/sobjects/${object}`, "POST", fields);
      if (!r?.id) throw new CrmError("salesforce", "validation", 400, "Salesforce did not return the new record id");
      return { contactId: String(r.id), companyId, created: r.created !== false, leftover };
    },

    async logActivity(tokens, contactId, a: ActivityInput) {
      const at = new Date(a.at || Date.now());
      const body: Record<string, unknown> = {
        WhoId: contactId, Subject: activityTitle(a).slice(0, 255), Description: activityText(a), Status: "Completed", Priority: "Normal",
        ActivityDate: at.toISOString().slice(0, 10), TaskSubtype: !a.note && a.channel === "email" ? "Email" : "Task",
      };
      if (a.dealId && !isLeadId(contactId)) body.WhatId = a.dealId; // a task on a Lead cannot point at an opportunity
      const r = await data(tokens, "/sobjects/Task", { json: body });
      return { id: r?.id ? String(r.id) : null };
    },

    async setStage(tokens, ids, target: StageTarget) {
      const done = { contact: false, deal: false };
      if (target.contact && isLeadId(ids.contactId)) { // contacts have no status in Salesforce
        await data(tokens, `/sobjects/Lead/${ids.contactId}`, { method: "PATCH", json: { Status: target.contact } });
        done.contact = true;
      }
      if (target.deal && ids.dealId) {
        await data(tokens, `/sobjects/Opportunity/${ids.dealId}`, { method: "PATCH", json: { StageName: target.deal } });
        done.deal = true;
      }
      return done;
    },

    async createDeal(tokens, contactId, deal: DealInput) {
      if (isLeadId(contactId)) throw new CrmError("salesforce", "unsupported", 400, "A Salesforce lead cannot hold an opportunity. Convert the lead in Salesforce, or set the integration to create contacts.");
      const c = await data(tokens, `/sobjects/Contact/${contactId}?fields=AccountId`);
      const stage = deal.stage ?? (await first(tokens, "SELECT MasterLabel FROM OpportunityStage WHERE IsActive = true AND IsClosed = false ORDER BY SortOrder LIMIT 1"))?.MasterLabel ?? "Prospecting";
      const body: Record<string, unknown> = { Name: deal.name.slice(0, 120), StageName: stage, CloseDate: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) };
      if (c?.AccountId ?? deal.companyId) body.AccountId = c?.AccountId ?? deal.companyId;
      if (deal.amount != null) body.Amount = deal.amount;
      const r = await data(tokens, "/sobjects/Opportunity", { json: body });
      const dealId = String(r.id);
      try { await data(tokens, "/sobjects/OpportunityContactRole", { json: { OpportunityId: dealId, ContactId: contactId, IsPrimary: true } }); } catch (e) { if (e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit")) throw e; }
      return { dealId };
    },

    async listSegments(tokens): Promise<Segment[]> {
      const out: Segment[] = [];
      for (const object of ["Lead", "Contact"]) {
        try {
          const r = await data(tokens, `/sobjects/${object}/listviews`);
          for (const v of r?.listviews ?? []) out.push({ id: `listview:${object}:${v.id}`, name: v.label, kind: `${object} list view`, size: null });
        } catch (e) { if (e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit")) throw e; }
      }
      try {
        const r = await soql(tokens, "SELECT Id, Name, NumberOfLeads, NumberOfContacts FROM Campaign WHERE IsActive = true ORDER BY LastModifiedDate DESC LIMIT 200");
        for (const c of r?.records ?? []) out.push({ id: `campaign:${c.Id}`, name: c.Name, kind: "Campaign", size: (Number(c.NumberOfLeads) || 0) + (Number(c.NumberOfContacts) || 0) });
      } catch (e) { if (e instanceof CrmError && (e.kind === "auth" || e.kind === "rate_limit")) throw e; /* campaigns need Marketing User */ }
      return out;
    },

    async importSegment(tokens, segmentId, cursor): Promise<SegmentPage> {
      let r: any;
      if (cursor) {
        if (!cursor.startsWith("/services/data/")) throw new CrmError("salesforce", "validation", 400, "bad cursor");
        r = await raw(tokens, cursor);
      } else {
        const [kind, a, b] = segmentId.split(":");
        if (kind === "campaign" && SF_ID.test(a ?? "")) {
          r = await soql(tokens, `SELECT ContactId, LeadId, FirstName, LastName, Email, Title, CompanyOrAccount, Phone FROM CampaignMember WHERE CampaignId = '${a}'`);
        } else if (kind === "listview" && (a === "Lead" || a === "Contact") && SF_ID.test(b ?? "")) {
          const d = await data(tokens, `/sobjects/${a}/listviews/${b}/describe`);
          const select = a === "Lead" ? "SELECT Id, FirstName, LastName, Email, Title, Company, Phone" : "SELECT Id, FirstName, LastName, Email, Title, Account.Name, AccountId, Phone";
          const from = /\sFROM\s+(Lead|Contact)\b/i.exec(String(d?.query ?? ""));
          if (!from) throw new CrmError("salesforce", "validation", 400, "Salesforce did not describe this list view");
          r = await soql(tokens, `${select}${String(d.query).slice(from.index)}`);
        } else throw new CrmError("salesforce", "validation", 400, "unknown segment");
      }
      const leads: ImportedLead[] = (r?.records ?? []).map((x: any): ImportedLead | null => {
        const id = x.Id ?? x.ContactId ?? x.LeadId;
        if (!id || x.attributes?.type === "CampaignMember" && !x.ContactId && !x.LeadId) return null;
        return { crm_contact_id: String(x.attributes?.type === "CampaignMember" ? (x.ContactId ?? x.LeadId) : id), crm_company_id: x.AccountId ?? null, first_name: x.FirstName ?? null, last_name: x.LastName ?? null, email: x.Email ?? null, title: x.Title ?? null, company: x.Company ?? x.CompanyOrAccount ?? x.Account?.Name ?? null, phone: x.Phone ?? null, linkedin_url: null };
      }).filter((x: ImportedLead | null): x is ImportedLead => !!x);
      return { leads, next: r?.done === false && r?.nextRecordsUrl ? String(r.nextRecordsUrl) : null };
    },

    async listCustomersAndOpenDeals(tokens, cursor): Promise<BlacklistPage> {
      // cursor = { phase, next }: 0 customer accounts, 1 their contacts, 2 accounts with an open opportunity, 3 contacts on open opportunities
      const QUERIES = [
        "SELECT Name, Website FROM Account WHERE Type LIKE 'Customer%'",
        "SELECT Email FROM Contact WHERE Email != null AND Account.Type LIKE 'Customer%'",
        "SELECT Account.Name, Account.Website FROM Opportunity WHERE IsClosed = false AND AccountId != null",
        "SELECT Contact.Email FROM OpportunityContactRole WHERE Opportunity.IsClosed = false AND Contact.Email != null",
      ];
      const c: { phase: number; next: string | null } = cursor ? JSON.parse(cursor) : { phase: 0, next: null };
      if (c.next && !c.next.startsWith("/services/data/")) throw new CrmError("salesforce", "validation", 400, "bad cursor");
      const r = c.next ? await raw(tokens, c.next) : await soql(tokens, QUERIES[c.phase]);
      const page: BlacklistPage = { emails: [], domains: [], companies: [], next: null };
      for (const x of r?.records ?? []) {
        const acc = x.Account ?? x;
        const email = x.Email ?? x.Contact?.Email;
        if (email) page.emails.push(email);
        if (acc?.Name && c.phase !== 1) page.companies.push(acc.Name);
        if (acc?.Website) page.domains.push(acc.Website);
      }
      if (r?.done === false && r?.nextRecordsUrl) page.next = JSON.stringify({ phase: c.phase, next: r.nextRecordsUrl });
      else page.next = c.phase < QUERIES.length - 1 ? JSON.stringify({ phase: c.phase + 1, next: null }) : null;
      return page;
    },
  };
}
