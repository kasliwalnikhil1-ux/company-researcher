-- =============================================================================
-- Outreach Platform (Unipile multi-sender) — 001 schema
-- All objects are namespaced with the `outreach_` prefix to avoid collisions
-- with the existing CapitalxAI CRM tables (investors, companies, outreach_contacts…).
-- Internal/ops/secret tables live in `public` with RLS enabled and NO policies,
-- so only the service role (edge functions) can touch them, while PostgREST RPC
-- still works for the service client.
-- =============================================================================

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists citext with schema extensions;
create extension if not exists supabase_vault;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
do $$ begin
  create type outreach_role_t as enum ('owner','manager','member','client_viewer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_provider_t as enum ('LINKEDIN','GMAIL','OUTLOOK','IMAP');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_auth_method_t as enum ('credentials','cookie','oauth');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_sender_status_t as enum ('connecting','ok','credentials','error','paused','disabled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_relation_t as enum ('none','pending_out','pending_in','first','blocked','invalid');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_action_type_t as enum ('profile_view','invite','withdraw','message','inmail','like','comment',
    'endorse','search_page','email','reply','relations_poll','call_api');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_action_status_t as enum ('queued','reserved','sent','skipped','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_enrollment_status_t as enum ('active','waiting_connection','waiting_delay','waiting_task',
    'paused','completed','exited_replied','exited_manual','exited_suppressed','exited_sender_disabled','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_sequence_status_t as enum ('draft','active','paused','archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_direction_t as enum ('in','out');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_intent_t as enum ('interested','question','not_now','not_interested','ooo',
    'wrong_person','unclear','unclassified');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_import_kind_t as enum ('search_url','csv','relations');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_job_status_t as enum ('queued','running','paused','done','failed','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_task_kind_t as enum ('manual_node','follow_up','review_ai_draft','reconnect');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Tenant core
-- -----------------------------------------------------------------------------
create table if not exists outreach_workspaces (
  id                     uuid primary key default gen_random_uuid(),
  name                   text not null,
  slug                   text unique not null,
  plan                   text not null default 'trial',          -- trial|team|agency|agency_plus|suspended
  stripe_customer_id     text,
  stripe_subscription_id text,
  stripe_status          text,
  past_due_since         timestamptz,
  trial_ends_at          timestamptz not null default now() + interval '14 days',
  settings               jsonb not null default '{"recruiter_enabled":false,"ai_auto_send":false,"create_leads_from_inbound":true,"cookie_mode_opt_in":true}',
  created_by             uuid references auth.users(id),
  created_at             timestamptz not null default now(),
  deleted_at             timestamptz
);

create table if not exists outreach_clients (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  name          text not null,
  slug          text,
  timezone      text,
  settings      jsonb not null default '{}',
  created_at    timestamptz not null default now(),
  unique (workspace_id, slug)
);
create index if not exists outreach_clients_ws_idx on outreach_clients(workspace_id);

create table if not exists outreach_members (
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  role          outreach_role_t not null,
  client_ids    uuid[] not null default '{}',   -- scope for member/client_viewer; empty = all
  can_reply     boolean not null default true,
  email         citext,
  display_name  text,
  created_at    timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists outreach_members_user_idx on outreach_members(user_id);

create table if not exists outreach_invitations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  email         citext not null,
  role          outreach_role_t not null,
  client_ids    uuid[] not null default '{}',
  token         text unique not null default encode(gen_random_bytes(24),'hex'),
  expires_at    timestamptz not null default now() + interval '7 days',
  accepted_at   timestamptz,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create index if not exists outreach_invitations_ws_idx on outreach_invitations(workspace_id);

-- -----------------------------------------------------------------------------
-- Senders
-- -----------------------------------------------------------------------------
create table if not exists outreach_senders (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references outreach_workspaces(id) on delete cascade,
  client_id            uuid references outreach_clients(id) on delete set null,
  owner_user_id        uuid references auth.users(id),
  owner_email          citext,
  provider             outreach_provider_t not null,
  unipile_account_id   text unique,
  auth_method          outreach_auth_method_t not null default 'credentials',
  display_name         text,
  public_identifier    text,
  provider_user_id     text,
  picture_url          text,
  is_premium           boolean not null default false,
  has_sales_nav        boolean not null default false,
  has_recruiter        boolean not null default false,
  connections_count    int,
  status               outreach_sender_status_t not null default 'connecting',
  status_reason        text,
  proxy_country        char(2),
  proxy_ip_hint        inet,
  user_agent           text,
  timezone             text not null default 'UTC',
  schedule             jsonb not null default
    '{"mon":[["09:00","18:00"]],"tue":[["09:00","18:00"]],"wed":[["09:00","18:00"]],"thu":[["09:00","18:00"]],"fri":[["09:00","18:00"]],"sat":[],"sun":[]}',
  warmup_level         smallint not null default 0 check (warmup_level between 0 and 5),
  warmup_locked_until  date,
  health_score         smallint not null default 100 check (health_score between 0 and 100),
  health_breakdown     jsonb not null default '{}',
  health_high_since    date,
  manual_caps          jsonb not null default '{}',
  rejects_1h           int not null default 0,
  rejects_1h_reset_at  timestamptz,
  consecutive_errors   int not null default 0,
  paused_until         timestamptz,
  invite_blocked_until timestamptz,
  reconnect_attempts   int not null default 0,
  last_reconnect_at    timestamptz,
  reconnect_notified_at timestamptz,
  reconnect_reminders  int not null default 0,
  connected_at         timestamptz,
  last_ok_at           timestamptz,
  last_disconnect_at   timestamptz,
  last_synced_at       timestamptz,
  extension_token_issued_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  deleted_at           timestamptz
);
create index if not exists outreach_senders_ws_status_idx on outreach_senders(workspace_id, status);
create index if not exists outreach_senders_unipile_idx on outreach_senders(unipile_account_id);

-- cookie secrets: service role only (RLS enabled, no policies)
create table if not exists outreach_sender_secrets (
  sender_id           uuid primary key references outreach_senders(id) on delete cascade,
  li_at_enc           text,          -- base64(iv||ciphertext) AES-256-GCM, key = OUTREACH_COOKIE_KEY
  li_a_enc            text,
  cookie_captured_at  timestamptz,
  cookie_ip           inet,
  cookie_user_agent   text,
  updated_at          timestamptz not null default now()
);

create table if not exists outreach_secret_access_log (
  id         bigserial primary key,
  sender_id  uuid,
  fn         text not null,
  at         timestamptz not null default now()
);

create table if not exists outreach_sender_tokens (  -- extension tokens, sha256 hashed
  sender_id   uuid primary key references outreach_senders(id) on delete cascade,
  token_hash  text not null,
  issued_at   timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists outreach_platform_ceilings (
  action_type  outreach_action_type_t primary key,
  per_day      int not null,
  per_week     int
);

create table if not exists outreach_warmup_caps (
  level        smallint not null,
  action_type  outreach_action_type_t not null,
  per_day      int not null,
  primary key (level, action_type)
);

create table if not exists outreach_sender_budgets (
  sender_id    uuid not null references outreach_senders(id) on delete cascade,
  day          date not null,
  action_type  outreach_action_type_t not null,
  cap          int not null,
  used         int not null default 0,
  reserved     int not null default 0,
  primary key (sender_id, day, action_type),
  check (used + reserved <= cap)
);

create table if not exists outreach_sender_events (
  id         bigserial primary key,
  sender_id  uuid not null references outreach_senders(id) on delete cascade,
  kind       text not null,     -- status|health|proxy|warmup|reconnect|reject|schedule|caps|checkpoint
  data       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index if not exists outreach_sender_events_idx on outreach_sender_events(sender_id, at desc);

-- -----------------------------------------------------------------------------
-- Leads
-- -----------------------------------------------------------------------------
create table if not exists outreach_lists (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  client_id    uuid references outreach_clients(id) on delete set null,
  name         text not null,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_lists_ws_idx on outreach_lists(workspace_id);

create table if not exists outreach_stages (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  name         text not null,
  position     int not null default 0,
  color        text
);
create index if not exists outreach_stages_ws_idx on outreach_stages(workspace_id);

create table if not exists outreach_tags (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  name         citext not null,
  color        text,
  unique (workspace_id, name)
);

create table if not exists outreach_leads (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  client_id             uuid references outreach_clients(id) on delete set null,
  public_identifier     citext,
  provider_id           text,
  profile_url           text,
  first_name            text,
  last_name             text,
  full_name             text,
  headline              text,
  company               text,
  company_id            text,
  title                 text,
  location              text,
  picture_url           text,
  email_work            citext,
  email_personal        citext,
  is_open_profile       boolean,
  custom                jsonb not null default '{}',
  list_id               uuid references outreach_lists(id) on delete set null,
  stage_id              uuid references outreach_stages(id) on delete set null,
  do_not_contact        boolean not null default false,
  unsubscribed          boolean not null default false,
  source                text,
  import_job_id         uuid,
  last_profile_fetch_at timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists outreach_leads_ws_pubid on outreach_leads(workspace_id, public_identifier) where public_identifier is not null;
create unique index if not exists outreach_leads_ws_email on outreach_leads(workspace_id, email_work) where email_work is not null and public_identifier is null;
create index if not exists outreach_leads_ws_client_idx on outreach_leads(workspace_id, client_id);
create index if not exists outreach_leads_ws_created_idx on outreach_leads(workspace_id, created_at desc);
create index if not exists outreach_leads_provider_idx on outreach_leads(workspace_id, provider_id);
create index if not exists outreach_leads_custom_gin on outreach_leads using gin (custom);

create table if not exists outreach_lead_tags (
  lead_id uuid references outreach_leads(id) on delete cascade,
  tag_id  uuid references outreach_tags(id) on delete cascade,
  primary key (lead_id, tag_id)
);

create table if not exists outreach_lead_sender_state (
  lead_id             uuid not null references outreach_leads(id) on delete cascade,
  sender_id           uuid not null references outreach_senders(id) on delete cascade,
  relation            outreach_relation_t not null default 'none',
  invitation_id       text,
  invite_sent_at      timestamptz,
  invite_accepted_at  timestamptz,
  invite_detected_at  timestamptz,
  invite_withdrawn_at timestamptz,
  invite_had_note     boolean,
  unipile_chat_id     text,
  last_outbound_at    timestamptz,
  last_inbound_at     timestamptz,
  replied             boolean not null default false,
  email_bounced       boolean not null default false,
  updated_at          timestamptz not null default now(),
  primary key (lead_id, sender_id)
);
create index if not exists outreach_lss_sender_rel_idx on outreach_lead_sender_state(sender_id, relation);

create table if not exists outreach_suppressions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  kind         text not null check (kind in ('domain','public_identifier','email')),
  value        citext not null,
  reason       text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (workspace_id, kind, value)
);

create table if not exists outreach_import_jobs (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references outreach_workspaces(id) on delete cascade,
  client_id      uuid references outreach_clients(id) on delete set null,
  sender_id      uuid references outreach_senders(id) on delete set null,
  kind           outreach_import_kind_t not null,
  params         jsonb not null default '{}',
  status         outreach_job_status_t not null default 'queued',
  total_expected int,
  fetched        int not null default 0,
  created_leads  int not null default 0,
  updated_leads  int not null default 0,
  next_offset    int not null default 0,
  cursor         text,
  next_run_at    timestamptz default now(),
  capped         boolean not null default false,
  error          text,
  list_id        uuid references outreach_lists(id) on delete set null,
  tag_ids        uuid[] not null default '{}',
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  finished_at    timestamptz
);
create index if not exists outreach_import_jobs_due_idx on outreach_import_jobs(status, next_run_at);

-- -----------------------------------------------------------------------------
-- Sequences, enrollments, actions
-- -----------------------------------------------------------------------------
create table if not exists outreach_sequences (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references outreach_workspaces(id) on delete cascade,
  client_id           uuid references outreach_clients(id) on delete set null,
  name                text not null,
  status              outreach_sequence_status_t not null default 'draft',
  head_version        int not null default 1,
  graph               jsonb not null default '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","position":{"x":100,"y":100}}}}',
  sender_pool         uuid[] not null default '{}',
  assignment          text not null default 'round_robin' check (assignment in ('round_robin','least_loaded','fixed')),
  use_sender_schedule boolean not null default true,
  settings            jsonb not null default '{"stop_on_reply":true,"withdraw_after_days":21}',
  throttled_reason    text,
  brief               text,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  archived_at         timestamptz
);
create index if not exists outreach_sequences_ws_status_idx on outreach_sequences(workspace_id, status);

create table if not exists outreach_sequence_versions (
  sequence_id uuid not null references outreach_sequences(id) on delete cascade,
  version     int not null,
  graph       jsonb not null,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  primary key (sequence_id, version)
);

create table if not exists outreach_enrollments (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  sequence_id      uuid not null references outreach_sequences(id) on delete cascade,
  sequence_version int not null,
  lead_id          uuid not null references outreach_leads(id) on delete cascade,
  sender_id        uuid not null references outreach_senders(id) on delete cascade,
  status           outreach_enrollment_status_t not null default 'active',
  current_node_id  text,
  node_entered_at  timestamptz not null default now(),
  wait_until       timestamptz,
  exit_reason      text,
  restart_count    int not null default 0,
  rotation_count   int not null default 0,
  priority         int not null default 100,
  paused_from      outreach_enrollment_status_t,
  created_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create unique index if not exists outreach_enr_active_unique on outreach_enrollments(lead_id, sender_id)
  where status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
create index if not exists outreach_enr_seq_status_idx on outreach_enrollments(sequence_id, status);
create index if not exists outreach_enr_sender_status_idx on outreach_enrollments(sender_id, status, wait_until);
create index if not exists outreach_enr_lead_idx on outreach_enrollments(lead_id);

create table if not exists outreach_actions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  enrollment_id    uuid references outreach_enrollments(id) on delete cascade,
  import_job_id    uuid references outreach_import_jobs(id) on delete cascade,
  sender_id        uuid not null references outreach_senders(id) on delete cascade,
  lead_id          uuid references outreach_leads(id) on delete cascade,
  node_id          text,
  action_type      outreach_action_type_t not null,
  scheduled_for    timestamptz not null,
  status           outreach_action_status_t not null default 'queued',
  attempt          int not null default 1,
  idempotency_key  text not null unique,
  payload          jsonb not null default '{}',
  response         jsonb,
  error_code       text,
  decision         text,
  reserved_at      timestamptz,
  executed_at      timestamptz,
  created_at       timestamptz not null default now()
);
create index if not exists outreach_actions_due_idx on outreach_actions(scheduled_for) where status = 'queued';
create index if not exists outreach_actions_sender_idx on outreach_actions(sender_id, status, scheduled_for);
create index if not exists outreach_actions_enr_idx on outreach_actions(enrollment_id);
create index if not exists outreach_actions_lead_idx on outreach_actions(lead_id);
create index if not exists outreach_actions_ws_idx on outreach_actions(workspace_id, created_at desc);

create table if not exists outreach_node_stats (
  sequence_id uuid not null references outreach_sequences(id) on delete cascade,
  node_id     text not null,
  queued      int not null default 0,
  sent        int not null default 0,
  failed      int not null default 0,
  skipped     int not null default 0,
  accepted    int not null default 0,
  replied     int not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (sequence_id, node_id)
);

-- -----------------------------------------------------------------------------
-- Inbox
-- -----------------------------------------------------------------------------
create table if not exists outreach_chats (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references outreach_workspaces(id) on delete cascade,
  client_id            uuid references outreach_clients(id) on delete set null,
  sender_id            uuid not null references outreach_senders(id) on delete cascade,
  lead_id              uuid references outreach_leads(id) on delete set null,
  unipile_chat_id      text not null,
  provider             outreach_provider_t not null,
  attendee_provider_id text,
  attendee_public_identifier text,
  attendee_name        text,
  attendee_picture_url text,
  subject              text,
  last_message_at      timestamptz,
  last_message_preview text,
  last_direction       outreach_direction_t,
  unread               boolean not null default false,
  unread_count         int not null default 0,
  assigned_to          uuid references auth.users(id),
  intent               outreach_intent_t not null default 'unclassified',
  archived             boolean not null default false,
  created_at           timestamptz not null default now(),
  unique (sender_id, unipile_chat_id)
);
create index if not exists outreach_chats_ws_last_idx on outreach_chats(workspace_id, last_message_at desc);
create index if not exists outreach_chats_lead_idx on outreach_chats(lead_id);

create table if not exists outreach_messages (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references outreach_workspaces(id) on delete cascade,
  chat_id             uuid not null references outreach_chats(id) on delete cascade,
  unipile_message_id  text unique,
  direction           outreach_direction_t not null,
  text                text,
  html                text,
  attachments         jsonb not null default '[]',
  sent_at             timestamptz not null,
  is_invite_note      boolean not null default false,
  intent              outreach_intent_t,
  intent_confidence   real,
  summary             text,
  classified_at       timestamptz,
  opens               int not null default 0,
  clicks              int not null default 0,
  edited_at           timestamptz,
  deleted_at          timestamptz,
  action_id           uuid references outreach_actions(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index if not exists outreach_messages_chat_idx on outreach_messages(chat_id, sent_at);
create index if not exists outreach_messages_ws_idx on outreach_messages(workspace_id, created_at desc);

create table if not exists outreach_tasks (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  client_id     uuid references outreach_clients(id) on delete set null,
  kind          outreach_task_kind_t not null,
  lead_id       uuid references outreach_leads(id) on delete cascade,
  sender_id     uuid references outreach_senders(id) on delete cascade,
  enrollment_id uuid references outreach_enrollments(id) on delete cascade,
  node_id       text,
  chat_id       uuid references outreach_chats(id) on delete set null,
  title         text not null,
  body          text,
  ai_draft      text,
  draft_kind    text,
  due_at        timestamptz,
  assigned_to   uuid references auth.users(id),
  completed_at  timestamptz,
  completed_by  uuid,
  result        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists outreach_tasks_ws_idx on outreach_tasks(workspace_id, completed_at, due_at);

-- -----------------------------------------------------------------------------
-- Ops, events, audit (service-role only)
-- -----------------------------------------------------------------------------
create table if not exists outreach_inbound_events (
  id                 bigserial primary key,
  source             text not null,
  event_type         text,
  unipile_account_id text,
  payload            jsonb not null,
  received_at        timestamptz not null default now(),
  processed_at       timestamptz,
  error              text,
  attempts           int not null default 0,
  dead               boolean not null default false
);
create index if not exists outreach_inbound_events_pending_idx on outreach_inbound_events(id) where processed_at is null and dead = false;

create table if not exists outreach_ai_classify_queue (
  id          bigserial primary key,
  message_id  uuid not null references outreach_messages(id) on delete cascade,
  attempts    int not null default 0,
  locked_at   timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists outreach_plans (
  sender_id  uuid not null references outreach_senders(id) on delete cascade,
  day        date not null,
  kind       text not null default 'nightly',
  actions    int not null default 0,
  created_at timestamptz not null default now(),
  primary key (sender_id, day, kind)
);

create table if not exists outreach_poll_plan (
  sender_id uuid not null references outreach_senders(id) on delete cascade,
  day       date not null,
  times     timestamptz[] not null default '{}',
  done      int not null default 0,
  primary key (sender_id, day)
);

create table if not exists outreach_rate_limits (
  key        text primary key,
  count      int not null default 0,
  window_end timestamptz not null
);

create table if not exists outreach_flags (
  key   text primary key,
  value jsonb not null default 'true'
);

create table if not exists outreach_outbound_webhooks (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  url          text not null,
  secret       text not null default encode(gen_random_bytes(24),'hex'),
  events       text[] not null default '{}',
  active       boolean not null default true,
  failures     int not null default 0,
  created_at   timestamptz not null default now()
);

create table if not exists outreach_outbound_webhook_deliveries (
  id           bigserial primary key,
  webhook_id   uuid references outreach_outbound_webhooks(id) on delete cascade,
  workspace_id uuid,
  event        text,
  payload      jsonb,
  status       int,
  attempts     int not null default 0,
  next_at      timestamptz not null default now(),
  delivered_at timestamptz,
  last_error   text,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_owd_due_idx on outreach_outbound_webhook_deliveries(next_at) where delivered_at is null;

create table if not exists outreach_audit_log (
  id           bigserial primary key,
  workspace_id uuid,
  actor        uuid,
  actor_type   text not null default 'user',   -- user|system|ai
  action       text not null,
  entity       text,
  entity_id    text,
  diff         jsonb,
  at           timestamptz not null default now()
);
create index if not exists outreach_audit_ws_idx on outreach_audit_log(workspace_id, at desc);

create table if not exists outreach_ai_calls (
  id              bigserial primary key,
  workspace_id    uuid,
  purpose         text,
  model           text,
  prompt_sha256   text,
  response_sha256 text,
  tokens_in       int,
  tokens_out      int,
  latency_ms      int,
  at              timestamptz not null default now()
);

create table if not exists outreach_billing_usage (
  workspace_id     uuid references outreach_workspaces(id) on delete cascade,
  day              date,
  active_senders   int not null default 0,
  active_mailboxes int not null default 0,
  primary key (workspace_id, day)
);

-- -----------------------------------------------------------------------------
-- Storage buckets (private)
-- -----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('outreach-attachments','outreach-attachments',false),
       ('outreach-exports','outreach-exports',false),
       ('outreach-imports','outreach-imports',false)
on conflict (id) do nothing;
