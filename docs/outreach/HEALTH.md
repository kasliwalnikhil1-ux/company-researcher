# Health page and daily health email

Built from `health-page-PRD.md` v1.1 (7 Oct 2026). This file records what shipped, where it lives, every place the build
deviates from the PRD and why, how to run it locally, and how to test it.

## Where things are

| Piece | Path |
|---|---|
| Schema, `ops.health_run()`, `ops.run_done()`, seeds (checks, limits, settings) | `migrations/outreach/081_health.sql` |
| Page RPCs (`outreach_health_*`), stuck users, usage, `outreach_report_client_event`, collector RPCs (`outreach_ops_*`), the daily payload | `migrations/outreach/082_health_rpcs.sql` |
| Cron: `outreach-health-run` (5 min, SQL only), `-collect` (5 min), `-daily` (hourly), `-cleanup` (04:10) | `migrations/outreach/083_health_cron.sql` |
| Smoke test (45 assertions, rolled back) | `migrations/outreach/tests/smoke_22_health.sql` |
| The wrapper: `withHealth`, `fetchWithHealth`, `recordCall`, `noteCallError`, `reportItems` | `supabase/functions/_shared/health.ts` |
| F48 health-collect (metrics endpoint, logs API, urgent emails) | `supabase/functions/outreach-health-collect/` |
| F49 health-daily (advisors, daily snapshot, upgrade answer, the daily email) | `supabase/functions/outreach-health-daily/` |
| F50 health-ping (public `ok` / `stale`) | `supabase/functions/outreach-health-ping/` |
| Email rendering (daily, urgent, recovered, stale) | `supabase/functions/_shared/outreach/health_email.ts` |
| AI outcomes (`ok`, `provider_error`, `timeout`, `empty`, `cut_off`, `refused`, `bad_format`), `logAiCall`, `markUnusable`, `geminiFetch` | `supabase/functions/_shared/outreach/llm.ts` |
| Build check | `scripts/check-health-coverage.mjs` (runs in `outreach-deploy-functions.sh` and `npm run lint`) |
| Page | `app/outreach/settings/admin/health/page.tsx` → `components/outreach/settings/admin/health/*` |
| Guides (G1–G19), links, steps, read tables | `lib/outreach/health-guides.ts` |
| Types, the Claude prompt, link filling, glossary, stuck-user copy | `lib/outreach/health.ts` |
| What the web app records (`reportError`, `track`, rage clicks) | `lib/outreach/clientEvents.ts`, mounted by `components/outreach/HealthClientEvents.tsx` in the outreach layout |
| Entry in the Admin tab (coloured dot) | `components/outreach/settings/admin/HealthEntryCard.tsx` |

Route: `/outreach/settings/admin/health?tab=now|usage|stuck|settings&check=<key>`. Localhost only, like the rest of the
Admin tab (`useIsLocalhost`), and every RPC calls `platform_require_admin()` first. Not in the product tour
(`lib/outreach/backend/demo/routes.ts`: `demo: false`; every `health_*` RPC refuses in the demo).

## Deviations from the PRD

