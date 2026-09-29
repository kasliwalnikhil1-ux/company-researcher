-- 035 — AI replies: tables, columns, indexes, RLS (ai-auto-reply-PRD.md §11, docs/outreach/AI-REPLIES-CONTRACT.md §2).
-- Needs 034 committed first. Idempotent.
--
--   outreach_master_prompts / _versions   the one prompt that decides how the AI replies (workspace → client → sequence)
--   outreach_reply_policies               mode, timing and caps per workspace / client / sequence / sender (null = inherit)
--   outreach_ai_reply_consent / _links    sender-owner consent for autopilot (signed link or owner-is-operator)
--   outreach_ai_reply_runs                one run per inbound burst; also the work queue (no pgmq on this project)
--   outreach_ai_reply_scenarios           the simulator's regression set
--   outreach_ai_reply_workspace           platform-admin switches: graduation bypass, monthly draft allowance
--   chats / messages                      stage + autopilot state, message origin + extended classification

-- ----------------------------------------------------------------------------- master prompts
create table if not exists outreach_master_prompts (
  id                   uuid primary key default gen_random_uuid(),
  workspace_id         uuid not null references outreach_workspaces(id) on delete cascade,
  scope                text not null check (scope in ('workspace','client','sequence')),
  scope_id             uuid,
  editor_mode          text not null default 'guided' check (editor_mode in ('guided','raw')),
  version              int  not null default 1,
  body                 text not null check (length(body) between 1 and 40000),
  sections             jsonb,
  settings             jsonb not null default '{}'::jsonb,
  substantive_version  int  not null default 1,          -- latest version whose change was substantive (consent + graduation reset)
  substantive_at       timestamptz not null default now(),
  graduated_at         timestamptz,                      -- autopilot unlocked for this prompt (§16.2), refreshed daily
  graduation           jsonb,
  graduation_checked_at timestamptz,
  created_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id) on delete set null,
  updated_at           timestamptz not null default now(),
  check ((scope = 'workspace') = (scope_id is null))
);
create unique index if not exists outreach_master_prompts_scope_uq
  on outreach_master_prompts(workspace_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

create table if not exists outreach_master_prompt_versions (
  master_prompt_id uuid not null references outreach_master_prompts(id) on delete cascade,
  version          int  not null,
  editor_mode      text not null check (editor_mode in ('guided','raw')),
  body             text not null,
  sections         jsonb,
  settings         jsonb not null,
  change_kind      text not null check (change_kind in ('style','substantive')),
  note             text,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  primary key (master_prompt_id, version)
);

-- ----------------------------------------------------------------------------- reply policies (null = inherit)
create table if not exists outreach_reply_policies (
  id                          uuid primary key default gen_random_uuid(),
  workspace_id                uuid not null references outreach_workspaces(id) on delete cascade,
  scope                       text not null check (scope in ('workspace','client','sequence','sender')),
  scope_id                    uuid,
  mode                        outreach_reply_mode_t,
  delay_min_s                 int check (delay_min_s between 60 and 3600),
  delay_max_s                 int check (delay_max_s between 61 and 3600),
  debounce_quiet_s            int check (debounce_quiet_s between 30 and 600),
  debounce_max_s              int check (debounce_max_s between 60 and 1800),
  max_ai_sends_per_sender_day int check (max_ai_sends_per_sender_day between 1 and 40),
  stale_after_h               int check (stale_after_h between 1 and 72),
  human_takeover_pause_h      int check (human_takeover_pause_h between 1 and 720),
  disclosure                  text check (disclosure is null or length(disclosure) between 1 and 200),
  blocked_countries           text[],
  downgraded_at               timestamptz,                -- set by the breakers (§10.3); re-enabling autopilot needs a note
  downgrade_reason            text,
  breaker_reset_at            timestamptz,                -- autopilot (re-)enabled: the breakers only judge holds after this
  note                        text,
  updated_by                  uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now(),
  check ((scope = 'workspace') = (scope_id is null)),
  check (delay_min_s is null or delay_max_s is null or delay_max_s > delay_min_s),
  check (debounce_quiet_s is null or debounce_max_s is null or debounce_max_s >= debounce_quiet_s)
);
create unique index if not exists outreach_reply_policies_scope_uq
  on outreach_reply_policies(workspace_id, scope, coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ----------------------------------------------------------------------------- consent
create table if not exists outreach_ai_reply_consent (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id             uuid not null references outreach_senders(id) on delete cascade,
  master_prompt_id      uuid not null references outreach_master_prompts(id) on delete cascade,
  master_prompt_version int  not null,
  granted_by_email      citext not null,
  granted_via           text not null check (granted_via in ('signed_link','owner_is_operator')),
  scope                 jsonb not null,                   -- {daily_cap, delay_min_s, delay_max_s} shown when granted
  evidence              jsonb not null default '{}'::jsonb,
  granted_at            timestamptz not null default now(),
  expires_at            timestamptz not null,
  revoked_at            timestamptz,
  revoked_reason        text,
  revoke_token_hash     text unique
);
create unique index if not exists outreach_ai_reply_consent_live_uq on outreach_ai_reply_consent(sender_id, master_prompt_id) where revoked_at is null;

create table if not exists outreach_ai_reply_consent_links (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  sender_id             uuid not null references outreach_senders(id) on delete cascade,
  master_prompt_id      uuid not null references outreach_master_prompts(id) on delete cascade,
  master_prompt_version int  not null,
  email                 citext,
  token_hash            text not null unique,
  scope                 jsonb not null,
  examples              jsonb not null default '[]'::jsonb,
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null default now() + interval '7 days',
  used_at               timestamptz,
  cancelled_at          timestamptz
);
create index if not exists outreach_ai_reply_consent_links_sender_idx on outreach_ai_reply_consent_links(sender_id, created_at desc);

-- ----------------------------------------------------------------------------- runs
create table if not exists outreach_ai_reply_runs (
  id                    uuid primary key default gen_random_uuid(),
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  client_id             uuid,
  chat_id               uuid not null references outreach_chats(id) on delete cascade,
  sender_id             uuid not null references outreach_senders(id) on delete cascade,
  lead_id               uuid references outreach_leads(id) on delete set null,
  sequence_id           uuid references outreach_sequences(id) on delete set null,
  provider              outreach_provider_t,
  inbound_message_ids   uuid[] not null,
  followup_inbound_ids  uuid[] not null default '{}',     -- inbound that arrived while this run was sending (§6.2 case 3)
  debounce_until        timestamptz not null,
  debounce_hard_until   timestamptz not null,
  attempts              smallint not null default 0,      -- draft attempts
  send_attempts         smallint not null default 0,      -- dispatch attempts (only rate-limit refusals are retried)
  next_attempt_at       timestamptz,
  mode                  outreach_reply_mode_t,
  policy_snapshot       jsonb,
  master_prompt_id      uuid references outreach_master_prompts(id) on delete set null,
  master_prompt_version int,
  floor_sha256          text,
  model                 text,
  status                outreach_ai_reply_status_t not null default 'debouncing',
  decision              outreach_ai_reply_decision_t,
  intent                outreach_intent_t,
  flags                 text[] not null default '{}',
  language              text,
  stage_before          text,
  stage_after           text,
  move                  text,
  rule_applied          text,
  side_effects          jsonb,
  draft_confidence      real,
  draft_text            text,
  final_text            text,
  facts_used            jsonb,
  validator             jsonb,
  verifier              jsonb,
  redrafts              smallint not null default 0,
  gate_failures         text[] not null default '{}',
  escalation_reasons    text[] not null default '{}',
  context               jsonb,
  scheduled_send_at     timestamptz,
  sent_message_id       uuid references outreach_messages(id) on delete set null,
  action_id             uuid references outreach_actions(id) on delete set null,
  sent_origin           text,
  dispatched_by         uuid references auth.users(id) on delete set null,
  cancelled_by          uuid references auth.users(id) on delete set null,
  cancel_reason         text,
  cancel_note           text,
  edit_distance         real,
  facts_changed         boolean,
  reply_latency_s       int,
  drew_bot_question     boolean not null default false,
  drew_hostile          boolean not null default false,
  error                 text,
  timings               jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create unique index if not exists outreach_ai_reply_one_active_per_chat on outreach_ai_reply_runs(chat_id)
  where status in ('debouncing','drafting','draft_ready','scheduled','sending');
create index if not exists outreach_ai_reply_runs_due_idx on outreach_ai_reply_runs(debounce_until) where status = 'debouncing';
create index if not exists outreach_ai_reply_runs_sched_idx on outreach_ai_reply_runs(scheduled_send_at) where status = 'scheduled';
create index if not exists outreach_ai_reply_runs_ws_idx on outreach_ai_reply_runs(workspace_id, created_at desc);
create index if not exists outreach_ai_reply_runs_chat_idx on outreach_ai_reply_runs(chat_id, created_at desc);
create index if not exists outreach_ai_reply_runs_sender_idx on outreach_ai_reply_runs(sender_id, created_at desc);
create index if not exists outreach_ai_reply_runs_seq_idx on outreach_ai_reply_runs(sequence_id, created_at desc) where sequence_id is not null;
create index if not exists outreach_ai_reply_runs_mp_idx on outreach_ai_reply_runs(master_prompt_id, created_at desc) where master_prompt_id is not null;

-- ----------------------------------------------------------------------------- scenarios (regression set)
create table if not exists outreach_ai_reply_scenarios (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  master_prompt_id uuid references outreach_master_prompts(id) on delete cascade,
  name             text not null check (length(name) between 1 and 120),
  turns            jsonb not null,
  expected         jsonb not null default '[]'::jsonb,
  last_result      jsonb,
  last_version     int,
  last_run_at      timestamptz,
  passed           boolean,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists outreach_ai_reply_scenarios_ws_idx on outreach_ai_reply_scenarios(workspace_id, created_at);

-- ----------------------------------------------------------------------------- platform-admin switches
create table if not exists outreach_ai_reply_workspace (
  workspace_id      uuid primary key references outreach_workspaces(id) on delete cascade,
  graduation_bypass boolean not null default false,
  monthly_limit     int check (monthly_limit is null or monthly_limit >= 0),
  note              text,
  updated_by        uuid references auth.users(id) on delete set null,
  updated_at        timestamptz not null default now()
);

-- columns added after the first draft of this file (create table if not exists does not add them to an existing table)
alter table outreach_reply_policies add column if not exists breaker_reset_at timestamptz;
alter table outreach_ai_reply_runs  add column if not exists send_attempts smallint not null default 0;

-- ----------------------------------------------------------------------------- chats / messages
alter table outreach_chats
  add column if not exists reply_mode_override     outreach_reply_mode_t,
  add column if not exists autopilot_state         text not null default 'active',
  add column if not exists autopilot_paused_until  timestamptz,
  add column if not exists autopilot_paused_reason text,
  add column if not exists conversation_stage      text,
  add column if not exists conversation_exchanges  int not null default 0,
  add column if not exists ai_replies_count        int not null default 0,
  add column if not exists last_ai_move            text,
  add column if not exists stage_stale             boolean not null default false,
  add column if not exists is_group                boolean not null default false,
  add column if not exists ai_run_id               uuid,
  add column if not exists ai_run_status           text,
  add column if not exists ai_escalation_reason    text,
  add column if not exists ai_scheduled_send_at    timestamptz,
  add column if not exists ai_run_decision         text;
do $$ begin
  alter table outreach_chats add constraint outreach_chats_autopilot_state_chk
    check (autopilot_state in ('active','paused_human','paused_escalated','paused_bot'));
exception when duplicate_object then null; end $$;
create index if not exists outreach_chats_ai_status_idx on outreach_chats(workspace_id, ai_run_status) where ai_run_status is not null;
create index if not exists outreach_chats_stage_idx on outreach_chats(workspace_id, conversation_stage) where conversation_stage is not null;

alter table outreach_messages
  add column if not exists origin          text not null default 'unknown',
  add column if not exists ai_reply_run_id uuid references outreach_ai_reply_runs(id) on delete set null,
  add column if not exists ai_flags        text[] not null default '{}',
  add column if not exists classification  jsonb,
  add column if not exists text_sha256     text;
do $$ begin
  alter table outreach_messages add constraint outreach_messages_origin_chk
    check (origin in ('prospect','sequence','inbox_user','ai_autopilot','ai_draft_sent','ai_edited','external_device','unknown'));
exception when duplicate_object then null; end $$;
create index if not exists outreach_messages_run_idx on outreach_messages(ai_reply_run_id) where ai_reply_run_id is not null;
create index if not exists outreach_messages_sha_idx on outreach_messages(chat_id, text_sha256) where direction = 'out';

-- ----------------------------------------------------------------------------- RLS
alter table outreach_master_prompts           enable row level security;
alter table outreach_master_prompt_versions   enable row level security;
alter table outreach_reply_policies           enable row level security;
alter table outreach_ai_reply_consent         enable row level security;   -- no policies: RPCs only (revoke hashes, owner emails)
alter table outreach_ai_reply_consent_links   enable row level security;   -- no policies: service role only (token hashes)
alter table outreach_ai_reply_runs            enable row level security;
alter table outreach_ai_reply_scenarios       enable row level security;
alter table outreach_ai_reply_workspace       enable row level security;   -- no policies: platform-admin RPCs only

-- the client a prompt / policy scope belongs to (null for workspace). Used by the read policies below, so signed-in users
-- may execute it; it only reveals the client id of an entity whose id the caller already has.
create or replace function outreach_ai_scope_client_of(p_scope text, p_scope_id uuid) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select case p_scope
    when 'client' then p_scope_id
    when 'sequence' then (select client_id from outreach_sequences where id = p_scope_id)
    when 'sender' then (select client_id from outreach_senders where id = p_scope_id)
  end
$$;

-- reads only; every write goes through a security-definer RPC or the service role. Client-scoped like every outreach table:
-- a member limited to client A never reads client B's prompts (facts, prices), versions, policies or scenarios.
drop policy if exists mp_select on outreach_master_prompts;
create policy mp_select on outreach_master_prompts for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member')
         and outreach_client_visible(workspace_id, outreach_ai_scope_client_of(scope, scope_id)));
drop policy if exists mpv_select on outreach_master_prompt_versions;
create policy mpv_select on outreach_master_prompt_versions for select
  using (exists (select 1 from outreach_master_prompts mp_ where mp_.id = master_prompt_id
                  and mp_.workspace_id in (select outreach_workspace_ids()) and outreach_role_in(mp_.workspace_id) in ('owner','manager','member')
                  and outreach_client_visible(mp_.workspace_id, outreach_ai_scope_client_of(mp_.scope, mp_.scope_id))));
drop policy if exists rp_select on outreach_reply_policies;
create policy rp_select on outreach_reply_policies for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member')
         and outreach_client_visible(workspace_id, outreach_ai_scope_client_of(scope, scope_id)));
drop policy if exists runs_select on outreach_ai_reply_runs;
create policy runs_select on outreach_ai_reply_runs for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, client_id));
drop policy if exists scen_select on outreach_ai_reply_scenarios;
create policy scen_select on outreach_ai_reply_scenarios for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member')
         and (master_prompt_id is null or exists (select 1 from outreach_master_prompts mp_ where mp_.id = master_prompt_id
                and outreach_client_visible(mp_.workspace_id, outreach_ai_scope_client_of(mp_.scope, mp_.scope_id)))));

