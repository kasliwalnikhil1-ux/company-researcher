-- 064_ai_hub_cron.sql — AI hub: the Review-mode job of the website assistant. Apply AFTER `outreach-webchat-worker` is
-- deployed with mode "review" (bash scripts/outreach-deploy-functions.sh webchat-worker). Idempotent.
--   outreach-webchat-review   every minute: write the suggestions a request did not finish (three tries), expire the ones
--                             nobody answered within the website's review timeout and post its offline message
--                             (docs/outreach/AI-HUB.md §6; outreach_webchat_suggest_claim + outreach_webchat_review_sweep)
do $$ begin
  if exists (select 1 from cron.job where jobname = 'outreach-webchat-review') then perform cron.unschedule('outreach-webchat-review'); end if;
end $$;
select cron.schedule('outreach-webchat-review', '* * * * *', $$select outreach_invoke('outreach-webchat-worker', '{"mode":"review"}'::jsonb)$$);
