-- Smoke test — 092 outreach_sender_labels. Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_26_sender_labels.sql
do $$
declare
  log text := ''; fails int := 0; n int; b boolean;
  ws uuid; u_owner uuid; u_viewer uuid; u_other uuid; ca uuid; cb uuid; s_li uuid; s_wa_gone uuid; s_client_b uuid;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_viewer from platform_user_access where status = 'active' and user_id <> u_owner order by created_at limit 1;
  select user_id into u_other from platform_user_access where status = 'active' and user_id not in (u_owner, u_viewer) order by created_at limit 1;
  if u_owner is null or u_viewer is null or u_other is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke26', 'smoke26-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_clients(workspace_id, name, slug) values (ws, 'Client A', 'a26') returning id into ca;
  insert into outreach_clients(workspace_id, name, slug) values (ws, 'Client B', 'b26') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner26@test.local', 'Owner');
  insert into outreach_members(workspace_id, user_id, role, client_ids, email, display_name) values (ws, u_viewer, 'client_viewer', array[ca], 'viewer26@test.local', 'Viewer');
  -- a live LinkedIn sender, a removed WhatsApp sender (the inbox still holds its chats), and a live sender of client B
  insert into outreach_senders(workspace_id, provider, display_name, public_identifier, status, owner_email, client_id, created_at)
    values (ws, 'LINKEDIN', 'Aarushi', 'aarushi-jain00', 'ok', 'owner26@test.local', ca, now() - interval '3 days') returning id into s_li;
  insert into outreach_senders(workspace_id, provider, display_name, public_identifier, status, status_reason, deleted_at, owner_email, client_id, created_at)
    values (ws, 'WHATSAPP', 'Lavish WhatsApp', '+910000000000', 'disabled', 'disabled_by_user', now(), 'owner26@test.local', ca, now() - interval '2 days') returning id into s_wa_gone;
  insert into outreach_senders(workspace_id, provider, display_name, status, owner_email, client_id, created_at)
    values (ws, 'INSTAGRAM', 'Client B Insta', 'ok', 'owner26@test.local', cb, now() - interval '1 day') returning id into s_client_b;

  -- ============================================================ 1. as the owner
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_senders where id = s_wa_gone;
  if n = 0 then log := log || E'\nok   RLS hides the removed WhatsApp sender (why the chip was blank)'; else fails := fails + 1; log := log || E'\nFAIL removed sender visible through RLS: ' || n; end if;
  select count(*) into n from outreach_sender_labels(ws);
  if n = 3 then log := log || E'\nok   the owner gets every sender, removed ones included'; else fails := fails + 1; log := log || E'\nFAIL owner label rows: ' || n; end if;
  select l.removed into b from outreach_sender_labels(ws) l where l.id = s_wa_gone;
  if b then log := log || E'\nok   the removed sender is flagged removed'; else fails := fails + 1; log := log || E'\nFAIL removed flag: ' || coalesce(b::text, 'null'); end if;
  select l.removed into b from outreach_sender_labels(ws) l where l.id = s_li;
  if not b then log := log || E'\nok   a live sender is not flagged'; else fails := fails + 1; log := log || E'\nFAIL live sender flagged removed'; end if;
  select count(*) into n from outreach_sender_labels(ws) l where l.id = s_wa_gone and l.display_name = 'Lavish WhatsApp' and l.public_identifier = '+910000000000' and l.provider = 'WHATSAPP';
  if n = 1 then log := log || E'\nok   label fields come through (name, identifier, channel)'; else fails := fails + 1; log := log || E'\nFAIL label fields: ' || n; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 2. as a client viewer of client A
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_sender_labels(ws);
  if n = 2 then log := log || E'\nok   a client viewer sees only their client''s senders (removed one included)'; else fails := fails + 1; log := log || E'\nFAIL viewer label rows: ' || n; end if;
  select count(*) into n from outreach_sender_labels(ws) l where l.id = s_client_b;
  if n = 0 then log := log || E'\nok   another client''s sender stays hidden'; else fails := fails + 1; log := log || E'\nFAIL client B sender visible to viewer of A'; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 3. as someone outside the workspace
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_other)::text, true);
  execute 'set local role authenticated';
  begin
    select count(*) into n from outreach_sender_labels(ws);
    fails := fails + 1; log := log || E'\nFAIL outsider read label rows: ' || n;
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   a non-member is refused'; else fails := fails + 1; log := log || E'\nFAIL outsider error: ' || sqlerrm; end if;
  end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 4. grants
  select count(*) into n from information_schema.role_routine_grants where routine_name = 'outreach_sender_labels' and grantee = 'authenticated' and privilege_type = 'EXECUTE';
  if n = 1 then log := log || E'\nok   authenticated may call it'; else fails := fails + 1; log := log || E'\nFAIL authenticated grant rows: ' || n; end if;
  select count(*) into n from information_schema.role_routine_grants where routine_name = 'outreach_sender_labels' and grantee in ('anon', 'PUBLIC') and privilege_type = 'EXECUTE';
  if n = 0 then log := log || E'\nok   anon may not'; else fails := fails + 1; log := log || E'\nFAIL anon/public grant rows: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
