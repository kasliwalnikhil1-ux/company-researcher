-- 037 — AI replies: RPCs for the app, the MCP connector and the public API (docs/outreach/AI-REPLIES-CONTRACT.md §3), and grants.
-- Every RPC is security definer and checks outreach_require() then outreach_client_visible() for the row's client
-- (rule from the Sept 2026 access audit). Needs 036. Idempotent.

-- ============================================================================= scope helper
-- the client a policy / prompt scope belongs to (null for workspace), after checking the entity is in the workspace
create or replace function outreach__ai_scope_client(p_ws uuid, p_scope text, p_scope_id uuid) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare cid uuid; ok boolean;
begin
  if p_scope = 'workspace' then
    if p_scope_id is not null then raise exception 'E_PAYLOAD_INVALID: workspace scope takes no id'; end if;
    return null;
  elsif p_scope = 'client' then
    select id, true into cid, ok from outreach_clients where id = p_scope_id and workspace_id = p_ws;
  elsif p_scope = 'sequence' then
    select client_id, true into cid, ok from outreach_sequences where id = p_scope_id and workspace_id = p_ws;
  elsif p_scope = 'sender' then
    select client_id, true into cid, ok from outreach_senders where id = p_scope_id and workspace_id = p_ws and deleted_at is null;
  else
    raise exception 'E_PAYLOAD_INVALID: unknown scope %', p_scope;
  end if;
  if not coalesce(ok, false) then raise exception 'E_NOT_FOUND: % not found', p_scope; end if;
  return cid;
end $$;

