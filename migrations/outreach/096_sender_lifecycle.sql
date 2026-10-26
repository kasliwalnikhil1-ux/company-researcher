-- =============================================================================
-- Outreach Platform — 096 sender lifecycle: pause → disable → remove → erase (sender-lifecycle-PRD.md)
-- Requires 095 (enum values 'removed', 'erased') applied in its own call first. Idempotent.
--
-- What changes, in one line each:
--   Pause     status 'paused' (+ paused_at / paused_by / pause_resume_at). Leads stay in their sequences. Manual replies allowed.
--   Disable   status 'disabled'. Leads exit (exited_sender_disabled, existing trigger), queued actions cancelled, rules and
--             imports that depended on the sender paused, scheduled AI replies cancelled. The connector link STAYS (late
--             replies still arrive) and the paid account slot stays used. auto_remove_at = now() + 30 days (7–90).
--   Remove    two steps: remove_begin (disable if needed, removal_requested_at, connector delete queued) → the edge
--             function deletes the connector account → remove_finish (status 'removed', credentials wiped, pools / rules /
--             imports / consents cleaned, slot freed). History stays: chats, actions, lead_sender_state, reports.
--   Erase     owner only, scheduled 24 h ahead, cancellable; the erase worker deletes conversations and personal data and
--             leaves a tombstone ('Erased sender') so report counts do not change.
--
-- Deviations from the PRD text, and why (also in docs/outreach/SENDER-LIFECYCLE.md):
--   * removed_at is a new column; deleted_at keeps its existing meaning (hidden tombstone: merged duplicates, erased rows).
--     The RLS policy senders_select hides deleted rows, and a removed sender must stay visible with a Reconnect button.
--   * D3 is enforced by a BEFORE DELETE trigger instead of switching every FK to `on delete no action`: several child tables
--     (sender_events, sender_budgets, secrets, tokens, poll plans) hang off the sender only, so `no action` would also block
--     the workspace purge. The trigger lets a row go only when it is erased, never connected, or inside outreach_purge_workspace.
--   * Billing v2's 'disconnected' (056) and the PRD's 'removed' are one state. outreach_disconnect_sender() now runs the remove
--     flow (removed_via trial_ended | app | billing), existing rows are moved, and nothing writes 'disconnected' any more.
--   * Auto-enrol rules target sequences here, not senders: a rule is paused when its sequence is left without an active sender.
--   * The connect flow already folds a second sign-in of a live profile into the existing sender (absorbDuplicateSender) and now
--     restores a removed one the same way; the unique index below is the database guarantee behind D11.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0. Patch helper (060 defines and drops it; recreated here for this file and dropped again at the end)
-- -----------------------------------------------------------------------------
create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');   -- bodies applied from a CRLF checkout carry CR
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists paused_at              timestamptz,
  add column if not exists paused_by              uuid references auth.users(id),
  add column if not exists pause_resume_at        timestamptz,
  add column if not exists disabled_at            timestamptz,
  add column if not exists disabled_by            uuid references auth.users(id),
  add column if not exists disable_reason         text,
  add column if not exists auto_remove_after_days int not null default 30,
  add column if not exists auto_remove_at         timestamptz,
  add column if not exists auto_remove_notice_at  timestamptz,
  add column if not exists removal_requested_at   timestamptz,
  add column if not exists removed_at             timestamptz,
  add column if not exists removed_by             uuid references auth.users(id),
  add column if not exists removed_via            text,
  add column if not exists unipile_account_id_history text[] not null default '{}',
  add column if not exists restored_at            timestamptz,
  add column if not exists erase_scheduled_at     timestamptz,
  add column if not exists erase_requested_by     uuid references auth.users(id),
  add column if not exists erased_at              timestamptz;

alter table outreach_senders drop constraint if exists outreach_senders_auto_remove_after_days_check;
alter table outreach_senders add constraint outreach_senders_auto_remove_after_days_check check (auto_remove_after_days between 7 and 90);
alter table outreach_senders drop constraint if exists outreach_senders_removed_via_check;
alter table outreach_senders add constraint outreach_senders_removed_via_check
  check (removed_via is null or removed_via in ('app','owner_link','unipile_deleted','auto_after_disabled','trial_ended','workspace_deleted','reconcile','billing'));

comment on column outreach_senders.removed_at is 'sender-lifecycle: when the connector account was unlinked (status removed). deleted_at stays the hidden-tombstone marker.';
comment on column outreach_senders.removed_via is 'app | owner_link | unipile_deleted | auto_after_disabled | trial_ended | workspace_deleted | reconcile | billing';
comment on column outreach_senders.unipile_account_id_history is 'connector account ids this sender had before each removal (reconcile + "events for a removed account" detection)';

alter table outreach_auto_enroll_rules
  add column if not exists paused_reason text,
  add column if not exists paused_at     timestamptz;
alter table outreach_import_jobs
  add column if not exists paused_reason text;

create index if not exists outreach_senders_disabled_auto_remove_idx on outreach_senders(auto_remove_at) where status = 'disabled' and deleted_at is null;
create index if not exists outreach_senders_erase_due_idx on outreach_senders(erase_scheduled_at) where erase_scheduled_at is not null and erased_at is null;
create index if not exists outreach_senders_pause_resume_idx on outreach_senders(pause_resume_at) where status = 'paused' and pause_resume_at is not null;
create index if not exists outreach_senders_removal_pending_idx on outreach_senders(removal_requested_at) where removal_requested_at is not null and removed_at is null;
create index if not exists outreach_senders_account_history_idx on outreach_senders using gin(unipile_account_id_history);

