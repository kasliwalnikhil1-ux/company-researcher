-- 067_insert_variables.sql — everything the Insert Variables popup lists renders at send time
-- (ai-fields-json-changes.md, Part B; as built: docs/outreach/AI-FIELDS.md). The PRD calls this file 066.
-- Requires 001–066. Idempotent. Additive: templates written before it render exactly as before.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/067_insert_variables.sql
--
--   1. Schema      outreach_ai_variables.builtin, outreach_senders.label, outreach_companies (the lead's current company).
--   2. Templates   outreach_template_normalize ({% if %} tags and quoted spintax → the native syntax), used by the length
--                  check and by "which AI variables does this graph use".
--   3. Context     new {{enrich.*}} keys, lead tags and work-email domain, sender email and label, `account`, `now`.
--   4. Built-ins   three AI variables every workspace has; written without a person (never in Needs you or Activity).
--   5. Patches     existing functions changed in place with asserted anchors, like 063 / 066.

-- ===============================================================================================================
-- 0. In-place patch helpers (dropped at the end of this file)
-- ===============================================================================================================
create or replace function outreach_hub__patch(p_fn text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(p_pairs[i] in def) = 0 then raise exception '067: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '067: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_hub__patch(text, text, text[]) from public, anon, authenticated;

create or replace function outreach_hub__patch_view(p_view text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  def := pg_get_viewdef(p_view::regclass, true);
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(p_pairs[i] in def) = 0 then raise exception '067: view % anchor not found: %', p_view, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '067: view % marker missing after the patch: %', p_view, p_marker; end if;
  execute format('create or replace view %I with (security_invoker = true) as %s', p_view, def);
  return true;
end $$;
revoke all on function outreach_hub__patch_view(text, text, text[]) from public, anon, authenticated;

-- ===============================================================================================================
-- 1. Schema
-- ===============================================================================================================
alter table outreach_ai_variables add column if not exists builtin boolean not null default false;
comment on column outreach_ai_variables.builtin is 'A platform variable every workspace has (contact_first_name, company_conversation, position_conversational). Its prompt lives in code; `prompt` is the description shown in Setup. mode review = on, off = off.';
alter table outreach_senders add column if not exists label text;   -- optional; {{ sender_label }}
comment on column outreach_senders.label is 'Optional name of the sender for messages ({{ sender_label }}); the display name is used when empty.';

-- The lead's current company, fetched once from LinkedIn and kept for 90 days. One row per company per workspace,
-- shared by every lead who works there. A row with only linkedin_id + fetched_at means "looked up, nothing found".
create table if not exists outreach_companies (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  linkedin_id           text,                 -- numeric LinkedIn company id
  public_identifier     text,                 -- slug
  name text, domain text, website text, phone text, industry text,
  size text,                                  -- employee range, e.g. '51-200'
  employees_on_linkedin int, founded_year int, tagline text, about text,
  specialties text[], hashtags text[], followers int,
  hq_city text, hq_region text, hq_country text, hq_address text,
  fetched_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (workspace_id, linkedin_id)
);
create index if not exists outreach_companies_ws_domain_idx on outreach_companies(workspace_id, lower(domain));
alter table outreach_companies enable row level security;
select outreach__policy('outreach_companies', 'companies_select', 'select', 'workspace_id in (select outreach_workspace_ids())');
revoke insert, update, delete, truncate on outreach_companies from anon, authenticated;
revoke all on outreach_companies from anon;
grant select on outreach_companies to authenticated, service_role;

-- ===============================================================================================================
-- 2. Templates: {% if %} tags and quoted spintax
-- ===============================================================================================================
-- Mirrors normalizeTemplate() in lib/outreach/render.ts: the same five replacements in the same order.
create or replace function outreach_template_normalize(p_text text) returns text
language sql immutable set search_path = public, extensions as $$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p_text, ''),
    '\{\{\s*"([^"{}]*\|[^"{}]*)"\s*\|\s*spintax\s*\}\}', '{\1}', 'g'),                             -- {{ "a|b" | spintax }} → {a|b}
    '\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*==\s*"([^"{}%]*)"\s*-?%\}', '{{#if \1 == "\2"}}', 'g'),
    '\{%-?\s*if\s+([a-zA-Z0-9_.]+)\s*-?%\}', '{{#if \1}}', 'g'),
    '\{%-?\s*else\s*-?%\}', '{{else}}', 'g'),
    '\{%-?\s*endif\s*-?%\}', '{{/if}}', 'g')
$$;

-- the server's length check counts {{ "Hey|Hello" | spintax }} as spintax
select outreach_hub__patch('public.outreach_spintax_info(text)', 'outreach_template_normalize', array[
  $a$declare t text := coalesce(p_text, '');$a$,
  $b$declare t text := outreach_template_normalize(coalesce(p_text, ''));$b$]);

-- Which AI variables does a graph use? 066's two patterns, plus the tag form of a conditional and the three built-ins,
-- which are written as {{ ai_contact_first_name }} (no dot).
create or replace function outreach_sequence_ai_keys(p_graph jsonb) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct t.k), '{}') from (
    select m[1] as k from regexp_matches(coalesce(p_graph::text, ''), '\{\{\s*#?(?:if\s+)?ai\.([a-z][a-z0-9_]*)', 'g') m
    union
    select m[1] from regexp_matches(coalesce(p_graph::text, ''), '\{%-?\s*if\s+ai\.([a-z][a-z0-9_]*)', 'g') m
    union
    select m[1] from regexp_matches(coalesce(p_graph::text, ''), '"field"\s*:\s*"ai\.([a-z][a-z0-9_]*)', 'g') m
    union
    select m[1] from regexp_matches(coalesce(p_graph::text, ''), '(?:\{\{\s*(?:#if\s+)?|\{%-?\s*if\s+)ai_(contact_first_name|company_conversation|position_conversational)\M', 'g') m
  ) t
