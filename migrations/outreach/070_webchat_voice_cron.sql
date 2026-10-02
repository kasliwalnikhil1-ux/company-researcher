-- 070_webchat_voice_cron.sql — Voice for the website assistant: the worker's cron job. Apply AFTER `outreach-webchat-worker`
-- is deployed with the voice mode (bash scripts/outreach-deploy-functions.sh webchat-worker). Idempotent.
--   outreach-webchat-voice  every minute: fetch the calls whose post-call webhook never arrived (10 minutes after they
--                           ended), delete at the voice provider what a removed website / an erased visitor left there,
--                           and (every 5th minute) bring every voice agent in line with its website's settings.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'outreach-webchat-voice') then perform cron.unschedule('outreach-webchat-voice'); end if;
end $$;
select cron.schedule('outreach-webchat-voice', '* * * * *', $$select outreach_invoke('outreach-webchat-worker', '{"mode":"voice"}'::jsonb)$$);
