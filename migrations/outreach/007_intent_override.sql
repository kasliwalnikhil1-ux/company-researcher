-- Manual intent override on a chat and its latest inbound message (members with write access).
create or replace function outreach_set_intent(p_chat uuid, p_intent outreach_intent_t)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_FORBIDDEN'; end if;
  update outreach_chats set intent = p_intent where id = p_chat;
  update outreach_messages set intent = p_intent, classified_at = now()
   where id = (select id from outreach_messages where chat_id = p_chat and direction = 'in' order by sent_at desc limit 1);
  perform outreach_audit(c.workspace_id, 'chat.intent_override', 'chat', p_chat::text, jsonb_build_object('intent', p_intent));
end $$;