$$;

-- ===============================================================================================================
-- 3. Countries, locations and the small text helpers of the render context
-- ===============================================================================================================
create or replace function outreach__countries() returns jsonb language sql immutable set search_path = public, extensions as $$
  select '{"AF":"Afghanistan","AL":"Albania","DZ":"Algeria","AD":"Andorra","AO":"Angola","AR":"Argentina","AM":"Armenia","AU":"Australia","AT":"Austria","AZ":"Azerbaijan",
  "BS":"Bahamas","BH":"Bahrain","BD":"Bangladesh","BB":"Barbados","BY":"Belarus","BE":"Belgium","BZ":"Belize","BJ":"Benin","BT":"Bhutan","BO":"Bolivia","BA":"Bosnia and Herzegovina",
  "BW":"Botswana","BR":"Brazil","BN":"Brunei","BG":"Bulgaria","BF":"Burkina Faso","BI":"Burundi","KH":"Cambodia","CM":"Cameroon","CA":"Canada","CV":"Cape Verde","TD":"Chad",
  "CL":"Chile","CN":"China","CO":"Colombia","CD":"Democratic Republic of the Congo","CG":"Republic of the Congo","CR":"Costa Rica","CI":"Côte d''Ivoire","HR":"Croatia","CU":"Cuba",
  "CY":"Cyprus","CZ":"Czechia","DK":"Denmark","DJ":"Djibouti","DO":"Dominican Republic","EC":"Ecuador","EG":"Egypt","SV":"El Salvador","EE":"Estonia","SZ":"Eswatini","ET":"Ethiopia",
  "FJ":"Fiji","FI":"Finland","FR":"France","GA":"Gabon","GM":"Gambia","GE":"Georgia","DE":"Germany","GH":"Ghana","GR":"Greece","GT":"Guatemala","GN":"Guinea","GY":"Guyana","HT":"Haiti",
  "HN":"Honduras","HK":"Hong Kong","HU":"Hungary","IS":"Iceland","IN":"India","ID":"Indonesia","IR":"Iran","IQ":"Iraq","IE":"Ireland","IL":"Israel","IT":"Italy","JM":"Jamaica","JP":"Japan",
  "JO":"Jordan","KZ":"Kazakhstan","KE":"Kenya","KW":"Kuwait","KG":"Kyrgyzstan","LA":"Laos","LV":"Latvia","LB":"Lebanon","LS":"Lesotho","LR":"Liberia","LY":"Libya","LI":"Liechtenstein",
  "LT":"Lithuania","LU":"Luxembourg","MO":"Macao","MG":"Madagascar","MW":"Malawi","MY":"Malaysia","MV":"Maldives","ML":"Mali","MT":"Malta","MR":"Mauritania","MU":"Mauritius","MX":"Mexico",
  "MD":"Moldova","MC":"Monaco","MN":"Mongolia","ME":"Montenegro","MA":"Morocco","MZ":"Mozambique","MM":"Myanmar","NA":"Namibia","NP":"Nepal","NL":"Netherlands","NZ":"New Zealand",
  "NI":"Nicaragua","NE":"Niger","NG":"Nigeria","MK":"North Macedonia","NO":"Norway","OM":"Oman","PK":"Pakistan","PS":"Palestine","PA":"Panama","PG":"Papua New Guinea","PY":"Paraguay",
  "PE":"Peru","PH":"Philippines","PL":"Poland","PT":"Portugal","PR":"Puerto Rico","QA":"Qatar","RO":"Romania","RU":"Russia","RW":"Rwanda","SA":"Saudi Arabia","SN":"Senegal","RS":"Serbia",
  "SC":"Seychelles","SL":"Sierra Leone","SG":"Singapore","SK":"Slovakia","SI":"Slovenia","SO":"Somalia","ZA":"South Africa","KR":"South Korea","SS":"South Sudan","ES":"Spain",
  "LK":"Sri Lanka","SD":"Sudan","SR":"Suriname","SE":"Sweden","CH":"Switzerland","SY":"Syria","TW":"Taiwan","TJ":"Tajikistan","TZ":"Tanzania","TH":"Thailand","TG":"Togo",
  "TT":"Trinidad and Tobago","TN":"Tunisia","TR":"Türkiye","TM":"Turkmenistan","UG":"Uganda","UA":"Ukraine","AE":"United Arab Emirates","GB":"United Kingdom","US":"United States",
  "UY":"Uruguay","UZ":"Uzbekistan","VE":"Venezuela","VN":"Vietnam","YE":"Yemen","ZM":"Zambia","ZW":"Zimbabwe"}'::jsonb
$$;

create or replace function outreach_country_name(p_code text) returns text language sql immutable set search_path = public, extensions as $$
  select outreach__countries() ->> upper(btrim(coalesce(p_code, '')))
$$;

-- ISO code of a country given as a code or a name (the names LinkedIn writes, plus a few everyday ones). Null when unknown.
create or replace function outreach_country_code(p_country text) returns text language sql immutable set search_path = public, extensions as $$
  with x as (select lower(btrim(coalesce(p_country, ''))) as c)
  select coalesce(
    (select upper(x.c) from x where length(x.c) = 2 and outreach__countries() ? upper(x.c)),
    (select e.key from x, jsonb_each_text(outreach__countries()) e where lower(e.value) = x.c limit 1),
    (select a.code from x join (values ('turkey', 'TR'), ('czech republic', 'CZ'), ('uk', 'GB'), ('great britain', 'GB'), ('england', 'GB'), ('usa', 'US'),
            ('united states of america', 'US'), ('uae', 'AE'), ('the netherlands', 'NL'), ('holland', 'NL'), ('korea', 'KR'), ('republic of korea', 'KR'),
            ('russian federation', 'RU'), ('viet nam', 'VN'), ('ivory coast', 'CI'), ('hong kong sar', 'HK'), ('macau', 'MO'), ('swaziland', 'SZ'), ('burma', 'MM')) a(name, code) on a.name = x.c))
