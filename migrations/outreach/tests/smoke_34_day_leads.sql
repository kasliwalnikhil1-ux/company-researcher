-- Smoke test — 106 "Activity by day" opens its leads: outreach_failed_leads with p_from / p_to and the interested /
-- meetings kinds. Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_34_day_leads.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int; r record; c uuid; m uuid; a uuid; seq int := 0;
  ws uuid; u_owner uuid; s1 uuid; q uuid; z text; d1 date; d2 date;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; e1 uuid; e2 uuid; e3 uuid; e4 uuid;
  t0 timestamptz := date_trunc('day', now()) - interval '3 days' + interval '12 hours';
  g jsonb := '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect","next":"n2"},"n2":{"id":"n2","type":"wait_connection","next":"n3"},"n3":{"id":"n3","type":"send_message","label":"Follow-up"}}}'::jsonb;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by) values ('smoke34', 'smoke34-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner34@test.local', 'Naman');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at) values (ws, 'LINKEDIN', 'Naman LI', 'ok', 's34a-' || ws, 'owner34@test.local', t0 - interval '10 days') returning id into s1;
  z := outreach_ws_tz(ws);
  d1 := (t0 at time zone z)::date; d2 := ((t0 + interval '1 day') at time zone z)::date;
  l1 := gen_random_uuid(); l2 := gen_random_uuid(); l3 := gen_random_uuid(); l4 := gen_random_uuid();
  insert into outreach_leads(id, workspace_id, public_identifier, full_name, company) select x.id, ws, 'l34-' || x.i || '-' || left(ws::text, 8), 'Lead ' || x.i, 'Acme ' || x.i
    from (values (l1,1),(l2,2),(l3,3),(l4,4)) x(id, i);
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'Smoke 34', 'active', array[s1], u_owner, t0 - interval '5 days', g) returning id into q;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, created_at) values (ws, q, 1, l1, s1, 'active', 'n3', t0) returning id into e1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, wait_until, created_at) values (ws, q, 1, l2, s1, 'waiting_connection', 'n2', now() + interval '10 days', t0) returning id into e2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, created_at) values (ws, q, 1, l3, s1, 'active', 'n3', t0) returning id into e3;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, exit_reason, completed_at, created_at) values (ws, q, 1, l4, s1, 'failed', 'n3', 'E_RELATION_INVALID', t0 + interval '1 day', t0) returning id into e4;

  -- day 1: e1 and e2 invited, e3 messaged. day 2: e1 accepted + replied (interested) + meeting, e3 skipped a step, e4 failed.
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l1, e1, 'n1', 'invite', t0, 'sent', t0, 'smoke34-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l2, e2, 'n1', 'invite', t0, 'sent', t0 + interval '1 hour', 'smoke34-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s1, l3, e3, 'n3', 'message', t0, 'sent', t0 + interval '2 hours', 'smoke34-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, error_code, idempotency_key) values (ws, s1, l3, e3, 'n3', 'message', t0 + interval '1 day', 'skipped', t0 + interval '1 day', 'E_ALREADY_REPLIED', 'smoke34-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key) values (ws, s1, l1, e1, 'n3', 'message', t0 + interval '1 day 3 hours', 'queued', 'smoke34-' || seq || '-' || ws);
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s1, l1, 'c34-l1-' || ws, 'LINKEDIN', 'Lead 1') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm34-l1-in-' || ws, 'in', 'Yes,   let us talk next week', t0 + interval '1 day 1 hour') returning id into m;
  -- the 089 facts carry the chart's timestamps; set them outright so the test does not depend on the enrichment path
  update outreach_sequence_lead_facts set accepted_at = t0 + interval '1 day', replied_at = t0 + interval '1 day 1 hour', reply_message_id = m,
         positive_at = t0 + interval '1 day 1 hour', meeting_at = t0 + interval '1 day 2 hours' where enrollment_id = e1;
  get diagnostics n = row_count;
  if n = 1 then log := log || E'\nok   0a the facts row of e1 exists (the sent invite created it)'; else fails := fails + 1; log := log || E'\nFAIL 0a facts rows updated: ' || n; end if;

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);

  -- ============================================================ 1. the old shapes still work
  select count(*) into n from outreach_failed_leads(q, null, 'failed', 200, 0);
  if n = 1 then log := log || E'\nok   1a the five-argument call (public API shape) still lists the failed lead'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'sent');
  if n = 3 then log := log || E'\nok   1b sent without a window: all three sends'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, 'n1', 'sent');
  if n = 2 then log := log || E'\nok   1c sent per step is unchanged'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || n; end if;
  select count(*) into n from pg_proc where proname = 'outreach_failed_leads' and pronamespace = 'public'::regnamespace;
  if n = 1 then log := log || E'\nok   1d one signature only (no ambiguous overload)'; else fails := fails + 1; log := log || E'\nFAIL 1d signatures: ' || n; end if;

  -- ============================================================ 2. the day window
  -- the invites both went out on day 1 together with e3's message: three sends on day 1, none on day 2
  select count(*) into n from outreach_failed_leads(q, null, 'sent', 200, 0, d1, d1);
  if n = 3 then log := log || E'\nok   2a sent on day 1: two invites and one message'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'sent', 200, 0, d2, d2);
  if n = 0 then log := log || E'\nok   2b nothing was sent on day 2'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'sent', 200, 0, d1, null);
  if n = 3 then log := log || E'\nok   2c one date alone means that single day'; else fails := fails + 1; log := log || E'\nFAIL 2c ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, 'n1', 'sent', 200, 0, d1, d2);
  if n = 2 then log := log || E'\nok   2d a step and a window combine'; else fails := fails + 1; log := log || E'\nFAIL 2d ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'queued', 200, 0, d2, d2);
  if n = 1 then log := log || E'\nok   2e queued filters on the due day'; else fails := fails + 1; log := log || E'\nFAIL 2e ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'skipped', 200, 0, d2, d2);
  if n = 1 then log := log || E'\nok   2f skipped on day 2'; else fails := fails + 1; log := log || E'\nFAIL 2f ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'failed', 200, 0, d1, d1);
  if n = 0 then log := log || E'\nok   2g failed on day 1: none (it failed on day 2)'; else fails := fails + 1; log := log || E'\nFAIL 2g ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'failed', 200, 0, d2, d2);
  if n = 1 then log := log || E'\nok   2h failed on day 2'; else fails := fails + 1; log := log || E'\nFAIL 2h ' || n; end if;
  begin
    perform outreach_failed_leads(q, null, 'sent', 200, 0, d2, d1);
    fails := fails + 1; log := log || E'\nFAIL 2i from > to was accepted';
  exception when others then log := log || E'\nok   2i from > to is refused'; end;

  -- ============================================================ 3. the outcome kinds (facts timestamps)
  select count(*) into n from outreach_failed_leads(q, null, 'accepted', 200, 0, d1, d1);
  if n = 0 then log := log || E'\nok   3a accepted on day 1: none'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || n; end if;
  select * into r from outreach_failed_leads(q, null, 'accepted', 200, 0, d2, d2);
  if r.enrollment_id = e1 and r.lead_name = 'Lead 1' and r.sender_name = 'Naman LI' and r.at = t0 + interval '1 day' then log := log || E'\nok   3b accepted on day 2: Lead 1, at the acceptance time'; else fails := fails + 1; log := log || E'\nFAIL 3b ' || coalesce(r::text, 'null'); end if;
  select * into r from outreach_failed_leads(q, null, 'replied', 200, 0, d2, d2);
  if r.enrollment_id = e1 and r.reason = 'Yes, let us talk next week' and r.at = t0 + interval '1 day 1 hour' then log := log || E'\nok   3c replied, sequence-wide, carries the reply text'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || coalesce(r::text, 'null'); end if;
  select * into r from outreach_failed_leads(q, null, 'interested', 200, 0, d2, d2);
  if r.enrollment_id = e1 and r.reason = 'Yes, let us talk next week' and r.at = t0 + interval '1 day 1 hour' then log := log || E'\nok   3d interested on day 2'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || coalesce(r::text, 'null'); end if;
  select * into r from outreach_failed_leads(q, null, 'meetings', 200, 0, d2, d2);
  if r.enrollment_id = e1 and r.reason is null and r.at = t0 + interval '1 day 2 hours' then log := log || E'\nok   3e meetings on day 2, no text'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || coalesce(r::text, 'null'); end if;
  select count(*) into n from outreach_failed_leads(q, null, 'meetings', 200, 0, d1, d1);
  if n = 0 then log := log || E'\nok   3f meetings on day 1: none'; else fails := fails + 1; log := log || E'\nFAIL 3f ' || n; end if;
  select count(*) into n from outreach_failed_leads(q, null, 'interested');
  if n = 1 then log := log || E'\nok   3g interested without a window'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || n; end if;

  -- ============================================================ 4. the lists agree with the chart's day
  j := outreach_sequence_analytics(q, d1, d2);
  select x into j from jsonb_array_elements(j#>'{daily,days}') x where (x->>'day')::date = d2;
  if (j->>'accepted')::int = 1 and (j->>'replied')::int = 1 and (j->>'interested')::int = 1 and (j->>'meetings')::int = 1 and (j->>'sent')::int = 0
  then log := log || E'\nok   4a day 2 of the chart counts what the day lists return'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || coalesce(j::text, 'null'); end if;

  -- ============================================================ 5. grants
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public' and routine_name = 'outreach_failed_leads';
  if n = 1 then log := log || E'\nok   5a authenticated can call it'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || n; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'anon' and specific_schema = 'public' and routine_name = 'outreach_failed_leads';
  if n = 0 then log := log || E'\nok   5b anon cannot'; else fails := fails + 1; log := log || E'\nFAIL 5b ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
