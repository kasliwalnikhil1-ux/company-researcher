-- =============================================================================
-- Outreach Platform — 003 triggers + row-level security
-- =============================================================================

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array['outreach_leads','outreach_senders','outreach_sequences','outreach_lead_sender_state','outreach_enrollments']) loop
    execute format('drop trigger if exists %I_updated_at on %I', t, t);
    execute format('create trigger %I_updated_at before update on %I for each row execute function outreach_set_updated_at()', t, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 1. Reply → exit enrollments (unless current node is send_always) + cancel queued actions
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_reply_exit() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; n jsonb;
begin
  if new.replied and not coalesce(old.replied, false) then
    for r in select e.id, e.current_node_id, e.sequence_id, s.graph, s.settings from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id
              where e.lead_id = new.lead_id and e.sender_id = new.sender_id
                and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
      n := r.graph->'nodes'->r.current_node_id;
      if coalesce((r.settings->>'stop_on_reply')::boolean, true) = false then continue; end if;
      if coalesce((n->'config'->>'send_always')::boolean, false) then continue; end if;
      insert into outreach_node_stats(sequence_id, node_id, replied) values (r.sequence_id, r.current_node_id, 1)
        on conflict (sequence_id, node_id) do update set replied = outreach_node_stats.replied + 1, updated_at = now();
      perform outreach_complete_enrollment(r.id, 'exited_replied', 'replied');
    end loop;
    update outreach_actions set status = 'cancelled', decision = 'reply_exit'
      where lead_id = new.lead_id and sender_id = new.sender_id and status in ('queued','reserved')
        and action_type not in ('reply')
        and not exists (select 1 from outreach_enrollments e where e.id = outreach_actions.enrollment_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task'));
  end if;
  return new;
end $$;
drop trigger if exists outreach_lss_reply_exit on outreach_lead_sender_state;
create trigger outreach_lss_reply_exit after update of replied on outreach_lead_sender_state
  for each row execute function outreach_trg_reply_exit();

-- -----------------------------------------------------------------------------
-- 1b. Relation → first (accepted): stats + advance waiting_connection (+2h not-before)
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_relation() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record; ws uuid;
begin
  if new.relation = 'first' and coalesce(old.relation::text,'none') <> 'first' then
    select workspace_id into ws from outreach_senders where id = new.sender_id;
    for r in select e.id, e.current_node_id, e.sequence_id from outreach_enrollments e
              where e.lead_id = new.lead_id and e.sender_id = new.sender_id and e.status = 'waiting_connection' loop
      insert into outreach_node_stats(sequence_id, node_id, accepted) values (r.sequence_id, r.current_node_id, 1)
        on conflict (sequence_id, node_id) do update set accepted = outreach_node_stats.accepted + 1, updated_at = now();
      perform outreach_advance_enrollment(r.id, r.current_node_id, 'connected', now() + interval '2 hours');
    end loop;
    if new.invite_sent_at is not null and old.relation = 'pending_out' then
      perform outreach_emit_event(ws, 'invite.accepted', jsonb_build_object('lead_id', new.lead_id, 'sender_id', new.sender_id, 'detected_at', coalesce(new.invite_detected_at, now())));
    end if;
  end if;
  return new;
end $$;
drop trigger if exists outreach_lss_relation on outreach_lead_sender_state;
create trigger outreach_lss_relation after update of relation on outreach_lead_sender_state
  for each row execute function outreach_trg_relation();

-- -----------------------------------------------------------------------------
-- 2. Enrollment leaves live → cancel its queued actions
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_enrollment_exit() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status not in ('active','waiting_connection','waiting_delay','waiting_task')
     and old.status in ('active','waiting_connection','waiting_delay','waiting_task') then
    update outreach_actions set status = 'cancelled', decision = 'enrollment_' || new.status::text
      where enrollment_id = new.id and status in ('queued','reserved');
  end if;
  return new;
end $$;
drop trigger if exists outreach_enr_exit on outreach_enrollments;
create trigger outreach_enr_exit after update of status on outreach_enrollments for each row execute function outreach_trg_enrollment_exit();

-- -----------------------------------------------------------------------------
-- 3. Sender status transitions
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_sender_status() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  if new.status <> old.status then
    insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'status', jsonb_build_object('from', old.status, 'to', new.status, 'reason', new.status_reason));
    if new.status <> 'ok' then
      update outreach_actions set status = 'queued', reserved_at = null where sender_id = new.id and status = 'reserved';
    end if;
    if new.status = 'ok' then
      new.last_ok_at := now(); new.consecutive_errors := 0; new.reconnect_attempts := 0; new.reconnect_reminders := 0;
      if old.status in ('credentials','error') then
        perform outreach_emit_event(new.workspace_id, 'sender.reconnected', jsonb_build_object('id', new.id));
      elsif old.status = 'connecting' then
        new.connected_at := coalesce(new.connected_at, now());
        perform outreach_emit_event(new.workspace_id, 'sender.connected', jsonb_build_object('id', new.id, 'provider', new.provider));
      end if;
    elsif new.status in ('credentials','error') then
      new.last_disconnect_at := now();
      perform outreach_emit_event(new.workspace_id, 'sender.disconnected', jsonb_build_object('id', new.id, 'status', new.status, 'reason', new.status_reason));
    elsif new.status = 'disabled' then
      for r in select id from outreach_enrollments where sender_id = new.id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
        perform outreach_complete_enrollment(r.id, 'exited_sender_disabled', 'sender_disabled');
      end loop;
      update outreach_actions set status = 'cancelled', decision = 'sender_disabled' where sender_id = new.id and status in ('queued','reserved');
    end if;
  end if;
  if new.paused_until is distinct from old.paused_until and new.paused_until > now() then
    insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'status', jsonb_build_object('paused_until', new.paused_until, 'reason', new.status_reason));
    perform outreach_emit_event(new.workspace_id, 'sender.paused', jsonb_build_object('id', new.id, 'until', new.paused_until));
  end if;
  if new.warmup_level <> old.warmup_level then
    insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'warmup', jsonb_build_object('from', old.warmup_level, 'to', new.warmup_level));
    perform outreach_emit_event(new.workspace_id, 'sender.level_changed', jsonb_build_object('id', new.id, 'level', new.warmup_level));
  end if;
  if new.health_score <> old.health_score then
    insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'health', jsonb_build_object('from', old.health_score, 'to', new.health_score, 'breakdown', new.health_breakdown));
  end if;
  if new.proxy_country is distinct from old.proxy_country then
    insert into outreach_sender_events(sender_id, kind, data) values (new.id, 'proxy', jsonb_build_object('from', old.proxy_country, 'to', new.proxy_country));
  end if;
  return new;
