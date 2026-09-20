-- =============================================================================
-- Outreach Platform — 012 safe live editing, recovery, enrolment
--   item 5  draft / publish with auto-save          item 6  publish impact + version pinning
--   item 7  queued text / timing edits (non-agent names, same manager check)
--   item 8  recover failed leads (retry / skip / exit — deliberately no "restart from top")
--   item 9  rebalance leads when the pool changes
--   item 17 blacklists per client / sequence, incl. companies (non-destructive)
--   item 1  enrol guard (replied in the last 90 days)   item 19 history-aware assignment
--   item 18 auto-enrol rules
-- One plan function feeds both the preview and the commit, so they cannot disagree.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Item 5 — drafts. Nothing in the engine reads draft_graph.
-- -----------------------------------------------------------------------------
create or replace function outreach_save_draft(p_id uuid, p_graph jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype;
begin
  select * into s from outreach_sequences where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_graph is null or jsonb_typeof(p_graph) <> 'object' or jsonb_typeof(p_graph->'nodes') <> 'object' then
    raise exception 'E_GRAPH_INVALID: graph.nodes missing';
  end if;
  if octet_length(p_graph::text) > 2000000 then raise exception 'E_PAYLOAD_INVALID: graph too large'; end if;
  update outreach_sequences set draft_graph = p_graph, draft_updated_at = now(), draft_updated_by = auth.uid(),
         draft_base_version = case when draft_graph is null then head_version else coalesce(draft_base_version, head_version) end
   where id = p_id returning * into s;
  return jsonb_build_object('saved_at', s.draft_updated_at, 'base_version', s.draft_base_version, 'head_version', s.head_version,
                            'stale', s.draft_base_version <> s.head_version, 'unpublished_changes', outreach_graph_change_count(s.graph, p_graph));
end $$;

create or replace function outreach_discard_draft(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  update outreach_sequences set draft_graph = null, draft_updated_at = null, draft_updated_by = null, draft_base_version = null where id = p_id;
  perform outreach_audit(ws, 'sequence.draft_discarded', 'sequence', p_id::text);
end $$;

-- supersedes 002: saving clears the server draft
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
    -- what was saved IS the draft now: a plain Save (never-activated sequence) and a Publish both end with no open draft
    draft_graph = null, draft_updated_at = null, draft_updated_by = null, draft_base_version = null,
    updated_at = now()
  where id = p_id;
  if newv <> s.head_version or not exists (select 1 from outreach_sequence_versions where sequence_id = p_id and version = newv) then
    insert into outreach_sequence_versions(sequence_id, version, graph, created_by) values (p_id, newv, p_graph, auth.uid())
    on conflict (sequence_id, version) do update set graph = excluded.graph;
  end if;
  perform outreach_audit(s.workspace_id, 'sequence.saved', 'sequence', p_id::text, jsonb_build_object('version', newv));
  return newv;
end $$;

-- Node-level diff between two graphs. Position-only moves are not changes.
create or replace function outreach_graph_diff(p_old jsonb, p_new jsonb)
returns table(node_id text, change text, text_changed boolean, delay_changed boolean, node_type text)
language plpgsql immutable as $$
declare k text; o jsonb; n jsonb;
begin
  for k in select key from jsonb_each(coalesce(p_old->'nodes','{}'::jsonb)) union select key from jsonb_each(coalesce(p_new->'nodes','{}'::jsonb)) loop
    o := p_old->'nodes'->k; n := p_new->'nodes'->k;
    if o is null then
      node_id := k; change := 'added'; text_changed := false; delay_changed := false; node_type := n->>'type'; return next;
    elsif n is null then
      node_id := k; change := 'removed'; text_changed := false; delay_changed := false; node_type := o->>'type'; return next;
    elsif (o - 'position' - 'label') is distinct from (n - 'position' - 'label') then
      node_id := k; change := 'changed'; node_type := n->>'type';
      text_changed := (coalesce(o->'config','{}'::jsonb) - 'ai') is distinct from (coalesce(n->'config','{}'::jsonb) - 'ai')
                      and ( (o->'config'->>'text') is distinct from (n->'config'->>'text') or (o->'config'->>'note') is distinct from (n->'config'->>'note')
                         or (o->'config'->>'subject') is distinct from (n->'config'->>'subject') or (o->'config'->>'html') is distinct from (n->'config'->>'html')
                         or (o->'config'->'variants') is distinct from (n->'config'->'variants') );
      delay_changed := ((o->>'type') = 'delay' and (o->'config') is distinct from (n->'config')) or (o->'delay') is distinct from (n->'delay');
      return next;
    end if;
  end loop;
end $$;

create or replace function outreach_graph_change_count(p_old jsonb, p_new jsonb) returns int
language sql immutable as $$ select count(*)::int from outreach_graph_diff(p_old, p_new) $$;

-- -----------------------------------------------------------------------------
-- Item 6 — what a publish would touch, before anything changes
-- -----------------------------------------------------------------------------
create or replace function outreach_publish_impact(p_id uuid, p_graph jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; g jsonb; changed text[]; removed text[]; texty text[]; delays text[]; v jsonb;
        in_flight int; on_changed int; past_changed int; queued_old int; waiting_delay int; pinned int; per_node jsonb;
begin
  select * into s from outreach_sequences where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  g := coalesce(p_graph, s.draft_graph, s.graph);
  select coalesce(array_agg(d.node_id) filter (where d.change in ('changed','removed')), '{}'),
         coalesce(array_agg(d.node_id) filter (where d.change = 'removed'), '{}'),
         coalesce(array_agg(d.node_id) filter (where d.text_changed), '{}'),
         coalesce(array_agg(d.node_id) filter (where d.delay_changed), '{}')
    into changed, removed, texty, delays from outreach_graph_diff(s.graph, g) d;

  select count(*), count(*) filter (where e.current_node_id = any(changed)), count(*) filter (where e.pinned_version is not null)
    into in_flight, on_changed, pinned
    from outreach_enrollments e where e.sequence_id = p_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
  select count(distinct e.id) into past_changed
    from outreach_enrollments e join outreach_actions a on a.enrollment_id = e.id
   where e.sequence_id = p_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
     and e.pinned_version is null and not (e.current_node_id = any(changed))
     and a.node_id = any(changed) and a.status in ('sent','skipped') and not coalesce((a.payload->>'prefetch')::boolean,false);
  select count(*) into queued_old from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
   where e.sequence_id = p_id and e.pinned_version is null and a.status = 'queued' and a.node_id = any(texty) and not coalesce((a.payload->>'prefetch')::boolean,false);
  select count(*) into waiting_delay from outreach_enrollments e
   where e.sequence_id = p_id and e.pinned_version is null and e.status = 'waiting_delay' and e.current_node_id = any(delays);
  select coalesce(jsonb_agg(jsonb_build_object('node_id', d.node_id, 'change', d.change, 'type', d.node_type, 'text_changed', d.text_changed, 'delay_changed', d.delay_changed,
           'leads_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_id and e.pinned_version is null and e.current_node_id = d.node_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
           'queued', (select count(*) from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id where e.sequence_id = p_id and e.pinned_version is null and a.node_id = d.node_id and a.status = 'queued' and not coalesce((a.payload->>'prefetch')::boolean,false)))), '[]'::jsonb)
    into per_node from outreach_graph_diff(s.graph, g) d;
  v := outreach_validate_graph(g, s.sender_pool, s.status = 'active');
  return jsonb_build_object(
    'head_version', s.head_version, 'draft_base_version', s.draft_base_version, 'stale', s.draft_base_version is not null and s.draft_base_version <> s.head_version,
    'changes', coalesce(array_length(changed,1),0) + (select count(*) from outreach_graph_diff(s.graph, g) d where d.change = 'added'),
    'in_flight', in_flight, 'already_pinned', pinned, 'on_changed_step', on_changed, 'past_changed_step', past_changed,
    'on_or_after_changed', on_changed + past_changed, 'before_changed_step', greatest(in_flight - pinned - on_changed - past_changed, 0),
    'queued_with_old_text', queued_old, 'waiting_on_changed_delay', waiting_delay,
    'removed_nodes', to_jsonb(removed), 'nodes', per_node, 'validation', v);
end $$;

-- Publish = validate → (optionally pin in-flight leads) → handle removed steps → new version → draft cleared.
drop function if exists outreach_publish_sequence(uuid,jsonb,text,text,boolean,boolean,boolean,text,uuid[],jsonb,text,text,text);
create or replace function outreach_publish_sequence(
  p_id uuid, p_graph jsonb default null, p_mode text default 'all', p_note text default null, p_force boolean default false,
  p_update_queued boolean default false, p_reschedule_delays boolean default false, p_removed_mode text default 'skip',
  p_pool uuid[] default null, p_settings jsonb default null, p_name text default null, p_assignment text default null, p_brief text default null,
  p_use_sender_schedule boolean default null, p_client_id uuid default null
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; g jsonb; newv int; pinned_n int := 0; upd int := 0; resched int := 0; removed_n int := 0; d record; r record; x record;
begin
  select * into s from outreach_sequences where id = p_id for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_mode not in ('all','new_only') then raise exception 'E_PAYLOAD_INVALID: mode must be all or new_only'; end if;
  if p_removed_mode not in ('skip','exit') then raise exception 'E_PAYLOAD_INVALID: removed_mode must be skip or exit'; end if;
  g := coalesce(p_graph, s.draft_graph);
  if g is null then raise exception 'E_PAYLOAD_INVALID: nothing to publish'; end if;
  -- two people editing: the live version moved on since this draft started
  if not p_force and s.draft_base_version is not null and s.draft_base_version <> s.head_version then
    raise exception 'E_DRAFT_STALE: version % was published while you were editing (your draft started from version %)', s.head_version, s.draft_base_version;
  end if;

  -- make sure the version the in-flight leads are on exists as a row before anything moves
  insert into outreach_sequence_versions(sequence_id, version, graph, created_by) values (p_id, s.head_version, s.graph, auth.uid())
  on conflict (sequence_id, version) do nothing;

  if p_mode = 'new_only' then
    update outreach_enrollments set pinned_version = s.head_version
     where sequence_id = p_id and pinned_version is null and status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
    get diagnostics pinned_n = row_count;
  else
    -- leads sitting on a step that no longer exists: skip past it (old graph knows where "next" is) or exit them
    for d in select node_id from outreach_graph_diff(s.graph, g) where change = 'removed' loop
      for r in select id from outreach_enrollments where sequence_id = p_id and pinned_version is null and current_node_id = d.node_id
                 and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
        removed_n := removed_n + 1;
        if p_removed_mode = 'skip' then
          update outreach_actions set status = 'cancelled', decision = 'node_deleted' where enrollment_id = r.id and status in ('queued','reserved');
          update outreach_enrollments set status = coalesce(paused_from,'active'), paused_from = null where id = r.id and status = 'paused' and held_at is null;
          perform outreach_advance_enrollment(r.id, d.node_id, null);   -- still reads the OLD live graph: s.graph is replaced below
        else
          perform outreach_complete_enrollment(r.id, 'exited_manual', 'node_deleted');
        end if;
      end loop;
    end loop;
  end if;

  newv := outreach_save_sequence(p_id, g, p_pool, p_settings, p_name, p_assignment, p_use_sender_schedule, p_client_id, p_brief);
  update outreach_sequence_versions set note = p_note, publish_mode = p_mode where sequence_id = p_id and version = newv;

  if p_mode = 'all' then
    if p_update_queued then
      for x in select node_id from outreach_graph_diff(s.graph, g) where text_changed loop
        upd := upd + outreach_refresh_queued_text(p_id, x.node_id);
      end loop;
    end if;
    if p_reschedule_delays then
      for x in select node_id from outreach_graph_diff(s.graph, g) where delay_changed and node_type = 'delay' loop
        select rescheduled into r from outreach_reschedule_delay(p_id, x.node_id);
        resched := resched + coalesce(r.rescheduled, 0);
      end loop;
    end if;
  end if;

  update outreach_sequences set draft_graph = null, draft_updated_at = null, draft_updated_by = null, draft_base_version = null where id = p_id;
  perform outreach_audit(s.workspace_id, 'sequence.published', 'sequence', p_id::text,
    jsonb_build_object('version', newv, 'mode', p_mode, 'pinned', pinned_n, 'queued_updated', upd, 'rescheduled', resched, 'removed_step_leads', removed_n, 'note', p_note));
  perform outreach_emit_event(s.workspace_id, 'sequence.published', jsonb_build_object('id', p_id, 'version', newv, 'mode', p_mode, 'pinned', pinned_n));
  return jsonb_build_object('version', newv, 'mode', p_mode, 'pinned', pinned_n, 'queued_updated', upd, 'rescheduled', resched, 'removed_step_leads', removed_n);
end $$;

-- Versions page: who still runs on which version, and a way to bring them forward
create or replace function outreach_version_usage(p_sequence uuid)
returns table(version int, created_at timestamptz, note text, publish_mode text, is_head boolean, live_leads int)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  return query
    select v.version, v.created_at, v.note, v.publish_mode, v.version = s.head_version,
      (select count(*)::int from outreach_enrollments e where e.sequence_id = p_sequence and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
         and coalesce(e.pinned_version, s.head_version) = v.version)
    from outreach_sequence_versions v where v.sequence_id = p_sequence order by v.version desc;
end $$;

create or replace function outreach_move_to_latest(p_sequence uuid, p_version int)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; moved int := 0; kept int := 0; r record;
begin
  select * into s from outreach_sequences where id = p_sequence for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  for r in select id, current_node_id from outreach_enrollments where sequence_id = p_sequence and pinned_version = p_version
             and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    if s.graph->'nodes' ? coalesce(r.current_node_id,'') then
      update outreach_enrollments set pinned_version = null where id = r.id;
      -- queued copy was rendered from the old version: let it re-render from the latest
      update outreach_actions set payload = payload - 'text' - 'note' - 'subject' - 'html' - 'variant_id', variant_id = null where enrollment_id = r.id and status = 'queued' and not coalesce((payload->>'prefetch')::boolean,false) and not (payload ? 'approved_task_id');
      moved := moved + 1;
    else
      kept := kept + 1;   -- their current step does not exist in the latest version; they finish on the old one
    end if;
  end loop;
  perform outreach_audit(s.workspace_id, 'sequence.moved_to_latest', 'sequence', p_sequence::text, jsonb_build_object('from_version', p_version, 'moved', moved, 'kept', kept));
  return jsonb_build_object('moved', moved, 'kept_on_old_version', kept);
end $$;

-- -----------------------------------------------------------------------------
-- Item 7 — queued text and timing, under non-agent names (008's agent_* stay as thin aliases)
-- -----------------------------------------------------------------------------
create or replace function outreach_node_queued_actions(p_sequence uuid, p_node_id text)
returns table(action_id uuid, lead_id uuid, lead_name text, sender_id uuid, payload jsonb, scheduled_for timestamptz, variant_id text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  return query
    select a.id, a.lead_id, l.full_name, a.sender_id, a.payload, a.scheduled_for, a.variant_id
      from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id left join outreach_leads l on l.id = a.lead_id
     where e.sequence_id = p_sequence and a.node_id = p_node_id and a.status = 'queued' and not coalesce((a.payload->>'prefetch')::boolean,false)
     order by a.scheduled_for limit 2000;
end $$;

create or replace function outreach_set_action_text(p_action uuid, p_text text, p_subject text default null)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype; lim int;
begin
  select * into a from outreach_actions where id = p_action for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(a.workspace_id, 'manager');
  if a.status <> 'queued' then return false; end if;   -- reserved / sent: left alone
  lim := case a.action_type when 'invite' then 300 when 'message' then 8000 when 'inmail' then 1900 when 'comment' then 1250 else 100000 end;
  if length(coalesce(p_text,'')) > lim then raise exception 'E_PAYLOAD_INVALID: text exceeds % characters', lim; end if;
  update outreach_actions set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('text', p_text, 'edited_by', auth.uid(), 'edited_at', now())
         || case when p_subject is not null then jsonb_build_object('subject', p_subject) else '{}'::jsonb end
         || case when a.action_type = 'email' then jsonb_build_object('html', p_text) else '{}'::jsonb end
   where id = p_action;
  perform outreach_audit(a.workspace_id, 'action.text_edited', 'action', p_action::text, jsonb_build_object('lead_id', a.lead_id));
  return true;
end $$;

-- "Update them too": drop the pre-rendered copy so the step re-renders from the published node at send time
create or replace function outreach_refresh_queued_text(p_sequence uuid, p_node_id text)
returns int language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid; cnt int;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  update outreach_actions a set payload = a.payload - 'text' - 'note' - 'subject' - 'html' - 'variant_id', variant_id = null
    from outreach_enrollments e
   where e.id = a.enrollment_id and e.sequence_id = p_sequence and e.pinned_version is null and a.node_id = p_node_id and a.status = 'queued'
     and not coalesce((a.payload->>'prefetch')::boolean,false) and not (a.payload ? 'approved_task_id') and not (a.payload ? 'edited_by');
  get diagnostics cnt = row_count;
  perform outreach_audit(ws, 'sequence.queued_text_refreshed', 'sequence', p_sequence::text, jsonb_build_object('node_id', p_node_id, 'actions', cnt));
  return cnt;
end $$;

create or replace function outreach_reschedule_delay(p_sequence uuid, p_node_id text)
returns table(rescheduled int, due_now int)
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; amt numeric; unit text; iv interval; r record;
begin
  rescheduled := 0; due_now := 0;
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  n := s.graph->'nodes'->p_node_id;
  if n is null or (n->>'type') <> 'delay' then raise exception 'E_PAYLOAD_INVALID: node is not a delay node'; end if;
  amt := coalesce((n->'config'->>'amount')::numeric, 1);
  unit := coalesce(n->'config'->>'unit', 'days');
  iv := case unit when 'minutes' then make_interval(mins => amt::int) when 'hours' then make_interval(hours => amt::int) else make_interval(days => amt::int) end;
  for r in select id, node_entered_at from outreach_enrollments where sequence_id = p_sequence and pinned_version is null and status = 'waiting_delay' and current_node_id = p_node_id loop
    update outreach_enrollments set wait_until = r.node_entered_at + iv, updated_at = now() where id = r.id;
    rescheduled := rescheduled + 1;
    if r.node_entered_at + iv <= now() then due_now := due_now + 1; end if;
  end loop;
  perform outreach_audit(s.workspace_id, 'sequence.timing_edited', 'sequence', p_sequence::text, jsonb_build_object('node_id', p_node_id, 'rescheduled', rescheduled, 'due_now', due_now));
  return next;
end $$;

-- 008 names stay callable (connector), delegating to the same code
create or replace function outreach_agent_node_queued_actions(p_sequence uuid, p_node_id text)
returns table(action_id uuid, lead_id uuid, sender_id uuid, payload jsonb, scheduled_for timestamptz)
language sql stable security definer set search_path = public, extensions as $$
  select q.action_id, q.lead_id, q.sender_id, q.payload, q.scheduled_for from outreach_node_queued_actions(p_sequence, p_node_id) q
$$;
create or replace function outreach_agent_set_action_text(p_action uuid, p_text text)
returns boolean language sql security definer set search_path = public, extensions as $$ select outreach_set_action_text(p_action, p_text, null) $$;
create or replace function outreach_agent_reschedule_delay(p_sequence uuid, p_node_id text)
returns table(rescheduled int, due_now int) language sql security definer set search_path = public, extensions as $$
  select * from outreach_reschedule_delay(p_sequence, p_node_id)
$$;

-- Lead panel: the lead's next queued actions, each editable / skippable / movable
create or replace function outreach_lead_queued_actions(p_lead uuid)
returns table(action_id uuid, enrollment_id uuid, sequence_id uuid, sequence_name text, node_id text, node_label text, action_type outreach_action_type_t,
              sender_id uuid, sender_name text, scheduled_for timestamptz, body text, subject text, variant_id text, editable boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'member');
  return query
    select a.id, a.enrollment_id, q.id, q.name, a.node_id,
           coalesce(outreach_enrollment_graph(e.id)->'nodes'->a.node_id->>'label', replace(a.action_type::text,'_',' ')), a.action_type,
           a.sender_id, s.display_name, a.scheduled_for, coalesce(a.payload->>'text', a.payload->>'note'), a.payload->>'subject', a.variant_id,
           a.action_type in ('invite','message','inmail','email','comment')
      from outreach_actions a join outreach_senders s on s.id = a.sender_id
      left join outreach_enrollments e on e.id = a.enrollment_id left join outreach_sequences q on q.id = e.sequence_id
     where a.lead_id = p_lead and a.status = 'queued' and not coalesce((a.payload->>'prefetch')::boolean,false)
     order by a.scheduled_for;
end $$;

-- Cancelling a queued step would just be re-planned, so the honest operations are "skip this step" and "move it".
create or replace function outreach_skip_action(p_action uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype;
begin
  select * into a from outreach_actions where id = p_action for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(a.workspace_id, 'member');
  if a.status <> 'queued' then raise exception 'E_PAYLOAD_INVALID: only queued actions can be skipped'; end if;
  update outreach_actions set status = 'skipped', executed_at = now(), decision = 'user_skipped', error_code = 'user_skipped' where id = p_action;
  if a.enrollment_id is not null and not coalesce((a.payload->>'subtask')::boolean,false) then
    perform outreach_advance_enrollment(a.enrollment_id, a.node_id, null);
  end if;
  perform outreach_audit(a.workspace_id, 'action.skipped', 'action', p_action::text, jsonb_build_object('lead_id', a.lead_id, 'node_id', a.node_id));
end $$;

create or replace function outreach_reschedule_action(p_action uuid, p_at timestamptz)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype;
begin
  select * into a from outreach_actions where id = p_action for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(a.workspace_id, 'member');
  if a.status <> 'queued' then raise exception 'E_PAYLOAD_INVALID: only queued actions can be moved'; end if;
  if p_at < now() - interval '1 minute' or p_at > now() + interval '60 days' then raise exception 'E_PAYLOAD_INVALID: pick a time within the next 60 days'; end if;
  -- the schedule window and the daily budget still decide when it really goes out
  update outreach_actions set scheduled_for = p_at, decision = 'user_rescheduled' where id = p_action;
end $$;

-- -----------------------------------------------------------------------------
-- Item 8 — failed leads are never a dead end
-- -----------------------------------------------------------------------------
create or replace function outreach_reason_text(p_code text, p_decision text default null) returns text
language sql immutable as $$
  select case
    when p_code is null then 'Unknown reason'
    when p_code in ('E_LEAD_SUPPRESSED','suppressed','do_not_contact','unsubscribed') then 'The lead is on a do-not-contact list'
    when p_code in ('E_REPLIED','replied') then 'The lead replied, so the sequence stopped'
    when p_code = 'E_RELATION_INVALID' then 'LinkedIn says this profile cannot be invited (blocked or invalid)'
    when p_code = 'E_RELATION_REQUIRED' or p_code like '%no_connection_with_recipient%' then 'Not connected yet, so a message could not be sent'
    when p_code = 'E_PAYLOAD_INVALID' or p_code like '%payload_invalid%' then 'The step had no usable text for this lead'
    when p_code = 'E_NO_EMAIL' then 'No email address on file'
    when p_code = 'email_bounced' or p_code like '%recipient_rejected%' then 'The email address bounced'
    when p_code = 'E_ENROLLMENT_NOT_LIVE' then 'The lead had already left the sequence'
    when p_code = 'network_timeout_max' or p_code like 'net:%' then 'Could not reach LinkedIn after three tries'
    when p_code like '%invalid_recipient%' or p_code like '%user_unreachable%' or p_code like '404:%' then 'The profile no longer exists or cannot be reached'
    when p_code like '%blocked_recipient%' or p_code like '%cannot_invite_attendee%' then 'This person cannot be invited (they limit who can connect)'
    when p_code like '%already_invited_recently%' or p_code like '%cannot_resend%' or p_code = 'invitation_pending' then 'An invitation is already pending or was sent recently'
    when p_code like '%already_connected%' or p_code = 'already_connected' then 'Already connected, so the invitation was skipped'
    when p_code like '%insufficient_credits%' or p_code like '%not_allowed_inmail%' or p_code = 'not_open_profile' then 'No InMail credit for this lead'
    when p_code = 'no_recent_post' then 'The lead has no recent post to react to'
    when p_code = 'no_skills' then 'No skills to endorse on the profile'
    when p_code = 'no_voice_clip' then 'This sender has not recorded a voice note for the step'
    when p_code = 'no_invitation' then 'There was no pending invitation to withdraw'
    when p_code like '%comments_disabled%' or p_code like '%invalid_post%' then 'The post does not accept comments'
    when p_code like '401:%' or p_code = 'E_SENDER_NOT_OK' then 'The sender was disconnected from LinkedIn'
    when p_code like '403:%' then 'LinkedIn restricted the sender for this action'
    when p_code like '429:%' then 'LinkedIn rate-limited the sender'
    when p_code like '5__:%' then 'LinkedIn had a temporary error'
    when p_code like 'http_%' then 'The API call returned ' || replace(p_code, 'http_', 'HTTP ')
    when p_code = 'graph_loop' then 'The sequence loops without a wait'
    when p_code = 'unknown_node_type' then 'The sequence contains a step this version cannot run'
    when p_code = 'user_skipped' then 'Skipped by a teammate'
    when p_code = 'email_not_found' then 'No email address was found'
    else replace(replace(p_code, 'E_', ''), '_', ' ') end
$$;

create or replace function outreach_failed_leads(p_sequence uuid, p_node_id text default null, p_kind text default 'failed', p_limit int default 200, p_offset int default 0)
returns table(enrollment_id uuid, lead_id uuid, lead_name text, company text, sender_id uuid, sender_name text, node_id text, error_code text, reason text, at timestamptz, recoverable boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');
  if p_kind = 'skipped' then
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, a.node_id, a.error_code, outreach_reason_text(a.error_code, a.decision), a.executed_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'skipped' and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
       order by a.executed_at desc nulls last limit least(p_limit, 500) offset p_offset;
  else
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, e.current_node_id, coalesce(fa.error_code, e.exit_reason), outreach_reason_text(coalesce(fa.error_code, e.exit_reason), fa.decision), e.completed_at,
             not (l.do_not_contact or l.unsubscribed) and coalesce(fa.decision,'') <> 'mark_lead_invalid'
        from outreach_enrollments e join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = e.sender_id
        left join lateral (select a.error_code, a.decision from outreach_actions a where a.enrollment_id = e.id and a.status = 'failed' order by a.executed_at desc nulls last limit 1) fa on true
       where e.sequence_id = p_sequence and e.status = 'failed' and (p_node_id is null or e.current_node_id = p_node_id)
       order by e.completed_at desc nulls last limit least(p_limit, 500) offset p_offset;
  end if;
end $$;

create or replace function outreach_failed_summary(p_sequence uuid)
returns table(node_id text, reason text, error_code text, leads int, recoverable int, oldest timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');
  return query
    select f.node_id, f.reason, f.error_code, count(*)::int, count(*) filter (where f.recoverable)::int, min(f.at)
      from outreach_failed_leads(p_sequence, null, 'failed', 500, 0) f group by 1,2,3 order by 4 desc;
end $$;

-- retry  = re-queue the same step under a new idempotency key, through the normal budget
-- skip   = advance to the next step          exit = close it for good
-- There is deliberately no "restart from top": to run a lead again, enrol again (preview warnings apply).
create or replace function outreach_enrollment_recover(p_enrollment_ids uuid[], p_action text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare eid uuid; e outreach_enrollments%rowtype; l outreach_leads%rowtype; done int := 0; refused jsonb := '[]'; why text; by_system boolean := outreach_is_service();
begin
  if p_action not in ('retry','skip','exit') then raise exception 'E_PAYLOAD_INVALID: action must be retry, skip or exit'; end if;
  if coalesce(array_length(p_enrollment_ids,1),0) = 0 then return jsonb_build_object('done', 0, 'refused', refused); end if;
  if array_length(p_enrollment_ids,1) > 500 then raise exception 'E_TOO_MANY: max 500 per request'; end if;
  foreach eid in array p_enrollment_ids loop
    select * into e from outreach_enrollments where id = eid for update;
    if not found then refused := refused || jsonb_build_object('id', eid, 'reason', 'not_found'); continue; end if;
    if not by_system then perform outreach_require(e.workspace_id, 'member'); end if;
    if e.status <> 'failed' then refused := refused || jsonb_build_object('id', eid, 'reason', 'not_failed'); continue; end if;
    if p_action = 'exit' then
      update outreach_enrollments set status = 'exited_manual', exit_reason = 'recovered:exit:' || coalesce(exit_reason,'') where id = eid;
      done := done + 1; continue;
    end if;
    select * into l from outreach_leads where id = e.lead_id;
    why := null;
    if outreach_lead_suppression_reason(l, (select client_id from outreach_sequences where id = e.sequence_id), e.sequence_id) is not null then why := 'lead_suppressed';
    elsif exists (select 1 from outreach_lead_sender_state x where x.lead_id = e.lead_id and x.sender_id = e.sender_id and x.relation in ('invalid','blocked')) and p_action = 'retry' then why := 'profile_invalid';
    elsif exists (select 1 from outreach_enrollments x where x.lead_id = e.lead_id and x.sender_id = e.sender_id and x.id <> eid and x.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then why := 'already_enrolled_again';
    elsif not exists (select 1 from outreach_senders s where s.id = e.sender_id and s.deleted_at is null and s.status <> 'disabled') then why := 'sender_gone';
    end if;
    if why is not null then refused := refused || jsonb_build_object('id', eid, 'reason', why); continue; end if;
    update outreach_enrollments set status = 'active', completed_at = null, wait_until = now(), wait_reason = null,
           exit_reason = null, restart_count = restart_count + 1 where id = eid;
    if p_action = 'skip' then perform outreach_advance_enrollment(eid, e.current_node_id, null); end if;
    perform outreach_emit_event(e.workspace_id, 'enrollment.recovered', jsonb_build_object('id', eid, 'lead_id', e.lead_id, 'sequence_id', e.sequence_id, 'action', p_action, 'previous_reason', e.exit_reason));
    done := done + 1;
  end loop;
  return jsonb_build_object('done', done, 'action', p_action, 'refused', refused);
end $$;

-- failures that fix themselves: a reconnecting sender gets its transient failures of the last 7 days back
create or replace function outreach_requeue_sender_failures(p_sender uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare ids uuid[]; res jsonb;
begin
  select array_agg(e.id) into ids from (
    select e.id from outreach_enrollments e
     where e.sender_id = p_sender and e.status = 'failed' and e.completed_at > now() - interval '7 days'
       and (e.exit_reason in ('network_timeout_max','E_SENDER_NOT_OK','sender_not_ok') or e.exit_reason like '401:%' or e.exit_reason like '5__:%' or e.exit_reason like 'net:%')
     order by e.completed_at limit 500) e;
  if ids is null then return 0; end if;
  res := outreach_enrollment_recover(ids, 'retry');
  return coalesce((res->>'done')::int, 0);
end $$;
revoke execute on function outreach_requeue_sender_failures(uuid) from public, anon, authenticated;

create or replace function outreach_trg_sender_reconnected() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if new.status = 'ok' and old.status in ('credentials','error') then
    n := outreach_requeue_sender_failures(new.id);
    if n > 0 then insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'reconnect', jsonb_build_object('requeued_failed_leads', n)); end if;
  end if;
  return null;
end $$;
drop trigger if exists outreach_sender_reconnected on outreach_senders;
create trigger outreach_sender_reconnected after update of status on outreach_senders for each row execute function outreach_trg_sender_reconnected();

-- -----------------------------------------------------------------------------
-- Item 9 — rebalance when the pool changes. Only leads with NO outbound yet on their current sender move,
-- so nothing can be duplicated and the lead never sees two senders.
-- -----------------------------------------------------------------------------
create or replace function outreach__untouched_enrollments(p_sequence uuid)
returns table(enrollment_id uuid, lead_id uuid, sender_id uuid)
language sql stable security definer set search_path = public, extensions as $$
  select e.id, e.lead_id, e.sender_id
    from outreach_enrollments e
    left join outreach_lead_sender_state x on x.lead_id = e.lead_id and x.sender_id = e.sender_id
   where e.sequence_id = p_sequence and e.status in ('active','waiting_delay','waiting_task','paused') and e.held_at is null
     and coalesce(x.relation,'none') in ('none') and x.last_outbound_at is null and x.invite_sent_at is null
     and not exists (select 1 from outreach_actions a where a.enrollment_id = e.id and (a.status in ('sent','reserved')) and not coalesce((a.payload->>'prefetch')::boolean,false))
$$;
revoke execute on function outreach__untouched_enrollments(uuid) from public, anon, authenticated;

create or replace function outreach_rebalance_preview(p_sequence uuid, p_pool uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; pool uuid[]; added uuid[]; removed uuid[]; movable int; target int; per jsonb; to_move int := 0; r record; n int;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  pool := coalesce(p_pool, s.sender_pool);
  select coalesce(array_agg(x),'{}') into added from unnest(pool) x where not (x = any(s.sender_pool));
  select coalesce(array_agg(x),'{}') into removed from unnest(s.sender_pool) x where not (x = any(pool));
  n := coalesce(array_length(pool,1),0);
  select count(*) into movable from outreach__untouched_enrollments(p_sequence);
  target := case when n > 0 then ceil(movable::numeric / n) else 0 end;
  select coalesce(jsonb_agg(jsonb_build_object('sender_id', q.sid, 'name', sd.display_name, 'status', sd.status, 'in_pool', q.sid = any(pool),
           'untouched', q.untouched, 'contacted', q.contacted, 'after', case when q.sid = any(pool) then least(greatest(q.untouched, 0), target) else 0 end)), '[]'::jsonb)
    into per
    from (select sid,
                 (select count(*) from outreach__untouched_enrollments(p_sequence) u where u.sender_id = sid) untouched,
                 (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.sender_id = sid and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
                    and e.id not in (select enrollment_id from outreach__untouched_enrollments(p_sequence))) contacted
            from (select unnest(pool) sid union select unnest(s.sender_pool)) p) q
    join outreach_senders sd on sd.id = q.sid;
  for r in select (x->>'untouched')::int u, (x->>'in_pool')::boolean inp from jsonb_array_elements(per) x loop
    to_move := to_move + case when r.inp then greatest(r.u - target, 0) else r.u end;
  end loop;
  return jsonb_build_object('pool_size', n, 'added', to_jsonb(added), 'removed', to_jsonb(removed), 'untouched_total', movable, 'would_move', to_move, 'target_per_sender', target, 'senders', per,
    'contacted_on_removed', (select coalesce(sum((x->>'contacted')::int),0) from jsonb_array_elements(per) x where not (x->>'in_pool')::boolean),
    'note', 'Only leads with nothing sent and no invite pending can move. Leads a sender already contacted stay with that sender.');
end $$;

-- Applies a pool change and (optionally) evens out the untouched leads. p_contacted: what happens to leads a REMOVED sender already contacted.
create or replace function outreach_set_pool(p_sequence uuid, p_pool uuid[], p_rebalance boolean default false, p_contacted text default 'keep')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n int; moved int := 0; exited int := 0; target int; movable int; r record; dest uuid; removed uuid[];
begin
  select * into s from outreach_sequences where id = p_sequence for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_contacted not in ('keep','exit') then raise exception 'E_PAYLOAD_INVALID: contacted must be keep or exit'; end if;
  if exists (select 1 from unnest(p_pool) pid where not exists (select 1 from outreach_senders x where x.id = pid and x.workspace_id = s.workspace_id and x.deleted_at is null)) then
    raise exception 'E_SENDER_NOT_IN_POOL: sender outside workspace';
  end if;
  n := coalesce(array_length(p_pool,1),0);
  if n = 0 and s.status = 'active' then raise exception 'E_POOL_EMPTY'; end if;
  select coalesce(array_agg(x),'{}') into removed from unnest(s.sender_pool) x where not (x = any(p_pool));
  update outreach_sequences set sender_pool = p_pool, updated_at = now() where id = p_sequence;

  if n > 0 and (p_rebalance or array_length(removed,1) > 0) then
    select count(*) into movable from outreach__untouched_enrollments(p_sequence);
    target := ceil(movable::numeric / n);
    -- candidates: everything untouched on a removed sender, plus the surplus above target on the others (only when rebalancing)
    for r in
      select u.enrollment_id, u.lead_id, u.sender_id from (
        select u.*, row_number() over (partition by u.sender_id order by u.enrollment_id) rn from outreach__untouched_enrollments(p_sequence) u) u
       where u.sender_id = any(removed) or (p_rebalance and u.rn > target)
    loop
      select x.sid into dest from unnest(p_pool) x(sid)
        join outreach_senders sd on sd.id = x.sid and sd.status <> 'disabled'
       where x.sid <> r.sender_id
         and not exists (select 1 from outreach_enrollments e2 where e2.lead_id = r.lead_id and e2.sender_id = x.sid and e2.status in ('active','waiting_connection','waiting_delay','waiting_task','paused'))
         and not exists (select 1 from outreach_lead_sender_state h where h.lead_id = r.lead_id and h.sender_id = x.sid and (h.last_outbound_at is not null or h.invite_sent_at is not null))
       order by (select count(*) from outreach__untouched_enrollments(p_sequence) u2 where u2.sender_id = x.sid), x.sid limit 1;
      if dest is null then continue; end if;
      if not (r.sender_id = any(removed)) and (select count(*) from outreach__untouched_enrollments(p_sequence) u2 where u2.sender_id = dest) >= target then continue; end if;
      update outreach_actions set status = 'cancelled', decision = 'rebalanced' where enrollment_id = r.enrollment_id and status in ('queued','reserved');
      insert into outreach_lead_sender_state(lead_id, sender_id) values (r.lead_id, dest) on conflict do nothing;
      update outreach_enrollments set sender_id = dest where id = r.enrollment_id;
      moved := moved + 1;
    end loop;
  end if;

  if p_contacted = 'exit' and array_length(removed,1) > 0 then
    for r in select id from outreach_enrollments where sequence_id = p_sequence and sender_id = any(removed) and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
      perform outreach_complete_enrollment(r.id, 'exited_manual', 'sender_removed_from_pool');
      exited := exited + 1;
    end loop;
  end if;
  perform outreach_audit(s.workspace_id, 'sequence.pool_changed', 'sequence', p_sequence::text, jsonb_build_object('pool', p_pool, 'moved', moved, 'exited', exited, 'rebalance', p_rebalance));
  return jsonb_build_object('pool', to_jsonb(p_pool), 'moved', moved, 'exited', exited);
end $$;

-- -----------------------------------------------------------------------------
-- Item 17 — scoped, non-destructive blacklists
-- -----------------------------------------------------------------------------
create or replace function outreach_lead_suppression_reason(p_lead outreach_leads, p_client uuid default null, p_sequence uuid default null) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case
    when p_lead.do_not_contact then 'do_not_contact'
    when p_lead.unsubscribed then 'unsubscribed'
    else (
      select case when sp.sequence_id is not null then 'sequence' when sp.client_id is not null then 'client' else 'workspace' end || '_blacklist:' || sp.kind
        from outreach_suppressions sp
       where sp.workspace_id = p_lead.workspace_id
         and (sp.client_id is null or sp.client_id = coalesce(p_client, p_lead.client_id))
         and (sp.sequence_id is null or sp.sequence_id = p_sequence)
         and (
           (sp.kind = 'public_identifier' and p_lead.public_identifier is not null and sp.value = p_lead.public_identifier) or
           (sp.kind = 'email' and ((p_lead.email_work is not null and sp.value = p_lead.email_work) or (p_lead.email_personal is not null and sp.value = p_lead.email_personal))) or
           (sp.kind = 'domain' and ((p_lead.email_work is not null and lower(split_part(p_lead.email_work::text,'@',2)) = lower(sp.value::text)) or
                                    (p_lead.email_personal is not null and lower(split_part(p_lead.email_personal::text,'@',2)) = lower(sp.value::text)))) or
           (sp.kind = 'company' and ((p_lead.company is not null and (lower(trim(p_lead.company)) = lower(sp.value::text)
                                        or outreach_slugify(p_lead.company) = outreach_slugify(sp.value::text)))   -- a linkedin.com/company/<slug> entry matches the company name's slug
                                     or (p_lead.company_id is not null and p_lead.company_id = sp.value::text)))
         )
       order by (sp.sequence_id is not null) desc, (sp.client_id is not null) desc limit 1)
  end
$$;

create or replace function outreach_lead_is_suppressed(p_lead outreach_leads) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select outreach_lead_suppression_reason(p_lead, p_lead.client_id, null) is not null
$$;

-- send-time check used by the executor: the enrollment's client + sequence scope
create or replace function outreach_enrollment_suppression_reason(p_enrollment uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select outreach_lead_suppression_reason(l, q.client_id, q.id)
    from outreach_enrollments e join outreach_leads l on l.id = e.lead_id join outreach_sequences q on q.id = e.sequence_id where e.id = p_enrollment
$$;
revoke execute on function outreach_enrollment_suppression_reason(uuid) from public, anon, authenticated;

-- Bulk add (UI form, CSV upload, CRM refresh). Values are normalised; nothing is ever deleted from leads or chats.
create or replace function outreach_add_suppressions(p_ws uuid, p_rows jsonb, p_client uuid default null, p_sequence uuid default null, p_source text default 'manual')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; k text; v text; added int := 0; skipped int := 0; n int;
begin
  perform outreach_require(p_ws, 'manager');
  if p_client is not null and p_sequence is not null then raise exception 'E_PAYLOAD_INVALID: choose a client scope or a sequence scope, not both'; end if;
  if p_client is not null and not exists (select 1 from outreach_clients where id = p_client and workspace_id = p_ws) then raise exception 'E_NOT_FOUND: client'; end if;
  if p_sequence is not null and not exists (select 1 from outreach_sequences where id = p_sequence and workspace_id = p_ws) then raise exception 'E_NOT_FOUND: sequence'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'E_PAYLOAD_INVALID: rows must be an array'; end if;
  if jsonb_array_length(p_rows) > 20000 then raise exception 'E_TOO_MANY: max 20000 rows per upload'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v := lower(trim(coalesce(r->>'value','')));
    k := coalesce(nullif(r->>'kind',''), case when v ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then 'email' when v ~ 'linkedin\.com/in/' then 'public_identifier'
                                              when v ~ 'linkedin\.com/company/' then 'company'
                                              when v ~ '^https?://' or v ~ '^www\.' or v ~ '^([a-z0-9-]+\.)+[a-z]{2,}$' then 'domain' else 'company' end);
    if v = '' or k not in ('domain','public_identifier','email','company') then skipped := skipped + 1; continue; end if;
    if k = 'public_identifier' then v := regexp_replace(regexp_replace(v, '^.*linkedin\.com/in/', ''), '[/?#].*$', '');
    elsif k = 'domain' then v := regexp_replace(regexp_replace(regexp_replace(v, '^https?://', ''), '^www\.', ''), '[/?#].*$', '');
    elsif k = 'company' and v ~ 'linkedin\.com/company/' then v := regexp_replace(regexp_replace(v, '^.*linkedin\.com/company/', ''), '[/?#].*$', '');
    end if;
    if v = '' then skipped := skipped + 1; continue; end if;
    insert into outreach_suppressions(workspace_id, client_id, sequence_id, kind, value, reason, source, created_by)
    values (p_ws, p_client, p_sequence, k, v, nullif(r->>'reason',''), p_source, auth.uid()) on conflict do nothing;
    get diagnostics n = row_count;
    if n > 0 then added := added + 1; else skipped := skipped + 1; end if;
  end loop;
  perform outreach_audit(p_ws, 'suppression.added', 'suppression', null, jsonb_build_object('added', added, 'skipped', skipped, 'client_id', p_client, 'sequence_id', p_sequence, 'source', p_source));
  return jsonb_build_object('added', added, 'skipped', skipped);
end $$;

-- -----------------------------------------------------------------------------
-- Enrolment: ONE plan, used by both the preview and the commit (items 1, 17, 19)
-- -----------------------------------------------------------------------------
create or replace function outreach__enroll_plan(p_sequence uuid, p_lead_ids uuid[], p_sender uuid, p_include_replied boolean)
returns table(lead_id uuid, sender_id uuid, reason text, note text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; l outreach_leads; pool uuid[]; n int; i int := 0; offs int; lid uuid; chosen uuid; rr uuid; tries int; why text;
        load jsonb := '{}'; k text; busy uuid[]; hist uuid[]; free uuid[];
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  pool := s.sender_pool;
  if p_sender is not null then
    if not (p_sender = any(pool)) then raise exception 'E_SENDER_NOT_IN_POOL'; end if;
    pool := array[p_sender];
  end if;
  select coalesce(array_agg(x.id order by array_position(pool, x.id)), '{}') into pool from outreach_senders x where x.id = any(pool) and x.deleted_at is null and x.status <> 'disabled';
  n := coalesce(array_length(pool,1),0);
  if n = 0 then raise exception 'E_POOL_EMPTY'; end if;
  select count(*) into offs from outreach_enrollments where sequence_id = p_sequence;
  for k in select unnest(pool)::text loop
    load := load || jsonb_build_object(k, (select count(*) from outreach_enrollments e where e.sender_id = k::uuid and e.status in ('active','waiting_connection','waiting_delay','waiting_task')));
  end loop;

  foreach lid in array p_lead_ids loop
    lead_id := lid; sender_id := null; reason := null; note := null; chosen := null;
    select * into l from outreach_leads x where x.id = lid and x.workspace_id = s.workspace_id;
    if not found then reason := 'not_in_workspace'; return next; continue; end if;
    why := outreach_lead_suppression_reason(l, s.client_id, s.id);
    if why is not null then reason := 'suppressed:' || why; return next; continue; end if;
    if not p_include_replied and l.last_replied_at is not null and l.last_replied_at > now() - interval '90 days' then
      reason := 'replied_recently'; return next; continue;
    end if;
    select coalesce(array_agg(e.sender_id), '{}') into busy from outreach_enrollments e where e.lead_id = lid and e.sender_id = any(pool) and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused');
    select coalesce(array_agg(h.sender_id order by greatest(coalesce(h.last_outbound_at,'epoch'), coalesce(h.last_inbound_at,'epoch'), coalesce(h.invite_sent_at,'epoch')) desc), '{}') into hist
      from outreach_lead_sender_state h where h.lead_id = lid and h.sender_id = any(pool) and (h.last_outbound_at is not null or h.last_inbound_at is not null or h.invite_sent_at is not null);
    select coalesce(array_agg(x), '{}') into free from unnest(pool) x where not (x = any(busy));
    if array_length(free,1) is null then reason := 'already_enrolled'; return next; continue; end if;

    rr := null;
    for tries in 0..n-1 loop
      if pool[((offs + i + tries) % n) + 1] = any(free) then rr := pool[((offs + i + tries) % n) + 1]; exit; end if;
    end loop;

    if p_sender is not null then
      chosen := rr;
    elsif s.assignment = 'fresh_sender' then
      if rr is not null and not (rr = any(hist)) then chosen := rr;
      else
        select x into chosen from unnest(free) x where not (x = any(hist)) order by (load->>x::text)::int, x limit 1;
        if chosen is null then reason := 'no_fresh_sender'; return next; continue; end if;   -- excluded leads never advance the round-robin, so the commit (eligible ids only) assigns exactly like the preview
        note := 'moved_to_fresh_sender';
      end if;
    elsif s.assignment = 'same_sender' then
      select x into chosen from unnest(hist) x where x = any(free) limit 1;
      if chosen is not null then note := case when chosen = rr then null else 'kept_with_previous_sender' end; else chosen := rr; end if;
    elsif s.assignment = 'least_loaded' then
      select x into chosen from unnest(free) x order by (load->>x::text)::int, x limit 1;
    else
      chosen := rr;
    end if;
    if chosen is null then reason := 'already_enrolled'; return next; continue; end if;
    if note is null and chosen = any(hist) then note := 'contacted_before_by_this_sender'; end if;
    load := jsonb_set(load, array[chosen::text], to_jsonb(coalesce((load->>chosen::text)::int, 0) + 1));
    sender_id := chosen; i := i + 1;
    return next;
  end loop;
end $$;
revoke execute on function outreach__enroll_plan(uuid,uuid[],uuid,boolean) from public, anon, authenticated;

create or replace function outreach_enroll_preview(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null, p_include_replied boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; res jsonb; warnings jsonb := '[]'; proj record; elig int; r record;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if coalesce(array_length(p_lead_ids,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: lead_ids required'; end if;
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  for r in select display_name, status from outreach_senders where id = any(s.sender_pool) and status <> 'ok' and deleted_at is null loop
    warnings := warnings || to_jsonb(format('Sender "%s" is %s and will not send until it is reconnected or resumed', r.display_name, r.status));
  end loop;
  if s.status <> 'active' then warnings := warnings || to_jsonb(format('The sequence is %s: leads wait at the start until it is activated', s.status)); end if;

  with plan as (select * from outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied))
  select jsonb_build_object(
    'requested', (select count(*) from plan),
    'eligible', (select count(*) from plan where sender_id is not null),
    'eligible_ids', (select coalesce(jsonb_agg(lead_id), '[]'::jsonb) from plan where sender_id is not null),
    'excluded', (select coalesce(jsonb_object_agg(x.reason, jsonb_build_object('count', x.c, 'sample_ids', x.ids)), '{}'::jsonb)
                   from (select reason, count(*) c, (array_agg(lead_id))[1:10] ids from plan where sender_id is null group by reason) x),
    'replied_recently', (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'name', l.full_name, 'company', l.company, 'last_replied_at', l.last_replied_at, 'channel', l.last_replied_channel) order by l.last_replied_at desc), '[]'::jsonb)
                           from (select lead_id from plan where reason = 'replied_recently' limit 50) p join outreach_leads l on l.id = p.lead_id),
    'assignment', (select coalesce(jsonb_agg(jsonb_build_object('sender_id', x.sender_id, 'name', sd.display_name, 'status', sd.status, 'leads', x.c)), '[]'::jsonb)
                     from (select sender_id, count(*) c from plan where sender_id is not null group by sender_id) x join outreach_senders sd on sd.id = x.sender_id),
    'assignment_rule', s.assignment,
    'rule_effects', (select coalesce(jsonb_object_agg(x.note, x.c), '{}'::jsonb) from (select note, count(*) c from plan where note is not null group by note) x)
  ) into res;
  elig := (res->>'eligible')::int;
  if elig > 0 then
    select * into proj from outreach_project_sequence(p_sequence, elig);
    res := res || jsonb_build_object('projection', jsonb_build_object('estimated_days', proj.estimated_days, 'bottleneck', proj.bottleneck));
  end if;
  if coalesce((res->'rule_effects'->>'contacted_before_by_this_sender')::int, 0) > 0 then
    warnings := warnings || to_jsonb(format('%s lead(s) were contacted before by the sender they are assigned to', res->'rule_effects'->>'contacted_before_by_this_sender'));
  end if;
  return res || jsonb_build_object('sequence_id', p_sequence, 'sequence_status', s.status, 'include_replied', p_include_replied, 'warnings', warnings);
end $$;

drop function if exists outreach_enroll_leads(uuid, uuid[], uuid, int);
create or replace function outreach_enroll_leads(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null, p_priority int default 100,
                                                 p_include_replied boolean default false, p_rule uuid default null, p_wait_enrichment boolean default null)
returns table(enrolled int, skipped_active int, skipped_suppressed int, skipped_other int, skipped_replied int, waiting int)
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; p record; eid uuid; keys text[]; want_wait boolean; hold_ai boolean; st outreach_enrollment_status_t; wr text; enriched timestamptz; want_posts boolean;
begin
  enrolled := 0; skipped_active := 0; skipped_suppressed := 0; skipped_other := 0; skipped_replied := 0; waiting := 0;
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  keys := outreach_sequence_ai_keys(s.graph);
  want_wait := coalesce(p_wait_enrichment, (s.settings->>'wait_for_enrichment')::boolean, false);
  hold_ai := coalesce((s.settings->>'hold_for_ai_review')::boolean, false) and array_length(keys,1) > 0;
  want_posts := position('enrich.recent_post' in s.graph::text) > 0
                or exists (select 1 from outreach_ai_variables v where v.workspace_id = s.workspace_id and v.key = any(keys) and v.needs_posts);

  for p in select * from outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied) loop
    if p.sender_id is null then
      if p.reason like 'suppressed:%' then skipped_suppressed := skipped_suppressed + 1;
      elsif p.reason = 'replied_recently' then skipped_replied := skipped_replied + 1;
      elsif p.reason in ('already_enrolled') then skipped_active := skipped_active + 1;
      else skipped_other := skipped_other + 1; end if;
      continue;
    end if;
    st := 'active'; wr := null;
    if want_wait then
      select enriched_at into enriched from outreach_lead_profiles where lead_id = p.lead_id;
      if enriched is null or enriched < now() - interval '90 days' then st := 'waiting_task'; wr := 'enrichment'; end if;
    end if;
    if wr is null and hold_ai then
      perform outreach_ensure_ai_values(s.workspace_id, p.lead_id, keys, null);
      if exists (select 1 from outreach_ai_variables v left join outreach_ai_values x on x.variable_id = v.id and x.lead_id = p.lead_id
                  where v.workspace_id = s.workspace_id and v.key = any(keys) and coalesce(x.status,'pending') in ('pending','generated')) then
        st := 'waiting_task'; wr := 'ai_review';
      end if;
    end if;
    insert into outreach_lead_sender_state(lead_id, sender_id) values (p.lead_id, p.sender_id) on conflict do nothing;
    -- "replied" in conditions means "replied during this enrolment": a deliberate re-enrol starts clean
    update outreach_lead_sender_state set replied = false where lead_id = p.lead_id and sender_id = p.sender_id and replied;
    eid := null;
    insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, wait_reason, current_node_id, priority, created_by, rule_id)
    values (s.workspace_id, p_sequence, s.head_version, p.lead_id, p.sender_id, st, wr, s.graph->>'start', p_priority, auth.uid(), p_rule)
    on conflict do nothing returning id into eid;
    if eid is null then skipped_active := skipped_active + 1; continue; end if;
    enrolled := enrolled + 1;
    perform outreach_emit_event(s.workspace_id, 'enrollment.started', jsonb_build_object('id', eid, 'lead_id', p.lead_id, 'sender_id', p.sender_id, 'sequence_id', p_sequence, 'rule_id', p_rule));
    if wr = 'enrichment' then
      waiting := waiting + 1;
      update outreach_leads set enrich_status = 'waiting' where id = p.lead_id;
      insert into outreach_enrich_queue(lead_id, workspace_id, want_posts, requested_by, reason) values (p.lead_id, s.workspace_id, want_posts, auth.uid(), 'enrollment')
      on conflict (lead_id) do update set want_posts = outreach_enrich_queue.want_posts or excluded.want_posts, next_at = least(outreach_enrich_queue.next_at, now());
    elsif wr = 'ai_review' then
      waiting := waiting + 1;
    else
      perform outreach_enter_node(eid, s.graph->>'start');
    end if;
  end loop;
  return next;
end $$;

-- -----------------------------------------------------------------------------
-- Item 18 — auto-enrol rules. Same checks as the preview, a daily cap, and a visible log.
-- -----------------------------------------------------------------------------
create or replace function outreach_save_auto_enroll_rule(p_rule jsonb)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; rid uuid;
begin
  select * into s from outreach_sequences where id = (p_rule->>'sequence_id')::uuid;
  if not found then raise exception 'E_NOT_FOUND: sequence'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if (p_rule->>'id') is null and (p_rule->>'list_id') is null and coalesce(p_rule->'filter','{}'::jsonb) = '{}'::jsonb then raise exception 'E_PAYLOAD_INVALID: choose a list or at least one filter'; end if;
  if (p_rule->>'list_id') is not null and not exists (select 1 from outreach_lists where id = (p_rule->>'list_id')::uuid and workspace_id = s.workspace_id) then raise exception 'E_NOT_FOUND: list'; end if;
  if (p_rule->>'id') is not null then
    update outreach_auto_enroll_rules set name = coalesce(p_rule->>'name', name),
           list_id = case when p_rule ? 'list_id' then (p_rule->>'list_id')::uuid else list_id end,
           filter = case when p_rule ? 'filter' then coalesce(p_rule->'filter','{}'::jsonb) else filter end,
           daily_cap = coalesce((p_rule->>'daily_cap')::int, daily_cap), active = coalesce((p_rule->>'active')::boolean, active)
     where id = (p_rule->>'id')::uuid and workspace_id = s.workspace_id returning id into rid;
    if rid is null then raise exception 'E_NOT_FOUND: rule'; end if;
  else
    insert into outreach_auto_enroll_rules(workspace_id, sequence_id, name, list_id, filter, daily_cap, active, created_by)
    values (s.workspace_id, s.id, coalesce(nullif(p_rule->>'name',''), 'Auto-enrol rule'), (p_rule->>'list_id')::uuid, coalesce(p_rule->'filter','{}'::jsonb),
            coalesce((p_rule->>'daily_cap')::int, 50), coalesce((p_rule->>'active')::boolean, true), auth.uid()) returning id into rid;
  end if;
  perform outreach_audit(s.workspace_id, 'auto_enroll.rule_saved', 'sequence', s.id::text, p_rule);
  return rid;
end $$;

create or replace function outreach_delete_auto_enroll_rule(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_auto_enroll_rules where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  delete from outreach_auto_enroll_rules where id = p_id;
end $$;

-- leads a rule would pick up right now (also powers the "matches N leads" hint in the UI)
create or replace function outreach__rule_candidates(p_rule uuid, p_limit int)
returns setof uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_auto_enroll_rules%rowtype; f jsonb;
begin
  select * into r from outreach_auto_enroll_rules where id = p_rule;
  if not found then return; end if;
  f := coalesce(r.filter, '{}'::jsonb);
  return query
    select l.id from outreach_leads l
      left join outreach_lead_profiles pr on pr.lead_id = l.id
     where l.workspace_id = r.workspace_id and not l.do_not_contact and not l.unsubscribed
       and (r.list_id is null or l.list_id = r.list_id)
       and ((f->>'client_id') is null or l.client_id = (f->>'client_id')::uuid)
       and ((f->>'stage_id') is null or l.stage_id = (f->>'stage_id')::uuid)
       and ((f->>'source') is null or l.source = f->>'source')
       and ((f->>'title_contains') is null or l.title ilike '%' || (f->>'title_contains') || '%' or l.headline ilike '%' || (f->>'title_contains') || '%')
       and ((f->>'company_contains') is null or l.company ilike '%' || (f->>'company_contains') || '%')
       and ((f->>'location_contains') is null or l.location ilike '%' || (f->>'location_contains') || '%')
       and ((f->>'min_followers') is null or pr.follower_count >= (f->>'min_followers')::int)
       and ((f->>'posted_within_days') is null or pr.last_posted_at > now() - make_interval(days => (f->>'posted_within_days')::int))
       and (jsonb_typeof(f->'tag_ids') is distinct from 'array' or jsonb_array_length(f->'tag_ids') = 0
            or exists (select 1 from outreach_lead_tags lt where lt.lead_id = l.id and lt.tag_id::text in (select jsonb_array_elements_text(f->'tag_ids'))))
       and not exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.sequence_id = r.sequence_id)   -- once per sequence, ever
     order by l.created_at limit p_limit;
end $$;
revoke execute on function outreach__rule_candidates(uuid,int) from public, anon, authenticated;

create or replace function outreach_rule_match_count(p_rule uuid) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_auto_enroll_rules where id = p_rule;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'member');
  return (select count(*)::int from outreach__rule_candidates(p_rule, 5000));
end $$;

create or replace function outreach_run_auto_enroll(p_rule uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; ids uuid[]; used int; room int; res record; total int := 0; ran int := 0; today date := (now() at time zone 'utc')::date;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in select ar.* from outreach_auto_enroll_rules ar join outreach_sequences q on q.id = ar.sequence_id
            where ar.active and q.status = 'active' and (p_rule is null or ar.id = p_rule)
              and outreach_plan_active(ar.workspace_id) loop
    select coalesce(sum(enrolled),0) into used from outreach_auto_enroll_log where rule_id = r.id and day = today;
    room := r.daily_cap - used;
    if room <= 0 then continue; end if;
    select array_agg(x) into ids from outreach__rule_candidates(r.id, room) x;
    update outreach_auto_enroll_rules set last_run_at = now() where id = r.id;
    if ids is null then continue; end if;
    select * into res from outreach_enroll_leads(r.sequence_id, ids, null, 100, false, r.id, null);
    insert into outreach_auto_enroll_log(rule_id, day, matched, enrolled, skipped)
    values (r.id, today, array_length(ids,1), res.enrolled, jsonb_build_object('active', res.skipped_active, 'suppressed', res.skipped_suppressed, 'replied_recently', res.skipped_replied, 'other', res.skipped_other));
    total := total + res.enrolled; ran := ran + 1;
  end loop;
  return jsonb_build_object('rules_run', ran, 'enrolled', total);
end $$;
revoke execute on function outreach_run_auto_enroll(uuid) from public, anon, authenticated;

-- a lead joining a list triggers its rules promptly instead of waiting for the next cron pass
create or replace function outreach_trg_lead_list_rule() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.list_id is not null and (tg_op = 'INSERT' or new.list_id is distinct from old.list_id) then
    update outreach_auto_enroll_rules set last_run_at = null where list_id = new.list_id and active;   -- null = "run me next"
  end if;
  return null;
end $$;
drop trigger if exists outreach_lead_list_rule on outreach_leads;
create trigger outreach_lead_list_rule after insert or update of list_id on outreach_leads for each row execute function outreach_trg_lead_list_rule();

-- grants: user-callable RPCs never go to anon
do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_save_draft(uuid,jsonb)','outreach_discard_draft(uuid)','outreach_publish_impact(uuid,jsonb)',
    'outreach_publish_sequence(uuid,jsonb,text,text,boolean,boolean,boolean,text,uuid[],jsonb,text,text,text,boolean,uuid)',
    'outreach_version_usage(uuid)','outreach_move_to_latest(uuid,int)','outreach_node_queued_actions(uuid,text)','outreach_set_action_text(uuid,text,text)',
    'outreach_refresh_queued_text(uuid,text)','outreach_reschedule_delay(uuid,text)','outreach_lead_queued_actions(uuid)','outreach_skip_action(uuid)',
    'outreach_reschedule_action(uuid,timestamptz)','outreach_failed_leads(uuid,text,text,int,int)','outreach_failed_summary(uuid)','outreach_enrollment_recover(uuid[],text)',
    'outreach_rebalance_preview(uuid,uuid[])','outreach_set_pool(uuid,uuid[],boolean,text)','outreach_add_suppressions(uuid,jsonb,uuid,uuid,text)',
    'outreach_enroll_preview(uuid,uuid[],uuid,boolean)','outreach_enroll_leads(uuid,uuid[],uuid,int,boolean,uuid,boolean)',
    'outreach_save_auto_enroll_rule(jsonb)','outreach_delete_auto_enroll_rule(uuid)','outreach_rule_match_count(uuid)']) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
