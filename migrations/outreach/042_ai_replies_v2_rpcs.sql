-- 042 — AI replies v2: RPCs for the app, the MCP connector and the API (docs/outreach/AI-REPLIES-V2-CONTRACT.md §5), grants.
-- Every RPC is security definer, checks outreach_require() then outreach_client_visible() (access-audit rule). Needs 041. Idempotent.

-- ============================================================================= scope helpers (library scope added)
create or replace function outreach__ai_scope_client(p_ws uuid, p_scope text, p_scope_id uuid) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare cid uuid; ok boolean;
begin
  if p_scope in ('workspace', 'library') then return null;
  elsif p_scope = 'client' then select id, true into cid, ok from outreach_clients where id = p_scope_id and workspace_id = p_ws;
  elsif p_scope = 'sequence' then select client_id, true into cid, ok from outreach_sequences where id = p_scope_id and workspace_id = p_ws;
  elsif p_scope = 'sender' then select client_id, true into cid, ok from outreach_senders where id = p_scope_id and workspace_id = p_ws and deleted_at is null;
  else raise exception 'E_PAYLOAD_INVALID: unknown scope %', p_scope;
  end if;
  if not coalesce(ok, false) then raise exception 'E_NOT_FOUND: % not found', p_scope; end if;
  return cid;
end $$;

create or replace function outreach__ai_scope_label(p_scope text, p_scope_id uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case p_scope
    when 'workspace' then 'Workspace'
    when 'library' then 'Library'
    when 'client' then 'Client · ' || coalesce((select name from outreach_clients where id = p_scope_id), '?')
    when 'sequence' then 'Sequence · ' || coalesce((select name from outreach_sequences where id = p_scope_id), '?')
    when 'sender' then 'Sender · ' || coalesce((select display_name from outreach_senders where id = p_scope_id), '?')
    else p_scope end
$$;

-- the sequence a caller may touch: checks membership + client scope, returns the row
create or replace function outreach__ai_seq_for(p_sequence uuid, p_role text) returns outreach_sequences
language plpgsql stable security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype;
begin
  select * into q from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(q.workspace_id, p_role);
  if not outreach_client_visible(q.workspace_id, q.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return q;
end $$;

-- ============================================================================= prompt json + versions + change bookkeeping
create or replace function outreach__mp_cards(p_mp uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'position', position, 'title', title, 'when_text', when_text, 'do_text', do_text, 'enabled', enabled, 'updated_at', updated_at) order by position, updated_at), '[]'::jsonb)
    from outreach_master_prompt_scenarios where master_prompt_id = p_mp
$$;
create or replace function outreach__mp_faqs(p_mp uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'question', question, 'answer', answer, 'source', source, 'enabled', enabled, 'created_at', created_at) order by created_at), '[]'::jsonb)
    from outreach_master_prompt_faqs where master_prompt_id = p_mp
$$;
create or replace function outreach__mp_knowledge(p_mp uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title, 'url', s.url, 'status', s.status, 'error', s.error, 'pages', s.pages, 'chunks', s.chunks, 'crawled_at', s.crawled_at) order by s.title), '[]'::jsonb)
    from outreach_master_prompts mp join outreach_knowledge_sources s on s.id = any(mp.knowledge_source_ids) where mp.id = p_mp
$$;

