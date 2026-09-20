-- =============================================================================
-- Outreach Platform — 015 open the platform + agency features
--   item 21 public API: keys, a dispatcher that runs the SAME RPCs as the UI/connector, read RPCs, webhook replay
--   item 22 CRM sync plumbing (event stream, links, sync rules, log)
--   item 23 white-label (branding, custom domains)       item 24 booking webhook → "Meeting booked"
--   item 20 email depth (mailbox rotation, unsubscribe, tracking domains, BCC, signature)
--   item 18 lead sources (repeating imports, conversations as leads, CSV update mode)
--   item 25/26 voice clips, find-email result        Phase 1 checklist (billing auto-resume, ai_auto_send removed)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Phase 1 checklist
-- -----------------------------------------------------------------------------
-- `ai_auto_send` never did anything and contradicts the approval rule: remove it everywhere.
alter table outreach_workspaces alter column settings set default '{"recruiter_enabled":false,"create_leads_from_inbound":true,"cookie_mode_opt_in":true,"timezone":"UTC","auto_stage_interested":true,"track_replies":false}';
update outreach_workspaces set settings = settings - 'ai_auto_send' where settings ? 'ai_auto_send';
alter table outreach_sequences alter column settings set default '{"stop_on_reply":true,"stop_on_reply_scope":"lead","on_reply":"exit","resume_after_ooo":true,"ooo_resume_days":7,"withdraw_after_days":21}';

