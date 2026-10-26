-- =============================================================================
-- Outreach Platform — 094 leads: prospects vs inbox contacts, status, who is connected through which account
-- (leads-relationships-PRD.md, 26 Oct 2026). Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/094_leads_relationships.sql
-- Smoke test: migrations/outreach/tests/smoke_27_leads_relationships.sql
--
-- What changes
--   * outreach_leads: origin (import | manual | api | search | inbound), kind (person | company_page | automated),
--     prospect_since (set = Prospects tab), hidden_at / hidden_reason, enrich_wait_reason (why enrichment waits).
--   * outreach_chats.counterpart_kind: the other side of a conversation is a person, a company page or an automated sender.
--     The inbox Replies view only lists people; the rest sit under the "Other" chip.
--   * outreach_lead_sender_state: relation_source (our_invite | their_invite | pre_existing | unknown), connected_at,
--     relation_checked_at, we_follow / follows_us (Instagram). A BEFORE trigger derives source + connected_at on every
--     path that writes relation = 'first' (webhook, note-chat acceptance, profile fetch, relations import / poll,
--     followers poll), so no caller has to remember.
--   * outreach_lead_summary: one denormalised row per lead for the list (status ladder, connected / pending accounts,
--     channels, per-account contacted / replied). Recomputed from a queue (outreach_lead_summary_queue) by
--     outreach-worker-lead-summary (dispatcher row lead-summary, 30 s) and reconciled nightly (03:30 UTC).
--   * ops.inbound_kind_rules + outreach_inbound_kind(): the classification F2 runs before creating a lead for a new chat.
--   * Workspace setting create_leads_from_inbound: boolean -> 'people_only' | 'all' | 'none' (true -> people_only, false -> none).
--   * Enrichment: prospects first, inbox people after, automated / company pages / hidden never; the reason a row waits
--     is stored on the lead (budget: which account ran out and when it resets; queue: position).
--   * Backfill: origin + prospect flag from source / enrolments / lists / stages, kind from the first chat, junk hidden
--     (not deleted), relation_source from invite history (else 'unknown'), every lead queued for a summary.
--
-- Deviations from the PRD (also in docs/outreach/LEADS-RELATIONSHIPS.md)
--   * Queue is a plain table, not pgmq (pgmq is not installed; every other queue here is a table).
--   * Channels in the summary are text ('linkedin' | 'instagram' | 'whatsapp' | 'email'), the value outreach__channel_of()
--     gives, not provider_t: the three mail providers are one channel to the reader.
--   * The leads page keeps its PostgREST query (table layout, custom-field columns, selection), reading the summary through
--     an embed; outreach_leads_list / _totals / _by_account are the one SQL source for the connector, the API and the
--     totals line. The filter vocabulary is the same on both sides (outreach__leads_matching documents it).
--   * stages.is_meeting is added (default from kind = 'meeting'); 089 sequence stats reads meetings from
--     outreach_lead_milestones, which the stage trigger (010) already writes, so both agree.
-- =============================================================================

-- ----------------------------------------------------------------------------- 1. columns
alter table outreach_leads
  add column if not exists origin             text not null default 'import',
  add column if not exists kind               text not null default 'person',
  add column if not exists prospect_since     timestamptz,
  add column if not exists hidden_at          timestamptz,
  add column if not exists hidden_reason      text,
  add column if not exists enrich_wait_reason jsonb;
alter table outreach_leads drop constraint if exists outreach_leads_origin_chk;
alter table outreach_leads add constraint outreach_leads_origin_chk check (origin in ('import','manual','api','search','inbound'));
alter table outreach_leads drop constraint if exists outreach_leads_kind_chk;
alter table outreach_leads add constraint outreach_leads_kind_chk check (kind in ('person','company_page','automated'));
alter table outreach_leads drop constraint if exists outreach_leads_hidden_reason_chk;
alter table outreach_leads add constraint outreach_leads_hidden_reason_chk check (hidden_reason is null or hidden_reason in ('automated','company_page','manual'));
create index if not exists outreach_leads_ws_prospect_idx on outreach_leads(workspace_id, prospect_since) where hidden_at is null;
create index if not exists outreach_leads_ws_origin_idx   on outreach_leads(workspace_id, origin) where hidden_at is null;
create index if not exists outreach_leads_ws_hidden_idx   on outreach_leads(workspace_id, hidden_at) where hidden_at is not null;
comment on column outreach_leads.origin is 'How the lead came to exist: import (CSV, relations, Sales Navigator...), manual (added by hand / from the inbox), api (public API, connector, CRM), search (LinkedIn search import), inbound (they wrote first). Never changes.';
comment on column outreach_leads.kind is 'person | company_page | automated (newsletter, notification, no-reply). Set by F2 classification (outreach_inbound_kind) or the 094 backfill.';
comment on column outreach_leads.prospect_since is 'Set = the lead is a prospect (Prospects tab): imported / added / API / search leads from creation, inbound contacts once enrolled, listed, staged or promoted.';
comment on column outreach_leads.hidden_at is 'Hidden from every tab (automated / company-page leads, or hidden by hand). Reversible; the Hidden filter shows them.';
comment on column outreach_leads.enrich_wait_reason is 'While enrich_status = waiting: {"kind":"queue","position":n} or {"kind":"budget","sender_id","sender","resets_at"}; refreshed by outreach_enrich_wait_reason_refresh() after each enrichment run.';

alter table outreach_chats add column if not exists counterpart_kind text not null default 'person';
alter table outreach_chats drop constraint if exists outreach_chats_counterpart_kind_chk;
alter table outreach_chats add constraint outreach_chats_counterpart_kind_chk check (counterpart_kind in ('person','company_page','automated'));
create index if not exists outreach_chats_ws_kind_idx on outreach_chats(workspace_id, counterpart_kind) where counterpart_kind <> 'person';
comment on column outreach_chats.counterpart_kind is 'Who is on the other side: person | company_page | automated. Replies view = person only; the others sit under the inbox "Other" chip.';

alter table outreach_lead_sender_state
  add column if not exists relation_source     text,
  add column if not exists connected_at        timestamptz,
  add column if not exists relation_checked_at timestamptz,
  add column if not exists we_follow           boolean,
  add column if not exists follows_us          boolean;
alter table outreach_lead_sender_state drop constraint if exists outreach_lss_relation_source_chk;
alter table outreach_lead_sender_state add constraint outreach_lss_relation_source_chk check (relation_source is null or relation_source in ('our_invite','their_invite','pre_existing','unknown'));
comment on column outreach_lead_sender_state.relation_source is 'Where the connection came from: our_invite (accepted ours), their_invite (we accepted theirs), pre_existing (already connected when first seen), unknown (from before 094, history cannot tell). Derived by outreach_trg_lss_relation_source.';
comment on column outreach_lead_sender_state.connected_at is 'When the connection was first observed. Kept when the connection later disappears (Status keeps "Connected" as reached).';
comment on column outreach_lead_sender_state.relation_checked_at is 'Last time the relation was observed (profile fetch, poll, webhook). The Connected via hover shows it.';

alter table outreach_stages add column if not exists is_meeting boolean not null default false;
update outreach_stages set is_meeting = true where kind = 'meeting' and not is_meeting;
comment on column outreach_stages.is_meeting is 'A lead reaching this stage counts as Meeting (leads page status, sequence stats). Defaults from kind = meeting.';

-- ----------------------------------------------------------------------------- 2. tables
create table if not exists outreach_lead_summary (
  lead_id              uuid primary key references outreach_leads(id) on delete cascade,
  workspace_id         uuid not null references outreach_workspaces(id) on delete cascade,
  status               text not null default 'not_contacted'
      check (status in ('not_contacted','invited','connected','messaged','replied','interested','meeting','do_not_contact','bounced','wrote_to_us')),
  status_rank          smallint not null default 0,          -- the ladder step reached (0..6), whatever the override shown
  status_channel       text,                                 -- linkedin | instagram | whatsapp | email
  status_at            timestamptz,
  connected_sender_ids uuid[] not null default '{}',         -- current LinkedIn 1st / Instagram follow-back, removed accounts included
  connected_via_our_invite_ids uuid[] not null default '{}',
  pending_sender_ids   uuid[] not null default '{}',         -- invites / follows from us not answered
  connected_count      smallint not null default 0,
  pending_count        smallint not null default 0,
  connection_sources   text[] not null default '{}',         -- distinct relation_source of the current connections
  identity_channels    text[] not null default '{}',         -- reachable on
  used_channels        text[] not null default '{}',         -- we sent something on
  replied_channels     text[] not null default '{}',         -- they answered on (after a touch of ours)
  bounced_channels     text[] not null default '{}',         -- email hard bounce / WhatsApp number invalid
  contacted_sender_ids uuid[] not null default '{}',
  replied_sender_ids   uuid[] not null default '{}',
  first_contacted_at   timestamptz,
  connected_ever_at    timestamptz,
  replied_at           timestamptz,
  last_activity_at     timestamptz,
  wrote_first_at       timestamptz,
  updated_at           timestamptz not null default now()
);
alter table outreach_lead_summary add column if not exists connection_sources text[] not null default '{}';
create index if not exists outreach_lead_summary_ws_rank_idx on outreach_lead_summary(workspace_id, status_rank);
create index if not exists outreach_lead_summary_ws_status_idx on outreach_lead_summary(workspace_id, status);
create index if not exists outreach_lead_summary_ws_activity_idx on outreach_lead_summary(workspace_id, last_activity_at desc);
create index if not exists outreach_lead_summary_connected_gin on outreach_lead_summary using gin (connected_sender_ids);
create index if not exists outreach_lead_summary_pending_gin on outreach_lead_summary using gin (pending_sender_ids);
create index if not exists outreach_lead_summary_contacted_gin on outreach_lead_summary using gin (contacted_sender_ids);
create index if not exists outreach_lead_summary_channels_gin on outreach_lead_summary using gin (identity_channels);
alter table outreach_lead_summary enable row level security;
select outreach__policy('outreach_lead_summary','lsum_select','select',
  'exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');
