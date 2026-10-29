# Sequence lead filters, bulk unenroll & Analytics

Built 26 October 2026 from `PRD Sequence lead filters, bulk unenroll & Analytics.md`. The sequence page's **Leads** tab got a grouped status filter with live counts, a teammate sub-filter, a Stopped by column, four "where is this person?" columns, checkboxes with select-all-matching, a sticky action bar (Unenroll · Pause · Resume), a confirm and a 10-second Undo. The **Analytics** tab was rebuilt around seven sections under one date range, every count opening the Leads tab on its filter.

## Where things live

| Piece | File |
|---|---|
| Migration (status log, step runs, daily plan, filter vocabulary, counts / list / bulk / undo / analytics RPCs, backfill, two crons) | `migrations/outreach/101_sequence_leads_analytics.sql` |
| Smoke test (65 assertions: counts, pagination, the new columns, teammate filter, bulk by ids and by filter in chunks, undo and its expiry, the four run triggers, analytics sections, grants, crons) | `migrations/outreach/tests/smoke_31_sequence_leads_analytics.sql` |
| Filter vocabulary, row / analytics shapes, confirm text, step text | `lib/outreach/sequenceLeads.ts` |
| Status names people see (label-only renames) | `lib/outreach/reasons.ts` → `ENROLLMENT_STATUS_LABEL`, `EXIT_REASONS` |
| Hooks (`useSequenceLeadCounts`, `useSequenceLeads`, `useSequenceAnalytics`, `useSequenceAnalyticsLeads`, `previewBulk`, `runBulk`, `undoBulk`) | `components/outreach/sequences/hooks.ts` |
| Leads tab table | `components/outreach/sequences/leads/SequenceLeads.tsx` (replaces `EnrollmentsTable.tsx`), controls in `leads/BulkControls.tsx`; mounted by `Builder.tsx` as the whole Leads tab; the enrol wizard is `EnrolDrawer.tsx`, a right-side drawer opened by the tab's "Enrol leads" button |
| Analytics tab | `components/outreach/sequences/stats/SequenceAnalytics.tsx` (replaces `stats/SequenceResults.tsx`; keeps the 089 per-channel blocks and A/B tests below the seven sections via `SequenceStepTables only="ab"`) |
| Analytics → Leads link | `Builder.tsx` `openLeads` → `SequenceLeads link` (filter + enrolled-in window + teammate); `?status=&from=&to=&teammate=` also work as a deep link |
| Demo (product tour) | handlers in `lib/outreach/backend/demo/rpc/sequences.ts` (`sequence_lead_counts`, `sequence_leads`, `sequence_bulk_preview`, `sequence_bulk`, `sequence_bulk_undo`, `sequence_analytics`, `sequence_analytics_leads`) |

## The vocabulary (feature 1)

Stored enrolment statuses are unchanged. The filter has **12** options in two groups plus two top options; five are tabs above the table (Live · Invite sent · Human handoff · Finished · Unenrolled), all are in the dropdown with a live count. `outreach__lead_filter_statuses(filter)` is the one definition the counts RPC, the list RPC and the bulk RPC share, so a count always equals the table it opens.

| Option | Stored statuses | Note |
|---|---|---|
| Live | active · waiting_connection · waiting_delay · waiting_task · paused | tab |
| All | every status | includes Do not contact |
| Active | active · waiting_delay | **"Waiting"** (the Delay-step wait) folded in: open question 2 |
| Invite sent | waiting_connection | **"Waiting to connect" merged in**: the engine sets `waiting_connection` the moment the invitation goes out (002/011 `outreach_enter_node`), so the two were one state. Open question 1 → yes → merged, which is why there are 12 options and not 13 |
| Waiting on a task | waiting_task | manual task, enrichment, AI review / route |
| Paused | paused | includes reply holds |
| Finished | completed | tab |
| Human handoff | exited_replied | tab; was "Stopped: replied" |
| Stopped by teammate | exited_manual | teammate sub-filter on `status_changed_by`; rows without one are shown as "stopped before teammates were recorded, or through the API" |
| Sender disabled | exited_sender_disabled | was "Stopped: sender disabled" |
| Failed | failed | the table links to the Failed & skipped view (retry / skip / exit) |
| Unenrolled | cancelled | tab; was "Cancelled". **Nothing wrote `cancelled` before 101**; Unenroll (row button and bulk) writes it with `exit_reason = 'unenrolled'` |
| — | exited_suppressed | "Do not contact": not an option, still counted in All, findable from the Leads page |