-- One live sender per identity per workspace (PRD D11). Created only when the data already obeys it; otherwise a warning
-- names the duplicates to fold first (the index is asserted by the smoke test).
do $$
declare d record; n int := 0;
begin
  for d in select workspace_id, provider, provider_user_id, count(*) c from outreach_senders
            where deleted_at is null and provider_user_id is not null and status::text not in ('removed','erased','disconnected')
            group by 1, 2, 3 having count(*) > 1 loop
    n := n + 1;
    raise warning 'outreach_senders_one_live_identity: % live rows for % % in workspace %', d.c, d.provider, d.provider_user_id, d.workspace_id;
  end loop;
  if n = 0 then
    create unique index if not exists outreach_senders_one_live_identity on outreach_senders(workspace_id, provider, provider_user_id)
      where provider_user_id is not null and deleted_at is null and status not in ('removed','erased','disconnected');
  else
    raise warning 'outreach_senders_one_live_identity NOT created: fold the duplicates and re-apply 096';
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. New tables (service-only: RLS on, no policies)
-- -----------------------------------------------------------------------------
-- Signed single-use links the sender owner gets in every email: disconnect without logging in, or request data deletion (PRD §4).
create table if not exists outreach_sender_owner_links (
  token_sha256 text primary key,
  sender_id    uuid not null references outreach_senders(id) on delete cascade,
  purpose      text not null check (purpose in ('disconnect','erase_request')),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  used_ip      inet,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_sender_owner_links_sender_idx on outreach_sender_owner_links(sender_id);

-- Erase job: Storage deletions are listed here so a crashed run finishes them next time; the row deletes run only after.
create table if not exists outreach_sender_erase_jobs (
  sender_id     uuid primary key references outreach_senders(id) on delete cascade,
  workspace_id  uuid not null,
  scheduled_at  timestamptz not null,
  started_at    timestamptz,
  storage_paths jsonb not null default '[]'::jsonb,      -- paths still to delete (shrinks as the worker goes)
  storage_done  int not null default 0,
  attempts      int not null default 0,
  last_error    text,
  finished_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- Nightly connector reconciliation (PRD §5.7): orphans on the connector, senders whose account the connector no longer lists.
create table if not exists outreach_unipile_reconcile_log (
  id                 bigserial primary key,
  run_at             timestamptz not null default now(),
  unipile_account_id text not null,
  finding            text not null check (finding in ('orphan','missing_in_unipile')),
  action             text not null check (action in ('reported','deleted','sender_marked_removed')),
  sender_id          uuid,
  detail             jsonb not null default '{}'::jsonb
);
create index if not exists outreach_unipile_reconcile_log_run_idx on outreach_unipile_reconcile_log(run_at desc);

do $$
declare t text;
begin
  for t in select unnest(array['outreach_sender_owner_links','outreach_sender_erase_jobs','outreach_unipile_reconcile_log']) loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on %I to service_role', t);
  end loop;
end $$;
grant usage, select on sequence outreach_unipile_reconcile_log_id_seq to service_role;

-- -----------------------------------------------------------------------------
-- 3. D3: a sender row is never deleted by accident
-- -----------------------------------------------------------------------------
-- Allowed: an erased tombstone (the erase job emptied its history first), a placeholder that never connected (the connect
-- wizard removes those when the sign-in link cannot be made), and rows going with their workspace inside
-- outreach_purge_workspace (which sets outreach.allow_sender_delete for its transaction).
create or replace function outreach_trg_sender_delete_guard() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if coalesce(current_setting('outreach.allow_sender_delete', true), '') = 'on' then return old; end if;
  if old.status::text = 'erased' then return old; end if;
  if old.unipile_account_id is null and old.connected_at is null
     and not exists (select 1 from outreach_chats c where c.sender_id = old.id)
     and not exists (select 1 from outreach_actions a where a.sender_id = old.id and a.status in ('sent','failed')) then
    return old;
  end if;
  raise exception 'E_SENDER_DELETE_BLOCKED: sender % keeps history (status %). Remove it, or schedule an erase: only the erase job may delete it.', old.id, old.status;
end $$;
drop trigger if exists outreach_sender_delete_guard on outreach_senders;
create trigger outreach_sender_delete_guard before delete on outreach_senders for each row execute function outreach_trg_sender_delete_guard();

-- the workspace purge deletes the workspace row; senders and their children cascade inside that statement
create or replace function outreach_purge_workspace(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; n_accounts int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then return jsonb_build_object('deleted', false, 'reason', 'not_found'); end if;
  if w.plan not in ('trial_expired','cancelled') or w.billing_comp or w.data_delete_after is null or w.data_delete_after > now()
     or coalesce(w.stripe_status, 'canceled') in ('active','trialing','past_due','unpaid') then
    raise exception 'E_FORBIDDEN: workspace % is not due for deletion', p_ws;
  end if;
  -- whatever is still connected stops costing us (PRD §5.5: no connector account is left behind)
  insert into outreach_account_deletions(account_id, sender_id, workspace_id, reason)
  select s.unipile_account_id, null, null, 'workspace_deleted' from outreach_senders s where s.workspace_id = p_ws and s.unipile_account_id is not null
  on conflict (account_id) do nothing;
  get diagnostics n_accounts = row_count;
  update outreach_account_deletions set sender_id = null, workspace_id = null where workspace_id = p_ws;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (null, null, 'system', 'workspace.data_deleted', 'workspace', p_ws::text, jsonb_build_object('name', w.name, 'plan', w.plan, 'data_delete_after', w.data_delete_after, 'accounts_queued', n_accounts));
  perform set_config('outreach.allow_sender_delete', 'on', true);
  delete from outreach_workspaces where id = p_ws;
  perform set_config('outreach.allow_sender_delete', 'off', true);
  return jsonb_build_object('deleted', true, 'accounts_queued', n_accounts);
end $$;

-- -----------------------------------------------------------------------------
-- 4. Pools, slots and the status trigger learn the new states
-- -----------------------------------------------------------------------------
-- a removed or erased sender is not in any pool (032 handled deleted tombstones only)
create or replace function public.outreach__live_pool(p_ws uuid, p_pool uuid[]) returns uuid[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(t.sid order by t.pos), '{}') from (
    select distinct on (m.sid) m.sid, m.pos from (
      select case
               when s.id is null or s.workspace_id <> p_ws then x.id                                  -- not ours: callers reject it
               when s.deleted_at is null and s.status::text in ('removed','erased','disconnected') then null
               when s.deleted_at is null then s.id
               when s.status_reason like 'merged_into:%' then (
                 select v.id from outreach_senders v
                  where v.id::text = substring(s.status_reason from 'merged_into:(.*)$')
                    and v.workspace_id = p_ws and v.deleted_at is null and v.status::text not in ('removed','erased','disconnected'))
             end sid, x.pos
        from unnest(p_pool) with ordinality x(id, pos)
        left join outreach_senders s on s.id = x.id) m
     where m.sid is not null
     order by m.sid, m.pos) t
$$;
revoke execute on function public.outreach__live_pool(uuid, uuid[]) from public, anon, authenticated;

drop trigger if exists outreach_sender_removed_pools on public.outreach_senders;
create trigger outreach_sender_removed_pools after update of status on public.outreach_senders
  for each row when (new.status::text in ('removed','erased') and old.status::text not in ('removed','erased')) execute function public.outreach_trg_sender_left_pools();

-- A sender occupies a paid account while it is linked: disabled counts (PRD D7); removed / erased do not, and neither does a
-- sender whose removal was requested (the connector delete is in flight: "this frees one of your paid accounts" holds at once).
create or replace function outreach__occupies(s outreach_senders) returns boolean language sql stable as $$
  select s.deleted_at is null and s.provider::text <> 'WEBCHAT' and s.status::text not in ('removed','erased','disconnected')
     and s.removal_requested_at is null and s.unipile_account_id is not null
$$;

-- slot event wording when a removal frees the account
select outreach__patch_fn('public.outreach_trg_senders_slot_guard()'::regprocedure, 'coalesce(new.removed_via',
$q$when new.status = 'disabled' then 'disabled' else 'released' end$q$,
$q$when new.status = 'disabled' then 'disabled' when new.status::text = 'removed' then coalesce(new.removed_via, 'removed') else 'released' end$q$);

-- the status trigger: a removal is a disconnect date; a reconnect from 'removed' gets the quiet period + requeue of 'credentials'
select outreach__patch_fn('public.outreach_trg_sender_status()'::regprocedure, $q$('disconnected','removed')$q$,
$q$    elsif new.status = 'disconnected' then$q$,
$q$    elsif new.status::text in ('disconnected','removed') then$q$);
select outreach__patch_fn('public.outreach_trg_sender_status()'::regprocedure, $q$'credentials','error','disconnected','removed'$q$,
$q$if old.status::text in ('credentials','error','disconnected') then
        perform outreach_emit_event(new.workspace_id, 'sender.reconnected'$q$,
$q$if old.status::text in ('credentials','error','disconnected','removed') then
        perform outreach_emit_event(new.workspace_id, 'sender.reconnected'$q$);
select outreach__patch_fn('public.outreach_trg_sender_quiet_period()'::regprocedure, $q$'connecting','credentials','error','disconnected','removed'$q$,
$q$old.status::text in ('connecting','credentials','error','disconnected')$q$,
$q$old.status::text in ('connecting','credentials','error','disconnected','removed')$q$);
select outreach__patch_fn('public.outreach_trg_sender_reconnected()'::regprocedure, $q$'credentials','error','disconnected','removed'$q$,
$q$old.status::text in ('credentials','error','disconnected')$q$,
$q$old.status::text in ('credentials','error','disconnected','removed')$q$);

-- trial end removes disabled (still linked) senders too
select outreach__patch_fn('public.outreach_billing_tick()'::regprocedure, $q$('removed','erased','disconnected') and x.unipile_account_id$q$,
$q$x.status::text not in ('disabled','disconnected') and x.unipile_account_id is not null loop$q$,
$q$x.status::text not in ('removed','erased','disconnected') and x.unipile_account_id is not null loop$q$);

-- -----------------------------------------------------------------------------
-- 5. Role check without the plan gate (removing or erasing an account must work on a read-only workspace)
-- -----------------------------------------------------------------------------
create or replace function outreach__lifecycle_require(p_ws uuid, p_min text) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_role_t;
begin
  if outreach_is_service() then return; end if;
  r := outreach_role_in(p_ws);
  if r is null then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
  if p_min = 'owner' and r <> 'owner' then raise exception 'E_FORBIDDEN: owner required'; end if;
  if p_min = 'manager' and r not in ('owner','manager') then raise exception 'E_FORBIDDEN: manager required'; end if;
  if p_min = 'member' and r not in ('owner','manager','member') then raise exception 'E_FORBIDDEN: member required'; end if;
end $$;
revoke execute on function outreach__lifecycle_require(uuid, text) from public, anon, authenticated;

-- compare-and-set status change, so a webhook and a person cannot race (PRD §6.3)
create or replace function outreach_sender_transition(p_sender uuid, p_from text[], p_to outreach_sender_status_t, p_reason text default null) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_senders set status = p_to, status_reason = p_reason where id = p_sender and status::text = any(p_from);
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke execute on function outreach_sender_transition(uuid, text[], outreach_sender_status_t, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 6. Preview: the counts every dialog shows before its button is enabled (PRD §7.1)
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_lifecycle_preview(p_sender uuid, p_action text default 'disable') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; seqs jsonb; n_act int; n_flight int; n_enr int; n_noseq int; n_rules int; n_imp int; n_ai int; n_prof int;
        n_tasks int; n_chats int; n_msgs int; n_cons int; n_auth int; n_leads int; live_st text[] := array['active','waiting_connection','waiting_delay','waiting_task','paused'];
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'member');
  if p_action not in ('pause','resume','disable','enable','remove','erase') then raise exception 'E_PAYLOAD_INVALID: unknown action %', p_action; end if;
  select count(*) filter (where status = 'queued'), count(*) filter (where status = 'reserved') into n_act, n_flight from outreach_actions where sender_id = p_sender and status in ('queued','reserved');
  select count(*) into n_enr from outreach_enrollments where sender_id = p_sender and status::text = any(live_st);
  select coalesce(jsonb_agg(jsonb_build_object('sequence_id', q.id, 'name', q.name, 'status', q.status, 'leads', x.n,
           'other_active_senders', (select count(*) from outreach_senders o where o.id = any(q.sender_pool) and o.id <> p_sender and o.status = 'ok' and o.deleted_at is null)) order by x.n desc), '[]'::jsonb)
    into seqs
    from (select sequence_id, count(*) n from outreach_enrollments where sender_id = p_sender and status::text = any(live_st) group by sequence_id) x
    join outreach_sequences q on q.id = x.sequence_id;
  select count(*) into n_noseq from outreach_sequences q
   where q.workspace_id = s.workspace_id and q.status = 'active' and p_sender = any(q.sender_pool)
     and not exists (select 1 from outreach_senders o where o.id = any(q.sender_pool) and o.id <> p_sender and o.status = 'ok' and o.deleted_at is null);
  select count(*) into n_rules from outreach_auto_enroll_rules r
   where r.active and r.sequence_id in (select q.id from outreach_sequences q where q.workspace_id = s.workspace_id and p_sender = any(q.sender_pool)
     and not exists (select 1 from outreach_senders o where o.id = any(q.sender_pool) and o.id <> p_sender and o.status = 'ok' and o.deleted_at is null));
  select count(*) into n_imp from outreach_import_jobs where sender_id = p_sender and status in ('queued','running');
  select count(*) into n_ai from outreach_ai_reply_runs where sender_id = p_sender and status = 'scheduled';
  select count(*) into n_prof from outreach_profile_changes where sender_id = p_sender and status = 'queued';
  select count(*) into n_tasks from outreach_tasks where sender_id = p_sender and completed_at is null;
  select count(*) into n_chats from outreach_chats where sender_id = p_sender;
  select count(*) into n_msgs from outreach_messages m where m.chat_id in (select id from outreach_chats where sender_id = p_sender);
  select count(*) into n_leads from outreach_lead_sender_state where sender_id = p_sender and (last_outbound_at is not null or invite_sent_at is not null);
  select count(*) into n_cons from outreach_ai_reply_consent where sender_id = p_sender and revoked_at is null;
  select count(*) into n_auth from outreach_profile_authority where sender_id = p_sender and revoked_at is null;
  return jsonb_build_object(
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason', s.status_reason,
                'unipile_linked', s.unipile_account_id is not null, 'auto_remove_after_days', s.auto_remove_after_days, 'auto_remove_at', s.auto_remove_at,
                'erase_scheduled_at', s.erase_scheduled_at, 'pause_resume_at', s.pause_resume_at,
                'removal_pending', s.removal_requested_at is not null and s.status::text not in ('removed','erased')),
    'action', p_action,
    'queued_actions', n_act, 'in_flight_actions', n_flight, 'live_enrollments', n_enr, 'sequences', seqs, 'sequences_left_without_sender', n_noseq,
    'rules_to_pause', n_rules, 'imports_to_pause', n_imp, 'ai_runs_scheduled', n_ai, 'profile_changes_queued', n_prof, 'open_tasks', n_tasks,
    'chats', n_chats, 'messages', n_msgs, 'leads_contacted', n_leads, 'ai_consents', n_cons, 'profile_authority', n_auth,
    'slot_freed', p_action in ('remove','erase') and s.unipile_account_id is not null and s.provider::text <> 'WEBCHAT');
end $$;
grant execute on function outreach_sender_lifecycle_preview(uuid, text) to authenticated;
revoke execute on function outreach_sender_lifecycle_preview(uuid, text) from public, anon;

-- -----------------------------------------------------------------------------
-- 7. Pause / resume (PRD §3.2)
-- -----------------------------------------------------------------------------
-- Overdue queued actions after a pause are spread over the following days inside the sender's daily caps, never a burst.
create or replace function outreach__spread_backlog(p_sender uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cap int; i int; n int := 0; day_idx int; slot_min int;
begin
  for r in select action_type, array_agg(id order by scheduled_for, id) ids from outreach_actions
            where sender_id = p_sender and status = 'queued' and scheduled_for < now() group by action_type loop
    begin cap := greatest(1, coalesce(outreach_effective_cap(p_sender, r.action_type), 1)); exception when others then cap := 1; end;
    slot_min := greatest(10, (8 * 60) / cap);
    for i in 1..array_length(r.ids, 1) loop
      day_idx := (i - 1) / cap;
      update outreach_actions set scheduled_for = now() + make_interval(days => day_idx, mins => 5 + ((i - 1) % cap) * slot_min) where id = r.ids[i];
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;
revoke execute on function outreach__spread_backlog(uuid) from public, anon, authenticated;

create or replace function outreach_sender_pause(p_sender uuid, p_resume_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; n_ai int := 0;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if s.provider::text = 'WEBCHAT' then raise exception 'E_PAYLOAD_INVALID: a website inbox is switched off from its Website agents page'; end if;
  if p_resume_at is not null and p_resume_at <= now() then raise exception 'E_PAYLOAD_INVALID: the resume time must be in the future'; end if;
  if s.status = 'paused' then
    update outreach_senders set pause_resume_at = p_resume_at where id = p_sender;
    return jsonb_build_object('ok', true, 'already', true, 'pause_resume_at', p_resume_at);
  end if;
  if s.status <> 'ok' then raise exception 'E_SENDER_NOT_OK: only a connected sender can be paused (it is %)', s.status; end if;
  update outreach_senders set status = 'paused', status_reason = 'user_paused', paused_at = now(), paused_by = auth.uid(), pause_resume_at = p_resume_at where id = p_sender;
  -- scheduled AI replies drop back to drafts; new drafts keep appearing (the worker gate G6 covers a paused sender)
  update outreach_ai_reply_runs set status = 'draft_ready', flags = array_append(flags, 'sender_paused') where sender_id = p_sender and status = 'scheduled';
  get diagnostics n_ai = row_count;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'pause', 'by', auth.uid(), 'resume_at', p_resume_at, 'ai_runs_to_draft', n_ai));
  perform outreach_audit(s.workspace_id, 'sender.paused', 'sender', p_sender::text, jsonb_build_object('resume_at', p_resume_at), null);
  perform outreach_emit_event(s.workspace_id, 'sender.paused', jsonb_build_object('id', p_sender, 'reason', 'user', 'until', p_resume_at));
  return jsonb_build_object('ok', true, 'pause_resume_at', p_resume_at, 'ai_runs_to_draft', n_ai);
end $$;
grant execute on function outreach_sender_pause(uuid, timestamptz) to authenticated;
revoke execute on function outreach_sender_pause(uuid, timestamptz) from public, anon;

create or replace function outreach_sender_resume(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; n int;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if s.status <> 'paused' then raise exception 'E_SENDER_NOT_OK: the sender is not paused (it is %)', s.status; end if;
  -- pauses that are not a person's to lift
  if s.status_reason = 'over_plan_limit' then
    raise exception 'E_ACCOUNT_LIMIT: This account is paused because the plan has fewer accounts than are connected. Add an account or remove another one; it resumes on its own.';
  elsif s.status_reason in ('billing_suspended','billing_cancelled','trial_expired') then
    raise exception 'E_PLAN_SUSPENDED: This account is paused for billing; it resumes on its own once the subscription is active.';
  elsif s.status_reason = 'provider_warning' then
    raise exception 'E_PROVIDER_WARNING: This sender rests after a warning from the provider. A manager resumes it from the warning banner on the sender page.';
  end if;
  if not outreach_plan_active(s.workspace_id) then raise exception 'E_PLAN_SUSPENDED: the workspace plan is not active'; end if;
  update outreach_senders set status = 'ok', status_reason = null, paused_at = null, paused_by = null, pause_resume_at = null where id = p_sender;
  n := outreach__spread_backlog(p_sender);
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'resume', 'by', auth.uid(), 'backlog_spread', n));
  perform outreach_audit(s.workspace_id, 'sender.resumed', 'sender', p_sender::text, jsonb_build_object('backlog_spread', n), null);
  perform outreach_emit_event(s.workspace_id, 'sender.resumed', jsonb_build_object('id', p_sender));
  return jsonb_build_object('ok', true, 'backlog_spread', n);
end $$;
grant execute on function outreach_sender_resume(uuid) to authenticated;
revoke execute on function outreach_sender_resume(uuid) from public, anon;

-- the pre-lifecycle RPC keeps its signature (web app, MCP, demo) and delegates
create or replace function outreach_pause_sender(p_sender uuid, p_pause boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_pause then perform outreach_sender_pause(p_sender, null); else perform outreach_sender_resume(p_sender); end if;
end $$;

-- -----------------------------------------------------------------------------
-- 8. Disable / enable (PRD §3.3)
-- -----------------------------------------------------------------------------
create or replace function outreach__sender_disable_core(p_sender uuid, p_reason text, p_by uuid, p_via text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; counts jsonb; exited jsonb; n_rules int := 0; n_imp int := 0; n_ai int := 0; n_prof int := 0;
        live_st text[] := array['active','waiting_connection','waiting_delay','waiting_task','paused'];
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  counts := outreach_sender_lifecycle_preview(p_sender, 'disable');
  -- who leaves which sequence: captured before the status trigger exits them, for the re-enrol option (D6)
  select coalesce(jsonb_agg(jsonb_build_object('sequence_id', x.sequence_id, 'name', q.name, 'lead_ids', to_jsonb(x.ids))), '[]'::jsonb) into exited
    from (select sequence_id, (array_agg(lead_id))[1:10000] ids from outreach_enrollments where sender_id = p_sender and status::text = any(live_st) group by sequence_id) x
    join outreach_sequences q on q.id = x.sequence_id;
  update outreach_senders
     set status = 'disabled', status_reason = coalesce(p_reason, 'disabled_by_user'), disabled_at = now(), disabled_by = p_by, disable_reason = p_reason,
         auto_remove_at = case when p_via is null then now() + make_interval(days => auto_remove_after_days) else null end, auto_remove_notice_at = null,
         paused_at = null, paused_by = null, pause_resume_at = null
   where id = p_sender;
  -- (the status trigger exited the live enrolments with exited_sender_disabled and cancelled queued / reserved actions)
  update outreach_auto_enroll_rules r set active = false, paused_reason = coalesce(p_via, 'sender_disabled'), paused_at = now()
   where r.active and r.sequence_id in (
     select q.id from outreach_sequences q where q.workspace_id = s.workspace_id and p_sender = any(q.sender_pool)
       and not exists (select 1 from outreach_senders o where o.id = any(q.sender_pool) and o.id <> p_sender and o.status = 'ok' and o.deleted_at is null));
  get diagnostics n_rules = row_count;
  update outreach_import_jobs set status = 'paused', paused_reason = coalesce(p_via, 'sender_disabled') where sender_id = p_sender and status in ('queued','running');
  get diagnostics n_imp = row_count;
  update outreach_ai_reply_runs set status = 'cancelled', flags = array_append(flags, coalesce(p_via, 'sender_disabled')) where sender_id = p_sender and status = 'scheduled';
  get diagnostics n_ai = row_count;
  update outreach_profile_changes set status = 'cancelled', note = coalesce(note, '') || ' [cancelled: ' || coalesce(p_via, 'sender disabled') || ']' where sender_id = p_sender and status = 'queued';
  get diagnostics n_prof = row_count;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'disable', 'by', p_by, 'reason', p_reason, 'via', p_via,
    'counts', counts - 'sequences' - 'sender', 'rules_paused', n_rules, 'imports_paused', n_imp, 'ai_runs_cancelled', n_ai, 'profile_changes_cancelled', n_prof));
  perform outreach_audit(s.workspace_id, 'sender.disabled', 'sender', p_sender::text, jsonb_build_object('reason', p_reason, 'via', p_via, 'counts', counts - 'sequences' - 'sender'), case when p_by is null then 'system' else 'user' end);
  perform outreach_emit_event(s.workspace_id, 'sender.disabled', jsonb_build_object('id', p_sender, 'reason', p_reason, 'via', p_via));
  return jsonb_build_object('ok', true, 'counts', counts, 'exited', exited, 'rules_paused', n_rules, 'imports_paused', n_imp, 'ai_runs_cancelled', n_ai, 'profile_changes_cancelled', n_prof);
end $$;
revoke execute on function outreach__sender_disable_core(uuid, text, uuid, text) from public, anon, authenticated;

create or replace function outreach_sender_disable(p_sender uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if s.provider::text = 'WEBCHAT' then raise exception 'E_PAYLOAD_INVALID: a website inbox is switched off from its Website agents page'; end if;
  if s.status::text in ('removed','erased') or s.deleted_at is not null then raise exception 'E_SENDER_NOT_OK: this sender is %', s.status; end if;
  if s.status = 'disabled' then return jsonb_build_object('ok', true, 'already', true); end if;
  return outreach__sender_disable_core(p_sender, p_reason, auth.uid(), null);
end $$;
grant execute on function outreach_sender_disable(uuid, text) to authenticated;
revoke execute on function outreach_sender_disable(uuid, text) from public, anon;

create or replace function outreach_sender_enable(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if s.status <> 'disabled' or s.deleted_at is not null then raise exception 'E_SENDER_NOT_OK: only a disabled sender can be enabled (it is %)', s.status; end if;
  if s.removal_requested_at is not null then raise exception 'E_CONFLICT: this sender is being removed; wait for the connector to confirm'; end if;
  if not outreach_plan_active(s.workspace_id) then raise exception 'E_PLAN_SUSPENDED: the workspace plan is not active'; end if;
  if s.unipile_account_id is null then
    -- disabled before the lifecycle build: its connector account was deleted then. That is a removed sender; the owner reconnects.
    update outreach_senders set status = 'removed', removed_at = coalesce(removed_at, disabled_at, updated_at, now()), removed_via = coalesce(removed_via, 'app'),
           auto_remove_at = null, auto_remove_notice_at = null,
           unipile_account_id_history = case when previous_unipile_account_id is not null and not (previous_unipile_account_id = any(unipile_account_id_history)) then array_append(unipile_account_id_history, previous_unipile_account_id) else unipile_account_id_history end
     where id = p_sender;
    insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'enable', 'by', auth.uid(), 'result', 'removed', 'note', 'no connector account left; reconnect'));
    perform outreach_audit(s.workspace_id, 'sender.enabled', 'sender', p_sender::text, jsonb_build_object('result', 'removed'), null);
    return jsonb_build_object('ok', true, 'state', 'removed');
  end if;
  update outreach_senders set status = 'ok', status_reason = null, disabled_at = null, disabled_by = null, disable_reason = null, auto_remove_at = null, auto_remove_notice_at = null where id = p_sender;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'enable', 'by', auth.uid(), 'result', 'ok'));
  perform outreach_audit(s.workspace_id, 'sender.enabled', 'sender', p_sender::text, null, null);
  perform outreach_emit_event(s.workspace_id, 'sender.enabled', jsonb_build_object('id', p_sender));
  return jsonb_build_object('ok', true, 'state', 'ok');
end $$;
grant execute on function outreach_sender_enable(uuid) to authenticated;
revoke execute on function outreach_sender_enable(uuid) from public, anon;

-- -----------------------------------------------------------------------------
-- 9. Remove (PRD §3.4): begin → connector delete (edge function / deletion queue) → finish
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_remove_begin(p_sender uuid, p_via text, p_reason text default null, p_by uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; acct text; by_user uuid := coalesce(p_by, auth.uid()); r jsonb;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if p_via not in ('app','owner_link','unipile_deleted','auto_after_disabled','trial_ended','workspace_deleted','reconcile','billing') then raise exception 'E_PAYLOAD_INVALID: unknown removed_via %', p_via; end if;
  if s.provider::text = 'WEBCHAT' then return jsonb_build_object('sender_id', p_sender, 'skipped', 'webchat', 'account_id', null, 'already', true); end if;
  if s.status::text in ('removed','erased') or s.deleted_at is not null then return jsonb_build_object('sender_id', p_sender, 'already', true, 'account_id', null, 'state', s.status); end if;
  if s.status <> 'disabled' then perform outreach__sender_disable_core(p_sender, coalesce(p_reason, 'remove:' || p_via), by_user, p_via); end if;
  acct := s.unipile_account_id;
  update outreach_senders set removal_requested_at = coalesce(removal_requested_at, now()), removed_via = p_via, removed_by = by_user, status_reason = coalesce(p_reason, status_reason),
         auto_remove_at = null, auto_remove_notice_at = null where id = p_sender;
  if acct is not null then
    insert into outreach_account_deletions(account_id, sender_id, workspace_id, reason) values (acct, p_sender, s.workspace_id, 'sender_remove:' || p_via)
    on conflict (account_id) do update set sender_id = excluded.sender_id, workspace_id = excluded.workspace_id, reason = excluded.reason, done_at = null, next_attempt_at = now(), alerted_at = null;
  end if;
  update outreach_slot_reservations set released_at = now(), release_reason = 'failed' where sender_id = p_sender and released_at is null;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'remove_requested', 'by', by_user, 'via', p_via, 'reason', p_reason, 'account_id', acct));
  perform outreach_audit(s.workspace_id, 'sender.remove_requested', 'sender', p_sender::text, jsonb_build_object('via', p_via, 'reason', p_reason, 'account_id', acct), case when by_user is null then 'system' else 'user' end);
  if acct is null then
    r := outreach_sender_remove_finish(p_sender);
    return jsonb_build_object('sender_id', p_sender, 'account_id', null, 'already', false, 'state', 'removed') || coalesce(r, '{}'::jsonb);
  end if;
  return jsonb_build_object('sender_id', p_sender, 'account_id', acct, 'already', false, 'state', 'pending');
