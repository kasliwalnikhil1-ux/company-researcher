-- =============================================================================
-- Sales CRM — 002 helpers, triggers (the hard rules), views, RLS, RPCs
-- Error convention (same as outreach): raise exception 'E_CODE: message'.
-- Every RPC is security definer + crm_require_member() so the web app and the
-- MCP connector go through exactly the same code path (no UI-only or MCP-only
-- behaviour).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
create or replace function crm_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from crm_members m where m.user_id = auth.uid() and m.is_active);
$$;

create or replace function crm_require_member() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  if not crm_is_member() then raise exception 'E_FORBIDDEN: you are not on the sales CRM team (ask a member to add you in CRM → Settings → Team)'; end if;
end $$;

create or replace function crm_setting(p_key text, p_default jsonb default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from crm_settings where key = p_key), p_default);
$$;

create or replace function crm_tz() returns text
language sql stable security definer set search_path = public as $$
  select coalesce(crm_setting('default_timezone') #>> '{}', 'Asia/Kolkata');
$$;

create or replace function crm_stale_days() returns int
language sql stable security definer set search_path = public as $$
  select coalesce((crm_setting('stale_after_days') #>> '{}')::int, 14);
$$;

create or replace function crm_stage_rank(p crm_deal_stage_t) returns int
language sql immutable as $$
  select array_position(enum_range(null::crm_deal_stage_t), p);
$$;

create or replace function crm_slugify(p text) returns text
language sql immutable as $$
  select trim(both '_' from regexp_replace(lower(coalesce(p, '')), '[^a-z0-9]+', '_', 'g'));
$$;

create or replace function crm_domain_from_url(p text) returns text
language plpgsql immutable as $$
declare s text;
begin
  if p is null or trim(p) = '' then return null; end if;
  s := lower(trim(p));
  s := regexp_replace(s, '^[a-z]+://', '');
  s := regexp_replace(s, '^www\.', '');
  s := split_part(split_part(split_part(s, '/', 1), '?', 1), ':', 1);
  if s !~ '^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$' then return null; end if;
  return s;
end $$;

/** Domain to fetch a logo for: the company's own domain, else the first contact email domain that is not a free mailbox.
    The free-mailbox list mirrors FREE_MAIL in components/crm/ui.tsx. */
create or replace function crm_company_logo_domain(p_company_id uuid, p_domain text default null) returns text
language sql stable set search_path = public as $$
  select coalesce(nullif(trim(p_domain), ''), (
    select crm_domain_from_url(split_part(ct.email, '@', 2)) from crm_contacts ct
    where ct.company_id = p_company_id and ct.email like '%@%'
      and crm_domain_from_url(split_part(ct.email, '@', 2)) is not null
      and lower(trim(split_part(ct.email, '@', 2))) <> all (array['gmail.com','googlemail.com','yahoo.com','yahoo.in','yahoo.co.in','yahoo.co.uk','ymail.com','rocketmail.com','hotmail.com','outlook.com','live.com','msn.com','icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','pm.me','zoho.com','zohomail.com','rediffmail.com','gmx.com','gmx.net','mail.com','yandex.com','yandex.ru','hey.com','fastmail.com','qq.com','163.com'])
    order by ct.is_primary desc, ct.created_at limit 1));
$$;

create or replace function crm_is_uuid(p text) returns boolean
language sql immutable as $$
  select p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create or replace function crm_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

/** Local-day window [from, to) for a date in a timezone. */
create or replace function crm_day_window(p_date date, p_tz text default null, out w_from timestamptz, out w_to timestamptz)
language plpgsql stable as $$
declare tz text := coalesce(p_tz, crm_tz());
begin
  w_from := (p_date::timestamp) at time zone tz;
  w_to := w_from + interval '1 day';
end $$;

-- -----------------------------------------------------------------------------
-- Lookup / entity resolvers (accept uuid | slug | label so chat can say "LinkedIn")
-- -----------------------------------------------------------------------------
-- SECURITY INVOKER ON PURPOSE (no `security definer` on the resolvers, crm_deal_json, crm_numbers, crm_owner_actuals):
-- the grants loop at the bottom exposes every crm_* function to `authenticated`, i.e. to every signed-in user of the
-- wider app, not just the CRM team. A definer helper with no crm_require_member() is therefore a public read of CRM data
-- (crm_numbers handed the whole scoreboard to non-members until 2026-09-20). As invoker functions they run under the
-- caller's RLS when called directly (a non-member sees nothing) and as the owner when called from the guarded RPCs.
-- Rule for new helpers: member-check it, or leave it invoker. Never definer + unguarded.
create or replace function crm_lookup_table(p_kind text) returns text
language plpgsql immutable as $$
begin
  return case p_kind
    when 'icp_segment' then 'crm_icp_segments'
    when 'source_channel' then 'crm_source_channels'
    when 'activity_type' then 'crm_activity_types'
    else null end;
end $$;

create or replace function crm_resolve_lookup(p_kind text, p_ref text) returns uuid
language plpgsql stable set search_path = public as $$
declare tbl text := crm_lookup_table(p_kind); r uuid;
begin
  if tbl is null then raise exception 'E_PAYLOAD_INVALID: unknown lookup kind %', p_kind; end if;
  if p_ref is null or trim(p_ref) = '' then return null; end if;
  if crm_is_uuid(p_ref) then
    execute format('select id from %I where id = $1', tbl) into r using p_ref::uuid;
    if r is not null then return r; end if;
  end if;
  execute format('select id from %I where slug = $1 or lower(label) = lower($1) or slug = crm_slugify($1) order by is_active desc limit 1', tbl) into r using trim(p_ref);
  if r is null then
    raise exception 'E_NOT_FOUND: unknown % "%" — add it in CRM → Settings (or with lookup_save) first', replace(p_kind, '_', ' '), p_ref;
  end if;
  return r;
end $$;

create or replace function crm_resolve_member(p_ref text) returns uuid
language plpgsql stable set search_path = public as $$
declare r uuid;
begin
  if p_ref is null or trim(p_ref) = '' or lower(p_ref) = 'me' then return auth.uid(); end if;
  if crm_is_uuid(p_ref) then
    select user_id into r from crm_members where user_id = p_ref::uuid;
    if r is not null then return r; end if;
  end if;
  select user_id into r from crm_members where lower(email) = lower(trim(p_ref)) or lower(display_name) = lower(trim(p_ref)) order by is_active desc limit 1;
  if r is null then
    select user_id into r from crm_members where display_name ilike '%' || trim(p_ref) || '%' and is_active order by display_name limit 1;
  end if;
  if r is null then raise exception 'E_NOT_FOUND: no team member matches "%"', p_ref; end if;
  return r;
end $$;

/** company_id | company (domain, website, or name). */
create or replace function crm_resolve_company(p jsonb, p_required boolean default true) returns uuid
language plpgsql stable set search_path = public as $$
declare r uuid; ref text; d text;
begin
  if p ? 'company_id' and p->>'company_id' is not null then
    select id into r from crm_companies where id = (p->>'company_id')::uuid;
    if r is null then raise exception 'E_NOT_FOUND: company % not found', p->>'company_id'; end if;
    return r;
  end if;
  ref := coalesce(p->>'company', p->>'company_name', p->>'company_domain');
  if ref is null or trim(ref) = '' then
    if p_required then raise exception 'E_PAYLOAD_INVALID: company_id or company (name/domain) is required'; end if;
    return null;
  end if;
  if crm_is_uuid(ref) then select id into r from crm_companies where id = ref::uuid; if r is not null then return r; end if; end if;
  d := crm_domain_from_url(ref);
  if d is not null then select id into r from crm_companies where domain = d; if r is not null then return r; end if; end if;
  select id into r from crm_companies where lower(name) = lower(trim(ref)) limit 1;
  if r is null then select id into r from crm_companies where name ilike '%' || trim(ref) || '%' order by length(name) limit 1; end if;
  if r is null and p_required then raise exception 'E_NOT_FOUND: no company matches "%" — create it with upsert_company first', ref; end if;
  return r;
end $$;

/** contact_id | contact_email | (company + contact_name). */
create or replace function crm_resolve_contact(p jsonb, p_required boolean default true) returns uuid
language plpgsql stable set search_path = public as $$
declare r uuid; cid uuid; nm text;
begin
  if p ? 'contact_id' and p->>'contact_id' is not null then
    select id into r from crm_contacts where id = (p->>'contact_id')::uuid;
    if r is null then raise exception 'E_NOT_FOUND: contact % not found', p->>'contact_id'; end if;
    return r;
  end if;
  if coalesce(p->>'contact_email', p->>'email') is not null then
    select id into r from crm_contacts where lower(email) = lower(trim(coalesce(p->>'contact_email', p->>'email')));
    if r is not null then return r; end if;
  end if;
  nm := coalesce(p->>'contact', p->>'contact_name');
  if nm is not null then
    cid := crm_resolve_company(p, false);
    if cid is not null then
      select id into r from crm_contacts where company_id = cid and lower(name) = lower(trim(nm)) limit 1;
      if r is null then select id into r from crm_contacts where company_id = cid and name ilike '%' || trim(nm) || '%' limit 1; end if;
    else
      select id into r from crm_contacts where lower(name) = lower(trim(nm)) limit 1;
    end if;
  end if;
  if r is null and p_required then raise exception 'E_NOT_FOUND: no contact matches % — add them with upsert_contact first', coalesce(nm, p->>'contact_email', '(none given)'); end if;
  return r;
end $$;

-- -----------------------------------------------------------------------------
-- Triggers: companies
-- -----------------------------------------------------------------------------
create or replace function crm_trg_company_biu() returns trigger language plpgsql as $$
begin
  if new.website is not null then new.domain := coalesce(crm_domain_from_url(new.website), new.domain); end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists crm_companies_biu on crm_companies;
create trigger crm_companies_biu before insert or update on crm_companies for each row execute function crm_trg_company_biu();

drop trigger if exists crm_contacts_bu on crm_contacts;
create trigger crm_contacts_bu before update on crm_contacts for each row execute function crm_set_updated_at();

-- -----------------------------------------------------------------------------
-- Triggers: deals — currency, forward-only stages, stage history
-- -----------------------------------------------------------------------------
create or replace function crm_trg_deal_biu() returns trigger language plpgsql security definer set search_path = public as $$
declare fx numeric; reason text;
begin
  new.currency := upper(coalesce(new.currency, 'USD'));
  if new.value_monthly is null then
    new.value_monthly_usd := null;
  else
    select usd_per_unit into fx from crm_fx_rates where currency = new.currency;
    if fx is null then raise exception 'E_UNKNOWN_CURRENCY: no FX rate for % — add it in CRM → Settings → Currencies', new.currency; end if;
    new.value_monthly_usd := round(new.value_monthly * fx, 2);
  end if;
  if new.source_channel_id is null then
    select source_channel_id into new.source_channel_id from crm_companies where id = new.company_id;
  end if;
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    new.stage_entered_at := coalesce(new.stage_entered_at, now());
    if new.stage in ('won','lost') then new.closed_at := coalesce(new.closed_at, now()); end if;
  elsif new.stage <> old.stage then
    -- Rule 4: forward or to lost; backwards needs an explicit reason (set by crm_update_deal)
    reason := nullif(current_setting('crm.stage_reason', true), '');
    if new.stage <> 'lost' and crm_stage_rank(new.stage) < crm_stage_rank(old.stage) and reason is null then
      raise exception 'E_STAGE_BACKWARD: % → % moves the deal backwards; give a reason (update_deal … reason) so it is written to stage_history', old.stage, new.stage;
    end if;
    new.stage_entered_at := now();
    new.closed_at := case when new.stage in ('won','lost') then now() else null end;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists crm_deals_biu on crm_deals;
create trigger crm_deals_biu before insert or update on crm_deals for each row execute function crm_trg_deal_biu();

create or replace function crm_trg_deal_history() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into crm_stage_history(deal_id, from_stage, to_stage, changed_by, changed_at) values (new.id, null, new.stage, coalesce(new.created_by, auth.uid()), new.stage_entered_at);
  elsif new.stage <> old.stage then
    insert into crm_stage_history(deal_id, from_stage, to_stage, reason, changed_by) values (new.id, old.stage, new.stage, nullif(current_setting('crm.stage_reason', true), ''), auth.uid());
  end if;
  return new;
end $$;
drop trigger if exists crm_deals_history on crm_deals;
create trigger crm_deals_history after insert or update of stage on crm_deals for each row execute function crm_trg_deal_history();

-- -----------------------------------------------------------------------------
-- Triggers: activities — fill company/deal/owner, bump deal.last_activity_at
-- -----------------------------------------------------------------------------
create or replace function crm_trg_activity_bi() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.company_id is null and new.contact_id is not null then select company_id into new.company_id from crm_contacts where id = new.contact_id; end if;
  if new.company_id is null and new.deal_id is not null then select company_id into new.company_id from crm_deals where id = new.deal_id; end if;
  if new.company_id is null then raise exception 'E_PAYLOAD_INVALID: activity needs a contact, deal or company'; end if;
  if new.deal_id is null then
    select id into new.deal_id from crm_deals where company_id = new.company_id and stage not in ('won','lost') order by created_at desc limit 1;
  end if;
  if new.source_channel_id is null then
    select coalesce(d.source_channel_id, c.source_channel_id) into new.source_channel_id
      from crm_companies c left join crm_deals d on d.id = new.deal_id where c.id = new.company_id;
  end if;
  new.owner_id := coalesce(new.owner_id, case when exists (select 1 from crm_members where user_id = auth.uid()) then auth.uid() end);
  new.created_by := coalesce(new.created_by, auth.uid());
  return new;
end $$;
drop trigger if exists crm_activities_bi on crm_activities;
create trigger crm_activities_bi before insert on crm_activities for each row execute function crm_trg_activity_bi();

create or replace function crm_trg_activity_ai() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deal_id is not null then
    update crm_deals set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'), new.occurred_at) where id = new.deal_id;
  end if;
  return new;
end $$;
drop trigger if exists crm_activities_ai on crm_activities;
create trigger crm_activities_ai after insert on crm_activities for each row execute function crm_trg_activity_ai();

-- -----------------------------------------------------------------------------
-- Triggers: meetings — RULE 1: no held/no_show without a matching capture
-- -----------------------------------------------------------------------------
create or replace function crm_trg_meeting_biu() returns trigger language plpgsql security definer set search_path = public as $$
declare cap crm_capture_outcome_t;
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
    if new.status in ('held','no_show') then
      raise exception 'E_CAPTURE_REQUIRED: a meeting cannot be created as % — schedule it, then call capture_meeting', new.status;
    end if;
  elsif new.status is distinct from old.status and new.status in ('held','no_show') then
    select outcome into cap from crm_meeting_captures where meeting_id = new.id;
    if cap is null then
      raise exception 'E_CAPTURE_REQUIRED: meeting % cannot move to % without a meeting_capture row — use capture_meeting(meeting_id, outcome, …)', new.id, new.status;
    end if;
    if cap::text <> new.status::text then
      raise exception 'E_CAPTURE_MISMATCH: the capture for meeting % says %, not %', new.id, cap, new.status;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists crm_meetings_biu on crm_meetings;
create trigger crm_meetings_biu before insert or update on crm_meetings for each row execute function crm_trg_meeting_biu();

-- Booking a meeting moves the deal forward to meeting_booked (never backwards).
create or replace function crm_trg_meeting_ai() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update crm_deals set stage = 'meeting_booked'
    where id = new.deal_id and stage <> 'lost' and crm_stage_rank(stage) < crm_stage_rank('meeting_booked');
  update crm_deals set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'), now()) where id = new.deal_id;
  return new;
end $$;
drop trigger if exists crm_meetings_ai on crm_meetings;
create trigger crm_meetings_ai after insert on crm_meetings for each row execute function crm_trg_meeting_ai();

-- -----------------------------------------------------------------------------
-- Triggers: meeting captures — completeness per outcome, repeat no-show,
-- and the single write that flips the meeting + deal
-- -----------------------------------------------------------------------------
create or replace function crm_capture_missing(p_outcome crm_capture_outcome_t, p jsonb) returns text[]
language plpgsql immutable as $$
declare missing text[] := '{}'; pp jsonb := p->'pain_points'; dead boolean := coalesce((p->>'is_dead')::boolean, false);
begin
  if p_outcome = 'held' then
    if pp is null or jsonb_typeof(pp) <> 'array' or jsonb_array_length(pp) = 0 then missing := array_append(missing, 'pain_points (in the prospect''s own words)'); end if;
    if p->'commercials_discussed' is null or jsonb_typeof(p->'commercials_discussed') = 'null' then missing := array_append(missing, 'commercials_discussed ({price, volume, currency} or {none: true})'); end if;
    if dead then
      if nullif(trim(coalesce(p->>'dead_reason','')), '') is null then missing := array_append(missing, 'dead_reason (is_dead is true)'); end if;
    else
      if nullif(trim(coalesce(p->>'next_step','')), '') is null then missing := array_append(missing, 'next_step (or is_dead + dead_reason)'); end if;
      if nullif(trim(coalesce(p->>'next_step_date','')), '') is null then missing := array_append(missing, 'next_step_date'); end if;
    end if;
  else
    if nullif(trim(coalesce(p->>'no_show_reason','')), '') is null then missing := array_append(missing, 'no_show_reason'); end if;
    if nullif(trim(coalesce(p->>'follow_up_action','')), '') is null then missing := array_append(missing, 'follow_up_action'); end if;
    if nullif(trim(coalesce(p->>'follow_up_date','')), '') is null then missing := array_append(missing, 'follow_up_date'); end if;
  end if;
  return missing;
end $$;

create or replace function crm_trg_capture_biu() returns trigger language plpgsql security definer set search_path = public as $$
declare m record; missing text[]; prior int;
begin
  select * into m from crm_meetings where id = new.meeting_id;
  if m is null then raise exception 'E_NOT_FOUND: meeting % not found', new.meeting_id; end if;
  if m.status = 'cancelled' then raise exception 'E_MEETING_CANCELLED: meeting % is cancelled; reschedule it before capturing', new.meeting_id; end if;
  missing := crm_capture_missing(new.outcome, to_jsonb(new));
  if array_length(missing, 1) > 0 then
    raise exception 'E_CAPTURE_INCOMPLETE: % capture is missing: %', new.outcome, array_to_string(missing, '; ');
  end if;
  if new.outcome = 'no_show' then
    select count(*) into prior from crm_meetings pm
      where pm.id <> m.id and pm.status = 'no_show' and pm.scheduled_at < m.scheduled_at
        and (pm.contact_id = m.contact_id or (m.contact_id is null and pm.deal_id = m.deal_id));
    new.is_repeat_no_show := prior > 0;
  else
    new.is_repeat_no_show := false;
  end if;
  if tg_op = 'INSERT' then new.created_by := coalesce(new.created_by, auth.uid()); end if;
  return new;
end $$;
drop trigger if exists crm_captures_biu on crm_meeting_captures;
create trigger crm_captures_biu before insert or update on crm_meeting_captures for each row execute function crm_trg_capture_biu();

create or replace function crm_trg_capture_ai() returns trigger language plpgsql security definer set search_path = public as $$
declare m record;
begin
  select * into m from crm_meetings where id = new.meeting_id;
  -- flip the meeting (the BEFORE UPDATE trigger on meetings now finds the capture)
  update crm_meetings set status = new.outcome::text::crm_meeting_status_t where id = new.meeting_id and status is distinct from new.outcome::text::crm_meeting_status_t;
  if new.outcome = 'held' then
    if new.is_dead then
      perform set_config('crm.stage_reason', 'dead after meeting: ' || coalesce(new.dead_reason, ''), true);
      update crm_deals set stage = 'lost', lost_reason = coalesce(new.dead_reason, lost_reason), next_step = null, next_step_date = null where id = m.deal_id and stage <> 'lost';
      perform set_config('crm.stage_reason', '', true);
    else
      update crm_deals set stage = 'meeting_held' where id = m.deal_id and stage <> 'lost' and crm_stage_rank(stage) < crm_stage_rank('meeting_held');
      update crm_deals set next_step = new.next_step, next_step_date = new.next_step_date where id = m.deal_id and stage not in ('won','lost');
    end if;
  else
    update crm_deals set next_step = new.follow_up_action, next_step_date = new.follow_up_date where id = m.deal_id and stage not in ('won','lost');
  end if;
  update crm_deals set last_activity_at = greatest(coalesce(last_activity_at, '-infinity'), now()) where id = m.deal_id;
  return new;
end $$;
drop trigger if exists crm_captures_ai on crm_meeting_captures;
create trigger crm_captures_ai after insert on crm_meeting_captures for each row execute function crm_trg_capture_ai();

create or replace function crm_trg_capture_bd() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from crm_meetings where id = old.meeting_id and status in ('held','no_show')) then
    raise exception 'E_CAPTURE_LOCKED: the meeting is already %; edit the capture instead of deleting it', (select status from crm_meetings where id = old.meeting_id);
  end if;
  return old;
end $$;
drop trigger if exists crm_captures_bd on crm_meeting_captures;
create trigger crm_captures_bd before delete on crm_meeting_captures for each row execute function crm_trg_capture_bd();

drop trigger if exists crm_commitments_bu on crm_commitments;
create trigger crm_commitments_bu before update on crm_commitments for each row execute function crm_set_updated_at();

drop trigger if exists crm_transcripts_bu on crm_meeting_transcripts;
create trigger crm_transcripts_bu before update on crm_meeting_transcripts for each row execute function crm_set_updated_at();

drop trigger if exists crm_recordings_bu on crm_meeting_recordings;
create trigger crm_recordings_bu before update on crm_meeting_recordings for each row execute function crm_set_updated_at();

-- -----------------------------------------------------------------------------
-- Views (security_invoker → RLS of the caller applies)
-- -----------------------------------------------------------------------------
create or replace view crm_deals_v with (security_invoker = true) as
select d.*,
       c.name as company_name, c.domain as company_domain, c.country as company_country, c.timezone as company_timezone,
       seg.id as icp_segment_id, seg.slug as icp_segment_slug, seg.label as icp_segment_label,
       ch.slug as source_channel_slug, ch.label as source_channel_label,
       m.display_name as owner_name,
       (d.stage not in ('won','lost')) as is_active,
       greatest(0, extract(day from now() - d.stage_entered_at))::int as days_in_stage,
       greatest(0, extract(day from now() - coalesce(d.last_activity_at, d.created_at)))::int as days_since_activity,
       (d.stage not in ('won','lost') and (d.next_step is null or d.next_step_date is null)) as is_stuck,
       (d.stage not in ('won','lost') and coalesce(d.last_activity_at, d.created_at) < now() - make_interval(days => crm_stale_days())) as is_stale,
       (d.stage not in ('won','lost') and d.next_step_date is not null and d.next_step_date < (now() at time zone crm_tz())::date) as is_slipping
from crm_deals d
join crm_companies c on c.id = d.company_id
left join crm_icp_segments seg on seg.id = c.icp_segment_id
left join crm_source_channels ch on ch.id = d.source_channel_id
left join crm_members m on m.user_id = d.owner_id;

create or replace view crm_meetings_v with (security_invoker = true) as
select mt.*,
       d.company_id, c.name as company_name, d.stage as deal_stage, d.value_monthly, d.currency, d.value_monthly_usd, d.owner_id,
       ct.name as contact_name, ct.role as contact_role, ct.email as contact_email,
       seg.label as icp_segment_label, ch.label as source_channel_label,
       (cap.id is not null) as has_capture, cap.outcome as capture_outcome,
       (tr.id is not null) as has_transcript,         -- new columns go last: create or replace view cannot reorder
       (rec.id is not null) as has_recording,
       (cc.id is not null) as has_coaching, cc.execution_score as coaching_score
from crm_meetings mt
join crm_deals d on d.id = mt.deal_id
join crm_companies c on c.id = d.company_id
left join crm_contacts ct on ct.id = mt.contact_id
left join crm_icp_segments seg on seg.id = c.icp_segment_id
left join crm_source_channels ch on ch.id = d.source_channel_id
left join crm_meeting_captures cap on cap.meeting_id = mt.id
left join crm_meeting_transcripts tr on tr.meeting_id = mt.id
left join crm_meeting_recordings rec on rec.meeting_id = mt.id
left join crm_call_coaching cc on cc.meeting_id = mt.id;

create or replace view crm_activities_v with (security_invoker = true) as
select a.*, t.slug as activity_type_slug, t.label as activity_type_label, t.counts_as,
       ch.slug as source_channel_slug, ch.label as source_channel_label,
       ct.name as contact_name, ct.role as contact_role, c.name as company_name, m.display_name as owner_name
from crm_activities a
join crm_activity_types t on t.id = a.activity_type_id
left join crm_source_channels ch on ch.id = a.source_channel_id
left join crm_contacts ct on ct.id = a.contact_id
join crm_companies c on c.id = a.company_id
left join crm_members m on m.user_id = a.owner_id;

-- -----------------------------------------------------------------------------
-- RLS — every active team member sees and edits everything
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array['crm_settings','crm_icp_segments','crm_source_channels','crm_activity_types','crm_fx_rates','crm_channel_costs',
                               'crm_companies','crm_contacts','crm_deals','crm_stage_history','crm_activities','crm_meetings','crm_meeting_captures',
                               'crm_pain_point_tags','crm_capture_pain_tags','crm_commitments','crm_meeting_transcripts','crm_meeting_recordings','crm_call_coaching']) loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists crm_member_all on %I', t);
    execute format('create policy crm_member_all on %I for all to authenticated using (crm_is_member()) with check (crm_is_member())', t);
  end loop;
end $$;

alter table crm_members enable row level security;
drop policy if exists crm_members_read on crm_members;
create policy crm_members_read on crm_members for select to authenticated using (crm_is_member() or user_id = auth.uid());
-- writes to crm_members only via RPCs (security definer)

alter table crm_agent_calls enable row level security;   -- no policies: service role only
alter table crm_upload_tickets enable row level security; -- no policies: minted/consumed only inside crm_transcript_ticket / crm_save_transcript

grant select on crm_deals_v, crm_meetings_v, crm_activities_v to authenticated;

-- =============================================================================
-- RPCs
-- =============================================================================

-- ------------------------------------------------------------------ context
create or replace function crm_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me record; is_m boolean := crm_is_member();
begin
  if auth.uid() is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  select * into me from crm_members where user_id = auth.uid();
  return jsonb_build_object(
    'user_id', auth.uid(),
    'is_member', is_m,
    'me', case when me.user_id is null then null else jsonb_build_object('user_id', me.user_id, 'display_name', me.display_name, 'email', me.email, 'is_active', me.is_active) end,
    'members', case when is_m then (select coalesce(jsonb_agg(jsonb_build_object('user_id', user_id, 'display_name', display_name, 'email', email, 'is_active', is_active) order by display_name), '[]') from crm_members) else '[]'::jsonb end,
    'settings', case when is_m then (select coalesce(jsonb_object_agg(key, value), '{}') from crm_settings) else '{}'::jsonb end,
    'timezone', crm_tz(),
    'stale_after_days', crm_stale_days(),
    'stages', (select jsonb_agg(s) from unnest(enum_range(null::crm_deal_stage_t)) s),
    'icp_segments', case when is_m then (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.label), '[]') from crm_icp_segments x) else '[]'::jsonb end,
    'source_channels', case when is_m then (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.label), '[]') from crm_source_channels x) else '[]'::jsonb end,
    'activity_types', case when is_m then (select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.label), '[]') from crm_activity_types x) else '[]'::jsonb end,
    'fx_rates', case when is_m then (select coalesce(jsonb_object_agg(currency, usd_per_unit), '{}') from crm_fx_rates) else '{}'::jsonb end
  );
