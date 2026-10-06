-- 076_reply_alerts.sql — reply alerts: desktop notification + sound when a person replies (reply-notifications-PRD.md, 6 Oct 2026).
-- Requires 001–075 (075 adds outreach__msg_kind, is_auto_reply / is_bounce, waiting_on, ai_answering). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/076_reply_alerts.sql
-- Cron for the push sender is in 077 (apply after deploying `outreach-notify-push`).
--
--   1. outreach_notification_settings: per person per workspace (scope, AI option, sound, preview, quiet hours, pause,
--      the inbox prompt's state). outreach_notification_prefs gains `sound` (null = the kind's default).
--   2. outreach_notifications gains message_id, count, alert_desktop / alert_sound / alert_muted, alerted_at, data,
--      updated_at. One OPEN reply alert per person per conversation (partial unique index, D4): new messages merge into it.
--   3. outreach_alert_flags(user, ws, kind, at) is the one place the rules live (D5). A BEFORE INSERT trigger stamps every
--      notification row with it, so the alerts that already exist (mentions, AI handoffs) follow the same rules.
--   4. Reply alerts come from a DEFERRED constraint trigger on outreach_messages: it runs at commit, so it sees the final
--      state of the transaction on every path (Unipile webhook, email, website chat, backfill) — including a website
--      chat that the same transaction handed to a person. Assignment and website-chat handoff alerts come from a deferred
--      trigger on outreach_chats. Alert failures never fail the write that caused them (caught, logged as warnings).
--   5. Our own message (any device, the AI included) marks the conversation's open reply alerts read for everyone;
--      a message reclassified as out-of-office takes its alert back.
--   6. Web Push (step 2): outreach_push_subscriptions (per user, follows them across workspaces), outreach_push_queue
--      (no pgmq on this project), VAPID keys in Vault (created by the function on first use), service RPCs for F47.
--
-- Naming (PRD → built): notify_reply → outreach_alert_on_message · notification_alert_flags → outreach_alert_flags ·
-- notifications_mark_read(chat) → outreach_alerts_mark_chat_read · notification_settings_save → outreach_alert_settings_save ·
-- notification_pref_set → outreach_alert_pref_set · push_subscribe / push_unsubscribe → outreach_push_subscribe / _unsubscribe.
-- Deliberately outside the `outreach_notification%` prefix: the 046 grant loop revokes every function under it that is not
-- on its own list (the loop at the end of 046_chat_notes.sql; 045 fixed the same trap for the AI RPCs).

-- ============================================================================= 1. tables
create table if not exists outreach_notification_settings (
  user_id              uuid not null references auth.users(id) on delete cascade,
  workspace_id         uuid not null references outreach_workspaces(id) on delete cascade,
  scope                text not null default 'mine_unassigned' check (scope in ('mine', 'mine_unassigned', 'all')),
  include_ai_handled   boolean not null default false,
  sound_enabled        boolean not null default false,                -- D2: off until the person turns it on
  sound_name           text not null default 'ping' check (sound_name in ('ping', 'chime', 'pop', 'knock')),
  sound_volume         smallint not null default 70 check (sound_volume between 0 and 100),
  show_preview         boolean not null default true,
  alert_when_visible   boolean not null default false,
  quiet_hours          jsonb check (quiet_hours is null or jsonb_typeof(quiet_hours) = 'object'),  -- {days:[1..7], start:"09:00", end:"19:00", tz}
  paused_until         timestamptz,                                    -- 'infinity' = until turned back on
  enabled_at           timestamptz,                                    -- first time alerts were turned on
  prompt_dismissed_at  timestamptz,
  prompt_dismiss_count smallint not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (user_id, workspace_id)
);
alter table outreach_notification_settings enable row level security;

-- "Desktop" in the UI is the existing `push` column. null sound = the kind's default (on, except "assigned").
alter table outreach_notification_prefs add column if not exists sound boolean;

alter table outreach_notifications
  add column if not exists message_id    uuid references outreach_messages(id) on delete cascade,
  add column if not exists count         int not null default 1,
  add column if not exists alert_desktop boolean not null default false,
  add column if not exists alert_sound   boolean not null default false,
  add column if not exists alert_muted   boolean not null default false,   -- paused / quiet hours: bell only
  add column if not exists alerted_at    timestamptz,                      -- last time this row alerted (merges re-alert after 30 s)
  add column if not exists data          jsonb not null default '{}'::jsonb,
  add column if not exists updated_at    timestamptz not null default now();
comment on column outreach_notifications.alerted_at is 'Last time this row asked for a sound / desktop notification. A merged message re-alerts only 30 s after it (076).';
comment on column outreach_notifications.data is 'Display parts for desktop notifications: channel, to (sender), text, provider, ws_name (076).';

-- D4: one open reply alert per person per conversation; website chat has its own kind
create unique index if not exists outreach_notifications_open_reply on outreach_notifications (user_id, chat_id, kind)
  where kind in ('reply_new', 'webchat_message') and read_at is null;
create index if not exists outreach_notifications_chat_open on outreach_notifications (chat_id) where read_at is null;
create index if not exists outreach_notifications_message on outreach_notifications (message_id) where message_id is not null;

create table if not exists outreach_push_subscriptions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  endpoint     text not null unique check (char_length(endpoint) <= 2048),
  p256dh       text not null check (char_length(p256dh) between 80 and 100),
  auth         text not null check (char_length(auth) between 16 and 32),
  label        text check (char_length(label) <= 80),                 -- "Chrome on Windows"
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  failures     int not null default 0,
  last_error   text
);
create index if not exists outreach_push_subscriptions_user on outreach_push_subscriptions (user_id);
alter table outreach_push_subscriptions enable row level security;

create table if not exists outreach_push_queue (
  id              bigint generated always as identity primary key,
  notification_id uuid not null references outreach_notifications(id) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  alerted_at      timestamptz not null,          -- the alert of the row this push is for (a newer alert supersedes it)
  created_at      timestamptz not null default now(),
  next_at         timestamptz not null default now(),
  attempts        int not null default 0,
  claimed_until   timestamptz
);
create index if not exists outreach_push_queue_due on outreach_push_queue (next_at);
alter table outreach_push_queue enable row level security;   -- no policies: functions only

