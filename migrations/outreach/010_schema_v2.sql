-- =============================================================================
-- Outreach Platform — 010 schema for the product plan (items 1–26)
-- Additive only: new columns are nullable or defaulted, nothing is dropped except the
-- two constraints that are replaced by wider ones (suppression scope, node-stats key).
-- Conventions unchanged: `outreach_` prefix, RLS on every table, service-only tables
-- have RLS enabled with no policies.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Leads
-- -----------------------------------------------------------------------------
alter table outreach_leads
  add column if not exists last_replied_at      timestamptz,          -- item 1: any sender, any channel
  add column if not exists last_replied_channel text,                 -- 'linkedin' | 'email'
  add column if not exists phone                text,                 -- item 24: call task
  add column if not exists company_domain       text,                 -- item 26: find-email needs the company's domain
  add column if not exists enrich_status        text not null default 'none'
    check (enrich_status in ('none','waiting','done','failed')),      -- item 13
  add column if not exists enriched_at          timestamptz,
  add column if not exists email_status         text                  -- item 26: verified | unverified | invalid
    check (email_status is null or email_status in ('verified','unverified','invalid'));
create index if not exists outreach_leads_last_replied_idx on outreach_leads(workspace_id, last_replied_at) where last_replied_at is not null;
create index if not exists outreach_leads_company_idx on outreach_leads(workspace_id, lower(company)) where company is not null;

-- -----------------------------------------------------------------------------
-- Stages get a semantic kind so the funnel and auto-staging know what a stage means
-- -----------------------------------------------------------------------------
alter table outreach_stages
  add column if not exists kind text check (kind is null or kind in ('new','contacted','connected','replied','interested','meeting','won','lost')),
  add column if not exists deal_value numeric;                        -- optional default value on the won stage (Cost tab)
update outreach_stages set kind = case lower(name)
    when 'new' then 'new' when 'contacted' then 'contacted' when 'connected' then 'connected' when 'replied' then 'replied'
    when 'interested' then 'interested' when 'meeting' then 'meeting' when 'won' then 'won' when 'lost' then 'lost' end
 where kind is null and lower(name) in ('new','contacted','connected','replied','interested','meeting','won','lost');

-- -----------------------------------------------------------------------------
-- Enrollments: pinning (item 6), clean exit / OOO resume / hold (item 1), waits (13, 14), rules (18)
-- -----------------------------------------------------------------------------
alter table outreach_enrollments
  add column if not exists pinned_version       int,
  add column if not exists prev_status          outreach_enrollment_status_t,
  add column if not exists prev_wait_until      timestamptz,
  add column if not exists exited_by_message_at timestamptz,
  add column if not exists reply_ignored_before timestamptz,
  add column if not exists held_at              timestamptz,
  add column if not exists hold_reason          text,
  add column if not exists wait_reason          text,                 -- 'enrichment' | 'ai_review' | null
  add column if not exists rule_id              uuid;
create index if not exists outreach_enr_held_idx on outreach_enrollments(workspace_id, held_at) where held_at is not null;
create index if not exists outreach_enr_wait_reason_idx on outreach_enrollments(wait_reason) where wait_reason is not null;
create index if not exists outreach_enr_seq_version_idx on outreach_enrollments(sequence_id, pinned_version) where pinned_version is not null;
create index if not exists outreach_enr_failed_idx on outreach_enrollments(sequence_id, completed_at) where status = 'failed';

-- -----------------------------------------------------------------------------
-- Actions / messages: variants (item 11), attribution (item 4)
-- -----------------------------------------------------------------------------
alter table outreach_actions add column if not exists variant_id text;
create index if not exists outreach_actions_ws_exec_idx on outreach_actions(workspace_id, executed_at) where executed_at is not null;
create index if not exists outreach_actions_node_idx on outreach_actions(enrollment_id, node_id);

alter table outreach_messages
  add column if not exists replied_to_action_id uuid references outreach_actions(id) on delete set null,
  add column if not exists is_first_reply       boolean not null default false,
  add column if not exists sent_by              uuid references auth.users(id);   -- manual replies: which teammate