create or replace function outreach__ai_scope_label(p_scope text, p_scope_id uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case p_scope
    when 'workspace' then 'Workspace'
    when 'client' then 'Client · ' || coalesce((select name from outreach_clients where id = p_scope_id), '?')
    when 'sequence' then 'Sequence · ' || coalesce((select name from outreach_sequences where id = p_scope_id), '?')
    when 'sender' then 'Sender · ' || coalesce((select display_name from outreach_senders where id = p_scope_id), '?')
    else p_scope end
$$;

-- ============================================================================= inbox
create or replace function outreach_ai_reply_chat_state(p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; eff jsonb; st jsonb; stage_j jsonb; total int; pos int; lbl text; act outreach_ai_reply_runs%rowtype; lst outreach_ai_reply_runs%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  eff := outreach__ai_effective(p_chat);
  st := coalesce(eff->'settings'->'stages', '[]'::jsonb);
  total := jsonb_array_length(st);
  if c.conversation_stage is not null then
    select o.i::int, o.x->>'label' into pos, lbl from jsonb_array_elements(st) with ordinality o(x, i) where o.x->>'key' = c.conversation_stage;
    if pos is null and c.conversation_stage = 'closing' then pos := total + 1; lbl := 'Closing'; end if;
    if pos is not null then stage_j := jsonb_build_object('key', c.conversation_stage, 'label', lbl, 'position', pos, 'total', total); end if;
  end if;
  select * into act from outreach_ai_reply_runs where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled','sending') limit 1;
  select * into lst from outreach_ai_reply_runs where chat_id = p_chat and status not in ('debouncing','drafting','draft_ready','scheduled','sending','superseded')
   order by updated_at desc limit 1;
  return (eff - 'policy' - 'settings' - 'sequence_id' - 'consent_valid' - 'graduated') || jsonb_build_object(
    'stage', stage_j, 'exchanges', c.conversation_exchanges, 'ai_replies_count', c.ai_replies_count,
    'max_ai_replies', coalesce((eff->'settings'->>'max_ai_replies_per_chat')::int, 6),
    'run', outreach__ai_run_json(act), 'last_run', outreach__ai_run_json(lst));
end $$;

create or replace function outreach_ai_reply_set_chat_mode(p_chat uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; eff jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  -- members may switch a chat off or to draft; turning autopilot on, or clearing an override (which can let an inherited
  -- autopilot apply), is a manager decision
  perform outreach_require(c.workspace_id, case when p_mode is null or p_mode = 'autopilot' then 'manager' else 'member' end);
  perform outreach__ai_chat_lock(p_chat);
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_mode is not null and p_mode not in ('off','draft','autopilot') then raise exception 'E_PAYLOAD_INVALID: mode must be off, draft or autopilot'; end if;
  update outreach_chats set reply_mode_override = p_mode::outreach_reply_mode_t where id = p_chat;
  eff := outreach__ai_effective(p_chat);
  if eff->>'mode' = 'off' then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'mode_off', cancelled_by = auth.uid()
     where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled');
  elsif eff->>'mode' = 'draft' then
    update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'mode_draft'::text
     where chat_id = p_chat and status = 'scheduled';
  end if;
  perform outreach_audit(c.workspace_id, 'ai_reply.chat_mode', 'chat', p_chat::text, jsonb_build_object('mode', p_mode), 'user');
  return outreach_ai_reply_chat_state(p_chat);
end $$;

create or replace function outreach_ai_reply_resume_chat(p_chat uuid, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'manager');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'E_PAYLOAD_INVALID: add a note saying why autopilot can resume'; end if;
  update outreach_chats set autopilot_state = 'active', autopilot_paused_until = null, autopilot_paused_reason = null where id = p_chat;
  perform outreach_audit(c.workspace_id, 'ai_reply.chat_resumed', 'chat', p_chat::text, jsonb_build_object('from', c.autopilot_state, 'note', left(p_note, 500)), 'user');
  return outreach_ai_reply_chat_state(p_chat);
end $$;

create or replace function outreach_ai_reply_cancel(p_run uuid, p_reason text, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'member');
  if not outreach_client_visible(r.workspace_id, r.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_reason not in ('wrong_facts','wrong_tone','too_early_to_pitch','shouldnt_reply','answer_myself','other','dismissed') then
    raise exception 'E_PAYLOAD_INVALID: unknown cancel reason';
  end if;
  if r.status = 'scheduled' and p_reason = 'dismissed' then raise exception 'E_PAYLOAD_INVALID: say why you are cancelling a scheduled reply'; end if;
  perform outreach__ai_chat_lock(r.chat_id);
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = p_reason, cancel_note = left(p_note, 500), cancelled_by = auth.uid()
   where id = p_run and status in ('debouncing','drafting','draft_ready','scheduled')
  returning * into r;
  if r.id is null then raise exception 'E_CONFLICT: this AI reply already moved on (sent, replaced or cancelled)'; end if;
  perform outreach_audit(r.workspace_id, 'ai_reply.cancelled', 'ai_reply_run', r.id::text, jsonb_build_object('reason', p_reason, 'note', p_note, 'rule_applied', r.rule_applied), 'user');
  return outreach__ai_run_json(r);
end $$;

-- draft mode: a person accepts the AI's "don't reply" suggestion and its side effects (task, archive …)
create or replace function outreach_ai_reply_apply_no_reply(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'member');
  if not outreach_client_visible(r.workspace_id, r.client_id) then raise exception 'E_NOT_FOUND'; end if;
  update outreach_ai_reply_runs set status = 'no_reply', dispatched_by = auth.uid()
   where id = p_run and status = 'draft_ready' and decision = 'no_reply' returning * into r;
  if r.id is null then raise exception 'E_CONFLICT: this is not a pending "no reply" suggestion'; end if;
  perform outreach__ai_apply_side_effects(r.id);
  perform outreach_audit(r.workspace_id, 'ai_reply.no_reply_applied', 'ai_reply_run', r.id::text, jsonb_build_object('side_effects', r.side_effects), 'user');
  return outreach__ai_run_json(r);
end $$;

-- ============================================================================= activity log
create or replace function outreach_ai_reply_runs_list(p_ws uuid, p_filters jsonb default '{}'::jsonb, p_limit int default 50, p_before timestamptz default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); lim int := greatest(1, least(coalesce(p_limit, 50), 200)); items jsonb; nb timestamptz;
begin
  perform outreach_require(p_ws, 'member');
  select coalesce(jsonb_agg(x.j order by x.created_at desc), '[]'::jsonb), min(x.created_at) into items, nb from (
    select r.created_at, outreach__ai_run_json(r) || jsonb_build_object(
             'sender_id', r.sender_id, 'lead_id', r.lead_id, 'lead_name', coalesce(l.full_name, c.attendee_name), 'sender_name', s.display_name,
             'sequence_id', r.sequence_id, 'sequence_name', q.name,
             'inbound_text', (select left(string_agg(coalesce(m.text, m.transcript, '[attachment]'), ' / ' order by m.sent_at), 300) from outreach_messages m where m.id = any(r.inbound_message_ids))) j
      from outreach_ai_reply_runs r
      join outreach_chats c on c.id = r.chat_id
      left join outreach_leads l on l.id = r.lead_id
      left join outreach_senders s on s.id = r.sender_id
      left join outreach_sequences q on q.id = r.sequence_id
     where r.workspace_id = p_ws and outreach_client_visible(p_ws, r.client_id)
       and (p_before is null or r.created_at < p_before)
       and (not (f ? 'status') or jsonb_typeof(f->'status') <> 'array' or jsonb_array_length(f->'status') = 0 or r.status::text in (select jsonb_array_elements_text(f->'status')))
       and (coalesce(f->>'decision', '') = '' or r.decision::text = f->>'decision')
       and (coalesce(f->>'mode', '') = '' or r.mode::text = f->>'mode')
       and (coalesce(f->>'sequence_id', '') = '' or r.sequence_id = (f->>'sequence_id')::uuid)
       and (coalesce(f->>'sender_id', '') = '' or r.sender_id = (f->>'sender_id')::uuid)
       and (coalesce(f->>'chat_id', '') = '' or r.chat_id = (f->>'chat_id')::uuid)
       and (coalesce(f->>'stage', '') = '' or r.stage_after = f->>'stage' or r.stage_before = f->>'stage')
       and (coalesce(f->>'reason', '') = '' or f->>'reason' = any(r.escalation_reasons) or f->>'reason' = any(r.gate_failures) or r.cancel_reason = f->>'reason')
       and (coalesce(f->>'since', '') = '' or r.created_at >= (f->>'since')::timestamptz)
     order by r.created_at desc limit lim) x;
  return jsonb_build_object('items', items, 'next_before', case when jsonb_array_length(items) = lim then nb end);
end $$;

create or replace function outreach_ai_reply_run_get(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; j jsonb; mpj jsonb;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'member');
  if not outreach_client_visible(r.workspace_id, r.client_id) then raise exception 'E_NOT_FOUND'; end if;
  select jsonb_build_object('id', v.master_prompt_id, 'version', v.version, 'body', v.body, 'editor_mode', v.editor_mode) into mpj
    from outreach_master_prompt_versions v where v.master_prompt_id = r.master_prompt_id and v.version = r.master_prompt_version;
  select outreach__ai_run_json(r) || jsonb_build_object(
           'sender_id', r.sender_id, 'lead_id', r.lead_id, 'lead_name', coalesce(l.full_name, c.attendee_name), 'sender_name', s.display_name,
           'sequence_id', r.sequence_id, 'sequence_name', q.name,
           'inbound_text', (select string_agg(coalesce(m.text, m.transcript, '[attachment]'), E'\n' order by m.sent_at) from outreach_messages m where m.id = any(r.inbound_message_ids)),
           'context', r.context, 'policy_snapshot', r.policy_snapshot, 'master_prompt', mpj, 'error', r.error, 'model', r.model,
           'edit_distance', r.edit_distance, 'facts_changed', r.facts_changed, 'sent_message_id', r.sent_message_id)
    into j
    from outreach_chats c left join outreach_leads l on l.id = r.lead_id left join outreach_senders s on s.id = r.sender_id left join outreach_sequences q on q.id = r.sequence_id
   where c.id = r.chat_id;
  return j;
end $$;

-- ============================================================================= reply policies
create or replace function outreach__ai_policy_row_json(p outreach_reply_policies) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object('id', p.id, 'scope', p.scope, 'scope_id', p.scope_id, 'scope_label', outreach__ai_scope_label(p.scope, p.scope_id),
    'mode', p.mode, 'delay_min_s', p.delay_min_s, 'delay_max_s', p.delay_max_s, 'debounce_quiet_s', p.debounce_quiet_s, 'debounce_max_s', p.debounce_max_s,
    'max_ai_sends_per_sender_day', p.max_ai_sends_per_sender_day, 'stale_after_h', p.stale_after_h, 'human_takeover_pause_h', p.human_takeover_pause_h,
    'disclosure', p.disclosure, 'blocked_countries', to_jsonb(p.blocked_countries), 'downgraded_at', p.downgraded_at, 'downgrade_reason', p.downgrade_reason,
    'note', p.note, 'updated_at', p.updated_at)
$$;

create or replace function outreach_reply_policy_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare rows_ jsonb;
begin
  perform outreach_require(p_ws, 'member');
  select coalesce(jsonb_agg(outreach__ai_policy_row_json(p) order by case p.scope when 'workspace' then 0 when 'client' then 1 when 'sequence' then 2 else 3 end, p.updated_at), '[]'::jsonb)
    into rows_ from outreach_reply_policies p
   where p.workspace_id = p_ws
     and outreach_client_visible(p_ws, case p.scope when 'client' then p.scope_id
                                                    when 'sequence' then (select client_id from outreach_sequences where id = p.scope_id)
                                                    when 'sender' then (select client_id from outreach_senders where id = p.scope_id) end);
  return jsonb_build_object('defaults', outreach_ai_reply_defaults(), 'rows', rows_);
end $$;

create or replace function outreach_reply_policy_set(p_ws uuid, p_scope text, p_scope_id uuid, p_patch jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; p outreach_reply_policies%rowtype; k text; bad text[];
  allowed text[] := array['mode','delay_min_s','delay_max_s','debounce_quiet_s','debounce_max_s','max_ai_sends_per_sender_day','stale_after_h',
                          'human_takeover_pause_h','disclosure','blocked_countries'];
begin
  perform outreach_require(p_ws, 'manager');
  cid := outreach__ai_scope_client(p_ws, p_scope, p_scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'E_PAYLOAD_INVALID: patch must be an object'; end if;
  select array_agg(x) into bad from jsonb_object_keys(p_patch) x where not (x = any(allowed));
  if bad is not null then raise exception 'E_PAYLOAD_INVALID: unknown field(s) %', array_to_string(bad, ', '); end if;
  if p_patch ? 'mode' and coalesce(p_patch->>'mode', 'off') not in ('off','draft','autopilot') then raise exception 'E_PAYLOAD_INVALID: mode must be off, draft or autopilot'; end if;
  if p_patch ? 'blocked_countries' and jsonb_typeof(p_patch->'blocked_countries') = 'array'
     and exists (select 1 from jsonb_array_elements_text(p_patch->'blocked_countries') c where c !~ '^[A-Z]{2}$') then
    raise exception 'E_PAYLOAD_INVALID: countries are two-letter codes like DE or FR';
  end if;
  insert into outreach_reply_policies(workspace_id, scope, scope_id) values (p_ws, p_scope, p_scope_id)
  on conflict (workspace_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)) do nothing;
  select * into p from outreach_reply_policies where workspace_id = p_ws and scope = p_scope and scope_id is not distinct from p_scope_id for update;
  -- re-enabling autopilot after an automatic downgrade is a manager decision with a reason (§10.3)
  if p.downgraded_at is not null and p_patch->>'mode' = 'autopilot' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'E_PAYLOAD_INVALID: autopilot was switched off automatically (%). Add a note saying why it can go back on', p.downgrade_reason;
  end if;
  begin
    update outreach_reply_policies set
      mode = case when p_patch ? 'mode' then (p_patch->>'mode')::outreach_reply_mode_t else mode end,
      delay_min_s = case when p_patch ? 'delay_min_s' then (p_patch->>'delay_min_s')::int else delay_min_s end,
      delay_max_s = case when p_patch ? 'delay_max_s' then (p_patch->>'delay_max_s')::int else delay_max_s end,
      debounce_quiet_s = case when p_patch ? 'debounce_quiet_s' then (p_patch->>'debounce_quiet_s')::int else debounce_quiet_s end,
      debounce_max_s = case when p_patch ? 'debounce_max_s' then (p_patch->>'debounce_max_s')::int else debounce_max_s end,
      max_ai_sends_per_sender_day = case when p_patch ? 'max_ai_sends_per_sender_day' then (p_patch->>'max_ai_sends_per_sender_day')::int else max_ai_sends_per_sender_day end,
      stale_after_h = case when p_patch ? 'stale_after_h' then (p_patch->>'stale_after_h')::int else stale_after_h end,
      human_takeover_pause_h = case when p_patch ? 'human_takeover_pause_h' then (p_patch->>'human_takeover_pause_h')::int else human_takeover_pause_h end,
      disclosure = case when p_patch ? 'disclosure' then nullif(btrim(p_patch->>'disclosure'), '') else disclosure end,
      blocked_countries = case when p_patch ? 'blocked_countries' then
                            case when jsonb_typeof(p_patch->'blocked_countries') = 'array' then array(select jsonb_array_elements_text(p_patch->'blocked_countries')) end
                          else blocked_countries end,
      downgraded_at = case when p_patch->>'mode' = 'autopilot' then null else downgraded_at end,
      breaker_reset_at = case when p_patch->>'mode' = 'autopilot' and mode is distinct from 'autopilot' then now() else breaker_reset_at end,
      downgrade_reason = case when p_patch->>'mode' = 'autopilot' then null else downgrade_reason end,
      note = coalesce(nullif(btrim(coalesce(p_note, '')), ''), note),
      updated_by = auth.uid(), updated_at = now()
    where id = p.id returning * into p;
  exception
    when check_violation then raise exception 'E_PAYLOAD_INVALID: a value is out of range (delays 1–60 min with max above min, debounce 30–600 s / 60–1800 s, 1–40 sends a day, stale 1–72 h, pause 1–720 h, disclosure up to 200 characters)';
    when invalid_text_representation then raise exception 'E_PAYLOAD_INVALID: a number field holds text';
  end;
  -- scheduled autopilot sends that this change turns into drafts wait for a person
  if p_patch->>'mode' in ('off','draft') then
    update outreach_ai_reply_runs r set status = 'draft_ready', mode = 'draft', gate_failures = r.gate_failures || 'policy_changed'::text
     where r.workspace_id = p_ws and r.status = 'scheduled' and (outreach__ai_effective(r.chat_id)->>'mode') <> 'autopilot';
  end if;
  perform outreach_audit(p_ws, 'ai_reply.policy_set', 'reply_policy', p.id::text, jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'patch', p_patch, 'note', p_note), 'user');
  return outreach__ai_policy_row_json(p);
end $$;

create or replace function outreach_reply_policy_clear(p_ws uuid, p_scope text, p_scope_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid;
begin
  perform outreach_require(p_ws, 'manager');
  if p_scope = 'workspace' then raise exception 'E_PAYLOAD_INVALID: the workspace policy can be edited, not removed'; end if;
  cid := outreach__ai_scope_client(p_ws, p_scope, p_scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_reply_policies where workspace_id = p_ws and scope = p_scope and scope_id = p_scope_id;
  perform outreach_audit(p_ws, 'ai_reply.policy_cleared', 'reply_policy', p_scope_id::text, jsonb_build_object('scope', p_scope), 'user');
end $$;

-- ============================================================================= master prompts
-- normalised settings (defaults under what was sent) — raises E_PAYLOAD_INVALID on anything out of range
create or replace function outreach__mp_clean_settings(p_ws uuid, p_settings jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s jsonb := outreach__mp_default_settings() || coalesce(p_settings, '{}'::jsonb); st jsonb; keys text[] := '{}'; k text; n int;
  flags text[] := array['asked_offer','pricing','meeting_request','meeting_time_proposed','explicit_interest'];
begin
  if jsonb_typeof(s->'stages') <> 'array' or jsonb_array_length(s->'stages') > 8 then raise exception 'E_PAYLOAD_INVALID: up to 8 stages'; end if;
  for st in select x from jsonb_array_elements(s->'stages') x loop
    k := st->>'key';
    if k is null or k !~ '^[a-z][a-z0-9_]{1,30}$' then raise exception 'E_PAYLOAD_INVALID: a stage key must be lowercase letters, digits or _ (e.g. next_step)'; end if;
    if k = 'closing' then raise exception 'E_PAYLOAD_INVALID: "closing" is reserved'; end if;
    if k = any(keys) then raise exception 'E_PAYLOAD_INVALID: stage key % is used twice', k; end if;
    if length(coalesce(st->>'label', '')) not between 1 and 40 then raise exception 'E_PAYLOAD_INVALID: every stage needs a label (up to 40 characters)'; end if;
    keys := keys || k;
  end loop;
  n := (s->>'min_exchanges_before_pitch')::int;
  if n is null or n not between 0 and 10 then raise exception 'E_PAYLOAD_INVALID: exchanges before pitching must be 0–10'; end if;
  n := (s->>'max_ai_replies_per_chat')::int;
  if n is null or n not between 1 and 10 then raise exception 'E_PAYLOAD_INVALID: AI replies per chat must be 1–10'; end if;
  n := (s->>'max_length')::int;
  if n is null or n not between 100 and 1000 then raise exception 'E_PAYLOAD_INVALID: reply length must be 100–1000 characters'; end if;
  if jsonb_typeof(s->'skip_to_pitch_when') <> 'array' or exists (select 1 from jsonb_array_elements_text(s->'skip_to_pitch_when') x where not (x = any(flags))) then
    raise exception 'E_PAYLOAD_INVALID: skip_to_pitch_when takes %', array_to_string(flags, ', ');
  end if;
  if jsonb_typeof(s->'languages') <> 'array' or jsonb_array_length(s->'languages') = 0
     or exists (select 1 from jsonb_array_elements_text(s->'languages') x where x !~ '^[a-z]{2,3}$') then
    raise exception 'E_PAYLOAD_INVALID: languages are ISO codes like en or hi';
  end if;
  if coalesce(s->>'bot_question', '') not in ('escalate','disclose') then raise exception 'E_PAYLOAD_INVALID: bot_question is escalate or disclose'; end if;
  if coalesce(s->>'handoff_stage_id', '') <> '' and not exists (select 1 from outreach_stages where id = (s->>'handoff_stage_id')::uuid and workspace_id = p_ws) then
    raise exception 'E_PAYLOAD_INVALID: hand-off stage not found in this workspace';
  end if;
  if jsonb_typeof(s->'knowledge_source_ids') <> 'array' then s := jsonb_set(s, '{knowledge_source_ids}', '[]'::jsonb); end if;
  return s;
exception when invalid_text_representation then raise exception 'E_PAYLOAD_INVALID: a number or id field holds text';
end $$;

create or replace function outreach__mp_json(mp outreach_master_prompts, p_version int default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v outreach_master_prompt_versions%rowtype; who text;
begin
  select coalesce(m.display_name, m.email::text) into who from outreach_members m where m.workspace_id = mp.workspace_id and m.user_id = mp.updated_by;
  if p_version is not null and p_version <> mp.version then
    select * into v from outreach_master_prompt_versions where master_prompt_id = mp.id and version = p_version;
    if not found then raise exception 'E_NOT_FOUND: version % not found', p_version; end if;
    return jsonb_build_object('exists', true, 'id', mp.id, 'scope', mp.scope, 'scope_id', mp.scope_id, 'scope_label', outreach__ai_scope_label(mp.scope, mp.scope_id),
      'editor_mode', v.editor_mode, 'version', v.version, 'body', v.body, 'sections', v.sections, 'settings', outreach__mp_default_settings() || v.settings,
      'substantive_version', mp.substantive_version, 'updated_at', v.created_at, 'updated_by_name', who, 'graduated', outreach__ai_graduated(mp.id),
      'inherited', null, 'template', outreach_master_prompt_template(), 'current_version', mp.version);
  end if;
  return jsonb_build_object('exists', true, 'id', mp.id, 'scope', mp.scope, 'scope_id', mp.scope_id, 'scope_label', outreach__ai_scope_label(mp.scope, mp.scope_id),
    'editor_mode', mp.editor_mode, 'version', mp.version, 'body', mp.body, 'sections', mp.sections, 'settings', outreach__mp_default_settings() || mp.settings,
    'substantive_version', mp.substantive_version, 'updated_at', mp.updated_at, 'updated_by_name', who, 'graduated', outreach__ai_graduated(mp.id),
    'inherited', null, 'template', outreach_master_prompt_template(), 'current_version', mp.version);
end $$;

create or replace function outreach_master_prompt_get(p_ws uuid, p_scope text default 'workspace', p_scope_id uuid default null, p_version int default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare cid uuid; mp outreach_master_prompts%rowtype; par outreach_master_prompts%rowtype; t jsonb;
begin
  perform outreach_require(p_ws, 'member');
  if p_scope not in ('workspace','client','sequence') then raise exception 'E_PAYLOAD_INVALID: scope is workspace, client or sequence'; end if;
  cid := outreach__ai_scope_client(p_ws, p_scope, p_scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  select * into mp from outreach_master_prompts where workspace_id = p_ws and scope = p_scope and scope_id is not distinct from p_scope_id;
  if found then return outreach__mp_json(mp, p_version); end if;
  -- no prompt at this scope yet: what it inherits (a sequence → its client's prompt → the workspace prompt)
  if p_scope = 'sequence' then par := outreach__ai_master_prompt(p_ws, cid, null);
  elsif p_scope = 'client' then par := outreach__ai_master_prompt(p_ws, null, null);
  end if;
  t := outreach_master_prompt_template();
  return jsonb_build_object('exists', false, 'id', null, 'scope', p_scope, 'scope_id', p_scope_id, 'scope_label', outreach__ai_scope_label(p_scope, p_scope_id),
    'editor_mode', coalesce(par.editor_mode, 'guided'), 'version', 0, 'body', coalesce(par.body, t->>'body'),
    'sections', case when par.id is null then t->'sections' else par.sections end,
    'settings', case when par.id is null then t->'settings' else outreach__mp_default_settings() || par.settings end,
    'substantive_version', null, 'updated_at', null, 'updated_by_name', null, 'graduated', false,
    'inherited', case when par.id is null then null else jsonb_build_object('scope', par.scope, 'id', par.id, 'version', par.version) end,
    'template', t, 'current_version', 0);
end $$;

create or replace function outreach_master_prompt_save(p_ws uuid, p_scope text, p_scope_id uuid, p_editor_mode text, p_body text, p_sections jsonb,
                                                       p_settings jsonb, p_change_kind text, p_note text default null, p_base_version int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; mp outreach_master_prompts%rowtype; st jsonb; body_ text; kind_ text := p_change_kind; newv int; was_raw boolean;
begin
  perform outreach_require(p_ws, 'manager');
  if p_scope not in ('workspace','client','sequence') then raise exception 'E_PAYLOAD_INVALID: scope is workspace, client or sequence'; end if;
  cid := outreach__ai_scope_client(p_ws, p_scope, p_scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  if p_editor_mode not in ('guided','raw') then raise exception 'E_PAYLOAD_INVALID: editor_mode is guided or raw'; end if;
  if kind_ not in ('style','substantive') then raise exception 'E_PAYLOAD_INVALID: change_kind is style or substantive'; end if;
  st := outreach__mp_clean_settings(p_ws, p_settings);
  if p_editor_mode = 'guided' then
    if p_sections is null or jsonb_typeof(p_sections) <> 'object' then raise exception 'E_PAYLOAD_INVALID: guided mode needs sections'; end if;
    body_ := outreach__compile_master_prompt(p_sections, st);
  else
    body_ := btrim(coalesce(p_body, ''));
  end if;
  if length(body_) < 20 then raise exception 'E_PAYLOAD_INVALID: the prompt is too short'; end if;
  if length(body_) > 40000 then raise exception 'E_PAYLOAD_INVALID: the prompt is longer than 40,000 characters'; end if;
  select * into mp from outreach_master_prompts where workspace_id = p_ws and scope = p_scope and scope_id is not distinct from p_scope_id for update;
  if not found then
    insert into outreach_master_prompts(workspace_id, scope, scope_id, editor_mode, version, body, sections, settings, substantive_version, substantive_at, updated_by)
    values (p_ws, p_scope, p_scope_id, p_editor_mode, 1, body_, case when p_editor_mode = 'guided' then p_sections end, st, 1, now(), auth.uid())
    returning * into mp;
    kind_ := 'substantive';   -- the first version is always substantive
  else
    if p_base_version is not null and p_base_version <> mp.version then
      raise exception 'E_CONFLICT: someone saved version % while you were editing version %. Reload to see it', mp.version, p_base_version;
    end if;
    was_raw := mp.editor_mode = 'raw';
    -- guided → raw drops the deterministic stage checks: treat as substantive and re-graduate (§19 q6)
    if mp.editor_mode = 'guided' and p_editor_mode = 'raw' then kind_ := 'substantive'; end if;
    newv := mp.version + 1;
    update outreach_master_prompts set editor_mode = p_editor_mode, version = newv, body = body_,
           sections = case when p_editor_mode = 'guided' then p_sections else sections end, settings = st,
           substantive_version = case when kind_ = 'substantive' then newv else substantive_version end,
           substantive_at = case when kind_ = 'substantive' then now() else substantive_at end,
           graduated_at = case when mp.editor_mode = 'guided' and p_editor_mode = 'raw' then null else graduated_at end,
           updated_by = auth.uid(), updated_at = now()
     where id = mp.id returning * into mp;
  end if;
  insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by)
  values (mp.id, mp.version, mp.editor_mode, mp.body, mp.sections, mp.settings, kind_, left(p_note, 500), auth.uid());
  perform outreach_audit(p_ws, 'ai_reply.master_prompt_saved', 'master_prompt', mp.id::text,
    jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id, 'version', mp.version, 'change_kind', kind_, 'editor_mode', mp.editor_mode, 'note', p_note), 'user');
  return outreach__mp_json(mp, null) || jsonb_build_object('change_kind', kind_);
end $$;

create or replace function outreach_master_prompt_versions(p_mp uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; cid uuid;
begin
  select * into mp from outreach_master_prompts where id = p_mp;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(mp.workspace_id, 'member');
  cid := outreach__ai_scope_client(mp.workspace_id, mp.scope, mp.scope_id);
  if not outreach_client_visible(mp.workspace_id, cid) then raise exception 'E_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'change_kind', v.change_kind, 'note', v.note, 'editor_mode', v.editor_mode,
            'body', v.body, 'sections', v.sections, 'settings', outreach__mp_default_settings() || v.settings, 'created_at', v.created_at,
            'created_by_name', (select coalesce(m.display_name, m.email::text) from outreach_members m where m.workspace_id = mp.workspace_id and m.user_id = v.created_by))
            order by v.version desc)
    from outreach_master_prompt_versions v where v.master_prompt_id = p_mp), '[]'::jsonb);
end $$;

create or replace function outreach_master_prompt_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return coalesce((select jsonb_agg(jsonb_build_object('id', mp.id, 'scope', mp.scope, 'scope_id', mp.scope_id, 'scope_label', outreach__ai_scope_label(mp.scope, mp.scope_id),
            'version', mp.version, 'editor_mode', mp.editor_mode, 'updated_at', mp.updated_at, 'graduated_at', mp.graduated_at, 'graduation', mp.graduation,
            'substantive_version', mp.substantive_version)
            order by case mp.scope when 'workspace' then 0 when 'client' then 1 else 2 end, mp.updated_at)
    from outreach_master_prompts mp
   where mp.workspace_id = p_ws
     and outreach_client_visible(p_ws, case mp.scope when 'client' then mp.scope_id when 'sequence' then (select client_id from outreach_sequences where id = mp.scope_id) end)), '[]'::jsonb);
end $$;

create or replace function outreach_master_prompt_delete(p_ws uuid, p_scope text, p_scope_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; mid uuid;
begin
  perform outreach_require(p_ws, 'manager');
  if p_scope not in ('client','sequence') then raise exception 'E_PAYLOAD_INVALID: only client and sequence prompts can be removed'; end if;
  cid := outreach__ai_scope_client(p_ws, p_scope, p_scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_master_prompts where workspace_id = p_ws and scope = p_scope and scope_id = p_scope_id returning id into mid;
  if mid is not null then
    perform outreach_audit(p_ws, 'ai_reply.master_prompt_removed', 'master_prompt', mid::text, jsonb_build_object('scope', p_scope, 'scope_id', p_scope_id), 'user');
  end if;
end $$;

-- ============================================================================= consent
create or replace function outreach_ai_consent_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare me_email text;
begin
  perform outreach_require(p_ws, 'manager');
  select lower(email) into me_email from auth.users where id = auth.uid();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'sender_id', s.id, 'sender_name', s.display_name, 'provider', s.provider, 'owner_email', s.owner_email,
      'owner_is_me', (s.owner_user_id = auth.uid()) or (me_email is not null and lower(s.owner_email::text) = me_email),
      'consents', (select coalesce(jsonb_agg(jsonb_build_object('id', k.id, 'master_prompt_id', k.master_prompt_id,
                      'scope_label', outreach__ai_scope_label(mp.scope, mp.scope_id), 'master_prompt_version', k.master_prompt_version,
                      'valid', k.expires_at > now() and mp.substantive_version <= k.master_prompt_version,
                      'needs_reconsent', mp.substantive_version > k.master_prompt_version, 'granted_via', k.granted_via, 'granted_by_email', k.granted_by_email,
                      'granted_at', k.granted_at, 'expires_at', k.expires_at, 'scope', k.scope) order by k.granted_at desc), '[]'::jsonb)
                     from outreach_ai_reply_consent k join outreach_master_prompts mp on mp.id = k.master_prompt_id
                    where k.sender_id = s.id and k.revoked_at is null),
      'pending_links', (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'master_prompt_id', x.master_prompt_id, 'email', x.email, 'created_at', x.created_at,
                      'expires_at', x.expires_at) order by x.created_at desc), '[]'::jsonb)
                     from outreach_ai_reply_consent_links x where x.sender_id = s.id and x.used_at is null and x.cancelled_at is null and x.expires_at > now()))
      order by s.display_name)
    from outreach_senders s
   where s.workspace_id = p_ws and s.deleted_at is null and s.provider = 'LINKEDIN' and outreach_client_visible(p_ws, s.client_id)), '[]'::jsonb);
end $$;

create or replace function outreach_ai_consent_revoke(p_consent uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent%rowtype; cid uuid;
begin
  select * into k from outreach_ai_reply_consent where id = p_consent;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(k.workspace_id, 'manager');
  select client_id into cid from outreach_senders where id = k.sender_id;
  if not outreach_client_visible(k.workspace_id, cid) then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__ai_consent_revoke(k.id, coalesce(nullif(btrim(coalesce(p_reason, '')), ''), 'revoked_by_manager'), coalesce(auth.uid()::text, 'service'));
end $$;

-- the sender's owner is the person using the app (their own account): consent is immediate (§4.1)
create or replace function outreach_ai_consent_grant_operator(p_sender uuid, p_mp uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; mp outreach_master_prompts%rowtype; me_email text; pol jsonb; cid uuid;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_NOT_FOUND'; end if;
  select * into mp from outreach_master_prompts where id = p_mp and workspace_id = s.workspace_id;
  if not found then raise exception 'E_NOT_FOUND: master prompt not found'; end if;
  select lower(email) into me_email from auth.users where id = auth.uid();
  if not ((s.owner_user_id is not null and s.owner_user_id = auth.uid()) or (me_email is not null and lower(coalesce(s.owner_email::text, '')) = me_email)) then
    raise exception 'E_FORBIDDEN: only the owner of this LinkedIn account can give consent here. Send them a consent link instead';
  end if;
  pol := outreach__ai_policy(s.workspace_id, s.client_id, null, s.id);
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'replaced' where sender_id = s.id and master_prompt_id = mp.id and revoked_at is null;
  insert into outreach_ai_reply_consent(workspace_id, sender_id, master_prompt_id, master_prompt_version, granted_by_email, granted_via, scope, evidence, granted_at, expires_at)
  values (s.workspace_id, s.id, mp.id, mp.version, coalesce(me_email, s.owner_email::text), 'owner_is_operator',
          jsonb_build_object('daily_cap', (pol->>'max_ai_sends_per_sender_day')::int, 'delay_min_s', (pol->>'delay_min_s')::int, 'delay_max_s', (pol->>'delay_max_s')::int),
          jsonb_build_object('user_id', auth.uid(), 'at', now()), now(), now() + interval '12 months')
  returning id into cid;
  perform outreach_audit(s.workspace_id, 'ai_reply.consent_granted', 'sender', s.id::text, jsonb_build_object('consent_id', cid, 'via', 'owner_is_operator', 'version', mp.version), 'user');
  return jsonb_build_object('id', cid, 'sender_id', s.id, 'master_prompt_id', mp.id, 'master_prompt_version', mp.version);
end $$;

-- ============================================================================= graduation, metrics, reports
create or replace function outreach_ai_reply_graduation(p_ws uuid, p_mp uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; cid uuid;
begin
  perform outreach_require(p_ws, 'member');
  select * into mp from outreach_master_prompts where id = p_mp and workspace_id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  cid := outreach__ai_scope_client(p_ws, mp.scope, mp.scope_id);
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  return outreach__ai_graduation_calc(p_mp);
end $$;

create or replace function outreach__ai_totals(p_runs outreach_ai_reply_runs[]) returns jsonb
language sql stable set search_path = public, extensions as $$
  with r as (select * from unnest(p_runs))
  select jsonb_build_object(
    'runs', count(*),
    'sent_ai', count(*) filter (where status = 'sent' and sent_origin = 'ai_autopilot'),
    'sent_human_draft', count(*) filter (where status = 'sent' and sent_origin in ('ai_draft_sent','ai_edited')),
    'escalated', count(*) filter (where status = 'escalated'),
    'no_reply', count(*) filter (where status = 'no_reply' or (status = 'draft_ready' and decision = 'no_reply')),
    'cancelled', count(*) filter (where status = 'cancelled'),
    'expired', count(*) filter (where status = 'expired'),
    'failed', count(*) filter (where status = 'failed'),
    'superseded', count(*) filter (where status = 'superseded'),
    'draft_p50_s', round((percentile_cont(0.5) within group (order by extract(epoch from (timings->>'drafted_at')::timestamptz - (timings->>'inbound_at')::timestamptz))
                          filter (where timings ? 'drafted_at' and timings ? 'inbound_at'))::numeric),
    'draft_p95_s', round((percentile_cont(0.95) within group (order by extract(epoch from (timings->>'drafted_at')::timestamptz - (timings->>'inbound_at')::timestamptz))
                          filter (where timings ? 'drafted_at' and timings ? 'inbound_at'))::numeric),
    'send_p50_s', round((percentile_cont(0.5) within group (order by extract(epoch from (timings->>'sent_at')::timestamptz - (timings->>'inbound_at')::timestamptz))
                          filter (where status = 'sent' and timings ? 'sent_at' and timings ? 'inbound_at'))::numeric),
    'light_edit_share', round((count(*) filter (where sent_origin in ('ai_draft_sent','ai_edited') and edit_distance <= 0.15))::numeric
                              / nullif(count(*) filter (where sent_origin in ('ai_draft_sent','ai_edited')), 0), 3),
    'bot_question_rate', round((count(*) filter (where sent_origin = 'ai_autopilot' and drew_bot_question))::numeric
                               / nullif(count(*) filter (where sent_origin = 'ai_autopilot'), 0), 4),
    'hold_cancel_rate', round((count(*) filter (where timings ? 'scheduled_at' and (sent_origin = 'ai_edited' or (status = 'cancelled' and cancelled_by is not null))))::numeric
                              / nullif(count(*) filter (where timings ? 'scheduled_at' and status in ('sent','cancelled')), 0), 3))
  from r
$$;

create or replace function outreach_ai_reply_metrics(p_ws uuid, p_from date, p_to date, p_group text default 'none') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare tz text; t0 timestamptz; t1 timestamptz; runs outreach_ai_reply_runs[]; groups jsonb := '[]'::jsonb;
begin
  perform outreach_require(p_ws, 'member');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'E_PAYLOAD_INVALID: pick a range of up to a year'; end if;
  tz := coalesce(outreach_ws_tz(p_ws), 'UTC');
  t0 := (p_from::timestamp) at time zone tz; t1 := ((p_to + 1)::timestamp) at time zone tz;
  select coalesce(array_agg(r), '{}') into runs from outreach_ai_reply_runs r
   where r.workspace_id = p_ws and r.created_at >= t0 and r.created_at < t1 and outreach_client_visible(p_ws, r.client_id);
  if coalesce(p_group, 'none') <> 'none' then
    if p_group not in ('sequence','sender','stage','master_prompt','client') then raise exception 'E_PAYLOAD_INVALID: group by sequence, sender, stage, master_prompt or client'; end if;
    select coalesce(jsonb_agg(g.j order by (g.j->>'runs')::int desc), '[]'::jsonb) into groups from (
      select outreach__ai_totals(array_agg(u)) || jsonb_build_object('key', k.key, 'label', coalesce(k.label, 'None')) j
        from unnest(runs) u
        cross join lateral (select case p_group when 'sequence' then u.sequence_id::text when 'sender' then u.sender_id::text when 'stage' then u.stage_after
                                                 when 'master_prompt' then u.master_prompt_id::text else u.client_id::text end as key,
                                   case p_group when 'sequence' then (select name from outreach_sequences where id = u.sequence_id)
                                                when 'sender' then (select display_name from outreach_senders where id = u.sender_id)
                                                when 'stage' then u.stage_after
                                                when 'master_prompt' then (select outreach__ai_scope_label(mp.scope, mp.scope_id) || ' v' || u.master_prompt_version from outreach_master_prompts mp where mp.id = u.master_prompt_id)
                                                else (select name from outreach_clients where id = u.client_id) end as label) k
       group by k.key, k.label) g;
  end if;
  return jsonb_build_object('totals', outreach__ai_totals(runs), 'groups', groups,
    'escalation_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n) order by x.n desc) from (
       select e.reason, count(*) n from unnest(runs) u cross join lateral unnest(u.escalation_reasons) e(reason) where u.status in ('escalated','draft_ready') group by 1) x), '[]'::jsonb),
    'cancel_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n) order by x.n desc) from (
       select u.cancel_reason reason, count(*) n from unnest(runs) u where u.status = 'cancelled' and u.cancel_reason is not null group by 1) x), '[]'::jsonb));
