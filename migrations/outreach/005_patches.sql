-- =============================================================================
-- Outreach Platform — 005 patches (additive)
-- =============================================================================

-- consume a reservation (used+1, reserved-1) for inline budgeted calls (relation verify, search pages, polls)
create or replace function outreach_consume_budget(p_sender uuid, p_day date, p_type outreach_action_type_t) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_sender_budgets set used = used + 1, reserved = greatest(reserved - 1, 0)
  where sender_id = p_sender and day = p_day and action_type = p_type
$$;
revoke execute on function outreach_consume_budget(uuid,date,outreach_action_type_t) from public, anon, authenticated;

-- allow queue_action for import/withdraw actions without an enrollment (already supported) — grant to service only
revoke execute on function outreach_queue_action(uuid,text,outreach_action_type_t,timestamptz,jsonb,uuid,uuid,uuid,uuid) from public, anon, authenticated;
revoke execute on function outreach_schedule_windows(uuid,date) from public, anon;
revoke execute on function outreach_in_schedule(uuid,timestamptz) from public, anon;
revoke execute on function outreach_sender_local_date(uuid,timestamptz) from public, anon;
revoke execute on function outreach_weekly_invites_used(uuid,date) from public, anon;
revoke execute on function outreach_upsert_lead(uuid,jsonb,text,uuid) from public, anon;

-- lead timeline helper for the lead detail page
create or replace function outreach_lead_timeline(p_lead uuid)
returns table(at timestamptz, kind text, title text, data jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then return; end if;
  perform outreach_require(ws, 'client_viewer');
  return query
    select a.executed_at, 'action'::text, a.action_type::text || ' ' || a.status::text, jsonb_build_object('id', a.id, 'sender_id', a.sender_id, 'node_id', a.node_id, 'decision', a.decision, 'error_code', a.error_code)
      from outreach_actions a where a.lead_id = p_lead and a.executed_at is not null
    union all
    select m.sent_at, 'message'::text, case when m.direction = 'in' then 'Reply received' else 'Message sent' end, jsonb_build_object('id', m.id, 'chat_id', m.chat_id, 'text', left(coalesce(m.text,''), 200), 'intent', m.intent)
      from outreach_messages m join outreach_chats c on c.id = m.chat_id where c.lead_id = p_lead
    union all
    select e.created_at, 'enrollment'::text, 'Enrolled', jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'sender_id', e.sender_id)
      from outreach_enrollments e where e.lead_id = p_lead
    union all
    select e.completed_at, 'enrollment'::text, 'Enrollment ' || e.status::text, jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'reason', e.exit_reason)
      from outreach_enrollments e where e.lead_id = p_lead and e.completed_at is not null
    union all
    select t.created_at, 'task'::text, t.title, jsonb_build_object('id', t.id, 'kind', t.kind, 'completed_at', t.completed_at)
      from outreach_tasks t where t.lead_id = p_lead
    order by 1 desc nulls last
    limit 300;
end $$;

-- client viewer stats
create or replace function outreach_client_stats(p_client uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid; res jsonb;
begin
  select workspace_id into ws from outreach_clients where id = p_client;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'client_viewer');
  if not outreach_client_visible(ws, p_client) then raise exception 'E_FORBIDDEN'; end if;
  select jsonb_build_object(
    'leads', (select count(*) from outreach_leads l where l.workspace_id = ws and l.client_id = p_client),
    'senders', (select count(*) from outreach_senders s where s.workspace_id = ws and s.client_id = p_client and s.deleted_at is null),
    'invites_30d', (select count(*) from outreach_actions a join outreach_senders s on s.id = a.sender_id where s.client_id = p_client and a.action_type = 'invite' and a.status = 'sent' and a.executed_at > now() - interval '30 days'),
    'accepted_30d', (select count(*) from outreach_lead_sender_state x join outreach_senders s on s.id = x.sender_id where s.client_id = p_client and x.invite_accepted_at > now() - interval '30 days'),
    'messages_30d', (select count(*) from outreach_actions a join outreach_senders s on s.id = a.sender_id where s.client_id = p_client and a.action_type in ('message','inmail','email') and a.status = 'sent' and a.executed_at > now() - interval '30 days'),
    'replies_30d', (select count(*) from outreach_messages m join outreach_chats c on c.id = m.chat_id where c.client_id = p_client and m.direction = 'in' and m.sent_at > now() - interval '30 days'),
    'interested_30d', (select count(*) from outreach_chats c where c.client_id = p_client and c.intent = 'interested' and c.last_message_at > now() - interval '30 days'),
    'enrollments_live', (select count(*) from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id where q.client_id = p_client and e.status in ('active','waiting_connection','waiting_delay','waiting_task'))
  ) into res;
  return res;
end $$;

-- sequence stats summary for the list page
create or replace function outreach_sequence_summary(p_ws uuid)
returns table(sequence_id uuid, live int, completed int, replied int, sent int, queued int)
language sql stable security definer set search_path = public, extensions as $$
  select s.id,
    (select count(*)::int from outreach_enrollments e where e.sequence_id = s.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
    (select count(*)::int from outreach_enrollments e where e.sequence_id = s.id and e.status = 'completed'),
    (select count(*)::int from outreach_enrollments e where e.sequence_id = s.id and e.status = 'exited_replied'),
    (select coalesce(sum(n.sent),0)::int from outreach_node_stats n where n.sequence_id = s.id),
    (select coalesce(sum(n.queued),0)::int from outreach_node_stats n where n.sequence_id = s.id)
  from outreach_sequences s where s.workspace_id = p_ws and s.workspace_id in (select outreach_workspace_ids())
$$;
