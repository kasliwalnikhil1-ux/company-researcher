// outreach-api/routes_leads.ts — leads, tags, stage, list, suppression, timeline, enrichment.
//
// PARTIAL UPDATES. `POST /v1/leads` and `PATCH /v1/leads/{id}` both end in outreach_upsert_lead, which
// updates an existing lead with `coalesce(new, old)` per column and merges `custom` key by key. So:
//   * a field you leave out is never blanked;
//   * an empty string or null is treated as "left out" (it cannot blank a field either);
//   * email_work, email_personal, public_identifier and client_id are only filled when they are empty,
//     they are never overwritten (the response lists them under `unchanged_fields` when that happens).
// This file adds no update logic of its own; it only picks which existing lead the RPC will match.

import { type App, type ApiCtx, call, ctxOf, body, parse, pathId, ok, page, filters, firstRow, scopedClient, id, bool, paging, z, HttpError } from "./dispatch.ts";

const text = (max: number) => z.string().trim().max(max);

const writableFields = {
  first_name: text(200).optional(),
  last_name: text(200).optional(),
  full_name: text(400).optional(),
  headline: text(1000).optional(),
  company: text(400).optional(),
  company_id: text(200).optional(),
  title: text(400).optional(),
  location: text(400).optional(),
  picture_url: z.url().max(2000).optional(),
  profile_url: z.url().max(2000).optional(),
  email: z.email().max(320).optional(),            // alias of email_work
  email_work: z.email().max(320).optional(),
  email_personal: z.email().max(320).optional(),
  is_open_profile: z.boolean().optional(),
  custom: z.record(z.string().max(100), z.union([z.string().max(4000), z.number(), z.boolean(), z.null()])).optional(),
  list_id: id.optional(),
  stage_id: id.optional(),
  client_id: id.optional(),
  linkedin_url: z.url().max(2000).optional(),      // https://www.linkedin.com/in/<public_identifier>
  public_identifier: text(200).optional(),
};

const createSchema = z.object({ ...writableFields, provider_id: text(200).optional(), source: text(60).optional() }).strict();
const patchSchema = z.object(writableFields).strict();

type LeadInput = z.infer<typeof createSchema>;
type Lead = Record<string, unknown> & { id: string; public_identifier: string | null; provider_id: string | null; email_work: string | null; email_personal: string | null };

/** linkedin_url → public_identifier, email → email_work. Pure input normalisation, no business rule. */
function toLeadJson(input: LeadInput): Record<string, unknown> {
  const { linkedin_url, email, source: _source, ...rest } = input as LeadInput & { source?: string };
  const out: Record<string, unknown> = { ...rest };
  if (linkedin_url) {
    const m = /linkedin\.com\/in\/([^/?#]+)/i.exec(linkedin_url);
    if (!m) throw new HttpError(422, "E_PAYLOAD_INVALID", "linkedin_url must look like https://www.linkedin.com/in/<name>");
    out.public_identifier ??= decodeURIComponent(m[1]).toLowerCase();
    out.profile_url ??= linkedin_url;
  }
  if (email && !out.email_work) out.email_work = email;
  if (typeof out.public_identifier === "string") out.public_identifier = out.public_identifier.toLowerCase();
  return out;
}

async function getLead(ctx: ApiCtx, leadId: string): Promise<Lead> {
  return await call<Lead>(ctx, "api_lead", { p_lead: leadId });   // E_NOT_FOUND when missing or outside the key's clients
}

/** Fields that were sent but did not take effect (fill-only columns that already had a value). */
function unchangedFields(sent: Record<string, unknown>, after: Lead): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(sent)) {
    if (k === "custom" || v === undefined || v === null || v === "") continue;
    if (String(after[k] ?? "").toLowerCase() !== String(v).toLowerCase()) out.push(k);
  }
  return out;
}

