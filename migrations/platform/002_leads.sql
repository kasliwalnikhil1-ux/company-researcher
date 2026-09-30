-- =============================================================================
-- Platform leads: who filled a form on growthxai.com and who signed up in the app, with location.
-- Builds on 001_admin.sql (platform_admins, platform_user_access, platform_require_admin, platform_audit).
--
--   platform_leads        one row per website form submission or app sign-up
--                         source: website_waitlist | website_demo | website_integration | website_contact | website_other | app_signup
--                         location (country/region/city/timezone) is filled by app/api/leads from the request's geo headers
--                         when they exist; every location column is optional.
--   linking               a lead and an account are matched by email in both directions:
--                         - a website lead inserted for an email that already has an account gets user_id set (trigger)
--                         - a new auth.users row links every earlier website lead with the same email, and gets its own
--                           app_signup lead row (extended platform_trg_auth_user_created)
--   admin RPCs            platform_admin_leads_overview / platform_admin_list_leads / platform_admin_get_lead /
--                         platform_admin_set_lead — admin only (platform_require_admin)
--   writes                only service_role writes rows (app/api/leads, app/api/leads/track); RLS on, no policies.
--
-- Apply: bash scripts/outreach-sql.sh migrations/platform/002_leads.sql
-- Smoke: bash scripts/outreach-sql.sh migrations/platform/tests/smoke_02_leads.sql
-- =============================================================================

create table if not exists platform_leads (
  id           uuid primary key default gen_random_uuid(),
  source       text not null check (source in ('website_waitlist','website_demo','website_integration','website_contact','website_other','app_signup')),
  email        text,
  name         text,
  company      text,
  answers      jsonb not null default '{}',   -- the form fields as submitted (company_type, senders, current_tool, goal, tool, message, …)
  page         text,                          -- path of the page the form was on
  referrer     text,
  utm          jsonb not null default '{}',   -- {source, medium, campaign, term, content} captured on the visitor's first page
  ip           inet,
  country      text,                          -- ISO-3166 alpha-2 when known
  region       text,
  city         text,
  timezone     text,
  latitude     double precision,
  longitude    double precision,
  user_agent   text,
  user_id      uuid references auth.users(id) on delete set null,
  status       text not null default 'new' check (status in ('new','contacted','booked','converted','ignored')),
  note         text,                          -- admin-only
  booked_at    timestamptz,                   -- set when the onboarding call is booked from the app's gate screen
  booking      jsonb,                         -- Calendly payload (event + invitee URIs)
  updated_by   uuid,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create index if not exists platform_leads_created_idx on platform_leads(created_at desc);
create index if not exists platform_leads_email_idx on platform_leads(lower(email));
create index if not exists platform_leads_source_idx on platform_leads(source);
create index if not exists platform_leads_user_idx on platform_leads(user_id);
-- one sign-up row per account
create unique index if not exists platform_leads_signup_user_uidx on platform_leads(user_id) where source = 'app_signup';

alter table platform_leads enable row level security;
revoke all on platform_leads from anon, authenticated;
grant all on platform_leads to service_role;

-- every stored email lowercased + trimmed (migrations/normalize_email_columns.sql)
drop trigger if exists a0_normalize_emails on public.platform_leads;
create trigger a0_normalize_emails before insert or update of email on public.platform_leads
  for each row execute function public.normalize_email_columns('email');

-- -----------------------------------------------------------------------------
-- Linking lead <-> account by email
-- -----------------------------------------------------------------------------
create or replace function platform_trg_lead_link_user() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  new.updated_at := now();
  if new.user_id is null and new.email is not null then
    select u.id into new.user_id from auth.users u
     where lower(u.email) = lower(new.email) and u.deleted_at is null
     order by u.created_at limit 1;
  end if;
  return new;
end $$;

drop trigger if exists platform_lead_link_user on platform_leads;
create trigger platform_lead_link_user
  before insert or update of email on platform_leads
  for each row execute function platform_trg_lead_link_user();

-- New sign-ups: the access row (001) + a sign-up lead row + link earlier website leads with the same email.
create or replace function platform_trg_auth_user_created() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into platform_user_access(user_id, status, approved_at)
  values (new.id,
          case when platform_signup_mode() = 'open' then 'active' else 'pending' end,
          case when platform_signup_mode() = 'open' then now() else null end)
  on conflict (user_id) do nothing;

  begin
    insert into platform_leads(source, email, name, user_id, answers)
    values ('app_signup', new.email, coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'), new.id,
            jsonb_build_object('provider', coalesce(new.raw_app_meta_data->>'provider', 'email')))
    on conflict do nothing;
    update platform_leads set user_id = new.id
     where user_id is null and email is not null and lower(email) = lower(new.email);
  exception when others then
    raise warning 'platform_trg_auth_user_created (lead): %', sqlerrm;
  end;
  return new;
exception when others then
  -- never break a sign-up because of the access row; the row is created lazily by platform_status_of's fallback
  raise warning 'platform_trg_auth_user_created: %', sqlerrm;
  return new;
end $$;

-- -----------------------------------------------------------------------------
-- Admin reads
-- -----------------------------------------------------------------------------
create or replace function platform_admin__lead_json(l platform_leads) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', l.id, 'source', l.source, 'email', l.email, 'name', l.name, 'company', l.company,
    'answers', l.answers, 'page', l.page, 'referrer', l.referrer, 'utm', l.utm,
    'ip', host(l.ip), 'country', l.country, 'region', l.region, 'city', l.city, 'timezone', l.timezone,
    'latitude', l.latitude, 'longitude', l.longitude, 'user_agent', l.user_agent,
    'status', l.status, 'note', l.note, 'booked_at', l.booked_at, 'booking', l.booking,
    'created_at', l.created_at, 'updated_at', l.updated_at,
    'user_id', l.user_id,
    'account', case when l.user_id is null then null else (
      select jsonb_build_object('id', u.id, 'email', u.email, 'created_at', u.created_at, 'last_sign_in_at', u.last_sign_in_at,
                                'status', platform_status_of(u.id), 'is_admin', platform_is_admin(u.id))
        from auth.users u where u.id = l.user_id and u.deleted_at is null) end,
    -- other leads with the same email (form fills for a sign-up, the sign-up for a form fill)
    'related', (select count(*) from platform_leads o
                 where o.id <> l.id and l.email is not null and lower(o.email) = lower(l.email))
  );