-- RLS (select only; writes are function-only)
select outreach__policy('outreach_notification_settings', 'notification_settings_select', 'select', 'user_id = auth.uid()');
select outreach__policy('outreach_push_subscriptions', 'push_subscriptions_select', 'select', 'user_id = auth.uid()');

-- ============================================================================= 2. the rules (D5)
-- Quiet hours: true when alerts may sound / show at `at`. null = always. Overnight windows (22:00–07:00) belong to the
-- day they start on. An unknown time zone never silences anyone.
create or replace function outreach__alert_window_open(p_q jsonb, p_at timestamptz) returns boolean
language plpgsql stable set search_path = public, extensions as $$
declare tz text; loc timestamp; t time; st time; en time; days int[]; dow int; prev int;
begin
  if p_q is null or jsonb_typeof(p_q) <> 'object' then return true; end if;
  tz := coalesce(nullif(p_q->>'tz', ''), 'UTC');
  begin
    loc := p_at at time zone tz;
    st := (p_q->>'start')::time; en := (p_q->>'end')::time;
  exception when others then return true;
  end;
  if st is null or en is null then return true; end if;
  select coalesce(array_agg(x::int), '{1,2,3,4,5,6,7}') into days from jsonb_array_elements_text(coalesce(p_q->'days', '[1,2,3,4,5,6,7]'::jsonb)) x;
  t := loc::time; dow := extract(isodow from loc)::int; prev := case when dow = 1 then 7 else dow - 1 end;
  if st = en then return dow = any(days); end if;
  if st < en then return dow = any(days) and t >= st and t < en; end if;
  return (dow = any(days) and t >= st) or (prev = any(days) and t < en);
end $$;

-- {desktop, sound, muted} for one person, workspace and kind. Desktop = the kind's Desktop tick (the browser decides if it
-- can show it); sound = sound turned on + the kind's Sound tick; muted = paused or outside quiet hours (bell only).
create or replace function outreach_alert_flags(p_user uuid, p_ws uuid, p_kind text, p_at timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_notification_settings%rowtype; p outreach_notification_prefs%rowtype; muted boolean;
begin
  select * into s from outreach_notification_settings where user_id = p_user and workspace_id = p_ws;
  select * into p from outreach_notification_prefs where user_id = p_user and workspace_id = p_ws and kind = p_kind;
  muted := (s.paused_until is not null and s.paused_until > p_at) or not outreach__alert_window_open(s.quiet_hours, p_at);
  return jsonb_build_object(
    'desktop', not muted and coalesce(p.push, true),
    'sound',   not muted and coalesce(s.sound_enabled, false) and coalesce(p.sound, p_kind <> 'assigned'),
    'muted',   muted);
end $$;

-- Can this member read this conversation (membership + client scope)? Client viewers only ever get their own clients'.
create or replace function outreach__alert_can_read(p_ws uuid, p_user uuid, p_role outreach_role_t, p_client_ids uuid[], p_cid uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select platform_can_use(p_user, 'outreach')
     and case when p_role = 'client_viewer' then outreach_has_feature(p_ws, 'client_viewer') and p_cid is not null and p_cid = any(coalesce(p_client_ids, '{}'))
              else p_role in ('owner', 'manager') or p_cid is null or p_cid = any(coalesce(p_client_ids, '{}')) end
$$;

-- "LinkedIn", "Email", "Website chat" …
create or replace function outreach__alert_channel(p_provider outreach_provider_t) returns text
language sql immutable set search_path = public, extensions as $$
  select case p_provider::text when 'LINKEDIN' then 'LinkedIn' when 'WHATSAPP' then 'WhatsApp' when 'INSTAGRAM' then 'Instagram'
                              when 'GMAIL' then 'Email' when 'OUTLOOK' then 'Email' when 'IMAP' then 'Email' when 'MAIL' then 'Email'
                              when 'WEBCHAT' then 'Website chat' else initcap(lower(p_provider::text)) end
$$;

-- The first 120 characters a person wrote, on one line (attachments / voice notes get a word).
create or replace function outreach__alert_text(m outreach_messages) returns text
language sql immutable set search_path = public, extensions as $$
  select left(btrim(regexp_replace(coalesce(nullif(btrim(m.text), ''), nullif(btrim(m.transcript), ''),
           case when jsonb_typeof(m.attachments) = 'array' and jsonb_array_length(m.attachments) > 0 then 'Sent an attachment' end, 'New message'), '\s+', ' ', 'g')), 120)
$$;

-- Name of the person on the other side: "Priya Nair · Razorpay"; website chat: "Website visitor · Acme site".
create or replace function outreach__alert_title(c outreach_chats, m outreach_messages) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; v outreach_webchat_visitors%rowtype; site text; nm text;
begin
  if c.lead_id is not null then select * into l from outreach_leads where id = c.lead_id; end if;
  if c.provider = 'WEBCHAT' then
    if c.visitor_id is not null then select * into v from outreach_webchat_visitors where id = c.visitor_id; end if;
    select i.name into site from outreach_webchat_inboxes i where i.id = c.webchat_inbox_id;
    nm := coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(v.name), ''), 'Website visitor');
    return left(nm || coalesce(' · ' || nullif(btrim(site), ''), ''), 160);
  end if;
  nm := coalesce(nullif(btrim(l.full_name), ''), nullif(btrim(c.attendee_name), ''), nullif(btrim(m.sender_name), ''), 'Someone');
  return left(nm || coalesce(' · ' || nullif(btrim(l.company), ''), ''), 160);
end $$;

