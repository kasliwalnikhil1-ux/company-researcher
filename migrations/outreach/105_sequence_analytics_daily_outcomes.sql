-- 105 — Sequence Analytics: the daily chart carries outcomes (29 Oct 2026).
-- outreach_sequence_analytics (101) returned planned + sent per day. The Analytics tab's "Activity by day" chart now
-- stacks what came back as well, so `daily.days[]` gains accepted, replied, interested and meetings per workspace day,
-- read from outreach_sequence_lead_facts with the stat cards' own timestamps (accepted_at, replied_at, positive_at,
-- meeting_at). Nothing else changes: same signature, same grants, the rest of the payload is byte-for-byte 101's.
-- definitions_version 1 → 2.
-- Idempotent (create or replace). Apply after 104. Smoke: tests/smoke_31_sequence_leads_analytics.sql (5h / 5h2).

create or replace function outreach_sequence_analytics(p_sequence uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; b record; f_ts timestamptz; t_ts timestamptz; z text; f date; t date;
        cards jsonb; progress jsonb; steps jsonb; daily jsonb; senders jsonb; team jsonb; first_run timestamptz; nums jsonb;
        gap_pct numeric; gap_reason text; today date; today_planned int; today_sent int; cap_senders int; off_senders int;
begin
  s := outreach__sequence_access(p_sequence, 'client_viewer');
  select * into b from outreach__stats_cohort_bounds(s.workspace_id, p_from, p_to);
  z := b.z; today := (now() at time zone z)::date;
  -- default: the last 30 days
  t := coalesce(p_to, today);
  f := coalesce(p_from, t - 29);
  if f > t then f := t; end if;
  f_ts := f::timestamp at time zone z; t_ts := (t + 1)::timestamp at time zone z;
  nums := outreach_graph_step_numbers(s.graph);

  select min(at) into first_run from outreach_step_runs where sequence_id = p_sequence;

  -- 1. Stat cards (the 089 facts: the same definitions as the Results funnel and the Sequences list)
  with fct as (select * from outreach_sequence_lead_facts where sequence_id = p_sequence)
  select jsonb_build_object(
    'enrolled',  (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.created_at >= f_ts and e.created_at < t_ts),
    'invites_sent', (select count(*) from fct where invited_at >= f_ts and invited_at < t_ts),
    'accepted',  (select count(*) from fct where accepted_at >= f_ts and accepted_at < t_ts),
    'replied',   (select count(*) from fct where replied_at >= f_ts and replied_at < t_ts),
    'interested',(select count(*) from fct where positive_at >= f_ts and positive_at < t_ts),
    'meetings',  (select count(*) from fct where meeting_at >= f_ts and meeting_at < t_ts),
    'contacted', (select count(*) from fct where first_contacted_at >= f_ts and first_contacted_at < t_ts))
  into cards;
  cards := cards || jsonb_build_object(
    'accepted_rate', outreach__pct((cards->>'accepted')::numeric, (cards->>'invites_sent')::numeric),
    'replied_rate', outreach__pct((cards->>'replied')::numeric, (cards->>'accepted')::numeric),
    'replied_of_contacted_rate', outreach__pct((cards->>'replied')::numeric, (cards->>'contacted')::numeric),
    'interested_rate', outreach__pct((cards->>'interested')::numeric, (cards->>'replied')::numeric));

  -- 2. Lead progress: everyone enrolled in the period, by where they are now (the same groups as the filter)
  select jsonb_build_object(
    'live', count(*) filter (where status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
    'completed', count(*) filter (where status = 'completed'),
    'handoff', count(*) filter (where status = 'exited_replied'),
    'stopped', count(*) filter (where status in ('exited_manual','exited_sender_disabled','exited_suppressed')),
    'failed', count(*) filter (where status = 'failed'),
    'unenrolled', count(*) filter (where status = 'cancelled'),
    'total', count(*))
  into progress from outreach_enrollments where sequence_id = p_sequence and created_at >= f_ts and created_at < t_ts;

  -- 3. Step table (hidden variant column: runs carry variant_id; rows are per step)
  select coalesce(jsonb_agg(jsonb_build_object(
      'node_id', x.key, 'step_number', (nums->>x.key)::int, 'type', x.value->>'type',
      'label', coalesce(x.value->>'label', initcap(replace(x.value->>'type', '_', ' '))),
      'variant_id', null,
      'has_variants', coalesce(jsonb_typeof(x.value->'config'->'variants') = 'array' and jsonb_array_length(x.value->'config'->'variants') > 1, false),
      'sent', coalesce(r.sent, 0), 'accepted', coalesce(r.accepted, 0), 'read', coalesce(r.read, 0), 'replied', coalesce(r.replied, 0), 'skipped', coalesce(r.skipped, 0), 'failed', coalesce(r.failed, 0),
      'accepted_rate', outreach__pct(coalesce(r.accepted, 0), coalesce(r.sent, 0)), 'read_rate', outreach__pct(coalesce(r.read, 0), coalesce(r.sent, 0)),
      'replied_rate', outreach__pct(coalesce(r.replied, 0), coalesce(r.sent, 0)), 'skipped_rate', outreach__pct(coalesce(r.skipped, 0), coalesce(r.sent, 0) + coalesce(r.skipped, 0) + coalesce(r.failed, 0)),
      'failed_rate', outreach__pct(coalesce(r.failed, 0), coalesce(r.sent, 0) + coalesce(r.skipped, 0) + coalesce(r.failed, 0)),
      'leads_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')))
      order by (nums->>x.key)::int nulls last, x.key), '[]'::jsonb)
    into steps
    from jsonb_each(s.graph->'nodes') x
    left join (select node_id, count(*) filter (where outcome = 'sent') as sent, count(*) filter (where outcome = 'accepted') as accepted, count(*) filter (where outcome = 'read') as read,
                      count(*) filter (where outcome = 'replied') as replied, count(*) filter (where outcome = 'skipped') as skipped, count(*) filter (where outcome = 'failed') as failed
                 from outreach_step_runs where sequence_id = p_sequence and at >= f_ts and at < t_ts group by node_id) r on r.node_id = x.key
   where outreach_is_executable_node(x.value->>'type') or (x.value->>'type') in ('manual_task','call_task','ai_draft_approval');

  -- 4. Activity by day: what the engine had planned (snapshot where there is one, else the actions scheduled that day),
  --    what went out, and what came back that day (accepted / replied / interested / meetings from the 089 facts, the
  --    same timestamps as the stat cards, so the days of the chart add up to the cards over the same window).
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'planned', coalesce(p.planned, q.planned, 0), 'sent', coalesce(sn.sent, 0), 'snapshot', p.planned is not null,
                                               'accepted', coalesce(oc.accepted, 0), 'replied', coalesce(oc.replied, 0), 'interested', coalesce(oc.interested, 0), 'meetings', coalesce(oc.meetings, 0)) order by d.day), '[]'::jsonb)
    into daily
    from (select g::date as day from generate_series(f, t, interval '1 day') g) d
    left join (select day, count(*) filter (where kind = 'accepted')::int as accepted, count(*) filter (where kind = 'replied')::int as replied,
                      count(*) filter (where kind = 'interested')::int as interested, count(*) filter (where kind = 'meetings')::int as meetings
                 from (select (fc.accepted_at at time zone z)::date as day, 'accepted' as kind from outreach_sequence_lead_facts fc where fc.sequence_id = p_sequence and fc.accepted_at >= f_ts and fc.accepted_at < t_ts
                       union all select (fc.replied_at at time zone z)::date, 'replied' from outreach_sequence_lead_facts fc where fc.sequence_id = p_sequence and fc.replied_at >= f_ts and fc.replied_at < t_ts
                       union all select (fc.positive_at at time zone z)::date, 'interested' from outreach_sequence_lead_facts fc where fc.sequence_id = p_sequence and fc.positive_at >= f_ts and fc.positive_at < t_ts
                       union all select (fc.meeting_at at time zone z)::date, 'meetings' from outreach_sequence_lead_facts fc where fc.sequence_id = p_sequence and fc.meeting_at >= f_ts and fc.meeting_at < t_ts) ev
                group by day) oc on oc.day = d.day
    left join (select day, sum(planned)::int as planned from outreach_sequence_daily_plan where sequence_id = p_sequence group by day) p on p.day = d.day
    left join (select (a.scheduled_for at time zone z)::date as day, count(*)::int as planned from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
                where e.sequence_id = p_sequence and a.scheduled_for >= f_ts and a.scheduled_for < t_ts and a.status in ('queued','reserved','sent','skipped','failed')
                  and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false) group by 1) q on q.day = d.day
    left join (select (at at time zone z)::date as day, count(*)::int as sent from outreach_step_runs where sequence_id = p_sequence and outcome = 'sent' and at >= f_ts and at < t_ts group by 1) sn on sn.day = d.day;
  -- today's gap and its reason
  select (x->>'planned')::int, (x->>'sent')::int into today_planned, today_sent from jsonb_array_elements(daily) x where (x->>'day')::date = today;
  gap_pct := case when coalesce(today_planned, 0) = 0 then null else round((today_planned - coalesce(today_sent, 0)) * 100.0 / today_planned, 1) end;
  if gap_pct is not null and gap_pct > 20 then
    select count(distinct a.sender_id) into cap_senders from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
     where e.sequence_id = p_sequence and a.created_at >= now() - interval '1 day' and a.decision in ('sender_cap_hit','sender_cap_hit_cascade','budget_deferred','hourly_deferred');
    select count(*) into off_senders from outreach_senders sd where sd.id = any(s.sender_pool) and sd.status <> 'ok';
    gap_reason := case
      when s.status = 'paused' then 'The sequence is paused'
      when cap_senders > 0 then cap_senders || ' sender' || case when cap_senders = 1 then '' else 's' end || ' hit ' || case when cap_senders = 1 then 'its' else 'their' end || ' daily limit'
      when off_senders > 0 then off_senders || ' sender' || case when off_senders = 1 then ' is' else 's are' end || ' not connected'
      when (now() at time zone z)::time < time '18:00' then 'The day is not over: sends continue in each sender''s working hours'
      else 'Sends were held back by the senders'' schedules' end;
  end if;

  -- 5. Sender accounts: the pool plus any sender that ran a step in the period
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', sd.id, 'name', coalesce(sd.display_name, sd.owner_email, 'Sender'), 'provider', sd.provider, 'status', sd.status, 'status_reason', sd.status_reason, 'in_pool', sd.id = any(s.sender_pool),
      'sent', coalesce(r.sent, 0), 'invites', coalesce(r.invites, 0), 'accepted', coalesce(r.accepted, 0), 'replied', coalesce(r.replied, 0), 'failed', coalesce(r.failed, 0),
      'accepted_rate', outreach__pct(coalesce(r.accepted, 0), coalesce(r.invites, 0)), 'replied_rate', outreach__pct(coalesce(r.replied, 0), coalesce(r.touches, 0)),
      'limited', exists (select 1 from outreach_sender_budgets bg where bg.sender_id = sd.id and bg.day = today and bg.used + bg.reserved >= bg.cap and bg.action_type in ('invite','message')),
      'live', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.sender_id = sd.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')))
      order by coalesce(r.sent, 0) desc, sd.display_name), '[]'::jsonb)
    into senders
    from outreach_senders sd
    left join (select sr.sender_id, count(*) filter (where outcome = 'sent') as sent,
                      count(*) filter (where outcome = 'sent' and a.action_type in ('invite','follow')) as invites,
                      count(*) filter (where outcome = 'sent' and a.action_type in ('invite','message','inmail','email','new_chat')) as touches,
                      count(*) filter (where outcome = 'accepted') as accepted, count(*) filter (where outcome = 'replied') as replied, count(*) filter (where outcome = 'failed') as failed
                 from outreach_step_runs sr left join outreach_actions a on a.id = sr.action_id
                where sr.sequence_id = p_sequence and sr.at >= f_ts and sr.at < t_ts group by sr.sender_id) r on r.sender_id = sd.id
   where sd.workspace_id = s.workspace_id and (sd.id = any(s.sender_pool) or r.sender_id is not null);

  -- 6. Team: handoffs taken (a teammate wrote to a handed-off lead), stops and unenrolls by hand (the status log)
  with handoffs as (
    select e.id as enrollment_id, m.sent_by as user_id, min(m.sent_at) as at
      from outreach_enrollments e join outreach_chats c on c.lead_id = e.lead_id and c.sender_id = e.sender_id
      join outreach_messages m on m.chat_id = c.id and m.direction = 'out' and m.sent_by is not null and m.deleted_at is null and m.sent_at >= e.completed_at
     where e.sequence_id = p_sequence and e.status = 'exited_replied' and e.completed_at >= f_ts and e.completed_at < t_ts
     group by 1, 2),
  logs as (
    select actor as user_id, count(*) filter (where new_status = 'exited_manual') as stopped, count(*) filter (where new_status = 'cancelled' and reason = 'unenrolled') as unenrolled
      from outreach_enrollment_status_log where sequence_id = p_sequence and actor_type = 'user' and at >= f_ts and at < t_ts group by actor),
  people as (select user_id from handoffs union select user_id from logs)
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', coalesce(mem.display_name, mem.email::text, outreach_user_email(p.user_id), 'Former teammate'),
           'handoffs_taken', (select count(distinct h.enrollment_id) from handoffs h where h.user_id = p.user_id),
           'stopped', coalesce(l.stopped, 0), 'unenrolled', coalesce(l.unenrolled, 0))
           order by (select count(*) from handoffs h where h.user_id = p.user_id) + coalesce(l.stopped, 0) + coalesce(l.unenrolled, 0) desc), '[]'::jsonb)
    into team
    from people p left join logs l on l.user_id = p.user_id left join outreach_members mem on mem.workspace_id = s.workspace_id and mem.user_id = p.user_id
   where p.user_id is not null;

  return jsonb_build_object(
    'sequence', jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'head_version', s.head_version),
    'period', jsonb_build_object('from', f, 'to', t, 'timezone', z, 'default', p_from is null and p_to is null),
    'first_run_at', first_run, 'empty', first_run is null,
    'cards', cards, 'progress', progress, 'steps', steps,
    'daily', jsonb_build_object('days', daily, 'today', today, 'today_planned', coalesce(today_planned, 0), 'today_sent', coalesce(today_sent, 0), 'gap_pct', gap_pct, 'gap_reason', gap_reason),
    'senders', senders, 'team', team,
    'handoffs_untaken', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.status = 'exited_replied' and e.completed_at >= f_ts and e.completed_at < t_ts
                            and not exists (select 1 from outreach_chats c join outreach_messages m on m.chat_id = c.id where c.lead_id = e.lead_id and c.sender_id = e.sender_id and m.direction = 'out' and m.sent_by is not null and m.sent_at >= e.completed_at)),
    'definitions_version', 2);
end $$;
grant execute on function outreach_sequence_analytics(uuid, date, date) to authenticated;
