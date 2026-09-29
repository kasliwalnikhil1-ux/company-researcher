-- 036 — AI replies: engine functions (ai-auto-reply-PRD.md §5–§10, §16; docs/outreach/AI-REPLIES-CONTRACT.md §3).
-- Service-only functions used by the edge functions (outreach-ai-reply-worker, outreach-ai-reply, send-reply, the webhook
-- handler, ai-classify), the message-origin trigger, the run → chat mirror trigger, and in-place patches that make the
-- existing engine treat an `ai_reply` action like a teammate's `reply` (conversation, not an automated step).
-- The app / MCP RPCs are in 037. Needs 034 committed and 035 applied. Idempotent.

-- ============================================================================= small helpers
create or replace function outreach__norm_text(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select nullif(regexp_replace(lower(btrim(coalesce(t, ''))), '\s+', ' ', 'g'), '')
$$;

create or replace function outreach__text_sha(t text) returns text
language sql immutable set search_path = public, extensions as $$
  select case when outreach__norm_text(t) is null then null else encode(extensions.digest(outreach__norm_text(t), 'sha256'), 'hex') end
$$;

-- EU + EEA, ISO 3166-1 alpha-2 (PRD §4.2: autopilot off there unless a disclosure line is set)
create or replace function outreach__eu_eea() returns text[]
language sql immutable set search_path = public, extensions as $$
  select array['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','IS','LI','NO']
$$;

create or replace function outreach_ai_reply_defaults() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'mode', 'draft', 'delay_min_s', 240, 'delay_max_s', 1200, 'debounce_quiet_s', 120, 'debounce_max_s', 600,
    'max_ai_sends_per_sender_day', 25, 'stale_after_h', 12, 'human_takeover_pause_h', 72, 'disclosure', null,
    'blocked_countries', to_jsonb(outreach__eu_eea()))
$$;

-- default guided settings (contract §5); merged under whatever a prompt stores
create or replace function outreach__mp_default_settings() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'stages', jsonb_build_array(
      jsonb_build_object('key','engage','label','Engage','early',true,'pitch',false,'instructions',
        E'My first 1–2 replies.\n- Respond to what they actually said, in their words.\n- Ask one question about their situation: what they''re working on, how they handle <problem> today.\n- Vary the approach between replies: e.g. first reply = acknowledge + question; second = react to their answer + one small useful observation or follow-up question.\n- No pitch, no link, no prices.'),
      jsonb_build_object('key','relate','label','Relate','early',true,'pitch',false,'instructions',
        E'Next reply.\n- Connect what they told me to one relevant example or result from "Facts I can use".\n- One question that checks if it matters to them. Still no link.'),
      jsonb_build_object('key','pitch','label','Pitch','early',false,'pitch',true,'instructions',
        E'Only after at least 2 exchanges.\n- One or two lines on how we''d help, tied to what they said. Not a feature list.'),
      jsonb_build_object('key','next_step','label','Next step','early',false,'pitch',false,'instructions',
        E'- Suggest a short call and share <my calendar link>. If they''d rather pick a time, offer two times from <my availability, e.g. Tue–Thu 3–6 pm IST>.')),
    'min_exchanges_before_pitch', 2,
    'skip_to_pitch_when', jsonb_build_array('asked_offer','pricing','meeting_request','meeting_time_proposed','explicit_interest'),
    'vary_moves_in_early_stages', true,
    'max_ai_replies_per_chat', 6,
    'languages', jsonb_build_array('en'),
    'allow_language_switch', false,
    'bot_question', 'escalate',
    'handoff_stage_id', null,
    'knowledge_source_ids', '[]'::jsonb,
    'max_length', 600)
$$;

create or replace function outreach__mp_default_sections() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'who', E'I''m {{sender.first_name}}, {{sender.role}} at <my company>. <One line on what we do and for whom.>',
    'flow', E'Move through these stages like a person would. Don''t pitch in the first replies unless they ask.\nSkip ahead when they ask what we do, ask the price, ask for a call, or say they want the service. Go straight to the stage that answers them.',
    'situations', E'- They ask the price → <e.g. "Share that projects start at ₹X" OR "Say pricing depends on scope and offer a 15-min call; no numbers">\n- They propose a meeting time → accept if it fits my availability; otherwise offer two times from it.\n- "Not now" / later → thank them, ask if I can check back in <month>; no pitch. Create a follow-up task for that date.\n- Not interested → don''t reply. Archive.\n- Wrong person, they name someone → thank them, say I''ll reach out to that person. Create a task with the contact exactly as they wrote it.\n- Out-of-office → don''t reply.\n- Just "Thanks" / 👍 after my last message → don''t reply.',
    'handoff', E'- They mention a contract, invoice, NDA, discount or legal terms.\n- They''re upset or complaining.\n- They ask something not covered by "Facts I can use".\n- <anything else>',
    'facts', E'- <Offer, turnaround, clients/proof points, prices if I want the AI to share them, links>',
    'style', E'- 1–3 short sentences. LinkedIn chat: no subject, no signature.\n- Match their language and register (English / Hinglish).\n- No exclamation marks unless they used them. No em dashes. Never "I hope this finds you well".')
$$;

-- Guided sections + stage table → the one prompt the model reads (§8.1)
create or replace function outreach__compile_master_prompt(p_sections jsonb, p_settings jsonb) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare s jsonb := coalesce(p_sections, '{}'::jsonb); st jsonb; i int := 0; stages text := '';
begin
  for st in select x from jsonb_array_elements(coalesce(p_settings->'stages', '[]'::jsonb)) x loop
    i := i + 1;
    stages := stages || format(E'Stage %s · %s%s\n%s\n\n', i, coalesce(st->>'label', st->>'key'),
      case when coalesce((st->>'pitch')::boolean, false) then ' (pitch)' when coalesce((st->>'early')::boolean, false) then ' (early)' else '' end,
      coalesce(nullif(btrim(st->>'instructions'), ''), '-'));
  end loop;
  return btrim(concat_ws(E'\n\n',
    E'## Who I am\n' || coalesce(nullif(btrim(s->>'who'), ''), '-'),
    E'## How a conversation goes\n' || coalesce(nullif(btrim(s->>'flow'), ''), '-') || case when stages <> '' then E'\n\n' || btrim(stages) else '' end,
    E'## Situations\n' || coalesce(nullif(btrim(s->>'situations'), ''), '-'),
    E'## Hand to a person when\n' || coalesce(nullif(btrim(s->>'handoff'), ''), '-'),
    E'## Facts I can use\n' || coalesce(nullif(btrim(s->>'facts'), ''), '-'),
    E'## Style\n' || coalesce(nullif(btrim(s->>'style'), ''), '-')));
end $$;

create or replace function outreach_master_prompt_template() returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('editor_mode', 'guided', 'sections', outreach__mp_default_sections(), 'settings', outreach__mp_default_settings(),
                            'body', outreach__compile_master_prompt(outreach__mp_default_sections(), outreach__mp_default_settings()))
$$;

-- ============================================================================= message origin + text hash (§10.4, §11)
create or replace function outreach_trg_message_origin() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare t outreach_action_type_t;
begin
  if tg_op = 'INSERT' or new.text is distinct from old.text then new.text_sha256 := outreach__text_sha(new.text); end if;
  if (tg_op = 'INSERT' and new.origin = 'unknown')
     or (tg_op = 'UPDATE' and new.action_id is distinct from old.action_id and new.action_id is not null and new.origin in ('unknown','external_device')) then
    if new.direction = 'in' then new.origin := 'prospect';
    elsif new.action_id is not null then
      select action_type into t from outreach_actions where id = new.action_id;
      new.origin := case when t is null then new.origin when t = 'reply' then 'inbox_user' when t = 'ai_reply' then 'ai_autopilot' else 'sequence' end;
    elsif new.is_invite_note then new.origin := 'sequence';
    end if;
  end if;
  return new;
end $$;
-- runs after the stamp (invite-note link) and unsupported (text nulling) triggers: BEFORE triggers fire in name order
drop trigger if exists outreach_messages_zz_origin on outreach_messages;
create trigger outreach_messages_zz_origin before insert or update of text, action_id on outreach_messages
  for each row execute function outreach_trg_message_origin();

-- one-off backfill (idempotent: only rows still 'unknown')
-- last 30 days only: that is all the drafter's 12-message window and the takeover matcher look at, and it keeps the
-- realtime fan-out of this one-off update small
update outreach_messages m set origin = 'prospect' where m.origin = 'unknown' and m.direction = 'in' and m.sent_at > now() - interval '30 days';
update outreach_messages m set origin = case a.action_type when 'reply' then 'inbox_user' when 'ai_reply' then 'ai_autopilot' else 'sequence' end
  from outreach_actions a where m.origin = 'unknown' and m.direction = 'out' and a.id = m.action_id and m.sent_at > now() - interval '30 days';
update outreach_messages m set origin = 'sequence' where m.origin = 'unknown' and m.direction = 'out' and m.is_invite_note and m.sent_at > now() - interval '30 days';
update outreach_messages m set text_sha256 = outreach__text_sha(m.text) where m.text_sha256 is null and m.text is not null and m.sent_at > now() - interval '30 days';

