-- Platform leads smoke test. Runs as one transaction and ALWAYS raises at the end (so nothing it creates survives);
-- a passing run prints "SMOKE OK" inside the raised error, a failing one lists the failed assertions.
-- Run: bash scripts/outreach-sql.sh migrations/platform/tests/smoke_02_leads.sql
do $$
declare
  log text := '';
  fails int := 0;
  admin_id uuid := '2793f3da-9340-44f4-b285-b7836bfb8591';   -- founders@capitalxai.com (seeded admin)
  u1 uuid := gen_random_uuid();
  e1 text := 'Smoke-' || substr(u1::text, 1, 8) || '@Example.test';   -- mixed case on purpose
  lead1 uuid; lead2 uuid;
  j jsonb; t text; n int; ok boolean;
begin
  -- 1. a website form lead for an email with no account: stored lowercased, unlinked
  insert into platform_leads(source, email, name, company, answers, page, country, city)
  values ('website_waitlist', e1, 'Smoke Person', 'Smoke Co', '{"company_type":"agency","senders":"5-9"}', '/waitlist/', 'IN', 'Jaipur')
  returning id into lead1;
  select email into t from platform_leads where id = lead1;
  ok := t = lower(e1);
  if not ok then fails := fails + 1; log := log || E'\nFAIL email normalised: ' || coalesce(t, 'null'); end if;
  ok := (select user_id is null from platform_leads where id = lead1);
  if not ok then fails := fails + 1; log := log || E'\nFAIL lead should be unlinked before sign-up'; end if;

  -- 2. the person signs up: access row pending, an app_signup lead appears, the form lead links to the account
  insert into auth.users(id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_app_meta_data, raw_user_meta_data)
  values (u1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', lower(e1), 'x', now(), now(), now(), '{"provider":"email","providers":["email"]}', '{"full_name":"Smoke Person"}');
  select status into t from platform_user_access where user_id = u1;
  ok := t = 'pending';
  if not ok then fails := fails + 1; log := log || E'\nFAIL trigger pending: ' || coalesce(t, 'null'); end if;
  select count(*) into n from platform_leads where source = 'app_signup' and user_id = u1;
  ok := n = 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL app_signup lead rows: ' || n; end if;
  ok := (select user_id = u1 from platform_leads where id = lead1);
  if not ok then fails := fails + 1; log := log || E'\nFAIL form lead not linked to new account'; end if;

  -- 3. a second form lead after sign-up links straight away (before-insert trigger)
  insert into platform_leads(source, email, answers) values ('website_demo', e1, '{"goal":"more-meetings"}') returning id into lead2;
  ok := (select user_id = u1 from platform_leads where id = lead2);
  if not ok then fails := fails + 1; log := log || E'\nFAIL later form lead not linked'; end if;

  -- 4. non-admin cannot read leads
  perform set_config('request.jwt.claims', json_build_object('sub', u1, 'email', lower(e1), 'role', 'authenticated')::text, true);
  begin
    perform platform_admin_list_leads(null, '{}', 10, 0); ok := false;
  exception when others then ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL non-admin list_leads should raise E_FORBIDDEN'; end if;

  -- 5. admin: overview, list (search + filters), detail with timeline, patch, delete
  perform set_config('request.jwt.claims', json_build_object('sub', admin_id, 'email', 'founders@capitalxai.com', 'role', 'authenticated')::text, true);
  j := platform_admin_leads_overview();
  ok := (j->>'total')::int >= 3 and (j->'by_source'->>'website_waitlist')::int >= 1 and (j->>'signups')::int >= 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL overview: ' || j::text; end if;

  j := platform_admin_list_leads(lower(e1), '{}', 50, 0);
  ok := (j->>'total')::int = 3;
  if not ok then fails := fails + 1; log := log || E'\nFAIL list search total: ' || (j->>'total'); end if;
  j := platform_admin_list_leads(lower(e1), '{"source":"website"}', 50, 0);
  ok := (j->>'total')::int = 2;
  if not ok then fails := fails + 1; log := log || E'\nFAIL list source=website: ' || (j->>'total'); end if;
  j := platform_admin_list_leads(lower(e1), '{"source":"app_signup","account":"yes"}', 50, 0);
  ok := (j->>'total')::int = 1 and j->'rows'->0->'account'->>'status' = 'pending' and (j->'rows'->0->>'related')::int = 2;
  if not ok then fails := fails + 1; log := log || E'\nFAIL list signup row: ' || j::text; end if;
  j := platform_admin_list_leads('Jaipur', '{"country":"IN"}', 50, 0);
  ok := (j->>'total')::int >= 1 and j->'rows'->0->>'city' = 'Jaipur';
  if not ok then fails := fails + 1; log := log || E'\nFAIL list by city/country: ' || j::text; end if;

  j := platform_admin_get_lead(lead1);
  ok := j->>'source' = 'website_waitlist' and jsonb_array_length(j->'timeline') = 2 and j->'answers'->>'company_type' = 'agency';
  if not ok then fails := fails + 1; log := log || E'\nFAIL get_lead: ' || j::text; end if;

  j := platform_admin_set_lead(lead1, '{"status":"contacted","note":"called"}');
  ok := j->>'status' = 'contacted' and j->>'note' = 'called';
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_lead: ' || j::text; end if;
  begin
    perform platform_admin_set_lead(lead1, '{"status":"bogus"}'); ok := false;
  exception when others then ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if not ok then fails := fails + 1; log := log || E'\nFAIL set_lead bogus status should raise'; end if;
  select count(*) into n from platform_audit_log where action = 'lead.updated' and details->>'lead_id' = lead1::text;
  ok := n = 1;
  if not ok then fails := fails + 1; log := log || E'\nFAIL audit row for lead.updated: ' || n; end if;

  perform platform_admin_delete_lead(lead2);
  ok := not exists (select 1 from platform_leads where id = lead2);
  if not ok then fails := fails + 1; log := log || E'\nFAIL delete_lead'; end if;

  -- 6. deleting the account keeps the leads (user_id set null)
  delete from auth.users where id = u1;
  ok := (select user_id is null from platform_leads where id = lead1);
  if not ok then fails := fails + 1; log := log || E'\nFAIL lead should survive account delete with user_id null'; end if;

  if fails = 0 then
    raise exception 'SMOKE OK (rolled back)';
  else
    raise exception 'SMOKE FAILED (% assertions):%', fails, log;
  end if;
end $$;
