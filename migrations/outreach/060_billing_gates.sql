-- =============================================================================
-- Outreach Platform — 060 billing v2 plan gates (pricing-billing-PRD.md §7.1, §10.5)
-- Every plan-name comparison becomes outreach_has_feature() / outreach_plan_limit(), and the checks §7.1 lists as missing are
-- added. Live function bodies are patched in place (like 027–029) so nothing else in them changes. Run after 059. Idempotent.
--
-- While the platform flag `billing_enforced` is off, outreach_has_feature() is true for everything and none of these gates
-- refuses anything (the website-inbox count keeps its pre-billing limit of 1).
-- =============================================================================

-- patch helper: replace one piece of a function body; `p_marker` (text that only exists after the patch) makes it re-runnable
create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');   -- bodies applied from a CRLF checkout carry CR
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;

-- ----------------------------------------------------------------------------- tracking domains (Scale)
select outreach__patch_fn('public.outreach_add_tracking_domain(uuid,text,uuid)'::regprocedure, 'outreach_require_feature',
$q$  select plan into pl from outreach_workspaces where id = p_ws;
  if pl not in ('agency','agency_plus') and (select coalesce(branding,'{}'::jsonb) = '{}'::jsonb from outreach_workspaces where id = p_ws) then
    raise exception 'E_PLAN_REQUIRED: custom tracking domains are part of the agency and white-label plans (each domain is approved by hand on the provider side)';
  end if;$q$,
$q$  perform outreach_require_feature(p_ws, 'tracking_domains', 'A custom tracking domain');$q$);

-- links fall back to the default tracking domain while the plan has no custom domains; the domain rows are kept
select outreach__patch_fn('public.outreach_tracking_domain_for(uuid)'::regprocedure, 'outreach_has_feature',
$q$where d.status = 'active' and$q$, $q$where d.status = 'active' and outreach_has_feature(d.workspace_id, 'tracking_domains') and$q$);

-- ----------------------------------------------------------------------------- website chat inboxes (1 / 3 / no limit)
select outreach__patch_fn('public.outreach_webchat_inbox_create(uuid,text,text[],uuid)'::regprocedure, 'outreach_plan_limit',
$q$  select w.plan into plan from outreach_workspaces w where w.id = p_ws;
  lim := case plan when 'agency_plus' then null when 'agency' then 3 else 1 end;$q$,
$q$  lim := case when outreach_billing_enforced() then outreach_plan_limit(p_ws, 'webchat_inboxes') else 1 end;$q$);

-- ----------------------------------------------------------------------------- signed webhooks (Enterprise)
select outreach__patch_fn('public.outreach_create_webhook(uuid,text,text[])'::regprocedure, 'outreach_require_feature',
$q$  perform outreach_require(p_ws, 'manager');
  if p_url !~$q$,
$q$  perform outreach_require(p_ws, 'manager');
  perform outreach_require_feature(p_ws, 'webhooks', 'Signed webhooks');
  if p_url !~$q$);

select outreach__patch_fn('public.outreach_set_webhook_active(uuid,boolean)'::regprocedure, 'outreach_require_feature',
$q$  perform outreach_require(ws, 'manager');$q$,
$q$  perform outreach_require(ws, 'manager');
  if p_active then perform outreach_require_feature(ws, 'webhooks', 'Signed webhooks'); end if;$q$);

-- delivery is paused, not queued, while the plan has no webhooks; it resumes for new events after an upgrade
select outreach__patch_fn('public.outreach_emit_event(uuid,text,jsonb)'::regprocedure, 'outreach_has_feature',
$q$  where w.workspace_id = p_ws and w.active and (p_event = any(w.events) or '*' = any(w.events));$q$,
$q$  where w.workspace_id = p_ws and w.active and (p_event = any(w.events) or '*' = any(w.events)) and outreach_has_feature(p_ws, 'webhooks');$q$);

