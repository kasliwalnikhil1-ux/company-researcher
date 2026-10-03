-- 072_webchat_question_langs_voice_turns.sql — "Fix 1 - chatbot changes" (3 Oct 2026). Requires 069. Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/072_webchat_question_langs_voice_turns.sql
--
-- 1. Video bubble: a suggested question can be written in each of the bubble's languages.
--      launcher.video.questions[n].text_variants = [{ "lang": "hi-IN", "text": "इसकी कीमत क्या है?" }, …]   8 at most
--    `text` stays the default-language wording (the settings screen keeps it equal to the first language's), so an older
--    widget and settings without languages read the question as before. Validation only: the list sits under
--    `launcher`, which outreach_webchat_public_config hands to the widget whole.
-- 2. Voice no longer hands off on "after N assistant turns". Every spoken reply was a turn (the greeting and "are you
--    still there?" included) and the count spanned the whole conversation, so a second call was handed to the team
--    after its first question. A call keeps its own time limit; spoken handoff words and the agent's switch-to-chat
--    tool still hand off.
-- 3. Typed messages count only typed assistant turns for the same rule, so a long call no longer makes the next typed
--    message hand off at once.

create or replace function outreach_w72__patch(p_fn text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  -- bodies applied from a CRLF checkout carry \r: strip it so the anchors match
  def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(replace(p_pairs[i], chr(13), '') in def) = 0 then raise exception '072: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, replace(p_pairs[i], chr(13), ''), replace(p_pairs[i + 1], chr(13), ''));
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '072: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_w72__patch(text, text, text[]) from public, anon, authenticated;

-- ---- 1. a question's wording per language
create or replace function outreach_webchat__text_variants_check(v jsonb, p_path text) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare x jsonb;
begin
  if v is null or jsonb_typeof(v) = 'null' then return; end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 8 then raise exception 'E_PAYLOAD_INVALID: % (a list, 8 at most)', p_path; end if;
  for x in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(x) <> 'object' then raise exception 'E_PAYLOAD_INVALID: %', p_path; end if;
    if exists (select 1 from jsonb_object_keys(x) k where k not in ('lang','text')) then raise exception 'E_PAYLOAD_INVALID: % (unknown field)', p_path; end if;
    if jsonb_typeof(x->'lang') is distinct from 'string' or (x->>'lang') !~* '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$' then raise exception 'E_PAYLOAD_INVALID: %.lang', p_path; end if;
    if jsonb_typeof(x->'text') is distinct from 'string' or btrim(x->>'text') = '' or length(x->>'text') > 120 then raise exception 'E_PAYLOAD_INVALID: %.text (120 characters at most)', p_path; end if;
  end loop;
end $$;
revoke all on function outreach_webchat__text_variants_check(jsonb, text) from public, anon, authenticated;
grant execute on function outreach_webchat__text_variants_check(jsonb, text) to service_role;

select outreach_w72__patch('public.outreach_webchat__settings_check(jsonb)', 'outreach_webchat__text_variants_check', array[
  $a$'video_variants','link_url','link_text')$a$,
  $b$'video_variants','link_url','link_text','text_variants')$b$,
  $a$perform outreach_webchat__variants_check(q->'video_variants', 'launcher.video.questions.video_variants');$a$,
  $b$perform outreach_webchat__variants_check(q->'video_variants', 'launcher.video.questions.video_variants');
        perform outreach_webchat__text_variants_check(q->'text_variants', 'launcher.video.questions.text_variants');$b$]);

-- ---- 2. no turn-count handoff in a call
select outreach_w72__patch('public.outreach_webchat_v_voice_turns(uuid,uuid,jsonb)', '072: a call has no turn-count handoff', array[
  $a$  if not handoff and new_user and (select count(*) from outreach_webchat_ai_turns x where x.chat_id = k.chat_id) >= coalesce((st#>>'{ai,handoff,max_turns}')::int, 6) then
    handoff := true; reason := 'max_turns';
  end if;$a$,
  $b$  -- 072: a call has no turn-count handoff (its time limit ends it); handoff words and switch_to_chat still hand off$b$]);

-- ---- 3. typed messages count typed turns
select outreach_w72__patch('public.outreach_webchat_v_message(uuid,uuid,text,text,jsonb,text,jsonb,text)', 't.voice_call_id is null', array[
  $a$t where t.chat_id = c.id) >= coalesce((st#>>'{ai,handoff,max_turns}')::int, 6)$a$,
  $b$t where t.chat_id = c.id and t.voice_call_id is null) >= coalesce((st#>>'{ai,handoff,max_turns}')::int, 6)$b$]);

drop function if exists outreach_w72__patch(text, text, text[]);
