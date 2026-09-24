# Outreach platform — operator runbook

Multi-sender LinkedIn/email outreach (Unipile-backed) built inside the CapitalxAI Next.js app and the CapitalxAI Supabase project `ktwqkvjuzsunssudqnrt`. This document is for whoever operates it: first-time setup, how the automation runs, what to do when it does not, and how to look inside.

PRD: `linkedin-outreach-platform-PRD.md` (repo root). Product plan: `outreach-product-plan.md`. Frontend conventions: [FRONTEND-BRIEF.md](FRONTEND-BRIEF.md). SQL API and metric definitions: [SQL-REFERENCE.md](SQL-REFERENCE.md). Public API: [API.md](API.md). Extension install guide for senders: [EXTENSION-UNPACKED-INSTALL.md](EXTENSION-UNPACKED-INSTALL.md). Billing and refund policy draft: [POLICIES.md](POLICIES.md).

**Switching on billing, email, CRM sync, custom domains and the other product-plan features: go to [§9 Switch-on checklist](#9-switch-on-checklist-product-plan-phase-1-and-later).**

---

## 1. Architecture overview

```
 Browser (Next.js /outreach/*)                       Chrome extension (extension/)
   │  PostgREST (RLS)  + supabase.rpc('outreach_*')     │  POST outreach-cookie-sync  (Bearer sender token)
   │  callFn('name') → POST outreach-<name>  (user JWT) │
   ▼                                                    ▼
 Supabase edge functions  outreach-*  (Deno, supabase/functions/outreach-*/index.ts, shared code in _shared/outreach/)
   │  service-role client → outreach_* tables + outreach_* SQL functions (ledger, enrollment engine)
   │  Unipile REST (X-API-KEY)   Gemini   Stripe   Resend
   ▲
   │  pg_cron  →  outreach_invoke(name)  →  pg_net POST  (x-cron-secret from Vault)
 Postgres   (public schema, every object prefixed outreach_)
   ▲
   │  Unipile webhooks → outreach-unipile-webhook → outreach_inbound_events (queue table) → outreach-process-inbound
   │  Unipile hosted-auth notify → outreach-sender-notify
   │  Stripe → outreach-stripe-webhook
```

### 1.1 Web app
* Pages live under `app/outreach/**` (client components) wrapped by `app/outreach/layout.tsx` (auth, workspace context, TanStack Query, realtime).
* `lib/outreach/api.ts`: `callFn(name, body)` calls edge function `outreach-<name>` with the user's JWT; `rpc(name, args)` calls SQL `outreach_<name>`.
* Reads go through PostgREST with RLS; writes go through RPCs (`security definer`) or edge functions.

### 1.2 SQL engine (`migrations/outreach/`)
| File | Contents |
|---|---|
| `001_schema.sql` | extensions (pgcrypto, pg_cron, pg_net, citext, supabase_vault), enums, all `outreach_*` tables, private storage buckets `outreach-attachments`, `outreach-exports`, `outreach-imports` |
| `002_functions.sql` | every `outreach_*` function: RLS helpers, ledger (`plan_budgets`, `reserve_budget`, …), graph validation, enrollment engine (`enter_node`, `advance_enrollment`), claim/complete/fail, sequences / enrollments / tasks / workspace / senders / leads APIs, planner + health inputs, `outreach_dashboard`, `outreach_invoke`, grants |
| `003_triggers_rls.sql` | triggers (reply → exit, relation → advance, enrollment exit → cancel actions, sender status transitions, suppression → exit, node stats, chat rollup), RLS enable on all tables + policies, storage policies |
| `004_seed_cron.sql` | platform ceilings, warmup caps, flags, Vault secret `outreach_cron_secret`, realtime publication, pg_cron jobs. Placeholders `__FUNCTIONS_BASE_URL__` / `__CRON_SECRET__` are substituted by the apply script |
| `005_patches.sql` | `outreach_consume_budget`, grant tightening, `outreach_lead_timeline`, `outreach_client_stats`, `outreach_sequence_summary` |
| `006_rpc_hardening.sql` / `007_intent_override.sql` | membership checks on read RPCs (`outreach_effective_cap_checked`), `outreach_set_intent` |
| `008_agent_mcp.sql` | MCP agent layer: `outreach_agent_confirmations` / `_previews` / `_drafts` / `_calls` (service-role only), `outreach_agent_gc`, and manager RPCs for in-flight edits `outreach_agent_node_queued_actions`, `outreach_agent_set_action_text`, `outreach_agent_reschedule_delay` |
| `009_enums_v2.sql` | product plan: new enum values only (action types `post_fetch`, `follow`, `find_email`; import kinds; task kinds). **Must be applied before 010+, as its own call** (§9.5) |
| `010_schema_v2.sql` | product plan: new columns and tables, RLS, realtime |
| `011_engine_v2.sql` | reply stop everywhere, hold, out-of-office resume, version pinning, A/B variants, new node types, InMail guard, message attribution triggers |
| `012_editing_recovery_enrol.sql` | draft / publish, queued edits, failed-lead recovery, rebalance, scoped blacklists, the enrol plan, auto-enrol rules |
| `013_reports.sql` | the one definition of every metric, daily rollup, report functions, stall detection, `why_not_sending`, dashboard |
| `014_intelligence.sql` | enrichment, render context, AI variables and review, AI routing queue, thread attribution, lead timeline |
| `015_platform.sql` | API keys and dispatch, CRM plumbing, branding and portal domains, booking, email depth, lead sources, `outreach_resume_after_billing` |
| `016_seed_cron_v2.sql` | ceilings and warm-up caps for the new action types, flag `portal_cname_target`, 9 new cron jobs (§9.3), report schedule defaults |
| `017_hardening.sql` | grants and `search_path`: no outreach function is executable by `anon` except the three that work before login. Re-run after adding functions |
| `018_scope_hardening.sql` | access audit (21 Sep 2026): internal helpers (`outreach_effective_cap`, `outreach_ws_tz`, `outreach_audit`, …) are no longer executable by signed-in users — only `SECURITY DEFINER` RPCs call them. Must run **after** 017 |

**Rule for every RPC that takes an id:** `outreach_require()` proves workspace membership only. A member or client viewer can be limited to some clients (`outreach_members.client_ids`), so right after it check `outreach_client_visible(ws, <the row's client>)` — enrollment → its sequence's client, queued action → its sender's, AI line → its lead's, task → its own — the same rule the RLS policies use. `tests/smoke_04_access_scope.sql` calls the id-taking RPCs as an outsider, a restricted viewer and a restricted member, and its last check fails if any viewer/member RPC has no client check at all.

Internal/ops/secret tables (`outreach_sender_secrets`, `outreach_sender_tokens`, `outreach_inbound_events`, `outreach_plans`, `outreach_flags`, `outreach_rate_limits`, …) sit in `public` with RLS **enabled and no policies**, so only the service role (edge functions, SQL editor) can touch them.

### 1.3 Edge functions (all deployed with `--no-verify-jwt`)
The table lists the original 29. The 10 added by the product plan (`outreach-worker-enrich`, `outreach-ai-variables`, `outreach-crm-sync`, `outreach-crm-oauth`, `outreach-worker-reports`, `outreach-domain-check`, `outreach-booking-webhook`, `outreach-unsubscribe`, `outreach-workspace-secrets`, `outreach-api`) are in §9.5. The catalogue in `scripts/outreach-deploy-functions.sh` is the full list.

| Function | Trigger | Auth (in code) | Purpose |
|---|---|---|---|
| `outreach-unipile-webhook` | Unipile → HTTP | header `unipile-auth` == `UNIPILE_WEBHOOK_SECRET` | persist raw event to `outreach_inbound_events`, ack |
| `outreach-sender-notify` | Unipile hosted-auth `notify_url` | sender id in `name`/`?sid=` must exist | bind `unipile_account_id`, sync profile, onboarding gate |
| `outreach-cookie-sync` | Chrome extension | `Bearer <sender_token>` (sha256 in `outreach_sender_tokens`), 1/10 min/sender | encrypt + store `li_at`/`li_a`, switch to cookie mode, reconnect if in `credentials` |
| `outreach-stripe-webhook` | Stripe → HTTP; also web | Stripe signature; or user JWT (owner) for `{action:'checkout'|'portal'}` | subscription lifecycle → `outreach_workspaces.plan`; checkout / portal links |
| `outreach-process-inbound` | cron 10 s | `x-cron-secret` | dispatch inbound events (account status, messaging, new_relation, mail, tracking, hosted notify); dead-letter after 5 attempts |
| `outreach-worker-tick` | cron 1 min | cron | `release_waits`, `claim_due_actions(200)`, execute via Unipile, `complete_action` / `fail_action`, fill pending AI drafts; skips when flag `tick_enabled=false` or lock held |
| `outreach-worker-planner` | cron hourly (`nightly`, senders at local 00:xx) + every 20 min (`{"mode":"topup"}`) | cron | budgets + jittered action slots; skips when `planner_enabled=false` |
| `outreach-worker-health` | cron hourly (senders at local 02:xx); `{sender_id}` or `{all:true}` on demand | cron | health score, pause `<50`, warmup level-up. Every run also calls `outreach_detect_stalls()` and emails new stall, running-dry and failed-import alerts; the nightly branch writes the daily `snapshot` sender event (connections count) |
| `outreach-worker-reconnect` | cron 15 min | cron | cookie-mode reconnect (≤4 attempts, 1 h apart) then manual-reconnect emails; credentials-mode reminder emails |
| `outreach-worker-imports` | cron 5 min | cron | advance `search_url` / `csv` / `relations` import jobs under `search_page` budget |
| `outreach-worker-withdraw` | cron hourly | cron | once per sender-day (local 10:00–16:00) queue withdrawals for stale `pending_out` invites |
| `outreach-worker-relations-poll` | cron hourly | cron | ≤3 runs/day/sender for no-note invites: diff `invite/sent`, verify via profile fetch |
| `outreach-outbound-webhooks` | cron 30 s | cron | deliver `outreach_outbound_webhook_deliveries` with `x-signature` HMAC, 5 attempts, disable webhook after 50 failures |
| `outreach-billing-sync` | cron daily 03:15 UTC | cron | usage rows, past-due (7 d) / trial-expiry suspension, Stripe quantities |
| `outreach-ai-classify` | cron 15 s | cron | consume `outreach_ai_classify_queue` → intent + summary, follow-up tasks |
| `outreach-ai-draft` | web (JWT) or cron | JWT (member) / cron | draft for a review task, ad-hoc draft, or fill pending drafts |
| `outreach-sender-connect` | web | JWT, manager | insert sender row, Unipile hosted-auth link (trial: max 3 senders) |
| `outreach-sender-update-proxy` | web | JWT, manager | PATCH Unipile account proxy country / custom proxy |
| `outreach-sender-disable` | web | JWT, manager | disable, optional Unipile delete + secret purge |
| `outreach-sender-manage` | web | JWT, manager | `reconnect_link`, `reconnect_cookie`, `resync`, `checkpoint`, `refresh_profile`, `backfill_inbox`, `recompute_health`, `plan_now`, `account_status` |
| `outreach-send-reply` | web | JWT, `can_reply` + client visibility | inbox reply (LinkedIn chat or email thread) recorded as `reply` action |
| `outreach-edit-message` | web | JWT, `can_reply` | edit / delete a sent LinkedIn message within 60 min |
| `outreach-attachment-proxy` | web (GET) | JWT, client visibility | stream attachment from Unipile / storage |
| `outreach-ai-sequence-qa` | web | JWT, manager | `outreach_validate_graph(strict)` + LLM warnings |
| `outreach-imports-create` | web | JWT, member | validate + create import job (`dry_run` for estimate) |
| `outreach-exports-create` | web | JWT, manager | CSV to `outreach-exports`, signed URL (1 h) |
| `outreach-invite-member` | web | JWT, owner | create/resend invitation + email |
| `outreach-unipile-setup` | web | JWT, owner | configuration status + register platform-level Unipile webhooks |
| `outreach-mcp` | Claude / MCP clients (Streamable HTTP at `/outreach-mcp/mcp`) | Supabase OAuth 2.1 bearer (same flow as `capitalxai-mcp`; `.well-known/oauth-protected-resource` public) → RLS-scoped client per call | remote MCP connector: ~60 tools by role (senders, leads, sequences, enrolments, inbox draft→approve→send, tasks, reports, `why_not_sending`), resources (`outreach://safety/policy`, …) and prompts. Skill: `claude-skill/outreach/`. Spec: `outreach-mcp-PRD.md` |

Shared modules (`supabase/functions/_shared/outreach/`): `supabase.ts` (client, CORS, `serve`, `requireUser`, `requireCron`, `rpc`, `rateLimit`, `flag`), `unipile.ts` (typed client), `errors.ts` (Unipile error → decision table), `execute.ts` (action execution), `planner.ts`, `health.ts`, `inbound.ts` (webhook handlers), `workers.ts` (reconnect / imports / withdraw / poll / webhooks / classify / billing), `drafts.ts`, `ai.ts` + `prompts.ts`, `notify.ts` (Resend), `crypto.ts` (AES-GCM cookies, HMAC), `render.ts` (templates).

### 1.4 pg_cron jobs (`outreach-*`, from `004_seed_cron.sql`; the 9 jobs added by `016_seed_cron_v2.sql` are in §9.3)
| Job | Schedule | Runs |
|---|---|---|
| `outreach-tick` | `* * * * *` | `outreach_invoke('outreach-worker-tick')` |
| `outreach-inbound` | every 10 s | `outreach-process-inbound` |
| `outreach-ai-classify` | every 15 s | `outreach-ai-classify` |
| `outreach-planner` | `5 * * * *` | `outreach-worker-planner` (nightly) |
| `outreach-planner-topup` | `*/20 * * * *` | `outreach-worker-planner` `{"mode":"topup"}` |
| `outreach-health` | `20 * * * *` | `outreach-worker-health` |
| `outreach-reconnect` | `*/15 * * * *` | `outreach-worker-reconnect` |
| `outreach-imports` | `*/5 * * * *` | `outreach-worker-imports` |
| `outreach-withdraw` | `40 * * * *` | `outreach-worker-withdraw` |
| `outreach-relations-poll` | `50 * * * *` | `outreach-worker-relations-poll` |
| `outreach-outbound-hooks` | every 30 s | `outreach-outbound-webhooks` |
| `outreach-billing` | `15 3 * * *` | `outreach-billing-sync` |
| `outreach-sweep` | `*/5 * * * *` | `select outreach_sweep_stale_reservations()` (SQL only) |
| `outreach-cleanup` | `0 4 * * *` | deletes processed inbound events > 30 d, delivered webhook rows > 30 d, expired rate-limit rows, audit > 90 d, `cron.job_run_details` > 7 d |
| `outreach-agent-gc` | `10 4 * * *` | `select outreach_agent_gc()` — expired MCP confirmation/preview/draft tokens, agent call log > 90 d (from `008_agent_mcp.sql`) |

---

## 2. One-time setup (in this order)

### 2.0 Prerequisites
* Supabase CLI, `curl`, `python` (3.x), `bash` (Git Bash on Windows works).
* `CAPITALXAI_SUPABASE_ACCESS_TOKEN` — a Supabase personal access token (`sbp_…`) **with access to project `ktwqkvjuzsunssudqnrt`**. The account the CLI is logged in with locally may be a different one and get `403`; the scripts pass this token explicitly.
* A Unipile account (DSN + API key), and optionally Gemini, Stripe and Resend keys.

Generate the platform secrets once and keep them in a password manager:
```bash
openssl rand -hex 32      # OUTREACH_CRON_SECRET
openssl rand -base64 32   # OUTREACH_COOKIE_KEY (must decode to exactly 32 bytes)
openssl rand -hex 32      # UNIPILE_WEBHOOK_SECRET
```

### 2.1 Apply migrations
```bash
export CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_...
export OUTREACH_CRON_SECRET=<the value generated above>
./scripts/outreach-apply-migrations.sh                                   # 001 → 018, in order, one API call per file
./scripts/outreach-smoke.sh                                              # SQL smoke tests; each must print PASS
```
The script substitutes `__FUNCTIONS_BASE_URL__` (`https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/`) and `__CRON_SECRET__` into `004_seed_cron.sql`, which writes the flag `functions_base_url` and the Vault secret `outreach_cron_secret`, and (re)schedules every `outreach-*` cron job. Re-running is safe: all files are idempotent (`create or replace`, `on conflict`, unschedule-by-name first).

Verify:
```sql
select jobname, schedule, active from cron.job where jobname like 'outreach-%' order by 1;
select key, value from outreach_flags;
select name from vault.secrets where name = 'outreach_cron_secret';
select count(*) from outreach_platform_ceilings;   -- 16 (13 from 004 + post_fetch, follow, find_email from 016)
```
Ad-hoc SQL: `./scripts/outreach-sql.sh file.sql` (Management API `/database/query`).

### 2.2 Set secrets
```bash
cp .env.example .env.local     # git-ignored; skip if you already have one
# fill in section 2 (edge function secrets), then:
./scripts/outreach-set-secrets.sh --dry-run   # shows key names only
./scripts/outreach-set-secrets.sh
```
`OUTREACH_CRON_SECRET` here **must equal** the one used in 2.1 (Vault). Empty keys are skipped. Secrets apply on the next function invocation.

### 2.3 Deploy functions
```bash
./scripts/outreach-deploy-functions.sh                       # every function in the catalogue that exists in this checkout
./scripts/outreach-deploy-functions.sh worker-tick planner   # subset
```
Everything is deployed `--no-verify-jwt` (see the comment block in the script for why). Smoke test:
```bash
curl -s https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-unipile-webhook   # {"ok":true,"fn":"outreach-unipile-webhook"}
curl -s -X POST https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-worker-tick -H "x-cron-secret: $OUTREACH_CRON_SECRET"
```

### 2.4 Register Unipile webhooks
In the app (workspace **owner**): **Settings → Workspace → Platform setup**. The status panel shows which secrets are present (`unipile`, `webhook_secret`, `cookie_key`, `cron_secret`, `ai`, `resend`, `stripe`, `stripe_webhook`) and the webhook URL; **Register** creates the platform-level webhooks. Equivalent call: `callFn('unipile-setup', { workspace_id, action: 'register' })`.

It registers one webhook per source, all pointing at `…/functions/v1/outreach-unipile-webhook` with header `Unipile-Auth: <UNIPILE_WEBHOOK_SECRET>`, named `capitalxai-outreach-<source>`:

| source | events |
|---|---|
| `account_status` | creation_success, creation_fail, deleted, reconnected, sync_success, stopped, ok, connecting, error, credentials, permissions |
| `messaging` | message_received, message_edited, message_deleted |
| `users` | new_relation |
| `email` | mail_received, mail_sent |
| `email_tracking` | mail_opened, mail_link_clicked |

Existing webhooks with the same source and URL are kept, so Register is idempotent. The hosted-auth callback (`outreach-sender-notify?sid=<sender>`) is passed per link and needs no registration.

### 2.5 Stripe
1. Create recurring **per-seat** prices: team sender, agency sender, agency-plus sender, mailbox add-on. Give them `lookup_key`s containing `agency_plus`, `agency`, `team` and `mailbox` — `planFromSub()` maps a subscription to a plan by `lookup_key` / `nickname` regex or by equality with `STRIPE_PRICE_*`, and `billing-sync` picks the mailbox item by `/mailbox/i`.
2. Put the price ids in `.env.local` (`STRIPE_PRICE_TEAM_SENDER`, …) and re-run the secrets script.
3. Add a webhook endpoint **`https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-stripe-webhook`** with events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`.
   Copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Checkout sessions created by the function carry `client_reference_id` and `metadata.workspace_id`, which is how events are matched to a workspace (fallback: `stripe_customer_id`).

Plan effects: `active`/`trialing` → plan from prices, un-suspend senders paused for billing; `past_due`/`unpaid` → `past_due_since` set, suspended by `billing-sync` after 7 days (senders paused with `status_reason='billing_suspended'`); `canceled`/deleted → `plan='suspended'`. Trial workspaces (14 days, max 3 senders) are suspended by `billing-sync` when the trial ends without a subscription.

### 2.6 Resend
Verify the sending domain in Resend, set `RESEND_API_KEY` and `OUTREACH_EMAIL_FROM` (e.g. `CapitalxAI Outreach <no-reply@capitalxai.com>`). Without a key the functions log `RESEND_API_KEY unset` and continue. The full list of emails (sender notices, invitation, stall and running-dry alerts, weekly sender report, digest, client reports) and how to verify each is in §9.2.

### 2.7 Gemini (AI)
`GEMINI_API_KEY` + optional `OUTREACH_AI_MODEL` (default `gemini-3-flash-preview`, falling back to `GEMINI_MODEL_ID`). This is the same key and model family the rest of the app uses (`utils/azureOpenAiHelper.ts`), called over the REST `generateContent` endpoint: system instruction separated, `thinkingLevel: MEDIUM` + `responseMimeType: application/json` for the JSON tasks, thought parts skipped, markdown fences stripped. Every call is recorded in `outreach_ai_calls` (hashes + token counts) and audited. Without a key: replies are stored as `unclear` (confidence 0), sequence QA returns static checks only (`ai_available:false`), AI drafts cannot be generated.

### 2.8 Chrome extension
Ship `extension/` unpacked (developer notes: `extension/README.md`). Zip the folder and send it to the account holder together with [EXTENSION-UNPACKED-INSTALL.md](EXTENSION-UNPACKED-INSTALL.md), which is written for a non-technical reader and covers install, pairing, updating, removal and what the extension reads. The extension is optional: the hosted re-login link is a complete fallback. Pairing token: Sender detail → Extension tab → *Generate pairing token* (RPC `outreach_issue_sender_token`, manager+, shown once).

### 2.9 First workspace
Sign in, open `/outreach` — the workspace is created on first visit (`outreach_ensure_workspace`), with default stages. Connect a LinkedIn sender (Senders → Connect → hosted auth), wait for status `ok`, set schedule/timezone, then build a sequence.

---

## 3. How cron works

* `outreach_invoke(p_name, p_body)` (SQL, security definer) reads the flag `functions_base_url` and the Vault secret `outreach_cron_secret`, then calls `net.http_post(base || p_name, headers: {x-cron-secret}, body, timeout 60 s)`. It returns the pg_net request id; the HTTP result lands asynchronously in `net._http_response`.
* Workers call `requireCron(req)`: accepts a matching `x-cron-secret` header **or** a service-role bearer token — so you can also invoke any worker by hand with either.
* Hourly workers (planner, health, withdraw, relations-poll) pick their own senders by **sender-local hour**, so one global schedule serves every timezone.
* The tick holds a soft lock in `outreach_flags` (`lock:tick`, epoch ms, 55 s) so overlapping runs skip; reservations older than 10 min are returned to `queued` by `outreach_sweep_stale_reservations()` every 5 min.

**Pause all automation** (sending + planning) without touching cron:
```sql
update outreach_flags set value = 'false'::jsonb where key in ('tick_enabled','planner_enabled');
-- resume
update outreach_flags set value = 'true'::jsonb  where key in ('tick_enabled','planner_enabled');
```
`tick_enabled=false` stops executing actions (queued rows simply wait; nothing is cancelled). `planner_enabled=false` stops creating new actions. Inbound processing, reconnects, imports, webhooks and billing keep running; to freeze those too, `select cron.unschedule(jobid) from cron.job where jobname like 'outreach-%'` and re-apply `004_seed_cron.sql` later.

**Manual runs**
```sql
select outreach_invoke('outreach-worker-planner', '{"mode":"topup"}'::jsonb);
select outreach_invoke('outreach-worker-health', '{"all":true}'::jsonb);
select outreach_invoke('outreach-worker-planner', '{"sender_id":"<uuid>"}'::jsonb);
```
```bash
curl -s -X POST "$BASE/outreach-worker-tick" -H "x-cron-secret: $OUTREACH_CRON_SECRET"
```

**Rotate the cron secret**: put the new value in `.env.local` → run the secrets script → re-run `004_seed_cron.sql` with the new `OUTREACH_CRON_SECRET` (updates Vault). Between the two steps workers answer `401`.

**Change the functions base URL**: `update outreach_flags set value = to_jsonb('https://…/functions/v1/'::text) where key = 'functions_base_url';` (trailing slash required) and set `OUTREACH_FUNCTIONS_BASE_URL` so hosted-auth callbacks use it too.

---

## 4. Environment variables (PRD Appendix A → this implementation)

| PRD name | Implementation | Set where | Notes |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | same | injected by the platform | never put in `.env.local` |
| `UNIPILE_DSN`, `UNIPILE_API_KEY` | same | secrets | DSN with or without `https://` |
| `UNIPILE_WEBHOOK_SECRET` | same | secrets | `unipile-auth` header check in `outreach-unipile-webhook`; sent by `outreach-unipile-setup` when registering |
| — | `OUTREACH_HOSTED_AUTH_DOMAIN` | secrets | optional white-label host for hosted-auth links (e.g. `auth.yourapp.com`, CNAME → `account.unipile.com`, validated by Unipile support). When set, every connect / re-login URL is rewritten to it (§9.10) |
| — | `OUTREACH_APP_NAME` | secrets | optional, default `Outreach`. Shown by the browser-extension sign-in (UniLogin) as the publisher name and tab label (≤60 chars) |
| `CRON_SECRET` | `OUTREACH_CRON_SECRET` | secrets **and** Vault `outreach_cron_secret` | must match |
| `VAULT_COOKIE_KEY_ID` (pgsodium) | `OUTREACH_COOKIE_KEY` (base64 32 bytes, AES-256-GCM in `crypto.ts`) | secrets | Vault is used for the cron secret only |
| `ANTHROPIC_API_KEY` | `GEMINI_API_KEY` (Gemini replaces Claude here, matching the rest of the app) | secrets | optional |
| — | `OUTREACH_AI_MODEL` | secrets | default `gemini-3-flash-preview` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | same | secrets | optional — while unset, billing enforcement (trial sender cap, trial-expiry and past-due suspension) is disabled entirely |
| `STRIPE_PRICE_*` | `STRIPE_PRICE_TEAM_SENDER`, `STRIPE_PRICE_AGENCY_SENDER`, `STRIPE_PRICE_AGENCY_PLUS_SENDER`, `STRIPE_PRICE_MAILBOX_ADDON` | secrets | |
| `RESEND_API_KEY` | same | secrets | optional |
| `EMAIL_FROM` | `OUTREACH_EMAIL_FROM` (falls back to `EMAIL_FROM`) | secrets | default `CapitalxAI Outreach <no-reply@capitalxai.com>` |
| `WEB_ORIGIN` | `OUTREACH_WEB_ORIGIN` | secrets | default `https://app.capitalxai.com`; used for redirects and email links (CORS itself is `*`) |
| `FUNCTIONS_BASE_URL` | `OUTREACH_FUNCTIONS_BASE_URL` + flag `functions_base_url` | secrets + DB | default `<SUPABASE_URL>/functions/v1/` |
| `SENTRY_DSN` | not implemented | — | logs are JSON lines in Supabase function logs |

Web app (Vercel): the existing `NEXT_PUBLIC_SUPABASE_URL` / anon key are all the outreach pages need.

---

## 5. Naming map (PRD → implementation)

| PRD | Implementation |
|---|---|
| schemas `private.*`, `ops.*` | `public.outreach_*` tables with RLS enabled and **no policies** (service role only): `outreach_sender_secrets`, `outreach_sender_tokens`, `outreach_secret_access_log`, `outreach_inbound_events`, `outreach_ai_classify_queue`, `outreach_plans`, `outreach_poll_plan`, `outreach_rate_limits`, `outreach_flags`, `outreach_outbound_webhook_deliveries`, `outreach_ai_calls` |
| `pgmq` queues `inbound`, `ai_classify`, `outbound` | plain queue tables: `outreach_inbound_events` (`processed_at`, `attempts`, `dead`), `outreach_ai_classify_queue` (`attempts`, `locked_at`), `outreach_outbound_webhook_deliveries` (`next_at`, `attempts`, `delivered_at`) |
| `auth.*` helper functions (`auth.workspace_ids()`, `auth.role_in()`, …) | `outreach_workspace_ids()`, `outreach_role_in()`, `outreach_client_visible()`, `outreach_can_write()`, `outreach_can_manage()`, `outreach_require()` |
| `ops.invoke(name)` | `outreach_invoke(p_name, p_body)` |
| `ops.flags` | `outreach_flags` (`functions_base_url`, `tick_enabled`, `planner_enabled`, `lock:tick`) |
| `ops.plans` / `ops.poll_plan` | `outreach_plans(sender_id, day, kind)` (`nightly`, `topup`, `withdraw`) / `outreach_poll_plan` |
| `ops.sweep_stale_reservations` | `outreach_sweep_stale_reservations()` (cron `outreach-sweep`) |
| pgsodium cookie encryption | AES-256-GCM in `_shared/outreach/crypto.ts`, key `OUTREACH_COOKIE_KEY`, stored as base64(iv‖ciphertext) in `outreach_sender_secrets.li_at_enc` / `li_a_enc` |
| Vault for all secrets | Vault holds only `outreach_cron_secret`; everything else is an edge-function secret |
| edge function `<name>` | `outreach-<name>` (e.g. F3 `worker-tick` → `outreach-worker-tick`) |
| F16 `edit-message` / `delete-message` | one function `outreach-edit-message` with `action: 'edit' | 'delete'` |
| F26 `invite-accept` | SQL RPC `outreach_accept_invitation(p_token)` (+ `outreach_invitation_preview`) |
| F27 `notify` | shared module `_shared/outreach/notify.ts` (`notifySender`, `notifyInvitation`) |
| — (not in PRD) | `outreach-sender-manage` (reconnect/resync/checkpoint/refresh/backfill/health/plan), `outreach-invite-member` (create + email invitation), `outreach-unipile-setup` (config status + webhook registration) |
| `verify_jwt: true` for user functions | all `--no-verify-jwt`; user functions call `requireUser()` (see deploy script) |
| rate limits in `ops.rate_limits` | `outreach_rate_limit(key, limit, window)` on `outreach_rate_limits` (per-user per-function; cookie-sync 1/10 min/sender) |
| Metrics views + Grafana | SQL snippets in §7 of this document (no views shipped) |

---

## 6. Runbooks

Run SQL in the Supabase SQL editor (service role) or with `scripts/outreach-sql.sh`.

### 6.1 Provider outage (Unipile 5xx / 429 / unreachable)
What the code does on its own (`_shared/outreach/errors.ts`, `execute.ts`, `health.ts`):
* `5xx` → action retried in 15–45 min; `429` → 30–90 min; network/timeout → 10 min (fails the enrollment after 3 attempts); `407/502` (proxy) → 15–45 min.
* every `429`/`5xx` counts as a reject: **3 within 1 h pauses the sender 24 h** (`paused_until`, `status_reason='3 provider rejections within 1h'`) and recomputes health.
* import jobs retry hourly; relations polls release their budget.

Steps:
1. Confirm: `select error_code, count(*) from outreach_actions where executed_at > now()-interval '1 hour' or (status='queued' and decision='retry') group by 1 order by 2 desc;` and the Unipile status page.
2. Stop the bleeding so senders are not auto-paused for the provider's fault: `update outreach_flags set value='false'::jsonb where key='tick_enabled';`
3. When Unipile recovers, clear the collateral pauses and resume:
   ```sql
   update outreach_senders set paused_until = null, status_reason = null, rejects_1h = 0
    where paused_until > now() and status_reason = '3 provider rejections within 1h';
   update outreach_flags set value='true'::jsonb where key='tick_enabled';
   ```
4. Retried actions already have new `scheduled_for` values; nothing else to replay. Health scores self-correct on the next nightly run (`rejects_14d` still counts them — accept it, or `delete from outreach_sender_events where kind='reject' and at between <start> and <end>` if the incident was clearly provider-side).

### 6.2 Mass disconnect (many senders → `credentials` / `error`)
Detect: `select status, count(*) from outreach_senders where deleted_at is null group by 1;` and
`select count(*) from outreach_sender_events where kind='status' and data->>'to' in ('credentials','error') and at > now()-interval '1 hour';` (PRD alert: > 10 % of fleet in 1 h).

Automatic behaviour:
* cookie-mode senders (`auth_method='cookie'`, have a synced cookie): `outreach-worker-reconnect` retries every 15 min, at most once per hour per sender, 4 attempts (`reconnect_attempts`), then emails *reconnect_needed_manual* daily (max 4); `outreach-cookie-sync` also reconnects immediately when the extension syncs a fresh cookie.
* credentials-mode senders: an email with a hosted-auth **reconnect** link is sent on the `CREDENTIALS` event, then daily reminders (max 3).
* while a sender is not `ok` its reserved actions go back to `queued` (trigger) and `claim_due_actions` ignores it; nothing is lost.

Steps:
1. Check `outreach_sender_events` for the affected senders (`kind in ('unipile','status','reconnect','checkpoint')`) — a `checkpoint` means LinkedIn asked for OTP: solve via Sender → *Checkpoint* (`sender-manage` `{action:'checkpoint', code}`).
2. If Unipile itself was down, wait for `RECONNECTED`/`OK` webhooks; if webhooks were lost, run Sender → *Resync* or query `sender-manage` `{action:'account_status'}` and set status by hand: `update outreach_senders set status='ok', status_reason=null where id=...` (the trigger emits `sender.reconnected`).
3. To force another cookie reconnect round: `update outreach_senders set reconnect_attempts=0, last_reconnect_at=null where status='credentials' and auth_method='cookie';`
4. If many cookie reconnects fail with `checkpoint_error`, the users must log in to LinkedIn in the extension browser; the next cookie sync retries automatically.

### 6.3 Stuck enrollments
Definitions and finders:
```sql
-- live enrollments with nothing scheduled and nothing waiting (should be picked up by the planner)
select e.id, e.status, e.current_node_id, e.wait_until, s.status seq_status
  from outreach_enrollments e join outreach_sequences s on s.id=e.sequence_id
 where e.status in ('active','waiting_delay') and coalesce(e.wait_until, e.node_entered_at) < now() - interval '1 day'
   and not exists (select 1 from outreach_actions a where a.enrollment_id=e.id and a.status in ('queued','reserved'));
-- waiting_task with no open task
select e.id from outreach_enrollments e where e.status='waiting_task'
   and not exists (select 1 from outreach_tasks t where t.enrollment_id=e.id and t.completed_at is null);
-- reserved for too long (sweeper should catch these)
select id, sender_id, action_type, reserved_at from outreach_actions where status='reserved' and reserved_at < now()-interval '10 minutes';
```
Common causes and fixes:
* sequence `paused`/`draft` → enrollments stay put by design; activate the sequence (`outreach_set_sequence_status`).
* sender not `ok`, paused, out of schedule, `invite_blocked_until` set, or daily cap exhausted (`decision='budget_deferred'`) → look at `outreach_sender_today(sender)` and `outreach_senders`; the planner sets `outreach_sequences.throttled_reason`.
* planner never planned the sender (no `outreach_plans` row): `select outreach_invoke('outreach-worker-planner','{"sender_id":"<uuid>"}'::jsonb);` or Sender → *Plan now*.
* node points at a missing/changed node: `select outreach_advance_enrollment('<enrollment>', current_node_id, null);` (moves on) or `select outreach_enter_node('<enrollment>', '<node_id>');` (re-enter).
* delay windows that never released: `select outreach_release_waits();` (the tick does this every minute for active sequences).
* give up: `select outreach_exit_enrollment('<enrollment>', 'ops');`.

### 6.4 Dead-letter replay (inbound events)
`outreach-process-inbound` retries an event up to 5 times, then marks it `dead=true` with the last `error`.
```sql
select id, source, event_type, unipile_account_id, attempts, error, received_at
  from outreach_inbound_events where dead order by id desc limit 50;

-- replay (after fixing the cause, e.g. the sender row now exists / secret set)
update outreach_inbound_events set dead = false, attempts = 0, error = null
 where dead and received_at > now() - interval '1 day';               -- or: where id in (...)
```
The next `outreach-inbound` run (≤ 10 s) processes them in id order. Events for unknown accounts (`warn: unknown account`) are marked processed, not dead — re-insert them from the payload if needed.

AI classification queue: rows with `attempts >= 3` are deleted; to re-queue a message `insert into outreach_ai_classify_queue(message_id) values ('<uuid>');`. Locks older than 5 min are re-claimed automatically.

Outbound webhooks: `select * from outreach_outbound_webhook_deliveries where delivered_at is null and attempts >= 5;` → `update … set attempts = 0, next_at = now()` to retry; a webhook disabled after 50 failures needs `update outreach_outbound_webhooks set active=true, failures=0 where id=…`.

### 6.5 Secrets
* **Cookie key rotation** (`OUTREACH_COOKIE_KEY`): stored cookies cannot be re-encrypted without the old key in the same runtime, so rotate by (1) setting the new key, (2) `delete from outreach_sender_secrets;`, (3) asking users to open the extension and *Sync now* (or wait ≤ 3 h). Cookie-mode senders that disconnect in between fall back to the credentials-mode email flow.
* **Purge one sender's secret**: Sender → Disable with *purge secrets*, or `delete from outreach_sender_secrets where sender_id=…; delete from outreach_sender_tokens where sender_id=…;`
* **Extension token**: regenerate from the sender page (old token invalid immediately). Every cookie read is in `outreach_secret_access_log`.

### 6.6 Suspend / restore a workspace by hand
```sql
update outreach_workspaces set plan='suspended' where id=…;          -- RLS/RPCs become read-only, senders keep status
update outreach_senders set status='paused', status_reason='billing_suspended' where workspace_id=… and status='ok';
-- restore: one call does both updates, restores the plan the workspace had (settings.plan_before_suspension, else 'team'), audits and emits workspace.billing_recovered
select outreach_resume_after_billing('<workspace id>');
```

---

## 7. Observability queries

```sql
-- Inbound backlog (alert: > 500 or oldest > 2 min)
select count(*) backlog, min(received_at) oldest, now()-min(received_at) age
  from outreach_inbound_events where processed_at is null and not dead;

-- Tick health: last runs of the cron job (alert: none in 3 min)
select jobname, status, start_time, end_time, return_message
  from cron.job_run_details d join cron.job j using (jobid)
 where j.jobname = 'outreach-tick' order by start_time desc limit 10;
-- HTTP outcome of the last invocations (pg_net keeps recent responses only)
select id, status_code, left(content, 200) body, created
  from net._http_response order by id desc limit 20;
-- tick lock (0 = free; epoch ms while running)
select value from outreach_flags where key = 'lock:tick';

-- Actions by status per hour (last 24 h)
select date_trunc('hour', coalesce(executed_at, scheduled_for)) h, status, count(*)
  from outreach_actions where coalesce(executed_at, scheduled_for) > now()-interval '24 hours'
 group by 1,2 order by 1 desc, 2;

-- Unipile error codes (last hour)
select error_code, decision, count(*) from outreach_actions
 where executed_at > now()-interval '1 hour' and error_code is not null group by 1,2 order by 3 desc;

-- Senders by status (+ paused / invite-blocked)
select status, count(*) filter (where paused_until > now()) paused, count(*) filter (where invite_blocked_until > now()) invite_blocked, count(*)
  from outreach_senders where deleted_at is null group by 1;

-- Health distribution
select width_bucket(health_score, 0, 100, 10)*10 bucket, count(*) from outreach_senders where deleted_at is null and status<>'disabled' group by 1 order by 1;

-- Budget utilisation today (sender-local day)
select s.display_name, b.action_type, b.used, b.reserved, b.cap, round(100.0*(b.used+b.reserved)/nullif(b.cap,0)) pct
  from outreach_sender_budgets b join outreach_senders s on s.id=b.sender_id
 where b.day = outreach_sender_local_date(b.sender_id, now()) and b.cap > 0 order by 1,2;

-- Planner completeness (alert: < 100 % by local 06:00) — senders `ok` that have a nightly plan for their local "tomorrow"
select count(*) filter (where p.sender_id is not null) planned, count(*) senders_ok
  from outreach_senders s
  left join outreach_plans p on p.sender_id = s.id and p.kind = 'nightly'
       and p.day = outreach_sender_local_date(s.id, now()) + 1
 where s.status='ok' and s.deleted_at is null and s.provider='LINKEDIN';
-- throttled sequences
select id, name, throttled_reason from outreach_sequences where status='active' and throttled_reason is not null;

-- AI classify backlog
select count(*) from outreach_ai_classify_queue;

-- Outbound webhook failures
select w.url, w.failures, w.active, count(d.id) pending
  from outreach_outbound_webhooks w left join outreach_outbound_webhook_deliveries d on d.webhook_id=w.id and d.delivered_at is null
 group by 1,2,3 order by 2 desc;

-- Enrollment funnel per sequence
select sequence_id, status, count(*) from outreach_enrollments group by 1,2 order by 1,2;

-- Secret access (who decrypted cookies)
select fn, count(*), max(at) from outreach_secret_access_log where at > now()-interval '7 days' group by 1;

-- Recent audit
select at, actor_type, action, entity, entity_id from outreach_audit_log order by at desc limit 50;
```
Function logs: Supabase dashboard → Edge Functions → `<function>` → Logs. Every request logs one JSON line `{at, fn, outcome, status, duration_ms}` plus per-call lines (`fn:"unipile"` with endpoint/status/latency, `fn:"tick"` summary, `fn:"planner"` per sender, `fn:"health"`).

---

## 8. Testing checklist (PRD §18 / MVP)

| # | Item | How to verify |
|---|---|---|
| 1 | Connect LinkedIn (credentials), status via webhooks, onboarding gate | Senders → Connect → complete hosted auth. Expect `outreach_inbound_events` rows `hosted_notify` + `account_status` (`CREATION_SUCCESS`, `OK`), sender `status='ok'`, `public_identifier`/`provider_user_id`/`connections_count` filled; `< 150` connections → `warmup_level=0`, `warmup_locked_until = today+28`; free account → level ≤ 1 |
| 2 | Planner + tick + ledger | Enrol a lead; `plan_now` → rows in `outreach_actions` (jittered, never at :00/:30 exactly, `profile_view` prefetch 5–40 min before sends); next tick executes; `outreach_sender_budgets.used` increments; `used + reserved <= cap` always holds (check constraint) |
| 3 | visit / like / invite / message / withdraw / delay | one sequence with each node; check `outreach_actions.status='sent'`, `response`, `outreach_lead_sender_state.relation` (`pending_out` after invite), delay → `waiting_delay` then released by `outreach_release_waits` |
| 4 | `wait_connection` with both acceptance signals | (a) note path: our own first message in a new chat while `pending_out` → `relation='first'` (`is_invite_note`); (b) `users.new_relation` webhook → `first`. Trigger `outreach_lss_relation` advances the `connected` branch with a 2 h not-before |
| 5 | Reply → exit | inbound `message_received` → `replied=true` → trigger `outreach_lss_reply_exit` exits **every** live enrollment of that lead in the workspace (scope `lead`, the default) and cancels the lead's queued actions on all senders (`decision='reply_exit'`); `send_always` nodes are exempt; an out-of-office intent re-opens it. Covered by `migrations/outreach/tests/smoke_01_reply_stop.sql` |
| 6 | Inbox with Realtime, reply, attachments | chat appears without refresh (publication includes `outreach_messages`/`outreach_chats`); `send-reply` creates a `reply` action + message, clears unread; attachment URL via `attachment-proxy` |
| 7 | Import by search URL and CSV | `imports-create` `dry_run` shows estimate; job advances every 5 min within schedule, consuming `search_page` budget; CSV job completes in one pass; leads deduped by `public_identifier` / email |
| 8 | Builder with versions, projection, node stats | `save_sequence` bumps `head_version` and writes `outreach_sequence_versions`; `restore_sequence_version`; `project_sequence` returns days/bottleneck; `outreach_node_stats` updated by the actions trigger |
| 9 | RLS + ledger tests | as a `member` of workspace A: cannot select workspace B rows; `client_viewer` sees only assigned clients; `outreach_claim_due_actions` never returns two rows for one sender; 100 parallel `reserve_budget` never exceed `cap` |
| 10 | Extension + cookie reconnect (v1) | pair the extension, *Sync now* → `outreach_sender_secrets` row, `auth_method='cookie'`; set sender to `credentials` (`update …`) → `worker-reconnect` posts a reconnect within 15 min; wrong LinkedIn account → `409 E_IDENTITY_MISMATCH` + audit `cookie.identity_mismatch` |
| 11 | Health, warmup, pause rules | `worker-health {all:true}`; force 3 rejects in 1 h → `paused_until` +24 h and email; score `<50` → paused; `≥85` for 14 days → level +1 (nightly only) |
| 12 | AI classify / drafts / QA | inbound reply → `outreach_messages.intent`, `interested`/`question` create a `follow_up` task; `ai_draft_approval` node → `review_ai_draft` task, `complete_task` with edited text queues the real action; `ai-sequence-qa` returns static errors even without a key |
| 13 | Stripe | checkout from Settings → Billing; webhook `customer.subscription.updated` sets `plan`; `billing-sync` writes `outreach_billing_usage` and updates item quantities |
| 14 | Chaos: kill tick mid-batch | stop the function (or set `tick_enabled=false` mid-run); reserved rows return to `queued` via the sender-status trigger or `outreach_sweep_stale_reservations` within 10 min; budgets released |
| 15 | Zero double-sends | `select idempotency_key, count(*) from outreach_actions group by 1 having count(*)>1;` is empty; no two `sent` actions for the same `(enrollment_id, node_id)` unless `attempt` differs |

---

## 9. Switch-on checklist (product plan, Phase 1 and later)

Added 20 Sep 2026. It mirrors the "Phase 1 switch-on checklist" in `outreach-product-plan.md` and adds the operator steps for features that need something outside this repo. **Built is not the same as on.** Until a row below is done, do not tell customers the feature is live.

| # | Item | State on 20 Sep 2026 | What switches it on |
|---|---|---|---|
| 9.1 | Stripe billing | Built, off | Keys, prices with lookup keys, webhook endpoint, then the recovered-payment test |
| 9.2 | Resend email | Built, off | Verified domain, `RESEND_API_KEY`, `OUTREACH_EMAIL_FROM` |
| 9.3 | New cron jobs, weekly sender report | In `016_seed_cron_v2.sql` | Apply 016, deploy the functions the jobs call |
| 9.4 | CRM sync (optional) | Needs one OAuth app per CRM | Client id and secret per CRM, redirect URL registered |
| 9.5 | Database and functions | Migrations 009–018 are applied to the live project | Re-apply after changes, deploy new functions, run the smoke tests |
| 9.6 | Booking webhook | Built | The customer pastes a URL into Calendly or Cal.com |
| 9.7 | Custom portal domains | Built | Customer DNS, flag `portal_cname_target`, add the domain at the hosting provider |
| 9.8 | Custom tracking domains | Built, **manual approval per domain** | Customer CNAME, Unipile support authorises it, you set the row to `active` |
| 9.9 | `ai_auto_send`, post-fetch budget | Done in the database | Nothing. Verify with the queries below |

### 9.1 Stripe

While `STRIPE_SECRET_KEY` is unset, billing enforcement is off: usage is recorded, nothing is charged and nothing is suspended (trial sender cap, trial expiry and past-due suspension all skip).

1. **Keys.** In Stripe: Developers → API keys. Put the secret key in `.env.local` as `STRIPE_SECRET_KEY`.
2. **Products and prices.** Create recurring **per-seat** prices: team sender, agency sender, agency-plus sender, and the mailbox add-on. Give each price a **lookup key** containing `team`, `agency`, `agency_plus` or `mailbox`. `planFromSub()` maps a subscription to a plan by lookup key or nickname, or by equality with a `STRIPE_PRICE_*` value; `outreach-billing-sync` finds the mailbox item by `/mailbox/i`. Put the price ids in `STRIPE_PRICE_TEAM_SENDER`, `STRIPE_PRICE_AGENCY_SENDER`, `STRIPE_PRICE_AGENCY_PLUS_SENDER`, `STRIPE_PRICE_MAILBOX_ADDON`. The amounts are a business decision and are not in this repo (see [POLICIES.md](POLICIES.md)).
3. **Webhook endpoint.** Add `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-stripe-webhook` with the events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`. Copy the signing secret to `STRIPE_WEBHOOK_SECRET`.
4. **Customer portal.** In Stripe: Settings → Billing → Customer portal. Allow cancelling and changing quantity or plan. The app's "Manage billing" button opens it.
5. **Failed-payment emails.** Turn on Stripe's own emails for failed payments and upcoming renewals (Settings → Billing → Subscriptions and emails). This repo does not send them.
6. Run `./scripts/outreach-set-secrets.sh`, then check **Settings → Workspace → Platform setup** shows `stripe` and `stripe_webhook` as present.
7. **Confirm the trial cap and the nightly quantity sync**, in Stripe test mode:
   * A trial workspace cannot connect a fourth sender (`outreach-sender-connect` refuses).
   * Subscribe with 2 active senders, connect a third, then run `select outreach_invoke('outreach-billing-sync');`. The subscription item quantity becomes 3 (`proration_behavior: none`), and `outreach_billing_usage` has today's row.
8. **Test that senders resume on their own after a recovered payment.** This is the claim we make against GetSales, so test it, do not assume it.
   1. In test mode, subscribe a workspace that has at least one sender with status `ok`.
   2. Make the payment fail: replace the customer's card with the test card `4000 0000 0000 0341`, then advance a Stripe test clock past the renewal. `invoice.payment_failed` arrives and `outreach_workspaces.past_due_since` is set.
   3. Suspension happens 7 days after `past_due_since`, in `outreach-billing-sync`. To avoid waiting: `update outreach_workspaces set past_due_since = now() - interval '8 days' where id = '<ws>';` then `select outreach_invoke('outreach-billing-sync');`.
   4. Check: `plan = 'suspended'`, `settings->>'plan_before_suspension'` holds the old plan, and the senders are `paused` with `status_reason = 'billing_suspended'`.
   5. Recover the payment: set a working test card (`4242 4242 4242 4242`) and pay the open invoice in the Stripe dashboard. `invoice.paid` (or `customer.subscription.updated` with status `active`) arrives.
   6. **Pass** = without touching anything in the app:
      ```sql
      select plan, past_due_since, settings->>'plan_before_suspension' from outreach_workspaces where id = '<ws>';   -- old plan back, past_due_since null
      select display_name, status, status_reason from outreach_senders where workspace_id = '<ws>';                   -- ok, null
      select at, diff from outreach_audit_log where workspace_id = '<ws>' and action = 'workspace.billing_recovered' order by at desc limit 1;   -- senders_resumed = n
      ```
      The webhook calls `outreach_resume_after_billing(p_ws)`, which restores the plan, sets every sender paused for `billing_suspended` or `trial_expired` back to `ok`, audits, and emits the `workspace.billing_recovered` event. Senders a person paused (`user_paused`) stay paused, on purpose.
   7. Within one planner top-up (20 minutes) the senders have new queued actions. Sequences were never paused, so there is nothing to restart.
   8. If it fails, by hand: `select outreach_resume_after_billing('<ws>');` from the SQL editor, and read the `outreach-stripe-webhook` logs for `resume_after_billing failed`.

### 9.2 Resend

Without `RESEND_API_KEY` every email is skipped and logged (`RESEND_API_KEY unset`); alerts still show in the app and fire webhooks.

1. In Resend, add and verify the sending **domain** (SPF and DKIM records at the DNS host).
2. Set `RESEND_API_KEY` and `OUTREACH_EMAIL_FROM`, for example `CapitalxAI Outreach <no-reply@capitalxai.com>`. The domain in `OUTREACH_EMAIL_FROM` must be the verified one. Run the secrets script.
3. White-label workspaces can set their own sender in **Settings → White-label** (`branding.email_from_address`). It is used only when **that** domain is also verified in the same Resend account. Otherwise the platform address is used with the agency's name and reply-to. Verifying a customer's domain is an operator task.
4. Check **Platform setup** shows `resend` as present.

Emails that exist:

| Email | Sent when | To | Code |
|---|---|---|---|
| Reconnect needed, with the hosted re-login link | a sender's LinkedIn session ends (credentials mode), then daily reminders, at most 3 | owners, managers, the sender's owner email, the sender's alert recipients | `notifySender('reconnect_needed')` |
| Automatic reconnect failed | cookie-mode reconnect gave up after 4 tries, then daily, at most 4 | same | `reconnect_needed_manual` |
| Sender paused / sender error / warm-up level up | safety pause, provider error, level change | same | `sender_paused`, `sender_error`, `level_up` |
| Workspace invitation | an owner invites a member | the invitee; branded | `notifyInvitation` (`outreach-invite-member`) |
| Sequence stalled | `outreach_detect_stalls` opens an alert | owners, managers | `notifyWorkspace('sequence_stalled')` from `outreach-worker-health` |
| Sender running dry | fewer than 2 days of new leads left | owners, managers, that sender's alert recipients | `sender_running_dry` |
| Import failed | an import job failed in the last 2 days | owners, managers | `import_failed` |
| Weekly sender report | Mondays 08:00 workspace time | owners, managers, each sender's alert recipients | `outreach-worker-reports`, schedule kind `sender_report` |
| Workspace digest | weekly (Monday) or monthly (the 1st), 08:00 workspace time | owners, managers, plus the schedule's recipients | schedule kind `digest` |
| Client report, branded | weekly or monthly per client | the schedule's recipients, optionally the client's viewers. Never shows the platform name when `hide_platform_name` is on | schedule kind `client_report` |

Each alert is emailed once per occurrence (`outreach_alerts.notified_at`). An alert whose email could not be sent is retried hourly for one day. **While Resend is off, alerts are marked as announced without an email**, so alerts that opened before you switched Resend on are not emailed afterwards; they stay visible on the dashboard until they resolve. Per-sender alert recipients are `outreach_senders.alert_emails` (sender page → Settings → "Alerts, booking and cost", at most 10).

Verify after switching on, as the plan's checklist asks:

* **Invite:** invite a test address from Settings → Members.
* **Reconnect link:** on a test sender click **Send re-login link**; the email arrives with a working link.
* **Disconnect:** `update outreach_senders set status = 'credentials' where id = '<test sender>';` then wait one `outreach-reconnect` run (15 minutes). Reconnect the sender afterwards.
* **Stall alert:** pause every sender in a test sequence's pool and wait for the next `outreach-health` run. One email arrives with the reason. Resume the senders and the alert clears.
* **Reports:** `curl -s -X POST "$BASE/outreach-worker-reports" -H "x-cron-secret: $OUTREACH_CRON_SECRET" -H 'content-type: application/json' -d '{"schedule_id":"<id>","dry_run":true}'` returns the HTML and sends nothing. Use `"force":true` to send now.

### 9.3 New cron jobs (`016_seed_cron_v2.sql`)

016 does not touch the jobs from 004 and 008. It unschedules its own jobs by name first, so re-applying is safe.

| Job | Schedule | Runs | Needs |
|---|---|---|---|
| `outreach-rollup` | `25 * * * *` | `select outreach_rollup_all()` (SQL only). Hourly because each workspace's "yesterday" closes at its own midnight | nothing |
| `outreach-auto-enroll` | `*/10 * * * *` | `select outreach_run_auto_enroll()` (SQL only) | nothing |
| `outreach-import-schedules` | `*/15 * * * *` | `select outreach_run_import_schedules()` (SQL only). The jobs it creates are run by the existing `outreach-worker-imports` | nothing |
| `outreach-enrich` | `*/10 * * * *` | edge function `outreach-worker-enrich` | function deployed |
| `outreach-ai-variables` | `* * * * *` | edge function `outreach-ai-variables`: AI lines and AI routing decisions | function deployed; an AI key (platform Gemini key, or the workspace's own) |
| `outreach-crm-sync` | `*/5 * * * *` | edge function `outreach-crm-sync` | function deployed; does nothing for workspaces without an active integration |
| `outreach-reports` | `0 * * * *` | edge function `outreach-worker-reports`. Sends at 08:00–08:59 workspace time, and catches up in the next two hourly runs | function deployed; Resend |
| `outreach-domain-check` | `*/30 * * * *` | edge function `outreach-domain-check` | function deployed |
| `outreach-cleanup-v2` | `30 4 * * *` | deletes API idempotency rows older than 2 days, integration events older than 14 days, CRM sync log, auto-enrol log and resolved alerts older than 90 days | nothing |

The **weekly sender report** is now scheduled: 016 inserts a weekly `sender_report` and a weekly `digest` row in `outreach_report_schedules` for every workspace, and a trigger does the same for new workspaces. Owners and managers can switch them off on the Reports page. Stall and running-dry detection needs no new job: it runs inside the existing `outreach-health` job.

A cron job whose edge function is not deployed yet fails quietly: `outreach_invoke` returns a pg_net request id and the 404 lands in `net._http_response`. Check after deploying:

```sql
select jobname, schedule, active from cron.job where jobname like 'outreach-%' order by 1;        -- 24 jobs: 15 from 004/008 + 9 from 016
select id, status_code, left(content, 120) from net._http_response order by id desc limit 30;     -- no 404s
select key, value from outreach_flags where key = 'portal_cname_target';
select * from outreach_platform_ceilings where action_type in ('post_fetch','follow','find_email');
```

### 9.4 New secrets

All optional. A feature whose secret is missing stays off without errors. `scripts/outreach-set-secrets.sh` pushes keys with the prefixes `UNIPILE_`, `OUTREACH_`, `STRIPE_`, `SMARTLEAD_`, `CRM_`, `HUBSPOT_`, `PIPEDRIVE_`, `SALESFORCE_`, plus `RESEND_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL_ID`, `EMAIL_FROM`, `TEMP_MAX_AGE_HOURS`.

**CRM OAuth apps (item 22).** One app per CRM you want to offer. Create it in the CRM's developer portal, and register this redirect URL:

```
<functions base>/outreach-crm-oauth/callback
for this project: https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-crm-oauth/callback
```

| CRM | Secrets | Where to create the app | Scopes the app must allow (from the provider file) |
|---|---|---|---|
| HubSpot | `HUBSPOT_CLIENT_ID`, `HUBSPOT_CLIENT_SECRET` | HubSpot developer account → Apps | `HUBSPOT_SCOPES` in `supabase/functions/_shared/outreach/crm/hubspot.ts`: `oauth`, contacts, companies and deals read + write, `crm.lists.read`, `crm.schemas.contacts.write` |
| Pipedrive | `PIPEDRIVE_CLIENT_ID`, `PIPEDRIVE_CLIENT_SECRET` | Pipedrive Developer Hub | `PIPEDRIVE_SCOPES` in `crm/pipedrive.ts`: `base`, `contacts:full`, `deals:full`, `search:read`; `admin` is optional |
| Salesforce | `SALESFORCE_CLIENT_ID`, `SALESFORCE_CLIENT_SECRET` | Setup → App Manager → Connected App | `SALESFORCE_SCOPES` in `crm/salesforce.ts`: `api`, `refresh_token` |

Optional overrides: `SALESFORCE_LOGIN_URL` (`https://test.salesforce.com` for sandboxes), `SALESFORCE_API_VERSION`, `HUBSPOT_TOKEN_URL`. The scope lists above are a summary; the constants in the provider files are the source of truth.

* A CRM whose pair is missing shows as not available in **Settings → Integrations**, with the message "The operator has to set …".
* The redirect URL is built from `OUTREACH_FUNCTIONS_BASE_URL` (default `<SUPABASE_URL>/functions/v1/`). If you change the functions base, update the redirect URL in every CRM app.
* After the CRM sends the user back, the function redirects to the page the user started from. That page must be on `OUTREACH_WEB_ORIGIN`; anything else falls back to `/outreach/settings/integrations` on that origin.
* Customer tokens are stored encrypted with `OUTREACH_COOKIE_KEY` in `outreach_integration_secrets` (service role only).
* **Do not describe CRM sync as live** until at least one CRM has been connected end to end on a test account and `outreach_crm_sync_log` shows `ok` rows. On 20 Sep 2026 no CRM app existed and none of the three providers had been run against a real account.

**Unsubscribe page.** `outreach-unsubscribe` answers `GET` with a small confirmation page and only unsubscribes on `POST` (mail scanners open every link, so a GET must not unsubscribe). On the default `*.supabase.co` domain Supabase serves HTML from edge functions as plain text, so the page would show as source code. Do one of these before the first email with `{{unsubscribe_link}}` goes out: serve functions from a custom domain and set `OUTREACH_FUNCTIONS_BASE_URL` to it, or set `OUTREACH_UNSUBSCRIBE_PAGE_URL` to a page in the web app that shows the button and POSTs to the function. The mailbox provider's one-click request (`List-Unsubscribe-Post`) is a POST and works either way.

**No new secret is needed for:** bring-your-own LLM keys and email-finder keys (customers enter them in Settings → AI & data; they are encrypted with `OUTREACH_COOKIE_KEY` and stored in `outreach_workspace_secrets`), the unsubscribe link (signed with `OUTREACH_CRON_SECRET`), the booking webhook (a per-workspace path secret in the database), and the public API (keys live in `outreach_api_keys`).

**Rotating `OUTREACH_CRON_SECRET` now has a side effect:** unsubscribe links in emails already sent stop verifying. Rotating `OUTREACH_COOKIE_KEY` also invalidates stored CRM tokens and customers' own AI keys, in addition to LinkedIn cookies (§6.5). Customers then reconnect the CRM and re-enter the key.

### 9.5 Apply migrations 009–018 and deploy the new functions

The migrations were applied to the live project on 20 Sep 2026. For a new project, or after a change:

```bash
export CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_...
export OUTREACH_CRON_SECRET=<same value as the edge function secret>
./scripts/outreach-apply-migrations.sh          # 001 → 018, one API call per file
# or only the product-plan files, in this order:
./scripts/outreach-apply-migrations.sh migrations/outreach/009_enums_v2.sql
./scripts/outreach-apply-migrations.sh migrations/outreach/010_schema_v2.sql migrations/outreach/011_engine_v2.sql \
  migrations/outreach/012_editing_recovery_enrol.sql migrations/outreach/013_reports.sql migrations/outreach/014_intelligence.sql \
  migrations/outreach/015_platform.sql migrations/outreach/016_seed_cron_v2.sql migrations/outreach/017_hardening.sql migrations/outreach/018_scope_hardening.sql
./scripts/outreach-smoke.sh                     # every smoke test must print PASS
```

* **009 first, on its own.** It only adds enum values. PostgreSQL cannot use a new enum value in the transaction that added it, and the Management API runs one file as one transaction. The script sends one request per file, so order is all that matters. Never paste 009 and 010 into the SQL editor as one statement batch.
* Every file is idempotent. Re-run `017_hardening.sql` whenever functions were added: it removes `anon` and `PUBLIC` execute rights from every outreach function except the three that must work before login.
* What each file contains, what the smoke tests assert and how to read their output: [SQL-REFERENCE.md](SQL-REFERENCE.md).

Deploy:

```bash
./scripts/outreach-deploy-functions.sh          # everything in the catalogue that exists in this checkout
./scripts/outreach-deploy-functions.sh worker-enrich ai-variables worker-reports domain-check booking-webhook unsubscribe \
  workspace-secrets crm-oauth crm-sync api      # only the new ones
```

With no arguments the script skips catalogue entries whose folder is missing and prints `WARN: … does not exist yet (skipped)`. Read those warnings: a skipped function that a cron job calls means that feature is off. If Docker is not running, set `OUTREACH_DEPLOY_EXTRA_ARGS="--use-api"`.

**Redeploy the existing functions as well, not only the new ones.** The shared modules in `_shared/outreach/` changed in this build (executor, planner, render, notify, workers, inbound), and an edge function only picks up a shared module when it is deployed again. Until `outreach-worker-tick` is redeployed the executor still reads `lss.replied` instead of `outreach_enrollment_reply_blocked`, and does not check scoped blacklists at send time.

New functions and who may call them:

| Function | Trigger | Auth in code |
|---|---|---|
| `outreach-worker-enrich` | cron, 10 min | cron secret |
| `outreach-ai-variables` | cron, 1 min; also the web app for "test on 20 leads" | cron secret or user JWT |
| `outreach-crm-sync` | cron, 5 min | cron secret |
| `outreach-worker-reports` | cron, hourly | cron secret |
| `outreach-domain-check` | cron, 30 min | cron secret |
| `outreach-booking-webhook` | Calendly / Cal.com | `ws` + `k` in the URL, compared in constant time |
| `outreach-unsubscribe` | the link in an email | signed token (HMAC with `OUTREACH_CRON_SECRET`) |
| `outreach-crm-oauth` | web app (start), the CRM (callback) | user JWT for the start call; `state` for the callback |
| `outreach-workspace-secrets` | web app | user JWT |
| `outreach-api` | customers' systems, `/v1` | API key, `outreach_api_authenticate`. Docs: [API.md](API.md), spec [openapi.json](openapi.json) |

### 9.6 Booking webhook URL

We do not run a calendar. The customer keeps Calendly or Cal.com and adds one webhook:

```
<functions base>/outreach-booking-webhook?ws=<workspace id>&k=<booking secret>&p=calendly
<functions base>/outreach-booking-webhook?ws=<workspace id>&k=<booking secret>&p=calcom
```

* `<booking secret>` is `outreach_workspace_secrets.booking_secret`, one per workspace. Only owners can read it: `outreach_workspace_ai_settings(p_ws)` returns it as `booking_webhook_secret` to owners and to nobody else, and **Settings → Email & booking** builds the full URL from it. `p` can be left out: the payload shape identifies the provider.
* The secret lives in a row that is created the first time the workspace saves anything in `outreach_workspace_secrets`. If an owner sees no URL, check the row exists: `insert into outreach_workspace_secrets(workspace_id) values ('<ws>') on conflict do nothing;`
* Calendly events: `invitee.created`, `invitee.canceled`. Cal.com triggers: `BOOKING_CREATED`, `BOOKING_RESCHEDULED`, `BOOKING_CANCELLED`.
* **How the lead is found:** links rendered by the platform (`{{booking_link}}`, `{{sender.booking_link}}`) end in `utm_content=<lead id>`. Calendly returns it in `payload.tracking.utm_content`. Cal.com does not echo UTM parameters. The inbox "Send booking link" button (`outreach-send-reply`, code in `_shared/outreach/reply.ts`) therefore also appends `metadata[lead_id]=<lead id>` to cal.com links, which Cal.com returns in `payload.metadata.lead_id`. Links rendered inside sequence steps get `utm_content` only (`buildContext` in `render.ts`), so a Cal.com booking from a sequence message is matched by the invitee's email. A hidden booking question with the identifier `lead_id` also works. A booking that matches no lead is still stored, with `lead_id` null, and logged as `unmatched`.
* A matched booking moves the lead to the Meeting stage, records the milestone, ends every live sequence for that lead (`meeting_booked`) and emits `meeting.booked`.
* To rotate a leaked secret: `update outreach_workspace_secrets set booking_secret = encode(gen_random_bytes(18),'hex') where workspace_id = '<ws>';` and have the customer paste the new URL.
* A sender's link is set on the sender page (Settings → "Alerts, booking and cost") and must start with `https://`.

### 9.7 Custom portal domains (white-label)

The customer wants clients to open `reports.agency.com` instead of our app's address.

1. **Once per platform: set the CNAME target.** `outreach_add_domain` copies the flag `portal_cname_target` into every new domain row. 016 seeds it with `cname.vercel-dns.com`. If the web app is hosted elsewhere, change it **before** customers add domains:
   ```sql
   update outreach_flags set value = to_jsonb('<your host''s cname target>'::text) where key = 'portal_cname_target';
   ```
   Rows that already exist keep the target they were created with.
2. **The customer (workspace owner)** adds the hostname in **Settings → White-label**. The app shows two DNS records:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `reports.agency.com` | the `portal_cname_target` value |
   | TXT | `_outreach-verify.reports.agency.com` | the row's `verification_token` |

3. **`outreach-domain-check`** (every 30 minutes) resolves both over DNS-over-HTTPS. TXT only → `verifying`. Both → `active` with `verified_at`. After 14 days without success → `failed`; remove the domain and add it again to retry. `last_error` holds the reason in plain words.
4. **You, the operator, add the hostname at the hosting provider** (Vercel: Project → Settings → Domains → Add). This is what issues the TLS certificate. `active` in our table only means the customer's DNS is right. Until the host has the domain, the browser shows a certificate error. There is no API call for this in the repo: it is a manual step per domain, so agree with the owner who gets told when a customer adds one.
   ```sql
   select hostname, status, verified_at, last_error from outreach_workspace_domains order by created_at desc;
   ```
5. **Web app side.** `proxy.ts` (Next.js 16's name for `middleware.ts`) runs only for `/` and `/outreach/*`. For a host that is not one of the app's own, it calls `outreach_branding_for_host` (callable before login, resolves only `active` rows), sets the `x-outreach-host`, `x-outreach-workspace` and `x-outreach-client` request headers, and rewrites `/` to the client portal. An unknown host, or a failed lookup, passes through unchanged. Set these in the hosting project's environment so the app knows its own hosts:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_APP_URL` | the app's main URL, for example `https://app.capitalxai.com` |
   | `OUTREACH_APP_HOSTS` | optional, comma-separated extra hosts that are **ours**, not a customer's (a second production domain, a staging host). Vercel preview hosts and localhost are recognised without it |

6. A browser session belongs to one origin, so a client signs in once on the custom domain. Password sign-in needs nothing more. If clients use a magic link or a social login, add `https://<hostname>/**` to Supabase → Authentication → URL Configuration → Redirect URLs, or the link sends them back to the main app.
7. Limit: 10 domains per workspace.

### 9.10 Hosted auth: sign-in methods and the white-label login domain

Connecting a sender always goes through Unipile's **Hosted Auth Wizard** (docs: <https://developer.unipile.com/docs/hosted-auth>). `outreach-sender-connect` creates the link (`type: create`, `name` = our sender id, `notify_url` = `outreach-sender-notify?sid=<id>`, 15-minute expiry); `reconnectLink()` in `_shared/outreach/inbound.ts` creates re-login links (`type: reconnect` + `reconnect_account`, 24 h). The notify callback carries `{status: CREATION_SUCCESS | RECONNECTED, account_id, name}` and is what binds the Unipile account to the sender row.

**Two LinkedIn sign-in methods** exist on the connect page (`connect_method` in the request body). The browser method is **switched off in the UI** by the hard-coded toggle `BROWSER_SIGNIN_ENABLED` in `lib/outreach/features.ts` until Unipile confirms it for our account (Sept 2026); the backend accepts it regardless, so flipping that one constant (and un-commenting the `BROWSER_SIGNIN` blocks in outreach-app-docs) re-enables it.

| Method | Hosted-auth options sent | Stored `auth_method` |
|---|---|---|
| Sign in with LinkedIn (default) | none | `credentials` (or `cookie` if the account later reports a cookie connection) |
| Use the signed-in browser (UniLogin) | `unilogin: {publisher_name, tab_name}` + `disabled_options: ["credentials_auth", "cookie_auth"]` | `browser` (migration 019; never overwritten by the account-status sync) |

With the browser method the wizard connects the LinkedIn account already logged in to the owner's browser through the UniLogin store extension (Chrome / Firefox automatic handoff; Edge / Safari ZIP; one-time code fallback when detection fails or a custom domain is used). We receive an account id, never cookies. Re-login links for `browser` senders send the same options, so the owner is not asked for a password. Mailboxes always use OAuth and ignore `connect_method`.

**White-label login domain** (removes the provider's name from the address bar; requires an active Unipile subscription):

1. Create a DNS record: `CNAME auth.<yourapp>.com → account.unipile.com`. Check propagation (`dig auth.<yourapp>.com CNAME` or whatsmydns.net) — Unipile cannot issue the certificate until it resolves publicly.
2. Ask Unipile support to validate `https://auth.<yourapp>.com`; they finish the configuration and issue the TLS certificate.
3. Set the secret `OUTREACH_HOSTED_AUTH_DOMAIN=auth.<yourapp>.com` and redeploy every function that creates links (`sender-connect`, `sender-manage`, `worker-reconnect`, `worker-tick`, `process-inbound`). `hostedAuthUrl()` in `_shared/outreach/unipile.ts` swaps the host of every returned link; nothing else changes. Note: on a custom domain the browser-extension method falls back to the one-time code instead of the automatic handoff (Unipile limitation).

Unipile itself must never appear in customer-facing copy (app UI, marketing site, client docs, emails): say "hosted login", "the connector" or "the connected account" instead.

### 9.8 Custom tracking domains (email opens and clicks)

**This is not self-serve, and it cannot be.** Unipile authorises each domain by hand. Their documentation states no limit on the number of domains and no turnaround time. **Ask Unipile for limits and turnaround before promising customers a date.** `outreach_add_tracking_domain` only accepts workspaces on the `agency` or `agency_plus` plan, or with branding set.

1. **The customer** adds the hostname in **Settings → Email & booking** (or per mailbox on the sender page) and creates one DNS record:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `link.agency.com` | `s1.lnk-fllw.com` |

   The row starts as `pending_dns`.
2. **`outreach-domain-check`** sees the CNAME resolve and moves the row to `awaiting_approval`. It never sets `active`. If the CNAME disappears while waiting, the row goes back to `pending_dns`.
3. **You ask Unipile support to authorise the domain** for our account. Find the waiting rows:
   ```sql
   select d.hostname, w.name as workspace, s.display_name as mailbox, d.checked_at
     from outreach_tracking_domains d
     join outreach_workspaces w on w.id = d.workspace_id
     left join outreach_senders s on s.id = d.sender_id
    where d.status = 'awaiting_approval' order by d.created_at;
   ```
4. **When Unipile confirms, set the row to `active`:**
   ```sql
   update outreach_tracking_domains
      set status = 'active', approved_at = now(), note = 'Authorised by Unipile support on 2026-09-20'
    where hostname = 'link.agency.com' and status = 'awaiting_approval';
   ```
   If Unipile refuses: `update outreach_tracking_domains set status = 'failed', note = '<their reason>' where hostname = 'link.agency.com';`
5. From the next send, `outreach_tracking_domain_for(sender)` returns the hostname and the executor passes it as `tracking_options.custom_domain`. A mailbox's own domain wins over the workspace default. **Until the row is `active`, the default tracking domain is used**, so sending never waits for this.
6. Send one test email from that mailbox, check that a link in it points at the customer's hostname, and click it to confirm the redirect works. If it does not, set the row back to `awaiting_approval` and ask Unipile.

Unsubscribe and booking links carry `data-disable-tracking`, so they are never rewritten, with or without a custom domain.

### 9.9 The two small checklist items

```sql
-- `ai_auto_send` is gone from every workspace and from the column default (015)
select count(*) from outreach_workspaces where settings ? 'ai_auto_send';            -- 0
-- every read of a lead's posts has a budget row (009 + 016)
select level, per_day from outreach_warmup_caps where action_type = 'post_fetch' order by level;   -- 5,10,15,20,30,30
select per_day from outreach_platform_ceilings where action_type = 'post_fetch';                   -- 100
-- ...and the deployed code actually spends it
select s.display_name, b.day, b.used, b.cap from outreach_sender_budgets b join outreach_senders s on s.id = b.sender_id
 where b.action_type = 'post_fetch' and b.day >= current_date - 1 and b.used > 0;
```

The database side is done, and the code in the repo reserves `post_fetch` before every call to Unipile's posts endpoint (`execute.ts` for like and comment steps, `enrich.ts` for enrichment and for AI drafts). The claim "every LinkedIn call is budgeted" becomes true for the running system when `outreach-worker-tick`, `outreach-ai-draft` and `outreach-worker-enrich` are redeployed. The last query proves it: it returns rows after like steps, comment steps or AI drafts have run. No rows while those steps are running means the deployed code is still the old one.
