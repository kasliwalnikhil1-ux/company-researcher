-- =============================================================================
-- Outreach Platform — 008 MCP agent layer (outreach-mcp edge function)
--
-- State the MCP server keeps between two tool calls (confirmation tokens,
-- enrolment previews, reply drafts, call log). Service-role only: RLS enabled,
-- no policies — the same convention as the other ops tables.
--
-- Also three small RPCs so in-flight sequence edits stay inside the database's
-- permission model instead of the MCP writing to outreach_actions directly.
-- =============================================================================

-- Two-step confirmation tokens (single use, 10 min, bound to the argument hash)
create table if not exists outreach_agent_confirmations (
  token           text primary key,
  user_id         uuid not null,
  workspace_id    uuid,
  tool            text not null,
  args_sha256     text not null,
  effect_summary  text,
  payload         jsonb,
  expires_at      timestamptz not null,
  used_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index if not exists outreach_agent_conf_user_idx on outreach_agent_confirmations(user_id, expires_at);

-- Enrolment previews: enroll_commit only accepts a preview token (15 min)
create table if not exists outreach_agent_previews (
  token         text primary key,
  user_id       uuid not null,
  workspace_id  uuid not null,
  sequence_id   uuid not null,
  lead_ids      uuid[] not null,
  sender_id     uuid,
  assignment    jsonb,
  excluded      jsonb,
  expires_at    timestamptz not null,
  committed_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists outreach_agent_prev_user_idx on outreach_agent_previews(user_id, expires_at);

-- Reply drafts: bound to (chat, last inbound message) so staleness is checked at send time
create table if not exists outreach_agent_drafts (
  token            text primary key,
  user_id          uuid not null,
  workspace_id     uuid not null,
  chat_id          uuid not null,
  last_message_id  uuid,
  draft_text       text not null,
  rationale        text,
  variant          smallint not null default 1,
  expires_at       timestamptz not null,
  sent_at          timestamptz,
  sent_text        text,
  created_at       timestamptz not null default now()
);
create index if not exists outreach_agent_drafts_chat_idx on outreach_agent_drafts(chat_id) where sent_at is null;

-- Per-call log (observability: tool usage, error codes, latency)
create table if not exists outreach_agent_calls (
  id            bigserial primary key,
  user_id       uuid,
  workspace_id  uuid,
  tool          text not null,
  args_sha256   text,
  outcome       text,
  error_code    text,
  duration_ms   int,
  at            timestamptz not null default now()
);
create index if not exists outreach_agent_calls_at_idx on outreach_agent_calls(at desc);

alter table outreach_agent_confirmations enable row level security;
alter table outreach_agent_previews      enable row level security;
alter table outreach_agent_drafts        enable row level security;
alter table outreach_agent_calls         enable row level security;

-- Housekeeping (called opportunistically by the MCP; safe to run any time)
create or replace function outreach_agent_gc() returns void
language sql security definer set search_path = public, extensions as $$
  delete from outreach_agent_confirmations where expires_at < now() - interval '1 day';
  delete from outreach_agent_previews      where expires_at < now() - interval '1 day';
  delete from outreach_agent_drafts        where expires_at < now() - interval '7 days';
  delete from outreach_agent_calls         where at < now() - interval '90 days';
$$;
revoke execute on function outreach_agent_gc() from public, anon, authenticated;

-- Daily housekeeping job (04:10 UTC, after outreach-cleanup); idempotent re-schedule
do $$
declare jid bigint;
begin
  select jobid into jid from cron.job where jobname = 'outreach-agent-gc';
  if jid is not null then perform cron.unschedule(jid); end if;
  perform cron.schedule('outreach-agent-gc', '10 4 * * *', $cmd$select outreach_agent_gc();$cmd$);
end $$;

-- -----------------------------------------------------------------------------
-- In-flight copy edits: list the queued (not yet reserved) actions of one node,
-- and overwrite the pre-rendered text of a single queued action. Manager only.
-- -----------------------------------------------------------------------------
create or replace function outreach_agent_node_queued_actions(p_sequence uuid, p_node_id text)
returns table(action_id uuid, lead_id uuid, sender_id uuid, payload jsonb, scheduled_for timestamptz)
language plpgsql stable security definer set search_path = public, extensions as $$
declare ws uuid;
begin
  select workspace_id into ws from outreach_sequences where id = p_sequence;
  if ws is null then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(ws, 'manager');
  return query
    select a.id, a.lead_id, a.sender_id, a.payload, a.scheduled_for
      from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id
     where e.sequence_id = p_sequence and a.node_id = p_node_id and a.status = 'queued'
     order by a.scheduled_for
     limit 2000;
end $$;

create or replace function outreach_agent_set_action_text(p_action uuid, p_text text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare a outreach_actions%rowtype;
begin
  select * into a from outreach_actions where id = p_action for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(a.workspace_id, 'manager');
  if a.status <> 'queued' then return false; end if;   -- reserved / sent: left alone
  update outreach_actions set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('text', p_text) where id = p_action;
  return true;
end $$;

-- -----------------------------------------------------------------------------
-- In-flight timing edits: recompute wait_until for enrollments sitting in a
-- delay node whose config changed. Enrollments whose new delay already elapsed
-- become due now; outreach_release_waits() picks them up on the next tick and
-- the ledger/schedule still gate the actual sends.
-- -----------------------------------------------------------------------------
create or replace function outreach_agent_reschedule_delay(p_sequence uuid, p_node_id text)
returns table(rescheduled int, due_now int)
language plpgsql security definer set search_path = public, extensions as $$
declare s outreach_sequences%rowtype; n jsonb; amt numeric; unit text; iv interval; r record;
begin
  rescheduled := 0; due_now := 0;
  select * into s from outreach_sequences where id = p_sequence;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  perform outreach_require(s.workspace_id, 'manager');
  n := s.graph->'nodes'->p_node_id;
  if n is null or (n->>'type') <> 'delay' then raise exception 'E_PAYLOAD_INVALID: node is not a delay node'; end if;
  amt := coalesce((n->'config'->>'amount')::numeric, 1);
  unit := coalesce(n->'config'->>'unit', 'days');
  iv := case unit when 'minutes' then make_interval(mins => amt::int) when 'hours' then make_interval(hours => amt::int) else make_interval(days => amt::int) end;
  for r in select id, node_entered_at from outreach_enrollments where sequence_id = p_sequence and status = 'waiting_delay' and current_node_id = p_node_id loop
    update outreach_enrollments set wait_until = r.node_entered_at + iv, updated_at = now() where id = r.id;
    rescheduled := rescheduled + 1;
    if r.node_entered_at + iv <= now() then due_now := due_now + 1; end if;
  end loop;
  perform outreach_audit(s.workspace_id, 'sequence.timing_edited', 'sequence', p_sequence::text, jsonb_build_object('node_id', p_node_id, 'rescheduled', rescheduled, 'due_now', due_now), 'agent');
  return next;
end $$;

-- signed-in users only (outreach_require enforces manager inside); never anon/public
revoke execute on function outreach_agent_node_queued_actions(uuid, text) from public, anon;
revoke execute on function outreach_agent_set_action_text(uuid, text) from public, anon;
revoke execute on function outreach_agent_reschedule_delay(uuid, text) from public, anon;
grant execute on function outreach_agent_node_queued_actions(uuid, text) to authenticated, service_role;
grant execute on function outreach_agent_set_action_text(uuid, text) to authenticated, service_role;
grant execute on function outreach_agent_reschedule_delay(uuid, text) to authenticated, service_role;
