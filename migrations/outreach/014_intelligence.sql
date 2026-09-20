-- =============================================================================
-- Outreach Platform — 014 lead intelligence
--   item 13 profile enrichment (free on the fetch we already do; budgeted for the backlog)
--   item 14 AI variables generated ahead of time + bulk review; nothing AI-written renders until a person approved it
--   item 15 AI routing (decision stored once with its reason and facts)
--   item 4  originating sequence + step on every message (thread attribution, inbox filter by sequence)
-- The render context is built HERE, so the builder preview and the executor see exactly the same values.
-- =============================================================================

alter table outreach_ai_values add column if not exists locked_at timestamptz, add column if not exists attempts int not null default 0;

-- Searchable text for the lead filters "past company" and "skill" (case-insensitive `ilike` from the list page and the API)
alter table outreach_lead_profiles add column if not exists companies_text text, add column if not exists skills_text text;
create or replace function outreach_trg_lead_profile_text() returns trigger language plpgsql set search_path = public, extensions as $$
begin
  new.companies_text := (select lower(string_agg(x->>'company', ' | ')) from jsonb_array_elements(coalesce(new.experience, '[]'::jsonb)) x where nullif(x->>'company','') is not null);
  new.skills_text := lower(array_to_string(new.skills, ' | '));
  return new;
end $$;
drop trigger if exists outreach_lead_profile_text on outreach_lead_profiles;
create trigger outreach_lead_profile_text before insert or update of experience, skills on outreach_lead_profiles for each row execute function outreach_trg_lead_profile_text();
update outreach_lead_profiles set experience = experience where companies_text is null and experience is not null;

-- -----------------------------------------------------------------------------
-- Item 13 — storing a fetched profile. An empty section means "unknown, try later" (LinkedIn throttles full
-- sections silently): it NEVER overwrites stored data and never counts as "this person has no About".
-- p_profile: {about, current_title, current_company, current_started_on, experience[], education[], skills[], languages[],
--             profile_language, follower_count, connections_count, requested_sections[]}
-- -----------------------------------------------------------------------------
create or replace function outreach_save_lead_profile(p_lead uuid, p_profile jsonb, p_sender uuid, p_source text)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid; req text[]; empty text[] := '{}'; sec text; has boolean; all_empty boolean;
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

  insert into outreach_lead_profiles as p (lead_id, workspace_id, about, current_title, current_company, current_started_on, experience, education, skills, languages,
         profile_language, follower_count, connections_count, enriched_at, enriched_by_sender, source, empty_sections)
  values (p_lead, ws, nullif(trim(coalesce(p_profile->>'about','')), ''), nullif(p_profile->>'current_title',''), nullif(p_profile->>'current_company',''),
          nullif(p_profile->>'current_started_on','')::date,
          case when 'experience' = any(empty) then null else p_profile->'experience' end, case when 'education' = any(empty) then null else p_profile->'education' end,
          case when 'skills' = any(empty) then null else (select array_agg(x) from jsonb_array_elements_text(p_profile->'skills') x) end,
          case when 'languages' = any(empty) then null else (select array_agg(x) from jsonb_array_elements_text(p_profile->'languages') x) end,
          nullif(p_profile->>'profile_language',''), nullif(p_profile->>'follower_count','')::int, nullif(p_profile->>'connections_count','')::int,
          case when all_empty then null else now() end, p_sender, p_source, empty)
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
end $$;
revoke execute on function outreach_save_lead_profile(uuid,jsonb,uuid,text) from public, anon, authenticated;

