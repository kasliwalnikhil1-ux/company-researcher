-- =============================================================================
-- Outreach Platform — 025 Instagram & WhatsApp channels: schema, seeds, RLS
-- Source: docs/outreach/CHANNELS-BUILD-CONTRACT.md §2 (instagram-whatsapp-channels-PRD.md, 25 Sep 2026).
-- Requires 024 (enum values). Idempotent. Nothing is dropped or truncated; the two primary keys that gain a
-- `provider` column are replaced in a guarded block (same pattern as 010 for outreach_node_stats).
--
-- What lives here
--   * outreach_channel_capabilities   the descriptor per provider (seeded; the engine, the UI, the MCP and the validator read it)
--   * provider on ceilings / warmup    existing rows = LINKEDIN; Instagram and WhatsApp get their own numbers (PRD §7.4, §7.6)
--   * outreach_channel_totals          Instagram's daily "all metered actions" cap per warm-up level
--   * outreach_sender_budgets_scoped   hourly (Instagram) and daily all-actions ledger rows; the check constraint is the cap
--   * sender columns                   quiet period, provider warning, account-age attestation
--   * outreach_lead_identities         one lead, many channel identities (+ LinkedIn backfill)
--   * outreach_lead_consent            the consent ledger (WhatsApp gate)
--   * chats / messages                 message requests, reactions, read receipts, voice-note transcripts (+ transcribe queue)
--   * sequences / enrollments          sender_pools per provider (trigger-maintained), current_channel, channel_sender_map
--   * outreach_sender_followers        follow-back detection cache (+ followers poll plan)
-- Writes to identities / consent go through SQL functions (026) or the service role.
-- Mail providers (GMAIL / OUTLOOK / IMAP) keep reading the LINKEDIN ceiling and warm-up rows: their allowances do not change.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Channel capability descriptors (PRD §5.1)
-- -----------------------------------------------------------------------------
create table if not exists outreach_channel_capabilities (
  provider                 outreach_provider_t primary key,
  identifier_kind          text not null check (identifier_kind in ('slug','handle','phone_e164','email')),
  has_connection_graph     boolean not null default false,
  connection_is_permission boolean not null default false,
  acceptance_webhook       boolean not null default false,
  can_validate_identifier  boolean not null default false,
  supports                 jsonb not null default '{}',   -- {invite, inmail, follow, post_react, post_comment, profile_view, voice_note, attachment, embed_video, search_people}
  ledger                   jsonb not null default '{}',   -- {hourly: {scope, cap, types} | null, daily_scope: {scope, types} | null, min_gap_seconds: [lo, hi], post_connect_quiet_hours}
  consent                  jsonb not null default '{}'    -- {required_for_first_contact, accepted_bases}
);