| PRD | Build | Why |
|---|---|---|
| Tables `actions`, `senders`, `ai_calls`, `ops.inbound_events` | `outreach_actions`, `outreach_senders`, `outreach_ai_calls`, `outreach_inbound_events` | The build's prefix (PRD "Names") |
| `pgmq.metrics_all()` for `flow-2` | The five queue tables (`outreach_ai_classify_queue`, `_ai_lead_notes_queue`, `_push_queue`, `_enrich_queue`, `_transcribe_queue`): length and age of the oldest due row | There is no pgmq in this project |
| AI model calls only in `_shared/outreach/ai.ts` | Only in `_shared/outreach/llm.ts` (the transport); `ai.ts` is the feature layer on top of it. `transcribe.ts` and `webchat.ts` call Gemini through `geminiFetch()` exported by `llm.ts` | That is where the provider hosts already lived |
| Hosts only in `health.ts` and the AI file | The allow list also holds the Resend, Stripe, ElevenLabs and Unipile client modules; each must import the wrapper or the check fails | Each provider has one client module; every call in it goes through `fetchWithHealth` |
| `withHealth` in every entry file | `serve()` in `_shared/outreach/supabase.ts` wraps the handler; the seven Hono / raw `Deno.serve` functions call `withHealth` by hand. The check accepts either | One change covers 53 functions |
| `ops.invoke` | `outreach_invoke` (existing) | Existing name |
| `planner_completeness` (§17) for `job-5` | Healthy senders in an active sequence's pool, past 06:00 local, with no `outreach_sender_budgets` row for their local day | No such metric existed; this is what "has a plan" means in the build |
| `job-1` act: "`tick` not started in 3 min" | Job name `outreach-tick` | Existing job name |
| Jobs = `cron.job` rows | Since 084 `outreach-tick` is the dispatcher (every 10 s) and the 15 frequent workers are rows of `outreach_cron_jobs`. `job-1` lists them as `outreach-tick/<name>` (late = the dispatcher has not looked at the row for 3× / 10× its `every_s`); `job-3` and `sys-2` count the dispatcher's calls from `outreach_cron_invocations` next to real cron starts. `job-2` still sees only pg_cron failures: a guard that raises fails open and is kept in `outreach_cron_jobs.last_error` | 15 jobs × every 10–60 s made ~45k invocations and ~250k log rows a day with empty queues (Oct 2026 overage) |
| `flow-1` counts every unprocessed event | Counts rows with `attempts < 5`; rows at 5 attempts are listed apart as "abandoned" | `process-inbound` stops at 5 attempts without marking the row dead; six such rows from 28 Sep would otherwise keep the check red forever |
| `flow-6` 24 h disconnection | `coalesce(disconnected_at, updated_at)` | `disconnected_at` is only set for the `disconnected` status (billing); `credentials` / `error` use `updated_at` |
| Metrics endpoint secret "in Vault" | The runtime's service key (`SUPABASE_SERVICE_ROLE_KEY`, the `sb_secret_` key) works for HTTP Basic; `OUTREACH_METRICS_KEY` overrides it | Verified 7 Oct 2026: both the legacy JWT and the `sb_secret` key answer 200 |
| Management API logs `logs.all` | `GET /v1/projects/{ref}/analytics/endpoints/logs` with ClickHouse SQL over the unified `logs` table filtered by `source`; the status code is `splitByString(' | ', event_message)[2]` | `logs.all` was removed (changelog 48235); the new endpoint exposes no `metadata` column, so the message is parsed |
| Management API token in Vault | Function secret `OUTREACH_MGMT_TOKEN` (read by F48 and F49; Supabase refuses secret names starting with `SUPABASE_`). Without it `fn-4`, `app-2` and `db-9` are grey with the reason on the card | Edge functions read secrets from env, not Vault |
| `db-6`..`db-8` thresholds "for an hour / 15 min" | F48 keeps the last 13 five-minute samples in `ops.health_kv` (`metrics_history`) and evaluates: CPU act = last 3 samples ≥ 90, watch = hour average ≥ 70; memory act = ≥ 90 or swap holding > 5% for 3 samples; disk act / watch = last 3 samples ≥ 90 / 70% of the IOPS limit (`ops.limits.disk_iops`, 3000) | Counters need two samples; the first run after deploy stores one and reports grey once |
| `health_state` columns | `+ alerted_status`, `+ error`; `ops.health_kv` and `ops.job_last_start` tables added; `ops.limits` keyed by `(key, plan)` with plan `any` | The urgent email needs to know what it last said; grey needs a reason; F48/F49 need a small store; per-plan limit rows |
| `api-1.ai` red → urgent email | As specified (`urgent = true` on `api-1.ai`); the email lists failed AI replies and lines that used their fallback, by workspace, for the last hour | — |
| `ai-3.replies` watch: "twice the 7-day average" | Share over the last 24 h against the share over the 7 days before, ≥ 20 finished runs; act: ≥ 50% of ≥ 20 finished in the last hour across ≥ 3 workspaces | — |
| `ai-2.lines` "variable switched on" | No such flag exists; pending values older than 5 min in workspaces whose `outreach__ai_pool` is ok | — |
| `app-1` "20% of people active in the hour" | Active = distinct users with a product event or error in the hour (the only per-hour presence the app records) | Overstates the share when few events are recorded; the 10-people rule is the main one |
| `app-2` thresholds | 5xx in the last 15 min against the 15 min before, from the gateway (`edge_logs`) | — |
| Per-check timings | `ops.health_run()` returns `ms` per check and stores it in `health_kv.health_run` | G16: when Health itself is among the top queries, this names the check |
| `cron.job_run_details` scans | 081 creates two indexes on it when allowed (`insufficient_privilege` is caught), and the job checks read a 3-hour temp window plus `ops.job_last_start` instead of scanning the table per job | 280,000 rows with no index cost 5–15 s per scan on this compute size |
| "Secret API key" of the metrics endpoint | See above | — |
| Sentry link | Not built | Sentry is not connected |
| Function names | `ops.fn_name()` turns what a function calls itself in `serve("worker-tick")` into the deployed name `outreach-worker-tick`, so `fn_stats` matches the cron commands | 53 functions name themselves without the prefix |
| `flow-2` counts every due queue row | Rows at 5 attempts are listed as `abandoned`, not waiting (as `flow-1`) | Workers stop at 5 attempts without deleting the row |
| `job-1` for a job never seen | Counted from Health's first run (`health_kv.health_first_run`), not from "a day ago" | pg_cron keeps no creation time; a daily job would be red for a day after install |
| `job-3`, `sys-2` windows | Only cron starts after the wrapper's first `fn_stats` bucket (+5 min) count; `sys-2` compares AI counts and no-outcome rows since the first `api_stats` bucket; rows logged before 081 were set to `ok` | The first hour after deploy otherwise reports 1,500 "unfinished" runs and six "silent" hourly functions |
| Usage rows `cron_concurrent`, `cron_run_minutes` | From the `job-4` check's state | A scan of `cron.job_run_details` cost 9 s cold |
| Indexes on `cron.job_run_details` | Attempted in 081; on the live project the role may not (0 created), so the job checks use the 3-hour window + `ops.job_last_start` and run in 20–500 ms | Confirmed 7 Oct 2026 |

