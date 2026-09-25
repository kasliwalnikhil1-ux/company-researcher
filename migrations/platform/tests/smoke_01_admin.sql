-- Platform admin smoke test. Runs as one transaction and ALWAYS raises at the end (so nothing it creates survives);
-- a passing run prints "SMOKE OK" inside the raised error, a failing one lists the failed assertions.
-- Run: bash scripts/outreach-sql.sh migrations/platform/tests/smoke_01_admin.sql
do $$
declare
  log text := '';
  fails int := 0;
  admin_id uuid := '2793f3da-9340-44f4-b285-b7836bfb8591';   -- founders@capitalxai.com (seeded admin)
  u1 uuid := gen_random_uuid();
  u2 uuid := gen_random_uuid();
  e1 text := 'smoke-' || substr(u1::text, 1, 8) || '@example.test';
  e2 text := 'smoke-' || substr(u2::text, 1, 8) || '@example.test';
  j jsonb; ws uuid; t text; n int; ok boolean;

begin
  -- helper as inline pattern: ok := ...; if not ok then fails++, log
  -- 0. sanity: the seed put the hardcoded admin in
  ok := platform_is_admin(admin_id);
  if not ok then fails := fails + 1; log := log || E'\nFAIL seed admin'; end if;

  -- 1. a new sign-up gets a pending access row (signup_mode = approval by default)
  insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (u1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e1, 'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');
  select status into t from platform_user_access where user_id = u1;
  ok := t = 'pending';
  if not ok then fails := fails + 1; log := log || E'\nFAIL trigger pending: ' || coalesce(t, 'null'); end if;

  -- 2. my_access as the new user
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  j := platform_my_access();
  ok := j->>'status' = 'pending' and (j->>'is_admin')::boolean = false and (j->'features'->>'outreach')::boolean = true and (j->'features'->>'fundraising')::boolean = true and (j->>'crm_member')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL my_access pending: ' || j::text; end if;

  -- 3. pending user cannot enter outreach
  begin
    perform outreach_ensure_workspace(null); ok := false;
  exception when others then ok := sqlerrm like 'E_FEATURE_DISABLED%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL pending ensure_workspace should raise E_FEATURE_DISABLED'; end if;

  -- 4. pending user is not a CRM member even with a row
  insert into crm_members(user_id, display_name, email) values (u1, 'Smoke', e1);
  ok := crm_is_member() = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL pending crm_is_member should be false'; end if;
  delete from crm_members where user_id = u1;

  -- 5. non-admin cannot call admin RPCs
  begin
    perform platform_admin_overview(); ok := false;
  exception when others then ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL non-admin overview should raise E_FORBIDDEN'; end if;

  -- 6. admin lists + approves the user
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  j := platform_admin_list_users(e1, '{}', 50, 0);
  ok := (j->>'total')::int = 1 and j->'rows'->0->>'email' = e1 and j->'rows'->0->>'status' = 'pending';
  if not ok then fails := fails + 1; log := log || E'\nFAIL list_users search: ' || j::text; end if;
  j := platform_admin_list_users(null, '{"status":"pending"}', 1, 0);
  ok := (j->>'total')::int >= 1 and jsonb_array_length(j->'rows') = 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL list_users filter/limit: ' || (j->>'total'); end if;
  j := platform_admin_set_access(u1, 'active', null, 'approved in smoke');
  ok := j->>'status' = 'active' and j->>'note' = 'approved in smoke';
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_access active: ' || j::text; end if;

  -- 7. approved user can enter outreach; a workspace is created
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  ws := (outreach_ensure_workspace(null)).id;
  n := (select count(*) from outreach_my_workspaces());
  ok := ws is not null and n = 1 and outreach_role_in(ws) = 'owner';
  if not ok then fails := fails + 1; log := log || E'\nFAIL active ensure_workspace: n=' || n; end if;

  -- 8. admin switches outreach off for this user → no role, my_workspaces raises
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  j := platform_admin_set_access(u1, null, '{"outreach": false}', null);
  ok := (j->'features'->>'outreach')::boolean = false and (j->'overrides'->>'outreach')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_access features: ' || j::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  ok := outreach_role_in(ws) is null and not exists (select 1 from outreach_workspace_ids());
  if not ok then fails := fails + 1; log := log || E'\nFAIL outreach off: role_in should be null'; end if;
  begin
    perform * from outreach_my_workspaces(); ok := false;
  exception when others then ok := sqlerrm like 'E_FEATURE_DISABLED%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL outreach off: my_workspaces should raise'; end if;
  j := platform_my_access();
  ok := (j->'features'->>'outreach')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL my_access reflects override'; end if;

  -- 9. back on, then credits + billing
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  perform platform_admin_set_access(u1, null, '{}', null);
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  ok := outreach_role_in(ws) = 'owner';
  if not ok then fails := fails + 1; log := log || E'\nFAIL outreach back on'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  select coalesce(credits_remaining, 0) into n from user_settings where id = u1;   -- the sign-up trigger may seed a starting balance
  j := platform_admin_adjust_credits(u1, 10, null, 'welcome');
  ok := (j->>'credits_remaining')::int = n + 10;
  if not ok then fails := fails + 1; log := log || E'
