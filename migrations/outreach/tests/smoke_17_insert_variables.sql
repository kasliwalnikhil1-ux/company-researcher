-- Smoke test — 067 Insert Variables (ai-fields-json-changes.md Part B; docs/outreach/AI-FIELDS.md): template tags and
-- quoted spintax on the server, the new render-context keys (enrich, lead, sender, account, now), stored companies,
-- the three built-in AI variables (seed, guard, written without a person, Off) and grants.
-- Builds fixtures, asserts, then RAISES so everything rolls back. A passing run ends with "SMOKE OK".
-- Run: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_17_insert_variables.sql
do $$
declare
  log text := ''; fails int := 0; t text; j jsonb; k jsonb; n int; n2 int; st text; b boolean;
  ws uuid; ws2 uuid; u_owner uuid; ca uuid; s1 uuid; mb uuid; mb2 uuid; l1 uuid; l2 uuid; l3 uuid; l4 uuid; l5 uuid;
  b_first uuid; b_company uuid; b_position uuid; own uuid; v1 uuid; v2 uuid; v3 uuid; seq uuid; seq2 uuid; e1 uuid; co uuid; co2 uuid;
  sched jsonb := '{"mon":[["00:00","23:59"]],"tue":[["00:00","23:59"]],"wed":[["00:00","23:59"]],"thu":[["00:00","23:59"]],"fri":[["00:00","23:59"]],"sat":[["00:00","23:59"]],"sun":[["00:00","23:59"]]}';
  g jsonb := '{"version":1,"start":"start","nodes":{
     "start":{"id":"start","type":"start","next":"m1","position":{"x":0,"y":0}},
     "m1":{"id":"m1","type":"send_message","config":{"text":"Hi {{ ai_contact_first_name }}, how is {{ company_name }}?","send_always":true},"next":"end","position":{"x":0,"y":0}},
     "end":{"id":"end","type":"end","config":{},"position":{"x":0,"y":0}}}}';
  as_owner text;
