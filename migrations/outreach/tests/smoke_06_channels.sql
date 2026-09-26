-- Smoke test — Instagram & WhatsApp channels (024–026). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_06_channels.sql
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; u_owner uuid; u_member uuid; u_other uuid;
  s_li uuid; s_ig uuid; s_ig2 uuid; s_wa uuid; s_wa2 uuid;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; l6 uuid; l7 uuid;
  q_wa uuid; q_rc uuid; q_wfr uuid; q_wfb uuid; q_sw uuid;
  e1 uuid; e2 uuid; cid uuid; cid2 uuid; aid uuid; iid uuid;
  j jsonb; t text; n int; n2 int; ok boolean; b boolean; ts timestamptz; d date;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  li_before text; li_after text;
begin
  -- three ACTIVE accounts (the platform admin layer gates outreach_role_in on platform_can_use)
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_other  from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_other is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke6', 'smoke6-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner6@test.local');
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_member, 'member', 'member6@test.local');

  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'LINKEDIN', 'Li Sender', 'ok', 's6li-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_li;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'INSTAGRAM', 'Ig Sender', 'ok', 's6ig-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_ig;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, manual_caps)
    values (ws, 'INSTAGRAM', 'Ig Small', 'ok', 's6ig2-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC', '{"all_metered": 2}') returning id into s_ig2;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'WHATSAPP', 'Wa Sender', 'connecting', 's6wa-' || ws, 2, 90, now() - interval '30 days', sched, 'UTC') returning id into s_wa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone)
    values (ws, 'WHATSAPP', 'Wa New', 'ok', 's6wa2-' || ws, 0, 90, now() - interval '1 day', sched, 'UTC') returning id into s_wa2;

  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'ada-li-' || left(ws::text, 8), 'Ada Li') returning id into l1;
  insert into outreach_leads(workspace_id, full_name) values (ws, 'Bea Both') returning id into l2;
  insert into outreach_leads(workspace_id, full_name, email_work) values (ws, 'Cy None', 'cy-' || left(ws::text, 8) || '@test.local') returning id into l3;
  insert into outreach_leads(workspace_id, full_name, email_work) values (ws, 'Di Wa', 'di-' || left(ws::text, 8) || '@test.local') returning id into l4;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'eve-li-' || left(ws::text, 8), 'Eve LiWa') returning id into l5;
  insert into outreach_leads(workspace_id, full_name, email_work) values (ws, 'Fay Ig', 'fay-' || left(ws::text, 8) || '@test.local') returning id into l6;
  insert into outreach_leads(workspace_id, full_name, email_work) values (ws, 'Gus Ig', 'gus-' || left(ws::text, 8) || '@test.local') returning id into l7;

  -- ------------------------------------------------------------ 1. normalisation (never guesses a country code)
  if outreach_normalize_phone('+91 98765 43210') = '+919876543210' and outreach_normalize_phone('0044 (20) 7946-0958') = '+442079460958'
     and outreach_normalize_phone('9876543210') is null and outreach_normalize_phone('+12') is null
    then log := log || E'\nok   1a phone → E.164; a bare national number is rejected, not guessed'; else fails := fails + 1; log := log || E'\nFAIL 1a'; end if;
  if outreach_normalize_handle('@Ada.Lovelace') = 'ada.lovelace' and outreach_normalize_handle('https://www.instagram.com/ada_l/?hl=en') = 'ada_l' and outreach_normalize_handle('not a handle!') is null
    then log := log || E'\nok   1b Instagram handle normalised (lower case, no @, no URL)'; else fails := fails + 1; log := log || E'\nFAIL 1b'; end if;

  -- ------------------------------------------------------------ 2. identities (as the member)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  begin
    perform outreach_identity_add(l2, 'WHATSAPP', '98765 43210');
    fails := fails + 1; log := log || E'\nFAIL 2a bare number accepted';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID: phone needs a country code%' then log := log || E'\nok   2a phone without a country code refused'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || sqlerrm; end if;
  end;
  perform outreach_identity_add(l2, 'WHATSAPP', '+91 98765 43210');
  perform outreach_identity_add(l2, 'INSTAGRAM', '@bea.both');
  perform outreach_identity_add(l4, 'WHATSAPP', '+44 7700 900001');
  perform outreach_identity_add(l5, 'WHATSAPP', '+44 7700 900002');
  perform outreach_identity_add(l6, 'INSTAGRAM', 'fay.ig', 'operator', true, '1234567');
  perform outreach_identity_add(l7, 'INSTAGRAM', 'gus.ig', 'operator', true, '7654321');
  begin
    perform outreach_identity_add(l3, 'WHATSAPP', '+919876543210');
    fails := fails + 1; log := log || E'\nFAIL 2b the same number accepted on a second lead';
  exception when others then
    if sqlerrm like 'E_IDENTITY_CONFLICT%Bea Both%' then log := log || E'\nok   2b one number, one lead: ' || left(sqlerrm, 60); else fails := fails + 1; log := log || E'\nFAIL 2b ' || sqlerrm; end if;
  end;
  iid := outreach_identity_add(l3, 'INSTAGRAM', 'cy.maybe', 'enrichment', false);
  j := outreach_identity_list(l1);
  if exists (select 1 from jsonb_array_elements(j) x where x->>'provider' = 'LINKEDIN' and x->>'identifier' like 'ada-li-%')
    then log := log || E'\nok   2c identity_list shows the LinkedIn identity of a lead'; else fails := fails + 1; log := log || E'\nFAIL 2c ' || j::text; end if;
  -- as the service: the engine's view
  perform set_config('request.jwt.claims', '', true);
  if (outreach_lead_identity(l2, 'WHATSAPP')->>'identifier') = '+919876543210' and outreach_lead_identity(l3, 'INSTAGRAM') is null and outreach_lead_identity(l3, 'WHATSAPP') is null
    then log := log || E'\nok   2d the engine only uses verified identities (a bio-parsed handle is never used)'; else fails := fails + 1; log := log || E'\nFAIL 2d'; end if;

  -- ------------------------------------------------------------ 3. consent ledger
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  begin
    perform outreach_consent_grant(l2, 'WHATSAPP', 'form_optin', '{}');
    fails := fails + 1; log := log || E'\nFAIL 3a form opt-in without evidence accepted';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID: evidence required%' then log := log || E'\nok   3a a form opt-in needs evidence'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || sqlerrm; end if;
  end;
  cid := outreach_consent_grant(l4, 'WHATSAPP', 'explicit_share', '{"note":"shared on a call"}', now() - interval '2 days', now() - interval '1 day');
  b := outreach_lead_has_consent(l4, 'WHATSAPP');
  cid := outreach_consent_grant(l4, 'WHATSAPP', 'explicit_share', '{"message_id":"m-1"}');
  if not b and outreach_lead_has_consent(l4, 'WHATSAPP') and (select count(*) from outreach_lead_consent where lead_id = l4 and revoked_at is null) = 1
     and (select attested_by from outreach_lead_consent where id = cid) = u_member
    then log := log || E'\nok   3b expired consent does not count; a new grant replaces the old row and records who attested'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  j := outreach_consent_list(ws, l4, null, null, true, 1);
  if jsonb_array_length(j) = 1 and j->0->>'id' = cid::text then log := log || E'\nok   3c consent_list honours the limit and orders newest first'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || j::text; end if;
  perform outreach_consent_revoke(cid, 'asked by phone');
  if not outreach_lead_has_consent(l4, 'WHATSAPP') then log := log || E'\nok   3d revoked consent no longer counts'; else fails := fails + 1; log := log || E'\nFAIL 3d'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_other, 'role', 'authenticated', 'email', 'other6@test.local')::text, true);
  begin
    perform outreach_consent_list(ws);
    fails := fails + 1; log := log || E'\nFAIL 3e an outsider read the consent ledger';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   3e an outsider cannot read the consent ledger'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || sqlerrm; end if;
  end;
  begin
    perform outreach_identity_add(l1, 'WHATSAPP', '+15550001111');
    fails := fails + 1; log := log || E'\nFAIL 3f an outsider added an identity';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   3f an outsider cannot add identities'; else fails := fails + 1; log := log || E'\nFAIL 3f ' || sqlerrm; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  begin
    perform outreach_consent_grant_system(l2, 'WHATSAPP', 'inbound', '{}');
    fails := fails + 1; log := log || E'\nFAIL 3g a member used the service-only consent path';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   3g the inbound consent path is service-only'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || sqlerrm; end if;
  end;

  -- ------------------------------------------------------------ 4. LinkedIn regression: caps and ledger unchanged
  perform set_config('request.jwt.claims', '', true);
  d := outreach_sender_local_date(s_li, now());
  if outreach_effective_cap(s_li, 'invite') = 15 and outreach_effective_cap(s_li, 'message') = 20 and outreach_effective_cap(s_li, 'new_chat') = 20 and outreach_effective_cap(s_li, 'profile_view') = 30
     and outreach_effective_total_cap(s_li) is null and outreach_sender_min_gap(s_li) = 0
    then log := log || E'\nok   4a LinkedIn level-2 caps unchanged (invite 15, message 20); new_chat = message; no total cap; no execution-time gap'; else fails := fails + 1; log := log || E'\nFAIL 4a'; end if;
  ok := outreach_reserve_budget(s_li, d, 'invite');
  perform outreach_consume_budget(s_li, d, 'invite');
  if ok and (select used from outreach_sender_budgets where sender_id = s_li and day = d and action_type = 'invite') = 1
     and not exists (select 1 from outreach_sender_budgets_scoped where sender_id = s_li)
    then log := log || E'\nok   4b LinkedIn reserve/consume uses only the daily rows (no scoped ledger)'; else fails := fails + 1; log := log || E'\nFAIL 4b'; end if;

  -- ------------------------------------------------------------ 5. Instagram hourly + daily ledger
  if outreach_effective_cap(s_ig, 'new_chat') = 8 and outreach_effective_cap(s_ig, 'follow') = 15 and outreach_effective_total_cap(s_ig) = 50 and outreach_sender_min_gap(s_ig) = 60
    then log := log || E'\nok   5a Instagram level-2 caps from the Instagram table (new chats 8, follows 15, 50 actions a day, 60 s gap)'; else fails := fails + 1; log := log || E'\nFAIL 5a'; end if;
  ts := date_trunc('hour', now()) + interval '5 minutes';
  n := 0;
  for i in 1..10 loop if outreach_reserve_budget(s_ig, d, 'like', ts) then n := n + 1; end if; end loop;
  t := outreach__reserve_why(s_ig, d, 'like', ts);
  if n = 10 and t = 'hour' and (select reserved from outreach_sender_budgets where sender_id = s_ig and day = d and action_type = 'like') = 10
     and (select reserved from outreach_sender_budgets_scoped where sender_id = s_ig and "window" = 'hour' and window_start = date_trunc('hour', ts)) = 10
     and (select reserved from outreach_sender_budgets_scoped where sender_id = s_ig and "window" = 'day') = 10
    then log := log || E'\nok   5b 10 actions an hour: the 11th fails on the hour and gives the daily allowances back'; else fails := fails + 1; log := log || E'\nFAIL 5b n=' || n || ' why=' || coalesce(t,'null'); end if;
  if outreach_reserve_budget(s_ig, d, 'like', ts + interval '1 hour') then log := log || E'\nok   5c the next hour has room again'; else fails := fails + 1; log := log || E'\nFAIL 5c'; end if;
  ok := outreach_reserve_budget(s_ig2, d, 'follow', ts);
  b := outreach_reserve_budget(s_ig2, d, 'like', ts + interval '1 hour');
  t := outreach__reserve_why(s_ig2, d, 'profile_view', ts + interval '2 hours');
  if ok and b and t = 'day_scope' then log := log || E'\nok   5d the daily all-actions total binds across action types (manual total 2)'; else fails := fails + 1; log := log || E'\nFAIL 5d why=' || coalesce(t,'null'); end if;
  perform outreach_consume_budget(s_ig, d, 'like', ts);
  if (select used from outreach_sender_budgets_scoped where sender_id = s_ig and "window" = 'hour' and window_start = date_trunc('hour', ts)) = 1
    then log := log || E'\nok   5e consume moves the hour row from reserved to used'; else fails := fails + 1; log := log || E'\nFAIL 5e'; end if;
  if outreach_reserve_budget(s_ig, d, 'reply', ts) then log := log || E'\nok   5f replies are never metered by the hour'; else fails := fails + 1; log := log || E'\nFAIL 5f'; end if;

  -- ------------------------------------------------------------ 6. WhatsApp quiet period + claim rules
  update outreach_senders set status = 'ok' where id = s_wa;
  select outreach_allowed_from into ts from outreach_senders where id = s_wa;
  if ts between now() + interval '23 hours 59 minutes' and now() + interval '24 hours 1 minute'
     and exists (select 1 from outreach_sender_events where sender_id = s_wa and kind = 'quiet_period')
    then log := log || E'\nok   6a connecting → ok opens a 24-hour quiet period'; else fails := fails + 1; log := log || E'\nFAIL 6a ' || coalesce(ts::text,'null'); end if;
  if outreach_effective_cap(s_wa2, 'new_chat') = 2 and outreach_effective_cap(s_wa, 'new_chat') = 10 and outreach_effective_cap(s_wa, 'message') = 100
    then log := log || E'\nok   6b WhatsApp new chats by governor level (level 0: 2, level 2: 10); messages 100'; else fails := fails + 1; log := log || E'\nFAIL 6b'; end if;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, idempotency_key) values (ws, s_wa, l2, 'new_chat', now() - interval '1 minute', 's6-nc-' || ws) returning id into aid;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, idempotency_key) values (ws, s_wa, l2, 'identifier_check', now() - interval '30 seconds', 's6-ic-' || ws);
  select count(*) filter (where c.action_type = 'identifier_check'), count(*) filter (where c.action_type = 'new_chat') into n, n2 from outreach_claim_due_actions(500) c where c.sender_id = s_wa;
  if n = 1 and (select status from outreach_actions where id = aid) = 'queued'
    then log := log || E'\nok   6c in the quiet period the number check runs, the new chat waits'; else fails := fails + 1; log := log || E'\nFAIL 6c'; end if;
  update outreach_actions set status = 'sent', executed_at = now() where sender_id = s_wa and action_type = 'identifier_check' and status = 'reserved';
  update outreach_senders set outreach_allowed_from = now() - interval '1 minute' where id = s_wa;
  select count(*) into n from outreach_claim_due_actions(500) c where c.sender_id = s_wa;
  if n = 0 and (select status from outreach_actions where id = aid) = 'queued'
    then log := log || E'\nok   6d after the quiet period the 10-second gap still holds the new chat back'; else fails := fails + 1; log := log || E'\nFAIL 6d n=' || n; end if;
  update outreach_actions set executed_at = now() - interval '1 minute' where sender_id = s_wa and action_type = 'identifier_check';
  select count(*) into n from outreach_claim_due_actions(500) c where c.sender_id = s_wa and c.id = aid;
  if n = 1 then log := log || E'\nok   6e once the gap has passed the new chat is claimed'; else fails := fails + 1; log := log || E'\nFAIL 6e'; end if;
  perform outreach_fail_action(aid, 'test', 'cancel', null, null);
  if (select reserved from outreach_sender_budgets where sender_id = s_wa and day = d and action_type = 'new_chat') = 0
    then log := log || E'\nok   6f a cancelled claim gives the allowance back'; else fails := fails + 1; log := log || E'\nFAIL 6f'; end if;

  -- ------------------------------------------------------------ 7. enrolment: identity and consent decide eligibility; the planner spends new_chat
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's6 wa', 'active', array[s_wa],
    '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"rc","position":{"x":0,"y":0}},
      "rc":{"id":"rc","type":"require_consent","config":{"bases":[]},"branches":{"has_consent":"m1","no_consent":"e0"},"position":{"x":0,"y":0}},
      "m1":{"id":"m1","type":"send_message","config":{"text":"Hi {{first_name}}","new_chat_allowed":true},"next":"e0","position":{"x":0,"y":0}},
      "e0":{"id":"e0","type":"end","config":{},"position":{"x":0,"y":0}}}}') returning id into q_wa;
  if (select sender_pools from outreach_sequences where id = q_wa) = jsonb_build_object('WHATSAPP', jsonb_build_array(s_wa))
    then log := log || E'\nok   7a sender_pools is kept per channel by the trigger'; else fails := fails + 1; log := log || E'\nFAIL 7a ' || (select sender_pools from outreach_sequences where id = q_wa)::text; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  j := outreach_enroll_preview(q_wa, array[l2, l3]);
  if (j->>'eligible')::int = 0 and (j->'excluded'->'no_consent'->>'count')::int = 1 and (j->'excluded'->'no_identity'->>'count')::int = 1
    then log := log || E'\nok   7b preview: no WhatsApp number → no_identity; no recorded consent → no_consent'; else fails := fails + 1; log := log || E'\nFAIL 7b ' || (j->'excluded')::text; end if;
  perform outreach_consent_grant(l2, 'WHATSAPP', 'linkedin_reply', '{"message_id":"li-9"}');
  select enrolled into n from outreach_enroll_leads(q_wa, array[l2]);
  select id into e1 from outreach_enrollments where sequence_id = q_wa and lead_id = l2;
  perform set_config('request.jwt.claims', '', true);
  if n = 1 and (select current_channel from outreach_enrollments where id = e1) = 'WHATSAPP' and (select current_node_id from outreach_enrollments where id = e1) = 'm1'
    then log := log || E'\nok   7c with consent the lead is enrolled on WhatsApp and passes “Check consent”'; else fails := fails + 1; log := log || E'\nFAIL 7c n=' || n; end if;
  select action_type::text into t from outreach_planner_demand(s_wa, now() + interval '1 day') p where p.enrollment_id = e1;
  if t = 'new_chat' then log := log || E'\nok   7d no chat yet → the planner spends a new_chat, not a message'; else fails := fails + 1; log := log || E'\nFAIL 7d ' || coalesce(t,'no row'); end if;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider) values (ws, s_wa, l2, 's6chat-' || ws, 'WHATSAPP');
  update outreach_lead_sender_state set unipile_chat_id = 's6chat-' || ws where lead_id = l2 and sender_id = s_wa;
  select action_type::text into t from outreach_planner_demand(s_wa, now() + interval '1 day') p where p.enrollment_id = e1;
  if t = 'message' then log := log || E'\nok   7e with a chat the same step is a message'; else fails := fails + 1; log := log || E'\nFAIL 7e ' || coalesce(t,'no row'); end if;
  delete from outreach_chats where sender_id = s_wa and lead_id = l2;
  update outreach_lead_sender_state set unipile_chat_id = null where lead_id = l2 and sender_id = s_wa;
  update outreach_senders set outreach_allowed_from = now() + interval '5 hours' where id = s_wa;
  select count(*) into n from outreach_planner_demand(s_wa, now() + interval '1 day') p where p.enrollment_id = e1;
  update outreach_senders set outreach_allowed_from = null where id = s_wa;
  if n = 0 then log := log || E'\nok   7f nothing is planned inside the quiet period'; else fails := fails + 1; log := log || E'\nFAIL 7f'; end if;
  update outreach_lead_consent set revoked_at = now(), revoked_reason = 'test' where lead_id = l2 and channel = 'WHATSAPP';
  select count(*) into n from outreach_planner_demand(s_wa, now() + interval '1 day') p where p.enrollment_id = e1;
  if n = 0 then log := log || E'\nok   7g no consent at planning time → no new chat is planned'; else fails := fails + 1; log := log || E'\nFAIL 7g'; end if;
  update outreach_lead_consent set revoked_at = null, revoked_reason = null where lead_id = l2 and channel = 'WHATSAPP' and revoked_reason = 'test';
  -- a revoke through the RPC exits the lead on that channel
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  select id into cid from outreach_lead_consent where lead_id = l2 and channel = 'WHATSAPP' and revoked_at is null;
  perform outreach_consent_revoke(cid, 'asked');
  perform set_config('request.jwt.claims', '', true);
  if (select status::text || ':' || coalesce(exit_reason,'') from outreach_enrollments where id = e1) = 'exited_suppressed:consent_revoked'
    then log := log || E'\nok   7h revoking consent exits the WhatsApp enrollment'; else fails := fails + 1; log := log || E'\nFAIL 7h ' || (select status::text || ':' || coalesce(exit_reason,'') from outreach_enrollments where id = e1); end if;

  -- ------------------------------------------------------------ 8. require_consent branches (a graph without a message needs no consent to enrol)
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's6 rc', 'active', array[s_wa],
    '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"rc","position":{"x":0,"y":0}},
      "rc":{"id":"rc","type":"require_consent","config":{"bases":["explicit_share"]},"branches":{"has_consent":"ey","no_consent":"en"},"position":{"x":0,"y":0}},
      "ey":{"id":"ey","type":"end","config":{"reason":"yes"},"position":{"x":0,"y":0}},
      "en":{"id":"en","type":"end","config":{"reason":"no"},"position":{"x":0,"y":0}}}}') returning id into q_rc;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_consent_grant(l5, 'WHATSAPP', 'imported_attested', '{"imported_from":"list.csv"}');
  perform outreach_enroll_leads(q_rc, array[l4, l5]);
  perform set_config('request.jwt.claims', '', true);
  if (select exit_reason from outreach_enrollments where sequence_id = q_rc and lead_id = l4) = 'no' and (select exit_reason from outreach_enrollments where sequence_id = q_rc and lead_id = l5) = 'no'
    then log := log || E'\nok   8a no consent → no_consent; a basis outside the accepted list → no_consent'; else fails := fails + 1; log := log || E'\nFAIL 8a'; end if;
  update outreach_lead_consent set basis = 'explicit_share' where lead_id = l5 and channel = 'WHATSAPP' and revoked_at is null;
  delete from outreach_enrollments where sequence_id = q_rc and lead_id = l5;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_enroll_leads(q_rc, array[l5], null, 100, true);
  perform set_config('request.jwt.claims', '', true);
  if (select exit_reason from outreach_enrollments where sequence_id = q_rc and lead_id = l5) = 'yes'
    then log := log || E'\nok   8b an accepted basis → has_consent'; else fails := fails + 1; log := log || E'\nFAIL 8b ' || coalesce((select exit_reason from outreach_enrollments where sequence_id = q_rc and lead_id = l5), 'null'); end if;

  -- ------------------------------------------------------------ 9. wait_for_reply: a reply advances (not exits); the window takes no_reply
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's6 wfr', 'active', array[s_ig],
    '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"w","position":{"x":0,"y":0}},
      "w":{"id":"w","type":"wait_for_reply","config":{"window_hours":96},"branches":{"replied":"er","no_reply":"en"},"position":{"x":0,"y":0}},
      "er":{"id":"er","type":"end","config":{"reason":"replied_branch"},"position":{"x":0,"y":0}},
      "en":{"id":"en","type":"end","config":{"reason":"no_reply_branch"},"position":{"x":0,"y":0}}}}') returning id into q_wfr;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_enroll_leads(q_wfr, array[l6, l7], null, 100, true);
  perform set_config('request.jwt.claims', '', true);
  if (select count(*) from outreach_enrollments where sequence_id = q_wfr and status = 'waiting_delay') = 2
    then log := log || E'\nok   9a both leads wait for a reply'; else fails := fails + 1; log := log || E'\nFAIL 9a'; end if;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l6 and sender_id = s_ig;
  if (select status::text || ':' || coalesce(exit_reason,'') from outreach_enrollments where sequence_id = q_wfr and lead_id = l6) = 'completed:replied_branch'
    then log := log || E'\nok   9b a reply takes the “replied” branch instead of exiting the lead'; else fails := fails + 1; log := log || E'\nFAIL 9b ' || (select status::text || ':' || coalesce(exit_reason,'') from outreach_enrollments where sequence_id = q_wfr and lead_id = l6); end if;
  update outreach_enrollments set wait_until = now() - interval '1 minute' where sequence_id = q_wfr and lead_id = l7;
  perform outreach_release_waits();
  if (select exit_reason from outreach_enrollments where sequence_id = q_wfr and lead_id = l7) = 'no_reply_branch'
    then log := log || E'\nok   9c the window closing takes “no reply”'; else fails := fails + 1; log := log || E'\nFAIL 9c'; end if;

  -- ------------------------------------------------------------ 10. wait_follow_back
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's6 wfb', 'active', array[s_ig],
    '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"w","position":{"x":0,"y":0}},
      "w":{"id":"w","type":"wait_follow_back","config":{"window_days":5,"poll_budget":2},"branches":{"followed_back":"ef","no_follow_back":"en"},"position":{"x":0,"y":0}},
      "ef":{"id":"ef","type":"end","config":{"reason":"fb"},"position":{"x":0,"y":0}},
      "en":{"id":"en","type":"end","config":{"reason":"nfb"},"position":{"x":0,"y":0}}}}') returning id into q_wfb;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_enroll_leads(q_wfb, array[l6, l7], null, 100, true);
  perform set_config('request.jwt.claims', '', true);
  update outreach_lead_sender_state set relation = 'first' where lead_id = l6 and sender_id = s_ig;
  update outreach_enrollments set wait_until = now() - interval '1 minute' where sequence_id = q_wfb and lead_id = l7;
  perform outreach_release_waits();
  if (select exit_reason from outreach_enrollments where sequence_id = q_wfb and lead_id = l6) = 'fb' and (select exit_reason from outreach_enrollments where sequence_id = q_wfb and lead_id = l7) = 'nfb'
    then log := log || E'\nok   10 a follow-back takes “followed back”; the window closing takes “no follow-back”'; else fails := fails + 1; log := log || E'\nFAIL 10'; end if;

  -- ------------------------------------------------------------ 11. channel_switch
  insert into outreach_sequences(workspace_id, name, status, sender_pool, graph) values (ws, 's6 switch', 'active', array[s_li, s_wa2],
    '{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"sw","position":{"x":0,"y":0}},
      "sw":{"id":"sw","type":"channel_switch","config":{"to_channel":"WHATSAPP","require_identity":true},"next":"es","branches":{"unavailable":"eu"},"position":{"x":0,"y":0}},
      "es":{"id":"es","type":"end","config":{"reason":"switched"},"position":{"x":0,"y":0}},
      "eu":{"id":"eu","type":"end","config":{"reason":"unavailable"},"position":{"x":0,"y":0}}}}') returning id into q_sw;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_enroll_leads(q_sw, array[l1, l5], s_li, 100, true);
  perform set_config('request.jwt.claims', '', true);
  if (select exit_reason from outreach_enrollments where sequence_id = q_sw and lead_id = l1) = 'unavailable'
     and (select exit_reason || ':' || sender_id::text || ':' || current_channel::text || ':' || (channel_sender_map->>'WHATSAPP') from outreach_enrollments where sequence_id = q_sw and lead_id = l5)
         = 'switched:' || s_wa2 || ':WHATSAPP:' || s_wa2
    then log := log || E'\nok   11 no WhatsApp number → “unavailable”; number + consent + a free number in the pool → switched to it'; else fails := fails + 1; log := log || E'\nFAIL 11'; end if;

  -- ------------------------------------------------------------ 12. validator
  j := outreach_validate_graph('{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
      "m1":{"id":"m1","type":"send_message","config":{"text":"Hi","new_chat_allowed":true},"next":"e0","position":{"x":0,"y":0}},
      "e0":{"id":"e0","type":"end","config":{},"position":{"x":0,"y":0}}}}', array[s_wa], true);
  if exists (select 1 from jsonb_array_elements(j->'errors') x where x->>'code' = 'E_NO_CONSENT_GUARD')
    then log := log || E'\nok   12a a WhatsApp message with no consent check is refused'; else fails := fails + 1; log := log || E'\nFAIL 12a ' || j::text; end if;
  j := outreach_validate_graph('{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
      "m1":{"id":"m1","type":"send_message","config":{"text":"Hi","new_chat_allowed":true},"next":"lk","position":{"x":0,"y":0}},
      "lk":{"id":"lk","type":"like_recent_posts","config":{"count":4},"next":"e0","position":{"x":0,"y":0}},
      "e0":{"id":"e0","type":"end","config":{},"position":{"x":0,"y":0}}}}', array[s_ig], true);
  if exists (select 1 from jsonb_array_elements(j->'errors') x where x->>'code' = 'E_LIKE_COUNT') and exists (select 1 from jsonb_array_elements(j->'warnings') x where x->>'code' = 'W_IG_DM_FIRST')
     and not exists (select 1 from jsonb_array_elements(j->'errors') x where x->>'code' = 'E_RELATION_REQUIRED')
    then log := log || E'\nok   12b Instagram: more than 3 likes refused, a message first warned, no LinkedIn connection rule'; else fails := fails + 1; log := log || E'\nFAIL 12b ' || j::text; end if;
  j := outreach_validate_graph((select graph from outreach_sequences where id = q_wa), array[s_wa], true);
  if not exists (select 1 from jsonb_array_elements(j->'errors') x where x->>'code' = 'E_NO_CONSENT_GUARD')
    then log := log || E'\nok   12c with “Check consent” above it the WhatsApp message passes'; else fails := fails + 1; log := log || E'\nFAIL 12c ' || j::text; end if;
  j := outreach_validate_graph('{"version":1,"start":"start","nodes":{"start":{"id":"start","type":"start","next":"f","position":{"x":0,"y":0}},
      "f":{"id":"f","type":"follow","config":{},"next":"e0","position":{"x":0,"y":0}},
      "e0":{"id":"e0","type":"end","config":{},"position":{"x":0,"y":0}}}}', array[s_li], true);
  if exists (select 1 from jsonb_array_elements(j->'errors') x where x->>'code' = 'E_NO_CHANNEL_SENDER')
    then log := log || E'\nok   12d an Instagram step with no Instagram account in the pool is refused'; else fails := fails + 1; log := log || E'\nFAIL 12d ' || j::text; end if;

  -- ------------------------------------------------------------ 13. blocks, provider warning, governor, attestation
  perform outreach_record_block(s_wa, l2, '422:blocked_recipient', null);
  if (select warmup_level from outreach_senders where id = s_wa) = 1 and (select relation from outreach_lead_sender_state where lead_id = l2 and sender_id = s_wa) = 'blocked'
     and exists (select 1 from outreach_sender_events where sender_id = s_wa and kind = 'block')
    then log := log || E'\nok   13a a WhatsApp block demotes one level at once and marks the lead blocked'; else fails := fails + 1; log := log || E'\nFAIL 13a'; end if;
  j := outreach_wa_governor(s_wa2);
  if (j->>'level_after')::int = 0 and j->>'reason' like 'Level 1 needs%not attested%'
    then log := log || E'\nok   13b the governor never promotes an unattested number past level 0'; else fails := fails + 1; log := log || E'\nFAIL 13b ' || j::text; end if;
  perform outreach_sender_provider_warning(s_ig, 'We suspect automated behavior on your account');
  if (select warmup_level from outreach_senders where id = s_ig) = 1 and (select paused_until from outreach_senders where id = s_ig) > now() + interval '47 hours'
     and (select provider_warning->>'text' from outreach_senders where id = s_ig) = 'We suspect automated behavior on your account'
    then log := log || E'\nok   13c an Instagram warning: one level down, 48 h pause, text kept verbatim'; else fails := fails + 1; log := log || E'\nFAIL 13c'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner6@test.local')::text, true);
  begin
    perform outreach_sender_attest_account_age(s_wa2, 3);
    fails := fails + 1; log := log || E'\nFAIL 13d a 3-month-old number attested';
  exception when others then
    if sqlerrm like 'E_ACCOUNT_TOO_NEW%' then log := log || E'\nok   13d numbers under 6 months are refused'; else fails := fails + 1; log := log || E'\nFAIL 13d ' || sqlerrm; end if;
  end;
  perform outreach_sender_attest_account_age(s_wa2, 18);
  perform outreach_sender_resume_after_warning(s_ig);
  perform set_config('request.jwt.claims', '', true);
  if (select account_age_months from outreach_senders where id = s_wa2) = 18 and (select paused_until from outreach_senders where id = s_ig) is null
    then log := log || E'\nok   13e a manager attests the number age and can resume after a warning'; else fails := fails + 1; log := log || E'\nFAIL 13e'; end if;

  -- ------------------------------------------------------------ 14. stop request, consent report
  perform outreach_consent_revoke_stop(l5, 'WHATSAPP', null);
  if exists (select 1 from outreach_suppressions where workspace_id = ws and kind = 'phone' and value = '+447700900002') and not outreach_lead_has_consent(l5, 'WHATSAPP')
    then log := log || E'\nok   14a STOP revokes consent and blacklists the number'; else fails := fails + 1; log := log || E'\nFAIL 14a'; end if;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  perform outreach_consent_grant(l4, 'WHATSAPP', 'imported_attested', '{"imported_from":"a.csv"}');
  perform outreach_consent_grant(l2, 'WHATSAPP', 'inbound', '{"chat_id":"c"}');
  perform set_config('request.jwt.claims', '', true);
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, executed_at, idempotency_key) values
    (ws, s_wa, l4, 'new_chat', now(), 'sent', now(), 's6-r1-' || ws), (ws, s_wa, l2, 'new_chat', now(), 'sent', now(), 's6-r2-' || ws);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member6@test.local')::text, true);
  j := outreach_consent_report(ws);
  if (j->>'contacted')::int = 2 and (j->>'imported_attested_share_pct')::numeric = 50 and (j->>'alert')::boolean
    then log := log || E'\nok   14b consent report: 2 contacted, half on attestation → amber alert above 30%'; else fails := fails + 1; log := log || E'\nFAIL 14b ' || j::text; end if;
  j := outreach_channel_capacity(ws);
  if exists (select 1 from jsonb_array_elements(j) x where x->>'provider' = 'INSTAGRAM' and (x->'hour'->>'cap')::int = 10)
    then log := log || E'\nok   14c channel_capacity shows the Instagram hourly cap'; else fails := fails + 1; log := log || E'\nFAIL 14c ' || j::text; end if;
  j := outreach_report_channels(ws);
  if exists (select 1 from jsonb_array_elements(j->'rows') x where x->>'channel' = 'whatsapp' and (x->>'new_chats')::int >= 2)
    then log := log || E'\nok   14d the channel report counts WhatsApp new chats'; else fails := fails + 1; log := log || E'\nFAIL 14d ' || j::text; end if;
  perform set_config('request.jwt.claims', '', true);

  if fails > 0 then raise exception 'SMOKE FAIL (%): %', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