create or replace function outreach__mp_json(mp outreach_master_prompts, p_version int default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v outreach_master_prompt_versions%rowtype; who text; base jsonb; sit text;
begin
  select coalesce(m.display_name, m.email::text) into who from outreach_members m where m.workspace_id = mp.workspace_id and m.user_id = mp.updated_by;
  sit := coalesce(mp.sections->>'situations', '');
  base := jsonb_build_object('exists', true, 'id', mp.id, 'scope', mp.scope, 'scope_id', mp.scope_id, 'sequence_id', mp.sequence_id, 'name', mp.name,
    'scope_label', case mp.scope when 'sequence' then outreach__ai_scope_label('sequence', mp.sequence_id) else 'Library · ' || coalesce(mp.name, '?') end,
    'substantive_version', mp.substantive_version, 'graduated', mp.graduated_at is not null, 'inherited', null, 'template', outreach_master_prompt_template(),
    'current_version', mp.version, 'copied_from_prompt_id', mp.copied_from_prompt_id, 'copied_from_version', mp.copied_from_version,
    'scenarios', outreach__mp_cards(mp.id), 'faqs', outreach__mp_faqs(mp.id), 'knowledge', outreach__mp_knowledge(mp.id), 'knowledge_source_ids', to_jsonb(mp.knowledge_source_ids),
    'stop_present', mp.body ilike '%## Stop when%',
    'situations_text_convertible', mp.editor_mode = 'guided' and btrim(sit) not in ('', '-') and not exists (select 1 from outreach_master_prompt_scenarios where master_prompt_id = mp.id));
  if p_version is not null and p_version <> mp.version then
    select * into v from outreach_master_prompt_versions where master_prompt_id = mp.id and version = p_version;
    if not found then raise exception 'E_NOT_FOUND: version % not found', p_version; end if;
    return base || jsonb_build_object('editor_mode', v.editor_mode, 'version', v.version, 'body', v.body, 'sections', v.sections,
      'settings', outreach__mp_default_settings() || v.settings, 'updated_at', v.created_at, 'updated_by_name', who, 'scenarios', coalesce(v.scenarios, '[]'::jsonb), 'faqs', coalesce(v.faqs, '[]'::jsonb));
  end if;
  return base || jsonb_build_object('editor_mode', mp.editor_mode, 'version', mp.version, 'body', mp.body, 'sections', mp.sections,
    'settings', outreach__mp_default_settings() || mp.settings, 'updated_at', mp.updated_at, 'updated_by_name', who);
end $$;

-- scheduled replies drafted on the old version are redrafted (§1.4); warm-up restarts at ≥ 10 (§4.3)
create or replace function outreach__mp_after_change(p_mp uuid, p_kind text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; r record; eff jsonb; pol jsonb; n int := 0;
begin
  select * into mp from outreach_master_prompts where id = p_mp;
  if mp.scope <> 'sequence' or p_kind <> 'substantive' then return 0; end if;
  update outreach_sequence_reply_settings set warmup_remaining = greatest(warmup_remaining, 10), updated_at = now() where sequence_id = mp.sequence_id;
  for r in select x.id, x.chat_id, x.inbound_message_ids, x.timings from outreach_ai_reply_runs x where x.sequence_id = mp.sequence_id and x.status = 'scheduled' loop
    perform outreach__ai_chat_lock(r.chat_id);
    update outreach_ai_reply_runs set status = 'superseded', error = 'prompt_changed' where id = r.id and status = 'scheduled';
    if found then
      eff := outreach__ai_effective(r.chat_id); pol := eff->'policy';
      if eff->>'mode' <> 'off' then perform outreach__ai_open_run(r.chat_id, r.inbound_message_ids, 30, 60, eff->>'mode', (r.timings->>'inbound_at')::timestamptz); end if;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- new version of a prompt: recompile (guided), bump, snapshot cards + Q&A, bookkeeping
create or replace function outreach__mp_bump(p_mp uuid, p_kind text, p_note text, p_editor_mode text default null, p_body text default null, p_sections jsonb default null, p_settings jsonb default null) returns outreach_master_prompts
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; body_ text; em text; sec jsonb; st jsonb; nv int;
begin
  select * into mp from outreach_master_prompts where id = p_mp for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  em := coalesce(p_editor_mode, mp.editor_mode);
  sec := case when em = 'guided' then coalesce(p_sections, mp.sections) else mp.sections end;
  st := coalesce(p_settings, mp.settings);
  if em = 'guided' then body_ := outreach__compile_master_prompt(sec, outreach__mp_default_settings() || st, outreach__mp_cards(p_mp));
  else body_ := btrim(coalesce(p_body, mp.body)); end if;
  if length(body_) < 20 then raise exception 'E_PAYLOAD_INVALID: the prompt is too short'; end if;
  if length(body_) > 40000 then raise exception 'E_PAYLOAD_INVALID: the prompt is longer than 40,000 characters'; end if;
  nv := mp.version + 1;
  update outreach_master_prompts set editor_mode = em, version = nv, body = body_, sections = sec, settings = st,
         substantive_version = case when p_kind = 'substantive' then nv else substantive_version end,
         substantive_at = case when p_kind = 'substantive' then now() else substantive_at end,
         updated_by = auth.uid(), updated_at = now()
   where id = p_mp returning * into mp;
  insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by, scenarios, faqs)
  values (mp.id, nv, em, body_, sec, st, p_kind, left(p_note, 500), auth.uid(), outreach__mp_cards(p_mp), outreach__mp_faqs(p_mp));
  perform outreach__mp_after_change(p_mp, p_kind);
  perform outreach_audit(mp.workspace_id, 'ai_reply.master_prompt_saved', 'master_prompt', mp.id::text,
    jsonb_build_object('sequence_id', mp.sequence_id, 'version', nv, 'change_kind', p_kind, 'editor_mode', em, 'note', p_note), 'user');
  return mp;
end $$;

-- ============================================================================= sequence settings (§1, §4)
create or replace function outreach_sequence_ai_summary(p_sequence uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; st jsonb;
begin
  q := outreach__ai_seq_for(p_sequence, 'member');
  select * into srs from outreach_sequence_reply_settings where sequence_id = p_sequence;
  select mp.settings->'stages' into st from outreach_master_prompts mp where mp.id = srs.master_prompt_id;
  return jsonb_build_object(
    'mode', coalesce(srs.mode::text, 'draft'), 'effective_mode', case when q.status = 'active' then coalesce(srs.mode::text, 'draft') when coalesce(srs.mode::text, 'draft') = 'off' then 'off' else 'draft' end,
    'warmup_remaining', srs.warmup_remaining, 'downgraded_at', srs.downgraded_at,
    'open_conversations', (select count(*) from outreach_chats c where c.reply_sequence_id = p_sequence and c.ai_handed_off_at is null and not c.archived and c.ai_session_started_at is not null),
    'open_by_stage', coalesce((select jsonb_agg(jsonb_build_object('stage', x.stage, 'label', x.label, 'n', x.n) order by x.pos) from (
        select coalesce(c.conversation_stage, case when c.ai_session_kind = 'dormant' then 're_engage' else 'engage' end) stage,
               coalesce((select o.x->>'label' from jsonb_array_elements(coalesce(st, outreach__mp_default_settings()->'stages')) with ordinality o(x, i) where o.x->>'key' = c.conversation_stage),
                        case when c.ai_session_kind = 'dormant' and c.conversation_stage is null then 'Re-engage' else 'Engage' end) label,
               coalesce((select o.i::int from jsonb_array_elements(coalesce(st, outreach__mp_default_settings()->'stages')) with ordinality o(x, i) where o.x->>'key' = c.conversation_stage), 0) pos,
               count(*) n
          from outreach_chats c where c.reply_sequence_id = p_sequence and c.ai_handed_off_at is null and not c.archived and c.ai_session_started_at is not null group by 1, 2, 3) x), '[]'::jsonb),
    'handed_off_7d', (select count(*) from outreach_chats c where c.reply_sequence_id = p_sequence and c.ai_handed_off_at > now() - interval '7 days'),
    'handed_off_open', (select count(*) from outreach_chats c where c.reply_sequence_id = p_sequence and c.ai_handed_off_at is not null and not c.archived),
    'drafts_waiting', (select count(*) from outreach_ai_reply_runs r where r.sequence_id = p_sequence and r.status = 'draft_ready' and r.decision = 'send'),
    'unanswered_open', (select count(*) from outreach_ai_unanswered_questions u where u.sequence_id = p_sequence and u.status = 'open'));
end $$;

create or replace function outreach_sequence_ai_replies_get(p_sequence uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; mp outreach_master_prompts%rowtype; me_email text; senders jsonb; pool uuid[];
begin
  q := outreach__ai_seq_for(p_sequence, 'member');
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  select * into mp from outreach_master_prompts where id = srs.master_prompt_id;
  select lower(email) into me_email from auth.users where id = auth.uid();
  -- the LinkedIn senders this sequence sends from (the old pool column and the per-channel pools)
  select coalesce(array_agg(distinct x), '{}') into pool from (
    select unnest(q.sender_pool) x union select (jsonb_array_elements_text(coalesce(q.sender_pools->'LINKEDIN', '[]'::jsonb)))::uuid) t;
  select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'sender_name', s.display_name, 'owner_email', s.owner_email,
           'owner_is_me', (s.owner_user_id = auth.uid()) or (me_email is not null and lower(coalesce(s.owner_email::text, '')) = me_email),
           'consent', case when k.id is not null then 'granted' when pl.id is not null then 'pending' else 'missing' end,
           'consent_id', k.id, 'granted_via', k.granted_via, 'pending_link_id', pl.id, 'pending_link_expires_at', pl.expires_at) order by s.display_name), '[]'::jsonb)
    into senders
    from outreach_senders s
    left join lateral (select id, granted_via from outreach_ai_reply_consent c where c.sender_id = s.id and c.revoked_at is null and c.expires_at > now() limit 1) k on true
    left join lateral (select id, expires_at from outreach_ai_reply_consent_links l where l.sender_id = s.id and l.used_at is null and l.cancelled_at is null and l.expires_at > now() order by created_at desc limit 1) pl on true
   where s.id = any(pool) and s.deleted_at is null and s.provider = 'LINKEDIN';
  return jsonb_build_object(
    'sequence_id', p_sequence, 'sequence_name', q.name, 'sequence_status', q.status, 'mode', srs.mode, 'master_prompt_id', srs.master_prompt_id,
    'prompt', outreach__mp_json(mp, null),
    'pitch_after_replies', srs.pitch_after_replies, 'max_ai_replies_per_chat', srs.max_ai_replies_per_chat, 'warmup_remaining', srs.warmup_remaining,
    'handoff_stage_id', srs.handoff_stage_id, 'delay_min_s', srs.delay_min_s, 'delay_max_s', srs.delay_max_s, 'debounce_quiet_s', srs.debounce_quiet_s,
    'debounce_max_s', srs.debounce_max_s, 'stale_after_h', srs.stale_after_h, 'languages', to_jsonb(srs.languages), 'disclosure', srs.disclosure,
    'blocked_countries', case when srs.blocked_countries is null then null else to_jsonb(srs.blocked_countries) end, 'blocked_countries_default', to_jsonb(outreach__eu_eea()),
    'returning_after_days', srs.returning_after_days, 'dormant_after_days', srs.dormant_after_days, 'inactivity_days', srs.inactivity_days,
    'downgraded_at', srs.downgraded_at, 'downgrade_reason', srs.downgrade_reason, 'updated_at', srs.updated_at,
    'senders', senders, 'workspace_cap', (select max_ai_sends_per_sender_day from outreach_workspace_reply_settings where workspace_id = q.workspace_id))
    || outreach_sequence_ai_summary(p_sequence);
end $$;

