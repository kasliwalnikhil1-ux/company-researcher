-- =============================================================================
-- Outreach Platform — 013 one source of numbers (item 2), reports (item 10), A/B results (item 11),
-- sender insights (item 12), stall / running-dry diagnosis (item 3), dashboard on top of the same facts.
--
-- Every metric is defined ONCE, in outreach__facts(). Dashboard, client page, reports page, connector
-- tools and the public API all read totals built from it, so their numbers cannot disagree.
-- Metric definitions are documented in docs/outreach/SQL-REFERENCE.md and returned by outreach_metric_definitions().
--
-- Days are calendar days in the WORKSPACE timezone (settings.timezone, default UTC). Ranges are inclusive dates.
-- outreach_actions-derived volume is immutable once executed, so it is rolled up nightly into
-- outreach_daily_stats (today is read live). Replies, intents, acceptances, milestones are small and
-- mutable (intent overrides), so they are always read live — that is what keeps the intent breakdown
-- equal to the inbox for the same range.
-- =============================================================================

create table if not exists outreach_rollup_state (
  workspace_id   uuid primary key references outreach_workspaces(id) on delete cascade,
  rolled_through date,
  updated_at     timestamptz not null default now()
);
alter table outreach_rollup_state enable row level security;

-- Role / client visibility, now aware of two more callers:
--   * the service role (workers, cron) sees everything, as RLS already lets it;
--   * a public-API key (item 21) acts as its member but never above the key's own role / client scope.
--     outreach_api_dispatch() sets outreach.key_role / outreach.key_clients for the duration of one call.
create or replace function outreach_role_in(ws uuid) returns outreach_role_t
language sql stable security definer set search_path = public, extensions as $$
  select case when nullif(current_setting('outreach.key_role', true), '') is null then m.role
              else greatest(m.role, current_setting('outreach.key_role', true)::outreach_role_t) end   -- enum order: owner < manager < member < client_viewer
    from outreach_members m where m.user_id = auth.uid() and m.workspace_id = ws
$$;

create or replace function outreach_client_visible(ws uuid, cid uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select outreach_is_service() or exists (
    select 1 from outreach_members m
     where m.user_id = auth.uid() and m.workspace_id = ws
       and (outreach_role_in(ws) in ('owner','manager') or cid is null or cid = any(m.client_ids))
       and (nullif(current_setting('outreach.key_clients', true), '') is null or cid is null
            or cid = any(string_to_array(current_setting('outreach.key_clients', true), ',')::uuid[])))
$$;

create or replace function outreach_ws_tz(p_ws uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select case when exists (select 1 from pg_timezone_names n where n.name = w.settings->>'timezone') then w.settings->>'timezone' end
                     from outreach_workspaces w where w.id = p_ws), 'UTC')
$$;

-- clients the caller may see: null = all of them
create or replace function outreach_visible_clients(p_ws uuid) returns uuid[]
language plpgsql stable security definer set search_path = public, extensions as $$
declare m outreach_members%rowtype; key_clients text;
begin
  if outreach_is_service() then return null; end if;
  select * into m from outreach_members where workspace_id = p_ws and user_id = auth.uid();
  if not found then return '{}'; end if;
  key_clients := nullif(current_setting('outreach.key_clients', true), '');
  if key_clients is not null then return string_to_array(key_clients, ',')::uuid[]; end if;
  if m.role in ('owner','manager') then return null; end if;
  return m.client_ids;   -- same rule as outreach_client_visible(): rows without a client are visible to everyone
end $$;

-- -----------------------------------------------------------------------------
-- Action volume, live (long format). The rollup stores exactly this output.
-- -----------------------------------------------------------------------------
create or replace function outreach__action_facts_live(p_ws uuid, p_from date, p_to date)
returns table(day date, client_id uuid, sequence_id uuid, node_id text, variant_id text, sender_id uuid, channel text, metric text, n numeric)
language sql stable security definer set search_path = public, extensions as $$
  with tz as (select outreach_ws_tz(p_ws) z),
  a as (
    select (x.executed_at at time zone (select z from tz))::date as day, coalesce(q.client_id, s.client_id) as client_id, e.sequence_id, x.node_id, x.variant_id, x.sender_id,
           case when x.action_type = 'email' then 'email' else 'linkedin' end as channel, x.action_type, x.status, x.payload, x.response
      from outreach_actions x
      join outreach_senders s on s.id = x.sender_id
      left join outreach_enrollments e on e.id = x.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
     where x.workspace_id = p_ws and x.executed_at is not null
       and x.executed_at >= (p_from::timestamp at time zone (select z from tz)) and x.executed_at < ((p_to + 1)::timestamp at time zone (select z from tz))
       and x.status in ('sent','failed','skipped')
  )
  select day, client_id, sequence_id, node_id, variant_id, sender_id, channel,
         case when status <> 'sent' then status::text when action_type = 'reply' then 'manual_reply' else action_type::text end, count(*)::numeric
    from a where not (status <> 'sent' and (coalesce((payload->>'prefetch')::boolean,false) or coalesce((payload->>'subtask')::boolean,false)))
   group by 1,2,3,4,5,6,7,8
  union all
  select day, client_id, sequence_id, node_id, variant_id, sender_id, channel, 'invite_with_note', count(*)::numeric
    from a where status = 'sent' and action_type = 'invite' and coalesce((response->>'note_length')::int, 0) > 0
   group by 1,2,3,4,5,6,7
$$;
revoke execute on function outreach__action_facts_live(uuid,date,date) from public, anon, authenticated;

create or replace function outreach_rollup_daily(p_ws uuid, p_from date, p_to date) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare cnt int; today date := (now() at time zone outreach_ws_tz(p_ws))::date; upto date := least(p_to, today - 1);
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if upto < p_from then return 0; end if;
  delete from outreach_daily_stats where workspace_id = p_ws and day between p_from and upto;
  insert into outreach_daily_stats(workspace_id, day, client_id, sequence_id, node_id, variant_id, sender_id, channel, metrics)
  select p_ws, f.day, coalesce(f.client_id, '00000000-0000-0000-0000-000000000000'), coalesce(f.sequence_id, '00000000-0000-0000-0000-000000000000'),
         coalesce(f.node_id,''), coalesce(f.variant_id,''), f.sender_id, f.channel, jsonb_object_agg(f.metric, f.n)
    from outreach__action_facts_live(p_ws, p_from, upto) f group by 2,3,4,5,6,7,8;
  get diagnostics cnt = row_count;
  insert into outreach_rollup_state(workspace_id, rolled_through) values (p_ws, upto)
  on conflict (workspace_id) do update set rolled_through = greatest(coalesce(outreach_rollup_state.rolled_through, excluded.rolled_through), excluded.rolled_through), updated_at = now();
  return cnt;
end $$;
revoke execute on function outreach_rollup_daily(uuid,date,date) from public, anon, authenticated;

-- nightly: every workspace, trailing 35 days (cheap, and heals any late-settled action)
create or replace function outreach_rollup_all() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare w record; total int := 0; today date;
begin
  for w in select id from outreach_workspaces where deleted_at is null loop
    today := (now() at time zone outreach_ws_tz(w.id))::date;
    total := total + outreach_rollup_daily(w.id, today - 35, today - 1);
  end loop;
  delete from outreach_daily_stats where day < current_date - 800;
  return total;
end $$;
revoke execute on function outreach_rollup_all() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- THE definition of every metric
-- -----------------------------------------------------------------------------
create or replace function outreach__facts(p_ws uuid, p_from date, p_to date)
returns table(day date, client_id uuid, sequence_id uuid, node_id text, variant_id text, sender_id uuid, channel text, metric text, n numeric)
language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); rt date; f_ts timestamptz; t_ts timestamptz; zero uuid := '00000000-0000-0000-0000-000000000000';
begin
  f_ts := p_from::timestamp at time zone z; t_ts := (p_to + 1)::timestamp at time zone z;
  select rolled_through into rt from outreach_rollup_state where workspace_id = p_ws;

  -- 1. action volume: rollup up to rolled_through, live after it
  if rt is not null and rt >= p_from then
    return query
      select d.day, nullif(d.client_id, zero), nullif(d.sequence_id, zero), nullif(d.node_id,''), nullif(d.variant_id,''), d.sender_id, d.channel, m.key, (m.value)::numeric
        from outreach_daily_stats d, jsonb_each_text(d.metrics) m
       where d.workspace_id = p_ws and d.day between p_from and least(p_to, rt);
  end if;
  if rt is null or rt < p_to then
    return query select * from outreach__action_facts_live(p_ws, greatest(p_from, coalesce(rt + 1, p_from)), p_to);
  end if;

  -- 2. accepted: dated by acceptance, attributed to the invite that was accepted
  return query
    select (x.invite_accepted_at at time zone z)::date, coalesce(q.client_id, s.client_id), e.sequence_id, ia.node_id, ia.variant_id, x.sender_id, 'linkedin'::text, 'accepted'::text, count(*)::numeric
      from outreach_lead_sender_state x
      join outreach_senders s on s.id = x.sender_id and s.workspace_id = p_ws
      left join lateral (select a.node_id, a.variant_id, a.enrollment_id from outreach_actions a
                          where a.lead_id = x.lead_id and a.sender_id = x.sender_id and a.action_type = 'invite' and a.status = 'sent' and a.executed_at <= x.invite_accepted_at
                          order by a.executed_at desc limit 1) ia on true
      left join outreach_enrollments e on e.id = ia.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
     where x.invite_accepted_at >= f_ts and x.invite_accepted_at < t_ts and x.invite_sent_at is not null
     group by 1,2,3,4,5,6;

  -- 3. replies: a thread's FIRST reply to an automated step, dated by that reply, classified by the thread's current intent
  return query
    select (m.sent_at at time zone z)::date, coalesce(q.client_id, c.client_id), e.sequence_id, a.node_id, a.variant_id, c.sender_id,
           case when c.provider = 'LINKEDIN' then 'linkedin' else 'email' end, k.metric, count(*)::numeric
      from outreach_messages m
      join outreach_chats c on c.id = m.chat_id
      join outreach_actions a on a.id = m.replied_to_action_id
      left join outreach_enrollments e on e.id = a.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
      cross join lateral (values ('reply'), ('reply_' || (case when c.intent <> 'unclassified' then c.intent else coalesce(m.intent, 'unclassified') end)::text)) k(metric)
     where m.workspace_id = p_ws and m.is_first_reply and m.sent_at >= f_ts and m.sent_at < t_ts
     group by 1,2,3,4,5,6,7,8;

  -- 4. every inbound message (conversation volume; not a rate numerator)
  return query
    select (m.sent_at at time zone z)::date, c.client_id, null::uuid, null::text, null::text, c.sender_id,
           case when c.provider = 'LINKEDIN' then 'linkedin' else 'email' end, 'inbound'::text, count(*)::numeric
      from outreach_messages m join outreach_chats c on c.id = m.chat_id
     where m.workspace_id = p_ws and m.direction = 'in' and m.sent_at >= f_ts and m.sent_at < t_ts
     group by 1,2,6,7;

  -- 5. enrolled
  return query
    select (e.created_at at time zone z)::date, q.client_id, e.sequence_id, null::text, null::text, e.sender_id, 'linkedin'::text, 'enrolled'::text, count(*)::numeric
      from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id
     where e.workspace_id = p_ws and e.created_at >= f_ts and e.created_at < t_ts
     group by 1,2,3,6;

  -- 6. milestones (meeting booked, won, lost) and won value
  return query
    select (ms.at at time zone z)::date, ms.client_id, ms.sequence_id, null::text, null::text, ms.sender_id, 'linkedin'::text, k.metric, sum(k.v)::numeric
      from outreach_lead_milestones ms
      cross join lateral (values (ms.kind, 1::numeric), (case when ms.kind = 'won' and ms.value is not null then 'won_value' end, ms.value)) k(metric, v)
     where ms.workspace_id = p_ws and ms.at >= f_ts and ms.at < t_ts and ms.kind in ('meeting','won','lost') and k.metric is not null
     group by 1,2,3,6,8;

  -- 7. email engagement
  return query
    select (m.sent_at at time zone z)::date, c.client_id, e.sequence_id, a.node_id, a.variant_id, c.sender_id, 'email'::text, k.metric, count(*)::numeric
      from outreach_messages m join outreach_chats c on c.id = m.chat_id and c.provider <> 'LINKEDIN'
      left join outreach_actions a on a.id = m.action_id left join outreach_enrollments e on e.id = a.enrollment_id
      cross join lateral (values (case when m.opens > 0 then 'email_opened' end), (case when m.clicks > 0 then 'email_clicked' end)) k(metric)
     where m.workspace_id = p_ws and m.direction = 'out' and m.sent_at >= f_ts and m.sent_at < t_ts and k.metric is not null
     group by 1,2,3,4,5,6,8;
  return query
    select (x.updated_at at time zone z)::date, s.client_id, null::uuid, null::text, null::text, x.sender_id, 'email'::text, 'email_bounced'::text, count(*)::numeric
      from outreach_lead_sender_state x join outreach_senders s on s.id = x.sender_id and s.workspace_id = p_ws
     where x.email_bounced and x.updated_at >= f_ts and x.updated_at < t_ts group by 1,2,6;

  -- 8. LinkedIn limit hits
  return query
    select (ev.at at time zone z)::date, s.client_id, null::uuid, null::text, null::text, ev.sender_id, 'linkedin'::text, 'limit_hit'::text, count(*)::numeric
      from outreach_sender_events ev join outreach_senders s on s.id = ev.sender_id and s.workspace_id = p_ws
     where ev.kind = 'reject' and (ev.data->>'decision' = 'sender_cap_hit' or coalesce((ev.data->>'limit_hit')::boolean, false)) and ev.at >= f_ts and ev.at < t_ts
     group by 1,2,6;