end $$;

-- ------------------------------------------------------------------ team & settings
create or replace function crm_add_member(p_email text, p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; r crm_members;
begin
  perform crm_require_member();
  select id into uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if uid is null then raise exception 'E_NOT_FOUND: no CapitalxAI account with email % — they must sign up first', p_email; end if;
  insert into crm_members(user_id, display_name, email) values (uid, coalesce(nullif(trim(p_display_name), ''), split_part(p_email, '@', 1)), lower(trim(p_email)))
  on conflict (user_id) do update set is_active = true, display_name = coalesce(nullif(trim(excluded.display_name), ''), crm_members.display_name), email = excluded.email
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function crm_set_member(p_user_id uuid, p_display_name text default null, p_is_active boolean default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r crm_members;
begin
  perform crm_require_member();
  if p_is_active = false and p_user_id = auth.uid() and (select count(*) from crm_members where is_active) <= 1 then
    raise exception 'E_LAST_MEMBER: you cannot deactivate the last active member';
  end if;
  update crm_members set display_name = coalesce(nullif(trim(p_display_name), ''), display_name), is_active = coalesce(p_is_active, is_active) where user_id = p_user_id returning * into r;
  if r.user_id is null then raise exception 'E_NOT_FOUND: member not found'; end if;
  return to_jsonb(r);
end $$;

create or replace function crm_set_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform crm_require_member();
  if p_key not in ('default_timezone','stale_after_days','default_currency','studio_name') then raise exception 'E_PAYLOAD_INVALID: unknown setting %', p_key; end if;
  insert into crm_settings(key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value, updated_at = now();
  return (select coalesce(jsonb_object_agg(key, value), '{}') from crm_settings);
end $$;

/** Add or edit a lookup value (icp_segment | source_channel | activity_type). Never a migration. */
create or replace function crm_lookup_save(p_kind text, p_label text, p_slug text default null, p_sort_order int default null, p_is_active boolean default null, p_notes text default null, p_counts_as text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tbl text := crm_lookup_table(p_kind); slug text := coalesce(nullif(crm_slugify(p_slug), ''), crm_slugify(p_label)); r jsonb; mx int;
begin
  perform crm_require_member();
  if tbl is null then raise exception 'E_PAYLOAD_INVALID: kind must be icp_segment | source_channel | activity_type'; end if;
  if slug = '' then raise exception 'E_PAYLOAD_INVALID: label is required'; end if;
  execute format('select coalesce(max(sort_order), 0) + 10 from %I', tbl) into mx;
  if p_kind = 'activity_type' then
    execute format($q$insert into %I(slug, label, sort_order, is_active, notes, counts_as) values ($1, $2, coalesce($3, %s), coalesce($4, true), $5, $6)
      on conflict (slug) do update set label = coalesce($2, %I.label), sort_order = coalesce($3, %I.sort_order), is_active = coalesce($4, %I.is_active), notes = coalesce($5, %I.notes), counts_as = coalesce($6, %I.counts_as)
      returning to_jsonb(%I.*)$q$, tbl, mx, tbl, tbl, tbl, tbl, tbl, tbl) into r using slug, trim(p_label), p_sort_order, p_is_active, p_notes, p_counts_as;
  else
    execute format($q$insert into %I(slug, label, sort_order, is_active, notes) values ($1, $2, coalesce($3, %s), coalesce($4, true), $5)
      on conflict (slug) do update set label = coalesce($2, %I.label), sort_order = coalesce($3, %I.sort_order), is_active = coalesce($4, %I.is_active), notes = coalesce($5, %I.notes)
      returning to_jsonb(%I.*)$q$, tbl, mx, tbl, tbl, tbl, tbl, tbl) into r using slug, trim(p_label), p_sort_order, p_is_active, p_notes;
  end if;
  return r;
end $$;

create or replace function crm_lookup_reorder(p_kind text, p_slugs text[]) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tbl text := crm_lookup_table(p_kind); i int; r jsonb;
begin
  perform crm_require_member();
  if tbl is null then raise exception 'E_PAYLOAD_INVALID: unknown lookup kind %', p_kind; end if;
  for i in 1 .. coalesce(array_length(p_slugs, 1), 0) loop
    execute format('update %I set sort_order = $1 where slug = $2', tbl) using i * 10, p_slugs[i];
  end loop;
  execute format('select coalesce(jsonb_agg(to_jsonb(x) order by x.sort_order, x.label), ''[]'') from %I x', tbl) into r;
  return r;
end $$;

create or replace function crm_set_fx_rate(p_currency text, p_usd_per_unit numeric) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform crm_require_member();
  insert into crm_fx_rates(currency, usd_per_unit) values (upper(trim(p_currency)), p_usd_per_unit)
    on conflict (currency) do update set usd_per_unit = excluded.usd_per_unit, updated_at = now();
  update crm_deals set value_monthly_usd = round(value_monthly * p_usd_per_unit, 2) where currency = upper(trim(p_currency)) and value_monthly is not null;
  return (select coalesce(jsonb_object_agg(currency, usd_per_unit), '{}') from crm_fx_rates);
end $$;

create or replace function crm_set_channel_cost(p_source_channel text, p_month date, p_cost numeric, p_currency text default 'USD', p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ch uuid := crm_resolve_lookup('source_channel', p_source_channel); r crm_channel_costs;
begin
  perform crm_require_member();
  insert into crm_channel_costs(source_channel_id, month, cost, currency, notes) values (ch, date_trunc('month', p_month)::date, p_cost, upper(coalesce(p_currency, 'USD')), p_notes)
    on conflict (source_channel_id, month) do update set cost = excluded.cost, currency = excluded.currency, notes = coalesce(excluded.notes, crm_channel_costs.notes)
    returning * into r;
  return to_jsonb(r);
end $$;

-- ------------------------------------------------------------------ companies / contacts / deals
create or replace function crm_upsert_company(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid; r crm_companies; d text;
begin
  perform crm_require_member();
  cid := case when p ? 'id' and p->>'id' is not null then (p->>'id')::uuid else null end;
  if cid is null then
    d := crm_domain_from_url(coalesce(p->>'website', p->>'domain'));
    if d is not null then select id into cid from crm_companies where domain = d; end if;
    if cid is null and p->>'name' is not null then select id into cid from crm_companies where lower(name) = lower(trim(p->>'name')) limit 1; end if;
  end if;
  if cid is null then
    if nullif(trim(coalesce(p->>'name', '')), '') is null then raise exception 'E_PAYLOAD_INVALID: name is required'; end if;
    insert into crm_companies(name, website, domain, country, timezone, icp_segment_id, source_channel_id, notes)
    values (trim(p->>'name'), p->>'website', d, p->>'country', p->>'timezone',
            crm_resolve_lookup('icp_segment', coalesce(p->>'icp_segment', p->>'icp_segment_id')),
            crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id')), p->>'notes')
    returning * into r;
  else
    update crm_companies set
      name = coalesce(nullif(trim(p->>'name'), ''), name),
      website = case when p ? 'website' then p->>'website' else website end,
      country = case when p ? 'country' then p->>'country' else country end,
      timezone = case when p ? 'timezone' then p->>'timezone' else timezone end,
      icp_segment_id = case when p ? 'icp_segment' or p ? 'icp_segment_id' then crm_resolve_lookup('icp_segment', coalesce(p->>'icp_segment', p->>'icp_segment_id')) else icp_segment_id end,
      source_channel_id = case when p ? 'source_channel' or p ? 'source_channel_id' then crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id')) else source_channel_id end,
      notes = case when p ? 'notes' then p->>'notes' when p ? 'append_notes' then concat_ws(E'\n', notes, p->>'append_notes') else notes end
    where id = cid returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function crm_upsert_contact(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid; v_contact_id uuid; r crm_contacts;
begin
  perform crm_require_member();
  v_contact_id := case when p ? 'id' and p->>'id' is not null then (p->>'id')::uuid else null end;
  if v_contact_id is null and p->>'email' is not null then select id into v_contact_id from crm_contacts where lower(email) = lower(trim(p->>'email')); end if;
  if v_contact_id is null then
    cid := crm_resolve_company(p, true);
    if p->>'name' is not null then select id into v_contact_id from crm_contacts where company_id = cid and lower(name) = lower(trim(p->>'name')) limit 1; end if;
  end if;
  if v_contact_id is null then
    if nullif(trim(coalesce(p->>'name', '')), '') is null then raise exception 'E_PAYLOAD_INVALID: name is required'; end if;
    insert into crm_contacts(company_id, name, role, email, phone, linkedin_url, timezone, notes, is_primary)
    values (cid, trim(p->>'name'), p->>'role', nullif(lower(trim(p->>'email')), ''), p->>'phone', p->>'linkedin_url', p->>'timezone', p->>'notes',
            coalesce((p->>'is_primary')::boolean, not exists (select 1 from crm_contacts where company_id = cid)))
    returning * into r;
  else
    update crm_contacts set
      name = coalesce(nullif(trim(p->>'name'), ''), name),
      role = case when p ? 'role' then p->>'role' else role end,
      email = case when p ? 'email' then nullif(lower(trim(p->>'email')), '') else email end,
      phone = case when p ? 'phone' then p->>'phone' else phone end,
      linkedin_url = case when p ? 'linkedin_url' then p->>'linkedin_url' else linkedin_url end,
      timezone = case when p ? 'timezone' then p->>'timezone' else timezone end,
      notes = case when p ? 'notes' then p->>'notes' else notes end,
      is_primary = coalesce((p->>'is_primary')::boolean, is_primary)
    where id = v_contact_id returning * into r;
  end if;
  if r.is_primary then update crm_contacts set is_primary = false where company_id = r.company_id and id <> r.id and is_primary; end if;
  return to_jsonb(r);
end $$;

create or replace function crm_deal_json(p_deal_id uuid) returns jsonb
language sql stable set search_path = public as $$
  select to_jsonb(v) from crm_deals_v v where v.id = p_deal_id;
$$;

create or replace function crm_create_deal(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cid uuid := crm_resolve_company(p, true); r crm_deals;
begin
  perform crm_require_member();
  insert into crm_deals(company_id, title, stage, owner_id, value_monthly, currency, videos_per_month, expected_close_date, next_step, next_step_date, source_channel_id)
  values (cid, p->>'title', coalesce((p->>'stage')::crm_deal_stage_t, 'new'), crm_resolve_member(coalesce(p->>'owner', p->>'owner_id')),
          (p->>'value_monthly')::numeric, upper(coalesce(p->>'currency', crm_setting('default_currency', '"USD"') #>> '{}')), (p->>'videos_per_month')::int,
          (p->>'expected_close_date')::date, p->>'next_step', (p->>'next_step_date')::date,
          crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id')))
  returning * into r;
  return crm_deal_json(r.id);
end $$;

/** Update stage / value / next step. Stage history is written by trigger; a backwards move needs p_reason. */
create or replace function crm_update_deal(p_deal_id uuid, p jsonb, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare before_stage crm_deal_stage_t; r crm_deals;
begin
  perform crm_require_member();
  select stage into before_stage from crm_deals where id = p_deal_id;
  if before_stage is null then raise exception 'E_NOT_FOUND: deal % not found', p_deal_id; end if;
  perform set_config('crm.stage_reason', coalesce(p_reason, ''), true);
  update crm_deals set
    title = case when p ? 'title' then p->>'title' else title end,
    stage = coalesce((p->>'stage')::crm_deal_stage_t, stage),
    owner_id = case when p ? 'owner' or p ? 'owner_id' then crm_resolve_member(coalesce(p->>'owner', p->>'owner_id')) else owner_id end,
    value_monthly = case when p ? 'value_monthly' then (p->>'value_monthly')::numeric else value_monthly end,
    currency = case when p ? 'currency' then upper(p->>'currency') else currency end,
    videos_per_month = case when p ? 'videos_per_month' then (p->>'videos_per_month')::int else videos_per_month end,
    expected_close_date = case when p ? 'expected_close_date' then (p->>'expected_close_date')::date else expected_close_date end,
    next_step = case when p ? 'next_step' then p->>'next_step' else next_step end,
    next_step_date = case when p ? 'next_step_date' then (p->>'next_step_date')::date else next_step_date end,
    lost_reason = case when p ? 'lost_reason' then p->>'lost_reason' else lost_reason end,
    source_channel_id = case when p ? 'source_channel' or p ? 'source_channel_id' then crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id')) else source_channel_id end,
    delivery_project_id = case when p ? 'delivery_project_id' then (p->>'delivery_project_id')::uuid else delivery_project_id end
  where id = p_deal_id returning * into r;
  perform set_config('crm.stage_reason', '', true);
  if r.stage = 'lost' and r.lost_reason is null then
    update crm_deals set lost_reason = coalesce(p_reason, 'not given') where id = p_deal_id returning * into r;
  end if;
  return crm_deal_json(r.id) || jsonb_build_object('stage_changed', r.stage <> before_stage, 'from_stage', before_stage);
end $$;

-- ------------------------------------------------------------------ activities & meetings
create or replace function crm_log_activity(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_contact_id uuid; did uuid; r crm_activities;
begin
  perform crm_require_member();
  v_contact_id := crm_resolve_contact(p, false);
  did := case when p->>'deal_id' is not null then (p->>'deal_id')::uuid else null end;
  if v_contact_id is null and did is null and crm_resolve_company(p, false) is null then
    raise exception 'E_PAYLOAD_INVALID: give contact_id / contact_email / (company + contact_name), or deal_id, or company';
  end if;
  if coalesce(p->>'activity_type', p->>'type') is null then raise exception 'E_PAYLOAD_INVALID: activity_type is required (call, linkedin_message, linkedin_connect, email, meeting, …)'; end if;
  insert into crm_activities(contact_id, company_id, deal_id, activity_type_id, direction, occurred_at, source_channel_id, body, outcome, owner_id, external_ref)
  values (v_contact_id, crm_resolve_company(p, false), did, crm_resolve_lookup('activity_type', coalesce(p->>'activity_type', p->>'type')),
          coalesce((p->>'direction')::crm_direction_t, 'outbound'), coalesce((p->>'occurred_at')::timestamptz, now()),
          crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id')), p->>'body', p->>'outcome',
          crm_resolve_member(coalesce(p->>'owner', p->>'owner_id')), p->>'external_ref')
  on conflict (external_ref) where external_ref is not null do update set body = excluded.body, outcome = excluded.outcome
  returning * into r;
  return (select to_jsonb(v) from crm_activities_v v where v.id = r.id);
end $$;

create or replace function crm_schedule_meeting(p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare did uuid; v_contact_id uuid; cid uuid; r crm_meetings;
begin
  perform crm_require_member();
  if p->>'scheduled_at' is null then raise exception 'E_PAYLOAD_INVALID: scheduled_at (ISO timestamp) is required'; end if;
  did := case when p->>'deal_id' is not null then (p->>'deal_id')::uuid else null end;
  v_contact_id := crm_resolve_contact(p, false);
  if did is null then
    cid := coalesce((select company_id from crm_contacts where id = v_contact_id), crm_resolve_company(p, false));
    if cid is null then raise exception 'E_PAYLOAD_INVALID: deal_id, or a contact/company with an open deal, is required'; end if;
    select id into did from crm_deals where company_id = cid and stage not in ('won','lost') order by created_at desc limit 1;
    if did is null then
      insert into crm_deals(company_id, owner_id) values (cid, auth.uid()) returning id into did;
    end if;
  end if;
  if v_contact_id is null then select id into v_contact_id from crm_contacts where company_id = (select company_id from crm_deals where id = did) order by is_primary desc, created_at limit 1; end if;
  insert into crm_meetings(deal_id, contact_id, scheduled_at, timezone, duration_min, attendees, notes)
  values (did, v_contact_id, (p->>'scheduled_at')::timestamptz, coalesce(p->>'timezone', (select timezone from crm_contacts where id = v_contact_id)),
          coalesce((p->>'duration_min')::int, 30),
          coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p->'attendees') = 'array' then p->'attendees' else '[]'::jsonb end) x), '{}'),
          p->>'notes')
  returning * into r;
  return (select to_jsonb(v) from crm_meetings_v v where v.id = r.id);
end $$;

create or replace function crm_update_meeting(p_meeting_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r crm_meetings;
begin
  perform crm_require_member();
  update crm_meetings set
    scheduled_at = coalesce((p->>'scheduled_at')::timestamptz, scheduled_at),
    timezone = case when p ? 'timezone' then p->>'timezone' else timezone end,
    duration_min = coalesce((p->>'duration_min')::int, duration_min),
    contact_id = case when p ? 'contact_id' then (p->>'contact_id')::uuid else contact_id end,
    attendees = case when jsonb_typeof(p->'attendees') = 'array' then (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(p->'attendees') x) else attendees end,
    notes = case when p ? 'notes' then p->>'notes' else notes end,
    status = coalesce((p->>'status')::crm_meeting_status_t, status)   -- held/no_show are rejected by trigger without a capture
  where id = p_meeting_id returning * into r;
  if r.id is null then raise exception 'E_NOT_FOUND: meeting % not found', p_meeting_id; end if;
  return (select to_jsonb(v) from crm_meetings_v v where v.id = r.id);
end $$;

/** THE main write. Rejects with the exact missing fields instead of writing a partial row. */
create or replace function crm_capture_meeting(p_meeting_id uuid, p_outcome text, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare oc crm_capture_outcome_t; missing text[]; cap crm_meeting_captures; m record; tags text[]; t text; tid uuid; pp text; i int;
begin
  perform crm_require_member();
  if p_outcome not in ('held','no_show') then raise exception 'E_PAYLOAD_INVALID: outcome must be held or no_show (cancel a meeting with update_meeting status=cancelled)'; end if;
  oc := p_outcome::crm_capture_outcome_t;
  select * into m from crm_meetings where id = p_meeting_id;
  if m is null then raise exception 'E_NOT_FOUND: meeting % not found', p_meeting_id; end if;
  if exists (select 1 from crm_meeting_captures where meeting_id = p_meeting_id) then
    raise exception 'E_ALREADY_CAPTURED: meeting % already has a capture; use update_capture to change it', p_meeting_id;
  end if;
  missing := crm_capture_missing(oc, p);
  if array_length(missing, 1) > 0 then
    raise exception 'E_CAPTURE_INCOMPLETE: cannot save a % capture — missing: %', oc, array_to_string(missing, '; ');
  end if;
  insert into crm_meeting_captures(meeting_id, outcome, pain_points, commercials_discussed, objections, next_step, next_step_date, is_dead, dead_reason,
                                   no_show_reason, follow_up_action, follow_up_date, raw_notes)
  values (p_meeting_id, oc,
          coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p->'pain_points') = 'array' then p->'pain_points' else '[]'::jsonb end) x where trim(x) <> ''), '{}'),
          p->'commercials_discussed',
          coalesce((select array_agg(x) from jsonb_array_elements_text(case when jsonb_typeof(p->'objections') = 'array' then p->'objections' else '[]'::jsonb end) x where trim(x) <> ''), '{}'),
          p->>'next_step', (p->>'next_step_date')::date, coalesce((p->>'is_dead')::boolean, false), p->>'dead_reason',
          p->>'no_show_reason', p->>'follow_up_action', (p->>'follow_up_date')::date, p->>'raw_notes')
  returning * into cap;

  -- Pain points tokenise into tags: explicit `tags` win, otherwise each pain point becomes a tag (slugified, ≤60 chars)
  if jsonb_typeof(p->'tags') = 'array' then
    select array_agg(x) into tags from jsonb_array_elements_text(p->'tags') x where trim(x) <> '';
  end if;
  if tags is null then tags := cap.pain_points; end if;
  i := 0;
  foreach t in array coalesce(tags, '{}') loop
    i := i + 1;
    if crm_slugify(left(t, 60)) = '' then continue; end if;
    insert into crm_pain_point_tags(slug, label) values (crm_slugify(left(t, 60)), left(trim(t), 80))
      on conflict (slug) do update set label = crm_pain_point_tags.label returning id into tid;
    pp := case when jsonb_typeof(p->'tags') = 'array' then null else t end;
    insert into crm_capture_pain_tags(capture_id, tag_id, verbatim) values (cap.id, tid, pp) on conflict do nothing;
  end loop;

  return jsonb_build_object(
    'capture', to_jsonb(cap),
    'meeting', (select to_jsonb(v) from crm_meetings_v v where v.id = p_meeting_id),
    'deal', crm_deal_json(m.deal_id),
    'tags', (select coalesce(jsonb_agg(jsonb_build_object('slug', pt.slug, 'label', pt.label)), '[]') from crm_capture_pain_tags cpt join crm_pain_point_tags pt on pt.id = cpt.tag_id where cpt.capture_id = cap.id)
  );
end $$;

create or replace function crm_update_capture(p_meeting_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare cap crm_meeting_captures;
begin
  perform crm_require_member();
  update crm_meeting_captures set
    pain_points = case when jsonb_typeof(p->'pain_points') = 'array' then (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(p->'pain_points') x) else pain_points end,
    commercials_discussed = case when p ? 'commercials_discussed' then p->'commercials_discussed' else commercials_discussed end,
    objections = case when jsonb_typeof(p->'objections') = 'array' then (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(p->'objections') x) else objections end,
    next_step = case when p ? 'next_step' then p->>'next_step' else next_step end,
    next_step_date = case when p ? 'next_step_date' then (p->>'next_step_date')::date else next_step_date end,
    is_dead = coalesce((p->>'is_dead')::boolean, is_dead),
    dead_reason = case when p ? 'dead_reason' then p->>'dead_reason' else dead_reason end,
    no_show_reason = case when p ? 'no_show_reason' then p->>'no_show_reason' else no_show_reason end,
    follow_up_action = case when p ? 'follow_up_action' then p->>'follow_up_action' else follow_up_action end,
    follow_up_date = case when p ? 'follow_up_date' then (p->>'follow_up_date')::date else follow_up_date end,
    raw_notes = case when p ? 'raw_notes' then p->>'raw_notes' else raw_notes end
  where meeting_id = p_meeting_id returning * into cap;
  if cap.id is null then raise exception 'E_NOT_FOUND: no capture for meeting %', p_meeting_id; end if;
  return to_jsonb(cap);
end $$;

-- ------------------------------------------------------------------ transcripts (call recordings)
-- Speaker indexes are 0-based (Deepgram); the default label is "Speaker N+1", the way the get-transcript pack prints it.
create or replace function crm_transcript_label(p_speakers jsonb, p_speaker int) returns text
language sql immutable as $$
  select case when p_speaker is null then 'Speaker'
              else coalesce((select nullif(trim(s->>'label'), '') from jsonb_array_elements(coalesce(p_speakers, '[]'::jsonb)) s where (s->>'speaker')::int = p_speaker limit 1),
                            'Speaker ' || (p_speaker + 1)) end;
$$;

create or replace function crm_transcript_text(p_turns jsonb, p_speakers jsonb) returns text
language sql immutable as $$
  select coalesce(string_agg(crm_transcript_label(p_speakers, nullif(t.v->>'speaker', '')::int) || ': ' || (t.v->>'text'), E'\n' order by t.ord), '')
  from jsonb_array_elements(coalesce(p_turns, '[]'::jsonb)) with ordinality t(v, ord);
$$;

-- Everything about a transcript except the turns. Security INVOKER on purpose: called directly it is RLS-scoped (members only).
create or replace function crm_transcript_json(p_meeting_id uuid) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'meeting_id', tr.meeting_id, 'company', mv.company_name, 'company_id', mv.company_id, 'contact', mv.contact_name, 'scheduled_at', mv.scheduled_at, 'meeting_status', mv.status,
    'summary', tr.summary, 'topics', to_jsonb(tr.topics), 'language', tr.language, 'duration_seconds', tr.duration_seconds, 'word_count', tr.word_count,
    'avg_confidence', tr.avg_confidence, 'low_confidence', tr.low_confidence, 'speakers', tr.speakers, 'turn_count', jsonb_array_length(tr.turns),
    'source', tr.source, 'engine', tr.engine, 'model', tr.model, 'saved_by', mem.display_name, 'created_at', tr.created_at, 'updated_at', tr.updated_at,
    'has_recording', mv.has_recording, 'has_coaching', mv.has_coaching)
  from crm_meeting_transcripts tr join crm_meetings_v mv on mv.id = tr.meeting_id left join crm_members mem on mem.user_id = tr.created_by
  where tr.meeting_id = p_meeting_id;
$$;

-- A member mints a one-time ticket (the connector makes the token and passes only its SHA-256); a script then posts the
-- transcript with it. 30 minutes, single use, bound to one meeting.
create or replace function crm_transcript_ticket(p_meeting_id uuid, p_token_sha256 text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare exp timestamptz := now() + interval '30 minutes';
begin
  perform crm_require_member();
  if p_token_sha256 is null or p_token_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'E_PAYLOAD_INVALID: token hash must be 64 lowercase hex characters'; end if;
  if not exists (select 1 from crm_meetings where id = p_meeting_id) then raise exception 'E_NOT_FOUND: meeting % not found', p_meeting_id; end if;
  delete from crm_upload_tickets where expires_at < now() - interval '1 day';
  insert into crm_upload_tickets(token_sha256, user_id, meeting_id, expires_at) values (p_token_sha256, auth.uid(), p_meeting_id, exp);
  return jsonb_build_object('meeting_id', p_meeting_id, 'expires_at', exp);
end $$;

-- Save (or replace) a meeting's transcript. Two ways in, one write path:
--   member:  crm_save_transcript(meeting_id, p)                — /crm screens and the connector's save_transcript tool
--   ticket:  crm_save_transcript(null, p, sha256(token))       — the connector's upload endpoint; the ticket IS the authority
-- p = {turns:[{speaker,start,end,text}], speakers:[{speaker,label,role,contact_id?,member_id?,words?,share_of_words?,speaking_seconds?}],
--      summary, topics[], language, duration_seconds, word_count, avg_confidence, low_confidence[], source, engine, model}
create or replace function crm_save_transcript(p_meeting_id uuid, p jsonb, p_ticket_sha256 text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; mid uuid := p_meeting_id; tk crm_upload_tickets; m crm_meetings; v_turns jsonb; v_speakers jsonb; n int; chars bigint; num_re constant text := '^\d+(\.\d+)?$';
begin
  if p_ticket_sha256 is null then
    perform crm_require_member();
    uid := auth.uid();
  else
    -- a rejected payload rolls this back too, so a failed upload can be retried with the same ticket
    update crm_upload_tickets set used_at = now() where token_sha256 = p_ticket_sha256 and used_at is null and expires_at > now() returning * into tk;
    if tk.token_sha256 is null then raise exception 'E_UNAUTHORIZED: upload ticket is invalid, expired or already used — get a new one with transcript_upload_ticket'; end if;
    if not exists (select 1 from crm_members where user_id = tk.user_id and is_active) then raise exception 'E_FORBIDDEN: the ticket owner is no longer on the CRM team'; end if;
    uid := tk.user_id; mid := tk.meeting_id;
  end if;
  select * into m from crm_meetings where id = mid;
  if m.id is null then raise exception 'E_NOT_FOUND: meeting % not found', mid; end if;
  if p is null or jsonb_typeof(p->'turns') is distinct from 'array' then raise exception 'E_PAYLOAD_INVALID: turns must be an array of {speaker, start, end, text}'; end if;

  -- w = word timings, one [start, end] per whitespace token of the text (the app highlights and seeks by word). Kept only
  -- when it lines up with the text exactly; otherwise dropped and the app estimates from the turn's start/end.
  select coalesce(jsonb_agg(jsonb_build_object('speaker', sp, 'start', st, 'end', en, 'text', tx)
                            || case when w is not null then jsonb_build_object('w', w) else '{}'::jsonb end order by ord), '[]'::jsonb),
         count(*), coalesce(sum(length(tx)), 0)
    into v_turns, n, chars
  from (select ord, sp, st, en, tx,
               case when jsonb_typeof(wr) = 'array' and jsonb_array_length(wr) = cardinality(regexp_split_to_array(tx, '\s+'))
                     and not exists (select 1 from jsonb_array_elements(wr) e
                                     where case when jsonb_typeof(e) <> 'array' then true
                                                else jsonb_array_length(e) <> 2 or jsonb_typeof(e->0) <> 'number' or jsonb_typeof(e->1) <> 'number' end)
                    then (select jsonb_agg(jsonb_build_array(round((e->>0)::numeric, 2), round((e->>1)::numeric, 2)) order by o) from jsonb_array_elements(wr) with ordinality q(e, o)) end as w
        from (select ord, case when (t->>'speaker') ~ '^\d+$' then (t->>'speaker')::int end as sp,
                     case when (t->>'start') ~ num_re then round((t->>'start')::numeric, 2) end as st,
                     case when (t->>'end') ~ num_re then round((t->>'end')::numeric, 2) end as en,
                     trim(t->>'text') as tx, t->'w' as wr
              from jsonb_array_elements(p->'turns') with ordinality x(t, ord)) y
        where tx is not null and tx <> '') z;
  if n = 0 then raise exception 'E_PAYLOAD_INVALID: turns has no text'; end if;
  if n > 6000 or chars > 1500000 then raise exception 'E_PAYLOAD_INVALID: transcript too large (% turns, % characters; max 6000 turns / 1.5M characters)', n, chars; end if;

  -- speakers = what the caller named + any index that speaks in the turns and was not named
  with given as (
    select distinct on (sp) sp, s from (select case when (s->>'speaker') ~ '^\d+$' then (s->>'speaker')::int end as sp, s
                                         from jsonb_array_elements(case when jsonb_typeof(p->'speakers') = 'array' then p->'speakers' else '[]'::jsonb end) s) g
    where sp is not null order by sp
  ), seen as (
    select distinct (t->>'speaker')::int as sp from jsonb_array_elements(v_turns) t where t->>'speaker' is not null
  ), allsp as (select sp from given union select sp from seen)
  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
           'speaker', a.sp,
           'label', coalesce(nullif(trim(g.s->>'label'), ''), 'Speaker ' || (a.sp + 1)),
           'role', case when g.s->>'role' in ('prospect', 'team') then g.s->>'role' else 'unknown' end,
           'contact_id', case when crm_is_uuid(g.s->>'contact_id') then g.s->>'contact_id' end,
           'member_id', case when crm_is_uuid(g.s->>'member_id') then g.s->>'member_id' end,
           'words', case when (g.s->>'words') ~ '^\d+$' then (g.s->>'words')::int end,
           'share_of_words', case when (g.s->>'share_of_words') ~ num_re then (g.s->>'share_of_words')::numeric end,
           'speaking_seconds', case when (g.s->>'speaking_seconds') ~ num_re then (g.s->>'speaking_seconds')::numeric end)) order by a.sp), '[]'::jsonb)
    into v_speakers
  from allsp a left join given g on g.sp = a.sp;

  -- a lone prospect voice is the meeting's contact; a lone team voice is whoever saved it
  select coalesce(jsonb_agg(case
           when s->>'role' = 'prospect' and not (s ? 'contact_id') and m.contact_id is not null
                and (select count(*) from jsonb_array_elements(v_speakers) x where x->>'role' = 'prospect') = 1 then s || jsonb_build_object('contact_id', m.contact_id)
           when s->>'role' = 'team' and not (s ? 'member_id')
                and (select count(*) from jsonb_array_elements(v_speakers) x where x->>'role' = 'team') = 1 then s || jsonb_build_object('member_id', uid)
           else s end order by (s->>'speaker')::int), '[]'::jsonb)
    into v_speakers
  from jsonb_array_elements(v_speakers) s;

  insert into crm_meeting_transcripts as tr (meeting_id, turns, speakers, full_text, summary, topics, language, duration_seconds, word_count, avg_confidence, low_confidence, source, engine, model, created_by)
  values (mid, v_turns, v_speakers, crm_transcript_text(v_turns, v_speakers), nullif(trim(p->>'summary'), ''),
          coalesce((select array_agg(left(trim(x), 80)) from jsonb_array_elements_text(case when jsonb_typeof(p->'topics') = 'array' then p->'topics' else '[]'::jsonb end) x where trim(x) <> ''), '{}'),
          nullif(trim(p->>'language'), ''),
          case when (p->>'duration_seconds') ~ num_re then round((p->>'duration_seconds')::numeric, 2) end,
          coalesce(case when (p->>'word_count') ~ '^\d+$' then (p->>'word_count')::int end,
                   (select sum(coalesce(array_length(regexp_split_to_array(t->>'text', '\s+'), 1), 0))::int from jsonb_array_elements(v_turns) t)),
          case when (p->>'avg_confidence') ~ num_re and (p->>'avg_confidence')::numeric <= 1 then round((p->>'avg_confidence')::numeric, 4) end,
          coalesce((select jsonb_agg(x order by o) from (select x, o from jsonb_array_elements(case when jsonb_typeof(p->'low_confidence') = 'array' then p->'low_confidence' else '[]'::jsonb end) with ordinality a(x, o) order by o limit 50) lc), '[]'::jsonb),
          left(nullif(trim(p->>'source'), ''), 500), left(nullif(trim(p->>'engine'), ''), 40), left(nullif(trim(p->>'model'), ''), 80), uid)
  on conflict (meeting_id) do update set
    turns = excluded.turns, speakers = excluded.speakers, full_text = excluded.full_text, summary = excluded.summary, topics = excluded.topics, language = excluded.language,
    duration_seconds = excluded.duration_seconds, word_count = excluded.word_count, avg_confidence = excluded.avg_confidence, low_confidence = excluded.low_confidence,
    source = excluded.source, engine = excluded.engine, model = excluded.model, created_by = excluded.created_by;

  return crm_transcript_json(mid);
end $$;

-- Rename speakers / say who is the prospect after the fact (diarization knows voices differ, not who they are).
create or replace function crm_set_transcript_speakers(p_meeting_id uuid, p_speakers jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare tr crm_meeting_transcripts; v_speakers jsonb;
begin
  perform crm_require_member();
  if jsonb_typeof(p_speakers) is distinct from 'array' then raise exception 'E_PAYLOAD_INVALID: speakers must be an array of {speaker, label?, role?, contact_id?, member_id?}'; end if;
  select * into tr from crm_meeting_transcripts where meeting_id = p_meeting_id;
  if tr.id is null then raise exception 'E_NOT_FOUND: no transcript saved for meeting %', p_meeting_id; end if;
  select coalesce(jsonb_agg(jsonb_strip_nulls(s || coalesce((
           select jsonb_build_object(
                    'label', coalesce(nullif(trim(g->>'label'), ''), s->>'label'),
                    'role', case when g->>'role' in ('prospect', 'team', 'unknown') then g->>'role' else s->>'role' end,
                    'contact_id', case when g ? 'contact_id' then (case when crm_is_uuid(g->>'contact_id') then g->>'contact_id' end) else s->>'contact_id' end,
                    'member_id', case when g ? 'member_id' then (case when crm_is_uuid(g->>'member_id') then g->>'member_id' end) else s->>'member_id' end)
           from jsonb_array_elements(p_speakers) g where (g->>'speaker') ~ '^\d+$' and (g->>'speaker')::int = (s->>'speaker')::int limit 1), '{}'::jsonb)) order by (s->>'speaker')::int), '[]'::jsonb)
    into v_speakers
  from jsonb_array_elements(tr.speakers) s;
  update crm_meeting_transcripts set speakers = v_speakers, full_text = crm_transcript_text(turns, v_speakers) where meeting_id = p_meeting_id;
  return crm_transcript_json(p_meeting_id);
end $$;

-- Read a transcript, whole or filtered. p = {q, speaker, role, from_s, to_s, context (turns either side of a match, 0-5), offset, limit,
--   words (true = include each turn's word timings `w`; the app's player wants them, the connector never asks — ~10k pairs an hour)}
create or replace function crm_get_transcript(p_meeting_id uuid, p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tr crm_meeting_transcripts; needle text := lower(nullif(trim(p->>'q'), '')); matched int; res jsonb;
        lim int := least(greatest(coalesce((p->>'limit')::int, 400), 1), 6000); skip int := greatest(coalesce((p->>'offset')::int, 0), 0);
        around int := least(greatest(coalesce((p->>'context')::int, 0), 0), 5); with_words boolean := coalesce((p->>'words')::boolean, false);
begin
  perform crm_require_member();
  select * into tr from crm_meeting_transcripts where meeting_id = p_meeting_id;
  if tr.id is null then raise exception 'E_NOT_FOUND: no transcript saved for meeting %', p_meeting_id; end if;
  with t as (
    select (ord - 1)::int as i, nullif(v->>'speaker', '')::int as sp, (v->>'start')::numeric as st, (v->>'end')::numeric as en, v->>'text' as tx,
           case when with_words then v->'w' end as w
    from jsonb_array_elements(tr.turns) with ordinality x(v, ord)
  ), tt as (
    select t.*, crm_transcript_label(tr.speakers, t.sp) as lbl,
           coalesce((select s->>'role' from jsonb_array_elements(tr.speakers) s where (s->>'speaker')::int = t.sp limit 1), 'unknown') as rl
    from t
  ), hit as (
    select i from tt
    where (needle is null or position(needle in lower(tx)) > 0)
      and (p->>'speaker' is null or sp = (p->>'speaker')::int)
      and (p->>'role' is null or rl = p->>'role')
      and (p->>'from_s' is null or coalesce(en, st, 0) >= (p->>'from_s')::numeric)
      and (p->>'to_s' is null or coalesce(st, 0) <= (p->>'to_s')::numeric)
  ), pick as (
    select distinct tt.i from tt join hit h on tt.i between h.i - around and h.i + around
  ), page as (
    select tt.*, (around > 0 and exists (select 1 from hit h where h.i = tt.i)) as is_match from tt join pick using (i) order by tt.i offset skip limit lim
  )
  select (select count(*) from hit),
         coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object('i', i, 'speaker', sp, 'label', lbl, 'role', rl, 'start', st, 'end', en, 'text', tx, 'w', w, 'match', case when is_match then true end)) order by i) from page), '[]'::jsonb)
    into matched, res;
  return crm_transcript_json(p_meeting_id) || jsonb_build_object('matched_turns', matched, 'returned', jsonb_array_length(res), 'turns', res);
end $$;

-- Transcripts across meetings, newest first. p = {company, q, role, from, to, limit}; with q each row carries up to 5 matching turns.
create or replace function crm_transcripts(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cid uuid; needle text := lower(nullif(trim(p->>'q'), '')); lim int := least(greatest(coalesce((p->>'limit')::int, 20), 1), 100);
begin
  perform crm_require_member();
  if nullif(trim(p->>'company'), '') is not null then cid := crm_resolve_company(jsonb_build_object('company', p->>'company'), true); end if;
  return jsonb_build_object('transcripts', (
    select coalesce(jsonb_agg(row_json order by scheduled_at desc), '[]'::jsonb) from (
      select mv.scheduled_at, jsonb_strip_nulls(crm_transcript_json(tr.meeting_id) - 'low_confidence' || jsonb_build_object('matches', case when needle is not null then (
               select jsonb_agg(jsonb_build_object('i', i, 'label', crm_transcript_label(tr.speakers, sp), 'start', st, 'text', tx) order by i) from (
                 select (ord - 1)::int as i, nullif(v->>'speaker', '')::int as sp, (v->>'start')::numeric as st, v->>'text' as tx
                 from jsonb_array_elements(tr.turns) with ordinality x(v, ord)
                 where position(needle in lower(v->>'text')) > 0
                   and (p->>'role' is null or coalesce((select s->>'role' from jsonb_array_elements(tr.speakers) s where s->>'speaker' = v->>'speaker' limit 1), 'unknown') = p->>'role')
                 order by ord limit 5) hits) end)) as row_json
      from crm_meeting_transcripts tr join crm_meetings_v mv on mv.id = tr.meeting_id
      where (cid is null or mv.company_id = cid)
        and (needle is null or position(needle in lower(tr.full_text)) > 0)
        and (p->>'from' is null or mv.scheduled_at >= (p->>'from')::date)
        and (p->>'to' is null or mv.scheduled_at < ((p->>'to')::date + 1))
      order by mv.scheduled_at desc limit lim) rows_
    where needle is null or p->>'role' is null or row_json ? 'matches'));   -- a role-filtered search only lists meetings where that side said it
end $$;

-- ------------------------------------------------------------------ recordings (call audio in Oracle Object Storage)
-- Is this upload ticket still good? Does NOT consume it: the skill's script uses one ticket first to upload the audio,
-- then to save the transcript — and only that last step burns it.
create or replace function crm_ticket_peek(p_ticket_sha256 text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tk crm_upload_tickets;
begin
  select * into tk from crm_upload_tickets where token_sha256 = p_ticket_sha256 and used_at is null and expires_at > now();
  if tk.token_sha256 is null then raise exception 'E_UNAUTHORIZED: upload ticket is invalid, expired or already used — get a new one with transcript_upload_ticket'; end if;
  if not exists (select 1 from crm_members where user_id = tk.user_id and is_active) then raise exception 'E_FORBIDDEN: the ticket owner is no longer on the CRM team'; end if;
  return jsonb_build_object('user_id', tk.user_id, 'meeting_id', tk.meeting_id, 'expires_at', tk.expires_at);
end $$;

-- Point a meeting at its uploaded audio (member JWT, or an unconsumed ticket). The object must sit under the meeting's own
-- prefix, so a caller can never attach another meeting's file. Returns replaced_key when an older object should be deleted.
-- p = {storage_key, bytes, content_type, duration_seconds, original_name, uploaded_via}
create or replace function crm_save_recording(p_meeting_id uuid, p jsonb, p_ticket_sha256 text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; mid uuid := p_meeting_id; tk jsonb; old_key text; rec crm_meeting_recordings; k text := nullif(trim(p->>'storage_key'), ''); num_re constant text := '^\d+(\.\d+)?$';
begin
  if p_ticket_sha256 is null then
    perform crm_require_member();
    uid := auth.uid();
  else
    tk := crm_ticket_peek(p_ticket_sha256);
    uid := (tk->>'user_id')::uuid; mid := (tk->>'meeting_id')::uuid;
  end if;
  if not exists (select 1 from crm_meetings where id = mid) then raise exception 'E_NOT_FOUND: meeting % not found', mid; end if;
  if k is null or not starts_with(k, 'crm/recordings/' || mid::text || '/') or position('..' in k) > 0 then
    raise exception 'E_PAYLOAD_INVALID: storage_key must be under crm/recordings/%/', mid;
  end if;
  select storage_key into old_key from crm_meeting_recordings where meeting_id = mid;
  insert into crm_meeting_recordings(meeting_id, storage_key, bytes, content_type, duration_seconds, original_name, uploaded_via, created_by)
  values (mid, k, case when (p->>'bytes') ~ '^\d+$' then (p->>'bytes')::bigint end, left(nullif(trim(p->>'content_type'), ''), 120),
          case when (p->>'duration_seconds') ~ num_re then round((p->>'duration_seconds')::numeric, 2) end,
          left(nullif(trim(p->>'original_name'), ''), 300), case when p->>'uploaded_via' in ('app', 'skill') then p->>'uploaded_via' end, uid)
  on conflict (meeting_id) do update set storage_key = excluded.storage_key, bytes = excluded.bytes, content_type = excluded.content_type,
    duration_seconds = excluded.duration_seconds, original_name = excluded.original_name, uploaded_via = excluded.uploaded_via, created_by = excluded.created_by
  returning * into rec;
  return jsonb_strip_nulls(to_jsonb(rec) - 'created_by' || jsonb_build_object('replaced_key', case when old_key is distinct from k then old_key end));
end $$;

create or replace function crm_get_recording(p_meeting_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rec crm_meeting_recordings;
begin
  perform crm_require_member();
  select * into rec from crm_meeting_recordings where meeting_id = p_meeting_id;
  if rec.id is null then raise exception 'E_NOT_FOUND: no recording saved for meeting %', p_meeting_id; end if;
  return jsonb_strip_nulls(to_jsonb(rec) - 'created_by' || jsonb_build_object('uploaded_by', (select display_name from crm_members where user_id = rec.created_by)));
end $$;

-- Removes the pointer and returns the key so the caller (the edge function) can delete the object too.
create or replace function crm_delete_recording(p_meeting_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text;
begin
  perform crm_require_member();
  delete from crm_meeting_recordings where meeting_id = p_meeting_id returning storage_key into k;
  if k is null then raise exception 'E_NOT_FOUND: no recording saved for meeting %', p_meeting_id; end if;
  return jsonb_build_object('meeting_id', p_meeting_id, 'storage_key', k);
end $$;

-- ------------------------------------------------------------------ morning brief
-- ------------------------------------------------------------------ sales coach (per-call coaching analysis)
-- One coaching record per meeting, written by the crm skill after it has read the transcript (crm_save_coaching; saving again
-- replaces it). The rubric is fixed here so every call is scored the same way: 12 criteria (crm_coaching_criteria) rated
-- met | partial | missed | na | insufficient, plus the 4-point Kaptured lens (crm_coaching_lens). Salesperson execution
-- (execution_score, from the criteria) is kept apart from deal readiness (readiness): a great call can rightly find a poor fit.
create or replace function crm_coaching_criteria() returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'buyer_problem',          'label', 'Buyer''s actual problem',       'asks', 'Did the buyer confirm a problem (launch delays, expensive shoots, coordination, creative variety, quality) — or did we assume one?'),
    jsonb_build_object('key', 'discovery_depth',        'label', 'Depth of discovery',           'asks', 'Were the causes, consequences, urgency and desired outcome explored, not just the surface need?'),
    jsonb_build_object('key', 'buyer_awareness',        'label', 'Buyer awareness',              'asks', 'Exploring AI, comparing agencies, replacing a vendor, or ready to commission — and did the pitch adapt to that?'),
    jsonb_build_object('key', 'qualification',          'label', 'Qualification',                'asks', 'Assets, quantities, usage, deadlines, budget, decision-makers, approval process, quality requirements: confirmed, unclear or not discussed?'),
    jsonb_build_object('key', 'pitch_relevance',        'label', 'Pitch relevance',              'asks', 'Did the examples and explanation address the buyer''s stated problem?'),
    jsonb_build_object('key', 'features_to_value',      'label', 'Features became business value', 'asks', 'Were speed, volume, resolution and variations tied to outcomes the buyer needs (SKUs, channels, launches, testing)?'),
    jsonb_build_object('key', 'tech_talk',              'label', 'Technology talk in proportion', 'asks', 'Did model names and generation techniques displace accuracy, consistency, service and delivery?'),
    jsonb_build_object('key', 'proof',                  'label', 'Proof and credibility',        'asks', 'Were relevant examples, client results, the review process or a suitable pilot used to answer concerns?'),
    jsonb_build_object('key', 'objections',             'label', 'Objection handling',           'asks', 'Was each concern clarified, answered and checked again — or discounted / talked past?'),
    jsonb_build_object('key', 'interest',               'label', 'Interest vs politeness',       'asks', 'Did the buyer articulate value, discuss implementation or commit — and did we test that, or accept "looks nice"?'),
    jsonb_build_object('key', 'recommendation_pricing', 'label', 'Recommendation and pricing',   'asks', 'Was the scope justified by the buyer''s requirements, and was interest established before the price?'),
    jsonb_build_object('key', 'closing',                'label', 'Closing quality',              'asks', 'Was there an explicit ask and an agreed next step with an owner and a date?')
  );
$$;

create or replace function crm_coaching_lens() returns jsonb
language sql immutable as $$
  select jsonb_build_array(
    jsonb_build_object('key', 'understood_needs',  'label', 'Understood the brand''s needs'),
    jsonb_build_object('key', 'relevant_value',    'label', 'Demonstrated relevant value'),
    jsonb_build_object('key', 'quality_concerns',  'label', 'Addressed quality concerns'),
    jsonb_build_object('key', 'next_step',         'label', 'Secured a clear next step')
  );
$$;

create or replace function crm_coaching_json(p_meeting_id uuid) returns jsonb
language sql stable set search_path = public as $$
  select (to_jsonb(cc) - 'id' - 'created_by') || jsonb_build_object(
    'company', mv.company_name, 'company_id', mv.company_id, 'contact', mv.contact_name, 'scheduled_at', mv.scheduled_at, 'meeting_status', mv.status,
    'deal_id', mv.deal_id, 'deal_stage', mv.deal_stage, 'owner', om.display_name, 'owner_id', mv.owner_id,
    'has_transcript', mv.has_transcript, 'has_recording', mv.has_recording, 'duration_seconds', tr.duration_seconds, 'saved_by', mem.display_name)
  from crm_call_coaching cc
  join crm_meetings_v mv on mv.id = cc.meeting_id
  left join crm_meeting_transcripts tr on tr.meeting_id = cc.meeting_id
  left join crm_members mem on mem.user_id = cc.created_by
  left join crm_members om on om.user_id = mv.owner_id
  where cc.meeting_id = p_meeting_id;
$$;

-- p = {purpose, summary*, lens*[4], criteria*[12], buyer_brief, qualification[], what_worked[], biggest_miss, priorities*[1..3], moments[],
--      uncertainties[], next_action*{what*, why, commitment, before, questions[], proof[], draft{channel, text}}, practice, readiness*{stage*, interest, summary, blockers[]},
--      limits[], context_used{}, model}. Evidence everywhere is [{t: seconds, speaker: prospect|team, quote}] so the app can play the moment.
create or replace function crm_save_coaching(p_meeting_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare m crm_meetings; keys text[]; seen text[] := '{}'; c jsonb; k text; r text; lbl text;
        n_met int := 0; n_partial int := 0; n_missed int := 0; n_na int := 0; n_ins int := 0;
        v_criteria jsonb := '[]'::jsonb; v_lens jsonb := '[]'::jsonb; score int; npri int; existed boolean; row_ crm_call_coaching;
        arr_keys constant text[] := array['qualification', 'what_worked', 'priorities', 'moments', 'uncertainties', 'limits'];
begin
  perform crm_require_member();
  select * into m from crm_meetings where id = p_meeting_id;
  if m.id is null then raise exception 'E_NOT_FOUND: meeting % not found', p_meeting_id; end if;
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'E_PAYLOAD_INVALID: coaching payload must be an object'; end if;
  if nullif(trim(p->>'summary'), '') is null then raise exception 'E_PAYLOAD_INVALID: summary (what happened on the call, 2–4 lines) is required'; end if;
  foreach k in array arr_keys loop
    if p ? k and jsonb_typeof(p->k) <> 'array' then raise exception 'E_PAYLOAD_INVALID: % must be an array', k; end if;
  end loop;

  -- criteria: every canonical key exactly once, each with a rating; met / partial need evidence (timestamp + excerpt)
  if jsonb_typeof(p->'criteria') is distinct from 'array' then raise exception 'E_PAYLOAD_INVALID: criteria must be an array of {key, rating, finding, evidence[], better}'; end if;
  select array_agg(x->>'key' order by ord) into keys from jsonb_array_elements(crm_coaching_criteria()) with ordinality x(x, ord);
  for c in select * from jsonb_array_elements(p->'criteria') loop
    k := c->>'key'; r := c->>'rating';
    if k is null or not (k = any(keys)) then raise exception 'E_PAYLOAD_INVALID: unknown criterion key "%" — use: %', coalesce(k, '(none)'), array_to_string(keys, ', '); end if;
    if k = any(seen) then raise exception 'E_PAYLOAD_INVALID: criterion % given twice', k; end if;
    if r is null or r not in ('met', 'partial', 'missed', 'na', 'insufficient') then raise exception 'E_PAYLOAD_INVALID: criterion % rating must be met | partial | missed | na | insufficient', k; end if;
    if r in ('met', 'partial') and (jsonb_typeof(c->'evidence') is distinct from 'array' or jsonb_array_length(c->'evidence') = 0) then
      raise exception 'E_PAYLOAD_INVALID: criterion % is rated % but has no evidence — add [{t, speaker, quote}] from the transcript, or rate it insufficient', k, r;
    end if;
    if nullif(trim(c->>'finding'), '') is null then raise exception 'E_PAYLOAD_INVALID: criterion % needs a finding (one or two sentences)', k; end if;
    seen := seen || k;
    case r when 'met' then n_met := n_met + 1; when 'partial' then n_partial := n_partial + 1; when 'missed' then n_missed := n_missed + 1; when 'na' then n_na := n_na + 1; else n_ins := n_ins + 1; end case;
    select x->>'label' into lbl from jsonb_array_elements(crm_coaching_criteria()) x where x->>'key' = k;
    v_criteria := v_criteria || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('key', k, 'label', lbl, 'rating', r, 'finding', c->>'finding', 'better', c->>'better', 'evidence', coalesce(c->'evidence', '[]'::jsonb))));
  end loop;
  if array_length(seen, 1) is distinct from array_length(keys, 1) then
    raise exception 'E_PAYLOAD_INVALID: every criterion must be rated (use na or insufficient when it does not apply) — missing: %', array_to_string((select array_agg(x) from unnest(keys) x where not (x = any(seen))), ', ');
  end if;
  score := case when n_met + n_partial + n_missed > 0 then round(100.0 * (n_met + 0.5 * n_partial) / (n_met + n_partial + n_missed))::int end;

  -- lens: the four Kaptured questions, same ratings
  if jsonb_typeof(p->'lens') is distinct from 'array' then raise exception 'E_PAYLOAD_INVALID: lens must rate the 4 Kaptured questions [{key, rating, note}]: understood_needs, relevant_value, quality_concerns, next_step'; end if;
  seen := '{}';
  for c in select * from jsonb_array_elements(p->'lens') loop
    k := c->>'key'; r := c->>'rating';
    select x->>'label' into lbl from jsonb_array_elements(crm_coaching_lens()) x where x->>'key' = k;
    if lbl is null then raise exception 'E_PAYLOAD_INVALID: unknown lens key "%" — use understood_needs, relevant_value, quality_concerns, next_step', coalesce(k, '(none)'); end if;
    if k = any(seen) then raise exception 'E_PAYLOAD_INVALID: lens % given twice', k; end if;
    if r is null or r not in ('met', 'partial', 'missed', 'na', 'insufficient') then raise exception 'E_PAYLOAD_INVALID: lens % rating must be met | partial | missed | na | insufficient', k; end if;
    seen := seen || k;
    v_lens := v_lens || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object('key', k, 'label', lbl, 'rating', r, 'note', c->>'note')));
  end loop;
  if array_length(seen, 1) is distinct from 4 then raise exception 'E_PAYLOAD_INVALID: all 4 lens questions must be rated (understood_needs, relevant_value, quality_concerns, next_step)'; end if;

  npri := coalesce(jsonb_array_length(p->'priorities'), 0);
  if npri < 1 or npri > 3 then raise exception 'E_PAYLOAD_INVALID: priorities must hold 1 to 3 improvements [{title, why, t}] — the full analysis belongs in criteria and moments, not here'; end if;
  if nullif(trim(p->'next_action'->>'what'), '') is null then raise exception 'E_PAYLOAD_INVALID: next_action.what is required ({what, why, commitment, before, questions[], proof[], draft{channel, text}})'; end if;
  if coalesce(p->'readiness'->>'stage', '') not in ('not_a_fit', 'early', 'price_blocked', 'advancing', 'ready', 'unknown') then
    raise exception 'E_PAYLOAD_INVALID: readiness.stage must be one of not_a_fit | early | price_blocked | advancing | ready | unknown';
  end if;
  if coalesce(p->'readiness'->>'interest', 'unknown') not in ('polite', 'interested', 'committed', 'unknown') then
    raise exception 'E_PAYLOAD_INVALID: readiness.interest must be polite | interested | committed | unknown';
  end if;

  existed := exists (select 1 from crm_call_coaching where meeting_id = p_meeting_id);
  insert into crm_call_coaching (meeting_id, purpose, summary, lens, criteria, buyer_brief, qualification, what_worked, biggest_miss, priorities, moments, uncertainties,
                                 next_action, practice, readiness, limits, context_used, execution_score, counts, model, created_by)
  values (p_meeting_id, nullif(trim(p->>'purpose'), ''), trim(p->>'summary'), v_lens, v_criteria,
          coalesce(p->'buyer_brief', '{}'::jsonb), coalesce(p->'qualification', '[]'::jsonb), coalesce(p->'what_worked', '[]'::jsonb), p->'biggest_miss', p->'priorities',
          coalesce(p->'moments', '[]'::jsonb), coalesce(p->'uncertainties', '[]'::jsonb), p->'next_action', p->'practice',
          p->'readiness' || jsonb_build_object('interest', coalesce(p->'readiness'->>'interest', 'unknown')),
          coalesce((select array_agg(x) from jsonb_array_elements_text(p->'limits') x), '{}'), coalesce(p->'context_used', '{}'::jsonb),
          score, jsonb_build_object('met', n_met, 'partial', n_partial, 'missed', n_missed, 'na', n_na, 'insufficient', n_ins), nullif(trim(p->>'model'), ''), auth.uid())
  on conflict (meeting_id) do update set
    purpose = excluded.purpose, summary = excluded.summary, lens = excluded.lens, criteria = excluded.criteria, buyer_brief = excluded.buyer_brief, qualification = excluded.qualification,
    what_worked = excluded.what_worked, biggest_miss = excluded.biggest_miss, priorities = excluded.priorities, moments = excluded.moments, uncertainties = excluded.uncertainties,
    next_action = excluded.next_action, practice = excluded.practice, readiness = excluded.readiness, limits = excluded.limits, context_used = excluded.context_used,
    execution_score = excluded.execution_score, counts = excluded.counts, model = excluded.model, created_by = excluded.created_by,
    version = crm_call_coaching.version + 1, updated_at = now()
  returning * into row_;
  return jsonb_build_object('meeting_id', p_meeting_id, 'company', (select company_name from crm_meetings_v where id = p_meeting_id), 'replaced', existed, 'version', row_.version,
                            'execution_score', row_.execution_score, 'counts', row_.counts, 'readiness', row_.readiness,
                            'priorities', (select jsonb_agg(x->>'title') from jsonb_array_elements(row_.priorities) x),
                            'biggest_miss', row_.biggest_miss->>'title', 'next_action', row_.next_action->>'what');
end $$;

create or replace function crm_get_coaching(p_meeting_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r jsonb;
begin
  perform crm_require_member();
  r := crm_coaching_json(p_meeting_id);
  if r is null then raise exception 'E_NOT_FOUND: no coaching saved for meeting % (the crm skill writes one from the transcript with save_call_coaching)', p_meeting_id; end if;
  return r;
end $$;

create or replace function crm_delete_coaching(p_meeting_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform crm_require_member();
  delete from crm_call_coaching where meeting_id = p_meeting_id; get diagnostics n = row_count;
  if n = 0 then raise exception 'E_NOT_FOUND: no coaching saved for meeting %', p_meeting_id; end if;
  return jsonb_build_object('meeting_id', p_meeting_id, 'deleted', true);
end $$;

-- Every coached call plus what repeats across them. p = {company, owner, from, to, limit}. `rollup.criteria` counts each rating per
-- criterion over the filtered calls (a criterion that is mostly missed is the process weakness to fix); `uncoached` lists meetings
-- that have a transcript but no coaching yet, so the team can ask Claude to coach them.
create or replace function crm_coaching_list(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cid uuid; oid uuid; lim int := least(greatest(coalesce((p->>'limit')::int, 50), 1), 200); f_from date := (p->>'from')::date; f_to date := (p->>'to')::date;
begin
  perform crm_require_member();
  if nullif(trim(p->>'company'), '') is not null then cid := crm_resolve_company(jsonb_build_object('company', p->>'company'), true); end if;
  if nullif(trim(p->>'owner'), '') is not null then oid := crm_resolve_member(p->>'owner'); end if;
  return (
    with base as (
      select cc.meeting_id, cc.purpose, cc.summary, cc.lens, cc.criteria, cc.biggest_miss, cc.priorities, cc.readiness, cc.next_action, cc.execution_score, cc.counts, cc.version, cc.updated_at,
             mv.company_name, mv.company_id, mv.contact_name, mv.scheduled_at, mv.owner_id, mv.deal_id, mv.deal_stage, om.display_name as owner_name, mv.has_transcript, mv.has_recording, tr.duration_seconds
      from crm_call_coaching cc
      join crm_meetings_v mv on mv.id = cc.meeting_id
      left join crm_meeting_transcripts tr on tr.meeting_id = cc.meeting_id
      left join crm_members om on om.user_id = mv.owner_id
      where (cid is null or mv.company_id = cid) and (oid is null or mv.owner_id = oid)
        and (f_from is null or mv.scheduled_at >= f_from) and (f_to is null or mv.scheduled_at < f_to + 1)
    )
    select jsonb_build_object(
      'total', (select count(*) from base),
      'avg_score', (select round(avg(execution_score))::int from base),
      'calls', (select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                  'meeting_id', b.meeting_id, 'company', b.company_name, 'company_id', b.company_id, 'contact', b.contact_name, 'scheduled_at', b.scheduled_at,
                  'owner', b.owner_name, 'owner_id', b.owner_id, 'deal_id', b.deal_id, 'deal_stage', b.deal_stage, 'duration_seconds', b.duration_seconds,
                  'purpose', b.purpose, 'summary', b.summary, 'execution_score', b.execution_score, 'counts', b.counts, 'lens', b.lens, 'readiness', b.readiness,
                  'biggest_miss', b.biggest_miss->>'title', 'priorities', (select jsonb_agg(x->>'title') from jsonb_array_elements(b.priorities) x),
                  'next_action', b.next_action->>'what', 'has_transcript', b.has_transcript, 'has_recording', b.has_recording, 'version', b.version, 'updated_at', b.updated_at)) order by b.scheduled_at desc), '[]'::jsonb)
                from (select * from base order by scheduled_at desc limit lim) b),
      'rollup', jsonb_build_object(
        'criteria', (select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'label', k.label, 'met', s.met, 'partial', s.partial, 'missed', s.missed, 'na', s.na, 'insufficient', s.insufficient) order by k.ord), '[]'::jsonb)
                     from (select x->>'key' as key, x->>'label' as label, ord from jsonb_array_elements(crm_coaching_criteria()) with ordinality x(x, ord)) k
                     left join lateral (
                       select count(*) filter (where c->>'rating' = 'met') as met, count(*) filter (where c->>'rating' = 'partial') as partial, count(*) filter (where c->>'rating' = 'missed') as missed,
                              count(*) filter (where c->>'rating' = 'na') as na, count(*) filter (where c->>'rating' = 'insufficient') as insufficient
                       from base b, jsonb_array_elements(b.criteria) c where c->>'key' = k.key) s on true),
        'lens', (select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'label', k.label, 'met', s.met, 'partial', s.partial, 'missed', s.missed, 'na', s.na, 'insufficient', s.insufficient) order by k.ord), '[]'::jsonb)
                 from (select x->>'key' as key, x->>'label' as label, ord from jsonb_array_elements(crm_coaching_lens()) with ordinality x(x, ord)) k
                 left join lateral (
                   select count(*) filter (where c->>'rating' = 'met') as met, count(*) filter (where c->>'rating' = 'partial') as partial, count(*) filter (where c->>'rating' = 'missed') as missed,
                          count(*) filter (where c->>'rating' = 'na') as na, count(*) filter (where c->>'rating' = 'insufficient') as insufficient
                   from base b, jsonb_array_elements(b.lens) c where c->>'key' = k.key) s on true),
        'readiness', (select coalesce(jsonb_object_agg(st, n), '{}'::jsonb) from (select readiness->>'stage' as st, count(*) as n from base group by 1) x),
        'by_owner', (select coalesce(jsonb_agg(jsonb_build_object('owner', owner_name, 'owner_id', owner_id, 'calls', n, 'avg_score', s) order by n desc), '[]'::jsonb)
                     from (select owner_name, owner_id, count(*) as n, round(avg(execution_score))::int as s from base group by 1, 2) x)),
      'uncoached', (select coalesce(jsonb_agg(jsonb_build_object('meeting_id', mv.id, 'company', mv.company_name, 'company_id', mv.company_id, 'contact', mv.contact_name, 'scheduled_at', mv.scheduled_at, 'owner', om.display_name) order by mv.scheduled_at desc), '[]'::jsonb)
                    from (select * from crm_meetings_v mv2
                          where mv2.has_transcript and not exists (select 1 from crm_call_coaching cc where cc.meeting_id = mv2.id)
                            and (cid is null or mv2.company_id = cid) and (oid is null or mv2.owner_id = oid)
                            and (f_from is null or mv2.scheduled_at >= f_from) and (f_to is null or mv2.scheduled_at < f_to + 1)
                          order by mv2.scheduled_at desc limit 50) mv
                    left join crm_members om on om.user_id = mv.owner_id)
    ));
