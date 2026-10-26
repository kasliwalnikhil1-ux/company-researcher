# PRD: Sequence lead filters, bulk unenroll & Analytics

Oct 26, 2026 · @Aarushi Jain

## Summary

We are reworking the Leads tab inside a sequence in three ways. The status filter goes from 14 flat options to 13 grouped options with clear names. Bulk unenroll is added. A new Analytics tab shows how each step, sender and teammate performs. Smartlead's campaign Leads and Analytics pages are the reference, rebuilt in our own UI for LinkedIn outreach.

## Problem

- **The filter is hard to read.** Its 14 statuses sit in one flat list. Some overlap (Live, All, Active, Waiting) and some are named after system internals ("Stopped: replied", "Cancelled").
- **No accountability by teammate.** "Stopped by a teammate" can't show which teammate stopped which leads.
- **No bulk actions.** Leads can only be unenrolled one at a time.
- **No sequence-level analytics.** There is no view of where a sequence loses people: invite, acceptance, which message, which sender.

## Goals and non-goals

**Goals**

1. A user can tell what any status means without opening docs.
2. A manager can see which teammate stopped or unenrolled which leads.
3. A user can unenroll hundreds of leads in one action, safely.
4. A user can see per sequence where leads drop off and which sender or step is underperforming.

**Non-goals (this release)**

- Email open and click tracking. It doesn't apply to LinkedIn.
- A/B variants per step. The step table should leave room for them later.
- A revenue or deal pipeline in Analytics. Add it once deals are tagged from the inbox.
- Leads page navigation (Outbound / Inbound tabs, moving Lists / Stages / Tags). That is a separate PRD.

## Feature 1: Status filter rework

The filter becomes two groups, In progress and Ended, under two top options, with a live count beside every option. Two statuses are removed, three are renamed and one is added.

| Order | Option | Group | Change | Shows leads that… |
| --- | --- | --- | --- | --- |
| 1 | Live | Top | Unchanged | are in any In-progress status |
| 2 | All | Top | Unchanged | were ever enrolled in this sequence |
| 3 | Active | In progress | Unchanged | have a step running or scheduled |
| 4 | Invite sent | In progress | **New** | have a connection invite sent and not yet accepted |
| 5 | Waiting to connect | In progress | Unchanged | are queued for the invite step (see open question 1) |
| 6 | Waiting on a task | In progress | Unchanged | are paused on a manual task |
| 7 | Paused | In progress | Unchanged | were paused by a user or the sequence |
| 8 | Finished | Ended | Unchanged | completed every step |
| 9 | Human handoff | Ended | **Renamed** from "Stopped: replied" | replied, so the sequence stopped and a person takes over |
| 10 | Stopped by teammate | Ended | **Adds teammate sub-filter** | were stopped manually by a teammate |
| 11 | Sender disabled | Ended | **Renamed** from "Stopped: sender disabled" | stopped because their sender account was disabled |
| 12 | Failed | Ended | Unchanged | stopped on an error |
| 13 | Unenrolled | Ended | **Renamed** from "Cancelled" | were removed from the sequence |
| — | ~~Waiting~~ | — | **Removed** | — |
| — | ~~Stopped: do not contact~~ | — | **Removed** | — |

**Requirements**

- Show group headers (In progress, Ended) as non-selectable labels in the dropdown.
- Show a count beside every option, matching the leads currently in this sequence.
- Promote Live, Invite sent, Human handoff, Finished and Unenrolled to tabs above the table, with counts. All 13 remain in the dropdown.
- **Teammate sub-filter:** when Stopped by teammate is selected, a second dropdown appears: "Teammate: Anyone / \<name> (count) / …". Only teammates with at least one stop are listed.
- Add a **Stopped by** column, shown when the filter is Stopped by teammate, Unenrolled or All.
- **Migration:** leads in the removed statuses go elsewhere. "Waiting" maps to the status it actually represents (see open question 2). "Do not contact" leads stay out of sequences but leave this filter; they remain findable from the Leads page. All renames are label-only; stored status keys can stay.

## Feature 2: Multi-select and bulk unenroll

Users can select any number of leads in a sequence and unenroll them in one action, with a confirmation and an undo.