$$;

-- The timezone of a country that has one (or where nearly everyone lives in one). Countries that span several
-- (US, CA, AU, BR, RU, MX, ID, KZ, MN, CD) stay empty: a wrong morning / evening is worse than none.
create or replace function outreach_country_tz(p_country text) returns text language sql immutable set search_path = public, extensions as $$
  select ('{"IN":"Asia/Kolkata","GB":"Europe/London","IE":"Europe/Dublin","DE":"Europe/Berlin","FR":"Europe/Paris","NL":"Europe/Amsterdam","BE":"Europe/Brussels","LU":"Europe/Luxembourg",
  "CH":"Europe/Zurich","AT":"Europe/Vienna","IT":"Europe/Rome","ES":"Europe/Madrid","PT":"Europe/Lisbon","SE":"Europe/Stockholm","NO":"Europe/Oslo","DK":"Europe/Copenhagen",
  "FI":"Europe/Helsinki","IS":"Atlantic/Reykjavik","PL":"Europe/Warsaw","CZ":"Europe/Prague","SK":"Europe/Bratislava","HU":"Europe/Budapest","RO":"Europe/Bucharest","BG":"Europe/Sofia",
  "GR":"Europe/Athens","HR":"Europe/Zagreb","SI":"Europe/Ljubljana","RS":"Europe/Belgrade","BA":"Europe/Sarajevo","ME":"Europe/Podgorica","MK":"Europe/Skopje","AL":"Europe/Tirane",
  "EE":"Europe/Tallinn","LV":"Europe/Riga","LT":"Europe/Vilnius","UA":"Europe/Kiev","BY":"Europe/Minsk","MD":"Europe/Chisinau","TR":"Europe/Istanbul","CY":"Asia/Nicosia","MT":"Europe/Malta",
  "IL":"Asia/Jerusalem","AE":"Asia/Dubai","SA":"Asia/Riyadh","QA":"Asia/Qatar","KW":"Asia/Kuwait","BH":"Asia/Bahrain","OM":"Asia/Muscat","JO":"Asia/Amman","LB":"Asia/Beirut",
  "EG":"Africa/Cairo","MA":"Africa/Casablanca","TN":"Africa/Tunis","DZ":"Africa/Algiers","NG":"Africa/Lagos","GH":"Africa/Accra","KE":"Africa/Nairobi","TZ":"Africa/Dar_es_Salaam",
  "UG":"Africa/Kampala","ET":"Africa/Addis_Ababa","RW":"Africa/Kigali","ZA":"Africa/Johannesburg","SN":"Africa/Dakar","CI":"Africa/Abidjan","CM":"Africa/Douala","ZM":"Africa/Lusaka",
  "ZW":"Africa/Harare","MU":"Indian/Mauritius","SG":"Asia/Singapore","MY":"Asia/Kuala_Lumpur","TH":"Asia/Bangkok","VN":"Asia/Ho_Chi_Minh","PH":"Asia/Manila","HK":"Asia/Hong_Kong",
  "TW":"Asia/Taipei","JP":"Asia/Tokyo","KR":"Asia/Seoul","CN":"Asia/Shanghai","PK":"Asia/Karachi","BD":"Asia/Dhaka","LK":"Asia/Colombo","NP":"Asia/Kathmandu","NZ":"Pacific/Auckland",
  "AR":"America/Argentina/Buenos_Aires","CL":"America/Santiago","CO":"America/Bogota","PE":"America/Lima","UY":"America/Montevideo","PY":"America/Asuncion","VE":"America/Caracas",
  "EC":"America/Guayaquil","BO":"America/La_Paz","CR":"America/Costa_Rica","PA":"America/Panama","GT":"America/Guatemala","DO":"America/Santo_Domingo","PR":"America/Puerto_Rico",
  "JM":"America/Jamaica","GE":"Asia/Tbilisi","AM":"Asia/Yerevan","AZ":"Asia/Baku","UZ":"Asia/Tashkent","IR":"Asia/Tehran","IQ":"Asia/Baghdad"}'::jsonb) ->> outreach_country_code(p_country)
$$;

