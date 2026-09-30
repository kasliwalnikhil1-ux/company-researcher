// crm-mcp/calendar_routes.ts — HTTP routes for the /crm/calendar screen (member JWT). Thin wrappers over calendar.ts,
// the same service the connector tools use.
//
//   GET  /crm-mcp/calendar/callback          Google → here → 302 back to the app (web client only)
//   POST /crm-mcp/calendar/status            {configured, client_kind, callback_url}
//   POST /crm-mcp/calendar/connect-url       {hint?, return_to?}            → {url, mode: auto|paste}
//   POST /crm-mcp/calendar/finish            {address}                      → {email, …}  (the address Google returned to)
//   POST /crm-mcp/calendar/accounts          {refresh?: account_id}         → {accounts}
//   POST /crm-mcp/calendar/account-update    {account_id, label?, aliases?, is_default?}
//   POST /crm-mcp/calendar/disconnect        {account_id}
//   POST /crm-mcp/calendar/events            ListOpts                       → {events, …}
//   POST /crm-mcp/calendar/event             {event_id, account?, calendar?}
//   POST /crm-mcp/calendar/create            CreateOpts (+ meeting_id | crm)
//   POST /crm-mcp/calendar/update            UpdateOpts
//   POST /crm-mcp/calendar/delete            {event_id, account?, calendar?, notify?}
//   POST /crm-mcp/calendar/free              FreeOpts
//   POST /crm-mcp/calendar/create-for-meeting {meeting_id, account?, notify?, title?}
//   POST /crm-mcp/calendar/sync-meeting      {meeting_id, scheduled_at?, duration_min?, status?, attendees?}
import type { Hono } from "npm:hono@4.9.7";
import { buildCtx, log, McpError, type Ctx } from "./ctx.ts";
import * as cal from "./calendar.ts";

type Row = Record<string, any>;
const STATUS: Record<string, number> = {
  E_UNAUTHORIZED: 401, E_FORBIDDEN: 403, E_NOT_FOUND: 404, E_PAYLOAD_INVALID: 400, E_MEETING_CANCELLED: 409,
  E_CALENDAR_NOT_CONFIGURED: 503, E_CALENDAR_NOT_CONNECTED: 409, E_CALENDAR_RECONNECT: 409, E_CALENDAR_SCOPE: 409, E_CALENDAR_READONLY: 403,
  E_GOOGLE: 502, E_GOOGLE_NETWORK: 502, E_GOOGLE_UNAUTHORIZED: 502,
};

export function registerCalendarRoutes(app: Hono, cors: Record<string, string>): void {
  const reply = (status: number, body: Row) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

  app.get("/calendar/callback", async (c) => {
    const to = await cal.handleCallback(new URL(c.req.url).searchParams);
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
  });

  const route = (op: string, handler: (ctx: Ctx, body: Row) => Promise<Row>) =>
    app.post(`/calendar/${op}`, async (c) => {
      const t0 = Date.now();
      try {
        const ctx = await buildCtx(c.req.header("authorization"));
        if (!ctx) throw new McpError("E_UNAUTHORIZED", "The session expired; sign in again.");
        if (!ctx.isMember) throw new McpError("E_FORBIDDEN", "This account is not on the CRM team.");
        const body = (await c.req.json().catch(() => ({}))) as Row;
        const out = await handler(ctx, body);
        log({ fn: "crm-mcp", route: `calendar/${op}`, status: "ok", user: ctx.userId, duration_ms: Date.now() - t0 });
        return reply(200, { ok: true, ...out });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const m = /^(E_[A-Z_]+)(?::\s*([\s\S]*))?$/.exec(msg.trim());
        const code = (e as Row)?.code && /^E_/.test(String((e as Row).code)) ? String((e as Row).code) : m?.[1] ?? "E_INTERNAL";
        log({ fn: "crm-mcp", route: `calendar/${op}`, status: "error", code, message: msg.slice(0, 200), duration_ms: Date.now() - t0 });
        return reply(STATUS[code] ?? 500, { error: true, code, message: m?.[2] ?? msg, remedy: e instanceof McpError ? e.remedy : undefined });
      }
    });

  route("status", async () => ({ configured: cal.isConfigured(), client_kind: cal.CLIENT_KIND, callback_url: cal.CALLBACK_URL }));
  route("connect-url", (ctx, b) => cal.connectUrl(ctx, { hint: b.hint, return_to: b.return_to }));
  route("finish", async (ctx, b) => cal.finishConnect(String(b.address ?? ""), ctx) as unknown as Row);
  route("accounts", async (ctx, b) => {
    if (b.refresh) await cal.refreshAccount(ctx, String(b.refresh));
    return { configured: cal.isConfigured(), timezone: ctx.crm.timezone, accounts: await cal.listAccounts(ctx) };
  });
  route("account-update", async (ctx, b) => {
    const { account_id, ...rest } = b;
    const { data, error } = await ctx.user.rpc("crm_calendar_account_update", { p_account_id: account_id, p: rest });
    if (error) throw new Error(error.message);
    return { account: data };
  });
  route("disconnect", (ctx, b) => cal.disconnectAccount(ctx, String(b.account_id ?? "")));
  route("events", (ctx, b) => cal.listEvents(ctx, b as cal.ListOpts));
  route("event", async (ctx, b) => ({ event: await cal.getEvent(ctx, b as { event_id: string }) }));
  route("create", (ctx, b) => cal.createEvent(ctx, b as cal.CreateOpts));
  route("update", (ctx, b) => cal.updateEvent(ctx, b as cal.UpdateOpts));
  route("delete", (ctx, b) => cal.deleteEvent(ctx, b as { event_id: string }));
  route("free", (ctx, b) => cal.freeSlots(ctx, b as cal.FreeOpts));
  route("create-for-meeting", (ctx, b) => cal.createEventForMeeting(ctx, String(b.meeting_id ?? ""), b));
  route("sync-meeting", async (ctx, b) => ({ note: await cal.syncMeetingToEvent(ctx, String(b.meeting_id ?? ""), b) }));
}