end $$;
revoke execute on function outreach_sender_remove_begin(uuid, text, text, uuid) from public, anon, authenticated;

create or replace function outreach_sender_remove_finish(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; acct text; n_pool int := 0; n_rules int := 0; n_imp int := 0; n_cons int := 0; n_auth int := 0; n_tasks int := 0; n_ai int := 0;
begin
  -- not granted to signed-in users; reachable through remove_begin (no connector account to delete) and the deletion queue
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'manager');
  if s.status::text in ('removed','erased') then return jsonb_build_object('ok', true, 'already', true); end if;
  if s.removal_requested_at is null then raise exception 'E_CONFLICT: removal was not requested for sender %', p_sender; end if;
  acct := s.unipile_account_id;
  update outreach_senders
     set status = 'removed', removed_at = now(), unipile_account_id = null,
         previous_unipile_account_id = coalesce(acct, previous_unipile_account_id),
         unipile_account_id_history = case when acct is not null and not (acct = any(unipile_account_id_history)) then array_append(unipile_account_id_history, acct) else unipile_account_id_history end,
         auto_remove_at = null, auto_remove_notice_at = null, paused_until = null, reconnect_attempts = 0, reconnect_notified_at = null, reconnect_reminders = 0,
         extension_token_issued_at = null, pause_resume_at = null
   where id = p_sender;
  -- stored credentials: session cookies, extension pairing token (PRD §3.4 step 4)
  delete from outreach_sender_secrets where sender_id = p_sender;
  delete from outreach_sender_tokens where sender_id = p_sender;
  insert into outreach_secret_access_log(sender_id, fn) values (p_sender, 'sender_remove');
  -- out of every pool (the pool trigger also drops it; this records the count)
  update outreach_sequences set sender_pool = array_remove(sender_pool, p_sender), updated_at = now() where workspace_id = s.workspace_id and p_sender = any(sender_pool);
  get diagnostics n_pool = row_count;
  update outreach_auto_enroll_rules r set active = false, paused_reason = 'sender_removed', paused_at = now()
   where r.active and r.sequence_id in (select q.id from outreach_sequences q where q.workspace_id = s.workspace_id and q.status = 'active'
     and not exists (select 1 from outreach_senders o where o.id = any(q.sender_pool) and o.status = 'ok' and o.deleted_at is null));
  get diagnostics n_rules = row_count;
  update outreach_import_jobs set status = 'cancelled', error = coalesce(error, 'sender_removed'), finished_at = coalesce(finished_at, now()) where sender_id = p_sender and status in ('queued','running','paused');
  get diagnostics n_imp = row_count;
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'sender_removed' where sender_id = p_sender and revoked_at is null;
  get diagnostics n_cons = row_count;
  update outreach_profile_authority set revoked_at = now(), revoked_reason = 'sender_removed' where sender_id = p_sender and revoked_at is null;
  get diagnostics n_auth = row_count;
  update outreach_ai_reply_runs set status = 'cancelled', flags = array_append(flags, 'sender_removed') where sender_id = p_sender and status = 'scheduled';
  get diagnostics n_ai = row_count;
  update outreach_tasks set completed_at = now() where sender_id = p_sender and kind = 'reconnect' and completed_at is null;
  get diagnostics n_tasks = row_count;
  update outreach_slot_reservations set released_at = now(), release_reason = 'failed' where sender_id = p_sender and released_at is null;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'remove', 'via', s.removed_via, 'by', s.removed_by, 'account_id', acct,
    'pools', n_pool, 'rules_paused', n_rules, 'imports_cancelled', n_imp, 'consents_revoked', n_cons, 'authority_revoked', n_auth, 'ai_runs_cancelled', n_ai, 'reconnect_tasks_closed', n_tasks));
  perform outreach_audit(s.workspace_id, 'sender.removed', 'sender', p_sender::text, jsonb_build_object('via', s.removed_via, 'account_id', acct, 'pools', n_pool, 'rules_paused', n_rules, 'imports_cancelled', n_imp), case when s.removed_by is null then 'system' else 'user' end);
  perform outreach_emit_event(s.workspace_id, 'sender.removed', jsonb_build_object('id', p_sender, 'via', s.removed_via));
  return jsonb_build_object('ok', true, 'sender_id', p_sender, 'account_id', acct, 'pools', n_pool, 'rules_paused', n_rules, 'imports_cancelled', n_imp, 'consents_revoked', n_cons, 'authority_revoked', n_auth);