end $$;

create or replace function outreach_ai_reply_cancel_report(p_ws uuid, p_days int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return coalesce((select jsonb_agg(jsonb_build_object('rule_applied', x.rule_applied, 'reason', x.reason, 'n', x.n, 'run_ids', to_jsonb(x.ids)) order by x.n desc)
    from (select r.rule_applied, coalesce(r.cancel_reason, 'edited') reason, count(*) n, (array_agg(r.id order by r.updated_at desc))[1:20] ids
            from outreach_ai_reply_runs r
           where r.workspace_id = p_ws and outreach_client_visible(p_ws, r.client_id)
             and r.updated_at > now() - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)))
             and ((r.status = 'cancelled' and r.cancelled_by is not null and r.cancel_reason <> 'dismissed') or r.sent_origin = 'ai_edited')
           group by 1, 2) x), '[]'::jsonb);
end $$;

-- ============================================================================= scenarios
create or replace function outreach__ai_scenario_json(s outreach_ai_reply_scenarios) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', s.id, 'workspace_id', s.workspace_id, 'master_prompt_id', s.master_prompt_id, 'name', s.name, 'turns', s.turns,
    'expected', s.expected, 'last_result', s.last_result, 'last_version', s.last_version, 'last_run_at', s.last_run_at, 'passed', s.passed,
    'created_at', s.created_at, 'updated_at', s.updated_at)
