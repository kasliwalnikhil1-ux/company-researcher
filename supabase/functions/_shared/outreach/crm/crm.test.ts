// deno test --node-modules-dir=none supabase/functions/_shared/outreach/crm/crm.test.ts
// Pure rules + the push engine with a fake provider and a fake store + each provider against a scripted fetch.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { processBatch, processEvent, type CrmLink, type EngineContext, type Integration, type LogRow, type MessageInfo, type SyncStore } from "./engine.ts";
import { activityTitle, DEFAULT_FIELD_MAPPING, diffSuppressions, effectiveMapping, emailDomain, linkedinIdentifier, mapFields, messageMarker, normaliseSuppression, planEvent, resolveStage, shouldLogSkip, trimText, unmappedOwned, type IntegrationEvent } from "./mapping.ts";
import { hubspotProvider } from "./hubspot.ts";
import { pipedriveProvider } from "./pipedrive.ts";
import { salesforceProvider } from "./salesforce.ts";
import { CrmError, type CrmLead, type CrmProvider, type CrmTokens, type FetchLike } from "./types.ts";

const LEAD: CrmLead = { id: "11111111-1111-1111-1111-111111111111", first_name: "Ada", last_name: "Lovelace", full_name: "Ada Lovelace", email: "ada@engines.io", email_work: "ada@engines.io", email_personal: null, title: "CTO", company: "Analytical Engines", linkedin_url: "https://www.linkedin.com/in/ada", phone: null, location: "London", headline: null, stage: "Interested", custom: { plan: "pro" } };
const TOKENS: CrmTokens = { access_token: "at", refresh_token: "rt", expires_at: null, instance_url: "https://acme.example.com" };

// ---------------------------------------------------------------------------
// field mapping
// ---------------------------------------------------------------------------
Deno.test("field mapping: {} uses the defaults plus the automatic Outreach stage property", () => {
  const m = effectiveMapping("hubspot", {});
  assertEquals(m.stage, "outreach_stage");
  assertEquals(mapFields(LEAD, m), { firstname: "Ada", lastname: "Lovelace", email: "ada@engines.io", jobtitle: "CTO", company: "Analytical Engines", city: "London", hs_linkedin_url: "https://www.linkedin.com/in/ada", outreach_stage: "Interested" });
});

Deno.test("field mapping: a non-empty map replaces the defaults; stage can be switched off", () => {
  const m = effectiveMapping("hubspot", { email_work: "email", "custom.plan": "plan_tier" });
  assertEquals(mapFields(LEAD, m), { email: "ada@engines.io", plan_tier: "pro", outreach_stage: "Interested" });
  assertEquals(effectiveMapping("hubspot", { email_work: "email", stage: "" }).stage, undefined);
  assertEquals(effectiveMapping("hubspot", {}, { write_outreach_stage: false }).stage, undefined);
  assertEquals(effectiveMapping("salesforce", {}), DEFAULT_FIELD_MAPPING.salesforce); // Salesforce has no field we may create
});

Deno.test("field mapping: owned-only, empty values, work email falls back to the personal one", () => {
  const m = effectiveMapping("hubspot", {});
  assertEquals(mapFields(LEAD, m, { ownedOnly: true }), { hs_linkedin_url: "https://www.linkedin.com/in/ada", outreach_stage: "Interested" });
  const personal = { ...LEAD, email: "ada@home.org", email_work: null, email_personal: "ada@home.org", title: "  " };
  const out = mapFields(personal, m);
  assertEquals(out.email, "ada@home.org");
  assert(!("jobtitle" in out));
  assertEquals(unmappedOwned(LEAD, effectiveMapping("salesforce", {})), { stage: "Interested", linkedin_url: "https://www.linkedin.com/in/ada" });
});

// ---------------------------------------------------------------------------
// stage mapping
// ---------------------------------------------------------------------------
Deno.test("stage mapping: defaults, replace semantics, per-provider meaning of a string", () => {
  const interested = { id: "s1", name: "Interested", kind: "interested" };
  assertEquals(resolveStage(interested, "hubspot", {}), { contact: "marketingqualifiedlead" });
  assertEquals(resolveStage(interested, "hubspot", { replied: "lead" }), null); // non-empty map: a missing kind is not pushed
  assertEquals(resolveStage(interested, "pipedrive", { interested: "7" }), { deal: "7" });
  assertEquals(resolveStage(interested, "salesforce", { interested: "Working - Contacted" }), { contact: "Working - Contacted" });
  assertEquals(resolveStage(interested, "hubspot", { interested: { contact: "opportunity", deal: "qualifiedtobuy" } }), { contact: "opportunity", deal: "qualifiedtobuy" });
  assertEquals(resolveStage({ id: "s9", name: "Hot", kind: null }, "hubspot", { hot: "opportunity" }), { contact: "opportunity" }); // by name
  assertEquals(resolveStage(null, "hubspot", {}), null);
});

