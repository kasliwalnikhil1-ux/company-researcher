# CapitalxAI Outreach vs. GetSales, HeyReach, Expandi, Dripify

**What users love that we already have, which complaints we've solved, and where GetSales is ahead of us** (updated 20 Sep 2026)

> ## What changed on 20 Sep 2026
>
> The product plan ([outreach-product-plan.md](outreach-product-plan.md)) was built in one pass: database first (migrations `009`–`017`, applied to the live project), then the web app, the Claude connector, the public API and the workers on top of the same database functions.
>
> * **Every row the plan names has been re-checked against the repo**, and each one now says what was built, where it lives, and which test proves it. The full list is in [Plan items: state and proof](#plan-items-state-and-proof).
> * **The three SQL smoke tests pass on the live database** (`./scripts/outreach-smoke.sh`, 20 Sep 2026: 14 + 30 + 22 assertions). The database-level parity check between dashboard and reports passes too (`./scripts/outreach-parity-test.sh --rpc-only`, 44 numeric keys identical).
> * **In the repo does not mean deployed, and deployed does not mean tried on a live account.** The database is live. The new and changed edge functions (executor, planner, enrichment, AI variables, CRM, API, connector) take effect only after `./scripts/outreach-deploy-functions.sh`, and none of the LinkedIn-, LLM- or CRM-facing code written on 20 Sep 2026 has been run against a real account yet. Rows that depend on it say so.
> * **Built does not mean switched on.** Billing (Stripe), notification email (Resend), CRM sync (one OAuth app per CRM) and custom tracking domains (Unipile approves each domain by hand) need configuration outside this repo. Those rows say "✅ built, needs configuration". The steps are in [docs/outreach/SETUP.md](docs/outreach/SETUP.md) §9.
> * **Nothing here has been measured on customers yet.** "Solved" means the feature exists and is wired up, with a passing test where one exists. It does not mean we have shown fewer bans, more replies or fewer support tickets than a competitor.
> * Writing the metric definitions turned up **two defects in how replies are counted**. They are listed under [Caveats](#caveats-before-using-this-externally) and are not fixed yet.

This document compares two kinds of evidence against what is **actually built** in `/outreach`:

1. **User reviews of all four tools**, from [linkedin-outreach-tools-review-analysis.md](linkedin-outreach-tools-review-analysis.md). This shows what users say.
2. **The full GetSales help center** (87 articles, last modified between Aug 2025 and Aug 2026). This shows how their product works, in their own words. It is first-party, so it is the most reliable source here. It is also one-sided: we have it for GetSales only, so GetSales gets a closer look than the other three.

Our side is based on the code (SQL, edge functions and UI), not the PRD. Competitor facts are unchanged from the previous version of this document; only our side was updated.

**Status key**

| Mark | Meaning |
|---|---|
| ✅ | The database logic **and** at least one user-facing surface (web page, connector tool or API route) exist in this repo |
| ✅ built, needs configuration | As above, but it does nothing until something outside the repo is set up: Stripe, Resend, a CRM OAuth app, or Unipile's approval of a tracking domain |
| ◐ | Partly. The row says what is missing |
| ❌ | Not built |

---

## At a glance

| | Before (19 Sep 2026) | Now (20 Sep 2026) |
|---|---|---|
| Loved competitor features we have in full | 11 of 16 | 14 of 16 |
| Loved competitor features we have in part | 5 of 16 | 2 of 16 |
| Review complaints we solve in full (Part 2) | 17 | 24, one of them gated on Stripe |
| Review complaints we solve in part (Part 2) | 9 | 2 |
| GetSales weaknesses from its own help center that we solve (Part 3) | 9 in full, 3 in part | 11 in full (one row is new), 2 more built and gated on Stripe |
| Things GetSales does that we don't (Part 4) | 17 | Of those 17: 13 matched in code (5 of them not yet run on a live account), 1 built and gated on Resend, 3 matched in part |
| Review complaints still open for us too (Part 5) | 10 | 6 closed, 1 built and gated on CRM OAuth apps, 2 in part, 1 open, plus 1 row added (dynamic images) |

**Strongest story:** multi-sender rotation, LinkedIn + Gmail/Outlook/IMAP in one sequence and one inbox, and layered account-safety limits that the database enforces, so nobody (including an AI agent or an API key) can raise volume past them. GetSales lets users switch its limits off, and ours can't be. Session reconnect runs automatically from a Chrome extension, where GetSales says it "does not auto log in". Every reply gets AI intent tagging, and nothing AI-written sends without a person approving it. New on 20 Sep 2026: one definition of every number for dashboard, reports, connector and API; a reply on any channel or sender stops the lead everywhere and nobody is left stuck; a running sequence can be edited with a preview of who is affected; and A/B tests come with a results report judged on positive replies.

**Biggest honest gap now:** proof on live accounts. Everything in the plan except the follow step now exists in the repo, and the database rules are covered by smoke tests. But the code that talks to LinkedIn, the LLM and the CRMs (enrichment, the five new lead sources, AI first lines, AI routing, voice notes, mailbox rotation, CRM sync) was written on 20 Sep 2026 and has not been deployed or run against a real account. GetSales' equivalents have been in customers' hands for months. Until ours have run on live senders, treat those rows as built, not as proven. The previous biggest gap, a reply on one channel or sender not stopping the lead elsewhere, is closed and covered by a smoke test.

**What the GetSales help center changed in this analysis:** GetSales is a broader product than the reviews suggest. It enriches every imported lead automatically, has AI templates, AI variables and an AI routing step, a public API with 130+ endpoints, a white-label add-on, several lead sources we lacked, and tools to recover failed leads. It is also weaker than the reviews suggest in places that matter: replies leave leads stuck until someone un-pauses them, a logged-out account needs a manual login, its blocklist deletes the contact and the chat history, InMail steps fail with no fallback when credits run out, and there is no A/B report.

---

## Plan items: state and proof

One row per comparison-doc row that the plan's timeline (section 10) says moves to ✅. "Proof" is a test anyone can run. Smoke tests are in `migrations/outreach/tests/` and are described in [docs/outreach/SQL-REFERENCE.md](docs/outreach/SQL-REFERENCE.md).

| Plan row | What was built | Where it lives | Proof | State |
|---|---|---|---|---|
| **Reply doesn't stop other senders** (item 1) | A reply on any channel or sender exits every live sequence for that lead and cancels its queued actions on all senders. Out-of-office replies resume on their own. Optional hold-for-review that expires, so nobody is stuck | `outreach_trg_reply_exit`, `outreach_enrollment_reply_blocked`, `outreach_apply_reply_intent`; sequence settings panel; enrol guard on the enrol page; connector `enrollment_hold_list` | `smoke_01_reply_stop.sql` A1–F3 | ✅ |
| **MCP numbers mismatch** (item 2) | Every metric is defined once in SQL. Dashboard, reports page, client page, connector and API read the same function | `outreach__facts` → `outreach__totals_from`; `outreach_report_*`; connector `report_*` tools; API `/v1/reports/*` | `smoke_02` 2a–2e; `scripts/outreach-parity-test.sh` (the connector checks pass once the new connector is deployed) | ✅ |
| **Campaigns stall silently** (item 3) | Stalled-sequence and running-dry alerts, once per occurrence, with the same plain reason "why not sending" gives. Dashboard attention list, badge, webhook events, "Why isn't this sending?" button | `outreach_detect_stalls`, `outreach_why_not_sending`, table `outreach_alerts`; `WhyNotSendingDialog`, `SenderDiagnosis`, `RunningDry`; connector `alerts_list` | `smoke_02` 3a–3c | ✅ in the app and by webhook. Email alerts: ✅ built, needs configuration (Resend) |
| **Which step triggered a reply** (item 4) | Every automated bubble shows sequence, step, variant and sender. Every inbound message shows the step it answers. Inbox filter by sequence | `outreach_thread_attribution`, `outreach_sequence_chat_ids`, trigger `outreach_trg_message_stamp`; `MessageBubble`; connector inbox tools | `smoke_02` 4a | ✅ |
| **Can't edit live campaigns** (items 5–7) | Drafts that never reach a live lead, a publish dialog that shows who is affected, "new leads only" pins in-flight leads to their version, and a UI for queued text and timing | `outreach_save_draft`, `outreach_publish_impact`, `outreach_publish_sequence`, `outreach_enrollment_graph`, `outreach_set_action_text`, `outreach_refresh_queued_text`; `PublishDialog`, `QueuedNotice`, versions page, lead page queued actions | `smoke_02` 5, 6a–6d, 7 | ✅ |
| **Lost work** (item 5) | The builder auto-saves a draft a couple of seconds after each change, with a local copy when offline | `outreach_save_draft`; `DraftAutosave.ts` | `smoke_02` 5 | ✅ |
| **Failed leads are a dead end** (item 8) | Failed and skipped counts per step with a plain reason. Bulk retry, skip or exit, up to 500. Transient failures retry on their own when a sender reconnects. No "restart from top", on purpose | `outreach_failed_leads`, `outreach_enrollment_recover`, `outreach_requeue_sender_failures`; `FailedLeadsDrawer`; connector `enrollments_failed`, `enrollment_recover`; API | `smoke_02` 8a–8c | ✅ |
| **Rebalancing when a sender is added** (item 9) | Moves only leads with nothing sent and no invite pending, so nothing is duplicated | `outreach_rebalance_preview`, `outreach_set_pool`; `RebalanceDialog`; connector `sequence_pool_preview`, `sequence_pool_set` | `smoke_02` 9 | ✅ |
| **No sentiment tracking** (item 10) | Replies tab: breakdown by intent over time and by sequence, step, sender and variant; positive and negative reply rate; a number opens exactly those threads | `outreach_report_intents`, `outreach_report_reply_threads`; `/outreach/reports` | `smoke_02` 10b | ✅ |
| **Funnel / ROI reporting** (item 10) | Reports page with Overview, Funnel (cohort), Replies, Sequences, Senders, Clients, Cost. CSV export on every table, saved ranges. Return is shown only when deal values were entered | `outreach_report_funnel`, `outreach_report_cost`, `outreach_daily_stats`; `/outreach/reports` | `smoke_02` 10a, 10c, 10d | ✅. Scheduled digest and client report emails: ✅ built, needs configuration (Resend). Client reports are email only, there is no PDF |
| **No real A/B testing** (item 11) | Message variants inside a step and an `ab_split` step, sticky per lead, with a results report judged on positive replies. No winner under 100 sends per variant. Promote winner | `outreach_pick_variant`, `outreach_ab_results`, `outreach_promote_variant`; `VariantEditor`, `VariantResults`; connector `sequence_ab_results` | `smoke_02` V1, V2, 11 | ✅ |
| **Sender analytics** (item 12) | Rule-based recommendations, warm-up card with the next unlock date, headroom, LinkedIn limit hits, acceptance trend, network growth, invites-versus-cap chart, InMail speed guard in the budget | `outreach_sender_insights`, `outreach_inmail_guard`; `SenderInsights`, `InvitesVsCapChart` | `smoke_03` B2 (guard). No SQL test for the insights payload | ✅. No market benchmark: it needs data from many workspaces |
| **No enrichment** (item 13) | Every profile the sequence already fetches is stored in full (named sections, no visit notification). Background enrichment for other leads inside a leftover-only allowance. Empty section means unknown. 90-day freshness, re-enrich, wait-for-enrichment, conditions and `{{enrich.*}}` variables. Posts have their own `post_fetch` budget | `outreach_save_lead_profile`, `outreach_request_enrichment`, `outreach_enrich_allowance`; `_shared/outreach/enrich.ts`, `outreach-worker-enrich`; `EnrichmentCard`, bulk "Enrich" | `smoke_03` B1, 13a–13e | ✅ in code. Not yet deployed or run on a live account |
| **Weak personalization** (items 14, 16) | Spintax and conditional text in both renderers with a shared test. AI variables generated ahead of time with a bulk review table; only approved text can render. Bring your own LLM key (Gemini, Anthropic, OpenAI) | `lib/outreach/render.ts` = `_shared/outreach/render.ts`; `outreach_render_context`, `outreach_ai_review`; `outreach-ai-variables`, `outreach-workspace-secrets`; `/outreach/ai-review`, `/outreach/settings/ai` | `scripts/outreach-render-test.sh` (passes, 20 Sep 2026); `smoke_03` 14a–14c | ✅. The AI worker has not been run on live leads yet |
| **No AI routing** (item 15) | `ai_route` step with plain-language branches and an "everything else" branch. The decision is stored once with its reason and the facts used, and shows in the lead timeline. Falls back after 6 hours. "Test on 20 leads" before publishing | `outreach_ai_route_pending`, `outreach_ai_route_decide`; `outreach-ai-variables`; `AiRouteForm` | `smoke_03` 15 | ✅. Not yet run on live leads |
| **No campaign-level blacklist** (item 17) | Blacklists scoped to workspace, client or sequence, with a company kind and CSV upload. Checked at enrolment and again at send time. Non-destructive | `outreach_add_suppressions`, `outreach_lead_suppression_reason`, `outreach_enrollment_suppression_reason` (called by the executor); `/outreach/settings/suppressions` | `smoke_02` 17, 17b | ✅ |
| **Fewer lead sources** (item 18) | Post engagement, repeating imports, conversations as leads, CSV update mode, Sales Navigator saved searches and lead lists, people inside target companies | import kinds in `outreach-imports-create` and `outreach-worker-imports`; `outreach_save_import_schedule`; import pages | `smoke_03` 18b | ✅ in code. Not yet run against a live LinkedIn account |
| **Manual enrolment** (item 18) | Auto-enrol rules by list or filter, through the same checks as a person, with a daily cap and a visible log | `outreach_save_auto_enroll_rule`, `outreach_run_auto_enroll`; `AutoEnrolRules`; connector `auto_enroll_rules_*` | `smoke_03` 18a | ✅ |
| **Sender assignment that knows history** (item 19) | "Fresh sender" and "same sender as before" strategies; the preview reports what each rule moved or skipped | `outreach__enroll_plan`; `EnrollGuard` | `smoke_02` 19 | ✅ |
| **Thin email** (item 20) | Mailbox rotation with a sticky mailbox per contact, `{{unsubscribe_link}}` with a one-click unsubscribe header, `{{sender.signature}}`, BCC to a CRM address, tracking off by default for manual replies, custom tracking domains | `outreach_pick_mailbox` (planner), `outreach_unsubscribe_lead` + `outreach-unsubscribe`, `outreach_tracking_domain_for` (executor); sender settings, `/outreach/settings/email` | `smoke_03` 20a–20c | ✅ in code, not yet run on a live mailbox. The unsubscribe page needs a hosting decision (SETUP §9.4). Custom tracking domains: ✅ built, needs configuration (Unipile approves each domain by hand) |
| **No public API** (item 21) | REST API at `/v1` over the same RPCs, API keys with a role and client scope, idempotency keys, webhook replay, OpenAPI spec, Zapier / Make / n8n / Clay recipes | `outreach-api`, `outreach_api_dispatch`; `/outreach/settings/api`; [docs/outreach/API.md](docs/outreach/API.md) | `smoke_03` 21a–21c | ✅ once `outreach-api` is deployed |
| **Weak CRM integrations** (item 22) | HubSpot, Pipedrive and Salesforce: OAuth connect, push contacts, companies, messages and stages, optional deal on an interested reply, import a CRM list, keep a "customers and open deals" blacklist fresh. Default sync rule: only leads who replied. Visible sync log | `outreach-crm-oauth`, `outreach-crm-sync`, `_shared/outreach/crm/`; `outreach_crm_should_sync`, `outreach_integration_save`; `/outreach/settings/integrations` | `deno test supabase/functions/_shared/outreach/crm/crm.test.ts` (unit tests with a fake CRM). No SQL smoke test | ✅ built, needs configuration: one OAuth app per CRM. No provider has been connected to a real CRM account yet |
| **No white-label** (item 23) | Logo, product name, accent colour, support and help links on the client portal, invite page and every email. Custom portal domains verified by DNS, resolved by host name. Branded client report emails | `outreach_set_branding`, `outreach_branding_for_host`, `outreach_add_domain`; `outreach-domain-check`; `proxy.ts`; `/outreach/settings/branding`; `notify.ts` | `smoke_03` 23 | ✅. Each portal domain also needs the operator to add it at the hosting provider for its certificate (SETUP §9.7). Client reports are email, not PDF |
| **No voice notes or meeting booking** (items 24–26) | Booking link variable plus a Calendly / Cal.com webhook that marks "Meeting booked" and ends the sequence; "Send booking link" in the reply box; call-task step with outcomes; voice-note step with a recorder, one real recording per step and sender; find-email step with the workspace's own provider keys | `outreach_record_booking`, `outreach-booking-webhook`; `Compose`; `call_task`; `VoiceClipRecorder`, `outreach_save_voice_clip`; `_shared/outreach/finder.ts` | `smoke_03` 24, 26 | Booking ✅ (the customer pastes one URL into their calendar tool). Call task ✅. Voice note ✅ in code, not yet sent on a live account. Find-email ✅ with the customer's own provider key. **Follow step ❌:** Unipile has no follow endpoint (checked 20 Sep 2026), so the step skips with `unsupported_follow` |

### Built on 20 Sep 2026 and not yet proven

Everything below is in the repo. None of it has been deployed and run against a real LinkedIn account, LLM key or CRM account. Do not describe these as available to customers until someone has.

| Item | What has to happen first |
|---|---|
| Enrichment (13) | Deploy `outreach-worker-tick` and `outreach-worker-enrich`. Check on one sender that stored profiles have filled sections, that a throttled (all-empty) answer backs the sender off, and that `post_fetch` budget is being spent (query in SETUP §9.9) |
| Lead sources (18) | Run each new import kind once on a live sender: post engagement, Sales Navigator saved search and lead list, people inside companies. They depend on Unipile endpoints added in `unipile_sources.ts` |
| AI variables and AI routing (14, 15) | Deploy `outreach-ai-variables` and `outreach-workspace-secrets`. Generate a batch, approve it, and send one message that contains the approved line. Try one workspace key per provider |
| Email depth (20) | Send through a rotated mailbox, click an unsubscribe link end to end (the page needs a hosting decision, SETUP §9.4), confirm the BCC copy arrives |
| Voice note (25) | The plan asked to confirm first that Unipile accepts a voice attachment on our plan. The code uses Unipile's `voice_message` field. Not confirmed on a live account |
| CRM sync (22) | Create the OAuth apps, connect one test account per CRM, watch the sync log |
| Follow step (24) | Cannot work today: Unipile exposes no follow action. The step stays in the builder and skips itself |
| Connector and API | Deploy `outreach-mcp` and `outreach-api`, then run `./scripts/outreach-parity-test.sh` without `--rpc-only` |

---

## Part 1: Features users love in other tools that we have

| Loved feature | Loved in | What we have | Status |
|---|---|---|---|
| **Multi-sender rotation** | HeyReach (core appeal), GetSales | Many LinkedIn accounts and mailboxes per workspace. Each sequence has a sender pool with round-robin, least-loaded, fixed, **fresh-sender** or **same-sender-as-before** assignment, plus "rotate sender" and "change sender" steps. A lead can only be in one live sequence per sender. Adding or removing a sender offers a safe rebalance of untouched leads | ✅ |
| **Unified inbox** | HeyReach Unibox, GetSales, Dripify | LinkedIn and email threads from every sender in one inbox. Filters for sender, channel, intent, client, **sequence**, unread, "Mine" and archived. Each bubble shows the sequence, step and sender that produced it. Assign to a teammate, archive, mark read/unread, attachments, j/k/e/u shortcuts. You can edit or delete a sent LinkedIn message within 60 min | ✅ |
| **LinkedIn + email in one sequence** | GetSales, Expandi | An email step lives in the same flow as LinkedIn steps, with "bounced" and "no email" branches, open/click tracking and threaded follow-ups. Gmail, Outlook and any IMAP mailbox connect through hosted sign-in | ✅ (email depth: see Part 4 #9) |
| **Flexible branching builder** | GetSales, Expandi, Dripify (visual) | Drag-and-drop canvas with 32 step types. Branch on replied, accepted, connection degree, bounced, has email, has phone, open profile, Premium sender, tag, stage, company, title, headline, location, any custom field, call outcome, and enrichment fields (time in role, past company, skill, posted recently, followers, language). A/B split and AI routing steps. Wait-for-accept has its own timeout branch (default 14 days) | ✅ |
| **Account safety** | All four | Daily caps take the lowest of three limits (platform ceiling, warm-up level, manual cap) and are then scaled by account health. Warm-up levels 0–5 (invites from 4 to 45 a day). Accounts with fewer than 150 connections are held at level 0 for 28 days. Per-sender working hours and timezone, human-like random timing, a proxy per sender, stale invites withdrawn automatically after 21 days. New: an InMail speed guard (at most about 50% above last week's daily average) inside the budget | ✅ |
| **Cloud-based, runs 24/7** | Expandi, Dripify | Everything runs server-side on a schedule. The Chrome extension only keeps the LinkedIn session fresh; it doesn't run the campaign | ✅ |
| **Sales Navigator import** | Expandi, Dripify | Import from LinkedIn, Sales Navigator or Recruiter search URLs (up to 1,000/2,500), Sales Navigator saved searches and lead lists, CSV with column mapping or update-only mode, your existing connections, your existing conversations, and people who engaged with a post | ✅ (the new sources are not yet run against a live account) |
| **Wide range of LinkedIn actions** | Expandi, Dripify | Profile visit, like latest post, comment, endorse skills (1–5), invite with note, message, InMail (Classic/Sales Navigator/Recruiter), withdraw invite. While waiting for an invite to be accepted, the sequence can do background visits or likes. Any step can be switched to a manual task. Call-task step with outcomes | ✅ (voice-note step: in code, not yet sent on a live account. Follow step: ❌, Unipile has no follow action) |
| **Built-in light CRM** | GetSales | Pipeline stages, tags, lists, custom fields, per-lead timeline, tasks, and bulk changes of up to 10k leads at a time. Sequences can set tags, lists and stages as steps. Stages now carry a meaning, and an interested reply or a booked meeting moves the stage on its own | ✅ (no notes, no companies object) |
| **Team workspaces** | Expandi, GetSales | Roles: owner, manager, member and client viewer, plus a separate "can reply" permission. Invites go out by email | ✅ |
| **Time savings / automated follow-ups** | All four | Every inbound reply is classified by AI, and "interested" or "question" replies automatically create a follow-up task due in 4 hours. Claude can triage every pending reply and draft answers through the connector | ✅ |
| **Analytics / A/B testing** | GetSales, Dripify, Expandi | Reports page (overview, funnel, replies by intent, sequences, senders, clients, cost), per-step and per-variant counts, A/B results with a confidence label, CSV export on every table | ✅ |
| **Integrations** | HeyReach, GetSales, Expandi | Signed outbound webhooks (retries, auto-disable, replay), "call webhook" and "call API" steps, a Claude connector, and a public REST API with keys, an OpenAPI spec and recipes for Zapier, Make, n8n and Clay | ✅ for the API and webhooks. Native HubSpot / Pipedrive / Salesforce: ✅ built, needs configuration (one OAuth app per CRM; not yet connected to a real account) |
| **Agency / client workspaces** | HeyReach, GetSales | Clients are optional partitions. A client viewer sees only their own client page, with stats, inbox and replies. Blacklists can be scoped to one client. White-label: branding, custom portal domain, branded emails and client reports | ✅ (each portal domain needs a manual step at the hosting provider) |
| **Rich personalization** | Expandi | Variables with fallbacks (`{{first_name\|there}}`), custom and sender fields, spintax, conditional text, and a live preview on a real lead that matches what is sent. An AI copy brief writes a draft that a person approves before it sends. Per-lead AI variables with a bulk review table, and enrichment variables | ◐ No dynamic images or GIFs (deferred). AI and enrichment variables are not yet run on live leads |
| **Waterfall email enrichment** | GetSales | A find-email step with found / not-found branches exists in the builder and the database, with bring-your-own provider keys. GetSales runs this across 20 providers, with verification across 10 | ◐ Not a waterfall: one or two providers, with the workspace's own keys, tried in order. We will not resell data. The Clay recipe in `docs/outreach/recipes/clay.md` is the alternative |

---

## Part 2: Complaints from user reviews that we have solved

### Solved

| Their complaint | Whose users say it | How we solve it |
|---|---|---|
| **LinkedIn only; needs Smartlead/Zapier for email** | HeyReach | Email is a native channel in the same sequence and the same inbox |
| **Email is Gmail-only** | Dripify | Gmail, Outlook and IMAP |
| **No combined LinkedIn + email inbox** | Dripify | One inbox for both channels, with a channel icon on every thread |
| **No shared inbox; teammates can't reply for each other** | Expandi | Threads can be assigned to teammates, there's a "Mine" filter, and a "can reply" permission per member |
| **No multi-account view; agencies switch accounts by hand** | Dripify, Expandi | All senders in one workspace, each with a sender badge on its threads, and optional client partitions |
| **Session drops; accounts have to be reconnected by hand; one user was down for a month** | HeyReach | LinkedIn status events flip the sender's status as soon as the session breaks. Cookie-mode senders reconnect themselves (hourly, up to 4 tries) using fresh cookies from the Chrome extension, which syncs every 3 hours. Password-mode senders get a hosted reconnect link with reminders. Broken senders show on the dashboard's "attention" list and fire a `sender.disconnected` webhook. Leads that failed only because the sender was disconnected are retried automatically on reconnect |
| **Safe volume is far below the advertised 75+ a day** | Dripify | We don't advertise volume that isn't safe. New accounts start at 4 invites a day and step up only after 14 days of good health. Ceilings are 80 invites/day and 150/week, and free LinkedIn accounts are capped at level 1 |
| **Can't see how campaign limits add up against account limits** | Expandi | The dashboard shows each sender's usage today and why it's throttled. "Why isn't this sending?" on the sequence and the sender page explains exactly which cap, schedule or health rule is blocking. The sender page shows headroom and an invites-versus-cap chart |
| **Easy to produce spammy outreach** | HeyReach | Caps are database rules, so neither users, the AI agent nor an API key can raise them. An AI check reviews a sequence before it goes live. Suppression covers domain, profile, email, company, do-not-contact and unsubscribe. Sequences stop on reply by default |
| **Shallow sequence logic: only accepted / not-accepted, no sub-sequences** | HeyReach | Branch on 25+ conditions, and a "send to sequence" step hands a lead to another sequence |
| **No tagging; no bulk save; messy lead management** | Dripify | Tags, lists, stages, custom fields and bulk operations |
| **Existing LinkedIn connections and messages must be synced by hand** | GetSales | Connecting a sender pulls in its recent chats (150 chats, 30 messages each). Existing connections and existing conversations can be imported as leads. Accepted invites are detected by webhook and by polling. *GetSales shipped "My Network" and "My Conversations" imports in April 2026, so this is parity, not an advantage* |
| **Hard to add steps to a sequence that has already run** | GetSales | Running leads follow the latest published flow unless they were pinned, so a step added later reaches everyone who hasn't passed that point yet |
| **Duplicate messages or tasks after updates** | GetSales | Every action has a unique idempotency key, a sender claims one action at a time under a database lock, stuck reservations are cleared every 5 min, and inbound messages are de-duplicated by message ID |
| **Weak AI assistant / no AI reply handling** | GetSales, HeyReach | AI classifies every reply (interested, question, not now, not interested, out of office, wrong person, unclear), and you can override it. An out-of-office reply no longer ends the sequence. AI drafts copy and replies for a person to approve, and AI reviews a sequence before it goes live. Claude can run the whole reply triage through the connector |
| **Exports locked on lower plans / need CSV to analyse** | Dripify, Expandi | CSV export of leads, messages, actions and audit log, and of every table on the reports page, not gated by plan |
| **7-day trial, card required** | Expandi | 14-day trial with up to 3 senders and no card (see billing caveat below) |
| **Can't edit live campaigns; delete and rebuild** *(moved from "partly")* | Dripify (major), all partly | Drafts, a publish dialog that shows who a change affects, "new leads only" version pinning, a versions page showing how many leads run on each version, and a UI for already-queued text and timing. ✅ Proof: `smoke_02` 5, 6a–6d, 7. GetSales has version history and a skip-or-cancel prompt, but no pinning |
| **Campaigns stall or won't start; unclear why** *(moved)* | HeyReach, Expandi | Stall and running-dry alerts, once per occurrence, on the dashboard, as a badge, by webhook, and by email once Resend is configured. ✅ Proof: `smoke_02` 3a–3c. GetSales publishes an 8-step manual checklist instead |
| **Lost work; auto-save fails** *(moved)* | Expandi, HeyReach | Draft auto-save a couple of seconds after each change, a local copy when offline, the unsaved-changes guard as a last resort. ✅ Proof: `smoke_02` 5 |
| **Inbox confusion: which sender or step triggered a reply** *(moved)* | GetSales, Dripify | Under every automated bubble: sequence, step, variant, sender. On every inbound message: the step it answers, with a link. Inbox filter by sequence. ✅ Proof: `smoke_02` 4a |
| **No positive/negative reply tracking; no sentiment** *(moved)* | GetSales, HeyReach | Replies tab with the intent breakdown over time and by sequence, step, sender and variant, plus positive and negative reply rate. A number opens exactly those threads. ✅ Proof: `smoke_02` 10b. GetSales has a "Replied Positive" pipeline stage but no intent report |
| **AI connector (MCP) numbers don't match the dashboard** *(moved)* | HeyReach | One SQL definition of every metric, read by the dashboard, the reports page, the connector and the API. ✅ Proof: `smoke_02` 2a–2e and `scripts/outreach-parity-test.sh`. The connector half of that script passes only after the new connector is deployed |
| **Per-seat pricing hurts teams; can't reduce seats and keep being billed** | Dripify, HeyReach, Expandi, GetSales | Billing is per *active sender*, set nightly to the number of active senders, so pausing or removing a sender lowers the bill automatically. Owners cancel or change plans themselves in the Stripe portal. Senders resume on their own after a recovered payment (`outreach_resume_after_billing`). **✅ built, needs configuration:** Stripe is not configured, so billing is off. The recovered-payment test in SETUP §9.1 has not been run |

### Partly solved

| Their complaint | Whose users say it | What we do | What's still missing |
|---|---|---|---|
| **Bans despite "safety" claims** | Expandi (major), Dripify, GetSales, HeyReach | Layered caps, warm-up lock for new accounts, health score (below 70 cuts caps to 60%, below 50 pauses 24h), 3 rate-limit errors in an hour pause the sender for 24h, LinkedIn's weekly invite-limit error blocks invites until the date LinkedIn gives, and an InMail speed guard | No tool can guarantee no bans. A proxy is only replaced by hand if it fails (GetSales pings proxies hourly and swaps a broken one automatically). Post fetches are budgeted in the repo, but not in the deployed executor until it is redeployed |
| **Weak personalization; only name variables** | Dripify, HeyReach | Custom fields with fallbacks, sender fields, spintax, conditional text, live preview equal to what is sent, AI-drafted copy with approval | No image, GIF or video personalization. Per-lead AI lines and enrichment variables are built but not yet run on live leads |

---

## Part 3: GetSales weaknesses documented in its own help center that we solve

These come from GetSales' own articles, not from reviews, so they describe how the product behaves today.

### Solved

| What GetSales' help center says | How we handle it |
|---|---|
| **InMail credits run out and the lead fails.** "There is currently no automatic, credit-based rerouting." Failed leads don't retry on their own. A recipient who has switched off InMail looks identical to "out of credits" | The InMail step has a `no_credit` branch, so the lead carries on down another path, such as a connection request. An "open profiles only" option sends free InMails only, and everyone else takes the branch |
| **A logged-out LinkedIn account needs a person.** "For safety, GetSales does not auto log in." The owner opens a cloud browser and logs in again | Cookie-mode senders reconnect on their own, hourly for up to 4 tries, from cookies the Chrome extension refreshes every 3 hours. Password-mode senders get a hosted re-login link. The extension is optional and can be installed without the Chrome Web Store ([guide](docs/outreach/EXTENSION-UNPACKED-INSTALL.md)) |
| **Replies don't arrive while a sender is outside working hours.** "Messages and emails only sync when the sender profile is active." InMails sync about every 2 hours, SMTP email every 20 minutes | Inbound LinkedIn messages and email arrive by webhook at any hour. The schedule only limits what we *send*. (Not yet verified for Sales Navigator InMail threads) |
| **The blocklist is destructive.** Adding someone to a Stoplist "removes the contact from GetSales, including the conversation history". Keeping the history needs a workaround with a tag and an exclusion filter on every automation | Suppression never deletes anything, at any scope (workspace, client, sequence). Do-not-contact, unsubscribe, and domain, profile, email or company entries exit the lead's sequences and keep the lead, the timeline and the chat. Proof: `smoke_02` 17, `smoke_03` 20c |
| **Safety limits can be switched off.** With Smart Limits off, "the Daily limit column becomes editable and you're responsible for every number". Their suggested targets reach 60–100 invites a day | Nobody can raise a cap past the platform ceiling: not an owner, not the AI agent, not an API key. It is a database constraint. The trade-off is that power users can't push harder even if they want to |
| **A cancelled contact can never re-enter that automation.** Their workaround is to duplicate the whole automation | A lead can be enrolled again after exiting. The only rule is one live enrolment per lead and sender. A lead who replied in the last 90 days is held back unless the user ticks "include" |
| **No conversation export.** "GetSales doesn't offer a built-in conversation export feature"; they point to the API or webhooks | Messages export to CSV, along with leads, actions and the audit log |
| **AI text sends without a person seeing it.** AI templates and AI variables generate the message when the step runs. In February 2026 they withdrew AI comment templates because "output quality wasn't consistent enough" | AI writes a draft, a person approves it, then it sends. For AI variables the rule is in the database: the render context only ever contains approved text (`smoke_03` 14b). Bulk approval keeps it practical |
| **The AI connector can take large or irreversible actions.** Their connector can permanently delete contacts, send one-off messages, stop all flows and change billing. Their docs advise asking Claude for a preview first, and describe no enforced confirmation step | Anything that sends, enrols, suppresses, publishes or touches many records returns a summary of the effect and needs a confirmation token from an explicit yes. Caps still apply to the agent |
| **A reply leaves the lead stuck.** A reply pauses the lead, who then stays "In Progress until you manually unpause or cancel them". Their docs warn that these paused leads also skew how new leads are shared between senders *(moved from "partly")* | A reply exits the lead **across all senders and channels**, tags the intent, and creates a follow-up task for "interested" and "question" replies. An out-of-office reply resumes the sequence on its own after 7 days or the stated return date. Teams that prefer a pause get a hold-for-review mode in which the held lead shows on the attention list and is exited after 30 days, so nobody is stuck. ✅ Proof: `smoke_01` A1–E2 |
| **Adding a sender to a running campaign means restarting leads by hand**, with a documented risk of re-sending messages ("Restart from top"), as recorded in [outreach-product-plan.md](outreach-product-plan.md) items 8 and 9 *(new row)* | Changing the pool offers to move only leads with nothing sent and no invite pending. There is no "restart from top" anywhere in the product. ✅ Proof: `smoke_02` 9 |

### Solved in the code, gated on Stripe

| What GetSales' help center says | What we do | State |
|---|---|---|
| **Email and AI cost extra.** The entry plan (Send) has no email sequencer. AI, enrichment and email finding are metered by monthly credits, and steps fail when credits run out | Email, AI classification and AI drafting are part of the product, not plan-gated. An AI variable always has a fallback, so a missing AI line never fails a lead. A workspace can bring its own LLM key. Draft policy: [docs/outreach/POLICIES.md](docs/outreach/POLICIES.md) | ✅ built, needs configuration. Billing isn't live, so the plan structure is untested. Prices are not set in this repo. Bring-your-own key is built (`outreach-workspace-secrets`) and not yet tried with a real key |
| **Seats and renewals need manual work.** Bought seats must be allocated to each team by hand (they have a whole article on this). A failed renewal stops every sender and pauses every automation, and each one must be restarted by hand | Billing follows the number of active senders automatically. Past-due pauses senders and doesn't delete them. When the payment recovers, the Stripe webhook calls `outreach_resume_after_billing`, which restores the plan and resumes every sender paused for billing. Sequences were never paused, so there is nothing to restart | ✅ built, needs configuration (Stripe). The recovered-payment test (SETUP §9.1 step 8) has not been run |

---

## Part 4: Where GetSales is ahead of us

Found in the GetSales help center. Ranked by how much it matters to a buyer comparing the two. The right-hand column is our state on 20 Sep 2026.

| # | What GetSales has | Where we stand |
|---|---|---|
| 1 | **A reply stops the lead everywhere.** "All scheduled messages for that lead are paused across all sender profiles" | ✅ Matched, and the lead is not left stuck afterwards. `outreach_trg_reply_exit`; `smoke_01` |
| 2 | **Automatic profile enrichment.** Every imported lead is enriched from a shared database (data under 3 months old is reused instantly) or fresh from "LinkedIn and other open sources" in hours to 2 days. It runs on their servers, not the customer's LinkedIn account. A re-enrich step costs 1 credit and can skip recently enriched leads. About, experience, education, skills and posts are all stored and filterable | ✅ in code, not yet run on a live account. Leads in a sequence are enriched from the fetch the sequence already makes, at no extra profile views. Other leads use leftover views only. `smoke_03` 13a–13e. We have no shared database, so enrichment always spends the customer's own allowance and will be slower than theirs for a fresh import |
| 3 | **AI personalization at volume.** AI Templates (an AI block inside a message, with a fallback), AI Variables (a saved prompt per variable, with a fallback), and bring-your-own LLM key across five providers | ✅ in code, not yet run on live leads. AI variables with fallbacks, generated ahead of time, approved in bulk before anything can send (`smoke_03` 14a–14c). Three providers (Gemini, Anthropic, OpenAI), not five |
| 4 | **Recovering failed leads.** Every step shows Failed, Skipped and Cancelled counts with the reason. Bulk actions: retry on this step, skip, cancel, restart from the top (up to 500 at once). Their connector can diagnose and bulk-retry failures | ✅ Matched without "restart from the top", which re-sends messages. Retry, skip, exit, up to 500, plus automatic retry when a sender reconnects. `outreach_enrollment_recover`; `smoke_02` 8a–8c |
| 5 | **More ways to find leads.** People who reacted to, commented on or reposted a given LinkedIn post; repeating imports (daily to monthly); Sales Navigator saved searches, lead lists and account lists; "Find contacts from accounts" (companies first, then people inside them); conversations as leads; a Chrome extension that saves profiles; a CSV mode that updates existing leads | ✅ Post engagement, repeating imports, Sales Navigator saved searches and lead lists, people inside companies, conversations as leads, CSV update mode. Not built: Sales Navigator account lists, a profile-saving extension. Not yet run against a live account |
| 6 | **Leads enrol themselves.** A segment "auto-filter" routes any lead that joins a list, or matches a filter, into the automation | ✅ Auto-enrol rules with the same checks as a manual enrolment, a daily cap and a visible log. `smoke_03` 18a |
| 7 | **Sender assignment that knows history.** Four modes, including "never contacted by this sender before" and "the same sender who spoke to them last" | ✅ Five modes. `smoke_02` 19 |
| 8 | **Public API and keys.** 130+ endpoints, API keys per workspace, about 10 webhook events including sender errors | ✅ A smaller API (leads, enrollments, sequences, inbox, senders, reports, webhooks) over the same functions as the UI, keys with a role and a client scope, idempotency keys, and webhook replay, which GetSales says it cannot do. `smoke_03` 21a–21c. Must be deployed before it is offered |
| 9 | **Deeper email.** Several mailboxes per sender (3 to 20) with even rotation and the same mailbox kept for a known contact; a separate email schedule; custom tracking domain; unsubscribe-link and signature variables; BCC to a CRM; per-mailbox delay | ✅ in code, not yet run on a live mailbox. Rotation with a sticky mailbox, unsubscribe link with a one-click header, signature, BCC, a schedule per mailbox (`smoke_03` 20a–20c). Custom tracking domain: ✅ built, needs configuration, because Unipile approves each domain by hand. No per-mailbox delay |
| 10 | **AI routing step.** "AI Condition Rules" sorts leads into branches written in plain language, and saves the reason for each decision. It only sees 7 profile fields (no posts, no custom fields) | ✅ in code, not yet run on live leads. Ours sees posts, past roles, skills and custom fields, stores the reason and the facts, and has a "test on 20 leads" run (`smoke_03` 15) |
| 11 | **Sender analytics.** Six-axis health radar with written recommendations, a five-tier warm-up ladder with progress to the next tier, "Safety Buffer", a count of LinkedIn limit hits, acceptance-rate trend, network growth, and a benchmark of your limits against the market median | ✅ Written recommendations by rule, warm-up card with the unlock date, headroom, limit hits, acceptance trend, network growth, invites-versus-cap chart. No market benchmark |
| 12 | **White-label.** An add-on from 10 seats: custom domain, custom menu links, tracking domain | ✅ Branding, custom portal domain, help and docs links, branded emails and client reports (`smoke_03` 23). Each portal domain needs a manual step at the hosting provider, and each tracking domain needs Unipile's approval |
| 13 | **Find-email step.** Waterfall across 20 providers with optional verification, and found / not-found branches | ◐ The step exists with found / not-found branches (`smoke_03` 26), but it is not a 20-provider waterfall: the workspace brings its own key for one or two providers plus a verifier. We will not resell data |
| 14 | **A/B step with weights.** Listed in their connector reference. Their own FAQ says there is no A/B report, and results must be compared by hand | ✅ Ahead: variants and a split step **with** a results report judged on positive replies, a confidence label, and "promote winner". `smoke_02` V1, 11 |
| 15 | **Proxy care.** Proxies are pinged every 60 minutes and replaced automatically when they break | ◐ Replaced by hand. Not in the plan |
| 16 | **Sender error emails.** Per-sender recipient list for logout, proxy and email errors | ✅ built, needs configuration. Per-sender alert recipients (`alert_emails`, up to 10) are used by every sender notice and by running-dry alerts. Resend isn't configured |
| 17 | **CRM extras.** Notes on contacts, a companies object with deals, stages that move on their own ("Replied", "Replied Positive"), and a dashboard filter by automation | ◐ Stages now move on their own (interested reply, booked meeting) and reports filter by sequence. No notes, no companies object (plan item 27, later) |

**Also worth knowing (different approach, not a gap):** GetSales runs each LinkedIn account inside its own cloud browser (GoLogin) with "single session protection", and lets the owner open that same session to use LinkedIn by hand. We connect through Unipile's hosted sign-in with a pinned proxy and have no browser to open. Their approach costs them cloud-browser limits per plan and "black screen" support articles. Ours is simpler, but offers no way to use LinkedIn inside the protected session.

---

## Part 5: Review complaints that apply to us too

Ranked by how often they come up in the reviews and how much damage they cause.

### Closed on 20 Sep 2026

| Gap | Competitors' users who raise it | Where we stand |
|---|---|---|
| **An email reply doesn't pause the LinkedIn steps** | Expandi | ✅ A reply by email, or to sender A, exits the lead's sequences everywhere and cancels queued steps on every sender. `smoke_01` A1–A3 |
| **No real A/B testing** | Dripify, HeyReach, GetSales | ✅ Variants, split step and a results report. `smoke_02` V1, 11 |
| **No public API** | Dripify | ✅ REST API with keys, an OpenAPI spec and recipes. `smoke_03` 21a–21c. Deploy `outreach-api` before offering it |
| **Funnel / ROI reporting** | All four | ✅ Reports page with a cohort funnel and a cost tab. `smoke_02` 10c, 10d |
| **No campaign-level blacklist** | Expandi | ✅ Workspace, client and sequence scope, companies included. `smoke_02` 17 |

### Partly closed

| Gap | Competitors' users who raise it | Where we stand |
|---|---|---|
| **Weak or no native CRM integrations** | All four (Salesforce especially) | ✅ built, needs configuration. Native HubSpot, Pipedrive and Salesforce sync exists in code; each needs an OAuth app, and none has been connected to a real account yet. The API, webhooks and recipes already cover most of what reviewers mean by "integrations". GetSales' plan page says "All CRMs with API", which means its API-call step |
| **No voice notes, video messages or meeting booking** | GetSales | ◐ Meeting booking ✅ (booking link plus a Calendly / Cal.com webhook, `smoke_03` 24) and call-task step ✅. The voice-note step is in code and has not been sent on a live account. The follow step cannot work: Unipile has no follow action. Video messages are out of scope; GetSales confirms it can't send native video either |
| **No white-label** | HeyReach (agency) | ✅ Branding, custom portal domain, branded emails and client reports. `smoke_03` 23. Each domain needs a manual step at the hosting provider |
| **No email warm-up** | GetSales, Expandi, HeyReach | ◐ Email steps now rotate across a sender's mailboxes. Mailboxes get a slow cap ramp (20 to 150 a day). A warm-up network is deliberately out of scope (plan §14); we recommend a dedicated tool |

### Still open

| Gap | Competitors' users who raise it | Where we stand |
|---|---|---|
| **Dynamic images, GIFs and video personalization** | Expandi | ❌ Deferred (plan item 27) |
| **Learning curve** | All four | Not measured. Helpful: sequence templates, AI pre-launch check, a completion-date estimate, "Why isn't this sending?", and Claude can build a sequence from plain language. The product has more screens than it had on 19 Sep 2026, so this risk went up, not down |

**Not a product problem, so not listed as solved:** declining support, refund policy, surprise renewals and billing errors. These depend on how we run the business, not on the code. GetSales' own policy page confirms "refunds are not provided". A draft policy for the owner to approve is in [docs/outreach/POLICIES.md](docs/outreach/POLICIES.md): cancel any time in the portal, prorated refund on request, no silent annual renewals. It is a draft, and prices are not set in this repo.

---

## The category-wide gaps from the review analysis

The review analysis ends with five gaps that no tool fills well. Here is where we stand on each, with GetSales checked against its own docs:

| Gap no tool fills well | Us | GetSales, per its help center |
|---|---|---|
| Reply-sentiment and funnel reporting | ✅ Intent breakdown with positive and negative reply rate, cohort funnel to meeting and won, cost per reply. `smoke_02` 10b–10d | ◐ "Replied Positive" stage and funnel reports through the API and connector. No intent breakdown |
| Editing sequences safely while they run | ✅ Drafts, publish impact, version pinning, queued-edit UI, no "restart from top". `smoke_02` 5–7 | ◐ Version history and a skip-or-cancel prompt. No pinning. "Restart from top" re-sends every message |
| Transparent, fair team pricing with self-serve seat downgrades | ✅ built, needs configuration. Billing per active sender that adjusts and resumes on its own; Stripe is not configured and prices are not set | ◐ Public per-seat prices ($69 for one seat down to $16 at 100) and self-serve downgrade. No refunds, and seats are allocated to teams by hand |
| Reliable session handling (no silent disconnects) | ✅ Status events, automatic cookie reconnect, reconnect links, attention list, automatic retry of leads that failed during the disconnect | ◐ Status pill, email and webhook alerts, and a re-login link. No automatic re-login |
| One LinkedIn + email inbox showing exactly which sender and step triggered each reply | ✅ Sequence, step, variant and sender on every bubble; filter by sequence. `smoke_02` 4a | ◐ Sender yes. Reviews say the step is unclear |

Four of the five are closed in the code, and the fifth is closed once Stripe is configured. Per GetSales' own help center, none of the five is closed there. This is a claim about features that exist, not about results: see the caveats.

---

## Risks the GetSales help center revealed

| Risk | Evidence | What it means for us |
|---|---|---|
| **LinkedIn acts against extensions and vendors** | In August 2026 GetSales' Chrome extension left the Chrome Web Store because "LinkedIn requested that we remove the extension". Users now install it unpacked in developer mode. In March 2026 LinkedIn removed HeyReach's company page | Our automatic reconnect depends on a Chrome extension. It stays optional, and the re-login link is a complete fallback. The unpacked install guide for non-technical senders is written: [docs/outreach/EXTENSION-UNPACKED-INSTALL.md](docs/outreach/EXTENSION-UNPACKED-INSTALL.md) |
| **LinkedIn changes break imports and syncing often** | Their release notes list repeated fixes for search imports, profile formats, InMail sync and limit detection | We inherit the same exposure through Unipile. Failed imports now raise an alert on the dashboard. The five new lead sources have not been run against a live account yet |
| **InMail has a hidden speed limit** | They document LinkedIn blocking InMails after a sender went from about 3 a day to about 16 a day, with 31 credits still unused | ✅ Closed: the InMail guard caps the daily InMail budget at about 50% above last week's daily average, never below 3 (`outreach_inmail_guard`; `smoke_03` B2) |
| **Custom tracking domains depend on a vendor's support desk** | Unipile authorises each domain by hand and states no limit or turnaround time | The feature has a visible "awaiting approval" state and falls back to the default domain. Ask Unipile for limits and turnaround before promising a customer a date (SETUP §9.8) |

---

## Caveats before using this externally

- **Billing is off.** Stripe isn't configured, so the trial limit, per-sender billing, the self-serve portal and automatic resume after a recovered payment are built but not running, and the recovered-payment test has not been run.
- **Notification email is off.** Resend isn't configured, so reconnect links, stall and running-dry alerts, the weekly sender report, digests and client reports are skipped by email. Alerts still show in the app and fire webhooks, and reconnect links can be copied from the sender page. Alerts that open while email is off are not emailed later.
- **Two known defects in the reply count (found 20 Sep 2026, not fixed).** (1) Every manual reply a teammate sends from the inbox is counted as one inbound "reply", because the action type `reply` and the metric `reply` share a name in `outreach__action_facts_live`. (2) A lead's answer to a teammate's manual message is flagged as a first reply. Both inflate `replies` and the reply rate on every surface equally, so the parity guarantee holds while the number itself is too high. Reproduced on the live database; the fixes are described in [docs/outreach/SQL-REFERENCE.md](docs/outreach/SQL-REFERENCE.md) §10. Do not quote reply rates externally until this is fixed.
- **The LinkedIn-, LLM- and CRM-facing code written on 20 Sep 2026 is unproven** (see "Built on 20 Sep 2026 and not yet proven"). It type-checks and its database rules are tested. It has not run against a real account.
- **Deploying matters.** The database is live. The new connector, the API and the changed workers take effect only after `./scripts/outreach-deploy-functions.sh`. Until `outreach-worker-tick` is redeployed, the executor runs the previous code.
- **One LinkedIn call is not budgeted until the executor is redeployed.** Fetching a lead's recent posts (like steps, comment steps, AI drafts, enrichment) reserves the new `post_fetch` budget in the repo's code. The deployed executor is still the old one, which fetches posts without a budget. Unipile recommends at most 100 post retrievals a day per account. Verify after deploying with the query in SETUP §9.9.
- **AI runs on Google Gemini** (`gemini-3-flash-preview` by default), not Claude as the PRD specifies. Bring-your-own-key is designed for Gemini, Anthropic and OpenAI.
- **The `ai_auto_send` setting was removed.** It never did anything and it contradicted the approval rule.
- **The follow step does not work.** Unipile exposes no follow action, so the step skips itself. The voice-note step relies on Unipile's `voice_message` field and has not been confirmed on our plan.
- Status is verified from code and from SQL smoke tests, not from live usage. "Solved" means the feature exists and is wired up. It does not mean we have measured results, such as fewer bans, against competitors.
- **GetSales is described from its help center, not from using the product.** A help center shows what is documented. Features may exist that aren't documented, and documented features may work worse than described. The reviews are the check on that. The other three tools were not examined this closely, so don't read this as "GetSales is the strongest competitor". It is only the best documented.
