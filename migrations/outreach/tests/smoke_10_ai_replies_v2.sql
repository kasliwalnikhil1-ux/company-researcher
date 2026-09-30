-- Smoke test — 039–042 AI replies v2 (ai-replies-changes.md; docs/outreach/AI-REPLIES-V2-CONTRACT.md). Also carries the v1.1 flows
-- that smoke_09 covered (origin / hash, enqueue, claim, finalize, dispatch, human sends) on the v2 resolver.
-- Builds fixtures, asserts, then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_10_ai_replies_v2.sql
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; b boolean;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid;
  s1 uuid; s2 uuid; l1 uuid; l2 uuid; q1 uuid; q2 uuid; e1 uuid; e2 uuid; a_seq uuid; a_seq2 uuid;
  c1 uuid; c2 uuid; m_out uuid; m_in1 uuid; m_in2 uuid; m_in3 uuid; m_x uuid;
  mp uuid; r1 uuid; r2 uuid; r3 uuid; aid uuid; tid uuid; sc uuid; fq uuid; gid uuid; ks uuid; srs outreach_sequence_reply_settings%rowtype;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  t0 timestamptz := now() - interval '3 days';
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke10', 'smoke10-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner10@test.local');
  insert into outreach_members(workspace_id, user_id, role, email, client_ids) values (ws, u_member, 'member', 'member10@test.local', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer10@test.local', array[ca]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Naman', 'ok', 's10a-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', u_owner, 'owner10@test.local') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_email)
    values (ws, cb, 'LINKEDIN', 'Other', 'ok', 's10b-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', 'client10@test.local') returning id into s2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company, location)
    values (ws, ca, 'ann10-' || left(ws::text, 8), 'Ann Lee', 'Ann', 'Acme', 'Mumbai, India') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name) values (ws, cb, 'ben10-' || left(ws::text, 8), 'Ben Roe') returning id into l2;
  -- q1 through the RPC (settings + prompt created at creation); q2 inserted raw (settings created lazily)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  q1 := outreach_create_sequence(ws, 'Fintech CFOs', ca);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_sequences set status = 'active', sender_pool = array[s1], created_by = u_owner where id = q1;
  insert into outreach_sequences(workspace_id, client_id, name, status, sender_pool, created_by) values (ws, ca, 'Second wave', 'active', array[s1], u_owner) returning id into q2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, q1, 1, l1, s1, 'exited_replied', t0 - interval '1 day') returning id into e1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, ca, s1, l1, 'c10-1-' || ws, 'LINKEDIN', 'Ann Lee') returning id into c1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, cb, s2, l2, 'c10-2-' || ws, 'LINKEDIN', 'Ben Roe') returning id into c2;

  -- ============================================================ 1. settings + prompt per sequence
  if exists (select 1 from outreach_sequence_reply_settings where sequence_id = q1 and mode = 'draft' and master_prompt_id is not null)
     and (select count(*) from outreach_master_prompt_scenarios where master_prompt_id = (select master_prompt_id from outreach_sequence_reply_settings where sequence_id = q1)) = 7
    then log := log || E'\nok   create_sequence made the settings row (Draft) and a template prompt with 7 scenario cards';
    else fails := fails + 1; log := log || E'\nFAIL create_sequence settings'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_sequence_ai_replies_get(q2);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'mode' = 'draft' and (j->'prompt'->>'stop_present')::boolean and jsonb_array_length(j->'prompt'->'scenarios') = 7 and (j->>'warmup_remaining')::int = 20
     and j->'prompt'->>'body' like '%## Stop when%' and j->'prompt'->>'body' like '%Pricing question: when%'
    then log := log || E'\nok   get on a raw-inserted sequence creates its settings lazily; template has Stop when + compiled cards';
    else fails := fails + 1; log := log || E'\nFAIL lazy settings: ' || left(j::text, 300); end if;
  -- a member limited to client B cannot read client A's sequence settings
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin j := outreach_sequence_ai_replies_get(q1); t := 'read'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_NOT_FOUND%' then log := log || E'\nok   client scope: a client-B member cannot read a client-A sequence''s AI settings';
  else fails := fails + 1; log := log || E'\nFAIL client scope: ' || t; end if;

  -- ============================================================ 2. origin / hash, sequence resolution, enqueue
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s1, l1, e1, 'n1', 'message', t0, 'sent', t0, 'k10-seq-' || ws, '{"text":"Hi Ann, saw your post on treasury ops"}') returning id into a_seq;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm10-out-' || ws, 'out', 'Hi Ann, saw your post on treasury ops', t0, a_seq) returning id into m_out;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-in1-' || ws, 'in', 'Thanks! What does your team do exactly?', t0 + interval '1 hour') returning id into m_in1;
  if (select origin from outreach_messages where id = m_out) = 'sequence' and (select origin from outreach_messages where id = m_in1) = 'prospect'
     and (select text_sha256 from outreach_messages where id = m_in1) = outreach__text_sha('  thanks!   what does your team do EXACTLY? ')
     and (select replied_to_action_id from outreach_messages where id = m_in1) = a_seq
    then log := log || E'\nok   origin sequence / prospect, normalised hash, reply attributed to the sequence step';
    else fails := fails + 1; log := log || E'\nFAIL origin/hash'; end if;
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'off' and j->>'reason_code' = 'no_sequence' and j->>'fallback' is not null then log := log || E'\nok   before resolution: off / no_sequence (Draft with AI has a fallback prompt)';
  else fails := fails + 1; log := log || E'\nFAIL effective before: ' || j::text; end if;
  j := outreach_ai_reply_enqueue(c1, m_in1);
  r1 := (j->>'run_id')::uuid;
  if j->>'action' = 'created' and (select reply_sequence_id from outreach_chats where id = c1) = q1 and (select sequence_id from outreach_ai_reply_runs where id = r1) = q1
     and (select mode from outreach_ai_reply_runs where id = r1) = 'draft' and (select ai_session_kind from outreach_chats where id = c1) = 'normal'
     and (select ai_run_status from outreach_chats where id = c1) = 'debouncing'
    then log := log || E'\nok   enqueue resolves the sequence from the answered step, opens a Draft run, starts a normal session';
    else fails := fails + 1; log := log || E'\nFAIL enqueue create: ' || j::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-in2-' || ws, 'in', 'And roughly what does it cost?', t0 + interval '1 hour 1 minute') returning id into m_in2;
  j := outreach_ai_reply_enqueue(c1, m_in2);
  if j->>'action' = 'appended' and (select cardinality(inbound_message_ids) from outreach_ai_reply_runs where id = r1) = 2 then log := log || E'\nok   a second message in the burst is appended';
  else fails := fails + 1; log := log || E'\nFAIL append: ' || j::text; end if;
  j := outreach_ai_reply_enqueue(c1, m_in2);
  if j->>'action' = 'duplicate' then log := log || E'\nok   the same message twice is a no-op'; else fails := fails + 1; log := log || E'\nFAIL duplicate: ' || j::text; end if;

  -- ============================================================ 3. mode Auto needs consent (per sender, once)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_sequence_ai_replies_set(q1, '{"mode":"autopilot","pitch_after_replies":1,"inactivity_days":7}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach__ai_effective(c1);
  if j->>'mode' = 'autopilot' and (j->>'pitch_after_replies')::int = 1 and j->'senders'->0->>'consent' = 'missing' and (j->>'applies_to')::int = 1
     and k->>'mode' = 'draft' and k->>'reason_code' = 'consent_missing' and (k->'settings'->>'min_exchanges_before_pitch')::int = 1
    then log := log || E'\nok   Auto without consent → Draft (consent_missing); pitch_after flows into the settings block';
    else fails := fails + 1; log := log || E'\nFAIL set auto: ' || left(j::text, 200) || ' | ' || left(k::text, 200); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_ai_consent_grant_operator(s1); t := 'granted'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_%' then log := log || E'\nok   only the account owner can approve AI replies for it in the app';
  else fails := fails + 1; log := log || E'\nFAIL member granted consent: ' || t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_ai_consent_grant_operator(s1);
  perform outreach_ai_consent_grant_operator(s1);   -- twice: one live row per sender
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach__ai_effective(c1);
  if k->>'mode' = 'autopilot' and (k->>'can_autopilot')::boolean and (select count(*) from outreach_ai_reply_consent where sender_id = s1 and revoked_at is null) = 1
     and (select count(*) from outreach_ai_reply_consent where sender_id = s1 and revoked_reason = 'replaced') = 1
    then log := log || E'\nok   owner consent → Auto; no graduation gate; one live consent per sender';
    else fails := fails + 1; log := log || E'\nFAIL consent: ' || k::text; end if;

  -- ============================================================ 4. claim → gate facts → finalize (T3 backstop) → Draft with AI
  update outreach_ai_reply_runs set debounce_until = now() - interval '10 seconds' where id = r1;
  update outreach_messages set classified_at = now(), intent = 'question', ai_flags = array['asked_offer','pricing'] where id in (m_in1, m_in2);
  n := (select count(*) from outreach_ai_reply_claim(25) x where x.id = r1);
  j := outreach_ai_reply_gate_facts(r1);
  if n = 1 and (j->>'contacted_first')::boolean and jsonb_array_length(j->'burst') = 2 and jsonb_array_length(j->'scenarios') = 7 and j->'effective'->>'mode' = 'autopilot'
     and (j->'settings_row'->>'warmup_remaining')::int = 20 and j->'chat'->>'session_kind' = 'normal' and j->'master_prompt'->>'id' is not null
    then log := log || E'\nok   gate facts v2: cards, settings row, session, prompt';
    else fails := fails + 1; log := log || E'\nFAIL gate facts: ' || left(j::text, 400); end if;
  mp := (j->'master_prompt'->>'id')::uuid;
  -- T3: a scheduling link forces stop_after_send at finalize
  j := outreach_ai_reply_finalize(r1, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Happy to walk you through it: https://cal.com/naman/15min',
          'stage_before', 'engage', 'stage_after', 'next_step', 'move', 'schedule', 'master_prompt_id', mp, 'master_prompt_version', 1,
          'scheduled_send_at', now() - interval '1 minute', 'timings', jsonb_build_object('scheduled_at', now())));
  if (j->>'ok')::boolean and (select stop_after_send from outreach_ai_reply_runs where id = r1) and (select stop_rule from outreach_ai_reply_runs where id = r1) = 'calendar link'
     and (select count(*) from outreach_ai_lead_notes_queue where run_id = r1) = 1
    then log := log || E'\nok   finalize: a calendar link forces stop_after_send (T3); the burst is queued for lead notes';
    else fails := fails + 1; log := log || E'\nFAIL T3 finalize: ' || j::text; end if;
  -- Draft with AI on a scheduled auto run: without regenerate the existing draft is returned; with it the send is taken over
  j := outreach_ai_reply_manual_open(c1, u_owner, 'inbox', null, 1, false);
  if j->>'source' = 'existing_auto' and (j->>'run_id')::uuid = r1 and j->>'status' = 'scheduled' then log := log || E'\nok   Draft with AI shows the scheduled auto draft first (existing_auto)';
  else fails := fails + 1; log := log || E'\nFAIL manual open existing: ' || j::text; end if;
  j := outreach_ai_reply_manual_open(c1, u_owner, 'inbox', 'shorter, ask about budget', 2, true);
  r2 := (j->>'run_id')::uuid;
  if j->>'source' = 'new' and (select status from outreach_ai_reply_runs where id = r1) = 'cancelled' and (select cancel_reason from outreach_ai_reply_runs where id = r1) = 'taken_manual'
     and (select status from outreach_ai_reply_runs where id = r2) = 'drafting' and (select trigger_kind from outreach_ai_reply_runs where id = r2) = 'manual'
     and (select guidance from outreach_ai_reply_runs where id = r2) = 'shorter, ask about budget' and (select cardinality(inbound_message_ids) from outreach_ai_reply_runs where id = r2) = 2
    then log := log || E'\nok   regenerate takes the scheduled send over (taken_manual) and opens a manual run on the unanswered messages';
    else fails := fails + 1; log := log || E'\nFAIL manual open new: ' || j::text; end if;
  -- a manual run never schedules or escalates: it becomes a draft with warnings
  j := outreach_ai_reply_finalize(r2, 'escalated', jsonb_build_object('decision', 'escalate', 'draft_text', 'We make 60-second product films. What budget did you have in mind?',
          'escalation_reasons', jsonb_build_array('verifier'), 'warnings', jsonb_build_array(jsonb_build_object('code', 'verifier', 'text', 'x')), 'master_prompt_id', mp, 'master_prompt_version', 1));
  if (j->>'ok')::boolean and (select status from outreach_ai_reply_runs where id = r2) = 'draft_ready' and jsonb_array_length((select warnings from outreach_ai_reply_runs where id = r2)) = 1
     and not exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_escalation')
    then log := log || E'\nok   manual finalize → draft_ready with warnings, no escalation task';
    else fails := fails + 1; log := log || E'\nFAIL manual finalize: ' || j::text; end if;

  -- ============================================================ 5. the person sends the draft with a calendar link → handoff (calendar_sent)
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, sent_by)
    values (ws, c1, 'm10-sent1-' || ws, 'out', 'We make 60-second product films. Book a slot: https://calendly.com/naman/15', t0 + interval '2 hours', u_owner) returning id into m_x;
  j := outreach_ai_reply_on_human_send(c1, m_x, r2, 0.3, false, u_owner);
  if j->>'origin' = 'ai_edited' and (j->>'used_run')::boolean and j->'handoff'->>'reason' = 'calendar_sent'
     and (select ai_handed_off_at from outreach_chats where id = c1) is not null and (select ai_handoff_reason from outreach_chats where id = c1) = 'calendar_sent'
     and exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_handoff' and source = 'system' and completed_at is null and assigned_to = u_owner)
     and exists (select 1 from outreach_lead_tags lt join outreach_tags tg on tg.id = lt.tag_id where lt.lead_id = l1 and tg.name = 'ai-handed-off')
    then log := log || E'\nok   sending an AI draft with a calendar link hands the chat off: task to the owner, tag on the lead';
    else fails := fails + 1; log := log || E'\nFAIL calendar handoff: ' || j::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-in3-' || ws, 'in', 'Booked for Thursday!', t0 + interval '2 hours 5 minutes') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3);
  if j->>'action' = 'skipped' and j->>'why' = 'handed_off' and not (j->>'returned')::boolean and not exists (select 1 from outreach_ai_reply_runs where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled'))
    then log := log || E'\nok   after handoff: no run for their next message (no automatic draft)';
    else fails := fails + 1; log := log || E'\nFAIL enqueue after handoff: ' || j::text; end if;
  k := outreach__ai_effective(c1);
  if k->>'mode' = 'off' and k->>'reason_code' = 'handed_off' and k->'handed_off'->>'reason' = 'calendar_sent' then log := log || E'\nok   effective: off / handed_off with the reason';
  else fails := fails + 1; log := log || E'\nFAIL effective handed off: ' || k::text; end if;
  -- Draft with AI still works on a handed-off chat
  j := outreach_ai_reply_manual_open(c1, u_owner, 'inbox', null, 1, false);
  if j->>'source' = 'new' then log := log || E'\nok   Draft with AI still opens a manual run on a handed-off chat'; else fails := fails + 1; log := log || E'\nFAIL manual after handoff: ' || j::text; end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed' where id = (j->>'run_id')::uuid;
  -- Resume AI (manager) clears it and closes the task
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_chat_ai_resume(c1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'handed_off' is null and (select ai_handed_off_at from outreach_chats where id = c1) is null
     and not exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_handoff' and completed_at is null)
    then log := log || E'\nok   Resume AI clears the handoff and completes its task';
    else fails := fails + 1; log := log || E'\nFAIL resume: ' || left(j::text, 200); end if;

  -- ============================================================ 6. T1: a person's own message hands off without a task; Stop AI (manual) too
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, sent_by)
    values (ws, c1, 'm10-own-' || ws, 'out', 'Great, see you Thursday. I will send the invite.', t0 + interval '2 hours 10 minutes', u_owner) returning id into m_x;
  j := outreach_ai_reply_on_human_send(c1, m_x, null, null, null, u_owner);
  if j->>'origin' = 'inbox_user' and j->'handoff'->>'reason' = 'human_replied' and (select ai_handoff_reason from outreach_chats where id = c1) = 'human_replied'
     and not exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_handoff' and completed_at is null)
    then log := log || E'\nok   T1: a person''s own reply hands off (human_replied) with no task';
    else fails := fails + 1; log := log || E'\nFAIL T1: ' || j::text; end if;
  perform outreach_ai_resume_chat(c1);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin j := outreach_chat_ai_stop(c1); t := 'stopped'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_NOT_FOUND%' then log := log || E'\nok   Stop AI respects client scope'; else fails := fails + 1; log := log || E'\nFAIL stop scope: ' || t; end if;
  perform outreach_ai_handoff(c1, 'manual', null, null);
  if (select ai_handoff_reason from outreach_chats where id = c1) = 'manual' and not exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_handoff' and completed_at is null)
    then log := log || E'\nok   Stop AI (T8) hands off with no task'; else fails := fails + 1; log := log || E'\nFAIL manual handoff'; end if;
  perform outreach_ai_resume_chat(c1);

  -- ============================================================ 7. dispatch: recheck, mark_sent → warm-up decrement + stop-rule handoff
  update outreach_chats set ai_handed_off_at = null, ai_handoff_reason = null where id = c1;   -- (service write, already resumed)
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-in4-' || ws, 'in', 'Actually can we do Friday instead?', t0 + interval '2 hours 20 minutes') returning id into m_x;
  update outreach_messages set classified_at = now(), ai_flags = array['meeting_time_proposed'] where id = m_x;
  j := outreach_ai_reply_enqueue(c1, m_x);
  r3 := (j->>'run_id')::uuid;
  update outreach_ai_reply_runs set status = 'drafting' where id = r3;
  j := outreach_ai_reply_finalize(r3, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Friday works, see you then.',
          'stage_before', 'next_step', 'stage_after', 'closing', 'move', 'close', 'master_prompt_id', mp, 'master_prompt_version', 1, 'stop_after_send', true, 'stop_rule', 'we agreed a meeting time',
          'scheduled_send_at', now() - interval '1 minute', 'timings', jsonb_build_object('scheduled_at', now(), 'warmup', true)));
  n := (select count(*) from outreach_ai_reply_dispatch_claim(25) x where x.id = r3);
  j := outreach_ai_reply_prepare_send(r3, false, 'IN');
  aid := (j->>'action_id')::uuid;
  if n = 1 and (j->>'ok')::boolean and (select status from outreach_actions where id = aid) = 'reserved' then log := log || E'\nok   scheduled run claimed, rechecked (not handed off, sequence active, consent live), ledger reserved';
  else fails := fails + 1; log := log || E'\nFAIL prepare_send: ' || j::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm10-ai-' || ws, 'out', 'Friday works, see you then.', t0 + interval '2 hours 30 minutes', aid) returning id into m_x;
  j := outreach_ai_reply_mark_sent(r3, m_x, 'm10-ai-' || ws);
  if (j->>'ok')::boolean and (select status from outreach_ai_reply_runs where id = r3) = 'sent' and (select origin from outreach_messages where id = m_x) = 'ai_autopilot'
     and (select warmup_remaining from outreach_sequence_reply_settings where sequence_id = q1) = 19
     and (select ai_handoff_reason from outreach_chats where id = c1) = 'stop_rule' and (select ai_handoff_run_id from outreach_chats where id = c1) = r3
     and exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_handoff' and completed_at is null and title like 'AI handed off — Ann Lee (Acme) · we agreed a meeting time%')
    then log := log || E'\nok   mark_sent: warm-up 20 → 19; the Stop rule hands off (T4) with a task naming the rule';
    else fails := fails + 1; log := log || E'\nFAIL mark_sent: ' || j::text || ' warmup=' || (select warmup_remaining from outreach_sequence_reply_settings where sequence_id = q1) || ' reason=' || coalesce((select ai_handoff_reason from outreach_chats where id = c1), 'null'); end if;
  -- a handed-off chat's scheduled run cannot be sent
  perform outreach_ai_resume_chat(c1);
  perform outreach_ai_handoff(c1, 'manual', null, null);
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, draft_text, scheduled_send_at, mode)
    values (ws, c1, s1, l1, q1, 'LINKEDIN', array[m_in3], now(), now(), 'scheduled', 'x', now(), 'autopilot') returning id into r1;
  perform outreach_ai_reply_dispatch_claim(25, r1);
  j := outreach_ai_reply_prepare_send(r1, false, 'IN');
  if j->>'why' = 'handed_off' and (select status from outreach_ai_reply_runs where id = r1) = 'cancelled' then log := log || E'\nok   prepare_send refuses a handed-off chat';
  else fails := fails + 1; log := log || E'\nFAIL prepare handed off: ' || j::text; end if;
  perform outreach_ai_resume_chat(c1);

  -- ============================================================ 8. pause / resume
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, draft_text, scheduled_send_at, mode)
    values (ws, c1, s1, l1, q1, 'LINKEDIN', array[m_in3], now(), now(), 'scheduled', 'y', now() + interval '10 minutes', 'autopilot') returning id into r1;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_set_sequence_status(q1, 'paused');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach__ai_effective(c1);
  if (j->'ai_replies'->>'demoted')::int = 1 and (select status from outreach_ai_reply_runs where id = r1) = 'draft_ready' and (select 'sequence_paused' = any(gate_failures) from outreach_ai_reply_runs where id = r1)
     and k->>'mode' = 'draft' and k->>'reason_code' = 'sequence_paused'
    then log := log || E'\nok   pausing the sequence turns its scheduled replies into drafts; new replies are drafts';
    else fails := fails + 1; log := log || E'\nFAIL pause: ' || j::text || ' ' || k::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_set_sequence_status(q1, 'active');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select resumed_at from outreach_sequences where id = q1) is not null and (j->'ai_replies'->>'drafts_waiting')::int >= 1
    then log := log || E'\nok   resume sets resumed_at and reports the drafts waiting';
    else fails := fails + 1; log := log || E'\nFAIL resume: ' || j::text; end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed' where id = r1;

  -- ============================================================ 9. sessions: returning / dormant / handed-off return; tasks on reply
  insert into outreach_tasks(workspace_id, kind, chat_id, lead_id, sender_id, title, source) values (ws, 'follow_up', c1, l1, s1, 'AI follow-up', 'ai');
  insert into outreach_tasks(workspace_id, kind, chat_id, lead_id, sender_id, title, source) values (ws, 'follow_up', c1, l1, s1, 'My own follow-up', 'user');
  update outreach_chats set conversation_stage = 'relate', conversation_exchanges = 3, ai_replies_count = 5, ai_quiet_task_at = now() where id = c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-ret-' || ws, 'in', 'Hi again, sorry for the silence. Still interested.', t0 + interval '12 days') returning id into m_x;
  j := outreach_ai_reply_enqueue(c1, m_x);
  if j->>'session' = 'returning' and (j->>'gap_days')::numeric between 9 and 13 and (select ai_session_kind from outreach_chats where id = c1) = 'returning'
     and (select ai_replies_count from outreach_chats where id = c1) = 0 and (select conversation_stage from outreach_chats where id = c1) = 'relate'
     and (select gap_days from outreach_ai_reply_runs where id = (j->>'run_id')::uuid) between 9 and 13 and (select ai_quiet_task_at from outreach_chats where id = c1) is null
     and exists (select 1 from outreach_tasks where chat_id = c1 and title = 'AI follow-up' and completed_at is not null and result->>'completed_reason' = 'they_replied')
     and exists (select 1 from outreach_tasks where chat_id = c1 and title = 'My own follow-up' and completed_at is null and result ? 'they_replied_at')
    then log := log || E'\nok   back after 12 days: returning session (counters reset, stage kept); AI task completed, person''s task marked';
    else fails := fails + 1; log := log || E'\nFAIL returning: ' || j::text; end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed' where id = (j->>'run_id')::uuid;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-dorm-' || ws, 'in', 'Long time. Do you still do this?', t0 + interval '60 days') returning id into m_x;
  j := outreach_ai_reply_enqueue(c1, m_x);
  if j->>'session' = 'dormant' and (select ai_session_kind from outreach_chats where id = c1) = 'dormant' and (select conversation_stage from outreach_chats where id = c1) is null
     and (select ai_session_count from outreach_chats where id = c1) = 3
    then log := log || E'\nok   back after 48 days: dormant session → Re-engage (no stage), session count 3';
    else fails := fails + 1; log := log || E'\nFAIL dormant: ' || j::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_ai_reply_chat_state(c1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->'stage'->>'key' = 're_engage' and j->'session'->>'kind' = 'dormant' then log := log || E'\nok   chat state shows Re-engage for a dormant return';
  else fails := fails + 1; log := log || E'\nFAIL chat state: ' || left(j::text, 300); end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed' where id = (j->'run'->>'id')::uuid;
  -- handed off, then back after 3 weeks: no run, task reopened, returned flagged
  perform outreach_ai_handoff(c1, 'calendar_sent', null, 'calendar link');
  update outreach_tasks set completed_at = now() where chat_id = c1 and kind = 'ai_handoff' and completed_at is null;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-back-' || ws, 'in', 'Hey, we never met. Free next week?', t0 + interval '81 days') returning id into m_x;
  j := outreach_ai_reply_enqueue(c1, m_x);
  if j->>'why' = 'handed_off' and (j->>'returned')::boolean and (j->>'task_id') is not null
     and exists (select 1 from outreach_tasks where id = (j->>'task_id')::uuid and completed_at is null and title like 'Ann Lee came back after 21 days%')
    then log := log || E'\nok   a handed-off prospect back after 21 days: no run, handoff task reopened with the gap';
    else fails := fails + 1; log := log || E'\nFAIL handed-off return: ' || j::text; end if;

  -- ============================================================ 10. re-enrolment in another sequence switches the chat
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, q2, 1, l1, s1, 'active', t0 + interval '82 days') returning id into e2;
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s1, l1, e2, 'n1', 'message', t0 + interval '83 days', 'sent', t0 + interval '83 days', 'k10-seq2-' || ws, '{"text":"New offer for CFOs"}') returning id into a_seq2;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm10-out2-' || ws, 'out', 'New offer for CFOs', t0 + interval '83 days', a_seq2) returning id into m_x;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm10-in5-' || ws, 'in', 'Tell me more about the new offer', t0 + interval '83 days 1 hour') returning id into m_x;
  j := outreach_ai_reply_enqueue(c1, m_x);
  if (select reply_sequence_id from outreach_chats where id = c1) = q2 and (select ai_handed_off_at from outreach_chats where id = c1) is null
     and (select ai_session_kind from outreach_chats where id = c1) = 'normal' and j->>'action' = 'created' and (select sequence_id from outreach_ai_reply_runs where id = (j->>'run_id')::uuid) = q2
    then log := log || E'\nok   answering a newer sequence''s message switches the chat: handoff cleared, counters reset, run on the new sequence';
    else fails := fails + 1; log := log || E'\nFAIL switch: ' || j::text || ' seq=' || (select reply_sequence_id::text from outreach_chats where id = c1); end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed' where id = (j->>'run_id')::uuid;

  -- ============================================================ 11. scenarios, Convert to cards, Q&A, unanswered, prompt versions
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  n := (select version from outreach_master_prompts where id = mp);
  j := outreach_scenario_save(q1, null, 'Asks for references', 'They ask for client names or case studies', 'Name <two clients> and offer a case study on a call', true);
  sc := (j->>'id')::uuid;
  k := outreach_scenario_toggle(sc, false);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select version from outreach_master_prompts where id = mp) = n + 2 and (select substantive_version from outreach_master_prompts where id = mp) = n + 2
     and (select warmup_remaining from outreach_sequence_reply_settings where sequence_id = q1) = 19
     and (select body from outreach_master_prompts where id = mp) not like '%Asks for references%'
     and (select jsonb_array_length(scenarios) from outreach_master_prompt_versions where master_prompt_id = mp and version = n + 1) = 8
     and (select body from outreach_master_prompt_versions where master_prompt_id = mp and version = n + 1) like '%Asks for references: when%'
    then log := log || E'\nok   a card added then disabled: two substantive versions, snapshots, compiled only while enabled; warm-up stays ≥ 10';
    else fails := fails + 1; log := log || E'\nFAIL scenarios: v=' || (select version from outreach_master_prompts where id = mp) || ' expected ' || (n + 2); end if;
  j := outreach_scenarios_from_text(E'- They ask the price → Say projects start at ₹X\n- Wrong person, they name someone -> thank them and create a task\nnot a bullet');
  if jsonb_array_length(j) = 2 and j->0->>'do_text' = 'Say projects start at ₹X' and j->1->>'title' like 'Wrong person%' then log := log || E'\nok   Convert to cards parses "- When → Do" bullets';
  else fails := fails + 1; log := log || E'\nFAIL from_text: ' || j::text; end if;
  -- unanswered questions: grouped by similarity, answered → Q&A, recurrence reopens
  j := outreach_ai_unanswered_add(r3, 'What is the turnaround time?', 'how long does it take to deliver?', m_in3);
  gid := (j->>'group_id')::uuid;
  k := outreach_ai_unanswered_add(r3, 'What is the turnaround time', 'turnaround?', m_in3);
  if (j->>'created')::boolean and (k->>'group_id')::uuid = gid and (select count_total from outreach_ai_unanswered_questions where id = gid) = 2
    then log := log || E'\nok   two phrasings of one question form one group (count 2)';
    else fails := fails + 1; log := log || E'\nFAIL unanswered group: ' || j::text || k::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_unanswered_answer(gid, 'Two weeks from brief to film.');
  k := outreach_unanswered_list(q1, 'all');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  fq := (j->>'faq_id')::uuid;
  if (select status from outreach_ai_unanswered_questions where id = gid) = 'answered' and (select source from outreach_master_prompt_faqs where id = fq) = 'unanswered'
     and jsonb_array_length(k) = 1 and (k->0->>'count_30d')::int = 2
    then log := log || E'\nok   Add answer creates a Q&A pair and marks the group answered';
    else fails := fails + 1; log := log || E'\nFAIL answer: ' || j::text; end if;
  perform outreach_ai_unanswered_add(r3, 'What is the turnaround time?', 'turnaround pls', m_in3);
  if (select status from outreach_ai_unanswered_questions where id = gid) = 'open' then log := log || E'\nok   an answered group that recurs reopens';
  else fails := fails + 1; log := log || E'\nFAIL reopen'; end if;
  j := outreach__ai_faqs_for(mp, 'turnaround');
  if jsonb_array_length(j) = 1 and j->0->>'answer' = 'Two weeks from brief to film.' then log := log || E'\nok   Q&A (≤ 30) all go to the drafter';
  else fails := fails + 1; log := log || E'\nFAIL faqs_for: ' || j::text; end if;

  -- ============================================================ 12. knowledge: add text, store chunks, search, attach
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_knowledge_source_add(ws, 'text', 'Rate card', null, null, 'Our 30-second films start at 80,000 rupees. Delivery takes two weeks. Discounts apply for three films.');
  ks := (j->>'id')::uuid;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform outreach_knowledge_store(ks, jsonb_build_array(jsonb_build_object('heading', 'Pricing', 'text', 'Our 30-second films start at 80,000 rupees. Delivery takes two weeks.'), jsonb_build_object('heading', 'Discounts', 'text', 'Discounts apply for three films or more.')), 1);
  j := outreach_knowledge_search(ws, array[ks], 'what is the price of a 30 second film', 5);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  k := outreach_knowledge_attach(q1, ks);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select status from outreach_knowledge_sources where id = ks) = 'ready' and (select chunks from outreach_knowledge_sources where id = ks) = 2
     and jsonb_array_length(j) >= 1 and j->0->>'heading' = 'Pricing' and (select ks = any(knowledge_source_ids) from outreach_master_prompts where id = mp)
     and jsonb_array_length(k->'knowledge') = 1
    then log := log || E'\nok   knowledge: text source stored as chunks, full-text search ranks the pricing chunk first, attached to the sequence prompt';
    else fails := fails + 1; log := log || E'\nFAIL knowledge: ' || j::text; end if;

  -- ============================================================ 13. lead notes: AI ops, person lock
  j := outreach_ai_lead_notes_apply(l1, jsonb_build_array(jsonb_build_object('op', 'add', 'key', 'budget', 'text', 'Around 2 lakh'), jsonb_build_object('op', 'add', 'key', 'timeline', 'text', 'Launch in November')), 'Budget ~2L, launch in November', m_in2);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  k := outreach_lead_notes_get(l1);
  k := outreach_lead_notes_update(l1, jsonb_build_array(jsonb_build_object('id', k->'items'->0->>'id', 'key', 'budget', 'text', 'Confirmed 2.5 lakh on the call'), k->'items'->1));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  j := outreach_ai_lead_notes_apply(l1, jsonb_build_array(jsonb_build_object('op', 'update', 'id', k->'items'->0->>'id', 'key', 'budget', 'text', 'Now says 5 lakh'), jsonb_build_object('op', 'add', 'key', 'budget', 'text', 'Said 5 lakh on 3 Oct')), null, m_in3);
  select items into k from outreach_lead_ai_notes where lead_id = l1;
  if (j->>'applied')::int = 1 and jsonb_array_length(k) = 3 and k->0->>'text' = 'Confirmed 2.5 lakh on the call' and (k->0->>'locked')::boolean and not coalesce((k->1->>'locked')::boolean, false)
     and (select summary from outreach_lead_ai_notes where lead_id = l1) = 'Budget ~2L, launch in November'
    then log := log || E'\nok   lead notes: AI adds, a person''s edit locks the item, the AI then adds instead of changing it';
    else fails := fails + 1; log := log || E'\nFAIL lead notes: ' || j::text || ' ' || k::text; end if;

  -- ============================================================ 14. gone quiet → one task per silence
  update outreach_chats set ai_handed_off_at = null, ai_handoff_reason = null, ai_quiet_task_at = null, reply_sequence_id = q1 where id = c1;
  update outreach_messages set sent_at = now() - interval '9 days' where chat_id = c1 and direction = 'in';
  update outreach_messages set sent_at = now() - interval '8 days' where chat_id = c1 and direction = 'out';
  j := outreach_ai_reply_inactivity();
  k := outreach_ai_reply_inactivity();
  if (j->>'tasks')::int = 1 and (k->>'tasks')::int = 0 and exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'follow_up' and source = 'system' and title like 'Ann Lee went quiet after%7 days')
     and (select ai_quiet_task_at from outreach_chats where id = c1) is not null
    then log := log || E'\nok   gone quiet for 7 days after our last message → one system task, not twice';
    else fails := fails + 1; log := log || E'\nFAIL inactivity: ' || j::text || k::text; end if;

  -- ============================================================ 15. breakers downgrade the sequence; re-enable needs a note; chat guard; backfill re-run
  perform outreach__ai_downgrade(ws, q1, 'smoke');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin j := outreach_sequence_ai_replies_set(q1, '{"mode":"autopilot"}'::jsonb); t := 'ok'; exception when others then t := sqlerrm; end;
  j := outreach_sequence_ai_replies_set(q1, '{"mode":"autopilot"}'::jsonb, 'fixed the pricing rule');
  begin update outreach_chats set ai_handed_off_at = now() where id = c1; t := t || '|written'; exception when others then t := t || '|' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_PAYLOAD_INVALID%' and t like '%E_FORBIDDEN%' and j->>'mode' = 'autopilot' and j->>'downgraded_at' is null and (select breaker_reset_at from outreach_sequence_reply_settings where sequence_id = q1) is not null
    then log := log || E'\nok   a downgrade needs a note to go back to Auto; a signed-in user cannot write the chat''s AI columns';
    else fails := fails + 1; log := log || E'\nFAIL downgrade/guard: ' || t || ' ' || left(j::text, 200); end if;
  j := outreach_migrate_ai_replies_v2();
  if (j->>'sequences')::int = 0 then log := log || E'\nok   the v2 backfill is a no-op on a second run'; else fails := fails + 1; log := log || E'\nFAIL backfill rerun: ' || j::text; end if;
  -- consent revoke turns the sender's scheduled sends into drafts
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, draft_text, scheduled_send_at, mode)
    values (ws, c1, s1, l1, q1, 'LINKEDIN', array[m_in3], now(), now(), 'scheduled', 'z', now() + interval '10 minutes', 'autopilot') returning id into r1;
  perform outreach__ai_consent_revoke((select id from outreach_ai_reply_consent where sender_id = s1 and revoked_at is null), 'smoke', 'test');
  k := outreach__ai_effective(c1);
  if (select status from outreach_ai_reply_runs where id = r1) = 'draft_ready' and k->>'mode' = 'draft' and k->>'reason_code' = 'consent_missing' then log := log || E'\nok   revoking consent demotes the sender''s scheduled sends and drops the chat to Draft';
  else fails := fails + 1; log := log || E'\nFAIL revoke: ' || k::text; end if;

  -- ============================================================ 16. grants: engine functions are service-only, app RPCs open to signed-in users
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname in ('outreach_ai_reply_enqueue','outreach_ai_reply_finalize','outreach_ai_handoff','outreach_ai_reply_manual_open','outreach_ai_lead_notes_apply','outreach_ai_unanswered_add','outreach_knowledge_search','outreach_ai_reply_inactivity','outreach_migrate_ai_replies_v2');
  if n = 0 and has_function_privilege('authenticated', 'outreach_sequence_ai_replies_get(uuid)', 'execute') and has_function_privilege('authenticated', 'outreach_chat_ai_stop(uuid)', 'execute')
     and not has_function_privilege('anon', 'outreach_sequence_ai_replies_get(uuid)', 'execute')
    then log := log || E'\nok   grants: engine service-only, app RPCs for signed-in users, nothing for anon';
    else fails := fails + 1; log := log || E'\nFAIL grants: ' || n; end if;
  if not exists (select 1 from information_schema.columns where table_name = 'outreach_chats' and column_name = 'reply_mode_override')
     and to_regclass('outreach_reply_policies_legacy') is not null and to_regclass('outreach_reply_policies') is null
    then log := log || E'\nok   legacy: reply_mode_override dropped, reply_policies renamed';
    else fails := fails + 1; log := log || E'\nFAIL legacy'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (ai replies v2)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
