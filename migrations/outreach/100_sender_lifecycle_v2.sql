-- =============================================================================
-- 100 — Sender lifecycle v1.2 (sender-lifecycle-PRD.md v1.2 §5.8–§5.10, D12–D18): who is told, when, and the billing clock
--
--   Holder model (§5.8.1, D13)   "Whose account is this?": owner_user_id XOR owner_email; connected_by; outreach_sender_holder /
--                                _email_recipients / _set_holder / _holder_left; a one-off migration of existing senders.
--   Disconnect alerts (§5.8)     disconnected_at and the holder / team email clock on the row; mass-disconnect holds (§5.8.4);
--                                in-app alerts (kind sender_disconnected); the team-email query for F60.
--   Pause reason (§3.2, D5)      pause_reason manual | billing | system, kept by trigger; a billing pause cannot be lifted by hand.
--   Billing clock (§5.9, D15–17) workspaces.billing_status (derived, never drifts), billing_emails, the overdue invoice,
--                                outreach_billing_steps (each step once), the due-steps query (10:00 local for emails) and the
--                                step effects; cancellation removes senders at once and keeps data 60 days (§5.10).
--   removed_via                  gains 'canceled'.
-- Deviations are listed in docs/outreach/SENDER-LIFECYCLE.md. Idempotent. Requires 096 and 099.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/100_sender_lifecycle_v2.sql
-- =============================================================================

create or replace function outreach__patch_fn(p_fn regprocedure, p_marker text, p_old text, p_new text) returns void language plpgsql as $$
declare def text := replace(pg_get_functiondef(p_fn), chr(13), '');
begin
  p_old := replace(p_old, chr(13), ''); p_new := replace(p_new, chr(13), '');
  if position(p_marker in def) > 0 then return; end if;
  if position(p_old in def) = 0 then raise exception '%: anchor not found, patch not applied: %', p_fn, left(p_old, 80); end if;
  execute replace(def, p_old, p_new);
end $$;

-- -----------------------------------------------------------------------------
-- 1. Columns
-- -----------------------------------------------------------------------------
alter table outreach_senders
  add column if not exists pause_reason            text check (pause_reason is null or pause_reason in ('manual','billing','system')),
  add column if not exists connected_by            uuid references auth.users(id),
  add column if not exists holder_notified_at      timestamptz,               -- first sign-in email of this disconnect
  add column if not exists holder_reminders_sent   smallint not null default 0,
  add column if not exists holder_email_held_until timestamptz,               -- §5.8.4 hold
  add column if not exists team_notified_at        timestamptz,               -- last combined team email that listed it
  add column if not exists team_final_notified_at  timestamptz,               -- the day-7 "disable it or remove it" mention
  add column if not exists last_reconnected_at     timestamptz;
-- disconnected_at existed (billing v2, never written since 096 moved removals to removed_at): it is the PRD's "entered credentials/error" from here on
update outreach_senders set disconnected_at = null where disconnected_at is not null and status::text not in ('credentials','error');
update outreach_senders set disconnected_at = coalesce(last_disconnect_at, updated_at) where disconnected_at is null and status::text in ('credentials','error') and deleted_at is null;
comment on column outreach_senders.disconnected_at is 'When the sender entered credentials / error; cleared on ok (sender lifecycle §5.8). Not the removal time: that is removed_at.';
comment on column outreach_senders.pause_reason is 'manual = a person paused it (manual replies still go out) · billing = the workspace is suspended (read-only) · system = health / provider warning';

create index if not exists outreach_senders_disconnected_idx on outreach_senders(workspace_id, disconnected_at) where status in ('credentials','error') and deleted_at is null;
create index if not exists outreach_senders_holder_user_idx on outreach_senders(owner_user_id) where owner_user_id is not null;

alter table outreach_senders drop constraint if exists outreach_senders_removed_via_check;
alter table outreach_senders add constraint outreach_senders_removed_via_check
  check (removed_via is null or removed_via in ('app','owner_link','unipile_deleted','auto_after_disabled','trial_ended','workspace_deleted','reconcile','billing','canceled'));

select outreach__patch_fn('public.outreach_sender_remove_begin(uuid,text,text,uuid)'::regprocedure, $q$'billing','canceled'$q$,
  $q$'workspace_deleted','reconcile','billing') then$q$, $q$'workspace_deleted','reconcile','billing','canceled') then$q$);
select outreach__patch_fn('public.outreach_disconnect_sender(uuid,text)'::regprocedure, $q$when 'billing_cancelled' then 'canceled'$q$,
  $q$when 'billing_cancelled' then 'billing'$q$, $q$when 'billing_cancelled' then 'canceled'$q$);

alter table outreach_sender_owner_links
  add column if not exists sent_to      citext,          -- the outside holder address the link was emailed to; the link dies when the holder changes
  add column if not exists cancelled_at timestamptz;

-- -----------------------------------------------------------------------------
-- 2. Holder model (§5.8.1): one-off migration of existing senders, then the constraint
--    On this build the connect wizard always wrote owner_user_id = the member who connected and owner_email = whatever was typed,
--    so owner_user_id is really connected_by. The PRD's table is applied with that reading:
--      typed email = the connecting member's own sign-in email  → Mine
--      typed email = another member's sign-in email             → that member
--      typed email = someone outside                            → Someone else's (owner_user_id null, connected_by copied)
--      no email                                                 → Mine (the connecting member)
-- -----------------------------------------------------------------------------
do $$
declare s record; me text; member_id uuid; n_mine int := 0; n_member int := 0; n_outside int := 0; ws_outside uuid[] := '{}';
begin
  if exists (select 1 from pg_constraint where conname = 'outreach_senders_one_holder') then return; end if;
  for s in select x.id, x.workspace_id, x.owner_user_id, lower(x.owner_email::text) oe, x.connected_by, x.status::text st, x.deleted_at from outreach_senders x loop
    if s.st = 'erased' or s.deleted_at is not null then
      update outreach_senders set owner_user_id = null, owner_email = null where id = s.id;
      continue;
    end if;
    if s.connected_by is null and s.owner_user_id is not null then update outreach_senders set connected_by = s.owner_user_id where id = s.id; end if;
    if s.oe is null then
      if s.owner_user_id is null then
        update outreach_senders set owner_user_id = (select m.user_id from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner' order by m.created_at limit 1) where id = s.id;
      end if;
      n_mine := n_mine + 1; continue;
    end if;
    me := case when s.owner_user_id is not null then outreach_user_email(s.owner_user_id) end;
    if me is not null and me = s.oe then
      update outreach_senders set owner_email = null where id = s.id; n_mine := n_mine + 1; continue;
    end if;
    select m.user_id into member_id from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and lower(u.email) = s.oe limit 1;
    if member_id is not null then
      update outreach_senders set owner_user_id = member_id, owner_email = null where id = s.id; n_member := n_member + 1; continue;
    end if;
    -- an outside address: keep it, the connecting member is copied
    update outreach_senders set owner_user_id = null where id = s.id;
    insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
    values (s.workspace_id, null, 'system', 'sender.holder_migrated', 'sender', s.id::text, jsonb_build_object('holder', 'outside', 'email', s.oe, 'connected_by', coalesce(s.connected_by, s.owner_user_id)));
    n_outside := n_outside + 1;
    if not (s.workspace_id = any(ws_outside)) then ws_outside := ws_outside || s.workspace_id; end if;
  end loop;
  -- rows that never connected and have nobody: the first owner
  update outreach_senders x set owner_user_id = (select m.user_id from outreach_members m where m.workspace_id = x.workspace_id and m.role = 'owner' order by m.created_at limit 1)
   where x.owner_user_id is null and x.owner_email is null and x.status::text <> 'erased';
  -- "These accounts send sign-in emails outside your team. Check they're right." (shown once on the senders page)
  update outreach_workspaces set settings = settings || jsonb_build_object('holder_review_pending', true) where id = any(ws_outside);
  raise notice '100: holders migrated: mine=% member=% outside=% (workspaces to review: %)', n_mine, n_member, n_outside, array_length(ws_outside, 1);
end $$;

do $$ begin
  alter table outreach_senders add constraint outreach_senders_one_holder check (
    status::text = 'erased' or deleted_at is not null or (owner_user_id is not null and owner_email is null) or (owner_user_id is null and owner_email is not null)
  ) not valid;
exception when duplicate_object then null; end $$;
alter table outreach_senders validate constraint outreach_senders_one_holder;

-- update_sender no longer writes owner_email (the holder is set through outreach_sender_set_holder)
select outreach__patch_fn('public.outreach_update_sender(uuid,jsonb)'::regprocedure, $q$owner_email = owner_email,$q$,
  $q$owner_email = case when p_patch ? 'owner_email' then nullif(p_patch->>'owner_email','')::citext else owner_email end,$q$,
  $q$owner_email = owner_email,$q$);

-- -----------------------------------------------------------------------------
-- 3. Who holds the account, and who gets its emails
-- -----------------------------------------------------------------------------
-- {kind: member | outside | member_left, user_id, email, name, connected_by, copy: [{user_id, email}], outside: bool}
create or replace function outreach_sender_holder(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; holder_email text; holder_name text; kind text; copy jsonb := '[]'::jsonb; cb_member boolean; to_user uuid;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.status::text = 'erased' then return jsonb_build_object('kind', 'none', 'outside', false); end if;
  cb_member := s.connected_by is not null and exists (select 1 from outreach_members m where m.workspace_id = s.workspace_id and m.user_id = s.connected_by);
  if s.owner_user_id is not null then
    if exists (select 1 from outreach_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_user_id) then
      to_user := s.owner_user_id; kind := 'member';
    else
      -- the holder left the workspace: the connecting member, else the owners (§5.8.1 "when the holder or connector leaves")
      kind := 'member_left';
      to_user := case when cb_member and s.connected_by <> s.owner_user_id then s.connected_by end;
    end if;
    if to_user is not null then
      holder_email := outreach_user_email(to_user);
      select coalesce(m.display_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)) into holder_name from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and m.user_id = to_user;
      return jsonb_build_object('kind', kind, 'user_id', to_user, 'email', holder_email, 'name', holder_name, 'connected_by', s.connected_by, 'copy', '[]'::jsonb, 'outside', false);
    end if;
    -- nobody left to hold it: every owner
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id))), '[]'::jsonb) into copy from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner';
    return jsonb_build_object('kind', 'member_left', 'user_id', null, 'email', null, 'name', null, 'connected_by', s.connected_by, 'owners', copy, 'copy', '[]'::jsonb, 'outside', false);
  end if;
  -- someone outside: the typed address; the connecting member is copied (the owners when they left or are unknown)
  if cb_member then
    copy := jsonb_build_array(jsonb_build_object('user_id', s.connected_by, 'email', outreach_user_email(s.connected_by)));
  else
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id))), '[]'::jsonb) into copy from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner';
  end if;
  return jsonb_build_object('kind', 'outside', 'user_id', null, 'email', lower(s.owner_email::text), 'name', s.display_name, 'connected_by', s.connected_by, 'copy', copy, 'outside', true);
