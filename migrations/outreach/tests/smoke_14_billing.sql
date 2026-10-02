-- Smoke test — 056–060 billing v2 (pricing-billing-PRD.md). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_14_billing.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; k jsonb; t text; n int; b boolean; r record;
  ws uuid; ws2 uuid; ws3 uuid; u_owner uuid; u_member uuid; u_viewer uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; q1 uuid; l1 uuid; e1 uuid; rid uuid; rid2 uuid; ib uuid;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  plans text[] := array['launch','scale','enterprise']; periods text[] := array['monthly','quarterly','annual']; p text; per text; prev numeric; bad text := '';
  expect jsonb := '{
    "launch":     {"monthly": "4,8,9,18,19,44-49,73-99",  "quarterly": "4,8,9,18,19,44-49,70-99", "annual": "4,8,9,18,19,45-49,73-99"},
    "scale":      {"monthly": "4,9,18,19,43-49,67-99",    "quarterly": "4,9,18,19,43-49,67-99",   "annual": "4,9,18,19,43-49,67-99"},
    "enterprise": {"monthly": "4,8,9,19,40-49,75-99",     "quarterly": "4,9,18,19,40-49,75-99",   "annual": "4,8,9,19,40-49,75-99"}}';
  rounded text; a int; z int; part text;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  -- ============================================================ 1. price book and the best-price rule (PRD §1.2, §2)
  j := outreach_quote_accounts('launch', 'monthly', 8);
  if (j->>'billed')::int = 10 and (j->>'period_total')::numeric = 290 and (j->>'requested_total')::numeric = 312 and (j->>'best_price')::boolean and j->>'lookup_key' = 'launch_monthly_v1'
    then log := log || E'\nok   quote: 8 accounts on Launch monthly are billed as 10 for $290 (8 would cost $312)';
    else fails := fails + 1; log := log || E'\nFAIL quote 8: ' || j::text; end if;
  if (outreach_quote_accounts('launch','annual',20)->>'period_total')::numeric = 4800 and (outreach_quote_accounts('scale','monthly',10)->>'period_total')::numeric = 400
     and (outreach_quote_accounts('launch','monthly',7)->>'period_total')::numeric = 273 and (outreach_quote_accounts('launch','monthly',150)->>'period_total')::numeric = 2400
     and (select count(*) from outreach_price_book where version = 'v1') = 54
    then log := log || E'\nok   quote: PRD examples (annual 20 = $4,800, Scale 10 = $400, 7 = $273, 150 at the 100+ price), 54 prices seeded';
    else fails := fails + 1; log := log || E'\nFAIL quote examples'; end if;
  -- the full §2 table, and a bigger count never costs less
  foreach p in array plans loop foreach per in array periods loop
    rounded := ''; prev := 0;
    for n in 1..100 loop
      j := outreach_quote_accounts(p, per, n);
      if (j->>'period_total')::numeric < prev then bad := bad || format(' %s/%s: %s costs less than %s;', p, per, n, n - 1); end if;
      prev := (j->>'period_total')::numeric;
      b := false;
      foreach part in array string_to_array(expect->p->>per, ',') loop
        a := split_part(part, '-', 1)::int; z := coalesce(nullif(split_part(part, '-', 2), '')::int, a);
        if n between a and z then b := true; end if;
      end loop;
      if b is distinct from (j->>'best_price')::boolean then bad := bad || format(' %s/%s/%s best_price=%s;', p, per, n, j->>'best_price'); end if;
    end loop;
  end loop; end loop;
  if bad = '' then log := log || E'\nok   quote: every best-price range of PRD §2 matches for 9 plan × period pairs; totals never fall as the count rises';
  else fails := fails + 1; log := log || E'\nFAIL best-price table:' || left(bad, 600); end if;

  -- ============================================================ 2. plans renamed; owners cannot write billing columns
  begin insert into outreach_workspaces(name, slug, created_by, plan) values ('x', 'smoke14-x-' || encode(gen_random_bytes(4),'hex'), u_owner, 'agency'); t := 'accepted';
  exception when check_violation then t := 'refused'; end;
  insert into outreach_workspaces(name, slug, created_by) values ('smoke14', 'smoke14-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner14@test.local');
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_member, 'member', 'member14@test.local');
  select * into r from outreach_workspaces where id = ws;
  if t = 'refused' and r.plan = 'trial' and r.trial_account_limit = 1 and r.trial_ends_at between now() + interval '6 days 23 hours' and now() + interval '7 days 1 hour'
    then log := log || E'\nok   plans: old plan names are refused; a new workspace starts a 7-day trial with 1 account';
    else fails := fails + 1; log := log || E'\nFAIL plans: old name ' || t || ', plan ' || r.plan || ', trial ends ' || r.trial_ends_at; end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin update outreach_workspaces set plan = 'enterprise', accounts_billed = 100 where id = ws; t := 'updated'; exception when insufficient_privilege then t := 'denied'; end;
  begin update outreach_workspaces set name = 'smoke14 renamed' where id = ws; t := t || ', name ok'; exception when others then t := t || ', name ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'denied, name ok' and (select plan from outreach_workspaces where id = ws) = 'trial'
    then log := log || E'\nok   an owner cannot set the plan or the account count through the table; the name still saves';
    else fails := fails + 1; log := log || E'\nFAIL owner column lock: ' || t; end if;

  -- ============================================================ 3. billing not enforced: nothing is limited
  update outreach_flags set value = 'false'::jsonb where key = 'billing_enforced';
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email, auth_method)
    values (ws, 'LINKEDIN', 'First', 'ok', 's14a-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', u_owner, 'owner14@test.local', 'credentials') returning id into s1;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_email)
    values (ws, 'LINKEDIN', 'Second', 'ok', 's14b-' || ws, 3, 95, now() - interval '30 days', sched, 'UTC', 'two14@test.local') returning id into s2;
  j := outreach__slots(ws);
  if j->>'billed' is null and (j->>'used')::int = 2 and j->>'available' is null and outreach_has_feature(ws, 'webhooks') and outreach_plan_limit(ws, 'webchat_inboxes') is null
     and outreach_slot_reserve(ws, 'hosted_auth', null) is null
    then log := log || E'\nok   switch off: no account limit (2 connected on a trial), every feature on, no reservation needed';
    else fails := fails + 1; log := log || E'\nFAIL switch off: ' || j::text; end if;

  -- ============================================================ 4. enforced: the trial has one account
  update outreach_flags set value = 'true'::jsonb where key = 'billing_enforced';
  update outreach_senders set status = 'disabled' where id = s2;                       -- frees its account
  j := outreach__slots(ws);
  begin perform outreach_slot_reserve(ws, 'hosted_auth', null); t := 'reserved'; exception when others then t := sqlerrm; end;
  if (j->>'billed')::int = 1 and (j->>'used')::int = 1 and (j->>'available')::int = 0 and t like 'E_ACCOUNT_LIMIT: Your trial includes 1 account%'
    then log := log || E'\nok   trial: 1 of 1 used; a second sign-in link is refused with E_ACCOUNT_LIMIT';
    else fails := fails + 1; log := log || E'\nFAIL trial limit: ' || j::text || ' / ' || t; end if;
  begin
    insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, timezone) values (ws, 'GMAIL', 'Mailbox', 'ok', 's14m-' || ws, 'UTC');
    t := 'inserted';
  exception when others then t := sqlerrm; end;
  begin update outreach_senders set status = 'ok' where id = s2; t := t || ' | re-enabled'; exception when others then t := t || ' | ' || sqlerrm; end;
  -- a website chat inbox is a synthetic sender and never counts
  insert into outreach_senders(workspace_id, provider, auth_method, display_name, status, timezone) values (ws, 'WEBCHAT', 'oauth', 'Site', 'ok', 'UTC');
  if t like 'E_ACCOUNT_LIMIT:%| E_ACCOUNT_LIMIT:%' and (outreach__slots(ws)->>'used')::int = 1
    then log := log || E'\nok   guard trigger: a second connected account and re-enabling a disabled one are both refused; a website inbox does not count';
    else fails := fails + 1; log := log || E'\nFAIL guard: ' || t; end if;

  -- ============================================================ 5. subscription (Scale, 3 accounts): limit, reservations, features
  j := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'customer_id', 'cus_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly',
        'accounts_billed', 3, 'accounts_requested', 3, 'current_period_start', now(), 'current_period_end', now() + interval '30 days', 'cancel_at_period_end', false, 'price_version', 'v1'));
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'scale' and r.accounts_billed = 3 and r.billing_period = 'monthly' and r.stripe_status = 'active' and r.stripe_subscription_id = 'sub_smoke14' and outreach_feature_plan(ws) = 'scale'
    then log := log || E'\nok   subscription: the workspace follows Stripe (Scale, 3 accounts, monthly)';
    else fails := fails + 1; log := log || E'\nFAIL apply_subscription: ' || j::text; end if;

  update outreach_senders set status = 'ok' where id = s2;                             -- 2 of 3
  insert into outreach_senders(workspace_id, provider, display_name, status, timezone, owner_email) values (ws, 'LINKEDIN', 'Third', 'connecting', 'UTC', 'three14@test.local') returning id into s3;
  insert into outreach_senders(workspace_id, provider, display_name, status, timezone, owner_email) values (ws, 'LINKEDIN', 'Fourth', 'connecting', 'UTC', 'four14@test.local') returning id into s4;
  rid := outreach_slot_reserve(ws, 'hosted_auth', s3);
  begin rid2 := outreach_slot_reserve(ws, 'hosted_auth', s4); t := 'reserved'; exception when others then t := sqlerrm; end;
  j := outreach__slots(ws);
  if rid is not null and t like 'E_ACCOUNT_LIMIT: All 3 accounts%' and (j->>'used')::int = 2 and (j->>'reserved')::int = 1 and (j->>'available')::int = 0
    then log := log || E'\nok   reservations: two links on the last free account, the second gets E_ACCOUNT_LIMIT (PRD #9)';
    else fails := fails + 1; log := log || E'\nFAIL reservations: ' || t || ' ' || j::text; end if;
  -- the hosted page comes back for the sender without a reservation first: refused (PRD #10); then the holder completes
  begin update outreach_senders set unipile_account_id = 's14d-' || ws where id = s4; t := 'bound'; exception when others then t := sqlerrm; end;
  update outreach_senders set unipile_account_id = 's14c-' || ws where id = s3;
  update outreach_senders set status = 'ok' where id = s3;
  j := outreach__slots(ws);
  if t like 'E_ACCOUNT_LIMIT:%' and (j->>'used')::int = 3 and (j->>'reserved')::int = 0
     and (select release_reason from outreach_slot_reservations where id = rid) = 'completed'
    then log := log || E'\nok   the reservation holder connects (3 of 3) and uses up its reservation; the sender without one is refused';
    else fails := fails + 1; log := log || E'\nFAIL reservation use: ' || t || ' ' || j::text; end if;
  -- an expired reservation frees the account
  update outreach_senders set status = 'disabled' where id = s3;
  rid := outreach_slot_reserve(ws, 'hosted_auth', s4, 15);
  update outreach_slot_reservations set expires_at = now() - interval '1 minute' where id = rid;
  if (outreach__slots(ws)->>'available')::int = 1 then log := log || E'\nok   an expired reservation no longer holds an account';
  else fails := fails + 1; log := log || E'\nFAIL reservation expiry: ' || outreach__slots(ws)::text; end if;
  update outreach_senders set status = 'ok' where id = s3;

  -- features of Scale: clients yes, webhooks no (Enterprise)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_create_webhook(ws, 'https://example.com/hook', array['*']); t := 'created'; exception when others then t := sqlerrm; end;
  begin perform outreach_create_api_key(ws, 'k', 'member'); t := t || ' | key created'; exception when others then t := t || ' | ' || sqlerrm; end;
  begin perform outreach_add_tracking_domain(ws, 'link.smoke14.example'); t := t || ' | domain ok'; exception when others then t := t || ' | ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A');
  if t like 'E_PLAN_REQUIRED: Available on Enterprise.%| E_PLAN_REQUIRED: Available on Enterprise.%| domain ok'
    then log := log || E'\nok   Scale: clients and tracking domains work; webhooks and API keys answer E_PLAN_REQUIRED naming Enterprise';
    else fails := fails + 1; log := log || E'\nFAIL scale features: ' || t; end if;

  -- ============================================================ 6. fewer accounts at renewal: the keep list decides who pauses; more accounts resume them
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'lead14-' || left(ws::text, 8), 'Ann Lee') returning id into l1;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by) values (ws, 'Seq 14', 'active', array[s1, s2, s3], u_owner) returning id into q1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status) values (ws, q1, 1, l1, s2, 'active') returning id into e1;
  j := outreach_senders_to_pause(ws, 1, array[s3]);
  update outreach_workspaces set scheduled_change = jsonb_build_object('plan', 'scale', 'accounts_billed', 1, 'billing_period', 'monthly', 'keep_sender_ids', jsonb_build_array(s3)) where id = ws;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 1));
  select string_agg(display_name || ':' || status::text || ':' || coalesce(status_reason, '-'), ', ' order by display_name) into t from outreach_senders where id in (s1, s2, s3);
  if t = 'First:paused:over_plan_limit, Second:paused:over_plan_limit, Third:ok:-' and (k#>>'{accounts,paused}')::int = 2
     and (select count(*) from jsonb_array_elements(j) x where x->>'action' = 'pause') = 2 and (j->0->>'sender_id')::uuid = s3
     and (select status from outreach_enrollments where id = e1) = 'active'
    then log := log || E'\nok   decrease 3 → 1: the customer''s keep list stays, the other two pause (over_plan_limit), their leads keep their place';
    else fails := fails + 1; log := log || E'\nFAIL decrease: ' || coalesce(t, '') || ' ' || k::text; end if;
  j := outreach_why_not_sending(null, s1, null);
  if j::text like '%E_ACCOUNT_LIMIT%' and j::text like '%your plan has 1 account and 3 are connected%'
    then log := log || E'\nok   why_not_sending explains: "Paused: your plan has 1 account and 3 are connected"';
    else fails := fails + 1; log := log || E'\nFAIL why_not_sending: ' || left(j::text, 500); end if;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 3));
  select string_agg(display_name || ':' || status::text, ', ' order by display_name) into t from outreach_senders where id in (s1, s2, s3);
  if t = 'First:ok, Second:ok, Third:ok' and (k#>>'{accounts,resumed}')::int = 2
    then log := log || E'\nok   adding accounts resumes the paused ones';
    else fails := fails + 1; log := log || E'\nFAIL resume after increase: ' || t || ' ' || k::text; end if;
  -- a plan-paused account is not resumed by hand, and comes back by itself when another account is removed
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 2));
  select id into s4 from outreach_senders where id in (s1, s2, s3) and status = 'paused' and status_reason = 'over_plan_limit';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_pause_sender(s4, false); t := 'resumed'; exception when others then t := left(sqlerrm, 16); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_senders set status = 'disabled', status_reason = 'disabled_by_user' where id = (select id from outreach_senders where id in (s1, s2, s3) and status = 'ok' and id <> s1 limit 1);
  if s4 is not null and t = 'E_ACCOUNT_LIMIT:' and (select status::text from outreach_senders where id = s4) = 'ok'
     and (select count(*) from outreach_senders where id in (s1, s2, s3) and status = 'ok') = 2
    then log := log || E'\nok   a plan-paused account refuses a manual resume and comes back on its own when another account is disabled';
    else fails := fails + 1; log := log || E'\nFAIL freed slot: ' || coalesce(t, '') || ' ' || (select string_agg(display_name || ':' || status::text, ',') from outreach_senders where id in (s1, s2, s3)); end if;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 3));
  update outreach_senders set status = 'ok', status_reason = null where id in (s1, s2, s3) and status = 'disabled';
  -- an account that needs a sign-in anyway gives its slot back instead of being paused
  update outreach_senders set status = 'credentials', status_reason = 'CREDENTIALS' where id = s2;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 2));
  if (select status::text || ':' || status_reason from outreach_senders where id = s2) = 'disconnected:over_plan_limit' and (k#>>'{accounts,disconnected}')::int = 1
     and (select count(*) from outreach_senders where id in (s1, s3) and status = 'ok') = 2
    then log := log || E'\nok   decrease 3 → 2 with one signed-out account: that one is disconnected, the two working ones stay';
    else fails := fails + 1; log := log || E'\nFAIL decrease with broken sender: ' || k::text; end if;

  -- ============================================================ 7. disconnect keeps the sender, queues the connector delete
  select * into r from outreach_senders where id = s2;
  select count(*) into n from outreach_account_deletions where account_id = 's14b-' || ws and done_at is null;
  if r.unipile_account_id is null and r.previous_unipile_account_id = 's14b-' || ws and r.disconnected_at is not null and n = 1
     and (select status from outreach_enrollments where id = e1) = 'active' and (outreach__slots(ws)->>'used')::int = 2
     and exists (select 1 from outreach_account_deletions_due(50) d where d.account_id = 's14b-' || ws)
    then log := log || E'\nok   disconnect: account id moved to previous_unipile_account_id, delete queued, enrolment still active, slot freed';
    else fails := fails + 1; log := log || E'\nFAIL disconnect: ' || to_jsonb(r)::text; end if;
  j := outreach_account_deletion_result('s14b-' || ws, false, 'timeout');
  k := outreach_account_deletion_result('s14b-' || ws, true);
  if (j->>'done')::boolean = false and (k->>'done')::boolean and not exists (select 1 from outreach_account_deletions_due(50) d where d.account_id = 's14b-' || ws)
    then log := log || E'\nok   connector delete: a failure backs off, a success closes the row';
    else fails := fails + 1; log := log || E'\nFAIL deletion result: ' || j::text || k::text; end if;
  -- reconnect onto the same sender: needs a free account, gets the quiet-period path like any reconnect
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'scale', 'billing_period', 'monthly', 'accounts_billed', 3));
  rid := outreach_slot_reserve(ws, 'reconnect', s2, 60);
  update outreach_senders set unipile_account_id = 's14b2-' || ws, status = 'connecting', status_reason = null where id = s2;
  update outreach_senders set status = 'ok' where id = s2;
  select * into r from outreach_senders where id = s2;
  if rid is not null and r.status = 'ok' and r.disconnected_at is null and r.previous_unipile_account_id = 's14b-' || ws and (outreach__slots(ws)->>'used')::int = 3
    then log := log || E'\nok   reconnect: the new account binds to the same sender row and takes a slot again';
    else fails := fails + 1; log := log || E'\nFAIL reconnect: ' || r.status || ' ' || outreach__slots(ws)::text; end if;

  -- ============================================================ 8. downgrade Scale → Launch: effects listed, applied, restored
  insert into outreach_sequence_reply_settings(sequence_id, workspace_id, mode) values (q1, ws, 'autopilot') on conflict (sequence_id) do update set mode = 'autopilot';
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_viewer, 'client_viewer', 'viewer14@test.local');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_downgrade_effects(ws, 'launch');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select x->>'text' from jsonb_array_elements(j) x where x->>'feature' = 'ai_auto_reply') = '1 sequence on Auto will switch to Draft'
     and (select x->>'text' from jsonb_array_elements(j) x where x->>'feature' = 'client_viewer') = '1 client viewer will lose access'
     and (select x->>'text' from jsonb_array_elements(j) x where x->>'feature' = 'tracking_domains') = '1 tracking domain will stop being used'
     and exists (select 1 from jsonb_array_elements(j) x where x->>'feature' = 'clients')
    then log := log || E'\nok   downgrade preview: "1 sequence on Auto will switch to Draft · 1 client viewer will lose access · 1 tracking domain will stop being used"';
    else fails := fails + 1; log := log || E'\nFAIL downgrade_effects: ' || j::text; end if;

  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'launch', 'billing_period', 'monthly', 'accounts_billed', 3));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  t := coalesce(outreach_role_in(ws)::text, 'none');
  j := outreach_billing_state(ws);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_sequence_ai_replies_set(q1, '{"mode":"autopilot"}'::jsonb, 'back on'); t := t || ' | auto set'; exception when others then t := t || ' | ' || left(sqlerrm, 44); end;
  begin insert into outreach_clients(workspace_id, name) values (ws, 'Client B'); t := t || ' | client created'; exception when others then t := t || ' | ' || left(sqlerrm, 41); end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select mode::text || ':' || coalesce(downgrade_reason, '') from outreach_sequence_reply_settings where sequence_id = q1) = 'draft:plan'
     and t = 'none | E_PLAN_REQUIRED: Available on Scale. AI repl | E_PLAN_REQUIRED: Available on Scale. Keep' and j->>'access_blocked' = 'client_viewer_plan'
     and outreach_tracking_domain_for(s1) is null and (select count(*) from outreach_clients where workspace_id = ws) = 1
    then log := log || E'\nok   on Launch: Auto became Draft, the client viewer is locked out (told why), new clients and Auto are refused, existing client kept';
    else fails := fails + 1; log := log || E'\nFAIL launch effects: ' || t || ' ' || j::text; end if;

  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'enterprise', 'billing_period', 'annual', 'accounts_billed', 3));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  t := coalesce(outreach_role_in(ws)::text, 'none');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_create_webhook(ws, 'https://example.com/hook', array['*']); t := t || ' | webhook'; exception when others then t := t || ' | ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select mode::text from outreach_sequence_reply_settings where sequence_id = q1) = 'autopilot' and t = 'client_viewer | webhook'
     and (select billing_period from outreach_workspaces where id = ws) = 'annual'
    then log := log || E'\nok   upgrade to Enterprise: Auto is back, the client viewer is back, webhooks can be created';
    else fails := fails + 1; log := log || E'\nFAIL re-upgrade: ' || t; end if;

  -- ============================================================ 9. billing state for the app
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  j := outreach_billing_state(ws);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  k := outreach_billing_state(ws);
  perform set_config('request.jwt.claims', '', true);
  if j->>'plan' = 'enterprise' and (j#>>'{accounts,billed}')::int = 3 and (j#>>'{accounts,used}')::int = 3 and (j#>>'{features,webhooks,enabled}')::boolean
     and j ? 'stripe_status' and (j->>'has_subscription')::boolean and (j->>'is_owner')::boolean
     and not (k ? 'stripe_status') and (k#>>'{accounts,used}')::int = 3 and not (k->>'is_owner')::boolean
    then log := log || E'\nok   billing_state: the owner sees the subscription; a member sees the meter and features only';
    else fails := fails + 1; log := log || E'\nFAIL billing_state: ' || left(j::text, 300) || ' / ' || left(k::text, 200); end if;

  -- ============================================================ 10. failed payment: past due → day 7 suspended → payment recovers
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'past_due', 'plan', 'enterprise', 'billing_period', 'annual', 'accounts_billed', 3));
  select * into r from outreach_workspaces where id = ws;
  b := r.plan = 'enterprise' and r.past_due_since is not null and outreach_plan_active(ws);
  j := outreach_billing_tick();
  b := b and not (j->'suspended') ? ws::text;
  update outreach_workspaces set past_due_since = now() - interval '8 days' where id = ws;
  j := outreach_billing_tick();
  select string_agg(status::text || ':' || coalesce(status_reason, '-'), ',' order by display_name) into t from outreach_senders where id in (s1, s2, s3);
  select * into r from outreach_workspaces where id = ws;
  if b and (j->'suspended') ? ws::text and r.plan = 'suspended' and r.plan_before_suspension = 'enterprise' and not outreach_plan_active(ws)
     and t = 'paused:billing_suspended,paused:billing_suspended,paused:billing_suspended'
    then log := log || E'\nok   past due: nothing changes for 7 days, then the workspace is suspended and every sender paused (billing_suspended)';
    else fails := fails + 1; log := log || E'\nFAIL past due: ' || r.plan || ' ' || coalesce(t, '') || ' ' || j::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  begin perform outreach_require(ws, 'member'); t := 'allowed'; exception when others then t := sqlerrm; end;
  perform set_config('request.jwt.claims', '', true);
  if t like 'E_PLAN_SUSPENDED: This workspace is paused because of a billing issue%' then log := log || E'\nok   a suspended workspace refuses writes (E_PLAN_SUSPENDED)';
  else fails := fails + 1; log := log || E'\nFAIL suspended write: ' || t; end if;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'enterprise', 'billing_period', 'annual', 'accounts_billed', 3));
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'enterprise' and r.past_due_since is null and r.plan_before_suspension is null and (select count(*) from outreach_senders where id in (s1, s2, s3) and status = 'ok') = 3
    then log := log || E'\nok   payment recovered: the plan is back and all three senders resumed on their own';
    else fails := fails + 1; log := log || E'\nFAIL recovery: ' || r.plan || ' ' || k::text; end if;

  -- ============================================================ 11. dispute: suspended at once, stays suspended whatever the subscription says, resumes when won
  j := outreach_billing_dispute(ws, true, null, 'dp_1');
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'active', 'plan', 'enterprise', 'billing_period', 'annual', 'accounts_billed', 3));
  b := (select plan from outreach_workspaces where id = ws) = 'suspended';
  j := outreach_billing_dispute(ws, false, true, 'dp_1');
  if b and (j->>'resumed')::boolean and (select plan from outreach_workspaces where id = ws) = 'enterprise' and (select count(*) from outreach_senders where id in (s1, s2, s3) and status = 'ok') = 3
    then log := log || E'\nok   dispute: suspended at once and kept suspended; resumed when the dispute is won';
    else fails := fails + 1; log := log || E'\nFAIL dispute: ' || j::text; end if;

  -- ============================================================ 12. 14 days paused for billing → disconnected (connector hygiene)
  update outreach_senders set status = 'paused', status_reason = 'over_plan_limit' where id = s3;
  update outreach_senders set billing_paused_at = now() - interval '15 days' where id = s3;
  -- (the limit still fits, so reconciliation would resume it: hold the limit at 2 for this check)
  update outreach_workspaces set accounts_billed = 2 where id = ws;
  j := outreach_billing_tick();
  if (select status::text || ':' || status_reason from outreach_senders where id = s3) = 'disconnected:over_plan_limit' and (j->>'senders_disconnected')::int >= 1
    then log := log || E'\nok   hygiene: an account paused for the plan for 15 days is disconnected (its connector account is queued for deletion)';
    else fails := fails + 1; log := log || E'\nFAIL hygiene: ' || j::text; end if;
  -- reconciliation: more active accounts than the plan, no reason on record
  update outreach_workspaces set accounts_billed = 1 where id = ws;
  j := outreach_billing_tick();
  if (j->'reconciled') ? ws::text and (select count(*) from outreach_senders where id in (s1, s2) and status = 'paused' and status_reason = 'over_plan_limit') = 1
    then log := log || E'\nok   reconciliation: 2 active on a 1-account plan → one is paused and the workspace is reported';
    else fails := fails + 1; log := log || E'\nFAIL reconcile: ' || j::text; end if;

  -- ============================================================ 13. cancel: read-only, senders paused, 90 days of data, early-supporter price gone
  update outreach_workspaces set early_supporter_discount = 0.30, early_supporter_tier = 2 where id = ws;
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'canceled'));
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'cancelled' and r.plan_before_suspension = 'enterprise' and r.early_supporter_discount = 0 and r.data_delete_after between now() + interval '89 days' and now() + interval '91 days'
     and not outreach_plan_active(ws) and outreach_feature_plan(ws) = 'enterprise'
     and (select count(*) from outreach_senders where id in (s1, s2) and status = 'paused' and status_reason = 'billing_cancelled') = 2
    then log := log || E'\nok   cancelled: read-only, senders paused (billing_cancelled), data kept 90 days, discount gone, settings still those of the last plan';
    else fails := fails + 1; log := log || E'\nFAIL cancel: ' || r.plan || ' ' || r.data_delete_after || ' ' || r.early_supporter_discount; end if;
  begin perform outreach_slot_reserve(ws, 'hosted_auth', null); t := 'reserved'; exception when others then t := sqlerrm; end;
  begin perform outreach_purge_workspace(ws); t := t || ' | purged'; exception when others then t := t || ' | ' || left(sqlerrm, 11); end;
  select count(*) into n from outreach_billing_notices_due() d where d.workspace_id = ws;
  if t like 'E_PLAN_SUSPENDED: This subscription has ended%| E_FORBIDDEN' and n = 0
    then log := log || E'\nok   cancelled: no new connections; the workspace cannot be purged before its date; no deletion warning yet';
    else fails := fails + 1; log := log || E'\nFAIL cancelled guards: ' || t || ' notices ' || n; end if;
  update outreach_workspaces set data_delete_after = now() + interval '6 days' where id = ws;
  select string_agg(d.kind, ',') into t from outreach_billing_notices_due() d where d.workspace_id = ws;
  b := outreach_billing_notice_claim(ws, 'cancel_data_7d', (select data_delete_after::date::text from outreach_workspaces where id = ws));
  select count(*) into n from outreach_billing_notices_due() d where d.workspace_id = ws;
  if t = 'cancel_data_7d' and b and n = 0 and not outreach_billing_notice_claim(ws, 'cancel_data_7d', (select data_delete_after::date::text from outreach_workspaces where id = ws))
    then log := log || E'\nok   notices: the 7-day deletion warning is due once, and can be claimed once';
    else fails := fails + 1; log := log || E'\nFAIL notices: ' || coalesce(t, 'none'); end if;
  -- coming back: a new subscription restores everything that was paused
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14b', 'status', 'active', 'plan', 'launch', 'billing_period', 'monthly', 'accounts_billed', 5));
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'launch' and r.data_delete_after is null and r.cancelled_at is null and r.stripe_subscription_id = 'sub_smoke14b'
     and (select count(*) from outreach_senders where id in (s1, s2) and status = 'ok') = 2
    then log := log || E'\nok   coming back within 90 days: new subscription, data kept, paused senders resume';
    else fails := fails + 1; log := log || E'\nFAIL comeback: ' || r.plan || ' ' || k::text; end if;
  -- a late event of the old subscription changes nothing (PRD #35)
  k := outreach_billing_apply_subscription(ws, jsonb_build_object('subscription_id', 'sub_smoke14', 'status', 'canceled'));
  if k->>'ignored' = 'other_subscription' and (select plan from outreach_workspaces where id = ws) = 'launch'
    then log := log || E'\nok   a late "canceled" for the previous subscription is ignored';
    else fails := fails + 1; log := log || E'\nFAIL stale event: ' || k::text; end if;

  -- ============================================================ 14. trial expiry: the account is disconnected, 30 days of read-only data
  -- (the test users may share a company email domain with an earlier workspace: clear that so this one is a first trial)
  delete from outreach_trial_claims c where c.user_id = u_member
     or c.email_domain = (select lower(split_part(u.email, '@', 2)) from auth.users u where u.id = u_member);
  insert into outreach_workspaces(name, slug, created_by) values ('smoke14 trial', 'smoke14t-' || encode(gen_random_bytes(4),'hex'), u_member) returning id into ws2;
  insert into outreach_members(workspace_id, user_id, role, email) values (ws2, u_member, 'owner', 'member14@test.local');
  select * into r from outreach_workspaces where id = ws2;
  b := r.plan = 'trial';                                              -- u_member's first own workspace: gets a trial
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, timezone, owner_user_id, connected_at)
    values (ws2, 'LINKEDIN', 'Priya Nair', 'ok', 's14t-' || ws2, 'UTC', u_member, now() - interval '6 days') returning id into s4;
  update outreach_workspaces set trial_ends_at = now() + interval '30 hours' where id = ws2;
  select string_agg(d.kind || ':' || (d.data->>'account'), ',') into t from outreach_billing_notices_due() d where d.workspace_id = ws2;
  update outreach_workspaces set trial_ends_at = now() - interval '1 hour' where id = ws2;
  j := outreach_billing_tick();
  select * into r from outreach_workspaces where id = ws2;
  if b and t = 'trial_ends_soon:Priya Nair' and (j->'trials_expired') ? ws2::text and r.plan = 'trial_expired' and r.data_delete_after between now() + interval '29 days' and now() + interval '30 days'
     and (select status::text || ':' || status_reason || ':' || coalesce(unipile_account_id, 'null') from outreach_senders where id = s4) = 'disconnected:trial_expired:null'
     and exists (select 1 from outreach_account_deletions where account_id = 's14t-' || ws2) and outreach_feature_plan(ws2) = 'scale' and not outreach_plan_active(ws2)
    then log := log || E'\nok   trial ended: plan trial_expired, the account disconnected (delete queued), data kept 30 days, read-only';
    else fails := fails + 1; log := log || E'\nFAIL trial expiry: ' || coalesce(t, 'no notice') || ' ' || r.plan || ' ' || j::text; end if;
  -- reconnect needs a plan
  begin update outreach_senders set unipile_account_id = 's14t2-' || ws2, status = 'connecting' where id = s4; t := 'bound'; exception when others then t := sqlerrm; end;
  if t like 'E_PLAN_SUSPENDED: Your trial has ended%' then log := log || E'\nok   a lapsed trial cannot reconnect before subscribing';
  else fails := fails + 1; log := log || E'\nFAIL lapsed reconnect: ' || t; end if;
  -- subscribe on day 20, reconnect onto the same sender (PRD #24b)
  k := outreach_billing_apply_subscription(ws2, jsonb_build_object('subscription_id', 'sub_smoke14t', 'status', 'active', 'plan', 'launch', 'billing_period', 'monthly', 'accounts_billed', 1));
  update outreach_senders set unipile_account_id = 's14t2-' || ws2, status = 'connecting', status_reason = null where id = s4;
  update outreach_senders set status = 'ok' where id = s4;
  select * into r from outreach_workspaces where id = ws2;
  if r.plan = 'launch' and r.data_delete_after is null and (select status::text from outreach_senders where id = s4) = 'ok' and (outreach__slots(ws2)->>'used')::int = 1
    then log := log || E'\nok   subscribing after expiry: data kept, the same sender reconnects';
    else fails := fails + 1; log := log || E'\nFAIL subscribe after expiry: ' || r.plan; end if;
  -- purge a workspace that really is past its date
  k := outreach_billing_apply_subscription(ws2, jsonb_build_object('subscription_id', 'sub_smoke14t', 'status', 'canceled'));
  update outreach_workspaces set data_delete_after = now() - interval '1 day' where id = ws2;
  select count(*) into n from outreach_workspaces_due_for_deletion() d where d.workspace_id = ws2;
  j := outreach_purge_workspace(ws2);
  if n = 1 and (j->>'deleted')::boolean and not exists (select 1 from outreach_workspaces where id = ws2) and not exists (select 1 from outreach_senders where workspace_id = ws2)
     and exists (select 1 from outreach_account_deletions where account_id = 's14t2-' || ws2 and done_at is null)
    then log := log || E'\nok   past the date: the workspace and everything in it is deleted; its connector account is queued for deletion';
    else fails := fails + 1; log := log || E'\nFAIL purge: ' || j::text; end if;

  -- ============================================================ 15. one trial per person / company; early-supporter places
  insert into outreach_workspaces(name, slug, created_by) values ('smoke14 second', 'smoke14s-' || encode(gen_random_bytes(4),'hex'), u_member) returning id into ws3;
  select * into r from outreach_workspaces where id = ws3;
  if r.plan = 'trial_expired' and not exists (select 1 from outreach_early_supporters where workspace_id = ws3)
     and (select count(*) from outreach_trial_claims where user_id = u_member) >= 2
    then log := log || E'\nok   a second workspace of the same person starts without a trial and takes no early-supporter place';
    else fails := fails + 1; log := log || E'\nFAIL second trial: ' || r.plan; end if;
  j := outreach_early_supporters_public();
  k := outreach_pricing_public();
  if (j->>'claimed')::int >= 1 and jsonb_array_length(j->'tiers') = 3 and jsonb_array_length(k->'prices') = 54 and (k#>>'{trial,days}')::int = 7
     and has_function_privilege('anon', 'outreach_pricing_public()', 'execute') and not has_function_privilege('authenticated', 'outreach_disconnect_sender(uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_billing_apply_subscription(uuid,jsonb)', 'execute') and not has_function_privilege('anon', 'outreach_billing_state(uuid)', 'execute')
    then log := log || E'\nok   public pricing (54 prices) and early-supporter count are open; the billing writers are service-only';
    else fails := fails + 1; log := log || E'\nFAIL public endpoints / grants: ' || j::text; end if;

  -- ============================================================ 16. website chat inboxes follow the plan limit (Launch: 1)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'Site one', array['one.example'], null);
  begin perform outreach_webchat_inbox_create(ws, 'Site two', array['two.example'], null); t := 'created'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_PLAN_LIMIT:%' then log := log || E'\nok   Launch allows one website chat inbox';
  else fails := fails + 1; log := log || E'\nFAIL inbox limit: ' || t; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (billing v2 056–060)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
