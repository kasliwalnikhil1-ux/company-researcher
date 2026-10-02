-- 062_webchat_video_questions.sql — Video bubble: a suggested question can carry its own clip and a page link
-- ("Fix 1 - tab1", fix 2). Requires 053. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/062_webchat_video_questions.sql
--
-- launcher.video.questions was a list of texts. An entry may now also be an object:
--   { "text": "What does it cost?",                        -- required, 120 characters at most
--     "video_url": "https://…/pricing.mp4" | "preset:x",   -- the clip that plays in the expanded view when the question is clicked
--     "video_kind": "video" | "image",
--     "link_url": "https://…/pricing",                     -- opens in a new browser tab
--     "link_text": "See pricing" }                         -- the link's label, 40 characters at most ("Learn more" when empty)
-- A plain text stays valid (the question opens the chat and is sent), so stored settings need no rewrite.
--
-- Only outreach_webchat__settings_check() changes: 053's copy with the question loop replaced. The list still sits under
-- `launcher`, which outreach_webchat_public_config hands to the widget whole, so the public projection is unchanged.

create or replace function outreach_webchat__settings_check(ns jsonb) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare vb jsonb := ns#>'{launcher,video}'; k text; q jsonb;
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
  if vb ? 'questions' and jsonb_typeof(vb->'questions') <> 'null' then
    if jsonb_typeof(vb->'questions') <> 'array' then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions'; end if;
    if jsonb_array_length(vb->'questions') > 6 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (6 at most)'; end if;
    for q in select * from jsonb_array_elements(vb->'questions') loop
      -- a text, or a question with its own clip and / or page link
      if jsonb_typeof(q) = 'string' then
        if length(q#>>'{}') > 120 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)'; end if;
      elsif jsonb_typeof(q) = 'object' then
        if exists (select 1 from jsonb_object_keys(q) x where x not in ('text','video_url','video_kind','link_url','link_text')) then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (unknown field)'; end if;
        if jsonb_typeof(q->'text') is distinct from 'string' or btrim(q->>'text') = '' or length(q->>'text') > 120 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)'; end if;
        foreach k in array array['video_url','video_kind','link_url','link_text'] loop
          if q ? k and jsonb_typeof(q->k) not in ('string','null') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.%', k; end if;
        end loop;
        if coalesce(q->>'video_url', '') <> '' and ((q->>'video_url') !~* '^(https://[^[:space:]"<>]+|preset:[a-z0-9][a-z0-9._-]*)$' or length(q->>'video_url') > 1000 or (q->>'video_url') like '%..%') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.video_url'; end if;
        if q->>'video_kind' is not null and q->>'video_kind' not in ('video','image') then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions.video_kind'; end if;
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