Deno.test("stage mapping: won / lost always reach the deal", () => {
  assertEquals(resolveStage({ id: "w", name: "Won", kind: "won" }, "hubspot", {}), { contact: "customer", deal: "closedwon" });
  assertEquals(resolveStage({ id: "l", name: "Lost", kind: "lost" }, "pipedrive", {}), { deal: "lost" });
  assertEquals(resolveStage({ id: "w", name: "Won", kind: "won" }, "pipedrive", { won: "12" }), { deal: "12" });
});

// ---------------------------------------------------------------------------
// event → operations
// ---------------------------------------------------------------------------
const ev = (event: string, payload: Record<string, unknown>, id = 1): IntegrationEvent => ({ id, event, payload, at: "2026-09-20T10:00:00.000Z" });

Deno.test("planning: messages, stage changes, interested, meetings", () => {
  assertEquals(planEvent(ev("message.received", { lead_id: "L", id: "m" }), {}).ops.map((o) => o.op), ["ensure_contact", "log_message"]);
  assertEquals(planEvent(ev("email.sent", { lead_id: "L" }), { log_messages: false }).ops.map((o) => o.op), ["ensure_contact"]);
  assertEquals(planEvent(ev("lead.updated", { id: "L", stage_id: "S" }), {}), { leadId: "L", ops: [{ op: "ensure_contact", force: true }, { op: "set_stage", stageId: "S" }] });
  assertEquals(planEvent(ev("message.classified", { lead_id: "L", intent: "interested" }), { create_deal_on_interested: true }).ops.map((o) => o.op), ["ensure_contact", "create_deal"]);
  assertEquals(planEvent(ev("message.classified", { lead_id: "L", intent: "interested" }), {}).ops.map((o) => o.op), ["ensure_contact"]);
  assertEquals(planEvent(ev("message.classified", { lead_id: "L", intent: "not_now" }), { create_deal_on_interested: true }).ops, []);
  const meeting = planEvent(ev("meeting.booked", { lead_id: "L", starts_at: "2026-09-22T15:30:00Z", provider: "calendly" }), {});
  assertEquals(meeting.ops.map((o) => o.op), ["ensure_contact", "note", "set_stage"]);
  assertEquals((meeting.ops[1] as { text: string }).text, "Meeting booked for 2026-09-22 15:30 UTC (calendly).");
  assertEquals(planEvent(ev("message.sent", { lead_id: null }), {}).leadId, null);
  assertEquals(planEvent(ev("sender.paused", { lead_id: "L" }), {}).ops, []);
});

// ---------------------------------------------------------------------------
// skip-log throttling + small helpers
// ---------------------------------------------------------------------------
Deno.test("skip log: once per lead per day", () => {
  const now = new Date("2026-09-20T18:00:00Z");
  assertEquals(shouldLogSkip(null, now), true);
  assertEquals(shouldLogSkip({ status: "skipped", at: "2026-09-20T01:00:00+00:00" }, now), false);
  assertEquals(shouldLogSkip({ status: "skipped", at: "2026-09-19T23:59:00+00:00" }, now), true);
  assertEquals(shouldLogSkip({ status: "ok", at: "2026-09-20T01:00:00+00:00" }, now), true);
});

