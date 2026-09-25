-- =============================================================================
-- Platform admin — 001 (Sept 2026)
--
-- One admin layer over the three products that live in this app:
--   * Fundraising  (investors, credits, plan)      → user_settings + credit_usage
--   * Outreach     (/outreach, outreach_* tables)  → outreach_workspaces + outreach_members
--   * Sales CRM    (/crm, crm_* tables)            → crm_members
--
-- Everything here is prefixed `platform_` (tables, functions, triggers) so it is greppable and removable.
--
-- Model
--   platform_admins        who may open /admin and call platform_admin_* RPCs (replaces hardcoded user ids)
--   platform_user_access   one row per account: status (pending|active|blocked) + per-feature overrides (jsonb)
--   platform_settings      signup_mode ('approval' | 'open'), default_features
--   platform_audit_log     every admin action (who, whom, what, before/after)
--
-- Enforcement (the DB is the authority; the UI only mirrors it)
--   * outreach_role_in / outreach_workspace_ids / outreach_my_workspaces / outreach_ensure_workspace /
--     outreach_create_workspace now require platform_can_use(uid, 'outreach')
--   * crm_is_member now requires platform_status_ok(uid)
--   * upsert_investor_ai_metadata (credit spend) now requires platform_can_use(uid, 'fundraising')
--
-- New sign-ups: a trigger on auth.users inserts the access row with status = 'active' when signup_mode = 'open',
-- 'pending' otherwise (the account exists, the person sees a "waiting for approval" screen until an admin approves).
--
-- Idempotent; safe to re-run.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------
create table if not exists platform_admins (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create table if not exists platform_settings (
  key         text primary key,
  value       jsonb not null,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

create table if not exists platform_user_access (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  status      text not null default 'active' check (status in ('pending','active','blocked')),
  features    jsonb not null default '{}',      -- {"outreach": false, "research": true, ...}; a missing key = default
  note        text,                             -- admin-only note about the account
  approved_at timestamptz,
  approved_by uuid,
  updated_by  uuid,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);
create index if not exists platform_user_access_status_idx on platform_user_access(status);

create table if not exists platform_audit_log (
  id              bigserial primary key,
  admin_id        uuid,
  admin_email     text,
  target_user_id  uuid,
  target_email    text,
  action          text not null,
  details         jsonb not null default '{}',
  created_at      timestamptz not null default now()
);
create index if not exists platform_audit_log_target_idx on platform_audit_log(target_user_id, created_at desc);
create index if not exists platform_audit_log_created_idx on platform_audit_log(created_at desc);

-- Only security-definer functions touch these tables: RLS on, no policies.
alter table platform_admins       enable row level security;
alter table platform_settings     enable row level security;
alter table platform_user_access  enable row level security;
alter table platform_audit_log    enable row level security;

-- -----------------------------------------------------------------------------
-- Settings + seeds
-- -----------------------------------------------------------------------------
insert into platform_settings(key, value) values
  ('signup_mode', '"approval"'),
  ('default_features', '{"fundraising": true, "outreach": true}')
on conflict (key) do nothing;

-- The accounts that were hardcoded as admins in the app, plus the allowlisted sign-in emails.
insert into platform_admins(user_id, email, note)
select u.id, u.email, 'seeded from the hardcoded admin list (migration platform/001)'
  from auth.users u
 where u.id in ('2793f3da-9340-44f4-b285-b7836bfb8591','e25d5e21-13fd-46ee-a39a-4c3386b77b65')
    or lower(u.email) in ('nkjaipur21@gmail.com','kasliwalnikhil1@gmail.com','aarushijain00@gmail.com')
on conflict (user_id) do nothing;

-- Every existing account gets an access row. Before this migration only the allowlisted emails could sign in, so
-- everyone else starts as 'pending' (same effective access as before) until an admin approves them.
insert into platform_user_access(user_id, status, approved_at)
select u.id,
       case when exists (select 1 from platform_admins a where a.user_id = u.id) then 'active' else 'pending' end,
       case when exists (select 1 from platform_admins a where a.user_id = u.id) then now() else null end
  from auth.users u
on conflict (user_id) do nothing;

-- -----------------------------------------------------------------------------
-- Helpers (used by the enforcement hooks in the other products; callable by any signed-in user)
-- -----------------------------------------------------------------------------
create or replace function platform_signup_mode() returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value #>> '{}' from platform_settings where key = 'signup_mode'), 'approval')
$$;

create or replace function platform_is_admin(p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select p_user is not null and exists (select 1 from platform_admins a where a.user_id = p_user)
$$;

create or replace function platform_require_admin() returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  if not platform_is_admin(auth.uid()) then raise exception 'E_FORBIDDEN: admin only'; end if;
end $$;

/** Effective account status: admins are always active; an account without a row follows the sign-up mode. */
create or replace function platform_status_of(p_user uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case
    when p_user is null then 'blocked'
    when platform_is_admin(p_user) then 'active'
    else coalesce((select a.status from platform_user_access a where a.user_id = p_user),
                  case when platform_signup_mode() = 'open' then 'active' else 'pending' end)
  end
$$;

create or replace function platform_status_ok(p_user uuid default auth.uid()) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select platform_status_of(p_user) = 'active'
$$;

/** Effective feature map for a user: defaults overlaid with the account's overrides. */
create or replace function platform_features_of(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value from platform_settings where key = 'default_features'), '{}'::jsonb)
      || coalesce((select a.features from platform_user_access a where a.user_id = p_user), '{}'::jsonb)
$$;

/** True when the account is active AND the feature is not switched off (a feature with no setting counts as on). */
create or replace function platform_can_use(p_user uuid, p_feature text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select platform_status_ok(p_user)
     and coalesce((platform_features_of(p_user) ->> p_feature)::boolean, true)
$$;

/** What the signed-in user may see. The client reads this once per session (contexts/AccessContext.tsx). */
create or replace function platform_my_access() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare uid uuid := auth.uid(); a platform_user_access;
begin
  if uid is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  select * into a from platform_user_access where user_id = uid;
  return jsonb_build_object(
    'user_id', uid,
    'email', auth.email(),
    'status', platform_status_of(uid),
    'is_admin', platform_is_admin(uid),
    'features', platform_features_of(uid),
    'overrides', coalesce(a.features, '{}'::jsonb),
    'crm_member', exists (select 1 from crm_members m where m.user_id = uid and m.is_active),
    'signup_mode', platform_signup_mode()
  );
end $$;

-- -----------------------------------------------------------------------------
-- New sign-ups
-- -----------------------------------------------------------------------------
create or replace function platform_trg_auth_user_created() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into platform_user_access(user_id, status, approved_at)
  values (new.id,
          case when platform_signup_mode() = 'open' then 'active' else 'pending' end,
          case when platform_signup_mode() = 'open' then now() else null end)
  on conflict (user_id) do nothing;
  return new;
exception when others then
  -- never break a sign-up because of the access row; the row is created lazily by platform_status_of's fallback
  raise warning 'platform_trg_auth_user_created: %', sqlerrm;
  return new;
end $$;

drop trigger if exists platform_on_auth_user_created on auth.users;
create trigger platform_on_auth_user_created
  after insert on auth.users
  for each row execute function platform_trg_auth_user_created();

-- -----------------------------------------------------------------------------
-- Audit
-- -----------------------------------------------------------------------------
create or replace function platform_audit(p_action text, p_target uuid, p_details jsonb default '{}') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into platform_audit_log(admin_id, admin_email, target_user_id, target_email, action, details)
  values (auth.uid(), auth.email(), p_target, (select email from auth.users where id = p_target), p_action, coalesce(p_details, '{}'::jsonb));
end $$;

-- -----------------------------------------------------------------------------
-- Admin: read
-- -----------------------------------------------------------------------------
create or replace function platform_admin_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'users', (select count(*) from auth.users where deleted_at is null),
    'pending', (select count(*) from auth.users u where u.deleted_at is null and platform_status_of(u.id) = 'pending'),
    'active', (select count(*) from auth.users u where u.deleted_at is null and platform_status_of(u.id) = 'active'),
    'blocked', (select count(*) from auth.users u where u.deleted_at is null and platform_status_of(u.id) = 'blocked'),
    'banned', (select count(*) from auth.users u where u.deleted_at is null and u.banned_until is not null and u.banned_until > now()),
    'signups_7d', (select count(*) from auth.users where deleted_at is null and created_at > now() - interval '7 days'),
    'credits_outstanding', (select coalesce(sum(credits_remaining), 0) from user_settings),
    'credits_used_30d', (select coalesce(sum(credits_used), 0) from credit_usage where created_at > now() - interval '30 days'),
    'paid_plans', (select count(*) from user_settings where plan in ('basic','pro')),
    'outreach_workspaces', (select count(*) from outreach_workspaces where deleted_at is null),
    'outreach_by_plan', (select coalesce(jsonb_object_agg(plan, n), '{}') from (select plan, count(*) n from outreach_workspaces where deleted_at is null group by plan) z),
    'outreach_senders', (select count(*) from outreach_senders where deleted_at is null),
    'crm_members', (select count(*) from crm_members where is_active),
    'admins', (select count(*) from platform_admins),
    'signup_mode', platform_signup_mode(),
    'default_features', coalesce((select value from platform_settings where key = 'default_features'), '{}'::jsonb)
  );
end $$;

/** One account as the admin sees it. Shared by list + detail. */
create or replace function platform_admin__user_json(p_user uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', u.id,
    'email', u.email,
    'created_at', u.created_at,
    'last_sign_in_at', u.last_sign_in_at,
    'email_confirmed_at', u.email_confirmed_at,
    'banned', (u.banned_until is not null and u.banned_until > now()),
    'provider', coalesce(u.raw_app_meta_data->>'provider', 'email'),
    'status', platform_status_of(u.id),
    'is_admin', platform_is_admin(u.id),
    'features', platform_features_of(u.id),
    'overrides', coalesce(a.features, '{}'::jsonb),
    'note', a.note,
    'approved_at', a.approved_at,
    'plan', coalesce(s.plan, 'free'),
    'billing_status', coalesce(s.status, 'active'),
    'billing_cycle', s.billing_cycle,
    'renewal_date', s.renewal_date,
    'last_billed_at', s.last_billed_at,
    'stripe_customer_id', s.stripe_customer_id,
    'credits_remaining', coalesce(s.credits_remaining, 0),
    'credits_used', (select coalesce(sum(cu.credits_used), 0) from credit_usage cu where cu.user_id = u.id),
    'primary_use', coalesce(s.onboarding->>'flowType', s.onboarding->'step0'->>'primaryUse'),
    'onboarding_completed', coalesce((s.onboarding->>'completed')::boolean, false),
    'outreach', (select coalesce(jsonb_agg(jsonb_build_object(
                    'workspace_id', w.id, 'name', w.name, 'slug', w.slug, 'plan', w.plan, 'role', m.role,
                    'trial_ends_at', w.trial_ends_at, 'stripe_status', w.stripe_status,
                    'senders', (select count(*) from outreach_senders sd where sd.workspace_id = w.id and sd.deleted_at is null),
                    'members', (select count(*) from outreach_members mm where mm.workspace_id = w.id)
                  ) order by m.created_at), '[]'::jsonb)
                 from outreach_members m join outreach_workspaces w on w.id = m.workspace_id and w.deleted_at is null
                where m.user_id = u.id),
    'crm', case when c.user_id is null then null else jsonb_build_object('is_active', c.is_active, 'display_name', c.display_name) end
  )
  from auth.users u
  left join platform_user_access a on a.user_id = u.id
  left join user_settings s on s.id = u.id
  left join crm_members c on c.user_id = u.id
  where u.id = p_user
$$;

/**
 * p_filter: {status, plan, crm (bool), outreach (bool), admin (bool), banned (bool), sort}
 * sort: newest (default) | oldest | last_seen | credits | email
 */
create or replace function platform_admin_list_users(p_search text default null, p_filter jsonb default '{}', p_limit int default 50, p_offset int default 0)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_search text := nullif(trim(coalesce(p_search, '')), '');
  v_status text := nullif(p_filter->>'status', '');
  v_plan text := nullif(p_filter->>'plan', '');
  v_crm boolean := nullif(p_filter->>'crm', '')::boolean;
  v_outreach boolean := nullif(p_filter->>'outreach', '')::boolean;
  v_admin boolean := nullif(p_filter->>'admin', '')::boolean;
  v_banned boolean := nullif(p_filter->>'banned', '')::boolean;
  v_sort text := coalesce(nullif(p_filter->>'sort', ''), 'newest');
  v_out jsonb;
begin
  perform platform_require_admin();
  with base as (
    select u.id, u.email::text as email, u.created_at, u.last_sign_in_at,
           (u.banned_until is not null and u.banned_until > now()) as banned,
           platform_status_of(u.id) as status,
           platform_is_admin(u.id) as is_admin,
           coalesce(s.plan, 'free') as plan,
           coalesce(s.credits_remaining, 0) as credits_remaining,
           exists (select 1 from crm_members c where c.user_id = u.id and c.is_active) as crm_active,
           exists (select 1 from outreach_members m join outreach_workspaces w on w.id = m.workspace_id and w.deleted_at is null where m.user_id = u.id) as has_outreach
      from auth.users u
      left join user_settings s on s.id = u.id
     where u.deleted_at is null
  ), filtered as (
    select * from base b
     where (v_search is null or b.email ilike '%' || v_search || '%' or b.id::text = v_search)
       and (v_status is null or b.status = v_status)
       and (v_plan is null or b.plan = v_plan)
       and (v_crm is null or b.crm_active = v_crm)
       and (v_outreach is null or b.has_outreach = v_outreach)
       and (v_admin is null or b.is_admin = v_admin)
       and (v_banned is null or b.banned = v_banned)
  ), page as (
    select f.id from filtered f
     order by case when v_sort = 'oldest' then f.created_at end asc,
              case when v_sort = 'last_seen' then f.last_sign_in_at end desc nulls last,
              case when v_sort = 'credits' then f.credits_remaining end desc,
              case when v_sort = 'email' then f.email end asc,
              f.created_at desc
     limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))
  )
  select jsonb_build_object(
    'total', (select count(*) from filtered),
    'rows', (select coalesce(jsonb_agg(platform_admin__user_json(p.id)), '[]'::jsonb) from page p)
  ) into v_out;
  -- jsonb_agg over the page loses the ORDER BY of the CTE on some planners: re-sort in the client (rows carry created_at).
  return v_out;
end $$;

create or replace function platform_admin_get_user(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v jsonb;
begin
  perform platform_require_admin();
  v := platform_admin__user_json(p_user);
  if v is null then raise exception 'E_NOT_FOUND: no such account'; end if;
  return v || jsonb_build_object(
    'credit_log', (select coalesce(jsonb_agg(jsonb_build_object('id', cu.id, 'action', cu.action, 'credits_used', cu.credits_used, 'investor_name', i.name, 'created_at', cu.created_at) order by cu.created_at desc), '[]'::jsonb)
                     from (select * from credit_usage where user_id = p_user order by created_at desc limit 50) cu
                     left join investors i on i.id = cu.related_investor_id),
    'audit', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
                from (select id, admin_email, action, details, created_at from platform_audit_log where target_user_id = p_user order by created_at desc limit 50) l),
    'outreach_memberships', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', m.workspace_id, 'role', m.role, 'client_ids', m.client_ids, 'can_reply', m.can_reply, 'created_at', m.created_at)), '[]'::jsonb)
                               from outreach_members m where m.user_id = p_user)
  );
