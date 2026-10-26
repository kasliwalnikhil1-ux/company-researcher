-- Smoke test — 101 sequence lead filters, bulk unenroll & Analytics (PRD Sequence lead filters, bulk unenroll & Analytics.md).
-- Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Runs as the service role; the teammate paths set request.jwt.claims for one call so auth.uid() is a real user.
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_31_sequence_leads_analytics.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; j2 jsonb; n int; r record; a uuid; c uuid; m uuid; batch uuid; batch2 uuid; st text;
  ws uuid; u_owner uuid; s1 uuid; q uuid; q2 uuid; seq int := 0;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; l6 uuid; l7 uuid; l8 uuid; l9 uuid; l10 uuid;
  e1 uuid; e2 uuid; e3 uuid; e4 uuid; e5 uuid; e6 uuid; e7 uuid; e8 uuid; e9 uuid; e10 uuid;
  a1 uuid; a4 uuid; t0 timestamptz := now() - interval '2 days';
  g jsonb := '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect","next":"n2"},"n2":{"id":"n2","type":"wait_connection","next":"n3"},"n3":{"id":"n3","type":"send_message","label":"Follow-up","next":"n4"},"n4":{"id":"n4","type":"delay","config":{"amount":2,"unit":"days"},"next":"n5"},"n5":{"id":"n5","type":"send_message","label":"Nudge"}}}'::jsonb;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by) values ('smoke31', 'smoke31-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner31@test.local', 'Naman');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at) values (ws, 'LINKEDIN', 'Naman LI', 'ok', 's31a-' || ws, 'owner31@test.local', t0 - interval '10 days') returning id into s1;
  l1 := gen_random_uuid(); l2 := gen_random_uuid(); l3 := gen_random_uuid(); l4 := gen_random_uuid(); l5 := gen_random_uuid();
  l6 := gen_random_uuid(); l7 := gen_random_uuid(); l8 := gen_random_uuid(); l9 := gen_random_uuid(); l10 := gen_random_uuid();
  insert into outreach_leads(id, workspace_id, public_identifier, full_name, company) select x.id, ws, 'l31-' || x.i || '-' || left(ws::text, 8), 'Lead ' || x.i, 'Acme ' || x.i
    from (values (l1,1),(l2,2),(l3,3),(l4,4),(l5,5),(l6,6),(l7,7),(l8,8),(l9,9),(l10,10)) x(id, i);
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'Smoke 31', 'active', array[s1], u_owner, t0 - interval '5 days', g) returning id into q;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'Smoke 31 empty', 'active', array[s1], u_owner, t0, g) returning id into q2;

  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, created_at) values (ws, q, 1, l1, s1, 'active', 'n3', t0) returning id into e1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, wait_until, created_at) values (ws, q, 1, l2, s1, 'waiting_connection', 'n2', now() + interval '10 days', t0) returning id into e2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, wait_until, created_at) values (ws, q, 1, l3, s1, 'waiting_delay', 'n4', now() + interval '1 day', t0) returning id into e3;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, wait_reason, created_at) values (ws, q, 1, l4, s1, 'waiting_task', 'n3', 'enrichment', t0) returning id into e4;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, paused_from, created_at) values (ws, q, 1, l5, s1, 'paused', 'n3', 'active', t0) returning id into e5;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, completed_at, created_at) values (ws, q, 1, l6, s1, 'completed', 'n5', t0 + interval '1 day', t0) returning id into e6;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, exit_reason, completed_at, created_at) values (ws, q, 1, l7, s1, 'exited_replied', 'n3', 'replied', t0 + interval '1 day', t0) returning id into e7;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, created_at) values (ws, q, 1, l8, s1, 'active', 'n3', t0) returning id into e8;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, exit_reason, completed_at, created_at) values (ws, q, 1, l9, s1, 'exited_suppressed', 'n3', 'do_not_contact', t0 + interval '1 day', t0) returning id into e9;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, exit_reason, completed_at, created_at) values (ws, q, 1, l10, s1, 'failed', 'n3', 'E_RELATION_INVALID', t0 + interval '1 day', t0) returning id into e10;

  -- e1: invite sent (n1), a queued follow-up (n3) tomorrow, one message out from the sequence
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l1, e1, 'n1', 'invite', t0, 'sent', t0, 'smoke31-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key) values (ws, s1, l1, e1, 'n3', 'message', now() + interval '1 day', 'queued', 'smoke31-' || seq || '-' || ws) returning id into a1;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s1, l1, 'c31-l1-' || ws, 'LINKEDIN', 'Lead 1') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, is_invite_note) values (ws, c, 'm31-l1-note-' || ws, 'out', 'Hi Lead 1, would love to connect about   the pricing of our studio', t0, true);
  -- e2: the invitation went out from n1 (the acceptance is credited to it)
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l2, e2, 'n1', 'invite', t0, 'sent', t0, 'smoke31-' || seq || '-' || ws);
  -- e4: a queued action, to check the unenroll cancels it and undo brings it back
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key) values (ws, s1, l4, e4, 'n3', 'message', now() + interval '1 day', 'queued', 'smoke31-' || seq || '-' || ws) returning id into a4;
  -- e7: a handoff, with the reply and a teammate's answer afterwards
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l7, e7, 'n3', 'message', t0 + interval '12 hours', 'sent', t0 + interval '12 hours', 'smoke31-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s1, l7, 'c31-l7-' || ws, 'LINKEDIN', 'Lead 7') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm31-l7-out-' || ws, 'out', 'Will you be interested in a quick call?', t0 + interval '12 hours', a);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm31-l7-in-' || ws, 'in', 'Yes, what are the prices?', t0 + interval '1 day');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, sent_by) values (ws, c, 'm31-l7-answer-' || ws, 'out', 'Happy to share, here is the deck', t0 + interval '1 day 2 hours', u_owner);

  -- e8: stopped by the owner (a signed-in teammate), through the existing exit RPC
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  perform outreach_exit_enrollment(e8, 'manual');
  perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 1. counts
  j := outreach_sequence_lead_counts(q);
  if (j->>'all')::int = 10 then log := log || E'\nok   1a All = 10 (do-not-contact leads stay in All)'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || j::text; end if;
  if (j->>'live')::int = 5 and (j->>'active')::int = 2 and (j->>'invite_sent')::int = 1 and (j->>'waiting_task')::int = 1 and (j->>'paused')::int = 1 then log := log || E'\nok   1b in-progress counts (Active = active + waiting_delay, Invite sent = waiting_connection)'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || j::text; end if;
  if (j->>'completed')::int = 1 and (j->>'handoff')::int = 1 and (j->>'stopped_by_teammate')::int = 1 and (j->>'sender_disabled')::int = 0 and (j->>'failed')::int = 1 and (j->>'unenrolled')::int = 0 and (j->>'do_not_contact')::int = 1 then log := log || E'\nok   1c ended counts'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || j::text; end if;
  if (j->>'live')::int + (j->>'completed')::int + (j->>'handoff')::int + (j->>'stopped_by_teammate')::int + (j->>'sender_disabled')::int + (j->>'failed')::int + (j->>'unenrolled')::int + (j->>'do_not_contact')::int = (j->>'all')::int then log := log || E'\nok   1d the groups add up to All'; else fails := fails + 1; log := log || E'\nFAIL 1d'; end if;
  if jsonb_array_length(j->'teammates') = 1 and j#>>'{teammates,0,user_id}' = u_owner::text and j#>>'{teammates,0,name}' = 'Naman' and (j#>>'{teammates,0,count}')::int = 1 then log := log || E'\nok   1e the teammate behind Stopped by teammate, by name'; else fails := fails + 1; log := log || E'\nFAIL 1e ' || (j->'teammates')::text; end if;
  select status_changed_by, status into r from outreach_enrollments where id = e8;
  if r.status_changed_by = u_owner and r.status = 'exited_manual' then log := log || E'\nok   1f the exit RPC records who stopped the lead'; else fails := fails + 1; log := log || E'\nFAIL 1f ' || coalesce(r.status_changed_by::text, 'null'); end if;
  select count(*) into n from outreach_enrollment_status_log where enrollment_id = e8 and prev_status = 'active' and new_status = 'exited_manual' and actor = u_owner and actor_type = 'user' and reason = 'manual';
  if n = 1 then log := log || E'\nok   1g the status log row: active → exited_manual, actor, reason'; else fails := fails + 1; log := log || E'\nFAIL 1g rows: ' || n; end if;
  j2 := outreach_sequence_lead_counts(q, (now() at time zone 'UTC')::date + 1, (now() at time zone 'UTC')::date + 2);
  if (j2->>'all')::int = 0 then log := log || E'\nok   1h an enrolled-in window (the Analytics link) narrows every count'; else fails := fails + 1; log := log || E'\nFAIL 1h ' || j2::text; end if;

  -- ============================================================ 2. the paginated table
  j := outreach_sequence_leads(q, 'live', null, null, null, null, 2, 0);
  if (j->>'total')::int = 5 and jsonb_array_length(j->'rows') = 2 and (j->>'step_total')::int = 3 then log := log || E'\nok   2a live: exact total 5, page of 2, 3 steps'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || (j - 'rows')::text; end if;
  j := outreach_sequence_leads(q, 'live', null, null, null, null, 2, 4);
  if jsonb_array_length(j->'rows') = 1 then log := log || E'\nok   2b the last page has the remainder'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || jsonb_array_length(j->'rows'); end if;
  j := outreach_sequence_leads(q, 'active');
  if (j->>'total')::int = 2 and exists (select 1 from jsonb_array_elements(j->'rows') x where x->>'id' = e3::text) then log := log || E'\nok   2c Active includes the lead waiting in a Delay step'; else fails := fails + 1; log := log || E'\nFAIL 2c'; end if;
  j := outreach_sequence_leads(q, 'invite_sent');
  if (j->>'total')::int = 1 and j#>>'{rows,0,id}' = e2::text and j#>>'{rows,0,next,kind}' = 'wait' then log := log || E'\nok   2d Invite sent = the lead waiting for acceptance, next = the wait'; else fails := fails + 1; log := log || E'\nFAIL 2d ' || j::text; end if;
  j := outreach_sequence_leads(q, 'all', null, null, null, 'acme 1');
  if (j->>'total')::int = 2 then log := log || E'\nok   2e search by company (Acme 1, Acme 10)'; else fails := fails + 1; log := log || E'\nFAIL 2e ' || (j->>'total'); end if;
  select x into j from jsonb_array_elements(outreach_sequence_leads(q, 'all')->'rows') x where x->>'id' = e1::text;
  if (j->>'step_index')::int = 2 and j#>>'{next,kind}' = 'action' and j#>>'{next,node_id}' = 'n3' and j#>>'{last_message,text}' = 'Hi Lead 1, would love to connect about the pricing of our studio' and j->>'last_reply' is null then log := log || E'\nok   2f e1: Step 2 of 3, next = the queued follow-up, last message snippet (whitespace collapsed), no reply'; else fails := fails + 1; log := log || E'\nFAIL 2f ' || j::text; end if;
  select x into j from jsonb_array_elements(outreach_sequence_leads(q, 'handoff')->'rows') x where x->>'id' = e7::text;
  if j#>>'{last_reply,text}' = 'Yes, what are the prices?' and j->>'next' is null then log := log || E'\nok   2g e7: the reply snippet, no next step once ended'; else fails := fails + 1; log := log || E'\nFAIL 2g ' || j::text; end if;
  select x into j from jsonb_array_elements(outreach_sequence_leads(q, 'stopped_by_teammate', u_owner)->'rows') x where x->>'id' = e8::text;
  if j#>>'{changed_by,name}' = 'Naman' and j->>'changed_at' is not null then log := log || E'\nok   2h Stopped by = Naman; the teammate sub-filter finds the row'; else fails := fails + 1; log := log || E'\nFAIL 2h ' || coalesce(j::text, 'null'); end if;
  j := outreach_sequence_leads(q, 'stopped_by_teammate', gen_random_uuid());
  if (j->>'total')::int = 0 then log := log || E'\nok   2i another teammate has no stops'; else fails := fails + 1; log := log || E'\nFAIL 2i'; end if;
  begin
    perform outreach_sequence_leads(q, 'waiting');
    fails := fails + 1; log := log || E'\nFAIL 2j the removed "waiting" filter was accepted';
  exception when others then log := log || E'\nok   2j the removed filters (waiting, do not contact as an option) are refused: ' || left(sqlerrm, 40); end;

  -- ============================================================ 3. bulk unenroll + undo
  j := outreach_sequence_bulk_preview(q, 'unenroll', array[e3, e4, e6]);
  if (j->>'total')::int = 3 and (j->>'eligible')::int = 2 and (j->>'skipped')::int = 1 and j->>'sequence_name' = 'Smoke 31' then log := log || E'\nok   3a preview: 2 eligible, the finished lead skipped'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || j::text; end if;
  j := outreach_sequence_bulk(q, 'unenroll', array[e3, e4, e6]);
  batch := (j->>'batch_id')::uuid;
  if (j->>'done')::int = 2 and (j->>'skipped')::int = 1 and batch is not null then log := log || E'\nok   3b unenroll by ids: 2 done, 1 skipped, a batch id'; else fails := fails + 1; log := log || E'\nFAIL 3b ' || j::text; end if;
  select status, exit_reason, wait_until, completed_at into r from outreach_enrollments where id = e3;
  if r.status = 'cancelled' and r.exit_reason = 'unenrolled' and r.wait_until is null and r.completed_at is not null then log := log || E'\nok   3c the lead is Unenrolled (cancelled / unenrolled), its wait cleared'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || r.status::text; end if;
  select status, decision into r from outreach_actions where id = a4;
  if r.status = 'cancelled' then log := log || E'\nok   3d the queued step was cancelled (' || coalesce(r.decision, '') || ')'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || r.status::text; end if;
  select count(*) into n from outreach_enrollment_status_log where batch_id = batch and new_status = 'cancelled' and reason = 'unenrolled';
  if n = 2 then log := log || E'\nok   3e two log rows carry the batch and the reason'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || n; end if;
  j := outreach_sequence_lead_counts(q);
  if (j->>'unenrolled')::int = 2 and (j->>'live')::int = 3 and (j->>'all')::int = 10 then log := log || E'\nok   3f counts follow: Unenrolled 2, Live 3, All still 10'; else fails := fails + 1; log := log || E'\nFAIL 3f ' || j::text; end if;
  j := outreach_sequence_bulk_undo(batch);
  if (j->>'restored')::int = 2 and (j->>'skipped')::int = 0 then log := log || E'\nok   3g undo restored both'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || j::text; end if;
  select status, wait_until, current_node_id, completed_at, exit_reason into r from outreach_enrollments where id = e3;
  if r.status = 'waiting_delay' and r.wait_until is not null and r.current_node_id = 'n4' and r.completed_at is null and r.exit_reason is null then log := log || E'\nok   3h e3 is back in its Delay with its schedule'; else fails := fails + 1; log := log || E'\nFAIL 3h ' || r.status::text; end if;
  select status, wait_reason into r from outreach_enrollments where id = e4;
  if r.status = 'waiting_task' then log := log || E'\nok   3i e4 is back on its task'; else fails := fails + 1; log := log || E'\nFAIL 3i ' || r.status::text; end if;
  select status, decision, reserved_at into r from outreach_actions where id = a4;
  if r.status = 'queued' and r.decision is null and r.reserved_at is null then log := log || E'\nok   3j the cancelled step is queued again'; else fails := fails + 1; log := log || E'\nFAIL 3j ' || r.status::text; end if;
  select count(*) into n from outreach_enrollment_status_log where batch_id = batch and reason = 'undo';
  if n = 2 then log := log || E'\nok   3k the undo is in the log too'; else fails := fails + 1; log := log || E'\nFAIL 3k ' || n; end if;
  j := outreach_sequence_bulk_undo(batch);
  if (j->>'restored')::int = 0 and (j->>'skipped')::int = 0 then log := log || E'\nok   3l undoing twice does nothing'; else fails := fails + 1; log := log || E'\nFAIL 3l ' || j::text; end if;
  -- by filter, in chunks: "select all 3 live leads" one at a time with the same batch
  j := outreach_sequence_bulk(q, 'unenroll', null, 'live', null, null, null, null, null, 1);
  batch2 := (j->>'batch_id')::uuid;
  if (j->>'done')::int = 1 and (j->>'remaining')::int = 4 then log := log || E'\nok   3m by filter, 1 per call: done 1, remaining 4'; else fails := fails + 1; log := log || E'\nFAIL 3m ' || j::text; end if;
  j := outreach_sequence_bulk(q, 'unenroll', null, 'live', null, null, null, null, batch2, 500);
  if (j->>'done')::int = 4 and (j->>'remaining')::int = 0 and (j->>'batch_id')::uuid = batch2 then log := log || E'\nok   3n the next call finishes the rest under the same batch'; else fails := fails + 1; log := log || E'\nFAIL 3n ' || j::text; end if;
  j := outreach_sequence_lead_counts(q);
  if (j->>'live')::int = 0 and (j->>'unenrolled')::int = 5 then log := log || E'\nok   3o nothing live, 5 unenrolled'; else fails := fails + 1; log := log || E'\nFAIL 3o ' || j::text; end if;
  j := outreach_sequence_bulk_undo(batch2);
  if (j->>'restored')::int = 5 then log := log || E'\nok   3p undo of the whole filter batch'; else fails := fails + 1; log := log || E'\nFAIL 3p ' || j::text; end if;
  select status, paused_from into r from outreach_enrollments where id = e5;
  if r.status = 'paused' and r.paused_from = 'active' then log := log || E'\nok   3q the paused lead is paused again'; else fails := fails + 1; log := log || E'\nFAIL 3q ' || r.status::text; end if;
  -- pause / resume
  j := outreach_sequence_bulk(q, 'pause', array[e1, e5, e6]);
  if (j->>'done')::int = 1 and (j->>'skipped')::int = 2 then log := log || E'\nok   3r pause: only the active lead; paused and finished skipped'; else fails := fails + 1; log := log || E'\nFAIL 3r ' || j::text; end if;
  j := outreach_sequence_bulk(q, 'resume', array[e1, e5]);
  if (j->>'done')::int = 2 then log := log || E'\nok   3s resume both'; else fails := fails + 1; log := log || E'\nFAIL 3s ' || j::text; end if;
  select status into st from outreach_enrollments where id = e1;
  if st = 'active' then log := log || E'\nok   3t e1 is active again'; else fails := fails + 1; log := log || E'\nFAIL 3t ' || st; end if;
  -- expiry
  j := outreach_sequence_bulk(q, 'unenroll', array[e6]);   -- nothing eligible: still a batch, no rows
  update outreach_enrollment_undo set at = now() - interval '16 minutes' where batch_id = batch;
  begin
    perform outreach_sequence_bulk_undo(batch);
    fails := fails + 1; log := log || E'\nFAIL 3u an expired batch was undone';
  exception when others then if sqlerrm like 'E_UNDO_EXPIRED%' then log := log || E'\nok   3u undo expires after 15 minutes'; else fails := fails + 1; log := log || E'\nFAIL 3u ' || sqlerrm; end if; end;
  begin
    perform outreach_sequence_bulk(q, 'delete', array[e6]);
    fails := fails + 1; log := log || E'\nFAIL 3v an unknown action was accepted';
  exception when others then log := log || E'\nok   3v unknown actions are refused'; end;

  -- ============================================================ 4. step runs from the real triggers
  update outreach_actions set status = 'sent', executed_at = now() where id = a1;
  select count(*) into n from outreach_step_runs where enrollment_id = e1 and node_id = 'n3' and outcome = 'sent' and action_id = a1 and sender_id = s1;
  if n = 1 then log := log || E'\nok   4a queued → sent writes a sent run with the sender'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || n; end if;
  update outreach_actions set status = 'sent' where id = a1;   -- a no-op update
  select count(*) into n from outreach_step_runs where action_id = a1 and outcome = 'sent';
  if n = 1 then log := log || E'\nok   4b runs are written once per action and outcome'; else fails := fails + 1; log := log || E'\nFAIL 4b ' || n; end if;
  select id into c from outreach_chats where lead_id = l1 and sender_id = s1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm31-l1-out-' || ws, 'out', 'Follow-up text', now(), a1) returning id into m;
  update outreach_messages set read_at = now() where id = m;
  select count(*) into n from outreach_step_runs where enrollment_id = e1 and node_id = 'n3' and outcome = 'read';
  if n = 1 then log := log || E'\nok   4c a read receipt writes a read run on the step'; else fails := fails + 1; log := log || E'\nFAIL 4c ' || n; end if;
  -- acceptance while waiting on the invite step (e2): the run is written before the engine moves the lead on
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at) values (l2, s1, 'pending_out', t0) on conflict (lead_id, sender_id) do update set relation = 'pending_out';
  update outreach_lead_sender_state set relation = 'first', invite_accepted_at = now() where lead_id = l2 and sender_id = s1;
  select count(*) into n from outreach_step_runs where enrollment_id = e2 and node_id = 'n1' and outcome = 'accepted';
  if n = 1 then log := log || E'\nok   4d acceptance writes an accepted run on the invite step that sent it'; else fails := fails + 1; log := log || E'\nFAIL 4d ' || n; end if;
  -- a reply from lead 1: credited to the last step that went out (n3)
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (l1, s1, 'first') on conflict (lead_id, sender_id) do nothing;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l1 and sender_id = s1;
  select count(*) into n from outreach_step_runs where enrollment_id = e1 and node_id = 'n3' and outcome = 'replied';
  if n = 1 then log := log || E'\nok   4e a reply writes a replied run on the last sent step'; else fails := fails + 1; log := log || E'\nFAIL 4e ' || n; end if;
  select status into st from outreach_enrollments where id = e1;
  if st = 'exited_replied' then log := log || E'\nok   4f and the lead went to Human handoff through the existing trigger'; else fails := fails + 1; log := log || E'\nFAIL 4f ' || st; end if;

  -- ============================================================ 5. analytics
  j := outreach_sequence_analytics(q2);
  if (j->>'empty')::boolean and jsonb_array_length(j->'steps') = 3 then log := log || E'\nok   5a a sequence that never ran: empty = true, the steps still listed'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || (j - 'steps' - 'daily')::text; end if;
  j := outreach_sequence_analytics(q);
  if not (j->>'empty')::boolean and (j#>>'{period,default}')::boolean and (j#>>'{period,to}')::date - (j#>>'{period,from}')::date = 29 then log := log || E'\nok   5b default period = the last 30 days'; else fails := fails + 1; log := log || E'\nFAIL 5b ' || (j->'period')::text; end if;
  if (j#>>'{cards,enrolled}')::int = 10 then log := log || E'\nok   5c Enrolled = 10'; else fails := fails + 1; log := log || E'\nFAIL 5c ' || (j->'cards')::text; end if;
  if (j#>>'{progress,total}')::int = 10 and (j#>>'{progress,handoff}')::int = 2 and (j#>>'{progress,stopped}')::int = 2 and (j#>>'{progress,failed}')::int = 1
     and (j#>>'{progress,live}')::int + (j#>>'{progress,completed}')::int + (j#>>'{progress,handoff}')::int + (j#>>'{progress,stopped}')::int + (j#>>'{progress,failed}')::int + (j#>>'{progress,unenrolled}')::int = 10
  then log := log || E'\nok   5d lead progress adds up (handoff 2 = fixture + lead 1; stopped 2 = teammate + do not contact)'; else fails := fails + 1; log := log || E'\nFAIL 5d ' || (j->'progress')::text; end if;
  j2 := outreach_sequence_lead_counts(q);
  if (j#>>'{progress,handoff}')::int = (j2->>'handoff')::int and (j#>>'{progress,live}')::int = (j2->>'live')::int and (j#>>'{progress,unenrolled}')::int = (j2->>'unenrolled')::int then log := log || E'\nok   5e Analytics totals = the Leads tab counts'; else fails := fails + 1; log := log || E'\nFAIL 5e'; end if;
  select x into j2 from jsonb_array_elements(j->'steps') x where x->>'node_id' = 'n3';
  if (j2->>'step_number')::int = 2 and (j2->>'sent')::int = 1 and (j2->>'read')::int = 1 and (j2->>'replied')::int = 1 and j2 ? 'variant_id' then log := log || E'\nok   5f step table: Follow-up is step 2, sent 1 · read 1 · replied 1, variant column present'; else fails := fails + 1; log := log || E'\nFAIL 5f ' || coalesce(j2::text, 'null'); end if;
  select x into j2 from jsonb_array_elements(j->'steps') x where x->>'node_id' = 'n1';
  if (j2->>'accepted')::int = 1 then log := log || E'\nok   5g the Invite row shows the acceptance'; else fails := fails + 1; log := log || E'\nFAIL 5g ' || coalesce(j2::text, 'null'); end if;
  if jsonb_array_length(j#>'{daily,days}') = 30 and (select sum((x->>'sent')::int) from jsonb_array_elements(j#>'{daily,days}') x) >= 1 then log := log || E'\nok   5h planned vs sent: 30 days, sends counted'; else fails := fails + 1; log := log || E'\nFAIL 5h ' || (j->'daily')::text; end if;
  select x into j2 from jsonb_array_elements(j->'senders') x where x->>'id' = s1::text;
  if j2->>'name' = 'Naman LI' and j2->>'status' = 'ok' and (j2->>'sent')::int >= 1 and (j2->>'in_pool')::boolean then log := log || E'\nok   5i the sender row: status, sends, in the pool'; else fails := fails + 1; log := log || E'\nFAIL 5i ' || coalesce(j2::text, 'null'); end if;
  select x into j2 from jsonb_array_elements(j->'team') x where x->>'user_id' = u_owner::text;
  if j2->>'name' = 'Naman' and (j2->>'stopped')::int = 1 and (j2->>'handoffs_taken')::int = 1 and (j2->>'unenrolled')::int = 0 then log := log || E'\nok   5j team: Naman took 1 handoff, stopped 1, unenrolled 0 (the undone unenrolls were by the system)'; else fails := fails + 1; log := log || E'\nFAIL 5j ' || coalesce(j2::text, 'null'); end if;
  j := outreach_sequence_analytics_leads(q, null, null, 3, 0);
  if (j->>'total')::int = 10 and jsonb_array_length(j->'rows') = 3 then log := log || E'\nok   5k the lead table: exact total, paginated'; else fails := fails + 1; log := log || E'\nFAIL 5k ' || (j - 'rows')::text; end if;
  select x into j2 from jsonb_array_elements(outreach_sequence_analytics_leads(q, null, null, 50, 0)->'rows') x where x->>'id' = e1::text;
  if (j2->>'step_reached')::int = 2 and (j2->>'step_total')::int = 3 then log := log || E'\nok   5l lead 1 reached step 2 of 3'; else fails := fails + 1; log := log || E'\nFAIL 5l ' || coalesce(j2::text, 'null'); end if;
  begin
    perform outreach_sequence_analytics(q, (now() at time zone 'UTC')::date, (now() at time zone 'UTC')::date - 1);
    fails := fails + 1; log := log || E'\nFAIL 5m from > to was accepted';
  exception when others then log := log || E'\nok   5m from > to is refused'; end;

  -- ============================================================ 6. plan snapshot, grants, cron
  n := outreach_plan_snapshot();
  if exists (select 1 from outreach_sequence_daily_plan where sequence_id = q and sender_id = s1) or n >= 0 then log := log || E'\nok   6a the plan snapshot runs'; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_sequence_lead_counts','outreach_sequence_leads','outreach_sequence_bulk','outreach_sequence_bulk_preview','outreach_sequence_bulk_undo','outreach_sequence_analytics','outreach_sequence_analytics_leads');
  if n = 7 then log := log || E'\nok   6b the seven user RPCs are granted'; else fails := fails + 1; log := log || E'\nFAIL 6b granted: ' || n; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach__sequence_lead_ids','outreach__sequence_access','outreach__step_run','outreach_plan_snapshot','outreach__batch_ctx','outreach_has_role');
  if n = 0 then log := log || E'\nok   6c the internal functions are not callable by signed-in users'; else fails := fails + 1; log := log || E'\nFAIL 6c leaked: ' || n; end if;
  select count(*) into n from cron.job where jobname in ('outreach-plan-snapshot', 'outreach-undo-prune');
  if n = 2 then log := log || E'\nok   6d the two cron jobs exist'; else fails := fails + 1; log := log || E'\nFAIL 6d ' || n; end if;
  select count(*) into n from pg_trigger where tgname in ('outreach_enr_aa_status_log','outreach_actions_zy_step_run','outreach_lss_a_step_run_accept','outreach_lss_a_step_run_reply','outreach_messages_zy_step_run_read');
  if n = 5 then log := log || E'\nok   6e the five triggers exist'; else fails := fails + 1; log := log || E'\nFAIL 6e ' || n; end if;
  if 'outreach_lss_a_step_run_accept' < 'outreach_lss_relation' and 'outreach_lss_a_step_run_reply' < 'outreach_lss_reply_exit' then log := log || E'\nok   6f the run triggers sort before the engine triggers (fire first)'; else fails := fails + 1; log := log || E'\nFAIL 6f'; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
