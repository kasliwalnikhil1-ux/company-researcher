-- 069_webchat_voice.sql — Web chat: voice for the website assistant (web-chat-voice-elevenlabs-PRD.md; as built:
-- docs/outreach/WEBCHAT.md "Voice"). Requires 001–068. Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/069_webchat_voice.sql   (cron: 070, after the functions are deployed)
--
--   1. Schema      one voice agent per website and kind (live | test), one row per call, a clean-up queue for what has to
--                  be deleted at the voice provider, minute grants (voice packs), the workspace's own voice key.
--   2. Settings    settings.voice: defaults, validation on save, the public projection the widget reads.
--   3. Limits      plan features (minutes, call length, calls at the same time, own key) and the minutes pool.
--   4. Calls       outreach_webchat_v_voice_* (service only): start, live turns, switch to chat, end, the tools the voice
--                  agent calls, and finalize (the signed transcript replaces the live copy in one transaction).
--   5. Agent sync  what the edge functions need to create / update the provider's agents, and where they store the ids.
--   6. App RPCs    outreach_hub_voice_* (the 037 / 042 / 051 grant loops take `authenticated` off every outreach_webchat*
--                  function that is not in their lists; see the grant-loop gotcha).
--   7. Patches     existing functions changed in place (pg_get_functiondef + replace, like 063 / 068). Every anchor is
--                  asserted: a missing anchor stops the migration with the function's name and nothing is changed.

