-- 049_webchat_schema.sql — Web chat (web-chat-PRD.md §10): website inboxes, visitors, page views, canned responses,
-- campaigns, blocks, settings history, AI turns, continuity emails, agent presence; the chat / message columns the
-- unified inbox needs for webchat threads; Realtime broadcast to the widget from triggers.
-- Requires 048 (provider WEBCHAT). Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/049_webchat_schema.sql
--
-- Model (PRD §3 mapped onto what exists):
--   webchat_inboxes      -> outreach_webchat_inboxes, 1:1 with a synthetic outreach_senders row (provider WEBCHAT, status ok)
--   chats                -> outreach_chats on that sender (unipile_chat_id = 'webchat:' || chat id); new columns below
--   messages             -> outreach_messages (direction in = visitor, out = agent/bot); content_type / content_attributes / sender_type
--   private notes        -> the existing outreach_chat_notes (046); no is_private column duplicated here
--   canned responses     -> outreach_webchat_canned_responses (workspace-wide, optional owner for personal ones)
--   AI knowledge         -> the existing outreach_knowledge_sources / _chunks (crawl + files); an inbox picks source ids
--   AI pool              -> outreach_ai_calls rows with purpose 'webchat_answer'; outreach__ai_pool counts them (below)
-- Visitor-side access never touches these tables directly: the public edge function calls SECURITY DEFINER functions
-- that take explicit ids (051), after checking website token + Origin + visitor token itself.

-- ---------------------------------------------------------------------------------------------------------------
-- Website inboxes
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists outreach_webchat_inboxes (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  client_id          uuid references outreach_clients(id) on delete set null,
  sender_id          uuid not null references outreach_senders(id) on delete cascade,   -- the synthetic WEBCHAT sender
  name               text not null,
  website_token      text not null unique,                 -- public identifier in the snippet
  hmac_token         text not null,                        -- identity validation secret (shown to the owner in settings)
  enforce_identity   boolean not null default false,
  allowed_domains    text[] not null default '{}',         -- bare hosts; '*.example.com' allows subdomains; 'localhost' opt-in
  settings           jsonb not null default '{}',          -- every §12 setting; merged over outreach_webchat_default_settings()
  config_version     integer not null default 1,           -- bumped on every settings change ("Publish now" busts the cache)
  ai_enabled         boolean not null default false,
  reply_mailbox_id   uuid references outreach_senders(id) on delete set null,   -- a GMAIL/OUTLOOK/IMAP sender: continuity emails go out from it
  business_hours     jsonb not null default '{}',          -- {tz, weekly:{mon:[["09:00","18:00"]],...}, holidays:["2026-12-25"]}
  is_active          boolean not null default true,
  installed_origins  jsonb not null default '{}',          -- {"https://example.com": "2026-09-30T10:00:00Z"} first/last widget-config hit per origin
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);
create index if not exists outreach_webchat_inboxes_ws_idx on outreach_webchat_inboxes(workspace_id) where deleted_at is null;
create unique index if not exists outreach_webchat_inboxes_sender_uq on outreach_webchat_inboxes(sender_id);

create table if not exists outreach_webchat_inbox_members (
  inbox_id         uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  user_id          uuid not null references auth.users(id) on delete cascade,
  auto_assign      boolean not null default true,
  last_assigned_at timestamptz,
  created_at       timestamptz not null default now(),
  primary key (inbox_id, user_id)
);

