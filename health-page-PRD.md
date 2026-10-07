# PRD: Health page and daily health email

**Document:** Change PRD — an internal page that says whether the product is healthy, where to look when it isn't, and a daily email with the same answer
**Version:** 1.1 · 7 October 2026
**Changes in 1.1:** AI checks added (§4.6, guides G17 to G19). An AI provider outage now sends the urgent email. Every AI call records whether its answer was usable (§5.2). Rules and a build check so no call can skip the measuring (§5.1, `sys-2`). Voice calls covered from our own records.
**Applies to:** the app as built. New page under the platform-admin tool (`/outreach/settings/admin`). Reads the existing `ops.*` tables, `actions`, `senders`, `ai_calls`, `cron.job_run_details` and the `pgmq` queues.
**Migration:** `0NN_health` (next free number). **New functions:** F48, F49, F50.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Checked:** Supabase observability, Management API, Edge Function, cron and billing docs, 7 Oct 2026. Sources at the end.

---

## 0. Summary

| # | What |
|---|---|
| 1 | One internal page, **Health**, answers "is anything wrong?" with a single line at the top and a card per check: green, amber, red, or grey when a check couldn't run |
| 2 | Every card says, in plain words, what it measures, the number against its limit, why it matters and what to do |
| 3 | Every card has **Look closer**: the evidence, **clickable links** to the exact Supabase or app screen, numbered steps, and a table of "if you see this, it means this, do this" |
| 4 | Every card has **Copy prompt for Claude**: the evidence packed into a prompt you paste into your coding tool |
| 5 | A **Usage and limits** tab lists every limit that applies to the product (Supabase plan, compute, functions, scheduled jobs, LinkedIn, your own plans), what is used, and the date each will be reached at the current rate |
| 6 | A **"Do I need to upgrade?"** box gives one answer: no, fix something first, or upgrade this to that |
| 7 | A **Stuck users** tab lists customers who look confused and the screens where it happens most |
| 8 | A **daily email** carries the verdict in its subject line. A short **urgent email** goes out when something breaks |
| 9 | **AI is checked at three levels:** did the provider answer, was the answer usable, and did the AI work get done |

---

## 1. Today and the gap

| Exists | Missing |
|---|---|
| Supabase's own dashboard: reports, logs, advisors, query performance | It only knows Supabase. It can't see Unipile, sends, senders or customers, and it doesn't tell you which screen to open or how to read it |
| Platform PRD §17: a list of metrics and six alerts (inbound backlog, tick not run, planner, 429/500 rate, mass disconnect, webhook 5xx) | No page shows them and nothing sends them |
| `ops.inbound_events`, `ai_calls`, `actions.error_code`, `sender_events`, `audit_log` | Nothing records how each Edge Function run went, or how each outside API call went, in a form you can count |
| "Why isn't it sending" for customers | Nothing for you about which customers are stuck |
| A platform-admin tool at `/outreach/settings/admin` | A health view inside it |
| `ai_calls` logs tokens and timing for every AI call | Whether the call failed, and whether the answer could be used |

Supabase publishes ready-made agent prompts that run health, security, performance and capacity checks through its MCP server. This PRD builds the same checks into the product, so the result is a page and an email, and adds the parts Supabase can't see.

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | The page is for platform admins only and lives at `/outreach/settings/admin/health`. Hidden in the demo | It shows every customer's workspace name and error counts |
| **D2** | A check that can't run is **grey, "Couldn't check"**. It is never green | A broken check that shows green is worse than no check |
| **D3** | Checks that only need the database run **inside the database**, straight from pg_cron, with no Edge Function | They keep working when Edge Functions are down, and they cost no function invocations |
| **D4** | Functions and outside API calls are measured by **one shared wrapper** that writes one small row per run | One place to add it, one write per run, and every function is covered the same way |
| **D5** | Thresholds and limits are rows in tables, editable on the page. Guides are one file in the repo | You can change a limit without a deploy. Guides need review when Supabase renames a screen, and one file is easy to hand to Claude |
| **D6** | Amber and red need **two checks in a row** before they show. Key and billing errors show at once | Stops one bad minute from sending an email |
| **D7** | The page stores counts, timings, error codes and short error text. **No message text, no lead data** | The page is for health, and logs are the wrong place for customer content |
| **D8** | The daily email is sent **every day, including when everything is fine** | A missing email is then itself a signal that the checks stopped |
| **D9** | Where Supabase documents a threshold, use it. Where the platform PRD §17 set one, keep it | No invented numbers where a sourced one exists |
| **D10** | No auto-fix. The page tells you and gives you a prompt | A wrong automatic fix on a sending product is expensive |
| **D11** | Every AI model call goes through the one AI helper in `_shared/outreach/ai.ts`, and every call to an outside service goes through the wrapper. A build check fails when any other file calls a provider directly | A call that skips the measuring is invisible, and nobody notices until it matters |
| **D12** | An AI call has two results: did the provider answer, and could we use the answer. Both are stored on `ai_calls` | A reply cut off at the length limit comes back from the provider as a success |
| **D13** | Calls made on a customer's own AI or voice key are counted apart and never turn a platform check red | Their revoked key is theirs to fix. It must not send you an urgent email |

---

## 3. The page

### 3.1 Where and who

| Item | Rule |
|---|---|
| Route | `/outreach/settings/admin/health`, with `?tab=now\|usage\|stuck\|settings` and `?check=<key>` to open one card's Look closer panel |
| Entry | A **Health** item in the platform-admin tool, with a coloured dot showing the current verdict |
| Access | Platform admins only. Uses the existing platform-admin check. If there is no helper yet, add `ops.assert_platform_admin()` and call it first in every Health RPC |
| Demo | Not rendered on `/product-tour` |
| Refresh | The page re-reads `health_overview()` every 60 seconds while open; a **Check now** button |

### 3.2 Layout

```
Health                                        Last checked 2 min ago · [Check now]

● 1 needs action · 2 to watch · 31 fine · 1 couldn't check

Do I need to upgrade?
Not yet. The database is at 41% of its disk and 35% of its connections.
At this rate the disk reaches 85% around 14 Feb 2027.              [How this is decided]

[ Now ]  [ Usage and limits ]  [ Stuck users ]  [ Settings ]

NEEDS ACTION
● Sends failing                                   18% of sends failed · limit 15%
  Since 10:35. Most are "429 too many requests" from Unipile on 6 senders.
  What to do: LinkedIn is being asked too fast on those senders. Look closer for which ones.
  [Look closer ▾]  [Copy prompt for Claude]  [Snooze]            ▁▁▂▁▁▃▇ 7 days

TO WATCH
● Database connections                            72% in use · watch at 60%, act at 80%
● A function is close to its time limit           worker-imports took 210 s · limit 400 s

FINE  (31)   ▸ Database  ▸ Scheduled jobs  ▸ Functions  ▸ Messages in and out  ▸ Outside services  ▸ AI  ▸ App
COULDN'T CHECK (1)
○ Supabase advisor findings                       Supabase didn't answer. [Open Advisors]
```

### 3.3 What every card must say

| Line | Rule |
|---|---|
| Name | A plain phrase. "Sends failing", not "action_failure_rate" |
| Number | The value, then the limit it's compared with |
| Since | When it turned amber or red |
| One sentence | The most likely cause, built from the evidence (top error code, top function, top sender) |
| What to do | One instruction. If nothing needs doing, say so: "Nothing. This clears on Monday when LinkedIn resets the weekly invite cap." |
| Look closer | §6 |
| Copy prompt for Claude | §3.5 |
| Snooze | For 1, 7 or 30 days, with a reason. A snoozed check shows in its own group and in the email footer |
| 7-day line | Small chart of the value |

Words to avoid on the page: p95, latency, throughput, saturation. Use "slowest", "how long it took", "how busy". A small **?** next to these eight words opens a one-line meaning: connection, index, scheduled job (cron), webhook, queue, compute size, egress, row-level security.

### 3.4 Status rules

| Status | Shown as | Rule |
|---|---|---|
| `ok` | Green · Fine | Below the watch line |
| `watch` | Amber · Watch | At or past the watch line on two checks in a row |
| `act` | Red · Act now | At or past the act line on two checks in a row. At once for checks marked **immediate** |
| `unknown` | Grey · Couldn't check | The source didn't answer, or the check errored |

A check returns to green after two green checks in a row. The top line is the worst status among checks that are on and not snoozed.

### 3.5 Copy prompt for Claude

The button copies text built from the check's stored evidence. Fixed shape:

```
Health check "Sends failing" (flow-4) is red on GrowthxAI Outreach.
Value: 18% of 412 sends failed in the last hour. Limit: 15%.
Red since: 7 Oct 2026, 10:35 IST.

Evidence:
- error_code 429: 61 failures across 6 senders, all on Unipile POST /api/v1/chats
- error_code 422 cannot_resend_yet: 13 failures
- worker-tick: 60 of 60 runs finished, none failed

What the guide says this usually means: LinkedIn is being asked too fast on those senders.

Find the cause in the code and the data, explain it to me in plain words, and
propose the smallest fix. Don't change sending limits or resend anything
without asking me first.
```

The last paragraph is always there. Evidence never contains message text or lead data (D7).

---

## 4. The checks

