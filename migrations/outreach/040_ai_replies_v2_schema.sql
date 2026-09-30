-- 040 — AI replies v2: schema + backfill (ai-replies-changes.md §1–§9, §12; docs/outreach/AI-REPLIES-V2-CONTRACT.md §2).
-- Needs 039 committed. Apply 040 and 041 in ONE call: between them the v1.1 resolver still reads the columns this file
-- drops / renames (enqueue would fail and log until 041 replaces it). Idempotent.
--
--   outreach_sequence_reply_settings     the one place AI replies are configured: per sequence
--   outreach_workspace_reply_settings    per-sender daily cap + the default prompt for new sequences
--   outreach_master_prompts              scope sequence | library; sequence_id; name; copied_from; knowledge links
--   outreach_master_prompt_scenarios     situation cards ("Scenarios") compiled into ## Situations
--   outreach_master_prompt_faqs          Q&A pairs
--   outreach_knowledge_sources/_chunks   website / document / text knowledge, full-text retrieval
--   outreach_ai_unanswered_questions     questions the AI could not answer, grouped
--   outreach_lead_ai_notes (+ queue)     key facts per lead
--   outreach_scheduling_domains          calendar hosts: a link to one of these hands the conversation off (T3)
--   chats / runs / tasks / messages      handoff, sessions, manual runs, task source, translation cache

create extension if not exists pg_trgm;

-- ============================================================================= prompt compiler v2 (pure; the backfill needs it)
-- Guided sections + stage table (+ scenario cards) → the one prompt the model reads. Order: Who I am · How a conversation goes ·
-- Situations · Hand to a person when · Stop when · Facts I can use · Style. Cards replace the free-text Situations when given.
create or replace function outreach__compile_master_prompt(p_sections jsonb, p_settings jsonb, p_scenarios jsonb default null) returns text
language plpgsql immutable set search_path = public, extensions as $$
declare s jsonb := coalesce(p_sections, '{}'::jsonb); st jsonb; i int := 0; stages text := ''; sit text; card jsonb;
begin
  for st in select x from jsonb_array_elements(coalesce(p_settings->'stages', '[]'::jsonb)) x loop
    i := i + 1;
    stages := stages || format(E'Stage %s · %s%s\n%s\n\n', i, coalesce(st->>'label', st->>'key'),
      case when coalesce((st->>'pitch')::boolean, false) then ' (pitch)' when coalesce((st->>'early')::boolean, false) then ' (early)' else '' end,
      coalesce(nullif(btrim(st->>'instructions'), ''), '-'));
  end loop;
  if p_scenarios is not null and jsonb_typeof(p_scenarios) = 'array' and jsonb_array_length(p_scenarios) > 0 then
    sit := '';
    for card in select x from jsonb_array_elements(p_scenarios) x where coalesce((x->>'enabled')::boolean, true) loop
      sit := sit || format(E'- %s: when %s → %s\n', btrim(coalesce(card->>'title', 'Situation')), btrim(coalesce(card->>'when_text', card->>'when', '')), btrim(coalesce(card->>'do_text', card->>'do', '')));
    end loop;
    sit := nullif(btrim(sit), '');
  end if;
  sit := coalesce(sit, nullif(btrim(s->>'situations'), ''), '-');
  return btrim(concat_ws(E'\n\n',
    E'## Who I am\n' || coalesce(nullif(btrim(s->>'who'), ''), '-'),
    E'## How a conversation goes\n' || coalesce(nullif(btrim(s->>'flow'), ''), '-') || case when stages <> '' then E'\n\n' || btrim(stages) else '' end,
    E'## Situations\n' || sit,
    E'## Hand to a person when\n' || coalesce(nullif(btrim(s->>'handoff'), ''), '-'),
    case when nullif(btrim(s->>'stop'), '') is not null then E'## Stop when\n' || btrim(s->>'stop') end,
    E'## Facts I can use\n' || coalesce(nullif(btrim(s->>'facts'), ''), '-'),
    E'## Style\n' || coalesce(nullif(btrim(s->>'style'), ''), '-')));
end $$;

create or replace function outreach__mp_default_stop() returns text
language sql immutable set search_path = public, extensions as $$
  select E'Stop replying after any of these. A person takes over from there.\n- I''ve shared my calendar link, or we''ve agreed a meeting time.\n- They say they''re interested and want to talk, and I''ve told them how to book.\n- They ask to speak to someone directly.'
$$;

create or replace function outreach__mp_default_gap_block() returns text
language sql immutable set search_path = public, extensions as $$
  select E'Coming back after a gap\n- A few days later: pick up naturally, no apology, answer what they wrote now.\n- Over a month later (Re-engage): acknowledge it lightly, recap in one line what we discussed, ask what''s changed on their side. Don''t restart discovery or re-pitch unless they ask.'
$$;

