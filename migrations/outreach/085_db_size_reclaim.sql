-- 085 — Database size: keep pg_cron history short and reclaim pg_net / cron-history bloat on a schedule.
--
-- Why: on 2026-10-12 the project was 1.28 GB against the 0.5 GB free allowance. 723 MB of it was `net._http_response`
-- (pg_net's response log) holding 1,500 live rows: the cron storm fixed by 084 and the catalogue sync in 080 pushed the
-- table to that size, pg_net's 6-hour TTL then deleted the rows, and autovacuum never gives file space back. Another
-- 98 MB was `cron.job_run_details` (7 days of the 10-second tick ≈ 135,000 rows) and 127 MB the August investors
-- backup schema. A one-off `vacuum full net._http_response` + `drop schema cleanup_backup_20260812` took it to 454 MB.
--
-- Now: the cron history is pruned to 2 days every night (the Health checks read 3 hours; 081's 7-day delete stays and
-- is a no-op), and once a week both tables are rewritten with `vacuum full` so a future burst cannot leave a large
-- empty file behind. Both tables are tiny when healthy, so the rewrite takes well under a second and the exclusive
-- lock is not noticeable; pg_cron runs commands outside a transaction block, which VACUUM requires.
-- Idempotent: cron.schedule replaces a job with the same name.

select cron.schedule('outreach-cron-history-prune', '45 4 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '2 days'$$);

select cron.schedule('outreach-db-reclaim', '50 4 * * 0',
  $$vacuum (full, analyze) net._http_response, cron.job_run_details$$);
