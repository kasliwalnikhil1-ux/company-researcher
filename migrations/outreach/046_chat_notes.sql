-- =============================================================================
-- Outreach Platform — 046 private notes (private-notes-PRD.md, 30 Sep 2026)
--
-- Internal team notes inside inbox conversations, with @mentions and an in-app notification centre.
-- Notes live in their OWN table (outreach_chat_notes), never in outreach_messages: no send path, reply detection,
-- classifier, digest, export or webhook can see a note unless code deliberately joins this table (PRD §3, §8).
--
-- Naming: outreach_note_* / outreach_notes_* / outreach_mentions_* / outreach_notifications_* — deliberately outside the
-- prefixes the 037/042 grant loops revoke (outreach_chat_ai_%, outreach_lead_notes_% …).
-- Writes go through SQL functions only (no insert/update/delete policies). Idempotent. Apply with scripts/outreach-sql.sh.
-- Cron jobs for the worker are in 047 (apply after `outreach-notes-worker` is deployed).
-- =============================================================================

alter table outreach_chats add column if not exists last_note_at timestamptz;

-- ----------------------------------------------------------------------------- tables
create table if not exists outreach_chat_notes (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references outreach_workspaces(id) on delete cascade,
  chat_id         uuid not null references outreach_chats(id) on delete cascade,
  lead_id         uuid references outreach_leads(id) on delete set null,        -- denormalised for the lead timeline
  client_id       uuid references outreach_clients(id) on delete set null,      -- denormalised (the chat's client at creation)
  author_id       uuid references auth.users(id) on delete set null,
  author_type     text not null default 'user' check (author_type in ('user','ai','system','agent')),
  body            text not null check (char_length(body) between 1 and 10000),  -- markdown subset + mention tokens @[Name](user:<uuid>)
  visibility      text not null default 'team' check (visibility in ('team','team_and_client')),
  mentions        uuid[] not null default '{}',
  attachments     jsonb not null default '[]',                                  -- [{path, name, size, mime, width?, height?}]
  exclude_from_ai boolean generated always as (body like '#no-ai%') stored,
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid references auth.users(id) on delete set null,
  purged_at       timestamptz,
  created_at      timestamptz not null default now(),
  search_tsv      tsvector generated always as (to_tsvector('simple', coalesce(body, ''))) stored
);
create index if not exists outreach_chat_notes_chat_idx on outreach_chat_notes(chat_id, created_at);
create index if not exists outreach_chat_notes_lead_idx on outreach_chat_notes(lead_id, created_at desc);
create index if not exists outreach_chat_notes_ws_idx on outreach_chat_notes(workspace_id, created_at desc);
create index if not exists outreach_chat_notes_tsv_idx on outreach_chat_notes using gin(search_tsv);
create index if not exists outreach_chat_notes_att_idx on outreach_chat_notes using gin(attachments jsonb_path_ops);
create index if not exists outreach_chat_notes_deleted_idx on outreach_chat_notes(deleted_at) where deleted_at is not null and purged_at is null;

create table if not exists outreach_chat_note_revisions (
  note_id    uuid not null references outreach_chat_notes(id) on delete cascade,
  revision   int not null,
  body       text not null,
  edited_by  uuid references auth.users(id) on delete set null,
  edited_at  timestamptz not null default now(),
  primary key (note_id, revision)
);

create table if not exists outreach_chat_note_mentions (
  note_id      uuid not null references outreach_chat_notes(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  chat_id      uuid not null references outreach_chats(id) on delete cascade,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  emailed_at   timestamptz,
  primary key (note_id, user_id)
);
create index if not exists outreach_chat_note_mentions_user_idx on outreach_chat_note_mentions(user_id, read_at, created_at desc);
create index if not exists outreach_chat_note_mentions_due_idx on outreach_chat_note_mentions(created_at) where read_at is null and emailed_at is null;

-- Notification centre (bell). kind: note_mention | ai_handoff | assigned | …
create table if not exists outreach_notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,
  chat_id      uuid references outreach_chats(id) on delete cascade,
  note_id      uuid references outreach_chat_notes(id) on delete cascade,
  actor_id     uuid references auth.users(id) on delete set null,
  title        text not null,
  body         text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_notifications_user_idx on outreach_notifications(user_id, read_at, created_at desc);
create index if not exists outreach_notifications_ws_user_idx on outreach_notifications(workspace_id, user_id, created_at desc);

create table if not exists outreach_notification_prefs (
  user_id         uuid not null references auth.users(id) on delete cascade,
  workspace_id    uuid not null references outreach_workspaces(id) on delete cascade,
  kind            text not null,
  push            boolean not null default true,
  email           boolean not null default true,
  email_delay_min int not null default 10 check (email_delay_min in (10, 30, 60)),
  updated_at      timestamptz not null default now(),
  primary key (user_id, workspace_id, kind)
);

alter table outreach_chat_notes enable row level security;
alter table outreach_chat_note_revisions enable row level security;
alter table outreach_chat_note_mentions enable row level security;
alter table outreach_notifications enable row level security;
alter table outreach_notification_prefs enable row level security;

-- ----------------------------------------------------------------------------- storage: private bucket, files only reachable through notes
insert into storage.buckets (id, name, public, file_size_limit)
values ('outreach-chat-notes', 'outreach-chat-notes', false, 26214400)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- ----------------------------------------------------------------------------- access helpers
-- Can a given user (not necessarily the caller) read a note with this visibility on this chat? Membership + client scope;
-- client viewers only see notes shared with the client. Used by mention parsing, the email job and the JSON builders.
create or replace function outreach__user_can_read_chat_note(p_user uuid, p_chat uuid, p_visibility text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from outreach_chats c join outreach_members m on m.workspace_id = c.workspace_id
     where c.id = p_chat and m.user_id = p_user
       and (m.role in ('owner','manager') or c.client_id is null or c.client_id = any(m.client_ids))
       and (p_visibility = 'team_and_client' or m.role <> 'client_viewer'))
$$;

-- The caller's view of a chat's notes (RLS + RPCs): service sees everything; otherwise the chat must be visible and a
-- client viewer only sees team_and_client notes.
create or replace function outreach_note_visible(p_chat uuid, p_visibility text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select outreach_is_service() or exists (
    select 1 from outreach_chats c
     where c.id = p_chat and c.workspace_id in (select outreach_workspace_ids())
       and outreach_client_visible(c.workspace_id, c.client_id)
       and (p_visibility = 'team_and_client' or outreach_role_in(c.workspace_id) <> 'client_viewer'))
$$;

create or replace function outreach_can_read_note(p_note uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select outreach_note_visible(n.chat_id, n.visibility) from outreach_chat_notes n where n.id = p_note), false)
$$;

-- Storage policy hook: a file is readable when a live note that carries it is readable by the caller.
create or replace function outreach_note_attachment_readable(p_path text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select exists (
    select 1 from outreach_chat_notes n
     where n.deleted_at is null and n.attachments @> jsonb_build_array(jsonb_build_object('path', p_path))
       and outreach_note_visible(n.chat_id, n.visibility))
$$;

drop policy if exists outreach_chat_notes_read on storage.objects;
create policy outreach_chat_notes_read on storage.objects for select to authenticated
  using (bucket_id = 'outreach-chat-notes' and outreach_note_attachment_readable(name));
-- no insert policy: uploads go through signed upload URLs issued by outreach-note-attachment after an access check

-- RLS (select only; writes are function-only)
select outreach__policy('outreach_chat_notes', 'chat_notes_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and outreach_note_visible(chat_id, visibility)');
select outreach__policy('outreach_chat_note_revisions', 'chat_note_revisions_select', 'select',
  'exists (select 1 from outreach_chat_notes n where n.id = note_id and (n.author_id = auth.uid() or outreach_role_in(n.workspace_id) in (''owner'',''manager'')) and outreach_note_visible(n.chat_id, n.visibility))');
select outreach__policy('outreach_chat_note_mentions', 'chat_note_mentions_select', 'select',
  'user_id = auth.uid() or outreach_can_read_note(note_id)');
select outreach__policy('outreach_notifications', 'notifications_select', 'select', 'user_id = auth.uid()');
select outreach__policy('outreach_notification_prefs', 'notification_prefs_select', 'select', 'user_id = auth.uid()');

-- ----------------------------------------------------------------------------- text helpers
-- A person's label inside a workspace (display name → auth name → email); null when they are no longer a member.
create or replace function outreach__note_user_label(p_ws uuid, p_user uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(m.display_name, u.raw_user_meta_data->>'full_name', m.email::text, u.email::text)
    from outreach_members m left join auth.users u on u.id = m.user_id
   where m.workspace_id = p_ws and m.user_id = p_user
$$;

-- Mention tokens → "@Name" for previews, notifications and AI context.
create or replace function outreach__note_plain(p_body text) returns text
language sql immutable set search_path = public, extensions as $$
  select regexp_replace(coalesce(p_body, ''), '@\[([^\]]{1,80})\]\(user:[0-9a-fA-F-]{36}\)', '@\1', 'g')
$$;

create or replace function outreach__note_author_label(p_ws uuid, p_author uuid, p_author_type text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case p_author_type
           when 'ai' then 'AI'
           when 'system' then 'System'
           when 'agent' then 'Claude (via ' || coalesce(outreach__note_user_label(p_ws, p_author), 'a former member') || ')'
           else coalesce(outreach__note_user_label(p_ws, p_author), 'Former member') end
$$;

-- Parse mention tokens server-side: keeps users who can read this note (dedupes, drops the author, caps at 20).
-- Returns {kept: uuid[], dropped: [{user_id, name, reason}]} — reason: no_access | self | cap | not_member.
create or replace function outreach__note_parse_mentions(p_ws uuid, p_chat uuid, p_visibility text, p_body text, p_author uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare m text[]; uid uuid; nm text; kept uuid[] := '{}'; seen uuid[] := '{}'; dropped jsonb := '[]'::jsonb;
begin
  for m in select regexp_matches(coalesce(p_body, ''), '@\[([^\]]{1,80})\]\(user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)', 'g') loop
    nm := m[1]; uid := m[2]::uuid;
    if uid = any(seen) then continue; end if;
    seen := array_append(seen, uid);
    if p_author is not null and uid = p_author then
      dropped := dropped || jsonb_build_object('user_id', uid, 'name', nm, 'reason', 'self');
    elsif not exists (select 1 from outreach_members mm where mm.workspace_id = p_ws and mm.user_id = uid) then
      dropped := dropped || jsonb_build_object('user_id', uid, 'name', nm, 'reason', 'not_member');
    elsif not outreach__user_can_read_chat_note(uid, p_chat, p_visibility) then
      dropped := dropped || jsonb_build_object('user_id', uid, 'name', nm, 'reason', 'no_access');
    elsif cardinality(kept) >= 20 then
      dropped := dropped || jsonb_build_object('user_id', uid, 'name', nm, 'reason', 'cap');
    else
      kept := array_append(kept, uid);
    end if;
  end loop;
  return jsonb_build_object('kept', to_jsonb(kept), 'dropped', dropped);
end $$;

-- Human title of a chat for notification text: "Priya Nair (Razorpay)".
create or replace function outreach__note_chat_title(p_chat uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(nullif(l.full_name, ''), nullif(c.attendee_name, ''), nullif(c.subject, ''), 'a conversation')
         || case when nullif(l.company, '') is not null then ' (' || l.company || ')' else '' end
    from outreach_chats c left join outreach_leads l on l.id = c.lead_id where c.id = p_chat
$$;

-- ----------------------------------------------------------------------------- JSON shape (one builder, three surfaces)
create or replace function outreach__note_json(n outreach_chat_notes) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', n.id, 'chat_id', n.chat_id, 'lead_id', n.lead_id, 'client_id', n.client_id, 'workspace_id', n.workspace_id,
    'author', jsonb_build_object('id', n.author_id, 'type', n.author_type, 'name', outreach__note_author_label(n.workspace_id, n.author_id, n.author_type),
                                 'former', n.author_type in ('user','agent') and (n.author_id is null or outreach__note_user_label(n.workspace_id, n.author_id) is null)),
    'body', case when n.deleted_at is null then n.body end,
    'visibility', n.visibility,
    'mentions', coalesce((select jsonb_agg(jsonb_build_object('user_id', u, 'name', coalesce(outreach__note_user_label(n.workspace_id, u), 'former member'),
                                                              'read_at', mm.read_at, 'access', outreach__user_can_read_chat_note(u, n.chat_id, n.visibility)) order by ord)
                            from unnest(n.mentions) with ordinality as x(u, ord)
                            left join outreach_chat_note_mentions mm on mm.note_id = n.id and mm.user_id = u), '[]'::jsonb),
    'attachments', case when n.deleted_at is null then n.attachments else '[]'::jsonb end,
    'exclude_from_ai', n.exclude_from_ai, 'edited_at', n.edited_at,
    'revisions', (select count(*) from outreach_chat_note_revisions r where r.note_id = n.id),
    'deleted_at', n.deleted_at,
    'deleted_by', case when n.deleted_at is not null then coalesce(outreach__note_user_label(n.workspace_id, n.deleted_by), case when n.deleted_by is null then 'System' else 'a former member' end) end,
    'created_at', n.created_at)
$$;

-- ----------------------------------------------------------------------------- notifications (internal writers)
create or replace function outreach__note_notify_mentions(n outreach_chat_notes, p_users uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare u uuid; k int := 0; who text; title text; snippet text; ttl text;
begin
  if p_users is null or cardinality(p_users) = 0 then return 0; end if;
  who := outreach__note_author_label(n.workspace_id, n.author_id, n.author_type);
  ttl := outreach__note_chat_title(n.chat_id);
  snippet := left(regexp_replace(outreach__note_plain(n.body), '\s+', ' ', 'g'), 140);
  title := who || ' mentioned you in ' || ttl;
  foreach u in array p_users loop
    insert into outreach_chat_note_mentions(note_id, user_id, workspace_id, chat_id) values (n.id, u, n.workspace_id, n.chat_id) on conflict do nothing;
    insert into outreach_notifications(workspace_id, user_id, kind, chat_id, note_id, actor_id, title, body)
    values (n.workspace_id, u, 'note_mention', n.chat_id, n.id, n.author_id, title, snippet);
    k := k + 1;
  end loop;
  return k;
end $$;

-- Attachment list validation: array of ≤10 objects whose path sits under <ws>/<chat>/ and whose size is ≤ 25 MB.
create or replace function outreach__note_attachments_ok(p_ws uuid, p_chat uuid, p_att jsonb) returns jsonb
language plpgsql immutable set search_path = public, extensions as $$
declare a jsonb; out_ jsonb := '[]'::jsonb; p text;
begin
  if p_att is null or jsonb_typeof(p_att) <> 'array' then return '[]'::jsonb; end if;
  if jsonb_array_length(p_att) > 10 then raise exception 'E_PAYLOAD_INVALID: up to 10 attachments per note'; end if;
  for a in select * from jsonb_array_elements(p_att) loop
    p := a->>'path';
    if p is null or position(p_ws::text || '/' || p_chat::text || '/' in p) <> 1 or p like '%..%' then raise exception 'E_PAYLOAD_INVALID: attachment path does not belong to this conversation'; end if;
    if coalesce((a->>'size')::bigint, 0) > 26214400 then raise exception 'E_PAYLOAD_INVALID: attachment larger than 25 MB'; end if;
    out_ := out_ || jsonb_strip_nulls(jsonb_build_object('path', p, 'name', left(coalesce(a->>'name', split_part(p, '/', 4)), 200), 'size', (a->>'size')::bigint,
                                                          'mime', left(a->>'mime', 120), 'width', (a->>'width')::int, 'height', (a->>'height')::int));
  end loop;
  return out_;
end $$;

-- ----------------------------------------------------------------------------- write RPCs
-- Create a note. Any workspace member who can read the chat may write one (viewers included); a viewer's note is always
-- shared with the client. Sending rules (sender status, can_reply, AI state) do not apply: a note never leaves the team.
create or replace function outreach_note_create(p_chat uuid, p_body text, p_visibility text default 'team', p_attachments jsonb default '[]'::jsonb, p_author_type text default 'user') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; n outreach_chat_notes%rowtype; r outreach_role_t; vis text; body_ text; att jsonb; parsed jsonb; kept uuid[]; k int;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if auth.uid() is null then raise exception 'E_FORBIDDEN: a signed-in member is required (system notes use outreach_note_system_create)'; end if;
  if p_author_type not in ('user', 'agent') then raise exception 'E_PAYLOAD_INVALID: author_type'; end if;
  if not outreach_rate_limit('note:' || auth.uid()::text || ':' || p_author_type, case when p_author_type = 'agent' then 60 else 240 end, 3600) then raise exception 'E_RATE_LIMITED'; end if;
  r := outreach_role_in(c.workspace_id);
  vis := coalesce(nullif(p_visibility, ''), 'team');
  if vis not in ('team', 'team_and_client') then raise exception 'E_PAYLOAD_INVALID: visibility'; end if;
  if r = 'client_viewer' then vis := 'team_and_client'; end if;
  att := outreach__note_attachments_ok(c.workspace_id, c.id, p_attachments);
  body_ := btrim(coalesce(p_body, ''));
  if body_ = '' and jsonb_array_length(att) > 0 then
    select string_agg(x->>'name', ', ') into body_ from jsonb_array_elements(att) x;
  end if;
  if body_ = '' then raise exception 'E_PAYLOAD_INVALID: the note is empty'; end if;
  if char_length(body_) > 10000 then raise exception 'E_NOTE_BODY_TOO_LONG'; end if;
  parsed := outreach__note_parse_mentions(c.workspace_id, c.id, vis, body_, auth.uid());
  select coalesce(array_agg(x::uuid), '{}') into kept from jsonb_array_elements_text(parsed->'kept') x;
  insert into outreach_chat_notes(workspace_id, chat_id, lead_id, client_id, author_id, author_type, body, visibility, mentions, attachments)
  values (c.workspace_id, c.id, c.lead_id, c.client_id, auth.uid(), p_author_type, body_, vis, kept, att) returning * into n;
  k := outreach__note_notify_mentions(n, kept);
  update outreach_chats set last_note_at = n.created_at where id = c.id;
  perform outreach_audit(c.workspace_id, 'note.created', 'chat', c.id::text,
    jsonb_build_object('note_id', n.id, 'visibility', vis, 'mentions', cardinality(kept), 'attachments', jsonb_array_length(att), 'author_type', p_author_type), 'user');
  return outreach__note_json(n) || jsonb_build_object('dropped_mentions', parsed->'dropped');
end $$;

-- Service-only: AI / system notes (AI handoff summary). Mentions are still filtered by access; nobody is "self" here.
create or replace function outreach__note_system_create(p_chat uuid, p_body text, p_author_type text, p_mentions uuid[] default '{}', p_visibility text default 'team') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; n outreach_chat_notes%rowtype; body_ text; kept uuid[] := '{}'; u uuid; tokens text := ''; parsed jsonb;
begin
  if p_author_type not in ('ai', 'system') then raise exception 'E_PAYLOAD_INVALID: author_type'; end if;
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  body_ := left(btrim(coalesce(p_body, '')), 10000);
  if body_ = '' then raise exception 'E_PAYLOAD_INVALID: the note is empty'; end if;
  -- explicit mentions become tokens at the top of the body unless the body already carries them
  foreach u in array coalesce(p_mentions, '{}') loop
    if position('user:' || u::text in body_) = 0 and outreach__user_can_read_chat_note(u, c.id, p_visibility) then
      tokens := tokens || '@[' || coalesce(outreach__note_user_label(c.workspace_id, u), 'teammate') || '](user:' || u::text || ') ';
    end if;
  end loop;
  body_ := left(tokens || body_, 10000);
  parsed := outreach__note_parse_mentions(c.workspace_id, c.id, p_visibility, body_, null);
  select coalesce(array_agg(x::uuid), '{}') into kept from jsonb_array_elements_text(parsed->'kept') x;
  insert into outreach_chat_notes(workspace_id, chat_id, lead_id, client_id, author_id, author_type, body, visibility, mentions)
  values (c.workspace_id, c.id, c.lead_id, c.client_id, null, p_author_type, body_, p_visibility, kept) returning * into n;
  perform outreach__note_notify_mentions(n, kept);
  update outreach_chats set last_note_at = n.created_at where id = c.id;
  perform outreach_audit(c.workspace_id, 'note.created', 'chat', c.id::text, jsonb_build_object('note_id', n.id, 'visibility', p_visibility, 'mentions', cardinality(kept), 'author_type', p_author_type), 'system');
  return outreach__note_json(n);
end $$;

create or replace function outreach_note_system_create(p_chat uuid, p_body text, p_author_type text default 'system', p_mentions uuid[] default '{}', p_visibility text default 'team') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return outreach__note_system_create(p_chat, p_body, p_author_type, p_mentions, p_visibility);
end $$;

-- Edit body (author only) and/or visibility (author or manager). A revision keeps the previous body; only NEW mentions notify.
create or replace function outreach_note_update(p_note uuid, p_body text default null, p_visibility text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n outreach_chat_notes%rowtype; c outreach_chats%rowtype; r outreach_role_t; is_author boolean; vis text; body_ text; parsed jsonb; kept uuid[]; added uuid[]; removed uuid[]; rev int; changed_body boolean := false; changed_vis boolean := false;
begin
  select * into n from outreach_chat_notes where id = p_note and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into c from outreach_chats where id = n.chat_id;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_note_visible(c.id, n.visibility) then raise exception 'E_NOT_FOUND'; end if;
  r := outreach_role_in(c.workspace_id);
  is_author := n.author_id is not null and n.author_id = auth.uid() and n.author_type in ('user', 'agent');
  vis := coalesce(nullif(p_visibility, ''), n.visibility);
  if vis not in ('team', 'team_and_client') then raise exception 'E_PAYLOAD_INVALID: visibility'; end if;
  if vis <> n.visibility then
    if not (is_author or r in ('owner', 'manager')) then raise exception 'E_FORBIDDEN: only the author or a manager can change who sees a note'; end if;
    if r = 'client_viewer' and vis = 'team' then raise exception 'E_FORBIDDEN: a client viewer cannot hide a note from the client'; end if;
    changed_vis := true;
  end if;
  body_ := n.body;
  if p_body is not null then
    if not is_author then raise exception 'E_FORBIDDEN: only the author can edit a note'; end if;
    body_ := btrim(p_body);
    if body_ = '' then raise exception 'E_PAYLOAD_INVALID: the note is empty'; end if;
    if char_length(body_) > 10000 then raise exception 'E_NOTE_BODY_TOO_LONG'; end if;
    changed_body := body_ <> n.body;
  end if;
  if not changed_body and not changed_vis then return outreach__note_json(n) || jsonb_build_object('dropped_mentions', '[]'::jsonb); end if;
  if changed_body then
    select coalesce(max(revision), 0) + 1 into rev from outreach_chat_note_revisions where note_id = n.id;
    insert into outreach_chat_note_revisions(note_id, revision, body, edited_by) values (n.id, rev, n.body, auth.uid());
  end if;
  parsed := outreach__note_parse_mentions(c.workspace_id, c.id, vis, body_, n.author_id);
  select coalesce(array_agg(x::uuid), '{}') into kept from jsonb_array_elements_text(parsed->'kept') x;
  select coalesce(array_agg(u), '{}') into added from unnest(kept) u where not (u = any(n.mentions));
  select coalesce(array_agg(u), '{}') into removed from unnest(n.mentions) u where not (u = any(kept));
  update outreach_chat_notes set body = body_, visibility = vis, mentions = kept, edited_at = case when changed_body then now() else edited_at end where id = n.id returning * into n;
  if cardinality(removed) > 0 then delete from outreach_chat_note_mentions where note_id = n.id and user_id = any(removed); end if;
  perform outreach__note_notify_mentions(n, added);
  if changed_body then perform outreach_audit(c.workspace_id, 'note.edited', 'chat', c.id::text, jsonb_build_object('note_id', n.id, 'revision', rev, 'mentions_added', cardinality(added), 'mentions_removed', cardinality(removed)), 'user'); end if;
  if changed_vis then perform outreach_audit(c.workspace_id, 'note.visibility_changed', 'chat', c.id::text, jsonb_build_object('note_id', n.id, 'visibility', vis), 'user'); end if;
  return outreach__note_json(n) || jsonb_build_object('dropped_mentions', parsed->'dropped');
end $$;

-- Soft delete (author, or owner/manager). Leaves a placeholder; the body is purged by the worker after 30 days.
create or replace function outreach_note_delete(p_note uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare n outreach_chat_notes%rowtype; c outreach_chats%rowtype; r outreach_role_t;
begin
  select * into n from outreach_chat_notes where id = p_note and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into c from outreach_chats where id = n.chat_id;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_note_visible(c.id, n.visibility) then raise exception 'E_NOT_FOUND'; end if;
  r := outreach_role_in(c.workspace_id);
  if not ((n.author_id is not null and n.author_id = auth.uid()) or r in ('owner', 'manager')) then raise exception 'E_FORBIDDEN: only the author or a manager can delete a note'; end if;
  update outreach_chat_notes set deleted_at = now(), deleted_by = auth.uid() where id = n.id returning * into n;
  delete from outreach_chat_note_mentions where note_id = n.id;
  update outreach_notifications set read_at = coalesce(read_at, now()) where note_id = n.id;
  perform outreach_audit(c.workspace_id, 'note.deleted', 'chat', c.id::text, jsonb_build_object('note_id', n.id), 'user');
  return outreach__note_json(n);
end $$;

-- ----------------------------------------------------------------------------- read state
create or replace function outreach_note_mark_read(p_note uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; b int;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  update outreach_chat_note_mentions set read_at = now() where note_id = p_note and user_id = auth.uid() and read_at is null;
  get diagnostics a = row_count;
  update outreach_notifications set read_at = now() where note_id = p_note and user_id = auth.uid() and read_at is null;
  get diagnostics b = row_count;
  return jsonb_build_object('mentions', a, 'notifications', b);
end $$;

create or replace function outreach_mentions_mark_all_read(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; b int;
begin
  perform outreach_require(p_ws, 'client_viewer');
  update outreach_chat_note_mentions set read_at = now() where workspace_id = p_ws and user_id = auth.uid() and read_at is null;
  get diagnostics a = row_count;
  update outreach_notifications set read_at = now() where workspace_id = p_ws and user_id = auth.uid() and read_at is null;
  get diagnostics b = row_count;
  return jsonb_build_object('mentions', a, 'notifications', b);
end $$;

create or replace function outreach_notifications_mark_read(p_ids uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare a int;
begin
  if auth.uid() is null then raise exception 'E_FORBIDDEN'; end if;
  update outreach_notifications set read_at = now() where id = any(p_ids) and user_id = auth.uid() and read_at is null;
  get diagnostics a = row_count;
  update outreach_chat_note_mentions m set read_at = now()
    from outreach_notifications x where x.id = any(p_ids) and x.user_id = auth.uid() and x.note_id = m.note_id and m.user_id = auth.uid() and m.read_at is null;
  return a;
end $$;

-- ----------------------------------------------------------------------------- read RPCs
create or replace function outreach_notes_list(p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(outreach__note_json(n) order by n.created_at) from outreach_chat_notes n
                    where n.chat_id = p_chat and n.purged_at is null and outreach_note_visible(n.chat_id, n.visibility)), '[]'::jsonb);
end $$;

-- Lead timeline: notes from every conversation of the lead the caller can read (marked with chat + channel).
create or replace function outreach_notes_for_lead(p_lead uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(l.workspace_id, 'client_viewer');
  if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
    select outreach__note_json(n) || jsonb_build_object('chat', jsonb_build_object('id', c.id, 'provider', c.provider, 'attendee_name', c.attendee_name, 'sender_name', s.display_name)) as j, n.created_at
      from outreach_chat_notes n join outreach_chats c on c.id = n.chat_id left join outreach_senders s on s.id = c.sender_id
     where n.lead_id = p_lead and n.deleted_at is null and outreach_note_visible(n.chat_id, n.visibility)
     order by n.created_at desc limit greatest(1, least(p_limit, 200))) x), '[]'::jsonb);
end $$;

-- Full-text search over readable notes ("Private note" results in the inbox search).
create or replace function outreach_notes_search(p_ws uuid, p_q text, p_limit int default 20) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare q text; tsq tsquery;
begin
  perform outreach_require(p_ws, 'client_viewer');
  q := btrim(coalesce(p_q, ''));
  if char_length(q) < 2 then return '[]'::jsonb; end if;
  tsq := plainto_tsquery('simple', q);
  return coalesce((select jsonb_agg(x.j order by x.rank desc, x.created_at desc) from (
    select jsonb_build_object('note_id', n.id, 'chat_id', n.chat_id, 'created_at', n.created_at,
             'author', outreach__note_author_label(n.workspace_id, n.author_id, n.author_type),
             'snippet', left(ts_headline('simple', outreach__note_plain(n.body), tsq, 'StartSel=**,StopSel=**,MaxWords=18,MinWords=8,MaxFragments=1'), 240),
             'chat', jsonb_build_object('id', c.id, 'provider', c.provider, 'attendee_name', c.attendee_name, 'picture_url', c.attendee_picture_url, 'lead_name', l.full_name, 'company', l.company)) as j,
           ts_rank(n.search_tsv, tsq) as rank, n.created_at
      from outreach_chat_notes n join outreach_chats c on c.id = n.chat_id left join outreach_leads l on l.id = c.lead_id
     where n.workspace_id = p_ws and n.deleted_at is null
       and (n.search_tsv @@ tsq or outreach__note_plain(n.body) ilike '%' || q || '%')
       and outreach_note_visible(n.chat_id, n.visibility)
     order by ts_rank(n.search_tsv, tsq) desc, n.created_at desc limit greatest(1, least(p_limit, 50))) x), '[]'::jsonb);
end $$;

-- Revision history: the author or a manager.
create or replace function outreach_note_revisions(p_note uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare n outreach_chat_notes%rowtype; r outreach_role_t;
begin
  select * into n from outreach_chat_notes where id = p_note;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(n.workspace_id, 'client_viewer');
  if not outreach_note_visible(n.chat_id, n.visibility) then raise exception 'E_NOT_FOUND'; end if;
  r := outreach_role_in(n.workspace_id);
  if not ((n.author_id is not null and n.author_id = auth.uid()) or r in ('owner', 'manager')) then raise exception 'E_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('revision', v.revision, 'body', v.body, 'edited_at', v.edited_at,
                                                      'edited_by', coalesce(outreach__note_user_label(n.workspace_id, v.edited_by), 'former member')) order by v.revision)
                     from outreach_chat_note_revisions v where v.note_id = p_note), '[]'::jsonb);
end $$;

-- The Mentions view: one row per conversation where the caller was mentioned, unread first, then newest.
create or replace function outreach_mentions_list(p_ws uuid, p_unread_only boolean default false, p_limit int default 100) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return coalesce((select jsonb_agg(x.j order by x.unread desc, x.created_at desc) from (
    select distinct on (m.chat_id)
           jsonb_build_object('chat_id', m.chat_id, 'note_id', m.note_id, 'created_at', m.created_at, 'read_at', m.read_at,
             'unread_count', (select count(*) from outreach_chat_note_mentions m2 where m2.chat_id = m.chat_id and m2.user_id = auth.uid() and m2.read_at is null),
             'author', outreach__note_author_label(n.workspace_id, n.author_id, n.author_type),
             'snippet', left(regexp_replace(outreach__note_plain(n.body), '\s+', ' ', 'g'), 160),
             'chat', jsonb_build_object('id', c.id, 'provider', c.provider, 'attendee_name', c.attendee_name, 'picture_url', c.attendee_picture_url, 'subject', c.subject,
                                        'lead_name', l.full_name, 'company', l.company, 'lead_picture_url', l.picture_url, 'last_message_at', c.last_message_at, 'sender_name', s.display_name)) as j,
           (m.read_at is null) as unread, m.created_at
      from outreach_chat_note_mentions m
      join outreach_chat_notes n on n.id = m.note_id and n.deleted_at is null
      join outreach_chats c on c.id = m.chat_id left join outreach_leads l on l.id = c.lead_id left join outreach_senders s on s.id = c.sender_id
     where m.workspace_id = p_ws and m.user_id = auth.uid() and (not p_unread_only or m.read_at is null)
       and outreach_note_visible(n.chat_id, n.visibility)
     order by m.chat_id, (m.read_at is null) desc, m.created_at desc) x
    limit greatest(1, least(p_limit, 500))), '[]'::jsonb);
end $$;

create or replace function outreach_notifications_list(p_ws uuid, p_limit int default 30) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'kind', x.kind, 'chat_id', x.chat_id, 'note_id', x.note_id, 'title', x.title, 'body', x.body, 'read_at', x.read_at, 'created_at', x.created_at,
                                                      'access', case when x.note_id is null then true else coalesce((select outreach_note_visible(n.chat_id, n.visibility) and n.deleted_at is null from outreach_chat_notes n where n.id = x.note_id), false) end)
                                    order by x.created_at desc)
                     from (select * from outreach_notifications where workspace_id = p_ws and user_id = auth.uid() order by created_at desc limit greatest(1, least(p_limit, 200))) x), '[]'::jsonb);
end $$;

-- Badge numbers for the bell and the Mentions tab.
create or replace function outreach_notes_badge(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return jsonb_build_object(
    'unread_mentions', (select count(*) from outreach_chat_note_mentions m join outreach_chat_notes n on n.id = m.note_id and n.deleted_at is null
                         where m.workspace_id = p_ws and m.user_id = auth.uid() and m.read_at is null),
    'unread_notifications', (select count(*) from outreach_notifications where workspace_id = p_ws and user_id = auth.uid() and read_at is null));
end $$;

-- ----------------------------------------------------------------------------- preferences
create or replace function outreach_notification_prefs_get(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return coalesce((select jsonb_object_agg(p.kind, jsonb_build_object('push', p.push, 'email', p.email, 'email_delay_min', p.email_delay_min))
                     from outreach_notification_prefs p where p.workspace_id = p_ws and p.user_id = auth.uid()), '{}'::jsonb);
end $$;

create or replace function outreach_notification_prefs_set(p_ws uuid, p_kind text, p_email boolean, p_email_delay_min int default 10, p_push boolean default true) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_kind not in ('note_mention', 'ai_handoff', 'assigned') then raise exception 'E_PAYLOAD_INVALID: kind'; end if;
  if p_email_delay_min not in (10, 30, 60) then raise exception 'E_PAYLOAD_INVALID: email_delay_min'; end if;
  insert into outreach_notification_prefs(user_id, workspace_id, kind, push, email, email_delay_min)
  values (auth.uid(), p_ws, p_kind, coalesce(p_push, true), coalesce(p_email, true), p_email_delay_min)
  on conflict (user_id, workspace_id, kind) do update set push = excluded.push, email = excluded.email, email_delay_min = excluded.email_delay_min, updated_at = now();
  return outreach_notification_prefs_get(p_ws);
end $$;

-- ----------------------------------------------------------------------------- worker support (service only)
-- Mentions that are still unread past the person's email delay and were never emailed. The worker groups them per
-- person + conversation. The recipient must still be able to read the note (scope may have changed since).
create or replace function outreach_note_mentions_due(p_limit int default 200) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'note_id', m.note_id, 'user_id', m.user_id, 'workspace_id', m.workspace_id, 'chat_id', m.chat_id, 'created_at', m.created_at,
      'email', coalesce(mem.email::text, u.email::text),
      'to_name', coalesce(mem.display_name, u.raw_user_meta_data->>'full_name'),
      'author', outreach__note_author_label(n.workspace_id, n.author_id, n.author_type),
      'body', outreach__note_plain(n.body), 'visibility', n.visibility,
      'chat_title', outreach__note_chat_title(m.chat_id), 'provider', c.provider, 'client_id', c.client_id) order by m.user_id, m.chat_id, m.created_at)
    from outreach_chat_note_mentions m
    join outreach_chat_notes n on n.id = m.note_id and n.deleted_at is null
    join outreach_chats c on c.id = m.chat_id
    join outreach_members mem on mem.workspace_id = m.workspace_id and mem.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    left join outreach_notification_prefs p on p.user_id = m.user_id and p.workspace_id = m.workspace_id and p.kind = 'note_mention'
   where m.read_at is null and m.emailed_at is null
     and coalesce(p.email, true)
     and m.created_at <= now() - make_interval(mins => coalesce(p.email_delay_min, 10))
     and outreach__user_can_read_chat_note(m.user_id, m.chat_id, n.visibility)
   limit greatest(1, least(p_limit, 1000))), '[]'::jsonb);