create or replace function outreach__mp_default_sections() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_object(
    'who', E'I''m {{sender.first_name}}, {{sender.role}} at <my company>. <One line on what we do and for whom.>',
    'flow', E'Move through these stages like a person would. Don''t pitch in the first replies unless they ask.\nSkip ahead when they ask what we do, ask the price, ask for a call, or say they want the service. Go straight to the stage that answers them.\n\n' || outreach__mp_default_gap_block(),
    'situations', E'- They ask the price → <e.g. "Share that projects start at ₹X" OR "Say pricing depends on scope and offer a 15-min call; no numbers">\n- They propose a meeting time → accept if it fits my availability; otherwise offer two times from it.\n- "Not now" / later → thank them, ask if I can check back in <month>; no pitch. Create a follow-up task for that date.\n- Not interested → don''t reply. Archive.\n- Wrong person, they name someone → thank them, say I''ll reach out to that person. Create a task with the contact exactly as they wrote it.\n- Out-of-office → don''t reply.\n- Just "Thanks" / 👍 after my last message → don''t reply.',
    'handoff', E'- They mention a contract, invoice, NDA, discount or legal terms.\n- They''re upset or complaining.\n- They ask something not covered by "Facts I can use".\n- <anything else>',
    'stop', outreach__mp_default_stop(),
    'facts', E'- <Offer, turnaround, clients/proof points, prices if I want the AI to share them, links>',
    'style', E'- 1–3 short sentences. LinkedIn chat: no subject, no signature.\n- Match their language and register (English / Hinglish).\n- No exclamation marks unless they used them. No em dashes. Never "I hope this finds you well".')
$$;

-- the template's scenario cards (§9.1)
create or replace function outreach__mp_default_scenarios() returns jsonb
language sql immutable set search_path = public, extensions as $$
  select jsonb_build_array(
    jsonb_build_object('title', 'Pricing question', 'when_text', 'They ask what it costs, rates, budget, or a quote', 'do_text', 'Say <projects start at ₹X for a 30-second film> OR say pricing depends on scope; offer a 15-min call for an exact quote. Never invent a number.', 'enabled', true),
    jsonb_build_object('title', 'Meeting time proposed', 'when_text', 'They suggest a day or time to talk', 'do_text', 'Accept if it fits <my availability>; otherwise offer two times from it. Share the calendar link if I have one.', 'enabled', true),
    jsonb_build_object('title', 'Not now', 'when_text', 'They say later, next quarter, or that the timing is wrong', 'do_text', 'Thank them, ask if I can check back in <month>; no pitch. Create a follow-up task for that date.', 'enabled', true),
    jsonb_build_object('title', 'Not interested', 'when_text', 'They say no, not relevant, or please stop', 'do_text', 'Don''t reply. Archive the conversation.', 'enabled', true),
    jsonb_build_object('title', 'Wrong person', 'when_text', 'They say someone else handles this and name them', 'do_text', 'Thank them, say I''ll reach out to that person. Create a task with the contact exactly as they wrote it.', 'enabled', true),
    jsonb_build_object('title', 'Out of office', 'when_text', 'An automatic out-of-office or holiday reply', 'do_text', 'Don''t reply.', 'enabled', true),
    jsonb_build_object('title', 'Just "thanks"', 'when_text', 'A bare thanks, 👍 or ok after my last message, with no question', 'do_text', 'Don''t reply.', 'enabled', true))
$$;

create or replace function outreach_master_prompt_template() returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('editor_mode', 'guided', 'sections', outreach__mp_default_sections(), 'settings', outreach__mp_default_settings(),
                            'scenarios', outreach__mp_default_scenarios(),
                            'body', outreach__compile_master_prompt(outreach__mp_default_sections(), outreach__mp_default_settings(), outreach__mp_default_scenarios()))
$$;

-- ============================================================================= master prompts: sequence | library
alter table outreach_master_prompts
  add column if not exists sequence_id           uuid references outreach_sequences(id) on delete cascade,
  add column if not exists name                  text,
  add column if not exists copied_from_prompt_id uuid references outreach_master_prompts(id) on delete set null,
  add column if not exists copied_from_version   int,
  add column if not exists knowledge_source_ids  uuid[] not null default '{}';
do $$
declare c record;
begin
  -- the v1.1 checks (scope in (workspace, client, sequence); (scope = workspace) = (scope_id is null)) go
  for c in select conname from pg_constraint where conrelid = 'outreach_master_prompts'::regclass and contype = 'c'
            and pg_get_constraintdef(oid) ilike '%scope%' loop
    execute format('alter table outreach_master_prompts drop constraint %I', c.conname);
  end loop;
end $$;
drop index if exists outreach_master_prompts_scope_uq;
update outreach_master_prompts set sequence_id = scope_id where scope = 'sequence' and sequence_id is null;

alter table outreach_master_prompt_versions
  add column if not exists scenarios jsonb,
  add column if not exists faqs      jsonb;

create table if not exists outreach_master_prompt_scenarios (
  id               uuid primary key default gen_random_uuid(),
  master_prompt_id uuid not null references outreach_master_prompts(id) on delete cascade,
  position         int  not null default 0,
  title            text not null check (char_length(title) between 1 and 80),
  when_text        text not null check (char_length(when_text) between 1 and 500),
  do_text          text not null check (char_length(do_text) between 1 and 1500),
  enabled          boolean not null default true,
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now()
);
create index if not exists outreach_master_prompt_scenarios_mp_idx on outreach_master_prompt_scenarios(master_prompt_id, position);

create table if not exists outreach_master_prompt_faqs (
  id               uuid primary key default gen_random_uuid(),
  master_prompt_id uuid not null references outreach_master_prompts(id) on delete cascade,
  question         text not null check (char_length(question) between 1 and 500),
  answer           text not null check (char_length(answer) between 1 and 2000),
  source           text not null default 'manual' check (source in ('manual','unanswered','import')),
  enabled          boolean not null default true,
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now()
);
create index if not exists outreach_master_prompt_faqs_mp_idx on outreach_master_prompt_faqs(master_prompt_id) where enabled;

