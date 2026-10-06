-- 077_reply_alerts_cron.sql — schedules for reply alerts (reply-notifications-PRD.md §7.2, §9). Requires 076.
-- Apply AFTER deploying the `outreach-notify-push` edge function (the job calls it). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/077_reply_alerts_cron.sql
--
-- outreach-notify-push   every 10 s, only when a push is due (an alert also nudges the function right away; this sweeps
--                        up retries and anything the nudge missed). Target: on screen within 15 s of the message.
-- outreach-alerts-cleanup daily: reply / assignment alerts older than 60 days, stale queue rows, long-dead browsers.

do $$ begin perform cron.unschedule('outreach-notify-push'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('outreach-alerts-cleanup'); exception when others then null; end $$;

select cron.schedule('outreach-notify-push', '10 seconds',
  $$select outreach_invoke('outreach-notify-push', '{"mode":"send"}'::jsonb) where exists (select 1 from outreach_push_queue where next_at <= now() and (claimed_until is null or claimed_until < now()))$$);
select cron.schedule('outreach-alerts-cleanup', '50 3 * * *', $$select outreach_alerts_cleanup()$$);
