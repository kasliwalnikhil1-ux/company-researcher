-- 063_ai_hub.sql — One home for AI (ai-hub-unified-ui-changes.md, adapted to the build: docs/outreach/AI-HUB.md).
-- Requires 001–062. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/063_ai_hub.sql
-- 064_ai_hub_cron.sql (the review-mode worker job) is applied AFTER the functions are deployed.
--
--   1. Schema      Personalized lines Off/Review per variable; website assistant Review mode (suggestions table);
--                  shared Q&A (library rows on outreach_master_prompt_faqs + outreach_knowledge_qa_links);
--                  unanswered questions from both features in one table.
--   2. Views       outreach_ai_outputs (Activity), outreach_ai_needs_you (Needs you + badge). security_invoker: a user
--                  sees exactly the rows the underlying tables' RLS already allows.
--   3. Functions   outreach_hub_* user RPCs (member / manager checked inside), outreach_webchat_*suggest* service functions.
--   4. Patches     existing functions changed in place (pg_get_functiondef + replace, like 027/044/050/060) so nothing else
--                  in them moves. Every anchor is asserted: a missing anchor aborts the migration.
--   5. Tasks       open `ai_escalation` tasks are closed (the run shows in Needs you); the engine stops creating them.
--                  `review_ai_draft` tasks stay as the record behind a Step draft card: closing them would strand the
--                  enrolment that waits on them.
--
-- Names: user RPCs are outreach_hub_* on purpose. The grant loops of 037/042/051 revoke `authenticated` from every
-- outreach_ai_* / outreach_knowledge_* / outreach_webchat* function that is not in their lists (see the grant-loop gotcha).

-- ===============================================================================================================
-- 0. In-place patch helper (dropped at the end of this file)
-- ===============================================================================================================
-- p_pairs = [old1, new1, old2, new2, ...]. Returns false when the function already carries p_marker.
create or replace function outreach_hub__patch(p_fn text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  -- bodies applied from a CRLF checkout carry \r: strip it so the anchors match
  def := replace(pg_get_functiondef(p_fn::regprocedure), chr(13), '');
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(p_pairs[i] in def) = 0 then raise exception '063: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '063: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_hub__patch(text, text, text[]) from public, anon, authenticated;

-- ===============================================================================================================
-- 1. Schema
-- ===============================================================================================================
-- ---- Personalized lines: Off / Review per variable; when the AI wrote the line
alter table outreach_ai_variables add column if not exists mode text not null default 'review';
do $$ begin
  alter table outreach_ai_variables add constraint outreach_ai_variables_mode_chk check (mode in ('off', 'review'));
exception when duplicate_object then null; end $$;

alter table outreach_ai_values add column if not exists generated_at timestamptz;
update outreach_ai_values set generated_at = updated_at where generated_at is null and nullif(btrim(coalesce(text, '')), '') is not null;
create index if not exists outreach_ai_values_ws_generated_idx on outreach_ai_values(workspace_id, generated_at desc) where generated_at is not null;
create index if not exists outreach_ai_values_ws_review_idx on outreach_ai_values(workspace_id, generated_at) where status = 'generated';
create index if not exists outreach_ai_values_variable_status_idx on outreach_ai_values(variable_id, status);

-- ---- Step drafts (review_ai_draft tasks) and website answers: the date filter of Activity / the queue
create index if not exists outreach_tasks_ai_draft_open_idx on outreach_tasks(workspace_id, created_at) where kind = 'review_ai_draft' and completed_at is null;
create index if not exists outreach_tasks_ai_draft_ws_idx on outreach_tasks(workspace_id, created_at desc) where kind = 'review_ai_draft';
create index if not exists outreach_webchat_ai_turns_ws_idx on outreach_webchat_ai_turns(workspace_id, created_at desc);
create index if not exists outreach_profile_changes_ai_idx on outreach_profile_changes(workspace_id, created_at desc) where source = 'ai_draft';

-- ---- Website assistant Review mode: one row per visitor message the assistant drafted an answer for
create table if not exists outreach_webchat_ai_suggestions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references outreach_workspaces(id) on delete cascade,
  inbox_id        uuid not null references outreach_webchat_inboxes(id) on delete cascade,
  chat_id         uuid not null references outreach_chats(id) on delete cascade,
  message_id      uuid not null references outreach_messages(id) on delete cascade,   -- the visitor message answered
  text            text,                                                              -- null while it is being written
  sources         jsonb not null default '[]',
  confidence      text,                                                              -- high | low
  model           text,
  -- pending: being written · waiting: ready for an agent · used: sent (as is or edited) · stale: the visitor wrote again or
  -- an agent replied without it · expired: nobody replied within review_timeout_min · failed: the AI had nothing to suggest
  status          text not null default 'pending' check (status in ('pending', 'waiting', 'used', 'stale', 'expired', 'failed')),
  attempts        smallint not null default 0,
  locked_at       timestamptz,
  error           text,
  used_message_id uuid references outreach_messages(id) on delete set null,
  resolved_by     uuid references auth.users(id) on delete set null,
  away_at         timestamptz,                                                       -- the timeout was handled (away message sent, or an agent answered)
  created_at      timestamptz not null default now(),
  ready_at        timestamptz,
  resolved_at     timestamptz,
  constraint outreach_webchat_ai_suggestions_text_chk check (status <> 'waiting' or text is not null)
);
create unique index if not exists outreach_webchat_ai_suggestions_msg_uq on outreach_webchat_ai_suggestions(message_id);
create index if not exists outreach_webchat_ai_suggestions_ws_idx on outreach_webchat_ai_suggestions(workspace_id, status, created_at);
create index if not exists outreach_webchat_ai_suggestions_ws_created_idx on outreach_webchat_ai_suggestions(workspace_id, created_at desc);
create index if not exists outreach_webchat_ai_suggestions_open_idx on outreach_webchat_ai_suggestions(chat_id) where status in ('pending', 'waiting');
create index if not exists outreach_webchat_ai_suggestions_away_idx on outreach_webchat_ai_suggestions(created_at) where away_at is null;

alter table outreach_webchat_ai_suggestions enable row level security;
select outreach__policy('outreach_webchat_ai_suggestions', 'webchat_ai_suggestions_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and exists (select 1 from outreach_webchat_inboxes i where i.id = inbox_id and outreach_client_visible(i.workspace_id, i.client_id))');
revoke insert, update, delete, truncate on outreach_webchat_ai_suggestions from anon, authenticated;
do $$ begin alter publication supabase_realtime add table outreach_webchat_ai_suggestions; exception when duplicate_object then null; when undefined_object then null; end $$;

-- ---- Q&A: one list. A row either belongs to a sequence's prompt (master_prompt_id, as before) or to the workspace
-- library (master_prompt_id null + workspace_id). Library rows apply everywhere unless outreach_knowledge_qa_links limits them.
-- The table keeps its name: thirty functions and the prompt version snapshots read it.
alter table outreach_master_prompt_faqs
  add column if not exists workspace_id uuid references outreach_workspaces(id) on delete cascade,
  add column if not exists updated_at   timestamptz not null default now();
alter table outreach_master_prompt_faqs alter column master_prompt_id drop not null;
update outreach_master_prompt_faqs f set workspace_id = mp.workspace_id from outreach_master_prompts mp where mp.id = f.master_prompt_id and f.workspace_id is null;
do $$ begin
  alter table outreach_master_prompt_faqs add constraint outreach_master_prompt_faqs_owner_chk check (master_prompt_id is not null or workspace_id is not null);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_master_prompt_faqs drop constraint if exists outreach_master_prompt_faqs_source_check;
  alter table outreach_master_prompt_faqs add constraint outreach_master_prompt_faqs_source_check check (source in ('manual', 'unanswered', 'import'));
exception when duplicate_object then null; end $$;
create index if not exists outreach_master_prompt_faqs_library_idx on outreach_master_prompt_faqs(workspace_id, created_at desc) where master_prompt_id is null;

create or replace function outreach_hub_trg_faq_workspace() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.workspace_id is null and new.master_prompt_id is not null then
    select mp.workspace_id into new.workspace_id from outreach_master_prompts mp where mp.id = new.master_prompt_id;
  end if;
  return new;
end $$;
drop trigger if exists outreach_hub_faq_workspace on outreach_master_prompt_faqs;
create trigger outreach_hub_faq_workspace before insert on outreach_master_prompt_faqs for each row execute function outreach_hub_trg_faq_workspace();

create table if not exists outreach_knowledge_qa_links (
  qa_id       uuid not null references outreach_master_prompt_faqs(id) on delete cascade,
  target_kind text not null check (target_kind in ('website', 'sequence')),
  target_id   uuid not null,
  primary key (qa_id, target_kind, target_id)
);   -- no rows for a library pair = available everywhere
create index if not exists outreach_knowledge_qa_links_target_idx on outreach_knowledge_qa_links(target_kind, target_id);
alter table outreach_knowledge_qa_links enable row level security;
select outreach__policy('outreach_knowledge_qa_links', 'kqa_links_select', 'select',
  'exists (select 1 from outreach_master_prompt_faqs f where f.id = qa_id and f.workspace_id in (select outreach_workspace_ids()) and outreach_role_in(f.workspace_id) in (''owner'', ''manager'', ''member''))');
revoke insert, update, delete, truncate on outreach_knowledge_qa_links from anon, authenticated;
-- library pairs are readable by the team (the prompt-scoped policy mpf_select stays as it is; policies are OR-ed)
select outreach__policy('outreach_master_prompt_faqs', 'mpf_library_select', 'select',
  'master_prompt_id is null and workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in (''owner'', ''manager'', ''member'')');

-- ---- Unanswered questions: Replies and the Website assistant in one table
alter table outreach_ai_unanswered_questions alter column sequence_id drop not null;
alter table outreach_ai_unanswered_questions
  add column if not exists inbox_id uuid references outreach_webchat_inboxes(id) on delete cascade,
  add column if not exists origins  text[] not null default '{reply}';
