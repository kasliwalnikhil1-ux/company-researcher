-- =============================================================================
-- Outreach Platform — 023 Profile Studio functions (PRD §4, §5, §7, §8, §9, §10.3)
-- Requires 021 + 022. Idempotent. Every user-facing function: outreach_require() then outreach_client_visible().
-- Rule kept from the platform: the database is the authority. "No authority, no write" and every ceiling are
-- checked here at submit time and again by the worker at execution time (outreach_profile_change_for_action).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------
-- Which authority groups a payload (+ uploaded assets) touches. Mirrors fieldGroupsOf() in profile_serialiser.ts.
create or replace function outreach_profile_groups_of(p_payload jsonb, p_assets jsonb default '{}')
returns outreach_profile_field_group_t[] language sql immutable as $$
  select coalesce(array_agg(g order by o), '{}')::outreach_profile_field_group_t[] from (values
    (1, 'headline',    p_payload ? 'headline'),
    (2, 'about',       p_payload ? 'summary'),
    (3, 'photo',       p_payload ? 'picture_settings' or coalesce(p_assets,'{}') ? 'picture' or coalesce(p_assets,'{}') ? 'picture_url'),
    (4, 'cover',       p_payload ? 'cover_picture_settings' or coalesce(p_assets,'{}') ? 'cover_picture' or coalesce(p_assets,'{}') ? 'cover_url'),
    (5, 'location',    p_payload ? 'location'),
    (6, 'experience',  p_payload ? 'experience'),
    (7, 'education',   p_payload ? 'education'),
    (8, 'skills',      p_payload ? 'skills' or p_payload ? 'skills_follow'),
    (9, 'custom_link', p_payload ? 'custom_link')
  ) v(o, g, hit) where hit
$$;

-- Keys the platform never writes, wherever they appear (PRD §4.4, §5.3, §5.4).
create or replace function outreach_profile_payload_prohibited(p_payload jsonb) returns text
language sql immutable as $$
  select case
    when p_payload ? 'open_to_work' then 'open_to_work'
    when p_payload::text ~* '"notify_network"' then 'notify_network'
    when p_payload ? 'first_name' or p_payload ? 'last_name' or p_payload ? 'pronouns' or p_payload ? 'public_identifier' then 'name'
  end
$$;

