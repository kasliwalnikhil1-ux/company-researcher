-- 103: every email about a sender account goes to a member's sign-in email, never to a typed outside address.
-- (product decision 26 Oct 2026, replacing sender-lifecycle-PRD v1.2 D13's "Someone else's: [email]" option)
--
--   * `owner_email` is no longer written: the wizard has no "someone else's" choice; `outreach_sender_set_holder` accepts
--     {mine} | {user_id} | {email of a member}; any other email raises E_HOLDER_OUTSIDE.
--   * existing rows held by an outside address pass to the member who connected them (else the first owner); a lifecycle
--     event keeps the old address for the record.
--   * `outreach_sender_holder` never answers kind = 'outside' any more; a row with no owner_user_id resolves to the
--     connecting member, else the owners. The recipients function, the disconnect clock and every email path are unchanged.
--   * the column, the constraint and the owner-link / consent-link machinery stay (removed accounts, old rows, tests).

-- -----------------------------------------------------------------------------
-- 1. the holder is always a member
-- -----------------------------------------------------------------------------
create or replace function outreach_sender_holder(p_sender uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; to_user uuid; kind text; holder_email text; holder_name text; owners jsonb;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if s.status::text = 'erased' then return jsonb_build_object('kind', 'none', 'outside', false); end if;
  if s.owner_user_id is not null and exists (select 1 from outreach_members m where m.workspace_id = s.workspace_id and m.user_id = s.owner_user_id) then
    to_user := s.owner_user_id; kind := 'member';
  elsif s.connected_by is not null and exists (select 1 from outreach_members m where m.workspace_id = s.workspace_id and m.user_id = s.connected_by) then
    -- no member holder on the row (an old outside row, or the holder left): the member who connected it
    to_user := s.connected_by; kind := case when s.owner_user_id is null then 'member' else 'member_left' end;
  end if;
  if to_user is not null then
    holder_email := outreach_user_email(to_user);
    select coalesce(m.display_name, u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)) into holder_name
      from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and m.user_id = to_user;
    return jsonb_build_object('kind', kind, 'user_id', to_user, 'email', holder_email, 'name', holder_name, 'connected_by', s.connected_by, 'copy', '[]'::jsonb, 'outside', false);
  end if;
  -- nobody left to hold it: every owner (the first gets the email, the others are copied)
  select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'email', outreach_user_email(m.user_id)) order by m.created_at), '[]'::jsonb) into owners
    from outreach_members m where m.workspace_id = s.workspace_id and m.role = 'owner';
  return jsonb_build_object('kind', 'member_left', 'user_id', null, 'email', null, 'name', null, 'connected_by', s.connected_by, 'owners', owners, 'copy', '[]'::jsonb, 'outside', false);
end $$;
revoke execute on function outreach_sender_holder(uuid) from public, anon, authenticated;