revoke insert, update, delete on outreach_lead_summary from anon, authenticated;
grant select on outreach_lead_summary to authenticated;
grant all on outreach_lead_summary to service_role;
comment on table outreach_lead_summary is 'Per-lead summary for the leads page (094): status ladder, connected / pending accounts, channels, per-account contacted / replied. Written only by outreach_lead_summary_refresh (queue + nightly reconcile).';

create table if not exists outreach_lead_summary_queue (
  lead_id   uuid primary key references outreach_leads(id) on delete cascade,
  queued_at timestamptz not null default now(),
  attempts  int not null default 0,
  last_error text
);
create index if not exists outreach_lead_summary_queue_at_idx on outreach_lead_summary_queue(queued_at);
revoke all on outreach_lead_summary_queue from public, anon, authenticated;
grant all on outreach_lead_summary_queue to service_role;

create schema if not exists ops;
create table if not exists ops.inbound_kind_rules (
  id         serial primary key,
  channel    text not null check (channel in ('LINKEDIN','INSTAGRAM','WHATSAPP','EMAIL')),
  match_type text not null check (match_type in ('email_local_part_regex','email_domain','header','display_name','provider_id')),
  pattern    text not null,
  kind       text not null check (kind in ('company_page','automated')),
  active     boolean not null default true,
  note       text,
  created_at timestamptz not null default now()
);
revoke all on ops.inbound_kind_rules from public, anon, authenticated;
grant all on ops.inbound_kind_rules to service_role;
grant usage on sequence ops.inbound_kind_rules_id_seq to service_role;
comment on table ops.inbound_kind_rules is 'Extra rules outreach_inbound_kind() applies after the built-in ones (PRD §3.1). Edited by platform operators in SQL; the built-in rules never go here.';

-- ----------------------------------------------------------------------------- 3. classification
-- Which origin a lead gets from the `source` every creation path already passes to outreach_upsert_lead.
create or replace function outreach__origin_of(p_source text) returns text
language sql immutable set search_path = public, extensions as $$
  select case
    when p_source in ('inbound','inbound_email') then 'inbound'
    when p_source = 'search_url' then 'search'
    when p_source in ('api','mcp','connector') or p_source like 'crm%' or p_source in ('hubspot','pipedrive','salesforce') then 'api'
    when p_source in ('manual','inbox','webchat','widget') then 'manual'
    else 'import' end
$$;
revoke execute on function outreach__origin_of(text) from public, anon, authenticated;

-- Headers arrive as [{name, value}] (the connector) or as an object; both become one lower-cased object.
create or replace function outreach__headers_obj(p jsonb) returns jsonb
language sql immutable set search_path = public, extensions as $$
  select case
    when p is null then '{}'::jsonb
    when jsonb_typeof(p) = 'array' then coalesce((select jsonb_object_agg(lower(coalesce(e->>'name', e->>'key', '')), coalesce(e->>'value', '')) from jsonb_array_elements(p) e where coalesce(e->>'name', e->>'key', '') <> ''), '{}'::jsonb)
    when jsonb_typeof(p) = 'object' then coalesce((select jsonb_object_agg(lower(k), v) from jsonb_each_text(p) t(k, v)), '{}'::jsonb)
    else '{}'::jsonb end
$$;
revoke execute on function outreach__headers_obj(jsonb) from public, anon, authenticated;

/*
 * PRD §3.1. person | company_page | automated for the other side of a new chat, before any lead is created.
 *   p_provider   the sender's provider (mail providers = email rules)
 *   p_name       the attendee's display name
 *   p_provider_id LinkedIn internal id / Instagram user id / WhatsApp id; the address for email
 *   p_identifier the email address, Instagram handle, phone or LinkedIn slug
 *   p_chat_meta  LinkedIn chat meta as inbound.ts stores it: {content_type: sponsored | inmail | linkedin_offer, inbox, is_organization, system}
 *   p_headers    email headers ([{name,value}] or object)
 * Built-in rules first, then active rows of ops.inbound_kind_rules. "LinkedIn Member" (hidden name) is a person.
 */
create or replace function outreach_inbound_kind(p_provider outreach_provider_t, p_name text, p_provider_id text, p_identifier text, p_chat_meta jsonb default null, p_headers jsonb default null)
returns text language plpgsql stable security definer set search_path = public, extensions as $$
declare ch text := case when p_provider in ('GMAIL','OUTLOOK','IMAP') then 'EMAIL' else p_provider::text end;
        addr text; local_part text; dom text; h jsonb; r record; ctype text;
