-- =============================================================================
-- Smartlead MCP layer — 001 schema + functions (idempotent)
-- Built from smartlead-mcp-prd.md. Everything is `smartlead_`-prefixed, same
-- convention as crm_* / outreach_*.
--
-- Smartlead itself is the system of record for campaigns, mailboxes and threads.
-- This schema only holds what the MCP layer owns:
--   smartlead_members              who on the team may use the connector (PRD §4: team only)
--   smartlead_settings             send caps + burn thresholds (key/value)
--   smartlead_reply_log            AUDIT TRAIL — every approved reply, body verbatim (PRD §6.7)
--   smartlead_agent_confirmations  two-step approval tokens bound to the exact arguments (PRD §6.1/6.2)
--   smartlead_agent_calls          connector call log
--
-- Apply:  Supabase MCP apply_migration, or  bash scripts/outreach-sql.sh migrations/smartlead/001_schema.sql
-- =============================================================================

create table if not exists smartlead_members (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  display_name  text not null,
  email         text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists smartlead_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

insert into smartlead_settings(key, value) values
  ('max_sends_per_hour_per_user', '10'),     -- PRD §6.8 "session cap": the MCP is stateless per request, so the cap is a rolling hour per user
  ('max_sends_per_day_team',      '40'),
  ('bounce_rate_threshold',       '0.03'),   -- burn check: bounced / sent over the window
  ('warmup_spam_rate_threshold',  '0.05'),   -- warmup mails landing in spam / warmup mails sent
  ('warmup_min_reputation',       '90'),
  ('timezone',                    '"Asia/Kolkata"')
on conflict (key) do nothing;

-- Every approved reply. The row is inserted (status 'pending') BEFORE the call to
-- Smartlead and the send is aborted if the insert fails: if it is not in the log
-- it did not happen.
create table if not exists smartlead_reply_log (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null,
  user_email          text,
  campaign_id         bigint not null,
  campaign_name       text,
  lead_id             bigint not null,
  lead_email          text,
  mailbox             text,                       -- sender mailbox that owns the conversation
  email_stats_id      text not null,              -- the message replied to
  reply_message_id    text,
  to_email            text,
  cc                  text,
  bcc                 text,
  add_signature       boolean not null default true,
  attachments         jsonb,
  approved_body       text not null,              -- exactly what was shown in chat and approved
  sent_body_html      text not null,              -- what went on the wire (approved_body, newline→<br> only when it had no HTML)
  body_sha256         text not null,
  confirmation_token  text,
  status              text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  smartlead_response  jsonb,
  error               text,
  approved_at         timestamptz not null default now(),
  sent_at             timestamptz
);
create index if not exists smartlead_reply_log_at_idx on smartlead_reply_log (approved_at desc);
create index if not exists smartlead_reply_log_user_idx on smartlead_reply_log (user_id, approved_at desc);
create index if not exists smartlead_reply_log_lead_idx on smartlead_reply_log (lower(lead_email));

create table if not exists smartlead_agent_confirmations (
  token           text primary key,
  user_id         uuid not null,
  tool            text not null,
  args_sha256     text not null,
  effect_summary  text not null,
  payload         jsonb,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);

create table if not exists smartlead_agent_calls (
  id           bigserial primary key,
  user_id      uuid,
  tool         text not null,
  args_sha256  text,
  outcome      text,
  error_code   text,
  duration_ms  int,
  at           timestamptz not null default now()
);
create index if not exists smartlead_agent_calls_at_idx on smartlead_agent_calls (at desc);

-- -----------------------------------------------------------------------------
-- Membership helpers + RLS
-- -----------------------------------------------------------------------------

create or replace function smartlead_is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from smartlead_members m where m.user_id = auth.uid() and m.is_active);
$$;

create or replace function smartlead_require_member() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  if not smartlead_is_member() then raise exception 'E_FORBIDDEN: you are not on the Smartlead email-ops team (a member can add you with smartlead_add_member)'; end if;
end $$;

alter table smartlead_members enable row level security;
drop policy if exists smartlead_members_read on smartlead_members;
create policy smartlead_members_read on smartlead_members for select to authenticated using (smartlead_is_member() or user_id = auth.uid());

alter table smartlead_settings enable row level security;
drop policy if exists smartlead_settings_read on smartlead_settings;
create policy smartlead_settings_read on smartlead_settings for select to authenticated using (smartlead_is_member());