end $$;

create or replace function platform_admin_audit_log(p_limit int default 100, p_offset int default 0, p_user uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'total', (select count(*) from platform_audit_log where p_user is null or target_user_id = p_user),
    'rows', (select coalesce(jsonb_agg(to_jsonb(l) order by l.created_at desc), '[]'::jsonb)
               from (select * from platform_audit_log where p_user is null or target_user_id = p_user
                     order by created_at desc limit greatest(1, least(coalesce(p_limit, 100), 500)) offset greatest(0, coalesce(p_offset, 0))) l)
  );
end $$;

create or replace function platform_admin_settings() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'settings', (select coalesce(jsonb_object_agg(key, value), '{}') from platform_settings),
    'admins', (select coalesce(jsonb_agg(jsonb_build_object('user_id', a.user_id, 'email', coalesce(u.email, a.email), 'note', a.note, 'created_at', a.created_at) order by a.created_at), '[]'::jsonb)
                 from platform_admins a left join auth.users u on u.id = a.user_id)
  );
end $$;

-- -----------------------------------------------------------------------------
-- Admin: account status, features, notes, admins, settings
-- -----------------------------------------------------------------------------
/**
 * p_status: 'pending' | 'active' | 'blocked' | null (keep)
 * p_features: full replacement of the account's overrides ({} = all defaults) | null (keep)
 * p_note: text | null (keep). Send '' to clear.
 */
