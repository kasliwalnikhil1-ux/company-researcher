-- 041 — AI replies v2: engine (ai-replies-changes.md §1–§7, §9; docs/outreach/AI-REPLIES-V2-CONTRACT.md §3–§4).
-- Replaces the v1.1 resolver (per-scope policies → per-sequence settings), the human takeover (pause → handoff), and adds
-- sessions, pause / resume, warm-up, manual runs (Draft with AI), knowledge retrieval, lead notes and unanswered questions.
-- Apply in the same call as 040. Idempotent.

-- ============================================================================= settings per sequence
-- The settings row (and the sequence's own prompt) exist for every sequence; created lazily for sequences made before v2
-- or through paths that do not call outreach_create_sequence.
create or replace function outreach_ai_seq_settings_ensure(p_sequence uuid) returns outreach_sequence_reply_settings
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequence_reply_settings%rowtype; q outreach_sequences%rowtype; mp outreach_master_prompts%rowtype; src outreach_master_prompts%rowtype; t jsonb; card jsonb; i int := 0; dflt uuid;
begin
  select * into s from outreach_sequence_reply_settings where sequence_id = p_sequence;
  if found and s.master_prompt_id is not null then return s; end if;
  select * into q from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND: sequence'; end if;
  select * into mp from outreach_master_prompts where scope = 'sequence' and sequence_id = p_sequence;
  if mp.id is null then
    select default_prompt_id into dflt from outreach_workspace_reply_settings where workspace_id = q.workspace_id;
    if dflt is not null then select * into src from outreach_master_prompts where id = dflt and workspace_id = q.workspace_id and scope = 'library'; end if;
    if src.id is not null then
      insert into outreach_master_prompts(workspace_id, scope, scope_id, sequence_id, editor_mode, version, body, sections, settings, substantive_version, substantive_at,
                                          copied_from_prompt_id, copied_from_version, knowledge_source_ids, updated_by)
      values (q.workspace_id, 'sequence', p_sequence, p_sequence, src.editor_mode, 1, src.body, src.sections, src.settings, 1, now(), src.id, src.version, src.knowledge_source_ids, auth.uid())
      returning * into mp;
      insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by, scenarios, faqs)
      values (mp.id, 1, mp.editor_mode, mp.body, mp.sections, mp.settings, 'substantive', 'Copied from the workspace default prompt "' || coalesce(src.name, 'Workspace default') || '" v' || src.version, auth.uid(),
              (select coalesce(jsonb_agg(jsonb_build_object('title', title, 'when_text', when_text, 'do_text', do_text, 'enabled', enabled) order by position), '[]'::jsonb) from outreach_master_prompt_scenarios where master_prompt_id = src.id),
              (select coalesce(jsonb_agg(jsonb_build_object('question', question, 'answer', answer, 'enabled', enabled) order by created_at), '[]'::jsonb) from outreach_master_prompt_faqs where master_prompt_id = src.id));
      insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled, updated_by)
      select mp.id, position, title, when_text, do_text, enabled, auth.uid() from outreach_master_prompt_scenarios where master_prompt_id = src.id;
      insert into outreach_master_prompt_faqs(master_prompt_id, question, answer, source, enabled, created_by)
      select mp.id, question, answer, 'import', enabled, auth.uid() from outreach_master_prompt_faqs where master_prompt_id = src.id;
    else
      t := outreach_master_prompt_template();
      insert into outreach_master_prompts(workspace_id, scope, scope_id, sequence_id, editor_mode, version, body, sections, settings, substantive_version, substantive_at, updated_by)
      values (q.workspace_id, 'sequence', p_sequence, p_sequence, 'guided', 1, t->>'body', t->'sections', t->'settings', 1, now(), auth.uid()) returning * into mp;
      insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by, scenarios)
      values (mp.id, 1, 'guided', mp.body, mp.sections, mp.settings, 'substantive', 'Template', auth.uid(), t->'scenarios');
      for card in select x from jsonb_array_elements(t->'scenarios') x loop
        i := i + 1;
        insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled) values (mp.id, i, card->>'title', card->>'when_text', card->>'do_text', true);
      end loop;
    end if;
  end if;
  insert into outreach_sequence_reply_settings(sequence_id, workspace_id, mode, master_prompt_id)
  values (p_sequence, q.workspace_id, 'draft', mp.id)
  on conflict (sequence_id) do update set master_prompt_id = coalesce(outreach_sequence_reply_settings.master_prompt_id, excluded.master_prompt_id)
  returning * into s;
  return s;
end $$;

-- new sequences get their settings + prompt at creation
do $$
declare def text; nd text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_create_sequence';
  if def is null then raise exception 'outreach_create_sequence not found'; end if;
  if position('outreach_ai_seq_settings_ensure' in def) > 0 then return; end if;
  nd := replace(def, $q$perform outreach_audit(p_workspace, 'sequence.created', 'sequence', sid::text);$q$,
                     $q$perform outreach_audit(p_workspace, 'sequence.created', 'sequence', sid::text);
  perform outreach_ai_seq_settings_ensure(sid);$q$);
  if nd = def then raise exception 'outreach_create_sequence: anchor not found'; end if;
  execute nd;
end $$;

-- ============================================================================= consent (per sender)
drop function if exists outreach__ai_consent_valid(uuid, uuid);
create or replace function outreach__ai_consent_valid(p_sender uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from outreach_ai_reply_consent c where c.sender_id = p_sender and c.revoked_at is null and c.expires_at > now())
$$;