end $$;
revoke execute on function outreach_sender_remove_finish(uuid) from public, anon, authenticated;

-- Billing v2's disconnect is the remove flow now (same signature: billing tick, outreach-sender-manage, disconnect.ts keep working).
create or replace function outreach_disconnect_sender(p_sender uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; via text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  via := case p_reason when 'trial_expired' then 'trial_ended' when 'user_disconnected' then 'app'
                       when 'billing_suspended' then 'billing' when 'billing_cancelled' then 'billing' when 'over_plan_limit' then 'billing'
                       else null end;
  if via is null then raise exception 'E_PAYLOAD_INVALID: unknown disconnect reason %', p_reason; end if;
  r := outreach_sender_remove_begin(p_sender, via, p_reason, null);
  return jsonb_build_object('sender_id', p_sender, 'account_id', r->>'account_id', 'already', coalesce((r->>'already')::boolean, false), 'state', r->>'state');
end $$;

-- the deletion queue confirms the connector delete → the removal finishes (PRD §3.4 step 3→4). Retries keep their backoff.
create or replace function outreach_account_deletion_result(p_account text, p_ok boolean, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare d outreach_account_deletions%rowtype; wait interval; alert boolean := false; fin jsonb := null;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into d from outreach_account_deletions where account_id = p_account for update;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_ok then
    update outreach_account_deletions set done_at = now(), attempts = attempts + 1, last_error = null where account_id = p_account;
    if d.sender_id is not null and exists (select 1 from outreach_senders x where x.id = d.sender_id and x.removal_requested_at is not null and x.status::text not in ('removed','erased')) then
      begin fin := outreach_sender_remove_finish(d.sender_id);
      exception when others then raise warning 'outreach_account_deletion_result: remove_finish(%) failed: %', d.sender_id, sqlerrm; fin := jsonb_build_object('error', sqlerrm); end;
    end if;
    return jsonb_build_object('ok', true, 'done', true, 'sender_id', d.sender_id, 'finished', fin);
  end if;
  wait := case d.attempts when 0 then interval '5 minutes' when 1 then interval '15 minutes' when 2 then interval '1 hour' when 3 then interval '3 hours' else interval '6 hours' end;
  alert := d.alerted_at is null and d.created_at < now() - interval '24 hours';
  update outreach_account_deletions set attempts = attempts + 1, last_error = left(coalesce(p_error, 'unknown'), 500), next_attempt_at = now() + wait,
         alerted_at = case when alert then now() else alerted_at end where account_id = p_account;
  if alert then
    perform outreach_audit(d.workspace_id, 'billing.account_delete_stuck', 'sender', d.sender_id::text, jsonb_build_object('account_id', p_account, 'attempts', d.attempts + 1, 'error', p_error), 'system');
    if d.sender_id is not null and d.workspace_id is not null then
      perform outreach_emit_event(d.workspace_id, 'sender.removal_stuck', jsonb_build_object('id', d.sender_id, 'account_id', p_account, 'attempts', d.attempts + 1));
    end if;
  end if;
  return jsonb_build_object('ok', true, 'done', false, 'alert', alert, 'sender_id', d.sender_id, 'workspace_id', d.workspace_id);
end $$;

-- -----------------------------------------------------------------------------
-- 10. Erase (PRD §3.5, §5.4): owner only, 24 h ahead, cancellable; the worker runs it
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_erase_schedule(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; at timestamptz; r jsonb := null;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'owner');
  if s.provider::text = 'WEBCHAT' then raise exception 'E_PAYLOAD_INVALID: a website inbox is deleted from its Website agents page'; end if;
  if s.status::text = 'erased' then return jsonb_build_object('ok', true, 'already', true); end if;
  if s.erase_scheduled_at is not null then return jsonb_build_object('ok', true, 'already', true, 'erase_scheduled_at', s.erase_scheduled_at); end if;
  if s.status::text <> 'removed' then r := outreach_sender_remove_begin(p_sender, 'app', 'erase', auth.uid()); end if;   -- the caller deletes the connector account
  at := now() + interval '24 hours';
  update outreach_senders set erase_scheduled_at = at, erase_requested_by = auth.uid() where id = p_sender;
  insert into outreach_sender_erase_jobs(sender_id, workspace_id, scheduled_at) values (p_sender, s.workspace_id, at)
  on conflict (sender_id) do update set scheduled_at = excluded.scheduled_at, started_at = null, finished_at = null, attempts = 0, last_error = null, storage_paths = '[]'::jsonb, storage_done = 0;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'erase_scheduled', 'by', auth.uid(), 'at', at));
  perform outreach_audit(s.workspace_id, 'sender.erase_scheduled', 'sender', p_sender::text, jsonb_build_object('at', at), null);
  perform outreach_emit_event(s.workspace_id, 'sender.erase_scheduled', jsonb_build_object('id', p_sender, 'at', at));
  return jsonb_build_object('ok', true, 'erase_scheduled_at', at, 'remove', r);