end $$;
drop trigger if exists outreach_sender_status on outreach_senders;
create trigger outreach_sender_status before update on outreach_senders for each row execute function outreach_trg_sender_status();

-- -----------------------------------------------------------------------------
-- 4. Suppression → exit
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_lead_dnc() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare r record;
begin
  if (new.do_not_contact and not old.do_not_contact) or (new.unsubscribed and not old.unsubscribed) then
    for r in select id from outreach_enrollments where lead_id = new.id and status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
      perform outreach_complete_enrollment(r.id, 'exited_suppressed', case when new.do_not_contact then 'do_not_contact' else 'unsubscribed' end);
    end loop;
    update outreach_actions set status = 'cancelled', decision = 'suppressed' where lead_id = new.id and status in ('queued','reserved') and action_type <> 'reply';
  end if;
  if new.do_not_contact <> old.do_not_contact or new.stage_id is distinct from old.stage_id or new.list_id is distinct from old.list_id then
    perform outreach_emit_event(new.workspace_id, 'lead.updated', jsonb_build_object('id', new.id, 'do_not_contact', new.do_not_contact, 'stage_id', new.stage_id, 'list_id', new.list_id));
  end if;
  return new;
end $$;
drop trigger if exists outreach_lead_dnc on outreach_leads;
create trigger outreach_lead_dnc after update of do_not_contact, unsubscribed, stage_id, list_id on outreach_leads for each row execute function outreach_trg_lead_dnc();