-- ============================================================================= sequence resolution (§1.3)
-- 1. the enrolment behind the action the message answers; 2. else the lead's latest enrolment with this chat's sender.
create or replace function outreach__ai_resolve_sequence(p_chat uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype; answered uuid; latest uuid; seq uuid; switched boolean := false;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then return jsonb_build_object('sequence_id', null, 'switched', false); end if;
  if p_message is not null then
    select * into m from outreach_messages where id = p_message;
    if m.replied_to_action_id is not null then
      select e.sequence_id into answered from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id where a.id = m.replied_to_action_id;
    end if;
  end if;
  if c.lead_id is not null then
    select e.sequence_id into latest from outreach_enrollments e where e.lead_id = c.lead_id and e.sender_id = c.sender_id order by e.created_at desc limit 1;
  end if;
  if c.reply_sequence_id is null then
    seq := coalesce(answered, latest);
    if seq is not null then update outreach_chats set reply_sequence_id = seq where id = p_chat; end if;
  elsif answered is not null and answered <> c.reply_sequence_id then
    -- they answered a NEWER sequence's message: a new conversation (stage / counters / handoff reset)
    seq := answered;
    update outreach_chats set reply_sequence_id = seq, conversation_stage = null, conversation_exchanges = 0, ai_replies_count = 0, last_ai_move = null, stage_stale = false,
           ai_handed_off_at = null, ai_handoff_reason = null, ai_handoff_rule = null, ai_handoff_run_id = null,
           ai_session_started_at = coalesce(m.sent_at, now()), ai_session_kind = 'normal', ai_session_count = ai_session_count + 1
     where id = p_chat;
    switched := true;
    perform outreach_audit(c.workspace_id, 'ai_reply.sequence_switched', 'chat', p_chat::text, jsonb_build_object('from', c.reply_sequence_id, 'to', seq, 'message_id', p_message), 'system');
  else
    seq := c.reply_sequence_id;
  end if;
  return jsonb_build_object('sequence_id', seq, 'switched', switched);
end $$;

-- ============================================================================= effective mode (§1, §2.4, §3)
create or replace function outreach__ai_reason_text(p_mode text, p_code text, p_src_label text, p_until timestamptz) returns text
language sql immutable set search_path = public, extensions as $$
  select initcap(replace(p_mode, 'autopilot', 'auto')) || ' — ' || case coalesce(p_code, '')
    when 'no_sequence'           then 'this conversation is not part of a sequence; Draft with AI still works'
    when 'handed_off'            then 'handed off to a person'
    when 'channel_not_supported' then 'AI replies are LinkedIn only for now'
    when 'consent_missing'       then 'the sender has not approved AI replies yet'
    when 'sequence_paused'       then 'the sequence is paused, replies are drafts'
    when 'sequence_archived'     then 'the sequence is archived, replies are drafts'
    when 'sequence_draft'        then 'the sequence is not live yet, replies are drafts'
    when 'paused_escalated'      then 'paused after an upset reply'
    when 'paused_bot'            then 'paused, the other side looks automated'
    when 'off'                   then 'turned off for ' || coalesce(p_src_label, 'this sequence')
    else 'from ' || coalesce(p_src_label, 'the sequence') end
$$;

create or replace function outreach__ai_effective(p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; s outreach_senders%rowtype; q outreach_sequences%rowtype; srs outreach_sequence_reply_settings%rowtype; wrs outreach_workspace_reply_settings%rowtype;
        mp outreach_master_prompts%rowtype; req text; md text; code text; consent_ok boolean := false; paused boolean; fallback text; pol jsonb; st jsonb; blocked jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then return null; end if;
  select * into s from outreach_senders where id = c.sender_id;
  select * into wrs from outreach_workspace_reply_settings where workspace_id = c.workspace_id;
  if c.reply_sequence_id is not null then
    select * into q from outreach_sequences where id = c.reply_sequence_id;
    select * into srs from outreach_sequence_reply_settings where sequence_id = c.reply_sequence_id;
    if srs.master_prompt_id is not null then select * into mp from outreach_master_prompts where id = srs.master_prompt_id; end if;
  end if;
  if mp.id is null then
    -- no sequence (or no prompt yet): Draft with AI uses the workspace default, else the template
    if wrs.default_prompt_id is not null then select * into mp from outreach_master_prompts where id = wrs.default_prompt_id; end if;
    fallback := case when mp.id is null then 'template' else 'workspace_default' end;
  end if;
  req := coalesce(srs.mode::text, 'off');
  md := req;
  paused := c.autopilot_state in ('paused_escalated', 'paused_bot');
  if c.provider <> 'LINKEDIN' then md := 'off'; code := 'channel_not_supported';
  elsif c.ai_handed_off_at is not null then md := 'off'; code := 'handed_off';
  elsif srs.sequence_id is null then md := 'off'; code := 'no_sequence';
  elsif req = 'off' then code := 'off';
  elsif q.status <> 'active' then
    if md = 'autopilot' then md := 'draft'; end if;
    code := 'sequence_' || q.status::text;
  end if;
  consent_ok := outreach__ai_consent_valid(c.sender_id);
  if md = 'autopilot' then
    if not consent_ok then md := 'draft'; code := 'consent_missing';
    elsif paused then md := 'draft'; code := c.autopilot_state;
    end if;
  end if;
  -- blocked countries: null = the EU/EEA default while no disclosure line is set
  blocked := case when srs.sequence_id is null then to_jsonb(outreach__eu_eea())
                  when srs.blocked_countries is null then to_jsonb(outreach__eu_eea()) else to_jsonb(srs.blocked_countries) end;
  pol := jsonb_build_object(
    'mode', md, 'delay_min_s', coalesce(srs.delay_min_s, 240), 'delay_max_s', coalesce(srs.delay_max_s, 1200),
    'debounce_quiet_s', coalesce(srs.debounce_quiet_s, 120), 'debounce_max_s', coalesce(srs.debounce_max_s, 600),
    'max_ai_sends_per_sender_day', coalesce(wrs.max_ai_sends_per_sender_day, 25), 'stale_after_h', coalesce(srs.stale_after_h, 12),
    'disclosure', srs.disclosure, 'blocked_countries', blocked);
  if mp.id is not null then
    st := outreach__mp_default_settings() || coalesce(mp.settings, '{}'::jsonb);
    if srs.sequence_id is not null then
      st := st || jsonb_build_object('min_exchanges_before_pitch', srs.pitch_after_replies, 'max_ai_replies_per_chat', srs.max_ai_replies_per_chat,
                                     'handoff_stage_id', srs.handoff_stage_id, 'languages', to_jsonb(srs.languages), 'knowledge_source_ids', to_jsonb(mp.knowledge_source_ids));
    else
      st := st || jsonb_build_object('knowledge_source_ids', to_jsonb(mp.knowledge_source_ids));
    end if;
  end if;
  return jsonb_build_object(
    'chat_id', c.id, 'mode', md, 'requested_mode', req, 'reason_code', code,
    'reason', outreach__ai_reason_text(md, code, case when q.id is null then null else 'sequence ' || q.name end, null),
    'source', case when srs.sequence_id is null then 'none' else 'sequence' end, 'source_label', case when q.id is null then null else 'sequence ' || q.name end,
    'can_autopilot', c.provider = 'LINKEDIN' and srs.sequence_id is not null and c.ai_handed_off_at is null and consent_ok and coalesce(q.status::text, '') = 'active',
    'sequence_id', srs.sequence_id, 'sequence_name', q.name, 'sequence_status', q.status, 'sequence_resumed_at', q.resumed_at,
    'handed_off', case when c.ai_handed_off_at is null then null else jsonb_build_object('at', c.ai_handed_off_at, 'reason', c.ai_handoff_reason, 'rule', c.ai_handoff_rule, 'run_id', c.ai_handoff_run_id) end,
    'session', jsonb_build_object('kind', coalesce(c.ai_session_kind, 'normal'), 'started_at', c.ai_session_started_at, 'count', c.ai_session_count),
    'autopilot_state', case when paused then c.autopilot_state else 'active' end, 'paused_reason', case when paused then c.autopilot_paused_reason end,
    'consent_valid', consent_ok, 'warmup_remaining', srs.warmup_remaining,
    'returning_after_days', coalesce(srs.returning_after_days, 3), 'dormant_after_days', coalesce(srs.dormant_after_days, 30),
    'policy', pol, 'fallback', fallback,
    'master_prompt', case when mp.id is null then null else jsonb_build_object('id', mp.id, 'scope', mp.scope, 'sequence_id', mp.sequence_id, 'name', mp.name, 'version', mp.version,
                     'substantive_version', mp.substantive_version, 'editor_mode', mp.editor_mode) end,
    'settings', st);
end $$;

-- ============================================================================= handoff (§2.3), resume (§2.4), demote (§3)
create or replace function outreach__ai_lead_tag(p_ws uuid, p_lead uuid, p_tag text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare tg uuid;
begin
  if p_lead is null then return; end if;
  insert into outreach_tags(workspace_id, name) values (p_ws, p_tag) on conflict (workspace_id, name) do nothing;
  select id into tg from outreach_tags where workspace_id = p_ws and name = p_tag;
  insert into outreach_lead_tags(lead_id, tag_id) values (p_lead, tg) on conflict do nothing;
end $$;

create or replace function outreach_ai_handoff(p_chat uuid, p_reason text, p_run uuid default null, p_rule text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; srs outreach_sequence_reply_settings%rowtype; nm text; co text; st text; hpos int; lpos int; assignee uuid; tid uuid; lbl text; n int;
begin
  if p_reason not in ('human_replied','meeting_confirmed','calendar_sent','stop_rule','max_replies','stage','booking','manual') then raise exception 'E_PAYLOAD_INVALID: handoff reason'; end if;
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'no_chat'); end if;
  if c.ai_handed_off_at is not null then return jsonb_build_object('ok', true, 'already', true, 'reason', c.ai_handoff_reason); end if;
  update outreach_chats set ai_handed_off_at = now(), ai_handoff_reason = p_reason, ai_handoff_rule = left(p_rule, 300), ai_handoff_run_id = p_run,
         ai_run_status = case when ai_run_status in ('escalated','no_reply','failed','expired') then null else ai_run_status end
   where id = p_chat;
  -- every pending run stops (the run that triggered the handoff is already sent / being sent)
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'handed_off'
   where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled') and id is distinct from p_run;
  get diagnostics n = row_count;
  if c.reply_sequence_id is not null then select * into srs from outreach_sequence_reply_settings where sequence_id = c.reply_sequence_id; end if;
  select coalesce(l.full_name, c.attendee_name, 'the lead'), l.company into nm, co from outreach_leads l where l.id = c.lead_id;
  nm := coalesce(nm, c.attendee_name, 'the lead');
  if c.lead_id is not null then perform outreach__ai_lead_tag(c.workspace_id, c.lead_id, 'ai-handed-off'); end if;
  -- move the lead to the hand-off stage (forward only)
  if srs.handoff_stage_id is not null and c.lead_id is not null then
    select st_.position into hpos from outreach_stages st_ where st_.id = srs.handoff_stage_id;
    select st_.position into lpos from outreach_stages st_ join outreach_leads l on l.stage_id = st_.id where l.id = c.lead_id;
    if hpos is not null and (lpos is null or lpos < hpos) then update outreach_leads set stage_id = srs.handoff_stage_id where id = c.lead_id; end if;
  end if;
  if p_reason not in ('human_replied', 'manual') then
    -- task for the chat's assignee, else the sequence owner (a person is already in the chat for T1 / T8)
    assignee := c.assigned_to;
    if assignee is null and c.reply_sequence_id is not null then select created_by into assignee from outreach_sequences where id = c.reply_sequence_id; end if;
    lbl := case p_reason when 'calendar_sent' then 'calendar link sent' when 'meeting_confirmed' then 'meeting confirmed' when 'stop_rule' then coalesce(nullif(p_rule, ''), 'stop rule met')
                         when 'max_replies' then 'AI reply limit reached' when 'stage' then 'reached the hand-off stage' when 'booking' then 'meeting booked' else 'AI stopped by ' || 'a teammate' end;
    select conversation_stage into st from outreach_chats where id = p_chat;
    insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, due_at, assigned_to, source)
    values (c.workspace_id, c.client_id, 'ai_handoff', c.lead_id, c.sender_id, c.id,
            left(concat_ws(' · ', case when p_reason in ('calendar_sent','meeting_confirmed','booking') then 'Meeting stage' else 'AI handed off' end || ' — ' || nm || case when co is not null then ' (' || co || ')' else '' end, lbl, 'over to you'), 200),
            left(concat_ws(E'\n', 'The AI stopped replying in this conversation: ' || lbl || '.', case when p_rule is not null then 'Rule: ' || p_rule end, 'Reply from the inbox; the AI will not answer again here unless you resume it.'), 2000),
            date_trunc('day', now()) + interval '18 hours', assignee, 'system')
    returning id into tid;
  end if;
  perform outreach_audit(c.workspace_id, 'ai_reply.handed_off', 'chat', p_chat::text, jsonb_build_object('reason', p_reason, 'rule', p_rule, 'run_id', p_run, 'task_id', tid, 'cancelled_runs', n), case when p_reason = 'manual' then 'user' else 'system' end);
  perform outreach_emit_event(c.workspace_id, 'ai_reply.handed_off', jsonb_build_object('chat_id', p_chat, 'lead_id', c.lead_id, 'sender_id', c.sender_id, 'reason', p_reason, 'rule', p_rule, 'run_id', p_run, 'task_id', tid, 'assignee', assignee));
  return jsonb_build_object('ok', true, 'reason', p_reason, 'task_id', tid, 'assignee', assignee, 'cancelled_runs', n);
end $$;

create or replace function outreach_ai_resume_chat(p_chat uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  update outreach_chats set ai_handed_off_at = null, ai_handoff_reason = null, ai_handoff_rule = null, ai_handoff_run_id = null,
         autopilot_state = 'active', autopilot_paused_until = null, autopilot_paused_reason = null, stage_stale = true
   where id = p_chat;
  update outreach_tasks set completed_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('completed_reason', 'ai_resumed', 'at', now())
   where chat_id = p_chat and kind = 'ai_handoff' and completed_at is null;
  return jsonb_build_object('ok', true, 'was', jsonb_build_object('handed_off_at', c.ai_handed_off_at, 'reason', c.ai_handoff_reason, 'autopilot_state', c.autopilot_state));
end $$;

-- scheduled sends of a sequence wait for a person instead (pause / archive / downgrade / consent)
create or replace function outreach_ai_reply_demote_scheduled(p_sequence uuid, p_reason text) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = array_append(gate_failures, p_reason)
   where sequence_id = p_sequence and status = 'scheduled';
  get diagnostics n = row_count;
  return n;
end $$;

-- called by outreach_set_sequence_status (patched below)
create or replace function outreach_ai_reply_on_sequence_status(p_sequence uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; waiting int := 0; prev_resumed timestamptz;
begin
  if p_status in ('paused', 'archived', 'draft') then
    n := outreach_ai_reply_demote_scheduled(p_sequence, 'sequence_' || p_status);
    return jsonb_build_object('demoted', n);
  elsif p_status = 'active' then
    -- drafts that piled up while paused: they stay drafts; the resume dialog says how many
    select count(*) into waiting from outreach_ai_reply_runs r join outreach_chats c on c.id = r.chat_id
     where c.reply_sequence_id = p_sequence and r.status = 'draft_ready' and r.trigger_kind = 'auto';
    return jsonb_build_object('drafts_waiting', waiting);
  end if;
  return '{}'::jsonb;
end $$;

do $$
declare def text; nd text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_set_sequence_status';
  if def is null then raise exception 'outreach_set_sequence_status not found'; end if;
  if position('outreach_ai_reply_on_sequence_status' in def) > 0 then return; end if;
  nd := replace(def, $q$update outreach_sequences set status = 'active', throttled_reason = null, updated_at = now() where id = p_id;$q$,
                     $q$update outreach_sequences set status = 'active', throttled_reason = null, resumed_at = case when s.status in ('paused','archived') then now() else resumed_at end, updated_at = now() where id = p_id;
    v := coalesce(v, '{}'::jsonb) || outreach_ai_reply_on_sequence_status(p_id, 'active');$q$);
  nd := replace(nd, $q$update outreach_sequences set status = 'paused', updated_at = now() where id = p_id;$q$,
                    $q$update outreach_sequences set status = 'paused', updated_at = now() where id = p_id;
    v := coalesce(v, '{}'::jsonb) || outreach_ai_reply_on_sequence_status(p_id, 'paused');$q$);
  nd := replace(nd, $q$update outreach_sequences set status = 'archived', archived_at = now(), updated_at = now() where id = p_id;$q$,
                    $q$update outreach_sequences set status = 'archived', archived_at = now(), updated_at = now() where id = p_id;
    v := coalesce(v, '{}'::jsonb) || outreach_ai_reply_on_sequence_status(p_id, 'archived');$q$);
  nd := replace(nd, $q$return jsonb_build_object('status', p_status, 'warnings', coalesce(v->'warnings','[]'::jsonb));$q$,
                    $q$return jsonb_build_object('status', p_status, 'warnings', coalesce(v->'warnings','[]'::jsonb), 'ai_replies', coalesce(v, '{}'::jsonb) - 'warnings' - 'errors');$q$);
  if position('outreach_ai_reply_on_sequence_status' in nd) = 0 then raise exception 'outreach_set_sequence_status: anchors not found'; end if;
  execute nd;
end $$;

-- ============================================================================= scheduling links (T3)
create or replace function outreach__ai_has_scheduling_link(p_text text) returns boolean
language plpgsql stable set search_path = public, extensions as $$
declare m text[]; h_ text; p_ text;
begin
  if p_text is null then return false; end if;
  for m in select regexp_matches(lower(p_text), '(?:https?://)?(?:www\.)?([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(/[^\s<>"'')\]]*)?', 'g') loop
    h_ := m[1]; p_ := coalesce(m[2], '');
    if exists (select 1 from outreach_scheduling_domains d where (h_ = d.host or h_ like '%.' || d.host) and (d.path_prefix is null or p_ like d.path_prefix || '%')) then
      return true;
    end if;
  end loop;
  return false;
end $$;

-- ============================================================================= sessions + enqueue (§1.3, §6, §7)
create or replace function outreach__ai_open_run(p_chat uuid, p_ids uuid[], p_quiet int, p_max int, p_mode text, p_inbound_at timestamptz) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; nid uuid;
begin
  select * into c from outreach_chats where id = p_chat;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids,
                                     debounce_until, debounce_hard_until, mode, timings, session_kind)
  values (c.workspace_id, c.client_id, c.id, c.sender_id, c.lead_id, c.reply_sequence_id, c.provider, p_ids,
          now() + make_interval(secs => p_quiet), now() + make_interval(secs => p_max), p_mode::outreach_reply_mode_t,
          jsonb_build_object('inbound_at', coalesce(p_inbound_at, now())), coalesce(c.ai_session_kind, 'normal'))
  returning id into nid;
  return nid;
end $$;

-- open follow-up tasks the AI / system created for this lead + chat are done ("They replied"); a person's stay open with a marker
create or replace function outreach__ai_tasks_on_reply(p_chat uuid, p_message uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; n int;
begin
  select * into c from outreach_chats where id = p_chat;
  update outreach_tasks set completed_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('completed_reason', 'they_replied', 'message_id', p_message, 'at', now())
   where chat_id = p_chat and completed_at is null and source in ('ai', 'system') and kind = 'follow_up';
  get diagnostics n = row_count;
  update outreach_tasks set result = coalesce(result, '{}'::jsonb) || jsonb_build_object('they_replied_at', now(), 'they_replied_message_id', p_message)
   where chat_id = p_chat and completed_at is null and source = 'user' and kind in ('follow_up', 'manual_node', 'call') and not (coalesce(result, '{}'::jsonb) ? 'they_replied_at');
  update outreach_chats set ai_quiet_task_at = null where id = p_chat and ai_quiet_task_at is not null;
  return n;
end $$;

create or replace function outreach_ai_reply_enqueue(p_chat uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype; eff jsonb; pol jsonb; r outreach_ai_reply_runs%rowtype;
        prev_out outreach_messages%rowtype; prev_any timestamptz; lat int; fast int; nid uuid; ids uuid[]; first_at timestamptz;
        gap numeric; skind text := 'normal'; res jsonb; srs outreach_sequence_reply_settings%rowtype; tid uuid; nm text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  if not found then return jsonb_build_object('action', 'skipped', 'why', 'no_chat'); end if;
  select * into m from outreach_messages where id = p_message and chat_id = p_chat;
  if not found or m.direction <> 'in' or m.event_type is not null then return jsonb_build_object('action', 'skipped', 'why', 'not_inbound'); end if;

  -- tasks: their reply closes the AI's follow-ups and marks a person's
  perform outreach__ai_tasks_on_reply(p_chat, p_message);

  -- §10.3: how fast did they answer our last message, and was it an AI send? Three sub-20 s answers in a row → another bot.
  select * into prev_out from outreach_messages where chat_id = p_chat and direction = 'out' and sent_at <= m.sent_at order by sent_at desc limit 1;
  if prev_out.id is not null and prev_out.origin = 'ai_autopilot' and prev_out.ai_reply_run_id is not null then
    lat := greatest(0, extract(epoch from m.sent_at - prev_out.sent_at))::int;
    update outreach_ai_reply_runs set reply_latency_s = coalesce(reply_latency_s, lat) where id = prev_out.ai_reply_run_id;
    select count(*) filter (where x.reply_latency_s < 20) into fast
      from (select r2.reply_latency_s from outreach_ai_reply_runs r2 where r2.chat_id = p_chat and r2.status = 'sent' and r2.sent_origin = 'ai_autopilot'
             order by r2.updated_at desc limit 3) x;
    if fast >= 3 and c.autopilot_state = 'active' then
      update outreach_chats set autopilot_state = 'paused_bot', autopilot_paused_until = null, autopilot_paused_reason = 'fast_replies' where id = p_chat;
      perform outreach_emit_event(c.workspace_id, 'ai_reply.paused', jsonb_build_object('chat_id', p_chat, 'state', 'paused_bot', 'reason', 'fast_replies'));
    end if;
  end if;

  -- the gap since the previous message in the chat (any direction) decides the session (§6)
  select max(sent_at) into prev_any from outreach_messages where chat_id = p_chat and id <> p_message and event_type is null and deleted_at is null and sent_at <= m.sent_at;
  if prev_any is not null then gap := round((extract(epoch from m.sent_at - prev_any) / 86400)::numeric, 1); end if;

  -- §1.3: which sequence this conversation belongs to (a newer sequence's message switches the chat)
  res := outreach__ai_resolve_sequence(p_chat, p_message);
  select * into c from outreach_chats where id = p_chat;
  if c.reply_sequence_id is not null then
    srs := outreach_ai_seq_settings_ensure(c.reply_sequence_id);
    if gap is not null and gap >= srs.dormant_after_days then skind := 'dormant';
    elsif gap is not null and gap >= srs.returning_after_days then skind := 'returning';
    end if;
  end if;

  -- §2.4 / §6: handed off → no run. Coming back after a gap reopens the handoff task and tells its owner.
  if c.ai_handed_off_at is not null and not (res->>'switched')::boolean then
    if skind <> 'normal' then
      select coalesce(l.full_name, c.attendee_name, 'The lead') into nm from outreach_leads l where l.id = c.lead_id;
      nm := coalesce(nm, c.attendee_name, 'The lead');
      update outreach_tasks set completed_at = null, due_at = now(), title = left(nm || ' came back after ' || round(gap)::int || ' days (handed off ' || to_char(c.ai_handed_off_at, 'DD Mon') || ' · ' || coalesce(replace(c.ai_handoff_reason, '_', ' '), '') || ')', 200),
             result = coalesce(result, '{}'::jsonb) || jsonb_build_object('reopened_at', now(), 'gap_days', gap)
       where id = (select id from outreach_tasks where chat_id = p_chat and kind = 'ai_handoff' order by created_at desc limit 1)
      returning id into tid;
      if tid is null then
        insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, due_at, assigned_to, source)
        values (c.workspace_id, c.client_id, 'ai_handoff', c.lead_id, c.sender_id, c.id, left(nm || ' came back after ' || round(gap)::int || ' days (handed off ' || to_char(c.ai_handed_off_at, 'DD Mon') || ')', 200),
                'They wrote again after the AI handed this conversation to a person. The AI does not reply here; it is yours.', now(),
                coalesce(c.assigned_to, (select created_by from outreach_sequences where id = c.reply_sequence_id)), 'system')
        returning id into tid;
      end if;
      perform outreach_emit_event(c.workspace_id, 'ai_reply.returned', jsonb_build_object('chat_id', p_chat, 'lead_id', c.lead_id, 'gap_days', gap, 'task_id', tid, 'handed_off_at', c.ai_handed_off_at, 'reason', c.ai_handoff_reason));
    end if;
    return jsonb_build_object('action', 'skipped', 'why', 'handed_off', 'returned', skind <> 'normal', 'gap_days', gap, 'task_id', tid);
  end if;

  -- a new session: counters reset; a dormant return starts at Re-engage (no stage)
  if skind <> 'normal' and not (res->>'switched')::boolean then
    update outreach_chats set ai_session_started_at = m.sent_at, ai_session_kind = skind, ai_session_count = ai_session_count + 1,
           ai_replies_count = 0, conversation_exchanges = 0, last_ai_move = null, stage_stale = false,
           conversation_stage = case when skind = 'dormant' then null else conversation_stage end
     where id = p_chat;
    perform outreach_audit(c.workspace_id, 'ai_reply.session_started', 'chat', p_chat::text, jsonb_build_object('kind', skind, 'gap_days', gap, 'previous_stage', c.conversation_stage), 'system');
  elsif c.ai_session_started_at is null then
    update outreach_chats set ai_session_started_at = m.sent_at, ai_session_kind = 'normal' where id = p_chat;
  end if;

  eff := outreach__ai_effective(p_chat);
  if eff->>'mode' = 'off' then return jsonb_build_object('action', 'skipped', 'why', coalesce(eff->>'reason_code', 'off'), 'gap_days', gap, 'session', skind); end if;
  pol := eff->'policy';

  select * into r from outreach_ai_reply_runs where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled','sending') for update;
  if found then
    if p_message = any(r.inbound_message_ids) or p_message = any(r.followup_inbound_ids) then return jsonb_build_object('action', 'duplicate', 'run_id', r.id); end if;
    if r.status = 'debouncing' then
      update outreach_ai_reply_runs set inbound_message_ids = inbound_message_ids || p_message,
             debounce_until = now() + make_interval(secs => (pol->>'debounce_quiet_s')::int)
       where id = r.id;
      return jsonb_build_object('action', 'appended', 'run_id', r.id);
    elsif r.status = 'sending' then
      update outreach_ai_reply_runs set followup_inbound_ids = followup_inbound_ids || p_message where id = r.id;
      return jsonb_build_object('action', 'deferred', 'run_id', r.id);
    end if;
    -- drafting / draft_ready / scheduled: the old draft answers too little now — replace it (the worker's CAS drops a draft in flight)
    update outreach_ai_reply_runs set status = 'superseded' where id = r.id;
    ids := case when r.trigger_kind = 'manual' then array[p_message] else r.inbound_message_ids || p_message end;
    first_at := case when r.trigger_kind = 'manual' then m.sent_at else coalesce((r.timings->>'inbound_at')::timestamptz, m.sent_at) end;
    nid := outreach__ai_open_run(p_chat, ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', first_at);
    update outreach_ai_reply_runs set gap_days = gap where id = nid;
    return jsonb_build_object('action', 'superseded', 'run_id', nid, 'superseded', r.id, 'session', skind);
  end if;
  nid := outreach__ai_open_run(p_chat, array[p_message], (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', m.sent_at);
  update outreach_ai_reply_runs set gap_days = gap where id = nid;
  return jsonb_build_object('action', 'created', 'run_id', nid, 'session', skind, 'gap_days', gap);
end $$;

-- ============================================================================= manual runs: Draft with AI (§5)
-- Opens (or returns) the run the composer's "Draft with AI" works on. Service-only; the edge function checks the person.
create or replace function outreach_ai_reply_manual_open(p_chat uuid, p_user uuid, p_via text, p_guidance text, p_variants int default 1, p_regenerate boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; r outreach_ai_reply_runs%rowtype; eff jsonb; ids uuid[]; last_out timestamptz; nid uuid; taken uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if c.reply_sequence_id is null then perform outreach__ai_resolve_sequence(p_chat, null); select * into c from outreach_chats where id = p_chat; end if;
  if c.reply_sequence_id is not null then perform outreach_ai_seq_settings_ensure(c.reply_sequence_id); end if;
  eff := outreach__ai_effective(p_chat);
  select * into r from outreach_ai_reply_runs where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled','sending') for update;
  if r.id is not null then
    if r.status = 'sending' then raise exception 'E_AI_SENDING: the AI is sending its reply in this chat right now'; end if;
    if not p_regenerate and r.status in ('draft_ready', 'scheduled') and r.draft_text is not null then
      return jsonb_build_object('run_id', r.id, 'source', case when r.trigger_kind = 'manual' then 'existing_manual' else 'existing_auto' end, 'status', r.status,
                                'prompt', jsonb_build_object('sequence', eff->>'sequence_name', 'version', r.master_prompt_version, 'fallback', eff->>'fallback'));
    end if;
    -- a pending / scheduled auto run is taken over by the person: it never sends by itself now
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'taken_manual', cancelled_by = p_user where id = r.id;
    taken := r.id;
  end if;
  -- what they wrote since our last message (else their last message)
  select max(sent_at) into last_out from outreach_messages where chat_id = p_chat and direction = 'out' and event_type is null and deleted_at is null;
  select array_agg(id order by sent_at) into ids from outreach_messages where chat_id = p_chat and direction = 'in' and event_type is null and deleted_at is null and (last_out is null or sent_at > last_out);
  if ids is null then
    select array_agg(id) into ids from (select id from outreach_messages where chat_id = p_chat and direction = 'in' and event_type is null and deleted_at is null order by sent_at desc limit 1) x;
  end if;
  if ids is null then raise exception 'E_NOTHING_TO_ANSWER: there is no message from them to answer yet'; end if;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until,
                                     mode, status, attempts, trigger_kind, requested_by, requested_via, guidance, variants, timings, session_kind)
  values (c.workspace_id, c.client_id, c.id, c.sender_id, c.lead_id, c.reply_sequence_id, c.provider, ids, now(), now(),
          'draft', 'drafting', 1, 'manual', p_user, p_via, left(p_guidance, 300), jsonb_build_object('n', greatest(1, least(3, coalesce(p_variants, 1)))),
          jsonb_build_object('inbound_at', (select min(sent_at) from outreach_messages where id = any(ids)), 'requested_at', now()), coalesce(c.ai_session_kind, 'normal'))
  returning id into nid;
  return jsonb_build_object('run_id', nid, 'source', 'new', 'status', 'drafting', 'taken_over', taken,
                            'prompt', jsonb_build_object('sequence', eff->>'sequence_name', 'version', eff->'master_prompt'->>'version', 'fallback', eff->>'fallback'));
end $$;

-- "Edit" on a scheduled auto draft: the send is cancelled before the person types (no double send)
create or replace function outreach_ai_reply_take_manual(p_run uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach__ai_chat_lock(r.chat_id);
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', scheduled_send_at = null, gate_failures = gate_failures || 'taken_manual'::text, dispatched_by = null
   where id = p_run and status = 'scheduled' returning * into r;
  if r.id is null then
    select * into r from outreach_ai_reply_runs where id = p_run;
    if r.status = 'sending' then raise exception 'E_AI_SENDING: the AI is sending this reply right now'; end if;
    return jsonb_build_object('ok', true, 'status', r.status, 'changed', false);
  end if;
  return jsonb_build_object('ok', true, 'status', r.status, 'changed', true);
end $$;

-- ============================================================================= gate facts (worker + Draft with AI)
create or replace function outreach_ai_reply_gate_facts(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; s outreach_senders%rowtype; l outreach_leads%rowtype; srs outreach_sequence_reply_settings%rowtype; q outreach_sequences%rowtype;
        eff jsonb; first_in timestamptz; contacted boolean; stage_pos int; stage_name text; handoff_pos int; tags text[]; supp text;
        day date; ai_today int; combined int; burst jsonb; thread jsonb; seq jsonb; first_step jsonb; mpj jsonb; scen jsonb; faqs jsonb; notes jsonb; prev_stage text; mpid uuid; t jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then return null; end if;
  select * into c from outreach_chats where id = r.chat_id;
  select * into s from outreach_senders where id = r.sender_id;
  eff := outreach__ai_effective(r.chat_id);
  if c.reply_sequence_id is not null then
    select * into srs from outreach_sequence_reply_settings where sequence_id = c.reply_sequence_id;
    select * into q from outreach_sequences where id = c.reply_sequence_id;
  end if;
  if c.lead_id is not null then
    select * into l from outreach_leads where id = c.lead_id;
    select st.position, st.name into stage_pos, stage_name from outreach_stages st where st.id = l.stage_id;
    select array_agg(lower(t_.name::text)) into tags from outreach_lead_tags lt join outreach_tags t_ on t_.id = lt.tag_id where lt.lead_id = l.id;
    supp := outreach_lead_suppression_reason(l, c.client_id, r.sequence_id);
    select jsonb_build_object('summary', n.summary, 'items', n.items, 'updated_at', n.updated_at) into notes from outreach_lead_ai_notes n where n.lead_id = l.id;
  end if;
  if srs.handoff_stage_id is not null then select st.position into handoff_pos from outreach_stages st where st.id = srs.handoff_stage_id; end if;
  -- G3: we wrote first (a sequence action or a human / AI outbound before their first message)
  select min(m.sent_at) into first_in from outreach_messages m where m.chat_id = c.id and m.direction = 'in' and m.event_type is null;
  contacted := exists (select 1 from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sent_at < coalesce(first_in, now()))
            or (c.lead_id is not null and exists (select 1 from outreach_actions a where a.lead_id = c.lead_id and a.sender_id = c.sender_id and a.status = 'sent'
                                                   and a.action_type in ('invite','message','new_chat','inmail') and a.executed_at < coalesce(first_in, now())));
  day := outreach_sender_local_date(s.id, now());
  select count(*) filter (where a.action_type = 'ai_reply'), count(*) into ai_today, combined
    from outreach_actions a where a.sender_id = s.id and a.status = 'sent' and a.action_type in ('message','new_chat','inmail','reply','ai_reply')
     and a.executed_at >= now() - interval '36 hours' and outreach_sender_local_date(s.id, a.executed_at) = day;
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text, 'transcript', m.transcript, 'sent_at', m.sent_at, 'attachments', m.attachments,
           'unsupported', m.unsupported, 'deleted', m.deleted_at is not null, 'edited_at', m.edited_at, 'classification', m.classification,
           'flags', to_jsonb(m.ai_flags), 'intent', m.intent, 'classified', m.classified_at is not null, 'reactions', m.reactions) order by m.sent_at), '[]'::jsonb)
    into burst from outreach_messages m where m.id = any(r.inbound_message_ids);
  select coalesce(jsonb_agg(x order by x->>'at'), '[]'::jsonb) into thread from (
    select jsonb_build_object('id', m.id, 'at', m.sent_at, 'text', coalesce(m.text, m.transcript, case when jsonb_array_length(m.attachments) > 0 then '[attachment]' end),
             'from', case when m.direction = 'in' then 'prospect'
                          when m.origin = 'sequence' then 'us_sequence'
                          when m.origin in ('ai_autopilot') then 'us_ai'
                          when m.origin in ('ai_draft_sent','ai_edited','inbox_user','external_device') then 'us_teammate'
                          else 'us' end,
             'action_type', a.action_type, 'node_id', a.node_id, 'answered', m.id = any(r.inbound_message_ids)) x
      from outreach_messages m left join outreach_actions a on a.id = m.action_id
     where m.chat_id = c.id and m.deleted_at is null and m.event_type is null
     order by m.sent_at desc limit 12) t_;
  if r.sequence_id is not null then
    select jsonb_build_object('id', q_.id, 'name', q_.name, 'brief', q_.brief, 'status', q_.status, 'resumed_at', q_.resumed_at) into seq from outreach_sequences q_ where q_.id = r.sequence_id;
  end if;
  select jsonb_build_object('node_id', a.node_id, 'variant_id', a.variant_id, 'action_type', a.action_type) into first_step
    from outreach_messages m join outreach_actions a on a.id = m.replied_to_action_id
   where m.chat_id = c.id and m.is_first_reply order by m.sent_at limit 1;
  -- the prompt (sequence's, or the fallback for Draft with AI) with its cards and Q&A
  mpid := (eff->'master_prompt'->>'id')::uuid;
  if mpid is not null then
    select jsonb_build_object('id', mp.id, 'version', mp.version, 'body', mp.body, 'editor_mode', mp.editor_mode, 'settings', mp.settings, 'sections', mp.sections,
             'knowledge_source_ids', to_jsonb(mp.knowledge_source_ids), 'name', mp.name, 'scope', mp.scope) into mpj from outreach_master_prompts mp where mp.id = mpid;
    select coalesce(jsonb_agg(jsonb_build_object('id', sc.id, 'title', sc.title, 'when_text', sc.when_text, 'do_text', sc.do_text, 'enabled', sc.enabled) order by sc.position), '[]'::jsonb)
      into scen from outreach_master_prompt_scenarios sc where sc.master_prompt_id = mpid and sc.enabled;
    select coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'question', f.question, 'answer', f.answer) order by f.created_at), '[]'::jsonb)
      into faqs from outreach_master_prompt_faqs f where f.master_prompt_id = mpid and f.enabled;
  else
    t := outreach_master_prompt_template();
    mpj := jsonb_build_object('id', null, 'version', 0, 'body', t->>'body', 'editor_mode', 'guided', 'settings', t->'settings', 'sections', t->'sections', 'knowledge_source_ids', '[]'::jsonb, 'name', 'Template', 'scope', 'template');
    scen := '[]'::jsonb; faqs := '[]'::jsonb;
  end if;
  select x.stage_after into prev_stage from outreach_ai_reply_runs x where x.chat_id = c.id and x.status = 'sent' and x.id <> r.id order by x.updated_at desc limit 1;
  return jsonb_build_object(
    'run', to_jsonb(r), 'effective', eff, 'master_prompt', mpj, 'scenarios', scen, 'faqs', faqs, 'lead_notes', notes,
    'chat', jsonb_build_object('id', c.id, 'provider', c.provider, 'archived', c.archived, 'is_group', c.is_group, 'lead_id', c.lead_id, 'client_id', c.client_id,
              'attendee_name', c.attendee_name, 'autopilot_state', c.autopilot_state, 'autopilot_paused_until', c.autopilot_paused_until,
              'stage', c.conversation_stage, 'exchanges', c.conversation_exchanges, 'ai_replies_count', c.ai_replies_count,
              'last_ai_move', c.last_ai_move, 'stage_stale', c.stage_stale, 'assigned_to', c.assigned_to, 'unipile_chat_id', c.unipile_chat_id,
              'handed_off_at', c.ai_handed_off_at, 'handoff_reason', c.ai_handoff_reason, 'session_kind', coalesce(c.ai_session_kind, 'normal'),
              'session_started_at', c.ai_session_started_at, 'session_count', c.ai_session_count, 'previous_stage', prev_stage, 'reply_sequence_id', c.reply_sequence_id),
    'sender', jsonb_build_object('id', s.id, 'status', s.status, 'display_name', s.display_name, 'timezone', s.timezone, 'schedule', s.schedule,
              'provider', s.provider, 'paused_until', s.paused_until, 'health_score', s.health_score, 'unipile_account_id', s.unipile_account_id,
              'owner_email', s.owner_email, 'client_id', s.client_id),
    'lead', case when l.id is null then null else jsonb_build_object('id', l.id, 'full_name', l.full_name, 'first_name', l.first_name, 'title', l.title,
              'company', l.company, 'headline', l.headline, 'location', l.location, 'do_not_contact', l.do_not_contact, 'unsubscribed', l.unsubscribed,
              'stage_position', stage_pos, 'stage_name', stage_name, 'tags', coalesce(to_jsonb(tags), '[]'::jsonb), 'suppression', supp) end,
    'settings_row', case when srs.sequence_id is null then null else jsonb_build_object('mode', srs.mode, 'warmup_remaining', srs.warmup_remaining, 'pitch_after_replies', srs.pitch_after_replies,
              'max_ai_replies_per_chat', srs.max_ai_replies_per_chat, 'returning_after_days', srs.returning_after_days, 'dormant_after_days', srs.dormant_after_days,
              'inactivity_days', srs.inactivity_days, 'handoff_stage_id', srs.handoff_stage_id) end,
    'handoff_stage_position', handoff_pos, 'contacted_first', contacted, 'burst', burst, 'thread', thread, 'sequence', seq, 'first_step', first_step,
    'ai_sends_today', coalesce(ai_today, 0), 'combined_today', coalesce(combined, 0), 'pool', outreach__ai_pool(r.workspace_id),
    'today_local', day);
end $$;

-- ============================================================================= knowledge retrieval (§9.2)
create or replace function outreach_knowledge_search(p_ws uuid, p_sources uuid[], p_query text, p_limit int default 5) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare q tsquery; out_ jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_sources is null or cardinality(p_sources) = 0 or nullif(btrim(coalesce(p_query, '')), '') is null then return '[]'::jsonb; end if;
  q := websearch_to_tsquery('english', left(p_query, 500));
  select coalesce(jsonb_agg(jsonb_build_object('chunk_id', x.id, 'source_id', x.source_id, 'title', x.title, 'url', x.url, 'heading', x.heading, 'text', x.text, 'score', x.score) order by x.score desc), '[]'::jsonb)
    into out_ from (
      select k.id, k.source_id, s.title, k.url, k.heading, k.text,
             ts_rank_cd(k.tsv, q, 1) + 0.5 * similarity(coalesce(k.heading, '') || ' ' || left(k.text, 2000), left(p_query, 500)) as score
        from outreach_knowledge_chunks k join outreach_knowledge_sources s on s.id = k.source_id
       where k.workspace_id = p_ws and k.source_id = any(p_sources) and s.status = 'ready'
         and (k.tsv @@ q or similarity(coalesce(k.heading, '') || ' ' || left(k.text, 2000), left(p_query, 500)) > 0.08)
       order by score desc limit greatest(1, least(coalesce(p_limit, 5), 10))) x;
  return out_;
end $$;

-- Q&A for a question: all when the prompt has ≤ 30, else the closest 5 (trigram)
create or replace function outreach__ai_faqs_for(p_mp uuid, p_question text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare n int;
begin
  select count(*) into n from outreach_master_prompt_faqs where master_prompt_id = p_mp and enabled;
  if n <= 30 then
    return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'question', question, 'answer', answer) order by created_at) from outreach_master_prompt_faqs where master_prompt_id = p_mp and enabled), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'question', x.question, 'answer', x.answer) order by x.sim desc) from (
    select id, question, answer, similarity(question, coalesce(p_question, '')) sim from outreach_master_prompt_faqs where master_prompt_id = p_mp and enabled
     order by sim desc limit 5) x), '[]'::jsonb);