-- ============================================================================= sequence + workspace settings
create table if not exists outreach_sequence_reply_settings (
  sequence_id             uuid primary key references outreach_sequences(id) on delete cascade,
  workspace_id            uuid not null references outreach_workspaces(id) on delete cascade,
  mode                    outreach_reply_mode_t not null default 'draft',
  master_prompt_id        uuid references outreach_master_prompts(id) on delete set null,
  pitch_after_replies     smallint not null default 2  check (pitch_after_replies between 0 and 5),
  max_ai_replies_per_chat smallint not null default 6  check (max_ai_replies_per_chat between 1 and 10),
  warmup_remaining        smallint not null default 20 check (warmup_remaining >= 0),
  handoff_stage_id        uuid references outreach_stages(id) on delete set null,
  delay_min_s             int not null default 240  check (delay_min_s >= 60),
  delay_max_s             int not null default 1200 check (delay_max_s <= 3600),
  debounce_quiet_s        int not null default 120  check (debounce_quiet_s between 30 and 600),
  debounce_max_s          int not null default 600  check (debounce_max_s between 60 and 1800),
  stale_after_h           int not null default 12   check (stale_after_h between 1 and 72),
  languages               text[] not null default '{en}',
  disclosure              text check (disclosure is null or length(disclosure) between 1 and 200),
  blocked_countries       text[],                                   -- null = EU/EEA default while no disclosure; '{}' = none
  returning_after_days    smallint not null default 3  check (returning_after_days between 1 and 30),
  dormant_after_days      smallint not null default 30 check (dormant_after_days between 7 and 365),
  inactivity_days         smallint default 7 check (inactivity_days is null or inactivity_days between 1 and 60),
  downgraded_at           timestamptz,
  downgrade_reason        text,
  breaker_reset_at        timestamptz,
  updated_by              uuid references auth.users(id) on delete set null,
  updated_at              timestamptz not null default now(),
  constraint outreach_srs_delay_order check (delay_max_s > delay_min_s),
  constraint outreach_srs_debounce_order check (debounce_max_s >= debounce_quiet_s),
  constraint outreach_srs_gap_order check (dormant_after_days > returning_after_days)
);
create index if not exists outreach_srs_ws_mode_idx on outreach_sequence_reply_settings(workspace_id, mode);

create table if not exists outreach_workspace_reply_settings (
  workspace_id                uuid primary key references outreach_workspaces(id) on delete cascade,
  max_ai_sends_per_sender_day int not null default 25 check (max_ai_sends_per_sender_day between 1 and 40),
  default_prompt_id           uuid references outreach_master_prompts(id) on delete set null,
  updated_by                  uuid references auth.users(id) on delete set null,
  updated_at                  timestamptz not null default now()
);

alter table outreach_sequences add column if not exists resumed_at timestamptz;

-- ============================================================================= consent: one live row per sender
alter table outreach_ai_reply_consent
  alter column master_prompt_id drop not null,
  alter column master_prompt_version drop not null;
alter table outreach_ai_reply_consent_links
  alter column master_prompt_id drop not null,
  alter column master_prompt_version drop not null;
drop index if exists outreach_ai_reply_consent_live_uq;

-- ============================================================================= chats
alter table outreach_chats
  add column if not exists reply_sequence_id     uuid references outreach_sequences(id) on delete set null,
  add column if not exists ai_handed_off_at      timestamptz,
  add column if not exists ai_handoff_reason     text,
  add column if not exists ai_handoff_rule       text,
  add column if not exists ai_handoff_run_id     uuid,
  add column if not exists ai_session_started_at timestamptz,
  add column if not exists ai_session_kind       text,
  add column if not exists ai_session_count      int not null default 1,
  add column if not exists ai_quiet_task_at      timestamptz;
