-- Smoke test — 099 email outbox, log and sending domains (custom-sending-domain-PRD.md §14). Builds fixtures, asserts, then
-- RAISES so everything rolls back. Ends with "SMOKE OK". Runs as the service role.
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_29_email_outbox.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; j2 jsonb; n int; t text; u uuid; r record;
  ws uuid; ws2 uuid; u_owner uuid; s_out uuid; s_mine uuid; dom uuid; ob1 uuid; ob2 uuid; ob3 uuid; ob4 uuid; tid uuid;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke29', 'smoke29-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email) values (ws, u_owner, 'owner', 'owner29@test.local');
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke29b', 'smoke29b-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws2;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_email, owner_user_id, connected_by, connected_at, timezone)
    values (ws, 'LINKEDIN', 'Outside Holder', 'ok', 's29o-' || ws, 'pid-o-' || ws, 'priya29@client.test', null, u_owner, now() - interval '10 days', 'UTC') returning id into s_out;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, provider_user_id, owner_email, owner_user_id, connected_by, connected_at, timezone)
    values (ws, 'LINKEDIN', 'Mine Holder', 'ok', 's29m-' || ws, 'pid-m-' || ws, null, u_owner, u_owner, now() - interval '10 days', 'UTC') returning id into s_mine;

  -- ============================================================ 1. catalogue + domain choice
  select count(*) into n from outreach_email_types;
  if n >= 70 then log := log || E'\nok   1a the catalogue is seeded (' || n || ' types)'; else fails := fails + 1; log := log || E'\nFAIL 1a catalogue ' || n; end if;
  j := outreach_email_domain_for('team_invite', ws);
  if (j->>'platform')::boolean then log := log || E'\nok   1b a team email is always platform'; else fails := fails + 1; log := log || E'\nFAIL 1b ' || j::text; end if;
  j := outreach_email_domain_for('sender_reconnect_needed', ws, null, true);
  if (j->>'platform')::boolean and j->>'fallback_reason' is null then log := log || E'\nok   1c no domain → platform, no fallback reason'; else fails := fails + 1; log := log || E'\nFAIL 1c ' || j::text; end if;
  begin perform outreach_email_domain_for('no_such_type', ws); fails := fails + 1; log := log || E'\nFAIL 1d unknown type accepted';
  exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'\nok   1d an unknown type is refused'; else fails := fails + 1; log := log || E'\nFAIL 1d ' || sqlerrm; end if; end;
  insert into outreach_sending_domains(workspace_id, domain, resend_domain_id, state, resend_status, from_name, reply_to, verified_at, activated_at, warmup_started_at, daily_cap, created_by)
    values (ws, 'notify.smoke29-' || left(ws::text, 8) || '.test', 'rd-' || ws, 'active', 'verified', 'Smoke Agency', 'support@smoke29.test', now(), now(), now(), 2, u_owner) returning id into dom;
  insert into outreach_sending_domain_keys(sending_domain_id, api_key_enc) values (dom, 'enc-key');
  j := outreach_email_domain_for('sender_reconnect_needed', ws, null, true);
  if (j->>'platform')::boolean = false and (j->>'domain_id')::uuid = dom and j->>'from_address' like 'notifications@notify.%' and j->>'reply_to' = 'support@smoke29.test'
    then log := log || E'\nok   1e an outside holder email uses the active domain'; else fails := fails + 1; log := log || E'\nFAIL 1e ' || j::text; end if;
  j := outreach_email_domain_for('sender_reconnect_needed', ws, null, false);
  if (j->>'platform')::boolean then log := log || E'\nok   1f the same email to a member stays on the platform (D7)'; else fails := fails + 1; log := log || E'\nFAIL 1f ' || j::text; end if;
  j := outreach_email_domain_for('client_report', ws);
  if (j->>'platform')::boolean = false then log := log || E'\nok   1g a client email uses the domain'; else fails := fails + 1; log := log || E'\nFAIL 1g ' || j::text; end if;
  j := outreach_email_domain_for('billing_payment_failed', ws);
  if (j->>'platform')::boolean then log := log || E'\nok   1h billing stays platform'; else fails := fails + 1; log := log || E'\nFAIL 1h'; end if;
  update outreach_sending_domains set paused_at = now(), paused_reason = 'dns' where id = dom;
  j := outreach_email_domain_for('client_report', ws);
  if (j->>'platform')::boolean and j->>'fallback_reason' = 'dns' then log := log || E'\nok   1i a paused domain falls back with its reason'; else fails := fails + 1; log := log || E'\nFAIL 1i ' || j::text; end if;
  update outreach_sending_domains set paused_at = null, paused_reason = null where id = dom;

  -- ============================================================ 2. enqueue
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'client_report', 'to', 'Client29@Test.local', 'subject', 'Report', 'html', '<p>hi</p>', 'idempotency_key', 'client_report:smoke29:1'));
  ob1 := (j->>'outbox_id')::uuid;
  if ob1 is not null and j->>'status' = 'queued' and (j->>'platform')::boolean = false then log := log || E'\nok   2a a client email is queued on the domain'; else fails := fails + 1; log := log || E'\nFAIL 2a ' || j::text; end if;
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'client_report', 'to', 'client29@test.local', 'subject', 'Report', 'html', '<p>hi</p>', 'idempotency_key', 'client_report:smoke29:1'));
  if (j->>'duplicate')::boolean and (j->>'outbox_id')::uuid = ob1 then log := log || E'\nok   2b the same idempotency key is sent once'; else fails := fails + 1; log := log || E'\nFAIL 2b ' || j::text; end if;
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'client_report', 'to', 'client29@test.local', 'subject', 'Report 2', 'html', '<p>two</p>', 'idempotency_key', 'client_report:smoke29:2'));
  ob2 := (j->>'outbox_id')::uuid;
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'client_report', 'to', 'client29@test.local', 'subject', 'Report 3', 'html', '<p>three</p>', 'idempotency_key', 'client_report:smoke29:3'));
  if (j->>'platform')::boolean and j->>'fallback_reason' = 'warmup_cap' then log := log || E'\nok   2c the warm-up cap sends the overflow from the platform'; else fails := fails + 1; log := log || E'\nFAIL 2c ' || j::text; end if;
  begin perform outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'nope', 'to', 'a@b.co', 'subject', 's', 'html', 'h')); fails := fails + 1; log := log || E'\nFAIL 2d unknown type accepted';
  exception when others then log := log || E'\nok   2d an unknown type is refused by enqueue'; end;
  begin perform outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'sender_reconnect_needed', 'to', 'a@b.co', 'subject', 's', 'html', 'h')); fails := fails + 1; log := log || E'\nFAIL 2e holder email without sender accepted';
  exception when others then log := log || E'\nok   2e a holder email must name its sender'; end;
  begin perform outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'client_report', 'to', 'not-an-email', 'subject', 's', 'html', 'h')); fails := fails + 1; log := log || E'\nFAIL 2f bad address accepted';
  exception when others then log := log || E'\nok   2f a bad address is refused'; end;
  -- a team email a person turned off
  insert into outreach_notification_prefs(user_id, workspace_id, kind, push, email) values (u_owner, ws, 'sender_disconnected', true, false);
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'sender_disconnected_team', 'to', 'owner29@test.local', 'subject', 's', 'html', 'h', 'recipient_user_id', u_owner));
  if j->>'skipped' = 'preference' then log := log || E'\nok   2g a team email honours the preference'; else fails := fails + 1; log := log || E'\nFAIL 2g ' || j::text; end if;
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'sender_mass_disconnect', 'to', 'owner29@test.local', 'subject', 's', 'html', 'h', 'recipient_user_id', u_owner, 'idempotency_key', 'mass:29'));
  if j->>'status' = 'queued' then log := log || E'\nok   2h a safety-critical email ignores preferences'; else fails := fails + 1; log := log || E'\nFAIL 2h ' || j::text; end if;
  -- a direct send is logged as sent at once
  j := outreach_email_enqueue(jsonb_build_object('workspace_id', ws, 'type', 'auth_magic_link', 'to', 'owner29@test.local', 'subject', 'Sign in', 'html', 'h', 'direct', true, 'ok', true, 'resend_email_id', 're-direct-29', 'from_address', 'GrowthxAI <n@updates.test>', 'platform', true, 'idempotency_key', 'auth:29'));
  if j->>'status' = 'sent' and exists (select 1 from outreach_email_log where outbox_id = (j->>'outbox_id')::uuid and delivery_status = 'sent') then log := log || E'\nok   2i a direct send lands in the log as sent'; else fails := fails + 1; log := log || E'\nFAIL 2i ' || j::text; end if;

  -- ============================================================ 3. claim and results
  select count(*) into n from outreach_email_outbox_claim(10);
  if n = 4 then log := log || E'\nok   3a the claim takes every due row (' || n || ')'; else fails := fails + 1; log := log || E'\nFAIL 3a claimed ' || n; end if;
  select api_key_enc into t from outreach_email_outbox o join outreach_sending_domain_keys k on k.sending_domain_id = o.sending_domain_id where o.id = ob1;
  if t = 'enc-key' and (select status from outreach_email_outbox where id = ob1) = 'sending' then log := log || E'\nok   3b the row is locked with its domain key'; else fails := fails + 1; log := log || E'\nFAIL 3b'; end if;
  select count(*) into n from outreach_email_outbox_claim(10);
  if n = 0 then log := log || E'\nok   3c a locked row is not claimed twice'; else fails := fails + 1; log := log || E'\nFAIL 3c ' || n; end if;
  j := outreach_email_outbox_result(ob1, 'sent', 're-1');
  if (select status from outreach_email_outbox where id = ob1) = 'sent' and exists (select 1 from outreach_email_log where outbox_id = ob1 and delivery_status = 'sent' and sending_domain_id = dom)
    then log := log || E'\nok   3d sent → status sent + log row'; else fails := fails + 1; log := log || E'\nFAIL 3d ' || j::text; end if;
  j := outreach_email_outbox_result(ob2, 'domain_error', null, 'The domain is not verified', 'Smoke Agency via GrowthxAI');
  select * into r from outreach_email_outbox where id = ob2;
  if (j->>'fell_back')::boolean and r.status = 'queued' and r.sending_domain_id is null and r.fell_back and r.fallback_reason = 'send_error' and r.from_address = 'Smoke Agency via GrowthxAI'
     and (select paused_reason from outreach_sending_domains where id = dom) = 'send_error' and (j->>'domain_paused')::uuid = dom
    then log := log || E'\nok   3e a domain error pauses the domain and re-queues the email from the platform (§5.3 step 3)'; else fails := fails + 1; log := log || E'\nFAIL 3e ' || j::text || ' ' || row_to_json(r)::text; end if;
  update outreach_sending_domains set paused_at = null, paused_reason = null where id = dom;
  -- transient retries: +30 s, +2 min, +10 min, +1 h, then failed
  insert into outreach_email_outbox(workspace_id, type, audience, to_address, subject, html, from_address, idempotency_key, status) values (ws, 'client_report', 'client', 'x@test.local', 's', 'h', 'platform', 'retry:29', 'sending') returning id into ob3;
  j := outreach_email_outbox_result(ob3, 'transient', null, '503');
  if j->>'status' = 'queued' and j->>'retry_in' = '00:00:30' then log := log || E'\nok   3f first transient failure retries in 30 s'; else fails := fails + 1; log := log || E'\nFAIL 3f ' || j::text; end if;
  update outreach_email_outbox set status = 'sending' where id = ob3; j := outreach_email_outbox_result(ob3, 'transient');
  update outreach_email_outbox set status = 'sending' where id = ob3; j := outreach_email_outbox_result(ob3, 'transient');
  update outreach_email_outbox set status = 'sending' where id = ob3; j := outreach_email_outbox_result(ob3, 'transient');
  if j->>'status' = 'queued' and j->>'retry_in' = '01:00:00' then log := log || E'\nok   3g the fourth transient failure waits an hour'; else fails := fails + 1; log := log || E'\nFAIL 3g ' || j::text; end if;
  update outreach_email_outbox set status = 'sending' where id = ob3; j := outreach_email_outbox_result(ob3, 'transient');
  if j->>'status' = 'failed' then log := log || E'\nok   3h the fifth failure is final'; else fails := fails + 1; log := log || E'\nFAIL 3h ' || j::text; end if;
  -- a safety-critical brand email still unsent after 3 tries goes from the platform
  insert into outreach_email_outbox(workspace_id, sender_id, type, audience, safety_critical, outside_holder, to_address, subject, html, sending_domain_id, from_address, idempotency_key, status, attempts)
    values (ws, s_out, 'sender_reconnect_needed', 'holder', true, true, 'priya29@client.test', 's', 'h', dom, 'notifications@x.test', 'safety:29', 'sending', 2) returning id into ob4;
  j := outreach_email_outbox_result(ob4, 'transient', null, '500', 'Smoke Agency via GrowthxAI');
  if (j->>'fell_back')::boolean and (select sending_domain_id is null and fell_back and fallback_reason = 'retries' from outreach_email_outbox where id = ob4)
    then log := log || E'\nok   3i a safety-critical email falls back to the platform after the third try (§5.3 step 4)'; else fails := fails + 1; log := log || E'\nFAIL 3i ' || j::text; end if;
  j := outreach_email_outbox_result(ob4, 'invalid', null, 'bad to');
  if (select status from outreach_email_outbox where id = ob4) = 'failed' then log := log || E'\nok   3j an invalid recipient fails without retry'; else fails := fails + 1; log := log || E'\nFAIL 3j'; end if;

  -- ============================================================ 4. delivery events + the bounce task
  j := outreach_email_event('re-1', 'email.delivered', '{}'::jsonb);
  if (j->>'ok')::boolean and (select delivery_status from outreach_email_log where outbox_id = ob1) = 'delivered' then log := log || E'\nok   4a delivered updates the log'; else fails := fails + 1; log := log || E'\nFAIL 4a ' || j::text; end if;
  update outreach_email_outbox set status = 'sent', resend_email_id = 're-h', sent_at = now() where id = ob4;
  j := outreach_email_event('re-h', 'email.bounced', jsonb_build_object('bounce', jsonb_build_object('type', 'Permanent', 'subType', 'General')));
  if (j->>'hard_bounce')::boolean and j->>'audience' = 'holder' and (j->>'outside_holder')::boolean and (select delivery_status || ':' || bounce_type from outreach_email_log where outbox_id = ob4) = 'bounced:Permanent'
    then log := log || E'\nok   4b a hard bounce on a holder email is reported as such'; else fails := fails + 1; log := log || E'\nFAIL 4b ' || j::text; end if;
  tid := outreach_email_bounce_task(ob4);
  if tid is not null and exists (select 1 from outreach_tasks where id = tid and sender_id = s_out and assigned_to = u_owner and node_id = 'email_bounce' and title like 'The sign-in email to priya29@client.test bounced')
    then log := log || E'\nok   4c the bounce opens a task for the connecting member'; else fails := fails + 1; log := log || E'\nFAIL 4c ' || coalesce(tid::text, 'null'); end if;
  if outreach_email_bounce_task(ob4) is null then log := log || E'\nok   4d one open task per sender'; else fails := fails + 1; log := log || E'\nFAIL 4d'; end if;
  j := outreach_email_event('re-1', 'email.delivery_delayed', '{}'::jsonb);
  if (select delivery_status from outreach_email_log where outbox_id = ob1) = 'delayed' and jsonb_array_length((select events from outreach_email_log where outbox_id = ob1)) = 2
    then log := log || E'\nok   4e events accumulate'; else fails := fails + 1; log := log || E'\nFAIL 4e'; end if;
  if (outreach_email_event('unknown-id', 'email.sent')->>'ok')::boolean = false then log := log || E'\nok   4f an unknown email id is ignored'; else fails := fails + 1; log := log || E'\nFAIL 4f'; end if;

  -- ============================================================ 5. reads
  j := outreach_email_log_search(ws, 'client29', null, null, null, null, 10);
  if (j->>'total')::int = 1 and j#>>'{rows,0,to}' = 'client29@test.local' then log := log || E'\nok   5a the log search finds by recipient'; else fails := fails + 1; log := log || E'\nFAIL 5a ' || j::text; end if;
  j := outreach_email_log_search(ws, null, null, 'bounced', null, null, 10);
  if (j->>'total')::int = 1 and j#>>'{rows,0,type}' = 'sender_reconnect_needed' then log := log || E'\nok   5b and by status'; else fails := fails + 1; log := log || E'\nFAIL 5b ' || j::text; end if;
  j := outreach_email_log_sender_last(s_out);
  if j->>'status' = 'bounced' and j->>'to' = 'priya29@client.test' and (j->>'outside')::boolean then log := log || E'\nok   5c the sender page line shows the last holder email'; else fails := fails + 1; log := log || E'\nFAIL 5c ' || coalesce(j::text, 'null'); end if;
  j := outreach_sending_domains(ws);
  if jsonb_array_length(j->'domains') = 1 and (j#>>'{domains,0,sent_today}')::int >= 1 and (j->'feature')::text = 'true' and (j#>>'{domains,0,fallbacks7}')::int >= 1
    then log := log || E'\nok   5d the domains view carries counts'; else fails := fails + 1; log := log || E'\nFAIL 5d ' || j::text; end if;
  j := outreach_email_types_by_rule();
  if jsonb_array_length(j->'brand') > 10 and jsonb_array_length(j->'platform') > 20 and jsonb_array_length(j->'auth') = 6 then log := log || E'\nok   5e the brand / platform lists'; else fails := fails + 1; log := log || E'\nFAIL 5e'; end if;
  j := outreach_email_platform_stats();
  if j ? 'outbox_backlog' and j ? 'domains' then log := log || E'\nok   5f platform stats'; else fails := fails + 1; log := log || E'\nFAIL 5f ' || j::text; end if;

  -- ============================================================ 6. domain checks
  j := outreach_sending_domain_check(ws2, 'notify.acme-smoke29.com');
  if (j->>'ok')::boolean and jsonb_array_length(j->'warnings') = 0 and j->>'root' = 'acme-smoke29.com' then log := log || E'\nok   6a a good subdomain passes'; else fails := fails + 1; log := log || E'\nFAIL 6a ' || j::text; end if;
  j := outreach_sending_domain_check(ws2, 'not a domain');
  if (j->>'ok')::boolean = false then log := log || E'\nok   6b a bad hostname fails'; else fails := fails + 1; log := log || E'\nFAIL 6b'; end if;
  j := outreach_sending_domain_check(ws2, 'notify.smoke29-' || left(ws::text, 8) || '.test');
  if (j->>'ok')::boolean = false and j#>>'{errors,0}' like 'This domain is in use by another%' then log := log || E'\nok   6c a domain live elsewhere is refused'; else fails := fails + 1; log := log || E'\nFAIL 6c ' || j::text; end if;
  j := outreach_sending_domain_check(ws2, 'acme-smoke29.com');
  if (j->>'ok')::boolean and j#>>'{warnings,0}' like 'This is your root domain%' then log := log || E'\nok   6d a root domain warns'; else fails := fails + 1; log := log || E'\nFAIL 6d ' || j::text; end if;
  insert into outreach_senders(workspace_id, provider, display_name, status, owner_email, connected_by, timezone) values (ws2, 'GMAIL', 'Mail', 'ok', 'sales@acme-smoke29.com', u_owner, 'UTC');
  j := outreach_sending_domain_check(ws2, 'notify.acme-smoke29.com');
  if j#>>'{warnings,0}' like 'This looks like the domain you send outreach from%' then log := log || E'\nok   6e an outreach mailbox domain warns'; else fails := fails + 1; log := log || E'\nFAIL 6e ' || j::text; end if;
  begin insert into outreach_sending_domains(workspace_id, domain) values (ws2, 'notify.smoke29-' || left(ws::text, 8) || '.test'); fails := fails + 1; log := log || E'\nFAIL 6f duplicate live domain accepted';
  exception when unique_violation then log := log || E'\nok   6f the unique index refuses a second live row'; end;

  -- ============================================================ 7. housekeeping
  update outreach_email_outbox set created_at = now() - interval '31 days' where id = ob3;
  j := outreach_email_retention();
  if (j->>'bodies_cleared')::int >= 1 and (select html is null from outreach_email_outbox where id = ob3) then log := log || E'\nok   7a bodies are cleared after 30 days'; else fails := fails + 1; log := log || E'\nFAIL 7a ' || j::text; end if;
  j := outreach_sending_domains_health();
  if jsonb_array_length(j) = 0 then log := log || E'\nok   7b one bounce out of two is below the 25-send floor'; else fails := fails + 1; log := log || E'\nFAIL 7b ' || j::text; end if;
  update outreach_sending_domains set warmup_started_at = now() - interval '20 days' where id = dom;
  perform outreach_sending_domains_health();
  if (select daily_cap from outreach_sending_domains where id = dom) is null then log := log || E'\nok   7c the warm-up cap lifts after 14 days'; else fails := fails + 1; log := log || E'\nFAIL 7c'; end if;
  j := outreach_sending_domains_plan_sync();
  if (j->>'paused')::int = 0 then log := log || E'\nok   7d a plan that includes the feature pauses nothing'; else fails := fails + 1; log := log || E'\nFAIL 7d ' || j::text; end if;
  n := outreach_email_outbox_reroute(dom);
  if n >= 0 then log := log || E'\nok   7e reroute runs (' || n || ')'; end if;

  -- ============================================================ 8. scheduling + grants
  if exists (select 1 from outreach_cron_jobs where name = 'email-outbox' and fn = 'outreach-email-outbox' and every_s = 15 and guarded) and exists (select 1 from outreach_cron_jobs where name = 'sending-domains-verify')
    then log := log || E'\nok   8a dispatcher rows'; else fails := fails + 1; log := log || E'\nFAIL 8a'; end if;
  update outreach_email_outbox set status = 'queued', next_attempt_at = now() where id = ob2;
  if outreach_cron_has_work('email-outbox') then log := log || E'\nok   8b the outbox guard sees a due row'; else fails := fails + 1; log := log || E'\nFAIL 8b'; end if;
  if exists (select 1 from cron.job where jobname = 'outreach-sending-domains-daily') then log := log || E'\nok   8c the nightly domain job is scheduled'; else fails := fails + 1; log := log || E'\nFAIL 8c'; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_email_log_search','outreach_email_log_sender_last','outreach_sending_domains','outreach_sending_domain_check','outreach_email_types_by_rule','outreach_email_platform_stats');
  if n = 6 then log := log || E'\nok   8d the six user RPCs are granted'; else fails := fails + 1; log := log || E'\nFAIL 8d granted: ' || n; end if;
  select count(*) into n from information_schema.routine_privileges where grantee = 'authenticated' and specific_schema = 'public'
    and routine_name in ('outreach_email_enqueue','outreach_email_outbox_claim','outreach_email_outbox_result','outreach_email_event','outreach_email_bounce_task','outreach_email_domain_for','outreach_email_retention','outreach_user_email');
  if n = 0 then log := log || E'\nok   8e the service RPCs are not callable by signed-in users'; else fails := fails + 1; log := log || E'\nFAIL 8e leaked: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