-- lead.location ("Bengaluru, Karnataka, India") → {city, region, country}. 3+ parts: first, second-to-last, last.
-- 2 parts: city, country (city, region when the second part is not a country and the profile's country is known).
-- 1 part: a country when it is one, else a city. The country falls back to the profile's country code.
create or replace function outreach_location_parts(p_location text, p_country_code text) returns jsonb
language plpgsql immutable set search_path = public, extensions as $$
declare parts text[]; n int; city text; region text; country text; by_code text := outreach_country_name(p_country_code);
begin
  select coalesce(array_agg(btrim(x) order by ord), '{}') into parts from unnest(string_to_array(coalesce(p_location, ''), ',')) with ordinality t(x, ord) where btrim(x) <> '';
  n := coalesce(array_length(parts, 1), 0);
  if n >= 3 then city := parts[1]; region := parts[n - 1]; country := parts[n];
  elsif n = 2 then
    city := parts[1];
    if outreach_country_code(parts[2]) is null and by_code is not null then region := parts[2]; else country := parts[2]; end if;
  elsif n = 1 then
    if length(parts[1]) > 2 and outreach_country_code(parts[1]) is not null then country := parts[1]; else city := parts[1]; end if;
  end if;
  return jsonb_strip_nulls(jsonb_build_object('city', city, 'region', region, 'country', coalesce(country, by_code)));
end $$;

-- "2 yrs 3 mos" / "1 yr" / "8 mos"
create or replace function outreach__duration_text(p_start date) returns text language sql stable set search_path = public, extensions as $$
  select case when p_start is null or p_start > current_date then null
              when d.y = 0 and d.m = 0 then 'less than a month'
              else concat_ws(' ', case when d.y > 0 then d.y || case when d.y = 1 then ' yr' else ' yrs' end end, case when d.m > 0 then d.m || case when d.m = 1 then ' mo' else ' mos' end end) end
    from (select extract(year from age(current_date, p_start))::int as y, extract(month from age(current_date, p_start))::int as m) d
$$;

-- A profile social ({type, name}) as a link. A bare handle becomes https://x.com/<handle> or https://facebook.com/<handle>.
create or replace function outreach__social_url(p_socials jsonb, p_kind text) returns text language sql immutable set search_path = public, extensions as $$
  select case when s.v is null then null
              when s.v ~* '^https?://' then s.v
              when s.v ~* '^(www\.)?(twitter|x|facebook|fb)\.com/' then 'https://' || s.v
              when p_kind = 'twitter' then 'https://x.com/' || ltrim(s.v, '@')
              else 'https://facebook.com/' || ltrim(s.v, '@') end
    from (select (select nullif(btrim(x->>'name'), '') from jsonb_array_elements(case when jsonb_typeof(p_socials) = 'array' then p_socials else '[]'::jsonb end) x
                   where nullif(btrim(x->>'name'), '') is not null
                     and case when p_kind = 'twitter' then lower(coalesce(x->>'type', '')) in ('twitter', 'x') else lower(coalesce(x->>'type', '')) in ('facebook', 'fb') end
                   limit 1) as v) s
$$;

-- {{enrich.*}} variables (all have sensible empties so fallbacks work). 014's keys, plus the ones the Insert Variables
-- popup lists. The location parts come from the lead itself, so they exist before the profile is stored.
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
      'top_skill', p.skills[1], 'skills', nullif(array_to_string(p.skills[1:3], ', '), ''),
      'language', coalesce(p.profile_language, p.languages[1]),
      'follower_count', p.follower_count, 'connections_count', p.connections_count,
      'recent_post', case when p.last_posted_at > now() - interval '60 days' then left(p.posts->0->>'text', 280) end,
      'recent_post_date', case when p.last_posted_at > now() - interval '60 days' then to_char(p.last_posted_at, 'Mon DD') end)
      || jsonb_build_object(
      'sn_id', nullif(p.linkedin->>'sales_navigator_id', ''),
      'last_enrich_at', to_char(p.enriched_at, 'Mon DD, YYYY'),
      'twitter_url', outreach__social_url(p.linkedin->'socials', 'twitter'),
      'facebook_url', outreach__social_url(p.linkedin->'socials', 'facebook'),
      'phone', nullif(p.linkedin->'phones'->>0, ''),
      'location_city', loc.j->>'city', 'location_region', loc.j->>'region', 'location_country', loc.j->>'country',
      'location_timezone', outreach_country_tz(coalesce(loc.j->>'country', p.linkedin->>'country')),
      'current_started_on', to_char(p.current_started_on, 'Mon YYYY'),
      'current_duration', outreach__duration_text(p.current_started_on),
      -- up to 3 roles: "Head of Growth at Acme (2022–present); Growth Manager at Swiggy (2019–2022)"
      'experience_summary', (select string_agg(
           concat_ws(' at ', nullif(e.x->>'title', ''), nullif(e.x->>'company', ''))
           || case when nullif(e.x->>'start', '') is null then ''
                   when coalesce((e.x->>'current')::boolean, false) then ' (' || left(e.x->>'start', 4) || '–present)'
                   when nullif(e.x->>'end', '') is null or left(e.x->>'end', 4) = left(e.x->>'start', 4) then ' (' || left(e.x->>'start', 4) || ')'
                   else ' (' || left(e.x->>'start', 4) || '–' || left(e.x->>'end', 4) || ')' end, '; ' order by e.ord)
         from (select x, ord from jsonb_array_elements(coalesce(p.experience, '[]'::jsonb)) with ordinality t(x, ord)
                where nullif(x->>'title', '') is not null or nullif(x->>'company', '') is not null order by ord limit 3) e),
      'education_field', nullif(p.education->0->>'field', ''),
      -- up to 2 entries: "MBA, Marketing — IIM Bangalore; B.Tech — NIT Trichy"
      'education_summary', (select string_agg(
           case when concat_ws(', ', nullif(e.x->>'degree', ''), nullif(e.x->>'field', '')) <> '' then concat_ws(', ', nullif(e.x->>'degree', ''), nullif(e.x->>'field', '')) || ' — ' else '' end
           || (e.x->>'school'), '; ' order by e.ord)
         from (select x, ord from jsonb_array_elements(coalesce(p.education, '[]'::jsonb)) with ordinality t(x, ord) where nullif(x->>'school', '') is not null order by ord limit 2) e),
      -- up to 3 posts, newest first, 280 characters each, a blank line between them
      'last_3_posts', (select string_agg(left(e.x->>'text', 280), E'\n\n' order by e.rn)
         from (select x, row_number() over (order by nullif(x->>'date', '') desc nulls last, ord) as rn
                 from jsonb_array_elements(coalesce(p.posts, '[]'::jsonb)) with ordinality t(x, ord)
                where nullif(btrim(coalesce(x->>'text', '')), '') is not null
                order by nullif(x->>'date', '') desc nulls last, ord limit 3) e)))
      from outreach_leads l
      left join outreach_lead_profiles p on p.lead_id = l.id
      cross join lateral (select outreach_location_parts(l.location, p.linkedin->>'country') as j) loc
     where l.id = p_lead), '{}'::jsonb)
