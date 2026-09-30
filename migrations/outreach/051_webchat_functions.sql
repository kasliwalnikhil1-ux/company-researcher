-- 051_webchat_functions.sql — Web chat functions (web-chat-PRD.md §5–§13).
-- Requires 048 + 049 (050 is unrelated). Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/051_webchat_functions.sql
--
-- Two families:
--   outreach_webchat_public_* / outreach_webchat_v_*  service-role only. Called by the public edge function
--       `outreach-webchat` after it has checked website token + Origin + the visitor token. Every one takes explicit ids
--       (p_inbox / p_visitor / p_chat) and re-checks ownership (visitor owns chat, chat belongs to inbox): pooler-safe,
--       no session GUC for tenancy (chatbot-main's rule).
--   outreach_webchat_*  (the rest) user RPCs: outreach_require() then outreach_client_visible() on the inbox's client.
-- Names stay outside the prefixes that the 037/042 grant loops match (outreach_ai_%, outreach_chat_ai_% ...).

-- ===============================================================================================================
-- Defaults, merge, helpers
-- ===============================================================================================================
create or replace function outreach_webchat_default_settings() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select $j${
    "appearance": {
      "brand_name": "Chat", "logo_url": null, "bot_avatar_url": null,
      "welcome_title": "Hi there 👋", "welcome_tagline": "Ask us anything, or share your feedback.",
      "accent": "#4f46e5", "widget_bg": "#ffffff", "chat_bg": "#f8f8fa", "font": "Inter", "theme": "auto",
      "mode": "bubble", "z_index": 2147483000, "custom_css": "", "drawer_side": "right", "panel_width": 384,
      "mobile": {}
    },
    "launcher": {
      "desktop": { "type": "icon", "size": "md", "position": "right", "margin_bottom": 48, "margin_side": 48, "text": "Chat with us" },
      "mobile":  { "type": "icon", "size": "md", "position": "right", "margin_bottom": 36, "margin_side": 36, "text": "Chat" },
      "show_unread_count": true, "show_unread_previews": true, "hide": false, "online_dot": true
    },
    "popup": { "enabled": false, "text": "👋 Have a question? We're here to help.", "image_url": null, "delay_s": 3, "position": "above" },
    "messages": {
      "greeting_enabled": true, "greeting": "Hi! How can we help you today?",
      "reply_time": "minutes", "available_message": "We're online", "unavailable_message": "We're away right now. Leave a message and we'll get back to you.",
      "email_capture_prompt": "We'll reply here and by email — what's your email?",
      "end_message": "Thanks for chatting with us!", "placeholder": "Type a message…",
      "quick_replies": [], "handoff_message": "Connecting you with a person — one moment.",
      "handoff_offline_message": "Our team is offline right now. Leave your email and we'll reply as soon as we're back."
    },
    "pre_chat": {
      "enabled": false, "message": "Tell us a bit about yourself so we can help.", "when": "before_first",
      "fields": [
        { "key": "name",  "label": "Name",  "type": "text",  "visible": true, "required": false, "placeholder": "" },
        { "key": "email", "label": "Email", "type": "email", "visible": true, "required": true,  "placeholder": "" },
        { "key": "phone", "label": "Phone", "type": "phone", "visible": false, "required": false, "placeholder": "" }
      ],
      "consent": { "enabled": false, "label": "I agree to be contacted about my request.", "link": null, "text_version": "v1" }
    },
    "features": {
      "file_picker": true, "emoji_picker": true, "restart": true, "end_conversation": true, "allow_after_resolved": true,
      "single_conversation": false, "sounds": true, "read_receipts": true, "show_agent_names": true, "transcript": true,
      "email_capture": true, "powered_by": true, "show_offline_status": true, "hide_outside_hours": false, "markdown": true
    },
    "csat": { "enabled": true, "scale": "emoji", "ask_comment": true, "by_email": true },
    "continuity": { "enabled": true, "inactivity_min": 5, "digest_window_min": 15, "include_transcript_on_resolve": false },
    "ai": {
      "mode": "off", "knowledge_source_ids": [], "persona": "", "allowed_topics": "",
      "handoff": { "keywords": ["pricing quote", "talk to a person", "speak to a human", "complaint", "refund"], "max_turns": 6, "low_confidence_streak": 2, "leads_in_sequence": true },
      "show_sources": true, "hourly_cap_per_visitor": 30
    },
    "targeting": { "url_rules": [], "hide_mobile": false, "hide_desktop": false, "identified_only": false, "countries_include": [], "countries_exclude": [] },
    "security": {
      "rate_limits": { "visitor_10s": 10, "visitor_1h": 200, "ip_1m": 20, "ip_1h": 300, "inbox_1m": 2000 },
      "turnstile_enabled": false, "turnstile_site_key": null, "consent_mode": false, "allow_localhost": false,
      "attachments": { "max_mb": 10, "allow_zip": false }, "profanity_filter": false
    },
    "assignment": { "auto": true, "capacity": 10, "unassign_offline_min": 0 },
    "locale": { "default": "en", "use_browser": true, "strings": {} }
  }$j$::jsonb
$$;

-- Recursive object merge: keys of b override a; nested objects merge; arrays / scalars replace.
create or replace function outreach_webchat__merge(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = public, extensions as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      (select coalesce(jsonb_object_agg(k, case when a ? k and b ? k then outreach_webchat__merge(a->k, b->k) when b ? k then b->k else a->k end), '{}'::jsonb)
         from (select jsonb_object_keys(a) k union select jsonb_object_keys(b)) ks)
    else coalesce(b, a) end
$$;

create or replace function outreach_webchat__settings(p_inbox uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select outreach_webchat__merge(outreach_webchat_default_settings(), coalesce(i.settings, '{}'::jsonb)) from outreach_webchat_inboxes i where i.id = p_inbox
$$;

create or replace function outreach_webchat__rand(p_bytes int default 16) returns text
language sql volatile set search_path = public, extensions as $$ select encode(gen_random_bytes(p_bytes), 'hex') $$;

-- Origin check (PRD §7): exact host, '*.example.com' wildcard, 'localhost' opt-in. Unknown origin → false.
create or replace function outreach_webchat__origin_ok(p_inbox uuid, p_origin text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
declare host text; d text; i outreach_webchat_inboxes%rowtype; st jsonb;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then return false; end if;
  host := lower(regexp_replace(regexp_replace(coalesce(p_origin, ''), '^[a-z]+://', ''), '[:/].*$', ''));
  if host = '' then return false; end if;
  host := regexp_replace(host, '^www\.', '');
  if host in ('localhost', '127.0.0.1', '[::1]') then
    st := outreach_webchat__settings(p_inbox);
    return coalesce((st#>>'{security,allow_localhost}')::boolean, false) or 'localhost' = any(i.allowed_domains);
  end if;
  foreach d in array i.allowed_domains loop
    d := lower(regexp_replace(regexp_replace(d, '^[a-z]+://', ''), '[:/].*$', ''));
    d := regexp_replace(d, '^www\.', '');
    if d = host then return true; end if;
    if d like '\*.%' and (host = substr(d, 3) or host like '%.' || substr(d, 3)) then return true; end if;
    if d = 'localhost' and host = 'localhost' then return true; end if;
  end loop;
  return false;
end $$;

-- Business hours (PRD §5.7 / §15): weekly intervals in the inbox timezone; intervals may cross midnight; holidays are dates.
create or replace function outreach_webchat__in_hours(p_bh jsonb, p_at timestamptz default now()) returns boolean
language plpgsql immutable set search_path = public, extensions as $$
declare tz text; loc timestamp; d text; prev text; iv jsonb; f time; t time; lt time; days text[] := array['sun','mon','tue','wed','thu','fri','sat'];
begin
  if p_bh is null or jsonb_typeof(p_bh->'weekly') is distinct from 'object' then return true; end if;
  tz := coalesce(nullif(p_bh->>'tz', ''), 'UTC');
  begin loc := p_at at time zone tz; exception when others then loc := p_at at time zone 'UTC'; end;
  if p_bh ? 'holidays' and jsonb_typeof(p_bh->'holidays') = 'array' and (p_bh->'holidays') ? to_char(loc, 'YYYY-MM-DD') then return false; end if;
  d := days[extract(dow from loc)::int + 1];
  prev := days[((extract(dow from loc)::int + 6) % 7) + 1];
  lt := loc::time;
  for iv in select * from jsonb_array_elements(coalesce(p_bh->'weekly'->d, '[]'::jsonb)) loop
    begin f := (iv->>0)::time; t := (iv->>1)::time; exception when others then continue; end;
    if f <= t then if lt >= f and lt < t then return true; end if;
    else if lt >= f or lt < t then return true; end if; end if;
  end loop;
  -- an interval of the previous day that crosses midnight
  for iv in select * from jsonb_array_elements(coalesce(p_bh->'weekly'->prev, '[]'::jsonb)) loop
    begin f := (iv->>0)::time; t := (iv->>1)::time; exception when others then continue; end;
    if f > t and lt < t then return true; end if;
  end loop;
  return false;
end $$;

create or replace function outreach_webchat__next_open(p_bh jsonb, p_at timestamptz default now()) returns timestamptz
language plpgsql immutable set search_path = public, extensions as $$
declare tz text; loc timestamp; i int; d text; iv jsonb; f time; cand timestamptz; best timestamptz; days text[] := array['sun','mon','tue','wed','thu','fri','sat']; day date;
begin
  if p_bh is null or jsonb_typeof(p_bh->'weekly') is distinct from 'object' then return null; end if;
  tz := coalesce(nullif(p_bh->>'tz', ''), 'UTC');
  begin loc := p_at at time zone tz; exception when others then tz := 'UTC'; loc := p_at at time zone 'UTC'; end;
  for i in 0..14 loop
    day := (loc::date + i);
    if p_bh ? 'holidays' and jsonb_typeof(p_bh->'holidays') = 'array' and (p_bh->'holidays') ? to_char(day, 'YYYY-MM-DD') then continue; end if;
    d := days[extract(dow from day)::int + 1];
    for iv in select * from jsonb_array_elements(coalesce(p_bh->'weekly'->d, '[]'::jsonb)) loop
      begin f := (iv->>0)::time; exception when others then continue; end;
      cand := (day + f) at time zone tz;
      if cand > p_at and (best is null or cand < best) then best := cand; end if;
    end loop;
    if best is not null then return best; end if;
  end loop;
  return best;
end $$;

-- Agents online for an inbox: members of the inbox with a presence ping in the last 10 minutes, state online.
create or replace function outreach_webchat__online_agents(p_inbox uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(nullif(m.display_name, ''), split_part(coalesce(m.email, ''), '@', 1), 'Agent'), 'user_id', m.user_id) order by p.last_seen_at desc), '[]'::jsonb)
    from outreach_webchat_inbox_members im
    join outreach_webchat_inboxes i on i.id = im.inbox_id
    join outreach_webchat_agent_presence p on p.workspace_id = i.workspace_id and p.user_id = im.user_id
    join outreach_members m on m.workspace_id = i.workspace_id and m.user_id = im.user_id
   where im.inbox_id = p_inbox and p.state = 'online' and p.last_seen_at > now() - interval '10 minutes'
$$;

-- Availability now: online = at least one agent online AND inside business hours (PRD §5.7).
create or replace function outreach_webchat__availability(p_inbox uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; agents jsonb; inh boolean; st jsonb;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  st := outreach_webchat__settings(p_inbox);
  agents := outreach_webchat__online_agents(p_inbox);
  inh := outreach_webchat__in_hours(i.business_hours, now());
  return jsonb_build_object(
    'online', inh and jsonb_array_length(agents) > 0,
    'in_hours', inh,
    'next_open_at', case when inh then null else outreach_webchat__next_open(i.business_hours, now()) end,
    'timezone', coalesce(i.business_hours->>'tz', 'UTC'),
    'agents', (select coalesce(jsonb_agg(x.a - 'user_id'), '[]'::jsonb) from (select a from jsonb_array_elements(agents) a limit 3) x),
    'reply_time', st#>>'{messages,reply_time}',
    'ai_mode', case when i.ai_enabled then coalesce(st#>>'{ai,mode}', 'off') else 'off' end);
end $$;

-- Ownership: the visitor owns the chat; both belong to the same inbox. Raises E_NOT_FOUND otherwise.
create or replace function outreach_webchat__own(p_visitor uuid, p_chat uuid) returns outreach_chats
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; vid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select coalesce(merged_into, id) into vid from outreach_webchat_visitors where id = p_visitor;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT'
     and (visitor_id = p_visitor or visitor_id = vid or visitor_id in (select id from outreach_webchat_visitors where merged_into = vid));
  if not found then raise exception 'E_NOT_FOUND'; end if;
  return c;
end $$;

create or replace function outreach_webchat__agent_name(p_user uuid, p_ws uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(nullif(m.display_name, ''), split_part(coalesce(m.email, ''), '@', 1), 'Agent') from outreach_members m where m.user_id = p_user and m.workspace_id = p_ws
$$;

-- Round-robin auto-assignment with capacity (PRD §8): online inbox members with auto_assign, fewest open first, then oldest assignment.
create or replace function outreach_webchat__auto_assign(p_chat uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st jsonb; cap int; pick uuid;
begin
  select * into c from outreach_chats where id = p_chat;
  if c.webchat_inbox_id is null or c.assigned_to is not null then return c.assigned_to; end if;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  if coalesce((st#>>'{assignment,auto}')::boolean, true) = false then return null; end if;
  cap := greatest(1, coalesce((st#>>'{assignment,capacity}')::int, 10));
  select im.user_id into pick
    from outreach_webchat_inbox_members im
    join outreach_webchat_agent_presence p on p.workspace_id = c.workspace_id and p.user_id = im.user_id and p.state = 'online' and p.last_seen_at > now() - interval '10 minutes'
   where im.inbox_id = c.webchat_inbox_id and im.auto_assign
     and (select count(*) from outreach_chats x where x.webchat_inbox_id = c.webchat_inbox_id and x.assigned_to = im.user_id and x.status in ('open','pending')) < cap
   order by im.last_assigned_at nulls first limit 1;
  if pick is null then return null; end if;
  update outreach_chats set assigned_to = pick where id = p_chat;
  update outreach_webchat_inbox_members set last_assigned_at = now() where inbox_id = c.webchat_inbox_id and user_id = pick;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
  values (c.workspace_id, p_chat, 'out', null, now(), 'event', jsonb_build_object('kind', 'assigned', 'agent', outreach_webchat__agent_name(pick, c.workspace_id)), 'system', 'system', 'inbox_user');
  return pick;
end $$;

-- Lead link: a visitor with an email that matches a lead of the workspace (client scope of the inbox) is linked for context.
-- Verified identities may create the lead (workspace setting create_leads_from_inbound, default true); unverified never do.
create or replace function outreach_webchat__link_lead(p_visitor uuid, p_create boolean default false) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; lid uuid; ws_settings jsonb; r record;
begin
  select * into v from outreach_webchat_visitors where id = p_visitor;
  if v.lead_id is not null then return v.lead_id; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  if v.email is not null then
    select l.id into lid from outreach_leads l
     where l.workspace_id = v.workspace_id and (l.email_work = v.email or l.email_personal = v.email)
       and (i.client_id is null or l.client_id is null or l.client_id = i.client_id)
     order by (l.client_id = i.client_id) desc nulls last, l.created_at limit 1;
  end if;
  if lid is null and v.phone is not null then
    select l.id into lid from outreach_leads l where l.workspace_id = v.workspace_id and l.phone = v.phone and (i.client_id is null or l.client_id is null or l.client_id = i.client_id) limit 1;
  end if;
  if lid is null and p_create and v.identity_verified and v.email is not null then
    select settings into ws_settings from outreach_workspaces where id = v.workspace_id;
    if coalesce((ws_settings->>'create_leads_from_inbound')::boolean, true) then
      for r in select * from outreach_upsert_lead(v.workspace_id, jsonb_strip_nulls(jsonb_build_object('email_work', v.email, 'full_name', v.name, 'phone', v.phone, 'company', v.company, 'client_id', i.client_id)), 'webchat', null) loop lid := r.id; end loop;
    end if;
  end if;
  if lid is not null then
    update outreach_webchat_visitors set lead_id = lid where id = p_visitor;
    update outreach_chats set lead_id = lid where visitor_id = p_visitor and lead_id is null;
  end if;
  return lid;
end $$;

-- Visitor as the widget sees it.
create or replace function outreach_webchat__visitor_json(v outreach_webchat_visitors) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', v.id, 'identifier', v.identifier, 'identity_verified', v.identity_verified, 'name', v.name, 'email', v.email, 'phone', v.phone,
    'avatar_url', v.avatar_url, 'custom_attributes', v.custom_attributes, 'consent', v.consent, 'locale', v.locale, 'token_version', v.token_version, 'first_seen_at', v.first_seen_at)
$$;

create or replace function outreach_webchat__conversation_json(c outreach_chats) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'id', c.id, 'status', c.status, 'created_at', c.created_at, 'last_message_at', c.last_message_at, 'last_message_preview', c.last_message_preview,
    'last_direction', c.last_direction, 'stream_key', c.stream_key, 'resolved_at', c.resolved_at, 'csat', c.csat, 'ai_handled', c.ai_handled,
    'handed_off_at', c.handed_off_at, 'source', c.source, 'labels', c.labels, 'custom_attributes', c.custom_attributes,
    'unread', (select count(*) from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.read_by_visitor_at is null and m.sender_type in ('agent','bot') and m.deleted_at is null),
    'assignee', case when c.assigned_to is null then null else jsonb_build_object('name', outreach_webchat__agent_name(c.assigned_to, c.workspace_id)) end,
    'agent_typing', c.agent_typing_at is not null and c.agent_typing_at > now() - interval '8 seconds')
$$;

-- ===============================================================================================================
-- PUBLIC (service-only): config, visitors, conversations, messages
-- ===============================================================================================================
create or replace function outreach_webchat_public_config(p_token text, p_origin text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; st jsonb; pub jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into i from outreach_webchat_inboxes where website_token = p_token and deleted_at is null;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if not outreach_webchat__origin_ok(i.id, p_origin) then return jsonb_build_object('error', 'origin'); end if;
  if not i.is_active or not outreach_plan_active(i.workspace_id) then return jsonb_build_object('error', 'inactive', 'inbox_id', i.id); end if;
  st := outreach_webchat__settings(i.id);
  -- public projection: everything the widget renders, nothing the server keeps (rate limits, block lists, AI knowledge ids, persona)
  pub := jsonb_build_object(
    'appearance', st->'appearance', 'launcher', st->'launcher', 'popup', st->'popup', 'messages', st->'messages',
    'pre_chat', st->'pre_chat', 'features', st->'features', 'csat', st->'csat', 'targeting', st->'targeting', 'locale', st->'locale',
    'security', jsonb_build_object('turnstile_enabled', st#>'{security,turnstile_enabled}', 'turnstile_site_key', st#>'{security,turnstile_site_key}', 'consent_mode', st#>'{security,consent_mode}', 'attachments', st#>'{security,attachments}'),
    'ai', jsonb_build_object('mode', case when i.ai_enabled then st#>'{ai,mode}' else '"off"'::jsonb end, 'show_sources', st#>'{ai,show_sources}'),
    'continuity', jsonb_build_object('enabled', st#>'{continuity,enabled}'));
  return jsonb_build_object(
    'ok', true, 'inbox_id', i.id, 'workspace_id', i.workspace_id, 'name', i.name, 'config_version', i.config_version,
    'enforce_identity', i.enforce_identity, 'settings', pub, 'availability', outreach_webchat__availability(i.id),
    'campaigns', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'message', c.message, 'sender_kind', c.sender_kind,
                    'sender_name', case when c.sender_kind = 'agent' and c.sender_user_id is not null then outreach_webchat__agent_name(c.sender_user_id, i.workspace_id) else st#>>'{appearance,brand_name}' end,
                    'quick_replies', to_jsonb(c.quick_replies), 'rules', c.rules, 'frequency', c.frequency, 'display', c.display)), '[]'::jsonb)
                    from outreach_webchat_campaigns c where c.inbox_id = i.id and c.enabled),
    'blocked_countries', (select coalesce(jsonb_agg(value), '[]'::jsonb) from outreach_webchat_blocks b where b.inbox_id = i.id and b.kind = 'country'),
    'hmac_token', i.hmac_token);   -- the edge function uses it for setUser verification and strips it before responding
end $$;

create or replace function outreach_webchat_public_install_seen(p_inbox uuid, p_origin text) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_inboxes set installed_origins = installed_origins || jsonb_build_object(left(coalesce(p_origin, ''), 200), now())
   where id = p_inbox and outreach_is_service() and p_origin is not null and p_origin <> ''
     and (installed_origins->>left(p_origin, 200) is null or (installed_origins->>left(p_origin, 200))::timestamptz < now() - interval '1 minute')
$$;

-- Create / restore a visitor. p_meta: {ua_browser, ua_os, device, locale, timezone, ip_hash, country, city, referrer, landing_url, utm}
create or replace function outreach_webchat_v_visitor(p_inbox uuid, p_visitor uuid, p_token_version int, p_meta jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; blocked boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_visitor is not null then
    select * into v from outreach_webchat_visitors where id = p_visitor and inbox_id = p_inbox and token_version = coalesce(p_token_version, token_version);
    if found and v.merged_into is not null then select * into v from outreach_webchat_visitors where id = v.merged_into; end if;
  end if;
  if v.id is null then
    insert into outreach_webchat_visitors(workspace_id, inbox_id, ip_hash, country, city, timezone, browser, os, device, locale, referrer, landing_url, utm, last_seen_at)
    values (i.workspace_id, p_inbox, p_meta->>'ip_hash', p_meta->>'country', p_meta->>'city', p_meta->>'timezone', p_meta->>'browser', p_meta->>'os', p_meta->>'device', p_meta->>'locale',
            left(p_meta->>'referrer', 2000), left(p_meta->>'landing_url', 2000), p_meta->'utm', now())
    returning * into v;
  else
    update outreach_webchat_visitors set last_seen_at = now(), ip_hash = coalesce(p_meta->>'ip_hash', ip_hash), country = coalesce(p_meta->>'country', country), city = coalesce(p_meta->>'city', city),
      timezone = coalesce(p_meta->>'timezone', timezone), browser = coalesce(p_meta->>'browser', browser), os = coalesce(p_meta->>'os', os), device = coalesce(p_meta->>'device', device),
      locale = coalesce(p_meta->>'locale', locale), utm = coalesce(p_meta->'utm', utm)
     where id = v.id returning * into v;
  end if;
  blocked := v.blocked_at is not null
    or exists (select 1 from outreach_webchat_blocks b where b.inbox_id = p_inbox and ((b.kind = 'visitor' and b.value = v.id::text) or (b.kind = 'ip_hash' and b.value = v.ip_hash) or (b.kind = 'country' and v.country is not null and upper(b.value) = upper(v.country))));
  return jsonb_build_object('visitor', outreach_webchat__visitor_json(v), 'blocked', blocked,
    'conversations', (select coalesce(jsonb_agg(outreach_webchat__conversation_json(c) order by c.last_message_at desc nulls last, c.created_at desc), '[]'::jsonb)
                        from outreach_chats c where c.visitor_id = v.id and c.provider = 'WEBCHAT'));
end $$;

create or replace function outreach_webchat_v_reset(p_visitor uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_visitors set token_version = token_version + 1 where id = p_visitor and outreach_is_service()
$$;

-- setUser (PRD §7): p_verified = HMAC checked by the edge function. Merge rules:
--   verified identifier already exists → merge THIS visitor into it (conversations move), never the reverse;
--   verified, new identifier → this visitor becomes identified;
--   unverified → attributes stored on this visitor, no merge into anyone else's history.
create or replace function outreach_webchat_v_identify(p_inbox uuid, p_visitor uuid, p_identifier text, p_verified boolean, p_attrs jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; ex outreach_webchat_visitors%rowtype; target uuid; em citext; changed boolean := false;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into v from outreach_webchat_visitors where id = p_visitor and inbox_id = p_inbox;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  em := nullif(lower(btrim(coalesce(p_attrs->>'email', ''))), '');
  if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := null; end if;
  target := v.id;
  if p_verified and p_identifier is not null then
    if v.identifier is not null and v.identifier <> p_identifier and v.identity_verified then
      -- a different verified identity on this device: new session semantics (the widget already called reset)
      insert into outreach_webchat_visitors(workspace_id, inbox_id, ip_hash, country, city, timezone, browser, os, device, locale, last_seen_at)
      values (v.workspace_id, v.inbox_id, v.ip_hash, v.country, v.city, v.timezone, v.browser, v.os, v.device, v.locale, now()) returning * into v;
      target := v.id; changed := true;
    end if;
    select * into ex from outreach_webchat_visitors where inbox_id = p_inbox and identifier = p_identifier and merged_into is null and id <> v.id;
    if found then
      -- merge the anonymous visitor into the existing identified one
      update outreach_chats set visitor_id = ex.id, lead_id = coalesce(lead_id, ex.lead_id) where visitor_id = v.id;
      update outreach_webchat_page_views set visitor_id = ex.id where visitor_id = v.id;
      update outreach_webchat_events set visitor_id = ex.id where visitor_id = v.id;
      update outreach_webchat_visitors set merged_into = ex.id, token_version = token_version + 1 where id = v.id;
      target := ex.id; changed := true;
    end if;
    update outreach_webchat_visitors set identifier = p_identifier, identity_verified = true,
      name = coalesce(nullif(p_attrs->>'name', ''), name), email = coalesce(em, email), email_verified = case when em is not null then true else email_verified end,
      phone = coalesce(nullif(p_attrs->>'phone', ''), phone), avatar_url = coalesce(nullif(p_attrs->>'avatar_url', ''), avatar_url), company = coalesce(nullif(p_attrs->>'company', ''), company),
      custom_attributes = custom_attributes || coalesce(p_attrs->'custom_attributes', '{}'::jsonb), last_seen_at = now()
     where id = target;
    perform outreach_webchat__link_lead(target, true);
    insert into outreach_webchat_events(visitor_id, name, props) values (target, 'identified', jsonb_build_object('verified', true, 'identifier', p_identifier));
  else
    -- unverified: context only; the identifier is never claimed (a verified visitor may own it) and nothing merges (PRD §7)
    update outreach_webchat_visitors set
      name = coalesce(nullif(p_attrs->>'name', ''), name), email = coalesce(em, email), phone = coalesce(nullif(p_attrs->>'phone', ''), phone),
      avatar_url = coalesce(nullif(p_attrs->>'avatar_url', ''), avatar_url), company = coalesce(nullif(p_attrs->>'company', ''), company),
      custom_attributes = custom_attributes || coalesce(p_attrs->'custom_attributes', '{}'::jsonb) || case when p_identifier is not null then jsonb_build_object('claimed_identifier', p_identifier) else '{}'::jsonb end,
      last_seen_at = now()
     where id = target;
    perform outreach_webchat__link_lead(target, false);
    insert into outreach_webchat_events(visitor_id, name, props) values (target, 'identified', jsonb_build_object('verified', false));
  end if;
  select * into v from outreach_webchat_visitors where id = target;
  perform outreach_emit_event(v.workspace_id, 'webchat.visitor.identified', jsonb_build_object('id', v.id, 'inbox_id', p_inbox, 'identifier', v.identifier, 'verified', v.identity_verified, 'lead_id', v.lead_id));
  return jsonb_build_object('visitor', outreach_webchat__visitor_json(v), 'changed', changed,
    'conversations', (select coalesce(jsonb_agg(outreach_webchat__conversation_json(c) order by c.last_message_at desc nulls last, c.created_at desc), '[]'::jsonb) from outreach_chats c where c.visitor_id = v.id and c.provider = 'WEBCHAT'));
end $$;

create or replace function outreach_webchat_v_attrs(p_visitor uuid, p_chat uuid, p_custom jsonb, p_delete text[], p_conv_custom jsonb, p_conv_delete text[], p_add_labels text[], p_remove_labels text[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; c outreach_chats%rowtype; k text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into v from outreach_webchat_visitors where id = p_visitor;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_custom is not null then v.custom_attributes := v.custom_attributes || p_custom; end if;
  if p_delete is not null then foreach k in array p_delete loop v.custom_attributes := v.custom_attributes - k; end loop; end if;
  update outreach_webchat_visitors set custom_attributes = left(v.custom_attributes::text, 20000)::jsonb where id = v.id;
  if p_chat is not null then
    c := outreach_webchat__own(p_visitor, p_chat);
    if p_conv_custom is not null then c.custom_attributes := c.custom_attributes || p_conv_custom; end if;
    if p_conv_delete is not null then foreach k in array p_conv_delete loop c.custom_attributes := c.custom_attributes - k; end loop; end if;
    if p_add_labels is not null then c.labels := (select array_agg(distinct x) from unnest(c.labels || p_add_labels) x); end if;
    if p_remove_labels is not null then c.labels := (select coalesce(array_agg(x), '{}') from unnest(c.labels) x where x <> all(p_remove_labels)); end if;
    update outreach_chats set custom_attributes = left(c.custom_attributes::text, 20000)::jsonb, labels = c.labels[1:50] where id = c.id;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function outreach_webchat_v_page_views(p_visitor uuid, p_views jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare last_url text; last_title text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into outreach_webchat_page_views(visitor_id, url, title, referrer, utm, at)
  select p_visitor, left(x->>'url', 2000), left(x->>'title', 300), left(x->>'referrer', 2000), x->'utm', coalesce((x->>'at')::timestamptz, now())
    from (select * from jsonb_array_elements(coalesce(p_views, '[]'::jsonb)) limit 50) x where x->>'url' is not null;
  select left(x->>'url', 2000), left(x->>'title', 300) into last_url, last_title from jsonb_array_elements(coalesce(p_views, '[]'::jsonb)) x order by coalesce((x->>'at')::timestamptz, now()) desc limit 1;
  update outreach_webchat_visitors set current_url = coalesce(last_url, current_url), current_title = coalesce(last_title, current_title), current_at = now(), last_seen_at = now(),
    landing_url = coalesce(landing_url, last_url) where id = p_visitor;
end $$;

create or replace function outreach_webchat_v_event(p_visitor uuid, p_chat uuid, p_name text, p_props jsonb) returns void
language sql security definer set search_path = public, extensions as $$
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) select p_visitor, p_chat, left(p_name, 100), coalesce(p_props, '{}'::jsonb) where outreach_is_service() and p_name is not null
$$;

-- Start a conversation (PRD §5.5 pre-chat form, §5.9). p_form: {name, email, phone, custom:{}, consent:{accepted, text_version}}
create or replace function outreach_webchat_v_conversation_start(p_inbox uuid, p_visitor uuid, p_form jsonb, p_source text, p_page jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; c outreach_chats%rowtype; em citext; av jsonb; mode text; ex uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into v from outreach_webchat_visitors where id = p_visitor and inbox_id = p_inbox;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if v.merged_into is not null then select * into v from outreach_webchat_visitors where id = v.merged_into; end if;
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  st := outreach_webchat__settings(p_inbox);
  if coalesce((st#>>'{features,single_conversation}')::boolean, false) then
    select id into ex from outreach_chats where visitor_id = v.id and provider = 'WEBCHAT' and status <> 'resolved' order by created_at desc limit 1;
    if ex is not null then select * into c from outreach_chats where id = ex; return jsonb_build_object('conversation', outreach_webchat__conversation_json(c), 'existing', true); end if;
  end if;
  if p_form is not null then
    em := nullif(lower(btrim(coalesce(p_form->>'email', ''))), '');
    if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then em := null; end if;
    update outreach_webchat_visitors set name = coalesce(nullif(left(p_form->>'name', 120), ''), name), email = coalesce(em, email), phone = coalesce(nullif(left(p_form->>'phone', 40), ''), phone),
      custom_attributes = custom_attributes || coalesce(p_form->'custom', '{}'::jsonb),
      consent = case when (p_form->'consent'->>'accepted')::boolean then jsonb_build_object('marketing', true, 'text_version', coalesce(p_form->'consent'->>'text_version', st#>>'{pre_chat,consent,text_version}'), 'at', now()) else consent end
     where id = v.id;
    perform outreach_webchat__link_lead(v.id, false);
    select * into v from outreach_webchat_visitors where id = v.id;   -- reload: link_lead may have set lead_id
  end if;
  av := outreach_webchat__availability(p_inbox);
  mode := av->>'ai_mode';
  if mode = 'offline_only' then mode := case when (av->>'online')::boolean then 'off' else 'first' end; end if;
  insert into outreach_chats(workspace_id, client_id, sender_id, lead_id, unipile_chat_id, provider, attendee_provider_id, attendee_name, attendee_picture_url,
    webchat_inbox_id, visitor_id, status, source, stream_key, ai_mode, ai_handled, visitor_last_seen_at, subject)
  values (i.workspace_id, i.client_id, i.sender_id, v.lead_id, 'webchat:' || gen_random_uuid()::text, 'WEBCHAT', v.id::text, coalesce(v.name, 'Visitor'), v.avatar_url,
    p_inbox, v.id, 'open', coalesce(p_source, 'launcher'), outreach_webchat__rand(16), mode, mode = 'first', now(), left(p_page->>'title', 200))
  returning * into c;
  update outreach_chats set unipile_chat_id = 'webchat:' || c.id::text where id = c.id;
  if p_form is not null then
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
    values (i.workspace_id, c.id, 'in', null, now(), 'form_response', jsonb_build_object('form', 'pre_chat', 'values', jsonb_strip_nulls(jsonb_build_object('name', p_form->>'name', 'email', em, 'phone', p_form->>'phone', 'custom', p_form->'custom'))), 'visitor', 'widget', 'prospect');
    update outreach_chats set unread = false, unread_count = 0, last_message_preview = null where id = c.id;   -- a form is not a message to read
  end if;
  if p_page->>'campaign_message' is not null then
    -- proactive campaign (PRD §5.11): the nudge the visitor answered is the first line of the thread
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
    values (i.workspace_id, c.id, 'out', left(p_page->>'campaign_message', 1000), now(), 'text', jsonb_build_object('campaign_id', p_page->>'campaign_id'), 'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
    if (p_page->>'campaign_id') ~ '^[0-9a-f-]{36}$' then update outreach_webchat_campaigns set started = started + 1 where id = (p_page->>'campaign_id')::uuid and inbox_id = i.id; end if;
  elsif coalesce((st#>>'{messages,greeting_enabled}')::boolean, true) and nullif(btrim(coalesce(st#>>'{messages,greeting}', '')), '') is not null then
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
    values (i.workspace_id, c.id, 'out', st#>>'{messages,greeting}', now(), 'text', jsonb_build_object('greeting', true), 'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
  end if;
  if p_page is not null then insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (v.id, c.id, 'conversation_started', jsonb_build_object('url', p_page->>'url', 'source', p_source)); end if;
  perform outreach_emit_event(i.workspace_id, 'webchat.conversation.created', jsonb_build_object('id', c.id, 'inbox_id', p_inbox, 'visitor_id', v.id, 'lead_id', v.lead_id, 'source', p_source));
  select * into c from outreach_chats where id = c.id;
  return jsonb_build_object('conversation', outreach_webchat__conversation_json(c), 'existing', false, 'visitor', outreach_webchat__visitor_json(v));
end $$;

create or replace function outreach_webchat_v_conversations(p_visitor uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when outreach_is_service() then (select coalesce(jsonb_agg(outreach_webchat__conversation_json(c) order by c.last_message_at desc nulls last, c.created_at desc), '[]'::jsonb)
    from outreach_chats c where c.provider = 'WEBCHAT' and c.visitor_id in (select coalesce(merged_into, id) from outreach_webchat_visitors where id = p_visitor)) else null end
$$;

create or replace function outreach_webchat_v_conversation(p_visitor uuid, p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  return outreach_webchat__conversation_json(c);
end $$;

create or replace function outreach_webchat_v_messages(p_visitor uuid, p_chat uuid, p_before timestamptz, p_after timestamptz, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; lim int := greatest(1, least(coalesce(p_limit, 50), 200));
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  if p_after is not null then
    return (select coalesce(jsonb_agg(outreach_webchat__message_json(m) order by m.sent_at, m.created_at), '[]'::jsonb) from (
      select * from outreach_messages m where m.chat_id = c.id and m.created_at > p_after order by m.created_at limit lim) m);
  end if;
  return (select coalesce(jsonb_agg(outreach_webchat__message_json(m) order by m.sent_at, m.created_at), '[]'::jsonb) from (
    select * from outreach_messages m where m.chat_id = c.id and (p_before is null or m.sent_at < p_before) order by m.sent_at desc, m.created_at desc limit lim) m);
end $$;

-- Handoff to a person (PRD §11): marks the chat, assigns, posts the system line, notifies; idempotent.
create or replace function outreach_webchat_v_handoff(p_chat uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st jsonb; av jsonb; v outreach_webchat_visitors%rowtype; msg text; assigned uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if c.handed_off_at is not null then return jsonb_build_object('already', true, 'assigned', c.assigned_to is not null); end if;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  av := outreach_webchat__availability(c.webchat_inbox_id);
  select * into v from outreach_webchat_visitors where id = c.visitor_id;
  update outreach_chats set handed_off_at = now(), handoff_reason = left(p_reason, 60), ai_handled = false, status = 'open', unread = true where id = c.id;
  assigned := outreach_webchat__auto_assign(c.id);
  msg := case when (av->>'online')::boolean then st#>>'{messages,handoff_message}' else st#>>'{messages,handoff_offline_message}' end;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
  values (c.workspace_id, c.id, 'out', msg, now(), case when (av->>'online')::boolean or v.email is not null then 'text' else 'form' end,
          case when (av->>'online')::boolean or v.email is not null then jsonb_build_object('handoff', true) else jsonb_build_object('handoff', true, 'form', 'email', 'prompt', msg) end,
          'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (c.visitor_id, c.id, 'handoff', jsonb_build_object('reason', p_reason, 'online', av->'online'));
  perform outreach_emit_event(c.workspace_id, 'webchat.handoff', jsonb_build_object('id', c.id, 'inbox_id', c.webchat_inbox_id, 'visitor_id', c.visitor_id, 'reason', p_reason, 'assigned_to', assigned));
  return jsonb_build_object('already', false, 'assigned', assigned is not null, 'online', av->'online');
end $$;

-- Visitor message (PRD §5.4, §7, §15). Returns {message, conversation, ai:boolean, handoff:boolean, dropped:boolean}.
--   blocked visitor   → dropped silently (echo returned so the widget shows it as sent)
--   resolved chat     → reopened, or a NEW conversation when "allow messages after resolved" is off (the returned conversation differs)
--   linked lead       → reply-stop through the side-effects trigger
--   AI                → true when the AI should answer this message (the edge function then streams /chat)
create or replace function outreach_webchat_v_message(p_visitor uuid, p_chat uuid, p_echo text, p_text text, p_attachments jsonb, p_content_type text, p_attrs jsonb, p_source text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; m outreach_messages%rowtype; txt text; blocked boolean;
        links int; flags text[] := '{}'; ai boolean := false; handoff boolean := false; av jsonb; kw text; reopened boolean := false; newconv boolean := false; em citext;
        ctype text := coalesce(p_content_type, 'text'); in_seq boolean; pool jsonb; new_id uuid;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  select * into v from outreach_webchat_visitors where id = c.visitor_id;
  select * into i from outreach_webchat_inboxes where id = c.webchat_inbox_id;
  st := outreach_webchat__settings(i.id);
  txt := left(coalesce(p_text, ''), 5000);
  if ctype not in ('text','attachment','form_response') then raise exception 'E_PAYLOAD_INVALID'; end if;
  if ctype = 'text' and btrim(txt) = '' and jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 0 then raise exception 'E_PAYLOAD_INVALID'; end if;
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 0 then ctype := 'attachment'; end if;
  -- dedupe on echo id
  if p_echo is not null then
    select * into m from outreach_messages where chat_id = c.id and echo_id = p_echo;
    if found then return jsonb_build_object('message', outreach_webchat__message_json(m), 'conversation', outreach_webchat__conversation_json(c), 'ai', false, 'handoff', false, 'dropped', false, 'duplicate', true); end if;
  end if;
  blocked := v.blocked_at is not null or exists (select 1 from outreach_webchat_blocks b where b.inbox_id = i.id and ((b.kind = 'visitor' and b.value = v.id::text) or (b.kind = 'ip_hash' and b.value = v.ip_hash) or (b.kind = 'country' and v.country is not null and upper(b.value) = upper(v.country))));
  if blocked then
    insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (v.id, c.id, 'message_dropped', jsonb_build_object('reason', 'blocked', 'len', length(txt)));
    return jsonb_build_object('message', jsonb_build_object('id', gen_random_uuid(), 'echo_id', p_echo, 'conversation_id', c.id, 'sender_type', 'visitor', 'content_type', ctype, 'text', txt, 'attachments', '[]'::jsonb, 'sent_at', now(), 'content_attributes', '{}'::jsonb),
                              'conversation', outreach_webchat__conversation_json(c), 'ai', false, 'handoff', false, 'dropped', true);
  end if;
  -- rate limits (per visitor; ip + inbox limits are applied by the edge function with the same settings)
  if not outreach_rate_limit('webchat:v:' || v.id::text || ':10s', coalesce((st#>>'{security,rate_limits,visitor_10s}')::int, 10), 10)
     or not outreach_rate_limit('webchat:v:' || v.id::text || ':1h', coalesce((st#>>'{security,rate_limits,visitor_1h}')::int, 200), 3600) then
    raise exception 'E_RATE_LIMITED';
  end if;
  -- resolved: reopen or start a new conversation
  if c.status = 'resolved' then
    if coalesce((st#>>'{features,allow_after_resolved}')::boolean, true) then
      update outreach_chats set status = 'open', resolved_at = null, resolved_by = null, unread = true where id = c.id returning * into c;
      reopened := true;
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
      values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', 'reopened'), 'system', 'system', 'inbox_user');
    else
      -- evaluate first: a volatile call inside WHERE would run once per scanned row
      new_id := ((outreach_webchat_v_conversation_start(i.id, v.id, null, coalesce(p_source, 'launcher'), null))->'conversation'->>'id')::uuid;
      select * into c from outreach_chats where id = new_id;
      newconv := true;
    end if;
  elsif c.status in ('pending','snoozed') then
    update outreach_chats set status = 'open', snoozed_until = null, unread = true where id = c.id returning * into c;
  end if;
  -- form responses (email capture / pre-chat inside the chat)
  if ctype = 'form_response' and p_attrs->>'form' = 'email' then
    em := nullif(lower(btrim(coalesce(p_attrs->'values'->>'email', ''))), '');
    if em is null or em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: email'; end if;
    update outreach_webchat_visitors set email = coalesce(email, em), email_invalid = false where id = v.id returning * into v;
    perform outreach_webchat__link_lead(v.id, false);
    txt := null;
  end if;
  -- spam heuristics (PRD §7): flagged, never rejected
  links := (select count(*) from regexp_matches(txt, 'https?://', 'gi'));
  if links > 5 then flags := array_append(flags, 'link_spam'); end if;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, attachments, sender_type, sender_name, sender_identifier, source, origin, echo_id)
  values (c.workspace_id, c.id, 'in', nullif(txt, ''), now(), ctype,
          coalesce(p_attrs, '{}'::jsonb) || case when cardinality(flags) > 0 then jsonb_build_object('internal', jsonb_build_object('flags', to_jsonb(flags))) else '{}'::jsonb end,
          coalesce(p_attachments, '[]'::jsonb), 'visitor', coalesce(v.name, 'Visitor'), v.email, coalesce(p_source, 'widget'), 'prospect', p_echo)
  returning * into m;
  update outreach_webchat_uploads set message_id = m.id, chat_id = c.id where visitor_id = v.id and message_id is null and path in (select a->>'id' from jsonb_array_elements(coalesce(p_attachments, '[]'::jsonb)) a);
  update outreach_webchat_visitors set last_seen_at = now() where id = v.id;
  update outreach_chats set visitor_last_seen_at = now(), visitor_typing_at = null, visitor_typing_text = null where id = c.id;
  av := outreach_webchat__availability(i.id);
  -- who answers: the AI (until handed off), or a person
  if ctype = 'text' and c.handed_off_at is null and coalesce(c.ai_mode, 'off') <> 'off' and i.ai_enabled then
    ai := true;
    foreach kw in array (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(coalesce(st#>'{ai,handoff,keywords}', '[]'::jsonb)) x) loop
      if kw <> '' and position(lower(kw) in lower(txt)) > 0 then handoff := true; end if;
    end loop;
    if txt ~* '\m(talk|speak|chat) (to|with) (a |an |someone|the )?(person|human|agent|rep|team|someone)\M' or txt ~* '\m(real|live) (person|human|agent)\M' then handoff := true; end if;
    if coalesce((st#>>'{ai,handoff,leads_in_sequence}')::boolean, true) and c.lead_id is not null then
      select exists (select 1 from outreach_enrollments e where e.lead_id = c.lead_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) into in_seq;
      if in_seq then handoff := true; end if;
    end if;
    if not handoff then
      pool := outreach__ai_pool(c.workspace_id);
      if not coalesce((pool->>'ok')::boolean, true) then ai := false; end if;   -- pool exhausted: silent switch to live chat (PRD §11)
      if ai and not outreach_rate_limit('webchat:ai:' || v.id::text, coalesce((st#>>'{ai,hourly_cap_per_visitor}')::int, 30), 3600) then ai := false; end if;
      if ai and (select count(*) from outreach_webchat_ai_turns t where t.chat_id = c.id) >= coalesce((st#>>'{ai,handoff,max_turns}')::int, 6) then handoff := true; end if;
    end if;
    if handoff then ai := false; perform outreach_webchat_v_handoff(c.id, 'visitor_request'); end if;
    if not ai and not handoff and c.handed_off_at is null then perform outreach_webchat_v_handoff(c.id, 'ai_unavailable'); end if;
  end if;
  -- nobody online, unknown visitor: ask for the email once (PRD §5.6)
  if not ai and coalesce((st#>>'{features,email_capture}')::boolean, true) and not (av->>'online')::boolean and v.email is null and ctype <> 'form_response'
     and not exists (select 1 from outreach_messages x where x.chat_id = c.id and x.content_type = 'form' and x.content_attributes->>'form' = 'email') then
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
    values (c.workspace_id, c.id, 'out', st#>>'{messages,email_capture_prompt}', now(), 'form', jsonb_build_object('form', 'email', 'prompt', st#>>'{messages,email_capture_prompt}'), 'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
  end if;
  if not ai and c.assigned_to is null and c.handed_off_at is not null then perform outreach_webchat__auto_assign(c.id); end if;
  if not ai and coalesce(c.ai_mode, 'off') = 'off' and c.assigned_to is null then perform outreach_webchat__auto_assign(c.id); end if;
  perform outreach_emit_event(c.workspace_id, 'webchat.message.created', jsonb_build_object('id', m.id, 'chat_id', c.id, 'inbox_id', i.id, 'visitor_id', v.id, 'lead_id', c.lead_id, 'text', left(txt, 500), 'content_type', ctype));
  select * into c from outreach_chats where id = c.id;
  return jsonb_build_object('message', outreach_webchat__message_json(m), 'conversation', outreach_webchat__conversation_json(c), 'ai', ai, 'handoff', handoff, 'dropped', false, 'reopened', reopened, 'new_conversation', newconv);
end $$;

-- Bot / system line into a chat (greeting, AI answer, forms, CSAT prompt). Returns the message json.
create or replace function outreach_webchat_v_bot_message(p_chat uuid, p_text text, p_content_type text, p_attrs jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype; st jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
  values (c.workspace_id, c.id, 'out', nullif(left(coalesce(p_text, ''), 20000), ''), now(), coalesce(p_content_type, 'text'), coalesce(p_attrs, '{}'::jsonb), 'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot')
  returning * into m;
  return outreach_webchat__message_json(m);
end $$;

-- Everything the AI answer needs in one call (edge function streams the model): settings, knowledge ids, history, guard state.
create or replace function outreach_webchat_v_ai_context(p_chat uuid, p_message uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; w outreach_workspaces%rowtype; agent_after boolean; q outreach_messages%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into q from outreach_messages where id = p_message and chat_id = c.id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = c.webchat_inbox_id;
  select * into w from outreach_workspaces where id = c.workspace_id;
  st := outreach_webchat__settings(i.id);
  -- an agent answered after this question → the AI stays quiet ("agent message wins", PRD §15)
  select exists (select 1 from outreach_messages x where x.chat_id = c.id and x.direction = 'out' and x.sender_type = 'agent' and x.created_at > q.created_at) into agent_after;
  return jsonb_build_object(
    'ok', c.handed_off_at is null and not agent_after and coalesce(c.ai_mode, 'off') <> 'off' and i.ai_enabled,
    'workspace_id', c.workspace_id, 'inbox_id', i.id, 'visitor_id', c.visitor_id, 'brand', coalesce(st#>>'{appearance,brand_name}', i.name),
    'persona', st#>>'{ai,persona}', 'allowed_topics', st#>>'{ai,allowed_topics}', 'show_sources', coalesce((st#>>'{ai,show_sources}')::boolean, true),
    'knowledge_source_ids', coalesce(st#>'{ai,knowledge_source_ids}', '[]'::jsonb),
    'low_confidence_streak', coalesce((st#>>'{ai,handoff,low_confidence_streak}')::int, 2),
    'recent_low', (select count(*) from (select t.confidence from outreach_webchat_ai_turns t where t.chat_id = c.id order by t.created_at desc limit coalesce((st#>>'{ai,handoff,low_confidence_streak}')::int, 2)) x where x.confidence in ('low','refused')),
    'query', q.text, 'page_url', (select current_url from outreach_webchat_visitors where id = c.visitor_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('role', case when x.direction = 'in' then 'user' else 'assistant' end, 'text', x.text) order by x.sent_at), '[]'::jsonb)
                  from (select * from outreach_messages x where x.chat_id = c.id and x.id <> q.id and x.text is not null and x.content_type = 'text' and x.deleted_at is null order by x.sent_at desc limit 8) x),
    'pool', outreach__ai_pool(c.workspace_id),
    'online', (outreach_webchat__availability(i.id))->'online',
    'visitor_email', (select email from outreach_webchat_visitors where id = c.visitor_id));
end $$;

-- Record an AI turn (+ the pool row) and post the answer as the bot message. Returns {turn_id, message}.
create or replace function outreach_webchat_v_ai_record(p_chat uuid, p_message uuid, p_turn jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; msg jsonb; tid uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if nullif(btrim(coalesce(p_turn->>'answer', '')), '') is not null then
    msg := outreach_webchat_v_bot_message(c.id, p_turn->>'answer', 'text', jsonb_build_object('ai', true, 'sources', coalesce(p_turn->'sources', '[]'::jsonb), 'confidence', p_turn->>'confidence'));
  end if;
  insert into outreach_webchat_ai_turns(workspace_id, inbox_id, chat_id, visitor_id, question_message_id, answer_message_id, query, answer, sources, confidence, handoff, page_url, tokens_in, tokens_out, latency_ms, model)
  values (c.workspace_id, c.webchat_inbox_id, c.id, c.visitor_id, p_message, (msg->>'id')::uuid, left(coalesce(p_turn->>'query', ''), 2000), p_turn->>'answer', coalesce(p_turn->'sources', '[]'::jsonb),
          p_turn->>'confidence', p_turn->>'handoff', p_turn->>'page_url', (p_turn->>'tokens_in')::int, (p_turn->>'tokens_out')::int, (p_turn->>'latency_ms')::int, p_turn->>'model')
  returning id into tid;
  insert into outreach_ai_calls(workspace_id, purpose, model, tokens_in, tokens_out, latency_ms) values (c.workspace_id, 'webchat_answer', p_turn->>'model', (p_turn->>'tokens_in')::int, (p_turn->>'tokens_out')::int, (p_turn->>'latency_ms')::int);
  if msg is not null then update outreach_messages set content_attributes = content_attributes || jsonb_build_object('turn_id', tid) where id = (msg->>'id')::uuid; end if;
  update outreach_chats set ai_handled = true where id = c.id and handed_off_at is null;
  return jsonb_build_object('turn_id', tid, 'message', case when msg is null then null else msg || jsonb_build_object('content_attributes', (msg->'content_attributes') || jsonb_build_object('turn_id', tid)) end);
end $$;

create or replace function outreach_webchat_v_feedback(p_visitor uuid, p_turn uuid, p_value int, p_text text) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_ai_turns t set feedback = case when p_value > 0 then 1 else -1 end, feedback_text = left(p_text, 1000)
   where t.id = p_turn and outreach_is_service() and t.visitor_id in (select coalesce(merged_into, id) from outreach_webchat_visitors where id = p_visitor union select p_visitor)
$$;

create or replace function outreach_webchat_v_typing(p_visitor uuid, p_chat uuid, p_on boolean, p_preview text) returns void
language plpgsql security definer set search_path = public, extensions, realtime as $$
declare c outreach_chats%rowtype;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  update outreach_chats set visitor_typing_at = case when p_on then now() else null end, visitor_typing_text = case when p_on then left(p_preview, 300) else null end, visitor_last_seen_at = now() where id = c.id;
end $$;

create or replace function outreach_webchat_v_heartbeat(p_visitor uuid, p_chat uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  update outreach_chats set visitor_last_seen_at = now() where id = c.id;
  update outreach_webchat_visitors set last_seen_at = now() where id = c.visitor_id;
  return jsonb_build_object('agent_typing', c.agent_typing_at is not null and c.agent_typing_at > now() - interval '8 seconds', 'status', c.status);
end $$;

create or replace function outreach_webchat_v_read(p_visitor uuid, p_chat uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  update outreach_messages set read_by_visitor_at = now() where chat_id = c.id and direction = 'out' and read_by_visitor_at is null;
  update outreach_chats set visitor_last_seen_at = now() where id = c.id;
end $$;

create or replace function outreach_webchat_v_resolve(p_visitor uuid, p_chat uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st jsonb;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  st := outreach_webchat__settings(c.webchat_inbox_id);
  if not coalesce((st#>>'{features,end_conversation}')::boolean, true) then raise exception 'E_FORBIDDEN: end_conversation disabled'; end if;
  if c.status <> 'resolved' then
    update outreach_chats set status = 'resolved', resolved_at = now(), resolved_by = 'visitor', unread = false where id = c.id;
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
    values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', 'resolved', 'by', 'visitor'), 'system', 'system', 'inbox_user');
    perform outreach_webchat__post_csat(c.id);
    perform outreach_emit_event(c.workspace_id, 'webchat.conversation.resolved', jsonb_build_object('id', c.id, 'inbox_id', c.webchat_inbox_id, 'by', 'visitor'));
  end if;
  select * into c from outreach_chats where id = c.id;
  return outreach_webchat__conversation_json(c);
end $$;

-- CSAT prompt on resolve (PRD §5.8), once per conversation.
create or replace function outreach_webchat__post_csat(p_chat uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st jsonb;
begin
  select * into c from outreach_chats where id = p_chat;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  if not coalesce((st#>>'{csat,enabled}')::boolean, true) then return; end if;
  if c.csat is not null or exists (select 1 from outreach_messages x where x.chat_id = c.id and x.content_type = 'csat') then return; end if;
  if not exists (select 1 from outreach_messages x where x.chat_id = c.id and x.direction = 'in' and x.sender_type = 'visitor') then return; end if;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
  values (c.workspace_id, c.id, 'out', st#>>'{messages,end_message}', now(), 'csat', jsonb_build_object('scale', st#>>'{csat,scale}', 'ask_comment', coalesce((st#>>'{csat,ask_comment}')::boolean, true)), 'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
end $$;

create or replace function outreach_webchat_v_csat(p_visitor uuid, p_chat uuid, p_rating int, p_comment text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  if p_rating is null or p_rating < 1 or p_rating > 5 then raise exception 'E_PAYLOAD_INVALID: rating'; end if;
  if c.csat is not null and (c.csat->>'at')::timestamptz < now() - interval '24 hours' then raise exception 'E_FORBIDDEN: csat locked'; end if;
  update outreach_chats set csat = jsonb_build_object('rating', p_rating, 'comment', left(p_comment, 1000), 'at', coalesce((c.csat->>'at')::timestamptz, now()), 'updated_at', now(), 'assigned_to', c.assigned_to) where id = c.id;
  update outreach_messages set content_attributes = content_attributes || jsonb_build_object('response', jsonb_build_object('rating', p_rating, 'comment', left(p_comment, 1000))) where chat_id = c.id and content_type = 'csat';
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (c.visitor_id, c.id, 'csat', jsonb_build_object('rating', p_rating));
  perform outreach_emit_event(c.workspace_id, 'webchat.csat.submitted', jsonb_build_object('id', c.id, 'inbox_id', c.webchat_inbox_id, 'rating', p_rating, 'comment', left(p_comment, 1000), 'assigned_to', c.assigned_to));
  select * into c from outreach_chats where id = c.id;
  return outreach_webchat__conversation_json(c);
end $$;

create or replace function outreach_webchat_v_upload_register(p_visitor uuid, p_chat uuid, p_path text, p_name text, p_mime text, p_size int) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; id_ uuid;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  insert into outreach_webchat_uploads(inbox_id, visitor_id, chat_id, path, name, mime, size) values (c.webchat_inbox_id, c.visitor_id, c.id, p_path, left(p_name, 200), p_mime, p_size) returning id into id_;
  return id_;
end $$;

-- Storage path of an attachment the visitor may read (their own chats only).
create or replace function outreach_webchat_v_attachment_path(p_visitor uuid, p_chat uuid, p_attachment text) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; p text;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  select a->>'id' into p from outreach_messages m, jsonb_array_elements(coalesce(m.attachments, '[]'::jsonb)) a where m.chat_id = c.id and a->>'id' = p_attachment and (a->>'storage')::boolean limit 1;
  return p;
end $$;

create or replace function outreach_webchat_v_transcript(p_visitor uuid, p_chat uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; v outreach_webchat_visitors%rowtype; st jsonb;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  select * into v from outreach_webchat_visitors where id = c.visitor_id;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  return jsonb_build_object('email', v.email, 'brand', st#>>'{appearance,brand_name}', 'workspace_id', c.workspace_id, 'inbox_id', c.webchat_inbox_id, 'chat_id', c.id, 'visitor_name', v.name,
    'reply_mailbox_id', (select reply_mailbox_id from outreach_webchat_inboxes where id = c.webchat_inbox_id),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('sender_type', m.sender_type, 'sender_name', m.sender_name, 'text', m.text, 'sent_at', m.sent_at, 'content_type', m.content_type) order by m.sent_at), '[]'::jsonb)
                   from outreach_messages m where m.chat_id = c.id and m.deleted_at is null and m.content_type in ('text','attachment') and m.text is not null));
end $$;

create or replace function outreach_webchat_v_campaign_hit(p_inbox uuid, p_campaign uuid, p_kind text, p_visitor uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_webchat_campaigns set shown = shown + (p_kind = 'shown')::int, clicked = clicked + (p_kind = 'clicked')::int, started = started + (p_kind = 'started')::int where id = p_campaign and inbox_id = p_inbox;
  if p_visitor is not null then insert into outreach_webchat_events(visitor_id, name, props) values (p_visitor, 'campaign_' || p_kind, jsonb_build_object('campaign_id', p_campaign)); end if;
end $$;

-- ===============================================================================================================
-- Continuity emails (PRD §9) — worker side
-- ===============================================================================================================
-- Chats owed a digest: visitor has an email, inactive for inactivity_min, unseen agent/bot messages older than the delay,
-- last email ≥ digest_window ago, continuity on, address not bounced, not stopped by the visitor.
create or replace function outreach_webchat_continuity_due(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_is_service() then null else (
    select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
      select c.id as chat_id, c.workspace_id, c.webchat_inbox_id as inbox_id, i.reply_mailbox_id, v.id as visitor_id, v.email, v.name as visitor_name,
             st#>>'{appearance,brand_name}' as brand, c.email_root_message_id, c.email_thread_key, c.last_continuity_email_at, c.status, c.resolved_at,
             (select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'text', m.text, 'sender_type', m.sender_type, 'sender_name', m.sender_name, 'sent_at', m.sent_at, 'content_type', m.content_type) order by m.sent_at), '[]'::jsonb)
                from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sender_type in ('agent','bot') and m.read_by_visitor_at is null and m.deleted_at is null
                 and m.content_type in ('text','attachment') and m.text is not null and m.created_at > coalesce(c.last_continuity_email_at, '-infinity'::timestamptz)
                 and coalesce((m.content_attributes->>'greeting')::boolean, false) = false) as messages
        from outreach_chats c
        join outreach_webchat_inboxes i on i.id = c.webchat_inbox_id and i.deleted_at is null
        join outreach_webchat_visitors v on v.id = c.visitor_id
        cross join lateral (select outreach_webchat__settings(i.id) as st) s
       where c.provider = 'WEBCHAT' and v.email is not null and not v.email_invalid and not c.continuity_stopped
         and coalesce((st#>>'{continuity,enabled}')::boolean, true)
         and coalesce(c.visitor_last_seen_at, c.created_at) < now() - make_interval(mins => greatest(3, least(coalesce((st#>>'{continuity,inactivity_min}')::int, 5), 30)))
         and (c.last_continuity_email_at is null or c.last_continuity_email_at < now() - make_interval(mins => greatest(5, coalesce((st#>>'{continuity,digest_window_min}')::int, 15))))
         and exists (select 1 from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sender_type in ('agent','bot') and m.read_by_visitor_at is null and m.deleted_at is null
                        and m.content_type in ('text','attachment') and m.text is not null and coalesce((m.content_attributes->>'greeting')::boolean, false) = false
                        and m.created_at > coalesce(c.last_continuity_email_at, '-infinity'::timestamptz)
                        and m.created_at < now() - make_interval(mins => greatest(3, least(coalesce((st#>>'{continuity,inactivity_min}')::int, 5), 30))))
       order by c.last_message_at limit greatest(1, least(coalesce(p_limit, 50), 200))) x) end
$$;

create or replace function outreach_webchat_continuity_record(p_chat uuid, p_kind text, p_to text, p_message_ids uuid[], p_transport text, p_mailbox uuid, p_tracking text, p_provider text, p_subject text, p_root text, p_error text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare id_ uuid; c outreach_chats%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat;
  insert into outreach_webchat_continuity_emails(chat_id, visitor_id, kind, to_email, message_ids, transport, mailbox_id, tracking_id, provider_id, subject, error)
  values (p_chat, c.visitor_id, coalesce(p_kind, 'digest'), p_to, coalesce(p_message_ids, '{}'), p_transport, p_mailbox, p_tracking, p_provider, p_subject, p_error) returning id into id_;
  if p_error is null then
    update outreach_chats set last_continuity_email_at = now(), email_root_message_id = coalesce(email_root_message_id, p_root) where id = p_chat;
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
    values (c.workspace_id, p_chat, 'out', null, now(), 'event', jsonb_build_object('kind', 'email_sent', 'to', p_to, 'count', coalesce(cardinality(p_message_ids), 0), 'email_kind', p_kind), 'system', 'system', 'inbox_user');
  end if;
  return id_;
end $$;

-- mail_sent webhook for one of our continuity emails: remember the Unipile thread so replies route back. Returns the chat id or null.
create or replace function outreach_webchat_continuity_link(p_tracking text, p_provider text, p_unipile_email_id text, p_thread_id text) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_webchat_continuity_emails%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into r from outreach_webchat_continuity_emails e
   where (p_tracking is not null and e.tracking_id = p_tracking) or (p_provider is not null and e.provider_id = p_provider) or (p_unipile_email_id is not null and e.unipile_email_id = p_unipile_email_id)
   order by e.sent_at desc limit 1;
  if not found then return null; end if;
  update outreach_webchat_continuity_emails set unipile_email_id = coalesce(p_unipile_email_id, unipile_email_id), thread_id = coalesce(p_thread_id, thread_id) where id = r.id;
  update outreach_chats set email_thread_key = coalesce(email_thread_key, p_thread_id, p_unipile_email_id) where id = r.chat_id;
  return r.chat_id;
end $$;

-- Inbound mail: is this a reply to a web-chat continuity email? Match by thread / in-reply-to id, then by the [#ref] token in the subject + sender address.
create or replace function outreach_webchat_continuity_match(p_thread_id text, p_in_reply_to text, p_from text, p_subject text) returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare cid uuid; ref text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_thread_id is not null then
    select chat_id into cid from outreach_webchat_continuity_emails where thread_id = p_thread_id or unipile_email_id = p_thread_id order by sent_at desc limit 1;
    if cid is null then select id into cid from outreach_chats where email_thread_key = p_thread_id limit 1; end if;
  end if;
  if cid is null and p_in_reply_to is not null then
    select chat_id into cid from outreach_webchat_continuity_emails where unipile_email_id = p_in_reply_to or provider_id = p_in_reply_to or tracking_id = p_in_reply_to order by sent_at desc limit 1;
  end if;
  if cid is null and p_subject is not null then
    ref := (regexp_match(p_subject, '\[#([a-z0-9]{8,16})\]', 'i'))[1];
    if ref is not null then
      select c.id into cid from outreach_chats c join outreach_webchat_visitors v on v.id = c.visitor_id
       where c.provider = 'WEBCHAT' and c.email_root_message_id = lower(ref) and (p_from is null or v.email = lower(p_from)) limit 1;
    end if;
  end if;
  return cid;
end $$;

-- Append the visitor's email reply to the chat (quote-stripped by the caller). Reopens a resolved chat (PRD §15).
create or replace function outreach_webchat_email_reply_attach(p_chat uuid, p_from text, p_text text, p_unipile_message_id text, p_sent_at timestamptz, p_attachments jsonb) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if p_unipile_message_id is not null and exists (select 1 from outreach_messages where unipile_message_id = p_unipile_message_id) then return null; end if;
  if c.status = 'resolved' then
    update outreach_chats set status = 'open', resolved_at = null, resolved_by = null where id = c.id;
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
    values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', 'reopened', 'by', 'email'), 'system', 'system', 'inbox_user');
  elsif c.status in ('pending','snoozed') then
    update outreach_chats set status = 'open', snoozed_until = null where id = c.id;
  end if;
  insert into outreach_messages(workspace_id, chat_id, unipile_message_id, direction, text, sent_at, content_type, attachments, sender_type, sender_name, sender_identifier, source, origin)
  values (c.workspace_id, c.id, p_unipile_message_id, 'in', nullif(left(coalesce(p_text, ''), 20000), ''), coalesce(p_sent_at, now()), 'text', coalesce(p_attachments, '[]'::jsonb), 'visitor',
          (select coalesce(name, 'Visitor') from outreach_webchat_visitors where id = c.visitor_id), lower(p_from), 'email', 'prospect')
  returning * into m;
  update outreach_webchat_visitors set email_verified = true, email_invalid = false where id = c.visitor_id and email = lower(p_from);
  if c.assigned_to is null then perform outreach_webchat__auto_assign(c.id); end if;
  perform outreach_emit_event(c.workspace_id, 'webchat.message.created', jsonb_build_object('id', m.id, 'chat_id', c.id, 'inbox_id', c.webchat_inbox_id, 'visitor_id', c.visitor_id, 'lead_id', c.lead_id, 'text', left(p_text, 500), 'content_type', 'text', 'source', 'email'));
  return m.id;
end $$;

create or replace function outreach_webchat_email_bounced(p_chat uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_visitors v set email_invalid = true from outreach_chats c where c.id = p_chat and v.id = c.visitor_id and outreach_is_service();
  update outreach_chats set continuity_stopped = true where id = p_chat and outreach_is_service();
$$;

-- Maintenance (cron): wake snoozed chats, unassign agents who went offline (setting), auto-resolve nothing, purge stale uploads / old page views.
create or replace function outreach_webchat_maintenance() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare woke int; unassigned int := 0; purged int; r record; mins int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_chats set status = 'open', snoozed_until = null where provider = 'WEBCHAT' and status = 'snoozed' and snoozed_until is not null and snoozed_until <= now();
  get diagnostics woke = row_count;
  for r in select i.id, outreach_webchat__settings(i.id) as st from outreach_webchat_inboxes i where i.deleted_at is null loop
    mins := coalesce((r.st#>>'{assignment,unassign_offline_min}')::int, 0);
    if mins > 0 then
      update outreach_chats c set assigned_to = null where c.webchat_inbox_id = r.id and c.status in ('open','pending') and c.assigned_to is not null
         and not exists (select 1 from outreach_webchat_agent_presence p where p.user_id = c.assigned_to and p.workspace_id = c.workspace_id and p.last_seen_at > now() - make_interval(mins => mins) and p.state <> 'offline');
      get diagnostics purged = row_count; unassigned := unassigned + purged;
    end if;
  end loop;
  delete from outreach_webchat_uploads where message_id is null and created_at < now() - interval '1 day';
  get diagnostics purged = row_count;
  delete from outreach_webchat_page_views where at < now() - interval '90 days';
  delete from outreach_webchat_events where at < now() - interval '180 days';
  update outreach_chats set visitor_typing_at = null, visitor_typing_text = null where provider = 'WEBCHAT' and visitor_typing_at < now() - interval '1 minute';
  return jsonb_build_object('woke', woke, 'unassigned', unassigned, 'uploads_purged', purged);
end $$;

-- ===============================================================================================================
-- AGENT RPCs (authenticated)
-- ===============================================================================================================
create or replace function outreach_webchat__inbox_json(i outreach_webchat_inboxes) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select to_jsonb(i) - 'hmac_token' || jsonb_build_object(
    'settings', outreach_webchat__settings(i.id),
    'hmac_token', case when outreach_role_in(i.workspace_id) in ('owner','manager') or outreach_is_service() then i.hmac_token else null end,
    'members', (select coalesce(jsonb_agg(jsonb_build_object('user_id', m.user_id, 'auto_assign', m.auto_assign, 'name', outreach_webchat__agent_name(m.user_id, i.workspace_id),
                   'online', exists (select 1 from outreach_webchat_agent_presence p where p.user_id = m.user_id and p.workspace_id = i.workspace_id and p.state = 'online' and p.last_seen_at > now() - interval '10 minutes'))), '[]'::jsonb)
                  from outreach_webchat_inbox_members m where m.inbox_id = i.id),
    'availability', outreach_webchat__availability(i.id),
    'stats', jsonb_build_object(
      'open', (select count(*) from outreach_chats c where c.webchat_inbox_id = i.id and c.status in ('open','pending')),
      'unassigned', (select count(*) from outreach_chats c where c.webchat_inbox_id = i.id and c.status = 'open' and c.assigned_to is null),
      'today', (select count(*) from outreach_chats c where c.webchat_inbox_id = i.id and c.created_at > date_trunc('day', now())),
      'visitors_30d', (select count(*) from outreach_webchat_visitors v where v.inbox_id = i.id and v.last_seen_at > now() - interval '30 days')),
    'reply_mailbox', (select jsonb_build_object('id', s.id, 'name', s.display_name, 'email', s.owner_email, 'provider', s.provider, 'status', s.status) from outreach_senders s where s.id = i.reply_mailbox_id))
$$;

create or replace function outreach_webchat_inbox_create(p_ws uuid, p_name text, p_domains text[], p_client uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare sid uuid; i outreach_webchat_inboxes%rowtype; lim int; cnt int; plan text;
begin
  perform outreach_require(p_ws, 'manager');
  if p_client is not null and not outreach_client_visible(p_ws, p_client) then raise exception 'E_NOT_FOUND'; end if;
  if nullif(btrim(coalesce(p_name, '')), '') is null then raise exception 'E_PAYLOAD_INVALID: name'; end if;
  -- plan limits (PRD §16): trial/team 1, agency 3, agency_plus unlimited
  select w.plan into plan from outreach_workspaces w where w.id = p_ws;
  lim := case plan when 'agency_plus' then null when 'agency' then 3 else 1 end;
  select count(*) into cnt from outreach_webchat_inboxes where workspace_id = p_ws and deleted_at is null;
  if lim is not null and cnt >= lim then raise exception 'E_PLAN_LIMIT: website inboxes on this plan: %', lim; end if;
  insert into outreach_senders(workspace_id, client_id, owner_user_id, provider, auth_method, display_name, status, timezone)
  values (p_ws, p_client, auth.uid(), 'WEBCHAT', 'oauth', left(btrim(p_name), 80), 'ok', 'UTC') returning id into sid;
  insert into outreach_webchat_inboxes(workspace_id, client_id, sender_id, name, website_token, hmac_token, allowed_domains, created_by, settings)
  values (p_ws, p_client, sid, left(btrim(p_name), 80), outreach_webchat__rand(16), outreach_webchat__rand(24),
          (select coalesce(array_agg(distinct lower(btrim(d))), '{}') from unnest(coalesce(p_domains, '{}')) d where btrim(d) <> ''), auth.uid(),
          jsonb_build_object('appearance', jsonb_build_object('brand_name', left(btrim(p_name), 20))))
  returning * into i;
  insert into outreach_webchat_inbox_members(inbox_id, user_id) values (i.id, auth.uid()) on conflict do nothing;
  insert into outreach_webchat_settings_history(inbox_id, version, settings, business_hours, allowed_domains, changed_by, diff) values (i.id, 1, i.settings, i.business_hours, i.allowed_domains, auth.uid(), jsonb_build_object('created', true));
  perform outreach_audit(p_ws, 'webchat.inbox.created', 'webchat_inbox', i.id::text, jsonb_build_object('name', i.name), 'user');
  return outreach_webchat__inbox_json(i);
end $$;

create or replace function outreach_webchat_inboxes(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(outreach_webchat__inbox_json(i) order by i.created_at), '[]'::jsonb) from outreach_webchat_inboxes i
           where i.workspace_id = p_ws and i.deleted_at is null and outreach_client_visible(p_ws, i.client_id));
end $$;

create or replace function outreach_webchat_inbox_get(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_id and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'client_viewer');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return outreach_webchat__inbox_json(i);
end $$;

-- Patch: {name, allowed_domains, client_id, is_active, ai_enabled, reply_mailbox_id, enforce_identity, business_hours, settings:{section:{...}}}
-- settings are merged per section (nested), versioned in settings_history, config_version bumped.
create or replace function outreach_webchat_inbox_update(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; ns jsonb; d text; doms text[]; mb uuid; accent text;
begin
  select * into i from outreach_webchat_inboxes where id = p_id and deleted_at is null for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_patch ? 'name' then i.name := left(btrim(p_patch->>'name'), 80); if i.name = '' then raise exception 'E_PAYLOAD_INVALID: name'; end if; end if;
  if p_patch ? 'allowed_domains' then
    select coalesce(array_agg(distinct lower(regexp_replace(regexp_replace(btrim(x), '^[a-z]+://', ''), '/.*$', ''))), '{}') into doms from jsonb_array_elements_text(p_patch->'allowed_domains') x where btrim(x) <> '';
    foreach d in array doms loop
      if d !~ '^(\*\.)?([a-z0-9-]+\.)*[a-z0-9-]+(:[0-9]+)?$' and d <> 'localhost' then raise exception 'E_PAYLOAD_INVALID: domain %', d; end if;
    end loop;
    i.allowed_domains := doms;
  end if;
  if p_patch ? 'client_id' then
    if p_patch->>'client_id' is not null and not outreach_client_visible(i.workspace_id, (p_patch->>'client_id')::uuid) then raise exception 'E_NOT_FOUND'; end if;
    i.client_id := (p_patch->>'client_id')::uuid;
    update outreach_senders set client_id = i.client_id where id = i.sender_id;
    update outreach_chats set client_id = i.client_id where webchat_inbox_id = i.id;
  end if;
  if p_patch ? 'is_active' then i.is_active := coalesce((p_patch->>'is_active')::boolean, i.is_active); end if;
  if p_patch ? 'ai_enabled' then i.ai_enabled := coalesce((p_patch->>'ai_enabled')::boolean, i.ai_enabled); end if;
  if p_patch ? 'enforce_identity' then i.enforce_identity := coalesce((p_patch->>'enforce_identity')::boolean, i.enforce_identity); end if;
  if p_patch ? 'reply_mailbox_id' then
    mb := (p_patch->>'reply_mailbox_id')::uuid;
    if mb is not null and not exists (select 1 from outreach_senders s where s.id = mb and s.workspace_id = i.workspace_id and s.provider in ('GMAIL','OUTLOOK','IMAP') and s.deleted_at is null) then raise exception 'E_PAYLOAD_INVALID: reply_mailbox_id'; end if;
    i.reply_mailbox_id := mb;
  end if;
  if p_patch ? 'business_hours' then
    if p_patch->'business_hours' ? 'tz' and (p_patch->'business_hours'->>'tz') <> '' and not exists (select 1 from pg_timezone_names where name = p_patch->'business_hours'->>'tz') then raise exception 'E_PAYLOAD_INVALID: timezone'; end if;
    i.business_hours := coalesce(p_patch->'business_hours', '{}'::jsonb);
  end if;
  if p_patch ? 'settings' then
    ns := outreach_webchat__merge(coalesce(i.settings, '{}'::jsonb), p_patch->'settings');
    accent := ns#>>'{appearance,accent}';
    if accent is not null and accent !~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' then raise exception 'E_PAYLOAD_INVALID: accent'; end if;
    if length(coalesce(ns#>>'{appearance,brand_name}', '')) > 40 then raise exception 'E_PAYLOAD_INVALID: brand_name'; end if;
    if length(coalesce(ns#>>'{appearance,custom_css}', '')) > 20000 then raise exception 'E_PAYLOAD_INVALID: custom_css'; end if;
    if length(ns::text) > 200000 then raise exception 'E_PAYLOAD_INVALID: settings too large'; end if;
    if ns#>>'{ai,mode}' is not null and ns#>>'{ai,mode}' not in ('off','first','offline_only') then raise exception 'E_PAYLOAD_INVALID: ai.mode'; end if;
    if ns#>>'{appearance,mode}' is not null and ns#>>'{appearance,mode}' not in ('bubble','drawer','sidebar','modal','inline','embedded') then raise exception 'E_PAYLOAD_INVALID: appearance.mode'; end if;
    i.settings := ns;
  end if;
  i.config_version := i.config_version + 1;
  update outreach_webchat_inboxes set name = i.name, allowed_domains = i.allowed_domains, client_id = i.client_id, is_active = i.is_active, ai_enabled = i.ai_enabled, enforce_identity = i.enforce_identity,
    reply_mailbox_id = i.reply_mailbox_id, business_hours = i.business_hours, settings = i.settings, config_version = i.config_version where id = i.id;
  update outreach_senders set display_name = i.name, status = (case when i.is_active then 'ok' else 'paused' end)::outreach_sender_status_t where id = i.sender_id;
  insert into outreach_webchat_settings_history(inbox_id, version, settings, business_hours, allowed_domains, changed_by, diff) values (i.id, i.config_version, i.settings, i.business_hours, i.allowed_domains, auth.uid(), p_patch);
  perform outreach_audit(i.workspace_id, 'webchat.inbox.updated', 'webchat_inbox', i.id::text, jsonb_build_object('keys', (select jsonb_agg(k) from jsonb_object_keys(p_patch) k)), 'user');
  select * into i from outreach_webchat_inboxes where id = p_id;
  return outreach_webchat__inbox_json(i);
end $$;

create or replace function outreach_webchat_inbox_set_members(p_id uuid, p_members jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_id and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_webchat_inbox_members where inbox_id = i.id and user_id not in (select (x->>'user_id')::uuid from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x);
  insert into outreach_webchat_inbox_members(inbox_id, user_id, auto_assign)
  select i.id, (x->>'user_id')::uuid, coalesce((x->>'auto_assign')::boolean, true) from jsonb_array_elements(coalesce(p_members, '[]'::jsonb)) x
   where exists (select 1 from outreach_members m where m.workspace_id = i.workspace_id and m.user_id = (x->>'user_id')::uuid and m.role <> 'client_viewer')
  on conflict (inbox_id, user_id) do update set auto_assign = excluded.auto_assign;
  return outreach_webchat__inbox_json(i);
end $$;

create or replace function outreach_webchat_inbox_regenerate_hmac(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_id and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  update outreach_webchat_inboxes set hmac_token = outreach_webchat__rand(24), config_version = config_version + 1 where id = i.id returning * into i;
  perform outreach_audit(i.workspace_id, 'webchat.inbox.hmac_regenerated', 'webchat_inbox', i.id::text, null, 'user');
  return outreach_webchat__inbox_json(i);
end $$;

create or replace function outreach_webchat_inbox_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_id and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'owner');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  -- history stays (chats, visitors); the widget stops answering (token no longer resolves) and the sender is disabled
  update outreach_webchat_inboxes set deleted_at = now(), is_active = false where id = i.id;
  update outreach_senders set status = 'disabled', deleted_at = now() where id = i.sender_id;
  perform outreach_audit(i.workspace_id, 'webchat.inbox.deleted', 'webchat_inbox', i.id::text, null, 'user');
end $$;

-- Contact panel (PRD §8): visitor + device + pages + events + conversations + linked lead summary.
create or replace function outreach_webchat_visitor(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype;
begin
  select * into v from outreach_webchat_visitors where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  perform outreach_require(v.workspace_id, 'client_viewer');
  if not outreach_client_visible(v.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return to_jsonb(v) - 'ip_hash' || jsonb_build_object(
    'inbox', jsonb_build_object('id', i.id, 'name', i.name),
    'blocked', v.blocked_at is not null or exists (select 1 from outreach_webchat_blocks b where b.inbox_id = i.id and b.kind = 'visitor' and b.value = v.id::text),
    'pages', (select coalesce(jsonb_agg(jsonb_build_object('url', p.url, 'title', p.title, 'at', p.at) order by p.at desc), '[]'::jsonb) from (select * from outreach_webchat_page_views p where p.visitor_id = v.id order by p.at desc limit 20) p),
    'events', (select coalesce(jsonb_agg(jsonb_build_object('name', e.name, 'props', e.props, 'at', e.at, 'chat_id', e.chat_id) order by e.at desc), '[]'::jsonb) from (select * from outreach_webchat_events e where e.visitor_id = v.id order by e.at desc limit 30) e),
    'conversations', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'created_at', c.created_at, 'last_message_at', c.last_message_at, 'preview', c.last_message_preview, 'csat', c.csat) order by c.created_at desc), '[]'::jsonb) from outreach_chats c where c.visitor_id = v.id),
    'conversation_count', (select count(*) from outreach_chats c where c.visitor_id = v.id),
    'lead', (select jsonb_build_object('id', l.id, 'full_name', l.full_name, 'company', l.company, 'title', l.title, 'email_work', l.email_work, 'last_replied_at', l.last_replied_at, 'last_replied_channel', l.last_replied_channel, 'picture_url', l.picture_url,
               'enrollments', (select coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'status', e.status, 'sequence', s.name, 'sender', sx.display_name, 'provider', sx.provider) order by e.created_at desc), '[]'::jsonb)
                                 from outreach_enrollments e join outreach_sequences s on s.id = e.sequence_id join outreach_senders sx on sx.id = e.sender_id where e.lead_id = l.id limit 10),
               'relations', (select coalesce(jsonb_agg(jsonb_build_object('sender', sx.display_name, 'provider', sx.provider, 'relation', ls.relation, 'last_inbound_at', ls.last_inbound_at, 'last_outbound_at', ls.last_outbound_at)), '[]'::jsonb)
                               from outreach_lead_sender_state ls join outreach_senders sx on sx.id = ls.sender_id where ls.lead_id = l.id and sx.provider <> 'WEBCHAT'))
              from outreach_leads l where l.id = v.lead_id),
    'lead_candidates', case when v.lead_id is null and v.email is not null then (select coalesce(jsonb_agg(jsonb_build_object('id', l.id, 'full_name', l.full_name, 'company', l.company, 'email_work', l.email_work)), '[]'::jsonb)
                              from outreach_leads l where l.workspace_id = v.workspace_id and (l.email_work = v.email or l.email_personal = v.email) and outreach_client_visible(v.workspace_id, l.client_id) limit 5) else '[]'::jsonb end);
end $$;

create or replace function outreach_webchat_visitor_update(p_id uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; em citext;
begin
  select * into v from outreach_webchat_visitors where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  perform outreach_require(v.workspace_id, 'member');
  if not outreach_client_visible(v.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_patch ? 'email' then em := nullif(lower(btrim(coalesce(p_patch->>'email', ''))), ''); if em is not null and em !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'E_PAYLOAD_INVALID: email'; end if; v.email := em; v.email_invalid := false; end if;
  if p_patch ? 'name' then v.name := nullif(left(btrim(p_patch->>'name'), 120), ''); end if;
  if p_patch ? 'phone' then v.phone := nullif(left(btrim(p_patch->>'phone'), 40), ''); end if;
  if p_patch ? 'company' then v.company := nullif(left(btrim(p_patch->>'company'), 120), ''); end if;
  if p_patch ? 'custom_attributes' then v.custom_attributes := coalesce(p_patch->'custom_attributes', '{}'::jsonb); end if;
  update outreach_webchat_visitors set email = v.email, name = v.name, phone = v.phone, company = v.company, custom_attributes = v.custom_attributes, email_invalid = v.email_invalid where id = v.id;
  update outreach_chats set attendee_name = coalesce(v.name, 'Visitor') where visitor_id = v.id;
  return outreach_webchat_visitor(v.id);
end $$;

-- Link to a lead (p_lead) or convert (p_lead null → create from the visitor's details).
create or replace function outreach_webchat_visitor_link_lead(p_id uuid, p_lead uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; lid uuid; r record;
begin
  select * into v from outreach_webchat_visitors where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  perform outreach_require(v.workspace_id, 'member');
  if not outreach_client_visible(v.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_lead is not null then
    select l.id into lid from outreach_leads l where l.id = p_lead and l.workspace_id = v.workspace_id and outreach_client_visible(v.workspace_id, l.client_id);
    if lid is null then raise exception 'E_NOT_FOUND'; end if;
  else
    if v.email is null and v.phone is null then raise exception 'E_PAYLOAD_INVALID: the visitor has no email or phone'; end if;
    for r in select * from outreach_upsert_lead(v.workspace_id, jsonb_strip_nulls(jsonb_build_object('email_work', v.email, 'full_name', v.name, 'phone', v.phone, 'company', v.company, 'client_id', i.client_id)), 'webchat', null) loop lid := r.id; end loop;
  end if;
  update outreach_webchat_visitors set lead_id = lid where id = v.id;
  update outreach_chats set lead_id = lid where visitor_id = v.id;
  perform outreach_audit(v.workspace_id, 'webchat.visitor.linked', 'webchat_visitor', v.id::text, jsonb_build_object('lead_id', lid), 'user');
  return outreach_webchat_visitor(v.id);
end $$;

create or replace function outreach_webchat_block(p_inbox uuid, p_kind text, p_value text, p_note text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'member');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_kind not in ('visitor','ip_hash','country') or nullif(btrim(coalesce(p_value, '')), '') is null then raise exception 'E_PAYLOAD_INVALID'; end if;
  insert into outreach_webchat_blocks(inbox_id, kind, value, note, created_by) values (i.id, p_kind, case when p_kind = 'country' then upper(btrim(p_value)) else btrim(p_value) end, left(p_note, 300), auth.uid()) on conflict do nothing;
  if p_kind = 'visitor' then update outreach_webchat_visitors set blocked_at = now(), token_version = token_version + 1 where id = p_value::uuid and inbox_id = i.id; end if;
  perform outreach_audit(i.workspace_id, 'webchat.block', 'webchat_inbox', i.id::text, jsonb_build_object('kind', p_kind, 'value', p_value), 'user');
end $$;

create or replace function outreach_webchat_unblock(p_inbox uuid, p_kind text, p_value text) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'member');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_webchat_blocks where inbox_id = i.id and kind = p_kind and value = case when p_kind = 'country' then upper(btrim(p_value)) else btrim(p_value) end;
  if p_kind = 'visitor' then update outreach_webchat_visitors set blocked_at = null where id = p_value::uuid and inbox_id = i.id; end if;
end $$;

-- Conversation actions (PRD §8): {status, snoozed_until, assigned_to, priority, labels, custom_attributes, mark_unread}
create or replace function outreach_webchat_conversation_update(p_chat uuid, p_patch jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st text; who text;
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT' for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  who := outreach_webchat__agent_name(auth.uid(), c.workspace_id);
  if p_patch ? 'assigned_to' then
    if p_patch->>'assigned_to' is not null and not exists (select 1 from outreach_members m where m.workspace_id = c.workspace_id and m.user_id = (p_patch->>'assigned_to')::uuid) then raise exception 'E_PAYLOAD_INVALID: assignee'; end if;
    if (p_patch->>'assigned_to')::uuid is distinct from c.assigned_to then
      c.assigned_to := (p_patch->>'assigned_to')::uuid;
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
      values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', case when c.assigned_to is null then 'unassigned' else 'assigned' end, 'agent', case when c.assigned_to is null then null else outreach_webchat__agent_name(c.assigned_to, c.workspace_id) end, 'by', who), 'system', 'system', 'inbox_user');
    end if;
  end if;
  if p_patch ? 'priority' then
    if p_patch->>'priority' is not null and p_patch->>'priority' not in ('urgent','high','medium','low') then raise exception 'E_PAYLOAD_INVALID: priority'; end if;
    c.priority := p_patch->>'priority';
  end if;
  if p_patch ? 'labels' then c.labels := (select coalesce(array_agg(distinct left(btrim(x), 40)), '{}') from jsonb_array_elements_text(p_patch->'labels') x where btrim(x) <> '')[1:50]; end if;
  if p_patch ? 'custom_attributes' then c.custom_attributes := coalesce(p_patch->'custom_attributes', '{}'::jsonb); end if;
  if p_patch ? 'status' then
    st := p_patch->>'status';
    if st not in ('open','pending','snoozed','resolved') then raise exception 'E_PAYLOAD_INVALID: status'; end if;
    if st = 'snoozed' then c.snoozed_until := nullif(p_patch->>'snoozed_until', '')::timestamptz; else c.snoozed_until := null; end if;
    if st <> c.status then
      if st = 'resolved' then
        c.resolved_at := now(); c.resolved_by := 'agent';
        insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
        values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', 'resolved', 'by', who), 'system', 'system', 'inbox_user');
      elsif c.status = 'resolved' then
        c.resolved_at := null; c.resolved_by := null;
        insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
        values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', 'reopened', 'by', who), 'system', 'system', 'inbox_user');
      end if;
      c.status := st;
    end if;
  end if;
  update outreach_chats set assigned_to = c.assigned_to, priority = c.priority, labels = c.labels, custom_attributes = c.custom_attributes, status = c.status, snoozed_until = c.snoozed_until,
    resolved_at = c.resolved_at, resolved_by = c.resolved_by, unread = case when coalesce((p_patch->>'mark_unread')::boolean, false) then true when c.status = 'resolved' then false else unread end,
    archived = case when c.status = 'resolved' then true else false end
   where id = c.id;
  if p_patch ? 'status' and c.status = 'resolved' then
    perform outreach_webchat__post_csat(c.id);
    perform outreach_emit_event(c.workspace_id, 'webchat.conversation.resolved', jsonb_build_object('id', c.id, 'inbox_id', c.webchat_inbox_id, 'by', auth.uid()));
  end if;
  select * into c from outreach_chats where id = c.id;
  return to_jsonb(c);
end $$;

-- Agent reply (text, quick replies, cards, forms). Attachments: paths already uploaded to outreach-attachments (<ws>/<chat>/...).
-- p_actor: only honoured for the service role (outreach-send-reply / the public API / MCP act for a member it already authenticated).
drop function if exists outreach_webchat_agent_send(uuid, text, text, jsonb, jsonb);
create or replace function outreach_webchat_agent_send(p_chat uuid, p_text text, p_content_type text default 'text', p_attrs jsonb default '{}', p_attachments jsonb default '[]', p_actor uuid default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; m outreach_messages%rowtype; who text; can boolean; ctype text := coalesce(p_content_type, 'text'); a jsonb; sc text; cr text; actor uuid;
begin
  actor := case when outreach_is_service() and p_actor is not null then p_actor else auth.uid() end;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT' for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  select can_reply into can from outreach_members where workspace_id = c.workspace_id and user_id = actor;
  if not coalesce(can, false) then raise exception 'E_FORBIDDEN: replies are off for your account'; end if;
  if ctype not in ('text','attachment','cards','quick_replies','form') then raise exception 'E_PAYLOAD_INVALID: content_type'; end if;
  if not outreach_rate_limit('webchat:agent:' || actor::text, 120, 60) then raise exception 'E_RATE_LIMITED'; end if;
  -- canned response expansion: "/shortcut" alone, or a leading "/shortcut " (variables {{contact.name}} {{agent.name}})
  who := outreach_webchat__agent_name(actor, c.workspace_id);
  sc := (regexp_match(coalesce(p_text, ''), '^/([A-Za-z0-9_-]+)\s*'))[1];
  if sc is not null then
    select content into cr from outreach_webchat_canned_responses r where r.workspace_id = c.workspace_id and lower(r.short_code) = lower(sc) and (r.owner_id is null or r.owner_id = actor) order by r.owner_id nulls last limit 1;
    if cr is not null then p_text := cr || coalesce(' ' || nullif(btrim(regexp_replace(p_text, '^/[A-Za-z0-9_-]+\s*', '')), ''), ''); end if;
  end if;
  p_text := replace(replace(replace(coalesce(p_text, ''), '{{contact.name}}', coalesce(c.attendee_name, 'there')), '{{agent.name}}', who), '{{contact.first_name}}', split_part(coalesce(c.attendee_name, 'there'), ' ', 1));
  p_text := left(p_text, 20000);
  if ctype = 'text' and btrim(p_text) = '' and jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) = 0 then raise exception 'E_PAYLOAD_INVALID: text'; end if;
  if jsonb_array_length(coalesce(p_attachments, '[]'::jsonb)) > 0 then
    ctype := 'attachment';
    for a in select * from jsonb_array_elements(p_attachments) loop
      if a->>'id' is null or a->>'id' not like c.workspace_id::text || '/' || c.id::text || '/%' then raise exception 'E_PAYLOAD_INVALID: attachment path'; end if;
    end loop;
  end if;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, attachments, sender_type, sender_name, sent_by, source, origin)
  values (c.workspace_id, c.id, 'out', nullif(p_text, ''), now(), ctype, coalesce(p_attrs, '{}'::jsonb), coalesce(p_attachments, '[]'::jsonb), 'agent', who, actor, 'agent', 'inbox_user')
  returning * into m;
  update outreach_chats set unread = false, unread_count = 0, archived = false, agent_typing_at = null,
    status = case when status in ('resolved','snoozed') then 'open' else status end, resolved_at = case when status = 'resolved' then null else resolved_at end,
    assigned_to = coalesce(assigned_to, actor) where id = c.id;
  update outreach_messages set read_by_agent_at = coalesce(read_by_agent_at, now()) where chat_id = c.id and direction = 'in' and read_by_agent_at is null;
  perform outreach_emit_event(c.workspace_id, 'message.sent', jsonb_build_object('id', m.id, 'chat_id', c.id, 'lead_id', c.lead_id, 'sender_id', c.sender_id, 'by', actor, 'reply', true, 'channel', 'webchat'));
  return to_jsonb(m);
end $$;

create or replace function outreach_webchat_agent_typing(p_chat uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public, extensions, realtime as $$
declare c outreach_chats%rowtype; topic text;
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  update outreach_chats set agent_typing_at = case when p_on then now() else null end, agent_typing_by = case when p_on then auth.uid() else null end where id = c.id;
  topic := outreach_webchat__topic(c.id);
  if topic is not null then
    begin perform realtime.send(jsonb_build_object('typing', p_on, 'agent', outreach_webchat__agent_name(auth.uid(), c.workspace_id)), 'typing', topic, false); exception when others then null; end;
  end if;
end $$;

create or replace function outreach_webchat_agent_read(p_chat uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'client_viewer');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  update outreach_messages set read_by_agent_at = now() where chat_id = c.id and direction = 'in' and read_by_agent_at is null;
  update outreach_chats set unread = false, unread_count = 0 where id = c.id;
end $$;

-- "Let AI continue" / "Stop the AI" for a webchat conversation.
create or replace function outreach_webchat_agent_ai(p_chat uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype;
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(c.workspace_id, 'member');
  if not outreach_client_visible(c.workspace_id, c.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if p_on then update outreach_chats set handed_off_at = null, handoff_reason = null, ai_handled = true, ai_mode = coalesce(nullif(ai_mode, 'off'), 'first') where id = c.id;
  else update outreach_chats set handed_off_at = coalesce(handed_off_at, now()), handoff_reason = coalesce(handoff_reason, 'manual'), ai_handled = false where id = c.id; end if;
  insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
  values (c.workspace_id, c.id, 'out', null, now(), 'event', jsonb_build_object('kind', case when p_on then 'ai_resumed' else 'ai_stopped' end, 'by', outreach_webchat__agent_name(auth.uid(), c.workspace_id)), 'system', 'system', 'inbox_user');
  select * into c from outreach_chats where id = c.id;
  return jsonb_build_object('ai_handled', c.ai_handled, 'handed_off_at', c.handed_off_at);
end $$;

-- Canned responses
create or replace function outreach_webchat_canned_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(to_jsonb(r) order by r.short_code), '[]'::jsonb) from outreach_webchat_canned_responses r where r.workspace_id = p_ws and (r.owner_id is null or r.owner_id = auth.uid()));
end $$;

create or replace function outreach_webchat_canned_save(p_ws uuid, p_id uuid, p_short_code text, p_content text, p_personal boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_webchat_canned_responses%rowtype; sc text;
begin
  perform outreach_require(p_ws, 'member');
  sc := lower(regexp_replace(btrim(coalesce(p_short_code, '')), '^/', ''));
  if sc !~ '^[a-z0-9_-]{1,40}$' then raise exception 'E_PAYLOAD_INVALID: short_code'; end if;
  if nullif(btrim(coalesce(p_content, '')), '') is null or length(p_content) > 5000 then raise exception 'E_PAYLOAD_INVALID: content'; end if;
  if p_id is null then
    insert into outreach_webchat_canned_responses(workspace_id, owner_id, short_code, content, created_by) values (p_ws, case when p_personal then auth.uid() end, sc, p_content, auth.uid())
    on conflict (workspace_id, coalesce(owner_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(short_code)) do update set content = excluded.content returning * into r;
  else
    update outreach_webchat_canned_responses set short_code = sc, content = p_content, owner_id = case when p_personal then auth.uid() end where id = p_id and workspace_id = p_ws and (owner_id is null or owner_id = auth.uid()) returning * into r;
    if not found then raise exception 'E_NOT_FOUND'; end if;
  end if;
  return to_jsonb(r);
end $$;

create or replace function outreach_webchat_canned_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_webchat_canned_responses%rowtype;
begin
  select * into r from outreach_webchat_canned_responses where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'member');
  if r.owner_id is not null and r.owner_id <> auth.uid() then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_webchat_canned_responses where id = p_id;
end $$;

-- Campaigns (PRD §5.11)
create or replace function outreach_webchat_campaign_save(p_inbox uuid, p_id uuid, p_row jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; r outreach_webchat_campaigns%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if nullif(btrim(coalesce(p_row->>'title', '')), '') is null or nullif(btrim(coalesce(p_row->>'message', '')), '') is null then raise exception 'E_PAYLOAD_INVALID'; end if;
  if p_id is null then
    insert into outreach_webchat_campaigns(inbox_id, title, message, sender_kind, sender_user_id, quick_replies, rules, frequency, display, enabled)
    values (i.id, left(p_row->>'title', 120), left(p_row->>'message', 1000), coalesce(p_row->>'sender_kind', 'bot'), (p_row->>'sender_user_id')::uuid,
            (select coalesce(array_agg(left(x, 60)), '{}') from jsonb_array_elements_text(coalesce(p_row->'quick_replies', '[]'::jsonb)) x), coalesce(p_row->'rules', '{}'::jsonb),
            coalesce(p_row->>'frequency', 'once'), coalesce(p_row->>'display', 'popup'), coalesce((p_row->>'enabled')::boolean, true)) returning * into r;
  else
    update outreach_webchat_campaigns set title = left(p_row->>'title', 120), message = left(p_row->>'message', 1000), sender_kind = coalesce(p_row->>'sender_kind', sender_kind), sender_user_id = (p_row->>'sender_user_id')::uuid,
      quick_replies = (select coalesce(array_agg(left(x, 60)), '{}') from jsonb_array_elements_text(coalesce(p_row->'quick_replies', '[]'::jsonb)) x), rules = coalesce(p_row->'rules', rules),
      frequency = coalesce(p_row->>'frequency', frequency), display = coalesce(p_row->>'display', display), enabled = coalesce((p_row->>'enabled')::boolean, enabled)
     where id = p_id and inbox_id = i.id returning * into r;
    if not found then raise exception 'E_NOT_FOUND'; end if;
  end if;
  update outreach_webchat_inboxes set config_version = config_version + 1 where id = i.id;
  return to_jsonb(r);
end $$;

create or replace function outreach_webchat_campaign_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select i.* into i from outreach_webchat_campaigns c join outreach_webchat_inboxes i on i.id = c.inbox_id where c.id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_webchat_campaigns where id = p_id;
  update outreach_webchat_inboxes set config_version = config_version + 1 where id = i.id;
end $$;

-- Presence ping from the app (every minute while a tab is open; state online|busy|offline).
create or replace function outreach_webchat_presence(p_ws uuid, p_state text default 'online') returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_state not in ('online','busy','offline') then raise exception 'E_PAYLOAD_INVALID'; end if;
  insert into outreach_webchat_agent_presence(workspace_id, user_id, state, last_seen_at) values (p_ws, auth.uid(), p_state, now())
  on conflict (workspace_id, user_id) do update set state = excluded.state, last_seen_at = now();
  return jsonb_build_object('state', p_state, 'at', now());
end $$;

-- Report (PRD §18) per inbox or workspace-wide, inclusive dates.
create or replace function outreach_webchat_report(p_ws uuid, p_inbox uuid, p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f timestamptz := p_from::timestamptz; t timestamptz := (p_to + 1)::timestamptz;
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (
    with ch as (
      select c.* from outreach_chats c join outreach_webchat_inboxes i on i.id = c.webchat_inbox_id
       where c.workspace_id = p_ws and c.provider = 'WEBCHAT' and (p_inbox is null or c.webchat_inbox_id = p_inbox) and outreach_client_visible(p_ws, i.client_id) and c.created_at >= f and c.created_at < t)
    select jsonb_build_object(
      'period', jsonb_build_object('from', p_from, 'to', p_to),
      'conversations', (select count(*) from ch),
      'by_source', (select coalesce(jsonb_object_agg(coalesce(source, 'launcher'), n), '{}'::jsonb) from (select source, count(*) n from ch group by source) x),
      'resolved', (select count(*) from ch where status = 'resolved'),
      'ai_resolved', (select count(*) from ch c where c.status = 'resolved' and c.ai_handled and not exists (select 1 from outreach_messages m where m.chat_id = c.id and m.sender_type = 'agent')),
      'handoffs', (select count(*) from ch where handed_off_at is not null),
      'ai_turns', (select count(*) from outreach_webchat_ai_turns x where x.workspace_id = p_ws and (p_inbox is null or x.inbox_id = p_inbox) and x.created_at >= f and x.created_at < t),
      'ai_feedback', (select jsonb_build_object('up', count(*) filter (where feedback = 1), 'down', count(*) filter (where feedback = -1)) from outreach_webchat_ai_turns x where x.workspace_id = p_ws and (p_inbox is null or x.inbox_id = p_inbox) and x.created_at >= f and x.created_at < t),
      'first_response_median_s', (select percentile_cont(0.5) within group (order by extract(epoch from (first_response_at - created_at))) from ch where first_response_at is not null),
      'first_response_p90_s', (select percentile_cont(0.9) within group (order by extract(epoch from (first_response_at - created_at))) from ch where first_response_at is not null),
      'resolution_median_s', (select percentile_cont(0.5) within group (order by extract(epoch from (resolved_at - created_at))) from ch where resolved_at is not null),
      'csat', (select jsonb_build_object('responses', count(*), 'avg', round(avg((csat->>'rating')::numeric), 2)) from ch where csat is not null),
      'csat_by_agent', (select coalesce(jsonb_agg(jsonb_build_object('user_id', g.assigned_to, 'name', outreach_webchat__agent_name(g.assigned_to, p_ws), 'avg', g.a, 'n', g.n)), '[]'::jsonb)
                          from (select assigned_to, round(avg((csat->>'rating')::numeric), 2) a, count(*) n from ch where csat is not null and assigned_to is not null group by assigned_to) g),
      'visitor_to_lead', (select count(*) from ch where lead_id is not null),
      'sequences_stopped', (select count(distinct e.id) from ch c join outreach_enrollments e on e.lead_id = c.lead_id and e.status = 'exited_replied' and e.exited_by_message_at >= f and e.exited_by_message_at < t),
      'continuity', (select jsonb_build_object('sent', count(*) filter (where error is null), 'failed', count(*) filter (where error is not null)) from outreach_webchat_continuity_emails e join ch on ch.id = e.chat_id where e.sent_at >= f and e.sent_at < t),
      'top_unanswered', (select coalesce(jsonb_agg(jsonb_build_object('query', q, 'n', n) order by n desc), '[]'::jsonb) from (select left(query, 120) q, count(*) n from outreach_webchat_ai_turns x where x.workspace_id = p_ws and (p_inbox is null or x.inbox_id = p_inbox) and x.created_at >= f and x.created_at < t and x.confidence in ('low','refused') group by 1 order by 2 desc limit 20) y),
      'by_day', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]'::jsonb) from (select created_at::date d, count(*) n from ch group by 1) z)));
end $$;

create or replace function outreach_webchat_ai_turns_list(p_inbox uuid, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'client_viewer');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return (select coalesce(jsonb_agg(to_jsonb(t) order by t.created_at desc), '[]'::jsonb) from (select * from outreach_webchat_ai_turns t where t.inbox_id = p_inbox order by t.created_at desc limit greatest(1, least(coalesce(p_limit, 50), 500))) t);
end $$;

create or replace function outreach_webchat_settings_history(p_inbox uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'manager');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('version', h.version, 'at', h.at, 'changed_by', h.changed_by, 'by', outreach_webchat__agent_name(h.changed_by, i.workspace_id), 'diff', h.diff) order by h.version desc), '[]'::jsonb) from (select * from outreach_webchat_settings_history h where h.inbox_id = p_inbox order by version desc limit 50) h);
end $$;

-- Restore a settings version (PRD §12 versioned settings).
create or replace function outreach_webchat_settings_restore(p_inbox uuid, p_version int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare h outreach_webchat_settings_history%rowtype;
begin
  select * into h from outreach_webchat_settings_history where inbox_id = p_inbox and version = p_version;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  return outreach_webchat_inbox_update(p_inbox, jsonb_build_object('settings', h.settings, 'business_hours', coalesce(h.business_hours, '{}'::jsonb), 'allowed_domains', to_jsonb(coalesce(h.allowed_domains, '{}'::text[])), 'restored_from', p_version));
end $$;

-- Visitor data export / deletion (PRD §7 privacy)
create or replace function outreach_webchat_visitor_export(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype;
begin
  select * into v from outreach_webchat_visitors where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  perform outreach_require(v.workspace_id, 'manager');
  if not outreach_client_visible(v.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  return jsonb_build_object('visitor', to_jsonb(v) - 'ip_hash',
    'page_views', (select coalesce(jsonb_agg(to_jsonb(p) order by p.at), '[]'::jsonb) from outreach_webchat_page_views p where p.visitor_id = v.id),
    'events', (select coalesce(jsonb_agg(to_jsonb(e) order by e.at), '[]'::jsonb) from outreach_webchat_events e where e.visitor_id = v.id),
    'conversations', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'status', c.status, 'created_at', c.created_at, 'csat', c.csat,
        'messages', (select coalesce(jsonb_agg(jsonb_build_object('sender_type', m.sender_type, 'sender_name', m.sender_name, 'text', m.text, 'sent_at', m.sent_at, 'content_type', m.content_type) order by m.sent_at), '[]'::jsonb) from outreach_messages m where m.chat_id = c.id and m.deleted_at is null))), '[]'::jsonb)
        from outreach_chats c where c.visitor_id = v.id));
end $$;

create or replace function outreach_webchat_visitor_delete(p_id uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype;
begin
  select * into v from outreach_webchat_visitors where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into i from outreach_webchat_inboxes where id = v.inbox_id;
  perform outreach_require(v.workspace_id, 'manager');
  if not outreach_client_visible(v.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  delete from outreach_chats where visitor_id = v.id;
  delete from outreach_webchat_visitors where id = v.id or merged_into = v.id;
  perform outreach_audit(v.workspace_id, 'webchat.visitor.deleted', 'webchat_visitor', v.id::text, null, 'user');
end $$;

-- Mail senders a manager may pick as the continuity reply mailbox.
create or replace function outreach_webchat_mailboxes(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'name', s.display_name, 'email', s.owner_email, 'provider', s.provider, 'status', s.status, 'client_id', s.client_id) order by s.display_name), '[]'::jsonb)
            from outreach_senders s where s.workspace_id = p_ws and s.provider in ('GMAIL','OUTLOOK','IMAP') and s.deleted_at is null and outreach_client_visible(p_ws, s.client_id));
end $$;

-- ===============================================================================================================
-- Grants: user RPCs to authenticated; everything else service only.
-- ===============================================================================================================
do $$
declare r record; app_fns text[] := array[
  'outreach_webchat_inbox_create','outreach_webchat_inboxes','outreach_webchat_inbox_get','outreach_webchat_inbox_update','outreach_webchat_inbox_set_members',
  'outreach_webchat_inbox_regenerate_hmac','outreach_webchat_inbox_delete','outreach_webchat_visitor','outreach_webchat_visitor_update','outreach_webchat_visitor_link_lead',
  'outreach_webchat_block','outreach_webchat_unblock','outreach_webchat_conversation_update','outreach_webchat_agent_send','outreach_webchat_agent_typing','outreach_webchat_agent_read',
  'outreach_webchat_agent_ai','outreach_webchat_canned_list','outreach_webchat_canned_save','outreach_webchat_canned_delete','outreach_webchat_campaign_save','outreach_webchat_campaign_delete',
  'outreach_webchat_presence','outreach_webchat_report','outreach_webchat_ai_turns_list','outreach_webchat_settings_history','outreach_webchat_settings_restore',
  'outreach_webchat_visitor_export','outreach_webchat_visitor_delete','outreach_webchat_mailboxes','outreach_webchat_default_settings'];
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'outreach\_webchat%' loop
    execute format('revoke all on function %s from public, anon', r.oid::regprocedure);
    if r.proname = any(app_fns) then execute format('grant execute on function %s to authenticated, service_role', r.oid::regprocedure);
    else execute format('revoke all on function %s from authenticated', r.oid::regprocedure); execute format('grant execute on function %s to service_role', r.oid::regprocedure); end if;
  end loop;
end $$;
