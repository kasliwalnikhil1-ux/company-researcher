-- =============================================================================
-- 106 — "Activity by day" opens the people behind each bar (30 Oct 2026).
--
-- outreach_failed_leads(p_sequence, p_node_id, p_kind, p_limit, p_offset) gains two optional dates, p_from / p_to
-- (workspace days, both inclusive; one of them alone means that single day), and two kinds. Same row shape, so the
-- app hook, the public API (/sequences/:id/failed) and the connector (enrollments_failed) keep working unchanged.
--   p_from / p_to — keep only rows whose moment (`at`) falls on those days: sent / skipped = executed_at,
--                   queued = scheduled_for, failed = the enrolment's completed_at, accepted / replied / interested /
--                   meetings = the 089 facts' accepted_at / replied_at / positive_at / meeting_at. These are the
--                   timestamps outreach_sequence_analytics (105) buckets its daily chart by, so the list behind a
--                   day's bar is exactly what the bar counts.
--   interested    — leads whose first human reply was classified positive (facts.positive_at). reason = the reply.
--   meetings      — leads with a meeting booked (facts.meeting_at).
--   replied, sequence-wide (p_node_id null) — now read from the facts (replied_at + reply_message_id) instead of the
--                   per-step credit, so the list matches the Replied card and the chart. Per step it is unchanged.
-- The old 5-argument signature is dropped first: a second overload would make PostgREST calls ambiguous.
-- Idempotent. Apply after 105. Smoke: tests/smoke_34_day_leads.sql.
-- =============================================================================

drop function if exists outreach_failed_leads(uuid, text, text, int, int);

create or replace function outreach_failed_leads(p_sequence uuid, p_node_id text default null, p_kind text default 'failed', p_limit int default 200, p_offset int default 0, p_from date default null, p_to date default null)
returns table(enrollment_id uuid, lead_id uuid, lead_name text, company text, sender_id uuid, sender_name text, node_id text, error_code text, reason text, at timestamptz, recoverable boolean)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid; g jsonb; br jsonb; conn text[]; other text[]; lim int := least(greatest(coalesce(p_limit, 200), 1), 500); off int := greatest(coalesce(p_offset, 0), 0);
        z text; f date; t date; f_ts timestamptz; t_ts timestamptz;