$$;

-- the lead's tag names, "vip, q4"
create or replace function outreach__lead_tags(p_lead uuid) returns text language sql stable security definer set search_path = public, extensions as $$
  select string_agg(t.name, ', ' order by t.name) from outreach_lead_tags lt join outreach_tags t on t.id = lt.tag_id where lt.lead_id = p_lead
$$;

-- {{ sender_email }}: a mailbox sends from its own address; a LinkedIn sender uses its linked mailbox, else the owner's email
create or replace function outreach__sender_email(s outreach_senders) returns text language sql stable security definer set search_path = public, extensions as $$
  select case when s.id is null then null
    when s.provider::text in ('GMAIL', 'OUTLOOK', 'IMAP') then
      coalesce(case when s.public_identifier like '%@%' then s.public_identifier end, case when s.display_name like '%@%' then s.display_name end, s.owner_email::text)
    else coalesce((select m.public_identifier from outreach_senders m
                    where m.parent_sender_id = s.id and m.deleted_at is null and m.provider::text in ('GMAIL', 'OUTLOOK', 'IMAP') and m.public_identifier like '%@%'
                    order by (m.status::text = 'ok') desc, m.created_at limit 1), s.owner_email::text) end
$$;

-- `account`: the stored company of the lead's current role (else of lead.company_id, else by domain). {} when none.
create or replace function outreach__render_account(l outreach_leads) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_companies%rowtype; cid text;
begin
  select nullif(t.x->>'company_id', '') into cid
    from outreach_lead_profiles p, jsonb_array_elements(coalesce(p.experience, '[]'::jsonb)) with ordinality t(x, ord)
   where p.lead_id = l.id and coalesce((t.x->>'current')::boolean, false) and nullif(t.x->>'company_id', '') is not null order by t.ord limit 1;
  if cid is not null then select * into c from outreach_companies k where k.workspace_id = l.workspace_id and k.linkedin_id = cid; end if;
  if c.id is null and nullif(l.company_id, '') is not null then select * into c from outreach_companies k where k.workspace_id = l.workspace_id and k.linkedin_id = l.company_id; end if;
  if c.id is null and nullif(l.company_domain, '') is not null then
    select * into c from outreach_companies k where k.workspace_id = l.workspace_id and lower(k.domain) = lower(l.company_domain) order by k.fetched_at desc nulls last limit 1;
  end if;
  if c.id is null then return '{}'::jsonb; end if;
  return jsonb_strip_nulls(jsonb_build_object('id', c.id, 'name', c.name, 'domain', c.domain, 'website', c.website,
    'linkedin_url', 'https://www.linkedin.com/company/' || coalesce(c.public_identifier, c.linkedin_id), 'linkedin_id', c.linkedin_id,
    'phone', c.phone, 'industry', c.industry, 'size', c.size, 'founded_year', c.founded_year, 'tagline', c.tagline, 'about', left(c.about, 600),
    'specialties', to_jsonb(c.specialties), 'hashtags', to_jsonb(c.hashtags), 'followers', c.followers, 'employees_on_linkedin', c.employees_on_linkedin,
    'hq', jsonb_build_object('city', c.hq_city, 'region', c.hq_region, 'country', c.hq_country, 'address', c.hq_address)));
end $$;

-- `now`: today's date parts in a timezone (unknown or empty → UTC). time_of_day: 05–11 morning, 12–16 afternoon, else evening.
create or replace function outreach__render_now(p_tz text) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare ts timestamp; h int;
begin
  begin ts := now() at time zone coalesce(nullif(btrim(p_tz), ''), 'UTC');
  exception when others then ts := now() at time zone 'UTC'; end;
  h := extract(hour from ts)::int;
  return jsonb_build_object('day', to_char(ts, 'FMDD'), 'month', to_char(ts, 'FMMonth'), 'weekday', to_char(ts, 'FMDay'), 'year', to_char(ts, 'YYYY'),
    'time_of_day', case when h between 5 and 11 then 'morning' when h between 12 and 16 then 'afternoon' else 'evening' end);
end $$;

-- ---- The render context: lead tags + work-email domain, sender email + label, account, now
select outreach_hub__patch('public.outreach_render_context(uuid,uuid,uuid)', 'outreach__render_account', array[
  $a$declare l outreach_leads%rowtype; s outreach_senders%rowtype; ai jsonb; seed text;$a$,
  $b$declare l outreach_leads%rowtype; s outreach_senders%rowtype; ai jsonb; seed text; en jsonb;$b$,
  $a$and nullif(trim(coalesce(x.text,'')), '') is not null;$a$,
  $b$and nullif(trim(coalesce(x.text,'')), '') is not null
     and not (v.builtin and v.mode = 'off');   -- a built-in that is switched off: the raw field is used
  en := outreach_lead_enrich_ctx(p_lead);$b$,
  $a$'lead', to_jsonb(l) - 'custom' || jsonb_build_object('custom', l.custom),$a$,
  $b$'lead', to_jsonb(l) - 'custom' || jsonb_build_object('custom', l.custom, 'tags', outreach__lead_tags(l.id), 'work_email_domain', nullif(split_part(coalesce(l.email_work::text, ''), '@', 2), '')),$b$,
  $a$'signature', s.signature, 'public_identifier', s.public_identifier) end,$a$,
  $b$'signature', s.signature, 'public_identifier', s.public_identifier, 'email', outreach__sender_email(s), 'label', nullif(btrim(coalesce(s.label, '')), ''), 'timezone', s.timezone) end,$b$,
  $a$'enrich', outreach_lead_enrich_ctx(p_lead), 'ai', ai, 'seed', seed);$a$,
  $b$'enrich', en, 'ai', ai, 'account', outreach__render_account(l), 'now', outreach__render_now(coalesce(en->>'location_timezone', s.timezone)), 'seed', seed);$b$]);