end $$;
revoke execute on function outreach_sender_holder(uuid) from public, anon, authenticated;

-- the same, for signed-in members (the sender page, the connector): the outside address is shown, sign-in emails of members are not
create or replace function outreach_sender_holder_view(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; h jsonb; cb jsonb := null; mine boolean;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'member');
  h := outreach_sender_holder(p_sender);
  if s.connected_by is not null then
    select jsonb_build_object('user_id', m.user_id, 'name', coalesce(m.display_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)), 'member', true) into cb
      from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and m.user_id = s.connected_by;
  end if;
  mine := coalesce((h->>'user_id') is not null and (h->>'user_id')::uuid = auth.uid(), false);
  return jsonb_build_object('kind', h->>'kind', 'user_id', h->'user_id', 'name', h->>'name', 'mine', mine,
    'email', case when h->>'kind' = 'outside' then h->>'email' when mine then h->>'email' else null end,
    'connected_by', cb, 'copied_to', (select coalesce(jsonb_agg(c->>'email'), '[]'::jsonb) from jsonb_array_elements(coalesce(h->'copy', '[]'::jsonb)) c),
    'can_change', outreach_is_service() or coalesce(outreach_role_in(s.workspace_id) in ('owner','manager'), false) or mine,
    'holder_notified_at', s.holder_notified_at, 'holder_reminders_sent', s.holder_reminders_sent, 'holder_email_held_until', s.holder_email_held_until, 'disconnected_at', s.disconnected_at);
end $$;
grant execute on function outreach_sender_holder_view(uuid) to authenticated;
revoke execute on function outreach_sender_holder_view(uuid) from public, anon;

-- p_kind 'holder' → {to, to_user_id, outside, cc:[{user_id,email}], holder_name, kind}; 'team' → {recipients:[{user_id,email,role}]}
-- Owners and managers; for a client-scoped sender only managers who see that client. Read at send time; nothing is cached.
create or replace function outreach_sender_email_recipients(p_sender uuid, p_kind text default 'holder') returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; h jsonb; team jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_kind = 'team' then
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id), 'role', m.role) order by m.role, m.created_at), '[]'::jsonb) into team
      from outreach_members m where m.workspace_id = s.workspace_id and m.role in ('owner','manager')
       and (m.role = 'owner' or s.client_id is null or m.client_ids = '{}' or s.client_id = any(m.client_ids)) and outreach_user_email(m.user_id) is not null;
    return jsonb_build_object('recipients', team);
  end if;
  h := outreach_sender_holder(p_sender);
  if h->>'kind' = 'none' then return jsonb_build_object('to', null, 'outside', false, 'cc', '[]'::jsonb, 'kind', 'none'); end if;
  if h->>'kind' = 'member_left' and (h->>'email') is null then
    -- nobody holds it any more: the first owner gets it, the other owners are copied
    return jsonb_build_object('to', h#>>'{owners,0,email}', 'to_user_id', (h#>>'{owners,0,user_id}')::uuid, 'outside', false,
      'cc', (select coalesce(jsonb_agg(o), '[]'::jsonb) from jsonb_array_elements(h->'owners') with ordinality as t(o, i) where i > 1), 'holder_name', null, 'kind', 'member_left');
  end if;
  return jsonb_build_object('to', h->>'email', 'to_user_id', (h->>'user_id')::uuid, 'outside', coalesce((h->>'outside')::boolean, false), 'cc', coalesce(h->'copy', '[]'::jsonb), 'holder_name', h->>'name', 'kind', h->>'kind');
end $$;
revoke execute on function outreach_sender_email_recipients(uuid, text) from public, anon, authenticated;

