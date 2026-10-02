-- Smoke test — 066 AI fields (ai-fields-json-changes.md Part A; docs/outreach/AI-FIELDS.md): the field list check, the
-- coercion of AI and human input, the worker's result path, the render context, Condition rules on AI fields, leads that
-- wait for a value a Condition reads, the typed edit, the guard on fields in use, the hub views and grants.
-- Builds fixtures, asserts, then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_16_ai_fields.sql
-- Service functions run as the service role (superuser here → outreach_is_service() is true); user RPCs and the views
-- (security_invoker) are read as impersonated members.
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; b boolean; st text;
  ws uuid; u_owner uuid; u_member uuid; ca uuid; cb uuid; s1 uuid; l1 uuid; l2 uuid; l3 uuid; l4 uuid;
  var uuid; opener uuid; v1 uuid; v2 uuid; v3 uuid; v4 uuid; vo uuid; seq uuid; e1 uuid;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  flds jsonb := '[
    {"key":"icp_fit","name":"ICP fit","type":"choice","options":["high","medium","low"],"description":"How well the company matches the ICP"},
    {"key":"pain","name":"Pain","type":"text","max_chars":120,"description":"Their most likely outbound pain"},
    {"key":"hiring_sales","name":"Hiring sales","type":"yes_no","description":"Profile or posts show they are hiring SDRs/AEs"},
    {"key":"team_size","name":"Team size","type":"number","description":"Employees, if the profile states it"}]';
  -- the ONLY use of the variable is a Condition step
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"c1","position":{"x":0,"y":0}},
     "c1":{"id":"c1","type":"condition","config":{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"eq","value":"high"}]},"branches":{"true":"m_hi","false":"end"},"position":{"x":0,"y":0}},
     "m_hi":{"id":"m_hi","type":"send_message","config":{"text":"Hi {{first_name}}","send_always":true},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
  as_owner text; as_member text;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  if u_member is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;
  as_owner := json_build_object('role', 'authenticated', 'sub', u_owner)::text;
  as_member := json_build_object('role', 'authenticated', 'sub', u_member)::text;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke16', 'smoke16-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner16@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member16@test.local', 'Naman', array[cb]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Sender A', 'ok', 's16a-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', u_owner, 'owner16@test.local') returning id into s1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company) values (ws, ca, 'priya16-' || left(ws::text, 8), 'Priya Nair', 'Priya', 'Razorpay') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company) values (ws, ca, 'ben16-' || left(ws::text, 8), 'Ben Roe', 'Ben', 'Loomcraft') returning id into l2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name) values (ws, cb, 'cara16-' || left(ws::text, 8), 'Cara Diaz', 'Cara') returning id into l3;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name) values (ws, ca, 'dev16-' || left(ws::text, 8), 'Dev Shah', 'Dev') returning id into l4;

  -- ============================================================ 1. The field list check
  if outreach_hub_fields_valid(flds)
     and not outreach_hub_fields_valid('[]'::jsonb) and not outreach_hub_fields_valid('{}'::jsonb) and not outreach_hub_fields_valid(null)
     and not outreach_hub_fields_valid((select jsonb_agg(jsonb_build_object('key', 'f' || i, 'name', 'F' || i, 'type', 'text')) from generate_series(1, 9) i))      -- 9 fields
     and not outreach_hub_fields_valid(flds || '[{"key":"pain","name":"Pain again","type":"text"}]'::jsonb)                                                       -- duplicate key
     and not outreach_hub_fields_valid('[{"key":"fit","name":"Fit","type":"choice","options":["only"]}]'::jsonb)                                                   -- choice with 1 option
     and not outreach_hub_fields_valid('[{"key":"fit","name":"Fit","type":"choice","options":["a","A"]}]'::jsonb)                                                  -- the same option twice
     and not outreach_hub_fields_valid('[{"key":"Bad Key","name":"Bad","type":"text"}]'::jsonb)                                                                    -- bad key
     and not outreach_hub_fields_valid('[{"key":"x1","name":"","type":"text"}]'::jsonb) and not outreach_hub_fields_valid('[{"key":"x1","name":"X","type":"list"}]'::jsonb)
     and not outreach_hub_fields_valid('[{"key":"x1","name":"X","type":"text","max_chars":5}]'::jsonb) and not outreach_hub_fields_valid('[{"key":"x1","name":"X","type":"text","max_chars":"abc"}]'::jsonb)
     and outreach_hub_fields_valid('[{"key":"x1","name":"X","type":"text"}]'::jsonb)
    then log := log || E'\nok   field list: 1 to 8 fields, unique keys, a choice needs 2 to 12 distinct options, text limits 20 to 1000; malformed input is false, never an error';
    else fails := fails + 1; log := log || E'\nFAIL field list check'; end if;

  begin
    insert into outreach_ai_variables(workspace_id, key, name, prompt, output, fields) values (ws, 'bad1', 'Bad', 'A prompt long enough to pass.', 'fields', '[]');
    t := 'no error';
  exception when check_violation then t := 'check'; end;
  begin
    insert into outreach_ai_variables(workspace_id, key, name, prompt, output, fields) values (ws, 'bad2', 'Bad', 'A prompt long enough to pass.', 'text', flds);
    t := t || '/no error';
  exception when check_violation then t := t || '/check'; end;
  if t = 'check/check' then log := log || E'\nok   constraint: a Fields variable needs a valid field list; a one-line variable has none';
    else fails := fails + 1; log := log || E'\nFAIL constraint: ' || t; end if;

  insert into outreach_ai_variables(workspace_id, key, name, prompt, output, fields) values (ws, 'research', 'Research', 'Judge this lead against our ICP: B2B SaaS, 20–500 people, sells outbound.', 'fields', flds) returning id into var;
  insert into outreach_ai_variables(workspace_id, key, name, prompt, fallback) values (ws, 'opener', 'Opener', 'One sentence about their current role, grounded in the profile.', 'I came across your work') returning id into opener;

  -- ============================================================ 2. Coercion: AI output is cleaned, a person's edit is refused
  j := outreach_hub_fields_clean(flds, '{"icp_fit":"High","pain":"  scaling   outbound  ","hiring_sales":"Yes","team_size":"1,200","extra":"dropped"}'::jsonb, false);
  k := outreach_hub_fields_clean(flds, '{"icp_fit":"huge","pain":"see {{x}}","hiring_sales":"maybe","team_size":"about 40"}'::jsonb, false);
  if j = '{"icp_fit":"high","pain":"scaling outbound","hiring_sales":true,"team_size":1200}'::jsonb
     and k = '{"icp_fit":null,"pain":null,"hiring_sales":null,"team_size":null}'::jsonb
     and outreach_hub_fields_clean(flds, '{"hiring_sales":false,"team_size":40,"pain":"n/a","icp_fit":null}'::jsonb, false) = '{"icp_fit":null,"pain":null,"hiring_sales":false,"team_size":40}'::jsonb
     and outreach_hub_fields_clean(flds, null, false) = k and outreach_hub_fields_clean(flds, '"text"'::jsonb, false) = k
     and outreach_hub_fields_clean(flds, '{"pain":{"a":1},"team_size":[1]}'::jsonb, false) = k
     and length(outreach_hub_fields_clean(flds, jsonb_build_object('pain', repeat('x', 500)), false)->>'pain') = 240
    then log := log || E'\nok   clean (AI output): Yes → true, 1,200 → 1200, High → high; huge, a leftover {{x}}, maybe, "about 40", nested values → null; unknown keys dropped; long text cut';
    else fails := fails + 1; log := log || E'\nFAIL clean: ' || j::text || ' / ' || k::text; end if;

  n := 0;
  for t in select unnest(array['{"icp_fit":"huge"}', '{"pain":"see {{x}}"}', '{"hiring_sales":"maybe"}', '{"team_size":"about 40"}', '{"pain":{"a":1}}']) loop
    begin perform outreach_hub_fields_clean(flds, t::jsonb, true);
    exception when others then if sqlerrm like 'E_PAYLOAD_INVALID:%' then n := n + 1; end if; end;
  end loop;
  begin perform outreach_hub_fields_clean(flds, jsonb_build_object('pain', repeat('x', 241)), true);
  exception when others then if sqlerrm like 'E_PAYLOAD_INVALID: "Pain" is longer than 240%' then n := n + 1; end if; end;
  if n = 6 and outreach_hub_fields_clean(flds, '{"icp_fit":"LOW","team_size":"12.5"}'::jsonb, true) = '{"icp_fit":"low","pain":null,"hiring_sales":null,"team_size":12.5}'::jsonb
    then log := log || E'\nok   clean (strict): each bad value raises E_PAYLOAD_INVALID naming the field; valid input passes';
    else fails := fails + 1; log := log || E'\nFAIL clean strict: ' || n || ' of 6 raised'; end if;

  if outreach_hub_fields_summary(flds, j) = 'ICP fit: high · Pain: scaling outbound · Hiring sales: Yes · Team size: 1200'
     and outreach_hub_fields_summary(flds, '{"hiring_sales":false,"team_size":0}'::jsonb) = 'Hiring sales: No · Team size: 0'
     and outreach_hub_fields_summary(flds, k) is null and outreach_hub_fields_summary(flds, null) is null
    then log := log || E'\nok   summary: the fields in list order, Yes / No for a yes/no field, null when every field is empty';
    else fails := fails + 1; log := log || E'\nFAIL summary: ' || coalesce(outreach_hub_fields_summary(flds, j), 'null'); end if;

  -- ============================================================ 3. Which variables a graph uses
  if outreach_sequence_ai_keys(g) = array['research']
     and outreach_sequence_ai_keys('{"a":"{{#if ai.research.hiring_sales}}x{{/if}}"}'::jsonb) = array['research']
     and outreach_sequence_ai_keys('{"a":"Hi {{ai.research.pain|there}} {{ ai.opener }}"}'::jsonb) = array['opener', 'research']
     and outreach_sequence_ai_keys('{"a":"{{first_name}} said \"field\":\"ai.fake\""}'::jsonb) = '{}'::text[]
     and outreach_sequence_ai_keys(null) = '{}'::text[]
    then log := log || E'\nok   sequence_ai_keys: finds a variable from a Condition rule alone, from {{#if ai.x.y}} and from {{ai.x.y}}';
    else fails := fails + 1; log := log || E'\nFAIL sequence_ai_keys: ' || outreach_sequence_ai_keys(g)::text; end if;

  -- ============================================================ 4. A lead waits for the value its Condition step reads
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool, settings, created_by)
    values (ws, ca, 'Q4 SaaS founders', 'active', g, array[s1], '{"stop_on_reply":true,"hold_for_ai_review":true}', u_owner) returning id into seq;
  perform outreach_enroll_leads(seq, array[l1, l2, l4], s1);
  select id, status::text || '/' || coalesce(wait_reason, '') into e1, st from outreach_enrollments where sequence_id = seq and lead_id = l1;
  select id into v1 from outreach_ai_values where lead_id = l1 and variable_id = var and status = 'pending';
  select id into v2 from outreach_ai_values where lead_id = l2 and variable_id = var and status = 'pending';
  select id into v4 from outreach_ai_values where lead_id = l4 and variable_id = var and status = 'pending';
  if st = 'waiting_task/ai_review' and v1 is not null and v2 is not null and v4 is not null
    then log := log || E'\nok   enrolment: a sequence whose only use of the variable is a Condition creates the value and holds the lead (ai_review)';
    else fails := fails + 1; log := log || E'\nFAIL enrolment: ' || coalesce(st, 'null') || ' value=' || coalesce(v1::text, 'null'); end if;

  -- ============================================================ 5. The worker's result
  update outreach_ai_values set locked_at = now(), attempts = 1 where id in (v1, v2, v4);
  perform outreach_ai_value_result_fields(v1, '{"icp_fit":"High","pain":"scaling outbound without adding SDRs","hiring_sales":"yes","team_size":"1,200","extra":"dropped"}'::jsonb,
    '["title: Head of Growth"]'::jsonb, 'test-model', null);
  select status, text, data into st, t, j from outreach_ai_values where id = v1;
  k := outreach_render_context(l1, s1, e1);
  if st = 'generated' and t = 'ICP fit: high · Pain: scaling outbound without adding SDRs · Hiring sales: Yes · Team size: 1200'
     and j = '{"icp_fit":"high","pain":"scaling outbound without adding SDRs","hiring_sales":true,"team_size":1200}'::jsonb
     and (select generated_at from outreach_ai_values where id = v1) is not null
     and k->'ai' = '{}'::jsonb
     and (select status::text || '/' || coalesce(wait_reason, '') from outreach_enrollments where id = e1) = 'waiting_task/ai_review'
    then log := log || E'\nok   result: typed data + the summary as text, status generated; nothing renders and the lead keeps waiting until a person approves';
    else fails := fails + 1; log := log || E'\nFAIL result: ' || coalesce(st, 'null') || ' ' || coalesce(t, 'null') || ' ' || coalesce(j::text, 'null') || ' ai=' || (k->'ai')::text; end if;

  -- every field empty → blank: nothing to review, the lead is released and takes the false branch
  perform outreach_ai_value_result_fields(v2, '{"icp_fit":"huge","pain":null,"hiring_sales":"maybe"}'::jsonb, '[]'::jsonb, 'test-model', null);
  select status, text, data into st, t, j from outreach_ai_values where id = v2;
  if st = 'blank' and t is null and j = '{"icp_fit":null,"pain":null,"hiring_sales":null,"team_size":null}'::jsonb
     and (select status::text from outreach_enrollments where sequence_id = seq and lead_id = l2) <> 'waiting_task'
     and not outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"eq","value":"high"}]}'::jsonb, l2, s1)
     and outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"not_exists"},{"field":"ai.research","op":"not_exists"}]}'::jsonb, l2, s1)
    then log := log || E'\nok   blank: all fields empty → status blank, the lead is released; its rules are false except "is empty"';
    else fails := fails + 1; log := log || E'\nFAIL blank: ' || coalesce(st, 'null') || ' ' || coalesce(j::text, 'null') || ' enrolment=' || coalesce((select status::text from outreach_enrollments where sequence_id = seq and lead_id = l2), 'null'); end if;

  -- an error stores nothing
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, status) values (ws, l3, var, 'pending') returning id into v3;
  perform outreach_ai_value_result_fields(v3, '{"icp_fit":"high"}'::jsonb, '[]'::jsonb, null, 'E_AI_UNAVAILABLE: no answer');
  -- a one-line value is not touched by the fields path
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, status) values (ws, l1, opener, 'pending') returning id into vo;
  perform outreach_ai_value_result_fields(vo, '{"icp_fit":"high"}'::jsonb, '[]'::jsonb, 'test-model', null);
  if (select status || '/' || coalesce(data::text, 'null') from outreach_ai_values where id = v3) = 'failed/null' and (select status from outreach_ai_values where id = vo) = 'pending'
    then log := log || E'\nok   result: an error marks the value failed with no data; the fields path ignores a one-line variable';
    else fails := fails + 1; log := log || E'\nFAIL result error path'; end if;

  -- ============================================================ 6. Needs you and Activity show the Fields value (summary text)
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  select jsonb_build_object('ai_text', x.ai_text, 'where', x.where_name, 'meta', x.meta) into j from outreach_ai_needs_you x where x.workspace_id = ws and x.type = 'line' and x.id = v1;
  select count(*) into n from outreach_ai_outputs o where o.workspace_id = ws and o.feature = 'line' and o.id = v1 and o.text like 'ICP fit: high · Pain:%';
  k := outreach_hub_setup(ws);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'ai_text' like 'ICP fit: high%' and j->>'where' = 'research' and j->'meta'->>'output' = 'fields' and jsonb_array_length(j->'meta'->'fields') = 4
     and j->'meta'->'data'->>'icp_fit' = 'high' and (j->'meta'->'data'->>'team_size')::int = 1200 and n = 1
     and (select x->>'output' from jsonb_array_elements(k->'variables') x where x->>'key' = 'research') = 'fields'
     and (select x->>'output' from jsonb_array_elements(k->'variables') x where x->>'key' = 'opener') = 'text'
    then log := log || E'\nok   hub: the Line card carries the summary plus output, fields and data; Activity shows the summary; Setup says which variables write fields';
    else fails := fails + 1; log := log || E'\nFAIL hub views: ' || coalesce(j::text, 'null') || ' outputs=' || n; end if;

  -- ============================================================ 7. Approve → the object renders, the rule holds, the lead takes the true branch
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  j := outreach_ai_review(array[v1], 'approve', null);
  k := outreach_render_context(l1, s1, e1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select current_node_id into t from outreach_enrollments where id = e1;
  if (j->>'updated')::int = 1 and jsonb_typeof(k->'ai'->'research') = 'object' and k->'ai'->'research'->>'pain' like 'scaling outbound%'
     and jsonb_typeof(k->'ai'->'research'->'hiring_sales') = 'boolean' and jsonb_typeof(k->'ai'->'research'->'team_size') = 'number' and t = 'm_hi'
    then log := log || E'\nok   approve: ai.research is the typed object in the render context, and the lead takes the Condition''s true branch';
    else fails := fails + 1; log := log || E'\nFAIL approve: node=' || coalesce(t, 'null') || ' ai=' || (k->'ai')::text; end if;

  if outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"eq","value":"HIGH"},{"field":"ai.research.hiring_sales","op":"eq","value":"true"},{"field":"ai.research.team_size","op":"gte","value":"20"},{"field":"ai.research.pain","op":"contains","value":"OUTBOUND"},{"field":"ai.research","op":"exists"},{"field":"ai.opener","op":"not_exists"},{"field":"ai.research.icp_fit","op":"neq","value":"low"}]}'::jsonb, l1, s1)
     and not outreach_eval_condition('{"match":"any","rules":[{"field":"ai.research.team_size","op":"lt","value":"20"},{"field":"ai.research.hiring_sales","op":"eq","value":"false"},{"field":"ai.research.nope","op":"exists"},{"field":"ai.opener.pain","op":"exists"},{"field":"ai.missing_variable.x","op":"exists"},{"field":"ai.research.pain","op":"gt","value":"5"}]}'::jsonb, l1, s1)
    then log := log || E'\nok   rules: choice and text compare case-insensitively, yes/no as true/false, numbers numerically; an unknown field or variable is empty';
    else fails := fails + 1; log := log || E'\nFAIL rules on approved fields'; end if;

  -- ============================================================ 8. The typed edit
  perform outreach_ai_value_result_fields(v4, '{"icp_fit":"medium","pain":"hiring is slow","hiring_sales":true,"team_size":40}'::jsonb, '["headline: Founder"]'::jsonb, 'test-model', null);
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  t := '';
  begin perform outreach_hub_line_fields_edit(v4, '{"icp_fit":"huge"}'::jsonb); t := t || 'none|'; exception when others then t := t || left(sqlerrm, 44) || '|'; end;
  begin perform outreach_hub_line_fields_edit(v4, '{"icp_fit":null,"pain":" "}'::jsonb); t := t || 'none|'; exception when others then t := t || left(sqlerrm, 44) || '|'; end;
  begin perform outreach_ai_review(array[v4], 'edit', 'free text'); t := t || 'none|'; exception when others then t := t || left(sqlerrm, 44) || '|'; end;
  begin perform outreach_hub_line_fields_edit(vo, '{"icp_fit":"high"}'::jsonb); t := t || 'none'; exception when others then t := t || left(sqlerrm, 44); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'E_PAYLOAD_INVALID: "ICP fit" is not a valid |E_PAYLOAD_INVALID: fill at least one field, |E_PAYLOAD_INVALID: this variable writes fiel|E_PAYLOAD_INVALID: this variable writes one '
     and (select status from outreach_ai_values where id = v4) = 'generated'
    then log := log || E'\nok   edit refused: a bad choice, an empty edit, a free-text edit of a Fields value, a fields edit of a one-line value';
    else fails := fails + 1; log := log || E'\nFAIL edit refusals: ' || t; end if;

  -- a member who may only see client B cannot edit a client A value
  perform set_config('request.jwt.claims', as_member, true); execute 'set local role authenticated';
  begin perform outreach_hub_line_fields_edit(v4, '{"icp_fit":"low"}'::jsonb); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' then log := log || E'\nok   edit scope: a member cannot edit a value of a client they do not see';
    else fails := fails + 1; log := log || E'\nFAIL edit scope: ' || t; end if;

  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  j := outreach_hub_line_fields_edit(v4, '{"icp_fit":"LOW","pain":"x","hiring_sales":"no","team_size":"12"}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select status || '/' || edited::text || '/' || coalesce(text, 'null'), data into t, k from outreach_ai_values where id = v4;
  if t = 'approved/true/ICP fit: low · Pain: x · Hiring sales: No · Team size: 12' and k = '{"icp_fit":"low","pain":"x","hiring_sales":false,"team_size":12}'::jsonb
     and (select approved_by from outreach_ai_values where id = v4) = u_owner and j->'data' = k
     and (select status::text from outreach_enrollments where sequence_id = seq and lead_id = l4) <> 'waiting_task'
     and not outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"eq","value":"high"}]}'::jsonb, l4, s1)
     and outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.hiring_sales","op":"eq","value":"false"},{"field":"ai.research.team_size","op":"lt","value":"20"}]}'::jsonb, l4, s1)
    then log := log || E'\nok   edit: a valid edit approves the value (edited, who), keeps data and summary in step, and releases the lead';
    else fails := fails + 1; log := log || E'\nFAIL edit: ' || coalesce(t, 'null') || ' ' || coalesce(k::text, 'null'); end if;

  -- ============================================================ 9. Skip and regenerate
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  perform outreach_ai_review(array[v4], 'skip', null);
  k := outreach_render_context(l4, s1, null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  b := outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"not_exists"}]}'::jsonb, l4, s1)
       and not outreach_eval_condition('{"match":"all","rules":[{"field":"ai.research.icp_fit","op":"eq","value":"low"}]}'::jsonb, l4, s1);
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  perform outreach_ai_review(array[v4], 'regenerate', null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if b and k->'ai' = '{}'::jsonb and (select status || '/' || coalesce(text, 'null') || '/' || coalesce(data::text, 'null') from outreach_ai_values where id = v4) = 'pending/null/null'
    then log := log || E'\nok   skip: the value is empty for rules and messages; regenerate clears the typed value with the text';
    else fails := fails + 1; log := log || E'\nFAIL skip / regenerate: ' || coalesce((select status || '/' || coalesce(data::text, 'null') from outreach_ai_values where id = v4), 'null'); end if;

  -- ============================================================ 10. Guard: a field in use stays; the output is fixed
  update outreach_sequences set draft_graph = '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"m","position":{"x":0,"y":0}},"m":{"id":"m","type":"send_message","config":{"text":"On {{ai.research.pain|growth}}"},"next":null,"position":{"x":0,"y":0}}}}' where id = seq;
  t := '';
  -- remove `pain` (used in the draft)
  begin update outreach_ai_variables set fields = (select jsonb_agg(x) from jsonb_array_elements(flds) x where x->>'key' <> 'pain') where id = var; t := t || 'none|';
  exception when others then t := t || left(sqlerrm, 78) || '|'; end;
  -- change the type of `icp_fit` (used by the live Condition)
  begin update outreach_ai_variables set fields = (select jsonb_agg(case when x->>'key' = 'icp_fit' then '{"key":"icp_fit","name":"ICP fit","type":"text"}'::jsonb else x end) from jsonb_array_elements(flds) x) where id = var; t := t || 'none|';
  exception when others then t := t || left(sqlerrm, 22) || '|'; end;
  begin update outreach_ai_variables set output = 'text', fields = '[]' where id = var; t := t || 'none|';
  exception when others then t := t || left(sqlerrm, 62) || '|'; end;
  begin update outreach_ai_variables set output = 'fields', fields = flds where id = opener; t := t || 'none';
  exception when others then t := t || left(sqlerrm, 17); end;
  if t = 'E_AI_FIELD_IN_USE: "Pain" is used in: Q4 SaaS founders. Remove it from those s|E_AI_FIELD_IN_USE: "IC|E_PAYLOAD_INVALID: the output of a variable cannot change; cre|E_PAYLOAD_INVALID'
    then log := log || E'\nok   guard: removing or retyping a field a sequence uses names the sequence; the output of a variable cannot change';
    else fails := fails + 1; log := log || E'\nFAIL guard: ' || t; end if;

  -- adding a field, renaming one, and removing one nobody uses are fine
  update outreach_ai_variables set fields = (select jsonb_agg(case when x->>'key' = 'pain' then x || '{"name":"Main pain","max_chars":200}'::jsonb else x end) from jsonb_array_elements(flds) x where x->>'key' <> 'team_size')
        || '[{"key":"tool","name":"Tool","type":"text"}]'::jsonb where id = var;
  -- an archived sequence no longer holds a field (its draft and live graph are ignored once no lead runs on it)
  update outreach_enrollments set status = 'completed' where sequence_id = seq;
  update outreach_sequences set status = 'archived' where id = seq;
  update outreach_ai_variables set fields = '[{"key":"tool","name":"Tool","type":"text"}]'::jsonb where id = var;
  if (select jsonb_array_length(fields) from outreach_ai_variables where id = var) = 1
    then log := log || E'\nok   guard: adding, renaming and removing an unused field pass; an archived sequence with no running leads holds nothing';
    else fails := fails + 1; log := log || E'\nFAIL guard (allowed changes)'; end if;

  -- ============================================================ 11. Grants
  if has_function_privilege('authenticated', 'outreach_hub_line_fields_edit(uuid,jsonb)', 'execute') and has_function_privilege('authenticated', 'outreach_hub_fields_valid(jsonb)', 'execute')
     and not has_function_privilege('anon', 'outreach_hub_line_fields_edit(uuid,jsonb)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_ai_value_result_fields(uuid,jsonb,jsonb,text,text)', 'execute')
     and has_function_privilege('service_role', 'outreach_ai_value_result_fields(uuid,jsonb,jsonb,text,text)', 'execute')
     and to_regprocedure('outreach_hub__patch(text,text,text[])') is null and to_regprocedure('outreach_hub__patch_view(text,text,text[])') is null
    then log := log || E'\nok   grants: the typed edit and the field check for signed-in users; the worker''s result path is service only; the patch helpers are gone';
    else fails := fails + 1; log := log || E'\nFAIL grants'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (AI fields 066)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