-- ---- Sender settings: the optional label
select outreach_hub__patch('public.outreach_update_sender(uuid,jsonb)', $m$p_patch ? 'label'$m$, array[
  $a$  update outreach_senders set
    display_name = coalesce(p_patch->>'display_name', display_name),$a$,
  $b$  if p_patch ? 'label' and length(btrim(coalesce(p_patch->>'label', ''))) > 80 then raise exception 'E_PAYLOAD_INVALID: the label can be up to 80 characters'; end if;
  update outreach_senders set
    display_name = coalesce(p_patch->>'display_name', display_name),
    label = case when p_patch ? 'label' then nullif(btrim(p_patch->>'label'), '') else label end,$b$]);

-- ---- Companies (service): is a fetch due, and store one
create or replace function outreach_company_due(p_ws uuid, p_linkedin_id text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if nullif(btrim(coalesce(p_linkedin_id, '')), '') is null then return false; end if;
  return not exists (select 1 from outreach_companies c where c.workspace_id = p_ws and c.linkedin_id = p_linkedin_id and c.fetched_at > now() - interval '90 days');
end $$;

-- p: {linkedin_id, public_identifier, name, domain, website, phone, industry, size, employees_on_linkedin, founded_year, tagline,
--     about, specialties[], hashtags[], followers, hq: {city, region, country, address}}. A field that is missing keeps what is stored.
create or replace function outreach_company_save(p_ws uuid, p jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare cid uuid; lid text := nullif(btrim(coalesce(p->>'linkedin_id', '')), '');
  arr_s text[] := case when jsonb_typeof(p->'specialties') = 'array' and jsonb_array_length(p->'specialties') > 0 then (select array_agg(left(x, 120)) from jsonb_array_elements_text(p->'specialties') x) end;
  arr_h text[] := case when jsonb_typeof(p->'hashtags') = 'array' and jsonb_array_length(p->'hashtags') > 0 then (select array_agg(left(x, 80)) from jsonb_array_elements_text(p->'hashtags') x) end;
  num_re constant text := '^[0-9]{1,9}$';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if lid is null then raise exception 'E_PAYLOAD_INVALID: linkedin_id required'; end if;
  insert into outreach_companies as c (workspace_id, linkedin_id, public_identifier, name, domain, website, phone, industry, size, employees_on_linkedin, founded_year,
         tagline, about, specialties, hashtags, followers, hq_city, hq_region, hq_country, hq_address, fetched_at)
  values (p_ws, lid, nullif(p->>'public_identifier', ''), nullif(left(p->>'name', 300), ''), nullif(lower(left(p->>'domain', 255)), ''), nullif(left(p->>'website', 500), ''),
          nullif(left(p->>'phone', 60), ''), nullif(left(p->>'industry', 200), ''), nullif(left(p->>'size', 40), ''),
          case when p->>'employees_on_linkedin' ~ num_re then (p->>'employees_on_linkedin')::int end,
          case when p->>'founded_year' ~ '^(1[5-9]|20)[0-9]{2}$' then (p->>'founded_year')::int end,
          nullif(left(p->>'tagline', 500), ''), nullif(left(p->>'about', 4000), ''), arr_s, arr_h,
          case when p->>'followers' ~ num_re then (p->>'followers')::int end,
          nullif(left(p#>>'{hq,city}', 200), ''), nullif(left(p#>>'{hq,region}', 200), ''), nullif(left(p#>>'{hq,country}', 200), ''), nullif(left(p#>>'{hq,address}', 500), ''), now())
  on conflict (workspace_id, linkedin_id) do update set
    public_identifier = coalesce(excluded.public_identifier, c.public_identifier), name = coalesce(excluded.name, c.name), domain = coalesce(excluded.domain, c.domain),
    website = coalesce(excluded.website, c.website), phone = coalesce(excluded.phone, c.phone), industry = coalesce(excluded.industry, c.industry), size = coalesce(excluded.size, c.size),
    employees_on_linkedin = coalesce(excluded.employees_on_linkedin, c.employees_on_linkedin), founded_year = coalesce(excluded.founded_year, c.founded_year),
    tagline = coalesce(excluded.tagline, c.tagline), about = coalesce(excluded.about, c.about), specialties = coalesce(excluded.specialties, c.specialties),
    hashtags = coalesce(excluded.hashtags, c.hashtags), followers = coalesce(excluded.followers, c.followers), hq_city = coalesce(excluded.hq_city, c.hq_city),
    hq_region = coalesce(excluded.hq_region, c.hq_region), hq_country = coalesce(excluded.hq_country, c.hq_country), hq_address = coalesce(excluded.hq_address, c.hq_address),
    fetched_at = now(), updated_at = now()
  returning c.id into cid;
  return cid;
end $$;

-- ===============================================================================================================
-- 4. Built-in AI variables
-- ===============================================================================================================
-- The three rows of one workspace (or of every workspace). A workspace that already has a variable with one of the keys
-- keeps its own: the seed skips it. The prompts live in code (_shared/outreach/ai.ts, BUILTIN_PROMPTS).
create or replace function outreach_seed_builtin_variables(p_ws uuid default null) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  perform set_config('outreach.builtin_seed', '1', true);
  insert into outreach_ai_variables(workspace_id, key, name, prompt, fallback, needs_posts, max_chars, mode, builtin)
  select w.id, b.key, b.name, b.prompt, '', false, 80, 'review', true
    from outreach_workspaces w
    cross join (values
      ('contact_first_name', 'Contact first name', 'The name a colleague would use. Titles, credentials, emojis and pronouns are removed and capitalisation is fixed.'),
      ('company_conversation', 'Company, as people say it', 'The company as people say it. Legal suffixes, taglines and "The" are removed, and all-caps is fixed unless it is an acronym.'),
      ('position_conversational', 'Position, as it reads mid-sentence', 'The role as it reads mid-sentence. Company names, separators, emojis and "ex-…" are removed.')) b(key, name, prompt)
   where p_ws is null or w.id = p_ws
  on conflict (workspace_id, key) do nothing;
  get diagnostics n = row_count;
  perform set_config('outreach.builtin_seed', '', true);
  return n;
end $$;

create or replace function outreach_hub_trg_workspace_builtins() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_seed_builtin_variables(new.id);
  return null;
end $$;
drop trigger if exists outreach_hub_workspace_builtins on outreach_workspaces;
create trigger outreach_hub_workspace_builtins after insert on outreach_workspaces for each row execute function outreach_hub_trg_workspace_builtins();

-- A built-in is created by the platform, cannot be edited (only switched on or off) and cannot be deleted.
create or replace function outreach_hub_trg_builtin_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare seeding boolean := coalesce(current_setting('outreach.builtin_seed', true), '') = '1';
begin
  if tg_op = 'INSERT' then
    if new.builtin and not seeding then raise exception 'E_FORBIDDEN: built-in variables are created by the platform'; end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.builtin is distinct from old.builtin and not seeding then raise exception 'E_FORBIDDEN: built-in variables are created by the platform'; end if;
    if old.builtin and not seeding and (new.key, new.name, new.prompt, new.fallback, new.needs_posts, new.max_chars, new.output, new.fields)
                                       is distinct from (old.key, old.name, old.prompt, old.fallback, old.needs_posts, old.max_chars, old.output, old.fields) then
      raise exception 'E_PAYLOAD_INVALID: a built-in variable cannot be changed. Switch it on or off instead';
    end if;
    return new;
  else
    -- deleting the workspace removes its variables: the workspace row is already gone then
    if old.builtin and not seeding and exists (select 1 from outreach_workspaces w where w.id = old.workspace_id) then
      raise exception 'E_PAYLOAD_INVALID: a built-in variable cannot be deleted. Switch it off instead';
    end if;
    return old;
  end if;
end $$;
drop trigger if exists outreach_hub_builtin_guard on outreach_ai_variables;
create trigger outreach_hub_builtin_guard before insert or update or delete on outreach_ai_variables for each row execute function outreach_hub_trg_builtin_guard();

select outreach_seed_builtin_variables(null);

-- the built-in keys (switched on) among a list of keys
create or replace function outreach__builtin_keys(p_ws uuid, p_keys text[]) returns text[]
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(array_agg(v.key), '{}') from outreach_ai_variables v where v.workspace_id = p_ws and v.builtin and v.mode <> 'off' and v.key = any(p_keys)
$$;

-- Service: a built-in value passed its check in code. It tidies a field the lead already has, so it is approved at once
-- (approved_by null = nobody had to) and the lead that waited for it starts. Empty → the normal blank path.
create or replace function outreach_ai_value_result_builtin(p_id uuid, p_text text, p_model text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare x outreach_ai_values%rowtype; txt text := nullif(btrim(regexp_replace(coalesce(p_text, ''), '\s+', ' ', 'g')), '');
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if txt is null or txt ~ '\{\{|\}\}' then perform outreach_ai_value_result(p_id, null, '[]'::jsonb, p_model, null); return; end if;
  update outreach_ai_values v set text = left(txt, 200), facts = '[]'::jsonb, model = p_model, error = null, locked_at = null, updated_at = now(), generated_at = now(),
         status = 'approved', approved_by = null, approved_at = now(), edited = false
   where v.id = p_id and v.status = 'pending' and exists (select 1 from outreach_ai_variables av where av.id = v.variable_id and av.builtin)
  returning v.* into x;
  if not found then return; end if;
  if x.batch_id is not null and not exists (select 1 from outreach_ai_values y where y.batch_id = x.batch_id and y.status = 'pending') then
    update outreach_ai_batches set status = case when exists (select 1 from outreach_ai_values y where y.batch_id = x.batch_id and y.status = 'generated') then 'review' else 'done' end,
           finished_at = now() where id = x.batch_id and status = 'generating';
  end if;
  perform outreach_release_waiting(x.lead_id, 'ai_review');
end $$;

-- ===============================================================================================================
-- 5. Patches for the built-ins and for Off
-- ===============================================================================================================
-- ---- A value created for a variable that is switched off is "skipped" from the start: nothing is written for it and no
-- lead waits for it (063 already does this to the values that are pending when a variable is switched off).
select outreach_hub__patch('public.outreach_ensure_ai_values(uuid,uuid,text[],uuid)', $m$v.mode = 'off'$m$, array[
  $a$select p_ws, p_lead, v.id, p_batch, 'pending' from outreach_ai_variables v$a$,
  $b$select p_ws, p_lead, v.id, p_batch, case when v.mode = 'off' then 'skipped' else 'pending' end from outreach_ai_variables v$b$]);

-- ---- Enrolment: a built-in the sequence uses is always created and waited for (seconds, never a person), also when the
-- sequence does not hold leads for review.
select outreach_hub__patch('public.outreach_enroll_leads(uuid,uuid[],uuid,integer,boolean,uuid,boolean)', 'outreach__builtin_keys', array[
  $a$enriched timestamptz; want_posts boolean;$a$,
  $b$enriched timestamptz; want_posts boolean; bkeys text[];$b$,
  $a$  hold_ai := coalesce((s.settings->>'hold_for_ai_review')::boolean, false) and array_length(keys,1) > 0;$a$,
  $b$  hold_ai := coalesce((s.settings->>'hold_for_ai_review')::boolean, false) and array_length(keys,1) > 0;
  bkeys := case when hold_ai then '{}'::text[] else outreach__builtin_keys(s.workspace_id, keys) end;$b$,
  $a$    insert into outreach_lead_sender_state(lead_id, sender_id) values (p.lead_id, p.sender_id) on conflict do nothing;$a$,
  $b$    if wr is null and array_length(bkeys, 1) > 0 then
      perform outreach_ensure_ai_values(s.workspace_id, p.lead_id, bkeys, null);
      if exists (select 1 from outreach_ai_variables v join outreach_ai_values x on x.variable_id = v.id and x.lead_id = p.lead_id
                  where v.workspace_id = s.workspace_id and v.key = any(bkeys) and x.status = 'pending') then
        st := 'waiting_task'; wr := 'ai_review';
      end if;
    end if;
    insert into outreach_lead_sender_state(lead_id, sender_id) values (p.lead_id, p.sender_id) on conflict do nothing;$b$]);

-- ---- Releasing a wait: without "hold for review" only the built-ins count.
select outreach_hub__patch('public.outreach_release_waiting(uuid,text)', 'outreach__builtin_keys', array[
  $a$keys text[]; needs_review boolean;$a$,
  $b$keys text[]; needs_review boolean; hold boolean;$b$,
  $a$    needs_review := false;
    if p_reason = 'enrichment' and coalesce((r.settings->>'hold_for_ai_review')::boolean, false) then
      keys := outreach_sequence_ai_keys(r.graph);$a$,
  $b$    needs_review := false;
    -- without "hold for review" only the built-in variables (written without a person) are waited for
    hold := coalesce((r.settings->>'hold_for_ai_review')::boolean, false);
    keys := outreach_sequence_ai_keys(r.graph);
    if not hold then keys := outreach__builtin_keys(r.workspace_id, keys); end if;
    if p_reason = 'enrichment' then$b$,
  $a$    if p_reason = 'ai_review' then
      keys := outreach_sequence_ai_keys(r.graph);$a$,
  $b$    if p_reason = 'ai_review' then$b$]);

-- ---- A built-in tidies a field the lead already has, so it does not wait for the profile to be enriched first
-- (a line does: up to a day, while the lead is in the enrichment queue).
select outreach_hub__patch('public.outreach_ai_claim_pending(integer)', 'bv.builtin', array[
  $a$or x.created_at < now() - interval '1 day')$a$,
  $b$or x.created_at < now() - interval '1 day'
              or exists (select 1 from outreach_ai_variables bv where bv.id = x.variable_id and bv.builtin))$b$]);

-- ---- A Condition on a built-in that is switched off reads nothing (the same rule as the render context)
select outreach_hub__patch('public.outreach_eval_rule(jsonb,outreach_leads,outreach_lead_sender_state,outreach_senders)', 'av.builtin', array[
  $a$and av.key = split_part(f, '.', 2) and x.status = 'approved';$a$,
  $b$and av.key = split_part(f, '.', 2) and x.status = 'approved' and not (av.builtin and av.mode = 'off');$b$]);

-- ---- Built-ins are not "lines": out of Activity, out of the All lines list and out of Setup's counts
select outreach_hub__patch_view('outreach_ai_outputs', 'av.builtin', array[
  $a$  WHERE v.text IS NOT NULL AND btrim(v.text) <> ''::text
UNION ALL$a$,
  $b$  WHERE v.text IS NOT NULL AND btrim(v.text) <> ''::text AND NOT av.builtin
UNION ALL$b$]);

select outreach_hub__patch('public.outreach_ai_review_list(uuid,uuid,text,integer,integer)', 'v.builtin', array[
  $a$where x.workspace_id = p_ws and (p_batch is null or x.batch_id = p_batch)$a$,
  $b$where x.workspace_id = p_ws and not v.builtin and (p_batch is null or x.batch_id = p_batch)$b$]);

-- Setup's variable list (counts, the Needs you filter) is about lines a person reviews: the built-ins are not in it
select outreach_hub__patch('public.outreach_hub_setup(uuid)', 'not v.builtin', array[
  $a$from outreach_ai_variables v where v.workspace_id = p_ws),$a$,
  $b$from outreach_ai_variables v where v.workspace_id = p_ws and not v.builtin),$b$]);

-- ===============================================================================================================
-- 6. Grants
-- ===============================================================================================================
do $$
declare f record;
  open_fns text[] := array['outreach_template_normalize', 'outreach_country_name', 'outreach_country_code', 'outreach_country_tz', 'outreach_location_parts', 'outreach__countries'];
  svc_fns text[] := array['outreach__duration_text', 'outreach__social_url', 'outreach__lead_tags', 'outreach__sender_email', 'outreach__render_account', 'outreach__render_now',
    'outreach__builtin_keys', 'outreach_company_due', 'outreach_company_save', 'outreach_seed_builtin_variables', 'outreach_hub_trg_workspace_builtins',
    'outreach_hub_trg_builtin_guard', 'outreach_ai_value_result_builtin'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname = any(open_fns) or p.proname = any(svc_fns)) loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname = any(open_fns) then execute format('grant execute on function %s to authenticated', f.sig);   -- pure text helpers; spintax_info (invoker) calls normalize
    else execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

drop function if exists outreach_hub__patch(text, text, text[]);
drop function if exists outreach_hub__patch_view(text, text, text[]);
