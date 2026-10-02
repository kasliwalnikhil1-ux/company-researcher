-- Smoke test — 048–051 web chat (web-chat-PRD.md). Builds fixtures, asserts, then RAISES so everything rolls back.
-- A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_12_webchat.sql
-- Public functions run as the service role (superuser here → outreach_is_service() is true); user RPCs impersonate members.
do $$
declare
  log text := ''; fails int := 0; j jsonb; k jsonb; n int; b boolean; t text; i int;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid; l1 uuid; ib uuid; ib_sender uuid; tok text; hm text;
  v1 uuid; v2 uuid; c1 uuid; c2 uuid; m1 uuid; m_ai uuid; mb uuid; ce uuid; tid uuid; cid uuid; ver int;
  bh jsonb;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke12', 'smoke12-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner12@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member12@test.local', 'Naman', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer12@test.local', 'Ravi', array[ca]);
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company, email_work) values (ws, ca, 'priya12-' || left(ws::text, 8), 'Priya Nair', 'Razorpay', 'priya12-' || left(ws::text, 8) || '@razorpay.test') returning id into l1;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id, owner_email) values (ws, 'GMAIL', 'Mailbox', 'ok', 's12mb-' || ws, 'mail12@test.local') returning id into mb;

  -- ============================================================ 1. inbox create (owner, client A) + scope
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'Acme Site', array['https://www.Acme.com/', '*.acme.dev'], ca);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  ib := (j->>'id')::uuid; tok := j->>'website_token'; hm := j->>'hmac_token'; ib_sender := (j->>'sender_id')::uuid;
  if ib is not null and length(tok) = 32 and length(hm) = 48 and (j->'allowed_domains') = '["*.acme.dev","https://www.acme.com/"]'::jsonb
     and (select provider from outreach_senders where id = ib_sender) = 'WEBCHAT' and (select status from outreach_senders where id = ib_sender) = 'ok'
     and (j#>>'{settings,appearance,brand_name}') = 'Acme Site' and (j#>>'{settings,launcher,desktop,type}') = 'icon'
     and (select count(*) from outreach_webchat_inbox_members where inbox_id = ib and user_id = u_owner) = 1
    then log := log || E'\nok   inbox_create: synthetic WEBCHAT sender, tokens, defaults merged, creator is a member';
    else fails := fails + 1; log := log || E'\nFAIL inbox_create: ' || left(j::text, 500); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inboxes(ws);
  begin k := outreach_webchat_inbox_get(ib); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if jsonb_array_length(j) = 0 and t like 'E_NOT_FOUND%'
    then log := log || E'\nok   client scope: member limited to client B sees no client-A inbox (list + get)';
    else fails := fails + 1; log := log || E'\nFAIL client scope: ' || left(j::text, 200) || ' / ' || t; end if;

  -- ============================================================ 2. public config + origin checks
  j := outreach_webchat_public_config(tok, 'https://evil.com');
  k := outreach_webchat_public_config(tok, 'https://acme.com');
  b := (outreach_webchat_public_config(tok, 'https://app.acme.dev')->>'ok')::boolean;
  if j->>'error' = 'origin' and (k->>'ok')::boolean and b and (k->'settings'->'security') ? 'turnstile_enabled' and not ((k->'settings'->'security') ? 'rate_limits')
     and (k->>'hmac_token') = hm and (k->'availability'->>'online')::boolean = false and (k->'availability'->>'in_hours')::boolean = true
     and (outreach_webchat_public_config(tok, 'http://localhost:3000')->>'error') = 'origin'
    then log := log || E'\nok   public_config: unknown origin rejected, exact + wildcard allowed, localhost off by default, private settings stripped';
    else fails := fails + 1; log := log || E'\nFAIL public_config: ' || left(j::text, 200) || ' / ' || left(k::text, 300); end if;

  -- ============================================================ 3. business hours (cross midnight, holidays, next open)
  bh := jsonb_build_object('tz', 'Asia/Kolkata', 'weekly', jsonb_build_object('mon', jsonb_build_array(jsonb_build_array('22:00', '02:00')), 'tue', '[]'::jsonb, 'wed', jsonb_build_array(jsonb_build_array('09:00', '18:00'))), 'holidays', jsonb_build_array('2026-10-07'));
  -- Monday 2026-10-05 23:30 IST = 18:00 UTC → open; Tuesday 01:00 IST (Mon 19:30 UTC) → open via the cross-midnight interval; Tuesday 10:00 IST → closed
  if outreach_webchat__in_hours(bh, '2026-10-05 18:00:00+00') and outreach_webchat__in_hours(bh, '2026-10-05 19:30:00+00') and not outreach_webchat__in_hours(bh, '2026-10-06 04:30:00+00')
     and not outreach_webchat__in_hours(bh, '2026-10-07 05:00:00+00')   -- Wednesday 10:30 IST but a holiday
     and outreach_webchat__next_open(bh, '2026-10-06 04:30:00+00') = '2026-10-12 16:30:00+00'::timestamptz   -- Wed 09:00 IST is a holiday → Monday 22:00 IST
     and outreach_webchat__in_hours('{}'::jsonb, now())
    then log := log || E'\nok   business hours: cross-midnight interval, holiday, next_open skips the holiday, empty = always open';
    else fails := fails + 1; log := log || E'\nFAIL business hours: next_open=' || coalesce(outreach_webchat__next_open(bh, '2026-10-06 04:30:00+00')::text, 'null'); end if;

  -- ============================================================ 4. visitor + conversation start with pre-chat form (lead link, unverified)
  j := outreach_webchat_v_visitor(ib, null, null, jsonb_build_object('browser', 'Chrome', 'os', 'macOS', 'device', 'desktop', 'locale', 'en', 'country', 'IN', 'ip_hash', 'h1', 'utm', jsonb_build_object('utm_source', 'x')));
  v1 := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_conversation_start(ib, v1, jsonb_build_object('name', 'Priya', 'email', 'PRIYA12-' || left(ws::text, 8) || '@razorpay.test', 'consent', jsonb_build_object('accepted', true)), 'launcher', jsonb_build_object('url', 'https://acme.com/pricing', 'title', 'Pricing'));
  c1 := (j->'conversation'->>'id')::uuid;
  if c1 is not null and length(j->'conversation'->>'stream_key') = 32 and (j->'conversation'->>'status') = 'open'
     and (select lead_id from outreach_webchat_visitors where id = v1) = l1 and (select email_verified from outreach_webchat_visitors where id = v1) = false
     and (select lead_id from outreach_chats where id = c1) = l1 and (select provider from outreach_chats where id = c1) = 'WEBCHAT' and (select sender_id from outreach_chats where id = c1) = ib_sender
     and (select unipile_chat_id from outreach_chats where id = c1) = 'webchat:' || c1::text
     and (select count(*) from outreach_messages where chat_id = c1 and content_type = 'form_response') = 1
     and (select count(*) from outreach_messages where chat_id = c1 and sender_type = 'bot' and (content_attributes->>'greeting')::boolean) = 1
     and (select consent->>'marketing' from outreach_webchat_visitors where id = v1) = 'true'
    then log := log || E'\nok   conversation_start: chat on the WEBCHAT sender, pre-chat stored, lead linked by email (unverified), greeting posted, consent recorded';
    else fails := fails + 1; log := log || E'\nFAIL conversation_start: ' || left(j::text, 500); end if;

  -- ============================================================ 5. visitor message: stored, chat unread, lead reply-stop side effect, echo dedupe
  j := outreach_webchat_v_message(v1, c1, 'echo-1', 'Hi, what does the Pro plan cost?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  m1 := (j->'message'->>'id')::uuid;
  k := outreach_webchat_v_message(v1, c1, 'echo-1', 'Hi, what does the Pro plan cost?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if m1 is not null and (j->>'ai')::boolean = false and (j->>'dropped')::boolean = false and (k->>'duplicate')::boolean and (k->'message'->>'id')::uuid = m1
     and (select sender_type from outreach_messages where id = m1) = 'visitor' and (select origin from outreach_messages where id = m1) = 'prospect'
     and (select unread from outreach_chats where id = c1) and (select unread_count from outreach_chats where id = c1) = 1
     and (select last_replied_channel from outreach_leads where id = l1) = 'webchat' and (select last_replied_at from outreach_leads where id = l1) is not null
     and (select replied from outreach_lead_sender_state where lead_id = l1 and sender_id = ib_sender)
     and (select count(*) from outreach_messages where chat_id = c1 and content_type = 'form' and content_attributes->>'form' = 'email') = 0  -- visitor already has an email
    then log := log || E'\nok   visitor message: stored as prospect/visitor, rollup unread, echo dedupe, lead reply-stop via LSS (last_replied_channel = webchat)';
    else fails := fails + 1; log := log || E'\nFAIL visitor message: ' || left(j::text, 400) || ' lrc=' || coalesce((select last_replied_channel from outreach_leads where id = l1), 'null'); end if;

  -- email capture when nobody is online and the visitor is unknown
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); v2 := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_conversation_start(ib, v2, null, 'sdk', null); c2 := (j->'conversation'->>'id')::uuid;
  j := outreach_webchat_v_message(v2, c2, null, 'hello?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if (select count(*) from outreach_messages where chat_id = c2 and content_type = 'form' and content_attributes->>'form' = 'email') = 1
    then log := log || E'\nok   email capture: offline + unknown visitor → one email form after the first message';
    else fails := fails + 1; log := log || E'\nFAIL email capture'; end if;
  j := outreach_webchat_v_message(v2, c2, null, null, '[]'::jsonb, 'form_response', jsonb_build_object('form', 'email', 'values', jsonb_build_object('email', 'New.Visitor@Example.com')), 'widget');
  if (select email from outreach_webchat_visitors where id = v2) = 'new.visitor@example.com' and (select email_verified from outreach_webchat_visitors where id = v2) = false
    then log := log || E'\nok   email form response: stored lower-cased, unverified';
    else fails := fails + 1; log := log || E'\nFAIL email form response: ' || coalesce((select email::text from outreach_webchat_visitors where id = v2), 'null'); end if;

  -- ============================================================ 6. rate limit (10 per 10 s per visitor)
  t := 'no error';
  begin
    for i in 1..12 loop perform outreach_webchat_v_message(v2, c2, null, 'spam ' || i, '[]'::jsonb, 'text', '{}'::jsonb, 'widget'); end loop;
  exception when others then t := sqlerrm; end;
  if t like 'E_RATE_LIMITED%' then log := log || E'\nok   rate limit: 11th message in 10 s → E_RATE_LIMITED';
  else fails := fails + 1; log := log || E'\nFAIL rate limit: ' || t; end if;
  delete from outreach_rate_limits where key like 'webchat:v:' || v2::text || '%';

  -- ============================================================ 7. ownership: another visitor cannot read / post into c1
  begin j := outreach_webchat_v_messages(v2, c1, null, null, 10); t := 'no error'; exception when others then t := sqlerrm; end;
  if t like 'E_NOT_FOUND%' then log := log || E'\nok   ownership: visitor B cannot read visitor A''s conversation';
  else fails := fails + 1; log := log || E'\nFAIL ownership: ' || t; end if;

  -- ============================================================ 8. blocked visitor: dropped silently
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_webchat_block(ib, 'visitor', v2::text, 'spam');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  n := (select count(*) from outreach_messages where chat_id = c2);
  j := outreach_webchat_v_message(v2, c2, 'echo-b', 'still here', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if (j->>'dropped')::boolean and (j->'message'->>'echo_id') = 'echo-b' and (select count(*) from outreach_messages where chat_id = c2) = n
     and (select token_version from outreach_webchat_visitors where id = v2) = 2
    then log := log || E'\nok   blocked visitor: message dropped server-side, echo returned, token version bumped';
    else fails := fails + 1; log := log || E'\nFAIL blocked visitor: ' || left(j::text, 300); end if;

  -- ============================================================ 9. agent send (owner) + canned response + first response + member scope
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_webchat_canned_save(ws, null, '/hi', 'Hi {{contact.first_name}}, {{agent.name}} here.', false);
  j := outreach_webchat_agent_send(c1, '/hi The Pro plan is $99.', 'text', '{}'::jsonb, '[]'::jsonb);
  perform outreach_webchat_agent_read(c1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'text') = 'Hi Priya, Aarushi here. The Pro plan is $99.' and (j->>'sender_type') = 'agent' and (j->>'sender_name') = 'Aarushi' and (j->>'origin') = 'inbox_user'
     and (select first_response_at from outreach_chats where id = c1) is not null and (select assigned_to from outreach_chats where id = c1) = u_owner
     and (select read_by_agent_at from outreach_messages where id = m1) is not null and (select unread from outreach_chats where id = c1) = false
    then log := log || E'\nok   agent_send: canned /hi expanded with variables, first_response_at, self-assigned, visitor messages read';
    else fails := fails + 1; log := log || E'\nFAIL agent_send: ' || left(j::text, 400); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin j := outreach_webchat_agent_send(c1, 'leak?', 'text', '{}'::jsonb, '[]'::jsonb); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_NOT_FOUND%' then log := log || E'\nok   agent_send scope: client-B member cannot post into a client-A chat';
  else fails := fails + 1; log := log || E'\nFAIL agent_send scope: ' || t; end if;

  -- ============================================================ 10. identify: verified merge, unverified no merge
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); v2 := (j->'visitor'->>'id')::uuid;   -- fresh anonymous visitor
  j := outreach_webchat_v_identify(ib, v1, 'user-42', true, jsonb_build_object('name', 'Priya N', 'email', 'priya12-' || left(ws::text, 8) || '@razorpay.test'));
  k := outreach_webchat_v_identify(ib, v2, 'user-42', true, '{}'::jsonb);
  if (j->'visitor'->>'identity_verified')::boolean and (k->'visitor'->>'id')::uuid = v1 and (k->>'changed')::boolean
     and (select merged_into from outreach_webchat_visitors where id = v2) = v1 and (select email_verified from outreach_webchat_visitors where id = v1)
     and (select visitor_id from outreach_chats where id = c1) = v1 and jsonb_array_length(k->'conversations') >= 1
    then log := log || E'\nok   identify: verified identity merges the anonymous visitor into the existing one (history moves), email becomes verified';
    else fails := fails + 1; log := log || E'\nFAIL identify verified: ' || left(k::text, 400); end if;
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); v2 := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_identify(ib, v2, 'user-42', false, jsonb_build_object('email', 'priya12-' || left(ws::text, 8) || '@razorpay.test'));
  if (j->'visitor'->>'id')::uuid = v2 and (select identity_verified from outreach_webchat_visitors where id = v2) = false and (select identifier from outreach_webchat_visitors where id = v2) is null
     and jsonb_array_length(j->'conversations') = 0 and (select lead_id from outreach_webchat_visitors where id = v2) = l1
    then log := log || E'\nok   identify: unverified email never merges into someone else''s history (lead linked for context only)';
    else fails := fails + 1; log := log || E'\nFAIL identify unverified: ' || left(j::text, 400); end if;

  -- ============================================================ 11. resolve by agent → CSAT prompt; visitor rates; message after resolve reopens; then new conversation when disabled
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_conversation_update(c1, jsonb_build_object('status', 'resolved', 'labels', jsonb_build_array('pricing', 'pricing', ' hot '), 'priority', 'high'));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_v_csat(v1, c1, 5, 'great');
  if (j->>'status') = 'resolved' and (j->'labels') = '["hot","pricing"]'::jsonb and (j->>'priority') = 'high'
     and (select count(*) from outreach_messages where chat_id = c1 and content_type = 'csat') = 1
     and (k->'csat'->>'rating')::int = 5 and (select archived from outreach_chats where id = c1)
    then log := log || E'\nok   resolve: labels deduped/trimmed, priority, CSAT prompt once, visitor rating stored';
    else fails := fails + 1; log := log || E'\nFAIL resolve/csat: ' || left(j::text, 300) || ' / ' || left(k::text, 200); end if;
  j := outreach_webchat_v_message(v1, c1, null, 'one more thing', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if (j->>'reopened')::boolean and (j->'conversation'->>'status') = 'open' and (select archived from outreach_chats where id = c1) = false
    then log := log || E'\nok   message after resolve: reopens (allow_after_resolved on)';
    else fails := fails + 1; log := log || E'\nFAIL reopen: ' || left(j::text, 300); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('features', jsonb_build_object('allow_after_resolved', false), 'appearance', jsonb_build_object('accent', '#0f766e'))));
  ver := (j->>'config_version')::int;
  begin k := outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('appearance', jsonb_build_object('accent', 'red;background:url(x)')))); t := 'no error'; exception when others then t := sqlerrm; end;
  perform outreach_webchat_conversation_update(c1, jsonb_build_object('status', 'resolved'));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if ver = 2 and (j#>>'{settings,appearance,accent}') = '#0f766e' and (j#>>'{settings,appearance,welcome_title}') = 'Hi there 👋' and (j#>>'{settings,features,file_picker}') = 'true'
     and t like 'E_PAYLOAD_INVALID%' and (select count(*) from outreach_webchat_settings_history where inbox_id = ib) = 2
    then log := log || E'\nok   inbox_update: nested merge keeps defaults, version bump + history, bad accent rejected';
    else fails := fails + 1; log := log || E'\nFAIL inbox_update: v=' || ver || ' ' || t || ' ' || left(j::text, 300); end if;
  j := outreach_webchat_v_message(v1, c1, null, 'new question', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if (j->>'new_conversation')::boolean and (j->'conversation'->>'id')::uuid <> c1 and (select status from outreach_chats where id = c1) = 'resolved'
    then log := log || E'\nok   message after resolve: new conversation when allow_after_resolved is off';
    else fails := fails + 1; log := log || E'\nFAIL new conversation: ' || left(j::text, 300); end if;

  -- ============================================================ 12. presence + auto-assign on handoff (AI first → keyword handoff)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_webchat_presence(ws, 'online');
  j := outreach_webchat_inbox_update(ib, jsonb_build_object('ai_enabled', true, 'settings', jsonb_build_object('ai', jsonb_build_object('mode', 'first'), 'features', jsonb_build_object('allow_after_resolved', true))));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_public_config(tok, 'https://acme.com');
  j := outreach_webchat_v_visitor(ib, null, null, '{}'::jsonb); v2 := (j->'visitor'->>'id')::uuid;
  j := outreach_webchat_v_conversation_start(ib, v2, null, 'popup', null); c2 := (j->'conversation'->>'id')::uuid;
  j := outreach_webchat_v_message(v2, c2, null, 'How do I export data?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  m_ai := (j->'message'->>'id')::uuid;
  if (k->'availability'->>'online')::boolean and jsonb_array_length(k->'availability'->'agents') = 1 and (j->>'ai')::boolean and (select ai_mode from outreach_chats where id = c2) = 'first'
    then log := log || E'\nok   presence: owner online → inbox online; AI-first chat asks the AI to answer';
    else fails := fails + 1; log := log || E'\nFAIL presence/ai: ' || left((k->'availability')::text, 200) || ' ' || left(j::text, 200); end if;
  k := outreach_webchat_v_ai_context(c2, m_ai);
  j := outreach_webchat_v_ai_record(c2, m_ai, jsonb_build_object('query', 'How do I export data?', 'answer', 'Settings → Export.', 'sources', jsonb_build_array(jsonb_build_object('url', 'https://acme.com/help')), 'confidence', 'high', 'model', 'test', 'tokens_in', 10, 'tokens_out', 5, 'latency_ms', 100));
  if (k->>'ok')::boolean and (k->>'query') = 'How do I export data?' and jsonb_array_length(k->'history') >= 1
     and (j->>'turn_id') is not null and (j->'message'->>'sender_type') = 'bot' and (j->'message'->'content_attributes'->>'turn_id') = (j->>'turn_id')
     and (select count(*) from outreach_ai_calls where workspace_id = ws and purpose = 'webchat_answer') = 1 and (outreach__ai_pool(ws)->>'used')::int = 1
     and (select ai_handled from outreach_chats where id = c2)
    then log := log || E'\nok   ai_context + ai_record: bot answer posted with sources, turn logged, pool consumed';
    else fails := fails + 1; log := log || E'\nFAIL ai: ' || left(k::text, 300) || ' / ' || left(j::text, 300); end if;
  j := outreach_webchat_v_message(v2, c2, null, 'Can I talk to a person please', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  if (j->>'handoff')::boolean and (j->>'ai')::boolean = false and (select handed_off_at from outreach_chats where id = c2) is not null and (select assigned_to from outreach_chats where id = c2) = u_owner
     and (select count(*) from outreach_messages where chat_id = c2 and content_type = 'event' and content_attributes->>'kind' = 'assigned') = 1
     and (select count(*) from outreach_messages where chat_id = c2 and sender_type = 'bot' and (content_attributes->>'handoff')::boolean) = 1
    then log := log || E'\nok   handoff: intent detected, chat handed off, round-robin assigned to the online owner, system + bot lines posted';
    else fails := fails + 1; log := log || E'\nFAIL handoff: ' || left(j::text, 400) || ' assigned=' || coalesce((select assigned_to::text from outreach_chats where id = c2), 'null'); end if;
  k := outreach_webchat_v_ai_context(c2, m_ai);
  if (k->>'ok')::boolean = false then log := log || E'\nok   ai_context after handoff: ok=false (AI stays quiet)';
  else fails := fails + 1; log := log || E'\nFAIL ai_context after handoff'; end if;

  -- ============================================================ 13. continuity: due, record, link, match, email reply attach (reopen), bounce
  update outreach_webchat_visitors set email = 'priya12-' || left(ws::text, 8) || '@razorpay.test' where id = v1;
  update outreach_chats set visitor_last_seen_at = now() - interval '20 minutes', status = 'open', resolved_at = null where id = c1;
  update outreach_messages set created_at = now() - interval '10 minutes', read_by_visitor_at = null where chat_id = c1 and sender_type = 'agent';
  j := outreach_webchat_continuity_due(50);
  if (select count(*) from jsonb_array_elements(j) x where (x->>'chat_id')::uuid = c1) = 1 and (select jsonb_array_length((x->'messages')) from jsonb_array_elements(j) x where (x->>'chat_id')::uuid = c1) = 1
    then log := log || E'\nok   continuity_due: inactive visitor with unseen agent message → one digest owed (greeting excluded)';
    else fails := fails + 1; log := log || E'\nFAIL continuity_due: ' || left(j::text, 400); end if;
  ce := outreach_webchat_continuity_record(c1, 'digest', 'priya12-' || left(ws::text, 8) || '@razorpay.test', array[(select id from outreach_messages where chat_id = c1 and sender_type = 'agent' limit 1)], 'mailbox', mb, 'trk-1', 'prov-1', 'Re: Your conversation with Acme Site [#abcd1234]', 'abcd1234', null);
  cid := outreach_webchat_continuity_link('trk-1', null, 'uni-email-1', 'thread-1');
  if ce is not null and cid = c1 and (select last_continuity_email_at from outreach_chats where id = c1) is not null and (select email_thread_key from outreach_chats where id = c1) = 'thread-1'
     and (select email_root_message_id from outreach_chats where id = c1) = 'abcd1234' and jsonb_array_length(outreach_webchat_continuity_due(50)) = 0
     and outreach_webchat_continuity_match('thread-1', null, null, null) = c1
     and outreach_webchat_continuity_match(null, 'uni-email-1', null, null) = c1
     and outreach_webchat_continuity_match(null, null, 'priya12-' || left(ws::text, 8) || '@razorpay.test', 'RE: Your conversation with Acme Site [#ABCD1234]') = c1
     and outreach_webchat_continuity_match(null, null, 'someone@else.test', 'RE: Your conversation with Acme Site [#ABCD1234]') is null
    then log := log || E'\nok   continuity: record + link (mail_sent) + match by thread / in-reply-to / subject token + sender';
    else fails := fails + 1; log := log || E'\nFAIL continuity link/match: cid=' || coalesce(cid::text, 'null'); end if;
  update outreach_chats set status = 'resolved', resolved_at = now() where id = c1;
  tid := outreach_webchat_email_reply_attach(c1, 'priya12-' || left(ws::text, 8) || '@razorpay.test', 'Thanks, that works for me.', 'uni-email-2', now(), '[]'::jsonb);
  if tid is not null and (select status from outreach_chats where id = c1) = 'open' and (select source from outreach_messages where id = tid) = 'email' and (select sender_type from outreach_messages where id = tid) = 'visitor'
     and outreach_webchat_email_reply_attach(c1, 'priya12-' || left(ws::text, 8) || '@razorpay.test', 'dup', 'uni-email-2', now(), '[]'::jsonb) is null
    then log := log || E'\nok   email reply: appended as a visitor message (source email), resolved chat reopened, duplicate ignored';
    else fails := fails + 1; log := log || E'\nFAIL email reply attach'; end if;
  perform outreach_webchat_email_bounced(c1);
  if (select email_invalid from outreach_webchat_visitors where id = v1) and (select continuity_stopped from outreach_chats where id = c1)
    then log := log || E'\nok   bounce: visitor email marked invalid, continuity stopped for the chat';
    else fails := fails + 1; log := log || E'\nFAIL bounce'; end if;

  -- ============================================================ 14. contact panel, report, visitor export/delete, inbox delete
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_visitor(v1);
  k := outreach_webchat_report(ws, ib, current_date - 1, current_date);
  t := left(outreach_webchat_visitor_export(v1)::text, 10);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->'lead'->>'id')::uuid = l1 and (j->>'conversation_count')::int >= 1 and jsonb_array_length(j->'events') >= 1 and not (j ? 'ip_hash')
     and (k->>'conversations')::int >= 3 and (k->>'handoffs')::int = 1 and (k->>'ai_turns')::int = 1 and (k->'csat'->>'responses')::int = 1 and t <> ''
    then log := log || E'\nok   contact panel + report + export: lead context, counts, no ip hash exposed';
    else fails := fails + 1; log := log || E'\nFAIL panel/report: ' || left(j::text, 300) || ' / ' || left(k::text, 400); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  n := (select count(*) from outreach_webchat_visitors where inbox_id = ib);
  begin perform outreach_webchat_visitor_delete(v1); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n >= 1 and t like 'E_FORBIDDEN%' then log := log || E'\nok   RLS + roles: client viewer of client A reads visitors, cannot delete';
  else fails := fails + 1; log := log || E'\nFAIL viewer: n=' || n || ' ' || t; end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_webchat_visitor_delete(v1);
  perform outreach_webchat_inbox_delete(ib);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from outreach_webchat_visitors where id = v1) = 0 and (select count(*) from outreach_chats where id = c1) = 0
     and (select deleted_at from outreach_webchat_inboxes where id = ib) is not null and (select status from outreach_senders where id = ib_sender) = 'disabled'
     and (outreach_webchat_public_config(tok, 'https://acme.com')->>'error') = 'not_found'
    then log := log || E'\nok   delete: visitor + chats gone; inbox soft-deleted, sender disabled, token no longer resolves';
    else fails := fails + 1; log := log || E'\nFAIL delete'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (webchat 048-051)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
