-- =============================================================================
-- Outreach Platform — 004 seed data, flags, vault secret, cron, realtime
-- Placeholders substituted by scripts/outreach-apply-migrations.sh:
--   __FUNCTIONS_BASE_URL__   e.g. https://<ref>.supabase.co/functions/v1/
--   __CRON_SECRET__          random secret shared with edge functions (OUTREACH_CRON_SECRET)
-- =============================================================================

-- Seeding helpers for the LinkedIn ceiling / warm-up rows. Since 025 both tables are keyed by provider, so a plain
-- `on conflict (action_type)` stops matching; these pick the right conflict target either way, which keeps every seed file
-- (004, 016, 022) safe to re-run before and after 025. Internal: revoked from signed-in users.
create or replace function outreach__seed_linkedin_ceilings(p jsonb) returns void
language plpgsql set search_path = public, extensions as $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'outreach_platform_ceilings' and column_name = 'provider') then
    execute $q$insert into outreach_platform_ceilings(provider, action_type, per_day, per_week)
      select 'LINKEDIN', (x->>0)::outreach_action_type_t, (x->>1)::int, (x->>2)::int from jsonb_array_elements($1) x
      on conflict (provider, action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week$q$ using p;
  else
    execute $q$insert into outreach_platform_ceilings(action_type, per_day, per_week)
      select (x->>0)::outreach_action_type_t, (x->>1)::int, (x->>2)::int from jsonb_array_elements($1) x
      on conflict (action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week$q$ using p;
  end if;
end $$;

create or replace function outreach__seed_linkedin_warmup(p jsonb) returns void
language plpgsql set search_path = public, extensions as $$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'outreach_warmup_caps' and column_name = 'provider') then
    execute $q$insert into outreach_warmup_caps(provider, level, action_type, per_day)
      select 'LINKEDIN', (x->>0)::smallint, (x->>1)::outreach_action_type_t, (x->>2)::int from jsonb_array_elements($1) x
      on conflict (provider, level, action_type) do update set per_day = excluded.per_day$q$ using p;
  else
    execute $q$insert into outreach_warmup_caps(level, action_type, per_day)
      select (x->>0)::smallint, (x->>1)::outreach_action_type_t, (x->>2)::int from jsonb_array_elements($1) x
      on conflict (level, action_type) do update set per_day = excluded.per_day$q$ using p;
  end if;
end $$;
revoke execute on function outreach__seed_linkedin_ceilings(jsonb) from public, anon, authenticated;
revoke execute on function outreach__seed_linkedin_warmup(jsonb) from public, anon, authenticated;

-- Platform ceilings (immutable; service-role editable only)
select outreach__seed_linkedin_ceilings((select jsonb_agg(jsonb_build_array(t, d, w)) from (values
  ('invite',80,150),('profile_view',100,null),('message',100,null),('inmail',50,null),
  ('like',100,null),('comment',100,null),('endorse',50,null),('search_page',50,null),
  ('withdraw',20,null),('email',150,null),('reply',100000,null),('relations_poll',3,null),('call_api',100000,null)
) x(t, d, w)));

-- Warmup cap table (levels 0..5)
select outreach__seed_linkedin_warmup((select jsonb_agg(jsonb_build_array(l, t, v)) from (values
  (0,'invite',4),(0,'message',5),(0,'profile_view',10),(0,'like',5),(0,'comment',0),(0,'inmail',0),(0,'search_page',5),(0,'endorse',0),(0,'withdraw',2),(0,'email',20),
  (1,'invite',9),(1,'message',10),(1,'profile_view',20),(1,'like',10),(1,'comment',3),(1,'inmail',5),(1,'search_page',10),(1,'endorse',3),(1,'withdraw',4),(1,'email',40),
  (2,'invite',15),(2,'message',20),(2,'profile_view',30),(2,'like',15),(2,'comment',5),(2,'inmail',10),(2,'search_page',20),(2,'endorse',5),(2,'withdraw',6),(2,'email',60),
  (3,'invite',25),(3,'message',35),(3,'profile_view',40),(3,'like',20),(3,'comment',8),(3,'inmail',20),(3,'search_page',40),(3,'endorse',8),(3,'withdraw',8),(3,'email',80),
  (4,'invite',35),(4,'message',50),(4,'profile_view',50),(4,'like',30),(4,'comment',10),(4,'inmail',30),(4,'search_page',60),(4,'endorse',10),(4,'withdraw',10),(4,'email',100),
  (5,'invite',45),(5,'message',60),(5,'profile_view',60),(5,'like',30),(5,'comment',10),(5,'inmail',40),(5,'search_page',80),(5,'endorse',10),(5,'withdraw',10),(5,'email',120)
) x(l, t, v)));

-- Global flags
insert into outreach_flags(key, value) values
  ('functions_base_url', to_jsonb('__FUNCTIONS_BASE_URL__'::text)),
  ('planner_enabled', 'true'::jsonb),
  ('tick_enabled', 'true'::jsonb)
on conflict (key) do update set value = excluded.value;

-- Vault secret for cron → edge function auth
do $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'outreach_cron_secret';
  if sid is null then
    perform vault.create_secret('__CRON_SECRET__', 'outreach_cron_secret', 'Outreach platform cron secret (x-cron-secret header)');
  else
    perform vault.update_secret(sid, '__CRON_SECRET__', 'outreach_cron_secret', 'Outreach platform cron secret (x-cron-secret header)');
  end if;
end $$;

-- Realtime publication
do $$
declare t text;
begin
  for t in select unnest(array['outreach_messages','outreach_chats','outreach_senders','outreach_node_stats','outreach_tasks','outreach_actions','outreach_enrollments','outreach_import_jobs']) loop
    begin
      execute format('alter publication supabase_realtime add table %I', t);
    exception when duplicate_object then null;
    when others then raise notice 'realtime add % skipped: %', t, sqlerrm;
    end;
  end loop;
end $$;

-- pg_cron schedule (idempotent: unschedule by name first)
do $$
declare j record;
begin
  for j in select jobid, jobname from cron.job where jobname like 'outreach-%' loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('outreach-tick',           '* * * * *',    $$select outreach_invoke('outreach-worker-tick')$$);
select cron.schedule('outreach-inbound',        '10 seconds',   $$select outreach_invoke('outreach-process-inbound')$$);
select cron.schedule('outreach-ai-classify',    '15 seconds',   $$select outreach_invoke('outreach-ai-classify')$$);
select cron.schedule('outreach-planner',        '5 * * * *',    $$select outreach_invoke('outreach-worker-planner')$$);
select cron.schedule('outreach-planner-topup',  '*/20 * * * *', $$select outreach_invoke('outreach-worker-planner', '{"mode":"topup"}'::jsonb)$$);
select cron.schedule('outreach-health',         '20 * * * *',   $$select outreach_invoke('outreach-worker-health')$$);
select cron.schedule('outreach-reconnect',      '*/15 * * * *', $$select outreach_invoke('outreach-worker-reconnect')$$);
select cron.schedule('outreach-imports',        '*/5 * * * *',  $$select outreach_invoke('outreach-worker-imports')$$);
select cron.schedule('outreach-withdraw',       '40 * * * *',   $$select outreach_invoke('outreach-worker-withdraw')$$);
select cron.schedule('outreach-relations-poll', '50 * * * *',   $$select outreach_invoke('outreach-worker-relations-poll')$$);
select cron.schedule('outreach-outbound-hooks', '30 seconds',   $$select outreach_invoke('outreach-outbound-webhooks')$$);
select cron.schedule('outreach-billing',        '15 3 * * *',   $$select outreach_invoke('outreach-billing-sync')$$);
select cron.schedule('outreach-sweep',          '*/5 * * * *',  $$select outreach_sweep_stale_reservations()$$);
select cron.schedule('outreach-cleanup',        '0 4 * * *',    $$delete from outreach_inbound_events where processed_at < now() - interval '30 days'; delete from outreach_outbound_webhook_deliveries where delivered_at < now() - interval '30 days'; delete from outreach_rate_limits where window_end < now() - interval '1 day'; delete from outreach_audit_log where at < now() - interval '90 days'; delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
