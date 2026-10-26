-- Smoke test — 095/096 sender lifecycle (sender-lifecycle-PRD.md §12). Builds fixtures, asserts, then RAISES so everything
-- rolls back. Ends with "SMOKE OK". Runs as the service role: role checks pass, auth.uid() is null.
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_28_sender_lifecycle.sql
-- Nothing here calls an edge function or the connector: the connector delete is simulated with outreach_account_deletion_result.
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int; b boolean; t text; u uuid; p uuid[]; tok text; paths jsonb; ts timestamptz;
  ws uuid; u_owner uuid; s_a uuid; s_b uuid; s_c uuid; s_ph uuid; q1 uuid; q2 uuid; l1 uuid; l2 uuid; l3 uuid; e1 uuid; e2 uuid; e3 uuid;
  chat_a uuid; chat_b uuid; rid uuid; job uuid; run_a uuid; act_old uuid; acct_a text; acct_b text; n_actions_b int; q3 uuid;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by) values ('smoke25', 'smoke25-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner25@test.local');
  acct_a := 's25a-' || ws; acct_b := 's25b-' || ws;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, public_identifier, owner_email, connected_at, warmup_level, timezone)
    values (ws, 'LINKEDIN', 'Alice Sender', 'ok', acct_a, 'pid-a-' || ws, 'alice-' || left(ws::text, 8), 'alice25@test.local', now() - interval '100 days', 3, 'UTC') returning id into s_a;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, public_identifier, owner_email, connected_at, timezone)
    values (ws, 'LINKEDIN', 'Bob Sender', 'ok', acct_b, 'pid-b-' || ws, 'bob-' || left(ws::text, 8), 'bob25@test.local', now() - interval '10 days', 'UTC') returning id into s_b;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, connected_at, timezone)
    values (ws, 'INSTAGRAM', 'Cara Sender', 'ok', 's25c-' || ws, 'pid-c-' || ws, now() - interval '10 days', 'UTC') returning id into s_c;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'l25-1-' || left(ws::text, 8), 'Lead One') returning id into l1;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'l25-2-' || left(ws::text, 8), 'Lead Two') returning id into l2;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'l25-3-' || left(ws::text, 8), 'Lead Three') returning id into l3;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by) values (ws, 'Seq 25 both', 'active', array[s_a, s_b], u_owner) returning id into q1;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by) values (ws, 'Seq 25 alice only', 'active', array[s_a], u_owner) returning id into q2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, q1, 1, l1, s_a, 'active') returning id into e1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, q2, 1, l2, s_a, 'waiting_delay') returning id into e2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, q1, 1, l3, s_b, 'active') returning id into e3;
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload)
    values (ws, e1, s_a, l1, 'n1', 'message', now() + interval '1 hour', 'smoke25-' || gen_random_uuid(), '{"text":"hello one"}');
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload)
    values (ws, e2, s_a, l2, 'n1', 'invite', now() - interval '1 day', 'smoke25-' || gen_random_uuid(), '{"note":"old one"}') returning id into act_old;
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, status, reserved_at)
    values (ws, e1, s_a, l1, 'n2', 'profile_view', now(), 'smoke25-' || gen_random_uuid(), 'reserved', now());
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, status, payload, response, executed_at)
    values (ws, e3, s_b, l3, 'n1', 'message', now() - interval '2 days', 'smoke25-' || gen_random_uuid(), 'sent', '{"text":"secret text"}', '{"id":"m1"}', now() - interval '2 days');
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at, unipile_chat_id) values (l1, s_a, now() - interval '3 days', 'uc-a');
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at, unipile_chat_id, invitation_id) values (l3, s_b, now() - interval '2 days', 'uc-b', 'inv-b');
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_a, l1, 'c25-a-' || ws, 'LINKEDIN', 'Lead One') returning id into chat_a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_b, l3, 'c25-b-' || ws, 'LINKEDIN', 'Lead Three') returning id into chat_b;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, chat_a, 'out', 'hi from alice', now() - interval '3 days');
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, chat_b, 'out', 'hi from bob', now() - interval '2 days');
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, attachments) values (ws, chat_b, 'in', 'file for you', now() - interval '1 day',
    jsonb_build_array(jsonb_build_object('id', ws::text || '/files/x.pdf', 'name', 'x.pdf', 'storage', true), jsonb_build_object('id', 'upstream-1', 'name', 'y.pdf')));
  insert into outreach_auto_enroll_rules(workspace_id, sequence_id, name, filter, daily_cap) values (ws, q2, 'alice rule', '{"source":"csv"}', 5) returning id into rid;
  insert into outreach_import_jobs(workspace_id, sender_id, kind, status) values (ws, s_a, 'csv', 'running') returning id into job;
  insert into outreach_ai_reply_runs(workspace_id, chat_id, sender_id, lead_id, inbound_message_ids, debounce_until, debounce_hard_until, status)
    values (ws, chat_a, s_a, l1, array[gen_random_uuid()], now(), now(), 'scheduled') returning id into run_a;
  insert into outreach_sender_secrets(sender_id, li_at_enc) values (s_a, 'enc'), (s_b, 'enc');
  insert into outreach_sender_tokens(sender_id, token_hash) values (s_a, 'h-a'), (s_b, 'h-b');
  select count(*) into n_actions_b from outreach_actions where sender_id = s_b;

  -- ============================================================ 1. schema
  if exists (select 1 from pg_indexes where indexname = 'outreach_senders_one_live_identity') then log := log || E'\nok   1a one-live-identity index exists'; else fails := fails + 1; log := log || E'\nFAIL 1a index missing'; end if;
  begin
    insert into outreach_senders(workspace_id, provider, display_name, status, provider_user_id) values (ws, 'LINKEDIN', 'Alice again', 'connecting', 'pid-a-' || ws);
    fails := fails + 1; log := log || E'\nFAIL 1b a second live row for the same profile was accepted';
  exception when unique_violation then log := log || E'\nok   1b a second live row for the same profile is refused (D11)';
  end;
  begin
    delete from outreach_senders where id = s_a;
    fails := fails + 1; log := log || E'\nFAIL 1c a sender with history was deleted';
  exception when others then
    if sqlerrm like 'E_SENDER_DELETE_BLOCKED%' then log := log || E'\nok   1c deleting a sender with history fails (D3)'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || sqlerrm; end if;
  end;
  insert into outreach_senders(workspace_id, provider, display_name, status) values (ws, 'LINKEDIN', 'Placeholder', 'connecting') returning id into s_ph;
  begin
    delete from outreach_senders where id = s_ph;
    log := log || E'\nok   1d a placeholder that never connected can still be deleted';
  exception when others then fails := fails + 1; log := log || E'\nFAIL 1d ' || sqlerrm;
  end;
  if (select outreach__occupies(s) from outreach_senders s where s.id = s_a) then log := log || E'\nok   1e a connected sender occupies an account'; else fails := fails + 1; log := log || E'\nFAIL 1e'; end if;

  -- ============================================================ 2. preview
  j := outreach_sender_lifecycle_preview(s_a, 'disable');
  if (j->>'queued_actions')::int = 2 and (j->>'in_flight_actions')::int = 1 and (j->>'live_enrollments')::int = 2 and (j->>'sequences_left_without_sender')::int = 1
     and (j->>'rules_to_pause')::int = 1 and (j->>'imports_to_pause')::int = 1 and (j->>'ai_runs_scheduled')::int = 1 and jsonb_array_length(j->'sequences') = 2
    then log := log || E'\nok   2a preview counts match the fixtures'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || j::text; end if;
  if (j->'sender'->>'unipile_linked')::boolean and (j->>'slot_freed')::boolean = false then log := log || E'\nok   2b disable keeps the slot'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || j::text; end if;
  if (outreach_sender_lifecycle_preview(s_a, 'remove')->>'slot_freed')::boolean then log := log || E'\nok   2c remove frees the slot'; else fails := fails + 1; log := log || E'\nFAIL 2c'; end if;

  -- ============================================================ 3. pause / resume
  j := outreach_sender_pause(s_a, now() + interval '2 hours');
  select status::text, pause_resume_at into t, ts from outreach_senders where id = s_a;
  if t = 'paused' and ts > now() then log := log || E'\nok   3a pause sets status + auto-resume time'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || t; end if;
  if (select status::text from outreach_ai_reply_runs where id = run_a) = 'draft_ready' then log := log || E'\nok   3b a scheduled AI reply drops back to a draft'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  if (select count(*) from outreach_enrollments where sender_id = s_a and status in ('active','waiting_delay')) = 2 then log := log || E'\nok   3c leads stay in their sequences'; else fails := fails + 1; log := log || E'\nFAIL 3c'; end if;
  if (select count(*) from outreach_actions where sender_id = s_a and status = 'queued') = 3 and (select count(*) from outreach_actions where sender_id = s_a and status = 'reserved') = 0
    then log := log || E'\nok   3d the reserved action went back to queued, nothing cancelled'; else fails := fails + 1; log := log || E'\nFAIL 3d'; end if;
  j := outreach_sender_resume(s_a);
  select status::text, pause_resume_at into t, ts from outreach_senders where id = s_a;
  if t = 'ok' and ts is null and (j->>'backlog_spread')::int >= 1 then log := log || E'\nok   3e resume → ok, backlog spread (' || (j->>'backlog_spread') || ')'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || t || ' ' || j::text; end if;
  if (select scheduled_for from outreach_actions where id = act_old) >= now() then log := log || E'\nok   3f the overdue action was moved forward'; else fails := fails + 1; log := log || E'\nFAIL 3f'; end if;
  perform outreach_pause_sender(s_a, true);
  if (select status::text from outreach_senders where id = s_a) = 'paused' then log := log || E'\nok   3g legacy pause_sender still works'; else fails := fails + 1; log := log || E'\nFAIL 3g'; end if;
  update outreach_senders set status_reason = 'over_plan_limit' where id = s_a;
  begin
    perform outreach_sender_resume(s_a);
    fails := fails + 1; log := log || E'\nFAIL 3h a billing pause was lifted by hand';
  exception when others then
    if sqlerrm like 'E_ACCOUNT_LIMIT%' then log := log || E'\nok   3h a plan pause cannot be lifted by hand'; else fails := fails + 1; log := log || E'\nFAIL 3h ' || sqlerrm; end if;
  end;
  update outreach_senders set status_reason = 'user_paused' where id = s_a;
  perform outreach_pause_sender(s_a, false);
  update outreach_actions set status = 'reserved', reserved_at = now() where sender_id = s_a and action_type = 'profile_view';

  -- ============================================================ 4. disable
  j := outreach_sender_disable(s_a, 'smoke');
  select status::text, auto_remove_at, unipile_account_id into t, ts, tok from outreach_senders where id = s_a;
  if t = 'disabled' and ts between now() + interval '29 days' and now() + interval '31 days' and tok = acct_a then log := log || E'\nok   4a disabled, auto-remove in 30 days, connector link kept'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || t || ' ' || coalesce(ts::text, 'null'); end if;
  if (select count(*) from outreach_enrollments where id in (e1, e2) and status = 'exited_sender_disabled') = 2 and (select status::text from outreach_enrollments where id = e3) = 'active'
    then log := log || E'\nok   4b its leads exited, the other sender''s lead did not'; else fails := fails + 1; log := log || E'\nFAIL 4b'; end if;
  if (select count(*) from outreach_actions where sender_id = s_a and status in ('queued','reserved')) = 0 and (select count(*) from outreach_actions where sender_id = s_a and status = 'cancelled') = 3
    then log := log || E'\nok   4c queued + reserved actions cancelled (enrolment exit + sender_disabled)'; else fails := fails + 1; log := log || E'\nFAIL 4c'; end if;
  if (select not active and paused_reason = 'sender_disabled' from outreach_auto_enroll_rules where id = rid) then log := log || E'\nok   4d the rule on the sequence left without a sender is paused'; else fails := fails + 1; log := log || E'\nFAIL 4d'; end if;
  if (select status::text = 'paused' and paused_reason = 'sender_disabled' from outreach_import_jobs where id = job) then log := log || E'\nok   4e the running import is paused'; else fails := fails + 1; log := log || E'\nFAIL 4e'; end if;
  if jsonb_array_length(j->'exited') = 2 and (select sum(jsonb_array_length(x->'lead_ids')) from jsonb_array_elements(j->'exited') x) = 2 and (j->'counts'->>'live_enrollments')::int = 2
    then log := log || E'\nok   4f the result lists who left which sequence (re-enrol option)'; else fails := fails + 1; log := log || E'\nFAIL 4f ' || j::text; end if;
  if (select outreach__occupies(s) from outreach_senders s where s.id = s_a) then log := log || E'\nok   4g a disabled sender still occupies its account (D7)'; else fails := fails + 1; log := log || E'\nFAIL 4g'; end if;
  j := outreach_why_not_sending(null, s_a, null);
  if exists (select 1 from jsonb_array_elements(j->'causes') c where c->>'code' = 'E_SENDER_DISABLED') then log := log || E'\nok   4h why_not_sending says E_SENDER_DISABLED'; else fails := fails + 1; log := log || E'\nFAIL 4h ' || j::text; end if;
  j := outreach_why_not_sending(q2, null, null);
  if exists (select 1 from jsonb_array_elements(j->'causes') c where c->>'code' = 'E_POOL_NO_ACTIVE_SENDER') then log := log || E'\nok   4i the sequence left with no active sender says so'; else fails := fails + 1; log := log || E'\nFAIL 4i ' || j::text; end if;
  if exists (select 1 from outreach_sender_events where sender_id = s_a and kind = 'lifecycle' and data->>'action' = 'disable') then log := log || E'\nok   4j lifecycle event written'; else fails := fails + 1; log := log || E'\nFAIL 4j'; end if;

  -- ============================================================ 5. enable
  j := outreach_sender_enable(s_a);
  select status::text, auto_remove_at into t, ts from outreach_senders where id = s_a;
  if t = 'ok' and ts is null and j->>'state' = 'ok' then log := log || E'\nok   5a enable → ok, auto-remove cleared'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || t; end if;
  if (select status::text from outreach_enrollments where id = e1) = 'exited_sender_disabled' then log := log || E'\nok   5b exited leads do not come back by themselves'; else fails := fails + 1; log := log || E'\nFAIL 5b'; end if;
  if (select not active from outreach_auto_enroll_rules where id = rid) then log := log || E'\nok   5c the paused rule stays paused'; else fails := fails + 1; log := log || E'\nFAIL 5c'; end if;

  -- ============================================================ 6. remove (two steps)
  j := outreach_sender_remove_begin(s_a, 'app', 'smoke remove');
  select status::text, removal_requested_at into t, ts from outreach_senders where id = s_a;
  if j->>'state' = 'pending' and j->>'account_id' = acct_a and t = 'disabled' and ts is not null then log := log || E'\nok   6a remove_begin disables and asks for the connector delete'; else fails := fails + 1; log := log || E'\nFAIL 6a ' || j::text || ' ' || t; end if;
  if exists (select 1 from outreach_account_deletions where account_id = acct_a and sender_id = s_a and done_at is null) then log := log || E'\nok   6b the connector delete is queued'; else fails := fails + 1; log := log || E'\nFAIL 6b'; end if;
  if (select status::text from outreach_senders where id = s_a) <> 'removed' then log := log || E'\nok   6c not "removed" while the connector still has the account'; else fails := fails + 1; log := log || E'\nFAIL 6c'; end if;
  j := outreach_account_deletion_result(acct_a, false, 'boom');
  if (j->>'done')::boolean = false and (select status::text from outreach_senders where id = s_a) = 'disabled' then log := log || E'\nok   6d a failed delete keeps it disabled (retry later)'; else fails := fails + 1; log := log || E'\nFAIL 6d ' || j::text; end if;
  j := outreach_account_deletion_result(acct_a, true);
  select status::text, unipile_account_id, removed_at into t, tok, ts from outreach_senders where id = s_a;
  if t = 'removed' and tok is null and ts is not null and (select acct_a = any(unipile_account_id_history) from outreach_senders where id = s_a) and (j->'finished'->>'ok')::boolean
    then log := log || E'\nok   6e the confirmed delete finishes the removal'; else fails := fails + 1; log := log || E'\nFAIL 6e ' || t || ' ' || j::text; end if;
  if not exists (select 1 from outreach_sender_secrets where sender_id = s_a) and not exists (select 1 from outreach_sender_tokens where sender_id = s_a)
     and exists (select 1 from outreach_secret_access_log where sender_id = s_a and fn = 'sender_remove')
    then log := log || E'\nok   6f cookies and the extension token are wiped, and logged'; else fails := fails + 1; log := log || E'\nFAIL 6f'; end if;
  select sender_pool into p from outreach_sequences where id = q1;
  if p = array[s_b] and (select coalesce(array_length(sender_pool, 1), 0) from outreach_sequences where id = q2) = 0 then log := log || E'\nok   6g out of every pool'; else fails := fails + 1; log := log || E'\nFAIL 6g ' || p::text; end if;
  if (select status::text from outreach_import_jobs where id = job) = 'cancelled' then log := log || E'\nok   6h the import job is cancelled'; else fails := fails + 1; log := log || E'\nFAIL 6h'; end if;
  if exists (select 1 from outreach_chats where id = chat_a) and exists (select 1 from outreach_lead_sender_state where lead_id = l1 and sender_id = s_a) and (select count(*) from outreach_actions where sender_id = s_a) = 3
    then log := log || E'\nok   6i conversations, contacted record and report rows stay (D2)'; else fails := fails + 1; log := log || E'\nFAIL 6i'; end if;
  if (select deleted_at is null from outreach_senders where id = s_a) then log := log || E'\nok   6j a removed sender stays visible (deleted_at null)'; else fails := fails + 1; log := log || E'\nFAIL 6j'; end if;
  if not (select outreach__occupies(s) from outreach_senders s where s.id = s_a) then log := log || E'\nok   6k the account slot is free'; else fails := fails + 1; log := log || E'\nFAIL 6k'; end if;
  j := outreach_why_not_sending(null, s_a, null);
  if exists (select 1 from jsonb_array_elements(j->'causes') c where c->>'code' = 'E_SENDER_REMOVED') then log := log || E'\nok   6l why_not_sending says E_SENDER_REMOVED'; else fails := fails + 1; log := log || E'\nFAIL 6l ' || j::text; end if;
  j := outreach_sender_remove_begin(s_a, 'app');
  if (j->>'already')::boolean then log := log || E'\nok   6m remove is idempotent'; else fails := fails + 1; log := log || E'\nFAIL 6m ' || j::text; end if;
  if outreach__live_pool(ws, array[s_a, s_b]) = array[s_b] then log := log || E'\nok   6n live_pool drops a removed sender'; else fails := fails + 1; log := log || E'\nFAIL 6n'; end if;

  -- billing's disconnect is the same flow
  j := outreach_disconnect_sender(s_c, 'trial_expired');
  if j->>'state' = 'pending' and (select removed_via from outreach_senders where id = s_c) = 'trial_ended' and exists (select 1 from outreach_account_deletions where account_id = 's25c-' || ws)
    then log := log || E'\nok   6o outreach_disconnect_sender runs the remove flow (trial_ended)'; else fails := fails + 1; log := log || E'\nFAIL 6o ' || j::text; end if;

  -- ============================================================ 7. restore
  u := outreach_sender_restore_match(ws, 'LINKEDIN', 'pid-a-' || ws);
  if u = s_a then log := log || E'\nok   7a the removed sender is found by its profile id'; else fails := fails + 1; log := log || E'\nFAIL 7a ' || coalesce(u::text, 'null'); end if;
  update outreach_senders set removed_at = now() - interval '65 days' where id = s_a;
  j := outreach_sender_restore_apply(s_a, 'new-' || acct_a);
  select status::text, unipile_account_id, warmup_level into t, tok, n from outreach_senders where id = s_a;
  if t = 'connecting' and tok = 'new-' || acct_a and n = 1 and (select removed_at is null and restored_at is not null from outreach_senders where id = s_a)
    then log := log || E'\nok   7b restore: connecting on the new account, warmup 3 → 1 after 65 days away'; else fails := fails + 1; log := log || E'\nFAIL 7b ' || t || ' level ' || n; end if;

  -- ============================================================ 8. erase (on Bob)
  j := outreach_sender_remove_begin(s_b, 'app', 'erase prep');
  perform outreach_account_deletion_result(acct_b, true);
  j := outreach_sender_erase_schedule(s_b);
  select erase_scheduled_at into ts from outreach_senders where id = s_b;
  if ts between now() + interval '23 hours' and now() + interval '25 hours' and exists (select 1 from outreach_sender_erase_jobs where sender_id = s_b) then log := log || E'\nok   8a erase scheduled 24 h ahead'; else fails := fails + 1; log := log || E'\nFAIL 8a ' || coalesce(ts::text, 'null'); end if;
  j := outreach_sender_erase_cancel(s_b);
  if (select erase_scheduled_at is null from outreach_senders where id = s_b) and not exists (select 1 from outreach_sender_erase_jobs where sender_id = s_b) then log := log || E'\nok   8b erase cancelled'; else fails := fails + 1; log := log || E'\nFAIL 8b'; end if;
  j := outreach_sender_erase_schedule(s_b);
  if (select count(*) from outreach_sender_erase_due(10) d where d.sender_id = s_b) = 0 then log := log || E'\nok   8c not due before its time'; else fails := fails + 1; log := log || E'\nFAIL 8c'; end if;
  update outreach_senders set erase_scheduled_at = now() - interval '1 minute' where id = s_b;
  if (select count(*) from outreach_sender_erase_due(10) d where d.sender_id = s_b) = 1 then log := log || E'\nok   8d due once the time has passed'; else fails := fails + 1; log := log || E'\nFAIL 8d'; end if;
  paths := outreach_sender_erase_storage_paths(s_b);
  if exists (select 1 from jsonb_array_elements(paths) x where x->>'path' = ws::text || '/files/x.pdf') and exists (select 1 from jsonb_array_elements(paths) x where x->>'prefix' = ws::text || '/avatars/' || chat_b::text)
     and not exists (select 1 from jsonb_array_elements(paths) x where x->>'path' = 'upstream-1')
    then log := log || E'\nok   8e Storage paths: stored attachment + avatar prefix, not the connector-hosted file'; else fails := fails + 1; log := log || E'\nFAIL 8e ' || paths::text; end if;
  perform outreach_sender_erase_progress(s_b, paths, 0);
  begin
    perform outreach_sender_erase_execute(s_b);
    fails := fails + 1; log := log || E'\nFAIL 8f rows were deleted before Storage was done';
  exception when others then
    if sqlerrm like 'E_CONFLICT: Storage deletes%' then log := log || E'\nok   8f row deletes wait for Storage'; else fails := fails + 1; log := log || E'\nFAIL 8f ' || sqlerrm; end if;
  end;
  perform outreach_sender_erase_progress(s_b, '[]'::jsonb, 2);
  j := outreach_sender_erase_execute(s_b);
  if (j->>'chats')::int = 1 and (j->>'messages')::int = 2 and not exists (select 1 from outreach_chats where sender_id = s_b) then log := log || E'\nok   8g conversations deleted'; else fails := fails + 1; log := log || E'\nFAIL 8g ' || j::text; end if;
  if (select count(*) from outreach_actions where sender_id = s_b) = n_actions_b and not exists (select 1 from outreach_actions where sender_id = s_b and (payload <> '{}'::jsonb or response is not null))
    then log := log || E'\nok   8h actions kept for the counts, without any text'; else fails := fails + 1; log := log || E'\nFAIL 8h'; end if;
  if (select unipile_chat_id is null and invitation_id is null and last_outbound_at is not null from outreach_lead_sender_state where lead_id = l3 and sender_id = s_b) then log := log || E'\nok   8i the lead still counts as contacted, ids cleared'; else fails := fails + 1; log := log || E'\nFAIL 8i'; end if;
  select status::text, display_name into t, tok from outreach_senders where id = s_b;
  if t = 'erased' and tok = 'Erased sender' and (select provider_user_id is null and owner_email is null and deleted_at is not null and erased_at is not null from outreach_senders where id = s_b)
    then log := log || E'\nok   8j tombstone: Erased sender, no identifiers, hidden from the app'; else fails := fails + 1; log := log || E'\nFAIL 8j ' || t || ' ' || coalesce(tok, 'null'); end if;
  if not exists (select 1 from outreach_audit_log where entity = 'sender' and entity_id = s_b::text and diff is not null and action <> 'sender.erased') then log := log || E'\nok   8k audit rows about the sender carry no diff'; else fails := fails + 1; log := log || E'\nFAIL 8k'; end if;
  if (select finished_at is not null from outreach_sender_erase_jobs where sender_id = s_b) then log := log || E'\nok   8l erase job finished'; else fails := fails + 1; log := log || E'\nFAIL 8l'; end if;
  j := outreach_sender_erase_execute(s_b);
  if (j->>'already')::boolean then log := log || E'\nok   8m erase is idempotent'; else fails := fails + 1; log := log || E'\nFAIL 8m'; end if;
  begin
    delete from outreach_senders where id = s_b;
    log := log || E'\nok   8n only an erased tombstone may be deleted';
  exception when others then fails := fails + 1; log := log || E'\nFAIL 8n ' || sqlerrm;
  end;

  -- ============================================================ 9. owner links
  tok := outreach_sender_owner_link_create(s_a, 'disconnect', 30);
  j := outreach_sender_owner_link_peek(tok);
  if (j->>'valid')::boolean and j->'sender'->>'id' = s_a::text and j->>'purpose' = 'disconnect' and j->'workspace'->>'name' = 'smoke25' then log := log || E'\nok   9a a fresh link is valid and names sender + workspace'; else fails := fails + 1; log := log || E'\nFAIL 9a ' || j::text; end if;
  j := outreach_sender_owner_link_use(tok, '10.0.0.1'::inet);
  if (j->>'ok')::boolean and j->>'sender_id' = s_a::text then log := log || E'\nok   9b the link can be used once'; else fails := fails + 1; log := log || E'\nFAIL 9b ' || j::text; end if;
  j := outreach_sender_owner_link_use(tok, '10.0.0.1'::inet);
  if (j->>'ok')::boolean = false and (outreach_sender_owner_link_peek(tok)->>'used')::boolean then log := log || E'\nok   9c a used link is refused'; else fails := fails + 1; log := log || E'\nFAIL 9c ' || j::text; end if;
  if (outreach_sender_owner_link_peek('nope')->>'valid')::boolean = false then log := log || E'\nok   9d an unknown token is invalid'; else fails := fails + 1; log := log || E'\nFAIL 9d'; end if;
  u := outreach_sender_erase_request_task(s_a, 'owner_link');
  if exists (select 1 from outreach_tasks where id = u and kind = 'follow_up' and sender_id = s_a and assigned_to = u_owner) then log := log || E'\nok   9e a deletion request becomes a task for the owner'; else fails := fails + 1; log := log || E'\nFAIL 9e'; end if;

  -- ============================================================ 10. re-enrol override
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by) values (ws, 'Seq 25 fresh', 'active', array[s_a], u_owner) returning id into q3;
  j := outreach_enroll_preview(q3, array[l1], null, false, 'fresh_sender');
  if j->>'assignment_rule' = 'fresh_sender' then log := log || E'\nok   10a enroll_preview accepts an assignment override'; else fails := fails + 1; log := log || E'\nFAIL 10a ' || j::text; end if;
  if to_regprocedure('public.outreach_enroll_leads(uuid,uuid[],uuid,int,boolean,uuid,boolean,text)') is not null and to_regprocedure('public.outreach_enroll_leads(uuid,uuid[],uuid,int,boolean,uuid,boolean)') is null
    then log := log || E'\nok   10b enroll_leads has the override and the old signature is gone'; else fails := fails + 1; log := log || E'\nFAIL 10b'; end if;

  -- ============================================================ 11. grants
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_sender_lifecycle_preview','outreach_sender_pause','outreach_sender_resume','outreach_sender_disable','outreach_sender_enable','outreach_sender_erase_schedule','outreach_sender_erase_cancel');
  if n = 7 then log := log || E'\nok   11a the seven user RPCs are granted to authenticated'; else fails := fails + 1; log := log || E'\nFAIL 11a granted: ' || n; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_sender_remove_begin','outreach_sender_remove_finish','outreach_sender_erase_execute','outreach_sender_owner_link_create','outreach_sender_owner_link_use','outreach_sender_restore_apply','outreach_sender_transition');
  if n = 0 then log := log || E'\nok   11b the service RPCs are not callable by signed-in users'; else fails := fails + 1; log := log || E'\nFAIL 11b leaked: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
