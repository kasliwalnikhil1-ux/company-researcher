-- Smoke test — Profile Studio (021–023). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_05_profile_studio.sql
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; u_owner uuid; u_member uuid; u_other uuid; sa uuid; sb uuid; sc uuid; sd uuid; s_cookie uuid; s_new uuid;
  j jsonb; j2 jsonb; n int; t text; cid uuid; cid2 uuid; aid uuid; snap uuid; tpl uuid; run uuid; eid uuid; tok text; st text; ts timestamptz; lid uuid; i int; l uuid;
begin
  -- three ACTIVE accounts (the platform admin layer gates outreach_role_in on platform_can_use)
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_other  from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_other is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, settings) values ('smoke5', 'smoke5-' || encode(gen_random_bytes(4),'hex'), u_owner, '{"profile_owner_permission": true}') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner5@test.local');
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_member, 'member', 'member5@test.local');
  -- A: healthy, level 2, connected 10 days ago, owner email = the member's email (owner is operator)
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method, public_identifier, picture_url, connections_count)
    values (ws, 'LINKEDIN', 'Ada Lovelace', 'ok', 's5a-' || ws, 2, 90, now() - interval '10 days', 'member5@test.local', 'credentials', 'ada', 'https://media.licdn.com/dms/image/x.jpg', 800) returning id into sa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method, connections_count)
    values (ws, 'LINKEDIN', 'Bob Builder', 'ok', 's5b-' || ws, 2, 90, now() - interval '10 days', 'bob@test.local', 'browser', 500) returning id into sb;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method, connections_count)
    values (ws, 'LINKEDIN', 'Cleo Cat', 'ok', 's5c-' || ws, 2, 90, now() - interval '10 days', 'cleo@test.local', 'credentials', 500) returning id into sc;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method, connections_count)
    values (ws, 'LINKEDIN', 'Dan Dog', 'ok', 's5d-' || ws, 2, 90, now() - interval '10 days', 'dan@test.local', 'credentials', 500) returning id into sd;
  -- cookie-synced (identity unverified) and freshly connected level-0 senders
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method)
    values (ws, 'LINKEDIN', 'Cookie Sender', 'ok', 's5k-' || ws, 2, 90, now() - interval '10 days', 'k@test.local', 'cookie') returning id into s_cookie;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, owner_email, auth_method)
    values (ws, 'LINKEDIN', 'New Sender', 'ok', 's5n-' || ws, 0, 90, now() - interval '1 hour', 'n@test.local', 'credentials') returning id into s_new;

  -- ------------------------------------------------------------ 1. serialiser-side rules mirrored in SQL
  if outreach_profile_groups_of('{"headline":"h","summary":"s","experience":{"id":"e"},"custom_link":{"type":"WEBSITE","url":"https://x"}}'::jsonb, '{"picture":"p"}'::jsonb)
     = array['headline','about','photo','experience','custom_link']::outreach_profile_field_group_t[]
    then log := log || E'\nok   1a field groups derived from payload + assets in canonical order'; else fails := fails + 1; log := log || E'\nFAIL 1a'; end if;
  if outreach_profile_payload_prohibited('{"open_to_work":{}}') = 'open_to_work' and outreach_profile_payload_prohibited('{"experience":{"id":"e","notify_network":true}}') = 'notify_network' and outreach_profile_payload_prohibited('{"headline":"x"}') is null
    then log := log || E'\nok   1b open_to_work / notify_network / names are prohibited keys'; else fails := fails + 1; log := log || E'\nFAIL 1b'; end if;
  if outreach_profile_render_text('Hi {{first_name}}, {{custom.region|EMEA}} {{missing|fallback}} {{gone}}', '{"first_name":"Ada","custom":{"region":"APAC"}}') = 'Hi Ada, APAC fallback '
    then log := log || E'\nok   1c template variables, custom.* and |fallback render'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || outreach_profile_render_text('Hi {{first_name}}, {{custom.region|EMEA}} {{missing|fallback}} {{gone}}', '{"first_name":"Ada","custom":{"region":"APAC"}}'); end if;
  if abs(outreach__phi(1.96) - 0.975) < 0.001 and abs(outreach__phi(-1.0) - 0.1587) < 0.001 then log := log || E'\nok   1d normal CDF'; else fails := fails + 1; log := log || E'\nFAIL 1d ' || outreach__phi(1.96); end if;

  -- ------------------------------------------------------------ 2. no authority, no write (member = Ada's owner)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_member, 'role', 'authenticated', 'email', 'member5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_member::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_profile_draft_change(sa, '{"headline":"Helping fintech CFOs close the books in 3 days"}', '{}', 'manual');
  cid := (j->>'id')::uuid;
  if j->>'status' = 'draft' and (j->'validation'->>'ok')::boolean = false and exists (select 1 from jsonb_array_elements(j->'validation'->'causes') x where x->>'code' = 'E_NO_PROFILE_AUTHORITY')
    then log := log || E'\nok   2a draft created; validation names E_NO_PROFILE_AUTHORITY'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || j::text; end if;
  begin
    perform outreach_profile_submit_change(cid);
    fails := fails + 1; log := log || E'\nFAIL 2b submitted without authority';
  exception when others then
    if sqlerrm like 'E_NO_PROFILE_AUTHORITY%' then log := log || E'\nok   2b submit refused: ' || left(sqlerrm, 60); else fails := fails + 1; log := log || E'\nFAIL 2b ' || sqlerrm; end if;
  end;
  begin
    perform outreach_profile_draft_change(sa, '{"open_to_work":{"visibility":"ALL"}}', '{}', 'manual');
    fails := fails + 1; log := log || E'\nFAIL 2c open_to_work accepted';
  exception when others then
    if sqlerrm like 'E_PROFILE_PROHIBITED%' then log := log || E'\nok   2c open_to_work refused at draft time'; else fails := fails + 1; log := log || E'\nFAIL 2c ' || sqlerrm; end if;
  end;
  -- the member is NOT Bob's owner: self-grant refused
  begin
    perform outreach_profile_authority_self(sb, array['headline']::outreach_profile_field_group_t[], 'direct');
    fails := fails + 1; log := log || E'\nFAIL 2d self-grant on someone else''s account';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   2d self-grant refused for an account the caller does not own'; else fails := fails + 1; log := log || E'\nFAIL 2d ' || sqlerrm; end if;
  end;
  -- owner-is-operator grant on Ada
  j := outreach_profile_authority_self(sa, array['headline','about']::outreach_profile_field_group_t[], 'direct');
  if (j->>'granted')::int = 2 and (select count(*) from outreach_profile_authority where sender_id = sa and revoked_at is null and granted_via = 'owner_is_operator') = 2
    then log := log || E'\nok   2e owner_is_operator grant recorded for headline + about'; else fails := fails + 1; log := log || E'\nFAIL 2e ' || j::text; end if;
  j := outreach_profile_submit_change(cid);
  if j->>'status' = 'queued' and (j->>'scheduled_for')::timestamptz > now() and exists (select 1 from outreach_actions a where a.id = (select action_id from outreach_profile_changes where id = cid) and a.action_type = 'profile_edit' and a.status = 'queued')
    then log := log || E'\nok   2f direct authority → queued with a profile_edit action at ' || to_char((j->>'scheduled_for')::timestamptz, 'Dy HH24:MI'); else fails := fails + 1; log := log || E'\nFAIL 2f ' || j::text; end if;
  select action_id into aid from outreach_profile_changes where id = cid;

  -- ------------------------------------------------------------ 3. ceilings: one per sender per day (scheduler), then the weekly per-group limit
  j := outreach_profile_draft_change(sa, '{"summary":"About text that is long enough."}', '{}', 'manual');
  cid2 := (j->>'id')::uuid;
  j := outreach_profile_submit_change(cid2);
  if j->>'status' = 'queued' and outreach_sender_local_date(sa, (j->>'scheduled_for')::timestamptz) > outreach_sender_local_date(sa, (select scheduled_for from outreach_actions where id = aid))
    then log := log || E'
ok   3a a second change the same day is scheduled on a later day (one profile edit per sender per day)'; else fails := fails + 1; log := log || E'
FAIL 3a ' || j::text; end if;
  -- pretend the first landed 2 days ago and a second headline 4 days ago: the headline group (2 per 7 days) is used up
  update outreach_profile_changes set status = 'applied', applied_at = now() - interval '2 days', scheduled_for = now() - interval '2 days' where id = cid;
  update outreach_actions set status = 'sent', executed_at = now() - interval '2 days', scheduled_for = now() - interval '2 days' where id = aid;
  insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, source, status, applied_at, submitted_at) values (ws, sa, array['headline']::outreach_profile_field_group_t[], '{"headline":"older"}', 'manual', 'applied', now() - interval '4 days', now() - interval '4 days');
  j := outreach_profile_ceiling_used(sa, 'headline');
  if (j->>'used')::int = 2 and (j->>'remaining')::int = 0 and (j->>'next_at')::timestamptz > now() then log := log || E'
