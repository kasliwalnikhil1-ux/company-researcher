# Outreach platform — operator runbook

Multi-sender LinkedIn/email outreach (Unipile-backed) built inside the CapitalxAI Next.js app and the CapitalxAI Supabase project `ktwqkvjuzsunssudqnrt`. This document is for whoever operates it: first-time setup, how the automation runs, what to do when it does not, and how to look inside.

PRD: `linkedin-outreach-platform-PRD.md` (repo root). Frontend conventions: `docs/outreach/FRONTEND-BRIEF.md`. SQL API: `docs/outreach/SQL-REFERENCE.md`.

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

Internal/ops/secret tables (`outreach_sender_secrets`, `outreach_sender_tokens`, `outreach_inbound_events`, `outreach_plans`, `outreach_flags`, `outreach_rate_limits`, …) sit in `public` with RLS **enabled and no policies**, so only the service role (edge functions, SQL editor) can touch them.

### 1.3 Edge functions (29, all deployed with `--no-verify-jwt`)
| Function | Trigger | Auth (in code) | Purpose |
|---|---|---|---|
| `outreach-unipile-webhook` | Unipile → HTTP | header `unipile-auth` == `UNIPILE_WEBHOOK_SECRET` | persist raw event to `outreach_inbound_events`, ack |
| `outreach-sender-notify` | Unipile hosted-auth `notify_url` | sender id in `name`/`?sid=` must exist | bind `unipile_account_id`, sync profile, onboarding gate |
| `outreach-cookie-sync` | Chrome extension | `Bearer <sender_token>` (sha256 in `outreach_sender_tokens`), 1/10 min/sender | encrypt + store `li_at`/`li_a`, switch to cookie mode, reconnect if in `credentials` |
| `outreach-stripe-webhook` | Stripe → HTTP; also web | Stripe signature; or user JWT (owner) for `{action:'checkout'|'portal'}` | subscription lifecycle → `outreach_workspaces.plan`; checkout / portal links |
| `outreach-process-inbound` | cron 10 s | `x-cron-secret` | dispatch inbound events (account status, messaging, new_relation, mail, tracking, hosted notify); dead-letter after 5 attempts |
| `outreach-worker-tick` | cron 1 min | cron | `release_waits`, `claim_due_actions(200)`, execute via Unipile, `complete_action` / `fail_action`, fill pending AI drafts; skips when flag `tick_enabled=false` or lock held |
| `outreach-worker-planner` | cron hourly (`nightly`, senders at local 00:xx) + every 20 min (`{"mode":"topup"}`) | cron | budgets + jittered action slots; skips when `planner_enabled=false` |
| `outreach-worker-health` | cron hourly (senders at local 02:xx); `{sender_id}` or `{all:true}` on demand | cron | health score, pause `<50`, warmup level-up |
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