create or replace function outreach_save_lead_posts(p_lead uuid, p_posts jsonb, p_sender uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid; latest timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then return; end if;
  select max(nullif(x->>'date','')::timestamptz) into latest from jsonb_array_elements(coalesce(p_posts,'[]'::jsonb)) x;
  insert into outreach_lead_profiles as p (lead_id, workspace_id, posts, posts_fetched_at, last_posted_at, enriched_by_sender)
  values (p_lead, ws, coalesce(p_posts,'[]'::jsonb), now(), latest, p_sender)
  on conflict (lead_id) do update set posts = excluded.posts, posts_fetched_at = now(), last_posted_at = coalesce(excluded.last_posted_at, p.last_posted_at), updated_at = now();
  delete from outreach_enrich_queue q where q.lead_id = p_lead and exists (select 1 from outreach_lead_profiles x where x.lead_id = p_lead and x.enriched_at is not null);
end $$;
revoke execute on function outreach_save_lead_posts(uuid,jsonb,uuid) from public, anon, authenticated;

-- Ask for enrichment (lead page "Re-enrich", bulk "Enrich", import tick box). Fresh (< 90 days) is skipped unless forced;
-- a never-enriched lead is always taken (GetSales' stale-only mode skips those — ours does not).
create or replace function outreach_request_enrichment(p_ws uuid, p_lead_ids uuid[], p_want_posts boolean default false, p_force boolean default false, p_reason text default 'manual')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare queued int; fresh int; no_id int;
begin
  perform outreach_require(p_ws, 'member');
  if coalesce(array_length(p_lead_ids,1),0) = 0 then return jsonb_build_object('queued', 0); end if;
  if array_length(p_lead_ids,1) > 5000 then raise exception 'E_TOO_MANY: max 5000 per request'; end if;
  select count(*) into no_id from outreach_leads l where l.workspace_id = p_ws and l.id = any(p_lead_ids) and l.public_identifier is null and l.provider_id is null;
  select count(*) into fresh from outreach_leads l join outreach_lead_profiles p on p.lead_id = l.id
   where l.workspace_id = p_ws and l.id = any(p_lead_ids) and not p_force and p.enriched_at > now() - interval '90 days';
  with ins as (
    insert into outreach_enrich_queue(lead_id, workspace_id, want_posts, requested_by, reason)
    select l.id, p_ws, p_want_posts, auth.uid(), p_reason from outreach_leads l left join outreach_lead_profiles p on p.lead_id = l.id
     where l.workspace_id = p_ws and l.id = any(p_lead_ids) and (l.public_identifier is not null or l.provider_id is not null)
       and not l.do_not_contact and (p_force or p.enriched_at is null or p.enriched_at < now() - interval '90 days')
       and outreach_client_visible(p_ws, l.client_id)
    on conflict (lead_id) do update set want_posts = outreach_enrich_queue.want_posts or excluded.want_posts, next_at = least(outreach_enrich_queue.next_at, now()), attempts = 0
    returning lead_id)
  select count(*) into queued from ins;
  update outreach_leads set enrich_status = 'waiting' where id in (select lead_id from outreach_enrich_queue where lead_id = any(p_lead_ids)) and enrich_status <> 'waiting';
  return jsonb_build_object('queued', queued, 'skipped_fresh', fresh, 'skipped_no_linkedin_id', no_id,
    'note', 'Background enrichment only uses profile views left over after the day''s sequence actions, at most 30% of a sender''s allowance, inside working hours. Senders at warm-up level 0–1 do none.');
end $$;

-- How many background profile views may this sender spend right now? (leftover after planned sequence work, ≤30% of the cap)
create or replace function outreach_enrich_allowance(p_sender uuid, p_priority boolean default false) returns int
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype; d date; b outreach_sender_budgets%rowtype; planned int; done_bg int; leftover int;
begin
  select * into s from outreach_senders where id = p_sender;
  if not found or s.status <> 'ok' or s.deleted_at is not null or s.provider <> 'LINKEDIN' then return 0; end if;
  if s.paused_until is not null and s.paused_until > now() then return 0; end if;
  if s.enrich_backoff_until is not null and s.enrich_backoff_until > now() then return 0; end if;
  if not outreach_in_schedule(p_sender, now()) then return 0; end if;
  if not p_priority and s.warmup_level <= 1 then return 0; end if;        -- 10–20 views a day: background work would starve the campaigns
  d := outreach_sender_local_date(p_sender, now());
  select * into b from outreach_sender_budgets where sender_id = p_sender and day = d and action_type = 'profile_view';
  if not found then return 0; end if;
  select count(*) into planned from outreach_actions a where a.sender_id = p_sender and a.action_type = 'profile_view' and a.status = 'queued'
     and outreach_sender_local_date(p_sender, a.scheduled_for) = d;
  select coalesce(actions, 0) into done_bg from outreach_plans where sender_id = p_sender and day = d and kind = 'enrich';
  leftover := b.cap - b.used - b.reserved - planned;
  if p_priority then return greatest(least(leftover, 5), 0); end if;
  return greatest(least(leftover, floor(b.cap * 0.3)::int - coalesce(done_bg, 0), 5), 0);   -- ≤5 per run keeps the pace human
end $$;
revoke execute on function outreach_enrich_allowance(uuid,boolean) from public, anon, authenticated;

create or replace function outreach_enrich_next(p_sender uuid, p_limit int)
returns table(lead_id uuid, want_posts boolean, priority boolean, provider_id text, public_identifier text)
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_senders%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into s from outreach_senders where id = p_sender;
  return query
    (select l.id, coalesce(q.want_posts, false), true, l.provider_id, l.public_identifier::text
       from outreach_enrollments e join outreach_leads l on l.id = e.lead_id left join outreach_enrich_queue q on q.lead_id = l.id
      where e.sender_id = p_sender and e.status = 'waiting_task' and e.wait_reason = 'enrichment' and coalesce(q.attempts, 0) < 3 and coalesce(q.next_at, now()) <= now()
      order by e.priority, e.created_at limit p_limit)
    union all
    (select l.id, q.want_posts, false, l.provider_id, l.public_identifier::text
       from outreach_enrich_queue q join outreach_leads l on l.id = q.lead_id
      where q.workspace_id = s.workspace_id and q.next_at <= now() and q.attempts < 3 and (l.client_id is null or s.client_id is null or l.client_id = s.client_id)
        and not exists (select 1 from outreach_enrollments e where e.lead_id = l.id and e.status = 'waiting_task' and e.wait_reason = 'enrichment')
      order by q.created_at limit p_limit);
end $$;
revoke execute on function outreach_enrich_next(uuid,int) from public, anon, authenticated;

create or replace function outreach_enrich_done(p_lead uuid, p_sender uuid, p_ok boolean, p_error text, p_background boolean) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare d date := outreach_sender_local_date(p_sender, now());
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_background then
    insert into outreach_plans(sender_id, day, kind, actions) values (p_sender, d, 'enrich', 1)
    on conflict (sender_id, day, kind) do update set actions = outreach_plans.actions + 1;
  end if;
  if p_ok then return; end if;
  update outreach_enrich_queue set attempts = attempts + 1, last_error = left(p_error, 300), next_at = now() + interval '6 hours' where lead_id = p_lead;
  if exists (select 1 from outreach_enrich_queue where lead_id = p_lead and attempts >= 3) then
    update outreach_leads set enrich_status = 'failed' where id = p_lead;
    delete from outreach_enrich_queue where lead_id = p_lead;
    perform outreach_release_waiting(p_lead, 'enrichment');   -- never hold a lead hostage to a profile we cannot read
  end if;
end $$;
revoke execute on function outreach_enrich_done(uuid,uuid,boolean,text,boolean) from public, anon, authenticated;

-- {{enrich.*}} variables (all have sensible empties so fallbacks work)
create or replace function outreach_lead_enrich_ctx(p_lead uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce((
    select jsonb_strip_nulls(jsonb_build_object(
      'about', left(p.about, 600),
      'current_title', p.current_title, 'current_company', p.current_company,
      'years_in_role', case when p.current_started_on is not null then greatest(floor(extract(epoch from age(now(), p.current_started_on)) / 31557600)::int, 0) end,
      'months_in_role', case when p.current_started_on is not null then (extract(year from age(now(), p.current_started_on)) * 12 + extract(month from age(now(), p.current_started_on)))::int end,
      'previous_company', (select x->>'company' from jsonb_array_elements(coalesce(p.experience,'[]'::jsonb)) with ordinality t(x, ord)
                            where not coalesce((x->>'current')::boolean, false) and nullif(x->>'company','') is not null and lower(x->>'company') <> lower(coalesce(p.current_company,'')) order by ord limit 1),
      'previous_title', (select x->>'title' from jsonb_array_elements(coalesce(p.experience,'[]'::jsonb)) with ordinality t(x, ord) where not coalesce((x->>'current')::boolean, false) order by ord limit 1),
      'school', p.education->0->>'school', 'degree', p.education->0->>'degree',
      'top_skill', p.skills[1], 'skills', array_to_string(p.skills[1:3], ', '),
      'language', coalesce(p.profile_language, p.languages[1]),
      'follower_count', p.follower_count, 'connections_count', p.connections_count,
      'recent_post', case when p.last_posted_at > now() - interval '60 days' then left(p.posts->0->>'text', 280) end,
      'recent_post_date', case when p.last_posted_at > now() - interval '60 days' then to_char(p.last_posted_at, 'Mon DD') end))
      from outreach_lead_profiles p where p.lead_id = p_lead), '{}'::jsonb)
$$;

-- The render context, for the executor, the planner AND the builder preview. {{ai.<key>}} resolves ONLY to approved text.
create or replace function outreach_render_context(p_lead uuid, p_sender uuid default null, p_enrollment uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; s outreach_senders%rowtype; ai jsonb; seed text;
begin
  select * into l from outreach_leads where id = p_lead;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then
    perform outreach_require(l.workspace_id, 'client_viewer');
    if not outreach_client_visible(l.workspace_id, l.client_id) then raise exception 'E_FORBIDDEN'; end if;
  end if;
  if p_sender is not null then select * into s from outreach_senders where id = p_sender and workspace_id = l.workspace_id; end if;
  select coalesce(jsonb_object_agg(v.key, x.text), '{}'::jsonb) into ai
    from outreach_ai_values x join outreach_ai_variables v on v.id = x.variable_id
   where x.lead_id = p_lead and x.status = 'approved' and nullif(trim(coalesce(x.text,'')), '') is not null;
  seed := coalesce(p_enrollment::text, p_lead::text || ':' || coalesce(p_sender::text, ''));
  return jsonb_build_object(
    'lead', to_jsonb(l) - 'custom' || jsonb_build_object('custom', l.custom),
    'sender', case when s.id is null then '{}'::jsonb else jsonb_build_object('id', s.id, 'display_name', s.display_name, 'full_name', s.display_name,
                'first_name', split_part(coalesce(s.display_name,''), ' ', 1), 'last_name', nullif(substr(coalesce(s.display_name,''), length(split_part(coalesce(s.display_name,''), ' ', 1)) + 2), ''),
                'booking_link', s.booking_link, 'signature', s.signature, 'public_identifier', s.public_identifier) end,
    'enrich', outreach_lead_enrich_ctx(p_lead), 'ai', ai, 'seed', seed);
end $$;

-- -----------------------------------------------------------------------------
-- Item 14 — AI variables: request → generate (worker) → review (person) → usable
-- -----------------------------------------------------------------------------
create or replace function outreach_ai_generate_request(p_ws uuid, p_variable uuid, p_lead_ids uuid[], p_sequence uuid default null, p_regenerate boolean default false)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_ai_variables%rowtype; bid uuid; n int; kept int;
begin
  perform outreach_require(p_ws, 'member');
  select * into v from outreach_ai_variables where id = p_variable and workspace_id = p_ws;
  if not found then raise exception 'E_NOT_FOUND: variable'; end if;
  if coalesce(array_length(p_lead_ids,1),0) = 0 then raise exception 'E_PAYLOAD_INVALID: lead_ids required'; end if;
  if array_length(p_lead_ids,1) > 2000 then raise exception 'E_TOO_MANY: max 2000 leads per batch'; end if;
  insert into outreach_ai_batches(workspace_id, variable_id, sequence_id, requested_by, total) values (p_ws, p_variable, p_sequence, auth.uid(), 0) returning id into bid;
  with up as (
    insert into outreach_ai_values as x (workspace_id, lead_id, variable_id, batch_id, status)
    select p_ws, l.id, p_variable, bid, 'pending' from outreach_leads l
     where l.workspace_id = p_ws and l.id = any(p_lead_ids) and outreach_client_visible(p_ws, l.client_id)
    on conflict (lead_id, variable_id) do update set batch_id = excluded.batch_id, status = 'pending', attempts = 0, text = null, facts = '[]', error = null, edited = false,
           approved_by = null, approved_at = null, locked_at = null, updated_at = now()
      where p_regenerate or x.status in ('failed','blank','skipped','pending')
    returning 1)
  select count(*) into n from up;
  select count(*) into kept from outreach_ai_values x where x.variable_id = p_variable and x.lead_id = any(p_lead_ids) and x.batch_id is distinct from bid;
  update outreach_ai_batches set total = n, status = case when n = 0 then 'done' else 'generating' end, finished_at = case when n = 0 then now() end where id = bid;
  -- profiles the variable needs but we do not have yet go to the enrichment queue
  perform outreach_request_enrichment(p_ws, (select array_agg(l.id) from outreach_leads l left join outreach_lead_profiles p on p.lead_id = l.id
                                               where l.id = any(p_lead_ids) and l.workspace_id = p_ws and p.enriched_at is null), v.needs_posts, false, 'ai_variable');
  return jsonb_build_object('batch_id', bid, 'to_generate', n, 'kept_existing', kept,
    'note', 'Lines are generated ahead of time and wait in the review table. Only approved lines are ever sent; everything else uses the fallback.');
end $$;

create or replace function outreach_ai_claim_pending(p_limit int default 20)
returns table(value_id uuid, workspace_id uuid, lead_id uuid, variable_id uuid, key text, prompt text, fallback text, needs_posts boolean, max_chars int, enriched boolean)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    with c as (
      select x.id from outreach_ai_values x left join outreach_lead_profiles p on p.lead_id = x.lead_id
       where x.status = 'pending' and x.attempts < 3 and (x.locked_at is null or x.locked_at < now() - interval '10 minutes')
         -- wait for enrichment when it is on its way; give up waiting after a day and work from the basic fields
         and (p.enriched_at is not null or not exists (select 1 from outreach_enrich_queue q where q.lead_id = x.lead_id) or x.created_at < now() - interval '1 day')
       order by x.created_at limit p_limit for update of x skip locked)
    update outreach_ai_values x set locked_at = now(), attempts = x.attempts + 1 from c, outreach_ai_variables v
     where x.id = c.id and v.id = x.variable_id
    returning x.id, x.workspace_id, x.lead_id, x.variable_id, v.key, v.prompt, v.fallback, v.needs_posts, v.max_chars,
              exists (select 1 from outreach_lead_profiles p where p.lead_id = x.lead_id and p.enriched_at is not null);
end $$;
revoke execute on function outreach_ai_claim_pending(int) from public, anon, authenticated;

-- three failed tries → the line is marked failed, the fallback is used and the lead stops waiting (called from outreach_release_waits)
create or replace function outreach_ai_fail_exhausted() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; n int := 0;
begin
  for r in update outreach_ai_values set status = 'failed', error = coalesce(error, 'AI did not answer after three tries'), locked_at = null, updated_at = now()
            where status = 'pending' and attempts >= 3 and (locked_at is null or locked_at < now() - interval '10 minutes') returning lead_id, batch_id loop
    perform outreach_release_waiting(r.lead_id, 'ai_review');
    update outreach_ai_batches b set status = case when exists (select 1 from outreach_ai_values y where y.batch_id = b.id and y.status = 'generated') then 'review' else 'done' end, finished_at = now()
     where b.id = r.batch_id and b.status = 'generating' and not exists (select 1 from outreach_ai_values y where y.batch_id = b.id and y.status = 'pending');
    n := n + 1;
  end loop;
  return n;
end $$;
revoke execute on function outreach_ai_fail_exhausted() from public, anon, authenticated;

create or replace function outreach_ai_value_result(p_id uuid, p_text text, p_facts jsonb, p_model text, p_error text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare x outreach_ai_values%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_ai_values set text = nullif(trim(coalesce(p_text,'')), ''), facts = coalesce(p_facts, '[]'::jsonb), model = p_model, error = left(p_error, 300), locked_at = null, updated_at = now(),
         status = case when p_error is not null then 'failed' when nullif(trim(coalesce(p_text,'')), '') is null then 'blank' else 'generated' end
   where id = p_id and status = 'pending' returning * into x;
  if not found then return; end if;
  if x.batch_id is not null and not exists (select 1 from outreach_ai_values y where y.batch_id = x.batch_id and y.status = 'pending') then
    update outreach_ai_batches set status = case when exists (select 1 from outreach_ai_values y where y.batch_id = x.batch_id and y.status = 'generated') then 'review' else 'done' end,
           finished_at = now() where id = x.batch_id and status = 'generating';
  end if;
  -- blank / failed lines need no review: the fallback is used, so do not keep the lead waiting
  if x.status in ('blank','failed') then perform outreach_release_waiting(x.lead_id, 'ai_review'); end if;
end $$;
revoke execute on function outreach_ai_value_result(uuid,text,jsonb,text,text) from public, anon, authenticated;

create or replace function outreach_ai_review_list(p_ws uuid, p_batch uuid default null, p_status text default 'generated', p_limit int default 100, p_offset int default 0)
returns table(value_id uuid, lead_id uuid, lead_name text, company text, title text, variable_key text, variable_name text, body text, facts jsonb, status text, edited boolean, fallback text, updated_at timestamptz, total bigint)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return query
    select x.id, l.id, l.full_name, l.company, coalesce(l.title, l.headline), v.key, v.name, x.text, x.facts, x.status, x.edited, v.fallback, x.updated_at, count(*) over ()
      from outreach_ai_values x join outreach_leads l on l.id = x.lead_id join outreach_ai_variables v on v.id = x.variable_id
     where x.workspace_id = p_ws and (p_batch is null or x.batch_id = p_batch) and (p_status is null or p_status = 'all' or x.status = p_status)
       and outreach_client_visible(p_ws, l.client_id)
     order by x.updated_at desc, x.id limit least(p_limit, 500) offset p_offset;
end $$;

-- approve | skip | edit (= approve with your text) | regenerate. "approve all" = pass every id of the batch.
create or replace function outreach_ai_review(p_value_ids uuid[], p_action text, p_text text default null)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare x record; cnt int := 0; leads uuid[] := '{}'; batches uuid[] := '{}'; b uuid; lim int;
begin
  if p_action not in ('approve','skip','edit','regenerate') then raise exception 'E_PAYLOAD_INVALID: action must be approve, skip, edit or regenerate'; end if;
  if coalesce(array_length(p_value_ids,1),0) = 0 then return jsonb_build_object('updated', 0); end if;
  if array_length(p_value_ids,1) > 2000 then raise exception 'E_TOO_MANY: max 2000 per request'; end if;
  if p_action = 'edit' and (array_length(p_value_ids,1) <> 1 or nullif(trim(coalesce(p_text,'')), '') is null) then raise exception 'E_PAYLOAD_INVALID: edit takes one id and a text'; end if;
  for x in select v.id, v.workspace_id, v.lead_id, v.batch_id, v.status, v.text, var.max_chars from outreach_ai_values v join outreach_ai_variables var on var.id = v.variable_id where v.id = any(p_value_ids) for update of v loop
    perform outreach_require(x.workspace_id, 'member');
    if p_action = 'approve' then
      if x.status not in ('generated','approved','skipped') or nullif(trim(coalesce(x.text,'')), '') is null then continue; end if;   -- there must be a line to approve
      update outreach_ai_values set status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = x.id;
    elsif p_action = 'edit' then
      lim := greatest(x.max_chars, 20) * 2;
      if length(p_text) > lim then raise exception 'E_PAYLOAD_INVALID: text exceeds % characters', lim; end if;
      update outreach_ai_values set text = trim(p_text), edited = true, status = 'approved', approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = x.id;
    elsif p_action = 'skip' then
      update outreach_ai_values set status = 'skipped', approved_by = null, approved_at = null, updated_at = now() where id = x.id;
    else
      update outreach_ai_values set status = 'pending', attempts = 0, text = null, facts = '[]', error = null, edited = false, approved_by = null, approved_at = null, locked_at = null, updated_at = now() where id = x.id;
      update outreach_ai_batches set status = 'generating', finished_at = null where id = x.batch_id;
    end if;
    cnt := cnt + 1;
    if not (x.lead_id = any(leads)) then leads := leads || x.lead_id; end if;
    if x.batch_id is not null and not (x.batch_id = any(batches)) then batches := batches || x.batch_id; end if;
  end loop;
  foreach b in array batches loop
    update outreach_ai_batches set status = 'done' where id = b and status = 'review'
       and not exists (select 1 from outreach_ai_values y where y.batch_id = b and y.status in ('generated','pending'));
  end loop;
  if p_action <> 'regenerate' then
    for x in select unnest(leads) lead_id loop perform outreach_release_waiting(x.lead_id, 'ai_review'); end loop;
  end if;
  return jsonb_build_object('updated', cnt, 'action', p_action);
end $$;

-- Workspace AI / finder settings without the secrets (the keys are written by the outreach-workspace-secrets function)
create or replace function outreach_workspace_ai_settings(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_workspace_secrets%rowtype;
begin
  perform outreach_require(p_ws, 'manager');
  select * into r from outreach_workspace_secrets where workspace_id = p_ws;
  return jsonb_build_object('llm_provider', coalesce(r.llm_provider, 'platform'), 'llm_model', r.llm_model, 'llm_key_hint', r.llm_key_hint, 'uses_own_key', r.llm_key_enc is not null,
    'finders', (select coalesce(jsonb_agg(jsonb_build_object('provider', x->>'provider', 'hint', x->>'hint')), '[]'::jsonb) from jsonb_array_elements(coalesce(r.finder_keys,'[]'::jsonb)) x),
    'verifier', case when r.verifier is not null then jsonb_build_object('provider', r.verifier->>'provider', 'hint', r.verifier->>'hint') end,
    'booking_webhook_secret', case when outreach_role_in(p_ws) = 'owner' or outreach_is_service() then r.booking_secret end);
end $$;

-- -----------------------------------------------------------------------------
-- Item 15 — AI routing: the worker's queue. The verdict itself is written by outreach_ai_route_decide (011).
-- -----------------------------------------------------------------------------
create or replace function outreach_ai_route_pending(p_limit int default 20)
returns table(enrollment_id uuid, node_id text, workspace_id uuid, lead_id uuid, routes jsonb, attempts int)
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    with c as (select d.enrollment_id, d.node_id from outreach_ai_route_decisions d where d.decided_at is null and d.attempts < 3 order by d.requested_at limit p_limit for update skip locked)
    update outreach_ai_route_decisions d set attempts = d.attempts + 1 from c where d.enrollment_id = c.enrollment_id and d.node_id = c.node_id
    returning d.enrollment_id, d.node_id, d.workspace_id, d.lead_id, outreach_enrollment_graph(d.enrollment_id)->'nodes'->d.node_id->'config'->'routes', d.attempts;
end $$;
revoke execute on function outreach_ai_route_pending(int) from public, anon, authenticated;

-- facts the router (and the AI variable writer) may use: profile + enrichment + custom fields. GetSales' router sees 7 fields.
create or replace function outreach_lead_ai_facts(p_lead uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare l outreach_leads%rowtype; p outreach_lead_profiles%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into l from outreach_leads where id = p_lead;
  select * into p from outreach_lead_profiles where lead_id = p_lead;
  return jsonb_strip_nulls(jsonb_build_object('name', l.full_name, 'headline', l.headline, 'title', coalesce(p.current_title, l.title), 'company', coalesce(p.current_company, l.company),
    'location', l.location, 'about', left(p.about, 1500), 'role_started', p.current_started_on,
    'past_roles', (select jsonb_agg(jsonb_build_object('company', x->>'company', 'title', x->>'title', 'start', x->>'start', 'end', x->>'end')) from (select x from jsonb_array_elements(coalesce(p.experience,'[]'::jsonb)) x limit 6) t),
    'education', (select jsonb_agg(jsonb_build_object('school', x->>'school', 'degree', x->>'degree', 'field', x->>'field')) from (select x from jsonb_array_elements(coalesce(p.education,'[]'::jsonb)) x limit 3) t),
    'skills', to_jsonb(p.skills[1:15]), 'languages', to_jsonb(p.languages), 'followers', p.follower_count, 'connections', p.connections_count,
    'recent_posts', (select jsonb_agg(jsonb_build_object('date', x->>'date', 'text', left(x->>'text', 600), 'reactions', x->'reactions')) from (select x from jsonb_array_elements(coalesce(p.posts,'[]'::jsonb)) x limit 3) t),
    'custom_fields', nullif(l.custom, '{}'::jsonb), 'enriched', p.enriched_at is not null));
end $$;
revoke execute on function outreach_lead_ai_facts(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Item 4 — which sequence, step and sender produced each message
-- -----------------------------------------------------------------------------
create or replace function outreach_graph_step_numbers(p_graph jsonb) returns jsonb
language plpgsql immutable as $$
declare res jsonb := '{}'; queue text[]; visited text[] := '{}'; cur text; n jsonb; i int := 0; b record;
begin
  queue := array[p_graph->>'start'];
  while array_length(queue,1) > 0 loop
    cur := queue[1]; queue := queue[2:];
    if cur is null or cur = any(visited) then continue; end if;
    visited := visited || cur;
    n := p_graph->'nodes'->cur;
    if n is null then continue; end if;
    if outreach_is_executable_node(n->>'type') or (n->>'type') in ('manual_task','call_task','ai_draft_approval') then i := i + 1; res := res || jsonb_build_object(cur, i); end if;
    if n->>'next' is not null then queue := queue || (n->>'next'); end if;
    if jsonb_typeof(n->'branches') = 'object' then for b in select value from jsonb_each_text(n->'branches') loop queue := queue || b.value; end loop; end if;
  end loop;
  return res;
end $$;

create or replace function outreach_thread_attribution(p_chat uuid)
returns table(message_id uuid, kind text, sequence_id uuid, sequence_name text, node_id text, step_number int, step_label text, node_type text, variant_id text, variant_label text,
              sender_name text, sent_by_name text, replying_to_message_id uuid)
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_FORBIDDEN'; end if;
  return query
    select m.id,
           case when m.direction = 'in' then 'inbound' when m.action_id is not null and a.action_type <> 'reply' then 'automated' else 'manual' end,
           q.id, q.name, a.node_id,
           (outreach_graph_step_numbers(g.graph)->>a.node_id)::int,
           coalesce(g.graph->'nodes'->a.node_id->>'label', initcap(replace(coalesce(g.graph->'nodes'->a.node_id->>'type', a.action_type::text), '_', ' '))),
           coalesce(g.graph->'nodes'->a.node_id->>'type', a.action_type::text), a.variant_id,
           (select x->>'label' from jsonb_array_elements(coalesce(g.graph->'nodes'->a.node_id->'config'->'variants','[]'::jsonb)) x where x->>'id' = a.variant_id),
           sd.display_name,
           case when m.direction = 'out' and (m.action_id is null or a.action_type = 'reply') then coalesce(mem.display_name, mem.email::text) end,
           case when m.direction = 'in' and m.replied_to_action_id is not null then (select o.id from outreach_messages o where o.action_id = m.replied_to_action_id and o.chat_id = m.chat_id order by o.sent_at desc limit 1) end
      from outreach_messages m
      left join outreach_actions a on a.id = coalesce(m.action_id, m.replied_to_action_id)
      left join outreach_enrollments e on e.id = a.enrollment_id
      left join outreach_sequences q on q.id = e.sequence_id
      left join lateral (select coalesce((select v.graph from outreach_sequence_versions v where v.sequence_id = e.sequence_id and v.version = e.pinned_version), q.graph) as graph) g on true
      left join outreach_senders sd on sd.id = coalesce(a.sender_id, c.sender_id)
      left join outreach_members mem on mem.workspace_id = m.workspace_id and mem.user_id = m.sent_by
     where m.chat_id = p_chat
     order by m.sent_at;
end $$;

-- inbox "filter by sequence": every thread that carries a step of that sequence
create or replace function outreach_sequence_chat_ids(p_sequence uuid)
returns setof uuid language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
  return query
    select distinct m.chat_id from outreach_messages m join outreach_actions a on a.id = coalesce(m.action_id, m.replied_to_action_id)
      join outreach_enrollments e on e.id = a.enrollment_id where e.sequence_id = p_sequence and m.workspace_id = s.workspace_id limit 5000;
end $$;

-- Lead timeline: adds AI routing verdicts, milestones, recoveries and holds to what 005 already showed
create or replace function outreach_lead_timeline(p_lead uuid)
returns table(at timestamptz, kind text, title text, data jsonb)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_leads where id = p_lead;
  if ws is null then return; end if;
  perform outreach_require(ws, 'client_viewer');
  return query
    select x.at, x.kind, x.title, x.data from (
      select a.executed_at as at, 'action'::text as kind, initcap(replace(a.action_type::text,'_',' ')) || ' ' || a.status::text || coalesce(' — ' || case when a.status in ('failed','skipped') then outreach_reason_text(a.error_code, a.decision) end, '') as title,
             jsonb_build_object('id', a.id, 'sender_id', a.sender_id, 'node_id', a.node_id, 'variant_id', a.variant_id, 'decision', a.decision, 'error_code', a.error_code) as data
        from outreach_actions a where a.lead_id = p_lead and a.executed_at is not null
      union all
      select m.sent_at, 'message', case when m.direction = 'in' then 'Reply received' else 'Message sent' end, jsonb_build_object('id', m.id, 'chat_id', m.chat_id, 'text', left(coalesce(m.text,''), 200), 'intent', m.intent, 'action_id', m.action_id, 'replied_to_action_id', m.replied_to_action_id)
        from outreach_messages m join outreach_chats c on c.id = m.chat_id where c.lead_id = p_lead
      union all
      select e.created_at, 'enrollment', 'Enrolled' || case when e.rule_id is not null then ' by an auto-enrol rule' else '' end, jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'sender_id', e.sender_id, 'rule_id', e.rule_id)
        from outreach_enrollments e where e.lead_id = p_lead
      union all
      select e.completed_at, 'enrollment', 'Enrollment ' || replace(e.status::text,'_',' '), jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id, 'reason', e.exit_reason, 'reason_text', outreach_reason_text(e.exit_reason))
        from outreach_enrollments e where e.lead_id = p_lead and e.completed_at is not null
      union all
      select e.held_at, 'enrollment', 'Held for review after a reply', jsonb_build_object('id', e.id, 'sequence_id', e.sequence_id) from outreach_enrollments e where e.lead_id = p_lead and e.held_at is not null
      union all
      select t.created_at, 'task', t.title, jsonb_build_object('id', t.id, 'kind', t.kind, 'completed_at', t.completed_at, 'result', t.result) from outreach_tasks t where t.lead_id = p_lead
      union all
      select d.decided_at, 'ai_route', 'AI routing → ' || coalesce(d.branch,'?'), jsonb_build_object('enrollment_id', d.enrollment_id, 'node_id', d.node_id, 'branch', d.branch, 'reason', d.reason, 'facts', d.facts)
        from outreach_ai_route_decisions d where d.lead_id = p_lead and d.decided_at is not null
      union all
      select ms.at, 'milestone', initcap(ms.kind), jsonb_build_object('kind', ms.kind, 'source', ms.source, 'value', ms.value, 'sequence_id', ms.sequence_id) from outreach_lead_milestones ms where ms.lead_id = p_lead
      union all
      select p.enriched_at, 'enrichment', 'Profile enriched', jsonb_build_object('source', p.source, 'sender_id', p.enriched_by_sender, 'empty_sections', p.empty_sections) from outreach_lead_profiles p where p.lead_id = p_lead and p.enriched_at is not null
    ) x order by 1 desc nulls last limit 400;
end $$;

do $$
declare f text;
begin
  for f in select unnest(array[
    'outreach_request_enrichment(uuid,uuid[],boolean,boolean,text)','outreach_lead_enrich_ctx(uuid)','outreach_render_context(uuid,uuid,uuid)',
    'outreach_ai_generate_request(uuid,uuid,uuid[],uuid,boolean)','outreach_ai_review_list(uuid,uuid,text,int,int)','outreach_ai_review(uuid[],text,text)',
    'outreach_workspace_ai_settings(uuid)','outreach_thread_attribution(uuid)','outreach_sequence_chat_ids(uuid)','outreach_lead_timeline(uuid)']) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
-- outreach_lead_enrich_ctx exposes profile data: members only, through outreach_render_context
revoke execute on function outreach_lead_enrich_ctx(uuid) from authenticated;
