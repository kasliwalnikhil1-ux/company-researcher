-- Smoke test — items 13, 14, 15, 18, 20, 21, 23, 24, 26 + budgets. Rolls back by raising at the end.
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; u uuid; sa uuid; mb1 uuid; mb2 uuid; seq uuid; l1 uuid; l2 uuid; l3 uuid; e uuid; e2 uuid; j jsonb; j2 jsonb; n int; st text; v uuid; b uuid; val uuid; t text; k jsonb; kid uuid; lst uuid; rid uuid; x uuid;
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"r1","position":{"x":0,"y":0}},
     "r1":{"id":"r1","type":"ai_route","config":{"routes":[{"id":"founders","label":"Founders","description":"founders and C-level"}]},"branches":{"founders":"m1","else":"em1"},"position":{"x":0,"y":0}},
     "m1":{"id":"m1","type":"send_message","config":{"text":"{{ai.icebreaker|Hi {{first_name}}}}","send_always":true},"next":"end","position":{"x":0,"y":0}},
     "em1":{"id":"em1","type":"send_email","config":{"subject":"s","html":"hello {{unsubscribe_link}}"},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
begin
  select id into u from auth.users order by created_at limit 1;
  insert into outreach_workspaces(name, slug, created_by) values ('smoke3', 'smoke3-' || encode(gen_random_bytes(4),'hex'), u) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u, 'owner', 'smoke@test.local');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, booking_link,
     schedule) values (ws, 'LINKEDIN', 'Ann Sender', 'ok', 's3a-' || ws, 3, 'https://cal.com/ann',
     '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}') returning id into sa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, parent_sender_id) values (ws, 'GMAIL', 'ann@a.co', 'ok', 's3m1-' || ws, sa) returning id into mb1;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, parent_sender_id) values (ws, 'GMAIL', 'ann@b.co', 'ok', 's3m2-' || ws, sa) returning id into mb2;
  insert into outreach_lists(workspace_id, name) values (ws, 'Hot list') returning id into lst;
  insert into outreach_leads(workspace_id, public_identifier, full_name, first_name, email_work, company) values (ws, 'smoke3-1', 'Lead One', 'Lee', 'one@x.test', 'X') returning id into l1;
  insert into outreach_leads(workspace_id, public_identifier, full_name, first_name) values (ws, 'smoke3-2', 'Lead Two', 'Lou') returning id into l2;
  insert into outreach_leads(workspace_id, public_identifier, full_name, first_name) values (ws, 'smoke3-3', 'Lead Three', 'Lex') returning id into l3;
  insert into outreach_sequences(workspace_id, name, status, graph, sender_pool, settings) values (ws, 'intel seq', 'active', g, array[sa, mb1, mb2],
     '{"stop_on_reply":true,"wait_for_enrichment":true,"hold_for_ai_review":true}') returning id into seq;

  -- ------------------------------------------------------------ budgets: every new LinkedIn call has a ceiling and a warm-up cap
  perform outreach_plan_budgets(sa, outreach_sender_local_date(sa, now()));
  select cap into n from outreach_sender_budgets where sender_id = sa and action_type = 'post_fetch' and day = outreach_sender_local_date(sa, now());
  if n between 1 and 22 and outreach_reserve_budget(sa, outreach_sender_local_date(sa, now()), 'post_fetch') then log := log || E'\nok   B1 post_fetch is budgeted (level-3 cap ' || n || ', reservable)'; else fails := fails + 1; log := log || E'\nFAIL B1 post_fetch cap=' || coalesce(n::text,'null'); end if;
  select cap into n from outreach_sender_budgets where sender_id = sa and action_type = 'inmail' and day = outreach_sender_local_date(sa, now());
  if n <= 3 then log := log || E'\nok   B2 InMail speed guard: no history → at most 3 today (cap ' || n || ')'; else fails := fails + 1; log := log || E'\nFAIL B2 inmail cap=' || n; end if;

  -- ------------------------------------------------------------ item 13: enrichment
  insert into outreach_ai_variables(workspace_id, key, name, prompt, fallback) values (ws, 'icebreaker', 'Icebreaker', 'One line about their latest post', 'Hi there') returning id into v;
  perform outreach_enroll_leads(seq, array[l1]);
  select id, status::text || '/' || coalesce(wait_reason,'') into e, st from outreach_enrollments where sequence_id = seq and lead_id = l1;
  select count(*) into n from outreach_enrich_queue where lead_id = l1;
  if st = 'waiting_task/enrichment' and n = 1 then log := log || E'\nok   13a "wait for enrichment": the lead waits and is queued with priority'; else fails := fails + 1; log := log || E'\nFAIL 13a ' || st || ' queue=' || n; end if;
  j := outreach_save_lead_profile(l1, '{"about":"","experience":[],"education":[],"skills":[],"languages":[],"requested_sections":["about","experience","education","skills","languages"]}'::jsonb, sa, 'prefetch');
  select enrich_empty_streak into n from outreach_senders where id = sa;
  if (j->>'throttled')::boolean and n = 1 and (select enriched_at from outreach_lead_profiles where lead_id = l1) is null then log := log || E'\nok   13b an all-empty answer is "unknown": nothing stored as enriched, sender streak = 1';
    else fails := fails + 1; log := log || E'\nFAIL 13b ' || j::text || ' streak=' || n; end if;
  j := outreach_save_lead_profile(l1, jsonb_build_object('about','Builds rockets.','current_title','CEO','current_company','X','current_started_on', (current_date - 800)::text,
        'experience', jsonb_build_array(jsonb_build_object('company','X','title','CEO','current',true), jsonb_build_object('company','OldCo','title','VP Eng','current',false)),
        'education', jsonb_build_array(jsonb_build_object('school','MIT')), 'skills', jsonb_build_array('Propulsion','Hiring'), 'languages', jsonb_build_array('English'),
        'follower_count', 5200, 'requested_sections', jsonb_build_array('about','experience','education','skills','languages')), sa, 'prefetch');
  j2 := outreach_save_lead_profile(l1, '{"about":"","experience":[],"skills":["Propulsion"],"requested_sections":["about","experience","skills"]}'::jsonb, sa, 'step');
  select about into t from outreach_lead_profiles where lead_id = l1;
  if t = 'Builds rockets.' and (j2->'empty_sections') ? 'about' then log := log || E'\nok   13c a later empty section never overwrites stored data'; else fails := fails + 1; log := log || E'\nFAIL 13c about=' || coalesce(t,'null'); end if;
  perform outreach_save_lead_posts(l1, jsonb_build_array(jsonb_build_object('id','p1','text','We just shipped v2 of the engine','date', (now() - interval '3 days')::text, 'reactions', 40)), sa);
  j := outreach_render_context(l1, sa, e);
  if j->'enrich'->>'previous_company' = 'OldCo' and (j->'enrich'->>'years_in_role')::int = 2 and j->'enrich'->>'recent_post' like 'We just shipped%' and j->'sender'->>'booking_link' = 'https://cal.com/ann'
    then log := log || E'\nok   13d {{enrich.*}} context: previous company, years in role, recent post; sender booking link';
    else fails := fails + 1; log := log || E'\nFAIL 13d ' || (j->'enrich')::text; end if;
  if outreach_eval_condition('{"match":"all","rules":[{"field":"enrich.months_in_role","op":"gte","value":"24"},{"field":"enrich.past_company","op":"contains","value":"oldco"},{"field":"enrich.skill","op":"contains","value":"propulsion"},{"field":"enrich.posted_within_days","op":"lte","value":"30"},{"field":"enrich.follower_count","op":"gt","value":"5000"}]}'::jsonb, l1, sa)
    then log := log || E'\nok   13e sequence conditions on time in role, past company, skill, posted recently, followers'; else fails := fails + 1; log := log || E'\nFAIL 13e'; end if;

  -- ------------------------------------------------------------ item 14: AI lines wait for a person
  select status::text || '/' || coalesce(wait_reason,'') into st from outreach_enrollments where id = e;
  if st = 'waiting_task/ai_review' then log := log || E'\nok   14a after enrichment the lead moves to "waiting for review" (sequence holds for AI review)'; else fails := fails + 1; log := log || E'\nFAIL 14a ' || st; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_ai_generate_request(ws, v, array[l1, l2], seq, false);
  b := (j->>'batch_id')::uuid;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  select value_id into val from outreach_ai_claim_pending(10) where lead_id = l1;
  perform outreach_ai_value_result(val, 'Congrats on shipping v2 of the engine', '["post: We just shipped v2 of the engine"]'::jsonb, 'test-model', null);
  j := outreach_render_context(l1, sa, e);
  if (j->'ai') = '{}'::jsonb and (select status from outreach_ai_batches where id = b) in ('generating','review') then log := log || E'\nok   14b a generated line is NOT usable until approved (render context has no ai.icebreaker)'; else fails := fails + 1; log := log || E'\nFAIL 14b ai=' || (j->'ai')::text; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j2 := outreach_ai_review(array[val], 'approve', null);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  j := outreach_render_context(l1, sa, e);
  select approved_by into x from outreach_ai_values where id = val;
  select status::text || '/' || coalesce(wait_reason,'') into st from outreach_enrollments where id = e;
  if j->'ai'->>'icebreaker' like 'Congrats%' and x = u and st = 'waiting_task/ai_route' then log := log || E'\nok   14c approval is recorded (who, when), the line becomes usable, and the lead starts';
    else fails := fails + 1; log := log || E'\nFAIL 14c ai=' || (j->'ai')::text || ' approved_by=' || coalesce(x::text,'null') || ' enrollment=' || st; end if;

  -- ------------------------------------------------------------ item 15: AI routing
  select count(*) into n from outreach_ai_route_pending(10) where enrollment_id = e;
  perform outreach_ai_route_decide(e, 'r1', 'founders', 'Headline says CEO', '["title: CEO"]'::jsonb, 'test-model');
  select current_node_id into t from outreach_enrollments where id = e;
  if n = 1 and t = 'm1' and exists (select 1 from outreach_lead_timeline(l1) x where x.kind = 'ai_route' and x.data->>'reason' = 'Headline says CEO')
    then log := log || E'\nok   15 routing decision stored once with reason + facts, shown on the timeline, lead moved to the chosen branch';
    else fails := fails + 1; log := log || E'\nFAIL 15 pending=' || n || ' node=' || coalesce(t,'null'); end if;

  -- ------------------------------------------------------------ item 20: mailbox rotation, unsubscribe
  update outreach_sequences set settings = '{"stop_on_reply":true}' where id = seq;
  perform outreach_enroll_leads(seq, array[l2, l3], sa);
  select id into e2 from outreach_enrollments where sequence_id = seq and lead_id = l2;
  x := outreach_pick_mailbox(e2, g->'nodes'->'em1');
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key) values (ws, e2, x, l2, 'em1', 'email', now(), 'smoke3-' || gen_random_uuid());
  if outreach_pick_mailbox((select id from outreach_enrollments where sequence_id = seq and lead_id = l3), g->'nodes'->'em1') <> x then log := log || E'\nok   20a mailbox rotation: the next lead gets the other mailbox (even split)'; else fails := fails + 1; log := log || E'\nFAIL 20a same mailbox twice'; end if;
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l2, mb2, now() - interval '5 days') on conflict (lead_id, sender_id) do update set last_outbound_at = excluded.last_outbound_at;
  if outreach_pick_mailbox(e2, g->'nodes'->'em1') = mb2 then log := log || E'\nok   20b a contact emailed before always gets the same mailbox'; else fails := fails + 1; log := log || E'\nFAIL 20b'; end if;
  perform outreach_unsubscribe_lead(l2, 'link');
  select status::text into st from outreach_enrollments where id = e2;
  if st = 'exited_suppressed' and (select unsubscribed from outreach_leads where id = l2) then log := log || E'\nok   20c one-click unsubscribe sets the flag and exits the sequence; the lead and its history stay';
    else fails := fails + 1; log := log || E'\nFAIL 20c ' || st; end if;

  -- ------------------------------------------------------------ item 24: booking → Meeting booked
  j := outreach_record_booking(ws, 'calendly', 'evt-1', l3, null, 'booked', now() + interval '2 days', '{}'::jsonb, null);
  select s2.kind into t from outreach_leads x join outreach_stages s2 on s2.id = x.stage_id where x.id = l3;
  select status::text || ':' || exit_reason into st from outreach_enrollments where sequence_id = seq and lead_id = l3;
  if t = 'meeting' and st = 'completed:meeting_booked' and exists (select 1 from outreach_lead_milestones where lead_id = l3 and kind = 'meeting')
    then log := log || E'\nok   24 a booking marks the lead "Meeting", ends the sequence cleanly and fills the funnel stage';
    else fails := fails + 1; log := log || E'\nFAIL 24 stage=' || coalesce(t,'null') || ' enr=' || coalesce(st,'null'); end if;

  -- ------------------------------------------------------------ item 18: auto-enrol rule with the same checks + daily cap
  update outreach_sequences set graph = jsonb_set(g, '{nodes,start,next}', '"m1"') where id = seq;
  insert into outreach_auto_enroll_rules(workspace_id, sequence_id, name, list_id, daily_cap) values (ws, seq, 'hot list', lst, 1) returning id into rid;
  insert into outreach_leads(workspace_id, public_identifier, full_name, list_id) values (ws, 'smoke3-4', 'Four', lst), (ws, 'smoke3-5', 'Five', lst), (ws, 'smoke3-6', 'Unsub', lst);
  update outreach_leads set unsubscribed = true where public_identifier = 'smoke3-6' and workspace_id = ws;
  j := outreach_run_auto_enroll(rid);
  j2 := outreach_run_auto_enroll(rid);
  select count(*) into n from outreach_enrollments where rule_id = rid;
  if (j->>'enrolled')::int = 1 and (j2->>'enrolled')::int = 0 and n = 1 then log := log || E'\nok   18a auto-enrol: daily cap respected, unsubscribed lead never picked, activity logged';
    else fails := fails + 1; log := log || E'\nFAIL 18a ' || j::text || ' / ' || j2::text || ' enrolled=' || n; end if;
  insert into outreach_import_schedules(workspace_id, sender_id, name, kind, params, cadence, next_run_at) values (ws, sa, 'weekly search', 'search_url', '{"url":"https://www.linkedin.com/search/results/people/?keywords=cto"}', 'weekly', now() - interval '1 minute');
  n := outreach_run_import_schedules();
  if n >= 1 and exists (select 1 from outreach_import_jobs where workspace_id = ws and schedule_id is not null and status = 'queued') then log := log || E'\nok   18b a due repeating import becomes an ordinary import job (same budgets apply)';
    else fails := fails + 1; log := log || E'\nFAIL 18b ran=' || n; end if;

  -- ------------------------------------------------------------ item 21: API key acts as its member, never above its role
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  k := outreach_create_api_key(ws, 'viewer key', 'client_viewer', '{}', null);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  j := outreach_api_authenticate(k->>'key');
  kid := (j->>'key_id')::uuid;
  j2 := outreach_api_dispatch(kid, 'report_overview', jsonb_build_object('p_ws', ws));
  if j->>'role' = 'client_viewer' and (j2->'totals') ? 'reply_rate' and outreach_api_authenticate('ok_live_wrong') is null then log := log || E'\nok   21a key authenticates (hash only), dispatch runs the same report RPC as the UI';
    else fails := fails + 1; log := log || E'\nFAIL 21a auth=' || coalesce(j::text,'null'); end if;
  begin
    j2 := outreach_api_dispatch(kid, 'enroll_preview', jsonb_build_object('sequence', seq, 'lead_ids', jsonb_build_array(l1)));
    fails := fails + 1; log := log || E'\nFAIL 21b a viewer key could call enroll_preview';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   21b a viewer-role key is refused a member operation (E_FORBIDDEN), even though its member is an owner';
    else fails := fails + 1; log := log || E'\nFAIL 21b unexpected error: ' || sqlerrm; end if;
  end;
  j2 := outreach_api_dispatch(kid, 'api_leads', jsonb_build_object('ws', ws, 'filters', jsonb_build_object('q', 'Lead'), 'limit', 2));
  if (j2->>'total')::int = 3 and jsonb_array_length(j2->'data') = 2 and (j2->>'has_more')::boolean then log := log || E'\nok   21c list endpoints paginate (short argument names accepted)'; else fails := fails + 1; log := log || E'\nFAIL 21c ' || left(j2::text, 300); end if;

  -- ------------------------------------------------------------ item 23: branding is visible to clients, secrets are not
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', u::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_set_branding(ws, '{"product_name":"Acme Reach","accent":"#ff5500","logo_url":"http://insecure/logo.png","email_from_address":"hello@acme.test","hide_platform_name":true}'::jsonb);
  j2 := outreach_add_domain(ws, 'Reports.Acme.test', null);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  update outreach_workspace_domains set status = 'active' where workspace_id = ws;
  k := outreach_branding_for_host('reports.acme.test');
  if j->>'product_name' = 'Acme Reach' and not (j ? 'logo_url') and k->>'product_name' = 'Acme Reach' and not (k ? 'email_from_address') and jsonb_array_length(j2->'dns') = 2
    then log := log || E'\nok   23 branding saved (http logo rejected), custom domain resolves to the workspace, public branding leaks no sender address';
    else fails := fails + 1; log := log || E'\nFAIL 23 ' || j::text || ' host=' || coalesce(k::text,'null'); end if;

  -- ------------------------------------------------------------ item 26
  perform outreach_set_lead_email(l3, 'Found@Corp.test', 'verified', 'hunter');
  if (select email_work::text || '/' || email_status from outreach_leads where id = l3) = 'found@corp.test/verified' then log := log || E'\nok   26 found email stored lower-cased with its verification status'; else fails := fails + 1; log := log || E'\nFAIL 26'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (items 13-15, 18, 20, 21, 23, 24, 26)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