end $$;

-- ============================================================================= finalize (worker + manual)
create or replace function outreach__ai_run_json(r outreach_ai_reply_runs) returns jsonb
language sql stable set search_path = public, extensions as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'chat_id', r.chat_id, 'status', r.status, 'decision', r.decision, 'mode', r.mode,
    'draft_text', r.draft_text, 'final_text', r.final_text, 'stage_before', r.stage_before, 'stage_after', r.stage_after, 'move', r.move,
    'rule_applied', r.rule_applied, 'escalation_reasons', to_jsonb(r.escalation_reasons), 'gate_failures', to_jsonb(r.gate_failures),
    'side_effects', coalesce(r.side_effects, '[]'::jsonb), 'facts_used', coalesce(r.facts_used, '[]'::jsonb), 'draft_confidence', r.draft_confidence,
    'validator', r.validator, 'verifier', r.verifier, 'scheduled_send_at', r.scheduled_send_at, 'master_prompt_id', r.master_prompt_id,
    'master_prompt_version', r.master_prompt_version, 'sent_origin', r.sent_origin, 'cancel_reason', r.cancel_reason, 'cancel_note', r.cancel_note,
    'flags', to_jsonb(r.flags), 'intent', r.intent, 'redrafts', r.redrafts,
    'trigger', r.trigger_kind, 'requested_by', r.requested_by, 'guidance', r.guidance, 'variants', r.variants,
    'stop_after_send', r.stop_after_send, 'stop_rule', r.stop_rule, 'scenario_id', r.scenario_id,
    'scenario_title', (select sc.title from outreach_master_prompt_scenarios sc where sc.id = r.scenario_id),
    'gap_days', r.gap_days, 'session_kind', r.session_kind, 'warnings', coalesce(r.warnings, '[]'::jsonb),
    'created_at', r.created_at, 'updated_at', r.updated_at, 'timings', r.timings) end
