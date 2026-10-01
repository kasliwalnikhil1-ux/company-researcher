-- 053_webchat_video_bubble.sql — Widget update of 1 Oct 2026 ("Chatbot update", fixes 1, 2 and 5; 3 and 4 are widget-only).
-- Requires 049 + 051. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/053_webchat_video_bubble.sql
--
--   1. Composer placeholder default is "Ask a question…". Inboxes that had stored the old default get the new one.
--   2. messages.privacy_url: the link behind "By chatting with us, you agree to our Privacy Policy" (null = platform policy).
--   5. launcher.video: a GIF / video bubble instead of the launcher icon, expanding into suggested questions + "Chat with us".
--      Defaults, validation on save, and the public bucket the uploaded clips live in. It sits under `launcher`, which
--      outreach_webchat_public_config already hands to the widget whole, so the public projection is unchanged.
--
-- outreach_webchat_default_settings() and outreach_webchat_inbox_update() are redefined here (051 holds the older copies;
-- this file runs after it, so these win). The only change to inbox_update is the outreach_webchat__settings_check() call.

-- ===============================================================================================================
-- Defaults
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
      "show_unread_count": true, "show_unread_previews": true, "hide": false, "online_dot": true,
      "video": {
        "enabled": true, "url": null, "kind": "video", "shape": "circle", "size": 120, "ratio": "1:1", "fit": "cover",
        "focus_x": 50, "focus_y": 50, "zoom": 100, "border_color": "#ffffff", "border_width": 3,
        "expanded_width": 420, "expanded_ratio": "auto", "sound": true,
        "questions": [], "questions_position": "over", "cta_text": "Chat with us",
        "question_bg": "#111827", "question_color": "#ffffff", "cta_bg": null, "cta_color": "#ffffff"
      }
    },
    "popup": { "enabled": false, "text": "👋 Have a question? We're here to help.", "image_url": null, "delay_s": 3, "position": "above" },
    "messages": {
      "greeting_enabled": true, "greeting": "Hi! How can we help you today?",
      "reply_time": "minutes", "available_message": "We're online", "unavailable_message": "We're away right now. Leave a message and we'll get back to you.",
      "email_capture_prompt": "We'll reply here and by email — what's your email?",
      "end_message": "Thanks for chatting with us!", "placeholder": "Ask a question…", "privacy_url": null,
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

-- ===============================================================================================================
-- Validation of the parts of the settings the widget puts into markup or CSS (colours, URLs, enums, list sizes).
-- Sizes and percentages are not checked here: the widget clamps them (video.js num()).
-- ===============================================================================================================
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
      if jsonb_typeof(q) <> 'string' or length(q#>>'{}') > 120 then raise exception 'E_PAYLOAD_INVALID: launcher.video.questions (text, 120 characters at most)'; end if;
    end loop;
  end if;
end $$;
revoke all on function outreach_webchat__settings_check(jsonb) from public, anon, authenticated;
grant execute on function outreach_webchat__settings_check(jsonb) to service_role;

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
    perform outreach_webchat__settings_check(ns);
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

-- ===============================================================================================================
-- Bucket for launcher clips. Public: the widget plays them on customer sites, for visitors with no session.
-- Path <workspace_id>/<inbox_id>/<file>; owners and managers write, members list. 20 MB, video / animated image only.
-- ===============================================================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('outreach-webchat-media', 'outreach-webchat-media', true, 20971520, array['video/mp4','video/webm','image/gif','image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists outreach_webchat_media_upload on storage.objects;
create policy outreach_webchat_media_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-webchat-media'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids()))
    and outreach_role_in(((storage.foldername(name))[1])::uuid) in ('owner','manager'));
drop policy if exists outreach_webchat_media_read on storage.objects;
create policy outreach_webchat_media_read on storage.objects for select to authenticated
  using (bucket_id = 'outreach-webchat-media'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));
drop policy if exists outreach_webchat_media_delete on storage.objects;
create policy outreach_webchat_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'outreach-webchat-media'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids()))
    and outreach_role_in(((storage.foldername(name))[1])::uuid) in ('owner','manager'));

-- ===============================================================================================================
-- Inboxes that saved the Messages tab carry a stored copy of the old default placeholder: drop it so the new default
-- applies. A placeholder somebody wrote themselves is left alone.
-- ===============================================================================================================
update outreach_webchat_inboxes set settings = settings #- '{messages,placeholder}'
 where settings#>>'{messages,placeholder}' in ('Type a message…', 'Type a message...');