begin
  select user_id into u_owner from platform_user_access where status = 'active' order by created_at limit 1;
  if u_owner is null then raise exception 'SMOKE FAIL: this test needs an active app user'; end if;
  as_owner := json_build_object('role', 'authenticated', 'sub', u_owner)::text;

  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke17', 'smoke17-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws;
  perform outreach_seed_workspace_defaults(ws);
  insert into outreach_clients(workspace_id, name) values (ws, 'Client A') returning id into ca;
  insert into outreach_members(workspace_id, user_id, role, email, display_name) values (ws, u_owner, 'owner', 'owner17@test.local', 'Aarushi');
  insert into outreach_senders(workspace_id, client_id, provider, display_name, status, unipile_account_id, warmup_level, health_score, connected_at, schedule, timezone, owner_user_id, owner_email)
    values (ws, ca, 'LINKEDIN', 'Naman Jain', 'ok', 's17a-' || ws, 3, 95, now() - interval '60 days', sched, 'Pacific/Kiritimati', u_owner, 'owner17@test.local') returning id into s1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company, title, location, email_work, company_id, company_domain)
    values (ws, ca, 'priya17-' || left(ws::text, 8), 'DR. PRIYA SHARMA, MBA', 'DR. PRIYA', 'Acme Technologies Pvt. Ltd.', 'Head of Growth', 'Bengaluru, Karnataka, India', 'priya@acme.com', '1441', 'acme.com') returning id into l1;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, company, location, company_id)
    values (ws, ca, 'ben17-' || left(ws::text, 8), 'Ben Roe', 'Ben', 'Acme', 'Austin, Texas', '1441') returning id into l2;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, location) values (ws, ca, 'cara17-' || left(ws::text, 8), 'Cara Diaz', 'Cara', 'Germany') returning id into l3;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, location, company_domain) values (ws, ca, 'dev17-' || left(ws::text, 8), 'Dev Shah', 'Dev', 'Greater Seattle Area', 'loomcraft.io') returning id into l4;
  insert into outreach_leads(workspace_id, client_id, public_identifier, full_name, first_name, title) values (ws, ca, 'eli17-' || left(ws::text, 8), 'Eli Fox', 'Eli', 'VP Sales & Partnerships | Ex-Google') returning id into l5;

  -- ============================================================ 1. Tags and quoted spintax on the server
  if outreach_template_normalize('{% if first_name %}Hi {{ first_name }}{% else %}Hi{% endif %}') = '{{#if first_name}}Hi {{ first_name }}{{else}}Hi{{/if}}'
     and outreach_template_normalize('{%- if first_name == "John" -%}A{%- else -%}B{%- endif -%}') = '{{#if first_name == "John"}}A{{else}}B{{/if}}'
     and outreach_template_normalize('{{ "Hey|Hello|Bonjour" | spintax }} {{first_name|there}} {Hi|Yo}') = '{Hey|Hello|Bonjour} {{first_name|there}} {Hi|Yo}'
     and outreach_template_normalize('Plain {{first_name}} text') = 'Plain {{first_name}} text' and outreach_template_normalize(null) = ''
     and (select max_len || '/' || combinations from outreach_spintax_info('{{ "Hey|Hello|Bonjour" | spintax }} {{first_name}}')) = (select max_len || '/' || combinations from outreach_spintax_info('{Hey|Hello|Bonjour} {{first_name}}'))
     and (select max_len || '/' || combinations from outreach_spintax_info('{{ "Hey|Hello|Bonjour" | spintax }} {{first_name}}')) = '22/3'
     and (select max_len from outreach_spintax_info('{% if company %}at {{company}}{% endif %}')) = 14
    then log := log || E'\nok   templates: {% if %} tags and quoted spintax become the native syntax; the length check counts both forms the same';
    else fails := fails + 1; log := log || E'\nFAIL template normalize / spintax_info: ' || outreach_template_normalize('{%- if first_name == "John" -%}A{%- else -%}B{%- endif -%}'); end if;

  if outreach_sequence_ai_keys(g) = array['contact_first_name']
     and outreach_sequence_ai_keys('{"a":"{% if ai_position_conversational %}x{% endif %} {{#if ai_company_conversation}}y{{/if}} {% if ai.research.fit == \"high\" %}z{% endif %} {{ai.opener}}"}'::jsonb)
         = array['company_conversation', 'opener', 'position_conversational', 'research']
     and outreach_sequence_ai_keys('{"a":"{{custom.ai_contact_first_name}} ai_contact_first_name {{ first_name }}"}'::jsonb) = '{}'::text[]
     and outreach_sequence_ai_keys('{"rules":[{"field":"ai.research.icp_fit","op":"eq","value":"high"}]}'::jsonb) = array['research']
    then log := log || E'\nok   sequence_ai_keys: finds a built-in from {{ ai_contact_first_name }}, tag conditionals, and still the 066 forms';
    else fails := fails + 1; log := log || E'\nFAIL sequence_ai_keys: ' || outreach_sequence_ai_keys(g)::text; end if;

  -- ============================================================ 2. Countries and locations
  if outreach_country_name('in') = 'India' and outreach_country_code('United Kingdom') = 'GB' and outreach_country_code('uk') = 'GB' and outreach_country_code('Narnia') is null
     and outreach_country_tz('India') = 'Asia/Kolkata' and outreach_country_tz('DE') = 'Europe/Berlin' and outreach_country_tz('United States') is null and outreach_country_tz(null) is null
     and outreach_location_parts('Bengaluru, Karnataka, India', null) = '{"city":"Bengaluru","region":"Karnataka","country":"India"}'::jsonb
     and outreach_location_parts('Dubai, United Arab Emirates', null) = '{"city":"Dubai","country":"United Arab Emirates"}'::jsonb
     and outreach_location_parts('Austin, Texas', null) = '{"city":"Austin","country":"Texas"}'::jsonb
     and outreach_location_parts('Austin, Texas', 'US') = '{"city":"Austin","region":"Texas","country":"United States"}'::jsonb
     and outreach_location_parts('Greater Seattle Area', 'us') = '{"city":"Greater Seattle Area","country":"United States"}'::jsonb
     and outreach_location_parts('Germany', null) = '{"country":"Germany"}'::jsonb and outreach_location_parts('', null) = '{}'::jsonb
     and outreach_location_parts('Whitefield, Bengaluru, Karnataka, India', null) = '{"city":"Whitefield","region":"Karnataka","country":"India"}'::jsonb
    then log := log || E'\nok   locations: 3, 2 and 1 parts split into city / region / country; the profile''s country code fills a missing country; one-timezone countries map to a timezone';
    else fails := fails + 1; log := log || E'\nFAIL locations: ' || outreach_location_parts('Austin, Texas', 'US')::text; end if;

  -- ============================================================ 3. Enrich context
  perform outreach_save_lead_profile(l1, jsonb_build_object('about', 'I build growth teams.', 'current_title', 'Head of Growth', 'current_company', 'Acme', 'current_started_on', (current_date - interval '2 years 3 months')::date::text,
    'experience', jsonb_build_array(
      jsonb_build_object('company', 'Acme', 'title', 'Head of Growth', 'company_id', '1441', 'start', '2022-03-01', 'current', true),
      jsonb_build_object('company', 'Swiggy', 'title', 'Growth Manager', 'start', '2019-01-01', 'end', '2022-02-01', 'current', false),
      jsonb_build_object('company', 'Zeta', 'title', 'Analyst', 'start', '2018-02-01', 'end', '2018-11-01', 'current', false),
      jsonb_build_object('company', 'Older', 'title', 'Intern', 'start', '2016-01-01', 'end', '2017-01-01', 'current', false)),
    'education', jsonb_build_array(jsonb_build_object('school', 'IIM Bangalore', 'degree', 'MBA', 'field', 'Marketing'), jsonb_build_object('school', 'NIT Trichy', 'degree', 'B.Tech'), jsonb_build_object('school', 'Third School')),
    'skills', jsonb_build_array('Growth', 'SEO'), 'languages', jsonb_build_array('English'),
    'linkedin', jsonb_build_object('country', 'IN', 'phones', jsonb_build_array('+91 11111 11111'), 'sales_navigator_id', 'SN123',
        'socials', jsonb_build_array(jsonb_build_object('type', 'TWITTER', 'name', '@priya'), jsonb_build_object('type', 'facebook', 'name', 'https://facebook.com/priya.s'))),
    'requested_sections', jsonb_build_array('about', 'experience', 'education', 'skills', 'languages')), s1, 'prefetch');
  perform outreach_save_lead_posts(l1, jsonb_build_array(
    jsonb_build_object('id', 'p1', 'text', 'Older post', 'date', (now() - interval '9 days')::text),
    jsonb_build_object('id', 'p2', 'text', 'Newest post', 'date', (now() - interval '1 day')::text),
    jsonb_build_object('id', 'p3', 'text', 'Middle post', 'date', (now() - interval '4 days')::text),
    jsonb_build_object('id', 'p4', 'text', 'Oldest post', 'date', (now() - interval '30 days')::text)), s1);
  j := outreach_lead_enrich_ctx(l1);
  if j->>'current_duration' = '2 yrs 3 mos' and j->>'current_started_on' = to_char((current_date - interval '2 years 3 months')::date, 'Mon YYYY')
     and j->>'experience_summary' = 'Head of Growth at Acme (2022–present); Growth Manager at Swiggy (2019–2022); Analyst at Zeta (2018)'
     and j->>'education_summary' = 'MBA, Marketing — IIM Bangalore; B.Tech — NIT Trichy' and j->>'education_field' = 'Marketing'
     and j->>'last_3_posts' = E'Newest post\n\nMiddle post\n\nOlder post'
     and j->>'location_city' = 'Bengaluru' and j->>'location_region' = 'Karnataka' and j->>'location_country' = 'India' and j->>'location_timezone' = 'Asia/Kolkata'
     and j->>'twitter_url' = 'https://x.com/priya' and j->>'facebook_url' = 'https://facebook.com/priya.s' and j->>'phone' = '+91 11111 11111' and j->>'sn_id' = 'SN123'
     and j->>'last_enrich_at' = to_char(now(), 'Mon DD, YYYY')
     and j->>'previous_company' = 'Swiggy' and j->>'school' = 'IIM Bangalore' and j->>'skills' = 'Growth, SEO' and j->>'about' = 'I build growth teams.'
    then log := log || E'\nok   enrich: duration, start date, the last three roles, two schools, three posts newest first, location parts and timezone, socials, phone; 014''s keys unchanged';
    else fails := fails + 1; log := log || E'\nFAIL enrich ctx: ' || j::text; end if;

  k := outreach_lead_enrich_ctx(l3);   -- no stored profile: the location still splits
  if k = '{"location_country":"Germany","location_timezone":"Europe/Berlin"}'::jsonb and outreach_lead_enrich_ctx(l4) = '{"location_city":"Greater Seattle Area"}'::jsonb
     and outreach_lead_enrich_ctx(gen_random_uuid()) = '{}'::jsonb
     and (outreach__duration_text((current_date - interval '1 year')::date) || '|' || outreach__duration_text((current_date - interval '8 months')::date) || '|' || outreach__duration_text(current_date)) = '1 yr|8 mos|less than a month'
    then log := log || E'\nok   enrich: a lead without a stored profile still gets its location parts; durations read "1 yr", "8 mos"';
    else fails := fails + 1; log := log || E'\nFAIL enrich without a profile: ' || k::text || ' / ' || outreach_lead_enrich_ctx(l4)::text; end if;

  -- ============================================================ 4. Companies: fetched once per company, shared by its leads
  b := outreach_company_due(ws, '1441');
  co := outreach_company_save(ws, '{"linkedin_id":"1441","public_identifier":"acme","name":"Acme Technologies","domain":"Acme.com","website":"https://acme.com","phone":"+91 80 1234 5678",
    "industry":"Software","size":"51-200","employees_on_linkedin":140,"founded_year":2015,"tagline":"Outbound, simplified","about":"Acme builds outbound tools.",
    "specialties":["Outbound","Sales engagement"],"hashtags":["#outbound"],"followers":18200,"hq":{"city":"Bengaluru","region":"Karnataka","country":"India","address":"12 MG Road, Bengaluru"}}'::jsonb);
  co2 := outreach_company_save(ws, '{"linkedin_id":"1441","followers":18300,"tagline":""}'::jsonb);   -- a later answer with fewer fields keeps what is stored
  if b and not outreach_company_due(ws, '1441') and co = co2 and outreach_company_due(ws, '9999') and not outreach_company_due(ws, '')
     and (select count(*) from outreach_companies where workspace_id = ws) = 1
     and (select name || '/' || domain || '/' || followers || '/' || tagline from outreach_companies where id = co) = 'Acme Technologies/acme.com/18300/Outbound, simplified'
    then log := log || E'\nok   companies: a fetch is due once per company per 90 days; a second save updates the same row and keeps fields it does not carry';
    else fails := fails + 1; log := log || E'\nFAIL companies'; end if;
  update outreach_companies set fetched_at = now() - interval '91 days' where id = co;
  if outreach_company_due(ws, '1441') then log := log || E'\nok   companies: due again after 90 days';
    else fails := fails + 1; log := log || E'\nFAIL companies: not due after 91 days'; end if;

  -- ============================================================ 5. The render context: lead, sender, account, now
  insert into outreach_tags(workspace_id, name) values (ws, 'vip'), (ws, 'q4');
  insert into outreach_lead_tags(lead_id, tag_id) select l1, id from outreach_tags where workspace_id = ws;
  update outreach_senders set label = 'Naman from GrowthX' where id = s1;
  j := outreach_render_context(l1, s1, null);
  if j->'lead'->>'tags' = 'q4, vip' and j->'lead'->>'work_email_domain' = 'acme.com'
     and j->'sender'->>'label' = 'Naman from GrowthX' and j->'sender'->>'email' = 'owner17@test.local' and j->'sender'->>'timezone' = 'Pacific/Kiritimati'
     and j->'account'->>'name' = 'Acme Technologies' and j->'account'->>'linkedin_url' = 'https://www.linkedin.com/company/acme' and j->'account'->>'linkedin_id' = '1441'
     and j->'account'->>'size' = '51-200' and (j->'account'->>'founded_year')::int = 2015 and j->'account'->'specialties' = '["Outbound","Sales engagement"]'::jsonb
     and j->'account'->'hq'->>'city' = 'Bengaluru' and j->'account'->'hq'->>'address' = '12 MG Road, Bengaluru' and (j->'account'->>'id')::uuid = co
     -- now: the lead's timezone (India), not the sender's
     and j->'now'->>'day' = to_char(now() at time zone 'Asia/Kolkata', 'FMDD') and j->'now'->>'month' = to_char(now() at time zone 'Asia/Kolkata', 'FMMonth')
     and j->'now'->>'weekday' = to_char(now() at time zone 'Asia/Kolkata', 'FMDay') and j->'now'->>'year' = to_char(now() at time zone 'Asia/Kolkata', 'YYYY')
     and j->'now'->>'time_of_day' in ('morning', 'afternoon', 'evening')
    then log := log || E'\nok   context: lead tags and work-email domain, sender label and email, the account of the lead''s current company, now in the lead''s timezone';
    else fails := fails + 1; log := log || E'\nFAIL render context: ' || (j - 'enrich' - 'lead')::text || ' lead.tags=' || coalesce(j->'lead'->>'tags', 'null'); end if;

  -- two leads at one company share the row (l2 matches by lead.company_id); a lead matched by domain; a lead with no company
  insert into outreach_companies(workspace_id, linkedin_id, name, domain, fetched_at) values (ws, '77', 'Loomcraft', 'loomcraft.io', now());
  j := outreach_render_context(l2, s1, null);
  k := outreach_render_context(l3, null, null);
  if (j->'account'->>'id')::uuid = co and outreach_render_context(l4, s1, null)->'account'->>'name' = 'Loomcraft' and k->'account' = '{}'::jsonb
     -- l2 ("Austin, Texas", no profile country) has no timezone: now follows the sender's; l3 (Germany, no sender) follows the lead's; l4 with no sender → UTC
     and j->'now'->>'day' = to_char(now() at time zone 'Pacific/Kiritimati', 'FMDD') and k->'now'->>'day' = to_char(now() at time zone 'Europe/Berlin', 'FMDD')
     and outreach_render_context(l4, null, null)->'now'->>'weekday' = to_char(now() at time zone 'UTC', 'FMDay')
     and outreach__render_now('Not/AZone')->>'year' = to_char(now() at time zone 'UTC', 'YYYY')
     and k->'sender' = '{}'::jsonb and j->'lead'->>'tags' is null
    then log := log || E'\nok   context: two leads at one company share its row; match by domain; no company → {}; now falls back to the sender''s timezone, then UTC';
    else fails := fails + 1; log := log || E'\nFAIL account / now fallbacks: ' || (j->'account')::text || ' ' || (j->'now')::text; end if;

  -- sender email: a mailbox sends from its own address; a LinkedIn sender uses its linked mailbox
  insert into outreach_senders(workspace_id, provider, display_name, public_identifier, status, unipile_account_id, parent_sender_id, owner_email)
    values (ws, 'GMAIL', 'Naman (work)', 'naman@growthx.ai', 'ok', 's17m-' || ws, s1, 'someone@else.test') returning id into mb;
  insert into outreach_senders(workspace_id, provider, display_name, status, unipile_account_id) values (ws, 'OUTLOOK', 'solo@mailbox.test', 'ok', 's17n-' || ws) returning id into mb2;
  if outreach_render_context(l1, mb, null)->'sender'->>'email' = 'naman@growthx.ai' and outreach_render_context(l1, s1, null)->'sender'->>'email' = 'naman@growthx.ai'
     and outreach_render_context(l1, mb2, null)->'sender'->>'email' = 'solo@mailbox.test'
    then log := log || E'\nok   sender email: a mailbox''s own address; a LinkedIn sender''s linked mailbox, else the owner''s email';
    else fails := fails + 1; log := log || E'\nFAIL sender email: ' || coalesce(outreach_render_context(l1, s1, null)->'sender'->>'email', 'null'); end if;

  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  perform outreach_update_sender(s1, '{"label":"  Naman at GrowthX  "}'::jsonb);
  begin perform outreach_update_sender(s1, jsonb_build_object('label', repeat('x', 81))); t := 'no error'; exception when others then t := left(sqlerrm, 17); end;
  perform outreach_update_sender(s1, '{"booking_link":"https://cal.example/naman"}'::jsonb);   -- a patch without a label keeps it
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  select label into st from outreach_senders where id = s1;
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  perform outreach_update_sender(s1, '{"label":""}'::jsonb);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if st = 'Naman at GrowthX' and t = 'E_PAYLOAD_INVALID' and (select label from outreach_senders where id = s1) is null
    then log := log || E'\nok   sender label: saved trimmed through update_sender, kept by other patches, cleared by an empty value, at most 80 characters';
    else fails := fails + 1; log := log || E'\nFAIL sender label: ' || coalesce(st, 'null') || ' ' || t; end if;

  -- ============================================================ 6. Built-ins: seeded, guarded
  select id into b_first from outreach_ai_variables where workspace_id = ws and key = 'contact_first_name' and builtin;
  select id into b_company from outreach_ai_variables where workspace_id = ws and key = 'company_conversation' and builtin;
  select id into b_position from outreach_ai_variables where workspace_id = ws and key = 'position_conversational' and builtin;
  -- a workspace that already uses one of the keys keeps its own variable
  insert into outreach_workspaces(name, slug, created_by, plan) values ('smoke17b', 'smoke17b-' || encode(gen_random_bytes(4),'hex'), u_owner, 'scale') returning id into ws2;
  delete from outreach_workspaces where id = ws2;   -- deleting a workspace takes its built-ins with it
  if b_first is not null and b_company is not null and b_position is not null
     and (select count(*) from outreach_ai_variables where workspace_id = ws and builtin and mode = 'review' and output = 'text') = 3
     and not exists (select 1 from outreach_ai_variables where workspace_id = ws2)
     and outreach_seed_builtin_variables(ws) = 0
    then log := log || E'\nok   built-ins: a new workspace gets the three variables (on); seeding again adds nothing; deleting the workspace removes them';
    else fails := fails + 1; log := log || E'\nFAIL built-in seed'; end if;

  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  t := '';
  begin insert into outreach_ai_variables(workspace_id, key, name, prompt, builtin) values (ws, 'mine', 'Mine', 'A prompt long enough to pass the check.', true); t := t || 'none|'; exception when others then t := t || left(sqlerrm, 11) || '|'; end;
  begin update outreach_ai_variables set prompt = 'Changed by a user' where id = b_first; get diagnostics n = row_count; t := t || 'rows=' || n || '|'; exception when others then t := t || left(sqlerrm, 17) || '|'; end;
  begin update outreach_ai_variables set builtin = false where id = b_first; t := t || 'none|'; exception when others then t := t || left(sqlerrm, 11) || '|'; end;
  begin delete from outreach_ai_variables where id = b_first; get diagnostics n = row_count; t := t || 'rows=' || n; exception when others then t := t || left(sqlerrm, 17); end;
  j := outreach_hub_variable_set_mode(b_position, 'off');
  k := outreach_hub_setup(ws);
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if t = 'E_FORBIDDEN|E_PAYLOAD_INVALID|E_FORBIDDEN|E_PAYLOAD_INVALID' and (select mode from outreach_ai_variables where id = b_position) = 'off'
     and not exists (select 1 from jsonb_array_elements(k->'variables') x where x->>'key' in ('contact_first_name', 'company_conversation', 'position_conversational'))
    then log := log || E'\nok   built-ins guard: a user cannot create, edit, un-mark or delete one; switching it on or off works; Setup''s line counts leave them out';
    else fails := fails + 1; log := log || E'\nFAIL built-in guard: ' || t; end if;

  -- ============================================================ 7. Built-ins: written without a person
  -- the sequence does NOT hold leads for review, and still waits for the built-in it uses
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool, settings, created_by)
    values (ws, ca, 'Built-in seq', 'active', g, array[s1], '{"stop_on_reply":true}', u_owner) returning id into seq;
  -- a workspace variable in the same kind of sequence is not created or waited for (unchanged behaviour)
  insert into outreach_ai_variables(workspace_id, key, name, prompt, fallback) values (ws, 'opener', 'Opener', 'One sentence about their current role, grounded in the profile.', 'Hello') returning id into own;
  insert into outreach_sequences(workspace_id, client_id, name, status, graph, sender_pool, settings, created_by)
    values (ws, ca, 'Own variable seq', 'active', replace(g::text, '{{ ai_contact_first_name }}', '{{ai.opener|there}} {{ ai_position_conversational }}')::jsonb, array[s1], '{"stop_on_reply":true}', u_owner) returning id into seq2;
  perform outreach_enroll_leads(seq, array[l1, l2], s1);
  perform outreach_enroll_leads(seq2, array[l3], s1);
  select id, status::text || '/' || coalesce(wait_reason, '') into e1, st from outreach_enrollments where sequence_id = seq and lead_id = l1;
  select id into v1 from outreach_ai_values where lead_id = l1 and variable_id = b_first;
  select id into v2 from outreach_ai_values where lead_id = l2 and variable_id = b_first;
  if st = 'waiting_task/ai_review' and (select status from outreach_ai_values where id = v1) = 'pending'
     -- seq2: the own variable is not created without "hold for review"; the built-in it uses is Off → no value, no wait
     and not exists (select 1 from outreach_ai_values where lead_id = l3)
     and (select status::text from outreach_enrollments where sequence_id = seq2 and lead_id = l3) <> 'waiting_task'
    then log := log || E'\nok   enrolment: a built-in in use is created and waited for without "hold for review"; own variables and switched-off built-ins are not';
    else fails := fails + 1; log := log || E'\nFAIL built-in enrolment: ' || coalesce(st, 'null'); end if;

  -- a built-in is claimed even while the lead waits in the enrichment queue (a line would wait for the profile)
  insert into outreach_enrich_queue(lead_id, workspace_id, want_posts, reason) values (l2, ws, false, 'manual') on conflict (lead_id) do nothing;
  insert into outreach_ai_values(workspace_id, lead_id, variable_id, status) values (ws, l2, own, 'pending');
  select count(*) filter (where c.value_id in (v1, v2)), count(*) filter (where c.variable_id = own) into n, n2 from outreach_ai_claim_pending(500) c where c.workspace_id = ws;
  if n = 2 and n2 = 0 then log := log || E'