do $$ begin
  alter table outreach_chats add constraint outreach_chats_ai_handoff_reason_chk
    check (ai_handoff_reason is null or ai_handoff_reason in ('human_replied','meeting_confirmed','calendar_sent','stop_rule','max_replies','stage','booking','manual'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_chats add constraint outreach_chats_ai_session_kind_chk check (ai_session_kind is null or ai_session_kind in ('normal','returning','dormant'));
exception when duplicate_object then null; end $$;
create index if not exists outreach_chats_reply_seq_idx on outreach_chats(reply_sequence_id) where ai_handed_off_at is null and reply_sequence_id is not null;
create index if not exists outreach_chats_handed_off_idx on outreach_chats(workspace_id, ai_handed_off_at desc) where ai_handed_off_at is not null;

-- ============================================================================= runs
alter table outreach_ai_reply_runs
  add column if not exists trigger_kind    text not null default 'auto' check (trigger_kind in ('auto','manual')),
  add column if not exists requested_by    uuid references auth.users(id) on delete set null,
  add column if not exists requested_via   text check (requested_via is null or requested_via in ('inbox','mcp')),
  add column if not exists guidance        text check (guidance is null or char_length(guidance) <= 300),
  add column if not exists variants        jsonb,
  add column if not exists stop_after_send boolean not null default false,
  add column if not exists stop_rule       text,
  add column if not exists scenario_id     uuid references outreach_master_prompt_scenarios(id) on delete set null,
  add column if not exists gap_days        numeric(6,1),
  add column if not exists session_kind    text,
  add column if not exists warnings        jsonb;
create index if not exists outreach_ai_reply_runs_manual_idx on outreach_ai_reply_runs(requested_by, created_at desc) where trigger_kind = 'manual';
-- a manual run is not "the chat's active run" for the dispatcher / mirror in the same way, but only one pending run per chat
-- keeps the composer unambiguous: the partial unique index from 035 stays.

-- ============================================================================= tasks, messages, domains
alter table outreach_tasks add column if not exists source text not null default 'user' check (source in ('user','ai','system'));
alter table outreach_messages add column if not exists translation jsonb;   -- {lang, text, at}

create table if not exists outreach_scheduling_domains (host text primary key, path_prefix text);
insert into outreach_scheduling_domains(host, path_prefix) values
  ('calendly.com', null), ('cal.com', null), ('savvycal.com', null), ('tidycal.com', null), ('zcal.co', null),
  ('meetings.hubspot.com', null), ('calendar.app.google', null), ('outlook.office.com', '/bookwithme'),
  ('koalendar.com', null), ('youcanbook.me', null)
on conflict (host) do nothing;

-- ============================================================================= knowledge (minimal own pipeline, contract §0)
create table if not exists outreach_knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references outreach_workspaces(id) on delete cascade,
  kind          text not null check (kind in ('website','document','text')),
  title         text not null check (char_length(title) between 1 and 200),
  url           text,
  storage_path  text,
  content_type  text,
  text_inline   text check (text_inline is null or char_length(text_inline) <= 200000),
  status        text not null default 'pending' check (status in ('pending','crawling','ready','error')),
  error         text,
  pages         int not null default 0,
  chunks        int not null default 0,
  crawled_at    timestamptz,
  refresh_days  int check (refresh_days is null or refresh_days between 1 and 90),
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists outreach_knowledge_sources_ws_idx on outreach_knowledge_sources(workspace_id, created_at desc);
create index if not exists outreach_knowledge_sources_due_idx on outreach_knowledge_sources(status) where status in ('pending','crawling');

create table if not exists outreach_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  source_id    uuid not null references outreach_knowledge_sources(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  seq          int  not null,
  url          text,
  heading      text,
  text         text not null,
  tsv          tsvector generated always as (to_tsvector('english', coalesce(heading, '') || ' ' || text)) stored
);
create index if not exists outreach_knowledge_chunks_src_idx on outreach_knowledge_chunks(source_id, seq);
create index if not exists outreach_knowledge_chunks_tsv_idx on outreach_knowledge_chunks using gin(tsv);
create index if not exists outreach_knowledge_chunks_trgm_idx on outreach_knowledge_chunks using gin(text gin_trgm_ops);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('outreach-knowledge', 'outreach-knowledge', false, 20971520, array['text/plain','text/markdown','text/html','application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/octet-stream'])
on conflict (id) do update set file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
drop policy if exists outreach_knowledge_upload on storage.objects;
create policy outreach_knowledge_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'outreach-knowledge'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids()))
    and outreach_role_in(((storage.foldername(name))[1])::uuid) in ('owner','manager'));
drop policy if exists outreach_knowledge_read on storage.objects;
create policy outreach_knowledge_read on storage.objects for select to authenticated
  using (bucket_id = 'outreach-knowledge'
    and (storage.foldername(name))[1] in (select id::text from outreach_workspaces where id in (select outreach_workspace_ids())));

-- ============================================================================= unanswered questions
create table if not exists outreach_ai_unanswered_questions (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references outreach_workspaces(id) on delete cascade,
  sequence_id      uuid not null references outreach_sequences(id) on delete cascade,
  master_prompt_id uuid references outreach_master_prompts(id) on delete cascade,
  canonical        text not null,
  norm             text not null,                                   -- lower-cased, punctuation-free canonical (trigram key)
  examples         jsonb not null default '[]'::jsonb,              -- [{run_id, chat_id, message_id, text, at}] (max 10)
  count_total      int not null default 1,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now(),
  status           text not null default 'open' check (status in ('open','answered','dismissed')),
  answered_faq_id  uuid references outreach_master_prompt_faqs(id) on delete set null,
  dismissed_reason text,
  seen_at          timestamptz[] not null default '{}'               -- for "count in the last 30 days"
);
create index if not exists outreach_ai_unanswered_seq_idx on outreach_ai_unanswered_questions(sequence_id, status, last_seen_at desc);
create index if not exists outreach_ai_unanswered_trgm_idx on outreach_ai_unanswered_questions using gin(norm gin_trgm_ops);