begin
  if ch = 'EMAIL' then
    addr := lower(trim(coalesce(p_identifier, p_provider_id, '')));
    local_part := split_part(addr, '@', 1); dom := split_part(addr, '@', 2);
    if local_part ~ '(^|[._+-])(no-?reply|do-?not-?reply|notifications?|newsletters?|digest|mailer-daemon|postmaster|bounces?|updates)([._+-]|$)' then return 'automated'; end if;
    h := outreach__headers_obj(p_headers);
    if h ? 'list-unsubscribe' or h ? 'list-id' then return 'automated'; end if;
    if lower(coalesce(h->>'precedence', '')) in ('bulk','list','junk') then return 'automated'; end if;
    if h ? 'auto-submitted' and lower(coalesce(h->>'auto-submitted', 'no')) <> 'no' then return 'automated'; end if;
    for r in select * from ops.inbound_kind_rules k where k.active and k.channel = 'EMAIL' order by k.id loop
      if r.match_type = 'email_local_part_regex' and local_part ~* r.pattern then return r.kind; end if;
      if r.match_type = 'email_domain' and (dom = lower(r.pattern) or dom like '%.' || lower(r.pattern)) then return r.kind; end if;
      if r.match_type = 'header' and h ? lower(r.pattern) then return r.kind; end if;
      if r.match_type = 'display_name' and coalesce(p_name, '') ~* r.pattern then return r.kind; end if;
    end loop;
    return 'person';
  end if;
  if ch = 'LINKEDIN' then
    ctype := lower(coalesce(p_chat_meta->>'content_type', ''));
    -- a person's id is "ACoAA…"; an organisation (company page) messages with a plain numeric id
    if coalesce(p_provider_id, '') ~ '^[0-9]{3,}$' then return 'company_page'; end if;
    if coalesce((p_chat_meta->>'is_organization')::boolean, false) then return 'company_page'; end if;
    -- a sponsored message is an ad: from a page it is the page, from a person (a recruiter's sponsored InMail) it is automated
    if ctype = 'sponsored' then return 'automated'; end if;
    if ctype = 'linkedin_offer' then return 'automated'; end if;                   -- LinkedIn's own offers / job-offer system messages
    if coalesce((p_chat_meta->>'system')::boolean, false) then return 'automated'; end if;
  elsif coalesce((p_chat_meta->>'system')::boolean, false) then
    return 'automated';
  end if;
  for r in select * from ops.inbound_kind_rules k where k.active and k.channel = ch order by k.id loop
    if r.match_type = 'display_name' and coalesce(p_name, '') ~* r.pattern then return r.kind; end if;
    if r.match_type = 'provider_id' and coalesce(p_provider_id, '') = r.pattern then return r.kind; end if;
  end loop;
  return 'person';
end $$;
revoke execute on function outreach_inbound_kind(outreach_provider_t, text, text, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function outreach_inbound_kind(outreach_provider_t, text, text, text, jsonb, jsonb) to service_role;

-- The known offenders seen live on 26 Oct 2026 that the built-in rules alone would not catch (hello@ / team@ senders).
insert into ops.inbound_kind_rules(channel, match_type, pattern, kind, note)
select v.channel, v.match_type, v.pattern, v.kind, v.note
  from (values
    ('EMAIL', 'email_domain', 'email.epidemicsound.com', 'automated', 'marketing subdomain'),
    ('EMAIL', 'email_domain', 'hellorep.ai', 'automated', 'vendor drip from team@'),
    ('EMAIL', 'email_domain', 'flair.ai', 'automated', 'vendor drip'),
    ('EMAIL', 'email_local_part_regex', '^(hello|team|news|marketing|info)@?$', 'automated', 'role addresses that only ever send campaigns; a person writing from hello@ is unhidden by hand')
  ) v(channel, match_type, pattern, kind, note)
 where not exists (select 1 from ops.inbound_kind_rules k where k.channel = v.channel and k.match_type = v.match_type and k.pattern = v.pattern);

-- ----------------------------------------------------------------------------- 4. the summary queue
create or replace function outreach_lead_summary_enqueue(p_lead uuid) returns void
language sql security definer set search_path = public, extensions as $$
  insert into outreach_lead_summary_queue(lead_id) select p_lead where p_lead is not null on conflict (lead_id) do nothing;
$$;
revoke execute on function outreach_lead_summary_enqueue(uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 5. triggers: origin / prospect flag
create or replace function outreach_trg_lead_origin() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if tg_op = 'INSERT' then
    -- origin follows the creation path's `source` unless the caller set it explicitly (anything but the default)
    if new.origin = 'import' and new.source is not null then new.origin := outreach__origin_of(new.source); end if;
    if new.prospect_since is null and new.origin <> 'inbound' then new.prospect_since := coalesce(new.created_at, now()); end if;
    -- an inbound contact that is created straight onto a list or a stage is a prospect from the start
    if new.prospect_since is null and (new.list_id is not null or new.stage_id is not null) then new.prospect_since := coalesce(new.created_at, now()); end if;
    return new;
  end if;
  -- added to a list or given a stage (PRD §3.3): the lead becomes a prospect. Tags, notes and replies never do.
  if new.prospect_since is null and ((new.list_id is not null and new.list_id is distinct from old.list_id) or (new.stage_id is not null and new.stage_id is distinct from old.stage_id)) then
    new.prospect_since := now();
  end if;
  if new.hidden_at is null then new.hidden_reason := null; end if;
  return new;
end $$;
drop trigger if exists outreach_lead_origin on outreach_leads;
create trigger outreach_lead_origin before insert or update of list_id, stage_id, hidden_at on outreach_leads for each row execute function outreach_trg_lead_origin();

create or replace function outreach_trg_enrollment_prospect() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_leads set prospect_since = coalesce(prospect_since, new.created_at, now()) where id = new.lead_id and prospect_since is null;
  perform outreach_lead_summary_enqueue(new.lead_id);
  return null;
end $$;
drop trigger if exists outreach_enrollment_prospect on outreach_enrollments;
create trigger outreach_enrollment_prospect after insert on outreach_enrollments for each row execute function outreach_trg_enrollment_prospect();

-- ----------------------------------------------------------------------------- 6. triggers: relation source + summary enqueue
-- Every path that writes relation = 'first' ends here: the source and connected_at are derived once, in one place.
create or replace function outreach_trg_lss_relation_source() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare became_first boolean := new.relation = 'first' and (tg_op = 'INSERT' or old.relation is distinct from 'first');
begin
  if tg_op = 'INSERT' or new.relation is distinct from old.relation then new.relation_checked_at := coalesce(new.relation_checked_at, now()); end if;
  if became_first then
    new.connected_at := coalesce(new.connected_at, new.invite_accepted_at, new.invite_detected_at, now());
    -- an explicit source from the caller wins (the Instagram poll knows whose follow came first)
    if new.relation_source is null or (tg_op = 'UPDATE' and new.relation_source is not distinct from old.relation_source) then
      new.relation_source := case
        when new.invite_sent_at is not null and new.invite_sent_at <= new.connected_at + interval '1 minute' then 'our_invite'
        when tg_op = 'UPDATE' and old.relation = 'pending_in' then 'their_invite'
        else 'pre_existing' end;
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outreach_lss_a0_relation_source on outreach_lead_sender_state;
create trigger outreach_lss_a0_relation_source before insert or update of relation, invite_accepted_at, relation_source on outreach_lead_sender_state
  for each row execute function outreach_trg_lss_relation_source();

create or replace function outreach_trg_lss_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_lead_summary_enqueue(new.lead_id);
  return null;
end $$;
drop trigger if exists outreach_lss_zz_summary on outreach_lead_sender_state;
create trigger outreach_lss_zz_summary after insert or update of relation, invite_sent_at, invite_accepted_at, invite_withdrawn_at, replied, email_bounced, last_outbound_at, last_inbound_at, relation_source, we_follow, follows_us
  on outreach_lead_sender_state for each row execute function outreach_trg_lss_summary();

create or replace function outreach_trg_msg_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare lid uuid;
begin
  select lead_id into lid from outreach_chats where id = new.chat_id;
  perform outreach_lead_summary_enqueue(lid);
  return null;
end $$;
drop trigger if exists outreach_messages_zz_summary on outreach_messages;
create trigger outreach_messages_zz_summary after insert or update of intent, is_auto_reply, is_bounce, deleted_at on outreach_messages
  for each row execute function outreach_trg_msg_summary();

create or replace function outreach_trg_action_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status = 'sent' and new.lead_id is not null then perform outreach_lead_summary_enqueue(new.lead_id); end if;
  return null;
end $$;
drop trigger if exists outreach_actions_zz_summary on outreach_actions;
create trigger outreach_actions_zz_summary after update of status on outreach_actions for each row execute function outreach_trg_action_summary();

create or replace function outreach_trg_lead_summary_touch() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_lead_summary_enqueue(new.id);
  return null;
end $$;
drop trigger if exists outreach_lead_zz_summary on outreach_leads;
create trigger outreach_lead_zz_summary after insert or update of stage_id, do_not_contact, unsubscribed, hidden_at, prospect_since, kind, email_work, email_personal, public_identifier, provider_id, phone
  on outreach_leads for each row execute function outreach_trg_lead_summary_touch();

create or replace function outreach_trg_lead_child_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_lead_summary_enqueue(coalesce(new.lead_id, old.lead_id));
  return null;
end $$;
drop trigger if exists outreach_lead_identities_zz_summary on outreach_lead_identities;
create trigger outreach_lead_identities_zz_summary after insert or update of is_valid, identifier or delete on outreach_lead_identities for each row execute function outreach_trg_lead_child_summary();
drop trigger if exists outreach_lead_consent_zz_summary on outreach_lead_consent;
create trigger outreach_lead_consent_zz_summary after insert or update of revoked_at or delete on outreach_lead_consent for each row execute function outreach_trg_lead_child_summary();
drop trigger if exists outreach_lead_milestones_zz_summary on outreach_lead_milestones;
create trigger outreach_lead_milestones_zz_summary after insert or delete on outreach_lead_milestones for each row execute function outreach_trg_lead_child_summary();

create or replace function outreach_trg_chat_lead_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_lead_summary_enqueue(new.lead_id);
  if tg_op = 'UPDATE' and old.lead_id is distinct from new.lead_id then perform outreach_lead_summary_enqueue(old.lead_id); end if;
  return null;
end $$;
drop trigger if exists outreach_chats_zz_summary on outreach_chats;
create trigger outreach_chats_zz_summary after insert or update of lead_id, counterpart_kind on outreach_chats for each row execute function outreach_trg_chat_lead_summary();

-- a blacklist row changes Status to "Do not contact" for every lead it matches
create or replace function outreach_trg_suppression_summary() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_suppressions%rowtype;
begin
  if tg_op = 'DELETE' then r := old; else r := new; end if;
  if r.kind = 'public_identifier' then
    insert into outreach_lead_summary_queue(lead_id) select id from outreach_leads where workspace_id = r.workspace_id and public_identifier = r.value on conflict do nothing;
  elsif r.kind = 'email' then
    insert into outreach_lead_summary_queue(lead_id) select id from outreach_leads where workspace_id = r.workspace_id and (email_work = r.value or email_personal = r.value) on conflict do nothing;
  elsif r.kind = 'domain' then
    insert into outreach_lead_summary_queue(lead_id) select id from outreach_leads where workspace_id = r.workspace_id
       and (email_work::text ilike '%@' || r.value::text or email_personal::text ilike '%@' || r.value::text or lower(company_domain) = lower(r.value::text)) on conflict do nothing;
  else
    insert into outreach_lead_summary_queue(lead_id) select id from outreach_leads where workspace_id = r.workspace_id and lower(company) = lower(r.value::text) on conflict do nothing;
  end if;
  return null;
end $$;
drop trigger if exists outreach_suppressions_zz_summary on outreach_suppressions;
create trigger outreach_suppressions_zz_summary after insert or delete on outreach_suppressions for each row execute function outreach_trg_suppression_summary();

-- ----------------------------------------------------------------------------- 7. the summary itself
/*
 * PRD §4. Recomputes one lead's row from sent actions, our own messages, their human messages, relation state,
 * identities, bounces, stages / milestones and blacklists. Returns true when the stored status changed.
 *
 * Ladder (furthest point ever reached, any channel; the channel shown is the one of the latest event at that step):
 *   0 not_contacted · 1 invited · 2 connected · 3 messaged · 4 replied · 5 interested · 6 meeting
 * Shown instead of the ladder: do_not_contact (suppressed) · bounced (email bounce / WhatsApp number invalid and
 * nothing else reached) · wrote_to_us (they wrote, we never touched them).
 */
create or replace function outreach_lead_summary_refresh(p_lead uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare
  l outreach_leads%rowtype; prev text;
  t record; i record; c record;
  v_bounced text[] := '{}'; v_ident text[] := '{}';
  first_touch timestamptz; ladder int := 0; st text; st_ch text; st_at timestamptz;
  meeting_at timestamptz; suppressed boolean; last_act timestamptz;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then delete from outreach_lead_summary where lead_id = p_lead; return false; end if;
  select status into prev from outreach_lead_summary where lead_id = p_lead;

  -- bounced channels: an email that came back, a WhatsApp number the check rejected
  if exists (select 1 from outreach_lead_sender_state x where x.lead_id = p_lead and x.email_bounced) then v_bounced := array_append(v_bounced, 'email'); end if;
  if exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider = 'WHATSAPP' and li.is_valid = false) then v_bounced := array_append(v_bounced, 'whatsapp'); end if;

  -- touches of ours: sent actions, our own messages (teammate / AI / typed outside the app), invitations on record
  with s as (select id, outreach__channel_of(provider) as ch from outreach_senders where workspace_id = l.workspace_id),
  tk as (
    select a.sender_id, s.ch, a.executed_at as at_,
           case when a.action_type in ('invite','follow') then 'invite'
                when a.action_type in ('message','new_chat','inmail','email','reply','ai_reply') then 'message' end as kind
      from outreach_actions a join s on s.id = a.sender_id
     where a.lead_id = p_lead and a.status = 'sent' and a.executed_at is not null
       and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
    union all
    select ch.sender_id, outreach__channel_of(ch.provider), m.sent_at, 'message'
      from outreach_messages m join outreach_chats ch on ch.id = m.chat_id
     where ch.lead_id = p_lead and ch.provider <> 'WEBCHAT' and m.deleted_at is null and not m.is_invite_note
       and outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) = 'ours'
    union all
    select x.sender_id, s.ch, x.invite_sent_at, 'invite'
      from outreach_lead_sender_state x join s on s.id = x.sender_id
     where x.lead_id = p_lead and x.invite_sent_at is not null and s.ch in ('linkedin','instagram'))
  select min(at_) as first_at, max(at_) as last_at,
         coalesce(array_agg(distinct sender_id), '{}') as senders, coalesce(array_agg(distinct ch), '{}') as used,
         min(at_) filter (where kind = 'invite') as invited_first, max(at_) filter (where kind = 'invite') as invited_last,
         (array_agg(ch order by at_ desc) filter (where kind = 'invite'))[1] as invited_ch,
         min(at_) filter (where kind = 'message' and not (ch = any(v_bounced))) as messaged_first,
         max(at_) filter (where kind = 'message' and not (ch = any(v_bounced))) as messaged_last,
         (array_agg(ch order by at_ desc) filter (where kind = 'message' and not (ch = any(v_bounced))))[1] as messaged_ch
    into t from tk where kind is not null;
  first_touch := t.first_at;

  -- what they wrote themselves (auto-replies, bounces, system events and website chat never count)
  with inb as (
    select ch.sender_id, outreach__channel_of(ch.provider) as ch, m.sent_at, m.intent
      from outreach_messages m join outreach_chats ch on ch.id = m.chat_id
     where ch.lead_id = p_lead and ch.provider <> 'WEBCHAT' and m.direction = 'in' and m.deleted_at is null
       and outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) = 'person')
  select min(sent_at) as any_first, max(sent_at) as any_last,
         min(sent_at) filter (where first_touch is not null and sent_at > first_touch) as replied_first,
         max(sent_at) filter (where first_touch is not null and sent_at > first_touch) as replied_last,
         (array_agg(ch order by sent_at desc) filter (where first_touch is not null and sent_at > first_touch))[1] as replied_ch,
         coalesce(array_agg(distinct sender_id) filter (where first_touch is not null and sent_at > first_touch), '{}') as replied_senders,
         coalesce(array_agg(distinct ch) filter (where first_touch is not null and sent_at > first_touch), '{}') as replied_chs,
         max(sent_at) filter (where first_touch is not null and sent_at > first_touch and intent in ('interested','question')) as interested_last,
         (array_agg(ch order by sent_at desc) filter (where first_touch is not null and sent_at > first_touch and intent in ('interested','question')))[1] as interested_ch,
         min(sent_at) filter (where first_touch is null or sent_at < first_touch) as wrote_first
    into i from inb;

  -- connections per account (LinkedIn 1st degree, Instagram follow-back); pending = our invite / follow not answered
  with s as (select id, outreach__channel_of(provider) as ch from outreach_senders where workspace_id = l.workspace_id)
  select coalesce(array_agg(x.sender_id) filter (where x.relation = 'first' and s.ch in ('linkedin','instagram')), '{}') as conn,
         coalesce(array_agg(x.sender_id) filter (where x.relation = 'first' and s.ch in ('linkedin','instagram') and x.relation_source = 'our_invite'), '{}') as conn_ours,
         coalesce(array_agg(x.sender_id) filter (where x.relation = 'pending_out' and s.ch in ('linkedin','instagram')), '{}') as pend,
         coalesce(array_agg(distinct x.relation_source) filter (where x.relation = 'first' and s.ch in ('linkedin','instagram') and x.relation_source is not null), '{}') as sources,
         max(coalesce(x.connected_at, x.invite_accepted_at, x.updated_at)) filter (where s.ch in ('linkedin','instagram') and (x.connected_at is not null or x.relation = 'first')) as connected_last,
         min(coalesce(x.connected_at, x.invite_accepted_at, x.updated_at)) filter (where s.ch in ('linkedin','instagram') and (x.connected_at is not null or x.relation = 'first')) as connected_first,
         (array_agg(s.ch order by coalesce(x.connected_at, x.invite_accepted_at, x.updated_at) desc) filter (where s.ch in ('linkedin','instagram') and (x.connected_at is not null or x.relation = 'first')))[1] as connected_ch,
         max(x.updated_at) as lss_last
    into c from outreach_lead_sender_state x join s on s.id = x.sender_id where x.lead_id = p_lead;

  -- reachable channels
  if l.public_identifier is not null or l.provider_id is not null or exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider = 'LINKEDIN') then v_ident := array_append(v_ident, 'linkedin'); end if;
  if l.email_work is not null or l.email_personal is not null or exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider in ('GMAIL','OUTLOOK','IMAP')) then v_ident := array_append(v_ident, 'email'); end if;
  if exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider = 'INSTAGRAM') then v_ident := array_append(v_ident, 'instagram'); end if;
  if exists (select 1 from outreach_lead_identities li where li.lead_id = p_lead and li.provider = 'WHATSAPP') then v_ident := array_append(v_ident, 'whatsapp'); end if;

  -- meeting: a milestone, or the current stage is a meeting stage
  select min(at) into meeting_at from outreach_lead_milestones where lead_id = p_lead and kind = 'meeting';
  if meeting_at is null and l.stage_id is not null and exists (select 1 from outreach_stages g where g.id = l.stage_id and (g.is_meeting or g.kind = 'meeting')) then meeting_at := l.updated_at; end if;

  suppressed := l.do_not_contact or l.unsubscribed or outreach_lead_suppression_reason(l, l.client_id, null) is not null;

  -- the ladder
  if t.invited_first is not null or cardinality(c.pend) > 0 then ladder := 1; st_ch := coalesce(t.invited_ch, 'linkedin'); st_at := t.invited_last; end if;
  if c.connected_first is not null then ladder := 2; st_ch := c.connected_ch; st_at := c.connected_last; end if;
  if t.messaged_first is not null then ladder := 3; st_ch := t.messaged_ch; st_at := t.messaged_last; end if;
  if i.replied_first is not null then ladder := 4; st_ch := i.replied_ch; st_at := i.replied_last; end if;
  if i.interested_last is not null then ladder := 5; st_ch := i.interested_ch; st_at := i.interested_last; end if;
  if meeting_at is not null then ladder := 6; st_ch := coalesce(i.replied_ch, st_ch); st_at := meeting_at; end if;

  st := case
    when suppressed then 'do_not_contact'
    when ladder = 0 and cardinality(v_bounced) > 0 then 'bounced'
    when i.any_first is not null and first_touch is null then 'wrote_to_us'   -- they wrote, we never touched them (a pre-existing connection is not a touch)
    else (array['not_contacted','invited','connected','messaged','replied','interested','meeting'])[ladder + 1] end;
  if st = 'wrote_to_us' then st_at := i.any_last; end if;
  if st = 'bounced' then st_ch := v_bounced[1]; st_at := t.last_at; end if;
  last_act := greatest(t.last_at, i.any_last, c.lss_last, meeting_at, l.created_at);

  insert into outreach_lead_summary as ls (lead_id, workspace_id, status, status_rank, status_channel, status_at,
      connected_sender_ids, connected_via_our_invite_ids, pending_sender_ids, connected_count, pending_count, connection_sources,
      identity_channels, used_channels, replied_channels, bounced_channels, contacted_sender_ids, replied_sender_ids,
      first_contacted_at, connected_ever_at, replied_at, last_activity_at, wrote_first_at, updated_at)
  values (p_lead, l.workspace_id, st, ladder, st_ch, st_at,
      c.conn, c.conn_ours, c.pend, cardinality(c.conn), cardinality(c.pend), c.sources,
      v_ident, t.used, i.replied_chs, v_bounced, t.senders, i.replied_senders,
      first_touch, c.connected_first, i.replied_first, last_act, i.wrote_first, now())
  on conflict (lead_id) do update set
      workspace_id = excluded.workspace_id, status = excluded.status, status_rank = excluded.status_rank, status_channel = excluded.status_channel, status_at = excluded.status_at,
      connected_sender_ids = excluded.connected_sender_ids, connected_via_our_invite_ids = excluded.connected_via_our_invite_ids, pending_sender_ids = excluded.pending_sender_ids,
      connected_count = excluded.connected_count, pending_count = excluded.pending_count, connection_sources = excluded.connection_sources,
      identity_channels = excluded.identity_channels, used_channels = excluded.used_channels, replied_channels = excluded.replied_channels, bounced_channels = excluded.bounced_channels,
      contacted_sender_ids = excluded.contacted_sender_ids, replied_sender_ids = excluded.replied_sender_ids,
      first_contacted_at = excluded.first_contacted_at, connected_ever_at = excluded.connected_ever_at, replied_at = excluded.replied_at,
      last_activity_at = excluded.last_activity_at, wrote_first_at = excluded.wrote_first_at, updated_at = now();
  return prev is distinct from st;
