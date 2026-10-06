-- 078: no country is blocked by default for AI Auto replies.
-- Until now a sequence that never saved a blocked-countries list (blocked_countries is null) got the EU/EEA list
-- while no disclosure line was set. Now null and '{}' both mean "none": Auto replies only skip the countries a
-- person picked on the sequence's AI tab → Rules. The rest of outreach__ai_effective is unchanged from 041.
-- Live 2026-10-06. Also done live then (not repeated here): the 22 sequences whose list was exactly EU/EEA (copied
-- from the old default by the 040 backfill) were reset to null; their old values are in
-- cleanup_backup_20261006.seq_blocked_countries (sequence_id, blocked_countries).

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
  -- blocked countries: only what the sequence lists (null or empty = none; no EU/EEA default since 078)
  blocked := coalesce(to_jsonb(srs.blocked_countries), '[]'::jsonb);
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
