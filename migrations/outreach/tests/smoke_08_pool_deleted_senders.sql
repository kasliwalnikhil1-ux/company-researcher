-- Smoke test — 032: deleted senders leave sequence pools. Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_08_pool_deleted_senders.sql
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; ws2 uuid; u_owner uuid;
  s_a uuid; s_b uuid; s_c uuid; s_dup uuid; s_other uuid;
  q uuid; q2 uuid; j jsonb; p uuid[];
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  insert into outreach_workspaces(name, slug, created_by) values ('smoke8', 'smoke8-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_workspaces(name, slug, created_by) values ('smoke8b', 'smoke8b-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws2;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner8@test.local');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'A', 'ok', 's8a-' || ws) returning id into s_a;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'B', 'ok', 's8b-' || ws) returning id into s_b;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'INSTAGRAM', 'C', 'ok', 's8c-' || ws) returning id into s_c;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'A dup', 'ok', 's8d-' || ws) returning id into s_dup;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws2, 'LINKEDIN', 'Other ws', 'ok', 's8o-' || ws2) returning id into s_other;
  insert into outreach_sequences(workspace_id, name, sender_pool) values (ws, 'smoke8 one', array[s_a, s_b]) returning id into q;
  insert into outreach_sequences(workspace_id, name, sender_pool) values (ws, 'smoke8 two', array[s_dup, s_c]) returning id into q2;

  -- 1. deleting a sender removes it from every pool that holds it
  update outreach_senders set status = 'disabled', status_reason = 'disabled_by_user', deleted_at = now() where id = s_b;
  select sender_pool into p from outreach_sequences where id = q;
  if p = array[s_a] then log := log || E'\nok   1a a deleted sender leaves the pool'; else fails := fails + 1; log := log || E'\nFAIL 1a ' || p::text; end if;
  if (select sender_pools from outreach_sequences where id = q) ? 'LINKEDIN' and not ((select sender_pools->'LINKEDIN' from outreach_sequences where id = q) ? s_b::text)
    then log := log || E'\nok   1b the per-provider pools follow'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || (select sender_pools from outreach_sequences where id = q)::text; end if;

  -- 2. a merged duplicate is replaced by its survivor, without duplicating it
  update outreach_senders set status = 'disabled', status_reason = 'merged_into:' || s_a, deleted_at = now() where id = s_dup;
  select sender_pool into p from outreach_sequences where id = q2;
  if p = array[s_a, s_c] then log := log || E'\nok   2a a merged sender is swapped for the survivor in place'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || p::text; end if;
  if outreach__live_pool(ws, array[s_a, s_dup, s_b, s_c]) = array[s_a, s_c] then log := log || E'\nok   2b live_pool dedups, drops deleted, keeps order'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || outreach__live_pool(ws, array[s_a, s_dup, s_b, s_c])::text; end if;

  -- 3. the pool dialog path: a stale pool that still carries a deleted sender saves; a foreign sender is refused clearly
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner8@test.local')::text, true);
  j := outreach_rebalance_preview(q, array[s_a, s_b, s_c]);
  if (j->>'pool_size')::int = 2 and not exists (select 1 from jsonb_array_elements(j->'senders') x where x->>'sender_id' = s_b::text)
    then log := log || E'\nok   3a the preview ignores a deleted sender in the requested pool'; else fails := fails + 1; log := log || E'\nFAIL 3a ' || j::text; end if;
  begin
    j := outreach_set_pool(q, array[s_a, s_b, s_c]);
    select sender_pool into p from outreach_sequences where id = q;
    if p = array[s_a, s_c] then log := log || E'\nok   3b set_pool saves the pool without the deleted sender'; else fails := fails + 1; log := log || E'\nFAIL 3b ' || p::text; end if;
  exception when others then fails := fails + 1; log := log || E'\nFAIL 3b ' || sqlerrm;
  end;
  begin
    perform outreach_set_pool(q, array[s_a, s_other]);
    fails := fails + 1; log := log || E'\nFAIL 3c a sender from another workspace was accepted';
  exception when others then
    if sqlerrm like 'E_SENDER_NOT_IN_POOL: One of these senders is not in this workspace%' then log := log || E'\nok   3c a sender from another workspace is refused with a clear message'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || sqlerrm; end if;
  end;
  begin
    perform outreach_save_sequence(q, (select graph from outreach_sequences where id = q), array[s_b, s_a]);
    select sender_pool into p from outreach_sequences where id = q;
    if p = array[s_a] then log := log || E'\nok   3d a builder save with a stale pool cannot put a deleted sender back'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || p::text; end if;
  exception when others then fails := fails + 1; log := log || E'\nFAIL 3d ' || sqlerrm;
  end;
  perform set_config('request.jwt.claims', '', true);

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