insert into outreach_channel_capabilities(provider, identifier_kind, has_connection_graph, connection_is_permission, acceptance_webhook, can_validate_identifier, supports, ledger, consent) values
  ('LINKEDIN', 'slug', true, true, true, false,
   '{"invite":true,"inmail":true,"follow":true,"post_react":true,"post_comment":true,"profile_view":true,"voice_note":true,"attachment":true,"embed_video":true,"search_people":"full"}',
   '{"hourly":null,"daily_scope":null,"min_gap_seconds":[90,400],"post_connect_quiet_hours":0}',
   '{"required_for_first_contact":false,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}'),
  ('INSTAGRAM', 'handle', false, false, false, false,
   '{"invite":false,"inmail":false,"follow":true,"post_react":true,"post_comment":true,"profile_view":true,"voice_note":true,"attachment":true,"embed_video":false,"search_people":"partial"}',
   '{"hourly":{"scope":"all_metered","cap":10,"types":["follow","unfollow","new_chat","message","like","comment","profile_view","followers_poll","post_fetch"]},"daily_scope":{"scope":"all_metered","types":["follow","unfollow","new_chat","message","like","comment","profile_view","followers_poll","post_fetch"]},"min_gap_seconds":[60,240],"post_connect_quiet_hours":0}',
   '{"required_for_first_contact":false,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}'),
  ('WHATSAPP', 'phone_e164', false, false, false, true,
   '{"invite":false,"inmail":false,"follow":false,"post_react":false,"post_comment":false,"profile_view":true,"voice_note":true,"attachment":true,"embed_video":true,"search_people":"none"}',
   '{"hourly":null,"daily_scope":null,"min_gap_seconds":[10,20],"post_connect_quiet_hours":24}',
   '{"required_for_first_contact":true,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}'),
  ('GMAIL', 'email', false, false, false, false,
   '{"invite":false,"inmail":false,"follow":false,"post_react":false,"post_comment":false,"profile_view":false,"voice_note":false,"attachment":true,"embed_video":false,"search_people":"none"}',
   '{"hourly":null,"daily_scope":null,"min_gap_seconds":[30,120],"post_connect_quiet_hours":0}',
   '{"required_for_first_contact":false,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}'),
  ('OUTLOOK', 'email', false, false, false, false,
   '{"invite":false,"inmail":false,"follow":false,"post_react":false,"post_comment":false,"profile_view":false,"voice_note":false,"attachment":true,"embed_video":false,"search_people":"none"}',
   '{"hourly":null,"daily_scope":null,"min_gap_seconds":[30,120],"post_connect_quiet_hours":0}',
   '{"required_for_first_contact":false,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}'),
  ('IMAP', 'email', false, false, false, false,
   '{"invite":false,"inmail":false,"follow":false,"post_react":false,"post_comment":false,"profile_view":false,"voice_note":false,"attachment":true,"embed_video":false,"search_people":"none"}',
   '{"hourly":null,"daily_scope":null,"min_gap_seconds":[30,120],"post_connect_quiet_hours":0}',
   '{"required_for_first_contact":false,"accepted_bases":["inbound","form_optin","existing_customer","linkedin_reply","explicit_share","imported_attested"]}')
on conflict (provider) do update set identifier_kind = excluded.identifier_kind, has_connection_graph = excluded.has_connection_graph,
  connection_is_permission = excluded.connection_is_permission, acceptance_webhook = excluded.acceptance_webhook, can_validate_identifier = excluded.can_validate_identifier,
  supports = excluded.supports, ledger = excluded.ledger, consent = excluded.consent;

-- -----------------------------------------------------------------------------
-- Ceilings and warm-up caps get a provider. Existing rows are LinkedIn. PK becomes (provider, action_type) / (provider, level, action_type).
-- -----------------------------------------------------------------------------
alter table outreach_platform_ceilings add column if not exists provider outreach_provider_t not null default 'LINKEDIN';
alter table outreach_warmup_caps       add column if not exists provider outreach_provider_t not null default 'LINKEDIN';

do $$ begin
  if exists (select 1 from pg_constraint where conname = 'outreach_platform_ceilings_pkey' and conrelid = 'outreach_platform_ceilings'::regclass
             and array_length(conkey,1) = 1) then
    alter table outreach_platform_ceilings drop constraint outreach_platform_ceilings_pkey;
    alter table outreach_platform_ceilings add primary key (provider, action_type);
  end if;
  if exists (select 1 from pg_constraint where conname = 'outreach_warmup_caps_pkey' and conrelid = 'outreach_warmup_caps'::regclass
             and array_length(conkey,1) = 2) then
    alter table outreach_warmup_caps drop constraint outreach_warmup_caps_pkey;
    alter table outreach_warmup_caps add primary key (provider, level, action_type);
  end if;
end $$;

