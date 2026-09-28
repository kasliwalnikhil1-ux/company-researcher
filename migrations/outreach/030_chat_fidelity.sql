-- 030 — WhatsApp / Instagram thread fidelity (Sept 2026)
--
-- The inbox shows WhatsApp threads the way WhatsApp does. The messaging webhook (inbound.ts handleMessaging) and the chat
-- backfill now keep what the connector already sends with every message:
--   quoted            the message this one replies to: {unipile_message_id, provider_id, text, sender_id, sender_name,
--                     attachment_type}. Filled for inbound replies and for our replies sent with a quote.
--   sender_name       who wrote an inbound message (group chats have many authors; 1:1 chats one)
--   sender_identifier that author's phone (WhatsApp, "+digits") or handle (Instagram)
--   is_forwarded      the provider marked it "Forwarded"
--   delivered_at      message_delivered webhook (one grey tick → two grey ticks); read_at (025) is the blue ticks
--   event_type        a system event instead of a message (connector codes: 3 group created, 4 title changed,
--                     5 participant added, 6 removed, 7 left, 8 missed voice call, 9 missed video call,
--                     10 call received, 11 call sent, 12 call ended, 13 accepted, 0 unknown). Events never count as a reply.
-- reactions (025) entries gain `by_id` (the reactor's provider id) and `mine` (reacted by the sender account).
--
-- Contact / group pictures of WhatsApp and Instagram chats are copied to storage (outreach-attachments/<ws>/avatars/…)
-- because the connector's picture links expire; attendee_picture_url then holds a long-lived signed URL.
--
-- Idempotent.

alter table public.outreach_messages
  add column if not exists quoted jsonb,
  add column if not exists sender_name text,
  add column if not exists sender_identifier text,
  add column if not exists is_forwarded boolean not null default false,
  add column if not exists delivered_at timestamptz,
  add column if not exists event_type smallint;

comment on column public.outreach_messages.quoted is 'The message this one replies to: {unipile_message_id, provider_id, text, sender_id, sender_name, attachment_type}';
comment on column public.outreach_messages.sender_name is 'Author of an inbound message (group chats: the member who wrote it)';
comment on column public.outreach_messages.sender_identifier is 'Author phone (WhatsApp +digits) or handle (Instagram)';
comment on column public.outreach_messages.is_forwarded is 'Provider marked the message as forwarded';
comment on column public.outreach_messages.delivered_at is 'Delivered to the recipient device (WhatsApp message_delivered)';
comment on column public.outreach_messages.event_type is 'System event code instead of a message (call, group change); null for a normal message';

-- One-off backfill from the stored webhooks: quote, author, forwarded flag and event code of messages already received.
with ev as (
  select distinct on (e.payload->>'message_id') e.payload p
  from public.outreach_inbound_events e
  where e.payload->>'message_id' is not null and coalesce(e.payload->>'event', 'message_received') = 'message_received'
    and e.payload->>'account_type' in ('WHATSAPP', 'INSTAGRAM')
  order by e.payload->>'message_id'
), src as (
  select p->>'message_id' mid,
    case when jsonb_typeof(p->'quoted') = 'object' then p->'quoted' when jsonb_typeof(p->'reply_to') = 'object' then p->'reply_to' end q,
    p
  from ev
)
update public.outreach_messages m set
  quoted = coalesce(m.quoted, case when s.q is null then null else jsonb_strip_nulls(jsonb_build_object(
    'unipile_message_id', coalesce(s.q->>'message_id', s.q->>'id'),
    'provider_id', s.q->>'provider_id',
    'text', left(s.q->>'text', 500),
    'sender_id', s.q->>'sender_id',
    'sender_name', (select nullif(btrim(a->>'attendee_name'), '') from jsonb_array_elements(coalesce(s.p->'attendees', '[]'::jsonb)) a
                    where a->>'attendee_provider_id' = s.q->>'sender_id' limit 1),
    'attachment_type', coalesce(s.q->'attachments'->0->>'attachment_type', s.q->'attachments'->0->>'type'))) end),
  sender_name = coalesce(m.sender_name, case when m.direction = 'in' then nullif(btrim(s.p->'sender'->>'attendee_name'), '') end),
  sender_identifier = coalesce(m.sender_identifier, case when m.direction = 'in' then coalesce(
    case when s.p->'sender'->>'attendee_public_identifier' ~ '^\d{6,16}@(s\.whatsapp\.net|c\.us)$' then '+' || split_part(s.p->'sender'->>'attendee_public_identifier', '@', 1) end,
    nullif('+' || regexp_replace(coalesce(s.p->'sender'->'attendee_specifics'->>'phone_number', ''), '\D', '', 'g'), '+')) end),
  is_forwarded = m.is_forwarded or coalesce((s.p->>'is_forwarded')::boolean, false),
  event_type = coalesce(m.event_type, case when s.p->>'is_event' in ('1', 'true') then nullif(s.p->>'event_type', '')::smallint end)
from src s
where m.unipile_message_id = s.mid;