FAIL credits +10: ' || (j->>'credits_remaining') || ' (was ' || n || ')'; end if;
  j := platform_admin_adjust_credits(u1, null, 3, null);
  ok := (j->>'credits_remaining')::int = 3;
  if not ok then fails := fails + 1; log := log || E'\nFAIL credits set 3'; end if;
  j := platform_admin_adjust_credits(u1, -5, null, null);
  ok := (j->>'credits_remaining')::int = 0;
  if not ok then fails := fails + 1; log := log || E'\nFAIL credits floor 0'; end if;
  begin
    perform platform_admin_adjust_credits(u1, 1, 1, null); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL credits both args should raise'; end if;
  j := platform_admin_set_billing(u1, '{"plan":"pro","billing_status":"active","billing_cycle":"yearly","renewal_date":"2027-01-01"}');
  ok := j->>'plan' = 'pro' and j->>'billing_cycle' = 'yearly' and (j->>'renewal_date')::date = '2027-01-01';
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_billing: ' || j::text; end if;
  begin
    perform platform_admin_set_billing(u1, '{"plan":"gold"}'); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_billing bad plan should raise'; end if;

  -- 10. credit spend is refused for a blocked account, allowed for an active one
  perform platform_admin_bulk_set_status(array[u1], 'blocked');
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  begin
    perform upsert_investor_ai_metadata(u1, gen_random_uuid(), '{}'); ok := false;
  exception when others then ok := sqlerrm like 'Fundraising is not enabled%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL blocked user credit spend should be refused'; end if;
  j := platform_my_access();
  ok := j->>'status' = 'blocked';
  if not ok then fails := fails + 1; log := log || E'\nFAIL my_access blocked'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  n := platform_admin_bulk_set_status(array[u1, gen_random_uuid()], 'active');
  ok := n = 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL bulk active count: ' || n; end if;

  -- 11. outreach workspace admin: suspend / resume / rename, members
  j := platform_admin_outreach_set_workspace(ws, '{"plan":"suspended"}');
  ok := j->>'plan' = 'suspended' and j->>'plan_before_suspension' = 'trial';
  if not ok then fails := fails + 1; log := log || E'\nFAIL suspend: ' || j::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  ok := outreach_role_in(ws) = 'owner' and outreach_plan_active(ws) = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL suspended: plan_active false, role kept'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  j := platform_admin_outreach_set_workspace(ws, '{"plan":"team","name":"Smoke WS","trial_ends_at":"2030-01-01T00:00:00Z"}');
  ok := j->>'plan' = 'team' and j->>'name' = 'Smoke WS' and j->>'plan_before_suspension' is null and (j->>'trial_ends_at')::date = '2030-01-01';
  if not ok then fails := fails + 1; log := log || E'\nFAIL resume/rename: ' || j::text; end if;
  begin
    perform platform_admin_outreach_set_workspace(ws, '{"plan":"gold"}'); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL bad ws plan should raise'; end if;
  j := platform_admin_outreach_set_member(ws, admin_id, 'manager', null);
  ok := exists (select 1 from outreach_members where workspace_id = ws and user_id = admin_id and role = 'manager');
  if not ok then fails := fails + 1; log := log || E'\nFAIL add member'; end if;
  begin
    perform platform_admin_outreach_set_member(ws, u1, null, null); ok := false;   -- last owner
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL remove last owner should raise'; end if;
  perform platform_admin_outreach_set_member(ws, admin_id, null, null);
  ok := not exists (select 1 from outreach_members where workspace_id = ws and user_id = admin_id);
  if not ok then fails := fails + 1; log := log || E'\nFAIL remove member'; end if;
  j := platform_admin_outreach_workspaces(e1, false);
  ok := jsonb_array_length(j) = 1 and j->0->>'owner_email' = e1 and jsonb_array_length(j->0->'members') = 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL admin ws list by owner email: ' || j::text; end if;

  -- 12. CRM team
  j := platform_admin_crm_set_member(u1, true, 'Smoke Person');
  ok := j->'crm'->>'display_name' = 'Smoke Person' and (j->'crm'->>'is_active')::boolean;
  if not ok then fails := fails + 1; log := log || E'\nFAIL crm add: ' || (j->'crm')::text; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', e1, 'role', 'authenticated')::text, true);
  ok := crm_is_member() and (platform_my_access()->>'crm_member')::boolean;
  if not ok then fails := fails + 1; log := log || E'\nFAIL crm member active'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  j := platform_admin_crm_set_member(u1, false, null);
  ok := (j->'crm'->>'is_active')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL crm deactivate'; end if;
  j := platform_admin_crm_members();
  ok := exists (select 1 from jsonb_array_elements(j) x where x->>'user_id' = u1::text and (x->>'is_active')::boolean = false);
  if not ok then fails := fails + 1; log := log || E'\nFAIL crm members list'; end if;

  -- 13. admins: grant, self-revoke refused, revoke
  j := platform_admin_set_admin(u1, true, 'smoke');
  ok := (j->>'is_admin')::boolean;
  if not ok then fails := fails + 1; log := log || E'\nFAIL grant admin'; end if;
  begin
    perform platform_admin_set_admin(admin_id, false); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL self revoke should raise'; end if;
  j := platform_admin_set_admin(u1, false);
  ok := (j->>'is_admin')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL revoke admin'; end if;

  -- 14. settings: open sign-ups make the next account active immediately
  j := platform_admin_set_setting('signup_mode', '"open"');
  ok := j->>'signup_mode' = 'open';
  if not ok then fails := fails + 1; log := log || E'\nFAIL set signup_mode'; end if;
  insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (u2, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', e2, 'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{}');
  ok := platform_status_of(u2) = 'active';
  if not ok then fails := fails + 1; log := log || E'\nFAIL open signup active'; end if;
  begin
    perform platform_admin_set_setting('signup_mode', '"maybe"'); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL bad signup_mode should raise'; end if;
  j := platform_admin_set_setting('default_features', '{"fundraising": true, "outreach": false}');
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'email', e2, 'role', 'authenticated')::text, true);
  ok := (platform_my_access()->'features'->>'outreach')::boolean = false;
  if not ok then fails := fails + 1; log := log || E'\nFAIL default_features applied'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);

  -- 15. detail + audit
  j := platform_admin_get_user(u1);
  ok := jsonb_typeof(j->'credit_log') = 'array' and jsonb_array_length(j->'audit') >= 8 and jsonb_typeof(j->'outreach_memberships') = 'array';
  if not ok then fails := fails + 1; log := log || E'\nFAIL get_user detail: audit=' || jsonb_array_length(j->'audit'); end if;
  j := platform_admin_audit_log(10, 0, u1);
  ok := (j->>'total')::int >= 8 and jsonb_array_length(j->'rows') = 10;
  if not ok then fails := fails + 1; log := log || E'\nFAIL audit_log: ' || (j->>'total'); end if;
  j := platform_admin_overview();
  ok := (j->>'users')::int >= 2 and j ? 'outreach_by_plan' and j->>'signup_mode' = 'open';
  if not ok then fails := fails + 1; log := log || E'\nFAIL overview: ' || j::text; end if;
  j := platform_admin_settings();
  ok := jsonb_array_length(j->'admins') >= 1 and j->'settings'->>'signup_mode' = 'open';
  if not ok then fails := fails + 1; log := log || E'\nFAIL settings'; end if;

  if fails = 0 then
    raise exception 'SMOKE OK (rolled back)';
  else
    raise exception 'SMOKE FAILED: % failure(s)%', fails, log;
  end if;
end $$;
