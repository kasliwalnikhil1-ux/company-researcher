-- 032 — Deleted senders leave sequence pools (Sept 2026)
--
-- Deleting a sender (outreach-sender-disable with delete_unipile, or the duplicate-merge tombstone in inbound.ts) set
-- deleted_at but left the id in outreach_sequences.sender_pool. The app lists only non-deleted senders, so the dead id
-- was invisible and could not be unticked, and every later pool change failed in outreach_set_pool with
-- "E_SENDER_NOT_IN_POOL: sender outside workspace". Now:
--   outreach__live_pool(ws, pool)   maps a merged tombstone (status_reason "merged_into:<id>") to its survivor, drops
--                                   every other deleted sender, removes duplicates, keeps order. Ids that are not
--                                   senders of the workspace are kept, so the callers still reject them.
--   outreach_sequences_a_live_pool  BEFORE trigger: every write of sender_pool is cleaned (named to fire before
--                                   outreach_sequences_pools, which derives sender_pools from it).
--   outreach_sender_left_pools      AFTER trigger on outreach_senders: when deleted_at is set, rewrites the pools that
--                                   hold the sender (which fires the trigger above).
--   outreach_set_pool / outreach_rebalance_preview clean p_pool first; a truly foreign id gets a clear message.
-- Backfills the pools that already hold deleted senders. Idempotent.

create or replace function public.outreach__live_pool(p_ws uuid, p_pool uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t.sid order by t.pos), '{}') from (
    select distinct on (m.sid) m.sid, m.pos from (
      select case
               when s.id is null or s.workspace_id <> p_ws then x.id                                  -- not ours: callers reject it
               when s.deleted_at is null then s.id
               when s.status_reason like 'merged_into:%' then (
                 select v.id from outreach_senders v
                  where v.id::text = substring(s.status_reason from 'merged_into:(.*)$')
                    and v.workspace_id = p_ws and v.deleted_at is null)
             end sid, x.pos
        from unnest(p_pool) with ordinality x(id, pos)
        left join outreach_senders s on s.id = x.id) m
     where m.sid is not null
     order by m.sid, m.pos) t
$$;
revoke execute on function public.outreach__live_pool(uuid, uuid[]) from public, anon, authenticated;

create or replace function public.outreach_trg_sequence_live_pool() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(array_length(new.sender_pool, 1), 0) > 0 then new.sender_pool := outreach__live_pool(new.workspace_id, new.sender_pool); end if;
  return new;
end $$;
drop trigger if exists outreach_sequences_a_live_pool on public.outreach_sequences;
create trigger outreach_sequences_a_live_pool before insert or update of sender_pool on public.outreach_sequences
  for each row execute function public.outreach_trg_sequence_live_pool();

create or replace function public.outreach_trg_sender_left_pools() returns trigger language plpgsql security definer set search_path = public as $$
begin
  update outreach_sequences set sender_pool = sender_pool, updated_at = now()
   where workspace_id = new.workspace_id and new.id = any(sender_pool);
  return null;
end $$;
drop trigger if exists outreach_sender_left_pools on public.outreach_senders;
create trigger outreach_sender_left_pools after update of deleted_at on public.outreach_senders
  for each row when (old.deleted_at is null and new.deleted_at is not null) execute function public.outreach_trg_sender_left_pools();

-- outreach_set_pool: clean the requested pool, then validate what is left
do $patch$
declare def text := pg_get_functiondef('public.outreach_set_pool(uuid,uuid[],boolean,text)'::regprocedure);
        old_chk text := $q$  if exists (select 1 from unnest(p_pool) pid where not exists (select 1 from outreach_senders x where x.id = pid and x.workspace_id = s.workspace_id and x.deleted_at is null)) then
    raise exception 'E_SENDER_NOT_IN_POOL: sender outside workspace';
  end if;$q$;
        new_chk text := $q$  p_pool := outreach__live_pool(s.workspace_id, coalesce(p_pool, '{}'));   -- deleted senders drop out, merged ones become their survivor
  if exists (select 1 from unnest(p_pool) pid where not exists (select 1 from outreach_senders x where x.id = pid and x.workspace_id = s.workspace_id)) then
    raise exception 'E_SENDER_NOT_IN_POOL: One of these senders is not in this workspace. Reload the page and pick the senders again.';
  end if;$q$;
begin
  if position('outreach__live_pool' in def) > 0 then return; end if;   -- already applied
  if position(old_chk in def) = 0 then raise exception 'outreach_set_pool: workspace check not found, patch not applied'; end if;
  execute replace(def, old_chk, new_chk);
end $patch$;

-- outreach_rebalance_preview: preview the same cleaned pool the save will store
do $patch$
declare def text := pg_get_functiondef('public.outreach_rebalance_preview(uuid,uuid[])'::regprocedure);
        old_pool text := $q$pool := coalesce(p_pool, s.sender_pool);$q$;
        new_pool text := $q$pool := outreach__live_pool(s.workspace_id, coalesce(p_pool, s.sender_pool));$q$;
begin
  if position('outreach__live_pool' in def) > 0 then return; end if;
  if position(old_pool in def) = 0 then raise exception 'outreach_rebalance_preview: pool line not found, patch not applied'; end if;
  execute replace(def, old_pool, new_pool);
end $patch$;

-- backfill: pools that already hold a deleted sender
update outreach_sequences q set sender_pool = sender_pool
 where exists (select 1 from outreach_senders s where s.id = any(q.sender_pool) and s.deleted_at is not null);
