-- Smoke test — 063 AI hub (ai-hub-unified-ui-changes.md; docs/outreach/AI-HUB.md): the Needs you / Activity views,
-- Off · Review for lines, the website assistant's Review mode, shared Q&A, unanswered questions from both features,
-- the knowledge library helpers, access scope and grants.
-- Builds fixtures, asserts, then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_15_ai_hub.sql
-- Service functions run as the service role (superuser here → outreach_is_service() is true); user RPCs and the views
-- (security_invoker) are read as impersonated members.
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; n2 int; b boolean;
  ws uuid; u_owner uuid; u_member uuid; u_viewer uuid; ca uuid; cb uuid;
  s1 uuid; s2 uuid; l1 uuid; l2 uuid; l3 uuid; q1 uuid; mp uuid;
  c1 uuid; c2 uuid; c3 uuid; c4 uuid; c5 uuid; c6 uuid; cbx uuid; m1 uuid; m2 uuid; m3 uuid;
  r1 uuid; r2 uuid; r3 uuid; r4 uuid; r5 uuid; r6 uuid; rb uuid;
  var uuid; v1 uuid; v2 uuid; v3 uuid; tk uuid; tk2 uuid;
  ib uuid; tok text; vis uuid; wc uuid; wm uuid; sg uuid; sg2 uuid; sg3 uuid; sg4 uuid;
  g1 uuid; g2 uuid; qa uuid; ks uuid; pc uuid;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  select user_id into u_viewer from platform_user_access where status = 'active' order by created_at limit 1 offset 2;
  if u_viewer is null then raise exception 'SMOKE FAIL: this test needs three active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke15', 'smoke15-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_clients(workspace_id, name) values (ws, 'Client B') returning id into cb;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner15@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_member, 'member', 'member15@test.local', 'Naman', array[cb]);
  insert into outreach_members(workspace_id, user_id, role, email, display_name, client_ids) values (ws, u_viewer, 'client_viewer', 'viewer15@test.local', 'Ravi', array[ca]);
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Sender A', 'ok', 's15a-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', u_owner, 'owner15@test.local') returning id into s1;
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_email)
    values (ws, cb, 'LINKEDIN', 'Sender B', 'ok', 's15b-' || ws, 3, 95, now() - interval '60 days', sched, 'UTC', 'client15@test.local') returning id into s2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, ca, 'priya15-' || left(ws::text, 8), 'Priya Nair', 'Razorpay') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, company) values (ws, cb, 'ben15-' || left(ws::text, 8), 'Ben Roe', 'Loomcraft') returning id into l2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name) values (ws, ca, 'cara15-' || left(ws::text, 8), 'Cara Diaz') returning id into l3;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  q1 := outreach_create_sequence(ws, 'Fintech CFOs', ca);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_sequences set status = 'active', sender_pool = array[s1], created_by = u_owner where id = q1;
  select master_prompt_id into mp from outreach_sequence_reply_settings where sequence_id = q1;

  -- chats: c1 draft · c2 escalated · c3 warm-up hold · c4 normal hold · c5 a person's own draft · c6 handed off · cbx client B
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name, reply_sequence_id, assigned_to) values (ws, ca, s1, l1, 'c15-1-' || ws, 'LINKEDIN', 'Priya Nair', q1, u_owner) returning id into c1;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name, reply_sequence_id) values (ws, ca, s1, l3, 'c15-2-' || ws, 'LINKEDIN', 'Cara Diaz', q1) returning id into c2;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, reply_sequence_id, assigned_to) values (ws, ca, s1, 'c15-3-' || ws, 'LINKEDIN', 'Dev Shah', q1, u_member) returning id into c3;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, reply_sequence_id) values (ws, ca, s1, 'c15-4-' || ws, 'LINKEDIN', 'Eli Fox', q1) returning id into c4;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, reply_sequence_id) values (ws, ca, s1, 'c15-5-' || ws, 'LINKEDIN', 'Fay Gil', q1) returning id into c5;
  insert into outreach_chats(workspace_id, client_id, sender_id, unipile_chat_id, provider, attendee_name, reply_sequence_id, ai_handed_off_at, ai_handoff_reason) values (ws, ca, s1, 'c15-6-' || ws, 'LINKEDIN', 'Gus Hall', q1, now(), 'manual') returning id into c6;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_name) values (ws, cb, s2, l2, 'c15-b-' || ws, 'LINKEDIN', 'Ben Roe') returning id into cbx;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c1, 'm15-1-' || ws, 'in', 'What would 3 films cost?', now() - interval '20 minutes') returning id into m1;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm15-2-' || ws, 'in', 'Send me your contract terms', now() - interval '15 minutes') returning id into m2;

  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text)
    values (ws, ca, c1, s1, l1, q1, array[m1], now(), now(), 'draft', 'draft_ready', 'send', 'Most projects start at 3 lakh.') returning id into r1;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text, escalation_reasons)
    values (ws, ca, c2, s1, l3, q1, array[m2], now(), now(), 'autopilot', 'escalated', 'escalate', 'Happy to share our terms.', array['legal_or_contract']) returning id into r2;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text, scheduled_send_at, timings)
    values (ws, ca, c3, s1, q1, '{}', now(), now(), 'autopilot', 'scheduled', 'send', 'Thanks Dev, here is how it works.', now() + interval '30 minutes', '{"warmup": true}') returning id into r3;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text, scheduled_send_at, timings)
    values (ws, ca, c4, s1, q1, '{}', now(), now(), 'autopilot', 'scheduled', 'send', 'A normal hold.', now() + interval '10 minutes', '{"warmup": false}') returning id into r4;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text, trigger_kind, requested_by)
    values (ws, ca, c5, s1, q1, '{}', now(), now(), 'draft', 'draft_ready', 'send', 'A person asked for this draft.', 'manual', u_owner) returning id into r5;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, sequence_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text)
    values (ws, ca, c6, s1, q1, '{}', now(), now(), 'draft', 'draft_ready', 'send', 'Draft in a handed-off chat.') returning id into r6;
  insert into outreach_ai_reply_runs(workspace_id, client_id, chat_id, sender_id, lead_id, inbound_message_ids, debounce_until, debounce_hard_until, mode, status, decision, draft_text)
    values (ws, cb, cbx, s2, l2, '{}', now(), now(), 'draft', 'draft_ready', 'send', 'Hi Ben, glad you asked.') returning id into rb;

  -- ============================================================ 1. Needs you: reply cards appear exactly when their condition holds
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select jsonb_object_agg(x.id::text, jsonb_build_object('state', x.state, 'reason', x.reason, 'where', x.where_name, 'who', x.who_name, 'detail', x.who_detail, 'trigger', x.trigger_text, 'assignee', x.assignee_id, 'send_at', x.send_at))
    into j from outreach_ai_needs_you x where x.workspace_id = ws and x.type = 'reply';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from jsonb_object_keys(j)) = 4
     and j->r1::text->>'state' = 'review' and j->r1::text->>'reason' = 'review' and j->r1::text->>'where' = 'Fintech CFOs' and j->r1::text->>'who' = 'Priya Nair'
     and j->r1::text->>'detail' = 'Razorpay' and j->r1::text->>'trigger' = 'What would 3 films cost?' and (j->r1::text->>'assignee')::uuid = u_owner
     and j->r2::text->>'state' = 'escalated' and j->r2::text->>'reason' = 'legal_or_contract'
     and j->r3::text->>'state' = 'warmup' and j->r3::text->>'reason' = 'warmup' and j->r3::text->>'send_at' is not null
     and j ? rb::text and not (j ? r4::text) and not (j ? r5::text) and not (j ? r6::text)
    then log := log || E'\nok   needs_you replies: a Review draft, an escalated reply and a warm-up hold are cards; a normal hold, a person''s own draft and a handed-off chat are not';
    else fails := fails + 1; log := log || E'\nFAIL needs_you replies: ' || left(coalesce(j::text, 'null'), 600); end if;

  -- ============================================================ 2. Mine, client scope, client viewers
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_needs_you_counts(ws, true);
  k := outreach_hub_needs_you_counts(ws, false);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  -- mine: r1 (assigned to the owner) + r2 and rb (nobody); r3 is assigned to the member
  if (j->>'reply')::int = 3 and (k->>'reply')::int = 4 and (k->>'total')::int = 4
    then log := log || E'\nok   counts: Mine = assigned to me + assigned to nobody; All = everything I may see';
    else fails := fails + 1; log := log || E'\nFAIL counts mine/all: ' || j::text || ' / ' || k::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  select count(*), count(*) filter (where id = rb) into n, n2 from outreach_ai_needs_you where workspace_id = ws;
  j := outreach_hub_needs_you_counts(ws, false);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 1 and n2 = 1 and (j->>'total')::int = 1
    then log := log || E'\nok   client scope: a member limited to client B sees only the client-B card (RLS through security_invoker)';
    else fails := fails + 1; log := log || E'\nFAIL client scope: rows=' || n || ' ' || j::text; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_viewer)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_needs_you_counts(ws, false);
  begin k := outreach_hub_setup(ws); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'total')::int = 0 and t like 'E_FORBIDDEN%'
    then log := log || E'\nok   client viewer: badge count 0, Setup refused';
    else fails := fails + 1; log := log || E'\nFAIL client viewer: ' || j::text || ' / ' || t; end if;

  -- ============================================================ 3. Reply actions: Skip, and the card of an answered escalation
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_reply_dismiss(r3); t := 'no error'; exception when others then t := sqlerrm; end;
  j := outreach_hub_reply_dismiss(r1);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_reply_dismiss(r2); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_PAYLOAD_INVALID%| E_NOT_FOUND%' and j->>'status' = 'cancelled' and (select cancel_reason from outreach_ai_reply_runs where id = r1) = 'dismissed'
     and (select cancelled_by from outreach_ai_reply_runs where id = r1) = u_owner
    then log := log || E'\nok   reply_dismiss: a draft closes as cancelled · dismissed; a scheduled reply needs a reason; a client-B member cannot touch client A';
    else fails := fails + 1; log := log || E'\nFAIL reply_dismiss: ' || t || ' ' || coalesce(j::text, 'null'); end if;
  -- a person answered the escalated chat themselves: the card goes away, the run stays escalated
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at) values (ws, c2, 'm15-2o-' || ws, 'out', 'I will send the terms myself.', now());
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) filter (where id = r2), count(*) filter (where id = r1) into n, n2 from outreach_ai_needs_you where workspace_id = ws;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 0 and n2 = 0 and (select status from outreach_ai_reply_runs where id = r2) = 'escalated' and (select last_direction from outreach_chats where id = c2) = 'out'
    then log := log || E'\nok   escalated reply: disappears once a person has the last word; a dismissed draft is gone';
    else fails := fails + 1; log := log || E'\nFAIL escalated disappears: ' || n || '/' || n2; end if;
  -- the engine no longer creates escalation tasks
  if outreach__ai_escalation_task(r2) is null and not exists (select 1 from outreach_tasks where workspace_id = ws and kind = 'ai_escalation')
    then log := log || E'\nok   escalation tasks: none are created (the reply is a card in Needs you)';
    else fails := fails + 1; log := log || E'\nFAIL escalation task created'; end if;

  -- ============================================================ 4. Personalized lines: cards, approve, Off
  insert into outreach_ai_variables(workspace_id, key, name, prompt, fallback) values (ws, 'opener', 'Opener', 'One sentence about their current role, grounded in the profile.', 'I came across your work') returning id into var;
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, text, status, generated_at) values (ws, l1, var, 'Your work on merchant onboarding at Razorpay stood out.', 'generated', now() - interval '5 minutes') returning id into v1;
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, text, status, generated_at) values (ws, l2, var, 'Loomcraft growing to 200 stores is some pace.', 'generated', now() - interval '4 minutes') returning id into v2;
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, status) values (ws, l3, var, 'pending') returning id into v3;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_ai_needs_you where workspace_id = ws and type = 'line';
  select where_name || '/' || who_name || '/' || coalesce(meta->>'fallback', '') into t from outreach_ai_needs_you where id = v1;
  perform outreach_ai_review(array[v1], 'approve', null);
  select count(*) into n2 from outreach_ai_needs_you where workspace_id = ws and type = 'line';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 2 and n2 = 1 and t = 'opener/Priya Nair/I came across your work' and (select mode from outreach_ai_variables where id = var) = 'review'
    then log := log || E'\nok   lines: a generated line is a card (variable key, lead, fallback); approving removes it; a pending line is not a card; new variables are on Review';
    else fails := fails + 1; log := log || E'\nFAIL lines: ' || n || '/' || n2 || ' ' || coalesce(t, 'null'); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_variable_set_mode(var, 'off'); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_variable_set_mode(var, 'auto'); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  j := outreach_hub_variable_set_mode(var, 'off');
  begin perform outreach_ai_generate_request(ws, var, array[l3], null, true); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  begin perform outreach_ai_review(array[v2], 'regenerate', null); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  k := outreach_hub_variable_set_mode(var, 'review');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%| E_PAYLOAD_INVALID%| E_AI_VARIABLE_OFF%| E_AI_VARIABLE_OFF%' and j->>'mode' = 'off' and j->>'was' = 'review' and k->>'mode' = 'review'
     and (select status from outreach_ai_values where id = v3) = 'skipped' and (select status from outreach_ai_values where id = v2) = 'generated'
     and exists (select 1 from outreach_audit_log a where a.workspace_id = ws and a.action = 'ai_line.mode_changed')
    then log := log || E'\nok   line modes: managers only; Auto refused; Off skips lines still to be written, refuses generate and regenerate, keeps written lines';
    else fails := fails + 1; log := log || E'\nFAIL line modes: ' || t || ' ' || coalesce(j::text, 'null') || ' v3=' || coalesce((select status from outreach_ai_values where id = v3), 'null'); end if;

  -- ============================================================ 5. Step drafts: the review_ai_draft task is the card
  insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, title, body, source) values (ws, ca, 'review_ai_draft', l1, s1, 'Review AI message for Priya Nair', 'Mention their KYC post.', 'system') returning id into tk;
  insert into outreach_tasks(workspace_id, client_id, kind, lead_id, sender_id, title, due_at) values (ws, ca, 'follow_up', l1, s1, 'Follow up with Priya', now()) returning id into tk2;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select state || '/' || coalesce(ai_text, '-') || '/' || coalesce(trigger_text, '-') into t from outreach_ai_needs_you where id = tk;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_tasks set ai_draft = 'Hi Priya, your KYC post was spot on.', draft_kind = 'message' where id = tk;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select t || ' → ' || state || '/' || coalesce(ai_text, '-') into t from outreach_ai_needs_you where id = tk;
  j := outreach_dashboard(ws);
  perform outreach_complete_task(tk, 'Hi Priya, your KYC post was spot on!', null);
  select count(*) into n from outreach_ai_needs_you where workspace_id = ws and type = 'draft';
  select count(*) into n2 from outreach_ai_outputs where workspace_id = ws and feature = 'draft' and text = 'Hi Priya, your KYC post was spot on!' and who_name = 'Priya Nair';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'drafting/-/Mention their KYC post. → review/Hi Priya, your KYC post was spot on.' and n = 0 and n2 = 1 and (j->>'tasks_open')::int = 1 and (j->>'drafts_awaiting')::int = 1
    then log := log || E'\nok   step drafts: drafting → review card from the task; approving through complete_task removes it and lands in Activity; the dashboard''s open tasks leave AI drafts out';
    else fails := fails + 1; log := log || E'\nFAIL step drafts: ' || coalesce(t, 'null') || ' n=' || n || ' out=' || n2 || ' tasks_open=' || coalesce(j->>'tasks_open', 'null'); end if;

  -- ============================================================ 6. Website assistant: Off / Review / Auto and the Review flow
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'kaptured.ai', array['kaptured.ai'], ca);
  ib := (j->>'id')::uuid; tok := j->>'website_token';
  j := outreach_hub_website_set_mode(ib, 'auto', 'outside_hours');
  k := outreach_hub_website_set_mode(ib, 'off');
  begin perform outreach_hub_website_set_mode(ib, 'review', null, 500); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_website_set_mode(ib, 'review'); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'ai_enabled')::boolean and j#>>'{settings,ai,mode}' = 'offline_only' and (k->>'ai_enabled')::boolean = false and k#>>'{settings,ai,mode}' = 'offline_only'
     and t like 'E_PAYLOAD_INVALID%| E_%'
    then log := log || E'\nok   website_set_mode: Auto · outside hours = offline_only; Off keeps the stored mode; timeout bounds; managers only';
    else fails := fails + 1; log := log || E'\nFAIL website_set_mode: ' || t || ' ' || left(coalesce(j::text, 'null'), 200); end if;

  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_website_set_mode(ib, 'review', null, 5);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  k := outreach_webchat_public_config(tok, 'https://kaptured.ai');
  if (j->>'ai_enabled')::boolean and j#>>'{settings,ai,mode}' = 'review' and (j#>>'{settings,ai,review_timeout_min}')::int = 5
     and k#>>'{settings,ai,mode}' = 'off' and k#>>'{availability,ai_mode}' = 'off'
    then log := log || E'\nok   Review: stored as ai.mode review with its timeout; the widget is told "off" (config and availability)';
    else fails := fails + 1; log := log || E'\nFAIL review mode stored/public: ' || left(coalesce(k->'settings'->'ai', 'null'::jsonb)::text, 200) || ' ' || coalesce(k#>>'{availability,ai_mode}', 'null'); end if;

  j := outreach_webchat_v_visitor(ib, null, null, jsonb_build_object('browser', 'Chrome', 'city', 'Mumbai'));
  vis := (j->'visitor'->>'id')::uuid;
  update outreach_webchat_visitors set city = 'Mumbai' where id = vis;
  j := outreach_webchat_v_conversation_start(ib, vis, null, 'launcher', null); wc := (j->'conversation'->>'id')::uuid;
  j := outreach_webchat_v_message(vis, wc, 'e15-1', 'Do you shoot on location?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  wm := (j->'message'->>'id')::uuid; sg := (j->>'suggest')::uuid;
  k := outreach_webchat_v_ai_context(wc, wm);
  if (select ai_mode from outreach_chats where id = wc) = 'review' and (j->>'ai')::boolean = false and sg is not null
     and (select status from outreach_webchat_ai_suggestions where id = sg) = 'pending' and (k->>'ok')::boolean = false
    then log := log || E'\nok   Review message: the widget gets ai=false, a pending suggestion is opened, the public /chat context refuses to answer';
    else fails := fails + 1; log := log || E'\nFAIL review message: ' || left(j::text, 300); end if;

  b := outreach_webchat_v_suggest_take(sg);
  k := outreach_webchat_v_suggest_context(sg);
  j := outreach_webchat_v_suggest_record(sg, jsonb_build_object('query', 'Do you shoot on location?', 'answer', 'Yes, we shoot on location across India.', 'sources', jsonb_build_array(jsonb_build_object('url', 'https://kaptured.ai/faq', 'title', 'FAQ')), 'confidence', 'high', 'model', 'test', 'tokens_in', 10, 'tokens_out', 5, 'latency_ms', 90));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select type || '/' || priority || '/' || who_name || '/' || coalesce(who_detail, '-') || '/' || trigger_text || '/' || ai_text || '/' || reason into t from outreach_ai_needs_you where id = sg;
  select count(*) into n from outreach_ai_outputs where workspace_id = ws and feature = 'website' and where_id = ib and chat_id = wc;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if b and outreach_webchat_v_suggest_take(sg) = false and (k->>'ok')::boolean and (k->>'review')::boolean and k->>'query' = 'Do you shoot on location?' and jsonb_typeof(k->'qa') = 'array'
     and j->>'status' = 'waiting' and t = 'website/0/Visitor/Mumbai/Do you shoot on location?/Yes, we shoot on location across India./review' and n = 1
     and (select count(*) from outreach_ai_calls where workspace_id = ws and purpose = 'webchat_answer') = 1
     and not exists (select 1 from outreach_messages where chat_id = wc and sender_type = 'bot' and (content_attributes->>'ai')::boolean)
    then log := log || E'\nok   suggestion: one writer at a time, recorded as waiting, counted against the allowance, a Website card on top of Needs you and a row in Activity; nothing is sent to the visitor';
    else fails := fails + 1; log := log || E'\nFAIL suggestion: ' || coalesce(t, 'null') || ' ' || left(coalesce(j::text, 'null'), 200) || ' out=' || n; end if;

  -- the visitor writes again → stale, a new suggestion; the agent sends it → used, and the assistant keeps going
  j := outreach_webchat_v_message(vis, wc, 'e15-2', 'And how many revision rounds?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  sg2 := (j->>'suggest')::uuid;
  perform outreach_webchat_v_suggest_take(sg2);
  perform outreach_webchat_v_suggest_record(sg2, jsonb_build_object('query', 'And how many revision rounds?', 'answer', 'I am checking and will come back to you.', 'confidence', 'low', 'model', 'test'));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select reason into t from outreach_ai_needs_you where id = sg2;
  k := outreach_webchat_agent_send(wc, 'Two rounds are included.', 'text', jsonb_build_object('internal', jsonb_build_object('suggestion_id', sg2)), '[]'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select id into g1 from outreach_ai_unanswered_questions where workspace_id = ws and inbox_id = ib;
  if (select status from outreach_webchat_ai_suggestions where id = sg) = 'stale' and t = 'low_confidence'
     and (select status from outreach_webchat_ai_suggestions where id = sg2) = 'used' and (select used_message_id from outreach_webchat_ai_suggestions where id = sg2) = (k->>'id')::uuid
     and (select resolved_by from outreach_webchat_ai_suggestions where id = sg2) = u_owner
     and (select handed_off_at from outreach_chats where id = wc) is null
     and g1 is not null and (select origins from outreach_ai_unanswered_questions where id = g1) = array['website'] and (select sequence_id from outreach_ai_unanswered_questions where id = g1) is null
     and not ((outreach_webchat__message_json((select m from outreach_messages m where m.id = (k->>'id')::uuid))->'content_attributes') ? 'internal')
    then log := log || E'\nok   stale / used: a new visitor message makes the old suggestion stale; the agent''s send marks it used and does not stop the assistant; a low-confidence suggestion is an unanswered question (website); the suggestion id never reaches the widget';
    else fails := fails + 1; log := log || E'\nFAIL stale/used: sg=' || (select status from outreach_webchat_ai_suggestions where id = sg) || ' sg2=' || (select status from outreach_webchat_ai_suggestions where id = sg2) || ' reason=' || coalesce(t, 'null') || ' handed=' || coalesce((select handed_off_at::text from outreach_chats where id = wc), 'null') || ' g1=' || coalesce(g1::text, 'null'); end if;

  -- an agent replies without the suggestion → stale
  j := outreach_webchat_v_message(vis, wc, 'e15-3', 'Can you do Diwali week?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  sg3 := (j->>'suggest')::uuid;
  perform outreach_webchat_v_suggest_take(sg3);
  perform outreach_webchat_v_suggest_record(sg3, jsonb_build_object('query', 'Can you do Diwali week?', 'answer', 'Yes, we can.', 'confidence', 'high', 'model', 'test'));
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_webchat_agent_send(wc, 'Let me check the calendar first.', 'text', '{}'::jsonb, '[]'::jsonb);
  select count(*) into n from outreach_ai_needs_you where workspace_id = ws and type = 'website';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select status from outreach_webchat_ai_suggestions where id = sg3) = 'stale' and n = 0
    then log := log || E'\nok   agent replied without the suggestion: stale, gone from Needs you';
    else fails := fails + 1; log := log || E'\nFAIL stale on own reply: ' || (select status from outreach_webchat_ai_suggestions where id = sg3) || ' n=' || n; end if;

  -- nobody answers within the review timeout (5 min) → expired + the offline message, once; never the suggestion itself
  j := outreach_webchat_v_message(vis, wc, 'e15-4', 'Anyone there?', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  sg4 := (j->>'suggest')::uuid;
  perform outreach_webchat_v_suggest_take(sg4);
  perform outreach_webchat_v_suggest_record(sg4, jsonb_build_object('query', 'Anyone there?', 'answer', 'Yes, we are here.', 'confidence', 'high', 'model', 'test'));
  k := outreach_webchat_review_sweep();
  n := (select count(*) from outreach_messages where chat_id = wc and sender_type = 'bot' and content_attributes ? 'review_timeout');
  -- (one transaction = one now(): move the agent's earlier replies into the past so "no reply since" is about this message)
  update outreach_messages set created_at = now() - interval '1 hour' where chat_id = wc and sender_type = 'agent';
  update outreach_webchat_ai_suggestions set created_at = now() - interval '6 minutes' where id = sg4;
  j := outreach_webchat_review_sweep();
  perform outreach_webchat_review_sweep();
  if n = 0 and (k->>'chats_timed_out')::int = 0 and (j->>'chats_timed_out')::int = 1 and (j->>'away_messages')::int = 1
     and (select status from outreach_webchat_ai_suggestions where id = sg4) = 'expired'
     and (select count(*) from outreach_messages where chat_id = wc and sender_type = 'bot' and content_attributes ? 'review_timeout') = 1
     -- the email was already asked for with the first message (nobody online), so the offline message is plain text
     and (select content_type from outreach_messages where chat_id = wc and sender_type = 'bot' and content_attributes ? 'review_timeout') = 'text'
     and (select count(*) from outreach_messages where chat_id = wc and content_type = 'form' and content_attributes->>'form' = 'email') = 1
     and not exists (select 1 from outreach_messages where chat_id = wc and direction = 'out' and text = 'Yes, we are here.')
    then log := log || E'\nok   review timeout: before it nothing happens; after it the suggestion expires and the visitor gets the offline message once (the email is asked for once per conversation); the suggestion is never sent';
    else fails := fails + 1; log := log || E'\nFAIL review timeout: ' || coalesce(k::text, 'null') || ' / ' || coalesce(j::text, 'null') || ' status=' || (select status from outreach_webchat_ai_suggestions where id = sg4); end if;

  -- three failed tries → given up
  j := outreach_webchat_v_message(vis, wc, 'e15-5', 'Still waiting here', '[]'::jsonb, 'text', '{}'::jsonb, 'widget');
  sg := (j->>'suggest')::uuid;
  for n in 1..3 loop
    perform outreach_webchat_v_suggest_take(sg);
    perform outreach_webchat_v_suggest_fail(sg, 'model timeout', false);
  end loop;
  if (select status from outreach_webchat_ai_suggestions where id = sg) = 'failed' and outreach_webchat_v_suggest_take(sg) = false
     and (select count(*) from outreach_webchat_suggest_claim(10)) = 0
    then log := log || E'\nok   suggestion retries: three failed tries and it is given up (the agent answers unaided)';
    else fails := fails + 1; log := log || E'\nFAIL suggestion retries: ' || (select status || ' attempts=' || attempts from outreach_webchat_ai_suggestions where id = sg); end if;

  -- ============================================================ 7. Questions and shared Q&A
  insert into outreach_ai_unanswered_questions(workspace_id, sequence_id, master_prompt_id, canonical, norm, examples, seen_at)
    values (ws, q1, mp, 'Do you offer revisions after delivery?', outreach__uq_norm('Do you offer revisions after delivery?'), '[]'::jsonb, array[now()]) returning id into g2;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select count(*) into n from outreach_ai_needs_you where workspace_id = ws and type = 'question';
  select where_kind || '/' || where_name || '/' || trigger_text || '/' || (meta->>'origins') into t from outreach_ai_needs_you where id = g1;
  j := outreach_hub_question_answer(g2, 'Yes, two rounds of revisions are included.');
  qa := (j->>'qa_id')::uuid;
  k := outreach_hub_question_dismiss(g1, 'not relevant');
  select count(*) into n2 from outreach_ai_needs_you where workspace_id = ws and type = 'question';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 2 and n2 = 0 and t = 'website/kaptured.ai/And how many revision rounds?/["website"]'
     and (select status from outreach_ai_unanswered_questions where id = g2) = 'answered' and (select answered_faq_id from outreach_ai_unanswered_questions where id = g2) = qa
     and (select master_prompt_id is null and workspace_id = ws and source = 'unanswered' from outreach_master_prompt_faqs where id = qa)
     and (select status from outreach_ai_unanswered_questions where id = g1) = 'dismissed'
    then log := log || E'\nok   questions: both origins are cards; Add answer makes a shared Q&A pair and answers the group; Dismiss closes it';
    else fails := fails + 1; log := log || E'\nFAIL questions: ' || n || '/' || n2 || ' ' || coalesce(t, 'null'); end if;
  -- the shared pair reaches both features; a limited pair only its targets
  if (select count(*) from jsonb_array_elements(outreach__ai_faqs_for(mp, 'revisions')) x where (x->>'id')::uuid = qa) = 1
     and (select count(*) from jsonb_array_elements(outreach_knowledge_qa_for(ws, 'website', ib, 'revisions')) x where (x->>'id')::uuid = qa) = 1
    then log := log || E'\nok   shared Q&A: a pair with no limits is read by Replies (the sequence''s prompt) and by the Website assistant';
    else fails := fails + 1; log := log || E'\nFAIL shared Q&A applies everywhere'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_qa_save(ws, qa, 'Do you offer revisions after delivery?', 'Yes, two rounds.', true, jsonb_build_array(jsonb_build_object('kind', 'website', 'id', ib)));
  k := outreach_hub_qa_list(ws);
  begin perform outreach_hub_qa_save(ws, null, 'Q', 'A', true, jsonb_build_array(jsonb_build_object('kind', 'sequence', 'id', gen_random_uuid()))); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_hub_qa_save(ws, null, 'Member question?', 'Member answer.'); t := t || ' | no error'; exception when others then t := t || ' | ' || sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select count(*) from jsonb_array_elements(outreach__ai_faqs_for(mp, 'revisions')) x where (x->>'id')::uuid = qa) = 0
     and (select count(*) from jsonb_array_elements(outreach_knowledge_qa_for(ws, 'website', ib, null)) x where (x->>'id')::uuid = qa) = 1
     and j->>'owner' = 'library' and jsonb_array_length(j->'targets') = 1 and j#>>'{targets,0,name}' = 'kaptured.ai'
     and (select count(*) from jsonb_array_elements(k) x where (x->>'id')::uuid = qa and x->>'owner' = 'library' and x->>'answer' = 'Yes, two rounds.') = 1
     and t like 'E_NOT_FOUND%| E_FORBIDDEN%'
    then log := log || E'\nok   Q&A limits: a pair limited to the website is no longer read by the sequence; unknown targets refused; managers only';
    else fails := fails + 1; log := log || E'\nFAIL Q&A limits: ' || t || ' ' || left(coalesce(j::text, 'null'), 200); end if;
  -- a sequence's own pair moves to the shared list when its scope changes; deleting a shared pair reopens its question
  insert into outreach_master_prompt_faqs(master_prompt_id, question, answer) values (mp, 'What is your turnaround?', 'Two weeks.') returning id into v1;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_hub_qa_save(ws, v1, 'What is your turnaround?', 'Two to three weeks.', true, null);
  k := outreach_hub_qa_save(ws, v1, 'What is your turnaround?', 'Two to three weeks.', true, '[]'::jsonb);
  perform outreach_hub_qa_delete(qa);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select workspace_id from outreach_master_prompt_faqs where id = v1) = ws and j->>'owner' = 'sequence' and k->>'owner' = 'library'
     and (select master_prompt_id from outreach_master_prompt_faqs where id = v1) is null
     and (select count(*) from jsonb_array_elements(outreach_knowledge_qa_for(ws, 'website', ib, null)) x where (x->>'id')::uuid = v1) = 1
     and not exists (select 1 from outreach_master_prompt_faqs where id = qa) and (select status from outreach_ai_unanswered_questions where id = g2) = 'open'
    then log := log || E'\nok   Q&A ownership: a prompt''s own pair is edited in place, moves to the shared list when its scope changes; deleting a shared pair reopens its question';
    else fails := fails + 1; log := log || E'\nFAIL Q&A ownership: ' || coalesce(j::text, 'null') || ' / ' || coalesce(k::text, 'null'); end if;

  -- ============================================================ 8. Knowledge library: used by, link, remove everywhere
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_knowledge_source_add(ws, 'text', 'Rate card', null, null, 'Our films start at three lakh rupees and take two to three weeks to deliver.');
  ks := (j->>'id')::uuid;
  perform outreach_hub_knowledge_link(ks, 'website', ib, true);
  perform outreach_hub_knowledge_link(ks, 'sequence', q1, true);
  perform outreach_hub_knowledge_link(ks, 'website', ib, true);   -- idempotent
  j := outreach_hub_knowledge(ws);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select x into k from jsonb_array_elements(j->'sources') x where (x->>'id')::uuid = ks;
  n := (select config_version from outreach_webchat_inboxes where id = ib);
  if jsonb_array_length(k->'used_in') = 2 and (k->>'used_by')::int = 2
     and (select count(*) from jsonb_array_elements(k->'used_in') x where x->>'kind' = 'website' and x->>'name' = 'kaptured.ai') = 1
     and (select count(*) from jsonb_array_elements(k->'used_in') x where x->>'kind' = 'sequence' and x->>'name' = 'Fintech CFOs') = 1
     and (select settings#>'{ai,knowledge_source_ids}' from outreach_webchat_inboxes where id = ib) = jsonb_build_array(ks::text)
     and ks = any((select knowledge_source_ids from outreach_master_prompts where id = mp)::uuid[])
     and jsonb_array_length(j#>'{targets,sequences}') = 1 and jsonb_array_length(j#>'{targets,websites}') = 1
    then log := log || E'\nok   knowledge: one source linked to a website and a sequence shows both under Used by; linking twice changes nothing';
    else fails := fails + 1; log := log || E'\nFAIL knowledge used_in: ' || left(coalesce(k::text, 'null'), 400); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  perform outreach_hub_knowledge_link(ks, 'sequence', q1, false);
  perform outreach_knowledge_source_delete(ks);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if not exists (select 1 from outreach_knowledge_sources where id = ks)
     and (select settings#>'{ai,knowledge_source_ids}' from outreach_webchat_inboxes where id = ib) = '[]'::jsonb
     and not (ks = any((select knowledge_source_ids from outreach_master_prompts where id = mp)::uuid[]))
    then log := log || E'\nok   knowledge remove: detaching a sequence and deleting the source takes it off the website too';
    else fails := fails + 1; log := log || E'\nFAIL knowledge remove: ' || coalesce((select (settings#>'{ai,knowledge_source_ids}')::text from outreach_webchat_inboxes where id = ib), 'null'); end if;

  -- ============================================================ 9. Profile drafts
  insert into outreach_profile_changes(workspace_id, sender_id, field_groups, payload, source, status, requested_by, note)
    values (ws, s1, array['headline']::outreach_profile_field_group_t[], jsonb_build_object('headline', 'Films that explain fintech'), 'ai_draft', 'draft', u_owner, 'AI draft: punchier') returning id into pc;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select type || '/' || where_name || '/' || ai_text || '/' || (meta->>'field') || '/' || (assignee_id = u_owner)::text into t from outreach_ai_needs_you where id = pc;
  select count(*) into n from outreach_ai_outputs where workspace_id = ws and feature = 'profile' and text = 'Films that explain fintech';
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  update outreach_profile_changes set status = 'cancelled' where id = pc;
  if t = 'profile/Sender A/Films that explain fintech/headline/true' and n = 1 and not exists (select 1 from outreach_ai_needs_you where id = pc)
    then log := log || E'\nok   profile drafts: an AI draft that is not applied is a card for the person who asked; discarded → gone; listed in Activity';
    else fails := fails + 1; log := log || E'\nFAIL profile drafts: ' || coalesce(t, 'null') || ' n=' || n; end if;

  -- ============================================================ 10. Activity: each output once, with feature / where / who; Setup numbers
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  select jsonb_object_agg(x.feature, x.n) into j from (select feature, count(*) n from outreach_ai_outputs where workspace_id = ws group by feature) x;
  select count(*) into n from (select id, feature from outreach_ai_outputs where workspace_id = ws group by id, feature having count(*) > 1) d;
  select where_kind || '/' || where_name || '/' || who_kind || '/' || who_name into t from outreach_ai_outputs where id = v2;
  select count(*) into n2 from outreach_ai_outputs where workspace_id = ws and text ilike '%' || 'merchant onboarding' || '%';
  k := outreach_hub_setup(ws);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  -- replies: r1..r6 + rb = 7 texts · lines: v1, v2 · drafts: 1 · website: 4 suggestions with text · profile: 1
  if (j->>'reply')::int = 7 and (j->>'line')::int = 2 and (j->>'draft')::int = 1 and (j->>'website')::int = 4 and (j->>'profile')::int = 1 and n = 0
     and t = 'variable/opener/lead/Ben Roe' and n2 = 1
     and (k->'written_7d'->>'reply')::int = 7 and jsonb_array_length(k->'sequences') = 1 and k#>>'{sequences,0,mode}' = 'draft'
     and jsonb_array_length(k->'variables') = 1 and k#>>'{variables,0,mode}' = 'review' and (k#>>'{variables,0,waiting}')::int = 1 and (k#>>'{variables,0,approved}')::int = 1
     and jsonb_array_length(k->'websites') = 1 and k#>>'{websites,0,mode}' = 'review' and (k#>>'{websites,0,review_timeout_min}')::int = 5
     and (k#>>'{drafts,open}')::int = 0 and (k->>'questions_open')::int = 1
    then log := log || E'\nok   Activity: every AI text once with its feature, place and person; search matches the text; Setup carries the modes and the 7-day counts';
    else fails := fails + 1; log := log || E'\nFAIL activity/setup: ' || coalesce(j::text, 'null') || ' dup=' || n || ' ' || coalesce(t, 'null') || ' ' || left(coalesce(k::text, 'null'), 500); end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  select count(*), count(*) filter (where who_name = 'Ben Roe') into n, n2 from outreach_ai_outputs where workspace_id = ws;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 2 and n2 = 2 then log := log || E'\nok   Activity scope: a client-B member sees only client B''s reply and line';
  else fails := fails + 1; log := log || E'\nFAIL activity scope: ' || n || '/' || n2; end if;

  -- ============================================================ 11. Grants
  if has_function_privilege('authenticated', 'outreach_hub_setup(uuid)', 'execute') and has_function_privilege('authenticated', 'outreach_hub_needs_you_counts(uuid,boolean)', 'execute')
     and has_function_privilege('authenticated', 'outreach_hub_qa_save(uuid,uuid,text,text,boolean,jsonb)', 'execute') and has_function_privilege('authenticated', 'outreach_hub_reply_dismiss(uuid)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_webchat_review_sweep()', 'execute') and not has_function_privilege('authenticated', 'outreach_knowledge_qa_for(uuid,text,uuid,text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_webchat_v_suggest_record(uuid,jsonb)', 'execute') and not has_function_privilege('anon', 'outreach_hub_setup(uuid)', 'execute')
     and has_table_privilege('authenticated', 'outreach_ai_needs_you', 'select') and not has_table_privilege('anon', 'outreach_ai_outputs', 'select')
     and not has_table_privilege('authenticated', 'outreach_webchat_ai_suggestions', 'insert')
     and to_regprocedure('outreach_hub__patch(text,text,text[])') is null
    then log := log || E'\nok   grants: hub RPCs and the two views for signed-in users; service functions and writes to suggestions are not';
    else fails := fails + 1; log := log || E'\nFAIL grants'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (AI hub 063)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
