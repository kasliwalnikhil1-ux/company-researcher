// outreach-api/routes_reports.ts — the same report functions the Reports screen uses. No number is computed here.
// `from` / `to` are inclusive dates (YYYY-MM-DD) in the workspace timezone; both optional (the database picks its default range).

import { type App, type C, call, ctxOf, parse, pathId, ok, filters, scopedClient, id, date, z } from "./dispatch.ts";

const range = { from: date.optional(), to: date.optional(), client_id: id.optional() };
const reportFilters = {
  sequence_id: id.optional(), sender_id: id.optional(), node_id: z.string().max(120).optional(), variant_id: z.string().max(120).optional(),
  channel: z.enum(["linkedin", "email"]).optional(), list_id: id.optional(), tag_id: id.optional(),
};

function read(c: C, extra: Record<string, z.ZodType> = {}) {
  const q = parse(z.object({ ...range, ...reportFilters, ...extra }), c.req.query()) as Record<string, unknown>;
  const ctx = ctxOf(c);
  scopedClient(ctx, q.client_id as string | undefined);
  const { from, to, client_id, group, intent, ...f } = q;
  return { ctx, ws: ctx.key.workspace_id, from, to, client: client_id, group, intent, f: filters(f) };
}

export function registerReports(app: App): void {
  app.get("/v1/reports/overview", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_overview", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to, p_filters: r.f }));
  });
  app.get("/v1/reports/funnel", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_funnel", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to, p_filters: r.f }));
  });
  app.get("/v1/reports/intents", async (c) => {
    const r = read(c, { group: z.enum(["day", "sequence", "step", "sender", "variant", "channel"]).default("day") });
    return ok(c, await call(r.ctx, "report_intents", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to, p_group: r.group, p_filters: r.f }));
  });
  app.get("/v1/reports/reply-threads", async (c) => {
    const r = read(c, { intent: z.enum(["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear", "unclassified"]).optional() });
    return ok(c, await call(r.ctx, "report_reply_threads", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to, p_intent: r.intent, p_filters: r.f }));
  });
  app.get("/v1/reports/cost", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_cost", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to }));
  });

  app.get("/v1/reports/sequences", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_sequences", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to }));
  });
  app.get("/v1/reports/senders", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_senders", { p_ws: r.ws, p_client: r.client, p_from: r.from, p_to: r.to }));
  });
  app.get("/v1/reports/clients", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_clients", { p_ws: r.ws, p_from: r.from, p_to: r.to }));
  });

  app.get("/v1/reports/sequences/:id", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_sequence", { p_sequence: pathId(c), p_from: r.from, p_to: r.to }));
  });
  app.get("/v1/reports/senders/:id", async (c) => {
    const r = read(c);
    return ok(c, await call(r.ctx, "report_sender", { p_sender: pathId(c), p_from: r.from, p_to: r.to }));
  });
  app.get("/v1/reports/clients/:id", async (c) => {
    const r = read(c);
    const client = pathId(c);
    scopedClient(r.ctx, client);
    return ok(c, await call(r.ctx, "report_client", { p_client: client, p_from: r.from, p_to: r.to }));
  });
}