end $$;
revoke execute on function outreach__facts(uuid,date,date) from public, anon, authenticated;

-- Totals and rates from a set of facts. The formulas live here and nowhere else.
create or replace function outreach__rate(p_num numeric, p_den numeric) returns numeric
language sql immutable as $$ select case when coalesce(p_den,0) > 0 then round(100.0 * coalesce(p_num,0) / p_den, 1) end $$;

create or replace function outreach__totals_from(p_m jsonb) returns jsonb
language sql immutable as $$
  with v as (select
    coalesce((p_m->>'invite')::numeric,0) invites, coalesce((p_m->>'invite_with_note')::numeric,0) notes, coalesce((p_m->>'accepted')::numeric,0) accepted,
    coalesce((p_m->>'message')::numeric,0) messages, coalesce((p_m->>'inmail')::numeric,0) inmails, coalesce((p_m->>'email')::numeric,0) emails,
    coalesce((p_m->>'reply')::numeric,0) replies, coalesce((p_m->>'reply_interested')::numeric,0) interested, coalesce((p_m->>'reply_not_interested')::numeric,0) not_interested,
    coalesce((p_m->>'reply_ooo')::numeric,0) ooo)
  select jsonb_build_object(
    'enrolled', coalesce((p_m->>'enrolled')::numeric,0),
    'invites', invites, 'invites_with_note', notes, 'accepted', accepted, 'acceptance_rate', outreach__rate(accepted, invites),
    'messages', messages, 'inmails', inmails, 'emails', emails, 'touches', messages + inmails + emails + notes,
    'replies', replies, 'reply_rate', outreach__rate(replies, messages + inmails + emails + notes),
    'interested', interested, 'interested_rate', outreach__rate(interested, messages + inmails + emails + notes),
    'positive_reply_rate', outreach__rate(interested, replies - ooo), 'negative_reply_rate', outreach__rate(not_interested, replies - ooo),
    'intents', jsonb_build_object('interested', interested, 'question', coalesce((p_m->>'reply_question')::numeric,0), 'not_now', coalesce((p_m->>'reply_not_now')::numeric,0),
               'not_interested', not_interested, 'ooo', ooo, 'wrong_person', coalesce((p_m->>'reply_wrong_person')::numeric,0),
               'unclear', coalesce((p_m->>'reply_unclear')::numeric,0), 'unclassified', coalesce((p_m->>'reply_unclassified')::numeric,0)),
    'meetings', coalesce((p_m->>'meeting')::numeric,0), 'won', coalesce((p_m->>'won')::numeric,0), 'lost', coalesce((p_m->>'lost')::numeric,0), 'won_value', coalesce((p_m->>'won_value')::numeric,0),
    'inbound_messages', coalesce((p_m->>'inbound')::numeric,0), 'manual_replies', coalesce((p_m->>'manual_reply')::numeric,0),
    'profile_views', coalesce((p_m->>'profile_view')::numeric,0), 'likes', coalesce((p_m->>'like')::numeric,0), 'comments', coalesce((p_m->>'comment')::numeric,0),
    'endorsements', coalesce((p_m->>'endorse')::numeric,0), 'follows', coalesce((p_m->>'follow')::numeric,0), 'withdrawn', coalesce((p_m->>'withdraw')::numeric,0),
    'post_fetches', coalesce((p_m->>'post_fetch')::numeric,0),
    'failed', coalesce((p_m->>'failed')::numeric,0), 'skipped', coalesce((p_m->>'skipped')::numeric,0), 'limit_hits', coalesce((p_m->>'limit_hit')::numeric,0),
    'email_opened', coalesce((p_m->>'email_opened')::numeric,0), 'email_clicked', coalesce((p_m->>'email_clicked')::numeric,0), 'email_bounced', coalesce((p_m->>'email_bounced')::numeric,0),
    'open_rate', outreach__rate((p_m->>'email_opened')::numeric, emails), 'click_rate', outreach__rate((p_m->>'email_clicked')::numeric, emails), 'bounce_rate', outreach__rate((p_m->>'email_bounced')::numeric, emails))
  from v
$$;

-- Generic grouped totals. p_group: none | day | channel | sequence | node | variant | sender | client
-- p_filters: {sequence_id, sender_id, node_id, channel}
create or replace function outreach__grouped(p_ws uuid, p_client uuid, p_from date, p_to date, p_group text, p_filters jsonb default '{}')
returns table(grp text, totals jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare vis uuid[] := outreach_visible_clients(p_ws);
begin
  return query
    with f as (
      select case p_group when 'day' then x.day::text when 'channel' then x.channel when 'sequence' then x.sequence_id::text when 'node' then x.sequence_id::text || '|' || x.node_id
                          when 'variant' then x.sequence_id::text || '|' || x.node_id || '|' || coalesce(x.variant_id,'') when 'sender' then x.sender_id::text when 'client' then x.client_id::text else 'all' end as g,
             x.metric, x.n
        from outreach__facts(p_ws, p_from, p_to) x
       where (p_client is null or x.client_id = p_client)
         and (vis is null or x.client_id is null or x.client_id = any(vis))
         and ((p_filters->>'sequence_id') is null or x.sequence_id = (p_filters->>'sequence_id')::uuid)
         and ((p_filters->>'sender_id') is null or x.sender_id = (p_filters->>'sender_id')::uuid)
         and ((p_filters->>'node_id') is null or x.node_id = p_filters->>'node_id')
         and ((p_filters->>'channel') is null or x.channel = p_filters->>'channel')),
    m as (select g, metric, sum(n) n from f group by g, metric)
    select m.g, outreach__totals_from(jsonb_object_agg(m.metric, m.n)) from m where m.g is not null group by m.g;
end $$;
revoke execute on function outreach__grouped(uuid,uuid,date,date,text,jsonb) from public, anon, authenticated;

create or replace function outreach__check_range(p_ws uuid, p_client uuid, p_from date, p_to date) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_client is not null and not outreach_client_visible(p_ws, p_client) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'E_PAYLOAD_INVALID: from/to must be dates with from <= to'; end if;
  if p_to - p_from > 731 then raise exception 'E_PAYLOAD_INVALID: range is limited to 2 years'; end if;
end $$;

create or replace function outreach_metric_definitions() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'day', 'A calendar day in the workspace timezone (Settings → Workspace). Ranges include both end dates.',
    'invites', 'Connection requests LinkedIn accepted for delivery in the period.',
    'accepted', 'Invitations accepted in the period, whenever they were sent. Attributed to the step and variant that sent the invitation.',
    'acceptance_rate', 'Accepted ÷ invites sent, both in the period.',
    'touches', 'Messages + InMails + emails + invitations that carried a note. The denominator of every reply rate.',
    'replies', 'Threads in which the lead answered an automated step for the first time in the period. One lead answering three times is one reply. Replies to a teammate''s manual message are conversation, not replies.',
    'reply_rate', 'Replies ÷ touches.',
    'interested', 'Replies whose thread is currently classified "interested" (AI classification, or your override).',
    'positive_reply_rate', 'Interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'negative_reply_rate', 'Not-interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'meetings', 'Leads that reached a Meeting stage or booked through the booking link in the period. Counted once per lead.',
    'won', 'Leads that reached a Won stage in the period. Counted once per lead.',
    'cost_per_reply', 'Sender cost for the period ÷ replies. Sender cost = monthly cost × days in period ÷ 30 for every sender that was connected.',
    'funnel', 'Follows the leads ENROLLED in the period through every later stage, whenever that stage happened.',
    'headroom', 'Share of the invitation cap a sender did not use over the last 30 days.')
$$;

-- -----------------------------------------------------------------------------
-- Public report functions (dashboard, reports page, connector, API all call these)
-- -----------------------------------------------------------------------------
create or replace function outreach_report_overview(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_filters jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; span int; cur jsonb; prev jsonb; series jsonb; chan jsonb;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 6);
  perform outreach__check_range(p_ws, p_client, f, t);
  span := t - f + 1;
  select totals into cur from outreach__grouped(p_ws, p_client, f, t, 'none', p_filters);
  select totals into prev from outreach__grouped(p_ws, p_client, f - span, f - 1, 'none', p_filters);
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day) || coalesce(g.totals, outreach__totals_from('{}'::jsonb)) order by d.day), '[]'::jsonb) into series
    from (select generate_series(f, t, interval '1 day')::date as day) d
    left join outreach__grouped(p_ws, p_client, f, t, 'day', p_filters) g on g.grp = d.day::text;
  select coalesce(jsonb_object_agg(g.grp, g.totals), '{}'::jsonb) into chan from outreach__grouped(p_ws, p_client, f, t, 'channel', p_filters) g;
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'days', span, 'timezone', z, 'previous_from', f - span, 'previous_to', f - 1),
    'totals', coalesce(cur, outreach__totals_from('{}'::jsonb)), 'previous', coalesce(prev, outreach__totals_from('{}'::jsonb)),
    'by_channel', chan, 'series', series);
end $$;

