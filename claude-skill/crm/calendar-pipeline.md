# Calendar — book, move, cancel, list, find free time

The CRM connector talks to Google Calendar for the team. Nothing runs locally and there is no sign-in step in the sandbox: each member connected their Google accounts once (in the app, or from a link this connector gives them) and the sign-in lives on the server. The same tools work in Claude, ChatGPT and the web app.

Tools: `calendar_accounts` · `calendar_events` · `calendar_get_event` · `calendar_create_event` · `calendar_update_event` · `calendar_delete_event` · `calendar_free_slots` · `calendar_event_for_meeting` · `calendar_connect_link` + `calendar_connect_finish`. Every time in and out is in the calendar's timezone (the account's, else the team's — Asia/Kolkata, IST) unless `tz` says otherwise.

## Accounts and calendars (more than one of each)

- **Accounts.** A member can connect several Google accounts — typically a work one and a personal one. Each has a `label` ("work", "personal") and `aliases` ("kaptured", "gmail") the member set in the app; `account` on any tool accepts the email, the label, an alias, or the id. One of them is the member's **default**: everything is booked there unless the user names another of theirs ("from my personal calendar" → `account: "personal"`).
- **The team's accounts are visible, not bookable.** `calendar_accounts` lists everyone's; `mine: true` marks the connected user's. `calendar_events` with `accounts: "team"` shows the whole team; `accounts: ["naman"]` one teammate. Creating, moving or cancelling on a teammate's account answers `E_CALENDAR_READONLY` — say so and offer to book on the user's own account, or ask the teammate.
- **Calendars.** Each account has a calendar list (primary + shared/secondary ones, e.g. Family, Holidays). Tools use the account's **primary** calendar unless `calendar: <id>` is given; `calendar_events` with `calendars: "all"` reads every calendar of the chosen accounts. `calendar_accounts` (with `refresh: <email>` after a new calendar was created) shows the ids.
- **Not connected yet / needs reconnect.** `E_CALENDAR_NOT_CONNECTED`, `E_CALENDAR_RECONNECT` or `E_CALENDAR_SCOPE` → connect in two steps, the same sign-in Desk uses:
  1. `calendar_connect_link(hint: <their email>)`. Give the user the URL **exactly as returned** and tell them: open it, pick the account, allow every calendar permission (it must include *view and edit events*); the browser then goes to an address starting with `http://127.0.0.1:53682/` that **will not load, which is expected**; copy that whole address from the address bar and paste it here.
  2. `calendar_connect_finish(address: "<what they pasted>")` → `Connected <email>`. Then carry on with what they asked.
  The link is valid for 15 minutes and the address works once; if finishing fails, run step 1 again for a fresh link. The sign-in is stored on the server (encrypted), not in the sandbox, so it survives across chats and works in every client. Do this once per account (work and personal are two). In the CRM app the same thing is the **Connect Google Calendar** button (on localhost Google comes straight back with no pasting). `E_CALENDAR_NOT_CONFIGURED` means the server itself is not set up — tell the user an admin has to finish the setup (docs/crm/SETUP.md → Google Calendar) and stop.

## Book a meeting

"Book a meeting with naman@resourceplan.io tomorrow at 4" →
`calendar_create_event(title: "Aarushi <> Naman", start: "2026-10-01 16:00", duration_min: 30, attendees: ["naman@resourceplan.io"], crm: {contact_email: "naman@resourceplan.io"})`

1. **Turn every relative date into an absolute `YYYY-MM-DD HH:MM`** from today's date in the calendar's timezone ("tomorrow", "next Tuesday", "Friday 3pm").
2. **Title**: the one the user gave; otherwise the team's invite title template from `crm_context` → `settings.invite_title_template` (placeholders `{me}` first name, `{me_full}`, `{who}` contact first name else company, `{contact}`, `{contact_first}`, `{company}`, `{studio}`; default `{me} <> {who}` → `Aarushi <> Naman`). With no name given, use the email in place of the name: `Aarushi <> naman@resourceplan.io`. Never invent a name from an email address. The user's first name comes from `crm_context` (`me.display_name`). `schedule_meeting` and `calendar_event_for_meeting` apply the title and description templates (`settings.invite_description_template`, default `{notes}

{company} · {contact}`) by themselves; the team edits both in **CRM → Settings → Calendar invites**.
3. **Duration**: what the user said; otherwise 30 min (`duration_min`, or `end`).
4. **Guests**: every email the user named. Only use addresses the user gave, that are on the contact in the CRM (`search`), or that are already on an event; if they gave only a first name and no email is known, ask for the email.
5. **Defaults already right**: a Google Meet link is added, and invites are emailed to guests (`notify: all`). `meet: false` for in-person (add `location`), `notify: none` to add silently.
6. **No time given?** Don't pick one silently: `calendar_free_slots(days: 5, weekdays: true, with: [<guest email>])` and offer the first two or three slots in one line, then book the one chosen. When the time was given, just book it.
7. **Link it to the CRM** whenever the guest is a prospect or customer: `crm: {contact_email}` (or `company` / `deal_id`). That creates the CRM meeting on their open deal (a deal is created if none is open, the company/contact if unknown) and links the two — the standup, capture and coaching then all know about it. An internal or personal event gets no `crm`.
8. Report back in two or three lines: title, day/time, guests, Meet link, and any `overlaps` the tool returned as a heads-up.