## Live state, 7 Oct 2026

081, 082, 083 applied; all 55 functions deployed with the wrapper (`fn_stats` filling, ~1,500 runs an hour); the four
cron jobs scheduled; `outreach-health-collect` and `-daily` verified by hand (200). `OUTREACH_MGMT_TOKEN` set 7 Oct 2026 (fine-grained token: Advisors read + Logs read, project-scoped; logs API verified 200).
Still to do by a person: Health settings (recipients, AI budget, plan / compute).

First real findings the page surfaced: `db-7` red — the database instance (428 MB RAM, `max_connections` 60) has 55% of
its swap in use; `flow-2` red + `fn-2` amber — `outreach_enrich_queue` has rows from 28 Sep at `attempts = 0` that
`outreach-worker-enrich` never picks up, and its runs exceed 60 s; `flow-1` lists six abandoned `account_status` events.

## Secrets and setup

1. `OUTREACH_MGMT_TOKEN`: a Supabase personal access token with only `analytics_logs_read` and `advisors_read`
   (create it in the dashboard → Account → Access tokens, fine-grained). Set with
   `supabase secrets set OUTREACH_MGMT_TOKEN=sbp_... --project-ref ktwqkvjuzsunssudqnrt`. Until it is set, `fn-4`, `app-2`
   and `db-9` stay grey and say so.
