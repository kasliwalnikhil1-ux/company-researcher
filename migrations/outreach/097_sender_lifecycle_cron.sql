-- 097_sender_lifecycle_cron.sql — schedules for the sender lifecycle (sender-lifecycle-PRD.md §7.2). Requires 096.
-- Apply AFTER deploying outreach-worker-sender-erase and outreach-worker-sender-housekeeping (the jobs call them). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/097_sender_lifecycle_cron.sql
--
-- sender-lifecycle (dispatcher row, every 15 min, guarded)  F51 outreach-worker-sender-erase {"mode":"tick"}:
--     due erasures (Storage deletes, then outreach_sender_erase_execute) and pauses whose auto-resume time has come.
--     The guard asks the two tables, so an idle platform makes no call (084 dispatcher rules).
-- outreach-sender-housekeeping (pg_cron, 02:30 UTC)            F52 outreach-worker-sender-housekeeping {"mode":"nightly"}:
--     auto-remove notices (7 days before) and removals of senders disabled for auto_remove_after_days, connector-delete
--     retries + the "removal pending" manager alert, and the connector reconciliation (report-only until the flag
--     sender_reconcile_cleanup is true).

create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;

insert into outreach_cron_jobs (name, fn, body, every_s, guarded, note) values
  ('sender-lifecycle', 'outreach-worker-sender-erase', '{"mode":"tick"}', 900, true, 'due sender erasures (24 h after scheduling) and paused senders whose resume time has come')
on conflict (name) do update set fn = excluded.fn, body = excluded.body, guarded = excluded.guarded, note = excluded.note;

select outreach__patch_fn('public.outreach_cron_has_work(text)'::regprocedure, $q$when 'sender-lifecycle' then$q$,
$q$    when 'inbound' then exists$q$,
$q$    when 'sender-lifecycle' then exists (select 1 from outreach_senders x where x.deleted_at is null
                                           and ((x.status = 'paused' and x.pause_resume_at <= now())
                                             or (x.erase_scheduled_at <= now() and x.erased_at is null and x.status::text = 'removed')))
    when 'inbound' then exists$q$);

do $$ begin perform cron.unschedule('outreach-sender-housekeeping'); exception when others then null; end $$;
select cron.schedule('outreach-sender-housekeeping', '30 2 * * *', $$select outreach_invoke('outreach-worker-sender-housekeeping', '{"mode":"nightly"}'::jsonb)$$);

-- reconciliation starts report-only (PRD §5.7 / rollout phase 1); set to true to let it delete orphans and mark missing senders removed
insert into outreach_flags(key, value) values ('sender_reconcile_cleanup', 'false'::jsonb) on conflict (key) do nothing;

drop function if exists outreach__patch_fn(regprocedure, text, text, text);
