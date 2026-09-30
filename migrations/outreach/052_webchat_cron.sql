-- 052_webchat_cron.sql — Web chat cron jobs. Apply AFTER the `outreach-webchat-worker` function is deployed
-- (bash scripts/outreach-deploy-functions.sh webchat-worker). Idempotent.
--   outreach-webchat-continuity   every minute: continuity email digests (PRD §9, batched per conversation)
--   outreach-webchat-maintenance  every 5 min: wake snoozed chats, unassign offline agents, purge stale uploads / old page views
do $$ declare j text; begin
  foreach j in array array['outreach-webchat-continuity','outreach-webchat-maintenance'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('outreach-webchat-continuity',  '* * * * *',   $$select outreach_invoke('outreach-webchat-worker', '{"mode":"continuity"}'::jsonb)$$);
select cron.schedule('outreach-webchat-maintenance', '*/5 * * * *', $$select outreach_invoke('outreach-webchat-worker', '{"mode":"maintenance"}'::jsonb)$$);