-- ============================================================================= resolution: sequence, policy, prompt, consent, graduation
-- the sequence a chat's replies belong to: the lead's latest enrollment with this chat's sender
create or replace function outreach__chat_sequence(p_chat uuid) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select e.sequence_id from outreach_chats c join outreach_enrollments e on e.lead_id = c.lead_id and e.sender_id = c.sender_id
   where c.id = p_chat order by e.created_at desc limit 1
$$;

-- merged policy, most specific first: sequence → sender → client → workspace → defaults. Adds mode_source / mode_source_id.
create or replace function outreach__ai_policy(p_ws uuid, p_client uuid, p_sequence uuid, p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare d jsonb := outreach_ai_reply_defaults(); o jsonb := '{}'::jsonb; r record; j jsonb; k text;
  keys text[] := array['mode','delay_min_s','delay_max_s','debounce_quiet_s','debounce_max_s','max_ai_sends_per_sender_day',
                       'stale_after_h','human_takeover_pause_h','disclosure','blocked_countries'];
begin
  for r in select p.*, case p.scope when 'sequence' then 1 when 'sender' then 2 when 'client' then 3 else 4 end as rk
             from outreach_reply_policies p
            where p.workspace_id = p_ws
              and (p.scope = 'workspace'
                or (p.scope = 'sequence' and p.scope_id = p_sequence)
                or (p.scope = 'sender' and p.scope_id = p_sender)
                or (p.scope = 'client' and p.scope_id = p_client))
            order by rk loop
    j := to_jsonb(r);
    foreach k in array keys loop
      if not (o ? k) and coalesce(j->k, 'null'::jsonb) <> 'null'::jsonb then
        o := o || jsonb_build_object(k, j->k);
        if k = 'mode' then o := o || jsonb_build_object('mode_source', r.scope, 'mode_source_id', r.scope_id, 'mode_downgraded_at', r.downgraded_at); end if;
      end if;
    end loop;
  end loop;
  foreach k in array keys loop
    if not (o ? k) then o := o || jsonb_build_object(k, d->k); end if;
  end loop;
  if not (o ? 'mode_source') then o := o || jsonb_build_object('mode_source', 'default', 'mode_source_id', null); end if;
  -- mixed scopes can leave min ≥ max: widen max so a delay window always exists
  if (o->>'delay_max_s')::int <= (o->>'delay_min_s')::int then o := jsonb_set(o, '{delay_max_s}', to_jsonb(least(3600, (o->>'delay_min_s')::int + 60))); end if;
  if (o->>'debounce_max_s')::int < (o->>'debounce_quiet_s')::int then o := jsonb_set(o, '{debounce_max_s}', o->'debounce_quiet_s'); end if;
  return o;
end $$;

-- the master prompt that speaks for a chat: sequence → client → workspace
create or replace function outreach__ai_master_prompt(p_ws uuid, p_client uuid, p_sequence uuid) returns outreach_master_prompts
language sql stable security definer set search_path = public, extensions as $$
  select mp.* from outreach_master_prompts mp
   where mp.workspace_id = p_ws
     and ((mp.scope = 'sequence' and mp.scope_id = p_sequence) or (mp.scope = 'client' and mp.scope_id = p_client) or mp.scope = 'workspace')
   order by case mp.scope when 'sequence' then 1 when 'client' then 2 else 3 end limit 1
$$;

create or replace function outreach__ai_consent_valid(p_sender uuid, p_mp uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from outreach_ai_reply_consent c join outreach_master_prompts m on m.id = c.master_prompt_id
                  where c.sender_id = p_sender and c.master_prompt_id = p_mp and c.revoked_at is null and c.expires_at > now()
                    and m.substantive_version <= c.master_prompt_version)
$$;

create or replace function outreach__ai_graduated(p_mp uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select mp.graduated_at is not null or coalesce(w.graduation_bypass, false)
                     from outreach_master_prompts mp left join outreach_ai_reply_workspace w on w.workspace_id = mp.workspace_id
                    where mp.id = p_mp), false)
$$;

