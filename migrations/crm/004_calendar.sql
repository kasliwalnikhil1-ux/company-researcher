-- =============================================================================
-- Sales CRM — 004: Google Calendar (team calendars + meeting ↔ event link)
-- Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/crm/004_calendar.sql
--
-- Each CRM member connects one or more Google accounts (work, personal, …) once, in the app
-- (CRM → Calendar → Connect) or from a connector link (calendar_connect_link). The sign-in
-- (Google refresh token) is stored here encrypted; only the crm-mcp edge function holds the
-- key (CRM_TOKEN_KEY) and it never returns a token to a client. The whole team sees every
-- connected account's events; only the owning member's accounts can create/edit/cancel.
-- A CRM meeting may be linked to one Google event (crm_meeting_calendar_events): booking a
-- CRM meeting creates the event (Meet link + invites), and an event booked on the Calendar
-- screen can be attached to a company/deal, which creates the CRM meeting.
-- =============================================================================

create table if not exists crm_calendar_accounts (
  id                 uuid primary key default gen_random_uuid(),
  member_id          uuid not null references crm_members(user_id) on delete cascade,
  email              text not null,
  label              text,                                   -- "work" / "personal" — shown in the app, usable as an alias
  aliases            text[] not null default '{}',           -- extra names the connector resolves ("kaptured", "gmail")
  is_default         boolean not null default false,         -- the member's booking account when none is named
  scopes             text[] not null default '{}',
  calendars          jsonb not null default '[]'::jsonb,     -- [{id, summary, primary, access_role, background_color}] refreshed on connect / accounts(refresh)
  timezone           text,                                   -- the account's Google Calendar timezone
  refresh_token_enc  text not null,                          -- AES-256-GCM (key CRM_TOKEN_KEY, crm-mcp only); base64 iv‖ciphertext
  auth_state         text not null default 'ok',             -- ok | revoked (Google refused the saved sign-in → reconnect)
  auth_error         text,
  connected_at       timestamptz not null default now(),
  last_used_at       timestamptz,
  updated_at         timestamptz not null default now(),
  unique (member_id, email)
);
create index if not exists crm_calendar_accounts_member_idx on crm_calendar_accounts (member_id);

-- one Google event per CRM meeting
create table if not exists crm_meeting_calendar_events (
  meeting_id     uuid primary key references crm_meetings(id) on delete cascade,
  account_id     uuid references crm_calendar_accounts(id) on delete set null,
  account_email  text not null,                              -- kept when the account is disconnected, for display
  calendar_id    text not null default 'primary',
  event_id       text not null,
  meet_link      text,
  html_link      text,
  event_start    timestamptz,
  event_end      timestamptz,
  summary        text,
  created_by     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists crm_meeting_calendar_events_event_idx on crm_meeting_calendar_events (event_id);

-- every stored email is lowercase + trimmed (migrations/normalize_email_columns.sql)
do $$ begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'normalize_email_columns') then
    execute 'drop trigger if exists a0_normalize_emails on crm_calendar_accounts';
    execute 'create trigger a0_normalize_emails before insert or update on crm_calendar_accounts for each row execute function public.normalize_email_columns(''email'')';
    execute 'drop trigger if exists a0_normalize_emails on crm_meeting_calendar_events';
    execute 'create trigger a0_normalize_emails before insert or update on crm_meeting_calendar_events for each row execute function public.normalize_email_columns(''account_email'')';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS: the accounts table holds encrypted tokens → NO policy for authenticated (deny all);
-- members read it through crm_calendar_accounts_list() (safe columns only) and the edge function
-- reads/writes it with the service role. The link table is ordinary team data.
-- ---------------------------------------------------------------------------
alter table crm_calendar_accounts enable row level security;
drop policy if exists crm_member_all on crm_calendar_accounts;
alter table crm_meeting_calendar_events enable row level security;
drop policy if exists crm_member_all on crm_meeting_calendar_events;
create policy crm_member_all on crm_meeting_calendar_events for all to authenticated using (crm_is_member()) with check (crm_is_member());
revoke all on crm_calendar_accounts from anon, authenticated;
grant select, insert, update, delete on crm_meeting_calendar_events to authenticated;