create or replace function platform_admin_set_access(p_user uuid, p_status text default null, p_features jsonb default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare before_row platform_user_access; k text; v jsonb;
begin
  perform platform_require_admin();
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'E_NOT_FOUND: no such account'; end if;
  if p_status is not null and p_status not in ('pending','active','blocked') then raise exception 'E_PAYLOAD_INVALID: status must be pending, active or blocked'; end if;
  if p_status = 'blocked' and p_user = auth.uid() then raise exception 'E_PAYLOAD_INVALID: you cannot block your own account'; end if;
  if p_features is not null then
    if jsonb_typeof(p_features) <> 'object' then raise exception 'E_PAYLOAD_INVALID: features must be an object'; end if;
    for k, v in select * from jsonb_each(p_features) loop
      if jsonb_typeof(v) <> 'boolean' then raise exception 'E_PAYLOAD_INVALID: feature "%" must be true or false', k; end if;
      if k !~ '^[a-z_]{1,40}$' then raise exception 'E_PAYLOAD_INVALID: bad feature key "%"', k; end if;
    end loop;
  end if;

  insert into platform_user_access(user_id) values (p_user) on conflict (user_id) do nothing;
  select * into before_row from platform_user_access where user_id = p_user;

  update platform_user_access set
    status      = coalesce(p_status, status),
    features    = coalesce(p_features, features),
    note        = case when p_note is null then note else nullif(p_note, '') end,
    approved_at = case when p_status = 'active' and status <> 'active' then now() else approved_at end,
    approved_by = case when p_status = 'active' and status <> 'active' then auth.uid() else approved_by end,
    updated_by  = auth.uid(),
    updated_at  = now()
  where user_id = p_user;

  perform platform_audit('access.updated', p_user, jsonb_strip_nulls(jsonb_build_object(
    'status', case when p_status is not null and p_status is distinct from before_row.status then jsonb_build_object('from', before_row.status, 'to', p_status) end,
    'features', case when p_features is not null and p_features is distinct from before_row.features then jsonb_build_object('from', before_row.features, 'to', p_features) end,
    'note', case when p_note is not null and nullif(p_note,'') is distinct from before_row.note then jsonb_build_object('from', before_row.note, 'to', nullif(p_note,'')) end
  )));
  return platform_admin__user_json(p_user);
end $$;

/** Approve / block many accounts at once (the list's bulk actions). */
create or replace function platform_admin_bulk_set_status(p_users uuid[], p_status text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid; n int := 0;
begin
  perform platform_require_admin();
  if p_status not in ('pending','active','blocked') then raise exception 'E_PAYLOAD_INVALID: status must be pending, active or blocked'; end if;
  foreach uid in array coalesce(p_users, '{}') loop
    if uid = auth.uid() and p_status = 'blocked' then continue; end if;
    if not exists (select 1 from auth.users where id = uid) then continue; end if;
    insert into platform_user_access(user_id, status, approved_at, approved_by, updated_by)
    values (uid, p_status, case when p_status = 'active' then now() end, case when p_status = 'active' then auth.uid() end, auth.uid())
    on conflict (user_id) do update set
      status = excluded.status,
      approved_at = case when excluded.status = 'active' and platform_user_access.status <> 'active' then now() else platform_user_access.approved_at end,
      approved_by = case when excluded.status = 'active' and platform_user_access.status <> 'active' then auth.uid() else platform_user_access.approved_by end,
      updated_by = auth.uid(), updated_at = now()
    where platform_user_access.status is distinct from excluded.status;
    if found then
      n := n + 1;
      perform platform_audit('access.updated', uid, jsonb_build_object('status', jsonb_build_object('to', p_status), 'bulk', true));
    end if;
  end loop;
  return n;
end $$;

create or replace function platform_admin_set_admin(p_user uuid, p_is_admin boolean, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'E_NOT_FOUND: no such account'; end if;
  if p_is_admin then
    insert into platform_admins(user_id, email, note, created_by)
    select id, email, p_note, auth.uid() from auth.users where id = p_user
    on conflict (user_id) do update set note = coalesce(excluded.note, platform_admins.note);
    -- an admin is always active
    insert into platform_user_access(user_id, status, approved_at, approved_by, updated_by) values (p_user, 'active', now(), auth.uid(), auth.uid())
    on conflict (user_id) do update set status = 'active', approved_at = coalesce(platform_user_access.approved_at, now()), updated_by = auth.uid(), updated_at = now();
    perform platform_audit('admin.granted', p_user, jsonb_strip_nulls(jsonb_build_object('note', p_note)));
  else
    if p_user = auth.uid() then raise exception 'E_PAYLOAD_INVALID: you cannot remove your own admin access'; end if;
    if (select count(*) from platform_admins) <= 1 then raise exception 'E_LAST_ADMIN: at least one admin must remain'; end if;
    delete from platform_admins where user_id = p_user;
    perform platform_audit('admin.revoked', p_user);
  end if;
  return platform_admin__user_json(p_user);
end $$;

create or replace function platform_admin_set_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k text; v jsonb; old jsonb;
begin
  perform platform_require_admin();
  if p_key = 'signup_mode' then
    if p_value not in ('"approval"'::jsonb, '"open"'::jsonb) then raise exception 'E_PAYLOAD_INVALID: signup_mode must be "approval" or "open"'; end if;
  elsif p_key = 'default_features' then
    if jsonb_typeof(p_value) <> 'object' then raise exception 'E_PAYLOAD_INVALID: default_features must be an object'; end if;
    for k, v in select * from jsonb_each(p_value) loop
      if jsonb_typeof(v) <> 'boolean' then raise exception 'E_PAYLOAD_INVALID: feature "%" must be true or false', k; end if;
    end loop;
  else
    raise exception 'E_PAYLOAD_INVALID: unknown setting %', p_key;
  end if;
  select value into old from platform_settings where key = p_key;
  insert into platform_settings(key, value, updated_by) values (p_key, p_value, auth.uid())
  on conflict (key) do update set value = excluded.value, updated_by = auth.uid(), updated_at = now();
  perform platform_audit('setting.updated', null, jsonb_build_object('key', p_key, 'from', old, 'to', p_value));
  return (select coalesce(jsonb_object_agg(key, value), '{}') from platform_settings);
end $$;

-- -----------------------------------------------------------------------------
-- Admin: fundraising plan + credits (user_settings)
-- -----------------------------------------------------------------------------
create or replace function platform_admin_set_billing(p_user uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s user_settings; upd jsonb := '{}'; v_plan text; v_status text; v_cycle text; v_renewal timestamptz;
begin
  perform platform_require_admin();
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'E_NOT_FOUND: no such account'; end if;
  insert into user_settings(id) values (p_user) on conflict (id) do nothing;
  select * into s from user_settings where id = p_user;

  if p_patch ? 'plan' then
    v_plan := p_patch->>'plan';
    if v_plan not in ('free','basic','pro') then raise exception 'E_PAYLOAD_INVALID: plan must be free, basic or pro'; end if;
    if v_plan is distinct from s.plan then upd := upd || jsonb_build_object('plan', jsonb_build_object('from', s.plan, 'to', v_plan)); end if;
    s.plan := v_plan;
  end if;
  if p_patch ? 'billing_status' then
    v_status := p_patch->>'billing_status';
    if v_status not in ('active','inactive','cancelled','past_due') then raise exception 'E_PAYLOAD_INVALID: billing_status must be active, inactive, cancelled or past_due'; end if;
    if v_status is distinct from s.status then upd := upd || jsonb_build_object('billing_status', jsonb_build_object('from', s.status, 'to', v_status)); end if;
    s.status := v_status;
  end if;
  if p_patch ? 'billing_cycle' then
    v_cycle := nullif(p_patch->>'billing_cycle', '');
    if v_cycle is not null and v_cycle not in ('monthly','quarterly','yearly') then raise exception 'E_PAYLOAD_INVALID: billing_cycle must be monthly, quarterly or yearly'; end if;
    if v_cycle is distinct from s.billing_cycle then upd := upd || jsonb_build_object('billing_cycle', jsonb_build_object('from', s.billing_cycle, 'to', v_cycle)); end if;
    s.billing_cycle := v_cycle;
  end if;
  if p_patch ? 'renewal_date' then
    v_renewal := nullif(p_patch->>'renewal_date', '')::timestamptz;
    if v_renewal is distinct from s.renewal_date then upd := upd || jsonb_build_object('renewal_date', jsonb_build_object('from', s.renewal_date, 'to', v_renewal)); end if;
    s.renewal_date := v_renewal;
  end if;

  update user_settings set plan = s.plan, status = s.status, billing_cycle = s.billing_cycle, renewal_date = s.renewal_date where id = p_user;
  if upd <> '{}'::jsonb then perform platform_audit('billing.updated', p_user, upd); end if;
  return platform_admin__user_json(p_user);
end $$;

/** Either add/remove credits (p_delta) or set the balance (p_set). Balance never goes below 0. */
create or replace function platform_admin_adjust_credits(p_user uuid, p_delta int default null, p_set int default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare before_c int; after_c int;
begin
  perform platform_require_admin();
  if not exists (select 1 from auth.users where id = p_user) then raise exception 'E_NOT_FOUND: no such account'; end if;
  if (p_delta is null) = (p_set is null) then raise exception 'E_PAYLOAD_INVALID: pass exactly one of delta or set'; end if;
  if p_set is not null and p_set < 0 then raise exception 'E_PAYLOAD_INVALID: credits cannot be negative'; end if;
  insert into user_settings(id) values (p_user) on conflict (id) do nothing;
  select coalesce(credits_remaining, 0) into before_c from user_settings where id = p_user for update;
  after_c := greatest(0, coalesce(p_set, before_c + p_delta));
  update user_settings set credits_remaining = after_c where id = p_user;
  perform platform_audit('credits.adjusted', p_user, jsonb_strip_nulls(jsonb_build_object('from', before_c, 'to', after_c, 'delta', after_c - before_c, 'note', nullif(p_note, ''))));
  return platform_admin__user_json(p_user);
end $$;

-- -----------------------------------------------------------------------------
-- Admin: outreach workspaces + memberships
-- -----------------------------------------------------------------------------
create or replace function platform_admin_outreach_workspaces(p_search text default null, p_include_deleted boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  perform platform_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'slug', w.slug, 'plan', w.plan, 'trial_ends_at', w.trial_ends_at,
      'stripe_status', w.stripe_status, 'past_due_since', w.past_due_since, 'created_at', w.created_at, 'deleted_at', w.deleted_at,
      'plan_before_suspension', w.settings->>'plan_before_suspension',
      'owner_email', (select u.email from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', coalesce(u.email, m.email::text), 'role', m.role, 'client_ids', m.client_ids, 'can_reply', m.can_reply) order by m.role, m.created_at), '[]'::jsonb)
                    from outreach_members m left join auth.users u on u.id = m.user_id where m.workspace_id = w.id),
      'senders', (select count(*) from outreach_senders s where s.workspace_id = w.id and s.deleted_at is null),
      'senders_ok', (select count(*) from outreach_senders s where s.workspace_id = w.id and s.deleted_at is null and s.status = 'ok'),
      'leads', (select count(*) from outreach_leads l where l.workspace_id = w.id),
      'sequences', (select count(*) from outreach_sequences q where q.workspace_id = w.id),
      'clients', (select count(*) from outreach_clients c where c.workspace_id = w.id),
      'actions_7d', (select count(*) from outreach_actions a where a.workspace_id = w.id and a.created_at > now() - interval '7 days')
    ) order by w.created_at desc), '[]'::jsonb)
    from outreach_workspaces w
   where (p_include_deleted or w.deleted_at is null)
     and (v_search is null or w.name ilike '%' || v_search || '%' or w.slug ilike '%' || v_search || '%' or w.id::text = v_search
          or exists (select 1 from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and u.email ilike '%' || v_search || '%')));
end $$;

/**
 * p_patch: {plan, trial_ends_at, name}
 * plan: trial | team | agency | agency_plus | suspended. Suspending pauses every connected sender (status_reason
 * 'billing_suspended', the same reason the billing sync uses) so lifting the suspension resumes them.
 */
create or replace function platform_admin_outreach_set_workspace(p_ws uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces; upd jsonb := '{}'; v_plan text; v_trial timestamptz; v_name text; n int;
begin
  perform platform_require_admin();
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND: no such workspace'; end if;

  if p_patch ? 'name' then
    v_name := nullif(trim(p_patch->>'name'), '');
    if v_name is null then raise exception 'E_PAYLOAD_INVALID: name is required'; end if;
    if v_name <> w.name then upd := upd || jsonb_build_object('name', jsonb_build_object('from', w.name, 'to', v_name)); update outreach_workspaces set name = v_name where id = p_ws; end if;
  end if;
  if p_patch ? 'trial_ends_at' then
    v_trial := nullif(p_patch->>'trial_ends_at', '')::timestamptz;
    if v_trial is null then raise exception 'E_PAYLOAD_INVALID: trial_ends_at is required'; end if;
    if v_trial <> w.trial_ends_at then upd := upd || jsonb_build_object('trial_ends_at', jsonb_build_object('from', w.trial_ends_at, 'to', v_trial)); update outreach_workspaces set trial_ends_at = v_trial where id = p_ws; end if;
  end if;
  if p_patch ? 'plan' then
    v_plan := p_patch->>'plan';
    if v_plan not in ('trial','team','agency','agency_plus','suspended') then raise exception 'E_PAYLOAD_INVALID: plan must be trial, team, agency, agency_plus or suspended'; end if;
    if v_plan <> w.plan then
      upd := upd || jsonb_build_object('plan', jsonb_build_object('from', w.plan, 'to', v_plan));
      if v_plan = 'suspended' then
        update outreach_workspaces set plan = 'suspended', settings = settings || jsonb_build_object('plan_before_suspension', w.plan) where id = p_ws;
        update outreach_senders set status = 'paused', status_reason = 'billing_suspended' where workspace_id = p_ws and status = 'ok' and deleted_at is null;
        get diagnostics n = row_count;
        upd := upd || jsonb_build_object('senders_paused', n);
      else
        update outreach_workspaces set plan = v_plan, past_due_since = null, settings = settings - 'plan_before_suspension' where id = p_ws;
        if w.plan = 'suspended' then
          update outreach_senders set status = 'ok', status_reason = null where workspace_id = p_ws and status = 'paused' and status_reason in ('billing_suspended','trial_expired') and deleted_at is null;
          get diagnostics n = row_count;
          upd := upd || jsonb_build_object('senders_resumed', n);
        end if;
      end if;
    end if;
  end if;

  if upd <> '{}'::jsonb then
    perform platform_audit('outreach.workspace_updated', w.created_by, upd || jsonb_build_object('workspace_id', p_ws, 'workspace', w.name));
    perform outreach_audit(p_ws, 'workspace.admin_updated', 'workspace', p_ws::text, upd, 'admin');
  end if;
  return (select x from jsonb_array_elements(platform_admin_outreach_workspaces(p_ws::text, true)) x limit 1);
end $$;

/** Add, change or remove (p_role = null) a workspace member. Cannot remove the last owner. */
create or replace function platform_admin_outreach_set_member(p_ws uuid, p_user uuid, p_role text, p_client_ids uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces; cur outreach_members; em text;
begin
  perform platform_require_admin();
  select * into w from outreach_workspaces where id = p_ws and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND: no such workspace'; end if;
  select email into em from auth.users where id = p_user;
  if em is null then raise exception 'E_NOT_FOUND: no such account'; end if;
  select * into cur from outreach_members where workspace_id = p_ws and user_id = p_user;

  if p_role is null then
    if cur.user_id is null then return platform_admin__user_json(p_user); end if;
    if cur.role = 'owner' and (select count(*) from outreach_members where workspace_id = p_ws and role = 'owner') <= 1 then
      raise exception 'E_PAYLOAD_INVALID: a workspace needs at least one owner';
    end if;
    delete from outreach_members where workspace_id = p_ws and user_id = p_user;
    perform platform_audit('outreach.member_removed', p_user, jsonb_build_object('workspace_id', p_ws, 'workspace', w.name, 'role', cur.role));
    perform outreach_audit(p_ws, 'member.admin_removed', 'member', p_user::text, jsonb_build_object('role', cur.role), 'admin');
  else
    if p_role not in ('owner','manager','member','client_viewer') then raise exception 'E_PAYLOAD_INVALID: role must be owner, manager, member or client_viewer'; end if;
    if cur.user_id is not null and cur.role = 'owner' and p_role <> 'owner' and (select count(*) from outreach_members where workspace_id = p_ws and role = 'owner') <= 1 then
      raise exception 'E_PAYLOAD_INVALID: a workspace needs at least one owner';
    end if;
    insert into outreach_members(workspace_id, user_id, role, client_ids, email)
    values (p_ws, p_user, p_role::outreach_role_t, coalesce(p_client_ids, '{}'), em::citext)
    on conflict (workspace_id, user_id) do update set role = excluded.role, client_ids = coalesce(p_client_ids, outreach_members.client_ids);
    perform platform_audit(case when cur.user_id is null then 'outreach.member_added' else 'outreach.member_updated' end, p_user,
      jsonb_strip_nulls(jsonb_build_object('workspace_id', p_ws, 'workspace', w.name, 'role', p_role, 'from_role', cur.role, 'client_ids', to_jsonb(p_client_ids))));
    perform outreach_audit(p_ws, case when cur.user_id is null then 'member.admin_added' else 'member.admin_updated' end, 'member', p_user::text, jsonb_build_object('role', p_role), 'admin');
  end if;
  return platform_admin__user_json(p_user);
end $$;

/** Give an account a workspace of its own when it has none (same defaults as the self-serve path). */
create or replace function platform_admin_outreach_create_workspace(p_user uuid, p_name text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces; em text; base text; v_slug text; i int := 0; nm text;
begin
  perform platform_require_admin();
  select email into em from auth.users where id = p_user;
  if em is null then raise exception 'E_NOT_FOUND: no such account'; end if;
  nm := coalesce(nullif(trim(p_name), ''), split_part(em, '@', 1) || '''s workspace');
  base := coalesce(nullif(outreach_slugify(nm), ''), 'workspace');
  v_slug := base;
  while exists (select 1 from outreach_workspaces x where x.slug = v_slug) loop
    i := i + 1; v_slug := base || '-' || substr(encode(gen_random_bytes(3), 'hex'), 1, 4);
    if i > 10 then v_slug := base || '-' || encode(gen_random_bytes(6), 'hex'); end if;
  end loop;
  insert into outreach_workspaces(name, slug, created_by) values (nm, v_slug, p_user) returning * into w;
  insert into outreach_members(workspace_id, user_id, role, email) values (w.id, p_user, 'owner', em::citext);
  perform outreach_seed_workspace_defaults(w.id);
  perform outreach_audit(w.id, 'workspace.created', 'workspace', w.id::text, jsonb_build_object('by', 'admin'), 'admin');
  perform platform_audit('outreach.workspace_created', p_user, jsonb_build_object('workspace_id', w.id, 'workspace', w.name));
  return platform_admin__user_json(p_user);
end $$;

-- -----------------------------------------------------------------------------
-- Admin: CRM team
-- -----------------------------------------------------------------------------
create or replace function platform_admin_crm_members() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', m.user_id, 'email', coalesce(u.email, m.email), 'display_name', m.display_name, 'is_active', m.is_active, 'created_at', m.created_at,
      'deals_owned', (select count(*) from crm_deals d where d.owner_id = m.user_id),
      'meetings', (select count(*) from crm_meetings x where x.created_by = m.user_id)
    ) order by m.is_active desc, m.display_name), '[]'::jsonb)
    from crm_members m left join auth.users u on u.id = m.user_id);
end $$;

/** Add (p_active = true, creates the row when missing), deactivate (false) or rename a CRM team member. */
create or replace function platform_admin_crm_set_member(p_user uuid, p_active boolean default null, p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare em text; cur crm_members;
begin
  perform platform_require_admin();
  select email into em from auth.users where id = p_user;
  if em is null then raise exception 'E_NOT_FOUND: no such account'; end if;
  select * into cur from crm_members where user_id = p_user;
  if cur.user_id is null then
    if p_active is distinct from true then return platform_admin__user_json(p_user); end if;
    insert into crm_members(user_id, display_name, email)
    values (p_user, coalesce(nullif(trim(p_display_name), ''), split_part(em, '@', 1)), lower(em));
    perform platform_audit('crm.member_added', p_user, jsonb_build_object('display_name', coalesce(nullif(trim(p_display_name), ''), split_part(em, '@', 1))));
  else
    if p_active = false and (select count(*) from crm_members where is_active) <= 1 and cur.is_active then
      raise exception 'E_LAST_MEMBER: the CRM needs at least one active member';
    end if;
    update crm_members set is_active = coalesce(p_active, is_active), display_name = coalesce(nullif(trim(p_display_name), ''), display_name), email = coalesce(email, lower(em)) where user_id = p_user;
    perform platform_audit('crm.member_updated', p_user, jsonb_strip_nulls(jsonb_build_object(
      'is_active', case when p_active is not null and p_active is distinct from cur.is_active then jsonb_build_object('from', cur.is_active, 'to', p_active) end,
      'display_name', case when nullif(trim(p_display_name), '') is not null and nullif(trim(p_display_name), '') <> cur.display_name then jsonb_build_object('from', cur.display_name, 'to', trim(p_display_name)) end)));
  end if;
  return platform_admin__user_json(p_user);
end $$;

-- -----------------------------------------------------------------------------
-- Enforcement hooks in the other products
-- -----------------------------------------------------------------------------
-- Outreach: a member whose account is pending/blocked, or whose outreach feature is off, has no role anywhere.
-- (Same body as before + the platform_can_use check. API keys still act as a member through the GUC.)
create or replace function outreach_role_in(ws uuid) returns outreach_role_t
language sql stable security definer set search_path = public, extensions as $$
  select case when nullif(current_setting('outreach.key_role', true), '') is null then m.role
              else greatest(m.role, current_setting('outreach.key_role', true)::outreach_role_t) end   -- enum order: owner < manager < member < client_viewer
    from outreach_members m
   where m.user_id = auth.uid() and m.workspace_id = ws
     and platform_can_use(auth.uid(), 'outreach')
$$;

create or replace function outreach_workspace_ids() returns setof uuid
language sql stable security definer set search_path = public, extensions as $$
  select workspace_id from outreach_members where user_id = auth.uid() and platform_can_use(auth.uid(), 'outreach')
$$;

create or replace function outreach_my_workspaces()
returns table(id uuid, name text, slug text, plan text, role outreach_role_t, client_ids uuid[], can_reply boolean, settings jsonb, trial_ends_at timestamptz, stripe_status text, past_due_since timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not platform_can_use(auth.uid(), 'outreach') then raise exception 'E_FEATURE_DISABLED: outreach is not enabled for this account'; end if;
  return query
  select ws.id, ws.name, ws.slug, ws.plan, m.role, m.client_ids, m.can_reply, ws.settings, ws.trial_ends_at, ws.stripe_status, ws.past_due_since
  from outreach_workspaces ws join outreach_members m on m.workspace_id = ws.id
  where m.user_id = auth.uid() and ws.deleted_at is null
  order by m.created_at;
end $$;

create or replace function outreach_create_workspace(p_name text)
returns outreach_workspaces language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; base text; v_slug text; i int := 0;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN: auth required'; end if;
  if not platform_can_use(auth.uid(), 'outreach') then raise exception 'E_FEATURE_DISABLED: outreach is not enabled for this account'; end if;
  base := coalesce(nullif(outreach_slugify(p_name),''), 'workspace');
  v_slug := base;
  while exists (select 1 from outreach_workspaces x where x.slug = v_slug) loop
    i := i + 1; v_slug := base || '-' || substr(encode(gen_random_bytes(3),'hex'),1,4);
    if i > 10 then v_slug := base || '-' || encode(gen_random_bytes(6),'hex'); end if;
  end loop;
  insert into outreach_workspaces(name, slug, created_by) values (coalesce(nullif(p_name,''),'My Workspace'), v_slug, auth.uid()) returning * into w;
  insert into outreach_members(workspace_id, user_id, role, email) values (w.id, auth.uid(), 'owner', auth.email());
  perform outreach_seed_workspace_defaults(w.id);
  perform outreach_audit(w.id, 'workspace.created', 'workspace', w.id::text);
  return w;
end $$;

create or replace function outreach_ensure_workspace(p_name text default null)
returns outreach_workspaces language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN: auth required'; end if;
  if not platform_can_use(auth.uid(), 'outreach') then raise exception 'E_FEATURE_DISABLED: outreach is not enabled for this account'; end if;
  select ws.* into w from outreach_workspaces ws join outreach_members m on m.workspace_id = ws.id
   where m.user_id = auth.uid() and ws.deleted_at is null
   order by (m.role = 'owner') desc, m.created_at asc limit 1;
  if found then return w; end if;
  return outreach_create_workspace(coalesce(p_name, split_part(coalesce(auth.email(),'My'),'@',1) || '''s workspace'));
end $$;

-- CRM: membership only counts for an active account.
create or replace function crm_is_member() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select platform_status_ok(auth.uid())
     and exists (select 1 from crm_members m where m.user_id = auth.uid() and m.is_active)
$$;

-- Fundraising: spending a credit needs an active account with the fundraising feature on.
create or replace function upsert_investor_ai_metadata(p_user_id uuid, p_investor_id uuid, new_ai_metadata jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_exists boolean;
  v_credits int;
  v_status text;
begin
  if p_user_id != auth.uid() then
    raise exception 'Unauthorized';
  end if;
  if not platform_can_use(p_user_id, 'fundraising') then
    raise exception 'Fundraising is not enabled for this account';
  end if;

  select credits_remaining, status into v_credits, v_status from user_settings where id = p_user_id for update;

  if v_status = 'inactive' then
    raise exception 'Account inactive';
  end if;

  select exists (select 1 from investor_personalization where user_id = p_user_id and investor_id = p_investor_id) into v_exists;

  if not v_exists then
    if v_credits is null or v_credits < 1 then
      raise exception 'Insufficient credits';
    end if;
    update user_settings set credits_remaining = credits_remaining - 1 where id = p_user_id;
    insert into credit_usage (user_id, action, credits_used, related_investor_id)
    values (p_user_id, 'AI Investor Analysis', 1, p_investor_id);
  end if;

  insert into investor_personalization (user_id, investor_id, ai_metadata)
  values (p_user_id, p_investor_id, new_ai_metadata)
  on conflict (user_id, investor_id)
  do update set ai_metadata = excluded.ai_metadata, updated_at = now();
end $$;

-- -----------------------------------------------------------------------------
-- Grants: nothing for anon/PUBLIC; signed-in users may call the platform_* functions (each checks admin itself);
-- trigger + internal functions are not callable directly.
-- -----------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid, p.proname, p.oid::regprocedure::text as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'platform\_%' and p.prokind = 'f' loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname like 'platform\_trg\_%' or f.proname like 'platform\_admin\_\_%' or f.proname = 'platform_audit' then
      execute format('revoke execute on function %s from authenticated', f.sig);
    else
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