-- monthly draft allowance (G12). Workspaces on their own LLM key are never limited.
create or replace function outreach__ai_pool(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare own boolean; lim int; used int; flagv jsonb;
begin
  select exists (select 1 from outreach_workspace_secrets s where s.workspace_id = p_ws and s.llm_key_enc is not null) into own;
  select w.monthly_limit into lim from outreach_ai_reply_workspace w where w.workspace_id = p_ws;
  if lim is null then
    select value into flagv from outreach_flags where key = 'ai_reply_monthly_limit';
    if jsonb_typeof(flagv) = 'number' then lim := (flagv #>> '{}')::int; end if;
  end if;
  select count(*)::int into used from outreach_ai_calls where workspace_id = p_ws and purpose = 'reply_draft' and at >= date_trunc('month', now());
  return jsonb_build_object('month', to_char(now(), 'YYYY-MM'), 'used', used, 'limit', case when own then null else lim end, 'own_key', own,
                            'ok', own or lim is null or used < lim);
end $$;

create or replace function outreach__ai_reason_text(p_mode text, p_code text, p_src_label text, p_until timestamptz) returns text
language sql immutable set search_path = public, extensions as $$
  select initcap(p_mode) || ' — ' || case coalesce(p_code, '')
    when 'no_master_prompt'      then 'save a master prompt to start AI drafts'
    when 'channel_not_supported' then 'AI replies are LinkedIn only for now'
    when 'chat_off'              then 'turned off for this chat'
    when 'consent_missing'       then 'sender consent missing'
    when 'not_graduated'         then 'autopilot is not unlocked for this prompt yet'
    when 'paused_human'          then 'a teammate replied, autopilot paused' || coalesce(' until ' || to_char(p_until at time zone 'UTC', 'DD Mon HH24:MI') || ' UTC', '')
    when 'paused_escalated'      then 'paused after an upset reply'
    when 'paused_bot'            then 'paused, the other side looks automated'
    else 'from ' || coalesce(p_src_label, 'workspace') end
$$;

-- effective mode for a chat (§3) — the one resolver the worker, dispatcher and UI share
create or replace function outreach__ai_effective(p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; s outreach_senders%rowtype; seq uuid; pol jsonb; mp outreach_master_prompts%rowtype;
        req text; src text; src_label text; md text; code text; consent_ok boolean := false; grad boolean := false; paused boolean;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then return null; end if;
  select * into s from outreach_senders where id = c.sender_id;
  seq := outreach__chat_sequence(p_chat);
  pol := outreach__ai_policy(c.workspace_id, c.client_id, seq, c.sender_id);
  mp := outreach__ai_master_prompt(c.workspace_id, c.client_id, seq);
  if c.reply_mode_override is not null then req := c.reply_mode_override::text; src := 'chat';
  else req := pol->>'mode'; src := pol->>'mode_source'; end if;
  src_label := case src
    when 'chat' then 'this chat'
    when 'sequence' then 'sequence ' || coalesce((select name from outreach_sequences where id = seq), '')
    when 'sender' then 'sender ' || coalesce(s.display_name, '')
    when 'client' then 'client ' || coalesce((select name from outreach_clients where id = c.client_id), '')
    when 'workspace' then 'workspace settings' else 'default' end;
  md := req;
  paused := c.autopilot_state <> 'active' and (c.autopilot_paused_until is null or c.autopilot_paused_until > now());
  if c.provider <> 'LINKEDIN' then md := 'off'; code := 'channel_not_supported';
  elsif mp.id is null then md := 'off'; code := 'no_master_prompt';
  elsif req = 'off' then code := case when src = 'chat' then 'chat_off' else null end;
  end if;
  if mp.id is not null then consent_ok := outreach__ai_consent_valid(c.sender_id, mp.id); grad := outreach__ai_graduated(mp.id); end if;
  if md = 'autopilot' then
    if not consent_ok then md := 'draft'; code := 'consent_missing';
    elsif not grad then md := 'draft'; code := 'not_graduated';
    elsif paused then md := 'draft'; code := c.autopilot_state;
    end if;
  end if;
  return jsonb_build_object(
    'chat_id', c.id, 'mode', md, 'requested_mode', req, 'source', src, 'source_label', src_label, 'reason_code', code,
    'reason', outreach__ai_reason_text(md, code, src_label, c.autopilot_paused_until),
    'can_autopilot', c.provider = 'LINKEDIN' and mp.id is not null and consent_ok and grad,
    'override', c.reply_mode_override, 'autopilot_state', case when paused then c.autopilot_state else 'active' end,
    'paused_until', case when paused then c.autopilot_paused_until end, 'paused_reason', case when paused then c.autopilot_paused_reason end,
    'policy', pol, 'sequence_id', seq, 'consent_valid', consent_ok, 'graduated', grad,
    'master_prompt', case when mp.id is null then null else jsonb_build_object('id', mp.id, 'scope', mp.scope, 'scope_id', mp.scope_id, 'version', mp.version,
                     'substantive_version', mp.substantive_version, 'editor_mode', mp.editor_mode) end,
    'settings', case when mp.id is null then null else outreach__mp_default_settings() || coalesce(mp.settings, '{}'::jsonb) end);
end $$;

-- ============================================================================= run → chat mirror (inbox filters, realtime)
create or replace function outreach_trg_ai_run_mirror() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status in ('debouncing','drafting','draft_ready','scheduled','sending') then
    -- decision mirrored too: in Draft mode an escalation / no-reply suggestion is a draft_ready run (inbox filters need it)
    update outreach_chats set ai_run_id = new.id, ai_run_status = new.status::text, ai_run_decision = new.decision::text,
           ai_escalation_reason = case when new.decision = 'escalate' then new.escalation_reasons[1] end,
           ai_scheduled_send_at = case when new.status = 'scheduled' then new.scheduled_send_at end
     where id = new.chat_id;
  else
    -- a terminal run only overwrites the mirror when it is the chat's current run (a superseded run must not clear its successor)
    update outreach_chats set ai_run_status = new.status::text, ai_run_decision = new.decision::text, ai_scheduled_send_at = null,
           ai_escalation_reason = case when new.status = 'escalated' then new.escalation_reasons[1] end
     where id = new.chat_id and (ai_run_id = new.id or ai_run_id is null);
  end if;
  return null;
end $$;
drop trigger if exists outreach_ai_reply_runs_mirror on outreach_ai_reply_runs;
create trigger outreach_ai_reply_runs_mirror after insert or update of status, scheduled_send_at, decision on outreach_ai_reply_runs
  for each row execute function outreach_trg_ai_run_mirror();
drop trigger if exists outreach_ai_reply_runs_updated_at on outreach_ai_reply_runs;
create trigger outreach_ai_reply_runs_updated_at before update on outreach_ai_reply_runs for each row execute function outreach_set_updated_at();

-- ============================================================================= run JSON
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
    'created_at', r.created_at, 'updated_at', r.updated_at, 'timings', r.timings) end
$$;

-- ============================================================================= side effects the master prompt may request (§6.4)
-- task(follow_up | contact_referral), archive, mark_read, set_tag — plus the floor's own opt_out. Nothing else is executable.
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
        insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, due_at, assigned_to)
        values (r.workspace_id, c.client_id, 'follow_up', c.lead_id, c.sender_id, c.id,
                left(case when e->>'kind' = 'contact_referral' then 'Referral from ' || nm || ': ' || coalesce(e->>'name', 'contact')
                          else 'Follow up with ' || nm end, 200),
                left(concat_ws(E'\n', nullif(e->>'note', ''), case when e->>'kind' = 'contact_referral' then 'Contact as they wrote it: ' || coalesce(e->>'contact', e->>'name', '') end,
                               'Created by an AI reply (' || coalesce(r.rule_applied, 'master prompt') || ').'), 2000),
                coalesce(due::timestamptz + interval '9 hours', now() + interval '1 day'), c.assigned_to);
        n := n + 1;
      when 'archive' then update outreach_chats set archived = true where id = c.id; n := n + 1;
      when 'mark_read' then update outreach_chats set unread = false, unread_count = 0 where id = c.id; n := n + 1;
      when 'set_tag' then
        tname := left(btrim(coalesce(e->>'tag', '')), 40);
        if tname <> '' and c.lead_id is not null then
          insert into outreach_tags(workspace_id, name) values (r.workspace_id, tname) on conflict (workspace_id, name) do nothing;
          select id into tg from outreach_tags where workspace_id = r.workspace_id and name = tname;
          insert into outreach_lead_tags(lead_id, tag_id) values (c.lead_id, tg) on conflict do nothing;
          n := n + 1;
        end if;
      when 'opt_out' then
        if c.lead_id is not null then update outreach_leads set do_not_contact = true where id = c.lead_id; end if;
        update outreach_chats set archived = true where id = c.id; n := n + 1;
      else null;
    end case;
  end loop;
  return n;
end $$;

-- escalation → a task for the chat's assignee (§13.3); the email is sent by the worker
create or replace function outreach__ai_escalation_task(p_run uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; nm text; words text; tid uuid;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  select * into c from outreach_chats where id = r.chat_id;
  select full_name into nm from outreach_leads where id = c.lead_id;
  nm := coalesce(nm, c.attendee_name, 'a lead');
  select string_agg(coalesce(m.text, m.transcript, '[attachment]'), E'\n' order by m.sent_at) into words from outreach_messages m where m.id = any(r.inbound_message_ids);
  -- one open escalation task per chat: refresh it instead of piling up
  select id into tid from outreach_tasks where chat_id = c.id and kind = 'ai_escalation' and completed_at is null limit 1;
  if tid is null then
    insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, chat_id, title, body, ai_draft, due_at, assigned_to)
    values (r.workspace_id, c.client_id, 'ai_escalation', c.lead_id, c.sender_id, c.id, left('AI handed over: ' || nm, 200),
            left(concat_ws(E'\n\n', 'Why: ' || array_to_string(r.escalation_reasons, ', '), 'They wrote:' || E'\n' || coalesce(words, '')), 4000),
            r.draft_text, now() + interval '2 hours', c.assigned_to) returning id into tid;
  else
    update outreach_tasks set body = left(concat_ws(E'\n\n', 'Why: ' || array_to_string(r.escalation_reasons, ', '), 'They wrote:' || E'\n' || coalesce(words, '')), 4000),
           ai_draft = r.draft_text, due_at = least(due_at, now() + interval '2 hours') where id = tid;
  end if;
  return tid;
end $$;

-- ============================================================================= per-chat serialisation
-- Every path that changes a chat's runs takes this transaction-scoped advisory lock first (claims skip a busy chat), so the
-- run → chat mirror trigger and the chat row lock are always taken in the same order: no deadlocks between the worker, the
-- dispatcher, the webhook and a person's send.
create or replace function outreach__ai_chat_lock_key(p_chat uuid) returns bigint
language sql immutable set search_path = public, extensions as $$ select hashtextextended('outreach_ai_reply:' || p_chat::text, 0) $$;
create or replace function outreach__ai_chat_lock(p_chat uuid) returns void
language sql set search_path = public, extensions as $$ select pg_advisory_xact_lock(outreach__ai_chat_lock_key(p_chat)) $$;

-- ============================================================================= open / enqueue (§6.2)
create or replace function outreach__ai_open_run(p_chat uuid, p_ids uuid[], p_quiet int, p_max int, p_mode text, p_inbound_at timestamptz) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; nid uuid;
begin
  select * into c from outreach_chats where id = p_chat;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids,
                                     debounce_until, debounce_hard_until, mode, timings)
  values (c.workspace_id, c.client_id, c.id, c.sender_id, c.lead_id, outreach__chat_sequence(c.id), c.provider, p_ids,
          now() + make_interval(secs => p_quiet), now() + make_interval(secs => p_max), p_mode::outreach_reply_mode_t,
          jsonb_build_object('inbound_at', coalesce(p_inbound_at, now())))
  returning id into nid;
  return nid;
end $$;