-- ---------------------------------------------------------------------------
-- Accounts (safe columns; the token column never leaves the table)
-- ---------------------------------------------------------------------------
create or replace function crm_calendar_accounts_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform crm_require_member();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', a.id, 'member_id', a.member_id, 'member_name', m.display_name, 'mine', a.member_id = auth.uid(),
      'email', a.email, 'label', a.label, 'aliases', to_jsonb(a.aliases), 'is_default', a.is_default,
      'can_write', 'https://www.googleapis.com/auth/calendar.events' = any(a.scopes) or 'https://www.googleapis.com/auth/calendar' = any(a.scopes),
      'calendars', a.calendars, 'timezone', a.timezone, 'auth_state', a.auth_state, 'auth_error', a.auth_error,
      'connected_at', a.connected_at, 'last_used_at', a.last_used_at
    ) order by (a.member_id = auth.uid()) desc, m.display_name, a.is_default desc, a.email)
    from crm_calendar_accounts a join crm_members m on m.user_id = a.member_id
    where m.is_active
  ), '[]'::jsonb);
end $$;

/** label / aliases / is_default of one of MY accounts. Setting is_default clears the member's other default. */
create or replace function crm_calendar_account_update(p_account_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a crm_calendar_accounts;
begin
  perform crm_require_member();
  select * into a from crm_calendar_accounts where id = p_account_id;
  if a.id is null then raise exception 'E_NOT_FOUND: calendar account % not found', p_account_id; end if;
  if a.member_id <> auth.uid() then raise exception 'E_FORBIDDEN: only the member who connected % can change it', a.email; end if;
  if coalesce((p->>'is_default')::boolean, false) then
    update crm_calendar_accounts set is_default = false, updated_at = now() where member_id = a.member_id and id <> a.id and is_default;
  end if;
  update crm_calendar_accounts set
    label = case when p ? 'label' then nullif(trim(p->>'label'), '') else label end,
    aliases = case when jsonb_typeof(p->'aliases') = 'array' then (select coalesce(array_agg(lower(trim(x))), '{}') from jsonb_array_elements_text(p->'aliases') x where trim(x) <> '') else aliases end,
    is_default = coalesce((p->>'is_default')::boolean, is_default),
    updated_at = now()
  where id = a.id;
  return (select x from jsonb_array_elements(crm_calendar_accounts_list()) x where (x->>'id')::uuid = a.id);
end $$;

/** Disconnect one of MY accounts. Linked meetings keep their event ids (display only) — the event itself stays in Google. */
create or replace function crm_calendar_account_delete(p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare a crm_calendar_accounts; n int;
begin
  perform crm_require_member();
  select * into a from crm_calendar_accounts where id = p_account_id;
  if a.id is null then raise exception 'E_NOT_FOUND: calendar account % not found', p_account_id; end if;
  if a.member_id <> auth.uid() then raise exception 'E_FORBIDDEN: only the member who connected % can disconnect it', a.email; end if;
  select count(*) into n from crm_meeting_calendar_events where account_id = a.id;
  delete from crm_calendar_accounts where id = a.id;
  -- promote another account of the member to default so booking keeps working
  if a.is_default then
    update crm_calendar_accounts set is_default = true where id = (select id from crm_calendar_accounts where member_id = a.member_id order by connected_at limit 1);
  end if;
  return jsonb_build_object('deleted', true, 'email', a.email, 'linked_meetings_kept', n);
end $$;

-- ---------------------------------------------------------------------------
-- Meeting ↔ event link
-- ---------------------------------------------------------------------------
create or replace function crm_link_calendar_event(p_meeting_id uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r crm_meeting_calendar_events; acc crm_calendar_accounts;
begin
  perform crm_require_member();
  if not exists (select 1 from crm_meetings where id = p_meeting_id) then raise exception 'E_NOT_FOUND: meeting % not found', p_meeting_id; end if;
  if nullif(trim(p->>'event_id'), '') is null then raise exception 'E_PAYLOAD_INVALID: event_id is required'; end if;
  if p->>'account_id' is not null then
    select * into acc from crm_calendar_accounts where id = (p->>'account_id')::uuid;
    if acc.id is null then raise exception 'E_NOT_FOUND: calendar account % not found', p->>'account_id'; end if;
  end if;
  insert into crm_meeting_calendar_events(meeting_id, account_id, account_email, calendar_id, event_id, meet_link, html_link, event_start, event_end, summary, created_by)
  values (p_meeting_id, acc.id, coalesce(acc.email, p->>'account_email', ''), coalesce(nullif(p->>'calendar_id', ''), 'primary'), p->>'event_id', p->>'meet_link', p->>'html_link',
          (p->>'event_start')::timestamptz, (p->>'event_end')::timestamptz, p->>'summary', auth.uid())
  on conflict (meeting_id) do update set
    account_id = excluded.account_id, account_email = excluded.account_email, calendar_id = excluded.calendar_id, event_id = excluded.event_id,
    meet_link = excluded.meet_link, html_link = excluded.html_link, event_start = excluded.event_start, event_end = excluded.event_end, summary = excluded.summary, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function crm_unlink_calendar_event(p_meeting_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r crm_meeting_calendar_events;
begin
  perform crm_require_member();
  delete from crm_meeting_calendar_events where meeting_id = p_meeting_id returning * into r;
  return jsonb_build_object('unlinked', r.meeting_id is not null, 'event_id', r.event_id);
end $$;

/** The link row of a meeting (null when none) — used by the connector/app before touching the Google event. */
create or replace function crm_meeting_calendar_event(p_meeting_id uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select to_jsonb(e) from crm_meeting_calendar_events e where e.meeting_id = p_meeting_id
$$;

-- ---------------------------------------------------------------------------
-- crm_meetings_v: append the link (new columns go LAST — create or replace view cannot reorder)
-- ---------------------------------------------------------------------------
create or replace view crm_meetings_v with (security_invoker = true) as
select mt.*,
       d.company_id, c.name as company_name, d.stage as deal_stage, d.value_monthly, d.currency, d.value_monthly_usd, d.owner_id,
       ct.name as contact_name, ct.role as contact_role, ct.email as contact_email,
       seg.label as icp_segment_label, ch.label as source_channel_label,
       (cap.id is not null) as has_capture, cap.outcome as capture_outcome,
       (tr.id is not null) as has_transcript,
       (rec.id is not null) as has_recording,
       (cc.id is not null) as has_coaching, cc.execution_score as coaching_score,
       (ce.event_id is not null) as has_calendar_event, ce.meet_link, ce.html_link as calendar_link, ce.account_email as calendar_account
from crm_meetings mt
join crm_deals d on d.id = mt.deal_id
join crm_companies c on c.id = d.company_id
left join crm_contacts ct on ct.id = mt.contact_id
left join crm_icp_segments seg on seg.id = c.icp_segment_id
left join crm_source_channels ch on ch.id = d.source_channel_id
left join crm_meeting_captures cap on cap.meeting_id = mt.id
left join crm_meeting_transcripts tr on tr.meeting_id = mt.id
left join crm_meeting_recordings rec on rec.meeting_id = mt.id
left join crm_call_coaching cc on cc.meeting_id = mt.id
left join crm_meeting_calendar_events ce on ce.meeting_id = mt.id;

-- ---------------------------------------------------------------------------
-- Grants (same loop as 002): RPCs for signed-in users only; the guards are inside
-- ---------------------------------------------------------------------------
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'crm\_calendar\_%' or (n.nspname = 'public' and p.proname in ('crm_link_calendar_event','crm_unlink_calendar_event','crm_meeting_calendar_event')) loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