create index if not exists outreach_messages_reply_idx on outreach_messages(workspace_id, sent_at) where is_first_reply;
create index if not exists outreach_messages_replied_to_idx on outreach_messages(replied_to_action_id) where replied_to_action_id is not null;
create index if not exists outreach_messages_action_idx on outreach_messages(action_id) where action_id is not null;

-- node stats: variant becomes part of the key ('' = no variant)
alter table outreach_node_stats
  add column if not exists variant_id text not null default '',
  add column if not exists interested int not null default 0;
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'outreach_node_stats_pkey' and conrelid = 'outreach_node_stats'::regclass
             and array_length(conkey,1) = 2) then
    alter table outreach_node_stats drop constraint outreach_node_stats_pkey;
    alter table outreach_node_stats add primary key (sequence_id, node_id, variant_id);
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Sequences: draft/publish (item 5), stall state (item 3), assignment strategies (item 19)
-- -----------------------------------------------------------------------------
alter table outreach_sequences
  add column if not exists draft_graph        jsonb,
  add column if not exists draft_updated_at   timestamptz,
  add column if not exists draft_updated_by   uuid references auth.users(id),
  add column if not exists draft_base_version int,
  add column if not exists stalled_at         timestamptz,
  add column if not exists stalled_reason     text;
alter table outreach_sequences drop constraint if exists outreach_sequences_assignment_check;
alter table outreach_sequences add constraint outreach_sequences_assignment_check
  check (assignment in ('round_robin','least_loaded','fixed','fresh_sender','same_sender'));

alter table outreach_sequence_versions
  add column if not exists note         text,
  add column if not exists publish_mode text;                          -- 'all' | 'new_only'

-- -----------------------------------------------------------------------------
-- Senders: alerts, booking, email depth, cost
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists running_dry_at        timestamptz,          -- item 3
  add column if not exists alert_emails          citext[] not null default '{}',   -- per-sender alert recipients (checklist)
  add column if not exists booking_link          text,                 -- item 24
  add column if not exists signature             text,                 -- item 20 (html)
  add column if not exists email_schedule        jsonb,                -- item 20: null = use `schedule`
  add column if not exists bcc_address           citext,               -- item 20: BCC to CRM
  add column if not exists parent_sender_id      uuid references outreach_senders(id) on delete set null,  -- mailbox → person
  add column if not exists monthly_cost          numeric,              -- item 10 Cost tab; null = plan price
  add column if not exists track_replies         boolean;              -- null = workspace default
create index if not exists outreach_senders_parent_idx on outreach_senders(parent_sender_id) where parent_sender_id is not null;

-- -----------------------------------------------------------------------------
-- Workspace: branding (item 23); service-only secrets (items 14, 26)
-- -----------------------------------------------------------------------------
alter table outreach_workspaces
  add column if not exists branding jsonb not null default '{}';       -- {logo_url, product_name, accent, support_email, help_url, docs_url}

