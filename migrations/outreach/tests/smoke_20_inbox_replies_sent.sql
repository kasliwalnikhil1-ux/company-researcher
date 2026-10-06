-- Smoke test — 075 Replies / Sent in the inbox (inbox-replies-sent-PRD.md §10). Builds fixtures, asserts, then RAISES so
-- everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_20_inbox_replies_sent.sql
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; b boolean; r record;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid; s1 uuid; s2 uuid; sm uuid; swc uuid; wci uuid;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; l6 uuid; q1 uuid; e1 uuid; e2 uuid; e3 uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; cm uuid; cwc uuid; cb1 uuid;
  m1 uuid; m2 uuid; m3 uuid; m4 uuid; m5 uuid; mx uuid; mem uuid; mb uuid;
  a_inv1 uuid; a_inv2 uuid; a_q uuid; a_f uuid; a_f2 uuid; a_msg uuid; run1 uuid;
  unread_before int; ids text[]; seen text[] := '{}'; cur jsonb; pages int := 0;
  t0 timestamptz := now() - interval '3 days';
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke20', 'smoke20-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner20@test.local', 'Naman');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member20@test.local', 'Ravi', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer20@test.local', 'Karin', array[ca]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email, created_at)
    values (ws, ca, 'LINKEDIN', 'Naman LI', 'ok', 's20a-' || ws, 'owner20@test.local', now() - interval '30 days') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email, created_at)
    values (ws, cb, 'LINKEDIN', 'Ravi LI', 'ok', 's20b-' || ws, 'member20@test.local', now() - interval '30 days') returning id into s2;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email, public_identifier, created_at)
    values (ws, ca, 'GMAIL', 'Naman mail', 'ok', 's20m-' || ws, 'owner20@test.local', 'naman@studio.test', now() - interval '30 days') returning id into sm;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, owner_email, created_at)
    values (ws, ca, 'WEBCHAT', 'Site', 'ok', 'owner20@test.local', now() - interval '30 days') returning id into swc;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'priya20-' || left(ws::text, 8), 'Priya Nair', 'Razorpay') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'rahul20-' || left(ws::text, 8), 'Rahul Mehta', 'Loomcraft') returning id into l2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'asha20-' || left(ws::text, 8), 'Asha Rao', 'Kite') returning id into l3;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company, email_work) values (ws, ca, 'karin20-' || left(ws::text, 8), 'Karin Elwin', 'J.Lindeberg', 'karin20@lindeberg.test') returning id into l4;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, cb, 'ben20-' || left(ws::text, 8), 'Ben Roe', 'Acme') returning id into l5;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'omar20-' || left(ws::text, 8), 'Omar Haddad', 'Dune') returning id into l6;
  insert into outreach_sequences(workspace_id, client_id, name, status, sender_pool, created_by,
      graph) values (ws, ca, 'Fintech CFOs', 'active', array[s1], u_owner,
      '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect","next":"n2"},"n2":{"id":"n2","type":"send_message","label":"Follow-up","config":{"variants":[{"id":"b","label":"B"}]}}}}'::jsonb) returning id into q1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id) values (ws, q1, 1, l1, s1, 'active', 'n2') returning id into e1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id) values (ws, q1, 1, l3, s1, 'active', 'n2') returning id into e2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id, exit_reason) values (ws, q1, 1, l6, s1, 'failed', 'n2', 'E_RELATION_REQUIRED') returning id into e3;
  select count(*) into unread_before from outreach_chats c where c.workspace_id = ws and c.unread and not c.archived;

  -- ============================================================ 1. only our messages → not in Replies; the first reply moves it in
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload, variant_id)
    values (ws, s1, l1, e1, 'n2', 'message', t0, 'sent', t0, 'smoke20-msg-' || ws, '{"text":"Thanks for connecting, Priya. Quick question"}', 'b') returning id into a_msg;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name)
    values (ws, ca, s1, l1, 'c20-1-' || ws, 'LINKEDIN', 'Priya Nair') returning id into c1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id)
    values (ws, c1, 'm20-1-' || ws, 'out', 'Thanks for connecting, Priya. Quick question', t0, a_msg) returning id into m1;
  if (select first_inbound_at is null and waiting_on is null and first_outbound_at = t0 and last_outbound_at = t0 from outreach_chats where id = c1)
    then log := log || E'\nok   only our message: first_inbound_at null (not in Replies), waiting_on null, outbound stamped';
    else fails := fails + 1; log := log || E'\nFAIL only-ours chat: ' || (select row(first_inbound_at, waiting_on, first_outbound_at)::text from outreach_chats where id = c1); end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm20-2-' || ws, 'in', 'Sure, what is it about?', t0 + interval '2 hours') returning id into m2;
  if (select first_inbound_at = t0 + interval '2 hours' and last_inbound_at = t0 + interval '2 hours' and waiting_on = 'us' from outreach_chats where id = c1)
     and (select replied_at = t0 + interval '2 hours' from outreach_messages where id = m1)
    then log := log || E'\nok   first reply: chat enters Replies (first_inbound_at), waiting_on us, our message replied_at set';
    else fails := fails + 1; log := log || E'\nFAIL first reply: ' || (select row(first_inbound_at, waiting_on)::text from outreach_chats where id = c1) || ' / ' || coalesce((select replied_at::text from outreach_messages where id = m1), 'null'); end if;

  -- ============================================================ 2. auto-replies: tagged, never Needs reply, never mark a send replied
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name)
    values (ws, ca, s1, l3, 'c20-3-' || ws, 'LINKEDIN', 'Asha Rao') returning id into c3;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c3, 'm20-3-' || ws, 'out', 'Hi Asha', t0) returning id into m3;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, intent)
    values (ws, c3, 'm20-4-' || ws, 'in', 'I am out of office until Monday', t0 + interval '1 hour', 'ooo') returning id into m4;
  if (select first_inbound_at is not null and last_inbound_at is null and waiting_on is null and last_auto_reply_at = t0 + interval '1 hour' from outreach_chats where id = c3)
     and (select is_auto_reply from outreach_messages where id = m4)
     and (select replied_at is null from outreach_messages where id = m3)
    then log := log || E'\nok   out-of-office: in Replies (first_inbound_at), not Needs reply (waiting_on null), Auto-reply tag time, send not replied';
    else fails := fails + 1; log := log || E'\nFAIL auto-reply: ' || (select row(first_inbound_at, last_inbound_at, waiting_on, last_auto_reply_at)::text from outreach_chats where id = c3); end if;

  -- ============================================================ 3. reclassification: a person's reply later marked ooo
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c3, 'm20-5-' || ws, 'in', 'Thanks, back on the 14th, will read then', t0 + interval '5 hours') returning id into m5;
  b := (select waiting_on = 'us' from outreach_chats where id = c3) and (select replied_at is not null from outreach_messages where id = m3);
  update outreach_messages set intent = 'ooo' where id = m5;
  if b and (select is_auto_reply from outreach_messages where id = m5)
     and (select last_inbound_at is null and waiting_on is null and last_auto_reply_at = t0 + interval '5 hours' from outreach_chats where id = c3)
     and (select replied_at is null from outreach_messages where id = m3)
    then log := log || E'\nok   reclassified as out-of-office: recompute clears last_inbound_at, waiting_on and replied_at';
    else fails := fails + 1; log := log || E'\nFAIL reclassification: before=' || b || ' ' || (select row(last_inbound_at, waiting_on)::text from outreach_chats where id = c3); end if;
  update outreach_messages set intent = 'interested' where id = m5;
  if (select not is_auto_reply from outreach_messages where id = m5) and (select waiting_on = 'us' from outreach_chats where id = c3)
    then log := log || E'\nok   a teammate correcting the intent away from ooo makes it a person''s reply again';
    else fails := fails + 1; log := log || E'\nFAIL intent correction'; end if;

  -- ============================================================ 4. out of order + delete
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name)
    values (ws, ca, s1, l2, 'c20-2-' || ws, 'LINKEDIN', 'Rahul Mehta') returning id into c2;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm20-6-' || ws, 'out', 'Follow-up', t0 + interval '3 hours');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm20-7-' || ws, 'in', 'Late arrival', t0 + interval '1 hour') returning id into mx;
  if (select waiting_on = 'them' and last_inbound_at = t0 + interval '1 hour' and last_outbound_at = t0 + interval '3 hours' from outreach_chats where id = c2)
    then log := log || E'\nok   out-of-order arrival: an older reply never flips waiting_on (least / greatest)';
    else fails := fails + 1; log := log || E'\nFAIL out of order: ' || (select row(waiting_on, last_inbound_at, last_outbound_at)::text from outreach_chats where id = c2); end if;
  delete from outreach_messages where id = mx;
  if (select first_inbound_at is null and last_inbound_at is null and waiting_on is null from outreach_chats where id = c2)
    then log := log || E'\nok   delete: recompute removes the chat from Replies again';
    else fails := fails + 1; log := log || E'\nFAIL delete recompute: ' || (select row(first_inbound_at, waiting_on)::text from outreach_chats where id = c2); end if;

  -- ============================================================ 5. every send type appears in Sent exactly once
  -- invite without note (Rahul), invite with note accepted (Omar), phone reply (external_device), inbox reply, AI reply, email
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload)
    values (ws, s1, l2, null, null, 'invite', t0 - interval '1 day', 'sent', t0 - interval '1 day', 'smoke20-inv1-' || ws, '{}') returning id into a_inv1;
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload, response)
    values (ws, s1, l6, e3, 'n1', 'invite', t0 - interval '1 day', 'sent', t0 - interval '1 day', 'smoke20-inv2-' || ws, '{"note":"Hi Omar, saw your post"}', '{"note_length":22}') returning id into a_inv2;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l6, s1, 'first', t0 - interval '1 day', t0)
    on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = t0;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name)
    values (ws, ca, s1, l6, 'c20-6-' || ws, 'LINKEDIN', 'Omar Haddad') returning id into c4;
  -- the accepted note arrives through the webhook without an action: the stamp trigger links it to the invite
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c4, 'm20-8-' || ws, 'out', 'Hi Omar, saw your post', t0 - interval '1 day');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin) values (ws, c2, 'm20-9-' || ws, 'out', 'Sent from my phone', t0 + interval '4 hours', 'external_device');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin, sent_by) values (ws, c2, 'm20-10-' || ws, 'out', 'Typed in the inbox', t0 + interval '6 hours', 'inbox_user', u_owner);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin) values (ws, c2, 'm20-11-' || ws, 'out', 'AI answered', t0 + interval '7 hours', 'ai_autopilot');
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name, attendee_provider_id)
    values (ws, ca, sm, l4, 'c20-m-' || ws, 'GMAIL', 'Karin Elwin', 'karin20@lindeberg.test') returning id into cm;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin, sent_by, content_attributes)
    values (ws, cm, 'm20-12-' || ws, 'out', 'Product films for AW26', t0 + interval '8 hours', 'inbox_user', u_owner, '{"email":{"subject":"Re: product films for AW26"}}') returning id into mem;
  -- website chat + a private note: never in Sent
  insert into outreach_webchat_inboxes(workspace_id, sender_id, name, website_token, hmac_token) values (ws, swc, 'Site', 'wt20-' || ws, 'hm20-' || ws) returning id into wci;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, webchat_inbox_id)
    values (ws, ca, swc, 'c20-wc-' || ws, 'WEBCHAT', 'Visitor', wci) returning id into cwc;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, sender_type, origin) values (ws, cwc, 'out', 'Hi! How can I help?', t0 + interval '9 hours', 'bot', 'ai_autopilot');
  insert into outreach_chat_notes(workspace_id, chat_id, lead_id, client_id, author_id, author_type, body) values (ws, c1, l1, ca, u_owner, 'user', 'internal note');

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('from', t0 - interval '3 days', 'to', now()), null, 100);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select array_agg(x ->> 'id') into ids from jsonb_array_elements(j -> 'items') x;
  if (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_inv1::text and x ->> 'type' = 'connection_request' and x ->> 'status' = 'sent') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_inv2::text and x ->> 'status' = 'accepted' and x ->> 'preview' = 'Hi Omar, saw your post') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'chat_id' = c4::text) = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = m1::text and x ->> 'status' = 'replied' and x ->> 'source' = 'sequence'
            and x -> 'step' ->> 'number' = '2' and x -> 'step' ->> 'label' = 'Follow-up' and x -> 'step' ->> 'variant_label' = 'B' and x -> 'sequence' ->> 'name' = 'Fintech CFOs') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'preview' = 'Sent from my phone' and x ->> 'source' = 'outside_app') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'preview' = 'Typed in the inbox' and x ->> 'source' = 'teammate' and x -> 'sent_by' ->> 'name' = 'Naman') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'preview' = 'AI answered' and x ->> 'source' = 'ai') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = mem::text and x ->> 'type' = 'email' and x ->> 'channel' = 'EMAIL' and x ->> 'subject' = 'Re: product films for AW26') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'chat_id' = cwc::text) = 0
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'preview' = 'internal note') = 0
     and (select count(distinct v) from unnest(ids) v) = array_length(ids, 1)
    then log := log || E'\nok   Sent: request without note, accepted request with note (listed once), step message (Replied, step 2 · B), phone, inbox, AI, email — once each; no web chat, no notes';
    else fails := fails + 1; log := log || E'\nFAIL Sent rows: ' || left((j -> 'items')::text, 1500); end if;

  -- ============================================================ 6. bounce: Failed as Bounced, nothing in Replies
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l4, sm, t0 + interval '8 hours') on conflict (lead_id, sender_id) do nothing;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, content_attributes)
    values (ws, cm, 'm20-13-' || ws, 'in', 'Delivery to karin20@lindeberg.test failed', t0 + interval '8 hours 5 minutes',
            '{"email":{"from":{"email":"mailer-daemon@googlemail.com"},"subject":"Delivery Status Notification (Failure)"}}') returning id into mb;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'failed', '{}'::jsonb, null, 50);
  k := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('channel', 'EMAIL', 'from', t0 - interval '1 day', 'to', now()), null, 50);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select is_bounce from outreach_messages where id = mb) and (select bounced_at is not null from outreach_messages where id = mem)
     and (select first_inbound_at is null from outreach_chats where id = cm)
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = mem::text and x ->> 'status' = 'bounced') = 1
     and jsonb_array_length(k -> 'items') = 0
     and (select email_bounced from outreach_lead_sender_state where lead_id = l4 and sender_id = sm)
    then log := log || E'\nok   bounce: email moves to Failed as Bounced, the thread stays out of Replies, the lead is marked bounced';
    else fails := fails + 1; log := log || E'\nFAIL bounce: ' || left(j::text, 400) || ' / sent=' || left(k::text, 200); end if;

  -- ============================================================ 7. Scheduled: queued step, held when the sender is disconnected, AI hold; leaves on cancel
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key, payload)
    values (ws, s1, l3, e2, 'n2', 'message', now() + interval '2 hours', 'queued', 'smoke20-q-' || ws, '{"text":"Step 2 for Asha"}') returning id into a_q;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, provider, inbound_message_ids, debounce_until, debounce_hard_until, status, draft_text, scheduled_send_at, mode)
    values (ws, ca, c1, s1, l1, q1, 'LINKEDIN', array[m2], now(), now(), 'scheduled', 'Happy to explain: we make product films', now() + interval '9 minutes', 'autopilot') returning id into run1;
  update outreach_chats set ai_run_id = run1, ai_run_status = 'scheduled', ai_scheduled_send_at = now() + interval '9 minutes' where id = c1;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'scheduled', '{}'::jsonb, null, 50);
  k := outreach_inbox_counts(ws, '{}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_q::text and x ->> 'status' = 'scheduled' and x ->> 'body' = 'Step 2 for Asha') = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = run1::text and x ->> 'source' = 'ai' and x ->> 'src' = 'ai_hold') = 1
     and j -> 'items' -> 0 ->> 'id' = run1::text
     and (select ai_answering from outreach_chats where id = c1)
    then log := log || E'\nok   Scheduled: queued step + AI reply in its hold, soonest first; the chat is ai_answering';
    else fails := fails + 1; log := log || E'\nFAIL scheduled: ' || left(j::text, 600); end if;
  -- Needs reply = waiting on us, open, AI not answering: c3 (Asha) yes; c1 (Priya) no while the AI holds a reply
  if (k ->> 'needs_reply')::int = 1 and (k ->> 'scheduled')::int = 2
    then log := log || E'\nok   counts: needs_reply leaves out the conversation the AI is answering; scheduled = 2';
    else fails := fails + 1; log := log || E'\nFAIL counts: ' || k::text; end if;
  update outreach_chats set ai_run_status = 'escalated' where id = c1;
  if not (select ai_answering from outreach_chats where id = c1)
    then log := log || E'\nok   escalated run → conversation goes back to Needs reply';
    else fails := fails + 1; log := log || E'\nFAIL escalation still ai_answering'; end if;
  update outreach_senders set status = 'credentials' where id = s1;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'scheduled', '{}'::jsonb, null, 50);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_q::text and x ->> 'status' = 'held' and x ->> 'status_reason' = 'sender_reconnect' and coalesce(x ->> 'status_text', '') <> '') = 1
    then log := log || E'\nok   held: disconnected sender → Held · ' || (select x ->> 'status_text' from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_q::text);
    else fails := fails + 1; log := log || E'\nFAIL held: ' || left(j::text, 500); end if;
  update outreach_senders set status = 'ok' where id = s1;
  update outreach_actions set status = 'cancelled' where id = a_q;
  if not exists (select 1 from outreach_sent_items where id = a_q)
    then log := log || E'\nok   a cancelled step leaves Scheduled';
    else fails := fails + 1; log := log || E'\nFAIL cancelled still listed'; end if;

  -- ============================================================ 8. Failed: failed step with reason; retried attempts drop out
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload, error_code)
    values (ws, s1, l6, e3, 'n2', 'message', now() - interval '1 hour', 'failed', now() - interval '1 hour', 'smoke20-f-' || ws, '{"text":"Step 2 for Omar"}', 'E_RELATION_REQUIRED') returning id into a_f;
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, payload, error_code, created_at)
    values (ws, s1, l3, e2, 'n2', 'message', now() - interval '2 hours', 'failed', now() - interval '2 hours', 'smoke20-f2-' || ws, '{"text":"old attempt"}', '5xx:timeout', now() - interval '2 hours') returning id into a_f2;
  insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, idempotency_key, payload)
    values (ws, s1, l3, e2, 'n2', 'message', now() + interval '1 day', 'queued', 'smoke20-f2b-' || ws, '{"text":"retry"}');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'failed', '{}'::jsonb, null, 50);
  k := outreach_inbox_counts(ws, '{}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_f::text and x ->> 'status_text' = 'Not connected yet, so a message could not be sent' and (x ->> 'recoverable')::boolean) = 1
     and (select count(*) from jsonb_array_elements(j -> 'items') x where x ->> 'id' = a_f2::text) = 0
     and (k ->> 'failed')::int = 2
    then log := log || E'\nok   Failed: reason text + recoverable; a retried attempt is not listed; failed count = 2 (step + bounce)';
    else fails := fails + 1; log := log || E'\nFAIL failed: ' || left(j::text, 600) || ' counts=' || k::text; end if;

  -- ============================================================ 9. access: member scoped to client B, client viewer + the setting
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name)
    values (ws, cb, s2, l5, 'c20-b-' || ws, 'LINKEDIN', 'Ben Roe') returning id into cb1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, cb1, 'm20-b-' || ws, 'out', 'Hello Ben', t0 + interval '1 hour');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('from', t0 - interval '3 days', 'to', now()), null, 100);
  select count(*) into n from outreach_sent_items where workspace_id = ws;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j -> 'items') = 1 and j -> 'items' -> 0 ->> 'preview' = 'Hello Ben' and n = 1
    then log := log || E'\nok   member (client B): one row via the RPC and via the view (row security), nothing from client A';
    else fails := fails + 1; log := log || E'\nFAIL member scope: rpc=' || jsonb_array_length(j -> 'items') || ' view=' || n; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  j := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('from', t0 - interval '3 days', 'to', now()), null, 100);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_workspaces set settings = coalesce(settings, '{}'::jsonb) || '{"inbox_show_sent_to_clients": false}' where id = ws;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  begin k := outreach_inbox_sent_list(ws, 'sent', '{}'::jsonb, null, 10); t := 'listed'; exception when others then t := sqlerrm; end;
  k := outreach_inbox_counts(ws, '{}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from jsonb_array_elements(j -> 'items') x where x ->> 'preview' = 'Hello Ben') and jsonb_array_length(j -> 'items') > 0
     and t like 'E_FORBIDDEN%' and (k ->> 'scheduled')::int = 0 and (k ->> 'show_sent')::boolean = false
    then log := log || E'\nok   client viewer: client A only; with "Show Sent to clients" off the list is E_FORBIDDEN and counts hide it';
    else fails := fails + 1; log := log || E'\nFAIL viewer: ' || t || ' ' || k::text; end if;

  -- ============================================================ 10. paging: no missing or duplicated rows while new sends arrive
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  cur := null;
  loop
    j := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('from', t0 - interval '3 days', 'to', now() + interval '1 hour'), cur, 2);
    pages := pages + 1;
    seen := seen || array(select x ->> 'id' from jsonb_array_elements(j -> 'items') x);
    if pages = 1 then
      execute 'reset role';
      insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm20-new-' || ws, 'out', 'arrives mid-paging', now());
      execute 'set local role authenticated';
    end if;
    cur := j -> 'next_cursor';
    exit when cur is null or jsonb_typeof(cur) = 'null' or pages > 30;
  end loop;
  select count(*) into n from outreach_sent_items v where v.workspace_id = ws and v.segment = 'sent' and v.at >= t0 - interval '3 days' and v.at < now() - interval '1 second';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(distinct v) from unnest(seen) v) = array_length(seen, 1) and array_length(seen, 1) = n and pages > 2
    then log := log || E'\nok   paging (limit 2, ' || pages || ' pages): ' || n || ' rows, none missing or twice; the new send waits at the top';
    else fails := fails + 1; log := log || E'\nFAIL paging: seen=' || coalesce(array_length(seen, 1), 0) || ' distinct=' || (select count(distinct v) from unnest(seen) v) || ' expected=' || n; end if;

  -- ============================================================ 11. unread untouched, browser cannot write the bookkeeping, range cap
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  k := outreach_inbox_counts(ws, '{}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (k ->> 'replies_unread')::int = (select count(*)::int from outreach_chats c where c.workspace_id = ws and c.unread and not c.archived) and unread_before = 0
    then log := log || E'\nok   replies_unread counts exactly as the sidebar badge (unread, not archived): ' || (k ->> 'replies_unread');
    else fails := fails + 1; log := log || E'\nFAIL unread'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  update outreach_chats set first_inbound_at = null, last_inbound_at = null, unread = false where id = c1;
  begin k := outreach_inbox_sent_list(ws, 'sent', jsonb_build_object('from', now() - interval '120 days', 'to', now()), null, 10); t := 'listed'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select first_inbound_at is not null and last_inbound_at is not null and not unread from outreach_chats where id = c1) and t like 'E_PAYLOAD_INVALID%90 days%'
    then log := log || E'\nok   a direct browser update keeps the bookkeeping columns (unread still changes); ranges over 90 days are refused';
    else fails := fails + 1; log := log || E'\nFAIL guard/range: ' || t; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
