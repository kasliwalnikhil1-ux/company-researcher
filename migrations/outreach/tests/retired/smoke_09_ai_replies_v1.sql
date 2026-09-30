-- Smoke test — 034–037 AI replies (ai-auto-reply-PRD.md). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_09_ai_replies.sql
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; b boolean;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid;
  s1 uuid; s2 uuid; sw uuid; l1 uuid; l2 uuid; lw uuid; q1 uuid; e1 uuid;
  c1 uuid; c2 uuid; cw uuid; a_seq uuid; m_out uuid; m_in1 uuid; m_in2 uuid; m_in3 uuid; m_x uuid;
  mp uuid; r1 uuid; r2 uuid; r3 uuid; aid uuid; tok text; st jsonb; se jsonb;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  sections jsonb;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke9', 'smoke9-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner9@test.local');
  insert into outreach_members(workspace_id, user_id, role, email, client_ids) values (ws, u_member, 'member', 'member9@test.local', array[ca]);
  insert into outreach_members(workspace_id, user_id, role, email, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer9@test.local', array[ca]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Naman', 'ok', 's9a-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', u_owner, 'owner9@test.local') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_email)
    values (ws, cb, 'LINKEDIN', 'Other', 'ok', 's9b-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', 'client9@test.local') returning id into s2;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, schedule, timezone)
    values (ws, 'WHATSAPP', 'WA', 'ok', 's9w-' || ws, sched, 'UTC') returning id into sw;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company, location)
    values (ws, ca, 'ann9-' || left(ws::text, 8), 'Ann Lee', 'Ann', 'Acme', 'Mumbai, India') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name) values (ws, cb, 'ben9-' || left(ws::text, 8), 'Ben Roe') returning id into l2;
  insert into outreach_leads(workspace_id, full_name, phone) values (ws, 'Wa Lead', '+911234') returning id into lw;
  insert into outreach_sequences(workspace_id, client_id, name, status) values (ws, ca, 'Fintech CFOs', 'active') returning id into q1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, q1, 1, l1, s1, 'exited_replied') returning id into e1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, ca, s1, l1, 'c9-1-' || ws, 'LINKEDIN', 'Ann Lee') returning id into c1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, cb, s2, l2, 'c9-2-' || ws, 'LINKEDIN', 'Ben Roe') returning id into c2;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, sw, lw, 'c9-w-' || ws, 'WHATSAPP', 'Wa Lead') returning id into cw;

  -- ============================================================ 1. message origin + text hash
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s1, l1, e1, 'n1', 'message', now() - interval '2 days', 'sent', now() - interval '2 days', 'k9-seq-' || ws, '{"text":"Hi Ann, saw your post on treasury ops"}') returning id into a_seq;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm9-out-' || ws, 'out', 'Hi Ann, saw your post on treasury ops', now() - interval '2 days', a_seq) returning id into m_out;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in1-' || ws, 'in', 'Thanks! What does your team do exactly?', now() - interval '5 minutes') returning id into m_in1;
  if (select origin from outreach_messages where id = m_out) = 'sequence' and (select origin from outreach_messages where id = m_in1) = 'prospect'
     and (select text_sha256 from outreach_messages where id = m_in1) = outreach__text_sha('  thanks!   what does your team do EXACTLY? ')
    then log := log || E'\nok   origin: sequence / prospect, normalised text hash';
    else fails := fails + 1; log := log || E'\nFAIL origin/hash: ' || coalesce((select origin || '/' || coalesce(text_sha256,'') from outreach_messages where id = m_out), 'null'); end if;

  -- ============================================================ 2. effective mode before / after a master prompt
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'off' and j->>'reason_code' = 'no_master_prompt' then log := log || E'\nok   no master prompt → off';
  else fails := fails + 1; log := log || E'\nFAIL no prompt: ' || j::text; end if;
  j := outreach__ai_effective(cw);
  if j->>'mode' = 'off' and j->>'reason_code' = 'channel_not_supported' then log := log || E'\nok   WhatsApp chat → off (LinkedIn only in v1)';
  else fails := fails + 1; log := log || E'\nFAIL whatsapp: ' || j::text; end if;
  j := outreach_ai_reply_enqueue(c1, m_in1);
  if j->>'action' = 'skipped' and not exists (select 1 from outreach_ai_reply_runs where chat_id = c1) then log := log || E'\nok   enqueue skips while mode is off (no run row)';
  else fails := fails + 1; log := log || E'\nFAIL enqueue while off: ' || j::text; end if;

  -- owner saves the workspace master prompt through the RPC (guided: the body is compiled server-side)
  sections := (outreach_master_prompt_template()->'sections') || jsonb_build_object('facts', E'- We make 60-second product films for D2C brands.\n- Turnaround is 2 weeks.\n- Calendar: https://cal.com/naman/15min');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_master_prompt_save(ws, 'workspace', null, 'guided', 'ignored for guided', sections, '{}'::jsonb, 'style', 'first');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  mp := (j->>'id')::uuid;
  if j->>'change_kind' = 'substantive' and (j->>'version')::int = 1 and j->>'body' like '%Turnaround is 2 weeks%' and j->>'body' like '%Stage 1 · Engage%'
    then log := log || E'\nok   first save is substantive, guided body compiled server-side';
    else fails := fails + 1; log := log || E'\nFAIL first save: ' || left(j::text, 300); end if;
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'draft' and j->>'source' = 'default' then log := log || E'\nok   with a prompt the default mode is draft';
  else fails := fails + 1; log := log || E'\nFAIL draft default: ' || j::text; end if;

  -- ============================================================ 3. policies: most specific wins, autopilot caps
  insert into outreach_reply_policies(workspace_id, scope, scope_id, mode) values (ws, 'workspace', null, 'off');
  insert into outreach_reply_policies(workspace_id, scope, scope_id, mode, delay_min_s) values (ws, 'sequence', q1, 'autopilot', 300);
  j := outreach__ai_effective(c1);
  if j->>'requested_mode' = 'autopilot' and j->>'source' = 'sequence' and j->>'mode' = 'draft' and j->>'reason_code' = 'consent_missing'
     and (j->'policy'->>'delay_min_s')::int = 300 and (j->'policy'->>'delay_max_s')::int = 1200
    then log := log || E'\nok   sequence policy wins over workspace; autopilot without consent → draft';
    else fails := fails + 1; log := log || E'\nFAIL policy merge: ' || j::text; end if;
  -- operator consent: only the sender's owner can grant it directly
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_ai_consent_grant_operator(s1, mp); t := 'granted'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' then log := log || E'\nok   a non-owner cannot grant operator consent';
  else fails := fails + 1; log := log || E'\nFAIL member granted consent: ' || t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_ai_consent_grant_operator(s1, mp);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'draft' and j->>'reason_code' = 'not_graduated' then log := log || E'\nok   consent without graduation → draft (not_graduated)';
  else fails := fails + 1; log := log || E'\nFAIL not graduated: ' || j::text; end if;
  insert into outreach_ai_reply_workspace(workspace_id, graduation_bypass, note) values (ws, true, 'smoke');
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'autopilot' and (j->>'can_autopilot')::boolean then log := log || E'\nok   consent + graduation (bypass) → autopilot';
  else fails := fails + 1; log := log || E'\nFAIL autopilot: ' || j::text; end if;

  -- ============================================================ 4. enqueue: create, append, supersede, defer
  j := outreach_ai_reply_enqueue(c1, m_in1);
  r1 := (j->>'run_id')::uuid;
  if j->>'action' = 'created' and (select status from outreach_ai_reply_runs where id = r1) = 'debouncing' and (select sequence_id from outreach_ai_reply_runs where id = r1) = q1
     and (select ai_run_status from outreach_chats where id = c1) = 'debouncing'
    then log := log || E'\nok   enqueue opens a debouncing run (sequence attached, chat mirror set)';
    else fails := fails + 1; log := log || E'\nFAIL enqueue create: ' || j::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in2-' || ws, 'in', 'And roughly what does it cost?', now() - interval '4 minutes') returning id into m_in2;
  j := outreach_ai_reply_enqueue(c1, m_in2);
  if j->>'action' = 'appended' and (select cardinality(inbound_message_ids) from outreach_ai_reply_runs where id = r1) = 2 then log := log || E'\nok   a second message in the burst is appended';
  else fails := fails + 1; log := log || E'\nFAIL append: ' || j::text; end if;
  j := outreach_ai_reply_enqueue(c1, m_in2);
  if j->>'action' = 'duplicate' then log := log || E'\nok   the same message twice is a no-op'; else fails := fails + 1; log := log || E'\nFAIL duplicate: ' || j::text; end if;

  -- ============================================================ 5. claim waits for debounce + classification
  n := (select count(*) from outreach_ai_reply_claim(25) x where x.id = r1);
  if n = 0 then log := log || E'\nok   not claimed while debouncing'; else fails := fails + 1; log := log || E'\nFAIL claimed early'; end if;
  update outreach_ai_reply_runs set debounce_until = now() - interval '10 seconds' where id = r1;
  n := (select count(*) from outreach_ai_reply_claim(25) x where x.id = r1);
  if n = 0 then log := log || E'\nok   not claimed while messages are unclassified (< 60 s)'; else fails := fails + 1; log := log || E'\nFAIL claimed before classification'; end if;
  update outreach_messages set classified_at = now(), intent = 'question', ai_flags = array['asked_offer','pricing'] where id in (m_in1, m_in2);
  n := (select count(*) from outreach_ai_reply_claim(25) x where x.id = r1);
  if n = 1 and (select status from outreach_ai_reply_runs where id = r1) = 'drafting' then log := log || E'\nok   due + classified → claimed (drafting)';
  else fails := fails + 1; log := log || E'\nFAIL claim: ' || n; end if;

  -- gate facts
  j := outreach_ai_reply_gate_facts(r1);
  if (j->>'contacted_first')::boolean and jsonb_array_length(j->'burst') = 2 and jsonb_array_length(j->'thread') = 3
     and j->'thread'->0->>'from' = 'us_sequence' and j->'lead'->>'suppression' is null and j->'effective'->>'mode' = 'autopilot'
    then log := log || E'\nok   gate facts: contacted first, burst of 2, labelled thread';
    else fails := fails + 1; log := log || E'\nFAIL gate facts: ' || left(j::text, 400); end if;

  -- ============================================================ 6. finalize → scheduled, then a new message supersedes
  j := outreach_ai_reply_finalize(r1, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'We make 60-second product films for D2C brands. What are you working on right now?',
          'stage_before', 'engage', 'stage_after', 'relate', 'move', 'answer', 'rule_applied', 'Stage 1 · Engage', 'master_prompt_id', mp, 'master_prompt_version', 1,
          'scheduled_send_at', now() + interval '10 minutes', 'flags', jsonb_build_array('asked_offer'), 'timings', jsonb_build_object('drafted_at', now(), 'scheduled_at', now())));
  if (j->>'ok')::boolean and (select ai_run_status from outreach_chats where id = c1) = 'scheduled' and (select ai_scheduled_send_at from outreach_chats where id = c1) is not null
    then log := log || E'\nok   finalize drafting → scheduled (chat shows the countdown)';
    else fails := fails + 1; log := log || E'\nFAIL finalize: ' || j::text; end if;
  j := outreach_ai_reply_finalize(r1, 'draft_ready', '{}'::jsonb);
  if not (j->>'ok')::boolean then log := log || E'\nok   a second finalize is refused (compare-and-set)'; else fails := fails + 1; log := log || E'\nFAIL CAS'; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in3-' || ws, 'in', 'Also do you work with fintechs?', now() - interval '1 minute') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3);
  r2 := (j->>'run_id')::uuid;
  if j->>'action' = 'superseded' and (select status from outreach_ai_reply_runs where id = r1) = 'superseded'
     and (select cardinality(inbound_message_ids) from outreach_ai_reply_runs where id = r2) = 3 and (select ai_run_id from outreach_chats where id = c1) = r2
    then log := log || E'\nok   a message during the hold supersedes; the new run answers all three';
    else fails := fails + 1; log := log || E'\nFAIL supersede: ' || j::text; end if;

  -- ============================================================ 7. dispatch: prepare_send, not-our-turn, mark_sent
  update outreach_messages set classified_at = now() where id = m_in3;
  update outreach_ai_reply_runs set status = 'drafting' where id = r2;
  perform outreach_ai_reply_finalize(r2, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Yes, fintechs too. Two weeks from brief to film. What are you launching next?',
          'stage_before', 'engage', 'stage_after', 'relate', 'move', 'answer', 'rule_applied', 'Stage 1 · Engage', 'master_prompt_id', mp, 'master_prompt_version', 1,
          'scheduled_send_at', now() - interval '1 minute', 'timings', jsonb_build_object('scheduled_at', now())));
  n := (select count(*) from outreach_ai_reply_dispatch_claim(25) x where x.id = r2);
  j := outreach_ai_reply_prepare_send(r2, false, 'IN');   -- lead in Mumbai: outside the EU/EEA default block
  aid := (j->>'action_id')::uuid;
  if n = 1 and (j->>'ok')::boolean and (select action_type from outreach_actions where id = aid) = 'ai_reply' and (select status from outreach_actions where id = aid) = 'reserved'
    then log := log || E'\nok   due scheduled run claimed, rechecked, ledger reserved, ai_reply action opened';
    else fails := fails + 1; log := log || E'\nFAIL prepare_send: ' || j::text; end if;
  -- the tick never picks an ai_reply, and the sweep never re-queues one
  if not exists (select 1 from outreach_claim_due_actions(200) x where x.id = aid) then log := log || E'\nok   claim_due_actions ignores ai_reply';
  else fails := fails + 1; log := log || E'\nFAIL tick claimed ai_reply'; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm9-ai-' || ws, 'out', 'Yes, fintechs too. Two weeks from brief to film. What are you launching next?', now(), aid) returning id into m_x;
  j := outreach_ai_reply_mark_sent(r2, m_x, 'm9-ai-' || ws);
  if (j->>'ok')::boolean and (select status from outreach_ai_reply_runs where id = r2) = 'sent' and (select origin from outreach_messages where id = m_x) = 'ai_autopilot'
     and (select ai_replies_count from outreach_chats where id = c1) = 1 and (select conversation_exchanges from outreach_chats where id = c1) = 1
     and (select conversation_stage from outreach_chats where id = c1) = 'relate' and (select status from outreach_actions where id = aid) = 'sent'
     and (select used from outreach_sender_budgets where sender_id = s1 and action_type = 'ai_reply' and day = outreach_sender_local_date(s1, now())) = 1
    then log := log || E'\nok   mark_sent: run sent, message ai_autopilot, stage → relate, exchanges 1, ledger used 1';
    else fails := fails + 1; log := log || E'\nFAIL mark_sent: ' || j::text || ' stage=' || coalesce((select conversation_stage from outreach_chats where id = c1), 'null'); end if;
  -- the prospect's answer to an AI send attaches to the automated step before it (not a new reply)
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in4-' || ws, 'in', 'Nice. Send me some examples', now() + interval '30 seconds') returning id into m_in1;
  if (select replied_to_action_id from outreach_messages where id = m_in1) = a_seq and not (select is_first_reply from outreach_messages where id = m_in1)
    then log := log || E'\nok   answers to an AI reply attach to the sequence step (stamp trigger patched)';
    else fails := fails + 1; log := log || E'\nFAIL stamp: ' || coalesce((select replied_to_action_id::text from outreach_messages where id = m_in1), 'null'); end if;
  if (select reply_latency_s from outreach_ai_reply_runs where id = r2) is null then
    j := outreach_ai_reply_enqueue(c1, m_in1);
  end if;
  r3 := (select id from outreach_ai_reply_runs where chat_id = c1 and status = 'debouncing');
  if (select reply_latency_s from outreach_ai_reply_runs where id = r2) = 30 and r3 is not null then log := log || E'\nok   reply latency to the AI send recorded; new run opened';
  else fails := fails + 1; log := log || E'\nFAIL latency: ' || coalesce((select reply_latency_s::text from outreach_ai_reply_runs where id = r2), 'null'); end if;

  -- ============================================================ 8. human takeover from the app with the AI draft
  update outreach_ai_reply_runs set status = 'drafting' where id = r3;
  perform outreach_ai_reply_finalize(r3, 'draft_ready', jsonb_build_object('decision', 'send', 'mode', 'draft', 'draft_text', 'Here are two films we made: https://cal.com/naman/15min',
          'stage_before', 'relate', 'stage_after', 'pitch', 'move', 'relate', 'rule_applied', 'Stage 2 · Relate', 'master_prompt_id', mp, 'master_prompt_version', 1,
          'side_effects', jsonb_build_array(jsonb_build_object('type', 'task', 'kind', 'follow_up', 'due', (current_date + 7)::text, 'note', 'Check they watched'))));
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s1, l1, 'reply', now(), 'sent', now(), 'k9-rep-' || ws, '{"text":"Here are two films we made (edited)"}') returning id into aid;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id, sent_by)
    values (ws, c1, 'm9-hum-' || ws, 'out', 'Here are two films we made (edited)', now() + interval '1 minute', aid, u_member) returning id into m_x;
  j := outreach_ai_reply_on_human_send(c1, m_x, r3, 0.2, false, u_member);
  if j->>'origin' = 'ai_edited' and (select status from outreach_ai_reply_runs where id = r3) = 'sent' and (select sent_origin from outreach_ai_reply_runs where id = r3) = 'ai_edited'
     and (select autopilot_state from outreach_chats where id = c1) = 'paused_human' and (select conversation_stage from outreach_chats where id = c1) = 'pitch'
     and (select conversation_exchanges from outreach_chats where id = c1) = 2 and not (select stage_stale from outreach_chats where id = c1)
     and exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'follow_up' and title like 'Follow up with Ann Lee%')
    then log := log || E'\nok   human send of the AI draft: ai_edited, stage → pitch, exchanges 2, paused_human, side-effect task';
    else fails := fails + 1; log := log || E'\nFAIL human send: ' || j::text || ' state=' || (select autopilot_state from outreach_chats where id = c1); end if;
  j := outreach__ai_effective(c1);
  if j->>'mode' = 'draft' and j->>'reason_code' = 'paused_human' then log := log || E'\nok   takeover pause drops autopilot to draft';
  else fails := fails + 1; log := log || E'\nFAIL paused effective: ' || j::text; end if;
  update outreach_chats set autopilot_state = 'active', autopilot_paused_until = null where id = c1;

  -- ============================================================ 9. outbound from the phone vs our own race
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in5-' || ws, 'in', 'ok thanks', now() + interval '2 minutes') returning id into m_in2;
  perform outreach_ai_reply_enqueue(c1, m_in2);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-ph-' || ws, 'out', 'Talk soon, Ann', now() + interval '3 minutes') returning id into m_x;
  t := outreach_ai_reply_on_outbound_external(m_x);
  if t = 'external_device' and (select origin from outreach_messages where id = m_x) = 'external_device' and (select autopilot_state from outreach_chats where id = c1) = 'paused_human'
     and not exists (select 1 from outreach_ai_reply_runs where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled'))
    then log := log || E'\nok   a message typed on the phone = takeover (runs cancelled, paused)';
    else fails := fails + 1; log := log || E'\nFAIL external: ' || t; end if;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, reserved_at, idempotency_key, payload)
    values (ws, s2, l2, 'message', now(), 'reserved', now(), 'k9-race-' || ws, '{"text":"Hi Ben"}');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c2, 'm9-race-' || ws, 'out', 'Hi Ben', now()) returning id into m_x;
  t := outreach_ai_reply_on_outbound_external(m_x);
  if t = 'ours' and (select origin from outreach_messages where id = m_x) <> 'external_device' then log := log || E'\nok   webhook beating our own insert (action in flight) is not a takeover';
  else fails := fails + 1; log := log || E'\nFAIL race: ' || t; end if;
  -- right after one of our sends that already recorded its message, a phone message is still a takeover
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s2, l2, 'reply', now(), 'sent', now(), 'k9-rec-' || ws, '{"text":"Recorded send"}') returning id into aid;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c2, 'm9-rec-' || ws, 'out', 'Recorded send', now(), aid);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c2, 'm9-ph2-' || ws, 'out', 'Typed on my phone', now() + interval '30 seconds') returning id into m_x;
  t := outreach_ai_reply_on_outbound_external(m_x);
  if t = 'external_device' then log := log || E'\nok   a phone message 30 s after a recorded send is still a takeover';
  else fails := fails + 1; log := log || E'\nFAIL phone after recorded send: ' || t; end if;

  -- ============================================================ 10. prepare_send rechecks
  update outreach_chats set autopilot_state = 'active', autopilot_paused_until = null where id = c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in6-' || ws, 'in', 'One more question', now() + interval '4 minutes') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  -- one transaction = one now(): place the run after the phone message above, as it would be in real time
  update outreach_ai_reply_runs set status = 'drafting', created_at = now() + interval '4 minutes' where id = r1;
  perform outreach_ai_reply_finalize(r1, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Sure, ask away.', 'master_prompt_id', mp, 'master_prompt_version', 1,
          'scheduled_send_at', now() - interval '1 minute', 'timings', jsonb_build_object('scheduled_at', now())));
  -- substantive prompt change since drafting → superseded and redrafted
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin
    perform outreach_master_prompt_save(ws, 'workspace', null, 'guided', null, sections || '{"facts":"- Turnaround is 3 weeks."}'::jsonb, '{}'::jsonb, 'substantive', 'facts', 1);
    t := 'saved';
  exception when others then t := sqlerrm; end;
  begin perform outreach_master_prompt_save(ws, 'workspace', null, 'guided', null, sections, '{}'::jsonb, 'style', 'stale', 1); t := t || '/no conflict'; exception when others then t := t || '/' || left(sqlerrm, 10); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'saved/E_CONFLICT' and (select substantive_version from outreach_master_prompts where id = mp) = 2 then log := log || E'\nok   substantive save bumps substantive_version; stale base version → E_CONFLICT';
  else fails := fails + 1; log := log || E'\nFAIL save v2: ' || t; end if;
  j := outreach__ai_effective(c1);
  if j->>'reason_code' = 'consent_missing' then log := log || E'\nok   substantive change invalidates the sender consent (re-consent needed)';
  else fails := fails + 1; log := log || E'\nFAIL reconsent: ' || j::text; end if;
  perform outreach_ai_reply_dispatch_claim(25, r1);
  j := outreach_ai_reply_prepare_send(r1);
  if j->>'to' = 'draft_ready' and (select status from outreach_ai_reply_runs where id = r1) = 'draft_ready' then log := log || E'\nok   recheck: consent no longer valid → the draft waits for a person';
  else fails := fails + 1; log := log || E'\nFAIL recheck consent: ' || j::text; end if;
  -- re-consent via a signed link: create → view → accept → revoke by token
  k := outreach_ai_consent_link_create(s1, mp, u_owner, 'owner9@test.local', '{"daily_cap":25,"delay_min_s":300,"delay_max_s":1200}', '[{"prospect":"hi","reply":"hello","stage":"engage"}]');
  tok := k->>'token';
  j := outreach_ai_consent_link_view(tok);
  k := outreach_ai_consent_link_accept(tok, '{"ip":"127.0.0.1","ua":"smoke"}');
  if j->>'status' = 'pending' and j->'master_prompt'->>'body' like '%3 weeks%' and (outreach__ai_effective(c1)->>'mode') = 'autopilot'
    then log := log || E'\nok   consent link: view shows the prompt text, accept restores autopilot';
    else fails := fails + 1; log := log || E'\nFAIL consent link: ' || j::text; end if;
  begin perform outreach_ai_consent_link_accept(tok, '{}'); t := 'accepted twice'; exception when others then t := left(sqlerrm, 10); end;
  if t = 'E_CONFLICT' then log := log || E'\nok   a consent link works once'; else fails := fails + 1; log := log || E'\nFAIL reuse: ' || t; end if;
  -- not our turn: the last message in the chat is ours
  update outreach_ai_reply_runs set status = 'scheduled', master_prompt_version = 2 where id = r1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, sent_by)
    values (ws, c1, 'm9-us2-' || ws, 'out', 'hold on', now() + interval '5 minutes', u_member) returning id into m_x;
  update outreach_messages set origin = 'sequence' where id = m_x;   -- not a teammate reply, so only the turn rule can stop it
  perform outreach_ai_reply_dispatch_claim(25, r1);
  j := outreach_ai_reply_prepare_send(r1);
  if j->>'why' = 'not_our_turn' then log := log || E'\nok   never two AI/our messages in a row'; else fails := fails + 1; log := log || E'\nFAIL turn: ' || j::text; end if;
  begin perform outreach_ai_consent_revoke_by_token('not-a-token', '{}'); t := 'revoked'; exception when others then t := left(sqlerrm, 11); end;
  if t = 'E_NOT_FOUND' then log := log || E'\nok   an unknown revoke token is refused'; else fails := fails + 1; log := log || E'\nFAIL bad token: ' || t; end if;
  -- a scheduled run of this sender; the owner's one-click revoke turns it back into a draft
  update outreach_ai_reply_runs set status = 'cancelled' where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled','sending');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in7-' || ws, 'in', 'Still there?', now() + interval '6 minutes') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  update outreach_ai_reply_runs set status = 'drafting' where id = r1;
  perform outreach_ai_reply_finalize(r1, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Yes, here.', 'master_prompt_id', mp, 'master_prompt_version', 2,
          'scheduled_send_at', now() + interval '5 minutes', 'timings', jsonb_build_object('scheduled_at', now())));
  j := outreach_ai_consent_revoke_by_token(k->>'revoke_token', '{"ip":"127.0.0.1"}');
  if (j->>'revoked')::int >= 1 and (select status from outreach_ai_reply_runs where id = r1) = 'draft_ready' and (outreach__ai_effective(c1)->>'reason_code') = 'consent_missing'
    then log := log || E'\nok   owner revoke link: consent revoked, scheduled send becomes a draft';
    else fails := fails + 1; log := log || E'\nFAIL revoke: ' || j::text || ' run=' || (select status::text from outreach_ai_reply_runs where id = r1); end if;

  -- ============================================================ 11. access scope
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  begin j := outreach_ai_reply_chat_state(c1); t := j->>'mode'; exception when others then t := sqlerrm; end;
  begin perform outreach_ai_reply_chat_state(c2); t := t || '/sawB'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin perform outreach_ai_reply_cancel(r1, 'wrong_tone', null); t := t || '/cancelled'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin perform outreach_ai_reply_runs_list(ws, '{}', 10, null); t := t || '/listed'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'draft/E_NOT_FOUND/E_FORBIDDEN/E_FORBIDDEN' then log := log || E'\nok   client viewer: own-client chat state only, cannot cancel or list runs';
  else fails := fails + 1; log := log || E'\nFAIL viewer: ' || t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_reply_policy_set(ws, 'workspace', null, '{"mode":"autopilot"}', null); t := 'set'; exception when others then t := left(sqlerrm, 11); end;
  begin perform outreach_ai_reply_set_chat_mode(c1, 'autopilot'); t := t || '/autopilot'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin j := outreach_ai_reply_set_chat_mode(c1, 'off'); t := t || '/' || (j->>'mode'); exception when others then t := t || '/' || sqlerrm; end;
  begin perform outreach_ai_consent_revoke(gen_random_uuid(), 'x'); t := t || '/rev'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin perform outreach_ai_reply_enqueue(c1, m_in3); t := t || '/enq'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'E_FORBIDDEN/E_FORBIDDEN/off/E_NOT_FOUND/permission ' and (select status from outreach_ai_reply_runs where id = r1) = 'cancelled'
    then log := log || E'\nok   member: no policy / autopilot changes, can turn a chat off (active runs cancelled), engine RPCs closed';
    else fails := fails + 1; log := log || E'\nFAIL member: ' || t || ' run=' || (select status::text from outreach_ai_reply_runs where id = r1); end if;
  update outreach_chats set reply_mode_override = null where id = c1;
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname in ('outreach_ai_reply_enqueue','outreach_ai_reply_claim','outreach_ai_reply_finalize','outreach_ai_reply_prepare_send','outreach_ai_reply_mark_sent',
                       'outreach_ai_reply_on_human_send','outreach_ai_reply_on_outbound_external','outreach_ai_consent_link_accept','outreach__ai_effective','outreach__ai_apply_side_effects',
                       'outreach_ai_reply_gate_facts','outreach_ai_reply_breakers','outreach_ai_consent_link_create');
  if n = 0 then log := log || E'\nok   engine functions are not executable by signed-in users';
  else fails := fails + 1; log := log || E'\nFAIL ' || n || ' engine function(s) callable by authenticated'; end if;

  -- ============================================================ 12. no_reply side effects, escalation task, after_classify
  update outreach_chats set autopilot_state = 'active', archived = false where id = c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in8-' || ws, 'in', 'Not interested, thanks', now() + interval '7 minutes') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  update outreach_ai_reply_runs set status = 'drafting' where id = r1;
  perform outreach_ai_reply_finalize(r1, 'no_reply', jsonb_build_object('decision', 'no_reply', 'rule_applied', 'Not interested',
          'side_effects', jsonb_build_array(jsonb_build_object('type', 'archive'), jsonb_build_object('type', 'set_tag', 'tag', 'not-now'))));
  if (select archived from outreach_chats where id = c1) and exists (select 1 from outreach_lead_tags lt join outreach_tags tg on tg.id = lt.tag_id where lt.lead_id = l1 and tg.name = 'not-now')
    then log := log || E'\nok   no_reply runs the prompt side effects (archive, tag)';
    else fails := fails + 1; log := log || E'\nFAIL no_reply side effects'; end if;
  update outreach_chats set archived = false where id = c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, attachments)
    values (ws, c1, 'm9-in9-' || ws, 'in', null, now() + interval '8 minutes', '[{"id":"a1","type":"img"}]') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  update outreach_ai_reply_runs set status = 'drafting' where id = r1;
  perform outreach_ai_reply_finalize(r1, 'escalated', jsonb_build_object('decision', 'escalate', 'escalation_reasons', jsonb_build_array('attachment')));
  if exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_escalation' and body like '%attachment%') and (select ai_escalation_reason from outreach_chats where id = c1) = 'attachment'
    then log := log || E'\nok   escalation → ai_escalation task + chat reason';
    else fails := fails + 1; log := log || E'\nFAIL escalation'; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin, ai_reply_run_id)
    values (ws, c1, 'm9-ai2-' || ws, 'out', 'Happy to help', now() + interval '9 minutes', 'ai_autopilot', r2);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, ai_flags)
    values (ws, c1, 'm9-in10-' || ws, 'in', 'Stop spamming me', now() + interval '10 minutes', array['hostile']) returning id into m_in3;
  j := outreach_ai_reply_after_classify(m_in3, false);
  if j->>'paused' = 'paused_escalated' and (select drew_hostile from outreach_ai_reply_runs where id = r2) then log := log || E'\nok   hostile reply to an AI send → paused_escalated';
  else fails := fails + 1; log := log || E'\nFAIL after_classify: ' || j::text; end if;
  update outreach_chats set autopilot_state = 'active' where id = c1;

  -- ============================================================ 13. message edit / delete during a run
  update outreach_ai_reply_runs set status = 'cancelled' where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled','sending');
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  t := outreach_ai_reply_on_message_change(m_in3, 'edited');
  n := (select count(*) from outreach_ai_reply_runs where chat_id = c1 and status = 'debouncing');
  t := t || '/' || outreach_ai_reply_on_message_change(m_in3, 'deleted');
  if t = 'superseded/cancelled' and n = 1 then log := log || E'\nok   edited message → superseded + redraft; deleted → cancelled';
  else fails := fails + 1; log := log || E'\nFAIL message change: ' || t; end if;

  -- ============================================================ 14. breakers: cancels during the hold downgrade the sequence
  update outreach_reply_policies set mode = 'autopilot', downgraded_at = null where workspace_id = ws and scope = 'sequence' and scope_id = q1;
  for n in 1..10 loop
    insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until,
                                       status, sent_origin, cancelled_by, cancel_reason, rule_applied, master_prompt_id, timings, created_at)
    values (ws, ca, c1, s1, l1, q1, 'LINKEDIN', array[m_in1], now(), now(), (case when n <= 3 then 'cancelled' else 'sent' end)::outreach_ai_reply_status_t,
            case when n > 3 then 'ai_autopilot' end, case when n <= 3 then u_member end, case when n <= 3 then 'too_early_to_pitch' end, 'Stage 1 · Engage', mp,
            jsonb_build_object('scheduled_at', now()), now() - interval '1 hour');
  end loop;
  update outreach_master_prompts set substantive_at = now() - interval '2 hours', version = 1 where id = mp;
  j := outreach_ai_reply_breakers();
  if exists (select 1 from jsonb_array_elements(j) x where x->>'kind' = 'downgrade_cancels' and (x->>'sequence_id')::uuid = q1)
     and (select mode from outreach_reply_policies where workspace_id = ws and scope = 'sequence' and scope_id = q1) = 'draft'
     and (select downgraded_at from outreach_reply_policies where workspace_id = ws and scope = 'sequence' and scope_id = q1) is not null
     and exists (select 1 from jsonb_array_elements(j) x where x->>'kind' = 'too_early_to_pitch')
    then log := log || E'\nok   breaker: 3 of 10 holds cancelled → sequence downgraded to draft; "too early to pitch" alert';
    else fails := fails + 1; log := log || E'\nFAIL breakers: ' || j::text; end if;
  update outreach_master_prompts set version = 3 where id = mp;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_reply_policy_set(ws, 'sequence', q1, '{"mode":"autopilot"}', null); t := 'no note ok'; exception when others then t := left(sqlerrm, 17); end;
  begin j := outreach_reply_policy_set(ws, 'sequence', q1, '{"mode":"autopilot"}', 'Tightened the pitch rule'); t := t || '/' || (j->>'mode'); exception when others then t := t || '/' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'E_PAYLOAD_INVALID/autopilot' then log := log || E'\nok   re-enabling after a downgrade needs a note';
  else fails := fails + 1; log := log || E'\nFAIL re-enable: ' || t; end if;

  -- ============================================================ 15. graduation
  delete from outreach_ai_reply_workspace where workspace_id = ws;
  j := outreach__ai_graduation_calc(mp);
  if not (j->>'eligible')::boolean and jsonb_array_length(j->'missing') >= 2 then log := log || E'\nok   graduation lists what is missing';
  else fails := fails + 1; log := log || E'\nFAIL graduation missing: ' || j::text; end if;
  for n in 1..30 loop
    insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, provider, inbound_message_ids, debounce_until, debounce_hard_until,
                                       status, sent_origin, edit_distance, facts_changed, master_prompt_id, master_prompt_version)
    values (ws, ca, c1, s1, l1, 'LINKEDIN', array[m_in1], now(), now(), 'sent', case when n % 5 = 0 then 'ai_edited' else 'ai_draft_sent' end,
            case when n % 5 = 0 then 0.3 else 0 end, false, mp, 2);
  end loop;
  insert into outreach_ai_reply_scenarios(workspace_id, master_prompt_id, name, turns, expected, passed, last_version)
    values (ws, null, 'price first', '[{"from":"prospect","text":"what do you charge?"}]', '[{"after_turn":0,"decision":"send"}]', true, 2);
  j := outreach_ai_reply_graduation_refresh();
  if exists (select 1 from jsonb_array_elements(j) x where x->>'kind' = 'graduated' and (x->>'master_prompt_id')::uuid = mp) and outreach__ai_graduated(mp)
    then log := log || E'\nok   30 drafts, 80% light edits, passing scenario → graduated';
    else fails := fails + 1; log := log || E'\nFAIL graduation: ' || j::text || ' calc=' || outreach__ai_graduation_calc(mp)::text; end if;

  -- ============================================================ 16. expiry, sweep, reports
  update outreach_ai_reply_runs set status = 'cancelled' where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled','sending');
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, created_at, draft_text)
    values (ws, c1, s1, 'LINKEDIN', array[m_in1], now(), now(), 'scheduled', now() - interval '25 hours', 'old') returning id into r1;
  j := outreach_ai_reply_expire();
  if (select status from outreach_ai_reply_runs where id = r1) = 'expired' then log := log || E'\nok   a hold older than 24 h expires (draft kept)';
  else fails := fails + 1; log := log || E'\nFAIL expire: ' || j::text; end if;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, reserved_at, idempotency_key, payload)
    values (ws, s1, l1, 'ai_reply', now(), 'reserved', now() - interval '20 minutes', 'k9-stale-' || ws, '{}') returning id into aid;
  perform outreach_sweep_stale_reservations();
  if (select status from outreach_actions where id = aid) = 'failed' then log := log || E'\nok   a stale reserved ai_reply is failed, never re-queued';
  else fails := fails + 1; log := log || E'\nFAIL sweep: ' || (select status::text from outreach_actions where id = aid); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_ai_reply_metrics(ws, current_date - 1, current_date + 1, 'sequence');
  k := outreach_ai_reply_runs_list(ws, '{"status":["sent"]}', 5, null);
  se := outreach_ai_reply_cancel_report(ws, 30);
  st := outreach_master_prompt_get(ws, 'sequence', q1, null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->'totals'->>'runs')::int > 30 and jsonb_array_length(k->'items') = 5 and k->>'next_before' is not null and jsonb_array_length(se) >= 1
     and not (st->>'exists')::boolean and st->'inherited'->>'scope' = 'workspace' and st->>'body' like '%3 weeks%'
    then log := log || E'\nok   metrics, paged run list, cancel report, inherited prompt for a sequence';
    else fails := fails + 1; log := log || E'\nFAIL reports: ' || left(j::text, 200) || ' ' || left(k::text, 100) || ' ' || left(st::text, 200); end if;

  -- ============================================================ 17. review fixes: column guard, human pre-send, rewrites, delivered-after-failure
  insert into outreach_master_prompts(workspace_id, scope, scope_id, body, settings) values (ws, 'client', cb, 'Client B prompt: secret prices here', '{}');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin update outreach_chats set reply_mode_override = 'autopilot' where id = c1; t := 'updated'; exception when others then t := left(sqlerrm, 11); end;
  begin update outreach_chats set ai_replies_count = 99, autopilot_state = 'paused_bot' where id = c1; t := t || '/updated'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin update outreach_chats set archived = false where id = c1; t := t || '/archive ok'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin perform outreach_ai_reply_set_chat_mode(c1, null); t := t || '/cleared'; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  begin select count(*) into n from outreach_master_prompts where workspace_id = ws; t := t || '/' || n; exception when others then t := t || '/' || left(sqlerrm, 11); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'E_FORBIDDEN/E_FORBIDDEN/archive ok/E_FORBIDDEN/1'
    then log := log || E'\nok   members cannot write AI chat columns directly or clear an override; prompts table is client-scoped';
    else fails := fails + 1; log := log || E'\nFAIL guard: ' || t; end if;
  -- a person sends while a reply is scheduled: the draft being sent is held back, the rest stops; an AI send in flight refuses
  update outreach_ai_reply_runs set status = 'cancelled' where chat_id = c1 and status in ('debouncing','drafting','draft_ready','scheduled','sending');
  update outreach_chats set autopilot_state = 'active', autopilot_paused_until = null, archived = false where id = c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-in11-' || ws, 'in', 'Any update?', now() + interval '11 minutes') returning id into m_in3;
  j := outreach_ai_reply_enqueue(c1, m_in3); r1 := (j->>'run_id')::uuid;
  update outreach_ai_reply_runs set status = 'drafting' where id = r1;
  perform outreach_ai_reply_finalize(r1, 'scheduled', jsonb_build_object('decision', 'send', 'mode', 'autopilot', 'draft_text', 'Yes, working on it.', 'master_prompt_id', mp,
          'master_prompt_version', 3, 'scheduled_send_at', now() + interval '10 minutes', 'timings', jsonb_build_object('scheduled_at', now())));
  j := outreach_ai_reply_before_human_send(c1, r1);
  if (j->>'ok')::boolean and (select status from outreach_ai_reply_runs where id = r1) = 'draft_ready'
    then log := log || E'\nok   before a person sends: their draft is held back from the dispatcher';
    else fails := fails + 1; log := log || E'\nFAIL before_human_send: ' || j::text; end if;
  -- mostly rewritten: the person's own reply (no AI origin, the run stops)
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, sent_by)
    values (ws, c1, 'm9-own-' || ws, 'out', 'Totally different words from me', now() + interval '12 minutes', u_member) returning id into m_x;
  j := outreach_ai_reply_on_human_send(c1, m_x, r1, 0.8, true, u_member);
  if j->>'origin' = 'inbox_user' and (select status from outreach_ai_reply_runs where id = r1) = 'cancelled'
    then log := log || E'\nok   a reply rewritten beyond half counts as the person''s own';
    else fails := fails + 1; log := log || E'\nFAIL rewrite: ' || j::text || ' ' || (select status::text from outreach_ai_reply_runs where id = r1); end if;
  -- an AI send in flight: a person's send is refused
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, draft_text)
    values (ws, c1, s1, 'LINKEDIN', array[m_in3], now(), now(), 'sending', 'x') returning id into r2;
  j := outreach_ai_reply_before_human_send(c1, null);
  if j->>'why' = 'ai_sending' then log := log || E'\nok   a person cannot send over an AI send in flight';
  else fails := fails + 1; log := log || E'\nFAIL in-flight guard: ' || j::text; end if;
  -- the AI send failed ambiguously, then the webhook shows it did go out: recorded as sent, task closed
  update outreach_ai_reply_runs set status = 'failed', final_text = 'Delivered after all', error = '504:timeout' where id = r2;
  insert into outreach_tasks(workspace_id, kind, chat_id, lead_id, sender_id, title) values (ws, 'ai_escalation', c1, l1, s1, 'AI reply may not have been sent');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm9-late-' || ws, 'out', 'Delivered after all', now() + interval '13 minutes') returning id into m_x;
  t := outreach_ai_reply_on_outbound_external(m_x);
  if t = 'ours_ai' and (select status from outreach_ai_reply_runs where id = r2) = 'sent' and (select origin from outreach_messages where id = m_x) = 'ai_autopilot'
     and not exists (select 1 from outreach_tasks where chat_id = c1 and kind = 'ai_escalation' and completed_at is null)
    then log := log || E'\nok   an AI send that timed out but arrived is recorded as sent, not as a takeover';
    else fails := fails + 1; log := log || E'\nFAIL delivered-after-failure: ' || t || ' ' || (select status::text from outreach_ai_reply_runs where id = r2); end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (ai replies)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
