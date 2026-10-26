-- =============================================================================
-- 098 — Every step chip on the sequence canvas opens its leads, not only failed / skipped.
--
-- outreach_failed_leads(p_sequence, p_node_id, p_kind, …) gains the kinds behind the other chips. Same row shape,
-- so the app hook, the public API (/sequences/:id/failed) and the connector (enrollments_failed) take them as is.
--   queued   — the step's actions waiting to go out (status queued | reserved): what the `queued` counter counts.
--              `at` = when it is due, soonest first. reason = 'Sending now' | 'Waiting to send'.
--   sent     — the step's sent actions (the `sent` counter). `at` = when it went out.
--   accepted — enrolments whose invitation / follow was accepted (outreach_sequence_lead_facts.accepted_at, the
--              Results tab's truth). Per wait step: only leads that then went on down that step's connected /
--              followed_back branch (an action or the current step on a step only that branch reaches), which is
--              when the trigger bumps the counter. A lead that accepted after the wait ran out, or after being
--              exited, is in the sequence-wide list but not on the step.
--   replied  — first replies (is_first_reply) credited to the step's sent action (the send step's counter). On a
--              wait_for_reply step: first replies to the send step that leads into it. reason = the reply text.
-- failed / skipped are unchanged. Two wait steps after one invitation stay apart (checked on the live sequence
-- b4b575ff…: every list matched its chip except where the counter had drifted).
-- Idempotent.
-- =============================================================================

-- Every step reachable from p_from (itself included), through `next` and every branch.
create or replace function outreach__reachable_steps(p_graph jsonb, p_from text) returns text[]
language plpgsql immutable set search_path = public, extensions as $$
declare seen text[] := '{}'; queue text[] := array[p_from]; cur text; n jsonb; b text;
begin
  while cardinality(queue) > 0 and cardinality(seen) < 1000 loop
    cur := queue[1]; queue := queue[2:];
    if cur is null or cur = any(seen) then continue; end if;
    n := p_graph->'nodes'->cur;
    if n is null then continue; end if;
    seen := seen || cur;
    if n->>'next' is not null then queue := queue || (n->>'next'); end if;
    if jsonb_typeof(n->'branches') = 'object' then
      for b in select value from jsonb_each_text(n->'branches') where value is not null loop queue := queue || b; end loop;
    end if;
  end loop;
  return seen;
end $$;
revoke execute on function outreach__reachable_steps(jsonb,text) from public, anon, authenticated;

-- The first step of one of p_types on from p_node, following `next` only (a branching step ends the walk).
create or replace function outreach__next_step_of_type(p_graph jsonb, p_node text, p_types text[]) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare cur text := p_node; n jsonb; i int := 0;
begin
  while cur is not null and i < 25 loop
    n := p_graph->'nodes'->cur;
    if n is null then return null; end if;
    if (n->>'type') = any(p_types) then return cur; end if;
    cur := n->>'next';
    i := i + 1;
  end loop;
  return null;
end $$;
revoke execute on function outreach__next_step_of_type(jsonb,text,text[]) from public, anon, authenticated;

create or replace function outreach_failed_leads(p_sequence uuid, p_node_id text default null, p_kind text default 'failed', p_limit int default 200, p_offset int default 0)
returns table(enrollment_id uuid, lead_id uuid, lead_name text, company text, sender_id uuid, sender_name text, node_id text, error_code text, reason text, at timestamptz, recoverable boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid; g jsonb; br jsonb; conn text[]; other text[]; lim int := least(greatest(coalesce(p_limit, 200), 1), 500); off int := greatest(coalesce(p_offset, 0), 0);
begin
  select workspace_id, graph into ws, g from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');
  if not outreach_client_visible(ws, (select sq_.client_id from outreach_sequences sq_ where sq_.id = p_sequence)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_kind = 'skipped' then
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, a.node_id, a.error_code, outreach_reason_text(a.error_code, a.decision), a.executed_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'skipped' and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
       order by a.executed_at desc nulls last limit lim offset off;
  elsif p_kind = 'queued' then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, a.node_id, null::text,
             case when a.status = 'reserved' then 'Sending now' else 'Waiting to send' end, a.scheduled_for, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status in ('queued','reserved') and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
       order by a.scheduled_for asc nulls last, a.id limit lim offset off;
  elsif p_kind = 'sent' then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, a.node_id, null::text, null::text, a.executed_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'sent' and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
       order by a.executed_at desc nulls last, a.id limit lim offset off;
  elsif p_kind = 'accepted' then
    if p_node_id is not null then
      -- steps only the connected / followed_back branch reaches (a merge reachable both ways proves nothing)
      br := case when jsonb_typeof(g->'nodes'->p_node_id->'branches') = 'object' then g->'nodes'->p_node_id->'branches' else '{}' end;
      select coalesce(array_agg(distinct y), '{}') into other
        from jsonb_each_text(br) b, unnest(outreach__reachable_steps(g, b.value)) y where b.key not in ('connected','followed_back');
      select coalesce(array_agg(distinct x), '{}') into conn
        from jsonb_each_text(br) b, unnest(outreach__reachable_steps(g, b.value)) x where b.key in ('connected','followed_back') and not x = any(other);
    end if;
    return query
      select e.id, l.id, l.full_name, l.company, e.sender_id, s.display_name, p_node_id, null::text, null::text, f.accepted_at, false
        from outreach_sequence_lead_facts f join outreach_enrollments e on e.id = f.enrollment_id join outreach_leads l on l.id = e.lead_id
        left join outreach_senders s on s.id = e.sender_id
       where f.sequence_id = p_sequence and f.accepted_at is not null
         and (p_node_id is null or e.current_node_id = any(conn)
              or exists (select 1 from outreach_actions a where a.enrollment_id = e.id and a.node_id = any(conn)))
       order by f.accepted_at desc, e.id limit lim offset off;
  elsif p_kind = 'replied' then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, coalesce(p_node_id, a.node_id), null::text,
             nullif(left(btrim(regexp_replace(coalesce(m.text, ''), '\s+', ' ', 'g')), 200), ''), m.sent_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id
        join outreach_messages m on m.replied_to_action_id = a.id and m.direction = 'in' and m.is_first_reply
        left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'sent' and a.node_id is not null
         and (p_node_id is null or a.node_id = p_node_id
              or ((g->'nodes'->p_node_id->>'type') = 'wait_for_reply'
                  and outreach__next_step_of_type(g, g->'nodes'->a.node_id->>'next', array['wait_for_reply']) = p_node_id))
       order by m.sent_at desc, m.id limit lim offset off;
  else
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, e.current_node_id, coalesce(fa.error_code, e.exit_reason), outreach_reason_text(coalesce(fa.error_code, e.exit_reason), fa.decision), e.completed_at,
             not (l.do_not_contact or l.unsubscribed) and coalesce(fa.decision,'') <> 'mark_lead_invalid'
        from outreach_enrollments e join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = e.sender_id
        left join lateral (select a.error_code, a.decision from outreach_actions a where a.enrollment_id = e.id and a.status = 'failed' order by a.executed_at desc nulls last limit 1) fa on true
       where e.sequence_id = p_sequence and e.status = 'failed' and (p_node_id is null or e.current_node_id = p_node_id)
       order by e.completed_at desc nulls last limit lim offset off;
  end if;
end $$;