end $$;

create or replace function outreach_note_mentions_mark_emailed(p_pairs jsonb) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare k int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_chat_note_mentions m set emailed_at = now()
    from jsonb_to_recordset(coalesce(p_pairs, '[]'::jsonb)) as x(note_id uuid, user_id uuid)
   where m.note_id = x.note_id and m.user_id = x.user_id and m.emailed_at is null;
  get diagnostics k = row_count;
  return k;
end $$;

-- Last messages of a conversation for the mention email (context), service only.
create or replace function outreach_note_email_context(p_chat uuid, p_n int default 3) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('from', case when x.direction = 'in' then 'them' else 'us' end, 'text', left(coalesce(x.text, x.transcript, '[attachment]'), 400), 'at', x.sent_at) order by x.sent_at)
                     from (select m.direction, m.text, m.transcript, m.sent_at from outreach_messages m where m.chat_id = p_chat and m.deleted_at is null and m.event_type is null order by m.sent_at desc limit greatest(1, least(p_n, 10))) x), '[]'::jsonb);
end $$;

-- Hard-purge bodies and attachments of notes deleted more than 30 days ago. Returns the storage paths to remove.
create or replace function outreach_notes_purge() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare paths jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(a->>'path'), '[]'::jsonb) into paths
    from outreach_chat_notes n, jsonb_array_elements(n.attachments) a
   where n.deleted_at < now() - interval '30 days' and n.purged_at is null;
  delete from outreach_chat_note_revisions r using outreach_chat_notes n where r.note_id = n.id and n.deleted_at < now() - interval '30 days' and n.purged_at is null;
  update outreach_chat_notes set body = '(purged)', attachments = '[]'::jsonb, mentions = '{}', purged_at = now()
   where deleted_at < now() - interval '30 days' and purged_at is null;
  return paths;