$$;

create or replace function outreach__ai_run_apply(p_run uuid, p_from text[], p_to text, p_patch jsonb) returns outreach_ai_reply_runs
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; p jsonb := coalesce(p_patch, '{}'::jsonb) - 'id' - 'workspace_id' - 'chat_id' - 'sender_id' - 'status' - 'created_at' - 'timings' - 'trigger_kind' - 'requested_by' - 'handoff_reason';
begin
  update outreach_ai_reply_runs x set
    (mode, policy_snapshot, master_prompt_id, master_prompt_version, floor_sha256, model, decision, intent, flags, language,
     stage_before, stage_after, move, rule_applied, side_effects, draft_confidence, draft_text, final_text, facts_used, validator, verifier,
     redrafts, gate_failures, escalation_reasons, context, scheduled_send_at, sent_message_id, action_id, sent_origin, dispatched_by,
     cancelled_by, cancel_reason, cancel_note, edit_distance, facts_changed, error, next_attempt_at, attempts, inbound_message_ids,
     stop_after_send, stop_rule, scenario_id, variants, warnings)
    = (select y.mode, y.policy_snapshot, y.master_prompt_id, y.master_prompt_version, y.floor_sha256, y.model, y.decision, y.intent, y.flags, y.language,
              y.stage_before, y.stage_after, y.move, y.rule_applied, y.side_effects, y.draft_confidence, y.draft_text, y.final_text, y.facts_used, y.validator, y.verifier,
              y.redrafts, y.gate_failures, y.escalation_reasons, y.context, y.scheduled_send_at, y.sent_message_id, y.action_id, y.sent_origin, y.dispatched_by,
              y.cancelled_by, y.cancel_reason, y.cancel_note, y.edit_distance, y.facts_changed, y.error, y.next_attempt_at, y.attempts, y.inbound_message_ids,
              y.stop_after_send, y.stop_rule, y.scenario_id, y.variants, y.warnings
         from jsonb_populate_record(x, p) y),
    status = p_to::outreach_ai_reply_status_t,
    timings = x.timings || coalesce(p_patch->'timings', '{}'::jsonb)
  where x.id = p_run and x.status::text = any(p_from)
  returning x.* into r;
  return r;
end $$;