-- -----------------------------------------------------------------------------
-- 5. Node stats from action transitions
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_action_stats() returns trigger language plpgsql security definer set search_path = public, extensions as $$
declare seq uuid; dq int := 0; ds int := 0; df int := 0; dk int := 0;
begin
  if coalesce(new.enrollment_id, old.enrollment_id) is null or coalesce(new.node_id, old.node_id) is null then return null; end if;
  if coalesce((coalesce(new.payload, old.payload)->>'prefetch')::boolean,false) or coalesce((coalesce(new.payload, old.payload)->>'subtask')::boolean,false) then return null; end if;
  select sequence_id into seq from outreach_enrollments where id = coalesce(new.enrollment_id, old.enrollment_id);
  if seq is null then return null; end if;
  if tg_op = 'INSERT' then
    if new.status in ('queued','reserved') then dq := 1; end if;
  elsif tg_op = 'UPDATE' then
    if old.status in ('queued','reserved') and new.status not in ('queued','reserved') then dq := -1; end if;
    if old.status not in ('queued','reserved') and new.status in ('queued','reserved') then dq := 1; end if;
    if new.status = 'sent' and old.status <> 'sent' then ds := 1; end if;
    if new.status = 'failed' and old.status <> 'failed' then df := 1; end if;
    if new.status = 'skipped' and old.status <> 'skipped' then dk := 1; end if;
  elsif tg_op = 'DELETE' then
    if old.status in ('queued','reserved') then dq := -1; end if;
  end if;
  if dq <> 0 or ds <> 0 or df <> 0 or dk <> 0 then
    insert into outreach_node_stats(sequence_id, node_id, queued, sent, failed, skipped)
    values (seq, coalesce(new.node_id, old.node_id), greatest(dq,0), ds, df, dk)
    on conflict (sequence_id, node_id) do update set
      queued = greatest(outreach_node_stats.queued + dq, 0), sent = outreach_node_stats.sent + ds,
      failed = outreach_node_stats.failed + df, skipped = outreach_node_stats.skipped + dk, updated_at = now();
  end if;
  return null;
end $$;
drop trigger if exists outreach_actions_stats on outreach_actions;
create trigger outreach_actions_stats after insert or update of status or delete on outreach_actions for each row execute function outreach_trg_action_stats();

-- -----------------------------------------------------------------------------
-- 6. Message insert → chat rollup
-- -----------------------------------------------------------------------------
create or replace function outreach_trg_message_rollup() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_chats c set
    last_message_at = greatest(coalesce(c.last_message_at, new.sent_at), new.sent_at),
    last_direction = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at) then new.direction else c.last_direction end,
    last_message_preview = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at) then left(coalesce(new.text, ''), 140) else c.last_message_preview end,
    unread = case when new.direction = 'in' then true else c.unread end,
    unread_count = case when new.direction = 'in' then c.unread_count + 1 else c.unread_count end,
    archived = case when new.direction = 'in' then false else c.archived end
  where c.id = new.chat_id;
  return new;
end $$;
drop trigger if exists outreach_messages_rollup on outreach_messages;
create trigger outreach_messages_rollup after insert on outreach_messages for each row execute function outreach_trg_message_rollup();

