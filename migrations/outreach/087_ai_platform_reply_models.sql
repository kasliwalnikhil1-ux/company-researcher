-- 087 — The model that writes replies to prospects is chosen apart from the everyday model.
--
-- Why: classification, Personalized lines, sequence QA and the website assistant run many times a day and are fine on a
-- fast model (the platform default is now Sonnet 5.5); a reply that a prospect will read is rarer and worth the strongest
-- model. llm.ts gives calls with tier "reply" (the inbox reply draft, the auto-reply engine's draft) the provider's reply
-- model: the flag below ({provider: model}), else OUTREACH_<PROVIDER>_REPLY_MODEL, else claude-opus-5-5 for Anthropic and
-- the everyday model for Gemini / OpenAI. Settings → Admin → AI provider has a second model field per provider for it.

insert into outreach_flags(key, value) values ('ai_platform_reply_models', '{}'::jsonb)
on conflict (key) do nothing;