-- ============================================================================= lead notes
create table if not exists outreach_lead_ai_notes (
  lead_id      uuid primary key references outreach_leads(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  summary      text check (summary is null or char_length(summary) <= 400),
  items        jsonb not null default '[]'::jsonb,
  -- [{id, key: budget|timeline|current_solution|pain|objection|decision_maker|interest|other, text, source_message_id,
  --   updated_at, edited_by, locked, history:[{text, at}]}]
  updated_at   timestamptz not null default now()
);
create table if not exists outreach_ai_lead_notes_queue (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references outreach_workspaces(id) on delete cascade,
  lead_id         uuid not null references outreach_leads(id) on delete cascade,
  chat_id         uuid not null references outreach_chats(id) on delete cascade,
  run_id          uuid references outreach_ai_reply_runs(id) on delete set null,
  message_ids     uuid[] not null,
  attempts        smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
create index if not exists outreach_ai_lead_notes_queue_due_idx on outreach_ai_lead_notes_queue(next_attempt_at);

-- alert kinds used by v2. The live constraint is either the original `kind in ('a','b')` or 035's `kind = any ('{a,b}'::text[])`
-- form: both are parsed, and the known kinds are always kept (035's parser only read the first form, so a re-run of it
-- could have left a constraint with the new kinds alone — this block repairs that too).
do $$
declare def text; kinds text[]; arr text; base text[] := array['sequence_stalled','sender_running_dry','import_failed','hold_expiring','ai_reply_too_early','ai_reply_downgraded','ai_reply_settings_moved'];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conname = 'outreach_alerts_kind_check' and conrelid = 'outreach_alerts'::regclass;
  if def is null then return; end if;
  arr := substring(def from '''\{([^}]*)\}''');
  if arr is not null then select array_agg(btrim(x, ' "')) into kinds from unnest(string_to_array(arr, ',')) x;
  else select array_agg(m[1]) into kinds from regexp_matches(def, '''([a-z_]+)''', 'g') m; end if;
  select array_agg(distinct k) into kinds from unnest(coalesce(kinds, '{}'::text[]) || base) k where k ~ '^[a-z_]+$';
  if not (def like '%ai_reply_settings_moved%' and def like '%sequence_stalled%') then
    alter table outreach_alerts drop constraint outreach_alerts_kind_check;
    execute format('alter table outreach_alerts add constraint outreach_alerts_kind_check check (kind = any (%L::text[]))', kinds);
  end if;
end $$;

-- ============================================================================= backfill (runs once; every step is idempotent)
-- Prompts: workspace / client → library rows; every sequence gets its own settings row and its own prompt (an independent
-- copy of the client / workspace prompt, else the template). Consent: one live row per sender. Chats: takeovers → handoffs,
-- recent chats → reply_sequence_id.
create or replace function outreach_migrate_ai_replies_v2() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare w record; q record; pol jsonb; own outreach_master_prompts%rowtype; src outreach_master_prompts%rowtype; mp outreach_master_prompts%rowtype;
        wsp uuid; cap int; n_seq int := 0; n_lib int := 0; n_chat int := 0; n_cons int := 0; ps jsonb; t jsonb; sec jsonb; body_ text; nv int; moved int := 0;
        stop_missing boolean; sender_modes text[]; sit jsonb; card jsonb; i int;
begin
  t := outreach_master_prompt_template();
  for w in select id from outreach_workspaces where deleted_at is null loop
    -- 1. workspace settings: cap from the v1.1 workspace policy (else 25); default prompt = the ex-workspace prompt
    cap := null;
    if to_regclass('outreach_reply_policies') is not null then
      execute 'select max_ai_sends_per_sender_day from outreach_reply_policies where workspace_id = $1 and scope = ''workspace''' into cap using w.id;
    end if;
    select id into wsp from outreach_master_prompts where workspace_id = w.id and scope = 'workspace';
    insert into outreach_workspace_reply_settings(workspace_id, max_ai_sends_per_sender_day, default_prompt_id)
    values (w.id, least(40, greatest(1, coalesce(cap, 25))), wsp) on conflict (workspace_id) do nothing;

    -- 2. one settings row + one prompt per sequence
    for q in select s.* from outreach_sequences s where s.workspace_id = w.id and not exists (select 1 from outreach_sequence_reply_settings x where x.sequence_id = s.id) loop
      pol := null;
      if to_regclass('outreach_reply_policies') is not null then
        -- the old resolution: sequence → client → workspace (sender rows ignored, noted below)
        execute 'select outreach__ai_policy($1, $2, $3, null)' into pol using w.id, q.client_id, q.id;
      end if;
      pol := coalesce(pol, outreach_ai_reply_defaults());
      select * into own from outreach_master_prompts where workspace_id = w.id and scope = 'sequence' and (sequence_id = q.id or scope_id = q.id) limit 1;
      if own.id is null then
        select * into src from outreach_master_prompts where workspace_id = w.id
           and ((scope = 'client' and scope_id = q.client_id) or scope = 'workspace' or (scope = 'library' and id = wsp))
         order by case scope when 'client' then 1 else 2 end limit 1;
        if src.id is not null then
          insert into outreach_master_prompts(workspace_id, scope, scope_id, sequence_id, editor_mode, version, body, sections, settings, substantive_version, substantive_at,
                                              copied_from_prompt_id, copied_from_version, knowledge_source_ids, updated_by)
          values (w.id, 'sequence', q.id, q.id, src.editor_mode, 1, src.body, src.sections, src.settings, 1, now(), src.id, src.version, src.knowledge_source_ids, src.updated_by)
          returning * into own;
          insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, created_by)
          values (own.id, 1, own.editor_mode, own.body, own.sections, own.settings, 'substantive', 'Copied from ' || case src.scope when 'client' then 'the client prompt' else 'the workspace prompt' end || ' (v' || src.version || ') by the v2 migration', src.updated_by);
          -- carry the source's cards / Q&A too (none exist yet in v1.1, kept for re-runs)
          insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled)
          select own.id, position, title, when_text, do_text, enabled from outreach_master_prompt_scenarios where master_prompt_id = src.id;
        else
          -- no prompt anywhere: the template, with its cards
          insert into outreach_master_prompts(workspace_id, scope, scope_id, sequence_id, editor_mode, version, body, sections, settings, substantive_version, substantive_at)
          values (w.id, 'sequence', q.id, q.id, 'guided', 1, t->>'body', t->'sections', t->'settings', 1, now()) returning * into own;
          insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note, scenarios)
          values (own.id, 1, 'guided', own.body, own.sections, own.settings, 'substantive', 'Template (v2 migration)', t->'scenarios');
          i := 0;
          for card in select x from jsonb_array_elements(t->'scenarios') x loop
            i := i + 1;
            insert into outreach_master_prompt_scenarios(master_prompt_id, position, title, when_text, do_text, enabled)
            values (own.id, i, card->>'title', card->>'when_text', card->>'do_text', true);
          end loop;
        end if;
      end if;
      ps := outreach__mp_default_settings() || coalesce(own.settings, '{}'::jsonb);
      insert into outreach_sequence_reply_settings(sequence_id, workspace_id, mode, master_prompt_id, pitch_after_replies, max_ai_replies_per_chat, warmup_remaining,
             handoff_stage_id, delay_min_s, delay_max_s, debounce_quiet_s, debounce_max_s, stale_after_h, languages, disclosure, blocked_countries)
      values (q.id, w.id, coalesce((pol->>'mode')::outreach_reply_mode_t, 'draft'), own.id,
              least(5, greatest(0, coalesce((ps->>'min_exchanges_before_pitch')::int, 2))), least(10, greatest(1, coalesce((ps->>'max_ai_replies_per_chat')::int, 6))),
              case when pol->>'mode' = 'autopilot' then 0 else 20 end,
              case when coalesce(ps->>'handoff_stage_id', '') <> '' and exists (select 1 from outreach_stages st where st.id = (ps->>'handoff_stage_id')::uuid and st.workspace_id = w.id) then (ps->>'handoff_stage_id')::uuid end,
              greatest(60, coalesce((pol->>'delay_min_s')::int, 240)), least(3600, greatest(greatest(60, coalesce((pol->>'delay_min_s')::int, 240)) + 60, coalesce((pol->>'delay_max_s')::int, 1200))),
              least(600, greatest(30, coalesce((pol->>'debounce_quiet_s')::int, 120))), least(1800, greatest(least(600, greatest(30, coalesce((pol->>'debounce_quiet_s')::int, 120))), coalesce((pol->>'debounce_max_s')::int, 600))),
              least(72, greatest(1, coalesce((pol->>'stale_after_h')::int, 12))),
              coalesce((select array_agg(x) from jsonb_array_elements_text(coalesce(ps->'languages', '["en"]'::jsonb)) x), '{en}'),
              nullif(btrim(coalesce(pol->>'disclosure', '')), ''),
              case when pol ? 'blocked_countries' and jsonb_typeof(pol->'blocked_countries') = 'array' then (select coalesce(array_agg(x), '{}') from jsonb_array_elements_text(pol->'blocked_countries') x) end);
      n_seq := n_seq + 1;
      -- 3. sender-level policies whose mode differed from what this sequence now has → one manager alert per sequence
      if to_regclass('outreach_reply_policies') is not null then
        execute 'select array_agg(distinct p.mode::text) from outreach_reply_policies p where p.workspace_id = $1 and p.scope = ''sender'' and p.mode is not null and p.scope_id = any($2) and p.mode::text <> $3'
          into sender_modes using w.id, q.sender_pool, coalesce(pol->>'mode', 'draft');
        if sender_modes is not null then
          insert into outreach_alerts(workspace_id, client_id, kind, entity, entity_id, label, reason, detail)
          values (w.id, q.client_id, 'ai_reply_settings_moved', 'sequence', q.id, q.name,
                  'Sender-level AI reply settings were removed: AI replies are now set per sequence. This sequence is on ' || coalesce(pol->>'mode', 'draft') || '.',
                  jsonb_build_object('sender_modes', to_jsonb(sender_modes)))
          on conflict (kind, entity_id) where resolved_at is null do nothing;
          moved := moved + 1;
        end if;
      end if;
    end loop;

    -- 4. the ex-workspace / client prompts become library prompts (names, no scope id)
    update outreach_master_prompts set scope = 'library', name = coalesce(name, case scope when 'workspace' then 'Workspace default' else 'Client · ' || coalesce((select c.name from outreach_clients c where c.id = scope_id), '?') end), scope_id = null
     where workspace_id = w.id and scope in ('workspace', 'client');
    get diagnostics i = row_count; n_lib := n_lib + i;
  end loop;

  -- 5. prompts without a "Stop when" section: append the default (a STYLE version: warm-up untouched) + the gap block
  for mp in select * from outreach_master_prompts where body not ilike '%## Stop when%' loop
    stop_missing := true;
    if mp.editor_mode = 'guided' then
      sec := coalesce(mp.sections, '{}'::jsonb);
      if nullif(btrim(sec->>'stop'), '') is null then sec := sec || jsonb_build_object('stop', outreach__mp_default_stop()); end if;
      if position('Coming back after a gap' in coalesce(sec->>'flow', '')) = 0 then sec := sec || jsonb_build_object('flow', btrim(coalesce(sec->>'flow', '')) || E'\n\n' || outreach__mp_default_gap_block()); end if;
      select coalesce(jsonb_agg(jsonb_build_object('title', title, 'when_text', when_text, 'do_text', do_text, 'enabled', enabled) order by position), '[]'::jsonb) into sit
        from outreach_master_prompt_scenarios where master_prompt_id = mp.id;
      body_ := outreach__compile_master_prompt(sec, outreach__mp_default_settings() || coalesce(mp.settings, '{}'::jsonb), sit);
    else
      sec := mp.sections;
      body_ := btrim(mp.body) || E'\n\n## Stop when\n' || outreach__mp_default_stop()
             || case when position('Coming back after a gap' in mp.body) = 0 then E'\n\n## How a conversation goes (addition)\n' || outreach__mp_default_gap_block() else '' end;
    end if;
    nv := mp.version + 1;
    update outreach_master_prompts set version = nv, body = body_, sections = sec, updated_at = now() where id = mp.id;
    insert into outreach_master_prompt_versions(master_prompt_id, version, editor_mode, body, sections, settings, change_kind, note)
    values (mp.id, nv, mp.editor_mode, body_, sec, mp.settings, 'style', 'Added the "Stop when" section and the returning-prospect rules (v2 migration)')
    on conflict do nothing;
  end loop;

  -- 6. consent: one live row per sender (the latest grant wins)
  with ranked as (select id, row_number() over (partition by sender_id order by granted_at desc) rn from outreach_ai_reply_consent where revoked_at is null)
  update outreach_ai_reply_consent c set revoked_at = now(), revoked_reason = 'merged_to_sender_consent' from ranked r where r.id = c.id and r.rn > 1;
  get diagnostics n_cons = row_count;

  -- 7. chats: a v1.1 human takeover is a v2 handoff; recent chats get their sequence and a session
  update outreach_chats set ai_handed_off_at = coalesce(autopilot_paused_until - interval '72 hours', now()), ai_handoff_reason = 'human_replied',
         autopilot_state = 'active', autopilot_paused_until = null, autopilot_paused_reason = null
   where autopilot_state = 'paused_human' and ai_handed_off_at is null;
  get diagnostics n_chat = row_count;
  update outreach_chats c set reply_sequence_id = x.sequence_id, ai_session_started_at = coalesce(c.ai_session_started_at, x.first_at), ai_session_kind = coalesce(c.ai_session_kind, 'normal')
    from (select r.chat_id, (array_agg(r.sequence_id order by r.created_at desc) filter (where r.sequence_id is not null))[1] sequence_id, min(r.created_at) first_at
            from outreach_ai_reply_runs r where r.created_at > now() - interval '30 days' group by r.chat_id) x
   where x.chat_id = c.id and c.reply_sequence_id is null;
  update outreach_chats c set reply_sequence_id = outreach__chat_sequence(c.id)
   where c.reply_sequence_id is null and c.provider = 'LINKEDIN' and c.lead_id is not null and c.ai_session_started_at is not null;

  return jsonb_build_object('sequences', n_seq, 'library_prompts', n_lib, 'consents_merged', n_cons, 'chats_handed_off', n_chat, 'settings_moved_alerts', moved);