-- ===============================================================================================================
-- 0. In-place patch helper (dropped at the end of this file)
-- ===============================================================================================================
-- p_pairs = [old1, new1, old2, new2, ...]. Returns false when the function already carries p_marker.
create or replace function outreach_wv__patch(p_fn text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  -- bodies applied from a CRLF checkout carry \r: strip it so the anchors match
  def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    -- the same for this file: an anchor that spans a line break must match whatever the checkout's line endings are
    if position(replace(p_pairs[i], chr(13), '') in def) = 0 then raise exception '069: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, replace(p_pairs[i], chr(13), ''), replace(p_pairs[i + 1], chr(13), ''));
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '069: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_wv__patch(text, text, text[]) from public, anon, authenticated;

-- ===============================================================================================================
-- 1. Schema
-- ===============================================================================================================
-- The workspace's own voice account (Settings → AI → Keys). Encrypted by the edge function, never returned.
alter table outreach_workspace_secrets
  add column if not exists elevenlabs_key_enc  text,
  add column if not exists elevenlabs_key_hint text,
  add column if not exists elevenlabs_webhook_secret_enc text,   -- the post-call webhook we created in that account (null: calls are fetched by the worker)
  add column if not exists elevenlabs_webhook_id text;

-- One voice agent per website and kind: `live` holds the published settings, `test` the draft from the Voice tab.
create table if not exists outreach_webchat_voice_agents (
  inbox_id         uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  which            text not null check (which in ('live','test')),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  account          text not null default 'platform' check (account in ('platform','own')),
  el_agent_id      text,
  el_tool_ids      jsonb not null default '{}',      -- {search_knowledge: "...", find_products: "...", ...}
  el_secret_id     text,                             -- the provider's workspace secret used in the tool headers
  tool_secret_hash text,                             -- sha256 of that secret; tool calls are verified against this
  config_hash      text,                             -- sha256 of what the provider has now
  want_hash        text,                             -- sha256 of what the last attempt tried to put there
  synced_at        timestamptz,
  sync_error       text,
  sync_attempts    int not null default 0,
  next_sync_at     timestamptz,
  archived         boolean not null default false,
  draft            jsonb,                            -- test only: the unpublished settings.voice from the Voice tab
  draft_at         timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (inbox_id, which)
);
create index if not exists outreach_webchat_voice_agents_el_idx on outreach_webchat_voice_agents(el_agent_id) where el_agent_id is not null;

create table if not exists outreach_webchat_voice_calls (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references outreach_workspaces(id) on delete cascade,
  inbox_id           uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  chat_id            uuid references outreach_chats(id) on delete set null,      -- null for test calls
  visitor_id         uuid references outreach_webchat_visitors(id) on delete set null,
  el_conversation_id text not null unique,
  el_agent_id        text not null,
  account            text not null default 'platform' check (account in ('platform','own')),
  test               boolean not null default false,
  status             text not null default 'starting'
                     check (status in ('starting','in_progress','ended_unconfirmed','done','failed')),
  started_at         timestamptz not null default now(),
  ended_at           timestamptz,
  ended_reason       text,              -- visitor | agent_end_call | switch | handoff | takeover | silence | max_duration | error
  duration_s         int,
  cost_credits       int,
  cost_usd           numeric(10,4),
  language           text,
  summary            text,
  title              text,
  successful         text,              -- success | failure | unknown
  collected          jsonb not null default '{}',
  tool_calls         int not null default 0,
  empty_searches     int not null default 0,   -- the low-confidence streak counter
  has_audio          boolean not null default false,
  handoff_reason     text,
  max_minutes        int not null default 5,   -- the limit this call started with (the tools and the live mirror stop after it)
  agent_turns        int not null default 0,
  low_next           boolean not null default false,   -- the last search found nothing: the next spoken answer is recorded as low confidence
  page_url           text,
  card_message_id    uuid,                     -- the call's card in the thread (an `event` message, kind voice_call)
  started_by         uuid references auth.users(id) on delete set null,   -- test calls: who ran the test
  finalized_at       timestamptz,
  poll_attempts      int not null default 0,
  next_poll_at       timestamptz
);
create index if not exists outreach_webchat_voice_calls_ws_idx    on outreach_webchat_voice_calls(workspace_id, started_at desc);
create index if not exists outreach_webchat_voice_calls_chat_idx  on outreach_webchat_voice_calls(chat_id, started_at);
create index if not exists outreach_webchat_voice_calls_live_idx  on outreach_webchat_voice_calls(status) where status in ('starting','in_progress','ended_unconfirmed');
create index if not exists outreach_webchat_voice_calls_visitor_idx on outreach_webchat_voice_calls(visitor_id) where visitor_id is not null;

-- What still has to be deleted at the voice provider: agents / tools / secrets of a removed website (or of the account a
-- workspace switched away from), conversations of an erased visitor or a deleted chat. The worker empties it.
create table if not exists outreach_webchat_voice_cleanup (
  id           bigserial primary key,
  workspace_id uuid,                               -- no FK: the row outlives a deleted workspace
  account      text not null default 'platform',
  kind         text not null check (kind in ('agent','tool','secret','conversation')),
  el_id        text not null,
  created_at   timestamptz not null default now(),
  attempts     int not null default 0,
  next_at      timestamptz not null default now(),
  last_error   text,
  done_at      timestamptz
);
create index if not exists outreach_webchat_voice_cleanup_due_idx on outreach_webchat_voice_cleanup(next_at) where done_at is null;

-- Extra voice minutes for one calendar month (voice packs; granted by the platform team until packs are sold in the app).
create table if not exists outreach_voice_minute_grants (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  month        date not null,
  minutes      int not null check (minutes > 0),
  note         text,
  created_by   uuid,
  created_at   timestamptz not null default now()
);
create index if not exists outreach_voice_minute_grants_ws_idx on outreach_voice_minute_grants(workspace_id, month);

alter table outreach_webchat_visitors add column if not exists voice_consent_at timestamptz;
alter table outreach_chats add column if not exists voice_calls int not null default 0;   -- the inbox list marks conversations that had a call
-- a spoken answer is a turn of the assistant like a written one (Activity, max turns, unanswered questions)
alter table outreach_webchat_ai_turns add column if not exists voice_call_id uuid references outreach_webchat_voice_calls(id) on delete cascade;
create index if not exists outreach_webchat_ai_turns_voice_idx on outreach_webchat_ai_turns(voice_call_id) where voice_call_id is not null;

alter table outreach_webchat_voice_agents  enable row level security;   -- managers read their workspace's rows
alter table outreach_webchat_voice_calls   enable row level security;   -- members read, with client visibility like chats
alter table outreach_webchat_voice_cleanup enable row level security;   -- service only
alter table outreach_voice_minute_grants   enable row level security;

select outreach__policy('outreach_webchat_voice_agents', 'webchat_voice_agents_select', 'select',
  'outreach_role_in(workspace_id) in (''owner'',''manager'') and exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_webchat_voice_calls', 'webchat_voice_calls_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and outreach_client_visible(i.workspace_id, i.client_id))');
select outreach__policy('outreach_voice_minute_grants', 'voice_minute_grants_select', 'select', 'workspace_id in (select outreach_workspace_ids())');
revoke insert, update, delete, truncate on outreach_webchat_voice_agents, outreach_webchat_voice_calls, outreach_webchat_voice_cleanup, outreach_voice_minute_grants from anon, authenticated;
revoke all on outreach_webchat_voice_cleanup from anon, authenticated;
-- the provider's ids, the hash of the tool secret and the draft never reach a browser through the table: the app reads outreach_hub_voice_state()
revoke select on outreach_webchat_voice_agents from anon, authenticated;
grant select (inbox_id, which, workspace_id, account, synced_at, sync_error, archived, updated_at) on outreach_webchat_voice_agents to authenticated;

-- ---- what goes when a website, a chat or a call goes
create or replace function outreach_webchat_trg_voice_agent_gone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if old.el_agent_id is not null then insert into outreach_webchat_voice_cleanup(workspace_id, account, kind, el_id) values (old.workspace_id, old.account, 'agent', old.el_agent_id); end if;
  insert into outreach_webchat_voice_cleanup(workspace_id, account, kind, el_id, next_at)
  select old.workspace_id, old.account, 'tool', x.value, now() + interval '1 minute' from jsonb_each_text(coalesce(old.el_tool_ids, '{}'::jsonb)) x where coalesce(x.value, '') <> '';
  if old.el_secret_id is not null then insert into outreach_webchat_voice_cleanup(workspace_id, account, kind, el_id, next_at) values (old.workspace_id, old.account, 'secret', old.el_secret_id, now() + interval '2 minutes'); end if;
  return null;
end $$;
drop trigger if exists outreach_webchat_voice_agent_gone on outreach_webchat_voice_agents;
create trigger outreach_webchat_voice_agent_gone after delete on outreach_webchat_voice_agents for each row execute function outreach_webchat_trg_voice_agent_gone();

create or replace function outreach_webchat_trg_voice_call_gone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if (old.status <> 'failed' or old.duration_s is not null) and old.el_conversation_id not like 'sim-%' then
    insert into outreach_webchat_voice_cleanup(workspace_id, account, kind, el_id) values (old.workspace_id, old.account, 'conversation', old.el_conversation_id);
  end if;
  return null;
end $$;
drop trigger if exists outreach_webchat_voice_call_gone on outreach_webchat_voice_calls;
create trigger outreach_webchat_voice_call_gone after delete on outreach_webchat_voice_calls for each row execute function outreach_webchat_trg_voice_call_gone();

-- A deleted conversation (visitor erasure, "delete visitor") takes its calls with it: summary and collected details are
-- personal data, and the provider's copy is queued for deletion by the trigger above.
create or replace function outreach_webchat_trg_voice_chat_gone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if old.voice_calls > 0 then delete from outreach_webchat_voice_calls where chat_id = old.id; end if;
  return old;
end $$;
drop trigger if exists outreach_webchat_voice_chat_gone on outreach_chats;
create trigger outreach_webchat_voice_chat_gone before delete on outreach_chats for each row execute function outreach_webchat_trg_voice_chat_gone();

-- A deleted website (soft delete) loses both agents at once; the queue removes them, their tools and the secret at the provider.
create or replace function outreach_webchat_trg_voice_inbox_gone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.deleted_at is not null and old.deleted_at is null then delete from outreach_webchat_voice_agents where inbox_id = new.id; end if;
  return null;
end $$;
drop trigger if exists outreach_webchat_voice_inbox_gone on outreach_webchat_inboxes;
create trigger outreach_webchat_voice_inbox_gone after update of deleted_at on outreach_webchat_inboxes for each row execute function outreach_webchat_trg_voice_inbox_gone();

-- ===============================================================================================================
-- 2. Limits: plan features, platform flags, the minutes pool
-- ===============================================================================================================
-- Generated from pricing/v1.json into 058 as well (scripts/pricing-sync.mjs); repeated here so 069 alone is enough on a
-- database that already has 058.
insert into outreach_plan_features(plan, feature, enabled, limit_value) values
  ('launch', 'voice_minutes', false, 0), ('scale', 'voice_minutes', true, 100), ('enterprise', 'voice_minutes', true, 300),
  ('launch', 'voice_max_minutes', true, 5), ('scale', 'voice_max_minutes', true, 10), ('enterprise', 'voice_max_minutes', true, 30),
  ('launch', 'voice_concurrency', true, 2), ('scale', 'voice_concurrency', true, 5), ('enterprise', 'voice_concurrency', true, 10),
  ('launch', 'voice_own_key', false, null), ('scale', 'voice_own_key', true, null), ('enterprise', 'voice_own_key', true, null)
on conflict (plan, feature) do nothing;

insert into outreach_flags(key, value) values
  ('voice_llm_models', '{"fast": "gemini-2.5-flash", "smart": "claude-sonnet-4-5"}'::jsonb),   -- the provider's model ids behind Fast / Smartest
  ('voice_platform_concurrency', '30'::jsonb),                                                  -- calls at the same time on the platform account, all customers together
  ('voice_default_limits', '{"minutes": 100, "max_minutes": 10, "concurrency": 5, "own_key": true}'::jsonb)   -- while billing is not enforced
on conflict (key) do nothing;

create or replace function outreach_webchat__voice_langs() returns text[]
language sql immutable set search_path = public, extensions as $$
  -- the languages of the provider's fast multilingual speech model
  select array['en','ja','zh','de','hi','fr','ko','pt','it','es','id','nl','tr','fil','pl','sv','bg','ro','ar','cs','el','fi','hr','ms','sk','da','ta','uk','ru','hu','no','vi']
$$;

-- {included, max_minutes, concurrency, own_key}: what the plan gives (the flag `voice_default_limits` while billing is off).
create or replace function outreach__voice_limits(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare d jsonb;
begin
  select value into d from outreach_flags where key = 'voice_default_limits';
  d := coalesce(d, '{}'::jsonb);
  if not outreach_billing_enforced() then
    return jsonb_build_object('included', coalesce((d->>'minutes')::int, 100), 'max_minutes', greatest(1, least(30, coalesce((d->>'max_minutes')::int, 10))),
      'concurrency', greatest(1, coalesce((d->>'concurrency')::int, 5)), 'own_key', coalesce((d->>'own_key')::boolean, true));
  end if;
  return jsonb_build_object(
    'included', case when outreach_has_feature(p_ws, 'voice_minutes') then coalesce(outreach_plan_limit(p_ws, 'voice_minutes'), 0) else 0 end,
    'max_minutes', greatest(1, least(30, coalesce(outreach_plan_limit(p_ws, 'voice_max_minutes'), 5))),
    'concurrency', greatest(1, coalesce(outreach_plan_limit(p_ws, 'voice_concurrency'), 2)),
    'own_key', outreach_has_feature(p_ws, 'voice_own_key'));
end $$;

-- 'own' when the workspace has saved its own voice key and its plan allows one; else the platform account.
create or replace function outreach__voice_account(p_ws uuid) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case when exists (select 1 from outreach_workspace_secrets s where s.workspace_id = p_ws and s.elevenlabs_key_enc is not null)
                   and coalesce((outreach__voice_limits(p_ws)->>'own_key')::boolean, false) then 'own' else 'platform' end
$$;

-- The month's voice minutes (mirrors outreach__ai_pool). A call counts whole minutes, rounded up; test calls count too;
-- a call that is still running counts what it has used so far. Calls on the workspace's own account never count.
create or replace function outreach__voice_pool(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare lim jsonb := outreach__voice_limits(p_ws); own boolean := outreach__voice_account(p_ws) = 'own'; used int; tests int; extra int; total int;
begin
  select coalesce(sum(m), 0)::int, coalesce(sum(m) filter (where test), 0)::int into used, tests from (
    select c.test, ceil(greatest(0, coalesce(c.duration_s::numeric,
             extract(epoch from (coalesce(c.ended_at, least(now(), c.started_at + make_interval(mins => c.max_minutes))) - c.started_at))::numeric)) / 60.0) m
      from outreach_webchat_voice_calls c
     where c.workspace_id = p_ws and c.account = 'platform' and c.started_at >= date_trunc('month', now())
       and (c.status <> 'failed' or c.duration_s is not null)
       and (c.status <> 'starting' or c.started_at > now() - interval '2 minutes')) x;
  select coalesce(sum(g.minutes), 0)::int into extra from outreach_voice_minute_grants g where g.workspace_id = p_ws and g.month = date_trunc('month', now())::date;
  total := coalesce((lim->>'included')::int, 0) + extra;
  return jsonb_build_object('month', to_char(now(), 'YYYY-MM'), 'used', used, 'test_used', tests, 'limit', case when own then null else total end,
    'included', (lim->>'included')::int, 'extra', extra, 'own_key', own, 'ok', own or used < total);
end $$;

-- Voice pack / goodwill minutes for the current month (service only; the platform team runs it).
create or replace function outreach_voice_grant(p_ws uuid, p_minutes int, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if coalesce(p_minutes, 0) <= 0 or p_minutes > 100000 then raise exception 'E_PAYLOAD_INVALID: minutes'; end if;
  insert into outreach_voice_minute_grants(workspace_id, month, minutes, note) values (p_ws, date_trunc('month', now())::date, p_minutes, left(p_note, 300));
  return outreach__voice_pool(p_ws);
end $$;

-- ===============================================================================================================
-- 3. Settings: validation, the effective voice settings, what the widget may know
-- ===============================================================================================================
create or replace function outreach_webchat__voice_check(v jsonb) returns void
language plpgsql immutable set search_path = public, extensions as $$
declare k text; x jsonb; langs text[] := outreach_webchat__voice_langs(); seen text[] := '{}';
  num constant text := '^-?[0-9]+(\.[0-9]+)?$';
begin
  if v is null or jsonb_typeof(v) = 'null' then return; end if;
  if jsonb_typeof(v) <> 'object' then raise exception 'E_PAYLOAD_INVALID: voice'; end if;
  foreach k in array array['enabled','auto_language','hinglish','record'] loop
    if v ? k and jsonb_typeof(v->k) <> 'boolean' then raise exception 'E_PAYLOAD_INVALID: voice.% is on or off', k; end if;
  end loop;
  if v ? 'voice_id' and jsonb_typeof(v->'voice_id') <> 'null' and (jsonb_typeof(v->'voice_id') <> 'string' or (v->>'voice_id') !~ '^[A-Za-z0-9]{8,64}$') then raise exception 'E_PAYLOAD_INVALID: voice.voice_id'; end if;
  if length(coalesce(v->>'voice_name', '')) > 120 then raise exception 'E_PAYLOAD_INVALID: voice.voice_name'; end if;
  if v ? 'speed' and (jsonb_typeof(v->'speed') <> 'number' or (v->>'speed')::numeric not between 0.7 and 1.2) then raise exception 'E_PAYLOAD_INVALID: voice.speed is 0.7 to 1.2'; end if;
  if v ? 'stability' and (jsonb_typeof(v->'stability') <> 'number' or (v->>'stability')::numeric not between 0 and 1) then raise exception 'E_PAYLOAD_INVALID: voice.stability is 0 to 1'; end if;
  if v ? 'language' and jsonb_typeof(v->'language') <> 'null' and (jsonb_typeof(v->'language') <> 'string' or not (v->>'language') = any(langs)) then raise exception 'E_PAYLOAD_INVALID: voice.language is not a language voice supports'; end if;
  if v ? 'languages' and jsonb_typeof(v->'languages') <> 'null' then
    if jsonb_typeof(v->'languages') <> 'array' then raise exception 'E_PAYLOAD_INVALID: voice.languages'; end if;
    if jsonb_array_length(v->'languages') > 10 then raise exception 'E_PAYLOAD_INVALID: voice.languages (10 at most)'; end if;
    for x in select * from jsonb_array_elements(v->'languages') loop
      if jsonb_typeof(x) <> 'string' or not (x#>>'{}') = any(langs) then raise exception 'E_PAYLOAD_INVALID: voice.languages has a language voice does not support'; end if;
      if (x#>>'{}') = any(seen) then raise exception 'E_PAYLOAD_INVALID: voice.languages (a language is listed twice)'; end if;
      seen := seen || (x#>>'{}');
    end loop;
  end if;
  if v ? 'greeting' and jsonb_typeof(v->'greeting') <> 'null' then
    if jsonb_typeof(v->'greeting') <> 'object' then raise exception 'E_PAYLOAD_INVALID: voice.greeting'; end if;
    for k, x in select * from jsonb_each(v->'greeting') loop
      if not k = any(langs) then raise exception 'E_PAYLOAD_INVALID: voice.greeting (unknown language %)', left(k, 12); end if;
      if jsonb_typeof(x) not in ('string', 'null') or length(coalesce(x#>>'{}', '')) > 300 then raise exception 'E_PAYLOAD_INVALID: voice.greeting (300 characters at most)'; end if;
    end loop;
  end if;
  if v ? 'instructions' and (jsonb_typeof(v->'instructions') not in ('string', 'null') or length(coalesce(v->>'instructions', '')) > 2000) then raise exception 'E_PAYLOAD_INVALID: voice.instructions (2,000 characters at most)'; end if;
  if v ? 'max_minutes' and (jsonb_typeof(v->'max_minutes') <> 'number' or (v->>'max_minutes') !~ '^[0-9]{1,2}$' or (v->>'max_minutes')::int not between 1 and 30) then raise exception 'E_PAYLOAD_INVALID: voice.max_minutes is 1 to 30'; end if;
  if v ? 'silence_end_s' and (jsonb_typeof(v->'silence_end_s') <> 'number' or (v->>'silence_end_s') !~ '^[0-9]{2,3}$' or (v->>'silence_end_s')::int not between 10 and 120) then raise exception 'E_PAYLOAD_INVALID: voice.silence_end_s is 10 to 120'; end if;
  if v ? 'retention_days' and (jsonb_typeof(v->'retention_days') <> 'number' or (v->>'retention_days') !~ '^[0-9]{1,3}$' or (v->>'retention_days')::int not between 1 and 365) then raise exception 'E_PAYLOAD_INVALID: voice.retention_days is 1 to 365'; end if;
  if v->>'model' is not null and v->>'model' not in ('fast', 'smart') then raise exception 'E_PAYLOAD_INVALID: voice.model'; end if;
  if v->>'tool_sound' is not null and v->>'tool_sound' not in ('typing', 'none') then raise exception 'E_PAYLOAD_INVALID: voice.tool_sound'; end if;
  if v ? 'collect' and jsonb_typeof(v->'collect') <> 'null' then
    if jsonb_typeof(v->'collect') <> 'array' or exists (select 1 from jsonb_array_elements(v->'collect') e where jsonb_typeof(e) <> 'string' or (e#>>'{}') not in ('name', 'phone', 'need', 'budget')) then raise exception 'E_PAYLOAD_INVALID: voice.collect'; end if;
  end if;
  if v ? 'consent_text' and (jsonb_typeof(v->'consent_text') not in ('string', 'null') or length(coalesce(v->>'consent_text', '')) > 400) then raise exception 'E_PAYLOAD_INVALID: voice.consent_text (400 characters at most)'; end if;
  x := v->'ui';
  if x is not null and jsonb_typeof(x) <> 'null' then
    if jsonb_typeof(x) <> 'object' then raise exception 'E_PAYLOAD_INVALID: voice.ui'; end if;
    if length(coalesce(x->>'start_text', '')) > 40 then raise exception 'E_PAYLOAD_INVALID: voice.ui.start_text (40 characters at most)'; end if;
    if length(coalesce(x->>'start_hint', '')) > 80 then raise exception 'E_PAYLOAD_INVALID: voice.ui.start_hint (80 characters at most)'; end if;
    foreach k in array array['orb_1', 'orb_2'] loop
      if x->>k is not null and x->>k !~ '^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' then raise exception 'E_PAYLOAD_INVALID: voice.ui.%', k; end if;
    end loop;
    if x->>'avatar' is not null and x->>'avatar' not in ('logo', 'bot', 'none') then raise exception 'E_PAYLOAD_INVALID: voice.ui.avatar'; end if;
    if x ? 'captions' and jsonb_typeof(x->'captions') <> 'boolean' then raise exception 'E_PAYLOAD_INVALID: voice.ui.captions'; end if;
    if x ? 'labels' and jsonb_typeof(x->'labels') <> 'null' then
      if jsonb_typeof(x->'labels') <> 'object' then raise exception 'E_PAYLOAD_INVALID: voice.ui.labels'; end if;
      if exists (select 1 from jsonb_each(x->'labels') e where e.key not in ('listening', 'thinking', 'speaking', 'muted', 'connecting', 'end', 'mute', 'switch')
                    or jsonb_typeof(e.value) not in ('string', 'null') or length(coalesce(e.value#>>'{}', '')) > 40) then raise exception 'E_PAYLOAD_INVALID: voice.ui.labels'; end if;
    end if;
    if x ? 'show_on' and jsonb_typeof(x->'show_on') <> 'null' then
      if jsonb_typeof(x->'show_on') <> 'object' then raise exception 'E_PAYLOAD_INVALID: voice.ui.show_on'; end if;
      if exists (select 1 from jsonb_each(x->'show_on') e where e.key not in ('home', 'composer', 'launcher') or jsonb_typeof(e.value) <> 'boolean') then raise exception 'E_PAYLOAD_INVALID: voice.ui.show_on'; end if;
    end if;
  end if;
end $$;

-- The main language and the others, as the agent gets them: the main one first, never twice, only what voice supports.
create or replace function outreach_webchat__voice_languages(st jsonb, v jsonb) returns text[]
language sql immutable set search_path = public, extensions as $$
  with main as (
    select case when (v->>'language') = any(outreach_webchat__voice_langs()) then v->>'language'
                when lower(left(coalesce(st#>>'{locale,default}', 'en'), 2)) = any(outreach_webchat__voice_langs()) then lower(left(st#>>'{locale,default}', 2))
                else 'en' end m)
  select array[m] || coalesce((select array_agg(x.l order by x.n) from jsonb_array_elements_text(case when jsonb_typeof(v->'languages') = 'array' then v->'languages' else '[]'::jsonb end) with ordinality x(l, n)
                                where x.l <> m and x.l = any(outreach_webchat__voice_langs())), '{}') from main
$$;

-- May this website take a voice call at all (the "Requires" of the Voice tab)? Voice speaks at once, so it needs the
-- assistant on Auto: an answer that waits for approval cannot be spoken.
create or replace function outreach_webchat__voice_ready(i outreach_webchat_inboxes, st jsonb) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select i.deleted_at is null and i.is_active and i.ai_enabled and coalesce(st#>>'{ai,mode}', 'off') in ('first', 'offline_only')
     and coalesce(st#>>'{voice,enabled}', 'false') = 'true'
$$;

-- What the widget may know: never the agent, the voice id, the instructions or what is collected.
create or replace function outreach_webchat__voice_public(p_inbox uuid, st jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; v jsonb := coalesce(st->'voice', '{}'::jsonb); on_ boolean; lim jsonb;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then return jsonb_build_object('enabled', false); end if;
  on_ := outreach_webchat__voice_ready(i, st)
     and exists (select 1 from outreach_webchat_voice_agents a where a.inbox_id = i.id and a.which = 'live' and a.el_agent_id is not null and not a.archived and a.account = outreach__voice_account(i.workspace_id))
     and coalesce((outreach__voice_pool(i.workspace_id)->>'ok')::boolean, false);
  if not on_ then return jsonb_build_object('enabled', false); end if;
  lim := outreach__voice_limits(i.workspace_id);
  return jsonb_build_object('enabled', true, 'ui', coalesce(v->'ui', '{}'::jsonb), 'languages', to_jsonb(outreach_webchat__voice_languages(st, v)),
    'consent_text', v->'consent_text', 'record', coalesce((v->>'record')::boolean, true),
    'max_minutes', least(coalesce((v->>'max_minutes')::int, 5), (lim->>'max_minutes')::int));
end $$;

-- The words that hand a conversation to a person, typed or spoken: the website's keywords, and asking for a person.
create or replace function outreach_webchat__handoff_match(st jsonb, txt text) returns boolean
language sql immutable set search_path = public, extensions as $$
  select coalesce(txt, '') <> '' and (
    exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(st#>'{ai,handoff,keywords}') = 'array' then st#>'{ai,handoff,keywords}' else '[]'::jsonb end) kw
             where kw <> '' and position(lower(kw) in lower(txt)) > 0)
    or txt ~* '\m(talk|speak|chat) (to|with) (a |an |someone|the )?(person|human|agent|rep|team|someone)\M' or txt ~* '\m(real|live) (person|human|agent)\M')
$$;

-- ===============================================================================================================
-- 4. Calls (service only: the public edge function has checked website token + Origin + the visitor token)
-- ===============================================================================================================
-- Is this call still running, as far as we know? `starting` lasts two minutes (a token that never connected).
create or replace function outreach_webchat__voice_live(c outreach_webchat_voice_calls) returns boolean
language sql stable set search_path = public, extensions as $$
  select (c.status = 'starting' and c.started_at > now() - interval '2 minutes')
      or (c.status = 'in_progress' and c.started_at > now() - make_interval(mins => c.max_minutes + 2))
$$;

-- The call's card in the thread: one `event` message at the point the call started, updated as the call goes.
create or replace function outreach_webchat__voice_card(p_call uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_webchat_voice_calls%rowtype; a jsonb;
begin
  select * into c from outreach_webchat_voice_calls where id = p_call;
  if not found or c.chat_id is null then return; end if;
  a := jsonb_strip_nulls(jsonb_build_object('kind', 'voice_call', 'call_id', c.id,
    'status', case when c.status in ('starting', 'in_progress') then 'live' when c.status = 'failed' then 'failed' else 'ended' end,
    'started_at', c.started_at, 'ended_at', c.ended_at, 'ended_reason', c.ended_reason,
    'duration_s', coalesce(c.duration_s, case when c.ended_at is not null then greatest(0, extract(epoch from (c.ended_at - c.started_at))::int) end),
    'summary', c.summary, 'title', c.title, 'successful', c.successful, 'has_audio', case when c.finalized_at is not null then c.has_audio end,
    'language', c.language, 'handoff_reason', c.handoff_reason, 'confirmed', c.finalized_at is not null));
  if c.card_message_id is not null and exists (select 1 from outreach_messages m where m.id = c.card_message_id) then
    update outreach_messages set content_attributes = a where id = c.card_message_id and content_attributes is distinct from a;
  else
    insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, source, origin)
    values (c.workspace_id, c.chat_id, 'out', null, c.started_at, 'event', a, 'system', 'voice', 'ai_autopilot') returning id into c.card_message_id;
    update outreach_webchat_voice_calls set card_message_id = c.card_message_id where id = c.id;
  end if;
end $$;

-- Close a call from our side (the provider's webhook confirms it later). The first reason wins.
create or replace function outreach_webchat__voice_close(p_call uuid, p_reason text, p_handoff_reason text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  update outreach_webchat_voice_calls
     set status = case when status in ('starting', 'in_progress') then case when status = 'starting' and p_reason = 'error' then 'failed' else 'ended_unconfirmed' end else status end,
         ended_at = coalesce(ended_at, now()),
         ended_reason = coalesce(ended_reason, left(p_reason, 40)),
         handoff_reason = coalesce(handoff_reason, left(p_handoff_reason, 60)),
         next_poll_at = coalesce(next_poll_at, now() + interval '10 minutes')
   where id = p_call;
  perform outreach_webchat__voice_card(p_call);
end $$;

-- Step 1 of /voice/start: every check, and what the session needs. {ok:false, reason} keeps the widget in chat:
--   off | mode | closed | handed_off | agent | sequence | consent | minutes | busy | rate
create or replace function outreach_webchat_v_voice_start(p_visitor uuid, p_chat uuid, p_consent boolean, p_page jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; v outreach_webchat_visitors%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; vs jsonb; ag outreach_webchat_voice_agents%rowtype;
        lim jsonb; pool jsonb; av jsonb; acct text; n int; cap int; langs text[]; recent text; r record; max_m int; left_m int;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  select * into v from outreach_webchat_visitors where id = c.visitor_id;
  select * into i from outreach_webchat_inboxes where id = c.webchat_inbox_id;
  st := outreach_webchat__settings(i.id); vs := coalesce(st->'voice', '{}'::jsonb);
  if not outreach_webchat__voice_ready(i, st) or not outreach_plan_active(i.workspace_id) then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  acct := outreach__voice_account(i.workspace_id);
  select * into ag from outreach_webchat_voice_agents where inbox_id = i.id and which = 'live';
  if not found or ag.el_agent_id is null or ag.archived or ag.account <> acct then return jsonb_build_object('ok', false, 'reason', 'off'); end if;
  if v.blocked_at is not null or exists (select 1 from outreach_webchat_blocks b where b.inbox_id = i.id and ((b.kind = 'visitor' and b.value = v.id::text) or (b.kind = 'ip_hash' and b.value = v.ip_hash) or (b.kind = 'country' and v.country is not null and upper(b.value) = upper(v.country)))) then
    return jsonb_build_object('ok', false, 'reason', 'off');
  end if;
  av := outreach_webchat__availability(i.id);
  if coalesce(st#>>'{ai,mode}', 'off') = 'offline_only' and coalesce((av->>'online')::boolean, false) then return jsonb_build_object('ok', false, 'reason', 'mode'); end if;
  if c.status = 'resolved' then return jsonb_build_object('ok', false, 'reason', 'closed'); end if;
  if c.handed_off_at is not null or coalesce(c.ai_mode, 'off') in ('off', 'review') then return jsonb_build_object('ok', false, 'reason', 'handed_off'); end if;
  if c.agent_typing_at is not null and c.agent_typing_at > now() - interval '10 seconds' then return jsonb_build_object('ok', false, 'reason', 'agent'); end if;
  if coalesce((st#>>'{ai,handoff,leads_in_sequence}')::boolean, true) and c.lead_id is not null
     and exists (select 1 from outreach_enrollments e where e.lead_id = c.lead_id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then
    return jsonb_build_object('ok', false, 'reason', 'sequence');
  end if;
  if v.voice_consent_at is null then
    if not coalesce(p_consent, false) then return jsonb_build_object('ok', false, 'reason', 'consent'); end if;
    update outreach_webchat_visitors set voice_consent_at = now() where id = v.id;
    insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (v.id, c.id, 'voice_consent', jsonb_build_object('record', coalesce((vs->>'record')::boolean, true)));
  end if;
  pool := outreach__voice_pool(i.workspace_id);
  if not coalesce((pool->>'ok')::boolean, false) then return jsonb_build_object('ok', false, 'reason', 'minutes'); end if;
  lim := outreach__voice_limits(i.workspace_id);
  -- a call of this conversation that is still open (the retry after a lost connection): it ends here
  for r in select x.id from outreach_webchat_voice_calls x where x.chat_id = c.id and x.status in ('starting', 'in_progress') loop
    perform outreach_webchat__voice_close(r.id, 'error');
  end loop;
  select count(*) into n from outreach_webchat_voice_calls x where x.workspace_id = i.workspace_id and outreach_webchat__voice_live(x);
  if n >= (lim->>'concurrency')::int then return jsonb_build_object('ok', false, 'reason', 'busy'); end if;
  if acct = 'platform' then
    select coalesce((select (f.value #>> '{}')::int from outreach_flags f where f.key = 'voice_platform_concurrency' and jsonb_typeof(f.value) = 'number'), 30) into cap;
    select count(*) into n from outreach_webchat_voice_calls x where x.account = 'platform' and x.status in ('starting', 'in_progress') and outreach_webchat__voice_live(x);
    if n >= cap then return jsonb_build_object('ok', false, 'reason', 'busy', 'platform', true); end if;
  end if;
  -- last, so a refusal above does not use up one of the visitor's calls
  if not outreach_rate_limit('webchat:voice:' || v.id::text, coalesce((st#>>'{security,rate_limits,voice_1h}')::int, 3), 3600) then return jsonb_build_object('ok', false, 'reason', 'rate'); end if;
  max_m := least(coalesce((vs->>'max_minutes')::int, 5), (lim->>'max_minutes')::int);
  if not coalesce((pool->>'own_key')::boolean, false) then
    left_m := greatest(1, (pool->>'limit')::int - (pool->>'used')::int);
    max_m := least(max_m, left_m);   -- the tools and the live mirror stop there; the provider's own limit is the agent's
  end if;
  langs := outreach_webchat__voice_languages(st, vs);
  select string_agg(case when x.direction = 'in' then 'Visitor: ' else 'Assistant: ' end || left(regexp_replace(x.text, '\s+', ' ', 'g'), 240), E'\n' order by x.sent_at) into recent
    from (select m.direction, m.text, m.sent_at from outreach_messages m where m.chat_id = c.id and m.text is not null and m.content_type = 'text' and m.deleted_at is null order by m.sent_at desc limit 8) x;
  return jsonb_build_object('ok', true, 'workspace_id', i.workspace_id, 'inbox_id', i.id, 'chat_id', c.id, 'visitor_id', v.id,
    'el_agent_id', ag.el_agent_id, 'account', acct, 'brand', coalesce(nullif(st#>>'{appearance,brand_name}', ''), i.name),
    'visitor_name', coalesce(nullif(btrim(v.name), ''), ''), 'recent_chat', coalesce(right(recent, 1500), ''),
    'languages', to_jsonb(langs), 'max_minutes', max_m, 'timezone', coalesce(nullif(i.business_hours->>'tz', ''), 'UTC'),
    'page_url', left(coalesce(p_page->>'url', v.current_url, ''), 500), 'page_title', left(coalesce(p_page->>'title', v.current_title, ''), 200));
end $$;

-- Step 2 of /voice/start: the provider gave a token and a conversation id; the call row links it to our chat before the
-- call begins. Returns {call_id, started_at}.
create or replace function outreach_webchat_v_voice_started(p_visitor uuid, p_chat uuid, p_el_conversation text, p_el_agent text, p_account text, p_language text, p_max_minutes int, p_page_url text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; cid uuid;
begin
  c := outreach_webchat__own(p_visitor, p_chat);
  if nullif(btrim(coalesce(p_el_conversation, '')), '') is null or nullif(btrim(coalesce(p_el_agent, '')), '') is null then raise exception 'E_PAYLOAD_INVALID'; end if;
  insert into outreach_webchat_voice_calls(workspace_id, inbox_id, chat_id, visitor_id, el_conversation_id, el_agent_id, account, language, max_minutes, page_url)
  values (c.workspace_id, c.webchat_inbox_id, c.id, c.visitor_id, p_el_conversation, p_el_agent, case when p_account = 'own' then 'own' else 'platform' end,
          nullif(left(p_language, 12), ''), greatest(1, least(30, coalesce(p_max_minutes, 5))), nullif(left(p_page_url, 2000), ''))
  returning id into cid;
  update outreach_chats set voice_calls = voice_calls + 1, visitor_last_seen_at = now() where id = c.id;
  perform outreach_webchat__voice_card(cid);
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (c.visitor_id, c.id, 'voice_call_started', jsonb_build_object('call_id', cid));
  perform outreach_emit_event(c.workspace_id, 'webchat.voice_call.started', jsonb_build_object('id', cid, 'chat_id', c.id, 'inbox_id', c.webchat_inbox_id, 'visitor_id', c.visitor_id));
  return jsonb_build_object('call_id', cid, 'started_at', (select started_at from outreach_webchat_voice_calls where id = cid));
end $$;

-- Ownership of a call: the visitor (or the visitor it was merged into) owns the call's chat.
create or replace function outreach_webchat__voice_own(p_visitor uuid, p_call uuid) returns outreach_webchat_voice_calls
language plpgsql stable security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_webchat_voice_calls where id = p_call and not test and chat_id is not null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_webchat__own(p_visitor, k.chat_id);
  return k;
end $$;

-- The live transcript: final turns from the widget, [{role: user | agent, text, event_id, at}]. They become messages of
-- the same conversation (marked live until the provider's transcript replaces them), deduped on (call, event id).
-- Returns {ok, handoff, reason, takeover, ended}: the same keyword / max-turn rules as a typed message.
create or replace function outreach_webchat_v_voice_turns(p_visitor uuid, p_call uuid, p_turns jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; c outreach_chats%rowtype; v outreach_webchat_visitors%rowtype; st jsonb; t jsonb; txt text; role text; eid text; at_ timestamptz;
        mid uuid; handoff boolean := false; reason text; brand text; lastq text; n int := 0; new_user boolean := false; conf text;
begin
  k := outreach_webchat__voice_own(p_visitor, p_call);
  select * into c from outreach_chats where id = k.chat_id;
  if k.status not in ('starting', 'in_progress') or k.started_at < now() - make_interval(mins => k.max_minutes + 2) then
    return jsonb_build_object('ok', true, 'ended', true, 'handoff', false, 'takeover', c.handed_off_at is not null);
  end if;
  if not outreach_rate_limit('webchat:voice:turns:' || k.id::text, 120, 60) then raise exception 'E_RATE_LIMITED'; end if;
  if k.status = 'starting' then update outreach_webchat_voice_calls set status = 'in_progress' where id = k.id; perform outreach_webchat__voice_card(k.id); end if;
  select * into v from outreach_webchat_visitors where id = c.visitor_id;
  st := outreach_webchat__settings(k.inbox_id);
  brand := coalesce(nullif(st#>>'{appearance,brand_name}', ''), 'Assistant');
  for t in select * from jsonb_array_elements(case when jsonb_typeof(p_turns) = 'array' then p_turns else '[]'::jsonb end) limit 20 loop
    role := t->>'role'; txt := btrim(left(coalesce(t->>'text', ''), 2000)); eid := left(regexp_replace(coalesce(t->>'event_id', ''), '[^A-Za-z0-9_-]', '', 'g'), 24);
    if role not in ('user', 'agent') or txt = '' or eid = '' or txt = '(handing over to the team)' then continue; end if;
    begin at_ := (t->>'at')::timestamptz; exception when others then at_ := now(); end;
    at_ := greatest(k.started_at, least(now(), coalesce(at_, now())));
    mid := null;
    if role = 'user' then
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, sender_identifier, source, origin, echo_id)
      values (k.workspace_id, k.chat_id, 'in', txt, at_, 'text', jsonb_build_object('voice', jsonb_build_object('call_id', k.id, 'event_id', eid, 'live', true)),
              'visitor', coalesce(v.name, 'Visitor'), v.email, 'voice', 'prospect', 'v:' || left(k.id::text, 8) || ':' || eid)
      on conflict (chat_id, echo_id) where echo_id is not null do nothing returning id into mid;
      if mid is not null then
        new_user := true; n := n + 1;
        if not handoff and outreach_webchat__handoff_match(st, txt) then handoff := true; reason := 'keyword'; end if;
      end if;
    else
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin, echo_id)
      values (k.workspace_id, k.chat_id, 'out', txt, at_, 'text', jsonb_build_object('ai', true, 'voice', jsonb_build_object('call_id', k.id, 'event_id', eid, 'live', true)),
              'bot', brand, 'voice', 'ai_autopilot', 'v:' || left(k.id::text, 8) || ':' || eid)
      on conflict (chat_id, echo_id) where echo_id is not null do nothing returning id into mid;
      if mid is not null then
        n := n + 1;
        select m.text into lastq from outreach_messages m where m.chat_id = k.chat_id and m.direction = 'in' and m.content_attributes#>>'{voice,call_id}' = k.id::text and m.sent_at <= at_ order by m.sent_at desc limit 1;
        select case when x.low_next then 'low' else 'high' end into conf from outreach_webchat_voice_calls x where x.id = k.id;
        insert into outreach_webchat_ai_turns(workspace_id, inbox_id, chat_id, visitor_id, answer_message_id, query, answer, confidence, page_url, model, voice_call_id)
        values (k.workspace_id, k.inbox_id, k.chat_id, k.visitor_id, mid, left(coalesce(lastq, ''), 2000), txt, conf, k.page_url, 'voice', k.id);
        update outreach_webchat_voice_calls set agent_turns = agent_turns + 1, low_next = false where id = k.id;
      end if;
    end if;
  end loop;
  if n > 0 then update outreach_chats set ai_handled = true, visitor_last_seen_at = now() where id = k.chat_id and handed_off_at is null; end if;
  -- the website's "hand off after N assistant turns", typed and spoken turns together
  if not handoff and new_user and (select count(*) from outreach_webchat_ai_turns x where x.chat_id = k.chat_id) >= coalesce((st#>>'{ai,handoff,max_turns}')::int, 6) then
    handoff := true; reason := 'max_turns';
  end if;
  select * into c from outreach_chats where id = k.chat_id;
  return jsonb_build_object('ok', true, 'ended', false, 'handoff', handoff and c.handed_off_at is null, 'reason', reason, 'takeover', c.handed_off_at is not null);
end $$;

-- The call switches to text chat. p_handoff: a person takes over (the existing handoff: assignment, notification, the
-- online / offline message); otherwise the assistant keeps answering by text.
create or replace function outreach_webchat_v_voice_switch(p_visitor uuid, p_call uuid, p_handoff boolean, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; c outreach_chats%rowtype; ho jsonb; why text := nullif(left(regexp_replace(coalesce(p_reason, ''), '[^A-Za-z0-9_ -]', '', 'g'), 40), '');
begin
  k := outreach_webchat__voice_own(p_visitor, p_call);
  perform outreach_webchat__voice_close(k.id, case when coalesce(p_handoff, false) then 'handoff' when why = 'takeover' then 'takeover' else 'switch' end, case when coalesce(p_handoff, false) then coalesce(why, 'agent') end);
  if coalesce(p_handoff, false) then ho := outreach_webchat_v_handoff(k.chat_id, 'voice_' || coalesce(why, 'agent')); end if;
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) values (k.visitor_id, k.chat_id, 'voice_switched', jsonb_build_object('call_id', k.id, 'handoff', coalesce(p_handoff, false), 'reason', why));
  select * into c from outreach_chats where id = k.chat_id;
  return jsonb_build_object('ok', true, 'handoff', ho, 'conversation', outreach_webchat__conversation_json(c));
end $$;

create or replace function outreach_webchat_v_voice_end(p_visitor uuid, p_call uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; c outreach_chats%rowtype;
        why text := case when p_reason in ('visitor', 'agent_end_call', 'switch', 'handoff', 'takeover', 'silence', 'max_duration', 'error') then p_reason else 'visitor' end;
begin
  k := outreach_webchat__voice_own(p_visitor, p_call);
  perform outreach_webchat__voice_close(k.id, why);
  select * into c from outreach_chats where id = k.chat_id;
  return jsonb_build_object('ok', true, 'conversation', outreach_webchat__conversation_json(c));
end $$;

-- ---- the tools the voice agent calls (outreach-voice-tools) ----------------------------------------------------
-- One call per tool request: the per-agent secret (its hash), the call from the signed session, the 30-a-call limit.
-- Returns what the tool needs; raises E_FORBIDDEN / E_EXPIRED / E_RATE_LIMITED.
create or replace function outreach_webchat_v_voice_tool(p_call uuid, p_secret_hash text, p_tool text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_webchat_voice_calls where id = p_call;
  if not found then raise exception 'E_FORBIDDEN'; end if;
  if not exists (select 1 from outreach_webchat_voice_agents a where a.inbox_id = k.inbox_id and a.which = case when k.test then 'test' else 'live' end
                    and a.el_agent_id = k.el_agent_id and a.tool_secret_hash is not null and a.tool_secret_hash = p_secret_hash) then raise exception 'E_FORBIDDEN'; end if;
  -- while the call is live (the session token is re-validated here on every call, up to the call's limit + 2 minutes)
  if k.status not in ('starting', 'in_progress') or k.started_at < now() - make_interval(mins => k.max_minutes + 2) then raise exception 'E_EXPIRED'; end if;
  update outreach_webchat_voice_calls set tool_calls = tool_calls + 1, status = case when status = 'starting' then 'in_progress' else status end where id = k.id returning tool_calls into n;
  if n > 30 then raise exception 'E_RATE_LIMITED'; end if;
  select * into i from outreach_webchat_inboxes where id = k.inbox_id;
  st := outreach_webchat__settings(i.id);
  return jsonb_build_object('call_id', k.id, 'workspace_id', k.workspace_id, 'inbox_id', k.inbox_id, 'chat_id', k.chat_id, 'visitor_id', k.visitor_id, 'test', k.test,
    'brand', coalesce(nullif(st#>>'{appearance,brand_name}', ''), i.name), 'page_url', k.page_url,
    'knowledge_source_ids', coalesce(st#>'{ai,knowledge_source_ids}', '[]'::jsonb),
    'products', outreach_webchat__products_ctx(i.id, st),
    'low_confidence_streak', coalesce((st#>>'{ai,handoff,low_confidence_streak}')::int, 2), 'empty_searches', k.empty_searches,
    'prompt', coalesce(st#>>'{messages,email_capture_prompt}', ''));
end $$;

-- After a knowledge search: the empty-result streak (the same rule as low-confidence text answers), and the question
-- goes to AI → Knowledge → Unanswered questions when nothing was found.
create or replace function outreach_webchat_v_voice_search_done(p_call uuid, p_query text, p_found int) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; st jsonb; streak int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_webchat_voice_calls set empty_searches = case when coalesce(p_found, 0) > 0 then 0 else empty_searches + 1 end, low_next = coalesce(p_found, 0) = 0
   where id = p_call returning * into k;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if coalesce(p_found, 0) = 0 and k.chat_id is not null then perform outreach_webchat_unanswered_add(k.chat_id, null, coalesce(p_query, '')); end if;
  st := outreach_webchat__settings(k.inbox_id);
  streak := coalesce((st#>>'{ai,handoff,low_confidence_streak}')::int, 2);
  return jsonb_build_object('empty_searches', k.empty_searches, 'offer_team', k.empty_searches >= streak);
end $$;

-- A name or a phone number the visitor said. Never over a value the visitor typed or the site identified.
create or replace function outreach_webchat_v_voice_contact(p_call uuid, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; v outreach_webchat_visitors%rowtype; nm text := nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), 120), '');
        ph text := nullif(left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 20), ''); saved text[] := '{}';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_webchat_voice_calls where id = p_call;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if ph is not null and ph !~ '^\+?[0-9]{6,15}$' then ph := null; end if;
  if k.visitor_id is null then return jsonb_build_object('ok', true, 'saved', to_jsonb(array_remove(array[case when nm is not null then 'name' end, case when ph is not null then 'phone' end], null))); end if;
  select * into v from outreach_webchat_visitors where id = k.visitor_id;
  if nm is not null and v.name is null then saved := array_append(saved, 'name'); end if;
  if ph is not null and v.phone is null then saved := array_append(saved, 'phone'); end if;
  update outreach_webchat_visitors set name = coalesce(name, nm), phone = coalesce(phone, ph), last_seen_at = now() where id = v.id;
  if 'name' = any(saved) then update outreach_chats set attendee_name = nm where visitor_id = v.id; end if;
  if cardinality(saved) > 0 then perform outreach_webchat__link_lead(v.id, false); end if;
  update outreach_webchat_voice_calls set collected = collected || jsonb_strip_nulls(jsonb_build_object('visitor_name', nm, 'visitor_phone', ph)) where id = k.id;
  return jsonb_build_object('ok', true, 'saved', to_jsonb(saved), 'had_name', v.name is not null, 'had_phone', v.phone is not null);
end $$;

-- Before the email form is shown in a call: does the visitor have an email already, is a form already waiting?
create or replace function outreach_webchat_v_voice_email_state(p_call uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_is_service() then null else (
    select jsonb_build_object('has_email', v.email is not null,
      'open_form', exists (select 1 from outreach_messages m where m.chat_id = k.chat_id and m.content_type = 'form' and m.content_attributes->>'form' = 'email' and m.sent_at > now() - interval '10 minutes'))
      from outreach_webchat_voice_calls k left join outreach_webchat_visitors v on v.id = k.visitor_id where k.id = p_call) end
$$;

-- ---- after the call: the provider's signed transcript (webhook) or the same data fetched by the worker ----------
-- p_payload (normalised by the edge function):
--   {transcript: [{role: user | agent, message, time_in_call_secs}], duration_s, cost_credits, cost_usd, termination_reason,
--    main_language, summary, title, successful, collected: {visitor_name, visitor_phone, need, budget}, has_audio, status}
-- One transaction: the inbox never shows the live copy and the confirmed one together. A second delivery is a no-op.
create or replace function outreach_webchat_v_voice_finalize(p_el_conversation text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare k outreach_webchat_voice_calls%rowtype; c outreach_chats%rowtype; v outreach_webchat_visitors%rowtype; st jsonb; brand text; t jsonb; role text; txt text; n int := 0; at_ timestamptz;
        mid uuid; lastq text; dur int; col jsonb; nm text; ph text; reason text; unread_ boolean; unread_n int; before jsonb; after jsonb; notice int; lim int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into k from outreach_webchat_voice_calls where el_conversation_id = p_el_conversation for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'unknown'); end if;
  if k.finalized_at is not null then return jsonb_build_object('ok', true, 'duplicate', true, 'call_id', k.id, 'workspace_id', k.workspace_id, 'test', k.test); end if;
  before := outreach__voice_pool(k.workspace_id);
  dur := greatest(0, coalesce((p_payload->>'duration_s')::numeric, extract(epoch from (coalesce(k.ended_at, now()) - k.started_at)))::int);
  col := case when jsonb_typeof(p_payload->'collected') = 'object' then p_payload->'collected' else '{}'::jsonb end;
  reason := lower(coalesce(p_payload->>'termination_reason', ''));
  update outreach_webchat_voice_calls set status = 'done', finalized_at = now(), ended_at = coalesce(ended_at, started_at + make_interval(secs => dur)), duration_s = dur,
      cost_credits = nullif(p_payload->>'cost_credits', '')::numeric::int, cost_usd = nullif(p_payload->>'cost_usd', '')::numeric,
      ended_reason = coalesce(ended_reason, case when reason like '%silence%' or reason like '%inactiv%' then 'silence' when reason like '%duration%' or reason like '%max%' then 'max_duration'
                                                 when reason like '%end_call%' or reason like '%agent%' then 'agent_end_call' when reason like '%error%' or reason like '%fail%' then 'error' else 'visitor' end),
      language = coalesce(nullif(left(p_payload->>'main_language', 12), ''), language), summary = nullif(left(p_payload->>'summary', 4000), ''), title = nullif(left(p_payload->>'title', 200), ''),
      successful = case when p_payload->>'successful' in ('success', 'failure', 'unknown') then p_payload->>'successful' else 'unknown' end,
      collected = collected || jsonb_strip_nulls(col), has_audio = coalesce((p_payload->>'has_audio')::boolean, false)
   where id = k.id returning * into k;
  if k.test or k.chat_id is null then
    return jsonb_build_object('ok', true, 'duplicate', false, 'call_id', k.id, 'workspace_id', k.workspace_id, 'test', true);
  end if;
  select * into c from outreach_chats where id = k.chat_id;
  st := outreach_webchat__settings(k.inbox_id);
  brand := coalesce(nullif(st#>>'{appearance,brand_name}', ''), 'Assistant');
  select * into v from outreach_webchat_visitors where id = k.visitor_id;
  -- 1. the confirmed transcript replaces the live rows (cards, forms and the call's card stay)
  if jsonb_typeof(p_payload->'transcript') = 'array' and exists (select 1 from jsonb_array_elements(p_payload->'transcript') x where x->>'role' in ('user', 'agent') and btrim(coalesce(x->>'message', '')) <> '') then
    unread_ := c.unread; unread_n := c.unread_count;
    delete from outreach_webchat_ai_turns where voice_call_id = k.id;
    delete from outreach_messages where chat_id = k.chat_id and content_type = 'text' and content_attributes#>>'{voice,call_id}' = k.id::text;
    for t in select * from jsonb_array_elements(p_payload->'transcript') loop
      role := t->>'role'; txt := btrim(left(coalesce(t->>'message', ''), 5000));
      if role not in ('user', 'agent') or txt = '' or txt = '(handing over to the team)' then continue; end if;
      n := n + 1;
      at_ := k.started_at + make_interval(secs => greatest(0, coalesce((t->>'time_in_call_secs')::numeric, 0))) + make_interval(secs => n * 0.001);
      insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, sender_identifier, source, origin, echo_id, read_by_agent_at)
      values (k.workspace_id, k.chat_id, (case when role = 'user' then 'in' else 'out' end)::outreach_direction_t, txt, at_, 'text',
              case when role = 'agent' then jsonb_build_object('ai', true) else '{}'::jsonb end || jsonb_build_object('voice', jsonb_build_object('call_id', k.id, 'event_id', 'f' || n, 'live', false, 'time_in_call_secs', (t->>'time_in_call_secs')::numeric)),
              case when role = 'user' then 'visitor' else 'bot' end, case when role = 'user' then coalesce(v.name, 'Visitor') else brand end, case when role = 'user' then v.email end,
              'voice', case when role = 'user' then 'prospect' else 'ai_autopilot' end, 'vf:' || left(k.id::text, 8) || ':' || n, case when role = 'user' and not unread_ then now() end)
      returning id into mid;
      if role = 'user' then lastq := txt;
      else
        insert into outreach_webchat_ai_turns(workspace_id, inbox_id, chat_id, visitor_id, answer_message_id, query, answer, confidence, page_url, model, voice_call_id, created_at)
        values (k.workspace_id, k.inbox_id, k.chat_id, k.visitor_id, mid, left(coalesce(lastq, ''), 2000), txt, 'high', k.page_url, 'voice', k.id, at_);
      end if;
    end loop;
    -- the live rows were already counted as unread: the confirmed copy must not count again
    update outreach_chats set unread = unread_, unread_count = unread_n where id = k.chat_id;
    update outreach_webchat_voice_calls set agent_turns = (select count(*) from outreach_webchat_ai_turns x where x.voice_call_id = k.id) where id = k.id;
  end if;
  -- 2. collected details: onto the visitor (and through the lead link), never over what the visitor typed
  if v.id is not null then
    nm := nullif(left(btrim(coalesce(col->>'visitor_name', '')), 120), '');
    ph := nullif(left(regexp_replace(coalesce(col->>'visitor_phone', ''), '[^0-9+]', '', 'g'), 20), '');
    if ph is not null and ph !~ '^\+?[0-9]{6,15}$' then ph := null; end if;
    update outreach_webchat_visitors set name = coalesce(name, nm), phone = coalesce(phone, ph),
        custom_attributes = jsonb_strip_nulls(jsonb_build_object('voice_need', nullif(left(col->>'need', 500), ''), 'voice_budget', nullif(left(col->>'budget', 120), ''))) || custom_attributes
     where id = v.id;
    if v.name is null and nm is not null then update outreach_chats set attendee_name = nm where visitor_id = v.id; end if;
    if (v.name is null and nm is not null) or (v.phone is null and ph is not null) then perform outreach_webchat__link_lead(v.id, false); end if;
    if ph is not null then update outreach_leads l set phone = ph where l.id = (select lead_id from outreach_webchat_visitors where id = v.id) and l.phone is null; end if;
  end if;
  perform outreach_webchat__voice_card(k.id);
  insert into outreach_webchat_events(visitor_id, chat_id, name, props) select k.visitor_id, k.chat_id, 'voice_call_ended', jsonb_build_object('call_id', k.id, 'duration_s', dur, 'reason', k.ended_reason) where k.visitor_id is not null;
  -- 3. the outbound webhook, and the 80 % / 100 % notices of the minutes pool
  perform outreach_emit_event(k.workspace_id, 'webchat.voice_call.ended', jsonb_build_object('id', k.id, 'chat_id', k.chat_id, 'inbox_id', k.inbox_id, 'visitor_id', k.visitor_id,
    'duration_s', dur, 'ended_reason', k.ended_reason, 'summary', k.summary, 'successful', k.successful, 'collected', k.collected, 'language', k.language, 'has_audio', k.has_audio));
  after := outreach__voice_pool(k.workspace_id);
  lim := (after->>'limit')::int;
  if lim is not null and lim > 0 then
    notice := case when (before->>'used')::int < lim and (after->>'used')::int >= lim then 100
                   when (before->>'used')::int * 100 < lim * 80 and (after->>'used')::int * 100 >= lim * 80 then 80 end;
  end if;
  return jsonb_build_object('ok', true, 'duplicate', false, 'call_id', k.id, 'workspace_id', k.workspace_id, 'chat_id', k.chat_id, 'inbox_id', k.inbox_id, 'test', false,
    'turns', n, 'notice', notice, 'pool', after);
end $$;

-- Missed webhook: calls that ended (or should have) ten minutes ago and were never confirmed. Each is handed out with a
-- growing gap, twelve times at most; the worker fetches the conversation and runs the same finalize.
create or replace function outreach_webchat_voice_poll_due(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out_ jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  -- scripted checks that were never collected
  update outreach_webchat_voice_calls set status = 'failed', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'error'), finalized_at = now(), duration_s = 0
   where el_conversation_id like 'sim-%' and finalized_at is null and started_at < now() - interval '15 minutes';
  -- a token that never became a call
  update outreach_webchat_voice_calls set status = 'failed', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'error')
   where status = 'starting' and started_at < now() - interval '10 minutes' and tool_calls = 0 and agent_turns = 0;
  with due as (
    select k.id from outreach_webchat_voice_calls k
     where k.finalized_at is null and k.status in ('in_progress', 'ended_unconfirmed') and k.poll_attempts < 12 and k.el_conversation_id not like 'sim-%'
       and coalesce(k.next_poll_at, k.started_at + make_interval(mins => k.max_minutes + 12)) <= now()
     order by k.started_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update skip locked),
  upd as (
    update outreach_webchat_voice_calls k set poll_attempts = k.poll_attempts + 1, next_poll_at = now() + make_interval(mins => 5 * (k.poll_attempts + 1)),
        status = case when k.status = 'in_progress' then 'ended_unconfirmed' else k.status end, ended_at = coalesce(k.ended_at, now()), ended_reason = coalesce(k.ended_reason, 'error')
      from due where k.id = due.id returning k.id, k.workspace_id, k.el_conversation_id, k.account, k.poll_attempts)
  select coalesce(jsonb_agg(jsonb_build_object('call_id', id, 'workspace_id', workspace_id, 'el_conversation_id', el_conversation_id, 'account', account, 'attempts', poll_attempts)), '[]'::jsonb) into out_ from upd;
  -- after twelve tries the call stays as the widget reported it
  update outreach_webchat_voice_calls set status = 'done', finalized_at = now(), duration_s = coalesce(duration_s, greatest(0, extract(epoch from (coalesce(ended_at, now()) - started_at))::int))
   where finalized_at is null and status = 'ended_unconfirmed' and poll_attempts >= 12 and next_poll_at <= now();
  return out_;
end $$;

-- The provider says it has no such conversation (a call that never connected): nothing to confirm.
create or replace function outreach_webchat_voice_poll_gone(p_call uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_voice_calls set status = case when agent_turns = 0 and tool_calls = 0 then 'failed' else 'done' end, finalized_at = now(),
         duration_s = coalesce(duration_s, case when agent_turns = 0 and tool_calls = 0 then 0 else greatest(0, extract(epoch from (coalesce(ended_at, now()) - started_at))::int) end)
   where id = p_call and finalized_at is null and outreach_is_service()
$$;

-- ---- clean-up queue -------------------------------------------------------------------------------------------
create or replace function outreach_webchat_voice_cleanup_due(p_limit int default 20) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare out_ jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  with due as (
    select q.id from outreach_webchat_voice_cleanup q where q.done_at is null and q.next_at <= now() and q.attempts < 8
     order by q.next_at limit greatest(1, least(coalesce(p_limit, 20), 100)) for update skip locked),
  upd as (
    update outreach_webchat_voice_cleanup q set attempts = q.attempts + 1, next_at = now() + make_interval(mins => 10 * (q.attempts + 1)) from due where q.id = due.id
    returning q.id, q.workspace_id, q.account, q.kind, q.el_id)
  select coalesce(jsonb_agg(to_jsonb(upd)), '[]'::jsonb) into out_ from upd;
  delete from outreach_webchat_voice_cleanup where done_at is not null and done_at < now() - interval '30 days';
  return out_;
end $$;

create or replace function outreach_webchat_voice_cleanup_done(p_id bigint, p_error text default null) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_voice_cleanup set done_at = case when p_error is null then now() else done_at end, last_error = left(p_error, 300) where id = p_id and outreach_is_service()
$$;

-- Ids the sync leaves behind (an account switch, a tool that was recreated).
create or replace function outreach_webchat_voice_cleanup_add(p_ws uuid, p_account text, p_kind text, p_el_id text) returns void
language sql security definer set search_path = public, extensions as $$
  insert into outreach_webchat_voice_cleanup(workspace_id, account, kind, el_id)
  select p_ws, case when p_account = 'own' then 'own' else 'platform' end, p_kind, p_el_id
   where outreach_is_service() and p_kind in ('agent', 'tool', 'secret', 'conversation') and coalesce(p_el_id, '') <> ''
$$;

-- ===============================================================================================================
-- 5. Agent sync (service only)
-- ===============================================================================================================
-- Everything the edge function needs to build the provider's agent for one website: the shared assistant settings, the
-- voice settings (the draft for the test agent), the Q&A written into the prompt, the plan's limits and the stored ids.
create or replace function outreach_webchat_v_voice_sync_ctx(p_inbox uuid, p_which text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; st jsonb; vs jsonb; ag outreach_webchat_voice_agents%rowtype; lim jsonb; wname text; qa jsonb; acct text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if p_which not in ('live', 'test') then raise exception 'E_PAYLOAD_INVALID: which'; end if;
  select * into i from outreach_webchat_inboxes where id = p_inbox;
  if not found then return jsonb_build_object('ok', false, 'why', 'not_found'); end if;
  select * into ag from outreach_webchat_voice_agents where inbox_id = p_inbox and which = p_which;
  st := outreach_webchat__settings(i.id);
  vs := coalesce(st->'voice', '{}'::jsonb);
  if p_which = 'test' and ag.draft is not null then vs := outreach_webchat__merge(vs, ag.draft); st := jsonb_set(st, '{voice}', vs); end if;
  select name into wname from outreach_workspaces where id = i.workspace_id;
  lim := outreach__voice_limits(i.workspace_id);
  acct := outreach__voice_account(i.workspace_id);
  -- the Q&A that applies to this website, oldest first: 30 pairs / 8,000 characters go into the prompt
  select coalesce(jsonb_agg(jsonb_build_object('question', x.question, 'answer', x.answer) order by x.created_at), '[]'::jsonb) into qa from (
    select f.question, f.answer, f.created_at from outreach_master_prompt_faqs f
     where f.master_prompt_id is null and f.workspace_id = i.workspace_id and f.enabled and outreach_hub__qa_applies(f.id, 'website', i.id)
     order by f.created_at limit 30) x;
  return jsonb_build_object('ok', true, 'inbox_id', i.id, 'workspace_id', i.workspace_id, 'which', p_which, 'deleted', i.deleted_at is not null,
    -- live: an agent exists while voice can take calls; test: once the Voice tab has been used (its row exists)
    'wanted', case when i.deleted_at is not null or not outreach_plan_active(i.workspace_id) then false
                   when p_which = 'live' then outreach_webchat__voice_ready(i, st) else ag.inbox_id is not null end,
    'name', i.name, 'workspace_name', coalesce(wname, ''), 'account', acct,
    'brand', coalesce(nullif(st#>>'{appearance,brand_name}', ''), i.name), 'persona', coalesce(st#>>'{ai,persona}', ''), 'allowed_topics', coalesce(st#>>'{ai,allowed_topics}', ''),
    'keywords', coalesce(st#>'{ai,handoff,keywords}', '[]'::jsonb), 'products', coalesce(st#>>'{ai,products,enabled}', '') = 'true' and cardinality(outreach_webchat__product_sources(i.workspace_id, st)) > 0,
    'email_form', coalesce((st#>>'{features,email_capture}')::boolean, true),
    'voice', vs, 'languages', to_jsonb(outreach_webchat__voice_languages(st, vs)), 'qa', qa,
    'limits', lim || jsonb_build_object('max_minutes', least(coalesce((vs->>'max_minutes')::int, 5), (lim->>'max_minutes')::int)),
    'agent', case when ag.inbox_id is null then null else to_jsonb(ag) - 'draft' end);
end $$;

-- Where the sync stores what it did. p_patch keys: account, el_agent_id, el_tool_ids, el_secret_id, tool_secret_hash,
-- config_hash, want_hash, synced (true = now), sync_error (null clears), archived, reset_attempts.
create or replace function outreach_webchat_v_voice_sync_done(p_inbox uuid, p_which text, p_patch jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_webchat_inboxes where id = p_inbox;
  if ws is null then return; end if;
  insert into outreach_webchat_voice_agents(inbox_id, which, workspace_id) values (p_inbox, p_which, ws) on conflict (inbox_id, which) do nothing;
  update outreach_webchat_voice_agents a set
      account = case when p_patch ? 'account' then case when p_patch->>'account' = 'own' then 'own' else 'platform' end else a.account end,
      el_agent_id = case when p_patch ? 'el_agent_id' then p_patch->>'el_agent_id' else a.el_agent_id end,
      el_tool_ids = case when p_patch ? 'el_tool_ids' then coalesce(p_patch->'el_tool_ids', '{}'::jsonb) else a.el_tool_ids end,
      el_secret_id = case when p_patch ? 'el_secret_id' then p_patch->>'el_secret_id' else a.el_secret_id end,
      tool_secret_hash = case when p_patch ? 'tool_secret_hash' then p_patch->>'tool_secret_hash' else a.tool_secret_hash end,
      config_hash = case when p_patch ? 'config_hash' then p_patch->>'config_hash' else a.config_hash end,
      want_hash = case when p_patch ? 'want_hash' then p_patch->>'want_hash' else a.want_hash end,
      archived = case when p_patch ? 'archived' then coalesce((p_patch->>'archived')::boolean, false) else a.archived end,
      synced_at = case when coalesce((p_patch->>'synced')::boolean, false) then now() else a.synced_at end,
      sync_error = case when p_patch ? 'sync_error' then left(p_patch->>'sync_error', 500) else a.sync_error end,
      sync_attempts = case when coalesce((p_patch->>'synced')::boolean, false) or coalesce((p_patch->>'reset_attempts')::boolean, false) then 0
                           when p_patch->>'sync_error' is not null then a.sync_attempts + 1 else a.sync_attempts end,
      next_sync_at = case when p_patch->>'sync_error' is not null then now() + make_interval(mins => power(2, least(a.sync_attempts, 5))::int) else null end,
      updated_at = now()
   where a.inbox_id = p_inbox and a.which = p_which;
end $$;

-- The websites the worker looks at: voice is (or was) on, or an agent exists. The worker compares hashes, so an
-- unchanged website costs one query and no call to the provider.
create or replace function outreach_webchat_voice_sync_due() returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_is_service() then '[]'::jsonb else coalesce((select jsonb_agg(jsonb_build_object('inbox_id', x.inbox_id, 'which', x.which)) from (
    select i.id as inbox_id, 'live'::text as which from outreach_webchat_inboxes i
     where i.deleted_at is null and (coalesce(i.settings#>>'{voice,enabled}', 'false') = 'true' or exists (select 1 from outreach_webchat_voice_agents a where a.inbox_id = i.id and a.which = 'live' and a.el_agent_id is not null and not a.archived))
    union all
    select a.inbox_id, 'test' from outreach_webchat_voice_agents a join outreach_webchat_inboxes i on i.id = a.inbox_id
     where a.which = 'test' and i.deleted_at is null and a.el_agent_id is not null) x), '[]'::jsonb) end
$$;

-- The Voice tab's draft: validated like a save, kept on the test agent's row until it is published or discarded.
create or replace function outreach_webchat_v_voice_draft(p_inbox uuid, p_draft jsonb) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select workspace_id into ws from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  if p_draft is not null and jsonb_typeof(p_draft) <> 'null' then
    perform outreach_webchat__voice_check(p_draft);
    if length(p_draft::text) > 20000 then raise exception 'E_PAYLOAD_INVALID: voice settings too large'; end if;
  end if;
  insert into outreach_webchat_voice_agents(inbox_id, which, workspace_id, draft, draft_at) values (p_inbox, 'test', ws, nullif(p_draft, 'null'::jsonb), now())
  on conflict (inbox_id, which) do update set draft = excluded.draft, draft_at = now(), updated_at = now();
end $$;

-- A test call from the Voice tab: no conversation, no visitor; it counts toward the minutes like any call.
create or replace function outreach_webchat_v_voice_test_started(p_inbox uuid, p_user uuid, p_el_conversation text, p_el_agent text, p_account text, p_language text, p_max_minutes int, p_page_url text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; cid uuid; pool jsonb; lim jsonb; n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  pool := outreach__voice_pool(i.workspace_id);
  if not coalesce((pool->>'ok')::boolean, false) then raise exception 'E_VOICE_MINUTES: this month''s voice minutes are used up'; end if;
  lim := outreach__voice_limits(i.workspace_id);
  update outreach_webchat_voice_calls set status = 'ended_unconfirmed', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'visitor'), next_poll_at = coalesce(next_poll_at, now() + interval '10 minutes')
   where inbox_id = i.id and test and started_by = p_user and status in ('starting', 'in_progress');
  select count(*) into n from outreach_webchat_voice_calls x where x.workspace_id = i.workspace_id and outreach_webchat__voice_live(x);
  if n >= (lim->>'concurrency')::int then raise exception 'E_VOICE_BUSY: every voice line of this workspace is in use'; end if;
  insert into outreach_webchat_voice_calls(workspace_id, inbox_id, el_conversation_id, el_agent_id, account, test, language, max_minutes, page_url, started_by)
  values (i.workspace_id, i.id, p_el_conversation, p_el_agent, case when p_account = 'own' then 'own' else 'platform' end, true, nullif(left(p_language, 12), ''),
          greatest(1, least(30, coalesce(p_max_minutes, 5))), nullif(left(p_page_url, 2000), ''), p_user)
  returning id into cid;
  return jsonb_build_object('call_id', cid);
end $$;

create or replace function outreach_webchat_v_voice_test_end(p_call uuid, p_user uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_voice_calls set status = 'ended_unconfirmed', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'visitor'), next_poll_at = coalesce(next_poll_at, now() + interval '2 minutes')
   where id = p_call and test and started_by = p_user and status in ('starting', 'in_progress') and outreach_is_service()
$$;

-- The scripted checks ran on a test call that never was a conversation at the provider: it closes without minutes.
create or replace function outreach_webchat_v_voice_sim_end(p_call uuid, p_user uuid) returns void
language sql security definer set search_path = public, extensions as $$
  update outreach_webchat_voice_calls set status = 'failed', ended_at = coalesce(ended_at, now()), ended_reason = coalesce(ended_reason, 'visitor'), finalized_at = now(), duration_s = 0
   where id = p_call and test and started_by = p_user and el_conversation_id like 'sim-%' and outreach_is_service()
$$;

-- A call as the recording proxy needs it (the edge function has checked the member; this returns the client for the scope check).
create or replace function outreach_webchat_v_voice_call(p_call uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when not outreach_is_service() then null else (
    select jsonb_build_object('id', k.id, 'workspace_id', k.workspace_id, 'client_id', i.client_id, 'inbox_id', k.inbox_id, 'el_conversation_id', k.el_conversation_id, 'account', k.account,
             'has_audio', k.has_audio, 'test', k.test, 'status', k.status)
      from outreach_webchat_voice_calls k join outreach_webchat_inboxes i on i.id = k.inbox_id where k.id = p_call) end
$$;

-- ===============================================================================================================
-- 6. Report + app RPCs
-- ===============================================================================================================
create or replace function outreach_webchat__voice_report(p_ws uuid, p_inbox uuid, f timestamptz, t timestamptz) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with inb as (
    select i.id from outreach_webchat_inboxes i where i.workspace_id = p_ws and (p_inbox is null or i.id = p_inbox) and outreach_client_visible(p_ws, i.client_id)),
  calls as (
    select k.* from outreach_webchat_voice_calls k where k.workspace_id = p_ws and k.inbox_id in (select id from inb) and k.started_at >= f and k.started_at < t and not k.test and k.status <> 'failed'),
  vis as (
    select count(*) n from outreach_webchat_visitors v where v.workspace_id = p_ws and v.inbox_id in (select id from inb) and v.last_seen_at >= f and v.first_seen_at < t)
  select jsonb_build_object(
    'calls', (select count(*) from calls),
    'minutes', (select coalesce(sum(ceil(coalesce(duration_s, 0) / 60.0)), 0)::int from calls),
    'avg_seconds', (select round(avg(duration_s))::int from calls where duration_s is not null),
    'per_100_visitors', (select case when vis.n > 0 then round((select count(*) from calls) * 100.0 / vis.n, 1) end from vis),
    'switched', (select count(*) from calls where ended_reason = 'switch'),
    'handed_off', (select count(*) from calls where ended_reason = 'handoff'),
    'handoff_reasons', (select coalesce(jsonb_object_agg(r, n), '{}'::jsonb) from (select coalesce(handoff_reason, 'other') r, count(*) n from calls where ended_reason = 'handoff' group by 1) x),
    'ended_by', (select coalesce(jsonb_object_agg(r, n), '{}'::jsonb) from (select coalesce(ended_reason, 'visitor') r, count(*) n from calls where ended_at is not null group by 1) x),
    'resolved', (select count(*) from calls where successful = 'success'),
    'judged', (select count(*) from calls where successful in ('success', 'failure')),
    'with_name', (select count(*) from calls where coalesce(collected->>'visitor_name', '') <> ''),
    'with_phone', (select count(*) from calls where coalesce(collected->>'visitor_phone', '') <> ''),
    'leads', (select count(distinct c.lead_id) from calls k join outreach_chats c on c.id = k.chat_id where c.lead_id is not null),
    'languages', (select coalesce(jsonb_object_agg(l, n), '{}'::jsonb) from (select coalesce(language, 'en') l, count(*) n from calls group by 1) x),
    'top_questions', (select coalesce(jsonb_agg(jsonb_build_object('query', q, 'n', n) order by n desc, q), '[]'::jsonb)
                        from (select left(x.query, 120) q, count(*) n from outreach_webchat_ai_turns x where x.voice_call_id in (select id from calls) and btrim(x.query) <> '' group by 1 order by 2 desc limit 10) y),
    'unanswered', (select coalesce(jsonb_agg(jsonb_build_object('query', q, 'n', n) order by n desc, q), '[]'::jsonb)
                     from (select left(x.query, 120) q, count(*) n from outreach_webchat_ai_turns x where x.voice_call_id in (select id from calls) and x.confidence = 'low' and btrim(x.query) <> '' group by 1 order by 2 desc limit 10) y),
    'cost_usd', case when outreach_role_in(p_ws) = 'owner' or outreach_is_service() then (select sum(cost_usd) from calls where account = 'own') end,
    'pool', outreach__voice_pool(p_ws))
$$;

-- The Voice tab: where the two agents stand, the draft, the minutes, what the plan allows and what voice still needs.
create or replace function outreach_hub_voice_state(p_inbox uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; st jsonb; lim jsonb; qa int; src int;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(i.workspace_id, 'member');
  if not outreach_client_visible(i.workspace_id, i.client_id) then raise exception 'E_NOT_FOUND'; end if;
  st := outreach_webchat__settings(i.id);
  lim := outreach__voice_limits(i.workspace_id);
  select count(*) into qa from outreach_master_prompt_faqs f where f.master_prompt_id is null and f.workspace_id = i.workspace_id and f.enabled and outreach_hub__qa_applies(f.id, 'website', i.id);
  select count(*) into src from outreach_knowledge_sources s where s.workspace_id = i.workspace_id and s.kind <> 'catalogue' and s.status = 'ready' and coalesce(st#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text;
  return jsonb_build_object(
    'inbox_id', i.id, 'account', outreach__voice_account(i.workspace_id), 'pool', outreach__voice_pool(i.workspace_id), 'limits', lim,
    'languages', to_jsonb(outreach_webchat__voice_languages(st, coalesce(st->'voice', '{}'::jsonb))),
    'agents', (select coalesce(jsonb_object_agg(a.which, jsonb_build_object('exists', a.el_agent_id is not null, 'account', a.account, 'synced_at', a.synced_at, 'sync_error', a.sync_error,
                         'sync_attempts', a.sync_attempts, 'archived', a.archived, 'draft_at', a.draft_at)), '{}'::jsonb) from outreach_webchat_voice_agents a where a.inbox_id = i.id),
    'draft', case when outreach_role_in(i.workspace_id) in ('owner', 'manager') then (select a.draft from outreach_webchat_voice_agents a where a.inbox_id = i.id and a.which = 'test') end,
    'requires', jsonb_build_object(
      'assistant_auto', i.ai_enabled and coalesce(st#>>'{ai,mode}', 'off') in ('first', 'offline_only'),
      'assistant_mode', case when i.ai_enabled then coalesce(st#>>'{ai,mode}', 'off') else 'off' end,
      'knowledge', src > 0 or qa >= 5, 'sources', src, 'qa_pairs', qa, 'active', i.is_active));
end $$;

-- Calls list (reports, the connector): newest first.
create or replace function outreach_hub_voice_calls(p_ws uuid, p_inbox uuid default null, p_from date default null, p_to date default null, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare f timestamptz := coalesce(p_from, (now() - interval '30 days')::date)::timestamptz; t timestamptz := (coalesce(p_to, now()::date) + 1)::timestamptz; owner_ boolean;
begin
  perform outreach_require(p_ws, 'client_viewer');
  owner_ := outreach_role_in(p_ws) = 'owner';
  return (select jsonb_build_object(
    'pool', outreach__voice_pool(p_ws),
    'total', (select count(*) from outreach_webchat_voice_calls k join outreach_webchat_inboxes i on i.id = k.inbox_id
               where k.workspace_id = p_ws and (p_inbox is null or k.inbox_id = p_inbox) and outreach_client_visible(p_ws, i.client_id) and k.started_at >= f and k.started_at < t and k.status <> 'failed'),
    'calls', coalesce((select jsonb_agg(x.j order by x.started_at desc) from (
      select k.started_at, jsonb_build_object('id', k.id, 'inbox_id', k.inbox_id, 'website', i.name, 'chat_id', k.chat_id, 'visitor_id', k.visitor_id, 'visitor_name', v.name, 'test', k.test, 'status', k.status,
               'started_at', k.started_at, 'ended_at', k.ended_at, 'ended_reason', k.ended_reason, 'handoff_reason', k.handoff_reason, 'duration_s', k.duration_s, 'language', k.language,
               'title', k.title, 'summary', k.summary, 'successful', k.successful, 'collected', k.collected, 'has_audio', k.has_audio, 'agent_turns', k.agent_turns, 'account', k.account,
               'cost_usd', case when owner_ and k.account = 'own' then k.cost_usd end) j
        from outreach_webchat_voice_calls k join outreach_webchat_inboxes i on i.id = k.inbox_id left join outreach_webchat_visitors v on v.id = k.visitor_id
       where k.workspace_id = p_ws and (p_inbox is null or k.inbox_id = p_inbox) and outreach_client_visible(p_ws, i.client_id) and k.started_at >= f and k.started_at < t and k.status <> 'failed'
       order by k.started_at desc limit greatest(1, least(coalesce(p_limit, 50), 200)) offset greatest(0, coalesce(p_offset, 0))) x), '[]'::jsonb)));
end $$;

-- ===============================================================================================================
-- 7. Patches to existing functions (in place)
-- ===============================================================================================================
-- ---- defaults (every key of the Voice tab; off)
select outreach_wv__patch('public.outreach_webchat_default_settings()', '"voice": {', array[
  $a$"shortcut": { "enabled": null }$a$,
  $b$"shortcut": { "enabled": null },
    "voice": {
      "enabled": false, "voice_id": null, "voice_name": null, "speed": 1.0, "stability": 0.5,
      "language": null, "languages": [], "auto_language": true, "hinglish": false,
      "greeting": {}, "instructions": "", "max_minutes": 5, "silence_end_s": 20, "model": "fast", "tool_sound": "typing",
      "collect": ["name", "phone", "need"], "record": true, "retention_days": 30, "consent_text": null,
      "ui": { "start_text": "Talk to us", "start_hint": "Speak with our AI assistant", "orb_1": null, "orb_2": "#c7a3ff", "avatar": "logo", "labels": {}, "captions": true,
              "show_on": { "home": true, "composer": true, "launcher": false } }
    }$b$]);

-- ---- validation on save
select outreach_wv__patch('public.outreach_webchat__settings_check(jsonb)', 'outreach_webchat__voice_check', array[
  $a$  perform outreach_webchat__buttons_check(ns);$a$,
  $b$  perform outreach_webchat__buttons_check(ns);
  perform outreach_webchat__voice_check(ns->'voice');
  if ns#>>'{security,rate_limits,voice_1h}' is not null and ((ns#>>'{security,rate_limits,voice_1h}') !~ '^[0-9]{1,3}$' or (ns#>>'{security,rate_limits,voice_1h}')::int not between 1 and 100) then raise exception 'E_PAYLOAD_INVALID: security.rate_limits.voice_1h is 1 to 100'; end if;$b$]);

-- ---- what the widget reads
select outreach_wv__patch('public.outreach_webchat_public_config(text,text)', 'outreach_webchat__voice_public', array[
  $a$'selection_ask', st->'selection_ask', 'shortcut', st->'shortcut');$a$,
  $b$'selection_ask', st->'selection_ask', 'shortcut', st->'shortcut', 'voice', outreach_webchat__voice_public(i.id, st));$b$]);

-- ---- typed and spoken messages share the handoff words
select outreach_wv__patch('public.outreach_webchat_v_message(uuid,uuid,text,text,jsonb,text,jsonb,text)', 'outreach_webchat__handoff_match', array[
  $a$    foreach kw in array (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(coalesce(st#>'{ai,handoff,keywords}', '[]'::jsonb)) x) loop$a$,
  $b$    if outreach_webchat__handoff_match(st, txt) then handoff := true; end if;$b$,
  $a$      if kw <> '' and position(lower(kw) in lower(txt)) > 0 then handoff := true; end if;
$a$, $b$$b$,
  $a$    end loop;
$a$, $b$$b$,
  $a$    if txt ~* '\m(talk|speak|chat) (to|with) (a |an |someone|the )?(person|human|agent|rep|team|someone)\M' or txt ~* '\m(real|live) (person|human|agent)\M' then handoff := true; end if;
$a$, $b$$b$]);

-- ---- the website report gets its Voice block
select outreach_wv__patch('public.outreach_webchat_report(uuid,uuid,date,date)', 'outreach_webchat__voice_report', array[
  $a$      'products', outreach_webchat__products_report(p_ws, p_inbox, f, t),$a$,
  $b$      'products', outreach_webchat__products_report(p_ws, p_inbox, f, t),
      'voice', outreach_webchat__voice_report(p_ws, p_inbox, f, t),$b$]);

-- ---- the workspace's keys screen says whether a voice key is saved (never the key)
do $$ begin
  if to_regprocedure('public.outreach_workspace_ai_settings(uuid)') is not null then
    perform outreach_wv__patch('public.outreach_workspace_ai_settings(uuid)', 'elevenlabs_key_hint', array[
      $a$'uses_own_key', r.llm_key_enc is not null,$a$,
      $b$'uses_own_key', r.llm_key_enc is not null,
    'elevenlabs_key_hint', (select x.elevenlabs_key_hint from outreach_workspace_secrets x where x.workspace_id = p_ws and x.elevenlabs_key_enc is not null),
    'voice_own_key_allowed', coalesce((outreach__voice_limits(p_ws)->>'own_key')::boolean, false),$b$]);
  end if;
end $$;

-- ===============================================================================================================
-- 8. Grants
-- ===============================================================================================================
do $$
declare f record;
  app_fns text[] := array['outreach_hub_voice_state', 'outreach_hub_voice_calls'];
  svc_fns text[] := array[
    'outreach_webchat_trg_voice_agent_gone', 'outreach_webchat_trg_voice_call_gone', 'outreach_webchat_trg_voice_chat_gone', 'outreach_webchat_trg_voice_inbox_gone',
    'outreach_webchat__voice_langs', 'outreach__voice_limits', 'outreach__voice_account', 'outreach__voice_pool', 'outreach_voice_grant',
    'outreach_webchat__voice_check', 'outreach_webchat__voice_languages', 'outreach_webchat__voice_ready', 'outreach_webchat__voice_public', 'outreach_webchat__handoff_match',
    'outreach_webchat__voice_live', 'outreach_webchat__voice_card', 'outreach_webchat__voice_close', 'outreach_webchat__voice_own',
    'outreach_webchat_v_voice_start', 'outreach_webchat_v_voice_started', 'outreach_webchat_v_voice_turns', 'outreach_webchat_v_voice_switch', 'outreach_webchat_v_voice_end',
    'outreach_webchat_v_voice_tool', 'outreach_webchat_v_voice_email_state', 'outreach_webchat_v_voice_search_done', 'outreach_webchat_v_voice_contact', 'outreach_webchat_v_voice_finalize',
    'outreach_webchat_voice_poll_due', 'outreach_webchat_voice_poll_gone', 'outreach_webchat_voice_cleanup_due', 'outreach_webchat_voice_cleanup_done', 'outreach_webchat_voice_cleanup_add',
    'outreach_webchat_v_voice_sync_ctx', 'outreach_webchat_v_voice_sync_done', 'outreach_webchat_voice_sync_due', 'outreach_webchat_v_voice_draft',
    'outreach_webchat_v_voice_test_started', 'outreach_webchat_v_voice_test_end', 'outreach_webchat_v_voice_sim_end', 'outreach_webchat_v_voice_call', 'outreach_webchat__voice_report'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname = any(app_fns) or p.proname = any(svc_fns)) loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
-- the settings check runs inside outreach_webchat_inbox_update (security definer); the functions the report and the
-- public config call run as their definer too, so nothing else needs `authenticated`.

drop function if exists outreach_wv__patch(text, text, text[]);