Open question 3: a teammate's manual stop (`exited_manual`, from the inbox / lead page / a failed-lead "exit") and an unenroll (`cancelled`) stay **separate** numbers everywhere (filter, Stopped by column, Team section). They mean different things to the lead (a stop usually follows a conversation; an unenroll is housekeeping) and merging them would hide which one a teammate does a lot of.

## Data (the PRD's "Data requirements")

- **`outreach_enrollment_status_log`** — every status change: previous → new status, the step, `actor` (= `auth.uid()`; null for the workers) + `actor_type`, `reason` (the exit reason, or the bulk reason: `unenrolled` / `undo` / `pause` / `resume`), `batch_id`. Written by the BEFORE trigger `outreach_enr_aa_status_log`, which also keeps `outreach_enrollments.status_changed_by / status_changed_at` (the Stopped by column and the teammate filter read the row, not the log). Backfilled with one "enrolled" row per enrolment and one row for its current status (`reason = backfill`, actor system).
- **`outreach_step_runs`** — one row per step outcome with sender and time: `sent / skipped / failed` (trigger on `outreach_actions` status), `accepted` (trigger on `outreach_lead_sender_state.relation`, credited to the invite / follow step that sent the request, fallback the wait step), `replied` (trigger on `replied / last_inbound_at`, credited to the last step that went out, once per enrolment), `read` (trigger on `outreach_messages.read_at`). The accept / reply triggers are named `outreach_lss_a_…` so they fire **before** the engine's `outreach_lss_relation` / `outreach_lss_reply_exit` (same event, name order), which move the lead on. Unique on `(action_id, outcome)` and on `(enrollment_id, outcome)` for accepted / replied, every insert `on conflict do nothing`. Backfilled from actions, the 089 facts (`accepted_at`, `replied_at`) and read receipts. Prefetch / subtask actions are excluded, as in 098.
- **`outreach_sequence_daily_plan`** — planned actions per sequence, sender and workspace day. `outreach_plan_snapshot()` runs hourly (pg_cron `outreach-plan-snapshot`, SQL only) and keeps the **highest** count seen for today, so an action deferred to tomorrow still counts as planned today. Days before the first snapshot fall back to `scheduled_for` (the chart tooltip says so).
- **`outreach_enrollment_undo`** — the pre-unenroll snapshot per batch (status, paused_from, wait, step, exit reason, hold, the ids of the queued actions the exit cancelled). Pruned after a day (`outreach-undo-prune`).

## RPCs (all `authenticated`; `outreach__…` helpers are internal)