do $$ begin
  alter table outreach_ai_unanswered_questions add constraint outreach_ai_unanswered_origins_chk check (origins <@ array['reply', 'website']::text[] and cardinality(origins) >= 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table outreach_ai_unanswered_questions add constraint outreach_ai_unanswered_owner_chk check (sequence_id is not null or inbox_id is not null);
exception when duplicate_object then null; end $$;
create index if not exists outreach_ai_unanswered_ws_idx on outreach_ai_unanswered_questions(workspace_id, status, last_seen_at desc);
select outreach__policy('outreach_ai_unanswered_questions', 'uq_select', 'select',
  'workspace_id in (select outreach_workspace_ids()) and outreach_role_in(workspace_id) in (''owner'', ''manager'', ''member'')
   and outreach_client_visible(workspace_id, coalesce(
         (select q.client_id from outreach_sequences q where q.id = outreach_ai_unanswered_questions.sequence_id),
         (select w.client_id from outreach_webchat_inboxes w where w.id = outreach_ai_unanswered_questions.inbox_id)))');

-- ===============================================================================================================
-- 2. Views
-- ===============================================================================================================
-- Activity: what the AI generated, nothing else (no outcome, approver, prompt or check data is read here).
-- feature: reply | line | draft (AI-written sequence step) | website | profile
drop view if exists outreach_ai_outputs;
create view outreach_ai_outputs with (security_invoker = true) as
  -- Replies: the text the AI wrote (sent or not; a person's "Draft with AI" included)
  select r.id, r.workspace_id, 'reply'::text as feature, r.created_at,
         'sequence'::text as where_kind, r.sequence_id as where_id, s.name as where_name,
         'lead'::text as who_kind, r.lead_id as who_id, coalesce(l.full_name, c.attendee_name) as who_name, l.company as who_detail,
         coalesce(r.final_text, r.draft_text) as text, r.chat_id
    from outreach_ai_reply_runs r
    join outreach_chats c on c.id = r.chat_id
    left join outreach_sequences s on s.id = r.sequence_id
    left join outreach_leads l on l.id = r.lead_id
   where coalesce(r.final_text, r.draft_text) is not null
  union all
  -- Personalized lines
  select v.id, v.workspace_id, 'line'::text, coalesce(v.generated_at, v.updated_at),
         'variable'::text, v.variable_id, av.key,
         'lead'::text, v.lead_id, l.full_name, l.company,
         v.text, null::uuid
    from outreach_ai_values v
    join outreach_ai_variables av on av.id = v.variable_id
    left join outreach_leads l on l.id = v.lead_id
   where v.text is not null and btrim(v.text) <> ''
  union all
  -- Step drafts: the message the AI wrote for an "AI draft + approval" step
  select t.id, t.workspace_id, 'draft'::text, t.created_at,
         'sequence'::text, e.sequence_id, s.name,
         'lead'::text, t.lead_id, l.full_name, l.company,
         t.ai_draft, t.chat_id
    from outreach_tasks t
    left join outreach_enrollments e on e.id = t.enrollment_id
    left join outreach_sequences s on s.id = e.sequence_id
    left join outreach_leads l on l.id = t.lead_id
   where t.kind = 'review_ai_draft' and t.ai_draft is not null and btrim(t.ai_draft) <> ''
  union all
  -- Website assistant: answers sent to visitors
  select a.id, a.workspace_id, 'website'::text, a.created_at,
         'website'::text, a.inbox_id, w.name,
         'visitor'::text, a.visitor_id, coalesce(nullif(btrim(vi.name), ''), 'Visitor'), vi.city,
         a.answer, a.chat_id
    from outreach_webchat_ai_turns a
    join outreach_webchat_inboxes w on w.id = a.inbox_id
    left join outreach_webchat_visitors vi on vi.id = a.visitor_id
   where a.answer is not null and btrim(a.answer) <> ''
  union all
  -- Website assistant: suggestions written for an agent (Review mode)
  select g.id, g.workspace_id, 'website'::text, coalesce(g.ready_at, g.created_at),
         'website'::text, g.inbox_id, w.name,
         'visitor'::text, c.visitor_id, coalesce(nullif(btrim(vi.name), ''), 'Visitor'), vi.city,
         g.text, g.chat_id
    from outreach_webchat_ai_suggestions g
    join outreach_chats c on c.id = g.chat_id
    join outreach_webchat_inboxes w on w.id = g.inbox_id
    left join outreach_webchat_visitors vi on vi.id = c.visitor_id
   where g.text is not null
  union all
  -- Profile drafts (Profile Studio "Draft with AI": headline / About)
  select p.id, p.workspace_id, 'profile'::text, p.created_at,
         'sender'::text, p.sender_id, sd.display_name,
         'sender'::text, p.sender_id, sd.display_name, null::text,
         coalesce(p.payload->>'headline', p.payload->>'summary'), null::uuid
    from outreach_profile_changes p
    join outreach_senders sd on sd.id = p.sender_id
   where p.source = 'ai_draft' and coalesce(p.payload->>'headline', p.payload->>'summary') is not null;
comment on view outreach_ai_outputs is 'AI hub → Activity: one row per text the AI wrote. security_invoker: RLS of the underlying tables applies.';

-- Needs you: every AI output a person has to act on. One row per card.
--   type      reply | line | draft | website | question | profile
--   state     reply: review | escalated | no_reply | warmup · line: review · draft: review | drafting | no_draft ·
--             website: review · question: open · profile: review
--   reason    a code the app turns into one line: review | warmup | no_reply | <escalation reason> | <gate> |
--             low_confidence | drafting | no_draft | unanswered
--   priority  0 = a live website suggestion (always on top), 1 = everything else; the page orders by priority, created_at
drop view if exists outreach_ai_needs_you;
create view outreach_ai_needs_you with (security_invoker = true) as
  -- Replies: a draft in Review mode, a reply the AI handed to a person, a suggestion not to reply, an Auto warm-up hold
  select r.id, r.workspace_id, 'reply'::text as type,
         case when r.status = 'scheduled' then 'warmup'
              when r.status = 'escalated' or r.decision = 'escalate' then 'escalated'
              when r.decision = 'no_reply' then 'no_reply' else 'review' end as state,
         'sequence'::text as where_kind, r.sequence_id as where_id, s.name as where_name,
         'lead'::text as who_kind, r.lead_id as who_id, coalesce(l.full_name, c.attendee_name) as who_name, l.company as who_detail,
         (select left(string_agg(coalesce(m.text, m.transcript, '[attachment]'), E'\n' order by m.sent_at), 2000)
            from outreach_messages m where m.id = any(r.inbound_message_ids)) as trigger_text,
         r.draft_text as ai_text,
         case when r.status = 'scheduled' then 'warmup'
              when r.status = 'escalated' or r.decision = 'escalate' then coalesce(r.escalation_reasons[1], 'escalated')
              when r.decision = 'no_reply' then 'no_reply'
              when cardinality(r.gate_failures) > 0 then r.gate_failures[1]
              else 'review' end as reason,
         c.assigned_to as assignee_id, r.updated_at as created_at,
         r.chat_id, r.lead_id, r.scheduled_send_at as send_at, 1 as priority,
         jsonb_build_object('status', r.status, 'decision', r.decision, 'mode', r.mode, 'provider', c.provider, 'sender_id', r.sender_id,
                            'stop_after_send', r.stop_after_send, 'stop_rule', r.stop_rule, 'warnings', coalesce(r.warnings, '[]'::jsonb)) as meta
    from outreach_ai_reply_runs r
    join outreach_chats c on c.id = r.chat_id
    left join outreach_sequences s on s.id = r.sequence_id
    left join outreach_leads l on l.id = r.lead_id
   where r.trigger_kind = 'auto' and c.ai_handed_off_at is null and not c.archived
     and (r.status = 'draft_ready'
          or (r.status = 'scheduled' and coalesce(r.timings->>'warmup', 'false') = 'true')
          -- an escalated run stays escalated for ever: it needs a person only while theirs is the last word in the chat
          or (r.status = 'escalated' and c.last_direction is distinct from 'out' and r.created_at > now() - interval '30 days'
              and not exists (select 1 from outreach_ai_reply_runs n where n.chat_id = r.chat_id and n.created_at > r.created_at)))
  union all
  -- Personalized lines waiting for review
  select v.id, v.workspace_id, 'line'::text, 'review'::text,
         'variable'::text, v.variable_id, av.key,
         'lead'::text, v.lead_id, l.full_name, l.company,
         null::text, v.text, 'review'::text,
         null::uuid, coalesce(v.generated_at, v.updated_at),
         null::uuid, v.lead_id, null::timestamptz, 1,
         jsonb_build_object('variable_name', av.name, 'fallback', av.fallback, 'max_chars', av.max_chars, 'facts', v.facts, 'batch_id', v.batch_id,
                            'title', coalesce(l.title, l.headline), 'edited', v.edited)
    from outreach_ai_values v
    join outreach_ai_variables av on av.id = v.variable_id
    join outreach_leads l on l.id = v.lead_id
   where v.status = 'generated' and v.text is not null and btrim(v.text) <> ''
  union all
  -- Step drafts: the AI wrote (or is writing) the message of a sequence step; the lead waits for a person
  select t.id, t.workspace_id, 'draft'::text,
         case when t.ai_draft is null then 'drafting' when btrim(t.ai_draft) = '' then 'no_draft' else 'review' end,
         'sequence'::text, e.sequence_id, s.name,
         'lead'::text, t.lead_id, l.full_name, l.company,
         t.body, nullif(btrim(coalesce(t.ai_draft, '')), ''),
         case when t.ai_draft is null then 'drafting' when btrim(t.ai_draft) = '' then 'no_draft' else 'review' end,
         t.assigned_to, t.created_at,
         t.chat_id, t.lead_id, null::timestamptz, 1,
         jsonb_build_object('draft_kind', t.draft_kind, 'node_id', t.node_id, 'sender_id', t.sender_id, 'enrollment_id', t.enrollment_id, 'title', t.title)
    from outreach_tasks t
    left join outreach_enrollments e on e.id = t.enrollment_id
    left join outreach_sequences s on s.id = e.sequence_id
    left join outreach_leads l on l.id = t.lead_id
   where t.kind = 'review_ai_draft' and t.completed_at is null
  union all
  -- Website assistant (Review mode): a suggested answer waits for an agent
  select g.id, g.workspace_id, 'website'::text, 'review'::text,
         'website'::text, g.inbox_id, w.name,
         'visitor'::text, c.visitor_id, coalesce(nullif(btrim(vi.name), ''), 'Visitor'), vi.city,
         q.text, g.text, case when g.confidence = 'low' then 'low_confidence' else 'review' end,
         c.assigned_to, coalesce(g.ready_at, g.created_at),
         g.chat_id, c.lead_id, null::timestamptz, 0,
         jsonb_build_object('sources', g.sources, 'confidence', g.confidence, 'message_id', g.message_id)
    from outreach_webchat_ai_suggestions g
    join outreach_chats c on c.id = g.chat_id
    join outreach_webchat_inboxes w on w.id = g.inbox_id
    join outreach_messages q on q.id = g.message_id
    left join outreach_webchat_visitors vi on vi.id = c.visitor_id
   where g.status = 'waiting'
  union all
  -- Questions the AI could not answer (Replies and the Website assistant); answering is a manager's job
  select u.id, u.workspace_id, 'question'::text, 'open'::text,
         case when u.sequence_id is not null then 'sequence' else 'website' end, coalesce(u.sequence_id, u.inbox_id),
         coalesce((select q.name from outreach_sequences q where q.id = u.sequence_id), (select w.name from outreach_webchat_inboxes w where w.id = u.inbox_id)),
         null::text, null::uuid, null::text, null::text,
         u.canonical, null::text, 'unanswered'::text,
         null::uuid, u.first_seen_at,
         null::uuid, null::uuid, null::timestamptz, 1,
         jsonb_build_object('count_total', u.count_total, 'origins', to_jsonb(u.origins), 'last_seen_at', u.last_seen_at,
                            'examples', (select coalesce(jsonb_agg(x.e), '[]'::jsonb) from (select e from jsonb_array_elements(u.examples) e order by e->>'at' desc limit 3) x))
    from outreach_ai_unanswered_questions u
   where u.status = 'open' and outreach_role_in(u.workspace_id) in ('owner', 'manager')
  union all
  -- Profile drafts: the AI drafted a headline / About that nobody applied or discarded yet
  select p.id, p.workspace_id, 'profile'::text, 'review'::text,
         'sender'::text, p.sender_id, sd.display_name,
         'sender'::text, p.sender_id, sd.display_name, null::text,
         p.note, coalesce(p.payload->>'headline', p.payload->>'summary'), 'review'::text,
         p.requested_by, p.created_at,
         null::uuid, null::uuid, null::timestamptz, 1,
         jsonb_build_object('field', case when p.payload ? 'headline' then 'headline' else 'about' end)
    from outreach_profile_changes p
    join outreach_senders sd on sd.id = p.sender_id
   where p.source = 'ai_draft' and p.status = 'draft' and coalesce(p.payload->>'headline', p.payload->>'summary') is not null;
comment on view outreach_ai_needs_you is 'AI hub → Needs you: one row per AI output that waits for a person. security_invoker: RLS of the underlying tables applies.';

revoke all on outreach_ai_outputs, outreach_ai_needs_you from public, anon;
grant select on outreach_ai_outputs, outreach_ai_needs_you to authenticated, service_role;

-- ===============================================================================================================
-- 3. Functions
-- ===============================================================================================================
-- ---------------------------------------------------------------------------------------------------------------
-- 3.1 Counts (the page header, the sidebar badge). Invoker: the same RLS as the view.
--     p_mine = cards assigned to me + cards assigned to nobody (PRD §4.2 "Mine").
-- ---------------------------------------------------------------------------------------------------------------
create or replace function outreach_hub_needs_you_counts(p_ws uuid, p_mine boolean default true) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object(
    'total', count(*), 'reply', count(*) filter (where n.type = 'reply'), 'line', count(*) filter (where n.type = 'line'),
    'draft', count(*) filter (where n.type = 'draft'), 'website', count(*) filter (where n.type = 'website'),
    'question', count(*) filter (where n.type = 'question'), 'profile', count(*) filter (where n.type = 'profile'))
    from outreach_ai_needs_you n
   where n.workspace_id = p_ws and coalesce(outreach_role_in(p_ws)::text, 'client_viewer') <> 'client_viewer'
     and (not coalesce(p_mine, true) or n.assignee_id is null or n.assignee_id = auth.uid())
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.2 Setup page: one call for the feature cards and their Manage tables. Invoker (RLS scopes clients).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function outreach_hub_setup(p_ws uuid) returns jsonb
language plpgsql stable set search_path = public, extensions as $$
declare rl outreach_role_t := outreach_role_in(p_ws); wk timestamptz := now() - interval '7 days'; written jsonb; waiting jsonb;
begin
  if rl is null or rl = 'client_viewer' then raise exception 'E_FORBIDDEN: member required'; end if;
  select coalesce(jsonb_object_agg(x.feature, x.n), '{}'::jsonb) into written
    from (select o.feature, count(*) n from outreach_ai_outputs o where o.workspace_id = p_ws and o.created_at >= wk group by o.feature) x;
  select coalesce(jsonb_object_agg(x.k, x.n), '{}'::jsonb) into waiting
    from (select y.type || ':' || coalesce(y.where_id::text, '') k, count(*) n from outreach_ai_needs_you y where y.workspace_id = p_ws group by 1) x;
  return jsonb_build_object(
    'written_7d', written,
    'sequences', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'status', q.status, 'mode', coalesce(s.mode::text, 'draft'),
                      'warmup_remaining', s.warmup_remaining, 'downgraded_at', s.downgraded_at, 'downgrade_reason', s.downgrade_reason,
                      'waiting', coalesce((waiting->>('reply:' || q.id::text))::int, 0)) order by q.name), '[]'::jsonb)
                    from outreach_sequences q left join outreach_sequence_reply_settings s on s.sequence_id = q.id
                   where q.workspace_id = p_ws and q.status <> 'archived'),
    'variables', (select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'key', v.key, 'name', v.name, 'mode', v.mode, 'needs_posts', v.needs_posts,
                      'waiting', coalesce((waiting->>('line:' || v.id::text))::int, 0),
                      'approved', (select count(*) from outreach_ai_values x where x.variable_id = v.id and x.status = 'approved')) order by v.name), '[]'::jsonb)
                    from outreach_ai_variables v where v.workspace_id = p_ws),
    'websites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name, 'is_active', i.is_active, 'ai_enabled', i.ai_enabled,
                      'mode', coalesce(i.settings#>>'{ai,mode}', 'off'),
                      'review_timeout_min', coalesce(nullif(i.settings#>>'{ai,review_timeout_min}', '')::int, 10),
                      'waiting', coalesce((waiting->>('website:' || i.id::text))::int, 0)) order by i.created_at), '[]'::jsonb)
                   from outreach_webchat_inboxes i where i.workspace_id = p_ws and i.deleted_at is null),
    'drafts', jsonb_build_object('open', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.kind = 'review_ai_draft' and t.completed_at is null)),
    'profile', jsonb_build_object('open', (select count(*) from outreach_profile_changes p where p.workspace_id = p_ws and p.source = 'ai_draft' and p.status = 'draft')),
    'questions_open', (select count(*) from outreach_ai_unanswered_questions u where u.workspace_id = p_ws and u.status = 'open'));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.3 Personalized lines: Off / Review per variable