end $$;
grant execute on function outreach_sender_erase_schedule(uuid) to authenticated;
revoke execute on function outreach_sender_erase_schedule(uuid) from public, anon;

create or replace function outreach_sender_erase_cancel(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__lifecycle_require(s.workspace_id, 'owner');
  if s.status::text = 'erased' then raise exception 'E_CONFLICT: this sender was already erased'; end if;
  if s.erase_scheduled_at is null then return jsonb_build_object('ok', true, 'already', true); end if;
  if exists (select 1 from outreach_sender_erase_jobs j where j.sender_id = p_sender and j.started_at is not null and j.finished_at is null) then
    raise exception 'E_CONFLICT: the erase is already running';
  end if;
  update outreach_senders set erase_scheduled_at = null, erase_requested_by = null where id = p_sender;
  delete from outreach_sender_erase_jobs where sender_id = p_sender and started_at is null;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'erase_cancelled', 'by', auth.uid()));
  perform outreach_audit(s.workspace_id, 'sender.erase_cancelled', 'sender', p_sender::text, null, null);
  return jsonb_build_object('ok', true);
end $$;
grant execute on function outreach_sender_erase_cancel(uuid) to authenticated;
revoke execute on function outreach_sender_erase_cancel(uuid) from public, anon;

-- due erasures: only a removed sender (the connector account is gone) past its scheduled time
create or replace function outreach_sender_erase_due(p_limit int default 10)
returns table(sender_id uuid, workspace_id uuid, scheduled_at timestamptz, storage_paths jsonb, started boolean)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    select s.id, s.workspace_id, s.erase_scheduled_at, coalesce(j.storage_paths, '[]'::jsonb), j.started_at is not null
      from outreach_senders s left join outreach_sender_erase_jobs j on j.sender_id = s.id
     where s.erase_scheduled_at is not null and s.erase_scheduled_at <= now() and s.erased_at is null and s.status::text = 'removed'
       and (j.sender_id is null or j.finished_at is null) and coalesce(j.attempts, 0) < 20
     order by s.erase_scheduled_at limit p_limit;