end $$;

-- ----------------------------------------------------------------------------- AI context (§7.2)
-- The last 10 live team notes of a chat for the reply engine: guidance only, never quoted. `#no-ai` notes are excluded.
create or replace function outreach__team_notes_for_ai(p_chat uuid, p_limit int default 10) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((select jsonb_agg(jsonb_build_object('author', outreach__note_author_label(x.workspace_id, x.author_id, x.author_type), 'text', left(outreach__note_plain(x.body), 1500), 'at', x.created_at) order by x.created_at)
                     from (select n.* from outreach_chat_notes n where n.chat_id = p_chat and n.deleted_at is null and not n.exclude_from_ai
                            order by n.created_at desc limit greatest(1, least(p_limit, 20))) x), '[]'::jsonb)
$$;

-- gate_facts gains a `team_notes` key (patched in place, like 029: anchor on the 'lead_notes', notes pair).
do $$
declare def text; nd text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_ai_reply_gate_facts';
  if def is null then raise exception 'outreach_ai_reply_gate_facts not found'; end if;
  if position('team_notes' in def) > 0 then return; end if;
  nd := replace(def, $q$'faqs', faqs, 'lead_notes', notes,$q$, $q$'faqs', faqs, 'lead_notes', notes, 'team_notes', outreach__team_notes_for_ai(c.id, 10),$q$);
  if nd = def then raise exception 'outreach_ai_reply_gate_facts: anchor not found'; end if;
  execute nd;