alter table smartlead_reply_log enable row level security;
drop policy if exists smartlead_reply_log_read on smartlead_reply_log;
create policy smartlead_reply_log_read on smartlead_reply_log for select to authenticated using (smartlead_is_member());
-- no insert/update/delete policies: the log is written by the connector (service role) only, and never edited by hand

alter table smartlead_agent_confirmations enable row level security;  -- no policies: service role only
alter table smartlead_agent_calls enable row level security;          -- no policies: service role only

-- -----------------------------------------------------------------------------
-- RPCs
-- -----------------------------------------------------------------------------

create or replace function smartlead_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me smartlead_members; is_m boolean := smartlead_is_member();
begin
  if auth.uid() is null then raise exception 'E_UNAUTHORIZED: sign in first'; end if;
  select * into me from smartlead_members where user_id = auth.uid();
  return jsonb_build_object(
    'user_id', auth.uid(),
    'is_member', is_m,
    'me', case when me.user_id is null then null else jsonb_build_object('user_id', me.user_id, 'display_name', me.display_name, 'email', me.email, 'is_active', me.is_active) end,
    'settings', case when is_m then (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from smartlead_settings) else '{}'::jsonb end
  );
end $$;

create or replace function smartlead_add_member(p_email text, p_display_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid; r smartlead_members;
begin
  perform smartlead_require_member();
  select id into uid from auth.users where lower(email) = lower(trim(p_email)) limit 1;
  if uid is null then raise exception 'E_NOT_FOUND: no app account with email % — they must sign up in the app first', p_email; end if;
  insert into smartlead_members(user_id, display_name, email)
  values (uid, coalesce(nullif(trim(p_display_name), ''), split_part(p_email, '@', 1)), lower(trim(p_email)))
  on conflict (user_id) do update set is_active = true, display_name = coalesce(nullif(trim(excluded.display_name), ''), smartlead_members.display_name), email = excluded.email
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function smartlead_set_member_active(p_user_id uuid, p_is_active boolean) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r smartlead_members;
begin
  perform smartlead_require_member();
  if p_is_active = false and (select count(*) from smartlead_members where is_active and user_id <> p_user_id) = 0 then
    raise exception 'E_LAST_MEMBER: at least one active member must remain';
  end if;
  update smartlead_members set is_active = p_is_active where user_id = p_user_id returning * into r;
  if r.user_id is null then raise exception 'E_NOT_FOUND: no such member'; end if;
  return to_jsonb(r);
end $$;

create or replace function smartlead_set_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform smartlead_require_member();
  if p_key not in ('max_sends_per_hour_per_user', 'max_sends_per_day_team', 'bounce_rate_threshold', 'warmup_spam_rate_threshold', 'warmup_min_reputation', 'timezone') then
    raise exception 'E_PAYLOAD_INVALID: unknown setting %', p_key;
  end if;
  insert into smartlead_settings(key, value) values (p_key, p_value)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return jsonb_build_object('key', p_key, 'value', p_value);
end $$;

-- housekeeping: expired approval tokens + old call log (called opportunistically by the connector)
create or replace function smartlead_agent_gc() returns void
language sql security definer set search_path = public as $$
  delete from smartlead_agent_confirmations where created_at < now() - interval '2 days';
  delete from smartlead_agent_calls where at < now() - interval '90 days';
$$;

revoke all on function smartlead_context(), smartlead_add_member(text, text), smartlead_set_member_active(uuid, boolean), smartlead_set_setting(text, jsonb), smartlead_agent_gc() from public, anon;
grant execute on function smartlead_context(), smartlead_add_member(text, text), smartlead_set_member_active(uuid, boolean), smartlead_set_setting(text, jsonb) to authenticated;
grant execute on function smartlead_agent_gc() to service_role;
revoke all on function smartlead_is_member(), smartlead_require_member() from public, anon;
grant execute on function smartlead_is_member(), smartlead_require_member() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- Seed: the same internal team that runs the sales CRM (only when empty)
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from smartlead_members) and to_regclass('public.crm_members') is not null then
    insert into smartlead_members(user_id, display_name, email, is_active)
    select user_id, display_name, email, is_active from crm_members
    on conflict (user_id) do nothing;
  end if;
end $$;
