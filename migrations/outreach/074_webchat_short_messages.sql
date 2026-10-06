-- 074_webchat_short_messages.sql — shorter Messages-tab defaults for the website agent, without em dashes (6 Oct 2026).
-- Requires 053. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/074_webchat_short_messages.sql
--
--   greeting                 "Hi! How can we help you today?"                    -> "Hi! How can we help?"
--   unavailable_message      "We're away right now. Leave a message and ..."     -> "We're away. Leave a message."
--   email_capture_prompt     "We'll reply here and by email — what's your email?" -> "What's your email so we can reply?"
--   end_message              "Thanks for chatting with us!"                      -> "Thanks for chatting!"
--   handoff_message          "Connecting you with a person — one moment."        -> "Connecting you to a person…"
--   handoff_offline_message  "Our team is offline right now. Leave your ..."     -> "We're offline. Leave your email and we'll reply."
--
-- outreach_webchat_default_settings() is patched in place (069 patched it too, so it is not redefined from a copy here).
-- Inboxes that saved the Messages tab carry stored copies of the old defaults: those keys are dropped so the new
-- defaults apply. Text somebody wrote themselves is left alone.

do $mig$
declare def text; pairs text[] := array[
  '"greeting": "Hi! How can we help you today?"', '"greeting": "Hi! How can we help?"',
  '"unavailable_message": "We''re away right now. Leave a message and we''ll get back to you."', '"unavailable_message": "We''re away. Leave a message."',
  '"email_capture_prompt": "We''ll reply here and by email — what''s your email?"', '"email_capture_prompt": "What''s your email so we can reply?"',
  '"end_message": "Thanks for chatting with us!"', '"end_message": "Thanks for chatting!"',
  '"handoff_message": "Connecting you with a person — one moment."', '"handoff_message": "Connecting you to a person…"',
  '"handoff_offline_message": "Our team is offline right now. Leave your email and we''ll reply as soon as we''re back."', '"handoff_offline_message": "We''re offline. Leave your email and we''ll reply."'
]; i int := 1;
begin
  def := replace(pg_get_functiondef('public.outreach_webchat_default_settings()'::regprocedure), chr(13), '');
  if position('"end_message": "Thanks for chatting!"' in def) > 0 then return; end if;   -- already applied
  while i < array_length(pairs, 1) loop
    if position(pairs[i] in def) = 0 then raise exception '074: anchor not found: %', pairs[i]; end if;
    def := replace(def, pairs[i], pairs[i + 1]);
    i := i + 2;
  end loop;
  execute def;
end $mig$;

update outreach_webchat_inboxes set settings = settings
    #- (case when settings#>>'{messages,greeting}' = 'Hi! How can we help you today?' then '{messages,greeting}' else '{messages,_none}' end)::text[]
    #- (case when settings#>>'{messages,unavailable_message}' in ('We''re away right now. Leave a message and we''ll get back to you.', 'We''re away right now. Leave a message and we''ll get back to you within a business day.') then '{messages,unavailable_message}' else '{messages,_none}' end)::text[]
    #- (case when settings#>>'{messages,email_capture_prompt}' = 'We''ll reply here and by email — what''s your email?' then '{messages,email_capture_prompt}' else '{messages,_none}' end)::text[]
    #- (case when settings#>>'{messages,end_message}' = 'Thanks for chatting with us!' then '{messages,end_message}' else '{messages,_none}' end)::text[]
    #- (case when settings#>>'{messages,handoff_message}' = 'Connecting you with a person — one moment.' then '{messages,handoff_message}' else '{messages,_none}' end)::text[]
    #- (case when settings#>>'{messages,handoff_offline_message}' = 'Our team is offline right now. Leave your email and we''ll reply as soon as we''re back.' then '{messages,handoff_offline_message}' else '{messages,_none}' end)::text[]
 where settings ? 'messages';