| Function | Returns |
|---|---|
| `outreach_sequence_lead_counts(p_sequence, p_from?, p_to?)` | one number per option + `teammates[]` + `do_not_contact` + `stopped_by_system`. The dates = enrolled in that window (workspace days): the Analytics link |
| `outreach_sequence_leads(p_sequence, p_filter, p_teammate?, p_from?, p_to?, p_search?, p_limit=50, p_offset)` | `{total, rows[]}`: lead, sender, status, `step_index / step_total / step_label`, `next` (soonest queued action, else the wait / task / pause the lead sits in; null once ended), `last_message` / `last_reply` snippets (one line, 140 chars; the full text is the tooltip), `changed_by` (name) / `changed_at`. Search: name, company, LinkedIn id, email |
| `outreach_sequence_bulk_preview(p_sequence, p_action, p_ids? \| p_filter…)` | `{total, eligible, skipped, sequence_name}` for the confirm text |
| `outreach_sequence_bulk(p_sequence, p_action, p_ids? \| p_filter…, p_batch?, p_limit=500)` | `{batch_id, done, skipped, remaining}`. Ids: at most 500 a call. Filter: the next 500 eligible rows; the app repeats with the same `p_batch` until `remaining = 0`, showing progress in the action bar (PRD "> 500 runs as a background job": run server-side in 500-row calls the page drives, rather than a worker + job table; leaving the page stops the run at a clean 500 boundary, and Undo covers everything done so far). Unenroll = `outreach_complete_enrollment(id, 'cancelled', 'unenrolled')` + the usual hold / task cleanup; the `enr_exit` trigger cancels queued actions as always. Writes `outreach_audit_log` |
| `outreach_sequence_bulk_undo(p_batch)` | `{restored, skipped}` within **15 minutes** (the toast shows 10 s). Restores status, step, schedule, hold and the cancelled queued actions (`decision = enrollment_cancelled` → queued). Skips a lead enrolled again on the same sender meanwhile. Only the teammate who ran the batch or a manager |
| `outreach_sequence_analytics(p_sequence, p_from?, p_to?)` | the seven sections; RPC default = last 30 days, the app opens on **7d** (per-sequence choice kept in sessionStorage) and sends the sequence's creation date for "All time". `empty = true` before the first step run |
| `outreach_sequence_analytics_leads(p_sequence, p_from?, p_to?, p_limit, p_offset, p_search?)` | section 7, paginated |

### What each Analytics number is

