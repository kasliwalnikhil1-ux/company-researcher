-- Smoke test — 072 question wording per language, no turn-count handoff in a call, typed turns only for typed messages.
-- Builds fixtures, asserts, then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_19_webchat_fix1.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; t text; def text;
  ws uuid; u_owner uuid; ib uuid; bad jsonb; vb jsonb;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at, user_id limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke19', 'smoke19-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner19@test.local', 'Aarushi');
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'Acme Site', array['acme.com'], null);
  ib := (j->>'id')::uuid;

  -- ============================================================ 1. a question's wording per language is saved and reaches the widget
  vb := jsonb_build_object('url', 'https://cdn.acme.com/hi.mp4', 'kind', 'video',
    'languages', jsonb_build_array(jsonb_build_object('code', 'hi-IN', 'label', 'Hindi', 'flag', 'in'), jsonb_build_object('code', 'en-US', 'label', 'English (US)', 'flag', 'us')),
    'questions', jsonb_build_array(
      jsonb_build_object('text', 'इसकी कीमत क्या है?', 'text_variants', jsonb_build_array(jsonb_build_object('lang', 'hi-IN', 'text', 'इसकी कीमत क्या है?'), jsonb_build_object('lang', 'en-US', 'text', 'What does it cost?'))),
      'Plain question'));
  j := outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('launcher', jsonb_build_object('video', vb))));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j#>>'{settings,launcher,video,questions,0,text_variants,1,text}') = 'What does it cost?' and (j#>>'{settings,launcher,video,questions,1}') = 'Plain question'
     and (outreach_webchat_public_config((select website_token from outreach_webchat_inboxes where id = ib), 'https://acme.com')#>>'{settings,launcher,video,questions,0,text_variants,1,lang}') = 'en-US'
    then log := log || E'\nok   text_variants: saved and in the widget config';
    else fails := fails + 1; log := log || E'\nFAIL text_variants: ' || left(coalesce((j#>'{settings,launcher,video,questions}')::text, 'null'), 400); end if;

  -- ============================================================ 2. bad wording lists are refused
  t := '';
  foreach bad in array array[
    jsonb_build_array(jsonb_build_object('lang', 'en-US', 'text', '')),                                   -- empty wording
    jsonb_build_array(jsonb_build_object('lang', 'en-US', 'text', repeat('x', 121))),                     -- too long
    jsonb_build_array(jsonb_build_object('lang', 'english', 'text', 'Hi')),                                -- not a language code
    jsonb_build_array(jsonb_build_object('lang', 'en-US', 'text', 'Hi', 'url', 'https://x.com')),          -- unknown field
    '"What does it cost?"'::jsonb,                                                                         -- not a list
    (select jsonb_agg(jsonb_build_object('lang', 'en-US', 'text', 'Hi')) from generate_series(1, 9))       -- more than 8
  ] loop
    perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
    execute 'set local role authenticated';
    begin
      perform outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('launcher', jsonb_build_object('video', jsonb_build_object(
        'questions', jsonb_build_array(jsonb_build_object('text', 'Q', 'text_variants', bad)))))));
      t := t || 'accepted ';
    exception when others then t := t || case when sqlerrm like 'E_PAYLOAD_INVALID: launcher.video.questions.text_variants%' then 'refused ' else 'other(' || sqlerrm || ') ' end;
    end;
    execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  end loop;
  if t = 'refused refused refused refused refused refused '
    then log := log || E'\nok   text_variants: empty, too long, bad code, unknown field, not a list, 9 entries all refused';
    else fails := fails + 1; log := log || E'\nFAIL text_variants refusals: ' || t; end if;

  -- ============================================================ 3. a call never hands off on the turn count; typed messages count typed turns
  def := pg_get_functiondef('public.outreach_webchat_v_voice_turns(uuid,uuid,jsonb)'::regprocedure);
  if position('''max_turns''' in def) = 0 and position('{ai,handoff,max_turns}' in def) = 0 and position('outreach_webchat__handoff_match' in def) > 0
    then log := log || E'\nok   voice turns: no max_turns handoff, handoff words still checked';
    else fails := fails + 1; log := log || E'\nFAIL voice turns still count turns'; end if;
  def := pg_get_functiondef('public.outreach_webchat_v_message(uuid,uuid,text,text,jsonb,text,jsonb,text)'::regprocedure);
  if position('t.voice_call_id is null) >= coalesce((st#>>''{ai,handoff,max_turns}'')::int, 6)' in def) > 0
    then log := log || E'\nok   typed messages: the turn count leaves out spoken turns';
    else fails := fails + 1; log := log || E'\nFAIL typed messages still count spoken turns'; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (webchat fix 1, 072)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