begin
  select workspace_id, graph into ws, g from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');
  if not outreach_client_visible(ws, (select sq_.client_id from outreach_sequences sq_ where sq_.id = p_sequence)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  -- the day window, in the workspace's own days (one date alone = that day)
  f := coalesce(p_from, p_to); t := coalesce(p_to, p_from);
  if f is not null then
    if t < f then raise exception 'E_PAYLOAD_INVALID: from/to must be dates with from <= to'; end if;
    z := outreach_ws_tz(ws);
    f_ts := f::timestamp at time zone z; t_ts := (t + 1)::timestamp at time zone z;
  end if;
  if p_kind = 'skipped' then
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, a.node_id, a.error_code, outreach_reason_text(a.error_code, a.decision), a.executed_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'skipped' and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
         and (f_ts is null or (a.executed_at >= f_ts and a.executed_at < t_ts))
       order by a.executed_at desc nulls last limit lim offset off;
  elsif p_kind = 'queued' then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, a.node_id, null::text,
             case when a.status = 'reserved' then 'Sending now' else 'Waiting to send' end, a.scheduled_for, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status in ('queued','reserved') and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
         and (f_ts is null or (a.scheduled_for >= f_ts and a.scheduled_for < t_ts))
       order by a.scheduled_for asc nulls last, a.id limit lim offset off;
  elsif p_kind = 'sent' then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, a.node_id, null::text, null::text, a.executed_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'sent' and (p_node_id is null or a.node_id = p_node_id)
         and not coalesce((a.payload->>'prefetch')::boolean,false) and not coalesce((a.payload->>'subtask')::boolean,false)
         and (f_ts is null or (a.executed_at >= f_ts and a.executed_at < t_ts))
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
      select e.id, l.id, l.full_name, l.company, e.sender_id, s.display_name, p_node_id, null::text, null::text, fc.accepted_at, false
        from outreach_sequence_lead_facts fc join outreach_enrollments e on e.id = fc.enrollment_id join outreach_leads l on l.id = e.lead_id
        left join outreach_senders s on s.id = e.sender_id
       where fc.sequence_id = p_sequence and fc.accepted_at is not null
         and (f_ts is null or (fc.accepted_at >= f_ts and fc.accepted_at < t_ts))
         and (p_node_id is null or e.current_node_id = any(conn)
              or exists (select 1 from outreach_actions a where a.enrollment_id = e.id and a.node_id = any(conn)))
       order by fc.accepted_at desc, e.id limit lim offset off;
  elsif p_kind = 'replied' and p_node_id is not null then
    return query
      select e.id, l.id, l.full_name, l.company, a.sender_id, s.display_name, p_node_id, null::text,
             nullif(left(btrim(regexp_replace(coalesce(m.text, ''), '\s+', ' ', 'g')), 200), ''), m.sent_at, false
        from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id join outreach_leads l on l.id = e.lead_id
        join outreach_messages m on m.replied_to_action_id = a.id and m.direction = 'in' and m.is_first_reply
        left join outreach_senders s on s.id = a.sender_id
       where e.sequence_id = p_sequence and a.status = 'sent' and a.node_id is not null
         and (f_ts is null or (m.sent_at >= f_ts and m.sent_at < t_ts))
         and (a.node_id = p_node_id
              or ((g->'nodes'->p_node_id->>'type') = 'wait_for_reply'
                  and outreach__next_step_of_type(g, g->'nodes'->a.node_id->>'next', array['wait_for_reply']) = p_node_id))
       order by m.sent_at desc, m.id limit lim offset off;
  elsif p_kind in ('replied', 'interested', 'meetings') then
    -- sequence-wide outcomes: the 089 facts, the same timestamps as the stat cards and the daily chart
    return query
      select e.id, l.id, l.full_name, l.company, e.sender_id, s.display_name, null::text, null::text,
             case when p_kind = 'meetings' then null::text else nullif(left(btrim(regexp_replace(coalesce(m.text, ''), '\s+', ' ', 'g')), 200), '') end,
             case p_kind when 'replied' then fc.replied_at when 'interested' then fc.positive_at else fc.meeting_at end, false
        from outreach_sequence_lead_facts fc join outreach_enrollments e on e.id = fc.enrollment_id join outreach_leads l on l.id = e.lead_id
        left join outreach_senders s on s.id = e.sender_id
        left join outreach_messages m on m.id = fc.reply_message_id
       where fc.sequence_id = p_sequence
         and (case p_kind when 'replied' then fc.replied_at when 'interested' then fc.positive_at else fc.meeting_at end) is not null
         and (f_ts is null or ((case p_kind when 'replied' then fc.replied_at when 'interested' then fc.positive_at else fc.meeting_at end) >= f_ts
                               and (case p_kind when 'replied' then fc.replied_at when 'interested' then fc.positive_at else fc.meeting_at end) < t_ts))
       order by 10 desc, 1 limit lim offset off;
  else
    return query
      select e.id, l.id, l.full_name, l.company, s.id, s.display_name, e.current_node_id, coalesce(fa.error_code, e.exit_reason), outreach_reason_text(coalesce(fa.error_code, e.exit_reason), fa.decision), e.completed_at,
             not (l.do_not_contact or l.unsubscribed) and coalesce(fa.decision,'') <> 'mark_lead_invalid'
        from outreach_enrollments e join outreach_leads l on l.id = e.lead_id join outreach_senders s on s.id = e.sender_id
        left join lateral (select a.error_code, a.decision from outreach_actions a where a.enrollment_id = e.id and a.status = 'failed' order by a.executed_at desc nulls last limit 1) fa on true
       where e.sequence_id = p_sequence and e.status = 'failed' and (p_node_id is null or e.current_node_id = p_node_id)
         and (f_ts is null or (e.completed_at >= f_ts and e.completed_at < t_ts))
       order by e.completed_at desc nulls last limit lim offset off;
  end if;
end $$;
revoke execute on function outreach_failed_leads(uuid, text, text, int, int, date, date) from public, anon;
grant execute on function outreach_failed_leads(uuid, text, text, int, int, date, date) to authenticated, service_role;
