# PRD: Multi-Sender Outreach Platform (Unipile · Supabase · React)

**Document:** Product Requirements Document, engineering-grade
**Version:** 1.0 · 15 September 2026
**Companion:** `linkedin-outreach-platform-product-plan.md` (strategy, competitive teardown, roadmap)
**Working name:** `outreach` (repo `outreach-platform`)

---

## 1. Document control

| Item | Value |
|---|---|
| Owner | Aarushi (product) |
| Engineering | 2 full-stack (TS/Postgres), 1 part-time frontend |
| Status | Draft for build kickoff |
| Target | v1 GA at end of week 12; MVP internal alpha end of week 6 |
| Out of scope for v1 | WhatsApp/Instagram channels, Recruiter hiring projects, whitelabel domains, identity rental of any kind, browser-based transport |

### 1.1 Definitions

| Term | Meaning |
|---|---|
| Workspace | Tenant. An agency or a company. All data is scoped here. |
| Client | Sub-grouping inside a workspace (an agency's customer). Optional. |
| Sender | A connected external identity: one LinkedIn profile, one mailbox. Maps 1:1 to a Unipile `account_id`. |
| Lead | A person we may contact. Workspace-scoped. |
| Sequence | A versioned DAG of nodes. |
| Enrollment | One lead travelling through one sequence via one sender. |
| Action | A single scheduled unit of outbound work (send invite, view profile). |
| Budget | Per-sender, per-day, per-action-type cap with reservation semantics. |
| Ledger | The `sender_budgets` table and the reservation function. The only gate to Unipile writes. |
| Health | Per-sender 0–100 score; min across categories. |
| Warmup level | 0–5; determines cap table row. |
| Ceiling | Hardcoded platform maximum per action type; never user-adjustable upward. |

---

## 2. Goals and success metrics

### 2.1 Goals
1. An agency operator runs 10–150 real LinkedIn senders plus mailboxes from one inbox.
2. Every outbound action passes through a database-enforced budget; no code path bypasses it.
3. Reply → stop is a data invariant with <60s latency from webhook receipt.
4. Session drops are recovered without user action when the extension is installed; otherwise the user is notified within 5 hours.
5. AI classifies every inbound reply; nothing AI-authored is sent without human approval in v1.

### 2.2 Success metrics (v1, 90 days post-GA)
| Metric | Target |
|---|---|
| Senders restricted by LinkedIn per 100 sender-months | < 2 |
| Actions executed outside sender schedule window | 0 |
| Double-sends (same enrollment+node executed twice) | 0 |
| Median reply→exit latency | < 30s |
| Reconnect success without user action (extension installed) | > 90% |
| Webhook 2xx within 30s | > 99.9% |
| Inbox message visibility after Unipile webhook | < 5s p95 |
| Planner completes nightly for all senders | 100% before first schedule window opens |

---

## 3. Personas and user stories

### 3.1 Personas
- **Agency Owner (Owner):** buys, configures billing, invites team, sees everything.
- **Campaign Manager (Manager):** builds sequences, imports leads, runs all clients' senders.
- **SDR (Member):** works the inbox for assigned clients, completes tasks.
- **Client Viewer:** the agency's customer; reads their own inbox and stats; may reply if granted.
- **Sender Owner:** the human whose LinkedIn is connected; may be any of the above or none (a client's employee). Receives connection and reconnect emails.

### 3.2 User stories (v1)

**Connection**
- US-01 As a Manager I connect a client's LinkedIn by sending them a link; they log in without giving me their password.
- US-02 As a Sender Owner I see which sessions/apps have access and can revoke from LinkedIn.
- US-03 As a Manager I see a sender's status, proxy country, last sync, health, today's budget usage.
- US-04 As a Manager I set a sender's working hours and timezone; nothing runs outside them.
- US-05 As a Manager I am told when a sender needs re-login, and it auto-recovers if the extension is installed.

**Leads**
- US-10 As a Manager I paste a LinkedIn or Sales Navigator search URL and get leads imported over the coming days within limits.
- US-11 As a Manager I upload a CSV and map columns.
- US-12 As a Manager I tag, list, stage and suppress leads.
- US-13 As a Manager I see for each lead which senders have contacted them and the relation state.

**Sequences**
- US-20 As a Manager I build a sequence from nodes with branches and delays.
- US-21 As a Manager I preview how long a sequence will take for N leads on this sender at its current level.
- US-22 As a Manager I activate/pause/archive; in-flight leads are handled explicitly.
- US-23 As a Manager I see per-node stats (queued, sent, accepted, replied, failed).
- US-24 As a Manager I restore a previous version.
- US-25 As a Manager I enrol leads into a sequence with a sender pool and rotation.

**Inbox**
- US-30 As an SDR I see all conversations for my senders in one list, filtered by intent/unread/client.
- US-31 As an SDR I reply; replies do not count against outbound caps.
- US-32 As an SDR I see AI intent and can correct it.
- US-33 As an SDR I convert a reply into a task, tag, stage change, or re-enrollment.

**Safety**
- US-40 As an Owner I cannot raise caps above the platform ceiling; I can lower them.
- US-41 As a Manager I see why a sender is throttled or paused, with the exact signal.
- US-42 As a Manager I see a new/thin account forced into warmup and the reason.

**Admin**
- US-50 As an Owner I manage members, roles, clients, billing.
- US-51 As an Owner I export leads, messages, and audit log.
- US-52 As an Owner I set outbound webhooks for events.

---

## 4. Functional requirements

IDs are stable; reference them in tickets.

### 4.1 Workspace and identity
- FR-WS-01 Supabase Auth (email+password, magic link, Google). One user may belong to many workspaces.
- FR-WS-02 Roles: `owner`, `manager`, `member`, `client_viewer`. Permission matrix in §11.3.
- FR-WS-03 Clients are optional partitions; senders, leads, sequences carry nullable `client_id`.
- FR-WS-04 Invitations by email with role and optional client scope; expire in 7 days.

### 4.2 Senders
- FR-SN-01 Connect LinkedIn via Unipile Hosted Auth with `country`/`ip` derived from the connecting browser's request; Recruiter feature disabled unless workspace flag `recruiter_enabled`.
- FR-SN-02 Connect Gmail/Outlook via Unipile Hosted Auth (OAuth handled by Unipile).
- FR-SN-03 Store only `unipile_account_id` for credentials-mode senders. Cookie-mode secrets in `sender_secrets`, encrypted with Vault key.
- FR-SN-04 Capture and persist `user_agent` at connect. Required for cookie mode.
- FR-SN-05 Status machine: `connecting → ok → {credentials|error} → ok` plus `paused`, `disabled`. Driven by `account_status` webhook and internal health.
- FR-SN-06 Schedule: per weekday list of `[start,end]` local-time windows; default Mon–Fri 09:00–18:00; timezone required.
- FR-SN-07 Warmup level 0–5 with onboarding gate (§7.6 of plan): connections <150 or unknown → level 0 for ≥28 days.
- FR-SN-08 Health score per §14.3; recomputed nightly and on every disconnect/reject event.
- FR-SN-09 Proxy: pin at connect; user may change country; system may replace within same country on proxy error; every change audited.
- FR-SN-10 Reconnect loop on `CREDENTIALS`: hourly ×4 with latest cookie (cookie mode) or immediate re-auth link email (credentials mode).
- FR-SN-11 Sender disable: cancels queued actions, exits enrollments with `exited_sender_disabled`, deletes Unipile account on explicit confirm.

### 4.3 Leads
- FR-LD-01 Dedupe key: `linkedin_public_identifier` (case-insensitive) else `email_work` else `email_personal`.
- FR-LD-02 Import job types: `search_url`, `csv`, `relations`. Jobs run over days under `search_page` and `profile_view` budgets.
- FR-LD-03 Lead fields: identity, headline, company, location, emails, `is_open_profile`, custom JSONB, tags, list, stage, `do_not_contact`.
- FR-LD-04 Per (lead, sender) relation state tracked separately from lead.
- FR-LD-05 Suppression: `do_not_contact` on lead; domain suppression list per workspace; global `unsubscribed` from email.
- FR-LD-06 Bulk operations (tag, list, stage, enrol, delete) capped at 10k per request.

### 4.4 Sequences
- FR-SQ-01 Graph stored as JSONB per schema §13.1; validated server-side on save.
- FR-SQ-02 Every save creates a version row; restore copies a version to head.
- FR-SQ-03 Node types per §13.2; each with config schema and validation.
- FR-SQ-04 Activation requires: ≥1 sender in pool, all senders `ok`, graph valid, at least one exit path, no email node if no mailbox in pool.
- FR-SQ-05 Enrollment states per §13.4.
- FR-SQ-06 Node deletion prompts `skip` or `cancel` for in-flight enrollments; choice recorded.
- FR-SQ-07 Projection: given N leads and pool, compute expected completion date from budgets.
- FR-SQ-08 One active enrollment per (lead, sender). Enrolling into a second sequence requires exit of the first.
- FR-SQ-09 Sender pool assignment strategies: `round_robin`, `least_loaded`, `fixed`.

### 4.5 Actions and scheduling
- FR-AC-01 Planner runs nightly per sender in sender local time, producing `actions` with `scheduled_for` for the next window day.
- FR-AC-02 Every `scheduled_for` is jittered; no value lands on :00 or :30.
- FR-AC-03 Tick runs every minute; `FOR UPDATE SKIP LOCKED`; per-sender concurrency 1.
- FR-AC-04 Budget reservation is atomic with dequeue (§6.7 function).
- FR-AC-05 Idempotency key on every action; unique index.
- FR-AC-06 Profile retrieval is scheduled 5–40 min before dependent send, never batched.
- FR-AC-07 Error handling table §14.5 implemented as a pure function `handleUnipileError(code, ctx) → decision`.
- FR-AC-08 Actions for exited/paused enrollments are cancelled by trigger, not by the tick.

### 4.6 Inbox
- FR-IB-01 Backfill chats/messages on `SYNC_SUCCESS`.
- FR-IB-02 `new_message` webhook → `messages` row within 5s; Realtime pushes to UI.
- FR-IB-03 Reply from UI → `POST chats/{id}/messages` via `send-reply` function; counts as `reply` type (uncapped) but logged.
- FR-IB-04 Attachments proxied via signed function URL; never expose Unipile URLs.
- FR-IB-05 Edit/delete exposed only within 60 minutes of send (LinkedIn) and for LinkedIn Classic edits.
- FR-IB-06 Intent classification on every inbound message with `direction='in'`.
- FR-IB-07 Assignment of chats to members; unread counters per member.

### 4.7 Safety
- FR-SF-01 Ceilings in `platform_ceilings` table, seeded, editable only by service role.
- FR-SF-02 Level cap table in `warmup_caps`, seeded.
- FR-SF-03 Health < 50 pauses sender; 50–69 scales caps ×0.6; ≥85 for 14 days enables level-up.
- FR-SF-04 Weekly invite cap enforced across all sequences on a sender.
- FR-SF-05 Relation polling ≤3/day at random offsets, only for senders with pending no-note invites.
- FR-SF-06 Any rejected code increments `rejects_24h`; ≥3 `429/500` in 1h → pause 24h.

### 4.8 AI
- FR-AI-01 Classify inbound → `intent`, `confidence`, `summary`.
- FR-AI-02 Draft opener/comment → approval queue; never auto-send in v1.
- FR-AI-03 Sequence QA on activation → non-blocking warnings, blocking errors for ceiling violations.
- FR-AI-04 All prompts/responses hashed to `audit_log`.

### 4.9 Billing
- FR-BL-01 Stripe subscription per workspace; quantity = active senders (LinkedIn + mailboxes beyond included).
- FR-BL-02 Nightly usage sync sets Stripe quantity to peak active senders in period.
- FR-BL-03 Past-due → read-only after 7 days; senders paused, not deleted.

### 4.10 Integrations out
- FR-IO-01 Outbound webhooks on events (§12.5) with HMAC signature and retry.
- FR-IO-02 CSV export of leads, messages, actions, audit.

---

## 5. Non-functional requirements

| Area | Requirement |
|---|---|
| Availability | 99.5% for app and webhook receiver; provider outages excluded |
| Webhook ack | 2xx within 2s p99 (target), hard limit 30s |
| Tick latency | Due action executed within 90s of `scheduled_for` p95 |
| Realtime | Inbox update ≤5s p95 from Unipile webhook |
| Scale (v1) | 5,000 senders, 5M leads, 50M actions/year, 20M messages |
| Data residency | Supabase region EU (Frankfurt) default; US project optional per workspace on Agency+ |
| Security | RLS on every tenant table; service role only in Edge Functions; Vault for secrets; no secrets in client bundle |
| Privacy | Cookies encrypted at rest; deletable; DPA available; audit of every access to `sender_secrets` |
| Observability | Structured logs, traces per action, dashboards per §17 |
| Backups | PITR 7 days; nightly logical dump to object storage |
| Accessibility | WCAG 2.1 AA for inbox and builder |
| Browser | Last 2 versions Chrome/Edge/Firefox/Safari; extension Chrome MV3 |

---

## 6. System architecture

### 6.1 Components

| Component | Tech | Responsibility |
|---|---|---|
| Web app | React 18, Vite, TypeScript, TanStack Query, Zustand, React Flow (builder), Tailwind + shadcn/ui | UI |
| API | Supabase PostgREST + RPC (SQL functions) for CRUD; Edge Functions for anything touching Unipile, AI, Stripe, or secrets | Backend |
| DB | Postgres 15 (Supabase) with `pg_cron`, `pgmq`, `pg_net`, `pgsodium/Vault` | State, scheduling, queue |
| Workers | Edge Functions invoked by `pg_cron` via `pg_net` HTTP, or `pgmq` consumers | Planner, tick, health, reconnect |
| Realtime | Supabase Realtime on `messages`, `chats`, `senders`, `actions` (filtered by workspace) | Live UI |
| Storage | Supabase Storage bucket `attachments` (private), `exports` (private, signed URLs) | Files |
| Extension | Chrome MV3, TypeScript | Cookie sync |
| External | Unipile API + webhooks; Anthropic API; Stripe; Resend (email) | |

### 6.2 Request paths

**Outbound action (the only path to LinkedIn writes)**
```
pg_cron (every minute) → pg_net POST /functions/v1/worker-tick
  → SQL: claim_due_actions(limit) [FOR UPDATE SKIP LOCKED + reserve_budget()]
  → for each action: unipileClient.execute(action)
  → SQL: complete_action(id, response) | fail_action(id, code, decision)
```

**Inbound webhook**
```
Unipile → POST /functions/v1/unipile-webhook
  → verify header secret → INSERT inbound_events → 200
pg_cron (every 10s via pgmq) → process_inbound_events()
  → dispatch by (source,event) → mutate senders/messages/lead_sender_state
  → triggers cascade (exit enrollments, cancel actions)
```

**UI reply**
```
React → POST /functions/v1/send-reply {chat_id, text}
  → RLS check via user JWT → log action(type=reply) → Unipile POST → insert message
```

### 6.3 Environments
`local` (supabase CLI + Unipile sandbox account) → `staging` (separate Supabase project, separate Unipile DSN, Stripe test) → `prod`. Migrations via `supabase db push` from CI; Edge Functions deployed by CI on tag.

### 6.4 Repository layout
```
/apps/web            React app
/apps/extension      Chrome MV3
/supabase/migrations SQL, numbered
/supabase/functions  one folder per Edge Function
/supabase/seed.sql   ceilings, warmup caps, intents
/packages/shared     zod schemas (graph, node configs, webhook payloads), error codes, types
/packages/unipile    typed client wrapper + error mapping + rate guard
/docs                this PRD, runbooks
```

---

## 7. Database design

Postgres 15. Schema `public` for tenant data, `private` for secrets and internal functions (no PostgREST exposure), `ops` for queues and events.

### 7.1 Extensions
```sql
create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists pgmq;
create extension if not exists supabase_vault;
create schema if not exists private;
create schema if not exists ops;
```

### 7.2 Enums
```sql
create type role_t          as enum ('owner','manager','member','client_viewer');
create type provider_t      as enum ('LINKEDIN','GMAIL','OUTLOOK','IMAP');
create type auth_method_t   as enum ('credentials','cookie','oauth');
create type sender_status_t as enum ('connecting','ok','credentials','error','paused','disabled');
create type relation_t      as enum ('none','pending_out','pending_in','first','blocked','invalid');
create type action_type_t   as enum ('profile_view','invite','withdraw','message','inmail','like','comment',
                                     'endorse','search_page','email','reply','relations_poll');
create type action_status_t as enum ('queued','reserved','sent','skipped','failed','cancelled');
create type enrollment_status_t as enum ('active','waiting_connection','waiting_delay','waiting_task',
                                          'paused','completed','exited_replied','exited_manual',
                                          'exited_suppressed','exited_sender_disabled','failed','cancelled');
create type sequence_status_t as enum ('draft','active','paused','archived');
create type direction_t     as enum ('in','out');
create type intent_t        as enum ('interested','question','not_now','not_interested','ooo',
                                     'wrong_person','unclear','unclassified');
create type import_kind_t   as enum ('search_url','csv','relations');
create type job_status_t    as enum ('queued','running','paused','done','failed','cancelled');
create type task_kind_t     as enum ('manual_node','follow_up','review_ai_draft','reconnect');
```

### 7.3 Tenant core
```sql
create table workspaces (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  plan          text not null default 'trial',        -- trial|team|agency|agency_plus
  stripe_customer_id text,
  stripe_subscription_id text,
  settings      jsonb not null default '{}',           -- {recruiter_enabled:false, ai_auto_send:false,...}
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table clients (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  timezone      text,
  created_at    timestamptz not null default now()
);
create index on clients(workspace_id);

create table members (
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          role_t not null,
  client_ids    uuid[] not null default '{}',          -- scope for member/client_viewer; empty = all (manager/owner)
  can_reply     boolean not null default true,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on members(user_id);

create table invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  email         citext not null,
  role          role_t not null,
  client_ids    uuid[] not null default '{}',
  token         text unique not null default encode(gen_random_bytes(24),'hex'),
  expires_at    timestamptz not null default now() + interval '7 days',
  accepted_at   timestamptz,
  created_by    uuid references auth.users(id)
);
```

### 7.4 Senders
```sql
create table senders (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references workspaces(id) on delete cascade,
  client_id          uuid references clients(id) on delete set null,
  owner_user_id      uuid references auth.users(id),      -- optional: the human who owns the identity
  owner_email        citext,                              -- for reconnect emails when not a user
  provider           provider_t not null,
  unipile_account_id text unique,
  auth_method        auth_method_t not null,
  display_name       text,
  public_identifier  text,                                -- linkedin slug or email address
  provider_user_id   text,                                -- linkedin provider id / plainId
  is_premium         boolean not null default false,
  has_sales_nav      boolean not null default false,
  has_recruiter      boolean not null default false,
  connections_count  int,
  status             sender_status_t not null default 'connecting',
  status_reason      text,
  proxy_country      char(2),
  proxy_ip_hint      inet,
  user_agent         text,
  timezone           text not null default 'UTC',
  schedule           jsonb not null default
    '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],
      "thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[],"sun":[]}',
  warmup_level       smallint not null default 0 check (warmup_level between 0 and 5),
  warmup_locked_until date,                               -- onboarding gate
  health_score       smallint not null default 100 check (health_score between 0 and 100),
  health_breakdown   jsonb not null default '{}',
  manual_caps        jsonb not null default '{}',         -- user-lowered caps {invite:20,...}; never above ceiling
  rejects_1h         int not null default 0,
  paused_until       timestamptz,
  connected_at       timestamptz,
  last_ok_at         timestamptz,
  last_disconnect_at timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index on senders(workspace_id, status);
create index on senders(unipile_account_id);

-- private: cookie secrets, service role only
create table private.sender_secrets (
  sender_id           uuid primary key references senders(id) on delete cascade,
  li_at_enc           bytea,
  li_a_enc            bytea,
  cookie_captured_at  timestamptz,
  cookie_ip           inet,
  cookie_user_agent   text,
  updated_at          timestamptz not null default now()
);
create table private.secret_access_log (
  id         bigserial primary key,
  sender_id  uuid,
  fn         text not null,
  at         timestamptz not null default now()
);

create table platform_ceilings (               -- seeded; service-role editable only
  action_type  action_type_t primary key,
  per_day      int not null,
  per_week     int
);
insert into platform_ceilings values
  ('invite',80,150),('profile_view',100,null),('message',100,null),('inmail',50,null),
  ('like',100,null),('comment',100,null),('endorse',50,null),('search_page',50,null),
  ('withdraw',20,null),('email',150,null),('reply',100000,null),('relations_poll',3,null);

create table warmup_caps (                     -- seeded
  level        smallint not null,
  action_type  action_type_t not null,
  per_day      int not null,
  primary key (level, action_type)
);
-- seed.sql fills levels 0..5 per plan §7.2

create table sender_budgets (
  sender_id    uuid not null references senders(id) on delete cascade,
  day          date not null,                  -- sender-local date
  action_type  action_type_t not null,
  cap          int not null,
  used         int not null default 0,
  reserved     int not null default 0,
  primary key (sender_id, day, action_type),
  check (used + reserved <= cap)
);

create table sender_events (                   -- status history, health changes, proxy changes
  id         bigserial primary key,
  sender_id  uuid not null references senders(id) on delete cascade,
  kind       text not null,                    -- status|health|proxy|warmup|reconnect|reject
  data       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index on sender_events(sender_id, at desc);
```

### 7.5 Leads
```sql
create table lists (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id uuid references clients(id) on delete set null,
  name text not null
);
create table stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name text not null, position int not null
);
create table tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  name citext not null, color text,
  unique (workspace_id, name)
);

create table leads (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  client_id           uuid references clients(id) on delete set null,
  public_identifier   citext,                     -- linkedin slug
  provider_id         text,                       -- linkedin urn/id, filled after profile fetch
  profile_url         text,
  first_name          text, last_name text, full_name text,
  headline            text, company text, company_id text, title text, location text,
  email_work          citext, email_personal citext,
  is_open_profile     boolean,
  custom              jsonb not null default '{}',
  list_id             uuid references lists(id) on delete set null,
  stage_id            uuid references stages(id) on delete set null,
  do_not_contact      boolean not null default false,
  source              text,
  import_job_id       uuid,
  last_profile_fetch_at timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index leads_ws_pubid on leads(workspace_id, public_identifier) where public_identifier is not null;
create unique index leads_ws_email on leads(workspace_id, email_work) where email_work is not null and public_identifier is null;
create index on leads(workspace_id, client_id);
create index on leads using gin (custom);

create table lead_tags (
  lead_id uuid references leads(id) on delete cascade,
  tag_id  uuid references tags(id) on delete cascade,
  primary key (lead_id, tag_id)
);

create table lead_sender_state (
  lead_id             uuid not null references leads(id) on delete cascade,
  sender_id           uuid not null references senders(id) on delete cascade,
  relation            relation_t not null default 'none',
  invitation_id       text,
  invite_sent_at      timestamptz,
  invite_accepted_at  timestamptz,
  invite_withdrawn_at timestamptz,
  unipile_chat_id     text,
  last_outbound_at    timestamptz,
  last_inbound_at     timestamptz,
  replied             boolean not null default false,
  updated_at          timestamptz not null default now(),
  primary key (lead_id, sender_id)
);
create index on lead_sender_state(sender_id, relation);

create table suppressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind text not null check (kind in ('domain','public_identifier','email')),
  value citext not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (workspace_id, kind, value)
);

create table import_jobs (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  client_id     uuid references clients(id),
  sender_id     uuid references senders(id),     -- which account performs the search
  kind          import_kind_t not null,
  params        jsonb not null,                  -- {url, api:'classic'|'sales_navigator', filters} | {storage_path, mapping}
  status        job_status_t not null default 'queued',
  total_expected int, fetched int not null default 0, created_leads int not null default 0,
  next_offset   int not null default 0,
  next_run_at   timestamptz,
  error         text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  finished_at   timestamptz
);
create index on import_jobs(status, next_run_at);
```

### 7.6 Sequences, enrollments, actions
```sql
create table sequences (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  client_id     uuid references clients(id) on delete set null,
  name          text not null,
  status        sequence_status_t not null default 'draft',
  head_version  int not null default 1,
  graph         jsonb not null,                        -- current head, denormalised
  sender_pool   uuid[] not null default '{}',
  assignment    text not null default 'round_robin',   -- round_robin|least_loaded|fixed
  use_sender_schedule boolean not null default true,
  settings      jsonb not null default '{}',           -- {stop_on_reply:true, withdraw_after_days:21,...}
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  archived_at   timestamptz
);
create index on sequences(workspace_id, status);

create table sequence_versions (
  sequence_id uuid not null references sequences(id) on delete cascade,
  version     int not null,
  graph       jsonb not null,
  created_by  uuid, created_at timestamptz not null default now(),
  primary key (sequence_id, version)
);

create table enrollments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  sequence_id      uuid not null references sequences(id) on delete cascade,
  sequence_version int not null,
  lead_id          uuid not null references leads(id) on delete cascade,
  sender_id        uuid not null references senders(id) on delete cascade,
  status           enrollment_status_t not null default 'active',
  current_node_id  text,
  node_entered_at  timestamptz not null default now(),
  wait_until       timestamptz,                         -- for delay / wait_connection window end
  exit_reason      text,
  restart_count    int not null default 0,
  priority         int not null default 100,
  created_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create unique index enr_active_unique on enrollments(lead_id, sender_id)
  where status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
create index on enrollments(sequence_id, status);
create index on enrollments(sender_id, status, wait_until);

create table actions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  enrollment_id    uuid references enrollments(id) on delete cascade,   -- null for imports/polls/replies
  import_job_id    uuid references import_jobs(id) on delete cascade,
  sender_id        uuid not null references senders(id) on delete cascade,
  lead_id          uuid references leads(id) on delete cascade,
  node_id          text,
  action_type      action_type_t not null,
  scheduled_for    timestamptz not null,
  status           action_status_t not null default 'queued',
  attempt          int not null default 1,
  idempotency_key  text not null unique,
  payload          jsonb not null default '{}',          -- rendered text, ids, api choice
  response         jsonb,
  error_code       text,
  decision         text,                                 -- what handleUnipileError decided
  reserved_at      timestamptz, executed_at timestamptz,
  created_at       timestamptz not null default now()
);
create index actions_due on actions(scheduled_for) where status = 'queued';
create index on actions(sender_id, status, scheduled_for);
create index on actions(enrollment_id);

create table node_stats (                       -- materialised counters for builder overlays
  sequence_id uuid not null, node_id text not null,
  queued int default 0, sent int default 0, failed int default 0, skipped int default 0,
  accepted int default 0, replied int default 0,
  primary key (sequence_id, node_id)
);
```

### 7.7 Inbox
```sql
create table chats (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references workspaces(id) on delete cascade,
  sender_id        uuid not null references senders(id) on delete cascade,
  lead_id          uuid references leads(id) on delete set null,
  unipile_chat_id  text not null,
  provider         provider_t not null,
  attendee_provider_id text,
  attendee_name    text,
  subject          text,                        -- email
  last_message_at  timestamptz,
  last_direction   direction_t,
  unread           boolean not null default false,
  assigned_to      uuid references auth.users(id),
  intent           intent_t not null default 'unclassified',
  archived         boolean not null default false,
  unique (sender_id, unipile_chat_id)
);
create index on chats(workspace_id, last_message_at desc);
create index on chats(lead_id);

create table messages (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references workspaces(id) on delete cascade,
  chat_id             uuid not null references chats(id) on delete cascade,
  unipile_message_id  text unique,
  direction           direction_t not null,
  text                text,
  html                text,                     -- email
  attachments         jsonb not null default '[]',
  sent_at             timestamptz not null,
  is_invite_note      boolean not null default false,
  intent              intent_t, intent_confidence real, summary text, classified_at timestamptz,
  action_id           uuid references actions(id),
  created_at          timestamptz not null default now()
);
create index on messages(chat_id, sent_at);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind task_kind_t not null,
  lead_id uuid references leads(id) on delete cascade,
  sender_id uuid references senders(id) on delete cascade,
  enrollment_id uuid references enrollments(id) on delete cascade,
  node_id text,
  chat_id uuid references chats(id) on delete set null,
  title text not null, body text,
  ai_draft text,                                 -- for review_ai_draft
  due_at timestamptz, assigned_to uuid references auth.users(id),
  completed_at timestamptz, completed_by uuid,
  created_at timestamptz not null default now()
);
create index on tasks(workspace_id, completed_at, due_at);
```

### 7.8 Ops, events, audit
```sql
create table ops.inbound_events (
  id            bigserial primary key,
  source        text not null,                  -- account_status|messaging|users|mail|mail_tracking|calendar
  event_type    text,
  unipile_account_id text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text,
  attempts      int not null default 0
);
create index on ops.inbound_events(processed_at) where processed_at is null;

select pgmq.create('inbound');       -- webhook fan-out
select pgmq.create('ai_classify');
select pgmq.create('outbound_webhooks');

create table outbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  url text not null, secret text not null, events text[] not null, active boolean default true
);
create table outbound_webhook_deliveries (
  id bigserial primary key, webhook_id uuid references outbound_webhooks(id) on delete cascade,
  event text, payload jsonb, status int, attempts int default 0, next_at timestamptz, delivered_at timestamptz
);

create table audit_log (
  id bigserial primary key,
  workspace_id uuid, actor uuid, actor_type text default 'user',   -- user|system|ai
  action text not null, entity text, entity_id text, diff jsonb, at timestamptz not null default now()
);
create index on audit_log(workspace_id, at desc);

create table ai_calls (
  id bigserial primary key, workspace_id uuid, purpose text, model text,
  prompt_sha256 text, response_sha256 text, tokens_in int, tokens_out int, latency_ms int,
  at timestamptz not null default now()
);

create table billing_usage (
  workspace_id uuid references workspaces(id), day date, active_senders int, active_mailboxes int,
  primary key (workspace_id, day)
);
```

### 7.9 Row-level security

Helper:
```sql
create or replace function auth.workspace_ids() returns setof uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from members where user_id = auth.uid()
$$;

create or replace function auth.role_in(ws uuid) returns role_t
language sql stable security definer set search_path = public as $$
  select role from members where user_id = auth.uid() and workspace_id = ws
$$;

create or replace function auth.client_visible(ws uuid, cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from members m where m.user_id = auth.uid() and m.workspace_id = ws
      and (m.role in ('owner','manager') or cid is null or cid = any(m.client_ids))
  )
$$;
```

Pattern applied to every tenant table (`senders, leads, sequences, enrollments, actions, chats, messages, tasks, lists, stages, tags, import_jobs, suppressions, outbound_webhooks, audit_log, clients`):
```sql
alter table leads enable row level security;

create policy leads_select on leads for select
  using (workspace_id in (select auth.workspace_ids()) and auth.client_visible(workspace_id, client_id));

create policy leads_write on leads for all
  using (auth.role_in(workspace_id) in ('owner','manager','member')
         and auth.client_visible(workspace_id, client_id))
  with check (auth.role_in(workspace_id) in ('owner','manager','member')
         and auth.client_visible(workspace_id, client_id));
```
Special cases:
- `workspaces`: select if member; update if owner.
- `members`, `invitations`, `outbound_webhooks`, billing: owner only for write; select for owner/manager.
- `actions`, `enrollments`, `sender_budgets`, `node_stats`: **select only** for users. All writes via SQL functions (`security definer`) or service role.
- `messages` insert for users only via `send-reply` function (service role). Users get select.
- `private.*`, `ops.*`: no policies; not exposed via PostgREST (schema not in `pgrst.db_schemas`).
- `platform_ceilings`, `warmup_caps`: select for all authenticated; no user write.

### 7.10 Triggers

```sql
-- 1. Reply → exit enrollments and cancel queued actions
create or replace function trg_reply_exit() returns trigger language plpgsql as $$
begin
  if new.replied and not coalesce(old.replied,false) then
    update enrollments set status='exited_replied', exit_reason='replied', completed_at=now()
      where lead_id=new.lead_id and sender_id=new.sender_id
        and status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
    update actions set status='cancelled', decision='reply_exit'
      where lead_id=new.lead_id and sender_id=new.sender_id and status in ('queued','reserved')
        and action_type <> 'reply';
  end if;
  return new;
end $$;
create trigger lss_reply_exit after update of replied on lead_sender_state
  for each row execute function trg_reply_exit();

-- 2. Enrollment leaves active → cancel its queued actions
create or replace function trg_enrollment_exit() returns trigger language plpgsql as $$
begin
  if new.status not in ('active','waiting_connection','waiting_delay','waiting_task')
     and old.status in ('active','waiting_connection','waiting_delay','waiting_task') then
    update actions set status='cancelled', decision='enrollment_'||new.status
      where enrollment_id=new.id and status in ('queued','reserved');
  end if;
  return new;
end $$;
create trigger enr_exit after update of status on enrollments for each row execute function trg_enrollment_exit();

-- 3. Sender leaves ok → pause everything
create or replace function trg_sender_status() returns trigger language plpgsql as $$
begin
  if new.status <> 'ok' and old.status = 'ok' then
    update actions set status='queued', reserved_at=null where sender_id=new.id and status='reserved';
    insert into sender_events(sender_id,kind,data) values (new.id,'status',jsonb_build_object('from',old.status,'to',new.status,'reason',new.status_reason));
  end if;
  if new.status = 'ok' and old.status <> 'ok' then
    insert into sender_events(sender_id,kind,data) values (new.id,'status',jsonb_build_object('from',old.status,'to','ok'));
  end if;
  return new;
end $$;
create trigger sender_status after update of status on senders for each row execute function trg_sender_status();

-- 4. Suppression → exit
create or replace function trg_lead_dnc() returns trigger language plpgsql as $$
begin
  if new.do_not_contact and not old.do_not_contact then
    update enrollments set status='exited_suppressed', exit_reason='do_not_contact', completed_at=now()
      where lead_id=new.id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
  end if;
  return new;
end $$;
create trigger lead_dnc after update of do_not_contact on leads for each row execute function trg_lead_dnc();

-- 5. updated_at maintenance on leads, senders, sequences, lead_sender_state (standard)
-- 6. sequence save → version row (in save_sequence() function, not trigger, to carry actor)
-- 7. node_stats increments in complete_action()/fail_action()
```

### 7.11 Core SQL functions (security definer, called by Edge Functions)

```sql
-- Reserve budget atomically. Returns true if reserved.
create or replace function private.reserve_budget(p_sender uuid, p_day date, p_type action_type_t)
returns boolean language plpgsql as $$
declare ok boolean;
begin
  update sender_budgets set reserved = reserved + 1
   where sender_id=p_sender and day=p_day and action_type=p_type and used + reserved < cap
   returning true into ok;
  return coalesce(ok,false);
end $$;

-- Claim due actions across senders, one per sender, respecting schedule and status.
create or replace function private.claim_due_actions(p_limit int)
returns setof actions language plpgsql as $$
begin
  return query
  with candidates as (
    select distinct on (a.sender_id) a.*
    from actions a
    join senders s on s.id = a.sender_id
    where a.status='queued' and a.scheduled_for <= now()
      and s.status='ok' and (s.paused_until is null or s.paused_until < now())
      and private.in_schedule(s.id, now())
      and not exists (select 1 from actions r where r.sender_id=a.sender_id and r.status='reserved')
    order by a.sender_id, a.scheduled_for
    limit p_limit
    for update of a skip locked
  ), reserved as (
    update actions a set status='reserved', reserved_at=now()
    from candidates c
    where a.id=c.id
      and private.reserve_budget(c.sender_id, private.sender_local_date(c.sender_id, now()), c.action_type)
    returning a.*
  )
  select * from reserved;
end $$;

create or replace function private.complete_action(p_id uuid, p_response jsonb) returns void ...;
-- sets status='sent', executed_at, response; used+1 reserved-1; advances enrollment; node_stats.sent+1

create or replace function private.fail_action(p_id uuid, p_code text, p_decision text, p_retry_at timestamptz)
returns void ...;
-- releases reservation; sets failed/queued(retry)/skipped per decision; node_stats; sender_events reject

create or replace function private.in_schedule(p_sender uuid, p_at timestamptz) returns boolean ...;
-- converts p_at to sender tz, checks against schedule jsonb windows

create or replace function private.sender_local_date(p_sender uuid, p_at timestamptz) returns date ...;

create or replace function private.advance_enrollment(p_enrollment uuid, p_from_node text, p_branch text)
returns void ...;
-- resolves next node from graph, sets current_node_id, status by node type, wait_until for delay/wait

create or replace function public.save_sequence(p_id uuid, p_graph jsonb, p_pool uuid[], p_settings jsonb)
returns int ...;  -- validates via private.validate_graph(), writes version, returns version

create or replace function public.enroll_leads(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null)
returns table(enrolled int, skipped_active int, skipped_suppressed int) ...;
-- assignment strategy, dedupe against enr_active_unique, suppression check, creates enrollments at start node

create or replace function public.project_sequence(p_sequence uuid, p_lead_count int)
returns table(estimated_days int, bottleneck action_type_t) ...;
```

### 7.12 Seed data
- `platform_ceilings` (above)
- `warmup_caps` levels 0–5 (plan §7.2)
- default `stages`: New, Contacted, Connected, Replied, Interested, Meeting, Won, Lost
- default `tags`: none

---

## 8. Edge Functions

All in `/supabase/functions/<name>/index.ts` (Deno). Conventions:
- `verify_jwt: true` for user-invoked functions; `false` for webhooks and cron (they verify their own secret).
- Every function logs `{fn, workspace_id, sender_id, action_id, duration_ms, outcome}` as JSON.
- Shared modules in `_shared/`: `supabase.ts` (service client), `unipile.ts` (typed client), `errors.ts`, `budget.ts`, `render.ts` (variable templating), `ai.ts`.
- Cron-invoked functions are called by `pg_cron` → `pg_net.http_post` with header `x-cron-secret`.

### 8.1 Function catalogue

| # | Function | Trigger | Auth | Purpose |
|---|---|---|---|---|
| F1 | `unipile-webhook` | HTTP from Unipile | header `Unipile-Auth` == secret | Persist inbound event, enqueue, 200 |
| F2 | `process-inbound` | pgmq consumer via cron (every 10s) | cron secret | Dispatch events to handlers |
| F3 | `worker-tick` | cron every minute | cron secret | Claim due actions, execute via Unipile, complete/fail |
| F4 | `worker-planner` | cron hourly (runs for senders whose local time is 00:00–01:00) | cron secret | Build next day's budgets and actions |
| F5 | `worker-health` | cron hourly (senders at local 02:00) + on demand | cron secret | Recompute health, adjust caps, level changes |
| F6 | `worker-reconnect` | cron every 15 min | cron secret | Retry reconnect for senders in `credentials` |
| F7 | `worker-imports` | cron every 5 min | cron secret | Advance import jobs under budget |
| F8 | `worker-withdraw` | daily per sender (local 10:00–16:00 random) | cron secret | Queue withdrawals for stale invites |
| F9 | `worker-relations-poll` | cron hourly, executes ≤3/day/sender at random | cron secret | Diff invitations for no-note invites |
| F10 | `sender-connect` | HTTP from web | user JWT | Create Hosted Auth link |
| F11 | `sender-notify` | HTTP from Unipile `notify_url` | Unipile secret | Handle CREATION_SUCCESS/RECONNECTED from hosted auth |
| F12 | `sender-update-proxy` | HTTP from web | user JWT (manager+) | PATCH proxy country |
| F13 | `sender-disable` | HTTP from web | user JWT (manager+) | Disable + optional Unipile delete |
| F14 | `cookie-sync` | HTTP from extension | extension token (per-sender) | Store encrypted cookies; trigger reconnect if needed |
| F15 | `send-reply` | HTTP from web | user JWT | Send inbox reply via Unipile |
| F16 | `edit-message` / `delete-message` | HTTP from web | user JWT | Within 60 min |
| F17 | `attachment-proxy` | HTTP from web (signed) | user JWT | Stream attachment from Unipile |
| F18 | `ai-classify` | pgmq consumer via cron (every 15s) | cron secret | Classify inbound messages |
| F19 | `ai-draft` | HTTP from web / from tick for approval nodes | user JWT / cron | Draft opener/comment → task |
| F20 | `ai-sequence-qa` | HTTP from web | user JWT | Warnings/errors on graph |
| F21 | `imports-create` | HTTP from web | user JWT | Validate URL/CSV, create import_job |
| F22 | `exports-create` | HTTP from web | user JWT | Generate CSV to storage, signed URL |
| F23 | `outbound-webhooks` | pgmq consumer via cron (every 30s) | cron secret | Deliver signed webhooks with retry |
| F24 | `stripe-webhook` | HTTP from Stripe | Stripe signature | Subscription lifecycle |
| F25 | `billing-sync` | cron daily | cron secret | Usage → Stripe quantity |
| F26 | `invite-accept` | HTTP from web | user JWT | Accept workspace invitation |
| F27 | `notify` | internal (called by others) | service | Email via Resend: reconnect, paused, digest |

### 8.2 Detailed specifications

#### F1 `unipile-webhook`
- **Route:** `POST /functions/v1/unipile-webhook`
- **Auth:** compare `req.headers['unipile-auth']` to Vault secret `UNIPILE_WEBHOOK_SECRET` (constant-time).
- **Logic:**
  1. Parse JSON. Derive `source` from payload shape: `AccountStatus` → `account_status`; `event=='new_relation'` → `users`; `message_id`/`chat_id` → `messaging`; `email_id` → `mail`; `tracking_id` → `mail_tracking`; `event_id` → `calendar`.
  2. `INSERT ops.inbound_events` (raw payload).
  3. `pgmq.send('inbound', {event_id})`.
  4. Return `200 {"ok":true}`.
- **Failure:** on DB error return 500 so Unipile retries (5 attempts with backoff).
- **Perf budget:** < 300ms p99. No Unipile calls, no business logic.

#### F2 `process-inbound`
- **Trigger:** cron every 10s: `select pgmq.read('inbound', 30, 50)` then dispatch; delete on success; on failure `attempts++`, dead-letter after 5.
- **Handlers:**

  `account_status`:
  | message | action |
  |---|---|
  | `CREATION_SUCCESS` | sender `connecting`; fetch own profile; set `public_identifier`, `provider_user_id`, `connections_count`, `is_premium`, flags; run onboarding gate |
  | `OK` | sender `ok`; `last_ok_at`; if previously `credentials` → `RECONNECTED` semantics |
  | `SYNC_SUCCESS` | enqueue inbox backfill (`backfillChats(sender)` inside this function, paged) |
  | `CREDENTIALS` | sender `credentials`, `status_reason`, `last_disconnect_at`; sender_events; health hit; if cookie mode → F6 picks up; else `notify(reconnect_needed)` |
  | `ERROR`/`STOPPED` | sender `error`; notify after 2 consecutive |
  | `CONNECTING` | no-op besides event |
  | `DELETED` | sender `disabled` |
  | `RECONNECTED` | sender `ok`; sender_events |

  `messaging` (`new_message`):
  1. Upsert `chats` by `(sender_id, unipile_chat_id)`; attendee → lead match by `provider_id` or `public_identifier`; create lead if unknown and `settings.create_leads_from_inbound`.
  2. Insert `messages` (dedupe on `unipile_message_id`).
  3. If `direction='in'`: set `lead_sender_state.replied=true, last_inbound_at` → trigger exits enrollments; `chats.unread=true`; `pgmq.send('ai_classify',{message_id})`.
  4. If `direction='out'` and message is first in chat and sender is author and `lead_sender_state.relation='pending_out'` → **acceptance via note path**: set `relation='first'`, `invite_accepted_at`, `is_invite_note=true`; `advance_enrollment(..., branch='connected')` for enrollments in `waiting_connection`. Guard: verify with a profile fetch scheduled as a `profile_view` action before the first connected-branch send.
  5. Outbound webhook event `message.received` / `message.sent`.

  `users` (`new_relation`):
  1. Match lead by `user_provider_id` or `user_public_identifier`.
  2. `lead_sender_state.relation='first'`, `invite_accepted_at=received_at` (note: may be up to 8h late; store `detected_at` separately).
  3. `advance_enrollment(branch='connected')` for `waiting_connection`.
  4. Event `invite.accepted`.

  `mail` (`new_email`): upsert chat (thread) + message; inbound → replied + classify; bounce detection via headers/status → `lead_sender_state` + condition flag `email_bounced`.

  `mail_tracking`: update `messages.attachments`/`opens`/`clicks` jsonb; event.

  `calendar`: v2.

#### F3 `worker-tick`
- **Cron:** `* * * * *`
- **Logic:**
  1. `rows = rpc('claim_due_actions', {p_limit: 200})`.
  2. For each row (parallel across senders, serial within sender):
     - Render payload if not pre-rendered (variables, fallbacks).
     - Pre-checks: lead not `do_not_contact`; enrollment status still active-ish; for `invite` check weekly used < weekly cap; for `message` check `relation='first'` unless `inmail`.
     - Execute via `unipile.execute(action)` (§10).
     - On success: `rpc('complete_action', {id, response})`; side effects per type (§13.3).
     - On error: `decision = handleUnipileError(code, ctx)`; `rpc('fail_action', {id, code, decision, retry_at})`; apply sender-level effects (pause, cap-hit flags).
  3. Log summary.
- **Timeout:** function max 60s; stop claiming new rows at 45s.
- **Concurrency guard:** advisory lock `pg_try_advisory_lock(hashtext('worker-tick'))`; skip if held.

#### F4 `worker-planner`
- **Cron:** `5 * * * *` (hourly). Selects senders where `local_hour(now()) = 0` and no plan exists for tomorrow.
- **Per sender:**
  1. `day = local tomorrow`. If no schedule window that weekday → write zero-cap budgets, exit.
  2. Compute caps: `cap = min(ceiling, warmup_caps[level], manual_caps) * health_multiplier * jitter(0.9..1.1)`, floor to int. Weekly invite: `min(cap, weekly_ceiling - used_this_week)`.
  3. Upsert `sender_budgets` for all action types.
  4. Collect demand: enrollments `active|waiting_delay` with `wait_until <= end of day` and next node executable; import jobs; withdrawals; polls.
  5. Slot allocation: for each action type, generate `cap` candidate timestamps inside windows using a bimodal distribution (peaks ~10:30 and ~15:00 local, trough 12:30–13:30), min gap per type 90–400s random, global min gap 20s. Assign to demand by `priority, created_at`. Excess demand stays unplanned; mark sequence `throttled_reason`.
  6. For each send needing a profile fetch (invite, message where `provider_id` null or `last_profile_fetch_at` > 7 days), insert a `profile_view` action 5–40 min before, consuming `profile_view` budget.
  7. Insert `actions` with `idempotency_key = sha256(enrollment_id|node_id|attempt)`.
- **Idempotency:** unique on `(sender_id, day)` in a `plans` table (add: `create table ops.plans(sender_id uuid, day date, primary key(sender_id,day), created_at timestamptz)`).

#### F5 `worker-health`
- **Cron:** hourly; senders at local 02:00; also invoked inline by F2/F3 on disconnect or reject burst (debounced 10 min).
- **Categories (0–100 each), score = min:**
  - `session_stability`: 100 − 25×disconnects_14d (floor 0); −20 if currently not `ok`.
  - `rejection_rate`: rejects/actions_14d: <1%→100, <3%→80, <6%→60, <10%→40, else 20.
  - `acceptance_rate` (invites ≥20 in 14d, else 100): ≥35%→100, ≥25%→85, ≥15%→65, ≥8%→45, else 25.
  - `reply_rate` (messages ≥20): ≥15%→100, ≥8%→80, ≥4%→60, else 40.
  - `consistency`: coefficient of variation of daily actions over 14d: <0.5→100, <1.0→75, else 50; +spike rule: today > 3×trailing avg after ≥5 idle days → 10.
  - `verification`: checkpoints on reconnect in 30d: 0→100, 1→70, ≥2→40.
- **Effects:** update `health_score`, `health_breakdown`; `<50` → `paused_until = now()+24h`, notify; `50–69` → multiplier 0.6; `≥85` for 14 consecutive days and `warmup_locked_until < today` → `warmup_level+1` (max 5), event, notify.

#### F6 `worker-reconnect`
- **Cron:** `*/15 * * * *`
- **Logic:** senders `status='credentials'` and `auth_method='cookie'` and `last_reconnect_attempt < now()-1h` and `attempts_since_disconnect < 4`:
  1. Decrypt cookie (log to `private.secret_access_log`).
  2. `POST accounts/{id}/reconnect` with `{access_token: li_at, premium_token: li_a, user_agent}`.
  3. Success → status via webhook; failure → attempt++.
  4. After 4 → `notify(reconnect_needed_manual)` to `owner_email` with instructions; then daily reminder max 3.
- Credentials-mode senders: on entering `credentials`, immediately `notify` with a fresh hosted-auth `reconnect` link (type `reconnect`, `reconnect_account: unipile_account_id`).

#### F7 `worker-imports`
- **Cron:** `*/5 * * * *`
- **Logic:** jobs `status in (queued,running)` and `next_run_at <= now()` and sender `ok` and in schedule:
  - `search_url`: reserve `search_page` budget; `POST linkedin/search?account_id&limit=50&offset` with `{url}` or `{api, category, ...filters}`; upsert leads; `next_offset += n`; `next_run_at = now() + random(20..90 min)`; done when `n < limit` or offset ≥ per-query cap (1000/2500) → mark `done` with `capped=true` hint.
  - `csv`: parse from storage in chunks of 500; no Unipile calls; done in one pass.
  - `relations`: `GET users/relations?cursor` paged; ≤1 page per hour.
- Total per-day rows fetched enforced by `search_page` budget × 50.

#### F8 `worker-withdraw`
- Daily per sender at a random slot inside window: select `lead_sender_state` where `relation='pending_out'` and `invite_sent_at < now() - settings.withdraw_after_days` and no active enrollment needing it; queue up to `withdraw` cap (default 10) as actions spread across the day.

#### F9 `worker-relations-poll`
- Only senders with pending **no-note** invites. ≤3 runs/day at random offsets stored in `ops.poll_plan(sender_id, day, times[])`. `GET users/invite/sent` first page; any previously pending invitation absent → verify via profile fetch (uses `profile_view` budget) → accepted or declined.

#### F10 `sender-connect`
- **Input:** `{provider, client_id?, owner_email?, recruiter?: boolean}`
- **Logic:** capture `x-forwarded-for` and `user-agent`; insert `senders` row (`connecting`, `auth_method='credentials'|'oauth'`, `proxy_ip_hint`, `user_agent`); call `POST hosted/accounts/link` with `{type:'create', providers:[provider], api_url, expires_on: +15min, notify_url: F11 URL + ?sid=, success_redirect_url, failure_redirect_url, name: sender.id, disabled_features: recruiter ? [] : ['recruiter'], ...(LinkedIn: {country|ip})}`; return `{url}`.
- **Output:** `{link, sender_id}`.

#### F11 `sender-notify`
- Receives hosted-auth notify payload with `name` (our sender id) and `account_id`; sets `unipile_account_id`; creates per-sender webhooks if platform-level ones not used (we use platform-level, so no-op); audit.

#### F14 `cookie-sync`
- **Auth:** `Authorization: Bearer <sender_token>` where token issued at extension install (stored hashed in `private.sender_tokens`).
- **Input:** `{li_at, li_a?, user_agent, ip, plain_id}`.
- **Logic:** verify `plain_id` matches `senders.provider_user_id` (prevents pasting another user's cookie); encrypt with Vault key; upsert `private.sender_secrets`; if sender `status='credentials'` → invoke reconnect immediately; if sender `auth_method='credentials'` and workspace opts in → switch to cookie mode on next disconnect.
- **Rate limit:** 1 request / 10 min / sender.

#### F15 `send-reply`
- **Input:** `{chat_id, text, attachments?: [storage_path]}`
- **Logic:** RLS-verify user can access chat and `members.can_reply`; insert `actions(type='reply', status='reserved')` (no budget reservation; `reply` ceiling is nominal); `POST chats/{unipile_chat_id}/messages`; insert `messages(direction='out')`; `complete_action`; `chats.unread=false`; `lead_sender_state.last_outbound_at`.

#### F18 `ai-classify`
- Consumer of `ai_classify`. Load message + last 3 outbound in chat + sequence brief. Prompt (system): classify into `intent_t`, return JSON `{intent, confidence, summary}`. Model: `claude-sonnet-4-6` (fast, cheap). Write to `messages` and `chats.intent`; if `interested|question` → create `tasks(kind='follow_up')` assigned to chat assignee or client default; record `ai_calls`.

#### F19 `ai-draft`
- Inputs: `{lead_id, sender_id, node_id, kind: 'invite_note'|'message'|'comment', brief}`; fetch profile (uses `profile_view` budget via a synchronous reserve) + last 2 posts; draft with constraints (length by kind/premium); create `tasks(kind='review_ai_draft', ai_draft)`; enrollment `waiting_task`. On task complete with edited text → enqueue the real action with `payload.text`.

#### F20 `ai-sequence-qa`
- Static checks (blocking): invite note > 300 (or > 200 if any free sender in pool), email node with no mailbox in pool, no terminal node, message node before any connection/inmail path, ceiling violations in settings. LLM checks (warnings): pitch-in-first-touch, link-in-first-touch, >3 touches before value, generic openers, no stop conditions.

#### F23 `outbound-webhooks`
- Consumer; `POST url` with `X-Signature: hmac_sha256(secret, body)`, `X-Event`, `X-Delivery-Id`; retries 5× exponential; disable webhook after 50 consecutive failures.

#### F24 `stripe-webhook` / F25 `billing-sync`
- Standard subscription lifecycle → `workspaces.plan`; nightly `billing_usage` → `subscriptions.items.quantity` = peak active senders this period.

### 8.3 Cron schedule (pg_cron)

```sql
select cron.schedule('tick',            '* * * * *',   $$select ops.invoke('worker-tick')$$);
select cron.schedule('inbound',         '10 seconds',  $$select ops.invoke('process-inbound')$$);
select cron.schedule('ai-classify',     '15 seconds',  $$select ops.invoke('ai-classify')$$);
select cron.schedule('planner',         '5 * * * *',   $$select ops.invoke('worker-planner')$$);
select cron.schedule('health',          '20 * * * *',  $$select ops.invoke('worker-health')$$);
select cron.schedule('reconnect',       '*/15 * * * *',$$select ops.invoke('worker-reconnect')$$);
select cron.schedule('imports',         '*/5 * * * *', $$select ops.invoke('worker-imports')$$);
select cron.schedule('withdraw',        '40 * * * *',  $$select ops.invoke('worker-withdraw')$$);
select cron.schedule('relations-poll',  '50 * * * *',  $$select ops.invoke('worker-relations-poll')$$);
select cron.schedule('outbound-hooks',  '30 seconds',  $$select ops.invoke('outbound-webhooks')$$);
select cron.schedule('billing',         '15 3 * * *',  $$select ops.invoke('billing-sync')$$);
select cron.schedule('cleanup',         '0 4 * * *',   $$delete from ops.inbound_events where processed_at < now()-interval '30 days'$$);
```
`ops.invoke(name)` wraps `net.http_post(url := functions_base||name, headers := jsonb_build_object('x-cron-secret', vault.get('CRON_SECRET')))`. Hourly workers select their own subset by sender local hour, so a single global cron serves all timezones.

---

## 9. Unipile integration layer (`/packages/unipile`)

### 9.1 Client
```ts
class UnipileClient {
  constructor(dsn: string, apiKey: string)
  accounts: { list, get, reconnect, patchProxy, delete, resync, hostedLink, solveCheckpoint }
  users:    { profile(accountId, identifier, {api?, notify?}), ownProfile, invite, cancelInvite,
              invitationsSent, invitationsReceived, relations, posts, endorse }
  chats:    { list, start(accountId, {attendees_ids, text, linkedin:{api,inmail}, subject?, attachments?}),
              messages, send, edit, delete, attachment }
  posts:    { get, react, comment }
  linkedin: { search(accountId, params), searchParams, company, inmailBalance, rawData }
  mails:    { list, send, get, update, delete, attachment, folders }
  webhooks: { list, create, delete }
}
```
- Base URL from `UNIPILE_DSN` (`https://apiX.unipile.com:PORT`); port as query param fallback where blocked.
- Timeouts: 20s per call; 2 retries on network error only (never on 4xx).
- Every call emits `{endpoint, account_id, status, latency_ms}` metric.

### 9.2 Error mapping (`handleUnipileError`)
```ts
type Decision =
  | {kind:'retry', at: Date}
  | {kind:'skip_node'}
  | {kind:'fail_enrollment', reason: string}
  | {kind:'mark_lead_invalid'}
  | {kind:'sender_cap_hit', type: 'invite', until: Date}
  | {kind:'sender_pause', hours: number}
  | {kind:'sender_credentials'}
  | {kind:'branch', name: string};
```
| HTTP / code | Decision |
|---|---|
| 422 `cannot_resend_yet` | `sender_cap_hit(invite, next Monday local)`; cancel remaining invite actions this week |
| 422 `invalid_attendee` / `not_found` profile | `mark_lead_invalid` + `fail_enrollment` |
| 422 `insufficient_credit` | `branch('no_credit')` if exists else `skip_node` |
| 422 `already_connected` | set relation `first`; `branch('connected')` |
| 422 `invitation_pending` | set relation `pending_out`; `skip_node` |
| 429 | `retry(+random(30..90 min))`; `rejects_1h++`; ≥3 → `sender_pause(24)` |
| 500/502/503 | `retry(+random(15..45 min))`; count as above |
| 401 / account disconnected | `sender_credentials` |
| network timeout | `retry(+10 min)`, max 3 |
| 400 validation (our bug) | `fail_enrollment('payload_invalid')` + alert |

### 9.3 Payload rendering
- Template syntax `{{first_name|fallback}}`, `{{company}}`, `{{custom.x}}`, `{{sender.first_name}}`.
- Rendering happens at plan time (stored in `payload.text`) and re-rendered at execute time if a profile fetch updated fields in between.
- Length enforcement per kind: invite note 300/200, message 8000, comment 1250, InMail subject 200/body 1900, email unlimited.

---

## 10. Webhook contracts (inbound from Unipile)

Registered once per platform (not per account) via `POST webhooks` for sources: `account_status`, `messaging`, `users`, `mail`, `mail_tracking`. Each with `headers: [{Content-Type: application/json},{Unipile-Auth: <secret>}]`.

Payload handling references (fields we depend on):
- `account_status`: `AccountStatus.account_id`, `.account_type`, `.message`, `.product?`
- `messaging`: `account_id, chat_id, message_id, sender, attendees[], message, timestamp, attachments[], is_sender`
- `users`: `event:'new_relation', account_id, user_provider_id, user_public_identifier, user_profile_url, user_full_name, user_picture_url`
- `mail`: `account_id, email_id, thread_id, from, to, subject, body_plain, date, in_reply_to, bounce?`
- `mail_tracking`: `email_id, event:'opened'|'clicked', url?, timestamp`

Payload versions are validated with zod in `/packages/shared/webhooks.ts`; unknown shapes are stored and dead-lettered, never dropped.

---

## 11. Frontend (React)

### 11.1 Stack
Vite + React 18 + TypeScript strict · React Router v6 · TanStack Query (server state) · Zustand (UI state) · supabase-js v2 (auth, PostgREST, Realtime, Storage) · React Flow (sequence canvas) · Tailwind + shadcn/ui · react-hook-form + zod (shared schemas from `/packages/shared`) · date-fns-tz · Papaparse (CSV) · Sentry.

### 11.2 Routes
```
/login  /signup  /invite/:token
/w/:slug
  /                       Dashboard: senders health grid, today's budgets, alerts, replies needing action
  /inbox                  Unified inbox (list + thread + lead panel)
  /inbox/:chatId
  /senders                Sender table: status, health, level, proxy, schedule, today used/cap
  /senders/new            Connect wizard (provider → client → owner email → launch hosted auth)
  /senders/:id            Sender detail: tabs Overview | Schedule | Budgets | Events | Secrets(extension) | Danger
  /leads                  Table with filters, saved views, bulk actions
  /leads/import           Import wizard (search URL | CSV | relations)
  /leads/:id              Lead detail: profile, per-sender relation, timeline, chats, enrollments
  /sequences              List with status, node stats summary, throttle badges
  /sequences/new
  /sequences/:id          Builder (canvas) + right panel (node config) + top bar (activate, pool, projection)
  /sequences/:id/versions
  /sequences/:id/enroll   Choose leads (filters) → pool → preview projection → enrol
  /tasks                  Task queue (manual nodes, AI drafts, follow-ups)
  /clients                Client partitions (agency tiers)
  /settings/workspace  /settings/members  /settings/billing  /settings/webhooks  /settings/suppressions
  /settings/safety        Read-only ceilings, editable manual caps per sender (lower only)
/c/:clientSlug            Client viewer surface (read-only inbox + stats), separate shell
```

### 11.3 Permission matrix

| Capability | owner | manager | member | client_viewer |
|---|---|---|---|---|
| Billing, members, webhooks | ✔ | | | |
| Connect/disable senders | ✔ | ✔ | | |
| Edit schedule/caps/proxy | ✔ | ✔ | | |
| Build/activate sequences | ✔ | ✔ | | |
| Import/enrol leads | ✔ | ✔ | ✔ (scoped) | |
| Inbox read | ✔ | ✔ | ✔ (scoped) | ✔ (own client) |
| Inbox reply | ✔ | ✔ | ✔ if can_reply | ✔ if can_reply |
| Tasks | ✔ | ✔ | ✔ (scoped) | |
| Export | ✔ | ✔ | | |

Enforced by RLS server-side; UI hides what the role cannot do.

### 11.4 Key screens: acceptance criteria

**Sender detail**
- Shows status pill with `status_reason`, health score with breakdown bars, warmup level with "locked until" if gated, proxy country, last sync, connections count.
- Budget panel: per action type `used/cap` for today (sender-local), weekly invites `used/150`.
- Schedule editor: per-weekday windows, timezone select, "copy Mon→Fri"; warns if timezone ≠ profile location country.
- Events timeline from `sender_events`.
- Danger: Pause, Disable (confirm), "Send re-login link" (credentials mode), "Extension setup" (cookie mode: shows one-time token QR).

**Inbox**
- Left: chat list, virtualised, filters (sender, client, intent, unread, assigned, channel); Realtime-updated.
- Middle: thread; inbound left, outbound right; invite-note badge; intent chip with override menu; edit/delete affordance with 60-min countdown.
- Right: lead panel with per-sender relation, active enrollment (with "Exit" and "Re-enrol"), tags/stage editors, tasks.
- Compose disabled if `members.can_reply=false` or sender not `ok`.

**Sequence builder**
- Canvas with node palette (grouped: Outreach, Social, Logic, CRM, Integrations, AI).
- Node config panel validated against zod schema; live character counters against limits; variable picker with fallback.
- Top bar: status, pool selector (senders must be `ok`), assignment strategy, "Use sender schedule" toggle, **Projection** ("1,000 leads ≈ 8.5 weeks on 3 senders; bottleneck: invites"), Activate (runs F20 QA; blocking errors stop).
- Node overlays: queued/sent/accepted/replied/failed counts from `node_stats` (Realtime).
- Version history drawer with restore.
- Delete node → modal: Skip in-flight / Cancel in-flight; count shown.

**Import wizard**
- Search URL: paste → server validates via `imports-create` → shows detected type (Classic/Sales Nav), estimated rows (capped 1000/2500), estimated days given `search_page` budget, sender selector.
- CSV: upload → column mapping → dedupe preview → confirm.

**Dashboard**
- Health grid (one tile per sender, coloured by score), today's aggregate budgets, "needs attention" list (credentials, paused, cap hit, throttled sequences), replies awaiting action, AI drafts awaiting review.

### 11.5 Realtime subscriptions
- `messages` insert filtered by `workspace_id` → inbox thread/list.
- `chats` update → list ordering/unread.
- `senders` update → status pills, health.
- `node_stats` update → builder overlays.
- `tasks` insert/update → badge counts.
Channel per workspace; reconnect with backoff; fall back to polling every 30s.

### 11.6 Chrome extension (`/apps/extension`)
- MV3, `host_permissions: ["https://www.linkedin.com/*"]`, `permissions: ["cookies","alarms","storage"]`.
- Setup: user pastes one-time token from sender detail → extension stores `sender_token`.
- Alarm every 3h + on `cookies.onChanged` for `li_at`/`li_a`: read cookies, `navigator.userAgent`, fetch `https://www.linkedin.com/feed/` HTML → parse `plainId`; POST to F14.
- Badge shows last sync; error state if plainId mismatch (wrong LinkedIn account logged in).

---

## 12. Sequence engine specification

### 12.1 Graph JSON schema (zod in `/packages/shared/graph.ts`)
```ts
Graph = {
  version: 1,
  start: NodeId,
  nodes: Record<NodeId, Node>,
}
Node = {
  id: string, type: NodeType, label?: string,
  config: NodeConfig[type],
  delay?: { amount: number, unit: 'minutes'|'hours'|'days', jitter_pct?: number },  // before executing
  mode?: 'auto'|'manual',
  next?: NodeId,                     // for single-exit nodes
  branches?: Record<string, NodeId>, // for branching nodes
  position: {x:number,y:number}
}
```

### 12.2 Node types and configs

| type | config | exits | executes as |
|---|---|---|---|
| `start` | – | next | – |
| `end` | `{reason?}` | – | completes enrollment |
| `visit_profile` | `{notify?: boolean}` | next | `profile_view` |
| `like_latest_post` | `{max_age_days: 90}` | next | `like` (+`profile_view` for post fetch) |
| `comment_latest_post` | `{text, ai?: {brief}, max_age_days}` | next | `comment` |
| `endorse_skills` | `{count: 1..5}` | next | `endorse` |
| `send_invite` | `{note?: string, ai?: {brief}, require_note_for_free: false}` | next | `invite` |
| `wait_connection` | `{window_days: 14, subtasks?: [{type:'delay'\|'visit_profile'\|'like_latest_post', ...}]}` | `connected`, `no_connect` | passive + subtasks |
| `withdraw_invite` | – | next | `withdraw` |
| `send_message` | `{text, ai?, send_always: false}` | next | `message` |
| `send_inmail` | `{subject, text, api: 'classic'\|'sales_navigator'\|'recruiter', open_profile_only: false}` | next, `no_credit` | `inmail` |
| `send_email` | `{subject, html, to: 'work'\|'personal'\|'any', thread: 'continue'\|'new', mailbox_sender_id?}` | next, `bounced`, `no_email` | `email` |
| `delay` | `{amount, unit, jitter_pct}` | next | passive |
| `condition` | `{rules: Rule[], match: 'all'\|'any'}` | `true`, `false` | passive |
| `rotate_sender` | `{restart_from: NodeId, max_rotations: 2}` | next | passive |
| `change_sender` | `{sender_id \| 'next_in_pool'}` | next | passive |
| `add_tag`/`remove_tag` | `{tag_id}` | next | CRM |
| `change_list` | `{list_id}` | next | CRM |
| `change_stage` | `{stage_id}` | next | CRM |
| `call_webhook` | `{webhook_id}` | next | outbound hook |
| `call_api` | `{method, url, headers, query, body, remove_empty}` | next, `error` | HTTP from F3 |
| `send_to_sequence` | `{sequence_id}` | – | enrol + complete |
| `manual_task` | `{title, body}` | next | task; enrollment `waiting_task` |
| `ai_draft_approval` | `{kind, brief}` | next | task `review_ai_draft` |

`Rule` fields: `replied`, `accepted`, `relation`, `email_bounced`, `has_email_work`, `has_email_personal`, `is_open_profile`, `has_tag`, `stage_is`, `custom.<key> op value`, `sender_is_premium`.

### 12.3 Execution semantics
- **Advance:** after an action completes, `advance_enrollment` moves to `next` (or the branch returned by the action). Passive nodes (delay, condition, CRM, rotate, change_sender) are evaluated immediately in the same transaction and chained until an executable node is reached or a wait state begins.
- **Delay:** `wait_until = now() + amount ± jitter`; status `waiting_delay`; planner picks up when `wait_until` falls inside a planned day.
- **wait_connection:** status `waiting_connection`, `wait_until = now()+window`. Subtasks scheduled as actions spread across the window (never more than one per 2 days). On acceptance (via either signal) → `connected`; connected branch's first executable action is planned with `scheduled_for ≥ detected_at + 2h` and within schedule. On `wait_until` passing → `no_connect`.
- **send_message guard:** if `relation != 'first'` at execute time and node is not `send_always`-exempt, decision `skip_node` unless a `not_connected` branch exists.
- **Reply stop:** trigger-based (§7.10). `send_always: true` nodes are the only exception, and only for nodes reached *after* the reply; the trigger cancels queued actions regardless, so `send_always` nodes are re-planned by a small re-entry routine that re-queues the current node when `send_always` and status became `exited_replied` — implemented as: enrollment status `active` retained if current node `send_always`; trigger checks node flag via graph lookup.
- **rotate_sender:** creates a new enrollment for the same lead with the next sender in pool, starting at `restart_from`; current enrollment completes with `rotated`. Respects `enr_active_unique`.
- **Manual mode:** any node with `mode='manual'` creates a task and sets `waiting_task`; completing the task performs the action (if outreach type, via `send-reply`-like path with budget) or just advances.

### 12.4 Enrollment state machine
```
active ──(reach delay)──► waiting_delay ──(due)──► active
active ──(reach wait_connection)──► waiting_connection ──accepted──► active(connected branch)
                                                         └─window end──► active(no_connect branch)
active ──(manual/ai node)──► waiting_task ──(task done)──► active
any live ──(reply)──► exited_replied
any live ──(dnc/suppression)──► exited_suppressed
any live ──(user)──► paused ──(user)──► active | exited_manual
any live ──(sender disabled)──► exited_sender_disabled
any live ──(unrecoverable error)──► failed
active ──(end node)──► completed
```

### 12.5 Events emitted (to outbound webhooks and audit)
`sender.connected`, `sender.disconnected`, `sender.reconnected`, `sender.paused`, `sender.level_changed`, `lead.created`, `lead.updated`, `invite.sent`, `invite.accepted`, `invite.withdrawn`, `message.sent`, `message.received`, `message.classified`, `email.sent`, `email.opened`, `email.clicked`, `email.bounced`, `enrollment.started`, `enrollment.exited`, `enrollment.completed`, `task.created`, `task.completed`, `sequence.activated`, `sequence.paused`, `sequence.throttled`.

---

## 13. Safety engine specification (normative)

### 13.1 Ceilings (immutable in v1)
See `platform_ceilings` seed. Enforced in `reserve_budget` because `cap` is computed as `min(ceiling, ...)` in the planner, and `sender_budgets` CHECK constraint prevents overrun.

### 13.2 Warmup cap table (seed)
```
level  invite message profile_view like comment inmail search_page endorse withdraw email
0        4      5        10          5     0       0       5          0        2       20
1        9     10        20         10     3       5      10          3        4       40
2       15     20        30         15     5      10      20          5        6       60
3       25     35        40         20     8      20      40          8        8       80
4       35     50        50         30    10      30      60         10       10      100
5       45     60        60         30    10      40      80         10       10      120
```
Weekly invite ceiling 150 at all levels. Free (non-premium) senders: level ≤ 1 and invites default to no-note.

### 13.3 Jitter rules
- Daily cap: `round(cap * uniform(0.90, 1.10))`, min 1 if base ≥ 1.
- Schedule window: start `+ uniform(0,5) min`, end `− uniform(0,5) min`.
- Slot time: sampled from bimodal distribution; rejected if within 90s of another same-type slot or 20s of any slot; never at `:00` or `:30` seconds-zero (add 1–59s).
- Poll times: 3 draws from window excluding first/last 30 min.

### 13.4 Onboarding gate
On `CREATION_SUCCESS` profile fetch: if `connections_count < 150` or null → `warmup_level=0`, `warmup_locked_until = today + 28d`, `sender_events(kind='warmup', data={reason:'thin_account'})`, UI banner. Premium detection sets `is_premium`; free accounts capped at level 1 permanently.

### 13.5 Pause and resume rules
| Condition | Effect | Resume |
|---|---|---|
| health < 50 | `paused_until = +24h` | health recompute ≥ 50 |
| ≥3 × (429/500) within 1h | `paused_until = +24h` | automatic |
| `cannot_resend_yet` | invites blocked until next Monday local | automatic |
| status ≠ ok | all actions held (stay queued) | status ok |
| user pause | `status='paused'` | user |

### 13.6 Prohibited behaviours (enforced by code review checklist and tests)
- No cron or planner emits fixed-time actions.
- No code path calls Unipile write endpoints outside `worker-tick`, `send-reply`, `worker-imports`, `worker-reconnect`, `sender-*` functions.
- No UI or API accepts caps above ceiling.
- No auto-send of AI text without `tasks.completed_by`.
- No storage of cookies outside `private.sender_secrets`.

---

## 14. AI specification

| Purpose | Model | Max tokens | Temperature | Output schema |
|---|---|---|---|---|
| classify | claude-sonnet-4-6 | 200 | 0 | `{intent, confidence:0..1, summary:≤140 chars}` |
| draft invite note | claude-sonnet-4-6 | 200 | 0.7 | `{text}` ≤ limit |
| draft message/comment | claude-sonnet-4-6 | 400 | 0.7 | `{text}` |
| sequence QA | claude-sonnet-4-6 | 800 | 0 | `{warnings:[{node_id,code,message}], errors:[...]}` |
| weekly sender report | claude-sonnet-4-6 | 600 | 0.3 | markdown |

Prompt files live in `/supabase/functions/_shared/prompts/*.md` and are versioned; `ai_calls.prompt_sha256` links outputs to prompt versions. PII sent: name, headline, company, posts, message text. No cookies, no emails beyond domain.

---

## 15. Billing

- Stripe products: `team_sender`, `agency_sender`, `agency_plus_sender`, `mailbox_addon`.
- Trial 14 days, up to 3 senders, no card.
- Quantity model: metered by peak daily active senders (status ≠ disabled) in the billing period; synced nightly; invoice in arrears.
- `past_due` → banner; +7 days → `workspaces.plan='suspended'` → senders `paused`, RLS write policies check `plan <> 'suspended'`.

---

## 16. Security and compliance

- Secrets: Unipile API key, webhook secret, cron secret, Vault encryption key, Stripe, Anthropic, Resend — all in Supabase Vault; Edge Functions read via `vault.decrypted_secrets` through a `security definer` accessor restricted to service role.
- Cookie encryption: `pgsodium` AEAD with per-row nonce; key rotation procedure documented; access logged.
- Extension tokens: 32-byte random, stored hashed (`sha256`), rotatable from sender page.
- PostgREST exposes only `public`. `private`, `ops` unexposed.
- All Edge Functions validate input with zod; reject unknown fields.
- CORS: web origin allowlist per environment.
- Rate limits: user-invoked functions 60/min/user via Upstash-style counter in Postgres (`ops.rate_limits`).
- Audit: every write to senders, sequences, members, suppressions, secrets, and every AI call.
- Data deletion: workspace delete → cascade; Unipile accounts deleted via API; secrets purged; audit retained 90 days then purged.
- Legal copy (in-app + ToS): not affiliated with LinkedIn; automation breaches LinkedIn's User Agreement; account holder bears restriction risk; session token held on their behalf and revocable; no identity rental.
- DPA template; sub-processors: Supabase, Unipile, Anthropic, Stripe, Resend, Sentry.

---

## 17. Observability

- **Logs:** Edge Function JSON logs shipped to Supabase logs + Logflare/BetterStack; correlation id `action_id`/`event_id`.
- **Metrics (Postgres views + Grafana):**
  - `actions_by_status_per_minute`, `tick_claim_latency`, `unipile_latency_by_endpoint`, `unipile_error_rate_by_code`
  - `webhook_ack_p99`, `inbound_backlog`, `ai_classify_backlog`
  - `senders_by_status`, `health_distribution`, `budget_utilisation`
  - `planner_completeness` (senders with plan for tomorrow / senders ok)
- **Alerts (PagerDuty/Slack):**
  - inbound backlog > 500 or oldest unprocessed > 2 min
  - tick not run in 3 min
  - planner completeness < 100% by local 06:00
  - 429/500 rate > 5% over 15 min
  - senders entering `credentials` > 10% of fleet in 1h (provider incident)
  - webhook 5xx from our side > 0
- **Runbooks:** provider outage, mass disconnect, stuck enrollments, dead-letter replay.

---

## 18. Testing strategy

- **Unit:** graph validation, `advance_enrollment` chaining, `handleUnipileError` table, jitter distributions (statistical tests: no value at :00, min gaps hold), renderer, health scorer.
- **DB tests (pgTAP):** RLS matrix per role × table; `reserve_budget` concurrency (100 parallel reserves never exceed cap); triggers (reply exit cancels actions; enrollment exit cancels; suppression exit); `claim_due_actions` one-per-sender.
- **Integration (Unipile sandbox account):** connect → OK → invite → accept (manual) → `new_relation` or note-chat → connected branch; message → reply → exit; disconnect → reconnect via cookie.
- **Contract tests:** zod schemas against recorded Unipile payload fixtures; alert on schema drift.
- **E2E (Playwright):** connect wizard, build + activate sequence, enrol, inbox reply, role restrictions.
- **Load:** 5,000 senders × 100 actions/day synthetic with a Unipile mock; tick p95 < 90s; planner < 20 min total.
- **Chaos:** kill tick mid-batch → reserved actions return to queued via `sender_status` trigger or a 10-min stale-reservation sweeper (`ops.sweep_stale_reservations`, cron every 5 min — add to §8.3).

---

## 19. Deployment

- CI (GitHub Actions): lint, typecheck, unit, pgTAP on ephemeral Supabase (`supabase start`), deploy migrations + functions to staging on `main`, to prod on tag `v*`.
- Migrations forward-only; destructive changes in two releases (add → backfill → drop).
- Feature flags in `workspaces.settings` and `ops.flags` (global).
- Web app on Vercel (or Cloudflare Pages); env per environment; Sentry release tagging.
- Extension via Chrome Web Store, unlisted during beta.

---

## 20. Release plan and acceptance

### MVP (end week 6) — internal alpha, 5 real senders
- [ ] Connect LinkedIn (credentials), status via webhooks, onboarding gate
- [ ] Planner + tick + ledger; visit/like/invite/message/withdraw/delay
- [ ] wait_connection with both acceptance signals
- [ ] Reply → exit trigger verified end-to-end
- [ ] Inbox with Realtime, reply, attachments
- [ ] Import by search URL and CSV
- [ ] Builder with versions, projection, node stats
- [ ] pgTAP RLS and ledger tests green

### v1 (end week 12) — agency beta, 30–50 senders
- [ ] Email channel + tracking + bounce condition
- [ ] InMail with credit check
- [ ] Condition, rotate, change sender, send_to_sequence, call_api, webhooks out
- [ ] Health score, warmup levels, pause rules
- [ ] Extension + cookie reconnect
- [ ] Clients + client_viewer surface
- [ ] AI classify, drafts with approval, sequence QA
- [ ] Stripe billing
- [ ] Observability + alerts + runbooks
- [ ] Legal copy, DPA, ToS

### Exit criteria for GA
- 30 days of beta with < 2 restrictions per 100 sender-months
- Zero double-sends in `actions` audit
- All alerts exercised at least once in staging chaos runs

---

## Appendix A — Environment variables
```
SUPABASE_URL, SUPABASE_ANON_KEY (web), SUPABASE_SERVICE_ROLE_KEY (functions only)
UNIPILE_DSN, UNIPILE_API_KEY, UNIPILE_WEBHOOK_SECRET
CRON_SECRET
VAULT_COOKIE_KEY_ID
ANTHROPIC_API_KEY
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_*
RESEND_API_KEY, EMAIL_FROM
WEB_ORIGIN, FUNCTIONS_BASE_URL
SENTRY_DSN
```

## Appendix B — Error codes (ours)
`E_BUDGET_EXHAUSTED, E_OUT_OF_SCHEDULE, E_SENDER_NOT_OK, E_LEAD_SUPPRESSED, E_RELATION_REQUIRED, E_NOTE_TOO_LONG, E_NO_MAILBOX, E_NO_EMAIL, E_INMAIL_NO_CREDIT, E_CAP_HIT_WEEKLY, E_PAYLOAD_INVALID, E_GRAPH_INVALID, E_POOL_EMPTY, E_SENDER_NOT_IN_POOL, E_DUPLICATE_ENROLLMENT, E_PLAN_SUSPENDED, E_RATE_LIMITED`

## Appendix C — Open technical decisions
1. Unipile API v1 vs v2 — decide week 1 after confirming webhook parity.
2. `pgmq` vs plain queue tables — default `pgmq`; fall back if unavailable on plan.
3. Per-tenant Unipile DSN for Agency+ — design supports via `workspaces.settings.unipile_dsn_id`; not built in v1.
4. Residential vs datacenter proxy — ask Unipile; if datacenter, add BYO proxy fields to `senders` and pricing add-on.
5. Second transport adapter (`/packages/transport`) — interface defined in v1 (`execute(action) → Result`), only Unipile implementation shipped.
