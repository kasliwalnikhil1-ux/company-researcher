-- Smoke test — plan item 1: reply stops the lead everywhere, with a clean exit.
-- Pattern: build fixtures, assert, then RAISE with the accumulated log so the whole block rolls back.
-- A passing run ends with "SMOKE OK"; a failing assertion ends with "SMOKE FAIL".
do $$
declare
  log text := ''; fails int := 0;
  ws uuid; sa uuid; sb uuid; mb uuid; seq uuid; seq2 uuid; seq3 uuid; seq4 uuid;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; e uuid; e2 uuid; st text; n int; chat uuid; msg uuid; ts timestamptz; j jsonb; b boolean;
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
     "m1":{"id":"m1","type":"send_message","config":{"text":"hi {{first_name}}","send_always":false},"next":"d1","position":{"x":0,"y":0}},
     "d1":{"id":"d1","type":"delay","config":{"amount":2,"unit":"days"},"next":"em1","position":{"x":0,"y":0}},
     "em1":{"id":"em1","type":"send_email","config":{"subject":"s","html":"b {{unsubscribe_link}}"},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
  g_always jsonb;
  procedure_dummy int;
begin
  insert into outreach_workspaces(name, slug) values ('smoke-ws', 'smoke-' || encode(gen_random_bytes(4),'hex')) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  update outreach_stages set kind = lower(name) where workspace_id = ws and lower(name) in ('new','contacted','connected','replied','interested','meeting','won','lost');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'Sender A', 'ok', 'smoke-a-' || ws) returning id into sa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'Sender B', 'ok', 'smoke-b-' || ws) returning id into sb;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, parent_sender_id) values (ws, 'GMAIL', 'Mailbox', 'ok', 'smoke-m-' || ws, sa) returning id into mb;
  insert into outreach_leads(workspace_id, public_identifier, full_name, email_work) values (ws, 'smoke-l1', 'Lead One', 'l1@smoke.test') returning id into l1;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'smoke-l2', 'Lead Two') returning id into l2;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'smoke-l3', 'Lead Three') returning id into l3;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'smoke-l4', 'Lead Four') returning id into l4;
  insert into outreach_leads(workspace_id, public_identifier, full_name) values (ws, 'smoke-l5', 'Lead Five') returning id into l5;

  insert into outreach_sequences(workspace_id, name, status, graph, sender_pool) values (ws, 'seq lead-scope', 'active', g, array[sa, mb]) returning id into seq;
  insert into outreach_sequences(workspace_id, name, status, graph, sender_pool) values (ws, 'seq other sender', 'active', g, array[sb]) returning id into seq2;
  insert into outreach_sequences(workspace_id, name, status, graph, sender_pool, settings) values (ws, 'seq sender-scope', 'active', g, array[sa], '{"stop_on_reply":true,"stop_on_reply_scope":"sender"}') returning id into seq3;
  insert into outreach_sequences(workspace_id, name, status, graph, sender_pool, settings) values (ws, 'seq hold', 'active', g, array[sa], '{"stop_on_reply":true,"on_reply":"hold"}') returning id into seq4;

  -- ---------------------------------------------------------------- A. email reply exits the LinkedIn enrollment; reply to A cancels B's queue
  perform outreach_enroll_leads(seq, array[l1], sa);
  perform outreach_enroll_leads(seq2, array[l1], sb);
  select id into e from outreach_enrollments where sequence_id = seq and lead_id = l1;
  select id into e2 from outreach_enrollments where sequence_id = seq2 and lead_id = l1;
  perform outreach_queue_action(e, 'm1', 'message', now() + interval '1 hour', '{"text":"hi"}');
  perform outreach_queue_action(e2, 'm1', 'message', now() + interval '1 hour', '{"text":"hi"}');
  insert into outreach_actions(workspace_id, enrollment_id, sender_id, lead_id, node_id, action_type, scheduled_for, idempotency_key, payload)
    values (ws, e, mb, l1, 'em1', 'email', now() + interval '2 hours', 'smoke-' || gen_random_uuid(), '{"via_mailbox":true}');
  insert into outreach_lead_sender_state(lead_id, sender_id) values (l1, mb) on conflict do nothing;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l1 and sender_id = mb;   -- the email reply

  select status::text into st from outreach_enrollments where id = e;
  if st = 'exited_replied' then log := log || E'\nok   A1 email reply exited the LinkedIn enrollment'; else fails := fails + 1; log := log || E'\nFAIL A1 LinkedIn enrollment status=' || st; end if;
  select status::text into st from outreach_enrollments where id = e2;
  if st = 'exited_replied' then log := log || E'\nok   A2 enrollment on sender B (other sequence) exited too'; else fails := fails + 1; log := log || E'\nFAIL A2 sender B enrollment status=' || st; end if;
  select count(*) into n from outreach_actions where lead_id = l1 and status in ('queued','reserved');
  if n = 0 then log := log || E'\nok   A3 every queued action for the lead is cancelled on all senders'; else fails := fails + 1; log := log || E'\nFAIL A3 still queued: ' || n; end if;
  select last_replied_channel into st from outreach_leads where id = l1;
  if st = 'email' then log := log || E'\nok   A4 lead.last_replied_at / channel stamped (email)'; else fails := fails + 1; log := log || E'\nFAIL A4 channel=' || coalesce(st,'null'); end if;

  -- ---------------------------------------------------------------- B. send_always still sends
  g_always := jsonb_set(g, '{nodes,m1,config,send_always}', 'true');
  update outreach_sequences set graph = g_always where id = seq2;
  perform outreach_enroll_leads(seq2, array[l2], sb);
  select id into e from outreach_enrollments where sequence_id = seq2 and lead_id = l2;
  perform outreach_queue_action(e, 'm1', 'message', now() + interval '1 hour', '{"text":"hi"}');
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l2 and sender_id = sb;
  select status::text into st from outreach_enrollments where id = e;
  select count(*) into n from outreach_actions where enrollment_id = e and status = 'queued';
  if st = 'active' and n = 1 then log := log || E'\nok   B  send_always step stays live and keeps its queued action'; else fails := fails + 1; log := log || E'\nFAIL B  status=' || st || ' queued=' || n; end if;

  -- ---------------------------------------------------------------- C. scope "sender" behaves exactly as before
  perform outreach_enroll_leads(seq3, array[l3], sa);
  select id into e from outreach_enrollments where sequence_id = seq3 and lead_id = l3;
  insert into outreach_lead_sender_state(lead_id, sender_id) values (l3, sb) on conflict do nothing;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l3 and sender_id = sb;
  select status::text into st from outreach_enrollments where id = e;
  if st = 'active' then log := log || E'\nok   C1 scope=sender: a reply to another sender does not exit'; else fails := fails + 1; log := log || E'\nFAIL C1 status=' || st; end if;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() + interval '1 second' where lead_id = l3 and sender_id = sa;
  select status::text into st from outreach_enrollments where id = e;
  if st = 'exited_replied' then log := log || E'\nok   C2 scope=sender: a reply to the same sender exits'; else fails := fails + 1; log := log || E'\nFAIL C2 status=' || st; end if;

  -- ---------------------------------------------------------------- D. an out-of-office reply resumes after the delay
  perform outreach_enroll_leads(seq, array[l4], sa);
  select id into e from outreach_enrollments where sequence_id = seq and lead_id = l4;
  ts := date_trunc('milliseconds', now() + interval '2 seconds');   -- webhook timestamps have ms precision
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider) values (ws, sa, l4, 'smoke-chat-' || l4, 'LINKEDIN') returning id into chat;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, chat, 'in', 'I am out of office until next week', ts) returning id into msg;
  update outreach_lead_sender_state set replied = true, last_inbound_at = ts where lead_id = l4 and sender_id = sa;
  select status::text into st from outreach_enrollments where id = e;
  if st <> 'exited_replied' then fails := fails + 1; log := log || E'\nFAIL D0 expected exit before classification, got ' || st; end if;
  j := outreach_apply_reply_intent(msg, 'ooo', null);
  select status::text, wait_until into st, ts from outreach_enrollments where id = e;
  if st = 'waiting_delay' and ts > now() + interval '6 days' and ts < now() + interval '8 days' and (j->>'resumed')::int = 1
    then log := log || E'\nok   D1 OOO re-opened the enrollment, resumes in ~7 days';
    else fails := fails + 1; log := log || E'\nFAIL D1 status=' || st || ' wait_until=' || coalesce(ts::text,'null') || ' result=' || j::text; end if;
  b := outreach_enrollment_reply_blocked(e);
  if not b then log := log || E'\nok   D2 the resumed enrollment is not blocked by the OOO reply'; else fails := fails + 1; log := log || E'\nFAIL D2 still reply-blocked'; end if;

  -- ---------------------------------------------------------------- E. hold-for-review mode
  perform outreach_enroll_leads(seq4, array[l5], sa);
  select id into e from outreach_enrollments where sequence_id = seq4 and lead_id = l5;
  update outreach_lead_sender_state set replied = true, last_inbound_at = now() where lead_id = l5 and sender_id = sa;
  select status::text into st from outreach_enrollments where id = e;
  select count(*) into n from outreach_tasks where enrollment_id = e and kind = 'reply_hold' and completed_at is null;
  if st = 'paused' and n = 1 then log := log || E'\nok   E1 hold mode: lead held with a review task'; else fails := fails + 1; log := log || E'\nFAIL E1 status=' || st || ' tasks=' || n; end if;
  perform outreach_resume_enrollment(e);
  select status::text into st from outreach_enrollments where id = e;
  select count(*) into n from outreach_tasks where enrollment_id = e and kind = 'reply_hold' and completed_at is null;
  if st = 'active' and n = 0 and not outreach_enrollment_reply_blocked(e) then log := log || E'\nok   E2 one click resumes, closes the task, and the old reply no longer blocks';
    else fails := fails + 1; log := log || E'\nFAIL E2 status=' || st || ' open tasks=' || n; end if;

  -- ---------------------------------------------------------------- F. enrol guard: replied in the last 90 days
  j := outreach_enroll_preview(seq3, array[l1, l2], null, false);
  if (j->'excluded'->'replied_recently'->>'count')::int = 2 and (j->>'eligible')::int = 0 then log := log || E'\nok   F1 preview lists recently-replied leads and excludes them';
    else fails := fails + 1; log := log || E'\nFAIL F1 ' || j::text; end if;
  j := outreach_enroll_preview(seq3, array[l1], null, true);
  if (j->>'eligible')::int = 1 then log := log || E'\nok   F2 "include" makes them eligible'; else fails := fails + 1; log := log || E'\nFAIL F2 ' || j::text; end if;
  perform outreach_enroll_leads(seq3, array[l1], null, 100, true);
  select id into e from outreach_enrollments where sequence_id = seq3 and lead_id = l1 and status = 'active';
  if e is not null and not outreach_enrollment_reply_blocked(e) then log := log || E'\nok   F3 a deliberate re-enrol is not blocked by the earlier reply';
    else fails := fails + 1; log := log || E'\nFAIL F3 re-enrolled lead blocked or missing'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (item 1: reply stop)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