end $$;
revoke execute on function outreach_migrate_ai_replies_v2() from public, anon, authenticated;
select outreach_migrate_ai_replies_v2();

-- now every prompt is sequence | library
update outreach_master_prompts set scope_id = sequence_id where scope = 'sequence' and scope_id is distinct from sequence_id;
do $$ begin
  alter table outreach_master_prompts add constraint outreach_master_prompts_scope_check
    check ((scope = 'sequence' and sequence_id is not null and scope_id = sequence_id) or (scope = 'library' and sequence_id is null and scope_id is null));
exception when duplicate_object then null; end $$;
create unique index if not exists outreach_master_prompts_one_per_sequence on outreach_master_prompts(sequence_id) where scope = 'sequence';
create index if not exists outreach_master_prompts_library_idx on outreach_master_prompts(workspace_id, name) where scope = 'library';
create unique index if not exists outreach_ai_reply_consent_one_per_sender on outreach_ai_reply_consent(sender_id) where revoked_at is null;

-- ============================================================================= legacy
-- v1.1 per-scope policies are read-only history; the RPCs that wrote them and the per-chat mode override go
do $$
declare f record;
begin
  if to_regclass('outreach_reply_policies') is not null and to_regclass('outreach_reply_policies_legacy') is null then
    alter table outreach_reply_policies rename to outreach_reply_policies_legacy;
  end if;
  if to_regclass('outreach_reply_policies_legacy') is not null then
    revoke insert, update, delete on outreach_reply_policies_legacy from authenticated, anon;
  end if;
  -- dropped by name, whatever their signature (the policy row type followed the rename)
  for f in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in ('outreach_reply_policy_list','outreach_reply_policy_set','outreach_reply_policy_clear',
              'outreach__ai_policy_row_json','outreach_ai_reply_set_chat_mode','outreach_ai_reply_resume_chat','outreach_master_prompt_get',
              'outreach_master_prompt_save','outreach_master_prompt_list','outreach_master_prompt_delete','outreach_ai_consent_grant_operator',
              'outreach__mp_json','outreach__ai_policy','outreach__ai_downgrade') loop
    execute format('drop function if exists %s', f.sig);
  end loop;
