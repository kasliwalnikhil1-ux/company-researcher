// outreach-api/routes_inbox.ts — threads, one thread with messages and attribution, intent, assignee, reply.

import { sendReply } from "../_shared/outreach/reply.ts";
import { type App, call, ctxOf, body, parse, pathId, ok, page, filters, id, bool, paging, z, HttpError } from "./dispatch.ts";

const INTENTS = ["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear", "unclassified"] as const;

export function registerInbox(app: App): void {
  app.get("/v1/threads", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({
      intent: z.enum(INTENTS).optional(), sender_id: id.optional(), lead_id: id.optional(), sequence_id: id.optional(),
      unread: bool.optional(), waiting_on_us: bool.optional(), archived: bool.optional(), since: z.iso.datetime({ offset: true }).optional(), ...paging,
    }), c.req.query());
    const { limit, offset, ...f } = q;
    return page(c, await call(ctx, "api_threads", { p_ws: ctx.key.workspace_id, p_filters: filters(f), p_limit: limit, p_offset: offset }));
  });

  app.get("/v1/threads/:id", async (c) => {
    const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }), c.req.query());
    return ok(c, await call(ctxOf(c), "api_thread", { p_chat: pathId(c), p_limit: q.limit }));
  });

  app.put("/v1/threads/:id/intent", async (c) => {
    const chat = pathId(c);
    const b = parse(z.object({ intent: z.enum(INTENTS) }).strict(), body(c));
    await call(ctxOf(c), "set_intent", { p_chat: chat, p_intent: b.intent });
    return ok(c, { id: chat, intent: b.intent });
  });

  app.put("/v1/threads/:id/assignee", async (c) => {
    const chat = pathId(c);
    const b = parse(z.object({ user_id: id.nullable() }).strict(), body(c));
    await call(ctxOf(c), "assign_chat", { p_chat: chat, p_user: b.user_id });
    return ok(c, { id: chat, assigned_to: b.user_id });
  });

  // Sending a reply is the one operation that is not an SQL function: it talks to LinkedIn / the mailbox.
  // It runs the SAME code as the inbox (_shared/outreach/reply.ts), as the key's member, narrowed to the key's role and client scope.
  app.post("/v1/threads/:id/reply", async (c) => {
    const chat = pathId(c);
    const b = parse(z.object({ text: z.string().trim().min(1).max(8000), subject: z.string().max(300).optional(), booking: z.boolean().optional() }).strict(), body(c));
    const ctx = ctxOf(c);
    const message = await sendReply({ userId: ctx.key.user_id, chat_id: chat, text: b.text, subject: b.subject, booking: b.booking,
      scope: { workspaceId: ctx.key.workspace_id, role: ctx.key.role, clientIds: ctx.key.client_ids ?? [] } });
    return ok(c, { id: chat, message }, 201);
  });
}
