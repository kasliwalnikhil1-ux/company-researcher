-- =============================================================================
-- Platform admin — 003 outreach billing v2 (pricing-billing-PRD.md §11.3 admin panel, §14 #25 #37)
--   plans Launch / Scale / Enterprise in the admin RPCs, comp workspaces (plan + account count set by hand),
--   custom Enterprise price, early-supporter discount, billing history, the enforcement switch.
-- Run after migrations/outreach/056–060. Idempotent.
-- =============================================================================

-- ----------------------------------------------------------------------------- workspace list: billing columns
create or replace function platform_admin_outreach_workspaces(p_search text default null, p_include_deleted boolean default false)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare v_search text := nullif(trim(coalesce(p_search, '')), '');
begin
  perform platform_require_admin();
  return (select coalesce(jsonb_agg(jsonb_build_object(
      'id', w.id, 'name', w.name, 'slug', w.slug, 'plan', w.plan, 'trial_ends_at', w.trial_ends_at,
      'stripe_status', w.stripe_status, 'past_due_since', w.past_due_since, 'created_at', w.created_at, 'deleted_at', w.deleted_at,
      'plan_before_suspension', w.plan_before_suspension,
      'billing_period', w.billing_period, 'accounts_billed', w.accounts_billed, 'accounts_requested', w.accounts_requested,
      'accounts_used', (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s)),
      'trial_account_limit', w.trial_account_limit, 'billing_comp', w.billing_comp, 'custom_price_id', w.custom_price_id,
      'early_supporter_discount', w.early_supporter_discount, 'early_supporter_tier', w.early_supporter_tier,
      'early_supporter_position', (select e.position from outreach_early_supporters e where e.workspace_id = w.id),
      'current_period_end', w.current_period_end, 'cancel_at_period_end', w.cancel_at_period_end, 'scheduled_change', w.scheduled_change,
      'data_delete_after', w.data_delete_after, 'stripe_customer_id', w.stripe_customer_id, 'stripe_subscription_id', w.stripe_subscription_id,
      'has_subscription', w.stripe_subscription_id is not null and coalesce(w.stripe_status, '') in ('active','trialing','past_due','unpaid'),
      'owner_email', (select u.email from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and m.role = 'owner' order by m.created_at limit 1),
      'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', coalesce(u.email, m.email::text), 'role', m.role, 'client_ids', m.client_ids, 'can_reply', m.can_reply) order by m.role, m.created_at), '[]'::jsonb)
                    from outreach_members m left join auth.users u on u.id = m.user_id where m.workspace_id = w.id),
      'senders', (select count(*) from outreach_senders s where s.workspace_id = w.id and s.deleted_at is null),
      'senders_ok', (select count(*) from outreach_senders s where s.workspace_id = w.id and s.deleted_at is null and s.status = 'ok'),
      'leads', (select count(*) from outreach_leads l where l.workspace_id = w.id),
      'sequences', (select count(*) from outreach_sequences q where q.workspace_id = w.id),
      'clients', (select count(*) from outreach_clients c where c.workspace_id = w.id),
      'actions_7d', (select count(*) from outreach_actions a where a.workspace_id = w.id and a.created_at > now() - interval '7 days')
    ) order by w.created_at desc), '[]'::jsonb)
    from outreach_workspaces w
   where (p_include_deleted or w.deleted_at is null)
     and (v_search is null or w.name ilike '%' || v_search || '%' or w.slug ilike '%' || v_search || '%' or w.id::text = v_search
          or exists (select 1 from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = w.id and u.email ilike '%' || v_search || '%')));
end $$;