Deno.test("helpers: trimming, attribution title, identifiers, blacklist diff", () => {
  assertEquals(trimText("x".repeat(2500)).length, 2000);
  assertEquals(activityTitle({ direction: "out", channel: "linkedin", text: "", at: "", sequence: "Founders Q3", step: 2 }), "LinkedIn message sent · Founders Q3 · Step 2");
  assertEquals(activityTitle({ direction: "in", channel: "email", text: "", at: "" }), "Email received");
  assertEquals(linkedinIdentifier("https://www.linkedin.com/in/Ada-L%C3%B8/?x=1"), "ada-lø");
  assertEquals(emailDomain("a@gmail.com"), null);
  assertEquals(emailDomain("a@Engines.io"), "engines.io");
  assertEquals(normaliseSuppression("domain", "https://www.Engines.io/about"), "engines.io");
  assertEquals(normaliseSuppression("domain", "gmail.com"), null);
  const d = diffSuppressions([{ id: "1", kind: "email", value: "old@x.com" }, { id: "2", kind: "domain", value: "engines.io" }], { emails: ["New@X.com"], domains: ["http://engines.io", "gmail.com"], companies: ["Engines Ltd"] });
  assertEquals(d.add, [{ kind: "email", value: "new@x.com" }, { kind: "company", value: "engines ltd" }]);
  assertEquals(d.removeIds, ["1"]);
  assertEquals(d.total, 3);
});

// ---------------------------------------------------------------------------
// engine with fakes
// ---------------------------------------------------------------------------
interface Fake { ctx: EngineContext; calls: string[]; logs: LogRow[]; links: Map<string, CrmLink>; allow: Set<string>; failWith: Map<string, CrmError> }

