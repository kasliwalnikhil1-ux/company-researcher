-- Smoke test — 084 cron dispatcher. Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_23_cron_dispatcher.sql
-- Nothing here calls an edge function: the tick runs with p_dry => true.
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int; b boolean; r record; t text;
  ws uuid; u_owner uuid; wh uuid; ev bigint;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  -- ============================================================ 1. schedule
  select count(*) into n from cron.job where jobname = 'outreach-tick' and schedule = '10 seconds' and command like '%outreach_cron_tick()%';
  if n = 1 then log := log || E'\n1a ok outreach-tick runs the dispatcher every 10 s'; else fails := fails + 1; log := log || E'\n1a FAIL outreach-tick job: ' || n; end if;
  select count(*) into n from cron.job where jobname in ('outreach-inbound', 'outreach-notify-push', 'outreach-ai-classify', 'outreach-ai-reply-worker', 'outreach-ai-reply-lead-notes',
    'outreach-outbound-hooks', 'outreach-ai-reply-dispatch', 'outreach-ai-reply-knowledge', 'outreach-ai-variables', 'outreach-notes-emails', 'outreach-transcribe',
    'outreach-webchat-continuity', 'outreach-webchat-review', 'outreach-webchat-voice');
  if n = 0 then log := log || E'\n1b ok the 14 frequent jobs are gone from pg_cron'; else fails := fails + 1; log := log || E'\n1b FAIL old jobs still scheduled: ' || n; end if;
  select count(*) into n from outreach_cron_jobs where active;
  if n = 16 then log := log || E'\n1c ok 16 dispatched jobs'; else fails := fails + 1; log := log || E'\n1c FAIL dispatched jobs: ' || n; end if;
  select count(*) into n from cron.job where jobname in ('outreach-sweep', 'outreach-imports', 'outreach-crm-sync', 'outreach-health-run', 'outreach-health-collect', 'outreach-webchat-maintenance');
  if n = 6 then log := log || E'\n1d ok the 5-minute jobs stay in pg_cron'; else fails := fails + 1; log := log || E'\n1d FAIL 5-minute jobs: ' || n; end if;

  -- ============================================================ 2. every guard runs and answers
  n := 0;
  for r in select name from outreach_cron_jobs order by name loop
    begin
      b := outreach_cron_has_work(r.name);
      if b is null then n := n + 1; log := log || E'\n   guard ' || r.name || ' returned null'; end if;
    exception when others then n := n + 1; log := log || E'\n   guard ' || r.name || ' raised: ' || sqlerrm;
    end;
  end loop;
  if n = 0 then log := log || E'\n2a ok all 16 guards run'; else fails := fails + 1; log := log || E'\n2a FAIL guards broken: ' || n; end if;
  if outreach_cron_has_work('no-such-job') then log := log || E'\n2b ok unknown name fails open'; else fails := fails + 1; log := log || E'\n2b FAIL unknown name'; end if;

  -- ============================================================ 3. guards follow the queues (inbound, outbound hooks)
  insert into outreach_inbound_events (source, event_type, payload) values ('smoke23', 'messaging', '{}') returning id into ev;
  if outreach_cron_has_work('inbound') then log := log || E'\n3a ok inbound: unprocessed event → work'; else fails := fails + 1; log := log || E'\n3a FAIL inbound with a pending event'; end if;
  update outreach_inbound_events set attempts = 5 where id = ev;
  b := outreach_cron_has_work('inbound');
  update outreach_inbound_events set processed_at = now(), attempts = 0 where id = ev;
  if not b or exists (select 1 from outreach_inbound_events e where e.id <> ev and e.processed_at is null and e.dead = false and e.attempts < 5)
     then log := log || E'\n3b ok inbound: an event at 5 attempts is not work'; else fails := fails + 1; log := log || E'\n3b FAIL inbound counted an abandoned event'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke23', 'smoke23-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_outbound_webhooks (workspace_id, url, events) values (ws, 'https://example.invalid/hook', array['lead.replied']) returning id into wh;
  insert into outreach_outbound_webhook_deliveries (webhook_id, workspace_id, event, payload, next_at) values (wh, ws, 'lead.replied', '{}', now() + interval '1 hour');
  b := outreach_cron_has_work('outbound-hooks');
  if not b or exists (select 1 from outreach_outbound_webhook_deliveries d where d.webhook_id <> wh and d.delivered_at is null and d.next_at <= now() and d.attempts < 5)
     then log := log || E'\n3c ok hooks: a delivery due in an hour is not work yet'; else fails := fails + 1; log := log || E'\n3c FAIL hooks counted a future delivery'; end if;
  update outreach_outbound_webhook_deliveries set next_at = now() - interval '1 second' where webhook_id = wh;
  if outreach_cron_has_work('outbound-hooks') then log := log || E'\n3d ok hooks: a due delivery → work'; else fails := fails + 1; log := log || E'\n3d FAIL hooks with a due delivery'; end if;

  -- ============================================================ 4. the tick respects each job's cadence (dry run: nothing is called)
  update outreach_cron_jobs set last_run_at = null;
  j := outreach_cron_tick(true);
  if (j->>'checked')::int = 16 and jsonb_array_length(j->'jobs') = 16 then log := log || E'\n4a ok first tick looks at all 16 jobs'; else fails := fails + 1; log := log || E'\n4a FAIL first tick: ' || j::text; end if;
  if (select bool_and(jsonb_typeof(x->'work') = 'boolean' and jsonb_typeof(x->'name') = 'string') from jsonb_array_elements(j->'jobs') x) then log := log || E'\n4b ok each job answers work yes/no';
     else fails := fails + 1; log := log || E'\n4b FAIL tick rows: ' || j::text; end if;
  if (select (x->>'work')::boolean from jsonb_array_elements(j->'jobs') x where x->>'name' = 'outbound-hooks') then log := log || E'\n4c ok the due delivery shows as work in the tick';
     else fails := fails + 1; log := log || E'\n4c FAIL tick missed the due delivery'; end if;
  if (select (x->>'work')::boolean from jsonb_array_elements(j->'jobs') x where x->>'name' = 'webchat-voice-sweep') then log := log || E'\n4d ok an unguarded job always runs';
     else fails := fails + 1; log := log || E'\n4d FAIL unguarded job skipped'; end if;
  update outreach_cron_jobs set last_run_at = now();
  j := outreach_cron_tick(true);
  if (j->>'checked')::int = 0 then log := log || E'\n4e ok nothing is due right after a run'; else fails := fails + 1; log := log || E'\n4e FAIL checked ' || (j->>'checked'); end if;
  update outreach_cron_jobs set last_run_at = now() - interval '12 seconds';
  j := outreach_cron_tick(true);
  select string_agg(x->>'name', ',' order by x->>'name') into t from jsonb_array_elements(j->'jobs') x;
  if t = 'inbound,notify-push' then log := log || E'\n4f ok after 12 s only the 10-second jobs are due'; else fails := fails + 1; log := log || E'\n4f FAIL due after 12 s: ' || coalesce(t, '-'); end if;
  update outreach_cron_jobs set last_run_at = now() - interval '61 seconds';
  j := outreach_cron_tick(true);
  if (j->>'checked')::int = 15 then log := log || E'\n4g ok after 61 s everything but the 5-minute sweep is due'; else fails := fails + 1; log := log || E'\n4g FAIL checked after 61 s: ' || (j->>'checked'); end if;
  update outreach_cron_jobs set active = false where name = 'tick';
  j := outreach_cron_tick(true);
  if (j->>'checked')::int = 14 then log := log || E'\n4h ok an inactive job is skipped (kill switch)'; else fails := fails + 1; log := log || E'\n4h FAIL inactive job: ' || (j->>'checked'); end if;

  -- ============================================================ 5. health sees the dispatched jobs
  select count(*) into n from outreach_cron_jobs where active and last_run_at < now() - interval '1 hour';
  if n = 0 then log := log || E'\n5a ok no dispatched job is an hour late (job-1 reads outreach_cron_jobs)'; else log := log || E'\n5a note: ' || n || ' dispatched jobs last looked at over an hour ago'; end if;
  select count(*) into n from ops.fn_config f where f.fn in (select fn from outreach_cron_jobs);
  if n >= 9 then log := log || E'\n5b ok fn_config has a slow threshold for the dispatched functions'; else fails := fails + 1; log := log || E'\n5b FAIL fn_config rows: ' || n; end if;
  if ops.cron_job_fn('select outreach_cron_tick()') is null then log := log || E'\n5c ok the dispatcher is not mistaken for a worker'; else fails := fails + 1; log := log || E'\n5c FAIL cron_job_fn'; end if;

  if fails > 0 then raise exception E'SMOKE FAIL (% failures)%', fails, log; end if;
  raise exception E'SMOKE OK%\n(rolled back)', log;
end $$;
