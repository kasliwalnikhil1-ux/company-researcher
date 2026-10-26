-- =============================================================================
-- 101 — Sequence lead filters, bulk unenroll & Analytics
--        (PRD Sequence lead filters, bulk unenroll & Analytics.md, 26 Oct 2026)
--
-- What this adds
--   1. outreach_enrollment_status_log — every status change of an enrolment: previous → new status, the step the lead
--      was on, who did it (a teammate, or the system) and why. Written by a BEFORE trigger on outreach_enrollments,
--      which also keeps status_changed_by / status_changed_at on the row (the "Stopped by" column and the teammate
--      sub-filter read the row; the Team section of Analytics reads the log).
--   2. outreach_step_runs — one row per step outcome with the sender and the time: sent / skipped / failed (from
--      outreach_actions), accepted (invitation accepted while the lead waited on the invite step), read (read
--      receipt on a step's message), replied (first reply, credited to the last step that went out). The Analytics
--      step table, the daily chart, the sender table and the sent / read snippets read this.
--   3. outreach_sequence_daily_plan — planned actions per sequence, sender and day, snapshotted every hour
--      (greatest of the hour's counts, so actions deferred to tomorrow still count as planned today). The planned
--      vs sent chart's baseline; days before the snapshot fall back to scheduled_for.
--   4. RPCs: outreach_sequence_lead_counts (one count per filter option + teammates), outreach_sequence_leads (the
--      paginated table with progress / next step / last message / reply / stopped by), outreach_sequence_bulk
--      (unenroll · pause · resume on ids or on everything matching a filter, 500 a call, one batch id across calls),
--      outreach_sequence_bulk_undo (restores status, schedule and the cancelled queued actions, 15 minutes),
--      outreach_sequence_analytics (the seven sections), outreach_sequence_analytics_leads (section 7, paginated).
--
-- Status vocabulary (label-only renames; stored keys unchanged)
--   Live = active · waiting_delay · waiting_connection · waiting_task · paused
--   Active = active + waiting_delay ("Waiting", the Delay-step wait, is folded into Active: open question 2)
--   Invite sent = waiting_connection (the engine sets it the moment the invitation goes out, so "Waiting to connect"
--   and "Invite sent" were one thing: open question 1 → merged)
--   Waiting on a task = waiting_task · Paused = paused · Finished = completed · Human handoff = exited_replied
--   Stopped by teammate = exited_manual · Sender disabled = exited_sender_disabled · Failed = failed
--   Unenrolled = cancelled (never written before this migration; bulk / row Unenroll writes it with reason 'unenrolled')
--   Do not contact = exited_suppressed (not an option any more; still in All)
-- Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/101_sequence_leads_analytics.sql
-- Then: bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_31_sequence_leads_analytics.sql
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Status log
-- -----------------------------------------------------------------------------
alter table outreach_enrollments add column if not exists status_changed_by uuid;
alter table outreach_enrollments add column if not exists status_changed_at timestamptz;
create index if not exists outreach_enr_seq_status_by_idx on outreach_enrollments(sequence_id, status, status_changed_by);

create table if not exists outreach_enrollment_status_log (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null,
  sequence_id   uuid not null,
  enrollment_id uuid not null references outreach_enrollments(id) on delete cascade,
  lead_id       uuid not null,
  sender_id     uuid,
  node_id       text,
  prev_status   outreach_enrollment_status_t,                -- null = enrolled
  new_status    outreach_enrollment_status_t not null,
  actor         uuid,                                        -- auth.uid() of the teammate, null for the system
  actor_type    text not null check (actor_type in ('user','system')),
  reason        text,
  batch_id      uuid,
  at            timestamptz not null default now()
);
create index if not exists outreach_esl_seq_at_idx     on outreach_enrollment_status_log(sequence_id, at desc);
create index if not exists outreach_esl_enr_idx        on outreach_enrollment_status_log(enrollment_id, at);
create index if not exists outreach_esl_seq_status_idx on outreach_enrollment_status_log(sequence_id, new_status, actor);
alter table outreach_enrollment_status_log enable row level security;
revoke all on outreach_enrollment_status_log from public, anon, authenticated;
grant select on outreach_enrollment_status_log to service_role;

-- The current bulk batch (set_config local to the transaction) so the log can tie rows to the batch and its reason.
create or replace function outreach__batch_ctx() returns table(batch_id uuid, reason text)
language sql stable as $$
  select nullif(current_setting('outreach.batch_id', true), '')::uuid, nullif(current_setting('outreach.batch_reason', true), '')
$$;
revoke execute on function outreach__batch_ctx() from public, anon, authenticated;

create or replace function outreach_trg_enrollment_status_log() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare b record; uid uuid := auth.uid();
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then return new; end if;
  select * into b from outreach__batch_ctx();
  new.status_changed_by := uid;
  new.status_changed_at := now();
  insert into outreach_enrollment_status_log(workspace_id, sequence_id, enrollment_id, lead_id, sender_id, node_id, prev_status, new_status, actor, actor_type, reason, batch_id)
  values (new.workspace_id, new.sequence_id, new.id, new.lead_id, new.sender_id, new.current_node_id,
          case when tg_op = 'UPDATE' then old.status end, new.status, uid, case when uid is null then 'system' else 'user' end,
          coalesce(b.reason, case when new.status in ('completed','exited_replied','exited_manual','exited_suppressed','exited_sender_disabled','failed','cancelled') then new.exit_reason end),
          b.batch_id);
  return new;
exception when others then
  -- the log never blocks the engine
  return new;
end $$;
drop trigger if exists outreach_enr_aa_status_log on outreach_enrollments;
create trigger outreach_enr_aa_status_log before insert or update of status on outreach_enrollments
  for each row execute function outreach_trg_enrollment_status_log();

-- -----------------------------------------------------------------------------
-- 2. Step runs
-- -----------------------------------------------------------------------------
create table if not exists outreach_step_runs (
  id            bigint generated always as identity primary key,
  workspace_id  uuid not null,
  sequence_id   uuid not null,
  node_id       text not null,
  enrollment_id uuid not null references outreach_enrollments(id) on delete cascade,
  lead_id       uuid not null,
  sender_id     uuid,                                        -- no FK: runs survive an erased sender
  variant_id    text,                                        -- A/B variant of the step (hidden column of the step table)
  outcome       text not null check (outcome in ('sent','accepted','read','replied','skipped','failed')),
  action_id     uuid,
  at            timestamptz not null default now()
);
create index if not exists outreach_step_runs_seq_at_idx   on outreach_step_runs(sequence_id, at);
create index if not exists outreach_step_runs_seq_node_idx on outreach_step_runs(sequence_id, node_id, outcome);
create index if not exists outreach_step_runs_enr_idx      on outreach_step_runs(enrollment_id);
create unique index if not exists outreach_step_runs_action_uq on outreach_step_runs(action_id, outcome) where action_id is not null;
create unique index if not exists outreach_step_runs_once_uq   on outreach_step_runs(enrollment_id, outcome) where outcome in ('accepted','replied');
alter table outreach_step_runs enable row level security;
revoke all on outreach_step_runs from public, anon, authenticated;
grant select on outreach_step_runs to service_role;

create or replace function outreach__step_run(p_enrollment uuid, p_node text, p_outcome text, p_at timestamptz, p_action uuid default null, p_sender uuid default null, p_variant text default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare e record;
begin
  if p_enrollment is null or p_node is null then return; end if;
  select workspace_id, sequence_id, lead_id, sender_id into e from outreach_enrollments where id = p_enrollment;
  if not found then return; end if;
  insert into outreach_step_runs(workspace_id, sequence_id, node_id, enrollment_id, lead_id, sender_id, variant_id, outcome, action_id, at)
  values (e.workspace_id, e.sequence_id, p_node, p_enrollment, e.lead_id, coalesce(p_sender, e.sender_id), p_variant, p_outcome, p_action, coalesce(p_at, now()))
  on conflict do nothing;
end $$;
revoke execute on function outreach__step_run(uuid, text, text, timestamptz, uuid, uuid, text) from public, anon, authenticated;

-- sent / skipped / failed: from the action
create or replace function outreach_trg_step_run_action() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  if new.status in ('sent','skipped','failed') and new.status is distinct from old.status and new.enrollment_id is not null and new.node_id is not null
     and not coalesce((new.payload->>'prefetch')::boolean, false) and not coalesce((new.payload->>'subtask')::boolean, false) then
    perform outreach__step_run(new.enrollment_id, new.node_id, new.status::text, coalesce(new.executed_at, now()), new.id, new.sender_id, new.variant_id);
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists outreach_actions_zy_step_run on outreach_actions;
create trigger outreach_actions_zy_step_run after update of status on outreach_actions for each row execute function outreach_trg_step_run_action();

-- accepted: relation → first while the lead waits on the invite / follow step, credited to the step that sent it. Named to fire BEFORE outreach_lss_relation
-- (triggers of one event fire in name order), which advances the enrolment off the step.
create or replace function outreach_trg_step_run_accept() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r record; nid text;
begin
  if new.relation = 'first' and coalesce(old.relation::text, 'none') <> 'first' then
    for r in select e.id, e.current_node_id from outreach_enrollments e
              where e.lead_id = new.lead_id and e.sender_id = new.sender_id and e.status = 'waiting_connection' loop
      -- credited to the step that sent the invitation / follow (the Invite row of the step table), else the wait step
      select a.node_id into nid from outreach_actions a where a.enrollment_id = r.id and a.status = 'sent' and a.action_type in ('invite','follow') and a.node_id is not null order by a.executed_at desc nulls last limit 1;
      perform outreach__step_run(r.id, coalesce(nid, r.current_node_id), 'accepted', coalesce(new.invite_accepted_at, new.invite_detected_at, now()), null, new.sender_id);
    end loop;
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists outreach_lss_a_step_run_accept on outreach_lead_sender_state;
create trigger outreach_lss_a_step_run_accept after update of relation on outreach_lead_sender_state for each row execute function outreach_trg_step_run_accept();

-- replied: the first reply of a live enrolment, credited to the last step that went out to the lead (falls back to the
-- current step). Fires BEFORE outreach_lss_reply_exit for the same reason. Counts whether or not the reply stops the lead.
create or replace function outreach_trg_step_run_reply() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare r record; ws uuid; at_ts timestamptz; nid text;
begin
  if not (new.replied and (not coalesce(old.replied, false) or new.last_inbound_at is distinct from old.last_inbound_at)) then return new; end if;
  select workspace_id into ws from outreach_senders where id = new.sender_id;
  at_ts := coalesce(new.last_inbound_at, now());
  for r in select e.id, e.current_node_id, e.created_at, e.reply_ignored_before from outreach_enrollments e
            where e.lead_id = new.lead_id and e.workspace_id = ws
              and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused') loop
    if at_ts < coalesce(r.reply_ignored_before, r.created_at) then continue; end if;
    select a.node_id into nid from outreach_actions a where a.enrollment_id = r.id and a.status = 'sent' and a.node_id is not null
       and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
     order by a.executed_at desc nulls last limit 1;
    perform outreach__step_run(r.id, coalesce(nid, r.current_node_id), 'replied', at_ts, null, new.sender_id);
  end loop;
  return new;
exception when others then return new;
end $$;
drop trigger if exists outreach_lss_a_step_run_reply on outreach_lead_sender_state;
create trigger outreach_lss_a_step_run_reply after update of replied, last_inbound_at on outreach_lead_sender_state for each row execute function outreach_trg_step_run_reply();

-- read: a read receipt on a message a step sent
create or replace function outreach_trg_step_run_read() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare a record;
begin
  if new.read_at is not null and old.read_at is null and new.action_id is not null and new.direction = 'out' then
    select enrollment_id, node_id, sender_id, variant_id into a from outreach_actions where id = new.action_id;
    if found and a.enrollment_id is not null then perform outreach__step_run(a.enrollment_id, a.node_id, 'read', new.read_at, new.action_id, a.sender_id, a.variant_id); end if;
  end if;
  return new;
exception when others then return new;
end $$;
drop trigger if exists outreach_messages_zy_step_run_read on outreach_messages;
create trigger outreach_messages_zy_step_run_read after update of read_at on outreach_messages for each row execute function outreach_trg_step_run_read();

-- -----------------------------------------------------------------------------
-- 3. Planned actions per sequence, sender and day
-- -----------------------------------------------------------------------------
create table if not exists outreach_sequence_daily_plan (
  sequence_id uuid not null references outreach_sequences(id) on delete cascade,
  sender_id   uuid not null,
  day         date not null,                                 -- in the workspace timezone
  planned     int  not null default 0,
  updated_at  timestamptz not null default now(),
  primary key (sequence_id, sender_id, day)
);
alter table outreach_sequence_daily_plan enable row level security;
revoke all on outreach_sequence_daily_plan from public, anon, authenticated;
grant select on outreach_sequence_daily_plan to service_role;

-- Hourly: for every sequence with actions scheduled today (workspace day), keep the highest count seen today.
create or replace function outreach_plan_snapshot() returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int;
begin
  with x as (
    select e.sequence_id, a.sender_id, (a.scheduled_for at time zone outreach_ws_tz(a.workspace_id))::date as day, count(*) as planned
      from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
     where a.status in ('queued','reserved','sent','skipped','failed')
       and a.scheduled_for >= now() - interval '2 days' and a.scheduled_for < now() + interval '2 days'
       and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
       and (a.scheduled_for at time zone outreach_ws_tz(a.workspace_id))::date = (now() at time zone outreach_ws_tz(a.workspace_id))::date
     group by 1, 2, 3)
  insert into outreach_sequence_daily_plan(sequence_id, sender_id, day, planned)
  select sequence_id, sender_id, day, planned from x
  on conflict (sequence_id, sender_id, day) do update set planned = greatest(outreach_sequence_daily_plan.planned, excluded.planned), updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke execute on function outreach_plan_snapshot() from public, anon, authenticated;
select cron.schedule('outreach-plan-snapshot', '7 * * * *', $$select outreach_plan_snapshot()$$);

-- -----------------------------------------------------------------------------
-- 4. The filter vocabulary (one place) and the lead-list predicate
-- -----------------------------------------------------------------------------
create or replace function outreach__lead_filter_statuses(p_filter text) returns outreach_enrollment_status_t[]
language sql immutable as $$
  select case p_filter
    when 'live'                then array['active','waiting_connection','waiting_delay','waiting_task','paused']::outreach_enrollment_status_t[]
    when 'all'                 then null
    when 'active'              then array['active','waiting_delay']::outreach_enrollment_status_t[]
    when 'invite_sent'         then array['waiting_connection']::outreach_enrollment_status_t[]
    when 'waiting_task'        then array['waiting_task']::outreach_enrollment_status_t[]
    when 'paused'              then array['paused']::outreach_enrollment_status_t[]
    when 'completed'           then array['completed']::outreach_enrollment_status_t[]
    when 'handoff'             then array['exited_replied']::outreach_enrollment_status_t[]
    when 'stopped_by_teammate' then array['exited_manual']::outreach_enrollment_status_t[]
    when 'sender_disabled'     then array['exited_sender_disabled']::outreach_enrollment_status_t[]
    when 'failed'              then array['failed']::outreach_enrollment_status_t[]
    when 'unenrolled'          then array['cancelled']::outreach_enrollment_status_t[]
    when 'stopped'             then array['exited_manual','exited_sender_disabled','exited_suppressed']::outreach_enrollment_status_t[]
    when 'do_not_contact'      then array['exited_suppressed']::outreach_enrollment_status_t[]
    else null end
$$;

create or replace function outreach__sequence_access(p_sequence uuid, p_min text default 'client_viewer') returns outreach_sequences
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then perform outreach_require(s.workspace_id, p_min); end if;
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  return s;
end $$;
revoke execute on function outreach__sequence_access(uuid, text) from public, anon, authenticated;

-- The enrolments one filter names (ids only). p_from / p_to = enrolled in that window (workspace days), the link from Analytics.
create or replace function outreach__sequence_lead_ids(p_sequence uuid, p_filter text, p_teammate uuid, p_from date, p_to date, p_search text)
returns table(enrollment_id uuid) language plpgsql stable security definer set search_path = public, extensions as $$
declare sts outreach_enrollment_status_t[] := outreach__lead_filter_statuses(coalesce(p_filter, 'live')); b record; ws uuid; q text;
begin
  if coalesce(p_filter, 'live') not in ('live','all','active','invite_sent','waiting_task','paused','completed','handoff','stopped_by_teammate','sender_disabled','failed','unenrolled','stopped','do_not_contact') then
    raise exception 'E_PAYLOAD_INVALID: unknown filter %', p_filter;
  end if;
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  select * into b from outreach__stats_cohort_bounds(ws, p_from, p_to);
  q := nullif(trim(coalesce(p_search, '')), '');
  return query
    select e.id from outreach_enrollments e
     where e.sequence_id = p_sequence
       and (sts is null or e.status = any(sts))
       and (p_teammate is null or e.status_changed_by = p_teammate)
       and (b.f_ts is null or (e.created_at >= b.f_ts and e.created_at < b.t_ts))
       and (q is null or exists (select 1 from outreach_leads l where l.id = e.lead_id
                                   and (l.full_name ilike '%' || q || '%' or l.company ilike '%' || q || '%' or l.public_identifier ilike '%' || q || '%' or l.email_work::text ilike '%' || q || '%')));
end $$;
revoke execute on function outreach__sequence_lead_ids(uuid, text, uuid, date, date, text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 5. Counts: one number per filter option, plus the teammates behind "Stopped by teammate"
-- -----------------------------------------------------------------------------
create or replace function outreach_sequence_lead_counts(p_sequence uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; b record; c jsonb; team jsonb;
begin
  s := outreach__sequence_access(p_sequence, 'client_viewer');
  select * into b from outreach__stats_cohort_bounds(s.workspace_id, p_from, p_to);
  with e as (select status, status_changed_by from outreach_enrollments where sequence_id = p_sequence and (b.f_ts is null or (created_at >= b.f_ts and created_at < b.t_ts)))
  select jsonb_build_object(
    'all', count(*),
    'live', count(*) filter (where status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
    'active', count(*) filter (where status in ('active','waiting_delay')),
    'invite_sent', count(*) filter (where status = 'waiting_connection'),
    'waiting_task', count(*) filter (where status = 'waiting_task'),
    'paused', count(*) filter (where status = 'paused'),
    'completed', count(*) filter (where status = 'completed'),
    'handoff', count(*) filter (where status = 'exited_replied'),
    'stopped_by_teammate', count(*) filter (where status = 'exited_manual'),
    'sender_disabled', count(*) filter (where status = 'exited_sender_disabled'),
    'failed', count(*) filter (where status = 'failed'),
    'unenrolled', count(*) filter (where status = 'cancelled'),
    'do_not_contact', count(*) filter (where status = 'exited_suppressed'))
  into c from e;
  select coalesce(jsonb_agg(jsonb_build_object('user_id', x.by, 'name', coalesce(m.display_name, m.email::text, outreach_user_email(x.by), 'Former teammate'), 'count', x.n) order by x.n desc, 2), '[]'::jsonb)
    into team
    from (select status_changed_by as by, count(*) as n from outreach_enrollments
           where sequence_id = p_sequence and status = 'exited_manual' and status_changed_by is not null
             and (b.f_ts is null or (created_at >= b.f_ts and created_at < b.t_ts)) group by 1) x
    left join outreach_members m on m.workspace_id = s.workspace_id and m.user_id = x.by;
  return c || jsonb_build_object('teammates', team, 'stopped_by_system', (select count(*) from outreach_enrollments where sequence_id = p_sequence and status = 'exited_manual' and status_changed_by is null and (b.f_ts is null or (created_at >= b.f_ts and created_at < b.t_ts))));
end $$;
grant execute on function outreach_sequence_lead_counts(uuid, date, date) to authenticated;

-- -----------------------------------------------------------------------------
-- 6. The Leads table: paginated, exact total, with progress / next step / last message / reply / stopped by
-- -----------------------------------------------------------------------------
create or replace function outreach__snippet(p_text text, p_n int default 140) returns text
language sql immutable as $$
  select case when p_text is null then null else left(regexp_replace(trim(p_text), E'\\s+', ' ', 'g'), p_n) end
$$;

create or replace function outreach_sequence_leads(p_sequence uuid, p_filter text default 'live', p_teammate uuid default null, p_from date default null, p_to date default null,
                                                    p_search text default null, p_limit int default 50, p_offset int default 0) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; total bigint; rows_ jsonb; nums jsonb; step_total int; lim int := least(greatest(coalesce(p_limit, 50), 1), 200); off int := greatest(coalesce(p_offset, 0), 0);
begin
  s := outreach__sequence_access(p_sequence, 'client_viewer');
  nums := outreach_graph_step_numbers(s.graph);
  select coalesce(max(value::int), 0) into step_total from jsonb_each_text(nums);
  select count(*) into total from outreach__sequence_lead_ids(p_sequence, p_filter, p_teammate, p_from, p_to, p_search);
  select coalesce(jsonb_agg(r order by r->>'created_at' desc, r->>'id'), '[]'::jsonb) into rows_ from (
    select jsonb_build_object(
      'id', e.id, 'lead_id', e.lead_id, 'sender_id', e.sender_id, 'status', e.status, 'exit_reason', e.exit_reason,
      'current_node_id', e.current_node_id, 'node_entered_at', e.node_entered_at, 'wait_until', e.wait_until, 'created_at', e.created_at, 'completed_at', e.completed_at,
      'held_at', e.held_at, 'hold_reason', e.hold_reason, 'wait_reason', e.wait_reason, 'paused_from', e.paused_from,
      'lead', jsonb_build_object('id', l.id, 'full_name', l.full_name, 'company', l.company, 'headline', l.headline, 'public_identifier', l.public_identifier, 'picture_url', l.picture_url),
      'sender', jsonb_build_object('id', sd.id, 'display_name', sd.display_name, 'status', sd.status),
      -- the step the lead is on; on a wait / delay (no number of its own) the last step that went out
      'step_index', coalesce((nums->>e.current_node_id)::int, (select max((nums->>sr.node_id)::int) from outreach_step_runs sr where sr.enrollment_id = e.id and sr.outcome = 'sent')), 'step_total', step_total,
      'step_label', coalesce(s.graph->'nodes'->e.current_node_id->>'label', initcap(replace(coalesce(s.graph->'nodes'->e.current_node_id->>'type', ''), '_', ' '))),
      'step_type', s.graph->'nodes'->e.current_node_id->>'type',
      'next', case when e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused') then nx.next end,
      'last_message', lm.m, 'last_reply', lr.m,
      'changed_by', case when e.status_changed_by is not null then jsonb_build_object('id', e.status_changed_by, 'name', coalesce(mem.display_name, mem.email::text, outreach_user_email(e.status_changed_by), 'Former teammate')) end,
      'changed_at', e.status_changed_at) as r
    from outreach__sequence_lead_ids(p_sequence, p_filter, p_teammate, p_from, p_to, p_search) ids
    join outreach_enrollments e on e.id = ids.enrollment_id
    left join outreach_leads l on l.id = e.lead_id
    left join outreach_senders sd on sd.id = e.sender_id
    left join outreach_members mem on mem.workspace_id = s.workspace_id and mem.user_id = e.status_changed_by
    left join lateral (
      -- the next thing that happens to this lead: the soonest queued action, else the wait the lead sits in
      select coalesce(
        (select jsonb_build_object('kind', 'action', 'type', a.action_type, 'node_id', a.node_id,
                  'label', coalesce(s.graph->'nodes'->a.node_id->>'label', outreach_action_label(a.action_type::text)), 'at', a.scheduled_for, 'status', a.status)
           from outreach_actions a where a.enrollment_id = e.id and a.status in ('queued','reserved')
            and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
          order by a.scheduled_for limit 1),
        case when e.status = 'waiting_connection' then jsonb_build_object('kind', 'wait', 'type', 'wait_connection', 'label', 'Waiting for the invitation to be accepted', 'at', e.wait_until)
             when e.status = 'waiting_delay' then jsonb_build_object('kind', 'wait', 'type', 'delay', 'label', 'Next step', 'at', e.wait_until, 'node_id', e.current_node_id)
             when e.status = 'waiting_task' then jsonb_build_object('kind', 'task', 'type', coalesce(e.wait_reason, 'task'), 'label', case e.wait_reason when 'enrichment' then 'Waiting for enrichment' when 'ai_review' then 'Waiting for AI review' when 'ai_route' then 'Waiting for the AI route' else 'Waiting on a task' end, 'at', null)
             when e.status = 'paused' then jsonb_build_object('kind', 'paused', 'label', case when e.held_at is not null then 'Held for review' else 'Paused' end, 'at', null)
             else null end) as next) nx on true
    left join lateral (
      select jsonb_build_object('text', outreach__snippet(coalesce(m.text, m.summary)), 'at', m.sent_at, 'chat_id', m.chat_id) as m
        from outreach_messages m join outreach_chats c on c.id = m.chat_id
       where c.lead_id = e.lead_id and c.sender_id = e.sender_id and m.direction = 'out' and m.deleted_at is null and m.sent_at >= e.created_at
       order by m.sent_at desc limit 1) lm on true
    left join lateral (
      select jsonb_build_object('text', outreach__snippet(coalesce(m.text, m.summary)), 'at', m.sent_at, 'chat_id', m.chat_id, 'intent', c.intent) as m
        from outreach_messages m join outreach_chats c on c.id = m.chat_id
       where c.lead_id = e.lead_id and c.sender_id = e.sender_id and m.direction = 'in' and m.deleted_at is null and m.sent_at >= e.created_at
       order by m.sent_at desc limit 1) lr on true
    order by e.created_at desc, e.id
    limit lim offset off) x;
  return jsonb_build_object('total', total, 'limit', lim, 'offset', off, 'step_total', step_total, 'rows', rows_);
end $$;
grant execute on function outreach_sequence_leads(uuid, text, uuid, date, date, text, int, int) to authenticated;

-- -----------------------------------------------------------------------------
-- 7. Bulk unenroll / pause / resume, with undo
-- -----------------------------------------------------------------------------
create table if not exists outreach_enrollment_undo (
  batch_id           uuid not null,
  enrollment_id      uuid not null references outreach_enrollments(id) on delete cascade,
  workspace_id       uuid not null,
  sequence_id        uuid not null,
  created_by         uuid,
  prev_status        outreach_enrollment_status_t not null,
  prev_paused_from   outreach_enrollment_status_t,
  prev_wait_until    timestamptz,
  prev_node_id       text,
  prev_node_entered  timestamptz,
  prev_exit_reason   text,
  prev_held_at       timestamptz,
  prev_hold_reason   text,
  action_ids         uuid[] not null default '{}',
  at                 timestamptz not null default now(),
  restored_at        timestamptz,
  primary key (batch_id, enrollment_id)
);
create index if not exists outreach_enrollment_undo_at_idx on outreach_enrollment_undo(at);
alter table outreach_enrollment_undo enable row level security;
revoke all on outreach_enrollment_undo from public, anon, authenticated;
grant select on outreach_enrollment_undo to service_role;

-- p_ids: act on these enrolments; p_ids null: on everything p_filter names, p_limit at a time (the caller repeats with the
-- same p_batch until remaining = 0, showing progress). Returns {batch_id, done, skipped, remaining, action}.
create or replace function outreach_sequence_bulk(p_sequence uuid, p_action text, p_ids uuid[] default null, p_filter text default null, p_teammate uuid default null,
                                                   p_from date default null, p_to date default null, p_search text default null, p_batch uuid default null, p_limit int default 500) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences; batch uuid := coalesce(p_batch, gen_random_uuid()); done int := 0; skipped int := 0; remaining bigint := 0; lim int := least(greatest(coalesce(p_limit, 500), 1), 500);
        e outreach_enrollments%rowtype; eid uuid; ids uuid[]; aids uuid[]; uid uuid := auth.uid();
begin
  if p_action not in ('unenroll','pause','resume') then raise exception 'E_PAYLOAD_INVALID: action must be unenroll, pause or resume'; end if;
  s := outreach__sequence_access(p_sequence, 'member');
  if p_ids is not null then
    if array_length(p_ids, 1) > 500 then raise exception 'E_TOO_MANY: max 500 ids per call; pass a filter for more'; end if;
    ids := p_ids;
  else
    if p_filter is null then raise exception 'E_PAYLOAD_INVALID: pass ids or a filter'; end if;
    -- only rows the action can touch, so repeated calls make progress and "remaining" is what is still to do
    select coalesce(array_agg(x.id), '{}') into ids from (
      select i.enrollment_id as id from outreach__sequence_lead_ids(p_sequence, p_filter, p_teammate, p_from, p_to, p_search) i join outreach_enrollments en on en.id = i.enrollment_id
       where case p_action when 'unenroll' then en.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
                           when 'pause' then en.status in ('active','waiting_connection','waiting_delay','waiting_task')
                           else en.status = 'paused' and en.held_at is null end
       order by en.created_at desc limit lim) x;
  end if;

  perform set_config('outreach.batch_id', batch::text, true);
  perform set_config('outreach.batch_reason', case p_action when 'unenroll' then 'unenrolled' else p_action end, true);

  foreach eid in array ids loop
    select * into e from outreach_enrollments where id = eid and sequence_id = p_sequence for update;
    if not found then skipped := skipped + 1; continue; end if;
    if p_action = 'unenroll' then
      if e.status not in ('active','waiting_connection','waiting_delay','waiting_task','paused') then skipped := skipped + 1; continue; end if;
      select coalesce(array_agg(a.id), '{}') into aids from outreach_actions a where a.enrollment_id = e.id and a.status in ('queued','reserved');
      insert into outreach_enrollment_undo(batch_id, enrollment_id, workspace_id, sequence_id, created_by, prev_status, prev_paused_from, prev_wait_until, prev_node_id, prev_node_entered, prev_exit_reason, prev_held_at, prev_hold_reason, action_ids)
      values (batch, e.id, e.workspace_id, e.sequence_id, uid, e.status, e.paused_from, e.wait_until, e.current_node_id, e.node_entered_at, e.exit_reason, e.held_at, e.hold_reason, aids)
      on conflict do nothing;
      perform outreach_complete_enrollment(e.id, 'cancelled', 'unenrolled');
      update outreach_enrollments set held_at = null, hold_reason = null, paused_from = null where id = e.id;
      update outreach_tasks set completed_at = now(), completed_by = uid, result = jsonb_build_object('decision', 'exit') where enrollment_id = e.id and kind = 'reply_hold' and completed_at is null;
      done := done + 1;
    elsif p_action = 'pause' then
      if e.status not in ('active','waiting_connection','waiting_delay','waiting_task') then skipped := skipped + 1; continue; end if;
      update outreach_enrollments set paused_from = status, status = 'paused' where id = e.id;
      done := done + 1;
    else
      if e.status <> 'paused' or e.held_at is not null then skipped := skipped + 1; continue; end if;
      update outreach_enrollments set status = coalesce(paused_from, 'active'), paused_from = null,
             wait_until = case when coalesce(paused_from, 'active') in ('active','waiting_delay') then greatest(coalesce(wait_until, now()), now()) else wait_until end
       where id = e.id;
      done := done + 1;
    end if;
  end loop;

  if p_ids is null then
    select count(*) into remaining from outreach__sequence_lead_ids(p_sequence, p_filter, p_teammate, p_from, p_to, p_search) i join outreach_enrollments en on en.id = i.enrollment_id
     where case p_action when 'unenroll' then en.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
                         when 'pause' then en.status in ('active','waiting_connection','waiting_delay','waiting_task')
                         else en.status = 'paused' and en.held_at is null end;
  end if;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (s.workspace_id, uid, case when uid is null then 'system' else 'user' end, 'sequence.bulk_' || p_action, 'sequence', p_sequence::text,
          jsonb_build_object('batch_id', batch, 'done', done, 'skipped', skipped, 'remaining', remaining, 'filter', p_filter));
  return jsonb_build_object('batch_id', batch, 'action', p_action, 'done', done, 'skipped', skipped, 'remaining', remaining);
end $$;
grant execute on function outreach_sequence_bulk(uuid, text, uuid[], text, uuid, date, date, text, uuid, int) to authenticated;

-- Which of the selected ids an unenroll would skip (the confirm text: "2 leads that have already ended will be skipped").
create or replace function outreach_sequence_bulk_preview(p_sequence uuid, p_action text, p_ids uuid[] default null, p_filter text default null, p_teammate uuid default null,
                                                           p_from date default null, p_to date default null, p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; n_total bigint; n_ok bigint;
begin
  if p_action not in ('unenroll','pause','resume') then raise exception 'E_PAYLOAD_INVALID: action must be unenroll, pause or resume'; end if;
  s := outreach__sequence_access(p_sequence, 'member');
  with ids as (select unnest(p_ids) as id where p_ids is not null union all select enrollment_id from outreach__sequence_lead_ids(p_sequence, p_filter, p_teammate, p_from, p_to, p_search) where p_ids is null)
  select count(*), count(*) filter (where case p_action when 'unenroll' then en.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')
                                                        when 'pause' then en.status in ('active','waiting_connection','waiting_delay','waiting_task')
                                                        else en.status = 'paused' and en.held_at is null end)
    into n_total, n_ok from ids join outreach_enrollments en on en.id = ids.id and en.sequence_id = p_sequence;
  return jsonb_build_object('total', n_total, 'eligible', n_ok, 'skipped', n_total - n_ok, 'sequence_name', s.name);
end $$;
grant execute on function outreach_sequence_bulk_preview(uuid, text, uuid[], text, uuid, date, date, text) to authenticated;

-- Undo an unenroll batch (15 minutes): each lead goes back to its previous status, step and schedule; the queued actions
-- the exit cancelled are queued again. A lead that was enrolled again on the same sender in the meantime is skipped.
create or replace function outreach_sequence_bulk_undo(p_batch uuid) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare u record; e outreach_enrollments%rowtype; restored int := 0; skipped int := 0; ws uuid; seq uuid; uid uuid := auth.uid(); b_at timestamptz; b_by uuid;
begin
  select workspace_id, sequence_id, min(at), min(created_by::text)::uuid into ws, seq, b_at, b_by from outreach_enrollment_undo where batch_id = p_batch group by 1, 2;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  if not outreach_is_service() then
    perform outreach_require(ws, 'member');
    if b_by is distinct from uid and not outreach_has_role(ws, 'manager') then raise exception 'E_FORBIDDEN: only the teammate who unenrolled (or a manager) can undo'; end if;
  end if;
  if not outreach_client_visible(ws, (select client_id from outreach_sequences where id = seq)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if b_at < now() - interval '15 minutes' then raise exception 'E_UNDO_EXPIRED: this can no longer be undone'; end if;
  perform set_config('outreach.batch_id', p_batch::text, true);
  perform set_config('outreach.batch_reason', 'undo', true);
  for u in select * from outreach_enrollment_undo where batch_id = p_batch and restored_at is null loop
    select * into e from outreach_enrollments where id = u.enrollment_id for update;
    if not found or e.status <> 'cancelled' or e.exit_reason is distinct from 'unenrolled' then skipped := skipped + 1; continue; end if;
    if exists (select 1 from outreach_enrollments x where x.lead_id = e.lead_id and x.sender_id = e.sender_id and x.id <> e.id
                  and x.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) then skipped := skipped + 1; continue; end if;
    update outreach_enrollments
       set status = u.prev_status, paused_from = u.prev_paused_from, wait_until = u.prev_wait_until, current_node_id = u.prev_node_id, node_entered_at = coalesce(u.prev_node_entered, node_entered_at),
           exit_reason = u.prev_exit_reason, completed_at = null, held_at = u.prev_held_at, hold_reason = u.prev_hold_reason
     where id = e.id;
    update outreach_actions set status = 'queued', decision = null, reserved_at = null where id = any(u.action_ids) and status = 'cancelled' and decision = 'enrollment_cancelled';
    if u.prev_held_at is not null then
      update outreach_tasks set completed_at = null, completed_by = null, result = null where enrollment_id = e.id and kind = 'reply_hold' and completed_at >= u.at and result->>'decision' = 'exit';
    end if;
    update outreach_enrollment_undo set restored_at = now() where batch_id = p_batch and enrollment_id = u.enrollment_id;
    perform outreach_emit_event(ws, 'enrollment.resumed', jsonb_build_object('id', e.id, 'lead_id', e.lead_id, 'sequence_id', seq, 'reason', 'undo_unenroll'));
    restored := restored + 1;
  end loop;
  insert into outreach_audit_log(workspace_id, actor, actor_type, action, entity, entity_id, diff)
  values (ws, uid, case when uid is null then 'system' else 'user' end, 'sequence.bulk_undo', 'sequence', seq::text, jsonb_build_object('batch_id', p_batch, 'restored', restored, 'skipped', skipped));
  return jsonb_build_object('batch_id', p_batch, 'restored', restored, 'skipped', skipped);
end $$;
grant execute on function outreach_sequence_bulk_undo(uuid) to authenticated;

-- outreach_has_role may not exist on older databases: a tiny shim over outreach_members
create or replace function outreach_has_role(p_ws uuid, p_min text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, p_min);
  return true;
exception when others then return false;
end $$;
revoke execute on function outreach_has_role(uuid, text) from public, anon, authenticated;

-- undo rows older than a day are useless
select cron.schedule('outreach-undo-prune', '25 4 * * *', $$delete from outreach_enrollment_undo where at < now() - interval '1 day'$$);

-- -----------------------------------------------------------------------------
-- 8. Analytics
-- -----------------------------------------------------------------------------
create or replace function outreach__pct(p_n numeric, p_d numeric) returns numeric
language sql immutable as $$ select case when coalesce(p_d, 0) = 0 then null else round(p_n * 100.0 / p_d, 1) end $$;

create or replace function outreach_sequence_analytics(p_sequence uuid, p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; b record; f_ts timestamptz; t_ts timestamptz; z text; f date; t date;
        cards jsonb; progress jsonb; steps jsonb; daily jsonb; senders jsonb; team jsonb; first_run timestamptz; nums jsonb;
        gap_pct numeric; gap_reason text; today date; today_planned int; today_sent int; cap_senders int; off_senders int;
begin
  s := outreach__sequence_access(p_sequence, 'client_viewer');
  select * into b from outreach__stats_cohort_bounds(s.workspace_id, p_from, p_to);
  z := b.z; today := (now() at time zone z)::date;
  -- default: the last 30 days
  t := coalesce(p_to, today);
  f := coalesce(p_from, t - 29);
  if f > t then f := t; end if;
  f_ts := f::timestamp at time zone z; t_ts := (t + 1)::timestamp at time zone z;
  nums := outreach_graph_step_numbers(s.graph);

  select min(at) into first_run from outreach_step_runs where sequence_id = p_sequence;

  -- 1. Stat cards (the 089 facts: the same definitions as the Results funnel and the Sequences list)
  with fct as (select * from outreach_sequence_lead_facts where sequence_id = p_sequence)
  select jsonb_build_object(
    'enrolled',  (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.created_at >= f_ts and e.created_at < t_ts),
    'invites_sent', (select count(*) from fct where invited_at >= f_ts and invited_at < t_ts),
    'accepted',  (select count(*) from fct where accepted_at >= f_ts and accepted_at < t_ts),
    'replied',   (select count(*) from fct where replied_at >= f_ts and replied_at < t_ts),
    'interested',(select count(*) from fct where positive_at >= f_ts and positive_at < t_ts),
    'meetings',  (select count(*) from fct where meeting_at >= f_ts and meeting_at < t_ts),
    'contacted', (select count(*) from fct where first_contacted_at >= f_ts and first_contacted_at < t_ts))
  into cards;
  cards := cards || jsonb_build_object(
    'accepted_rate', outreach__pct((cards->>'accepted')::numeric, (cards->>'invites_sent')::numeric),
    'replied_rate', outreach__pct((cards->>'replied')::numeric, (cards->>'accepted')::numeric),
    'replied_of_contacted_rate', outreach__pct((cards->>'replied')::numeric, (cards->>'contacted')::numeric),
    'interested_rate', outreach__pct((cards->>'interested')::numeric, (cards->>'replied')::numeric));

  -- 2. Lead progress: everyone enrolled in the period, by where they are now (the same groups as the filter)
  select jsonb_build_object(
    'live', count(*) filter (where status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
    'completed', count(*) filter (where status = 'completed'),
    'handoff', count(*) filter (where status = 'exited_replied'),
    'stopped', count(*) filter (where status in ('exited_manual','exited_sender_disabled','exited_suppressed')),
    'failed', count(*) filter (where status = 'failed'),
    'unenrolled', count(*) filter (where status = 'cancelled'),
    'total', count(*))
  into progress from outreach_enrollments where sequence_id = p_sequence and created_at >= f_ts and created_at < t_ts;

  -- 3. Step table (hidden variant column: runs carry variant_id; rows are per step)
  select coalesce(jsonb_agg(jsonb_build_object(
      'node_id', x.key, 'step_number', (nums->>x.key)::int, 'type', x.value->>'type',
      'label', coalesce(x.value->>'label', initcap(replace(x.value->>'type', '_', ' '))),
      'variant_id', null,
      'has_variants', coalesce(jsonb_typeof(x.value->'config'->'variants') = 'array' and jsonb_array_length(x.value->'config'->'variants') > 1, false),
      'sent', coalesce(r.sent, 0), 'accepted', coalesce(r.accepted, 0), 'read', coalesce(r.read, 0), 'replied', coalesce(r.replied, 0), 'skipped', coalesce(r.skipped, 0), 'failed', coalesce(r.failed, 0),
      'accepted_rate', outreach__pct(coalesce(r.accepted, 0), coalesce(r.sent, 0)), 'read_rate', outreach__pct(coalesce(r.read, 0), coalesce(r.sent, 0)),
      'replied_rate', outreach__pct(coalesce(r.replied, 0), coalesce(r.sent, 0)), 'skipped_rate', outreach__pct(coalesce(r.skipped, 0), coalesce(r.sent, 0) + coalesce(r.skipped, 0) + coalesce(r.failed, 0)),
      'failed_rate', outreach__pct(coalesce(r.failed, 0), coalesce(r.sent, 0) + coalesce(r.skipped, 0) + coalesce(r.failed, 0)),
      'leads_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')))
      order by (nums->>x.key)::int nulls last, x.key), '[]'::jsonb)
    into steps
    from jsonb_each(s.graph->'nodes') x
    left join (select node_id, count(*) filter (where outcome = 'sent') as sent, count(*) filter (where outcome = 'accepted') as accepted, count(*) filter (where outcome = 'read') as read,
                      count(*) filter (where outcome = 'replied') as replied, count(*) filter (where outcome = 'skipped') as skipped, count(*) filter (where outcome = 'failed') as failed
                 from outreach_step_runs where sequence_id = p_sequence and at >= f_ts and at < t_ts group by node_id) r on r.node_id = x.key
   where outreach_is_executable_node(x.value->>'type') or (x.value->>'type') in ('manual_task','call_task','ai_draft_approval');

  -- 4. Planned vs sent per day (snapshot where there is one, else the actions scheduled that day)
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day, 'planned', coalesce(p.planned, q.planned, 0), 'sent', coalesce(sn.sent, 0), 'snapshot', p.planned is not null) order by d.day), '[]'::jsonb)
    into daily
    from (select g::date as day from generate_series(f, t, interval '1 day') g) d
    left join (select day, sum(planned)::int as planned from outreach_sequence_daily_plan where sequence_id = p_sequence group by day) p on p.day = d.day
    left join (select (a.scheduled_for at time zone z)::date as day, count(*)::int as planned from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
                where e.sequence_id = p_sequence and a.scheduled_for >= f_ts and a.scheduled_for < t_ts and a.status in ('queued','reserved','sent','skipped','failed')
                  and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false) group by 1) q on q.day = d.day
    left join (select (at at time zone z)::date as day, count(*)::int as sent from outreach_step_runs where sequence_id = p_sequence and outcome = 'sent' and at >= f_ts and at < t_ts group by 1) sn on sn.day = d.day;
  -- today's gap and its reason
  select (x->>'planned')::int, (x->>'sent')::int into today_planned, today_sent from jsonb_array_elements(daily) x where (x->>'day')::date = today;
  gap_pct := case when coalesce(today_planned, 0) = 0 then null else round((today_planned - coalesce(today_sent, 0)) * 100.0 / today_planned, 1) end;
  if gap_pct is not null and gap_pct > 20 then
    select count(distinct a.sender_id) into cap_senders from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
     where e.sequence_id = p_sequence and a.created_at >= now() - interval '1 day' and a.decision in ('sender_cap_hit','sender_cap_hit_cascade','budget_deferred','hourly_deferred');
    select count(*) into off_senders from outreach_senders sd where sd.id = any(s.sender_pool) and sd.status <> 'ok';
    gap_reason := case
      when s.status = 'paused' then 'The sequence is paused'
      when cap_senders > 0 then cap_senders || ' sender' || case when cap_senders = 1 then '' else 's' end || ' hit ' || case when cap_senders = 1 then 'its' else 'their' end || ' daily limit'
      when off_senders > 0 then off_senders || ' sender' || case when off_senders = 1 then ' is' else 's are' end || ' not connected'
      when (now() at time zone z)::time < time '18:00' then 'The day is not over: sends continue in each sender''s working hours'
      else 'Sends were held back by the senders'' schedules' end;
  end if;

  -- 5. Sender accounts: the pool plus any sender that ran a step in the period
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', sd.id, 'name', coalesce(sd.display_name, sd.owner_email, 'Sender'), 'provider', sd.provider, 'status', sd.status, 'status_reason', sd.status_reason, 'in_pool', sd.id = any(s.sender_pool),
      'sent', coalesce(r.sent, 0), 'invites', coalesce(r.invites, 0), 'accepted', coalesce(r.accepted, 0), 'replied', coalesce(r.replied, 0), 'failed', coalesce(r.failed, 0),
      'accepted_rate', outreach__pct(coalesce(r.accepted, 0), coalesce(r.invites, 0)), 'replied_rate', outreach__pct(coalesce(r.replied, 0), coalesce(r.touches, 0)),
      'limited', exists (select 1 from outreach_sender_budgets bg where bg.sender_id = sd.id and bg.day = today and bg.used + bg.reserved >= bg.cap and bg.action_type in ('invite','message')),
      'live', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.sender_id = sd.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')))
      order by coalesce(r.sent, 0) desc, sd.display_name), '[]'::jsonb)
    into senders
    from outreach_senders sd
    left join (select sr.sender_id, count(*) filter (where outcome = 'sent') as sent,
                      count(*) filter (where outcome = 'sent' and a.action_type in ('invite','follow')) as invites,
                      count(*) filter (where outcome = 'sent' and a.action_type in ('invite','message','inmail','email','new_chat')) as touches,
                      count(*) filter (where outcome = 'accepted') as accepted, count(*) filter (where outcome = 'replied') as replied, count(*) filter (where outcome = 'failed') as failed
                 from outreach_step_runs sr left join outreach_actions a on a.id = sr.action_id
                where sr.sequence_id = p_sequence and sr.at >= f_ts and sr.at < t_ts group by sr.sender_id) r on r.sender_id = sd.id
   where sd.workspace_id = s.workspace_id and (sd.id = any(s.sender_pool) or r.sender_id is not null);

  -- 6. Team: handoffs taken (a teammate wrote to a handed-off lead), stops and unenrolls by hand (the status log)
  with handoffs as (
    select e.id as enrollment_id, m.sent_by as user_id, min(m.sent_at) as at
      from outreach_enrollments e join outreach_chats c on c.lead_id = e.lead_id and c.sender_id = e.sender_id
      join outreach_messages m on m.chat_id = c.id and m.direction = 'out' and m.sent_by is not null and m.deleted_at is null and m.sent_at >= e.completed_at
     where e.sequence_id = p_sequence and e.status = 'exited_replied' and e.completed_at >= f_ts and e.completed_at < t_ts
     group by 1, 2),
  logs as (
    select actor as user_id, count(*) filter (where new_status = 'exited_manual') as stopped, count(*) filter (where new_status = 'cancelled' and reason = 'unenrolled') as unenrolled
      from outreach_enrollment_status_log where sequence_id = p_sequence and actor_type = 'user' and at >= f_ts and at < t_ts group by actor),
  people as (select user_id from handoffs union select user_id from logs)
  select coalesce(jsonb_agg(jsonb_build_object('user_id', p.user_id, 'name', coalesce(mem.display_name, mem.email::text, outreach_user_email(p.user_id), 'Former teammate'),
           'handoffs_taken', (select count(distinct h.enrollment_id) from handoffs h where h.user_id = p.user_id),
           'stopped', coalesce(l.stopped, 0), 'unenrolled', coalesce(l.unenrolled, 0))
           order by (select count(*) from handoffs h where h.user_id = p.user_id) + coalesce(l.stopped, 0) + coalesce(l.unenrolled, 0) desc), '[]'::jsonb)
    into team
    from people p left join logs l on l.user_id = p.user_id left join outreach_members mem on mem.workspace_id = s.workspace_id and mem.user_id = p.user_id
   where p.user_id is not null;

  return jsonb_build_object(
    'sequence', jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'head_version', s.head_version),
    'period', jsonb_build_object('from', f, 'to', t, 'timezone', z, 'default', p_from is null and p_to is null),
    'first_run_at', first_run, 'empty', first_run is null,
    'cards', cards, 'progress', progress, 'steps', steps,
    'daily', jsonb_build_object('days', daily, 'today', today, 'today_planned', coalesce(today_planned, 0), 'today_sent', coalesce(today_sent, 0), 'gap_pct', gap_pct, 'gap_reason', gap_reason),
    'senders', senders, 'team', team,
    'handoffs_untaken', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.status = 'exited_replied' and e.completed_at >= f_ts and e.completed_at < t_ts
                            and not exists (select 1 from outreach_chats c join outreach_messages m on m.chat_id = c.id where c.lead_id = e.lead_id and c.sender_id = e.sender_id and m.direction = 'out' and m.sent_by is not null and m.sent_at >= e.completed_at)),
    'definitions_version', 1);