-- Agent availability (PRD §5.7): online / busy / offline; auto-offline after 10 min without a ping (computed at read time).
create table if not exists outreach_webchat_agent_presence (
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  state        text not null default 'online' check (state in ('online','busy','offline')),
  last_seen_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- Visitors
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists outreach_webchat_visitors (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  inbox_id           uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  identifier         text,                                 -- from setUser
  identity_verified  boolean not null default false,       -- HMAC checked
  name               text,
  email              citext,
  email_verified     boolean not null default false,       -- true only when it came with a verified identity or an email reply
  email_invalid      boolean not null default false,       -- hard bounce on a continuity email
  phone              text,
  avatar_url         text,
  company            text,
  lead_id            uuid references outreach_leads(id) on delete set null,
  custom_attributes  jsonb not null default '{}',
  consent            jsonb,                                -- {marketing, text_version, at}
  ip_hash            text,                                 -- sha256(ip || inbox salt)
  country            text, city text, timezone text,
  browser            text, os text, device text, locale   text,
  referrer           text, landing_url text, utm jsonb,
  current_url        text, current_title text, current_at timestamptz,
  token_version      integer not null default 1,           -- bumped by reset() / block: older visitor tokens stop working
  first_seen_at      timestamptz not null default now(),
  last_seen_at       timestamptz,
  blocked_at         timestamptz,
  merged_into        uuid references outreach_webchat_visitors(id) on delete set null,
  created_at         timestamptz not null default now()
);
create unique index if not exists outreach_webchat_visitors_identifier_uq on outreach_webchat_visitors(inbox_id, identifier) where identifier is not null and merged_into is null;
create index if not exists outreach_webchat_visitors_inbox_idx on outreach_webchat_visitors(inbox_id, last_seen_at desc);
create index if not exists outreach_webchat_visitors_email_idx on outreach_webchat_visitors(inbox_id, email) where email is not null;
create index if not exists outreach_webchat_visitors_lead_idx on outreach_webchat_visitors(lead_id) where lead_id is not null;

create table if not exists outreach_webchat_page_views (
  id         bigserial primary key,
  visitor_id uuid not null references outreach_webchat_visitors(id) on delete cascade,
  url        text, title text, referrer text, utm jsonb,
  at         timestamptz not null default now()
);
create index if not exists outreach_webchat_page_views_visitor_idx on outreach_webchat_page_views(visitor_id, at desc);

-- Custom events from the SDK (trackEvent) and system events (identified, csat, handoff ...) on the visitor timeline.
create table if not exists outreach_webchat_events (
  id         bigserial primary key,
  visitor_id uuid not null references outreach_webchat_visitors(id) on delete cascade,
  chat_id    uuid references outreach_chats(id) on delete set null,
  name       text not null,
  props      jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index if not exists outreach_webchat_events_visitor_idx on outreach_webchat_events(visitor_id, at desc);

-- ---------------------------------------------------------------------------------------------------------------
-- Chats / messages: web-chat columns (PRD §10). Defaults keep every existing row valid.
-- ---------------------------------------------------------------------------------------------------------------
alter table outreach_chats
  add column if not exists webchat_inbox_id uuid references outreach_webchat_inboxes(id) on delete cascade,
  add column if not exists visitor_id uuid references outreach_webchat_visitors(id) on delete set null,
  add column if not exists status text not null default 'open',
  add column if not exists snoozed_until timestamptz,
  add column if not exists priority text,
  add column if not exists labels text[] not null default '{}',
  add column if not exists custom_attributes jsonb not null default '{}',
  add column if not exists csat jsonb,
  add column if not exists ai_handled boolean not null default false,
  add column if not exists handed_off_at timestamptz,
  add column if not exists handoff_reason text,
  add column if not exists first_response_at timestamptz,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by text,                    -- agent | visitor | auto
  add column if not exists source text,                         -- launcher | popup | campaign | sdk | standalone | email
  add column if not exists stream_key text,                     -- capability key of the widget's Realtime topic (see below)
  add column if not exists visitor_last_seen_at timestamptz,    -- heartbeat while the panel is open (continuity "inactive" logic)
  add column if not exists visitor_typing_at timestamptz,
  add column if not exists visitor_typing_text text,            -- sneak peek for the agent (throttled by the function)
  add column if not exists agent_typing_at timestamptz,
  add column if not exists agent_typing_by uuid,
  add column if not exists email_root_message_id text,          -- continuity thread root (our Message-ID token)
  add column if not exists email_thread_key text,               -- Unipile thread id once the first continuity email is out
  add column if not exists last_continuity_email_at timestamptz,
  add column if not exists continuity_stopped boolean not null default false,
  add column if not exists ai_mode text;                        -- webchat only: off | first | offline_only (resolved at start)

do $$ begin
  alter table outreach_chats add constraint outreach_chats_status_chk check (status in ('open','pending','snoozed','resolved'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_chats add constraint outreach_chats_priority_chk check (priority is null or priority in ('urgent','high','medium','low'));
exception when duplicate_object then null; end $$;
create index if not exists outreach_chats_webchat_inbox_idx on outreach_chats(webchat_inbox_id, status, last_message_at desc) where webchat_inbox_id is not null;
create index if not exists outreach_chats_visitor_idx on outreach_chats(visitor_id, created_at desc) where visitor_id is not null;
create index if not exists outreach_chats_snoozed_idx on outreach_chats(snoozed_until) where status = 'snoozed';
create index if not exists outreach_chats_email_thread_idx on outreach_chats(email_thread_key) where email_thread_key is not null;
create index if not exists outreach_chats_email_root_idx on outreach_chats(email_root_message_id) where email_root_message_id is not null;
create index if not exists outreach_chats_labels_idx on outreach_chats using gin(labels);

alter table outreach_messages
  add column if not exists content_type text not null default 'text',     -- text | attachment | cards | quick_replies | form | form_response | csat | event
  add column if not exists content_attributes jsonb not null default '{}',-- cards, buttons, form schema / response, ai {sources, turn_id}, event {kind}
  add column if not exists sender_type text,                              -- visitor | agent | bot | system (null on non-webchat rows)
  add column if not exists read_by_visitor_at timestamptz,
  add column if not exists read_by_agent_at timestamptz,
  add column if not exists echo_id text,                                  -- client-generated id: optimistic UI + dedupe
  add column if not exists source text;                                   -- widget | email | sdk | agent | bot | system

do $$ begin
  alter table outreach_messages add constraint outreach_messages_content_type_chk check (content_type in ('text','attachment','cards','quick_replies','form','form_response','csat','event'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_messages add constraint outreach_messages_sender_type_chk check (sender_type is null or sender_type in ('visitor','agent','bot','system'));
exception when duplicate_object then null; end $$;
create unique index if not exists outreach_messages_echo_uq on outreach_messages(chat_id, echo_id) where echo_id is not null;
create index if not exists outreach_messages_unread_by_agent_idx on outreach_messages(chat_id) where direction = 'in' and read_by_agent_at is null and sender_type = 'visitor';

-- ---------------------------------------------------------------------------------------------------------------
-- Canned responses, campaigns, blocks, settings history, AI turns, continuity emails
-- ---------------------------------------------------------------------------------------------------------------
create table if not exists outreach_webchat_canned_responses (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  owner_id     uuid references auth.users(id) on delete cascade,   -- null = shared with the workspace
  short_code   text not null,
  content      text not null,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists outreach_webchat_canned_uq on outreach_webchat_canned_responses(workspace_id, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(short_code));

create table if not exists outreach_webchat_campaigns (
  id          uuid primary key default gen_random_uuid(),
  inbox_id    uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  title       text not null,
  message     text not null,
  sender_kind text not null default 'bot' check (sender_kind in ('bot','agent')),
  sender_user_id uuid references auth.users(id) on delete set null,
  quick_replies text[] not null default '{}',
  rules       jsonb not null default '{}',    -- {url_rules:[{op,value}], time_on_page_s, visitor:'all|new|returning|identified', business_hours_only}
  frequency   text not null default 'once' check (frequency in ('once','session','every')),
  display     text not null default 'popup' check (display in ('popup','open')),
  enabled     boolean not null default true,
  shown       integer not null default 0,
  clicked     integer not null default 0,
  started     integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists outreach_webchat_campaigns_inbox_idx on outreach_webchat_campaigns(inbox_id) where enabled;

create table if not exists outreach_webchat_blocks (
  inbox_id   uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  kind       text not null check (kind in ('visitor','ip_hash','country')),
  value      text not null,
  note       text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  primary key (inbox_id, kind, value)
);

create table if not exists outreach_webchat_settings_history (
  id         bigserial primary key,
  inbox_id   uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  version    integer not null,
  settings   jsonb not null,
  business_hours jsonb,
  allowed_domains text[],
  changed_by uuid references auth.users(id),
  diff       jsonb,
  at         timestamptz not null default now()
);
create index if not exists outreach_webchat_settings_history_idx on outreach_webchat_settings_history(inbox_id, version desc);

-- One row per AI answer (chatbot-main chat_logs re-keyed to the inbox): sources, confidence, feedback, latency.
create table if not exists outreach_webchat_ai_turns (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  inbox_id     uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  chat_id      uuid references outreach_chats(id) on delete cascade,
  visitor_id   uuid references outreach_webchat_visitors(id) on delete set null,
  question_message_id uuid references outreach_messages(id) on delete set null,
  answer_message_id   uuid references outreach_messages(id) on delete set null,
  query        text not null,
  answer       text,
  sources      jsonb not null default '[]',
  confidence   text,                       -- high | low | refused
  handoff      text,                       -- reason when this turn handed off
  page_url     text,
  tokens_in    integer, tokens_out integer, latency_ms integer,
  feedback     smallint,                   -- 1 | -1
  feedback_text text,
  model        text,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_webchat_ai_turns_inbox_idx on outreach_webchat_ai_turns(inbox_id, created_at desc);
create index if not exists outreach_webchat_ai_turns_chat_idx on outreach_webchat_ai_turns(chat_id, created_at);

-- Continuity emails (PRD §9): one row per digest sent; the Unipile ids let handleMail route the reply back to the chat.
create table if not exists outreach_webchat_continuity_emails (
  id            uuid primary key default gen_random_uuid(),
  chat_id       uuid not null references outreach_chats(id) on delete cascade,
  visitor_id    uuid references outreach_webchat_visitors(id) on delete set null,
  kind          text not null default 'digest' check (kind in ('digest','transcript','csat','resolved')),
  to_email      citext not null,
  message_ids   uuid[] not null default '{}',
  transport     text not null,             -- mailbox | resend | none
  mailbox_id    uuid references outreach_senders(id) on delete set null,
  tracking_id   text,                      -- Unipile tracking id (send response)
  provider_id   text,                      -- provider message id (send response)
  unipile_email_id text,                   -- filled from the mail_sent webhook
  thread_id     text,                      -- filled from the mail_sent webhook
  subject       text,
  error         text,
  sent_at       timestamptz not null default now()
);
create index if not exists outreach_webchat_continuity_chat_idx on outreach_webchat_continuity_emails(chat_id, sent_at desc);
create index if not exists outreach_webchat_continuity_ids_idx on outreach_webchat_continuity_emails(provider_id) where provider_id is not null;
create index if not exists outreach_webchat_continuity_tracking_idx on outreach_webchat_continuity_emails(tracking_id) where tracking_id is not null;

-- Widget uploads waiting for a message (PRD §15 "attachment upload fails midway → no orphan message"): the storage
-- object is created first, the message references it; rows older than a day without a message are purged by the worker.
create table if not exists outreach_webchat_uploads (
  id          uuid primary key default gen_random_uuid(),
  inbox_id    uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  visitor_id  uuid not null references outreach_webchat_visitors(id) on delete cascade,
  chat_id     uuid references outreach_chats(id) on delete cascade,
  path        text not null,
  name        text not null,
  mime        text not null,
  size        integer not null,
  message_id  uuid references outreach_messages(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists outreach_webchat_uploads_pending_idx on outreach_webchat_uploads(created_at) where message_id is null;

-- ---------------------------------------------------------------------------------------------------------------
-- Storage bucket for widget attachments (private; read through signed URLs minted by the public function)
-- ---------------------------------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('outreach-webchat', 'outreach-webchat', false, 10485760)
on conflict (id) do update set file_size_limit = excluded.file_size_limit;

-- ---------------------------------------------------------------------------------------------------------------
-- updated_at + channel key
-- ---------------------------------------------------------------------------------------------------------------
do $$ begin
  create trigger outreach_webchat_inboxes_updated_at before update on outreach_webchat_inboxes for each row execute function outreach_set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger outreach_webchat_canned_updated_at before update on outreach_webchat_canned_responses for each row execute function outreach_set_updated_at();
exception when duplicate_object then null; end $$;
do $$ begin
  create trigger outreach_webchat_campaigns_updated_at before update on outreach_webchat_campaigns for each row execute function outreach_set_updated_at();
exception when duplicate_object then null; end $$;

-- Reports and the reply-exit trigger key channels through this: webchat is its own channel, not 'email'.
create or replace function outreach__channel_of(p outreach_provider_t) returns text
language sql immutable set search_path = public, extensions as $$
  select case when p is null then 'linkedin' when p in ('LINKEDIN','INSTAGRAM','WHATSAPP','WEBCHAT') then lower(p::text) else 'email' end
$$;

-- The AI pool counts web-chat answers too (PRD §11 "each AI answer consumes 1 AI action from the workspace pool").
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
  select count(*)::int into used from outreach_ai_calls where workspace_id = p_ws and purpose in ('reply_draft','webchat_answer') and at >= date_trunc('month', now());
  return jsonb_build_object('month', to_char(now(), 'YYYY-MM'), 'used', used, 'limit', case when own then null else lim end, 'own_key', own,
                            'ok', own or lim is null or used < lim);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Realtime broadcast to the widget (PRD §13.2).
-- Topic per conversation: webchat:<chat_id>:<stream_key>. The stream key is a 128-bit random capability handed only to
-- the visitor who owns the chat (through the visitor-token-protected API), so a public broadcast channel carries the
-- same guarantee as a private one without the widget needing a Supabase-signed JWT. Agents keep using postgres_changes.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function outreach_webchat__topic(p_chat uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select 'webchat:' || c.id::text || ':' || c.stream_key from outreach_chats c where c.id = p_chat and c.stream_key is not null
$$;

-- Public projection of a message as the widget sees it: no ids of internal rows, no agent-only fields.
create or replace function outreach_webchat__message_json(m outreach_messages) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', m.id, 'conversation_id', m.chat_id, 'echo_id', m.echo_id,
    'sender_type', coalesce(m.sender_type, case when m.direction = 'in' then 'visitor' else 'agent' end),
    'sender_name', case when coalesce(m.sender_type, '') in ('agent','bot') then m.sender_name else null end,
    'sender_avatar', case when coalesce(m.sender_type, '') in ('agent','bot') then m.content_attributes->>'sender_avatar' else null end,
    'content_type', m.content_type,
    'text', case when m.deleted_at is not null then null else m.text end,
    'attachments', case when m.deleted_at is not null then '[]'::jsonb else (
        select coalesce(jsonb_agg(jsonb_build_object('id', a->>'id', 'name', a->>'name', 'type', a->>'type', 'size', a->'size')), '[]'::jsonb)
          from jsonb_array_elements(coalesce(m.attachments, '[]'::jsonb)) a) end,
    'content_attributes', m.content_attributes - 'sender_avatar' - 'internal',
    'sent_at', m.sent_at, 'delivered_at', coalesce(m.delivered_at, m.created_at),
    'read_by_agent_at', m.read_by_agent_at, 'read_by_visitor_at', m.read_by_visitor_at,
    'deleted', m.deleted_at is not null, 'source', m.source, 'unsupported', m.unsupported)
$$;

create or replace function outreach_webchat_trg_message_broadcast() returns trigger
language plpgsql security definer set search_path = public, extensions, realtime as $$
declare topic text; ev text;
begin
  select outreach_webchat__topic(c.id) into topic from outreach_chats c where c.id = new.chat_id and c.provider = 'WEBCHAT';
  if topic is null then return null; end if;
  ev := case when tg_op = 'INSERT' then 'message.created' else 'message.updated' end;
  begin
    perform realtime.send(jsonb_build_object('message', outreach_webchat__message_json(new)), ev, topic, false);
  exception when others then
    raise warning 'webchat broadcast failed: %', sqlerrm;   -- never fail the insert because the socket layer hiccuped
  end;
  return null;
end $$;

drop trigger if exists outreach_webchat_message_broadcast on outreach_messages;
create trigger outreach_webchat_message_broadcast
  after insert or update of text, deleted_at, read_by_agent_at, read_by_visitor_at, content_attributes on outreach_messages
  for each row execute function outreach_webchat_trg_message_broadcast();

create or replace function outreach_webchat_trg_chat_broadcast() returns trigger
language plpgsql security definer set search_path = public, extensions, realtime as $$
declare topic text;
begin
  if new.provider <> 'WEBCHAT' then return null; end if;
  if new.status is distinct from old.status or new.assigned_to is distinct from old.assigned_to or new.handed_off_at is distinct from old.handed_off_at
     or new.ai_handled is distinct from old.ai_handled or new.csat is distinct from old.csat then
    topic := outreach_webchat__topic(new.id);
    if topic is null then return null; end if;
    begin
      perform realtime.send(jsonb_build_object('conversation', jsonb_build_object('id', new.id, 'status', new.status, 'assigned', new.assigned_to is not null,
                 'resolved_at', new.resolved_at, 'handed_off_at', new.handed_off_at, 'ai_handled', new.ai_handled, 'csat_submitted', new.csat is not null)),
        'conversation.status', topic, false);
    exception when others then raise warning 'webchat broadcast failed: %', sqlerrm; end;
  end if;
  return null;
end $$;

drop trigger if exists outreach_webchat_chat_broadcast on outreach_chats;
create trigger outreach_webchat_chat_broadcast
  after update of status, assigned_to, handed_off_at, ai_handled, csat on outreach_chats
  for each row execute function outreach_webchat_trg_chat_broadcast();

-- Agent side: keep the existing rollup for previews, plus first-response stamping and lead reply-stop on visitor messages.
create or replace function outreach_webchat_trg_message_side_effects() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = new.chat_id;
  if c.provider <> 'WEBCHAT' then return null; end if;
  if new.direction = 'out' and new.sender_type = 'agent' and c.first_response_at is null then
    update outreach_chats set first_response_at = new.sent_at where id = c.id;
  end if;
  if new.direction = 'out' and new.sender_type = 'agent' then
    -- a person answered: the AI stops for this conversation (PRD §11 agent takeover); the AI menu can hand it back
    update outreach_chats set ai_handled = false, handed_off_at = coalesce(handed_off_at, now()), handoff_reason = coalesce(handoff_reason, 'human_replied')
     where id = c.id and ai_mode is not null and ai_mode <> 'off' and handed_off_at is null;
  end if;
  if new.direction = 'in' and new.sender_type = 'visitor' and c.lead_id is not null then
    -- a visitor linked to a lead replied: same effect as a reply on any other channel. outreach_trg_reply_exit fires on
    -- UPDATE of replied / last_inbound_at only (as the connector path does it): insert the row first, then update it.
    insert into outreach_lead_sender_state(lead_id, sender_id, relation, unipile_chat_id) values (c.lead_id, c.sender_id, 'none', c.unipile_chat_id) on conflict (lead_id, sender_id) do nothing;
    update outreach_lead_sender_state set replied = true, last_inbound_at = new.sent_at, unipile_chat_id = c.unipile_chat_id, updated_at = now() where lead_id = c.lead_id and sender_id = c.sender_id;
  end if;
  return null;
end $$;

drop trigger if exists outreach_webchat_message_side_effects on outreach_messages;
create trigger outreach_webchat_message_side_effects after insert on outreach_messages for each row execute function outreach_webchat_trg_message_side_effects();

-- ---------------------------------------------------------------------------------------------------------------
-- RLS: agent-side tables readable by workspace members (client scope through the inbox); writes through RPCs only.
-- Service-only tables (visitors' events, uploads, continuity, AI turns, settings history) have RLS and no policies for
-- users except the reads the contact panel needs.
-- ---------------------------------------------------------------------------------------------------------------
alter table outreach_webchat_inboxes enable row level security;
alter table outreach_webchat_inbox_members enable row level security;
alter table outreach_webchat_agent_presence enable row level security;
alter table outreach_webchat_visitors enable row level security;
alter table outreach_webchat_page_views enable row level security;
alter table outreach_webchat_events enable row level security;
alter table outreach_webchat_canned_responses enable row level security;
alter table outreach_webchat_campaigns enable row level security;
alter table outreach_webchat_blocks enable row level security;
alter table outreach_webchat_settings_history enable row level security;
alter table outreach_webchat_ai_turns enable row level security;
alter table outreach_webchat_continuity_emails enable row level security;
alter table outreach_webchat_uploads enable row level security;

select outreach__policy('outreach_webchat_inboxes', 'webchat_inboxes_select', 'select',
  'deleted_at is null and workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id)');
select outreach__policy('outreach_webchat_inbox_members', 'webchat_inbox_members_select', 'select',
  'exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and i.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_agent_presence', 'webchat_presence_select', 'select', 'workspace_id in (select outreach_workspace_ids())');
select outreach__policy('outreach_webchat_visitors', 'webchat_visitors_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_page_views', 'webchat_page_views_select', 'select',
  'exists (select 1 from outreach_webchat_visitors v join outreach_webchat_inboxes i on i.id = v.inbox_id where v.id = visitor_id and v.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_events', 'webchat_events_select', 'select',
  'exists (select 1 from outreach_webchat_visitors v join outreach_webchat_inboxes i on i.id = v.inbox_id where v.id = visitor_id and v.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_canned_responses', 'webchat_canned_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and (owner_id is null or owner_id = auth.uid())');
select outreach__policy('outreach_webchat_campaigns', 'webchat_campaigns_select', 'select',
  'exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and i.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_blocks', 'webchat_blocks_select', 'select',
  'exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and i.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_settings_history', 'webchat_history_select', 'select',
  'exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and i.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_ai_turns', 'webchat_ai_turns_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_continuity_emails', 'webchat_continuity_select', 'select',
  'exists (select 1 from outreach_chats c where c.id = chat_id and c.workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(c.workspace_id, c.client_id))');

-- Realtime: presence + visitors change on the agent side (contact panel live page, typing preview through outreach_chats)
do $$ begin alter publication supabase_realtime add table outreach_webchat_visitors; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table outreach_webchat_agent_presence; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table outreach_webchat_inboxes; exception when duplicate_object then null; when undefined_object then null; end $$;

-- The synthetic WEBCHAT sender must never be planned, warmed, health-scored or billed like a connected account.
-- Planner / health / billing all select by provider; WEBCHAT is outside their lists. Belt and braces: pools drop it.
create or replace function outreach_webchat_trg_sender_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.provider = 'WEBCHAT' then
    new.status := case when new.status in ('disabled','paused') then new.status else 'ok' end;
    new.auth_method := 'oauth';
    new.warmup_level := 5;
    new.health_score := 100;
    new.unipile_account_id := null;
  end if;
  return new;
end $$;
drop trigger if exists outreach_webchat_sender_guard on outreach_senders;
create trigger outreach_webchat_sender_guard before insert or update on outreach_senders for each row execute function outreach_webchat_trg_sender_guard();