end $$;
revoke execute on function outreach_lead_summary_refresh(uuid) from public, anon, authenticated;
grant execute on function outreach_lead_summary_refresh(uuid) to service_role;

-- F55 tick: take a batch off the queue and recompute. A lead whose refresh raises goes back with attempts + 1 (3 tries).
create or replace function outreach_lead_summary_process(p_limit int default 200) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ids record; n int := 0; changed int := 0; failed int := 0; rows_ uuid[];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  with picked as (select lead_id from outreach_lead_summary_queue order by queued_at limit greatest(1, least(coalesce(p_limit, 200), 1000)) for update skip locked),
       gone as (delete from outreach_lead_summary_queue q using picked p where q.lead_id = p.lead_id returning q.lead_id, q.attempts)
  select array_agg(gone.lead_id) into rows_ from gone;
  if rows_ is null then return jsonb_build_object('processed', 0, 'changed', 0, 'failed', 0); end if;
  for ids in select unnest(rows_) as id loop
    begin
      if outreach_lead_summary_refresh(ids.id) then changed := changed + 1; end if;
      n := n + 1;
    exception when others then
      failed := failed + 1;
      insert into outreach_lead_summary_queue(lead_id, queued_at, attempts, last_error) values (ids.id, now() + interval '10 minutes', 1, left(sqlerrm, 300))
        on conflict (lead_id) do update set attempts = outreach_lead_summary_queue.attempts + 1, last_error = excluded.last_error, queued_at = now() + interval '10 minutes';
      delete from outreach_lead_summary_queue where lead_id = ids.id and attempts >= 3;
    end;
  end loop;
  return jsonb_build_object('processed', n, 'changed', changed, 'failed', failed, 'remaining', (select count(*) from outreach_lead_summary_queue));
end $$;
revoke execute on function outreach_lead_summary_process(int) from public, anon, authenticated;
grant execute on function outreach_lead_summary_process(int) to service_role;

-- Nightly: every lead with activity in the last p_days (and every lead with no row yet) is queued; drift = rows whose status changed.
create or replace function outreach_lead_summary_reconcile(p_days int default 7, p_limit int default 5000) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare since timestamptz := now() - make_interval(days => greatest(1, coalesce(p_days, 7))); queued int; r jsonb; total jsonb := '{"processed":0,"changed":0,"failed":0}'::jsonb; loops int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  with cand as (
    select l.id from outreach_leads l left join outreach_lead_summary s on s.lead_id = l.id
     where s.lead_id is null
        or exists (select 1 from outreach_actions a where a.lead_id = l.id and a.executed_at >= since)
        or exists (select 1 from outreach_chats ch join outreach_messages m on m.chat_id = ch.id where ch.lead_id = l.id and m.sent_at >= since)
        or exists (select 1 from outreach_lead_sender_state x where x.lead_id = l.id and x.updated_at >= since)
        or l.updated_at >= since
     limit greatest(100, coalesce(p_limit, 5000))),
  ins as (insert into outreach_lead_summary_queue(lead_id) select id from cand on conflict do nothing returning lead_id)
  select count(*) into queued from ins;
  loop
    r := outreach_lead_summary_process(500);
    total := jsonb_build_object('processed', (total->>'processed')::int + (r->>'processed')::int, 'changed', (total->>'changed')::int + (r->>'changed')::int, 'failed', (total->>'failed')::int + (r->>'failed')::int);
    loops := loops + 1;
    exit when (r->>'processed')::int = 0 or loops >= 40;
  end loop;
  return total || jsonb_build_object('queued', queued, 'since', since);