$$;

create or replace function platform_admin_leads_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'total', (select count(*) from platform_leads),
    'forms', (select count(*) from platform_leads where source <> 'app_signup'),
    'forms_7d', (select count(*) from platform_leads where source <> 'app_signup' and created_at > now() - interval '7 days'),
    'signups', (select count(*) from platform_leads where source = 'app_signup'),
    'signups_7d', (select count(*) from platform_leads where source = 'app_signup' and created_at > now() - interval '7 days'),
    'booked', (select count(*) from platform_leads where booked_at is not null or status = 'booked'),
    'new', (select count(*) from platform_leads where status = 'new'),
    'located', (select count(*) from platform_leads where country is not null),
    'by_source', (select coalesce(jsonb_object_agg(source, n), '{}') from (select source, count(*) n from platform_leads group by source) s),
    'by_country', (select coalesce(jsonb_agg(jsonb_build_object('country', country, 'n', n) order by n desc), '[]')
                     from (select country, count(*) n from platform_leads where country is not null group by country order by n desc limit 8) c)
  );
end $$;

-- p_filter: {source?, status?, account?: 'yes'|'no', days?: int, country?}
create or replace function platform_admin_list_leads(p_search text default null, p_filter jsonb default '{}', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_source text := nullif(p_filter->>'source', '');
  v_status text := nullif(p_filter->>'status', '');
  v_account text := nullif(p_filter->>'account', '');
  v_country text := nullif(p_filter->>'country', '');
  v_days int := nullif(p_filter->>'days', '')::int;
  v_out jsonb;
begin
  perform platform_require_admin();
  with filtered as (
    select l.* from platform_leads l
     where (v_search is null or l.email ilike '%' || v_search || '%' or l.name ilike '%' || v_search || '%'
            or l.company ilike '%' || v_search || '%' or l.city ilike '%' || v_search || '%' or l.answers::text ilike '%' || v_search || '%')
       and (v_source is null or (v_source = 'website' and l.source <> 'app_signup') or l.source = v_source)
       and (v_status is null or l.status = v_status)
       and (v_account is null or (v_account = 'yes' and l.user_id is not null) or (v_account = 'no' and l.user_id is null))
       and (v_country is null or l.country = v_country)
       and (v_days is null or l.created_at > now() - make_interval(days => v_days))
  ), page as (
    select f.* from filtered f order by f.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', (select coalesce(jsonb_agg(platform_admin__lead_json(p) order by p.created_at desc), '[]'::jsonb) from page p)
  ) into v_out;
  return v_out;
end $$;

create or replace function platform_admin_get_lead(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l platform_leads; v jsonb;
begin
  perform platform_require_admin();
  select * into l from platform_leads where id = p_id;
  if not found then raise exception 'E_NOT_FOUND: lead'; end if;
  v := platform_admin__lead_json(l);
  return v || jsonb_build_object(
    'timeline', (select coalesce(jsonb_agg(platform_admin__lead_json(o) order by o.created_at desc), '[]'::jsonb)
                   from platform_leads o where o.id <> l.id and l.email is not null and lower(o.email) = lower(l.email))
  );
end $$;

-- -----------------------------------------------------------------------------
-- Admin writes
-- -----------------------------------------------------------------------------
create or replace function platform_admin_set_lead(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l platform_leads; v_status text := p_patch->>'status';
begin
  perform platform_require_admin();
  if v_status is not null and v_status not in ('new','contacted','booked','converted','ignored') then
    raise exception 'E_PAYLOAD_INVALID: status';
  end if;
  update platform_leads set
    status = coalesce(v_status, status),
    note = case when p_patch ? 'note' then nullif(trim(p_patch->>'note'), '') else note end,
    updated_by = auth.uid(), updated_at = now()
   where id = p_id returning * into l;
  if not found then raise exception 'E_NOT_FOUND: lead'; end if;
  perform platform_audit('lead.updated', l.user_id, jsonb_build_object('lead_id', l.id, 'email', l.email) || p_patch);
  return platform_admin__lead_json(l);
end $$;

create or replace function platform_admin_delete_lead(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare l platform_leads;
begin
  perform platform_require_admin();
  delete from platform_leads where id = p_id returning * into l;
  if not found then raise exception 'E_NOT_FOUND: lead'; end if;
  perform platform_audit('lead.deleted', l.user_id, jsonb_build_object('lead_id', l.id, 'email', l.email, 'source', l.source));
end $$;

-- -----------------------------------------------------------------------------
-- Backfill: every account that signed up before this table existed gets its app_signup row (dated at sign-up,
-- no location: nothing was recorded at the time). Idempotent.
-- -----------------------------------------------------------------------------
insert into platform_leads(source, email, name, user_id, answers, created_at, updated_at)
select 'app_signup', u.email, coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name'), u.id,
       jsonb_build_object('provider', coalesce(u.raw_app_meta_data->>'provider', 'email'), 'backfilled', true),
       u.created_at, u.created_at
  from auth.users u
 where u.deleted_at is null
   and not exists (select 1 from platform_leads l where l.source = 'app_signup' and l.user_id = u.id)
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- Grants (same rule as 001: signed-in users may call platform_* functions, which check admin themselves;
-- trigger + internal functions are not callable directly)
-- -----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid, p.proname, p.oid::regprocedure::text as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and p.proname in ('platform_trg_lead_link_user','platform_trg_auth_user_created','platform_admin__lead_json',
                                'platform_admin_leads_overview','platform_admin_list_leads','platform_admin_get_lead',
                                'platform_admin_set_lead','platform_admin_delete_lead') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname like 'platform\_trg\_%' or f.proname like 'platform\_admin\_\_%' then
      execute format('revoke execute on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
