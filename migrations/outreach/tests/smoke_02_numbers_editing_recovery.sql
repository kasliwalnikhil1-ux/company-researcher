-- Smoke test — items 2, 3, 4, 5, 6, 7, 8, 9, 11, 17, 19. Rolls back by raising at the end.
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; ca uuid; cb uuid; sa uuid; sb uuid; sc uuid; seq uuid; seqb uuid; l uuid[] := '{}'; lid uuid; e uuid; e2 uuid; a uuid; i int; st text; n int; n2 int; j jsonb; j2 jsonb; chat uuid; v text; t1 numeric; t2 numeric;
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
     "m1":{"id":"m1","type":"send_message","label":"Opener","config":{"text":"","send_always":true,"variants":[{"id":"a","label":"A","text":"{Hi|Hello} {{first_name}}, quick question","weight":1},{"id":"b","label":"B","text":"Saw your work at {{company|your company}}","weight":1}]},"next":"d1","position":{"x":0,"y":0}},
     "d1":{"id":"d1","type":"delay","config":{"amount":2,"unit":"days"},"next":"m2","position":{"x":0,"y":0}},
     "m2":{"id":"m2","type":"send_message","label":"Follow-up","config":{"text":"Following up","send_always":true},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
  g2 jsonb;
begin
  insert into outreach_workspaces(name, slug) values ('smoke2', 'smoke2-' || encode(gen_random_bytes(4),'hex')) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  update outreach_stages set kind = lower(name) where workspace_id = ws and kind is null and lower(name) in ('new','contacted','connected','replied','interested','meeting','won','lost');
  insert into outreach_clients(workspace_id, name, slug) values (ws, 'Client A', 'a') returning id into ca;
  insert into outreach_clients(workspace_id, name, slug) values (ws, 'Client B', 'b') returning id into cb;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, monthly_cost) values (ws, 'LINKEDIN', 'A', 'ok', 's2a-' || ws, 60) returning id into sa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, monthly_cost) values (ws, 'LINKEDIN', 'B', 'ok', 's2b-' || ws, 60) returning id into sb;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'C', 'ok', 's2c-' || ws) returning id into sc;
  update outreach_senders set schedule = '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}' where workspace_id = ws;
  for i in 1..12 loop
    insert into outreach_leads(workspace_id, public_identifier, full_name, first_name, company) values (ws, 'smoke2-' || i, 'Lead ' || i, 'L' || i, case when i = 8 then 'Acme Corp' else 'Co ' || i end) returning id into lid;
    l := l || lid;
  end loop;
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool) values (ws, ca, 'AB seq', 'active', g, array[sa, sb]) returning id into seq;
  insert into outreach_sequence_versions(sequence_id, version, graph) values (seq, 1, g);
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool) values (ws, cb, 'Client B seq', 'active', g, array[sa]) returning id into seqb;

  -- ------------------------------------------------------------ validation: spintax + variants
  j := outreach_validate_graph(g, array[sa, sb], true);
  if jsonb_array_length(j->'errors') = 0 then log := log || E'\nok   V1 graph with variants + spintax validates'; else fails := fails + 1; log := log || E'\nFAIL V1 ' || (j->'errors')::text; end if;
  select max_len, combinations into n, n2 from outreach_spintax_info('{Hi|Hello|Hey there} {{first_name|friend}}');
  if n = length('Hey there {{first_name|friend}}') and n2 = 3 then log := log || E'\nok   V2 spintax: longest combination + count; {{var|fallback}} is not spintax'; else fails := fails + 1; log := log || E'\nFAIL V2 len=' || n || ' combos=' || n2; end if;

  -- ------------------------------------------------------------ enrol 6, send the opener, one interested reply
  perform outreach_enroll_leads(seq, l[1:6]);
  for e, lid, i in select x.id, x.lead_id, row_number() over (order by x.created_at, x.id)::int from outreach_enrollments x where x.sequence_id = seq loop
    v := outreach_pick_variant(e, 'm1', g->'nodes'->'m1'->'config'->'variants');
    if v <> outreach_pick_variant(e, 'm1', g->'nodes'->'m1'->'config'->'variants') then fails := fails + 1; log := log || E'\nFAIL variant not sticky'; end if;
    a := outreach_queue_action(e, 'm1', 'message', now() - interval '1 hour', jsonb_build_object('text','x','variant_id', v));
    update outreach_actions set status = 'reserved', reserved_at = now() where id = a;
    perform outreach_complete_action(a, '{"message_id":"m"}'::jsonb, null);
    update outreach_actions set executed_at = case when i <= 3 then now() - interval '3 days' else now() end where id = a;   -- half of them on a day that gets rolled up
    if i = 1 then
      insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, ca, (select sender_id from outreach_enrollments where id = e), lid, 'c-' || e, 'LINKEDIN', 'Lead') returning id into chat;
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, action_id) values (ws, chat, 'out', 'x', now() - interval '50 minutes', a);
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, chat, 'in', 'Yes, tell me more', now() - interval '10 minutes');
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, chat, 'in', 'and pricing?', now() - interval '9 minutes');
      e2 := e;
    end if;
  end loop;
  select count(*) filter (where is_first_reply), count(*) filter (where replied_to_action_id is not null) into n, n2 from outreach_messages where chat_id = chat and direction = 'in';
  if n = 1 and n2 = 2 then log := log || E'\nok   4a inbound messages are stamped with the step they answer; only the first counts as a reply';
    else fails := fails + 1; log := log || E'\nFAIL 4a first=' || n || ' stamped=' || n2; end if;
  select count(*) into n from outreach_enrollments where sequence_id = seq and status = 'waiting_delay';
  if n = 6 then log := log || E'\nok   E  completing a step advances every lead into the delay'; else fails := fails + 1; log := log || E'\nFAIL E waiting_delay=' || n; end if;
  update outreach_chats set intent = 'interested' where id = chat;
  perform outreach_apply_reply_intent((select id from outreach_messages where chat_id = chat and is_first_reply), 'interested', null);
  select count(*) into n from outreach_lead_milestones where workspace_id = ws and kind = 'interested';
  select s2.kind into st from outreach_leads x join outreach_stages s2 on s2.id = x.stage_id where x.id = (select lead_id from outreach_enrollments where id = e2);
  if n = 1 and st = 'interested' then log := log || E'\nok   10a an interested reply moves the lead to the Interested stage and records the milestone'; else fails := fails + 1; log := log || E'\nFAIL 10a milestones=' || n || ' stage=' || coalesce(st,'null'); end if;

  -- ------------------------------------------------------------ item 2: one source of numbers
  j := outreach_report_overview(ws, null, current_date - 6, current_date);
  if (j->'totals'->>'messages')::int = 6 and (j->'totals'->>'replies')::int = 1 and (j->'totals'->>'interested')::int = 1 and (j->'totals'->>'reply_rate')::numeric = 16.7
    then log := log || E'\nok   2a overview: 6 messages, 1 reply, 1 interested, reply rate 16.7%';
    else fails := fails + 1; log := log || E'\nFAIL 2a ' || (j->'totals')::text; end if;
  t1 := (j->'totals'->>'messages')::numeric;
  perform outreach_rollup_daily(ws, current_date - 10, current_date);
  select count(*) into n from outreach_daily_stats where workspace_id = ws;
  j2 := outreach_report_overview(ws, null, current_date - 6, current_date);
  if n > 0 and j2->'totals' = j->'totals' then log := log || E'\nok   2b totals are identical before and after the nightly rollup (rollup rows: ' || n || ')';
    else fails := fails + 1; log := log || E'\nFAIL 2b rollup rows=' || n || E'\n  before=' || (j->'totals')::text || E'\n  after =' || (j2->'totals')::text; end if;
  j2 := outreach_dashboard(ws);
  if j2->'last_7_days' = j->'totals' then log := log || E'\nok   2c dashboard == reports (same facts function)'; else fails := fails + 1; log := log || E'\nFAIL 2c dashboard differs'; end if;
  select sum((x->'totals'->>'messages')::numeric), sum((x->'totals'->>'replies')::numeric) into t1, t2 from jsonb_array_elements(outreach_report_sequences(ws, null, current_date - 6, current_date)) x;
  if t1 = 6 and t2 = 1 then log := log || E'\nok   2d sequences table sums to the overview'; else fails := fails + 1; log := log || E'\nFAIL 2d seq sums ' || t1 || '/' || t2; end if;
  select sum((x->'totals'->>'messages')::numeric) into t1 from jsonb_array_elements(outreach_report_senders(ws, null, current_date - 6, current_date)) x;
  select sum((x->'totals'->>'messages')::numeric) into t2 from jsonb_array_elements(outreach_report_clients(ws, current_date - 6, current_date)) x;
  if t1 = 6 and t2 = 6 then log := log || E'\nok   2e senders table and clients table sum to the overview'; else fails := fails + 1; log := log || E'\nFAIL 2e senders=' || t1 || ' clients=' || t2; end if;
  j2 := outreach_report_intents(ws, null, current_date - 6, current_date, 'step');
  select count(*) into n from outreach_report_reply_threads(ws, null, current_date - 6, current_date, 'interested', '{}');
  if (j2->'intents'->>'interested')::int = 1 and n = 1 and (j2->>'positive_reply_rate')::numeric = 100 then log := log || E'\nok   10b intent breakdown == the threads the inbox opens for that number';
    else fails := fails + 1; log := log || E'\nFAIL 10b intents=' || (j2->'intents')::text || ' threads=' || n; end if;
  j2 := outreach_report_funnel(ws, null, current_date - 6, current_date, '{}');
  if (j2->>'cohort')::int = 6 and (j2->'stages'->3->>'count')::int = 6 and (j2->'stages'->4->>'count')::int = 1 and (j2->'stages'->5->>'count')::int = 1
    then log := log || E'\nok   10c funnel: 6 enrolled → 6 messaged → 1 replied → 1 interested';
    else fails := fails + 1; log := log || E'\nFAIL 10c ' || j2::text; end if;
  j2 := outreach_report_cost(ws, null, current_date - 29, current_date);
  if (j2->>'cost_per_reply') is not null and (j2->>'return_multiple') is null and (j2->>'senders_without_cost')::int = 1 then log := log || E'\nok   10d cost per reply computed; return not guessed; sender without a cost is flagged';
    else fails := fails + 1; log := log || E'\nFAIL 10d ' || j2::text; end if;

  -- ------------------------------------------------------------ item 11: A/B results
  j2 := outreach_ab_results(seq, 'm1', current_date - 6, current_date);
  select sum((x->>'sent')::int), sum((x->>'interested')::int) into n, n2 from jsonb_array_elements(j2->'variants') x;
  if n = 6 and n2 = 1 and not (j2->>'enough_data')::boolean and (j2->>'leader') is null then log := log || E'\nok   11 A/B: per-variant sent/interested, and no winner under 100 sends per variant';
    else fails := fails + 1; log := log || E'\nFAIL 11 ' || j2::text; end if;

  -- ------------------------------------------------------------ items 5 / 6 / 7: draft, impact, pinning, queued text
  g2 := jsonb_set(g, '{nodes,m2,config,text}', '"Following up (rewritten)"');
  j := outreach_save_draft(seq, g2);
  if (select graph from outreach_sequences where id = seq) = g and (j->>'unpublished_changes')::int = 1 then log := log || E'\nok   5  the draft is saved and the live graph is untouched'; else fails := fails + 1; log := log || E'\nFAIL 5 ' || j::text; end if;
  update outreach_enrollments set status = 'active', wait_until = now(), current_node_id = 'm2' where id = e2;
  update outreach_lead_sender_state set replied = false where lead_id = (select lead_id from outreach_enrollments where id = e2);
  a := outreach_queue_action(e2, 'm2', 'message', now() + interval '1 hour', '{"text":"Following up"}');
  j := outreach_publish_impact(seq, null);
  if (j->>'in_flight')::int = 6 and (j->>'on_changed_step')::int = 1 and (j->>'queued_with_old_text')::int = 1 then log := log || E'\nok   6a impact: 6 in flight, 1 on the changed step, 1 message queued with the old text';
    else fails := fails + 1; log := log || E'\nFAIL 6a ' || j::text; end if;
  j := outreach_publish_sequence(seq, null, 'new_only', 'rewrite follow-up');
  select count(*) into n from outreach_enrollments where sequence_id = seq and pinned_version = 1;
  if (j->>'pinned')::int = 6 and n = 6 and outreach_enrollment_graph(e2)->'nodes'->'m2'->'config'->>'text' = 'Following up'
     and (select draft_graph from outreach_sequences where id = seq) is null
    then log := log || E'\nok   6b "new leads only": in-flight leads are pinned to the version they are on; the draft is cleared';
    else fails := fails + 1; log := log || E'\nFAIL 6b ' || j::text || ' pinned=' || n; end if;
  perform outreach_enroll_leads(seq, array[l[7]]);
  select id into e from outreach_enrollments where sequence_id = seq and lead_id = l[7];
  if outreach_enrollment_graph(e)->'nodes'->'m2'->'config'->>'text' = 'Following up (rewritten)' then log := log || E'\nok   6c a new lead runs the new version'; else fails := fails + 1; log := log || E'\nFAIL 6c'; end if;
  select live_leads into n from outreach_version_usage(seq) where version = 1;
  j := outreach_move_to_latest(seq, 1);
  if n = 6 and (j->>'moved')::int = 6 and not ((select payload from outreach_actions where id = a) ? 'text') then log := log || E'\nok   6d versions page: 6 leads on v1 → moved to latest, their queued copy re-renders';
    else fails := fails + 1; log := log || E'\nFAIL 6d usage=' || n || ' ' || j::text; end if;
  if not outreach_set_action_text(a, 'Hand-edited for this lead') then fails := fails + 1; log := log || E'