end $$;

create or replace function crm_whos_meeting_today(p_date date default null, p_tz text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := coalesce(p_tz, crm_tz()); d date := coalesce(p_date, (now() at time zone coalesce(p_tz, crm_tz()))::date); w record;
begin
  perform crm_require_member();
  select * into w from crm_day_window(d, tz);
  return jsonb_build_object(
    'date', d, 'timezone', tz,
    'meetings', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'meeting_id', mv.id, 'scheduled_at', mv.scheduled_at, 'local_time', to_char(mv.scheduled_at at time zone tz, 'HH24:MI'),
        'prospect_local_time', case when mv.timezone is not null then to_char(mv.scheduled_at at time zone mv.timezone, 'HH24:MI') || ' ' || mv.timezone end,
        'status', mv.status, 'has_capture', mv.has_capture, 'attendees', mv.attendees, 'meeting_notes', mv.notes,
        'company', jsonb_build_object('id', c.id, 'name', c.name, 'domain', c.domain, 'country', c.country, 'notes', c.notes),
        'contact', case when mv.contact_id is null then null else jsonb_build_object('id', mv.contact_id, 'name', mv.contact_name, 'role', mv.contact_role, 'email', mv.contact_email) end,
        'icp_segment', mv.icp_segment_label, 'source_channel', mv.source_channel_label,
        'deal', jsonb_build_object('id', dv.id, 'stage', dv.stage, 'value_monthly', dv.value_monthly, 'currency', dv.currency, 'value_monthly_usd', dv.value_monthly_usd,
                                   'videos_per_month', dv.videos_per_month, 'owner', dv.owner_name, 'next_step', dv.next_step, 'next_step_date', dv.next_step_date, 'days_in_stage', dv.days_in_stage),
        'prior_no_shows', (select count(*) from crm_meetings pm where pm.id <> mv.id and pm.status = 'no_show' and (pm.contact_id = mv.contact_id or pm.deal_id = mv.deal_id)),
        'activity_history', (
          select coalesce(jsonb_agg(jsonb_build_object('at', a.occurred_at, 'type', a.activity_type_label, 'direction', a.direction, 'channel', a.source_channel_label, 'outcome', a.outcome, 'body', a.body, 'by', a.owner_name) order by a.occurred_at desc), '[]')
          from crm_activities_v a where (mv.contact_id is not null and a.contact_id = mv.contact_id) or (mv.contact_id is null and a.deal_id = mv.deal_id)),
        'last_capture', (
          select to_jsonb(cp) - 'id' - 'meeting_id' - 'created_by' || jsonb_build_object('meeting_at', pm.scheduled_at)
          from crm_meetings pm join crm_meeting_captures cp on cp.meeting_id = pm.id
          where pm.deal_id = mv.deal_id and pm.id <> mv.id and pm.scheduled_at < mv.scheduled_at order by pm.scheduled_at desc limit 1)
      ) order by mv.scheduled_at), '[]')
      from crm_meetings_v mv join crm_companies c on c.id = mv.company_id join crm_deals_v dv on dv.id = mv.deal_id
      where mv.scheduled_at >= w.w_from and mv.scheduled_at < w.w_to and mv.status <> 'cancelled')
  );