-- -----------------------------------------------------------------------------
-- Row-level security
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select unnest(array[
    'outreach_workspaces','outreach_clients','outreach_members','outreach_invitations','outreach_senders','outreach_sender_secrets',
    'outreach_secret_access_log','outreach_sender_tokens','outreach_platform_ceilings','outreach_warmup_caps','outreach_sender_budgets',
    'outreach_sender_events','outreach_lists','outreach_stages','outreach_tags','outreach_leads','outreach_lead_tags','outreach_lead_sender_state',
    'outreach_suppressions','outreach_import_jobs','outreach_sequences','outreach_sequence_versions','outreach_enrollments','outreach_actions',
    'outreach_node_stats','outreach_chats','outreach_messages','outreach_tasks','outreach_inbound_events','outreach_ai_classify_queue','outreach_plans',
    'outreach_poll_plan','outreach_rate_limits','outreach_flags','outreach_outbound_webhooks','outreach_outbound_webhook_deliveries','outreach_audit_log',
    'outreach_ai_calls','outreach_billing_usage']) loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- helper to (re)create policies idempotently
create or replace function outreach__policy(p_table text, p_name text, p_cmd text, p_using text, p_check text default null) returns void language plpgsql as $$
begin
  execute format('drop policy if exists %I on %I', p_name, p_table);
  if p_cmd = 'select' then
    execute format('create policy %I on %I for select to authenticated using (%s)', p_name, p_table, p_using);
  elsif p_cmd = 'insert' then
    execute format('create policy %I on %I for insert to authenticated with check (%s)', p_name, p_table, coalesce(p_check, p_using));
  elsif p_cmd = 'update' then
    execute format('create policy %I on %I for update to authenticated using (%s) with check (%s)', p_name, p_table, p_using, coalesce(p_check, p_using));
  elsif p_cmd = 'delete' then
    execute format('create policy %I on %I for delete to authenticated using (%s)', p_name, p_table, p_using);
  end if;
end $$;

-- workspaces
select outreach__policy('outreach_workspaces','ws_select','select','id in (select outreach_workspace_ids()) and deleted_at is null');
select outreach__policy('outreach_workspaces','ws_update','update','outreach_role_in(id) = ''owner''');

-- members
select outreach__policy('outreach_members','members_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_members','members_insert','insert','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_members','members_update','update','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_members','members_delete','delete','outreach_role_in(workspace_id) = ''owner'' or user_id = auth.uid()');

-- invitations
select outreach__policy('outreach_invitations','inv_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_invitations','inv_insert','insert','outreach_role_in(workspace_id) = ''owner'' and outreach_plan_active(workspace_id)');
select outreach__policy('outreach_invitations','inv_delete','delete','outreach_role_in(workspace_id) = ''owner''');

-- clients
select outreach__policy('outreach_clients','clients_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, id)');
select outreach__policy('outreach_clients','clients_write_i','insert','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_clients','clients_write_u','update','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_clients','clients_write_d','delete','outreach_can_manage(workspace_id)');

-- senders: select only (mutations via RPC / edge functions)
select outreach__policy('outreach_senders','senders_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id) and deleted_at is null');

-- ceilings / caps: read-only for authenticated
select outreach__policy('outreach_platform_ceilings','ceilings_select','select','true');
select outreach__policy('outreach_warmup_caps','warmup_select','select','true');

-- sender budgets & events: select via sender
select outreach__policy('outreach_sender_budgets','budgets_select','select','exists (select 1 from outreach_senders s where s.id = sender_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_sender_events','sevents_select','select','exists (select 1 from outreach_senders s where s.id = sender_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');

-- lists / stages / tags
select outreach__policy('outreach_lists','lists_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_lists','lists_i','insert','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_lists','lists_u','update','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_lists','lists_d','delete','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_stages','stages_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_stages','stages_i','insert','outreach_can_write(workspace_id)');
select outreach__policy('outreach_stages','stages_u','update','outreach_can_write(workspace_id)');
select outreach__policy('outreach_stages','stages_d','delete','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_tags','tags_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_tags','tags_i','insert','outreach_can_write(workspace_id)');
select outreach__policy('outreach_tags','tags_u','update','outreach_can_write(workspace_id)');
select outreach__policy('outreach_tags','tags_d','delete','outreach_can_write(workspace_id)');

