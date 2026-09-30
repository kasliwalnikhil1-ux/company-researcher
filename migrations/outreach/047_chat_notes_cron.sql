-- 047 — private notes: cron jobs (private-notes-PRD.md §10). Apply AFTER `outreach-notes-worker` is deployed. Idempotent.
--   emails  every minute   F45: mention emails (unread past the person's delay, batched per conversation)
--   purge   daily 03:40    F46: purge bodies + files of notes deleted more than 30 days ago
do $$
declare j text;
begin
  foreach j in array array['outreach-notes-emails', 'outreach-notes-purge'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('outreach-notes-emails', '* * * * *',  $$select outreach_invoke('outreach-notes-worker', '{"mode":"emails"}'::jsonb)$$);
select cron.schedule('outreach-notes-purge',  '40 3 * * *', $$select outreach_invoke('outreach-notes-worker', '{"mode":"purge"}'::jsonb)$$);
