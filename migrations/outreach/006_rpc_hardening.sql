-- =============================================================================
-- Outreach Platform — 006 membership checks on read RPCs that lacked them
-- =============================================================================

create or replace function outreach_sender_today(p_sender uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid; res jsonb;
begin
  select workspace_id into ws from outreach_senders where id = p_sender;
  if ws is null then return '{}'::jsonb; end if;
  if not outreach_is_service() then perform outreach_require(ws, 'client_viewer'); end if;
  select coalesce(jsonb_object_agg(action_type, jsonb_build_object('used', used, 'reserved', reserved, 'cap', cap)), '{}'::jsonb)
    into res from outreach_sender_budgets where sender_id = p_sender and day = outreach_sender_local_date(p_sender, now());
  return res;
end $$;

create or replace function outreach_project_sequence(p_sequence uuid, p_lead_count int)
returns table(estimated_days int, bottleneck outreach_action_type_t, details jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; t outreach_action_type_t; counts jsonb := '{}'; k text; per_lead int;
        cap_sum numeric; days_per_week numeric; need numeric; d numeric; worst numeric := 0; worst_t outreach_action_type_t; wait_days int := 0; sid uuid; wk numeric;
        det jsonb := '{}';
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then return; end if;
  if not outreach_is_service() then perform outreach_require(s.workspace_id, 'client_viewer'); end if;
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

-- effective_cap is called from the UI for projections; restrict to members of the sender's workspace
create or replace function outreach_effective_cap_checked(p_sender uuid, p_type outreach_action_type_t) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_senders where id = p_sender;
  if ws is null then return 0; end if;
  perform outreach_require(ws, 'client_viewer');
  return outreach_effective_cap(p_sender, p_type);
end $$;