ok   3b headline ceiling 2/7d used, next_at in the future'; else fails := fails + 1; log := log || E'
FAIL 3b ' || j::text; end if;
  j := outreach_profile_draft_change(sa, '{"headline":"third headline this week"}', '{}', 'manual');
  begin
    perform outreach_profile_submit_change((j->>'id')::uuid);
    fails := fails + 1; log := log || E'
FAIL 3c third headline queued';
  exception when others then
    if sqlerrm like 'E_PROFILE_CEILING%' then log := log || E'
ok   3c third headline refused by the group ceiling'; else fails := fails + 1; log := log || E'
FAIL 3c ' || sqlerrm; end if;
  end;
  perform outreach_profile_cancel_change(cid2, 'test');
  select status into st from outreach_actions where id = (select action_id from outreach_profile_changes where id = cid2);
  if st = 'cancelled' then log := log || E'
ok   3d cancelling a queued change cancels its action'; else fails := fails + 1; log := log || E'
FAIL 3d action=' || coalesce(st,'null'); end if;

  -- ------------------------------------------------------------ 4. sender-level blockers
  j := outreach_profile_why_not(s_new);
  if exists (select 1 from jsonb_array_elements(j->'blockers') x where x->>'code' = 'E_PROFILE_WARMUP') and exists (select 1 from jsonb_array_elements(j->'blockers') x where x->>'code' = 'E_PROFILE_QUIET_PERIOD')
    then log := log || E'\nok   4a level-0 + 72h quiet period both reported'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || (j->'blockers')::text; end if;
  j := outreach_profile_why_not(s_cookie);
  if exists (select 1 from jsonb_array_elements(j->'blockers') x where x->>'code' = 'E_PROFILE_IDENTITY_UNVERIFIED') and (j->>'identity_verified')::boolean = false
    then log := log || E'\nok   4b cookie-connected sender is identity-unverified'; else fails := fails + 1; log := log || E'\nFAIL 4b ' || (j->'blockers')::text; end if;
  if (select outreach_effective_cap(s_new, 'profile_edit')) = 0 and (select outreach_effective_cap(sa, 'profile_edit')) = 1
    then log := log || E'\nok   4c profile_edit daily allowance: level 0 → 0, level 2 → 1'; else fails := fails + 1; log := log || E'\nFAIL 4c'; end if;

  -- ------------------------------------------------------------ 5. propose_only: owner link → grant → awaiting_owner → owner applies
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true);
  j := outreach_profile_authority_link_create(sb, array['headline']::outreach_profile_field_group_t[], 'propose_only', null, 90);
  tok := j->>'token';
  if length(tok) = 48 and j->>'owner_email' = 'bob@test.local' then log := log || E'\nok   5a signed link created for the owner (token returned once)'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || j::text; end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  j := outreach_profile_authority_link_by_token(tok);
  if j->>'sender_name' = 'Bob Builder' and (j->>'expired')::boolean = false then log := log || E'\nok   5b link resolves by hash'; else fails := fails + 1; log := log || E'\nFAIL 5b ' || coalesce(j::text,'null'); end if;
  begin
    perform outreach_profile_authority_accept(tok, 'accept', array['headline']::outreach_profile_field_group_t[], 'direct', '{}');
    fails := fails + 1; log := log || E'\nFAIL 5c owner widened propose_only to direct';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'\nok   5c the owner cannot widen the request (propose_only → direct refused)'; else fails := fails + 1; log := log || E'\nFAIL 5c ' || sqlerrm; end if;
  end;
  j := outreach_profile_authority_accept(tok, 'accept', null, null, '{"ip":"1.2.3.4","user_agent":"smoke"}');
  if (j->>'granted')::int = 1 and (select evidence->>'ip' from outreach_profile_authority where sender_id = sb and revoked_at is null) = '1.2.3.4'
    then log := log || E'\nok   5d grant recorded with evidence, via signed_link'; else fails := fails + 1; log := log || E'\nFAIL 5d ' || j::text; end if;
  begin
    perform outreach_profile_authority_accept(tok, 'accept');
    fails := fails + 1; log := log || E'\nFAIL 5e link reusable';
  exception when others then
    if sqlerrm like 'E_PROFILE_LINK_USED%' then log := log || E'\nok   5e link is single use'; else fails := fails + 1; log := log || E'\nFAIL 5e ' || sqlerrm; end if;
  end;
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_profile_draft_change(sb, '{"headline":"Proposed by the agency"}', '{}', 'manual');
  cid := (j->>'id')::uuid;
  j := outreach_profile_submit_change(cid);
  if j->>'status' = 'awaiting_owner' and not (j ? 'approval_token') and (select action_id from outreach_profile_changes where id = cid) is null
    then log := log || E'\nok   5f propose_only → awaiting_owner, no action queued, no token exposed to the operator'; else fails := fails + 1; log := log || E'\nFAIL 5f ' || j::text; end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  tok := outreach_profile_issue_approval_token(cid);
  if (select id from outreach_profile_change_by_approval_token(tok)) = cid then log := log || E'\nok   5g approval token resolves by hash'; else fails := fails + 1; log := log || E'\nFAIL 5g'; end if;
  j := outreach_profile_owner_decide(cid, 'apply', 'bob@test.local', '{"ip":"5.6.7.8"}');
  if j->>'status' = 'queued' and (select approved_by_email from outreach_profile_changes where id = cid) = 'bob@test.local' and (select approval_token_hash from outreach_profile_changes where id = cid) is null
    then log := log || E'\nok   5h owner applied with one click → queued, token consumed'; else fails := fails + 1; log := log || E'\nFAIL 5h ' || j::text; end if;
  begin
    perform outreach_profile_owner_decide(cid, 'apply', 'bob@test.local');
    fails := fails + 1; log := log || E'\nFAIL 5i decided twice';
  exception when others then
    if sqlerrm like 'E_PROFILE_STATE%' then log := log || E'\nok   5i a second decision is refused'; else fails := fails + 1; log := log || E'\nFAIL 5i ' || sqlerrm; end if;
  end;
  -- revoking authority cancels anything still waiting on it
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_profile_draft_change(sb, '{"headline":"Second proposal"}', '{}', 'manual');
  perform outreach_profile_submit_change((j->>'id')::uuid);
  perform outreach_profile_authority_revoke((select id from outreach_profile_authority where sender_id = sb and revoked_at is null), 'owner changed mind');
  if (select status from outreach_profile_changes where id = (j->>'id')::uuid) = 'cancelled' and (select cancelled_reason from outreach_profile_changes where id = (j->>'id')::uuid) = 'authority_revoked'
    then log := log || E'\nok   5j revoking authority cancels the pending proposal'; else fails := fails + 1; log := log || E'\nFAIL 5j'; end if;

  -- ------------------------------------------------------------ 6. worker hooks: execution re-check, snapshots, applied → verified, rollback build + fidelity
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  select action_id into aid from outreach_profile_changes where id = cid;
  j := outreach_profile_change_for_action(aid);
  if (j->>'ok')::boolean = false and j->>'code' = 'E_NO_PROFILE_AUTHORITY' then log := log || E'\nok   6a execution re-check refuses a queued change whose authority was revoked'; else fails := fails + 1; log := log || E'\nFAIL 6a ' || j::text; end if;
  -- Ada: applied change with a pre snapshot, then verify + revert build
  select id into cid from outreach_profile_changes where sender_id = sa and payload->>'headline' like 'Helping fintech%';
  snap := outreach_profile_record_snapshot(sa, 'pre_change', array['about'], 'full', '{"headline":"Old headline at Old Co","summary":"Old about","picture_url":"https://media.licdn.com/old.jpg","location":"London","experience":[{"id":"exp1","title":"CFO","company":"Old Co","current":true,"description":"old desc"}],"skills":[{"name":"Finance"},{"name":"Excel"}]}', '{}', cid, null);
  if (select pre_snapshot_id from outreach_profile_changes where id = cid) = snap and (select profile_snapshot_at from outreach_senders where id = sa) is not null
    then log := log || E'\nok   6b pre-change snapshot linked to the change'; else fails := fails + 1; log := log || E'\nFAIL 6b'; end if;
  perform outreach_profile_mark_verified(cid, array['headline'], '{}', null);
  if (select status || '/' || coalesce(array_to_string(applied_fields, ','), '') from outreach_profile_changes where id = cid) = 'applied/headline' then log := log || E'\nok   6c verified: applied_fields recorded'; else fails := fails + 1; log := log || E'\nFAIL 6c'; end if;
  perform outreach_profile_mark_verified(cid, '{}', '{"headline":"E_PROFILE_NOT_VISIBLE"}', null);
  if (select status from outreach_profile_changes where id = cid) = 'partially_applied' then log := log || E'\nok   6d a failed field → partially_applied (the diff is the truth)'; else fails := fails + 1; log := log || E'\nFAIL 6d'; end if;
  tok := outreach_profile_issue_revert_token(cid);
  if (select id from outreach_profile_change_by_revert_token(tok)) = cid and (select revert_expires_at from outreach_profile_changes where id = cid) > now() + interval '29 days' then log := log || E'\nok   6e 30-day revert token'; else fails := fails + 1; log := log || E'\nFAIL 6e'; end if;
  j := outreach_profile_revert_build(cid);
  if j->'payload'->>'headline' = 'Old headline at Old Co' and (j->'fields'->0->>'fidelity') = 'full' and (j->>'possible')::boolean then log := log || E'\nok   6f rollback payload rebuilt from the snapshot with full fidelity'; else fails := fails + 1; log := log || E'\nFAIL 6f ' || j::text; end if;
  -- a written-only field with no prior write is declared unrecoverable, not silently dropped
  insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, source, status, applied_at, submitted_at, pre_snapshot_id)
    values (ws, sa, array['custom_link','location']::outreach_profile_field_group_t[], '{"custom_link":{"type":"WEBSITE","url":"https://new"},"location":{"id":"123"}}', 'manual', 'applied', now() - interval '1 day', now() - interval '1 day', snap) returning id into cid2;
  j := outreach_profile_revert_build(cid2);
  if jsonb_array_length(j->'unrecoverable') = 2 and (j->>'possible')::boolean = false then log := log || E'\nok   6g custom_link + location with no earlier write: unrecoverable, honestly'; else fails := fails + 1; log := log || E'\nFAIL 6g ' || j::text; end if;
  -- owner-token revert path: creates a rollback change and queues it despite the (now fully used) headline ceiling? No: ceilings apply to rollbacks too
  begin
    perform outreach_profile_revert(cid, 'member5@test.local');
    fails := fails + 1; log := log || E'\nFAIL 6h rollback bypassed the headline ceiling';
  exception when others then
    if sqlerrm like 'E_PROFILE_CEILING%' then log := log || E'\nok   6h a rollback is an ordinary change: the headline ceiling still applies'; else fails := fails + 1; log := log || E'\nFAIL 6h ' || sqlerrm; end if;
  end;
  delete from outreach_profile_changes where sender_id = sa and payload->>'headline' = 'older';   -- free one headline slot
  j := outreach_profile_revert(cid, 'member5@test.local');
  if j->>'status' = 'queued' and (select status from outreach_profile_changes where id = cid) = 'reverted' and (select source || '/' || coalesce(reverts_change_id::text,'') from outreach_profile_changes where id = (j->>'id')::uuid) = 'rollback/' || cid::text
    then log := log || E'\nok   6i owner revert queued as a rollback change; the original is marked reverted'; else fails := fails + 1; log := log || E'\nFAIL 6i ' || j::text; end if;
  perform outreach_profile_park_change((j->>'id')::uuid, '401:unauthorized');
  if (select status from outreach_profile_changes where id = (j->>'id')::uuid) = 'draft' then log := log || E'\nok   6j a 401 parks the change as a draft (never re-applied silently)'; else fails := fails + 1; log := log || E'\nFAIL 6j'; end if;

  -- ------------------------------------------------------------ 7. QA score
  j := outreach_profile_qa_compute(sa);
  if (j->>'score')::int between 1 and 99 and exists (select 1 from jsonb_array_elements(j->'checks') x where x->>'code' = 'headline_default' and (x->>'pass')::boolean = false)
     and exists (select 1 from jsonb_array_elements(j->'checks') x where x->>'code' = 'about_short' and (x->>'pass')::boolean = false)
     and (select profile_qa_score from outreach_senders where id = sa) = (j->>'score')::int
    then log := log || E'\nok   7a QA: default headline + short About flagged, score ' || (j->>'score') || ' mirrored on the sender'; else fails := fails + 1; log := log || E'\nFAIL 7a ' || j::text; end if;
  if exists (select 1 from jsonb_array_elements(j->'checks') x where x->>'code' = 'no_cover' and x->'pass' = 'null'::jsonb) then log := log || E'\nok   7b a check LinkedIn cannot answer is null, not a failure'; else fails := fails + 1; log := log || E'\nFAIL 7b'; end if;

  -- ------------------------------------------------------------ 8. templates + bulk preview/commit (manager)
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  tpl := outreach_profile_template_save(ws, null, 'Q4 offer', null, '{"headline":"{{first_name}} | Helping {{custom.segment|teams}} with {{offer}}"}', '{"offer":"faster closes"}');
  j := outreach_profile_template_render(tpl, sc, '{"custom":{"segment":"CFOs"}}');
  if j->'payload'->>'headline' = 'Cleo | Helping CFOs with faster closes' then log := log || E'\nok   8a template renders sender + custom + default variables'; else fails := fails + 1; log := log || E'\nFAIL 8a ' || j::text; end if;
  begin
    perform outreach_profile_template_save(ws, null, 'bad', null, '{"experience":{"role":"CEO","company":"{{company}}","notify_network":true}}', '{}');
    fails := fails + 1; log := log || E'\nFAIL 8b template with notify_network saved';
  exception when others then
    if sqlerrm like 'E_PROFILE_PROHIBITED%' then log := log || E'\nok   8b template with notify_network refused'; else fails := fails + 1; log := log || E'\nFAIL 8b ' || sqlerrm; end if;
  end;
  -- Cleo has direct headline authority, Dan has none: bulk preview excludes Dan with the reason
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  insert into outreach_profile_authority(workspace_id, sender_id, field_group, mode, granted_by_email, granted_via) values (ws, sc, 'headline', 'direct', 'cleo@test.local', 'signed_link');
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_profile_bulk_preview(tpl, array[sc, sd, s_new], '{"custom":{"segment":"CFOs"}}');
  run := (j->>'run_id')::uuid;
  if (j->>'eligible')::int = 1 and (j->>'excluded')::int = 2
     and exists (select 1 from jsonb_array_elements(j->'rows') r where r->>'sender_id' = sd::text and r->'causes'->0->>'code' = 'E_NO_PROFILE_AUTHORITY')
     and exists (select 1 from jsonb_array_elements(j->'rows') r where r->>'sender_id' = s_new::text and (r->>'ok')::boolean = false)
    then log := log || E'\nok   8c bulk preview: 1 eligible, 2 excluded with reasons'; else fails := fails + 1; log := log || E'\nFAIL 8c ' || j::text; end if;
  j := outreach_profile_bulk_commit(run);
  if (j->>'queued')::int = 1 and (j->>'failed')::int = 0 and (select status from outreach_profile_bulk_runs where id = run) = 'committed' then log := log || E'\nok   8d bulk commit queued one change'; else fails := fails + 1; log := log || E'\nFAIL 8d ' || j::text; end if;
  begin
    perform outreach_profile_bulk_commit(run);
    fails := fails + 1; log := log || E'\nFAIL 8e committed twice';
  exception when others then
    if sqlerrm like 'E_PREVIEW_EXPIRED%' then log := log || E'\nok   8e a preview commits once'; else fails := fails + 1; log := log || E'\nFAIL 8e ' || sqlerrm; end if;
  end;
  -- bulk fabrication guard: a template that CREATES a position cannot go to more than one sender
  tpl := outreach_profile_template_save(ws, null, 'Fake job', null, '{"experience":{"role":"Head of Sales","company":"Acme"}}', '{}');
  j := outreach_profile_bulk_preview(tpl, array[sc, sd], '{}');
  if (j->>'eligible')::int = 0 and exists (select 1 from jsonb_array_elements(j->'rows') r, jsonb_array_elements(r->'causes') c where c->>'code' = 'E_PROFILE_PROHIBITED')
    then log := log || E'\nok   8f creating a position in bulk is prohibited for every sender'; else fails := fails + 1; log := log || E'\nFAIL 8f ' || j::text; end if;

  -- ------------------------------------------------------------ 9. experiments: guards + readout statistics
  begin
    perform outreach_profile_experiment_create(ws, 'too few', 'headline', '[{"key":"A","value":"a"},{"key":"B","value":"b"}]', array[sc, sd]);
    fails := fails + 1; log := log || E'\nFAIL 9a experiment with 1 sender per arm accepted';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'\nok   9a minimum 2 senders per variant enforced'; else fails := fails + 1; log := log || E'\nFAIL 9a ' || sqlerrm; end if;
  end;
  eid := outreach_profile_experiment_create(ws, 'Headline test', 'headline', '[{"key":"A","value":"Headline A"},{"key":"B","value":"Headline B"}]', array[sa, sb, sc, sd]);
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  update outreach_profile_experiments set status = 'running', assignment = jsonb_build_object(sa::text, 'A', sb::text, 'A', sc::text, 'B', sd::text, 'B'), started_at = now() - interval '20 days', washout_until = now() - interval '17 days' where id = eid;
  -- 250 resolved invites per arm: A 62 accepted, B 78 accepted (the PRD's worked example)
  for i in 1..500 loop
    insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'smoke5-l' || i, 'L' || i) returning id into l;
    insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at)
      values (l, case when i <= 250 then (case when i % 2 = 0 then sa else sb end) else (case when i % 2 = 0 then sc else sd end) end, 'pending_out', now() - interval '16 days',
              case when (i <= 250 and i <= 62) or (i > 250 and i <= 328) then now() - interval '15 days' end);
  end loop;
  j := outreach_profile_experiment_result(eid);
  if j->>'verdict' = 'not_conclusive' and (j->'comparison'->>'rate_b')::numeric = 31.2 and (j->'comparison'->>'rate_a')::numeric = 24.8 and (j->'comparison'->>'difference_points')::numeric = 6.4
     and (j->'comparison'->>'ci_low')::numeric < 0 and (j->'comparison'->>'ci_high')::numeric > 13 and j->>'summary' like '%Not conclusive%' and (j->'comparison'->>'required_per_variant')::int between 600 and 1000
    then log := log || E'\nok   9b readout: B 31.2% vs A 24.8%, +6.4 points, CI crosses zero → not conclusive, ~' || (j->'comparison'->>'required_per_variant') || ' needed'; else fails := fails + 1; log := log || E'\nFAIL 9b ' || j::text; end if;
  if exists (select 1 from jsonb_array_elements(j->'warnings') w where w->>'code' = 'cluster') and (j->>'ready')::boolean then log := log || E'\nok   9c cluster warning (<5 senders per arm) + ready (≥120 resolved per arm)'; else fails := fails + 1; log := log || E'\nFAIL 9c ' || j::text; end if;
  j := outreach_profile_experiment_advance();
  if (select status from outreach_profile_experiments where id = eid) = 'ready' then log := log || E'\nok   9d worker moved the experiment to ready'; else fails := fails + 1; log := log || E'\nFAIL 9d ' || j::text; end if;
  -- lock: while the experiment runs, headline edits on a participant are blocked
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  j := outreach_profile_draft_change(sc, '{"headline":"Sneaky edit"}', '{}', 'manual');
  if exists (select 1 from jsonb_array_elements(j->'validation'->'causes') x where x->>'code' = 'E_EXPERIMENT_LOCK') then log := log || E'\nok   9e experiment locks the tested field group'; else fails := fails + 1; log := log || E'\nFAIL 9e ' || j::text; end if;
  begin
    perform outreach_profile_experiment_conclude(eid, true);
    fails := fails + 1; log := log || E'\nFAIL 9f applied a winner on a crossing interval';
  exception when others then
    if sqlerrm like 'E_EXPERIMENT_NO_WINNER%' then log := log || E'\nok   9f no winner is ever applied on a crossing interval'; else fails := fails + 1; log := log || E'\nFAIL 9f ' || sqlerrm; end if;
  end;
  j := outreach_profile_experiment_conclude(eid, false);
  if j->>'status' = 'concluded' and j->>'winner' is null then log := log || E'\nok   9g concluded without a winner'; else fails := fails + 1; log := log || E'\nFAIL 9g ' || j::text; end if;

  -- ------------------------------------------------------------ 10. access scope: an outsider gets nothing
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_other, 'role', 'authenticated', 'email', 'other@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_other::text, true);
  n := 0;
  foreach t in array array[
      format('select outreach_profile_overview(%L)', sa), format('select outreach_profile_history(%L)', sa), format('select outreach_profile_why_not(%L)', sa),
      format('select outreach_profile_draft_change(%L, ''{"headline":"x"}'')', sa), format('select outreach_profile_authority_list(%L)', sa),
      format('select outreach_profile_authority_self(%L, array[''headline'']::outreach_profile_field_group_t[], ''direct'')', sa),
      format('select outreach_profile_revert_build(%L)', cid), format('select outreach_profile_experiments_list(%L)', ws), format('select outreach_profile_changes_list(%L)', ws),
      format('select outreach_profile_bulk_preview(%L, array[%L]::uuid[])', tpl, sc), format('select outreach_profile_qa_compute(%L)', sa)] loop
    begin
      execute t; fails := fails + 1; log := log || E'\nFAIL 10 outsider answered: ' || substring(t from 'outreach_[a-z_]+');
    exception when others then
      if sqlerrm ~ 'E_FORBIDDEN|permission denied' then n := n + 1; else fails := fails + 1; log := log || E'\nFAIL 10 ' || substring(t from 'outreach_[a-z_]+') || ' → ' || sqlerrm; end if;
    end;
  end loop;
  if n = 11 then log := log || E'\nok   10 outsider refused by all 11 user-facing functions'; end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  begin
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims', jsonb_build_object('sub', u_other, 'role', 'authenticated')::text, true);
    begin
      perform outreach_profile_owner_decide(cid, 'apply', 'x@test.local');
      fails := fails + 1; log := log || E'\nFAIL 10b a signed-in user could call the owner-decide function';
    exception when others then
      if sqlerrm ~ 'E_FORBIDDEN|permission denied' then log := log || E'\nok   10b service-only functions are closed to signed-in users'; else fails := fails + 1; log := log || E'\nFAIL 10b ' || sqlerrm; end if;
    end;
    execute 'reset role';
  end;

  -- ------------------------------------------------------------ 11. workspace toggle off (the default): no authority needed, direct mode, no owner step
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_owner, 'role', 'authenticated', 'email', 'owner5@test.local')::text, true);
  perform set_config('request.jwt.claim.sub', u_owner::text, true); perform set_config('request.jwt.claim.role', 'authenticated', true);
  update outreach_workspaces set settings = settings - 'profile_owner_permission' where id = ws;
  j := outreach_profile_why_not(sd);
  if (j->>'permission_required')::boolean = false then log := log || E'\nok   11a permission_required reports the workspace toggle (off by default)'; else fails := fails + 1; log := log || E'\nFAIL 11a ' || j::text; end if;
  j := outreach_profile_draft_change(sd, '{"headline":"No sign-off needed"}', '{}', 'manual');
  if (j->'validation'->>'ok')::boolean and j->'validation'->>'mode' = 'direct' then log := log || E'\nok   11b a sender without any grant validates in direct mode'; else fails := fails + 1; log := log || E'\nFAIL 11b ' || j::text; end if;
  j := outreach_profile_submit_change((j->>'id')::uuid);
  if j->>'status' = 'queued' then log := log || E'\nok   11c queued straight away, no owner step'; else fails := fails + 1; log := log || E'\nFAIL 11c ' || j::text; end if;
  update outreach_workspaces set settings = settings || '{"profile_owner_permission": true}' where id = ws;
  j := outreach_profile_draft_change(sd, '{"summary":"Needs sign-off again"}', '{}', 'manual');
  if exists (select 1 from jsonb_array_elements(j->'validation'->'causes') x where x->>'code' = 'E_NO_PROFILE_AUTHORITY') then log := log || E'\nok   11d switching the toggle on restores the authority requirement'; else fails := fails + 1; log := log || E'\nFAIL 11d ' || j::text; end if;
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (profile studio: serialiser mirror, authority, ceilings, owner flow, worker hooks, rollback fidelity, QA, templates/bulk, experiments, scope)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
