// outreach-api/routes_inbox.ts — threads, one thread with messages and attribution, intent, assignee, reply; the Sent list
// (docs/outreach/INBOX-REPLIES-SENT.md: one row per send, segments sent | scheduled | failed). Messages keep direction in | out.

import { sendReply } from "../_shared/outreach/reply.ts";
import { type App, call, ctxOf, body, parse, pathId, ok, page, filters, scopedClient, id, bool, z, paging, HttpError } from "./dispatch.ts";

const INTENTS = ["interested", "question", "not_now", "not_interested", "ooo", "wrong_person", "unclear", "unclassified"] as const;

/** The Sent cursor: the RPC's next_cursor {at, id}, carried as one opaque base64url string. */
const encodeCursor = (c: unknown): string | null => {
  const o = c as { at?: string; id?: string } | null;
  return o?.at && o?.id ? btoa(JSON.stringify({ at: o.at, id: o.id })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
};
function decodeCursor(s: string | undefined): { at: string; id: string } | undefined {
  if (!s) return undefined;
  try {
    const o = JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    if (o && typeof o.at === "string" && typeof o.id === "string") return { at: o.at, id: o.id };
  } catch { /* fall through */ }
  throw new HttpError(422, "E_PAYLOAD_INVALID", "cursor: pass the next_cursor of the previous page unchanged.");
}

export function registerInbox(app: App): void {
  // Sent: what went out, what is scheduled, what failed. Same rows as the app's Sent view (outreach_inbox_sent_list).
  app.get("/v1/sent", async (c) => {
    const ctx = ctxOf(c);
    const q = parse(z.object({
      segment: z.enum(["sent", "scheduled", "failed"]).default("sent"),
      sender_ids: z.string().optional().transform((v, k) => {
        if (!v) return undefined;
        const ids = v.split(",").map((x) => x.trim()).filter(Boolean);
        if (ids.length > 100 || ids.some((x) => !id.safeParse(x).success)) { k.addIssue({ code: "custom", message: "comma-separated sender ids (at most 100)" }); return z.NEVER; }
        return ids.length ? ids : undefined;
      }),
      my_senders: bool.optional(), client_id: id.optional(), channel: z.enum(["LINKEDIN", "EMAIL", "WHATSAPP", "INSTAGRAM"]).optional(),
      source: z.enum(["sequence", "teammate", "ai", "outside_app"]).optional(), sequence_id: id.optional(),
      type: z.enum(["connection_request", "message", "inmail", "email"]).optional(), replied: bool.optional(),
      from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
      search: z.string().trim().max(200).optional(), lead_id: id.optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(500).optional(),
    }), c.req.query());
    const { segment, limit, cursor, ...f } = q;
    scopedClient(ctx, f.client_id);
    const r = await call<{ segment?: string; items?: unknown[]; next_cursor?: unknown; range?: unknown }>(ctx, "inbox_sent_list",
      { p_ws: ctx.key.workspace_id, p_segment: segment, p_filters: filters(f), p_cursor: decodeCursor(cursor), p_limit: limit });
    return ok(c, r?.items ?? [], 200, { next_cursor: encodeCursor(r?.next_cursor), segment: r?.segment ?? segment, range: r?.range ?? null });
  });

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
    // cc / bcc: email threads only (addresses are checked again in sendReply: valid, unique, at most 20)
    const addresses = z.array(z.string().trim().email().max(320)).max(20).optional();
    const b = parse(z.object({ text: z.string().trim().min(1).max(8000), subject: z.string().max(300).optional(), cc: addresses, bcc: addresses, booking: z.boolean().optional() }).strict(), body(c));
    const ctx = ctxOf(c);
    const message = await sendReply({ userId: ctx.key.user_id, chat_id: chat, text: b.text, subject: b.subject, cc: b.cc, bcc: b.bcc, booking: b.booking,
      scope: { workspaceId: ctx.key.workspace_id, role: ctx.key.role, clientIds: ctx.key.client_ids ?? [] } });
    return ok(c, { id: chat, message }, 201);
  });
}
