-- 038 — AI replies: cron jobs (ai-auto-reply-PRD.md §12.2). Apply AFTER outreach-ai-reply-worker is deployed
-- (a job that invokes a missing function only logs 404s, but there is no reason to). Idempotent: jobs are replaced.
--   draft        every 15 s   F32 worker
--   dispatch     every minute F33 dispatcher
--   maintenance  */15 min     F35 expire + stuck-run recovery + takeover pauses ending
--   breakers     :07 hourly   F36 circuit breakers
--   daily        03:30 UTC    graduation refresh, managers' daily summary, owners' weekly digest (Mondays)
-- Kill switch: select cron.unschedule(jobname) from cron.job where jobname like 'outreach-ai-reply%';

do $$
declare j text;
begin
  foreach j in array array['outreach-ai-reply-worker','outreach-ai-reply-dispatch','outreach-ai-reply-maintenance','outreach-ai-reply-breakers','outreach-ai-reply-daily'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

select cron.schedule('outreach-ai-reply-worker',      '15 seconds',   $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"draft"}'::jsonb)$$);
select cron.schedule('outreach-ai-reply-dispatch',    '* * * * *',    $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"dispatch"}'::jsonb)$$);
select cron.schedule('outreach-ai-reply-maintenance', '*/15 * * * *', $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"maintenance"}'::jsonb)$$);
select cron.schedule('outreach-ai-reply-breakers',    '7 * * * *',    $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"breakers"}'::jsonb)$$);
select cron.schedule('outreach-ai-reply-daily',       '30 3 * * *',   $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"daily"}'::jsonb)$$);