function fake(settings: Integration["settings"] = {}, provider: Integration["provider"] = "hubspot"): Fake {
  const calls: string[] = [], logs: LogRow[] = [], links = new Map<string, CrmLink>(), allow = new Set<string>(), failWith = new Map<string, CrmError>();
  const guard = (name: string) => { const e = failWith.get(name); if (e) throw e; };
  const p: CrmProvider = {
    name: provider, label: "FakeCRM", scopes: [], configured: () => true,
    authorizeUrl: () => "", exchangeCode: () => Promise.resolve(TOKENS), refresh: () => Promise.resolve(TOKENS), accountLabel: () => Promise.resolve("Fake"),
    upsertContact: (_t, lead, o) => { guard("upsert"); calls.push(`upsert:${lead.id}:${o.existing?.contactId ?? "new"}`); return Promise.resolve({ contactId: "C1", companyId: "CO1", created: !o.existing?.contactId, leftover: {} }); },
    logActivity: (_t, id, a) => { guard("activity"); calls.push(`activity:${id}:${a.note ? a.title : activityTitle(a)}`); return Promise.resolve({ id: "N1" }); },
    setStage: (_t, ids, target) => { guard("stage"); calls.push(`stage:${ids.contactId}:${JSON.stringify(target)}`); return Promise.resolve({ contact: !!target.contact, deal: !!target.deal }); },
    createDeal: (_t, id, d) => { guard("deal"); calls.push(`deal:${id}:${d.name}`); return Promise.resolve({ dealId: "D1" }); },
    listSegments: () => Promise.resolve([]), importSegment: () => Promise.resolve({ leads: [], next: null }), listCustomersAndOpenDeals: () => Promise.resolve({ emails: [], domains: [], companies: [], next: null }),
  };
  const message: MessageInfo = { id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", direction: "in", channel: "linkedin", text: "Sounds good", subject: null, at: "2026-09-20T09:59:00.000Z", sequence: "Founders Q3", step: 2 };
  const store: SyncStore = {
    loadLead: (id) => Promise.resolve({ ...LEAD, id }),
    shouldSync: (id) => Promise.resolve(allow.has(id)),
    getLink: (id) => Promise.resolve(links.get(id) ?? null),
    saveLink: (id, patch) => { links.set(id, { crm_contact_id: null, crm_company_id: null, crm_deal_id: null, last_synced_at: null, ...(links.get(id) ?? {}), ...patch }); return Promise.resolve(); },
    lastLog: (id) => { const l = [...logs].reverse().find((r) => r.lead_id === id); return Promise.resolve(l ? { status: l.status, at: new Date().toISOString() } : null); },
    lastDetail: (id, op) => Promise.resolve([...logs].reverse().find((r) => r.lead_id === id && r.op === op && r.status === "ok")?.detail ?? null),
    hasMarker: (id, op, marker) => Promise.resolve(logs.some((r) => r.lead_id === id && r.op === op && r.status === "ok" && r.detail.includes(marker))),
    log: (row) => { logs.push(row); return Promise.resolve(); },
    resolveMessage: () => Promise.resolve(message),
    history: () => Promise.resolve([{ ...message, id: "older", direction: "out", text: "Hi Ada", at: "2026-09-18T09:00:00.000Z" }]),
    stage: (id, kind) => Promise.resolve(id === "S-int" ? { id, name: "Interested", kind: "interested" } : kind === "meeting" ? { id: "S-meet", name: "Meeting", kind: "meeting" } : null),
  };
  const integration: Integration = { id: "I1", workspace_id: "W1", provider, settings, field_mapping: {}, stage_mapping: {}, last_event_id: 0 };
  return { ctx: { integration, provider: p, store, session: { call: (fn) => fn(TOKENS) } }, calls, logs, links, allow, failWith };
}

Deno.test("engine: a lead outside the sync rule is skipped and logged once", async () => {
  const f = fake();
  const r = await processBatch(f.ctx, [ev("message.sent", { lead_id: "L1" }, 1), ev("message.sent", { lead_id: "L1" }, 2), ev("enrollment.started", { lead_id: "L1" }, 3)], Date.now() + 5000);
  assertEquals([r.skipped, r.synced, r.lastEventId, r.stop], [3, 0, 3, null]);
  assertEquals(f.calls, []);
  assertEquals(f.logs.length, 1);
  assertEquals(f.logs[0].status, "skipped");
  assert(f.logs[0].detail.includes("only leads who replied"));
});

Deno.test("engine: first reply creates the contact, carries the conversation over, logs the message once", async () => {
  const f = fake(); f.allow.add("L1");
  const reply = ev("message.received", { lead_id: "L1", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }, 5);
  assertEquals(await processEvent(f.ctx, reply), "synced");
  assertEquals(f.calls, ["upsert:L1:new", "activity:C1:Conversation so far (1 message)", "activity:C1:LinkedIn message received · Founders Q3 · Step 2"]);
  assertEquals(f.links.get("L1")?.crm_contact_id, "C1");
  assert(f.logs.some((l) => l.op === "note.create" && l.detail.includes(messageMarker("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"))));
  // the same event again (at-least-once delivery): nothing is written twice
  const before = f.calls.length;
  assertEquals(await processEvent(f.ctx, reply), "synced");
  assertEquals(f.calls.length, before);
});

Deno.test("engine: stage change maps through the defaults and is not repeated", async () => {
  const f = fake(); f.allow.add("L1");
  await processEvent(f.ctx, ev("lead.updated", { id: "L1", stage_id: "S-int" }, 1));
  assert(f.calls.includes('stage:C1:{"contact":"marketingqualifiedlead"}'));
  const n = f.calls.filter((c) => c.startsWith("stage:")).length;
  await processEvent(f.ctx, ev("lead.updated", { id: "L1", stage_id: "S-int", list_id: "other" }, 2)); // list change only
  assertEquals(f.calls.filter((c) => c.startsWith("stage:")).length, n);
});

Deno.test("engine: interested creates one deal; meeting booked adds a note and the stage", async () => {
  const f = fake({ create_deal_on_interested: true }); f.allow.add("L1");
  await processEvent(f.ctx, ev("message.classified", { lead_id: "L1", intent: "interested" }, 1));
  await processEvent(f.ctx, ev("message.classified", { lead_id: "L1", intent: "interested" }, 2));
  assertEquals(f.calls.filter((c) => c.startsWith("deal:")), ["deal:C1:Analytical Engines - Ada Lovelace (Outreach)"]);
  assertEquals(f.links.get("L1")?.crm_deal_id, "D1");
  await processEvent(f.ctx, ev("meeting.booked", { lead_id: "L1", starts_at: "2026-09-22T15:30:00Z" }, 3));
  assert(f.calls.includes("activity:C1:Meeting booked"));
  assert(f.calls.includes('stage:C1:{"contact":"salesqualifiedlead"}'));
});

Deno.test("engine: 429 stops the batch without moving past the event; a rejected record is logged and passed", async () => {
  const f = fake(); f.allow.add("L1"); f.allow.add("L2");
  f.failWith.set("upsert", new CrmError("hubspot", "rate_limit", 429, "slow down"));
  let r = await processBatch(f.ctx, [ev("message.received", { lead_id: "L1", id: "m1" }, 10), ev("message.received", { lead_id: "L2", id: "m2" }, 11)], Date.now() + 5000);
  assertEquals([r.stop, r.lastEventId], ["rate_limit", 0]);
  f.failWith.set("upsert", new CrmError("hubspot", "validation", 400, "email is invalid"));
  r = await processBatch(f.ctx, [ev("message.received", { lead_id: "L1", id: "m1" }, 10)], Date.now() + 5000);
  assertEquals([r.stop, r.failed, r.lastEventId], [null, 1, 10]);
  assertEquals(f.logs.at(-1)?.status, "error");
  f.failWith.set("upsert", new CrmError("hubspot", "auth", 401, "expired"));
  r = await processBatch(f.ctx, [ev("message.received", { lead_id: "L1", id: "m1" }, 12)], Date.now() + 5000);
  assertEquals([r.stop, r.lastEventId], ["auth", 0]);
});

Deno.test("engine: an action the CRM cannot do is logged as skipped, not as an error", async () => {
  const f = fake({ create_deal_on_interested: true }, "salesforce"); f.allow.add("L1");
  f.failWith.set("deal", new CrmError("salesforce", "unsupported", 400, "A Salesforce lead cannot hold an opportunity."));
  assertEquals(await processEvent(f.ctx, ev("message.classified", { lead_id: "L1", intent: "interested" }, 1)), "synced");
  assertEquals(f.logs.at(-1)?.status, "skipped");
});

// ---------------------------------------------------------------------------
// providers against a scripted fetch
// ---------------------------------------------------------------------------
type Script = (url: string, init: RequestInit) => { status?: number; body?: unknown } | undefined;
function scripted(script: Script): { fetch: FetchLike; seen: { method: string; url: string; body: any }[] } {
  const seen: { method: string; url: string; body: any }[] = [];
  const fetch: FetchLike = (input, init = {}) => {
    const url = String(input);
    let body: any = init.body;
    try { body = JSON.parse(String(init.body)); } catch { /* form or none */ }
    seen.push({ method: init.method ?? "GET", url, body });
    const r = script(url, init) ?? { status: 404, body: { message: "not scripted" } };
    return Promise.resolve(r.status === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(r.body ?? {}), { status: r.status ?? 200 }));
  };
  return { fetch, seen };
}

