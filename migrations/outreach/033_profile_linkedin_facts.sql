-- 033 — LinkedIn profile facts on enrichment (Sept 2026)
--
-- The provider's profile answer carries more than the sections we store: open profile, Premium, open to work, hiring,
-- creator / influencer, whether the sender can InMail, the degree of connection, shared connections, websites and the
-- contact details a 1st-degree connection shows. Enrichment dropped all of it, so a lead page could not say whether a
-- lead is an Open Profile. They are kept in one jsonb column on outreach_lead_profiles:
--   linkedin  {is_open_profile, is_premium, can_send_inmail, is_open_to_work, is_hiring, is_creator, is_influencer,
--              network_distance, shared_connections_count, connected_at, websites[], creator_website{url,description},
--              hashtags[], emails[], phones[], addresses[], socials[{type,name}], birthdate{month,day}, country, pronoun}
-- network_distance, shared_connections_count, can_send_inmail and connected_at are as seen by enriched_by_sender.
-- A key that comes back null never replaces a stored value (same rule as the sections).
--
-- Idempotent.

alter table public.outreach_lead_profiles add column if not exists linkedin jsonb not null default '{}'::jsonb;
comment on column public.outreach_lead_profiles.linkedin is 'Top-level LinkedIn profile facts (open profile, Premium, open to work, degree, contact info …) from the last enrichment';

create or replace function public.outreach_save_lead_profile(p_lead uuid, p_profile jsonb, p_sender uuid, p_source text)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'extensions'
as $function$
declare ws uuid; req text[]; empty text[] := '{}'; sec text; has boolean; all_empty boolean; facts jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then return jsonb_build_object('saved', false); end if;
  select coalesce(array_agg(x), '{}') into req from jsonb_array_elements_text(coalesce(p_profile->'requested_sections', '["about","experience","education","skills","languages"]'::jsonb)) x;
  foreach sec in array req loop
    has := case sec when 'about' then nullif(trim(coalesce(p_profile->>'about','')), '') is not null
                    when 'experience' then jsonb_typeof(p_profile->'experience') = 'array' and jsonb_array_length(p_profile->'experience') > 0
                    when 'education' then jsonb_typeof(p_profile->'education') = 'array' and jsonb_array_length(p_profile->'education') > 0
                    when 'skills' then jsonb_typeof(p_profile->'skills') = 'array' and jsonb_array_length(p_profile->'skills') > 0
                    when 'languages' then jsonb_typeof(p_profile->'languages') = 'array' and jsonb_array_length(p_profile->'languages') > 0
                    else true end;
    if not has then empty := empty || sec; end if;
  end loop;
  all_empty := array_length(req,1) is not null and coalesce(array_length(empty,1),0) = array_length(req,1);
  facts := case when jsonb_typeof(p_profile->'linkedin') = 'object' then jsonb_strip_nulls(p_profile->'linkedin') else '{}'::jsonb end;

  insert into outreach_lead_profiles as p (lead_id, workspace_id, about, current_title, current_company, current_started_on, experience, education, skills, languages,
         profile_language, follower_count, connections_count, linkedin, enriched_at, enriched_by_sender, source, empty_sections)
  values (p_lead, ws, nullif(trim(coalesce(p_profile->>'about','')), ''), nullif(p_profile->>'current_title',''), nullif(p_profile->>'current_company',''),
          nullif(p_profile->>'current_started_on','')::date,
          case when 'experience' = any(empty) then null else p_profile->'experience' end, case when 'education' = any(empty) then null else p_profile->'education' end,
          case when 'skills' = any(empty) then null else (select array_agg(x) from jsonb_array_elements_text(p_profile->'skills') x) end,
          case when 'languages' = any(empty) then null else (select array_agg(x) from jsonb_array_elements_text(p_profile->'languages') x) end,
          nullif(p_profile->>'profile_language',''), nullif(p_profile->>'follower_count','')::int, nullif(p_profile->>'connections_count','')::int,
          facts, case when all_empty then null else now() end, p_sender, p_source, empty)
  on conflict (lead_id) do update set
    about = coalesce(excluded.about, p.about),
    current_title = coalesce(excluded.current_title, p.current_title),
    current_company = coalesce(excluded.current_company, p.current_company),
    current_started_on = coalesce(excluded.current_started_on, p.current_started_on),
    experience = coalesce(excluded.experience, p.experience),
    education = coalesce(excluded.education, p.education),
    skills = coalesce(excluded.skills, p.skills),
    languages = coalesce(excluded.languages, p.languages),
    profile_language = coalesce(excluded.profile_language, p.profile_language),
    follower_count = coalesce(excluded.follower_count, p.follower_count),
    connections_count = coalesce(excluded.connections_count, p.connections_count),
    linkedin = coalesce(p.linkedin, '{}'::jsonb) || excluded.linkedin,
    enriched_at = case when all_empty then p.enriched_at else now() end,
    enriched_by_sender = case when all_empty then p.enriched_by_sender else excluded.enriched_by_sender end,
    source = case when all_empty then p.source else excluded.source end,
    empty_sections = excluded.empty_sections, updated_at = now();

  -- two throttled (all-empty) answers in a row → back the sender off full-section requests for 6 hours
  if p_sender is not null then
    update outreach_senders set enrich_empty_streak = case when all_empty then enrich_empty_streak + 1 else 0 end,
           enrich_backoff_until = case when all_empty and enrich_empty_streak + 1 >= 2 then now() + interval '6 hours' else enrich_backoff_until end
     where id = p_sender;
  end if;
  if not all_empty then
    update outreach_leads set enrich_status = 'done', enriched_at = now() where id = p_lead;
    delete from outreach_enrich_queue where lead_id = p_lead and not want_posts;
    perform outreach_release_waiting(p_lead, 'enrichment');
  end if;
  return jsonb_build_object('saved', not all_empty, 'empty_sections', to_jsonb(empty), 'throttled', all_empty);
end $function$;
revoke execute on function public.outreach_save_lead_profile(uuid,jsonb,uuid,text) from public, anon, authenticated;