The tool refuses to create a second event with the same title at the same start (a retry cannot double-book): `created: false` with `duplicate_of`. `allow_duplicate: true` overrides that only when the user really wants two.

**From the CRM side.** `schedule_meeting` creates the Google event by itself when the member has a calendar connected (`calendar_note` says what happened; `calendar: false` skips it). A CRM meeting booked before the calendar was connected can be put on Google Calendar with `calendar_event_for_meeting(meeting_id)`.

## Find, reschedule, edit, cancel

Every change needs the event **id**. Find it first:

```
calendar_events(from: "today", days: 7, q: "naman")        # search title/description/guests
calendar_events(from: "2026-10-01", to: "2026-10-01")     # one whole day
calendar_events(from: "today", days: 1, accounts: "team")  # everyone's calendars together
calendar_get_event(event_id)                               # full details, link, notes
```

If more than one event matches, ask which one (show day, time, title) before changing anything. Events linked to a CRM meeting carry `crm.meeting_id` / `crm.company`.

```
calendar_update_event(event_id, start: "2026-10-02 17:00")          # move; the length is kept
calendar_update_event(event_id, duration_min: 45)                    # longer
calendar_update_event(event_id, title: "Kaptured x Resourceplan")    # rename
calendar_update_event(event_id, add_attendees: ["a@x.com"], remove_attendees: ["b@y.com"])
calendar_update_event(event_id, description: "Agenda: …", location: "Office")
calendar_update_event(event_id, meet: true)                          # add a Meet link if missing
calendar_delete_event(event_id)                                      # cancel; guests get the cancellation
```

- Updates and deletes email the guests by default (`notify: all`); `notify: none` keeps it quiet.
- **Deleting**: do it straight away only when the user explicitly asked to cancel/delete that specific meeting; otherwise confirm the title and time first. A delete cannot be undone.
- If the result says `not_organizer`, say so: only the user's copy changes; other guests keep the organizer's version.
- A linked CRM meeting follows: moving the event moves the CRM meeting (`meeting_updated`), cancelling it cancels a still-scheduled CRM meeting (`meeting_cancelled`); a held / no-show meeting keeps its capture. The reverse holds for `update_meeting`.
- Events on a non-primary calendar need `calendar: <id>` on get/update/delete (the `calendar_id` shown by `calendar_events`).

## What's on the calendar / am I free

```
calendar_events()                                            # next 7 days, my accounts, primary calendars
calendar_events(from: "today", to: "today", accounts: "team")
calendar_events(from: "tomorrow", days: 1, calendars: "all", accounts: ["personal"])
calendar_free_slots(date: "tomorrow", duration_min: 60)       # busy time on all my accounts counted
calendar_free_slots(date: "2026-10-01", days: 3, weekdays: true, with: ["naman@resourceplan.io"])
calendar_free_slots(window: "09:00-21:00")                    # different working hours
calendar_free_slots(accounts: "team", duration_min: 30)       # a slot the whole team has free
```

`calendar_free_slots` counts busy time from the user's connected accounts' primary calendars (declined, free/transparent and all-day events do not block). A guest's busy times are added only when Google lets this account see their calendar (usually colleagues in the same Workspace); `not_visible` names the ones it could not see — say so rather than promising they're free.

Answer "what's on today" as one line per event: time, title, who with, Meet if any — plain words, no ids unless the user is about to change something.

## Errors

| Code | Meaning / what to do |
|---|---|
| `E_CALENDAR_NOT_CONNECTED` | The user has no Google account connected. `calendar_connect_link(hint)` → they paste back the address → `calendar_connect_finish` → retry. |
| `E_CALENDAR_RECONNECT` | Google no longer accepts the saved sign-in (revoked/expired). Connect again (both steps) with that email as `hint`. |
| `That sign-in address is not from a link…` / `did not accept that code` | Stale, cut-off or already-used address. Run `calendar_connect_link` again for a fresh link. |
| `E_CALENDAR_SCOPE` | The account was connected read-only. Same link; the user must allow *view and edit events*. |
| `E_CALENDAR_READONLY` | A teammate's calendar. Book on the user's own account, or ask the teammate. |
| `E_CALENDAR_NOT_CONFIGURED` | Server setup missing (admin). Nothing else to do here. |
| `E_NOT_FOUND` on get/update/delete | Wrong id, or the event lives on another calendar/account: pass `calendar` / `account`. |
| `E_GOOGLE_NETWORK` | Google unreachable; nothing was changed. Retry shortly. |