-- Whose account → Change (§5.8.1). p_holder = {"mine": true} | {"email": "..."}. A member can mark an account Mine only for themselves.
-- Returns {old, new, notify_member (a teammate set as holder by someone else), old_outside_email, links_cancelled, grants_revoked}
create or replace function outreach_sender_set_holder(p_sender uuid, p_holder jsonb, p_by uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; actor uuid := coalesce(p_by, auth.uid()); r outreach_role_t; em text; actor_email text; member_id uuid;
        new_user uuid; new_email text; old_user uuid; old_email text; notify_member uuid := null; n_links int := 0; n_grants int := 0; n2 int; changed boolean;
begin
  select * into s from outreach_senders where id = p_sender for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.status::text = 'erased' then raise exception 'E_CONFLICT: an erased sender has no holder'; end if;
  if not outreach_is_service() then
    r := outreach_role_in(s.workspace_id);
    if r is null then raise exception 'E_FORBIDDEN: not a member of workspace'; end if;
    if r not in ('owner','manager') and not (s.owner_user_id is not null and s.owner_user_id = actor) then raise exception 'E_FORBIDDEN: only a manager or the person who holds this account can change it'; end if;
  end if;
  if actor is null then raise exception 'E_PAYLOAD_INVALID: the person making the change is required'; end if;
  actor_email := outreach_user_email(actor);
  old_user := s.owner_user_id; old_email := lower(s.owner_email::text);
  if coalesce((p_holder->>'mine')::boolean, false) then
    new_user := actor; new_email := null;
  else
    em := lower(trim(coalesce(p_holder->>'email', '')));
    if em = '' or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: enter the email of the person who signs in to this account'; end if;
    if em = actor_email then
      new_user := actor; new_email := null;                       -- typed their own sign-in email: Mine (edge case table)
    else
      select m.user_id into member_id from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and lower(u.email) = em limit 1;
      if member_id is not null then new_user := member_id; new_email := null; notify_member := member_id;
      else new_user := null; new_email := em; end if;
    end if;
  end if;
  changed := new_user is distinct from old_user or new_email is distinct from old_email;
  if not changed then return jsonb_build_object('changed', false, 'holder', outreach_sender_holder(p_sender)); end if;
  update outreach_senders set owner_user_id = new_user, owner_email = new_email::citext, connected_by = coalesce(connected_by, actor), updated_at = now() where id = p_sender;
  -- open sign-in, permission and disconnect links die with the old holder
  update outreach_sender_owner_links set cancelled_at = now() where sender_id = p_sender and used_at is null and cancelled_at is null and expires_at > now();
  get diagnostics n_links = row_count;
  update outreach_ai_reply_consent_links set cancelled_at = now() where sender_id = p_sender and used_at is null and cancelled_at is null and expires_at > now();
  get diagnostics n2 = row_count; n_links := n_links + n2;
  update outreach_profile_authority_links set expires_at = now() where sender_id = p_sender and accepted_at is null and declined_at is null and expires_at > now();
  get diagnostics n2 = row_count; n_links := n_links + n2;
  -- grants were the old holder's; the new one grants again
  update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'holder_changed' where sender_id = p_sender and revoked_at is null;
  get diagnostics n_grants = row_count;
  update outreach_profile_authority set revoked_at = now(), revoked_reason = 'holder_changed', revoked_by = actor where sender_id = p_sender and revoked_at is null;
  get diagnostics n2 = row_count; n_grants := n_grants + n2;
  insert into outreach_sender_events(sender_id, kind, data) values (p_sender, 'lifecycle', jsonb_build_object('action', 'holder_changed', 'by', actor,
    'from', jsonb_build_object('user_id', old_user, 'email', old_email), 'to', jsonb_build_object('user_id', new_user, 'email', new_email), 'links_cancelled', n_links, 'grants_revoked', n_grants));
  perform outreach_audit(s.workspace_id, 'sender.holder_changed', 'sender', p_sender::text,
    jsonb_build_object('from', jsonb_build_object('user_id', old_user, 'email', old_email), 'to', jsonb_build_object('user_id', new_user, 'email', new_email), 'links_cancelled', n_links, 'grants_revoked', n_grants),
    case when outreach_is_service() and p_by is null then 'system' else 'user' end);
  return jsonb_build_object('changed', true, 'old', jsonb_build_object('user_id', old_user, 'email', old_email), 'new', jsonb_build_object('user_id', new_user, 'email', new_email),
    'notify_member', notify_member, 'old_outside_email', case when old_user is null then old_email end, 'links_cancelled', n_links, 'grants_revoked', n_grants, 'holder', outreach_sender_holder(p_sender));
end $$;
grant execute on function outreach_sender_set_holder(uuid, jsonb, uuid) to authenticated;
revoke execute on function outreach_sender_set_holder(uuid, jsonb, uuid) from public, anon;

-- A member left (or was removed): accounts they held pass to the connecting member, else the first owner, with a task for the
-- owners per account; their operator grants end; outside-held accounts they connected copy the owners from now on.
create or replace function outreach_sender_holder_left(p_ws uuid, p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s record; new_holder uuid; first_owner uuid; who text; n_moved int := 0; n_tasks int := 0; n_grants int := 0; n2 int;
begin
  select m.user_id into first_owner from outreach_members m where m.workspace_id = p_ws and m.role = 'owner' and m.user_id <> p_user order by m.created_at limit 1;
  who := coalesce((select coalesce(m.display_name, u.raw_user_meta_data->>'full_name', u.email) from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = p_ws and m.user_id = p_user), 'A teammate');
  for s in select x.id, x.display_name, x.client_id, x.connected_by from outreach_senders x where x.workspace_id = p_ws and x.owner_user_id = p_user and x.deleted_at is null and x.status::text <> 'erased' loop
    new_holder := case when s.connected_by is not null and s.connected_by <> p_user and exists (select 1 from outreach_members m where m.workspace_id = p_ws and m.user_id = s.connected_by) then s.connected_by else first_owner end;
    if new_holder is null then continue; end if;   -- the last owner: nothing to hand over to
    update outreach_senders set owner_user_id = new_holder, updated_at = now() where id = s.id;
    n_moved := n_moved + 1;
    insert into outreach_tasks(workspace_id, client_id, kind, sender_id, node_id, title, body, due_at, assigned_to, source)
    values (p_ws, s.client_id, 'follow_up', s.id, 'holder_left', who || ' has left. Who looks after ' || coalesce(s.display_name, 'this account') || '?',
            'Sign-in links and notices about this account now go to ' || case when new_holder = s.connected_by then 'the member who connected it' else 'the workspace owner' end ||
            '. Set the right person on the sender page (Whose account → Change).', now() + interval '7 days', first_owner, 'system');
    n_tasks := n_tasks + 1;
    update outreach_ai_reply_consent set revoked_at = now(), revoked_reason = 'holder_left' where sender_id = s.id and revoked_at is null and granted_via = 'owner_is_operator';
    get diagnostics n2 = row_count; n_grants := n_grants + n2;
    update outreach_profile_authority set revoked_at = now(), revoked_reason = 'holder_left' where sender_id = s.id and revoked_at is null and granted_via = 'owner_is_operator';
    get diagnostics n2 = row_count; n_grants := n_grants + n2;
    insert into outreach_sender_events(sender_id, kind, data) values (s.id, 'lifecycle', jsonb_build_object('action', 'holder_left', 'left', p_user, 'now', new_holder));
  end loop;
  -- outside-held accounts they connected: the owners are copied from now on (connected_by cleared)
  update outreach_senders set connected_by = null where workspace_id = p_ws and connected_by = p_user and owner_user_id is null;
  perform outreach_audit(p_ws, 'sender.holder_left', 'member', p_user::text, jsonb_build_object('senders_moved', n_moved, 'tasks', n_tasks, 'grants_revoked', n_grants), 'system');
  return jsonb_build_object('senders_moved', n_moved, 'tasks', n_tasks, 'grants_revoked', n_grants);
end $$;
revoke execute on function outreach_sender_holder_left(uuid, uuid) from public, anon, authenticated;

create or replace function outreach_remove_member(p_ws uuid, p_user uuid)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'owner');
  if p_user = auth.uid() then raise exception 'E_FORBIDDEN: cannot remove yourself'; end if;
  perform outreach_sender_holder_left(p_ws, p_user);
  delete from outreach_members where workspace_id = p_ws and user_id = p_user;
  perform outreach_audit(p_ws, 'member.removed', 'member', p_user::text);
end $$;

-- owner links carry the address they were sent to (§4): a link dies when the holder changes
drop function if exists outreach_sender_owner_link_create(uuid, text, int);
create or replace function outreach_sender_owner_link_create(p_sender uuid, p_purpose text, p_ttl_days int default 30, p_sent_to text default null) returns text
language plpgsql security definer set search_path = public, extensions as $$
declare tok text; s outreach_senders%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_purpose not in ('disconnect','erase_request') then raise exception 'E_PAYLOAD_INVALID: purpose'; end if;
  select * into s from outreach_senders where id = p_sender and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.owner_user_id is not null then raise exception 'E_CONFLICT: a member''s own account has no disconnect link; they disconnect it on the sender page'; end if;
  tok := encode(gen_random_bytes(24), 'hex');
  insert into outreach_sender_owner_links(token_sha256, sender_id, purpose, expires_at, sent_to)
  values (encode(digest(tok, 'sha256'), 'hex'), p_sender, p_purpose, now() + make_interval(days => greatest(1, least(90, p_ttl_days))), lower(coalesce(p_sent_to, s.owner_email::text))::citext);
  delete from outreach_sender_owner_links where sender_id = p_sender and (expires_at < now() - interval '30 days' or used_at < now() - interval '30 days' or cancelled_at < now() - interval '30 days');
  return tok;
end $$;
revoke execute on function outreach_sender_owner_link_create(uuid, text, int, text) from public, anon, authenticated;

create or replace function outreach_sender_owner_link_peek(p_token text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_sender_owner_links%rowtype; s outreach_senders%rowtype; wname text; b jsonb; valid boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into l from outreach_sender_owner_links where token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  if not found then return jsonb_build_object('valid', false, 'reason', 'unknown'); end if;
  select * into s from outreach_senders where id = l.sender_id;
  select name, branding into wname, b from outreach_workspaces where id = s.workspace_id;
  valid := l.used_at is null and l.cancelled_at is null and l.expires_at > now() and (l.sent_to is null or (s.owner_user_id is null and s.owner_email = l.sent_to));
  return jsonb_build_object('valid', valid, 'used', l.used_at is not null, 'expired', l.expires_at <= now(), 'cancelled', l.cancelled_at is not null or (l.sent_to is not null and not (s.owner_user_id is null and s.owner_email = l.sent_to)),
    'purpose', l.purpose, 'expires_at', l.expires_at,
    'sender', jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'public_identifier', s.public_identifier, 'erase_scheduled_at', s.erase_scheduled_at),
    'workspace', jsonb_build_object('id', s.workspace_id, 'name', wname),
    'branding', coalesce(b, '{}'::jsonb) - 'email_from_address' - 'email_from_name');
end $$;
revoke execute on function outreach_sender_owner_link_peek(text) from public, anon, authenticated;

create or replace function outreach_sender_owner_link_use(p_token text, p_ip inet default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare l outreach_sender_owner_links%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_sender_owner_links k set used_at = now(), used_ip = p_ip
   where k.token_sha256 = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex') and k.used_at is null and k.cancelled_at is null and k.expires_at > now()
     and (k.sent_to is null or exists (select 1 from outreach_senders s where s.id = k.sender_id and s.owner_user_id is null and s.owner_email = k.sent_to))
   returning * into l;
  if not found then return jsonb_build_object('ok', false); end if;
  return jsonb_build_object('ok', true, 'sender_id', l.sender_id, 'purpose', l.purpose);
end $$;
revoke execute on function outreach_sender_owner_link_use(text, inet) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Disconnect tracking (§5.8), pause reason (§3.2), holds (§5.8.4), in-app alerts
-- -----------------------------------------------------------------------------
create table if not exists outreach_disconnect_holds (
  id           bigserial primary key,
  scope        text not null check (scope in ('workspace','platform')),
  workspace_id uuid references outreach_workspaces(id) on delete cascade,
  started_at   timestamptz not null default now(),
  held_until   timestamptz not null,
  extended     boolean not null default false,
  sender_count int not null,
  live_count   int,
  notified_at  timestamptz,
  detail       jsonb not null default '{}'::jsonb
);
create index if not exists outreach_disconnect_holds_until on outreach_disconnect_holds(held_until);
create index if not exists outreach_disconnect_holds_unnotified on outreach_disconnect_holds(id) where notified_at is null;
alter table outreach_disconnect_holds enable row level security;
revoke all on outreach_disconnect_holds from public, anon, authenticated;
grant select, insert, update, delete on outreach_disconnect_holds to service_role;
grant usage, select on sequence outreach_disconnect_holds_id_seq to service_role;

-- alerts the platform raises on its own learn the two disconnect kinds
do $$
declare def text; kinds text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conname = 'outreach_alerts_kind_check' and conrelid = 'outreach_alerts'::regclass;
  if def is null or position('sender_disconnected' in def) > 0 then return; end if;
  select array_agg(distinct k order by k) into kinds from (select unnest(array['ai_reply_downgraded','ai_reply_settings_moved','ai_reply_too_early','hold_expiring','import_failed','sender_running_dry','sequence_stalled','sender_disconnected','mass_disconnect']) k
                                                           union select kind from outreach_alerts) x;
  alter table outreach_alerts drop constraint outreach_alerts_kind_check;
  execute format('alter table outreach_alerts add constraint outreach_alerts_kind_check check (kind = any (%L::text[]))', kinds);
end $$;

-- the open hold that applies to a workspace right now (its own, or a platform-wide one); null = none
create or replace function outreach_disconnect_hold_until(p_ws uuid) returns timestamptz
language sql stable security definer set search_path = public, extensions as $$
  select max(h.held_until) from outreach_disconnect_holds h where h.held_until > now() and (h.scope = 'platform' or h.workspace_id = p_ws)
$$;
revoke execute on function outreach_disconnect_hold_until(uuid) from public, anon, authenticated;

-- §5.8.4 thresholds, checked after a sender enters credentials / error
create or replace function outreach__disconnect_hold_check(p_ws uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare n_recent int; n_live int; p_recent int; p_live int; hu timestamptz;
begin
  select count(*) filter (where s.disconnected_at > now() - interval '60 minutes'), count(*) filter (where s.status::text in ('ok','credentials','error','paused') and s.unipile_account_id is not null)
    into n_recent, n_live
    from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null and s.provider::text <> 'WEBCHAT' and s.status::text in ('ok','credentials','error','paused');
  if n_recent >= 3 and n_live > 0 and n_recent::numeric / n_live >= 0.30 and not exists (select 1 from outreach_disconnect_holds h where h.scope = 'workspace' and h.workspace_id = p_ws and h.held_until > now()) then
    hu := now() + interval '2 hours';
    insert into outreach_disconnect_holds(scope, workspace_id, held_until, sender_count, live_count) values ('workspace', p_ws, hu, n_recent, n_live);
    update outreach_senders set holder_email_held_until = hu where workspace_id = p_ws and status::text in ('credentials','error') and disconnected_at > now() - interval '60 minutes' and holder_notified_at is null;
    insert into outreach_alerts(workspace_id, kind, entity, entity_id, label, reason, detail)
    values (p_ws, 'mass_disconnect', 'workspace', p_ws, n_recent || ' accounts disconnected within an hour', 'Several accounts dropped at once. This is usually a LinkedIn or connector problem, not your accounts. Sign-in emails are held for 2 hours.',
            jsonb_build_object('senders', n_recent, 'live', n_live, 'held_until', hu))
    on conflict (kind, entity_id) where resolved_at is null do nothing;
    perform outreach_audit(p_ws, 'sender.mass_disconnect_hold', 'workspace', p_ws::text, jsonb_build_object('senders', n_recent, 'live', n_live, 'held_until', hu), 'system');
  end if;
  -- platform-wide: more than 10% of every live sender within an hour (needs at least 20 live senders and 3 drops to mean anything)
  select count(*) filter (where s.disconnected_at > now() - interval '60 minutes'), count(*) filter (where s.status::text in ('ok','credentials','error','paused') and s.unipile_account_id is not null)
    into p_recent, p_live
    from outreach_senders s where s.deleted_at is null and s.provider::text <> 'WEBCHAT' and s.status::text in ('ok','credentials','error','paused');
  if p_live >= 20 and p_recent >= 3 and p_recent::numeric / p_live > 0.10 and not exists (select 1 from outreach_disconnect_holds h where h.scope = 'platform' and h.held_until > now()) then
    hu := now() + interval '2 hours';
    insert into outreach_disconnect_holds(scope, workspace_id, held_until, sender_count, live_count) values ('platform', null, hu, p_recent, p_live);
    update outreach_senders set holder_email_held_until = hu where status::text in ('credentials','error') and disconnected_at > now() - interval '60 minutes' and holder_notified_at is null and deleted_at is null;
    insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff) values (null, null, 'system', 'platform.mass_disconnect_hold', 'platform', 'platform', jsonb_build_object('senders', p_recent, 'live', p_live, 'held_until', hu));
  end if;
end $$;
revoke execute on function outreach__disconnect_hold_check(uuid) from public, anon, authenticated;

-- a platform admin extends a hold by 2 hours, at most once (health page)
create or replace function outreach_disconnect_hold_extend(p_hold bigint) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare h outreach_disconnect_holds%rowtype;
begin
  if not outreach_is_service() and not platform_is_admin(auth.uid()) then raise exception 'E_FORBIDDEN'; end if;
  select * into h from outreach_disconnect_holds where id = p_hold for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if h.extended then raise exception 'E_CONFLICT: this hold was extended already'; end if;
  update outreach_disconnect_holds set held_until = greatest(held_until, now()) + interval '2 hours', extended = true where id = p_hold returning * into h;
  update outreach_senders set holder_email_held_until = h.held_until where status::text in ('credentials','error') and holder_notified_at is null and deleted_at is null and (h.scope = 'platform' or workspace_id = h.workspace_id);
  return jsonb_build_object('id', h.id, 'held_until', h.held_until);
end $$;
grant execute on function outreach_disconnect_hold_extend(bigint) to authenticated;
revoke execute on function outreach_disconnect_hold_extend(bigint) from public, anon;

-- lifecycle fields kept by trigger: disconnect clock, pause reason
create or replace function outreach_trg_sender_lifecycle_fields() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status is distinct from old.status then
    if new.status::text in ('credentials','error') and old.status::text not in ('credentials','error') then
      new.disconnected_at := now(); new.holder_notified_at := null; new.holder_reminders_sent := 0; new.team_notified_at := null; new.team_final_notified_at := null;
      new.holder_email_held_until := outreach_disconnect_hold_until(new.workspace_id);
    elsif new.status::text not in ('credentials','error') and old.status::text in ('credentials','error') then
      new.last_reconnected_at := case when new.status = 'ok' then now() else new.last_reconnected_at end;
      new.disconnected_at := null; new.holder_email_held_until := null;
    end if;
    if new.status = 'paused' and old.status <> 'paused' then
      new.paused_at := coalesce(new.paused_at, now());
      new.pause_reason := case when new.status_reason in ('billing_suspended','billing_cancelled','over_plan_limit','trial_expired') then 'billing'
                               when new.status_reason in ('user_paused') or new.paused_by is not null then 'manual'
                               else coalesce(new.pause_reason, 'system') end;
    elsif new.status <> 'paused' and old.status = 'paused' then
      new.pause_reason := null; new.paused_at := null; new.paused_by := null;
    end if;
  elsif new.status = 'paused' and new.status_reason is distinct from old.status_reason and new.status_reason in ('billing_suspended','billing_cancelled','over_plan_limit','trial_expired') then
    new.pause_reason := 'billing';
  end if;
  return new;
end $$;
drop trigger if exists outreach_sender_lifecycle_fields on outreach_senders;
create trigger outreach_sender_lifecycle_fields before update of status, status_reason on outreach_senders for each row execute function outreach_trg_sender_lifecycle_fields();

-- after the row is visible: the hold check and the in-app alert
create or replace function outreach_trg_sender_disconnect_alert() returns trigger language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status is distinct from old.status and new.deleted_at is null then
    if new.status::text in ('credentials','error') and old.status::text not in ('credentials','error') then
      insert into outreach_alerts(workspace_id, client_id, kind, entity, entity_id, label, reason, detail)
      values (new.workspace_id, new.client_id, 'sender_disconnected', 'sender', new.id, new.display_name, coalesce(new.display_name, 'An account') || ' needs signing in again', jsonb_build_object('status', new.status, 'status_reason', new.status_reason))
      on conflict (kind, entity_id) where resolved_at is null do nothing;
      perform outreach__disconnect_hold_check(new.workspace_id);
    elsif new.status::text not in ('credentials','error') and old.status::text in ('credentials','error') then
      update outreach_alerts set resolved_at = now() where kind = 'sender_disconnected' and entity_id = new.id and resolved_at is null;
    end if;
  end if;
  return null;
end $$;
drop trigger if exists outreach_sender_disconnect_alert on outreach_senders;
create trigger outreach_sender_disconnect_alert after update of status on outreach_senders for each row execute function outreach_trg_sender_disconnect_alert();

-- backfill the pause reason on rows paused before this migration
update outreach_senders set pause_reason = case when status_reason in ('billing_suspended','billing_cancelled','over_plan_limit','trial_expired') then 'billing' when status_reason = 'user_paused' or paused_by is not null then 'manual' else 'system' end
 where status = 'paused' and pause_reason is null;
update outreach_senders set pause_reason = null where status <> 'paused' and pause_reason is not null;

-- compose: a paused sender may reply unless the pause is for billing (send-reply checks the same)
create or replace function outreach_sender_can_reply(p_sender uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select s.deleted_at is null and s.unipile_account_id is not null and (s.status = 'ok' or (s.status = 'paused' and coalesce(s.pause_reason, 'manual') <> 'billing')) and outreach_plan_active(s.workspace_id)
    from outreach_senders s where s.id = p_sender
$$;
grant execute on function outreach_sender_can_reply(uuid) to authenticated;
revoke execute on function outreach_sender_can_reply(uuid) from public, anon;

-- the notification preference "Disconnected accounts (combined email after 4 hours)", default on
select outreach__patch_fn('public.outreach_notification_prefs_set(uuid,text,boolean,integer,boolean)'::regprocedure, $q$'sender_disconnected'$q$,
  $q$if p_kind not in ('note_mention', 'ai_handoff', 'assigned') then$q$, $q$if p_kind not in ('note_mention', 'ai_handoff', 'assigned', 'sender_disconnected') then$q$);

-- -----------------------------------------------------------------------------
-- 5. The F60 queries (§5.8.2–§5.8.3): sign-in emails due, team emails due
-- -----------------------------------------------------------------------------
-- Senders whose holder is owed a sign-in email or a reminder now. kind: first | reminder. Holds and suspended workspaces excluded.
create or replace function outreach_disconnect_holder_due(p_limit int default 100)
returns table(sender_id uuid, workspace_id uuid, kind text, reminders smallint, disconnected_at timestamptz, provider text, auth_method text, reconnect_attempts int)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
  select s.id, s.workspace_id,
         case when s.holder_notified_at is null then 'first' else 'reminder' end,
         s.holder_reminders_sent, s.disconnected_at, s.provider::text, s.auth_method::text, s.reconnect_attempts
    from outreach_senders s join outreach_workspaces w on w.id = s.workspace_id
   where s.deleted_at is null and s.status::text = 'credentials' and s.provider::text <> 'WEBCHAT' and s.unipile_account_id is not null and s.removal_requested_at is null
     and w.deleted_at is null and coalesce(w.billing_status, 'active') not in ('suspended','canceled','trial_expired')
     and (s.holder_email_held_until is null or s.holder_email_held_until <= now())
     and outreach_disconnect_hold_until(s.workspace_id) is null
     and (
          -- the first email: at once for a sign-in (credentials) account; a LinkedIn cookie account only after 4 failed retries (the worker retries hourly)
          (s.holder_notified_at is null and not (s.auth_method = 'cookie' and s.provider::text = 'LINKEDIN' and coalesce(s.reconnect_attempts, 0) < 4))
          -- exactly two reminders: day 1 and day 3 after the first email
       or (s.holder_notified_at is not null and s.holder_reminders_sent = 0 and s.holder_notified_at <= now() - interval '1 day')
       or (s.holder_notified_at is not null and s.holder_reminders_sent = 1 and s.holder_notified_at <= now() - interval '3 days'))
   order by s.disconnected_at
   limit greatest(1, p_limit);
end $$;
revoke execute on function outreach_disconnect_holder_due(int) from public, anon, authenticated;

create or replace function outreach_disconnect_holder_mark(p_sender uuid, p_kind text) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_kind = 'first' then
    update outreach_senders set holder_notified_at = now(), holder_reminders_sent = 0, reconnect_notified_at = now(), reconnect_reminders = 0 where id = p_sender;
  elsif p_kind = 'reset' then
    -- "Send a new sign-in link" on the sender page: the clock starts again
    update outreach_senders set holder_notified_at = now(), holder_reminders_sent = 0, holder_email_held_until = null, reconnect_notified_at = now(), reconnect_reminders = 0 where id = p_sender;
  else
    update outreach_senders set holder_reminders_sent = holder_reminders_sent + 1, reconnect_notified_at = now(), reconnect_reminders = reconnect_reminders + 1 where id = p_sender;
  end if;
end $$;
revoke execute on function outreach_disconnect_holder_mark(uuid, text) from public, anon, authenticated;

-- The combined team email per workspace (§5.8.3): accounts still down 4 h after their sign-in email, not listed in the last
-- 24 h, under 7 days down (or exactly the day-7 final mention), plus "Back online" since the last email, plus the recipients.
create or replace function outreach_disconnect_team_due() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare out jsonb := '[]'::jsonb; w record; senders jsonb; back jsonb; recips jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for w in select distinct s.workspace_id from outreach_senders s join outreach_workspaces x on x.id = s.workspace_id
            where s.deleted_at is null and s.status::text in ('credentials','error') and s.provider::text <> 'WEBCHAT' and s.removal_requested_at is null
              and x.deleted_at is null and coalesce(x.billing_status, 'active') not in ('suspended','canceled','trial_expired')
              and s.holder_notified_at is not null and s.holder_notified_at <= now() - interval '4 hours'
              and (s.team_notified_at is null or s.team_notified_at <= now() - interval '24 hours')
              and (s.disconnected_at > now() - interval '7 days' or s.team_final_notified_at is null)
              and outreach_disconnect_hold_until(s.workspace_id) is null loop
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'client_id', s.client_id, 'status', s.status, 'status_reason', s.status_reason,
             'disconnected_at', s.disconnected_at, 'holder_notified_at', s.holder_notified_at, 'reminders', s.holder_reminders_sent, 'auth_method', s.auth_method,
             'days_down', floor(extract(epoch from now() - s.disconnected_at) / 86400)::int,
             'final', s.disconnected_at <= now() - interval '7 days',
             'drops_today', (select count(*) from outreach_sender_events e where e.sender_id = s.id and e.kind = 'status' and e.at > now() - interval '24 hours' and e.data->>'to' in ('credentials','error')),
             'holder', outreach_sender_holder(s.id),
             'bounced', exists (select 1 from outreach_email_log l where l.sender_id = s.id and l.audience = 'holder' and l.delivery_status in ('bounced','suppressed') and l.sent_at > s.disconnected_at)) order by s.disconnected_at), '[]'::jsonb)
      into senders
      from outreach_senders s
     where s.workspace_id = w.workspace_id and s.deleted_at is null and s.status::text in ('credentials','error') and s.provider::text <> 'WEBCHAT' and s.removal_requested_at is null
       and s.holder_notified_at is not null and s.holder_notified_at <= now() - interval '4 hours'
       and (s.team_notified_at is null or s.team_notified_at <= now() - interval '24 hours')
       and (s.disconnected_at > now() - interval '7 days' or s.team_final_notified_at is null);
    select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'at', s.last_reconnected_at) order by s.last_reconnected_at desc), '[]'::jsonb)
      into back from outreach_senders s where s.workspace_id = w.workspace_id and s.deleted_at is null and s.status = 'ok' and s.last_reconnected_at > now() - interval '24 hours';
    select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id), 'role', m.role, 'client_ids', m.client_ids,
             'name', coalesce(m.display_name, split_part(outreach_user_email(m.user_id), '@', 1)))), '[]'::jsonb)
      into recips from outreach_members m where m.workspace_id = w.workspace_id and m.role in ('owner','manager') and outreach_user_email(m.user_id) is not null;
    out := out || jsonb_build_object('workspace_id', w.workspace_id, 'workspace_name', (select name from outreach_workspaces where id = w.workspace_id), 'senders', senders, 'back_online', back, 'recipients', recips);
  end loop;
  return out;
