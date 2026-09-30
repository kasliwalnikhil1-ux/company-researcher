// crm-mcp/tools_calendar.ts — Google Calendar tools: connect, accounts, what's on, book / move / cancel, free slots.
// Same service as the /crm/calendar screen (calendar.ts). The booking rules the agent follows live in the crm skill's
// calendar-pipeline.md (title "<Me> <> <Name>", 30 min, Meet link + invites, offer slots when no time was given …).
import type { McpServer } from "npm:@modelcontextprotocol/sdk@1.25.3/server/mcp.js";
import { type Ctx, tool, z } from "./ctx.ts";
import * as cal from "./calendar.ts";

type Row = Record<string, any>;

const accountParam = z.string().optional().describe("Which Google account: its email, label ('work', 'personal'), an alias, or id. Default: the connected user's default account. For reading, a teammate's email also works.");
const calendarParam = z.string().optional().describe("Calendar id on that account (default: the account's primary calendar). Other calendars are listed by calendar_accounts.");
const notifyParam = z.enum(["all", "externalOnly", "none"]).optional().describe("Who gets the invite/update email (default all)");
const whenParam = (what: string) => z.string().describe(`${what}: 'YYYY-MM-DD HH:MM' in the calendar's timezone (IST unless the account says otherwise), an ISO timestamp with offset, 'today 16:00' or 'tomorrow 3pm'. A bare date means all day.`);
const emails = z.array(z.string()).max(50).optional();
const line = (e: cal.EventRow) => `${e.when} · ${e.title}${e.crm?.company ? ` [CRM: ${e.crm.company}]` : ""}${e.attendees.filter((a) => !a.self).length ? ` · with ${e.attendees.filter((a) => !a.self).map((a) => a.email).join(", ")}` : ""}${e.meet ? " · Meet" : ""}`;