2. Health settings (Settings → Admin → Health → Settings): recipients of the daily email, the hour and time zone, the
   Supabase plan and compute size (seed: Pro, micro; the live project's `max_connections` is 60), the AI monthly budget
   (`api-5` is grey until one is set), and whether there are paying customers (the Free → Pro rule).
3. Rollout order: 081, 082 (applied 7 Oct 2026) → deploy every function (the wrapper lives in `serve()`) → 083 (cron;
   it also runs `ops.health_run()` once) → set `OUTREACH_MGMT_TOKEN` → fill in Health settings.
4. An outside uptime monitor (step 3 of the PRD): point it at
   `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-health-ping`; `ok` = 200, `stale` = 503.

## What the wrapper records

One `outreach_ops_run_done` call per function run (after the response, via `EdgeRuntime.waitUntil` where available):
function, outcome (`failed` = thrown or a 5xx answer), duration, items (`reportItems(n)`), error code and 300 scrubbed
characters of error text, and every outside call made during the run (provider, endpoint group, status, ms). A customer's
own key is recorded as `ai:own` / `elevenlabs:own` and never turns a platform check red (D13). `OUTREACH_HEALTH_OFF=1`
stops the writes (never the measuring). Failures of the write are logged and ignored.

Endpoint groups: Unipile `METHOD /path/with/:id`, Resend `emails.send`, Stripe `METHOD /path`, ElevenLabs
`METHOD /v1/...`, AI = the call's purpose (`reply_draft`, `classify`, `ai_fields`, `webchat_answer`, `transcribe`, …).

Counting rules in `ops.run_done`: `failed` = status 0 (network / timeout), ≥ 500, or 400; `rate_limited` = 429;
`auth_failed` = 401 / 402 / 403. Other 4xx (404, 409, 422) are calls, not failures: Unipile's `cannot_resend_yet` shows
under `flow-4` through `outreach_actions.error_code`.

## AI outcomes

`llmCallDetailed` writes one `outreach_ai_calls` row per call after the last retry with `outcome`, `http_status`,
`attempts`, `own_key`. `ai.ts` marks `bad_format` when a structured answer does not parse or a required part is missing
(`markUnusable`); `ai_reply_engine.ts` does the same for drafts and verifier answers. A `cut_off` answer is still returned
(the caller may use it) and keeps `cut_off`. The website assistant's successful turns are recorded by SQL
(`outreach_webchat_v_turn_record`), so a trigger sets those rows to `ok`; its failed streams are logged by the helper.

## Local

- SQL dry run (nothing committed): `cat migrations/outreach/081_health.sql migrations/outreach/082_health_rpcs.sql migrations/outreach/tests/smoke_22_health.sql > t.sql; bash scripts/outreach-sql.sh t.sql` → `SMOKE OK`.
- Build check: `node scripts/check-health-coverage.mjs`.
- Deno: `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x deno check --node-modules-dir=none supabase/functions/outreach-health-collect/index.ts` (and the others).
- Page: `npm run dev`, sign in as a platform admin, open `http://localhost:3000/outreach/settings/admin/health`.
- Run the collector by hand: `curl -X POST https://<ref>.supabase.co/functions/v1/outreach-health-collect -H "x-cron-secret: $OUTREACH_CRON_SECRET" -d '{"mode":"now"}'`; the daily email: same for `outreach-health-daily`.

## Acceptance tests (PRD §13) — what covers each

1 fn-1: `ops.run_done` + `health_run` (smoke 1a, 4a); the function-level test needs a deliberately failing deploy.
2 job-1 immediate: `health_apply` immediate rule (smoke 2e). 3 flow-1: live data. 4 api-3: smoke 2e / 8b.
5 token invalid: F48/F49 record `unknown` with the reason. 6 sys-1: `health_ping` (smoke 4c), the red banner on the page.
7 run_done failure: `writeRunDone` catches everything. 8 non-admin: smoke 6a–6d. 9 no lead data: smoke 1b, 5a, 6f, 6g.
10 links: `health-guides.ts` `checkedOn`; the Supabase paths are the ones the docs list. 11 snooze: smoke 7a.
12 daily email every day: F49 + `ops_daily` (smoke 8e). 13 product tour: `routes.ts`, demo RPC stubs.
14–18 AI: `ai-1`, `ai-2.*`, `ai-3.*` in `health_run`; the live tests need staging keys. 19 build check: `check-health-coverage.mjs`.
20 sys-2: `health_run`. 21 voice: `ai-4` in `health_run`.

## Database overload windows (found 7 Oct 2026)

The Postgres logs show the instance starving for hours at a time: pg_cron `job startup timeout` (600–880 an hour),
`could not accept SSL connection`, statement timeouts, and Supabase's own health check reporting db / REST / auth
unhealthy while the pooler stays up. Windows seen: 6 Oct 18:00 → 7 Oct 02:00 UTC, and 7 Oct from 14:00 UTC. Clean in
between, including the four hours after Health went live, so Health did not cause it. During a window the advisors
endpoint answers 544 (it cannot reach the database), so `db-9` goes grey, and `ops.health_run()` may not start: the
page shows "Checks have stopped" and `outreach-health-ping` returns `stale`. That is the signal working as intended.