create table if not exists outreach_workspace_secrets (
  workspace_id   uuid primary key references outreach_workspaces(id) on delete cascade,
  llm_provider   text check (llm_provider is null or llm_provider in ('gemini','anthropic','openai')),
  llm_model      text,
  llm_key_enc    text,                       -- AES-GCM, same key as sender secrets
  llm_key_hint   text,                       -- last 4 chars, shown in settings
  finder_keys    jsonb not null default '[]',-- [{provider, key_enc, hint}] tried in order (item 26)
  verifier       jsonb,                      -- {provider, key_enc, hint}
  booking_secret text not null default encode(gen_random_bytes(18),'hex'),  -- path secret for the Calendly/Cal.com webhook
  updated_at     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Suppressions: client / sequence scope + company kind (item 17)
-- -----------------------------------------------------------------------------
alter table outreach_suppressions
  add column if not exists client_id   uuid references outreach_clients(id) on delete cascade,
  add column if not exists sequence_id uuid references outreach_sequences(id) on delete cascade,
  add column if not exists source      text not null default 'manual';     -- manual | csv | crm:<provider> | unsubscribe
alter table outreach_suppressions drop constraint if exists outreach_suppressions_kind_check;
alter table outreach_suppressions add constraint outreach_suppressions_kind_check
  check (kind in ('domain','public_identifier','email','company'));
alter table outreach_suppressions drop constraint if exists outreach_suppressions_scope_check;
alter table outreach_suppressions add constraint outreach_suppressions_scope_check
  check (not (client_id is not null and sequence_id is not null));
alter table outreach_suppressions drop constraint if exists outreach_suppressions_workspace_id_kind_value_key;
create unique index if not exists outreach_suppressions_scope_uq on outreach_suppressions
  (workspace_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid),
   coalesce(sequence_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, value);
create index if not exists outreach_suppressions_lookup_idx on outreach_suppressions(workspace_id, kind, value);

-- -----------------------------------------------------------------------------
-- Alerts: one row per occurrence (item 3). Re-alerts only after resolved_at is set and it recurs.
-- -----------------------------------------------------------------------------
create table if not exists outreach_alerts (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  client_id    uuid references outreach_clients(id) on delete set null,
  kind         text not null check (kind in ('sequence_stalled','sender_running_dry','import_failed','hold_expiring')),
  entity       text not null,              -- 'sequence' | 'sender' | 'import'
  entity_id    uuid not null,
  label        text,
  reason       text not null,              -- the plain sentence "why not sending" gives
  detail       jsonb not null default '{}',
  opened_at    timestamptz not null default now(),
  notified_at  timestamptz,
  resolved_at  timestamptz
);
create unique index if not exists outreach_alerts_open_uq on outreach_alerts(kind, entity_id) where resolved_at is null;
create index if not exists outreach_alerts_ws_idx on outreach_alerts(workspace_id, opened_at desc);

-- -----------------------------------------------------------------------------
-- Lead milestones (funnel stages that are events, not counters) + daily rollup (item 10)
-- -----------------------------------------------------------------------------
create table if not exists outreach_lead_milestones (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id       uuid not null references outreach_leads(id) on delete cascade,
  kind          text not null check (kind in ('interested','meeting','won','lost')),
  at            timestamptz not null default now(),
  client_id     uuid,
  sequence_id   uuid references outreach_sequences(id) on delete set null,
  sender_id     uuid references outreach_senders(id) on delete set null,
  enrollment_id uuid references outreach_enrollments(id) on delete set null,
  source        text not null default 'stage',   -- stage | intent | booking | crm | api
  value         numeric,
  currency      text,
  unique (lead_id, kind)
);
create index if not exists outreach_milestones_ws_idx on outreach_lead_milestones(workspace_id, at);

create table if not exists outreach_daily_stats (
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  day          date not null,              -- workspace-timezone calendar day
  client_id    uuid not null default '00000000-0000-0000-0000-000000000000',
  sequence_id  uuid not null default '00000000-0000-0000-0000-000000000000',
  node_id      text not null default '',
  variant_id   text not null default '',
  sender_id    uuid not null default '00000000-0000-0000-0000-000000000000',
  channel      text not null default 'linkedin',  -- linkedin | email
  metrics      jsonb not null default '{}',       -- {invites, invites_with_note, accepted, messages, …} see SQL-REFERENCE
  computed_at  timestamptz not null default now(),
  primary key (workspace_id, day, client_id, sequence_id, node_id, variant_id, sender_id, channel)
);
create index if not exists outreach_daily_stats_seq_idx on outreach_daily_stats(sequence_id, day);
create index if not exists outreach_daily_stats_sender_idx on outreach_daily_stats(sender_id, day);

create table if not exists outreach_saved_ranges (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  name         text not null,
  preset       text,                        -- '7d' | '30d' | 'qtd' … or null with from/to
  from_date    date,
  to_date      date,
  created_at   timestamptz not null default now()
);

create table if not exists outreach_report_schedules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  client_id     uuid references outreach_clients(id) on delete cascade,
  kind          text not null check (kind in ('digest','client_report','sender_report')),
  cadence       text not null default 'weekly' check (cadence in ('weekly','monthly')),
  recipients    citext[] not null default '{}',
  include_client_viewers boolean not null default false,
  active        boolean not null default true,
  last_sent_at  timestamptz,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create unique index if not exists outreach_report_schedules_uq on outreach_report_schedules
  (workspace_id, coalesce(client_id, '00000000-0000-0000-0000-000000000000'::uuid), kind);

-- -----------------------------------------------------------------------------
-- Enrichment (item 13)
-- -----------------------------------------------------------------------------
create table if not exists outreach_lead_profiles (
  lead_id            uuid primary key references outreach_leads(id) on delete cascade,
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  about              text,
  current_title      text,
  current_company    text,
  current_started_on date,
  experience         jsonb,                 -- [{company, company_id, title, start, end, current, location, description}]
  education          jsonb,                 -- [{school, degree, field, start, end}]
  skills             text[],
  languages          text[],
  profile_language   text,
  follower_count     int,
  connections_count  int,
  posts              jsonb,                 -- [{id, text, date, reactions, comments, url}] newest first, ≤5
  posts_fetched_at   timestamptz,
  last_posted_at     timestamptz,
  enriched_at        timestamptz,
  enriched_by_sender uuid references outreach_senders(id) on delete set null,
  source             text,                  -- prefetch | step | background | manual | draft
  empty_sections     text[] not null default '{}',   -- sections that came back empty last time = unknown, retry later
  updated_at         timestamptz not null default now()
);
create index if not exists outreach_lead_profiles_ws_idx on outreach_lead_profiles(workspace_id, enriched_at);
create index if not exists outreach_lead_profiles_skills_gin on outreach_lead_profiles using gin (skills);

-- background path: leads not yet in a sequence
create table if not exists outreach_enrich_queue (
  lead_id       uuid primary key references outreach_leads(id) on delete cascade,
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  want_posts    boolean not null default false,
  requested_by  uuid references auth.users(id),
  reason        text not null default 'manual',     -- manual | import | setting | re_enrich
  attempts      int not null default 0,
  last_error    text,
  next_at       timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists outreach_enrich_queue_due_idx on outreach_enrich_queue(workspace_id, next_at);

-- sender back-off when LinkedIn throttles full sections (empty twice in a row)
alter table outreach_senders
  add column if not exists enrich_empty_streak int not null default 0,
  add column if not exists enrich_backoff_until timestamptz;

-- -----------------------------------------------------------------------------
-- AI variables + review table (item 14), AI routing decisions (item 15)
-- -----------------------------------------------------------------------------
create table if not exists outreach_ai_variables (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  key          text not null check (key ~ '^[a-z][a-z0-9_]{1,39}$'),   -- used as {{ai.<key>|fallback}}
  name         text not null,
  prompt       text not null,
  fallback     text not null default '',
  needs_posts  boolean not null default false,
  max_chars    int not null default 220 check (max_chars between 20 and 1000),
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, key)
);

create table if not exists outreach_ai_batches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  variable_id  uuid not null references outreach_ai_variables(id) on delete cascade,
  sequence_id  uuid references outreach_sequences(id) on delete set null,
  requested_by uuid references auth.users(id),
  total        int not null default 0,
  status       text not null default 'generating' check (status in ('generating','review','done','cancelled')),
  hold_enrollments boolean not null default false,
  created_at   timestamptz not null default now(),
  finished_at  timestamptz
);

