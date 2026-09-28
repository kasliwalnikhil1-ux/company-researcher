-- 031 — Messages the connector cannot read (Sept 2026)
--
-- For a message type it does not support yet (WhatsApp polls, live locations, events, some albums …) the connector sends
-- the literal text "-- Unipile cannot display this type of message yet, check the native application --". That text
-- names the vendor and must never reach a customer (inbox thread, chat-list preview, MCP, outbound webhooks), and the
-- connector exposes no other field to fetch the real content. So:
--   unsupported   true when the message had nothing but that placeholder: the inbox shows
--                 "This message can't be shown here. Open <channel> to see it."
-- A BEFORE trigger strips the placeholder on every insert / update path (webhook, chat backfill, edits), including a
-- quoted message's text. When the message also carries a file (an image with the placeholder as caption), the file is
-- shown and only the text is dropped.
--
-- Idempotent.

alter table public.outreach_messages add column if not exists unsupported boolean not null default false;
comment on column public.outreach_messages.unsupported is 'The provider message type is not supported by the connector: shown as "open the app to see it"';

create or replace function public.outreach_trg_message_unsupported() returns trigger language plpgsql set search_path = public as $$
begin
  if new.text ~* 'unipile cannot display' then
    new.text := null;
    if coalesce(jsonb_array_length(case when jsonb_typeof(new.attachments) = 'array' then new.attachments end), 0) = 0 then new.unsupported := true; end if;
  end if;
  if jsonb_typeof(new.quoted) = 'object' and new.quoted->>'text' ~* 'unipile cannot display' then
    new.quoted := new.quoted - 'text';
  end if;
  return new;
end $$;
drop trigger if exists outreach_messages_unsupported on public.outreach_messages;
create trigger outreach_messages_unsupported before insert or update of text, quoted on public.outreach_messages
  for each row execute function public.outreach_trg_message_unsupported();

-- chat-list preview of an unsupported message
create or replace function public.outreach_trg_message_rollup() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_chats c set
    last_message_at = greatest(coalesce(c.last_message_at, new.sent_at), new.sent_at),
    last_direction = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at) then new.direction else c.last_direction end,
    last_message_preview = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at)
      then left(coalesce(new.text, case when new.unsupported then 'Unsupported message' end, ''), 140) else c.last_message_preview end,
    unread = case when new.direction = 'in' then true else c.unread end,
    unread_count = case when new.direction = 'in' then c.unread_count + 1 else c.unread_count end,
    archived = case when new.direction = 'in' then false else c.archived end
  where c.id = new.chat_id;
  return new;
end $$;

-- One-off cleanup of messages already stored (the update fires the trigger above)
update public.outreach_messages set text = text where text ~* 'unipile cannot display';
update public.outreach_messages set quoted = quoted where quoted->>'text' ~* 'unipile cannot display';
update public.outreach_chats c set last_message_preview = coalesce((
  select left(coalesce(m.text, case when m.unsupported then 'Unsupported message' end, ''), 140)
  from public.outreach_messages m where m.chat_id = c.id order by m.sent_at desc limit 1), '')
where c.last_message_preview ~* 'unipile cannot display';
