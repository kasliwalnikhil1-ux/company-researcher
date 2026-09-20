// outreach-api/routes_sequences.ts — list, get, stats, activate / pause, failed leads, why-not-sending.
// Building and publishing sequences stays in the app and the connector; the API reads them and switches them on and off.

import { type App, call, ctxOf, parse, pathId, ok, scopedClient, id, date, paging, z } from "./dispatch.ts";

export function registerSequences(app: App): void {
  app.get("/v1/sequences", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({ status: z.enum(["draft", "active", "paused", "archived"]).optional(), client_id: id.optional() }), c.req.query());
    scopedClient(ctx, q.client_id);
    return ok(c, await call(ctx, "api_sequences", { p_ws: ctx.key.workspace_id, p_status: q.status, p_client: q.client_id }));
  });

  app.get("/v1/sequences/:id", async (c) => ok(c, await call(ctxOf(c), "api_sequence", { p_sequence: pathId(c) })));

  app.get("/v1/sequences/:id/stats", async (c) => {
    const q = parse(z.object({ from: date.optional(), to: date.optional() }), c.req.query());
    return ok(c, await call(ctxOf(c), "report_sequence", { p_sequence: pathId(c), p_from: q.from, p_to: q.to }));
  });

  // Activating lets queued leads start spending sender budget, so it sits in the "spend" rate class.
  app.post("/v1/sequences/:id/activate", async (c) => ok(c, await call(ctxOf(c), "set_sequence_status", { p_id: pathId(c), p_status: "active" })));
  app.post("/v1/sequences/:id/pause", async (c) => ok(c, await call(ctxOf(c), "set_sequence_status", { p_id: pathId(c), p_status: "paused" })));

  app.get("/v1/sequences/:id/failed", async (c) => {
    const ctx = ctxOf(c); const sid = pathId(c);
    const q = parse(z.object({ node_id: z.string().max(120).optional(), kind: z.enum(["failed", "skipped"]).default("failed"), ...paging }), c.req.query());
    const [summary, leads] = await Promise.all([
      call(ctx, "failed_summary", { p_sequence: sid }),
      call(ctx, "failed_leads", { p_sequence: sid, p_node_id: q.node_id, p_kind: q.kind, p_limit: q.limit, p_offset: q.offset }),
    ]);
    return ok(c, { summary, leads }, 200, { limit: q.limit, offset: q.offset });
  });

  app.get("/v1/sequences/:id/why-not-sending", async (c) => {
    const q = parse(z.object({ sender_id: id.optional(), enrollment_id: id.optional() }), c.req.query());
    return ok(c, await call(ctxOf(c), "why_not_sending", { p_sequence: pathId(c), p_sender: q.sender_id, p_enrollment: q.enrollment_id }));
  });
}