end $$;
grant execute on function outreach_sequence_analytics(uuid, date, date) to authenticated;

-- 7. The lead table of Analytics: everyone enrolled in the period, where they got to and what they did
create or replace function outreach_sequence_analytics_leads(p_sequence uuid, p_from date default null, p_to date default null, p_limit int default 50, p_offset int default 0, p_search text default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences; b record; f_ts timestamptz; t_ts timestamptz; z text; f date; t date; nums jsonb; step_total int; total bigint; rows_ jsonb;
        lim int := least(greatest(coalesce(p_limit, 50), 1), 200); off int := greatest(coalesce(p_offset, 0), 0); q text;
begin
  s := outreach__sequence_access(p_sequence, 'client_viewer');
  select * into b from outreach__stats_cohort_bounds(s.workspace_id, p_from, p_to);
  z := b.z; t := coalesce(p_to, (now() at time zone z)::date); f := coalesce(p_from, t - 29); if f > t then f := t; end if;
  f_ts := f::timestamp at time zone z; t_ts := (t + 1)::timestamp at time zone z;
  nums := outreach_graph_step_numbers(s.graph);
  select coalesce(max(value::int), 0) into step_total from jsonb_each_text(nums);
  q := nullif(trim(coalesce(p_search, '')), '');
  select count(*) into total from outreach_enrollments e where e.sequence_id = p_sequence and e.created_at >= f_ts and e.created_at < t_ts
    and (q is null or exists (select 1 from outreach_leads l where l.id = e.lead_id and (l.full_name ilike '%' || q || '%' or l.company ilike '%' || q || '%')));
  select coalesce(jsonb_agg(r), '[]'::jsonb) into rows_ from (
    select jsonb_build_object(
      'id', e.id, 'lead_id', e.lead_id, 'status', e.status, 'created_at', e.created_at, 'completed_at', e.completed_at,
      'lead', jsonb_build_object('id', l.id, 'full_name', l.full_name, 'company', l.company, 'public_identifier', l.public_identifier, 'picture_url', l.picture_url),
      'sender', jsonb_build_object('id', sd.id, 'display_name', sd.display_name),
      'step_reached', coalesce((select max((nums->>sr.node_id)::int) from outreach_step_runs sr where sr.enrollment_id = e.id and sr.outcome = 'sent'), (nums->>e.current_node_id)::int, 0),
      'step_total', step_total,
      'step_label', coalesce(s.graph->'nodes'->e.current_node_id->>'label', initcap(replace(coalesce(s.graph->'nodes'->e.current_node_id->>'type', ''), '_', ' '))),
      'invited_at', fc.invited_at, 'accepted_at', fc.accepted_at, 'replied_at', fc.replied_at, 'positive_at', fc.positive_at, 'meeting_at', fc.meeting_at) as r
    from outreach_enrollments e
    left join outreach_leads l on l.id = e.lead_id
    left join outreach_senders sd on sd.id = e.sender_id
    left join outreach_sequence_lead_facts fc on fc.enrollment_id = e.id
   where e.sequence_id = p_sequence and e.created_at >= f_ts and e.created_at < t_ts
     and (q is null or (l.full_name ilike '%' || q || '%' or l.company ilike '%' || q || '%'))
   order by e.created_at desc, e.id limit lim offset off) x;
  return jsonb_build_object('total', total, 'limit', lim, 'offset', off, 'step_total', step_total, 'rows', rows_);
end $$;
grant execute on function outreach_sequence_analytics_leads(uuid, date, date, int, int, text) to authenticated;

-- -----------------------------------------------------------------------------
-- 9. Backfill (idempotent: every insert is `on conflict do nothing` / guarded)
-- -----------------------------------------------------------------------------
-- 9a. step runs from history: sent / skipped / failed from actions
insert into outreach_step_runs(workspace_id, sequence_id, node_id, enrollment_id, lead_id, sender_id, variant_id, outcome, action_id, at)
select a.workspace_id, e.sequence_id, a.node_id, a.enrollment_id, e.lead_id, a.sender_id, a.variant_id, a.status::text, a.id, coalesce(a.executed_at, a.created_at)
  from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
 where a.status in ('sent','skipped','failed') and a.node_id is not null
   and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
on conflict do nothing;
-- 9b. accepted: from the 089 facts, on the step that sent the invitation / follow
insert into outreach_step_runs(workspace_id, sequence_id, node_id, enrollment_id, lead_id, sender_id, outcome, at)
select f.workspace_id, f.sequence_id, a.node_id, f.enrollment_id, f.lead_id, f.sender_id, 'accepted', f.accepted_at
  from outreach_sequence_lead_facts f
  join lateral (select node_id from outreach_actions a where a.enrollment_id = f.enrollment_id and a.status = 'sent' and a.action_type in ('invite','follow') and a.node_id is not null order by a.executed_at limit 1) a on true
 where f.accepted_at is not null
on conflict do nothing;
-- 9c. replied: from the facts, on the last step that went out before the reply
insert into outreach_step_runs(workspace_id, sequence_id, node_id, enrollment_id, lead_id, sender_id, outcome, at)
select f.workspace_id, f.sequence_id, coalesce(a.node_id, e.current_node_id), f.enrollment_id, f.lead_id, f.sender_id, 'replied', f.replied_at
  from outreach_sequence_lead_facts f join outreach_enrollments e on e.id = f.enrollment_id
  left join lateral (select node_id from outreach_actions a where a.enrollment_id = f.enrollment_id and a.status = 'sent' and a.node_id is not null and a.executed_at <= f.replied_at
                      and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false) order by a.executed_at desc limit 1) a on true
 where f.replied_at is not null and coalesce(a.node_id, e.current_node_id) is not null
