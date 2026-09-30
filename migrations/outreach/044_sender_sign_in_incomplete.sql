-- 044 — Abandoned hosted sign-ins.
-- A sender row is created (status connecting, no account id) before the owner opens the hosted sign-in page. The page only calls
-- back on success or on CREATION_FAIL; a page that is closed, or a link that expires (15 min), leaves the row "connecting" forever.
--   1. outreach_sweep_incomplete_sign_ins(): every 10 min, a connecting row with no account whose latest sign-in link is older
--      than an hour gets status_reason SIGN_IN_INCOMPLETE (the UI shows "Sign-in not completed"). A fresh link clears it.
--   2. outreach_dashboard(): each sender carries has_account + created_at, and the attention list names these rows.
-- Idempotent.

create or replace function outreach_sweep_incomplete_sign_ins() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  with stale as (
    select s.id from outreach_senders s
    where s.status = 'connecting' and s.unipile_account_id is null and s.deleted_at is null and s.status_reason is null
      and greatest(s.created_at, coalesce((select max(e.at) from outreach_sender_events e where e.sender_id = s.id and e.kind = 'reconnect'
                                                   and e.data->>'method' in ('connect_link','fresh_bind','hosted_link')), s.created_at)) < now() - interval '60 minutes'
  ), upd as (
    update outreach_senders s set status_reason = 'SIGN_IN_INCOMPLETE' from stale where s.id = stale.id returning s.id
  ), ev as (
    insert into outreach_sender_events(sender_id, kind, data) select id, 'reconnect', '{"result":"incomplete","via":"sweep"}'::jsonb from upd returning 1
  )
  select count(*) into n from upd;
  return n;
end $$;
revoke all on function outreach_sweep_incomplete_sign_ins() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'outreach-sweep-sign-ins') then perform cron.unschedule('outreach-sweep-sign-ins'); end if;
end $$;
select cron.schedule('outreach-sweep-sign-ins', '*/10 * * * *', $$select outreach_sweep_incomplete_sign_ins()$$);

-- Dashboard: has_account + created_at on each sender (the client decides which "connecting" rows need attention), and abandoned
-- sign-ins in the attention list. Patched in place like 027 so nothing else in the function changes.
do $$
declare def text := pg_get_functiondef('public.outreach_dashboard(uuid)'::regprocedure);
begin
  if position('''has_account''' in def) = 0 then
    def := replace(def, $q$'status', s.status, 'status_reason', s.status_reason,$q$,
                        $q$'status', s.status, 'status_reason', s.status_reason, 'has_account', s.unipile_account_id is not null, 'created_at', s.created_at,$q$);
    if position('''has_account''' in def) = 0 then raise exception 'outreach_dashboard: sender object not found, patch not applied'; end if;
  end if;
  if position('sign-in was not completed' in def) = 0 then
    def := replace(def, $q$        union all
        select 'sender', s.id::text, s.display_name, 'paused until ' || to_char(s.paused_until, 'Mon DD HH24:MI') from outreach_senders s$q$,
                        $q$        union all
        select 'sender', s.id::text, s.display_name, 'The sign-in was not completed. Open the sender and send a fresh sign-in link.' from outreach_senders s
          where s.workspace_id = p_ws and s.deleted_at is null and s.status = 'connecting' and s.unipile_account_id is null
            and (s.status_reason is not null or s.created_at < now() - interval '60 minutes') and outreach_client_visible(p_ws, s.client_id)
        union all
        select 'sender', s.id::text, s.display_name, 'paused until ' || to_char(s.paused_until, 'Mon DD HH24:MI') from outreach_senders s$q$);
    if position('sign-in was not completed' in def) = 0 then raise exception 'outreach_dashboard: attention list not found, patch not applied'; end if;
  end if;
  execute def;
end $$;