Each check is a row in `ops.health_checks`. **Step** is the rollout step (§12). **Imm.** means it shows red at once and sends the urgent email. **Urgent** means it waits for the usual two checks in a row, then sends the urgent email.

### 4.1 Database

| Key | Name | The question it answers | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `db-1` | Database size | Is the disk filling up? | `pg_database_size` against the disk limit in `ops.limits` | 70%, or full within 30 days | 85%, or full within 7 days | G4 | 1 |
| `db-2` | Connections in use | Is the database running out of room for new connections? | `pg_stat_activity` against `max_connections` | 60% | 80% (Supabase's line) | G2 | 1 |
| `db-3` | Slow queries | Is a query taking the database's time? | `pg_stat_statements`, compared hour to hour | A query averaging ≥ 100 ms, ≥ 20 calls in the hour, and twice the hour before (Supabase's rule) | A query averaging ≥ 1 s with ≥ 20 calls in the hour | G3 | 1 |
| `db-4` | Stuck or blocked queries | Is something holding everything else up? | `pg_stat_activity` and `pg_blocking_pids` | Any query active, or idle in a transaction, for over 30 s | Any query blocking another for over 2 min | G5 | 1 |
| `db-5` | Fast-growing tables | Is a table growing faster than the business? | Daily size of the 20 biggest tables | A table over 100 MB that grew more than 20% in 7 days | — | G4 | 1 |
| `db-6` | How busy the database is (CPU) | Is the database short of processing power? | Supabase metrics endpoint | Over 70% for an hour | Over 90% for 15 min | G1 | 2 |
| `db-7` | Memory | Is the database short of memory? | Supabase metrics endpoint | Over 80% | Over 90%, or swap in use | G1 | 2 |
| `db-8` | Disk activity | Is the disk the bottleneck? | Supabase metrics endpoint | 70% of the compute size's limit for 15 min | 90% for 15 min | G1 | 2 |
| `db-9` | Supabase advisor findings | Has Supabase spotted a security or speed problem? | Management API advisors | Any performance finding at WARN | Any security finding at ERROR | G6 | 2 |

