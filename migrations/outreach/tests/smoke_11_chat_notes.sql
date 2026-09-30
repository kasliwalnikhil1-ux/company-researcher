-- Smoke test — 046 private notes (private-notes-PRD.md). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_11_chat_notes.sql
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; b boolean;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid; s1 uuid; s2 uuid; l1 uuid; l2 uuid; c1 uuid; c2 uuid;
  n1 uuid; n2 uuid; n3 uuid; n4 uuid; n5 uuid; nid uuid; lm timestamptz; un boolean; uc int; m_in uuid;
  tok_member text; tok_viewer text; tok_owner text; tok_ghost text;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke11', 'smoke11-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner11@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member11@test.local', 'Naman', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer11@test.local', 'Ravi', array[ca]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Sender A', 'ok', 's11a-' || ws, 'owner11@test.local') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, owner_email)
    values (ws, cb, 'LINKEDIN', 'Sender B', 'ok', 's11b-' || ws, 'owner11@test.local') returning id into s2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'priya11-' || left(ws::text, 8), 'Priya Nair', 'Razorpay') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, cb, 'ben11-' || left(ws::text, 8), 'Ben Roe', 'Acme') returning id into l2;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name, last_message_at, unread, unread_count)
    values (ws, ca, s1, l1, 'c11-1-' || ws, 'LINKEDIN', 'Priya Nair', now() - interval '2 hours', false, 0) returning id into c1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name, last_message_at, unread, unread_count)
    values (ws, cb, s2, l2, 'c11-2-' || ws, 'LINKEDIN', 'Ben Roe', now() - interval '3 hours', true, 2) returning id into c2;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at)
    values (ws, c2, 'm11-in-' || ws, 'in', 'Sounds interesting, what would 3 films cost?', now() - interval '3 hours') returning id into m_in;
  select last_message_at, unread, unread_count into lm, un, uc from outreach_chats where id = c2;

  tok_member := '@[Naman](user:' || u_member::text || ')';
  tok_viewer := '@[Ravi](user:' || u_viewer::text || ')';
  tok_owner  := '@[Aarushi](user:' || u_owner::text || ')';
  tok_ghost  := '@[Ghost](user:' || gen_random_uuid()::text || ')';

  -- ============================================================ 1. create (owner on client-B chat), mention filtering
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_create(c2, tok_member || ' she asked for 3 films, can you quote before Friday? ' || tok_viewer || ' ' || tok_owner || ' ' || tok_ghost || ' ' || tok_member, 'team', '[]'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  n1 := (j->>'id')::uuid;
  if n1 is not null and j->>'visibility' = 'team' and j->'author'->>'name' = 'Aarushi' and jsonb_array_length(j->'mentions') = 1 and j->'mentions'->0->>'user_id' = u_member::text
     and jsonb_array_length(j->'dropped_mentions') = 3
     and (select count(*) from outreach_chat_note_mentions where note_id = n1) = 1
     and (select count(*) from outreach_notifications where note_id = n1 and user_id = u_member and kind = 'note_mention') = 1
     and (select count(*) from outreach_notifications where note_id = n1 and user_id in (u_viewer, u_owner)) = 0
    then log := log || E'\nok   note_create: member kept + notified; viewer (scope), self and unknown dropped; duplicate token deduped';
    else fails := fails + 1; log := log || E'\nFAIL note_create: ' || left(j::text, 400); end if;
  if (select title from outreach_notifications where note_id = n1) = 'Aarushi mentioned you in Ben Roe (Acme)'
     and (select body from outreach_notifications where note_id = n1) like '@Naman she asked for 3 films%'
    then log := log || E'\nok   notification text: "<author> mentioned you in <lead> (<company>)" + plain snippet';
    else fails := fails + 1; log := log || E'\nFAIL notification text: ' || coalesce((select title || ' | ' || body from outreach_notifications where note_id = n1), 'none'); end if;
  if (select r.reason from jsonb_to_recordset(j->'dropped_mentions') as r(user_id uuid, reason text) where r.user_id = u_viewer) = 'no_access'
     and (select r.reason from jsonb_to_recordset(j->'dropped_mentions') as r(user_id uuid, reason text) where r.user_id = u_owner) = 'self'
    then log := log || E'\nok   dropped reasons: viewer = no_access, author = self';
    else fails := fails + 1; log := log || E'\nFAIL dropped reasons: ' || (j->'dropped_mentions')::text; end if;

  -- ============================================================ 2. metrics untouched, last_note_at set, no message row
  if (select last_message_at from outreach_chats where id = c2) = lm and (select unread from outreach_chats where id = c2) = un and (select unread_count from outreach_chats where id = c2) = uc
     and (select last_note_at from outreach_chats where id = c2) is not null
     and (select count(*) from outreach_messages where chat_id = c2) = 1
    then log := log || E'\nok   a note leaves last_message_at / unread / unread_count / messages untouched and sets last_note_at';
    else fails := fails + 1; log := log || E'\nFAIL metrics touched'; end if;

  -- ============================================================ 3. reads by scope (RPC + RLS)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_notes_list(c2);
  begin k := outreach_notes_list(c1); t := 'read'; exception when others then t := sqlerrm; end;
  select count(*) into n from outreach_chat_notes;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j) = 1 and j->0->>'id' = n1::text and t like 'E_NOT_FOUND%' and n = 1
    then log := log || E'\nok   member (client B): sees the c2 note via RPC and RLS; c1 (client A) is E_NOT_FOUND';
    else fails := fails + 1; log := log || E'\nFAIL member scope: ' || t || ' / ' || n || ' / ' || left(j::text, 200); end if;

  -- viewer (client A): team notes on c1 are invisible; a team_and_client note is visible; cannot write on c2
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_create(c1, 'Team only: budget is 4L ' || tok_viewer, 'team', '[]'::jsonb);
  n2 := (j->>'id')::uuid;
  k := outreach_note_create(c1, tok_viewer || ' is this lead a fit?', 'team_and_client', '[]'::jsonb);
  n3 := (k->>'id')::uuid;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j->'mentions') = 0 and (j->'dropped_mentions'->0->>'reason') = 'no_access' and jsonb_array_length(k->'mentions') = 1
     and (select count(*) from outreach_notifications where user_id = u_viewer) = 1
    then log := log || E'\nok   viewer mentioned on a team note is dropped (no_access); on a team_and_client note it is kept + notified';
    else fails := fails + 1; log := log || E'\nFAIL viewer mention rules: ' || left(j::text, 200) || ' / ' || left(k::text, 200); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  j := outreach_notes_list(c1);
  select count(*) into n from outreach_chat_notes;
  k := outreach_note_create(c1, 'Viewer note, please treat as shared', 'team', '[]'::jsonb);
  n4 := (k->>'id')::uuid;
  begin perform outreach_note_create(c2, 'nope', 'team', '[]'::jsonb); t := 'wrote'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j) = 1 and j->0->>'id' = n3::text and n = 1 and k->>'visibility' = 'team_and_client' and t like 'E_NOT_FOUND%'
    then log := log || E'\nok   viewer: sees only the shared note (RPC + RLS), own note forced to team_and_client, client-B chat is E_NOT_FOUND';
    else fails := fails + 1; log := log || E'\nFAIL viewer scope: ' || jsonb_array_length(j) || ' / ' || n || ' / ' || coalesce(k->>'visibility', '?') || ' / ' || t; end if;
  -- the viewer's mention row and its "seen by" state are visible to the note's readers
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_chat_note_mentions where note_id = n3;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 1 then log := log || E'\nok   mention rows readable by the note''s readers (Seen by)'; else fails := fails + 1; log := log || E'\nFAIL mention rows RLS: ' || n; end if;

  -- ============================================================ 4. update: permissions, revisions, new-mention-only notifications, visibility
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_note_update(n1, 'hijack'); t := 'edited'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' then log := log || E'\nok   a non-author cannot edit a note'; else fails := fails + 1; log := log || E'\nFAIL non-author edit: ' || t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_update(n1, tok_member || ' she asked for 3 films — quote by Thursday please');
  k := outreach_note_revisions(n1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'edited_at' is not null and (j->>'revisions')::int = 1 and jsonb_array_length(k) = 1 and k->0->>'body' like '%can you quote before Friday%'
     and (select count(*) from outreach_notifications where note_id = n1 and user_id = u_member) = 1
    then log := log || E'\nok   edit keeps a revision, sets edited_at, and an unchanged mention is not notified again';
    else fails := fails + 1; log := log || E'\nFAIL edit: ' || left(j::text, 200) || ' / ' || left(k::text, 200) || ' / ' || (select count(*) from outreach_notifications where note_id = n1); end if;
  -- visibility team_and_client → team hides it from the viewer at once
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_update(n3, null, 'team');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_chat_notes where id = n3;
  k := outreach_notes_list(c1);
  begin perform outreach_note_update(n4, null, 'team'); t := 'changed'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'visibility' = 'team' and n = 0 and not exists (select 1 from jsonb_array_elements(k) x where x->>'id' = n3::text) and t like 'E_FORBIDDEN%'
    then log := log || E'\nok   visibility → team hides the note from the client viewer immediately; a viewer cannot hide their own note';
    else fails := fails + 1; log := log || E'\nFAIL visibility change: ' || coalesce(j->>'visibility', '?') || ' / ' || n || ' / ' || t; end if;

  -- ============================================================ 5. delete: permissions + placeholder + mention cleanup
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_note_delete(n1); t := 'deleted'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' then log := log || E'\nok   a member cannot delete someone else''s note'; else fails := fails + 1; log := log || E'\nFAIL member delete: ' || t; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_create(c2, 'to be deleted ' || tok_member, 'team', '[]'::jsonb);
  n5 := (j->>'id')::uuid;
  j := outreach_note_delete(n5);
  k := outreach_notes_list(c2);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if j->>'deleted_at' is not null and j->>'body' is null and j->>'deleted_by' = 'Aarushi'
     and exists (select 1 from jsonb_array_elements(k) x where x->>'id' = n5::text and x->>'deleted_at' is not null and x->>'body' is null)
     and (select count(*) from outreach_chat_note_mentions where note_id = n5) = 0
     and (select read_at from outreach_notifications where note_id = n5) is not null
    then log := log || E'\nok   delete: placeholder (no body) stays in the list, mentions removed, its notification marked read';
    else fails := fails + 1; log := log || E'\nFAIL delete: ' || left(j::text, 300); end if;

  -- ============================================================ 6. mark read, badge, mentions list, notifications list
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_notes_badge(ws);
  k := outreach_mentions_list(ws, false, 50);
  perform outreach_note_mark_read(n1);
  t := (outreach_notes_badge(ws))::text;
  select jsonb_array_length(outreach_notifications_list(ws, 10)) into n;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'unread_mentions')::int = 1 and (j->>'unread_notifications')::int = 1 and jsonb_array_length(k) = 1 and k->0->>'chat_id' = c2::text and k->0->>'read_at' is null
     and k->0->'chat'->>'lead_name' = 'Ben Roe' and (t::jsonb->>'unread_mentions')::int = 0 and (t::jsonb->>'unread_notifications')::int = 0 and n = 2
    then log := log || E'\nok   badge counts, mentions_list row shape, note_mark_read clears both mention + notification';
    else fails := fails + 1; log := log || E'\nFAIL read state: ' || j::text || ' / ' || left(k::text, 300) || ' / ' || t || ' / ' || n; end if;

  -- ============================================================ 7. search + lead timeline
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_notes_search(ws, 'quote Thursday', 10);
  k := outreach_notes_for_lead(l2, 20);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j) = 1 and j->0->>'note_id' = n1::text and j->0->>'snippet' like '%**quote**%' and j->0->'chat'->>'lead_name' = 'Ben Roe'
     and jsonb_array_length(k) = 1 and k->0->>'id' = n1::text and k->0->'chat'->>'provider' = 'LINKEDIN'
    then log := log || E'\nok   notes_search finds the note with a highlighted snippet; notes_for_lead lists live notes with their chat';
    else fails := fails + 1; log := log || E'\nFAIL search/lead: ' || left(j::text, 300) || ' / ' || left(k::text, 200); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  j := outreach_notes_search(ws, 'budget', 10);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j) = 0 then log := log || E'\nok   search never returns a team note to a client viewer'; else fails := fails + 1; log := log || E'\nFAIL viewer search leak: ' || left(j::text, 200); end if;

  -- ============================================================ 8. attachments: path validation, attachment-only body
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_note_create(c2, 'x', 'team', jsonb_build_array(jsonb_build_object('path', ws::text || '/' || c1::text || '/p/deck.pdf', 'name', 'deck.pdf', 'size', 1000))); t := 'created'; exception when others then t := sqlerrm; end;
  j := outreach_note_create(c2, '', 'team', jsonb_build_array(jsonb_build_object('path', ws::text || '/' || c2::text || '/p1/deck.pdf', 'name', 'deck.pdf', 'size', 1000, 'mime', 'application/pdf'),
                                                              jsonb_build_object('path', ws::text || '/' || c2::text || '/p1/shot.png', 'name', 'shot.png', 'size', 2000, 'mime', 'image/png', 'width', 800, 'height', 600)));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_PAYLOAD_INVALID%' and j->>'body' = 'deck.pdf, shot.png' and jsonb_array_length(j->'attachments') = 2 and (j->'attachments'->1->>'width')::int = 800
    then log := log || E'\nok   attachments: a path outside this chat is rejected; an attachment-only note gets the file names as body';
    else fails := fails + 1; log := log || E'\nFAIL attachments: ' || t || ' / ' || left(j::text, 300); end if;
  -- storage readability follows the note
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  b := outreach_note_attachment_readable(ws::text || '/' || c2::text || '/p1/deck.pdf');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  t := outreach_note_attachment_readable(ws::text || '/' || c2::text || '/p1/deck.pdf')::text;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if b and t = 'false' then log := log || E'\nok   attachment readable by a member of the chat, not by a viewer outside its client'; else fails := fails + 1; log := log || E'\nFAIL attachment readability: ' || b || ' / ' || t; end if;

  -- ============================================================ 9. AI context + #no-ai
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_note_create(c2, '#no-ai secret: they are also talking to a competitor', 'team', '[]'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach__team_notes_for_ai(c2, 10);
  if (j->>'exclude_from_ai')::boolean and not exists (select 1 from jsonb_array_elements(k) x where x->>'text' like '%competitor%')
     and exists (select 1 from jsonb_array_elements(k) x where x->>'text' like '@Naman she asked for 3 films%' and x->>'author' = 'Aarushi')
     and not exists (select 1 from jsonb_array_elements(k) x where x->>'text' like 'to be deleted%')
    then log := log || E'\nok   AI context: live notes as plain text with author; #no-ai and deleted notes excluded';
    else fails := fails + 1; log := log || E'\nFAIL ai context: ' || left(k::text, 400); end if;
  select pg_get_functiondef(p.oid) into t from pg_proc p where p.proname = 'outreach_ai_reply_gate_facts';
  if position('team_notes' in t) > 0 then log := log || E'\nok   gate_facts carries team_notes'; else fails := fails + 1; log := log || E'\nFAIL gate_facts not patched'; end if;

  -- ============================================================ 10. AI handoff → system note by "AI" mentioning the assignee
  update outreach_chats set assigned_to = u_member where id = c2;
  j := outreach_ai_handoff(c2, 'calendar_sent', null, null);
  select id into nid from outreach_chat_notes where chat_id = c2 and author_type = 'ai' order by created_at desc limit 1;
  k := outreach__note_json((select n_ from outreach_chat_notes n_ where n_.id = nid));
  if (j->>'ok')::boolean and nid is not null and k->'author'->>'name' = 'AI' and k->'mentions'->0->>'user_id' = u_member::text
     and k->>'body' like '@[Naman](user:%) over to you — calendar link sent.%' and k->>'body' like '%Last from Ben Roe: “Sounds interesting%'
     and (select count(*) from outreach_notifications where note_id = nid and user_id = u_member) = 1
     and (select count(*) from outreach_tasks where chat_id = c2 and kind = 'ai_handoff') = 1
    then log := log || E'\nok   ai_handoff writes an AI note (reason + their last words) mentioning the assignee, next to the task';
    else fails := fails + 1; log := log || E'\nFAIL handoff note: ' || left(k::text, 400); end if;

  -- ============================================================ 11. worker support: due mentions, prefs, purge
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_notification_prefs_set(ws, 'note_mention', true, 30);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_chat_note_mentions set created_at = now() - interval '20 minutes' where note_id = nid and user_id = u_member;
  k := outreach_note_mentions_due(100);
  update outreach_chat_note_mentions set created_at = now() - interval '40 minutes' where note_id = nid and user_id = u_member;
  t := outreach_note_mentions_due(100)::text;
  if (j->'note_mention'->>'email_delay_min')::int = 30 and not exists (select 1 from jsonb_array_elements(k) x where x->>'note_id' = nid::text)
     and exists (select 1 from jsonb_array_elements(t::jsonb) x where x->>'note_id' = nid::text and x->>'email' = 'member11@test.local' and x->>'chat_title' = 'Ben Roe (Acme)')
    then log := log || E'\nok   mentions_due honours the per-user delay (30 min) and carries email + chat title';
    else fails := fails + 1; log := log || E'\nFAIL mentions_due: ' || left(k::text, 200) || ' / ' || left(t, 300); end if;
  n := outreach_note_mentions_mark_emailed(jsonb_build_array(jsonb_build_object('note_id', nid, 'user_id', u_member)));
  if n = 1 and not exists (select 1 from jsonb_array_elements(outreach_note_mentions_due(100)) x where x->>'note_id' = nid::text)
    then log := log || E'\nok   mark_emailed removes the mention from the due list';
    else fails := fails + 1; log := log || E'\nFAIL mark_emailed: ' || n; end if;
  k := outreach_note_email_context(c2, 3);
  if jsonb_array_length(k) = 1 and k->0->>'from' = 'them' then log := log || E'\nok   email context = last messages of the conversation'; else fails := fails + 1; log := log || E'\nFAIL email context: ' || k::text; end if;
  update outreach_chat_notes set deleted_at = now() - interval '31 days' where id = n5;
  k := outreach_notes_purge();
  if (select body from outreach_chat_notes where id = n5) = '(purged)' and (select purged_at from outreach_chat_notes where id = n5) is not null and jsonb_typeof(k) = 'array'
    then log := log || E'\nok   purge: body replaced after 30 days, attachment paths returned for storage cleanup';
    else fails := fails + 1; log := log || E'\nFAIL purge'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  k := outreach_notes_list(c2);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from jsonb_array_elements(k) x where x->>'id' = n5::text) then log := log || E'\nok   purged notes leave the thread'; else fails := fails + 1; log := log || E'\nFAIL purged note still listed'; end if;

  -- ============================================================ 12. grants
  if has_function_privilege('authenticated', 'outreach_note_create(uuid,text,text,jsonb,text)', 'execute')
     and has_function_privilege('authenticated', 'outreach_notes_list(uuid)', 'execute')
     and has_function_privilege('authenticated', 'outreach_note_attachment_readable(text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_note_system_create(uuid,text,text,uuid[],text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach__note_system_create(uuid,text,text,uuid[],text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_note_mentions_due(int)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_notes_purge()', 'execute')
     and not has_function_privilege('authenticated', 'outreach__team_notes_for_ai(uuid,int)', 'execute')
     and not has_function_privilege('anon', 'outreach_note_create(uuid,text,text,jsonb,text)', 'execute')
    then log := log || E'\nok   grants: app RPCs for authenticated only; system / worker / internal functions service-only';
    else fails := fails + 1; log := log || E'\nFAIL grants'; end if;
  -- service-only guard on the wrapper
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  begin perform outreach_note_system_create(c2, 'x', 'system', '{}', 'team'); t := 'wrote'; exception when others then t := sqlerrm; end;
  perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' then log := log || E'\nok   note_system_create refuses a signed-in caller'; else fails := fails + 1; log := log || E'\nFAIL system_create guard: ' || t; end if;

  -- ============================================================ 13. audit log never carries the body
  if not exists (select 1 from outreach_audit_log a where a.workspace_id = ws and a.action like 'note.%' and (a.diff::text ilike '%3 films%' or a.diff::text ilike '%competitor%'))
     and (select count(*) from outreach_audit_log a where a.workspace_id = ws and a.action = 'note.created') >= 5
    then log := log || E'\nok   audit rows for note.* exist and contain no note text';
    else fails := fails + 1; log := log || E'\nFAIL audit body leak'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (private notes)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
