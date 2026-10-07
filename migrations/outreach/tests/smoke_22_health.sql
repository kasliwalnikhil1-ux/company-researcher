-- Smoke test — 081/082 Health (health-page-PRD.md §13, the SQL half). Builds fixtures, asserts, then RAISES so everything
-- rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_22_health.sql
-- Dry-run of an unapplied migration: cat migrations/outreach/081_health.sql migrations/outreach/082_health_rpcs.sql tests/smoke_22_health.sql > t.sql; bash scripts/outreach-sql.sh t.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int; t text; r record; adm uuid; ws uuid; u_owner uuid; marker text := 'SMOKE22-LEAD-' || encode(gen_random_bytes(4), 'hex');
  procedure_ok boolean;
begin
  select user_id into adm from platform_admins limit 1;
  select m.user_id into u_owner from outreach_members m where m.user_id not in (select user_id from platform_admins) order by m.created_at limit 1;
  if adm is null or u_owner is null then raise exception 'SMOKE FAIL: this test needs a platform admin and one non-admin active user'; end if;

  -- ============================================================ 1. run_done aggregates one row per run into fn_stats / api_stats, scrubs, keeps no bodies
  perform ops.run_done(jsonb_build_object('fn', 'smoke-fn', 'outcome', 'ok', 'duration_ms', 120, 'items', 3, 'status', 200, 'calls', '[]'::jsonb));
  perform ops.run_done(jsonb_build_object('fn', 'smoke-fn', 'outcome', 'failed', 'duration_ms', 9000, 'items', 0, 'status', 500, 'error_code', 'E_BOOM',
    'error_text', 'lead ' || marker || ' failed for x@y.com phone +91 98765 43210 token sk-abcdefghijklmnop ?secret=1',
    'calls', jsonb_build_array(jsonb_build_object('provider', 'unipile', 'group', 'POST /chats', 'status', 429, 'ms', 80), jsonb_build_object('provider', 'unipile', 'group', 'POST /chats', 'status', 500, 'ms', 300, 'error_text', 'boom ' || marker),
                               jsonb_build_object('provider', 'ai', 'group', 'reply_draft', 'status', 401, 'ms', 50), jsonb_build_object('provider', 'ai:own', 'group', 'reply_draft', 'status', 200, 'ms', 50))));
  select runs, failed, slow, items into r from ops.fn_stats where fn = 'smoke-fn' order by bucket desc limit 1;
  if r.runs = 2 and r.failed = 1 and r.slow = 1 and r.items = 3 then log := log || E'\n1a ok fn_stats 2 runs, 1 failed, 1 slow, 3 items'; else fails := fails + 1; log := log || E'\n1a FAIL fn_stats ' || row_to_json(r); end if;
  select error_text into t from ops.fn_problems where fn = 'smoke-fn' and outcome = 'failed' order by at desc limit 1;
  if t not like '%x@y.com%' and t not like '%98765%' and t not like '%sk-abcdefghijklmnop%' and t not like '%secret=1%' and t like '%[removed]%' then log := log || E'\n1b ok error text scrubbed: ' || t; else fails := fails + 1; log := log || E'\n1b FAIL scrub: ' || coalesce(t, 'null'); end if;
  select calls, failed, rate_limited, auth_failed into r from ops.api_stats where provider = 'unipile' and endpoint_group = 'POST /chats' order by bucket desc limit 1;
  if r.calls = 2 and r.failed = 1 and r.rate_limited = 1 then log := log || E'\n1c ok api_stats unipile 2 calls, 1 failed, 1 rate-limited'; else fails := fails + 1; log := log || E'\n1c FAIL api_stats ' || row_to_json(r); end if;
  select auth_failed into n from ops.api_stats where provider = 'ai' and endpoint_group = 'reply_draft' order by bucket desc limit 1;
  if n = 1 then log := log || E'\n1d ok ai auth failure counted'; else fails := fails + 1; log := log || E'\n1d FAIL ai auth_failed ' || coalesce(n::text, 'null'); end if;
  if exists (select 1 from ops.api_stats where provider = 'ai:own') then log := log || E'\n1e ok own-key calls counted apart (ai:own)'; else fails := fails + 1; log := log || E'\n1e FAIL ai:own missing'; end if;

  -- ============================================================ 2. the two-in-a-row rule, immediate checks, back to green
  delete from ops.health_state where check_key in ('db-2', 'flow-4');
  perform ops.health_apply('db-2', 'watch', 65, 's', null);
  select status, pending into r from ops.health_state where check_key = 'db-2';
  if r.status = 'ok' and r.pending = 'watch' then log := log || E'\n2a ok first amber is pending, still green'; else fails := fails + 1; log := log || E'\n2a FAIL ' || row_to_json(r); end if;
  perform ops.health_apply('db-2', 'watch', 66, 's', null);
  select status, pending into r from ops.health_state where check_key = 'db-2';
  if r.status = 'watch' and r.pending is null then log := log || E'\n2b ok second amber shows'; else fails := fails + 1; log := log || E'\n2b FAIL ' || row_to_json(r); end if;
  perform ops.health_apply('db-2', 'ok', 10, 's', null);
  select status into t from ops.health_state where check_key = 'db-2';
  if t = 'watch' then log := log || E'\n2c ok one green does not clear it'; else fails := fails + 1; log := log || E'\n2c FAIL ' || t; end if;
  perform ops.health_apply('db-2', 'ok', 10, 's', null);
  select status into t from ops.health_state where check_key = 'db-2';
  if t = 'ok' then log := log || E'\n2d ok two greens clear it'; else fails := fails + 1; log := log || E'\n2d FAIL ' || t; end if;
  perform ops.health_apply('flow-4', 'act', 18, 's', null);
  select status into t from ops.health_state where check_key = 'flow-4';
  if t = 'act' then log := log || E'\n2e ok immediate check is red on the first check (test 4)'; else fails := fails + 1; log := log || E'\n2e FAIL ' || t; end if;
  perform ops.health_apply('db-2', 'unknown', null, 'Couldn''t check', null, 'boom');
  select status, error into r from ops.health_state where check_key = 'db-2';
  if r.status = 'unknown' and r.error = 'boom' then log := log || E'\n2f ok a check that cannot run is grey at once, never green (D2)'; else fails := fails + 1; log := log || E'\n2f FAIL ' || row_to_json(r); end if;
  select count(*) into n from ops.health_results where check_key = 'db-2' and at > now() - interval '1 minute';
  if n >= 5 then log := log || E'\n2g ok history rows written'; else fails := fails + 1; log := log || E'\n2g FAIL history ' || n; end if;

  -- ============================================================ 3. health_record from an outside source uses the thresholds
  perform ops.health_record('db-6', 95, 'cpu', null);
  perform ops.health_record('db-6', 95, 'cpu', null);
  select status into t from ops.health_state where check_key = 'db-6';
  if t = 'act' then log := log || E'\n3a ok health_record → act from the act line'; else fails := fails + 1; log := log || E'\n3a FAIL ' || t; end if;

  -- ============================================================ 4. health_run runs every SQL check without error
  j := ops.health_run();
  if jsonb_array_length(j->'errors') = 0 and (j->>'ran')::int >= 45 then log := log || E'\n4a ok health_run ran ' || (j->>'ran') || ' checks, no errors'; else fails := fails + 1; log := log || E'\n4a FAIL ' || j::text; end if;
  if not exists (select 1 from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.enabled and s.status is null) then log := log || E'\n4b ok every enabled check has a state'; else fails := fails + 1; log := log || E'\n4b FAIL missing states: ' || (select string_agg(c.key, ',') from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.enabled and s.status is null); end if;
  if ops.health_ping() = 'ok' then log := log || E'\n4c ok health_ping says ok after a run'; else fails := fails + 1; log := log || E'\n4c FAIL ping'; end if;

  -- ============================================================ 5. no lead data in the ops tables (test 9): the marker never lands in evidence
  perform ops.run_done(jsonb_build_object('fn', 'smoke-fn2', 'outcome', 'failed', 'duration_ms', 1, 'error_text', 'lead name ' || marker || ' email ' || lower(marker) || '@acme.io'));
  j := ops.health_run();
  select count(*) into n from (
    select 1 from ops.health_state where evidence::text like '%' || lower(marker) || '@acme.io%' or summary like '%' || lower(marker) || '@acme.io%'
    union all select 1 from ops.fn_problems where error_text like '%@acme.io%'
    union all select 1 from ops.api_problems where error_text like '%@acme.io%') x;
  if n = 0 then log := log || E'\n5a ok no email address reaches the ops tables'; else fails := fails + 1; log := log || E'\n5a FAIL marker found ' || n; end if;

  -- ============================================================ 6. access: a non-admin is refused by every page RPC (test 8); an admin is not
  perform set_config('request.jwt.claims', json_build_object('sub', u_owner, 'role', 'authenticated')::text, true);
  procedure_ok := false;
  begin perform outreach_health_overview(); exception when others then procedure_ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if procedure_ok then log := log || E'\n6a ok non-admin refused (overview)'; else fails := fails + 1; log := log || E'\n6a FAIL non-admin allowed'; end if;
  procedure_ok := false;
  begin perform outreach_health_snooze('db-2', now() + interval '1 day', 'x'); exception when others then procedure_ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if procedure_ok then log := log || E'\n6b ok non-admin refused (snooze)'; else fails := fails + 1; log := log || E'\n6b FAIL'; end if;
  procedure_ok := false;
  begin perform outreach_health_usage(); exception when others then procedure_ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if procedure_ok then log := log || E'\n6c ok non-admin refused (usage)'; else fails := fails + 1; log := log || E'\n6c FAIL'; end if;
  -- the service-only RPCs refuse a signed-in user too
  procedure_ok := false;
  begin perform outreach_ops_run_done('{}'::jsonb); exception when others then procedure_ok := sqlerrm like 'E_FORBIDDEN%'; end;
  if procedure_ok then log := log || E'\n6d ok signed-in user cannot write run_done'; else fails := fails + 1; log := log || E'\n6d FAIL'; end if;
  -- client events: a signed-in user may report, the list of events is fixed, values are not stored
  perform outreach_report_client_event('event', 'rage_click', '/outreach/leads', jsonb_build_object('control', 'Save', 'count', 5));
  perform outreach_report_client_event('event', 'form_rejected', '/outreach/sequences/new', jsonb_build_object('form', 'sequence', 'fields', jsonb_build_array('name', 'sender_pool'), 'values', jsonb_build_object('name', marker)));
  perform outreach_report_client_event('error', null, '/outreach/inbox', jsonb_build_object('message', 'TypeError: cannot read x of undefined (' || marker || '@acme.io)', 'fingerprint', 'abc', 'app_version', '1.0'));
  select count(*) into n from ops.product_events where user_id = u_owner and name in ('rage_click', 'form_rejected') and at > now() - interval '1 minute';
  if n = 2 then log := log || E'\n6e ok two events stored'; else fails := fails + 1; log := log || E'\n6e FAIL events ' || n; end if;
  if not exists (select 1 from ops.product_events where user_id = u_owner and detail::text like '%' || marker || '%') then log := log || E'\n6f ok form values never stored (D7)'; else fails := fails + 1; log := log || E'\n6f FAIL values stored'; end if;
  select message into t from ops.client_errors where user_id = u_owner order by at desc limit 1;
  if t not like '%@acme.io%' then log := log || E'\n6g ok error message scrubbed: ' || t; else fails := fails + 1; log := log || E'\n6g FAIL ' || t; end if;
  procedure_ok := false;
  begin perform outreach_report_client_event('event', 'page_view', '/x', '{}'::jsonb); exception when others then procedure_ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if procedure_ok then log := log || E'\n6h ok an event outside the fixed list is refused'; else fails := fails + 1; log := log || E'\n6h FAIL'; end if;
  -- the rate limit: 30 a minute, then dropped silently
  for n in 1..40 loop perform outreach_report_client_event('event', 'help_opened', '/x', '{}'::jsonb); end loop;
  select count(*) into n from ops.product_events where user_id = u_owner and name = 'help_opened' and at > now() - interval '1 minute';
  if n <= 30 then log := log || E'\n6i ok rate limit held (' || n || ' of 40 stored)'; else fails := fails + 1; log := log || E'\n6i FAIL ' || n; end if;

  -- ============================================================ 7. the admin: snooze (test 11), thresholds, settings, manual usage, audit rows
  perform set_config('request.jwt.claims', json_build_object('sub', adm, 'role', 'authenticated')::text, true);
  perform ops.health_apply('flow-4', 'act', 18, 's', null);
  perform outreach_health_snooze('flow-4', now() + interval '7 days', 'LinkedIn weekly cap');
  j := outreach_health_overview();
  if (j->'counts'->>'act')::int = (select count(*) from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.enabled and s.status = 'act' and c.key <> 'flow-4' and (c.snoozed_until is null or c.snoozed_until <= now()))
     and (j->'counts'->>'snoozed')::int >= 1 then log := log || E'\n7a ok a snoozed red check leaves the top line and is counted as snoozed'; else fails := fails + 1; log := log || E'\n7a FAIL ' || (j->'counts')::text; end if;
  perform outreach_health_snooze('flow-4', null, null);
  perform outreach_health_set_threshold('db-2', 61, 81);
  select watch_at, act_at into r from ops.health_checks where key = 'db-2';
  if r.watch_at = 61 and r.act_at = 81 then log := log || E'\n7b ok thresholds editable without a deploy (D5)'; else fails := fails + 1; log := log || E'\n7b FAIL'; end if;
  procedure_ok := false;
  begin perform outreach_health_set_threshold('db-2', 90, 80); exception when others then procedure_ok := sqlerrm like 'E_PAYLOAD_INVALID%'; end;
  if procedure_ok then log := log || E'\n7c ok act below watch refused'; else fails := fails + 1; log := log || E'\n7c FAIL'; end if;
  j := outreach_health_settings_set(jsonb_build_object('email_to', jsonb_build_array('Ops@Example.com', 'not-an-email'), 'ai_monthly_budget_usd', 150, 'email_hour', 8));
  if j->'email_to' = '["ops@example.com"]'::jsonb and (j->>'ai_monthly_budget_usd')::numeric = 150 and (j->>'email_hour')::int = 8 then log := log || E'\n7d ok settings saved, emails cleaned'; else fails := fails + 1; log := log || E'\n7d FAIL ' || j::text; end if;
  perform outreach_health_set_manual_usage('egress', (5 * 1024^3)::numeric);
  j := outreach_health_usage();
  select x into j from jsonb_array_elements(j->'rows') x where x->>'key' = 'egress';
  if (j->>'used')::numeric = (5 * 1024^3)::numeric and (j->>'manual')::boolean then log := log || E'\n7e ok by-hand usage stored and shown'; else fails := fails + 1; log := log || E'\n7e FAIL ' || coalesce(j::text, 'null'); end if;
  select count(*) into n from outreach_audit_log where actor = adm and action like 'health.%' and at > now() - interval '1 minute';
  if n >= 5 then log := log || E'\n7f ok ' || n || ' audit rows for the admin writes'; else fails := fails + 1; log := log || E'\n7f FAIL audit ' || n; end if;
  j := outreach_health_check('db-2');
  if j->>'key' = 'db-2' and j ? 'spark' and j ? 'recent' then log := log || E'\n7g ok health_check returns evidence, spark and recent'; else fails := fails + 1; log := log || E'\n7g FAIL'; end if;
  j := outreach_health_stuck();
  if j ? 'who' and j ? 'where' then log := log || E'\n7h ok health_stuck shape'; else fails := fails + 1; log := log || E'\n7h FAIL'; end if;

  j := ops.health_cleanup();
  if j ? 'health_results' then log := log || E'\n7i ok cleanup ran: ' || j::text; else fails := fails + 1; log := log || E'\n7i FAIL cleanup'; end if;

  -- ============================================================ 8. the collectors' RPCs as service role (only the security-definer wrappers are reachable); the daily payload
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('role', 'service_role', true);
  perform outreach_ops_kv_set('smoke', '{"a":1}'::jsonb);
  if outreach_ops_kv_get('smoke') = '{"a":1}'::jsonb then log := log || E'\n8a ok kv'; else fails := fails + 1; log := log || E'\n8a FAIL kv'; end if;
  perform outreach_ops_health_record('api-3.unipile', 3, 'key rejected', null, 'act');
  j := outreach_ops_alerts();
  if exists (select 1 from jsonb_array_elements(j->'due') d where d->>'key' = 'api-3.unipile') then log := log || E'\n8b ok immediate red check is due for the urgent email'; else fails := fails + 1; log := log || E'\n8b FAIL due ' || (j->'due')::text; end if;
  perform outreach_ops_alerts_mark(array['api-3.unipile'], 'act');
  j := outreach_ops_alerts();
  if not exists (select 1 from jsonb_array_elements(j->'due') d where d->>'key' = 'api-3.unipile') then log := log || E'\n8c ok not sent twice within 4 hours'; else fails := fails + 1; log := log || E'\n8c FAIL'; end if;
  perform outreach_ops_health_record('api-3.unipile', 0, 'fine', null, 'ok');
  perform outreach_ops_health_record('api-3.unipile', 0, 'fine', null, 'ok');   -- back to green takes two in a row
  j := outreach_ops_alerts();
  if exists (select 1 from jsonb_array_elements(j->'recovered') d where d->>'key' = 'api-3.unipile') then log := log || E'\n8d ok recovery email due once it is green'; else fails := fails + 1; log := log || E'\n8d FAIL'; end if;
  j := outreach_ops_daily(false);
  if j ? 'counts' and j ? 'yesterday' and j ? 'upgrade' and jsonb_array_length(j->'yesterday') = 13 and j ? 'stuck' then log := log || E'\n8e ok daily payload: ' || (j->'upgrade'->>'text'); else fails := fails + 1; log := log || E'\n8e FAIL ' || left(j::text, 200); end if;

  -- ============================================================ 9. cron interval parsing and the job → function mapping
  if ops.cron_interval_seconds('10 seconds') = 10 and ops.cron_interval_seconds('*/5 * * * *') = 300 and ops.cron_interval_seconds('* * * * *') = 60 and ops.cron_interval_seconds('5 * * * *') = 3600
     and ops.cron_interval_seconds('30 4 * * *') = 86400 and ops.cron_interval_seconds('35 3 * * 1') = 604800 then log := log || E'\n9a ok cron intervals'; else fails := fails + 1; log := log || E'\n9a FAIL cron intervals'; end if;
  if ops.cron_job_fn($q$select outreach_invoke('outreach-worker-tick', '{"x":1}'::jsonb)$q$) = 'outreach-worker-tick' and ops.cron_job_fn('select ops.health_run()') is null then log := log || E'\n9b ok job → function'; else fails := fails + 1; log := log || E'\n9b FAIL'; end if;
  if ops.scrub('call me at +91 98765 43210 or a.b@c.io, key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123 ?token=1 end') not similar to '%(98765|a.b@c.io|AIzaSy|token=1)%' then log := log || E'\n9c ok scrub'; else fails := fails + 1; log := log || E'\n9c FAIL scrub: ' || ops.scrub('call me at +91 98765 43210 or a.b@c.io, key AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123 ?token=1 end'); end if;

  if fails > 0 then raise exception E'SMOKE FAIL (% failures)%', fails, log; end if;
  raise exception E'SMOKE OK%\n(rolled back)', log;
end $$;