create or replace function outreach_report_sequences(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws);
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  return (select coalesce(jsonb_agg(jsonb_build_object('sequence_id', q.id, 'name', q.name, 'status', q.status, 'client_id', q.client_id, 'stalled', q.stalled_at is not null, 'stalled_reason', q.stalled_reason,
             'live', (select count(*) from outreach_enrollments e where e.sequence_id = q.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
             'failed_leads', (select count(*) from outreach_enrollments e where e.sequence_id = q.id and e.status = 'failed'),
             'has_ab_test', q.graph::text like '%"variants"%' or q.graph::text like '%"ab_split"%',
             'totals', coalesce(g.totals, outreach__totals_from('{}'::jsonb))) order by coalesce((g.totals->>'replies')::numeric,0) desc, q.name), '[]'::jsonb)
            from outreach_sequences q left join outreach__grouped(p_ws, p_client, f, t, 'sequence', '{}') g on g.grp = q.id::text
           where q.workspace_id = p_ws and q.status <> 'archived' and (p_client is null or q.client_id = p_client) and (vis is null or q.client_id is null or q.client_id = any(vis)));
end $$;

create or replace function outreach_report_senders(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws);
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  return (select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'client_id', s.client_id,
             'health', s.health_score, 'level', s.warmup_level, 'paused_until', s.paused_until, 'invite_blocked_until', s.invite_blocked_until, 'running_dry', s.running_dry_at is not null,
             'totals', coalesce(g.totals, outreach__totals_from('{}'::jsonb))) order by coalesce((g.totals->>'replies')::numeric,0) desc, s.display_name), '[]'::jsonb)
            from outreach_senders s left join outreach__grouped(p_ws, p_client, f, t, 'sender', '{}') g on g.grp = s.id::text
           where s.workspace_id = p_ws and s.deleted_at is null and (p_client is null or s.client_id = p_client) and (vis is null or s.client_id is null or s.client_id = any(vis)));
end $$;

create or replace function outreach_report_clients(p_ws uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws);
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, null, f, t);
  return (select coalesce(jsonb_agg(jsonb_build_object('client_id', c.id, 'name', c.name,
             'senders', (select count(*) from outreach_senders s where s.client_id = c.id and s.deleted_at is null),
             'leads', (select count(*) from outreach_leads l where l.client_id = c.id),
             'live', (select count(*) from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id where q.client_id = c.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task')),
             'totals', coalesce(g.totals, outreach__totals_from('{}'::jsonb))) order by c.name), '[]'::jsonb)
            from outreach_clients c left join outreach__grouped(p_ws, null, f, t, 'client', '{}') g on g.grp = c.id::text
           where c.workspace_id = p_ws and (vis is null or c.id = any(vis)));
end $$;

-- one client, the same shape as the overview (client portal + branded reports)
create or replace function outreach_report_client(p_client uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_clients%rowtype; o jsonb;
begin
  select * into c from outreach_clients where id = p_client;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  o := outreach_report_overview(c.workspace_id, p_client, p_from, p_to, '{}');
  return o || jsonb_build_object('client', jsonb_build_object('id', c.id, 'name', c.name),
    'leads', (select count(*) from outreach_leads l where l.client_id = p_client),
    'senders', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'status', s.status, 'health', s.health_score) order by s.display_name), '[]'::jsonb) from outreach_senders s where s.client_id = p_client and s.deleted_at is null),
    'live_enrollments', (select count(*) from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id where q.client_id = p_client and e.status in ('active','waiting_connection','waiting_delay','waiting_task')));
end $$;

-- Replies tab: breakdown by intent over time / sequence / step / sender / variant
create or replace function outreach_report_intents(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_group text default 'day', p_filters jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; tot jsonb; rows_ jsonb; gk text;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  gk := case p_group when 'step' then 'node' when 'node' then 'node' when 'sequence' then 'sequence' when 'sender' then 'sender' when 'variant' then 'variant' when 'channel' then 'channel' else 'day' end;
  select totals into tot from outreach__grouped(p_ws, p_client, f, t, 'none', p_filters);
  select coalesce(jsonb_agg(jsonb_build_object('key', g.grp,
           'label', case gk when 'sequence' then (select name from outreach_sequences where id::text = g.grp)
                             when 'sender' then (select display_name from outreach_senders where id::text = g.grp)
                             when 'node' then (select q.name || ' · ' || coalesce(q.graph->'nodes'->split_part(g.grp,'|',2)->>'label', split_part(g.grp,'|',2)) from outreach_sequences q where q.id::text = split_part(g.grp,'|',1))
                             when 'variant' then (select q.name || ' · ' || coalesce(q.graph->'nodes'->split_part(g.grp,'|',2)->>'label', split_part(g.grp,'|',2)) || ' · ' || coalesce(nullif(split_part(g.grp,'|',3),''),'no variant') from outreach_sequences q where q.id::text = split_part(g.grp,'|',1))
                             else g.grp end,
           'sequence_id', case when gk in ('node','variant') then split_part(g.grp,'|',1) when gk = 'sequence' then g.grp end,
           'node_id', case when gk in ('node','variant') then split_part(g.grp,'|',2) end,
           'variant_id', case when gk = 'variant' then split_part(g.grp,'|',3) end,
           'replies', g.totals->'replies', 'touches', g.totals->'touches', 'reply_rate', g.totals->'reply_rate', 'intents', g.totals->'intents',
           'positive_reply_rate', g.totals->'positive_reply_rate', 'negative_reply_rate', g.totals->'negative_reply_rate') order by g.grp), '[]'::jsonb)
    into rows_ from outreach__grouped(p_ws, p_client, f, t, gk, p_filters) g where (g.totals->>'replies')::numeric > 0 or gk = 'day';
  tot := coalesce(tot, outreach__totals_from('{}'::jsonb));
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'group', gk,
    'replies', tot->'replies', 'touches', tot->'touches', 'reply_rate', tot->'reply_rate', 'positive_reply_rate', tot->'positive_reply_rate',
    'negative_reply_rate', tot->'negative_reply_rate', 'intents', tot->'intents', 'rows', rows_);
end $$;

-- "Clicking a number opens the inbox filtered to those threads": the exact threads behind a reply count
create or replace function outreach_report_reply_threads(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_intent text default null, p_filters jsonb default '{}')
returns table(chat_id uuid, lead_id uuid, lead_name text, sender_id uuid, intent text, replied_at timestamptz, sequence_id uuid, node_id text, variant_id text, preview text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws);
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  return query
    select c.id, c.lead_id, c.attendee_name, c.sender_id, (case when c.intent <> 'unclassified' then c.intent else coalesce(m.intent,'unclassified') end)::text,
           m.sent_at, e.sequence_id, a.node_id, a.variant_id, left(coalesce(m.text,''), 200)
      from outreach_messages m join outreach_chats c on c.id = m.chat_id join outreach_actions a on a.id = m.replied_to_action_id
      left join outreach_enrollments e on e.id = a.enrollment_id left join outreach_sequences q on q.id = e.sequence_id
     where m.workspace_id = p_ws and m.is_first_reply
       and m.sent_at >= (f::timestamp at time zone z) and m.sent_at < ((t + 1)::timestamp at time zone z)
       and (p_client is null or coalesce(q.client_id, c.client_id) = p_client)
       and (vis is null or coalesce(q.client_id, c.client_id) is null or coalesce(q.client_id, c.client_id) = any(vis))
       and (p_intent is null or (case when c.intent <> 'unclassified' then c.intent else coalesce(m.intent,'unclassified') end)::text = p_intent)
       and ((p_filters->>'sequence_id') is null or e.sequence_id = (p_filters->>'sequence_id')::uuid)
       and ((p_filters->>'sender_id') is null or c.sender_id = (p_filters->>'sender_id')::uuid)
       and ((p_filters->>'node_id') is null or a.node_id = p_filters->>'node_id')
       and ((p_filters->>'variant_id') is null or coalesce(a.variant_id,'') = p_filters->>'variant_id')
     order by m.sent_at desc limit 1000;
end $$;

-- Funnel tab (cohort): leads enrolled in the period, followed through every later stage
create or replace function outreach_report_funnel(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_filters jsonb default '{}')
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; vis uuid[] := outreach_visible_clients(p_ws); res jsonb;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  with cohort as (
    select e.id, e.lead_id, e.sender_id, e.sequence_id, e.created_at as enrolled_at
      from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id join outreach_leads l on l.id = e.lead_id
     where e.workspace_id = p_ws and e.created_at >= (f::timestamp at time zone z) and e.created_at < ((t + 1)::timestamp at time zone z)
       and (p_client is null or q.client_id = p_client) and (vis is null or q.client_id is null or q.client_id = any(vis))
       and ((p_filters->>'sequence_id') is null or e.sequence_id = (p_filters->>'sequence_id')::uuid)
       and ((p_filters->>'sender_id') is null or e.sender_id = (p_filters->>'sender_id')::uuid)
       and ((p_filters->>'list_id') is null or l.list_id = (p_filters->>'list_id')::uuid)
       and ((p_filters->>'tag_id') is null or exists (select 1 from outreach_lead_tags lt where lt.lead_id = l.id and lt.tag_id = (p_filters->>'tag_id')::uuid))
  ), st as (
    select c.id, c.enrolled_at,
      (select min(a.executed_at) from outreach_actions a where a.enrollment_id = c.id and a.action_type = 'invite' and a.status = 'sent') invited_at,
      (select x.invite_accepted_at from outreach_lead_sender_state x where x.lead_id = c.lead_id and x.sender_id = c.sender_id and x.invite_accepted_at >= c.enrolled_at) accepted_at,
      (select min(a.executed_at) from outreach_actions a where a.enrollment_id = c.id and a.action_type in ('message','inmail','email') and a.status = 'sent') messaged_at,
      (select min(m.sent_at) from outreach_messages m join outreach_actions a on a.id = m.replied_to_action_id where a.enrollment_id = c.id and m.is_first_reply) replied_at,
      (select min(ms.at) from outreach_lead_milestones ms where ms.lead_id = c.lead_id and ms.kind = 'interested' and ms.at >= c.enrolled_at) interested_at,
      (select min(ms.at) from outreach_lead_milestones ms where ms.lead_id = c.lead_id and ms.kind = 'meeting' and ms.at >= c.enrolled_at) meeting_at,
      (select min(ms.at) from outreach_lead_milestones ms where ms.lead_id = c.lead_id and ms.kind = 'won' and ms.at >= c.enrolled_at) won_at
    from cohort c
  ), stages as (
    select * from (values (1,'enrolled'),(2,'invited'),(3,'accepted'),(4,'messaged'),(5,'replied'),(6,'interested'),(7,'meeting'),(8,'won')) v(pos, stage)
  ), counts as (
    select s.pos, s.stage,
      count(st.id) filter (where case s.stage when 'enrolled' then true when 'invited' then st.invited_at is not null when 'accepted' then st.accepted_at is not null
                         when 'messaged' then st.messaged_at is not null when 'replied' then st.replied_at is not null when 'interested' then st.interested_at is not null
                         when 'meeting' then st.meeting_at is not null else st.won_at is not null end) as n,
      percentile_cont(0.5) within group (order by extract(epoch from
        case s.stage when 'invited' then st.invited_at - st.enrolled_at when 'accepted' then st.accepted_at - st.invited_at
                     when 'messaged' then st.messaged_at - coalesce(st.accepted_at, st.enrolled_at) when 'replied' then st.replied_at - coalesce(st.messaged_at, st.invited_at)
                     when 'interested' then st.interested_at - st.replied_at when 'meeting' then st.meeting_at - coalesce(st.interested_at, st.replied_at)
                     when 'won' then st.won_at - coalesce(st.meeting_at, st.interested_at) end) / 3600.0) as median_hours
    from stages s left join st on true group by s.pos, s.stage
  )
  select jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'cohort', (select count(*) from cohort),
    'stages', (select jsonb_agg(jsonb_build_object('stage', c.stage, 'count', c.n,
                 'pct_of_enrolled', outreach__rate(c.n, (select n from counts where pos = 1)),
                 'pct_of_previous', outreach__rate(c.n, (select p.n from counts p where p.pos < c.pos and p.n > 0 order by p.pos desc limit 1)),
                 'median_hours_from_previous', case when c.pos > 1 and c.median_hours >= 0 then round(c.median_hours::numeric, 1) end) order by c.pos) from counts c))
    into res;
  return res;