create or replace function outreach_ai_reply_finalize(p_run uuid, p_to text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; tid uuid; n int := 0; patch jsonb := coalesce(p_patch, '{}'::jsonb); ho jsonb; tgt text := p_to;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_to not in ('draft_ready','scheduled','escalated','no_reply','cancelled','failed','debouncing') then raise exception 'E_PAYLOAD_INVALID: bad target %', p_to; end if;
  perform outreach__ai_chat_lock((select chat_id from outreach_ai_reply_runs where id = p_run));
  select * into r from outreach_ai_reply_runs where id = p_run;
  if r.id is null then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;
  -- manual runs only ever become drafts (or fail / retry); nothing schedules or escalates a person's own request
  if r.trigger_kind = 'manual' and tgt in ('scheduled', 'escalated', 'no_reply') then tgt := 'draft_ready'; end if;
  -- T3: a scheduling link in the reply always ends the AI conversation once sent (deterministic backstop for T4)
  if tgt in ('scheduled', 'draft_ready') and outreach__ai_has_scheduling_link(patch->>'draft_text') and not coalesce((patch->>'stop_after_send')::boolean, false) then
    patch := patch || jsonb_build_object('stop_after_send', true, 'stop_rule', coalesce(nullif(patch->>'stop_rule', ''), 'calendar link'));
  end if;
  r := outreach__ai_run_apply(p_run, array['drafting'], tgt, patch);
  if r.id is null then return jsonb_build_object('ok', false, 'why', 'state_changed'); end if;
  if r.trigger_kind = 'auto' then
    if tgt = 'escalated' then
      tid := outreach__ai_escalation_task(r.id);
      -- an upset or complaining reply to one of OUR AI sends pauses the chat (§10.3); an upset first reply is just escalated
      if (r.flags && array['hostile','complaint']) and exists (select 1 from outreach_messages m where m.chat_id = r.chat_id and m.direction = 'out' and m.origin = 'ai_autopilot') then
        update outreach_chats set autopilot_state = 'paused_escalated', autopilot_paused_until = null, autopilot_paused_reason = 'hostile_after_ai' where id = r.chat_id;
      end if;
    elsif tgt = 'no_reply' then
      n := outreach__ai_apply_side_effects(r.id);
    elsif tgt = 'failed' and r.mode = 'autopilot' then
      tid := outreach__ai_escalation_task(r.id);
    end if;
    -- T5 / T6 decided by the worker's gates: the conversation is handed off with no reply
    if p_patch ? 'handoff_reason' and tgt in ('cancelled', 'no_reply', 'escalated') then
      ho := outreach_ai_handoff(r.chat_id, p_patch->>'handoff_reason', r.id, p_patch->>'stop_rule');
    end if;
    -- a processed burst feeds the lead notes (§9.4)
    if tgt in ('draft_ready', 'scheduled', 'escalated', 'no_reply') and r.lead_id is not null and r.provider = 'LINKEDIN' then
      insert into outreach_ai_lead_notes_queue(workspace_id, lead_id, chat_id, run_id, message_ids) values (r.workspace_id, r.lead_id, r.chat_id, r.id, r.inbound_message_ids);
    end if;
  end if;
  perform outreach_emit_event(r.workspace_id, 'ai_reply.' || tgt, jsonb_build_object('run_id', r.id, 'chat_id', r.chat_id, 'lead_id', r.lead_id, 'sender_id', r.sender_id,
          'decision', r.decision, 'stage_after', r.stage_after, 'reasons', to_jsonb(r.escalation_reasons), 'scheduled_send_at', r.scheduled_send_at, 'trigger', r.trigger_kind,
          'stop_after_send', r.stop_after_send, 'scenario_id', r.scenario_id));
  return jsonb_build_object('ok', true, 'run', outreach__ai_run_json(r), 'task_id', tid, 'side_effects', n, 'handoff', ho);
end $$;

-- side effects / escalation tasks are the AI's (source = 'ai')
create or replace function outreach__ai_apply_side_effects(p_run uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; e jsonb; n int := 0; due date; tg uuid; nm text; tname text;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found or r.side_effects is null or jsonb_typeof(r.side_effects) <> 'array' then return 0; end if;
  select * into c from outreach_chats where id = r.chat_id;
  select full_name into nm from outreach_leads where id = c.lead_id;
  nm := coalesce(nm, c.attendee_name, 'the lead');
  for e in select x from jsonb_array_elements(r.side_effects) x limit 5 loop
    case e->>'type'
      when 'task' then
        due := null;
        begin due := (e->>'due')::date; exception when others then due := null; end;
        if due is not null and (due < current_date or due > current_date + 366) then due := null; end if;
        insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, due_at, assigned_to, source)
        values (r.workspace_id, c.client_id, 'follow_up', c.lead_id, c.sender_id, c.id,
                left(case when e->>'kind' = 'contact_referral' then 'Referral from ' || nm || ': ' || coalesce(e->>'name', 'contact')
                          else 'Follow up with ' || nm end, 200),
                left(concat_ws(E'\n', nullif(e->>'note', ''), case when e->>'kind' = 'contact_referral' then 'Contact as they wrote it: ' || coalesce(e->>'contact', e->>'name', '') end,
                               'Created by an AI reply (' || coalesce(r.rule_applied, 'master prompt') || ').'), 2000),
                coalesce(due::timestamptz + interval '9 hours', now() + interval '1 day'), c.assigned_to, 'ai');
        n := n + 1;
      when 'archive' then update outreach_chats set archived = true where id = c.id; n := n + 1;
      when 'mark_read' then update outreach_chats set unread = false, unread_count = 0 where id = c.id; n := n + 1;
      when 'set_tag' then
        tname := left(btrim(coalesce(e->>'tag', '')), 40);
        if tname <> '' and c.lead_id is not null then perform outreach__ai_lead_tag(r.workspace_id, c.lead_id, tname); n := n + 1; end if;
      when 'opt_out' then
        if c.lead_id is not null then update outreach_leads set do_not_contact = true where id = c.lead_id; end if;
        update outreach_chats set archived = true where id = c.id; n := n + 1;
      else null;
    end case;
  end loop;
  return n;
end $$;

create or replace function outreach__ai_escalation_task(p_run uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; nm text; words text; tid uuid;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  select * into c from outreach_chats where id = r.chat_id;
  select full_name into nm from outreach_leads where id = c.lead_id;
  nm := coalesce(nm, c.attendee_name, 'a lead');
  select string_agg(coalesce(m.text, m.transcript, '[attachment]'), E'\n' order by m.sent_at) into words from outreach_messages m where m.id = any(r.inbound_message_ids);
  select id into tid from outreach_tasks where chat_id = c.id and kind = 'ai_escalation' and completed_at is null limit 1;
  if tid is null then
    insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, ai_draft, due_at, assigned_to, source)
    values (r.workspace_id, c.client_id, 'ai_escalation', c.lead_id, c.sender_id, c.id, left('AI handed over: ' || nm, 200),
            left(concat_ws(E'\n\n', 'Why: ' || array_to_string(r.escalation_reasons, ', '), 'They wrote:' || E'\n' || coalesce(words, '')), 4000),
            r.draft_text, now() + interval '2 hours', c.assigned_to, 'ai') returning id into tid;
  else
    update outreach_tasks set body = left(concat_ws(E'\n\n', 'Why: ' || array_to_string(r.escalation_reasons, ', '), 'They wrote:' || E'\n' || coalesce(words, '')), 4000),
           ai_draft = r.draft_text, due_at = least(due_at, now() + interval '2 hours') where id = tid;
  end if;
  return tid;
end $$;

-- ============================================================================= human sends → T1 (§2.2)
drop function if exists outreach__ai_takeover(uuid, text);
create or replace function outreach_ai_reply_on_human_send(p_chat uuid, p_message uuid, p_run uuid, p_edit_distance real, p_facts_changed boolean, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; origin_ text := 'inbox_user'; used boolean := false; txt text; c outreach_chats%rowtype; ho jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  select text into txt from outreach_messages where id = p_message;
  if p_run is not null then
    select * into r from outreach_ai_reply_runs where id = p_run and chat_id = p_chat and status in ('draft_ready','scheduled','escalated') and draft_text is not null for update;
    -- more than half rewritten = the teammate's own reply: no AI origin, no AI side effects, no credit
    if found and coalesce(p_edit_distance, 1) <= 0.5 then
      used := true;
      origin_ := case when coalesce(p_edit_distance, 1) <= 0.0001 then 'ai_draft_sent' else 'ai_edited' end;
      update outreach_ai_reply_runs set status = 'sent', sent_origin = origin_, sent_message_id = p_message, final_text = txt, edit_distance = p_edit_distance,
             facts_changed = p_facts_changed, dispatched_by = p_actor, timings = timings || jsonb_build_object('sent_at', now())
       where id = r.id;
      update outreach_chats set conversation_stage = coalesce(r.stage_after, conversation_stage), last_ai_move = coalesce(r.move, last_ai_move), stage_stale = false,
             ai_replies_count = ai_replies_count + 1
       where id = p_chat;
      perform outreach__ai_apply_side_effects(r.id);
    end if;
  end if;
  update outreach_messages set origin = origin_, ai_reply_run_id = case when used then p_run end where id = p_message;
  perform outreach__ai_bump_exchange(p_chat, p_message);
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover'
   where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled') and (not used or id is distinct from p_run);
  if used then
    -- the AI's reply went out with a person's approval: the Stop rules apply to it exactly as to an autopilot send
    -- (T3 is checked on the text that actually went out: an edit may have added or removed the link)
    if outreach__ai_has_scheduling_link(txt) then ho := outreach_ai_handoff(p_chat, 'calendar_sent', r.id, 'calendar link');
    elsif r.stop_after_send then ho := outreach_ai_handoff(p_chat, case when r.stop_rule = 'meeting confirmed' then 'meeting_confirmed' else 'stop_rule' end, r.id, r.stop_rule); end if;
  else
    -- T1: a person wrote their own message — the conversation is theirs from here
    update outreach_chats set stage_stale = true where id = p_chat;
    ho := outreach_ai_handoff(p_chat, 'human_replied', null, null);
  end if;
  return jsonb_build_object('origin', origin_, 'used_run', used, 'handoff', ho);
end $$;

create or replace function outreach_ai_reply_on_outbound_external(p_message uuid) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare m outreach_messages%rowtype; c outreach_chats%rowtype; a outreach_actions%rowtype; run_ outreach_ai_reply_runs%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into m from outreach_messages where id = p_message;
  if not found or m.direction <> 'out' or m.event_type is not null then return 'skipped'; end if;
  if m.action_id is not null or m.is_invite_note or m.origin not in ('unknown') then return 'ours'; end if;
  perform outreach__ai_chat_lock(m.chat_id);
  select * into c from outreach_chats where id = m.chat_id;
  -- 1. our AI send with the same text: in flight, recorded, or given up on after an ambiguous error (then it DID go out)
  select * into run_ from outreach_ai_reply_runs where chat_id = c.id and status in ('sending','sent','failed') and outreach__text_sha(final_text) = m.text_sha256
     and updated_at > m.sent_at - interval '30 minutes' order by updated_at desc limit 1;
  if run_.id is not null then
    update outreach_messages set origin = 'ai_autopilot', ai_reply_run_id = run_.id, action_id = coalesce(action_id, run_.action_id) where id = m.id;
    if run_.status = 'failed' then
      update outreach_ai_reply_runs set status = 'sent', sent_origin = 'ai_autopilot', sent_message_id = m.id, error = coalesce(error, '') || ' (delivered)',
             timings = timings || jsonb_build_object('sent_at', m.sent_at) where id = run_.id;
      update outreach_actions set status = 'sent', executed_at = m.sent_at where id = run_.action_id and status = 'failed';
      update outreach_chats set ai_replies_count = ai_replies_count + 1, conversation_stage = coalesce(run_.stage_after, conversation_stage),
             last_ai_move = coalesce(run_.move, last_ai_move), stage_stale = false where id = c.id;
      perform outreach__ai_bump_exchange(c.id, m.id);
      update outreach_tasks set completed_at = now(), result = jsonb_build_object('resolved', 'delivered')
       where chat_id = c.id and kind = 'ai_escalation' and completed_at is null;
      if run_.stop_after_send then perform outreach_ai_handoff(c.id, case when run_.stop_rule = 'calendar link' then 'calendar_sent' else 'stop_rule' end, run_.id, run_.stop_rule); end if;
    end if;
    return 'ours_ai';
  end if;
  -- 2. an action of ours for this sender + lead is in flight, or ran within ±120 s and has not recorded its message yet
  select * into a from outreach_actions x
   where x.sender_id = c.sender_id and x.lead_id is not distinct from c.lead_id
     and x.action_type in ('message','new_chat','inmail','invite','reply','ai_reply')
     and (x.status = 'reserved' or (x.status = 'sent' and x.executed_at between m.sent_at - interval '120 seconds' and m.sent_at + interval '120 seconds'))
     and not exists (select 1 from outreach_messages y where y.action_id = x.id and y.id <> m.id)
   order by (outreach__text_sha(x.payload->>'text') = m.text_sha256) desc nulls last, x.executed_at desc nulls first limit 1;
  if a.id is not null then
    if outreach__text_sha(a.payload->>'text') = m.text_sha256 then update outreach_messages set action_id = a.id where id = m.id; end if;
    return 'ours';
  end if;
  -- 3. the same text as one of our messages in this chat within ±120 s: a duplicate delivery
  if exists (select 1 from outreach_messages x where x.chat_id = c.id and x.id <> m.id and x.direction = 'out' and x.text_sha256 = m.text_sha256
              and x.sent_at between m.sent_at - interval '120 seconds' and m.sent_at + interval '120 seconds') then
    return 'duplicate';
  end if;
  -- 4. the sender typed it on their phone / LinkedIn web: T1
  update outreach_messages set origin = 'external_device' where id = m.id;
  perform outreach__ai_bump_exchange(c.id, m.id);
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover' where chat_id = c.id and status in ('debouncing','drafting','draft_ready','scheduled');
  update outreach_chats set stage_stale = true where id = c.id;
  perform outreach_ai_handoff(c.id, 'human_replied', null, null);
  perform outreach_emit_event(c.workspace_id, 'ai_reply.takeover', jsonb_build_object('chat_id', c.id, 'message_id', m.id, 'source', 'external_device'));
  return 'external_device';
end $$;

-- ============================================================================= dispatch: recheck + sent (§2.2 T3/T4, §4.3)
create or replace function outreach_ai_reply_prepare_send(p_run uuid, p_ignore_window boolean default false, p_country text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; s outreach_senders%rowtype; mp outreach_master_prompts%rowtype; eff jsonb; pol jsonb;
        newest timestamptz; later_ids uuid[]; last_dir text; day date; ai_today int; combined int; cap int; why text; aid uuid; txt text; nid uuid; supp text;
        l outreach_leads%rowtype; blocked text[]; hpos int; lpos int; tags text[];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then return jsonb_build_object('ok', false, 'to', null, 'why', 'not_found'); end if;
  perform outreach__ai_chat_lock(r.chat_id);
  select * into r from outreach_ai_reply_runs where id = p_run for update;
  if r.status <> 'sending' then return jsonb_build_object('ok', false, 'to', null, 'why', 'not_sending'); end if;
  select * into c from outreach_chats where id = r.chat_id for update;
  select * into s from outreach_senders where id = r.sender_id;
  -- 0. handed off meanwhile (a person wrote, a stop rule fired elsewhere): never send
  if c.ai_handed_off_at is not null then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'handed_off' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'handed_off');
  end if;
  -- 1. a newer message from them → redraft on everything unanswered
  select max(sent_at) into newest from outreach_messages where id = any(r.inbound_message_ids);
  select array_agg(m.id order by m.sent_at) into later_ids from outreach_messages m
   where m.chat_id = c.id and m.direction = 'in' and m.event_type is null and m.sent_at > newest and not (m.id = any(r.inbound_message_ids));
  if later_ids is not null or cardinality(r.followup_inbound_ids) > 0 then
    update outreach_ai_reply_runs set status = 'superseded', error = 'newer_inbound' where id = r.id;
    eff := outreach__ai_effective(c.id); pol := eff->'policy';
    if eff->>'mode' <> 'off' then
      nid := outreach__ai_open_run(c.id, r.inbound_message_ids || coalesce(later_ids, '{}') || r.followup_inbound_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', (r.timings->>'inbound_at')::timestamptz);
    end if;
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'newer_inbound', 'new_run', nid);
  end if;
  -- 8. age
  if r.created_at < now() - interval '24 hours' then
    update outreach_ai_reply_runs set status = 'expired', error = 'older_than_24h' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'expired', 'why', 'older_than_24h');
  end if;
  -- 2. a teammate answered meanwhile (a recorded send, or one of theirs still in flight)
  if exists (select 1 from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sent_at > r.created_at
               and m.origin in ('inbox_user','external_device','ai_draft_sent','ai_edited'))
     or exists (select 1 from outreach_actions a where a.sender_id = r.sender_id and a.lead_id is not distinct from c.lead_id
                  and a.action_type = 'reply' and a.status = 'reserved') then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'human_takeover');
  end if;
  select direction::text into last_dir from outreach_messages where chat_id = c.id and event_type is null and deleted_at is null order by sent_at desc limit 1;
  if last_dir is distinct from 'in' then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'not_our_turn' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'not_our_turn');
  end if;
  -- 3. answered messages deleted / edited
  if exists (select 1 from outreach_messages m where m.id = any(r.inbound_message_ids) and m.deleted_at is not null) then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'message_deleted' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'message_deleted');
  end if;
  if exists (select 1 from outreach_messages m where m.id = any(r.inbound_message_ids) and m.edited_at > r.created_at) then
    update outreach_ai_reply_runs set status = 'superseded', error = 'message_edited' where id = r.id;
    eff := outreach__ai_effective(c.id);
    nid := outreach__ai_open_run(c.id, r.inbound_message_ids, 30, 60, coalesce(eff->>'mode', 'draft'), (r.timings->>'inbound_at')::timestamptz);
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'message_edited', 'new_run', nid);
  end if;
  -- 4. still autopilot: sequence active, consent live, not paused / archived, lead not suppressed
  eff := outreach__ai_effective(c.id);
  if c.archived then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'archived' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'archived');
  end if;
  if c.lead_id is not null then
    select * into l from outreach_leads where id = c.lead_id;
    supp := outreach_lead_suppression_reason(l, c.client_id, r.sequence_id);
    if supp is not null then
      update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'suppressed:' || supp where id = r.id;
      return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'suppressed');
    end if;
  end if;
  if eff->>'mode' = 'off' then
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'mode_off' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'cancelled', 'why', 'mode_off');
  elsif eff->>'mode' = 'draft' then
    update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = array_append(gate_failures, coalesce(eff->>'reason_code', 'mode_draft')) where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', coalesce(eff->>'reason_code', 'mode_draft'));
  end if;
  pol := eff->'policy';
  -- G13 / G14 again: tags, hand-off stage and the disclosure rule may have changed during the hold
  if l.id is not null then
    select array_agg(lower(t.name::text)) into tags from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = l.id;
    select st.position into lpos from outreach_stages st where st.id = l.stage_id;
    if coalesce(eff->'settings'->>'handoff_stage_id', '') <> '' then
      select st.position into hpos from outreach_stages st where st.id = (eff->'settings'->>'handoff_stage_id')::uuid;
    end if;
    if tags && array['vip','manual_only','manual-only'] or (hpos is not null and lpos is not null and lpos >= hpos) then
      update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'G13'::text where id = r.id;
      return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', 'G13');
    end if;
  end if;
  if nullif(btrim(coalesce(pol->>'disclosure', '')), '') is null then
    select coalesce(array_agg(x), '{}') into blocked from jsonb_array_elements_text(coalesce(pol->'blocked_countries', '[]'::jsonb)) x;
    if cardinality(blocked) > 0 and (p_country is null or upper(p_country) = any(blocked)) then
      update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'G14'::text where id = r.id;
      return jsonb_build_object('ok', false, 'to', 'draft_ready', 'why', 'G14');
    end if;
  end if;
  -- 5. prompt changed substantively since drafting → redraft on the new version
  select * into mp from outreach_master_prompts where id = (eff->'master_prompt'->>'id')::uuid;
  if mp.id is distinct from r.master_prompt_id or mp.substantive_version > coalesce(r.master_prompt_version, 0) then
    update outreach_ai_reply_runs set status = 'superseded', error = 'master_prompt_changed' where id = r.id;
    nid := outreach__ai_open_run(c.id, r.inbound_message_ids, 30, 60, 'autopilot', (r.timings->>'inbound_at')::timestamptz);
    return jsonb_build_object('ok', false, 'to', 'superseded', 'why', 'master_prompt_changed', 'new_run', nid);
  end if;
  -- 6. sender healthy and inside its working hours
  if s.status <> 'ok' or s.deleted_at is not null or (s.paused_until is not null and s.paused_until > now()) then
    update outreach_ai_reply_runs set status = 'scheduled', scheduled_send_at = now() + interval '30 minutes', error = 'sender_not_ok' where id = r.id;
    return jsonb_build_object('ok', false, 'to', 'scheduled', 'why', 'sender_not_ok');
  end if;
  if not p_ignore_window and not outreach_in_schedule(s.id, now()) then
    return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'why', 'outside_window');
  end if;
  -- 7. caps: AI sends / day (sends in flight count), message + reply + ai_reply ≤ 100 / day, then the ledger
  day := outreach_sender_local_date(s.id, now());
  select count(*) filter (where a.action_type = 'ai_reply'), count(*) into ai_today, combined from outreach_actions a
   where a.sender_id = s.id and a.action_type in ('message','new_chat','inmail','reply','ai_reply')
     and ((a.status = 'sent' and a.executed_at >= now() - interval '36 hours' and outreach_sender_local_date(s.id, a.executed_at) = day)
          or (a.status = 'reserved' and a.action_type = 'ai_reply'));
  cap := least(40, coalesce((pol->>'max_ai_sends_per_sender_day')::int, 25));
  if ai_today >= cap then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', true, 'why', 'daily_ai_cap'); end if;
  if combined >= 100 then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', true, 'why', 'combined_cap'); end if;
  why := outreach__reserve_why(s.id, day, 'ai_reply', now());
  if why <> 'ok' then return jsonb_build_object('ok', false, 'to', null, 'reschedule', true, 'next_day', why = 'day', 'why', 'ledger_' || why); end if;
  txt := r.draft_text || case when nullif(btrim(coalesce(pol->>'disclosure', '')), '') is not null then E'\n\n' || btrim(pol->>'disclosure') else '' end;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, reserved_at, idempotency_key, payload)
  values (r.workspace_id, s.id, c.lead_id, 'ai_reply', now(), 'reserved', now(), 'ai_reply:' || r.id::text || ':' || r.send_attempts::text || ':' || extract(epoch from now())::bigint,
          jsonb_build_object('text', txt, 'run_id', r.id, 'by', r.dispatched_by))
  returning id into aid;
  update outreach_ai_reply_runs set action_id = aid, final_text = txt where id = r.id;
  return jsonb_build_object('ok', true, 'action_id', aid, 'text', txt, 'day', day);