$$;

create or replace function outreach_ai_reply_scenarios_list(p_ws uuid, p_mp uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return coalesce((select jsonb_agg(outreach__ai_scenario_json(s) order by s.created_at)
    from outreach_ai_reply_scenarios s left join outreach_master_prompts mp on mp.id = s.master_prompt_id
   where s.workspace_id = p_ws
     -- no prompt given = the workspace prompt's scenarios (unassigned or on the workspace prompt), never an override's
     and (case when p_mp is null then s.master_prompt_id is null or mp.scope = 'workspace'
               else s.master_prompt_id = p_mp or (s.master_prompt_id is null and exists (select 1 from outreach_master_prompts w where w.id = p_mp and w.scope = 'workspace')) end)
     and outreach_client_visible(p_ws, case mp.scope when 'client' then mp.scope_id when 'sequence' then (select client_id from outreach_sequences where id = mp.scope_id) end)), '[]'::jsonb);
end $$;

create or replace function outreach_ai_reply_scenario_save(p_ws uuid, p_id uuid, p_mp uuid, p_name text, p_turns jsonb, p_expected jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_ai_reply_scenarios%rowtype; mp outreach_master_prompts%rowtype; cid uuid;
begin
  perform outreach_require(p_ws, 'manager');
  if p_mp is not null then
    select * into mp from outreach_master_prompts where id = p_mp and workspace_id = p_ws;
    if not found then raise exception 'E_NOT_FOUND: master prompt not found'; end if;
    cid := outreach__ai_scope_client(p_ws, mp.scope, mp.scope_id);
  end if;
  if not outreach_client_visible(p_ws, cid) then raise exception 'E_NOT_FOUND'; end if;
  -- updating: the scenario's current prompt must be visible too (a key limited to client A cannot move client B's scenarios)
  if p_id is not null then
    select mp_.* into mp from outreach_ai_reply_scenarios sc_ left join outreach_master_prompts mp_ on mp_.id = sc_.master_prompt_id where sc_.id = p_id and sc_.workspace_id = p_ws;
    if mp.id is not null and not outreach_client_visible(p_ws, outreach__ai_scope_client(p_ws, mp.scope, mp.scope_id)) then raise exception 'E_NOT_FOUND'; end if;
  end if;
  if jsonb_typeof(p_turns) <> 'array' or jsonb_array_length(p_turns) = 0 or jsonb_array_length(p_turns) > 30
     or exists (select 1 from jsonb_array_elements(p_turns) t where coalesce(t->>'from', '') not in ('prospect','us') or length(coalesce(t->>'text', '')) not between 1 and 4000) then
    raise exception 'E_PAYLOAD_INVALID: turns are 1–30 lines of {from: prospect|us, text}';
  end if;
  if p_expected is not null and (jsonb_typeof(p_expected) <> 'array'
     or exists (select 1 from jsonb_array_elements(p_expected) e where coalesce(e->>'decision', '') not in ('send','escalate','no_reply') or (e->>'after_turn') is null)) then
    raise exception 'E_PAYLOAD_INVALID: expected is [{after_turn, decision: send|escalate|no_reply, stage_after?}]';
  end if;
  if p_id is null then
    insert into outreach_ai_reply_scenarios(workspace_id, master_prompt_id, name, turns, expected, created_by)
    values (p_ws, p_mp, left(btrim(p_name), 120), p_turns, coalesce(p_expected, '[]'::jsonb), auth.uid()) returning * into s;
  else
    update outreach_ai_reply_scenarios set master_prompt_id = p_mp, name = left(btrim(p_name), 120), turns = p_turns, expected = coalesce(p_expected, '[]'::jsonb),
           passed = null, last_result = null, last_version = null, updated_at = now()
     where id = p_id and workspace_id = p_ws returning * into s;
    if s.id is null then raise exception 'E_NOT_FOUND'; end if;
  end if;
  return outreach__ai_scenario_json(s);
exception when check_violation then raise exception 'E_PAYLOAD_INVALID: name is 1–120 characters';
end $$;

create or replace function outreach_ai_reply_scenario_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_ai_reply_scenarios%rowtype; cid uuid; mp outreach_master_prompts%rowtype;
begin
  select * into s from outreach_ai_reply_scenarios where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if s.master_prompt_id is not null then
    select * into mp from outreach_master_prompts where id = s.master_prompt_id;
    cid := outreach__ai_scope_client(s.workspace_id, mp.scope, mp.scope_id);
  end if;
  if not outreach_client_visible(s.workspace_id, cid) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_ai_reply_scenarios where id = p_id;
end $$;

-- ============================================================================= allowance + platform admin
create or replace function outreach_ai_reply_pool(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  -- workspace-level figure (no client data): any member of the workspace may see it
  if not outreach_client_visible(p_ws, null) then raise exception 'E_NOT_FOUND'; end if;
  return outreach__ai_pool(p_ws);
end $$;

create or replace function outreach_ai_reply_admin_list() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare dflt jsonb;
begin
  perform platform_require_admin();
  select value into dflt from outreach_flags where key = 'ai_reply_monthly_limit';
  return coalesce((select jsonb_agg(jsonb_build_object('workspace_id', w.id, 'workspace_name', w.name,
            'default_limit', case when jsonb_typeof(dflt) = 'number' then (dflt #>> '{}')::int end,
            'graduation_bypass', coalesce(a.graduation_bypass, false), 'monthly_limit', a.monthly_limit, 'note', a.note, 'updated_at', a.updated_at,
            'used_this_month', (outreach__ai_pool(w.id)->>'used')::int, 'own_key', (outreach__ai_pool(w.id)->>'own_key')::boolean) order by w.name)
    from outreach_workspaces w left join outreach_ai_reply_workspace a on a.workspace_id = w.id where w.deleted_at is null), '[]'::jsonb);
end $$;

create or replace function outreach_ai_reply_admin_set(p_ws uuid, p_bypass boolean, p_monthly_limit int, p_note text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform platform_require_admin();
  if length(btrim(coalesce(p_note, ''))) < 3 then raise exception 'E_PAYLOAD_INVALID: add a note'; end if;
  if p_monthly_limit is not null and p_monthly_limit < 0 then raise exception 'E_PAYLOAD_INVALID: the limit cannot be negative'; end if;
  insert into outreach_ai_reply_workspace(workspace_id, graduation_bypass, monthly_limit, note, updated_by, updated_at)
  values (p_ws, coalesce(p_bypass, false), p_monthly_limit, left(p_note, 500), auth.uid(), now())
  on conflict (workspace_id) do update set graduation_bypass = excluded.graduation_bypass, monthly_limit = excluded.monthly_limit,
    note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  perform platform_audit('outreach.ai_reply_admin_set', p_ws, jsonb_build_object('graduation_bypass', p_bypass, 'monthly_limit', p_monthly_limit, 'note', p_note));
  perform outreach_audit(p_ws, 'ai_reply.admin_set', 'workspace', p_ws::text, jsonb_build_object('graduation_bypass', p_bypass, 'monthly_limit', p_monthly_limit, 'note', p_note), 'platform_admin');
  return outreach__ai_pool(p_ws) || jsonb_build_object('graduation_bypass', coalesce(p_bypass, false), 'monthly_limit', p_monthly_limit);
end $$;

-- ============================================================================= grants
-- New functions get EXECUTE for anon / authenticated through Supabase's default privileges. Close everything to
-- anon, keep the app RPCs for signed-in users, and make engine / helper functions service-only.
do $$
declare f record;
  app_fns text[] := array[
    'outreach_ai_reply_chat_state','outreach_ai_reply_set_chat_mode','outreach_ai_reply_resume_chat','outreach_ai_reply_cancel',
    'outreach_ai_reply_apply_no_reply','outreach_ai_reply_runs_list','outreach_ai_reply_run_get','outreach_reply_policy_list',
    'outreach_reply_policy_set','outreach_reply_policy_clear','outreach_master_prompt_template','outreach_master_prompt_get',
    'outreach_master_prompt_save','outreach_master_prompt_versions','outreach_master_prompt_list','outreach_master_prompt_delete',
    'outreach_ai_consent_list','outreach_ai_consent_revoke','outreach_ai_consent_grant_operator','outreach_ai_reply_graduation',
    'outreach_ai_reply_metrics','outreach_ai_reply_cancel_report','outreach_ai_reply_scenarios_list','outreach_ai_reply_scenario_save',
    'outreach_ai_reply_scenario_delete','outreach_ai_reply_pool','outreach_ai_reply_admin_list','outreach_ai_reply_admin_set',
    'outreach_ai_reply_defaults','outreach_ai_scope_client_of'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (p.proname like 'outreach\_ai\_%' or p.proname like 'outreach\_\_ai\_%' or p.proname like 'outreach\_\_mp\_%'
                   or p.proname like 'outreach\_master\_prompt\_%' or p.proname like 'outreach\_reply\_policy\_%'
                   or p.proname in ('outreach__norm_text','outreach__text_sha','outreach__eu_eea','outreach__chat_sequence',
                                    'outreach__compile_master_prompt','outreach_trg_message_origin','outreach_trg_ai_run_mirror')) loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then
      execute format('grant execute on function %s to authenticated', f.sig);
    else
      execute format('revoke execute on function %s from authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