end $$;

-- -----------------------------------------------------------------------------
-- Item 11 — A/B results. Judged on POSITIVE replies (invites: on acceptance). No winner under 100 sends per variant.
-- -----------------------------------------------------------------------------
create or replace function outreach_norm_cdf(z numeric) returns numeric
language sql immutable as $$
  -- Abramowitz–Stegun 7.1.26, |error| < 1.5e-7
  with p as (select abs(z) / sqrt(2.0) as x), q as (select x, 1.0 / (1.0 + 0.3275911 * x) as t from p),
  e as (select 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x) as erf from q)
  select round((0.5 * (1 + sign(z) * erf))::numeric, 6) from e
$$;

create or replace function outreach_ab_results(p_sequence uuid, p_node_id text, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; z text; f date; t date; rows_ jsonb; metric text; best jsonb; r jsonb; out_rows jsonb := '[]';
        p1 numeric; p2 numeric; n1 numeric; n2 numeric; pp numeric; se numeric; zs numeric; conf numeric; enough boolean := true; label text; is_split boolean;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
  z := outreach_ws_tz(s.workspace_id);
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, s.created_at::date);
  n := s.graph->'nodes'->p_node_id;
  if n is null then raise exception 'E_NOT_FOUND: node'; end if;
  is_split := (n->>'type') = 'ab_split';

  if is_split then
    -- whole-path test: each branch is a cohort of enrollments, reported as a funnel
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', b.branch, 'label', coalesce((select x->>'label' from jsonb_array_elements(n->'config'->'branches') x where x->>'id' = b.branch), b.branch),
             'leads', b.leads, 'sent', b.leads, 'accepted', b.accepted, 'replies', b.replies, 'interested', b.interested, 'meetings', b.meetings,
             'acceptance_rate', outreach__rate(b.accepted, b.leads), 'reply_rate', outreach__rate(b.replies, b.leads), 'interested_rate', outreach__rate(b.interested, b.leads)) order by b.branch), '[]'::jsonb)
      into rows_
      from (select sa.branch, count(*) leads,
                   count(*) filter (where exists (select 1 from outreach_lead_sender_state x where x.lead_id = e.lead_id and x.sender_id = e.sender_id and x.invite_accepted_at >= e.created_at)) accepted,
                   count(*) filter (where exists (select 1 from outreach_messages m join outreach_actions a on a.id = m.replied_to_action_id where a.enrollment_id = e.id and m.is_first_reply)) replies,
                   count(*) filter (where exists (select 1 from outreach_messages m join outreach_actions a on a.id = m.replied_to_action_id join outreach_chats c on c.id = m.chat_id where a.enrollment_id = e.id and m.is_first_reply and c.intent = 'interested')) interested,
                   count(*) filter (where exists (select 1 from outreach_lead_milestones ms where ms.lead_id = e.lead_id and ms.kind = 'meeting' and ms.at >= e.created_at)) meetings
              from outreach_split_assignments sa join outreach_enrollments e on e.id = sa.enrollment_id
             where sa.sequence_id = p_sequence and sa.node_id = p_node_id and sa.at >= (f::timestamp at time zone z) and sa.at < ((t + 1)::timestamp at time zone z)
             group by sa.branch) b;
    metric := 'interested';
  else
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', v.vid, 'label', coalesce((select x->>'label' from jsonb_array_elements(coalesce(n->'config'->'variants','[]'::jsonb)) x where x->>'id' = v.vid), nullif(v.vid,''), 'No variant'),
             'weight', (select x->'weight' from jsonb_array_elements(coalesce(n->'config'->'variants','[]'::jsonb)) x where x->>'id' = v.vid),
             'sent', v.sent, 'accepted', v.accepted, 'replies', v.replies, 'interested', v.interested,
             'acceptance_rate', outreach__rate(v.accepted, v.sent), 'reply_rate', outreach__rate(v.replies, v.sent), 'interested_rate', outreach__rate(v.interested, v.sent)) order by v.vid), '[]'::jsonb)
      into rows_
      from (select coalesce(a.variant_id,'') vid, count(*) sent,
                   count(*) filter (where a.action_type = 'invite' and exists (select 1 from outreach_lead_sender_state x where x.lead_id = a.lead_id and x.sender_id = a.sender_id and x.invite_accepted_at >= a.executed_at)) accepted,
                   count(*) filter (where exists (select 1 from outreach_messages m where m.replied_to_action_id = a.id and m.is_first_reply)) replies,
                   count(*) filter (where exists (select 1 from outreach_messages m join outreach_chats c on c.id = m.chat_id where m.replied_to_action_id = a.id and m.is_first_reply and c.intent = 'interested')) interested
              from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
             where e.sequence_id = p_sequence and a.node_id = p_node_id and a.status = 'sent' and not coalesce((a.payload->>'prefetch')::boolean,false)
               and a.executed_at >= (f::timestamp at time zone z) and a.executed_at < ((t + 1)::timestamp at time zone z)
             group by 1) v;
    metric := case when (n->>'type') = 'send_invite' then 'accepted' else 'interested' end;
  end if;

  select x into best from jsonb_array_elements(rows_) x order by (x->>(metric))::numeric / nullif((x->>'sent')::numeric, 0) desc nulls last, (x->>'sent')::numeric desc limit 1;
  for r in select * from jsonb_array_elements(rows_) loop
    if (r->>'sent')::numeric < 100 then enough := false; end if;
  end loop;
  for r in select * from jsonb_array_elements(rows_) loop
    conf := null; label := null;
    if best is not null and r->>'variant_id' <> best->>'variant_id' and (r->>'sent')::numeric > 0 and (best->>'sent')::numeric > 0 then
      n1 := (best->>'sent')::numeric; n2 := (r->>'sent')::numeric; p1 := (best->>(metric))::numeric / n1; p2 := (r->>(metric))::numeric / n2;
      pp := ((best->>(metric))::numeric + (r->>(metric))::numeric) / (n1 + n2);
      se := sqrt(greatest(pp * (1 - pp) * (1 / n1 + 1 / n2), 0));
      if se > 0 then zs := (p1 - p2) / se; conf := round(100 * (2 * outreach_norm_cdf(zs) - 1), 1); end if;
      label := case when not enough then 'Not enough data yet' when conf is null then 'No difference' when conf >= 99 then 'Very confident' when conf >= 95 then 'Confident'
                    when conf >= 90 then 'Likely' else 'No clear difference' end;
    end if;
    out_rows := out_rows || (r || jsonb_build_object('is_leading', best is not null and r->>'variant_id' = best->>'variant_id', 'confidence_vs_leader', conf, 'verdict_vs_leader', label));
  end loop;
  return jsonb_build_object('sequence_id', p_sequence, 'node_id', p_node_id, 'node_type', n->>'type', 'judged_on', metric, 'period', jsonb_build_object('from', f, 'to', t),
    'enough_data', enough and jsonb_array_length(rows_) >= 2, 'min_sends_per_variant', 100, 'variants', out_rows,
    'leader', case when enough and jsonb_array_length(rows_) >= 2 then best->>'variant_id' end,
    'can_promote', enough and jsonb_array_length(rows_) >= 2 and not is_split
                   and not exists (select 1 from jsonb_array_elements(out_rows) x where not (x->>'is_leading')::boolean and coalesce((x->>'confidence_vs_leader')::numeric, 0) < 90));
end $$;

