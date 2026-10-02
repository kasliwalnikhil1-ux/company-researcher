-- 065_webchat_video_languages.sql — Video bubble: the same clips in several languages, with a flag strip to switch.
-- Requires 062. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/065_webchat_video_languages.sql
--
--   launcher.video.languages      [{ "code": "en-GB", "label": "English (UK)", "flag": "gb" }, …]   8 at most; the first is the default
--   launcher.video.variants       [{ "lang": "en-GB", "url": "https://…/hello-uk.mp4", "kind": "video" }, …]   the main clip per language
--   questions[n].video_variants   the same list for a question's answer clip
-- `url` / `video_url` stay what they were: the default-language clip (the settings screen keeps them equal to the first
-- language's clip), so a widget from before this file and settings without languages work unchanged. The lists are
-- arrays, not maps, because outreach_webchat__merge replaces an array whole: removing a language's clip removes it.
-- `flag` names a file in public/widget/v1/flags (<flag>.svg).
--
-- Only validation changes: a new helper for a clip-per-language list, and 062's outreach_webchat__settings_check() with
-- the languages block, the two helper calls and `video_variants` in the question's field list. The lists sit under
-- `launcher`, which outreach_webchat_public_config hands to the widget whole, so the public projection is unchanged.

create or replace function outreach_webchat__variants_check(v jsonb, p_path text) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare x jsonb;
begin
  if v is null or jsonb_typeof(v) = 'null' then return; end if;
  if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) > 8 then raise exception 'E_PAYLOAD_INVALID: % (a list, 8 at most)', p_path; end if;
  for x in select * from jsonb_array_elements(v) loop
    if jsonb_typeof(x) <> 'object' then raise exception 'E_PAYLOAD_INVALID: %', p_path; end if;
    if exists (select 1 from jsonb_object_keys(x) k where k not in ('lang','url','kind')) then raise exception 'E_PAYLOAD_INVALID: % (unknown field)', p_path; end if;
    if jsonb_typeof(x->'lang') is distinct from 'string' or (x->>'lang') !~* '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$' then raise exception 'E_PAYLOAD_INVALID: %.lang', p_path; end if;
    if jsonb_typeof(x->'url') is distinct from 'string' or (x->>'url') !~* '^(https://[^[:space:]"<>]+|preset:[a-z0-9][a-z0-9._-]*)$' or length(x->>'url') > 1000 or (x->>'url') like '%..%' then raise exception 'E_PAYLOAD_INVALID: %.url', p_path; end if;
    if x->>'kind' is not null and x->>'kind' not in ('video','image') then raise exception 'E_PAYLOAD_INVALID: %.kind', p_path; end if;
  end loop;
end $$;
revoke all on function outreach_webchat__variants_check(jsonb, text) from public, anon, authenticated;
grant execute on function outreach_webchat__variants_check(jsonb, text) to service_role;

