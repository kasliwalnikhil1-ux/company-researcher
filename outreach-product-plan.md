# CapitalxAI Outreach: Product Plan to Close the Competitive Gaps

**From "strong engine with gaps" to the tool agencies switch to** (updated 20 Sep 2026)

This plan covers the gaps in [outreach-vs-competitors.md](outreach-vs-competitors.md). That document draws on user reviews of four tools ([linkedin-outreach-tools-review-analysis.md](linkedin-outreach-tools-review-analysis.md)) and on the full GetSales help center. Table, function and file names below were checked against the current code, not the PRD.

**Effort key:** S = up to 3 days · M = 1 to 2 weeks · L = 3 weeks or more (one developer working with Claude).

**What changed in this version.** Reading the GetSales help center showed three things:

1. **One planned "win" is only catch-up.** GetSales already stops a lead across all senders when they reply. We still have to fix it first, but we can't sell it as a difference.
2. **GetSales is broader than the reviews showed.** It has automatic enrichment, AI templates and variables, an AI routing step, a public API, white-label, more lead sources and failed-lead recovery. Six new items cover this (marked **new** below).
3. **GetSales is weaker than the reviews showed in ways we can use.** Replies leave leads stuck until someone un-pauses them, its blocklist deletes chat history, there is no A/B report, InMail steps have no fallback, and adding a sender to a running campaign means restarting leads by hand, which can re-send messages. Several items below are shaped to beat these directly.

---

## 1. Where we aim to win

The review analysis ends with five gaps that **no** competitor fills well. Checked against GetSales' own docs, all five are still open there too. We are ahead on one (session handling) and level on the other four. The plan finishes those four first, because that is where a new tool can be clearly better instead of merely equal:

1. **Safe editing of live sequences.** Dripify's most repeated product complaint. GetSales has version history but no pinning, and its "Restart from top" re-sends every message.
2. **Reply-sentiment and funnel reporting.** Every tool gets this complaint. GetSales has a "Replied Positive" stage but no intent report. We already tag every reply with intent, so we are one reports page away.
3. **An inbox that shows exactly which sender and step triggered each reply.** The data is already stored per message. It only needs displaying.
4. **Nothing sends after someone replies, and nobody gets stuck.** We must match GetSales on stopping across all senders. We can beat it on what happens next: they leave the lead paused "until you manually unpause or cancel". We exit cleanly, tag the intent, create the follow-up task, and resume on its own after an out-of-office.

