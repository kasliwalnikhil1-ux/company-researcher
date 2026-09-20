// outreach-api/routes_platform.ts — meta (me, metric definitions), webhooks (with replay) and tasks.

import { type App, call, ctxOf, body, parse, pathId, ok, id, z } from "./dispatch.ts";

/** Every event a webhook can subscribe to. `*` subscribes to all of them, including ones added later. */
export const WEBHOOK_EVENTS = [
  "sender.connected", "sender.disconnected", "sender.reconnected", "sender.paused", "sender.level_changed", "sender.running_dry",
  "lead.created", "lead.updated", "lead.unsubscribed", "invite.sent", "invite.accepted", "invite.withdrawn",
  "message.sent", "message.received", "message.classified", "email.sent", "email.opened", "email.clicked", "email.bounced",
  "enrollment.started", "enrollment.exited", "enrollment.completed", "enrollment.held", "enrollment.resumed", "enrollment.recovered",
  "task.created", "task.completed", "meeting.booked",
  "sequence.activated", "sequence.paused", "sequence.throttled", "sequence.webhook", "sequence.stalled", "sequence.recovered", "sequence.published",
  "workspace.billing_recovered",
] as const;

export function registerPlatform(app: App): void {
  // ---- meta
  app.get("/v1/me", async (c) => {
    const ctx = ctxOf(c);
    const context = await call<Record<string, unknown>>(ctx, "api_context", { p_ws: ctx.key.workspace_id });
    const k = ctx.key;
    return ok(c, { key: { id: k.key_id, name: k.name, role: k.role, client_ids: k.client_ids, acts_as_user_id: k.user_id }, ...context });
  });
  app.get("/v1/metrics/definitions", async (c) => ok(c, await call(ctxOf(c), "metric_definitions", {})));

  // ---- webhooks (manager keys only; the database enforces it)
  app.get("/v1/webhooks", async (c) => {
    const ctx = ctxOf(c);
    return ok(c, await call(ctx, "api_webhooks", { p_ws: ctx.key.workspace_id }), 200, { events: WEBHOOK_EVENTS });
  });
  app.post("/v1/webhooks", async (c) => {
    const ctx = ctxOf(c);
    const b = parse(z.object({ url: z.url().max(2000).regex(/^https:\/\//, "must start with https://"), events: z.array(z.enum(["*", ...WEBHOOK_EVENTS])).min(1).max(60).default(["*"]) }).strict(), body(c));
    return ok(c, await call(ctx, "create_webhook", { p_ws: ctx.key.workspace_id, p_url: b.url, p_events: b.events }), 201);
  });
  // Registered before /:id so "deliveries" is never read as an id.
  app.get("/v1/webhooks/deliveries", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({ webhook_id: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), c.req.query());
    return ok(c, await call(ctx, "api_deliveries", { p_ws: ctx.key.workspace_id, p_webhook: q.webhook_id, p_limit: q.limit }));
  });
  app.post("/v1/webhooks/deliveries/:id/replay", async (c) => {
    const delivery = parse(z.coerce.number().int().positive(), c.req.param("id"));
    const newId = await call<number>(ctxOf(c), "replay_delivery", { p_delivery: delivery });
    return ok(c, { delivery_id: newId, replay_of: delivery, status: "queued" }, 202);
  });
  app.delete("/v1/webhooks/:id", async (c) => {
    const wid = pathId(c);
    await call(ctxOf(c), "delete_webhook", { p_id: wid });
    return ok(c, { id: wid, deleted: true });
  });

  // ---- tasks
  app.post("/v1/tasks/:id/complete", async (c) => {
    const tid = pathId(c);
    const b = parse(z.object({ text: z.string().max(8000).optional(), result: z.record(z.string(), z.unknown()).optional() }).strict(), body(c));
    await call(ctxOf(c), "complete_task", { p_id: tid, p_text: b.text, p_result: b.result });
    return ok(c, { id: tid, completed: true });
  });
}
