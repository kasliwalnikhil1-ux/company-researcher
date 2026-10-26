# Sequence stats: contacted · accepted · replied · positive, per channel

Built 26 October 2026 from `sequence-stats-PRD.md`. Everything the Sequences list (`/outreach/sequences`), the sequence page's **Results** tab, Reports → Sequences, the client portal, the connector (`sequences_list`, `sequence_stats`, `report_sequences`, `report_sequence`) and the public API (`GET /reports/sequences`, `GET /sequences/{id}/stats`, `GET /sequences` → `stats`) show comes from two SQL functions over two fact tables. No surface recomputes a number.

## Where things live

| Piece | File |
|---|---|
| Migration (tables, truth, triggers, cache, reconcile, report functions, backfill) | `migrations/outreach/089_sequence_stats.sql` |
| Smoke test (63 assertions: every §9 edge case, same numbers everywhere, cohorts, idempotency, reply credit, NA, reconcile) | `migrations/outreach/tests/smoke_25_sequence_stats.sql` |
| Shapes, period model, exact tooltip wording (§6.3), channel stage lists | `lib/outreach/sequenceStats.ts` (+ `sequenceStats.test.ts`, `npx tsx lib/outreach/sequenceStats.test.ts`) |
| Hooks | `lib/outreach/reports.ts` → `useReportSequences`, `useReportSequence` (range `null` = all time) |
| List | `app/outreach/sequences/page.tsx` |
| Sequence page Analytics tab | `components/outreach/sequences/stats/SequenceAnalytics.tsx` since 26 Oct 2026 (docs/outreach/SEQUENCE-LEADS-ANALYTICS.md); it keeps the 089 per-channel blocks and A/B tests under its own sections (`StatsPeriodPicker`, `ChannelBlocks`, `MetricCell`, `ProgressRing`, `ChannelGlyphs`; `SequenceResults.tsx` was retired with it; `FunnelTiles` lives on in Reports → Sequences) |
| Reports → Sequences | `components/outreach/reports/SequencesTab.tsx`; the step / A/B / exit tables moved to `SequenceStepTables.tsx` (shared with the Results tab) |
| Demo (product tour) | `lib/outreach/backend/demo/reports/stats.ts`, handlers in `demo/rpc/reports.ts` |
| Connector | `outreach-mcp/tools_sequences.ts`, `tools_tasks_reports.ts`; skill text `claude-skill/outreach/metrics.md` ("Sequence results") |
| API | `outreach-api/routes_reports.ts` (`channel`, `status` params), `docs/outreach/openapi.json` (`SequenceStats`, `SequenceStatsRow`, `SequenceChannelBlock`), `docs/outreach/API.md` |
| Digest email | `_shared/outreach/reports_email.ts` (top sequences: live · contacted · replied · reply rate · positive) |

## The data model

`outreach_sequence_lead_facts` (one row per enrolment): `first_attempt_at`, `first_contacted_at` + `first_contact_channel`, `last_touch_at`, `invited_at` + `invite_channel`, `accepted_at`, `invite_closed_at` + `invite_closed_reason` (withdrawn | declined), `replied_at` + `reply_channel` + `reply_message_id`, `auto_replied_at`, `positive_at`, `meeting_at`.
`outreach_sequence_channel_facts` (one row per enrolment and channel): `contacted_at`, `invited_at`, `accepted_at`, `messaged_at`, `seen_at`, `replied_at`, `bounced_at`.
`outreach_sequence_stats_cache` (the all-time block per sequence), `outreach_stats_refresh_queue`, `ops.stats_reconcile_log`, Health check `stats-1`, flag `stats_seen_since`.

**One definition.** `outreach__stats_truth_leads(p_leads uuid[])` and `outreach__stats_truth_channels(p_leads uuid[])` compute the facts of some leads from the source tables: `outreach_actions` (sent touches: LinkedIn invite / message / InMail, Instagram follow / new chat / message, WhatsApp new chat / message, email; failed WhatsApp number checks), `outreach_messages` + `outreach_chats` (human and auto replies via `outreach__msg_kind`, read receipts `read_at`, email bounces), `outreach_lead_sender_state` (acceptances / follow-backs, dropped invitations), `outreach_lead_milestones` (meetings). A lead is always computed whole, across every sequence, because reply credit (§3.4: the latest touch before the message, any sequence or sender), acceptance credit and meeting credit need the lead's whole history.

**Writing.** Triggers on those source tables call `outreach_stats_rebuild_lead(lead)`, which upserts the truth for that lead (only rows that changed) and queues its sequences for a cache refresh: `outreach_actions` (sent touches, withdrawals, failed number checks), `outreach_lead_sender_state` (`invite_accepted_at`, `invite_withdrawn_at`), `outreach_messages` (statement-level: inbound messages, intent / auto-reply / bounce / read-receipt / deletion changes), `outreach_chats.lead_id`, `outreach_lead_milestones` (meeting), `outreach_enrollments` (delete → queue). Trigger bodies swallow their own errors (a stats problem never blocks a send or a webhook). Rebuilding is exact, idempotent and order-independent: replaying a webhook changes nothing.

