-- =============================================================================
-- Outreach Platform — 059 billing v2 functions (pricing-billing-PRD.md §6, §7, §9.1, §10, §12)
--   price quote (best price) · account slots, reservations and the guard trigger · plan features
--   disconnect / over-limit enforcement · subscription state from Stripe · trial expiry, suspension, hygiene
--   early supporters, trials per business · billing state for the app
-- Run after 057 + 058. Idempotent (create or replace). Contract: docs/outreach/BILLING.md
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Switches and numbers
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_enforced() returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select value in ('true'::jsonb, '"true"'::jsonb) from outreach_flags where key = 'billing_enforced'), false)
$$;

create or replace function outreach__billing_int(p_key text, p_default int) returns int
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select case when jsonb_typeof(value) = 'number' then (value #>> '{}')::int when (value #>> '{}') ~ '^\d+$' then (value #>> '{}')::int end
                     from outreach_flags where key = p_key), p_default)
$$;

create or replace function outreach__billing_text(p_key text, p_default text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select nullif(value #>> '{}', '') from outreach_flags where key = p_key), p_default)
$$;

create or replace function outreach__plan_label(p_plan text) returns text language sql immutable as $$
  select case p_plan when 'launch' then 'Launch' when 'scale' then 'Scale' when 'enterprise' then 'Enterprise' when 'trial' then 'Trial'
                     when 'trial_expired' then 'Trial ended' when 'suspended' then 'Suspended' when 'cancelled' then 'Cancelled' else initcap(coalesce(p_plan, '')) end
$$;

create or replace function outreach__plan_rank(p_plan text) returns int language sql immutable as $$
  select case p_plan when 'launch' then 1 when 'scale' then 2 when 'enterprise' then 3 else 0 end
$$;

create or replace function outreach__period_months(p_period text) returns int language sql immutable as $$
  select case p_period when 'monthly' then 1 when 'quarterly' then 3 when 'annual' then 12 end
$$;

-- -----------------------------------------------------------------------------
-- Price quote: the best-price rule (PRD §2). The TypeScript twin is pricing_core.ts quote().
-- -----------------------------------------------------------------------------
create or replace function outreach_quote_accounts(p_plan text, p_period text, p_accounts int, p_version text default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v text := coalesce(p_version, outreach__billing_text('billing_price_version', 'v1')); months int := outreach__period_months(p_period);
        per numeric; total numeric; req_total numeric; billed int := p_accounts; r record; t numeric; key text;
begin
  if p_accounts is null or p_accounts < 1 then raise exception 'E_PAYLOAD_INVALID: at least 1 account'; end if;
  if months is null then raise exception 'E_PAYLOAD_INVALID: billing period must be monthly, quarterly or annual'; end if;
  select b.per_account_monthly, b.stripe_price_lookup_key into per, key from outreach_price_book b
   where b.version = v and b.plan = p_plan and b.billing_period = p_period and b.step_min <= p_accounts order by b.step_min desc limit 1;
  if per is null then raise exception 'E_PAYLOAD_INVALID: no price for plan % (%, %)', p_plan, p_period, v; end if;
  req_total := per * p_accounts * months; total := req_total;
  -- a bigger step that costs the same or less wins
  for r in select b.step_min, b.per_account_monthly from outreach_price_book b
            where b.version = v and b.plan = p_plan and b.billing_period = p_period and b.step_min > p_accounts order by b.step_min loop
    t := r.per_account_monthly * r.step_min * months;
    if t <= total then billed := r.step_min; total := t; per := r.per_account_monthly; end if;
  end loop;
  return jsonb_build_object('plan', p_plan, 'period', p_period, 'requested', p_accounts, 'billed', billed, 'per_account', per, 'months', months,
    'period_total', total, 'requested_total', req_total, 'best_price', billed <> p_accounts, 'lookup_key', key, 'version', v);
end $$;

-- -----------------------------------------------------------------------------
-- Plan features (PRD §7). No code compares plan names: everything asks these.
-- -----------------------------------------------------------------------------
-- The plan whose features a workspace has: its own plan; Scale during the trial; the last plan while suspended / cancelled / lapsed.
create or replace function outreach_feature_plan(ws uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when w.plan in ('launch','scale','enterprise') then w.plan
              when w.plan = 'trial' then outreach__billing_text('billing_trial_features_of', 'scale')
              else coalesce(nullif(w.plan_before_suspension, 'trial'), outreach__billing_text('billing_trial_features_of', 'scale')) end
    from outreach_workspaces w where w.id = ws
$$;

create or replace function outreach_has_feature(ws uuid, p_feature text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_billing_enforced() then true
              else coalesce((select f.enabled from outreach_plan_features f where f.plan = outreach_feature_plan(ws) and f.feature = p_feature), true) end
$$;

-- null = no limit
create or replace function outreach_plan_limit(ws uuid, p_feature text) returns int
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_billing_enforced() then null
              else (select f.limit_value from outreach_plan_features f where f.plan = outreach_feature_plan(ws) and f.feature = p_feature) end
$$;

-- the cheapest plan that includes a feature
create or replace function outreach_feature_min_plan(p_feature text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select f.plan from outreach_plan_features f where f.feature = p_feature and f.enabled order by outreach__plan_rank(f.plan) limit 1
$$;

-- raises E_PLAN_REQUIRED naming the plan that unlocks the feature, so the UI can show "Available on Scale — Upgrade"
create or replace function outreach_require_feature(ws uuid, p_feature text, p_what text default null) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if outreach_has_feature(ws, p_feature) then return; end if;
  raise exception 'E_PLAN_REQUIRED: Available on %. %', outreach__plan_label(outreach_feature_min_plan(p_feature)),
    coalesce(p_what, initcap(replace(p_feature, '_', ' '))) || ' is not part of the ' || outreach__plan_label(outreach_feature_plan(ws)) || ' plan.';
end $$;

-- -----------------------------------------------------------------------------
-- Read-only workspaces: suspended, cancelled and lapsed trials can read, never write.
-- -----------------------------------------------------------------------------
create or replace function outreach_plan_active(ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions, extensions as $$
  select coalesce((select plan not in ('suspended','cancelled','trial_expired') from outreach_workspaces where id = ws), false)
$$;

create or replace function outreach__plan_inactive_message(p_plan text) returns text language sql immutable as $$
  select case p_plan when 'trial_expired' then 'Your trial has ended. Subscribe to keep going; everything is still here.'
                     when 'cancelled' then 'This subscription has ended. Subscribe again to continue; your data is kept for 90 days.'
                     else 'This workspace is paused because of a billing issue. An owner can fix it on the Billing page.' end
$$;

-- Reads keep working in an inactive workspace: PostgREST runs STABLE functions in a read-only transaction, so "read-only
-- workspace" is exactly "may only call what cannot write". Volatile functions are refused as before.
create or replace function outreach_require(ws uuid, p_min text) returns void
language plpgsql stable security definer set search_path = public, extensions, extensions as $$
declare r outreach_role_t; pl text;
begin
  if outreach_is_service() then return; end if;
  r := outreach_role_in(ws);
  if r is null then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
  if not outreach_plan_active(ws) and coalesce(current_setting('transaction_read_only', true), 'off') <> 'on' then
    select plan into pl from outreach_workspaces where id = ws;
    raise exception 'E_PLAN_SUSPENDED: %', outreach__plan_inactive_message(pl);
  end if;
  if p_min = 'owner' and r <> 'owner' then raise exception 'E_FORBIDDEN: owner required'; end if;
  if p_min = 'manager' and r not in ('owner','manager') then raise exception 'E_FORBIDDEN: manager required'; end if;
  if p_min = 'member' and r not in ('owner','manager','member') then raise exception 'E_FORBIDDEN: member required'; end if;
end $$;

-- -----------------------------------------------------------------------------
-- Account slots (PRD §6)
-- -----------------------------------------------------------------------------
-- A sender occupies an account while it holds a live connection: not deleted, not disabled, not disconnected, and bound to a
-- connector account. A row that is still signing in (no account yet) is covered by its reservation instead. Website chat
-- inboxes are synthetic senders and never count.
create or replace function outreach__occupies(s outreach_senders) returns boolean language sql stable as $$
  select s.deleted_at is null and s.provider::text <> 'WEBCHAT' and s.status::text not in ('disabled','disconnected') and s.unipile_account_id is not null
$$;

-- how many accounts the workspace may have connected; null = no limit
create or replace function outreach__slot_limit(w outreach_workspaces) returns int language sql stable as $$
  select case when not outreach_billing_enforced() then null
              when w.plan = 'trial' then w.trial_account_limit
              when w.plan in ('launch','scale','enterprise','suspended') then w.accounts_billed       -- null on a comp workspace = no limit
              else 0 end
$$;

create or replace function outreach__slots(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; lim int; used int; reserved int; over int;
begin
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  lim := outreach__slot_limit(w);
  select count(*), count(*) filter (where s.status = 'paused' and s.status_reason = 'over_plan_limit') into used, over
    from outreach_senders s where s.workspace_id = p_ws and outreach__occupies(s);
  select count(*) into reserved from outreach_slot_reservations r where r.workspace_id = p_ws and r.released_at is null and r.expires_at > now();
  return jsonb_build_object('enforced', outreach_billing_enforced(), 'plan', w.plan, 'trial', w.plan = 'trial',
    'billed', lim, 'requested', w.accounts_requested, 'used', used, 'reserved', reserved, 'over_limit', over,
    'available', case when lim is null then null else greatest(lim - used - reserved, 0) end);
end $$;

create or replace function outreach_slots(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() and not exists (select 1 from outreach_members m where m.workspace_id = p_ws and m.user_id = auth.uid() and m.role <> 'client_viewer') then
    raise exception 'E_FORBIDDEN';
  end if;
  return outreach__slots(p_ws);
end $$;

create or replace function outreach__slot_lock(p_ws uuid) returns void language sql as $$
  select pg_advisory_xact_lock(hashtextextended('outreach_slots:' || p_ws::text, 0))
$$;

create or replace function outreach__account_limit_message(w outreach_workspaces, lim int) returns text language sql stable as $$
  select case when w.plan = 'trial' then format('Your trial includes %s account%s. Subscribe to add more.', lim, case when lim = 1 then '' else 's' end)
              when w.plan in ('trial_expired','cancelled') then 'Subscribe to connect an account.'
              else format('All %s account%s on your plan are in use. Add an account to connect another.', lim, case when lim = 1 then '' else 's' end) end
$$;

-- Hold one account for a sign-in link. Returns the reservation id, or null when nothing needs holding (billing not enforced,
-- no limit, or the sender already occupies an account). Raises E_ACCOUNT_LIMIT when none is free.
create or replace function outreach_slot_reserve(p_ws uuid, p_purpose text, p_sender uuid default null, p_minutes int default 15, p_by uuid default null)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; lim int; s jsonb; rid uuid; sn outreach_senders%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__slot_lock(p_ws);
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if outreach_billing_enforced() and w.plan in ('suspended','cancelled','trial_expired') then
    raise exception 'E_PLAN_SUSPENDED: %', outreach__plan_inactive_message(w.plan);
  end if;
  update outreach_slot_reservations set released_at = now(), release_reason = 'expired' where workspace_id = p_ws and released_at is null and expires_at <= now();
  if p_sender is not null then
    update outreach_slot_reservations set released_at = now(), release_reason = 'replaced' where sender_id = p_sender and released_at is null;
    select * into sn from outreach_senders where id = p_sender;
    if found and outreach__occupies(sn) then return null; end if;     -- re-login of a connected account: it already has its slot
  end if;
  lim := outreach__slot_limit(w);
  if lim is null then return null; end if;
  s := outreach__slots(p_ws);
  if (s->>'available')::int < 1 then raise exception 'E_ACCOUNT_LIMIT: %', outreach__account_limit_message(w, lim); end if;
  insert into outreach_slot_reservations(workspace_id, sender_id, purpose, expires_at, created_by)
  values (p_ws, p_sender, p_purpose, now() + make_interval(mins => greatest(coalesce(p_minutes, 15), 1)), p_by) returning id into rid;
  return rid;
end $$;

create or replace function outreach_slot_release(p_id uuid, p_reason text default 'manual') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_slot_reservations set released_at = now(), release_reason = coalesce(p_reason, 'manual') where id = p_id and released_at is null;
end $$;

-- release whatever a sender still holds (sign-in failed, row removed)
create or replace function outreach_slot_release_sender(p_sender uuid, p_reason text default 'failed') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_slot_reservations set released_at = now(), release_reason = coalesce(p_reason, 'failed') where sender_id = p_sender and released_at is null;
end $$;

-- The guard: no code path can push connected accounts above the limit (PRD §6.2). Also keeps the billing timestamps on the
-- sender and writes the slot ledger. Cheap unless the row starts or stops occupying an account.
create or replace function outreach_trg_senders_slot_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare occ_new boolean := outreach__occupies(new); occ_old boolean := false; w outreach_workspaces%rowtype; lim int; used int; reserved int; own int;
begin
  if tg_op = 'UPDATE' then
    occ_old := outreach__occupies(old);
    -- since when the sender is paused for a billing reason (the 14-day disconnect counts from here)
    if new.status = 'paused' and new.status_reason in ('billing_suspended','billing_cancelled','over_plan_limit') then
      -- moving from one billing reason to another keeps the first date
      if old.status <> 'paused' or coalesce(old.status_reason, '') not in ('billing_suspended','billing_cancelled','over_plan_limit') or new.billing_paused_at is null then new.billing_paused_at := now(); end if;
    elsif new.billing_paused_at is not null then
      new.billing_paused_at := null;
    end if;
    if new.status = 'disconnected' and old.status <> 'disconnected' then new.disconnected_at := coalesce(new.disconnected_at, now()); end if;
    if new.status <> 'disconnected' and old.status = 'disconnected' then new.disconnected_at := null; end if;
    if new.status <> 'paused' or new.status_reason is distinct from 'over_plan_limit' then new.plan_pause_prev := null; end if;
  end if;

  if occ_new and not occ_old then
    if outreach_billing_enforced() then
      perform outreach__slot_lock(new.workspace_id);
      select * into w from outreach_workspaces where id = new.workspace_id;
      if w.plan in ('suspended','cancelled','trial_expired') then
        raise exception 'E_PLAN_SUSPENDED: %', outreach__plan_inactive_message(w.plan);
      end if;
      lim := outreach__slot_limit(w);
      if lim is not null then
        -- the reservation made for this sender's sign-in link is used up here
        with done as (update outreach_slot_reservations set released_at = now(), release_reason = 'completed'
                       where sender_id = new.id and released_at is null and expires_at > now() returning 1)
        select count(*) into own from done;
        select count(*) into used from outreach_senders s where s.workspace_id = new.workspace_id and s.id <> new.id and outreach__occupies(s);
        select count(*) into reserved from outreach_slot_reservations r where r.workspace_id = new.workspace_id and r.released_at is null and r.expires_at > now();
        if (own > 0 and used + 1 > lim) or (own = 0 and used + reserved + 1 > lim) then
          raise exception 'E_ACCOUNT_LIMIT: %', outreach__account_limit_message(w, lim);
        end if;
      end if;
    end if;
    insert into outreach_slot_events(workspace_id, sender_id, kind, reason) values (new.workspace_id, new.id, 'taken', case when tg_op = 'INSERT' then 'connected' when old.status::text in ('disabled','disconnected') then 'reconnected' else 'connected' end);
  elsif occ_old and not occ_new then
    insert into outreach_slot_events(workspace_id, sender_id, kind, reason)
    values (new.workspace_id, new.id, 'freed', case when new.deleted_at is not null then 'deleted' when new.status = 'disconnected' then coalesce(new.status_reason, 'disconnected') when new.status = 'disabled' then 'disabled' else 'released' end);
  end if;
  return new;
end $$;

drop trigger if exists outreach_senders_slot_guard on outreach_senders;
create trigger outreach_senders_slot_guard before insert or update on outreach_senders for each row execute function outreach_trg_senders_slot_guard();

-- An account was freed (disabled, disconnected, deleted): accounts paused for the plan limit come back, in the order they
-- were paused, while there is room. No role check: only the trigger below calls it.
create or replace function outreach__resume_over_limit(p_ws uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; lim int; active int; s record; n int := 0;
begin
  select * into w from outreach_workspaces where id = p_ws;
  if not found or w.plan in ('suspended','cancelled','trial_expired') then return 0; end if;
  lim := outreach__slot_limit(w);
  select count(*) into active from outreach_senders x where x.workspace_id = p_ws and outreach__occupies(x) and not (x.status = 'paused' and x.status_reason = 'over_plan_limit');
  for s in select x.id, x.plan_pause_prev from outreach_senders x
            where x.workspace_id = p_ws and x.deleted_at is null and x.status = 'paused' and x.status_reason = 'over_plan_limit' and x.unipile_account_id is not null
            order by x.billing_paused_at nulls last, x.created_at loop
    exit when lim is not null and active >= lim;
    update outreach_senders set status = coalesce(nullif(s.plan_pause_prev->>'status', ''), 'ok')::outreach_sender_status_t, status_reason = s.plan_pause_prev->>'status_reason', plan_pause_prev = null where id = s.id;
    insert into outreach_sender_events(sender_id, kind, data) values (s.id, 'plan_limit', jsonb_build_object('action', 'resumed', 'limit', lim, 'because', 'account_freed'));
    active := active + 1; n := n + 1;
  end loop;
  return n;
end $$;

create or replace function outreach_trg_senders_slot_freed() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if outreach__occupies(old) and not outreach__occupies(new)
     and exists (select 1 from outreach_senders x where x.workspace_id = new.workspace_id and x.status = 'paused' and x.status_reason = 'over_plan_limit' and x.deleted_at is null) then
    perform outreach__resume_over_limit(new.workspace_id);
  end if;
  return null;
end $$;
drop trigger if exists outreach_senders_slot_freed on outreach_senders;
create trigger outreach_senders_slot_freed after update on outreach_senders for each row execute function outreach_trg_senders_slot_freed();

-- the sender status trigger: a disconnect is a disconnect date, and a reconnect from 'disconnected' gets the same quiet
-- period and failed-lead requeue as a reconnect from 'credentials'
do $$
declare def text := replace(pg_get_functiondef('public.outreach_trg_sender_status()'::regprocedure), chr(13), '');
        old_s text := $q$    elsif new.status = 'disabled' then$q$;
        new_s text := $q$    elsif new.status = 'disconnected' then
      new.last_disconnect_at := now();
    elsif new.status = 'disabled' then$q$;
begin
  if position('''disconnected''' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_trg_sender_status: disabled branch not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

do $$
declare def text := replace(pg_get_functiondef('public.outreach_trg_sender_status()'::regprocedure), chr(13), '');
        old_s text := $q$if old.status in ('credentials','error') then
        perform outreach_emit_event(new.workspace_id, 'sender.reconnected'$q$;
        new_s text := $q$if old.status::text in ('credentials','error','disconnected') then
        perform outreach_emit_event(new.workspace_id, 'sender.reconnected'$q$;
begin
  if position($q$'credentials','error','disconnected'$q$ in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_trg_sender_status: reconnected branch not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

do $$
declare def text := replace(pg_get_functiondef('public.outreach_trg_sender_quiet_period()'::regprocedure), chr(13), '');
        old_s text := $q$old.status in ('connecting','credentials','error')$q$;
        new_s text := $q$old.status::text in ('connecting','credentials','error','disconnected')$q$;
begin
  if position('''disconnected''' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_trg_sender_quiet_period: status list not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

do $$
declare def text := replace(pg_get_functiondef('public.outreach_trg_sender_reconnected()'::regprocedure), chr(13), '');
        old_s text := $q$old.status in ('credentials','error')$q$;
        new_s text := $q$old.status::text in ('credentials','error','disconnected')$q$;
begin
  if position('''disconnected''' in def) > 0 then return; end if;
  if position(old_s in def) = 0 then raise exception 'outreach_trg_sender_reconnected: status list not found, patch not applied'; end if;
  execute replace(def, old_s, new_s);
end $$;

-- -----------------------------------------------------------------------------
-- Disconnect (PRD §12.1): the connector account goes, the sender and everything attached to it stays.
-- -----------------------------------------------------------------------------
-- Database half. The connector-side delete is queued in outreach_account_deletions; the caller (edge function) tries it at
-- once and the hourly billing job retries with backoff. Enrolments keep their status and wait for the sender, like on a
-- signed-out sender; queued actions stay queued.
create or replace function outreach_disconnect_sender(p_sender uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; acct text; n_enr int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_reason not in ('trial_expired','billing_suspended','billing_cancelled','over_plan_limit','user_disconnected') then
    raise exception 'E_PAYLOAD_INVALID: unknown disconnect reason %', p_reason;
  end if;
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.provider::text = 'WEBCHAT' then return jsonb_build_object('sender_id', p_sender, 'skipped', 'webchat'); end if;
  if s.status::text = 'disconnected' or s.deleted_at is not null then return jsonb_build_object('sender_id', p_sender, 'already', true, 'account_id', null); end if;
  acct := s.unipile_account_id;
  update outreach_senders set status = 'disconnected', status_reason = p_reason, previous_unipile_account_id = coalesce(acct, previous_unipile_account_id),
         unipile_account_id = null, disconnected_at = now(), paused_until = null, reconnect_attempts = 0, reconnect_notified_at = null, reconnect_reminders = 0
   where id = p_sender;
  if acct is not null then
    insert into outreach_account_deletions(account_id, sender_id, workspace_id, reason) values (acct, p_sender, s.workspace_id, p_reason)
    on conflict (account_id) do nothing;
  end if;
  update outreach_slot_reservations set released_at = now(), release_reason = 'failed' where sender_id = p_sender and released_at is null;
  -- stored session cookies are only useful to an account that still exists; keep them for cookie / browser sign-in senders
  if s.auth_method::text not in ('cookie','browser') then delete from outreach_sender_secrets where sender_id = p_sender; end if;
  select count(*) into n_enr from outreach_enrollments e where e.sender_id = p_sender and e.status in ('active','waiting_connection','waiting_delay','waiting_task');
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'disconnected', jsonb_build_object('reason', p_reason, 'account_id', acct, 'waiting_enrollments', n_enr));
  perform outreach_audit(s.workspace_id, 'sender.disconnected', 'sender', p_sender::text, jsonb_build_object('reason', p_reason, 'waiting_enrollments', n_enr), 'system');
  perform outreach_emit_event(s.workspace_id, 'sender.disconnected', jsonb_build_object('id', p_sender, 'status', 'disconnected', 'reason', p_reason));
  return jsonb_build_object('sender_id', p_sender, 'account_id', acct, 'waiting_enrollments', n_enr);
end $$;

-- connector accounts to delete now (the caller deletes and reports back)
create or replace function outreach_account_deletions_due(p_limit int default 25)
returns table(account_id text, sender_id uuid, workspace_id uuid, reason text, attempts int, created_at timestamptz)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  select d.account_id, d.sender_id, d.workspace_id, d.reason, d.attempts, d.created_at from outreach_account_deletions d
   where d.done_at is null and d.next_attempt_at <= now()
     -- an account that a live sender uses again (reconnect onto the same id never happens, but be safe) is not deleted
     and not exists (select 1 from outreach_senders s where s.unipile_account_id = d.account_id)
   order by d.next_attempt_at limit greatest(p_limit, 1);
end $$;

-- ok: deleted (or already gone). Otherwise back off: 5 min, 15 min, 1 h, 3 h, then every 6 h; alert once after 24 h.
create or replace function outreach_account_deletion_result(p_account text, p_ok boolean, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare d outreach_account_deletions%rowtype; wait interval; alert boolean := false;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into d from outreach_account_deletions where account_id = p_account for update;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_ok then
    update outreach_account_deletions set done_at = now(), attempts = attempts + 1, last_error = null where account_id = p_account;
    return jsonb_build_object('ok', true, 'done', true);
  end if;
  wait := case d.attempts when 0 then interval '5 minutes' when 1 then interval '15 minutes' when 2 then interval '1 hour' when 3 then interval '3 hours' else interval '6 hours' end;
  alert := d.alerted_at is null and d.created_at < now() - interval '24 hours';
  update outreach_account_deletions set attempts = attempts + 1, last_error = left(coalesce(p_error, 'unknown'), 500), next_attempt_at = now() + wait,
         alerted_at = case when alert then now() else alerted_at end where account_id = p_account;
  if alert then
    perform outreach_audit(d.workspace_id, 'billing.account_delete_stuck', 'sender', d.sender_id::text, jsonb_build_object('account_id', p_account, 'attempts', d.attempts + 1, 'error', p_error), 'system');
  end if;
  return jsonb_build_object('ok', true, 'done', false, 'alert', alert, 'sender_id', d.sender_id, 'workspace_id', d.workspace_id);
end $$;

-- -----------------------------------------------------------------------------
-- Over the limit (PRD §6.4)
-- -----------------------------------------------------------------------------
-- Who keeps an account when only p_limit may stay active, best first:
--   1. the customer's own choice (p_keep, in the order given)
--   2. accounts that are active now before accounts already paused for the plan (those return in the order they were paused)
--   3. working accounts before accounts that need a sign-in anyway
--   4. the first account of the workspace owner
--   5. most activity in the last 14 days, then oldest
create or replace function outreach__account_ranking(p_ws uuid, p_keep uuid[] default null)
returns table(sender_id uuid, rnk int, status text, status_reason text, display_name text, provider text, activity_14d int, over_limit boolean, working boolean)
language sql stable security definer set search_path = public, extensions as $$
  with owner_first as (
    select s.id from outreach_senders s
     where s.workspace_id = p_ws and outreach__occupies(s)
       and s.owner_user_id in (select m.user_id from outreach_members m where m.workspace_id = p_ws and m.role = 'owner')
     order by coalesce(s.connected_at, s.created_at), s.created_at limit 1
  ), base as (
    select s.id, s.status::text st, s.status_reason sr, s.display_name dn, s.provider::text pv, s.billing_paused_at, s.created_at,
           (s.status = 'paused' and s.status_reason = 'over_plan_limit') as over_limit,
           (s.status::text in ('ok','paused')) as working,
           (select count(*)::int from outreach_actions a where a.sender_id = s.id and a.status = 'sent' and a.executed_at > now() - interval '14 days') as act
      from outreach_senders s where s.workspace_id = p_ws and outreach__occupies(s)
  )
  select b.id, (row_number() over (order by
           coalesce(array_position(p_keep, b.id), 2147483647),
           b.over_limit, not b.working, (b.id not in (select id from owner_first)),
           case when b.over_limit then b.billing_paused_at end nulls last,
           b.act desc, b.created_at))::int,
         b.st, b.sr, b.dn, b.pv, b.act, b.over_limit, b.working
    from base b
$$;

-- what a lower limit would do, for the change screen: the accounts that would be paused (or disconnected when they need a
-- sign-in anyway)
create or replace function outreach_senders_to_pause(p_ws uuid, p_limit int, p_keep uuid[] default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() and outreach_role_in(p_ws) is distinct from 'owner'::outreach_role_t then raise exception 'E_FORBIDDEN: owner required'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('sender_id', r.sender_id, 'name', r.display_name, 'provider', r.provider, 'status', r.status,
                    'activity_14d', r.activity_14d, 'keep', r.rnk <= p_limit, 'action', case when r.rnk <= p_limit then 'keep' when r.working then 'pause' else 'disconnect' end) order by r.rnk), '[]'::jsonb)
            from outreach__account_ranking(p_ws, p_keep) r);
end $$;

-- Bring the workspace back inside its limit, or let paused accounts back when the limit grew. Returns what it did.
create or replace function outreach_enforce_account_limit(p_ws uuid, p_keep uuid[] default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; lim int; r record; paused int := 0; resumed int := 0; dropped int := 0; prev jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__slot_lock(p_ws);
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  lim := outreach__slot_limit(w);
  -- a suspended / cancelled workspace has every sender paused for billing already; limits are settled when it comes back
  if w.plan in ('suspended','cancelled','trial_expired') then return jsonb_build_object('limit', lim, 'skipped', w.plan); end if;
  for r in select * from outreach__account_ranking(p_ws, p_keep) order by rnk loop
    if lim is null or r.rnk <= lim then
      if r.over_limit then
        select plan_pause_prev into prev from outreach_senders where id = r.sender_id;
        update outreach_senders set status = coalesce(nullif(prev->>'status', ''), 'ok')::outreach_sender_status_t, status_reason = prev->>'status_reason', plan_pause_prev = null
         where id = r.sender_id;
        insert into outreach_sender_events(sender_id, kind, data) values (r.sender_id, 'plan_limit', jsonb_build_object('action', 'resumed', 'limit', lim));
        resumed := resumed + 1;
      end if;
    elsif r.over_limit then
      null;                                            -- already paused for the plan
    elsif r.working then
      update outreach_senders set plan_pause_prev = jsonb_build_object('status', r.status, 'status_reason', r.status_reason), status = 'paused', status_reason = 'over_plan_limit'
       where id = r.sender_id;
      insert into outreach_sender_events(sender_id, kind, data) values (r.sender_id, 'plan_limit', jsonb_build_object('action', 'paused', 'limit', lim));
      paused := paused + 1;
    else
      -- signed out / errored: it needs a sign-in either way, so it gives its account back now
      perform outreach_disconnect_sender(r.sender_id, 'over_plan_limit');
      dropped := dropped + 1;
    end if;
  end loop;
  if paused + resumed + dropped > 0 then
    perform outreach_audit(p_ws, 'billing.account_limit_enforced', 'workspace', p_ws::text, jsonb_build_object('limit', lim, 'paused', paused, 'resumed', resumed, 'disconnected', dropped), 'system');
    perform outreach_emit_event(p_ws, 'workspace.account_limit', jsonb_build_object('id', p_ws, 'limit', lim, 'paused', paused, 'resumed', resumed, 'disconnected', dropped));
  end if;
  return jsonb_build_object('limit', lim, 'paused', paused, 'resumed', resumed, 'disconnected', dropped);
end $$;

-- -----------------------------------------------------------------------------
-- What a plan change switches off and back on (PRD §7.3). Most features are gates read live through
-- outreach_has_feature(); only the few with stored state are touched here. Nothing is deleted.
-- -----------------------------------------------------------------------------
alter table outreach_webchat_inboxes add column if not exists plan_paused_at timestamptz;

create or replace function outreach_apply_plan_features(p_ws uuid, p_old_plan text, p_new_plan text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare had boolean; has boolean; n_auto int := 0; n_demoted int := 0; n_restored int := 0; n_inbox_off int := 0; n_inbox_on int := 0; lim int; q record;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if not outreach_billing_enforced() then return jsonb_build_object('skipped', 'billing_not_enforced'); end if;

  -- AI auto-reply: sequences on Auto go to Draft and scheduled AI replies become drafts; an upgrade puts Auto back
  has := coalesce((select enabled from outreach_plan_features where plan = p_new_plan and feature = 'ai_auto_reply'), true);
  if not has then
    for q in select sequence_id from outreach_sequence_reply_settings where workspace_id = p_ws and mode = 'autopilot' loop
      update outreach_sequence_reply_settings set mode = 'draft', downgraded_at = now(), downgrade_reason = 'plan' where sequence_id = q.sequence_id;
      n_demoted := n_demoted + coalesce(outreach_ai_reply_demote_scheduled(q.sequence_id, 'plan_required'), 0);
      n_auto := n_auto + 1;
    end loop;
  else
    update outreach_sequence_reply_settings set mode = 'autopilot', downgraded_at = null, downgrade_reason = null, breaker_reset_at = now()
     where workspace_id = p_ws and mode = 'draft' and downgrade_reason = 'plan';
    get diagnostics n_restored = row_count;
  end if;

  -- website chat inboxes over the limit: the newest extra ones go inactive, and come back when the limit allows
  lim := (select limit_value from outreach_plan_features where plan = p_new_plan and feature = 'webchat_inboxes');
  update outreach_webchat_inboxes i set is_active = true, plan_paused_at = null
   where i.workspace_id = p_ws and i.plan_paused_at is not null and i.deleted_at is null
     and (lim is null or (select count(*) from outreach_webchat_inboxes x where x.workspace_id = p_ws and x.deleted_at is null and x.created_at <= i.created_at) <= lim);
  get diagnostics n_inbox_on = row_count;
  if lim is not null then
    update outreach_webchat_inboxes i set is_active = false, plan_paused_at = now()
     where i.workspace_id = p_ws and i.deleted_at is null and i.plan_paused_at is null and i.is_active
       and (select count(*) from outreach_webchat_inboxes x where x.workspace_id = p_ws and x.deleted_at is null and x.created_at <= i.created_at) > lim;
    get diagnostics n_inbox_off = row_count;
  end if;

  perform outreach_audit(p_ws, 'billing.plan_features_applied', 'workspace', p_ws::text,
    jsonb_build_object('from', p_old_plan, 'to', p_new_plan, 'auto_to_draft', n_auto, 'ai_replies_to_draft', n_demoted, 'auto_restored', n_restored, 'inboxes_off', n_inbox_off, 'inboxes_on', n_inbox_on), 'system');
  return jsonb_build_object('auto_to_draft', n_auto, 'ai_replies_to_draft', n_demoted, 'auto_restored', n_restored, 'inboxes_off', n_inbox_off, 'inboxes_on', n_inbox_on);
end $$;

-- The list the change screen shows before a downgrade is confirmed: each thing that switches off, with a count.
create or replace function outreach_downgrade_effects(p_ws uuid, p_to_plan text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare cur text := outreach_feature_plan(p_ws); out jsonb := '[]'; n int; lim int;
  lost text[] := array(select a.feature from outreach_plan_features a join outreach_plan_features b on b.feature = a.feature and b.plan = p_to_plan
                        where a.plan = cur and a.enabled and not b.enabled);
begin
  if not outreach_is_service() and outreach_role_in(p_ws) is distinct from 'owner'::outreach_role_t then raise exception 'E_FORBIDDEN: owner required'; end if;
  if p_to_plan not in ('launch','scale','enterprise') then raise exception 'E_PAYLOAD_INVALID: plan'; end if;
  if 'ai_auto_reply' = any(lost) then
    select count(*) into n from outreach_sequence_reply_settings where workspace_id = p_ws and mode = 'autopilot';
    out := out || jsonb_build_object('feature', 'ai_auto_reply', 'count', n, 'text', case when n = 0 then 'AI replies can no longer send by itself (Auto mode)' else format('%s sequence%s on Auto will switch to Draft', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'clients' = any(lost) then
    select count(*) into n from outreach_clients where workspace_id = p_ws;
    out := out || jsonb_build_object('feature', 'clients', 'count', n, 'text', case when n = 0 then 'Clients can no longer be created' else format('%s client%s stay in your data, but new clients can''t be created', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'client_viewer' = any(lost) then
    select count(*) into n from outreach_members where workspace_id = p_ws and role = 'client_viewer';
    out := out || jsonb_build_object('feature', 'client_viewer', 'count', n, 'text', case when n = 0 then 'Client viewers can no longer be invited' else format('%s client viewer%s will lose access', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'client_reports' = any(lost) then
    select count(*) into n from outreach_report_schedules where workspace_id = p_ws and kind = 'client_report' and active;
    out := out || jsonb_build_object('feature', 'client_reports', 'count', n, 'text', case when n = 0 then 'Per-client reports and exports will be hidden' else format('%s scheduled client report%s will stop', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'tracking_domains' = any(lost) then
    select count(*) into n from outreach_tracking_domains where workspace_id = p_ws;
    out := out || jsonb_build_object('feature', 'tracking_domains', 'count', n, 'text', case when n = 0 then 'Custom tracking domains can no longer be added' else format('%s tracking domain%s will stop being used', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'white_label' = any(lost) then
    select count(*) into n from outreach_workspace_domains where workspace_id = p_ws;
    out := out || jsonb_build_object('feature', 'white_label', 'count', n, 'text', 'Your own branding goes back to the default' || case when n > 0 then format('; %s custom domain%s will redirect to the default one', n, case when n = 1 then '' else 's' end) else '' end);
  end if;
  if 'webhooks' = any(lost) then
    select count(*) into n from outreach_outbound_webhooks where workspace_id = p_ws and active;
    out := out || jsonb_build_object('feature', 'webhooks', 'count', n, 'text', case when n = 0 then 'Webhooks can no longer be created' else format('%s webhook%s will stop receiving events', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'public_api' = any(lost) then
    select count(*) into n from outreach_api_keys where workspace_id = p_ws and revoked_at is null;
    out := out || jsonb_build_object('feature', 'public_api', 'count', n, 'text', case when n = 0 then 'API keys can no longer be created' else format('%s API key%s will stop working (kept, not deleted)', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'crm_sync' = any(lost) then
    select count(*) into n from outreach_integrations where workspace_id = p_ws and status in ('active','error');
    out := out || jsonb_build_object('feature', 'crm_sync', 'count', n, 'text', case when n = 0 then 'CRM sync can no longer be connected' else format('%s CRM connection%s will pause', n, case when n = 1 then '' else 's' end) end);
  end if;
  if 'priority_processing' = any(lost) then
    out := out || jsonb_build_object('feature', 'priority_processing', 'count', 0, 'text', 'Priority processing goes back to the normal queue');
  end if;
  -- counted limits
  lim := (select limit_value from outreach_plan_features where plan = p_to_plan and feature = 'webchat_inboxes');
  if lim is not null then
    select count(*) into n from outreach_webchat_inboxes where workspace_id = p_ws and deleted_at is null and is_active;
    if n > lim then out := out || jsonb_build_object('feature', 'webchat_inboxes', 'count', n - lim, 'text', format('%s website chat inbox%s will go inactive (the newest first)', n - lim, case when n - lim = 1 then '' else 'es' end)); end if;
  end if;
  if coalesce((select limit_value from outreach_plan_features where plan = p_to_plan and feature = 'ai_limits'), 0)
     < coalesce((select limit_value from outreach_plan_features where plan = cur and feature = 'ai_limits'), 0) then
    out := out || jsonb_build_object('feature', 'ai_limits', 'count', 0, 'text', 'AI limits go back to the standard allowance');
  end if;
  return out;
end $$;

-- -----------------------------------------------------------------------------
-- Suspend, cancel, resume
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_suspend(p_ws uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if w.plan = 'suspended' then return 0; end if;
  update outreach_workspaces set plan = 'suspended', suspended_at = now(),
         plan_before_suspension = case when w.plan in ('trial','launch','scale','enterprise') then w.plan else plan_before_suspension end
   where id = p_ws;
  update outreach_senders set status = 'paused', status_reason = 'billing_suspended' where workspace_id = p_ws and status = 'ok' and deleted_at is null and provider::text <> 'WEBCHAT';
  get diagnostics n = row_count;
  perform outreach_audit(p_ws, 'workspace.suspended', 'workspace', p_ws::text, jsonb_build_object('reason', p_reason, 'senders_paused', n), 'system');
  perform outreach_emit_event(p_ws, 'workspace.suspended', jsonb_build_object('id', p_ws, 'reason', p_reason, 'senders_paused', n));
  return n;
end $$;

-- the subscription has ended (PRD §4.7): read-only, senders paused, 90 days of data, early-supporter price gone
create or replace function outreach__billing_cancelled(p_ws uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; n int := 0; days int := outreach__billing_int('billing_cancel_data_days', 90);
begin
  select * into w from outreach_workspaces where id = p_ws for update;
  if w.plan = 'cancelled' then return 0; end if;
  update outreach_workspaces set plan = 'cancelled', cancelled_at = now(), stripe_status = 'canceled', cancel_at_period_end = false, past_due_since = null,
         scheduled_change = null, stripe_schedule_id = null, pending_payment = null, data_delete_after = now() + make_interval(days => days),
         plan_before_suspension = case when w.plan in ('launch','scale','enterprise') then w.plan else plan_before_suspension end,
         early_supporter_discount = 0, early_supporter_tier = null
   where id = p_ws;
  update outreach_early_supporters set forfeited_at = coalesce(forfeited_at, now()) where workspace_id = p_ws;
  update outreach_senders set status = 'paused', status_reason = 'billing_cancelled'
   where workspace_id = p_ws and deleted_at is null and provider::text <> 'WEBCHAT'
     and (status = 'ok' or (status = 'paused' and status_reason in ('billing_suspended','over_plan_limit')));
  get diagnostics n = row_count;
  perform outreach_audit(p_ws, 'workspace.cancelled', 'workspace', p_ws::text, jsonb_build_object('senders_paused', n, 'data_delete_after', now() + make_interval(days => days)), 'system');
  perform outreach_emit_event(p_ws, 'workspace.cancelled', jsonb_build_object('id', p_ws, 'senders_paused', n));
  return n;
end $$;

-- Payment recovered / subscription active again: the plan comes back and the senders billing paused resume on their own.
-- Not resumed: accounts paused for the plan limit (the limit decides), and accounts already disconnected (they need a sign-in).
create or replace function outreach_resume_after_billing(p_ws uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_workspaces
     set plan = case when plan = 'suspended' then coalesce(plan_before_suspension, 'launch') else plan end,
         plan_before_suspension = case when plan = 'suspended' then null else plan_before_suspension end,
         past_due_since = null, suspended_at = null
   where id = p_ws;
  update outreach_senders set status = 'ok', status_reason = null
   where workspace_id = p_ws and status = 'paused' and status_reason in ('billing_suspended','billing_cancelled','trial_expired') and deleted_at is null;
  get diagnostics n = row_count;
  perform outreach_enforce_account_limit(p_ws, null);
  perform outreach_audit(p_ws, 'workspace.billing_recovered', 'workspace', p_ws::text, jsonb_build_object('senders_resumed', n), 'system');
  perform outreach_emit_event(p_ws, 'workspace.billing_recovered', jsonb_build_object('id', p_ws, 'senders_resumed', n));
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- The workspace follows the live Stripe subscription (PRD §10.2). The webhook reads the subscription from Stripe and
-- passes what it derived; this function is the only writer of the billing columns for a Stripe-billed workspace.
--   p: {subscription_id, customer_id, status, plan, billing_period, accounts_billed, accounts_requested, current_period_start,
--       current_period_end, cancel_at_period_end, schedule_id, scheduled_change, price_version, custom_price_id, pending_payment}
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_apply_subscription(p_ws uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; st text := p->>'status'; sub text := p->>'subscription_id'; new_plan text; billed int; old_feat text; new_feat text;
        was_blocked boolean; keep uuid[]; res jsonb := '{}'; enf jsonb; n_res int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  -- events of a subscription the workspace has moved on from change nothing
  if w.stripe_subscription_id is not null and sub is not null and w.stripe_subscription_id <> sub
     and (st in ('canceled','incomplete','incomplete_expired') or coalesce(w.stripe_status, '') in ('active','trialing','past_due')) then
    return jsonb_build_object('ignored', 'other_subscription');
  end if;
  -- a checkout that was never paid
  if st in ('incomplete','incomplete_expired') then
    if w.stripe_subscription_id = sub and st = 'incomplete_expired' then update outreach_workspaces set stripe_status = st where id = p_ws; end if;
    return jsonb_build_object('ignored', st);
  end if;
  old_feat := outreach_feature_plan(p_ws);

  if st = 'canceled' then
    perform outreach__billing_cancelled(p_ws);
    update outreach_workspaces set stripe_subscription_id = coalesce(sub, stripe_subscription_id), stripe_customer_id = coalesce(p->>'customer_id', stripe_customer_id) where id = p_ws;
    return jsonb_build_object('plan', 'cancelled');
  end if;

  new_plan := case when p->>'plan' in ('launch','scale','enterprise') then p->>'plan'
                   when w.plan in ('launch','scale','enterprise') then w.plan
                   else coalesce(nullif(w.plan_before_suspension, 'trial'), 'launch') end;
  billed := greatest(coalesce((p->>'accounts_billed')::int, w.accounts_billed, 1), 1);
  was_blocked := w.plan in ('suspended','cancelled','trial_expired') or w.past_due_since is not null or coalesce(w.stripe_status, '') in ('past_due','unpaid');
  -- the customer's keep list of a scheduled decrease is used when that decrease lands
  if w.scheduled_change ? 'keep_sender_ids' and billed < coalesce(w.accounts_billed, billed) then
    keep := array(select (x)::uuid from jsonb_array_elements_text(w.scheduled_change->'keep_sender_ids') x);
  end if;

  update outreach_workspaces set
    stripe_subscription_id = coalesce(sub, stripe_subscription_id),
    stripe_customer_id = coalesce(p->>'customer_id', stripe_customer_id),
    stripe_status = st,
    billing_period = coalesce(p->>'billing_period', billing_period),
    accounts_billed = billed,
    accounts_requested = least(greatest(coalesce((p->>'accounts_requested')::int, case when w.accounts_billed = billed then w.accounts_requested end, billed), 1), billed),
    current_period_start = coalesce((p->>'current_period_start')::timestamptz, current_period_start),
    current_period_end = coalesce((p->>'current_period_end')::timestamptz, current_period_end),
    cancel_at_period_end = coalesce((p->>'cancel_at_period_end')::boolean, false),
    stripe_schedule_id = nullif(p->>'schedule_id', ''),
    scheduled_change = case when jsonb_typeof(p->'scheduled_change') = 'object' then p->'scheduled_change' else null end,
    pending_payment = case when jsonb_typeof(p->'pending_payment') = 'object' then p->'pending_payment' else null end,
    price_version = coalesce(nullif(p->>'price_version', ''), price_version),
    custom_price_id = case when p ? 'custom_price_id' then nullif(p->>'custom_price_id', '') else custom_price_id end,
    billing_comp = false
  where id = p_ws;

  if st in ('active','trialing') then
    if w.disputed_at is not null then
      -- an open card dispute keeps the workspace suspended whatever the subscription says (PRD §5.4)
      update outreach_workspaces set plan = 'suspended', plan_before_suspension = new_plan, past_due_since = null where id = p_ws;
      return jsonb_build_object('plan', 'suspended', 'reason', 'dispute_open');
    end if;
    update outreach_workspaces set plan = new_plan, past_due_since = null, suspended_at = null, plan_before_suspension = null,
           cancelled_at = null, data_delete_after = null where id = p_ws;
    if was_blocked or w.plan = 'trial' then
      update outreach_senders set status = 'ok', status_reason = null
       where workspace_id = p_ws and status = 'paused' and status_reason in ('billing_suspended','billing_cancelled','trial_expired') and deleted_at is null;
      get diagnostics n_res = row_count;
      res := jsonb_build_object('senders_resumed', n_res);
      if was_blocked then
        perform outreach_audit(p_ws, 'workspace.billing_recovered', 'workspace', p_ws::text, res, 'system');
        perform outreach_emit_event(p_ws, 'workspace.billing_recovered', jsonb_build_object('id', p_ws) || res);
      end if;
    end if;
    new_feat := outreach_feature_plan(p_ws);
    if new_feat is distinct from old_feat then res := res || jsonb_build_object('features', outreach_apply_plan_features(p_ws, old_feat, new_feat)); end if;
    enf := outreach_enforce_account_limit(p_ws, keep);
    res := res || jsonb_build_object('accounts', enf);
    if w.plan is distinct from new_plan or w.accounts_billed is distinct from billed or w.billing_period is distinct from (p->>'billing_period') then
      perform outreach_audit(p_ws, 'billing.subscription_changed', 'workspace', p_ws::text,
        jsonb_build_object('from', jsonb_build_object('plan', w.plan, 'accounts_billed', w.accounts_billed, 'billing_period', w.billing_period),
                           'to', jsonb_build_object('plan', new_plan, 'accounts_billed', billed, 'billing_period', p->>'billing_period')), 'system');
    end if;
    return res || jsonb_build_object('plan', new_plan, 'accounts_billed', billed);
  end if;

  -- past_due / unpaid / paused: the plan stays; the hourly job suspends on day 7
  update outreach_workspaces set past_due_since = coalesce(past_due_since, now()) where id = p_ws and st in ('past_due','unpaid');
  return jsonb_build_object('plan', w.plan, 'status', st);
end $$;

-- card dispute (PRD §5.4): opened → suspended at once; closed in our favour → resumes
create or replace function outreach_billing_dispute(p_ws uuid, p_open boolean, p_won boolean default null, p_dispute text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_open then
    update outreach_workspaces set disputed_at = coalesce(disputed_at, now()) where id = p_ws;
    n := outreach_billing_suspend(p_ws, 'dispute');
    perform outreach_audit(p_ws, 'billing.dispute_opened', 'workspace', p_ws::text, jsonb_build_object('dispute', p_dispute, 'senders_paused', n), 'system');
    return jsonb_build_object('suspended', true, 'senders_paused', n);
  end if;
  update outreach_workspaces set disputed_at = null where id = p_ws;
  perform outreach_audit(p_ws, 'billing.dispute_closed', 'workspace', p_ws::text, jsonb_build_object('dispute', p_dispute, 'won', p_won), 'system');
  if coalesce(p_won, false) and w.plan = 'suspended' and coalesce(w.stripe_status, 'active') in ('active','trialing') then
    n := outreach_resume_after_billing(p_ws);
    return jsonb_build_object('resumed', true, 'senders_resumed', n);
  end if;
  return jsonb_build_object('resumed', false);
end $$;

-- -----------------------------------------------------------------------------
-- The hourly job, database half (PRD §10.3): trial expiry → disconnect, past-due day 7 → suspend, 14-day billing pause →
-- disconnect, reconciliation, stale reservations and quotes. The connector deletes are queued for the edge function.
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_tick() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare enforced boolean := outreach_billing_enforced(); w record; s record; lim int; active int; r jsonb;
        expired uuid[] := '{}'; suspended uuid[] := '{}'; reconciled uuid[] := '{}'; n_disc int := 0; n_res int := 0; n_quotes int := 0;
        trial_days int := outreach__billing_int('billing_trial_data_days', 30); suspend_day int := outreach__billing_int('billing_past_due_suspend_day', 7);
        stale_days int := outreach__billing_int('billing_disconnect_paused_after_days', 14);
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;

  -- 1. a failed payment not fixed in 7 days suspends the workspace (runs whenever a workspace is past due: that only exists with Stripe)
  for w in select id from outreach_workspaces where deleted_at is null and stripe_status in ('past_due','unpaid') and past_due_since is not null
            and past_due_since < now() - make_interval(days => suspend_day) and plan not in ('suspended','cancelled') loop
    perform outreach_billing_suspend(w.id, 'past_due_' || suspend_day || 'd');
    suspended := suspended || w.id;
  end loop;

  if enforced then
    -- 2. a trial that ended without a subscription: the account is disconnected, the workspace becomes read-only for 30 days
    for w in select id, trial_ends_at from outreach_workspaces
              where deleted_at is null and plan = 'trial' and not billing_comp and trial_ends_at < now()
                and (stripe_subscription_id is null or coalesce(stripe_status, '') not in ('active','trialing','past_due','unpaid')) loop
      update outreach_workspaces set plan = 'trial_expired', plan_before_suspension = 'trial',
             data_delete_after = greatest(w.trial_ends_at, now() - interval '1 day') + make_interval(days => trial_days) where id = w.id;
      for s in select x.id from outreach_senders x where x.workspace_id = w.id and x.deleted_at is null and x.provider::text <> 'WEBCHAT' and x.status::text not in ('disabled','disconnected') and x.unipile_account_id is not null loop
        perform outreach_disconnect_sender(s.id, 'trial_expired');
        n_disc := n_disc + 1;
      end loop;
      update outreach_slot_reservations set released_at = now(), release_reason = 'expired' where workspace_id = w.id and released_at is null;
      perform outreach_audit(w.id, 'workspace.trial_expired', 'workspace', w.id::text, null, 'system');
      perform outreach_emit_event(w.id, 'workspace.trial_expired', jsonb_build_object('id', w.id));
      expired := expired || w.id;
    end loop;

    -- 3. accounts paused for billing for 14 days stop costing us: disconnected, reconnect later with a normal sign-in
    for s in select x.id, x.status_reason from outreach_senders x
              where x.deleted_at is null and x.status = 'paused' and x.status_reason in ('billing_suspended','billing_cancelled','over_plan_limit')
                and x.billing_paused_at < now() - make_interval(days => stale_days) and x.unipile_account_id is not null loop
      perform outreach_disconnect_sender(s.id, s.status_reason);
      n_disc := n_disc + 1;
    end loop;

    -- 4. reconciliation: more active accounts than the plan has, with no reason on record
    for w in select x.id from outreach_workspaces x where x.deleted_at is null and x.plan in ('trial','launch','scale','enterprise') loop
      select outreach__slot_limit(x) into lim from outreach_workspaces x where x.id = w.id;
      continue when lim is null;
      select count(*) into active from outreach_senders sn where sn.workspace_id = w.id and outreach__occupies(sn) and not (sn.status = 'paused' and sn.status_reason = 'over_plan_limit');
      if active > lim then
        r := outreach_enforce_account_limit(w.id, null);
        perform outreach_audit(w.id, 'billing.reconciled', 'workspace', w.id::text, jsonb_build_object('active', active, 'limit', lim) || r, 'system');
        reconciled := reconciled || w.id;
      end if;
    end loop;
  end if;

  -- 5. housekeeping
  update outreach_slot_reservations set released_at = now(), release_reason = 'expired' where released_at is null and expires_at <= now();
  get diagnostics n_res = row_count;
  delete from outreach_billing_changes where status = 'quoted' and created_at < now() - interval '1 day';
  get diagnostics n_quotes = row_count;
  delete from outreach_slot_reservations where released_at < now() - interval '30 days';

  return jsonb_build_object('enforced', enforced, 'trials_expired', to_jsonb(expired), 'suspended', to_jsonb(suspended), 'reconciled', to_jsonb(reconciled),
    'senders_disconnected', n_disc, 'reservations_expired', n_res, 'quotes_removed', n_quotes);
end $$;

-- one row per workspace per day: accounts connected (information only)
create or replace function outreach_billing_record_usage() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_billing_usage(workspace_id, day, active_senders, active_mailboxes, accounts, accounts_billed)
  select w.id, (now() at time zone 'utc')::date,
         count(s.id) filter (where s.provider::text = 'LINKEDIN'), count(s.id) filter (where s.provider::text in ('GMAIL','OUTLOOK','IMAP')),
         count(s.id), outreach__slot_limit(w)
    from outreach_workspaces w left join outreach_senders s on s.workspace_id = w.id and outreach__occupies(s)
   where w.deleted_at is null group by w.id
  on conflict (workspace_id, day) do update set active_senders = greatest(outreach_billing_usage.active_senders, excluded.active_senders),
     active_mailboxes = greatest(outreach_billing_usage.active_mailboxes, excluded.active_mailboxes),
     accounts = greatest(outreach_billing_usage.accounts, excluded.accounts), accounts_billed = excluded.accounts_billed;
  get diagnostics n = row_count;
  return n;
end $$;

-- -----------------------------------------------------------------------------
-- Emails the billing job owes (PRD §5): returned once each; the caller claims a notice before sending it.
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_notices_due()
returns table(workspace_id uuid, kind text, period_key text, data jsonb)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  with cand as (
    -- trial ending in 2 days / tomorrow (enforced only: a trial does not end otherwise)
    select w.id ws, case when w.trial_ends_at <= now() + interval '1 day' then 'trial_ends_tomorrow' else 'trial_ends_soon' end k, w.trial_ends_at::date::text pk,
           jsonb_build_object('trial_ends_at', w.trial_ends_at,
             'account', (select coalesce(s.display_name, s.owner_email::text) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s) order by s.created_at limit 1),
             'provider', (select s.provider::text from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s) order by s.created_at limit 1)) d
      from outreach_workspaces w
     where outreach_billing_enforced() and w.deleted_at is null and w.plan = 'trial' and not w.billing_comp and w.stripe_subscription_id is null
       and w.trial_ends_at > now() and w.trial_ends_at <= now() + interval '2 days'
    union all
    -- lapsed trial: on expiry, then 23, 7 and 1 day before the data goes (day 14, 30 and 36 of a 7-day trial with 30 days of data)
    select w.id, x.k, w.data_delete_after::date::text, jsonb_build_object('data_delete_after', w.data_delete_after, 'days_left', greatest(ceil(extract(epoch from w.data_delete_after - now()) / 86400)::int, 0))
      from outreach_workspaces w
      cross join lateral (select case when w.data_delete_after <= now() + interval '1 day' then 'trial_data_1d'
                                      when w.data_delete_after <= now() + interval '7 days' then 'trial_data_7d'
                                      when w.data_delete_after <= now() + interval '23 days' then 'trial_data_23d'
                                      else 'trial_expired' end k) x
     where outreach_billing_enforced() and w.deleted_at is null and w.plan = 'trial_expired' and w.data_delete_after is not null and w.data_delete_after > now()
    union all
    -- payment failed: reminder on day 3
    select w.id, 'past_due_reminder', w.past_due_since::date::text, jsonb_build_object('past_due_since', w.past_due_since)
      from outreach_workspaces w
     where w.deleted_at is null and w.stripe_status in ('past_due','unpaid') and w.plan <> 'suspended' and w.past_due_since is not null
       and w.past_due_since < now() - make_interval(days => outreach__billing_int('billing_past_due_reminder_day', 3))
    union all
    -- suspended for non-payment
    select w.id, 'suspended', coalesce(w.suspended_at, now())::date::text, jsonb_build_object('suspended_at', w.suspended_at)
      from outreach_workspaces w where w.deleted_at is null and w.plan = 'suspended' and w.stripe_status in ('past_due','unpaid') and w.suspended_at > now() - interval '3 days'
    union all
    -- cancelled: 30, 7 and 1 day before deletion
    select w.id, x.k, w.data_delete_after::date::text, jsonb_build_object('data_delete_after', w.data_delete_after, 'days_left', greatest(ceil(extract(epoch from w.data_delete_after - now()) / 86400)::int, 0))
      from outreach_workspaces w
      cross join lateral (select case when w.data_delete_after <= now() + interval '1 day' then 'cancel_data_1d'
                                      when w.data_delete_after <= now() + interval '7 days' then 'cancel_data_7d'
                                      when w.data_delete_after <= now() + interval '30 days' then 'cancel_data_30d' end k) x
     where w.deleted_at is null and w.plan = 'cancelled' and w.data_delete_after is not null and w.data_delete_after > now() and x.k is not null
  )
  select c.ws, c.k, c.pk, c.d from cand c
   where not exists (select 1 from outreach_billing_notices n where n.workspace_id = c.ws and n.kind = c.k and n.period_key = c.pk);
end $$;

-- true when the caller now owns this notice (send it); false when someone already sent it
create or replace function outreach_billing_notice_claim(p_ws uuid, p_kind text, p_period_key text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_billing_notices(workspace_id, kind, period_key) values (p_ws, p_kind, p_period_key) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- -----------------------------------------------------------------------------
-- Lapsed workspaces (PRD §5.1 day 37, §4.7 day 90)
-- -----------------------------------------------------------------------------
create or replace function outreach_workspaces_due_for_deletion()
returns table(workspace_id uuid, name text, plan text, data_delete_after timestamptz, owner_email text)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  select w.id, w.name, w.plan, w.data_delete_after,
         (select u.email::text from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1)
    from outreach_workspaces w
   where w.deleted_at is null and w.plan in ('trial_expired','cancelled') and not w.billing_comp
     and w.data_delete_after is not null and w.data_delete_after < now()
     and coalesce(w.stripe_status, 'canceled') not in ('active','trialing','past_due','unpaid');
end $$;

-- Deletes the workspace and everything in it (every table hangs off the workspace with ON DELETE CASCADE). The caller
-- empties the storage folders first. Refuses unless the workspace really is past its date and has no live subscription.
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
  -- whatever is still connected stops costing us
  insert into outreach_account_deletions(account_id, sender_id, workspace_id, reason)
  select s.unipile_account_id, null, null, 'workspace_deleted' from outreach_senders s where s.workspace_id = p_ws and s.unipile_account_id is not null
  on conflict (account_id) do nothing;
  get diagnostics n_accounts = row_count;
  update outreach_account_deletions set sender_id = null, workspace_id = null where workspace_id = p_ws;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (null, null, 'system', 'workspace.data_deleted', 'workspace', p_ws::text, jsonb_build_object('name', w.name, 'plan', w.plan, 'data_delete_after', w.data_delete_after, 'accounts_queued', n_accounts));
  delete from outreach_workspaces where id = p_ws;
  return jsonb_build_object('deleted', true, 'accounts_queued', n_accounts);
end $$;

-- -----------------------------------------------------------------------------
-- Early supporters and one trial per business (PRD §1.3, §14 #38)
-- -----------------------------------------------------------------------------
create or replace function outreach__free_mail_domain(p_domain text) returns boolean language sql immutable as $$
  select lower(coalesce(p_domain, '')) = any(array['gmail.com','googlemail.com','yahoo.com','yahoo.co.in','yahoo.co.uk','yahoo.in','ymail.com','rocketmail.com','outlook.com','outlook.in',
    'hotmail.com','hotmail.co.uk','live.com','live.in','msn.com','icloud.com','me.com','mac.com','aol.com','proton.me','protonmail.com','pm.me','gmx.com','gmx.de','gmx.net','mail.com',
    'zoho.com','zohomail.in','yandex.com','yandex.ru','qq.com','163.com','126.com','rediffmail.com','hey.com','fastmail.com','tutanota.com','tuta.io','duck.com'])
$$;

-- has this user, or their company email domain, had a trial before?
create or replace function outreach__trial_claimed(p_user uuid, p_except_ws uuid default null) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  with me as (select lower(split_part(u.email, '@', 2)) dom from auth.users u where u.id = p_user)
  select exists (select 1 from outreach_trial_claims c
                  where (c.workspace_id is distinct from p_except_ws or c.workspace_id is null)
                    and (c.user_id = p_user or (c.email_domain is not null and c.email_domain = (select dom from me) and not outreach__free_mail_domain((select dom from me)))))
$$;

-- next position in sign-up order; the tier comes from outreach_early_supporter_tiers. No row once every tier is full.
create or replace function outreach_assign_early_supporter(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare pos int; t record; start_at int := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('outreach_early_supporters', 0));
  if exists (select 1 from outreach_early_supporters where workspace_id = p_ws) then
    return (select jsonb_build_object('position', position, 'tier', tier, 'discount', discount) from outreach_early_supporters where workspace_id = p_ws);
  end if;
  select coalesce(max(position), 0) + 1 into pos from outreach_early_supporters;
  for t in select tier, spots, discount from outreach_early_supporter_tiers order by tier loop
    if pos > start_at and pos <= start_at + t.spots then
      insert into outreach_early_supporters(workspace_id, position, tier, discount) values (p_ws, pos, t.tier, t.discount);
      update outreach_workspaces set early_supporter_tier = t.tier, early_supporter_discount = t.discount where id = p_ws;
      return jsonb_build_object('position', pos, 'tier', t.tier, 'discount', t.discount);
    end if;
    start_at := start_at + t.spots;
  end loop;
  return null;
end $$;

-- A new workspace: the trial clock, and whether this business gets a trial at all.
create or replace function outreach_trg_workspace_billing_before() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.plan = 'trial' then
    new.trial_ends_at := now() + make_interval(days => outreach__billing_int('billing_trial_days', 7));
    new.trial_account_limit := outreach__billing_int('billing_trial_accounts', 1);
    -- a second workspace of the same person or company starts without a trial and must subscribe to connect
    if outreach_billing_enforced() and new.created_by is not null and outreach__trial_claimed(new.created_by) then
      new.plan := 'trial_expired'; new.plan_before_suspension := 'trial'; new.trial_ends_at := now();
    end if;
  end if;
  return new;
end $$;

create or replace function outreach_trg_workspace_billing_after() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare dom text; first_time boolean;
begin
  if new.created_by is null then return null; end if;
  first_time := not outreach__trial_claimed(new.created_by);
  select lower(split_part(u.email, '@', 2)) into dom from auth.users u where u.id = new.created_by;
  insert into outreach_trial_claims(user_id, email_domain, workspace_id) values (new.created_by, case when outreach__free_mail_domain(dom) then null else nullif(dom, '') end, new.id);
  -- the early-supporter place belongs to the business: its first workspace takes it
  if first_time then perform outreach_assign_early_supporter(new.id); end if;
  return null;
end $$;

drop trigger if exists outreach_workspace_billing_before on outreach_workspaces;
create trigger outreach_workspace_billing_before before insert on outreach_workspaces for each row execute function outreach_trg_workspace_billing_before();
drop trigger if exists outreach_workspace_billing_after on outreach_workspaces;
create trigger outreach_workspace_billing_after after insert on outreach_workspaces for each row execute function outreach_trg_workspace_billing_after();

-- existing workspaces: trial claims and early-supporter positions in sign-up order (PRD §13 step 5)
do $$
declare w record;
begin
  for w in select id, created_by from outreach_workspaces x where x.deleted_at is null and x.created_by is not null
              and not exists (select 1 from outreach_trial_claims c where c.workspace_id = x.id) order by x.created_at loop
    if not outreach__trial_claimed(w.created_by) and not exists (select 1 from outreach_early_supporters e where e.workspace_id = w.id) then
      perform outreach_assign_early_supporter(w.id);
    end if;
    insert into outreach_trial_claims(user_id, email_domain, workspace_id)
    select w.created_by, case when outreach__free_mail_domain(lower(split_part(u.email, '@', 2))) then null else nullif(lower(split_part(u.email, '@', 2)), '') end, w.id
      from auth.users u where u.id = w.created_by;
  end loop;
end $$;

-- website: how many early-supporter places are taken (PRD §10.6)
create or replace function outreach_early_supporters_public() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('claimed', (select count(*) from outreach_early_supporters),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object('tier', t.tier, 'spots', t.spots, 'discount', t.discount) order by t.tier), '[]'::jsonb) from outreach_early_supporter_tiers t))
$$;

-- website / app: the price book and feature matrix as stored (the same rows quotes are made from)
create or replace function outreach_pricing_public() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('version', outreach__billing_text('billing_price_version', 'v1'), 'currency', 'usd',
    'trial', jsonb_build_object('days', outreach__billing_int('billing_trial_days', 7), 'accounts', outreach__billing_int('billing_trial_accounts', 1)),
    'max_self_serve_accounts', outreach__billing_int('billing_max_self_serve_accounts', 100),
    'prices', (select coalesce(jsonb_agg(jsonb_build_object('plan', b.plan, 'period', b.billing_period, 'step_min', b.step_min, 'per_account_monthly', b.per_account_monthly, 'lookup_key', b.stripe_price_lookup_key)
                        order by outreach__plan_rank(b.plan), outreach__period_months(b.billing_period), b.step_min), '[]'::jsonb)
                 from outreach_price_book b where b.version = outreach__billing_text('billing_price_version', 'v1')),
    'features', (select coalesce(jsonb_agg(jsonb_build_object('plan', f.plan, 'feature', f.feature, 'enabled', f.enabled, 'limit', f.limit_value) order by f.feature, outreach__plan_rank(f.plan)), '[]'::jsonb)
                   from outreach_plan_features f))
$$;

-- -----------------------------------------------------------------------------
-- Billing state for the app (billing page, senders meter, feature gates, banners)
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_state(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; m outreach_members%rowtype; svc boolean := outreach_is_service(); feat jsonb; fp text; owner boolean; base jsonb;
begin
  select * into w from outreach_workspaces where id = p_ws and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not svc then
    select * into m from outreach_members where workspace_id = p_ws and user_id = auth.uid();
    if not found or not platform_can_use(auth.uid(), 'outreach') then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
  end if;
  owner := svc or m.role = 'owner';
  fp := outreach_feature_plan(p_ws);
  select coalesce(jsonb_object_agg(f.feature, jsonb_build_object('enabled', outreach_has_feature(p_ws, f.feature), 'limit', outreach_plan_limit(p_ws, f.feature), 'min_plan', outreach_feature_min_plan(f.feature))), '{}'::jsonb)
    into feat from outreach_plan_features f where f.plan = fp;
  base := jsonb_build_object('workspace_id', p_ws, 'enforced', outreach_billing_enforced(), 'plan', w.plan, 'feature_plan', fp,
    'read_only', not outreach_plan_active(p_ws), 'features', feat, 'is_owner', owner);
  if not svc and m.role = 'client_viewer' then
    -- a client viewer learns nothing about billing, only whether their access is part of the plan
    return base - 'features' || jsonb_build_object('access_blocked', case when outreach_has_feature(p_ws, 'client_viewer') then null else 'client_viewer_plan' end);
  end if;
  base := base || jsonb_build_object(
    'accounts', outreach__slots(p_ws),
    'trial', jsonb_build_object('ends_at', w.trial_ends_at, 'account_limit', w.trial_account_limit,
               'days_left', case when w.plan = 'trial' then greatest(ceil(extract(epoch from w.trial_ends_at - now()) / 86400)::int, 0) end),
    'past_due', w.stripe_status in ('past_due','unpaid') or w.past_due_since is not null, 'past_due_since', w.past_due_since,
    'cancel_at_period_end', w.cancel_at_period_end, 'current_period_end', w.current_period_end, 'data_delete_after', w.data_delete_after,
    'paused_over_limit', (select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'name', s.display_name) order by s.billing_paused_at), '[]'::jsonb)
                            from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null and s.status = 'paused' and s.status_reason = 'over_plan_limit'));
  if not owner then return base; end if;
  return base || jsonb_build_object(
    'billing_period', w.billing_period, 'accounts_requested', w.accounts_requested, 'accounts_billed', w.accounts_billed,
    'current_period_start', w.current_period_start, 'cancelled_at', w.cancelled_at, 'scheduled_change', w.scheduled_change,
    'pending_payment', w.pending_payment, 'stripe_status', w.stripe_status, 'has_customer', w.stripe_customer_id is not null,
    'has_subscription', w.stripe_subscription_id is not null and coalesce(w.stripe_status, '') in ('active','trialing','past_due','unpaid'),
    'comp', w.billing_comp, 'price_version', w.price_version, 'custom_price', w.custom_price_id is not null,
    'plan_before_suspension', w.plan_before_suspension, 'disputed', w.disputed_at is not null,
    'early_supporter', case when w.early_supporter_discount > 0 then jsonb_build_object('tier', w.early_supporter_tier, 'discount', w.early_supporter_discount) end,
    'quote_current', case when w.plan in ('launch','scale','enterprise') and w.billing_period is not null and w.accounts_billed is not null and w.custom_price_id is null
                          then outreach_quote_accounts(w.plan, w.billing_period, w.accounts_billed, w.price_version) end);
end $$;

-- billing history for the owner (and the admin panel through the service role)
create or replace function outreach_billing_changes(p_ws uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() and not exists (select 1 from outreach_members m where m.workspace_id = p_ws and m.user_id = auth.uid() and m.role = 'owner') then
    raise exception 'E_FORBIDDEN: owner required';
  end if;
  return (select coalesce(jsonb_agg(to_jsonb(c) - 'quote' || jsonb_build_object('charge_today_cents', c.quote->'charge_today_cents', 'next_invoice_cents', c.quote->'next_invoice_cents',
                    'requested_by_email', (select u.email from auth.users u where u.id = c.requested_by)) order by c.created_at desc), '[]'::jsonb)
            from (select * from outreach_billing_changes x where x.workspace_id = p_ws and x.status <> 'quoted' order by x.created_at desc limit least(greatest(p_limit, 1), 200)) c);
end $$;

-- -----------------------------------------------------------------------------
-- Daily cost report (PRD §12 #6): what is paid for vs what is connected. The edge job adds the connector's own count.
-- -----------------------------------------------------------------------------
create or replace function outreach_billing_cost_report() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare month_start timestamptz := date_trunc('month', now()); swap_alert int := outreach__billing_int('billing_swap_alert_per_month', 5);
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return jsonb_build_object(
    'day', (now() at time zone 'utc')::date, 'enforced', outreach_billing_enforced(),
    'accounts_billed', (select coalesce(sum(accounts_billed), 0) from outreach_workspaces where deleted_at is null and plan in ('launch','scale','enterprise')),
    'trial_accounts', (select coalesce(sum(trial_account_limit), 0) from outreach_workspaces where deleted_at is null and plan = 'trial'),
    'connected', (select count(*) from outreach_senders s join outreach_workspaces w on w.id = s.workspace_id where w.deleted_at is null and outreach__occupies(s)),
    'connected_by_plan', (select coalesce(jsonb_object_agg(x.plan, x.n), '{}'::jsonb) from (select w.plan, count(*) n from outreach_senders s join outreach_workspaces w on w.id = s.workspace_id
                             where w.deleted_at is null and outreach__occupies(s) group by w.plan) x),
    'connected_on_inactive_plans', (select count(*) from outreach_senders s join outreach_workspaces w on w.id = s.workspace_id
                                     where w.deleted_at is null and outreach__occupies(s) and w.plan in ('suspended','cancelled','trial_expired')),
    'paused_over_limit', (select count(*) from outreach_senders s where s.deleted_at is null and s.status = 'paused' and s.status_reason = 'over_plan_limit'),
    'deletions_pending', (select count(*) from outreach_account_deletions where done_at is null),
    'deletions_stuck', (select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'workspace_id', workspace_id, 'since', created_at, 'error', last_error)), '[]'::jsonb)
                          from outreach_account_deletions where done_at is null and created_at < now() - interval '24 hours'),
    -- a swap = an account freed and another taken in the same month: each costs one extra connector account that month
    'swaps', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', x.workspace_id, 'name', (select name from outreach_workspaces where id = x.workspace_id), 'swaps', x.swaps) order by x.swaps desc), '[]'::jsonb)
                from (select e.workspace_id, least(count(*) filter (where e.kind = 'freed'), count(*) filter (where e.kind = 'taken'))::int swaps
                        from outreach_slot_events e where e.at >= month_start group by e.workspace_id) x where x.swaps > swap_alert),
    'workspaces', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'plan', w.plan, 'billed', outreach__slot_limit(w),
                             'connected', (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s))) order by w.created_at), '[]'::jsonb)
                     from outreach_workspaces w where w.deleted_at is null));
end $$;

create or replace function outreach_billing_save_cost_report(p_report jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_billing_cost_reports(day, report) values ((now() at time zone 'utc')::date, p_report)
  on conflict (day) do update set report = excluded.report, created_at = now();
end $$;

-- -----------------------------------------------------------------------------
-- Grants. Supabase grants EXECUTE on new functions to anon / authenticated by default: take it back for everything
-- internal, then open the few the app calls with a user JWT (each checks membership itself).
-- -----------------------------------------------------------------------------
do $$
declare f record;
  user_fns text[] := array['outreach_slots','outreach_billing_state','outreach_billing_changes','outreach_downgrade_effects','outreach_senders_to_pause','outreach_quote_accounts'];
  anon_fns text[] := array['outreach_early_supporters_public','outreach_pricing_public'];
begin
  for f in select p.oid::regprocedure sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'outreach_billing_enforced','outreach__billing_int','outreach__billing_text','outreach__plan_label','outreach__plan_rank','outreach__period_months','outreach_quote_accounts',
              'outreach_feature_plan','outreach_has_feature','outreach_plan_limit','outreach_feature_min_plan','outreach_require_feature','outreach__plan_inactive_message',
              'outreach__occupies','outreach__slot_limit','outreach__slots','outreach_slots','outreach__slot_lock','outreach__account_limit_message','outreach_slot_reserve','outreach_slot_release',
              'outreach_slot_release_sender','outreach_trg_senders_slot_guard','outreach__resume_over_limit','outreach_trg_senders_slot_freed','outreach_disconnect_sender','outreach_account_deletions_due','outreach_account_deletion_result',
              'outreach__account_ranking','outreach_senders_to_pause','outreach_enforce_account_limit','outreach_apply_plan_features','outreach_downgrade_effects','outreach_billing_suspend',
              'outreach__billing_cancelled','outreach_resume_after_billing','outreach_billing_apply_subscription','outreach_billing_dispute','outreach_billing_tick','outreach_billing_record_usage',
              'outreach_billing_notices_due','outreach_billing_notice_claim','outreach_workspaces_due_for_deletion','outreach_purge_workspace','outreach__free_mail_domain','outreach__trial_claimed',
              'outreach_assign_early_supporter','outreach_trg_workspace_billing_before','outreach_trg_workspace_billing_after','outreach_early_supporters_public','outreach_pricing_public',
              'outreach_billing_state','outreach_billing_changes','outreach_billing_cost_report','outreach_billing_save_cost_report') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = any(user_fns) then execute format('grant execute on function %s to authenticated', f.sig); end if;
    if f.proname = any(anon_fns) then execute format('grant execute on function %s to anon, authenticated', f.sig); end if;
  end loop;
end $$;
-- helpers that RLS policies and other definer functions call as the querying user stay callable (they reveal nothing by themselves)
grant execute on function outreach_plan_active(uuid) to authenticated;
grant execute on function outreach_require(uuid, text) to authenticated;