After those, the biggest lever is **lead intelligence**: enrichment plus AI personalization. GetSales leads here today. We can pass it because our AI can see posts and custom fields (theirs can't), and because a person approves what goes out (theirs sends unreviewed, and they withdrew AI comments over quality).

### Rules for every item in this plan

| Rule | Why |
|---|---|
| **One RPC, three surfaces.** Every feature is a database function first, then exposed in the UI, the Claude connector and the public API from that same function | Ends the "connector-only" pattern (queued-text edits, full reports) and makes it impossible for numbers to disagree |
| **Safety stays in the database.** New steps and background jobs (enrichment, voice note, follow, A/B variants) consume existing budgets through `outreach_reserve_budget`. No new code path calls Unipile outside the allowed functions. Caps can never be switched off | Account safety is our strongest story. GetSales lets users turn its limits off, and we never will |
| **Nothing AI-written sends without a person approving it.** Approval can be in bulk (a review table), but never silent | This is our quality difference from GetSales. Bulk review keeps it practical at 500 leads |
| **Nothing we build deletes history.** Blocking, suppressing and cancelling keep the lead, the timeline and the chat | GetSales' Stoplist deletes the contact and the conversation. Agencies need the record |
| **Each item ships with a SQL smoke test** (the existing `do $$ ... raise` pattern) and an entry in the comparison doc | Keeps "solved" claims honest |

---

## 2. Priority summary

| # | Item | Closes | Priority | Effort | Phase |
|---|---|---|---|---|---|
| 1 | Reply stops the lead everywhere, with a clean exit | Expandi complaint; parity with GetSales | P0 | S | 1 |
| 2 | One source of numbers for dashboard, reports and connector | HeyReach complaint | P0 | M | 1 |
| 3 | Stalled-campaign alerts | HeyReach, Expandi; GetSales only has a manual checklist | P0 | S | 1 |
| 4 | Show the originating sequence and step on every message | GetSales, Dripify complaint | P0 | S | 1 |
| 5 | Draft / publish with auto-save | Expandi, HeyReach | P1 | M | 2 |
| 6 | Publish dialog: in-flight leads or new leads only (version pinning) | Dripify (major), all | P1 | M | 2 |
| 7 | UI for editing already-queued text and timing | Dripify, GetSales | P1 | S | 2 |
| 8 | **new** Recover failed leads: retry this step, skip, cancel | GetSales has it, we don't | P1 | M | 2 |
| 9 | **new** Rebalance leads safely when a sender is added or removed | GetSales does this by hand, with a re-send risk | P1 | S–M | 2 |
| 10 | Reports page: funnel, reply intent, sequences, senders, clients, cost | All four | P1 | L | 3 |
| 11 | A/B testing with a results report | Dripify, HeyReach, GetSales (has the step, no report) | P1 | M | 3 |
| 12 | **new** Sender insights: headroom, limit hits, trends, recommendations | GetSales is ahead | P2 | M | 3 |
| 13 | **new** Profile enrichment: free on the fetch we already do, budgeted for the rest | GetSales is ahead | P1 | M–L | 4 |
| 14 | AI first lines and AI variables with a bulk review table; bring-your-own LLM key | GetSales is ahead on volume, behind on quality control | P1 | M | 4 |
| 15 | **new** AI routing step | GetSales has it | P2 | M | 4 |
| 16 | Spintax and conditional text | Dripify, HeyReach | P2 | S | 4 |
| 17 | Blacklists per client and per sequence, including companies | Expandi; GetSales' is destructive | P2 | S | 4 |
| 18 | **new** More lead sources, repeating imports and rules that enrol leads automatically | GetSales is ahead | P2 | L | 5 |
| 19 | **new** Sender assignment that knows contact history | GetSales is ahead | P2 | S | 5 |
| 20 | **new** Email depth: mailbox rotation, unsubscribe link, signature, email schedule, tracking domain, BCC to CRM | GetSales is ahead | P2 | M | 5 |
| 21 | Public API with keys, docs and Zapier/Make/n8n/Clay recipes | Dripify, HeyReach; GetSales has 130+ endpoints | P2 | M | 6 |
| 22 | Native CRM sync: HubSpot, then Pipedrive, then Salesforce | All four, including GetSales | P2 | L | 6 |
| 23 | White-label: branding, custom domain, branded reports | HeyReach; GetSales sells it as an add-on | P2 | M | 7 |
| 24 | Meeting booking, call-task step, follow step | GetSales complaint | P3 | M | 7 |
| 25 | Voice-note step | GetSales complaint | P3 | S–M | 7 |
| 26 | **new** Find-email step (bring your own provider key) | GetSales has it | P3 | M | 7 |
| 27 | Dynamic images and GIFs; notes and a companies object | Expandi; GetSales CRM | P3 | M | Later |

**Before any of this is sold:** billing (Stripe) and notification email (Resend) are built but switched off, and the weekly sender report is built but unscheduled. They are a checklist in Phase 1, not new work. Stall alerts (item 3), sender error emails and branded emails (item 23) all depend on Resend.

---

## 3. Phase 1: Trust fixes (about 2 weeks)

These are the items where a customer would say "it's broken", not "it's missing".

### 1. Reply stops the lead everywhere, with a clean exit · P0 · S

**Problem.** `outreach_trg_reply_exit` ([003_triggers_rls.sql:20](migrations/outreach/003_triggers_rls.sql#L20)) only exits enrollments where `lead_id` **and** `sender_id` match the row that flipped to replied. Email steps run on a mailbox sender while the enrollment belongs to the LinkedIn sender, so an email reply sets `replied` on (lead, mailbox) and the LinkedIn enrollment carries on. The same happens when a lead is in rotation across sender A and sender B. GetSales already pauses "across all sender profiles", so until this ships we lose a direct comparison.

**Build.**
- Sequence setting `stop_on_reply_scope`: `lead` (new default) or `sender` (today's behaviour, kept for the rare case where it's wanted).
- Rewrite the trigger so that scope `lead` exits every live enrollment for that `lead_id` in the workspace, and cancels every queued or reserved action for that lead on any sender. `send_always` steps and `stop_on_reply = false` still win, as now.
- Add `outreach_leads.last_replied_at` and `last_replied_channel`, set in the same trigger. Cheap to read, and needed for the next bullet and for reports.
- Enrol guard: `enroll_preview` lists leads that replied to anyone in the last 90 days and excludes them unless the user ticks "include".
- **Out-of-office replies should not end a sequence.** After classification, an `ooo` intent re-opens the enrollment with a delay (default 7 days, or the return date if the classifier extracts one). Today every reply is final.
- **Optional "hold for review" mode** per sequence, for teams that like the GetSales behaviour: the reply holds the lead, the next message becomes a task, and one click resumes. Unlike GetSales, a held lead shows on the attention list and stops counting toward sender load after 14 days, so nobody is stuck forever.

**Done when.** A smoke test proves: email reply exits the LinkedIn enrollment; reply to sender A cancels sender B's queued actions; `send_always` still sends; scope `sender` behaves exactly as today; an OOO reply resumes after the delay.

### 2. One source of numbers · P0 · M

**Problem.** The dashboard uses `outreach_dashboard` and `outreach_client_stats`; the connector's `report_*` tools compute their own figures in [tools_tasks_reports.ts](supabase/functions/outreach-mcp/tools_tasks_reports.ts). This is the setup that produced HeyReach's "MCP numbers don't match the dashboard" complaint. We can't claim we've solved it until there is only one calculation.

**Build.**
- A small set of SQL functions is the only place a metric is defined: `outreach_report_overview`, `_funnel`, `_sequence`, `_sender`, `_client`, `_intents`. All take `(workspace, client?, from, to)` and run as the caller, so RLS scoping is identical everywhere.
- A written definition for each metric (what counts as "sent", "accepted", "reply", "reply rate" and its denominator, which timezone a "day" is in). For example, GetSales documents that "Messages Replied" counts each contact once per period. Decide ours, put it in [docs/outreach/SQL-REFERENCE.md](docs/outreach/SQL-REFERENCE.md), and show it as tooltips on the reports page.
- Dashboard, client page, connector tools and (later) the public API all call these functions. Delete the separate calculations.
- A parity test that calls the dashboard RPC and the connector tool for the same workspace and range, and fails if any number differs.

**Done when.** The parity test passes in CI and the comparison doc row moves from ◐ to ✅.

### 3. Stalled-campaign alerts · P0 · S

**Problem.** "Why not sending" exists, but only if someone thinks to ask. HeyReach and Expandi users complain about campaigns that quietly stop. GetSales' answer is an 8-step manual troubleshooting article, and they tell agencies to build their own Google Sheets dashboard to see when senders run out of leads.

**Build.**
- Move the diagnosis logic out of [tools_diag.ts](supabase/functions/outreach-mcp/tools_diag.ts) into `_shared/outreach/` so the health worker and the UI can use it too.
- In `outreach-worker-health`: a sequence is **stalled** when it is active, has live enrollments, executed nothing during the last full schedule window of any pool sender, and has nothing planned for the next one. Waiting on delays or on invite acceptance does not count as stalled.
- A second alert, **running dry**: a sender in an active sequence has fewer than 2 days of queued first-step work left. This is the alert GetSales users build by hand in a spreadsheet.
- On either: write the reason (the same plain sentence "why not sending" gives), add it to the dashboard attention list, fire a webhook event (`sequence.stalled`, `sender.running_dry`), email owners and managers (once Resend is on), and show a badge on the sequence list. Alert once per occurrence, then again only after it recovers and recurs.
- A "Why isn't this sending?" button on the sequence top bar and the sender page that runs the same diagnosis in the UI.

**Done when.** Pausing every sender in a pool produces one alert with the correct reason within one health cycle, and resuming clears it.

### 4. Originating sequence and step on every message · P0 · S

**Problem.** `outreach_messages.action_id` already links a sent message to its action, which carries `node_id` and `enrollment_id`. It is just never shown. This is one of the five category-wide gaps and the cheapest to close.

**Build.**
- Under each automated outbound bubble: "Sequence name · Step 3: Follow-up message · via Sender name". Manual replies read "Sent by Teammate name".
- On inbound messages: "Replying to Step 3" with a link that opens the sequence at that step.
- At ingest, stamp `replied_to_action_id` on the inbound message (the last automated outbound in that chat before it). This one column is what makes per-step and per-variant reply reports possible in Phase 3, so it goes in now.
- Inbox filter by sequence. Add the same fields to `inbox_thread` and `inbox_pending` in the connector.

### Phase 1 switch-on checklist

| Item | State | Action |
|---|---|---|
| Stripe billing | Built, off | Configure keys and products; confirm the trial cap and the nightly per-active-sender quantity sync. Test that senders **resume on their own** when a failed payment recovers. GetSales makes users restart every sender and automation by hand |
| Resend email | Built, off | Configure domain; verify disconnect, reconnect-link and invite emails. Add a per-sender list of alert recipients, which GetSales has |
| Weekly sender report | Built, unscheduled | Add the cron job; send to owners and managers |
| `ai_auto_send` setting | Has no effect | Remove it from settings until it does something |
| Post fetches have no budget | Found 20 Sep 2026: like steps, comment steps and AI drafts call Unipile's posts endpoint without reserving anything. Unipile recommends at most 100 post retrievals a day per account | Add the `post_fetch` action type and reserve it in `latestPost` and `drafts.ts` now. Don't wait for item 13. It is a small change, and it makes "every LinkedIn call is budgeted" true |

---

## 4. Phase 2: Safe live editing and recovery (about 4 weeks)

Today running leads always follow the **latest saved** flow. That is what lets us add steps to a running sequence. It also means every save is instantly live for everyone in flight, which is why auto-save doesn't exist and why editing feels risky. The fix is to separate saving from publishing. The second half of this phase makes sure no lead is ever a dead end.

### 5. Draft / publish with auto-save · P1 · M

- Add `outreach_sequences.draft_graph` and `draft_updated_at`. The builder edits the draft and auto-saves it a couple of seconds after each change, with a local copy as a fallback when offline. Nothing in the engine reads the draft.
- **Save** becomes **Publish** for active sequences. Publishing validates, writes a version row and copies the draft to the live graph, as saving does today. For sequences that have never been activated, keep the simple Save behaviour.
- The top bar shows "Draft saved 10:42 · 3 unpublished changes" with a **Discard draft** action. The unsaved-changes guard in [Builder.tsx](components/outreach/sequences/Builder.tsx) stays for the rare case the draft write fails.
- Two people editing at once: the draft carries `draft_base_version`. If the live version moved on since the draft started, publishing shows the diff and asks before overwriting.

**Done when.** Closing the tab mid-edit loses nothing, and no draft change ever reaches a live lead before Publish.

### 6. Publish dialog with version pinning · P1 · M

- Enrollments already record `sequence_version` when they start, but the engine ignores it. Add `pinned_version int null`; when set, the planner and `outreach_advance_enrollment` load that lead's graph from `outreach_sequence_versions` through one helper, `outreach_enrollment_graph(enrollment_id)`.
- The Publish dialog shows the impact before anything changes: "214 leads in flight. 37 are on or after a step you changed. 12 messages with the old text are already queued."
- Then one choice:
  - **Everyone who hasn't reached the changed steps yet** (default, today's behaviour)
  - **New leads only**, which pins the current in-flight leads to the version they are on
- Deleting a step keeps its existing skip-or-cancel prompt, folded into the same dialog.
- The versions page shows how many leads are still running on each old version, with "Move these leads to the latest version".

### 7. UI for queued text and timing · P1 · S

- The RPCs exist from migration 008: `outreach_agent_node_queued_actions`, `outreach_agent_set_action_text`, `outreach_agent_reschedule_delay`. Re-expose them under non-agent names with the same manager check. No engine change.
- When a user edits a message step on a live sequence, the config panel shows "12 messages already queued with the old text", with **Update them too** and **Leave as they are**. The same goes for a changed delay ("reschedule 40 waiting leads").
- The lead panel lists the lead's next queued actions with edit and cancel on each.

### 8. Recover failed leads · P1 · M · new

**Problem.** A failed enrolment is a dead end today. There is no retry or skip in the UI, the connector or the database. GetSales has four bulk actions on every step and a connector "troubleshooter". Theirs has a trap we should avoid: "Restart from top" re-sends every message the lead already received, and their docs carry a warning about it.

**Build.**
- Each step on the canvas shows Failed and Skipped counts next to the existing ones. Clicking opens a list with the plain-language reason per lead, reusing the decision codes in `_shared/outreach/errors.ts`.
- Bulk actions, up to 500 leads at a time:
  - **Retry this step** re-queues the same node under a new idempotency key, through the normal budget.
  - **Skip this step** advances to the next node.
  - **Exit** ends the enrolment.
- There is deliberately **no "restart from top"**. To run a lead through again, enrol them again, which passes through `enroll_preview` and its "already contacted" warnings. That removes the re-send trap by design.
- New RPC `outreach_enrollment_recover(enrollment_ids, action)`, with matching connector tools `enrollments_failed` (grouped by reason) and `enrollment_recover` behind a confirmation gate.
- Failures that fix themselves retry on their own: when a sender reconnects, its leads that failed with `sender_not_ok` in the last 7 days re-queue automatically.

**Done when.** Disconnecting a sender mid-campaign and reconnecting it leaves zero leads needing manual action.

### 9. Rebalance leads when a sender is added or removed · P1 · S–M · new

**Problem.** Like GetSales, adding a sender to a running sequence only affects leads enrolled afterwards. GetSales' documented fix is to select leads on the connection-request step and "Restart from top" by hand, with a warning that doing it from a message step re-sends messages.

**Build.**
- When the pool changes on an active sequence, offer: "Move 140 waiting leads to the new sender?" Only leads with **no outbound action yet** on their current sender are eligible (nothing sent, no invite pending), so nothing can be duplicated and the lead never sees two senders.
- Removing a sender offers the same for its untouched leads. Leads it has already contacted stay with it, or exit, with counts shown for each choice.
- Reuse the `change_sender` logic so the one-live-enrolment-per-lead-and-sender rule still holds.

**Claim after Phase 2:** "Edit a running campaign without rebuilding it, see exactly who a change affects before you publish, never lose work, and never have a lead stuck with no way forward."

---

## 5. Phase 3: Reporting and A/B testing (about 5 weeks)

### 10. Reports page · P1 · L

New route `/outreach/reports`, built only on the Phase 1 report functions.

| Tab | Shows |
|---|---|
| **Overview** | Sent, accepted, replied, interested and meetings over time; by channel; versus the previous period |
| **Funnel** | Enrolled → invited → accepted → messaged → replied → interested → meeting booked → won, with conversion and median time between stages. Filter by sequence, sender, client, list or tag |
| **Replies** | Breakdown by intent (interested, question, not now, not interested, out of office, wrong person, unclear) over time and by sequence, step, sender and variant. Headline numbers: **positive reply rate** and **negative reply rate**. Clicking a number opens the inbox filtered to those threads |
| **Sequences** | Table of all sequences with per-step drop-off, a best and worst step callout, and A/B results |
| **Senders** | Volume, acceptance rate, reply rate, health trend and restrictions per sender. Shows which accounts carry the results |
| **Clients** | The same views per client. This feeds the client portal and the white-label reports. GetSales tells agencies to build this themselves in Google Sheets |
| **Cost** | Cost per reply, per interested reply and per meeting. Inputs: a monthly cost per sender (default is the plan price, editable) and an optional deal value on the won stage. Return is only shown when the workspace has entered deal values; we don't guess |

**Data.** A daily rollup table, `outreach_daily_stats`, keyed by date, client, sequence, node, variant, sender and channel. It is filled nightly, and today's figures are read live. This keeps the page fast at 150 senders and gives the API something cheap to serve.

**Also.** CSV export on every table, saved date ranges, and a weekly email digest to owners, managers and (optionally) client viewers. Stages should also move on their own: a reply classified as interested sets the lead to a "Replied: interested" stage unless the workspace turns that off. The funnel's later stages depend on this.

**Done when.** Every number on the page matches the connector's `report_*` tools under the parity test, and the intent breakdown matches inbox filter counts for the same range.

### 11. A/B testing with a results report · P1 · M

GetSales has a weighted A/B step, and its own FAQ says: "There is no dedicated A/B test overview report… you need to do this manually." The report is where we win, so it ships together with the step.

**Step 1: message variants inside a step.** This is what most reviewers actually mean by A/B testing.
- `send_invite`, `send_message`, `send_inmail` and `send_email` accept `variants: [{id, label, text, subject?, weight}]`.
- Assignment is a hash of the enrollment and the node, so it is random across leads but stable for each lead. Retries and previews always show the same variant. The variant id is stored on the action, and `outreach_node_stats` gains `variant_id` in its key.
- Results per variant: sent, accepted, replied, **interested**. Judging by positive replies, not just replies, is something competitors can't do because they have no intent data.
- No winner is declared under 100 sends per variant. Above that, show the difference with a confidence label (two-proportion test). **Promote winner** sets that variant to 100% and publishes a new version.

**Step 2: an `ab_split` step** with weighted branches, for testing whole paths (for example invite with a note versus without, or LinkedIn-first versus email-first). Same sticky assignment, reported as branch-versus-branch funnels on the Sequences tab.

**Later:** auto-promote after a confidence threshold, off by default.

### 12. Sender insights · P2 · M · new

GetSales' sender page is the best-presented part of its product: a six-axis health radar with written advice, a warm-up ladder showing progress to the next tier, "Safety Buffer", a count of LinkedIn limit hits, acceptance trend and a market benchmark. We compute most of this already (`health_score`, `health_breakdown`, budgets, events). We show little of it.

- On the sender page, show the breakdown as plain recommendations ("Acceptance rate is 14%. Below 20% LinkedIn notices. Tighten targeting before raising volume"), generated from `health_breakdown` by rule, not by AI.
- Warm-up card: current level, what unlocks the next one, and the date it can happen.
- Four numbers over the last 30 days: **headroom** (share of the invite cap unused), **LinkedIn limit hits**, **acceptance rate** with trend, and **network growth**.
- A 30-day chart of invites sent against the cap that applied each day.
- **An InMail speed guard.** GetSales documents LinkedIn blocking a sender who went from about 3 to about 16 InMails a day with credits unused. Cap week-over-week InMail growth (no more than about 50% above the previous week's daily average), enforced in the planner.
- A market benchmark needs data from many workspaces, so it waits until we have it.

**Claim after Phase 3:** "The only LinkedIn tool that tells you which message gets *positive* replies, shows the full funnel from invite to meeting, and reports A/B results instead of leaving you to compare by hand."

---

## 6. Phase 4: Lead intelligence and personalization (about 5 weeks)

GetSales is ahead here today. It enriches every import automatically and lets AI write per-lead text at volume. It has two weaknesses. Its AI routing sees only 7 profile fields (no posts, no custom fields), and nothing AI-written is reviewed before it sends. This phase gets us level on data and ahead on quality.

### 13. Profile enrichment · P1 · M–L · new

**How GetSales does it.** On their own servers with a shared contact database (data under 3 months old is reused instantly), so it costs the customer's LinkedIn account nothing. A re-enrich step costs 1 credit per lead. We have no shared database, so we must be careful with the customer's profile-view budget.

**The finding that makes this cheap.** The planner already queues a profile fetch before every invite, message, InMail, like, comment and endorse step (`needs_profile` in [002_functions.sql:1504](migrations/outreach/002_functions.sql#L1504), queued in [planner.ts:177](supabase/functions/_shared/outreach/planner.ts#L177)). `updateLeadFromProfile` in [execute.ts:45](supabase/functions/_shared/outreach/execute.ts#L45) then keeps six fields and discards the rest. **Every lead in a sequence can be enriched for zero extra profile views.**

**Build.**
- New table `outreach_lead_profiles`: about, current role and start date, past roles, education, skills, language, follower and connection counts, recent posts (text, date, reactions), `enriched_at`, `enriched_by_sender`, `source`. Raw fields first, because they power filters and conditions, not just AI.
- **Free path:** the existing pre-step fetch asks for the full sections we store instead of `*_preview`, and saves everything. Ask for named sections (`about`, `experience`, `education`, `skills`, `languages`), not `*`. Unipile's reference warns that "LinkedIn may throttle heavy use of full data section requests" and that throttled calls return **empty sections**. An empty section therefore means "unknown, try again later". It must never overwrite stored data or count as "this person has no About". Keep `notify: false` on these fetches, as the prefetch already does, so enrichment never shows up as a profile visit.
- **Posts are a separate call with a separate allowance (checked against Unipile's docs, 20 Sep 2026).** Listing a person's posts is its own endpoint. Unipile's limits page puts "retrieving posts" in a different bucket from profile retrieval: about 100 profiles a day per account, and separately up to 100 a day for each other action, posts included. Posts do not spend a profile view.
  - **This exposed a gap in today's code.** `latestPost` in [execute.ts:106](supabase/functions/_shared/outreach/execute.ts#L106) (like and comment steps) and the AI draft in [drafts.ts:44](supabase/functions/_shared/outreach/drafts.ts#L44) call the posts endpoint with **no budget at all**. That breaks the rule that every LinkedIn call passes through a database budget.
  - Add a `post_fetch` action type: platform ceiling 100 a day, warm-up caps in line with `like` (5 at level 0, up to 30 at level 5). Like steps, comment steps, AI drafts and enrichment all reserve it.
  - Enrichment fetches posts only when something will use them: a `{{enrich.recent_post}}` variable, an AI variable, an AI routing step, or a "posted recently" filter on that sequence. Otherwise posts are skipped and the profile alone is stored.
- **Budgeted path, for leads not yet in a sequence:** a background job uses only the profile views **left over after the planner has placed the day's sequence actions**, capped at 30% of the sender's limit, inside working hours, with jitter. Senders at warm-up level 0–1 do none, because at 10–20 views a day it would starve their campaigns.
- **Trigger:** on by default for enrolled leads (free). For imported but un-enrolled leads, a workspace setting (off by default), a tick box on each import, and a bulk "Enrich" action. Existing leads are never enriched in bulk without someone asking.
- **Freshness, copied from GetSales:** skip anything enriched in the last 90 days. A "Re-enrich" button on the lead, and a **Refresh profile** sequence step with the same stale filter. Fix their gap: in their stale-only mode a never-enriched lead is skipped; in ours it is enriched.
- **Wait for enrichment** option at enrolment, so a lead doesn't start until the data its first message needs has arrived. The lead page shows waiting, done or failed.
- Lead filters and sequence conditions on the new fields: time in role, past company, skill, posted in the last 30 days, follower count, profile language.
- Variables with fallbacks: `{{enrich.about}}`, `{{enrich.recent_post}}`, `{{enrich.previous_company}}`, `{{enrich.years_in_role}}`.

**Done when.** A lead entering any sequence is fully enriched by the time its first message renders, with no profile views beyond what the sequence already used.

### 14. AI first lines and AI variables, with bulk review · P1 · M

- **AI variables:** a saved prompt plus a fallback, used as `{{ai.icebreaker|fallback}}`. The prompt can reference lead, custom, sender and enrichment fields. This matches GetSales' AI Variables, with one difference: the text is generated **ahead of time** and stored on the lead, not at the moment of sending.
- **Review table:** generating for 500 leads produces a table (lead, source facts used, generated line) with approve all, edit, regenerate and skip. Only approved lines can be sent. A line is left blank, and the fallback is used, when the profile has nothing usable. The AI may only use facts that are on the profile.
- The enrol flow offers "generate first lines for these leads" and holds them at "waiting for review" until approved.
- **Bring your own LLM key** (Gemini, Anthropic, OpenAI) per workspace, with our Gemini key as the default. GetSales supports five providers. This also moves AI cost off us as usage grows.
- AI drafts and reply drafts read the stored enrichment, so they stop re-fetching the profile.

### 15. AI routing step · P2 · M · new

- A step where each branch is described in plain language ("founders and C-level", "agencies, not product companies") plus an "everything else" branch. GetSales calls this AI Condition Rules.
- **Where we go further:** the AI sees enrichment (posts, past roles, skills) and custom fields. GetSales' sees 7 fields and, in its own words, no "posts and activity, company details… custom fields".
- The decision is made once per lead and stored with a short reason and the facts it relied on, shown in the lead timeline. A "test on 20 leads" button shows the split before publishing, which GetSales recommends doing by hand.
- This is routing, not message text, so it doesn't need per-lead approval. The test run is the review.

### 16. Spintax and conditional text · P2 · S

- **Spintax:** `{Hi|Hello|Hey}` in both renderers, [lib/outreach/render.ts](lib/outreach/render.ts) for the preview and `_shared/outreach/render.ts` for sending. They must stay identical, so add a shared test file that both run. The choice is seeded per enrollment, so the preview is exactly what gets sent. The validator checks the **longest** possible combination against LinkedIn's limits (invite notes especially: GetSales documents that an over-length note fails every request) and shows the number of combinations.
- **Conditional text:** `{{#if company}}at {{company}}{{/if}}`, so a missing field doesn't leave a broken sentence.
- **Dynamic images and GIFs** (item 27) are deferred. Expandi users have to pay for Hyperise to get them, and few reviews mention them.

### 17. Blacklists per client and per sequence · P2 · S

- Add nullable `client_id` and `sequence_id` to `outreach_suppressions`, and replace the unique constraint so the scope is part of the key. Scope is workspace, client or sequence.
- Add a `company` kind (company name or LinkedIn company id) next to domain, profile and email. GetSales has an accounts stoplist.
- The **client** scope matters more than the sequence scope Expandi users asked for. An agency must be able to block client A's customers and competitors without blocking them for client B.
- Enforced in the same two places as today: at enrolment (with counts by reason in `enroll_preview`) and again at send time, so an entry added mid-campaign still stops the next step.
- **Non-destructive, and we say so.** GetSales' Stoplist deletes the contact and the conversation history. Ours keeps both.
- CSV upload of domains, emails, profile URLs and companies on the client page and in sequence settings.
- Once the CRM sync exists: "never contact existing customers or open deals", kept up to date from the CRM.

---

## 7. Phase 5: Lead sources, auto-enrolment and email depth (about 4 weeks)

### 18. More lead sources and rules that enrol automatically · P2 · L · new

`outreach_import_kind_t` has three values today: `search_url`, `csv`, `relations`. GetSales has about ten sources. In order of value:

| Source | What it does | Effort |
|---|---|---|
| **Post engagement** | Paste a LinkedIn post URL and import the people who reacted, commented or reposted. High intent. Good for a client's own posts and for competitors' posts | M |
| **Repeating imports** | Re-run a saved search or post daily, weekly or monthly, and add only new people. Pairs with auto-enrol below | S |
| **Conversations as leads** | We already backfill chats when a sender connects. Offer "create leads from these conversations" | S |
| **CSV update mode** | Match on LinkedIn URL or email and update chosen columns only, without touching the rest | S |
| **Sales Navigator saved searches and lead lists** | Choose from the sender's saved items instead of pasting a URL | M |
| **People inside target companies** | Start from a company list, find up to N people per company by title filter. GetSales' "Find contacts from accounts" | L, later |

All of them run under the existing `search_page` and `profile_view` budgets, inside the sender's working hours.

**Auto-enrol rules.** "When a lead joins list X, or matches filter Y, enrol them in sequence Z." GetSales calls this a segment auto-filter. Safety is the hard part: a rule enrols through the same checks as `enroll_preview` (suppression, replied recently, already contacted), has a daily cap, and lists its activity on the sequence page. Together with repeating imports, a campaign stays topped up, which removes the "sender ran out of leads" problem from item 3.

### 19. Sender assignment that knows contact history · P2 · S · new

`outreach_enroll_leads` avoids a sender only if the lead is **currently** in a live sequence with them. `outreach_lead_sender_state` already records every past contact per lead and sender, so add two strategies next to `round_robin`, `least_loaded` and `fixed`:

- **Fresh sender:** choose a sender that has never invited or messaged this lead. If none is left, skip the lead and say why. (GetSales marks the lead Failed.)
- **Same sender as before:** choose whoever last spoke to the lead, to keep the conversation in one place.

`enroll_preview` reports how many leads each rule moved or skipped.

### 20. Email depth · P2 · M · new

We sell LinkedIn and email in one sequence, but the email side is thin next to GetSales.

| Piece | What | Effort |
|---|---|---|
| **Mailbox rotation** | An email step can send from a pool of the sender's mailboxes, split evenly. A contact who has been emailed before always gets the same mailbox | M |
| **Unsubscribe link** | A `{{unsubscribe_link}}` variable and the one-click unsubscribe header. It sets the existing `unsubscribed` flag, which already exits sequences. The pre-launch check warns when an email step has no link | S |
| **Signature** | Per-mailbox signature and a `{{sender.signature}}` variable | S |
| **Separate email schedule** | Email windows separate from LinkedIn windows on the same sender | S |
| **Custom tracking domain** | Open and click tracking under the customer's own domain. **Unipile supports it (checked 20 Sep 2026), but not self-serve.** The customer points a CNAME (for example `link.agency.com`) at `s1.lnk-fllw.com`, Unipile support authorises that domain, and we then pass `tracking_options.custom_domain` on each send. We already send `opens`, `links` and `label`. Build: a `tracking_domain` and status per mailbox or workspace (pending DNS → awaiting approval → active), a DNS check, and a fallback to the default domain until it is active. Each new domain needs a support request to Unipile, so offer this on agency and white-label plans, not to every workspace. Their docs don't state a limit on domains or a turnaround time, so **ask Unipile for both before promising customers a date** | M, plus a manual approval step per domain |
| **Links that must not be rewritten** | Unipile skips tracking on any link carrying the `data-disable-tracking` attribute. Add it automatically to the unsubscribe link and the booking link (item 24) so they stay clean and trustworthy | S |
| **Tracking on manual replies** | `outreach-send-reply` always sends with open and link tracking on. A person's one-to-one reply doesn't need a tracking pixel, and it can hurt deliverability. Make it follow a workspace setting, off by default for replies | S |
| **BCC to CRM** | A BCC address per mailbox. HubSpot, Pipedrive and Salesforce all log email this way, which gives basic CRM logging months before item 22 | S |

Email warm-up stays out of scope (see section 12).

---

## 8. Phase 6: Open the platform (about 6 weeks)

### 21. Public API · P2 · M

GetSales lists "130+ endpoints" on every plan, so for agencies this is expected, not a bonus.

- The connector's tool layer (`tools_*.ts`: role gate, quota class, confirmation gate, error contract) is already a clean API surface. The REST API is a second front door onto the same handlers, not a rewrite.
- New `outreach_api_keys` table: hashed key, workspace, role, optional client scope, last used, revoked. Keys are created and revoked in Settings and shown once. This also fills the "no unattended tokens" gap left open in the connector PRD.
- New edge function `outreach-api`, versioned at `/v1`:

| Resource | Operations |
|---|---|
| Leads | search, get, create or update, tag, stage, list, suppress, timeline, enrich |
| Enrollments | preview, commit, list, pause, resume, exit, recover |
| Sequences | list, get, stats, activate, pause |
| Inbox | list threads, get thread, send reply, set intent, assign |
| Senders | list, get, health, budgets, capacity |
| Reports | overview, funnel, sequence, sender, client, intents |
| Webhooks | list, create, delete, recent deliveries, **replay a delivery** |

- Writes accept an idempotency key header, and an update only changes the fields that were sent. (GetSales had to fix an upsert that blanked every field not included.) Rate limits reuse `outreach_rate_limit`. Actions that spend LinkedIn budget keep the preview-then-commit flow. Caps stay in the database, so the API cannot out-send the UI.
- Webhook replay is a small thing GetSales can't do: "Event-based webhooks cannot be re-triggered."
- An OpenAPI spec, a docs page on the marketing site, and copy-paste recipes for **Zapier, Make, n8n and Clay**. That covers most of what reviewers mean by "integrations" before any native connector exists.

### 22. Native CRM sync · P2 · L

No tool in this comparison has real native CRM sync. GetSales' plan page says "All CRMs with API", which means its API-call step. Order: **HubSpot → Pipedrive → Salesforce.** HubSpot and Pipedrive are what agencies and small sales teams use and their APIs are quick to build against. Salesforce is the loudest complaint in reviews but the slowest to build and certify, so it goes last and only if customers are asking for it.

- `outreach_integrations` (OAuth tokens encrypted the same way as sender secrets) and an `outreach-crm-sync` worker that reads the event stream outbound webhooks already use.
- **Push to the CRM:** create or update the contact and company; log sent messages and replies on the contact's timeline; map our stages to their lifecycle or deal stages; optionally create a deal when a reply is classified as interested.
- **Pull from the CRM:** import a CRM list or segment as leads; keep the "customers and open deals" suppression fresh.
- **Avoid Expandi's mistake** ("HubSpot links every contact"): the default sync rule is **only leads who replied**. Other options are "only interested" and "everyone enrolled". Field mapping has sensible defaults, and every record shows a visible sync log, because reviewers describe competitor connectors as "bumpy" and opaque.
- Build directly against each CRM's API. Revisit a unified-API vendor only if we go past three CRMs.

---

## 9. Phase 7: Agency upsell and remaining steps (about 5 weeks)

### 23. White-label · P2 · M

| Level | What | Effort |
|---|---|---|
| 1. Branding | Per-workspace logo, product name, accent colour and support email, applied to the client portal (`/outreach/c/...`), its login and invite pages, and all emails clients receive | S |
| 2. Custom domain | `outreach_workspace_domains`: the agency points a CNAME at us and the app resolves the workspace from the host name, so the client sees only the portal at `reports.agency.com`. Certificates are issued through the hosting provider's custom-domain feature. Custom help and docs links in the menu, as GetSales offers | M |
| 3. Branded reports | A scheduled weekly or monthly client report (PDF and email) from the Clients report tab with the agency's branding, sent from the agency's own domain | M |

GetSales sells white-label as an add-on from 10 seats. HeyReach's agency price reportedly rose from about $749 to about $1,399 a month in January 2026. There is room to be the fair-priced option.

### 24. Meeting booking, call task, follow · P3 · M

- **Booking: don't build a calendar.** Add a `booking_link` sender field, used as `{{sender.booking_link}}`, with the lead's id attached as a tracking parameter. A **Calendly / Cal.com webhook** then marks the lead "Meeting booked", exits the enrollment, fires a `meeting.booked` event and fills the last funnel stage. When an interested reply arrives, the reply composer offers a one-click "Send booking link".
- **Call task step:** a `manual_task` variant that shows the phone number, a short script and an outcome picker (connected, voicemail, no answer, wrong number). Outcomes are available as branch conditions.
- **Follow step:** only if Unipile exposes a follow action. If it does, it gets its own budget row in the warm-up table like every other action type.

### 25. Voice-note step · P3 · S–M

- A `send_voice_note` step. The sender's owner records or uploads a clip per step; it is stored in `outreach-attachments` and sent as a LinkedIn voice message. It counts against the message budget.
- **Check first:** confirm that Unipile's LinkedIn send-message endpoint accepts a voice attachment on our plan before scheduling this.
- No AI voice cloning. It is a ban and reputation risk and works against our safety story. One real recording per step is the feature.

Video messages are out of scope. GetSales confirms even it can only attach a video file, not send a native video. A link to a Loom in a normal message already works.

### 26. Find-email step · P3 · M · new

- A step with **found** and **not found** branches that fills `email_work`. GetSales runs a waterfall over 20 providers on metered credits.
- We won't resell data. The workspace brings its own key for one or two providers plus a verifier, tried in order, stopping at the first hit. It skips leads with no company domain and leads whose email is already verified, as GetSales does.
- Until then, the Clay recipe from item 21 covers this.

---

## 10. Timeline

| Phase | Weeks | Ships | Comparison-doc rows that move to ✅ |
|---|---|---|---|
| 1. Trust fixes | 1–2 | Reply-stop everywhere with clean exit, one source of numbers, stall and running-dry alerts, step attribution, billing and email switched on | Reply doesn't stop other senders · MCP numbers mismatch · campaigns stall silently · which step triggered a reply |
| 2. Live editing and recovery | 3–6 | Draft/publish, auto-save, version pinning, queued-edit UI, failed-lead recovery, sender rebalancing | Can't edit live campaigns · lost work · failed leads are a dead end |
| 3. Reporting + A/B | 7–11 | Reports page, intent and funnel reports, A/B with a report, sender insights | No sentiment tracking · funnel/ROI reporting · no real A/B testing · sender analytics |
| 4. Lead intelligence | 12–16 | Enrichment, AI variables with review, AI routing, bring-your-own LLM, spintax, scoped blacklists | No enrichment · weak personalization · no AI routing · no campaign-level blacklist |
| 5. Sources and email | 17–20 | Post-engagement and repeating imports, auto-enrol rules, history-aware assignment, mailbox rotation, unsubscribe link, signature | Fewer lead sources · manual enrolment · thin email |
| 6. Platform | 21–26 | Public API and docs, automation recipes, HubSpot, then Pipedrive | No public API · weak CRM integrations |
| 7. Agency + steps | 27–31 | White-label, booking, call task, voice notes, find-email, Salesforce if demanded | No white-label · no voice notes or meeting booking |

Phases 1 to 3 are the product story: after week 11 we have closed all five category-wide gaps, which no competitor, GetSales included, can say. Phase 4 removes GetSales' biggest lead over us. Phases 5 to 7 can be reordered by whatever the first paying agencies ask for.

---

## 11. Pricing and positioning notes

Not a build item, but the GetSales help center makes the pricing picture concrete.

| GetSales today | What it suggests for us |
|---|---|
| Per seat (sender): $69–119 for one seat, falling to $16–30 at 100 seats. 6- and 12-month prepay with free months | Agencies with many seats pay little per seat, so we won't win large agencies on headline price. Solo users and small teams (1–5 senders) pay the most, and that is where we can be clearly cheaper |
| Email is missing from the entry plan. AI, enrichment, email finding and validation are metered monthly credits, and steps fail when credits run out | Include both channels in every plan. If AI must be metered, degrade gracefully (use the fallback text) instead of failing the lead, and offer bring-your-own key (item 14) as the unlimited option |
| Bought seats must be assigned to each team by hand. A failed renewal stops every sender and automation until each is restarted by hand | Per-active-sender billing that adjusts on its own, and automatic resume after a payment recovers. Both are in the Phase 1 checklist |
| "Refunds are not provided." Their docs also suggest entering a California address to avoid VAT | Publish a plain policy: cancel any time in the portal, prorated refund on request, no silent annual renewals. Billing complaints fill the 1★ reviews of three of the four tools |

---

## 12. How we'll know it worked

| Measure | Target |
|---|---|
| Actions sent to a lead after they replied on any channel or sender | 0 |
| Dashboard vs. connector vs. API metric mismatches (parity test) | 0 |
| Time from a sequence stalling to the owner being told | Under 1 health cycle |
| Builder sessions that end with lost changes | 0 |
| Failed enrolments older than 7 days with no action taken | Under 1% of enrolments |
| Live-sequence edits done by delete-and-rebuild | 0 (no reason left to do it) |
| Leads enriched by the time their first message renders | Over 95%, with no profile views beyond what the sequence used |
| AI-written lines sent without a recorded approval | 0 |
| Active sequences using at least one A/B variant, 60 days after launch | Over 30% |
| Workspaces opening Reports weekly | Over 60% |
| Senders restricted per 100 sender-months (the PRD target; must not get worse as features are added) | Under 2 |

---

## 13. Risks to plan around

| Risk | Evidence | Mitigation |
|---|---|---|
| **LinkedIn acts against our Chrome extension** | In August 2026 GetSales' extension left the Chrome Web Store because "LinkedIn requested that we remove the extension". Users now load it unpacked in developer mode | Automatic reconnect must stay optional. Keep the re-login link as a complete fallback, keep the extension small and single-purpose, and prepare an unpacked install guide now, before it is needed |
| **LinkedIn changes break imports and sync** | GetSales' release notes show repeated fixes for search imports, profile formats and InMail sync | We inherit this through Unipile. Every import and sync shows its status and a real error. The stall alerts in item 3 cover imports too |
| **Enrichment eats the profile-view budget** | At warm-up level 0 a sender has 10 profile views a day. Unipile's guidance is about 100 profile retrievals a day per account, which matches our platform ceiling | Item 13 only uses the free path for sequences and leftover capacity for the backlog, never at levels 0–1 |
| **LinkedIn throttles full-profile requests** | Unipile's reference: heavy use of full sections gets throttled, and throttled calls return empty sections with no error | Request named sections only, treat empty as "unknown", never overwrite stored data with empty, and back off a sender that returns empty sections twice in a row |
| **Custom tracking domains depend on Unipile support** | Each domain is authorised by hand on their side | Keep it a paid agency feature with a visible "awaiting approval" state, and confirm limits and turnaround with Unipile first |
| **Scope: 27 items and about 31 weeks** | | Phases 1–3 are fixed. Everything after is re-ranked each phase against what paying customers ask for |

---

## 14. Deliberately not in this plan

| Left out | Why |
|---|---|
| Email warm-up network | A large build outside our core. Recommend a dedicated warm-up tool and document it. GetSales doesn't have one either |
| A cloud browser per sender | GetSales runs each account in its own GoLogin browser. It gives them "open LinkedIn in the protected session", and also cloud-browser limits per plan and black-screen support tickets. Unipile's hosted sign-in covers our need |
| B2B contact database | GetSales' shared contact database is how it enriches instantly. Building one is a different business. Items 13 and 26 cover the need without it |
| Letting users switch safety limits off | GetSales allows it. Bans are the top complaint in the category, and enforced limits are the reason to choose us |
| "Restart from top" | GetSales' docs warn that it re-sends every message. Re-enrolling through the normal preview does the same job safely (item 8) |
| Video personalization | Few mentions in reviews, and competitors use a paid third party for it |
| AI auto-send of messages or replies | Breaks our approval rule. GetSales withdrew AI comments over quality, and "easy to produce spammy outreach" is a complaint we currently solve |
| Support, refund and renewal policy | Real reasons people leave these tools, but they are about how the business is run, not what gets built. Section 11 has the policy to publish |
