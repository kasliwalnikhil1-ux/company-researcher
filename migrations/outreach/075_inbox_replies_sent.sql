-- 075_inbox_replies_sent.sql — Replies / Sent in the unified inbox (inbox-replies-sent-PRD.md, 6 Oct 2026).
-- Requires 001–074. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/075_inbox_replies_sent.sql
--
-- No sending behaviour changes: this is a new way to look at data the platform already has.
--
--   1. outreach_chats gains who-wrote-last bookkeeping: first_inbound_at (null = nobody has written back), last_inbound_at
--      (last message from a PERSON: auto-replies and bounces excluded), first/last_outbound_at, last_auto_reply_at, the
--      generated waiting_on ('us' | 'them' | null) and ai_answering (the AI is about to answer their latest message).
--   2. outreach_messages gains replied_at (on our message, when their next message arrives), is_auto_reply, is_bounce and
--      bounced_at (on our email that came back). Notes live in their own table and never touch any of this.
--   3. Triggers keep it right on every path (webhook, backfill sync, send-reply, executor, AI): the rollup trigger (031)
--      now also stamps the direction columns in the same UPDATE; least / greatest make out-of-order arrival safe;
--      outreach_chat_direction_recompute(chat) rebuilds a chat after a delete or an out-of-office reclassification.
--   4. outreach_sent_items (view, security_invoker): one row per thing a person on the other side receives from us,
--      in three segments — sent · scheduled · failed — with the furthest status reached.
--   5. RPCs: outreach_inbox_sent_list (keyset-paged, each source queried with the same cursor then merged),
--      outreach_inbox_counts ({replies_unread, needs_reply, scheduled, failed}), outreach_inbox_sent_settings_get.
--   6. Backfill (batched by workspace) from existing messages.
--
-- Vocabulary (decision D5): Replies / Sent in the UI, direction in / out in data. Never "inbox" / "outbox".
-- Naming: outreach_inbox_* / outreach_chat_direction_* / outreach__msg_kind — outside the prefixes the 037/042/051 grant
-- loops revoke ([[outreach-grant-loop-gotcha]]).

-- ============================================================================= 1. columns
alter table outreach_chats
  add column if not exists first_inbound_at   timestamptz,   -- null = nobody has written back (auto-replies count, bounces do not)
  add column if not exists last_inbound_at    timestamptz,   -- last message from a person (auto-replies and bounces excluded)
  add column if not exists first_outbound_at  timestamptz,
  add column if not exists last_outbound_at   timestamptz,
  add column if not exists last_auto_reply_at timestamptz,   -- the "Auto-reply" tag: their latest message was an out-of-office
  add column if not exists ai_answering       boolean not null default false;

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'outreach_chats' and column_name = 'waiting_on') then
    alter table outreach_chats add column waiting_on text generated always as (
      case when last_inbound_at is null then null
           when last_outbound_at is null or last_inbound_at > last_outbound_at then 'us'
           else 'them' end) stored;
  end if;
end $$;

