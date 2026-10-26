-- Smoke test — 088 outreach_sender_landing. Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_24_sender_landing.sql
do $$
declare
  log text := ''; fails int := 0; n int; r uuid;
  ws uuid; u_owner uuid; u_other uuid; s_old uuid; s_new uuid; s_two uuid; s_gone uuid;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_other from platform_user_access where status = 'active' and user_id <> u_owner order by created_at limit 1;
  if u_owner is null or u_other is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke24', 'smoke24-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner24@test.local', 'Naman');
  -- the sender that holds the account, and the placeholder the hosted sign-in came back to, folded into it
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at)
    values (ws, 'LINKEDIN', 'Naman LI', 'ok', 's24-' || ws, 'owner24@test.local', now() - interval '30 days') returning id into s_old;
  insert into outreach_senders(workspace_id, provider, display_name, status, status_reason, deleted_at, owner_email)
    values (ws, 'LINKEDIN', 'Naman LI (copy)', 'disabled', 'merged_into:' || s_old, now(), 'owner24@test.local') returning id into s_new;
  -- a second-generation tombstone, pointing at the first one
  insert into outreach_senders(workspace_id, provider, display_name, status, status_reason, deleted_at, owner_email)
    values (ws, 'LINKEDIN', 'Naman LI (copy 2)', 'disabled', 'merged_into:' || s_new, now(), 'owner24@test.local') returning id into s_two;
  -- a plainly deleted sender: nowhere to go
  insert into outreach_senders(workspace_id, provider, display_name, status, status_reason, deleted_at, owner_email)
    values (ws, 'LINKEDIN', 'Gone', 'disabled', 'disabled_by_user', now(), 'owner24@test.local') returning id into s_gone;

  -- ============================================================ 1. as the owner
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_senders where id = s_new;
  if n = 0 then log := log || E'\nok   RLS hides the folded placeholder (why the page read nothing)'; else fails := fails + 1; log := log || E'\nFAIL tombstone visible through RLS: ' || n; end if;
  r := outreach_sender_landing(s_new);
  if r = s_old then log := log || E'\nok   folded placeholder lands on the survivor'; else fails := fails + 1; log := log || E'\nFAIL landing(s_new) = ' || coalesce(r::text, 'null'); end if;
  r := outreach_sender_landing(s_two);
  if r = s_old then log := log || E'\nok   a two-hop tombstone chain lands on the survivor'; else fails := fails + 1; log := log || E'\nFAIL landing(s_two) = ' || coalesce(r::text, 'null'); end if;
  r := outreach_sender_landing(s_old);
  if r = s_old then log := log || E'\nok   a live sender lands on itself'; else fails := fails + 1; log := log || E'\nFAIL landing(s_old) = ' || coalesce(r::text, 'null'); end if;
  r := outreach_sender_landing(s_gone);
  if r is null then log := log || E'\nok   a plainly deleted sender lands nowhere'; else fails := fails + 1; log := log || E'\nFAIL landing(s_gone) = ' || r; end if;
  r := outreach_sender_landing(gen_random_uuid());
  if r is null then log := log || E'\nok   an unknown id lands nowhere'; else fails := fails + 1; log := log || E'\nFAIL landing(unknown) = ' || r; end if;
  r := outreach_sender_landing(null);
  if r is null then log := log || E'\nok   null lands nowhere'; else fails := fails + 1; log := log || E'\nFAIL landing(null) = ' || r; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 2. as someone outside the workspace
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_other)::text, true);
  execute 'set local role authenticated';
  r := outreach_sender_landing(s_new);
  if r is null then log := log || E'\nok   a non-member learns nothing from a folded placeholder'; else fails := fails + 1; log := log || E'\nFAIL outsider landing(s_new) = ' || r; end if;
  r := outreach_sender_landing(s_old);
  if r is null then log := log || E'\nok   a non-member learns nothing from a live sender'; else fails := fails + 1; log := log || E'\nFAIL outsider landing(s_old) = ' || r; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 3. grants
  select count(*) into n from information_schema.role_routine_grants where routine_name = 'outreach_sender_landing' and grantee = 'authenticated' and privilege_type = 'EXECUTE';
  if n = 1 then log := log || E'\nok   authenticated may call it'; else fails := fails + 1; log := log || E'\nFAIL authenticated grant rows: ' || n; end if;
  select count(*) into n from information_schema.role_routine_grants where routine_name = 'outreach_sender_landing' and grantee in ('anon', 'PUBLIC') and privilege_type = 'EXECUTE';
  if n = 0 then log := log || E'\nok   anon may not'; else fails := fails + 1; log := log || E'\nFAIL anon/public grant rows: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