end $$;

-- the chat guard: the new AI columns are engine / RPC state too; the override column is gone
create or replace function outreach_trg_chat_ai_guard() returns trigger
language plpgsql set search_path = public, extensions as $$
begin
  if current_user in ('authenticated', 'anon') and (
       new.autopilot_state is distinct from old.autopilot_state
    or new.autopilot_paused_until is distinct from old.autopilot_paused_until or new.autopilot_paused_reason is distinct from old.autopilot_paused_reason
    or new.conversation_stage is distinct from old.conversation_stage or new.conversation_exchanges is distinct from old.conversation_exchanges
    or new.ai_replies_count is distinct from old.ai_replies_count or new.last_ai_move is distinct from old.last_ai_move
    or new.stage_stale is distinct from old.stage_stale or new.is_group is distinct from old.is_group
    or new.ai_run_id is distinct from old.ai_run_id or new.ai_run_status is distinct from old.ai_run_status or new.ai_run_decision is distinct from old.ai_run_decision
    or new.ai_escalation_reason is distinct from old.ai_escalation_reason or new.ai_scheduled_send_at is distinct from old.ai_scheduled_send_at
    or new.reply_sequence_id is distinct from old.reply_sequence_id or new.ai_handed_off_at is distinct from old.ai_handed_off_at
    or new.ai_handoff_reason is distinct from old.ai_handoff_reason or new.ai_handoff_rule is distinct from old.ai_handoff_rule
    or new.ai_handoff_run_id is distinct from old.ai_handoff_run_id or new.ai_session_started_at is distinct from old.ai_session_started_at
    or new.ai_session_kind is distinct from old.ai_session_kind or new.ai_session_count is distinct from old.ai_session_count
    or new.ai_quiet_task_at is distinct from old.ai_quiet_task_at) then
    raise exception 'E_FORBIDDEN: AI reply settings of a chat change through the AI menu only';
  end if;
  return new;