end $$;

-- ----------------------------------------------------------------------------- AI handoff writes a system note (§7.2)
-- After the handoff task: a note by "AI" that mentions the assignee — reason, rule, the lead-notes summary and their last words.
create or replace function outreach__note_on_ai_handoff(p_chat uuid, p_reason text, p_rule text, p_assignee uuid, p_label text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; nm text; summ text; last_in text; body_ text; j jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then return null; end if;
  select coalesce(l.full_name, c.attendee_name, 'the lead') into nm from outreach_leads l where l.id = c.lead_id;
  nm := coalesce(nm, c.attendee_name, 'the lead');
  if c.lead_id is not null then select left(n.summary, 400) into summ from outreach_lead_ai_notes n where n.lead_id = c.lead_id; end if;
  select left(regexp_replace(coalesce(m.text, m.transcript, ''), '\s+', ' ', 'g'), 200) into last_in
    from outreach_messages m where m.chat_id = c.id and m.direction = 'in' and m.deleted_at is null and m.event_type is null order by m.sent_at desc limit 1;
  body_ := concat_ws(E'\n',
    'over to you — ' || coalesce(nullif(p_label, ''), 'AI handed off') || case when p_rule is not null and p_reason = 'stop_rule' then '' else case when p_rule is not null then ' (' || left(p_rule, 120) || ')' else '' end end || '.',
    case when nullif(summ, '') is not null then 'Summary: ' || summ end,
    case when nullif(last_in, '') is not null then 'Last from ' || nm || ': “' || last_in || '”' end,
    'The AI will not answer here again unless you resume it.');
  j := outreach__note_system_create(c.id, body_, 'ai', case when p_assignee is null then '{}'::uuid[] else array[p_assignee] end, 'team');
  return (j->>'id')::uuid;
end $$;

do $$
declare def text; nd text;
begin
  select pg_get_functiondef(p.oid) into def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'outreach_ai_handoff';
  if def is null then raise exception 'outreach_ai_handoff not found'; end if;
  if position('outreach__note_on_ai_handoff' in def) > 0 then return; end if;
  nd := replace(def,
    $q$    returning id into tid;
  end if;
  perform outreach_audit(c.workspace_id, 'ai_reply.handed_off'$q$,
    $q$    returning id into tid;
    perform outreach__note_on_ai_handoff(p_chat, p_reason, p_rule, assignee, lbl);
  end if;
  perform outreach_audit(c.workspace_id, 'ai_reply.handed_off'$q$);
  if nd = def then raise exception 'outreach_ai_handoff: anchor not found'; end if;
  execute nd;
end $$;

-- ----------------------------------------------------------------------------- realtime
do $$ begin alter publication supabase_realtime add table outreach_chat_notes; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table outreach_chat_note_mentions; exception when duplicate_object then null; when undefined_object then null; end $$;
do $$ begin alter publication supabase_realtime add table outreach_notifications; exception when duplicate_object then null; when undefined_object then null; end $$;

-- ----------------------------------------------------------------------------- grants
do $$
declare f record;
  app_fns text[] := array['outreach_note_create','outreach_note_update','outreach_note_delete','outreach_note_mark_read','outreach_mentions_mark_all_read',
    'outreach_notifications_mark_read','outreach_notes_list','outreach_notes_for_lead','outreach_notes_search','outreach_note_revisions','outreach_mentions_list',
    'outreach_notifications_list','outreach_notes_badge','outreach_notification_prefs_get','outreach_notification_prefs_set',
    'outreach_note_visible','outreach_can_read_note','outreach_note_attachment_readable'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
              and (p.proname like 'outreach\_note%' or p.proname like 'outreach\_notes%' or p.proname like 'outreach\_\_note%' or p.proname like 'outreach\_mentions%'
                   or p.proname like 'outreach\_notification%' or p.proname like 'outreach\_can\_read\_note' or p.proname like 'outreach\_\_team\_notes%' or p.proname like 'outreach\_\_user\_can\_read\_chat\_note') loop
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke execute on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
