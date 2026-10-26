# Leads: outbound vs inbound leads, status, connections per account (migration 094)

In the app the tabs read **Outbound · Inbound · All** (renamed 2026-10-26 from Prospects · From inbox · All). Tab keys, API/MCP `tab` values (`prospects` | `inbox` | `all`) and `prospect_since` are unchanged; "Add to prospects" is "Add to outbound".

Reader: an engineer touching the leads page, the inbound handler or the connector. Built 26 Oct 2026 from
`leads-relationships-PRD.md`. Live since 26 Oct 2026 (migration 094 applied, ten edge functions deployed).

## What exists

| Piece | Where |
|---|---|
| Columns `origin`, `kind`, `prospect_since`, `hidden_at`, `hidden_reason`, `enrich_wait_reason` on `outreach_leads`; `counterpart_kind` on `outreach_chats`; `relation_source`, `connected_at`, `relation_checked_at`, `we_follow`, `follows_us` on `outreach_lead_sender_state`; `is_meeting` on `outreach_stages` | `migrations/outreach/094_leads_relationships.sql` §1 |
| `outreach_lead_summary` (one row per lead), `outreach_lead_summary_queue`, `ops.inbound_kind_rules` | 094 §2 |
| Classification `outreach_inbound_kind()` (service) | 094 §3; called from `_shared/outreach/inbound.ts` (`inboundKind`) before a lead is created |
| Origin / prospect triggers (`outreach_trg_lead_origin`, `outreach_trg_enrollment_prospect`), relation-source trigger (`outreach_trg_lss_relation_source`), summary enqueue triggers | 094 §5–6 |
| `outreach_lead_summary_refresh / _process / _reconcile` (service) | 094 §7; worker `outreach-worker-lead-summary` (dispatcher row `lead-summary`, 30 s; pg_cron `outreach-lead-summary-reconcile` 03:30 UTC) |
| Reads `outreach_leads_totals`, `outreach_leads_by_account`, `outreach_lead_relationships`, `outreach_leads_list`; writes `outreach_lead_promote`, `outreach_lead_hide` | 094 §8; `lib/outreach/leadsRelationships.ts`, `components/outreach/leads/relationships.tsx` |
| Enrichment order + wait reasons (`outreach_enrich_next`, `outreach_enrich_wait_reason_refresh`) | 094 §9; `outreach-worker-enrich` calls the refresh after each run |
| Setting `create_leads_from_inbound`: `people_only` (default) · `all` · `none` | 094 §10; Settings → Workspace → Behaviour; `inboundLeadMode()` on both sides accepts the old boolean |
| Smoke test (89 assertions) | `migrations/outreach/tests/smoke_27_leads_relationships.sql` |

## Rules the database enforces