end $$;
revoke execute on function outreach_lead_summary_reconcile(int, int) from public, anon, authenticated;
grant execute on function outreach_lead_summary_reconcile(int, int) to service_role;

-- ----------------------------------------------------------------------------- 8. reads
-- Accounts that no longer count unless "Include removed accounts" is on (sender-lifecycle: removed / erased; billing: disconnected; merged tombstones).
create or replace function outreach__removed_sender_ids(p_ws uuid) returns uuid[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(id), '{}') from outreach_senders where workspace_id = p_ws and (deleted_at is not null or status::text in ('removed','erased','disconnected'))
$$;
revoke execute on function outreach__removed_sender_ids(uuid) from public, anon, authenticated;

/*
 * The one filter vocabulary of the leads page, the connector and the API (keys of p_f, all optional):
 *   tab: prospects (default) | inbox | all · hidden: true = hidden leads only (any tab; default = not hidden)
 *   search, client_id, list_id, stage_id, tag_id, dnc (bool), origin (text[]), kind (text[])
 *   status (text[] of summary statuses) · connected_via (uuid[]) · pending_with (uuid[]) · not_connected (bool)
 *   connection_source (our_invite | their_invite | pre_existing | unknown: connected to any account with that source)
 *   channel (reachable on: LINKEDIN | INSTAGRAM | WHATSAPP | EMAIL) · channel_used · channel_replied (same values)
 *   enriched (bool) · replied (bool) · posted_30d (bool) · min_followers (int) · time_in_role (lt6 | 6to12 | 1to3 | gt3)
 *   past_company, skill, language (text) · include_removed (bool: removed accounts count in connected / pending)
 *   connector extras: company, title, location (ilike) · has_email (bool) · enrolled_in / not_enrolled_in (sequence id) · created_after (ISO)
 */
create or replace function outreach__leads_matching(p_ws uuid, p_f jsonb) returns setof uuid
language sql stable security definer set search_path = public, extensions as $$
  with f as (select coalesce(p_f, '{}'::jsonb) as j),
  p as (
    select j->>'tab' as tab, coalesce((j->>'hidden')::boolean, false) as hidden, nullif(trim(coalesce(j->>'search', '')), '') as search,
           nullif(j->>'client_id', '')::uuid as client_id, nullif(j->>'list_id', '')::uuid as list_id, nullif(j->>'stage_id', '')::uuid as stage_id, nullif(j->>'tag_id', '')::uuid as tag_id,
           (j->>'dnc')::boolean as dnc, (j->>'enriched')::boolean as enriched, (j->>'replied')::boolean as replied, coalesce((j->>'not_connected')::boolean, false) as not_connected,
           case when jsonb_typeof(j->'origin') = 'array' then array(select jsonb_array_elements_text(j->'origin')) when nullif(j->>'origin', '') is not null then array[j->>'origin'] end as origin,
           case when jsonb_typeof(j->'kind') = 'array' then array(select jsonb_array_elements_text(j->'kind')) when nullif(j->>'kind', '') is not null then array[j->>'kind'] end as kind,
           case when jsonb_typeof(j->'status') = 'array' then array(select jsonb_array_elements_text(j->'status')) when nullif(j->>'status', '') is not null then array[j->>'status'] end as status,
           case when jsonb_typeof(j->'connected_via') = 'array' then array(select (jsonb_array_elements_text(j->'connected_via'))::uuid) when nullif(j->>'connected_via', '') is not null then array[(j->>'connected_via')::uuid] end as connected_via,
           case when jsonb_typeof(j->'pending_with') = 'array' then array(select (jsonb_array_elements_text(j->'pending_with'))::uuid) when nullif(j->>'pending_with', '') is not null then array[(j->>'pending_with')::uuid] end as pending_with,
           nullif(j->>'connection_source', '') as connection_source,
           lower(nullif(case when upper(j->>'channel') in ('GMAIL','OUTLOOK','IMAP') then 'EMAIL' else j->>'channel' end, '')) as ch_reach,
           lower(nullif(case when upper(j->>'channel_used') in ('GMAIL','OUTLOOK','IMAP') then 'EMAIL' else j->>'channel_used' end, '')) as ch_used,
           lower(nullif(case when upper(j->>'channel_replied') in ('GMAIL','OUTLOOK','IMAP') then 'EMAIL' else j->>'channel_replied' end, '')) as ch_replied,
           coalesce((j->>'posted_30d')::boolean, false) as posted_30d, (j->>'min_followers')::int as min_followers, nullif(j->>'time_in_role', '') as time_in_role,
           nullif(trim(coalesce(j->>'past_company', '')), '') as past_company, nullif(trim(coalesce(j->>'skill', '')), '') as skill, nullif(trim(coalesce(j->>'language', '')), '') as language,
           coalesce((j->>'include_removed')::boolean, false) as include_removed,
           nullif(trim(coalesce(j->>'company', '')), '') as company, nullif(trim(coalesce(j->>'title', '')), '') as title, nullif(trim(coalesce(j->>'location', '')), '') as location,
           (j->>'has_email')::boolean as has_email, nullif(j->>'enrolled_in', '')::uuid as enrolled_in, nullif(j->>'not_enrolled_in', '')::uuid as not_enrolled_in,
           nullif(j->>'created_after', '')::timestamptz as created_after
      from f),
  rm as (select case when (select include_removed from p) then '{}'::uuid[] else outreach__removed_sender_ids(p_ws) end as ids)
  select l.id
    from outreach_leads l
    left join outreach_lead_summary s on s.lead_id = l.id
    left join outreach_lead_profiles pr on pr.lead_id = l.id
    cross join p cross join rm
   where l.workspace_id = p_ws and outreach_client_visible(p_ws, l.client_id)
     and ((l.hidden_at is not null) = p.hidden)
     and (p.hidden or coalesce(p.tab, 'prospects') = 'all'
          or (coalesce(p.tab, 'prospects') = 'prospects' and l.prospect_since is not null)
          or (p.tab = 'inbox' and l.origin = 'inbound' and l.prospect_since is null))
     and (p.search is null or l.full_name ilike '%' || p.search || '%' or l.company ilike '%' || p.search || '%' or l.headline ilike '%' || p.search || '%'
          or l.public_identifier::text ilike '%' || p.search || '%' or l.email_work::text ilike '%' || p.search || '%')
     and (p.client_id is null or l.client_id = p.client_id) and (p.list_id is null or l.list_id = p.list_id) and (p.stage_id is null or l.stage_id = p.stage_id)
     and (p.tag_id is null or exists (select 1 from outreach_lead_tags lt where lt.lead_id = l.id and lt.tag_id = p.tag_id))
     and (p.dnc is null or l.do_not_contact = p.dnc)
     and (p.origin is null or l.origin = any(p.origin)) and (p.kind is null or l.kind = any(p.kind))
     and (p.status is null or coalesce(s.status, 'not_contacted') = any(p.status))
     and (p.connected_via is null or (coalesce(s.connected_sender_ids, '{}') && p.connected_via and not (array(select unnest(coalesce(s.connected_sender_ids, '{}')) intersect select unnest(p.connected_via)) <@ rm.ids)))
     and (p.pending_with is null or (coalesce(s.pending_sender_ids, '{}') && p.pending_with and not (array(select unnest(coalesce(s.pending_sender_ids, '{}')) intersect select unnest(p.pending_with)) <@ rm.ids)))
     and (not p.not_connected or coalesce(array_length(array(select unnest(coalesce(s.connected_sender_ids, '{}')) except select unnest(rm.ids)), 1), 0) = 0)
     and (p.connection_source is null or p.connection_source = any(coalesce(s.connection_sources, '{}')))
     and (p.ch_reach is null or (case when p.ch_reach = 'linkedin' then (l.public_identifier is not null or l.provider_id is not null) else false end) or p.ch_reach = any(coalesce(s.identity_channels, '{}')))
     and (p.ch_used is null or p.ch_used = any(coalesce(s.used_channels, '{}')))
     and (p.ch_replied is null or p.ch_replied = any(coalesce(s.replied_channels, '{}')))
     and (p.enriched is null or (l.enriched_at is not null) = p.enriched)
     and (p.replied is null or (coalesce(s.replied_at, l.last_replied_at) is not null) = p.replied)
     and (not p.posted_30d or pr.last_posted_at >= now() - interval '30 days')
     and (p.min_followers is null or pr.follower_count >= p.min_followers)
     and (p.time_in_role is null or case p.time_in_role
            when 'lt6' then pr.current_started_on > (current_date - interval '6 months')::date
            when '6to12' then pr.current_started_on <= (current_date - interval '6 months')::date and pr.current_started_on > (current_date - interval '12 months')::date
            when '1to3' then pr.current_started_on <= (current_date - interval '12 months')::date and pr.current_started_on > (current_date - interval '36 months')::date
            when 'gt3' then pr.current_started_on <= (current_date - interval '36 months')::date else true end)
     and (p.past_company is null or pr.companies_text ilike '%' || lower(p.past_company) || '%')
     and (p.skill is null or pr.skills_text ilike '%' || lower(p.skill) || '%')
     and (p.language is null or pr.profile_language ilike p.language || '%')
     and (p.company is null or l.company ilike '%' || p.company || '%')
     and (p.title is null or l.title ilike '%' || p.title || '%' or l.headline ilike '%' || p.title || '%')
     and (p.location is null or l.location ilike '%' || p.location || '%')
     and (p.has_email is null or ((l.email_work is not null or l.email_personal is not null) = p.has_email))
     and (p.enrolled_in is null or exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.sequence_id = p.enrolled_in))
     and (p.not_enrolled_in is null or not exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.sequence_id = p.not_enrolled_in))
     and (p.created_after is null or l.created_at >= p.created_after)