FAIL 7 set_action_text returned false'; end if;
  select payload->>'text' into st from outreach_actions where id = a;
  if st = 'Hand-edited for this lead'
    then log := log || E'\nok   7  queued text edited through the non-agent RPC'; else fails := fails + 1; log := log || E'\nFAIL 7'; end if;

  -- ------------------------------------------------------------ item 8: failed leads are not a dead end
  update outreach_actions set status = 'reserved', reserved_at = now() where id = a;
  perform outreach_fail_action(a, 'net:errors/network', 'fail_enrollment');
  select status::text into st from outreach_enrollments where id = e2;
  select count(*) into n from outreach_failed_leads(seq, null, 'failed');
  j := outreach_enrollment_recover(array[e2], 'retry');
  select status::text into st from outreach_enrollments where id = e2;
  if n = 1 and (j->>'done')::int = 1 and st = 'active' then log := log || E'\nok   8a failed lead listed with a plain reason, "retry" re-opens it on the same step'; else fails := fails + 1; log := log || E'\nFAIL 8a listed=' || n || ' status=' || st || ' ' || j::text; end if;
  a := outreach_queue_action(e2, 'm2', 'message', now() + interval '1 hour', '{"text":"Following up"}');
  if a is not null then log := log || E'\nok   8b the retried step queues under a NEW idempotency key'; else fails := fails + 1; log := log || E'\nFAIL 8b queue_action returned null (idempotency collision)'; end if;
  update outreach_enrollments set status = 'failed', completed_at = now(), exit_reason = 'network_timeout_max' where id = e2;
  update outreach_senders set status = 'credentials' where id = (select sender_id from outreach_enrollments where id = e2);
  update outreach_senders set status = 'ok' where id = (select sender_id from outreach_enrollments where id = e2);
  select status::text into st from outreach_enrollments where id = e2;
  if st = 'active' then log := log || E'\nok   8c a reconnecting sender gets its transient failures back automatically'; else fails := fails + 1; log := log || E'\nFAIL 8c status=' || st; end if;

  -- ------------------------------------------------------------ item 9: rebalance when a sender is added
  perform outreach_enroll_leads(seqb, l[9:12], sa, 100, true);
  j := outreach_rebalance_preview(seqb, array[sa, sc]);
  j2 := outreach_set_pool(seqb, array[sa, sc], true);
  select count(*) into n from outreach_enrollments where sequence_id = seqb and sender_id = sc;
  if (j->>'would_move')::int = 2 and (j2->>'moved')::int = 2 and n = 2 then log := log || E'\nok   9  adding a sender offers to move 2 of 4 untouched leads, and moves exactly those';
    else fails := fails + 1; log := log || E'\nFAIL 9 preview=' || j::text || ' result=' || j2::text || ' on C=' || n; end if;

  -- ------------------------------------------------------------ item 17: blacklist scoped to one client, companies included
  j := outreach_add_suppressions(ws, '[{"value":"Acme Corp"},{"value":"https://www.blocked.io/about"},{"value":"https://linkedin.com/in/someone/"}]'::jsonb, ca, null, 'csv');
  j2 := outreach_enroll_preview(seq, array[l[8]]);
  j := outreach_enroll_preview(seqb, array[l[8]]);
  if (j2->>'eligible')::int = 0 and (j2->'excluded') ? 'suppressed:client_blacklist:company' and (j->>'eligible')::int = 1
    then log := log || E'\nok   17 company blacklisted for client A only: blocked there, still eligible for client B; nothing deleted';
    else fails := fails + 1; log := log || E'\nFAIL 17 A=' || j2::text || E'\n  B=' || j::text; end if;
  select count(*) into n from outreach_suppressions where workspace_id = ws and kind in ('company','domain','public_identifier') and value in ('acme corp','blocked.io','someone');
  if n = 3 then log := log || E'\nok   17b uploaded values are normalised (company, domain, profile URL)'; else fails := fails + 1; log := log || E'\nFAIL 17b n=' || n; end if;

  -- ------------------------------------------------------------ item 19: history-aware assignment
  update outreach_sequences set assignment = 'fresh_sender', sender_pool = array[sa, sc] where id = seqb;
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l[5], sa, now() - interval '40 days') on conflict (lead_id, sender_id) do update set last_outbound_at = excluded.last_outbound_at;
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l[5], sc, now() - interval '40 days') on conflict (lead_id, sender_id) do update set last_outbound_at = excluded.last_outbound_at;
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l[6], sa, now() - interval '40 days') on conflict (lead_id, sender_id) do update set last_outbound_at = excluded.last_outbound_at;
  j := outreach_enroll_preview(seqb, array[l[5], l[6]]);
  if (j->'excluded'->'no_fresh_sender'->>'count')::int = 1 and (j->>'eligible')::int = 1 and (j->'assignment'->0->>'sender_id')::uuid = sc
    then log := log || E'\nok   19 fresh-sender rule: one lead moved to the sender that never contacted it, one skipped with the reason';
    else fails := fails + 1; log := log || E'\nFAIL 19 ' || j::text; end if;

  -- ------------------------------------------------------------ item 3: stalled-campaign alert
  update outreach_enrollments set status = 'active', wait_until = now() - interval '2 hours', node_entered_at = now() - interval '2 hours', current_node_id = 'm2' where sequence_id = seq;
  update outreach_actions set status = 'cancelled' where status in ('queued','reserved') and enrollment_id in (select id from outreach_enrollments where sequence_id = seq);
  update outreach_actions set executed_at = now() - interval '3 days' where enrollment_id in (select id from outreach_enrollments where sequence_id = seq) and status = 'sent';
  update outreach_senders set status = 'paused', status_reason = 'user_paused' where id in (sa, sb);
  j := outreach_detect_stalls();
  select count(*) into n from outreach_alerts where workspace_id = ws and kind = 'sequence_stalled' and entity_id = seq and resolved_at is null;
  select reason into st from outreach_alerts where workspace_id = ws and kind = 'sequence_stalled' and entity_id = seq;
  j2 := outreach_detect_stalls();
  select count(*) into n2 from outreach_alerts where workspace_id = ws and kind = 'sequence_stalled' and entity_id = seq;
  if n = 1 and n2 = 1 and st like '%paused%' then log := log || E'\nok   3a pausing every pool sender raises ONE alert with the reason: "' || st || '"';
    else fails := fails + 1; log := log || E'\nFAIL 3a open=' || n || ' total=' || n2 || ' reason=' || coalesce(st,'null'); end if;
  if exists (select 1 from jsonb_array_elements((outreach_dashboard(ws))->'attention') x where x->>'kind' = 'sequence_stalled') then log := log || E'\nok   3b the alert is on the dashboard attention list'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  update outreach_senders set status = 'ok', status_reason = null where id in (sa, sb);
  perform outreach_queue_action(x.id, 'm2', 'message', now() + interval '1 hour', '{"text":"y"}') from outreach_enrollments x where x.sequence_id = seq and x.status = 'active';
  j := outreach_detect_stalls();
  select count(*) into n from outreach_alerts where workspace_id = ws and kind = 'sequence_stalled' and entity_id = seq and resolved_at is null;
  if n = 0 and (select stalled_at from outreach_sequences where id = seq) is null then log := log || E'\nok   3c resuming clears it'; else fails := fails + 1; log := log || E'\nFAIL 3c still open=' || n; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (items 2-11, 17, 19)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
