-- 061_billing_cron.sql — billing v2 cron jobs. Apply AFTER the new `outreach-billing-sync` function is deployed
-- (bash scripts/outreach-deploy-functions.sh billing-sync). Idempotent.
--   outreach-billing        hourly (was daily 03:15): trial expiry → disconnect at the end of day 7 (not up to a day later),
--                           past-due day-7 suspension, 14-day billing pause → disconnect, reconciliation, connector deletes,
--                           the emails the billing lifecycle owes
--   outreach-billing-daily  03:15: usage row per workspace, the cost report, deletion of workspaces past their date
--                           (only when the platform flag billing_data_deletion is on)
do $$ declare j text; begin
  foreach j in array array['outreach-billing','outreach-billing-daily'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('outreach-billing',       '7 * * * *',  $$select outreach_invoke('outreach-billing-sync', '{"mode":"hourly"}'::jsonb)$$);
select cron.schedule('outreach-billing-daily', '15 3 * * *', $$select outreach_invoke('outreach-billing-sync', '{"mode":"daily"}'::jsonb)$$);
