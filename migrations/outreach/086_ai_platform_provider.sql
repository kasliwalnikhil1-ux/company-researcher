-- 086 — The platform AI provider is a setting, not a constant.
--
-- Why: until now every workspace without its own key went to the platform Gemini key, hard-wired in llm.ts. The
-- platform now holds one key per provider (GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY) and the default is
-- chosen from Settings → Admin → AI provider (localhost only, written by outreach-unipile-setup `set_ai`):
--   ai_platform_provider  "gemini" | "anthropic" | "openai" | null   null = OUTREACH_AI_PROVIDER, else the first provider with a key
--   ai_platform_models    {"anthropic": "claude-opus-5-5", ...}      per-provider model overrides (empty = the env default)
-- A provider named here without a platform key is skipped with a warning in the function logs; nothing goes dark.
-- Seeded to Anthropic (the Claude key added on 2026-10-23). Every function instance re-reads the flags every 60 s.

insert into outreach_flags(key, value) values
  ('ai_platform_provider', '"anthropic"'::jsonb),
  ('ai_platform_models', '{}'::jsonb)
on conflict (key) do nothing;

-- The AI → Setup screen says which provider the platform default is (only the flag is visible from SQL; the admin card
-- shows the effective choice from the edge function).
create or replace function outreach_workspace_ai_settings(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare r outreach_workspace_secrets%rowtype;
begin
  perform outreach_require(p_ws, 'manager');
  select * into r from outreach_workspace_secrets where workspace_id = p_ws;
  return jsonb_build_object('llm_provider', coalesce(r.llm_provider, 'platform'), 'llm_model', r.llm_model, 'llm_key_hint', r.llm_key_hint, 'uses_own_key', r.llm_key_enc is not null,
    'platform_provider', coalesce((select f.value #>> '{}' from outreach_flags f where f.key = 'ai_platform_provider'), 'gemini'),
    'elevenlabs_key_hint', (select x.elevenlabs_key_hint from outreach_workspace_secrets x where x.workspace_id = p_ws and x.elevenlabs_key_enc is not null),
    'voice_own_key_allowed', coalesce((outreach__voice_limits(p_ws)->>'own_key')::boolean, false),
    'finders', (select coalesce(jsonb_agg(jsonb_build_object('provider', x->>'provider', 'hint', x->>'hint')), '[]'::jsonb) from jsonb_array_elements(coalesce(r.finder_keys,'[]'::jsonb)) x),
    'verifier', case when r.verifier is not null then jsonb_build_object('provider', r.verifier->>'provider', 'hint', r.verifier->>'hint') end,
    'booking_webhook_secret', case when outreach_role_in(p_ws) = 'owner' or outreach_is_service() then r.booking_secret end);
end $$;