**Reading.** `outreach__stats_block(sequence, from_ts, to_ts)` = the people-level block for a cohort (null bounds = all time); `outreach__stats_channel_blocks` = per channel; `outreach__sequence_channels` = steps of the head graph + channels seen only in activity (`from_earlier_version`); `outreach__stats_progress` = live progress / ops from enrolments and node stats; `outreach__stats_row` = one list row. `outreach_report_sequences(p_ws, p_client, p_from, p_to, p_channel, p_status)` reads the cache for all time (a sequence sitting in the refresh queue is computed live, so the list is never behind) and the facts for a period. `outreach_report_sequence(p_sequence, p_from, p_to)` keeps the 013 step table / A/B / exits and adds `funnel`, `channels`, `replied_other_channel`, `seen_since`.

**Cache + reconcile.** pg_cron `outreach-stats-refresh` (every minute, SQL only) drains the queue; `outreach-stats-reconcile` (03:15 UTC) recomputes every sequence with activity in the last 7 days, repairs differences, logs them to `ops.stats_reconcile_log` and reports Health check `stats-1` (watch > 0.2 % rows fixed, act ≥ 1 %).

## Deviations from the PRD (and why)

| PRD | Built | Why |
|---|---|---|
| `stats_record(enrollment, channel, event, at, ref)` fills null timestamps per event, called from F2 / F3 / F18 / polls | Triggers on the source tables recompute the lead from the one truth query | One definition instead of two (incremental vs nightly) that could drift; every write path (webhook, sync backfill, note-path acceptance, follower poll, manual overrides) is covered without touching TypeScript; idempotent by construction |
| `pgmq` queue + 30-second cron for the cache | `outreach_stats_refresh_queue` table + one-minute SQL cron, and the list computes a queued sequence live | No pgmq on this project; the 084 rule forbids sub-minute crons; read-through makes the list exact anyway |
| F54 `worker-stats-reconcile` edge function | `outreach_stats_reconcile()` in SQL, scheduled by pg_cron directly | Nothing to do outside the database; no invocation / log cost |
| `messages.seen_at` new column | `messages.read_at` (025, written by the `message_read` webhook since 2026-09-28) | Already stored; `stats_seen_since` = the earliest read receipt |
| `stages.is_meeting` | `stages.kind = 'meeting'` → `outreach_lead_milestones(kind='meeting')` (stage trigger, booking link, CRM, API all write it) | Already exists |
| Channel columns typed `provider_t` | text channel keys `linkedin \| instagram \| whatsapp \| email` (the reports' vocabulary) | Email providers (GMAIL / OUTLOOK / IMAP) are one channel |
| `sender_id` FK with no action | no FK | Facts must survive an erased sender |
| Lead facts only for contacted enrolments | also for an enrolment whose WhatsApp number check failed before any message (`first_attempt_at`, `first_contacted_at` null) | Otherwise "Not on WhatsApp" could never show for a WhatsApp-first sequence; the cohort key is `first_attempt_at`, Contacted still counts touches only |
| Seen empty for history | backfilled from `read_at` (kept since 025); "Seen counted from <date>" shown for earlier periods | More data, same meaning |
| Phase 2 "behind a flag on your own workspace first" | no flag | The web app is deployed by hand after a local check |
| `sequence_channels` as a public function | internal `outreach__sequence_channels`, returned inside both report functions | One fewer RPC surface and demo handler |
| `accepted_rate` sort with a base under 20 "sort last and show the rate greyed" | done on the list and Reports (`rateSortValue`) | — |
| MCP `report_sequences` default period 30d | default all time (pass `period` for a cohort); `sequences_list` / `sequence_stats` are all time | The list's default is all time (§3.5) |

Also: `outreach_report_sequences` no longer returns `totals` (the grouped 013 totals); the digest email and the client portal were moved to the new fields. `outreach_report_sequence` keeps `totals` for the step table. `sequence_summary` (005) still exists for older callers.

## Rollout status (26 Oct 2026)

- Migration + smoke test pass in a rolled-back dry run against the live project (`cat 089 smoke_25 > t.sql; bash scripts/outreach-sql.sh t.sql` → SMOKE OK, 11 s including the backfill of 30 sequences / 773 enrolments).
- **Not applied live yet** (the live apply was blocked in the session). To go live: `bash scripts/outreach-sql.sh migrations/outreach/089_sequence_stats.sql`, then `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_25_sequence_stats.sql`, then `bash scripts/outreach-deploy-functions.sh outreach-mcp outreach-api outreach-worker-reports` (add `OUTREACH_DEPLOY_EXTRA_ARGS=--use-api` without Docker), then deploy the web app.
- After applying, compare the backfilled Replied with the old column (PRD §10 phase 1): `select q.name, (c.stats->>'replied')::int as replied_people, (select count(*) from outreach_enrollments e where e.sequence_id = q.id and e.status = 'exited_replied') as exited_replied from outreach_sequences q join outreach_sequence_stats_cache c on c.sequence_id = q.id order by 2 desc;` — differences are OOO / auto-replies (no longer counted) and replies credited to another sequence (latest touch wins).
- Performance (§11): a 50k-enrolment sequence is untested; the truth functions run `enable_nestloop = off` with materialized CTEs and sequence rebuilds go 500 leads at a time. The per-lead trigger path is ~10 ms.