-- Promote winner: the variant goes to 100% and a new version is published (leads in flight keep their sticky variant only if it still has weight)
create or replace function outreach_promote_variant(p_sequence uuid, p_node_id text, p_variant text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; g jsonb; vars jsonb; nv jsonb := '[]'; v jsonb; found_v boolean := false; res jsonb;
begin
  select * into s from outreach_sequences where id = p_sequence for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  vars := s.graph->'nodes'->p_node_id->'config'->'variants';
  if jsonb_typeof(vars) <> 'array' then raise exception 'E_PAYLOAD_INVALID: step has no variants'; end if;
  for v in select * from jsonb_array_elements(vars) loop
    if v->>'id' = p_variant then found_v := true; nv := nv || (v || jsonb_build_object('weight', 100, 'promoted_at', now()));
    else nv := nv || (v || jsonb_build_object('weight', 0)); end if;
  end loop;
  if not found_v then raise exception 'E_NOT_FOUND: variant'; end if;
  g := jsonb_set(s.graph, array['nodes', p_node_id, 'config', 'variants'], nv);
  if s.draft_graph is not null and s.draft_graph->'nodes' ? p_node_id then
    update outreach_sequences set draft_graph = jsonb_set(draft_graph, array['nodes', p_node_id, 'config', 'variants'], nv), draft_base_version = head_version + 1 where id = p_sequence;
  end if;
  -- publish the live graph + weights only; an open draft stays a draft
  res := jsonb_build_object('version', outreach_save_sequence(p_sequence, g));
  update outreach_sequence_versions set note = 'Promoted variant ' || p_variant || ' on ' || p_node_id, publish_mode = 'all' where sequence_id = p_sequence and version = (res->>'version')::int;
  perform outreach_refresh_queued_text(p_sequence, p_node_id);
  perform outreach_audit(s.workspace_id, 'sequence.variant_promoted', 'sequence', p_sequence::text, jsonb_build_object('node_id', p_node_id, 'variant', p_variant));
  return res || jsonb_build_object('promoted', p_variant);
end $$;

-- One sequence: totals, per-step drop-off, best / worst step, A/B blocks, exits
create or replace function outreach_report_sequence(p_sequence uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; z text; f date; t date; tot jsonb; steps jsonb; ab jsonb := '[]'; k text; nd jsonb; best jsonb; worst jsonb; exits jsonb;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  z := outreach_ws_tz(s.workspace_id);
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(s.workspace_id, s.client_id, f, t);
  select totals into tot from outreach__grouped(s.workspace_id, null, f, t, 'none', jsonb_build_object('sequence_id', p_sequence));
  select coalesce(jsonb_agg(jsonb_build_object('node_id', x.key, 'step_number', (outreach_graph_step_numbers(s.graph)->>x.key)::int, 'type', x.value->>'type', 'label', coalesce(x.value->>'label', replace(x.value->>'type','_',' ')),
           'sent', coalesce((g.totals->>'invites')::numeric,0) + coalesce((g.totals->>'messages')::numeric,0) + coalesce((g.totals->>'inmails')::numeric,0) + coalesce((g.totals->>'emails')::numeric,0)
                   + coalesce((g.totals->>'profile_views')::numeric,0) + coalesce((g.totals->>'likes')::numeric,0) + coalesce((g.totals->>'comments')::numeric,0) + coalesce((g.totals->>'endorsements')::numeric,0) + coalesce((g.totals->>'follows')::numeric,0),
           'failed', coalesce(g.totals->'failed','0'), 'skipped', coalesce(g.totals->'skipped','0'), 'accepted', coalesce(g.totals->'accepted','0'),
           'replies', coalesce(g.totals->'replies','0'), 'interested', coalesce(g.totals->'interested','0'),
           'reply_rate', g.totals->'reply_rate', 'positive_reply_rate', g.totals->'positive_reply_rate', 'acceptance_rate', g.totals->'acceptance_rate',
           'leads_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
           'failed_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status = 'failed'))
           order by (outreach_graph_step_numbers(s.graph)->>x.key)::int nulls last, x.key), '[]'::jsonb)
    into steps
    from jsonb_each(s.graph->'nodes') x left join outreach__grouped(s.workspace_id, null, f, t, 'node', jsonb_build_object('sequence_id', p_sequence)) g on g.grp = p_sequence::text || '|' || x.key
   where outreach_is_executable_node(x.value->>'type') or (x.value->>'type') in ('wait_connection','ab_split','ai_route','manual_task','call_task');
  select x into best from jsonb_array_elements(steps) x where (x->>'sent')::numeric >= 20 and x->>'reply_rate' is not null order by (x->>'reply_rate')::numeric desc limit 1;
  select x into worst from jsonb_array_elements(steps) x where (x->>'sent')::numeric >= 20 and x->>'reply_rate' is not null order by (x->>'reply_rate')::numeric asc limit 1;
  for k, nd in select * from jsonb_each(s.graph->'nodes') loop
    if (nd->>'type') = 'ab_split' or (jsonb_typeof(nd->'config'->'variants') = 'array' and jsonb_array_length(nd->'config'->'variants') > 1) then
      ab := ab || outreach_ab_results(p_sequence, k, f, t);
    end if;
  end loop;
  select coalesce(jsonb_object_agg(x.k, x.c), '{}'::jsonb) into exits from (
    select e.status::text || coalesce(':' || nullif(e.exit_reason,''), '') k, count(*) c from outreach_enrollments e
     where e.sequence_id = p_sequence and e.completed_at >= (f::timestamp at time zone z) and e.completed_at < ((t + 1)::timestamp at time zone z) group by 1) x;
  return jsonb_build_object('sequence', jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'head_version', s.head_version, 'stalled_reason', s.stalled_reason),
    'period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'totals', coalesce(tot, outreach__totals_from('{}'::jsonb)), 'steps', steps,
    'best_step', case when best is distinct from worst then best end, 'worst_step', case when best is distinct from worst then worst end, 'ab_tests', ab, 'exits', exits,
    'live', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')));
end $$;

-- -----------------------------------------------------------------------------
-- Item 12 — sender insights: rule-based recommendations, warm-up card, four 30-day numbers, invites vs cap
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_insights(p_sender uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; z text; today date; recs jsonb := '[]'; hb jsonb; inp jsonb; cur jsonb; prev jsonb; chart jsonb; headroom numeric; cap_sum numeric; used_sum numeric;
        ar numeric; next_on date; max_level int; growth int; snap_now int; snap_then int; guard int;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
  z := outreach_ws_tz(s.workspace_id); today := (now() at time zone z)::date;
  hb := coalesce(s.health_breakdown, '{}'::jsonb);
  inp := outreach_health_inputs(p_sender);
  select totals into cur from outreach__grouped(s.workspace_id, null, today - 29, today, 'none', jsonb_build_object('sender_id', p_sender));
  select totals into prev from outreach__grouped(s.workspace_id, null, today - 59, today - 30, 'none', jsonb_build_object('sender_id', p_sender));
  cur := coalesce(cur, outreach__totals_from('{}'::jsonb)); prev := coalesce(prev, outreach__totals_from('{}'::jsonb));

  select coalesce(sum(cap),0), coalesce(sum(used),0) into cap_sum, used_sum from outreach_sender_budgets where sender_id = p_sender and action_type = 'invite' and day >= current_date - 30 and cap > 0;
  headroom := case when cap_sum > 0 then round(100.0 * (cap_sum - used_sum) / cap_sum, 1) end;
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'sent', coalesce(b.used,0), 'cap', b.cap) order by d.day), '[]'::jsonb) into chart
    from (select generate_series(current_date - 29, current_date, interval '1 day')::date as day) d
    left join outreach_sender_budgets b on b.sender_id = p_sender and b.action_type = 'invite' and b.day = d.day;
  select (data->>'connections_count')::int into snap_now from outreach_sender_events where sender_id = p_sender and kind = 'snapshot' order by at desc limit 1;
  select (data->>'connections_count')::int into snap_then from outreach_sender_events where sender_id = p_sender and kind = 'snapshot' and at <= now() - interval '29 days' order by at desc limit 1;
  growth := case when snap_now is not null and snap_then is not null then snap_now - snap_then else (cur->>'accepted')::int end;

  -- recommendations: rules over the health breakdown, never AI
  ar := case when (inp->>'invites_14d')::numeric >= 20 then round(100.0 * (inp->>'accepted_14d')::numeric / (inp->>'invites_14d')::numeric, 0) end;
  if s.status in ('credentials','error') then recs := recs || jsonb_build_object('severity','high','area','session','text','This sender is disconnected. Reconnect it before anything else: nothing is being sent.'); end if;
  if coalesce((hb->>'acceptance_rate')::numeric, 100) < 85 and ar is not null then
    recs := recs || jsonb_build_object('severity', case when ar < 15 then 'high' else 'medium' end, 'area','acceptance_rate',
      'text', format('Acceptance rate is %s%%. Below 20%% LinkedIn notices. Tighten targeting or rewrite the invitation note before raising volume.', ar));
  end if;
  if coalesce((hb->>'rejection_rate')::numeric, 100) < 80 then
    recs := recs || jsonb_build_object('severity','high','area','rejection_rate','text', format('LinkedIn rejected %s of the last %s actions. Keep volume flat for a week; the caps already dropped to protect the account.', inp->>'rejects_14d', inp->>'actions_14d'));
  end if;
  if coalesce((hb->>'session_stability')::numeric, 100) < 75 then
    recs := recs || jsonb_build_object('severity','medium','area','session_stability','text', format('The session dropped %s time(s) in 14 days. Turn on automatic reconnect (extension) and avoid logging in from new devices or countries.', inp->>'disconnects_14d'));
  end if;
  if coalesce((hb->>'reply_rate')::numeric, 100) < 80 then
    recs := recs || jsonb_build_object('severity','medium','area','reply_rate','text','Few people answer this sender''s messages. Test a shorter first message (A/B) before adding follow-ups.');
  end if;
  if coalesce((hb->>'consistency')::numeric, 100) < 75 then
    recs := recs || jsonb_build_object('severity', case when (hb->>'consistency')::numeric <= 10 then 'high' else 'low' end, 'area','consistency','text','Activity is uneven from day to day. Keep leads flowing steadily: a burst after idle days looks automated.');
  end if;
  if coalesce((hb->>'verification')::numeric, 100) < 100 then
    recs := recs || jsonb_build_object('severity','medium','area','verification','text', format('LinkedIn asked for verification %s time(s) in 30 days. Complete it promptly and keep volume low for two weeks.', inp->>'checkpoints_30d'));
  end if;
  if (cur->>'limit_hits')::numeric > 0 then
    recs := recs || jsonb_build_object('severity','medium','area','limits','text', format('LinkedIn''s own invitation limit was hit %s time(s) in 30 days. The platform pauses invitations until the limit resets; lower the manual invite cap to stay under it.', cur->>'limit_hits'));
  end if;
  if headroom is not null and headroom > 60 and s.running_dry_at is null and s.status = 'ok' then
    recs := recs || jsonb_build_object('severity','low','area','headroom','text', format('%s%% of the invitation allowance went unused. There is room for more leads on this sender.', round(headroom)));
  end if;
  if s.running_dry_at is not null then recs := recs || jsonb_build_object('severity','medium','area','leads','text','This sender has less than two days of new leads queued. Enrol more leads or add an auto-enrol rule.'); end if;
  if jsonb_array_length(recs) = 0 then recs := recs || jsonb_build_object('severity','ok','area','all','text','Nothing to fix. Keep volume steady and the next warm-up level unlocks on its own.'); end if;

  max_level := case when s.is_premium or s.provider <> 'LINKEDIN' then 5 else 1 end;
  next_on := case when s.warmup_level >= max_level then null
                  when s.health_score < 85 then null
                  else greatest(coalesce(s.health_high_since, current_date) + 14, coalesce(s.warmup_locked_until + 1, current_date)) end;
  guard := outreach_inmail_guard(p_sender, current_date);

  return jsonb_build_object(
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'status', s.status, 'health', s.health_score, 'level', s.warmup_level),
    'health_breakdown', hb - 'computed_at' - 'trigger', 'recommendations', recs,
    'warmup', jsonb_build_object('level', s.warmup_level, 'max_level', max_level, 'locked_until', s.warmup_locked_until, 'health_high_since', s.health_high_since,
       'next_level_on', next_on,
       'unlocks', case when s.warmup_level >= max_level then case when max_level = 1 then 'Free LinkedIn accounts stay at level 1. A Premium or Sales Navigator seat unlocks higher levels.' else 'Top level reached.' end
                       when s.health_score < 85 then format('Health must reach 85 (now %s) and stay there for 14 days.', s.health_score)
                       else format('Health has been 85+ since %s. Level %s unlocks on %s.', coalesce(s.health_high_since, current_date), s.warmup_level + 1, next_on) end,
       'caps_now', (select coalesce(jsonb_object_agg(action_type, per_day), '{}'::jsonb) from outreach_warmup_caps where level = s.warmup_level),
       'caps_next', (select coalesce(jsonb_object_agg(action_type, per_day), '{}'::jsonb) from outreach_warmup_caps where level = least(s.warmup_level + 1, 5))),
    'last_30_days', jsonb_build_object('headroom_pct', headroom, 'limit_hits', cur->'limit_hits', 'acceptance_rate', cur->'acceptance_rate', 'acceptance_rate_previous', prev->'acceptance_rate',
       'network_growth', growth, 'network_growth_source', case when snap_now is not null and snap_then is not null then 'connections_count' else 'accepted_invitations' end,
       'invites', cur->'invites', 'accepted', cur->'accepted', 'replies', cur->'replies', 'reply_rate', cur->'reply_rate'),
    'invites_vs_cap', chart,
    'inmail_guard', jsonb_build_object('max_today', guard, 'rule', 'InMails may grow at most ~50% above last week''s daily average (never below 3 a day). LinkedIn has blocked senders who jumped from about 3 to 16 a day.'));
end $$;

create or replace function outreach_report_sender(p_sender uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; z text; f date; t date; tot jsonb; series jsonb;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  z := outreach_ws_tz(s.workspace_id);
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(s.workspace_id, s.client_id, f, t);
  select totals into tot from outreach__grouped(s.workspace_id, null, f, t, 'none', jsonb_build_object('sender_id', p_sender));
  select coalesce(jsonb_agg(jsonb_build_object('day', g.grp) || g.totals order by g.grp), '[]'::jsonb) into series from outreach__grouped(s.workspace_id, null, f, t, 'day', jsonb_build_object('sender_id', p_sender)) g;
  return jsonb_build_object('sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'status', s.status, 'health', s.health_score, 'level', s.warmup_level),
    'period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'totals', coalesce(tot, outreach__totals_from('{}'::jsonb)), 'series', series,
    'health_trend', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'score', (e.data->>'to')::int) order by e.at), '[]'::jsonb) from outreach_sender_events e
                      where e.sender_id = p_sender and e.kind = 'health' and e.at >= (f::timestamp at time zone z) and e.at < ((t + 1)::timestamp at time zone z)),
    'restrictions', (select coalesce(jsonb_agg(jsonb_build_object('at', e.at, 'kind', e.kind, 'data', e.data) order by e.at desc), '[]'::jsonb) from (
                       select * from outreach_sender_events e where e.sender_id = p_sender and e.kind in ('reject','checkpoint','status') and e.at >= (f::timestamp at time zone z)
                          and (e.kind <> 'status' or e.data->>'to' in ('credentials','error','paused') or e.data ? 'paused_until') order by e.at desc limit 50) e),
    'failures_by_reason', (select coalesce(jsonb_object_agg(x.reason, x.c), '{}'::jsonb) from (
                       select outreach_reason_text(a.error_code, a.decision) reason, count(*) c from outreach_actions a
                        where a.sender_id = p_sender and a.status = 'failed' and a.executed_at >= (f::timestamp at time zone z) and a.executed_at < ((t + 1)::timestamp at time zone z) group by 1) x));