1. **Select.** A checkbox column on every row, plus a select-page checkbox in the header.
2. **Select all matching.** After a page is ticked, a banner reads "25 selected · Select all 412 leads matching this filter". Clicking it selects across pages. Its label then becomes "All 412 selected · Clear selection".
3. **Action bar.** A sticky bar shows: "12 selected · Unenroll · Pause · Resume · Clear". Only actions valid for at least one selected lead are enabled.
4. **Confirm.** A modal reads: "Unenroll 12 leads from \<sequence name>? Their scheduled steps are cancelled and they move to Unenrolled. 2 leads that have already ended will be skipped." Buttons: Unenroll / Cancel.
5. **Undo.** A toast reads "12 leads unenrolled · Undo" and stays for 10 seconds. Undo restores each lead's previous status and schedule.
6. **Record.** Each unenroll stores who did it and when. This feeds the Stopped by column and the Team section of Analytics.

**Rules**

- Leads already Finished, Human handoff, Failed or Unenrolled are skipped and counted in the confirm text.
- Bulk actions of more than 500 leads run as a background job. Show progress in the action bar, and a toast when done.
- An unenrolled lead can be re-enrolled later from the Leads page. Unenroll never deletes the lead or its conversation.

## Feature 3: Sequence Analytics tab

Each sequence gets an Analytics tab next to Leads. It has seven sections, top to bottom, all filtered by one date range (default: last 30 days).

| # | Section | What it shows | Smartlead equivalent |
| --- | --- | --- | --- |
| 1 | Stat cards | Enrolled · Invites sent · Accepted (% of sent) · Replied (% of accepted) · Interested (% of replied) · Meetings | Contacted / Opened / Positive replies / Replied / Bounced cards |
| 2 | Lead progress | One stacked bar: Live / Finished / Human handoff / Stopped / Failed / Unenrolled, with counts | "Campaign progress" donut (Completed / In progress / Yet to start / Blocked) |
| 3 | Step table | One row per step (Invite, Message 1, Follow-up 2…): Sent · Accepted or Read · Replied · Skipped · Failed, each with % | Sequence analytics per email step |
| 4 | Planned vs sent | Daily chart of planned actions against actual sends, with today's gap | "Send forecast vs actual" |
| 5 | Sender accounts | Per LinkedIn account: actions sent, acceptance %, reply %, status (Active / Limited / Disabled) | Mailbox and domain health |
| 6 | Team | Per teammate: handoffs taken, leads stopped, leads unenrolled | None (ours) |
| 7 | Lead table | Per lead: step reached, accepted, replied, interested; links to the lead | Lead-level stats table |

**Requirements**

- Every count in sections 1, 2 and 6 links to the Leads tab with the matching filter applied. For example, clicking Human handoff in the progress bar opens Leads filtered to Human handoff.
- The step table keeps a hidden Variant column so A/B variants can be added without a redesign.
- Planned vs sent shows a one-line reason when the gap is above 20%. Example: "2 senders hit their daily invite limit".
- Sender status uses the same states as the sender settings page.
- Empty state before the first send: "Analytics appear after the first step runs."

**Leave out from Smartlead:** open and click tracking, the Smart Servers upsell, the Reply Agent and the revenue pipeline.

## Leads table: new columns

Four columns, taken from Smartlead's campaign Leads page, answer "where is this person?" without opening the row.

| Column | Shows | Example |
| --- | --- | --- |
| Sequence progress | A bar and step count | ▓▓▓░░ Step 3 of 5 |
| Next step | The next action and when it runs | Message 2 · tomorrow 11:00 |
| Last message | A one-line snippet of the last message sent | Will you be interested in… |
| Reply | A one-line snippet of their last reply, shown for Human handoff | Yes, what are the prices? |

Next step is blank for Ended statuses. Snippets truncate at one line, and the full text shows on hover.

## Data requirements

- Store on every status change: lead, sequence, previous status, new status, actor (teammate or system), timestamp. The teammate filter, Stopped by column, Undo and the Team section all read from this.
- Store on every step run: step, sender account, outcome (sent / accepted / read / replied / skipped / failed), timestamp.
- Store the planned action count per sender per day, so the planned vs sent chart has a baseline.

## Acceptance criteria

- [ ] The filter shows 13 options in two groups. Each option has a count that matches the table when selected.
- [ ] "Waiting" and "Stopped: do not contact" no longer appear. No lead disappears from All after migration.
- [ ] Selecting Stopped by teammate shows the teammate dropdown. Picking a teammate shows only their stops.
- [ ] Select all matching, then Unenroll, unenrolls every matching lead, skips ended leads, and can be undone within 10 seconds.
- [ ] Analytics totals match the Leads tab counts for the same date range.
- [ ] Clicking any Analytics count opens Leads with that filter applied.

## Open questions

1. Does "Waiting to connect" already mean the invite was sent and is pending? If yes, merge it into Invite sent rather than keeping both.
2. What did "Waiting" cover, and which status should those leads map to?
3. Should a teammate's manual stop and a teammate's unenroll be counted separately in the Team section, or as one number?