end $$;

/** Per-channel metric counts inside a window. Channel rows come from crm_source_channels at query time. */
create or replace function crm_numbers(p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable set search_path = public as $$
declare res jsonb;
begin
  res := (with acts as (
    select a.source_channel_id as ch, t.counts_as, a.direction, lower(coalesce(a.outcome, '')) as outcome
    from crm_activities a join crm_activity_types t on t.id = a.activity_type_id
    where a.occurred_at >= p_from and a.occurred_at < p_to
  ),
  mt as (
    select d.source_channel_id as ch, m.status, m.created_at, m.scheduled_at
    from crm_meetings m join crm_deals d on d.id = m.deal_id
  ),
  sh as (
    select d.source_channel_id as ch, h.to_stage
    from crm_stage_history h join crm_deals d on d.id = h.deal_id
    where h.changed_at >= p_from and h.changed_at < p_to
  ),
  chans as (
    select id, slug, label, sort_order, is_active from crm_source_channels
    union all select null::uuid, 'unattributed', 'Unattributed', 9999, true
  ),
  nums as (
    select c.id, c.slug, c.label, c.sort_order, c.is_active,
      (select count(*) from acts a where a.ch is not distinct from c.id and a.counts_as = 'dial' and a.direction = 'outbound') as dials,
      (select count(*) from acts a where a.ch is not distinct from c.id and a.counts_as = 'dial' and a.outcome in ('connected','connect','spoke','conversation')) as connects,
      (select count(*) from acts a where a.ch is not distinct from c.id and a.counts_as = 'linkedin_connect' and (a.outcome = 'accepted' or a.direction = 'inbound')) as linkedin_accepts,
      (select count(*) from acts a where a.ch is not distinct from c.id and a.direction = 'inbound' and coalesce(a.counts_as, '') not in ('meeting','linkedin_connect')) as replies,
      (select count(*) from mt where mt.ch is not distinct from c.id and mt.created_at >= p_from and mt.created_at < p_to) as meetings_booked,
      (select count(*) from mt where mt.ch is not distinct from c.id and mt.status = 'held' and mt.scheduled_at >= p_from and mt.scheduled_at < p_to) as meetings_held,
      (select count(*) from mt where mt.ch is not distinct from c.id and mt.status = 'no_show' and mt.scheduled_at >= p_from and mt.scheduled_at < p_to) as no_shows,
      (select count(*) from sh where sh.ch is not distinct from c.id and sh.to_stage = 'proposal_sent') as proposals_sent,
      (select count(*) from sh where sh.ch is not distinct from c.id and sh.to_stage = 'won') as closes
    from chans c
  )
  select jsonb_build_object(
    'channels', coalesce((select jsonb_agg(to_jsonb(n) - 'sort_order' order by n.sort_order, n.label) from nums n
                          where n.is_active or (n.dials + n.connects + n.linkedin_accepts + n.replies + n.meetings_booked + n.meetings_held + n.no_shows + n.proposals_sent + n.closes) > 0), '[]'),
    'totals', (select jsonb_build_object('dials', sum(dials), 'connects', sum(connects), 'linkedin_accepts', sum(linkedin_accepts), 'replies', sum(replies),
                                         'meetings_booked', sum(meetings_booked), 'meetings_held', sum(meetings_held), 'no_shows', sum(no_shows),
                                         'proposals_sent', sum(proposals_sent), 'closes', sum(closes)) from nums)
  ));
  return res;
end $$;

create or replace function crm_daily_scoreboard(p_date date default null, p_tz text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := coalesce(p_tz, crm_tz()); d date; w record; w7 record;
begin
  perform crm_require_member();
  d := coalesce(p_date, (now() at time zone tz)::date - 1);   -- default: yesterday
  select * into w from crm_day_window(d, tz);
  select * into w7 from crm_day_window(d - 6, tz);
  return jsonb_build_object(
    'date', d, 'timezone', tz,
    'day', crm_numbers(w.w_from, w.w_to),
    'trailing_7d', jsonb_build_object('from', d - 6, 'to', d) || crm_numbers(w7.w_from, w.w_to),
    'note', 'Counts are derived from activities, meetings and stage_history — nothing here is hand-entered. dials = outbound call activities; connects = calls with outcome connected; replies = inbound activities; proposals/closes = stage changes on that day.'
  );
end $$;

create or replace function crm_deals_needing_attention() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare item_sql text;
begin
  perform crm_require_member();
  return jsonb_build_object(
    'stuck', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', id, 'company', company_name, 'stage', stage, 'owner', owner_name, 'value_monthly', value_monthly, 'currency', currency, 'days_in_stage', days_in_stage, 'missing', case when next_step is null then 'next_step' else 'next_step_date' end) order by days_in_stage desc), '[]') from crm_deals_v where is_stuck),
    'stale', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', id, 'company', company_name, 'stage', stage, 'owner', owner_name, 'value_monthly', value_monthly, 'currency', currency, 'days_since_activity', days_since_activity, 'last_activity_at', last_activity_at) order by days_since_activity desc), '[]') from crm_deals_v where is_stale),
    'slipping', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', id, 'company', company_name, 'stage', stage, 'owner', owner_name, 'value_monthly', value_monthly, 'currency', currency, 'next_step', next_step, 'next_step_date', next_step_date, 'days_late', ((now() at time zone crm_tz())::date - next_step_date)) order by next_step_date), '[]') from crm_deals_v where is_slipping),
    'stale_after_days', crm_stale_days()
  );
end $$;

-- ------------------------------------------------------------------ in the meeting
create or replace function crm_log_commitment(p_owner text, p_date date, p_targets jsonb, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := crm_resolve_member(p_owner); r crm_commitments;
begin
  perform crm_require_member();
  if p_targets is null or jsonb_typeof(p_targets) <> 'object' or p_targets = '{}'::jsonb then raise exception 'E_PAYLOAD_INVALID: targets must be an object like {"dials": 30, "linkedin_connects": 20, "meetings_booked": 2}'; end if;
  insert into crm_commitments(owner_id, commit_date, targets, notes, created_by) values (uid, coalesce(p_date, (now() at time zone crm_tz())::date), p_targets, p_notes, auth.uid())
  on conflict (owner_id, commit_date) do update set targets = crm_commitments.targets || excluded.targets, notes = coalesce(excluded.notes, crm_commitments.notes)
  returning * into r;
  return to_jsonb(r) || jsonb_build_object('owner', (select display_name from crm_members where user_id = uid));
end $$;

/** Actual numbers a member produced on a local day (for commitment_vs_actual). */
create or replace function crm_owner_actuals(p_owner uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable set search_path = public as $$
  select jsonb_build_object(
    'dials', (select count(*) from crm_activities a join crm_activity_types t on t.id = a.activity_type_id where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and t.counts_as = 'dial' and a.direction = 'outbound'),
    'connects', (select count(*) from crm_activities a join crm_activity_types t on t.id = a.activity_type_id where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and t.counts_as = 'dial' and lower(coalesce(a.outcome,'')) in ('connected','connect','spoke','conversation')),
    'linkedin_connects', (select count(*) from crm_activities a join crm_activity_types t on t.id = a.activity_type_id where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and t.counts_as = 'linkedin_connect' and a.direction = 'outbound'),
    'linkedin_messages', (select count(*) from crm_activities a join crm_activity_types t on t.id = a.activity_type_id where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and t.counts_as = 'linkedin_message' and a.direction = 'outbound'),
    'emails', (select count(*) from crm_activities a join crm_activity_types t on t.id = a.activity_type_id where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and t.counts_as = 'email' and a.direction = 'outbound'),
    'touches', (select count(*) from crm_activities a where a.owner_id = p_owner and a.occurred_at >= p_from and a.occurred_at < p_to and a.direction = 'outbound'),
    'meetings_booked', (select count(*) from crm_meetings m where m.created_by = p_owner and m.created_at >= p_from and m.created_at < p_to),
    'proposals_sent', (select count(*) from crm_stage_history h where h.changed_by = p_owner and h.to_stage = 'proposal_sent' and h.changed_at >= p_from and h.changed_at < p_to),
    'closes', (select count(*) from crm_stage_history h where h.changed_by = p_owner and h.to_stage = 'won' and h.changed_at >= p_from and h.changed_at < p_to)
  );
$$;

create or replace function crm_commitment_vs_actual(p_from date, p_to date default null, p_owner text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := crm_tz(); d_to date := coalesce(p_to, (now() at time zone crm_tz())::date); uid uuid; rows jsonb := '[]'; r record; w record; act jsonb; k text; committed numeric; actual numeric; misses int; keys int;
begin
  perform crm_require_member();
  uid := case when p_owner is null then null else crm_resolve_member(p_owner) end;
  for r in select c.*, m.display_name from crm_commitments c join crm_members m on m.user_id = c.owner_id
           where c.commit_date between p_from and d_to and (uid is null or c.owner_id = uid) order by c.commit_date, m.display_name loop
    select * into w from crm_day_window(r.commit_date, tz);
    act := crm_owner_actuals(r.owner_id, w.w_from, w.w_to);
    misses := 0; keys := 0;
    for k in select jsonb_object_keys(r.targets) loop
      keys := keys + 1;
      committed := nullif(r.targets->>k, '')::numeric; actual := nullif(act->>k, '')::numeric;
      if actual is not null and committed is not null and actual < committed then misses := misses + 1; end if;
    end loop;
    rows := rows || jsonb_build_object('date', r.commit_date, 'owner', r.display_name, 'owner_id', r.owner_id, 'committed', r.targets, 'actual', act,
                                       'metrics_missed', misses, 'metrics_committed', keys, 'all_met', misses = 0, 'notes', r.notes);
  end loop;
  return jsonb_build_object('from', p_from, 'to', d_to, 'timezone', tz, 'rows', rows,
    'repeat_misses', (select coalesce(jsonb_agg(jsonb_build_object('owner', x.owner, 'days_missed', x.n) order by x.n desc), '[]')
                      from (select x->>'owner' as owner, count(*) as n from jsonb_array_elements(rows) x where (x->>'metrics_missed')::int > 0 group by 1 having count(*) >= 2) x),
    'note', 'actual keys: dials, connects, linkedin_connects, linkedin_messages, emails, touches, meetings_booked, proposals_sent, closes. Commit with the same keys so they compare.');
end $$;

-- ------------------------------------------------------------------ pipeline & analysis
-- Filters: owner / icp_segment / source_channel / stages / include_closed, plus time windows on when the deal was created
-- (created_from / created_to) and its latest activity (activity_from / activity_to) — timestamptz, from inclusive, to exclusive.
-- sort: 'value' (default: biggest first) | 'created' (newest first) | 'activity' (most recent activity first).
create or replace function crm_pipeline(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare owner uuid; seg uuid; ch uuid; stages crm_deal_stage_t[]; include_closed boolean := coalesce((p->>'include_closed')::boolean, false);
  c_from timestamptz := (p->>'created_from')::timestamptz; c_to timestamptz := (p->>'created_to')::timestamptz;
  a_from timestamptz := (p->>'activity_from')::timestamptz; a_to timestamptz := (p->>'activity_to')::timestamptz;
  sort_by text := coalesce(nullif(p->>'sort', ''), 'value');
begin
  perform crm_require_member();
  owner := case when p->>'owner' is not null then crm_resolve_member(p->>'owner') end;
  seg := crm_resolve_lookup('icp_segment', coalesce(p->>'icp_segment', p->>'icp_segment_id'));
  ch := crm_resolve_lookup('source_channel', coalesce(p->>'source_channel', p->>'source_channel_id'));
  if jsonb_typeof(p->'stages') = 'array' then select array_agg(x::crm_deal_stage_t) into stages from jsonb_array_elements_text(p->'stages') x; end if;
  return (
    with f as (
      select v.* from crm_deals_v v
      where (owner is null or v.owner_id = owner) and (seg is null or v.icp_segment_id = seg) and (ch is null or v.source_channel_id = ch)
        and (c_from is null or v.created_at >= c_from) and (c_to is null or v.created_at < c_to)
        and (a_from is null or v.last_activity_at >= a_from) and (a_to is null or v.last_activity_at < a_to))
    select jsonb_build_object(
      'stages', (
        select coalesce(jsonb_agg(jsonb_build_object('stage', s, 'count', (select count(*) from f where f.stage = s),
          'value_monthly_usd', (select coalesce(sum(f.value_monthly_usd), 0) from f where f.stage = s),
          'deals', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', f.id, 'company', f.company_name, 'company_id', f.company_id, 'logo_domain', crm_company_logo_domain(f.company_id, f.company_domain), 'title', f.title, 'value_monthly', f.value_monthly, 'currency', f.currency, 'value_monthly_usd', f.value_monthly_usd,
                      'videos_per_month', f.videos_per_month, 'owner', f.owner_name, 'days_in_stage', f.days_in_stage, 'next_step', f.next_step, 'next_step_date', f.next_step_date,
                      'is_stale', f.is_stale, 'is_stuck', f.is_stuck, 'is_slipping', f.is_slipping, 'icp_segment', f.icp_segment_label, 'source_channel', f.source_channel_label, 'expected_close_date', f.expected_close_date, 'lost_reason', f.lost_reason,
                      'created_at', f.created_at, 'last_activity_at', f.last_activity_at)
                    order by case when sort_by = 'created' then f.created_at end desc nulls last, case when sort_by = 'activity' then f.last_activity_at end desc nulls last,
                             f.value_monthly_usd desc nulls last, f.days_in_stage desc), '[]')
                    from f where f.stage = s)
        ) order by crm_stage_rank(s)), '[]')
        from unnest(enum_range(null::crm_deal_stage_t)) s
        where (stages is null or s = any(stages)) and (include_closed or s not in ('won','lost'))),
      'totals', (select jsonb_build_object('open_deals', count(*) filter (where is_active), 'open_value_monthly_usd', coalesce(sum(value_monthly_usd) filter (where is_active), 0),
                                           'won_value_monthly_usd', coalesce(sum(value_monthly_usd) filter (where stage = 'won'), 0), 'stale', count(*) filter (where is_stale), 'stuck', count(*) filter (where is_stuck), 'slipping', count(*) filter (where is_slipping))
                 from f)
    ));
end $$;

-- PostgREST computed field: `crm_companies?select=*,crm_last_activity_at&order=crm_last_activity_at.desc` — latest activity across the
-- company's deals, so the paginated /crm/companies list can filter and sort on it server-side. Security INVOKER (caller's RLS).
create or replace function crm_last_activity_at(c crm_companies) returns timestamptz
language sql stable set search_path = public as $$
  select max(d.last_activity_at) from crm_deals d where d.company_id = c.id;
$$;

/** Whole months a won deal has been billed up to today: the month it was won counts as 1. */
create or replace function crm_months_billed(p_won_at timestamptz) returns int
language sql stable set search_path = public as $$
  select case when p_won_at is null then 0
    else greatest(1, (extract(year from age((now() at time zone crm_tz())::date, (p_won_at at time zone crm_tz())::date)) * 12
                    + extract(month from age((now() at time zone crm_tz())::date, (p_won_at at time zone crm_tz())::date)))::int + 1) end;
$$;

create or replace function crm_funnel(p_from date, p_to date default null, p_source_channel text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare ch uuid; d_to date := coalesce(p_to, (now() at time zone crm_tz())::date); w record; t_to timestamptz;
begin
  perform crm_require_member();
  ch := crm_resolve_lookup('source_channel', p_source_channel);
  select * into w from crm_day_window(p_from, null);
  t_to := (select w_to from crm_day_window(d_to, null));
  return jsonb_build_object('from', p_from, 'to', d_to, 'source_channel', (select label from crm_source_channels where id = ch),
    'channels', (
      select coalesce(jsonb_agg(row_ || jsonb_build_object(
        'conversion_pct', jsonb_build_object(
          'contacted_of_leads', case when (row_->>'leads')::int > 0 then round(100.0 * (row_->>'contacted')::int / (row_->>'leads')::int, 1) end,
          'replied_of_contacted', case when (row_->>'contacted')::int > 0 then round(100.0 * (row_->>'replied')::int / (row_->>'contacted')::int, 1) end,
          'meeting_booked_of_replied', case when (row_->>'replied')::int > 0 then round(100.0 * (row_->>'meeting_booked')::int / (row_->>'replied')::int, 1) end,
          'meeting_held_of_booked', case when (row_->>'meeting_booked')::int > 0 then round(100.0 * (row_->>'meeting_held')::int / (row_->>'meeting_booked')::int, 1) end,
          'proposal_of_held', case when (row_->>'meeting_held')::int > 0 then round(100.0 * (row_->>'proposal_sent')::int / (row_->>'meeting_held')::int, 1) end,
          'won_of_proposal', case when (row_->>'proposal_sent')::int > 0 then round(100.0 * (row_->>'won')::int / (row_->>'proposal_sent')::int, 1) end,
          'won_of_leads', case when (row_->>'leads')::int > 0 then round(100.0 * (row_->>'won')::int / (row_->>'leads')::int, 1) end),
        'cac_usd', case when (row_->>'cost_usd') is not null and (row_->>'won')::int > 0 then round((row_->>'cost_usd')::numeric / (row_->>'won')::int, 2) end,
        'ltv_usd', case when (row_->>'won_customers')::int > 0 then round((row_->>'revenue_usd')::numeric / (row_->>'won_customers')::int, 2) end
      ) order by row_->>'label'), '[]')
      from (
        select jsonb_build_object('source_channel_id', c.id, 'slug', c.slug, 'label', c.label,
          'leads', (select count(*) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to),
          'contacted', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('contacted') and h.to_stage <> 'lost'),
          'replied', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('replied') and h.to_stage <> 'lost'),
          'meeting_booked', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('meeting_booked') and h.to_stage <> 'lost'),
          'meeting_held', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('meeting_held') and h.to_stage <> 'lost'),
          'proposal_sent', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('proposal_sent') and h.to_stage <> 'lost'),
          'negotiation', (select count(distinct d.id) from crm_deals d join crm_stage_history h on h.deal_id = d.id where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and crm_stage_rank(h.to_stage) >= crm_stage_rank('negotiation') and h.to_stage <> 'lost'),
          'won', (select count(*) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and d.stage = 'won'),
          'lost', (select count(*) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and d.stage = 'lost'),
          'won_value_monthly_usd', (select coalesce(sum(value_monthly_usd), 0) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and d.stage = 'won'),
          'won_customers', (select count(distinct d.company_id) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and d.stage = 'won'),
          'revenue_usd', (select coalesce(sum(d.value_monthly_usd * crm_months_billed(d.closed_at)), 0) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= w.w_from and d.created_at < t_to and d.stage = 'won'),
          'cost_usd', (select sum(cc.cost * coalesce(fx.usd_per_unit, 1)) from crm_channel_costs cc left join crm_fx_rates fx on fx.currency = cc.currency where cc.source_channel_id = c.id and cc.month >= date_trunc('month', p_from)::date and cc.month <= d_to)
        ) as row_
        from (select id, slug, label, sort_order from crm_source_channels where is_active and (ch is null or id = ch)
              union all select null, 'unattributed', 'Unattributed', 9999 where ch is null) c
      ) x
      where (row_->>'leads')::int > 0 or (row_->>'cost_usd') is not null),
    'note', 'Cohort funnel: deals CREATED in the range, counted at the furthest stage they reached (stage_history). cost/CAC only where channel cost was entered (set_channel_cost). revenue_usd = won deals'' monthly value x months billed since they were won (the won month counts, a won deal is assumed still active); ltv_usd = revenue_usd per won customer.');