create or replace function outreach_ai_reply_enqueue(p_chat uuid, p_message uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype; eff jsonb; pol jsonb; r outreach_ai_reply_runs%rowtype;
        prev_out outreach_messages%rowtype; lat int; fast int; nid uuid; ids uuid[]; first_at timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  select * into c from outreach_chats where id = p_chat for update;
  if not found then return jsonb_build_object('action', 'skipped', 'why', 'no_chat'); end if;
  select * into m from outreach_messages where id = p_message and chat_id = p_chat;
  if not found or m.direction <> 'in' or m.event_type is not null then return jsonb_build_object('action', 'skipped', 'why', 'not_inbound'); end if;

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

  eff := outreach__ai_effective(p_chat);
  if eff->>'mode' = 'off' then return jsonb_build_object('action', 'skipped', 'why', coalesce(eff->>'reason_code', 'off')); end if;
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
    ids := r.inbound_message_ids || p_message;
    first_at := coalesce((r.timings->>'inbound_at')::timestamptz, m.sent_at);
    nid := outreach__ai_open_run(p_chat, ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', first_at);
    return jsonb_build_object('action', 'superseded', 'run_id', nid, 'superseded', r.id);
  end if;
  nid := outreach__ai_open_run(p_chat, array[p_message], (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', m.sent_at);
  return jsonb_build_object('action', 'created', 'run_id', nid);
end $$;

-- ============================================================================= worker: claim + gate facts + finalize (§6.3, §12.3)
create or replace function outreach_ai_reply_claim(p_limit int default 25) returns setof outreach_ai_reply_runs
language plpgsql security definer set search_path = public, extensions as $$
declare cand record; r outreach_ai_reply_runs%rowtype; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for cand in
    select x.id, x.chat_id from outreach_ai_reply_runs x
     where x.status = 'debouncing' and least(x.debounce_until, x.debounce_hard_until) <= now()
       and (x.next_attempt_at is null or x.next_attempt_at <= now())
       -- wait for the classifier on every message of the burst; after 60 s the worker classifies inline
       and (least(x.debounce_until, x.debounce_hard_until) <= now() - interval '60 seconds'
            or not exists (select 1 from outreach_messages mm where mm.id = any(x.inbound_message_ids) and mm.classified_at is null and mm.deleted_at is null))
     order by least(x.debounce_until, x.debounce_hard_until) limit greatest(1, least(p_limit, 100)) * 2
  loop
    exit when n >= greatest(1, least(p_limit, 100));
    -- one mutator per chat at a time (same lock the enqueue / human-send paths take); a busy chat is picked up next tick
    if not pg_try_advisory_xact_lock(outreach__ai_chat_lock_key(cand.chat_id)) then continue; end if;
    update outreach_ai_reply_runs set status = 'drafting', attempts = attempts + 1 where id = cand.id and status = 'debouncing' returning * into r;
    if found then n := n + 1; return next r; end if;
  end loop;
end $$;

-- everything the gates and the drafter need from the database, in one call
create or replace function outreach_ai_reply_gate_facts(p_run uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; c outreach_chats%rowtype; s outreach_senders%rowtype; l outreach_leads%rowtype;
        eff jsonb; first_in timestamptz; contacted boolean; stage_pos int; stage_name text; handoff_pos int; tags text[]; supp text;
        day date; ai_today int; combined int; burst jsonb; thread jsonb; seq jsonb; first_step jsonb; other jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then return null; end if;
  select * into c from outreach_chats where id = r.chat_id;
  select * into s from outreach_senders where id = r.sender_id;
  eff := outreach__ai_effective(r.chat_id);
  if c.lead_id is not null then
    select * into l from outreach_leads where id = c.lead_id;
    select st.position, st.name into stage_pos, stage_name from outreach_stages st where st.id = l.stage_id;
    select array_agg(lower(t.name::text)) into tags from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = l.id;
    supp := outreach_lead_suppression_reason(l, c.client_id, r.sequence_id);
  end if;
  if coalesce(eff->'settings'->>'handoff_stage_id', '') <> '' then
    select st.position into handoff_pos from outreach_stages st where st.id = (eff->'settings'->>'handoff_stage_id')::uuid and st.workspace_id = r.workspace_id;
  end if;
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
  -- last 12 messages, labelled by who wrote them (§9.3)
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
     order by m.sent_at desc limit 12) t;
  if r.sequence_id is not null then
    select jsonb_build_object('id', q.id, 'name', q.name, 'brief', q.brief) into seq from outreach_sequences q where q.id = r.sequence_id;
  end if;
  select jsonb_build_object('node_id', a.node_id, 'variant_id', a.variant_id, 'action_type', a.action_type) into first_step
    from outreach_messages m join outreach_actions a on a.id = m.replied_to_action_id
   where m.chat_id = c.id and m.is_first_reply order by m.sent_at limit 1;
  return jsonb_build_object(
    'run', to_jsonb(r), 'effective', eff,
    'chat', jsonb_build_object('id', c.id, 'provider', c.provider, 'archived', c.archived, 'is_group', c.is_group, 'lead_id', c.lead_id, 'client_id', c.client_id,
              'attendee_name', c.attendee_name, 'autopilot_state', c.autopilot_state, 'autopilot_paused_until', c.autopilot_paused_until,
              'stage', c.conversation_stage, 'exchanges', c.conversation_exchanges, 'ai_replies_count', c.ai_replies_count,
              'last_ai_move', c.last_ai_move, 'stage_stale', c.stage_stale, 'assigned_to', c.assigned_to, 'unipile_chat_id', c.unipile_chat_id),
    'sender', jsonb_build_object('id', s.id, 'status', s.status, 'display_name', s.display_name, 'timezone', s.timezone, 'schedule', s.schedule,
              'provider', s.provider, 'paused_until', s.paused_until, 'health_score', s.health_score, 'unipile_account_id', s.unipile_account_id,
              'owner_email', s.owner_email, 'client_id', s.client_id),
    'lead', case when l.id is null then null else jsonb_build_object('id', l.id, 'full_name', l.full_name, 'first_name', l.first_name, 'title', l.title,
              'company', l.company, 'headline', l.headline, 'location', l.location, 'do_not_contact', l.do_not_contact, 'unsubscribed', l.unsubscribed,
              'stage_position', stage_pos, 'stage_name', stage_name, 'tags', coalesce(to_jsonb(tags), '[]'::jsonb), 'suppression', supp) end,
    'handoff_stage_position', handoff_pos, 'contacted_first', contacted, 'burst', burst, 'thread', thread, 'sequence', seq, 'first_step', first_step,
    'ai_sends_today', coalesce(ai_today, 0), 'combined_today', coalesce(combined, 0), 'pool', outreach__ai_pool(r.workspace_id),
    'today_local', day);
end $$;

-- patchable run columns: the worker writes its result in one compare-and-set
create or replace function outreach__ai_run_apply(p_run uuid, p_from text[], p_to text, p_patch jsonb) returns outreach_ai_reply_runs
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; p jsonb := coalesce(p_patch, '{}'::jsonb) - 'id' - 'workspace_id' - 'chat_id' - 'sender_id' - 'status' - 'created_at' - 'timings';
begin
  update outreach_ai_reply_runs x set
    (mode, policy_snapshot, master_prompt_id, master_prompt_version, floor_sha256, model, decision, intent, flags, language,
     stage_before, stage_after, move, rule_applied, side_effects, draft_confidence, draft_text, final_text, facts_used, validator, verifier,
     redrafts, gate_failures, escalation_reasons, context, scheduled_send_at, sent_message_id, action_id, sent_origin, dispatched_by,
     cancelled_by, cancel_reason, cancel_note, edit_distance, facts_changed, error, next_attempt_at, attempts, inbound_message_ids)
    = (select y.mode, y.policy_snapshot, y.master_prompt_id, y.master_prompt_version, y.floor_sha256, y.model, y.decision, y.intent, y.flags, y.language,
              y.stage_before, y.stage_after, y.move, y.rule_applied, y.side_effects, y.draft_confidence, y.draft_text, y.final_text, y.facts_used, y.validator, y.verifier,
              y.redrafts, y.gate_failures, y.escalation_reasons, y.context, y.scheduled_send_at, y.sent_message_id, y.action_id, y.sent_origin, y.dispatched_by,
              y.cancelled_by, y.cancel_reason, y.cancel_note, y.edit_distance, y.facts_changed, y.error, y.next_attempt_at, y.attempts, y.inbound_message_ids
         from jsonb_populate_record(x, p) y),
    status = p_to::outreach_ai_reply_status_t,
    timings = x.timings || coalesce(p_patch->'timings', '{}'::jsonb)
  where x.id = p_run and x.status::text = any(p_from)
  returning x.* into r;
  return r;
end $$;

-- end of a worker pass: compare-and-set drafting → target, then the consequences in the same transaction
create or replace function outreach_ai_reply_finalize(p_run uuid, p_to text, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; tid uuid; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_to not in ('draft_ready','scheduled','escalated','no_reply','cancelled','failed','debouncing') then raise exception 'E_PAYLOAD_INVALID: bad target %', p_to; end if;
  perform outreach__ai_chat_lock((select chat_id from outreach_ai_reply_runs where id = p_run));
  r := outreach__ai_run_apply(p_run, array['drafting'], p_to, p_patch);
  if r.id is null then return jsonb_build_object('ok', false, 'why', 'state_changed'); end if;
  if p_to = 'escalated' then
    tid := outreach__ai_escalation_task(r.id);
    -- an upset or complaining reply to one of OUR AI sends pauses the chat (§10.3); an upset first reply is just escalated
    if (r.flags && array['hostile','complaint']) and exists (select 1 from outreach_messages m where m.chat_id = r.chat_id and m.direction = 'out' and m.origin = 'ai_autopilot') then
      update outreach_chats set autopilot_state = 'paused_escalated', autopilot_paused_until = null, autopilot_paused_reason = 'hostile_after_ai' where id = r.chat_id;
    end if;
  elsif p_to = 'no_reply' then
    n := outreach__ai_apply_side_effects(r.id);
  elsif p_to = 'failed' and r.mode = 'autopilot' then
    -- the AI could not produce a reply in autopilot: a person must answer (draft mode just has no draft in the composer)
    tid := outreach__ai_escalation_task(r.id);
  end if;
  perform outreach_emit_event(r.workspace_id, 'ai_reply.' || p_to, jsonb_build_object('run_id', r.id, 'chat_id', r.chat_id, 'lead_id', r.lead_id, 'sender_id', r.sender_id,
          'decision', r.decision, 'stage_after', r.stage_after, 'reasons', to_jsonb(r.escalation_reasons), 'scheduled_send_at', r.scheduled_send_at));
  return jsonb_build_object('ok', true, 'run', outreach__ai_run_json(r), 'task_id', tid, 'side_effects', n);
end $$;

-- ============================================================================= human sends and takeover (§10.4, §12.1 F15)
create or replace function outreach__ai_takeover(p_chat uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; pol jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = p_reason
   where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled');
  pol := outreach__ai_policy(c.workspace_id, c.client_id, outreach__chat_sequence(p_chat), c.sender_id);
  update outreach_chats set stage_stale = true,
         ai_run_status = case when ai_run_status in ('escalated','no_reply','failed','expired') then null else ai_run_status end,
         ai_escalation_reason = case when ai_run_status in ('escalated','no_reply','failed','expired') then null else ai_escalation_reason end,
         autopilot_state = case when autopilot_state in ('active','paused_human') then 'paused_human' else autopilot_state end,
         autopilot_paused_until = case when autopilot_state in ('active','paused_human') then now() + make_interval(hours => (pol->>'human_takeover_pause_h')::int) else autopilot_paused_until end,
         autopilot_paused_reason = case when autopilot_state in ('active','paused_human') then p_reason else autopilot_paused_reason end
   where id = p_chat;
end $$;

-- exchanges count prospect-burst → our-reply pairs: +1 when the message before this outbound is theirs
create or replace function outreach__ai_bump_exchange(p_chat uuid, p_message uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare prev text; at_ timestamptz;
begin
  select sent_at into at_ from outreach_messages where id = p_message;
  select direction::text into prev from outreach_messages where chat_id = p_chat and id <> p_message and event_type is null and deleted_at is null
     and sent_at <= coalesce(at_, now()) order by sent_at desc limit 1;
  if prev = 'in' then update outreach_chats set conversation_exchanges = conversation_exchanges + 1 where id = p_chat; return true; end if;
  return false;
end $$;

-- a teammate sent from the app (send-reply / API / MCP). p_run = the AI run whose draft the composer held (optional).
create or replace function outreach_ai_reply_on_human_send(p_chat uuid, p_message uuid, p_run uuid, p_edit_distance real, p_facts_changed boolean, p_actor uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; origin_ text := 'inbox_user'; used boolean := false; txt text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  perform 1 from outreach_chats where id = p_chat for update;
  select text into txt from outreach_messages where id = p_message;
  if p_run is not null then
    select * into r from outreach_ai_reply_runs where id = p_run and chat_id = p_chat and status in ('draft_ready','scheduled','escalated') and draft_text is not null for update;
    -- more than half rewritten = the teammate's own reply: no AI origin, no AI side effects, no graduation credit
    if found and coalesce(p_edit_distance, 1) <= 0.5 then
      used := true;
      origin_ := case when coalesce(p_edit_distance, 1) <= 0.0001 then 'ai_draft_sent' else 'ai_edited' end;
      update outreach_ai_reply_runs set status = 'sent', sent_origin = origin_, sent_message_id = p_message, final_text = txt, edit_distance = p_edit_distance,
             facts_changed = p_facts_changed, dispatched_by = p_actor, timings = timings || jsonb_build_object('sent_at', now())
       where id = r.id;
      update outreach_chats set conversation_stage = coalesce(r.stage_after, conversation_stage), last_ai_move = coalesce(r.move, last_ai_move), stage_stale = false
       where id = p_chat;
      perform outreach__ai_apply_side_effects(r.id);
    end if;
  end if;
  update outreach_messages set origin = origin_, ai_reply_run_id = case when used then p_run end where id = p_message;
  perform outreach__ai_bump_exchange(p_chat, p_message);
  -- any other AI work on this chat stops; autopilot pauses for the takeover window (drafts keep coming)
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover'
   where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled') and (not used or id is distinct from p_run);
  perform outreach__ai_takeover(p_chat, 'teammate_replied');
  if used then update outreach_chats set stage_stale = false where id = p_chat; end if;
  return jsonb_build_object('origin', origin_, 'used_run', used);
end $$;

-- an outbound message the webhook delivered that no send of ours recorded first (§10.4 "outside the app")
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
      -- delivered after all: record it as sent, count it, and close the "could not be sent" task
      update outreach_ai_reply_runs set status = 'sent', sent_origin = 'ai_autopilot', sent_message_id = m.id, error = coalesce(error, '') || ' (delivered)',
             timings = timings || jsonb_build_object('sent_at', m.sent_at) where id = run_.id;
      update outreach_actions set status = 'sent', executed_at = m.sent_at where id = run_.action_id and status = 'failed';
      update outreach_chats set ai_replies_count = ai_replies_count + 1, conversation_stage = coalesce(run_.stage_after, conversation_stage),
             last_ai_move = coalesce(run_.move, last_ai_move), stage_stale = false where id = c.id;
      perform outreach__ai_bump_exchange(c.id, m.id);
      update outreach_tasks set completed_at = now(), result = jsonb_build_object('resolved', 'delivered')
       where chat_id = c.id and kind = 'ai_escalation' and completed_at is null;
    end if;
    return 'ours_ai';
  end if;
  -- 2. an action of ours for this sender + lead is in flight, or ran within ±120 s and has not recorded its message yet:
  --    the webhook beat our own insert. (A send whose message is already recorded cannot be this one.)
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
  -- 4. the sender typed it on their phone / LinkedIn web: human takeover
  update outreach_messages set origin = 'external_device' where id = m.id;
  perform outreach__ai_bump_exchange(c.id, m.id);
  perform outreach__ai_takeover(c.id, 'sent_from_phone');
  perform outreach_emit_event(c.workspace_id, 'ai_reply.takeover', jsonb_build_object('chat_id', c.id, 'message_id', m.id, 'source', 'external_device'));
  return 'external_device';
end $$;

-- the prospect deleted or edited a message the AI is answering (§7.3 point 3, §12.1)
create or replace function outreach_ai_reply_on_message_change(p_message uuid, p_kind text) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; eff jsonb; pol jsonb; nid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock((select chat_id from outreach_messages where id = p_message));
  select * into r from outreach_ai_reply_runs where p_message = any(inbound_message_ids) and status in ('debouncing','drafting','draft_ready','scheduled') for update;
  if not found then return 'none'; end if;
  if p_kind = 'deleted' then
    if array_length(r.inbound_message_ids, 1) > 1 then
      -- other messages in the burst still need an answer: redraft without the deleted one
      update outreach_ai_reply_runs set status = 'superseded' where id = r.id;
      eff := outreach__ai_effective(r.chat_id); pol := eff->'policy';
      nid := outreach__ai_open_run(r.chat_id, array_remove(r.inbound_message_ids, p_message), 30, 60, coalesce(eff->>'mode', 'draft'), (r.timings->>'inbound_at')::timestamptz);
      return 'superseded';
    end if;
    update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'message_deleted' where id = r.id;
    return 'cancelled';
  end if;
  update outreach_ai_reply_runs set status = 'superseded' where id = r.id;
  eff := outreach__ai_effective(r.chat_id);
  if eff->>'mode' = 'off' then return 'superseded'; end if;
  pol := eff->'policy';
  nid := outreach__ai_open_run(r.chat_id, r.inbound_message_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', (r.timings->>'inbound_at')::timestamptz);
  return 'superseded';
end $$;

-- messages that arrived while a run was sending get their own run when that run ends any way other than `sent`
create or replace function outreach__ai_open_followups(p_run uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; eff jsonb; pol jsonb;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found or cardinality(r.followup_inbound_ids) = 0 then return null; end if;
  if exists (select 1 from outreach_ai_reply_runs x where x.chat_id = r.chat_id and x.status in ('debouncing','drafting','draft_ready','scheduled','sending')) then return null; end if;
  eff := outreach__ai_effective(r.chat_id);
  if eff->>'mode' = 'off' then return null; end if;
  pol := eff->'policy';
  update outreach_ai_reply_runs set followup_inbound_ids = '{}' where id = r.id;
  return outreach__ai_open_run(r.chat_id, r.followup_inbound_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', null);
end $$;

-- A person is about to send into this chat (send-reply / API / MCP), BEFORE the connector call: the AI stops here.
-- Refuses when an AI send is in flight or the AI already sent this draft; otherwise every pending AI run of the chat stops,
-- except the one whose draft the person is sending, which waits as draft_ready so the dispatcher cannot claim it meanwhile.
create or replace function outreach_ai_reply_before_human_send(p_chat uuid, p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock(p_chat);
  if exists (select 1 from outreach_ai_reply_runs where chat_id = p_chat and status = 'sending') then
    return jsonb_build_object('ok', false, 'why', 'ai_sending');
  end if;
  if p_run is not null and exists (select 1 from outreach_ai_reply_runs where id = p_run and chat_id = p_chat and status = 'sent' and sent_origin = 'ai_autopilot') then
    return jsonb_build_object('ok', false, 'why', 'ai_already_sent');
  end if;
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'human_sending'::text
   where chat_id = p_chat and id = p_run and status = 'scheduled';
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'human_takeover'
   where chat_id = p_chat and status in ('debouncing','drafting','draft_ready','scheduled') and id is distinct from p_run;
  return jsonb_build_object('ok', true);
end $$;

-- ============================================================================= dispatch (§7.3, F33)
create or replace function outreach_ai_reply_dispatch_claim(p_limit int default 25, p_run uuid default null) returns setof outreach_ai_reply_runs
language plpgsql security definer set search_path = public, extensions as $$
declare cand record; r outreach_ai_reply_runs%rowtype; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for cand in
    select x.id, x.chat_id from outreach_ai_reply_runs x
     where x.status = 'scheduled' and (x.id = p_run or (p_run is null and x.scheduled_send_at <= now()))
     order by x.scheduled_send_at limit greatest(1, least(p_limit, 100)) * 2
  loop
    exit when n >= greatest(1, least(p_limit, 100));
    if not pg_try_advisory_xact_lock(outreach__ai_chat_lock_key(cand.chat_id)) then continue; end if;
    update outreach_ai_reply_runs set status = 'sending' where id = cand.id and status = 'scheduled' returning * into r;
    if found then n := n + 1; return next r; end if;
  end loop;
end $$;

-- move a claimed run out of `sending` when it cannot go now (checks 1–8) or reserve the ledger and open the action
drop function if exists outreach_ai_reply_prepare_send(uuid);
drop function if exists outreach_ai_reply_prepare_send(uuid, boolean);
-- p_ignore_window: "Send now" pressed by a person sends outside working hours; p_country: the lead's parsed country (G14 recheck)
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
  -- 1. a newer message from them → redraft on everything unanswered (before the age check: a new message deserves an answer)
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
  -- never two AI messages in a row: the last message must be theirs
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
  -- 4. still autopilot, consent valid, not paused / archived, lead not suppressed
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
    -- consent revoked, graduation lost, chat paused or the policy moved to draft: the draft waits for a person
    update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || coalesce(eff->>'reason_code', 'mode_draft') where id = r.id;
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
  -- 7. caps: the policy's AI sends / day (sends in flight count), message + reply + ai_reply ≤ 100 / day, then the ledger
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

create or replace function outreach_ai_reply_reschedule(p_run uuid, p_at timestamptz, p_why text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform outreach__ai_chat_lock((select chat_id from outreach_ai_reply_runs where id = p_run));
  update outreach_ai_reply_runs set status = 'scheduled', scheduled_send_at = p_at, error = p_why where id = p_run and status = 'sending';
  return found;
end $$;

create or replace function outreach_ai_reply_mark_sent(p_run uuid, p_message uuid, p_unipile_message_id text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; a outreach_actions%rowtype; eff jsonb; pol jsonb; nid uuid;
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
  perform outreach_emit_event(r.workspace_id, 'ai_reply.sent', jsonb_build_object('run_id', r.id, 'chat_id', r.chat_id, 'lead_id', r.lead_id, 'sender_id', r.sender_id, 'message_id', p_message, 'stage_after', r.stage_after));
  -- messages that arrived while we were sending get their own run now (§6.2 case 3)
  if cardinality(r.followup_inbound_ids) > 0 then
    eff := outreach__ai_effective(r.chat_id); pol := eff->'policy';
    if eff->>'mode' <> 'off' then
      nid := outreach__ai_open_run(r.chat_id, r.followup_inbound_ids, (pol->>'debounce_quiet_s')::int, (pol->>'debounce_max_s')::int, eff->>'mode', null);
    end if;
  end if;
  return jsonb_build_object('ok', true, 'followup_run', nid);
end $$;

-- p_retry_at null = final failure (the draft stays on the run; a person can still send it)
create or replace function outreach_ai_reply_send_failed(p_run uuid, p_error text, p_retry_at timestamptz) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype; a outreach_actions%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then return jsonb_build_object('ok', false); end if;
  perform outreach__ai_chat_lock(r.chat_id);
  select * into r from outreach_ai_reply_runs where id = p_run for update;
  if r.status <> 'sending' then return jsonb_build_object('ok', false); end if;
  select * into a from outreach_actions where id = r.action_id;
  if a.id is not null and a.status = 'reserved' then
    perform outreach_release_budget(a.sender_id, outreach_sender_local_date(a.sender_id, a.reserved_at), 'ai_reply', a.reserved_at);
    update outreach_actions set status = 'failed', executed_at = now(), error_code = left(p_error, 120) where id = a.id;
  end if;
  if p_retry_at is not null and r.send_attempts < 3 then
    update outreach_ai_reply_runs set status = 'scheduled', scheduled_send_at = p_retry_at, action_id = null, send_attempts = send_attempts + 1, error = left(p_error, 500) where id = r.id;
    return jsonb_build_object('ok', true, 'to', 'scheduled');
  end if;
  update outreach_ai_reply_runs set status = 'failed', send_attempts = send_attempts + 1, error = left(p_error, 500) where id = r.id;
  -- a failed autopilot send becomes a person's job, with the draft attached; their newer messages still get a run
  perform outreach__ai_escalation_task(r.id);
  perform outreach__ai_open_followups(r.id);
  return jsonb_build_object('ok', true, 'to', 'failed');
end $$;

-- ============================================================================= classifier follow-up (§10.3)
-- after F18 labels an inbound message: what did it say about our previous AI send?
create or replace function outreach_ai_reply_after_classify(p_message uuid, p_bot_pattern boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare m outreach_messages%rowtype; prev outreach_messages%rowtype; paused text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into m from outreach_messages where id = p_message;
  if not found or m.direction <> 'in' then return jsonb_build_object('ok', false); end if;
  select * into prev from outreach_messages where chat_id = m.chat_id and direction = 'out' and sent_at <= m.sent_at order by sent_at desc limit 1;
  if prev.id is null or prev.origin <> 'ai_autopilot' or prev.ai_reply_run_id is null then return jsonb_build_object('ok', true, 'after_ai', false); end if;
  update outreach_ai_reply_runs set drew_bot_question = drew_bot_question or ('bot_question' = any(m.ai_flags)),
         drew_hostile = drew_hostile or (m.ai_flags && array['hostile','complaint'])
   where id = prev.ai_reply_run_id;
  if m.ai_flags && array['hostile','complaint'] then
    update outreach_chats set autopilot_state = 'paused_escalated', autopilot_paused_until = null, autopilot_paused_reason = 'hostile_after_ai'
     where id = m.chat_id and autopilot_state <> 'paused_escalated';
    paused := 'paused_escalated';
  elsif p_bot_pattern then
    update outreach_chats set autopilot_state = 'paused_bot', autopilot_paused_until = null, autopilot_paused_reason = 'auto_responder'
     where id = m.chat_id and autopilot_state = 'active';
    paused := 'paused_bot';
  end if;
  return jsonb_build_object('ok', true, 'after_ai', true, 'paused', paused, 'run_id', prev.ai_reply_run_id);
end $$;

-- ============================================================================= maintenance (F35 / F36)
create or replace function outreach_ai_reply_expire() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n_exp int := 0; n_stuck int; n_fail int; n_send int := 0; n_resume int; r record;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in select id from outreach_ai_reply_runs where status = 'scheduled' and created_at < now() - interval '24 hours' loop
    update outreach_ai_reply_runs set status = 'expired', error = 'older_than_24h' where id = r.id and status = 'scheduled';
    perform outreach__ai_open_followups(r.id);
    n_exp := n_exp + 1;
  end loop;
  -- a worker that died mid-draft: retry twice, then fail (the thread stays answerable by a person)
  update outreach_ai_reply_runs set status = 'debouncing', next_attempt_at = now() + interval '1 minute'
   where status = 'drafting' and updated_at < now() - interval '5 minutes' and attempts < 3;
  get diagnostics n_stuck = row_count;
  update outreach_ai_reply_runs set status = 'failed', error = 'stuck_drafting' where status = 'drafting' and updated_at < now() - interval '5 minutes';
  get diagnostics n_fail = row_count;
  -- a dispatcher that died mid-send: never resend blind (the message may have gone out); a person decides
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
  update outreach_chats set autopilot_state = 'active', autopilot_paused_until = null, autopilot_paused_reason = null
   where autopilot_state = 'paused_human' and autopilot_paused_until is not null and autopilot_paused_until <= now();
  get diagnostics n_resume = row_count;
  update outreach_ai_reply_consent_links set cancelled_at = now() where used_at is null and cancelled_at is null and expires_at < now() - interval '30 days';
  return jsonb_build_object('expired', n_exp, 'retried', n_stuck, 'failed', n_fail, 'stuck_sending', n_send, 'resumed_chats', n_resume);
end $$;

-- §10.3 circuit breakers. Applies the downgrades and returns what to tell people.
create or replace function outreach_ai_reply_breakers() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare q record; out_ jsonb := '[]'::jsonb; n int; bad int; minn int; thr numeric; reset_at timestamptz; mp outreach_master_prompts%rowtype; reasons jsonb; rules jsonb; sent int; botq int; aid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  -- 1 + 2: per sequence with autopilot activity in the last 30 days
  for q in select distinct r.workspace_id, r.sequence_id, r.client_id from outreach_ai_reply_runs r
            where r.sequence_id is not null and r.timings ? 'scheduled_at' and r.created_at > now() - interval '30 days' loop
    if exists (select 1 from outreach_reply_policies p where p.workspace_id = q.workspace_id and p.scope = 'sequence' and p.scope_id = q.sequence_id
                 and p.downgraded_at is not null and p.downgraded_at > now() - interval '30 days' and p.mode is distinct from 'autopilot') then continue; end if;
    mp := outreach__ai_master_prompt(q.workspace_id, q.client_id, q.sequence_id);
    -- a manager turned autopilot back on: judge only the holds since then
    reset_at := coalesce((select p.breaker_reset_at from outreach_reply_policies p where p.workspace_id = q.workspace_id and p.scope = 'sequence' and p.scope_id = q.sequence_id), '-infinity'::timestamptz);
    -- holds that ended: sent untouched, edited, or cancelled by a person
    select count(*), count(*) filter (where x.sent_origin = 'ai_edited' or (x.status = 'cancelled' and x.cancelled_by is not null)) into n, bad from (
      select r.* from outreach_ai_reply_runs r
       where r.sequence_id = q.sequence_id and r.timings ? 'scheduled_at' and r.status in ('sent','cancelled') and r.created_at > reset_at
         and (r.status <> 'cancelled' or r.cancelled_by is not null)
         and (mp.id is null or mp.version = 1 or r.created_at >= mp.substantive_at
              or (select count(*) from outreach_ai_reply_runs z where z.sequence_id = q.sequence_id and z.timings ? 'scheduled_at' and z.created_at >= mp.substantive_at) >= 20)
       order by r.created_at desc limit 20) x;
    -- after a substantive change the next 20 holds are judged at 15 % (§16.2)
    thr := case when mp.id is not null and mp.version > 1 and (select count(*) from outreach_ai_reply_runs z where z.sequence_id = q.sequence_id and z.timings ? 'scheduled_at' and z.created_at >= mp.substantive_at) < 20 then 0.15 else 0.25 end;
    minn := case when thr = 0.15 then 5 else 10 end;
    if n >= minn and bad::numeric / n >= thr then
      select coalesce(jsonb_agg(jsonb_build_object('reason', k.cancel_reason, 'rule', k.rule_applied, 'n', k.n)), '[]'::jsonb) into reasons from (
        select coalesce(r.cancel_reason, 'edited') cancel_reason, r.rule_applied, count(*) n from outreach_ai_reply_runs r
         where r.sequence_id = q.sequence_id and r.timings ? 'scheduled_at' and (r.sent_origin = 'ai_edited' or (r.status = 'cancelled' and r.cancelled_by is not null))
           and r.created_at > now() - interval '30 days' group by 1, 2 order by 3 desc limit 10) k;
      perform outreach__ai_downgrade(q.workspace_id, q.sequence_id, format('%s of the last %s autopilot replies were cancelled or edited', bad, n));
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
  -- 3: "too early to pitch" three times in 7 days on one prompt → suggest raising min_exchanges_before_pitch
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

create or replace function outreach__ai_downgrade(p_ws uuid, p_sequence uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into outreach_reply_policies(workspace_id, scope, scope_id, mode, downgraded_at, downgrade_reason, note)
  values (p_ws, 'sequence', p_sequence, 'draft', now(), p_reason, 'Automatic downgrade')
  on conflict (workspace_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  do update set mode = 'draft', downgraded_at = now(), downgrade_reason = p_reason, updated_at = now();
  -- scheduled sends of that sequence wait for a person instead
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'downgraded'::text
   where sequence_id = p_sequence and status = 'scheduled';
  perform outreach_audit(p_ws, 'ai_reply.downgraded', 'sequence', p_sequence::text, jsonb_build_object('reason', p_reason), 'system');
end $$;

-- ============================================================================= graduation (§16.2)
create or replace function outreach__ai_graduation_calc(p_mp uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; n int; minn int; light int; facts int; since int; reg_total int; reg_pass int; reg_at timestamptz; bypass boolean; missing text[] := '{}';
        share numeric; eligible boolean;
begin
  select * into mp from outreach_master_prompts where id = p_mp;
  if not found then return null; end if;
  select coalesce(graduation_bypass, false) into bypass from outreach_ai_reply_workspace where workspace_id = mp.workspace_id;
  -- drafts produced under the current substantive version (style-only edits since then count); a prompt that already
  -- graduated keeps counting its last 60 days, so a substantive change does not wipe it (the breaker watches it instead)
  since := case when mp.graduated_at is null then mp.substantive_version else 1 end;
  select count(*), count(*) filter (where r.edit_distance <= 0.15), count(*) filter (where r.facts_changed)
    into n, light, facts from outreach_ai_reply_runs r
   where r.master_prompt_id = mp.id and r.master_prompt_version >= since and r.status = 'sent' and r.sent_origin in ('ai_draft_sent','ai_edited')
     and r.updated_at > now() - interval '60 days';
  share := case when n > 0 then round(light::numeric / n, 3) end;
  select count(*), count(*) filter (where s.passed and coalesce(s.last_version, 0) >= mp.substantive_version), max(s.last_run_at)
    into reg_total, reg_pass, reg_at from outreach_ai_reply_scenarios s
   where s.workspace_id = mp.workspace_id and (s.master_prompt_id = mp.id or (s.master_prompt_id is null and mp.scope = 'workspace'));
  if mp.graduated_at is null and n < 30 then missing := missing || format('%s more drafts sent by a person (%s of 30)', 30 - n, n); end if;
  minn := case when mp.graduated_at is null then 1 else 10 end;
  if n >= minn and coalesce(share, 0) < 0.8 then missing := missing || format('%s%% of sent drafts were unedited or lightly edited (80%% needed)', round(coalesce(share, 0) * 100)); end if;
  if facts > 0 then missing := missing || format('%s sent draft(s) had a price, date or link changed by a person', facts); end if;
  if reg_total = 0 then missing := missing || 'Save at least one simulator scenario'::text;
  elsif reg_pass < reg_total then missing := missing || format('%s of %s simulator scenarios fail or have not run on the current version', reg_total - reg_pass, reg_total); end if;
  eligible := cardinality(missing) = 0;
  return jsonb_build_object('eligible', eligible, 'graduated_at', mp.graduated_at, 'bypass', coalesce(bypass, false), 'window_days', 60, 'since_version', since,
    'drafts_sent', n, 'light_edits', light, 'light_edit_share', share, 'facts_changed', facts,
    'regression', jsonb_build_object('total', reg_total, 'passed', reg_pass, 'last_run_at', reg_at),
    'requirements', jsonb_build_object('min_drafts', 30, 'min_share', 0.8), 'missing', to_jsonb(missing));
end $$;

create or replace function outreach_ai_reply_graduation_refresh() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare mp outreach_master_prompts%rowtype; g jsonb; out_ jsonb := '[]'::jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for mp in select * from outreach_master_prompts loop
    g := outreach__ai_graduation_calc(mp.id);
    if (g->>'eligible')::boolean and mp.graduated_at is null then
      update outreach_master_prompts set graduated_at = now(), graduation = g, graduation_checked_at = now() where id = mp.id;
      out_ := out_ || jsonb_build_object('kind', 'graduated', 'workspace_id', mp.workspace_id, 'master_prompt_id', mp.id, 'scope', mp.scope);
    elsif not (g->>'eligible')::boolean and mp.graduated_at is not null then
      update outreach_master_prompts set graduated_at = null, graduation = g, graduation_checked_at = now() where id = mp.id;
      -- scheduled autopilot sends on this prompt wait for a person
      update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'graduation_lost'::text
       where master_prompt_id = mp.id and status = 'scheduled';
      out_ := out_ || jsonb_build_object('kind', 'graduation_lost', 'workspace_id', mp.workspace_id, 'master_prompt_id', mp.id, 'scope', mp.scope, 'missing', g->'missing');
    else
      update outreach_master_prompts set graduation = g, graduation_checked_at = now() where id = mp.id;
    end if;
  end loop;
  return out_;
end $$;

-- ============================================================================= digests (§4.1 weekly owner, §13.3 daily managers)
create or replace function outreach_ai_reply_digest_data(p_kind text, p_since timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_kind = 'owner' then
    return coalesce((select jsonb_agg(jsonb_build_object('sender_id', s.id, 'workspace_id', s.workspace_id, 'sender_name', s.display_name, 'owner_email', s.owner_email,
      'items', (select jsonb_agg(jsonb_build_object('chat_id', r.chat_id, 'lead', coalesce(l.full_name, c.attendee_name), 'text', r.final_text, 'sent_at', r.timings->>'sent_at') order by r.updated_at)
                  from outreach_ai_reply_runs r join outreach_chats c on c.id = r.chat_id left join outreach_leads l on l.id = c.lead_id
                 where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)))
      from outreach_senders s
     where s.owner_email is not null and s.deleted_at is null
       and exists (select 1 from outreach_ai_reply_runs r where r.sender_id = s.id and r.status = 'sent' and r.sent_origin = 'ai_autopilot' and r.updated_at >= p_since)), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('workspace_id', w.workspace_id,
      'sent_ai', w.sent_ai, 'sent_draft', w.sent_draft, 'escalated', w.escalated, 'cancelled', w.cancelled, 'no_reply', w.no_reply,
      'reasons', (select jsonb_agg(jsonb_build_object('reason', k.reason, 'n', k.n)) from (
                    select coalesce(r.cancel_reason, r.escalation_reasons[1]) reason, count(*) n from outreach_ai_reply_runs r
                     where r.workspace_id = w.workspace_id and r.updated_at >= p_since and r.status in ('cancelled','escalated')
                       and coalesce(r.cancel_reason, '') not in ('human_takeover','superseded') group by 1 order by 2 desc limit 8) k),
      'downgrades', (select jsonb_agg(jsonb_build_object('sequence_id', p.scope_id, 'reason', p.downgrade_reason)) from outreach_reply_policies p
                      where p.workspace_id = w.workspace_id and p.downgraded_at >= p_since)))
    from (select r.workspace_id,
                 count(*) filter (where r.status = 'sent' and r.sent_origin = 'ai_autopilot') sent_ai,
                 count(*) filter (where r.status = 'sent' and r.sent_origin in ('ai_draft_sent','ai_edited')) sent_draft,
                 count(*) filter (where r.status = 'escalated') escalated,
                 count(*) filter (where r.status = 'cancelled' and r.cancelled_by is not null) cancelled,
                 count(*) filter (where r.status = 'no_reply') no_reply
            from outreach_ai_reply_runs r where r.updated_at >= p_since group by r.workspace_id) w
   where w.sent_ai + w.escalated + w.cancelled > 0), '[]'::jsonb);
end $$;

-- ============================================================================= consent links (service; called by outreach-ai-reply)
create or replace function outreach_ai_consent_link_create(p_sender uuid, p_mp uuid, p_by uuid, p_email text, p_scope jsonb, p_examples jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; mp outreach_master_prompts%rowtype; tok text; lid uuid; exp timestamptz := now() + interval '7 days';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  select * into mp from outreach_master_prompts where id = p_mp;
  if s.id is null or mp.id is null or s.workspace_id <> mp.workspace_id then raise exception 'E_NOT_FOUND'; end if;
  update outreach_ai_reply_consent_links set cancelled_at = now() where sender_id = p_sender and master_prompt_id = p_mp and used_at is null and cancelled_at is null;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_ai_reply_consent_links(workspace_id, sender_id, master_prompt_id, master_prompt_version, email, token_hash, scope, examples, created_by, expires_at)
  values (s.workspace_id, s.id, mp.id, mp.version, lower(nullif(btrim(coalesce(p_email, '')), '')), encode(digest(tok, 'sha256'), 'hex'),
          coalesce(p_scope, '{}'::jsonb), coalesce(p_examples, '[]'::jsonb), p_by, exp)
  returning id into lid;
  perform outreach_audit(s.workspace_id, 'ai_reply.consent_requested', 'sender', s.id::text, jsonb_build_object('link_id', lid, 'master_prompt_id', mp.id, 'version', mp.version, 'email', p_email, 'by', p_by), 'user');
  return jsonb_build_object('id', lid, 'token', tok, 'expires_at', exp);
end $$;

create or replace function outreach_ai_consent_link_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent_links%rowtype; s outreach_senders%rowtype; mp outreach_master_prompts%rowtype; body text; st text; wsname text; br jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_ai_reply_consent_links where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into s from outreach_senders where id = k.sender_id;
  select * into mp from outreach_master_prompts where id = k.master_prompt_id;
  select v.body into body from outreach_master_prompt_versions v where v.master_prompt_id = k.master_prompt_id and v.version = k.master_prompt_version;
  select name, branding into wsname, br from outreach_workspaces where id = k.workspace_id;
  st := case when k.used_at is not null then 'accepted' when k.cancelled_at is not null then 'cancelled' when k.expires_at < now() then 'expired'
             when mp.substantive_version > k.master_prompt_version then 'outdated' else 'pending' end;
  return jsonb_build_object('status', st, 'workspace_id', k.workspace_id, 'workspace_name', wsname, 'branding', coalesce(br, '{}'::jsonb), 'sender_name', s.display_name,
    'email', k.email, 'master_prompt', jsonb_build_object('body', coalesce(body, mp.body), 'version', k.master_prompt_version, 'scope', mp.scope,
    'scope_label', case mp.scope when 'workspace' then 'Workspace prompt' when 'client' then 'Client prompt' else 'Sequence prompt' end),
    'scope', k.scope, 'examples', k.examples, 'expires_at', k.expires_at, 'consent_months', 12);
end $$;

-- the owner's revoke page shows whose autopilot it turns off before the click
create or replace function outreach_ai_consent_revoke_view(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent%rowtype; s outreach_senders%rowtype; wsname text; br jsonb; live int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_ai_reply_consent where revoke_token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into s from outreach_senders where id = k.sender_id;
  select name, branding into wsname, br from outreach_workspaces where id = k.workspace_id;
  select count(*) into live from outreach_ai_reply_consent where sender_id = k.sender_id and revoked_at is null and expires_at > now();
  return jsonb_build_object('status', case when live > 0 then 'active' else 'revoked' end, 'sender_name', s.display_name,
    'workspace_name', wsname, 'branding', coalesce(br, '{}'::jsonb), 'email', k.granted_by_email);
end $$;

create or replace function outreach_ai_consent_link_accept(p_token text, p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent_links%rowtype; mp outreach_master_prompts%rowtype; s outreach_senders%rowtype; rtok text; cid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_ai_reply_consent_links where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') for update;
  if not found then raise exception 'E_NOT_FOUND: this link is not valid'; end if;
  if k.used_at is not null then raise exception 'E_CONFLICT: consent was already given with this link'; end if;
  if k.cancelled_at is not null or k.expires_at < now() then raise exception 'E_EXPIRED: this link has expired, ask for a new one'; end if;
  select * into mp from outreach_master_prompts where id = k.master_prompt_id;
  if mp.substantive_version > k.master_prompt_version then raise exception 'E_CONFLICT: the prompt changed since this link was sent, ask for a new one'; end if;
  select * into s from outreach_senders where id = k.sender_id;
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'replaced' where sender_id = k.sender_id and master_prompt_id = k.master_prompt_id and revoked_at is null;
  rtok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_ai_reply_consent(workspace_id, sender_id, master_prompt_id, master_prompt_version, granted_by_email, granted_via, scope, evidence, granted_at, expires_at, revoke_token_hash)
  values (k.workspace_id, k.sender_id, k.master_prompt_id, k.master_prompt_version, coalesce(k.email, s.owner_email, 'unknown@unknown'), 'signed_link', k.scope,
          coalesce(p_evidence, '{}'::jsonb) || jsonb_build_object('token_id', k.id, 'at', now()), now(), now() + interval '12 months', encode(digest(rtok, 'sha256'), 'hex'))
  returning id into cid;
  update outreach_ai_reply_consent_links set used_at = now() where id = k.id;
  perform outreach_audit(k.workspace_id, 'ai_reply.consent_granted', 'sender', k.sender_id::text, jsonb_build_object('consent_id', cid, 'via', 'signed_link', 'version', k.master_prompt_version) || coalesce(p_evidence, '{}'::jsonb), 'system');
  return jsonb_build_object('consent_id', cid, 'revoke_token', rtok, 'workspace_id', k.workspace_id, 'sender_id', k.sender_id, 'email', coalesce(k.email, s.owner_email));
end $$;

-- revoking cancels every scheduled AI send for that sender at once; the drafts stay for a person
create or replace function outreach__ai_consent_revoke(p_consent uuid, p_reason text, p_actor text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_ai_reply_consent%rowtype;
begin
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = left(coalesce(p_reason, 'revoked'), 200) where id = p_consent and revoked_at is null returning * into k;
  if k.id is null then return; end if;
  update outreach_ai_reply_runs set status = 'draft_ready', mode = 'draft', gate_failures = gate_failures || 'consent_revoked'::text
   where sender_id = k.sender_id and master_prompt_id = k.master_prompt_id and status = 'scheduled';
  perform outreach_audit(k.workspace_id, 'ai_reply.consent_revoked', 'sender', k.sender_id::text, jsonb_build_object('consent_id', k.id, 'reason', p_reason, 'by', p_actor), 'user');
end $$;

create or replace function outreach_ai_consent_revoke_by_token(p_token text, p_evidence jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sid uuid; cid uuid; n int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select sender_id into sid from outreach_ai_reply_consent where revoke_token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if sid is null then raise exception 'E_NOT_FOUND: this link is not valid'; end if;
  -- the owner's one click turns autopilot off for this account on every prompt
  for cid in select id from outreach_ai_reply_consent where sender_id = sid and revoked_at is null loop
    perform outreach__ai_consent_revoke(cid, 'revoked_by_owner', 'owner_link');
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'revoked', n);
end $$;

-- ============================================================================= scenarios (service write-back)
create or replace function outreach_ai_reply_scenario_record(p_id uuid, p_result jsonb, p_version int, p_passed boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_ai_reply_scenarios set last_result = p_result, last_version = p_version, passed = p_passed, last_run_at = now(), updated_at = now() where id = p_id;
end $$;

-- ============================================================================= existing engine: ai_reply behaves like a teammate's reply
-- (conversation, not an automated step; never claimed by the tick; never swept back to `queued`)
do $$
declare f record; def text; nd text;
begin
  for f in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and p.proname in ('outreach_trg_message_stamp','outreach_trg_reply_exit','outreach__sender_causes','outreach_health_inputs',
                                'outreach_record_block','outreach_thread_attribution','outreach_claim_due_actions') loop
    def := pg_get_functiondef(f.oid);
    if position('''ai_reply''' in def) > 0 then continue; end if;   -- already patched
    nd := replace(def, $q$a.action_type <> 'reply'$q$, $q$a.action_type not in ('reply','ai_reply')$q$);
    nd := replace(nd, $q$ action_type <> 'reply'$q$, $q$ action_type not in ('reply','ai_reply')$q$);
    nd := replace(nd, $q$not in ('reply','relations_poll')$q$, $q$not in ('reply','ai_reply','relations_poll')$q$);
    if f.proname = 'outreach_thread_attribution' then
      nd := replace(nd, $q$a.action_type = 'reply'$q$, $q$a.action_type in ('reply','ai_reply')$q$);
    end if;
    if f.proname = 'outreach_claim_due_actions' then
      -- the tick never executes an ai_reply: the dispatcher's recheck must run first
      nd := replace(nd, $q$where a2.status = 'queued' and a2.scheduled_for <= now()$q$, $q$where a2.status = 'queued' and a2.scheduled_for <= now() and a2.action_type <> 'ai_reply'$q$);
      if position($q$a2.action_type <> 'ai_reply'$q$ in nd) = 0 then raise exception 'outreach_claim_due_actions: anchor not found, patch not applied'; end if;
    end if;
    if nd = def then raise exception '%: no reply anchor found, patch not applied', f.proname; end if;
    execute nd;
  end loop;
end $$;

-- a stale reserved ai_reply is never re-queued: the message may already be out, a person decides
create or replace function outreach_sweep_stale_reservations() returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare r record; cnt int := 0;
begin
  for r in select id, sender_id, action_type, reserved_at from outreach_actions where status = 'reserved' and reserved_at < now() - interval '10 minutes' loop
    perform outreach_release_budget(r.sender_id, outreach_sender_local_date(r.sender_id, r.reserved_at), r.action_type, r.reserved_at);
    if r.action_type = 'ai_reply' then
      update outreach_actions set status = 'failed', decision = 'stale_reservation', error_code = 'stale_reservation' where id = r.id;
    else
      update outreach_actions set status = 'queued', reserved_at = null, decision = 'stale_reservation' where id = r.id;
    end if;
    cnt := cnt + 1;
  end loop;
  return cnt;
end $$;