-- ----------------------------------------------------------------------------- edit one workspace
/*
 * p_patch keys (all optional):
 *   name, trial_ends_at
 *   plan: trial | launch | scale | enterprise | suspended. A paid plan set here makes a comp workspace (no Stripe
 *         subscription; the billing job leaves it alone). While a Stripe subscription is live the only plan edits are
 *         suspending and lifting the suspension (the workspace returns to the plan it had; Stripe stays the authority).
 *   accounts_billed: number, or null for no limit (comp / custom deals above 100 accounts)
 *   trial_account_limit: how many accounts a trial may connect (default 1)
 *   billing_period: monthly | quarterly | annual (label only on a comp workspace)
 *   custom_price_id: a Stripe price made for this workspace (Enterprise custom deal), or null to clear
 *   early_supporter_discount: 0 | 0.1 | 0.3 | 0.5 (0 removes it)
 * A key whose value is what the workspace already has changes nothing and is never refused.
 * custom_price_id and early_supporter_discount are used at the next checkout / plan change. They do not touch a live Stripe
 * subscription: add or remove the coupon (early_50 / early_30 / early_10) or swap the price on the subscription in Stripe too.
 * Suspending pauses every connected sender (reason 'billing_suspended'); lifting it resumes them.
 */
create or replace function platform_admin_outreach_set_workspace(p_ws uuid, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces; upd jsonb := '{}'; v_plan text; v_trial timestamptz; v_name text; n int; v_acc int; v_disc numeric; old_feat text; new_feat text; live_sub boolean; r jsonb;
begin
  perform platform_require_admin();
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND: no such workspace'; end if;
  live_sub := w.stripe_subscription_id is not null and coalesce(w.stripe_status, '') in ('active','trialing','past_due','unpaid');
  old_feat := outreach_feature_plan(p_ws);
  -- the admin edits billing columns as "the system": inner helpers are service-only
  perform set_config('request.jwt.claim.role', 'service_role', true);

  if p_patch ? 'name' then
    v_name := nullif(trim(p_patch->>'name'), '');
    if v_name is null then raise exception 'E_PAYLOAD_INVALID: name is required'; end if;
    if v_name <> w.name then upd := upd || jsonb_build_object('name', jsonb_build_object('from', w.name, 'to', v_name)); update outreach_workspaces set name = v_name where id = p_ws; end if;
  end if;

  if p_patch ? 'trial_ends_at' then
    v_trial := nullif(p_patch->>'trial_ends_at', '')::timestamptz;
    if v_trial is null then raise exception 'E_PAYLOAD_INVALID: trial_ends_at is required'; end if;
    if v_trial <> w.trial_ends_at then
      upd := upd || jsonb_build_object('trial_ends_at', jsonb_build_object('from', w.trial_ends_at, 'to', v_trial));
      update outreach_workspaces set trial_ends_at = v_trial where id = p_ws;
      -- a lapsed trial that is extended is a trial again (its account stays disconnected until someone reconnects it)
      if w.plan = 'trial_expired' and v_trial > now() and not (p_patch ? 'plan') then
        update outreach_workspaces set plan = 'trial', plan_before_suspension = null, data_delete_after = null where id = p_ws;
        upd := upd || jsonb_build_object('plan', jsonb_build_object('from', 'trial_expired', 'to', 'trial'));
      end if;
    end if;
  end if;

  if p_patch ? 'plan' then
    v_plan := p_patch->>'plan';
    if v_plan is distinct from w.plan and v_plan not in ('trial','launch','scale','enterprise','suspended') then raise exception 'E_PAYLOAD_INVALID: plan must be trial, launch, scale, enterprise or suspended'; end if;
    if v_plan <> w.plan then
      if live_sub and v_plan <> 'suspended' then
        if w.plan <> 'suspended' then
          raise exception 'E_PAYLOAD_INVALID: this workspace is billed through Stripe (%). Change its subscription there, or cancel it first; a plan set here would be overwritten by the next Stripe event.', w.stripe_status;
        end if;
        -- lifting a suspension on a Stripe-billed workspace returns it to the plan its subscription has, whatever was picked
        v_plan := coalesce(nullif(w.plan_before_suspension, 'trial'), v_plan);
      end if;
      upd := upd || jsonb_build_object('plan', jsonb_build_object('from', w.plan, 'to', v_plan));
      if v_plan = 'suspended' then
        n := outreach_billing_suspend(p_ws, 'admin');
        upd := upd || jsonb_build_object('senders_paused', n);
      else
        update outreach_workspaces set plan = v_plan, past_due_since = null, suspended_at = null, plan_before_suspension = null, data_delete_after = null, cancelled_at = null,
               billing_comp = (v_plan in ('launch','scale','enterprise') and not live_sub) where id = p_ws;
        if w.plan in ('suspended','cancelled','trial_expired') then
          update outreach_senders set status = 'ok', status_reason = null where workspace_id = p_ws and status = 'paused' and status_reason in ('billing_suspended','billing_cancelled','trial_expired') and deleted_at is null;
          get diagnostics n = row_count;
          upd := upd || jsonb_build_object('senders_resumed', n);
        end if;
      end if;
    end if;
  end if;

  if p_patch ? 'accounts_billed' then
    v_acc := nullif(p_patch->>'accounts_billed', '')::int;
    if v_acc is not null and v_acc < 1 then raise exception 'E_PAYLOAD_INVALID: accounts must be 1 or more (leave empty for no limit)'; end if;
    if live_sub and v_acc is distinct from w.accounts_billed then raise exception 'E_PAYLOAD_INVALID: this workspace is billed through Stripe. Change the quantity on its subscription; the workspace follows.'; end if;
    if v_acc is distinct from w.accounts_billed then
      upd := upd || jsonb_build_object('accounts_billed', jsonb_build_object('from', w.accounts_billed, 'to', v_acc));
      update outreach_workspaces set accounts_billed = v_acc, accounts_requested = v_acc where id = p_ws;
    end if;
  end if;

  if p_patch ? 'trial_account_limit' then
    v_acc := nullif(p_patch->>'trial_account_limit', '')::int;
    if v_acc is null or v_acc < 0 or v_acc > 100 then raise exception 'E_PAYLOAD_INVALID: the trial account limit is a number from 0 to 100'; end if;
    if v_acc <> w.trial_account_limit then
      upd := upd || jsonb_build_object('trial_account_limit', jsonb_build_object('from', w.trial_account_limit, 'to', v_acc));
      update outreach_workspaces set trial_account_limit = v_acc where id = p_ws;
    end if;
  end if;

  if p_patch ? 'billing_period' then
    if nullif(p_patch->>'billing_period', '') is not null and (p_patch->>'billing_period') not in ('monthly','quarterly','annual') then raise exception 'E_PAYLOAD_INVALID: billing_period must be monthly, quarterly or annual'; end if;
    if live_sub and nullif(p_patch->>'billing_period', '') is distinct from w.billing_period then raise exception 'E_PAYLOAD_INVALID: this workspace is billed through Stripe. Change the period on its subscription.'; end if;
    if nullif(p_patch->>'billing_period', '') is distinct from w.billing_period then
      upd := upd || jsonb_build_object('billing_period', jsonb_build_object('from', w.billing_period, 'to', nullif(p_patch->>'billing_period', '')));
      update outreach_workspaces set billing_period = nullif(p_patch->>'billing_period', '') where id = p_ws;
    end if;
  end if;

  if p_patch ? 'custom_price_id' then
    if nullif(p_patch->>'custom_price_id', '') is not null and (p_patch->>'custom_price_id') !~ '^price_[A-Za-z0-9]+$' then raise exception 'E_PAYLOAD_INVALID: a Stripe price id looks like price_…'; end if;
    if nullif(p_patch->>'custom_price_id', '') is distinct from w.custom_price_id then
      upd := upd || jsonb_build_object('custom_price_id', jsonb_build_object('from', w.custom_price_id, 'to', nullif(p_patch->>'custom_price_id', '')));
      update outreach_workspaces set custom_price_id = nullif(p_patch->>'custom_price_id', '') where id = p_ws;
    end if;
  end if;

  if p_patch ? 'early_supporter_discount' then
    v_disc := coalesce(nullif(p_patch->>'early_supporter_discount', '')::numeric, 0);
    if v_disc not in (0, 0.1, 0.3, 0.5) then raise exception 'E_PAYLOAD_INVALID: the early-supporter discount is 0, 0.1, 0.3 or 0.5'; end if;
    if v_disc <> w.early_supporter_discount then
      upd := upd || jsonb_build_object('early_supporter_discount', jsonb_build_object('from', w.early_supporter_discount, 'to', v_disc));
      update outreach_workspaces set early_supporter_discount = v_disc,
             early_supporter_tier = case when v_disc = 0 then null else (select t.tier from outreach_early_supporter_tiers t where t.discount = v_disc) end where id = p_ws;
      update outreach_early_supporters set forfeited_at = case when v_disc = 0 then coalesce(forfeited_at, now()) else null end, discount = case when v_disc = 0 then discount else v_disc end,
             note = 'set by admin' where workspace_id = p_ws;
    end if;
  end if;

  -- a different plan or account count takes effect now: features and the account limit
  if upd ? 'plan' or upd ? 'accounts_billed' or upd ? 'trial_account_limit' then
    new_feat := outreach_feature_plan(p_ws);
    if new_feat is distinct from old_feat then upd := upd || jsonb_build_object('features', outreach_apply_plan_features(p_ws, old_feat, new_feat)); end if;
    r := outreach_enforce_account_limit(p_ws, null);
    if coalesce((r->>'paused')::int, 0) + coalesce((r->>'resumed')::int, 0) + coalesce((r->>'disconnected')::int, 0) > 0 then upd := upd || jsonb_build_object('accounts', r); end if;
  end if;
  perform set_config('request.jwt.claim.role', '', true);

  if upd <> '{}'::jsonb then
    perform platform_audit('outreach.workspace_updated', w.created_by, upd || jsonb_build_object('workspace_id', p_ws, 'workspace', w.name));
    perform outreach_audit(p_ws, 'workspace.admin_updated', 'workspace', p_ws::text, upd, 'admin');
    if upd ? 'plan' or upd ? 'accounts_billed' or upd ? 'billing_period' or upd ? 'early_supporter_discount' or upd ? 'custom_price_id' then
      insert into outreach_billing_changes(workspace_id, requested_by, kind, from_state, to_state, quote, status, applied_at)
      select p_ws, auth.uid(), 'admin',
             jsonb_build_object('plan', w.plan, 'accounts_billed', w.accounts_billed, 'billing_period', w.billing_period),
             jsonb_build_object('plan', x.plan, 'accounts_billed', x.accounts_billed, 'billing_period', x.billing_period),
             jsonb_build_object('charge_today_cents', 0, 'admin', upd), 'applied', now()
        from outreach_workspaces x where x.id = p_ws;
    end if;
  end if;
  return (select x from jsonb_array_elements(platform_admin_outreach_workspaces(p_ws::text, true)) x limit 1);
end $$;

-- ----------------------------------------------------------------------------- billing history of one workspace
create or replace function platform_admin_outreach_billing(p_ws uuid, p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'changes', (select coalesce(jsonb_agg(to_jsonb(c) || jsonb_build_object('requested_by_email', (select u.email from auth.users u where u.id = c.requested_by)) order by c.created_at desc), '[]'::jsonb)
                  from (select * from outreach_billing_changes x where x.workspace_id = p_ws and x.status <> 'quoted' order by x.created_at desc limit least(greatest(p_limit, 1), 200)) c),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('id', e.stripe_event_id, 'type', e.type, 'received_at', e.received_at, 'processed_at', e.processed_at, 'error', e.error) order by e.received_at desc), '[]'::jsonb)
                 from (select * from outreach_billing_events x where x.workspace_id = p_ws order by x.received_at desc limit least(greatest(p_limit, 1), 200)) e),
    'slots', outreach__slots(p_ws),
    'early_supporter', (select to_jsonb(e) from outreach_early_supporters e where e.workspace_id = p_ws));