### 4.2 Scheduled jobs

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `job-1` | Jobs running on time | Did every scheduled job start when it should? | `cron.job_run_details`, last start per job against its schedule | Late by 3× its interval (at least 2 min) | `tick` not started in 3 min (§17), or any job late by 10× its interval · **Imm.** | G7 | 1 |
| `job-2` | Jobs failing | Did a job end in an error? | `cron.job_run_details` where status is `failed`, last hour | 1 failure | 3 failures of one job, or any failure of `tick` or `inbound` | G7 | 1 |
| `job-3` | Jobs finishing their work | Did the function behind each job finish? | Starts in `cron.job_run_details` against finished runs in `ops.fn_stats` | 1 unfinished run in an hour | 5 unfinished runs in an hour | G8 | 1 |
| `job-4` | Jobs piling up | Are too many jobs running at once, or too long? | `cron.job_run_details` where status is `running` | More than 8 at once, or one running over 10 min (Supabase's recommendations) | 24 or more at once (the hard limit is 32) | G7 | 1 |
| `job-5` | Tomorrow's plan | Does every healthy sender have a plan for tomorrow? | `planner_completeness` (§17) | — | Under 100% by 06:00 sender time | G10 | 1 |

### 4.3 Functions

Each function check covers every Edge Function. The card names the worst one and lists the rest under Look closer.

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `fn-1` | A function is failing | Is any Edge Function erroring? | `ops.fn_stats`, per function, 15 min | ≥ 5 failures and ≥ 1% of runs | ≥ 20 failures, ≥ 1% of runs and twice the 15 min before (Supabase's rule for server errors) | G8 | 1 |
| `fn-2` | A function is slow | Is a function taking longer than it should? | `ops.fn_stats` slow runs against `ops.fn_config.slow_ms` | ≥ 10% of runs slow over an hour | A cron function taking longer than its own interval for 15 min | G8 | 1 |
| `fn-3` | A function is close to its time limit | Will Supabase start stopping it? | Longest run against the wall-clock limit in `ops.limits` | 50% of the limit | 80% of the limit | G8 | 1 |
| `fn-4` | Functions stopped by Supabase | Did Supabase stop a function (codes 546, 504, 503)? | Management API logs | 1 in an hour | 5 in an hour | G8 | 2 |

### 4.4 Messages in and out

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `flow-1` | Incoming events waiting | Are replies and status changes being processed? | `ops.inbound_events` where `processed_at` is null | Over 100, or oldest over 1 min | Over 500, or oldest over 2 min (§17) · **Imm.** | G9 | 1 |
| `flow-2` | Queues backing up | Is a queue not being emptied? | `pgmq.metrics_all()`, age of the oldest message per queue | Over 2 min | Over 10 min | G9 | 1 |
| `flow-3` | Nothing arriving from Unipile | Have webhooks stopped? | Latest `ops.inbound_events.received_at`, only when 5 or more senders are connected | None for 2 h | None for 6 h | G9 | 1 |
| `flow-4` | Sends failing | Are messages and invites failing? | `actions` failed against attempted, last hour, grouped by `error_code` | ≥ 5% with ≥ 20 attempts | ≥ 15% with ≥ 20 attempts · **Imm.** | G10 | 1 |
| `flow-5` | Sends running late | Are due sends not going out? | `actions` due over 15 min ago and still pending, not counting ones held by budget or working hours | Over 20 | Over 200, or oldest over 1 h | G10 | 1 |
| `flow-6` | Senders disconnected | Are accounts dropping off? | `senders` in `credentials`, and `sender_events` | Any sender disconnected over 24 h | Over 10% of senders within 1 h (§17) · **Imm.** | G11 | 1 |
| `flow-7` | Webhook receiver failing | Is the function that takes Unipile's calls returning errors? | `ops.fn_stats` for `unipile-webhook` | — | Any failure (§17) · **Imm.** | G8 | 1 |

### 4.5 Outside services

One set of checks per provider: Unipile, the AI provider, Resend, Stripe, ElevenLabs. Keys carry the provider, e.g. `api-1.unipile`, `api-1.ai`.

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `api-1` | Calls failing | Is the provider returning errors? | `ops.api_stats`, 15 min | ≥ 5 errors and ≥ 2% | ≥ 20 errors and ≥ 5% (§17) · **Urgent** for the AI provider | G12, and G17 for the AI provider | 1 |
| `api-2` | Being rate-limited | Is the provider telling us to slow down (429)? | `ops.api_stats.rate_limited`, 15 min | ≥ 5 | ≥ 5% of calls | G12 | 1 |
| `api-3` | Key or billing problem | Has a key stopped working, or credit run out (401, 402, 403)? | `ops.api_stats.auth_failed` | — | Any · **Imm.** | G12 | 1 |
| `api-4` | Slower than usual | Is the provider slow? | Average time against its 7-day average, ≥ 20 calls | Twice as slow | — | G12 | 1 |
| `api-5` | AI spend | Is AI cost on track for the month? | `ai_calls` tokens × price against the monthly budget in Health settings | 80% of budget | 100% | G15 | 1 |

Calls made on a customer's own key are left out of these checks (D13). A customer whose key is rejected shows in §7.2.

### 4.6 AI

§4.5 says whether the AI provider answered. This section says whether the answers could be used and whether the AI work got done. Keys carry the feature, e.g. `ai-2.replies`.

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `ai-1` | AI answers we can't use | Is the AI answering with something broken? | `ai_calls.outcome` in `bad_format`, `cut_off`, `empty`, `refused` (§5.2), per purpose, last hour | ≥ 5 and ≥ 2% of that purpose's calls | ≥ 20 and ≥ 10% of that purpose's calls | G17 | 1 |
| `ai-2.replies` | AI replies waiting | Is a reply the AI should be writing stuck? | `ai_reply_runs` in `drafting`, or in `debouncing` past `debounce_hard_until` | Oldest over 5 min | Oldest over 15 min | G18 | 1 |
| `ai-2.lines` | Personalized lines waiting | Are leads waiting for a line nobody is writing? | `ai_variable_values` in `pending`, for workspaces with AI allowance left and the variable switched on | Oldest over 15 min | Oldest over 60 min | G18 | 1 |
| `ai-2.website` | Website visitors waiting | Is a visitor waiting for the assistant? | Website chats with the assistant on and not handed over, where a visitor's message has no answer after 30 s | 3 in 15 min | 10 in 15 min | G18 | 1 |
| `ai-3.replies` | AI giving up more than usual | Is the AI passing more conversations to people, or failing more? | `ai_reply_runs` ending `escalated` or `failed`, as a share of finished runs | Twice the 7-day average, with ≥ 20 finished runs in 24 h | ≥ 50% of ≥ 20 finished runs in the last hour, across 3 or more workspaces | G18 | 1 |
| `ai-3.website` | Website assistant stumped more than usual | Are visitors asking things it can't answer? | `ai_unanswered_questions` opened today | Twice the 7-day average, with ≥ 10 | — | G18 | 1 |
| `ai-4` | Voice calls failing | Are voice calls failing to start, ending in an error, or never being closed? | `outreach_webchat_voice_calls` with `status = 'failed'` or `ended_reason = 'error'`; calls still open 30 min after they started; `outreach_webchat_voice_agents.sync_error` | 3 failed and ≥ 10% of calls in an hour, or any call still open after 30 min, or any sync error | 10 failed and ≥ 30% of calls in an hour | G19 | With voice |

What is and isn't counted:
- **Good handovers are left out of `ai-3`.** A conversation handed over because a meeting was confirmed, a calendar link was sent, a booking was made, or a person replied or stopped the AI by hand (`meeting_confirmed`, `calendar_sent`, `booking`, `human_replied`, `manual`) is the AI doing its job.
- **A blank line is not a broken answer.** When a profile has nothing to write about, the value is `blank`, and `ai-1` ignores it.
- **Queues are already covered.** The `ai_classify` and `ai_reply` queues backing up show under `flow-2`.
- **Customer keys are counted apart** (D13).
- **`ai-2.website`** uses the website-chat tables from the web-chat spec. The builder maps "visitor message with no assistant answer" to them.

### 4.7 App

| Key | Name | The question | Measured from | Watch | Act | Guide | Step |
|---|---|---|---|---|---|---|---|
| `app-1` | Errors people see | Are people hitting errors in the app? | `ops.client_errors`, last hour | 3 people on the same error | 10 people, or 20% of people active in the hour | G13 | 3 |
| `app-2` | Requests failing | Are requests to the backend failing (5xx)? | Management API logs, API gateway | ≥ 5 and ≥ 1% | ≥ 20, ≥ 1% and twice the period before (Supabase's rule) | G13 | 2 |
| `app-3` | Stuck users | Is anyone stuck today? | §8 | 1 or more workspaces | — | G14 | 3 |

### 4.8 The checks themselves

| Key | Name | Rule |
|---|---|---|
| `sys-1` | Checks running | If `ops.health_run()` last ran over 15 min ago, the page shows a red banner: "Checks have stopped. The numbers below are old." Guide G16 |
| `sys-2` | Everything is being measured | Amber when, over the last 24 hours: a scheduled function has no rows in `ops.fn_stats`; or the number of AI calls in `ai_calls` and in `ops.api_stats` differ by more than 5%; or any `ai_calls` row has no outcome. Guide G16 |

---

## 5. Where the numbers come from

| Source | Used for | How | Notes |
|---|---|---|---|
| Postgres itself | `db-1` to `db-5`, all `job-*`, `flow-*`, `api-*`, `fn-1` to `fn-3` | `ops.health_run()`, a `security definer` SQL function called by pg_cron every 5 min | Uses the queries Supabase publishes in its detection checks for connections, long-running sessions and table sizes |
| `ops.fn_stats`, `ops.api_stats` | Function and API checks | Written by the shared wrapper (§5.1) | New |
| `cron.job_run_details` | Job checks | Read directly | "Succeeded" here only means the database sent the request to the function. Whether the function finished comes from `ops.fn_stats`. `job-3` compares the two |
| Supabase metrics endpoint | `db-6` to `db-8` | F48 reads `https://<project-ref>.supabase.co/customer/v1/privileged/metrics` with HTTP Basic auth and a secret API key | Prometheus text format, about 200 series, in beta. The builder picks the CPU, memory and disk series from a live read. Supabase suggests reading once a minute; Health reads every 5 |
| Management API, logs | `fn-4`, `app-2` | F48 calls `GET /v1/projects/{ref}/analytics/endpoints/logs` with a `sql` query | At most 24 hours per query. Needs a token with `analytics_logs_read` |
| Management API, advisors | `db-9` | F49 calls `GET /v1/projects/{ref}/advisors/performance` and `/advisors/security` once a day | Supabase marks these endpoints experimental. If they fail the card is grey with a link (D2). Needs `advisors_read` |
| `ops.client_errors`, `ops.product_events` | `app-1`, `app-3`, Stuck users | Written by the web app (§8) | New |
| `ai_calls` | `ai-1`, `api-5`, the AI lines in the email | Written by the AI helper (§5.2) | Existing table, four new columns |
| `ai_reply_runs`, `ai_variable_values`, `ai_unanswered_questions` | `ai-2`, `ai-3` | Read directly by `ops.health_run()` | Existing tables, no change |
| Voice call records | `ai-4` | `outreach_webchat_voice_calls` and `outreach_webchat_voice_agents`, plus the wrapper on `outreach-voice-tools`, `outreach-elevenlabs-webhook` and the token request in `/voice/start` | The call itself runs between the visitor's browser and ElevenLabs. Health sees the start, the tool calls, the end and the post-call record. It can't see sound quality or what was said inside the call |
| Supabase Usage page | Egress, Realtime connections and messages | A link with steps (G15) | Supabase documents no API for these billing numbers. Marked "check by hand" on the Usage tab |

### 5.1 The shared wrapper

One module, `_shared/health.ts`, with three functions. Every Edge Function is wrapped in the first and uses the other two for every call it makes to an outside service.

| Function | What it does |
|---|---|
| `withHealth(name, handler)` | Wraps the function's handler. Times the run, catches any error, and at the end makes **one** database call, `ops.run_done(payload)`, with: function name, outcome (`ok`, `failed`), time taken, items processed, error code and the first 300 characters of the error text, plus the API calls made during the run |
| `fetchWithHealth(provider, group, url, init)` | Replaces `fetch` for calls to Unipile, the AI provider, Resend, Stripe and ElevenLabs. Records provider, endpoint group (e.g. `chats.send`), status code and time in memory. `withHealth` writes them at the end of the run |
| `recordCall(provider, group, fn)` | For a provider SDK that can't be given a custom `fetch`. Runs `fn`, times it, and records the result the same way, reading the status code from the error the SDK throws |

Rules:
- One write per run, however many API calls it made.
- A failed write to `ops.run_done` must never fail the function. Log and move on.
- Error text is trimmed to 300 characters. Email addresses, phone numbers, URL query strings and anything shaped like a key or token are replaced with `[removed]` before it is stored. No request or response bodies.
- `ops.run_done` adds to a 5-minute row per function in `ops.fn_stats` and per provider and endpoint group in `ops.api_stats`. It writes a row to `ops.fn_problems` or `ops.api_problems` only for a failure or a slow run.

**So that no call skips the measuring (D11):**

| Rule | How it is enforced |
|---|---|
| A provider SDK is created with `fetchWithHealth` as its `fetch` option. Where an SDK has no such option, its calls go through `recordCall` | Code review, and the build check below |
| AI model calls are made only inside `_shared/outreach/ai.ts` | Build check |
| Every Edge Function's handler is wrapped in `withHealth` | Build check |
| **Build check**, `scripts/check-health-coverage`: fails the build when a function's entry file doesn't use `withHealth`, or when any file other than `_shared/health.ts` and `_shared/outreach/ai.ts` contains a provider's API host name or imports a provider SDK. The list of host names and SDK packages is in the script | Runs on every deploy |
| What still slips through shows on the page | `sys-2` (§4.8) |

Cost of measuring: about 1.3 million small writes a month at the polling rate in the specs, into rows that already exist for the current 5 minutes. `ops.fn_stats` grows by a few thousand rows a day.

### 5.2 What the AI helper records

Every AI call already goes through `llmCallDetailed` in `_shared/outreach/ai.ts` and is logged to `ai_calls` with its purpose. Three changes:

1. The helper sends its request through `fetchWithHealth('ai', purpose, …)`. The purpose (`reply_draft`, `reply_classify`, `ai_fields`, …) is the endpoint group, so the page can say which AI feature is failing.
2. It writes one `ai_calls` row per call, after the last retry, with `attempts`, `http_status` and `own_key`.
3. It sets `ai_calls.outcome`:

| Outcome | Set when | Set by |
|---|---|---|
| `ok` | The answer was used | Helper |
| `provider_error` | The provider returned an error on the last retry | Helper |
| `timeout` | No answer in time on the last retry | Helper |
| `empty` | The provider answered with no text | Helper |
| `cut_off` | The answer stopped at the length limit | Helper, from the provider's stop reason |
| `refused` | The model declined to answer | Helper, from the provider's stop reason |
| `bad_format` | A structured answer was asked for and it didn't parse, or required parts were missing | Helper for parsing. The calling code for its own rules, through `markUnusable(callId, 'bad_format')` |

`provider_error` and `timeout` feed the provider checks in §4.5. The other four are the "answered, but unusable" cases and feed `ai-1`.

---

## 6. Look closer: links, steps and how to read them

This is the part of the page that teaches. Each check points to one guide. A guide opens under the card.

### 6.1 What a guide shows

```
Look closer · Slow queries                                  Guide checked 7 Oct 2026

THE EVIDENCE
  Query (shortened)                          Calls/hour   Average   Share of database time
  select … from messages where chat_id = …      41,200     140 ms    63%
  update actions set status = …                  3,600      12 ms     9%

OPEN
  ↗ Query Performance (Supabase)
  ↗ Performance Advisor (Supabase)

STEPS
  1. Look at the first row above. It is the query using most of the database's time.
  2. Open Query Performance and order the list by total time. Find the same query.
  3. Open the Performance Advisor and see whether it names the same table.

HOW TO READ IT
  If you see…                          It means…                  Do this
  One query with a large share and     Usually a missing index     Copy the prompt and ask for the index
  an average over 100 ms
  …
```

Rules:
- **The evidence comes first and is on the page.** The person shouldn't need to leave to see the top five rows.
- **Links open in a new tab** and go to the exact screen. Supabase links carry the project ref. Supabase's own docs use `_` in place of the ref, which opens a project picker; the build fills in the real ref from an environment variable.
- **Steps are numbered and each is one action.**
- **The table always has three columns:** what you see, what it means, what to do. A row can point to another guide.
- Each guide shows the date it was last checked against the live screens.
- Guides live in one file, `health-guides.ts`:

```ts
type Guide = {
  key: string;                 // 'G3'
  title: string;
  checkedOn: string;           // '2026-10-07'
  links: { label: string; url: string; kind: 'supabase' | 'app' | 'provider' }[];
  steps: string[];
  read: { see: string; means: string; do: string; next?: string }[];
};
```

### 6.2 Link list

`{ref}` is the Supabase project ref, `{org}` the organisation slug. Paths marked ✓ appear in Supabase's docs as written. The builder opens every link once before shipping and fixes any that moved.

| Label | URL | ✓ |
|---|---|---|
| Observability (reports) | `https://supabase.com/dashboard/project/{ref}/observability` | ✓ |
| API overview report | `https://supabase.com/dashboard/project/{ref}/observability/api-overview` | ✓ |
| Logs | `https://supabase.com/dashboard/project/{ref}/logs` | ✓ |
| Explorer (run SQL on the database or the logs) | `https://supabase.com/dashboard/project/{ref}/explorer` | ✓ |
| Query Performance | `https://supabase.com/dashboard/project/{ref}/database/query-performance` | ✓ |
| Performance Advisor | `https://supabase.com/dashboard/project/{ref}/advisors/performance` | ✓ |
| Security Advisor | `https://supabase.com/dashboard/project/{ref}/advisors/security` | ✓ |
| Health Advisor | `https://supabase.com/dashboard/project/{ref}/advisors/health` | ✓ |
| Edge Functions | `https://supabase.com/dashboard/project/{ref}/functions` | ✓ |
| Integrations (Cron and Queues are inside) | `https://supabase.com/dashboard/project/{ref}/integrations` | ✓ |
| Infrastructure (compute size) | `https://supabase.com/dashboard/project/{ref}/settings/infrastructure` | ✓ |
| Usage (organisation) | `https://supabase.com/dashboard/org/{org}/usage` | ✓ |
| Supabase status | `https://status.supabase.com` | confirm |
| Unipile dashboard | `https://dashboard.unipile.com` | confirm. No public Unipile status page turned up in the check |
| AI provider console and status | `https://platform.claude.com`, `https://status.claude.com` | confirm |
| Resend, Stripe, ElevenLabs, Vercel status | `https://resend-status.com`, `https://status.stripe.com`, `https://status.elevenlabs.io`, `https://www.vercel-status.com` | confirm |
| Failed sends (app) | `/outreach/inbox/sent?segment=failed` | from `inbox-replies-sent-PRD.md` |
| A workspace in the admin tool (app) | `/outreach/settings/admin` with the workspace selected | existing |
| AI → Activity, Needs you, Knowledge (app, your own workspace) | `/outreach/ai/activity`, `/outreach/ai/needs-you`, `/outreach/ai/knowledge` | from the AI hub spec |
| ElevenLabs dashboard | `https://elevenlabs.io/app` | confirm |

### 6.3 The guides

Chart names below are the ones Supabase's Reports doc lists. Button and column labels inside Supabase screens change; the builder corrects them during the link check.

#### G1 · The database is working too hard
**From:** `db-6`, `db-7`, `db-8` · **Open:** Observability · Infrastructure

1. Open Observability and choose the **Database** report. Set the range to the last 24 hours.
2. Look at three charts: **CPU usage**, **Memory usage**, **Disk IOPS**. On Disk IOPS, the straight line is the most your compute size can do.
3. Note the times of the peaks, then compare with the table.

| If you see | It means | Do this |
|---|---|---|
| CPU jumps at the same minute every hour or day, then drops | A scheduled job is heavy | Match the time in G7. Not a reason to upgrade |
| CPU high and flat for hours | A query that runs all the time is slow | G3. Fix this before thinking about an upgrade |
| The "IOWait" part of CPU is large | The database is waiting for the disk | Look at Disk IOPS, next row |
| Disk IOPS touching the line | The disk is the bottleneck. Most often a query reading a whole large table | G3. If G3 is clean, go up one compute size |
| Memory high and swap being used | Not enough memory. Supabase: sustained swap means memory pressure and slows the database a lot | If G3 shows nothing heavy, go up one compute size |
| All three high, G3 clean, and customers have grown | Real growth | Upgrade (G15) |

#### G2 · Too many connections
**From:** `db-2` · **Open:** Observability

1. Read the table in the card: who is connected, in what state, how many.
2. Open Observability, **Database** report, **Database connections** chart, last 24 hours. Check **Dedicated Pooler connections** and **Shared Pooler connections** too.

| If you see | It means | Do this |
|---|---|---|
| Many connections in the state `idle in transaction` | Code opens a transaction and doesn't close it | A bug. Copy the prompt |
| The count jumps every few seconds and falls again | Scheduled jobs. Each running job holds one connection | G7. Spread the jobs out or slow the idle ones |
| A steady climb as more people use the app | Normal growth | Watch it. Act at 80% |
| Edge Functions holding many direct connections | Functions are connecting straight to Postgres | Ask Claude to move them to the pooler or to the Supabase client |
| Near the limit all day, none of the above | The compute size is too small for the traffic | Go up one size. The limit per size is on the Usage tab |

#### G3 · Slow queries
**From:** `db-3` · **Open:** Query Performance · Performance Advisor

1. Look at the first row in the card. It is the query using the most database time in the last hour.
2. Open Query Performance and order the list by total time. Find the same query.
3. Open the Performance Advisor. See whether it names the same table.

| If you see | It means | Do this |
|---|---|---|
| One query with a large share of the time and an average over 100 ms | Usually a missing index. The Advisor often names it ("unindexed foreign keys") | Copy the prompt. Ask for the index as a migration |
| A query that takes a few milliseconds but runs a huge number of times | The code calls it in a loop, or polls too often | Reduce the calls. An index won't help |
| A query that got slower this week with the same number of calls | Its table grew | G4, then an index or a clean-up |
| The top queries come from the scheduled jobs or from Health itself | Our own background work | Lower how often it runs |
| The Advisor lists "unused index" | Harmless | Ignore unless disk is tight |

After a fix, check the card again in an hour. It compares one hour with the hour before.

#### G4 · Database size and growing tables
**From:** `db-1`, `db-5` · **Open:** Observability · Usage · Infrastructure

1. Read the table in the card: the 20 biggest tables, their size, and how much each grew in 7 days.
2. Open Observability, **Database** report, and compare **Database size** with **Disk usage**.

| If you see | It means | Do this |
|---|---|---|
| The biggest table is a log: `cron.job_run_details`, `ops.inbound_events`, `ops.*`, `audit_log`, `ai_calls`, a queue's archive | A clean-up job is missing or not running | Check in G7 that `cleanup` ran. Shorten how long the rows are kept |
| `messages` or `leads` is biggest and grows with customers | Real growth | Fine. Watch "full within" on the card |
| The size jumped in one day | An import, or code writing rows in a loop | The card shows which table. Copy the prompt |
| Disk usage is much larger than database size | Space held by deleted rows, or by the database's own write log | Ask Claude to run a bloat check |

#### G5 · Stuck or blocked queries
**From:** `db-4` · **Open:** Explorer

1. Read the list in the card: who, state, how long, waiting on what, blocked by whom, first 200 characters of the query.
2. To see it live, open Explorer, choose **Run SQL** with the database as the source, and run the query shown under the list.

| If you see | It means | Do this |
|---|---|---|
| `idle in transaction` for minutes | Code started a change and never finished it. Others queue behind it | A bug. Copy the prompt. Ask Claude before ending the query by hand |
| An active query running for minutes, from a scheduled job | A heavy job | G7 |
| A row with a number under "blocked by" | That number is the query causing the wait | Find its row and read what it's doing |
| It happens only during a deploy | A migration is changing a table | Expected. It clears when the migration ends |

#### G6 · Supabase advisor findings
**From:** `db-9` · **Open:** Security Advisor · Performance Advisor · Health Advisor

1. Open the Security Advisor first. Each finding has a level and a link to how to fix it.
2. Then the Performance Advisor.

| If you see | It means | Do this |
|---|---|---|
| A security finding at ERROR, e.g. a table without row-level security, or exposed auth users | Customer data may be readable by people who shouldn't see it | Fix today. Copy the prompt |
| A performance finding at WARN, e.g. unindexed foreign keys | A query will slow down as the table grows | Fix this week if the table is large |
| A finding at INFO | A suggestion | Ignore |
| A finding about something done on purpose | Supabase says to check findings against what you intended | Snooze the check with the reason |

#### G7 · Scheduled jobs
**From:** `job-1`, `job-2`, `job-4` · **Open:** Integrations → Cron · Edge Functions

A scheduled job has two halves. The database starts it on time and asks a function to do the work. The cron history only covers the first half: "succeeded" there means the request was sent. Whether the work finished is in G8.

1. Read the table in the card: job, schedule, last start, result, how long, how late.
2. Open Integrations, then **Cron**, and open the job's history.

| If you see | It means | Do this |
|---|---|---|
| Every job late or not running | The scheduler has stopped, or the database is overloaded | G1 first. If the database is calm, Supabase's fix is a fast reboot from project settings |
| One job failed with an error message | The SQL the job runs has a problem | Copy the prompt with the message |
| Jobs start on time but the function shows no runs | The call from the database to the function is failing: wrong address or cron secret, or Edge Functions are down | G8, then Supabase status |
| More than 8 jobs running at once | Too many overlap. pg_cron allows 32 at once and each uses a database connection | Stagger the schedules. Slow the idle polling |
| A job runs longer than the gap between its runs | Runs overlap and pile up | Ask Claude to add "skip if the last run is still going" |

#### G8 · A function is failing, slow or being stopped
**From:** `job-3`, `fn-1` to `fn-4`, `flow-7` · **Open:** Edge Functions · Logs

1. Read the card: which function, how many failures, the most common error text, the time of one example.
2. Open Edge Functions and click the function. On **Invocations**, filter by status code around that time.
3. Open **Logs** on the same function at the same time to read the error.

| Status code you see | It means | Do this |
|---|---|---|
| 500 | The code threw an error | Copy the prompt with the error text |
| 503 | The function couldn't start: a broken deploy or a missing secret | Redeploy the last working version, then fix |
| 504 | No answer in time. It is waiting on a slow outside service or a slow query | G12 or G3. Do less in each run |
| 546 | Supabase stopped it for using too much memory or processing time (256 MB, 2 s of CPU per request) | Process fewer items per run. Move heavy work into the database |
| 401 | The caller's key or secret is wrong | Check the cron secret |
| Health says runs didn't finish, and there is no error in our own records | Almost always a 546 or 504 | Confirm on Invocations |
| It succeeds but is near the time limit | Each run takes on too much | Lower the batch size |

#### G9 · Messages not coming in
**From:** `flow-1`, `flow-2`, `flow-3` · **Open:** Integrations → Queues · Unipile dashboard

1. Read the card: how many events are waiting, the age of the oldest, when the last one arrived.

| If you see | It means | Do this |
|---|---|---|
| Events arrive but the waiting pile grows | `process-inbound` is failing or too slow | G8 |
| Nothing arrives, and senders are connected | Unipile isn't calling us: the webhook was removed, the address changed after a deploy, or the secret doesn't match | Check webhooks in the Unipile dashboard. Run `bootstrap-webhooks.ts` again |
| The same rows show an error and a rising attempt count | One bad event is being retried forever | Copy the prompt with the event id |
| A queue's length is steady but its oldest message keeps getting older | The job that empties it isn't running | G7 |
| Only "new connection" events are late | Normal. Unipile reports these up to 8 hours late | Nothing |
| It's night for most senders | A quiet period | Nothing. This check never goes red on its own before 6 hours |

#### G10 · Sends failing or late
**From:** `job-5`, `flow-4`, `flow-5` · **Open:** Failed sends (app) · Unipile dashboard

1. Read the card: failures grouped by error code, by sender and by workspace.
2. Open Failed sends to see the same items a customer sees.

| If you see | It means | Do this |
|---|---|---|
| `422 cannot_resend_yet` | LinkedIn's weekly invite cap for that sender | Nothing. The system stops invites until Monday |
| `429` on a few senders | LinkedIn is being asked too fast on those accounts | The system pauses them. If it repeats, lower their daily limits |
| `429` or `500` across many senders | A problem at Unipile or LinkedIn | G12. Don't retry by hand |
| Failures in one workspace only | That customer's content or leads | Open the workspace and contact them |
| Sends late, none failing | `worker-tick` isn't running, or the plan is empty | G7, then `job-5` |
| Tomorrow's plan is incomplete | `worker-planner` failed for some senders | G8 for `worker-planner` |

#### G11 · Senders disconnected
**From:** `flow-6` · **Open:** the workspace in the admin tool · Unipile dashboard

| If you see | It means | Do this |
|---|---|---|
| A few, spread over days | Normal. LinkedIn asks people to log in again | The reconnect email already goes out. Nothing |
| Many within an hour | An incident at Unipile or LinkedIn | Pause sending. Don't retry in a loop: Unipile says a pile of rejected requests is itself a cause of disconnects |
| The same sender again and again | Their proxy country, or they use LinkedIn somewhere that conflicts | Contact the user |
| Disconnected over 24 hours, never reconnected | The person hasn't seen the email | Message them. They also show under Stuck users |

#### G12 · An outside service is failing or slow
**From:** `api-1` to `api-4` · **Open:** the provider's status page and dashboard (§6.2)

1. Read the card: provider, which call, which status codes, since when.
2. Open the provider's status page.

| Status code you see | It means | Do this |
|---|---|---|
| 401 or 403 | The key is wrong, revoked or expired | Create a new key at the provider and replace it in Vault |
| 402, or "insufficient credit" or "quota" | Credit or the plan's allowance has run out | Top up or raise the plan at the provider |
| 429 | We are calling too fast | The system slows down by itself. If it stays, ask the provider for a higher limit |
| 500s or timeouts on many calls | The provider has a problem | Their status page. The system retries. Nothing to fix |
| 500s on one call only, starting at a deploy | Our request is wrong | Copy the prompt |
| Everything works but slowly | The provider is degraded | Nothing unless it lasts a day |

#### G13 · Errors people see in the app
**From:** `app-1`, `app-2` · **Open:** API overview report · Logs · Sentry, if connected

1. Read the card: error text, screen, people affected, first seen, last seen, app version.
2. Open Logs and filter by status to the 500s around the same time. Supabase's Logs view shows one request across the API gateway, the database and functions.

| If you see | It means | Do this |
|---|---|---|
| First seen minutes after a deploy | That deploy | Roll back, or copy the prompt and fix forward |
| One person only | Their data or their browser | Open their workspace |
| Many people, one screen | A bug on that screen | Copy the prompt |
| 500s that mention a timeout | The database is slow | G1 and G3 |
| A jump in 401s or 403s | Sessions, or a change to row-level security | Look at the last migration |

#### G14 · Stuck users
**From:** `app-3` · **Open:** the Stuck users tab. See §8 for the signals and what each means.

#### G15 · Usage, the bill and upgrading
**From:** `api-5`, the Usage tab, the upgrade box · **Open:** Usage · Infrastructure

1. Open Usage. Choose the current billing period.
2. Read **Egress**, **Realtime peak connections** and **Realtime messages**. Health can't read these three by itself.
3. Type the three numbers into the Usage tab. Health keeps them and shows the trend.

| If you see | It means | Do this |
|---|---|---|
| Egress climbing faster than customers | Large responses: lists without paging, or big files | Ask Claude which requests return the most data |
| Function invocations heading over the included amount | Idle polling. The 10- and 15-second jobs make up most of it | It costs $2 per extra million. Slow the idle jobs if it matters |
| Realtime connections near the limit | Many tabs open at once | $10 per extra 1,000. Not a fault |
| Disk past what's included | Growth | $0.125 per extra GB on Pro. G4 if a log table is the cause |

Upgrade rules are in §7.3.

#### G16 · The checks have stopped
**From:** `sys-1`, `sys-2` · **Open:** Integrations → Cron · Edge Functions · Supabase status

| If you see | It means | Do this |
|---|---|---|
| `health-run` hasn't started | The scheduler stopped | G7, first row |
| `health-run` fails | A check's SQL has an error | Copy the prompt with the message |
| Only the Supabase-sourced checks are grey | The metrics endpoint or Management API token stopped working | Replace the token in Vault |
| No daily email arrived | `health-daily` or Resend | G8 for `health-daily`, then G12 for Resend |
| "Everything is being measured" names a function | That function isn't wrapped, so its failures don't show anywhere on this page | Copy the prompt |
| The two counts of AI calls differ | Some AI call skips the helper or the wrapper | Run the build check. Copy the prompt with the purpose it names |
| AI calls with no outcome | Code that logs to `ai_calls` without going through the helper | Copy the prompt |

#### G17 · The AI provider is failing, or its answers can't be used
**From:** `api-1` to `api-4` for the AI provider, `ai-1` · **Open:** AI provider status · AI provider console · the workspace in the admin tool · Edge Functions

1. Read the card: which purpose (reply draft, classifying, personalized lines, fields, website assistant), which status code or outcome, which model, which workspaces, since when.
2. Open the provider's status page.
3. If the status page is clean, see whether the trouble sits in one purpose, one workspace or one model. The table reads each case.

| If you see | It means | Do this |
|---|---|---|
| 500s or "overloaded" on every purpose, and the status page shows an incident | The provider is down | Nothing to fix. AI replies in that window ended as `failed` and were left for a person; lines used their fallback. The card lists how many, by workspace. When it recovers, decide whether to run the replies again: one that is hours late is often better written by a person |
| 429 on the platform key | We are past the provider's limit for requests or tokens a minute | Open the provider console's limits page and ask for a higher tier. Writing lines in bulk competes with live replies, so ask Claude to slow the bulk work first |
| 401, 402 or 403 on the platform key | The key was revoked, or credit ran out | Provider console, billing. Replace the key in Vault. This one emails you at once |
| 401 on one customer's own key only | Their key | Nothing for the platform. They see the "key invalid" message and appear in §7.2 |
| Timeouts, and the status page is clean | Our requests are too large or too slow: long threads, a high length limit, a high thinking setting | Copy the prompt. If the function is also being stopped, G8 |
| `cut_off` on one purpose | The answer is longer than that purpose's length limit allows | Raise the limit for that purpose, or ask the AI for less |
| `bad_format` on one purpose, starting at a deploy or a model change | The prompt, the expected shape or the model id changed | Copy the prompt with two example call ids |
| `bad_format` spread thinly across purposes, under the watch line | Normal. The retry handles it | Nothing |
| `empty` or `refused` in one workspace | That customer's prompt or content trips the model's safety rules | Open their AI setup in the admin tool. Contact them |
| `refused` or `bad_format` across workspaces on one model only | The model changed behaviour | Switch that purpose to another model. Model ids are settings, not code |

#### G18 · AI work waiting, or the AI giving up
**From:** `ai-2`, `ai-3` · **Open:** the workspace in the admin tool · AI → Needs you · Edge Functions

1. Read the card: which feature, how many items are waiting and the age of the oldest, or the giving-up share against its 7-day average. The card splits it by workspace, sequence, reason and prompt version.
2. Check G17 first. If the provider is failing, that is the cause and this card clears when it does.

| If you see | It means | Do this |
|---|---|---|
| Replies stuck in drafting, provider fine | `ai-reply-worker` isn't running or is failing | G7, then G8 |
| Lines waiting in every workspace | `outreach-ai-variables` isn't running, is failing, or is being rate-limited | G8, then G17 |
| Lines waiting in one workspace | Their AI allowance is used up, their key is rejected, or the variable was switched off | §7.2. Contact them |
| Website visitors waiting | A live visitor is looking at a silent chat | G17 first, then G8 for `outreach-webchat` |
| Giving up rose in one workspace, from the hour their prompt version changed | Their new prompt escalates more, or contradicts itself | Read the reasons on the card. Tell the customer what changed |
| Giving up rose in every workspace from the same hour | Our deploy, a model change at the provider, or a check that became too strict | Copy the prompt with the hour and the top reasons |
| Failed rose, escalated stayed flat | The provider, not the prompts | G17 |
| The website assistant is stumped more, in one workspace | Their knowledge is missing the answers | Theirs to fix, in AI → Knowledge. The open questions are listed there |
| More handovers for meetings and bookings | Good news | Nothing. These aren't counted |

#### G19 · Voice calls failing
**From:** `ai-4` · **Open:** ElevenLabs status · ElevenLabs dashboard · Edge Functions

1. Read the card: failed calls by workspace and by end reason, calls still open, agents with a sync error, how long `outreach-voice-tools` took.
2. Open the ElevenLabs status page.

| If you see | It means | Do this |
|---|---|---|
| Calls failing in every workspace, and an incident on the status page | ElevenLabs is down | Nothing. Visitors are moved to text chat by themselves |
| Starts refused for one workspace | Their voice minutes are used up | §7.2 |
| Starts refused as "busy" across workspaces | The platform-wide limit on calls at once was reached | Raise `voice_platform_concurrency`, and the ElevenLabs plan if it is the cap |
| Calls still open 30 min after they started | The post-call record never arrived, and the 5-minute fallback fetch is failing too | G8 for `outreach-elevenlabs-webhook` and `outreach-webchat-worker`. Run `scripts/outreach-elevenlabs-setup.mjs` again |
| `outreach-voice-tools` taking seconds | The agent gives up waiting after 8 seconds and tells the visitor it found nothing | G3. The knowledge search is slow |
| An agent with a sync error | Settings didn't reach ElevenLabs. The live agent keeps its last good settings | Read the error. On a customer's own key, it is their key |
| Errors on one website only | That site or its visitors: microphone blocked, or the page blocks the connection | Contact the customer |
| The call worked but sounded wrong | Health can't see inside a call | Open the call in the ElevenLabs dashboard by its conversation id, shown on the card |

---

## 7. Usage and limits tab

### 7.1 The table

One row per limit, from `ops.limits`. Columns: limit · used · % · reached on (at the last 7 days' rate) · how it's measured · link.

Seed values. **Plan and compute size are chosen once in Health settings**; the table shows the matching column.

| Limit | Free | Pro | Measured by |
|---|---|---|---|
| Database on disk | 500 MB | 8 GB included, then $0.125 per GB | SQL |
| Egress | 5 GB | 250 GB included, then $0.09 per GB | By hand (G15) |
| Edge Function invocations a month | 500,000 | 2 million included, then $2 per million | `ops.fn_stats` |
| Realtime peak connections | 200 | 500 included, then $10 per 1,000 | By hand |
| Realtime messages a month | 2 million | 5 million included, then $2.50 per million | By hand |
| File storage | 1 GB | 100 GB included, then $0.021 per GB | SQL on `storage.objects` |
| Monthly active users | 50,000 | 100,000 included | SQL on `auth.users` |
| Log history | 1 day | 7 days | Fixed |
| Project paused when idle | After 1 week | Never | Fixed |

| Compute size | About per month | Memory | Direct connections | Pooler connections |
|---|---|---|---|---|
| Micro | $10 | 1 GB | 60 | 200 |
| Small | $15 | 2 GB | 90 | 400 |
| Medium | $60 | 4 GB | 120 | 600 |
| Large | $110 | 8 GB, 2 dedicated CPUs | 160 | 800 |

Larger sizes are in Supabase's compute table, linked from the tab.

| Edge Functions | Limit |
|---|---|
| Memory | 256 MB |
| Processing time (CPU) per request | 2 s |
| Total time a run may take | 150 s on Free, 400 s on paid |
| Time to send a response | 150 s |
| Number of functions | 100 on Free, 1,000 on Pro |
| Log line | 10,000 characters; 100 log events per 10 s per function |

| Scheduled jobs | Limit |
|---|---|
| Running at once | 32 (hard). Supabase recommends 8 or fewer |
| Length of one run | Supabase recommends 10 min or less |

| LinkedIn through Unipile, per account | Limit |
|---|---|
| Invitations | 80–100 a day, about 200 a week |
| Profile views | About 100 a day |
| Messages | 100 a day or fewer |

Each row keeps the date it was last checked and a link to its source. The daily email reminds once a month to recheck the Supabase rows, because prices and quotas change.

### 7.2 Customers near their own limits

A second table, from `ops.plans`, `billing_usage`, `outreach__ai_pool(ws)` and `outreach__voice_pool(ws)`: workspaces at 80% or more of their senders, seats, AI allowance or voice allowance. This is a list of customers to talk to about a bigger plan.

The same table marks workspaces whose **AI has stopped**: allowance used up (`outreach__ai_pool(ws)` not ok), voice minutes used up, or their own key rejected (`E_AI_KEY_INVALID`). These never turn a platform check red (D13).

### 7.3 "Do I need to upgrade?"

One answer, worked out once a day by F49 and shown at the top of the page and in the email.

| Answer | When |
|---|---|
| **No** | No rule below is met |
| **Fix first** | A rule below is met, and `db-3` (slow queries), `db-4` (stuck queries) or `db-9` (advisor) is amber or red. The box names the check to fix |
| **Go up one compute size** | With `db-3`, `db-4` and `db-9` green: CPU over 80% for more than an hour, or memory over 85% or swap in use, or connections at 80%, on 3 of the last 7 days |
| **Move from Free to Pro** | The project is on Free and has paying customers, or any Free limit is past 70%. The polling in the specs alone is about 1.3 million invocations a month against 500,000 on Free |
| **Expect a higher bill, no action needed** | A usage limit that only costs money (invocations, egress, Realtime, disk) will pass its included amount this month. The box gives the estimate |

The box always shows its reasons and the numbers behind them, under **How this is decided**.

---

## 8. Stuck users tab

### 8.1 Signals

Counted per workspace, per day.

| # | Signal | From | It usually means |
|---|---|---|---|
| S1 | Signed up over 24 hours ago, no sender connected | `senders` | They didn't understand or trust the LinkedIn login step |
| S2 | Started connecting a sender twice or more and never finished | `sender_events` | The login failed for them: verification code, wrong country |
| S3 | Sequence created, not started after 48 hours | `sequences` | They don't know what's missing before it can start |
| S4 | Sequence started, nothing sent after 24 hours | `actions`, with the reason from `why_not_sending` | Working hours, warm-up or an empty lead list, and they don't know |
| S5 | Opened "Why isn't it sending" three times or more in a day | `ops.product_events` | The explanation there didn't answer them |
| S6 | The same error three times or more in a day | `ops.client_errors` | A bug, and they keep retrying |
| S7 | The same form rejected three times or more | `ops.product_events` | The form's message doesn't say what to fix |
| S8 | An import failed, or brought in no leads | `import_jobs` | Column mapping or the LinkedIn URL format |
| S9 | Sender disconnected over 24 hours, no reconnect attempt | `senders` | They missed the email |
| S10 | Clicked the same control four times or more within two seconds | `ops.product_events` | It looks clickable and does nothing, or it's slow |

### 8.2 What the tab shows

| Block | Content |
|---|---|
| **Who is stuck** | One row per workspace: name, signals, since when, the screen, a link to the workspace in the admin tool. Sorted by number of signals |
| **Where people get stuck** | Screens ranked by stuck signals over the last 7 days, with the number of workspaces affected. This is the list of things to make clearer |
| **What to do** | Per signal: the row from the table above, plus two buttons: **Copy prompt for Claude** (to change the screen) and **Copy a message to the customer** (a short, plain note offering help) |

### 8.3 What the app records

Two calls from the web app, both through one RPC, `report_client_event`, limited to 30 a minute per person.

| Call | When | Stores |
|---|---|---|
| `reportError(error)` | An error boundary catches an error, or a request fails with a 500 | Screen, a fingerprint of the error, the first 300 characters of the message, app version |
| `track(name)` | One of a fixed list of events: `why_not_sending_opened`, `form_rejected`, `rage_click`, `help_opened`, `onboarding_step` | Screen and the event name. For `form_rejected`, the field names that failed, never their values |

This is not general analytics. The list of events is fixed in code and reviewed when it changes. No message text, no lead data, no field values (D7). If Sentry is connected, the card links to the same error there for the full detail.

---

## 9. Emails

### 9.1 Daily email

Sent by F49 through F27 `notify` (Resend), every day at the hour set in Health settings. First value: 09:00, Asia/Kolkata. Recipients are set in Health settings.

**Subject** carries the verdict:

```
Health · all fine · 7 Oct
Health · 2 to watch · 7 Oct
Health · ACT NOW · sends are failing · 7 Oct
```

**Body:**

```
1 needs action · 2 to watch · 31 fine · 1 couldn't check

NEEDS ACTION
● Sends failing — 18% of sends failed in the last hour (limit 15%)
  Most are "429 too many requests" from Unipile on 6 senders.
  [See the steps]

TO WATCH
● Database connections — 72% in use (act at 80%)          [See the steps]
● worker-imports took 210 s (limit 400 s)                  [See the steps]

DO I NEED TO UPGRADE?
Not yet. Fix first: slow queries.                          [Why]

YESTERDAY                          Yesterday    7-day average
Messages and invites sent              4,120        3,870
Replies received                         212          198
Sends that failed                       2.1%         1.4%
Function runs                         43,300       43,100
Function runs that failed                 37           12
Slowest function                 worker-imports, 210 s
Unipile calls that failed               0.8%         0.5%
New workspaces                             3            2
AI calls                               9,400        9,100
AI calls that failed                    0.4%         0.3%
AI answers we couldn't use              1.1%         0.9%
AI replies sent                          310          295
AI replies passed to a person             42           38

USAGE THIS MONTH
Database on disk       3.3 GB of 8 GB      41%     85% around 14 Feb
Function invocations   0.3 M of 2 M        15%     on track for 1.3 M
AI spend               $41 of $150         27%

STUCK USERS (2)
Acme Agency — sequence started, nothing sent for 2 days    [Open]
Northwind — started connecting a sender 3 times            [Open]

NEW SINCE YESTERDAY: Sends failing
FIXED SINCE YESTERDAY: Queues backing up

34 of 35 checks ran. Couldn't check: Supabase advisor findings. Snoozed: none.
```

Rules:
- **See the steps** opens the Health page on that card with Look closer open (`?check=<key>`).
- No more than five items per section, then "and 3 more".
- Plain text and simple HTML. Readable on a phone.
- The email holds no customer message text and no lead names.
- Once a week it adds one line: "Egress and Realtime numbers are 9 days old. Update them." with the link to G15.

### 9.2 Urgent email

Sent by F48 for the checks marked **Imm.** or **Urgent** in §4, and for `sys-1`.

| Rule | Value |
|---|---|
| When | The check turns red |
| Again | After 4 hours if still red |
| Recovered | One email when it goes green |
| Several at once | One combined email |
| Subject | `ACT NOW · sends are failing · 18% in the last hour` |
| Body | The card's lines, the evidence, **See the steps** |
| AI provider outage | The email also says what it affected: AI replies that failed and lines that used their fallback, by workspace |
| Off switch | Health settings. Snoozing a check silences it |

---

## 10. Data

Migration `0NN_health`. All tables are in `ops`. Clients have no access to them; the page reads through `security definer` RPCs that call the platform-admin check first.

```sql
create table ops.health_checks (
  key            text primary key,              -- 'db-2'
  area           text not null,                 -- database|jobs|functions|flow|services|ai|app|system
  name           text not null,
  question       text not null,
  unit           text,                          -- '%', 'count', 'seconds', 'ms'
  watch_at       numeric,
  act_at         numeric,
  immediate      boolean not null default false,   -- red at once, and the urgent email
  urgent         boolean not null default false,   -- the urgent email after two checks in a row
  guide          text not null,                 -- 'G2'
  source         text not null,                 -- sql|metrics|logs_api|advisors|manual
  every_minutes  int  not null default 5,
  enabled        boolean not null default true,
  snoozed_until  timestamptz,
  snooze_reason  text
);

create table ops.health_state (                 -- one row per check: what the page reads
  check_key   text primary key references ops.health_checks(key),
  status      text not null check (status in ('ok','watch','act','unknown')),
  since       timestamptz not null,
  value       numeric,
  summary     text,                             -- the one-sentence cause
  evidence    jsonb,                            -- top rows shown under Look closer
  pending     text,                             -- status seen once, waiting for the second check
  last_run_at timestamptz,
  alerted_at  timestamptz
);

create table ops.health_results (               -- history for the 7-day line; kept 14 days
  id bigserial primary key,
  check_key text not null, at timestamptz not null default now(),
  value numeric, status text not null
);
create index on ops.health_results (check_key, at desc);

create table ops.health_daily (                 -- one row per check per day; kept for good
  day date, check_key text, value numeric, worst_status text,
  primary key (day, check_key)
);

create table ops.fn_stats (                     -- one row per function per 5 minutes; kept 30 days
  fn text, bucket timestamptz,
  runs int not null default 0, failed int not null default 0, slow int not null default 0,
  total_ms bigint not null default 0, max_ms int not null default 0, items int not null default 0,
  primary key (fn, bucket)
);
create table ops.fn_problems (                  -- failures and slow runs only; kept 14 days
  id bigserial primary key, fn text not null, at timestamptz not null default now(),
  outcome text not null, duration_ms int, error_code text, error_text text, workspace_id uuid
);
create table ops.fn_config (                    -- what "slow" means for each function
  fn text primary key, cron_job text, slow_ms int not null default 5000
);

create table ops.api_stats (                    -- one row per provider and call per 5 minutes; kept 30 days
  provider text, endpoint_group text, bucket timestamptz,
  calls int not null default 0, failed int not null default 0,
  rate_limited int not null default 0, auth_failed int not null default 0,
  total_ms bigint not null default 0, max_ms int not null default 0,
  primary key (provider, endpoint_group, bucket)
);
create table ops.api_problems (                 -- failures only; kept 14 days
  id bigserial primary key, provider text not null, endpoint_group text, at timestamptz not null default now(),
  status int, error_code text, error_text text, duration_ms int, fn text, workspace_id uuid
);

create table ops.query_snapshots (              -- hourly copy of the top 100 queries; kept 7 days
  at timestamptz, queryid bigint, query text, calls bigint, total_ms double precision,
  primary key (at, queryid)
);
create table ops.size_snapshots (               -- daily size of the 20 biggest tables; kept 400 days
  day date, schema_name text, table_name text, bytes bigint,
  primary key (day, schema_name, table_name)
);

create table ops.client_errors (                -- kept 30 days
  id bigserial primary key, at timestamptz not null default now(),
  user_id uuid, workspace_id uuid, route text, fingerprint text, message text, app_version text
);
create table ops.product_events (               -- kept 30 days
  id bigserial primary key, at timestamptz not null default now(),
  user_id uuid, workspace_id uuid, name text not null, route text, detail jsonb
);

create table ops.limits (
  key text primary key, grp text not null, label text not null,
  limit_value numeric, unit text, plan text, note text,
  used_manual numeric, used_manual_at timestamptz,    -- for the three by-hand numbers
  source_url text, checked_on date
);

create table ops.health_settings (              -- one row
  id boolean primary key default true check (id),
  supabase_plan text not null default 'pro', compute_size text not null default 'micro',
  email_to text[] not null default '{}', email_hour int not null default 9,
  time_zone text not null default 'Asia/Kolkata',
  urgent_email boolean not null default true, ai_monthly_budget_usd numeric
);
```

```sql
alter table ai_calls
  add column outcome     text check (outcome in
    ('ok','provider_error','timeout','empty','cut_off','refused','bad_format')),
  add column http_status int,
  add column attempts    smallint not null default 1,
  add column own_key     boolean  not null default false;
create index on ai_calls (at desc, purpose) where outcome is distinct from 'ok';
```

**SQL functions**

| Function | Purpose |
|---|---|
| `ops.health_run()` | Runs every check whose source is `sql`, applies the two-in-a-row rule, writes `health_state` and `health_results` |
| `ops.run_done(payload jsonb)` | Called by the wrapper. Adds to `fn_stats` and `api_stats`; writes problem rows |
| `ops.health_record(key, value, summary, evidence)` | Used by F48 and F49 to write results from outside sources through the same status rules |
| `report_client_event(kind, name, route, detail)` | From the web app. Checks the rate limit and the fixed event list |
| `health_overview()`, `health_check(key)`, `health_usage()`, `health_stuck()` | What the page reads |
| `health_snooze(key, until, reason)`, `health_set_threshold(key, watch_at, act_at)`, `health_settings_set(…)`, `health_set_manual_usage(key, value)`, `health_run_now()` | What the page writes. Each writes to `audit_log` |

**Clean-up.** Add to the existing 04:00 `cleanup` job: delete past the periods above, and **delete `cron.job_run_details` rows older than 7 days**. With jobs running every 10 and 15 seconds that table gains about 40,000 rows a day and nothing removes them today.

**Secrets in Vault:** the Management API token (read-only permissions: `analytics_logs_read`, `advisors_read`), the secret API key for the metrics endpoint, and the project ref.

---

## 11. Functions and schedule

| # | Function | Runs | Purpose |
|---|---|---|---|
| — | `ops.health_run()` | pg_cron, every 5 min, no Edge Function | All database-only checks (D3) |
| F48 | `health-collect` | cron, every 5 min | Reads the metrics endpoint and the logs API, records results, sends urgent emails |
| F49 | `health-daily` | cron, hourly; acts once a day at the set hour | Advisors, daily snapshot, projections, the upgrade answer, stuck users, the daily email |
| F50 | `health-ping` | public HTTP, no login | Returns `ok` if `ops.health_run()` ran in the last 15 min, otherwise `stale`. Returns nothing else. For an outside uptime monitor (§12, step 3) |
| — | `_shared/health.ts` | in every function | `withHealth`, `fetchWithHealth`, `recordCall` (§5.1) |
| — | `_shared/outreach/ai.ts` | existing AI helper | Records each AI call's outcome (§5.2) |
| — | `scripts/check-health-coverage` | on every deploy | Fails the build when a call skips the measuring (§5.1) |

```sql
select cron.schedule('health-run',     '*/5 * * * *', $$select ops.health_run()$$);
select cron.schedule('health-collect', '*/5 * * * *', $$select ops.invoke('health-collect')$$);
select cron.schedule('health-daily',   '30 * * * *',  $$select ops.invoke('health-daily')$$);
```

Added load: about 9,400 function invocations a month, and one database write per function run.

---

## 12. Rollout

| Step | What ships | You can then answer |
|---|---|---|
| **1** | Tables, the wrapper in every function, the build check, the AI helper recording outcomes, `ops.health_run()` with the AI checks, the page with the Now tab, Look closer with all guides, Copy prompt, Usage and limits with by-hand numbers, the daily email, F48 sending urgent emails, the `cron.job_run_details` clean-up | Is anything failing or slow? Which function, which provider, which job? Is the AI answering, usably, and on time? Is the database filling up? What are my limits? Tell me straight away when something breaks |
| **2** | F48 gains the metrics endpoint and logs API; advisors; the upgrade answer | Is the database short of CPU or memory? Should I upgrade? |
| **With voice** | `ai-4` and G19 | Are voice calls failing? |
| **3** | Error and event reporting from the web app, the Stuck users tab, `health-ping` and an outside uptime monitor pointed at it | Who is confused, and on which screen? Tell me even when Supabase itself is down |

Step 3's outside monitor matters for one reason: everything in steps 1 and 2 runs inside Supabase. If the whole project is down, nothing inside it can send an email.

---

## 13. Acceptance tests

| # | Test | Pass when |
|---|---|---|
| 1 | Make a function throw on every run for 10 min | `fn-1` turns amber then red, names the function and the error text; the daily email lists it; Copy prompt contains the error |
| 2 | Disable the `tick` job for 4 min | `job-1` is red within 5 min and the urgent email arrives once |
| 3 | Stop `process-inbound` and send 600 test events | `flow-1` is red; G9's first row matches what the card shows |
| 4 | Make Unipile calls return 401 in staging | `api-3` is red on the first check, with no two-in-a-row wait |
| 5 | Make the Management API token invalid | `db-9`, `fn-4`, `app-2` are grey with a link. None is green |
| 6 | Stop `health-run` for 20 min | The red banner shows; `health-ping` returns `stale` |
| 7 | Make a function fail inside `ops.run_done` | The function still completes its work |
| 8 | Sign in as a workspace owner who is not a platform admin | The page and every Health RPC refuse |
| 9 | Search every `ops` Health table after a day of use for a marker string placed in a message and a lead name | Not found |
| 10 | Open every link in §6.2 and follow every step in §6.3 against the live screens | Each lands on the named screen; labels in the guides match; `checkedOn` is updated |
| 11 | Snooze a red check for 7 days | It leaves the top line, shows under Snoozed, and the email footer lists it |
| 12 | Run a day with nothing wrong | The email still arrives, with "all fine" in the subject |
| 13 | Open `/product-tour` | No Health entry, no Health request |
| 14 | In staging, make the AI provider return 503 on the platform key for 15 min | `api-1.ai` turns red and one urgent email arrives, listing the AI replies that failed, by workspace |
| 15 | Make one workspace's own AI key invalid | No platform check changes. The workspace shows in §7.2 as "AI has stopped" |
| 16 | In staging, set the length limit for `ai_fields` to 50 | `ai_calls.outcome` is `cut_off`, and `ai-1` turns amber naming `ai_fields` |
| 17 | Stop `ai-reply-worker` with runs in `drafting` | `ai-2.replies` is amber at 5 min and red at 15 |
| 18 | Hand over 30 conversations for `meeting_confirmed` in a day | `ai-3.replies` doesn't move |
| 19 | Add a direct `fetch` to the AI provider in a new function and deploy | The build check fails and names the file |
| 20 | In staging, remove `withHealth` from one scheduled function for a day | `sys-2` turns amber naming the function |
| 21 | End one test voice call with an error and block the post-call record for another | `ai-4` counts the first and lists the second as still open after 30 min |

---

## 14. Not in this version

| Left out | Why |
|---|---|
| Recordings of user sessions | A separate tool and a privacy decision. The stuck signals answer "who and where" without it |
| Automatic fixes | D10 |
| Slack or phone alerts | Email first. See open question 1 |
| A customer-facing status page | This page is internal |
| Tracing one request end to end inside the Health page | Supabase's Logs view already does it. G13 links there |
| Judging whether an AI answer is good: right facts, right tone | Health checks that an answer arrived and could be used. Review mode and spot checks judge what it says |
| Running failed AI replies again automatically after an outage | D10. The card lists them by workspace and a person decides |
| Anything inside a voice call: sound quality, delay, what was said | It runs between the visitor's browser and ElevenLabs. G19 links to the call there |

---

## 15. Open questions

| # | Question | Default if unanswered |
|---|---|---|
| 1 | Urgent alerts by email only, or also to Slack or WhatsApp? | Email only |
| 2 | Which Supabase plan and compute size is the project on now? | Set once in Health settings; the seed assumes Pro, Micro |
| 3 | Egress and the two Realtime numbers have no documented API. Type them in weekly, or leave them out? | Type them in; the email reminds weekly |
| 4 | Who else gets the daily email? | You only |
| 5 | Is Sentry connected in the build? | Health works without it; the link shows only if it is |
| 6 | Which AI providers does the build call, and does each SDK accept a custom `fetch`? | The builder lists them in the build check. Any that doesn't goes through `recordCall` |
| 7 | Should an AI provider outage also show customers a notice in the app? | No. Internal only in this version |

---

## Sources

- [New observability features in Supabase](https://supabase.com/blog/new-observability-features-in-supabase)
- [Supabase observability overview](https://supabase.com/docs/guides/observability)
- [Detection checks](https://supabase.com/docs/guides/observability/detecting)
- [Inspect the database](https://supabase.com/docs/guides/observability/inspect)
- [Reports](https://supabase.com/docs/guides/observability/reports)
- [Logs in Studio](https://supabase.com/docs/guides/observability/logs)
- [Advisors](https://supabase.com/docs/guides/observability/advisors)
- [Metrics API](https://supabase.com/docs/guides/observability/metrics) and [vendor-agnostic setup](https://supabase.com/docs/guides/observability/metrics/vendor-agnostic)
- [Agent prompts: resources](https://supabase.com/docs/guides/observability/automate-with-agents/usage)
- [Management API: get project logs](https://supabase.com/docs/reference/api/v1-get-project-logs)
- [Management API: performance advisors](https://supabase.com/docs/reference/api/v1-get-performance-advisors)
- [Management API: usage API counts](https://supabase.com/docs/reference/api/v1-get-project-usage-api-count)
- [Edge Function status codes](https://supabase.com/docs/guides/functions/status-codes.md)
- [Edge Function logging](https://supabase.com/docs/guides/functions/logging.md)
- [546 error](https://supabase.com/docs/guides/troubleshooting/edge-function-546-error-response.md)
- [Cron](https://supabase.com/docs/guides/cron.md) and [pg_cron debugging guide](https://supabase.com/docs/guides/troubleshooting/pgcron-debugging-guide-n1KTaz)
- [Compute and disk](https://supabase.com/docs/guides/platform/compute-and-disk)
- [Billing on Supabase](https://supabase.com/docs/guides/platform/billing-on-supabase.md)
- [Manage egress usage](https://supabase.com/docs/guides/platform/manage-your-usage/egress)