-- The inbox may update chats directly (assign, archive, read …), but the AI columns are engine / RPC state: a direct write
-- could switch a chat to autopilot, lift a safety pause or reset the per-chat reply limit. Only security-definer RPCs
-- (current_user = their owner) and the service role may change them.
create or replace function outreach_trg_chat_ai_guard() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.reply_mode_override is distinct from old.reply_mode_override or new.autopilot_state is distinct from old.autopilot_state
    or new.autopilot_paused_until is distinct from old.autopilot_paused_until or new.autopilot_paused_reason is distinct from old.autopilot_paused_reason
    or new.conversation_stage is distinct from old.conversation_stage or new.conversation_exchanges is distinct from old.conversation_exchanges
    or new.ai_replies_count is distinct from old.ai_replies_count or new.last_ai_move is distinct from old.last_ai_move
    or new.stage_stale is distinct from old.stage_stale or new.is_group is distinct from old.is_group
    or new.ai_run_id is distinct from old.ai_run_id or new.ai_run_status is distinct from old.ai_run_status or new.ai_run_decision is distinct from old.ai_run_decision
    or new.ai_escalation_reason is distinct from old.ai_escalation_reason or new.ai_scheduled_send_at is distinct from old.ai_scheduled_send_at) then
    raise exception 'E_FORBIDDEN: AI reply settings of a chat change through the AI menu only';
  end if;
  return new;