-- ---------------------------------------------------------------------------------------------------------------
-- Switching a variable off: lines still to be written are not written (they become "skipped", so a lead that waits for
-- its line starts with the fallback); lines already written stay where they are. The trigger also covers a direct update.
create or replace function outreach_hub_trg_variable_mode() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r record; n int := 0;
begin
  if new.mode = 'off' then
    for r in update outreach_ai_values set status = 'skipped', locked_at = null, updated_at = now()
              where variable_id = new.id and status = 'pending' returning lead_id loop
      perform outreach_release_waiting(r.lead_id, 'ai_review');
      n := n + 1;
    end loop;
    update outreach_ai_batches b
       set status = case when exists (select 1 from outreach_ai_values y where y.batch_id = b.id and y.status = 'generated') then 'review' else 'done' end, finished_at = now()
     where b.variable_id = new.id and b.status = 'generating';
  end if;
  perform outreach_audit(new.workspace_id, 'ai_line.mode_changed', 'ai_variable', new.id::text, jsonb_build_object('from', old.mode, 'to', new.mode, 'not_written', n), 'user');
  return null;
end $$;
drop trigger if exists outreach_hub_variable_mode on outreach_ai_variables;
create trigger outreach_hub_variable_mode after update of mode on outreach_ai_variables
  for each row when (old.mode is distinct from new.mode) execute function outreach_hub_trg_variable_mode();

create or replace function outreach_hub_variable_set_mode(p_variable uuid, p_mode text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v outreach_ai_variables%rowtype;
begin
  select * into v from outreach_ai_variables where id = p_variable for update;
  if not found then raise exception 'E_NOT_FOUND: variable'; end if;
  perform outreach_require(v.workspace_id, 'manager');
  if p_mode = 'auto' then raise exception 'E_PAYLOAD_INVALID: Auto is not available for Personalized lines yet: a person approves every line. Use off or review'; end if;
  if coalesce(p_mode, '') not in ('off', 'review') then raise exception 'E_PAYLOAD_INVALID: mode is off or review'; end if;
  update outreach_ai_variables set mode = p_mode, updated_at = now() where id = p_variable and mode <> p_mode;
  return jsonb_build_object('id', v.id, 'key', v.key, 'name', v.name, 'mode', p_mode, 'was', v.mode);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.4 Replies: Skip / Dismiss from Needs you. outreach_ai_reply_cancel covers drafts and scheduled runs only; an escalated
--     run has no "done" state of its own, so skipping it closes it the same way (cancelled · dismissed).
-- ---------------------------------------------------------------------------------------------------------------
create or replace function outreach_hub_reply_dismiss(p_run uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r outreach_ai_reply_runs%rowtype;
begin
  select * into r from outreach_ai_reply_runs where id = p_run;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(r.workspace_id, 'member');
  if not outreach_client_visible(r.workspace_id, r.client_id) then raise exception 'E_NOT_FOUND'; end if;
  if r.status = 'scheduled' then raise exception 'E_PAYLOAD_INVALID: say why you are cancelling a scheduled reply'; end if;
  update outreach_ai_reply_runs set status = 'cancelled', cancel_reason = 'dismissed', cancelled_by = auth.uid()
   where id = p_run and status in ('draft_ready', 'escalated') returning * into r;
  if not found then raise exception 'E_CONFLICT: this reply was already handled'; end if;
  perform outreach_audit(r.workspace_id, 'ai_reply.cancelled', 'ai_reply_run', r.id::text, jsonb_build_object('reason', 'dismissed', 'via', 'needs_you'), 'user');
  return jsonb_build_object('id', r.id, 'status', r.status);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.5 Q&A: which pairs apply where
-- ---------------------------------------------------------------------------------------------------------------
-- A library pair with no link rows applies everywhere; with links, only to those sequences / websites.
create or replace function outreach_hub__qa_applies(p_qa uuid, p_kind text, p_target uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select not exists (select 1 from outreach_knowledge_qa_links k where k.qa_id = p_qa)
      or exists (select 1 from outreach_knowledge_qa_links k where k.qa_id = p_qa and k.target_kind = p_kind and k.target_id = p_target)
$$;

-- Library pairs for one sequence / website: all of them up to 30, else the 5 closest to the question (trigram), the
-- same rule outreach__ai_faqs_for uses for a prompt's own pairs. Service only (the reply engine and the website assistant).
create or replace function outreach_knowledge_qa_for(p_ws uuid, p_kind text, p_target uuid, p_question text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare n int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select count(*) into n from outreach_master_prompt_faqs f
   where f.master_prompt_id is null and f.workspace_id = p_ws and f.enabled and outreach_hub__qa_applies(f.id, p_kind, p_target);
  if n <= 30 or nullif(btrim(coalesce(p_question, '')), '') is null then
    return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'question', x.question, 'answer', x.answer) order by x.created_at) from (
      select f.id, f.question, f.answer, f.created_at from outreach_master_prompt_faqs f
       where f.master_prompt_id is null and f.workspace_id = p_ws and f.enabled and outreach_hub__qa_applies(f.id, p_kind, p_target)
       order by f.created_at limit 30) x), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'question', x.question, 'answer', x.answer) order by x.sim desc) from (
    select f.id, f.question, f.answer, similarity(f.question, p_question) sim from outreach_master_prompt_faqs f
     where f.master_prompt_id is null and f.workspace_id = p_ws and f.enabled and outreach_hub__qa_applies(f.id, p_kind, p_target)
     order by sim desc limit 5) x), '[]'::jsonb);
