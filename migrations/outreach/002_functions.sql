-- =============================================================================
-- Outreach Platform — 002 functions (all `outreach_` prefixed, schema public)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Auth / RLS helpers
-- -----------------------------------------------------------------------------
create or replace function outreach_is_service() returns boolean
language sql stable as $$
  select coalesce(auth.role(), 'internal') in ('service_role','internal')
$$;

create or replace function outreach_workspace_ids() returns setof uuid
language sql stable security definer set search_path = public, extensions, extensions as $$
  select workspace_id from outreach_members where user_id = auth.uid()
$$;

create or replace function outreach_role_in(ws uuid) returns outreach_role_t
language sql stable security definer set search_path = public, extensions, extensions as $$
  select role from outreach_members where user_id = auth.uid() and workspace_id = ws
$$;

create or replace function outreach_client_visible(ws uuid, cid uuid) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select exists (
    select 1 from outreach_members m
    where m.user_id = auth.uid() and m.workspace_id = ws
      and (m.role in ('owner','manager') or cid is null or cid = any(m.client_ids))
  )
$$;

create or replace function outreach_plan_active(ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select coalesce((select plan <> 'suspended' from outreach_workspaces where id = ws), false)
$$;

create or replace function outreach_can_write(ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select outreach_role_in(ws) in ('owner','manager','member') and outreach_plan_active(ws)
$$;

create or replace function outreach_can_manage(ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select outreach_role_in(ws) in ('owner','manager') and outreach_plan_active(ws)
$$;

create or replace function outreach_require(ws uuid, p_min text) returns void
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare r outreach_role_t;
begin
  if outreach_is_service() then return; end if;
  r := outreach_role_in(ws);
  if r is null then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
  if not outreach_plan_active(ws) then raise exception 'E_PLAN_SUSPENDED'; end if;
  if p_min = 'owner' and r <> 'owner' then raise exception 'E_FORBIDDEN: owner required'; end if;
  if p_min = 'manager' and r not in ('owner','manager') then raise exception 'E_FORBIDDEN: manager required'; end if;
  if p_min = 'member' and r not in ('owner','manager','member') then raise exception 'E_FORBIDDEN: member required'; end if;
end $$;

-- -----------------------------------------------------------------------------
-- Generic utilities
-- -----------------------------------------------------------------------------
create or replace function outreach_set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create or replace function outreach_audit(p_ws uuid, p_action text, p_entity text, p_entity_id text, p_diff jsonb default null, p_actor_type text default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
begin
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (p_ws, auth.uid(), coalesce(p_actor_type, case when auth.uid() is null then 'system' else 'user' end), p_action, p_entity, p_entity_id, p_diff);
end $$;

-- Emit a platform event: fan out to matching outbound webhooks + audit
create or replace function outreach_emit_event(p_ws uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
begin
  insert into outreach_outbound_webhook_deliveries(webhook_id, workspace_id, event, payload)
  select w.id, p_ws, p_event, jsonb_build_object('event', p_event, 'workspace_id', p_ws, 'at', now(), 'data', p_payload)
  from outreach_outbound_webhooks w
  where w.workspace_id = p_ws and w.active and (p_event = any(w.events) or '*' = any(w.events));
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (p_ws, auth.uid(), 'system', p_event, split_part(p_event,'.',1), coalesce(p_payload->>'id', p_payload->>'lead_id', p_payload->>'sender_id'), p_payload);
end $$;

create or replace function outreach_rate_limit(p_key text, p_limit int, p_window_secs int) returns boolean
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare c int;
begin
  insert into outreach_rate_limits(key, count, window_end) values (p_key, 1, now() + make_interval(secs => p_window_secs))
  on conflict (key) do update
    set count = case when outreach_rate_limits.window_end < now() then 1 else outreach_rate_limits.count + 1 end,
        window_end = case when outreach_rate_limits.window_end < now() then now() + make_interval(secs => p_window_secs) else outreach_rate_limits.window_end end
  returning count into c;
  return c <= p_limit;
end $$;

-- -----------------------------------------------------------------------------
-- Schedule / timezone helpers
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_local_date(p_sender uuid, p_at timestamptz) returns date
language sql stable security definer set search_path = public, extensions, extensions as $$
  select (p_at at time zone coalesce((select timezone from outreach_senders where id = p_sender), 'UTC'))::date
$$;

create or replace function outreach_in_schedule(p_sender uuid, p_at timestamptz) returns boolean
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare tz text; sch jsonb; lt timestamp; dow text; tod text; w jsonb;
begin
  select timezone, schedule into tz, sch from outreach_senders where id = p_sender;
  if tz is null then return false; end if;
  lt := p_at at time zone tz;
  dow := lower(to_char(lt, 'dy'));
  tod := to_char(lt, 'HH24:MI');
  for w in select * from jsonb_array_elements(coalesce(sch->dow, '[]'::jsonb)) loop
    if tod >= (w->>0) and tod < (w->>1) then return true; end if;
  end loop;
  return false;
end $$;

-- Windows for a sender-local calendar day, returned as UTC timestamptz ranges
create or replace function outreach_schedule_windows(p_sender uuid, p_day date)
returns table(start_at timestamptz, end_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare tz text; sch jsonb; dow text; w jsonb;
begin
  select timezone, schedule into tz, sch from outreach_senders where id = p_sender;
  if tz is null then return; end if;
  dow := lower(to_char(p_day, 'dy'));
  for w in select * from jsonb_array_elements(coalesce(sch->dow, '[]'::jsonb)) loop
    start_at := ((p_day::text || ' ' || (w->>0))::timestamp) at time zone tz;
    end_at   := ((p_day::text || ' ' || (w->>1))::timestamp) at time zone tz;
    if end_at > start_at then return next; end if;
  end loop;
end $$;

create or replace function outreach_sender_local_hour(p_sender uuid, p_at timestamptz) returns int
language sql stable security definer set search_path = public, extensions, extensions as $$
  select extract(hour from (p_at at time zone coalesce((select timezone from outreach_senders where id = p_sender), 'UTC')))::int
$$;

-- -----------------------------------------------------------------------------
-- Caps & budgets (the ledger)
-- -----------------------------------------------------------------------------
create or replace function outreach_weekly_invites_used(p_sender uuid, p_day date) returns int
language sql stable security definer set search_path = public, extensions, extensions as $$
  select coalesce(sum(used + reserved), 0)::int from outreach_sender_budgets
  where sender_id = p_sender and action_type = 'invite'
    and day >= date_trunc('week', p_day)::date and day < (date_trunc('week', p_day)::date + 7)
$$;

-- Effective base cap before jitter: min(ceiling, warmup level cap, manual cap) * health multiplier
create or replace function outreach_effective_cap(p_sender uuid, p_type outreach_action_type_t) returns int
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype; ceil_v int; warm_v int; man_v int; base int; mult numeric := 1;
begin
  select * into s from outreach_senders where id = p_sender;
  select per_day into ceil_v from outreach_platform_ceilings where action_type = p_type;
  if ceil_v is null then return 0; end if;
  if p_type in ('reply','call_api','relations_poll') then return ceil_v; end if;
  select per_day into warm_v from outreach_warmup_caps where level = s.warmup_level and action_type = p_type;
  base := least(ceil_v, coalesce(warm_v, ceil_v));
  if s.manual_caps ? p_type::text then
    man_v := (s.manual_caps->>p_type::text)::int;
    base := least(base, greatest(man_v, 0));
  end if;
  if s.health_score < 50 then mult := 0;
  elsif s.health_score < 70 then mult := 0.6; end if;
  return floor(base * mult)::int;
end $$;

-- Upsert today's/tomorrow's budgets for every action type. Idempotent; keeps used/reserved.
create or replace function outreach_plan_budgets(p_sender uuid, p_day date)
returns setof outreach_sender_budgets
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare t outreach_action_type_t; base int; capv int; has_window boolean; jitter numeric; wk int; wk_ceiling int;
begin
  select exists(select 1 from outreach_schedule_windows(p_sender, p_day)) into has_window;
  for t in select action_type from outreach_platform_ceilings loop
    base := outreach_effective_cap(p_sender, t);
    if t in ('reply','call_api','relations_poll') then
      capv := base;
    elsif not has_window then
      capv := 0;
    else
      jitter := 0.9 + random() * 0.2;
      capv := floor(base * jitter)::int;
      if base >= 1 and capv < 1 then capv := 1; end if;
      if t = 'invite' then
        select per_week into wk_ceiling from outreach_platform_ceilings where action_type = 'invite';
        wk := outreach_weekly_invites_used(p_sender, p_day)
              - coalesce((select used + reserved from outreach_sender_budgets where sender_id = p_sender and day = p_day and action_type = 'invite'), 0);
        capv := greatest(least(capv, coalesce(wk_ceiling, 150) - wk), 0);
      end if;
    end if;
    insert into outreach_sender_budgets(sender_id, day, action_type, cap)
    values (p_sender, p_day, t, capv)
    on conflict (sender_id, day, action_type) do update
      set cap = greatest(excluded.cap, outreach_sender_budgets.used + outreach_sender_budgets.reserved);
  end loop;
  return query select * from outreach_sender_budgets where sender_id = p_sender and day = p_day;
end $$;

create or replace function outreach_reserve_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns boolean
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare ok boolean;
begin
  update outreach_sender_budgets set reserved = reserved + 1
   where sender_id = p_sender and day = p_day and action_type = p_type and used + reserved < cap
   returning true into ok;
  if ok is null then
    if not exists (select 1 from outreach_sender_budgets where sender_id = p_sender and day = p_day and action_type = p_type) then
      perform outreach_plan_budgets(p_sender, p_day);
      update outreach_sender_budgets set reserved = reserved + 1
       where sender_id = p_sender and day = p_day and action_type = p_type and used + reserved < cap
       returning true into ok;
    end if;
  end if;
  return coalesce(ok, false);
end $$;

create or replace function outreach_release_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns void
language sql security definer set search_path = public, extensions, extensions as $$
  update outreach_sender_budgets set reserved = greatest(reserved - 1, 0)
  where sender_id = p_sender and day = p_day and action_type = p_type
$$;

-- -----------------------------------------------------------------------------
-- Graph helpers
-- -----------------------------------------------------------------------------
create or replace function outreach_node_action_type(p_type text) returns outreach_action_type_t
language sql immutable as $$
  select case p_type
    when 'visit_profile' then 'profile_view'::outreach_action_type_t
    when 'like_latest_post' then 'like'
    when 'comment_latest_post' then 'comment'
    when 'endorse_skills' then 'endorse'
    when 'send_invite' then 'invite'
    when 'withdraw_invite' then 'withdraw'
    when 'send_message' then 'message'
    when 'send_inmail' then 'inmail'
    when 'send_email' then 'email'
    when 'call_api' then 'call_api'
    else null end
$$;

create or replace function outreach_is_executable_node(p_type text) returns boolean
language sql immutable as $$
  select p_type in ('visit_profile','like_latest_post','comment_latest_post','endorse_skills','send_invite',
                    'withdraw_invite','send_message','send_inmail','send_email','call_api')
$$;

create or replace function outreach_node_types() returns text[]
language sql immutable as $$
  select array['start','end','visit_profile','like_latest_post','comment_latest_post','endorse_skills','send_invite',
    'wait_connection','withdraw_invite','send_message','send_inmail','send_email','delay','condition','rotate_sender',
    'change_sender','add_tag','remove_tag','change_list','change_stage','call_webhook','call_api','send_to_sequence',
    'manual_task','ai_draft_approval']
$$;

-- Structural + semantic validation. p_strict=true adds activation-level checks.
create or replace function outreach_validate_graph(p_graph jsonb, p_pool uuid[] default '{}', p_strict boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare
  errors jsonb := '[]'; warnings jsonb := '[]';
  nodes jsonb; k text; n jsonb; t text; nxt text; b record;
  has_free boolean := false; has_mailbox boolean := false;
  has_connect_path boolean := false; has_terminal boolean := false;
  note_limit int; visited text[] := '{}'; queue text[]; cur text;
begin
  if p_graph is null or jsonb_typeof(p_graph) <> 'object' then
    return jsonb_build_object('errors', jsonb_build_array(jsonb_build_object('code','E_GRAPH_INVALID','message','graph must be an object')), 'warnings', '[]'::jsonb);
  end if;
  nodes := p_graph->'nodes';
  if nodes is null or jsonb_typeof(nodes) <> 'object' then
    errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','graph.nodes missing');
    return jsonb_build_object('errors', errors, 'warnings', warnings);
  end if;
  if not (nodes ? coalesce(p_graph->>'start','')) then
    errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','start node not found');
  end if;

  if array_length(p_pool,1) > 0 then
    select bool_or(not is_premium) filter (where provider = 'LINKEDIN'), bool_or(provider <> 'LINKEDIN')
      into has_free, has_mailbox from outreach_senders where id = any(p_pool);
  end if;
  note_limit := case when coalesce(has_free,false) then 200 else 300 end;

  for k, n in select * from jsonb_each(nodes) loop
    t := n->>'type';
    if t is null or not (t = any(outreach_node_types())) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','unknown node type '||coalesce(t,'null'));
      continue;
    end if;
    if coalesce(n->>'id', k) <> k then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','node id mismatch');
    end if;
    nxt := n->>'next';
    if nxt is not null and not (nodes ? nxt) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','next points to missing node '||nxt);
    end if;
    if n ? 'branches' then
      for b in select * from jsonb_each_text(n->'branches') loop
        if b.value is not null and not (nodes ? b.value) then
          errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','branch '||b.key||' points to missing node');
        end if;
      end loop;
    end if;
    if t = 'end' or (nxt is null and not (n ? 'branches') and t <> 'start') or t = 'send_to_sequence' then has_terminal := true; end if;
    if t in ('send_invite','wait_connection','send_inmail') then has_connect_path := true; end if;

    if t = 'send_invite' and length(coalesce(n->'config'->>'note','')) > note_limit then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NOTE_TOO_LONG','message','invite note exceeds '||note_limit||' characters');
    end if;
    if t = 'send_message' and length(coalesce(n->'config'->>'text','')) > 8000 then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_PAYLOAD_INVALID','message','message exceeds 8000 characters');
    end if;
    if t = 'comment_latest_post' and length(coalesce(n->'config'->>'text','')) > 1250 then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_PAYLOAD_INVALID','message','comment exceeds 1250 characters');
    end if;
    if t = 'send_inmail' and (length(coalesce(n->'config'->>'subject','')) > 200 or length(coalesce(n->'config'->>'text','')) > 1900) then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_PAYLOAD_INVALID','message','InMail subject/body exceeds limits (200/1900)');
    end if;
    if t = 'condition' and not (n->'branches' ? 'true' and n->'branches' ? 'false') then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_BRANCH_MISSING','message','condition should define true and false branches');
    end if;
    if t = 'wait_connection' and not (n->'branches' ? 'connected') then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_GRAPH_INVALID','message','wait_connection needs a connected branch');
    end if;
    if t = 'send_email' and p_strict and not has_mailbox and (n->'config'->>'mailbox_sender_id') is null then
      errors := errors || jsonb_build_object('node_id', k, 'code','E_NO_MAILBOX','message','email node requires a mailbox sender in the pool');
    end if;
    if t in ('send_invite','send_message','comment_latest_post','send_inmail') and (n->'config'->'ai') is not null and (n->'config'->'ai'->>'brief') is null then
      warnings := warnings || jsonb_build_object('node_id', k, 'code','W_AI_BRIEF','message','AI drafting enabled without a brief');
    end if;
  end loop;

  if p_strict then
    if not has_terminal then
      errors := errors || jsonb_build_object('code','E_GRAPH_INVALID','message','no exit path (add an End node)');
    end if;
    if exists (select 1 from jsonb_each(nodes) x where x.value->>'type' = 'send_message' and not coalesce((x.value->'config'->>'send_always')::boolean,false)) and not has_connect_path then
      errors := errors || jsonb_build_object('code','E_RELATION_REQUIRED','message','a message node needs an invite / wait_connection (or InMail) path before it');
    end if;
    -- reachability warning
    queue := array[p_graph->>'start'];
    while array_length(queue,1) > 0 loop
      cur := queue[1]; queue := queue[2:];
      if cur is null or cur = any(visited) then continue; end if;
      visited := visited || cur;
      n := nodes->cur;
      if n->>'next' is not null then queue := queue || (n->>'next'); end if;
      if n ? 'branches' then
        for b in select * from jsonb_each_text(n->'branches') loop queue := queue || b.value; end loop;
      end if;
    end loop;
    for k in select key from jsonb_each(nodes) loop
      if not (k = any(visited)) then
        warnings := warnings || jsonb_build_object('node_id', k, 'code','W_UNREACHABLE','message','node is not reachable from start');
      end if;
    end loop;
  end if;

  return jsonb_build_object('errors', errors, 'warnings', warnings);
end $$;

-- -----------------------------------------------------------------------------
-- Condition evaluation
-- -----------------------------------------------------------------------------
create or replace function outreach_eval_rule(p_rule jsonb, p_lead outreach_leads, p_lss outreach_lead_sender_state, p_sender outreach_senders)
returns boolean language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare f text; op text; v text; actual text; ok boolean;
begin
  f := p_rule->>'field'; op := coalesce(p_rule->>'op','eq'); v := p_rule->>'value';
  if f = 'replied' then actual := coalesce(p_lss.replied,false)::text;
  elsif f = 'accepted' then actual := (coalesce(p_lss.relation,'none') = 'first')::text;
  elsif f = 'relation' then actual := coalesce(p_lss.relation,'none')::text;
  elsif f = 'email_bounced' then actual := coalesce(p_lss.email_bounced,false)::text;
  elsif f = 'has_email_work' then actual := (p_lead.email_work is not null)::text;
  elsif f = 'has_email_personal' then actual := (p_lead.email_personal is not null)::text;
  elsif f = 'is_open_profile' then actual := coalesce(p_lead.is_open_profile,false)::text;
  elsif f = 'has_tag' then actual := exists(select 1 from outreach_lead_tags where lead_id = p_lead.id and tag_id::text = v)::text; v := 'true';
  elsif f = 'stage_is' then actual := (p_lead.stage_id::text = v)::text; v := 'true';
  elsif f = 'sender_is_premium' then actual := coalesce(p_sender.is_premium,false)::text;
  elsif f like 'custom.%' then actual := p_lead.custom->>substr(f,8);
  elsif f = 'company' then actual := p_lead.company;
  elsif f = 'title' then actual := p_lead.title;
  elsif f = 'headline' then actual := p_lead.headline;
  elsif f = 'location' then actual := p_lead.location;
  else actual := null; end if;

  if op in ('eq','is') then ok := coalesce(lower(actual) = lower(coalesce(v,'')), false);
  elsif op in ('neq','not','is_not') then ok := coalesce(lower(actual) <> lower(coalesce(v,'')), true);
  elsif op = 'contains' then ok := coalesce(position(lower(coalesce(v,'')) in lower(actual)) > 0, false);
  elsif op = 'not_contains' then ok := coalesce(position(lower(coalesce(v,'')) in lower(actual)) = 0, true);
  elsif op = 'exists' then ok := actual is not null and actual <> '';
  elsif op = 'not_exists' then ok := actual is null or actual = '';
  elsif op = 'gt' then ok := coalesce(actual::numeric > v::numeric, false);
  elsif op = 'lt' then ok := coalesce(actual::numeric < v::numeric, false);
  else ok := false; end if;
  return ok;
exception when others then return false;
end $$;

create or replace function outreach_eval_condition(p_config jsonb, p_lead_id uuid, p_sender_id uuid)
returns boolean language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare l outreach_leads; s outreach_lead_sender_state; sd outreach_senders; r jsonb; m text; res boolean; any_true boolean := false; all_true boolean := true; cnt int := 0;
begin
  select * into l from outreach_leads where id = p_lead_id;
  select * into s from outreach_lead_sender_state where lead_id = p_lead_id and sender_id = p_sender_id;
  select * into sd from outreach_senders where id = p_sender_id;
  m := coalesce(p_config->>'match','all');
  for r in select * from jsonb_array_elements(coalesce(p_config->'rules','[]'::jsonb)) loop
    cnt := cnt + 1;
    res := outreach_eval_rule(r, l, s, sd);
    any_true := any_true or res;
    all_true := all_true and res;
  end loop;
  if cnt = 0 then return true; end if;
  return case when m = 'any' then any_true else all_true end;
end $$;

-- -----------------------------------------------------------------------------
-- Actions: queue helper
-- -----------------------------------------------------------------------------
create or replace function outreach_queue_action(
  p_enrollment uuid, p_node_id text, p_type outreach_action_type_t, p_scheduled_for timestamptz,
  p_payload jsonb default '{}', p_sender uuid default null, p_lead uuid default null, p_import_job uuid default null, p_workspace uuid default null
) returns uuid language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype; attempt_no int; key text; ws uuid; sid uuid; lid uuid; aid uuid; sched timestamptz;
begin
  if p_enrollment is not null then
    select * into e from outreach_enrollments where id = p_enrollment;
    if not found then raise exception 'E_ENROLLMENT_NOT_FOUND'; end if;
    ws := e.workspace_id; sid := e.sender_id; lid := e.lead_id;
  else
    ws := p_workspace; sid := p_sender; lid := p_lead;
  end if;
  if not outreach_is_service() then perform outreach_require(ws, 'member'); end if;
  select count(*) + 1 into attempt_no from outreach_actions
    where coalesce(enrollment_id::text, coalesce(import_job_id::text, sid::text)) = coalesce(p_enrollment::text, coalesce(p_import_job::text, sid::text))
      and coalesce(node_id,'') = coalesce(p_node_id,'') and action_type = p_type and coalesce(lead_id::text,'') = coalesce(lid::text,'')
      and coalesce((payload->>'prefetch')::boolean,false) = coalesce((p_payload->>'prefetch')::boolean,false)
      and coalesce((payload->>'subtask')::boolean,false) = coalesce((p_payload->>'subtask')::boolean,false);
  key := encode(digest(coalesce(p_enrollment::text, coalesce(p_import_job::text, sid::text)) || '|' || coalesce(p_node_id,'') || '|' || p_type::text || '|' || coalesce(lid::text,'') || '|' || coalesce(p_payload->>'prefetch','') || coalesce(p_payload->>'subtask','') || '|' || attempt_no::text, 'sha256'), 'hex');
  -- jitter: never on :00 / :30 exactly
  sched := p_scheduled_for;
  if extract(second from sched) = 0 and extract(minute from sched)::int in (0,30) then
    sched := sched + make_interval(secs => 1 + floor(random()*58));
  end if;
  insert into outreach_actions(workspace_id, enrollment_id, import_job_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload)
  values (ws, p_enrollment, p_import_job, sid, lid, p_node_id, p_type, sched, key, coalesce(p_payload,'{}'))
  on conflict (idempotency_key) do nothing
  returning id into aid;
  return aid;
end $$;

-- -----------------------------------------------------------------------------
-- Enrollment engine
-- -----------------------------------------------------------------------------
create or replace function outreach_complete_enrollment(p_id uuid, p_status outreach_enrollment_status_t, p_reason text)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  update outreach_enrollments set status = p_status, exit_reason = p_reason, completed_at = now(), wait_until = null
   where id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
   returning * into e;
  if found then
    perform outreach_emit_event(e.workspace_id, case when p_status = 'completed' then 'enrollment.completed' else 'enrollment.exited' end,
      jsonb_build_object('id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'sequence_id', e.sequence_id, 'status', p_status, 'reason', p_reason));
  end if;
end $$;

create or replace function outreach_create_node_task(p_e outreach_enrollments, p_node jsonb, p_kind outreach_task_kind_t)
returns uuid language plpgsql security definer set search_path = public, extensions, extensions as $$
declare tid uuid; ttl text; bdy text; cid uuid; lname text;
begin
  select client_id into cid from outreach_sequences where id = p_e.sequence_id;
  select coalesce(full_name, public_identifier::text, email_work::text, 'lead') into lname from outreach_leads where id = p_e.lead_id;
  ttl := coalesce(p_node->'config'->>'title', p_node->>'label', replace(p_node->>'type','_',' ')) || ' — ' || lname;
  bdy := coalesce(p_node->'config'->>'body', p_node->'config'->>'text', p_node->'config'->>'note', p_node->'config'->'ai'->>'brief');
  insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, enrollment_id, node_id, title, body, draft_kind, due_at)
  values (p_e.workspace_id, cid, p_kind, p_e.lead_id, p_e.sender_id, p_e.id, p_node->>'id', ttl, bdy,
          coalesce(p_node->'config'->>'kind', case p_node->>'type' when 'send_invite' then 'invite_note' when 'comment_latest_post' then 'comment' else 'message' end),
          now() + interval '1 day')
  returning id into tid;
  perform outreach_emit_event(p_e.workspace_id, 'task.created', jsonb_build_object('id', tid, 'kind', p_kind, 'lead_id', p_e.lead_id, 'enrollment_id', p_e.id));
  return tid;
end $$;

-- Enter a node and chain through passive nodes until a wait state / executable node / end.
create or replace function outreach_enter_node(p_enrollment uuid, p_node_id text, p_not_before timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare
  e outreach_enrollments%rowtype; seq outreach_sequences%rowtype; g jsonb; n jsonb; t text; nid text; guard int := 0;
  amount numeric; unit text; jit numeric; iv interval; rel outreach_relation_t; branch text; pool uuid[]; pos int; nxt_sender uuid;
  new_id uuid; target uuid; res record;
begin
  select * into e from outreach_enrollments where id = p_enrollment for update;
  if not found then return; end if;
  if e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then return; end if;
  select * into seq from outreach_sequences where id = e.sequence_id;
  g := seq.graph; nid := p_node_id;

  loop
    guard := guard + 1;
    if guard > 100 then
      perform outreach_complete_enrollment(e.id, 'failed', 'graph_loop');
      return;
    end if;
    n := g->'nodes'->nid;
    if nid is null or n is null then
      perform outreach_complete_enrollment(e.id, 'completed', 'end_of_graph');
      return;
    end if;
    t := n->>'type';
    update outreach_enrollments set current_node_id = nid, node_entered_at = now(), wait_until = null, status = 'active' where id = e.id;

    -- manual override for executable nodes
    if coalesce(n->>'mode','auto') = 'manual' and outreach_is_executable_node(t) then
      perform outreach_create_node_task(e, n, 'manual_node');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;
    end if;

    if t = 'start' then
      nid := n->>'next'; continue;

    elsif t = 'end' then
      perform outreach_complete_enrollment(e.id, 'completed', coalesce(n->'config'->>'reason','end'));
      return;

    elsif t = 'delay' then
      amount := coalesce((n->'config'->>'amount')::numeric, 1); unit := coalesce(n->'config'->>'unit','days');
      jit := coalesce((n->'config'->>'jitter_pct')::numeric, 0);
      iv := case unit when 'minutes' then make_interval(mins => amount::int) when 'hours' then make_interval(hours => amount::int) else make_interval(days => amount::int) end;
      iv := iv * (1 + (random()*2 - 1) * jit / 100.0);
      update outreach_enrollments set status = 'waiting_delay', wait_until = greatest(now() + iv, coalesce(p_not_before, now())) where id = e.id;
      return;

    elsif t = 'condition' then
      branch := case when outreach_eval_condition(n->'config', e.lead_id, e.sender_id) then 'true' else 'false' end;
      nid := coalesce(n->'branches'->>branch, n->>'next'); continue;

    elsif t = 'add_tag' then
      insert into outreach_lead_tags(lead_id, tag_id) select e.lead_id, (n->'config'->>'tag_id')::uuid where (n->'config'->>'tag_id') is not null on conflict do nothing;
      nid := n->>'next'; continue;
    elsif t = 'remove_tag' then
      delete from outreach_lead_tags where lead_id = e.lead_id and tag_id::text = n->'config'->>'tag_id';
      nid := n->>'next'; continue;
    elsif t = 'change_list' then
      update outreach_leads set list_id = (n->'config'->>'list_id')::uuid where id = e.lead_id;
      nid := n->>'next'; continue;
    elsif t = 'change_stage' then
      update outreach_leads set stage_id = (n->'config'->>'stage_id')::uuid where id = e.lead_id;
      nid := n->>'next'; continue;

    elsif t = 'call_webhook' then
      insert into outreach_outbound_webhook_deliveries(webhook_id, workspace_id, event, payload)
      select w.id, e.workspace_id, 'sequence.webhook',
        jsonb_build_object('event','sequence.webhook','workspace_id', e.workspace_id, 'at', now(),
          'data', jsonb_build_object('enrollment_id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'sequence_id', e.sequence_id, 'node_id', nid,
                                     'lead', (select to_jsonb(l) - 'custom' || jsonb_build_object('custom', l.custom) from outreach_leads l where l.id = e.lead_id)))
      from outreach_outbound_webhooks w where w.id::text = n->'config'->>'webhook_id' and w.active;
      nid := n->>'next'; continue;

    elsif t = 'rotate_sender' then
      pool := seq.sender_pool;
      pos := array_position(pool, e.sender_id);
      nxt_sender := null;
      if pos is not null and array_length(pool,1) > 1 and e.rotation_count < coalesce((n->'config'->>'max_rotations')::int, 2) then
        nxt_sender := pool[(pos % array_length(pool,1)) + 1];
      end if;
      if nxt_sender is null or nxt_sender = e.sender_id then nid := n->>'next'; continue; end if;
      insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, rotation_count, priority, created_by)
      values (e.workspace_id, e.sequence_id, seq.head_version, e.lead_id, nxt_sender, 'active', coalesce(n->'config'->>'restart_from', g->>'start'), e.rotation_count + 1, e.priority, e.created_by)
      on conflict do nothing returning id into new_id;
      insert into outreach_lead_sender_state(lead_id, sender_id) values (e.lead_id, nxt_sender) on conflict do nothing;
      perform outreach_complete_enrollment(e.id, 'completed', 'rotated');
      if new_id is not null then perform outreach_enter_node(new_id, coalesce(n->'config'->>'restart_from', g->>'start')); end if;
      return;

    elsif t = 'change_sender' then
      if coalesce(n->'config'->>'sender_id','next_in_pool') = 'next_in_pool' then
        pool := seq.sender_pool; pos := array_position(pool, e.sender_id);
        target := case when pos is null or array_length(pool,1) < 2 then null else pool[(pos % array_length(pool,1)) + 1] end;
      else
        target := (n->'config'->>'sender_id')::uuid;
      end if;
      if target is not null and target <> e.sender_id and not exists (
          select 1 from outreach_enrollments x where x.lead_id = e.lead_id and x.sender_id = target and x.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then
        update outreach_enrollments set sender_id = target where id = e.id;
        insert into outreach_lead_sender_state(lead_id, sender_id) values (e.lead_id, target) on conflict do nothing;
        e.sender_id := target;
      end if;
      nid := n->>'next'; continue;

    elsif t = 'send_to_sequence' then
      perform outreach_complete_enrollment(e.id, 'completed', 'sent_to_sequence');
      if (n->'config'->>'sequence_id') is not null then
        perform outreach_enroll_leads((n->'config'->>'sequence_id')::uuid, array[e.lead_id], null, e.priority);
      end if;
      return;

    elsif t = 'manual_task' then
      perform outreach_create_node_task(e, n, 'manual_node');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;

    elsif t = 'ai_draft_approval' then
      perform outreach_create_node_task(e, n, 'review_ai_draft');
      update outreach_enrollments set status = 'waiting_task' where id = e.id;
      return;

    elsif t = 'wait_connection' then
      select relation into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
      if rel = 'first' then
        nid := n->'branches'->>'connected'; p_not_before := coalesce(p_not_before, now()); continue;
      end if;
      update outreach_enrollments set status = 'waiting_connection', wait_until = now() + make_interval(days => coalesce((n->'config'->>'window_days')::int, 14)) where id = e.id;
      return;

    elsif outreach_is_executable_node(t) then
      if n ? 'delay' and (n->'delay'->>'amount') is not null then
        amount := (n->'delay'->>'amount')::numeric; unit := coalesce(n->'delay'->>'unit','days'); jit := coalesce((n->'delay'->>'jitter_pct')::numeric,0);
        iv := case unit when 'minutes' then make_interval(mins => amount::int) when 'hours' then make_interval(hours => amount::int) else make_interval(days => amount::int) end;
        iv := iv * (1 + (random()*2 - 1) * jit / 100.0);
        update outreach_enrollments set status = 'waiting_delay', wait_until = greatest(now() + iv, coalesce(p_not_before, now())) where id = e.id;
      else
        update outreach_enrollments set status = 'active', wait_until = coalesce(p_not_before, now()) where id = e.id;
      end if;
      return;
    else
      perform outreach_complete_enrollment(e.id, 'failed', 'unknown_node_type');
      return;
    end if;
  end loop;
end $$;

create or replace function outreach_advance_enrollment(p_enrollment uuid, p_from_node text, p_branch text default null, p_not_before timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype; g jsonb; n jsonb; nxt text;
begin
  select * into e from outreach_enrollments where id = p_enrollment;
  if not found or e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then return; end if;
  select graph into g from outreach_sequences where id = e.sequence_id;
  n := g->'nodes'->coalesce(p_from_node, e.current_node_id);
  if n is null then
    perform outreach_complete_enrollment(e.id, 'completed', 'node_missing');
    return;
  end if;
  if p_branch is not null and (n->'branches' ? p_branch) then nxt := n->'branches'->>p_branch;
  else nxt := n->>'next'; end if;
  perform outreach_enter_node(e.id, nxt, p_not_before);
end $$;

-- Periodic releaser: delays due, wait_connection windows expired. Called by the tick.
create or replace function outreach_release_waits() returns int
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare r record; cnt int := 0; g jsonb; n jsonb;
begin
  for r in select e.id, e.current_node_id, e.sequence_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_delay' and e.wait_until <= now() and s.status = 'active'
             and (s.graph->'nodes'->e.current_node_id->>'type') = 'delay'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, null);
    cnt := cnt + 1;
  end loop;
  for r in select e.id, e.current_node_id from outreach_enrollments e
            join outreach_sequences s on s.id = e.sequence_id
           where e.status = 'waiting_connection' and e.wait_until <= now() and s.status = 'active'
           limit 500 loop
    perform outreach_advance_enrollment(r.id, r.current_node_id, 'no_connect');
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;

-- -----------------------------------------------------------------------------
-- Claim / complete / fail (service role only)
-- -----------------------------------------------------------------------------
create or replace function outreach_claim_due_actions(p_limit int default 200)
returns setof outreach_actions
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare r record; d date; ok boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in
    select a.id, a.sender_id, a.action_type, a.status
    from outreach_actions a
    where a.id in (
      select id from (
        select a2.id, row_number() over (partition by a2.sender_id order by a2.scheduled_for) rn
        from outreach_actions a2
        join outreach_senders s on s.id = a2.sender_id
        where a2.status = 'queued' and a2.scheduled_for <= now()
          and s.status = 'ok' and s.deleted_at is null
          and (s.paused_until is null or s.paused_until < now())
          and (a2.action_type in ('reply','call_api') or outreach_in_schedule(s.id, now()))
          and not (a2.action_type = 'invite' and s.invite_blocked_until is not null and s.invite_blocked_until > now())
          and not exists (select 1 from outreach_actions r2 where r2.sender_id = a2.sender_id and r2.status = 'reserved')
      ) x where x.rn = 1 limit p_limit
    )
    for update skip locked
  loop
    if r.status <> 'queued' then continue; end if;
    d := outreach_sender_local_date(r.sender_id, now());
    ok := outreach_reserve_budget(r.sender_id, d, r.action_type);
    if ok then
      update outreach_actions set status = 'reserved', reserved_at = now() where id = r.id;
      return query select * from outreach_actions where id = r.id;
    else
      update outreach_actions set scheduled_for = now() + interval '1 day', decision = 'budget_deferred' where id = r.id;
    end if;
  end loop;
end $$;

create or replace function outreach_complete_action(p_id uuid, p_response jsonb default null, p_branch text default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare a outreach_actions%rowtype; d date;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_id for update;
  if not found or a.status <> 'reserved' then return; end if;
  update outreach_actions set status = 'sent', executed_at = now(), response = p_response where id = p_id;
  d := outreach_sender_local_date(a.sender_id, coalesce(a.reserved_at, now()));
  update outreach_sender_budgets set used = used + 1, reserved = greatest(reserved - 1, 0)
   where sender_id = a.sender_id and day = d and action_type = a.action_type;
  if a.enrollment_id is not null
     and not coalesce((a.payload->>'prefetch')::boolean, false)
     and not coalesce((a.payload->>'subtask')::boolean, false) then
    perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch);
  end if;
end $$;

create or replace function outreach_fail_action(p_id uuid, p_code text, p_decision text, p_retry_at timestamptz default null, p_branch text default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare a outreach_actions%rowtype; d date;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into a from outreach_actions where id = p_id for update;
  if not found or a.status <> 'reserved' then return; end if;
  d := outreach_sender_local_date(a.sender_id, coalesce(a.reserved_at, now()));
  perform outreach_release_budget(a.sender_id, d, a.action_type);

  if p_decision = 'retry' then
    update outreach_actions set status = 'queued', reserved_at = null, scheduled_for = coalesce(p_retry_at, now() + interval '15 minutes'),
      attempt = attempt + 1, error_code = p_code, decision = p_decision where id = p_id;
  elsif p_decision = 'skip_node' then
    update outreach_actions set status = 'skipped', executed_at = now(), error_code = p_code, decision = p_decision where id = p_id;
    if a.enrollment_id is not null and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false) then
      perform outreach_advance_enrollment(a.enrollment_id, a.node_id, null);
    end if;
  elsif p_decision = 'branch' then
    update outreach_actions set status = 'skipped', executed_at = now(), error_code = p_code, decision = p_decision || ':' || coalesce(p_branch,'') where id = p_id;
    if a.enrollment_id is not null and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false) then
      perform outreach_advance_enrollment(a.enrollment_id, a.node_id, p_branch);
    end if;
  elsif p_decision in ('fail_enrollment','mark_lead_invalid') then
    update outreach_actions set status = 'failed', executed_at = now(), error_code = p_code, decision = p_decision where id = p_id;
    if p_decision = 'mark_lead_invalid' and a.lead_id is not null then
      insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (a.lead_id, a.sender_id, 'invalid')
      on conflict (lead_id, sender_id) do update set relation = 'invalid', updated_at = now();
    end if;
    if a.enrollment_id is not null and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false) then
      perform outreach_complete_enrollment(a.enrollment_id, 'failed', coalesce(p_code, p_decision));
    end if;
  elsif p_decision = 'sender_cap_hit' then
    update outreach_actions set status = 'cancelled', error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set invite_blocked_until = coalesce(p_retry_at, now() + interval '7 days') where id = a.sender_id;
    update outreach_actions set status = 'cancelled', decision = 'sender_cap_hit_cascade'
     where sender_id = a.sender_id and action_type = 'invite' and status = 'queued' and scheduled_for < coalesce(p_retry_at, now() + interval '7 days');
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('code', p_code, 'decision', p_decision, 'until', p_retry_at));
  elsif p_decision = 'sender_pause' then
    update outreach_actions set status = 'queued', reserved_at = null, scheduled_for = coalesce(p_retry_at, now() + interval '24 hours'), error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set paused_until = coalesce(p_retry_at, now() + interval '24 hours') where id = a.sender_id;
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('code', p_code, 'decision', p_decision, 'until', p_retry_at));
  elsif p_decision = 'sender_credentials' then
    update outreach_actions set status = 'queued', reserved_at = null, error_code = p_code, decision = p_decision where id = p_id;
    update outreach_senders set status = 'credentials', status_reason = coalesce(p_code,'unauthorized'), last_disconnect_at = now() where id = a.sender_id and status = 'ok';
  elsif p_decision = 'cancel' then
    update outreach_actions set status = 'cancelled', error_code = p_code, decision = p_decision where id = p_id;
  else
    update outreach_actions set status = 'failed', executed_at = now(), error_code = p_code, decision = coalesce(p_decision,'failed') where id = p_id;
  end if;

  if p_decision not in ('skip_node','branch','cancel') then
    insert into outreach_sender_events(sender_id, kind, data) values (a.sender_id, 'reject', jsonb_build_object('action_id', a.id, 'type', a.action_type, 'code', p_code, 'decision', p_decision));
  end if;
end $$;

create or replace function outreach_sweep_stale_reservations() returns int
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare r record; cnt int := 0;
begin
  for r in select id, sender_id, action_type, reserved_at from outreach_actions where status = 'reserved' and reserved_at < now() - interval '10 minutes' loop
    perform outreach_release_budget(r.sender_id, outreach_sender_local_date(r.sender_id, r.reserved_at), r.action_type);
    update outreach_actions set status = 'queued', reserved_at = null, decision = 'stale_reservation' where id = r.id;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;

-- -----------------------------------------------------------------------------
-- Sequences API
-- -----------------------------------------------------------------------------
create or replace function outreach_save_sequence(
  p_id uuid, p_graph jsonb, p_pool uuid[] default null, p_settings jsonb default null,
  p_name text default null, p_assignment text default null, p_use_sender_schedule boolean default null,
  p_client_id uuid default null, p_brief text default null
) returns int language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_sequences%rowtype; v jsonb; newv int;
begin
  select * into s from outreach_sequences where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  v := outreach_validate_graph(p_graph, coalesce(p_pool, s.sender_pool), s.status = 'active');
  if jsonb_array_length(v->'errors') > 0 then
    raise exception 'E_GRAPH_INVALID: %', (v->'errors')::text;
  end if;
  if p_pool is not null and exists (select 1 from unnest(p_pool) pid where not exists (select 1 from outreach_senders x where x.id = pid and x.workspace_id = s.workspace_id)) then
    raise exception 'E_SENDER_NOT_IN_POOL: sender outside workspace';
  end if;
  newv := case when s.graph = p_graph then s.head_version else s.head_version + 1 end;
  update outreach_sequences set
    graph = p_graph, head_version = newv,
    sender_pool = coalesce(p_pool, sender_pool),
    settings = coalesce(p_settings, settings),
    name = coalesce(p_name, name),
    assignment = coalesce(p_assignment, assignment),
    use_sender_schedule = coalesce(p_use_sender_schedule, use_sender_schedule),
    client_id = coalesce(p_client_id, client_id),
    brief = coalesce(p_brief, brief),
    updated_at = now()
  where id = p_id;
  if newv <> s.head_version or not exists (select 1 from outreach_sequence_versions where sequence_id = p_id and version = newv) then
    insert into outreach_sequence_versions(sequence_id, version, graph, created_by) values (p_id, newv, p_graph, auth.uid())
    on conflict (sequence_id, version) do update set graph = excluded.graph;
  end if;
  perform outreach_audit(s.workspace_id, 'sequence.saved', 'sequence', p_id::text, jsonb_build_object('version', newv));
  return newv;
end $$;

create or replace function outreach_create_sequence(p_workspace uuid, p_name text, p_client_id uuid default null)
returns uuid language plpgsql security definer set search_path = public, extensions, extensions as $$
declare sid uuid; g jsonb;
begin
  perform outreach_require(p_workspace, 'manager');
  g := '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","position":{"x":80,"y":200},"next":"end"},"end":{"id":"end","type":"end","position":{"x":520,"y":200},"config":{}}}}';
  insert into outreach_sequences(workspace_id, client_id, name, graph, created_by) values (p_workspace, p_client_id, p_name, g, auth.uid()) returning id into sid;
  insert into outreach_sequence_versions(sequence_id, version, graph, created_by) values (sid, 1, g, auth.uid());
  perform outreach_audit(p_workspace, 'sequence.created', 'sequence', sid::text);
  return sid;
end $$;

create or replace function outreach_restore_sequence_version(p_id uuid, p_version int)
returns int language plpgsql security definer set search_path = public, extensions, extensions as $$
declare g jsonb;
begin
  select graph into g from outreach_sequence_versions where sequence_id = p_id and version = p_version;
  if g is null then raise exception 'E_NOT_FOUND: version'; end if;
  return outreach_save_sequence(p_id, g);
end $$;

-- Handle in-flight enrollments before a node is removed from the graph
create or replace function outreach_delete_node_inflight(p_sequence uuid, p_node_id text, p_mode text)
returns int language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_sequences%rowtype; r record; cnt int := 0;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  for r in select id from outreach_enrollments where sequence_id = p_sequence and current_node_id = p_node_id
             and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    cnt := cnt + 1;
    if p_mode = 'skip' then
      update outreach_actions set status = 'cancelled', decision = 'node_deleted' where enrollment_id = r.id and status in ('queued','reserved');
      update outreach_enrollments set status = 'active' where id = r.id and status = 'paused';
      perform outreach_advance_enrollment(r.id, p_node_id, null);
    else
      perform outreach_complete_enrollment(r.id, 'exited_manual', 'node_deleted');
    end if;
  end loop;
  perform outreach_audit(s.workspace_id, 'sequence.node_deleted', 'sequence', p_sequence::text, jsonb_build_object('node_id', p_node_id, 'mode', p_mode, 'affected', cnt));
  return cnt;
end $$;

create or replace function outreach_set_sequence_status(p_id uuid, p_status outreach_sequence_status_t, p_inflight text default 'pause')
returns jsonb language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_sequences%rowtype; v jsonb; notok int; r record;
begin
  select * into s from outreach_sequences where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');

  if p_status = 'active' then
    if coalesce(array_length(s.sender_pool,1),0) = 0 then raise exception 'E_POOL_EMPTY'; end if;
    select count(*) into notok from outreach_senders where id = any(s.sender_pool) and (status <> 'ok' or deleted_at is not null);
    if notok > 0 then raise exception 'E_SENDER_NOT_OK: % sender(s) in pool are not connected', notok; end if;
    v := outreach_validate_graph(s.graph, s.sender_pool, true);
    if jsonb_array_length(v->'errors') > 0 then raise exception 'E_GRAPH_INVALID: %', (v->'errors')::text; end if;
    if s.status = 'paused' then
      update outreach_enrollments set status = coalesce(paused_from, 'active'), paused_from = null
       where sequence_id = p_id and status = 'paused' and exit_reason is null;
    end if;
    update outreach_sequences set status = 'active', throttled_reason = null, updated_at = now() where id = p_id;
    perform outreach_emit_event(s.workspace_id, 'sequence.activated', jsonb_build_object('id', p_id));
  elsif p_status = 'paused' then
    update outreach_enrollments set paused_from = status, status = 'paused'
     where sequence_id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task');
    update outreach_sequences set status = 'paused', updated_at = now() where id = p_id;
    perform outreach_emit_event(s.workspace_id, 'sequence.paused', jsonb_build_object('id', p_id));
  elsif p_status = 'archived' then
    for r in select id from outreach_enrollments where sequence_id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
      perform outreach_complete_enrollment(r.id, 'exited_manual', 'sequence_archived');
    end loop;
    update outreach_sequences set status = 'archived', archived_at = now(), updated_at = now() where id = p_id;
  elsif p_status = 'draft' then
    if exists (select 1 from outreach_enrollments where sequence_id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then
      raise exception 'E_INFLIGHT: pause or archive first';
    end if;
    update outreach_sequences set status = 'draft', updated_at = now() where id = p_id;
  end if;
  perform outreach_audit(s.workspace_id, 'sequence.status', 'sequence', p_id::text, jsonb_build_object('from', s.status, 'to', p_status));
  return jsonb_build_object('status', p_status, 'warnings', coalesce(v->'warnings','[]'::jsonb));
end $$;

-- Projection: expected duration for N leads on the pool at current levels
create or replace function outreach_project_sequence(p_sequence uuid, p_lead_count int)
returns table(estimated_days int, bottleneck outreach_action_type_t, details jsonb)
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; t outreach_action_type_t; counts jsonb := '{}'; k text; per_lead int;
        cap_sum numeric; days_per_week numeric; need numeric; d numeric; worst numeric := 0; worst_t outreach_action_type_t; wait_days int := 0; sid uuid; wk numeric;
        det jsonb := '{}';
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then return; end if;
  for n in select value from jsonb_each(s.graph->'nodes') loop
    if outreach_is_executable_node(n->>'type') then
      t := outreach_node_action_type(n->>'type');
      counts := jsonb_set(counts, array[t::text], to_jsonb(coalesce((counts->>t::text)::int,0) + 1));
      if (n->>'type') in ('send_invite','send_message') then
        counts := jsonb_set(counts, array['profile_view'], to_jsonb(coalesce((counts->>'profile_view')::int,0) + 1));
      end if;
    elsif (n->>'type') = 'wait_connection' then
      wait_days := greatest(wait_days, coalesce((n->'config'->>'window_days')::int, 14) / 2);
    elsif (n->>'type') = 'delay' and coalesce(n->'config'->>'unit','days') = 'days' then
      wait_days := wait_days + coalesce((n->'config'->>'amount')::int, 0);
    end if;
  end loop;
  for k in select key from jsonb_each(counts) loop
    t := k::outreach_action_type_t;
    per_lead := (counts->>k)::int;
    cap_sum := 0;
    for sid in select unnest(s.sender_pool) loop
      select count(*) into days_per_week from (
        select key from jsonb_each(coalesce((select schedule from outreach_senders where id = sid),'{}'::jsonb)) x where jsonb_array_length(x.value) > 0
      ) q;
      cap_sum := cap_sum + outreach_effective_cap(sid, t) * (days_per_week / 7.0);
      if t = 'invite' then
        select least(cap_sum, (coalesce(per_week,150) / 7.0) * coalesce(array_length(s.sender_pool,1),1)) into wk from outreach_platform_ceilings where action_type = 'invite';
        cap_sum := least(cap_sum, wk);
      end if;
    end loop;
    need := per_lead * p_lead_count;
    d := case when cap_sum <= 0 then 9999 else ceil(need / cap_sum) end;
    det := det || jsonb_build_object(k, jsonb_build_object('total', need, 'per_day', round(cap_sum,1), 'days', d));
    if d > worst then worst := d; worst_t := t; end if;
  end loop;
  estimated_days := least(worst + wait_days, 9999)::int;
  bottleneck := worst_t;
  details := det || jsonb_build_object('wait_days', wait_days, 'pool_size', coalesce(array_length(s.sender_pool,1),0));
  return next;
end $$;

-- -----------------------------------------------------------------------------
-- Enrollment API
-- -----------------------------------------------------------------------------
create or replace function outreach_lead_is_suppressed(p_lead outreach_leads) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select p_lead.do_not_contact or p_lead.unsubscribed or exists (
    select 1 from outreach_suppressions sp where sp.workspace_id = p_lead.workspace_id and (
      (sp.kind = 'public_identifier' and p_lead.public_identifier is not null and sp.value = p_lead.public_identifier) or
      (sp.kind = 'email' and ((p_lead.email_work is not null and sp.value = p_lead.email_work) or (p_lead.email_personal is not null and sp.value = p_lead.email_personal))) or
      (sp.kind = 'domain' and ((p_lead.email_work is not null and lower(split_part(p_lead.email_work::text,'@',2)) = lower(sp.value::text)) or
                               (p_lead.email_personal is not null and lower(split_part(p_lead.email_personal::text,'@',2)) = lower(sp.value::text))))
    ))
$$;

create or replace function outreach_enroll_leads(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null, p_priority int default 100)
returns table(enrolled int, skipped_active int, skipped_suppressed int, skipped_other int)
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_sequences%rowtype; l outreach_leads; pool uuid[]; n int; i int := 0; chosen uuid; tries int; offs int; eid uuid; lid uuid; ok boolean;
begin
  enrolled := 0; skipped_active := 0; skipped_suppressed := 0; skipped_other := 0;
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if exists (select 1 from outreach_leads ld_ where ld_.id = any(p_lead_ids) and not outreach_client_visible(s.workspace_id, ld_.client_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  pool := s.sender_pool;
  if p_sender is not null then
    if not (p_sender = any(pool)) then raise exception 'E_SENDER_NOT_IN_POOL'; end if;
    pool := array[p_sender];
  end if;
  n := coalesce(array_length(pool,1),0);
  if n = 0 then raise exception 'E_POOL_EMPTY'; end if;
  select count(*) into offs from outreach_enrollments where sequence_id = p_sequence;

  foreach lid in array p_lead_ids loop
    eid := null; chosen := null;
    select * into l from outreach_leads where id = lid and workspace_id = s.workspace_id;
    if not found then skipped_other := skipped_other + 1; continue; end if;
    if outreach_lead_is_suppressed(l) then skipped_suppressed := skipped_suppressed + 1; continue; end if;
    ok := false;
    for tries in 0..n-1 loop
      if s.assignment = 'least_loaded' and p_sender is null then
        select x.id into chosen from unnest(pool) x(id)
          left join lateral (select count(*) c from outreach_enrollments e where e.sender_id = x.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task')) q on true
          where not exists (select 1 from outreach_enrollments e2 where e2.lead_id = lid and e2.sender_id = x.id and e2.status in ('active','waiting_connection','waiting_delay','waiting_task','paused'))
          order by q.c asc, x.id limit 1;
        if chosen is null then exit; end if;
      else
        chosen := pool[((offs + i + tries) % n) + 1];
      end if;
      if exists (select 1 from outreach_enrollments e where e.lead_id = lid and e.sender_id = chosen and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then
        chosen := null; continue;
      end if;
      insert into outreach_lead_sender_state(lead_id, sender_id) values (lid, chosen) on conflict do nothing;
      insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, priority, created_by)
      values (s.workspace_id, p_sequence, s.head_version, lid, chosen, 'active', s.graph->>'start', p_priority, auth.uid())
      on conflict do nothing returning id into eid;
      if eid is not null then ok := true; end if;
      exit;
    end loop;
    i := i + 1;
    if ok then
      enrolled := enrolled + 1;
      perform outreach_emit_event(s.workspace_id, 'enrollment.started', jsonb_build_object('id', eid, 'lead_id', lid, 'sender_id', chosen, 'sequence_id', p_sequence));
      perform outreach_enter_node(eid, s.graph->>'start');
    else
      skipped_active := skipped_active + 1;
    end if;
  end loop;
  return next;
end $$;

create or replace function outreach_exit_enrollment(p_id uuid, p_reason text default 'manual')
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  select * into e from outreach_enrollments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'member');
  if not outreach_client_visible(e.workspace_id, (select sq_.client_id from outreach_sequences sq_ where sq_.id = e.sequence_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  perform outreach_complete_enrollment(p_id, 'exited_manual', p_reason);
end $$;

create or replace function outreach_pause_enrollment(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  select * into e from outreach_enrollments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'member');
  if not outreach_client_visible(e.workspace_id, (select sq_.client_id from outreach_sequences sq_ where sq_.id = e.sequence_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  update outreach_enrollments set paused_from = status, status = 'paused' where id = p_id and status in ('active','waiting_connection','waiting_delay','waiting_task');
end $$;

create or replace function outreach_resume_enrollment(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare e outreach_enrollments%rowtype;
begin
  select * into e from outreach_enrollments where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(e.workspace_id, 'member');
  if not outreach_client_visible(e.workspace_id, (select sq_.client_id from outreach_sequences sq_ where sq_.id = e.sequence_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  update outreach_enrollments set status = coalesce(paused_from,'active'), paused_from = null where id = p_id and status = 'paused';
end $$;

-- -----------------------------------------------------------------------------
-- Tasks
-- -----------------------------------------------------------------------------
create or replace function outreach_complete_task(p_id uuid, p_text text default null, p_result jsonb default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare t outreach_tasks%rowtype; e outreach_enrollments%rowtype; g jsonb; n jsonb; atype outreach_action_type_t; payload jsonb;
begin
  select * into t from outreach_tasks where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(t.workspace_id, 'member');
  if not outreach_client_visible(t.workspace_id, t.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if not outreach_client_visible(t.workspace_id, (select sq_.client_id from outreach_enrollments en_ join outreach_sequences sq_ on sq_.id = en_.sequence_id where en_.id = t.enrollment_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if t.completed_at is not null then return; end if;
  update outreach_tasks set completed_at = now(), completed_by = auth.uid(), result = coalesce(p_result, jsonb_build_object('text', p_text)),
    ai_draft = coalesce(p_text, ai_draft) where id = p_id;
  perform outreach_emit_event(t.workspace_id, 'task.completed', jsonb_build_object('id', p_id, 'kind', t.kind));

  if t.enrollment_id is null then return; end if;
  select * into e from outreach_enrollments where id = t.enrollment_id;
  if not found or e.status <> 'waiting_task' then return; end if;
  select graph into g from outreach_sequences where id = e.sequence_id;
  n := g->'nodes'->t.node_id;
  if n is null then perform outreach_advance_enrollment(e.id, t.node_id, null); return; end if;

  if t.kind = 'review_ai_draft' then
    if coalesce(p_result->>'decision','approve') = 'reject' then
      update outreach_enrollments set status = 'active' where id = e.id;
      perform outreach_advance_enrollment(e.id, t.node_id, null);
      return;
    end if;
    atype := case coalesce(t.draft_kind, n->'config'->>'kind') when 'invite_note' then 'invite'::outreach_action_type_t when 'comment' then 'comment' else 'message' end;
    if (n->>'type') = 'ai_draft_approval' then
      payload := jsonb_build_object('text', coalesce(p_text, t.ai_draft), 'approved_task_id', p_id, 'kind', coalesce(t.draft_kind, n->'config'->>'kind'));
    else
      atype := outreach_node_action_type(n->>'type');
      payload := jsonb_build_object('text', coalesce(p_text, t.ai_draft), 'approved_task_id', p_id);
    end if;
    update outreach_enrollments set status = 'active', wait_until = now() where id = e.id;
    perform outreach_queue_action(e.id, t.node_id, atype, now(), payload);
    return;
  end if;

  if t.kind = 'manual_node' then
    if outreach_is_executable_node(n->>'type') then
      atype := outreach_node_action_type(n->>'type');
      payload := coalesce(n->'config','{}'::jsonb) || jsonb_build_object('approved_task_id', p_id) || case when p_text is not null then jsonb_build_object('text', p_text) else '{}'::jsonb end;
      update outreach_enrollments set status = 'active', wait_until = now() where id = e.id;
      perform outreach_queue_action(e.id, t.node_id, atype, now(), payload);
    else
      update outreach_enrollments set status = 'active' where id = e.id;
      perform outreach_advance_enrollment(e.id, t.node_id, null);
    end if;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- Workspace / membership
-- -----------------------------------------------------------------------------
create or replace function outreach_slugify(p text) returns text language sql immutable as $$
  select trim(both '-' from regexp_replace(lower(coalesce(p,'workspace')), '[^a-z0-9]+', '-', 'g'))
$$;

create or replace function outreach_seed_workspace_defaults(p_ws uuid) returns void
language plpgsql security definer set search_path = public, extensions, extensions as $$
begin
  insert into outreach_stages(workspace_id, name, position, color)
  select p_ws, x.n, x.p, x.c from (values
    ('New',0,'#6b7280'),('Contacted',1,'#3b82f6'),('Connected',2,'#8b5cf6'),('Replied',3,'#f59e0b'),
    ('Interested',4,'#10b981'),('Meeting',5,'#06b6d4'),('Won',6,'#22c55e'),('Lost',7,'#ef4444')) x(n,p,c)
  where not exists (select 1 from outreach_stages where workspace_id = p_ws);
end $$;

create or replace function outreach_create_workspace(p_name text)
returns outreach_workspaces language plpgsql security definer set search_path = public, extensions, extensions as $$
declare w outreach_workspaces%rowtype; base text; v_slug text; i int := 0;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN: auth required'; end if;
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
returns outreach_workspaces language plpgsql security definer set search_path = public, extensions, extensions as $$
declare w outreach_workspaces%rowtype;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN: auth required'; end if;
  select ws.* into w from outreach_workspaces ws join outreach_members m on m.workspace_id = ws.id
   where m.user_id = auth.uid() and ws.deleted_at is null
   order by (m.role = 'owner') desc, m.created_at asc limit 1;
  if found then return w; end if;
  return outreach_create_workspace(coalesce(p_name, split_part(coalesce(auth.email(),'My'),'@',1) || '''s workspace'));
end $$;

create or replace function outreach_my_workspaces()
returns table(id uuid, name text, slug text, plan text, role outreach_role_t, client_ids uuid[], can_reply boolean, settings jsonb, trial_ends_at timestamptz, stripe_status text, past_due_since timestamptz)
language sql stable security definer set search_path = public, extensions, extensions as $$
  select ws.id, ws.name, ws.slug, ws.plan, m.role, m.client_ids, m.can_reply, ws.settings, ws.trial_ends_at, ws.stripe_status, ws.past_due_since
  from outreach_workspaces ws join outreach_members m on m.workspace_id = ws.id
  where m.user_id = auth.uid() and ws.deleted_at is null
  order by m.created_at
$$;

create or replace function outreach_accept_invitation(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions, extensions as $$
declare inv outreach_invitations%rowtype;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN: auth required'; end if;
  select * into inv from outreach_invitations where token = p_token for update;
  if not found then raise exception 'E_NOT_FOUND: invitation'; end if;
  if inv.accepted_at is not null then raise exception 'E_INVITE_USED'; end if;
  if inv.expires_at < now() then raise exception 'E_INVITE_EXPIRED'; end if;
  if lower(inv.email::text) <> lower(coalesce(auth.email(),'')) then raise exception 'E_INVITE_EMAIL_MISMATCH'; end if;
  insert into outreach_members(workspace_id, user_id, role, client_ids, email)
  values (inv.workspace_id, auth.uid(), inv.role, inv.client_ids, auth.email())
  on conflict (workspace_id, user_id) do update set role = excluded.role, client_ids = excluded.client_ids;
  update outreach_invitations set accepted_at = now() where id = inv.id;
  perform outreach_audit(inv.workspace_id, 'member.joined', 'member', auth.uid()::text, jsonb_build_object('role', inv.role));
  return inv.workspace_id;
end $$;

create or replace function outreach_invitation_preview(p_token text)
returns table(workspace_name text, email citext, role outreach_role_t, expired boolean, accepted boolean)
language sql stable security definer set search_path = public, extensions, extensions as $$
  select w.name, i.email, i.role, i.expires_at < now(), i.accepted_at is not null
  from outreach_invitations i join outreach_workspaces w on w.id = i.workspace_id where i.token = p_token
$$;

create or replace function outreach_update_member(p_ws uuid, p_user uuid, p_role outreach_role_t, p_client_ids uuid[] default null, p_can_reply boolean default null)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
begin
  perform outreach_require(p_ws, 'owner');
  if p_user = auth.uid() and p_role <> 'owner' then raise exception 'E_FORBIDDEN: cannot demote yourself'; end if;
  update outreach_members set role = p_role, client_ids = coalesce(p_client_ids, client_ids), can_reply = coalesce(p_can_reply, can_reply)
   where workspace_id = p_ws and user_id = p_user;
  perform outreach_audit(p_ws, 'member.updated', 'member', p_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function outreach_remove_member(p_ws uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
begin
  perform outreach_require(p_ws, 'owner');
  if p_user = auth.uid() then raise exception 'E_FORBIDDEN: cannot remove yourself'; end if;
  delete from outreach_members where workspace_id = p_ws and user_id = p_user;
  perform outreach_audit(p_ws, 'member.removed', 'member', p_user::text);
end $$;

create or replace function outreach_workspace_members(p_ws uuid)
returns table(user_id uuid, role outreach_role_t, client_ids uuid[], can_reply boolean, email text, display_name text, created_at timestamptz)
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return query select m.user_id, m.role, m.client_ids, m.can_reply, coalesce(m.email::text, u.email::text), coalesce(m.display_name, u.raw_user_meta_data->>'full_name'), m.created_at
  from outreach_members m left join auth.users u on u.id = m.user_id where m.workspace_id = p_ws order by m.created_at;
end $$;

-- -----------------------------------------------------------------------------
-- Senders API
-- -----------------------------------------------------------------------------
create or replace function outreach_issue_sender_token(p_sender uuid)
returns text language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype; tok text;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  tok := encode(gen_random_bytes(32), 'hex');
  insert into outreach_sender_tokens(sender_id, token_hash) values (p_sender, encode(digest(tok,'sha256'),'hex'))
  on conflict (sender_id) do update set token_hash = excluded.token_hash, issued_at = now(), last_used_at = null;
  update outreach_senders set extension_token_issued_at = now() where id = p_sender;
  perform outreach_audit(s.workspace_id, 'sender.token_issued', 'sender', p_sender::text);
  return tok;
end $$;

create or replace function outreach_verify_sender_token(p_token text)
returns uuid language plpgsql security definer set search_path = public, extensions, extensions as $$
declare sid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_sender_tokens set last_used_at = now() where token_hash = encode(digest(p_token,'sha256'),'hex') returning sender_id into sid;
  return sid;
end $$;

create or replace function outreach_set_sender_schedule(p_sender uuid, p_schedule jsonb, p_timezone text)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype; k text; w jsonb;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'E_PAYLOAD_INVALID: unknown timezone'; end if;
  for k in select key from jsonb_each(p_schedule) loop
    if k not in ('mon','tue','wed','thu','fri','sat','sun') then raise exception 'E_PAYLOAD_INVALID: bad weekday %', k; end if;
    for w in select * from jsonb_array_elements(p_schedule->k) loop
      if jsonb_typeof(w) <> 'array' or jsonb_array_length(w) <> 2 or (w->>0) !~ '^\d\d:\d\d$' or (w->>1) !~ '^\d\d:\d\d$' or (w->>0) >= (w->>1) then
        raise exception 'E_PAYLOAD_INVALID: bad window on %', k;
      end if;
    end loop;
  end loop;
  update outreach_senders set schedule = p_schedule, timezone = p_timezone where id = p_sender;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'schedule', jsonb_build_object('timezone', p_timezone, 'schedule', p_schedule));
  perform outreach_audit(s.workspace_id, 'sender.schedule', 'sender', p_sender::text, jsonb_build_object('timezone', p_timezone));
end $$;

create or replace function outreach_set_manual_caps(p_sender uuid, p_caps jsonb)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype; k text; v int; c int; clean jsonb := '{}';
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  for k in select key from jsonb_each(p_caps) loop
    v := (p_caps->>k)::int;
    select per_day into c from outreach_platform_ceilings where action_type = k::outreach_action_type_t;
    if c is null then raise exception 'E_PAYLOAD_INVALID: unknown action type %', k; end if;
    if v > c then raise exception 'E_CAP_ABOVE_CEILING: % max is %', k, c; end if;
    if v >= 0 then clean := clean || jsonb_build_object(k, v); end if;
  end loop;
  update outreach_senders set manual_caps = clean where id = p_sender;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'caps', clean);
  perform outreach_audit(s.workspace_id, 'sender.caps', 'sender', p_sender::text, clean);
end $$;

create or replace function outreach_pause_sender(p_sender uuid, p_pause boolean)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_pause then
    update outreach_senders set status = 'paused', status_reason = 'user_paused' where id = p_sender and status = 'ok';
    perform outreach_emit_event(s.workspace_id, 'sender.paused', jsonb_build_object('id', p_sender, 'reason', 'user'));
  else
    update outreach_senders set status = 'ok', status_reason = null where id = p_sender and status = 'paused';
  end if;
end $$;

create or replace function outreach_update_sender(p_sender uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  update outreach_senders set
    display_name = coalesce(p_patch->>'display_name', display_name),
    client_id = case when p_patch ? 'client_id' then (p_patch->>'client_id')::uuid else client_id end,
    owner_email = case when p_patch ? 'owner_email' then (p_patch->>'owner_email')::citext else owner_email end
  where id = p_sender;
end $$;

-- Sender snapshot used by the senders table / dashboard
create or replace function outreach_sender_today(p_sender uuid)
returns jsonb language sql stable security definer set search_path = public, extensions, extensions as $$
  select coalesce(jsonb_object_agg(action_type, jsonb_build_object('used', used, 'reserved', reserved, 'cap', cap)), '{}'::jsonb)
  from outreach_sender_budgets where sender_id = p_sender and day = outreach_sender_local_date(p_sender, now())
$$;

-- -----------------------------------------------------------------------------
-- Leads API
-- -----------------------------------------------------------------------------
create or replace function outreach_upsert_lead(p_ws uuid, p_lead jsonb, p_source text default null, p_import_job uuid default null)
returns table(id uuid, created boolean)
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare pid citext; ew citext; ep citext; existing uuid; nid uuid; cid uuid; lid uuid; sid uuid;
begin
  if not outreach_is_service() then perform outreach_require(p_ws, 'member'); end if;
  pid := nullif(lower(trim(coalesce(p_lead->>'public_identifier',''))),'')::citext;
  ew := nullif(lower(trim(coalesce(p_lead->>'email_work',''))),'')::citext;
  ep := nullif(lower(trim(coalesce(p_lead->>'email_personal',''))),'')::citext;
  cid := nullif(p_lead->>'client_id','')::uuid;
  lid := nullif(p_lead->>'list_id','')::uuid;
  sid := nullif(p_lead->>'stage_id','')::uuid;
  if pid is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.public_identifier = pid;
  end if;
  if existing is null and (p_lead->>'provider_id') is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.provider_id = p_lead->>'provider_id';
  end if;
  if existing is null and ew is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_work = ew;
  end if;
  if existing is null and ep is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_personal = ep;
  end if;
  if existing is null and pid is null and ew is null and ep is null and (p_lead->>'provider_id') is null then
    raise exception 'E_PAYLOAD_INVALID: lead needs public_identifier or email';
  end if;

  if existing is not null then
    update outreach_leads l set
      public_identifier = coalesce(l.public_identifier, pid),
      provider_id = coalesce(p_lead->>'provider_id', l.provider_id),
      profile_url = coalesce(p_lead->>'profile_url', l.profile_url),
      first_name = coalesce(nullif(p_lead->>'first_name',''), l.first_name),
      last_name = coalesce(nullif(p_lead->>'last_name',''), l.last_name),
      full_name = coalesce(nullif(p_lead->>'full_name',''), l.full_name),
      headline = coalesce(nullif(p_lead->>'headline',''), l.headline),
      company = coalesce(nullif(p_lead->>'company',''), l.company),
      company_id = coalesce(nullif(p_lead->>'company_id',''), l.company_id),
      title = coalesce(nullif(p_lead->>'title',''), l.title),
      location = coalesce(nullif(p_lead->>'location',''), l.location),
      picture_url = coalesce(nullif(p_lead->>'picture_url',''), l.picture_url),
      email_work = coalesce(l.email_work, ew),
      email_personal = coalesce(l.email_personal, ep),
      is_open_profile = coalesce((p_lead->>'is_open_profile')::boolean, l.is_open_profile),
      custom = l.custom || coalesce(p_lead->'custom','{}'::jsonb),
      list_id = coalesce(lid, l.list_id),
      stage_id = coalesce(sid, l.stage_id),
      client_id = coalesce(l.client_id, cid),
      last_profile_fetch_at = case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else l.last_profile_fetch_at end,
      updated_at = now()
    where l.id = existing;
    id := existing; created := false; return next; return;
  end if;

  insert into outreach_leads(workspace_id, client_id, public_identifier, provider_id, profile_url, first_name, last_name, full_name, headline, company, company_id, title, location, picture_url,
    email_work, email_personal, is_open_profile, custom, list_id, stage_id, source, import_job_id, last_profile_fetch_at)
  values (p_ws, cid, pid, p_lead->>'provider_id', p_lead->>'profile_url', nullif(p_lead->>'first_name',''), nullif(p_lead->>'last_name',''),
    coalesce(nullif(p_lead->>'full_name',''), nullif(trim(coalesce(p_lead->>'first_name','') || ' ' || coalesce(p_lead->>'last_name','')),'')),
    nullif(p_lead->>'headline',''), nullif(p_lead->>'company',''), nullif(p_lead->>'company_id',''), nullif(p_lead->>'title',''), nullif(p_lead->>'location',''), nullif(p_lead->>'picture_url',''),
    ew, ep, (p_lead->>'is_open_profile')::boolean, coalesce(p_lead->'custom','{}'::jsonb), lid, sid, p_source, p_import_job,
    case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else null end)
  returning outreach_leads.id into nid;
  if nid is null then
    -- lost a race on the unique index; re-resolve
    select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
    id := nid; created := false; return next; return;
  end if;
  perform outreach_emit_event(p_ws, 'lead.created', jsonb_build_object('id', nid, 'public_identifier', pid, 'source', p_source));
  id := nid; created := true; return next;
exception when unique_violation then
  select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
  id := nid; created := false; return next;
end $$;

create or replace function outreach_bulk_leads(p_ws uuid, p_lead_ids uuid[], p_op text, p_value text default null)
returns int language plpgsql security definer set search_path = public, extensions, extensions as $$
declare cnt int := 0;
begin
  perform outreach_require(p_ws, 'member');
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  if p_op = 'add_tag' then
    insert into outreach_lead_tags(lead_id, tag_id) select l.id, p_value::uuid from outreach_leads l where l.workspace_id = p_ws and l.id = any(p_lead_ids) on conflict do nothing;
    get diagnostics cnt = row_count;
  elsif p_op = 'remove_tag' then
    delete from outreach_lead_tags lt using outreach_leads l where lt.lead_id = l.id and l.workspace_id = p_ws and l.id = any(p_lead_ids) and lt.tag_id = p_value::uuid;
    get diagnostics cnt = row_count;
  elsif p_op = 'set_list' then
    update outreach_leads set list_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_stage' then
    update outreach_leads set stage_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_client' then
    update outreach_leads set client_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_dnc' then
    update outreach_leads set do_not_contact = true where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  elsif p_op = 'clear_dnc' then
    update outreach_leads set do_not_contact = false where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  elsif p_op = 'delete' then
    delete from outreach_leads where workspace_id = p_ws and id = any(p_lead_ids);
    get diagnostics cnt = row_count;
  else
    raise exception 'E_PAYLOAD_INVALID: unknown op %', p_op;
  end if;
  perform outreach_audit(p_ws, 'leads.bulk', 'lead', null, jsonb_build_object('op', p_op, 'value', p_value, 'count', cnt));
  return cnt;
end $$;

-- -----------------------------------------------------------------------------
-- Planner helpers (service role)
-- -----------------------------------------------------------------------------
-- Demand for a sender: enrollments that need an action created (up to p_until)
create or replace function outreach_planner_demand(p_sender uuid, p_until timestamptz)
returns table(enrollment_id uuid, lead_id uuid, sequence_id uuid, node_id text, node jsonb, action_type outreach_action_type_t,
              earliest timestamptz, priority int, created_at timestamptz, needs_profile boolean, subtask boolean, settings jsonb)
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare r record; n jsonb; subs jsonb; k int; last_sub timestamptz; st jsonb;
begin
  for r in
    select e.id, e.lead_id, e.sequence_id, e.current_node_id, e.status, e.wait_until, e.node_entered_at, e.priority, e.created_at,
           s.graph, s.settings, l.provider_id, l.last_profile_fetch_at
    from outreach_enrollments e
    join outreach_sequences s on s.id = e.sequence_id and s.status = 'active'
    join outreach_leads l on l.id = e.lead_id
    where e.sender_id = p_sender
      and e.status in ('active','waiting_delay','waiting_connection')
      and coalesce(e.wait_until, e.node_entered_at) <= p_until
      and not l.do_not_contact
    order by e.priority, e.created_at
  loop
    n := r.graph->'nodes'->r.current_node_id;
    if n is null then continue; end if;
    if r.status = 'waiting_connection' then
      subs := n->'config'->'subtasks';
      if subs is null or jsonb_typeof(subs) <> 'array' or jsonb_array_length(subs) = 0 then continue; end if;
      select count(*), max(a.created_at) into k, last_sub from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and coalesce((a.payload->>'subtask')::boolean,false);
      if k >= jsonb_array_length(subs) then continue; end if;
      if last_sub is not null and last_sub > now() - interval '2 days' then continue; end if;
      st := subs->k;
      if (st->>'type') not in ('visit_profile','like_latest_post') then continue; end if;
      enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id;
      node := st || jsonb_build_object('id', r.current_node_id, 'subtask_index', k);
      action_type := outreach_node_action_type(st->>'type');
      earliest := greatest(coalesce(last_sub, r.node_entered_at) + interval '2 days', now());
      priority := r.priority; created_at := r.created_at; needs_profile := false; subtask := true; settings := r.settings;
      return next;
      continue;
    end if;
    if (n->>'type') = 'delay' or not outreach_is_executable_node(n->>'type') then continue; end if;
    if exists (select 1 from outreach_actions a where a.enrollment_id = r.id and a.node_id = r.current_node_id and a.status in ('queued','reserved')
               and not coalesce((a.payload->>'prefetch')::boolean,false)) then continue; end if;
    enrollment_id := r.id; lead_id := r.lead_id; sequence_id := r.sequence_id; node_id := r.current_node_id; node := n;
    action_type := outreach_node_action_type(n->>'type');
    earliest := coalesce(r.wait_until, r.node_entered_at);
    priority := r.priority; created_at := r.created_at; subtask := false; settings := r.settings;
    needs_profile := (n->>'type') in ('send_invite','send_message','send_inmail','comment_latest_post','like_latest_post','endorse_skills')
                     and (r.provider_id is null or r.last_profile_fetch_at is null or r.last_profile_fetch_at < now() - interval '7 days');
    return next;
  end loop;
end $$;

create or replace function outreach_health_inputs(p_sender uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare s outreach_senders%rowtype; res jsonb; daily int[]; d date; i int; idle_before int := 0; today_actions int;
begin
  select * into s from outreach_senders where id = p_sender;
  d := outreach_sender_local_date(p_sender, now());
  daily := '{}';
  for i in reverse 14..1 loop
    daily := daily || coalesce((select count(*)::int from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type not in ('reply','relations_poll')
                                  and outreach_sender_local_date(p_sender, a.executed_at) = d - i), 0);
  end loop;
  select count(*)::int into today_actions from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type not in ('reply','relations_poll') and outreach_sender_local_date(p_sender, a.executed_at) = d;
  for i in reverse 14..1 loop
    if daily[i] = 0 then idle_before := idle_before + 1; else exit; end if;
  end loop;
  res := jsonb_build_object(
    'currently_ok', s.status = 'ok',
    'disconnects_14d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'status' and e.data->>'to' in ('credentials','error') and e.at > now() - interval '14 days'),
    'checkpoints_30d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'checkpoint' and e.at > now() - interval '30 days'),
    'rejects_14d', (select count(*) from outreach_sender_events e where e.sender_id = p_sender and e.kind = 'reject' and e.at > now() - interval '14 days'),
    'actions_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status in ('sent','failed') and a.action_type not in ('reply','relations_poll') and a.executed_at > now() - interval '14 days'),
    'invites_14d', (select count(*) from outreach_lead_sender_state x where x.sender_id = p_sender and x.invite_sent_at > now() - interval '14 days'),
    'accepted_14d', (select count(*) from outreach_lead_sender_state x where x.sender_id = p_sender and x.invite_sent_at > now() - interval '14 days' and x.invite_accepted_at is not null),
    'messages_14d', (select count(*) from outreach_actions a where a.sender_id = p_sender and a.status = 'sent' and a.action_type in ('message','inmail') and a.executed_at > now() - interval '14 days'),
    'replies_14d', (select count(distinct x.lead_id) from outreach_lead_sender_state x where x.sender_id = p_sender and x.last_inbound_at > now() - interval '14 days' and x.last_outbound_at is not null),
    'daily_actions_14d', to_jsonb(daily),
    'today_actions', today_actions,
    'idle_days_before_today', idle_before,
    'health_score', s.health_score,
    'health_high_since', s.health_high_since,
    'warmup_level', s.warmup_level,
    'warmup_locked_until', s.warmup_locked_until,
    'is_premium', s.is_premium
  );
  return res;
end $$;

-- -----------------------------------------------------------------------------
-- Dashboard
-- -----------------------------------------------------------------------------
create or replace function outreach_dashboard(p_ws uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare res jsonb;
begin
  perform outreach_require(p_ws, 'client_viewer');
  select jsonb_build_object(
    'senders', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'display_name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason', s.status_reason,
                 'health_score', s.health_score, 'warmup_level', s.warmup_level, 'client_id', s.client_id, 'paused_until', s.paused_until, 'today', outreach_sender_today(s.id)) order by s.display_name)
               from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null and outreach_client_visible(p_ws, s.client_id)), '[]'::jsonb),
    'attention', coalesce((select jsonb_agg(x) from (
        select 'sender' as kind, s.id::text as id, s.display_name as label, s.status::text as reason from outreach_senders s
          where s.workspace_id = p_ws and s.deleted_at is null and s.status in ('credentials','error') and outreach_client_visible(p_ws, s.client_id)
        union all
        select 'sender', s.id::text, s.display_name, 'paused until ' || to_char(s.paused_until, 'Mon DD HH24:MI') from outreach_senders s
          where s.workspace_id = p_ws and s.deleted_at is null and s.paused_until > now() and outreach_client_visible(p_ws, s.client_id)
        union all
        select 'sender', s.id::text, s.display_name, 'invites blocked until ' || to_char(s.invite_blocked_until, 'Mon DD') from outreach_senders s
          where s.workspace_id = p_ws and s.deleted_at is null and s.invite_blocked_until > now() and outreach_client_visible(p_ws, s.client_id)
        union all
        select 'sequence', q.id::text, q.name, q.throttled_reason from outreach_sequences q
          where q.workspace_id = p_ws and q.status = 'active' and q.throttled_reason is not null and outreach_client_visible(p_ws, q.client_id)
      ) x), '[]'::jsonb),
    'replies_awaiting', (select count(*) from outreach_chats c where c.workspace_id = p_ws and c.unread and c.intent in ('interested','question') and not c.archived and outreach_client_visible(p_ws, c.client_id)),
    'unread', (select count(*) from outreach_chats c where c.workspace_id = p_ws and c.unread and not c.archived and outreach_client_visible(p_ws, c.client_id)),
    'tasks_open', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and outreach_client_visible(p_ws, t.client_id)),
    'drafts_awaiting', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and t.kind = 'review_ai_draft' and outreach_client_visible(p_ws, t.client_id)),
    'enrollments_live', (select count(*) from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id where e.workspace_id = p_ws and e.status in ('active','waiting_connection','waiting_delay','waiting_task') and outreach_client_visible(p_ws, q.client_id)),
    'sent_today', (select count(*) from outreach_actions a where a.workspace_id = p_ws and a.status = 'sent' and a.executed_at > now() - interval '24 hours' and a.action_type not in ('relations_poll')),
    'queued_today', (select count(*) from outreach_actions a where a.workspace_id = p_ws and a.status = 'queued' and a.scheduled_for < now() + interval '24 hours'),
    'leads_total', (select count(*) from outreach_leads l where l.workspace_id = p_ws and outreach_client_visible(p_ws, l.client_id)),
    'stats_7d', (select jsonb_build_object(
        'invites', count(*) filter (where action_type = 'invite'),
        'messages', count(*) filter (where action_type in ('message','inmail','email')),
        'accepted', (select count(*) from outreach_lead_sender_state x join outreach_senders s on s.id = x.sender_id where s.workspace_id = p_ws and x.invite_accepted_at > now() - interval '7 days'),
        'replies', (select count(*) from outreach_messages m where m.workspace_id = p_ws and m.direction = 'in' and m.sent_at > now() - interval '7 days'))
      from outreach_actions a where a.workspace_id = p_ws and a.status = 'sent' and a.executed_at > now() - interval '7 days')
  ) into res;
  return res;
end $$;

-- -----------------------------------------------------------------------------
-- Ops: cron invoker (pg_net → edge function with x-cron-secret from Vault)
-- -----------------------------------------------------------------------------
create or replace function outreach_invoke(p_name text, p_body jsonb default '{}')
returns bigint language plpgsql security definer set search_path = public, extensions, extensions as $$
declare base text; secret text; rid bigint;
begin
  select value #>> '{}' into base from outreach_flags where key = 'functions_base_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'outreach_cron_secret' limit 1;
  if base is null or secret is null then raise exception 'outreach_invoke: functions_base_url flag or outreach_cron_secret vault secret missing'; end if;
  select net.http_post(
    url := base || p_name,
    headers := jsonb_build_object('Content-Type','application/json','x-cron-secret', secret),
    body := p_body,
    timeout_milliseconds := 60000
  ) into rid;
  return rid;
end $$;

-- Grants: users may call the public API functions; internal ones are service-only
do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_reserve_budget(uuid,date,outreach_action_type_t)','outreach_release_budget(uuid,date,outreach_action_type_t)',
    'outreach_claim_due_actions(int)','outreach_complete_action(uuid,jsonb,text)','outreach_fail_action(uuid,text,text,timestamptz,text)',
    'outreach_sweep_stale_reservations()','outreach_release_waits()','outreach_planner_demand(uuid,timestamptz)','outreach_plan_budgets(uuid,date)',
    'outreach_health_inputs(uuid)','outreach_verify_sender_token(text)','outreach_invoke(text,jsonb)','outreach_enter_node(uuid,text,timestamptz)',
    'outreach_advance_enrollment(uuid,text,text,timestamptz)','outreach_complete_enrollment(uuid,outreach_enrollment_status_t,text)',
    'outreach_emit_event(uuid,text,jsonb)','outreach_rate_limit(text,int,int)','outreach_seed_workspace_defaults(uuid)'
  ]) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $$;
