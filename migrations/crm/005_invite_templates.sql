-- =============================================================================
-- Sales CRM — 005: calendar-invite title / description templates (team settings)
-- Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/crm/005_invite_templates.sql
--
-- Two crm_settings keys decide what the Google Calendar invite says whenever the CRM books the event
-- (schedule_meeting, calendar_event_for_meeting, "Add to Google Calendar", and the Calendar screen's
-- New event once a company/contact is attached):
--   invite_title_template        default "{me} <> {who}"
--   invite_description_template  default "{notes}\n\n{company} · {contact}"
-- Placeholders: {me} my first name · {me_full} · {who} contact first name else company · {contact} ·
-- {contact_first} · {company} · {studio} (studio_name setting) · {notes} (meeting notes).
-- Rendering lives in supabase/functions/crm-mcp/invite_template.ts (mirrored in lib/crm/invite.ts):
-- separators next to an empty value and blank lines are dropped, so the defaults reproduce the old
-- "<Me> <> <contact or company>" / "<notes>\n\n<company> · <contact>" exactly.
-- Edited in CRM → Settings → Calendar invites (crm_set_setting). The same function body is in 002.
-- =============================================================================

insert into crm_settings(key, value) values
  ('invite_title_template', '"{me} <> {who}"'),
  ('invite_description_template', '"{notes}\n\n{company} · {contact}"')
on conflict (key) do nothing;

create or replace function crm_set_setting(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform crm_require_member();
  if p_key not in ('default_timezone','stale_after_days','default_currency','studio_name','invite_title_template','invite_description_template') then raise exception 'E_PAYLOAD_INVALID: unknown setting %', p_key; end if;
  -- Calendar-invite templates (005): strings with {me} {who} {contact} {company} {studio} {notes} placeholders; empty = default.
  if p_key in ('invite_title_template','invite_description_template') then
    if jsonb_typeof(p_value) <> 'string' then raise exception 'E_PAYLOAD_INVALID: % must be a string', p_key; end if;
    if length(p_value #>> '{}') > (case when p_key = 'invite_title_template' then 300 else 2000 end) then raise exception 'E_PAYLOAD_INVALID: % is too long', p_key; end if;
  end if;
  insert into crm_settings(key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value, updated_at = now();
  return (select coalesce(jsonb_object_agg(key, value), '{}') from crm_settings);
end $$;

select key, value from crm_settings where key like 'invite_%' order by key;
