-- 071: the widget learns whether the assistant answers in a conversation (`ai_live`).
--
-- outreach_chats.ai_mode is resolved once, when the conversation starts (049). A conversation that began while the
-- website's assistant was off keeps ai_mode = 'off' after the assistant is turned on, and webchat_v_voice_start refuses
-- a call there ('handed_off'). The widget could not tell, so it offered the mic and every call ended in "Voice isn't
-- available". With `ai_live` it hides voice in such a conversation and starts a call in a new one instead.
-- Same rule as webchat_v_voice_start: no teammate holds it and the mode is neither off nor review.

create or replace function outreach_webchat__conversation_json(c outreach_chats) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', c.id, 'status', c.status, 'created_at', c.created_at, 'last_message_at', c.last_message_at, 'last_message_preview', c.last_message_preview,
    'last_direction', c.last_direction, 'stream_key', c.stream_key, 'resolved_at', c.resolved_at, 'csat', c.csat, 'ai_handled', c.ai_handled,
    'handed_off_at', c.handed_off_at, 'source', c.source, 'labels', c.labels, 'custom_attributes', c.custom_attributes,
    'unread', (select count(*) from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.read_by_visitor_at is null and m.sender_type in ('agent','bot') and m.deleted_at is null),
    'assignee', case when c.assigned_to is null then null else jsonb_build_object('name', outreach_webchat__agent_name(c.assigned_to, c.workspace_id)) end,
    'agent_typing', c.agent_typing_at is not null and c.agent_typing_at > now() - interval '8 seconds',
    'ai_live', c.handed_off_at is null and coalesce(c.ai_mode, 'off') not in ('off', 'review'))
$$;