-- A sender's identity is verified when its owner connected it through hosted auth (credentials / browser sign-in / OAuth).
-- Cookie-synced or pasted sessions, and a manager's explicit flag, make it unverified (PRD §4.4).
create or replace function outreach_profile_identity_verified(p_sender uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select s.auth_method in ('credentials','browser','oauth') and not s.profile_identity_unverified from outreach_senders s where s.id = p_sender
$$;

-- Workspace toggle (settings.profile_owner_permission, OFF by default): when off, no owner authority is needed, every change
-- is direct, and no owner emails go out. When on, the PRD's authority model applies in full.
create or replace function outreach_profile_permission_required(p_ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((w.settings->>'profile_owner_permission')::boolean, false) from outreach_workspaces w where w.id = p_ws
$$;

-- Active grant for a sender + field group (null when none).
create or replace function outreach_profile_authority_for(p_sender uuid, p_group outreach_profile_field_group_t)
returns outreach_profile_authority language sql stable security definer set search_path = public, extensions as $$
  select a.* from outreach_profile_authority a
   where a.sender_id = p_sender and a.field_group = p_group and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())
   order by a.granted_at desc limit 1
$$;

-- How much of a ceiling a sender has used: {key, max, window_days, used, remaining, next_at}. A change counts once it is
-- queued (it will land) and stays counted while applied / partially applied inside the window.
create or replace function outreach_profile_ceiling_used(p_sender uuid, p_key text, p_exclude_change uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_profile_ceilings%rowtype; used int; first_at timestamptz; win interval;
begin
  select * into c from outreach_profile_ceilings where field_group = p_key;
  if not found then return jsonb_build_object('key', p_key, 'max', null, 'used', 0, 'remaining', 999, 'next_at', null); end if;
  win := make_interval(days => c.window_days);
  select count(*), min(coalesce(ch.applied_at, ch.scheduled_for, ch.submitted_at, ch.created_at)) into used, first_at
    from outreach_profile_changes ch
   where ch.sender_id = p_sender and ch.status in ('queued','applied','partially_applied')
     and (p_exclude_change is null or ch.id <> p_exclude_change)
     and coalesce(ch.applied_at, ch.scheduled_for, ch.submitted_at, ch.created_at) > now() - win
     and case p_key
           when 'all' then true
           when 'all_daily' then true
           when 'experience_new' then 'experience' = any(ch.field_groups) and not (ch.payload->'experience' ? 'id')
           else p_key::outreach_profile_field_group_t = any(ch.field_groups)
         end;
  return jsonb_build_object('key', p_key, 'max', c.max_count, 'window_days', c.window_days, 'used', used,
                            'remaining', greatest(c.max_count - used, 0), 'next_at', case when used >= c.max_count then first_at + win end);
end $$;

-- Field-length rules (LinkedIn's own limits). Returns null or a detail sentence.
create or replace function outreach_profile_payload_problem(p_payload jsonb) returns text
language sql immutable as $$
  select case
    when p_payload ? 'headline' and length(p_payload->>'headline') > 220 then 'The headline is over 220 characters'
    when p_payload ? 'headline' and btrim(coalesce(p_payload->>'headline','')) = '' then 'The headline is empty'
    when p_payload ? 'summary' and length(p_payload->>'summary') > 2600 then 'The About section is over 2,600 characters'
    when p_payload ? 'experience' and length(coalesce(p_payload->'experience'->>'description','')) > 2000 then 'The experience description is over 2,000 characters'
    when p_payload ? 'experience' and not (p_payload->'experience' ? 'id') and (coalesce(p_payload->'experience'->>'role','') = '' or coalesce(p_payload->'experience'->>'company','') = '') then 'A new experience entry needs a role and a company'
    when p_payload ? 'education' and length(coalesce(p_payload->'education'->>'description','')) > 1000 then 'The education description is over 1,000 characters'
    when p_payload ? 'education' and not (p_payload->'education' ? 'id') and coalesce(p_payload->'education'->>'school','') = '' then 'A new education entry needs a school'
    when p_payload ? 'skills' and jsonb_typeof(p_payload->'skills') <> 'array' then 'Skills must be a list'
    when p_payload ? 'skills' and jsonb_array_length(p_payload->'skills') > 50 then 'At most 50 skills'
    when p_payload ? 'custom_link' and coalesce(p_payload->'custom_link'->>'url','') !~* '^https?://' then 'The custom link must start with http:// or https://'
    when p_payload ? 'custom_link' and coalesce(p_payload->'custom_link'->>'type','') not in ('STORE','WEBSITE','PORTFOLIO','BLOG','NEWSLETTER') then 'Pick a link type'
    when p_payload ? 'location' and coalesce(p_payload->'location'->>'id','') = '' and coalesce(p_payload->'location'->>'postal_code','') = '' then 'A location needs a LinkedIn location id or a postal code'
    when p_payload ? 'picture_settings' and coalesce(p_payload->'picture_settings'->>'filter','ORIGINAL') not in ('ORIGINAL','STUDIO','SPOTLIGHT','PRIME','CLASSIC','EDGE','LUMINATE') then 'Unknown photo filter'
  end
$$;

-- -----------------------------------------------------------------------------
-- Validation (PRD §7.1 step 1). {ok, mode, groups, causes:[{code, blocking, group?, detail, remedy}]}
-- The same function answers "why can't I edit this?" in the editor (outreach_profile_why_not).
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_validate(p_sender uuid, p_payload jsonb, p_assets jsonb default '{}', p_source text default 'manual', p_bulk_count int default 1, p_change uuid default null, p_experiment uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; groups outreach_profile_field_group_t[]; g outreach_profile_field_group_t; a outreach_profile_authority; causes jsonb := '[]'; ok boolean := true;
        mode text := 'direct'; c jsonb; bad text; quiet_from timestamptz; lock_exp record; eff int; need_auth boolean;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found or s.deleted_at is not null then return jsonb_build_object('ok', false, 'causes', jsonb_build_array(jsonb_build_object('code','E_NOT_FOUND','blocking',true,'detail','Sender not found','remedy','Check the sender id'))); end if;
  groups := outreach_profile_groups_of(p_payload, p_assets);
  need_auth := outreach_profile_permission_required(s.workspace_id);

  if s.provider <> 'LINKEDIN' then causes := causes || jsonb_build_object('code','E_PROFILE_PROVIDER','blocking',true,'detail','Profile editing is available for LinkedIn accounts','remedy','Pick a LinkedIn sender'); end if;
  if s.status <> 'ok' then causes := causes || jsonb_build_object('code','E_PROFILE_SENDER_NOT_OK','blocking',true,'detail','The account is ' || case s.status when 'credentials' then 'waiting for a fresh login' when 'paused' then 'paused' else s.status::text end,'remedy','Reconnect or resume the sender first. Profile changes are never applied while it is disconnected.'); end if;
  if s.paused_until is not null and s.paused_until > now() then causes := causes || jsonb_build_object('code','E_PROFILE_SENDER_NOT_OK','blocking',true,'detail','The account is resting until ' || to_char(s.paused_until, 'DD Mon HH24:MI'),'remedy','Wait for the pause to end'); end if;
  if s.health_score < 50 then causes := causes || jsonb_build_object('code','E_PROFILE_HEALTH','blocking',true,'detail','Health is below 50, so the account has no daily allowance','remedy','Fix the health causes on the Insights tab first'); end if;
  if not outreach_profile_identity_verified(p_sender) then causes := causes || jsonb_build_object('code','E_PROFILE_IDENTITY_UNVERIFIED','blocking',true,'detail','This account was not connected by its owner through a hosted login, so its identity is unverified','remedy','Ask the owner to reconnect through the hosted login page. Profiles connected by cookie cannot be edited.'); end if;
  if s.warmup_level < 1 then causes := causes || jsonb_build_object('code','E_PROFILE_WARMUP','blocking',true,'detail','The account is at warm-up level 0','remedy','Profile changes on a brand-new or thin account look like a takeover. Wait for level 1.'); end if;
  quiet_from := greatest(coalesce(s.connected_at, '1970-01-01'), coalesce(s.last_reconnect_at, '1970-01-01'));
  if quiet_from > now() - interval '72 hours' then causes := causes || jsonb_build_object('code','E_PROFILE_QUIET_PERIOD','blocking',true,'detail','The account connected or reconnected less than 72 hours ago','remedy','Wait until ' || to_char(quiet_from + interval '72 hours', 'DD Mon HH24:MI') || '. Edits right after a new login are what LinkedIn watches for.'); end if;

  if coalesce(array_length(groups,1),0) = 0 then causes := causes || jsonb_build_object('code','E_PAYLOAD_INVALID','blocking',true,'detail','Nothing to change','remedy','Edit at least one field'); end if;
  bad := outreach_profile_payload_prohibited(p_payload);
  if bad is not null then causes := causes || jsonb_build_object('code','E_PROFILE_PROHIBITED','blocking',true,'detail','The platform never writes ' || bad,'remedy','Remove it. Open-to-work, network broadcasts and names are not editable here, by design.'); end if;
  bad := outreach_profile_payload_problem(p_payload);
  if bad is not null then causes := causes || jsonb_build_object('code','E_PAYLOAD_INVALID','blocking',true,'detail',bad,'remedy','Fix the field and try again'); end if;
  if p_bulk_count > 1 and p_payload ? 'experience' and not (p_payload->'experience' ? 'id') then
    causes := causes || jsonb_build_object('code','E_PROFILE_PROHIBITED','blocking',true,'detail','Creating a job entry on several profiles in one operation is not allowed','remedy','Add a position one sender at a time, with that person''s confirmation.');
  end if;

  -- per group: authority + ceiling + experiment lock
  foreach g in array groups loop
    if need_auth then
      a := outreach_profile_authority_for(p_sender, g);
      if a.id is null then
        causes := causes || jsonb_build_object('code','E_NO_PROFILE_AUTHORITY','blocking',true,'group',g,'detail','No authority from the account owner to edit ' || replace(g::text,'_',' '),'remedy','Send the owner a permission link from the Profile tab, grant it yourself if you own this account, or switch off owner permission in Settings, Workspace.');
      elsif a.mode = 'propose_only' then mode := 'propose_only'; end if;
    end if;
    c := outreach_profile_ceiling_used(p_sender, g::text, p_change);
    if (c->>'remaining')::int <= 0 then
      causes := causes || jsonb_build_object('code','E_PROFILE_CEILING','blocking',true,'group',g,'detail',replace(g::text,'_',' ') || ': ' || (c->>'max') || ' change(s) per ' || (c->>'window_days') || ' days already used','remedy','Next change possible on ' || to_char((c->>'next_at')::timestamptz, 'DD Mon'));
    end if;
    if g = 'experience' and not (p_payload->'experience' ? 'id') then
      c := outreach_profile_ceiling_used(p_sender, 'experience_new', p_change);
      if (c->>'remaining')::int <= 0 then causes := causes || jsonb_build_object('code','E_PROFILE_CEILING','blocking',true,'group',g,'detail','A new position was added in the last 30 days','remedy','Next new entry possible on ' || to_char((c->>'next_at')::timestamptz, 'DD Mon')); end if;
    end if;
    select e.id, e.name into lock_exp from outreach_profile_experiments e
     where e.status in ('washout','running','ready') and e.field_group = g and p_sender = any(e.sender_ids) and (p_experiment is null or e.id <> p_experiment) limit 1;
    if lock_exp.id is not null then causes := causes || jsonb_build_object('code','E_EXPERIMENT_LOCK','blocking',true,'group',g,'detail',replace(g::text,'_',' ') || ' is locked by the running experiment "' || lock_exp.name || '"','remedy','Conclude or abandon the experiment first'); end if;
  end loop;
  -- combined weekly limit here; the one-per-day rule is the scheduler's (one profile_edit per sender per local day) and the daily budget's
  c := outreach_profile_ceiling_used(p_sender, 'all', p_change);
  if (c->>'remaining')::int <= 0 then
    causes := causes || jsonb_build_object('code','E_PROFILE_CEILING','blocking',true,'detail','The combined limit of ' || (c->>'max') || ' profile changes per week is used','remedy','Next change possible on ' || to_char((c->>'next_at')::timestamptz, 'DD Mon HH24:MI'));
  end if;
  eff := outreach_effective_cap(p_sender, 'profile_edit');
  if eff < 1 and s.warmup_level >= 1 and s.health_score >= 50 then causes := causes || jsonb_build_object('code','E_PROFILE_CEILING','blocking',true,'detail','The daily allowance for profile edits is 0 (manual cap)','remedy','Raise the profile_edit cap on the Budgets tab'); end if;

  select bool_and(not (x->>'blocking')::boolean) into ok from jsonb_array_elements(causes) x;
  return jsonb_build_object('ok', coalesce(ok, true), 'mode', mode, 'groups', to_jsonb(groups), 'causes', causes);
end $$;

-- The editor's status panel: authority + ceilings per group, and the sender-level blockers.
create or replace function outreach_profile_why_not(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; g outreach_profile_field_group_t; a outreach_profile_authority; groups jsonb := '[]'; v jsonb; lock_exp record;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  foreach g in array enum_range(null::outreach_profile_field_group_t) loop
    a := outreach_profile_authority_for(p_sender, g);
    select e.id, e.name into lock_exp from outreach_profile_experiments e where e.status in ('washout','running','ready') and e.field_group = g and p_sender = any(e.sender_ids) limit 1;
    groups := groups || jsonb_build_object('group', g, 'authority', case when a.id is null then null else jsonb_build_object('id', a.id, 'mode', a.mode, 'granted_by', a.granted_by_email, 'via', a.granted_via, 'expires_at', a.expires_at) end,
      'ceiling', outreach_profile_ceiling_used(p_sender, g::text) || case when g = 'experience' then jsonb_build_object('new_entry', outreach_profile_ceiling_used(p_sender, 'experience_new')) else '{}'::jsonb end,
      'locked_by', case when lock_exp.id is null then null else jsonb_build_object('experiment_id', lock_exp.id, 'name', lock_exp.name) end);
  end loop;
  -- sender-level blockers only: validate an always-valid payload against a group that needs no authority check by passing an empty payload
  v := outreach_profile_validate(p_sender, '{}'::jsonb, '{}'::jsonb, 'manual', 1);
  return jsonb_build_object('groups', groups,
    'combined', jsonb_build_object('week', outreach_profile_ceiling_used(p_sender, 'all'), 'day', outreach_profile_ceiling_used(p_sender, 'all_daily')),
    'blockers', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v->'causes') x where x->>'code' <> 'E_PAYLOAD_INVALID'),
    'identity_verified', outreach_profile_identity_verified(p_sender), 'warmup_level', s.warmup_level, 'owner_email', s.owner_email,
    'permission_required', outreach_profile_permission_required(s.workspace_id),
    'daily_allowance', outreach_effective_cap(p_sender, 'profile_edit'));
end $$;

-- -----------------------------------------------------------------------------
-- Scheduling (PRD §8.2 pacing, §10.2 planner rule): inside the sender's window, one profile edit per sender per day,
-- at most one sender per hour and 8 per day per workspace. Creates the profile_edit action. Service only.
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_schedule(p_change uuid) returns timestamptz
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype; d date; w record; cand timestamptz; i int; n_sender int; n_ws int; clash boolean; aid uuid; tz text;
begin
  -- internal: reached only through submit / owner_decide / revert (execute is revoked from signed-in users below)
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found or ch.status <> 'approved' then raise exception 'E_PROFILE_STATE: change is % (expected approved)', ch.status; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  tz := coalesce(s.timezone, 'UTC');
  for i in 0..30 loop
    d := (now() at time zone tz)::date + i;
    select count(*) into n_sender from outreach_actions a where a.sender_id = s.id and a.action_type = 'profile_edit' and a.status in ('queued','reserved','sent') and outreach_sender_local_date(s.id, a.scheduled_for) = d;
    if n_sender > 0 then continue; end if;
    select count(*) into n_ws from outreach_actions a where a.workspace_id = ch.workspace_id and a.action_type = 'profile_edit' and a.status in ('queued','reserved','sent') and (a.scheduled_for at time zone tz)::date = d;
    if n_ws >= 8 then continue; end if;
    for w in select start_at, end_at from outreach_schedule_windows(s.id, d) order by start_at loop
      cand := greatest(w.start_at, now() + interval '3 minutes') + (random() * interval '25 minutes');
      -- workspace pacing: one sender per hour
      loop
        select exists (select 1 from outreach_actions a where a.workspace_id = ch.workspace_id and a.action_type = 'profile_edit' and a.status in ('queued','reserved') and abs(extract(epoch from a.scheduled_for - cand)) < 3600) into clash;
        exit when not clash;
        cand := cand + interval '61 minutes';
      end loop;
      if cand + interval '2 minutes' < w.end_at then
        insert into outreach_actions(workspace_id, sender_id, action_type, scheduled_for, idempotency_key, payload)
        values (ch.workspace_id, s.id, 'profile_edit', cand, 'profile:' || ch.id, jsonb_build_object('change_id', ch.id, 'field_groups', to_jsonb(ch.field_groups)))
        on conflict (idempotency_key) do update set scheduled_for = excluded.scheduled_for, status = 'queued', reserved_at = null
        returning id into aid;
        update outreach_profile_changes set status = 'queued', action_id = aid, scheduled_for = cand where id = ch.id;
        return cand;
      end if;
    end loop;
  end loop;
  raise exception 'E_NO_SCHEDULE: the sender has no working hours in the next 30 days';
end $$;
revoke execute on function outreach_profile_schedule(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Drafting and submitting (PRD §7.1)
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_draft_change(p_sender uuid, p_payload jsonb, p_assets jsonb default '{}', p_source text default 'manual', p_template uuid default null, p_experiment uuid default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; groups outreach_profile_field_group_t[]; cid uuid; bad text; em citext;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_source not in ('manual','template','experiment','ai_draft','rollback','mcp') then raise exception 'E_PAYLOAD_INVALID: source'; end if;
  bad := outreach_profile_payload_prohibited(p_payload);
  if bad is not null then raise exception 'E_PROFILE_PROHIBITED: the platform never writes %', bad; end if;
  bad := outreach_profile_payload_problem(p_payload);
  if bad is not null then raise exception 'E_PAYLOAD_INVALID: %', bad; end if;
  groups := outreach_profile_groups_of(p_payload, coalesce(p_assets,'{}'));
  if coalesce(array_length(groups,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: nothing to change'; end if;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, assets, source, template_id, experiment_id, requested_by, requested_by_email, note)
  values (s.workspace_id, s.id, groups, p_payload, coalesce(p_assets,'{}'), p_source, p_template, p_experiment, auth.uid(), em, left(p_note, 500)) returning id into cid;
  perform outreach_audit(s.workspace_id, 'profile.draft', 'profile_change', cid::text, jsonb_build_object('sender_id', s.id, 'groups', groups, 'source', p_source));
  return jsonb_build_object('id', cid, 'status', 'draft', 'field_groups', to_jsonb(groups), 'validation', outreach_profile_validate(s.id, p_payload, coalesce(p_assets,'{}'), p_source, 1, cid, p_experiment));
end $$;

create or replace function outreach_profile_update_draft(p_change uuid, p_payload jsonb, p_assets jsonb default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype; bad text; groups outreach_profile_field_group_t[];
begin
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  perform outreach_require(ch.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if ch.status <> 'draft' then raise exception 'E_PROFILE_STATE: only drafts can be edited (this change is %)', ch.status; end if;
  bad := outreach_profile_payload_prohibited(p_payload);
  if bad is not null then raise exception 'E_PROFILE_PROHIBITED: the platform never writes %', bad; end if;
  bad := outreach_profile_payload_problem(p_payload);
  if bad is not null then raise exception 'E_PAYLOAD_INVALID: %', bad; end if;
  groups := outreach_profile_groups_of(p_payload, coalesce(p_assets, ch.assets));
  if coalesce(array_length(groups,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: nothing to change'; end if;
  update outreach_profile_changes set payload = p_payload, assets = coalesce(p_assets, assets), field_groups = groups, note = coalesce(left(p_note,500), note) where id = p_change;
  return jsonb_build_object('id', p_change, 'status', 'draft', 'field_groups', to_jsonb(groups), 'validation', outreach_profile_validate(s.id, p_payload, coalesce(p_assets, ch.assets), ch.source, 1, p_change, ch.experiment_id));
end $$;

-- Submit: validate → awaiting_owner (propose_only) or approved → queued (direct). Never returns an approval token to the
-- caller: the edge function issues it with the service role and emails the owner.
create or replace function outreach_profile_submit_change(p_change uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype; v jsonb; first jsonb; when_at timestamptz; em citext;
begin
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  perform outreach_require(ch.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if ch.status not in ('draft','approved') then raise exception 'E_PROFILE_STATE: change is % (only drafts can be submitted)', ch.status; end if;
  v := outreach_profile_validate(s.id, ch.payload, ch.assets, ch.source, 1, ch.id, ch.experiment_id);
  if not (v->>'ok')::boolean then
    select x into first from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean limit 1;
    raise exception '%: %', first->>'code', first->>'detail';
  end if;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  if v->>'mode' = 'propose_only' then
    update outreach_profile_changes set status = 'awaiting_owner', mode = 'propose_only', submitted_at = now(), approval_expires_at = now() + interval '14 days', requested_by_email = coalesce(requested_by_email, em) where id = ch.id;
    perform outreach_audit(ch.workspace_id, 'profile.submitted', 'profile_change', ch.id::text, jsonb_build_object('sender_id', s.id, 'mode', 'propose_only'));
    return jsonb_build_object('id', ch.id, 'status', 'awaiting_owner', 'mode', 'propose_only', 'owner_email', s.owner_email);
  end if;
  update outreach_profile_changes set status = 'approved', mode = 'direct', submitted_at = now(), approved_by_email = coalesce(approved_by_email, em), requested_by_email = coalesce(requested_by_email, em) where id = ch.id;
  when_at := outreach_profile_schedule(ch.id);
  perform outreach_audit(ch.workspace_id, 'profile.queued', 'profile_change', ch.id::text, jsonb_build_object('sender_id', s.id, 'mode', 'direct', 'scheduled_for', when_at));
  return jsonb_build_object('id', ch.id, 'status', 'queued', 'mode', 'direct', 'scheduled_for', when_at);
end $$;

create or replace function outreach_profile_cancel_change(p_change uuid, p_reason text default 'cancelled') returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype;
begin
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  perform outreach_require(ch.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if ch.status not in ('draft','awaiting_owner','approved','queued') then raise exception 'E_PROFILE_STATE: a % change cannot be cancelled', ch.status; end if;
  if ch.action_id is not null then update outreach_actions set status = 'cancelled', decision = 'cancel', error_code = 'profile_change_cancelled' where id = ch.action_id and status in ('queued','reserved'); end if;
  update outreach_profile_changes set status = 'cancelled', cancelled_reason = left(p_reason, 200), approval_token_hash = null where id = ch.id;
  perform outreach_audit(ch.workspace_id, 'profile.cancelled', 'profile_change', ch.id::text, jsonb_build_object('reason', p_reason));
end $$;

-- -----------------------------------------------------------------------------
-- Owner flows (service role; the edge function verifies the signed token first)
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_issue_approval_token(p_change uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  t := encode(gen_random_bytes(24), 'hex');
  update outreach_profile_changes set approval_token_hash = encode(digest(t, 'sha256'), 'hex'), approval_expires_at = coalesce(approval_expires_at, now() + interval '14 days')
   where id = p_change and status = 'awaiting_owner';
  if not found then raise exception 'E_PROFILE_STATE: not awaiting the owner'; end if;
  return t;
end $$;
revoke execute on function outreach_profile_issue_approval_token(uuid) from public, anon, authenticated;

create or replace function outreach_profile_change_by_approval_token(p_token text) returns outreach_profile_changes
language sql stable security definer set search_path = public, extensions as $$
  select * from outreach_profile_changes where approval_token_hash = encode(digest(p_token, 'sha256'), 'hex') limit 1
$$;
revoke execute on function outreach_profile_change_by_approval_token(text) from public, anon, authenticated;

create or replace function outreach_profile_owner_decide(p_change uuid, p_decision text, p_email citext, p_evidence jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; when_at timestamptz; v jsonb; first jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if ch.status <> 'awaiting_owner' then raise exception 'E_PROFILE_STATE: this change is already %', ch.status; end if;
  if ch.approval_expires_at < now() then raise exception 'E_PROFILE_APPROVAL_EXPIRED: the approval link has expired'; end if;
  if p_decision = 'decline' then
    update outreach_profile_changes set status = 'cancelled', cancelled_reason = 'declined_by_owner', approval_token_hash = null, approved_by_email = p_email where id = ch.id;
    perform outreach_audit(ch.workspace_id, 'profile.declined', 'profile_change', ch.id::text, jsonb_build_object('by', p_email, 'evidence', p_evidence));
    return jsonb_build_object('id', ch.id, 'status', 'cancelled');
  end if;
  v := outreach_profile_validate(ch.sender_id, ch.payload, ch.assets, ch.source, 1, ch.id, ch.experiment_id);
  if not (v->>'ok')::boolean then
    select x into first from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean limit 1;
    raise exception '%: %', first->>'code', first->>'detail';
  end if;
  update outreach_profile_changes set status = 'approved', approved_by_email = p_email, approval_token_hash = null where id = ch.id;
  when_at := outreach_profile_schedule(ch.id);
  perform outreach_audit(ch.workspace_id, 'profile.approved_by_owner', 'profile_change', ch.id::text, jsonb_build_object('by', p_email, 'evidence', p_evidence, 'scheduled_for', when_at));
  return jsonb_build_object('id', ch.id, 'status', 'queued', 'scheduled_for', when_at);
end $$;
revoke execute on function outreach_profile_owner_decide(uuid,text,citext,jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Worker hooks (service role): load, snapshot, mark applied / verified / failed, revert tokens, notifications
-- -----------------------------------------------------------------------------
-- What the executor needs for a claimed profile_edit action. Re-checks authority + ceilings at execution (PRD §4.2).
create or replace function outreach_profile_change_for_action(p_action uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; ch outreach_profile_changes%rowtype; v jsonb; first jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_action;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into ch from outreach_profile_changes where id = (a.payload->>'change_id')::uuid;
  if not found then return jsonb_build_object('ok', false, 'code', 'E_NOT_FOUND', 'detail', 'change missing'); end if;
  if ch.status <> 'queued' then return jsonb_build_object('ok', false, 'code', 'E_PROFILE_STATE', 'detail', 'change is ' || ch.status); end if;
  v := outreach_profile_validate(ch.sender_id, ch.payload, ch.assets, ch.source, 1, ch.id, ch.experiment_id);
  if not (v->>'ok')::boolean then
    select x into first from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean limit 1;
    return jsonb_build_object('ok', false, 'code', first->>'code', 'detail', first->>'detail', 'change', to_jsonb(ch));
  end if;
  return jsonb_build_object('ok', true, 'change', to_jsonb(ch));
end $$;
revoke execute on function outreach_profile_change_for_action(uuid) from public, anon, authenticated;

create or replace function outreach_profile_record_snapshot(p_sender uuid, p_kind text, p_sections text[], p_fidelity text, p_data jsonb, p_unwritten text[] default '{}', p_change uuid default null, p_action uuid default null, p_drift jsonb default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid; sid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_senders where id = p_sender;
  insert into outreach_profile_snapshots(workspace_id, sender_id, kind, sections, fidelity, data, unwritten_fields, change_id, action_id, drift)
  values (ws, p_sender, p_kind, coalesce(p_sections,'{}'), p_fidelity, p_data, coalesce(p_unwritten,'{}'), p_change, p_action, p_drift) returning id into sid;
  update outreach_senders set profile_snapshot_at = now() where id = p_sender;
  if p_change is not null and p_kind = 'pre_change' then update outreach_profile_changes set pre_snapshot_id = sid where id = p_change; end if;
  if p_change is not null and p_kind = 'post_change' then update outreach_profile_changes set post_snapshot_id = sid where id = p_change; end if;
  return sid;
end $$;
revoke execute on function outreach_profile_record_snapshot(uuid,text,text[],text,jsonb,text[],uuid,uuid,jsonb) from public, anon, authenticated;

-- After the PATCH: provisional status, verification due after the propagation delay.
create or replace function outreach_profile_mark_applied(p_change uuid, p_ok boolean, p_error text default null, p_verify_after timestamptz default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then return; end if;
  if p_ok then
    update outreach_profile_changes set status = 'applied', applied_at = now(), error_code = null, verify_after = coalesce(p_verify_after, now() + interval '90 seconds') where id = p_change;
    perform outreach_emit_event(ch.workspace_id, 'profile.applied', jsonb_build_object('id', ch.id, 'sender_id', ch.sender_id, 'field_groups', to_jsonb(ch.field_groups)));
  else
    update outreach_profile_changes set status = 'failed', error_code = left(p_error, 120), failed_fields = coalesce(failed_fields,'{}') || jsonb_build_object('_all', left(p_error,120)) where id = p_change;
    perform outreach_emit_event(ch.workspace_id, 'profile.failed', jsonb_build_object('id', ch.id, 'sender_id', ch.sender_id, 'error', left(p_error,120)));
  end if;
  insert into outreach_sender_events(sender_id, kind, data) values (ch.sender_id, 'profile', jsonb_build_object('change_id', ch.id, 'ok', p_ok, 'groups', to_jsonb(ch.field_groups), 'error', p_error));
end $$;
revoke execute on function outreach_profile_mark_applied(uuid,boolean,text,timestamptz) from public, anon, authenticated;

-- A 401 during apply: the change goes back to needing an explicit re-submit (never re-applied silently on reconnect, PRD §5.5).
create or replace function outreach_profile_park_change(p_change uuid, p_error text) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_profile_changes set status = 'draft', action_id = null, scheduled_for = null, error_code = left(p_error, 120), note = coalesce(note,'') || ' [held: the account disconnected before this change was applied; submit it again after reconnecting]' where id = p_change and status = 'queued'
$$;
revoke execute on function outreach_profile_park_change(uuid,text) from public, anon, authenticated;

-- Post-verify outcome (PRD §7.3): the diff is the source of truth, not the HTTP status.
create or replace function outreach_profile_mark_verified(p_change uuid, p_applied text[], p_failed jsonb, p_post_snapshot uuid default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; st text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found or ch.status not in ('applied','partially_applied') then return; end if;
  st := case when coalesce(jsonb_typeof(p_failed),'null') = 'object' and (select count(*) from jsonb_object_keys(p_failed)) > 0 then 'partially_applied' else 'applied' end;
  update outreach_profile_changes set status = st, applied_fields = coalesce(p_applied,'{}'), failed_fields = coalesce(p_failed,'{}'), verified_at = now(), post_snapshot_id = coalesce(p_post_snapshot, post_snapshot_id) where id = p_change;
  if st = 'partially_applied' then perform outreach_emit_event(ch.workspace_id, 'profile.partially_applied', jsonb_build_object('id', ch.id, 'sender_id', ch.sender_id, 'failed_fields', p_failed)); end if;
end $$;
revoke execute on function outreach_profile_mark_verified(uuid,text[],jsonb,uuid) from public, anon, authenticated;

create or replace function outreach_profile_issue_revert_token(p_change uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare t text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  t := encode(gen_random_bytes(24), 'hex');
  update outreach_profile_changes set revert_token_hash = encode(digest(t, 'sha256'), 'hex'), revert_expires_at = now() + interval '30 days' where id = p_change;
  return t;
end $$;
revoke execute on function outreach_profile_issue_revert_token(uuid) from public, anon, authenticated;

create or replace function outreach_profile_change_by_revert_token(p_token text) returns outreach_profile_changes
language sql stable security definer set search_path = public, extensions as $$
  select * from outreach_profile_changes where revert_token_hash = encode(digest(p_token, 'sha256'), 'hex') limit 1
$$;
revoke execute on function outreach_profile_change_by_revert_token(text) from public, anon, authenticated;

create or replace function outreach_profile_mark_notified(p_change uuid, p_recipients jsonb) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_profile_changes set owner_notified_at = now(), note = note where id = p_change;
  select outreach_audit((select workspace_id from outreach_profile_changes where id = p_change), 'profile.owner_notified', 'profile_change', p_change::text, jsonb_build_object('recipients', p_recipients), 'system');
$$;
revoke execute on function outreach_profile_mark_notified(uuid,jsonb) from public, anon, authenticated;

-- Housekeeping: expired approvals, previews and links. Service only.
create or replace function outreach_profile_expire() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; b int; c int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  with x as (update outreach_profile_changes set status = 'cancelled', cancelled_reason = 'approval_expired', approval_token_hash = null where status = 'awaiting_owner' and approval_expires_at < now() returning 1) select count(*) into a from x;
  with x as (update outreach_profile_bulk_runs set status = 'expired' where status = 'preview' and expires_at < now() returning 1) select count(*) into b from x;
  with x as (update outreach_profile_changes set revert_token_hash = null where revert_token_hash is not null and revert_expires_at < now() returning 1) select count(*) into c from x;
  return jsonb_build_object('approvals_expired', a, 'previews_expired', b, 'revert_tokens_expired', c);
end $$;
revoke execute on function outreach_profile_expire() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Rollback (PRD §7.2): payload reconstructed from the pre-change snapshot + our last written values; fidelity per field.
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_revert_build(p_change uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype; pre outreach_profile_snapshots%rowtype; prev outreach_profile_changes%rowtype;
        payload jsonb := '{}'; assets jsonb := '{}'; fields jsonb := '[]'; unrec jsonb := '[]'; k text; entry jsonb; prevval jsonb; d jsonb;
begin
  select * into ch from outreach_profile_changes where id = p_change;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  if not outreach_is_service() then
    perform outreach_require(ch.workspace_id, 'member');
    if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  end if;
  if ch.status not in ('applied','partially_applied') then raise exception 'E_PROFILE_STATE: only an applied change can be reverted (this one is %)', ch.status; end if;
  if ch.pre_snapshot_id is not null then select * into pre from outreach_profile_snapshots where id = ch.pre_snapshot_id; end if;
  d := coalesce(pre.data, '{}'::jsonb);
  -- the last change applied BEFORE this one holds our last written values for the fields LinkedIn does not read back
  select * into prev from outreach_profile_changes where sender_id = ch.sender_id and status in ('applied','partially_applied') and applied_at < ch.applied_at order by applied_at desc limit 1;

  for k in select jsonb_object_keys(ch.payload) loop
    case k
      when 'headline' then
        if d ? 'headline' and d->>'headline' is not null then payload := payload || jsonb_build_object('headline', d->>'headline'); fields := fields || jsonb_build_object('key','headline','fidelity','full','note','Restored from the snapshot taken before the change');
        else unrec := unrec || jsonb_build_object('key','headline','why','No snapshot of the previous headline'); end if;
      when 'summary' then
        if d ? 'summary' and d->>'summary' is not null then payload := payload || jsonb_build_object('summary', d->>'summary'); fields := fields || jsonb_build_object('key','summary','fidelity','full','note','Restored from the snapshot taken before the change');
        else unrec := unrec || jsonb_build_object('key','summary','why','No snapshot of the previous About section'); end if;
      when 'experience' then
        if ch.payload->'experience' ? 'id' then
          select e into entry from jsonb_array_elements(coalesce(d->'experience','[]'::jsonb)) e where e->>'id' = ch.payload->'experience'->>'id' limit 1;
          if entry is not null then
            payload := payload || jsonb_build_object('experience', jsonb_strip_nulls(jsonb_build_object('id', entry->>'id',
              'description', case when ch.payload->'experience' ? 'description' then coalesce(entry->>'description','') end,
              'role', case when ch.payload->'experience' ? 'role' then entry->>'title' end,
              'location', case when ch.payload->'experience' ? 'location' then entry->>'location' end,
              'skills', case when ch.payload->'experience' ? 'skills' then entry->'skills' end)));
            fields := fields || jsonb_build_object('key','experience','fidelity','full','note','Restored from the snapshot taken before the change');
          else unrec := unrec || jsonb_build_object('key','experience','why','The previous state of this position was not in the snapshot'); end if;
        else unrec := unrec || jsonb_build_object('key','experience','why','A position that was added cannot be removed through the connector. Remove it on LinkedIn.'); end if;
      when 'education' then
        if ch.payload->'education' ? 'id' then
          select e into entry from jsonb_array_elements(coalesce(d->'education','[]'::jsonb)) e where e->>'id' = ch.payload->'education'->>'id' limit 1;
          if entry is not null then
            payload := payload || jsonb_build_object('education', jsonb_strip_nulls(jsonb_build_object('id', entry->>'id',
              'description', case when ch.payload->'education' ? 'description' then coalesce(entry->>'description','') end,
              'degree', case when ch.payload->'education' ? 'degree' then entry->>'degree' end,
              'field_of_study', case when ch.payload->'education' ? 'field_of_study' then entry->>'field' end)));
            fields := fields || jsonb_build_object('key','education','fidelity','full','note','Restored from the snapshot taken before the change');
          else unrec := unrec || jsonb_build_object('key','education','why','The previous state of this entry was not in the snapshot'); end if;
        else unrec := unrec || jsonb_build_object('key','education','why','An education entry that was added cannot be removed through the connector. Remove it on LinkedIn.'); end if;
      when 'skills' then
        if d ? 'skills' then
          payload := payload || jsonb_build_object('skills', (select coalesce(jsonb_agg(coalesce(x->>'name', x#>>'{}')), '[]'::jsonb) from jsonb_array_elements(d->'skills') x));
          fields := fields || jsonb_build_object('key','skills','fidelity','full','note','Restored from the snapshot taken before the change');
        else unrec := unrec || jsonb_build_object('key','skills','why','No snapshot of the previous skills'); end if;
      when 'location' then
        prevval := case when prev.id is not null and prev.payload ? 'location' then prev.payload->'location' end;
        if prevval is not null then payload := payload || jsonb_build_object('location', prevval); fields := fields || jsonb_build_object('key','location','fidelity','written_only','note','Restored to the location the platform last wrote. LinkedIn reports the location as text, not as the id the edit needs.');
        else unrec := unrec || jsonb_build_object('key','location','why','The previous location ("' || coalesce(d->>'location','unknown') || '") was never written by the platform, so its id is unknown. Set it on LinkedIn.'); end if;
      when 'picture_settings', 'cover_picture_settings', 'custom_link', 'skills_follow' then
        prevval := case when prev.id is not null and prev.payload ? k then prev.payload->k end;
        if prevval is not null then payload := payload || jsonb_build_object(k, prevval); fields := fields || jsonb_build_object('key',k,'fidelity','written_only','note','Restored to the value the platform last wrote. If it was changed on LinkedIn since, that state cannot be recovered.');
        else unrec := unrec || jsonb_build_object('key',k,'why','LinkedIn does not report this field and the platform never wrote it before, so there is nothing to restore it to'); end if;
      else null;
    end case;
  end loop;
  -- images: our own upload before this change = full; the URL from the snapshot = partial (LinkedIn's crop state is lost)
  for k in select jsonb_object_keys(ch.assets) loop
    if k in ('picture','picture_url') then
      if prev.id is not null and prev.assets ? 'picture' then assets := assets || jsonb_build_object('picture', prev.assets->>'picture'); fields := fields || jsonb_build_object('key','picture','fidelity','full','note','The previous photo was uploaded through the platform and is kept');
      elsif d->>'picture_url' is not null then assets := assets || jsonb_build_object('picture_url', d->>'picture_url'); fields := fields || jsonb_build_object('key','picture','fidelity','partial','note','The previous photo is restored from its URL; LinkedIn''s crop and filter state cannot be restored');
      else unrec := unrec || jsonb_build_object('key','picture','why','No record of the previous photo'); end if;
    elsif k in ('cover_picture','cover_url') then
      if prev.id is not null and prev.assets ? 'cover_picture' then assets := assets || jsonb_build_object('cover_picture', prev.assets->>'cover_picture'); fields := fields || jsonb_build_object('key','cover_picture','fidelity','full','note','The previous cover was uploaded through the platform and is kept');
      elsif d->>'cover_url' is not null then assets := assets || jsonb_build_object('cover_url', d->>'cover_url'); fields := fields || jsonb_build_object('key','cover_picture','fidelity','partial','note','The previous cover is restored from its URL; the crop state cannot be restored');
      else unrec := unrec || jsonb_build_object('key','cover_picture','why','No record of the previous cover image'); end if;
    end if;
  end loop;
  return jsonb_build_object('change_id', ch.id, 'payload', payload, 'assets', assets, 'fields', fields, 'unrecoverable', unrec,
                            'possible', (payload <> '{}'::jsonb or assets <> '{}'::jsonb), 'pre_snapshot_id', ch.pre_snapshot_id);
end $$;

-- Create + submit the rollback as an ordinary change (ceilings and authority apply). Member path; the owner path calls this
-- through the edge function with the service role after verifying the revert token.
create or replace function outreach_profile_revert(p_change uuid, p_by_email citext default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_profile_changes%rowtype; s outreach_senders%rowtype; b jsonb; nid uuid; groups outreach_profile_field_group_t[]; v jsonb; first jsonb; when_at timestamptz; em citext; is_svc boolean;
begin
  is_svc := outreach_is_service();
  select * into ch from outreach_profile_changes where id = p_change for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = ch.sender_id;
  if not is_svc then
    perform outreach_require(ch.workspace_id, 'member');
    if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  end if;
  b := outreach_profile_revert_build(p_change);
  if not (b->>'possible')::boolean then raise exception 'E_PROFILE_UNRECOVERABLE: nothing in this change can be restored automatically'; end if;
  groups := outreach_profile_groups_of(b->'payload', b->'assets');
  em := coalesce(p_by_email, nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email');
  insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, assets, source, reverts_change_id, requested_by, requested_by_email, note)
  values (ch.workspace_id, ch.sender_id, groups, b->'payload', b->'assets', 'rollback', ch.id, auth.uid(), em, 'Rollback of the change applied ' || to_char(ch.applied_at, 'DD Mon HH24:MI')) returning id into nid;
  -- the owner reverting their own profile does not need authority from themselves: their token IS the authority; ceilings still apply
  if is_svc then
    v := outreach_profile_validate(ch.sender_id, b->'payload', b->'assets', 'rollback', 1, nid, null);
    select x into first from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean and x->>'code' <> 'E_NO_PROFILE_AUTHORITY' limit 1;
    if first is not null then
      update outreach_profile_changes set status = 'cancelled', cancelled_reason = first->>'code' where id = nid;
      raise exception '%: %', first->>'code', first->>'detail';
    end if;
    update outreach_profile_changes set status = 'approved', mode = 'direct', submitted_at = now(), approved_by_email = em where id = nid;
    when_at := outreach_profile_schedule(nid);
    update outreach_profile_changes set status = 'reverted', reverted_at = now() where id = ch.id;
    perform outreach_audit(ch.workspace_id, 'profile.revert_by_owner', 'profile_change', nid::text, jsonb_build_object('reverts', ch.id, 'by', em, 'scheduled_for', when_at), 'system');
    return jsonb_build_object('id', nid, 'status', 'queued', 'scheduled_for', when_at, 'fields', b->'fields', 'unrecoverable', b->'unrecoverable');
  end if;
  v := outreach_profile_submit_change(nid);
  update outreach_profile_changes set status = 'reverted', reverted_at = now() where id = ch.id;
  perform outreach_audit(ch.workspace_id, 'profile.revert', 'profile_change', nid::text, jsonb_build_object('reverts', ch.id));
  return v || jsonb_build_object('fields', b->'fields', 'unrecoverable', b->'unrecoverable');
end $$;

-- -----------------------------------------------------------------------------
-- Reads for the Profile tab and history
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_overview(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; snap outreach_profile_snapshots%rowtype; q outreach_profile_qa%rowtype; exp record;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  select * into snap from outreach_profile_snapshots where sender_id = p_sender and kind in ('baseline','post_change','drift_check','pre_change') order by captured_at desc limit 1;
  select * into q from outreach_profile_qa where sender_id = p_sender;
  select e.id, e.name, e.status, e.field_group into exp from outreach_profile_experiments e where p_sender = any(e.sender_ids) and e.status in ('washout','running','ready') limit 1;
  return jsonb_build_object(
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'public_identifier', s.public_identifier, 'picture_url', s.picture_url, 'owner_email', s.owner_email, 'status', s.status, 'warmup_level', s.warmup_level, 'connections_count', s.connections_count, 'timezone', s.timezone, 'auth_method', s.auth_method, 'identity_unverified', s.profile_identity_unverified),
    'snapshot', case when snap.id is null then null else jsonb_build_object('id', snap.id, 'kind', snap.kind, 'captured_at', snap.captured_at, 'fidelity', snap.fidelity, 'sections', to_jsonb(snap.sections), 'data', snap.data) end,
    'qa', case when q.sender_id is null then null else jsonb_build_object('score', q.score, 'checks', q.checks, 'computed_at', q.computed_at) end,
    'status', outreach_profile_why_not(p_sender),
    'pending', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'field_groups', to_jsonb(c.field_groups), 'source', c.source, 'scheduled_for', c.scheduled_for, 'created_at', c.created_at, 'mode', c.mode, 'note', c.note, 'payload', c.payload, 'assets', c.assets, 'error_code', c.error_code) order by c.created_at desc), '[]'::jsonb)
                  from outreach_profile_changes c where c.sender_id = p_sender and c.status in ('draft','awaiting_owner','approved','queued')),
    'last_written', (select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) from (
                       select distinct on (k) k, v from outreach_profile_changes c, jsonb_each(c.payload) kv(k, v)
                        where c.sender_id = p_sender and c.status in ('applied','partially_applied') and k in ('picture_settings','cover_picture_settings','custom_link','skills_follow','location')
                        order by k, c.applied_at desc) x),
    'experiment', case when exp.id is null then null else jsonb_build_object('id', exp.id, 'name', exp.name, 'status', exp.status, 'field_group', exp.field_group) end,
    'ceilings', (select jsonb_object_agg(field_group, jsonb_build_object('max', max_count, 'window_days', window_days)) from outreach_profile_ceilings));
end $$;

create or replace function outreach_profile_history(p_sender uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'field_groups', to_jsonb(c.field_groups), 'source', c.source, 'mode', c.mode,
            'payload', c.payload, 'assets', c.assets, 'applied_fields', to_jsonb(c.applied_fields), 'failed_fields', c.failed_fields, 'error_code', c.error_code,
            'requested_by_email', c.requested_by_email, 'approved_by_email', c.approved_by_email, 'owner_notified_at', c.owner_notified_at,
            'scheduled_for', c.scheduled_for, 'applied_at', c.applied_at, 'verified_at', c.verified_at, 'reverted_at', c.reverted_at, 'created_at', c.created_at, 'note', c.note,
            'reverts_change_id', c.reverts_change_id, 'pre_snapshot_id', c.pre_snapshot_id, 'post_snapshot_id', c.post_snapshot_id,
            'before', (select p.data from outreach_profile_snapshots p where p.id = c.pre_snapshot_id),
            'can_revert', c.status in ('applied','partially_applied') and c.pre_snapshot_id is not null) order by c.created_at desc), '[]'::jsonb)
          from (select * from outreach_profile_changes where sender_id = p_sender order by created_at desc limit greatest(1, least(p_limit, 200))) c);
end $$;

-- Workspace-wide list for the Profiles page (pending approvals, queued, recent).
create or replace function outreach_profile_changes_list(p_ws uuid, p_statuses text[] default null, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'sender_id', c.sender_id, 'sender_name', s.display_name, 'sender_picture', s.picture_url, 'status', c.status, 'field_groups', to_jsonb(c.field_groups), 'source', c.source, 'mode', c.mode,
            'scheduled_for', c.scheduled_for, 'applied_at', c.applied_at, 'created_at', c.created_at, 'error_code', c.error_code, 'template_id', c.template_id, 'experiment_id', c.experiment_id, 'owner_email', s.owner_email, 'payload', c.payload) order by c.created_at desc), '[]'::jsonb)
          from (select * from outreach_profile_changes where workspace_id = p_ws and (p_statuses is null or status = any(p_statuses)) order by created_at desc limit greatest(1, least(p_limit, 500))) c
          join outreach_senders s on s.id = c.sender_id where outreach_client_visible(p_ws, s.client_id));
end $$;

-- -----------------------------------------------------------------------------
-- Authority grants (PRD §4.2)
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_authority_list(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  return jsonb_build_object(
    'grants', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'field_group', a.field_group, 'mode', a.mode, 'granted_by_email', a.granted_by_email, 'granted_via', a.granted_via, 'granted_at', a.granted_at, 'expires_at', a.expires_at, 'revoked_at', a.revoked_at, 'revoked_reason', a.revoked_reason, 'active', a.revoked_at is null and (a.expires_at is null or a.expires_at > now())) order by a.revoked_at nulls first, a.granted_at desc), '[]'::jsonb) from outreach_profile_authority a where a.sender_id = p_sender),
    'links', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'field_groups', to_jsonb(l.field_groups), 'mode', l.mode, 'owner_email', l.owner_email, 'expires_at', l.expires_at, 'accepted_at', l.accepted_at, 'declined_at', l.declined_at, 'created_at', l.created_at) order by l.created_at desc), '[]'::jsonb) from outreach_profile_authority_links l where l.sender_id = p_sender and l.created_at > now() - interval '90 days'),
    'owner_email', s.owner_email,
    'caller_is_owner', coalesce(s.owner_user_id = auth.uid(), false) or coalesce(s.owner_email = (nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email')::citext, false));
end $$;

-- The owner IS the operator: the signed-in user owns this sender (owner_user_id or owner_email). Both modes available at once.
create or replace function outreach_profile_authority_self(p_sender uuid, p_groups outreach_profile_field_group_t[], p_mode text, p_expires_days int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; em citext; g outreach_profile_field_group_t; n int := 0;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  if not (coalesce(s.owner_user_id = auth.uid(), false) or coalesce(s.owner_email = em, false)) then
    raise exception 'E_FORBIDDEN: only the account owner can grant this for themselves (set the sender''s owner email to your own address, or send the owner a permission link)';
  end if;
  if p_mode not in ('propose_only','direct') then raise exception 'E_PAYLOAD_INVALID: mode'; end if;
  if coalesce(array_length(p_groups,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: pick at least one field group'; end if;
  foreach g in array p_groups loop
    update outreach_profile_authority set revoked_at = now(), revoked_reason = 'replaced', revoked_by = auth.uid() where sender_id = p_sender and field_group = g and revoked_at is null;
    insert into outreach_profile_authority(workspace_id, sender_id, field_group, mode, granted_by_email, granted_via, evidence, expires_at)
    values (s.workspace_id, p_sender, g, p_mode, coalesce(em, s.owner_email, 'owner'), 'owner_is_operator', jsonb_build_object('user_id', auth.uid(), 'signed_at', now()), case when p_expires_days is not null then now() + make_interval(days => p_expires_days) end);
    n := n + 1;
  end loop;
  perform outreach_audit(s.workspace_id, 'profile.authority_self', 'sender', p_sender::text, jsonb_build_object('groups', p_groups, 'mode', p_mode));
  return jsonb_build_object('granted', n, 'mode', p_mode);
end $$;

create or replace function outreach_profile_authority_revoke(p_authority uuid, p_reason text default 'revoked') returns void
language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_profile_authority%rowtype; s outreach_senders%rowtype; em citext;
begin
  select * into a from outreach_profile_authority where id = p_authority for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = a.sender_id;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  -- a manager, or the owner who granted it
  if not (outreach_is_service() or coalesce(outreach_role_in(a.workspace_id) in ('owner','manager'), false) or coalesce(s.owner_user_id = auth.uid(), false) or coalesce(a.granted_by_email = em, false)) then raise exception 'E_FORBIDDEN'; end if;
  if a.revoked_at is not null then return; end if;
  update outreach_profile_authority set revoked_at = now(), revoked_reason = left(p_reason,200), revoked_by = auth.uid() where id = p_authority;
  -- anything waiting on that authority stops
  update outreach_profile_changes set status = 'cancelled', cancelled_reason = 'authority_revoked' where sender_id = a.sender_id and status in ('awaiting_owner','approved') and a.field_group = any(field_groups);
  perform outreach_audit(a.workspace_id, 'profile.authority_revoked', 'sender', a.sender_id::text, jsonb_build_object('field_group', a.field_group, 'reason', p_reason));
end $$;

-- A manager creates a signed link for the owner (token returned once; the edge function emails it). Manager role.
create or replace function outreach_profile_authority_link_create(p_sender uuid, p_groups outreach_profile_field_group_t[], p_mode text, p_owner_email citext default null, p_grant_days int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; t text; lid uuid; em citext;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_mode not in ('propose_only','direct') then raise exception 'E_PAYLOAD_INVALID: mode'; end if;
  if coalesce(array_length(p_groups,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: pick at least one field group'; end if;
  em := coalesce(p_owner_email, s.owner_email);
  if em is null or em::text !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: the sender needs an owner email address first'; end if;
  if s.owner_email is null then update outreach_senders set owner_email = em where id = s.id; end if;
  t := encode(gen_random_bytes(24), 'hex');
  insert into outreach_profile_authority_links(workspace_id, sender_id, token_hash, field_groups, mode, owner_email, expires_at, grant_days, created_by)
  values (s.workspace_id, s.id, encode(digest(t,'sha256'),'hex'), p_groups, p_mode, em, now() + interval '7 days', p_grant_days, auth.uid()) returning id into lid;
  perform outreach_audit(s.workspace_id, 'profile.authority_link', 'sender', s.id::text, jsonb_build_object('link_id', lid, 'groups', p_groups, 'mode', p_mode, 'owner_email', em));
  return jsonb_build_object('link_id', lid, 'token', t, 'owner_email', em, 'expires_at', now() + interval '7 days');
end $$;

create or replace function outreach_profile_authority_link_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('id', l.id, 'sender_id', l.sender_id, 'workspace_id', l.workspace_id, 'field_groups', to_jsonb(l.field_groups), 'mode', l.mode, 'owner_email', l.owner_email,
                            'expires_at', l.expires_at, 'accepted_at', l.accepted_at, 'declined_at', l.declined_at, 'grant_days', l.grant_days,
                            'sender_name', s.display_name, 'sender_picture', s.picture_url, 'public_identifier', s.public_identifier, 'workspace_name', w.name,
                            'expired', l.expires_at < now())
    from outreach_profile_authority_links l join outreach_senders s on s.id = l.sender_id join outreach_workspaces w on w.id = l.workspace_id
   where l.token_hash = encode(digest(p_token,'sha256'),'hex') limit 1
$$;
revoke execute on function outreach_profile_authority_link_by_token(text) from public, anon, authenticated;

-- The owner accepts (no login): records grants with evidence. Service only.
create or replace function outreach_profile_authority_accept(p_token text, p_decision text, p_groups outreach_profile_field_group_t[] default null, p_mode text default null, p_evidence jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_profile_authority_links%rowtype; g outreach_profile_field_group_t; groups outreach_profile_field_group_t[]; md text; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into l from outreach_profile_authority_links where token_hash = encode(digest(p_token,'sha256'),'hex') for update;
  if not found then raise exception 'E_NOT_FOUND: unknown link'; end if;
  if l.accepted_at is not null or l.declined_at is not null then raise exception 'E_PROFILE_LINK_USED: this link was already used'; end if;
  if l.expires_at < now() then raise exception 'E_PROFILE_LINK_EXPIRED: this link has expired'; end if;
  if p_decision = 'decline' then
    update outreach_profile_authority_links set declined_at = now(), evidence = p_evidence where id = l.id;
    perform outreach_audit(l.workspace_id, 'profile.authority_declined', 'sender', l.sender_id::text, jsonb_build_object('link_id', l.id), 'system');
    return jsonb_build_object('declined', true);
  end if;
  -- the owner may narrow the request (fewer groups, propose_only instead of direct), never widen it
  groups := coalesce(p_groups, l.field_groups);
  if exists (select 1 from unnest(groups) x where not (x = any(l.field_groups))) then raise exception 'E_PAYLOAD_INVALID: a group outside the request'; end if;
  md := coalesce(p_mode, l.mode);
  if md = 'direct' and l.mode = 'propose_only' then raise exception 'E_PAYLOAD_INVALID: the request was for proposals only'; end if;
  foreach g in array groups loop
    update outreach_profile_authority set revoked_at = now(), revoked_reason = 'replaced' where sender_id = l.sender_id and field_group = g and revoked_at is null;
    insert into outreach_profile_authority(workspace_id, sender_id, field_group, mode, granted_by_email, granted_via, evidence, expires_at)
    values (l.workspace_id, l.sender_id, g, md, l.owner_email, 'signed_link', p_evidence || jsonb_build_object('link_id', l.id, 'signed_at', now()), case when l.grant_days is not null then now() + make_interval(days => l.grant_days) end);
    n := n + 1;
  end loop;
  update outreach_profile_authority_links set accepted_at = now(), evidence = p_evidence where id = l.id;
  perform outreach_audit(l.workspace_id, 'profile.authority_granted', 'sender', l.sender_id::text, jsonb_build_object('link_id', l.id, 'groups', groups, 'mode', md, 'by', l.owner_email), 'system');
  return jsonb_build_object('granted', n, 'mode', md, 'groups', to_jsonb(groups));
end $$;
revoke execute on function outreach_profile_authority_accept(text,text,outreach_profile_field_group_t[],text,jsonb) from public, anon, authenticated;

create or replace function outreach_profile_set_identity_flag(p_sender uuid, p_unverified boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  update outreach_senders set profile_identity_unverified = p_unverified where id = p_sender;
  perform outreach_audit(s.workspace_id, 'profile.identity_flag', 'sender', p_sender::text, jsonb_build_object('unverified', p_unverified));
end $$;

-- -----------------------------------------------------------------------------
-- Templates + rendering (PRD §8.2). {{var}}, {{custom.key}}, {{var|fallback}}.
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_render_text(p_text text, p_vars jsonb) returns text
language plpgsql immutable as $$
declare m text[]; out_t text := coalesce(p_text,''); key text; fb text; val text; guard int := 0;
begin
  for m in select regexp_matches(coalesce(p_text,''), '\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*(?:\|([^}]*))?\}\}', 'g') loop
    key := m[1]; fb := coalesce(m[2], '');
    if key like 'custom.%' then val := p_vars->'custom'->>substr(key, 8); else val := p_vars->>key; end if;
    val := coalesce(nullif(btrim(val), ''), btrim(fb));
    out_t := regexp_replace(out_t, '\{\{\s*' || replace(key, '.', '\.') || '\s*(?:\|[^}]*)?\}\}', replace(val, '\', '\\'), 'g');
    guard := guard + 1; exit when guard > 200;
  end loop;
  return out_t;
end $$;

create or replace function outreach_profile_render_json(p_json jsonb, p_vars jsonb) returns jsonb
language plpgsql immutable as $$
declare res jsonb; k text; v jsonb;
begin
  case jsonb_typeof(p_json)
    when 'string' then return to_jsonb(outreach_profile_render_text(p_json #>> '{}', p_vars));
    when 'object' then
      res := '{}';
      for k, v in select * from jsonb_each(p_json) loop res := res || jsonb_build_object(k, outreach_profile_render_json(v, p_vars)); end loop;
      return res;
    when 'array' then
      return coalesce((select jsonb_agg(outreach_profile_render_json(x, p_vars)) from jsonb_array_elements(p_json) x), '[]'::jsonb);
    else return p_json;
  end case;
end $$;

-- Variables available for a sender: first_name, last_name, full_name, headline, company, title, client, plus custom.*
create or replace function outreach_profile_sender_vars(p_sender uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'first_name', split_part(coalesce(s.display_name,''), ' ', 1),
    'last_name', nullif(regexp_replace(coalesce(s.display_name,''), '^\S+\s*', ''), ''),
    'full_name', s.display_name,
    'headline', p.data->>'headline',
    'company', coalesce((select e->>'company' from jsonb_array_elements(coalesce(p.data->'experience','[]'::jsonb)) e where coalesce((e->>'current')::boolean,false) limit 1), (select e->>'company' from jsonb_array_elements(coalesce(p.data->'experience','[]'::jsonb)) e limit 1)),
    'title', coalesce((select e->>'title' from jsonb_array_elements(coalesce(p.data->'experience','[]'::jsonb)) e where coalesce((e->>'current')::boolean,false) limit 1), (select e->>'title' from jsonb_array_elements(coalesce(p.data->'experience','[]'::jsonb)) e limit 1)),
    'client', (select c.name from outreach_clients c where c.id = s.client_id),
    'location', p.data->>'location'))
    from outreach_senders s
    left join lateral (select data from outreach_profile_snapshots x where x.sender_id = s.id order by captured_at desc limit 1) p on true
   where s.id = p_sender
$$;

create or replace function outreach_profile_template_save(p_ws uuid, p_id uuid, p_name text, p_client uuid, p_body jsonb, p_variables jsonb default '{}') returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare tid uuid; groups outreach_profile_field_group_t[]; bad text;
begin
  perform outreach_require(p_ws, 'manager');
  if btrim(coalesce(p_name,'')) = '' then raise exception 'E_PAYLOAD_INVALID: name'; end if;
  bad := outreach_profile_payload_prohibited(p_body);
  if bad is not null then raise exception 'E_PROFILE_PROHIBITED: the platform never writes %', bad; end if;
  if p_body ? 'picture' or p_body ? 'cover_picture' then raise exception 'E_PAYLOAD_INVALID: templates hold text fields only (photos are per sender)'; end if;
  groups := outreach_profile_groups_of(p_body, '{}');
  if coalesce(array_length(groups,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: the template has no fields'; end if;
  if p_client is not null and not exists (select 1 from outreach_clients c where c.id = p_client and c.workspace_id = p_ws) then raise exception 'E_NOT_FOUND: client'; end if;
  if p_id is null then
    insert into outreach_profile_templates(workspace_id, client_id, name, field_groups, body, variables, created_by, updated_by) values (p_ws, p_client, btrim(p_name), groups, p_body, coalesce(p_variables,'{}'), auth.uid(), auth.uid()) returning id into tid;
  else
    update outreach_profile_templates set name = btrim(p_name), client_id = p_client, field_groups = groups, body = p_body, variables = coalesce(p_variables,'{}'), updated_by = auth.uid() where id = p_id and workspace_id = p_ws returning id into tid;
    if tid is null then raise exception 'E_NOT_FOUND'; end if;
  end if;
  perform outreach_audit(p_ws, 'profile.template_saved', 'profile_template', tid::text, jsonb_build_object('name', p_name, 'groups', groups));
  return tid;
end $$;

create or replace function outreach_profile_template_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_profile_templates where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  delete from outreach_profile_templates where id = p_id;
  perform outreach_audit(ws, 'profile.template_deleted', 'profile_template', p_id::text);
end $$;

-- Render a template for one sender (preview in the editor).
create or replace function outreach_profile_template_render(p_template uuid, p_sender uuid, p_vars jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare t outreach_profile_templates%rowtype; s outreach_senders%rowtype; vars jsonb;
begin
  select * into t from outreach_profile_templates where id = p_template;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into s from outreach_senders where id = p_sender and workspace_id = t.workspace_id;
  if not found then raise exception 'E_NOT_FOUND: sender'; end if;
  perform outreach_require(t.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  vars := coalesce(t.variables,'{}') || outreach_profile_sender_vars(p_sender) || coalesce(p_vars,'{}');
  return jsonb_build_object('payload', outreach_profile_render_json(t.body, vars), 'vars', vars, 'field_groups', to_jsonb(t.field_groups));
end $$;

-- -----------------------------------------------------------------------------
-- Bulk apply: preview (one row per sender, each validated with bulk_count) → commit (one change per sender)
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_bulk_preview(p_template uuid, p_sender_ids uuid[], p_vars jsonb default '{}') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_profile_templates%rowtype; sid uuid; s outreach_senders%rowtype; rows jsonb := '[]'; payload jsonb; v jsonb; vars jsonb; n_ok int := 0; n_x int := 0; rid uuid; n int;
begin
  select * into t from outreach_profile_templates where id = p_template;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(t.workspace_id, 'manager');
  n := coalesce(array_length(p_sender_ids,1),0);
  if n = 0 then raise exception 'E_PAYLOAD_INVALID: pick at least one sender'; end if;
  if n > 50 then raise exception 'E_TOO_MANY: at most 50 senders per run'; end if;
  foreach sid in array p_sender_ids loop
    select * into s from outreach_senders where id = sid and workspace_id = t.workspace_id and deleted_at is null;
    if not found or not outreach_client_visible(s.workspace_id, s.client_id) then
      rows := rows || jsonb_build_object('sender_id', sid, 'ok', false, 'causes', jsonb_build_array(jsonb_build_object('code','E_NOT_FOUND','blocking',true,'detail','Sender not found in this workspace'))); n_x := n_x + 1; continue;
    end if;
    vars := coalesce(t.variables,'{}') || outreach_profile_sender_vars(sid) || coalesce(p_vars,'{}');
    payload := outreach_profile_render_json(t.body, vars);
    v := outreach_profile_validate(sid, payload, '{}', 'template', n, null, null);
    rows := rows || jsonb_build_object('sender_id', sid, 'name', s.display_name, 'picture_url', s.picture_url, 'owner_email', s.owner_email, 'payload', payload, 'field_groups', v->'groups', 'ok', (v->>'ok')::boolean, 'mode', v->>'mode',
                                       'causes', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean));
    if (v->>'ok')::boolean then n_ok := n_ok + 1; else n_x := n_x + 1; end if;
  end loop;
  insert into outreach_profile_bulk_runs(workspace_id, template_id, sender_ids, variables, rows, eligible, excluded, created_by)
  values (t.workspace_id, t.id, p_sender_ids, coalesce(p_vars,'{}'), rows, n_ok, n_x, auth.uid()) returning id into rid;
  return jsonb_build_object('run_id', rid, 'template', jsonb_build_object('id', t.id, 'name', t.name, 'field_groups', to_jsonb(t.field_groups)), 'rows', rows, 'eligible', n_ok, 'excluded', n_x, 'expires_at', now() + interval '30 minutes',
    'pacing', 'Changes are spread out: at most one sender per hour and 8 per day for the workspace, each inside the sender''s working hours.');
end $$;

create or replace function outreach_profile_bulk_commit(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_profile_bulk_runs%rowtype; row_j jsonb; cid uuid; res jsonb; n_q int := 0; n_w int := 0; n_f int := 0; details jsonb := '[]'; em citext;
begin
  select * into r from outreach_profile_bulk_runs where id = p_run for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'manager');
  if r.status <> 'preview' then raise exception 'E_PREVIEW_EXPIRED: this preview was already committed or expired'; end if;
  if r.expires_at < now() then update outreach_profile_bulk_runs set status = 'expired' where id = r.id; raise exception 'E_PREVIEW_EXPIRED: run the preview again'; end if;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  for row_j in select x from jsonb_array_elements(r.rows) x where (x->>'ok')::boolean loop
    begin
      insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, source, template_id, experiment_id, bulk_run_id, requested_by, requested_by_email)
      values (r.workspace_id, (row_j->>'sender_id')::uuid, (select array_agg(fg.v::outreach_profile_field_group_t) from jsonb_array_elements_text(row_j->'field_groups') as fg(v)), row_j->'payload', case when r.experiment_id is not null then 'experiment' else 'template' end, r.template_id, r.experiment_id, r.id, auth.uid(), em) returning id into cid;
      res := outreach_profile_submit_change(cid);
      if res->>'status' = 'queued' then n_q := n_q + 1; else n_w := n_w + 1; end if;
      details := details || jsonb_build_object('sender_id', row_j->>'sender_id', 'change_id', cid, 'status', res->>'status', 'scheduled_for', res->'scheduled_for');
    exception when others then
      n_f := n_f + 1;
      details := details || jsonb_build_object('sender_id', row_j->>'sender_id', 'status', 'failed', 'error', sqlerrm);
    end;
  end loop;
  update outreach_profile_bulk_runs set status = 'committed', committed_at = now(), result = jsonb_build_object('queued', n_q, 'awaiting_owner', n_w, 'failed', n_f, 'details', details) where id = r.id;
  perform outreach_audit(r.workspace_id, 'profile.bulk_commit', 'profile_bulk_run', r.id::text, jsonb_build_object('queued', n_q, 'awaiting_owner', n_w, 'failed', n_f));
  return jsonb_build_object('run_id', r.id, 'queued', n_q, 'awaiting_owner', n_w, 'failed', n_f, 'details', details);
end $$;

-- -----------------------------------------------------------------------------
-- Campaign-matched profiles (PRD §8.3): a sequence may carry settings.profile_template_id. Advisory only.
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_link_sequence(p_sequence uuid, p_template uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare sq outreach_sequences%rowtype;
begin
  select * into sq from outreach_sequences where id = p_sequence for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sq.workspace_id, 'manager');
  if not outreach_client_visible(sq.workspace_id, sq.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_template is not null and not exists (select 1 from outreach_profile_templates t where t.id = p_template and t.workspace_id = sq.workspace_id) then raise exception 'E_NOT_FOUND: template'; end if;
  update outreach_sequences set settings = case when p_template is null then settings - 'profile_template_id' else settings || jsonb_build_object('profile_template_id', p_template) end, updated_at = now() where id = p_sequence;
  perform outreach_audit(sq.workspace_id, 'profile.sequence_linked', 'sequence', p_sequence::text, jsonb_build_object('template_id', p_template));
end $$;

-- For each pool sender: does the current profile match the linked template's rendered values?
create or replace function outreach_profile_sequence_match(p_sequence uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare sq outreach_sequences%rowtype; t outreach_profile_templates%rowtype; sid uuid; s outreach_senders%rowtype; snap jsonb; rendered jsonb; rows jsonb := '[]'; mismatched int := 0; ok boolean; why text[];
begin
  select * into sq from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(sq.workspace_id, 'member');
  if not outreach_client_visible(sq.workspace_id, sq.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if (sq.settings->>'profile_template_id') is null then return jsonb_build_object('linked', false, 'rows', '[]'::jsonb); end if;
  select * into t from outreach_profile_templates where id = (sq.settings->>'profile_template_id')::uuid;
  if not found then return jsonb_build_object('linked', false, 'rows', '[]'::jsonb, 'note', 'The linked template no longer exists'); end if;
  foreach sid in array coalesce(sq.sender_pool, '{}') loop
    select * into s from outreach_senders where id = sid and deleted_at is null;
    if not found then continue; end if;
    select data into snap from outreach_profile_snapshots where sender_id = sid order by captured_at desc limit 1;
    rendered := outreach_profile_render_json(t.body, coalesce(t.variables,'{}') || outreach_profile_sender_vars(sid));
    why := '{}'; ok := snap is not null;
    if snap is not null then
      if rendered ? 'headline' and btrim(coalesce(snap->>'headline','')) <> btrim(rendered->>'headline') then why := why || 'headline'; end if;
      if rendered ? 'summary' and btrim(coalesce(snap->>'summary','')) <> btrim(rendered->>'summary') then why := why || 'about'; end if;
      ok := coalesce(array_length(why,1),0) = 0;
    end if;
    if not ok then mismatched := mismatched + 1; end if;
    rows := rows || jsonb_build_object('sender_id', sid, 'name', s.display_name, 'matches', ok, 'no_snapshot', snap is null, 'differs', to_jsonb(why));
  end loop;
  return jsonb_build_object('linked', true, 'template', jsonb_build_object('id', t.id, 'name', t.name), 'rows', rows, 'mismatched', mismatched);
end $$;

-- -----------------------------------------------------------------------------
-- QA score (PRD §8.4). From the latest snapshot + sender fields. Service or member.
-- -----------------------------------------------------------------------------
create or replace function outreach_profile_qa_compute(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; snap outreach_profile_snapshots%rowtype; d jsonb; checks jsonb := '[]'; score int := 100; hl text; ab text; cur jsonb; nskills int; pic text; link jsonb; conns int;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then perform outreach_require(s.workspace_id, 'member'); if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if; end if;
  select * into snap from outreach_profile_snapshots where sender_id = p_sender order by captured_at desc limit 1;
  d := coalesce(snap.data, '{}'::jsonb);
  hl := coalesce(d->>'headline', ''); ab := coalesce(d->>'summary', '');
  pic := coalesce(d->>'picture_url', s.picture_url, '');
  conns := coalesce((d->>'connections_count')::int, s.connections_count);
  select e into cur from jsonb_array_elements(coalesce(d->'experience','[]'::jsonb)) e where coalesce((e->>'current')::boolean,false) limit 1;
  if cur is null then select e into cur from jsonb_array_elements(coalesce(d->'experience','[]'::jsonb)) e limit 1; end if;
  nskills := coalesce(jsonb_array_length(d->'skills'), 0);
  select payload->'custom_link' into link from outreach_profile_changes where sender_id = p_sender and status in ('applied','partially_applied') and payload ? 'custom_link' order by applied_at desc limit 1;

  -- each check: {code, severity, pass, detail, fix_hint}; pass = null means "cannot tell" and does not score
  checks := checks || jsonb_build_object('code','no_photo','severity','critical','pass', pic <> '' and pic !~ '/sc/h/' ,'detail', case when pic = '' then 'No profile photo' when pic ~ '/sc/h/' then 'The default grey avatar is showing' else 'Custom photo present' end,'fix_hint','Upload a clear head-and-shoulders photo on a plain background. Profiles with a real photo get accepted far more often.');
  checks := checks || jsonb_build_object('code','headline_default','severity','high','pass', not (hl ~* '^\s*[^|•·–—]{2,60}\s+at\s+[^|•·–—]{2,60}\s*$'),'detail', case when hl ~* '^\s*[^|•·–—]{2,60}\s+at\s+[^|•·–—]{2,60}\s*$' then 'The headline is the bare default ("Role at Company")' else 'Headline is customised' end,'fix_hint','Say who you help and how, not just your title.');
  checks := checks || jsonb_build_object('code','headline_length','severity','medium','pass', hl <> '' and length(hl) between 40 and 200,'detail', case when hl = '' then 'No headline' when length(hl) < 40 then 'Headline is under 40 characters' when length(hl) > 200 then 'Headline is over 200 characters and will be cut off' else 'Headline length is fine' end,'fix_hint','Aim for 40 to 200 characters.');
  checks := checks || jsonb_build_object('code','about_empty','severity','high','pass', case when snap.id is null or not ('about' = any(coalesce(snap.sections,'{}'))) then null else ab <> '' end,'detail', case when ab = '' then 'The About section is empty' else 'About section present' end,'fix_hint','Write 3 short paragraphs: who you help, how, and proof.');
  checks := checks || jsonb_build_object('code','about_short','severity','medium','pass', case when ab = '' then null else length(ab) >= 300 end,'detail', case when ab = '' then 'No About section' when length(ab) < 300 then 'The About section is under 300 characters' else 'About section is long enough' end,'fix_hint','Give prospects enough to trust you: at least 300 characters.');
  checks := checks || jsonb_build_object('code','about_no_breaks','severity','low','pass', case when length(ab) < 300 then null else position(E'\n' in ab) > 0 end,'detail', case when length(ab) >= 300 and position(E'\n' in ab) = 0 then 'The About section is one block of text' else 'About section has paragraphs' end,'fix_hint','Break it into short paragraphs.');
  checks := checks || jsonb_build_object('code','no_cover','severity','medium','pass', case when d ? 'cover_url' then coalesce(d->>'cover_url','') <> '' else null end,'detail', case when d ? 'cover_url' and coalesce(d->>'cover_url','') = '' then 'No cover image' when d ? 'cover_url' then 'Cover image present' else 'Cover image not reported by LinkedIn' end,'fix_hint','Add a cover image that states your offer in one line.');
  checks := checks || jsonb_build_object('code','experience_no_description','severity','medium','pass', case when cur is null then null else coalesce(cur->>'description','') <> '' end,'detail', case when cur is null then 'No current position found' when coalesce(cur->>'description','') = '' then 'The current position has no description' else 'Current position has a description' end,'fix_hint','Describe what you do for whom in 2 to 4 lines.');
  checks := checks || jsonb_build_object('code','few_skills','severity','low','pass', case when snap.id is null or not ('skills' = any(coalesce(snap.sections,'{}'))) then null else nskills >= 5 end,'detail', nskills || ' skills listed','fix_hint','List at least 5 relevant skills.');
  checks := checks || jsonb_build_object('code','no_custom_link','severity','low','pass', case when link is null then null else true end,'detail', case when link is null then 'No custom link set through the platform (LinkedIn does not report this field)' else 'Custom link set' end,'fix_hint','Add a link to a booking page or case study.');
  checks := checks || jsonb_build_object('code','location_unset','severity','medium','pass', coalesce(d->>'location', '') <> '','detail', case when coalesce(d->>'location','') = '' then 'No location set' else 'Location set' end,'fix_hint','Set your location; prospects filter by it.');
  checks := checks || jsonb_build_object('code','connections_low','severity','critical','pass', case when conns is null then null else conns >= 150 end,'detail', case when conns is null then 'Connections count unknown' else conns || ' connections' end,'fix_hint','Below 150 connections the account stays at warm-up level 0.');

  select 100 - coalesce(sum(case x->>'severity' when 'critical' then 25 when 'high' then 15 when 'medium' then 8 else 4 end), 0) into score
    from jsonb_array_elements(checks) x where (x->>'pass') = 'false';
  score := greatest(0, least(100, score));
  insert into outreach_profile_qa(sender_id, workspace_id, score, checks, snapshot_id, computed_at) values (p_sender, s.workspace_id, score, checks, snap.id, now())
  on conflict (sender_id) do update set score = excluded.score, checks = excluded.checks, snapshot_id = excluded.snapshot_id, computed_at = now();
  update outreach_senders set profile_qa_score = score where id = p_sender and profile_qa_score is distinct from score;
  return jsonb_build_object('score', score, 'checks', checks, 'snapshot_id', snap.id, 'computed_at', now());
end $$;

-- QA vs acceptance, per sender, for the Profiles → Insights view (PRD §8.4 "correlated against acceptance rate").
create or replace function outreach_profile_qa_correlation(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return (select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'name', s.display_name, 'qa', s.profile_qa_score, 'health', s.health_score,
             'invites_30d', x.inv, 'accepted_30d', x.acc, 'acceptance_rate', case when x.inv >= 10 then round(100.0 * x.acc / x.inv, 1) end) order by s.display_name), '[]'::jsonb)
          from outreach_senders s
          left join lateral (select count(*) inv, count(*) filter (where invite_accepted_at is not null) acc from outreach_lead_sender_state l where l.sender_id = s.id and l.invite_sent_at > now() - interval '30 days') x on true
          where s.workspace_id = p_ws and s.deleted_at is null and s.provider = 'LINKEDIN' and outreach_client_visible(p_ws, s.client_id));
end $$;

-- -----------------------------------------------------------------------------
-- Experiments (PRD §9). Sender-level randomisation; readout with a two-proportion CI; no winner on a crossing interval.
-- -----------------------------------------------------------------------------
create or replace function outreach__phi(z numeric) returns numeric language sql immutable as $$
  -- standard normal CDF, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7)
  select case when z < 0 then 1 - r else r end
    from (select 1 - (1/sqrt(2*pi())) * exp(-(abs(z)*abs(z))/2) * (0.319381530*t - 0.356563782*t^2 + 1.781477937*t^3 - 1.821255978*t^4 + 1.330274429*t^5) as r
            from (select 1/(1 + 0.2316419*abs(z)) as t) q) q2
$$;

create or replace function outreach_profile_experiment_create(p_ws uuid, p_name text, p_field_group outreach_profile_field_group_t, p_variants jsonb, p_sender_ids uuid[], p_washout_days int default 3, p_min_invites int default 120) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare eid uuid; nv int; sid uuid; s outreach_senders%rowtype; busy record;
begin
  perform outreach_require(p_ws, 'manager');
  if p_field_group not in ('headline','about','photo') then raise exception 'E_PAYLOAD_INVALID: experiments cover headline, about or photo'; end if;
  nv := coalesce(jsonb_array_length(p_variants), 0);
  if nv < 2 or nv > 4 then raise exception 'E_PAYLOAD_INVALID: 2 to 4 variants'; end if;
  if exists (select 1 from jsonb_array_elements(p_variants) v where coalesce(v->>'key','') = '' or v->'value' is null) then raise exception 'E_PAYLOAD_INVALID: every variant needs a key and a value'; end if;
  if (select count(distinct v->>'key') from jsonb_array_elements(p_variants) v) <> nv then raise exception 'E_PAYLOAD_INVALID: variant keys must be unique'; end if;
  if coalesce(array_length(p_sender_ids,1),0) < 2 * nv then raise exception 'E_PAYLOAD_INVALID: at least 2 senders per variant (% needed)', 2 * nv; end if;
  foreach sid in array p_sender_ids loop
    select * into s from outreach_senders where id = sid and workspace_id = p_ws and deleted_at is null and provider = 'LINKEDIN';
    if not found then raise exception 'E_NOT_FOUND: sender % is not a LinkedIn sender of this workspace', sid; end if;
    if not outreach_client_visible(p_ws, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
    select e.id, e.name into busy from outreach_profile_experiments e where sid = any(e.sender_ids) and e.status in ('draft','washout','running','ready') limit 1;
    if busy.id is not null then raise exception 'E_EXPERIMENT_LOCK: % is already in the experiment "%"', s.display_name, busy.name; end if;
  end loop;
  insert into outreach_profile_experiments(workspace_id, name, field_group, variants, sender_ids, washout_days, min_invites_per_variant, created_by)
  values (p_ws, btrim(p_name), p_field_group, p_variants, p_sender_ids, coalesce(p_washout_days,3), coalesce(p_min_invites,120), auth.uid()) returning id into eid;
  perform outreach_audit(p_ws, 'profile.experiment_created', 'profile_experiment', eid::text, jsonb_build_object('name', p_name, 'field_group', p_field_group, 'senders', array_length(p_sender_ids,1)));
  return eid;
end $$;

-- Start: assign variants (balanced random), create one change per sender (source experiment) and submit them.
create or replace function outreach_profile_experiment_start(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_profile_experiments%rowtype; ids uuid[]; nv int; i int; assign jsonb := '{}'; vkey text; vval jsonb; payload jsonb; assets jsonb; cid uuid; res jsonb; n_q int := 0; n_w int := 0; n_f int := 0; details jsonb := '[]'; em citext; v jsonb; sid uuid;
begin
  select * into e from outreach_profile_experiments where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'manager');
  if e.status <> 'draft' then raise exception 'E_PROFILE_STATE: experiment is %', e.status; end if;
  nv := jsonb_array_length(e.variants);
  select array_agg(x order by random()) into ids from unnest(e.sender_ids) x;
  em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
  for i in 1..array_length(ids,1) loop
    vkey := (e.variants->((i-1) % nv))->>'key';
    vval := (e.variants->((i-1) % nv))->'value';
    assign := assign || jsonb_build_object(ids[i]::text, vkey);
  end loop;
  -- every sender must be able to take the change BEFORE anything is queued: an experiment with a missing arm is worthless
  for i in 1..array_length(ids,1) loop
    sid := ids[i]; vval := (e.variants->((i-1) % nv))->'value';
    payload := case e.field_group when 'headline' then jsonb_build_object('headline', vval #>> '{}') when 'about' then jsonb_build_object('summary', vval #>> '{}') else coalesce(vval->'payload', '{}'::jsonb) end;
    assets := case e.field_group when 'photo' then coalesce(vval->'assets', '{}'::jsonb) else '{}'::jsonb end;
    v := outreach_profile_validate(sid, payload, assets, 'experiment', 1, null, e.id);
    if not (v->>'ok')::boolean then
      raise exception 'E_EXPERIMENT_NOT_READY: % — %', (select display_name from outreach_senders where id = sid), (select x->>'detail' from jsonb_array_elements(v->'causes') x where (x->>'blocking')::boolean limit 1);
    end if;
  end loop;
  update outreach_profile_experiments set status = 'washout', assignment = assign, started_at = now() where id = e.id;
  for i in 1..array_length(ids,1) loop
    sid := ids[i]; vval := (e.variants->((i-1) % nv))->'value';
    payload := case e.field_group when 'headline' then jsonb_build_object('headline', vval #>> '{}') when 'about' then jsonb_build_object('summary', vval #>> '{}') else coalesce(vval->'payload', '{}'::jsonb) end;
    assets := case e.field_group when 'photo' then coalesce(vval->'assets', '{}'::jsonb) else '{}'::jsonb end;
    begin
      insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, assets, source, experiment_id, requested_by, requested_by_email, note)
      values (e.workspace_id, sid, array[e.field_group], payload, assets, 'experiment', e.id, auth.uid(), em, 'Experiment "' || e.name || '", variant ' || assign->>(sid::text)) returning id into cid;
      res := outreach_profile_submit_change(cid);
      if res->>'status' = 'queued' then n_q := n_q + 1; else n_w := n_w + 1; end if;
      details := details || jsonb_build_object('sender_id', sid, 'variant', assign->>(sid::text), 'change_id', cid, 'status', res->>'status');
    exception when others then
      n_f := n_f + 1; details := details || jsonb_build_object('sender_id', sid, 'variant', assign->>(sid::text), 'status', 'failed', 'error', sqlerrm);
    end;
  end loop;
  perform outreach_audit(e.workspace_id, 'profile.experiment_started', 'profile_experiment', e.id::text, jsonb_build_object('queued', n_q, 'awaiting_owner', n_w, 'failed', n_f));
  return jsonb_build_object('id', e.id, 'status', 'washout', 'assignment', assign, 'queued', n_q, 'awaiting_owner', n_w, 'failed', n_f, 'details', details,
    'note', case when e.field_group = 'photo' then 'Photo experiments need at least 21 days: the photo ceiling is one change per 30 days, so the losing arm can only be switched after that.' else null end);
end $$;

-- Readout (PRD §9.2). Only invites sent after washout_until count; an invite is resolved when accepted or 14 days old.
create or replace function outreach_profile_experiment_result(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare e outreach_profile_experiments%rowtype; arms jsonb := '[]'; st record; vk text; from_ts timestamptz; n_a numeric; x_a numeric; n_b numeric; x_b numeric; ka text; kb text; pa numeric; pb numeric; diff numeric; se numeric; lo numeric; hi numeric; z numeric; p numeric; pbar numeric; verdict text; warnings jsonb := '[]'; min_senders int; need int; ready boolean; last_invite timestamptz; all_resolved boolean; contamination int;
begin
  select * into e from outreach_profile_experiments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then
    perform outreach_require(e.workspace_id, 'member');
    -- a member limited to some clients sees only experiments whose senders are all visible to them
    if exists (select 1 from outreach_senders sx where sx.id = any(e.sender_ids) and not outreach_client_visible(e.workspace_id, sx.client_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  end if;
  from_ts := e.washout_until;
  for vk in select v->>'key' from jsonb_array_elements(e.variants) v loop
    select count(distinct u.s) as senders,
           count(l.lead_id) filter (where l.invite_accepted_at is not null or l.invite_sent_at < now() - interval '14 days') as resolved,
           count(l.lead_id) filter (where l.invite_accepted_at is not null) as accepted,
           count(l.lead_id) filter (where l.invite_accepted_at is null and l.invite_sent_at >= now() - interval '14 days') as pending,
           max(l.invite_sent_at) as last_at
      into st
      from unnest(e.sender_ids) u(s)
      left join outreach_lead_sender_state l on l.sender_id = u.s and from_ts is not null and l.invite_sent_at > from_ts
     where e.assignment->>(u.s::text) = vk;
    arms := arms || jsonb_build_object('key', vk, 'senders', st.senders, 'resolved', st.resolved, 'accepted', st.accepted, 'pending', st.pending,
                                       'rate', case when st.resolved > 0 then round(100.0 * st.accepted / st.resolved, 1) end, 'last_invite_at', st.last_at);
  end loop;

  select min((x->>'senders')::int) into min_senders from jsonb_array_elements(arms) x;
  if min_senders < 2 then warnings := warnings || jsonb_build_object('code','confounded','text','With fewer than 2 senders in an arm, the sender and the variant are the same thing: no number can separate them. Add senders.'); end if;
  if min_senders < 5 then warnings := warnings || jsonb_build_object('code','cluster','text','Fewer than 5 senders per arm: differences between the people (their networks, seniority, existing connections) are likely larger than the effect of the variant, and the interval below understates the uncertainty.'); end if;
  select count(*) into contamination from outreach_sequence_versions sv join outreach_sequences sq on sq.id = sv.sequence_id
   where sq.workspace_id = e.workspace_id and sq.sender_pool && e.sender_ids and e.started_at is not null and sv.created_at > e.started_at;
  if contamination > 0 then warnings := warnings || jsonb_build_object('code','contamination','text', contamination || ' sequence edit(s) were published for participating senders during the experiment. Message copy changed under the test, so part of any difference may be the copy, not the profile.'); end if;

  -- two-arm comparison (first two variants; more arms are reported but not tested)
  ka := arms->0->>'key'; kb := arms->1->>'key';
  n_a := (arms->0->>'resolved')::numeric; x_a := (arms->0->>'accepted')::numeric; n_b := (arms->1->>'resolved')::numeric; x_b := (arms->1->>'accepted')::numeric;
  if n_a >= 20 and n_b >= 20 and min_senders >= 2 then
    pa := x_a / n_a; pb := x_b / n_b; diff := pb - pa;
    se := sqrt(pa*(1-pa)/n_a + pb*(1-pb)/n_b);
    lo := diff - 1.96*se; hi := diff + 1.96*se;
    pbar := (x_a + x_b) / (n_a + n_b);
    z := case when pbar in (0,1) then 0 else diff / sqrt(pbar*(1-pbar)*(1/n_a + 1/n_b)) end;
    p := 2 * (1 - outreach__phi(abs(z)));
    need := case when abs(diff) < 0.005 then null else ceil(2 * 7.84 * pbar*(1-pbar) / (diff*diff)) end;   -- 80% power, two-sided 5%
    verdict := case when lo > 0 then 'b_better' when hi < 0 then 'a_better' else 'not_conclusive' end;
  else
    verdict := case when min_senders < 2 then 'insufficient_senders' else 'insufficient_data' end;
  end if;

  select bool_and(coalesce((x->>'resolved')::int,0) >= e.min_invites_per_variant) into all_resolved from jsonb_array_elements(arms) x;
  select max((x->>'last_invite_at')::timestamptz) into last_invite from jsonb_array_elements(arms) x;
  ready := coalesce(all_resolved, false) or (last_invite is not null and last_invite < now() - interval '14 days' and n_a >= 20 and n_b >= 20);

  return jsonb_build_object('experiment_id', e.id, 'status', e.status, 'metric', e.metric, 'field_group', e.field_group, 'washout_until', e.washout_until, 'arms', arms,
    'comparison', case when pa is null then null else jsonb_build_object('a', ka, 'b', kb, 'rate_a', round(100*pa,1), 'rate_b', round(100*pb,1), 'difference_points', round(100*diff,1), 'ci_low', round(100*lo,1), 'ci_high', round(100*hi,1), 'p_value', round(p,3), 'required_per_variant', need) end,
    'verdict', verdict, 'ready', ready, 'warnings', warnings,
    'summary', case
      when verdict = 'insufficient_senders' then 'Every arm needs at least 2 senders before a number means anything.'
      when verdict = 'insufficient_data' then 'Not enough resolved invitations yet (need 20 per variant to compare, ' || e.min_invites_per_variant || ' to conclude).'
      else format('Variant %s accepted at %s%% (%s/%s) against %s''s %s%% (%s/%s). Difference %s%s points, 95%% CI %s to %s. %s',
             kb, round(100*pb,1), x_b, n_b, ka, round(100*pa,1), x_a, n_a, case when diff >= 0 then '+' else '' end, round(100*diff,1), round(100*lo,1), round(100*hi,1),
             case when verdict = 'not_conclusive' then 'Not conclusive: the interval crosses zero.' || case when need is not null then format(' To detect a %s-point difference reliably you would need roughly %s resolved invitations per variant.', round(100*abs(diff),0), need) else '' end
                  when verdict = 'b_better' then format('%s did better and the interval excludes zero.', kb) else format('%s did better and the interval excludes zero.', ka) end)
    end);
end $$;

-- Worker: washout → running once every change landed and the washout elapsed; running → ready per the readout. Service only.
create or replace function outreach_profile_experiment_advance() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e record; n_run int := 0; n_ready int := 0; n_ab int := 0; last_applied timestamptz; n_bad int; n_open int; r jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for e in select * from outreach_profile_experiments where status in ('washout','running') loop
    if e.status = 'washout' then
      select count(*) filter (where status in ('failed','cancelled')), count(*) filter (where status in ('draft','awaiting_owner','approved','queued')), max(applied_at)
        into n_bad, n_open, last_applied from outreach_profile_changes where experiment_id = e.id;
      if n_bad > 0 then
        update outreach_profile_experiments set status = 'abandoned', concluded_at = now(), result = jsonb_build_object('reason', 'A profile change for a participating sender failed or was declined, so the arms are incomplete.') where id = e.id;
        n_ab := n_ab + 1; continue;
      end if;
      if n_open = 0 and last_applied is not null then
        if e.washout_until is null then update outreach_profile_experiments set washout_until = last_applied + make_interval(days => e.washout_days) where id = e.id; end if;
        if coalesce(e.washout_until, last_applied + make_interval(days => e.washout_days)) <= now() then
          update outreach_profile_experiments set status = 'running' where id = e.id; n_run := n_run + 1;
        end if;
      elsif e.started_at < now() - interval '21 days' then
        update outreach_profile_experiments set status = 'abandoned', concluded_at = now(), result = jsonb_build_object('reason', 'Not every profile change was approved within 21 days.') where id = e.id; n_ab := n_ab + 1;
      end if;
    else
      r := outreach_profile_experiment_result(e.id);
      update outreach_profile_experiments set result = r where id = e.id;
      if (r->>'ready')::boolean then update outreach_profile_experiments set status = 'ready' where id = e.id; n_ready := n_ready + 1; end if;
    end if;
  end loop;
  return jsonb_build_object('to_running', n_run, 'to_ready', n_ready, 'abandoned', n_ab);
end $$;
revoke execute on function outreach_profile_experiment_advance() from public, anon, authenticated;

-- Conclude. Applying the winner to the losing arm is an ordinary bulk of changes (ceilings + authority), never automatic.
create or replace function outreach_profile_experiment_conclude(p_id uuid, p_apply_winner boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_profile_experiments%rowtype; r jsonb; win text; wval jsonb; sid text; payload jsonb; assets jsonb; cid uuid; res jsonb; n_q int := 0; n_w int := 0; n_f int := 0; em citext; details jsonb := '[]';
begin
  select * into e from outreach_profile_experiments where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'manager');
  if e.status not in ('running','ready','washout') then raise exception 'E_PROFILE_STATE: experiment is %', e.status; end if;
  r := outreach_profile_experiment_result(p_id);
  update outreach_profile_experiments set status = 'concluded', concluded_at = now(), result = r where id = p_id;
  win := case r->>'verdict' when 'b_better' then r->'comparison'->>'b' when 'a_better' then r->'comparison'->>'a' end;
  if p_apply_winner then
    if win is null then raise exception 'E_EXPERIMENT_NO_WINNER: the readout did not declare a winner, so nothing is applied'; end if;
    select v->'value' into wval from jsonb_array_elements(e.variants) v where v->>'key' = win;
    payload := case e.field_group when 'headline' then jsonb_build_object('headline', wval #>> '{}') when 'about' then jsonb_build_object('summary', wval #>> '{}') else coalesce(wval->'payload','{}'::jsonb) end;
    assets := case e.field_group when 'photo' then coalesce(wval->'assets','{}'::jsonb) else '{}'::jsonb end;
    em := nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email';
    for sid in select key from jsonb_each_text(e.assignment) where value <> win loop
      begin
        insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, assets, source, experiment_id, requested_by, requested_by_email, note)
        values (e.workspace_id, sid::uuid, array[e.field_group], payload, assets, 'experiment', e.id, auth.uid(), em, 'Winner of experiment "' || e.name || '" (' || win || ')') returning id into cid;
        res := outreach_profile_submit_change(cid);
        if res->>'status' = 'queued' then n_q := n_q + 1; else n_w := n_w + 1; end if;
        details := details || jsonb_build_object('sender_id', sid, 'change_id', cid, 'status', res->>'status');
      exception when others then n_f := n_f + 1; details := details || jsonb_build_object('sender_id', sid, 'status', 'failed', 'error', sqlerrm); end;
    end loop;
  end if;
  perform outreach_audit(e.workspace_id, 'profile.experiment_concluded', 'profile_experiment', e.id::text, jsonb_build_object('verdict', r->>'verdict', 'winner', win, 'applied', p_apply_winner));
  return jsonb_build_object('id', e.id, 'status', 'concluded', 'result', r, 'winner', win, 'applied', jsonb_build_object('queued', n_q, 'awaiting_owner', n_w, 'failed', n_f, 'details', details));
end $$;

create or replace function outreach_profile_experiment_abandon(p_id uuid, p_reason text default 'abandoned') returns void
language plpgsql security definer set search_path = public, extensions as $$
declare e outreach_profile_experiments%rowtype; c record;
begin
  select * into e from outreach_profile_experiments where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'manager');
  if e.status in ('concluded','abandoned') then return; end if;
  for c in select id from outreach_profile_changes where experiment_id = p_id and status in ('draft','awaiting_owner','approved','queued') loop perform outreach_profile_cancel_change(c.id, 'experiment_abandoned'); end loop;
  update outreach_profile_experiments set status = 'abandoned', concluded_at = now(), result = coalesce(result,'{}'::jsonb) || jsonb_build_object('reason', left(p_reason,200)) where id = p_id;
  perform outreach_audit(e.workspace_id, 'profile.experiment_abandoned', 'profile_experiment', e.id::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function outreach_profile_experiments_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'name', e.name, 'field_group', e.field_group, 'status', e.status, 'variants', e.variants, 'sender_ids', to_jsonb(e.sender_ids), 'assignment', e.assignment,
            'washout_days', e.washout_days, 'min_invites_per_variant', e.min_invites_per_variant, 'started_at', e.started_at, 'washout_until', e.washout_until, 'concluded_at', e.concluded_at, 'result', e.result, 'created_at', e.created_at,
            'senders', (select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'variant', e.assignment->>(s.id::text))) from outreach_senders s where s.id = any(e.sender_ids)),
            'changes', (select jsonb_agg(jsonb_build_object('id', c.id, 'sender_id', c.sender_id, 'status', c.status)) from outreach_profile_changes c where c.experiment_id = e.id)) order by e.created_at desc), '[]'::jsonb)
          from outreach_profile_experiments e where e.workspace_id = p_ws
           and not exists (select 1 from outreach_senders sx where sx.id = any(e.sender_ids) and not outreach_client_visible(p_ws, sx.client_id)));
end $$;

-- -----------------------------------------------------------------------------
-- Cron + grants
-- -----------------------------------------------------------------------------
do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('outreach-profile-tick','outreach-profile-weekly') loop perform cron.unschedule(j.jobid); end loop;
end $$;
select cron.schedule('outreach-profile-tick',   '*/5 * * * *', $$select outreach_invoke('outreach-worker-profile', '{"mode":"tick"}'::jsonb)$$);      -- verify applied changes, notify owners, advance experiments, expire
select cron.schedule('outreach-profile-weekly', '35 3 * * 1',  $$select outreach_invoke('outreach-worker-profile', '{"mode":"weekly"}'::jsonb)$$);    -- staggered drift re-read + QA recompute

-- Signed-in users may call the user-facing functions; internal ones are service-only (017 keeps whatever this grants).
do $$
declare f record;
  internal_fns text[] := array['outreach_profile_identity_verified','outreach_profile_authority_for','outreach_profile_ceiling_used','outreach_profile_groups_of','outreach_profile_payload_prohibited','outreach_profile_payload_problem',
    'outreach_profile_render_text','outreach_profile_render_json','outreach_profile_sender_vars','outreach_profile_permission_required','outreach__phi'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like 'outreach\_profile%' or p.proname = 'outreach__phi') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = any(internal_fns) then execute format('revoke execute on function %s from authenticated', f.sig); end if;
  end loop;
end $$;