export function registerLeads(app: App): void {
  // ---- search
  app.get("/v1/leads", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({
      q: z.string().max(200).optional(), client_id: id.optional(), list_id: id.optional(), stage_id: id.optional(), tag_id: id.optional(),
      source: z.string().max(60).optional(), email: z.string().max(320).optional(), public_identifier: z.string().max(200).optional(),
      updated_since: z.iso.datetime({ offset: true }).optional(), replied: bool.optional(), enriched: bool.optional(), ...paging,
    }), c.req.query());
    const { limit, offset, ...f } = q;
    scopedClient(ctx, f.client_id);
    return page(c, await call(ctx, "api_leads", { p_ws: ctx.key.workspace_id, p_filters: filters(f), p_limit: limit, p_offset: offset }));
  });

  // ---- enrich (spends profile views, so it is in the "spend" rate class). Registered before /v1/leads/:id.
  app.post("/v1/leads/enrich", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(z.object({ lead_ids: z.array(id).min(1).max(5000), want_posts: z.boolean().optional(), force: z.boolean().optional() }).strict(), body(c));
    return ok(c, await call(ctx, "request_enrichment", { p_ws: ctx.key.workspace_id, p_lead_ids: b.lead_ids, p_want_posts: b.want_posts, p_force: b.force, p_reason: "api" }), 202);
  });

  // ---- get
  app.get("/v1/leads/:id", async (c) => ok(c, await getLead(ctxOf(c), pathId(c))));

  // ---- create or update (matched by LinkedIn id, then provider id, then work email, then personal email)
  app.post("/v1/leads", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(createSchema, body(c));
    const lead = toLeadJson(b);
    if (!lead.public_identifier && !lead.provider_id && !lead.email_work && !lead.email_personal) {
      throw new HttpError(422, "E_PAYLOAD_INVALID", "Send linkedin_url, public_identifier or an email so the lead can be matched.");
    }
    const scope = ctx.key.client_ids ?? [];
    scopedClient(ctx, lead.client_id as string | undefined);
    if (scope.length && !lead.client_id) {
      if (scope.length > 1) throw new HttpError(422, "E_PAYLOAD_INVALID", "This key covers several clients. Send client_id.");
      lead.client_id = scope[0];
    }
    const row = firstRow<{ id: string; created: boolean }>(await call(ctx, "upsert_lead", { p_ws: ctx.key.workspace_id, p_lead: lead, p_source: b.source ?? "api" }));
    if (!row?.id) throw new HttpError(409, "E_CONFLICT", "The lead could not be matched or created. Retry.");
    let after: Lead;
    try { after = await getLead(ctx, row.id); } catch (e) {
      if ((e as HttpError).code === "E_NOT_FOUND") throw new HttpError(403, "E_FORBIDDEN", "A lead with this LinkedIn id or email belongs to a client outside this key's scope.");
      throw e;
    }
    return ok(c, after, row.created ? 201 : 200, { created: row.created, unchanged_fields: row.created ? [] : unchangedFields(lead, after) });
  });

  // ---- partial update by id
  app.patch("/v1/leads/:id", async (c) => {
    const ctx = ctxOf(c);
    const leadId = pathId(c);
    const patch = toLeadJson(parse(patchSchema, body(c)) as LeadInput);
    if (!Object.keys(patch).length) throw new HttpError(422, "E_PAYLOAD_INVALID", "Send at least one field to change.");
    scopedClient(ctx, patch.client_id as string | undefined);
    const current = await getLead(ctx, leadId);

    // Make outreach_upsert_lead match THIS lead and no other: it looks up public_identifier, then provider_id,
    // then email_work, then email_personal. We always hand it the lead's own strongest identifier.
    const p: Record<string, unknown> = { ...patch };
    const otherLeadHas = async (f: Record<string, unknown>) => {
      const r = await call<{ data: Array<{ id: string }> }>(ctx, "api_leads", { p_ws: ctx.key.workspace_id, p_filters: f, p_limit: 2 });
      return (r?.data ?? []).some((l) => l.id !== leadId);
    };
    if (current.public_identifier) {
      p.public_identifier = current.public_identifier;
    } else if (p.public_identifier && await otherLeadHas({ public_identifier: p.public_identifier })) {
      throw new HttpError(409, "E_CONFLICT", "Another lead already has this LinkedIn profile.");
    }
    if (current.provider_id) p.provider_id = current.provider_id;
    if (!current.public_identifier && !current.provider_id) {
      if (current.email_work) p.email_work = current.email_work;
      else {
        if (p.email_work && await otherLeadHas({ email: p.email_work })) throw new HttpError(409, "E_CONFLICT", "Another lead already has this email.");
        if (current.email_personal) p.email_personal = current.email_personal;
      }
    }
    const row = firstRow<{ id: string; created: boolean }>(await call(ctx, "upsert_lead", { p_ws: ctx.key.workspace_id, p_lead: p }));
    if (row?.id !== leadId) throw new HttpError(409, "E_CONFLICT", "The identifiers in this update belong to another lead. Nothing was changed on this one.");
    const after = await getLead(ctx, leadId);
    return ok(c, after, 200, { unchanged_fields: unchangedFields(patch, after) });
  });

  // ---- one-lead actions, all through outreach_bulk_leads (the same function the leads table uses)
  const bulk = async (ctx: ApiCtx, leadId: string, op: string, value?: string | null) => {
    await getLead(ctx, leadId);   // 404 when the lead is outside the key's clients; bulk_leads itself only checks the workspace
    await call(ctx, "bulk_leads", { p_ws: ctx.key.workspace_id, p_lead_ids: [leadId], p_op: op, p_value: value });
    return await getLead(ctx, leadId);
  };

  app.post("/v1/leads/:id/tags", async (c) => {
    const b = parse(z.object({ tag_id: id.optional(), tag_ids: z.array(id).min(1).max(20).optional() }).strict(), body(c));
    const tags = [...new Set([...(b.tag_ids ?? []), ...(b.tag_id ? [b.tag_id] : [])])];
    if (!tags.length) throw new HttpError(422, "E_PAYLOAD_INVALID", "Send tag_id or tag_ids. Tag ids are listed by GET /v1/me.");
    const ctx = ctxOf(c); const leadId = pathId(c);
    let lead: Lead | null = null;
    for (const t of tags) lead = await bulk(ctx, leadId, "add_tag", t);
    return ok(c, lead);
  });
  app.delete("/v1/leads/:id/tags/:tag_id", async (c) => ok(c, await bulk(ctxOf(c), pathId(c), "remove_tag", pathId(c, "tag_id"))));

  app.put("/v1/leads/:id/stage", async (c) => {
    const b = parse(z.object({ stage_id: id.nullable() }).strict(), body(c));
    return ok(c, await bulk(ctxOf(c), pathId(c), "set_stage", b.stage_id));
  });
  app.put("/v1/leads/:id/list", async (c) => {
    const b = parse(z.object({ list_id: id.nullable() }).strict(), body(c));
    return ok(c, await bulk(ctxOf(c), pathId(c), "set_list", b.list_id));
  });

  // Suppressing keeps the lead, its timeline and its chats (contract rule 4). It only stops future sends.
  app.post("/v1/leads/:id/suppress", async (c) => ok(c, await bulk(ctxOf(c), pathId(c), "set_dnc")));
  app.delete("/v1/leads/:id/suppress", async (c) => ok(c, await bulk(ctxOf(c), pathId(c), "clear_dnc")));

  app.get("/v1/leads/:id/timeline", async (c) => {
    const ctx = ctxOf(c); const leadId = pathId(c);
    await getLead(ctx, leadId);
    return ok(c, await call(ctx, "lead_timeline", { p_lead: leadId }));
  });

  // ---- workspace / client / sequence blacklists
  app.post("/v1/suppressions", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(z.object({
      rows: z.array(z.object({ kind: z.enum(["email", "domain", "public_identifier", "company"]).optional(), value: z.string().trim().min(1).max(500), reason: z.string().max(500).optional() }).strict()).min(1).max(20000),
      client_id: id.optional(), sequence_id: id.optional(), source: z.string().max(60).optional(),
    }).strict(), body(c));
    scopedClient(ctx, b.client_id);
    return ok(c, await call(ctx, "add_suppressions", { p_ws: ctx.key.workspace_id, p_rows: b.rows, p_client: b.client_id, p_sequence: b.sequence_id, p_source: b.source ?? "api" }), 201);
  });
}
