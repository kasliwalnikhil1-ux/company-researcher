-- 083_health_cron.sql — schedules for the Health page (health-page-PRD.md §11) and the clean-up. Requires 081 + 082.
-- Apply AFTER deploying outreach-health-collect and outreach-health-daily (the jobs call them). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/083_health_cron.sql
--
-- outreach-health-run      every 5 min, SQL only: all database-sourced checks (D3; keeps working when functions are down)
-- outreach-health-collect  every 5 min: the metrics endpoint, the logs API, urgent emails (F48)
-- outreach-health-daily    hourly at :30; acts once a day at the hour in Health settings (F49)
-- outreach-health-cleanup  04:10 daily: the ops retention periods + cron.job_run_details older than 7 days (PRD §10)

do $$ begin perform cron.unschedule('outreach-health-run'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('outreach-health-collect'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('outreach-health-daily'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('outreach-health-cleanup'); exception when others then null; end $$;

select cron.schedule('outreach-health-run',     '*/5 * * * *', $$select ops.health_run()$$);
select cron.schedule('outreach-health-collect', '*/5 * * * *', $$select outreach_invoke('outreach-health-collect', '{"mode":"cron"}'::jsonb)$$);
select cron.schedule('outreach-health-daily',   '30 * * * *',  $$select outreach_invoke('outreach-health-daily', '{"mode":"cron"}'::jsonb)$$);
select cron.schedule('outreach-health-cleanup', '10 4 * * *',  $$select ops.health_cleanup()$$);

-- first results right away, so the page is not empty until the next 5-minute mark
select ops.health_run();
