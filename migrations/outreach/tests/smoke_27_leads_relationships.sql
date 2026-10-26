-- Smoke test — 094 leads relationships (prospects vs inbox contacts, status, connections per account).
-- Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_27_leads_relationships.sql
do $$
declare
  log text := ''; fails int := 0; n int; j jsonb; t text; r record; b boolean; ts timestamptz;
  ws uuid; u_owner uuid; u_other uuid; u_member uuid; cl_a uuid; cl_b uuid;
  s_li_a uuid; s_li_b uuid; s_ig uuid; s_wa uuid; s_gm uuid; s_gone uuid;
  st_meeting uuid; lst uuid; sq uuid;
  l_csv uuid; l_inbox uuid; l_news uuid; l_page uuid; l_ours uuid; l_theirs uuid; l_pre uuid; l_two uuid; l_gone uuid;
  l_bounce uuid; l_wa uuid; l_replied uuid; l_ooo uuid; l_meet uuid; l_dnc uuid; l_wrote uuid; l_clb uuid; l_invited uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; ids uuid[];
begin
  -- ============================================================ fixtures
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_other from platform_user_access where status = 'active' and user_id <> u_owner order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' and user_id not in (u_owner, u_other) order by created_at limit 1;
  if u_owner is null or u_other is null or u_member is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke27', 'smoke27-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into cl_a;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cl_b;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner27@test.local', 'Owner');
  insert into outreach_members(workspace_id, user_id, role, client_ids, email, display_name) values (ws, u_member, 'member', array[cl_a], 'member27@test.local', 'Member A');

  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, timezone) values (ws, 'LINKEDIN', 'Naman', 'ok', 's27a-' || ws, 'Asia/Kolkata') returning id into s_li_a;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'Avi', 'ok', 's27b-' || ws) returning id into s_li_b;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'INSTAGRAM', 'Kaptured Insta', 'ok', 's27i-' || ws) returning id into s_ig;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, public_identifier) values (ws, 'WHATSAPP', 'Aarushi (WA)', 'ok', 's27w-' || ws, '+919999999999') returning id into s_wa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'GMAIL', 'hello@kaptured.ai', 'ok', 's27g-' || ws) returning id into s_gm;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, deleted_at) values (ws, 'LINKEDIN', 'Old account', 'disabled', 's27x-' || ws, now()) returning id into s_gone;

  insert into outreach_stages(workspace_id, name, position, kind) values (ws, 'Meeting', 5, 'meeting') returning id into st_meeting;
  insert into outreach_lists(workspace_id, name) values (ws, 'Founders') returning id into lst;
  insert into outreach_sequences(workspace_id, name, status, sender_pool, created_by) values (ws, 'Seq', 'active', array[s_li_a], u_owner) returning id into sq;

  -- ============================================================ 1. classification (PRD §3.1, §13)
  if outreach_inbound_kind('GMAIL', 'ElevenLabs Team', null, 'no-reply@contact.elevenlabs.io') = 'automated' then log := log || E'\nok   email no-reply local part -> automated'; else fails := fails + 1; log := log || E'\nFAIL no-reply not automated'; end if;
  if outreach_inbound_kind('GMAIL', 'Behance', null, 'noreply-behance@behance.com') = 'automated' then log := log || E'\nok   noreply-<brand> -> automated'; else fails := fails + 1; log := log || E'\nFAIL noreply-behance'; end if;
  if outreach_inbound_kind('GMAIL', 'Quora Digest', null, 'english-personalized-digest@quora.com') = 'automated' then log := log || E'\nok   …-digest -> automated'; else fails := fails + 1; log := log || E'\nFAIL digest'; end if;
  if outreach_inbound_kind('GMAIL', 'Acme', null, 'jane@acme.com', null, '[{"name":"List-Unsubscribe","value":"<mailto:u@acme.com>"}]'::jsonb) = 'automated' then log := log || E'\nok   List-Unsubscribe header -> automated'; else fails := fails + 1; log := log || E'\nFAIL list-unsubscribe'; end if;
  if outreach_inbound_kind('GMAIL', 'Acme', null, 'jane@acme.com', null, '{"Precedence":"bulk"}'::jsonb) = 'automated' then log := log || E'\nok   Precedence: bulk -> automated'; else fails := fails + 1; log := log || E'\nFAIL precedence'; end if;
  if outreach_inbound_kind('GMAIL', 'Acme', null, 'jane@acme.com', null, '{"Auto-Submitted":"auto-generated"}'::jsonb) = 'automated' then log := log || E'\nok   Auto-Submitted -> automated'; else fails := fails + 1; log := log || E'\nFAIL auto-submitted'; end if;
  if outreach_inbound_kind('GMAIL', 'Acme', null, 'jane@acme.com', null, '{"Auto-Submitted":"no"}'::jsonb) = 'person' then log := log || E'\nok   Auto-Submitted: no stays a person'; else fails := fails + 1; log := log || E'\nFAIL auto-submitted no'; end if;
  if outreach_inbound_kind('GMAIL', 'Priya Founder', null, 'priya@email.epidemicsound.com') = 'automated' and outreach_inbound_kind('GMAIL', 'Priya Founder', null, 'priya@epidemicsound.com') = 'person'
    then log := log || E'\nok   a founder on the company domain stays a person; the marketing subdomain rule only catches the subdomain'; else fails := fails + 1; log := log || E'\nFAIL domain rule scope'; end if;
  if outreach_inbound_kind('LINKEDIN', 'LinkedIn for Marketing', '4973896', null, null) = 'company_page' then log := log || E'\nok   LinkedIn numeric id -> company page'; else fails := fails + 1; log := log || E'\nFAIL numeric id'; end if;
  if outreach_inbound_kind('LINKEDIN', 'Some Brand', '778899', null, '{"content_type":"sponsored"}'::jsonb) = 'company_page' then log := log || E'\nok   sponsored chat from a page -> company page'; else fails := fails + 1; log := log || E'\nFAIL sponsored page'; end if;
  if outreach_inbound_kind('LINKEDIN', 'Vanessa Recruiter', 'ACoAAxyz123', null, '{"content_type":"sponsored"}'::jsonb) = 'automated' then log := log || E'\nok   sponsored InMail from a person -> automated (an ad, not a prospect)'; else fails := fails + 1; log := log || E'\nFAIL sponsored person'; end if;
  if outreach_inbound_kind('LINKEDIN', 'LinkedIn Member', 'ACoAACy4zU8Bl72ncYCcbQmNlrvEHSrKIrG7mLk', null, null) = 'person' then log := log || E'\nok   "LinkedIn Member" (hidden name) is a person'; else fails := fails + 1; log := log || E'\nFAIL linkedin member'; end if;
  if outreach_inbound_kind('LINKEDIN', 'Jobs', 'ACoAA1', null, '{"content_type":"linkedin_offer"}'::jsonb) = 'automated' then log := log || E'\nok   job-offer system message -> automated'; else fails := fails + 1; log := log || E'\nFAIL linkedin_offer'; end if;
  if outreach_inbound_kind('LINKEDIN', 'Jane Doe', 'ACoAA2', 'jane-doe', '{"content_type":"inmail"}'::jsonb) = 'person' then log := log || E'\nok   an InMail from a person is a person'; else fails := fails + 1; log := log || E'\nFAIL inmail person'; end if;
  if outreach_inbound_kind('WHATSAPP', 'Someone', '919@lid', '+919000000000') = 'person' then log := log || E'\nok   WhatsApp sender -> person'; else fails := fails + 1; log := log || E'\nFAIL whatsapp person'; end if;

  -- ============================================================ 2. origin + prospect flag triggers (PRD §3.2, §3.3)
  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'csv-lead', 'Csv Lead', 'csv') returning id into l_csv;
  insert into outreach_leads(workspace_id, provider_id, full_name, source) values (ws, 'ACoAAinbox1', 'Inbox Person', 'inbound') returning id into l_inbox;
  insert into outreach_leads(workspace_id, email_work, full_name, source, kind, hidden_at, hidden_reason) values (ws, 'noreply@news.example.com', 'News Letter', 'inbound_email', 'automated', now(), 'automated') returning id into l_news;
  insert into outreach_leads(workspace_id, provider_id, full_name, source, kind, hidden_at, hidden_reason) values (ws, '10657590', 'Big Bank Page', 'inbound', 'company_page', now(), 'company_page') returning id into l_page;
  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'api-lead', 'Api Lead', 'mcp') returning id into l_invited;
  select origin, (prospect_since is not null) as flag into r from outreach_leads where id = l_csv;
  if r.origin = 'import' and r.flag then log := log || E'\nok   csv lead: origin import, prospect from creation'; else fails := fails + 1; log := log || E'\nFAIL csv lead origin/prospect: ' || r::text; end if;
  select origin, (prospect_since is null) as flag into r from outreach_leads where id = l_inbox;
  if r.origin = 'inbound' and r.flag then log := log || E'\nok   inbound lead: origin inbound, not a prospect'; else fails := fails + 1; log := log || E'\nFAIL inbound lead: ' || r::text; end if;
  if (select origin from outreach_leads where id = l_invited) = 'api' then log := log || E'\nok   connector lead: origin api'; else fails := fails + 1; log := log || E'\nFAIL mcp origin'; end if;

  -- tags never promote; a list does
  insert into outreach_tags(workspace_id, name) values (ws, 'warm') returning id into c1;
  insert into outreach_lead_tags(lead_id, tag_id) values (l_inbox, c1);
  if (select prospect_since from outreach_leads where id = l_inbox) is null then log := log || E'\nok   a tag does not promote'; else fails := fails + 1; log := log || E'\nFAIL tag promoted'; end if;
  update outreach_leads set list_id = lst where id = l_inbox;
  if (select prospect_since from outreach_leads where id = l_inbox) is not null then log := log || E'\nok   adding to a list promotes'; else fails := fails + 1; log := log || E'\nFAIL list did not promote'; end if;
  -- enrolment promotes
  insert into outreach_leads(workspace_id, provider_id, full_name, source) values (ws, 'ACoAAwrote', 'Wrote First', 'inbound') returning id into l_wrote;
  insert into outreach_leads(workspace_id, provider_id, full_name, source) values (ws, 'ACoAAenrol', 'Enrolled Later', 'inbound') returning id into l_replied;
  insert into outreach_enrollments(workspace_id, sequence_id, sequence_version, lead_id, sender_id, status, current_node_id) values (ws, sq, 1, l_replied, s_li_a, 'active', 'n1');
  if (select prospect_since from outreach_leads where id = l_replied) is not null then log := log || E'\nok   enrolling promotes'; else fails := fails + 1; log := log || E'\nFAIL enrolment did not promote'; end if;

  -- ============================================================ 3. relation source (PRD §4.2, §8.2)
  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'ours', 'Our Invite', 'csv') returning id into l_ours;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at) values (l_ours, s_li_a, 'pending_out', now() - interval '5 days');
  update outreach_lead_sender_state set relation = 'first', invite_accepted_at = now() - interval '3 days', invite_detected_at = now() where lead_id = l_ours and sender_id = s_li_a;
  select relation_source, connected_at, relation_checked_at into r from outreach_lead_sender_state where lead_id = l_ours and sender_id = s_li_a;
  if r.relation_source = 'our_invite' and r.connected_at = now() - interval '3 days' and r.relation_checked_at is not null then log := log || E'\nok   accepted our invite -> our_invite, connected_at = acceptance'; else fails := fails + 1; log := log || E'\nFAIL our_invite: ' || r::text; end if;

  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'theirs', 'Their Invite', 'csv') returning id into l_theirs;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (l_theirs, s_li_a, 'pending_in');
  update outreach_lead_sender_state set relation = 'first' where lead_id = l_theirs and sender_id = s_li_a;
  if (select relation_source from outreach_lead_sender_state where lead_id = l_theirs and sender_id = s_li_a) = 'their_invite' then log := log || E'\nok   accepting their invite -> their_invite'; else fails := fails + 1; log := log || E'\nFAIL their_invite'; end if;

  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'pre', 'Pre Existing', 'csv') returning id into l_pre;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (l_pre, s_li_a, 'first');
  if (select relation_source from outreach_lead_sender_state where lead_id = l_pre and sender_id = s_li_a) = 'pre_existing' then log := log || E'\nok   first seen already connected -> pre_existing'; else fails := fails + 1; log := log || E'\nFAIL pre_existing'; end if;

  -- an explicit source from the caller wins (Instagram poll)
  insert into outreach_leads(workspace_id, full_name, source) values (ws, 'Two Accounts', 'csv') returning id into l_two;
  insert into outreach_lead_identities(workspace_id, lead_id, provider, identifier, verified, source) values (ws, l_two, 'INSTAGRAM', 'two.accounts', true, 'import');
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, relation_source, we_follow, follows_us) values (l_two, s_ig, 'first', 'our_invite', true, true);
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at) values (l_two, s_li_a, 'pending_out', now() - interval '2 days');
  update outreach_lead_sender_state set relation = 'first', invite_accepted_at = now() - interval '1 day' where lead_id = l_two and sender_id = s_li_a;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (l_two, s_li_b, 'first');
  if (select relation_source from outreach_lead_sender_state where lead_id = l_two and sender_id = s_ig) = 'our_invite' then log := log || E'\nok   an explicit relation_source is kept'; else fails := fails + 1; log := log || E'\nFAIL explicit source overwritten'; end if;

  -- a connection that disappears keeps connected_at
  update outreach_lead_sender_state set relation = 'none' where lead_id = l_pre and sender_id = s_li_a;
  if (select connected_at from outreach_lead_sender_state where lead_id = l_pre and sender_id = s_li_a) is not null then log := log || E'\nok   a removed connection keeps connected_at (history)'; else fails := fails + 1; log := log || E'\nFAIL connected_at lost'; end if;

  -- ============================================================ 4. more status fixtures
  -- removed account connected
  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'gone', 'Gone Account', 'csv') returning id into l_gone;
  insert into outreach_lead_sender_state(lead_id, sender_id, relation) values (l_gone, s_gone, 'first');
  -- invited only (pending)
  insert into outreach_lead_sender_state(lead_id, sender_id, relation, invite_sent_at) values (l_invited, s_li_b, 'pending_out', now() - interval '1 day');
  -- email bounced, nothing else
  insert into outreach_leads(workspace_id, email_work, full_name, source) values (ws, 'bounce@example.com', 'Bounced Email', 'csv') returning id into l_bounce;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name) values (ws, s_gm, l_bounce, 'thr-bounce', 'GMAIL', 'bounce@example.com', 'Bounced Email') returning id into c1;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c1, 'out', 'Hello', now() - interval '2 days');
  insert into outreach_lead_sender_state(lead_id, sender_id, email_bounced, last_outbound_at) values (l_bounce, s_gm, true, now() - interval '2 days');
  -- messaged on WhatsApp only
  insert into outreach_leads(workspace_id, full_name, source, phone) values (ws, 'Wa Only', 'csv', '+919876543210') returning id into l_wa;
  insert into outreach_lead_identities(workspace_id, lead_id, provider, identifier, verified, source) values (ws, l_wa, 'WHATSAPP', '+919876543210', true, 'import');
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_wa, l_wa, 'message', now() - interval '1 day', 'sent', now() - interval '1 day', 'smoke27-wa-' || l_wa);
  insert into outreach_lead_sender_state(lead_id, sender_id, last_outbound_at) values (l_wa, s_wa, now() - interval '1 day');
  -- replied (person) then interested
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name) values (ws, s_li_a, l_replied, 'chat-replied', 'LINKEDIN', 'ACoAAenrol', 'Enrolled Later') returning id into c2;
  insert into outreach_actions(workspace_id, sender_id, lead_id, action_type, scheduled_for, status, executed_at, idempotency_key) values (ws, s_li_a, l_replied, 'message', now() - interval '3 days', 'sent', now() - interval '3 days', 'smoke27-msg-' || l_replied);
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c2, 'out', 'Hi there', now() - interval '3 days');
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c2, 'in', 'Thanks, tell me more', now() - interval '2 days');
  -- OOO only: never a reply
  insert into outreach_leads(workspace_id, public_identifier, full_name, source) values (ws, 'ooo', 'Out Of Office', 'csv') returning id into l_ooo;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name) values (ws, s_li_a, l_ooo, 'chat-ooo', 'LINKEDIN', 'ACoAAooo', 'Out Of Office') returning id into c3;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c3, 'out', 'Hi', now() - interval '3 days');
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, is_auto_reply) values (ws, c3, 'in', 'I am away until Monday', now() - interval '2 days', true);
  -- meeting stage
  insert into outreach_leads(workspace_id, public_identifier, full_name, source, stage_id) values (ws, 'meet', 'Meeting Lead', 'csv', st_meeting) returning id into l_meet;
  -- do not contact with a reply behind it
  insert into outreach_leads(workspace_id, public_identifier, full_name, source, do_not_contact) values (ws, 'dnc', 'Dnc Lead', 'csv', true) returning id into l_dnc;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name) values (ws, s_li_a, l_dnc, 'chat-dnc', 'LINKEDIN', 'ACoAAdnc', 'Dnc Lead') returning id into c4;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c4, 'out', 'Hi', now() - interval '3 days');
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c4, 'in', 'No thanks', now() - interval '2 days');
  -- wrote to us (never touched)
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name) values (ws, s_li_a, l_wrote, 'chat-wrote', 'LINKEDIN', 'ACoAAwrote', 'Wrote First') returning id into c5;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values (ws, c5, 'in', 'Hey, saw your post', now() - interval '1 day');
  -- a client-B lead (scope test)
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, source) values (ws, cl_b, 'client-b', 'Client B Lead', 'csv') returning id into l_clb;

  -- the queue holds every touched lead; the worker's RPC drains it
  select count(*) into n from outreach_lead_summary_queue q join outreach_leads l on l.id = q.lead_id where l.workspace_id = ws;
  if n >= 15 then log := log || E'\nok   triggers queued the leads (' || n || ')'; else fails := fails + 1; log := log || E'\nFAIL queue has only ' || n; end if;
  loop j := outreach_lead_summary_process(500); exit when (j->>'processed')::int = 0; end loop;
  select count(*) into n from outreach_lead_summary_queue q join outreach_leads l on l.id = q.lead_id where l.workspace_id = ws;
  if n = 0 then log := log || E'\nok   queue drained'; else fails := fails + 1; log := log || E'\nFAIL queue left ' || n; end if;

  -- ============================================================ 5. status ladder (PRD §4.1)
  select status, status_rank, status_channel into r from outreach_lead_summary where lead_id = l_csv;
  if r.status = 'not_contacted' and r.status_rank = 0 then log := log || E'\nok   untouched lead: Not contacted'; else fails := fails + 1; log := log || E'\nFAIL not_contacted: ' || r::text; end if;
  select status, status_channel into r from outreach_lead_summary where lead_id = l_invited;
  if r.status = 'invited' and r.status_channel = 'linkedin' then log := log || E'\nok   pending invite: Invited (in)'; else fails := fails + 1; log := log || E'\nFAIL invited: ' || r::text; end if;
  select status, status_channel, connected_sender_ids, connected_via_our_invite_ids into r from outreach_lead_summary where lead_id = l_ours;
  if r.status = 'connected' and r.status_channel = 'linkedin' and r.connected_sender_ids = array[s_li_a] and r.connected_via_our_invite_ids = array[s_li_a] then log := log || E'\nok   accepted invite: Connected (in), via our invite'; else fails := fails + 1; log := log || E'\nFAIL connected ours: ' || r::text; end if;
  select status, status_rank, connected_sender_ids into r from outreach_lead_summary where lead_id = l_pre;
  if r.status = 'connected' and r.connected_sender_ids = '{}' then log := log || E'\nok   connection removed later: status keeps Connected, Connected via is empty'; else fails := fails + 1; log := log || E'\nFAIL removed connection: ' || r::text; end if;
  select status, status_channel, used_channels, identity_channels into r from outreach_lead_summary where lead_id = l_wa;
  if r.status = 'messaged' and r.status_channel = 'whatsapp' and 'whatsapp' = any(r.used_channels) and 'whatsapp' = any(r.identity_channels) then log := log || E'\nok   WhatsApp message: Messaged (wa), channel used + reachable'; else fails := fails + 1; log := log || E'\nFAIL wa messaged: ' || r::text; end if;
  select status, status_channel, replied_channels, replied_sender_ids into r from outreach_lead_summary where lead_id = l_replied;
  if r.status = 'replied' and r.status_channel = 'linkedin' and r.replied_sender_ids = array[s_li_a] then log := log || E'\nok   human reply after our touch: Replied (in)'; else fails := fails + 1; log := log || E'\nFAIL replied: ' || r::text; end if;
  update outreach_messages set intent = 'interested' where chat_id = c2 and direction = 'in';
  loop j := outreach_lead_summary_process(500); exit when (j->>'processed')::int = 0; end loop;
  if (select status from outreach_lead_summary where lead_id = l_replied) = 'interested' then log := log || E'\nok   intent interested: Interested'; else fails := fails + 1; log := log || E'\nFAIL interested'; end if;
  select status, status_rank into r from outreach_lead_summary where lead_id = l_ooo;
  if r.status = 'messaged' then log := log || E'\nok   an out-of-office is not a reply'; else fails := fails + 1; log := log || E'\nFAIL ooo counted: ' || r::text; end if;
  if (select status from outreach_lead_summary where lead_id = l_meet) = 'meeting' then log := log || E'\nok   meeting stage: Meeting'; else fails := fails + 1; log := log || E'\nFAIL meeting'; end if;
  select status, status_rank into r from outreach_lead_summary where lead_id = l_dnc;
  if r.status = 'do_not_contact' and r.status_rank = 4 then log := log || E'\nok   suppressed lead: Do not contact shown, history (rank) kept'; else fails := fails + 1; log := log || E'\nFAIL dnc: ' || r::text; end if;
  select status, status_channel, bounced_channels into r from outreach_lead_summary where lead_id = l_bounce;
  if r.status = 'bounced' and r.bounced_channels = array['email'] then log := log || E'\nok   bounced email and nothing else: Bounced'; else fails := fails + 1; log := log || E'\nFAIL bounced: ' || r::text; end if;
  select status, wrote_first_at into r from outreach_lead_summary where lead_id = l_wrote;
  if r.status = 'wrote_to_us' and r.wrote_first_at is not null then log := log || E'\nok   inbox contact we never touched: Wrote to us'; else fails := fails + 1; log := log || E'\nFAIL wrote_to_us: ' || r::text; end if;
  select connected_sender_ids, connected_count into r from outreach_lead_summary where lead_id = l_two;
  if r.connected_count = 3 and r.connected_sender_ids @> array[s_ig, s_li_a, s_li_b] then log := log || E'\nok   a lead connected to three accounts lists all three'; else fails := fails + 1; log := log || E'\nFAIL multi connected: ' || r::text; end if;

  -- ============================================================ 6. totals and by account (PRD §5.4, §5.5) as the owner
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_leads_totals(ws, '{"tab":"all"}'::jsonb);
  if (j->>'people')::int = 16 then log := log || E'\nok   totals(all): 16 people'; else fails := fails + 1; log := log || E'\nFAIL totals people: ' || j::text; end if;
  if (j->>'connected')::int = 3 and (j->>'connected_via_our_invites')::int = 2 then log := log || E'\nok   totals: 3 connected (l_ours, l_two, l_theirs), 2 via our invites; the removed account does not count'; else fails := fails + 1; log := log || E'\nFAIL totals connected: ' || j::text; end if;
  if (j->>'replied')::int = 3 and (j->>'interested')::int = 2 and (j->>'meetings')::int = 1 then log := log || E'\nok   totals: replied 3 (replied, dnc, meeting) interested 2 meetings 1'; else fails := fails + 1; log := log || E'\nFAIL totals replied/interested/meetings: ' || j::text; end if;
  j := outreach_leads_totals(ws, '{"tab":"all"}'::jsonb, true);
  if (j->>'connected')::int = 4 then log := log || E'\nok   include removed accounts: 4 connected'; else fails := fails + 1; log := log || E'\nFAIL totals include_removed: ' || j::text; end if;
  j := outreach_leads_totals(ws, '{"tab":"prospects"}'::jsonb);
  if (j->>'people')::int = 15 then log := log || E'\nok   Prospects tab: 15 (the wrote-first contact is in From inbox; two hidden)'; else fails := fails + 1; log := log || E'\nFAIL prospects count: ' || j::text; end if;
  j := outreach_leads_totals(ws, '{"tab":"inbox"}'::jsonb);
  if (j->>'people')::int = 1 then log := log || E'\nok   From inbox tab: 1'; else fails := fails + 1; log := log || E'\nFAIL inbox count: ' || j::text; end if;
  j := outreach_leads_totals(ws, '{"hidden":true}'::jsonb);
  if (j->>'people')::int = 2 then log := log || E'\nok   Hidden filter: 2 (newsletter, company page)'; else fails := fails + 1; log := log || E'\nFAIL hidden count: ' || j::text; end if;

  j := outreach_leads_by_account(ws, '{"tab":"all"}'::jsonb);
  select count(*) into n from jsonb_array_elements(j->'rows') e where (e->>'sender_id')::uuid = s_gone;
  if n = 0 then log := log || E'\nok   by account hides the removed account by default'; else fails := fails + 1; log := log || E'\nFAIL removed account listed'; end if;
  select (e->>'connected')::int as c, (e->>'via_our_invite')::int as o, (e->>'pending')::int as p into r from jsonb_array_elements(j->'rows') e where (e->>'sender_id')::uuid = s_li_a;
  if r.c = 3 and r.o = 2 and r.p = 0 then log := log || E'\nok   by account: Naman 3 connected (ours, theirs, two), 2 via our invite'; else fails := fails + 1; log := log || E'\nFAIL by account Naman: ' || r::text; end if;
  select (e->>'connected')::int into n from jsonb_array_elements(j->'rows') e where (e->>'sender_id')::uuid = s_li_b;
  if n = 1 then log := log || E'\nok   by account: the same lead counts once in Avi''s row too'; else fails := fails + 1; log := log || E'\nFAIL by account Avi: ' || coalesce(n::text, 'null'); end if;
  select e->>'connected' as c, (e->>'contacted')::int as k into r from jsonb_array_elements(j->'rows') e where (e->>'sender_id')::uuid = s_wa;
  if r.c is null and r.k = 1 then log := log || E'\nok   WhatsApp row: no Connected number, 1 contacted'; else fails := fails + 1; log := log || E'\nFAIL wa row: ' || r::text; end if;
  j := outreach_leads_by_account(ws, '{"tab":"all"}'::jsonb, true);
  select count(*) into n from jsonb_array_elements(j->'rows') e where (e->>'sender_id')::uuid = s_gone and (e->>'removed')::boolean;
  if n = 1 then log := log || E'\nok   include removed: the old account appears, marked removed'; else fails := fails + 1; log := log || E'\nFAIL removed row missing'; end if;

  -- ============================================================ 7. filters (PRD §5.6) through leads_list
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'status', array['connected']), 'activity', 50, 0);
  if (j->>'total')::int = 5 then log := log || E'\nok   filter status=connected: 5 (ours, theirs, pre, two, gone: status is what was ever reached)'; else fails := fails + 1; log := log || E'\nFAIL status filter: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'connected_via', array[s_li_b]), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   filter connected_via Avi: 1'; else fails := fails + 1; log := log || E'\nFAIL connected_via: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'pending_with', array[s_li_b]), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   filter pending_with Avi: 1'; else fails := fails + 1; log := log || E'\nFAIL pending_with: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'connection_source', 'their_invite'), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   filter connection_source=their_invite: 1'; else fails := fails + 1; log := log || E'\nFAIL connection_source: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'connected_via', array[s_gone]), 'activity', 50, 0);
  if (j->>'total')::int = 0 then log := log || E'\nok   filter connected_via a removed account: 0 unless include_removed'; else fails := fails + 1; log := log || E'\nFAIL connected_via removed: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'connected_via', array[s_gone], 'include_removed', true), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   … and 1 with include_removed'; else fails := fails + 1; log := log || E'\nFAIL connected_via removed incl: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'channel_used', 'WHATSAPP'), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   filter channel_used=WHATSAPP: 1'; else fails := fails + 1; log := log || E'\nFAIL channel_used: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'channel_replied', 'LINKEDIN'), 'activity', 50, 0);
  if (j->>'total')::int = 2 then log := log || E'\nok   filter channel_replied=LINKEDIN: 2 (replied, dnc)'; else fails := fails + 1; log := log || E'\nFAIL channel_replied: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'origin', array['inbound']), 'activity', 50, 0);
  if (j->>'total')::int = 3 then log := log || E'\nok   filter origin=inbound: 3 (inbox person, wrote first, enrolled later)'; else fails := fails + 1; log := log || E'\nFAIL origin filter: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('hidden', true, 'kind', array['automated']), 'activity', 50, 0);
  if (j->>'total')::int = 1 and (j->'rows'->0->>'kind') = 'automated' then log := log || E'\nok   Hidden + kind=automated: the newsletter'; else fails := fails + 1; log := log || E'\nFAIL hidden kind: ' || j::text; end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'not_connected', true), 'activity', 50, 0);
  if (j->>'total')::int = 13 then log := log || E'\nok   filter not connected to any account: 13 (gone counts: its only connection is removed)'; else fails := fails + 1; log := log || E'\nFAIL not_connected: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'has_email', true), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   connector filter has_email: 1 (the bounce lead; the newsletter is hidden)'; else fails := fails + 1; log := log || E'\nFAIL has_email: ' || (j->>'total'); end if;
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'enrolled_in', sq), 'activity', 50, 0);
  if (j->>'total')::int = 1 then log := log || E'\nok   connector filter enrolled_in: 1'; else fails := fails + 1; log := log || E'\nFAIL enrolled_in: ' || (j->>'total'); end if;
  -- row shape
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'search', 'Two Accounts'), 'activity', 50, 0);
  if (j->>'total')::int = 1 and jsonb_array_length(j->'rows'->0->'connected_via') = 3 and (j->'rows'->0->'channels'->'reachable') ? 'instagram' then log := log || E'\nok   leads_list row carries connected_via[] and channels{}'; else fails := fails + 1; log := log || E'\nFAIL row shape: ' || (j->'rows'->0)::text; end if;

  -- ============================================================ 8. relationships (PRD §6)
  j := outreach_lead_relationships(l_two);
  select count(*) into n from jsonb_array_elements(j) e where e->>'state' = 'connected';
  if n = 3 then log := log || E'\nok   relationships: three connected rows'; else fails := fails + 1; log := log || E'\nFAIL relationships count: ' || j::text; end if;
  select e->>'source' into t from jsonb_array_elements(j) e where (e->>'sender_id')::uuid = s_li_b;
  if t = 'pre_existing' then log := log || E'\nok   relationships: Avi row says already connected before outreach'; else fails := fails + 1; log := log || E'\nFAIL relationships source: ' || coalesce(t, 'null'); end if;
  j := outreach_lead_relationships(l_bounce);
  if (j->0->>'state') = 'bounced' and (j->0->>'channel') = 'email' then log := log || E'\nok   relationships: the mailbox row shows Bounced'; else fails := fails + 1; log := log || E'\nFAIL relationships bounce: ' || j::text; end if;
  j := outreach_lead_relationships(l_gone);
  if jsonb_array_length(j) = 0 and jsonb_array_length(outreach_lead_relationships(l_gone, true)) = 1 then log := log || E'\nok   relationships: removed account only with include_removed'; else fails := fails + 1; log := log || E'\nFAIL relationships removed: ' || j::text; end if;

  -- ============================================================ 9. promote / hide / unhide
  n := outreach_lead_promote(ws, array[l_wrote]);
  if n = 1 and (select prospect_since from outreach_leads where id = l_wrote) is not null then log := log || E'\nok   Add to prospects promotes an inbox contact'; else fails := fails + 1; log := log || E'\nFAIL promote: ' || n; end if;
  n := outreach_lead_hide(ws, array[l_csv], true);
  if n = 1 and (select hidden_reason from outreach_leads where id = l_csv) = 'manual' then log := log || E'\nok   hide by hand: hidden_reason manual'; else fails := fails + 1; log := log || E'\nFAIL hide: ' || n; end if;
  n := outreach_lead_hide(ws, array[l_csv, l_news], false);
  select (hidden_at is null) as unh, hidden_reason into r from outreach_leads where id = l_news;
  if n = 2 and r.unh and r.hidden_reason is null then log := log || E'\nok   unhide clears hidden_at and the reason'; else fails := fails + 1; log := log || E'\nFAIL unhide: ' || n || ' ' || r::text; end if;
  n := outreach_lead_promote(ws, array[l_page]);
  select (hidden_at is null) as unh, (prospect_since is not null) as pro into r from outreach_leads where id = l_page;
  if n = 1 and r.unh and r.pro then log := log || E'\nok   promoting a hidden lead unhides it too'; else fails := fails + 1; log := log || E'\nFAIL promote hidden: ' || r::text; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 10. access: outsider, client-scoped member
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_other)::text, true);
  execute 'set local role authenticated';
  begin
    j := outreach_leads_totals(ws, '{}'::jsonb);
    fails := fails + 1; log := log || E'\nFAIL outsider read totals';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   outsider: totals E_FORBIDDEN'; else fails := fails + 1; log := log || E'\nFAIL outsider totals error: ' || sqlerrm; end if;
  end;
  begin
    j := outreach_lead_relationships(l_two);
    fails := fails + 1; log := log || E'\nFAIL outsider read relationships';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' or sqlerrm like 'E_NOT_FOUND%' then log := log || E'\nok   outsider: relationships refused'; else fails := fails + 1; log := log || E'\nFAIL outsider relationships error: ' || sqlerrm; end if;
  end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_leads_list(ws, jsonb_build_object('tab', 'all', 'search', 'Client B'), 'activity', 50, 0);
  if (j->>'total')::int = 0 then log := log || E'\nok   client-scoped member: client B lead not listed'; else fails := fails + 1; log := log || E'\nFAIL client scope list: ' || (j->>'total'); end if;
  begin
    j := outreach_lead_relationships(l_clb);
    fails := fails + 1; log := log || E'\nFAIL client-scoped member read client B relationships';
  exception when others then
    if sqlerrm like 'E_NOT_FOUND%' then log := log || E'\nok   client-scoped member: client B relationships E_NOT_FOUND'; else fails := fails + 1; log := log || E'\nFAIL client scope relationships error: ' || sqlerrm; end if;
  end;
  begin
    n := outreach_lead_hide(ws, array[l_csv], true);
    fails := fails + 1; log := log || E'\nFAIL member could hide';
  exception when others then
    if sqlerrm like 'E_FORBIDDEN%' then log := log || E'\nok   hide needs a manager'; else fails := fails + 1; log := log || E'\nFAIL hide gate error: ' || sqlerrm; end if;
  end;
  select count(*) into n from outreach_lead_summary where lead_id = l_clb;
  if n = 0 then log := log || E'\nok   RLS: client B summary row invisible to the client-A member'; else fails := fails + 1; log := log || E'\nFAIL summary RLS'; end if;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);

  -- ============================================================ 11. enrichment order + wait reasons (PRD D9)
  insert into outreach_enrich_queue(lead_id, workspace_id, reason, created_at) values (l_inbox, ws, 'manual', now() - interval '3 hours');
  update outreach_leads set prospect_since = null where id = l_inbox;   -- back to an inbox contact for this check
  insert into outreach_enrich_queue(lead_id, workspace_id, reason, created_at) values (l_csv, ws, 'manual', now() - interval '2 hours');
  insert into outreach_enrich_queue(lead_id, workspace_id, reason, created_at) values (l_page, ws, 'manual', now() - interval '4 hours');
  update outreach_leads set hidden_at = now(), hidden_reason = 'company_page', prospect_since = null where id = l_page;
  update outreach_leads set enrich_status = 'waiting' where id in (l_inbox, l_csv, l_page);
  select array_agg(q.lead_id order by q.ord) into ids from (select x.lead_id, row_number() over () as ord from outreach_enrich_next(s_li_a, 10) x) q;
  if ids = array[l_csv, l_inbox] then log := log || E'\nok   enrich order: prospect before inbox contact, hidden company page never'; else fails := fails + 1; log := log || E'\nFAIL enrich order: ' || coalesce(ids::text, 'null'); end if;
  j := outreach_enrich_wait_reason_refresh();
  if (select enrich_wait_reason->>'kind' from outreach_leads where id = l_csv) in ('queue','budget','no_sender') and (select enrich_wait_reason->>'position' from outreach_leads where id = l_csv) is distinct from '2'
    then log := log || E'\nok   wait reason written (' || (select enrich_wait_reason::text from outreach_leads where id = l_csv) || ')'; else fails := fails + 1; log := log || E'\nFAIL wait reason: ' || coalesce((select enrich_wait_reason::text from outreach_leads where id = l_csv), 'null'); end if;
  select count(*) into n from outreach_enrich_queue where lead_id = l_page;
  if n = 0 and (select enrich_status from outreach_leads where id = l_page) = 'none' then log := log || E'\nok   a hidden company page left the enrichment queue'; else fails := fails + 1; log := log || E'\nFAIL hidden still queued'; end if;

  -- ============================================================ 12. inbox: counterpart kind follows the lead
  update outreach_leads set kind = 'automated' where id = l_bounce;
  -- (F2 writes counterpart_kind on chats; the backfill copied it once. The column exists with its check.)
  begin
    update outreach_chats set counterpart_kind = 'robot' where id = c1;
    fails := fails + 1; log := log || E'\nFAIL counterpart_kind check missing';
  exception when check_violation then log := log || E'\nok   counterpart_kind is checked';
  end;

  -- ============================================================ 13. grants
  select count(*) into n from information_schema.role_routine_grants where routine_name in ('outreach_leads_totals','outreach_leads_by_account','outreach_lead_relationships','outreach_leads_list','outreach_lead_promote','outreach_lead_hide') and grantee = 'authenticated' and privilege_type = 'EXECUTE';
  if n = 6 then log := log || E'\nok   the six user RPCs are granted to authenticated'; else fails := fails + 1; log := log || E'\nFAIL user grants: ' || n; end if;
  select count(*) into n from information_schema.role_routine_grants where routine_name in ('outreach_lead_summary_refresh','outreach_lead_summary_process','outreach_lead_summary_reconcile','outreach__leads_matching','outreach_inbound_kind','outreach_enrich_wait_reason_refresh','outreach_lead_summary_enqueue') and grantee in ('authenticated','anon','PUBLIC') and privilege_type = 'EXECUTE';
  if n = 0 then log := log || E'\nok   service functions are not callable by users'; else fails := fails + 1; log := log || E'\nFAIL service grants leaked: ' || n; end if;
  if exists (select 1 from outreach_cron_jobs where name = 'lead-summary' and fn = 'outreach-worker-lead-summary' and active) and outreach_cron_has_work('lead-summary') is not null
    then log := log || E'\nok   dispatcher row + guard present'; else fails := fails + 1; log := log || E'\nFAIL dispatcher row'; end if;
  if exists (select 1 from cron.job where jobname = 'outreach-lead-summary-reconcile') then log := log || E'\nok   nightly reconcile scheduled'; else fails := fails + 1; log := log || E'\nFAIL reconcile job'; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