create or replace function outreach_sequence_ai_replies_set(p_sequence uuid, p_patch jsonb, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; bad text[]; was text; n int; applies int;
  allowed text[] := array['mode','pitch_after_replies','max_ai_replies_per_chat','handoff_stage_id','delay_min_s','delay_max_s','debounce_quiet_s','debounce_max_s',
                          'stale_after_h','languages','disclosure','blocked_countries','returning_after_days','dormant_after_days','inactivity_days'];
begin
  q := outreach__ai_seq_for(p_sequence, 'manager');
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'E_PAYLOAD_INVALID: patch must be an object'; end if;
  select array_agg(x) into bad from jsonb_object_keys(p_patch) x where not (x = any(allowed));
  if bad is not null then raise exception 'E_PAYLOAD_INVALID: unknown field(s) %', array_to_string(bad, ', '); end if;
  if p_patch ? 'mode' and coalesce(p_patch->>'mode', '') not in ('off','draft','autopilot') then raise exception 'E_PAYLOAD_INVALID: mode is off, draft or autopilot'; end if;
  if p_patch ? 'languages' and (jsonb_typeof(p_patch->'languages') <> 'array' or jsonb_array_length(p_patch->'languages') = 0
     or exists (select 1 from jsonb_array_elements_text(p_patch->'languages') x where x !~ '^[a-z]{2,3}$')) then raise exception 'E_PAYLOAD_INVALID: languages are ISO codes like en or hi'; end if;
  if p_patch ? 'blocked_countries' and jsonb_typeof(p_patch->'blocked_countries') = 'array'
     and exists (select 1 from jsonb_array_elements_text(p_patch->'blocked_countries') c where c !~ '^[A-Z]{2}$') then raise exception 'E_PAYLOAD_INVALID: countries are two-letter codes like DE or FR'; end if;
  if p_patch ? 'handoff_stage_id' and coalesce(p_patch->>'handoff_stage_id', '') <> ''
     and not exists (select 1 from outreach_stages where id = (p_patch->>'handoff_stage_id')::uuid and workspace_id = q.workspace_id) then raise exception 'E_PAYLOAD_INVALID: hand-off stage not found'; end if;
  if srs.downgraded_at is not null and p_patch->>'mode' = 'autopilot' and length(btrim(coalesce(p_note, ''))) < 3 then
    raise exception 'E_PAYLOAD_INVALID: Auto was switched off automatically (%). Add a note saying why it can go back on', srs.downgrade_reason;
  end if;
  was := srs.mode::text;
  select * into srs from outreach_sequence_reply_settings where sequence_id = p_sequence for update;
  begin
    update outreach_sequence_reply_settings set
      mode = case when p_patch ? 'mode' then (p_patch->>'mode')::outreach_reply_mode_t else mode end,
      pitch_after_replies = case when p_patch ? 'pitch_after_replies' then (p_patch->>'pitch_after_replies')::smallint else pitch_after_replies end,
      max_ai_replies_per_chat = case when p_patch ? 'max_ai_replies_per_chat' then (p_patch->>'max_ai_replies_per_chat')::smallint else max_ai_replies_per_chat end,
      handoff_stage_id = case when p_patch ? 'handoff_stage_id' then nullif(p_patch->>'handoff_stage_id', '')::uuid else handoff_stage_id end,
      delay_min_s = case when p_patch ? 'delay_min_s' then (p_patch->>'delay_min_s')::int else delay_min_s end,
      delay_max_s = case when p_patch ? 'delay_max_s' then (p_patch->>'delay_max_s')::int else delay_max_s end,
      debounce_quiet_s = case when p_patch ? 'debounce_quiet_s' then (p_patch->>'debounce_quiet_s')::int else debounce_quiet_s end,
      debounce_max_s = case when p_patch ? 'debounce_max_s' then (p_patch->>'debounce_max_s')::int else debounce_max_s end,
      stale_after_h = case when p_patch ? 'stale_after_h' then (p_patch->>'stale_after_h')::int else stale_after_h end,
      languages = case when p_patch ? 'languages' then array(select jsonb_array_elements_text(p_patch->'languages')) else languages end,
      disclosure = case when p_patch ? 'disclosure' then nullif(btrim(coalesce(p_patch->>'disclosure', '')), '') else disclosure end,
      blocked_countries = case when p_patch ? 'blocked_countries' then case when jsonb_typeof(p_patch->'blocked_countries') = 'array' then array(select jsonb_array_elements_text(p_patch->'blocked_countries')) end else blocked_countries end,
      returning_after_days = case when p_patch ? 'returning_after_days' then (p_patch->>'returning_after_days')::smallint else returning_after_days end,
      dormant_after_days = case when p_patch ? 'dormant_after_days' then (p_patch->>'dormant_after_days')::smallint else dormant_after_days end,
      inactivity_days = case when p_patch ? 'inactivity_days' then nullif(p_patch->>'inactivity_days', '')::smallint else inactivity_days end,
      downgraded_at = case when p_patch->>'mode' = 'autopilot' then null else downgraded_at end,
      downgrade_reason = case when p_patch->>'mode' = 'autopilot' then null else downgrade_reason end,
      breaker_reset_at = case when p_patch->>'mode' = 'autopilot' and was <> 'autopilot' then now() else breaker_reset_at end,
      updated_by = auth.uid(), updated_at = now()
     where sequence_id = p_sequence returning * into srs;
  exception
    when check_violation then raise exception 'E_PAYLOAD_INVALID: a value is out of range (pitch after 0–5, 1–10 replies per conversation, delay 1–60 min with max above min, debounce 30–600 s / 60–1800 s, stale 1–72 h, disclosure up to 200 characters, returning 1–30 days, dormant 7–365 days above returning, quiet 1–60 days)';
    when invalid_text_representation then raise exception 'E_PAYLOAD_INVALID: a number field holds text';
  end;
  if p_patch->>'mode' in ('off', 'draft') then n := outreach_ai_reply_demote_scheduled(p_sequence, 'policy_changed'); end if;
  select count(*) into applies from outreach_chats c where c.reply_sequence_id = p_sequence and c.ai_handed_off_at is null and not c.archived and c.ai_session_started_at is not null;
  perform outreach_audit(q.workspace_id, 'ai_reply.sequence_settings', 'sequence', p_sequence::text, jsonb_build_object('patch', p_patch, 'note', p_note, 'from_mode', was, 'demoted', n), 'user');
  return outreach_sequence_ai_replies_get(p_sequence) || jsonb_build_object('applies_to', applies, 'demoted', coalesce(n, 0));
end $$;

create or replace function outreach_workspace_reply_settings_get(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare w outreach_workspace_reply_settings%rowtype;
begin
  perform outreach_require(p_ws, 'member');
  if not outreach_client_visible(p_ws, null) then raise exception 'E_NOT_FOUND'; end if;   -- workspace-level figures, no client data
  select * into w from outreach_workspace_reply_settings where workspace_id = p_ws;
  return jsonb_build_object('workspace_id', p_ws, 'max_ai_sends_per_sender_day', coalesce(w.max_ai_sends_per_sender_day, 25), 'default_prompt_id', w.default_prompt_id,
    'default_prompt_name', (select name from outreach_master_prompts where id = w.default_prompt_id), 'updated_at', w.updated_at);
end $$;

create or replace function outreach_workspace_reply_settings_set(p_ws uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare bad text[];
begin
  perform outreach_require(p_ws, 'manager');
  select array_agg(x) into bad from jsonb_object_keys(coalesce(p_patch, '{}'::jsonb)) x where x not in ('max_ai_sends_per_sender_day', 'default_prompt_id');
  if bad is not null then raise exception 'E_PAYLOAD_INVALID: unknown field(s) %', array_to_string(bad, ', '); end if;
  if p_patch ? 'default_prompt_id' and coalesce(p_patch->>'default_prompt_id', '') <> ''
     and not exists (select 1 from outreach_master_prompts where id = (p_patch->>'default_prompt_id')::uuid and workspace_id = p_ws and scope = 'library') then
    raise exception 'E_PAYLOAD_INVALID: default prompt must be a library prompt of this workspace';
  end if;
  insert into outreach_workspace_reply_settings(workspace_id) values (p_ws) on conflict (workspace_id) do nothing;
  begin
    update outreach_workspace_reply_settings set
      max_ai_sends_per_sender_day = case when p_patch ? 'max_ai_sends_per_sender_day' then (p_patch->>'max_ai_sends_per_sender_day')::int else max_ai_sends_per_sender_day end,
      default_prompt_id = case when p_patch ? 'default_prompt_id' then nullif(p_patch->>'default_prompt_id', '')::uuid else default_prompt_id end,
      updated_by = auth.uid(), updated_at = now()
     where workspace_id = p_ws;
  exception when check_violation then raise exception 'E_PAYLOAD_INVALID: the cap is 1–40 AI sends a day per sender';
           when invalid_text_representation then raise exception 'E_PAYLOAD_INVALID: a number or id field holds text';
  end;
  perform outreach_audit(p_ws, 'ai_reply.workspace_settings', 'workspace', p_ws::text, jsonb_build_object('patch', p_patch), 'user');
  return outreach_workspace_reply_settings_get(p_ws);
end $$;

-- ============================================================================= master prompt per sequence
create or replace function outreach_master_prompt_get(p_sequence uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; mp outreach_master_prompts%rowtype;
begin
  q := outreach__ai_seq_for(p_sequence, 'member');
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  select * into mp from outreach_master_prompts where id = srs.master_prompt_id;
  return outreach__mp_json(mp, null);
end $$;

create or replace function outreach_master_prompt_update(p_sequence uuid, p_editor_mode text, p_body text, p_sections jsonb, p_settings jsonb, p_change_kind text,
                                                         p_note text default null, p_base_version int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; mp outreach_master_prompts%rowtype; st jsonb; kind_ text := p_change_kind; warns text[] := '{}';
begin
  q := outreach__ai_seq_for(p_sequence, 'manager');
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  select * into mp from outreach_master_prompts where id = srs.master_prompt_id for update;
  if p_editor_mode not in ('guided','raw') then raise exception 'E_PAYLOAD_INVALID: editor_mode is guided or raw'; end if;
  if kind_ not in ('style','substantive') then raise exception 'E_PAYLOAD_INVALID: change_kind is style or substantive'; end if;
  if p_base_version is not null and p_base_version <> mp.version then
    raise exception 'E_CONFLICT: someone saved version % while you were editing version %. Reload to see it', mp.version, p_base_version;
  end if;
  if p_editor_mode = 'guided' and (p_sections is null or jsonb_typeof(p_sections) <> 'object') then raise exception 'E_PAYLOAD_INVALID: guided mode needs sections'; end if;
  st := outreach__mp_clean_settings(q.workspace_id, p_settings);
  if mp.editor_mode = 'guided' and p_editor_mode = 'raw' then kind_ := 'substantive'; end if;
  mp := outreach__mp_bump(mp.id, kind_, p_note, p_editor_mode, p_body, p_sections, st);
  if mp.body not ilike '%## Stop when%' then warns := warns || ('No Stop section — the AI will only stop after ' || srs.max_ai_replies_per_chat || ' replies.')::text; end if;
  select * into srs from outreach_sequence_reply_settings where sequence_id = p_sequence;
  return outreach__mp_json(mp, null) || jsonb_build_object('change_kind', kind_, 'warmup_remaining', srs.warmup_remaining, 'warnings', to_jsonb(warns));
end $$;

-- Copy from sequence / from a library prompt: prompt, cards, knowledge links and Q&A as an independent copy (substantive)
create or replace function outreach_master_prompt_copy(p_sequence uuid, p_from_sequence uuid default null, p_from_library uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; mp outreach_master_prompts%rowtype; src outreach_master_prompts%rowtype; nv int;
begin
  q := outreach__ai_seq_for(p_sequence, 'manager');
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  if p_from_sequence is not null then
    perform outreach__ai_seq_for(p_from_sequence, 'member');
    select * into src from outreach_master_prompts where scope = 'sequence' and sequence_id = p_from_sequence;
  elsif p_from_library is not null then
    select * into src from outreach_master_prompts where id = p_from_library and scope = 'library' and workspace_id = q.workspace_id;
  else
    raise exception 'E_PAYLOAD_INVALID: give a sequence or a library prompt to copy from';
  end if;
  if src.id is null then raise exception 'E_NOT_FOUND: nothing to copy from'; end if;
  if src.id = srs.master_prompt_id then raise exception 'E_PAYLOAD_INVALID: that is this sequence''s own prompt'; end if;
  select * into mp from outreach_master_prompts where id = srs.master_prompt_id for update;
  nv := mp.version + 1;
  delete from outreach_master_prompt_scenarios where master_prompt_id = mp.id;
  insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled, updated_by)
  select mp.id, position, title, when_text, do_text, enabled, auth.uid() from outreach_master_prompt_scenarios where master_prompt_id = src.id;
  delete from outreach_master_prompt_faqs where master_prompt_id = mp.id;
  insert into outreach_master_prompt_faqs(master_prompt_id, question, answer, source, enabled, created_by)
  select mp.id, question, answer, 'import', enabled, auth.uid() from outreach_master_prompt_faqs where master_prompt_id = src.id;
  update outreach_master_prompts set editor_mode = src.editor_mode, version = nv, body = src.body, sections = src.sections, settings = src.settings,
         substantive_version = nv, substantive_at = now(), copied_from_prompt_id = src.id, copied_from_version = src.version, knowledge_source_ids = src.knowledge_source_ids,
         updated_by = auth.uid(), updated_at = now()
   where id = mp.id returning * into mp;
  insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by, scenarios, faqs)
  values (mp.id, nv, mp.editor_mode, mp.body, mp.sections, mp.settings, 'substantive', 'Copied from ' || case when src.scope = 'sequence' then 'sequence "' || coalesce((select name from outreach_sequences where id = src.sequence_id), '?') || '"' else 'library prompt "' || coalesce(src.name, '?') || '"' end || ' v' || src.version,
          auth.uid(), outreach__mp_cards(mp.id), outreach__mp_faqs(mp.id));
  perform outreach__mp_after_change(mp.id, 'substantive');
  perform outreach_audit(q.workspace_id, 'ai_reply.master_prompt_copied', 'master_prompt', mp.id::text, jsonb_build_object('from', src.id, 'from_version', src.version, 'sequence_id', p_sequence), 'user');
  return outreach__mp_json(mp, null) || jsonb_build_object('change_kind', 'substantive');
end $$;

create or replace function outreach_master_prompt_versions(p_mp uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  select * into mp from outreach_master_prompts where id = p_mp;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(mp.workspace_id, 'member');
  if not outreach_client_visible(mp.workspace_id, outreach__ai_scope_client(mp.workspace_id, mp.scope, mp.scope_id)) then raise exception 'E_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('version', v.version, 'change_kind', v.change_kind, 'note', v.note, 'editor_mode', v.editor_mode,
            'body', v.body, 'sections', v.sections, 'settings', outreach__mp_default_settings() || v.settings, 'scenarios', coalesce(v.scenarios, '[]'::jsonb), 'faqs', coalesce(v.faqs, '[]'::jsonb),
            'created_at', v.created_at,
            'created_by_name', (select coalesce(m.display_name, m.email::text) from outreach_members m where m.workspace_id = mp.workspace_id and m.user_id = v.created_by))
            order by v.version desc)
    from outreach_master_prompt_versions v where v.master_prompt_id = p_mp), '[]'::jsonb);
end $$;

-- ============================================================================= library prompts (workspace defaults)
create or replace function outreach_master_prompt_library_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  if not outreach_client_visible(p_ws, null) then raise exception 'E_NOT_FOUND'; end if;   -- library prompts are workspace-level
  return coalesce((select jsonb_agg(jsonb_build_object('id', mp.id, 'name', mp.name, 'version', mp.version, 'editor_mode', mp.editor_mode, 'updated_at', mp.updated_at,
            'is_default', mp.id = (select default_prompt_id from outreach_workspace_reply_settings w where w.workspace_id = p_ws),
            'used_by', (select count(*) from outreach_master_prompts x where x.copied_from_prompt_id = mp.id and x.scope = 'sequence')) order by mp.name)
    from outreach_master_prompts mp where mp.workspace_id = p_ws and mp.scope = 'library'), '[]'::jsonb);
end $$;

create or replace function outreach_master_prompt_library_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  select * into mp from outreach_master_prompts where id = p_id and scope = 'library';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(mp.workspace_id, 'member');
  if not outreach_client_visible(mp.workspace_id, null) then raise exception 'E_NOT_FOUND'; end if;
  return outreach__mp_json(mp, null);
end $$;

create or replace function outreach_master_prompt_library_save(p_ws uuid, p_id uuid, p_name text, p_editor_mode text, p_body text, p_sections jsonb, p_settings jsonb,
                                                               p_note text default null, p_scenarios jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; st jsonb; body_ text; card jsonb; i int := 0;
begin
  perform outreach_require(p_ws, 'manager');
  if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then raise exception 'E_PAYLOAD_INVALID: name is 1–80 characters'; end if;
  if p_editor_mode not in ('guided','raw') then raise exception 'E_PAYLOAD_INVALID: editor_mode is guided or raw'; end if;
  st := outreach__mp_clean_settings(p_ws, p_settings);
  if p_id is null then
    body_ := case when p_editor_mode = 'guided' then outreach__compile_master_prompt(coalesce(p_sections, '{}'::jsonb), st, p_scenarios) else btrim(coalesce(p_body, '')) end;
    if length(body_) < 20 then raise exception 'E_PAYLOAD_INVALID: the prompt is too short'; end if;
    insert into outreach_master_prompts(workspace_id, scope, name, editor_mode, version, body, sections, settings, substantive_version, substantive_at, updated_by)
    values (p_ws, 'library', btrim(p_name), p_editor_mode, 1, body_, case when p_editor_mode = 'guided' then p_sections end, st, 1, now(), auth.uid()) returning * into mp;
    if p_scenarios is not null and jsonb_typeof(p_scenarios) = 'array' then
      for card in select x from jsonb_array_elements(p_scenarios) x loop
        i := i + 1;
        insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled, updated_by)
        values (mp.id, i, left(coalesce(card->>'title', 'Situation'), 80), left(coalesce(card->>'when_text', ''), 500), left(coalesce(card->>'do_text', ''), 1500), coalesce((card->>'enabled')::boolean, true), auth.uid());
      end loop;
    end if;
    insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by, scenarios)
    values (mp.id, 1, mp.editor_mode, mp.body, mp.sections, mp.settings, 'substantive', left(p_note, 500), auth.uid(), outreach__mp_cards(mp.id));
    perform outreach_audit(p_ws, 'ai_reply.library_prompt_saved', 'master_prompt', mp.id::text, jsonb_build_object('name', p_name, 'version', 1), 'user');
    return outreach__mp_json(mp, null);
  end if;
  select * into mp from outreach_master_prompts where id = p_id and workspace_id = p_ws and scope = 'library' for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_scenarios is not null and jsonb_typeof(p_scenarios) = 'array' then
    delete from outreach_master_prompt_scenarios where master_prompt_id = mp.id;
    for card in select x from jsonb_array_elements(p_scenarios) x loop
      i := i + 1;
      insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled, updated_by)
      values (mp.id, i, left(coalesce(card->>'title', 'Situation'), 80), left(coalesce(card->>'when_text', ''), 500), left(coalesce(card->>'do_text', ''), 1500), coalesce((card->>'enabled')::boolean, true), auth.uid());
    end loop;
  end if;
  update outreach_master_prompts set name = btrim(p_name) where id = mp.id;
  mp := outreach__mp_bump(mp.id, 'substantive', p_note, p_editor_mode, p_body, p_sections, st);
  return outreach__mp_json(mp, null);
