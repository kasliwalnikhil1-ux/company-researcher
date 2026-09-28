-- Every stored email is lowercase with no leading/trailing whitespace, whichever path wrote it
-- (forms, edge functions, MCP tools, CSV imports, provider sync, direct RLS writes).
--
-- normalize_email_text: lower + trim each comma-separated part (investors.email and companies.email hold
-- "a@x.com, b@y.com" lists; smartlead cc/bcc are comma-joined), drop empty parts, rejoin with ", ".
-- Trims regular whitespace plus the no-break space / zero-width space / BOM that pasting brings along.
-- A single address comes back as lower(trim(address)). Blank stays '' (not NULL): companies.email uses ''
-- for "no email" on ~4k rows and the UI filters on that, so emptiness semantics are left alone.
create or replace function public.normalize_email_text(p text) returns text
language sql immutable strict parallel safe set search_path = pg_catalog as $$
  select array_to_string(array(
    select lower(t) from (
      select regexp_replace(part, '^[[:space:] ​﻿]+|[[:space:] ​﻿]+$', '', 'g') as t, ord
      from unnest(string_to_array(p, ',')) with ordinality as u(part, ord)
    ) s where t <> '' order by ord
  ), ', ')
$$;

-- BEFORE INSERT/UPDATE trigger: the column names come in as trigger arguments.
--   text / citext columns        -> normalize_email_text
--   text[] / citext[] columns    -> each element normalized, blanks dropped
--   jsonb arrays of objects      -> each object's "email" key normalized (companies.contacts)
create or replace function public.normalize_email_columns() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
declare
  j jsonb := to_jsonb(new);
  col text;
  v jsonb;
  patch jsonb := '{}'::jsonb;
begin
  foreach col in array tg_argv loop
    v := j -> col;
    if v is null or jsonb_typeof(v) = 'null' then continue; end if;
    if jsonb_typeof(v) = 'string' then
      patch := patch || jsonb_build_object(col, public.normalize_email_text(v #>> '{}'));
    elsif jsonb_typeof(v) = 'array' then
      patch := patch || jsonb_build_object(col, coalesce((
        select jsonb_agg(x order by ord) from (
          select case jsonb_typeof(e)
                   when 'string' then to_jsonb(nullif(public.normalize_email_text(e #>> '{}'), ''))
                   when 'object' then case when jsonb_typeof(e -> 'email') = 'string'
                                           then jsonb_set(e, '{email}', coalesce(to_jsonb(public.normalize_email_text(e ->> 'email')), 'null'::jsonb))
                                           else e end
                   else e end as x, ord
          from jsonb_array_elements(v) with ordinality as a(e, ord)
        ) s where x is not null
      ), '[]'::jsonb));
    end if;
  end loop;
  if patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, patch);
  end if;
  return new;
end $$;

-- "a0_" so it runs before the other BEFORE triggers (they fire in name order).
-- UPDATE OF <cols>: only fires when the statement actually sets an email column.

-- Outreach
drop trigger if exists a0_normalize_emails on public.outreach_senders;
create trigger a0_normalize_emails before insert or update of owner_email, bcc_address, alert_emails on public.outreach_senders
  for each row execute function public.normalize_email_columns('owner_email', 'bcc_address', 'alert_emails');

drop trigger if exists a0_normalize_emails on public.outreach_leads;
create trigger a0_normalize_emails before insert or update of email_work, email_personal on public.outreach_leads
  for each row execute function public.normalize_email_columns('email_work', 'email_personal');

drop trigger if exists a0_normalize_emails on public.outreach_members;
create trigger a0_normalize_emails before insert or update of email on public.outreach_members
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.outreach_invitations;
create trigger a0_normalize_emails before insert or update of email on public.outreach_invitations
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.outreach_booking_events;
create trigger a0_normalize_emails before insert or update of invitee_email on public.outreach_booking_events
  for each row execute function public.normalize_email_columns('invitee_email');

drop trigger if exists a0_normalize_emails on public.outreach_report_schedules;
create trigger a0_normalize_emails before insert or update of recipients on public.outreach_report_schedules
  for each row execute function public.normalize_email_columns('recipients');

drop trigger if exists a0_normalize_emails on public.outreach_profile_authority;
create trigger a0_normalize_emails before insert or update of granted_by_email on public.outreach_profile_authority
  for each row execute function public.normalize_email_columns('granted_by_email');

drop trigger if exists a0_normalize_emails on public.outreach_profile_authority_links;
create trigger a0_normalize_emails before insert or update of owner_email on public.outreach_profile_authority_links
  for each row execute function public.normalize_email_columns('owner_email');

drop trigger if exists a0_normalize_emails on public.outreach_profile_changes;
create trigger a0_normalize_emails before insert or update of approved_by_email, requested_by_email on public.outreach_profile_changes
  for each row execute function public.normalize_email_columns('approved_by_email', 'requested_by_email');

-- CRM / Smartlead
drop trigger if exists a0_normalize_emails on public.crm_contacts;
create trigger a0_normalize_emails before insert or update of email on public.crm_contacts
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.crm_members;
create trigger a0_normalize_emails before insert or update of email on public.crm_members
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.smartlead_members;
create trigger a0_normalize_emails before insert or update of email on public.smartlead_members
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.smartlead_reply_log;
create trigger a0_normalize_emails before insert or update of to_email, cc, bcc, lead_email, user_email on public.smartlead_reply_log
  for each row execute function public.normalize_email_columns('to_email', 'cc', 'bcc', 'lead_email', 'user_email');

-- Investors / lead-gen companies / platform
drop trigger if exists a0_normalize_emails on public.investors;
create trigger a0_normalize_emails before insert or update of email on public.investors
  for each row execute function public.normalize_email_columns('email');

drop trigger if exists a0_normalize_emails on public.companies;
create trigger a0_normalize_emails before insert or update of email, contacts on public.companies
  for each row execute function public.normalize_email_columns('email', 'contacts');

drop trigger if exists a0_normalize_emails on public.platform_admins;
create trigger a0_normalize_emails before insert or update of email on public.platform_admins
  for each row execute function public.normalize_email_columns('email');

-- Backfill the rows written before this (the triggers do the normalizing).
update public.outreach_senders set owner_email = owner_email, bcc_address = bcc_address, alert_emails = alert_emails
  where owner_email::text is distinct from public.normalize_email_text(owner_email::text)
     or bcc_address::text is distinct from public.normalize_email_text(bcc_address::text);
update public.companies set email = email where email is distinct from public.normalize_email_text(email);
update public.investors set email = email where email is distinct from public.normalize_email_text(email);
