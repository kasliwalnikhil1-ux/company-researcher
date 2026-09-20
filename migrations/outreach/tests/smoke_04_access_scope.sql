-- Smoke test — access scope (018). Every id-taking RPC must refuse (a) a signed-in user outside the workspace and (b) a member or
-- client viewer limited to client A when the row belongs to client B; the owner must be unaffected. Rolls back by raising at the end.
do $$
declare
  log text := ''; fails int := 0; n int; q text; who text; j jsonb;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid; sb uuid; seqb uuid; lb uuid; eb uuid; ab uuid; tb uuid; rb uuid; vb uuid; var uuid;
  reads text[]; writes text[];
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
     "m1":{"id":"m1","type":"send_message","config":{"text":"Hi {{first_name}}","send_always":true},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
begin
  select id into u_owner  from auth.users order by created_at limit 1;
  select id into u_member from auth.users order by created_at limit 1 offset 1;
  select id into u_viewer from auth.users order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke4', 'smoke4-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner@test.local');
  insert into outreach_members(workspace_id, user_id, role, client_ids, email) values (ws, u_member, 'member', array[ca], 'member@test.local');
  insert into outreach_members(workspace_id, user_id, role, client_ids, email) values (ws, u_viewer, 'client_viewer', array[ca], 'viewer@test.local');
  -- everything below belongs to client B
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level) values (ws, cb, 'LINKEDIN', 'B Sender', 'ok', 's4-' || ws, 3) returning id into sb;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name) values (ws, cb, 'smoke4-b', 'Lead B', 'Bee') returning id into lb;
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool) values (ws, cb, 'B seq', 'active', g, array[sb]) returning id into seqb;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, seqb, 1, lb, sb, 'failed') returning id into eb;
  insert into outreach_actions(workspace_id, sender_id, enrollment_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload)
    values (ws, sb, eb, lb, 'm1', 'message', now() + interval '1 day', 'smoke4-' || ws, '{"text":"secret copy"}') returning id into ab;
  insert into outreach_tasks(workspace_id, client_id, enrollment_id, lead_id, kind, title) values (ws, cb, eb, lb, 'follow_up', 'B task') returning id into tb;
  insert into outreach_auto_enroll_rules(workspace_id, sequence_id, name, filter) values (ws, seqb, 'B rule', '{"company":"x"}') returning id into rb;
  insert into outreach_ai_variables(workspace_id, key, name, prompt) values (ws, 'smoke4', 'Smoke 4', 'p') returning id into var;
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, status, text) values (ws, lb, var, 'generated', 'secret line') returning id into vb;

  reads := array[
    format('select count(*) from outreach_lead_timeline(%L)', lb),
    format('select outreach_enrollment_graph(%L)', eb),
    format('select count(*) from outreach_project_sequence(%L, 10)', seqb),
    format('select outreach_sender_today(%L)', sb),
    format('select outreach_effective_cap_checked(%L, ''invite'')', sb),
    format('select count(*) from outreach_version_usage(%L)', seqb),
    format('select count(*) from outreach_failed_leads(%L)', seqb),
    format('select count(*) from outreach_failed_summary(%L)', seqb)];
  writes := array[
    format('select count(*) from outreach_lead_queued_actions(%L)', lb),
    format('select outreach_rule_match_count(%L)', rb),
    format('select outreach_exit_enrollment(%L, ''smoke'')', eb),
    format('select outreach_pause_enrollment(%L)', eb),
    format('select outreach_resume_enrollment(%L)', eb),
    format('select outreach_skip_action(%L)', ab),
    format('select outreach_reschedule_action(%L, now() + interval ''2 days'')', ab),
    format('select outreach_complete_task(%L, ''done'', ''{}''::jsonb)', tb),
    format('select count(*) from outreach_enroll_leads(%L, array[%L]::uuid[])', seqb, lb),
    format('select outreach_enroll_preview(%L, array[%L]::uuid[], null, false)', seqb, lb),
    format('select outreach_ai_review(array[%L]::uuid[], ''approve'', null)', vb)];

  execute 'set local role authenticated';
  -- ------------------------------------------------------------ nobody but the right people
  foreach who in array array['outsider','viewer','member'] loop
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated',
      'sub', case who when 'outsider' then gen_random_uuid() when 'viewer' then u_viewer else u_member end)::text, true);
    foreach q in array reads || writes loop
      begin
        execute q;
        fails := fails + 1; log := log || E'\nFAIL ' || who || ' was answered: ' || q;
      exception when others then
        if sqlerrm ~ 'E_FORBIDDEN|permission denied' then log := log || E'\nok   ' || who || ' refused: ' || substring(q from 'outreach_[a-z_]+');
        else fails := fails + 1; log := log || E'\nFAIL ' || who || ' ' || substring(q from 'outreach_[a-z_]+') || ' → ' || sqlerrm; end if;
      end;
    end loop;
  end loop;

  -- bulk recover answers "not found" for a row the caller may not see, and leaves it alone; the sequence list leaves client B's out
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  j := outreach_enrollment_recover(array[eb], 'exit');
  select count(*) into n from outreach_sequence_summary(ws) where sequence_id = seqb;
  if (j->>'done')::int = 0 and j->'refused'->0->>'reason' = 'not_found' and n = 0 then log := log || E'\nok   member: recover says not_found, sequence summary hides client B';
    else fails := fails + 1; log := log || E'\nFAIL member recover/summary ' || j::text || ' summary=' || n; end if;

  -- ------------------------------------------------------------ the owner keeps everything
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  foreach q in array reads loop
    begin execute q; log := log || E'\nok   owner answered: ' || substring(q from 'outreach_[a-z_]+');
    exception when others then fails := fails + 1; log := log || E'\nFAIL owner ' || substring(q from 'outreach_[a-z_]+') || ' → ' || sqlerrm; end;
  end loop;
  select count(*) into n from outreach_sequence_summary(ws) where sequence_id = seqb;
  if n = 1 then log := log || E'\nok   owner: sequence summary shows client B'; else fails := fails + 1; log := log || E'\nFAIL owner summary=' || n; end if;
  execute 'reset role';
  if (select status from outreach_enrollments where id = eb) = 'failed' and (select completed_at from outreach_tasks where id = tb) is null and (select status from outreach_actions where id = ab) = 'queued'
    then log := log || E'\nok   client B''s enrollment, task and queued action are untouched';
    else fails := fails + 1; log := log || E'\nFAIL a refused call still changed client B''s rows'; end if;

  -- ------------------------------------------------------------ catalog: helpers are closed, and no RPC skips the client check
  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname in ('outreach_effective_cap','outreach_eval_condition','outreach_eval_rule','outreach_in_schedule','outreach_schedule_windows','outreach_sender_local_date',
       'outreach_sender_local_hour','outreach_weekly_invites_used','outreach_ws_tz','outreach_lead_is_suppressed','outreach_lead_suppression_reason','outreach_audit');
  if n = 0 then log := log || E'\nok   internal helpers are not callable by signed-in users'; else fails := fails + 1; log := log || E'\nFAIL ' || n || ' internal helper(s) callable by authenticated — run 018 after 017'; end if;

  -- a SECURITY DEFINER RPC open to viewers/members must scope by client somewhere in its body. The three exceptions hold nothing
  -- client-specific (workspace branding, the caller's own saved date ranges, the team list).
  select count(*), string_agg(p.proname, ', ') into n, q from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.prosecdef and p.proname like 'outreach\_%' and has_function_privilege('authenticated', p.oid, 'execute')
     and p.prosrc ~ 'outreach_require\([^,]+,\s*''(client_viewer|member)''\)'
     and p.prosrc !~ 'outreach_client_visible|outreach_visible_clients|outreach__check_range'
     and p.proname not in ('outreach_branding','outreach_save_range','outreach_workspace_members');
  if n = 0 then log := log || E'\nok   every viewer/member RPC checks the client'; else fails := fails + 1; log := log || E'\nFAIL no client check in: ' || q; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (access scope)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