end $$;
alter table outreach_chats drop column if exists reply_mode_override;

-- ============================================================================= RLS (platform pattern: reads for members; writes through RPCs / service)
alter table outreach_sequence_reply_settings   enable row level security;
alter table outreach_workspace_reply_settings  enable row level security;
alter table outreach_master_prompt_scenarios   enable row level security;
alter table outreach_master_prompt_faqs        enable row level security;
alter table outreach_knowledge_sources         enable row level security;
alter table outreach_knowledge_chunks          enable row level security;   -- no policies: retrieval is service-side
alter table outreach_ai_unanswered_questions   enable row level security;
alter table outreach_lead_ai_notes             enable row level security;
alter table outreach_ai_lead_notes_queue       enable row level security;   -- no policies: service only
alter table outreach_scheduling_domains        enable row level security;

drop policy if exists srs_select on outreach_sequence_reply_settings;
create policy srs_select on outreach_sequence_reply_settings for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member')
         and outreach_client_visible(workspace_id, (select client_id from outreach_sequences q where q.id = sequence_id)));
drop policy if exists wrs_select on outreach_workspace_reply_settings;
create policy wrs_select on outreach_workspace_reply_settings for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member'));
drop policy if exists mps_select on outreach_master_prompt_scenarios;
create policy mps_select on outreach_master_prompt_scenarios for select
  using (exists (select 1 from outreach_master_prompts mp_ where mp_.id = master_prompt_id and mp_.workspace_id in (select outreach_workspace_ids())
                  and outreach_role_in(mp_.workspace_id) in ('owner','manager','member') and outreach_client_visible(mp_.workspace_id, outreach_ai_scope_client_of(mp_.scope, mp_.scope_id))));
drop policy if exists mpf_select on outreach_master_prompt_faqs;
create policy mpf_select on outreach_master_prompt_faqs for select
  using (exists (select 1 from outreach_master_prompts mp_ where mp_.id = master_prompt_id and mp_.workspace_id in (select outreach_workspace_ids())
                  and outreach_role_in(mp_.workspace_id) in ('owner','manager','member') and outreach_client_visible(mp_.workspace_id, outreach_ai_scope_client_of(mp_.scope, mp_.scope_id))));
drop policy if exists ks_select on outreach_knowledge_sources;
create policy ks_select on outreach_knowledge_sources for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member'));
drop policy if exists uq_select on outreach_ai_unanswered_questions;
create policy uq_select on outreach_ai_unanswered_questions for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in ('owner','manager','member')
         and outreach_client_visible(workspace_id, (select client_id from outreach_sequences q where q.id = sequence_id)));
drop policy if exists lan_select on outreach_lead_ai_notes;
create policy lan_select on outreach_lead_ai_notes for select
  using (workspace_id in (select outreach_workspace_ids()) and outreach_client_visible(workspace_id, (select client_id from outreach_leads l where l.id = lead_id)));
drop policy if exists sd_select on outreach_scheduling_domains;
create policy sd_select on outreach_scheduling_domains for select to authenticated using (true);

-- the v1.1 read policy on master prompts still works: outreach_ai_scope_client_of('library', null) → null → workspace-wide
do $$ begin
  alter publication supabase_realtime add table outreach_lead_ai_notes;
exception when duplicate_object then null; when undefined_object then null; end $$;
