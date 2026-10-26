-- =============================================================================
-- 089 — Sequence stats: contacted · accepted · replied · positive, per channel (sequence-stats-PRD.md).
--
-- Every number the Sequences list, the sequence page, Reports → Sequences, the connector and the public API show
-- comes from two fact tables, one row per enrolment (outreach_sequence_lead_facts) and one row per enrolment and
-- channel (outreach_sequence_channel_facts), read by outreach_report_sequences / outreach_report_sequence.
--
-- How the facts are written (D9, simplified from the PRD's per-event stats_record):
--   * ONE definition: outreach__stats_truth_leads() / outreach__stats_truth_channels() compute the facts of a lead
--     (or of a whole sequence) from the source tables: outreach_actions (sent touches), outreach_messages +
--     outreach_chats (human / auto replies, read receipts, bounces), outreach_lead_sender_state (acceptances, dropped
--     invitations), outreach_lead_milestones (meetings).
--   * Incremental: triggers on those source tables call outreach_stats_rebuild_lead(lead) — a lead's facts never
--     depend on another lead, so recomputing the lead is exact, idempotent and order-independent (replaying a
--     webhook changes nothing). This replaces the PRD's "fill a null timestamp per event" writer; there is no second
--     copy of the rules to drift.
--   * Nightly: outreach_stats_reconcile() recomputes every sequence with activity in the last 7 days, repairs
--     differences, logs them to ops.stats_reconcile_log and reports Health check stats-1 (F54 is SQL, scheduled by
--     pg_cron directly: no edge function is needed).
--   * All-time list numbers are cached per sequence (outreach_sequence_stats_cache); a rebuild queues the sequence
--     and a one-minute cron drains the queue. The list reads the cache and computes a queued sequence live, so it
--     is never behind (no pgmq on this project; the dispatcher rule of 084 applies: no sub-minute cron).
--
-- Deviations from the PRD are listed in docs/outreach/SEQUENCE-STATS.md.
-- Idempotent. Backfills every sequence at the end (small data: ~800 enrolments on 2026-10-26).
-- =============================================================================

-- ----------------------------------------------------------------------------- 1. tables
create table if not exists outreach_sequence_lead_facts (
  enrollment_id         uuid primary key references outreach_enrollments(id) on delete cascade,
  workspace_id          uuid not null references outreach_workspaces(id) on delete cascade,
  sequence_id           uuid not null references outreach_sequences(id) on delete cascade,
  sequence_version      int  not null,
  lead_id               uuid not null references outreach_leads(id) on delete cascade,
  sender_id             uuid not null,                       -- no FK on purpose: facts survive an erased sender (sender-lifecycle PRD)
  first_attempt_at      timestamptz not null,                -- first touch, or the WhatsApp number check that failed before any touch (row existence + cohort key)
  first_contacted_at    timestamptz,
  first_contact_channel text,                                -- linkedin | instagram | whatsapp | email (the reports' channel keys)
  last_touch_at         timestamptz,
  invited_at            timestamptz,                         -- LinkedIn invitation or Instagram follow
  invite_channel        text,
  accepted_at           timestamptz,
  invite_closed_at      timestamptz,
  invite_closed_reason  text check (invite_closed_reason in ('withdrawn','declined')),
  replied_at            timestamptz,                         -- first HUMAN reply credited to this enrolment (§3.4)
  reply_channel         text,
  reply_message_id      uuid references outreach_messages(id) on delete set null,
  auto_replied_at       timestamptz,
  positive_at           timestamptz,
  meeting_at            timestamptz,
  updated_at            timestamptz not null default now()
);
create index if not exists outreach_slf_seq_attempt_idx on outreach_sequence_lead_facts(sequence_id, first_attempt_at);
create index if not exists outreach_slf_seq_lead_idx    on outreach_sequence_lead_facts(sequence_id, lead_id);
create index if not exists outreach_slf_lead_idx        on outreach_sequence_lead_facts(lead_id, last_touch_at desc);
create index if not exists outreach_slf_ws_seq_idx      on outreach_sequence_lead_facts(workspace_id, sequence_id);
alter table outreach_sequence_lead_facts enable row level security;
revoke all on outreach_sequence_lead_facts from public, anon, authenticated;
grant select on outreach_sequence_lead_facts to service_role;

create table if not exists outreach_sequence_channel_facts (
  enrollment_id uuid not null references outreach_enrollments(id) on delete cascade,
  channel       text not null,
  sequence_id   uuid not null,
  lead_id       uuid not null,
  contacted_at  timestamptz,
  invited_at    timestamptz,
  accepted_at   timestamptz,
  messaged_at   timestamptz,
  seen_at       timestamptz,
  replied_at    timestamptz,          -- a human reply on this channel credited to this enrolment (not only the lead-level one)
  bounced_at    timestamptz,          -- email hard bounce, or WhatsApp "number not on WhatsApp"
  primary key (enrollment_id, channel)
);
create index if not exists outreach_scf_seq_channel_idx on outreach_sequence_channel_facts(sequence_id, channel);
create index if not exists outreach_scf_lead_idx on outreach_sequence_channel_facts(lead_id);
alter table outreach_sequence_channel_facts enable row level security;
revoke all on outreach_sequence_channel_facts from public, anon, authenticated;
grant select on outreach_sequence_channel_facts to service_role;

create table if not exists outreach_sequence_stats_cache (
  sequence_id  uuid primary key references outreach_sequences(id) on delete cascade,
  workspace_id uuid not null,
  stats        jsonb not null,                       -- outreach__stats_block(sequence, null, null): the all-time results
  refreshed_at timestamptz not null default now()
);
alter table outreach_sequence_stats_cache enable row level security;
revoke all on outreach_sequence_stats_cache from public, anon, authenticated;

create table if not exists outreach_stats_refresh_queue (
  sequence_id uuid primary key,
  queued_at   timestamptz not null default now()
);
alter table outreach_stats_refresh_queue enable row level security;
revoke all on outreach_stats_refresh_queue from public, anon, authenticated;

create schema if not exists ops;
create table if not exists ops.stats_reconcile_log (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  workspace_id uuid,
  sequence_id  uuid,
  rows_checked int not null,
  rows_fixed   int not null,
  pct_fixed    numeric,
  detail       jsonb
);
create index if not exists stats_reconcile_log_at_idx on ops.stats_reconcile_log(at);

-- when read receipts started being kept (Seen is "at least" and counted from this day)
insert into outreach_flags(key, value)
select 'stats_seen_since', to_jsonb(coalesce((select min(read_at)::date from outreach_messages where direction = 'out' and read_at is not null), current_date)::text)
on conflict (key) do nothing;

-- ----------------------------------------------------------------------------- 2. the vocabulary
-- The channel an action went out on: email by type, otherwise the sender's provider.
create or replace function outreach__stats_action_channel(p_type outreach_action_type_t, p_provider outreach_provider_t) returns text
language sql immutable as $$ select case when p_type = 'email' then 'email' else outreach__channel_of(p_provider) end $$;

-- §3.1 touches: what counts as contacting someone, per channel. invite = starts the accept funnel (LinkedIn invitation,
-- Instagram follow); message = a message of any kind. Profile visits, likes, comments, endorsements, LinkedIn follows: null.
create or replace function outreach__stats_touch_kind(p_type outreach_action_type_t, p_channel text) returns text
language sql immutable as $$
  select case
    when p_channel = 'linkedin'  and p_type = 'invite' then 'invite'
    when p_channel = 'linkedin'  and p_type in ('message','inmail') then 'message'
    when p_channel = 'instagram' and p_type = 'follow' then 'invite'
    when p_channel = 'instagram' and p_type in ('new_chat','message') then 'message'
    when p_channel = 'whatsapp'  and p_type in ('new_chat','message') then 'message'
    when p_channel = 'email'     and p_type = 'email' then 'message'
    else null end
$$;

-- ----------------------------------------------------------------------------- 3. THE definition of the facts
-- Lead-level facts for every enrolment of the given leads (across every sequence: credit decisions — which enrolment
-- an acceptance, a reply or a meeting belongs to — need the lead's whole history, so a lead is always computed whole).
-- Planner notes: the body is planned once per call with the array unknown, so every reused CTE is MATERIALIZED and
-- nested loops are off: with rows=1 estimates the planner otherwise re-runs the aggregates per outer row (minutes for
-- a 700-lead sequence; 17 ms when planned with literals). Callers batch big sequences 500 leads at a time.
create or replace function outreach__stats_truth_leads(p_leads uuid[])
returns setof outreach_sequence_lead_facts
language sql stable security definer set search_path = public, extensions set enable_nestloop = off as $$
  with en as materialized (
    select e.id, e.workspace_id, e.sequence_id, e.sequence_version, e.lead_id, e.sender_id, e.created_at
      from outreach_enrollments e where e.lead_id = any(p_leads)),
  tk as materialized (   -- every sent touch of those enrolments, with its channel and kind
    select a.id, a.enrollment_id, a.lead_id, a.sender_id, a.executed_at,
           outreach__stats_action_channel(a.action_type, s.provider) as ch,
           outreach__stats_touch_kind(a.action_type, outreach__stats_action_channel(a.action_type, s.provider)) as kind
      from outreach_actions a join en on en.id = a.enrollment_id join outreach_senders s on s.id = a.sender_id
     where a.status = 'sent' and a.executed_at is not null
       and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
       and outreach__stats_touch_kind(a.action_type, outreach__stats_action_channel(a.action_type, s.provider)) is not null),
  chk as materialized (  -- WhatsApp number checks that failed: an attempt that could not become a touch
    select a.enrollment_id, min(a.executed_at) as at_
      from outreach_actions a join en on en.id = a.enrollment_id
     where a.action_type = 'identifier_check' and a.status = 'skipped' and a.error_code = 'E_IDENTIFIER_INVALID' and a.executed_at is not null
     group by a.enrollment_id),
  lf as materialized (
    select en.id as enrollment_id, en.lead_id, en.sender_id,
           min(tk.executed_at) as first_contacted_at,
           (array_agg(tk.ch order by tk.executed_at, tk.id))[1] as first_contact_channel,
           max(tk.executed_at) as last_touch_at,
           min(tk.executed_at) filter (where tk.kind = 'invite') as invited_at,
           (array_agg(tk.ch order by tk.executed_at, tk.id) filter (where tk.kind = 'invite'))[1] as invite_channel
      from en left join tk on tk.enrollment_id = en.id
     group by en.id, en.lead_id, en.sender_id),
  acc as materialized (  -- the acceptance (LinkedIn) / follow-back (Instagram) kept per lead + sender credits the latest invitation sent before it
    select lf.enrollment_id, x.invite_accepted_at as accepted_at
      from lf join outreach_lead_sender_state x on x.lead_id = lf.lead_id and x.sender_id = lf.sender_id
     where lf.invited_at is not null and x.invite_accepted_at is not null and x.invite_accepted_at >= lf.invited_at - interval '1 minute'
       and not exists (select 1 from lf l2 where l2.lead_id = lf.lead_id and l2.sender_id = lf.sender_id and l2.enrollment_id <> lf.enrollment_id
                          and l2.invited_at > lf.invited_at and l2.invited_at <= x.invite_accepted_at + interval '1 minute')),
  wd as materialized (   -- we withdrew it
    select lf.enrollment_id, min(a.executed_at) as at_
      from lf join outreach_actions a on a.lead_id = lf.lead_id and a.sender_id = lf.sender_id and a.action_type = 'withdraw' and a.status = 'sent' and a.executed_at > lf.invited_at
     where lf.invited_at is not null group by lf.enrollment_id),
  dc as materialized (   -- LinkedIn dropped it from the pending list (relations poll): declined, or expired
    select lf.enrollment_id, x.invite_withdrawn_at as at_
      from lf join outreach_lead_sender_state x on x.lead_id = lf.lead_id and x.sender_id = lf.sender_id
     where lf.invited_at is not null and x.invite_withdrawn_at > lf.invited_at),
  inb as materialized (  -- what the other side wrote, as a person or an auto-reply (bounces, system events and website chat never count)
    select m.id, m.sent_at, c.lead_id, outreach__channel_of(c.provider) as ch, m.intent,
           outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as kind
      from outreach_messages m join outreach_chats c on c.id = m.chat_id
     where c.lead_id = any(p_leads) and m.direction = 'in' and m.deleted_at is null and c.provider <> 'WEBCHAT'
       and outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) in ('person','auto')),
  cred as materialized ( -- §3.4: a message is credited to the enrolment whose touch was the latest one before it, across every sequence and sender
    select i.*, x.enrollment_id
      from inb i
      left join lateral (select t.enrollment_id from tk t where t.lead_id = i.lead_id and t.executed_at < i.sent_at order by t.executed_at desc, t.id desc limit 1) x on true),
  rep as materialized (select enrollment_id, min(sent_at) as replied_at from cred where kind = 'person' and enrollment_id is not null group by enrollment_id),
  rep1 as materialized (
    select distinct on (c.enrollment_id) c.enrollment_id, c.lead_id, c.sent_at, c.ch, c.id as msg_id
      from cred c join rep r on r.enrollment_id = c.enrollment_id and r.replied_at = c.sent_at
     where c.kind = 'person' order by c.enrollment_id, c.id),
  aut as materialized (select enrollment_id, min(sent_at) as auto_replied_at from cred where kind = 'auto' and enrollment_id is not null group by enrollment_id),
  pos as materialized (  -- the credited reply, or any later human message of the lead within 30 days, classified interested / question
    select r.enrollment_id, min(i.sent_at) as positive_at
      from rep1 r join inb i on i.lead_id = r.lead_id and i.kind = 'person' and i.intent in ('interested','question')
       and (i.id = r.msg_id or (i.sent_at >= r.sent_at and i.sent_at <= r.sent_at + interval '30 days'))
     group by r.enrollment_id),
  meet as materialized ( -- a meeting credits the most recently credited enrolment before it, else the most recently contacted one
    select x.enrollment_id, ms.at as meeting_at
      from outreach_lead_milestones ms
      cross join lateral (select coalesce(
          (select r.enrollment_id from rep1 r where r.lead_id = ms.lead_id and r.sent_at <= ms.at order by r.sent_at desc limit 1),
          (select f.enrollment_id from lf f where f.lead_id = ms.lead_id and f.first_contacted_at <= ms.at order by f.first_contacted_at desc limit 1)) as enrollment_id) x
     where ms.lead_id = any(p_leads) and ms.kind = 'meeting' and x.enrollment_id is not null)
  select en.id, en.workspace_id, en.sequence_id, en.sequence_version, en.lead_id, en.sender_id,
         least(lf.first_contacted_at, chk.at_) as first_attempt_at,
         lf.first_contacted_at, lf.first_contact_channel, lf.last_touch_at, lf.invited_at, lf.invite_channel, acc.accepted_at,
         case when acc.accepted_at is null then coalesce(wd.at_, dc.at_) end as invite_closed_at,
         case when acc.accepted_at is null and coalesce(wd.at_, dc.at_) is not null then case when wd.at_ is not null then 'withdrawn' else 'declined' end end as invite_closed_reason,
         rep1.sent_at as replied_at, rep1.ch as reply_channel, rep1.msg_id as reply_message_id, aut.auto_replied_at,
         least(pos.positive_at, meet.meeting_at) as positive_at, meet.meeting_at, now() as updated_at
    from en join lf on lf.enrollment_id = en.id
    left join chk on chk.enrollment_id = en.id
    left join acc on acc.enrollment_id = en.id left join wd on wd.enrollment_id = en.id left join dc on dc.enrollment_id = en.id
    left join rep1 on rep1.enrollment_id = en.id left join aut on aut.enrollment_id = en.id
    left join pos on pos.enrollment_id = en.id left join meet on meet.enrollment_id = en.id
   where least(lf.first_contacted_at, chk.at_) is not null
$$;
revoke execute on function outreach__stats_truth_leads(uuid[]) from public, anon, authenticated;

-- Per enrolment and channel (§3.2). Replies here are credited the same way as above but kept per channel, so a
-- lead who answered a LinkedIn sequence on WhatsApp shows under "Replied on another channel".
create or replace function outreach__stats_truth_channels(p_leads uuid[])
returns setof outreach_sequence_channel_facts
language sql stable security definer set search_path = public, extensions set enable_nestloop = off as $$
  with en as materialized (select e.id, e.sequence_id, e.lead_id from outreach_enrollments e where e.lead_id = any(p_leads)),
  tk as materialized (
    select a.id, a.enrollment_id, a.lead_id, a.executed_at,
           outreach__stats_action_channel(a.action_type, s.provider) as ch,
           outreach__stats_touch_kind(a.action_type, outreach__stats_action_channel(a.action_type, s.provider)) as kind
      from outreach_actions a join en on en.id = a.enrollment_id join outreach_senders s on s.id = a.sender_id
     where a.status = 'sent' and a.executed_at is not null
       and not coalesce((a.payload->>'prefetch')::boolean, false) and not coalesce((a.payload->>'subtask')::boolean, false)
       and outreach__stats_touch_kind(a.action_type, outreach__stats_action_channel(a.action_type, s.provider)) is not null),
  ct as materialized (
    select tk.enrollment_id, tk.ch as channel, min(tk.executed_at) as contacted_at,
           min(tk.executed_at) filter (where tk.kind = 'invite') as invited_at,
           min(tk.executed_at) filter (where tk.kind = 'message') as messaged_at
      from tk group by 1, 2),
  lfx as materialized (select enrollment_id, invite_channel, accepted_at from outreach__stats_truth_leads(p_leads)),
  seen as materialized (  -- read receipts on our messages that an enrolment sent (at least: people can turn them off)
    select tk.enrollment_id, tk.ch as channel, min(m.read_at) as seen_at
      from tk join outreach_messages m on m.action_id = tk.id and m.direction = 'out' and m.read_at is not null
     group by 1, 2),
  inb as materialized (
    select m.id, m.sent_at, c.lead_id, outreach__channel_of(c.provider) as ch,
           outreach__msg_kind(m.direction, m.is_auto_reply, m.is_bounce, m.event_type, m.content_type, m.sender_type) as kind
      from outreach_messages m join outreach_chats c on c.id = m.chat_id
     where c.lead_id = any(p_leads) and m.direction = 'in' and m.deleted_at is null and c.provider <> 'WEBCHAT'),
  cred as materialized (
    select i.*, x.enrollment_id
      from inb i
      left join lateral (select t.enrollment_id from tk t where t.lead_id = i.lead_id and t.executed_at < i.sent_at order by t.executed_at desc, t.id desc limit 1) x on true
     where i.kind = 'person'),
  rep as materialized (select c.enrollment_id, c.ch as channel, min(c.sent_at) as replied_at from cred c where c.enrollment_id is not null group by 1, 2),
  eb as materialized (    -- email hard bounces: the bounce stamped on our email (075), else the delivery notice that came back after it
    select tk.enrollment_id, 'email'::text as channel, min(least(m.bounced_at, b.sent_at)) as bounced_at
      from tk
      left join outreach_messages m on m.action_id = tk.id and m.direction = 'out' and m.bounced_at is not null
      left join inb b on b.lead_id = tk.lead_id and b.kind = 'bounce' and b.ch = 'email' and b.sent_at >= tk.executed_at and b.sent_at < tk.executed_at + interval '72 hours'
     where tk.ch = 'email' and (m.id is not null or b.id is not null) group by 1, 2),
  wb as materialized (    -- WhatsApp: the number check this enrolment ran came back "not on WhatsApp"
    select a.enrollment_id, 'whatsapp'::text as channel, min(a.executed_at) as bounced_at
      from outreach_actions a join en on en.id = a.enrollment_id
     where a.action_type = 'identifier_check' and a.status = 'skipped' and a.error_code = 'E_IDENTIFIER_INVALID' and a.executed_at is not null
     group by 1, 2),
  keys as materialized (select enrollment_id, channel from ct union select enrollment_id, channel from wb union select enrollment_id, channel from rep)
  select k.enrollment_id, k.channel, en.sequence_id, en.lead_id,
         ct.contacted_at, ct.invited_at, case when lfx.invite_channel = k.channel then lfx.accepted_at end as accepted_at, ct.messaged_at,
         seen.seen_at, rep.replied_at, coalesce(eb.bounced_at, wb.bounced_at) as bounced_at
    from keys k join en on en.id = k.enrollment_id
    left join ct on ct.enrollment_id = k.enrollment_id and ct.channel = k.channel
    left join lfx on lfx.enrollment_id = k.enrollment_id
    left join seen on seen.enrollment_id = k.enrollment_id and seen.channel = k.channel
    left join rep on rep.enrollment_id = k.enrollment_id and rep.channel = k.channel
    left join eb on eb.enrollment_id = k.enrollment_id and eb.channel = k.channel
    left join wb on wb.enrollment_id = k.enrollment_id and wb.channel = k.channel
$$;
revoke execute on function outreach__stats_truth_channels(uuid[]) from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 4. writing the facts
create or replace function outreach__stats_enqueue(p_sequences uuid[]) returns void
language sql security definer set search_path = public, extensions as $$
  insert into outreach_stats_refresh_queue(sequence_id) select distinct unnest(p_sequences) on conflict (sequence_id) do nothing
$$;
revoke execute on function outreach__stats_enqueue(uuid[]) from public, anon, authenticated;

-- Bring the stored facts of some leads in line with the truth: upsert changed rows, delete rows the truth no longer
-- has. Returns the number of rows written or removed (0 = nothing had changed).
create or replace function outreach__stats_apply(p_leads uuid[]) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; m int; seqs uuid[];
begin
  if p_leads is null or cardinality(p_leads) = 0 then return 0; end if;
  create temp table if not exists stats_truth_l (like outreach_sequence_lead_facts) on commit drop;
  create temp table if not exists stats_truth_c (like outreach_sequence_channel_facts) on commit drop;
  truncate stats_truth_l; truncate stats_truth_c;
  insert into stats_truth_l select * from outreach__stats_truth_leads(p_leads);
  insert into stats_truth_c select * from outreach__stats_truth_channels(p_leads);

  insert into outreach_sequence_lead_facts as f select * from stats_truth_l t
  on conflict (enrollment_id) do update set
    sequence_version = excluded.sequence_version, lead_id = excluded.lead_id, sender_id = excluded.sender_id,
    first_attempt_at = excluded.first_attempt_at, first_contacted_at = excluded.first_contacted_at, first_contact_channel = excluded.first_contact_channel,
    last_touch_at = excluded.last_touch_at, invited_at = excluded.invited_at, invite_channel = excluded.invite_channel, accepted_at = excluded.accepted_at,
    invite_closed_at = excluded.invite_closed_at, invite_closed_reason = excluded.invite_closed_reason, replied_at = excluded.replied_at,
    reply_channel = excluded.reply_channel, reply_message_id = excluded.reply_message_id, auto_replied_at = excluded.auto_replied_at,
    positive_at = excluded.positive_at, meeting_at = excluded.meeting_at, updated_at = now()
  where (f.sequence_version, f.lead_id, f.sender_id, f.first_attempt_at, f.first_contacted_at, f.first_contact_channel, f.last_touch_at, f.invited_at, f.invite_channel,
         f.accepted_at, f.invite_closed_at, f.invite_closed_reason, f.replied_at, f.reply_channel, f.reply_message_id, f.auto_replied_at, f.positive_at, f.meeting_at)
        is distinct from
        (excluded.sequence_version, excluded.lead_id, excluded.sender_id, excluded.first_attempt_at, excluded.first_contacted_at, excluded.first_contact_channel, excluded.last_touch_at,
         excluded.invited_at, excluded.invite_channel, excluded.accepted_at, excluded.invite_closed_at, excluded.invite_closed_reason, excluded.replied_at, excluded.reply_channel,
         excluded.reply_message_id, excluded.auto_replied_at, excluded.positive_at, excluded.meeting_at);
  get diagnostics m = row_count; n := n + m;

  delete from outreach_sequence_lead_facts f
   where f.lead_id = any(p_leads) and not exists (select 1 from stats_truth_l t where t.enrollment_id = f.enrollment_id);
  get diagnostics m = row_count; n := n + m;

  insert into outreach_sequence_channel_facts as f select * from stats_truth_c t
  on conflict (enrollment_id, channel) do update set
    sequence_id = excluded.sequence_id, lead_id = excluded.lead_id, contacted_at = excluded.contacted_at, invited_at = excluded.invited_at, accepted_at = excluded.accepted_at,
    messaged_at = excluded.messaged_at, seen_at = excluded.seen_at, replied_at = excluded.replied_at, bounced_at = excluded.bounced_at
  where (f.sequence_id, f.lead_id, f.contacted_at, f.invited_at, f.accepted_at, f.messaged_at, f.seen_at, f.replied_at, f.bounced_at)
        is distinct from
        (excluded.sequence_id, excluded.lead_id, excluded.contacted_at, excluded.invited_at, excluded.accepted_at, excluded.messaged_at, excluded.seen_at, excluded.replied_at, excluded.bounced_at);
  get diagnostics m = row_count; n := n + m;

  delete from outreach_sequence_channel_facts f
   where f.lead_id = any(p_leads) and not exists (select 1 from stats_truth_c t where t.enrollment_id = f.enrollment_id and t.channel = f.channel);
  get diagnostics m = row_count; n := n + m;

  if n > 0 then
    select array_agg(distinct x.sequence_id) into seqs from (
      select sequence_id from stats_truth_l union select sequence_id from outreach_enrollments where lead_id = any(p_leads)) x;
    perform outreach__stats_enqueue(seqs);
  end if;
  return n;
end $$;
revoke execute on function outreach__stats_apply(uuid[]) from public, anon, authenticated;

-- Recompute one lead (the incremental path: called by the triggers below).
create or replace function outreach_stats_rebuild_lead(p_lead uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_lead is null then return 0; end if;
  if not exists (select 1 from outreach_enrollments where lead_id = p_lead) then return 0; end if;
  return outreach__stats_apply(array[p_lead]);
end $$;
revoke execute on function outreach_stats_rebuild_lead(uuid) from public, anon, authenticated;

-- Recompute one sequence (backfill, reconcile, repair), 500 leads at a time. Returns rows written or removed.
create or replace function outreach_stats_rebuild_sequence(p_sequence uuid) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare n int := 0; b record;
begin
  for b in select array_agg(x.lead_id) as leads from (select distinct lead_id, dense_rank() over (order by lead_id) as rn from outreach_enrollments where sequence_id = p_sequence) x group by (x.rn - 1) / 500 loop
    n := n + outreach__stats_apply(b.leads);
  end loop;
  -- rows of enrolments that no longer exist are gone by cascade; rows of leads no longer enrolled here cannot exist
  perform outreach__stats_enqueue(array[p_sequence]);
  return n;
end $$;
revoke execute on function outreach_stats_rebuild_sequence(uuid) from public, anon, authenticated;

-- The trigger bodies swallow their own errors: a stats problem must never block a send, a webhook or a reply.
create or replace function outreach__stats_safe_rebuild(p_leads uuid[]) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare l uuid;
begin
  if p_leads is null then return; end if;
  for l in select distinct x from unnest(p_leads) x where x is not null loop
    begin perform outreach_stats_rebuild_lead(l);
    exception when others then raise warning 'outreach_stats_rebuild_lead(%): %', l, sqlerrm; end;
  end loop;
end $$;
revoke execute on function outreach__stats_safe_rebuild(uuid[]) from public, anon, authenticated;

-- 4a. actions: a touch went out (complete_action sets status = sent), a withdrawal, a failed number check
create or replace function outreach_trg_stats_action() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__stats_safe_rebuild(array[new.lead_id]);
  return null;
end $$;
drop trigger if exists outreach_actions_stats on outreach_actions;
create trigger outreach_actions_stats after insert or update of status on outreach_actions for each row
  when (new.lead_id is not null and new.enrollment_id is not null
        and ((new.status = 'sent' and new.action_type in ('invite','message','inmail','email','follow','new_chat','withdraw'))
             or (new.status = 'skipped' and new.action_type = 'identifier_check')))
  execute function outreach_trg_stats_action();
-- a withdrawal made outside a sequence (the withdraw worker) has no enrolment but closes the invitation
drop trigger if exists outreach_actions_stats_withdraw on outreach_actions;
create trigger outreach_actions_stats_withdraw after insert or update of status on outreach_actions for each row
  when (new.lead_id is not null and new.enrollment_id is null and new.status = 'sent' and new.action_type = 'withdraw')
  execute function outreach_trg_stats_action();

-- 4b. lead ↔ sender state: acceptance / follow-back, dropped invitation
create or replace function outreach_trg_stats_lss() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__stats_safe_rebuild(array[new.lead_id]);
  return null;
end $$;
drop trigger if exists outreach_lss_stats on outreach_lead_sender_state;
create trigger outreach_lss_stats after insert or update of invite_accepted_at, invite_withdrawn_at on outreach_lead_sender_state for each row
  when (new.invite_accepted_at is not null or new.invite_withdrawn_at is not null)
  execute function outreach_trg_stats_lss();

-- 4c. messages: an inbound message (human or auto), a classification, a read receipt, a bounce, a deletion.
-- Statement-level with transition tables: a whole-chat read receipt updates many rows and rebuilds the lead once.
create or replace function outreach_trg_stats_messages_ins() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare leads uuid[];
begin
  select array_agg(distinct c.lead_id) into leads
    from new_rows n join outreach_chats c on c.id = n.chat_id
   where c.lead_id is not null and c.provider <> 'WEBCHAT' and (n.direction = 'in' or n.read_at is not null or n.bounced_at is not null);
  perform outreach__stats_safe_rebuild(leads);
  return null;
end $$;
create or replace function outreach_trg_stats_messages_upd() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare leads uuid[];
begin
  select array_agg(distinct c.lead_id) into leads
    from new_rows n join old_rows o on o.id = n.id join outreach_chats c on c.id = n.chat_id
   where c.lead_id is not null and c.provider <> 'WEBCHAT'
     and (n.intent is distinct from o.intent or n.is_auto_reply <> o.is_auto_reply or n.is_bounce <> o.is_bounce
          or n.read_at is distinct from o.read_at or n.bounced_at is distinct from o.bounced_at or n.deleted_at is distinct from o.deleted_at
          or n.sent_at <> o.sent_at or n.chat_id <> o.chat_id);
  perform outreach__stats_safe_rebuild(leads);
  return null;
end $$;
drop trigger if exists outreach_messages_stats_ins on outreach_messages;
create trigger outreach_messages_stats_ins after insert on outreach_messages referencing new table as new_rows for each statement execute function outreach_trg_stats_messages_ins();
drop trigger if exists outreach_messages_stats_upd on outreach_messages;
create trigger outreach_messages_stats_upd after update on outreach_messages referencing old table as old_rows new table as new_rows for each statement execute function outreach_trg_stats_messages_upd();

-- 4d. a chat matched to its lead after its messages arrived (webhook / sync name resolution)
create or replace function outreach_trg_stats_chat_lead() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__stats_safe_rebuild(array[new.lead_id, old.lead_id]);
  return null;
end $$;
drop trigger if exists outreach_chats_stats_lead on outreach_chats;
create trigger outreach_chats_stats_lead after update of lead_id on outreach_chats for each row
  when (new.lead_id is distinct from old.lead_id and new.provider <> 'WEBCHAT') execute function outreach_trg_stats_chat_lead();

-- 4e. meeting booked (stage with kind meeting, booking link, CRM, API: every writer goes through outreach_lead_milestones)
create or replace function outreach_trg_stats_milestone() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__stats_safe_rebuild(array[case when tg_op = 'DELETE' then old.lead_id else new.lead_id end]);
  return null;
end $$;
drop trigger if exists outreach_milestones_stats on outreach_lead_milestones;
create trigger outreach_milestones_stats after insert or update of at on outreach_lead_milestones for each row
  when (new.kind = 'meeting') execute function outreach_trg_stats_milestone();
drop trigger if exists outreach_milestones_stats_del on outreach_lead_milestones;
create trigger outreach_milestones_stats_del after delete on outreach_lead_milestones for each row
  when (old.kind = 'meeting') execute function outreach_trg_stats_milestone();

-- 4f. enrolments removed (sequence deleted, lead deleted): the cache row must drop them
create or replace function outreach_trg_stats_enrollment_del() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach__stats_enqueue((select array_agg(distinct sequence_id) from old_rows));
  return null;
end $$;
drop trigger if exists outreach_enrollments_stats_del on outreach_enrollments;
create trigger outreach_enrollments_stats_del after delete on outreach_enrollments referencing old table as old_rows for each statement execute function outreach_trg_stats_enrollment_del();

-- ----------------------------------------------------------------------------- 5. reading the facts
-- The channels a sequence uses (§3.3): steps of the head version, then channels seen only in the facts for the period.
create or replace function outreach__graph_channels(p_graph jsonb, p_pools jsonb) returns table(channel text, invite_step boolean, ord int)
language plpgsql immutable as $$
declare nums jsonb := outreach_graph_step_numbers(p_graph); k text; n jsonb; t text; c text; chans text[]; x text; i int := 0;
        pool_provs text[] := coalesce((select array_agg(lower(key)) from jsonb_object_keys(coalesce(p_pools, '{}'::jsonb)) key where key in ('LINKEDIN','INSTAGRAM','WHATSAPP')), '{}');
        seen jsonb := '{}'::jsonb;
begin
  for k in select key from jsonb_each(coalesce(p_graph->'nodes', '{}'::jsonb)) order by coalesce((nums->>key)::int, 9999), key loop
    n := p_graph->'nodes'->k; t := n->>'type'; c := lower(nullif(coalesce(n->'config'->>'channel', n->'config'->>'to_channel'), ''));
    chans := null;
    if t = 'send_email' then chans := array['email'];
    elsif t in ('send_invite','send_inmail','withdraw_invite','visit_profile','refresh_profile','like_latest_post','comment_latest_post','endorse_skills','follow_profile') then chans := array['linkedin'];
    elsif t = 'channel_switch' then chans := case when c is not null then array[c] else null end;
    elsif t in ('send_message','send_voice_note') then chans := case when c is not null then array[c] when cardinality(pool_provs) > 0 then pool_provs else array['linkedin'] end;
    elsif t in ('follow','unfollow','like_recent_posts','comment_post') then chans := array[coalesce(c, 'instagram')];
    elsif t = 'check_identifier' then chans := array[coalesce(c, 'whatsapp')];
    end if;
    if chans is null then continue; end if;
    foreach x in array chans loop
      if x not in ('linkedin','instagram','whatsapp','email') then continue; end if;
      if not (seen ? x) then i := i + 1; seen := seen || jsonb_build_object(x, i); end if;
      channel := x; ord := (seen->>x)::int;
      invite_step := (t = 'send_invite' and x = 'linkedin') or (t = 'follow' and x = 'instagram');
      return next;
    end loop;
  end loop;
end $$;

create or replace function outreach__sequence_channels(p_sequence uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with q as (select graph, sender_pools from outreach_sequences where id = p_sequence),
  g as (select channel, bool_or(invite_step) as invite_step, min(ord) as ord from q, lateral outreach__graph_channels(q.graph, q.sender_pools) group by channel),
  a as (select cf.channel, min(coalesce(cf.contacted_at, cf.bounced_at)) as first_at
          from outreach_sequence_channel_facts cf join outreach_sequence_lead_facts lf on lf.enrollment_id = cf.enrollment_id
         where cf.sequence_id = p_sequence and (cf.contacted_at is not null or cf.bounced_at is not null)   -- a reply alone is "replied on another channel", not a block
           and (p_from is null or lf.first_attempt_at >= p_from) and (p_to is null or lf.first_attempt_at < p_to)
         group by cf.channel),
  u as (select coalesce(g.channel, a.channel) as channel, coalesce(g.invite_step, false) as invite_step, g.channel is null as from_earlier_version,
               case when g.channel is not null then 0 else 1 end as grp, coalesce(g.ord, 0) as ord, a.first_at
          from g full join a on a.channel = g.channel)
  select coalesce(jsonb_agg(jsonb_build_object('channel', channel, 'invite_step', invite_step, 'from_earlier_version', from_earlier_version) order by grp, ord, first_at nulls last, channel), '[]'::jsonb) from u
$$;
revoke execute on function outreach__sequence_channels(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- The results block (§3.1): people counted once, cohort = leads first contacted in [p_from, p_to), everything they did after.
-- Null bounds = all time. Rates are null when the denominator is 0.
create or replace function outreach__stats_block(p_sequence uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with c as (   -- one row per lead in the cohort
    select lead_id, min(first_contacted_at) as fc,
           bool_or(invited_at is not null) as invited, bool_or(accepted_at is not null) as accepted,
           bool_or(invited_at is not null and accepted_at is null and invite_closed_at is null) as pending_any,
           min(replied_at) as replied_at, bool_or(auto_replied_at is not null) as auto_replied,
           bool_or(positive_at is not null) as positive, bool_or(meeting_at is not null) as meeting,
           (array_agg(reply_channel order by replied_at) filter (where replied_at is not null))[1] as reply_channel
      from outreach_sequence_lead_facts
     where sequence_id = p_sequence and (p_from is null or first_attempt_at >= p_from) and (p_to is null or first_attempt_at < p_to)
     group by lead_id),
  sp as (   -- the accept funnel per invite channel (LinkedIn invitations, Instagram follows)
    select f.invite_channel as channel, count(distinct f.lead_id) as invited,
           count(distinct f.lead_id) filter (where f.accepted_at is not null) as accepted,
           count(distinct f.lead_id) filter (where f.accepted_at is null and f.invite_closed_at is null) as pending
      from outreach_sequence_lead_facts f join c on c.lead_id = f.lead_id
     where f.sequence_id = p_sequence and f.invite_channel is not null group by f.invite_channel),
  rc as (select reply_channel as channel, count(*) as n from c where replied_at is not null group by reply_channel),
  t as (
    select count(*) filter (where fc is not null) as contacted,
           count(*) filter (where invited) as invited, count(*) filter (where accepted) as accepted,
           count(*) filter (where invited and not accepted and pending_any) as pending,
           count(*) filter (where replied_at is not null) as replied,
           count(*) filter (where auto_replied and replied_at is null) as auto_replied,
           count(*) filter (where positive) as positive, count(*) filter (where meeting) as meetings,
           count(*) as attempted
      from c)
  select jsonb_build_object(
    'contacted', t.contacted, 'invited', t.invited, 'accepted', t.accepted, 'accepted_rate', outreach__rate(t.accepted, t.invited),
    'pending', t.pending, 'accepted_early', t.invited > 0 and t.pending * 2 > t.invited,
    'accepted_split', coalesce((select jsonb_object_agg(sp.channel, jsonb_build_object('invited', sp.invited, 'accepted', sp.accepted, 'pending', sp.pending, 'accepted_rate', outreach__rate(sp.accepted, sp.invited))) from sp), '{}'::jsonb),
    'replied', t.replied, 'replied_rate', outreach__rate(t.replied, t.contacted), 'auto_replied', t.auto_replied,
    'positive', t.positive, 'positive_rate', outreach__rate(t.positive, t.replied), 'meetings', t.meetings,
    'replied_by_channel', coalesce((select jsonb_object_agg(rc.channel, rc.n) from rc), '{}'::jsonb),
    'cohort', t.attempted)
  from t
$$;
revoke execute on function outreach__stats_block(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Per-channel funnels (§3.2) for the same cohort. Only the stages a channel has are returned.
create or replace function outreach__stats_channel_blocks(p_sequence uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with c as (
    select lead_id from outreach_sequence_lead_facts
     where sequence_id = p_sequence and (p_from is null or first_attempt_at >= p_from) and (p_to is null or first_attempt_at < p_to) group by lead_id),
  x as (
    select cf.channel,
           count(distinct cf.lead_id) filter (where cf.contacted_at is not null and (cf.channel <> 'email' or cf.bounced_at is null)) as contacted,
           count(distinct cf.lead_id) filter (where cf.invited_at is not null) as invited,
           count(distinct cf.lead_id) filter (where cf.accepted_at is not null) as accepted,
           count(distinct cf.lead_id) filter (where cf.messaged_at is not null) as messaged,
           count(distinct cf.lead_id) filter (where cf.seen_at is not null) as seen,
           count(distinct cf.lead_id) filter (where cf.replied_at is not null) as replied,
           count(distinct cf.lead_id) filter (where cf.replied_at is not null and cf.accepted_at is not null) as replied_of_accepted,
           count(distinct cf.lead_id) filter (where cf.bounced_at is not null) as bounced
      from outreach_sequence_channel_facts cf join c on c.lead_id = cf.lead_id
     where cf.sequence_id = p_sequence group by cf.channel)
  select coalesce(jsonb_object_agg(x.channel,
    case x.channel
      when 'linkedin' then jsonb_build_object('contacted', x.contacted, 'invited', x.invited, 'accepted', x.accepted, 'accepted_rate', outreach__rate(x.accepted, x.invited),
                                              'messaged', x.messaged, 'seen', x.seen, 'replied', x.replied, 'replied_rate', outreach__rate(x.replied, x.contacted),
                                              'replied_of_accepted', x.replied_of_accepted, 'replied_of_accepted_rate', outreach__rate(x.replied_of_accepted, x.accepted))
      when 'instagram' then jsonb_build_object('contacted', x.contacted, 'invited', x.invited, 'accepted', x.accepted, 'accepted_rate', outreach__rate(x.accepted, x.invited),
                                               'messaged', x.messaged, 'seen', x.seen, 'replied', x.replied, 'replied_rate', outreach__rate(x.replied, x.contacted))
      when 'whatsapp' then jsonb_build_object('contacted', x.contacted, 'seen', x.seen, 'replied', x.replied, 'replied_rate', outreach__rate(x.replied, x.contacted), 'bounced', x.bounced)
      else jsonb_build_object('contacted', x.contacted, 'replied', x.replied, 'replied_rate', outreach__rate(x.replied, x.contacted), 'bounced', x.bounced) end), '{}'::jsonb)
  from x
$$;
revoke execute on function outreach__stats_channel_blocks(uuid, timestamptz, timestamptz) from public, anon, authenticated;

-- Progress and ops (period-independent: they describe the sequence now)
create or replace function outreach__stats_progress(p_sequence uuid) returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  with e as (select count(distinct lead_id) as enrolled, count(*) as total,
                    count(*) filter (where status in ('active','waiting_connection','waiting_delay','waiting_task','paused')) as live,
                    count(*) filter (where status = 'failed') as failed_leads
               from outreach_enrollments where sequence_id = p_sequence),
       n as (select coalesce(sum(queued), 0) as queued, coalesce(sum(sent), 0) as sent, coalesce(sum(failed), 0) as failed from outreach_node_stats where sequence_id = p_sequence)
  select jsonb_build_object(
    'progress', jsonb_build_object('enrolled', e.enrolled, 'live', e.live, 'done', e.total - e.live, 'pct_done', case when e.total > 0 then round(100.0 * (e.total - e.live) / e.total, 1) end),
    'ops', jsonb_build_object('queued', n.queued, 'actions_sent', n.sent, 'failed', n.failed, 'failed_leads', e.failed_leads))
  from e, n
$$;
revoke execute on function outreach__stats_progress(uuid) from public, anon, authenticated;

-- Cache: the all-time block + the channels seen in the facts, per sequence
create or replace function outreach_stats_refresh(p_sequence uuid) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then delete from outreach_sequence_stats_cache where sequence_id = p_sequence; return; end if;
  insert into outreach_sequence_stats_cache(sequence_id, workspace_id, stats, refreshed_at)
  values (p_sequence, ws, outreach__stats_block(p_sequence, null, null), now())
  on conflict (sequence_id) do update set stats = excluded.stats, refreshed_at = now();
end $$;
revoke execute on function outreach_stats_refresh(uuid) from public, anon, authenticated;

create or replace function outreach_stats_refresh_due(p_limit int default 500) returns int
language plpgsql security definer set search_path = public, extensions as $$
declare r record; n int := 0;
begin
  if not pg_try_advisory_xact_lock(hashtext('outreach_stats_refresh_due')) then return 0; end if;
  for r in delete from outreach_stats_refresh_queue q
            where q.sequence_id in (select sequence_id from outreach_stats_refresh_queue order by queued_at limit greatest(1, p_limit))
            returning q.sequence_id loop
    begin perform outreach_stats_refresh(r.sequence_id); n := n + 1;
    exception when others then raise warning 'outreach_stats_refresh(%): %', r.sequence_id, sqlerrm; end;
  end loop;
  return n;
end $$;
revoke execute on function outreach_stats_refresh_due(int) from public, anon, authenticated;

-- NA reasons and the definitions version, shared by list and detail
create or replace function outreach__stats_na(p_channels jsonb, p_block jsonb) returns jsonb
language sql immutable as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'accepted', case when not exists (select 1 from jsonb_array_elements(p_channels) c where (c->>'invite_step')::boolean) and coalesce((p_block->>'invited')::int, 0) = 0
                     then 'This sequence doesn''t send connection requests or follows.' end,
    'seen', case when jsonb_array_length(p_channels) > 0 and not exists (select 1 from jsonb_array_elements(p_channels) c where c->>'channel' <> 'email')
                 then 'Email opens aren''t tracked.' end))
$$;

create or replace function outreach__stats_cohort_bounds(p_ws uuid, p_from date, p_to date, out f_ts timestamptz, out t_ts timestamptz, out z text)
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  z := outreach_ws_tz(p_ws);
  if p_from is null and p_to is null then return; end if;
  if p_from is null or p_to is null or p_to < p_from then raise exception 'E_PAYLOAD_INVALID: from/to must be dates with from <= to, or both empty for all time'; end if;
  if p_to - p_from > 731 then raise exception 'E_PAYLOAD_INVALID: range is limited to 2 years'; end if;
  f_ts := p_from::timestamp at time zone z; t_ts := (p_to + 1)::timestamp at time zone z;
end $$;
revoke execute on function outreach__stats_cohort_bounds(uuid, date, date) from public, anon, authenticated;

-- One row of the Sequences list / Reports → Sequences. p_live: compute the block from the facts even for all time.
create or replace function outreach__stats_row(q outreach_sequences, p_from timestamptz, p_to timestamptz, p_live boolean) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare blk jsonb; chans jsonb; pr jsonb; cached_at timestamptz;
begin
  if p_from is null and p_to is null and not p_live then
    select c.stats, c.refreshed_at into blk, cached_at from outreach_sequence_stats_cache c where c.sequence_id = q.id;
    if blk is null or exists (select 1 from outreach_stats_refresh_queue r where r.sequence_id = q.id) then blk := null; cached_at := null; end if;
  end if;
  if blk is null then blk := outreach__stats_block(q.id, p_from, p_to); end if;
  chans := outreach__sequence_channels(q.id, p_from, p_to);
  pr := outreach__stats_progress(q.id);
  return jsonb_build_object('sequence_id', q.id, 'name', q.name, 'status', q.status, 'client_id', q.client_id, 'head_version', q.head_version,
           'steps', (select count(*) from jsonb_each(coalesce(q.graph->'nodes', '{}'::jsonb)) x where outreach_is_executable_node(x.value->>'type') or (x.value->>'type') in ('wait_connection','ab_split','ai_route','manual_task','call_task','channel_switch','condition')),
           'stalled', q.stalled_at is not null, 'stalled_reason', q.stalled_reason, 'throttled_reason', q.throttled_reason,
           'has_ab_test', q.graph::text like '%"variants"%' or q.graph::text like '%"ab_split"%', 'updated_at', q.updated_at,
           'channels', chans, 'na', outreach__stats_na(chans, blk), 'cached_at', cached_at, 'definitions_version', 2)
         || blk || pr;
end $$;
revoke execute on function outreach__stats_row(outreach_sequences, timestamptz, timestamptz, boolean) from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 6. the public report functions
-- Sequences list: p_from/p_to both null = all time (cache), else the cohort first contacted in the period (§3.5).
-- p_channel: only sequences that use that channel (numbers stay whole-sequence). p_status: draft | active | paused | archived | all
-- (null = every status but archived, as Reports always did).
drop function if exists outreach_report_sequences(uuid, uuid, date, date);
create or replace function outreach_report_sequences(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_channel text default null, p_status text default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare b record; vis uuid[] := outreach_visible_clients(p_ws);
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_client is not null and not outreach_client_visible(p_ws, p_client) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  select * into b from outreach__stats_cohort_bounds(p_ws, p_from, p_to);
  return (select coalesce(jsonb_agg(r.rw order by coalesce((r.rw->>'replied')::int, 0) desc, r.rw->>'name'), '[]'::jsonb)
            from (select outreach__stats_row(q, b.f_ts, b.t_ts, false) as rw
                    from outreach_sequences q
                   where q.workspace_id = p_ws and (p_status is not null or q.status <> 'archived') and (p_status is null or p_status = 'all' or q.status::text = p_status)
                     and (p_client is null or q.client_id = p_client) and (vis is null or q.client_id is null or q.client_id = any(vis))) r
           where p_channel is null or exists (select 1 from jsonb_array_elements(r.rw->'channels') c where c->>'channel' = p_channel));
end $$;
grant execute on function outreach_report_sequences(uuid, uuid, date, date, text, text) to authenticated;

-- One sequence: the header funnel, the per-channel blocks, "replied on another channel", plus the existing per-step
-- table, best / worst step, A/B blocks and exits (013). Dates both null = all time.
create or replace function outreach_report_sequence(p_sequence uuid, p_from date default null, p_to date default null)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; b record; f date; t date; tot jsonb; steps jsonb; ab jsonb := '[]'; k text; nd jsonb; best jsonb; worst jsonb; exits jsonb;
        row_ jsonb; chans jsonb; blocks jsonb; graph_ch text[]; other jsonb; seen_since date;
begin
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'client_viewer');
  if not outreach_client_visible(s.workspace_id, s.client_id) then raise exception 'E_FORBIDDEN'; end if;
  select * into b from outreach__stats_cohort_bounds(s.workspace_id, p_from, p_to);
  -- the step table reads the dated facts of 013: all time = since the sequence was created, at most two years back
  t := coalesce(p_to, (now() at time zone b.z)::date);
  f := coalesce(p_from, greatest((s.created_at at time zone b.z)::date, t - 730));
  if f > t then f := t; end if;

  select totals into tot from outreach__grouped(s.workspace_id, null, f, t, 'none', jsonb_build_object('sequence_id', p_sequence));
  select coalesce(jsonb_agg(jsonb_build_object('node_id', x.key, 'step_number', (outreach_graph_step_numbers(s.graph)->>x.key)::int, 'type', x.value->>'type', 'label', coalesce(x.value->>'label', replace(x.value->>'type','_',' ')),
           'sent', coalesce((g.totals->>'invites')::numeric,0) + coalesce((g.totals->>'messages')::numeric,0) + coalesce((g.totals->>'inmails')::numeric,0) + coalesce((g.totals->>'emails')::numeric,0)
                   + coalesce((g.totals->>'profile_views')::numeric,0) + coalesce((g.totals->>'likes')::numeric,0) + coalesce((g.totals->>'comments')::numeric,0) + coalesce((g.totals->>'endorsements')::numeric,0) + coalesce((g.totals->>'follows')::numeric,0)
                   + coalesce((g.totals->>'new_chats')::numeric,0),
           'failed', coalesce(g.totals->'failed','0'), 'skipped', coalesce(g.totals->'skipped','0'), 'accepted', coalesce(g.totals->'accepted','0'),
           'replies', coalesce(g.totals->'replies','0'), 'interested', coalesce(g.totals->'interested','0'),
           'reply_rate', g.totals->'reply_rate', 'positive_reply_rate', g.totals->'positive_reply_rate', 'acceptance_rate', g.totals->'acceptance_rate',
           'leads_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
           'failed_here', (select count(*) from outreach_enrollments e where e.sequence_id = p_sequence and e.current_node_id = x.key and e.status = 'failed'))
           order by (outreach_graph_step_numbers(s.graph)->>x.key)::int nulls last, x.key), '[]'::jsonb)
    into steps
    from jsonb_each(s.graph->'nodes') x left join outreach__grouped(s.workspace_id, null, f, t, 'node', jsonb_build_object('sequence_id', p_sequence)) g on g.grp = p_sequence::text || '|' || x.key
   where outreach_is_executable_node(x.value->>'type') or (x.value->>'type') in ('wait_connection','ab_split','ai_route','manual_task','call_task');
  select x into best from jsonb_array_elements(steps) x where (x->>'sent')::numeric >= 20 and x->>'reply_rate' is not null order by (x->>'reply_rate')::numeric desc limit 1;
  select x into worst from jsonb_array_elements(steps) x where (x->>'sent')::numeric >= 20 and x->>'reply_rate' is not null order by (x->>'reply_rate')::numeric asc limit 1;
  for k, nd in select * from jsonb_each(s.graph->'nodes') loop
    if (nd->>'type') = 'ab_split' or (jsonb_typeof(nd->'config'->'variants') = 'array' and jsonb_array_length(nd->'config'->'variants') > 1) then
      ab := ab || outreach_ab_results(p_sequence, k, f, t);
    end if;
  end loop;
  select coalesce(jsonb_object_agg(x.k, x.c), '{}'::jsonb) into exits from (
    select e.status::text || coalesce(':' || nullif(e.exit_reason,''), '') k, count(*) c from outreach_enrollments e
     where e.sequence_id = p_sequence and e.completed_at >= (f::timestamp at time zone b.z) and e.completed_at < ((t + 1)::timestamp at time zone b.z) group by 1) x;

  -- the new blocks (always live from the facts: one sequence is cheap)
  row_ := outreach__stats_row(s, b.f_ts, b.t_ts, true);
  chans := row_->'channels';
  blocks := outreach__stats_channel_blocks(p_sequence, b.f_ts, b.t_ts);
  select coalesce(array_agg(c->>'channel'), '{}') into graph_ch from jsonb_array_elements(chans) c where not (c->>'from_earlier_version')::boolean;
  select coalesce(jsonb_object_agg(x.key, x.value), '{}'::jsonb) into other from jsonb_each(coalesce(row_->'replied_by_channel', '{}'::jsonb)) x where not (x.key = any(graph_ch));
  seen_since := nullif(coalesce((select value #>> '{}' from outreach_flags where key = 'stats_seen_since'), ''), '')::date;

  return jsonb_build_object('sequence', jsonb_build_object('id', s.id, 'name', s.name, 'status', s.status, 'head_version', s.head_version, 'stalled_reason', s.stalled_reason, 'client_id', s.client_id),
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'all', p_from is null and p_to is null, 'timezone', b.z, 'steps_from', f, 'steps_to', t),
    'funnel', row_ - 'name' - 'status' - 'client_id' - 'head_version' - 'steps' - 'stalled' - 'stalled_reason' - 'throttled_reason' - 'has_ab_test' - 'updated_at',
    'channels', (select coalesce(jsonb_agg(c || jsonb_build_object('stages', coalesce(blocks->(c->>'channel'), '{}'::jsonb)) order by o), '[]'::jsonb) from jsonb_array_elements(chans) with ordinality x(c, o)),
    'replied_other_channel', other,
    'seen_since', seen_since, 'seen_partial', seen_since is not null and (p_from is null or p_from < seen_since),
    'definitions_version', 2,
    'totals', coalesce(tot, outreach__totals_from('{}'::jsonb)), 'steps', steps,
    'best_step', case when best is distinct from worst then best end, 'worst_step', case when best is distinct from worst then worst end, 'ab_tests', ab, 'exits', exits,
    'live', (row_->'progress'->>'live')::int);
end $$;
grant execute on function outreach_report_sequence(uuid, date, date) to authenticated;

-- /v1/sequences rows carry the all-time results too (PRD §8); `sent` kept for 90 days as actions_sent
create or replace function outreach_api_sequences(p_ws uuid, p_status text default null, p_client uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', q.id, 'name', q.name, 'status', q.status, 'client_id', q.client_id, 'head_version', q.head_version, 'sender_pool', q.sender_pool, 'assignment', q.assignment,
            'stalled', q.stalled_at is not null, 'stalled_reason', q.stalled_reason, 'throttled_reason', q.throttled_reason, 'created_at', q.created_at, 'updated_at', q.updated_at,
            'live', (select count(*) from outreach_enrollments e where e.sequence_id = q.id and e.status in ('active','waiting_connection','waiting_delay','waiting_task','paused')),
            'stats', outreach__stats_row(q, null, null, false) - 'sequence_id' - 'name' - 'status' - 'client_id' - 'head_version' - 'stalled' - 'stalled_reason' - 'throttled_reason' - 'updated_at' - 'steps' - 'has_ab_test')
            order by q.created_at desc), '[]'::jsonb)
            from outreach_sequences q where q.workspace_id = p_ws and outreach_client_visible(p_ws, q.client_id) and (p_status is null or q.status::text = p_status) and (p_client is null or q.client_id = p_client));
end $$;

-- definitions: the §3 wording joins the existing text (keys the Reports page and the connector already quote stay)
create or replace function outreach_metric_definitions() returns jsonb
language sql immutable as $$
  select jsonb_build_object(
    'definitions_version', '2',
    'day', 'A calendar day in the workspace timezone (Settings → Workspace). Ranges include both end dates.',
    'invites', 'Connection requests LinkedIn accepted for delivery in the period.',
    'accepted', 'People whose connection request (LinkedIn) or follow (Instagram) from this sequence was accepted, whenever that happened. Rate: accepted ÷ invited. Shown with the number still pending; greyed as "early" while more than half are pending.',
    'acceptance_rate', 'Accepted ÷ invites sent, both in the period.',
    'touches', 'Messages + InMails + emails + new chats + invitations that carried a note. The denominator of every reply rate.',
    'new_chats', 'Conversations the platform started with someone it had no chat with yet, on any channel. WhatsApp and Instagram watch this number closely.',
    'replies', 'Threads in which the lead answered an automated step for the first time in the period. One lead answering three times is one reply. Replies to a teammate''s manual message are conversation, not replies.',
    'reply_rate', 'Replies ÷ touches.',
    'replies_per_100_actions', 'Replies ÷ every metered outbound action (invites, new chats, messages, InMails, emails, likes, comments, follows) × 100. Compares channels with very different volumes.',
    'interested', 'Replies whose thread is currently classified "interested" (AI classification, or your override).',
    'positive_reply_rate', 'Interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'negative_reply_rate', 'Not-interested replies ÷ replies, leaving out-of-office auto-replies out of the denominator.',
    'blocks', 'Times a person blocked the sender or a chat went one-way after our first message (detected by the executor and the block worker). Each one lowers the sender''s level.',
    'consent basis', 'Why we may message this person on WhatsApp: they wrote first (inbound), opted in on a form, are an existing customer, replied on LinkedIn, shared their number, or an operator attested consent at import (the weakest basis, shown in amber).',
    'meetings', 'Leads that reached a Meeting stage or booked through the booking link in the period. Counted once per lead.',
    'won', 'Leads that reached a Won stage in the period. Counted once per lead.',
    'cost_per_reply', 'Sender cost for the period ÷ replies. Sender cost = monthly cost × days in period ÷ 30 for every sender that was connected.',
    'funnel', 'Follows the leads ENROLLED in the period through every later stage, whenever that stage happened.',
    'headroom', 'Share of the invitation cap a sender did not use over the last 30 days.',
    -- sequence stats (089)
    'contacted', 'People who got at least one connection request, follow or message from this sequence (LinkedIn invitation, message or InMail; Instagram follow or message; WhatsApp message; email). Profile visits, likes, comments and endorsements don''t count. One person counts once, however many channels or steps reached them.',
    'invited', 'People this sequence sent a LinkedIn connection request or an Instagram follow to. The denominator of the accepted rate.',
    'pending', 'Invited, not accepted, and the request is still open (not withdrawn, not declined or expired).',
    'replied', 'People who wrote back, as a person, after this sequence contacted them. A reply belongs to the sequence that contacted the lead last before it; it is counted once, at the first human reply. Out-of-office and automatic replies don''t count. Rate: replied ÷ contacted.',
    'auto_replied', 'People from whom only an out-of-office or automatic reply arrived. Shown in the tooltip, never counted as replied.',
    'positive', 'Replied people whose reply (or a later message of theirs within 30 days) was classified interested or question, or who reached a Meeting stage while in or after this sequence. Rate: positive ÷ replied.',
    'seen', 'At least this many people saw a message from this sequence (read receipts on LinkedIn, Instagram and WhatsApp). People can turn read receipts off, so this undercounts. Email opens aren''t tracked.',
    'bounced', 'Email: the address bounced hard. WhatsApp: the number is not on WhatsApp (the check before the first message).',
    'cohort', 'For a period, the sequence counts the people it FIRST contacted in that period, and everything they did afterwards up to today. All time counts everyone.',
    'progress', 'Enrolled = people in the sequence (ever). Live = enrolments still running, waiting or paused. Done = finished, replied, removed or failed.')
$$;

-- ----------------------------------------------------------------------------- 7. reconcile (F54) + health
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order)
values ('stats-1', 'flow', 'Sequence stats drift', 'Do the stored sequence numbers still match what actually happened?', '%', 0.2, 1, false, false, 'G3', 'sql', 1440, 45)
on conflict (key) do nothing;

create or replace function outreach_stats_reconcile(p_days int default 7, p_limit int default 500) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare r record; checked int; fixed int; pct numeric; worst numeric := 0; worst_seq uuid; seqs int := 0; fixed_total int := 0; st text; summ text; worst_name text;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  if not pg_try_advisory_xact_lock(hashtext('outreach_stats_reconcile')) then return jsonb_build_object('busy', true); end if;
  for r in
    select q.id, q.workspace_id, q.name from outreach_sequences q
     where exists (select 1 from outreach_sequence_lead_facts f where f.sequence_id = q.id and f.updated_at > now() - make_interval(days => p_days))
        or exists (select 1 from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id where e.sequence_id = q.id and a.executed_at > now() - make_interval(days => p_days))
        or exists (select 1 from outreach_stats_refresh_queue x where x.sequence_id = q.id)
        or not exists (select 1 from outreach_sequence_stats_cache c where c.sequence_id = q.id)
     order by q.updated_at desc limit greatest(1, p_limit)
  loop
    begin
      select count(*) into checked from outreach_sequence_lead_facts where sequence_id = r.id;
      fixed := outreach_stats_rebuild_sequence(r.id);
      perform outreach_stats_refresh(r.id);
      delete from outreach_stats_refresh_queue where sequence_id = r.id;
      pct := case when checked > 0 then round(100.0 * fixed / checked, 2) when fixed > 0 then 100 else 0 end;
      seqs := seqs + 1; fixed_total := fixed_total + fixed;
      if fixed > 0 then
        insert into ops.stats_reconcile_log(workspace_id, sequence_id, rows_checked, rows_fixed, pct_fixed, detail) values (r.workspace_id, r.id, checked, fixed, pct, jsonb_build_object('name', r.name));
        if pct > worst then worst := pct; worst_seq := r.id; worst_name := r.name; end if;
      end if;
    exception when others then
      insert into ops.stats_reconcile_log(workspace_id, sequence_id, rows_checked, rows_fixed, pct_fixed, detail) values (r.workspace_id, r.id, 0, 0, null, jsonb_build_object('name', r.name, 'error', sqlerrm));
    end;
  end loop;
  delete from ops.stats_reconcile_log where at < now() - interval '90 days';
  st := case when worst >= 1 then 'act' when worst > 0.2 then 'watch' else 'ok' end;
  summ := case when fixed_total = 0 then format('%s sequences checked, every stored number matched.', seqs)
               else format('%s sequences checked, %s fact rows corrected. Largest drift: %s%% in "%s".', seqs, fixed_total, worst, worst_name) end;
  begin
    perform ops.health_apply('stats-1', st, worst, summ, jsonb_build_object('sequences', seqs, 'rows_fixed', fixed_total, 'worst_sequence_id', worst_seq,
      'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', l.at, 'sequence_id', l.sequence_id, 'name', l.detail->>'name', 'rows_checked', l.rows_checked, 'rows_fixed', l.rows_fixed, 'pct', l.pct_fixed, 'error', l.detail->>'error') order by l.at desc), '[]'::jsonb)
                   from (select * from ops.stats_reconcile_log order by at desc limit 20) l)));
  exception when others then raise warning 'stats-1 health_apply: %', sqlerrm; end;
  return jsonb_build_object('sequences', seqs, 'rows_fixed', fixed_total, 'worst_pct', worst, 'status', st);
end $$;
revoke execute on function outreach_stats_reconcile(int, int) from public, anon, authenticated;

-- ----------------------------------------------------------------------------- 8. cron
do $$ begin perform cron.unschedule('outreach-stats-refresh'); exception when others then null; end $$;
do $$ begin perform cron.unschedule('outreach-stats-reconcile'); exception when others then null; end $$;
select cron.schedule('outreach-stats-refresh',   '* * * * *',  $$select outreach_stats_refresh_due(500)$$);
select cron.schedule('outreach-stats-reconcile', '15 3 * * *', $$select outreach_stats_reconcile(7, 500)$$);

-- ----------------------------------------------------------------------------- 9. backfill (§4.3): every sequence, then its cache
do $$
declare q record; n int := 0;
begin
  for q in select id from outreach_sequences order by workspace_id, created_at loop
    perform outreach_stats_rebuild_sequence(q.id);
    perform outreach_stats_refresh(q.id);
    n := n + 1;
  end loop;
  delete from outreach_stats_refresh_queue;
  raise notice 'sequence stats backfilled for % sequences', n;
end $$;
