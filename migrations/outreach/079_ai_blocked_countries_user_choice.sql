-- 079: blocked countries are fully the user's choice.
-- G14 used to apply only while no AI disclosure line was set, and blocked a lead whose country was unknown.
-- Now: Auto turns into a draft only for a lead whose country is known and on the sequence's list; every other
-- lead gets Auto. The disclosure line is independent (still appended to every AI-sent message).
-- outreach_ai_reply_prepare_send is otherwise unchanged from 041; outreach_ai_reply_defaults drops its EU/EEA list.

create or replace function outreach_ai_reply_prepare_send(p_run uuid, p_ignore_window boolean default false, p_country text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; s outreach_senders%rowtype; mp outreach_master_prompts%rowtype; eff jsonb; pol jsonb;
        newest timestamptz; later_ids uuid[]; last_dir text; day date; ai_today int; combined int; cap int; why text; aid uuid; txt text; nid uuid; supp text;
        l outreach_leads%rowtype; blocked text[]; hpos int; lpos int; tags text[];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then return jsonb_build_object('ok', false, 'to', null, 'why', 'not_found'); end if;
  perform outreach__ai_chat_lock(r.chat_id);
  select * into r from outreach_ai_reply_runs where id = p_run for update;
  if r.status <> 'sending' then return jsonb_build_object('ok', false, 'to', null, 'why', 'not_sending'); end if;
  select * into c from outreach_chats where id = r.chat_id for update;
  select * into s from outreach_senders where id = r.sender_id;
  -- 0. handed off meanwhile (a person wrote, a stop rule fired elsewhere): never send
  if c.ai_handed_off_at is not null then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'handed_off' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'handed_off');
  end if;
  -- 1. a newer message from them → redraft on everything unanswered
  select max(sent_at) into newest from outreach_messages where id = any(r.inbound_message_ids);
  select array_agg(m.id order by m.sent_at) into later_ids from outreach_messages m
   where m.chat_id = c.id and m.direction = 'in' and m.event_type is null and m.sent_at > newest and not (m.id = any(r.inbound_message_ids));
  if later_ids is not null or cardinality(r.followup_inbound_ids) > 0 then
    update outreach_ai_reply_runs set status = 'superseded', error = 'newer_inbound' where id = r.id;
    eff := outreach__ai_effective(c.id); pol := eff->'policy';
    if eff->>'mode' <> 'off' then
      nid := outreach__ai_open_run(c.id, r.inbound_message_ids || coalesce(later_ids, '{}') || r.followup_inbound_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', (r.timings->>'inbound_at')::timestamptz);
    end if;
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'newer_inbound', 'new_run', nid);
  end if;
  -- 8. age
  if r.created_at < now() - interval '24 hours' then
    update outreach_ai_reply_runs set status = 'expired', error = 'older_than_24h' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'expired', 'why', 'older_than_24h');
  end if;
  -- 2. a teammate answered meanwhile (a recorded send, or one of theirs still in flight)
  if exists (select 1 from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sent_at > r.created_at
               and m.origin in ('inbox_user','external_device','ai_draft_sent','ai_edited'))
     or exists (select 1 from outreach_actions a where a.sender_id = r.sender_id and a.lead_id is not distinct from c.lead_id
                  and a.action_type = 'reply' and a.status = 'reserved') then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'human_takeover');
  end if;
  select direction::text into last_dir from outreach_messages where chat_id = c.id and event_type is null and deleted_at is null order by sent_at desc limit 1;
  if last_dir is distinct from 'in' then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'not_our_turn' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'not_our_turn');
  end if;
  -- 3. answered messages deleted / edited
  if exists (select 1 from outreach_messages m where m.id = any(r.inbound_message_ids) and m.deleted_at is not null) then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'message_deleted' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'message_deleted');
  end if;
  if exists (select 1 from outreach_messages m where m.id = any(r.inbound_message_ids) and m.edited_at > r.created_at) then
    update outreach_ai_reply_runs set status = 'superseded', error = 'message_edited' where id = r.id;
    eff := outreach__ai_effective(c.id);
    nid := outreach__ai_open_run(c.id, r.inbound_message_ids, 30, 60, coalesce(eff->>'mode', 'draft'), (r.timings->>'inbound_at')::timestamptz);
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'message_edited', 'new_run', nid);
  end if;
  -- 4. still autopilot: sequence active, consent live, not paused / archived, lead not suppressed
  eff := outreach__ai_effective(c.id);
  if c.archived then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'archived' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'archived');
  end if;
  if c.lead_id is not null then
    select * into l from outreach_leads where id = c.lead_id;
    supp := outreach_lead_suppression_reason(l, c.client_id, r.sequence_id);
    if supp is not null then
      update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'suppressed:' || supp where id = r.id;
      return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'suppressed');
    end if;
  end if;
  if eff->>'mode' = 'off' then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'mode_off' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'mode_off');
  elsif eff->>'mode' = 'draft' then
    update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = array_append(gate_failures, coalesce(eff->>'reason_code', 'mode_draft')) where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', coalesce(eff->>'reason_code', 'mode_draft'));
  end if;
  pol := eff->'policy';
  -- G13 / G14 again: tags, hand-off stage and blocked countries may have changed during the hold
  if l.id is not null then
    select array_agg(lower(t.name::text)) into tags from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = l.id;
    select st.position into lpos from outreach_stages st where st.id = l.stage_id;
    if coalesce(eff->'settings'->>'handoff_stage_id', '') <> '' then
      select st.position into hpos from outreach_stages st where st.id = (eff->'settings'->>'handoff_stage_id')::uuid;
    end if;
    if tags && array['vip','manual_only','manual-only'] or (hpos is not null and lpos is not null and lpos >= hpos) then
      update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'G13'::text where id = r.id;
      return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', 'G13');
    end if;
  end if;
  -- G14 (since 079): only a lead whose country is known and on the sequence's list; the disclosure line plays no part
  select coalesce(array_agg(upper(x)), '{}') into blocked from jsonb_array_elements_text(coalesce(pol->'blocked_countries', '[]'::jsonb)) x;
  if p_country is not null and upper(p_country) = any(blocked) then
    update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'G14'::text where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', 'G14');
  end if;
  -- 5. prompt changed substantively since drafting → redraft on the new version
  select * into mp from outreach_master_prompts where id = (eff->'master_prompt'->>'id')::uuid;
  if mp.id is distinct from r.master_prompt_id or mp.substantive_version > coalesce(r.master_prompt_version, 0) then
    update outreach_ai_reply_runs set status = 'superseded', error = 'master_prompt_changed' where id = r.id;
    nid := outreach__ai_open_run(c.id, r.inbound_message_ids, 30, 60, 'autopilot', (r.timings->>'inbound_at')::timestamptz);
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'master_prompt_changed', 'new_run', nid);
  end if;
  -- 6. sender healthy and inside its working hours
  if s.status <> 'ok' or s.deleted_at is not null or (s.paused_until is not null and s.paused_until > now()) then
    update outreach_ai_reply_runs set status = 'scheduled', scheduled_send_at = now() + interval '30 minutes', error = 'sender_not_ok' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'scheduled', 'why', 'sender_not_ok');
  end if;
  if not p_ignore_window and not outreach_in_schedule(s.id, now()) then
    return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'why', 'outside_window');
  end if;
  -- 7. caps: AI sends / day (sends in flight count), message + reply + ai_reply ≤ 100 / day, then the ledger
  day := outreach_sender_local_date(s.id, now());
  select count(*) filter (where a.action_type = 'ai_reply'), count(*) into ai_today, combined from outreach_actions a
   where a.sender_id = s.id and a.action_type in ('message','new_chat','inmail','reply','ai_reply')
     and ((a.status = 'sent' and a.executed_at >= now() - interval '36 hours' and outreach_sender_local_date(s.id, a.executed_at) = day)
          or (a.status = 'reserved' and a.action_type = 'ai_reply'));
  cap := least(40, coalesce((pol->>'max_ai_sends_per_sender_day')::int, 25));
  if ai_today >= cap then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', true, 'why', 'daily_ai_cap'); end if;
  if combined >= 100 then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', true, 'why', 'combined_cap'); end if;
  why := outreach__reserve_why(s.id, day, 'ai_reply', now());
  if why <> 'ok' then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', why = 'day', 'why', 'ledger_' || why); end if;
  txt := r.draft_text || case when nullif(btrim(coalesce(pol->>'disclosure', '')), '') is not null then E'\n\n' || btrim(pol->>'disclosure') else '' end;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, reserved_at, idempotency_key, payload)
  values (r.workspace_id, s.id, c.lead_id, 'ai_reply', now(), 'reserved', now(), 'ai_reply:' || r.id::text || ':' || r.send_attempts::text || ':' || extract(epoch from now())::bigint,
          jsonb_build_object('text', txt, 'run_id', r.id, 'by', r.dispatched_by))
  returning id into aid;
  update outreach_ai_reply_runs set action_id = aid, final_text = txt where id = r.id;
  return jsonb_build_object('ok', true, 'action_id', aid, 'text', txt, 'day', day);
end $$;

create or replace function outreach_ai_reply_defaults() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'mode', 'draft', 'delay_min_s', 240, 'delay_max_s', 1200, 'debounce_quiet_s', 120, 'debounce_max_s', 600,
    'max_ai_sends_per_sender_day', 25, 'stale_after_h', 12, 'human_takeover_pause_h', 72, 'disclosure', null,
    'blocked_countries', '[]'::jsonb)
$$;