-- ----------------------------------------------------------------------------- public API (Enterprise)
select outreach__patch_fn('public.outreach_create_api_key(uuid,text,outreach_role_t,uuid[],timestamptz)'::regprocedure, 'outreach_require_feature',
$q$  perform outreach_require(p_ws, 'manager');
  select * into me$q$,
$q$  perform outreach_require(p_ws, 'manager');
  perform outreach_require_feature(p_ws, 'public_api', 'The public API');
  select * into me$q$);

-- keys are kept on a plan without the API; the gateway answers 402 E_PLAN_REQUIRED from `api_enabled`
select outreach__patch_fn('public.outreach_api_authenticate(text)'::regprocedure, 'api_enabled',
$q$'plan', w.plan, 'name', k.name);$q$,
$q$'plan', w.plan, 'name', k.name, 'api_enabled', outreach_has_feature(k.workspace_id, 'public_api'), 'min_plan', outreach_feature_min_plan('public_api'));$q$);

-- ----------------------------------------------------------------------------- white-label (Enterprise)
select outreach__patch_fn('public.outreach_set_branding(uuid,jsonb)'::regprocedure, 'outreach_require_feature',
$q$  perform outreach_require(p_ws, 'owner');
  b := jsonb_strip_nulls($q$,
$q$  perform outreach_require(p_ws, 'owner');
  perform outreach_require_feature(p_ws, 'white_label', 'White-label branding');
  b := jsonb_strip_nulls($q$);

select outreach__patch_fn('public.outreach_add_domain(uuid,text,uuid)'::regprocedure, 'outreach_require_feature',
$q$  perform outreach_require(p_ws, 'owner');
  if h !~$q$,
$q$  perform outreach_require(p_ws, 'owner');
  perform outreach_require_feature(p_ws, 'white_label', 'Your own app domain');
  if h !~$q$);

-- default branding while the plan has no white-label; the saved branding is kept and comes back on upgrade
select outreach__patch_fn('public.outreach__public_branding(uuid)'::regprocedure, 'outreach_has_feature',
$q$(coalesce(w.branding,'{}'::jsonb) - 'email_from_address' - 'email_from_name')$q$,
$q$(case when outreach_has_feature(w.id, 'white_label') then coalesce(w.branding,'{}'::jsonb) - 'email_from_address' - 'email_from_name' else '{}'::jsonb end)$q$);

-- the custom app domain stops resolving, so the app falls back to its default domain
select outreach__patch_fn('public.outreach_branding_for_host(text)'::regprocedure, 'outreach_has_feature',
$q$and d.status = 'active'$q$, $q$and d.status = 'active' and outreach_has_feature(d.workspace_id, 'white_label')$q$);

-- ----------------------------------------------------------------------------- per-client reports (Scale)
select outreach__patch_fn('public.outreach_report_client(uuid,date,date)'::regprocedure, 'outreach_require_feature',
$q$  if not found then raise exception 'E_NOT_FOUND'; end if;
  o := outreach_report_overview($q$,
$q$  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require_feature(c.workspace_id, 'client_reports', 'Per-client reports');
  o := outreach_report_overview($q$);

select outreach__patch_fn('public.outreach_report_clients(uuid,date,date)'::regprocedure, 'outreach_require_feature',
$q$  perform outreach__check_range(p_ws, null, f, t);$q$,
$q$  perform outreach__check_range(p_ws, null, f, t);
  perform outreach_require_feature(p_ws, 'client_reports', 'Per-client reports');$q$);

-- ----------------------------------------------------------------------------- AI replies in Auto mode (Scale)
select outreach__patch_fn('public.outreach_sequence_ai_replies_set(uuid,jsonb,text)'::regprocedure, 'outreach_require_feature',
$q$  if srs.downgraded_at is not null and p_patch->>'mode' = 'autopilot'$q$,
$q$  if p_patch->>'mode' = 'autopilot' then perform outreach_require_feature(q.workspace_id, 'ai_auto_reply', 'AI replies in Auto mode'); end if;
  if srs.downgraded_at is not null and p_patch->>'mode' = 'autopilot'$q$);

-- AI limits: the platform's monthly allowance scales with the plan (Enterprise: higher). A limit set for one workspace
-- by an admin is left as it is.
select outreach__patch_fn('public.outreach__ai_pool(uuid)'::regprocedure, 'ai_limits',
$q$    if jsonb_typeof(flagv) = 'number' then lim := (flagv #>> '{}')::int; end if;$q$,
$q$    if jsonb_typeof(flagv) = 'number' then lim := ((flagv #>> '{}')::int * coalesce(outreach_plan_limit(p_ws, 'ai_limits'), 100) / 100)::int; end if;$q$);

-- ----------------------------------------------------------------------------- clients and client viewers (Scale)
-- Clients and invitations are written straight to their tables under RLS, so the gate is a trigger. Existing rows are never
-- touched: on a plan without clients the separation stays in the data and client filters keep working for the team.
create or replace function outreach_trg_clients_plan() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_require_feature(new.workspace_id, 'clients', 'Keeping clients apart');
  return new;
end $$;
drop trigger if exists outreach_clients_plan on outreach_clients;
create trigger outreach_clients_plan before insert on outreach_clients for each row execute function outreach_trg_clients_plan();

create or replace function outreach_trg_client_viewer_plan() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.role = 'client_viewer' and (tg_op = 'INSERT' or old.role is distinct from new.role) then
    perform outreach_require_feature(new.workspace_id, 'client_viewer', 'The client-viewer portal');
  end if;
  return new;
end $$;
drop trigger if exists outreach_invitations_plan on outreach_invitations;
create trigger outreach_invitations_plan before insert on outreach_invitations for each row execute function outreach_trg_client_viewer_plan();
drop trigger if exists outreach_members_plan on outreach_members;
create trigger outreach_members_plan before insert or update of role on outreach_members for each row execute function outreach_trg_client_viewer_plan();

-- a client viewer's login is disabled (not deleted) while the plan has no client access: they are a member of nothing until
-- the plan includes it again. The app shows "Your agency's plan no longer includes client access" from outreach_billing_state().
select outreach__patch_fn('public.outreach_role_in(uuid)'::regprocedure, 'outreach_has_feature',
$q$where m.user_id = auth.uid() and m.workspace_id = ws$q$,
$q$where m.user_id = auth.uid() and m.workspace_id = ws
     and (m.role <> 'client_viewer' or outreach_has_feature(ws, 'client_viewer'))$q$);

-- ----------------------------------------------------------------------------- "Why isn't this sending?"
select outreach__patch_fn('public.outreach__sender_causes(uuid,text[])'::regprocedure, 'E_ACCOUNT_LIMIT',
$q$  if plan = 'suspended' then c := c || jsonb_build_object('code','E_PLAN_SUSPENDED','blocking',true,'sender',nm,'sender_id',s.id,'detail','The workspace is suspended (billing)','remedy','An owner fixes billing; sending resumes on its own afterwards.'); end if;
  if s.status <> 'ok' then$q$,
$q$  if plan in ('suspended','cancelled','trial_expired') then
    c := c || jsonb_build_object('code','E_PLAN_SUSPENDED','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', case plan when 'trial_expired' then 'The trial has ended' when 'cancelled' then 'The subscription has ended' else 'The workspace is suspended (billing)' end,
      'remedy', case plan when 'suspended' then 'An owner fixes billing; sending resumes on its own afterwards.' else 'An owner subscribes on the Billing page, then reconnects the account.' end);
  end if;
  if s.status = 'paused' and s.status_reason = 'over_plan_limit' then
    c := c || jsonb_build_object('code','E_ACCOUNT_LIMIT','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', format('Paused: your plan has %s account%s and %s are connected', (outreach__slots(s.workspace_id)->>'billed'), case when (outreach__slots(s.workspace_id)->>'billed') = '1' then '' else 's' end, (outreach__slots(s.workspace_id)->>'used')),
      'remedy','An owner adds accounts on the Billing page, or removes some. Paused accounts resume in the order they were paused.');
  elsif s.status::text = 'disconnected' then
    c := c || jsonb_build_object('code','E_SENDER_DISCONNECTED','blocking',true,'sender',nm,'sender_id',s.id,
      'detail', nm || ' is disconnected' || case s.status_reason when 'trial_expired' then ' (the trial ended)' when 'over_plan_limit' then ' (the plan has fewer accounts)'
                  when 'billing_suspended' then ' (billing)' when 'billing_cancelled' then ' (the subscription ended)' when 'user_disconnected' then ' (by a teammate)' else '' end,
      'remedy','Reconnect it on the sender page. Its leads wait and carry on from where they stopped.');
  end if;
  if s.status <> 'ok' and s.status::text <> 'disconnected' and not (s.status = 'paused' and coalesce(s.status_reason,'') = 'over_plan_limit') then$q$);

-- ----------------------------------------------------------------------------- resume is not manual for billing pauses
select outreach__patch_fn('public.outreach_pause_sender(uuid,boolean)'::regprocedure, 'E_ACCOUNT_LIMIT',
$q$  else
    update outreach_senders set status = 'ok', status_reason = null where id = p_sender and status = 'paused';$q$,
$q$  else
    if s.status = 'paused' and s.status_reason = 'over_plan_limit' then
      raise exception 'E_ACCOUNT_LIMIT: This account is paused because the plan has fewer accounts than are connected. Add an account or remove another one; it resumes on its own.';
    elsif s.status = 'paused' and s.status_reason in ('billing_suspended','billing_cancelled') then
      raise exception 'E_PLAN_SUSPENDED: This account is paused for billing. It resumes on its own once the subscription is active again.';
    end if;
    update outreach_senders set status = 'ok', status_reason = null where id = p_sender and status = 'paused';$q$);

-- ----------------------------------------------------------------------------- priority processing (Enterprise)
-- When more senders have work due than one run can take, workspaces with priority processing go first; inside each group
-- the oldest due action goes first (the cut used to be arbitrary). Empty while billing is not enforced.
create or replace function outreach__priority_workspaces() returns uuid[]
language sql stable security definer set search_path = public, extensions as $$
  select case when outreach_billing_enforced()
              then coalesce((select array_agg(w.id) from outreach_workspaces w where w.deleted_at is null and outreach_has_feature(w.id, 'priority_processing')), '{}'::uuid[])
              else '{}'::uuid[] end
$$;
revoke execute on function outreach__priority_workspaces() from public, anon, authenticated;

select outreach__patch_fn('public.outreach_claim_due_actions(integer)'::regprocedure, 'outreach__priority_workspaces',
$q$select a2.id, row_number() over (partition by a2.sender_id order by a2.scheduled_for) rn$q$,
$q$select a2.id, a2.scheduled_for, (s.workspace_id = any((select outreach__priority_workspaces())::uuid[])) prio, row_number() over (partition by a2.sender_id order by a2.scheduled_for) rn$q$);
select outreach__patch_fn('public.outreach_claim_due_actions(integer)'::regprocedure, 'order by x.prio desc',
$q$) x where x.rn = 1 limit p_limit$q$, $q$) x where x.rn = 1 order by x.prio desc, x.scheduled_for limit p_limit$q$);

drop function outreach__patch_fn(regprocedure, text, text, text);

-- ----------------------------------------------------------------------------- grants for what this file created
revoke execute on function outreach_trg_clients_plan() from public, anon, authenticated;
revoke execute on function outreach_trg_client_viewer_plan() from public, anon, authenticated;