### 1.4 pg_cron jobs (`outreach-*`, from `004_seed_cron.sql`)
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
./scripts/outreach-apply-migrations.sh                                   # 001 → 004
./scripts/outreach-apply-migrations.sh migrations/outreach/005_patches.sql   # 005 is NOT in the default list
```
The script substitutes `__FUNCTIONS_BASE_URL__` (`https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/`) and `__CRON_SECRET__` into `004_seed_cron.sql`, which writes the flag `functions_base_url` and the Vault secret `outreach_cron_secret`, and (re)schedules every `outreach-*` cron job. Re-running is safe: all files are idempotent (`create or replace`, `on conflict`, unschedule-by-name first).

Verify:
```sql
select jobname, schedule, active from cron.job where jobname like 'outreach-%' order by 1;
select key, value from outreach_flags;
select name from vault.secrets where name = 'outreach_cron_secret';
select count(*) from outreach_platform_ceilings;   -- 13
```
Ad-hoc SQL: `./scripts/outreach-sql.sh file.sql` (Management API `/database/query`).

### 2.2 Set secrets
```bash
cp .env.outreach.example .env.outreach     # git-ignored
# fill in the values, then:
./scripts/outreach-set-secrets.sh --dry-run   # shows key names only
./scripts/outreach-set-secrets.sh
```
`OUTREACH_CRON_SECRET` here **must equal** the one used in 2.1 (Vault). Empty keys are skipped. Secrets apply on the next function invocation.

### 2.3 Deploy functions
```bash
./scripts/outreach-deploy-functions.sh                       # all 28
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
2. Put the price ids in `.env.outreach` (`STRIPE_PRICE_TEAM_SENDER`, …) and re-run the secrets script.
3. Add a webhook endpoint **`https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/outreach-stripe-webhook`** with events:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.paid`.
   Copy its signing secret to `STRIPE_WEBHOOK_SECRET`.
4. Checkout sessions created by the function carry `client_reference_id` and `metadata.workspace_id`, which is how events are matched to a workspace (fallback: `stripe_customer_id`).

Plan effects: `active`/`trialing` → plan from prices, un-suspend senders paused for billing; `past_due`/`unpaid` → `past_due_since` set, suspended by `billing-sync` after 7 days (senders paused with `status_reason='billing_suspended'`); `canceled`/deleted → `plan='suspended'`. Trial workspaces (14 days, max 3 senders) are suspended by `billing-sync` when the trial ends without a subscription.

### 2.6 Resend
Verify the sending domain in Resend, set `RESEND_API_KEY` and `OUTREACH_EMAIL_FROM` (e.g. `CapitalxAI Outreach <no-reply@capitalxai.com>`). Emails sent: reconnect needed (with hosted re-login link), automatic reconnect failed, sender paused, sender error, warmup level up, workspace invitation. Without a key the functions log `RESEND_API_KEY unset` and continue.

### 2.7 Gemini (AI)
`GEMINI_API_KEY` + optional `OUTREACH_AI_MODEL` (default `gemini-3-flash-preview`, falling back to `GEMINI_MODEL_ID`). This is the same key and model family the rest of the app uses (`utils/azureOpenAiHelper.ts`), called over the REST `generateContent` endpoint: system instruction separated, `thinkingLevel: MEDIUM` + `responseMimeType: application/json` for the JSON tasks, thought parts skipped, markdown fences stripped. Every call is recorded in `outreach_ai_calls` (hashes + token counts) and audited. Without a key: replies are stored as `unclear` (confidence 0), sequence QA returns static checks only (`ai_available:false`), AI drafts cannot be generated.

### 2.8 Chrome extension
Ship `extension/` unpacked during beta (see `extension/README.md`). Pairing token: Sender detail → Extension tab → *Generate pairing token* (RPC `outreach_issue_sender_token`, manager+, shown once).

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

**Rotate the cron secret**: put the new value in `.env.outreach` → run the secrets script → re-run `004_seed_cron.sql` with the new `OUTREACH_CRON_SECRET` (updates Vault). Between the two steps workers answer `401`.

**Change the functions base URL**: `update outreach_flags set value = to_jsonb('https://…/functions/v1/'::text) where key = 'functions_base_url';` (trailing slash required) and set `OUTREACH_FUNCTIONS_BASE_URL` so hosted-auth callbacks use it too.

---

## 4. Environment variables (PRD Appendix A → this implementation)

| PRD name | Implementation | Set where | Notes |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | same | injected by the platform | never put in `.env.outreach` |
| `UNIPILE_DSN`, `UNIPILE_API_KEY` | same | secrets | DSN with or without `https://` |
| `UNIPILE_WEBHOOK_SECRET` | same | secrets | `unipile-auth` header check in `outreach-unipile-webhook`; sent by `outreach-unipile-setup` when registering |
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
-- restore
update outreach_workspaces set plan='team', past_due_since=null where id=…;
update outreach_senders set status='ok', status_reason=null where workspace_id=… and status='paused' and status_reason in ('billing_suspended','trial_expired');
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
| 5 | Reply → exit | inbound `message_received` → `replied=true` → trigger `outreach_lss_reply_exit` sets enrollment `exited_replied`, cancels queued actions (`decision='reply_exit'`), `outreach_node_stats.replied++`; `send_always` nodes are exempt |
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