on conflict do nothing;
-- 9d. read receipts on step messages
insert into outreach_step_runs(workspace_id, sequence_id, node_id, enrollment_id, lead_id, sender_id, variant_id, outcome, action_id, at)
select a.workspace_id, e.sequence_id, a.node_id, a.enrollment_id, e.lead_id, a.sender_id, a.variant_id, 'read', a.id, m.read_at
  from outreach_messages m join outreach_actions a on a.id = m.action_id join outreach_enrollments e on e.id = a.enrollment_id
 where m.read_at is not null and m.direction = 'out' and a.node_id is not null
on conflict do nothing;
-- 9e. the status log gets one row per enrolment so "enrolled" and the final status are there from day one
insert into outreach_enrollment_status_log(workspace_id, sequence_id, enrollment_id, lead_id, sender_id, node_id, prev_status, new_status, actor, actor_type, reason, at)
select e.workspace_id, e.sequence_id, e.id, e.lead_id, e.sender_id, null, null, 'active', e.created_by, case when e.created_by is null then 'system' else 'user' end, 'backfill', e.created_at
  from outreach_enrollments e where not exists (select 1 from outreach_enrollment_status_log l where l.enrollment_id = e.id);
insert into outreach_enrollment_status_log(workspace_id, sequence_id, enrollment_id, lead_id, sender_id, node_id, prev_status, new_status, actor, actor_type, reason, at)
select e.workspace_id, e.sequence_id, e.id, e.lead_id, e.sender_id, e.current_node_id, 'active', e.status, null, 'system', coalesce(e.exit_reason, 'backfill'), coalesce(e.completed_at, e.updated_at)
  from outreach_enrollments e where e.status <> 'active' and not exists (select 1 from outreach_enrollment_status_log l where l.enrollment_id = e.id and l.new_status = e.status);
update outreach_enrollments set status_changed_at = coalesce(completed_at, updated_at) where status_changed_at is null;
-- 9f. today's plan
select outreach_plan_snapshot();