end $$;

create or replace function outreach_ai_reply_mark_sent(p_run uuid, p_message uuid, p_unipile_message_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; a outreach_actions%rowtype; eff jsonb; pol jsonb; nid uuid; ho jsonb; wl int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock((select chat_id from outreach_ai_reply_runs where id = p_run));
  select * into r from outreach_ai_reply_runs where id = p_run for update;
  if not found or r.status <> 'sending' then return jsonb_build_object('ok', false, 'why', 'not_sending'); end if;
  select * into a from outreach_actions where id = r.action_id;
  if a.id is not null then
    perform outreach_consume_budget(a.sender_id, outreach_sender_local_date(a.sender_id, a.reserved_at), 'ai_reply', a.reserved_at);
    update outreach_actions set status = 'sent', executed_at = now(), response = jsonb_build_object('message_id', p_unipile_message_id, 'run_id', r.id) where id = a.id;
  end if;
  update outreach_ai_reply_runs set status = 'sent', sent_origin = 'ai_autopilot', sent_message_id = p_message, timings = timings || jsonb_build_object('sent_at', now())
   where id = r.id;
  if p_message is not null then update outreach_messages set origin = 'ai_autopilot', ai_reply_run_id = r.id, action_id = coalesce(action_id, r.action_id) where id = p_message; end if;
  update outreach_chats set ai_replies_count = ai_replies_count + 1, conversation_stage = coalesce(r.stage_after, conversation_stage),
         last_ai_move = coalesce(r.move, last_ai_move), stage_stale = false where id = r.chat_id;
  if p_message is not null then perform outreach__ai_bump_exchange(r.chat_id, p_message); end if;
  perform outreach__ai_apply_side_effects(r.id);
  -- warm-up: one fewer held reply (§4.3)
  if r.sequence_id is not null then
    update outreach_sequence_reply_settings set warmup_remaining = greatest(0, warmup_remaining - 1) where sequence_id = r.sequence_id and warmup_remaining > 0 returning warmup_remaining into wl;
  end if;
  perform outreach_emit_event(r.workspace_id, 'ai_reply.sent', jsonb_build_object('run_id', r.id, 'chat_id', r.chat_id, 'lead_id', r.lead_id, 'sender_id', r.sender_id, 'message_id', p_message, 'stage_after', r.stage_after, 'stop_after_send', r.stop_after_send));
  -- T3 / T4 / T2: this reply ends the AI conversation
  if r.stop_after_send then
    ho := outreach_ai_handoff(r.chat_id, case when r.stop_rule = 'calendar link' then 'calendar_sent' when r.stop_rule = 'meeting confirmed' then 'meeting_confirmed' else 'stop_rule' end, r.id, r.stop_rule);
    -- messages that arrived while sending are theirs now (the handoff task already exists); no new run
    return jsonb_build_object('ok', true, 'handoff', ho, 'warmup_remaining', wl);
  end if;
  if cardinality(r.followup_inbound_ids) > 0 then
    eff := outreach__ai_effective(r.chat_id); pol := eff->'policy';
    if eff->>'mode' <> 'off' then
      nid := outreach__ai_open_run(r.chat_id, r.followup_inbound_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', null);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'followup_run', nid, 'warmup_remaining', wl);
end $$;

-- ============================================================================= maintenance
create or replace function outreach_ai_reply_expire() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n_exp int := 0; n_stuck int; n_fail int; n_send int := 0; r record;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in select id from outreach_ai_reply_runs where status = 'scheduled' and created_at < now() - interval '24 hours' loop
    update outreach_ai_reply_runs set status = 'expired', error = 'older_than_24h' where id = r.id and status = 'scheduled';
    perform outreach__ai_open_followups(r.id);
    n_exp := n_exp + 1;
  end loop;
  update outreach_ai_reply_runs set status = 'debouncing', next_attempt_at = now() + interval '1 minute'
   where status = 'drafting' and updated_at < now() - interval '5 minutes' and attempts < 3 and trigger_kind = 'auto';
  get diagnostics n_stuck = row_count;
  update outreach_ai_reply_runs set status = 'failed', error = 'stuck_drafting' where status = 'drafting' and updated_at < now() - interval '5 minutes';
  get diagnostics n_fail = row_count;
  for r in select id, action_id from outreach_ai_reply_runs where status = 'sending' and updated_at < now() - interval '10 minutes' loop
    update outreach_actions a set status = 'failed', error_code = 'stuck_sending', executed_at = now() where a.id = r.action_id and a.status = 'reserved';
    if found then
      perform outreach_release_budget(a.sender_id, outreach_sender_local_date(a.sender_id, a.reserved_at), 'ai_reply', a.reserved_at) from outreach_actions a where a.id = r.action_id;
    end if;
    update outreach_ai_reply_runs set status = 'failed', error = 'stuck_sending' where id = r.id;
    perform outreach__ai_escalation_task(r.id);
    perform outreach__ai_open_followups(r.id);
    n_send := n_send + 1;
  end loop;
  update outreach_ai_reply_consent_links set cancelled_at = now() where used_at is null and cancelled_at is null and expires_at < now() - interval '30 days';
  delete from outreach_ai_lead_notes_queue where attempts >= 3 and next_attempt_at < now() - interval '1 day';
  return jsonb_build_object('expired', n_exp, 'retried', n_stuck, 'failed', n_fail, 'stuck_sending', n_send);
end $$;

-- gone quiet → a task for a person (§9.6), once per silence
create or replace function outreach_ai_reply_inactivity() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; n int := 0; nm text; stage_lbl text; st jsonb; pos int; lbl text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in
    select c.*, s.inactivity_days, s.master_prompt_id, q.created_by as seq_owner, q.name as seq_name,
           (select max(m.sent_at) from outreach_messages m where m.chat_id = c.id and m.event_type is null and m.deleted_at is null) last_at,
           (select m.direction::text from outreach_messages m where m.chat_id = c.id and m.event_type is null and m.deleted_at is null order by m.sent_at desc limit 1) last_dir
      from outreach_chats c
      join outreach_sequence_reply_settings s on s.sequence_id = c.reply_sequence_id
      join outreach_sequences q on q.id = s.sequence_id
     where c.provider = 'LINKEDIN' and c.ai_handed_off_at is null and not c.archived and s.inactivity_days is not null and s.mode <> 'off' and q.status = 'active'
       and c.ai_quiet_task_at is null
       and exists (select 1 from outreach_ai_reply_runs x where x.chat_id = c.id and x.status = 'sent')
  loop
    if r.last_dir <> 'out' or r.last_at is null or r.last_at > now() - make_interval(days => r.inactivity_days) then continue; end if;
    select coalesce(l.full_name, r.attendee_name, 'The lead') into nm from outreach_leads l where l.id = r.lead_id;
    nm := coalesce(nm, r.attendee_name, 'The lead');
    lbl := null;
    if r.conversation_stage is not null then
      select mp.settings->'stages' into st from outreach_master_prompts mp where mp.id = r.master_prompt_id;
      select o.i::int, o.x->>'label' into pos, lbl from jsonb_array_elements(coalesce(st, outreach__mp_default_settings()->'stages')) with ordinality o(x, i) where o.x->>'key' = r.conversation_stage;
    end if;
    stage_lbl := case when lbl is not null then 'Stage ' || pos || ' · ' || lbl when r.ai_session_kind = 'dormant' then 'Re-engage' else 'the first replies' end;
    insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, due_at, assigned_to, source)
    values (r.workspace_id, r.client_id, 'follow_up', r.lead_id, r.sender_id, r.id, left(nm || ' went quiet after ' || stage_lbl || ' · ' || r.inactivity_days || ' days', 200),
            'No reply for ' || r.inactivity_days || ' days after our last message in ' || coalesce(r.seq_name, 'the sequence') || '. The AI does not nudge; a short personal note from you works best.',
            now(), coalesce(r.assigned_to, r.seq_owner), 'system');
    update outreach_chats set ai_quiet_task_at = now() where id = r.id;
    n := n + 1;
  end loop;
  return jsonb_build_object('tasks', n);
end $$;

-- ============================================================================= breakers (§4.3, per sequence)
create or replace function outreach__ai_downgrade(p_ws uuid, p_sequence uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_sequence_reply_settings set mode = 'draft', downgraded_at = now(), downgrade_reason = p_reason, updated_at = now() where sequence_id = p_sequence;
  perform outreach_ai_reply_demote_scheduled(p_sequence, 'downgraded');
  perform outreach_audit(p_ws, 'ai_reply.downgraded', 'sequence', p_sequence::text, jsonb_build_object('reason', p_reason), 'system');
end $$;

create or replace function outreach_ai_reply_breakers() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q record; out_ jsonb := '[]'::jsonb; n int; bad int; minn int; thr numeric; reset_at timestamptz; mp outreach_master_prompts%rowtype; reasons jsonb; sent int; botq int; aid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for q in select s.workspace_id, s.sequence_id, s.master_prompt_id, s.breaker_reset_at, s.downgraded_at, s.mode from outreach_sequence_reply_settings s
            where exists (select 1 from outreach_ai_reply_runs r where r.sequence_id = s.sequence_id and r.timings ? 'scheduled_at' and r.created_at > now() - interval '30 days') loop
    if q.downgraded_at is not null and q.downgraded_at > now() - interval '30 days' and q.mode <> 'autopilot' then continue; end if;
    select * into mp from outreach_master_prompts where id = q.master_prompt_id;
    reset_at := coalesce(q.breaker_reset_at, '-infinity'::timestamptz);
    select count(*), count(*) filter (where x.sent_origin = 'ai_edited' or (x.status = 'cancelled' and x.cancelled_by is not null)) into n, bad from (
      select r.* from outreach_ai_reply_runs r
       where r.sequence_id = q.sequence_id and r.timings ? 'scheduled_at' and r.status in ('sent','cancelled') and r.created_at > reset_at
         and (r.status <> 'cancelled' or r.cancelled_by is not null) and coalesce(r.cancel_reason, '') <> 'taken_manual'
         and (mp.id is null or mp.version = 1 or r.created_at >= mp.substantive_at
              or (select count(*) from outreach_ai_reply_runs z where z.sequence_id = q.sequence_id and z.timings ? 'scheduled_at' and z.created_at >= mp.substantive_at) >= 20)
       order by r.created_at desc limit 20) x;
    thr := case when mp.id is not null and mp.version > 1 and (select count(*) from outreach_ai_reply_runs z where z.sequence_id = q.sequence_id and z.timings ? 'scheduled_at' and z.created_at >= mp.substantive_at) < 20 then 0.15 else 0.25 end;
    minn := case when thr = 0.15 then 5 else 10 end;
    if n >= minn and bad::numeric / n >= thr then
      select coalesce(jsonb_agg(jsonb_build_object('reason', k.cancel_reason, 'rule', k.rule_applied, 'n', k.n)), '[]'::jsonb) into reasons from (
        select coalesce(r.cancel_reason, 'edited') cancel_reason, r.rule_applied, count(*) n from outreach_ai_reply_runs r
         where r.sequence_id = q.sequence_id and r.timings ? 'scheduled_at' and (r.sent_origin = 'ai_edited' or (r.status = 'cancelled' and r.cancelled_by is not null))
           and r.created_at > now() - interval '30 days' group by 1, 2 order by 3 desc limit 10) k;
      perform outreach__ai_downgrade(q.workspace_id, q.sequence_id, format('%s of the last %s auto replies were cancelled or edited', bad, n));
      out_ := out_ || jsonb_build_object('kind', 'downgrade_cancels', 'workspace_id', q.workspace_id, 'sequence_id', q.sequence_id, 'n', n, 'bad', bad, 'threshold', thr, 'reasons', reasons);
      continue;
    end if;
    select count(*) filter (where r.sent_origin = 'ai_autopilot'), count(*) filter (where r.sent_origin = 'ai_autopilot' and r.drew_bot_question) into sent, botq
      from outreach_ai_reply_runs r where r.sequence_id = q.sequence_id and r.status = 'sent' and r.created_at > greatest(now() - interval '30 days', reset_at);
    if sent > 0 and botq > 0 and botq::numeric / sent > 0.02 then
      perform outreach__ai_downgrade(q.workspace_id, q.sequence_id, format('%s of %s AI replies drew an "are you a bot?" answer', botq, sent));
      out_ := out_ || jsonb_build_object('kind', 'downgrade_bot_questions', 'workspace_id', q.workspace_id, 'sequence_id', q.sequence_id, 'sent', sent, 'bot_questions', botq);
    end if;
  end loop;
  for q in select r.workspace_id, r.master_prompt_id, count(*) n, array_agg(r.id) ids from outreach_ai_reply_runs r
            where r.cancel_reason = 'too_early_to_pitch' and r.updated_at > now() - interval '7 days' and r.master_prompt_id is not null
            group by 1, 2 having count(*) >= 3 loop
    insert into outreach_alerts(workspace_id, kind, entity, entity_id, label, reason, detail)
    values (q.workspace_id, 'ai_reply_too_early', 'master_prompt', q.master_prompt_id, 'Master prompt', format('%s replies were cancelled as "too early to pitch" this week', q.n),
            jsonb_build_object('run_ids', to_jsonb(q.ids)))
    on conflict (kind, entity_id) where resolved_at is null do nothing
    returning id into aid;
    if aid is not null then
      out_ := out_ || jsonb_build_object('kind', 'too_early_to_pitch', 'workspace_id', q.workspace_id, 'master_prompt_id', q.master_prompt_id, 'n', q.n, 'run_ids', to_jsonb(q.ids), 'alert_id', aid);
    end if;
    aid := null;
  end loop;
  update outreach_alerts set resolved_at = now() where kind = 'ai_reply_too_early' and resolved_at is null and opened_at < now() - interval '7 days';
  return out_;
end $$;

-- digests: downgrades now live on the sequence settings
create or replace function outreach_ai_reply_digest_data(p_kind text, p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_kind = 'owner' then
    return coalesce((select jsonb_agg(jsonb_build_object('sender_id', s.id, 'workspace_id', s.workspace_id, 'sender_name', s.display_name, 'owner_email', s.owner_email,
      'sequences', (select jsonb_agg(distinct q.name) from outreach_ai_reply_runs r join outreach_sequences q on q.id = r.sequence_id where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since),
      'items', (select jsonb_agg(jsonb_build_object('chat_id', r.chat_id, 'lead', coalesce(l.full_name, c.attendee_name), 'text', r.final_text, 'sent_at', r.timings->>'sent_at') order by r.updated_at)
                  from outreach_ai_reply_runs r join outreach_chats c on c.id = r.chat_id left join outreach_leads l on l.id = c.lead_id
                 where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)))
      from outreach_senders s
     where s.owner_email is not null and s.deleted_at is null
       and exists (select 1 from outreach_ai_reply_runs r where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('workspace_id', w.workspace_id,
      'sent_ai', w.sent_ai, 'sent_draft', w.sent_draft, 'escalated', w.escalated, 'cancelled', w.cancelled, 'no_reply', w.no_reply, 'handed_off', w.handed_off,
      'reasons', (select jsonb_agg(jsonb_build_object('reason', k.reason, 'n', k.n)) from (
                    select coalesce(r.cancel_reason, r.escalation_reasons[1]) reason, count(*) n from outreach_ai_reply_runs r
                     where r.workspace_id = w.workspace_id and r.updated_at >= p_since and r.status in ('cancelled','escalated')
                       and coalesce(r.cancel_reason, '') not in ('human_takeover','superseded','taken_manual','handed_off') group by 1 order by 2 desc limit 8) k),
      'downgrades', (select jsonb_agg(jsonb_build_object('sequence_id', p.sequence_id, 'reason', p.downgrade_reason)) from outreach_sequence_reply_settings p
                      where p.workspace_id = w.workspace_id and p.downgraded_at >= p_since)))
    from (select r.workspace_id,
                 count(*) filter (where r.status = 'sent' and r.sent_origin = 'ai_autopilot') sent_ai,
                 count(*) filter (where r.status = 'sent' and r.sent_origin in ('ai_draft_sent','ai_edited')) sent_draft,
                 count(*) filter (where r.status = 'escalated') escalated,
                 count(*) filter (where r.status = 'cancelled' and r.cancelled_by is not null) cancelled,
                 count(*) filter (where r.status = 'no_reply') no_reply,
                 (select count(*) from outreach_chats c where c.workspace_id = r.workspace_id and c.ai_handed_off_at >= p_since) handed_off
            from outreach_ai_reply_runs r where r.updated_at >= p_since group by r.workspace_id) w
   where w.sent_ai + w.escalated + w.cancelled + w.handed_off > 0), '[]'::jsonb);
end $$;

-- ============================================================================= consent links (per sender)
drop function if exists outreach_ai_consent_link_create(uuid, uuid, uuid, text, jsonb, jsonb);
create or replace function outreach_ai_consent_link_create(p_sender uuid, p_by uuid, p_email text, p_scope jsonb, p_examples jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; tok text; lid uuid; exp timestamptz := now() + interval '7 days';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if s.id is null then raise exception 'E_NOT_FOUND'; end if;
  update outreach_ai_reply_consent_links set cancelled_at = now() where sender_id = p_sender and used_at is null and cancelled_at is null;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_ai_reply_consent_links(workspace_id, sender_id, email, token_hash, scope, examples, created_by, expires_at)
  values (s.workspace_id, s.id, lower(nullif(btrim(coalesce(p_email, '')), '')), encode(digest(tok, 'sha256'), 'hex'), coalesce(p_scope, '{}'::jsonb), coalesce(p_examples, '[]'::jsonb), p_by, exp)
  returning id into lid;
  perform outreach_audit(s.workspace_id, 'ai_reply.consent_requested', 'sender', s.id::text, jsonb_build_object('link_id', lid, 'email', p_email, 'by', p_by), 'user');
  return jsonb_build_object('id', lid, 'token', tok, 'expires_at', exp);
end $$;

create or replace function outreach_ai_consent_link_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent_links%rowtype; s outreach_senders%rowtype; st text; wsname text; br jsonb; seqs jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_ai_reply_consent_links where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into s from outreach_senders where id = k.sender_id;
  select name, branding into wsname, br from outreach_workspaces where id = k.workspace_id;
  st := case when k.used_at is not null then 'accepted' when k.cancelled_at is not null then 'cancelled' when k.expires_at < now() then 'expired' else 'pending' end;
  -- the sequences this account would answer for on Auto right now (informational; consent covers the sender)
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'mode', r.mode) order by q.name), '[]'::jsonb) into seqs
    from outreach_sequence_reply_settings r join outreach_sequences q on q.id = r.sequence_id
   where r.workspace_id = k.workspace_id and r.mode = 'autopilot' and q.status <> 'archived' and (q.sender_pool @> array[k.sender_id] or q.sender_pools::text like '%' || k.sender_id::text || '%');
  return jsonb_build_object('status', st, 'workspace_id', k.workspace_id, 'workspace_name', wsname, 'branding', coalesce(br, '{}'::jsonb), 'sender_name', s.display_name,
    'email', k.email, 'sequences', seqs, 'scope', k.scope, 'examples', k.examples, 'expires_at', k.expires_at, 'consent_months', 12,
    'grant_text', 'AI may reply as me in the sequences my team turns on.');
end $$;

create or replace function outreach_ai_consent_link_accept(p_token text, p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent_links%rowtype; s outreach_senders%rowtype; rtok text; cid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_ai_reply_consent_links where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if not found then raise exception 'E_NOT_FOUND: this link is not valid'; end if;
  if k.used_at is not null then raise exception 'E_CONFLICT: consent was already given with this link'; end if;
  if k.cancelled_at is not null or k.expires_at < now() then raise exception 'E_EXPIRED: this link has expired, ask for a new one'; end if;
  select * into s from outreach_senders where id = k.sender_id;
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'replaced' where sender_id = k.sender_id and revoked_at is null;
  rtok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_ai_reply_consent(workspace_id, sender_id, granted_by_email, granted_via, scope, evidence, granted_at, expires_at, revoke_token_hash)
  values (k.workspace_id, k.sender_id, coalesce(k.email, s.owner_email, 'unknown@unknown'), 'signed_link', k.scope,
          coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('token_id', k.id, 'at', now()), now(), now() + interval '12 months', encode(digest(rtok, 'sha256'), 'hex'))
  returning id into cid;
  update outreach_ai_reply_consent_links set used_at = now() where id = k.id;
  perform outreach_audit(k.workspace_id, 'ai_reply.consent_granted', 'sender', k.sender_id::text, jsonb_build_object('consent_id', cid, 'via', 'signed_link') || coalesce(p_evidence, '{}'::jsonb), 'system');
  return jsonb_build_object('consent_id', cid, 'revoke_token', rtok, 'workspace_id', k.workspace_id, 'sender_id', k.sender_id, 'email', coalesce(k.email, s.owner_email));
end $$;

create or replace function outreach__ai_consent_revoke(p_consent uuid, p_reason text, p_actor text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent%rowtype;
begin
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = left(coalesce(p_reason, 'revoked'), 200) where id = p_consent and revoked_at is null returning * into k;
  if k.id is null then return; end if;
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'consent_revoked'::text
   where sender_id = k.sender_id and status = 'scheduled';
  perform outreach_audit(k.workspace_id, 'ai_reply.consent_revoked', 'sender', k.sender_id::text, jsonb_build_object('consent_id', k.id, 'reason', p_reason, 'by', p_actor), 'user');
end $$;

-- ============================================================================= lead notes (§9.4)
create or replace function outreach_ai_lead_notes_claim(p_limit int default 10) returns setof outreach_ai_lead_notes_queue
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    update outreach_ai_lead_notes_queue q set attempts = attempts + 1, next_attempt_at = now() + interval '5 minutes'
     where q.id in (select id from outreach_ai_lead_notes_queue where next_attempt_at <= now() and attempts < 3 order by created_at limit greatest(1, least(p_limit, 50)) for update skip locked)
    returning q.*;
end $$;

create or replace function outreach_ai_lead_notes_done(p_id uuid) returns void
language sql security definer set search_path = public, extensions as $$ delete from outreach_ai_lead_notes_queue where id = p_id $$;

-- the model's add / update / remove operations; items a person edited are locked (the AI may add, never change them)
create or replace function outreach_ai_lead_notes_apply(p_lead uuid, p_ops jsonb, p_summary text, p_source_message uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n outreach_lead_ai_notes%rowtype; its jsonb; op jsonb; it jsonb; i int; found_ boolean; ws uuid; applied int := 0; key_ text;
  keys text[] := array['budget','timeline','current_solution','pain','objection','decision_maker','interest','other'];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then return jsonb_build_object('ok', false, 'why', 'no_lead'); end if;
  insert into outreach_lead_ai_notes(lead_id, workspace_id) values (p_lead, ws) on conflict (lead_id) do nothing;
  select * into n from outreach_lead_ai_notes where lead_id = p_lead for update;
  its := coalesce(n.items, '[]'::jsonb);
  for op in select x from jsonb_array_elements(coalesce(p_ops, '[]'::jsonb)) x limit 20 loop
    key_ := case when (op->>'key') = any(keys) then op->>'key' else 'other' end;
    if op->>'op' = 'add' and nullif(btrim(coalesce(op->>'text', '')), '') is not null and jsonb_array_length(its) < 20 then
      its := its || jsonb_build_object('id', gen_random_uuid(), 'key', key_, 'text', left(btrim(op->>'text'), 300), 'source_message_id', case when op->>'source_message_id' ~ '^[0-9a-fA-F-]{36}$' then (op->>'source_message_id')::uuid else p_source_message end,
                                           'updated_at', now(), 'edited_by', null, 'locked', false, 'history', '[]'::jsonb);
      applied := applied + 1;
    elsif op->>'op' in ('update', 'remove') then
      for i in 0 .. jsonb_array_length(its) - 1 loop
        it := its->i;
        if it->>'id' = op->>'id' and not coalesce((it->>'locked')::boolean, false) then
          if op->>'op' = 'remove' then
            its := its - i;
          else
            its := jsonb_set(its, array[i::text], it || jsonb_build_object('text', left(btrim(coalesce(op->>'text', it->>'text')), 300), 'key', key_, 'updated_at', now(),
                       'source_message_id', case when op->>'source_message_id' ~ '^[0-9a-fA-F-]{36}$' then (op->>'source_message_id')::uuid else p_source_message end,
                       'history', (coalesce(it->'history', '[]'::jsonb) || jsonb_build_object('text', it->>'text', 'at', it->>'updated_at'))));
          end if;
          applied := applied + 1;
          exit;
        end if;
      end loop;
    end if;
  end loop;
  update outreach_lead_ai_notes set items = its, summary = coalesce(left(nullif(btrim(p_summary), ''), 400), summary), updated_at = now() where lead_id = p_lead;
  return jsonb_build_object('ok', true, 'applied', applied, 'items', jsonb_array_length(its));
end $$;

-- ============================================================================= unanswered questions (§9.3)
create or replace function outreach__uq_norm(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select nullif(btrim(regexp_replace(lower(coalesce(t, '')), '[^a-z0-9\s]+', ' ', 'g')), '')
$$;

-- one question the AI could not answer → its group (new or existing, trigram ≥ 0.6 within the sequence)
create or replace function outreach_ai_unanswered_add(p_run uuid, p_canonical text, p_text text, p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; g outreach_ai_unanswered_questions%rowtype; nrm text; ex jsonb; mpid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if r.id is null or r.sequence_id is null then return jsonb_build_object('ok', false, 'why', 'no_sequence'); end if;
  nrm := outreach__uq_norm(coalesce(nullif(p_canonical, ''), p_text));
  if nrm is null or length(nrm) < 4 then return jsonb_build_object('ok', false, 'why', 'empty'); end if;
  select master_prompt_id into mpid from outreach_sequence_reply_settings where sequence_id = r.sequence_id;
  ex := jsonb_build_object('run_id', r.id, 'chat_id', r.chat_id, 'message_id', p_message, 'text', left(coalesce(p_text, p_canonical), 500), 'at', now());
  select * into g from outreach_ai_unanswered_questions where sequence_id = r.sequence_id and (norm = nrm or similarity(norm, nrm) >= 0.6)
   order by (norm = nrm) desc, similarity(norm, nrm) desc limit 1 for update;
  if g.id is null then
    insert into outreach_ai_unanswered_questions(workspace_id, sequence_id, master_prompt_id, canonical, norm, examples, seen_at)
    values (r.workspace_id, r.sequence_id, mpid, left(coalesce(nullif(p_canonical, ''), p_text), 300), nrm, jsonb_build_array(ex), array[now()]) returning * into g;
    return jsonb_build_object('ok', true, 'group_id', g.id, 'created', true);
  end if;
  update outreach_ai_unanswered_questions set count_total = count_total + 1, last_seen_at = now(), seen_at = (seen_at || now())[greatest(1, cardinality(seen_at) - 200):],
         examples = case when jsonb_array_length(examples) >= 10 then (examples - 0) || ex else examples || ex end,
         -- an answered group that recurs reopens (the Q&A did not cover it)
         status = case when status = 'answered' then 'open' else status end, master_prompt_id = coalesce(master_prompt_id, mpid)
   where id = g.id;
  return jsonb_build_object('ok', true, 'group_id', g.id, 'created', false, 'reopened', g.status = 'answered');
end $$;

-- nightly: merge near-duplicate groups inside a sequence
create or replace function outreach_ai_unanswered_merge() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare a record; b record; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for a in select * from outreach_ai_unanswered_questions where status = 'open' order by count_total desc, first_seen_at loop
    if not exists (select 1 from outreach_ai_unanswered_questions where id = a.id) then continue; end if;
    for b in select * from outreach_ai_unanswered_questions where sequence_id = a.sequence_id and id <> a.id and status = 'open' and similarity(norm, a.norm) >= 0.6 loop
      update outreach_ai_unanswered_questions set count_total = count_total + b.count_total, last_seen_at = greatest(last_seen_at, b.last_seen_at), first_seen_at = least(first_seen_at, b.first_seen_at),
             seen_at = (seen_at || b.seen_at)[greatest(1, cardinality(seen_at || b.seen_at) - 200):],
             examples = (select coalesce(jsonb_agg(x), '[]'::jsonb) from (select x from jsonb_array_elements(examples || b.examples) x order by x->>'at' desc limit 10) t)
       where id = a.id;
      delete from outreach_ai_unanswered_questions where id = b.id;
      n := n + 1;
    end loop;
  end loop;
  return n;
end $$;

-- ============================================================================= knowledge worker SQL
create or replace function outreach_knowledge_claim(p_limit int default 3) returns setof outreach_knowledge_sources
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    update outreach_knowledge_sources s set status = 'crawling', updated_at = now()
     where s.id in (select id from outreach_knowledge_sources
                     where status = 'pending' or (status = 'crawling' and updated_at < now() - interval '20 minutes')
                        or (status = 'ready' and refresh_days is not null and crawled_at < now() - make_interval(days => refresh_days))
                     order by updated_at limit greatest(1, least(p_limit, 10)) for update skip locked)
    returning s.*;
end $$;

create or replace function outreach_knowledge_store(p_source uuid, p_chunks jsonb, p_pages int, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; n int := 0; ch jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_knowledge_sources where id = p_source for update;
  if not found then return jsonb_build_object('ok', false); end if;
  if p_error is not null then
    update outreach_knowledge_sources set status = 'error', error = left(p_error, 500), updated_at = now() where id = p_source;
    return jsonb_build_object('ok', true, 'status', 'error');
  end if;
  delete from outreach_knowledge_chunks where source_id = p_source;
  for ch in select x from jsonb_array_elements(coalesce(p_chunks, '[]'::jsonb)) x limit 2000 loop
    n := n + 1;
    insert into outreach_knowledge_chunks(source_id, workspace_id, seq, url, heading, text) values (p_source, s.workspace_id, n, left(ch->>'url', 1000), left(ch->>'heading', 200), left(ch->>'text', 4000));
  end loop;
  update outreach_knowledge_sources set status = 'ready', error = null, pages = coalesce(p_pages, 0), chunks = n, crawled_at = now(), updated_at = now() where id = p_source;
  return jsonb_build_object('ok', true, 'status', 'ready', 'chunks', n);
end $$;

-- ============================================================================= grants (engine = service only)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and p.proname in ('outreach_ai_seq_settings_ensure','outreach__ai_consent_valid','outreach__ai_resolve_sequence','outreach__ai_effective','outreach__ai_reason_text',
                                'outreach__ai_lead_tag','outreach_ai_handoff','outreach_ai_resume_chat','outreach_ai_reply_demote_scheduled','outreach_ai_reply_on_sequence_status',
                                'outreach__ai_has_scheduling_link','outreach__ai_open_run','outreach__ai_tasks_on_reply','outreach_ai_reply_enqueue','outreach_ai_reply_manual_open',
                                'outreach_ai_reply_take_manual','outreach_ai_reply_gate_facts','outreach_knowledge_search','outreach__ai_faqs_for','outreach__ai_run_json',
                                'outreach__ai_run_apply','outreach_ai_reply_finalize','outreach__ai_apply_side_effects','outreach__ai_escalation_task','outreach_ai_reply_on_human_send',
                                'outreach_ai_reply_on_outbound_external','outreach_ai_reply_prepare_send','outreach_ai_reply_mark_sent','outreach_ai_reply_expire','outreach_ai_reply_inactivity',
                                'outreach__ai_downgrade','outreach_ai_reply_breakers','outreach_ai_reply_digest_data','outreach_ai_consent_link_create','outreach_ai_consent_link_view',
                                'outreach_ai_consent_link_accept','outreach__ai_consent_revoke','outreach_ai_lead_notes_claim','outreach_ai_lead_notes_done','outreach_ai_lead_notes_apply',
                                'outreach__uq_norm','outreach_ai_unanswered_add','outreach_ai_unanswered_merge','outreach_knowledge_claim','outreach_knowledge_store',
                                'outreach__compile_master_prompt','outreach__mp_default_stop','outreach__mp_default_gap_block','outreach__mp_default_sections','outreach__mp_default_scenarios',
                                'outreach_master_prompt_template') loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
  -- the template + compiler are read by the app (the sequence card's "Reset to template", the editor preview)
  for f in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('outreach_master_prompt_template','outreach__compile_master_prompt','outreach__mp_default_scenarios') loop
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