end $$;

create or replace function crm_top_pain_points(p_from date default null, p_to date default null, p_icp_segment text default null, p_limit int default 25) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare seg uuid; f timestamptz; t timestamptz;
begin
  perform crm_require_member();
  seg := crm_resolve_lookup('icp_segment', p_icp_segment);
  f := case when p_from is null then '-infinity'::timestamptz else (select w_from from crm_day_window(p_from, null)) end;
  t := case when p_to is null then 'infinity'::timestamptz else (select w_to from crm_day_window(p_to, null)) end;
  return jsonb_build_object('from', p_from, 'to', p_to, 'icp_segment', (select label from crm_icp_segments where id = seg),
    'captures_considered', (select count(*) from crm_meeting_captures cp join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id join crm_companies c on c.id = d.company_id
                             where cp.outcome = 'held' and m.scheduled_at >= f and m.scheduled_at < t and (seg is null or c.icp_segment_id = seg)),
    'tags', (
      select coalesce(jsonb_agg(jsonb_build_object('tag', x.label, 'slug', x.slug, 'mentions', x.mentions, 'deals', x.deals, 'won_deals', x.won,
                                                   'segments', x.segments, 'verbatims', x.verbatims) order by x.mentions desc, x.deals desc), '[]')
      from (
        select pt.slug, pt.label, count(*) as mentions, count(distinct d.id) as deals, count(distinct d.id) filter (where d.stage = 'won') as won,
               (select jsonb_object_agg(s.label, s.n) from (select coalesce(seg2.label, 'unsegmented') as label, count(*) as n from crm_capture_pain_tags cpt2 join crm_meeting_captures cp2 on cp2.id = cpt2.capture_id join crm_meetings m2 on m2.id = cp2.meeting_id join crm_deals d2 on d2.id = m2.deal_id join crm_companies c2 on c2.id = d2.company_id left join crm_icp_segments seg2 on seg2.id = c2.icp_segment_id where cpt2.tag_id = pt.id group by 1) s) as segments,
               (select jsonb_agg(v) from (select distinct cpt3.verbatim as v from crm_capture_pain_tags cpt3 where cpt3.tag_id = pt.id and cpt3.verbatim is not null limit 3) q) as verbatims
        from crm_capture_pain_tags cpt
        join crm_pain_point_tags pt on pt.id = cpt.tag_id
        join crm_meeting_captures cp on cp.id = cpt.capture_id
        join crm_meetings m on m.id = cp.meeting_id
        join crm_deals d on d.id = m.deal_id
        join crm_companies c on c.id = d.company_id
        where m.scheduled_at >= f and m.scheduled_at < t and (seg is null or c.icp_segment_id = seg)
        group by pt.id, pt.slug, pt.label
        order by mentions desc, deals desc
        limit coalesce(p_limit, 25)
      ) x),
    'top_objections', (
      select coalesce(jsonb_agg(jsonb_build_object('objection', o.ob, 'mentions', o.n) order by o.n desc), '[]')
      from (select lower(trim(ob)) as ob, count(*) as n from crm_meeting_captures cp join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id join crm_companies c on c.id = d.company_id, unnest(cp.objections) ob
            where m.scheduled_at >= f and m.scheduled_at < t and (seg is null or c.icp_segment_id = seg) group by 1 order by 2 desc limit 10) o));