create or replace function outreach_webchat__settings_check(ns jsonb) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare vb jsonb := ns#>'{launcher,video}'; k text; q jsonb; codes text[] := '{}';
begin
  if coalesce(ns#>>'{messages,privacy_url}', '') <> '' and ((ns#>>'{messages,privacy_url}') !~* '^https://[^[:space:]"<>]+$' or length(ns#>>'{messages,privacy_url}') > 1000) then raise exception 'E_PAYLOAD_INVALID: privacy_url must be an https link'; end if;
  if vb is null or jsonb_typeof(vb) = 'null' then return; end if;
  if jsonb_typeof(vb) <> 'object' then raise exception 'E_PAYLOAD_INVALID: launcher.video'; end if;
  -- an uploaded / hosted clip (https) or a built-in one that ships with the widget (preset:<file>)
  if coalesce(vb->>'url', '') <> '' and ((vb->>'url') !~* '^(https://[^[:space:]"<>]+|preset:[a-z0-9][a-z0-9._-]*)$' or length(vb->>'url') > 1000 or (vb->>'url') like '%..%') then raise exception 'E_PAYLOAD_INVALID: launcher.video.url'; end if;
  if vb->>'kind' is not null and vb->>'kind' not in ('video','image') then raise exception 'E_PAYLOAD_INVALID: launcher.video.kind'; end if;
  if vb->>'shape' is not null and vb->>'shape' not in ('circle','rounded','square') then raise exception 'E_PAYLOAD_INVALID: launcher.video.shape'; end if;
  if vb->>'fit' is not null and vb->>'fit' not in ('cover','contain') then raise exception 'E_PAYLOAD_INVALID: launcher.video.fit'; end if;
  if vb->>'ratio' is not null and vb->>'ratio' !~ '^[0-9]{1,2}:[0-9]{1,2}$' then raise exception 'E_PAYLOAD_INVALID: launcher.video.ratio'; end if;
  if vb->>'expanded_ratio' is not null and vb->>'expanded_ratio' <> 'auto' and vb->>'expanded_ratio' !~ '^[0-9]{1,2}:[0-9]{1,2}$' then raise exception 'E_PAYLOAD_INVALID: launcher.video.expanded_ratio'; end if;
  if vb->>'questions_position' is not null and vb->>'questions_position' not in ('over','below') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions_position'; end if;
  foreach k in array array['border_color','question_bg','question_color','cta_bg','cta_color'] loop
    if vb->>k is not null and vb->>k !~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' then raise exception 'E_PAYLOAD_INVALID: launcher.video.%', k; end if;
  end loop;
  if length(coalesce(vb->>'cta_text', '')) > 40 then raise exception 'E_PAYLOAD_INVALID: launcher.video.cta_text'; end if;
  -- the languages the clips come in (the flag strip), and the main clip per language
  if vb ? 'languages' and jsonb_typeof(vb->'languages') <> 'null' then
    if jsonb_typeof(vb->'languages') <> 'array' then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages'; end if;
    if jsonb_array_length(vb->'languages') > 8 then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages (8 at most)'; end if;
    for q in select * from jsonb_array_elements(vb->'languages') loop
      if jsonb_typeof(q) <> 'object' then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages'; end if;
      if exists (select 1 from jsonb_object_keys(q) x where x not in ('code','label','flag')) then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages (unknown field)'; end if;
      if jsonb_typeof(q->'code') is distinct from 'string' or (q->>'code') !~* '^[a-z]{2,3}(-[a-z0-9]{2,8}){0,2}$' then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages.code'; end if;
      if lower(q->>'code') = any(codes) then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages (a language is listed twice)'; end if;
      codes := codes || lower(q->>'code');
      if q ? 'label' and (jsonb_typeof(q->'label') not in ('string','null') or length(coalesce(q->>'label', '')) > 40) then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages.label'; end if;
      if q ? 'flag' and jsonb_typeof(q->'flag') <> 'null' and (jsonb_typeof(q->'flag') <> 'string' or (q->>'flag') !~ '^[a-z]{2}(-[a-z]{2,4})?$') then raise exception 'E_PAYLOAD_INVALID: launcher.video.languages.flag'; end if;
    end loop;
  end if;
  perform outreach_webchat__variants_check(vb->'variants', 'launcher.video.variants');
  if vb ? 'questions' and jsonb_typeof(vb->'questions') <> 'null' then
    if jsonb_typeof(vb->'questions') <> 'array' then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions'; end if;
    if jsonb_array_length(vb->'questions') > 6 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (6 at most)'; end if;
    for q in select * from jsonb_array_elements(vb->'questions') loop
      -- a text, or a question with its own clip and / or page link
      if jsonb_typeof(q) = 'string' then
        if length(q#>>'{}') > 120 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)'; end if;
      elsif jsonb_typeof(q) = 'object' then
        if exists (select 1 from jsonb_object_keys(q) x where x not in ('text','video_url','video_kind','video_variants','link_url','link_text')) then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (unknown field)'; end if;
        if jsonb_typeof(q->'text') is distinct from 'string' or btrim(q->>'text') = '' or length(q->>'text') > 120 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)'; end if;
        foreach k in array array['video_url','video_kind','link_url','link_text'] loop
          if q ? k and jsonb_typeof(q->k) not in ('string','null') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.%', k; end if;
        end loop;
        if coalesce(q->>'video_url', '') <> '' and ((q->>'video_url') !~* '^(https://[^[:space:]"<>]+|preset:[a-z0-9][a-z0-9._-]*)$' or length(q->>'video_url') > 1000 or (q->>'video_url') like '%..%') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.video_url'; end if;
        if q->>'video_kind' is not null and q->>'video_kind' not in ('video','image') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.video_kind'; end if;
        perform outreach_webchat__variants_check(q->'video_variants', 'launcher.video.questions.video_variants');
        if coalesce(q->>'link_url', '') <> '' and ((q->>'link_url') !~* '^https://[^[:space:]"<>]+$' or length(q->>'link_url') > 1000) then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.link_url must be an https link'; end if;
        if length(coalesce(q->>'link_text', '')) > 40 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.link_text'; end if;
      else
        raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)';
      end if;
    end loop;
  end if;
end $$;
revoke all on function outreach_webchat__settings_check(jsonb) from public, anon, authenticated;
grant execute on function outreach_webchat__settings_check(jsonb) to service_role;