-- leads
select outreach__policy('outreach_leads','leads_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_leads','leads_i','insert','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_leads','leads_u','update','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_leads','leads_d','delete','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_lead_tags','lead_tags_select','select','exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_tags','lead_tags_i','insert','exists (select 1 from outreach_leads l where l.id = lead_id and outreach_can_write(l.workspace_id) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_tags','lead_tags_d','delete','exists (select 1 from outreach_leads l where l.id = lead_id and outreach_can_write(l.workspace_id) and outreach_client_visible(l.workspace_id, l.client_id))');
select outreach__policy('outreach_lead_sender_state','lss_select','select','exists (select 1 from outreach_leads l where l.id = lead_id and l.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(l.workspace_id, l.client_id))');

-- suppressions (manager write)
select outreach__policy('outreach_suppressions','supp_select','select','workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_suppressions','supp_i','insert','outreach_can_manage(workspace_id)');
select outreach__policy('outreach_suppressions','supp_d','delete','outreach_can_manage(workspace_id)');

-- import jobs
select outreach__policy('outreach_import_jobs','imports_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_import_jobs','imports_i','insert','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_import_jobs','imports_u','update','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');

-- sequences: select; delete drafts; everything else via RPC
select outreach__policy('outreach_sequences','seq_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_sequences','seq_u','update','outreach_can_manage(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_sequences','seq_d','delete','outreach_can_manage(workspace_id) and status in (''draft'',''archived'')');
select outreach__policy('outreach_sequence_versions','seqv_select','select','exists (select 1 from outreach_sequences s where s.id = sequence_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_node_stats','nstats_select','select','exists (select 1 from outreach_sequences s where s.id = sequence_id and s.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(s.workspace_id, s.client_id))');

-- enrollments / actions: select only
select outreach__policy('outreach_enrollments','enr_select','select','workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_sequences s where s.id = sequence_id and outreach_client_visible(s.workspace_id, s.client_id))');
select outreach__policy('outreach_actions','actions_select','select','workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_senders s where s.id = sender_id and outreach_client_visible(s.workspace_id, s.client_id))');

-- chats / messages / tasks
select outreach__policy('outreach_chats','chats_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_chats','chats_u','update','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id) and outreach_plan_active(workspace_id)');
select outreach__policy('outreach_messages','msgs_select','select','workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_chats c where c.id = chat_id and outreach_client_visible(c.workspace_id, c.client_id))');
select outreach__policy('outreach_tasks','tasks_select','select','workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_tasks','tasks_i','insert','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_tasks','tasks_u','update','outreach_can_write(workspace_id) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_tasks','tasks_d','delete','outreach_can_manage(workspace_id)');

-- webhooks / audit / billing (owner)
select outreach__policy('outreach_outbound_webhooks','owh_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_outbound_webhooks','owh_i','insert','outreach_role_in(workspace_id) = ''owner'' and outreach_plan_active(workspace_id)');
select outreach__policy('outreach_outbound_webhooks','owh_u','update','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_outbound_webhooks','owh_d','delete','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_outbound_webhook_deliveries','owd_select','select','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_audit_log','audit_select','select','outreach_role_in(workspace_id) in (''owner'',''manager'')');
select outreach__policy('outreach_ai_calls','ai_calls_select','select','outreach_role_in(workspace_id) = ''owner''');
select outreach__policy('outreach_billing_usage','billing_select','select','outreach_role_in(workspace_id) = ''owner''');

-- Storage policies: users read attachments/exports of their workspace via signed URLs generated by functions; imports uploaded by members.
drop policy if exists outreach_imports_upload on storage.objects;
create policy outreach_imports_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-imports' and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));
drop policy if exists outreach_imports_read on storage.objects;
create policy outreach_imports_read on storage.objects for select to authenticated
  using (bucket_id in ('outreach-imports','outreach-exports','outreach-attachments') and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));