end $$;

-- Q&A for a question in a reply: the prompt's own pairs + the library pairs that apply to its sequence.
create or replace function outreach__ai_faqs_for(p_mp uuid, p_question text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare n int; ws uuid; seq uuid;
begin
  select mp.workspace_id, mp.sequence_id into ws, seq from outreach_master_prompts mp where mp.id = p_mp;
  select count(*) into n from outreach_master_prompt_faqs f
   where f.enabled and (f.master_prompt_id = p_mp or (f.master_prompt_id is null and f.workspace_id = ws and outreach_hub__qa_applies(f.id, 'sequence', seq)));
  if n <= 30 then
    return coalesce((select jsonb_agg(jsonb_build_object('id', f.id, 'question', f.question, 'answer', f.answer) order by f.created_at) from outreach_master_prompt_faqs f
      where f.enabled and (f.master_prompt_id = p_mp or (f.master_prompt_id is null and f.workspace_id = ws and outreach_hub__qa_applies(f.id, 'sequence', seq)))), '[]'::jsonb);
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'question', x.question, 'answer', x.answer) order by x.sim desc) from (
    select f.id, f.question, f.answer, similarity(f.question, coalesce(p_question, '')) sim from outreach_master_prompt_faqs f
     where f.enabled and (f.master_prompt_id = p_mp or (f.master_prompt_id is null and f.workspace_id = ws and outreach_hub__qa_applies(f.id, 'sequence', seq)))
     order by sim desc limit 5) x), '[]'::jsonb);
end $$;

-- targets of one pair as json: [] = everywhere
create or replace function outreach_hub__qa_targets(p_qa uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('kind', k.target_kind, 'id', k.target_id,
           'name', case k.target_kind when 'sequence' then (select q.name from outreach_sequences q where q.id = k.target_id)
                                      else (select w.name from outreach_webchat_inboxes w where w.id = k.target_id) end) order by k.target_kind, k.target_id), '[]'::jsonb)
    from outreach_knowledge_qa_links k where k.qa_id = p_qa
$$;

-- p_targets: [{kind: 'sequence' | 'website', id}] of this workspace, visible to the caller. Raises otherwise.
create or replace function outreach_hub__qa_check_targets(p_ws uuid, p_targets jsonb) returns void
language plpgsql stable security definer set search_path = public, extensions as $$
declare t jsonb; tid uuid;
begin
  if p_targets is null then return; end if;
  if jsonb_typeof(p_targets) <> 'array' or jsonb_array_length(p_targets) > 50 then raise exception 'E_PAYLOAD_INVALID: targets is a list of up to 50 sequences and websites'; end if;
  for t in select x from jsonb_array_elements(p_targets) x loop
    begin tid := (t->>'id')::uuid; exception when others then raise exception 'E_PAYLOAD_INVALID: a target id is not a uuid'; end;
    if t->>'kind' = 'sequence' then
      if not exists (select 1 from outreach_sequences q where q.id = tid and q.workspace_id = p_ws and outreach_client_visible(p_ws, q.client_id)) then raise exception 'E_NOT_FOUND: sequence'; end if;
    elsif t->>'kind' = 'website' then
      if not exists (select 1 from outreach_webchat_inboxes w where w.id = tid and w.workspace_id = p_ws and w.deleted_at is null and outreach_client_visible(p_ws, w.client_id)) then raise exception 'E_NOT_FOUND: website'; end if;
    else raise exception 'E_PAYLOAD_INVALID: a target is a sequence or a website';
    end if;
  end loop;
end $$;

create or replace function outreach_hub_qa_list(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
    select f.created_at, jsonb_build_object(
             'id', f.id, 'question', f.question, 'answer', f.answer, 'enabled', f.enabled, 'source', f.source, 'created_at', f.created_at, 'updated_at', f.updated_at,
             -- 'sequence' = kept on that sequence's prompt (edited there too); 'library' = shared
             'owner', case when f.master_prompt_id is null then 'library' else 'sequence' end,
             'targets', case when f.master_prompt_id is null then outreach_hub__qa_targets(f.id)
                             else jsonb_build_array(jsonb_build_object('kind', 'sequence', 'id', mp.sequence_id, 'name', q.name)) end) j
      from outreach_master_prompt_faqs f
      left join outreach_master_prompts mp on mp.id = f.master_prompt_id
      left join outreach_sequences q on q.id = mp.sequence_id
     where (f.master_prompt_id is null and f.workspace_id = p_ws)
        or (mp.workspace_id = p_ws and mp.scope = 'sequence' and q.status <> 'archived' and outreach_client_visible(p_ws, q.client_id))) x), '[]'::jsonb);
end $$;