end $$;

create or replace function crm_channel_quality(p_from date, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d_to date := coalesce(p_to, (now() at time zone crm_tz())::date); f timestamptz; t timestamptz;
begin
  perform crm_require_member();
  f := (select w_from from crm_day_window(p_from, null));
  t := (select w_to from crm_day_window(d_to, null));
  return jsonb_build_object('from', p_from, 'to', d_to,
    'channels', (
      select coalesce(jsonb_agg(r || jsonb_build_object(
        'no_show_rate_pct', case when (r->>'meetings_booked')::int > 0 then round(100.0 * (r->>'no_shows')::int / (r->>'meetings_booked')::int, 1) end,
        'held_rate_pct', case when (r->>'meetings_booked')::int > 0 then round(100.0 * (r->>'meetings_held')::int / (r->>'meetings_booked')::int, 1) end,
        'close_rate_pct', case when (r->>'deals_created')::int > 0 then round(100.0 * (r->>'won')::int / (r->>'deals_created')::int, 1) end,
        'close_rate_of_held_pct', case when (r->>'meetings_held')::int > 0 then round(100.0 * (r->>'won')::int / (r->>'meetings_held')::int, 1) end
      ) order by (r->>'no_show_rate_sort')::numeric nulls last, r->>'label'), '[]')
      from (
        select jsonb_build_object('source_channel_id', c.id, 'slug', c.slug, 'label', c.label, 'is_active', c.is_active,
          'deals_created', (select count(*) from crm_deals d where d.source_channel_id is not distinct from c.id and d.created_at >= f and d.created_at < t),
          'meetings_booked', (select count(*) from crm_meetings m join crm_deals d on d.id = m.deal_id where d.source_channel_id is not distinct from c.id and m.created_at >= f and m.created_at < t),
          'meetings_held', (select count(*) from crm_meetings m join crm_deals d on d.id = m.deal_id where d.source_channel_id is not distinct from c.id and m.status = 'held' and m.scheduled_at >= f and m.scheduled_at < t),
          'no_shows', (select count(*) from crm_meetings m join crm_deals d on d.id = m.deal_id where d.source_channel_id is not distinct from c.id and m.status = 'no_show' and m.scheduled_at >= f and m.scheduled_at < t),
          'won', (select count(*) from crm_stage_history h join crm_deals d on d.id = h.deal_id where d.source_channel_id is not distinct from c.id and h.to_stage = 'won' and h.changed_at >= f and h.changed_at < t),
          'lost', (select count(*) from crm_stage_history h join crm_deals d on d.id = h.deal_id where d.source_channel_id is not distinct from c.id and h.to_stage = 'lost' and h.changed_at >= f and h.changed_at < t),
          'avg_deal_value_monthly_usd', (select round(avg(d.value_monthly_usd), 2) from crm_deals d where d.source_channel_id is not distinct from c.id and d.stage = 'won' and d.closed_at >= f and d.closed_at < t),
          'avg_open_value_monthly_usd', (select round(avg(d.value_monthly_usd), 2) from crm_deals d where d.source_channel_id is not distinct from c.id and d.stage not in ('won','lost')),
          'no_show_rate_sort', (select case when count(*) filter (where m.created_at >= f and m.created_at < t) > 0 then -1.0 * count(*) filter (where m.status = 'no_show' and m.scheduled_at >= f and m.scheduled_at < t) / count(*) filter (where m.created_at >= f and m.created_at < t) end from crm_meetings m join crm_deals d on d.id = m.deal_id where d.source_channel_id is not distinct from c.id)
        ) as r
        from (select id, slug, label, is_active, sort_order from crm_source_channels union all select null, 'unattributed', 'Unattributed', true, 9999) c
      ) x
      where (r->>'deals_created')::int > 0 or (r->>'meetings_booked')::int > 0 or (r->>'is_active')::boolean),
    'note', 'No-show rate by channel is the lead-quality signal: high no-show + low close = poor-fit leads from that channel. Channels are sorted worst no-show rate first.');
end $$;

create or replace function crm_company_brief(p_company text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cid uuid := crm_resolve_company(jsonb_build_object('company', p_company), true);
begin
  perform crm_require_member();
  return jsonb_build_object(
    'company', (select to_jsonb(c) || jsonb_build_object('icp_segment', s.label, 'source_channel', ch.label, 'created_by_name', m.display_name)
                from crm_companies c left join crm_icp_segments s on s.id = c.icp_segment_id left join crm_source_channels ch on ch.id = c.source_channel_id left join crm_members m on m.user_id = c.created_by where c.id = cid),
    'contacts', (select coalesce(jsonb_agg(to_jsonb(ct) order by ct.is_primary desc, ct.created_at), '[]') from crm_contacts ct where ct.company_id = cid),
    'deals', (select coalesce(jsonb_agg((to_jsonb(v) - 'company_name' - 'company_domain' - 'company_country' - 'company_timezone') || jsonb_build_object(
                 'stage_history', (select coalesce(jsonb_agg(jsonb_build_object('from', h.from_stage, 'to', h.to_stage, 'at', h.changed_at, 'reason', h.reason, 'by', mm.display_name) order by h.changed_at), '[]') from crm_stage_history h left join crm_members mm on mm.user_id = h.changed_by where h.deal_id = v.id)
               ) order by v.created_at desc), '[]') from crm_deals_v v where v.company_id = cid),
    'meetings', (select coalesce(jsonb_agg(jsonb_build_object('meeting_id', mv.id, 'deal_id', mv.deal_id, 'scheduled_at', mv.scheduled_at, 'status', mv.status, 'contact', mv.contact_name, 'attendees', mv.attendees, 'notes', mv.notes,
                   'capture', (select to_jsonb(cp) - 'id' - 'meeting_id' - 'created_by' || jsonb_build_object('tags', (select coalesce(jsonb_agg(pt.label), '[]') from crm_capture_pain_tags cpt join crm_pain_point_tags pt on pt.id = cpt.tag_id where cpt.capture_id = cp.id)) from crm_meeting_captures cp where cp.meeting_id = mv.id),
                   'transcript', (select jsonb_build_object('summary', tr.summary, 'topics', to_jsonb(tr.topics), 'duration_seconds', tr.duration_seconds, 'word_count', tr.word_count, 'speakers', tr.speakers) from crm_meeting_transcripts tr where tr.meeting_id = mv.id),
                   'recording', (select jsonb_build_object('bytes', rc.bytes, 'content_type', rc.content_type, 'duration_seconds', rc.duration_seconds, 'original_name', rc.original_name, 'uploaded_via', rc.uploaded_via, 'created_at', rc.created_at) from crm_meeting_recordings rc where rc.meeting_id = mv.id),
                   'coaching', (select jsonb_build_object('execution_score', cc.execution_score, 'counts', cc.counts, 'readiness', cc.readiness, 'purpose', cc.purpose, 'biggest_miss', cc.biggest_miss->>'title', 'priorities', (select jsonb_agg(x->>'title') from jsonb_array_elements(cc.priorities) x), 'next_action', cc.next_action->>'what', 'lens', cc.lens, 'version', cc.version, 'updated_at', cc.updated_at) from crm_call_coaching cc where cc.meeting_id = mv.id)
                 ) order by mv.scheduled_at desc), '[]') from crm_meetings_v mv where mv.company_id = cid),
    'activities', (select coalesce(jsonb_agg(jsonb_build_object('at', a.occurred_at, 'type', a.activity_type_label, 'direction', a.direction, 'channel', a.source_channel_label, 'contact', a.contact_name, 'outcome', a.outcome, 'body', a.body, 'by', a.owner_name, 'deal_id', a.deal_id) order by a.occurred_at desc), '[]') from crm_activities_v a where a.company_id = cid),
    'pain_points', (select coalesce(jsonb_agg(distinct pp), '[]') from crm_meeting_captures cp join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id, unnest(cp.pain_points) pp where d.company_id = cid),
    'pain_point_tags', (select coalesce(jsonb_agg(distinct pt.label), '[]') from crm_capture_pain_tags cpt join crm_pain_point_tags pt on pt.id = cpt.tag_id join crm_meeting_captures cp on cp.id = cpt.capture_id join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id where d.company_id = cid),
    'objections', (select coalesce(jsonb_agg(distinct ob), '[]') from crm_meeting_captures cp join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id, unnest(cp.objections) ob where d.company_id = cid),
    'commercials', (select coalesce(jsonb_agg(cp.commercials_discussed || jsonb_build_object('meeting_at', m.scheduled_at) order by m.scheduled_at desc), '[]') from crm_meeting_captures cp join crm_meetings m on m.id = cp.meeting_id join crm_deals d on d.id = m.deal_id where d.company_id = cid and cp.commercials_discussed is not null),
    'open_next_steps', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', v.id, 'stage', v.stage, 'next_step', v.next_step, 'next_step_date', v.next_step_date, 'owner', v.owner_name)), '[]') from crm_deals_v v where v.company_id = cid and v.is_active),
    'delivery_project_ids', (select coalesce(jsonb_agg(d.delivery_project_id), '[]') from crm_deals d where d.company_id = cid and d.delivery_project_id is not null)
  );
end $$;

create or replace function crm_search(p_q text, p_limit int default 10) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare q text := '%' || trim(coalesce(p_q, '')) || '%';
begin
  perform crm_require_member();
  return jsonb_build_object(
    'companies', (select coalesce(jsonb_agg(jsonb_build_object('company_id', c.id, 'name', c.name, 'domain', c.domain, 'country', c.country, 'icp_segment', s.label, 'open_deals', (select count(*) from crm_deals d where d.company_id = c.id and d.stage not in ('won','lost'))) order by c.name), '[]')
                  from (select * from crm_companies where name ilike q or domain ilike q or website ilike q order by name limit coalesce(p_limit, 10)) c left join crm_icp_segments s on s.id = c.icp_segment_id),
    'contacts', (select coalesce(jsonb_agg(jsonb_build_object('contact_id', ct.id, 'name', ct.name, 'role', ct.role, 'email', ct.email, 'company_id', ct.company_id, 'company', c.name) order by ct.name), '[]')
                 from (select * from crm_contacts where name ilike q or email ilike q or role ilike q order by name limit coalesce(p_limit, 10)) ct join crm_companies c on c.id = ct.company_id),
    'deals', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', v.id, 'company', v.company_name, 'company_id', v.company_id, 'title', v.title, 'stage', v.stage, 'value_monthly', v.value_monthly, 'currency', v.currency, 'owner', v.owner_name) order by v.created_at desc), '[]')
              from (select * from crm_deals_v where company_name ilike q or title ilike q or next_step ilike q order by created_at desc limit coalesce(p_limit, 10)) v));
end $$;

/** One call for the Standup screen. */
create or replace function crm_standup(p_date date default null, p_tz text default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare tz text := coalesce(p_tz, crm_tz()); d date := coalesce(p_date, (now() at time zone coalesce(p_tz, crm_tz()))::date);
begin
  perform crm_require_member();
  return jsonb_build_object(
    'date', d, 'timezone', tz,
    'scoreboard', crm_daily_scoreboard(d - 1, tz),
    'meetings_today', crm_whos_meeting_today(d, tz) -> 'meetings',
    'attention', crm_deals_needing_attention(),
    'next_steps_today', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', id, 'company', company_name, 'company_id', company_id, 'stage', stage, 'owner', owner_name, 'value_monthly', value_monthly, 'currency', currency, 'next_step', next_step, 'next_step_date', next_step_date) order by owner_name nulls last, company_name), '[]')
                         from crm_deals_v where stage not in ('won','lost') and next_step_date = d),
    -- the day itself through the Sunday of next week (weeks run Mon–Sun); the Standup card splits it into today / this week / next week
    'week_start', date_trunc('week', d)::date,
    'next_steps_upcoming', (select coalesce(jsonb_agg(jsonb_build_object('deal_id', id, 'company', company_name, 'company_id', company_id, 'stage', stage, 'owner', owner_name, 'value_monthly', value_monthly, 'currency', currency, 'next_step', next_step, 'next_step_date', next_step_date) order by next_step_date, owner_name nulls last, company_name), '[]')
                            from crm_deals_v where stage not in ('won','lost') and next_step_date >= d and next_step_date <= date_trunc('week', d)::date + 13),
    'commitments_today', (select coalesce(jsonb_agg(jsonb_build_object('owner', m.display_name, 'owner_id', c.owner_id, 'targets', c.targets, 'notes', c.notes) order by m.display_name), '[]') from crm_commitments c join crm_members m on m.user_id = c.owner_id where c.commit_date = d),
    'yesterday_commitments', crm_commitment_vs_actual(d - 1, d - 1) -> 'rows',
    'uncaptured_meetings', (select coalesce(jsonb_agg(jsonb_build_object('meeting_id', mv.id, 'company', mv.company_name, 'contact', mv.contact_name, 'scheduled_at', mv.scheduled_at, 'deal_id', mv.deal_id) order by mv.scheduled_at), '[]')
                            from crm_meetings_v mv where mv.status = 'scheduled' and mv.scheduled_at < (select w_from from crm_day_window(d, tz)))
  );
end $$;

-- -----------------------------------------------------------------------------
-- Grants: RPCs are for signed-in users only (RLS + crm_require_member inside)
-- -----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'crm\_%' loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