Deno.test("hubspot: creates the missing Outreach stage property, then the contact, company and association", async () => {
  let propertyExists = false;
  const s = scripted((url, init) => {
    if (url.endsWith("/contacts/search") || url.endsWith("/companies/search")) return { body: { results: [] } };
    if (url.endsWith("/crm/v3/properties/contacts")) { propertyExists = true; return { status: 201, body: { name: "outreach_stage" } }; }
    if (url.endsWith("/crm/v3/objects/contacts") && init.method === "POST") {
      return propertyExists ? { status: 201, body: { id: "501" } } : { status: 400, body: { status: "error", category: "VALIDATION_ERROR", message: 'Property values were not valid: [{"isValid":false,"message":"Property \\"outreach_stage\\" does not exist","error":"PROPERTY_DOESNT_EXIST","name":"outreach_stage"}]' } };
    }
    if (url.endsWith("/crm/v3/objects/companies")) return { status: 201, body: { id: "900" } };
    if (url.includes("/associations/default/")) return { body: {} };
  });
  const p = hubspotProvider({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const r = await p.upsertContact(TOKENS, LEAD, { mapping: effectiveMapping("hubspot", {}) });
  assertEquals(r, { contactId: "501", companyId: "900", created: true, leftover: {} });
  assert(s.seen.some((c) => c.url.endsWith("/crm/v4/objects/contacts/501/associations/default/companies/900") && c.method === "PUT"));
  assertEquals(s.seen.find((c) => c.url.endsWith("/companies") && c.method === "POST")?.body.properties, { name: "Analytical Engines", domain: "engines.io" });
});

Deno.test("hubspot: an existing contact only gets the fields we own; a 401 surfaces as an auth error", async () => {
  const s = scripted((url, init) => {
    if (url.endsWith("/contacts/search")) return { body: { results: [{ id: "77", properties: { associatedcompanyid: "5" } }] } };
    if (url.endsWith("/contacts/77") && init.method === "PATCH") return { body: { id: "77" } };
  });
  const p = hubspotProvider({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const r = await p.upsertContact(TOKENS, LEAD, { mapping: effectiveMapping("hubspot", {}) });
  assertEquals([r.contactId, r.companyId, r.created], ["77", "5", false]);
  assertEquals(s.seen.at(-1)?.body.properties, { hs_linkedin_url: "https://www.linkedin.com/in/ada", outreach_stage: "Interested" });
  const dead = hubspotProvider({ clientId: "id", clientSecret: "secret", fetch: scripted(() => ({ status: 401, body: { message: "expired" } })).fetch });
  const err = await assertRejects(() => dead.listSegments(TOKENS), CrmError);
  assertEquals(err.kind, "auth");
  assert(p.authorizeUrl("st", "https://x/cb").startsWith("https://app.hubspot.com/oauth/authorize?client_id=id&redirect_uri=https%3A%2F%2Fx%2Fcb&scope=oauth+crm.objects.contacts.read"));
});

Deno.test("pipedrive: person with organisation and custom fields; notes carry the timestamp", async () => {
  const s = scripted((url, init) => {
    if (url.includes("/api/v2/persons/search") || url.includes("/api/v2/organizations/search")) return { body: { data: { items: [] } } };
    if (url.includes("/api/v1/personFields") && (init.method ?? "GET") === "GET") return { body: { data: [{ key: "abc123", name: "LinkedIn URL" }], additional_data: { pagination: { more_items_in_collection: false } } } };
    if (url.endsWith("/api/v1/personFields")) return { status: 201, body: { data: { key: "def456" } } };
    if (url.endsWith("/api/v2/organizations")) return { status: 201, body: { data: { id: 31 } } };
    if (url.endsWith("/api/v2/persons")) return { status: 201, body: { data: { id: 12 } } };
    if (url.endsWith("/api/v1/notes")) return { status: 201, body: { data: { id: 99 } } };
  });
  const p = pipedriveProvider({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const r = await p.upsertContact(TOKENS, LEAD, { mapping: effectiveMapping("pipedrive", {}) });
  assertEquals([r.contactId, r.companyId, r.created], ["12", "31", true]);
  const body = s.seen.find((c) => c.url.endsWith("/api/v2/persons"))?.body;
  assertEquals(body, { name: "Ada Lovelace", emails: [{ value: "ada@engines.io", primary: true, label: "work" }], job_title: "CTO", custom_fields: { abc123: "https://www.linkedin.com/in/ada", def456: "Interested" }, org_id: 31 });
  await p.logActivity(TOKENS, "12", { direction: "in", channel: "linkedin", text: "Hi <b>there</b>", at: "2026-09-20T09:59:30.000Z" });
  const note = s.seen.at(-1)?.body;
  assertEquals([note.person_id, note.add_time], [12, "2026-09-20 09:59:30"]);
  assert(note.content.includes("Hi &lt;b&gt;there&lt;/b&gt;"));
});

Deno.test("salesforce: reuses a contact by email, creates leads otherwise, PKCE on the authorize URL", async () => {
  const s = scripted((url, init) => {
    if (url.includes("/query?q=") && decodeURIComponent(url).includes("FROM Contact")) return { body: { records: [] } };
    if (url.includes("/query?q=") && decodeURIComponent(url).includes("FROM Lead")) return { body: { records: [] } };
    if (url.endsWith("/sobjects/Lead") && init.method === "POST") return { status: 201, body: { id: "00Q000000000001AAA", success: true } };
    if (url.includes("/sobjects/Lead/00Q000000000001AAA") && init.method === "PATCH") return { status: 204 };
  });
  const p = salesforceProvider({ clientId: "id", clientSecret: "secret", fetch: s.fetch });
  const r = await p.upsertContact(TOKENS, LEAD, { mapping: effectiveMapping("salesforce", {}) });
  assertEquals([r.contactId, r.created], ["00Q000000000001AAA", true]);
  assertEquals(r.leftover, { stage: "Interested", linkedin_url: "https://www.linkedin.com/in/ada" }); // no field for them: the engine writes a note
  assertEquals(s.seen.find((c) => c.url.endsWith("/sobjects/Lead"))?.body, { FirstName: "Ada", LastName: "Lovelace", Email: "ada@engines.io", Title: "CTO", Company: "Analytical Engines", City: "London" });
  assertEquals(await p.setStage(TOKENS, { contactId: "00Q000000000001AAA" }, { contact: "Working - Contacted" }), { contact: true, deal: false });
  const err = await assertRejects(() => p.createDeal(TOKENS, "00Q000000000001AAA", { name: "x" }), CrmError);
  assertEquals(err.kind, "unsupported");
  const u = new URL(p.authorizeUrl("st", "https://x/cb", "challenge"));
  assertEquals([u.origin, u.searchParams.get("code_challenge"), u.searchParams.get("code_challenge_method"), u.searchParams.get("scope")], ["https://login.salesforce.com", "challenge", "S256", "api refresh_token"]);
});