-- Create or change a pair. p_targets: null = leave as it is (new pair: everywhere); [] = everywhere; a list = only those.
-- A pair that lives on a sequence's prompt stays there while its target is that sequence alone; any other target moves
-- it to the shared library.
create or replace function outreach_hub_qa_save(p_ws uuid, p_id uuid, p_question text, p_answer text, p_enabled boolean default true, p_targets jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f outreach_master_prompt_faqs%rowtype; mp outreach_master_prompts%rowtype; fid uuid; same_seq boolean; t jsonb;
begin
  perform outreach_require(p_ws, 'manager');
  if length(btrim(coalesce(p_question, ''))) not between 1 and 500 or length(btrim(coalesce(p_answer, ''))) not between 1 and 2000 then
    raise exception 'E_PAYLOAD_INVALID: question up to 500 and answer up to 2000 characters, neither empty';
  end if;
  perform outreach_hub__qa_check_targets(p_ws, p_targets);
  if p_id is null then
    if (select count(*) from outreach_master_prompt_faqs x where x.workspace_id = p_ws and x.master_prompt_id is null) >= 500 then raise exception 'E_PAYLOAD_INVALID: up to 500 shared Q&A pairs per workspace'; end if;
    insert into outreach_master_prompt_faqs(master_prompt_id, workspace_id, question, answer, source, enabled, created_by)
    values (null, p_ws, btrim(p_question), btrim(p_answer), 'manual', coalesce(p_enabled, true), auth.uid()) returning id into fid;
  else
    select * into f from outreach_master_prompt_faqs where id = p_id for update;
    if not found then raise exception 'E_NOT_FOUND'; end if;
    if f.master_prompt_id is not null then
      select * into mp from outreach_master_prompts where id = f.master_prompt_id;
      if mp.workspace_id <> p_ws or mp.scope <> 'sequence' then raise exception 'E_NOT_FOUND'; end if;
      perform outreach__ai_seq_for(mp.sequence_id, 'manager');
      same_seq := p_targets is null or (jsonb_array_length(p_targets) = 1 and p_targets->0->>'kind' = 'sequence' and (p_targets->0->>'id')::uuid = mp.sequence_id);
      if same_seq then
        update outreach_master_prompt_faqs set question = btrim(p_question), answer = btrim(p_answer), enabled = coalesce(p_enabled, enabled), updated_at = now() where id = p_id;
        perform outreach__mp_bump(mp.id, 'substantive', 'Q&A edited');
        perform outreach_audit(p_ws, 'ai.qa_saved', 'qa', p_id::text, jsonb_build_object('owner', 'sequence', 'sequence_id', mp.sequence_id), 'user');
        return jsonb_build_object('id', p_id, 'owner', 'sequence');
      end if;
      -- moved to the shared library: the sequence's prompt no longer carries it
      update outreach_master_prompt_faqs set master_prompt_id = null, workspace_id = p_ws, question = btrim(p_question), answer = btrim(p_answer),
             enabled = coalesce(p_enabled, enabled), updated_at = now() where id = p_id;
      perform outreach__mp_bump(mp.id, 'substantive', 'Q&A moved to the shared library');
    else
      if f.workspace_id <> p_ws then raise exception 'E_NOT_FOUND'; end if;
      update outreach_master_prompt_faqs set question = btrim(p_question), answer = btrim(p_answer), enabled = coalesce(p_enabled, enabled), updated_at = now() where id = p_id;
    end if;
    fid := p_id;
  end if;
  if p_targets is not null then
    delete from outreach_knowledge_qa_links where qa_id = fid;
    for t in select x from jsonb_array_elements(p_targets) x loop
      insert into outreach_knowledge_qa_links(qa_id, target_kind, target_id) values (fid, t->>'kind', (t->>'id')::uuid) on conflict do nothing;
    end loop;
  end if;
  perform outreach_audit(p_ws, 'ai.qa_saved', 'qa', fid::text, jsonb_build_object('owner', 'library', 'created', p_id is null, 'targets', coalesce(p_targets, 'null'::jsonb)), 'user');
  return jsonb_build_object('id', fid, 'owner', 'library', 'targets', outreach_hub__qa_targets(fid));
end $$;

create or replace function outreach_hub_qa_delete(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare f outreach_master_prompt_faqs%rowtype;
begin
  select * into f from outreach_master_prompt_faqs where id = p_id;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if f.master_prompt_id is not null then
    return outreach_faq_delete(p_id) || jsonb_build_object('ok', true);   -- checks the sequence, reopens its questions, bumps the prompt
  end if;
  perform outreach_require(f.workspace_id, 'manager');
  update outreach_ai_unanswered_questions set status = 'open', answered_faq_id = null where answered_faq_id = p_id;   -- its question is unanswered again
  delete from outreach_master_prompt_faqs where id = p_id;
  perform outreach_audit(f.workspace_id, 'ai.qa_deleted', 'qa', p_id::text, jsonb_build_object('question', left(f.question, 120)), 'user');
  return jsonb_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.6 Unanswered questions (Question cards)
-- ---------------------------------------------------------------------------------------------------------------
-- the group a caller may answer / dismiss: manager, and the group's sequence / website visible to them
create or replace function outreach_hub__question_for(p_group uuid) returns outreach_ai_unanswered_questions
language plpgsql stable security definer set search_path = public, extensions as $$
declare u outreach_ai_unanswered_questions%rowtype; cid uuid;
begin
  select * into u from outreach_ai_unanswered_questions where id = p_group;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(u.workspace_id, 'manager');
  select coalesce((select q.client_id from outreach_sequences q where q.id = u.sequence_id), (select w.client_id from outreach_webchat_inboxes w where w.id = u.inbox_id)) into cid;
  if not outreach_client_visible(u.workspace_id, cid) then raise exception 'E_NOT_FOUND'; end if;
  return u;
end $$;

-- "Add answer": a shared Q&A pair (everywhere unless p_targets limits it), so Replies and the Website assistant can both
-- answer it next time. The group is marked answered; it reopens by itself if the question keeps coming unanswered.
create or replace function outreach_hub_question_answer(p_group uuid, p_answer text, p_targets jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u outreach_ai_unanswered_questions%rowtype; fid uuid; t jsonb;
begin
  u := outreach_hub__question_for(p_group);
  if u.status <> 'open' then raise exception 'E_CONFLICT: this question was already handled'; end if;
  if length(btrim(coalesce(p_answer, ''))) not between 2 and 2000 then raise exception 'E_PAYLOAD_INVALID: write the answer (up to 2000 characters)'; end if;
  perform outreach_hub__qa_check_targets(u.workspace_id, p_targets);
  insert into outreach_master_prompt_faqs(master_prompt_id, workspace_id, question, answer, source, enabled, created_by)
  values (null, u.workspace_id, left(u.canonical, 500), btrim(p_answer), 'unanswered', true, auth.uid()) returning id into fid;
  if p_targets is not null then
    for t in select x from jsonb_array_elements(p_targets) x loop
      insert into outreach_knowledge_qa_links(qa_id, target_kind, target_id) values (fid, t->>'kind', (t->>'id')::uuid) on conflict do nothing;
    end loop;
  end if;
  update outreach_ai_unanswered_questions set status = 'answered', answered_faq_id = fid where id = p_group;
  perform outreach_audit(u.workspace_id, 'ai.question_answered', 'unanswered_question', p_group::text, jsonb_build_object('qa_id', fid, 'question', left(u.canonical, 120)), 'user');
  return jsonb_build_object('group_id', p_group, 'qa_id', fid);
end $$;

create or replace function outreach_hub_question_dismiss(p_group uuid, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u outreach_ai_unanswered_questions%rowtype;
begin
  u := outreach_hub__question_for(p_group);
  update outreach_ai_unanswered_questions set status = 'dismissed', dismissed_reason = left(p_reason, 300) where id = p_group and status = 'open';
  if not found then raise exception 'E_CONFLICT: this question was already handled'; end if;
  perform outreach_audit(u.workspace_id, 'ai.question_dismissed', 'unanswered_question', p_group::text, jsonb_build_object('question', left(u.canonical, 120), 'reason', p_reason), 'user');
  return jsonb_build_object('ok', true, 'group_id', p_group);
end $$;

-- The website assistant could not answer (low confidence): into the same grouped list. Service only.
-- The visitor's own words are the question (no extra model call); grouping = trigram ≥ 0.6, as for replies.
create or replace function outreach_webchat_unanswered_add(p_chat uuid, p_message uuid, p_text text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; g outreach_ai_unanswered_questions%rowtype; nrm text; ex jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found or c.webchat_inbox_id is null then return jsonb_build_object('ok', false, 'why', 'no_chat'); end if;
  nrm := outreach__uq_norm(left(p_text, 300));
  if nrm is null or length(nrm) < 8 then return jsonb_build_object('ok', false, 'why', 'empty'); end if;
  ex := jsonb_build_object('chat_id', c.id, 'message_id', p_message, 'text', left(p_text, 500), 'at', now(), 'origin', 'website');
  select u.* into g from outreach_ai_unanswered_questions u
   where u.workspace_id = c.workspace_id and (u.norm = nrm or similarity(u.norm, nrm) >= 0.6)
     -- same website, or a group of the same client (never merge across clients)
     and (u.inbox_id = c.webchat_inbox_id
          or coalesce((select q.client_id from outreach_sequences q where q.id = u.sequence_id), (select w.client_id from outreach_webchat_inboxes w where w.id = u.inbox_id)) is not distinct from c.client_id)
   order by (u.inbox_id is not distinct from c.webchat_inbox_id) desc, (u.norm = nrm) desc, similarity(u.norm, nrm) desc limit 1 for update;
  if g.id is null then
    insert into outreach_ai_unanswered_questions(workspace_id, sequence_id, inbox_id, canonical, norm, examples, seen_at, origins)
    values (c.workspace_id, null, c.webchat_inbox_id, left(btrim(p_text), 300), nrm, jsonb_build_array(ex), array[now()], array['website']) returning * into g;
    return jsonb_build_object('ok', true, 'group_id', g.id, 'created', true);
  end if;
  update outreach_ai_unanswered_questions set count_total = count_total + 1, last_seen_at = now(), seen_at = (seen_at || now())[greatest(1, cardinality(seen_at) - 200):],
         examples = case when jsonb_array_length(examples) >= 10 then (examples - 0) || ex else examples || ex end,
         status = case when status = 'answered' then 'open' else status end,
         origins = case when 'website' = any(origins) then origins else array_append(origins, 'website') end
   where id = g.id;
  return jsonb_build_object('ok', true, 'group_id', g.id, 'created', false, 'reopened', g.status = 'answered');
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.7 Knowledge library: sources with the places that use them; attach / detach; remove everywhere
-- ---------------------------------------------------------------------------------------------------------------
-- "Used by" counts websites too (it only counted sequence prompts)
create or replace function outreach__ks_json(s outreach_knowledge_sources) returns jsonb
language sql stable set search_path = public, extensions as $$
  select jsonb_build_object('id', s.id, 'kind', s.kind, 'title', s.title, 'url', s.url, 'storage_path', s.storage_path, 'content_type', s.content_type, 'status', s.status, 'error', s.error,
    'pages', s.pages, 'chunks', s.chunks, 'crawled_at', s.crawled_at, 'refresh_days', s.refresh_days, 'created_at', s.created_at, 'updated_at', s.updated_at,
    'used_by', (select count(*) from outreach_master_prompts mp where s.id = any(mp.knowledge_source_ids))
             + (select count(*) from outreach_webchat_inboxes i where i.workspace_id = s.workspace_id and i.deleted_at is null and coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text))
$$;

create or replace function outreach_hub_knowledge(p_ws uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'member');
  return jsonb_build_object(
    'sources', coalesce((select jsonb_agg(outreach__ks_json(s) || jsonb_build_object('used_in',
        (select coalesce(jsonb_agg(u.j order by u.kind desc, u.name), '[]'::jsonb) from (
           select 'sequence' kind, q.name, jsonb_build_object('kind', 'sequence', 'id', q.id, 'name', q.name) j
             from outreach_master_prompts mp join outreach_sequences q on q.id = mp.sequence_id
            where mp.workspace_id = p_ws and mp.scope = 'sequence' and s.id = any(mp.knowledge_source_ids) and q.status <> 'archived' and outreach_client_visible(p_ws, q.client_id)
           union all
           select 'website', i.name, jsonb_build_object('kind', 'website', 'id', i.id, 'name', i.name)
             from outreach_webchat_inboxes i
            where i.workspace_id = p_ws and i.deleted_at is null and coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) ? s.id::text and outreach_client_visible(p_ws, i.client_id)) u))
        order by s.created_at desc) from outreach_knowledge_sources s where s.workspace_id = p_ws), '[]'::jsonb),
    -- the same pairs outreach_hub_qa_list returns
    'qa_total', (select count(*) from outreach_master_prompt_faqs f left join outreach_master_prompts mp on mp.id = f.master_prompt_id left join outreach_sequences q on q.id = mp.sequence_id
                  where (f.master_prompt_id is null and f.workspace_id = p_ws)
                     or (mp.workspace_id = p_ws and mp.scope = 'sequence' and q.status <> 'archived' and outreach_client_visible(p_ws, q.client_id))),
    'questions_open', (select count(*) from outreach_ai_unanswered_questions u where u.workspace_id = p_ws and u.status = 'open'
                        and outreach_client_visible(p_ws, coalesce((select q.client_id from outreach_sequences q where q.id = u.sequence_id), (select w.client_id from outreach_webchat_inboxes w where w.id = u.inbox_id)))),
    'targets', jsonb_build_object(
      'sequences', (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'status', q.status) order by q.name), '[]'::jsonb) from outreach_sequences q
                     where q.workspace_id = p_ws and q.status <> 'archived' and outreach_client_visible(p_ws, q.client_id)),
      'websites', (select coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', i.name) order by i.name), '[]'::jsonb) from outreach_webchat_inboxes i
                    where i.workspace_id = p_ws and i.deleted_at is null and outreach_client_visible(p_ws, i.client_id))));
end $$;

-- Attach / detach one source to a sequence (its prompt, a new prompt version as before) or a website (its settings, a
-- new settings version as before). The existing RPCs do the work and the permission checks.
create or replace function outreach_hub_knowledge_link(p_source uuid, p_kind text, p_target uuid, p_on boolean) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_knowledge_sources%rowtype; i outreach_webchat_inboxes%rowtype; ids jsonb;
begin
  select * into s from outreach_knowledge_sources where id = p_source;
  if not found then raise exception 'E_NOT_FOUND: knowledge source'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  if p_kind = 'sequence' then
    if not exists (select 1 from outreach_sequences q where q.id = p_target and q.workspace_id = s.workspace_id) then raise exception 'E_NOT_FOUND: sequence'; end if;
    if coalesce(p_on, true) then perform outreach_knowledge_attach(p_target, p_source); else perform outreach_knowledge_detach(p_target, p_source); end if;
  elsif p_kind = 'website' then
    select * into i from outreach_webchat_inboxes where id = p_target and workspace_id = s.workspace_id and deleted_at is null;
    if not found then raise exception 'E_NOT_FOUND: website'; end if;
    select coalesce(jsonb_agg(x), '[]'::jsonb) into ids from jsonb_array_elements_text(coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb)) x where x <> p_source::text;
    if coalesce(p_on, true) then ids := ids || to_jsonb(p_source::text); end if;
    if ids is distinct from coalesce(i.settings#>'{ai,knowledge_source_ids}', '[]'::jsonb) then
      perform outreach_webchat_inbox_update(i.id, jsonb_build_object('settings', jsonb_build_object('ai', jsonb_build_object('knowledge_source_ids', ids))));
    end if;
  else raise exception 'E_PAYLOAD_INVALID: attach a source to a sequence or a website';
  end if;
  return jsonb_build_object('ok', true, 'source_id', p_source, 'kind', p_kind, 'target_id', p_target, 'on', coalesce(p_on, true));
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.8 Website assistant: Off / Review / Auto (+ When) in one call. Storage is unchanged:
--     Off = ai_enabled false · Review = ai.mode 'review' · Auto·Always = 'first' · Auto·Outside hours = 'offline_only'.
-- ---------------------------------------------------------------------------------------------------------------
create or replace function outreach_hub_website_set_mode(p_inbox uuid, p_mode text, p_when text default null, p_review_timeout_min int default null) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare i outreach_webchat_inboxes%rowtype; patch jsonb; cur text; ai jsonb := '{}'::jsonb;
begin
  select * into i from outreach_webchat_inboxes where id = p_inbox and deleted_at is null;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if coalesce(p_mode, '') not in ('off', 'review', 'auto') then raise exception 'E_PAYLOAD_INVALID: mode is off, review or auto'; end if;
  if p_when is not null and p_when not in ('always', 'outside_hours') then raise exception 'E_PAYLOAD_INVALID: when is always or outside_hours'; end if;
  if p_review_timeout_min is not null and p_review_timeout_min not between 1 and 240 then raise exception 'E_PAYLOAD_INVALID: the review timeout is 1 to 240 minutes'; end if;
  cur := coalesce(i.settings#>>'{ai,mode}', 'off');
  if p_review_timeout_min is not null then ai := ai || jsonb_build_object('review_timeout_min', p_review_timeout_min); end if;
  if p_mode = 'off' then
    patch := jsonb_build_object('ai_enabled', false);   -- the stored mode stays, so switching back on keeps the "when"
  elsif p_mode = 'review' then
    patch := jsonb_build_object('ai_enabled', true); ai := ai || jsonb_build_object('mode', 'review');
  else
    patch := jsonb_build_object('ai_enabled', true);
    ai := ai || jsonb_build_object('mode', case when coalesce(p_when, case when cur = 'offline_only' then 'outside_hours' else 'always' end) = 'outside_hours' then 'offline_only' else 'first' end);
  end if;
  if ai <> '{}'::jsonb then patch := patch || jsonb_build_object('settings', jsonb_build_object('ai', ai)); end if;
  return outreach_webchat_inbox_update(p_inbox, patch);   -- manager + client scope checked there; versioned; widget picks it up
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 3.9 Website assistant Review mode (service): open → take → record / fail → sweep
-- ---------------------------------------------------------------------------------------------------------------
-- Called from outreach_webchat_v_message for a chat in Review mode. Returns the suggestion id, or null when the AI may not
-- be used now (allowance used up, per-visitor hourly cap): the chat is then a plain live chat for this message.
create or replace function outreach_webchat__suggest_open(p_chat uuid, p_message uuid) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare c outreach_chats%rowtype; st jsonb; pool jsonb; sid uuid;
begin
  select * into c from outreach_chats where id = p_chat and provider = 'WEBCHAT';
  if not found or c.webchat_inbox_id is null then return null; end if;
  st := outreach_webchat__settings(c.webchat_inbox_id);
  pool := outreach__ai_pool(c.workspace_id);
  if not coalesce((pool->>'ok')::boolean, true) then return null; end if;
  if not outreach_rate_limit('webchat:ai:' || c.visitor_id::text, coalesce((st#>>'{ai,hourly_cap_per_visitor}')::int, 30), 3600) then return null; end if;
  insert into outreach_webchat_ai_suggestions(workspace_id, inbox_id, chat_id, message_id) values (c.workspace_id, c.webchat_inbox_id, c.id, p_message)
  on conflict (message_id) do nothing returning id into sid;
  return sid;
end $$;

-- Everything the suggestion needs (the same shape outreach_webchat_v_ai_context returns, so the edge function reuses
-- its retrieval and prompt code). ok = still worth writing.
create or replace function outreach_webchat_v_suggest_context(p_suggestion uuid) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare g outreach_webchat_ai_suggestions%rowtype; c outreach_chats%rowtype; i outreach_webchat_inboxes%rowtype; st jsonb; q outreach_messages%rowtype; agent_after boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into g from outreach_webchat_ai_suggestions where id = p_suggestion;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into c from outreach_chats where id = g.chat_id;
  select * into q from outreach_messages where id = g.message_id;
  select * into i from outreach_webchat_inboxes where id = g.inbox_id;
  st := outreach_webchat__settings(i.id);
  select exists (select 1 from outreach_messages x where x.chat_id = c.id and x.direction = 'out' and x.sender_type = 'agent' and x.created_at > q.created_at) into agent_after;
  return jsonb_build_object(
    'ok', g.status = 'pending' and c.handed_off_at is null and not agent_after and coalesce(c.ai_mode, 'off') = 'review' and i.ai_enabled
          and i.deleted_at is null and c.status <> 'resolved' and q.deleted_at is null and nullif(btrim(coalesce(q.text, '')), '') is not null,
    'review', true, 'suggestion_id', g.id, 'chat_id', c.id, 'message_id', q.id,
    'workspace_id', c.workspace_id, 'inbox_id', i.id, 'visitor_id', c.visitor_id, 'brand', coalesce(st#>>'{appearance,brand_name}', i.name),
    'persona', st#>>'{ai,persona}', 'allowed_topics', st#>>'{ai,allowed_topics}', 'show_sources', true,
    'knowledge_source_ids', coalesce(st#>'{ai,knowledge_source_ids}', '[]'::jsonb),
    'low_confidence_streak', 2, 'recent_low', 0,
    'query', q.text, 'page_url', (select current_url from outreach_webchat_visitors where id = c.visitor_id),
    'history', (select coalesce(jsonb_agg(jsonb_build_object('role', case when x.direction = 'in' then 'user' else 'assistant' end, 'text', x.text) order by x.sent_at), '[]'::jsonb)
                  from (select * from outreach_messages x where x.chat_id = c.id and x.id <> q.id and x.text is not null and x.content_type = 'text' and x.deleted_at is null order by x.sent_at desc limit 8) x),
    'pool', outreach__ai_pool(c.workspace_id),
    'online', (outreach_webchat__availability(i.id))->'online',
    'visitor_email', (select email from outreach_webchat_visitors where id = c.visitor_id),
    'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text));
end $$;

-- One writer at a time, three tries at most.
create or replace function outreach_webchat_v_suggest_take(p_suggestion uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare ok boolean := false;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_webchat_ai_suggestions set locked_at = now(), attempts = attempts + 1
   where id = p_suggestion and status = 'pending' and attempts < 3 and (locked_at is null or locked_at < now() - interval '90 seconds')
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- The cron worker's safety net: suggestions the request that created them did not finish.
create or replace function outreach_webchat_suggest_claim(p_limit int default 10) returns setof uuid
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  return query
    with due as (
      select g.id from outreach_webchat_ai_suggestions g
       where g.status = 'pending' and g.attempts < 3 and g.created_at < now() - interval '20 seconds'
         and (g.locked_at is null or g.locked_at < now() - interval '90 seconds')
       order by g.created_at limit greatest(1, least(coalesce(p_limit, 10), 50)) for update skip locked)
    update outreach_webchat_ai_suggestions g set locked_at = now(), attempts = g.attempts + 1 from due where g.id = due.id returning g.id;
end $$;

-- p_turn: {answer, sources, confidence: high | low | refused, model, tokens_in, tokens_out, latency_ms, query}
create or replace function outreach_webchat_v_suggest_record(p_suggestion uuid, p_turn jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare g outreach_webchat_ai_suggestions%rowtype; ans text := nullif(btrim(coalesce(p_turn->>'answer', '')), ''); conf text := coalesce(p_turn->>'confidence', 'high');
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into g from outreach_webchat_ai_suggestions where id = p_suggestion for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  -- the call was made and is paid for whatever happens to the suggestion: it counts against the allowance like an answer
  insert into outreach_ai_calls(workspace_id, purpose, model, tokens_in, tokens_out, latency_ms)
  values (g.workspace_id, 'webchat_answer', p_turn->>'model', (p_turn->>'tokens_in')::int, (p_turn->>'tokens_out')::int, (p_turn->>'latency_ms')::int);
  if g.status <> 'pending' then return jsonb_build_object('ok', false, 'why', g.status); end if;
  if ans is null or conf = 'refused' then
    -- off-topic or nothing to say: no suggestion; the agent answers unaided
    update outreach_webchat_ai_suggestions set status = 'failed', error = case when ans is null then 'no_answer' else 'refused' end, locked_at = null, resolved_at = now(), model = p_turn->>'model' where id = g.id;
    return jsonb_build_object('ok', true, 'status', 'failed');
  end if;
  update outreach_webchat_ai_suggestions set text = left(ans, 20000), sources = coalesce(p_turn->'sources', '[]'::jsonb), confidence = case when conf = 'low' then 'low' else 'high' end,
         model = p_turn->>'model', status = 'waiting', ready_at = now(), locked_at = null, error = null where id = g.id;
  if conf = 'low' then perform outreach_webchat_unanswered_add(g.chat_id, g.message_id, coalesce(p_turn->>'query', '')); end if;
  perform outreach_emit_event(g.workspace_id, 'webchat.suggestion.ready', jsonb_build_object('id', g.id, 'chat_id', g.chat_id, 'inbox_id', g.inbox_id, 'message_id', g.message_id, 'confidence', conf));
  return jsonb_build_object('ok', true, 'status', 'waiting');
end $$;

create or replace function outreach_webchat_v_suggest_fail(p_suggestion uuid, p_error text, p_final boolean default false) returns void
language plpgsql security definer set search_path = public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_webchat_ai_suggestions
     set error = left(p_error, 300), locked_at = null,
         status = case when coalesce(p_final, false) or attempts >= 3 then 'failed' else status end,
         resolved_at = case when coalesce(p_final, false) or attempts >= 3 then now() else resolved_at end
   where id = p_suggestion and status = 'pending';
end $$;

-- used / stale bookkeeping (PRD §4.3 step 4). The agent's message names the suggestion it came from under
-- content_attributes.internal.suggestion_id (`internal` never reaches the widget).
create or replace function outreach_webchat_trg_suggestion_state() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare sid uuid; raw text;
begin
  if new.direction = 'in' and new.sender_type = 'visitor' then
    update outreach_webchat_ai_suggestions set status = 'stale', resolved_at = now() where chat_id = new.chat_id and status in ('pending', 'waiting');
  elsif new.direction = 'out' and new.sender_type = 'agent' then
    raw := new.content_attributes#>>'{internal,suggestion_id}';
    if raw ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then sid := raw::uuid; end if;
    if sid is not null then
      update outreach_webchat_ai_suggestions set status = 'used', used_message_id = new.id, resolved_by = new.sent_by, resolved_at = now(), away_at = coalesce(away_at, now())
       where id = sid and chat_id = new.chat_id and status in ('waiting', 'expired');
    end if;
    update outreach_webchat_ai_suggestions set status = 'stale', resolved_at = now() where chat_id = new.chat_id and status in ('pending', 'waiting');
    -- a person answered: no away message is owed for anything asked before
    update outreach_webchat_ai_suggestions set away_at = now() where chat_id = new.chat_id and away_at is null;
  end if;
  return null;
end $$;
drop trigger if exists outreach_webchat_suggestion_state on outreach_messages;
create trigger outreach_webchat_suggestion_state after insert on outreach_messages
  for each row when (new.sender_type in ('visitor', 'agent')) execute function outreach_webchat_trg_suggestion_state();

-- Every minute (064): give up on suggestions that could not be written, and after review_timeout_min without an agent's
-- reply behave like the website's away settings: say the team will get back, ask for the email once. Never sends the
-- suggestion itself (PRD §4.3 step 5).
create or replace function outreach_webchat_review_sweep() returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; st jsonb; v outreach_webchat_visitors%rowtype; msg text; failed int; expired int := 0; away int := 0; ask boolean;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update outreach_webchat_ai_suggestions set status = 'failed', error = coalesce(error, 'not written after three tries'), locked_at = null, resolved_at = now()
   where status = 'pending' and attempts >= 3 and (locked_at is null or locked_at < now() - interval '90 seconds');
  get diagnostics failed = row_count;
  for r in
    select x.chat_id, x.first_at, c.workspace_id, c.webchat_inbox_id, c.visitor_id, c.status
      from (select g.chat_id, min(g.created_at) first_at from outreach_webchat_ai_suggestions g
             where g.away_at is null and g.status <> 'used' and g.created_at > now() - interval '1 day' group by g.chat_id) x
      join outreach_chats c on c.id = x.chat_id
  loop
    st := outreach_webchat__settings(r.webchat_inbox_id);
    if r.first_at > now() - make_interval(mins => greatest(1, least(240, coalesce(nullif(st#>>'{ai,review_timeout_min}', '')::int, 10)))) then continue; end if;
    if r.status in ('open', 'pending')
       and not exists (select 1 from outreach_messages m where m.chat_id = r.chat_id and m.direction = 'out' and m.sender_type = 'agent' and m.created_at > r.first_at) then
      select * into v from outreach_webchat_visitors where id = r.visitor_id;
      msg := coalesce(nullif(btrim(st#>>'{messages,handoff_offline_message}'), ''), st#>>'{messages,unavailable_message}');
      -- the email is asked for once per conversation (the same rule outreach_webchat_v_message applies when nobody is online)
      ask := v.email is null and coalesce((st#>>'{features,email_capture}')::boolean, true)
             and not exists (select 1 from outreach_messages m where m.chat_id = r.chat_id and m.content_type = 'form' and m.content_attributes->>'form' = 'email');
      if msg is not null then
        insert into outreach_messages(workspace_id, chat_id, direction, text, sent_at, content_type, content_attributes, sender_type, sender_name, source, origin)
        values (r.workspace_id, r.chat_id, 'out', msg, now(), case when ask then 'form' else 'text' end,
                case when ask then jsonb_build_object('form', 'email', 'prompt', msg, 'review_timeout', true) else jsonb_build_object('review_timeout', true) end,
                'bot', st#>>'{appearance,brand_name}', 'bot', 'ai_autopilot');
        away := away + 1;
      end if;
    end if;
    update outreach_webchat_ai_suggestions set status = case when status in ('pending', 'waiting') then 'expired' else status end,
           resolved_at = coalesce(resolved_at, now()), away_at = now()
     where chat_id = r.chat_id and away_at is null;
    expired := expired + 1;
  end loop;
  return jsonb_build_object('not_written', failed, 'chats_timed_out', expired, 'away_messages', away);
end $$;

-- ===============================================================================================================
-- 4. Patches to existing functions (in place)
-- ===============================================================================================================
-- ---- Personalized lines
select outreach_hub__patch('public.outreach_ai_generate_request(uuid,uuid,uuid[],uuid,boolean)', 'E_AI_VARIABLE_OFF', array[
  $a$  if not found then raise exception 'E_NOT_FOUND: variable'; end if;$a$,
  $b$  if not found then raise exception 'E_NOT_FOUND: variable'; end if;
  if v.mode = 'off' then raise exception 'E_AI_VARIABLE_OFF: "%" is switched off. Turn it on under AI → Setup → Personalized lines to write new lines', v.name; end if;$b$]);

select outreach_hub__patch('public.outreach_ai_value_result(uuid,text,jsonb,text,text)', 'generated_at', array[
  $a$locked_at = null, updated_at = now(),$a$,
  $b$locked_at = null, updated_at = now(), generated_at = case when p_error is null then now() else generated_at end,$b$]);

select outreach_hub__patch('public.outreach_ai_review(uuid[],text,text)', 'var_mode', array[
  $a$v.text, var.max_chars from outreach_ai_values v$a$,
  $b$v.text, var.max_chars, var.mode as var_mode from outreach_ai_values v$b$,
  $a$update outreach_ai_values set status = 'pending', attempts = 0, text = null, facts = '[]', error = null, edited = false, approved_by = null, approved_at = null, locked_at = null, updated_at = now() where id = x.id;$a$,
  $b$if x.var_mode = 'off' then raise exception 'E_AI_VARIABLE_OFF: this variable is switched off, so its lines cannot be written again. Turn it on under AI → Setup → Personalized lines'; end if;
      update outreach_ai_values set status = 'pending', attempts = 0, text = null, facts = '[]', error = null, edited = false, approved_by = null, approved_at = null, locked_at = null, updated_at = now() where id = x.id;$b$]);

-- ---- Replies: a reply the AI hands to a person is a card in Needs you, not a task (PRD §8.4). Callers keep working.
create or replace function outreach__ai_escalation_task(p_run uuid) returns uuid
language sql security definer set search_path = public, extensions as $$ select null::uuid $$;

-- ---- Q&A: replies read the shared library next to the prompt's own pairs
select outreach_hub__patch('public.outreach_ai_reply_gate_facts(uuid)', 'outreach_hub__qa_applies', array[
  $a$into faqs from outreach_master_prompt_faqs f where f.master_prompt_id = mpid and f.enabled;$a$,
  $b$into faqs from outreach_master_prompt_faqs f where f.enabled and (f.master_prompt_id = mpid or (f.master_prompt_id is null and f.workspace_id = r.workspace_id and outreach_hub__qa_applies(f.id, 'sequence', c.reply_sequence_id)));$b$,
  $a$scen := '[]'::jsonb; faqs := '[]'::jsonb;$a$,
  $b$scen := '[]'::jsonb; faqs := outreach_knowledge_qa_for(r.workspace_id, 'sequence', c.reply_sequence_id, null);$b$]);

-- ---- Unanswered questions: a reply's question joins a website-only group of the same client instead of duplicating it
select outreach_hub__patch('public.outreach_ai_unanswered_add(uuid,text,text,uuid)', $m$array_append(origins, 'reply')$m$, array[
  $a$from outreach_ai_unanswered_questions where sequence_id = r.sequence_id and (norm = nrm or similarity(norm, nrm) >= 0.6)$a$,
  $b$from outreach_ai_unanswered_questions where (sequence_id = r.sequence_id or (sequence_id is null and workspace_id = r.workspace_id and (select w.client_id from outreach_webchat_inboxes w where w.id = inbox_id) is not distinct from r.client_id)) and (norm = nrm or similarity(norm, nrm) >= 0.6)$b$,
  $a$status = case when status = 'answered' then 'open' else status end, master_prompt_id = coalesce(master_prompt_id, mpid)$a$,
  $b$status = case when status = 'answered' then 'open' else status end, master_prompt_id = coalesce(master_prompt_id, mpid), origins = case when 'reply' = any(origins) then origins else array_append(origins, 'reply') end$b$]);

-- ---- Knowledge: removing a source also takes it off the websites that use it
select outreach_hub__patch('public.outreach_knowledge_source_delete(uuid)', 'outreach_webchat_inboxes', array[
  $a$  delete from outreach_knowledge_sources where id = p_id;$a$,
  $b$  update outreach_webchat_inboxes i
     set settings = jsonb_set(i.settings, '{ai,knowledge_source_ids}', (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements_text(i.settings#>'{ai,knowledge_source_ids}') x where x <> p_id::text)),
         config_version = i.config_version + 1
   where i.workspace_id = s.workspace_id and jsonb_typeof(i.settings#>'{ai,knowledge_source_ids}') = 'array' and (i.settings#>'{ai,knowledge_source_ids}') ? p_id::text;
  delete from outreach_knowledge_sources where id = p_id;$b$]);

-- ---- Website assistant: Review mode
select outreach_hub__patch('public.outreach_webchat_default_settings()', 'review_timeout_min', array[
  $a$"show_sources": true, "hourly_cap_per_visitor": 30$a$,
  $b$"show_sources": true, "hourly_cap_per_visitor": 30, "review_timeout_min": 10$b$]);

select outreach_hub__patch('public.outreach_webchat_inbox_update(uuid,jsonb)', $m$'offline_only','review'$m$, array[
  $a$not in ('off','first','offline_only') then raise exception 'E_PAYLOAD_INVALID: ai.mode'; end if;$a$,
  $b$not in ('off','first','offline_only','review') then raise exception 'E_PAYLOAD_INVALID: ai.mode'; end if;
    if ns#>>'{ai,review_timeout_min}' is not null and ((ns#>>'{ai,review_timeout_min}') !~ '^[0-9]{1,3}$' or (ns#>>'{ai,review_timeout_min}')::int not between 1 and 240) then raise exception 'E_PAYLOAD_INVALID: ai.review_timeout_min is 1 to 240 minutes'; end if;$b$]);

-- the visitor never learns the site is on Review: to the widget it is a live chat (ai_mode 'off')
select outreach_hub__patch('public.outreach_webchat__availability(uuid)', $m$<> 'review' then coalesce(st#>>'{ai,mode}', 'off')$m$, array[
  $a$'ai_mode', case when i.ai_enabled then coalesce(st#>>'{ai,mode}', 'off') else 'off' end);$a$,
  $b$'ai_mode', case when i.ai_enabled and coalesce(st#>>'{ai,mode}', 'off') <> 'review' then coalesce(st#>>'{ai,mode}', 'off') else 'off' end);$b$]);

select outreach_hub__patch('public.outreach_webchat_public_config(text,text)', $m$<> 'review' then st#>'{ai,mode}'$m$, array[
  $a$'mode', case when i.ai_enabled then st#>'{ai,mode}' else '"off"'::jsonb end$a$,
  $b$'mode', case when i.ai_enabled and coalesce(st#>>'{ai,mode}', 'off') <> 'review' then st#>'{ai,mode}' else '"off"'::jsonb end$b$]);

select outreach_hub__patch('public.outreach_webchat_v_conversation_start(uuid,uuid,jsonb,text,jsonb)', 'the stored mode', array[
  $a$  mode := av->>'ai_mode';$a$,
  $b$  mode := case when i.ai_enabled then coalesce(st#>>'{ai,mode}', 'off') else 'off' end;   -- the stored mode: availability hides 'review' from the widget$b$]);

select outreach_hub__patch('public.outreach_webchat_v_message(uuid,uuid,text,text,jsonb,text,jsonb,text)', 'outreach_webchat__suggest_open', array[
  $a$in_seq boolean; pool jsonb; new_id uuid;$a$,
  $b$in_seq boolean; pool jsonb; new_id uuid; suggest uuid;$b$,
  $a$if ctype = 'text' and c.handed_off_at is null and coalesce(c.ai_mode, 'off') <> 'off' and i.ai_enabled then$a$,
  $b$if ctype = 'text' and c.handed_off_at is null and coalesce(c.ai_mode, 'off') not in ('off', 'review') and i.ai_enabled then$b$,
  $a$  -- nobody online, unknown visitor: ask for the email once (PRD §5.6)$a$,
  $b$  -- Review mode (AI hub §4.3): the assistant drafts an answer for the agent; the visitor waits for a person
  if ctype = 'text' and btrim(txt) <> '' and c.handed_off_at is null and coalesce(c.ai_mode, 'off') = 'review' and i.ai_enabled then
    suggest := outreach_webchat__suggest_open(c.id, m.id);
  end if;
  -- nobody online, unknown visitor: ask for the email once (PRD §5.6)$b$,
  $a$if not ai and coalesce(c.ai_mode, 'off') = 'off' and c.assigned_to is null then perform outreach_webchat__auto_assign(c.id); end if;$a$,
  $b$if not ai and coalesce(c.ai_mode, 'off') in ('off', 'review') and c.assigned_to is null then perform outreach_webchat__auto_assign(c.id); end if;$b$,
  $a$'dropped', false, 'reopened', reopened, 'new_conversation', newconv);$a$,
  $b$'dropped', false, 'reopened', reopened, 'new_conversation', newconv, 'suggest', suggest);$b$]);

-- the public /chat endpoint never answers a Review chat; the assistant reads the shared Q&A that applies to the website
select outreach_hub__patch('public.outreach_webchat_v_ai_context(uuid,uuid)', 'outreach_knowledge_qa_for', array[
  $a$'ok', c.handed_off_at is null and not agent_after and coalesce(c.ai_mode, 'off') <> 'off' and i.ai_enabled,$a$,
  $b$'ok', c.handed_off_at is null and not agent_after and coalesce(c.ai_mode, 'off') not in ('off', 'review') and i.ai_enabled,$b$,
  $a$'visitor_email', (select email from outreach_webchat_visitors where id = c.visitor_id));$a$,
  $b$'visitor_email', (select email from outreach_webchat_visitors where id = c.visitor_id),
    'qa', outreach_knowledge_qa_for(c.workspace_id, 'website', i.id, q.text));$b$]);

-- a low-confidence answer is a question the knowledge does not cover
select outreach_hub__patch('public.outreach_webchat_v_ai_record(uuid,uuid,jsonb)', 'outreach_webchat_unanswered_add', array[
  $a$  update outreach_chats set ai_handled = true where id = c.id and handed_off_at is null;$a$,
  $b$  if p_turn->>'confidence' = 'low' then perform outreach_webchat_unanswered_add(c.id, p_message, coalesce(p_turn->>'query', '')); end if;
  update outreach_chats set ai_handled = true where id = c.id and handed_off_at is null;$b$]);

-- in Review the agent's reply is the whole point: it does not stop the assistant ("Stop the AI" in the thread bar still does)
select outreach_hub__patch('public.outreach_webchat_trg_message_side_effects()', $m$ai_mode not in ('off', 'review')$m$, array[
  $a$where id = c.id and ai_mode is not null and ai_mode <> 'off' and handed_off_at is null;$a$,
  $b$where id = c.id and ai_mode is not null and ai_mode not in ('off', 'review') and handed_off_at is null;$b$]);

-- ---- Names and counts in server-side copy
select outreach_hub__patch('public.outreach_dashboard(uuid)', $m$t.kind not in ('review_ai_draft', 'ai_escalation')$m$, array[
  $a$'tasks_open', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and outreach_client_visible(p_ws, t.client_id)),$a$,
  $b$'tasks_open', (select count(*) from outreach_tasks t where t.workspace_id = p_ws and t.completed_at is null and t.kind not in ('review_ai_draft', 'ai_escalation') and outreach_client_visible(p_ws, t.client_id)),$b$]);

-- the page names 050 wrote into two functions ("AI Personalization"; "AI review" on a database that never got 050)
do $$
declare def text := replace(pg_get_functiondef('public.outreach_dashboard(uuid)'::regprocedure), chr(13), '');
begin
  if position('Personalized lines are waiting for you' in def) = 0 then
    def := replace(def, $q$'AI Personalization lines are waiting for review'$q$, $q$'Personalized lines are waiting for you'$q$);
    def := replace(def, $q$'AI lines are waiting for review'$q$, $q$'Personalized lines are waiting for you'$q$);
    if position('Personalized lines are waiting for you' in def) = 0 then raise exception '063: outreach_dashboard: ai_review attention reason not found'; end if;
    execute def;
  end if;
end $$;

do $$
declare def text := replace(pg_get_functiondef('public.outreach_why_not_sending(uuid,uuid,uuid)'::regprocedure), chr(13), '');
begin
  if position('Open AI → Needs you' in def) = 0 then
    def := replace(def, $q$'remedy','Open AI Personalization and approve, edit or skip it.'$q$, $q$'remedy','Open AI → Needs you and approve, edit or skip it.'$q$);
    def := replace(def, $q$'remedy','Open AI review and approve, edit or skip it.'$q$, $q$'remedy','Open AI → Needs you and approve, edit or skip it.'$q$);
    def := replace(def, $q$'remedy','Open AI Personalization.'$q$, $q$'remedy','Open AI → Needs you.'$q$);
    def := replace(def, $q$'remedy','Open AI review.'$q$, $q$'remedy','Open AI → Needs you.'$q$);
    if position('Open AI → Needs you and approve' in def) = 0 or position($q$'Open AI → Needs you.'$q$ in def) = 0 then
      raise exception '063: outreach_why_not_sending: W_WAITING_AI_REVIEW remedies not found';
    end if;
    execute def;
  end if;
end $$;

-- ===============================================================================================================
-- 5. Tasks: escalation tasks move to Needs you
-- ===============================================================================================================
update outreach_tasks
   set completed_at = now(), result = coalesce(result, '{}'::jsonb) || jsonb_build_object('completed_reason', 'moved_to_needs_you', 'note', 'Moved to AI → Needs you', 'at', now())
 where kind = 'ai_escalation' and completed_at is null;

-- ===============================================================================================================
-- 6. Grants
-- ===============================================================================================================
do $$
declare f record;
  app_fns text[] := array[
    'outreach_hub_needs_you_counts', 'outreach_hub_setup', 'outreach_hub_variable_set_mode', 'outreach_hub_reply_dismiss',
    'outreach_hub_qa_list', 'outreach_hub_qa_save', 'outreach_hub_qa_delete', 'outreach_hub_question_answer', 'outreach_hub_question_dismiss',
    'outreach_hub_knowledge', 'outreach_hub_knowledge_link', 'outreach_hub_website_set_mode'];
  svc_fns text[] := array[
    'outreach_hub__qa_applies', 'outreach_hub__qa_targets', 'outreach_hub__qa_check_targets', 'outreach_hub__question_for', 'outreach_hub_trg_faq_workspace',
    'outreach_hub_trg_variable_mode', 'outreach_knowledge_qa_for', 'outreach__ai_faqs_for', 'outreach__ai_escalation_task', 'outreach_webchat_unanswered_add',
    'outreach_webchat__suggest_open', 'outreach_webchat_v_suggest_context', 'outreach_webchat_v_suggest_take', 'outreach_webchat_suggest_claim',
    'outreach_webchat_v_suggest_record', 'outreach_webchat_v_suggest_fail', 'outreach_webchat_trg_suggestion_state', 'outreach_webchat_review_sweep'];
begin
  for f in select p.oid::regprocedure::text as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and (p.proname = any(app_fns) or p.proname = any(svc_fns)) loop
    execute format('revoke all on function %s from public, anon', f.sig);
    if f.proname = any(app_fns) then execute format('grant execute on function %s to authenticated', f.sig);
    else execute format('revoke all on function %s from authenticated', f.sig); end if;
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

drop function if exists outreach_hub__patch(text, text, text[]);