* **Origin never changes.** `outreach_trg_lead_origin` derives it from the creation path's `source` (`outreach__origin_of`): csv / relations / sales-nav / post engagement → `import`, `search_url` → `search`, api / mcp / connector / crm → `api`, manual / inbox → `manual`, inbound / inbound_email → `inbound`.
* **Prospect flag.** Non-inbound leads are prospects from creation. An inbound contact becomes one when enrolled (trigger on `outreach_enrollments`), put on a list or given a stage (trigger on `outreach_leads`), or promoted (`outreach_lead_promote`). Tags, notes and replies never promote (D8).
* **Relation source.** Every path that writes `relation = 'first'` goes through `outreach_trg_lss_relation_source`: an invite from that sender on record (`invite_sent_at` ≤ connection + 1 min) → `our_invite`; `pending_in → first` → `their_invite`; otherwise `pre_existing`. A caller may set `relation_source` explicitly (the Instagram poll). `connected_at` is kept when the connection later disappears. Connections from before 094 with no invite on record are `unknown`.
* **Status ladder** (`outreach_lead_summary_refresh`): 0 not contacted · 1 invited · 2 connected · 3 messaged · 4 replied · 5 interested · 6 meeting. Touches = sent actions (invite / follow; message / new_chat / inmail / email / reply / ai_reply, not prefetch or subtask) + our own messages (`outreach__msg_kind = 'ours'`, not the invite note) + `invite_sent_at` on LinkedIn / Instagram. Replied = a `person` message after the first touch; Interested = intent `interested` or `question`; Meeting = a `meeting` milestone or the current stage is a meeting stage. Overrides: `do_not_contact` (suppressed, blacklist included) · `bounced` (email bounce / WhatsApp number invalid and the ladder is at 0, with the bounced channel's messages left out of the ladder) · `wrote_to_us` (they wrote, no touch from us; a pre-existing connection is not a touch). `status_rank` keeps the ladder step whatever override is shown.
* **Removed accounts** (sender-lifecycle `removed` / `erased`, billing `disconnected`, merged tombstones) stay in the summary arrays; the read functions subtract them unless `include_removed`.

## Deviations from the PRD

* Queue is a table (`outreach_lead_summary_queue`), not pgmq (not installed); the worker is driven by the 084 dispatcher, not its own cron.
* Channels are text (`linkedin | instagram | whatsapp | email`), as `outreach__channel_of()` gives them.
* The leads page keeps its PostgREST list query (`intel.ts leadsQuery`) with `outreach_lead_summary` embedded and ordered by `outreach_lead_summary(last_activity_at)`; the connector, the API and the totals use `outreach_leads_list / _totals / _by_account`. Both sides use the filter vocabulary documented on `outreach__leads_matching`. `connection_sources text[]` on the summary exists for the PostgREST side of the "connection source" filter.
* Sponsored InMails from a person (a recruiter) are `automated`, not `company_page`; only a numeric (organisation) id or `is_organization` makes a company page. `linkedin_offer` chats are automated.
* The inbox has no "Other / updates" view: a fourth Replies chip **Other** lists `counterpart_kind <> 'person'`; the three people chips exclude them. The connector's `inbox_pending` skips them unless `include_automated`.
* Platform admins edit `ops.inbound_kind_rules` in SQL (seeded: `email.epidemicsound.com`, `hellorep.ai`, `flair.ai`, role local parts `hello|team|news|marketing|info`). No admin UI.
* `is_meeting` was added to `outreach_stages` (default from `kind = 'meeting'`); 089 sequence stats read meetings from milestones, which the stage trigger writes, so both agree.
* The public API's `GET /v1/leads` defaults `tab` to `all` (existing integrations keep every lead); the app and the connector default to `prospects`. The legacy exact-match filters (`email`, `public_identifier`, `source`, `updated_since`) still go through `outreach_api_leads`.
* Removed-account names: the Connected via cell shows "Removed account" for ids the senders RLS hides; 092 `sender_labels` was not used so this ships independently of the sender-lifecycle migrations.
* Backfill approximation: an inbound lead that already sat on a list or a stage got `prospect_since = updated_at`.

## Backfill result (live, 26 Oct 2026)

| Workspace | Old "Replied" | Real replies | Hidden junk | Wrote first | Unexplained |
|---|---|---|---|---|---|
| nkjaipur21 | 90 | 28 | 36 | 64 | 0 |

36 leads hidden (30 automated senders, 6 company pages); 736 outbound, 52 inbound.

## Operating notes

* Status for one lead looks wrong → `select outreach_lead_summary_refresh('<lead>')` (returns true when it changed), or enqueue it and let the worker run.
* Drift check → `select outreach_lead_summary_reconcile(7)`; the nightly run logs `{processed, changed, failed, queued}` in the function logs.
* A person caught by the automated rules → Hidden filter → Add to outbound (or Unhide); a rule that is wrong → `ops.inbound_kind_rules.active = false`.
* Enrichment cell says "daily profile views used (X, resets HH:MM)" → the account named is the one whose next schedule window comes first; the row is refreshed after every enrichment run (10 min).