end $$;

create or replace function outreach_master_prompt_library_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  select * into mp from outreach_master_prompts where id = p_id and scope = 'library';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(mp.workspace_id, 'manager');
  update outreach_workspace_reply_settings set default_prompt_id = null where default_prompt_id = p_id;
  delete from outreach_master_prompts where id = p_id;
  perform outreach_audit(mp.workspace_id, 'ai_reply.library_prompt_removed', 'master_prompt', p_id::text, jsonb_build_object('name', mp.name), 'user');
end $$;

-- ============================================================================= scenarios (situation cards, §9.1)
create or replace function outreach__mp_of_sequence(p_sequence uuid, p_role text) returns outreach_master_prompts
language plpgsql security definer set search_path = public, extensions as $$
declare q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; mp outreach_master_prompts%rowtype;
begin
  q := outreach__ai_seq_for(p_sequence, p_role);
  srs := outreach_ai_seq_settings_ensure(p_sequence);
  select * into mp from outreach_master_prompts where id = srs.master_prompt_id;
  return mp;
end $$;

create or replace function outreach_scenarios_list(p_sequence uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'member');
  return outreach__mp_cards(mp.id);
end $$;

create or replace function outreach_scenario_save(p_sequence uuid, p_id uuid, p_title text, p_when text, p_do text, p_enabled boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; sid uuid; pos int;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'manager');
  begin
    if p_id is null then
      select coalesce(max(position), 0) + 1 into pos from outreach_master_prompt_scenarios where master_prompt_id = mp.id;
      insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled, updated_by)
      values (mp.id, pos, btrim(p_title), btrim(p_when), btrim(p_do), coalesce(p_enabled, true), auth.uid()) returning id into sid;
    else
      update outreach_master_prompt_scenarios set title = btrim(p_title), when_text = btrim(p_when), do_text = btrim(p_do), enabled = coalesce(p_enabled, enabled), updated_by = auth.uid(), updated_at = now()
       where id = p_id and master_prompt_id = mp.id returning id into sid;
      if sid is null then raise exception 'E_NOT_FOUND'; end if;
    end if;
  exception when check_violation then raise exception 'E_PAYLOAD_INVALID: title up to 80, when up to 500, do up to 1500 characters, none empty';
  end;
  perform outreach__mp_bump(mp.id, 'substantive', 'Scenario "' || left(btrim(p_title), 60) || '" ' || case when p_id is null then 'added' else 'edited' end);
  return jsonb_build_object('id', sid, 'scenarios', outreach__mp_cards(mp.id), 'version', (select version from outreach_master_prompts where id = mp.id));