-- Whose account → Change. p_holder = {"mine": true} | {"user_id": "<member>"} | {"email": "<a member's sign-in email>"}.
-- A member can mark an account Mine only for themselves. An email that is not a member's raises E_HOLDER_OUTSIDE.
-- Returns {changed, old, new, notify_member (a teammate set as holder by someone else), old_outside_email, links_cancelled, grants_revoked, holder}
create or replace function outreach_sender_set_holder(p_sender uuid, p_holder jsonb, p_by uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; actor uuid := coalesce(p_by, auth.uid()); r outreach_role_t; em text; actor_email text; member_id uuid;
        new_user uuid; old_user uuid; old_email text; notify_member uuid := null; n_links int := 0; n_grants int := 0; n2 int; changed boolean;
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
    new_user := actor;
  elsif coalesce(p_holder->>'user_id', '') <> '' then
    member_id := (p_holder->>'user_id')::uuid;
    if not exists (select 1 from outreach_members m where m.workspace_id = s.workspace_id and m.user_id = member_id) then raise exception 'E_PAYLOAD_INVALID: that person is not a member of this workspace'; end if;
    new_user := member_id; if member_id <> actor then notify_member := member_id; end if;
  else
    em := lower(trim(coalesce(p_holder->>'email', '')));
    if em = '' or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: choose the teammate who signs in to this account'; end if;
    if em = actor_email then
      new_user := actor;
    else
      select m.user_id into member_id from outreach_members m join auth.users u on u.id = m.user_id where m.workspace_id = s.workspace_id and lower(u.email) = em limit 1;
      if member_id is null then raise exception 'E_HOLDER_OUTSIDE: emails about an account only go to a teammate''s sign-in email. Invite % to the workspace first, or keep the account under your own name.', em; end if;
      new_user := member_id; notify_member := member_id;
    end if;
  end if;
  changed := new_user is distinct from old_user or old_email is not null;
  if not changed then return jsonb_build_object('changed', false, 'holder', outreach_sender_holder(p_sender)); end if;
  update outreach_senders set owner_user_id = new_user, owner_email = null, connected_by = coalesce(connected_by, actor), updated_at = now() where id = p_sender;
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
    'from', jsonb_build_object('user_id', old_user, 'email', old_email), 'to', jsonb_build_object('user_id', new_user, 'email', null), 'links_cancelled', n_links, 'grants_revoked', n_grants));
  perform outreach_audit(s.workspace_id, 'sender.holder_changed', 'sender', p_sender::text,
    jsonb_build_object('from', jsonb_build_object('user_id', old_user, 'email', old_email), 'to', jsonb_build_object('user_id', new_user, 'email', null), 'links_cancelled', n_links, 'grants_revoked', n_grants),
    case when outreach_is_service() and p_by is null then 'system' else 'user' end);
  return jsonb_build_object('changed', true, 'old', jsonb_build_object('user_id', old_user, 'email', old_email), 'new', jsonb_build_object('user_id', new_user, 'email', null),
    'notify_member', notify_member, 'old_outside_email', case when old_user is null then old_email end, 'links_cancelled', n_links, 'grants_revoked', n_grants, 'holder', outreach_sender_holder(p_sender));
end $$;
grant execute on function outreach_sender_set_holder(uuid, jsonb, uuid) to authenticated;
revoke execute on function outreach_sender_set_holder(uuid, jsonb, uuid) from public, anon;

-- -----------------------------------------------------------------------------
-- 2. rows held by an outside address pass to a member
-- -----------------------------------------------------------------------------
-- The connecting member if they are still in the workspace, else the first owner. Service only; p_ws limits it (tests).
create or replace function outreach_holder_member_only_backfill(p_ws uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; new_holder uuid; n int := 0; skipped int := 0;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  for r in select s.id, s.workspace_id, s.connected_by, s.owner_email from outreach_senders s
            where s.owner_email is not null and s.owner_user_id is null and (p_ws is null or s.workspace_id = p_ws) loop
    new_holder := case when r.connected_by is not null and exists (select 1 from outreach_members m where m.workspace_id = r.workspace_id and m.user_id = r.connected_by) then r.connected_by end;
    if new_holder is null then
      select m.user_id into new_holder from outreach_members m where m.workspace_id = r.workspace_id and m.role = 'owner' order by m.created_at limit 1;
    end if;
    if new_holder is null then skipped := skipped + 1; continue; end if;   -- a workspace with no owner: left as is
    update outreach_senders set owner_user_id = new_holder, owner_email = null, connected_by = coalesce(connected_by, new_holder), updated_at = now() where id = r.id;
    insert into outreach_sender_events(sender_id, kind, data)
      values (r.id, 'lifecycle', jsonb_build_object('action', 'holder_member_only', 'was_outside_email', lower(r.owner_email::text), 'now', new_holder));
    n := n + 1;
  end loop;
  return jsonb_build_object('moved', n, 'skipped', skipped);
end $$;
revoke execute on function outreach_holder_member_only_backfill(uuid) from public, anon, authenticated;

select outreach_holder_member_only_backfill();