create table if not exists outreach_ai_values (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id      uuid not null references outreach_leads(id) on delete cascade,
  variable_id  uuid not null references outreach_ai_variables(id) on delete cascade,
  batch_id     uuid references outreach_ai_batches(id) on delete set null,
  text         text,
  facts        jsonb not null default '[]',   -- the profile facts the line relied on (shown in the review table)
  status       text not null default 'pending' check (status in ('pending','generated','approved','skipped','blank','failed')),
  edited       boolean not null default false,
  model        text,
  error        text,
  approved_by  uuid references auth.users(id),
  approved_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (lead_id, variable_id)
);
create index if not exists outreach_ai_values_batch_idx on outreach_ai_values(batch_id, status);
create index if not exists outreach_ai_values_pending_idx on outreach_ai_values(created_at) where status = 'pending';

create table if not exists outreach_ai_route_decisions (
  enrollment_id uuid not null references outreach_enrollments(id) on delete cascade,
  node_id       text not null,
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id       uuid not null references outreach_leads(id) on delete cascade,
  branch        text,                        -- null while pending
  reason        text,
  facts         jsonb not null default '[]',
  model         text,
  attempts      int not null default 0,
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,
  primary key (enrollment_id, node_id)
);
create index if not exists outreach_ai_route_pending_idx on outreach_ai_route_decisions(requested_at) where decided_at is null;