export function registerCalendar(server: McpServer, ctx: Ctx): void {
  tool(server, ctx, {
    name: "calendar_connect_link", title: "Connect a Google Calendar", cls: "read",
    description: "Sign-in link to connect one of the connected user's Google accounts (work, personal, …) to the CRM. Give the user the URL exactly as returned plus the instructions. They open it, choose the account and allow every calendar permission; Google then sends the browser to an address starting with http://127.0.0.1:53682/ that will NOT load — that is expected. They copy that whole address from the address bar and paste it back to you; then call calendar_connect_finish with it. Call this when calendar tools answer E_CALENDAR_NOT_CONNECTED, E_CALENDAR_RECONNECT or E_CALENDAR_SCOPE. A member can connect several accounts; the first becomes their default.",
    input: { hint: z.string().optional().describe("Email to preselect on Google's page") },
    annotations: { openWorldHint: true },
  }, async (a) => cal.connectUrl(ctx, { hint: a.hint }));

  tool(server, ctx, {
    name: "calendar_connect_finish", title: "Finish connecting a Google Calendar", cls: "write",
    description: "Second step of calendar_connect_link: pass the full address the user's browser landed on after allowing access (http://127.0.0.1:53682/?state=…&code=…). Stores the sign-in on the server; answers which account was connected, whether it can book (view and edit events), and how many calendars it has. A stale or reused address fails with a clear message — run calendar_connect_link again for a fresh link.",
    input: { address: z.string().min(10).describe("The whole address from the browser's address bar") },
  }, async (a) => {
    const r = await cal.finishConnect(a.address, ctx);
    return { ...r, return_to: undefined, summary: `Connected ${r.email}${r.is_default ? " (your default for booking)" : ""}: ${r.calendars} calendar(s)${r.can_write ? "" : ". READ-ONLY — booking will fail until it is reconnected with every permission"}${r.note ? `. ${r.note}` : ""}.` };
  });

  tool(server, ctx, {
    name: "calendar_accounts", title: "Connected calendars", cls: "read",
    description: "Every Google account connected to the CRM — the whole team's (mine: true marks the connected user's), each with its label/aliases, default flag, calendars (id, name, primary) and timezone. Bookings go to the user's default account unless another of THEIR accounts is named; teammates' accounts are read-only. Set refresh to an account (email/id) to re-pull its calendar list.",
    input: { refresh: z.string().optional() },
  }, async (a) => {
    if (a.refresh) await cal.refreshAccount(ctx, a.refresh);
    const accounts = await cal.listAccounts(ctx);
    const mine = accounts.filter((x) => x.mine);
    return {
      configured: cal.isConfigured(), team_timezone: ctx.crm.timezone, count: accounts.length, accounts,
      summary: accounts.length === 0 ? "No Google Calendar connected yet — offer calendar_connect_link." : `${mine.length === 0 ? "You have no account connected (calendar_connect_link); " : ""}${accounts.map((x) => `${x.email}${x.label ? ` (${x.label})` : ""}${x.is_default && x.mine ? " default" : ""}${x.mine ? "" : ` — ${x.member_name}, read-only`}${x.can_write ? "" : " — READ-ONLY grant"}${x.auth_state !== "ok" ? " — needs reconnect" : ""}: ${x.calendars.length} calendar(s)`).join("; ")}`,
    };
  });

  tool(server, ctx, {
    name: "calendar_events", title: "What's on the calendar", cls: "read",
    description: "Events in a range (default: my accounts, primary calendars, now → 7 days). accounts: 'mine' | 'team' (everyone's) | list of emails/labels; calendars: 'primary' | 'all' | list of ids. q searches title/description/guests. Each event has an id (needed to move or cancel it), when (formatted), attendees with responses, meet link, and crm {meeting_id, company} when it is linked to a CRM meeting. Use it before any change to find the right event; if several match, ask which.",
    input: {
      from: z.string().optional().describe("Start: 'today', 'tomorrow', 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM' (default now)"), to: z.string().optional().describe("End; a bare date includes that whole day"), days: z.number().int().min(1).max(92).optional().describe("Length when to is absent (default 7)"),
      q: z.string().optional(), accounts: z.union([z.enum(["mine", "team"]), z.array(z.string()).max(20)]).optional(), calendars: z.union([z.enum(["primary", "all"]), z.array(z.string()).max(20)]).optional(),
      tz: z.string().optional().describe("IANA timezone for reading/printing times (default the account's, then the team's)"),
    },
  }, async (a) => {
    const r = await cal.listEvents(ctx, a);
    return { ...r, events: r.events.map((e) => ({ ...e, description: e.description || undefined })), summary: r.events.length === 0 ? `Nothing on ${r.accounts.join(", ")} in that range.` : r.events.slice(0, 40).map(line).join("\n") + (r.events.length > 40 ? `\n… +${r.events.length - 40} more` : "") };
  });

  tool(server, ctx, {
    name: "calendar_get_event", title: "One event in full", cls: "read",
    description: "Full details of one event: guests and their responses, Meet link, location, notes, organizer, link to the CRM meeting if any.",
    input: { event_id: z.string(), account: accountParam, calendar: calendarParam },
  }, async (a) => ({ event: await cal.getEvent(ctx, a) }));

  tool(server, ctx, {
    name: "calendar_create_event", title: "Book a meeting", cls: "write",
    description: "Create an event on one of the user's Google accounts — with a Google Meet link and emailed invites by default. Turn relative dates into absolute ones first. Title convention: the one the user gave, else the team's invite title template (crm_context → settings.invite_title_template; placeholders {me} {who} {contact} {company} {studio}; default '{me} <> {who}' = '<User first name> <> <name the user used>'; never invent a name from an email). 30 min unless said. Only guest emails the user gave or that are already on an event. If no time was given, do not pick one: run calendar_free_slots and offer 2–3 slots first. A second event with the same title at the same start is not created (created: false, duplicate_of) unless allow_duplicate. Link it to the CRM: meeting_id (existing CRM meeting) or crm {deal_id | contact_email | company, contact_name} to create the CRM meeting too — do this whenever the guest is a prospect.",
    input: {
      title: z.string().min(1).max(300), start: whenParam("Start"), end: z.string().optional().describe("End time (or last day for all-day)"), duration_min: z.number().int().min(5).max(24 * 60).optional().describe("Minutes (default 30)"), all_day: z.boolean().optional(),
      attendees: emails.describe("Guest emails"), description: z.string().max(5000).optional().describe("Agenda / notes"), location: z.string().max(500).optional(),
      meet: z.boolean().optional().describe("Add a Google Meet link (default true; false for in-person)"), notify: notifyParam, allow_duplicate: z.boolean().optional(),
      account: accountParam, calendar: calendarParam, tz: z.string().optional().describe("Timezone the start/end are written in (default the account's)"),
      meeting_id: z.string().uuid().optional().describe("Existing CRM meeting to link"),
      crm: z.object({ deal_id: z.string().uuid().optional(), contact_id: z.string().uuid().optional(), contact_email: z.string().optional(), company: z.string().optional(), contact_name: z.string().optional(), timezone: z.string().optional(), notes: z.string().optional() }).optional().describe("Create + link a CRM meeting (same resolution as schedule_meeting: deal, or contact/company whose open deal is used — created if none)"),
    },
  }, async (a) => {
    const r = await cal.createEvent(ctx, a);
    const e = r.event;
    const guests = e.attendees.filter((x) => !x.self).map((x) => x.email);
    const summary = !r.created
      ? `Not created — an event with this title already starts then: ${line(e)} (pass allow_duplicate to book it anyway).`
      : `Booked on ${e.account_email}: ${e.title}, ${e.when}${guests.length ? `, with ${guests.join(", ")}` : ""}${e.meet ? `, Meet ${e.meet}` : ""}${guests.length ? ({ all: " — invites emailed", externalOnly: " — invites emailed to external guests", none: " — no invite emails" } as Row)[r.notify] : ""}${r.overlaps.length ? `. Heads-up: overlaps ${r.overlaps.map((o: Row) => `'${o.title}' (${o.when})`).join(", ")}` : ""}${e.crm?.company ? `. Linked to the CRM meeting with ${e.crm.company}` : ""}${r.crm_error ? `. CRM link failed: ${r.crm_error}` : ""}.`;
    return { ...r, summary };
  });

  tool(server, ctx, {
    name: "calendar_update_event", title: "Move / edit a meeting", cls: "write",
    description: "Change an event: new start (length kept unless end/duration_min), duration, title, guests (add_attendees / remove_attendees, or attendees to replace), notes, location, or add a Meet link (meet: true). Guests are emailed by default (notify). Only the user's own accounts can be edited; a linked CRM meeting moves with it. Find the id with calendar_events first; if the user is not the organizer, only their copy changes — say so.",
    input: {
      event_id: z.string(), account: accountParam, calendar: calendarParam,
      title: z.string().max(300).optional(), start: z.string().optional().describe("New start (see calendar_create_event.start)"), end: z.string().optional(), duration_min: z.number().int().min(5).max(24 * 60).optional(),
      add_attendees: emails, remove_attendees: emails, attendees: emails.describe("Replace the whole guest list"), description: z.string().max(5000).optional(), location: z.string().max(500).optional(), meet: z.boolean().optional(), notify: notifyParam, tz: z.string().optional(),
    },
  }, async (a) => {
    const r = await cal.updateEvent(ctx, a);
    return { ...r, summary: `Updated on ${r.event.account_email}: ${line(r.event)}${r.not_organizer ? ` — note: ${r.event.account_email} is not the organizer, so other guests keep the organizer's version` : ""}${r.meeting_updated ? " — the CRM meeting was moved too" : ""}${r.overlaps.length ? `. Heads-up: overlaps ${r.overlaps.map((o: Row) => `'${o.title}' (${o.when})`).join(", ")}` : ""}.` };
  });

  tool(server, ctx, {
    name: "calendar_delete_event", title: "Cancel a meeting", cls: "write",
    description: "Delete/cancel an event; guests receive the cancellation unless notify: none. Cannot be undone — do it straight away only when the user explicitly asked to cancel that specific meeting; otherwise confirm title + time first. A linked CRM meeting that was still scheduled becomes cancelled.",
    input: { event_id: z.string(), account: accountParam, calendar: calendarParam, notify: notifyParam },
    annotations: { destructiveHint: true },
  }, async (a) => {
    const r = await cal.deleteEvent(ctx, a);
    return { ...r, summary: `Cancelled on ${r.account}: ${r.title}, ${r.when}${r.meeting_cancelled ? " — the CRM meeting is cancelled too" : ""}.` };
  });

  tool(server, ctx, {
    name: "calendar_free_slots", title: "Find free time", cls: "read",
    description: "Free slots of at least duration_min inside working hours (window, default 10:00-19:00 in the calendar's timezone), counting busy time on all of the user's connected accounts (accounts: 'team' for everyone's, or a list). Declined, free/transparent and all-day events do not block. with: guest emails whose busy times to add when Google lets this account see them (usually same-Workspace colleagues); not_visible lists those it could not see — say so instead of promising they are free. Offer the first 2–3 slots in one line.",
    input: {
      date: z.string().optional().describe("First day (default today)"), days: z.number().int().min(1).max(31).optional().describe("How many days (default 1)"), duration_min: z.number().int().min(5).max(480).optional().describe("Minutes needed (default 30)"),
      window: z.string().optional().describe("Working hours 'HH:MM-HH:MM' (default 10:00-19:00)"), with: emails.describe("Guest emails to check"), weekdays: z.boolean().optional().describe("Skip Saturday/Sunday"),
      accounts: z.union([z.enum(["mine", "team"]), z.array(z.string()).max(20)]).optional(), tz: z.string().optional(),
    },
  }, async (a) => cal.freeSlots(ctx, a));

  tool(server, ctx, {
    name: "calendar_event_for_meeting", title: "Add a CRM meeting to Google Calendar", cls: "write",
    description: "Create the Google event for an existing CRM meeting that has none yet (title and description from the team's invite templates in settings — default '<Me> <> <contact>' — the contact's email + the meeting's attendee emails as guests, Meet link, invites) and link them. schedule_meeting does this by itself when the member has a calendar connected; use this for meetings booked before the calendar was connected.",
    input: { meeting_id: z.string().uuid(), account: accountParam, notify: notifyParam, title: z.string().max(300).optional(), meet: z.boolean().optional() },
  }, async (a) => {
    const r = await cal.createEventForMeeting(ctx, a.meeting_id, a);
    const e = r.event as cal.EventRow;
    return { ...r, summary: r.already_linked ? `That meeting already has a Google event: ${line(e)}` : `Booked on ${e.account_email}: ${line(e)}${e.meet ? ` · ${e.meet}` : ""}` };
  });
}