end $$;
drop trigger if exists outreach_chats_ai_guard on outreach_chats;
create trigger outreach_chats_ai_guard before update on outreach_chats for each row execute function outreach_trg_chat_ai_guard();

-- the inbox banner and the activity log follow runs live
do $$ begin
  alter publication supabase_realtime add table outreach_ai_reply_runs;
exception when duplicate_object then null; when undefined_object then null; end $$;

-- ----------------------------------------------------------------------------- ledger: ai_reply ceiling (§10.1)
-- 40/day is the hard ceiling; the policy's max_ai_sends_per_sender_day (default 25, ≤ 40) is the working cap, and
-- message + reply + ai_reply stay under 100 a day per sender (checked in outreach_ai_reply_prepare_send).
insert into outreach_platform_ceilings(provider, action_type, per_day, per_week)
select 'LINKEDIN', 'ai_reply', 40, null
where not exists (select 1 from outreach_platform_ceilings where provider = 'LINKEDIN' and action_type = 'ai_reply');

-- breaker notices are alerts (deduped by the open-alert unique index). Extend the kind list read from the live constraint,
-- so kinds other migrations added are kept.
do $$
declare def text; kinds text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conname = 'outreach_alerts_kind_check' and conrelid = 'outreach_alerts'::regclass;
  if def is not null and position('ai_reply_too_early' in def) = 0 then
    select array_agg(m[1]) into kinds from regexp_matches(def, '''([a-z_]+)''', 'g') m;
    kinds := kinds || array['ai_reply_too_early', 'ai_reply_downgraded'];
    alter table outreach_alerts drop constraint outreach_alerts_kind_check;
    execute format('alter table outreach_alerts add constraint outreach_alerts_kind_check check (kind = any (%L::text[]))', kinds);
  end if;
end $$;

-- platform default monthly AI draft allowance per workspace on the platform key (null = unlimited)
insert into outreach_flags(key, value) values ('ai_reply_monthly_limit', 'null'::jsonb) on conflict (key) do nothing;