-- -----------------------------------------------------------------------------
-- Lead sources: repeating imports, update mode, auto-enrol rules (item 18)
-- -----------------------------------------------------------------------------
alter table outreach_import_jobs
  add column if not exists mode          text not null default 'upsert' check (mode in ('upsert','update_only')),
  add column if not exists update_fields text[] not null default '{}',
  add column if not exists enrich        boolean not null default false,
  add column if not exists schedule_id   uuid;

create table if not exists outreach_import_schedules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  client_id    uuid references outreach_clients(id) on delete set null,
  sender_id    uuid references outreach_senders(id) on delete set null,
  name         text not null,
  kind         outreach_import_kind_t not null,
  params       jsonb not null default '{}',
  list_id      uuid references outreach_lists(id) on delete set null,
  tag_ids      uuid[] not null default '{}',
  enrich       boolean not null default false,
  cadence      text not null check (cadence in ('daily','weekly','monthly')),
  active       boolean not null default true,
  next_run_at  timestamptz not null default now(),
  last_job_id  uuid,
  last_run_at  timestamptz,
  runs         int not null default 0,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);
create index if not exists outreach_import_schedules_due_idx on outreach_import_schedules(next_run_at) where active;

create table if not exists outreach_auto_enroll_rules (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  sequence_id  uuid not null references outreach_sequences(id) on delete cascade,
  name         text not null,
  list_id      uuid references outreach_lists(id) on delete cascade,   -- "when a lead joins list X"
  filter       jsonb not null default '{}',                           -- or "matches filter Y": {tag_ids, stage_id, client_id, title_contains, company_contains, source, min_followers, posted_within_days}
  daily_cap    int not null default 50 check (daily_cap between 1 and 1000),
  active       boolean not null default true,
  last_run_at  timestamptz,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  check (list_id is not null or filter <> '{}'::jsonb)
);
create index if not exists outreach_auto_enroll_rules_seq_idx on outreach_auto_enroll_rules(sequence_id);

