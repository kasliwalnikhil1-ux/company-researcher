-- 043 — AI replies v2: cron jobs (docs/outreach/AI-REPLIES-V2-CONTRACT.md §9). Apply AFTER the functions are deployed. Idempotent.
--   lead_notes   every 30 s   F39: lead-notes queue consumer
--   knowledge    every minute F42-adjacent: crawl / parse pending knowledge sources, refresh due ones
--   daily        (unchanged job) now also runs inactivity tasks + unanswered merge
do $$
declare j text;
begin
  foreach j in array array['outreach-ai-reply-lead-notes','outreach-ai-reply-knowledge'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('outreach-ai-reply-lead-notes', '30 seconds', $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"lead_notes"}'::jsonb)$$);
select cron.schedule('outreach-ai-reply-knowledge',  '* * * * *',  $$select outreach_invoke('outreach-ai-reply-worker', '{"mode":"knowledge"}'::jsonb)$$);