end $$;

create or replace function outreach_scenario_toggle(p_id uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sc outreach_master_prompt_scenarios%rowtype; mp outreach_master_prompts%rowtype;
begin
  select * into sc from outreach_master_prompt_scenarios where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into mp from outreach_master_prompts where id = sc.master_prompt_id;
  if mp.scope = 'sequence' then perform outreach__ai_seq_for(mp.sequence_id, 'manager'); else perform outreach_require(mp.workspace_id, 'manager'); end if;
  update outreach_master_prompt_scenarios set enabled = p_enabled, updated_by = auth.uid(), updated_at = now() where id = p_id;
  perform outreach__mp_bump(mp.id, 'substantive', 'Scenario "' || left(sc.title, 60) || '" ' || case when p_enabled then 'on' else 'off' end);
  return jsonb_build_object('scenarios', outreach__mp_cards(mp.id), 'version', (select version from outreach_master_prompts where id = mp.id));
end $$;

create or replace function outreach_scenario_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sc outreach_master_prompt_scenarios%rowtype; mp outreach_master_prompts%rowtype;
begin
  select * into sc from outreach_master_prompt_scenarios where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into mp from outreach_master_prompts where id = sc.master_prompt_id;
  if mp.scope = 'sequence' then perform outreach__ai_seq_for(mp.sequence_id, 'manager'); else perform outreach_require(mp.workspace_id, 'manager'); end if;
  delete from outreach_master_prompt_scenarios where id = p_id;
  perform outreach__mp_bump(mp.id, 'substantive', 'Scenario "' || left(sc.title, 60) || '" removed');
  return jsonb_build_object('scenarios', outreach__mp_cards(mp.id), 'version', (select version from outreach_master_prompts where id = mp.id));
end $$;

create or replace function outreach_scenarios_reorder(p_sequence uuid, p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; i int;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'manager');
  for i in 1 .. coalesce(cardinality(p_ids), 0) loop
    update outreach_master_prompt_scenarios set position = i, updated_at = now() where id = p_ids[i] and master_prompt_id = mp.id;
  end loop;
  perform outreach__mp_bump(mp.id, 'substantive', 'Scenarios reordered');
  return jsonb_build_object('scenarios', outreach__mp_cards(mp.id), 'version', (select version from outreach_master_prompts where id = mp.id));
end $$;

-- "Convert to cards": parses "- When → Do" bullets (also "->"); nothing saved
create or replace function outreach_scenarios_from_text(p_text text) returns jsonb
language plpgsql immutable set search_path = public, extensions as $$
declare ln text; parts text[]; w text; d text; t text; out_ jsonb := '[]'::jsonb;
begin
  for ln in select unnest(regexp_split_to_array(coalesce(p_text, ''), E'\\n')) loop
    ln := btrim(regexp_replace(ln, '^\s*[-*•]\s*', ''));
    if ln = '' then continue; end if;
    parts := regexp_split_to_array(ln, '\s*(→|->|=>)\s*');
    if cardinality(parts) < 2 then continue; end if;
    w := btrim(parts[1]); d := btrim(array_to_string(parts[2:], ' → '));
    if w = '' or d = '' then continue; end if;
    t := regexp_replace(w, '^(they|when they|if they|the prospect)\s+', '', 'i');
    t := left(btrim(split_part(split_part(t, ',', 1), ' / ', 1)), 80);
    t := upper(left(t, 1)) || substr(t, 2);
    out_ := out_ || jsonb_build_object('title', coalesce(nullif(t, ''), 'Situation'), 'when_text', left(w, 500), 'do_text', left(d, 1500), 'enabled', true);
  end loop;
  return out_;
end $$;

-- ============================================================================= Q&A (§9.2)
create or replace function outreach_faqs_list(p_sequence uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'member');
  return outreach__mp_faqs(mp.id);
end $$;

create or replace function outreach_faq_save(p_sequence uuid, p_id uuid, p_question text, p_answer text, p_enabled boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; fid uuid;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'manager');
  begin
    if p_id is null then
      insert into outreach_master_prompt_faqs(master_prompt_id, question, answer, source, enabled, created_by) values (mp.id, btrim(p_question), btrim(p_answer), 'manual', coalesce(p_enabled, true), auth.uid()) returning id into fid;
    else
      update outreach_master_prompt_faqs set question = btrim(p_question), answer = btrim(p_answer), enabled = coalesce(p_enabled, enabled) where id = p_id and master_prompt_id = mp.id returning id into fid;
      if fid is null then raise exception 'E_NOT_FOUND'; end if;
    end if;
  exception when check_violation then raise exception 'E_PAYLOAD_INVALID: question up to 500 and answer up to 2000 characters, neither empty';
  end;
  perform outreach__mp_bump(mp.id, 'substantive', 'Q&A ' || case when p_id is null then 'added' else 'edited' end);
  return jsonb_build_object('id', fid, 'faqs', outreach__mp_faqs(mp.id));
end $$;

create or replace function outreach_faq_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f outreach_master_prompt_faqs%rowtype; mp outreach_master_prompts%rowtype;
begin
  select * into f from outreach_master_prompt_faqs where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into mp from outreach_master_prompts where id = f.master_prompt_id;
  if mp.scope = 'sequence' then perform outreach__ai_seq_for(mp.sequence_id, 'manager'); else perform outreach_require(mp.workspace_id, 'manager'); end if;
  delete from outreach_master_prompt_faqs where id = p_id;
  update outreach_ai_unanswered_questions set status = 'open', answered_faq_id = null where answered_faq_id = p_id;
  perform outreach__mp_bump(mp.id, 'substantive', 'Q&A removed');
  return jsonb_build_object('faqs', outreach__mp_faqs(mp.id));
end $$;

-- ============================================================================= knowledge sources (§9.2)
create or replace function outreach__ks_json(s outreach_knowledge_sources) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title, 'url', s.url, 'storage_path', s.storage_path, 'content_type', s.content_type, 'status', s.status, 'error', s.error,
    'pages', s.pages, 'chunks', s.chunks, 'crawled_at', s.crawled_at, 'refresh_days', s.refresh_days, 'created_at', s.created_at, 'updated_at', s.updated_at,
    'used_by', (select count(*) from outreach_master_prompts mp where s.id = any(mp.knowledge_source_ids)))
