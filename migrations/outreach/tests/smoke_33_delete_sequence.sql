-- Smoke test — 104 delete a sequence in any status, confirmed by typing its name.
-- Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Calls run as the owner (request.jwt.claims) so outreach_require sees a real member.
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_33_delete_sequence.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int;
  ws uuid; u_owner uuid; s1 uuid; q_active uuid; q_paused uuid; q_draft uuid; q_archived uuid;
  l1 uuid; l2 uuid; l3 uuid; e1 uuid; e2 uuid; e3 uuid; a1 uuid; t1 uuid; seq int := 0;
  g jsonb := '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect","next":"n2"},"n2":{"id":"n2","type":"wait_connection","next":"n3"},"n3":{"id":"n3","type":"send_message","label":"Follow-up"}}}'::jsonb;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke33', 'smoke33-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner33@test.local');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_user_id) values (ws, 'LINKEDIN', 'Smoke LI', 'ok', 's33-' || ws, u_owner) returning id into s1;
  l1 := gen_random_uuid(); l2 := gen_random_uuid(); l3 := gen_random_uuid();
  insert into outreach_leads(id, workspace_id, public_identifier, full_name) select x.id, ws, 'l33-' || x.i || '-' || left(ws::text, 8), 'Lead ' || x.i
    from (values (l1,1),(l2,2),(l3,3)) x(id, i);
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, graph) values (ws, 'Founders  — Q4', 'active', array[s1], u_owner, g) returning id into q_active;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, graph) values (ws, 'Paused one', 'paused', array[s1], u_owner, g) returning id into q_paused;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, graph) values (ws, 'Draft one', 'draft', array[s1], u_owner, g) returning id into q_draft;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, graph) values (ws, 'Archived one', 'archived', array[s1], u_owner, g) returning id into q_archived;

  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id) values (ws, q_active, 1, l1, s1, 'active', 'n3') returning id into e1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, completed_at) values (ws, q_active, 1, l2, s1, 'completed', 'n3', now()) returning id into e2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, paused_from) values (ws, q_paused, 1, l3, s1, 'paused', 'n3', 'active') returning id into e3;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key) values (ws, s1, l1, e1, 'n3', 'message', now() + interval '1 day', 'queued', 'smoke33-' || seq || '-' || ws) returning id into a1;
  insert into outreach_tasks(workspace_id, kind, lead_id, sender_id, enrollment_id, node_id, title) values (ws, 'manual_node', l3, s1, e3, 'n3', 'Call Lead 3') returning id into t1;

  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);

  -- 1. the name has to match
  begin
    perform outreach_delete_sequence(q_active, 'Founders');
    fails := fails + 1; log := log || E'\nFAIL 1a a wrong name deleted the sequence';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' and exists (select 1 from outreach_sequences where id = q_active) then log := log || E'\nok   1a a wrong name is refused and nothing changes'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || sqlerrm; end if;
  end;
  begin
    perform outreach_delete_sequence(q_active, null);
    fails := fails + 1; log := log || E'\nFAIL 1b no name deleted the sequence';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'\nok   1b no name is refused'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || sqlerrm; end if;
  end;
  if (select status::text from outreach_enrollments where id = e1) = 'active' and (select status::text from outreach_actions where id = a1) = 'queued'
    then log := log || E'\nok   1c a refused delete leaves the live lead and its queued step alone'; else fails := fails + 1; log := log || E'\nFAIL 1c'; end if;

  -- 2. an active sequence with a live lead: deleted, case and outer spaces ignored
  delete from outreach_lead_summary_queue where lead_id in (l1, l2);   -- the enrolment inserts queued them already
  j := outreach_delete_sequence(q_active, '  founders  — q4 ');
  if (j->>'deleted')::boolean and j->>'status' = 'active' and (j->>'leads')::int = 2 and (j->>'exited')::int = 1
     and not exists (select 1 from outreach_sequences where id = q_active)
     and not exists (select 1 from outreach_enrollments where sequence_id = q_active)
     and not exists (select 1 from outreach_actions where id = a1)
    then log := log || E'\nok   2a an active sequence is deleted; its enrolments and queued steps go with it'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || coalesce(j::text, 'null'); end if;
  select count(*) into n from outreach_lead_summary_queue where lead_id in (l1, l2);
  if n = 2 then log := log || E'\nok   2b both leads it touched are queued for a summary rebuild'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || n; end if;
  if exists (select 1 from outreach_audit_log where workspace_id = ws and action = 'sequence.deleted' and entity_id = q_active::text and diff->>'name' = 'Founders  — Q4')
    then log := log || E'\nok   2c the delete is in the audit log with the name'; else fails := fails + 1; log := log || E'\nFAIL 2c'; end if;

  -- 3. paused (with an open task), draft and archived all delete
  j := outreach_delete_sequence(q_paused, 'Paused one');
  if (j->>'exited')::int = 1 and not exists (select 1 from outreach_sequences where id = q_paused) and not exists (select 1 from outreach_tasks where id = t1)
    then log := log || E'\nok   3a a paused sequence is deleted; the paused lead exits and its open task goes'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || coalesce(j::text, 'null'); end if;
  j := outreach_delete_sequence(q_draft, 'Draft one');
  if (j->>'exited')::int = 0 and not exists (select 1 from outreach_sequences where id = q_draft) then log := log || E'\nok   3b a draft is deleted'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  j := outreach_delete_sequence(q_archived, 'Archived one');
  if not exists (select 1 from outreach_sequences where id = q_archived) then log := log || E'\nok   3c an archived sequence is deleted'; else fails := fails + 1; log := log || E'\nFAIL 3c'; end if;

  -- 4. deleting again: not found
  begin
    perform outreach_delete_sequence(q_draft, 'Draft one');
    fails := fails + 1; log := log || E'\nFAIL 4a a second delete succeeded';
  exception when others then
    if sqlerrm like 'E_NOT_FOUND%' then log := log || E'\nok   4a deleting a sequence that is already gone says not found'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || sqlerrm; end if;
  end;

  -- 5. a member (not a manager) can't
  update outreach_members set role = 'member' where workspace_id = ws and user_id = u_owner;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, graph) values (ws, 'Member try', 'draft', array[s1], u_owner, g) returning id into q_draft;
  begin
    perform outreach_delete_sequence(q_draft, 'Member try');
    fails := fails + 1; log := log || E'\nFAIL 5a a member deleted a sequence';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   5a a member is refused'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || sqlerrm; end if;
  end;
  perform set_config('request.jwt.claims', '', true);

  select count(*) into n from information_schema.routine_privileges where grantee = 'anon' and specific_schema = 'public' and routine_name = 'outreach_delete_sequence';
  if n = 0 then log := log || E'\nok   6a anon cannot call it'; else fails := fails + 1; log := log || E'\nFAIL 6a'; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