-- GetSales makes users restart every sender by hand after a failed renewal. Ours resume on their own.
create or replace function outreach_resume_after_billing(p_ws uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_workspaces set plan = case when plan = 'suspended' then coalesce(nullif(settings->>'plan_before_suspension',''), 'team') else plan end, past_due_since = null where id = p_ws;
  update outreach_senders set status = 'ok', status_reason = null where workspace_id = p_ws and status = 'paused' and status_reason in ('billing_suspended','trial_expired') and deleted_at is null;
  get diagnostics n = row_count;
  perform outreach_audit(p_ws, 'workspace.billing_recovered', 'workspace', p_ws::text, jsonb_build_object('senders_resumed', n), 'system');
  perform outreach_emit_event(p_ws, 'workspace.billing_recovered', jsonb_build_object('id', p_ws, 'senders_resumed', n));
  return n;
end $$;
revoke execute on function outreach_resume_after_billing(uuid) from public, anon, authenticated;

-- sender fields a manager may edit (adds alert recipients, booking link, signature, BCC, cost, mailbox owner, reply tracking)
create or replace function outreach_update_sender(p_sender uuid, p_patch jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; em text;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_patch ? 'alert_emails' then
    for em in select jsonb_array_elements_text(p_patch->'alert_emails') loop
      if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: "%" is not an email address', em; end if;
    end loop;
    if jsonb_array_length(p_patch->'alert_emails') > 10 then raise exception 'E_PAYLOAD_INVALID: at most 10 alert recipients'; end if;
  end if;
  if p_patch ? 'booking_link' and nullif(p_patch->>'booking_link','') is not null and (p_patch->>'booking_link') !~ '^https://' then raise exception 'E_PAYLOAD_INVALID: booking link must start with https://'; end if;
  if p_patch ? 'parent_sender_id' and nullif(p_patch->>'parent_sender_id','') is not null
     and not exists (select 1 from outreach_senders x where x.id = (p_patch->>'parent_sender_id')::uuid and x.workspace_id = s.workspace_id and x.provider = 'LINKEDIN') then
    raise exception 'E_PAYLOAD_INVALID: a mailbox can only belong to a LinkedIn sender of the same workspace';
  end if;
  update outreach_senders set
    display_name = coalesce(p_patch->>'display_name', display_name),
    client_id = case when p_patch ? 'client_id' then nullif(p_patch->>'client_id','')::uuid else client_id end,
    owner_email = case when p_patch ? 'owner_email' then nullif(p_patch->>'owner_email','')::citext else owner_email end,
    alert_emails = case when p_patch ? 'alert_emails' then (select coalesce(array_agg(lower(x)::citext), '{}') from jsonb_array_elements_text(p_patch->'alert_emails') x) else alert_emails end,
    booking_link = case when p_patch ? 'booking_link' then nullif(p_patch->>'booking_link','') else booking_link end,
    signature = case when p_patch ? 'signature' then nullif(p_patch->>'signature','') else signature end,
    bcc_address = case when p_patch ? 'bcc_address' then nullif(p_patch->>'bcc_address','')::citext else bcc_address end,
    monthly_cost = case when p_patch ? 'monthly_cost' then nullif(p_patch->>'monthly_cost','')::numeric else monthly_cost end,
    parent_sender_id = case when p_patch ? 'parent_sender_id' then nullif(p_patch->>'parent_sender_id','')::uuid else parent_sender_id end,
    track_replies = case when p_patch ? 'track_replies' then (p_patch->>'track_replies')::boolean else track_replies end
  where id = p_sender;
  perform outreach_audit(s.workspace_id, 'sender.updated', 'sender', p_sender::text, p_patch - 'signature');
end $$;

create or replace function outreach_assign_chat(p_chat uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_FORBIDDEN'; end if;
  if p_user is not null and not exists (select 1 from outreach_members where workspace_id = c.workspace_id and user_id = p_user) then raise exception 'E_NOT_FOUND: member'; end if;
  update outreach_chats set assigned_to = p_user where id = p_chat;
end $$;

-- -----------------------------------------------------------------------------
-- Events also feed the CRM worker (item 22), only for workspaces that connected a CRM
-- -----------------------------------------------------------------------------
create or replace function outreach_emit_event(p_ws uuid, p_event text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into outreach_outbound_webhook_deliveries(webhook_id, workspace_id, event, payload)
  select w.id, p_ws, p_event, jsonb_build_object('event', p_event, 'workspace_id', p_ws, 'at', now(), 'data', p_payload)
  from outreach_outbound_webhooks w
  where w.workspace_id = p_ws and w.active and (p_event = any(w.events) or '*' = any(w.events));
  if p_event in ('message.sent','message.received','message.classified','email.sent','invite.accepted','enrollment.started','lead.updated','meeting.booked','lead.created')
     and exists (select 1 from outreach_integrations i where i.workspace_id = p_ws and i.status in ('active','error')) then   -- keep queueing while a CRM is in error: changes are sent after it reconnects
    insert into outreach_integration_events(workspace_id, event, payload) values (p_ws, p_event, p_payload);
  end if;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (p_ws, auth.uid(), 'system', p_event, split_part(p_event,'.',1), coalesce(p_payload->>'id', p_payload->>'lead_id', p_payload->>'sender_id'), p_payload);
end $$;
revoke execute on function outreach_emit_event(uuid,text,jsonb) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 21 — API keys. The key is shown once; only its sha256 is stored.
-- -----------------------------------------------------------------------------
create or replace function outreach_create_api_key(p_ws uuid, p_name text, p_role outreach_role_t default 'member', p_client_ids uuid[] default '{}', p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare me outreach_members%rowtype; k text; kid uuid;
begin
  perform outreach_require(p_ws, 'manager');
  select * into me from outreach_members where workspace_id = p_ws and user_id = auth.uid();
  if not found then raise exception 'E_FORBIDDEN'; end if;
  if p_role = 'owner' then raise exception 'E_PAYLOAD_INVALID: API keys cannot have the owner role'; end if;
  if p_role < me.role then raise exception 'E_FORBIDDEN: a key cannot have more rights than you'; end if;   -- enum order: owner < manager < member < client_viewer
  if nullif(trim(coalesce(p_name,'')),'') is null then raise exception 'E_PAYLOAD_INVALID: name required'; end if;
  if exists (select 1 from unnest(p_client_ids) c where not exists (select 1 from outreach_clients x where x.id = c and x.workspace_id = p_ws)) then raise exception 'E_NOT_FOUND: client'; end if;
  if (select count(*) from outreach_api_keys where workspace_id = p_ws and revoked_at is null) >= 25 then raise exception 'E_TOO_MANY: at most 25 active keys per workspace'; end if;
  k := 'ok_live_' || encode(gen_random_bytes(24), 'hex');
  insert into outreach_api_keys(workspace_id, user_id, name, prefix, key_hash, role, client_ids, expires_at)
  values (p_ws, auth.uid(), left(trim(p_name), 80), left(k, 14), encode(digest(k, 'sha256'), 'hex'), p_role, coalesce(p_client_ids,'{}'), p_expires_at) returning id into kid;
  perform outreach_audit(p_ws, 'api_key.created', 'api_key', kid::text, jsonb_build_object('name', p_name, 'role', p_role, 'client_ids', p_client_ids));
  return jsonb_build_object('id', kid, 'key', k, 'prefix', left(k, 14), 'note', 'Copy the key now. It is not stored and cannot be shown again.');
end $$;

create or replace function outreach_revoke_api_key(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_api_keys where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  update outreach_api_keys set revoked_at = now() where id = p_id and revoked_at is null;
  perform outreach_audit(ws, 'api_key.revoked', 'api_key', p_id::text);
end $$;

create or replace function outreach_api_authenticate(p_key text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_api_keys%rowtype; m outreach_members%rowtype; w outreach_workspaces%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_api_keys where key_hash = encode(digest(coalesce(p_key,''), 'sha256'), 'hex');
  if not found or k.revoked_at is not null or (k.expires_at is not null and k.expires_at < now()) then return null; end if;
  select * into m from outreach_members where workspace_id = k.workspace_id and user_id = k.user_id;
  if not found then return null; end if;                                  -- the member who created it left the workspace
  select * into w from outreach_workspaces where id = k.workspace_id and deleted_at is null;
  if not found then return null; end if;
  update outreach_api_keys set last_used_at = now() where id = k.id and (last_used_at is null or last_used_at < now() - interval '1 minute');
  return jsonb_build_object('key_id', k.id, 'workspace_id', k.workspace_id, 'user_id', k.user_id, 'role', greatest(k.role, m.role), 'client_ids', to_jsonb(k.client_ids),
                            'plan', w.plan, 'name', k.name);
end $$;
revoke execute on function outreach_api_authenticate(text) from public, anon, authenticated;

-- Runs one whitelisted RPC AS the key's member: auth.uid() resolves to that member, outreach_require applies,
-- and outreach.key_role / outreach.key_clients narrow it to the key. Arguments are passed by name.
create or replace function outreach_api_dispatch(p_key_id uuid, p_fn text, p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_api_keys%rowtype; pr record; call text := ''; i int; an text; at oid; tcat "char"; tname text; res jsonb; em text;
  allowed text[] := array['upsert_lead','bulk_leads','lead_timeline','request_enrichment','render_context','enroll_preview','enroll_leads','pause_enrollment','resume_enrollment','exit_enrollment',
    'enrollment_recover','failed_leads','failed_summary','set_sequence_status','project_sequence','why_not_sending','set_intent','assign_chat','sender_today','sender_insights',
    'report_overview','report_funnel','report_sequence','report_sequences','report_sender','report_senders','report_client','report_clients','report_intents','report_cost','report_reply_threads',
    'ab_results','metric_definitions','add_suppressions','complete_task','replay_delivery','create_webhook','delete_webhook','set_webhook_active',
    'api_leads','api_lead','api_sequences','api_sequence','api_enrollments','api_threads','api_thread','api_senders','api_sender','api_webhooks','api_deliveries','api_context'];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if not (p_fn = any(allowed)) then raise exception 'E_NOT_FOUND: unknown operation %', p_fn; end if;
  select * into k from outreach_api_keys where id = p_key_id and revoked_at is null;
  if not found then raise exception 'E_FORBIDDEN: key revoked'; end if;
  select email into em from auth.users where id = k.user_id;

  select p.oid, p.proname, p.proargnames, p.proargtypes, p.pronargs, p.proretset, p.prorettype into pr
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_' || p_fn limit 1;
  if pr.oid is null then raise exception 'E_NOT_FOUND: operation % is not available', p_fn; end if;
  for i in 1..pr.pronargs loop
    an := pr.proargnames[i]; at := pr.proargtypes[i - 1];
    if not (p_args ? an) and not (p_args ? regexp_replace(an, '^p_', '')) then continue; end if;
    if not (p_args ? an) then p_args := p_args || jsonb_build_object(an, p_args->regexp_replace(an, '^p_', '')); end if;
    select t.typcategory, format_type(t.oid, null) into tcat, tname from pg_type t where t.oid = at;
    call := call || case when call = '' then '' else ', ' end || quote_ident(an) || ' => ' ||
      case when tname = 'jsonb' then format('($1->%L)', an)
           when tcat = 'A' then format('(select case when jsonb_typeof($1->%1$L) = ''array'' then array(select jsonb_array_elements_text($1->%1$L))::%2$s end)', an, tname)
           else format('nullif($1->>%L, '''')::%s', an, tname) end;
  end loop;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', k.user_id, 'role', 'authenticated', 'email', em, 'aud', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', k.user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.email', coalesce(em,''), true);
  perform set_config('outreach.key_role', k.role::text, true);
  perform set_config('outreach.key_clients', array_to_string(k.client_ids, ','), true);

  if pr.proretset or exists (select 1 from pg_type t where t.oid = pr.prorettype and t.typtype = 'c') or pr.prorettype = 'record'::regtype then
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I(%s) t', pr.proname, call) into res using p_args;
  else
    execute format('select to_jsonb(public.%I(%s))', pr.proname, call) into res using p_args;
  end if;
  -- leave no trace of the impersonation for the rest of the transaction
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.email', '', true); perform set_config('outreach.key_role', '', true); perform set_config('outreach.key_clients', '', true);
  return res;
end $$;
revoke execute on function outreach_api_dispatch(uuid,text,jsonb) from public, anon, authenticated;

create or replace function outreach_api_idempotent(p_key_id uuid, p_idem text, p_hash text, p_status int default null, p_response jsonb default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_api_idempotency%rowtype; ins int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_status is not null then
    update outreach_api_idempotency set status = p_status, response = p_response where key_id = p_key_id and idem_key = p_idem;
    return null;
  end if;
  insert into outreach_api_idempotency(key_id, idem_key, request_hash) values (p_key_id, p_idem, p_hash) on conflict do nothing;
  get diagnostics ins = row_count;
  select * into r from outreach_api_idempotency where key_id = p_key_id and idem_key = p_idem;
  if r.request_hash <> p_hash then return jsonb_build_object('conflict', true); end if;
  if ins = 1 then return jsonb_build_object('fresh', true); end if;                      -- only the request that inserted the row runs
  if r.status is not null then return jsonb_build_object('replay', true, 'status', r.status, 'response', r.response); end if;
  if r.created_at < now() - interval '60 seconds' then                                    -- the first call died before storing a result: let this one take over
    update outreach_api_idempotency set created_at = now() where key_id = p_key_id and idem_key = p_idem;
    return jsonb_build_object('fresh', true);
  end if;
  return jsonb_build_object('in_progress', true);
end $$;
revoke execute on function outreach_api_idempotent(uuid,text,text,int,jsonb) from public, anon, authenticated;

-- ---- read RPCs for the API (also usable by the connector). All go through outreach_require + client visibility.
create or replace function outreach_api_context(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return jsonb_build_object(
    'workspace', (select jsonb_build_object('id', id, 'name', name, 'slug', slug, 'plan', plan, 'timezone', outreach_ws_tz(id)) from outreach_workspaces where id = p_ws),
    'role', outreach_role_in(p_ws),
    'clients', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from outreach_clients where workspace_id = p_ws and outreach_client_visible(p_ws, id)),
    'stages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'position', position) order by position), '[]'::jsonb) from outreach_stages where workspace_id = p_ws),
    'tags', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name) order by name), '[]'::jsonb) from outreach_tags where workspace_id = p_ws),
    'lists', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'client_id', client_id) order by name), '[]'::jsonb) from outreach_lists where workspace_id = p_ws and outreach_client_visible(p_ws, client_id)));
end $$;

create or replace function outreach_api_leads(p_ws uuid, p_filters jsonb default '{}', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare res jsonb; total bigint; lim int := least(greatest(coalesce(p_limit,50),1),200); f jsonb := coalesce(p_filters,'{}'::jsonb);
begin
  perform outreach_require(p_ws, 'client_viewer');
  with base as (
    select l.* from outreach_leads l
     where l.workspace_id = p_ws and outreach_client_visible(p_ws, l.client_id)
       and ((f->>'q') is null or l.full_name ilike '%' || (f->>'q') || '%' or l.company ilike '%' || (f->>'q') || '%' or l.headline ilike '%' || (f->>'q') || '%' or l.email_work::text ilike '%' || (f->>'q') || '%')
       and ((f->>'client_id') is null or l.client_id = (f->>'client_id')::uuid) and ((f->>'list_id') is null or l.list_id = (f->>'list_id')::uuid)
       and ((f->>'stage_id') is null or l.stage_id = (f->>'stage_id')::uuid) and ((f->>'source') is null or l.source = f->>'source')
       and ((f->>'email') is null or l.email_work = (f->>'email')::citext or l.email_personal = (f->>'email')::citext)
       and ((f->>'public_identifier') is null or l.public_identifier = lower(f->>'public_identifier')::citext)
       and ((f->>'tag_id') is null or exists (select 1 from outreach_lead_tags lt where lt.lead_id = l.id and lt.tag_id = (f->>'tag_id')::uuid))
       and ((f->>'updated_since') is null or l.updated_at >= (f->>'updated_since')::timestamptz)
       and ((f->>'replied') is null or (l.last_replied_at is not null) = (f->>'replied')::boolean)
       and ((f->>'enriched') is null or (l.enriched_at is not null) = (f->>'enriched')::boolean))
  select (select count(*) from base), coalesce((select jsonb_agg(to_jsonb(x) - 'workspace_id' order by x.created_at desc) from (select * from base order by created_at desc limit lim offset greatest(coalesce(p_offset,0),0)) x), '[]'::jsonb)
    into total, res;
  return jsonb_build_object('data', res, 'total', total, 'limit', lim, 'offset', greatest(coalesce(p_offset,0),0), 'has_more', total > greatest(coalesce(p_offset,0),0) + lim);
end $$;

create or replace function outreach_api_lead(p_lead uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(l.workspace_id, 'client_viewer');
  if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return to_jsonb(l) - 'workspace_id' || jsonb_build_object(
    'tags', (select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name)), '[]'::jsonb) from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = p_lead),
    'profile', (select to_jsonb(p) - 'workspace_id' - 'lead_id' from outreach_lead_profiles p where p.lead_id = p_lead),
    'senders', (select coalesce(jsonb_agg(jsonb_build_object('sender_id', x.sender_id, 'relation', x.relation, 'invite_sent_at', x.invite_sent_at, 'invite_accepted_at', x.invite_accepted_at, 'last_outbound_at', x.last_outbound_at, 'last_inbound_at', x.last_inbound_at)), '[]'::jsonb) from outreach_lead_sender_state x where x.lead_id = p_lead),
    'enrollments', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'sender_id', e.sender_id, 'status', e.status, 'current_node_id', e.current_node_id, 'created_at', e.created_at, 'exit_reason', e.exit_reason) order by e.created_at desc), '[]'::jsonb) from outreach_enrollments e where e.lead_id = p_lead),
    'suppressed', outreach_lead_suppression_reason(l, l.client_id, null));
end $$;

create or replace function outreach_api_sequences(p_ws uuid, p_status text default null, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'status', q.status, 'client_id', q.client_id, 'head_version', q.head_version, 'sender_pool', q.sender_pool, 'assignment', q.assignment,
            'stalled', q.stalled_at is not null, 'stalled_reason', q.stalled_reason, 'throttled_reason', q.throttled_reason, 'created_at', q.created_at, 'updated_at', q.updated_at,
            'live', (select count(*) from outreach_enrollments e where e.sequence_id = q.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused'))) order by q.created_at desc), '[]'::jsonb)
            from outreach_sequences q where q.workspace_id = p_ws and outreach_client_visible(p_ws, q.client_id) and (p_status is null or q.status::text = p_status) and (p_client is null or q.client_id = p_client));
end $$;

create or replace function outreach_api_sequence(p_sequence uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype;
begin
  select * into q from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(q.workspace_id, 'client_viewer');
  if not outreach_client_visible(q.workspace_id, q.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return to_jsonb(q) - 'workspace_id' - 'draft_graph' || jsonb_build_object('has_draft', q.draft_graph is not null,
    'node_stats', (select coalesce(jsonb_agg(to_jsonb(n) - 'sequence_id'), '[]'::jsonb) from outreach_node_stats n where n.sequence_id = p_sequence),
    'rules', (select coalesce(jsonb_agg(to_jsonb(r) - 'workspace_id'), '[]'::jsonb) from outreach_auto_enroll_rules r where r.sequence_id = p_sequence));
end $$;

create or replace function outreach_api_enrollments(p_ws uuid, p_filters jsonb default '{}', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare res jsonb; total bigint; lim int := least(greatest(coalesce(p_limit,50),1),200); f jsonb := coalesce(p_filters,'{}'::jsonb);
begin
  perform outreach_require(p_ws, 'client_viewer');
  with base as (
    select e.*, q.name as sequence_name, l.full_name as lead_name from outreach_enrollments e join outreach_sequences q on q.id = e.sequence_id join outreach_leads l on l.id = e.lead_id
     where e.workspace_id = p_ws and outreach_client_visible(p_ws, q.client_id)
       and ((f->>'sequence_id') is null or e.sequence_id = (f->>'sequence_id')::uuid) and ((f->>'lead_id') is null or e.lead_id = (f->>'lead_id')::uuid)
       and ((f->>'sender_id') is null or e.sender_id = (f->>'sender_id')::uuid) and ((f->>'status') is null or e.status::text = f->>'status')
       and ((f->>'live') is null or (e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) = (f->>'live')::boolean))
  select (select count(*) from base), coalesce((select jsonb_agg(to_jsonb(x) - 'workspace_id' order by x.created_at desc) from (select * from base order by created_at desc limit lim offset greatest(coalesce(p_offset,0),0)) x), '[]'::jsonb)
    into total, res;
  return jsonb_build_object('data', res, 'total', total, 'limit', lim, 'offset', greatest(coalesce(p_offset,0),0), 'has_more', total > greatest(coalesce(p_offset,0),0) + lim);
end $$;

create or replace function outreach_api_threads(p_ws uuid, p_filters jsonb default '{}', p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare res jsonb; total bigint; lim int := least(greatest(coalesce(p_limit,50),1),200); f jsonb := coalesce(p_filters,'{}'::jsonb);
begin
  perform outreach_require(p_ws, 'client_viewer');
  with base as (
    select c.* from outreach_chats c
     where c.workspace_id = p_ws and outreach_client_visible(p_ws, c.client_id)
       and ((f->>'intent') is null or c.intent::text = f->>'intent') and ((f->>'sender_id') is null or c.sender_id = (f->>'sender_id')::uuid)
       and ((f->>'lead_id') is null or c.lead_id = (f->>'lead_id')::uuid) and ((f->>'unread') is null or c.unread = (f->>'unread')::boolean)
       and ((f->>'waiting_on_us') is null or (c.last_direction = 'in') = (f->>'waiting_on_us')::boolean) and ((f->>'archived') is null or c.archived = (f->>'archived')::boolean)
       and ((f->>'sequence_id') is null or c.id in (select outreach_sequence_chat_ids((f->>'sequence_id')::uuid)))
       and ((f->>'since') is null or c.last_message_at >= (f->>'since')::timestamptz))
  select (select count(*) from base), coalesce((select jsonb_agg(to_jsonb(x) - 'workspace_id' order by x.last_message_at desc nulls last) from (select * from base order by last_message_at desc nulls last limit lim offset greatest(coalesce(p_offset,0),0)) x), '[]'::jsonb)
    into total, res;
  return jsonb_build_object('data', res, 'total', total, 'limit', lim, 'offset', greatest(coalesce(p_offset,0),0), 'has_more', total > greatest(coalesce(p_offset,0),0) + lim);
end $$;

create or replace function outreach_api_thread(p_chat uuid, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return to_jsonb(c) - 'workspace_id' || jsonb_build_object(
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'text', m.text, 'sent_at', m.sent_at, 'intent', m.intent, 'summary', m.summary, 'is_first_reply', m.is_first_reply,
                   'opens', m.opens, 'clicks', m.clicks, 'attribution', (select to_jsonb(t) - 'message_id' from outreach_thread_attribution(p_chat) t where t.message_id = m.id)) order by m.sent_at), '[]'::jsonb)
                   from (select * from outreach_messages where chat_id = p_chat and deleted_at is null order by sent_at desc limit least(greatest(p_limit,1),500)) m));
end $$;

create or replace function outreach_api_senders(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason', s.status_reason, 'client_id', s.client_id,
            'health', s.health_score, 'warmup_level', s.warmup_level, 'timezone', s.timezone, 'paused_until', s.paused_until, 'invite_blocked_until', s.invite_blocked_until,
            'running_dry', s.running_dry_at is not null, 'is_premium', s.is_premium, 'today', outreach_sender_today(s.id)) order by s.display_name), '[]'::jsonb)
            from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null and outreach_client_visible(p_ws, s.client_id));
end $$;

create or replace function outreach_api_sender(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'status_reason', s.status_reason, 'client_id', s.client_id, 'health', s.health_score,
    'health_breakdown', s.health_breakdown, 'warmup_level', s.warmup_level, 'timezone', s.timezone, 'schedule', s.schedule, 'manual_caps', s.manual_caps, 'paused_until', s.paused_until,
    'invite_blocked_until', s.invite_blocked_until, 'connected_at', s.connected_at, 'today', outreach_sender_today(s.id),
    'capacity', (select coalesce(jsonb_object_agg(c.action_type, outreach_effective_cap(s.id, c.action_type)), '{}'::jsonb) from outreach_platform_ceilings c));
end $$;

create or replace function outreach_api_webhooks(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'manager');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', w.id, 'url', w.url, 'events', w.events, 'active', w.active, 'failures', w.failures, 'created_at', w.created_at) order by w.created_at), '[]'::jsonb)
            from outreach_outbound_webhooks w where w.workspace_id = p_ws);
end $$;

create or replace function outreach_create_webhook(p_ws uuid, p_url text, p_events text[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_outbound_webhooks%rowtype;
begin
  perform outreach_require(p_ws, 'manager');
  if p_url !~ '^https://[^\s]+$' then raise exception 'E_PAYLOAD_INVALID: url must be https'; end if;
  if (select count(*) from outreach_outbound_webhooks where workspace_id = p_ws) >= 20 then raise exception 'E_TOO_MANY: at most 20 webhooks'; end if;
  insert into outreach_outbound_webhooks(workspace_id, url, events) values (p_ws, p_url, coalesce(p_events, array['*'])) returning * into w;
  perform outreach_audit(p_ws, 'webhook.created', 'webhook', w.id::text, jsonb_build_object('url', p_url, 'events', p_events));
  return jsonb_build_object('id', w.id, 'url', w.url, 'events', w.events, 'secret', w.secret, 'note', 'Deliveries are signed: x-signature = HMAC-SHA256(secret, body).');
end $$;

-- managers can create and delete webhooks, so they can also switch one back on after it was auto-disabled (50 failures)
create or replace function outreach_set_webhook_active(p_id uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_outbound_webhooks where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  update outreach_outbound_webhooks set active = p_active, failures = case when p_active then 0 else failures end where id = p_id;
  perform outreach_audit(ws, 'webhook.' || case when p_active then 'enabled' else 'disabled' end, 'webhook', p_id::text);
end $$;
grant execute on function outreach_set_webhook_active(uuid, boolean) to authenticated, service_role;

create or replace function outreach_delete_webhook(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_outbound_webhooks where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  delete from outreach_outbound_webhooks where id = p_id;
end $$;

create or replace function outreach_api_deliveries(p_ws uuid, p_webhook uuid default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'manager');
  return (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from (
            select d.id, d.webhook_id, d.event, d.status, d.attempts, d.created_at, d.delivered_at, d.last_error, d.replay_of, d.payload
              from outreach_outbound_webhook_deliveries d where d.workspace_id = p_ws and (p_webhook is null or d.webhook_id = p_webhook) order by d.id desc limit least(greatest(p_limit,1),200)) x);
end $$;

-- "Event-based webhooks cannot be re-triggered" (GetSales). Ours can.
create or replace function outreach_replay_delivery(p_delivery bigint) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
declare d outreach_outbound_webhook_deliveries%rowtype; nid bigint;
begin
  select * into d from outreach_outbound_webhook_deliveries where id = p_delivery;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(d.workspace_id, 'manager');
  if not exists (select 1 from outreach_outbound_webhooks w where w.id = d.webhook_id and w.active) then raise exception 'E_PAYLOAD_INVALID: the webhook is gone or inactive'; end if;
  insert into outreach_outbound_webhook_deliveries(webhook_id, workspace_id, event, payload, replay_of)
  values (d.webhook_id, d.workspace_id, d.event, d.payload || jsonb_build_object('replayed', true, 'replay_of', d.id), d.id) returning id into nid;
  perform outreach_audit(d.workspace_id, 'webhook.replayed', 'webhook', d.webhook_id::text, jsonb_build_object('delivery', d.id, 'new_delivery', nid));
  return nid;
end $$;

-- -----------------------------------------------------------------------------
-- Item 22 — CRM sync: settings + the rule that decides who gets synced
-- -----------------------------------------------------------------------------
create or replace function outreach_integration_save(p_id uuid, p_settings jsonb default null, p_field_mapping jsonb default null, p_stage_mapping jsonb default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_integrations%rowtype;
begin
  select * into i from outreach_integrations where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if p_settings ? 'sync_rule' and (p_settings->>'sync_rule') not in ('replied','interested','enrolled') then raise exception 'E_PAYLOAD_INVALID: sync_rule must be replied, interested or enrolled'; end if;
  update outreach_integrations set settings = settings || coalesce(p_settings, '{}'::jsonb), field_mapping = coalesce(p_field_mapping, field_mapping), stage_mapping = coalesce(p_stage_mapping, stage_mapping) where id = p_id;
  perform outreach_audit(i.workspace_id, 'integration.settings', 'integration', p_id::text, jsonb_build_object('settings', p_settings));
end $$;

create or replace function outreach_integration_disconnect(p_id uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_integrations%rowtype;
begin
  select * into i from outreach_integrations where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  update outreach_integrations set status = 'disconnected', last_error = null where id = p_id;
  delete from outreach_integration_secrets where integration_id = p_id;
  -- blacklist entries that came from the CRM go with it; nothing else is deleted
  delete from outreach_suppressions where workspace_id = i.workspace_id and source = 'crm:' || i.provider;
  perform outreach_audit(i.workspace_id, 'integration.disconnected', 'integration', p_id::text, jsonb_build_object('provider', i.provider));
end $$;

-- Expandi's mistake is syncing everyone. Default: only leads who replied.
create or replace function outreach_crm_should_sync(p_integration uuid, p_lead uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select case coalesce(i.settings->>'sync_rule','replied')
           when 'enrolled' then exists (select 1 from outreach_enrollments e where e.lead_id = p_lead)
           when 'interested' then exists (select 1 from outreach_lead_milestones m where m.lead_id = p_lead and m.kind in ('interested','meeting','won'))
           else exists (select 1 from outreach_leads l where l.id = p_lead and l.last_replied_at is not null) end
         or exists (select 1 from outreach_crm_links k where k.integration_id = p_integration and k.lead_id = p_lead)   -- once linked, keep it up to date
    from outreach_integrations i where i.id = p_integration
$$;
revoke execute on function outreach_crm_should_sync(uuid,uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 23 — white-label
-- -----------------------------------------------------------------------------
create or replace function outreach_set_branding(p_ws uuid, p_branding jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare b jsonb;
begin
  perform outreach_require(p_ws, 'owner');
  b := jsonb_strip_nulls(jsonb_build_object(
    'product_name', nullif(left(trim(coalesce(p_branding->>'product_name','')), 60), ''),
    'logo_url', case when (p_branding->>'logo_url') ~ '^https://' then p_branding->>'logo_url' end,
    'accent', case when (p_branding->>'accent') ~ '^#[0-9a-fA-F]{6}$' then p_branding->>'accent' end,
    'support_email', case when (p_branding->>'support_email') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(p_branding->>'support_email') end,
    'help_url', case when (p_branding->>'help_url') ~ '^https://' then p_branding->>'help_url' end,
    'docs_url', case when (p_branding->>'docs_url') ~ '^https://' then p_branding->>'docs_url' end,
    'email_from_name', nullif(left(trim(coalesce(p_branding->>'email_from_name','')), 60), ''),
    'email_from_address', case when (p_branding->>'email_from_address') ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then lower(p_branding->>'email_from_address') end,
    'hide_platform_name', coalesce((p_branding->>'hide_platform_name')::boolean, false)));
  update outreach_workspaces set branding = b where id = p_ws;
  perform outreach_audit(p_ws, 'workspace.branding', 'workspace', p_ws::text, b);
  return b;
end $$;

-- safe subset for anyone who may open the portal, incl. before login (custom domain) and on the invite page
create or replace function outreach__public_branding(p_ws uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('workspace_name', w.name) || (coalesce(w.branding,'{}'::jsonb) - 'email_from_address' - 'email_from_name') from outreach_workspaces w where w.id = p_ws and w.deleted_at is null
$$;
revoke execute on function outreach__public_branding(uuid) from public, anon, authenticated;

create or replace function outreach_branding_for_host(p_hostname text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select outreach__public_branding(d.workspace_id) || jsonb_build_object('workspace_id', d.workspace_id, 'client_id', d.client_id, 'portal_only', true)
    from outreach_workspace_domains d where d.hostname = lower(p_hostname)::citext and d.status = 'active'
$$;
grant execute on function outreach_branding_for_host(text) to anon, authenticated, service_role;

create or replace function outreach_branding_for_invite(p_token text) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select outreach__public_branding(i.workspace_id) from outreach_invitations i where i.token = p_token
$$;
grant execute on function outreach_branding_for_invite(text) to anon, authenticated, service_role;

create or replace function outreach_branding(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select case when outreach_role_in(p_ws) in ('owner','manager') then jsonb_build_object('workspace_name', w.name) || coalesce(w.branding,'{}'::jsonb) else outreach__public_branding(p_ws) end
            from outreach_workspaces w where w.id = p_ws);
end $$;

create or replace function outreach_add_domain(p_ws uuid, p_hostname text, p_client uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text := lower(trim(p_hostname)); d outreach_workspace_domains%rowtype; target text;
begin
  perform outreach_require(p_ws, 'owner');
  if h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' then raise exception 'E_PAYLOAD_INVALID: enter a hostname such as reports.agency.com'; end if;
  if p_client is not null and not exists (select 1 from outreach_clients where id = p_client and workspace_id = p_ws) then raise exception 'E_NOT_FOUND: client'; end if;
  if (select count(*) from outreach_workspace_domains where workspace_id = p_ws) >= 10 then raise exception 'E_TOO_MANY: at most 10 domains'; end if;
  select value #>> '{}' into target from outreach_flags where key = 'portal_cname_target';
  insert into outreach_workspace_domains(workspace_id, client_id, hostname, cname_target, created_by) values (p_ws, p_client, h, coalesce(target, 'cname.vercel-dns.com'), auth.uid())
  returning * into d;
  perform outreach_audit(p_ws, 'workspace.domain_added', 'workspace', p_ws::text, jsonb_build_object('hostname', h));
  return jsonb_build_object('id', d.id, 'hostname', d.hostname, 'status', d.status,
    'dns', jsonb_build_array(jsonb_build_object('type','CNAME','name', d.hostname, 'value', d.cname_target),
                             jsonb_build_object('type','TXT','name', '_outreach-verify.' || d.hostname, 'value', d.verification_token)));
exception when unique_violation then raise exception 'E_PAYLOAD_INVALID: this hostname is already in use';
end $$;

create or replace function outreach_domains(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'manager');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'hostname', d.hostname, 'client_id', d.client_id, 'status', d.status, 'verified_at', d.verified_at, 'last_checked_at', d.last_checked_at, 'last_error', d.last_error,
            'dns', jsonb_build_array(jsonb_build_object('type','CNAME','name', d.hostname, 'value', d.cname_target), jsonb_build_object('type','TXT','name', '_outreach-verify.' || d.hostname, 'value', d.verification_token))) order by d.created_at), '[]'::jsonb)
            from outreach_workspace_domains d where d.workspace_id = p_ws);
end $$;

create or replace function outreach_remove_domain(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_workspace_domains where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'owner');
  delete from outreach_workspace_domains where id = p_id;
end $$;

-- -----------------------------------------------------------------------------
-- Item 24 — a booking (Calendly / Cal.com webhook) fills the last funnel stage and ends the sequence cleanly
-- -----------------------------------------------------------------------------
create or replace function outreach_record_booking(p_ws uuid, p_provider text, p_external_id text, p_lead uuid, p_email text, p_status text, p_starts_at timestamptz, p_payload jsonb, p_sender uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare lid uuid; bid uuid; st outreach_stages%rowtype; cur_pos int; r record; sid uuid := p_sender; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select id into lid from outreach_leads where id = p_lead and workspace_id = p_ws;
  if lid is null and nullif(p_email,'') is not null then
    select id into lid from outreach_leads where workspace_id = p_ws and (email_work = lower(p_email)::citext or email_personal = lower(p_email)::citext) order by updated_at desc limit 1;
  end if;
  if sid is null and lid is not null then select sender_id into sid from outreach_enrollments where lead_id = lid order by created_at desc limit 1; end if;
  insert into outreach_booking_events(workspace_id, lead_id, sender_id, provider, external_id, status, invitee_email, starts_at, payload)
  values (p_ws, lid, sid, p_provider, p_external_id, coalesce(p_status,'booked'), nullif(lower(p_email),'')::citext, p_starts_at, p_payload)
  on conflict (provider, external_id) do update set status = excluded.status, starts_at = coalesce(excluded.starts_at, outreach_booking_events.starts_at), lead_id = coalesce(outreach_booking_events.lead_id, excluded.lead_id)
  returning id into bid;
  if lid is null or coalesce(p_status,'booked') <> 'booked' then return jsonb_build_object('booking_id', bid, 'matched', lid is not null); end if;

  perform outreach_record_milestone(lid, 'meeting', 'booking', null, null);
  select * into st from outreach_stages where workspace_id = p_ws and kind = 'meeting' order by position limit 1;
  if found then
    select s2.position into cur_pos from outreach_leads l left join outreach_stages s2 on s2.id = l.stage_id where l.id = lid;
    if cur_pos is null or cur_pos < st.position then update outreach_leads set stage_id = st.id where id = lid; end if;
  end if;
  for r in select id from outreach_enrollments where lead_id = lid and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    perform outreach_complete_enrollment(r.id, 'completed', 'meeting_booked'); n := n + 1;
  end loop;
  perform outreach_emit_event(p_ws, 'meeting.booked', jsonb_build_object('lead_id', lid, 'sender_id', sid, 'provider', p_provider, 'starts_at', p_starts_at, 'booking_id', bid, 'enrollments_ended', n));
  return jsonb_build_object('booking_id', bid, 'matched', true, 'lead_id', lid, 'enrollments_ended', n);
end $$;
revoke execute on function outreach_record_booking(uuid,text,text,uuid,text,text,timestamptz,jsonb,uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 20 — email depth
-- -----------------------------------------------------------------------------
-- Which mailbox sends this email step? Sticky per contact; otherwise the least-used mailbox today (an even split).
create or replace function outreach_pick_mailbox(p_enrollment uuid, p_node jsonb) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare e outreach_enrollments%rowtype; pool uuid[]; cand uuid[]; chosen uuid; cfg jsonb := coalesce(p_node->'config','{}'::jsonb);
begin
  select * into e from outreach_enrollments where id = p_enrollment;
  if not found then return null; end if;
  if nullif(cfg->>'mailbox_sender_id','') is not null then cand := array[(cfg->>'mailbox_sender_id')::uuid];
  elsif jsonb_typeof(cfg->'mailbox_pool') = 'array' and jsonb_array_length(cfg->'mailbox_pool') > 0 then select array_agg(x::uuid) into cand from jsonb_array_elements_text(cfg->'mailbox_pool') x;
  else
    select array_agg(s.id) into cand from outreach_senders s where s.parent_sender_id = e.sender_id and s.provider <> 'LINKEDIN' and s.deleted_at is null;   -- the person's own mailboxes first
    if cand is null then
      select sender_pool into pool from outreach_sequences where id = e.sequence_id;
      select array_agg(s.id) into cand from outreach_senders s where s.id = any(pool) and s.provider <> 'LINKEDIN' and s.deleted_at is null;
    end if;
  end if;
  if cand is null then return null; end if;
  select array_agg(s.id) into cand from outreach_senders s where s.id = any(cand) and s.workspace_id = e.workspace_id and s.status = 'ok' and s.deleted_at is null and (s.paused_until is null or s.paused_until < now());
  if cand is null then return null; end if;
  -- a contact who has been emailed before always gets the same mailbox
  select x.sender_id into chosen from outreach_lead_sender_state x where x.lead_id = e.lead_id and x.sender_id = any(cand) and x.last_outbound_at is not null order by x.last_outbound_at desc limit 1;
  if chosen is not null then return chosen; end if;
  select c into chosen from unnest(cand) c
   order by (select count(*) from outreach_actions a where a.sender_id = c and a.action_type = 'email' and a.status in ('queued','reserved','sent') and a.scheduled_for > now() - interval '20 hours'), c limit 1;
  return chosen;
end $$;
revoke execute on function outreach_pick_mailbox(uuid,jsonb) from public, anon, authenticated;

create or replace function outreach_unsubscribe_lead(p_lead uuid, p_source text default 'link') returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into l from outreach_leads where id = p_lead;
  if not found then return false; end if;
  if l.unsubscribed then return true; end if;
  update outreach_leads set unsubscribed = true where id = p_lead;       -- the existing trigger exits every sequence and cancels queued actions
  perform outreach_audit(l.workspace_id, 'lead.unsubscribed', 'lead', p_lead::text, jsonb_build_object('source', p_source), 'system');
  perform outreach_emit_event(l.workspace_id, 'lead.unsubscribed', jsonb_build_object('lead_id', p_lead, 'source', p_source));
  return true;
end $$;
revoke execute on function outreach_unsubscribe_lead(uuid,text) from public, anon, authenticated;

create or replace function outreach_add_tracking_domain(p_ws uuid, p_hostname text, p_sender uuid default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare h text := lower(trim(p_hostname)); d outreach_tracking_domains%rowtype; pl text;
begin
  perform outreach_require(p_ws, 'manager');
  select plan into pl from outreach_workspaces where id = p_ws;
  if pl not in ('agency','agency_plus') and (select coalesce(branding,'{}'::jsonb) = '{}'::jsonb from outreach_workspaces where id = p_ws) then
    raise exception 'E_PLAN_REQUIRED: custom tracking domains are part of the agency and white-label plans (each domain is approved by hand on the provider side)';
  end if;
  if h !~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$' then raise exception 'E_PAYLOAD_INVALID: enter a hostname such as link.agency.com'; end if;
  if p_sender is not null and not exists (select 1 from outreach_senders where id = p_sender and workspace_id = p_ws and provider <> 'LINKEDIN') then raise exception 'E_NOT_FOUND: mailbox'; end if;
  insert into outreach_tracking_domains(workspace_id, sender_id, hostname, created_by) values (p_ws, p_sender, h, auth.uid()) returning * into d;
  return jsonb_build_object('id', d.id, 'hostname', d.hostname, 'status', d.status, 'dns', jsonb_build_object('type','CNAME','name', d.hostname, 'value', d.cname_target),
    'next', 'Add the CNAME. We check it automatically; once it resolves the domain moves to "awaiting approval" while the email provider authorises it. Until it is active the default tracking domain is used.');
exception when unique_violation then raise exception 'E_PAYLOAD_INVALID: this hostname is already registered';
end $$;

create or replace function outreach_remove_tracking_domain(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_tracking_domains where id = p_id;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  delete from outreach_tracking_domains where id = p_id;
end $$;

-- the executor asks this at send time: only an ACTIVE domain is ever passed to the provider
create or replace function outreach_tracking_domain_for(p_sender uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select d.hostname::text from outreach_tracking_domains d join outreach_senders s on s.id = p_sender and s.workspace_id = d.workspace_id
   where d.status = 'active' and (d.sender_id = p_sender or d.sender_id is null) order by (d.sender_id is not null) desc limit 1
$$;
revoke execute on function outreach_tracking_domain_for(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 18 — lead sources
-- -----------------------------------------------------------------------------
create or replace function outreach_save_import_schedule(p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid := (p->>'workspace_id')::uuid; sid uuid; k outreach_import_kind_t := (p->>'kind')::outreach_import_kind_t;
begin
  perform outreach_require(ws, 'member');
  if k not in ('search_url','post_engagement','sn_saved_search','sn_lead_list','relations','company_people') then raise exception 'E_PAYLOAD_INVALID: this source cannot repeat'; end if;
  if (p->>'cadence') not in ('daily','weekly','monthly') then raise exception 'E_PAYLOAD_INVALID: cadence must be daily, weekly or monthly'; end if;
  if nullif(p->>'sender_id','') is null or not exists (select 1 from outreach_senders where id = (p->>'sender_id')::uuid and workspace_id = ws and provider = 'LINKEDIN' and deleted_at is null) then raise exception 'E_NOT_FOUND: sender'; end if;
  if (select count(*) from outreach_import_schedules where workspace_id = ws and active) >= 50 then raise exception 'E_TOO_MANY: at most 50 repeating imports'; end if;
  if (p->>'id') is not null then
    update outreach_import_schedules set name = coalesce(p->>'name', name), cadence = p->>'cadence', active = coalesce((p->>'active')::boolean, active), params = coalesce(p->'params', params),
           list_id = nullif(p->>'list_id','')::uuid, enrich = coalesce((p->>'enrich')::boolean, enrich)
     where id = (p->>'id')::uuid and workspace_id = ws returning id into sid;
    if sid is null then raise exception 'E_NOT_FOUND'; end if;
    return sid;
  end if;
  insert into outreach_import_schedules(workspace_id, client_id, sender_id, name, kind, params, list_id, tag_ids, enrich, cadence, next_run_at, created_by)
  values (ws, nullif(p->>'client_id','')::uuid, (p->>'sender_id')::uuid, coalesce(nullif(p->>'name',''), initcap(replace(k::text,'_',' ')) || ' (' || (p->>'cadence') || ')'), k, coalesce(p->'params','{}'::jsonb),
          nullif(p->>'list_id','')::uuid, coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(coalesce(p->'tag_ids','[]'::jsonb)) x), '{}'), coalesce((p->>'enrich')::boolean, false), p->>'cadence',
          now() + case p->>'cadence' when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end, auth.uid())
  returning id into sid;
  return sid;
end $$;

-- cron: turn due schedules into ordinary import jobs (same budgets, same working hours). Leads are de-duplicated on upsert, so only new people are added.
create or replace function outreach_run_import_schedules() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare s record; jid uuid; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for s in select * from outreach_import_schedules where active and next_run_at <= now() order by next_run_at limit 50 for update skip locked loop
    if exists (select 1 from outreach_import_jobs j where j.schedule_id = s.id and j.status in ('queued','running')) then
      update outreach_import_schedules set next_run_at = now() + interval '6 hours' where id = s.id;   -- the previous run is still going
      continue;
    end if;
    insert into outreach_import_jobs(workspace_id, client_id, sender_id, kind, params, list_id, tag_ids, enrich, schedule_id, created_by)
    values (s.workspace_id, s.client_id, s.sender_id, s.kind, s.params || jsonb_build_object('repeat_run', s.runs + 1), s.list_id, s.tag_ids, s.enrich, s.id, s.created_by) returning id into jid;
    update outreach_import_schedules set last_job_id = jid, last_run_at = now(), runs = runs + 1,
           next_run_at = now() + case cadence when 'daily' then interval '1 day' when 'weekly' then interval '7 days' else interval '1 month' end where id = s.id;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function outreach_run_import_schedules() from public, anon, authenticated;

-- "Create leads from these conversations": pure database work, no LinkedIn call
create or replace function outreach_import_conversations(p_job uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare j outreach_import_jobs%rowtype; c record; r record; created int := 0; linked int := 0; parts text[];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into j from outreach_import_jobs where id = p_job;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  for c in select ch.* from outreach_chats ch where ch.workspace_id = j.workspace_id and ch.lead_id is null and ch.provider = 'LINKEDIN'
             and (j.sender_id is null or ch.sender_id = j.sender_id) and (ch.attendee_provider_id is not null or ch.attendee_public_identifier is not null)
             and (coalesce((j.params->>'only_replied')::boolean, false) = false or exists (select 1 from outreach_messages m where m.chat_id = ch.id and m.direction = 'in'))
           order by ch.last_message_at desc nulls last limit least(coalesce((j.params->>'max_results')::int, 2000), 5000) loop
    parts := regexp_split_to_array(trim(coalesce(c.attendee_name,'')), '\s+');
    select * into r from outreach_upsert_lead(j.workspace_id, jsonb_build_object('provider_id', c.attendee_provider_id, 'public_identifier', c.attendee_public_identifier, 'full_name', c.attendee_name,
       'first_name', parts[1], 'last_name', nullif(array_to_string(parts[2:], ' '), ''), 'picture_url', c.attendee_picture_url, 'client_id', coalesce(j.client_id, c.client_id), 'list_id', j.list_id), 'conversations', j.id);
    if r.id is null then continue; end if;
    update outreach_chats set lead_id = r.id where id = c.id;
    insert into outreach_lead_sender_state(lead_id, sender_id, relation, unipile_chat_id, last_inbound_at, last_outbound_at)
    values (r.id, c.sender_id, 'first', c.unipile_chat_id,
            (select max(m.sent_at) from outreach_messages m where m.chat_id = c.id and m.direction = 'in'), (select max(m.sent_at) from outreach_messages m where m.chat_id = c.id and m.direction = 'out'))
    on conflict (lead_id, sender_id) do update set unipile_chat_id = coalesce(outreach_lead_sender_state.unipile_chat_id, excluded.unipile_chat_id), relation = 'first';
    if array_length(j.tag_ids,1) > 0 then insert into outreach_lead_tags(lead_id, tag_id) select r.id, unnest(j.tag_ids) on conflict do nothing; end if;
    if r.created then created := created + 1; else linked := linked + 1; end if;
  end loop;
  update outreach_import_jobs set status = 'done', fetched = created + linked, created_leads = created, updated_leads = linked, finished_at = now(), next_run_at = null, error = null where id = p_job;
  return jsonb_build_object('created', created, 'linked', linked);
end $$;
revoke execute on function outreach_import_conversations(uuid) from public, anon, authenticated;

-- CSV update mode: match on LinkedIn URL / email and change ONLY the chosen columns. Never creates, never blanks.
create or replace function outreach_update_lead_fields(p_ws uuid, p_match jsonb, p_fields jsonb, p_allowed text[])
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare lid uuid; k text; v text; cust jsonb := '{}';
  cols text[] := array['first_name','last_name','full_name','headline','company','title','location','email_work','email_personal','phone','company_domain'];
begin
  if not outreach_is_service() then perform outreach_require(p_ws, 'member'); end if;
  if nullif(p_match->>'public_identifier','') is not null then select id into lid from outreach_leads where workspace_id = p_ws and public_identifier = lower(p_match->>'public_identifier')::citext; end if;
  if lid is null and nullif(p_match->>'email','') is not null then
    select id into lid from outreach_leads where workspace_id = p_ws and (email_work = lower(p_match->>'email')::citext or email_personal = lower(p_match->>'email')::citext) limit 1;
  end if;
  if lid is null then return false; end if;
  for k, v in select key, value from jsonb_each_text(p_fields) loop
    if not (k = any(p_allowed)) or nullif(trim(v),'') is null then continue; end if;      -- an empty cell never blanks a field
    if k like 'custom.%' then cust := cust || jsonb_build_object(substr(k, 8), v);
    elsif k = any(cols) then execute format('update outreach_leads set %I = $1 where id = $2', k) using (case when k like 'email%' then lower(v) else v end), lid;
    end if;
  end loop;
  if cust <> '{}'::jsonb then update outreach_leads set custom = custom || cust where id = lid; end if;
  return true;
end $$;
revoke execute on function outreach_update_lead_fields(uuid,jsonb,jsonb,text[]) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Items 25 / 26
-- -----------------------------------------------------------------------------
create or replace function outreach_save_voice_clip(p_sequence uuid, p_node_id text, p_sender uuid, p_path text, p_mime text, p_duration numeric, p_size int)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; s outreach_senders%rowtype;
begin
  select * into q from outreach_sequences where id = p_sequence;
  select * into s from outreach_senders where id = p_sender;
  if q.id is null or s.id is null or s.workspace_id <> q.workspace_id then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(q.workspace_id, 'member');
  -- the sender's owner or a manager may record for a sender
  if outreach_role_in(q.workspace_id) not in ('owner','manager') and s.owner_user_id is distinct from auth.uid() and not outreach_is_service() then raise exception 'E_FORBIDDEN: only the sender''s owner or a manager can record for this sender'; end if;
  if p_mime not in ('audio/mp4','audio/m4a','audio/x-m4a','audio/mpeg','audio/ogg','audio/webm','audio/wav','audio/x-wav') then raise exception 'E_PAYLOAD_INVALID: unsupported audio type'; end if;
  if coalesce(p_duration, 0) > 60 then raise exception 'E_PAYLOAD_INVALID: voice notes are limited to 60 seconds'; end if;
  if p_path not like q.workspace_id::text || '/voice/%' then raise exception 'E_PAYLOAD_INVALID: bad storage path'; end if;
  insert into outreach_voice_clips(sequence_id, node_id, sender_id, workspace_id, path, mime, duration_s, size_bytes, created_by)
  values (p_sequence, p_node_id, p_sender, q.workspace_id, p_path, p_mime, p_duration, p_size, auth.uid())
  on conflict (sequence_id, node_id, sender_id) do update set path = excluded.path, mime = excluded.mime, duration_s = excluded.duration_s, size_bytes = excluded.size_bytes, created_by = excluded.created_by, created_at = now();
end $$;

drop policy if exists outreach_voice_upload on storage.objects;
create policy outreach_voice_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-attachments' and (storage.foldername(name))[2] = 'voice'
              and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));
drop policy if exists outreach_voice_update on storage.objects;
create policy outreach_voice_update on storage.objects for update to authenticated
  using (bucket_id = 'outreach-attachments' and (storage.foldername(name))[2] = 'voice'
         and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));

create or replace function outreach_set_lead_email(p_lead uuid, p_email text, p_status text, p_source text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_leads set email_work = coalesce(email_work, lower(p_email)::citext), email_status = p_status,
         custom = custom || jsonb_build_object('email_source', p_source) where id = p_lead and nullif(p_email,'') is not null;
exception when unique_violation then
  update outreach_leads set email_status = p_status, custom = custom || jsonb_build_object('email_found', lower(p_email), 'email_source', p_source) where id = p_lead;
end $$;
revoke execute on function outreach_set_lead_email(uuid,text,text,text) from public, anon, authenticated;

create or replace function outreach_clean_domain(p text) returns text
language sql immutable as $$
  select nullif(regexp_replace(regexp_replace(regexp_replace(lower(trim(coalesce(p,''))), '^https?://', ''), '^www\.', ''), '[/?#].*$', ''), '')
$$;

-- -----------------------------------------------------------------------------
-- Lead writes respect the caller's client scope (members with client_ids, client-scoped API keys). Supersedes 002.
-- Partial update by design: a field you leave out is never blanked. `phone` is now writable.
-- -----------------------------------------------------------------------------
create or replace function outreach_upsert_lead(p_ws uuid, p_lead jsonb, p_source text default null, p_import_job uuid default null)
returns table(id uuid, created boolean)
language plpgsql security definer set search_path = public, extensions, extensions as $$
declare pid citext; ew citext; ep citext; existing uuid; nid uuid; cid uuid; lid uuid; sid uuid;
begin
  if not outreach_is_service() then perform outreach_require(p_ws, 'member'); end if;
  pid := nullif(lower(trim(coalesce(p_lead->>'public_identifier',''))),'')::citext;
  ew := nullif(lower(trim(coalesce(p_lead->>'email_work',''))),'')::citext;
  ep := nullif(lower(trim(coalesce(p_lead->>'email_personal',''))),'')::citext;
  cid := nullif(p_lead->>'client_id','')::uuid;
  lid := nullif(p_lead->>'list_id','')::uuid;
  sid := nullif(p_lead->>'stage_id','')::uuid;
  if pid is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.public_identifier = pid;
  end if;
  if existing is null and (p_lead->>'provider_id') is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.provider_id = p_lead->>'provider_id';
  end if;
  if existing is null and ew is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_work = ew;
  end if;
  if existing is null and ep is not null then
    select l.id into existing from outreach_leads l where l.workspace_id = p_ws and l.email_personal = ep;
  end if;
  -- a client-scoped member (or API key) may not touch another client's lead, however it was matched
  if existing is not null and not outreach_is_service()
     and not outreach_client_visible(p_ws, (select l.client_id from outreach_leads l where l.id = existing)) then
    raise exception 'E_FORBIDDEN: this lead belongs to another client';
  end if;
  if existing is null and pid is null and ew is null and ep is null and (p_lead->>'provider_id') is null then
    raise exception 'E_PAYLOAD_INVALID: lead needs public_identifier or email';
  end if;

  if existing is null and cid is not null and not outreach_is_service() and not outreach_client_visible(p_ws, cid) then
    raise exception 'E_FORBIDDEN: client not visible';
  end if;

  if existing is not null then
    update outreach_leads l set
      public_identifier = coalesce(l.public_identifier, pid),
      provider_id = coalesce(p_lead->>'provider_id', l.provider_id),
      profile_url = coalesce(p_lead->>'profile_url', l.profile_url),
      first_name = coalesce(nullif(p_lead->>'first_name',''), l.first_name),
      last_name = coalesce(nullif(p_lead->>'last_name',''), l.last_name),
      full_name = coalesce(nullif(p_lead->>'full_name',''), l.full_name),
      headline = coalesce(nullif(p_lead->>'headline',''), l.headline),
      company = coalesce(nullif(p_lead->>'company',''), l.company),
      company_id = coalesce(nullif(p_lead->>'company_id',''), l.company_id),
      title = coalesce(nullif(p_lead->>'title',''), l.title),
      location = coalesce(nullif(p_lead->>'location',''), l.location),
      phone = coalesce(nullif(p_lead->>'phone',''), l.phone),
      company_domain = coalesce(outreach_clean_domain(p_lead->>'company_domain'), l.company_domain),
      picture_url = coalesce(nullif(p_lead->>'picture_url',''), l.picture_url),
      email_work = coalesce(l.email_work, ew),
      email_personal = coalesce(l.email_personal, ep),
      is_open_profile = coalesce((p_lead->>'is_open_profile')::boolean, l.is_open_profile),
      custom = l.custom || coalesce(p_lead->'custom','{}'::jsonb),
      list_id = coalesce(lid, l.list_id),
      stage_id = coalesce(sid, l.stage_id),
      client_id = coalesce(l.client_id, cid),
      last_profile_fetch_at = case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else l.last_profile_fetch_at end,
      updated_at = now()
    where l.id = existing;
    id := existing; created := false; return next; return;
  end if;

  insert into outreach_leads(workspace_id, client_id, public_identifier, provider_id, profile_url, first_name, last_name, full_name, headline, company, company_id, title, location, picture_url, phone, company_domain,
    email_work, email_personal, is_open_profile, custom, list_id, stage_id, source, import_job_id, last_profile_fetch_at)
  values (p_ws, cid, pid, p_lead->>'provider_id', p_lead->>'profile_url', nullif(p_lead->>'first_name',''), nullif(p_lead->>'last_name',''),
    coalesce(nullif(p_lead->>'full_name',''), nullif(trim(coalesce(p_lead->>'first_name','') || ' ' || coalesce(p_lead->>'last_name','')),'')),
    nullif(p_lead->>'headline',''), nullif(p_lead->>'company',''), nullif(p_lead->>'company_id',''), nullif(p_lead->>'title',''), nullif(p_lead->>'location',''), nullif(p_lead->>'picture_url',''), nullif(p_lead->>'phone',''), outreach_clean_domain(p_lead->>'company_domain'),
    ew, ep, (p_lead->>'is_open_profile')::boolean, coalesce(p_lead->'custom','{}'::jsonb), lid, sid, p_source, p_import_job,
    case when coalesce((p_lead->>'profile_fetched')::boolean,false) then now() else null end)
  returning outreach_leads.id into nid;
  if nid is null then
    -- lost a race on the unique index; re-resolve
    select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
    id := nid; created := false; return next; return;
  end if;
  perform outreach_emit_event(p_ws, 'lead.created', jsonb_build_object('id', nid, 'public_identifier', pid, 'source', p_source));
  id := nid; created := true; return next;
exception when unique_violation then
  select l.id into nid from outreach_leads l where l.workspace_id = p_ws and ((pid is not null and l.public_identifier = pid) or (ew is not null and l.email_work = ew)) limit 1;
  id := nid; created := false; return next;
end $$;

create or replace function outreach_bulk_leads(p_ws uuid, p_lead_ids uuid[], p_op text, p_value text default null)
returns int language plpgsql security definer set search_path = public, extensions, extensions as $$
declare cnt int := 0;
begin
  perform outreach_require(p_ws, 'member');
  if array_length(p_lead_ids,1) > 10000 then raise exception 'E_TOO_MANY: max 10000 per request'; end if;
  if p_op = 'add_tag' then
    insert into outreach_lead_tags(lead_id, tag_id) select l.id, p_value::uuid from outreach_leads l where l.workspace_id = p_ws and l.id = any(p_lead_ids) and outreach_client_visible(p_ws, l.client_id) on conflict do nothing;
    get diagnostics cnt = row_count;
  elsif p_op = 'remove_tag' then
    delete from outreach_lead_tags lt using outreach_leads l where lt.lead_id = l.id and l.workspace_id = p_ws and l.id = any(p_lead_ids) and outreach_client_visible(p_ws, l.client_id) and lt.tag_id = p_value::uuid;
    get diagnostics cnt = row_count;
  elsif p_op = 'set_list' then
    update outreach_leads set list_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_stage' then
    update outreach_leads set stage_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_client' then
    if nullif(p_value,'') is not null and not outreach_client_visible(p_ws, p_value::uuid) then raise exception 'E_FORBIDDEN: client not visible'; end if;
    update outreach_leads set client_id = nullif(p_value,'')::uuid where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  elsif p_op = 'set_dnc' then
    update outreach_leads set do_not_contact = true where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  elsif p_op = 'clear_dnc' then
    update outreach_leads set do_not_contact = false where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  elsif p_op = 'delete' then
    delete from outreach_leads where workspace_id = p_ws and id = any(p_lead_ids) and outreach_client_visible(p_ws, client_id);
    get diagnostics cnt = row_count;
  else
    raise exception 'E_PAYLOAD_INVALID: unknown op %', p_op;
  end if;
  perform outreach_audit(p_ws, 'leads.bulk', 'lead', null, jsonb_build_object('op', p_op, 'value', p_value, 'count', cnt));
  return cnt;
end $$;

do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_update_sender(uuid,jsonb)','outreach_assign_chat(uuid,uuid)','outreach_create_api_key(uuid,text,outreach_role_t,uuid[],timestamptz)','outreach_revoke_api_key(uuid)',
    'outreach_api_context(uuid)','outreach_api_leads(uuid,jsonb,int,int)','outreach_api_lead(uuid)','outreach_api_sequences(uuid,text,uuid)','outreach_api_sequence(uuid)',
    'outreach_api_enrollments(uuid,jsonb,int,int)','outreach_api_threads(uuid,jsonb,int,int)','outreach_api_thread(uuid,int)','outreach_api_senders(uuid)','outreach_api_sender(uuid)',
    'outreach_api_webhooks(uuid)','outreach_create_webhook(uuid,text,text[])','outreach_delete_webhook(uuid)','outreach_api_deliveries(uuid,uuid,int)','outreach_replay_delivery(bigint)',
    'outreach_integration_save(uuid,jsonb,jsonb,jsonb)','outreach_integration_disconnect(uuid)','outreach_set_branding(uuid,jsonb)','outreach_branding(uuid)',
    'outreach_add_domain(uuid,text,uuid)','outreach_domains(uuid)','outreach_remove_domain(uuid)','outreach_add_tracking_domain(uuid,text,uuid)','outreach_remove_tracking_domain(uuid)',
    'outreach_save_import_schedule(jsonb)','outreach_save_voice_clip(uuid,text,uuid,text,text,numeric,int)']) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
