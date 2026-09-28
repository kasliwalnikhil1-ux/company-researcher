-- Smoke test — 029: enrichment on a lead's first reply, Open Profile leads skip the invitation. Builds fixtures, asserts,
-- then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_07_reply_enrich_open_profile.sql
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; u_owner uuid; u_member uuid;
  s_li uuid; s_li2 uuid; s_ig uuid;
  la uuid; lb uuid; lc uuid; ld uuid; le uuid; lf uuid; lg uuid;
  q uuid; ea uuid; eb uuid; a_pre uuid; a_inv uuid;
  j jsonb; t text; n int; d date; g jsonb;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  if u_member is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke7', 'smoke7-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner7@test.local');
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_member, 'member', 'member7@test.local');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'LINKEDIN', 'Li One', 'ok', 's7li-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_li;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'LINKEDIN', 'Li Two', 'ok', 's7li2-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_li2;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'INSTAGRAM', 'Ig One', 'ok', 's7ig-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_ig;

  insert into outreach_leads(workspace_id, public_identifier, provider_id, full_name, is_open_profile, last_profile_fetch_at)
    values (ws, 'ann-op-' || left(ws::text, 8), 'ACo-ann-' || left(ws::text, 8), 'Ann Open', true, now()) returning id into la;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'ben-unk-' || left(ws::text, 8), 'Ben Unknown') returning id into lb;
  insert into outreach_leads(workspace_id, public_identifier, full_name, is_open_profile) values (ws, 'cat-con-' || left(ws::text, 8), 'Cat Connected', true) returning id into lc;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'dan-rep-' || left(ws::text, 8), 'Dan Replied') returning id into ld;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'eve-man-' || left(ws::text, 8), 'Eve Manual') returning id into le;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'fay-off-' || left(ws::text, 8), 'Fay Off') returning id into lf;
  insert into outreach_leads(workspace_id, public_identifier, full_name, company, location, email_work)
    values (ws, 'gus-full-' || left(ws::text, 8), 'Gus Full', 'Acme', 'Berlin', 'gus-' || left(ws::text, 8) || '@acme.test') returning id into lg;

  -- ============================================================ Fix 2: Open Profile skips the invitation
  g := '{"version":1,"start":"start","nodes":{
      "start":{"id":"start","type":"start","next":"inv","position":{"x":0,"y":0}},
      "inv":{"id":"inv","type":"send_invite","config":{"note":"Hi","open_profile_inmail":true},"next":"wc","branches":{"next":"wc","open_profile":"im"},"position":{"x":0,"y":0}},
      "wc":{"id":"wc","type":"wait_connection","config":{"window_days":14},"branches":{"connected":"m1","no_connect":"e0"},"position":{"x":0,"y":0}},
      "m1":{"id":"m1","type":"send_message","config":{"text":"Thanks {{first_name}}"},"next":"e0","position":{"x":0,"y":0}},
      "im":{"id":"im","type":"send_inmail","config":{"subject":"Hello","text":"Hi {{first_name}}","api":"classic"},"next":"e0","branches":{"no_credit":"e0"},"position":{"x":0,"y":0}},
      "e0":{"id":"e0","type":"end","config":{},"position":{"x":0,"y":0}}}}';
  j := outreach_validate_graph(g, array[s_li], true);
  if jsonb_array_length(j->'errors') = 0 then log := log || E'\nok   1a a graph with the invitation''s open_profile exit validates'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || (j->'errors')::text; end if;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's7 op', 'active', array[s_li], g) returning id into q;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member7@test.local')::text, true);
  select enrolled into n from outreach_enroll_leads(q, array[la, lb], s_li);
  perform set_config('request.jwt.claims', '', true);
  select id into ea from outreach_enrollments where sequence_id = q and lead_id = la;
  select id into eb from outreach_enrollments where sequence_id = q and lead_id = lb;
  if n = 2 and (select current_node_id from outreach_enrollments where id = ea) = 'im'
    then log := log || E'\nok   1b a known Open Profile lead goes straight to the InMail step on entry'; else fails := fails + 1; log := log || E'\nFAIL 1b n=' || n || ' node=' || coalesce((select current_node_id from outreach_enrollments where id = ea), 'null'); end if;
  if not exists (select 1 from outreach_actions where enrollment_id = ea and action_type = 'invite')
     and not exists (select 1 from outreach_planner_demand(s_li, now() + interval '1 day') p where p.enrollment_id = ea and p.action_type = 'invite')
     and exists (select 1 from outreach_planner_demand(s_li, now() + interval '1 day') p where p.enrollment_id = ea and p.action_type = 'inmail')
    then log := log || E'\nok   1c no invitation is queued or planned for it; the planner asks for an InMail'; else fails := fails + 1; log := log || E'\nFAIL 1c'; end if;
  if (select current_node_id from outreach_enrollments where id = eb) = 'inv'
    then log := log || E'\nok   1d a lead of unknown profile type stays on the invitation step'; else fails := fails + 1; log := log || E'\nFAIL 1d'; end if;

  -- the prefetch before the invitation finds an Open Profile: the queued invitation is skipped and the lead moves on
  d := outreach_sender_local_date(s_li, now());
  perform outreach_plan_budgets(s_li, d);
  a_pre := outreach_queue_action(eb, 'inv', 'profile_view', now() - interval '1 minute', '{"prefetch":true,"notify":false}');
  a_inv := outreach_queue_action(eb, 'inv', 'invite', now() + interval '30 minutes', '{"text":"Hi"}');
  perform outreach_reserve_budget(s_li, d, 'profile_view');
  update outreach_actions set status = 'reserved', reserved_at = now() where id = a_pre;
  update outreach_leads set is_open_profile = true, last_profile_fetch_at = now() where id = lb;   -- what the executor's profile read stores
  perform outreach_complete_action(a_pre, '{"is_open_profile":true}');
  if (select current_node_id from outreach_enrollments where id = eb) = 'im'
     and (select status::text || '|' || decision from outreach_actions where id = a_inv) = 'skipped|branch:open_profile'
    then log := log || E'\nok   1e after the prefetch shows an Open Profile, the queued invitation is skipped and the lead is on the InMail step'; else fails := fails + 1; log := log || E'\nFAIL 1e ' || coalesce((select current_node_id from outreach_enrollments where id = eb), 'null') || ' ' || coalesce((select status::text || '|' || decision from outreach_actions where id = a_inv), 'null'); end if;
  if coalesce((select used + reserved from outreach_sender_budgets where sender_id = s_li and day = d and action_type = 'invite'), 0) = 0
    then log := log || E'\nok   1f no invitation allowance was used or held'; else fails := fails + 1; log := log || E'\nFAIL 1f'; end if;
  if outreach_reason_text('open_profile') like 'Open Profile%' then log := log || E'\nok   1g the skipped invitation reads "Open Profile: …"'; else fails := fails + 1; log := log || E'\nFAIL 1g ' || outreach_reason_text('open_profile'); end if;

  -- when not to route
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id)
    values (ws, q, (select head_version from outreach_sequences where id = q), lc, s_li, 'active', 'inv') returning id into ea;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (lc, s_li, 'first') on conflict (lead_id, sender_id) do update set relation = 'first';
  if outreach__open_profile_target(ea, g->'nodes'->'inv') is null then log := log || E'\nok   1h an Open Profile lead who is already a connection keeps the invitation step''s own handling'; else fails := fails + 1; log := log || E'\nFAIL 1h'; end if;
  update outreach_lead_sender_state set relation = 'none' where lead_id = lc and sender_id = s_li;
  if outreach__open_profile_target(ea, (g->'nodes'->'inv') #- '{branches,open_profile}') is null and outreach__open_profile_target(ea, g->'nodes'->'inv') = 'im'
    then log := log || E'\nok   1i without the open_profile exit wired nothing changes (with it: routed)'; else fails := fails + 1; log := log || E'\nFAIL 1i'; end if;
  update outreach_enrollments set sender_id = s_ig where id = ea;
  if outreach__open_profile_target(ea, g->'nodes'->'inv') is null then log := log || E'\nok   1j only LinkedIn senders route'; else fails := fails + 1; log := log || E'\nFAIL 1j'; end if;

  -- InMail has its own ledger row: spending it leaves the invitation and message allowances alone
  if outreach_reserve_budget(s_li, d, 'inmail') then perform outreach_consume_budget(s_li, d, 'inmail'); end if;
  if (select used from outreach_sender_budgets where sender_id = s_li and day = d and action_type = 'inmail') = 1
     and coalesce((select used + reserved from outreach_sender_budgets where sender_id = s_li and day = d and action_type = 'invite'), 0) = 0
     and coalesce((select used + reserved from outreach_sender_budgets where sender_id = s_li and day = d and action_type = 'message'), 0) = 0
    then log := log || E'\nok   2a an InMail spends the inmail row only (not invitations, not messages)'; else fails := fails + 1; log := log || E'\nFAIL 2a'; end if;
  if (select per_day from outreach_platform_ceilings where provider = 'LINKEDIN' and action_type = 'inmail') between 30 and 50
    then log := log || E'\nok   2b InMail ceiling is inside 30–50 a day per sender (' || (select per_day from outreach_platform_ceilings where provider = 'LINKEDIN' and action_type = 'inmail') || ')'; else fails := fails + 1; log := log || E'\nFAIL 2b'; end if;

  -- ============================================================ Fix 1: enrichment on the first reply
  insert into outreach_enrich_queue(lead_id, workspace_id, reason, created_at) values (le, ws, 'manual', now() - interval '2 hours');
  t := outreach_enrich_on_reply(ld, s_li);
  if t = 'queued' and exists (select 1 from outreach_enrich_queue where lead_id = ld and reason = 'reply' and sender_id = s_li)
     and (select enrich_status from outreach_leads where id = ld) = 'waiting'
    then log := log || E'\nok   3a a replying lead with missing details is queued (reason reply, pinned to the sender replied to)'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || coalesce(t, 'null'); end if;
  select x.lead_id into lc from outreach_enrich_next(s_li, 5) x where not x.priority limit 1;
  if lc = ld then log := log || E'\nok   3b reply rows go to the front of the background line'; else fails := fails + 1; log := log || E'\nFAIL 3b first=' || coalesce(lc::text, 'none'); end if;
  if not exists (select 1 from outreach_enrich_next(s_li2, 5) x where x.lead_id = ld) and exists (select 1 from outreach_enrich_next(s_li2, 5) x where x.lead_id = le)
    then log := log || E'\nok   3c for 24 hours only the sender replied to takes it'; else fails := fails + 1; log := log || E'\nFAIL 3c'; end if;
  update outreach_enrich_queue set created_at = now() - interval '25 hours' where lead_id = ld;
  if exists (select 1 from outreach_enrich_next(s_li2, 5) x where x.lead_id = ld) then log := log || E'\nok   3d after 24 hours any sender may take it'; else fails := fails + 1; log := log || E'\nFAIL 3d'; end if;

  insert into outreach_lead_profiles(lead_id, workspace_id, enriched_at) values (lg, ws, now() - interval '200 days');
  if outreach_enrich_on_reply(lg, s_li) = 'complete' then log := log || E'\nok   3e nothing to do for an enriched lead with company, location and work email'; else fails := fails + 1; log := log || E'\nFAIL 3e'; end if;
  insert into outreach_lead_profiles(lead_id, workspace_id, enriched_at) values (la, ws, now());
  if outreach_enrich_on_reply(la, s_li) = 'fresh' then log := log || E'\nok   3f a profile read in the last 24 hours is not read again'; else fails := fails + 1; log := log || E'\nFAIL 3f'; end if;
  if outreach_enrich_on_reply(lf, s_ig) = 'not_linkedin' then log := log || E'\nok   3g only LinkedIn replies trigger it'; else fails := fails + 1; log := log || E'\nFAIL 3g'; end if;
  update outreach_workspaces set settings = settings || '{"enrich_on_reply": false}' where id = ws;
  if outreach_enrich_on_reply(lf, s_li) = 'disabled' and not exists (select 1 from outreach_enrich_queue where lead_id = lf)
    then log := log || E'\nok   3h the workspace setting enrich_on_reply=false turns it off'; else fails := fails + 1; log := log || E'\nFAIL 3h'; end if;
  update outreach_workspaces set settings = settings - 'enrich_on_reply' where id = ws;
  if outreach_enrich_on_reply(lf, s_li) = 'queued' then log := log || E'\nok   3i the setting defaults to on'; else fails := fails + 1; log := log || E'\nFAIL 3i'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member7@test.local')::text, true);
  begin
    perform outreach_enrich_on_reply(ld, s_li);
    fails := fails + 1; log := log || E'\nFAIL 3j a member could call it';
  exception when others then
    if sqlerrm like '%E_FORBIDDEN%' or sqlerrm like '%permission denied%' then log := log || E'\nok   3j service only'; else fails := fails + 1; log := log || E'\nFAIL 3j ' || sqlerrm; end if;
  end;
  perform set_config('request.jwt.claims', '', true);

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