end $$;
revoke execute on function outreach_sender_erase_due(int) from public, anon, authenticated;

-- Storage objects that belong to this sender's conversations: stored attachments and chat avatars (prefix per chat)
create or replace function outreach_sender_erase_storage_paths(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; paths jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select coalesce(jsonb_agg(distinct p), '[]'::jsonb) into paths from (
    select jsonb_build_object('bucket', 'outreach-attachments', 'path', a->>'id') p
      from outreach_messages m join outreach_chats c on c.id = m.chat_id, jsonb_array_elements(m.attachments) a
     where c.sender_id = p_sender and coalesce((a->>'storage')::boolean, false) and coalesce(a->>'id', '') <> ''
    union all
    select jsonb_build_object('bucket', 'outreach-attachments', 'prefix', s.workspace_id::text || '/avatars/' || c.id::text) from outreach_chats c where c.sender_id = p_sender
  ) x;
  return paths;
end $$;
revoke execute on function outreach_sender_erase_storage_paths(uuid) from public, anon, authenticated;

-- marks a job started and records what is left to delete in Storage (the worker calls it before and during the deletes)
create or replace function outreach_sender_erase_progress(p_sender uuid, p_storage_paths jsonb, p_done int, p_error text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_sender_erase_jobs(sender_id, workspace_id, scheduled_at, started_at, storage_paths, storage_done, attempts, last_error)
  select s.id, s.workspace_id, coalesce(s.erase_scheduled_at, now()), now(), p_storage_paths, p_done, 1, p_error from outreach_senders s where s.id = p_sender
  on conflict (sender_id) do update set started_at = coalesce(outreach_sender_erase_jobs.started_at, now()), storage_paths = excluded.storage_paths,
    storage_done = outreach_sender_erase_jobs.storage_done + excluded.storage_done, attempts = outreach_sender_erase_jobs.attempts + 1, last_error = excluded.last_error;
end $$;
revoke execute on function outreach_sender_erase_progress(uuid, jsonb, int, text) from public, anon, authenticated;

-- §5.4, in that order, one transaction. Storage must be done before (the worker checks).
create or replace function outreach_sender_erase_execute(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; n_msgs int; n_chats int; n_runs int; n_tasks int; n_prof int; n_ev int; n_act int; n_lss int; n_audit int; n_clips int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.status::text = 'erased' then return jsonb_build_object('ok', true, 'already', true); end if;
  if s.erase_scheduled_at is null or s.erase_scheduled_at > now() then raise exception 'E_CONFLICT: erase is not due for sender %', p_sender; end if;
  if s.status::text <> 'removed' then raise exception 'E_CONFLICT: sender % must be removed before it is erased (it is %)', p_sender, s.status; end if;
  if exists (select 1 from outreach_sender_erase_jobs j where j.sender_id = p_sender and jsonb_array_length(j.storage_paths) > 0) then
    raise exception 'E_CONFLICT: Storage deletes for sender % are not finished', p_sender;
  end if;
  -- conversations (messages, notes, drafts and AI runs on those chats cascade from chats)
  select count(*) into n_msgs from outreach_messages m where m.chat_id in (select id from outreach_chats where sender_id = p_sender);
  delete from outreach_ai_reply_runs where sender_id = p_sender;
  get diagnostics n_runs = row_count;
  delete from outreach_chats where sender_id = p_sender;
  get diagnostics n_chats = row_count;
  delete from outreach_tasks where sender_id = p_sender;
  get diagnostics n_tasks = row_count;
  -- profile studio data about this person
  delete from outreach_profile_changes where sender_id = p_sender;
  get diagnostics n_prof = row_count;
  delete from outreach_profile_snapshots where sender_id = p_sender;
  delete from outreach_profile_qa where sender_id = p_sender;
  delete from outreach_profile_authority_links where sender_id = p_sender;
  delete from outreach_profile_authority where sender_id = p_sender;
  delete from outreach_ai_reply_consent_links where sender_id = p_sender;
  delete from outreach_ai_reply_consent where sender_id = p_sender;
  delete from outreach_voice_clips where sender_id = p_sender;
  get diagnostics n_clips = row_count;
  -- operational history and budgets
  delete from outreach_sender_events where sender_id = p_sender;
  get diagnostics n_ev = row_count;
  delete from outreach_sender_budgets where sender_id = p_sender;
  delete from outreach_sender_budgets_scoped where sender_id = p_sender;
  delete from outreach_sender_followers where sender_id = p_sender;
  delete from outreach_followers_poll_plan where sender_id = p_sender;
  delete from outreach_poll_plan where sender_id = p_sender;
  delete from outreach_sender_secrets where sender_id = p_sender;
  delete from outreach_sender_tokens where sender_id = p_sender;
  delete from outreach_sender_owner_links where sender_id = p_sender;
  delete from outreach_slot_reservations where sender_id = p_sender;
  -- kept, without content: actions (report counts), the contacted record (no second contact by mistake)
  update outreach_actions set payload = '{}'::jsonb, response = null where sender_id = p_sender;
  get diagnostics n_act = row_count;
  update outreach_lead_sender_state set unipile_chat_id = null, invitation_id = null where sender_id = p_sender;
  get diagnostics n_lss = row_count;
  update outreach_audit_log set diff = null where entity = 'sender' and entity_id = p_sender::text;
  get diagnostics n_audit = row_count;
  -- the tombstone: no identifier to match on, hidden from the app (deleted_at), still joined by the reports as "Erased sender"
  update outreach_senders
     set display_name = 'Erased sender', public_identifier = null, provider_user_id = null, owner_email = null, owner_user_id = null, user_agent = null, proxy_ip_hint = null,
         picture_url = null, schedule = '{}'::jsonb, signature = null, label = null, booking_link = null, bcc_address = null, alert_emails = '{}',
         status = 'erased', status_reason = null, erased_at = now(), erase_scheduled_at = null, deleted_at = coalesce(deleted_at, now()), previous_unipile_account_id = null
   where id = p_sender;
  update outreach_sender_erase_jobs set finished_at = now(), last_error = null where sender_id = p_sender;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (s.workspace_id, s.erase_requested_by, 'system', 'sender.erased', 'sender', p_sender::text,
          jsonb_build_object('chats', n_chats, 'messages', n_msgs, 'ai_runs', n_runs, 'tasks', n_tasks, 'profile_changes', n_prof, 'events', n_ev, 'actions_blanked', n_act, 'lead_states_kept', n_lss, 'audit_rows_blanked', n_audit, 'voice_clips', n_clips));
  perform outreach_emit_event(s.workspace_id, 'sender.erased', jsonb_build_object('id', p_sender));
  return jsonb_build_object('ok', true, 'chats', n_chats, 'messages', n_msgs, 'ai_runs', n_runs, 'tasks', n_tasks, 'profile_changes', n_prof, 'events', n_ev, 'actions_blanked', n_act, 'lead_states_kept', n_lss);
end $$;
revoke execute on function outreach_sender_erase_execute(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 11. Reconnect restores the removed sender (PRD §5.1)
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_restore_match(p_ws uuid, p_provider outreach_provider_t, p_provider_user_id text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select id from outreach_senders where workspace_id = p_ws and provider = p_provider and provider_user_id = p_provider_user_id
    and status::text = 'removed' and deleted_at is null order by removed_at desc nulls last limit 1
$$;
revoke execute on function outreach_sender_restore_match(uuid, outreach_provider_t, text) from public, anon, authenticated;

-- after the fold gave the row its new connector account: clear the removal, decay warmup one level per full 30 days away (never below 1)
create or replace function outreach_sender_restore_apply(p_sender uuid, p_account_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; away_days int; lvl int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  away_days := greatest(0, floor(extract(epoch from (now() - coalesce(s.removed_at, now()))) / 86400)::int);
  lvl := case when s.warmup_level >= 1 then greatest(1, s.warmup_level - away_days / 30) else 0 end;
  update outreach_senders
     set removed_at = null, removal_requested_at = null, removed_via = null, removed_by = null, restored_at = now(), erase_scheduled_at = null, erase_requested_by = null,
         warmup_level = lvl, unipile_account_id = coalesce(p_account_id, unipile_account_id),
         status = case when status::text in ('removed','erased','disconnected') then 'connecting'::outreach_sender_status_t else status end
   where id = p_sender;
  delete from outreach_sender_erase_jobs where sender_id = p_sender and started_at is null;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'restore', 'account_id', p_account_id, 'away_days', away_days, 'warmup_from', s.warmup_level, 'warmup_to', lvl, 'removed_at', s.removed_at));
  perform outreach_audit(s.workspace_id, 'sender.restored', 'sender', p_sender::text, jsonb_build_object('away_days', away_days, 'warmup_from', s.warmup_level, 'warmup_to', lvl), 'system');
  perform outreach_emit_event(s.workspace_id, 'sender.restored', jsonb_build_object('id', p_sender, 'removed_at', s.removed_at));
  return jsonb_build_object('ok', true, 'away_days', away_days, 'warmup_level', lvl, 'removed_at', s.removed_at);
end $$;
revoke execute on function outreach_sender_restore_apply(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 12. Owner links (PRD §4): signed, single use, 30 days, bound to the sender
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_owner_link_create(p_sender uuid, p_purpose text, p_ttl_days int default 30) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare tok text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_purpose not in ('disconnect','erase_request') then raise exception 'E_PAYLOAD_INVALID: purpose'; end if;
  if not exists (select 1 from outreach_senders where id = p_sender and deleted_at is null) then raise exception 'E_NOT_FOUND'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_sender_owner_links(token_sha256, sender_id, purpose, expires_at) values (encode(digest(tok, 'sha256'), 'hex'), p_sender, p_purpose, now() + make_interval(days => greatest(1, least(90, p_ttl_days))));
  -- links are per email; keep the table small
  delete from outreach_sender_owner_links where sender_id = p_sender and (expires_at < now() - interval '30 days' or used_at < now() - interval '30 days');
  return tok;
end $$;
revoke execute on function outreach_sender_owner_link_create(uuid, text, int) from public, anon, authenticated;

create or replace function outreach_sender_owner_link_peek(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_sender_owner_links%rowtype; s outreach_senders%rowtype; wname text; b jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into l from outreach_sender_owner_links where token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return jsonb_build_object('valid', false, 'reason', 'unknown'); end if;
  select * into s from outreach_senders where id = l.sender_id;
  select name, branding into wname, b from outreach_workspaces where id = s.workspace_id;
  return jsonb_build_object('valid', l.used_at is null and l.expires_at > now(), 'used', l.used_at is not null, 'expired', l.expires_at <= now(), 'purpose', l.purpose, 'expires_at', l.expires_at,
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'public_identifier', s.public_identifier, 'erase_scheduled_at', s.erase_scheduled_at),
    'workspace', jsonb_build_object('id', s.workspace_id, 'name', wname),
    'branding', coalesce(b, '{}'::jsonb) - 'email_from_address' - 'email_from_name');
end $$;
revoke execute on function outreach_sender_owner_link_peek(text) from public, anon, authenticated;

create or replace function outreach_sender_owner_link_use(p_token text, p_ip inet default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_sender_owner_links%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_sender_owner_links set used_at = now(), used_ip = p_ip
   where token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and used_at is null and expires_at > now()
   returning * into l;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'sender_id', l.sender_id, 'purpose', l.purpose);
end $$;
revoke execute on function outreach_sender_owner_link_use(text, inet) from public, anon, authenticated;

-- an owner's deletion request becomes a task for the workspace owners (legal deadlines: PRD open question 3)
create or replace function outreach_sender_erase_request_task(p_sender uuid, p_source text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; tid uuid; owner_id uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select user_id into owner_id from outreach_members where workspace_id = s.workspace_id and role = 'owner' order by created_at limit 1;
  insert into outreach_tasks(workspace_id, client_id, kind, sender_id, title, body, due_at, assigned_to)
  values (s.workspace_id, s.client_id, 'follow_up', p_sender, 'Data deletion request: ' || coalesce(s.display_name, 'sender'),
          'The owner of this account asked for their conversations and personal data to be deleted (' || p_source || '). Decide on the sender page: Account → Erase. Under the GDPR the answer is usually due within one month.',
          now() + interval '14 days', owner_id)
  returning id into tid;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'erase_requested_by_owner', 'source', p_source, 'task_id', tid));
  perform outreach_audit(s.workspace_id, 'sender.erase_requested_by_owner', 'sender', p_sender::text, jsonb_build_object('source', p_source, 'task_id', tid), 'system');
  perform outreach_emit_event(s.workspace_id, 'sender.erase_requested', jsonb_build_object('id', p_sender, 'task_id', tid));
  return tid;
end $$;
revoke execute on function outreach_sender_erase_request_task(uuid, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 13. "Why isn't this sending?" learns the lifecycle states (PRD §9)
-- -----------------------------------------------------------------------------
select outreach__patch_fn('public.outreach__sender_causes(uuid,text[])'::regprocedure, 'E_SENDER_REMOVED',
$q$  elsif s.status::text = 'disconnected' then$q$,
$q$  elsif s.status::text in ('removed','erased','disconnected') then
    c := c || jsonb_build_object('code','E_SENDER_REMOVED','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', nm || case when s.status::text = 'erased' then ' was erased' else ' was removed' || case s.removed_via when 'trial_ended' then ' (the trial ended)' when 'billing' then ' (billing)' when 'owner_link' then ' (by its owner)'
                  when 'unipile_deleted' then ' (the account was deleted on the connector side)' when 'auto_after_disabled' then ' (disabled for too long)' else '' end end,
      'remedy', case when s.status::text = 'erased' then 'Connect the account again as a new sender.' else 'The owner signs in again from the sender page (Reconnect); its history comes back.' end);
  elsif s.status = 'disabled' then
    c := c || jsonb_build_object('code','E_SENDER_DISABLED','blocking',true,'sender',nm,'sender_id',s.id,'detail', nm || ' is disabled','remedy','A manager enables it on the sender page, then enrols leads again.');
  elsif s.status = 'paused' and coalesce(s.status_reason,'') not in ('over_plan_limit','billing_suspended','billing_cancelled','trial_expired') then
    c := c || jsonb_build_object('code','E_SENDER_PAUSED','blocking',true,'sender',nm,'sender_id',s.id,'next_capacity',s.pause_resume_at,
      'detail', nm || ' is paused' || case when s.pause_resume_at is not null then ' until ' || to_char(s.pause_resume_at at time zone s.timezone, 'Mon DD HH24:MI') else '' end || case when coalesce(s.status_reason,'user_paused') <> 'user_paused' then ' (' || s.status_reason || ')' else '' end,
      'remedy','A manager resumes it on the sender page. Replies still go out.');
  elsif s.status::text = 'disconnected_legacy' then$q$);
select outreach__patch_fn('public.outreach__sender_causes(uuid,text[])'::regprocedure, $q$('disconnected','removed','erased','disabled')$q$,
$q$  if s.status <> 'ok' and s.status::text <> 'disconnected' and not (s.status = 'paused' and coalesce(s.status_reason,'') = 'over_plan_limit') then$q$,
$q$  if s.status <> 'ok' and s.status::text not in ('disconnected','removed','erased','disabled')
     and not (s.status = 'paused' and coalesce(s.status_reason,'') not in ('billing_suspended','billing_cancelled','trial_expired')) then$q$);

select outreach__patch_fn('public.outreach_why_not_sending(uuid,uuid,uuid)'::regprocedure, 'E_POOL_NO_ACTIVE_SENDER',
$q$    if coalesce(array_length(q.sender_pool,1),0) = 0 then causes := causes || jsonb_build_object('code','E_POOL_EMPTY','blocking',true,'detail','The sequence has no senders','remedy','Add a connected sender to the pool.'); end if;$q$,
$q$    if coalesce(array_length(q.sender_pool,1),0) = 0 then causes := causes || jsonb_build_object('code','E_POOL_EMPTY','blocking',true,'detail','The sequence has no senders','remedy','Add a connected sender to the pool.'); end if;
    if coalesce(array_length(q.sender_pool,1),0) > 0 and not exists (select 1 from outreach_senders sp_ where sp_.id = any(q.sender_pool) and sp_.status = 'ok' and sp_.deleted_at is null) then
      causes := causes || jsonb_build_object('code','E_POOL_NO_ACTIVE_SENDER','blocking',true,'detail','Not sending: no active sender (every sender in the pool is paused, disabled or removed)','remedy','Resume or enable a sender, or add another connected sender to the pool.');
    end if;$q$);

-- -----------------------------------------------------------------------------
-- 14. Re-enrol with other senders (PRD D6): an assignment override for one preview / commit
-- -----------------------------------------------------------------------------
-- outreach__enroll_plan / outreach_enroll_preview / outreach_enroll_leads gain `p_assignment text default null`; when given
-- ('fresh_sender', 'same_sender', 'least_loaded', 'round_robin') it replaces the sequence's own rule for that call.
do $$
declare def text;
begin
  if to_regprocedure('public.outreach__enroll_plan(uuid,uuid[],uuid,boolean)') is not null then
    def := replace(pg_get_functiondef('public.outreach__enroll_plan(uuid,uuid[],uuid,boolean)'::regprocedure), chr(13), '');
    if position('p_include_replied boolean)' in def) = 0 or position($a$elsif s.assignment = 'fresh_sender' then$a$ in def) = 0 then
      raise exception 'outreach__enroll_plan: anchors not found, 096 §14 not applied';
    end if;
    def := replace(def, 'p_include_replied boolean)', 'p_include_replied boolean, p_assignment text DEFAULT NULL)');
    def := replace(def, $a$elsif s.assignment = 'fresh_sender' then$a$, $a$elsif coalesce(p_assignment, s.assignment::text) = 'fresh_sender' then$a$);
    def := replace(def, $a$elsif s.assignment = 'same_sender' then$a$,  $a$elsif coalesce(p_assignment, s.assignment::text) = 'same_sender' then$a$);
    def := replace(def, $a$elsif s.assignment = 'least_loaded' then$a$, $a$elsif coalesce(p_assignment, s.assignment::text) = 'least_loaded' then$a$);
    execute def;
    drop function public.outreach__enroll_plan(uuid, uuid[], uuid, boolean);
    revoke execute on function public.outreach__enroll_plan(uuid, uuid[], uuid, boolean, text) from public, anon, authenticated;
  end if;

  if to_regprocedure('public.outreach_enroll_preview(uuid,uuid[],uuid,boolean)') is not null then
    def := replace(pg_get_functiondef('public.outreach_enroll_preview(uuid,uuid[],uuid,boolean)'::regprocedure), chr(13), '');
    if position('p_include_replied boolean DEFAULT false)' in def) = 0 or position('outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied))' in def) = 0 then
      raise exception 'outreach_enroll_preview: anchors not found, 096 §14 not applied';
    end if;
    def := replace(def, 'p_include_replied boolean DEFAULT false)', 'p_include_replied boolean DEFAULT false, p_assignment text DEFAULT NULL)');
    def := replace(def, 'outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied))', 'outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied, p_assignment))');
    def := replace(def, $a$'assignment_rule', s.assignment,$a$, $a$'assignment_rule', coalesce(p_assignment, s.assignment::text),$a$);
    execute def;
    drop function public.outreach_enroll_preview(uuid, uuid[], uuid, boolean);
    grant execute on function public.outreach_enroll_preview(uuid, uuid[], uuid, boolean, text) to authenticated;
    revoke execute on function public.outreach_enroll_preview(uuid, uuid[], uuid, boolean, text) from public, anon;
  end if;

  if to_regprocedure('public.outreach_enroll_leads(uuid,uuid[],uuid,int,boolean,uuid,boolean)') is not null then
    def := replace(pg_get_functiondef('public.outreach_enroll_leads(uuid,uuid[],uuid,int,boolean,uuid,boolean)'::regprocedure), chr(13), '');
    if position('p_wait_enrichment boolean DEFAULT NULL::boolean)' in def) = 0 or position('outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied) loop' in def) = 0 then
      raise exception 'outreach_enroll_leads: anchors not found, 096 §14 not applied';
    end if;
    def := replace(def, 'p_wait_enrichment boolean DEFAULT NULL::boolean)', 'p_wait_enrichment boolean DEFAULT NULL::boolean, p_assignment text DEFAULT NULL)');
    def := replace(def, 'outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied) loop', 'outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied, p_assignment) loop');
    execute def;
    drop function public.outreach_enroll_leads(uuid, uuid[], uuid, int, boolean, uuid, boolean);
    grant execute on function public.outreach_enroll_leads(uuid, uuid[], uuid, int, boolean, uuid, boolean, text) to authenticated;
    revoke execute on function public.outreach_enroll_leads(uuid, uuid[], uuid, int, boolean, uuid, boolean, text) from public, anon;
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 15. Existing rows
-- -----------------------------------------------------------------------------
-- billing v2 'disconnected' → 'removed'
update outreach_senders
   set status = 'removed', removed_at = coalesce(disconnected_at, updated_at, now()),
       removed_via = case status_reason when 'trial_expired' then 'trial_ended' when 'user_disconnected' then 'app' else 'billing' end,
       unipile_account_id_history = case when previous_unipile_account_id is not null and not (previous_unipile_account_id = any(unipile_account_id_history)) then array_append(unipile_account_id_history, previous_unipile_account_id) else unipile_account_id_history end
 where status::text = 'disconnected';
-- disabled before this build: the old disable deleted the connector account, so these are removed senders (Reconnect brings them back)
update outreach_senders
   set status = 'removed', removed_at = coalesce(last_disconnect_at, updated_at, now()), removed_via = 'app',
       unipile_account_id_history = case when previous_unipile_account_id is not null and not (previous_unipile_account_id = any(unipile_account_id_history)) then array_append(unipile_account_id_history, previous_unipile_account_id) else unipile_account_id_history end
 where status = 'disabled' and unipile_account_id is null and deleted_at is null and provider::text <> 'WEBCHAT';
-- a disabled sender that is still linked gets its auto-remove date from today
update outreach_senders set disabled_at = coalesce(disabled_at, updated_at, now()), auto_remove_at = now() + make_interval(days => auto_remove_after_days)
 where status = 'disabled' and unipile_account_id is not null and deleted_at is null and auto_remove_at is null;

comment on function outreach_sender_lifecycle_preview(uuid, text) is 'sender-lifecycle: counts for the pause / disable / remove / erase dialogs';
comment on function outreach_sender_remove_begin(uuid, text, text, uuid) is 'sender-lifecycle: disable if needed + request removal; the connector delete is queued (outreach_account_deletions) and confirmed by outreach_sender_remove_finish';

-- sender lifecycle: a sender keeps its connector account id until outreach_sender_remove_finish, so a queued delete whose
-- sender has a removal in flight must still be due (the old guard skipped every account a sender row still names).
create or replace function outreach_account_deletions_due(p_limit int default 25)
returns table(account_id text, sender_id uuid, workspace_id uuid, reason text, attempts int, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  select d.account_id, d.sender_id, d.workspace_id, d.reason, d.attempts, d.created_at from outreach_account_deletions d
   where d.done_at is null and d.next_attempt_at <= now()
     -- an account a live sender still uses is not deleted, unless that sender's removal is in flight (the delete IS the removal)
     and not exists (select 1 from outreach_senders s where s.unipile_account_id = d.account_id and s.removal_requested_at is null)
   order by d.next_attempt_at limit greatest(p_limit, 1);
end $$;

drop function if exists outreach__patch_fn(regprocedure, text, text, text);
