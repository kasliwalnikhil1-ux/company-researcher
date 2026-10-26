-- smoke_32: every account email goes to a member's sign-in email (migration 103). Rolls back (the final RAISE).
do $$
declare
  ws uuid; u_owner uuid; u2 uuid; u_owner_email text; u2_email text; s_o uuid; s_m uuid; j jsonb;
  log text := ''; fails int := 0;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u2 from platform_user_access where status = 'active' and user_id <> u_owner order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;
  u_owner_email := outreach_user_email(u_owner); u2_email := outreach_user_email(u2);
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke32', 'smoke32-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner32@test.local');
  if u2 is not null then insert into outreach_members(workspace_id, user_id, role, email) values (ws, u2, 'manager', 'manager32@test.local'); end if;
  -- an old row held by an outside address (the shape the wizard wrote before 103)
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_email, connected_by, connected_at, timezone, auth_method)
    values (ws, 'LINKEDIN', 'Old outside', 'ok', 's32o-' || ws, 'pid-o-' || ws, 'avi32@client.test', u_owner, now() - interval '10 days', 'UTC', 'credentials') returning id into s_o;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone, auth_method)
    values (ws, 'LINKEDIN', 'Mine', 'ok', 's32m-' || ws, 'pid-m-' || ws, u_owner, u_owner, now() - interval '10 days', 'UTC', 'credentials') returning id into s_m;

  -- 1. before the backfill the row already resolves to the connecting member
  j := outreach_sender_holder(s_o);
  if j->>'kind' = 'member' and (j->>'user_id')::uuid = u_owner and j->>'email' = u_owner_email and (j->>'outside')::boolean = false
    then log := log || E'\nok   1a an outside row resolves to the connecting member, never outside'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || j::text; end if;
  j := outreach_sender_email_recipients(s_o, 'holder');
  if j->>'to' = u_owner_email and (j->>'outside')::boolean = false and jsonb_array_length(j->'cc') = 0
    then log := log || E'\nok   1b recipients(holder) = the member''s sign-in email, nobody copied'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || j::text; end if;

  -- 2. the backfill moves the row to the member and records the old address
  j := outreach_holder_member_only_backfill(ws);
  if (j->>'moved')::int = 1 and (select owner_user_id = u_owner and owner_email is null from outreach_senders where id = s_o)
     and exists (select 1 from outreach_sender_events e where e.sender_id = s_o and e.data->>'action' = 'holder_member_only' and e.data->>'was_outside_email' = 'avi32@client.test')
    then log := log || E'\nok   2a backfill: owner_user_id = the connecting member, owner_email cleared, event kept'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || j::text; end if;
  j := outreach_holder_member_only_backfill(ws);
  if (j->>'moved')::int = 0 then log := log || E'\nok   2b the backfill is idempotent'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || j::text; end if;

  -- 3. Change: an outside email is refused; a teammate works by id or by sign-in email; Mine works
  begin
    perform outreach_sender_set_holder(s_m, jsonb_build_object('email', 'someone@client.test'), u_owner);
    fails := fails + 1; log := log || E'\nFAIL 3a an outside email was accepted';
  exception when others then
    if sqlerrm like 'E_HOLDER_OUTSIDE%' then log := log || E'\nok   3a an outside email raises E_HOLDER_OUTSIDE'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || sqlerrm; end if;
  end;
  if (select owner_user_id = u_owner and owner_email is null from outreach_senders where id = s_m) then log := log || E'\nok   3b the refused change left the row alone'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  begin
    perform outreach_sender_set_holder(s_m, jsonb_build_object('user_id', gen_random_uuid()), u_owner);
    fails := fails + 1; log := log || E'\nFAIL 3c a non-member id was accepted';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'\nok   3c a non-member user id is refused'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || sqlerrm; end if;
  end;
  j := outreach_sender_set_holder(s_m, '{"mine": true}'::jsonb, u_owner);
  if (j->>'changed')::boolean = false then log := log || E'\nok   3d Mine when already mine: nothing changed'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || j::text; end if;
  if u2 is not null then
    insert into outreach_ai_reply_consent(workspace_id, sender_id, granted_by_email, granted_via, scope, expires_at) values (ws, s_m, u_owner_email, 'owner_is_operator', '{}', now() + interval '1 year');
    j := outreach_sender_set_holder(s_m, jsonb_build_object('user_id', u2), u_owner);
    if (j->>'changed')::boolean and (j#>>'{new,user_id}')::uuid = u2 and (j->>'notify_member')::uuid = u2 and (j->>'grants_revoked')::int = 1 and (j#>>'{new,email}') is null
      then log := log || E'\nok   3e a teammate by id: holder moved, teammate flagged, grants reset'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || j::text; end if;
    j := outreach_sender_set_holder(s_m, jsonb_build_object('email', upper(u2_email)), u2);
    if (j->>'changed')::boolean = false then log := log || E'\nok   3f the same teammate by sign-in email (any case): nothing changed'; else fails := fails + 1; log := log || E'\nFAIL 3f ' || j::text; end if;
    j := outreach_sender_email_recipients(s_m, 'holder');
    if j->>'to' = u2_email and (j->>'outside')::boolean = false then log := log || E'\nok   3g emails now go to the teammate''s sign-in email'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || j::text; end if;
    j := outreach_sender_holder_view(s_m);
    if j->>'kind' = 'member' and (j->>'user_id')::uuid = u2 and j->>'email' is null then log := log || E'\nok   3h the member view shows the teammate, not their email'; else fails := fails + 1; log := log || E'\nFAIL 3h ' || j::text; end if;
  else
    log := log || E'\nskip 3e-3h (one app user only)';
  end if;

  -- 4. a member's own account never gets a disconnect link
  begin perform outreach_sender_owner_link_create(s_o, 'disconnect', 30, null); fails := fails + 1; log := log || E'\nFAIL 4a a member''s account got a disconnect link';
  exception when others then if sqlerrm like 'E_CONFLICT%' then log := log || E'\nok   4a no disconnect link for a member''s account'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || sqlerrm; end if; end;

  if fails > 0 then raise exception 'SMOKE FAILED (% failures)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