-- The workspace name, only for people in more than one workspace (the desktop notification names it).
create or replace function outreach__alert_ws_name(p_user uuid, p_ws uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when (select count(*) from outreach_members x where x.user_id = p_user) > 1 then (select w.name from outreach_workspaces w where w.id = p_ws) end
$$;

-- ============================================================================= 3. every notification row: flags + push
create or replace function outreach_trg_notification_alert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb;
begin
  new.updated_at := now();
  if new.read_at is not null then
    new.alert_desktop := false; new.alert_sound := false; new.alerted_at := null;
    return new;
  end if;
  f := outreach_alert_flags(new.user_id, new.workspace_id, new.kind, now());
  new.alert_desktop := (f->>'desktop')::boolean;
  new.alert_sound := (f->>'sound')::boolean;
  new.alert_muted := (f->>'muted')::boolean;
  new.alerted_at := now();
  if new.data = '{}'::jsonb and new.chat_id is not null then
    -- existing creators (mentions, AI handoff notes) get the same display parts as replies
    select jsonb_strip_nulls(jsonb_build_object('provider', c.provider, 'channel', outreach__alert_channel(c.provider), 'to', s.display_name,
             'ws_name', outreach__alert_ws_name(new.user_id, new.workspace_id)))
      into new.data from outreach_chats c left join outreach_senders s on s.id = c.sender_id where c.id = new.chat_id;
    new.data := coalesce(new.data, '{}'::jsonb);
  end if;
  return new;
end $$;
drop trigger if exists outreach_notifications_alert on outreach_notifications;
create trigger outreach_notifications_alert before insert on outreach_notifications
  for each row execute function outreach_trg_notification_alert();

-- A due push nudges the sender right away (at most once every 2 s); the 10-second cron sweeps up the rest.
create or replace function outreach__push_kick() returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if outreach_rate_limit('push:kick', 1, 2) then perform outreach_invoke('outreach-notify-push', '{"mode":"send"}'::jsonb); end if;
exception when others then
  raise warning 'outreach push kick: %', sqlerrm;
end $$;

-- Step 2: an alert that may show on the desktop is queued for each of the person's saved browsers (F47 sends it).
create or replace function outreach_trg_notification_push() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.read_at is null and new.alert_desktop and new.alerted_at is not null
     and (tg_op = 'INSERT' or new.alerted_at is distinct from old.alerted_at)
     and exists (select 1 from outreach_push_subscriptions p where p.user_id = new.user_id) then
    insert into outreach_push_queue(notification_id, user_id, alerted_at) values (new.id, new.user_id, new.alerted_at);
    perform outreach__push_kick();
  end if;
  return null;
exception when others then
  raise warning 'outreach push enqueue for notification %: %', new.id, sqlerrm;
  return null;
end $$;
drop trigger if exists outreach_notifications_push on outreach_notifications;
create trigger outreach_notifications_push after insert or update of alerted_at on outreach_notifications
  for each row execute function outreach_trg_notification_push();

-- ============================================================================= 4. reply alerts
-- Called at commit for every message from the other side. Skips (§3.1): not a person (ours, auto-reply, bounce, system
-- event, CSAT), deleted, older than 10 minutes when stored (history sync, reconnect backfill), and a website chat that
-- this same transaction handed to a person (the handoff alert covers it). Recipients (§3.2): members who can read the
-- conversation, narrowed by their scope; the AI answering it (Auto, not handed off) alerts nobody unless they opted in.
-- One open alert per person per conversation: a new message updates text, message_id, count and re-alerts after 30 s.
create or replace function outreach_alert_on_message(p_message uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare m outreach_messages%rowtype; c outreach_chats%rowtype; s outreach_senders%rowtype; r record;
        k text; ai boolean := false; title_ text; text_ text; base jsonb; n int := 0; owner_ uuid; ok boolean;
begin
  select * into m from outreach_messages where id = p_message;
  if not found or m.direction <> 'in' or m.deleted_at is not null then return 0; end if;
  if outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) is distinct from 'person' then return 0; end if;
  if m.sent_at < now() - interval '10 minutes' then return 0; end if;
  select * into c from outreach_chats where id = m.chat_id;
  if not found then return 0; end if;
  if c.provider = 'WEBCHAT' then
    if c.handed_off_at is not null and c.handed_off_at >= now() then return 0; end if;   -- handed off in this transaction
    k := 'webchat_message';
    ai := c.handed_off_at is null and coalesce(c.ai_mode, 'off') not in ('off', 'review');
  else
    k := 'reply_new';
    if c.ai_handed_off_at is null then
      ai := coalesce(c.ai_answering, false);
      if not ai and c.provider = 'LINKEDIN' and c.reply_sequence_id is not null then
        begin
          ai := coalesce(outreach__ai_effective(c.id)->>'mode', 'off') = 'autopilot';
        exception when others then ai := false;
        end;
      end if;
    end if;
  end if;
  select * into s from outreach_senders where id = c.sender_id;
  owner_ := s.owner_user_id;
  if owner_ is null and s.owner_email is not null then
    select mm.user_id into owner_ from outreach_members mm where mm.workspace_id = c.workspace_id and lower(mm.email::text) = lower(s.owner_email::text) limit 1;
  end if;
  title_ := outreach__alert_title(c, m);
  text_ := outreach__alert_text(m);
  base := jsonb_strip_nulls(jsonb_build_object('provider', c.provider, 'channel', outreach__alert_channel(c.provider),
            'to', case when c.provider = 'WEBCHAT' then null else s.display_name end, 'text', text_, 'lead_id', c.lead_id));

  for r in
    select mm.user_id, coalesce(st.scope, 'mine_unassigned') as scope, coalesce(st.include_ai_handled, false) as inc_ai
      from outreach_members mm
      left join outreach_notification_settings st on st.user_id = mm.user_id and st.workspace_id = mm.workspace_id
     where mm.workspace_id = c.workspace_id
       and outreach__alert_can_read(c.workspace_id, mm.user_id, mm.role, mm.client_ids, c.client_id)
  loop
    -- null-safe: an unassigned chat must never make the test NULL (and so skip nobody)
    ok := case r.scope
            when 'all' then true
            when 'mine' then c.assigned_to is not distinct from r.user_id or (c.assigned_to is null and owner_ is not distinct from r.user_id)
            else c.assigned_to is null or c.assigned_to is not distinct from r.user_id end;
    if not coalesce(ok, false) then continue; end if;
    if ai and not r.inc_ai then continue; end if;
    -- this transaction already told them it was assigned to them: one alert, not two
    if exists (select 1 from outreach_notifications x where x.user_id = r.user_id and x.chat_id = c.id and x.kind = 'assigned' and x.created_at >= now()) then continue; end if;
    insert into outreach_notifications as x (workspace_id, user_id, kind, chat_id, message_id, title, body, data)
    values (c.workspace_id, r.user_id, k, c.id, m.id, title_, text_, base || jsonb_strip_nulls(jsonb_build_object('ws_name', outreach__alert_ws_name(r.user_id, c.workspace_id))))
    on conflict (user_id, chat_id, kind) where kind in ('reply_new', 'webchat_message') and read_at is null
    do update set count = x.count + 1, title = excluded.title, body = excluded.body, data = excluded.data, message_id = excluded.message_id, updated_at = now(),
                  alerted_at    = case when x.alerted_at is null or x.alerted_at <= now() - interval '30 seconds' then now() else x.alerted_at end,
                  alert_desktop = case when x.alerted_at is null or x.alerted_at <= now() - interval '30 seconds' then excluded.alert_desktop else x.alert_desktop end,
                  alert_sound   = case when x.alerted_at is null or x.alerted_at <= now() - interval '30 seconds' then excluded.alert_sound else x.alert_sound end,
                  alert_muted   = case when x.alerted_at is null or x.alerted_at <= now() - interval '30 seconds' then excluded.alert_muted else x.alert_muted end
     where x.message_id is distinct from excluded.message_id;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function outreach_trg_message_alert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  begin
    perform outreach_alert_on_message(new.id);
  exception when others then
    raise warning 'outreach reply alert for message %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_alert on outreach_messages;
create constraint trigger outreach_messages_zz_alert after insert on outreach_messages
  deferrable initially deferred
  for each row when (new.direction = 'in' and new.event_type is null and new.sent_at > now() - interval '10 minutes')
  execute function outreach_trg_message_alert();

-- Our message (from the app, the sender's phone or the AI) means the conversation no longer waits on us: every open reply
-- alert on it is read, on every device. Runs after the rollup trigger, so waiting_on already reflects this message.
create or replace function outreach_trg_message_alert_clear() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if outreach__msg_kind(new.direction, new.is_auto_reply, new.is_bounce, new.event_type, new.content_type, new.sender_type) = 'ours'
     and coalesce(new.content_attributes->>'handoff', 'false') <> 'true'
     and exists (select 1 from outreach_chats c where c.id = new.chat_id and c.waiting_on = 'them') then
    update outreach_notifications set read_at = now(), updated_at = now()
     where chat_id = new.chat_id and read_at is null and kind in ('reply_new', 'webchat_message');
  end if;
  return null;
exception when others then
  raise warning 'outreach alert clear for message %: %', new.id, sqlerrm;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_alert_clear on outreach_messages;
create trigger outreach_messages_zz_alert_clear after insert on outreach_messages
  for each row when (new.direction = 'out') execute function outreach_trg_message_alert_clear();

-- The classifier decides a message was an out-of-office after all: its alert is taken back. Hangs off `intent` (what the
-- classifier writes): is_auto_reply is set by 075's BEFORE trigger, and a column-specific trigger only sees SET columns.
create or replace function outreach_trg_message_alert_retract() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_notifications set read_at = now(), updated_at = now() where message_id = new.id and read_at is null and count <= 1;
  update outreach_notifications set count = count - 1, updated_at = now() where message_id = new.id and read_at is null and count > 1;
  return null;
exception when others then
  raise warning 'outreach alert retract for message %: %', new.id, sqlerrm;
  return null;
end $$;
drop trigger if exists outreach_messages_zz_alert_retract on outreach_messages;
create trigger outreach_messages_zz_alert_retract after update of intent on outreach_messages
  for each row when (new.is_auto_reply and not old.is_auto_reply and new.direction = 'in') execute function outreach_trg_message_alert_retract();

-- ============================================================================= 5. assignment + website chat handoff alerts
-- Runs at commit with the conversation's final state.
--   * website chat handed to a person: the assignee gets "AI handed … to you"; nobody assigned → everyone in scope gets a
--     website chat alert (the visitor is waiting, the AI has stopped).
--   * assigned to someone else by a teammate or by auto-assignment: "… assigned you …". Not for assigning yourself, not
--     when the same transaction handed the conversation over (the handoff alert says it), not twice with a reply alert.
create or replace function outreach_alert_on_chat_change(p_chat uuid, p_old_assignee uuid, p_new_assignee uuid, p_old_handed timestamptz, p_new_handed timestamptz) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; mem outreach_members%rowtype; lastm outreach_messages%rowtype; title_ text; text_ text; who text; n int := 0; r record; base jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then return 0; end if;
  select * into lastm from outreach_messages x where x.chat_id = c.id and x.direction = 'in' and x.deleted_at is null and x.event_type is null order by x.sent_at desc limit 1;
  title_ := outreach__alert_title(c, lastm);
  text_ := case when lastm.id is null then null else outreach__alert_text(lastm) end;
  base := jsonb_strip_nulls(jsonb_build_object('provider', c.provider, 'channel', outreach__alert_channel(c.provider), 'text', text_, 'lead_id', c.lead_id,
            'to', (select s.display_name from outreach_senders s where s.id = c.sender_id and c.provider <> 'WEBCHAT')));

  if c.provider = 'WEBCHAT' and p_old_handed is null and p_new_handed is not null and c.handed_off_at is not null then
    if c.assigned_to is not null then
      select * into mem from outreach_members where workspace_id = c.workspace_id and user_id = c.assigned_to;
      if found and outreach__alert_can_read(c.workspace_id, mem.user_id, mem.role, mem.client_ids, c.client_id) then
        insert into outreach_notifications(workspace_id, user_id, kind, chat_id, message_id, title, body, data)
        values (c.workspace_id, c.assigned_to, 'ai_handoff', c.id, lastm.id, 'AI handed ' || title_ || ' to you', text_,
                base || jsonb_strip_nulls(jsonb_build_object('ws_name', outreach__alert_ws_name(c.assigned_to, c.workspace_id))));
        n := 1;
      end if;
    else
      for r in
        select mm.user_id from outreach_members mm
          left join outreach_notification_settings st on st.user_id = mm.user_id and st.workspace_id = mm.workspace_id
         where mm.workspace_id = c.workspace_id and coalesce(st.scope, 'mine_unassigned') <> 'mine'
           and outreach__alert_can_read(c.workspace_id, mm.user_id, mm.role, mm.client_ids, c.client_id)
      loop
        insert into outreach_notifications as x (workspace_id, user_id, kind, chat_id, message_id, title, body, data)
        values (c.workspace_id, r.user_id, 'webchat_message', c.id, lastm.id, title_, coalesce('Asked for a person: ' || text_, 'Asked for a person'),
                base || jsonb_strip_nulls(jsonb_build_object('ws_name', outreach__alert_ws_name(r.user_id, c.workspace_id))))
        on conflict (user_id, chat_id, kind) where kind in ('reply_new', 'webchat_message') and read_at is null
        do update set title = excluded.title, body = excluded.body, data = excluded.data, message_id = excluded.message_id, updated_at = now(),
                      alerted_at = now(), alert_desktop = excluded.alert_desktop, alert_sound = excluded.alert_sound, alert_muted = excluded.alert_muted;
        n := n + 1;
      end loop;
    end if;
    return n;
  end if;

  if p_new_assignee is not null and p_new_assignee is distinct from p_old_assignee and c.assigned_to = p_new_assignee then
    if auth.uid() is not null and p_new_assignee = auth.uid() then return 0; end if;                        -- assigned themselves
    if (c.handed_off_at is not null and c.handed_off_at >= now()) or (c.ai_handed_off_at is not null and c.ai_handed_off_at >= now()) then return 0; end if;
    if exists (select 1 from outreach_notifications x where x.user_id = p_new_assignee and x.chat_id = c.id and x.read_at is null
                and x.kind in ('reply_new', 'webchat_message', 'ai_handoff') and x.updated_at >= now()) then return 0; end if;
    select * into mem from outreach_members where workspace_id = c.workspace_id and user_id = p_new_assignee;
    if not found or not outreach__alert_can_read(c.workspace_id, mem.user_id, mem.role, mem.client_ids, c.client_id) then return 0; end if;
    who := case when auth.uid() is null then null else outreach__note_user_label(c.workspace_id, auth.uid()) end;
    -- an earlier unread assignment of the same conversation is replaced, not stacked
    update outreach_notifications set read_at = now(), updated_at = now() where user_id = p_new_assignee and chat_id = c.id and kind = 'assigned' and read_at is null;
    insert into outreach_notifications(workspace_id, user_id, kind, chat_id, actor_id, title, body, data)
    values (c.workspace_id, p_new_assignee, 'assigned', c.id, auth.uid(),
            case when who is null then 'You were assigned ' || title_ else who || ' assigned you ' || title_ end, text_,
            base || jsonb_strip_nulls(jsonb_build_object('ws_name', outreach__alert_ws_name(p_new_assignee, c.workspace_id))));
    return 1;
  end if;
  return 0;
end $$;

create or replace function outreach_trg_chat_alert() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  begin
    perform outreach_alert_on_chat_change(new.id, old.assigned_to, new.assigned_to, old.handed_off_at, new.handed_off_at);
  exception when others then
    raise warning 'outreach chat alert for %: %', new.id, sqlerrm;
  end;
  return null;
end $$;
drop trigger if exists outreach_chats_zz_alert on outreach_chats;
create constraint trigger outreach_chats_zz_alert after update of assigned_to, handed_off_at on outreach_chats
  deferrable initially deferred
  for each row when (old.assigned_to is distinct from new.assigned_to or old.handed_off_at is distinct from new.handed_off_at)
  execute function outreach_trg_chat_alert();

-- The AI handoff note (046) mentions the assignee: that alert is an "AI handed … to you" alert, not a mention.
create or replace function outreach__note_notify_mentions(n outreach_chat_notes, p_users uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid; k int := 0; who text; title text; snippet text; ttl text; kind_ text;
begin
  if p_users is null or cardinality(p_users) = 0 then return 0; end if;
  who := outreach__note_author_label(n.workspace_id, n.author_id, n.author_type);
  ttl := outreach__note_chat_title(n.chat_id);
  snippet := left(regexp_replace(outreach__note_plain(n.body), '\s+', ' ', 'g'), 140);
  kind_ := case when n.author_type = 'ai' then 'ai_handoff' else 'note_mention' end;
  title := case when kind_ = 'ai_handoff' then 'AI handed ' || ttl || ' to you' else who || ' mentioned you in ' || ttl end;
  foreach u in array p_users loop
    insert into outreach_chat_note_mentions(note_id, user_id, workspace_id, chat_id) values (n.id, u, n.workspace_id, n.chat_id) on conflict do nothing;
    insert into outreach_notifications(workspace_id, user_id, kind, chat_id, note_id, actor_id, title, body)
    values (n.workspace_id, u, kind_, n.chat_id, n.id, n.author_id, title, snippet);
    k := k + 1;
  end loop;
  return k;
end $$;

-- ============================================================================= 6. app RPCs
-- Personal settings: any member (suspended workspaces included — this is not workspace data).
create or replace function outreach__alert_member(p_ws uuid) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null or outreach_role_in(p_ws) is null then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
end $$;

create or replace function outreach_alert_settings_get(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_notification_settings%rowtype; kinds jsonb := '{}'::jsonb; k text; p outreach_notification_prefs%rowtype; f jsonb;
begin
  perform outreach__alert_member(p_ws);
  select * into s from outreach_notification_settings where user_id = auth.uid() and workspace_id = p_ws;
  foreach k in array array['reply_new', 'webchat_message', 'note_mention', 'ai_handoff', 'assigned'] loop
    p := null;
    select * into p from outreach_notification_prefs where user_id = auth.uid() and workspace_id = p_ws and kind = k;
    kinds := kinds || jsonb_build_object(k, jsonb_build_object('desktop', coalesce(p.push, true), 'sound', coalesce(p.sound, k <> 'assigned')));
  end loop;
  f := outreach_alert_flags(auth.uid(), p_ws, 'reply_new', now());
  return jsonb_build_object(
    'scope', coalesce(s.scope, 'mine_unassigned'), 'include_ai_handled', coalesce(s.include_ai_handled, false),
    'sound_enabled', coalesce(s.sound_enabled, false), 'sound_name', coalesce(s.sound_name, 'ping'), 'sound_volume', coalesce(s.sound_volume, 70),
    'show_preview', coalesce(s.show_preview, true), 'alert_when_visible', coalesce(s.alert_when_visible, false),
    'quiet_hours', s.quiet_hours, 'paused_until', case when s.paused_until = 'infinity' then 'infinity' else to_jsonb(s.paused_until) #>> '{}' end,
    'enabled_at', s.enabled_at, 'prompt_dismissed_at', s.prompt_dismissed_at, 'prompt_dismiss_count', coalesce(s.prompt_dismiss_count, 0),
    'kinds', kinds, 'muted', (f->>'muted')::boolean, 'now', now());
end $$;

-- Save any subset of the settings (every change saves at once). Extra keys:
--   prompt: 'dismissed' (Not now; the banner comes back once after 7 days) · 'answered'
--   enabled: true (alerts turned on in some browser: stamps enabled_at once)
create or replace function outreach_alert_settings_save(p_ws uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare p jsonb := coalesce(p_patch, '{}'::jsonb); s outreach_notification_settings%rowtype; q jsonb; d jsonb; pu timestamptz;
begin
  perform outreach__alert_member(p_ws);
  if jsonb_typeof(p) <> 'object' then raise exception 'E_PAYLOAD_INVALID: patch'; end if;
  if not outreach_rate_limit('alert-settings:' || auth.uid()::text, 120, 60) then raise exception 'E_RATE_LIMITED'; end if;
  insert into outreach_notification_settings(user_id, workspace_id) values (auth.uid(), p_ws) on conflict do nothing;
  select * into s from outreach_notification_settings where user_id = auth.uid() and workspace_id = p_ws for update;

  if p ? 'scope' then
    if p->>'scope' not in ('mine', 'mine_unassigned', 'all') then raise exception 'E_PAYLOAD_INVALID: scope'; end if;
    s.scope := p->>'scope';
  end if;
  if p ? 'include_ai_handled' then s.include_ai_handled := coalesce((p->>'include_ai_handled')::boolean, false); end if;
  if p ? 'sound_enabled' then s.sound_enabled := coalesce((p->>'sound_enabled')::boolean, false); end if;
  if p ? 'sound_name' then
    if p->>'sound_name' not in ('ping', 'chime', 'pop', 'knock') then raise exception 'E_PAYLOAD_INVALID: sound_name'; end if;
    s.sound_name := p->>'sound_name';
  end if;
  if p ? 'sound_volume' then
    if jsonb_typeof(p->'sound_volume') <> 'number' or (p->>'sound_volume')::numeric not between 0 and 100 then raise exception 'E_PAYLOAD_INVALID: sound_volume'; end if;
    s.sound_volume := round((p->>'sound_volume')::numeric)::smallint;
  end if;
  if p ? 'show_preview' then s.show_preview := coalesce((p->>'show_preview')::boolean, true); end if;
  if p ? 'alert_when_visible' then s.alert_when_visible := coalesce((p->>'alert_when_visible')::boolean, false); end if;
  if p ? 'quiet_hours' then
    q := p->'quiet_hours';
    if q is null or jsonb_typeof(q) = 'null' then s.quiet_hours := null;
    else
      if jsonb_typeof(q) <> 'object' or coalesce(q->>'start', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(q->>'end', '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'E_PAYLOAD_INVALID: quiet_hours start / end (HH:MM)';
      end if;
      d := coalesce(q->'days', '[1,2,3,4,5,6,7]'::jsonb);
      if jsonb_typeof(d) <> 'array' or jsonb_array_length(d) = 0 or jsonb_array_length(d) > 7
         or exists (select 1 from jsonb_array_elements(d) x where jsonb_typeof(x) <> 'number' or (x #>> '{}')::numeric not in (1,2,3,4,5,6,7)) then
        raise exception 'E_PAYLOAD_INVALID: quiet_hours days (1 = Monday … 7 = Sunday)';
      end if;
      if not exists (select 1 from pg_timezone_names where name = coalesce(q->>'tz', '')) then raise exception 'E_PAYLOAD_INVALID: quiet_hours tz'; end if;
      s.quiet_hours := jsonb_build_object('days', (select jsonb_agg(distinct (x #>> '{}')::int) from jsonb_array_elements(d) x), 'start', q->>'start', 'end', q->>'end', 'tz', q->>'tz');
    end if;
  end if;
  if p ? 'paused_until' then
    if p->'paused_until' is null or jsonb_typeof(p->'paused_until') = 'null' then s.paused_until := null;
    elsif p->>'paused_until' = 'infinity' then s.paused_until := 'infinity';
    else
      begin pu := (p->>'paused_until')::timestamptz; exception when others then raise exception 'E_PAYLOAD_INVALID: paused_until'; end;
      if pu > now() + interval '31 days' then raise exception 'E_PAYLOAD_INVALID: pause for at most 31 days, or until turned back on'; end if;
      s.paused_until := case when pu <= now() then null else pu end;
    end if;
  end if;
  if coalesce((p->>'enabled')::boolean, false) then s.enabled_at := coalesce(s.enabled_at, now()); end if;
  if p->>'prompt' = 'dismissed' then
    s.prompt_dismissed_at := now(); s.prompt_dismiss_count := least(s.prompt_dismiss_count + 1, 99);
  elsif p->>'prompt' = 'answered' then
    s.prompt_dismissed_at := coalesce(s.prompt_dismissed_at, now()); s.prompt_dismiss_count := greatest(s.prompt_dismiss_count, 2);
  end if;

  update outreach_notification_settings set scope = s.scope, include_ai_handled = s.include_ai_handled, sound_enabled = s.sound_enabled,
         sound_name = s.sound_name, sound_volume = s.sound_volume, show_preview = s.show_preview, alert_when_visible = s.alert_when_visible,
         quiet_hours = s.quiet_hours, paused_until = s.paused_until, enabled_at = s.enabled_at, prompt_dismissed_at = s.prompt_dismissed_at,
         prompt_dismiss_count = s.prompt_dismiss_count, updated_at = now()
   where user_id = auth.uid() and workspace_id = p_ws;
  return outreach_alert_settings_get(p_ws);
end $$;

-- The alert table's Desktop / Sound ticks for one kind (email stays on the existing setter).
create or replace function outreach_alert_pref_set(p_ws uuid, p_kind text, p_desktop boolean default null, p_sound boolean default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__alert_member(p_ws);
  if p_kind not in ('reply_new', 'webchat_message', 'note_mention', 'ai_handoff', 'assigned') then raise exception 'E_PAYLOAD_INVALID: kind'; end if;
  insert into outreach_notification_prefs(user_id, workspace_id, kind, push, sound)
  values (auth.uid(), p_ws, p_kind, coalesce(p_desktop, true), p_sound)
  on conflict (user_id, workspace_id, kind) do update
    set push = coalesce(p_desktop, outreach_notification_prefs.push), sound = coalesce(p_sound, outreach_notification_prefs.sound), updated_at = now();
  return outreach_alert_settings_get(p_ws);
end $$;

-- Opening a conversation reads the caller's alerts on it (Realtime tells their other tabs and browsers to clear them).
create or replace function outreach_alerts_mark_chat_read(p_chat uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  update outreach_notifications set read_at = now(), updated_at = now()
   where user_id = auth.uid() and chat_id = p_chat and read_at is null and kind in ('reply_new', 'webchat_message', 'assigned');
  get diagnostics n = row_count;
  return n;
end $$;

-- The bell list (046) also returns what reply alerts carry; merged rows rise to the top by updated_at.
create or replace function outreach_notifications_list(p_ws uuid, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'chat_id', x.chat_id, 'note_id', x.note_id, 'message_id', x.message_id,
                                                      'title', x.title, 'body', x.body, 'count', x.count, 'data', x.data, 'read_at', x.read_at, 'created_at', x.created_at, 'updated_at', x.updated_at,
                                                      'access', case when x.note_id is not null then coalesce((select outreach_note_visible(n.chat_id, n.visibility) and n.deleted_at is null from outreach_chat_notes n where n.id = x.note_id), false)
                                                                     when x.chat_id is not null then coalesce((select outreach_client_visible(c.workspace_id, c.client_id) from outreach_chats c where c.id = x.chat_id), false)
                                                                     else true end)
                                    order by x.updated_at desc)
                     from (select * from outreach_notifications where workspace_id = p_ws and user_id = auth.uid() order by updated_at desc limit greatest(1, least(p_limit, 200))) x), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------- Web Push subscriptions (this user's browsers)
-- Only real push services are accepted: F47 POSTs to the endpoint, so an arbitrary URL would be a request forgery hole.
create or replace function outreach__push_endpoint_ok(p_endpoint text) returns boolean
language sql immutable set search_path = public, extensions as $$
  select coalesce(p_endpoint, '') ~ '^https://([a-z0-9-]+\.)*(googleapis\.com|mozilla\.com|mozaws\.net|push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)(:443)?/'
$$;

create or replace function outreach_push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_label text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_push_subscriptions%rowtype;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  if not outreach__push_endpoint_ok(p_endpoint) or char_length(p_endpoint) > 2048 then raise exception 'E_PAYLOAD_INVALID: not a push service address'; end if;
  if coalesce(p_p256dh, '') !~ '^[A-Za-z0-9_-]{80,100}={0,2}$' or coalesce(p_auth, '') !~ '^[A-Za-z0-9_-]{16,32}={0,2}$' then raise exception 'E_PAYLOAD_INVALID: subscription keys'; end if;
  if not outreach_rate_limit('push-sub:' || auth.uid()::text, 30, 3600) then raise exception 'E_RATE_LIMITED'; end if;
  insert into outreach_push_subscriptions(user_id, endpoint, p256dh, auth, label)
  values (auth.uid(), p_endpoint, rtrim(p_p256dh, '='), rtrim(p_auth, '='), left(nullif(btrim(p_label), ''), 80))
  on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
    label = coalesce(excluded.label, outreach_push_subscriptions.label), last_seen_at = now(), failures = 0, last_error = null
  returning * into r;
  -- at most 20 browsers per person: the longest unused go first
  delete from outreach_push_subscriptions where id in (
    select id from outreach_push_subscriptions where user_id = auth.uid() order by last_seen_at desc offset 20);
  return jsonb_build_object('id', r.id, 'label', r.label, 'created_at', r.created_at, 'last_seen_at', r.last_seen_at);
end $$;

-- Remove this browser (turn off, log out) by endpoint, or another of the caller's browsers by id.
create or replace function outreach_push_unsubscribe(p_endpoint text default null, p_id uuid default null) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  delete from outreach_push_subscriptions where user_id = auth.uid() and ((p_endpoint is not null and endpoint = p_endpoint) or (p_id is not null and id = p_id));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function outreach_push_subscriptions_list() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'label', p.label, 'endpoint', p.endpoint, 'created_at', p.created_at, 'last_seen_at', p.last_seen_at,
                                                      'failing', p.failures > 0) order by p.last_seen_at desc)
                     from outreach_push_subscriptions p where p.user_id = auth.uid()), '[]'::jsonb);
end $$;

-- ============================================================================= 7. F47 support (service only)
create or replace function outreach_push_vapid() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return jsonb_build_object(
    'public', (select decrypted_secret from vault.decrypted_secrets where name = 'outreach_vapid_public' limit 1),
    'private_jwk', (select decrypted_secret from vault.decrypted_secrets where name = 'outreach_vapid_private_jwk' limit 1));
end $$;

-- First use: the function generated a key pair; keep it unless another caller won the race.
create or replace function outreach_push_vapid_init(p_public text, p_private_jwk text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if coalesce(p_public, '') !~ '^[A-Za-z0-9_-]{86,88}$' or coalesce(p_private_jwk, '') !~ '^\{.*"d"\s*:.*\}$' then raise exception 'E_PAYLOAD_INVALID: vapid keys'; end if;
  perform pg_advisory_xact_lock(hashtext('outreach_vapid_init'));
  if not exists (select 1 from vault.secrets where name = 'outreach_vapid_public') then
    perform vault.create_secret(p_private_jwk, 'outreach_vapid_private_jwk', 'Web Push VAPID private key (JWK) for outreach reply alerts');
    perform vault.create_secret(p_public, 'outreach_vapid_public', 'Web Push VAPID public key (base64url, uncompressed P-256)');
  end if;
  return outreach_push_vapid();
end $$;

-- Claim due pushes. Drops what no longer needs sending: the alert was read, a newer alert of the row superseded it, it is
-- older than its 1-hour time to live, or the person has no saved browser left. Returns ready-to-encrypt payloads.
create or replace function outreach_push_claim(p_limit int default 100) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out_ jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  delete from outreach_push_queue q using outreach_notifications n
   where n.id = q.notification_id and (n.read_at is not null or n.alerted_at is distinct from q.alerted_at or not n.alert_desktop);
  delete from outreach_push_queue q where q.created_at < now() - interval '1 hour' or q.attempts >= 6
     or not exists (select 1 from outreach_push_subscriptions p where p.user_id = q.user_id);
  with picked as (
    select q.id from outreach_push_queue q
     where q.next_at <= now() and (q.claimed_until is null or q.claimed_until < now())
     order by q.id limit greatest(1, least(p_limit, 500)) for update skip locked),
  upd as (
    update outreach_push_queue q set claimed_until = now() + interval '2 minutes', attempts = q.attempts + 1
      from picked where q.id = picked.id returning q.*)
  select coalesce(jsonb_agg(jsonb_build_object(
           'queue_id', u.id,
           'topic', replace(n.chat_id::text, '-', ''),
           'payload', jsonb_strip_nulls(jsonb_build_object(
              'v', 1, 'id', n.id, 'kind', n.kind, 'chat_id', n.chat_id, 'message_id', n.message_id, 'ws', n.workspace_id,
              'title', n.title, 'text', case when coalesce(st.show_preview, true) then coalesce(n.data->>'text', n.body) end,
              'preview', coalesce(st.show_preview, true), 'count', n.count, 'channel', n.data->>'channel', 'to', n.data->>'to',
              'ws_name', n.data->>'ws_name', 'sound', n.alert_sound, 'at', n.alerted_at)),
           'subs', (select jsonb_agg(jsonb_build_object('id', p.id, 'endpoint', p.endpoint, 'p256dh', p.p256dh, 'auth', p.auth))
                      from outreach_push_subscriptions p where p.user_id = u.user_id))), '[]'::jsonb)
    into out_
    from upd u join outreach_notifications n on n.id = u.notification_id
    left join outreach_notification_settings st on st.user_id = n.user_id and st.workspace_id = n.workspace_id;
  return out_;
end $$;

-- Results from F47: [{queue_id, done: bool, retry_after_s?: int, gone: [sub ids], failed: [{id, error}], sent: [sub ids]}]
create or replace function outreach_push_result(p_results jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r jsonb; gone int := 0; n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in select * from jsonb_array_elements(coalesce(p_results, '[]'::jsonb)) loop
    delete from outreach_push_subscriptions where id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(r->'gone', '[]'::jsonb)) x);
    get diagnostics n = row_count; gone := gone + n;
    update outreach_push_subscriptions p set failures = p.failures + 1, last_error = left(f->>'error', 300)
      from jsonb_array_elements(coalesce(r->'failed', '[]'::jsonb)) f where p.id = (f->>'id')::uuid;
    -- a browser refused 10 times in a row (403 after a key change, a revoked permission the service still reports) is gone
    delete from outreach_push_subscriptions where failures >= 10 and id in (select (f->>'id')::uuid from jsonb_array_elements(coalesce(r->'failed', '[]'::jsonb)) f);
    get diagnostics n = row_count; gone := gone + n;
    update outreach_push_subscriptions p set failures = 0, last_error = null
     where p.id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(r->'sent', '[]'::jsonb)) x) and p.failures > 0;
    if coalesce((r->>'done')::boolean, true) then
      delete from outreach_push_queue where id = (r->>'queue_id')::bigint;
    else
      update outreach_push_queue set claimed_until = null,
             next_at = now() + make_interval(secs => greatest(5, least(coalesce((r->>'retry_after_s')::int, 15 * attempts), 600)))
       where id = (r->>'queue_id')::bigint;
    end if;
  end loop;
  return jsonb_build_object('gone', gone);
end $$;

-- Daily: reply / assignment alerts older than 60 days and stale queue rows go.
create or replace function outreach_alerts_cleanup() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; b int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  delete from outreach_notifications where kind in ('reply_new', 'webchat_message', 'assigned') and updated_at < now() - interval '60 days';
  get diagnostics a = row_count;
  delete from outreach_push_queue where created_at < now() - interval '1 day';
  get diagnostics b = row_count;
  delete from outreach_push_subscriptions where failures >= 20 and last_seen_at < now() - interval '30 days';
  return jsonb_build_object('notifications', a, 'queue', b);
end $$;

-- ============================================================================= 8. grants
do $$
declare f record;
  app_fns text[] := array['outreach_alert_settings_get', 'outreach_alert_settings_save', 'outreach_alert_pref_set', 'outreach_alerts_mark_chat_read',
                          'outreach_push_subscribe', 'outreach_push_unsubscribe', 'outreach_push_subscriptions_list'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (p.proname like 'outreach\_alert%' or p.proname like 'outreach\_\_alert%' or p.proname like 'outreach\_push%' or p.proname like 'outreach\_\_push%'
                   or p.proname in ('outreach_trg_notification_alert', 'outreach_trg_notification_push', 'outreach_trg_message_alert', 'outreach_trg_message_alert_clear',
                                    'outreach_trg_message_alert_retract', 'outreach_trg_chat_alert')) loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke execute on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
-- the list RPC was replaced in place: it keeps its 046 grant, restated here
grant execute on function outreach_notifications_list(uuid, int) to authenticated;