end $$;
revoke execute on function outreach_disconnect_team_due() from public, anon, authenticated;

create or replace function outreach_disconnect_team_mark(p_sender_ids uuid[], p_final_ids uuid[] default '{}') returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_senders set team_notified_at = now() where id = any(p_sender_ids);
  update outreach_senders set team_final_notified_at = now() where id = any(p_final_ids);
end $$;
revoke execute on function outreach_disconnect_team_mark(uuid[], uuid[]) from public, anon, authenticated;

-- holds whose "likely an outage" email has not gone out
create or replace function outreach_disconnect_holds_unnotified() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'scope', h.scope, 'workspace_id', h.workspace_id, 'workspace_name', w.name, 'held_until', h.held_until, 'sender_count', h.sender_count, 'live_count', h.live_count, 'started_at', h.started_at,
           'recipients', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id))), '[]'::jsonb) from outreach_members m where m.workspace_id = h.workspace_id and m.role in ('owner','manager')))), '[]'::jsonb)
    into out from outreach_disconnect_holds h left join outreach_workspaces w on w.id = h.workspace_id where h.notified_at is null;
  update outreach_disconnect_holds set notified_at = now() where notified_at is null;
  return out;
end $$;
revoke execute on function outreach_disconnect_holds_unnotified() from public, anon, authenticated;