alter table outreach_messages
  add column if not exists replied_at    timestamptz,                  -- on our message: when their next message arrived
  add column if not exists is_auto_reply boolean not null default false, -- out-of-office / automatic reply (never a person's reply)
  add column if not exists is_bounce     boolean not null default false, -- a delivery-failure notice (never a reply)
  add column if not exists bounced_at    timestamptz;                  -- on our email: it came back

comment on column outreach_chats.first_inbound_at is 'Replies view: null = nobody on the other side has written (auto-replies count, bounces do not). Maintained by triggers (075).';
comment on column outreach_chats.waiting_on is 'us = their (person) message is the latest; them = ours is; null = they never wrote. Generated (075).';
comment on column outreach_chats.ai_answering is 'The AI is answering their latest message (Auto, not handed off, run in progress or waiting to send). Maintained by trigger (075).';
comment on column outreach_messages.replied_at is 'On our message: the time their next message arrived (person only; auto-replies never count). Maintained by triggers (075).';

-- ============================================================================= 2. what a message counts as
-- person | auto | bounce | ours | null (system events, call notices, CSAT surveys: never counted either way)
create or replace function outreach__msg_kind(p_dir outreach_direction_t, p_auto boolean, p_bounce boolean, p_event smallint, p_ctype text, p_stype text)
returns text language sql immutable set search_path = public, extensions as $$
  select case
    when p_event is not null or coalesce(p_ctype, 'text') in ('event', 'csat') or coalesce(p_stype, '') = 'system' then null
    when p_dir = 'out' then 'ours'
    when p_bounce then 'bounce'
    when p_auto then 'auto'
    else 'person' end
$$;

-- Bounce / auto-reply detection on email (same rule as the webhook's lead_sender_state.email_bounced) and the classifier's
-- out-of-office intent. A teammate correcting the intent away from ooo makes it a person's reply again.
create or replace function outreach_trg_message_kind() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare prov outreach_provider_t; frm text; subj text;
begin
  if new.direction <> 'in' then return new; end if;
  if tg_op = 'INSERT' then
    select c.provider into prov from outreach_chats c where c.id = new.chat_id;
    if prov in ('GMAIL', 'OUTLOOK', 'IMAP') then
      frm  := lower(coalesce(new.content_attributes #>> '{email,from,email}', new.content_attributes #>> '{email,from,identifier}', new.sender_identifier, ''));
      subj := coalesce(new.content_attributes #>> '{email,subject}', '');
      if (frm || ' ' || subj) ~* '(mailer-daemon|postmaster|delivery (status )?notification|undeliverable|delivery failure|mail delivery failed|returned mail)' then
        new.is_bounce := true;
      elsif subj ~* '^\s*(auto(matic)?[ -]?(reply|response|antwort)|autoreply|out of (the )?office|ooo\M|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica|risposta automatica|absence)' then
        new.is_auto_reply := true;
      end if;
    end if;
    if new.intent = 'ooo' then new.is_auto_reply := true; end if;
  elsif new.intent is distinct from old.intent then
    if new.intent = 'ooo' then new.is_auto_reply := true;
    elsif old.intent = 'ooo' then new.is_auto_reply := false; end if;
  end if;
  return new;
end $$;
-- BEFORE triggers fire in name order: stamp → unsupported → zy_kind → zz_origin
drop trigger if exists outreach_messages_zy_kind on outreach_messages;
create trigger outreach_messages_zy_kind before insert or update of intent on outreach_messages
  for each row execute function outreach_trg_message_kind();

-- ============================================================================= 3. bookkeeping on insert
-- The rollup trigger (003 → 031) already updates the chat once per message: the direction columns join that same UPDATE,
-- so a message still costs one chat write (and one realtime event).
create or replace function outreach_trg_message_rollup() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare k text := outreach__msg_kind(new.direction, new.is_auto_reply, new.is_bounce, new.event_type, new.content_type, new.sender_type);
begin
  update outreach_chats c set
    last_message_at = greatest(coalesce(c.last_message_at, new.sent_at), new.sent_at),
    last_direction = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at) then new.direction else c.last_direction end,
    last_message_preview = case when new.sent_at >= coalesce(c.last_message_at, new.sent_at)
      then left(coalesce(new.text, case when new.unsupported then 'Unsupported message' end, ''), 140) else c.last_message_preview end,
    unread = case when new.direction = 'in' then true else c.unread end,
    unread_count = case when new.direction = 'in' then c.unread_count + 1 else c.unread_count end,
    archived = case when new.direction = 'in' then false else c.archived end,
    first_inbound_at   = case when k in ('person', 'auto') then least(coalesce(c.first_inbound_at, new.sent_at), new.sent_at) else c.first_inbound_at end,
    last_inbound_at    = case when k = 'person' then greatest(coalesce(c.last_inbound_at, new.sent_at), new.sent_at) else c.last_inbound_at end,
    last_auto_reply_at = case when k = 'auto' then greatest(coalesce(c.last_auto_reply_at, new.sent_at), new.sent_at) else c.last_auto_reply_at end,
    first_outbound_at  = case when k = 'ours' then least(coalesce(c.first_outbound_at, new.sent_at), new.sent_at) else c.first_outbound_at end,
    last_outbound_at   = case when k = 'ours' then greatest(coalesce(c.last_outbound_at, new.sent_at), new.sent_at) else c.last_outbound_at end
  where c.id = new.chat_id;
  return new;
end $$;

-- replied_at on our message when a person answers; bounced_at on our email when a delivery failure comes back
create or replace function outreach_trg_message_direction() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare k text := outreach__msg_kind(new.direction, new.is_auto_reply, new.is_bounce, new.event_type, new.content_type, new.sender_type);
        ch outreach_chats%rowtype; tgt uuid;
begin
  if k is null or k not in ('person', 'bounce') then return null; end if;
  select * into ch from outreach_chats where id = new.chat_id;
  if not found or ch.provider = 'WEBCHAT' then return null; end if;
  if k = 'person' then
    -- our latest earlier message: "a send counts as Replied when the next message in that conversation is from them"
    select o.id into tgt from outreach_messages o
     where o.chat_id = new.chat_id and o.direction = 'out' and o.id <> new.id and o.sent_at <= new.sent_at
       and outreach__msg_kind(o.direction, o.is_auto_reply, o.is_bounce, o.event_type, o.content_type, o.sender_type) = 'ours'
     order by o.sent_at desc, o.id desc limit 1;
    if tgt is not null then
      update outreach_messages set replied_at = new.sent_at where id = tgt and (replied_at is null or replied_at > new.sent_at);
    end if;
    -- the automated step this reply is credited to (outreach_trg_message_stamp): the same answer as the step statistics
    if new.replied_to_action_id is not null then
      update outreach_messages set replied_at = new.sent_at
       where chat_id = new.chat_id and action_id = new.replied_to_action_id and direction = 'out' and sent_at <= new.sent_at
         and (replied_at is null or replied_at > new.sent_at);
    end if;
  else
    -- the email that came back: our latest email in the same thread; otherwise (the notice opened its own thread) the
    -- latest email from the same mailbox in the last 72 hours whose address the notice quotes
    select o.id into tgt from outreach_messages o
     where o.chat_id = new.chat_id and o.direction = 'out' and o.sent_at <= new.sent_at and o.bounced_at is null
     order by o.sent_at desc limit 1;
    if tgt is null and coalesce(new.text, '') <> '' then
      select o.id into tgt from outreach_messages o join outreach_chats oc on oc.id = o.chat_id
       where oc.sender_id = ch.sender_id and oc.id <> ch.id and o.direction = 'out' and o.bounced_at is null
         and o.sent_at between new.sent_at - interval '72 hours' and new.sent_at
         and oc.attendee_provider_id like '%@%' and position(lower(oc.attendee_provider_id) in lower(new.text)) > 0
       order by o.sent_at desc limit 1;
    end if;
    if tgt is not null then
      update outreach_messages set bounced_at = new.sent_at where id = tgt;
      -- the right lead is marked bounced (the notice's own "lead" is the mailer daemon)
      update outreach_lead_sender_state x set email_bounced = true, updated_at = now()
        from outreach_messages o join outreach_chats oc on oc.id = o.chat_id
       where o.id = tgt and x.lead_id = oc.lead_id and x.sender_id = oc.sender_id and not x.email_bounced;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_direction on outreach_messages;
create trigger outreach_messages_zz_direction after insert on outreach_messages
  for each row execute function outreach_trg_message_direction();

-- ============================================================================= 4. recompute (delete, reclassification)
create or replace function outreach_chat_direction_recompute(p_chat uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ch outreach_chats%rowtype;
begin
  select * into ch from outreach_chats where id = p_chat;
  if not found then return; end if;
  with k as (
    select m.sent_at, outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as mk
      from outreach_messages m where m.chat_id = p_chat
  ), agg as (
    select min(sent_at) filter (where mk in ('person', 'auto')) fi, max(sent_at) filter (where mk = 'person') li,
           max(sent_at) filter (where mk = 'auto') la, min(sent_at) filter (where mk = 'ours') fo, max(sent_at) filter (where mk = 'ours') lo
      from k
  )
  update outreach_chats c set
    first_inbound_at = case when c.provider = 'WEBCHAT' then coalesce(least(agg.fi, c.created_at), c.created_at) else agg.fi end,
    last_inbound_at = agg.li, last_auto_reply_at = agg.la, first_outbound_at = agg.fo, last_outbound_at = agg.lo
  from agg
  where c.id = p_chat
    and (c.first_inbound_at, c.last_inbound_at, c.last_auto_reply_at, c.first_outbound_at, c.last_outbound_at)
        is distinct from (case when c.provider = 'WEBCHAT' then coalesce(least(agg.fi, c.created_at), c.created_at) else agg.fi end, agg.li, agg.la, agg.fo, agg.lo);
  if ch.provider = 'WEBCHAT' then return; end if;
  with k as (
    select m.id, m.sent_at, m.action_id, m.replied_to_action_id, m.replied_at,
           outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as mk
      from outreach_messages m where m.chat_id = p_chat
  ), seq as (
    select id, mk, sent_at, action_id, replied_at, lead(mk) over w as next_mk, lead(sent_at) over w as next_at
      from k where mk in ('person', 'ours') window w as (order by sent_at, id)
  ), step as (
    select o.id, min(i.sent_at) as at_ from k o join k i on i.replied_to_action_id = o.action_id and i.mk = 'person' and i.sent_at >= o.sent_at
     where o.mk = 'ours' and o.action_id is not null group by o.id
  ), want as (
    select k.id, case when k.mk = 'ours' then least(case when s.next_mk = 'person' then s.next_at end, st.at_) end as r
      from k left join seq s on s.id = k.id left join step st on st.id = k.id
  )
  update outreach_messages m set replied_at = want.r from want where m.id = want.id and m.replied_at is distinct from want.r;
end $$;

create or replace function outreach_trg_message_direction_redo() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_chat_direction_recompute(new.chat_id);
  if tg_op = 'UPDATE' and old.chat_id is distinct from new.chat_id then perform outreach_chat_direction_recompute(old.chat_id); end if;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_direction_redo on outreach_messages;
create trigger outreach_messages_zz_direction_redo after update of intent, is_auto_reply, is_bounce, direction, sent_at, chat_id, event_type on outreach_messages
  for each row when (old.is_auto_reply is distinct from new.is_auto_reply or old.is_bounce is distinct from new.is_bounce or old.direction is distinct from new.direction
                     or old.sent_at is distinct from new.sent_at or old.chat_id is distinct from new.chat_id or old.event_type is distinct from new.event_type)
  execute function outreach_trg_message_direction_redo();

-- a deleted message (one or a whole chat's worth): one recompute per chat that still exists
create or replace function outreach_trg_message_direction_gone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid;
begin
  for cid in select distinct g.chat_id from gone g where exists (select 1 from outreach_chats c where c.id = g.chat_id) loop
    perform outreach_chat_direction_recompute(cid);
  end loop;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_direction_gone on outreach_messages;
create trigger outreach_messages_zz_direction_gone after delete on outreach_messages
  referencing old table as gone for each statement execute function outreach_trg_message_direction_gone();

-- ============================================================================= 5. ai_answering + webchat on the chat row
-- "The AI is currently answering it": Auto, not handed off, the run for their latest message is in progress or waiting
-- to send. Review / Off, an escalation, a failure or a handoff → the conversation is a person's to answer (Needs reply).
-- Website chat: the agent answers on its own until it hands off (Review mode waits for a person).
create or replace function outreach__chat_ai_answering(p_provider outreach_provider_t, p_run uuid, p_status text, p_handed_off timestamptz,
                                                       p_ai_handled boolean, p_wc_handed_off timestamptz, p_ai_mode text)
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select case
    when p_provider = 'WEBCHAT' then coalesce(p_ai_handled, false) and p_wc_handed_off is null and coalesce(p_ai_mode, 'off') not in ('off', 'review')
    when p_handed_off is not null then false
    when p_status in ('scheduled', 'sending') then true
    when p_status in ('debouncing', 'drafting') then exists (select 1 from outreach_ai_reply_runs r where r.id = p_run and r.mode = 'autopilot')
    else false end
$$;

-- The bookkeeping columns are the database's: a browser's direct `update outreach_chats` (row security allows a few
-- triage columns) never changes them.
-- Not security definer on purpose (like outreach_trg_chat_ai_guard): current_user must still be the caller.
create or replace function outreach_trg_chat_inbox_views() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') then
    new.first_inbound_at := old.first_inbound_at; new.last_inbound_at := old.last_inbound_at; new.last_auto_reply_at := old.last_auto_reply_at;
    new.first_outbound_at := old.first_outbound_at; new.last_outbound_at := old.last_outbound_at;
  end if;
  if tg_op = 'INSERT' and new.provider = 'WEBCHAT' then
    -- every website chat is in Replies: the visitor always writes first
    new.first_inbound_at := coalesce(new.first_inbound_at, new.created_at, now());
  end if;
  if tg_op = 'INSERT' or (new.ai_run_id, new.ai_run_status, new.ai_handed_off_at, new.ai_handled, new.handed_off_at, new.ai_mode)
                           is distinct from (old.ai_run_id, old.ai_run_status, old.ai_handed_off_at, old.ai_handled, old.handed_off_at, old.ai_mode) then
    new.ai_answering := outreach__chat_ai_answering(new.provider, new.ai_run_id, new.ai_run_status, new.ai_handed_off_at, new.ai_handled, new.handed_off_at, new.ai_mode);
  elsif current_user in ('authenticated', 'anon') then
    new.ai_answering := old.ai_answering;
  end if;
  return new;
end $$;
drop trigger if exists outreach_chats_zz_inbox_views on outreach_chats;
create trigger outreach_chats_zz_inbox_views before insert or update on outreach_chats
  for each row execute function outreach_trg_chat_inbox_views();

-- ============================================================================= 6. indexes
create index if not exists outreach_chats_replies_idx on outreach_chats (workspace_id, last_message_at desc, id desc)
  where first_inbound_at is not null and archived = false;
create index if not exists outreach_chats_needs_reply_idx on outreach_chats (workspace_id, last_inbound_at, id)
  where waiting_on = 'us' and archived = false;
create index if not exists outreach_messages_sent_idx on outreach_messages (workspace_id, sent_at desc, id desc) where direction = 'out';
create index if not exists outreach_messages_bounced_idx on outreach_messages (workspace_id, bounced_at desc, id desc) where bounced_at is not null;
create index if not exists outreach_actions_scheduled_idx on outreach_actions (workspace_id, scheduled_for, id) where status in ('queued', 'reserved');
create index if not exists outreach_actions_failed_idx on outreach_actions (workspace_id, executed_at desc, id desc) where status = 'failed';
create index if not exists outreach_actions_invites_idx on outreach_actions (workspace_id, executed_at desc, id desc)
  where status = 'sent' and action_type = 'invite';
create index if not exists outreach_ai_reply_runs_hold_idx on outreach_ai_reply_runs (workspace_id, scheduled_send_at, id)
  where status in ('scheduled', 'sending');

-- ============================================================================= 7. sent_items
-- One row per thing a person on the other side receives from us. `src` names the source table query:
--   message (sent)     outbound messages: not website chat, not the note of an invite (its request row stands for it),
--                      not system events, sent on or after the sender was connected to us, not bounced
--   invite (sent)      connection requests that went out (a request has no message row of its own)
--   queued (scheduled) send actions with a planned time that have not gone out (queued / reserved)
--   ai_hold (scheduled) AI replies in their hold (scheduled) or going out (sending)
--   failed (failed)    send actions that did not go out and were not retried since
--   bounce (failed)    outbound emails that came back
create or replace view outreach_sent_items with (security_invoker = true) as
select m.id, 'message'::text as src, 'sent'::text as segment, m.workspace_id, c.client_id, c.sender_id, c.lead_id, c.id as chat_id, m.id as message_id,
       m.action_id, m.ai_reply_run_id, a.enrollment_id,
       case when c.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'EMAIL' else c.provider::text end as channel,
       case when c.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'email'
            when a.action_type = 'inmail' or c.custom_attributes #>> '{linkedin,content_type}' = 'inmail' then 'inmail' else 'message' end as type,
       coalesce(a.action_type::text, 'message') as action_type,
       case m.origin when 'sequence' then 'sequence' when 'inbox_user' then 'teammate' when 'ai_draft_sent' then 'teammate' when 'ai_edited' then 'teammate'
                     when 'ai_autopilot' then 'ai' when 'external_device' then 'outside_app'
                     else case when a.action_type = 'reply' then 'teammate' when a.action_type = 'ai_reply' then 'ai' when a.id is not null then 'sequence'
                               when m.sent_by is not null then 'teammate' else 'outside_app' end end as source,
       e.sequence_id, a.node_id, nullif(a.variant_id, '') as variant_id, m.sent_by, m.origin in ('ai_draft_sent', 'ai_edited') as from_ai_draft,
       nullif(coalesce(m.content_attributes #>> '{email,subject}', m.content_attributes ->> 'subject'), '') as subject,
       left(regexp_replace(coalesce(nullif(m.text, ''), case when jsonb_array_length(coalesce(m.attachments, '[]'::jsonb)) > 0 then 'Attachment' end, ''), '\s+', ' ', 'g'), 140) as preview,
       case when m.replied_at is not null then 'replied' when m.read_at is not null then 'read' when m.delivered_at is not null then 'delivered' else 'sent' end as status,
       null::text as status_reason, m.sent_at as at, m.replied_at, m.deleted_at is not null as deleted, m.edited_at is not null as edited,
       coalesce(l.full_name, c.attendee_name) as recipient_name
  from outreach_messages m
  join outreach_chats c on c.id = m.chat_id
  join outreach_senders s on s.id = c.sender_id
  left join outreach_actions a on a.id = m.action_id
  left join outreach_enrollments e on e.id = a.enrollment_id
  left join outreach_leads l on l.id = c.lead_id
 where m.direction = 'out' and c.provider <> 'WEBCHAT' and m.event_type is null and coalesce(m.content_type, 'text') not in ('event', 'csat')
   and coalesce(m.sender_type, '') <> 'system' and m.bounced_at is null and m.sent_at >= s.created_at
   and not (m.is_invite_note and a.action_type = 'invite')
union all
select a.id, 'invite', 'sent', a.workspace_id, s.client_id, a.sender_id, a.lead_id, ic.id, nm.id, a.id, null::uuid, a.enrollment_id,
       'LINKEDIN', 'connection_request', 'invite',
       case when a.enrollment_id is not null or a.import_job_id is not null then 'sequence' else 'teammate' end,
       e.sequence_id, a.node_id, nullif(a.variant_id, ''), nullif(a.payload ->> 'created_by', '')::uuid, false, null::text,
       left(regexp_replace(coalesce(nullif(a.payload ->> 'note', ''), nullif(a.payload ->> 'text', ''), nm.text, ''), '\s+', ' ', 'g'), 140),
       case when nm.replied_at is not null
              or (nm.id is null and ic.first_inbound_at is not null and ic.first_inbound_at >= a.executed_at - interval '5 minutes'
                  and (ic.first_outbound_at is null or ic.first_inbound_at < ic.first_outbound_at)) then 'replied'
            when x.invite_accepted_at is not null and x.invite_accepted_at >= a.executed_at - interval '5 minutes' then 'accepted'
            else 'sent' end,
       null, a.executed_at, coalesce(nm.replied_at, case when nm.id is null and ic.first_inbound_at >= a.executed_at - interval '5 minutes'
                                                          and (ic.first_outbound_at is null or ic.first_inbound_at < ic.first_outbound_at) then ic.first_inbound_at end),
       false, false, l.full_name
  from outreach_actions a
  join outreach_senders s on s.id = a.sender_id
  left join outreach_enrollments e on e.id = a.enrollment_id
  left join outreach_leads l on l.id = a.lead_id
  left join outreach_lead_sender_state x on x.lead_id = a.lead_id and x.sender_id = a.sender_id
  left join lateral (select c2.id, c2.first_inbound_at, c2.first_outbound_at from outreach_chats c2
                      where c2.lead_id = a.lead_id and c2.sender_id = a.sender_id and c2.provider = 'LINKEDIN' and not coalesce(c2.is_group, false)
                      order by c2.created_at limit 1) ic on true
  left join lateral (select m2.id, m2.text, m2.replied_at from outreach_messages m2 where m2.action_id = a.id and m2.direction = 'out'
                      order by m2.sent_at limit 1) nm on true
 where a.action_type = 'invite' and a.status = 'sent' and a.executed_at is not null
   and not coalesce((a.payload ->> 'prefetch')::boolean, false) and not coalesce((a.payload ->> 'subtask')::boolean, false)
union all
select a.id, 'queued', 'scheduled', a.workspace_id, s.client_id, a.sender_id, a.lead_id,
       (select c2.id from outreach_chats c2 where c2.lead_id = a.lead_id and c2.sender_id = a.sender_id and not coalesce(c2.is_group, false)
         order by c2.last_message_at desc nulls last limit 1),
       null::uuid, a.id, null::uuid, a.enrollment_id,
       case when s.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'EMAIL' else s.provider::text end,
       case a.action_type when 'invite' then 'connection_request' when 'inmail' then 'inmail' when 'email' then 'email' else 'message' end,
       a.action_type::text,
       case when a.action_type = 'reply' then 'teammate' else 'sequence' end,
       e.sequence_id, a.node_id, nullif(a.variant_id, ''), nullif(a.payload ->> 'sent_by', '')::uuid, false, nullif(a.payload ->> 'subject', ''),
       left(regexp_replace(coalesce(nullif(a.payload ->> 'text', ''), nullif(a.payload ->> 'note', ''), nullif(a.payload ->> 'body', ''), ''), '\s+', ' ', 'g'), 140),
       case when a.status = 'reserved' then 'sending'
            when a.scheduled_for > now() - interval '2 minutes' and s.status = 'ok' and coalesce(s.paused_until, '-infinity') <= now()
                 and coalesce(e.status::text, 'active') <> 'paused' and coalesce(q.status::text, 'active') = 'active' then 'scheduled'
            else 'held' end,
       case when a.status = 'reserved' then null
            when s.status in ('credentials', 'error', 'disconnected', 'connecting') then 'sender_reconnect'
            when s.status in ('paused', 'disabled') or coalesce(s.paused_until, '-infinity') > now() then 'sender_paused'
            when e.status = 'paused' or coalesce(q.status::text, 'active') <> 'active' then 'sequence_paused'
            when a.scheduled_for > now() - interval '2 minutes' then null
            when a.decision = 'budget_deferred' then 'allowance_used'
            when a.decision = 'hourly_deferred' then 'hourly_allowance'
            else 'waiting_slot' end,
       a.scheduled_for, null::timestamptz, false, coalesce((a.payload ->> 'edited_at') is not null, false), l.full_name
  from outreach_actions a
  join outreach_senders s on s.id = a.sender_id
  left join outreach_enrollments e on e.id = a.enrollment_id
  left join outreach_sequences q on q.id = e.sequence_id
  left join outreach_leads l on l.id = a.lead_id
 where a.status in ('queued', 'reserved') and a.action_type in ('invite', 'message', 'inmail', 'email', 'new_chat', 'reply')
   and not coalesce((a.payload ->> 'prefetch')::boolean, false) and not coalesce((a.payload ->> 'subtask')::boolean, false)
union all
select r.id, 'ai_hold', 'scheduled', r.workspace_id, r.client_id, r.sender_id, r.lead_id, r.chat_id, null::uuid, r.action_id, r.id, null::uuid,
       case when r.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'EMAIL' else r.provider::text end,
       case when r.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'email' else 'message' end, 'ai_reply', 'ai',
       r.sequence_id, null::text, null::text, null::uuid, false, null::text,
       left(regexp_replace(coalesce(r.final_text, r.draft_text, ''), '\s+', ' ', 'g'), 140),
       case when r.status = 'sending' then 'sending' else 'scheduled' end,
       case when coalesce((r.timings ->> 'warmup')::boolean, false) then 'warmup_hold' end,
       coalesce(r.scheduled_send_at, r.updated_at), null::timestamptz, false, false, coalesce(l.full_name, c.attendee_name)
  from outreach_ai_reply_runs r
  join outreach_chats c on c.id = r.chat_id
  left join outreach_leads l on l.id = r.lead_id
 where r.status in ('scheduled', 'sending') and r.provider <> 'WEBCHAT'
union all
select a.id, 'failed', 'failed', a.workspace_id, s.client_id, a.sender_id, a.lead_id,
       (select c2.id from outreach_chats c2 where c2.lead_id = a.lead_id and c2.sender_id = a.sender_id and not coalesce(c2.is_group, false)
         order by c2.last_message_at desc nulls last limit 1),
       null::uuid, a.id, (select r.id from outreach_ai_reply_runs r where r.action_id = a.id limit 1), a.enrollment_id,
       case when s.provider in ('GMAIL', 'OUTLOOK', 'IMAP') then 'EMAIL' else s.provider::text end,
       case a.action_type when 'invite' then 'connection_request' when 'inmail' then 'inmail' when 'email' then 'email' else 'message' end,
       a.action_type::text,
       case when a.action_type = 'reply' then 'teammate' when a.action_type = 'ai_reply' then 'ai' else 'sequence' end,
       e.sequence_id, a.node_id, nullif(a.variant_id, ''), nullif(a.payload ->> 'sent_by', '')::uuid, false, nullif(a.payload ->> 'subject', ''),
       left(regexp_replace(coalesce(nullif(a.payload ->> 'text', ''), nullif(a.payload ->> 'note', ''), nullif(a.payload ->> 'body', ''), ''), '\s+', ' ', 'g'), 140),
       'failed', coalesce(a.error_code, a.decision), a.executed_at, null::timestamptz, false, false, l.full_name
  from outreach_actions a
  join outreach_senders s on s.id = a.sender_id
  left join outreach_enrollments e on e.id = a.enrollment_id
  left join outreach_leads l on l.id = a.lead_id
 where a.status = 'failed' and a.executed_at is not null and a.action_type in ('invite', 'message', 'inmail', 'email', 'new_chat', 'reply', 'ai_reply')
   and not coalesce((a.payload ->> 'prefetch')::boolean, false) and not coalesce((a.payload ->> 'subtask')::boolean, false)
   -- retried since (a newer attempt of the same step): not a failure anybody needs to act on
   and not (a.enrollment_id is not null and a.node_id is not null and exists (
         select 1 from outreach_actions b where b.enrollment_id = a.enrollment_id and b.node_id = a.node_id and b.id <> a.id
            and b.created_at > a.created_at and b.status in ('queued', 'reserved', 'sent')))
union all
select m.id, 'bounce', 'failed', m.workspace_id, c.client_id, c.sender_id, c.lead_id, c.id, m.id, m.action_id, m.ai_reply_run_id, a.enrollment_id,
       'EMAIL', 'email', coalesce(a.action_type::text, 'email'),
       case m.origin when 'sequence' then 'sequence' when 'inbox_user' then 'teammate' when 'ai_draft_sent' then 'teammate' when 'ai_edited' then 'teammate'
                     when 'ai_autopilot' then 'ai' when 'external_device' then 'outside_app'
                     else case when a.action_type = 'reply' then 'teammate' when a.id is not null then 'sequence' when m.sent_by is not null then 'teammate' else 'outside_app' end end,
       e.sequence_id, a.node_id, nullif(a.variant_id, ''), m.sent_by, m.origin in ('ai_draft_sent', 'ai_edited'),
       nullif(m.content_attributes #>> '{email,subject}', ''),
       left(regexp_replace(coalesce(nullif(m.text, ''), ''), '\s+', ' ', 'g'), 140),
       'bounced', 'email_bounced', m.bounced_at, null::timestamptz, m.deleted_at is not null, false, coalesce(l.full_name, c.attendee_name)
  from outreach_messages m
  join outreach_chats c on c.id = m.chat_id
  left join outreach_actions a on a.id = m.action_id
  left join outreach_enrollments e on e.id = a.enrollment_id
  left join outreach_leads l on l.id = c.lead_id
 where m.bounced_at is not null and m.direction = 'out';

comment on view outreach_sent_items is 'Inbox Sent view (075): one row per send, segments sent | scheduled | failed. security_invoker: callers see what row security lets them see.';
revoke all on outreach_sent_items from public, anon;
grant select on outreach_sent_items to authenticated, service_role;

-- ============================================================================= 8. paging helpers (one source at a time)
-- Each source is read with the same (at, id) cursor and limit, then the pages are merged: paging stays an index range
-- scan at any depth. The constant `src` filter turns every other branch of the view into a one-time-false filter.
create or replace function outreach__sent_page_desc(p_ws uuid, p_src text, p_from timestamptz, p_to timestamptz, p_at timestamptz, p_id uuid, p_lim int,
  p_senders uuid[], p_client uuid, p_channel text, p_source text, p_sequence uuid, p_type text, p_replied boolean, p_search text, p_lead uuid)
returns setof outreach_sent_items language sql stable set search_path = public, extensions as $$
  select v.* from outreach_sent_items v
   where v.workspace_id = p_ws and v.src = p_src
     and (p_from is null or v.at >= p_from) and (p_to is null or v.at < p_to)
     and (p_at is null or v.at < p_at or (v.at = p_at and v.id < p_id))
     and (p_senders is null or v.sender_id = any(p_senders)) and (p_client is null or v.client_id = p_client)
     and (p_channel is null or v.channel = p_channel) and (p_source is null or v.source = p_source)
     and (p_sequence is null or v.sequence_id = p_sequence) and (p_type is null or v.type = p_type)
     and (p_replied is null or (v.status = 'replied') = p_replied) and (p_lead is null or v.lead_id = p_lead)
     and (p_search is null or v.recipient_name ilike '%' || p_search || '%' or v.preview ilike '%' || p_search || '%' or v.subject ilike '%' || p_search || '%')
     and outreach_client_visible(p_ws, v.client_id)
   order by v.at desc, v.id desc limit p_lim
$$;

create or replace function outreach__sent_page_asc(p_ws uuid, p_src text, p_at timestamptz, p_id uuid, p_lim int,
  p_senders uuid[], p_client uuid, p_channel text, p_source text, p_sequence uuid, p_type text, p_search text, p_lead uuid)
returns setof outreach_sent_items language sql stable set search_path = public, extensions as $$
  select v.* from outreach_sent_items v
   where v.workspace_id = p_ws and v.src = p_src
     and (p_at is null or v.at > p_at or (v.at = p_at and v.id > p_id))
     and (p_senders is null or v.sender_id = any(p_senders)) and (p_client is null or v.client_id = p_client)
     and (p_channel is null or v.channel = p_channel) and (p_source is null or v.source = p_source)
     and (p_sequence is null or v.sequence_id = p_sequence) and (p_type is null or v.type = p_type) and (p_lead is null or v.lead_id = p_lead)
     and (p_search is null or v.recipient_name ilike '%' || p_search || '%' or v.preview ilike '%' || p_search || '%' or v.subject ilike '%' || p_search || '%')
     and outreach_client_visible(p_ws, v.client_id)
   order by v.at asc, v.id asc limit p_lim
$$;
revoke execute on function outreach__sent_page_desc(uuid, text, timestamptz, timestamptz, timestamptz, uuid, int, uuid[], uuid, text, text, uuid, text, boolean, text, uuid) from public, anon, authenticated;
revoke execute on function outreach__sent_page_asc(uuid, text, timestamptz, uuid, int, uuid[], uuid, text, text, uuid, text, text, uuid) from public, anon, authenticated;

-- Held reasons: the same causes and wording as "Why isn't it sending" (outreach__sender_causes), else the short reason.
create or replace function outreach__sent_status_text(p_status text, p_reason text, p_sender uuid, p_action_type text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare causes jsonb; d text;
begin
  if p_status = 'failed' then return outreach_reason_text(p_reason); end if;
  if p_status = 'bounced' then return 'The email address bounced'; end if;
  if p_status = 'scheduled' and p_reason = 'warmup_hold' then return 'Warm-up: waits so you can check it'; end if;
  if p_status <> 'held' then return null; end if;
  if p_reason in ('sender_reconnect', 'sender_paused', 'waiting_slot') and p_sender is not null then
    causes := outreach__sender_causes(p_sender, array[coalesce(nullif(p_action_type, 'reply'), 'message')]);
    select x ->> 'detail' into d from jsonb_array_elements(causes) x where (x ->> 'blocking')::boolean limit 1;
    if d is not null then return d; end if;
  end if;
  return case p_reason
    when 'sender_reconnect' then 'The sender needs reconnecting'
    when 'sender_paused' then 'The sender is paused'
    when 'sequence_paused' then 'The sequence is paused'
    when 'allowance_used' then 'Today''s allowance was used; it goes out in the next slot'
    when 'hourly_allowance' then 'This hour''s allowance was used; moved to the next hour'
    else 'Outside working hours or waiting for the next free slot' end;
end $$;
revoke execute on function outreach__sent_status_text(text, text, uuid, text) from public, anon, authenticated;

-- Workspace setting "Show Sent to clients" (settings.inbox_show_sent_to_clients, default on): client viewers get Sent read-only.
create or replace function outreach__sent_allowed(p_ws uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select outreach_is_service() or coalesce(outreach_role_in(p_ws)::text, '') <> 'client_viewer'
      or coalesce((select (w.settings ->> 'inbox_show_sent_to_clients')::boolean from outreach_workspaces w where w.id = p_ws), true)
$$;
revoke execute on function outreach__sent_allowed(uuid) from public, anon, authenticated;

-- ============================================================================= 9. outreach_inbox_sent_list
-- p_segment: sent (default, newest first, last 7 days) | scheduled (soonest first, all upcoming) | failed (newest first, last 7 days)
-- p_filters: { sender_ids: [uuid], my_senders: bool, client_id, channel: LINKEDIN|EMAIL|WHATSAPP|INSTAGRAM,
--              source: sequence|teammate|ai|outside_app, sequence_id, type: connection_request|message|inmail|email,
--              replied: bool (Sent only), from, to (ISO; max 90 days apart), search, lead_id }
-- p_cursor: { at, id } from the previous page's next_cursor. Limit 50 by default, 100 at most.
create or replace function outreach_inbox_sent_list(p_ws uuid, p_segment text default 'sent', p_filters jsonb default '{}'::jsonb,
                                                    p_cursor jsonb default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare seg text := coalesce(nullif(p_segment, ''), 'sent'); f jsonb := coalesce(p_filters, '{}'::jsonb);
        lim int := least(greatest(coalesce(p_limit, 50), 1), 100); c_at timestamptz; c_id uuid;
        v_from timestamptz; v_to timestamptz; v_senders uuid[]; v_client uuid; v_channel text; v_source text; v_sequence uuid; v_type text;
        v_replied boolean; v_search text; v_lead uuid; v_mine uuid[]; res jsonb; nxt jsonb; n int; pg outreach_sent_items[];
begin
  perform outreach_require(p_ws, 'client_viewer');
  if not outreach__sent_allowed(p_ws) then raise exception 'E_FORBIDDEN: Sent is not shared with client viewers in this workspace'; end if;
  if seg not in ('sent', 'scheduled', 'failed') then raise exception 'E_PAYLOAD_INVALID: segment must be sent, scheduled or failed'; end if;
  if jsonb_typeof(f) <> 'object' then raise exception 'E_PAYLOAD_INVALID: filters must be an object'; end if;

  if p_cursor is not null and jsonb_typeof(p_cursor) = 'object' and p_cursor ? 'at' then
    begin c_at := (p_cursor ->> 'at')::timestamptz; c_id := (p_cursor ->> 'id')::uuid;
    exception when others then raise exception 'E_PAYLOAD_INVALID: cursor'; end;
  end if;
  begin
    v_client := nullif(f ->> 'client_id', '')::uuid; v_sequence := nullif(f ->> 'sequence_id', '')::uuid; v_lead := nullif(f ->> 'lead_id', '')::uuid;
    if jsonb_typeof(f -> 'sender_ids') = 'array' and jsonb_array_length(f -> 'sender_ids') > 0 then
      v_senders := array(select jsonb_array_elements_text(f -> 'sender_ids'))::uuid[];
    end if;
    v_from := nullif(f ->> 'from', '')::timestamptz; v_to := nullif(f ->> 'to', '')::timestamptz;
  exception when others then raise exception 'E_PAYLOAD_INVALID: filters'; end;
  v_channel := nullif(upper(f ->> 'channel'), ''); v_source := nullif(f ->> 'source', ''); v_type := nullif(f ->> 'type', '');
  v_replied := case when f ? 'replied' and jsonb_typeof(f -> 'replied') = 'boolean' then (f ->> 'replied')::boolean end;
  v_search := nullif(btrim(replace(replace(coalesce(f ->> 'search', ''), '%', ''), '_', ' ')), '');
  if v_search is not null and length(v_search) < 2 then v_search := null; end if;
  if v_channel is not null and v_channel not in ('LINKEDIN', 'EMAIL', 'WHATSAPP', 'INSTAGRAM') then raise exception 'E_PAYLOAD_INVALID: channel'; end if;
  if v_source is not null and v_source not in ('sequence', 'teammate', 'ai', 'outside_app') then raise exception 'E_PAYLOAD_INVALID: source'; end if;
  if v_type is not null and v_type not in ('connection_request', 'message', 'inmail', 'email') then raise exception 'E_PAYLOAD_INVALID: type'; end if;
  if coalesce((f ->> 'my_senders')::boolean, false) then
    v_mine := array(select s.id from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null
                      and (s.owner_user_id = auth.uid() or lower(s.owner_email::text) = lower((select m.email::text from outreach_members m where m.workspace_id = p_ws and m.user_id = auth.uid()))));
    v_senders := case when v_senders is null then v_mine else array(select unnest(v_senders) intersect select unnest(v_mine)) end;
    if coalesce(array_length(v_senders, 1), 0) = 0 then v_senders := array['00000000-0000-0000-0000-000000000000'::uuid]; end if;
  end if;

  if seg in ('sent', 'failed') then
    v_to := coalesce(v_to, now() + interval '1 minute');
    v_from := coalesce(v_from, v_to - interval '7 days');
    if v_from > v_to then raise exception 'E_PAYLOAD_INVALID: from is after to'; end if;
    if v_to - v_from > interval '90 days 1 minute' then raise exception 'E_PAYLOAD_INVALID: the date range is limited to 90 days per query'; end if;
  end if;

  -- one page per source (same cursor, limit + 1), merged and cut to the limit; the extra row says whether there is more
  if seg = 'sent' then
    pg := array(select x::outreach_sent_items from (
            select * from outreach__sent_page_desc(p_ws, 'message', v_from, v_to, c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, v_replied, v_search, v_lead)
            union all
            select * from outreach__sent_page_desc(p_ws, 'invite', v_from, v_to, c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, v_replied, v_search, v_lead)
             where v_channel is null or v_channel = 'LINKEDIN') x
          order by x.at desc, x.id desc limit lim + 1);
  elsif seg = 'failed' then
    pg := array(select x::outreach_sent_items from (
            select * from outreach__sent_page_desc(p_ws, 'failed', v_from, v_to, c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, null, v_search, v_lead)
            union all
            select * from outreach__sent_page_desc(p_ws, 'bounce', v_from, v_to, c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, null, v_search, v_lead)
             where v_channel is null or v_channel = 'EMAIL') x
          order by x.at desc, x.id desc limit lim + 1);
  else
    pg := array(select x::outreach_sent_items from (
            select * from outreach__sent_page_asc(p_ws, 'queued', c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, v_search, v_lead)
            union all
            select * from outreach__sent_page_asc(p_ws, 'ai_hold', c_at, c_id, lim + 1, v_senders, v_client, v_channel, v_source, v_sequence, v_type, v_search, v_lead)
             where v_source is null or v_source = 'ai') x
          order by x.at asc, x.id asc limit lim + 1);
  end if;
  n := coalesce(array_length(pg, 1), 0);
  if n > lim then nxt := jsonb_build_object('at', (pg[lim]).at, 'id', (pg[lim]).id); end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id, 'src', p.src, 'segment', p.segment, 'at', p.at, 'status', p.status, 'status_reason', p.status_reason,
           'status_text', outreach__sent_status_text(p.status, p.status_reason, p.sender_id, p.action_type),
           'channel', p.channel, 'type', p.type, 'action_type', p.action_type, 'source', p.source, 'from_ai_draft', p.from_ai_draft,
           'subject', p.subject, 'preview', p.preview,
           'body', left(coalesce(mm.text, aa.payload ->> 'text', aa.payload ->> 'note', aa.payload ->> 'body', rr.final_text, rr.draft_text), 8000),
           'deleted', p.deleted, 'edited', p.edited, 'replied_at', p.replied_at,
           'chat_id', p.chat_id, 'message_id', p.message_id, 'action_id', p.action_id, 'ai_reply_run_id', p.ai_reply_run_id, 'enrollment_id', p.enrollment_id,
           'enrollment_status', en.status, 'recoverable', en.status = 'failed',
           'lead', case when p.lead_id is not null or p.recipient_name is not null then jsonb_build_object('id', p.lead_id, 'name', coalesce(ld.full_name, p.recipient_name),
                     'company', ld.company, 'headline', ld.headline, 'picture_url', coalesce(ld.picture_url, ch.attendee_picture_url)) end,
           'sender', jsonb_build_object('id', p.sender_id, 'name', sd.display_name, 'provider', sd.provider, 'picture_url', sd.picture_url, 'status', sd.status,
                     'identifier', coalesce(sd.public_identifier, sd.owner_email::text)),
           'sequence', case when p.sequence_id is not null then jsonb_build_object('id', p.sequence_id, 'name', sq.name, 'status', sq.status) end,
           'step', case when p.node_id is not null then jsonb_build_object('node_id', p.node_id,
                     'number', (outreach_graph_step_numbers(g.graph) ->> p.node_id)::int,
                     'label', coalesce(g.graph -> 'nodes' -> p.node_id ->> 'label', initcap(replace(coalesce(g.graph -> 'nodes' -> p.node_id ->> 'type', p.action_type), '_', ' '))),
                     'variant', p.variant_id,
                     'variant_label', (select x ->> 'label' from jsonb_array_elements(coalesce(g.graph -> 'nodes' -> p.node_id -> 'config' -> 'variants', '[]'::jsonb)) x where x ->> 'id' = p.variant_id)) end,
           'sent_by', case when p.sent_by is not null then jsonb_build_object('id', p.sent_by, 'name', coalesce(mem.display_name, mem.email::text)) end
         ) order by p.ordinality), '[]'::jsonb)
    into res
    from unnest(pg[1:lim]) with ordinality as p
    left join outreach_leads ld on ld.id = p.lead_id
    left join outreach_chats ch on ch.id = p.chat_id
    left join outreach_senders sd on sd.id = p.sender_id
    left join outreach_sequences sq on sq.id = p.sequence_id
    left join outreach_enrollments en on en.id = p.enrollment_id
    left join outreach_members mem on mem.workspace_id = p.workspace_id and mem.user_id = p.sent_by
    left join outreach_messages mm on mm.id = p.message_id
    left join outreach_actions aa on aa.id = p.action_id and p.message_id is null
    left join outreach_ai_reply_runs rr on rr.id = p.ai_reply_run_id and p.src = 'ai_hold'
    left join lateral (select coalesce((select v.graph from outreach_sequence_versions v where v.sequence_id = en.sequence_id and v.version = en.pinned_version), sq.graph) as graph) g on p.node_id is not null;

  return jsonb_build_object('segment', seg, 'items', res, 'next_cursor', nxt,
                            'range', case when seg <> 'scheduled' then jsonb_build_object('from', v_from, 'to', v_to) end);
end $$;

-- ============================================================================= 10. outreach_inbox_counts
-- { replies_unread: unread conversations, counted as the sidebar Inbox badge counts them (dashboard.unread),
--   needs_reply: the Needs reply chip under the same filters as the list (assigned_to, sender_id, client_id, provider),
--   scheduled: sends waiting to go out, failed: failed sends in the last 7 days nobody has acted on }
-- Failed "acted on": the enrollment is no longer failed (retried, skipped, removed) or a newer attempt went out; a bounce
-- once the lead's address was changed (or the lead was marked do-not-contact). Client viewers without Sent get 0 for scheduled / failed.
create or replace function outreach_inbox_counts(p_ws uuid, p_filters jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f jsonb := coalesce(p_filters, '{}'::jsonb); v_assigned uuid; v_sender uuid; v_client uuid; v_provider text;
        unread int; needs int; sched int := 0; failed int := 0; since timestamptz := now() - interval '7 days';
begin
  perform outreach_require(p_ws, 'client_viewer');
  begin
    v_assigned := nullif(f ->> 'assigned_to', '')::uuid; v_sender := nullif(f ->> 'sender_id', '')::uuid; v_client := nullif(f ->> 'client_id', '')::uuid;
  exception when others then raise exception 'E_PAYLOAD_INVALID: filters'; end;
  v_provider := nullif(f ->> 'provider', '');

  select count(*) into unread from outreach_chats c
   where c.workspace_id = p_ws and c.unread and not c.archived and outreach_client_visible(p_ws, c.client_id);
  select count(*) into needs from outreach_chats c
   where c.workspace_id = p_ws and c.waiting_on = 'us' and c.archived = false and coalesce(c.status, 'open') not in ('resolved', 'snoozed')
     and not c.ai_answering and outreach_client_visible(p_ws, c.client_id)
     and (v_assigned is null or c.assigned_to = v_assigned) and (v_sender is null or c.sender_id = v_sender)
     and (v_client is null or c.client_id = v_client) and (v_provider is null or c.provider::text = v_provider);
  if outreach__sent_allowed(p_ws) then
    select count(*) into sched from outreach_sent_items v
     where v.workspace_id = p_ws and v.src in ('queued', 'ai_hold') and outreach_client_visible(p_ws, v.client_id);
    select count(*) into failed from outreach_sent_items v
      left join outreach_enrollments e on e.id = v.enrollment_id
      left join outreach_leads l on l.id = v.lead_id
      left join outreach_chats c on c.id = v.chat_id
     where v.workspace_id = p_ws and v.src in ('failed', 'bounce') and v.at >= since and outreach_client_visible(p_ws, v.client_id)
       and case when v.src = 'bounce' then l.id is null or (not coalesce(l.do_not_contact, false)
                       and lower(coalesce(c.attendee_provider_id, '')) in (lower(coalesce(l.email_work::text, '')), lower(coalesce(l.email_personal::text, ''))))
                else v.enrollment_id is null or e.status = 'failed' end;
  end if;
  return jsonb_build_object('replies_unread', unread, 'needs_reply', needs, 'scheduled', sched, 'failed', failed, 'show_sent', outreach__sent_allowed(p_ws));
end $$;

-- ============================================================================= 11. backfill (batched by workspace)
create or replace function outreach_inbox_backfill(p_ws uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w uuid; nws int := 0; nchats int := 0; nmsg int := 0; k int;
begin
  if not outreach_is_service() and current_user not in ('postgres', 'supabase_admin') then raise exception 'E_FORBIDDEN'; end if;
  for w in select id from outreach_workspaces where p_ws is null or id = p_ws order by created_at loop
    nws := nws + 1;
    -- classification of existing inbound mail / out-of-office messages
    update outreach_messages m set is_bounce = true
      from outreach_chats c
     where c.id = m.chat_id and m.workspace_id = w and m.direction = 'in' and not m.is_bounce and c.provider in ('GMAIL', 'OUTLOOK', 'IMAP')
       and (lower(coalesce(m.content_attributes #>> '{email,from,email}', m.content_attributes #>> '{email,from,identifier}', m.sender_identifier, '')) || ' '
            || coalesce(m.content_attributes #>> '{email,subject}', '')) ~* '(mailer-daemon|postmaster|delivery (status )?notification|undeliverable|delivery failure|mail delivery failed|returned mail)';
    update outreach_messages m set is_auto_reply = true
      from outreach_chats c
     where c.id = m.chat_id and m.workspace_id = w and m.direction = 'in' and not m.is_auto_reply and not m.is_bounce
       and (m.intent = 'ooo' or (c.provider in ('GMAIL', 'OUTLOOK', 'IMAP') and coalesce(m.content_attributes #>> '{email,subject}', '')
            ~* '^\s*(auto(matic)?[ -]?(reply|response|antwort)|autoreply|out of (the )?office|ooo\M|abwesenheit|r[ée]ponse automatique|respuesta autom[áa]tica|risposta automatica|absence)'));
    -- chat timestamps
    with k2 as (
      select m.chat_id, m.sent_at, outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as mk
        from outreach_messages m where m.workspace_id = w
    ), agg as (
      select chat_id, min(sent_at) filter (where mk in ('person', 'auto')) fi, max(sent_at) filter (where mk = 'person') li,
             max(sent_at) filter (where mk = 'auto') la, min(sent_at) filter (where mk = 'ours') fo, max(sent_at) filter (where mk = 'ours') lo
        from k2 group by chat_id
    ), want as (
      select c.id, case when c.provider = 'WEBCHAT' then coalesce(least(a.fi, c.created_at), c.created_at) else a.fi end fi, a.li, a.la, a.fo, a.lo
        from outreach_chats c left join agg a on a.chat_id = c.id where c.workspace_id = w
    )
    update outreach_chats c set first_inbound_at = want.fi, last_inbound_at = want.li, last_auto_reply_at = want.la, first_outbound_at = want.fo, last_outbound_at = want.lo,
           ai_answering = outreach__chat_ai_answering(c.provider, c.ai_run_id, c.ai_run_status, c.ai_handed_off_at, c.ai_handled, c.handed_off_at, c.ai_mode)
      from want
     where c.id = want.id
       and ((c.first_inbound_at, c.last_inbound_at, c.last_auto_reply_at, c.first_outbound_at, c.last_outbound_at) is distinct from (want.fi, want.li, want.la, want.fo, want.lo)
            or c.ai_answering is distinct from outreach__chat_ai_answering(c.provider, c.ai_run_id, c.ai_run_status, c.ai_handed_off_at, c.ai_handled, c.handed_off_at, c.ai_mode));
    get diagnostics k = row_count; nchats := nchats + k;
    -- replied_at on our messages (window rule + the step-attribution rule, as outreach_chat_direction_recompute)
    with k3 as (
      select m.id, m.chat_id, m.sent_at, m.action_id, m.replied_to_action_id,
             outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as mk
        from outreach_messages m join outreach_chats c on c.id = m.chat_id where m.workspace_id = w and c.provider <> 'WEBCHAT'
    ), seq as (
      select id, mk, lead(mk) over wn as next_mk, lead(sent_at) over wn as next_at
        from k3 where mk in ('person', 'ours') window wn as (partition by chat_id order by sent_at, id)
    ), step as (
      select o.id, min(i.sent_at) as at_ from k3 o join k3 i on i.chat_id = o.chat_id and i.replied_to_action_id = o.action_id and i.mk = 'person' and i.sent_at >= o.sent_at
       where o.mk = 'ours' and o.action_id is not null group by o.id
    ), want as (
      select k3.id, least(case when s.next_mk = 'person' then s.next_at end, st.at_) as r
        from k3 left join seq s on s.id = k3.id left join step st on st.id = k3.id where k3.mk = 'ours'
    )
    update outreach_messages m set replied_at = want.r from want where m.id = want.id and m.replied_at is distinct from want.r;
    get diagnostics k = row_count; nmsg := nmsg + k;
    -- bounced_at on the email each bounce notice answers (same thread)
    update outreach_messages o set bounced_at = b.sent_at
      from (select distinct on (t.id) t.id, bm.sent_at
              from outreach_messages bm
              join lateral (select o2.id from outreach_messages o2 where o2.chat_id = bm.chat_id and o2.direction = 'out' and o2.sent_at <= bm.sent_at
                             order by o2.sent_at desc limit 1) t on true
             where bm.workspace_id = w and bm.is_bounce
             order by t.id, bm.sent_at) b
     where o.id = b.id and o.bounced_at is null;
  end loop;
  return jsonb_build_object('workspaces', nws, 'chats_updated', nchats, 'messages_updated', nmsg);
end $$;
revoke execute on function outreach_inbox_backfill(uuid) from public, anon, authenticated;
grant execute on function outreach_inbox_backfill(uuid) to service_role;

select outreach_inbox_backfill();

-- ============================================================================= 12. grants
revoke execute on function outreach__msg_kind(outreach_direction_t, boolean, boolean, smallint, text, text) from public, anon;
grant execute on function outreach__msg_kind(outreach_direction_t, boolean, boolean, smallint, text, text) to authenticated, service_role;
revoke execute on function outreach__chat_ai_answering(outreach_provider_t, uuid, text, timestamptz, boolean, timestamptz, text) from public, anon;
-- the chat trigger runs as the caller (a teammate's triage update): it needs this helper
grant execute on function outreach__chat_ai_answering(outreach_provider_t, uuid, text, timestamptz, boolean, timestamptz, text) to authenticated, service_role;
revoke execute on function outreach_chat_direction_recompute(uuid) from public, anon, authenticated;
grant execute on function outreach_chat_direction_recompute(uuid) to service_role;
revoke execute on function outreach_inbox_sent_list(uuid, text, jsonb, jsonb, int) from public, anon;
revoke execute on function outreach_inbox_counts(uuid, jsonb) from public, anon;
grant execute on function outreach_inbox_sent_list(uuid, text, jsonb, jsonb, int) to authenticated, service_role;
grant execute on function outreach_inbox_counts(uuid, jsonb) to authenticated, service_role;
-- trigger functions are never called directly
revoke execute on function outreach_trg_message_kind() from public, anon, authenticated;
revoke execute on function outreach_trg_message_direction() from public, anon, authenticated;
revoke execute on function outreach_trg_message_direction_redo() from public, anon, authenticated;
revoke execute on function outreach_trg_message_direction_gone() from public, anon, authenticated;
revoke execute on function outreach_trg_chat_inbox_views() from public, anon;


-- ============================================================================= 13. public API (outreach-api)
-- GET /v1/sent and the counts go through outreach_api_dispatch (the key acts as a member); /v1/threads/{id} messages carry
-- the Sent status; /v1/threads?waiting_on_us uses the same rule as Needs reply / inbox_pending (a person's message is
-- the latest; auto-replies and bounces no longer count). Live definitions copied, then patched.
CREATE OR REPLACE FUNCTION public.outreach_api_dispatch(p_key_id uuid, p_fn text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare k outreach_api_keys%rowtype; pr record; call text := ''; i int; an text; at oid; tcat "char"; tname text; res jsonb; em text;
  allowed text[] := array['upsert_lead','bulk_leads','lead_timeline','request_enrichment','render_context','enroll_preview','enroll_leads','pause_enrollment','resume_enrollment','exit_enrollment',
    'enrollment_recover','failed_leads','failed_summary','set_sequence_status','project_sequence','why_not_sending','set_intent','assign_chat','sender_today','sender_insights',
    'report_overview','report_funnel','report_sequence','report_sequences','report_sender','report_senders','report_client','report_clients','report_intents','report_cost','report_reply_threads',
    'ab_results','metric_definitions','add_suppressions','complete_task','replay_delivery','create_webhook','delete_webhook','set_webhook_active',
    'api_leads','api_lead','api_sequences','api_sequence','api_enrollments','api_threads','api_thread','api_senders','api_sender','api_webhooks','api_deliveries','api_context',
    'inbox_sent_list','inbox_counts'];
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if not (p_fn = any(allowed)) then raise exception 'E_NOT_FOUND: unknown operation %', p_fn; end if;
  select * into k from outreach_api_keys where id = p_key_id and revoked_at is null;
  if not found then raise exception 'E_FORBIDDEN: key revoked'; end if;
  select email into em from auth.users where id = k.user_id;

  select p.oid, p.proname, p.proargnames, p.proargtypes, p.pronargs, p.proretset, p.prorettype into pr
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_' || p_fn limit 1;
  if pr.oid is null then raise exception 'E_NOT_FOUND: operation % is not available', p_fn; end if;
  for i in 1..pr.pronargs loop
    an := pr.proargnames[i]; at := pr.proargtypes[i - 1];
    if not (p_args ? an) and not (p_args ? regexp_replace(an, '^p_', '')) then continue; end if;
    if not (p_args ? an) then p_args := p_args || jsonb_build_object(an, p_args->regexp_replace(an, '^p_', '')); end if;
    select t.typcategory, format_type(t.oid, null) into tcat, tname from pg_type t where t.oid = at;
    call := call || case when call = '' then '' else ', ' end || quote_ident(an) || ' => ' ||
      case when tname = 'jsonb' then format('($1->%L)', an)
           when tcat = 'A' then format('(select case when jsonb_typeof($1->%1$L) = ''array'' then array(select jsonb_array_elements_text($1->%1$L))::%2$s end)', an, tname)
           else format('nullif($1->>%L, '''')::%s', an, tname) end;
  end loop;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', k.user_id, 'role', 'authenticated', 'email', em, 'aud', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', k.user_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.email', coalesce(em,''), true);
  perform set_config('outreach.key_role', k.role::text, true);
  perform set_config('outreach.key_clients', array_to_string(k.client_ids, ','), true);

  if pr.proretset or exists (select 1 from pg_type t where t.oid = pr.prorettype and t.typtype = 'c') or pr.prorettype = 'record'::regtype then
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from public.%I(%s) t', pr.proname, call) into res using p_args;
  else
    execute format('select to_jsonb(public.%I(%s))', pr.proname, call) into res using p_args;
  end if;
  -- leave no trace of the impersonation for the rest of the transaction
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claim.email', '', true); perform set_config('outreach.key_role', '', true); perform set_config('outreach.key_clients', '', true);
  return res;
end $function$;

CREATE OR REPLACE FUNCTION public.outreach_api_thread(p_chat uuid, p_limit integer DEFAULT 100)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return to_jsonb(c) - 'workspace_id' || jsonb_build_object(
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'direction', m.direction, 'text', m.text, 'sent_at', m.sent_at, 'intent', m.intent, 'summary', m.summary, 'is_first_reply', m.is_first_reply,
                   'opens', m.opens, 'clicks', m.clicks,
                   'status', case when m.direction = 'out' then case when m.bounced_at is not null then 'bounced' when m.replied_at is not null then 'replied' when m.read_at is not null then 'read' when m.delivered_at is not null then 'delivered' else 'sent' end end,
                   'replied_at', m.replied_at, 'is_auto_reply', m.is_auto_reply, 'is_bounce', m.is_bounce, 'attribution', (select to_jsonb(t) - 'message_id' from outreach_thread_attribution(p_chat) t where t.message_id = m.id)) order by m.sent_at), '[]'::jsonb)
                   from (select * from outreach_messages where chat_id = p_chat and deleted_at is null order by sent_at desc limit least(greatest(p_limit,1),500)) m));
end $function$;

CREATE OR REPLACE FUNCTION public.outreach_api_threads(p_ws uuid, p_filters jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare res jsonb; total bigint; lim int := least(greatest(coalesce(p_limit,50),1),200); f jsonb := coalesce(p_filters,'{}'::jsonb);
begin
  perform outreach_require(p_ws, 'client_viewer');
  with base as (
    select c.* from outreach_chats c
     where c.workspace_id = p_ws and outreach_client_visible(p_ws, c.client_id)
       and ((f->>'intent') is null or c.intent::text = f->>'intent') and ((f->>'sender_id') is null or c.sender_id = (f->>'sender_id')::uuid)
       and ((f->>'lead_id') is null or c.lead_id = (f->>'lead_id')::uuid) and ((f->>'unread') is null or c.unread = (f->>'unread')::boolean)
       and ((f->>'waiting_on_us') is null or (coalesce(c.waiting_on, '') = 'us') = (f->>'waiting_on_us')::boolean) and ((f->>'archived') is null or c.archived = (f->>'archived')::boolean)
       and ((f->>'sequence_id') is null or c.id in (select outreach_sequence_chat_ids((f->>'sequence_id')::uuid)))
       and ((f->>'since') is null or c.last_message_at >= (f->>'since')::timestamptz))
  select (select count(*) from base), coalesce((select jsonb_agg(to_jsonb(x) - 'workspace_id' order by x.last_message_at desc nulls last) from (select * from base order by last_message_at desc nulls last limit lim offset greatest(coalesce(p_offset,0),0)) x), '[]'::jsonb)
    into total, res;
  return jsonb_build_object('data', res, 'total', total, 'limit', lim, 'offset', greatest(coalesce(p_offset,0),0), 'has_more', total > greatest(coalesce(p_offset,0),0) + lim);
end $function$;