end $$;

-- Cost tab. Return (ROI) is only shown when the workspace entered deal values: we don't guess.
create or replace function outreach_report_cost(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare z text := outreach_ws_tz(p_ws); f date; t date; tot jsonb; cost numeric; senders_n int; missing int; def numeric; vis uuid[] := outreach_visible_clients(p_ws); per jsonb;
begin
  t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29);
  perform outreach__check_range(p_ws, p_client, f, t);
  select nullif(settings->>'sender_monthly_cost','')::numeric into def from outreach_workspaces where id = p_ws;
  select totals into tot from outreach__grouped(p_ws, p_client, f, t, 'none', '{}');
  tot := coalesce(tot, outreach__totals_from('{}'::jsonb));
  with sd as (
    select s.id, s.display_name, coalesce(s.monthly_cost, def) mc,
           greatest(least(t, coalesce(s.deleted_at::date, t)) - greatest(f, coalesce(s.connected_at::date, s.created_at::date)) + 1, 0) days
      from outreach_senders s where s.workspace_id = p_ws and s.status <> 'disabled' and (p_client is null or s.client_id = p_client)
       and (vis is null or s.client_id is null or s.client_id = any(vis)) and coalesce(s.connected_at, s.created_at) < ((t + 1)::timestamp at time zone z))
  select count(*) filter (where days > 0), count(*) filter (where days > 0 and mc is null), sum(mc * days / 30.0),
         coalesce(jsonb_agg(jsonb_build_object('sender_id', id, 'name', display_name, 'monthly_cost', mc, 'days', days, 'cost', round(mc * days / 30.0, 2))) filter (where days > 0), '[]'::jsonb)
    into senders_n, missing, cost, per from sd;
  return jsonb_build_object('period', jsonb_build_object('from', f, 'to', t, 'timezone', z), 'currency', coalesce((select settings->>'currency' from outreach_workspaces where id = p_ws), 'USD'),
    'default_sender_monthly_cost', def, 'senders', senders_n, 'senders_without_cost', missing, 'cost', round(cost, 2), 'per_sender', per,
    'replies', tot->'replies', 'interested', tot->'interested', 'meetings', tot->'meetings', 'won', tot->'won',
    'cost_per_reply', case when cost is not null and (tot->>'replies')::numeric > 0 then round(cost / (tot->>'replies')::numeric, 2) end,
    'cost_per_interested', case when cost is not null and (tot->>'interested')::numeric > 0 then round(cost / (tot->>'interested')::numeric, 2) end,
    'cost_per_meeting', case when cost is not null and (tot->>'meetings')::numeric > 0 then round(cost / (tot->>'meetings')::numeric, 2) end,
    'won_value', case when (tot->>'won_value')::numeric > 0 then tot->'won_value' end,
    'return_multiple', case when cost > 0 and (tot->>'won_value')::numeric > 0 then round((tot->>'won_value')::numeric / cost, 1) end,
    'note', case when cost is null then 'Set a monthly cost per sender (Settings → Workspace, or on each sender) to see cost per reply.'
                 when (tot->>'won_value')::numeric = 0 then 'Return is shown once deals carry a value (the Won stage value, or a deal_value field on the lead).' end);
end $$;

-- -----------------------------------------------------------------------------
-- Item 3 — diagnosis in the database, so the health worker, the UI and the connector say the same sentence
-- -----------------------------------------------------------------------------
create or replace function outreach_action_label(p_type text) returns text
language sql immutable as $$
  select case p_type when 'invite' then 'invitations' when 'message' then 'messages' when 'inmail' then 'InMails' when 'email' then 'emails' when 'profile_view' then 'profile views'
    when 'like' then 'likes' when 'comment' then 'comments' when 'endorse' then 'endorsements' when 'follow' then 'follows' when 'withdraw' then 'withdrawals'
    when 'post_fetch' then 'post look-ups' when 'search_page' then 'search pages' when 'find_email' then 'email look-ups' else replace(p_type, '_', ' ') end
$$;