-- the dispatcher row for F60 (every 15 min, only when there is a disconnected sender or an unannounced hold)
insert into outreach_cron_jobs (name, fn, body, every_s, guarded, note) values
  ('account-alerts', 'outreach-worker-account-alerts', '{"mode":"tick"}', 900, true, 'sign-in reminders, combined team emails, mass-disconnect holds (sender-lifecycle-PRD §5.8)')
on conflict (name) do update set fn = excluded.fn, body = excluded.body, every_s = excluded.every_s, guarded = excluded.guarded, note = excluded.note;
select outreach__patch_fn('public.outreach_cron_has_work(text)'::regprocedure, $q$when 'account-alerts' then$q$,
$q$    when 'inbound' then exists$q$,
$q$    when 'account-alerts' then exists (select 1 from outreach_senders x where x.deleted_at is null and x.status::text in ('credentials','error') and x.unipile_account_id is not null)
                               or exists (select 1 from outreach_disconnect_holds h where h.notified_at is null)
    when 'inbound' then exists$q$);

-- -----------------------------------------------------------------------------
-- 6. Billing state (§5.9, D15–D17)
-- -----------------------------------------------------------------------------
alter table outreach_workspaces
  add column if not exists billing_status           text not null default 'active',
  add column if not exists billing_action_required  boolean not null default false,
  add column if not exists overdue_invoice_id       text,
  add column if not exists overdue_invoice_url      text,
  add column if not exists billing_emails           citext[] not null default '{}';