-- LinkedIn: new_chat = the same numbers as message (ceiling 100; warm-up 5/10/20/35/50/60). Nothing else changes.
insert into outreach_platform_ceilings(provider, action_type, per_day, per_week) values ('LINKEDIN', 'new_chat', 100, null)
on conflict (provider, action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week;
insert into outreach_warmup_caps(provider, level, action_type, per_day)
select 'LINKEDIN', l, 'new_chat'::outreach_action_type_t, v from (values (0,5),(1,10),(2,20),(3,35),(4,50),(5,60)) x(l,v)
on conflict (provider, level, action_type) do update set per_day = excluded.per_day;

-- Instagram (PRD §4.1, §7.6): 100 actions/day, 10/hour across every metered type; level 0 cannot DM.
insert into outreach_platform_ceilings(provider, action_type, per_day, per_week)
select 'INSTAGRAM', t::outreach_action_type_t, v, null from (values
  ('profile_view',60),('follow',30),('unfollow',15),('new_chat',25),('message',50),('like',40),('comment',15),('post_fetch',40),('followers_poll',3),
  ('reply',100000),('call_api',100000),('find_email',100000)) x(t,v)
on conflict (provider, action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week;
insert into outreach_warmup_caps(provider, level, action_type, per_day)
select 'INSTAGRAM', l, t::outreach_action_type_t, v from (values
  (0,'new_chat',0),(1,'new_chat',3),(2,'new_chat',8),(3,'new_chat',15),(4,'new_chat',20),(5,'new_chat',25),
  (0,'follow',5),(1,'follow',10),(2,'follow',15),(3,'follow',20),(4,'follow',25),(5,'follow',30),
  (0,'like',8),(1,'like',15),(2,'like',25),(3,'like',30),(4,'like',35),(5,'like',40),
  (0,'comment',0),(1,'comment',3),(2,'comment',6),(3,'comment',10),(4,'comment',12),(5,'comment',15),
  (0,'profile_view',10),(1,'profile_view',20),(2,'profile_view',30),(3,'profile_view',40),(4,'profile_view',50),(5,'profile_view',60),
  (0,'message',0),(1,'message',6),(2,'message',16),(3,'message',30),(4,'message',40),(5,'message',50),
  (0,'unfollow',0),(1,'unfollow',3),(2,'unfollow',5),(3,'unfollow',8),(4,'unfollow',10),(5,'unfollow',15),
  (0,'post_fetch',8),(1,'post_fetch',15),(2,'post_fetch',25),(3,'post_fetch',30),(4,'post_fetch',35),(5,'post_fetch',40),
  (0,'followers_poll',1),(1,'followers_poll',2),(2,'followers_poll',2),(3,'followers_poll',3),(4,'followers_poll',3),(5,'followers_poll',3)) x(l,t,v)
on conflict (provider, level, action_type) do update set per_day = excluded.per_day;

-- WhatsApp (PRD §7.4): the governor level IS warmup_level (0–4); level 5 = level 4 because the sender check allows 0–5.
insert into outreach_platform_ceilings(provider, action_type, per_day, per_week)
select 'WHATSAPP', t::outreach_action_type_t, v, null from (values
  ('new_chat',35),('message',100),('identifier_check',50),('reply',100000),('call_api',100000),('find_email',100000)) x(t,v)
on conflict (provider, action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week;
insert into outreach_warmup_caps(provider, level, action_type, per_day)
select 'WHATSAPP', l, t::outreach_action_type_t, v from (values
  (0,'new_chat',2),(1,'new_chat',5),(2,'new_chat',10),(3,'new_chat',20),(4,'new_chat',35),(5,'new_chat',35),
  (0,'message',100),(1,'message',100),(2,'message',100),(3,'message',100),(4,'message',100),(5,'message',100),
  (0,'identifier_check',50),(1,'identifier_check',50),(2,'identifier_check',50),(3,'identifier_check',50),(4,'identifier_check',50),(5,'identifier_check',50)) x(l,t,v)
on conflict (provider, level, action_type) do update set per_day = excluded.per_day;

-- Daily "all metered actions" total per level (Instagram only): per-type caps can never sum past it.
create table if not exists outreach_channel_totals (
  provider outreach_provider_t not null,
  level    smallint not null,
  per_day  int not null,
  primary key (provider, level)
);
insert into outreach_channel_totals(provider, level, per_day)
select 'INSTAGRAM', l, v from (values (0,15),(1,30),(2,50),(3,70),(4,85),(5,100)) x(l,v)
on conflict (provider, level) do update set per_day = excluded.per_day;

-- -----------------------------------------------------------------------------
-- Scoped ledger rows: ('hour', date_trunc('hour', at), 'all_metered') for Instagram, ('day', sender-local day start, 'all_metered')
-- where the descriptor declares a daily scope. `window` is a reserved word: always quote it.
-- -----------------------------------------------------------------------------
create table if not exists outreach_sender_budgets_scoped (
  sender_id    uuid not null references outreach_senders(id) on delete cascade,
  "window"     text not null check ("window" in ('hour','day')),
  window_start timestamptz not null,
  scope        text not null,
  cap          int not null,
  used         int not null default 0,
  reserved     int not null default 0,
  primary key (sender_id, "window", window_start, scope),
  check (used + reserved <= cap)
);
create index if not exists outreach_sender_budgets_scoped_start_idx on outreach_sender_budgets_scoped(window_start);

-- -----------------------------------------------------------------------------
-- Senders: post-connect quiet period (PRD §7.3), provider warning (PRD §7.5), WhatsApp account-age attestation (PRD §7.4)
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists outreach_allowed_from    timestamptz,
  add column if not exists provider_warning         jsonb,          -- null | {text, at, level_before, paused_until}
  add column if not exists account_age_attested_at  timestamptz,
  add column if not exists account_age_attested_by  uuid references auth.users(id),
  add column if not exists account_age_months       int;

-- -----------------------------------------------------------------------------
-- Identities (PRD §8): identifier is a LinkedIn slug, an Instagram handle, an E.164 phone ('+…') or an email
-- -----------------------------------------------------------------------------
create table if not exists outreach_lead_identities (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id         uuid not null references outreach_leads(id) on delete cascade,
  provider        outreach_provider_t not null,
  identifier      citext not null,
  provider_id     text,
  verified        boolean not null default false,
  source          text,                     -- import | inbound | profile_fetch | operator | enrichment | backfill
  is_valid        boolean,                  -- WhatsApp: result of identifier_check; null = not checked
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  unique (workspace_id, provider, identifier)
);
create index if not exists outreach_lead_identities_lead_idx on outreach_lead_identities(lead_id);
create index if not exists outreach_lead_identities_pid_idx on outreach_lead_identities(workspace_id, provider, provider_id) where provider_id is not null;

-- Backfill: every lead with a LinkedIn slug gets a verified LINKEDIN identity row. Leads' own columns stay the source for LinkedIn.
insert into outreach_lead_identities(workspace_id, lead_id, provider, identifier, provider_id, verified, source, created_at)
select l.workspace_id, l.id, 'LINKEDIN', l.public_identifier, l.provider_id, true, 'backfill', l.created_at
  from outreach_leads l where l.public_identifier is not null
on conflict (workspace_id, provider, identifier) do nothing;

-- -----------------------------------------------------------------------------
-- Consent ledger (PRD §6.3)
-- -----------------------------------------------------------------------------
create table if not exists outreach_lead_consent (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id        uuid not null references outreach_leads(id) on delete cascade,
  channel        outreach_provider_t not null,
  basis          outreach_consent_basis_t not null,
  evidence       jsonb not null default '{}',   -- {url, form_id, message_id, chat_id, imported_from, note}
  attested_by    uuid references auth.users(id),
  obtained_at    timestamptz not null default now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,
  created_at     timestamptz not null default now()
);
create unique index if not exists outreach_lead_consent_active_uq on outreach_lead_consent(lead_id, channel) where revoked_at is null;
create index if not exists outreach_lead_consent_ws_idx on outreach_lead_consent(workspace_id, channel, basis);

-- -----------------------------------------------------------------------------
-- Inbox: message requests, reactions, read receipts, voice-note transcripts
-- -----------------------------------------------------------------------------
alter table outreach_chats add column if not exists is_request boolean not null default false;   -- Instagram: still in the Requests tab
alter table outreach_messages
  add column if not exists reactions         jsonb not null default '[]',   -- [{emoji, by, at}]
  add column if not exists read_at           timestamptz,
  add column if not exists transcript        text,
  add column if not exists transcript_status text check (transcript_status is null or transcript_status in ('pending','done','failed'));

create table if not exists outreach_transcribe_queue (   -- service only
  message_id uuid primary key references outreach_messages(id) on delete cascade,
  attempts   int not null default 0,
  locked_at  timestamptz,
  created_at timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Sequences: sender pool per provider (trigger-maintained). Enrollments: the channel a lead is on right now.
-- -----------------------------------------------------------------------------
alter table outreach_sequences add column if not exists sender_pools jsonb not null default '{}';   -- {"LINKEDIN":[ids],"INSTAGRAM":[ids],…}
alter table outreach_enrollments
  add column if not exists current_channel    outreach_provider_t,
  add column if not exists channel_sender_map jsonb not null default '{}';                          -- {"WHATSAPP": senderId, …}

create or replace function outreach_trg_sequence_pools() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  select coalesce(jsonb_object_agg(x.prov, x.ids), '{}'::jsonb) into new.sender_pools
    from (select s.provider::text as prov, jsonb_agg(s.id order by array_position(new.sender_pool, s.id)) as ids
            from outreach_senders s where s.id = any(new.sender_pool) group by s.provider) x;
  return new;
end $$;
drop trigger if exists outreach_sequences_pools on outreach_sequences;
create trigger outreach_sequences_pools before insert or update of sender_pool on outreach_sequences
  for each row execute function outreach_trg_sequence_pools();

-- backfill once: touching sender_pool fires the trigger
update outreach_sequences set sender_pool = sender_pool where sender_pools = '{}'::jsonb and coalesce(array_length(sender_pool,1),0) > 0;
-- backfill: an enrollment's channel is its sender's provider
update outreach_enrollments e set current_channel = s.provider from outreach_senders s where s.id = e.sender_id and e.current_channel is null;

-- -----------------------------------------------------------------------------
-- Instagram follow-back detection (PRD §9.3): the sender's own followers, diffed against leads waiting in wait_follow_back
-- -----------------------------------------------------------------------------
create table if not exists outreach_sender_followers (   -- service only
  sender_id     uuid not null references outreach_senders(id) on delete cascade,
  provider_id   text not null,
  username      citext,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (sender_id, provider_id)
);
create index if not exists outreach_sender_followers_username_idx on outreach_sender_followers(sender_id, username);

create table if not exists outreach_followers_poll_plan (   -- service only
  sender_id uuid not null references outreach_senders(id) on delete cascade,
  day       date not null,
  times     timestamptz[] not null default '{}',
  done      int not null default 0,
  primary key (sender_id, day)
);

-- -----------------------------------------------------------------------------
-- RLS. Reads for the people who can see the lead / sender; every write goes through a function or the service role.
-- -----------------------------------------------------------------------------
alter table outreach_channel_capabilities   enable row level security;
alter table outreach_channel_totals         enable row level security;
alter table outreach_sender_budgets_scoped  enable row level security;
alter table outreach_lead_identities        enable row level security;
alter table outreach_lead_consent           enable row level security;
alter table outreach_transcribe_queue       enable row level security;   -- no policies: service role only
alter table outreach_sender_followers       enable row level security;   -- no policies: service role only
alter table outreach_followers_poll_plan    enable row level security;   -- no policies: service role only

select outreach__policy('outreach_channel_capabilities','chcaps_select','select','true');
select outreach__policy('outreach_channel_totals','chtotals_select','select','true');
select outreach__policy('outreach_sender_budgets_scoped','sbudgets_scoped_select','select',
  'exists (select 1 from outreach_senders s where s.id = sender_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_lead_identities','lid_select','select',
  'exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_identities','lid_i','insert',
  'exists (select 1 from outreach_leads l where l.id = lead_id and outreach_can_write(l.workspace_id) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_identities','lid_u','update',
  'exists (select 1 from outreach_leads l where l.id = lead_id and outreach_can_write(l.workspace_id) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_identities','lid_d','delete',
  'exists (select 1 from outreach_leads l where l.id = lead_id and outreach_can_write(l.workspace_id) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_consent','lcons_select','select',
  'exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');

-- realtime for the inbox (reactions / read receipts / transcripts arrive on existing rows; identities change on the lead page)
do $$
declare t text;
begin
  for t in select unnest(array['outreach_lead_identities','outreach_lead_consent']) loop
    begin execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null; when others then raise notice 'realtime add % skipped: %', t, sqlerrm; end;
  end loop;
end $$;