end $$;

-- ----------------------------------------------------------------------------- the rollout switch
-- What turning enforcement on would do right now, and the latest cost report. Read-only.
create or replace function platform_admin_billing_overview() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare trial_accounts int := outreach__billing_int('billing_trial_accounts', 1);
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'enforced', outreach_billing_enforced(),
    'data_deletion', coalesce((select value in ('true'::jsonb, '"true"'::jsonb) from outreach_flags where key = 'billing_data_deletion'), false),
    'price_version', outreach__billing_text('billing_price_version', 'v1'),
    'trial_days', outreach__billing_int('billing_trial_days', 7), 'trial_accounts', outreach__billing_int('billing_trial_accounts', 1),
    'trial_data_days', outreach__billing_int('billing_trial_data_days', 30), 'cancel_data_days', outreach__billing_int('billing_cancel_data_days', 90),
    -- trials that are already over: with enforcement on, the next hourly run ends them and disconnects their accounts
    'trials_that_would_expire', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'trial_ends_at', w.trial_ends_at,
          'accounts', (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s))) order by w.created_at), '[]'::jsonb)
        from outreach_workspaces w where w.deleted_at is null and w.plan = 'trial' and not w.billing_comp and w.trial_ends_at < now()
          and (w.stripe_subscription_id is null or coalesce(w.stripe_status, '') not in ('active','trialing','past_due','unpaid'))),
    -- running trials with more accounts than a trial includes: the extra ones would be paused
    'trials_over_limit', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'trial_ends_at', w.trial_ends_at, 'limit', w.trial_account_limit,
          'accounts', (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s))) order by w.created_at), '[]'::jsonb)
        from outreach_workspaces w where w.deleted_at is null and w.plan = 'trial' and not w.billing_comp and w.trial_ends_at >= now()
          and (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s)) > w.trial_account_limit),
    'paid_over_limit', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'plan', w.plan, 'limit', w.accounts_billed,
          'accounts', (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s))) order by w.created_at), '[]'::jsonb)
        from outreach_workspaces w where w.deleted_at is null and w.plan in ('launch','scale','enterprise') and w.accounts_billed is not null
          and (select count(*) from outreach_senders s where s.workspace_id = w.id and outreach__occupies(s)) > w.accounts_billed),
    'due_for_deletion', (select coalesce(jsonb_agg(jsonb_build_object('workspace_id', w.id, 'name', w.name, 'plan', w.plan, 'data_delete_after', w.data_delete_after) order by w.data_delete_after), '[]'::jsonb)
        from outreach_workspaces w where w.deleted_at is null and w.plan in ('trial_expired','cancelled') and w.data_delete_after is not null and w.data_delete_after < now()),
    'deletions_pending', (select count(*) from outreach_account_deletions where done_at is null),
    'latest_cost_report', (select jsonb_build_object('day', r.day, 'report', r.report) from outreach_billing_cost_reports r order by r.day desc limit 1));