- **Cards** come from the 089 facts, so they match the Sequences list and Reports: Enrolled (enrolments created in the period), Invites sent (`invited_at`), Accepted (`accepted_at`, % of invites sent), Replied (`replied_at`, % of accepted; % of contacted when the sequence sends no invites), Interested (`positive_at` = interested / question reply or a meeting, % of replied), Meetings (`meeting_at`).
- **Activity by day** legend labels (Planned · Sent · Accepted · Replied · Interested · Meetings) are toggles: click one to hide / show that series in the chart and tooltip; the last visible series cannot be hidden. Not persisted.
- **Lead progress** = everyone enrolled in the period by status group now (same groups as the filter; Stopped = teammate + sender disabled + do not contact). Equals `outreach_sequence_lead_counts` for the same window (smoke 5e).
- **Steps** = `outreach_step_runs` in the period per sending / task step: Sent · Accepted (invite / follow steps) or Read (message steps) · Replied · Skipped · Failed with %. Rows carry `variant_id` / `has_variants`; the Variant column exists in the component behind `SHOW_VARIANT_COLUMN`.
- **Activity by day** (was "Planned vs sent"; migration 105, 29 Oct 2026) = one stacked bar a day — sent runs plus the accepted / replied / interested / meetings of that workspace day from `outreach_sequence_lead_facts` (the stat cards' own timestamps, so the days add up to the cards) — drawn over a grey ghost bar of the daily plan snapshot (fallback `scheduled_for`); today's gap and a one-line reason when it is over 20 %: the sequence is paused → N senders hit their daily limit (cap / budget / hourly deferrals in the last day) → N senders not connected → the day is not over → held back by schedules.
- **Sender accounts** = the pool plus any sender that ran a step: status (`StatusPill`, the Senders page states) + a "Limited" badge when today's invite or message budget is used up, actions sent, acceptance (accepted ÷ invites), replies (replied ÷ touches), failed, live leads.
- **Team** = handoffs taken (a teammate's own message, `messages.sent_by`, in the lead's chat after the handoff), stopped (log rows → `exited_manual` by a user), unenrolled (log rows → `cancelled`, reason `unenrolled`, by a user); plus "N handoffs nobody has answered yet".
- **Leads** = enrolled in the period: step reached (highest sent step), accepted / replied / interested / meeting from the facts.

Links: the stat cards Enrolled → All and Replied → Human handoff; every progress segment; Team counts (stopped → Stopped by teammate with that teammate; unenrolled → Unenrolled; handoffs → Human handoff). All carry the period as an "Enrolled <dates>" chip on the Leads tab, so the two tabs show the same people. Invites sent / Accepted / Interested / Meetings have no status that means exactly that, so they are not links.

## Deviations from the PRD (and why)

| PRD | Built | Why |
|---|---|---|
| 13 options, "Waiting to connect" kept | 12 options; merged into Invite sent | Open question 1 answered by the engine: the two were one state |
| "Waiting" maps to "the status it actually represents" | Active | `waiting_delay` = a step is scheduled after a Delay; that is Active's definition |
| > 500 leads "run as a background job" | 500-row RPC calls driven by the page under one batch id, progress in the action bar | No worker, no job table, no polling; Undo still covers the whole run; stopping mid-way leaves clean 500-row chunks |
| Undo "within 10 seconds" | toast 10 s; server window 15 min | a slow click should not fail; the batch is unambiguous |
| Team: one number or two for stop vs unenroll (Q3) | two | different actions with different meanings |
| Reply column "shown for Human handoff" | Human handoff and All | All is where a manager scans everything |
| Step table "Accepted or Read" | Accepted on invite / follow steps, Read on message steps | read receipts exist for LinkedIn / Instagram / WhatsApp messages (025); people can turn them off |
| Stat cards every count links | Enrolled and Replied link; others are not statuses | — |

Also: the row-level "Exit sequence" button became **Unenroll** (status `cancelled`, undoable). The lead page's "Exit enrollment" and the inbox stop keep writing `exited_manual` = Stopped by teammate, now with the teammate recorded. Status names changed app-wide (lead page, inbox, reports exits): Human handoff, Stopped by teammate, Sender disabled, Unenrolled, Do not contact; a lead in a Delay step reads Active.

## Rollout status (26 Oct 2026)

- Migration + smoke pass in a rolled-back dry run against the live project (`cat 101 smoke_31 > t.sql; bash scripts/outreach-sql.sh t.sql` → SMOKE OK, 65 assertions, including the 101 backfill over the live data).
- **Applied live 26 Oct 2026** through the Supabase MCP (`apply_migration` `101_sequence_leads_analytics`, same text as the repo file); smoke_31 then passed against the live database (65 assertions, fixtures rolled back). No edge function changes. The web app still needs its usual deploy.
- Follow-ups the same day: the Leads tab toolbar is one compact row; selection uses the Leads page pattern (`SelectionMenu` header checkbox: this page / all / first N, the indigo `BulkBar`, "Showing a–b of N · k selected"); the Failed & skipped panel links the lead name to the LinkedIn profile (new tab, "Lead page" link under it) and shows sender pictures, both fetched client-side from `outreach_leads` / `useSenders` (the row RPC is unchanged).
- `npx tsc --noEmit` clean; `npm run demo:contract` regenerated; `npm run demo:check` passes.
- The connector and public API are untouched: statuses are the same keys; `enrollments_list` / `GET /v1/enrollments` keep working. The new RPCs are app-only for now.
- **29 Oct 2026 — Analytics polish** (`migrations/outreach/105_sequence_analytics_daily_outcomes.sql`, applied live through the Supabase MCP; smoke_31 passes live with the new 5h2 assertion, 66 in all): sender rows show the Senders page photo (client-side join on `useSenders`, the RPC is unchanged); sections now run stat cards → Lead progress → Steps → Activity by day → By channel → Sender accounts → Team → Leads; the day chart is one stacked bar (sent · accepted · replied · interested · meetings) over the planned ghost bar instead of two bars side by side; each Steps row expands (chevron) to the copy it sends, read from the live graph — invitation note, message text, email subject + body as text, task title + instructions, A/B variants with their share, the AI brief when AI drafts the step, and the step's own delay; "of N enrolled" under the progress bar opens All; and every link from Analytics scrolls the Leads tab to the Enrolled leads table (it sits under the enrol wizard). `daily.days[]` keeps its old keys, so an older web build keeps working; the new UI treats missing outcome keys as 0.
