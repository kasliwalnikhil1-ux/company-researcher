-- Smoke test — 100 sender lifecycle v1.2 (sender-lifecycle-PRD-v2.md §12): the holder model, disconnect alerts and holds,
-- pause reasons, the billing clock and cancellation. Builds fixtures, asserts, then RAISES so everything rolls back.
-- Ends with "SMOKE OK". Runs as the service role (auth.uid() is null: the user RPCs are called with p_by where they take it).
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_30_lifecycle_v2.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; n int; t text; tok text; r record; b boolean;
  ws uuid; ws2 uuid; u_owner uuid; u2 uuid; u_owner_email text; u2_email text;
  s_m uuid; s_o uuid; s_t uuid; s_x uuid; s_y uuid; s_z uuid; sb1 uuid; sb2 uuid; hold_id bigint; period timestamptz;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u2 from platform_user_access where status = 'active' and user_id <> u_owner order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;
  u_owner_email := outreach_user_email(u_owner); u2_email := outreach_user_email(u2);

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke30', 'smoke30-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner30@test.local');
  if u2 is not null then insert into outreach_members(workspace_id, user_id, role, email) values (ws, u2, 'manager', 'manager30@test.local'); end if;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone, auth_method)
    values (ws, 'LINKEDIN', 'Mine', 'ok', 's30m-' || ws, 'pid-m-' || ws, u_owner, u_owner, now() - interval '10 days', 'UTC', 'credentials') returning id into s_m;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_email, connected_by, connected_at, timezone, auth_method)
    values (ws, 'LINKEDIN', 'Outside', 'ok', 's30o-' || ws, 'pid-o-' || ws, 'avi30@client.test', u_owner, now() - interval '10 days', 'UTC', 'credentials') returning id into s_o;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone, auth_method)
    values (ws, 'LINKEDIN', 'Teammate', 'ok', 's30t-' || ws, 'pid-t-' || ws, coalesce(u2, u_owner), u_owner, now() - interval '10 days', 'UTC', 'cookie') returning id into s_t;

  -- ============================================================ 1. the holder model (§5.8.1)
  begin
    insert into outreach_senders(workspace_id, provider, display_name, status, owner_user_id, owner_email, timezone) values (ws, 'LINKEDIN', 'Both', 'connecting', u_owner, 'x@y.test', 'UTC');
    fails := fails + 1; log := log || E'\nFAIL 1a a sender with both owner fields was accepted';
  exception when check_violation then log := log || E'\nok   1a exactly one of owner_user_id / owner_email (constraint)'; end;
  j := outreach_sender_holder(s_m);
  if j->>'kind' = 'member' and j->>'email' = u_owner_email and (j->>'outside')::boolean = false then log := log || E'\nok   1b Mine → the member''s sign-in email'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || j::text; end if;
  j := outreach_sender_holder(s_o);
  if j->>'kind' = 'member' and (j->>'user_id')::uuid = u_owner and j->>'email' = u_owner_email and (j->>'outside')::boolean = false then log := log || E'\nok   1c an old outside row resolves to the connecting member (103)'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || j::text; end if;
  j := outreach_sender_email_recipients(s_o, 'holder');
  if j->>'to' = u_owner_email and (j->>'outside')::boolean = false and jsonb_array_length(j->'cc') = 0 then log := log || E'\nok   1d recipients(holder) = a member''s sign-in email, nobody copied (103)'; else fails := fails + 1; log := log || E'\nFAIL 1d ' || j::text; end if;
  j := outreach_sender_email_recipients(s_o, 'team');
  if jsonb_array_length(j->'recipients') >= 1 and j#>>'{recipients,0,email}' = u_owner_email then log := log || E'\nok   1e recipients(team) = owners/managers on sign-in emails'; else fails := fails + 1; log := log || E'\nFAIL 1e ' || j::text; end if;
  j := outreach_sender_holder_view(s_m);
  if j->>'kind' = 'member' and (j->>'can_change')::boolean then log := log || E'\nok   1f the member view'; else fails := fails + 1; log := log || E'\nFAIL 1f ' || j::text; end if;
  -- an old outside row's link dies when the holder changes; grants are revoked
  tok := outreach_sender_owner_link_create(s_o, 'disconnect', 30, 'avi30@client.test');
  insert into outreach_ai_reply_consent(workspace_id, sender_id, granted_by_email, granted_via, scope, expires_at) values (ws, s_o, 'avi30@client.test', 'signed_link', '{}', now() + interval '1 year');
  j := outreach_sender_set_holder(s_o, '{"mine": true}'::jsonb, u_owner);
  if (j->>'changed')::boolean and j->>'old_outside_email' = 'avi30@client.test' and (j->>'links_cancelled')::int >= 1 and (j->>'grants_revoked')::int = 1 and (j#>>'{new,user_id}')::uuid = u_owner
    then log := log || E'\nok   1g Change → Mine: links cancelled, grants revoked, old address reported'; else fails := fails + 1; log := log || E'\nFAIL 1g ' || j::text; end if;
  if (outreach_sender_owner_link_peek(tok)->>'valid')::boolean = false and (outreach_sender_owner_link_use(tok)->>'ok')::boolean = false then log := log || E'\nok   1h the old disconnect link no longer works'; else fails := fails + 1; log := log || E'\nFAIL 1h'; end if;
  if exists (select 1 from outreach_ai_reply_consent where sender_id = s_o and revoked_reason = 'holder_changed') then log := log || E'\nok   1i revoked_reason = holder_changed'; else fails := fails + 1; log := log || E'\nFAIL 1i'; end if;
  begin perform outreach_sender_owner_link_create(s_o, 'disconnect', 30, null); fails := fails + 1; log := log || E'\nFAIL 1j a member''s account got a disconnect link';
  exception when others then if sqlerrm like 'E_CONFLICT%' then log := log || E'\nok   1j a member''s own account has no disconnect link'; else fails := fails + 1; log := log || E'\nFAIL 1j ' || sqlerrm; end if; end;
  begin
    perform outreach_sender_set_holder(s_o, jsonb_build_object('email', 'Avi30@Client.test'), u_owner);
    fails := fails + 1; log := log || E'\nFAIL 1k an outside address was accepted';
  exception when others then
    if sqlerrm like 'E_HOLDER_OUTSIDE%' then log := log || E'\nok   1k Change: an outside address is refused (103)'; else fails := fails + 1; log := log || E'\nFAIL 1k ' || sqlerrm; end if;
  end;
  if u2 is not null then
    j := outreach_sender_set_holder(s_o, jsonb_build_object('email', u2_email), u_owner);
    if (j#>>'{new,user_id}')::uuid = u2 and (j->>'notify_member')::uuid = u2 then log := log || E'\nok   1l a teammate''s email links the teammate and flags the notice'; else fails := fails + 1; log := log || E'\nFAIL 1l ' || j::text; end if;
    perform outreach_sender_set_holder(s_o, '{"mine": true}'::jsonb, u_owner);
    -- the holder leaves: the account passes to the connecting member, a task is opened, operator grants end
    insert into outreach_ai_reply_consent(workspace_id, sender_id, granted_by_email, granted_via, scope, expires_at) values (ws, s_t, u2_email, 'owner_is_operator', '{}', now() + interval '1 year');
    j := outreach_sender_holder_left(ws, u2);
    if (j->>'senders_moved')::int = 1 and (j->>'tasks')::int = 1 and (j->>'grants_revoked')::int = 1 and (select owner_user_id from outreach_senders where id = s_t) = u_owner
       and exists (select 1 from outreach_tasks where sender_id = s_t and node_id = 'holder_left' and assigned_to = u_owner)
      then log := log || E'\nok   1m a holder who left: account to the connecting member, task for the owner, grants revoked'; else fails := fails + 1; log := log || E'\nFAIL 1m ' || j::text; end if;
  else
    log := log || E'\nskip 1l/1m (one app user only)';
  end if;
  j := outreach_sender_holder(s_t);
  if j->>'kind' = 'member' then log := log || E'\nok   1n the teammate account resolves to a member'; else fails := fails + 1; log := log || E'\nFAIL 1n ' || j::text; end if;

  -- ============================================================ 2. disconnect clock (§5.8.2)
  update outreach_senders set status = 'credentials', status_reason = 'CREDENTIALS' where id = s_m;
  select * into r from outreach_senders where id = s_m;
  if r.disconnected_at is not null and r.holder_notified_at is null and r.holder_reminders_sent = 0 and exists (select 1 from outreach_alerts where kind = 'sender_disconnected' and entity_id = s_m and resolved_at is null)
    then log := log || E'\nok   2a entering credentials sets disconnected_at and opens an alert'; else fails := fails + 1; log := log || E'\nFAIL 2a'; end if;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m and d.kind = 'first';
  if n = 1 then log := log || E'\nok   2b a sign-in account is owed its email at once'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || n; end if;
  update outreach_senders set status = 'credentials', status_reason = 'CREDENTIALS', reconnect_attempts = 1 where id = s_t;
  -- a small platform may trip the platform-wide hold on our own fixtures: not what this section tests
  delete from outreach_disconnect_holds where scope = 'platform' and started_at > now() - interval '2 minutes'; update outreach_senders set holder_email_held_until = null where workspace_id = ws;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_t;
  if n = 0 then log := log || E'\nok   2c a cookie account waits for 4 silent retries'; else fails := fails + 1; log := log || E'\nFAIL 2c ' || n; end if;
  update outreach_senders set reconnect_attempts = 4 where id = s_t;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_t and d.kind = 'first';
  if n = 1 then log := log || E'\nok   2d … then it is owed the manual email'; else fails := fails + 1; log := log || E'\nFAIL 2d ' || n; end if;
  perform outreach_disconnect_holder_mark(s_m, 'first');
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m;
  if n = 0 and (select holder_notified_at is not null and reconnect_notified_at is not null from outreach_senders where id = s_m) then log := log || E'\nok   2e after the first email nothing is due today'; else fails := fails + 1; log := log || E'\nFAIL 2e ' || n; end if;
  update outreach_senders set holder_notified_at = now() - interval '25 hours' where id = s_m;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m and d.kind = 'reminder';
  if n = 1 then log := log || E'\nok   2f day 1: the first reminder is due'; else fails := fails + 1; log := log || E'\nFAIL 2f ' || n; end if;
  perform outreach_disconnect_holder_mark(s_m, 'reminder');
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m;
  if n = 0 then log := log || E'\nok   2g the second reminder waits for day 3'; else fails := fails + 1; log := log || E'\nFAIL 2g ' || n; end if;
  update outreach_senders set holder_notified_at = now() - interval '73 hours' where id = s_m;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m and d.reminders = 1;
  if n = 1 then log := log || E'\nok   2h day 3: the second reminder'; else fails := fails + 1; log := log || E'\nFAIL 2h ' || n; end if;
  perform outreach_disconnect_holder_mark(s_m, 'reminder');
  update outreach_senders set holder_notified_at = now() - interval '10 days' where id = s_m;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.sender_id = s_m;
  if n = 0 then log := log || E'\nok   2i exactly two reminders, never a third'; else fails := fails + 1; log := log || E'\nFAIL 2i ' || n; end if;
  -- the team email: 4 h after the sign-in email, once a day, final at day 7
  update outreach_senders set holder_notified_at = now() - interval '5 hours', disconnected_at = now() - interval '6 hours' where id = s_m;
  j := outreach_disconnect_team_due();
  if jsonb_array_length(j) = 1 and j#>>'{0,workspace_id}' = ws::text and (select count(*) from jsonb_array_elements(j#>'{0,senders}') x where x->>'id' = s_m::text) = 1
     and (j#>>'{0,senders,0,holder,kind}') = 'member' and jsonb_array_length(j#>'{0,recipients}') >= 1
    then log := log || E'\nok   2j the combined team email lists the account with its holder and recipients'; else fails := fails + 1; log := log || E'\nFAIL 2j ' || j::text; end if;
  perform outreach_disconnect_team_mark(array[s_m], '{}'::uuid[]);
  j := outreach_disconnect_team_due();
  if (select count(*) from jsonb_array_elements(coalesce(j#>'{0,senders}', '[]'::jsonb)) x where x->>'id' = s_m::text) = 0 then log := log || E'\nok   2k listed once a day'; else fails := fails + 1; log := log || E'\nFAIL 2k'; end if;
  update outreach_senders set team_notified_at = now() - interval '25 hours', disconnected_at = now() - interval '8 days' where id = s_m;
  j := outreach_disconnect_team_due();
  if (j#>>'{0,senders,0,final}')::boolean then log := log || E'\nok   2l day 7: the final mention'; else fails := fails + 1; log := log || E'\nFAIL 2l ' || j::text; end if;
  perform outreach_disconnect_team_mark(array[s_m], array[s_m]);
  update outreach_senders set team_notified_at = now() - interval '25 hours' where id = s_m;
  j := outreach_disconnect_team_due();
  if (select count(*) from jsonb_array_elements(coalesce(j#>'{0,senders}', '[]'::jsonb)) x where x->>'id' = s_m::text) = 0 then log := log || E'\nok   2m no team emails after the final one'; else fails := fails + 1; log := log || E'\nFAIL 2m'; end if;
  update outreach_senders set status = 'ok', status_reason = null where id = s_m;
  select * into r from outreach_senders where id = s_m;
  if r.disconnected_at is null and r.last_reconnected_at is not null and not exists (select 1 from outreach_alerts where kind = 'sender_disconnected' and entity_id = s_m and resolved_at is null)
    then log := log || E'\nok   2n reconnecting clears the clock and resolves the alert'; else fails := fails + 1; log := log || E'\nFAIL 2n'; end if;
  update outreach_senders set status = 'ok', status_reason = null, reconnect_attempts = 0 where id = s_t;

  -- ============================================================ 3. mass disconnect (§5.8.4)
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone)
    values (ws, 'LINKEDIN', 'X', 'ok', 's30x-' || ws, 'pid-x-' || ws, u_owner, u_owner, now(), 'UTC') returning id into s_x;
  update outreach_senders set status = 'credentials', status_reason = 'CREDENTIALS' where id in (s_m, s_o);
  delete from outreach_disconnect_holds where scope = 'platform' and started_at > now() - interval '2 minutes';
  if not exists (select 1 from outreach_disconnect_holds where workspace_id = ws) then log := log || E'\nok   3a two of four is under the threshold'; else fails := fails + 1; log := log || E'\nFAIL 3a'; end if;
  update outreach_senders set status = 'credentials', status_reason = 'CREDENTIALS' where id = s_x;
  select * into r from outreach_disconnect_holds where workspace_id = ws and scope = 'workspace';
  if found and r.sender_count = 3 and r.held_until > now() + interval '110 minutes' and (select holder_email_held_until from outreach_senders where id = s_x) = r.held_until
     and exists (select 1 from outreach_alerts where kind = 'mass_disconnect' and entity_id = ws and resolved_at is null)
    then log := log || E'\nok   3b three within an hour and 75% of live → a 2 h hold on every sign-in email'; hold_id := r.id; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.workspace_id = ws;
  if n = 0 then log := log || E'\nok   3c no sign-in email leaves during the hold'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || n; end if;
  j := outreach_disconnect_holds_unnotified();
  if (select count(*) from jsonb_array_elements(j) x where (x->>'id')::bigint = hold_id) = 1 and (select notified_at is not null from outreach_disconnect_holds where id = hold_id)
    then log := log || E'\nok   3d the hold is handed to the worker once'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || j::text; end if;
  j := outreach_disconnect_hold_extend(hold_id);
  if (select extended and held_until > now() + interval '3 hours' from outreach_disconnect_holds where id = hold_id) then log := log || E'\nok   3e extended once'; else fails := fails + 1; log := log || E'\nFAIL 3e'; end if;
  begin perform outreach_disconnect_hold_extend(hold_id); fails := fails + 1; log := log || E'\nFAIL 3f extended twice'; exception when others then log := log || E'\nok   3f not twice'; end;
  update outreach_disconnect_holds set held_until = now() - interval '1 minute' where id = hold_id;
  delete from outreach_disconnect_holds where scope = 'platform' and started_at > now() - interval '2 minutes';
  update outreach_senders set holder_email_held_until = now() - interval '1 minute' where workspace_id = ws;
  select count(*) into n from outreach_disconnect_holder_due(50) d where d.workspace_id = ws;
  if n = 3 then log := log || E'\nok   3g after the hold every account still down is owed its email'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || n; end if;
  update outreach_senders set status = 'ok', status_reason = null where id in (s_m, s_o, s_x);

  -- ============================================================ 4. pause reason (§3.2, D5)
  j := outreach_sender_pause(s_m, null);
  if (select pause_reason from outreach_senders where id = s_m) = 'manual' and outreach_sender_can_reply(s_m) then log := log || E'\nok   4a a person''s pause is manual; replies still go out'; else fails := fails + 1; log := log || E'\nFAIL 4a'; end if;
  perform outreach_sender_resume(s_m);
  if (select pause_reason is null and paused_at is null from outreach_senders where id = s_m) then log := log || E'\nok   4b resume clears it'; else fails := fails + 1; log := log || E'\nFAIL 4b'; end if;

  -- ============================================================ 5. billing status + the clock (§5.9)
  if (select billing_status from outreach_workspaces where id = ws) = 'active' then log := log || E'\nok   5a a paid workspace is active'; else fails := fails + 1; log := log || E'\nFAIL 5a'; end if;
  update outreach_workspaces set settings = settings || '{"timezone":"UTC"}'::jsonb where id = ws;
  j := outreach_billing_payment_failed(ws, 'in_30', 'https://pay.test/in_30', false);
  select * into r from outreach_workspaces where id = ws;
  if (j->>'first_failure')::boolean and r.billing_status = 'past_due' and r.past_due_since is not null and r.overdue_invoice_url = 'https://pay.test/in_30' and r.plan = 'scale'
    then log := log || E'\nok   5b the first failed charge starts the clock; the plan name stays (D17)'; else fails := fails + 1; log := log || E'\nFAIL 5b ' || j::text; end if;
  j := outreach_billing_payment_failed(ws, 'in_31', 'https://pay.test/in_31', false);
  if (j->>'first_failure')::boolean = false and (select past_due_since from outreach_workspaces where id = ws) = r.past_due_since then log := log || E'\nok   5c a second failure keeps the first date'; else fails := fails + 1; log := log || E'\nFAIL 5c'; end if;
  period := r.past_due_since;
  select count(*) into n from outreach_billing_steps_due() d where d.workspace_id = ws;
  if n = 1 and (select step from outreach_billing_steps_due() d where d.workspace_id = ws) = 'd0' then log := log || E'\nok   5d day 0: only the first email is due'; else fails := fails + 1; log := log || E'\nFAIL 5d ' || n; end if;
  if outreach_billing_step_claim(ws, period, 'd0') and not outreach_billing_step_claim(ws, period, 'd0') then log := log || E'\nok   5e each step runs once'; else fails := fails + 1; log := log || E'\nFAIL 5e'; end if;
  update outreach_workspaces set past_due_since = now() - interval '8 days' where id = ws; period := (select past_due_since from outreach_workspaces where id = ws);
  select string_agg(step, ',' order by day) into t from outreach_billing_steps_due() d where d.workspace_id = ws;
  if t = 'd0,d3,d6,suspend' then log := log || E'\nok   5f day 8: d0, d3, d6 and suspend are owed (late emails do not wait for 10:00)'; else fails := fails + 1; log := log || E'\nFAIL 5f ' || coalesce(t, 'none'); end if;
  j := outreach_billing_step_apply(ws, 'suspend');
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'suspended' and r.billing_status = 'suspended' and r.plan_before_suspension = 'scale' and r.data_delete_after between period + interval '66 days' and period + interval '68 days'
     and (select count(*) from outreach_senders where workspace_id = ws and status = 'paused' and pause_reason = 'billing') = 4
    then log := log || E'\nok   5g suspend: senders paused for billing, data date = day 67'; else fails := fails + 1; log := log || E'\nFAIL 5g ' || row_to_json(r)::text; end if;
  if not outreach_sender_can_reply(s_m) then log := log || E'\nok   5h a billing pause blocks replies (D18)'; else fails := fails + 1; log := log || E'\nFAIL 5h'; end if;
  begin perform outreach_sender_resume(s_m); fails := fails + 1; log := log || E'\nFAIL 5i a billing pause was lifted by hand';
  exception when others then if sqlerrm like 'E_PLAN_SUSPENDED%' then log := log || E'\nok   5i a billing pause cannot be lifted by hand'; else fails := fails + 1; log := log || E'\nFAIL 5i ' || sqlerrm; end if; end;
  j := outreach_billing_clock(ws);
  if j->>'billing_status' = 'suspended' and jsonb_array_length(j->'steps') = 3 and (j#>>'{steps,0,done}')::boolean and j->>'overdue_invoice_url' like 'https://pay.test/%'
    then log := log || E'\nok   5j the clock for the app: steps with dates'; else fails := fails + 1; log := log || E'\nFAIL 5j ' || j::text; end if;
  j := outreach_billing_email_context(ws);
  if jsonb_array_length(j->'recipients') >= 1 and j->'recipients' ? u_owner_email and jsonb_array_length(j->'senders') = 4 then log := log || E'\nok   5k the email context: owners + every live sender with its holder'; else fails := fails + 1; log := log || E'\nFAIL 5k ' || j::text; end if;
  j := outreach_billing_emails_set(ws, array['Finance@Acme.test', 'finance@acme.test', 'cfo@acme.test']);
  if jsonb_array_length(j->'billing_emails') = 2 and outreach_billing_recipients(ws) @> array['finance@acme.test', 'cfo@acme.test', u_owner_email] then log := log || E'\nok   5l billing contacts: lower-cased, de-duplicated, added to the owners'; else fails := fails + 1; log := log || E'\nFAIL 5l ' || j::text; end if;
  begin perform outreach_billing_emails_set(ws, array['nope']); fails := fails + 1; log := log || E'\nFAIL 5m bad contact accepted'; exception when others then log := log || E'\nok   5m a bad contact is refused'; end;
  update outreach_workspaces set past_due_since = now() - interval '22 days' where id = ws; period := (select past_due_since from outreach_workspaces where id = ws);
  select string_agg(step, ',' order by day) into t from outreach_billing_steps_due() d where d.workspace_id = ws;
  if t = 'd0,d3,d6,suspend,d14,remove' then log := log || E'\nok   5n day 22: d14 and remove are owed too'; else fails := fails + 1; log := log || E'\nFAIL 5n ' || coalesce(t, 'none'); end if;
  j := outreach_billing_step_apply(ws, 'remove');
  if (j->>'senders_removed')::int = 4 and (select count(*) from outreach_senders where workspace_id = ws and removal_requested_at is not null and removed_via = 'billing') = 4
     and (select count(*) from outreach_account_deletions where workspace_id = ws and done_at is null) = 4
    then log := log || E'\nok   5o day 21: every account removed with via=billing, connector deletes queued, history kept'; else fails := fails + 1; log := log || E'\nFAIL 5o ' || j::text; end if;
  perform outreach_account_deletion_result('s30m-' || ws, true);
  if (select status::text from outreach_senders where id = s_m) = 'removed' then log := log || E'\nok   5p the connector confirms → removed'; else fails := fails + 1; log := log || E'\nFAIL 5p'; end if;
  -- payment recovered
  update outreach_workspaces set stripe_status = 'active' where id = ws;
  j := outreach_workspace_reactivated(ws);
  select * into r from outreach_workspaces where id = ws;
  if r.plan = 'scale' and r.billing_status = 'active' and r.past_due_since is null and r.overdue_invoice_url is null and r.data_delete_after is null
     and jsonb_array_length(j->'removed_senders') = 1 and (j#>>'{removed_senders,0,id}') = s_m::text and (j#>>'{removed_senders,0,holder,kind}') = 'member'
     and exists (select 1 from outreach_billing_steps where workspace_id = ws and step = 'reactivated')
    then log := log || E'\nok   5q reactivation: plan back, clock cleared, removed accounts listed with their holders'; else fails := fails + 1; log := log || E'\nFAIL 5q ' || row_to_json(r)::text || ' ' || j::text; end if;
  select count(*) into n from outreach_billing_steps_due() d where d.workspace_id = ws;
  if n = 0 then log := log || E'\nok   5r nothing owed after reactivation'; else fails := fails + 1; log := log || E'\nFAIL 5r ' || n; end if;

  -- ============================================================ 6. cancellation (§5.10)
  insert into outreach_workspaces(name, slug, created_by, plan, stripe_status, settings) values ('smoke30c', 'smoke30c-' || encode(gen_random_bytes(4),'hex'), u_owner, 'launch', 'active', '{"timezone":"UTC"}') returning id into ws2;
  perform outreach_seed_workspace_defaults(ws2);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws2, u_owner, 'owner', 'owner30c@test.local');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone)
    values (ws2, 'LINKEDIN', 'C1', 'ok', 's30c1-' || ws2, 'pid-c1-' || ws2, u_owner, u_owner, now(), 'UTC') returning id into sb1;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_user_id, connected_by, connected_at, timezone)
    values (ws2, 'LINKEDIN', 'C2', 'paused', 's30c2-' || ws2, 'pid-c2-' || ws2, u_owner, u_owner, now(), 'UTC') returning id into sb2;
  n := outreach__billing_cancelled(ws2);
  select * into r from outreach_workspaces where id = ws2;
  if n = 2 and r.plan = 'cancelled' and r.billing_status = 'canceled' and r.data_delete_after between now() + interval '59 days' and now() + interval '61 days'
     and (select count(*) from outreach_senders where workspace_id = ws2 and removal_requested_at is not null and removed_via = 'canceled') = 2
    then log := log || E'\nok   6a cancellation removes every account at once (via=canceled), 60 days read-only'; else fails := fails + 1; log := log || E'\nFAIL 6a n=' || n || ' ' || row_to_json(r)::text; end if;
  update outreach_workspaces set cancelled_at = now() - interval '54 days' where id = ws2;
  select string_agg(step, ',' order by day) into t from outreach_billing_steps_due() d where d.workspace_id = ws2;
  if t = 'cancel_remove,cancel_d53' then log := log || E'\nok   6b day 54 after cancelling: the deletion warning is owed'; else fails := fails + 1; log := log || E'\nFAIL 6b ' || coalesce(t, 'none'); end if;
  j := outreach_billing_clock(ws2);
  if j->>'billing_status' = 'canceled' and jsonb_array_length(j->'steps') = 1 then log := log || E'\nok   6c the clock shows the deletion date'; else fails := fails + 1; log := log || E'\nFAIL 6c ' || j::text; end if;

  -- ============================================================ 7. odds and ends
  if (select value::int from outreach_flags where key = 'billing_cancel_data_days') = 60 then log := log || E'\nok   7a cancellation keeps data 60 days'; else fails := fails + 1; log := log || E'\nFAIL 7a'; end if;
  if (select value::text from outreach_flags where key = 'billing_clock_enforce') = 'false' then log := log || E'\nok   7b the clock starts in emails-only mode'; else fails := fails + 1; log := log || E'\nFAIL 7b'; end if;
  if position('sender_disconnected' in pg_get_functiondef('public.outreach_notification_prefs_set(uuid,text,boolean,integer,boolean)'::regprocedure)) > 0 then log := log || E'\nok   7c the preference kind sender_disconnected is accepted'; else fails := fails + 1; log := log || E'\nFAIL 7c'; end if;
  if exists (select 1 from outreach_cron_jobs where name = 'account-alerts' and every_s = 900) then log := log || E'\nok   7d the F60 dispatcher row'; else fails := fails + 1; log := log || E'\nFAIL 7d'; end if;
  j := outreach_sender_remove_begin(sb2, 'canceled', 'x', null);
  if j is not null then log := log || E'\nok   7e removed_via canceled is accepted'; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_sender_holder_view','outreach_sender_set_holder','outreach_billing_clock','outreach_billing_emails_set','outreach_sender_can_reply','outreach_disconnect_hold_extend');
  if n = 6 then log := log || E'\nok   7f the six user RPCs are granted'; else fails := fails + 1; log := log || E'\nFAIL 7f granted: ' || n; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_sender_holder','outreach_sender_email_recipients','outreach_sender_holder_left','outreach_billing_steps_due','outreach_billing_step_claim','outreach_billing_step_apply','outreach_workspace_reactivated','outreach_billing_payment_failed','outreach_disconnect_holder_due','outreach_disconnect_team_due');
  if n = 0 then log := log || E'\nok   7g the service RPCs are not callable by signed-in users'; else fails := fails + 1; log := log || E'\nFAIL 7g leaked: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