create or replace function outreach__sender_causes(p_sender uuid, p_need text[]) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; c jsonb := '[]'; plan text; b record; nw timestamptz; d int; w record; wk int; wkc int; nm text;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found or s.deleted_at is not null then return jsonb_build_array(jsonb_build_object('code','E_SENDER_NOT_OK','blocking',true,'sender_id',p_sender,'detail','This sender no longer exists','remedy','Remove it from the pool.')); end if;
  nm := coalesce(s.display_name, 'Sender');
  select w2.plan into plan from outreach_workspaces w2 where w2.id = s.workspace_id;
  if plan = 'suspended' then c := c || jsonb_build_object('code','E_PLAN_SUSPENDED','blocking',true,'sender',nm,'sender_id',s.id,'detail','The workspace is suspended (billing)','remedy','An owner fixes billing; sending resumes on its own afterwards.'); end if;
  if s.status <> 'ok' then
    c := c || jsonb_build_object('code','E_SENDER_NOT_OK','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', nm || case s.status when 'credentials' then ' is disconnected from LinkedIn (session expired)' when 'error' then ' reports a provider error (' || coalesce(s.status_reason,'unknown') || ')'
                           when 'paused' then ' is paused (' || coalesce(s.status_reason,'by a teammate') || ')' when 'connecting' then ' is still connecting' else ' is ' || s.status::text end,
      'remedy', case when s.status = 'paused' then 'A manager resumes it on the sender page.' else 'Reconnect it on the sender page.' end);
  end if;
  if s.paused_until is not null and s.paused_until > now() then
    c := c || jsonb_build_object('code','E_SENDER_PAUSED','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.paused_until,
      'detail', nm || ' is resting until ' || to_char(s.paused_until at time zone s.timezone, 'Mon DD HH24:MI') || ' (' || coalesce(s.status_reason,'safety pause') || ')', 'remedy','Wait it out. Do not move volume to other senders to compensate.');
  end if;
  if not outreach_in_schedule(s.id, now()) then
    nw := null;
    for d in 0..7 loop
      for w in select start_at from outreach_schedule_windows(s.id, (now() at time zone s.timezone)::date + d) order by start_at loop
        if w.start_at > now() then nw := w.start_at; exit; end if;
      end loop;
      exit when nw is not null;
    end loop;
    c := c || jsonb_build_object('code', case when nw is null then 'E_NO_SCHEDULE' else 'W_OUT_OF_SCHEDULE' end, 'blocking', nw is null, 'sender',nm,'sender_id',s.id,'next_capacity',nw,
      'detail', case when nw is null then nm || ' has no working hours in the next 7 days' else nm || ' is outside working hours; sending resumes ' || to_char(nw at time zone s.timezone, 'Dy HH24:MI') || ' (' || s.timezone || ')' end,
      'remedy', case when nw is null then 'Set working hours on the sender page.' else 'Nothing to fix.' end);
  end if;
  for b in select x.action_type::text t, x.cap, x.used, x.reserved from outreach_sender_budgets x where x.sender_id = p_sender and x.day = outreach_sender_local_date(p_sender, now()) and x.action_type::text = any(p_need) loop
    if b.cap = 0 then
      -- a day without working hours has cap 0 for everything: that is the schedule cause above, not a cap problem
      if exists (select 1 from outreach_schedule_windows(s.id, outreach_sender_local_date(s.id, now()))) then
        c := c || jsonb_build_object('code','E_CAP_ZERO','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s has no allowance for %s today (warm-up level %s, health %s)', nm, outreach_action_label(b.t), s.warmup_level, s.health_score),'remedy','Allowances rise with warm-up level and health. A manager can check the manual caps.');
      end if;
    elsif b.used + b.reserved >= b.cap then
      c := c || jsonb_build_object('code','W_BUDGET_EXHAUSTED','blocking',false,'sender',nm,'sender_id',s.id,'next_capacity','tomorrow','detail', format('%s used today''s allowance for %s (%s of %s)', nm, outreach_action_label(b.t), b.used + b.reserved, b.cap),'remedy','Resumes tomorrow. Add another healthy sender for more volume; do not raise caps.');
    end if;
  end loop;
  if 'invite' = any(p_need) then
    wk := outreach_weekly_invites_used(p_sender, outreach_sender_local_date(p_sender, now()));
    select per_week into wkc from outreach_platform_ceilings where action_type = 'invite';
    if wk >= coalesce(wkc,150) then c := c || jsonb_build_object('code','E_CAP_HIT_WEEKLY','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s reached the weekly invitation ceiling (%s of %s)', nm, wk, coalesce(wkc,150)),'remedy','Invitations resume next week; messages continue.'); end if;
    if s.invite_blocked_until is not null and s.invite_blocked_until > now() then
      c := c || jsonb_build_object('code','E_INVITE_BLOCKED','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.invite_blocked_until,'detail', nm || ': LinkedIn refused further invitations until ' || to_char(s.invite_blocked_until, 'Mon DD'),'remedy','Wait. Other steps continue.');
    end if;
  end if;
  if s.health_score < 50 then c := c || jsonb_build_object('code','E_HEALTH_PAUSED','blocking',true,'sender',nm,'sender_id',s.id,'detail', format('%s has a health score of %s: below 50 every allowance is 0', nm, s.health_score),'remedy','Open the sender page for the failing category; recovery takes days of low, steady activity.');
  elsif s.health_score < 70 then c := c || jsonb_build_object('code','W_HEALTH_REDUCED','blocking',false,'sender',nm,'sender_id',s.id,'detail', format('%s has a health score of %s: allowances are reduced to 60%%', nm, s.health_score),'remedy','Keep volume steady.'); end if;
  return c;
end $$;
revoke execute on function outreach__sender_causes(uuid,text[]) from public, anon, authenticated;

create or replace function outreach_why_not_sending(p_sequence uuid default null, p_sender uuid default null, p_enrollment uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare causes jsonb := '[]'; notes jsonb := '[]'; ws uuid; target text; q outreach_sequences%rowtype; e outreach_enrollments%rowtype; s outreach_senders%rowtype; l outreach_leads%rowtype;
        need text[]; sid uuid; n jsonb; live int; queued int; waiting int; f record; blocking jsonb; tk record; nx record; rel text; ok_senders int := 0; sc jsonb; first_text text;
begin
  if p_enrollment is not null then
    select * into e from outreach_enrollments where id = p_enrollment;
    if not found then raise exception 'E_NOT_FOUND'; end if;
    ws := e.workspace_id; p_sequence := e.sequence_id;
  elsif p_sequence is not null then select workspace_id into ws from outreach_sequences where id = p_sequence;
  elsif p_sender is not null then select workspace_id into ws from outreach_senders where id = p_sender;
  else raise exception 'E_PAYLOAD_INVALID: sequence, sender or enrollment required'; end if;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');

  for f in select key, value from outreach_flags where key in ('tick_enabled','planner_enabled') and value in ('false'::jsonb, '"false"'::jsonb) loop
    causes := causes || jsonb_build_object('code','E_PLATFORM_PAUSED','blocking',true,'detail','Automation is paused platform-wide by the operators (' || f.key || ')','remedy','Nothing to do in the workspace.');
  end loop;

  if p_sequence is not null then
    select * into q from outreach_sequences where id = p_sequence;
    if not outreach_client_visible(ws, q.client_id) then raise exception 'E_FORBIDDEN'; end if;
    target := 'Sequence "' || q.name || '"';
    if q.status <> 'active' then causes := causes || jsonb_build_object('code','E_SEQUENCE_NOT_ACTIVE','blocking',true,'detail','The sequence is ' || q.status::text,'remedy','Activate it.'); end if;
    if coalesce(array_length(q.sender_pool,1),0) = 0 then causes := causes || jsonb_build_object('code','E_POOL_EMPTY','blocking',true,'detail','The sequence has no senders','remedy','Add a connected sender to the pool.'); end if;
    select array_agg(distinct outreach_node_action_type(x.value->>'type')::text) into need from jsonb_each(q.graph->'nodes') x where outreach_node_action_type(x.value->>'type') is not null;
  end if;

  if p_enrollment is not null then
    select * into l from outreach_leads where id = e.lead_id;
    target := coalesce(l.full_name,'Lead') || ' in "' || q.name || '"';
    n := outreach_enrollment_graph(e.id)->'nodes'->e.current_node_id;
    need := array_remove(array[outreach_node_action_type(n->>'type')::text], null);
    if e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then
      causes := causes || jsonb_build_object('code','E_ENROLLMENT_NOT_LIVE','blocking',true,'detail', case when e.held_at is not null then 'The lead replied and is held for review' else 'The lead is ' || replace(e.status::text,'_',' ') || coalesce(' (' || outreach_reason_text(e.exit_reason) || ')','') end,
        'remedy', case when e.held_at is not null then 'Resume or exit the lead from the task list.' when e.status = 'paused' then 'Resume the lead.' when e.status = 'failed' then 'Retry or skip the step from the failed-leads list.' else 'It is finished; enrol the lead again if appropriate.' end);
    end if;
    if outreach_enrollment_suppression_reason(e.id) is not null then causes := causes || jsonb_build_object('code','E_LEAD_SUPPRESSED','blocking',true,'detail','The lead is blacklisted (' || replace(outreach_enrollment_suppression_reason(e.id),'_',' ') || ')','remedy','Nothing will be sent. Do not work around a blacklist.'); end if;
    if e.status = 'waiting_delay' then causes := causes || jsonb_build_object('code','W_WAITING_DELAY','blocking',false,'next_capacity',e.wait_until,'detail','Waiting in a delay until ' || to_char(e.wait_until,'Mon DD HH24:MI'),'remedy','By design; it continues on its own.'); end if;
    if e.status = 'waiting_connection' then
      select relation::text into rel from outreach_lead_sender_state where lead_id = e.lead_id and sender_id = e.sender_id;
      causes := causes || jsonb_build_object('code','W_WAITING_CONNECTION','blocking',false,'next_capacity',e.wait_until,'detail','Waiting for the invitation to be accepted (' || coalesce(rel,'pending') || '); the window ends ' || to_char(e.wait_until,'Mon DD'),'remedy','By design.');
    end if;
    if e.status = 'waiting_task' then
      if e.wait_reason = 'enrichment' then causes := causes || jsonb_build_object('code','W_WAITING_ENRICHMENT','blocking',false,'detail','Waiting for the profile to be enriched before the first step','remedy','Happens within the sender''s profile-view allowance; starts anyway after 72 hours.');
      elsif e.wait_reason = 'ai_review' then causes := causes || jsonb_build_object('code','W_WAITING_AI_REVIEW','blocking',true,'detail','Waiting for someone to approve the AI-written line for this lead','remedy','Open AI review and approve, edit or skip it.');
      elsif e.wait_reason = 'ai_route' then causes := causes || jsonb_build_object('code','W_WAITING_AI_ROUTE','blocking',false,'detail','Waiting for the AI routing decision','remedy','Decided within minutes; falls back to "everything else" after 6 hours.');
      else
        select id, kind, title into tk from outreach_tasks where enrollment_id = e.id and completed_at is null order by created_at desc limit 1;
        causes := causes || jsonb_build_object('code','W_WAITING_TASK','blocking',true,'detail','Waiting for a teammate: ' || coalesce(tk.title, 'open task'),'remedy','Complete the task.','task_id',tk.id);
      end if;
    end if;
    if e.status = 'active' then
      select action_type::text t, scheduled_for, decision into nx from outreach_actions where enrollment_id = e.id and status in ('queued','reserved') order by scheduled_for limit 1;
      if found then causes := causes || jsonb_build_object('code','W_SCHEDULED','blocking',false,'next_capacity',nx.scheduled_for,'detail','The next step (' || outreach_action_label(nx.t) || ') is planned for ' || to_char(nx.scheduled_for,'Mon DD HH24:MI') || case when nx.decision = 'budget_deferred' then ' (moved: today''s allowance was used)' else '' end,'remedy','Nothing to fix.');
      else causes := causes || jsonb_build_object('code','W_NOT_PLANNED_YET','blocking',false,'detail','Active with no planned action yet','remedy','The planner assigns a slot within 20 minutes when the sender has allowance.'); end if;
    end if;
    causes := causes || outreach__sender_causes(e.sender_id, coalesce(need, array['invite','message']));
  elsif p_sequence is not null then
    select count(*) filter (where x.status in ('active','waiting_connection','waiting_delay','waiting_task')),
           count(*) filter (where x.status = 'waiting_task' and x.wait_reason = 'ai_review') into live, waiting
      from outreach_enrollments x where x.sequence_id = p_sequence;
    select count(*) into queued from outreach_actions a join outreach_enrollments x on x.id = a.enrollment_id where x.sequence_id = p_sequence and a.status = 'queued';
    notes := notes || to_jsonb(format('%s live lead(s), %s planned action(s)', live, queued));
    if live = 0 then causes := causes || jsonb_build_object('code','E_NO_LEADS','blocking',true,'detail','No leads are in this sequence','remedy','Enrol leads, or add an auto-enrol rule.'); end if;
    if waiting > 0 then causes := causes || jsonb_build_object('code','W_WAITING_AI_REVIEW','blocking', waiting = live,'detail', format('%s lead(s) wait for their AI-written line to be approved', waiting),'remedy','Open AI review.'); end if;
    foreach sid in array coalesce(q.sender_pool, '{}') loop
      sc := outreach__sender_causes(sid, coalesce(need, array['invite','message']));
      if not exists (select 1 from jsonb_array_elements(sc) x where (x->>'blocking')::boolean) then ok_senders := ok_senders + 1; end if;
      causes := causes || sc;
    end loop;
    -- with several senders, one blocked sender does not block the sequence
    if ok_senders > 0 then
      select coalesce(jsonb_agg(case when x ? 'sender_id' and (x->>'blocking')::boolean then x || jsonb_build_object('blocking', false, 'partial', true) else x end), '[]'::jsonb) into causes from jsonb_array_elements(causes) x;
    end if;
    if q.throttled_reason is not null then causes := causes || jsonb_build_object('code','W_THROTTLED','blocking',false,'detail',q.throttled_reason,'remedy','The pool cannot keep up with demand: add senders or accept the longer projection.'); end if;
  else
    select * into s from outreach_senders where id = p_sender;
    if not outreach_client_visible(ws, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
    target := 'Sender "' || coalesce(s.display_name,'') || '"';
    causes := causes || outreach__sender_causes(p_sender, array['invite','message','profile_view','inmail','email']);
    select count(*) into live from outreach_enrollments x where x.sender_id = p_sender and x.status in ('active','waiting_connection','waiting_delay','waiting_task');
    select count(*) into queued from outreach_actions a where a.sender_id = p_sender and a.status = 'queued';
    notes := notes || to_jsonb(format('%s live lead(s), %s planned action(s)', live, queued));
    if live = 0 then causes := causes || jsonb_build_object('code','W_NO_DEMAND','blocking',false,'detail','No leads are assigned to this sender','remedy','Add it to a sequence and enrol leads.'); end if;
  end if;

  select coalesce(jsonb_agg(x), '[]'::jsonb) into blocking from jsonb_array_elements(causes) x where (x->>'blocking')::boolean;
  first_text := coalesce(blocking->0->>'detail', causes->0->>'detail');
  return jsonb_build_object('target', target, 'blocked', jsonb_array_length(blocking) > 0,
    'reason', case when jsonb_array_length(blocking) > 0 then first_text when jsonb_array_length(causes) > 0 then 'Nothing is blocking. ' || first_text else 'Nothing is blocking.' end,
    'causes', causes, 'notes', notes, 'rule', 'Never respond to a cap, schedule or health block by raising volume elsewhere.');
end $$;

-- Stall + running-dry detection, run by outreach-worker-health every cycle. Returns the alerts that still need an email.
create or replace function outreach_detect_stalls() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q record; s record; diag jsonb; stalled boolean; live int; movable int; recent int; planned int; opened jsonb := '[]'; resolved int := 0; aid uuid; per_day numeric; first_nodes text[]; backlog int; days_left numeric;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;

  for q in select * from outreach_sequences where status = 'active' loop
    select count(*) filter (where e.status in ('active','waiting_connection','waiting_delay','waiting_task')),
           -- "movable" = leads that SHOULD be producing actions now: not in a delay, not waiting for acceptance or a human
           count(*) filter (where e.status = 'active' and coalesce(e.wait_until, e.node_entered_at) < now() - interval '30 minutes')
      into live, movable from outreach_enrollments e where e.sequence_id = q.id;
    stalled := false;
    if live > 0 and movable > 0 then
      select count(*) into recent from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
       where e.sequence_id = q.id and a.status = 'sent' and a.executed_at > now() - interval '26 hours';
      select count(*) into planned from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
       where e.sequence_id = q.id and a.status in ('queued','reserved') and a.scheduled_for < now() + interval '26 hours';
      if recent = 0 and planned = 0 then
        -- executed nothing in the last full window and nothing planned for the next one; only a stall if some pool sender HAD a window
        if exists (select 1 from unnest(q.sender_pool) sid where exists (select 1 from outreach_schedule_windows(sid, (now() at time zone 'utc')::date - 1))
                                                              or exists (select 1 from outreach_schedule_windows(sid, (now() at time zone 'utc')::date))) then
          stalled := true;
        end if;
      end if;
    end if;
    if stalled then
      diag := outreach_why_not_sending(q.id, null, null);
      if q.stalled_at is null then
        update outreach_sequences set stalled_at = now(), stalled_reason = diag->>'reason' where id = q.id;
        aid := null;
        insert into outreach_alerts(workspace_id, client_id, kind, entity, entity_id, label, reason, detail)
        values (q.workspace_id, q.client_id, 'sequence_stalled', 'sequence', q.id, q.name, diag->>'reason', jsonb_build_object('causes', diag->'causes', 'movable_leads', movable))
        on conflict do nothing returning id into aid;
        if aid is not null then
          perform outreach_emit_event(q.workspace_id, 'sequence.stalled', jsonb_build_object('id', q.id, 'name', q.name, 'reason', diag->>'reason', 'leads_waiting', movable));
          opened := opened || jsonb_build_object('alert_id', aid, 'kind', 'sequence_stalled', 'workspace_id', q.workspace_id, 'entity_id', q.id, 'label', q.name, 'reason', diag->>'reason');
        end if;
      else
        update outreach_sequences set stalled_reason = diag->>'reason' where id = q.id and stalled_reason is distinct from diag->>'reason';
      end if;
    elsif q.stalled_at is not null then
      update outreach_sequences set stalled_at = null, stalled_reason = null where id = q.id;
      update outreach_alerts set resolved_at = now() where kind = 'sequence_stalled' and entity_id = q.id and resolved_at is null;
      resolved := resolved + 1;
      perform outreach_emit_event(q.workspace_id, 'sequence.recovered', jsonb_build_object('id', q.id, 'name', q.name));
    end if;
  end loop;
  -- sequences that stopped being active no longer count as stalled
  update outreach_alerts a set resolved_at = now() where a.kind = 'sequence_stalled' and a.resolved_at is null
     and not exists (select 1 from outreach_sequences qq where qq.id = a.entity_id and qq.status = 'active');
  update outreach_sequences set stalled_at = null, stalled_reason = null where stalled_at is not null and status <> 'active';

  -- running dry: a sender in an active sequence has < 2 days of first-step work left
  for s in select sd.* from outreach_senders sd where sd.status = 'ok' and sd.deleted_at is null and sd.provider = 'LINKEDIN'
             and exists (select 1 from outreach_sequences qq where qq.status = 'active' and sd.id = any(qq.sender_pool)) loop
    -- backlog = leads of this sender that have not had any outbound step yet (they are "first-step work")
    select count(*) into backlog from outreach_enrollments e
     where e.sender_id = s.id and e.status in ('active','waiting_delay','waiting_task')
       and not exists (select 1 from outreach_actions a where a.enrollment_id = e.id and a.status = 'sent' and not coalesce((a.payload->>'prefetch')::boolean,false));
    per_day := greatest(outreach_effective_cap(s.id, 'invite'), 1);
    days_left := backlog / per_day;
    if days_left < 2 and exists (select 1 from outreach_enrollments e where e.sender_id = s.id) then
      if s.running_dry_at is null then
        update outreach_senders set running_dry_at = now() where id = s.id;
        aid := null;
        insert into outreach_alerts(workspace_id, client_id, kind, entity, entity_id, label, reason, detail)
        values (s.workspace_id, s.client_id, 'sender_running_dry', 'sender', s.id, s.display_name,
                format('%s has %s new lead(s) left: about %s day(s) of work at its current allowance', coalesce(s.display_name,'Sender'), backlog, round(days_left, 1)),
                jsonb_build_object('backlog', backlog, 'per_day', per_day, 'days_left', round(days_left,1)))
        on conflict do nothing returning id into aid;
        if aid is not null then
          perform outreach_emit_event(s.workspace_id, 'sender.running_dry', jsonb_build_object('id', s.id, 'name', s.display_name, 'leads_left', backlog, 'days_left', round(days_left,1)));
          opened := opened || jsonb_build_object('alert_id', aid, 'kind', 'sender_running_dry', 'workspace_id', s.workspace_id, 'entity_id', s.id, 'label', s.display_name,
                                                 'reason', format('%s new lead(s) left, about %s day(s) of work', backlog, round(days_left,1)));
        end if;
      end if;
    elsif s.running_dry_at is not null and days_left >= 3 then
      update outreach_senders set running_dry_at = null where id = s.id;
      update outreach_alerts set resolved_at = now() where kind = 'sender_running_dry' and entity_id = s.id and resolved_at is null;
      resolved := resolved + 1;
    end if;
  end loop;
  update outreach_senders sd set running_dry_at = null where running_dry_at is not null
     and not exists (select 1 from outreach_sequences qq where qq.status = 'active' and sd.id = any(qq.sender_pool));
  update outreach_alerts a set resolved_at = now() where a.kind = 'sender_running_dry' and a.resolved_at is null
     and exists (select 1 from outreach_senders sd where sd.id = a.entity_id and sd.running_dry_at is null);

  -- imports that failed are alerts too (risk table: "the stall alerts cover imports")
  with ins as (
    insert into outreach_alerts(workspace_id, client_id, kind, entity, entity_id, label, reason, detail)
    select j.workspace_id, j.client_id, 'import_failed', 'import', j.id, initcap(replace(j.kind::text,'_',' ')) || ' import', 'Import failed: ' || coalesce(j.error,'unknown error'), jsonb_build_object('fetched', j.fetched)
      from outreach_import_jobs j where j.status = 'failed' and j.finished_at > now() - interval '2 days'
    on conflict do nothing
    returning id, workspace_id, entity_id, label, reason)
  select opened || coalesce(jsonb_agg(jsonb_build_object('alert_id', ins.id, 'kind', 'import_failed', 'workspace_id', ins.workspace_id, 'entity_id', ins.entity_id, 'label', ins.label, 'reason', ins.reason)), '[]'::jsonb)
    into opened from ins;
  update outreach_alerts set resolved_at = now() where kind = 'import_failed' and resolved_at is null and opened_at < now() - interval '3 days';

  -- holds nobody looked at: exit after the hold limit so no lead is stuck forever
  perform outreach_complete_enrollment(e.id, 'exited_replied', 'hold_expired')
     from outreach_enrollments e join outreach_sequences qq on qq.id = e.sequence_id
    where e.status = 'paused' and e.held_at is not null and e.held_at < now() - make_interval(days => greatest(coalesce((qq.settings->>'hold_max_days')::int, 30), 1));

  return jsonb_build_object('opened', opened, 'resolved', resolved);
end $$;
revoke execute on function outreach_detect_stalls() from public, anon, authenticated;

create or replace function outreach_mark_alerts_notified(p_ids uuid[]) returns void
language sql security definer set search_path = public, extensions as $$ update outreach_alerts set notified_at = now() where id = any(p_ids) $$;
revoke execute on function outreach_mark_alerts_notified(uuid[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Dashboard + client page now read the same facts
-- -----------------------------------------------------------------------------
create or replace function outreach_dashboard(p_ws uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare res jsonb; z text := outreach_ws_tz(p_ws); today date; wk jsonb; td jsonb;
begin
  perform outreach_require(p_ws, 'client_viewer');
  today := (now() at time zone z)::date;
  select totals into wk from outreach__grouped(p_ws, null, today - 6, today, 'none', '{}');
  select totals into td from outreach__grouped(p_ws, null, today, today, 'none', '{}');
  wk := coalesce(wk, outreach__totals_from('{}'::jsonb)); td := coalesce(td, outreach__totals_from('{}'::jsonb));
  select jsonb_build_object(
    'senders', coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'display_name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason', s.status_reason,
                 'health_score', s.health_score, 'warmup_level', s.warmup_level, 'client_id', s.client_id, 'paused_until', s.paused_until, 'running_dry', s.running_dry_at is not null, 'today', outreach_sender_today(s.id)) order by s.display_name)
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
        select case a.entity when 'sequence' then 'sequence_stalled' when 'sender' then 'sender_running_dry' else 'import_failed' end, a.entity_id::text, a.label, a.reason from outreach_alerts a
          where a.workspace_id = p_ws and a.resolved_at is null and a.kind in ('sequence_stalled','sender_running_dry','import_failed') and outreach_client_visible(p_ws, a.client_id)
        union all
        select 'sequence', q.id::text, q.name, q.throttled_reason from outreach_sequences q
          where q.workspace_id = p_ws and q.status = 'active' and q.throttled_reason is not null and q.stalled_at is null and outreach_client_visible(p_ws, q.client_id)
        union all
        select 'held_leads', q.id::text, q.name, count(*) || ' lead(s) replied and are held for review' from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id
          where e.workspace_id = p_ws and e.held_at is not null and e.status = 'paused' and outreach_client_visible(p_ws, q.client_id) group by q.id, q.name
        union all
        select 'failed_leads', q.id::text, q.name, count(*) || ' failed lead(s) need a decision (retry, skip or exit)' from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id
          where e.workspace_id = p_ws and e.status = 'failed' and e.completed_at > now() - interval '30 days' and q.status <> 'archived' and outreach_client_visible(p_ws, q.client_id) group by q.id, q.name
        union all
        select 'ai_review', b.id::text, v.name, 'AI lines are waiting for review' from outreach_ai_batches b join outreach_ai_variables v on v.id = b.variable_id
          where b.workspace_id = p_ws and b.status = 'review'
      ) x), '[]'::jsonb),
    'replies_awaiting', (select count(*) from outreach_chats c where c.workspace_id = p_ws and c.unread and c.intent in ('interested','question') and not c.archived and outreach_client_visible(p_ws, c.client_id)),
    'unread', (select count(*) from outreach_chats c where c.workspace_id = p_ws and c.unread and not c.archived and outreach_client_visible(p_ws, c.client_id)),
    'tasks_open', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and outreach_client_visible(p_ws, t.client_id)),
    'drafts_awaiting', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and t.kind = 'review_ai_draft' and outreach_client_visible(p_ws, t.client_id)),
    'ai_lines_awaiting', (select count(*) from outreach_ai_values v where v.workspace_id = p_ws and v.status = 'generated'),
    'enrollments_live', (select count(*) from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id where e.workspace_id = p_ws and e.status in ('active','waiting_connection','waiting_delay','waiting_task') and outreach_client_visible(p_ws, q.client_id)),
    'sent_today', (td->>'invites')::numeric + (td->>'messages')::numeric + (td->>'inmails')::numeric + (td->>'emails')::numeric + (td->>'profile_views')::numeric + (td->>'likes')::numeric + (td->>'comments')::numeric + (td->>'endorsements')::numeric + (td->>'follows')::numeric + (td->>'withdrawn')::numeric,
    'queued_today', (select count(*) from outreach_actions a where a.workspace_id = p_ws and a.status = 'queued' and a.scheduled_for < now() + interval '24 hours'),
    'leads_total', (select count(*) from outreach_leads l where l.workspace_id = p_ws and outreach_client_visible(p_ws, l.client_id)),
    'today', td, 'last_7_days', wk,
    -- kept for older clients of this RPC: same numbers, legacy key names
    'stats_7d', jsonb_build_object('invites', wk->'invites', 'messages', (wk->>'messages')::numeric + (wk->>'inmails')::numeric + (wk->>'emails')::numeric, 'accepted', wk->'accepted', 'replies', wk->'replies', 'interested', wk->'interested', 'reply_rate', wk->'reply_rate', 'acceptance_rate', wk->'acceptance_rate')
  ) into res;
  return res;