do $$ begin
  alter table outreach_workspaces add constraint outreach_workspaces_billing_status_check check (billing_status in ('trialing','active','past_due','suspended','canceled','trial_expired'));
exception when duplicate_object then null; end $$;
comment on column outreach_workspaces.billing_status is 'trialing · active · past_due · suspended · canceled · trial_expired. Derived by trigger from plan / stripe_status / past_due_since (D17: plan keeps the plan name; plan_before_suspension names the plan to restore).';

create or replace function outreach_trg_workspace_billing_status() returns trigger language plpgsql as $$
begin
  new.billing_status := case when new.plan = 'suspended' then 'suspended'
                             when new.plan = 'cancelled' then 'canceled'
                             when new.plan = 'trial_expired' then 'trial_expired'
                             when coalesce(new.stripe_status, '') in ('past_due','unpaid') and new.past_due_since is not null then 'past_due'
                             when new.plan = 'trial' then 'trialing'
                             else 'active' end;
  if new.billing_status = 'active' then new.billing_action_required := false; new.overdue_invoice_id := null; new.overdue_invoice_url := null; end if;
  return new;
end $$;
drop trigger if exists outreach_workspace_billing_status on outreach_workspaces;
create trigger outreach_workspace_billing_status before insert or update on outreach_workspaces for each row execute function outreach_trg_workspace_billing_status();
update outreach_workspaces set billing_status = billing_status;   -- the trigger fills it in

create table if not exists outreach_billing_steps (
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  period_start  timestamptz not null,          -- past_due_since, or cancelled_at
  step          text not null check (step in ('d0','d3','d6','suspend','d14','remove','d60','erase','cancel_remove','cancel_d53','cancel_erase','reactivated')),
  done_at       timestamptz not null default now(),
  data          jsonb not null default '{}'::jsonb,
  primary key (workspace_id, period_start, step)
);
alter table outreach_billing_steps enable row level security;
revoke all on outreach_billing_steps from public, anon, authenticated;
grant select, insert, update, delete on outreach_billing_steps to service_role;

-- 60 days of read-only access after a cancellation (PRD v1.2 §5.10; was 90)
update outreach_flags set value = to_jsonb(60) where key = 'billing_cancel_data_days' and value = to_jsonb(90);
insert into outreach_flags(key, value) values ('billing_cancel_data_days', to_jsonb(60)) on conflict (key) do nothing;
-- the clock can run in "emails only" mode for its first week (rollout phase 5): suspend / remove / erase steps are recorded and alerted, not applied
insert into outreach_flags(key, value) values ('billing_clock_enforce', 'false'::jsonb) on conflict (key) do nothing;

-- owners + "Also send billing emails to" (D16), deduplicated
create or replace function outreach_billing_recipients(p_ws uuid) returns text[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(distinct e), '{}') from (
    select outreach_user_email(m.user_id) e from outreach_members m where m.workspace_id = p_ws and m.role = 'owner'
    union select lower(x::text) from outreach_workspaces w, unnest(w.billing_emails) x where w.id = p_ws) q where e is not null
$$;
revoke execute on function outreach_billing_recipients(uuid) from public, anon, authenticated;