create table if not exists outreach_auto_enroll_log (
  id         bigserial primary key,
  rule_id    uuid not null references outreach_auto_enroll_rules(id) on delete cascade,
  day        date not null,
  matched    int not null default 0,
  enrolled   int not null default 0,
  skipped    jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index if not exists outreach_auto_enroll_log_idx on outreach_auto_enroll_log(rule_id, at desc);

-- -----------------------------------------------------------------------------
-- Email depth (item 20): tracking domains
-- -----------------------------------------------------------------------------
create table if not exists outreach_tracking_domains (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id    uuid references outreach_senders(id) on delete cascade,   -- null = workspace default
  hostname     citext not null,
  status       text not null default 'pending_dns' check (status in ('pending_dns','awaiting_approval','active','failed')),
  cname_target text not null default 's1.lnk-fllw.com',
  checked_at   timestamptz,
  approved_at  timestamptz,
  note         text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  unique (hostname)
);

-- -----------------------------------------------------------------------------
-- Public API (item 21)
-- -----------------------------------------------------------------------------
create table if not exists outreach_api_keys (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,   -- the key acts as this member, never above `role`
  name         text not null,
  prefix       text not null,               -- first 12 chars, shown in settings ("ok_live_ab12…")
  key_hash     text not null unique,        -- sha256(key)
  role         outreach_role_t not null default 'member',
  client_ids   uuid[] not null default '{}',
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_api_keys_ws_idx on outreach_api_keys(workspace_id);

create table if not exists outreach_api_idempotency (
  key_id       uuid not null references outreach_api_keys(id) on delete cascade,
  idem_key     text not null,
  request_hash text not null,
  status       int,
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (key_id, idem_key)
);

alter table outreach_outbound_webhook_deliveries add column if not exists replay_of bigint;

-- -----------------------------------------------------------------------------
-- CRM sync (item 22)
-- -----------------------------------------------------------------------------
create table if not exists outreach_integrations (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  provider      text not null check (provider in ('hubspot','pipedrive','salesforce')),
  status        text not null default 'connecting' check (status in ('connecting','active','error','disconnected')),
  account_label text,
  settings      jsonb not null default '{"sync_rule":"replied","log_messages":true,"create_deal_on_interested":false,"suppress_customers":false}',
  field_mapping jsonb not null default '{}',
  stage_mapping jsonb not null default '{}',
  last_event_id bigint not null default 0,
  last_sync_at  timestamptz,
  last_pull_at  timestamptz,
  last_error    text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  unique (workspace_id, provider)
);

create table if not exists outreach_integration_secrets (   -- service role only
  integration_id    uuid primary key references outreach_integrations(id) on delete cascade,
  access_token_enc  text,
  refresh_token_enc text,
  expires_at        timestamptz,
  instance_url      text,
  oauth_state       text,
  updated_at        timestamptz not null default now()
);

create table if not exists outreach_integration_events (    -- the event stream the CRM worker reads
  id           bigserial primary key,
  workspace_id uuid not null,
  event        text not null,
  payload      jsonb not null,
  at           timestamptz not null default now()
);
create index if not exists outreach_integration_events_ws_idx on outreach_integration_events(workspace_id, id);

create table if not exists outreach_crm_links (
  integration_id  uuid not null references outreach_integrations(id) on delete cascade,
  lead_id         uuid not null references outreach_leads(id) on delete cascade,
  crm_contact_id  text,
  crm_company_id  text,
  crm_deal_id     text,
  last_synced_at  timestamptz,
  primary key (integration_id, lead_id)
);

create table if not exists outreach_crm_sync_log (
  id             bigserial primary key,
  integration_id uuid not null references outreach_integrations(id) on delete cascade,
  workspace_id   uuid not null,
  lead_id        uuid,
  direction      text not null check (direction in ('push','pull')),
  op             text not null,              -- contact.upsert | note.create | deal.create | stage.update | list.import | suppress.refresh
  status         text not null check (status in ('ok','skipped','error')),
  detail         text,
  at             timestamptz not null default now()
);
create index if not exists outreach_crm_sync_log_idx on outreach_crm_sync_log(integration_id, at desc);
create index if not exists outreach_crm_sync_log_lead_idx on outreach_crm_sync_log(lead_id, at desc);

-- -----------------------------------------------------------------------------
-- White-label domains (item 23), booking (item 24), voice clips (item 25)
-- -----------------------------------------------------------------------------
create table if not exists outreach_workspace_domains (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  client_id          uuid references outreach_clients(id) on delete cascade,   -- land on this client's portal
  hostname           citext not null unique,
  status             text not null default 'pending_dns' check (status in ('pending_dns','verifying','active','failed')),
  verification_token text not null default encode(gen_random_bytes(16),'hex'),
  cname_target       text,
  verified_at        timestamptz,
  last_checked_at    timestamptz,
  last_error         text,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now()
);

create table if not exists outreach_booking_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id      uuid references outreach_leads(id) on delete set null,
  sender_id    uuid references outreach_senders(id) on delete set null,
  provider     text not null check (provider in ('calendly','calcom','manual','api')),
  external_id  text,
  status       text not null default 'booked' check (status in ('booked','cancelled','rescheduled')),
  invitee_email citext,
  starts_at    timestamptz,
  payload      jsonb,
  created_at   timestamptz not null default now(),
  unique (provider, external_id)
);
create index if not exists outreach_booking_events_ws_idx on outreach_booking_events(workspace_id, created_at desc);

create table if not exists outreach_voice_clips (
  sequence_id  uuid not null references outreach_sequences(id) on delete cascade,
  node_id      text not null,
  sender_id    uuid not null references outreach_senders(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  path         text not null,                -- outreach-attachments/<ws>/voice/<sequence>/<node>/<sender>.<ext>
  mime         text not null,
  duration_s   numeric,
  size_bytes   int,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  primary key (sequence_id, node_id, sender_id)
);

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'outreach_workspace_secrets','outreach_alerts','outreach_lead_milestones','outreach_daily_stats','outreach_saved_ranges','outreach_report_schedules',
    'outreach_lead_profiles','outreach_enrich_queue','outreach_ai_variables','outreach_ai_batches','outreach_ai_values','outreach_ai_route_decisions',
    'outreach_import_schedules','outreach_auto_enroll_rules','outreach_auto_enroll_log','outreach_tracking_domains','outreach_api_keys','outreach_api_idempotency',
    'outreach_integrations','outreach_integration_secrets','outreach_integration_events','outreach_crm_links','outreach_crm_sync_log',
    'outreach_workspace_domains','outreach_booking_events','outreach_voice_clips']) loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- service-only (no policies): workspace_secrets, api_idempotency, integration_secrets, integration_events, enrich_queue writes