end $$;

-- Turning enforcement on is refused while a trial that is already over would be ended by it, unless the caller confirms
-- having read the list (those workspaces lose their connected accounts at the next hourly run).
create or replace function platform_admin_billing_set(p_key text, p_value boolean, p_confirm boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare o jsonb;
begin
  perform platform_require_admin();
  if p_key not in ('billing_enforced','billing_data_deletion') then raise exception 'E_PAYLOAD_INVALID: unknown switch %', p_key; end if;
  o := platform_admin_billing_overview();
  if p_key = 'billing_enforced' and p_value and not coalesce(p_confirm, false)
     and (jsonb_array_length(o->'trials_that_would_expire') > 0 or jsonb_array_length(o->'trials_over_limit') > 0 or jsonb_array_length(o->'paid_over_limit') > 0) then
    raise exception 'E_CONFIRM_REQUIRED: % trial(s) are already over and would have their accounts disconnected, % running trial(s) and % paid workspace(s) are over their account limit. Set a plan for the workspaces that should keep working, then confirm.',
      jsonb_array_length(o->'trials_that_would_expire'), jsonb_array_length(o->'trials_over_limit'), jsonb_array_length(o->'paid_over_limit');
  end if;
  if p_key = 'billing_data_deletion' and p_value and not coalesce(p_confirm, false) and jsonb_array_length(o->'due_for_deletion') > 0 then
    raise exception 'E_CONFIRM_REQUIRED: % workspace(s) are past their date and would be deleted at the next daily run. Confirm to turn automatic deletion on.', jsonb_array_length(o->'due_for_deletion');
  end if;
  insert into outreach_flags(key, value) values (p_key, to_jsonb(p_value)) on conflict (key) do update set value = excluded.value;
  perform platform_audit('outreach.billing_switch', null, jsonb_build_object('key', p_key, 'value', p_value, 'confirmed', coalesce(p_confirm, false)));
  return platform_admin_billing_overview();
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('platform_admin_outreach_workspaces','platform_admin_outreach_set_workspace','platform_admin_outreach_billing','platform_admin_billing_overview','platform_admin_billing_set') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated, service_role', f.sig);
  end loop;
end $$;
