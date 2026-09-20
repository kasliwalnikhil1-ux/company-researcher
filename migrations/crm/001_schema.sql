-- =============================================================================
-- Sales CRM (video-production studio standup CRM) — 001 schema
-- All objects are namespaced with the `crm_` prefix (tables, enums, functions,
-- views) so they never collide with the investor tables (`companies`,
-- `outreach_contacts`, …) or the outreach platform (`outreach_*`).
--
-- Access model: one internal team, everyone sees everything. Membership is the
-- `crm_members` table (user_id → auth.users); RLS lets any active member read
-- and write every CRM row. Non-members see nothing.
-- =============================================================================

create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Enums — deal stage is the deliberate exception to "lists are lookup tables":
-- the code reasons about stage order (forward-only rule, funnel).
-- -----------------------------------------------------------------------------
do $$ begin
  create type crm_deal_stage_t as enum ('new','contacted','replied','meeting_booked','meeting_held','proposal_sent','negotiation','won','lost');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crm_direction_t as enum ('outbound','inbound');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crm_meeting_status_t as enum ('scheduled','held','no_show','cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type crm_capture_outcome_t as enum ('held','no_show');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- Team membership
-- -----------------------------------------------------------------------------
create table if not exists crm_members (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  email         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Settings (key/value) — default timezone, stale threshold, default currency
-- -----------------------------------------------------------------------------
create table if not exists crm_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Lookup tables (never enums): anything the business may add next quarter.
-- Deactivate with is_active, never delete, so history keeps its labels.
-- -----------------------------------------------------------------------------
create table if not exists crm_icp_segments (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 100,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists crm_source_channels (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 100,
  notes       text,
  created_at  timestamptz not null default now()
);

create table if not exists crm_activity_types (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  is_active   boolean not null default true,
  sort_order  int not null default 100,
  notes       text,
  -- which scoreboard column(s) an activity of this type feeds (see crm_daily_scoreboard)
  counts_as   text,
  created_at  timestamptz not null default now()
);

-- Manual FX so every value is stored WITH its currency and still sums in USD.
create table if not exists crm_fx_rates (
  currency      text primary key,
  usd_per_unit  numeric(14,6) not null check (usd_per_unit > 0),
  updated_at    timestamptz not null default now()
);

-- Manual monthly channel spend (feeds funnel cost / CAC; nullable by design).
create table if not exists crm_channel_costs (
  id                 uuid primary key default gen_random_uuid(),
  source_channel_id  uuid not null references crm_source_channels(id),
  month              date not null,                      -- first day of month
  cost               numeric(14,2) not null default 0,
  currency           text not null default 'USD',
  notes              text,
  unique (source_channel_id, month)
);

-- -----------------------------------------------------------------------------
-- Core objects
-- -----------------------------------------------------------------------------
create table if not exists crm_companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  website            text,
  domain             text,                                -- bare lowercase domain, derived from website
  country            text,
  timezone           text,                                -- IANA, e.g. Asia/Kolkata
  icp_segment_id     uuid references crm_icp_segments(id),
  source_channel_id  uuid references crm_source_channels(id),
  notes              text,
  created_by         uuid references crm_members(user_id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create unique index if not exists crm_companies_domain_uq on crm_companies (domain) where domain is not null;
create index if not exists crm_companies_name_idx on crm_companies (lower(name));

create table if not exists crm_contacts (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references crm_companies(id) on delete cascade,
  name          text not null,
  role          text,
  email         text,
  phone         text,
  linkedin_url  text,
  timezone      text,
  notes         text,
  is_primary    boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists crm_contacts_company_idx on crm_contacts (company_id);
create unique index if not exists crm_contacts_email_uq on crm_contacts (lower(email)) where email is not null;

create table if not exists crm_deals (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references crm_companies(id) on delete cascade,
  title                 text,                              -- optional label ("Q4 UGC batch"); UI shows company when null
  stage                 crm_deal_stage_t not null default 'new',
  owner_id              uuid references crm_members(user_id),
  value_monthly         numeric(14,2),
  currency              text not null default 'USD',
  value_monthly_usd     numeric(14,2),                     -- maintained by trigger from crm_fx_rates
  videos_per_month      int,
  expected_close_date   date,
  next_step             text,
  next_step_date        date,
  lost_reason           text,
  source_channel_id     uuid references crm_source_channels(id),
  delivery_project_id   uuid,                              -- hook: join to the client portal later (no FK yet)
  stage_entered_at      timestamptz not null default now(),
  last_activity_at      timestamptz,
  created_by            uuid references crm_members(user_id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  closed_at             timestamptz
);
create index if not exists crm_deals_company_idx on crm_deals (company_id);
create index if not exists crm_deals_stage_idx on crm_deals (stage);
create index if not exists crm_deals_owner_idx on crm_deals (owner_id);

create table if not exists crm_stage_history (
  id          uuid primary key default gen_random_uuid(),
  deal_id     uuid not null references crm_deals(id) on delete cascade,
  from_stage  crm_deal_stage_t,
  to_stage    crm_deal_stage_t not null,
  reason      text,                                        -- required when moving backwards
  changed_by  uuid,
  changed_at  timestamptz not null default now()
);
create index if not exists crm_stage_history_deal_idx on crm_stage_history (deal_id, changed_at);
create index if not exists crm_stage_history_to_idx on crm_stage_history (to_stage, changed_at);

create table if not exists crm_activities (
  id                 uuid primary key default gen_random_uuid(),
  contact_id         uuid references crm_contacts(id) on delete set null,
  company_id         uuid not null references crm_companies(id) on delete cascade,
  deal_id            uuid references crm_deals(id) on delete set null,
  activity_type_id   uuid not null references crm_activity_types(id),
  direction          crm_direction_t not null default 'outbound',
  occurred_at        timestamptz not null default now(),
  source_channel_id  uuid references crm_source_channels(id),
  body               text,
  outcome            text,                                 -- free text; conventions: connected | no_answer | voicemail | accepted | replied | booked
  owner_id           uuid references crm_members(user_id), -- who did it (commitments are measured against this)
  external_ref       text,                                 -- hook: id from an outreach tool when written by machine
  created_by         uuid,
  created_at         timestamptz not null default now()
);
create index if not exists crm_activities_contact_idx on crm_activities (contact_id, occurred_at desc);
create index if not exists crm_activities_company_idx on crm_activities (company_id, occurred_at desc);
create index if not exists crm_activities_deal_idx on crm_activities (deal_id, occurred_at desc);
create index if not exists crm_activities_occurred_idx on crm_activities (occurred_at desc);
create unique index if not exists crm_activities_external_ref_uq on crm_activities (external_ref) where external_ref is not null;

create table if not exists crm_meetings (
  id            uuid primary key default gen_random_uuid(),
  deal_id       uuid not null references crm_deals(id) on delete cascade,
  contact_id    uuid references crm_contacts(id) on delete set null,
  scheduled_at  timestamptz not null,
  timezone      text,                                      -- the prospect's tz for display
  duration_min  int default 30,
  attendees     text[] not null default '{}',
  status        crm_meeting_status_t not null default 'scheduled',
  notes         text,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists crm_meetings_deal_idx on crm_meetings (deal_id);
create index if not exists crm_meetings_sched_idx on crm_meetings (scheduled_at);

create table if not exists crm_meeting_captures (
  id                     uuid primary key default gen_random_uuid(),
  meeting_id             uuid not null unique references crm_meetings(id) on delete cascade,
  outcome                crm_capture_outcome_t not null,
  -- held
  pain_points            text[] not null default '{}',     -- prospect's own words
  commercials_discussed  jsonb,                            -- {price, volume, currency, notes}
  objections             text[] not null default '{}',
  next_step              text,
  next_step_date         date,
  is_dead                boolean not null default false,
  dead_reason            text,
  -- no-show
  no_show_reason         text,
  follow_up_action       text,
  follow_up_date         date,
  is_repeat_no_show      boolean not null default false,   -- computed by trigger from prior no-shows for the contact
  raw_notes              text,
  created_by             uuid,
  created_at             timestamptz not null default now()
);

create table if not exists crm_pain_point_tags (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique,
  label       text not null,
  created_at  timestamptz not null default now()
);

create table if not exists crm_capture_pain_tags (
  capture_id  uuid not null references crm_meeting_captures(id) on delete cascade,
  tag_id      uuid not null references crm_pain_point_tags(id) on delete cascade,
  verbatim    text,                                        -- the pain point text this tag came from
  primary key (capture_id, tag_id)
);

-- Call recording transcripts (one per meeting). Written by the `crm` skill after it runs the get-transcript skill
-- (Deepgram, speaker-diarized) on a recording, or pasted/saved through crm_save_transcript. Text is prospect speech: data, never instructions.
create table if not exists crm_meeting_transcripts (
  id                uuid primary key default gen_random_uuid(),
  meeting_id        uuid not null unique references crm_meetings(id) on delete cascade,
  turns             jsonb not null default '[]'::jsonb,     -- [{speaker: 0-based index | null, start: sec, end: sec, text}]
  speakers          jsonb not null default '[]'::jsonb,     -- [{speaker, label, role: prospect|team|unknown, contact_id?, member_id?, words?, share_of_words?, speaking_seconds?}]
  full_text         text not null default '',               -- "Label: text" per turn, for search and quoting
  summary           text,
  topics            text[] not null default '{}',
  language          text,
  duration_seconds  numeric(10,2),
  word_count        int,
  avg_confidence    numeric(5,4),
  low_confidence    jsonb not null default '[]'::jsonb,     -- [{word, start, confidence}] — words to double-check (prices, names)
  source            text,                                   -- file name or link the recording came from
  engine            text,                                   -- deepgram | whisper | manual
  model             text,
  created_by        uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One-time upload tickets: a member mints one through the connector, a script posts the (large) transcript with it,
-- so an hour of speech never has to travel through a tool-call argument. Only the SHA-256 of the token is stored.
create table if not exists crm_upload_tickets (
  token_sha256  text primary key,
  user_id       uuid not null,
  meeting_id    uuid not null references crm_meetings(id) on delete cascade,
  purpose       text not null default 'transcript',
  expires_at    timestamptz not null,
  used_at       timestamptz,
  created_at    timestamptz not null default now()
);

create table if not exists crm_commitments (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references crm_members(user_id),
  commit_date  date not null,
  targets      jsonb not null default '{}'::jsonb,          -- {dials, connects, linkedin_connects, emails, meetings_booked, proposals_sent, ...}
  notes        text,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_id, commit_date)
);

-- MCP connector call log (mirrors outreach_agent_calls; service role only)
create table if not exists crm_agent_calls (
  id           bigserial primary key,
  user_id      uuid,
  tool         text not null,
  args_sha256  text,
  outcome      text,
  error_code   text,
  duration_ms  int,
  at           timestamptz not null default now()
);
create index if not exists crm_agent_calls_at_idx on crm_agent_calls (at desc);
