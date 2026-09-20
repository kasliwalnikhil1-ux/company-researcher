-- =============================================================================
-- Outreach Platform — 016 budgets for the new action types + cron for the new workers
-- Idempotent. Does not touch the jobs created by 004 / 008.
-- =============================================================================

-- Every LinkedIn call is budgeted (plan §3 checklist): posts are their own bucket, ~100/day per Unipile's limits page.
insert into outreach_platform_ceilings(action_type, per_day, per_week) values
  ('post_fetch', 100, null), ('follow', 50, null), ('find_email', 100000, null)
on conflict (action_type) do update set per_day = excluded.per_day, per_week = excluded.per_week;

insert into outreach_warmup_caps(level, action_type, per_day)
select l, t::outreach_action_type_t, v from (values
  (0,'post_fetch',5),(1,'post_fetch',10),(2,'post_fetch',15),(3,'post_fetch',20),(4,'post_fetch',30),(5,'post_fetch',30),   -- in line with `like`
  (0,'follow',0),(1,'follow',3),(2,'follow',5),(3,'follow',8),(4,'follow',12),(5,'follow',15)
) x(l,t,v)
on conflict (level, action_type) do update set per_day = excluded.per_day;

insert into outreach_flags(key, value) values ('portal_cname_target', to_jsonb('cname.vercel-dns.com'::text)) on conflict (key) do nothing;

do $$
declare j record;
begin
  for j in select jobid from cron.job where jobname in ('outreach-rollup','outreach-auto-enroll','outreach-import-schedules','outreach-enrich','outreach-ai-variables',
                                                        'outreach-crm-sync','outreach-reports','outreach-domain-check','outreach-cleanup-v2') loop
    perform cron.unschedule(j.jobid);
  end loop;
end $$;

select cron.schedule('outreach-rollup',           '25 * * * *',   $$select outreach_rollup_all()$$);                       -- hourly: each workspace's "yesterday" closes at its own midnight
select cron.schedule('outreach-auto-enroll',      '*/10 * * * *', $$select outreach_run_auto_enroll()$$);
select cron.schedule('outreach-import-schedules', '*/15 * * * *', $$select outreach_run_import_schedules()$$);
select cron.schedule('outreach-enrich',           '*/10 * * * *', $$select outreach_invoke('outreach-worker-enrich')$$);
select cron.schedule('outreach-ai-variables',     '* * * * *',    $$select outreach_invoke('outreach-ai-variables')$$);     -- AI lines + AI routing decisions
select cron.schedule('outreach-crm-sync',         '*/5 * * * *',  $$select outreach_invoke('outreach-crm-sync')$$);
select cron.schedule('outreach-reports',          '0 * * * *',    $$select outreach_invoke('outreach-worker-reports')$$);   -- weekly sender report / digests / client reports, sent at 08:00 workspace time
select cron.schedule('outreach-domain-check',     '*/30 * * * *', $$select outreach_invoke('outreach-domain-check')$$);
select cron.schedule('outreach-cleanup-v2',       '30 4 * * *',   $$delete from outreach_api_idempotency where created_at < now() - interval '2 days'; delete from outreach_integration_events where at < now() - interval '14 days'; delete from outreach_crm_sync_log where at < now() - interval '90 days'; delete from outreach_auto_enroll_log where at < now() - interval '90 days'; delete from outreach_alerts where resolved_at < now() - interval '90 days'$$);

-- owners and managers get the weekly digest by default; they can switch it off in Reports
insert into outreach_report_schedules(workspace_id, kind, cadence)
select w.id, k.kind, 'weekly' from outreach_workspaces w cross join (values ('digest'), ('sender_report')) k(kind) where w.deleted_at is null
on conflict do nothing;

-- every workspace has a secrets row from day one (booking-webhook secret; LLM / finder keys are added later)
insert into outreach_workspace_secrets(workspace_id) select id from outreach_workspaces on conflict do nothing;

create or replace function outreach_trg_workspace_report_defaults() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into outreach_report_schedules(workspace_id, kind, cadence) values (new.id, 'digest', 'weekly'), (new.id, 'sender_report', 'weekly') on conflict do nothing;
  insert into outreach_workspace_secrets(workspace_id) values (new.id) on conflict do nothing;   -- carries the booking-webhook secret
  return null;
end $$;
drop trigger if exists outreach_workspace_report_defaults on outreach_workspaces;
create trigger outreach_workspace_report_defaults after insert on outreach_workspaces for each row execute function outreach_trg_workspace_report_defaults();

-- seeded stages of new workspaces carry their semantic kind
create or replace function outreach_seed_workspace_defaults(p_ws uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into outreach_stages(workspace_id, name, position, color, kind)
  select p_ws, x.n, x.p, x.c, x.k from (values
    ('New',0,'#6b7280','new'),('Contacted',1,'#3b82f6','contacted'),('Connected',2,'#8b5cf6','connected'),('Replied',3,'#f59e0b','replied'),
    ('Interested',4,'#10b981','interested'),('Meeting',5,'#06b6d4','meeting'),('Won',6,'#22c55e','won'),('Lost',7,'#ef4444','lost')) x(n,p,c,k)
  where not exists (select 1 from outreach_stages where workspace_id = p_ws);
end $$;
revoke execute on function outreach_seed_workspace_defaults(uuid) from public, anon, authenticated;
