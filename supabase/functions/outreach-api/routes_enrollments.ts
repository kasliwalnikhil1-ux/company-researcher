// outreach-api/routes_enrollments.ts — preview, commit, list, pause / resume / exit, recover.
//
// PREVIEW THEN COMMIT. Enrolling spends LinkedIn budget later, so the API keeps the two steps the app has.
// There is no server-side preview token: `POST /v1/enrollments/preview` returns outreach_enroll_preview as is,
// and `POST /v1/enrollments` needs the same `lead_ids` plus `confirm: true`. Both functions run the SAME plan
// in the database (outreach__enroll_plan), and the commit re-checks every rule at commit time (suppression,
// recent replies, already enrolled, sender freshness). A commit can therefore enrol FEWER leads than the
// preview showed when something changed in between, never a lead the rules exclude, and never a lead that was
// not in `lead_ids`. Send the preview's `eligible_ids` to commit exactly what you reviewed.

import { type App, call, ctxOf, body, parse, pathId, ok, page, filters, firstRow, id, bool, paging, z, HttpError } from "./dispatch.ts";

const enrolBase = {
  sequence_id: id,
  lead_ids: z.array(id).min(1).max(10000),
  sender_id: id.optional(),
  include_replied: z.boolean().optional(),
};

export function registerEnrollments(app: App): void {
  app.post("/v1/enrollments/preview", async (c) => {
    const b = parse(z.object(enrolBase).strict(), body(c));
    const preview = await call(ctxOf(c), "enroll_preview", { p_sequence: b.sequence_id, p_lead_ids: b.lead_ids, p_sender: b.sender_id, p_include_replied: b.include_replied });
    return ok(c, preview, 200, { next: "POST /v1/enrollments with sequence_id, lead_ids (use data.eligible_ids) and confirm: true" });
  });

  app.post("/v1/enrollments", async (c) => {
    const b = parse(z.object({ ...enrolBase, priority: z.number().int().min(1).max(1000).optional(), wait_enrichment: z.boolean().optional(), confirm: z.boolean().optional() }).strict(), body(c));
    if (b.confirm !== true) throw new HttpError(400, "E_CONFIRM_REQUIRED", "Call POST /v1/enrollments/preview first, then repeat this call with the same lead_ids and confirm: true.");
    const row = firstRow(await call(ctxOf(c), "enroll_leads", {
      p_sequence: b.sequence_id, p_lead_ids: b.lead_ids, p_sender: b.sender_id, p_priority: b.priority, p_include_replied: b.include_replied, p_wait_enrichment: b.wait_enrichment,
    }));
    return ok(c, { requested: b.lead_ids.length, ...(row ?? {}) }, 201);
  });

  app.get("/v1/enrollments", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({
      sequence_id: id.optional(), lead_id: id.optional(), sender_id: id.optional(), live: bool.optional(),
      status: z.enum(["active", "waiting_connection", "waiting_delay", "waiting_task", "paused", "completed", "exited_replied", "exited_manual", "exited_suppressed", "exited_sender_disabled", "failed", "cancelled"]).optional(),
      ...paging,
    }), c.req.query());
    const { limit, offset, ...f } = q;
    return page(c, await call(ctx, "api_enrollments", { p_ws: ctx.key.workspace_id, p_filters: filters(f), p_limit: limit, p_offset: offset }));
  });

  // Registered before /:id/... so "recover" is never read as an id.
  app.post("/v1/enrollments/recover", async (c) => {
    const b = parse(z.object({ enrollment_ids: z.array(id).min(1).max(500), action: z.enum(["retry", "skip", "exit"]) }).strict(), body(c));
    return ok(c, await call(ctxOf(c), "enrollment_recover", { p_enrollment_ids: b.enrollment_ids, p_action: b.action }));
  });

  app.post("/v1/enrollments/:id/pause", async (c) => {
    const eid = pathId(c);
    await call(ctxOf(c), "pause_enrollment", { p_id: eid });
    return ok(c, { id: eid, action: "paused" });
  });
  app.post("/v1/enrollments/:id/resume", async (c) => {
    const eid = pathId(c);
    await call(ctxOf(c), "resume_enrollment", { p_id: eid });
    return ok(c, { id: eid, action: "resumed" });
  });
  app.post("/v1/enrollments/:id/exit", async (c) => {
    const eid = pathId(c);
    const b = parse(z.object({ reason: z.string().trim().max(120).optional() }).strict(), body(c));
    await call(ctxOf(c), "exit_enrollment", { p_id: eid, p_reason: b.reason || "api" });
    return ok(c, { id: eid, action: "exited" });
  });
}
