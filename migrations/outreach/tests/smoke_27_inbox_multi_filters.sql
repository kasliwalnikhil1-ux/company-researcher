-- Smoke test — 093 inbox multi filters. Builds fixtures, asserts, then RAISES so everything rolls back. Ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_27_inbox_multi_filters.sql
do $$
declare
  log text := ''; fails int := 0; n int;
  ws uuid; u_owner uuid; s_li uuid; s_wa uuid; s_gm uuid; l1 uuid; c_li uuid; c_wa uuid; c_gm uuid; r jsonb;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;

  insert into outreach_workspaces(name, slug, created_by) values ('smoke27', 'smoke27-' || encode(gen_random_bytes(4),'hex'), u_owner) returning id into ws;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner27@test.local', 'Naman');
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'LINKEDIN', 'LI', 'ok', 's27-li-' || ws) returning id into s_li;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'WHATSAPP', 'WA', 'ok', 's27-wa-' || ws) returning id into s_wa;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'GMAIL', 'GM', 'ok', 's27-gm-' || ws) returning id into s_gm;
  insert into outreach_leads(workspace_id, full_name) values (ws, 'Lead 27') returning id into l1;
  -- three conversations waiting on us, one per sender / channel
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_li, l1, 'c27-li-' || ws, 'LINKEDIN', 'A') returning id into c_li;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_wa, l1, 'c27-wa-' || ws, 'WHATSAPP', 'B') returning id into c_wa;
  insert into outreach_chats(workspace_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, s_gm, l1, 'c27-gm-' || ws, 'GMAIL', 'C') returning id into c_gm;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at) values
    (ws, c_li, 'in', 'hi', now() - interval '3 days'), (ws, c_wa, 'in', 'hi', now() - interval '2 days'), (ws, c_gm, 'in', 'hi', now() - interval '1 day');

  -- act as the owner (the RPC checks membership)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';

  r := outreach_inbox_counts(ws, '{}'::jsonb);
  if (r ->> 'needs_reply')::int = 3 then log := log || E'ok  no filter: 3 need a reply\n'; else fails := fails + 1; log := log || 'FAIL no filter: ' || r::text || E'\n'; end if;

  r := outreach_inbox_counts(ws, jsonb_build_object('sender_ids', jsonb_build_array(s_li, s_wa)));
  if (r ->> 'needs_reply')::int = 2 then log := log || E'ok  two senders: 2\n'; else fails := fails + 1; log := log || 'FAIL two senders: ' || r::text || E'\n'; end if;

  r := outreach_inbox_counts(ws, jsonb_build_object('sender_id', s_gm));
  if (r ->> 'needs_reply')::int = 1 then log := log || E'ok  single sender_id still works: 1\n'; else fails := fails + 1; log := log || 'FAIL single sender_id: ' || r::text || E'\n'; end if;

  r := outreach_inbox_counts(ws, jsonb_build_object('providers', jsonb_build_array('WHATSAPP', 'GMAIL')));
  if (r ->> 'needs_reply')::int = 2 then log := log || E'ok  two channels: 2\n'; else fails := fails + 1; log := log || 'FAIL two channels: ' || r::text || E'\n'; end if;

  r := outreach_inbox_counts(ws, jsonb_build_object('sender_ids', '[]'::jsonb, 'providers', '[]'::jsonb));
  if (r ->> 'needs_reply')::int = 3 then log := log || E'ok  empty lists mean every sender / channel: 3\n'; else fails := fails + 1; log := log || 'FAIL empty lists: ' || r::text || E'\n'; end if;

  r := outreach_inbox_counts(ws, jsonb_build_object('sender_ids', jsonb_build_array(s_li), 'providers', jsonb_build_array('WHATSAPP')));
  if (r ->> 'needs_reply')::int = 0 then log := log || E'ok  sender and channel combine with AND: 0\n'; else fails := fails + 1; log := log || 'FAIL combined: ' || r::text || E'\n'; end if;

  begin
    r := outreach_inbox_counts(ws, '{"sender_ids": ["not-a-uuid"]}'::jsonb);
    fails := fails + 1; log := log || E'FAIL bad id accepted\n';
  exception when others then
    if sqlerrm like 'E_PAYLOAD_INVALID%' then log := log || E'ok  bad id -> E_PAYLOAD_INVALID\n'; else fails := fails + 1; log := log || 'FAIL bad id: ' || sqlerrm || E'\n'; end if;
  end;

  -- the reply-date index exists and is partial on replied, open conversations
  select count(*) into n from pg_indexes where tablename = 'outreach_chats' and indexname = 'outreach_chats_last_inbound_idx' and indexdef ilike '%last_inbound_at IS NOT NULL%';
  if n = 1 then log := log || E'ok  outreach_chats_last_inbound_idx present\n'; else fails := fails + 1; log := log || E'FAIL index missing\n'; end if;

  if fails = 0 then raise exception E'%\nSMOKE OK', log; else raise exception E'%\nSMOKE FAIL (% failures)', log, fails; end if;
end $$;