create or replace function outreach_billing_emails_set(p_ws uuid, p_emails text[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare em text; cleaned citext[] := '{}';
begin
  perform outreach_require(p_ws, 'owner');
  if coalesce(array_length(p_emails, 1), 0) > 5 then raise exception 'E_PAYLOAD_INVALID: at most 5 extra billing contacts'; end if;
  foreach em in array coalesce(p_emails, '{}') loop
    em := lower(trim(em));
    if em = '' then continue; end if;
    if em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: "%" is not an email address', em; end if;
    if not (em::citext = any(cleaned)) then cleaned := cleaned || em::citext; end if;
  end loop;
  update outreach_workspaces set billing_emails = cleaned where id = p_ws;
  perform outreach_audit(p_ws, 'billing.contacts_changed', 'workspace', p_ws::text, jsonb_build_object('billing_emails', to_jsonb(cleaned)), 'user');
  return jsonb_build_object('billing_emails', to_jsonb(cleaned));
end $$;
grant execute on function outreach_billing_emails_set(uuid, text[]) to authenticated;
revoke execute on function outreach_billing_emails_set(uuid, text[]) from public, anon;

-- the billing clock as the app shows it (§8.5): status, dates of the next steps, contacts, the open invoice
create or replace function outreach_billing_clock(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; r outreach_role_t; base timestamptz; steps jsonb := '[]'::jsonb; owner boolean;
begin
  select * into w from outreach_workspaces where id = p_ws and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then r := outreach_role_in(p_ws); if r is null then raise exception 'E_FORBIDDEN'; end if; end if;
  owner := outreach_is_service() or r = 'owner';
  if w.billing_status in ('past_due','suspended') and w.past_due_since is not null then
    base := w.past_due_since;
    steps := jsonb_build_array(
      jsonb_build_object('step', 'suspend', 'label', 'Sending stops, workspace read-only', 'at', base + interval '7 days', 'done', w.billing_status = 'suspended'),
      jsonb_build_object('step', 'remove', 'label', 'Connected accounts disconnected (history kept)', 'at', base + interval '21 days', 'done', exists (select 1 from outreach_billing_steps b where b.workspace_id = p_ws and b.period_start = base and b.step = 'remove')),
      jsonb_build_object('step', 'erase', 'label', 'Workspace data deleted', 'at', base + interval '67 days', 'done', false));
  elsif w.billing_status = 'canceled' and w.cancelled_at is not null then
    base := w.cancelled_at;
    steps := jsonb_build_array(jsonb_build_object('step', 'erase', 'label', 'Workspace data deleted', 'at', coalesce(w.data_delete_after, base + interval '60 days'), 'done', false));
  end if;
  return jsonb_build_object('billing_status', w.billing_status, 'plan', w.plan, 'plan_before_suspension', w.plan_before_suspension, 'past_due_since', w.past_due_since, 'suspended_at', w.suspended_at,
    'cancelled_at', w.cancelled_at, 'cancel_at_period_end', w.cancel_at_period_end, 'current_period_end', w.current_period_end, 'data_delete_after', w.data_delete_after,
    'day', case when base is not null then floor(extract(epoch from now() - base) / 86400)::int end, 'steps', steps,
    'billing_action_required', w.billing_action_required, 'overdue_invoice_url', case when owner then w.overdue_invoice_url end,
    'billing_emails', case when owner then to_jsonb(w.billing_emails) else null end, 'read_only', not outreach_plan_active(p_ws),
    'owner_name', (select coalesce(m.display_name, split_part(outreach_user_email(m.user_id), '@', 1)) from outreach_members m where m.workspace_id = p_ws and m.role = 'owner' order by m.created_at limit 1),
    'removed_for_billing', (select count(*) from outreach_senders s where s.workspace_id = p_ws and s.status::text = 'removed' and s.removed_via in ('billing','canceled')),
    'paused_for_billing', (select count(*) from outreach_senders s where s.workspace_id = p_ws and s.status = 'paused' and s.pause_reason = 'billing' and s.deleted_at is null));
end $$;
grant execute on function outreach_billing_clock(uuid) to authenticated;
revoke execute on function outreach_billing_clock(uuid) from public, anon;

-- the steps the clock owes right now. Emails wait for 10:00 in the workspace's timezone (never later than 20 h after the day turns);
-- mechanical steps (suspend, remove, erase) run at the hour.
create or replace function outreach_billing_steps_due()
returns table(workspace_id uuid, step text, period_start timestamptz, day int, is_email boolean, data jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare w record; tz text; local_hour int; st record; ps timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for w in select x.* from outreach_workspaces x where x.deleted_at is null and not x.billing_comp
            and ((x.billing_status in ('past_due','suspended') and x.past_due_since is not null) or (x.billing_status = 'canceled' and x.cancelled_at is not null)) loop
    tz := outreach_ws_tz(w.id);
    local_hour := extract(hour from now() at time zone tz)::int;
    for st in select * from (values
        ('d0', 0, true, 'past_due'), ('d3', 3, true, 'past_due'), ('d6', 6, true, 'past_due'), ('suspend', 7, false, 'past_due'), ('d14', 14, true, 'past_due'),
        ('remove', 21, false, 'past_due'), ('d60', 60, true, 'past_due'), ('erase', 67, false, 'past_due'),
        ('cancel_remove', 0, false, 'canceled'), ('cancel_d53', 53, true, 'canceled'), ('cancel_erase', 60, false, 'canceled')) as v(name, d, email, mode) loop
      continue when (st.mode = 'past_due' and w.billing_status not in ('past_due','suspended')) or (st.mode = 'canceled' and w.billing_status <> 'canceled');
      ps := case when st.mode = 'past_due' then w.past_due_since else w.cancelled_at end;
      continue when ps + make_interval(days => st.d) > now();
      continue when st.email and st.d > 0 and local_hour < 10 and now() - (ps + make_interval(days => st.d)) < interval '20 hours';
      continue when exists (select 1 from outreach_billing_steps b where b.workspace_id = w.id and b.period_start = ps and b.step = st.name);
      workspace_id := w.id; step := st.name; day := st.d; is_email := st.email; period_start := ps;
      data := jsonb_build_object('plan', w.plan, 'plan_before_suspension', w.plan_before_suspension, 'past_due_since', w.past_due_since, 'cancelled_at', w.cancelled_at,
        'overdue_invoice_url', w.overdue_invoice_url, 'data_delete_after', coalesce(w.data_delete_after, ps + make_interval(days => case when st.mode = 'past_due' then 67 else 60 end)),
        'suspend_at', w.past_due_since + interval '7 days', 'remove_at', w.past_due_since + interval '21 days', 'erase_at', w.past_due_since + interval '67 days', 'tz', tz, 'name', w.name);
      return next;
    end loop;
  end loop;
end $$;
revoke execute on function outreach_billing_steps_due() from public, anon, authenticated;

create or replace function outreach_billing_step_claim(p_ws uuid, p_period timestamptz, p_step text, p_data jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_billing_steps(workspace_id, period_start, step, data) values (p_ws, p_period, p_step, coalesce(p_data, '{}'::jsonb)) on conflict do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke execute on function outreach_billing_step_claim(uuid, timestamptz, text, jsonb) from public, anon, authenticated;

-- the database side of a mechanical step; the edge function does the connector deletes, Storage and emails around it
--   suspend       → outreach_billing_suspend + data_delete_after = day 67
--   remove        → every live sender removed with 'billing' (the connector delete is queued; the hourly job drains it)
--   erase         → the workspace becomes cancelled with data_delete_after = now(); the daily deletion path purges it
--   cancel_remove → every live sender removed with 'canceled' (also done by outreach__billing_cancelled; idempotent)
--   cancel_erase  → data_delete_after = now()
create or replace function outreach_billing_step_apply(p_ws uuid, p_step text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; s record; n int := 0; r jsonb; accounts text[] := '{}'; senders uuid[] := '{}';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_step = 'suspend' then
    n := outreach_billing_suspend(p_ws, 'past_due_7d');
    update outreach_workspaces set data_delete_after = coalesce(data_delete_after, past_due_since + interval '67 days') where id = p_ws;
    perform outreach_sending_domains_plan_sync_ws(p_ws, true);
    return jsonb_build_object('senders_paused', n);
  elsif p_step in ('remove', 'cancel_remove') then
    for s in select x.id, x.unipile_account_id from outreach_senders x where x.workspace_id = p_ws and x.deleted_at is null and x.provider::text <> 'WEBCHAT'
              and x.status::text not in ('removed','erased') and x.unipile_account_id is not null and x.removal_requested_at is null loop
      r := outreach_sender_remove_begin(s.id, case when p_step = 'remove' then 'billing' else 'canceled' end, case when p_step = 'remove' then 'billing_suspended' else 'billing_cancelled' end, null);
      n := n + 1; senders := senders || s.id; if s.unipile_account_id is not null then accounts := accounts || s.unipile_account_id; end if;
    end loop;
    return jsonb_build_object('senders_removed', n, 'sender_ids', to_jsonb(senders), 'account_ids', to_jsonb(accounts));
  elsif p_step = 'erase' then
    perform outreach__billing_cancelled(p_ws);
    update outreach_workspaces set data_delete_after = now(), stripe_status = 'canceled' where id = p_ws;
    return jsonb_build_object('cancelled', true, 'data_delete_after', now());
  elsif p_step = 'cancel_erase' then
    update outreach_workspaces set data_delete_after = least(coalesce(data_delete_after, now()), now()) where id = p_ws;
    return jsonb_build_object('data_delete_after', now());
  end if;
  return jsonb_build_object('noop', true);
end $$;
revoke execute on function outreach_billing_step_apply(uuid, text) from public, anon, authenticated;

-- a workspace's sending domains follow its billing (§9 of the sending-domain PRD): paused with 'plan' while suspended, back on reactivation
create or replace function outreach_sending_domains_plan_sync_ws(p_ws uuid, p_pause boolean) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  if p_pause then
    update outreach_sending_domains set paused_at = now(), paused_reason = 'plan', paused_detail = 'The workspace is paused for billing', updated_at = now()
     where workspace_id = p_ws and state <> 'removed' and paused_at is null;
  else
    update outreach_sending_domains set paused_at = null, paused_reason = null, paused_detail = null, updated_at = now()
     where workspace_id = p_ws and state <> 'removed' and paused_reason = 'plan';
  end if;
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function outreach_sending_domains_plan_sync_ws(uuid, boolean) from public, anon, authenticated;

-- suspension pauses with reason billing (the trigger sets pause_reason from status_reason); cancellation removes at once (§5.10)
select outreach__patch_fn('public.outreach__billing_cancelled(uuid)'::regprocedure, $q$x record;$q$,
$q$declare w outreach_workspaces%rowtype; n int := 0;$q$, $q$declare w outreach_workspaces%rowtype; n int := 0; x record;$q$);
select outreach__patch_fn('public.outreach__billing_cancelled(uuid)'::regprocedure, $q$outreach_sender_remove_begin(x.id, 'canceled'$q$,
$q$  update outreach_senders set status = 'paused', status_reason = 'billing_cancelled'
   where workspace_id = p_ws and deleted_at is null and provider::text <> 'WEBCHAT'
     and (status = 'ok' or (status = 'paused' and status_reason in ('billing_suspended','over_plan_limit')));
  get diagnostics n = row_count;$q$,
$q$  -- PRD v1.2 §5.10: the accounts are removed at once (they would only cost money); history stays for the read-only period
  for x in select id from outreach_senders where workspace_id = p_ws and deleted_at is null and provider::text <> 'WEBCHAT'
            and status::text not in ('removed','erased') and unipile_account_id is not null and removal_requested_at is null loop
    perform outreach_sender_remove_begin(x.id, 'canceled', 'billing_cancelled', null);
    n := n + 1;
  end loop;
  perform outreach_sending_domains_plan_sync_ws(p_ws, true);$q$);

-- payment recovered: the senders paused for billing come back (existing), the domains too, and the step is recorded
create or replace function outreach_workspace_reactivated(p_ws uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; n_dom int; removed jsonb; no_sender jsonb; period timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if w.plan = 'suspended' then perform outreach_resume_after_billing(p_ws); end if;
  update outreach_workspaces set past_due_since = null, suspended_at = null, billing_action_required = false, overdue_invoice_id = null, overdue_invoice_url = null,
         data_delete_after = case when plan in ('launch','scale','enterprise','trial') then null else data_delete_after end where id = p_ws;
  n_dom := outreach_sending_domains_plan_sync_ws(p_ws, false);
  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'removed_at', s.removed_at, 'holder', outreach_sender_holder(s.id)) order by s.removed_at), '[]'::jsonb)
    into removed from outreach_senders s where s.workspace_id = p_ws and s.status::text = 'removed' and s.removed_via in ('billing','canceled') and s.removed_at > now() - interval '120 days';
  select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name)), '[]'::jsonb) into no_sender
    from outreach_sequences q where q.workspace_id = p_ws and q.status = 'active' and not exists (select 1 from outreach_senders o where o.id = any(q.sender_pool) and o.status = 'ok' and o.deleted_at is null);
  -- the period that just ended, so its steps stay recorded and the next failure starts a fresh clock
  select max(b.period_start) into period from outreach_billing_steps b where b.workspace_id = p_ws;
  if period is not null then insert into outreach_billing_steps(workspace_id, period_start, step, data) values (p_ws, period, 'reactivated', jsonb_build_object('at', now())) on conflict do nothing; end if;
  perform outreach_audit(p_ws, 'workspace.reactivated', 'workspace', p_ws::text, jsonb_build_object('domains_resumed', n_dom, 'removed_for_billing', jsonb_array_length(removed), 'sequences_without_sender', jsonb_array_length(no_sender)), 'system');
  return jsonb_build_object('domains_resumed', n_dom, 'removed_senders', removed, 'sequences_without_sender', no_sender);
end $$;
revoke execute on function outreach_workspace_reactivated(uuid) from public, anon, authenticated;

-- the webhook records the failed invoice (the clock starts from the first failure; D15)
create or replace function outreach_billing_payment_failed(p_ws uuid, p_invoice_id text, p_invoice_url text, p_action_required boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype; first boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  first := w.past_due_since is null;
  if p_action_required then
    update outreach_workspaces set billing_action_required = true, overdue_invoice_id = coalesce(p_invoice_id, overdue_invoice_id), overdue_invoice_url = coalesce(p_invoice_url, overdue_invoice_url) where id = p_ws;
    return jsonb_build_object('first_failure', false, 'action_required', true);
  end if;
  update outreach_workspaces set stripe_status = case when stripe_status in ('active','trialing') or stripe_status is null then 'past_due' else stripe_status end,
         past_due_since = coalesce(past_due_since, now()), overdue_invoice_id = coalesce(p_invoice_id, overdue_invoice_id), overdue_invoice_url = coalesce(p_invoice_url, overdue_invoice_url)
   where id = p_ws and plan not in ('suspended','cancelled','trial_expired');
  return jsonb_build_object('first_failure', first, 'past_due_since', (select past_due_since from outreach_workspaces where id = p_ws));
end $$;
revoke execute on function outreach_billing_payment_failed(uuid, text, text, boolean) from public, anon, authenticated;

-- the data the billing emails need (owners / contacts, amounts come from Stripe in the edge function)
create or replace function outreach_billing_email_context(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare w outreach_workspaces%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into w from outreach_workspaces where id = p_ws;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  return jsonb_build_object('name', w.name, 'recipients', to_jsonb(outreach_billing_recipients(p_ws)), 'billing_status', w.billing_status, 'plan', w.plan, 'past_due_since', w.past_due_since,
    'overdue_invoice_url', w.overdue_invoice_url, 'data_delete_after', w.data_delete_after, 'tz', outreach_ws_tz(p_ws), 'current_period_end', w.current_period_end, 'cancelled_at', w.cancelled_at,
    'owner_name', (select coalesce(m.display_name, split_part(outreach_user_email(m.user_id), '@', 1)) from outreach_members m where m.workspace_id = p_ws and m.role = 'owner' order by m.created_at limit 1),
    'senders', (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'provider', s.provider, 'status', s.status, 'holder', outreach_sender_holder(s.id)) order by s.display_name), '[]'::jsonb)
                  from outreach_senders s where s.workspace_id = p_ws and s.deleted_at is null and s.provider::text <> 'WEBCHAT' and s.status::text not in ('removed','erased') and s.unipile_account_id is not null));
end $$;
revoke execute on function outreach_billing_email_context(uuid) from public, anon, authenticated;

-- E_BILLING_SUSPENDED for the connector and the API: the plan-active check names the billing state
create or replace function outreach__plan_inactive_message(p_plan text) returns text language sql immutable as $$
  select case p_plan when 'trial_expired' then 'Your trial has ended. Subscribe to keep going; everything is still here.'
                     when 'cancelled' then 'This subscription has ended. Subscribe again to continue; your data is kept for 60 days.'
                     else 'This workspace is paused because of a billing issue. The workspace owner needs to update payment.' end
$$;

drop function if exists outreach__patch_fn(regprocedure, text, text, text);