$$;
revoke execute on function outreach__leads_matching(uuid, jsonb) from public, anon, authenticated;

-- PRD §5.4. Counted in people: a lead connected to two accounts counts once.
create or replace function outreach_leads_totals(p_ws uuid, p_f jsonb default '{}', p_include_removed boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare rm uuid[]; res jsonb;
begin
  perform outreach_require(p_ws, 'client_viewer');
  rm := case when p_include_removed then '{}'::uuid[] else outreach__removed_sender_ids(p_ws) end;
  with m as (select * from outreach__leads_matching(p_ws, coalesce(p_f, '{}'::jsonb) || jsonb_build_object('include_removed', p_include_removed)) as t(id)),
  x as (
    select l.id, coalesce(s.status_rank, 0) as rank_, coalesce(s.status, 'not_contacted') as status,
           coalesce(array_length(array(select unnest(coalesce(s.connected_sender_ids, '{}')) except select unnest(rm)), 1), 0) > 0 as connected,
           coalesce(array_length(array(select unnest(coalesce(s.connected_via_our_invite_ids, '{}')) except select unnest(rm)), 1), 0) > 0 as connected_ours,
           coalesce(array_length(array(select unnest(coalesce(s.pending_sender_ids, '{}')) except select unnest(rm)), 1), 0) > 0 as pending
      from m join outreach_leads l on l.id = m.id left join outreach_lead_summary s on s.lead_id = l.id)
  select jsonb_build_object(
    'people', count(*), 'contacted', count(*) filter (where rank_ >= 1), 'invited_pending', count(*) filter (where pending),
    'connected', count(*) filter (where connected), 'connected_via_our_invites', count(*) filter (where connected_ours),
    'replied', count(*) filter (where rank_ >= 4), 'interested', count(*) filter (where rank_ >= 5), 'meetings', count(*) filter (where rank_ >= 6),
    'do_not_contact', count(*) filter (where status = 'do_not_contact'), 'bounced', count(*) filter (where status = 'bounced'), 'wrote_to_us', count(*) filter (where status = 'wrote_to_us'),
    'include_removed', p_include_removed) into res from x;
  return res;
end $$;
revoke all on function outreach_leads_totals(uuid, jsonb, boolean) from public, anon;
grant execute on function outreach_leads_totals(uuid, jsonb, boolean) to authenticated, service_role;

-- PRD §5.5. One row per account that touched, is connected to or has an invite pending with a lead in the view.
-- A lead connected to two accounts counts once in each account's row (the panel footer says so).
create or replace function outreach_leads_by_account(p_ws uuid, p_f jsonb default '{}', p_include_removed boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare res jsonb;
begin
  perform outreach_require(p_ws, 'client_viewer');
  with m as (select * from outreach__leads_matching(p_ws, coalesce(p_f, '{}'::jsonb) || jsonb_build_object('include_removed', p_include_removed)) as t(id)),
  s as (select ls.* from m join outreach_lead_summary ls on ls.lead_id = m.id),
  per as (
    select u.sender_id, 'connected' as k, s.lead_id from s cross join lateral unnest(s.connected_sender_ids) u(sender_id)
    union all select u.sender_id, 'ours', s.lead_id from s cross join lateral unnest(s.connected_via_our_invite_ids) u(sender_id)
    union all select u.sender_id, 'pending', s.lead_id from s cross join lateral unnest(s.pending_sender_ids) u(sender_id)
    union all select u.sender_id, 'contacted', s.lead_id from s cross join lateral unnest(s.contacted_sender_ids) u(sender_id)
    union all select u.sender_id, 'replied', s.lead_id from s cross join lateral unnest(s.replied_sender_ids) u(sender_id)),
  agg as (
    select p.sender_id,
           count(distinct p.lead_id) filter (where p.k = 'connected') as connected, count(distinct p.lead_id) filter (where p.k = 'ours') as via_our_invite,
           count(distinct p.lead_id) filter (where p.k = 'pending') as pending, count(distinct p.lead_id) filter (where p.k = 'contacted') as contacted,
           count(distinct p.lead_id) filter (where p.k = 'replied') as replied
      from per p group by p.sender_id)
  select coalesce(jsonb_agg(jsonb_build_object(
           'sender_id', a.sender_id, 'name', coalesce(nullif(sd.display_name, ''), sd.public_identifier, sd.owner_email::text, 'Account'), 'picture_url', sd.picture_url,
           'provider', sd.provider, 'channel', outreach__channel_of(sd.provider),
           'removed', sd.deleted_at is not null or sd.status::text in ('removed','erased','disconnected'),
           'connected', case when outreach__channel_of(sd.provider) in ('linkedin','instagram') then a.connected end,
           'via_our_invite', case when outreach__channel_of(sd.provider) in ('linkedin','instagram') then a.via_our_invite end,
           'pending', case when outreach__channel_of(sd.provider) in ('linkedin','instagram') then a.pending end,
           'contacted', a.contacted, 'replied', a.replied)
           order by (sd.deleted_at is not null or sd.status::text in ('removed','erased','disconnected')), a.contacted desc, a.connected desc, sd.display_name), '[]'::jsonb)
    into res
    from agg a join outreach_senders sd on sd.id = a.sender_id
   where p_include_removed or (sd.deleted_at is null and sd.status::text not in ('removed','erased','disconnected'));
  return jsonb_build_object('rows', res, 'include_removed', p_include_removed, 'note', 'A lead connected to two accounts counts once in each row and once in the totals.');
end $$;
revoke all on function outreach_leads_by_account(uuid, jsonb, boolean) from public, anon;
grant execute on function outreach_leads_by_account(uuid, jsonb, boolean) to authenticated, service_role;

-- PRD §6 / §5.3. One row per account with any relationship to the lead, grouped by channel by the caller.
create or replace function outreach_lead_relationships(p_lead uuid, p_include_removed boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; res jsonb;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(l.workspace_id, 'client_viewer');
  if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_NOT_FOUND'; end if;
  with x as (
    select sd.id as sender_id, sd.provider, outreach__channel_of(sd.provider) as channel,
           coalesce(nullif(sd.display_name, ''), sd.public_identifier, sd.owner_email::text, 'Account') as name, sd.picture_url,
           (sd.deleted_at is not null or sd.status::text in ('removed','erased','disconnected')) as removed,
           st.relation, st.relation_source, st.connected_at, st.relation_checked_at, st.invite_sent_at, st.invite_accepted_at, st.invite_withdrawn_at, st.invite_had_note,
           st.last_outbound_at, st.last_inbound_at, st.replied, st.email_bounced, st.we_follow, st.follows_us,
           (select min(c.created_at) from outreach_chats c where c.lead_id = p_lead and c.sender_id = sd.id) as chat_since,
           (select cs.basis::text from outreach_lead_consent cs where cs.lead_id = p_lead and cs.channel = sd.provider and cs.revoked_at is null order by cs.obtained_at desc limit 1) as consent,
           (select li.is_valid from outreach_lead_identities li where li.lead_id = p_lead and li.provider = sd.provider order by li.created_at limit 1) as identity_valid
      from outreach_lead_sender_state st join outreach_senders sd on sd.id = st.sender_id
     where st.lead_id = p_lead
     union
    select sd.id, sd.provider, outreach__channel_of(sd.provider), coalesce(nullif(sd.display_name, ''), sd.public_identifier, sd.owner_email::text, 'Account'), sd.picture_url,
           (sd.deleted_at is not null or sd.status::text in ('removed','erased','disconnected')),
           null, null, null, null, null, null, null, null, null, null, false, false, null, null,
           min(c.created_at), null, null
      from outreach_chats c join outreach_senders sd on sd.id = c.sender_id
     where c.lead_id = p_lead and c.provider <> 'WEBCHAT' and not exists (select 1 from outreach_lead_sender_state st where st.lead_id = p_lead and st.sender_id = sd.id)
     group by sd.id)
  select coalesce(jsonb_agg(jsonb_build_object(
      'sender_id', x.sender_id, 'name', x.name, 'picture_url', x.picture_url, 'provider', x.provider, 'channel', x.channel, 'removed', x.removed,
      'state', case
        when x.channel in ('linkedin','instagram') then case
          when x.relation = 'first' then 'connected'
          when x.relation = 'pending_out' then 'pending'
          when x.relation = 'pending_in' then 'pending_in'
          when x.relation in ('blocked','invalid') then x.relation::text
          when x.channel = 'instagram' and x.follows_us then 'follows_us'
          when x.connected_at is not null then 'disconnected'
          else 'not_connected' end
        when x.channel = 'whatsapp' then case when x.identity_valid = false then 'number_invalid' when x.chat_since is not null or x.last_outbound_at is not null then 'chat' else 'has_number' end
        else case when x.email_bounced then 'bounced' when x.last_outbound_at is not null then 'emailed' else 'has_address' end end,
      'since', case when x.relation = 'first' then coalesce(x.connected_at, x.invite_accepted_at) when x.relation = 'pending_out' then x.invite_sent_at else x.chat_since end,
      'source', case when x.relation = 'first' then x.relation_source end,
      'invite_sent_at', x.invite_sent_at, 'invite_had_note', x.invite_had_note, 'invite_withdrawn_at', x.invite_withdrawn_at,
      'connected_at', x.connected_at, 'checked_at', x.relation_checked_at, 'last_touch_at', x.last_outbound_at, 'last_reply_at', x.last_inbound_at,
      'replied', x.replied, 'consent', x.consent, 'we_follow', x.we_follow, 'follows_us', x.follows_us, 'chat_since', x.chat_since)
      order by x.removed, array_position(array['linkedin','instagram','whatsapp','email'], x.channel), x.name), '[]'::jsonb)
    into res from x where p_include_removed or not x.removed;
  return res;
end $$;
revoke all on function outreach_lead_relationships(uuid, boolean) from public, anon;
grant execute on function outreach_lead_relationships(uuid, boolean) to authenticated, service_role;

-- Rows for the connector and the public API (the web app reads the same tables through PostgREST). Sort: activity | created | message.
create or replace function outreach_leads_list(p_ws uuid, p_f jsonb default '{}', p_sort text default 'activity', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare lim int := least(greatest(coalesce(p_limit, 50), 1), 200); off int := greatest(coalesce(p_offset, 0), 0); total bigint; res jsonb; rm uuid[];
begin
  perform outreach_require(p_ws, 'client_viewer');
  rm := case when coalesce((p_f->>'include_removed')::boolean, false) then '{}'::uuid[] else outreach__removed_sender_ids(p_ws) end;
  with m as (select * from outreach__leads_matching(p_ws, coalesce(p_f, '{}'::jsonb)) as t(id)),
  rows_ as (
    select l.*, s.status, s.status_rank, s.status_channel, s.status_at, s.identity_channels, s.used_channels, s.replied_channels, s.bounced_channels,
           s.last_activity_at, s.first_contacted_at, s.wrote_first_at,
           array(select unnest(coalesce(s.connected_sender_ids, '{}')) except select unnest(rm)) as conn_ids,
           array(select unnest(coalesce(s.pending_sender_ids, '{}')) except select unnest(rm)) as pend_ids,
           coalesce(s.connected_via_our_invite_ids, '{}') as ours_ids,
           (select max(c.last_message_at) from outreach_chats c where c.lead_id = l.id) as last_message_at
      from m join outreach_leads l on l.id = m.id left join outreach_lead_summary s on s.lead_id = l.id)
  select count(*) into total from rows_;
  with m as (select * from outreach__leads_matching(p_ws, coalesce(p_f, '{}'::jsonb)) as t(id)),
  rows_ as (
    select l.*, s.status, s.status_rank, s.status_channel, s.status_at, s.identity_channels, s.used_channels, s.replied_channels, s.bounced_channels,
           s.last_activity_at, s.first_contacted_at, s.wrote_first_at,
           array(select unnest(coalesce(s.connected_sender_ids, '{}')) except select unnest(rm)) as conn_ids,
           array(select unnest(coalesce(s.pending_sender_ids, '{}')) except select unnest(rm)) as pend_ids,
           coalesce(s.connected_via_our_invite_ids, '{}') as ours_ids,
           (select max(c.last_message_at) from outreach_chats c where c.lead_id = l.id) as last_message_at
      from m join outreach_leads l on l.id = m.id left join outreach_lead_summary s on s.lead_id = l.id),
  page as (
    select * from rows_ r
     order by case when p_sort = 'created' then r.created_at when p_sort = 'message' then r.last_message_at else coalesce(r.last_activity_at, r.created_at) end desc nulls last, r.id desc
     limit lim offset off)
  select coalesce(jsonb_agg(
    (to_jsonb(pg) - 'workspace_id' - 'conn_ids' - 'pend_ids' - 'ours_ids') || jsonb_build_object(
      'status', coalesce(pg.status, 'not_contacted'),
      'tags', (select coalesce(jsonb_agg(t.name), '[]'::jsonb) from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = pg.id),
      'connected_via', (select coalesce(jsonb_agg(jsonb_build_object('sender_id', sd.id, 'name', coalesce(nullif(sd.display_name, ''), sd.public_identifier, sd.owner_email::text), 'channel', outreach__channel_of(sd.provider),
                                 'source', (select x.relation_source from outreach_lead_sender_state x where x.lead_id = pg.id and x.sender_id = sd.id))), '[]'::jsonb)
                          from outreach_senders sd where sd.id = any(pg.conn_ids)),
      'pending_with', (select coalesce(jsonb_agg(jsonb_build_object('sender_id', sd.id, 'name', coalesce(nullif(sd.display_name, ''), sd.public_identifier, sd.owner_email::text), 'channel', outreach__channel_of(sd.provider))), '[]'::jsonb)
                          from outreach_senders sd where sd.id = any(pg.pend_ids)),
      'channels', jsonb_build_object('reachable', coalesce(pg.identity_channels, '{}'), 'used', coalesce(pg.used_channels, '{}'), 'replied', coalesce(pg.replied_channels, '{}'), 'bounced', coalesce(pg.bounced_channels, '{}')))
    order by case when p_sort = 'created' then pg.created_at when p_sort = 'message' then pg.last_message_at else coalesce(pg.last_activity_at, pg.created_at) end desc nulls last, pg.id desc), '[]'::jsonb)
    into res from page pg;
  return jsonb_build_object('rows', res, 'total', total, 'limit', lim, 'offset', off, 'has_more', total > off + lim);
end $$;
revoke all on function outreach_leads_list(uuid, jsonb, text, int, int) from public, anon;
grant execute on function outreach_leads_list(uuid, jsonb, text, int, int) to authenticated, service_role;

-- Add to prospects (PRD §3.3): inbox contacts move to the Prospects tab; a hidden lead is unhidden at the same time.
create or replace function outreach_lead_promote(p_ws uuid, p_lead_ids uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform outreach_require(p_ws, 'member');
  if coalesce(array_length(p_lead_ids, 1), 0) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  update outreach_leads set prospect_since = now(), hidden_at = null, hidden_reason = null, updated_at = now()
   where workspace_id = p_ws and id = any(p_lead_ids) and (prospect_since is null or hidden_at is not null) and outreach_client_visible(p_ws, client_id);
  get diagnostics n = row_count;
  perform outreach_audit(p_ws, 'leads.promote', 'lead', null, jsonb_build_object('count', n));
  return n;
end $$;
revoke all on function outreach_lead_promote(uuid, uuid[]) from public, anon;
grant execute on function outreach_lead_promote(uuid, uuid[]) to authenticated, service_role;

-- Hide / unhide by hand (managers). Hidden leads keep everything; the Hidden filter shows them.
create or replace function outreach_lead_hide(p_ws uuid, p_lead_ids uuid[], p_hide boolean default true) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform outreach_require(p_ws, 'manager');
  if coalesce(array_length(p_lead_ids, 1), 0) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  if p_hide then
    update outreach_leads set hidden_at = now(), hidden_reason = 'manual', updated_at = now()
     where workspace_id = p_ws and id = any(p_lead_ids) and hidden_at is null and outreach_client_visible(p_ws, client_id);
  else
    update outreach_leads set hidden_at = null, hidden_reason = null, updated_at = now()
     where workspace_id = p_ws and id = any(p_lead_ids) and hidden_at is not null and outreach_client_visible(p_ws, client_id);
  end if;
  get diagnostics n = row_count;
  perform outreach_audit(p_ws, case when p_hide then 'leads.hide' else 'leads.unhide' end, 'lead', null, jsonb_build_object('count', n));
  return n;
end $$;
revoke all on function outreach_lead_hide(uuid, uuid[], boolean) from public, anon;
grant execute on function outreach_lead_hide(uuid, uuid[], boolean) to authenticated, service_role;

-- ----------------------------------------------------------------------------- 9. enrichment: order + wait reasons (PRD D9, §8.3)
-- Order: enrolments waiting on enrichment; then the first-reply queue; then prospects; then inbox people. Never automated
-- senders, company pages or hidden leads (their queue rows are dropped by the wait-reason refresh).
create or replace function outreach_enrich_next(p_sender uuid, p_limit int)
returns table(lead_id uuid, want_posts boolean, priority boolean, provider_id text, public_identifier text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  return query
    (select l.id, coalesce(q.want_posts, false), true, l.provider_id, l.public_identifier::text
       from outreach_enrollments e join outreach_leads l on l.id = e.lead_id left join outreach_enrich_queue q on q.lead_id = l.id
      where e.sender_id = p_sender and e.status = 'waiting_task' and e.wait_reason = 'enrichment' and coalesce(q.attempts, 0) < 3 and coalesce(q.next_at, now()) <= now()
      order by e.priority, e.created_at limit p_limit)
    union all
    (select l.id, q.want_posts, false, l.provider_id, l.public_identifier::text
       from outreach_enrich_queue q join outreach_leads l on l.id = q.lead_id
      where q.workspace_id = s.workspace_id and q.next_at <= now() and q.attempts < 3 and (l.client_id is null or s.client_id is null or l.client_id = s.client_id)
        and l.kind = 'person' and l.hidden_at is null
        and (q.sender_id is null or q.sender_id = p_sender or q.created_at < now() - interval '24 hours')
        and not exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.status = 'waiting_task' and e.wait_reason = 'enrichment')
      order by (q.reason = 'reply') desc, (l.prospect_since is not null) desc, q.created_at limit p_limit);
end $$;
revoke execute on function outreach_enrich_next(uuid, int) from public, anon, authenticated;
grant execute on function outreach_enrich_next(uuid, int) to service_role;

-- The next time a sender's profile-view budget starts again: the first schedule window of the next local day (else midnight).
create or replace function outreach__sender_next_window(p_sender uuid) returns timestamptz
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; d date; w jsonb; t text; i int;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then return null; end if;
  d := outreach_sender_local_date(p_sender, now());
  for i in 1..7 loop
    d := d + 1;
    w := s.schedule -> lower(to_char(d, 'dy'));
    if w is not null and jsonb_typeof(w) = 'array' and jsonb_array_length(w) > 0 then
      t := w->0->>0;
      return ((d::text || ' ' || coalesce(nullif(t, ''), '00:00'))::timestamp) at time zone coalesce(s.timezone, 'UTC');
    end if;
  end loop;
  return (d::timestamp) at time zone coalesce(s.timezone, 'UTC');
end $$;
revoke execute on function outreach__sender_next_window(uuid) from public, anon, authenticated;

-- Writes outreach_leads.enrich_wait_reason for every queued lead; drops queue rows of leads that are never enriched.
-- Called by outreach-worker-enrich after each run (every 10 minutes), so the list cell is at most that stale.
create or replace function outreach_enrich_wait_reason_refresh() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare dropped int; n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  with gone as (delete from outreach_enrich_queue q using outreach_leads l where l.id = q.lead_id and (l.kind <> 'person' or l.hidden_at is not null) returning q.lead_id)
  select count(*) into dropped from gone;
  update outreach_leads l set enrich_status = 'none', enrich_wait_reason = null
   where (l.kind <> 'person' or l.hidden_at is not null) and l.enrich_status = 'waiting';
  with ws as (
    select w.id as workspace_id,
           (select count(*) from outreach_senders sd where sd.workspace_id = w.id and sd.provider = 'LINKEDIN' and sd.status = 'ok' and sd.deleted_at is null) as li_senders,
           (select count(*) from outreach_senders sd where sd.workspace_id = w.id and sd.provider = 'LINKEDIN' and sd.status = 'ok' and sd.deleted_at is null and outreach_enrich_allowance(sd.id, false) > 0) as with_budget,
           (select jsonb_build_object('sender_id', sd.id, 'sender', coalesce(nullif(sd.display_name, ''), sd.public_identifier, 'an account'), 'resets_at', outreach__sender_next_window(sd.id))
              from outreach_senders sd where sd.workspace_id = w.id and sd.provider = 'LINKEDIN' and sd.status = 'ok' and sd.deleted_at is null
             order by outreach__sender_next_window(sd.id) limit 1) as first_reset
      from outreach_workspaces w where exists (select 1 from outreach_enrich_queue q where q.workspace_id = w.id)),
  pos as (
    select q.lead_id, q.workspace_id,
           row_number() over (partition by q.workspace_id order by (q.reason = 'reply') desc, (l.prospect_since is not null) desc, q.created_at) as position
      from outreach_enrich_queue q join outreach_leads l on l.id = q.lead_id),
  want as (
    select p.lead_id,
           case when ws.li_senders = 0 then jsonb_build_object('kind', 'no_sender')
                when ws.with_budget = 0 and ws.first_reset is not null then jsonb_build_object('kind', 'budget') || ws.first_reset
                else jsonb_build_object('kind', 'queue', 'position', p.position) end as reason
      from pos p join ws on ws.workspace_id = p.workspace_id)
  update outreach_leads l set enrich_wait_reason = want.reason from want where l.id = want.lead_id and l.enrich_wait_reason is distinct from want.reason;
  get diagnostics n = row_count;
  update outreach_leads set enrich_wait_reason = null where enrich_wait_reason is not null and enrich_status <> 'waiting';
  return jsonb_build_object('updated', n, 'dropped', dropped);
end $$;
revoke execute on function outreach_enrich_wait_reason_refresh() from public, anon, authenticated;
grant execute on function outreach_enrich_wait_reason_refresh() to service_role;

-- ----------------------------------------------------------------------------- 10. workspace setting
-- create_leads_from_inbound: true -> people_only, false -> none (PRD §3.2). Code accepts both forms for one release.
update outreach_workspaces
   set settings = settings || jsonb_build_object('create_leads_from_inbound', case when (settings->>'create_leads_from_inbound') = 'false' then 'none' else 'people_only' end)
 where jsonb_typeof(settings->'create_leads_from_inbound') = 'boolean';

-- ----------------------------------------------------------------------------- 11. cron: dispatcher row + nightly reconcile
insert into outreach_cron_jobs (name, fn, body, every_s, guarded, note) values
  ('lead-summary', 'outreach-worker-lead-summary', '{"mode":"tick"}', 30, true, 'leads waiting in outreach_lead_summary_queue (status / connections summary for the leads page)')
on conflict (name) do update set fn = excluded.fn, body = excluded.body, guarded = excluded.guarded, note = excluded.note;

-- (060 defines and drops this helper; defined again here so this file stands on its own)
create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;
select outreach__patch_fn('public.outreach_cron_has_work(text)'::regprocedure, $q$when 'lead-summary' then$q$,
$q$    when 'inbound' then exists$q$,
$q$    when 'lead-summary' then exists (select 1 from outreach_lead_summary_queue q where q.queued_at <= now())
    when 'inbound' then exists$q$);

do $$ begin perform cron.unschedule('outreach-lead-summary-reconcile'); exception when others then null; end $$;
select cron.schedule('outreach-lead-summary-reconcile', '30 3 * * *', $$select outreach_invoke('outreach-worker-lead-summary', '{"mode":"reconcile"}'::jsonb)$$);

-- ----------------------------------------------------------------------------- 12. backfill (PRD §9)
-- 1. origin from the creation path; prospect flag
update outreach_leads set origin = outreach__origin_of(source) where origin = 'import' and source is not null and outreach__origin_of(source) <> 'import';
update outreach_leads set prospect_since = created_at where prospect_since is null and origin <> 'inbound';
update outreach_leads l set prospect_since = x.since
  from (select l2.id, least(
          (select min(e.created_at) from outreach_enrollments e where e.lead_id = l2.id),
          case when l2.list_id is not null or l2.stage_id is not null then l2.updated_at end) as since
          from outreach_leads l2 where l2.origin = 'inbound' and l2.prospect_since is null) x
 where x.id = l.id and x.since is not null;

-- 2. kind of inbound leads from their first conversation (email leads with no conversation: from the address)
with first_chat as (
  select distinct on (c.lead_id) c.lead_id, c.provider, c.attendee_name, c.attendee_provider_id, c.attendee_public_identifier, c.custom_attributes
    from outreach_chats c join outreach_leads l on l.id = c.lead_id
   where l.origin = 'inbound' and c.provider <> 'WEBCHAT'
   order by c.lead_id, c.created_at)
update outreach_leads l set kind = k.kind
  from (select fc.lead_id, outreach_inbound_kind(fc.provider, fc.attendee_name, fc.attendee_provider_id, coalesce(fc.attendee_public_identifier, fc.attendee_provider_id), fc.custom_attributes->'linkedin', null) as kind from first_chat fc) k
 where k.lead_id = l.id and l.kind = 'person' and k.kind <> 'person';
update outreach_leads l set kind = outreach_inbound_kind('GMAIL', l.full_name, null, l.email_work::text, null, null)
 where l.origin = 'inbound' and l.kind = 'person' and l.email_work is not null and l.public_identifier is null and l.provider_id is null
   and not exists (select 1 from outreach_chats c where c.lead_id = l.id)
   and outreach_inbound_kind('GMAIL', l.full_name, null, l.email_work::text, null, null) <> 'person';

-- 3. hide automated senders and company pages nobody ever enrolled or touched (reversible)
update outreach_leads l set hidden_at = now(), hidden_reason = l.kind, prospect_since = null
 where l.kind <> 'person' and l.hidden_at is null
   and not exists (select 1 from outreach_enrollments e where e.lead_id = l.id)
   and not exists (select 1 from outreach_actions a where a.lead_id = l.id and a.status = 'sent' and a.action_type in ('invite','message','inmail','email','reply','new_chat','follow'));

-- 4. conversations follow their lead's kind; conversations without a lead are classified directly
update outreach_chats c set counterpart_kind = l.kind from outreach_leads l where l.id = c.lead_id and c.counterpart_kind <> l.kind;
update outreach_chats c set counterpart_kind = k.kind
  from (select c2.id, outreach_inbound_kind(c2.provider, c2.attendee_name, c2.attendee_provider_id, coalesce(c2.attendee_public_identifier, c2.attendee_provider_id), c2.custom_attributes->'linkedin', null) as kind
          from outreach_chats c2 where c2.lead_id is null and c2.provider <> 'WEBCHAT' and c2.counterpart_kind = 'person') k
 where k.id = c.id and k.kind <> 'person';

-- 5. relation source for connections that already exist (the trigger only sees changes from now on)
alter table outreach_lead_sender_state disable trigger outreach_lss_a0_relation_source;
alter table outreach_lead_sender_state disable trigger outreach_lss_zz_summary;
update outreach_lead_sender_state x
   set connected_at = coalesce(x.connected_at, x.invite_accepted_at, x.invite_detected_at, x.updated_at),
       relation_checked_at = coalesce(x.relation_checked_at, x.updated_at),
       relation_source = coalesce(x.relation_source, case when x.invite_sent_at is not null and x.invite_sent_at <= coalesce(x.invite_accepted_at, x.invite_detected_at, x.updated_at) + interval '1 minute' then 'our_invite' else 'unknown' end)
 where x.relation = 'first' and (x.relation_source is null or x.connected_at is null);
update outreach_lead_sender_state x set relation_checked_at = coalesce(x.relation_checked_at, x.updated_at) where x.relation_checked_at is null;
alter table outreach_lead_sender_state enable trigger outreach_lss_a0_relation_source;
alter table outreach_lead_sender_state enable trigger outreach_lss_zz_summary;

-- 6. every lead gets a summary row (F55 drains the queue; the first drain runs here for small tables so the page is right at once)
insert into outreach_lead_summary_queue(lead_id) select id from outreach_leads on conflict do nothing;
do $$
declare r jsonb; i int := 0;
begin
  if (select count(*) from outreach_leads) <= 5000 then
    loop
      r := outreach_lead_summary_process(500);
      i := i + 1;
      exit when (r->>'processed')::int = 0 or i >= 20;
    end loop;
  end if;
end $$;

-- 7. enrichment rows of leads that are never enriched, and the first wait reasons
select outreach_enrich_wait_reason_refresh();

-- ----------------------------------------------------------------------------- 13. check (PRD §9.5): Replied after vs the old "Replied" (last_replied_at)
select w.name as workspace,
       count(*) filter (where l.last_replied_at is not null) as old_replied,
       count(*) filter (where s.status_rank >= 4 and l.hidden_at is null) as new_replied,
       count(*) filter (where l.last_replied_at is not null and l.hidden_at is not null) as hidden_junk,
       count(*) filter (where l.last_replied_at is not null and s.status = 'wrote_to_us') as wrote_first,
       count(*) filter (where l.last_replied_at is not null and l.hidden_at is null and s.status <> 'wrote_to_us' and coalesce(s.status_rank, 0) < 4) as other_difference
  from outreach_leads l join outreach_workspaces w on w.id = l.workspace_id left join outreach_lead_summary s on s.lead_id = l.id
 group by w.name order by w.name;