end $$;

create or replace function outreach_client_stats(p_client uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid; r jsonb; t jsonb;
begin
  select workspace_id into ws from outreach_clients where id = p_client;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  r := outreach_report_client(p_client, ((now() at time zone outreach_ws_tz(ws))::date - 29), (now() at time zone outreach_ws_tz(ws))::date);
  t := r->'totals';
  return jsonb_build_object('leads', r->'leads', 'senders', jsonb_array_length(r->'senders'),
    'invites_30d', t->'invites', 'accepted_30d', t->'accepted', 'messages_30d', (t->>'messages')::numeric + (t->>'inmails')::numeric + (t->>'emails')::numeric,
    'replies_30d', t->'replies', 'interested_30d', t->'interested', 'meetings_30d', t->'meetings', 'reply_rate_30d', t->'reply_rate', 'acceptance_rate_30d', t->'acceptance_rate',
    'enrollments_live', r->'live_enrollments', 'report', r);
end $$;

-- saved date ranges
create or replace function outreach_save_range(p_ws uuid, p_name text, p_preset text default null, p_from date default null, p_to date default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare rid uuid;
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_preset is null and (p_from is null or p_to is null) then raise exception 'E_PAYLOAD_INVALID: preset or from/to required'; end if;
  insert into outreach_saved_ranges(workspace_id, user_id, name, preset, from_date, to_date) values (p_ws, auth.uid(), left(p_name, 60), p_preset, p_from, p_to) returning id into rid;
  return rid;
end $$;

do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_report_overview(uuid,uuid,date,date,jsonb)','outreach_report_sequences(uuid,uuid,date,date)','outreach_report_senders(uuid,uuid,date,date)',
    'outreach_report_clients(uuid,date,date)','outreach_report_client(uuid,date,date)','outreach_report_intents(uuid,uuid,date,date,text,jsonb)',
    'outreach_report_reply_threads(uuid,uuid,date,date,text,jsonb)','outreach_report_funnel(uuid,uuid,date,date,jsonb)','outreach_ab_results(uuid,text,date,date)',
    'outreach_promote_variant(uuid,text,text)','outreach_report_sequence(uuid,date,date)','outreach_sender_insights(uuid)','outreach_report_sender(uuid,date,date)',
    'outreach_report_cost(uuid,uuid,date,date)','outreach_why_not_sending(uuid,uuid,uuid)','outreach_save_range(uuid,text,text,date,date)','outreach_metric_definitions()']) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
