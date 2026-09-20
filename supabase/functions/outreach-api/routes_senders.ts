// outreach-api/routes_senders.ts — read-only. Caps, warm-up and schedules are changed in the app, never through the API.

import { type App, call, ctxOf, pathId, ok } from "./dispatch.ts";

export function registerSenders(app: App): void {
  app.get("/v1/senders", async (c) => {
    const ctx = ctxOf(c);
    return ok(c, await call(ctx, "api_senders", { p_ws: ctx.key.workspace_id }));
  });

  app.get("/v1/senders/:id", async (c) => ok(c, await call(ctxOf(c), "api_sender", { p_sender: pathId(c) })));

  // health score breakdown, recommendations, warm-up, last 30 days, invites against the cap
  app.get("/v1/senders/:id/health", async (c) => ok(c, await call(ctxOf(c), "sender_insights", { p_sender: pathId(c) })));

  // today's budget per action type: planned, reserved, used
  app.get("/v1/senders/:id/budgets", async (c) => {
    const ctx = ctxOf(c); const sid = pathId(c);
    await call(ctx, "api_sender", { p_sender: sid });   // 404 outside the key's clients
    return ok(c, await call(ctx, "sender_today", { p_sender: sid }));
  });

  // effective daily cap per action type right now (warm-up level, health, manual caps and platform ceilings applied)
  app.get("/v1/senders/:id/capacity", async (c) => {
    const s = await call<Record<string, unknown>>(ctxOf(c), "api_sender", { p_sender: pathId(c) });
    return ok(c, { sender_id: s.id, status: s.status, warmup_level: s.warmup_level, paused_until: s.paused_until, invite_blocked_until: s.invite_blocked_until, capacity: s.capacity, today: s.today });
  });
}