ok   claim: a built-in does not wait for enrichment; a line of the same lead does';
    else fails := fails + 1; log := log || E'
FAIL claim: built-ins=' || n || ' lines=' || n2; end if;
  delete from outreach_ai_values where lead_id = l2 and variable_id = own;
  delete from outreach_enrich_queue where lead_id = l2;
  perform outreach_ai_value_result_builtin(v1, '  Priya ', 'test-model');
  perform outreach_ai_value_result_builtin(v2, '', 'test-model');            -- the check in code rejected it → blank → the raw field is used
  j := outreach_render_context(l1, s1, e1);
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  select count(*) into n from outreach_ai_needs_you x where x.workspace_id = ws and x.type = 'line';
  select count(*) into n from outreach_ai_outputs o where o.workspace_id = ws and o.feature = 'line' and n = 0;
  k := to_jsonb((select count(*) from outreach_ai_review_list(ws, null, 'all', 100, 0)));
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if (select status || '/' || text || '/' || coalesce(approved_by::text, 'nobody') || '/' || (approved_at is not null)::text || '/' || (generated_at is not null)::text from outreach_ai_values where id = v1) = 'approved/Priya/nobody/true/true'
     and (select status from outreach_ai_values where id = v2) = 'blank'
     and j->'ai'->>'contact_first_name' = 'Priya'
     and (select current_node_id || '/' || status::text from outreach_enrollments where id = e1) like 'm1/%'
     and (select status::text from outreach_enrollments where sequence_id = seq and lead_id = l2) <> 'waiting_task'
     and n = 0 and k = '0'::jsonb
    then log := log || E'\nok   built-ins: a value that passes is approved at once (by nobody) and the lead starts; a rejected one is blank; neither shows in Needs you, Activity or All lines';
    else fails := fails + 1; log := log || E'\nFAIL built-in result: ' || coalesce((select status || '/' || coalesce(text, 'null') from outreach_ai_values where id = v1), 'null') || ' ai=' || (j->'ai')::text || ' n=' || n || ' list=' || k::text; end if;

  -- Off: the approved value is no longer used (the alias falls back to the raw field); a new lead gets no value and does not wait
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  perform outreach_hub_variable_set_mode(b_first, 'off');
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  j := outreach_render_context(l1, s1, e1);
  perform outreach_enroll_leads(seq, array[l4], s1);
  if j->'ai' = '{}'::jsonb and not exists (select 1 from outreach_ai_values where lead_id = l4)
     and (select status::text from outreach_enrollments where sequence_id = seq and lead_id = l4) <> 'waiting_task'
     and not outreach_eval_condition('{"match":"all","rules":[{"field":"ai.contact_first_name","op":"exists"}]}'::jsonb, l1, s1)
    then log := log || E'\nok   built-ins Off: the stored value stops rendering (the raw field is used), rules read nothing, and new leads neither get a value nor wait';
    else fails := fails + 1; log := log || E'\nFAIL built-in off: ai=' || (j->'ai')::text; end if;

  -- ensure_ai_values for a switched-off variable of any kind: skipped from the start
  update outreach_ai_variables set mode = 'off' where id = own;
  perform outreach_ensure_ai_values(ws, l4, array['opener', 'contact_first_name', 'company_conversation'], null);
  if (select string_agg(v.key || '=' || x.status, ',' order by v.key) from outreach_ai_values x join outreach_ai_variables v on v.id = x.variable_id where x.lead_id = l4)
       = 'company_conversation=pending,contact_first_name=skipped,opener=skipped'
    then log := log || E'\nok   off: a value created for a switched-off variable is skipped from the start, so nothing is written and nobody waits';
    else fails := fails + 1; log := log || E'\nFAIL ensure_ai_values off'; end if;

  -- with "hold for review" the built-ins are part of the normal wait
  update outreach_sequences set settings = '{"stop_on_reply":true,"hold_for_ai_review":true}' where id = seq2;
  update outreach_ai_variables set mode = 'review' where id = own;
  perform set_config('outreach.builtin_seed', '1', true); update outreach_ai_variables set mode = 'review' where id = b_position; perform set_config('outreach.builtin_seed', '', true);
  perform outreach_enroll_leads(seq2, array[l5], s1);
  select id into v3 from outreach_ai_values where lead_id = l5 and variable_id = b_position;
  update outreach_ai_values set locked_at = now(), attempts = 1 where id = v3;
  perform outreach_ai_value_result_builtin(v3, 'VP of Sales', 'test-model');
  if (select status::text || '/' || coalesce(wait_reason, '') from outreach_enrollments where sequence_id = seq2 and lead_id = l5) = 'waiting_task/ai_review'
     and (select status from outreach_ai_values where lead_id = l5 and variable_id = own) = 'pending' and (select status from outreach_ai_values where id = v3) = 'approved'
    then log := log || E'\nok   hold for review: the lead keeps waiting for its own line after the built-in is written';
    else fails := fails + 1; log := log || E'\nFAIL hold for review with a built-in: ' || coalesce((select status::text || '/' || coalesce(wait_reason, '') from outreach_enrollments where sequence_id = seq2 and lead_id = l5), 'null'); end if;

  -- ============================================================ 8. Grants and RLS
  perform set_config('request.jwt.claims', as_owner, true); execute 'set local role authenticated';
  select count(*) into n from outreach_companies where workspace_id = ws;
  begin insert into outreach_companies(workspace_id, linkedin_id, name) values (ws, '5', 'x'); t := 'inserted'; exception when insufficient_privilege then t := 'denied'; end;
  execute 'reset role'; perform set_config('request.jwt.claims', '', true);
  if n = 2 and t = 'denied'
     and has_function_privilege('authenticated', 'outreach_template_normalize(text)', 'execute') and has_function_privilege('authenticated', 'outreach_spintax_info(text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_company_save(uuid,jsonb)', 'execute') and not has_function_privilege('authenticated', 'outreach_ai_value_result_builtin(uuid,text,text)', 'execute')
     and not has_function_privilege('authenticated', 'outreach_seed_builtin_variables(uuid)', 'execute') and not has_function_privilege('authenticated', 'outreach__lead_tags(uuid)', 'execute')
     and not has_function_privilege('anon', 'outreach_template_normalize(text)', 'execute') and not has_table_privilege('anon', 'outreach_companies', 'select')
     and has_function_privilege('service_role', 'outreach_company_save(uuid,jsonb)', 'execute')
     and to_regprocedure('outreach_hub__patch(text,text,text[])') is null and to_regprocedure('outreach_hub__patch_view(text,text,text[])') is null
    then log := log || E'\nok   grants: members read their workspace''s companies and cannot write them; the service functions are closed to signed-in users';
    else fails := fails + 1; log := log || E'\nFAIL grants: companies visible=' || n || ' insert=' || t; end if;

  raise exception E'%\n%', case when fails = 0 then 'SMOKE OK (Insert Variables 067)' else 'SMOKE FAIL (' || fails || ')' end, log;
end $$;
