-- Smoke test — 089 sequence stats (sequence-stats-PRD.md §9 edge cases + §11 tests). Builds fixtures, asserts, then
-- RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_25_sequence_stats.sql
do $$
declare
  log text := ''; fails int := 0; n int; j jsonb; rows_ jsonb; ra jsonb; rb jsonb; re jsonb; rw jsonb; ri jsonb; rd jsonb; det jsonb; blk jsonb; r record;
  ws uuid; u_owner uuid; s_li uuid; s_li2 uuid; s_ig uuid; s_wa uuid; s_mail uuid;
  l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid; l6 uuid; l7 uuid; l8 uuid; l9 uuid; l10 uuid; l11 uuid; l12 uuid; l13 uuid; l14 uuid; l15 uuid; l16 uuid; l17 uuid; l18 uuid;
  qa uuid; qb uuid; qe uuid; qw uuid; qi uuid; qd uuid;
  ea1 uuid; ea2 uuid; ea3 uuid; ea4 uuid; ea5 uuid; ea6 uuid; ea7 uuid; ea8 uuid; ea9 uuid; ea10 uuid; ea17 uuid; ea17b uuid; ea18 uuid;
  eb8 uuid; eb16 uuid; ee11 uuid; ee12 uuid; ew13 uuid; ew14 uuid; ei15 uuid;
  a uuid; c uuid; m uuid; m_l1_in uuid; m_l5_ooo uuid; m_l5_in uuid; m_l12_out uuid;
  t0 timestamptz := now() - interval '40 days'; d0 date;
  seq int := 0;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;
  d0 := (t0 at time zone 'UTC')::date;

  -- ============================================================ fixtures
  insert into outreach_workspaces(name, slug, created_by) values ('smoke25', 'smoke25-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner25@test.local', 'Naman');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at) values (ws, 'LINKEDIN', 'Naman LI', 'ok', 's25a-' || ws, 'owner25@test.local', t0 - interval '10 days') returning id into s_li;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at) values (ws, 'LINKEDIN', 'Ravi LI', 'ok', 's25b-' || ws, 'owner25@test.local', t0 - interval '10 days') returning id into s_li2;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, created_at) values (ws, 'INSTAGRAM', 'Studio IG', 'ok', 's25i-' || ws, 'owner25@test.local', t0 - interval '10 days') returning id into s_ig;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, public_identifier, created_at) values (ws, 'WHATSAPP', 'Studio WA', 'ok', 's25w-' || ws, 'owner25@test.local', '+919999900000', t0 - interval '10 days') returning id into s_wa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email, public_identifier, created_at) values (ws, 'GMAIL', 'Naman mail', 'ok', 's25m-' || ws, 'owner25@test.local', 'naman25@studio.test', t0 - interval '10 days') returning id into s_mail;

  l1 := gen_random_uuid(); l2 := gen_random_uuid(); l3 := gen_random_uuid(); l4 := gen_random_uuid(); l5 := gen_random_uuid(); l6 := gen_random_uuid();
  l7 := gen_random_uuid(); l8 := gen_random_uuid(); l9 := gen_random_uuid(); l10 := gen_random_uuid(); l11 := gen_random_uuid(); l12 := gen_random_uuid();
  l13 := gen_random_uuid(); l14 := gen_random_uuid(); l15 := gen_random_uuid(); l16 := gen_random_uuid(); l17 := gen_random_uuid(); l18 := gen_random_uuid();
  insert into outreach_leads(id, workspace_id, public_identifier, full_name) select x.id, ws, 'l25-' || x.i || '-' || left(ws::text, 8), 'Lead ' || x.i
    from (values (l1,1),(l2,2),(l3,3),(l4,4),(l5,5),(l6,6),(l7,7),(l8,8),(l9,9),(l10,10),(l11,11),(l13,13),(l14,14),(l15,15),(l16,16),(l17,17),(l18,18)) x(id, i);
  insert into outreach_leads(id, workspace_id, full_name, email_work) values (l12, ws, 'Lead 12', 'lead12-' || left(ws::text, 8) || '@example.test');

  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'A LinkedIn invite + message', 'active', array[s_li, s_li2], u_owner, t0 - interval '5 days',
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect","next":"n2"},"n2":{"id":"n2","type":"wait_connection","next":"n3"},"n3":{"id":"n3","type":"send_message","label":"Follow-up"}}}'::jsonb) returning id into qa;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'B LinkedIn message only', 'active', array[s_li], u_owner, t0 - interval '5 days',
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_message","label":"Hello"}}}'::jsonb) returning id into qb;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'E Email only', 'active', array[s_mail], u_owner, t0 - interval '5 days',
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_email","label":"Intro email"}}}'::jsonb) returning id into qe;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'W WhatsApp', 'active', array[s_wa], u_owner, t0 - interval '5 days',
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"check_identifier","config":{"channel":"WHATSAPP"},"next":"n2"},"n2":{"id":"n2","type":"send_message","config":{"channel":"WHATSAPP"},"label":"Hi"}}}'::jsonb) returning id into qw;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'I Instagram', 'active', array[s_ig], u_owner, t0 - interval '5 days',
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"follow","config":{"channel":"INSTAGRAM"},"next":"n2"},"n2":{"id":"n2","type":"send_message","config":{"channel":"INSTAGRAM"},"label":"DM"}}}'::jsonb) returning id into qi;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by, created_at, graph) values (ws, 'D Draft', 'draft', array[s_li], u_owner, t0,
    '{"start":"n1","nodes":{"n1":{"id":"n1","type":"send_invite","label":"Connect"}}}'::jsonb) returning id into qd;

  -- enrolments
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values
    (ws, qa, 1, l1, s_li, 'exited_replied', t0 - interval '1 day') returning id into ea1;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l2, s_li, 'waiting_connection', t0 - interval '1 day') returning id into ea2;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l3, s_li, 'completed', t0 - interval '1 day') returning id into ea3;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l4, s_li, 'completed', t0 - interval '1 day') returning id into ea4;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l5, s_li, 'exited_replied', t0 - interval '1 day') returning id into ea5;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l6, s_li, 'active', t0 - interval '1 day') returning id into ea6;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l7, s_li, 'active', t0 - interval '1 day') returning id into ea7;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l8, s_li, 'waiting_connection', t0 - interval '1 day') returning id into ea8;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l9, s_li, 'exited_replied', t0 - interval '1 day') returning id into ea9;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l10, s_li, 'exited_replied', t0 - interval '1 day') returning id into ea10;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l17, s_li, 'cancelled', t0 - interval '1 day') returning id into ea17;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l17, s_li2, 'active', t0) returning id into ea17b;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qa, 1, l18, s_li, 'active', t0 - interval '6 days') returning id into ea18;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qb, 1, l8, s_li, 'exited_replied', t0 + interval '4 days') returning id into eb8;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qb, 1, l16, s_li, 'active', t0 - interval '1 day') returning id into eb16;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qe, 1, l11, s_mail, 'failed', t0 - interval '1 day') returning id into ee11;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qe, 1, l12, s_mail, 'exited_replied', t0 - interval '1 day') returning id into ee12;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qw, 1, l13, s_wa, 'completed', t0 - interval '1 day') returning id into ew13;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qw, 1, l14, s_wa, 'exited_replied', t0 - interval '1 day') returning id into ew14;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, created_at) values (ws, qi, 1, l15, s_ig, 'active', t0 - interval '1 day') returning id into ei15;

  -- ---- a helper to send an action: inserted as reserved, then completed through the real path (status → sent)
  -- (plpgsql has no local functions: the pattern is repeated inline)
  -- l1: invite t0, accepted t0+1d, message t0+2d (read t0+2d+1h), human reply t0+3d classified interested, meeting t0+10d
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l1, ea1, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  update outreach_lead_sender_state set relation = 'first', invite_accepted_at = t0 + interval '1 day' where lead_id = l1 and sender_id = s_li;
  if not found then insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l1, s_li, 'first', t0, t0 + interval '1 day'); end if;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l1, ea1, 'n3', 'message', t0 + interval '2 days', 'sent', t0 + interval '2 days', 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l1, 'c25-l1-' || ws, 'LINKEDIN', 'Lead 1') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l1-out-' || ws, 'out', 'Thanks for connecting', t0 + interval '2 days', a) returning id into m;
  update outreach_messages set read_at = t0 + interval '2 days 1 hour' where id = m;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l1-in-' || ws, 'in', 'Sure, tell me more', t0 + interval '3 days') returning id into m_l1_in;
  update outreach_messages set intent = 'interested', classified_at = now() where id = m_l1_in;
  insert into outreach_lead_milestones(workspace_id, lead_id, kind, at, source) values (ws, l1, 'meeting', t0 + interval '10 days', 'stage');

  -- l2: invite t0, nothing else (pending)
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l2, ea2, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  -- l3: invite t0, withdrawn by us at t0+21d (the withdraw worker: no enrolment on the action)
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l3, ea3, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l3, null, null, 'withdraw', t0 + interval '21 days', 'sent', t0 + interval '21 days', 'smoke25-' || seq || '-' || ws);
  -- l4: invite t0, LinkedIn dropped it (relations poll) at t0+10d
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l4, ea4, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at) values (l4, s_li, 'pending_out', t0) on conflict (lead_id, sender_id) do nothing;
  update outreach_lead_sender_state set relation = 'none', invite_withdrawn_at = t0 + interval '10 days' where lead_id = l4 and sender_id = s_li;
  -- l5: invite, accepted, message, OOO first (t0+3d), human reply later (t0+6d) classified question
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l5, ea5, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l5, s_li, 'first', t0, t0 + interval '1 day') on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = excluded.invite_accepted_at;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l5, ea5, 'n3', 'message', t0 + interval '2 days', 'sent', t0 + interval '2 days', 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l5, 'c25-l5-' || ws, 'LINKEDIN', 'Lead 5') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l5-out-' || ws, 'out', 'Thanks for connecting', t0 + interval '2 days', a);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, intent) values (ws, c, 'm25-l5-ooo-' || ws, 'in', 'I am out of office until the 20th', t0 + interval '3 days', 'ooo') returning id into m_l5_ooo;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l5-in-' || ws, 'in', 'Back now. What does it cost?', t0 + interval '6 days') returning id into m_l5_in;
  update outreach_messages set intent = 'question', classified_at = now() where id = m_l5_in;
  -- l6: invite, accepted, message, only an OOO
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l6, ea6, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l6, s_li, 'first', t0, t0 + interval '1 day') on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = excluded.invite_accepted_at;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l6, ea6, 'n3', 'message', t0 + interval '2 days', 'sent', t0 + interval '2 days', 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l6, 'c25-l6-' || ws, 'LINKEDIN', 'Lead 6') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l6-out-' || ws, 'out', 'Thanks for connecting', t0 + interval '2 days', a);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, intent) values (ws, c, 'm25-l6-ooo-' || ws, 'in', 'Automatic reply: travelling', t0 + interval '3 days', 'ooo');
  -- l7: already connected, message only
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l7, ea7, 'n3', 'message', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  -- l8: in A (invite t0) and B (message t0+5d); reply t0+6d → credited to B
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l8, ea8, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l8, eb8, 'n1', 'message', t0 + interval '5 days', 'sent', t0 + interval '5 days', 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l8, 'c25-l8-' || ws, 'LINKEDIN', 'Lead 8') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l8-out-' || ws, 'out', 'Hello', t0 + interval '5 days', a);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l8-in-' || ws, 'in', 'Hi there', t0 + interval '6 days');
  -- l9: wrote first (t0-1d), invite t0, human reply t0+4d
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l9, 'c25-l9-' || ws, 'LINKEDIN', 'Lead 9') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l9-first-' || ws, 'in', 'Saw your post, nice', t0 - interval '1 day');
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l9, ea9, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l9-in-' || ws, 'in', 'Thanks for the invite, happy to chat', t0 + interval '4 days');
  -- l10: LinkedIn invite t0, replies on WhatsApp t0+4d
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l10, ea10, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_wa, l10, 'c25-l10-' || ws, 'WHATSAPP', 'Lead 10') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l10-in-' || ws, 'in', 'Hey, got your request on LinkedIn, easier here', t0 + interval '4 days');
  -- l17: re-enrolled with another sender; first invite pending, second accepted
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l17, ea17, 'n1', 'invite', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li2, l17, ea17b, 'n1', 'invite', t0 + interval '1 day', 'sent', t0 + interval '1 day', 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l17, s_li2, 'first', t0 + interval '1 day', t0 + interval '2 days') on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = excluded.invite_accepted_at;
  -- l18: the cohort case: invited 5 days before t0, accepted 2 days before t0
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l18, ea18, 'n1', 'invite', t0 - interval '5 days', 'sent', t0 - interval '5 days', 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l18, s_li, 'first', t0 - interval '5 days', t0 - interval '2 days') on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = excluded.invite_accepted_at;
  -- l16 in B: message t0, no reply, meeting booked t0+5d
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li, l16, eb16, 'n1', 'message', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_milestones(workspace_id, lead_id, kind, at, source) values (ws, l16, 'meeting', t0 + interval '5 days', 'booking');
  -- E: l11 email bounced; l12 email + human reply
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_mail, l11, ee11, 'n1', 'email', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_mail, l11, 'c25-l11-' || ws, 'GMAIL', 'Lead 11') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l11-out-' || ws, 'out', 'Intro', t0, a) returning id into m;
  update outreach_messages set bounced_at = t0 + interval '10 minutes' where id = m;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_mail, l12, ee12, 'n1', 'email', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_mail, l12, 'c25-l12-' || ws, 'GMAIL', 'Lead 12') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l12-out-' || ws, 'out', 'Intro', t0, a) returning id into m_l12_out;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l12-in-' || ws, 'in', 'Thanks, interested', t0 + interval '1 day');
  -- W: l13 number check failed (never messaged); l14 new chat, read, reply
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key, error_code, decision) values (ws, s_wa, l13, ew13, 'n1', 'identifier_check', t0, 'skipped', t0, 'smoke25-' || seq || '-' || ws, 'E_IDENTIFIER_INVALID', 'branch:invalid');
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_wa, l14, ew14, 'n2', 'new_chat', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws) returning id into a;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_wa, l14, 'c25-l14-' || ws, 'WHATSAPP', 'Lead 14') returning id into c;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, action_id) values (ws, c, 'm25-l14-out-' || ws, 'out', 'Hi', t0, a) returning id into m;
  update outreach_messages set read_at = t0 + interval '1 hour' where chat_id = c and direction = 'out' and read_at is null;   -- whole-chat read receipt
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c, 'm25-l14-in-' || ws, 'in', 'Hello!', t0 + interval '2 hours');
  -- I: l15 follow t0, followed back t0+2d, DM t0+3d
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_ig, l15, ei15, 'n1', 'follow', t0, 'sent', t0, 'smoke25-' || seq || '-' || ws);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at, invite_accepted_at) values (l15, s_ig, 'first', t0, t0 + interval '2 days') on conflict (lead_id, sender_id) do update set relation = 'first', invite_accepted_at = excluded.invite_accepted_at;
  seq := seq + 1; insert into outreach_actions(workspace_id, sender_id, lead_id, enrollment_id, node_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_ig, l15, ei15, 'n2', 'message', t0 + interval '3 days', 'sent', t0 + interval '3 days', 'smoke25-' || seq || '-' || ws);

  -- ============================================================ 1. facts written by the triggers (the incremental path)
  select count(*) into n from outreach_sequence_lead_facts where sequence_id = qa;
  if n = 13 then log := log || E'\nok   A: one fact row per contacted enrolment (13)'; else fails := fails + 1; log := log || E'\nFAIL A lead fact rows: ' || n; end if;
  select count(*) into n from outreach_sequence_lead_facts where sequence_id = qw and first_contacted_at is null and first_attempt_at is not null;
  if n = 1 then log := log || E'\nok   W: a failed number check is an attempt, not a contact'; else fails := fails + 1; log := log || E'\nFAIL W attempt rows: ' || n; end if;

  -- ============================================================ 2. the list (all time) as the owner
  perform outreach_stats_refresh_due(500);   -- what the one-minute cron does: fill the all-time cache for the queued sequences
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  rows_ := outreach_report_sequences(ws);
  select x into ra from jsonb_array_elements(rows_) x where x->>'sequence_id' = qa::text;
  select x into rb from jsonb_array_elements(rows_) x where x->>'sequence_id' = qb::text;
  select x into re from jsonb_array_elements(rows_) x where x->>'sequence_id' = qe::text;
  select x into rw from jsonb_array_elements(rows_) x where x->>'sequence_id' = qw::text;
  select x into ri from jsonb_array_elements(rows_) x where x->>'sequence_id' = qi::text;
  select x into rd from jsonb_array_elements(rows_) x where x->>'sequence_id' = qd::text;
  if jsonb_array_length(rows_) = 6 and ra is not null and rd is not null then log := log || E'\nok   list: six rows, drafts included'; else fails := fails + 1; log := log || E'\nFAIL list rows: ' || jsonb_array_length(rows_); end if;

  -- A: contacted 12 (l1-l10, l17, l18; l13.. are elsewhere), invited 11, accepted 5, pending 4, replied 4, auto 1, positive 2, meetings 1
  if (ra->>'contacted')::int = 12 then log := log || E'\nok   A contacted = 12 people (re-enrolled lead counted once, connected lead counted when messaged)'; else fails := fails + 1; log := log || E'\nFAIL A contacted: ' || (ra->>'contacted'); end if;
  if (ra->>'invited')::int = 11 then log := log || E'\nok   A invited = 11 (already-connected lead not invited)'; else fails := fails + 1; log := log || E'\nFAIL A invited: ' || (ra->>'invited'); end if;
  if (ra->>'accepted')::int = 5 then log := log || E'\nok   A accepted = 5 (either invite of a re-enrolled lead counts)'; else fails := fails + 1; log := log || E'\nFAIL A accepted: ' || (ra->>'accepted'); end if;
  if (ra->>'accepted_rate')::numeric = 45.5 then log := log || E'\nok   A accepted rate = 45.5% (5 of 11)'; else fails := fails + 1; log := log || E'\nFAIL A accepted_rate: ' || (ra->>'accepted_rate'); end if;
  if (ra->>'pending')::int = 4 then log := log || E'\nok   A pending = 4 (withdrawn and declined invitations are closed)'; else fails := fails + 1; log := log || E'\nFAIL A pending: ' || (ra->>'pending'); end if;
  if (ra->>'accepted_early')::boolean = false then log := log || E'\nok   A not early (fewer than half pending)'; else fails := fails + 1; log := log || E'\nFAIL A accepted_early: ' || (ra->>'accepted_early'); end if;
  if (ra->>'replied')::int = 4 then log := log || E'\nok   A replied = 4 (OOO-then-human, wrote-first, WhatsApp reply; the two-sequence lead went to B)'; else fails := fails + 1; log := log || E'\nFAIL A replied: ' || (ra->>'replied'); end if;
  if (ra->>'auto_replied')::int = 1 then log := log || E'\nok   A auto-replied = 1 (only an OOO arrived)'; else fails := fails + 1; log := log || E'\nFAIL A auto_replied: ' || (ra->>'auto_replied'); end if;
  if (ra->>'replied_rate')::numeric = 33.3 then log := log || E'\nok   A replied rate = 33.3% (4 of 12)'; else fails := fails + 1; log := log || E'\nFAIL A replied_rate: ' || (ra->>'replied_rate'); end if;
  if (ra->>'positive')::int = 2 and (ra->>'meetings')::int = 1 then log := log || E'\nok   A positive = 2 (interested, question), meetings = 1'; else fails := fails + 1; log := log || E'\nFAIL A positive/meetings: ' || (ra->>'positive') || '/' || (ra->>'meetings'); end if;
  if (ra->>'positive_rate')::numeric = 50.0 then log := log || E'\nok   A positive rate = 50% (2 of 4)'; else fails := fails + 1; log := log || E'\nFAIL A positive_rate: ' || (ra->>'positive_rate'); end if;
  if ra->'replied_by_channel'->>'whatsapp' = '1' and ra->'replied_by_channel'->>'linkedin' = '3' then log := log || E'\nok   A replies by channel: 3 LinkedIn, 1 WhatsApp'; else fails := fails + 1; log := log || E'\nFAIL A replied_by_channel: ' || (ra->'replied_by_channel')::text; end if;
  if ra->'accepted_split'->'linkedin'->>'invited' = '11' and ra->'accepted_split'->'linkedin'->>'accepted' = '5' then log := log || E'\nok   A accepted split: LinkedIn 5 of 11'; else fails := fails + 1; log := log || E'\nFAIL A accepted_split: ' || (ra->'accepted_split')::text; end if;
  if jsonb_array_length(ra->'channels') = 1 and ra->'channels'->0->>'channel' = 'linkedin' and (ra->'channels'->0->>'invite_step')::boolean then log := log || E'\nok   A channels = [linkedin] (a WhatsApp reply is not a channel block)'; else fails := fails + 1; log := log || E'\nFAIL A channels: ' || (ra->'channels')::text; end if;
  if ra->'na' = '{}'::jsonb then log := log || E'\nok   A: nothing NA'; else fails := fails + 1; log := log || E'\nFAIL A na: ' || (ra->'na')::text; end if;
  if (ra->'progress'->>'enrolled')::int = 12 and (ra->'progress'->>'live')::int = 6 and (ra->'progress'->>'done')::int = 7 then log := log || E'\nok   A progress: 12 people, 6 live, 7 done'; else fails := fails + 1; log := log || E'\nFAIL A progress: ' || (ra->'progress')::text; end if;
  if ra->>'cached_at' is not null then log := log || E'\nok   A all-time row came from the cache'; else fails := fails + 1; log := log || E'\nFAIL A not cached'; end if;

  -- B: message-only: Accepted NA; the two-sequence lead's reply is credited here; meeting without a reply is positive
  if rb->'na'->>'accepted' = 'This sequence doesn''t send connection requests or follows.' then log := log || E'\nok   B Accepted is NA with the reason'; else fails := fails + 1; log := log || E'\nFAIL B na: ' || (rb->'na')::text; end if;
  if (rb->>'contacted')::int = 2 and (rb->>'replied')::int = 1 then log := log || E'\nok   B contacted 2, replied 1 (latest touch before the reply wins)'; else fails := fails + 1; log := log || E'\nFAIL B contacted/replied: ' || (rb->>'contacted') || '/' || (rb->>'replied'); end if;
  if (rb->>'positive')::int = 1 and (rb->>'meetings')::int = 1 and rb->>'positive_rate' = '100.0' then log := log || E'\nok   B meeting booked without a reply counts as positive'; else fails := fails + 1; log := log || E'\nFAIL B positive/meetings/rate: ' || (rb->>'positive') || '/' || (rb->>'meetings') || '/' || coalesce(rb->>'positive_rate', 'null'); end if;
  -- E: email-only: Accepted NA + Seen NA; bounced lead stays Contacted in the header
  if re->'na'->>'accepted' is not null and re->'na'->>'seen' = 'Email opens aren''t tracked.' then log := log || E'\nok   E Accepted NA and Seen NA'; else fails := fails + 1; log := log || E'\nFAIL E na: ' || (re->'na')::text; end if;
  if (re->>'contacted')::int = 2 and (re->>'replied')::int = 1 and re->>'accepted_rate' is null then log := log || E'\nok   E contacted 2, replied 1, accepted rate n/a'; else fails := fails + 1; log := log || E'\nFAIL E: ' || re::text; end if;
  -- W / I
  if (rw->>'contacted')::int = 1 and (rw->>'replied')::int = 1 and (rw->>'cohort')::int = 2 then log := log || E'\nok   W contacted 1 of 2 attempted, replied 1'; else fails := fails + 1; log := log || E'\nFAIL W: ' || rw::text; end if;
  if (ri->>'invited')::int = 1 and (ri->>'accepted')::int = 1 and ri->'accepted_split'->'instagram'->>'accepted' = '1' and ri->'na' = '{}'::jsonb then log := log || E'\nok   I follow + follow-back = invited 1, accepted 1 (Instagram split)'; else fails := fails + 1; log := log || E'\nFAIL I: ' || ri::text; end if;
  -- D
  if (rd->>'contacted')::int = 0 and (rd->'progress'->>'enrolled')::int = 0 and rd->>'status' = 'draft' then log := log || E'\nok   D draft row is empty (the UI shows dashes)'; else fails := fails + 1; log := log || E'\nFAIL D: ' || rd::text; end if;
  -- sort + filters
  if rows_->0->>'sequence_id' = qa::text then log := log || E'\nok   list sorted by replied'; else fails := fails + 1; log := log || E'\nFAIL sort: ' || (rows_->0->>'name'); end if;
  j := outreach_report_sequences(ws, null, null, null, 'email', null);
  if jsonb_array_length(j) = 1 and j->0->>'sequence_id' = qe::text then log := log || E'\nok   channel filter keeps the sequences that use it'; else fails := fails + 1; log := log || E'\nFAIL channel filter: ' || jsonb_array_length(j); end if;
  j := outreach_report_sequences(ws, null, null, null, null, 'draft');
  if jsonb_array_length(j) = 1 then log := log || E'\nok   status filter'; else fails := fails + 1; log := log || E'\nFAIL status filter: ' || jsonb_array_length(j); end if;

  -- ============================================================ 3. cohorts (D3): first contact in the period, outcomes whenever
  j := outreach_report_sequences(ws, null, d0 - 6, d0 - 4);
  select x into ra from jsonb_array_elements(j) x where x->>'sequence_id' = qa::text;
  if (ra->>'contacted')::int = 1 and (ra->>'accepted')::int = 1 and (ra->>'invited')::int = 1 then log := log || E'\nok   cohort: the lead contacted 5 days before t0 counts as accepted in that window (acceptance came later)'; else fails := fails + 1; log := log || E'\nFAIL cohort early window: ' || ra::text; end if;
  if ra->>'cached_at' is null then log := log || E'\nok   a dated period is computed live'; else fails := fails + 1; log := log || E'\nFAIL dated period cached'; end if;
  j := outreach_report_sequences(ws, null, d0 - 1, (now() at time zone 'UTC')::date);
  select x into ra from jsonb_array_elements(j) x where x->>'sequence_id' = qa::text;
  if (ra->>'contacted')::int = 11 and (ra->>'accepted')::int = 4 then log := log || E'\nok   cohort: the later window leaves that lead out (11 contacted, 4 accepted)'; else fails := fails + 1; log := log || E'\nFAIL cohort later window: ' || ra::text; end if;
  if (ra->'progress'->>'enrolled')::int = 12 then log := log || E'\nok   progress ignores the period'; else fails := fails + 1; log := log || E'\nFAIL progress with period: ' || (ra->'progress')::text; end if;
  begin
    j := outreach_report_sequences(ws, null, d0, null);
    fails := fails + 1; log := log || E'\nFAIL half-open range accepted';
  exception when others then log := log || E'\nok   a range needs both dates (' || left(sqlerrm, 40) || ')'; end;

  -- ============================================================ 4. the sequence page = the list (same numbers everywhere)
  det := outreach_report_sequence(qa);
  rows_ := outreach_report_sequences(ws);
  select x into ra from jsonb_array_elements(rows_) x where x->>'sequence_id' = qa::text;
  if det->'funnel'->>'contacted' = ra->>'contacted' and det->'funnel'->>'accepted' = ra->>'accepted' and det->'funnel'->>'replied' = ra->>'replied' and det->'funnel'->>'positive' = ra->>'positive'
     and det->'funnel'->>'pending' = ra->>'pending' and det->'funnel'->'progress' = ra->'progress'
    then log := log || E'\nok   sequence page funnel = list row (contacted, accepted, pending, replied, positive, progress)';
    else fails := fails + 1; log := log || E'\nFAIL page vs list: ' || (det->'funnel')::text || ' vs ' || ra::text; end if;
  if (det->'period'->>'all')::boolean and det->>'definitions_version' = '2' then log := log || E'\nok   page: all-time period, definitions v2'; else fails := fails + 1; log := log || E'\nFAIL page period: ' || (det->'period')::text; end if;
  if det->'replied_other_channel' = '{"whatsapp": 1}'::jsonb then log := log || E'\nok   "Replied on another channel: 1 (WhatsApp)"'; else fails := fails + 1; log := log || E'\nFAIL replied_other_channel: ' || (det->'replied_other_channel')::text; end if;
  blk := det->'channels'->0->'stages';
  if det->'channels'->0->>'channel' = 'linkedin' and (blk->>'contacted')::int = 12 and (blk->>'invited')::int = 11 and (blk->>'accepted')::int = 5 and (blk->>'messaged')::int = 4 and (blk->>'seen')::int = 1
     and (blk->>'replied')::int = 3 and (blk->>'replied_of_accepted')::int = 2
    then log := log || E'\nok   LinkedIn block: contacted 12 → invited 11 → accepted 5 → messaged 4 → seen ≥1 → replied 3 · replied of accepted 2';
    else fails := fails + 1; log := log || E'\nFAIL LinkedIn block: ' || blk::text; end if;
  if (det->'funnel'->'steps') is null and jsonb_array_length(det->'steps') = 3 and det ? 'ab_tests' and det ? 'exits' and det ? 'totals' then log := log || E'\nok   per-step table, A/B and exits still there'; else fails := fails + 1; log := log || E'\nFAIL legacy parts: ' || jsonb_array_length(det->'steps'); end if;
  det := outreach_report_sequence(qe);
  blk := det->'channels'->0->'stages';
  if det->'channels'->0->>'channel' = 'email' and (blk->>'contacted')::int = 1 and (blk->>'bounced')::int = 1 and (blk->>'replied')::int = 1 and not (blk ? 'seen') and not (blk ? 'invited') then log := log || E'\nok   Email block: contacted 1 (the bounce left out) · replied 1 · bounced 1, no seen / invited stages'; else fails := fails + 1; log := log || E'\nFAIL email block: ' || det->'channels'::text; end if;
  det := outreach_report_sequence(qw);
  blk := det->'channels'->0->'stages';
  if det->'channels'->0->>'channel' = 'whatsapp' and (blk->>'contacted')::int = 1 and (blk->>'seen')::int = 1 and (blk->>'replied')::int = 1 and (blk->>'bounced')::int = 1 and not (blk ? 'invited') then log := log || E'\nok   WhatsApp block: contacted 1 → seen ≥1 → replied 1 · not on WhatsApp 1'; else fails := fails + 1; log := log || E'\nFAIL whatsapp block: ' || det->'channels'::text; end if;
  det := outreach_report_sequence(qi);
  blk := det->'channels'->0->'stages';
  if det->'channels'->0->>'channel' = 'instagram' and (blk->>'invited')::int = 1 and (blk->>'accepted')::int = 1 and (blk->>'messaged')::int = 1 then log := log || E'\nok   Instagram block: followed 1 → followed back 1 → DM''d 1'; else fails := fails + 1; log := log || E'\nFAIL instagram block: ' || det->'channels'::text; end if;
  det := outreach_report_sequence(qa, d0 - 6, d0 - 4);
  if det->'funnel'->>'contacted' = '1' and not (det->'period'->>'all')::boolean then log := log || E'\nok   page with a period uses the same cohort'; else fails := fails + 1; log := log || E'\nFAIL page period: ' || (det->'funnel')::text; end if;
  -- API rows carry the same block
  j := outreach_api_sequences(ws);
  select x into ra from jsonb_array_elements(j) x where x->>'id' = qa::text;
  if ra->'stats'->>'contacted' = '12' and ra->'stats'->>'replied' = '4' and ra->'stats'->'ops'->>'actions_sent' is not null then log := log || E'\nok   /v1/sequences rows carry the same stats'; else fails := fails + 1; log := log || E'\nFAIL api_sequences stats: ' || (ra->'stats')::text; end if;
  j := outreach_metric_definitions();
  if j->>'definitions_version' = '2' and j ? 'contacted' and j ? 'positive' and j ? 'cohort' then log := log || E'\nok   metric definitions carry the new names'; else fails := fails + 1; log := log || E'\nFAIL definitions'; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 5. idempotency: recomputing changes nothing; replaying an event changes nothing
  n := 0;
  for r in select distinct lead_id from outreach_enrollments where workspace_id = ws loop n := n + outreach_stats_rebuild_lead(r.lead_id); end loop;
  if n = 0 then log := log || E'\nok   rebuilding every lead from scratch changes 0 rows (incremental = truth)'; else fails := fails + 1; log := log || E'\nFAIL rebuild changed rows: ' || n; end if;
  n := outreach_stats_rebuild_sequence(qa);
  if n = 0 then log := log || E'\nok   rebuilding the sequence changes 0 rows'; else fails := fails + 1; log := log || E'\nFAIL sequence rebuild changed: ' || n; end if;
  update outreach_messages set read_at = t0 + interval '2 days 1 hour' where id = (select id from outreach_messages where unipile_message_id = 'm25-l1-out-' || ws);   -- the same receipt again
  update outreach_lead_sender_state set invite_accepted_at = t0 + interval '1 day' where lead_id = l1 and sender_id = s_li;                                          -- the same acceptance again
  select count(*) into n from outreach_sequence_lead_facts where sequence_id = qa and accepted_at is not null;
  if n = 5 then log := log || E'\nok   replayed events leave the counts as they were (5 accepted enrolments)'; else fails := fails + 1; log := log || E'\nFAIL replay: ' || n; end if;

  -- OOO reclassified as a person (teammate override): it becomes the first reply; back to ooo: credit returns to the later message
  update outreach_messages set intent = 'question' where id = m_l5_ooo;
  if (select replied_at from outreach_sequence_lead_facts where enrollment_id = ea5) = t0 + interval '3 days' then log := log || E'\nok   an OOO corrected to a person''s reply moves Replied to that message'; else fails := fails + 1; log := log || E'\nFAIL ooo override: ' || (select replied_at::text from outreach_sequence_lead_facts where enrollment_id = ea5); end if;
  update outreach_messages set intent = 'ooo' where id = m_l5_ooo;
  if (select replied_at from outreach_sequence_lead_facts where enrollment_id = ea5) = t0 + interval '6 days' and (select auto_replied_at from outreach_sequence_lead_facts where enrollment_id = ea5) = t0 + interval '3 days'
    then log := log || E'\nok   back to OOO: Replied at the later human reply, OOO stays in the tooltip count'; else fails := fails + 1; log := log || E'\nFAIL ooo back: ' || (select row(replied_at, auto_replied_at)::text from outreach_sequence_lead_facts where enrollment_id = ea5); end if;

  -- ============================================================ 6. reconcile (F54) repairs a missing row and logs it
  delete from outreach_sequence_lead_facts where enrollment_id = ea1;
  update outreach_sequence_channel_facts set seen_at = null where enrollment_id = ea1;
  j := outreach_stats_reconcile(7, 500);
  if exists (select 1 from outreach_sequence_lead_facts where enrollment_id = ea1 and replied_at is not null) and (select seen_at from outreach_sequence_channel_facts where enrollment_id = ea1 and channel = 'linkedin') is not null
    then log := log || E'\nok   reconcile restored the deleted row and the cleared read receipt'; else fails := fails + 1; log := log || E'\nFAIL reconcile repair'; end if;
  select count(*) into n from ops.stats_reconcile_log where sequence_id = qa and rows_fixed >= 2;
  if n = 1 then log := log || E'\nok   reconcile logged the repair'; else fails := fails + 1; log := log || E'\nFAIL reconcile log rows: ' || n || ' · ' || j::text; end if;
  if (select status from ops.health_state where check_key = 'stats-1') is not null then log := log || E'\nok   Health check stats-1 has a status'; else fails := fails + 1; log := log || E'\nFAIL stats-1 health state missing'; end if;
  j := outreach_stats_reconcile(7, 500);
  select count(*) into n from ops.stats_reconcile_log where sequence_id = qa;
  if n = 1 then log := log || E'\nok   a clean second run logs nothing for the sequence'; else fails := fails + 1; log := log || E'\nFAIL second reconcile: ' || n || ' · ' || j::text; end if;

  -- ============================================================ 7. cache refresh queue
  n := outreach_stats_refresh_due(500);
  if not exists (select 1 from outreach_stats_refresh_queue q join outreach_sequences s on s.id = q.sequence_id where s.workspace_id = ws) then log := log || E'\nok   refresh drained the queue'; else fails := fails + 1; log := log || E'\nFAIL queue not drained'; end if;
  delete from outreach_enrollments where id = ea7;
  if exists (select 1 from outreach_stats_refresh_queue where sequence_id = qa) then log := log || E'\nok   removing an enrolment queues the sequence'; else fails := fails + 1; log := log || E'\nFAIL enrolment delete not queued'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  rows_ := outreach_report_sequences(ws);
  select x into ra from jsonb_array_elements(rows_) x where x->>'sequence_id' = qa::text;
  if (ra->>'contacted')::int = 11 and ra->>'cached_at' is null then log := log || E'\nok   a queued sequence is computed live on the list (never behind)'; else fails := fails + 1; log := log || E'\nFAIL queued row: ' || (ra->>'contacted') || ' cached_at ' || coalesce(ra->>'cached_at', 'null'); end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 8. grants
  select count(*) into n from information_schema.role_routine_grants where routine_name in ('outreach_report_sequences', 'outreach_report_sequence') and grantee = 'authenticated' and privilege_type = 'EXECUTE';
  if n = 2 then log := log || E'\nok   authenticated may call both report functions'; else fails := fails + 1; log := log || E'\nFAIL authenticated grants: ' || n; end if;
  select count(*) into n from information_schema.role_routine_grants where routine_name in ('outreach_stats_reconcile', 'outreach_stats_rebuild_sequence', 'outreach__stats_truth_leads', 'outreach_stats_refresh_due') and grantee in ('authenticated', 'anon', 'PUBLIC') and privilege_type = 'EXECUTE';
  if n = 0 then log := log || E'\nok   service functions are not callable by users'; else fails := fails + 1; log := log || E'\nFAIL service grant rows: ' || n; end if;
  select count(*) into n from cron.job where jobname in ('outreach-stats-refresh', 'outreach-stats-reconcile');
  if n = 2 then log := log || E'\nok   both cron jobs scheduled'; else fails := fails + 1; log := log || E'\nFAIL cron jobs: ' || n; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
