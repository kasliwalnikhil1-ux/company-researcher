-- Smoke test — 053 web chat video bubble, privacy link, placeholder default. Builds fixtures, asserts, then RAISES so
-- everything rolls back. A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_13_webchat_video.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; k jsonb; t text; n int;
  ws uuid; u_owner uuid; u_member uuid; ib uuid; tok text; bad jsonb; path text;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  if u_member is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke13', 'smoke13-' || encode(gen_random_bytes(4),'hex'), u_owner, 'agency') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner13@test.local', 'Aarushi');
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_member, 'member', 'member13@test.local', 'Naman');

  -- ============================================================ 1. defaults
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_create(ws, 'Acme Site', array['acme.com'], null);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  ib := (j->>'id')::uuid; tok := j->>'website_token';
  if (j#>>'{settings,messages,placeholder}') = 'Ask a question…' and (j#>'{settings,messages}') ? 'privacy_url' and (j#>>'{settings,messages,privacy_url}') is null
     and (j#>>'{settings,launcher,video,url}') is null and (j#>>'{settings,launcher,video,shape}') = 'circle' and (j#>>'{settings,launcher,video,size}')::int = 120
     and (j#>'{settings,launcher,video,questions}') = '[]'::jsonb and (j#>>'{settings,launcher,video,cta_text}') = 'Chat with us' and (j#>>'{settings,launcher,desktop,type}') = 'icon'
    then log := log || E'\nok   defaults: new placeholder, privacy_url, launcher.video off (no url) next to the untouched launcher';
    else fails := fails + 1; log := log || E'\nFAIL defaults: ' || left((j#>'{settings,launcher}')::text, 400) || ' / ' || left((j#>'{settings,messages}')::text, 300); end if;

  -- ============================================================ 2. save a clip + questions; the widget config carries it; order is kept
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object(
         'launcher', jsonb_build_object('video', jsonb_build_object('url', 'https://cdn.acme.com/hello.mp4', 'kind', 'video', 'shape', 'rounded', 'ratio', '3:4', 'size', 140,
                     'questions', jsonb_build_array('What does it cost?', 'How do I start?', 'Can I talk to sales?'), 'questions_position', 'below', 'question_bg', '#0f766e', 'cta_text', 'Talk to us')),
         'messages', jsonb_build_object('privacy_url', 'https://acme.com/privacy'))));
  k := outreach_webchat_inbox_update(ib, jsonb_build_object('settings', jsonb_build_object('launcher', jsonb_build_object('video', jsonb_build_object('questions', jsonb_build_array('Can I talk to sales?', 'What does it cost?'))))));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j#>>'{settings,launcher,video,url}') = 'https://cdn.acme.com/hello.mp4' and (j#>>'{settings,launcher,video,shape}') = 'rounded' and (j#>>'{settings,launcher,video,fit}') = 'cover'
     and (j#>>'{settings,launcher,desktop,position}') = 'right' and jsonb_array_length(j#>'{settings,launcher,video,questions}') = 3
     and (k#>'{settings,launcher,video,questions}') = '["Can I talk to sales?", "What does it cost?"]'::jsonb and (k#>>'{settings,launcher,video,url}') = 'https://cdn.acme.com/hello.mp4'
     and (k#>>'{settings,messages,privacy_url}') = 'https://acme.com/privacy' and (k#>>'{settings,messages,placeholder}') = 'Ask a question…'
    then log := log || E'\nok   save: video settings merge over defaults, questions replace as an ordered list, privacy link stored';
    else fails := fails + 1; log := log || E'\nFAIL save: ' || left((k#>'{settings,launcher,video}')::text, 500); end if;

  j := outreach_webchat_public_config(tok, 'https://acme.com');
  if (j#>>'{settings,launcher,video,url}') = 'https://cdn.acme.com/hello.mp4' and (j#>>'{settings,launcher,video,questions_position}') = 'below'
     and (j#>>'{settings,launcher,video,questions,0}') = 'Can I talk to sales?' and (j#>>'{settings,messages,privacy_url}') = 'https://acme.com/privacy'
    then log := log || E'\nok   public_config: the widget gets launcher.video and the privacy link';
    else fails := fails + 1; log := log || E'\nFAIL public_config: ' || left((j#>'{settings,launcher}')::text, 400); end if;

  -- ============================================================ 3. built-in clip, switching off, clearing
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  j := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"url":"preset:wave-01.mp4"}}}}'::jsonb);
  k := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"url":null,"enabled":false},"hide":false},"messages":{"privacy_url":null}}}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j#>>'{settings,launcher,video,url}') = 'preset:wave-01.mp4' and (k#>>'{settings,launcher,video,url}') is null and (k#>>'{settings,launcher,video,enabled}') = 'false' and (k#>>'{settings,messages,privacy_url}') is null
    then log := log || E'\nok   preset url accepted; url and privacy link can be cleared';
    else fails := fails + 1; log := log || E'\nFAIL preset/clear: ' || left((k#>'{settings,launcher,video}')::text, 300); end if;

  -- ============================================================ 4. validation: every bad value is refused, nothing is stored
  n := 0; t := '';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  for bad in select * from jsonb_array_elements('[
      {"launcher":{"video":{"url":"http://cdn.acme.com/a.mp4"}}},
      {"launcher":{"video":{"url":"javascript:alert(1)"}}},
      {"launcher":{"video":{"url":"https://cdn.acme.com/a.mp4\" onerror=\"x"}}},
      {"launcher":{"video":{"url":"preset:../../secret"}}},
      {"launcher":{"video":{"shape":"star"}}},
      {"launcher":{"video":{"kind":"audio"}}},
      {"launcher":{"video":{"fit":"stretch"}}},
      {"launcher":{"video":{"ratio":"wide"}}},
      {"launcher":{"video":{"expanded_ratio":"16x9"}}},
      {"launcher":{"video":{"questions_position":"left"}}},
      {"launcher":{"video":{"question_bg":"red;background:url(x)"}}},
      {"launcher":{"video":{"cta_bg":"#12"}}},
      {"launcher":{"video":{"cta_text":"01234567890123456789012345678901234567890"}}},
      {"launcher":{"video":{"questions":["1","2","3","4","5","6","7"]}}},
      {"launcher":{"video":{"questions":[{"q":"x"}]}}},
      {"launcher":{"video":{"questions":"one"}}},
      {"launcher":{"video":"on"}},
      {"messages":{"privacy_url":"acme.com/privacy"}},
      {"messages":{"privacy_url":"http://acme.com/privacy"}}
    ]'::jsonb) loop
    begin perform outreach_webchat_inbox_update(ib, jsonb_build_object('settings', bad)); t := t || ' ACCEPTED ' || bad::text;
    exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; else t := t || ' ' || sqlerrm; end if; end;
  end loop;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select settings into j from outreach_webchat_inboxes where id = ib;
  if n = 19 and t = '' and (j#>>'{launcher,video,shape}') = 'rounded' and (select count(*) from outreach_webchat_settings_history where inbox_id = ib) = 5
    then log := log || E'\nok   validation: 19 bad values refused (urls, enums, colours, question list, privacy link), settings + history untouched';
    else fails := fails + 1; log := log || E'\nFAIL validation: n=' || n || t; end if;

  -- ============================================================ 5. roles: a member cannot change the launcher; the helper is not callable by app users
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin perform outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"url":"https://cdn.acme.com/b.mp4"}}}}'::jsonb); t := 'no error'; exception when others then t := sqlerrm; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t like 'E_FORBIDDEN%' and not has_function_privilege('authenticated', 'outreach_webchat__settings_check(jsonb)', 'execute') and not has_function_privilege('anon', 'outreach_webchat__settings_check(jsonb)', 'execute')
     and has_function_privilege('authenticated', 'outreach_webchat_inbox_update(uuid,jsonb)', 'execute') and has_function_privilege('authenticated', 'outreach_webchat_default_settings()', 'execute')
    then log := log || E'\nok   roles: member refused; grants unchanged on the redefined RPCs, check helper is service-only';
    else fails := fails + 1; log := log || E'\nFAIL roles: ' || t; end if;

  -- ============================================================ 6. stored copies of the old default placeholder (the data fix in 053)
  update outreach_webchat_inboxes set settings = '{"messages":{"placeholder":"Type a message…","greeting":"Hey"}}'::jsonb where id = ib;
  update outreach_webchat_inboxes set settings = settings #- '{messages,placeholder}' where settings#>>'{messages,placeholder}' in ('Type a message…', 'Type a message...');
  j := outreach_webchat__settings(ib);
  update outreach_webchat_inboxes set settings = '{"messages":{"placeholder":"Write to us"}}'::jsonb where id = ib;
  update outreach_webchat_inboxes set settings = settings #- '{messages,placeholder}' where settings#>>'{messages,placeholder}' in ('Type a message…', 'Type a message...');
  k := outreach_webchat__settings(ib);
  if (j#>>'{messages,placeholder}') = 'Ask a question…' and (j#>>'{messages,greeting}') = 'Hey' and (k#>>'{messages,placeholder}') = 'Write to us'
    then log := log || E'\nok   placeholder: a stored old default becomes the new one, a custom placeholder stays';
    else fails := fails + 1; log := log || E'\nFAIL placeholder: ' || (j#>>'{messages,placeholder}') || ' / ' || (k#>>'{messages,placeholder}'); end if;

  -- ============================================================ 7. bucket + storage policies
  select to_jsonb(b) into j from storage.buckets b where b.id = 'outreach-webchat-media';
  path := ws || '/' || ib || '/clip.mp4';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_member)::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects(bucket_id, name) values ('outreach-webchat-media', path); t := 'member inserted'; exception when others then t := 'member refused'; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin insert into storage.objects(bucket_id, name) values ('outreach-webchat-media', path); t := t || ', owner inserted'; exception when others then t := t || ', owner refused: ' || sqlerrm; end;
  begin insert into storage.objects(bucket_id, name) values ('outreach-webchat-media', gen_random_uuid() || '/x/clip.mp4'); t := t || ', foreign inserted'; exception when others then t := t || ', foreign refused'; end;
  n := (select count(*) from storage.objects where bucket_id = 'outreach-webchat-media' and name = path);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (j->>'public')::boolean and (j->>'file_size_limit')::bigint = 20971520 and (j->'allowed_mime_types') @> '["video/mp4","image/gif"]'::jsonb
     and t = 'member refused, owner inserted, foreign refused' and n = 1
    then log := log || E'\nok   bucket: public, 20 MB, clip types only; owner uploads into the workspace folder, member and foreign folder refused';
    else fails := fails + 1; log := log || E'\nFAIL bucket: ' || t || ' n=' || n || ' ' || coalesce(j::text, 'no bucket'); end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (webchat video 053)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
