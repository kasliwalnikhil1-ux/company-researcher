-- Smoke test — 076 reply alerts (reply-notifications-PRD.md §13, the SQL half). Builds fixtures, asserts, then RAISES so
-- everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_21_reply_alerts.sql
-- The alert triggers are DEFERRED (they run at commit); the test switches them to IMMEDIATE so each statement fires them,
-- and back to DEFERRED for the website-chat handoff case, which depends on the final state of a transaction.
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; n int; b boolean; r record;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid; s1 uuid; s2 uuid; swc uuid; wci uuid; vis uuid; vis2 uuid;
  l1 uuid; l2 uuid; c1 uuid; c2 uuid; c3 uuid; c4 uuid; cw1 uuid; cw2 uuid; m uuid; m2 uuid; nid uuid; sub uuid; viewer_feature boolean;
  dow int;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;
  execute 'set constraints outreach_messages_zz_alert, outreach_chats_zz_alert immediate';

  insert into outreach_workspaces(name, slug, created_by) values ('smoke21', 'smoke21-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner21@test.local', 'Naman');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member21@test.local', 'Ravi', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer21@test.local', 'Karin', array[ca]);
  viewer_feature := outreach_has_feature(ws, 'client_viewer');
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email, created_at)
    values (ws, ca, 'LINKEDIN', 'Naman LI', 'ok', 's21a-' || ws, 'owner21@test.local', now() - interval '30 days') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email, created_at)
    values (ws, cb, 'LINKEDIN', 'Ravi LI', 'ok', 's21b-' || ws, 'member21@test.local', now() - interval '30 days') returning id into s2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'priya21-' || left(ws::text, 8), 'Priya Nair', 'Razorpay') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, cb, 'ben21-' || left(ws::text, 8), 'Ben Roe', null) returning id into l2;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, ca, s1, l1, 'c21-1-' || ws, 'LINKEDIN', 'Priya Nair') returning id into c1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, cb, s2, l2, 'c21-2-' || ws, 'LINKEDIN', 'Ben Roe') returning id into c2;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name) values (ws, ca, s1, 'c21-3-' || ws, 'LINKEDIN', 'Asha Rao') returning id into c3;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name) values (ws, ca, s1, 'c21-4-' || ws, 'LINKEDIN', 'Omar Haddad') returning id into c4;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-0-' || ws, 'out', 'Hi Priya', now() - interval '1 day');

  -- ============================================================ 1. a reply: who is alerted, what the row says
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c1, 'm21-1-' || ws, 'in', 'Sure, happy to chat next week.   What did you have in mind?', now() - interval '20 seconds') returning id into m;
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c1 and kind = 'reply_new' and read_at is null;
  if r.id is not null and r.count = 1 and r.message_id = m and r.title = 'Priya Nair · Razorpay' and r.body = 'Sure, happy to chat next week. What did you have in mind?'
     and r.data->>'channel' = 'LinkedIn' and r.data->>'to' = 'Naman LI' and r.alert_desktop and not r.alert_sound and not r.alert_muted and r.alerted_at = now()
    then log := log || E'\nok   reply: one row for the owner — title, one-line text, channel, sender; desktop on, sound off until turned on (D2)';
    else fails := fails + 1; log := log || E'\nFAIL reply row: ' || coalesce(row_to_json(r)::text, 'none'); end if;
  if not exists (select 1 from outreach_notifications where user_id = u_member and chat_id = c1)
    then log := log || E'\nok   a member outside the client''s scope is not alerted';
    else fails := fails + 1; log := log || E'\nFAIL member outside the client scope was alerted'; end if;
  if exists (select 1 from outreach_notifications where user_id = u_viewer and chat_id = c1) = viewer_feature
    then log := log || E'\nok   the client viewer of that client is alerted exactly when client access is on the plan (' || viewer_feature || ')';
    else fails := fails + 1; log := log || E'\nFAIL client viewer alert vs feature ' || viewer_feature; end if;

  -- ============================================================ 2. merging (D4) and the 30-second re-alert
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-2-' || ws, 'in', 'Thursday works', now() - interval '10 seconds') returning id into m2;
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c1 and kind = 'reply_new' and read_at is null;
  if (select count(*) from outreach_notifications where user_id = u_owner and chat_id = c1 and kind = 'reply_new') = 1 and r.count = 2 and r.message_id = m2 and r.body = 'Thursday works'
    then log := log || E'\nok   a second message updates the same open alert (count 2, latest text)';
    else fails := fails + 1; log := log || E'\nFAIL merge: ' || coalesce(row_to_json(r)::text, 'none'); end if;
  update outreach_notifications set alerted_at = now() - interval '1 minute', alert_desktop = false where id = r.id;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-3-' || ws, 'in', 'Or Friday', now()) returning id into m;
  select * into r from outreach_notifications where id = r.id;
  if r.count = 3 and r.alerted_at = now() and r.alert_desktop
    then log := log || E'\nok   more than 30 s after the last alert, a merged message alerts again';
    else fails := fails + 1; log := log || E'\nFAIL re-alert: ' || row_to_json(r)::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-4-' || ws, 'in', 'Either is fine', now());
  if (select alerted_at = now() and count = 4 from outreach_notifications where id = r.id)
    then log := log || E'\nok   within 30 s a merged message updates silently (alerted_at unchanged)';
    else fails := fails + 1; log := log || E'\nFAIL silent merge'; end if;

  -- ============================================================ 3. our message clears every open reply alert on the conversation
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, origin) values (ws, c1, 'm21-5-' || ws, 'out', 'Friday 3pm then', now(), 'external_device');
  if not exists (select 1 from outreach_notifications where chat_id = c1 and kind = 'reply_new' and read_at is null)
    then log := log || E'\nok   our reply (any device) marks the open reply alerts read for everyone';
    else fails := fails + 1; log := log || E'\nFAIL our reply did not clear the alert'; end if;

  -- ============================================================ 4. what never alerts
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c3, 'm21-6-' || ws, 'in', 'old history', now() - interval '2 hours');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, intent) values (ws, c3, 'm21-7-' || ws, 'in', 'I am out of office', now(), 'ooo');
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, event_type) values (ws, c3, 'm21-8-' || ws, 'in', null, now(), 1);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c3, 'm21-9-' || ws, 'out', 'our own', now());
  if not exists (select 1 from outreach_notifications where chat_id = c3)
    then log := log || E'\nok   no alert for: a message older than 10 minutes, an out-of-office, a system event, our own message';
    else fails := fails + 1; log := log || E'\nFAIL something alerted on c3: ' || (select string_agg(kind || ':' || coalesce(body, ''), ', ') from outreach_notifications where chat_id = c3); end if;
  -- reclassified as out-of-office later: the alert is taken back
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c4, 'm21-10-' || ws, 'in', 'Away until Monday', now()) returning id into m;
  b := exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c4 and read_at is null);
  update outreach_messages set intent = 'ooo' where id = m;
  if b and not exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c4 and read_at is null)
    then log := log || E'\nok   a reply reclassified as out-of-office takes its alert back';
    else fails := fails + 1; log := log || E'\nFAIL ooo retract (before=' || b || ')'; end if;

  -- ============================================================ 5. scope: mine / unassigned / assignment alerts
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_settings_save(ws, '{"scope":"mine"}');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm21-11-' || ws, 'in', 'Hello?', now());
  if j->>'scope' = 'mine' and not exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c2)
     and exists (select 1 from outreach_notifications where user_id = u_member and chat_id = c2 and kind = 'reply_new')
    then log := log || E'\nok   scope "mine": the owner is not alerted about an unassigned chat on someone else''s sender; the sender''s owner is';
    else fails := fails + 1; log := log || E'\nFAIL scope mine: ' || j::text; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c4, 'm21-12-' || ws, 'in', 'Back early', now());
  if exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c4 and read_at is null)
    then log := log || E'\nok   scope "mine": unassigned on a sender I own (owner matched by email) still alerts';
    else fails := fails + 1; log := log || E'\nFAIL scope mine own sender'; end if;
  -- the member assigns c2 to the owner → "Ravi assigned you …"
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  update outreach_chats set assigned_to = u_owner where id = c2;
  perform set_config('request.jwt.claims', '', true);
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c2 and kind = 'assigned';
  if r.id is not null and r.title = 'Ravi assigned you Ben Roe' and r.actor_id = u_member and r.body = 'Hello?' and not r.alert_sound
    then log := log || E'\nok   assignment by a teammate: "Ravi assigned you Ben Roe", sound off by default for this kind';
    else fails := fails + 1; log := log || E'\nFAIL assigned alert: ' || coalesce(row_to_json(r)::text, 'none'); end if;
  -- (one transaction here; in the product the assignment and a later reply are separate transactions)
  update outreach_notifications set created_at = now() - interval '1 minute', updated_at = now() - interval '1 minute' where id = r.id;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm21-13-' || ws, 'in', 'Still there?', now());
  if exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c2 and kind = 'reply_new')
    then log := log || E'\nok   scope "mine": a reply in a conversation assigned to me alerts';
    else fails := fails + 1; log := log || E'\nFAIL scope mine assigned reply'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  update outreach_chats set assigned_to = u_owner where id = c4;
  perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = c4 and kind = 'assigned')
    then log := log || E'\nok   assigning yourself does not alert';
    else fails := fails + 1; log := log || E'\nFAIL self-assign alerted'; end if;

  -- ============================================================ 6. AI answering, pause, quiet hours, sound, per-kind ticks
  update outreach_chats set ai_run_status = 'scheduled' where id = c3;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c3, 'm21-14-' || ws, 'in', 'Sounds good', now());
  b := not exists (select 1 from outreach_notifications where chat_id = c3 and read_at is null);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_settings_save(ws, '{"scope":"mine_unassigned","include_ai_handled":true,"sound_enabled":true}');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c3, 'm21-15-' || ws, 'in', 'One more thing', now());
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c3 and read_at is null;
  if b and r.id is not null and r.alert_sound and r.alert_desktop
    then log := log || E'\nok   the AI answering: no alert by default; "also when the AI is handling" alerts, with sound once sound is on';
    else fails := fails + 1; log := log || E'\nFAIL ai-handled (default silent=' || b || '): ' || coalesce(row_to_json(r)::text, 'none'); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_settings_save(ws, '{"paused_until":"infinity"}');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_chats set ai_run_status = null where id = c3;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-16-' || ws, 'in', 'Ping', now());
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c1 and read_at is null;
  if j->>'paused_until' = 'infinity' and (j->>'muted')::boolean and r.id is not null and r.alert_muted and not r.alert_desktop and not r.alert_sound
    then log := log || E'\nok   paused: the bell still collects, nothing sounds or shows (muted)';
    else fails := fails + 1; log := log || E'\nFAIL paused: ' || j::text || ' / ' || coalesce(row_to_json(r)::text, 'none'); end if;

  dow := extract(isodow from now() at time zone 'UTC')::int;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_settings_save(ws, jsonb_build_object('paused_until', null, 'quiet_hours', jsonb_build_object('days', jsonb_build_array(case when dow = 7 then 1 else dow + 1 end), 'start', '09:00', 'end', '19:00', 'tz', 'UTC')));
  b := (j->>'muted')::boolean;
  j := outreach_alert_settings_save(ws, jsonb_build_object('quiet_hours', jsonb_build_object('days', jsonb_build_array(1,2,3,4,5,6,7), 'start', '00:00', 'end', '00:00', 'tz', 'Asia/Kolkata')));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if b and not (j->>'muted')::boolean and j#>>'{quiet_hours,tz}' = 'Asia/Kolkata'
    then log := log || E'\nok   quiet hours: outside the chosen days is muted; an all-day window on every day is not';
    else fails := fails + 1; log := log || E'\nFAIL quiet hours: muted-outside=' || b || ' ' || j::text; end if;
  if outreach__alert_window_open('{"days":[1,2,3,4,5,6,7],"start":"22:00","end":"07:00","tz":"UTC"}', date_trunc('day', now()) + interval '23 hours')
     and outreach__alert_window_open('{"days":[1,2,3,4,5,6,7],"start":"22:00","end":"07:00","tz":"UTC"}', date_trunc('day', now()) + interval '3 hours')
     and not outreach__alert_window_open('{"days":[1,2,3,4,5,6,7],"start":"22:00","end":"07:00","tz":"UTC"}', date_trunc('day', now()) + interval '12 hours')
     and outreach__alert_window_open('{"start":"09:00","end":"19:00","tz":"No/Such_Zone"}', now())
    then log := log || E'\nok   overnight windows wrap midnight; an unknown time zone never silences anyone';
    else fails := fails + 1; log := log || E'\nFAIL window maths'; end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_pref_set(ws, 'reply_new', false, null);
  b := (j#>>'{kinds,reply_new,desktop}')::boolean is false and (j#>>'{kinds,reply_new,sound}')::boolean and (j#>>'{kinds,assigned,sound}')::boolean is false;
  n := outreach_alerts_mark_chat_read(c1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm21-17-' || ws, 'in', 'Pong', now());
  select * into r from outreach_notifications where user_id = u_owner and chat_id = c1 and read_at is null;
  if b and n = 1 and r.id is not null and not r.alert_desktop and r.alert_sound and r.count = 1
    then log := log || E'\nok   per-kind ticks: Desktop off for replies keeps the sound; opening the chat read the old alert, a new one starts at 1';
    else fails := fails + 1; log := log || E'\nFAIL pref/read: b=' || b || ' n=' || n || ' ' || coalesce(row_to_json(r)::text, 'none'); end if;

  -- ============================================================ 7. AI handoff note → "AI handed … to you"
  j := outreach__note_system_create(c4, 'over to you — meeting confirmed.', 'ai', array[u_owner], 'team');
  select * into r from outreach_notifications where user_id = u_owner and note_id = (j->>'id')::uuid;
  if r.kind = 'ai_handoff' and r.title = 'AI handed Omar Haddad to you' and r.data->>'channel' = 'LinkedIn'
    then log := log || E'\nok   the AI handoff note alerts as ai_handoff ("AI handed Omar Haddad to you"), with display parts';
    else fails := fails + 1; log := log || E'\nFAIL handoff note alert: ' || coalesce(row_to_json(r)::text, 'none'); end if;

  -- ============================================================ 8. website chat: AI answering → silent; handed off → handoff alert only
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_alert_settings_save(ws, '{"include_ai_handled":false}');   -- section 6 opted in
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, owner_email, created_at)
    values (ws, ca, 'WEBCHAT', 'Site', 'ok', 'owner21@test.local', now() - interval '30 days') returning id into swc;
  insert into outreach_webchat_inboxes(workspace_id, sender_id, name, website_token, hmac_token) values (ws, swc, 'Acme site', 'wt21-' || ws, 'hm21-' || ws) returning id into wci;
  insert into outreach_webchat_visitors(workspace_id, inbox_id, name) values (ws, wci, null) returning id into vis;
  insert into outreach_webchat_visitors(workspace_id, inbox_id, name) values (ws, wci, 'Lena') returning id into vis2;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, webchat_inbox_id, visitor_id, ai_mode, status)
    values (ws, ca, swc, 'c21-w1-' || ws, 'WEBCHAT', 'Visitor', wci, vis, 'first', 'open') returning id into cw1;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, webchat_inbox_id, visitor_id, ai_mode, status)
    values (ws, ca, swc, 'c21-w2-' || ws, 'WEBCHAT', 'Visitor', wci, vis2, 'off', 'open') returning id into cw2;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, sender_type, source) values (ws, cw1, 'in', 'Do you ship to Berlin?', now(), 'visitor', 'webchat');
  b := not exists (select 1 from outreach_notifications where chat_id = cw1);
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, sender_type, source) values (ws, cw2, 'in', 'Pricing please', now(), 'visitor', 'webchat');
  select * into r from outreach_notifications where user_id = u_member and chat_id = cw2;
  if b and (select kind = 'webchat_message' and title = 'Lena · Acme site' and data->>'channel' = 'Website chat' and data->>'to' is null
              from outreach_notifications where user_id = u_owner and chat_id = cw2) and r.id is null
    then log := log || E'\nok   website chat: the assistant answering is silent; with it off the visitor''s message alerts ("Lena · Acme site")';
    else fails := fails + 1; log := log || E'\nFAIL webchat message (ai silent=' || b || ')'; end if;
  -- handed off and auto-assigned in ONE transaction: only the handoff alert, decided at "commit" with the final state
  execute 'set constraints outreach_messages_zz_alert, outreach_chats_zz_alert deferred';
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, sender_type, source) values (ws, cw1, 'in', 'Can I talk to a person?', now(), 'visitor', 'webchat');
  update outreach_chats set handed_off_at = now(), handoff_reason = 'asked' where id = cw1;
  update outreach_chats set assigned_to = u_owner where id = cw1;
  execute 'set constraints outreach_messages_zz_alert, outreach_chats_zz_alert immediate';
  if (select count(*) from outreach_notifications where chat_id = cw1) = 1
     and exists (select 1 from outreach_notifications where user_id = u_owner and chat_id = cw1 and kind = 'ai_handoff' and title = 'AI handed Website visitor · Acme site to you' and body = 'Can I talk to a person?')
    then log := log || E'\nok   handoff + auto-assign in one transaction: one "AI handed … to you" alert, no message or assignment alert';
    else fails := fails + 1; log := log || E'\nFAIL webchat handoff: ' || coalesce((select string_agg(kind || '/' || title, ', ') from outreach_notifications where chat_id = cw1), 'none'); end if;

  -- ============================================================ 9. Web Push: subscribe, queue, claim, gone
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_alert_pref_set(ws, 'reply_new', true, null);
  perform outreach_alerts_mark_chat_read(c4);
  perform outreach_alerts_mark_chat_read(c2);
  j := outreach_push_subscribe('https://fcm.googleapis.com/fcm/send/smoke21-' || ws, 'BKz' || repeat('a', 84), 'abcdefghijklmnopqrstuv', 'Chrome on Windows');
  sub := (j->>'id')::uuid;
  b := false;
  begin
    perform outreach_push_subscribe('https://169.254.169.254/latest', 'BKz' || repeat('a', 84), 'abcdefghijklmnopqrstuv', 'evil');
  exception when others then b := sqlerrm like 'E_PAYLOAD_INVALID%';
  end;
  n := jsonb_array_length(outreach_push_subscriptions_list());
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if sub is not null and b and n = 1 then log := log || E'\nok   push subscribe saves this browser; a non-push-service address is refused';
  else fails := fails + 1; log := log || E'\nFAIL push subscribe: ' || coalesce(j::text, 'null') || ' refused=' || b || ' n=' || n; end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c4, 'm21-18-' || ws, 'in', 'Push me', now());
  select id into nid from outreach_notifications where user_id = u_owner and chat_id = c4 and kind = 'reply_new' and read_at is null;
  if exists (select 1 from outreach_push_queue q where q.notification_id = nid)
    then log := log || E'\nok   a desktop alert for someone with a saved browser is queued for F47';
    else fails := fails + 1; log := log || E'\nFAIL push not queued (nid ' || coalesce(nid::text, 'null') || ')'; end if;
  j := outreach_push_claim(500);
  select x into j from jsonb_array_elements(j) x where x#>>'{payload,id}' = nid::text;
  if j is not null and j#>>'{payload,title}' = 'Omar Haddad' and j#>>'{payload,text}' = 'Push me' and j#>>'{payload,channel}' = 'LinkedIn'
     and jsonb_array_length(j->'subs') = 1 and j->>'topic' = replace(c4::text, '-', '')
    then log := log || E'\nok   claim returns the payload (title, text, channel), the browser keys and a 32-char topic (collapse key)';
    else fails := fails + 1; log := log || E'\nFAIL claim: ' || coalesce(j::text, 'missing'); end if;
  perform outreach_push_result(jsonb_build_array(jsonb_build_object('queue_id', (j->>'queue_id')::bigint, 'done', true, 'gone', jsonb_build_array(sub))));
  if not exists (select 1 from outreach_push_subscriptions where id = sub) and not exists (select 1 from outreach_push_queue where notification_id = nid)
    then log := log || E'\nok   a "gone" answer deletes the browser; a done push leaves the queue';
    else fails := fails + 1; log := log || E'\nFAIL push result'; end if;
  -- read before sending → dropped
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_push_subscribe('https://updates.push.services.mozilla.com/wpush/v2/smoke21-' || ws, 'BKz' || repeat('b', 84), 'abcdefghijklmnopqrstuw', 'Firefox on Mac');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm21-19-' || ws, 'in', 'Read me first', now());
  select id into nid from outreach_notifications where user_id = u_owner and chat_id = c2 and kind = 'reply_new' and read_at is null;
  b := exists (select 1 from outreach_push_queue where notification_id = nid);
  update outreach_notifications set read_at = now() where id = nid;
  j := outreach_push_claim(500);
  if b and not exists (select 1 from jsonb_array_elements(j) x where x#>>'{payload,id}' = nid::text) and not exists (select 1 from outreach_push_queue where notification_id = nid)
    then log := log || E'\nok   an alert read before sending is never pushed';
    else fails := fails + 1; log := log || E'\nFAIL read-before-send (queued=' || b || ')'; end if;

  -- ============================================================ 10. validation, privacy, permissions
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  n := 0;
  begin perform outreach_alert_settings_save(ws, '{"scope":"everyone"}'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_alert_settings_save(ws, '{"quiet_hours":{"start":"9am","end":"19:00","tz":"UTC"}}'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_alert_settings_save(ws, '{"quiet_hours":{"start":"09:00","end":"19:00","tz":"Mars/Olympus"}}'); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_alert_settings_save(ws, jsonb_build_object('paused_until', now() + interval '60 days')); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  begin perform outreach_alert_pref_set(ws, 'everything', true, true); exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; end if; end;
  j := outreach_alert_settings_save(ws, '{"prompt":"dismissed"}');
  b := (j->>'prompt_dismiss_count')::int = 1 and j->>'prompt_dismissed_at' is not null;
  t := (select count(*)::text from outreach_notification_settings) || '/' || (select count(*)::text from outreach_notifications where user_id <> u_owner) || '/' || (select count(*)::text from outreach_push_subscriptions where user_id <> u_owner);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 5 and b then log := log || E'\nok   bad scope / time / time zone / long pause / kind are refused; Not now is counted';
  else fails := fails + 1; log := log || E'\nFAIL validation n=' || n || ' prompt=' || b; end if;
  if t = '1/0/0' then log := log || E'\nok   row security: a person reads only their own settings, alerts and browsers';
  else fails := fails + 1; log := log || E'\nFAIL rls ' || t; end if;
  select string_agg(p.proname, ', ') into t from pg_proc p where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')
     and p.proname in ('outreach_alert_on_message', 'outreach_alert_on_chat_change', 'outreach_alert_flags', 'outreach_push_claim', 'outreach_push_result', 'outreach_push_vapid',
                       'outreach_push_vapid_init', 'outreach_alerts_cleanup', 'outreach__alert_can_read', 'outreach__push_kick');
  if t is null then log := log || E'\nok   internal alert and push functions are not callable by signed-in users';
  else fails := fails + 1; log := log || E'\nFAIL callable by authenticated: ' || t; end if;
  b := false;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_alert_settings_get(gen_random_uuid()); exception when others then b := sqlerrm like 'E_FORBIDDEN%'; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if b then log := log || E'\nok   settings of a workspace you are not in: E_FORBIDDEN';
  else fails := fails + 1; log := log || E'\nFAIL non-member settings'; end if;

  if fails > 0 then raise exception 'SMOKE FAIL (% failed)%', fails, log; end if;
  raise exception 'SMOKE OK%', log;
end $$;