$$;

create or replace function outreach_knowledge_sources_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  if not outreach_client_visible(p_ws, null) then raise exception 'E_NOT_FOUND'; end if;   -- knowledge sources are workspace-level
  return coalesce((select jsonb_agg(outreach__ks_json(s) order by s.created_at desc) from outreach_knowledge_sources s where s.workspace_id = p_ws), '[]'::jsonb);
end $$;

create or replace function outreach_knowledge_source_add(p_ws uuid, p_kind text, p_title text, p_url text default null, p_storage_path text default null, p_text text default null, p_refresh_days int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; ct text;
begin
  perform outreach_require(p_ws, 'manager');
  if p_kind not in ('website', 'document', 'text') then raise exception 'E_PAYLOAD_INVALID: kind is website, document or text'; end if;
  if p_kind = 'website' and coalesce(p_url, '') !~ '^https?://[^\s/]+' then raise exception 'E_PAYLOAD_INVALID: a website needs an http(s) URL'; end if;
  if p_kind = 'document' and (coalesce(p_storage_path, '') = '' or p_storage_path not like p_ws::text || '/%') then raise exception 'E_PAYLOAD_INVALID: upload the file to the knowledge bucket under this workspace first'; end if;
  if p_kind = 'text' and length(btrim(coalesce(p_text, ''))) < 20 then raise exception 'E_PAYLOAD_INVALID: paste at least a few sentences'; end if;
  if (select count(*) from outreach_knowledge_sources where workspace_id = p_ws) >= 50 then raise exception 'E_PAYLOAD_INVALID: up to 50 knowledge sources per workspace'; end if;
  ct := case when p_storage_path ~* '\.pdf$' then 'application/pdf' when p_storage_path ~* '\.docx$' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
             when p_storage_path ~* '\.(md|markdown)$' then 'text/markdown' when p_storage_path ~* '\.html?$' then 'text/html' when p_storage_path is not null then 'text/plain' end;
  begin
    insert into outreach_knowledge_sources(workspace_id, kind, title, url, storage_path, content_type, text_inline, refresh_days, created_by)
    values (p_ws, p_kind, btrim(p_title), case when p_kind = 'website' then btrim(p_url) end, case when p_kind = 'document' then p_storage_path end, ct,
            case when p_kind = 'text' then p_text end, case when p_kind = 'website' then p_refresh_days end, auth.uid()) returning * into s;
  exception when check_violation then raise exception 'E_PAYLOAD_INVALID: title 1–200 characters, text up to 200,000 characters, refresh 1–90 days';
  end;
  perform outreach_audit(p_ws, 'ai_reply.knowledge_added', 'knowledge_source', s.id::text, jsonb_build_object('kind', p_kind, 'title', p_title, 'url', p_url), 'user');
  return outreach__ks_json(s);
end $$;

create or replace function outreach_knowledge_source_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; mp record;
begin
  select * into s from outreach_knowledge_sources where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  for mp in select id from outreach_master_prompts where p_id = any(knowledge_source_ids) loop
    update outreach_master_prompts set knowledge_source_ids = array_remove(knowledge_source_ids, p_id) where id = mp.id;
    perform outreach__mp_bump(mp.id, 'substantive', 'Knowledge source "' || left(s.title, 60) || '" removed');
  end loop;
  delete from outreach_knowledge_sources where id = p_id;
  perform outreach_audit(s.workspace_id, 'ai_reply.knowledge_removed', 'knowledge_source', p_id::text, jsonb_build_object('title', s.title), 'user');
end $$;

create or replace function outreach_knowledge_attach(p_sequence uuid, p_source uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; s outreach_knowledge_sources%rowtype;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'manager');
  select * into s from outreach_knowledge_sources where id = p_source and workspace_id = mp.workspace_id;
  if not found then raise exception 'E_NOT_FOUND: knowledge source'; end if;
  if not (p_source = any(mp.knowledge_source_ids)) then
    update outreach_master_prompts set knowledge_source_ids = knowledge_source_ids || p_source where id = mp.id;
    perform outreach__mp_bump(mp.id, 'substantive', 'Knowledge "' || left(s.title, 60) || '" attached');
  end if;
  return jsonb_build_object('knowledge', outreach__mp_knowledge(mp.id));
end $$;

create or replace function outreach_knowledge_detach(p_sequence uuid, p_source uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype;
begin
  mp := outreach__mp_of_sequence(p_sequence, 'manager');
  if p_source = any(mp.knowledge_source_ids) then
    update outreach_master_prompts set knowledge_source_ids = array_remove(knowledge_source_ids, p_source) where id = mp.id;
    perform outreach__mp_bump(mp.id, 'substantive', 'Knowledge source detached');
  end if;
  return jsonb_build_object('knowledge', outreach__mp_knowledge(mp.id));
end $$;

-- ============================================================================= unanswered questions (§9.3)
create or replace function outreach_unanswered_list(p_sequence uuid, p_status text default 'open') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach__ai_seq_for(p_sequence, 'member');
  return coalesce((select jsonb_agg(jsonb_build_object('id', u.id, 'canonical', u.canonical, 'count_total', u.count_total,
      'count_30d', (select count(*) from unnest(u.seen_at) t where t > now() - interval '30 days'),
      'first_seen_at', u.first_seen_at, 'last_seen_at', u.last_seen_at, 'status', u.status, 'examples', (select coalesce(jsonb_agg(x) , '[]'::jsonb) from (select x from jsonb_array_elements(u.examples) x order by x->>'at' desc limit 3) e),
      'answered_faq_id', u.answered_faq_id, 'dismissed_reason', u.dismissed_reason) order by (select count(*) from unnest(u.seen_at) t where t > now() - interval '30 days') desc, u.last_seen_at desc)
    from outreach_ai_unanswered_questions u where u.sequence_id = p_sequence and (coalesce(p_status, 'open') = 'all' or u.status = coalesce(p_status, 'open'))), '[]'::jsonb);
end $$;

create or replace function outreach_unanswered_answer(p_group uuid, p_answer text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u outreach_ai_unanswered_questions%rowtype; mp outreach_master_prompts%rowtype; fid uuid;
begin
  select * into u from outreach_ai_unanswered_questions where id = p_group;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  mp := outreach__mp_of_sequence(u.sequence_id, 'manager');
  if length(btrim(coalesce(p_answer, ''))) < 2 then raise exception 'E_PAYLOAD_INVALID: write the answer'; end if;
  insert into outreach_master_prompt_faqs(master_prompt_id, question, answer, source, enabled, created_by) values (mp.id, left(u.canonical, 500), left(btrim(p_answer), 2000), 'unanswered', true, auth.uid()) returning id into fid;
  update outreach_ai_unanswered_questions set status = 'answered', answered_faq_id = fid where id = p_group;
  perform outreach__mp_bump(mp.id, 'substantive', 'Answer added for "' || left(u.canonical, 60) || '"');
  return jsonb_build_object('faq_id', fid, 'group_id', p_group, 'faqs', outreach__mp_faqs(mp.id));
end $$;

create or replace function outreach_unanswered_dismiss(p_group uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u outreach_ai_unanswered_questions%rowtype;
begin
  select * into u from outreach_ai_unanswered_questions where id = p_group;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__ai_seq_for(u.sequence_id, 'manager');
  update outreach_ai_unanswered_questions set status = 'dismissed', dismissed_reason = left(p_reason, 300) where id = p_group;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================= lead notes (§9.4)
create or replace function outreach_lead_notes_get(p_lead uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; n outreach_lead_ai_notes%rowtype;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(l.workspace_id, 'client_viewer');
  if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_NOT_FOUND'; end if;
  select * into n from outreach_lead_ai_notes where lead_id = p_lead;
  return jsonb_build_object('lead_id', p_lead, 'summary', n.summary, 'items', coalesce(n.items, '[]'::jsonb), 'updated_at', n.updated_at);
end $$;

-- a person's edit: items replaced; changed or new items are locked (the AI may add, never change them)
create or replace function outreach_lead_notes_update(p_lead uuid, p_items jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; n outreach_lead_ai_notes%rowtype; it jsonb; old jsonb; out_ jsonb := '[]'::jsonb; key_ text;
  keys text[] := array['budget','timeline','current_solution','pain','objection','decision_maker','interest','other'];
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(l.workspace_id, 'member');
  if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if not exists (select 1 from outreach_members m where m.workspace_id = l.workspace_id and m.user_id = auth.uid() and m.can_reply) then raise exception 'E_FORBIDDEN: replies are disabled for your account'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then raise exception 'E_PAYLOAD_INVALID: items is a list of up to 20 notes'; end if;
  insert into outreach_lead_ai_notes(lead_id, workspace_id) values (p_lead, l.workspace_id) on conflict (lead_id) do nothing;
  select * into n from outreach_lead_ai_notes where lead_id = p_lead for update;
  for it in select x from jsonb_array_elements(p_items) x loop
    if nullif(btrim(coalesce(it->>'text', '')), '') is null then continue; end if;
    key_ := case when (it->>'key') = any(keys) then it->>'key' else 'other' end;
    select x into old from jsonb_array_elements(coalesce(n.items, '[]'::jsonb)) x where x->>'id' = it->>'id';
    if old is not null and old->>'text' = btrim(it->>'text') and old->>'key' = key_ then
      out_ := out_ || old;
    else
      out_ := out_ || jsonb_build_object('id', coalesce(nullif(it->>'id', '')::uuid, gen_random_uuid()), 'key', key_, 'text', left(btrim(it->>'text'), 300),
                'source_message_id', old->'source_message_id', 'updated_at', now(), 'edited_by', auth.uid(), 'locked', true,
                'history', case when old is null then '[]'::jsonb else coalesce(old->'history', '[]'::jsonb) || jsonb_build_object('text', old->>'text', 'at', old->>'updated_at') end);
    end if;
  end loop;
  update outreach_lead_ai_notes set items = out_, updated_at = now() where lead_id = p_lead;
  perform outreach_audit(l.workspace_id, 'ai_reply.lead_notes_edited', 'lead', p_lead::text, jsonb_build_object('items', jsonb_array_length(out_)), 'user');
  return outreach_lead_notes_get(p_lead);
exception when invalid_text_representation then raise exception 'E_PAYLOAD_INVALID: an item id is not a uuid';
end $$;

-- ============================================================================= inbox: chat state, stop / resume
create or replace function outreach_ai_reply_chat_state(p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; eff jsonb; st jsonb; stage_j jsonb; total int; pos int; lbl text; act outreach_ai_reply_runs%rowtype; lst outreach_ai_reply_runs%rowtype; notes text;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  eff := outreach__ai_effective(p_chat);
  st := coalesce(eff->'settings'->'stages', outreach__mp_default_settings()->'stages');
  total := jsonb_array_length(st);
  if c.conversation_stage is not null then
    select o.i::int, o.x->>'label' into pos, lbl from jsonb_array_elements(st) with ordinality o(x, i) where o.x->>'key' = c.conversation_stage;
    if pos is null and c.conversation_stage = 'closing' then pos := total + 1; lbl := 'Closing'; end if;
    if pos is not null then stage_j := jsonb_build_object('key', c.conversation_stage, 'label', lbl, 'position', pos, 'total', total); end if;
  elsif c.ai_session_kind = 'dormant' then
    stage_j := jsonb_build_object('key', 're_engage', 'label', 'Re-engage', 'position', 0, 'total', total);
  end if;
  select * into act from outreach_ai_reply_runs where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled','sending') limit 1;
  select * into lst from outreach_ai_reply_runs where chat_id = p_chat and status not in ('debouncing','drafting','draft_ready','scheduled','sending','superseded')
   order by updated_at desc limit 1;
  select summary into notes from outreach_lead_ai_notes where lead_id = c.lead_id;
  return (eff - 'policy' - 'settings' - 'consent_valid') || jsonb_build_object(
    'stage', stage_j, 'exchanges', c.conversation_exchanges, 'ai_replies_count', c.ai_replies_count,
    'max_ai_replies', coalesce((eff->'settings'->>'max_ai_replies_per_chat')::int, 6),
    'stages', st, 'lead_notes_summary', notes,
    'run', outreach__ai_run_json(act), 'last_run', outreach__ai_run_json(lst));
end $$;

create or replace function outreach_chat_ai_stop(p_chat uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_ai_handoff(p_chat, 'manual', null, null);
  return outreach_ai_reply_chat_state(p_chat);
end $$;

create or replace function outreach_chat_ai_resume(p_chat uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; r jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'manager');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  r := outreach_ai_resume_chat(p_chat);
  perform outreach_audit(c.workspace_id, 'ai_reply.chat_resumed', 'chat', p_chat::text, r, 'user');
  return outreach_ai_reply_chat_state(p_chat);
end $$;

-- ============================================================================= activity log: trigger filter
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
       and (coalesce(f->>'trigger', '') = '' or r.trigger_kind = f->>'trigger')
       and (coalesce(f->>'sequence_id', '') = '' or r.sequence_id = (f->>'sequence_id')::uuid)
       and (coalesce(f->>'sender_id', '') = '' or r.sender_id = (f->>'sender_id')::uuid)
       and (coalesce(f->>'chat_id', '') = '' or r.chat_id = (f->>'chat_id')::uuid)
       and (coalesce(f->>'stage', '') = '' or r.stage_after = f->>'stage' or r.stage_before = f->>'stage')
       and (coalesce(f->>'reason', '') = '' or f->>'reason' = any(r.escalation_reasons) or f->>'reason' = any(r.gate_failures) or r.cancel_reason = f->>'reason')
       and (coalesce(f->>'since', '') = '' or r.created_at >= (f->>'since')::timestamptz)
     order by r.created_at desc limit lim) x;
  return jsonb_build_object('items', items, 'next_before', case when jsonb_array_length(items) = lim then nb end);
end $$;

-- ============================================================================= consent (per sender)
create or replace function outreach_ai_consent_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare me_email text;
begin
  perform outreach_require(p_ws, 'manager');
  select lower(email) into me_email from auth.users where id = auth.uid();
  return coalesce((select jsonb_agg(jsonb_build_object(
      'sender_id', s.id, 'sender_name', s.display_name, 'provider', s.provider, 'owner_email', s.owner_email,
      'owner_is_me', (s.owner_user_id = auth.uid()) or (me_email is not null and lower(coalesce(s.owner_email::text, '')) = me_email),
      'consent', (select jsonb_build_object('id', k.id, 'valid', k.expires_at > now(), 'granted_via', k.granted_via, 'granted_by_email', k.granted_by_email, 'granted_at', k.granted_at, 'expires_at', k.expires_at, 'scope', k.scope)
                    from outreach_ai_reply_consent k where k.sender_id = s.id and k.revoked_at is null order by k.granted_at desc limit 1),
      'pending_link', (select jsonb_build_object('id', x.id, 'email', x.email, 'created_at', x.created_at, 'expires_at', x.expires_at)
                         from outreach_ai_reply_consent_links x where x.sender_id = s.id and x.used_at is null and x.cancelled_at is null and x.expires_at > now() order by x.created_at desc limit 1),
      'sequences_on_auto', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name) order by q.name), '[]'::jsonb) from outreach_sequence_reply_settings r join outreach_sequences q on q.id = r.sequence_id
                              where r.workspace_id = p_ws and r.mode = 'autopilot' and q.status <> 'archived' and (q.sender_pool @> array[s.id] or q.sender_pools::text like '%' || s.id::text || '%')),
      'ai_sent_7d', (select count(*) from outreach_ai_reply_runs r where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at > now() - interval '7 days'))
      order by s.display_name)
    from outreach_senders s
   where s.workspace_id = p_ws and s.deleted_at is null and s.provider = 'LINKEDIN' and outreach_client_visible(p_ws, s.client_id)), '[]'::jsonb);
end $$;

create or replace function outreach_ai_consent_grant_operator(p_sender uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; me_email text; cap int; cid uuid;
begin
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_NOT_FOUND'; end if;
  select lower(email) into me_email from auth.users where id = auth.uid();
  if not ((s.owner_user_id is not null and s.owner_user_id = auth.uid()) or (me_email is not null and lower(coalesce(s.owner_email::text, '')) = me_email)) then
    raise exception 'E_FORBIDDEN: only the owner of this LinkedIn account can approve AI replies here. Send them the approval link instead';
  end if;
  select max_ai_sends_per_sender_day into cap from outreach_workspace_reply_settings where workspace_id = s.workspace_id;
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'replaced' where sender_id = s.id and revoked_at is null;
  insert into outreach_ai_reply_consent(workspace_id, sender_id, granted_by_email, granted_via, scope, evidence, granted_at, expires_at)
  values (s.workspace_id, s.id, coalesce(me_email, s.owner_email::text), 'owner_is_operator',
          jsonb_build_object('daily_cap', coalesce(cap, 25), 'grant', 'AI may reply as me in the sequences my team turns on.'),
          jsonb_build_object('user_id', auth.uid(), 'at', now()), now(), now() + interval '12 months')
  returning id into cid;
  perform outreach_audit(s.workspace_id, 'ai_reply.consent_granted', 'sender', s.id::text, jsonb_build_object('consent_id', cid, 'via', 'owner_is_operator'), 'user');
  return jsonb_build_object('id', cid, 'sender_id', s.id, 'granted_via', 'owner_is_operator');
end $$;

-- ============================================================================= metrics label fix (prompt group)
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
    if p_group not in ('sequence','sender','stage','master_prompt','client','trigger','scenario') then raise exception 'E_PAYLOAD_INVALID: group by sequence, sender, stage, master_prompt, client, trigger or scenario'; end if;
    select coalesce(jsonb_agg(g.j order by (g.j->>'runs')::int desc), '[]'::jsonb) into groups from (
      select outreach__ai_totals(array_agg(u)) || jsonb_build_object('key', k.key, 'label', coalesce(k.label, 'None')) j
        from unnest(runs) u
        cross join lateral (select case p_group when 'sequence' then u.sequence_id::text when 'sender' then u.sender_id::text when 'stage' then u.stage_after
                                                 when 'master_prompt' then u.master_prompt_id::text when 'trigger' then u.trigger_kind when 'scenario' then u.scenario_id::text else u.client_id::text end as key,
                                   case p_group when 'sequence' then (select name from outreach_sequences where id = u.sequence_id)
                                                when 'sender' then (select display_name from outreach_senders where id = u.sender_id)
                                                when 'stage' then u.stage_after
                                                when 'trigger' then u.trigger_kind
                                                when 'scenario' then (select title from outreach_master_prompt_scenarios where id = u.scenario_id)
                                                when 'master_prompt' then (select case mp.scope when 'sequence' then coalesce((select name from outreach_sequences where id = mp.sequence_id), 'Sequence') else coalesce(mp.name, 'Library') end || ' v' || u.master_prompt_version from outreach_master_prompts mp where mp.id = u.master_prompt_id)
                                                else (select name from outreach_clients where id = u.client_id) end as label) k
       group by k.key, k.label) g;
  end if;
  return jsonb_build_object('totals', outreach__ai_totals(runs), 'groups', groups,
    'handed_off', (select count(*) from outreach_chats c where c.workspace_id = p_ws and c.ai_handed_off_at >= t0 and c.ai_handed_off_at < t1 and outreach_client_visible(p_ws, c.client_id)),
    'handoff_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n) order by x.n desc) from (
       select c.ai_handoff_reason reason, count(*) n from outreach_chats c where c.workspace_id = p_ws and c.ai_handed_off_at >= t0 and c.ai_handed_off_at < t1 and outreach_client_visible(p_ws, c.client_id) group by 1) x), '[]'::jsonb),
    'escalation_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n) order by x.n desc) from (
       select e.reason, count(*) n from unnest(runs) u cross join lateral unnest(u.escalation_reasons) e(reason) where u.status in ('escalated','draft_ready') group by 1) x), '[]'::jsonb),
    'cancel_reasons', coalesce((select jsonb_agg(jsonb_build_object('reason', x.reason, 'n', x.n) order by x.n desc) from (
       select u.cancel_reason reason, count(*) n from unnest(runs) u where u.status = 'cancelled' and u.cancel_reason is not null group by 1) x), '[]'::jsonb));
