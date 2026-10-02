-- Smoke test — 053 web chat video bubble, privacy link, placeholder default; 062 question clips + page links; 065 languages. Builds fixtures, asserts, then RAISES so
-- everything rolls back. A passing run ends with "SMOKE OK". Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_13_webchat_video.sql
do $$
declare
  log text := ''; fails int := 0; j jsonb; k jsonb; t text; n int;
  ws uuid; u_owner uuid; u_member uuid; ib uuid; tok text; bad jsonb; path text;
begin
  select user_id into u_owner  from platform_user_access where status = 'active' order by created_at limit 1;
  select user_id into u_member from platform_user_access where status = 'active' order by created_at limit 1 offset 1;
  if u_member is null then raise exception 'SMOKE FAIL: this test needs two active app users'; end if;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke13', 'smoke13-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
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
      {"launcher":{"video":{"questions":[7]}}},
      {"launcher":{"video":{"questions":[{"video_url":"https://cdn.acme.com/a.mp4"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","video_url":"http://cdn.acme.com/a.mp4"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","video_url":"preset:../../secret"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","video_kind":"audio"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","link_url":"http://acme.com/pricing"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","link_url":"javascript:alert(1)"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","link_url":{"href":"https://acme.com"}}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","link_text":"01234567890123456789012345678901234567890"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","onclick":"alert(1)"}]}}},
      {"launcher":{"video":{"languages":"en"}}},
      {"launcher":{"video":{"languages":["en-GB"]}}},
      {"launcher":{"video":{"languages":[{"code":"english!"}]}}},
      {"launcher":{"video":{"languages":[{"code":"en-GB"},{"code":"en-gb"}]}}},
      {"launcher":{"video":{"languages":[{"code":"en-GB","flag":"../x"}]}}},
      {"launcher":{"video":{"languages":[{"code":"en-GB","onload":"x"}]}}},
      {"launcher":{"video":{"languages":[{"code":"aa"},{"code":"ab"},{"code":"ac"},{"code":"ad"},{"code":"ae"},{"code":"af"},{"code":"ag"},{"code":"ah"},{"code":"ai"}]}}},
      {"launcher":{"video":{"variants":{"en-GB":"https://cdn.acme.com/a.mp4"}}}},
      {"launcher":{"video":{"variants":[{"lang":"en-GB"}]}}},
      {"launcher":{"video":{"variants":[{"lang":"en-GB","url":"http://cdn.acme.com/a.mp4"}]}}},
      {"launcher":{"video":{"variants":[{"lang":"en-GB","url":"https://cdn.acme.com/a.mp4","kind":"audio"}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","video_variants":[{"lang":"x","url":"https://cdn.acme.com/a.mp4"}]}]}}},
      {"launcher":{"video":{"questions":[{"text":"x","video_variants":[{"lang":"en-GB","url":"javascript:alert(1)"}]}]}}},
      {"launcher":{"video":"on"}},
      {"messages":{"privacy_url":"acme.com/privacy"}},
      {"messages":{"privacy_url":"http://acme.com/privacy"}}
    ]'::jsonb) loop
    begin perform outreach_webchat_inbox_update(ib, jsonb_build_object('settings', bad)); t := t || ' ACCEPTED ' || bad::text;
    exception when others then if sqlerrm like 'E_PAYLOAD_INVALID%' then n := n + 1; else t := t || ' ' || sqlerrm; end if; end;
  end loop;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select settings into j from outreach_webchat_inboxes where id = ib;
  if n = 42 and t = '' and (j#>>'{launcher,video,shape}') = 'rounded' and (select count(*) from outreach_webchat_settings_history where inbox_id = ib) = 5
    then log := log || E'\nok   validation: 42 bad values refused (urls, enums, colours, question list, question clip / link, languages, clips per language, privacy link), settings + history untouched';
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

  -- ============================================================ 5b. a question with its own clip and page link (062), next to a plain text one
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin
    k := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"url":"https://cdn.acme.com/hello.mp4","enabled":true,"questions":[
           {"text":"What does it cost?","video_url":"https://cdn.acme.com/pricing.mp4","video_kind":"video","link_url":"https://acme.com/pricing","link_text":"See pricing"},
           "How do I start?",
           {"text":"Why you?","video_url":"preset:why-01.mp4","video_kind":"video","link_url":null},
           {"text":"Read the docs","link_url":"https://acme.com/docs"}]}}}}'::jsonb);
    t := 'saved';
  exception when others then t := sqlerrm; k := '{}'::jsonb; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  j := outreach_webchat_public_config(tok, 'https://acme.com');
  if t = 'saved' and jsonb_array_length(k#>'{settings,launcher,video,questions}') = 4
     and (j#>>'{settings,launcher,video,questions,0,text}') = 'What does it cost?' and (j#>>'{settings,launcher,video,questions,0,video_url}') = 'https://cdn.acme.com/pricing.mp4'
     and (j#>>'{settings,launcher,video,questions,0,link_url}') = 'https://acme.com/pricing' and (j#>>'{settings,launcher,video,questions,0,link_text}') = 'See pricing'
     and jsonb_typeof(j#>'{settings,launcher,video,questions,1}') = 'string' and (j#>>'{settings,launcher,video,questions,1}') = 'How do I start?'
     and (j#>>'{settings,launcher,video,questions,2,video_url}') = 'preset:why-01.mp4' and (j#>>'{settings,launcher,video,questions,3,link_url}') = 'https://acme.com/docs'
    then log := log || E'\nok   question clips: a question keeps its own clip, page link and link text; plain text questions still save; the widget config carries both';
    else fails := fails + 1; log := log || E'\nFAIL question clips: ' || t || ' ' || left((j#>'{settings,launcher,video,questions}')::text, 500); end if;

  -- ============================================================ 5c. the clips in several languages (065)
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', u_owner)::text, true);
  execute 'set local role authenticated';
  begin
    k := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"url":"https://cdn.acme.com/hello-uk.mp4",
           "languages":[{"code":"en-GB","label":"English (UK)","flag":"gb"},{"code":"en-AU","label":"English (Australia)","flag":"au"},{"code":"hi-IN","label":"Hindi","flag":"in"}],
           "variants":[{"lang":"en-GB","url":"https://cdn.acme.com/hello-uk.mp4","kind":"video"},{"lang":"en-AU","url":"https://cdn.acme.com/hello-au.mp4","kind":"video"},{"lang":"hi-IN","url":"preset:hello-hi.mp4","kind":"video"}],
           "questions":[{"text":"What does it cost?","video_url":"https://cdn.acme.com/p-uk.mp4","video_kind":"video",
                         "video_variants":[{"lang":"en-GB","url":"https://cdn.acme.com/p-uk.mp4","kind":"video"},{"lang":"hi-IN","url":"https://cdn.acme.com/p-hi.mp4","kind":"video"}]},
                        "How do I start?"]}}}}'::jsonb);
    -- two languages' main clips removed: the list is replaced, not merged
    j := outreach_webchat_inbox_update(ib, '{"settings":{"launcher":{"video":{"variants":[{"lang":"en-GB","url":"https://cdn.acme.com/hello-uk.mp4","kind":"video"}]}}}}'::jsonb);
    t := 'saved';
  exception when others then t := sqlerrm; k := '{}'::jsonb; j := '{}'::jsonb; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  bad := outreach_webchat_public_config(tok, 'https://acme.com');
  if t = 'saved' and jsonb_array_length(k#>'{settings,launcher,video,languages}') = 3 and jsonb_array_length(k#>'{settings,launcher,video,variants}') = 3 and (k#>>'{settings,launcher,video,variants,2,url}') = 'preset:hello-hi.mp4'
     and (bad#>>'{settings,launcher,video,languages,1,flag}') = 'au' and (bad#>>'{settings,launcher,video,languages,2,label}') = 'Hindi' and jsonb_array_length(bad#>'{settings,launcher,video,variants}') = 1
     and (bad#>>'{settings,launcher,video,questions,0,video_variants,1,url}') = 'https://cdn.acme.com/p-hi.mp4' and (bad#>>'{settings,launcher,video,url}') = 'https://cdn.acme.com/hello-uk.mp4'
     and jsonb_array_length(j#>'{settings,launcher,video,variants}') = 1 and jsonb_array_length(j#>'{settings,launcher,video,languages}') = 3
     and not has_function_privilege('authenticated', 'outreach_webchat__variants_check(jsonb,text)', 'execute') and not has_function_privilege('anon', 'outreach_webchat__variants_check(jsonb,text)', 'execute')
    then log := log || E'
ok   languages: the language list, the main clip per language and a question''s clips per language save and reach the widget; a clip list is replaced whole; the helper is service-only';
    else fails := fails + 1; log := log || E'
FAIL languages: ' || coalesce(t, '') || ' ' || coalesce(left((bad#>'{settings,launcher,video}')::text, 600), 'no video settings'); end if;

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

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (webchat video 053 + 062 + 065)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