select outreach__policy('outreach_alerts','alerts_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_lead_milestones','milestones_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_daily_stats','dstats_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, nullif(client_id, ''00000000-0000-0000-0000-000000000000''::uuid))');
select outreach__policy('outreach_saved_ranges','ranges_select','select','user_id = auth.uid()');
select outreach__policy('outreach_saved_ranges','ranges_i','insert','user_id = auth.uid() and workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_saved_ranges','ranges_d','delete','user_id = auth.uid()');
select outreach__policy('outreach_report_schedules','rsched_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_report_schedules','rsched_i','insert','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_report_schedules','rsched_u','update','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_report_schedules','rsched_d','delete','outreach_can_manage(workspace_id)');

select outreach__policy('outreach_lead_profiles','lprof_select','select','exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_enrich_queue','enrq_select','select','workspace_id in (select outreach_workspace_ids())');

select outreach__policy('outreach_ai_variables','aivar_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_ai_variables','aivar_i','insert','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_ai_variables','aivar_u','update','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_ai_variables','aivar_d','delete','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_ai_batches','aibatch_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_ai_values','aival_select','select','exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_ai_route_decisions','airoute_select','select','workspace_id in (select outreach_workspace_ids())');

select outreach__policy('outreach_import_schedules','isched_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_import_schedules','isched_u','update','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_import_schedules','isched_d','delete','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_auto_enroll_rules','aer_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_auto_enroll_log','aerl_select','select','exists (select 1 from outreach_auto_enroll_rules r where r.id = rule_id and r.workspace_id in (select outreach_workspace_ids()))');

select outreach__policy('outreach_tracking_domains','tdom_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_api_keys','apikeys_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_integrations','integ_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_crm_links','crml_select','select','exists (select 1 from outreach_integrations i where i.id = integration_id and i.workspace_id in (select outreach_workspace_ids()))');
select outreach__policy('outreach_crm_sync_log','crmlog_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_workspace_domains','wdom_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_booking_events','book_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_voice_clips','vclip_select','select','workspace_id in (select outreach_workspace_ids())');

-- api key hashes must never reach the browser: column-level privilege instead of a view
revoke select on outreach_api_keys from authenticated, anon;
grant select (id, workspace_id, user_id, name, prefix, role, client_ids, last_used_at, expires_at, revoked_at, created_at) on outreach_api_keys to authenticated;
-- same for the domain verification token (owners see it through an RPC)
revoke select on outreach_workspace_domains from anon;

-- realtime for the screens that watch these
do $$
declare t text;
begin
  for t in select unnest(array['outreach_alerts','outreach_ai_values','outreach_ai_batches','outreach_sequences']) loop
    begin execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null; when others then raise notice 'realtime add % skipped: %', t, sqlerrm; end;
  end loop;
end $$;