end $$;

-- ============================================================================= test conversations (v1.1 regression set; library or sequence prompt)
create or replace function outreach_ai_reply_scenarios_list(p_ws uuid, p_mp uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return coalesce((select jsonb_agg(outreach__ai_scenario_json(s) order by s.created_at)
    from outreach_ai_reply_scenarios s left join outreach_master_prompts mp on mp.id = s.master_prompt_id
   where s.workspace_id = p_ws and s.master_prompt_id is not distinct from p_mp
     and outreach_client_visible(p_ws, case when mp.scope = 'sequence' then (select client_id from outreach_sequences where id = mp.sequence_id) end)), '[]'::jsonb);
end $$;

-- ============================================================================= grants
do $$
declare f record;
  app_fns text[] := array[
    'outreach_ai_reply_chat_state','outreach_chat_ai_stop','outreach_chat_ai_resume','outreach_ai_reply_cancel','outreach_ai_reply_apply_no_reply',
    'outreach_ai_reply_runs_list','outreach_ai_reply_run_get',
    'outreach_sequence_ai_replies_get','outreach_sequence_ai_replies_set','outreach_sequence_ai_summary','outreach_workspace_reply_settings_get','outreach_workspace_reply_settings_set',
    'outreach_master_prompt_get','outreach_master_prompt_update','outreach_master_prompt_copy','outreach_master_prompt_versions','outreach_master_prompt_template',
    'outreach_master_prompt_library_list','outreach_master_prompt_library_get','outreach_master_prompt_library_save','outreach_master_prompt_library_delete',
    'outreach_scenarios_list','outreach_scenario_save','outreach_scenario_toggle','outreach_scenario_delete','outreach_scenarios_reorder','outreach_scenarios_from_text',
    'outreach_faqs_list','outreach_faq_save','outreach_faq_delete',
    'outreach_knowledge_sources_list','outreach_knowledge_source_add','outreach_knowledge_source_delete','outreach_knowledge_attach','outreach_knowledge_detach',
    'outreach_unanswered_list','outreach_unanswered_answer','outreach_unanswered_dismiss','outreach_lead_notes_get','outreach_lead_notes_update',
    'outreach_ai_consent_list','outreach_ai_consent_revoke','outreach_ai_consent_grant_operator','outreach_ai_reply_graduation',
    'outreach_ai_reply_metrics','outreach_ai_reply_cancel_report','outreach_ai_reply_scenarios_list','outreach_ai_reply_scenario_save',
    'outreach_ai_reply_scenario_delete','outreach_ai_reply_pool','outreach_ai_reply_admin_list','outreach_ai_reply_admin_set',
    'outreach_ai_reply_defaults','outreach_ai_scope_client_of','outreach__compile_master_prompt','outreach__mp_default_scenarios'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (p.proname like 'outreach\_ai\_%' or p.proname like 'outreach\_\_ai\_%' or p.proname like 'outreach\_\_mp\_%' or p.proname like 'outreach\_\_ks\_%'
                   or p.proname like 'outreach\_master\_prompt\_%' or p.proname like 'outreach\_sequence\_ai\_%' or p.proname like 'outreach\_workspace\_reply\_%'
                   or p.proname like 'outreach\_scenario%' or p.proname like 'outreach\_faq%' or p.proname like 'outreach\_knowledge\_%' or p.proname like 'outreach\_unanswered\_%'
                   or p.proname like 'outreach\_lead\_notes\_%' or p.proname like 'outreach\_chat\_ai\_%' or p.proname like 'outreach\_\_uq\_%'
                   or p.proname in ('outreach__norm_text','outreach__text_sha','outreach__eu_eea','outreach__chat_sequence','outreach__compile_master_prompt',
                                    'outreach_trg_message_origin','outreach_trg_ai_run_mirror','outreach_migrate_ai_replies_v2')) loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke execute on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
