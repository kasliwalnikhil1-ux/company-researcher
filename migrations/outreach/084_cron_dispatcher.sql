-- 084 — Cron dispatcher: one pg_cron job runs the frequent workers, and only when they have work.
--
-- Why: 15 pg_cron jobs (every 10 s … every minute) each called an edge function on every run, work or not: ~45,000
-- invocations and ~250,000 log rows a day (Oct 2026: 539k invocations and 6 GB of logs in the period, both over the
-- free allowance), plus 15 cron connections at once on a 60-connection instance ("job startup timeout" 9,000×/day).
--
-- Now: `outreach-tick` runs `outreach_cron_tick()` every 10 s. The table `outreach_cron_jobs` holds each worker's
-- cadence (`every_s`) and the dispatcher calls `outreach_cron_has_work(name)` — a cheap `exists` over the worker's queue
-- — before `outreach_invoke`. A worker whose guard says "nothing to do" is not called, so an idle platform makes almost
-- no invocations and logs. Guards are supersets of the claim RPCs (a guard may say yes when the claim then finds
-- nothing; it never says no when the claim would find something). A guard that raises fails open: the worker is
-- called and the error is kept on the row. Every real call is written to `outreach_cron_invocations` (7 days) so the
-- Health checks job-1 / job-3 / sys-2 (081, patched) still see these functions.
--
-- Unchanged: the hourly / daily jobs and the 5-minute ones that do their own time-based sweeps (imports, crm-sync,
-- profile-tick, webchat-maintenance, health-collect, sweep, health-run). Kill switch: update outreach_cron_jobs set
-- active = false where name = '…'; or to go back to the old jobs, re-apply 004/016/038/043/047/052/064/070/077.
-- Idempotent. Apply after every function it names is deployed (they already are).

create table if not exists outreach_cron_jobs (
  name            text primary key,                       -- the old pg_cron job name, minus the outreach- prefix
  fn              text not null,                          -- edge function (outreach_invoke's p_name)
  body            jsonb not null default '{}'::jsonb,
  every_s         int  not null check (every_s between 10 and 86400),
  guarded         boolean not null default true,          -- false: called every every_s regardless (time-based sweeps)
  active          boolean not null default true,
  last_run_at     timestamptz,                            -- last time the dispatcher looked at this job
  last_had_work   boolean,
  last_invoked_at timestamptz,
  last_error      text,                                   -- the guard raised (the worker was still called)
  runs            bigint not null default 0,
  invocations     bigint not null default 0,
  note            text
);
revoke all on outreach_cron_jobs from public, anon, authenticated;
grant select, insert, update, delete on outreach_cron_jobs to service_role;

create table if not exists outreach_cron_invocations (
  id bigint generated always as identity primary key,
  name text not null, fn text not null, at timestamptz not null default now(), request_id bigint
);
create index if not exists outreach_cron_invocations_at_idx on outreach_cron_invocations (at);
revoke all on outreach_cron_invocations from public, anon, authenticated;
grant select on outreach_cron_invocations to service_role;

-- The jobs. `every_s` = the schedule the job had before; rows already there keep their operator edits (active, every_s).
insert into outreach_cron_jobs (name, fn, body, every_s, guarded, note) values
  ('inbound',             'outreach-process-inbound',  '{}',                                  10,  true,  'Unipile webhook events waiting in outreach_inbound_events'),
  ('notify-push',         'outreach-notify-push',      '{"mode":"send"}',                     10,  true,  'reply alerts due in outreach_push_queue (also nudged by the trigger)'),
  ('ai-classify',         'outreach-ai-classify',      '{}',                                  15,  true,  'messages in outreach_ai_classify_queue'),
  ('ai-reply-worker',     'outreach-ai-reply-worker',  '{"mode":"draft"}',                    15,  true,  'AI reply runs whose debounce has passed'),
  ('ai-reply-lead-notes', 'outreach-ai-reply-worker',  '{"mode":"lead_notes"}',               30,  true,  'outreach_ai_lead_notes_queue'),
  ('outbound-hooks',      'outreach-outbound-webhooks','{}',                                  30,  true,  'outreach_outbound_webhook_deliveries due'),
  ('tick',                'outreach-worker-tick',      '{}',                                  60,  true,  'due actions, waits to release, AI drafts for review tasks'),
  ('ai-reply-dispatch',   'outreach-ai-reply-worker',  '{"mode":"dispatch"}',                 60,  true,  'scheduled AI replies whose send time has come'),
  ('ai-reply-knowledge',  'outreach-ai-reply-worker',  '{"mode":"knowledge"}',                60,  true,  'knowledge sources to crawl / refresh'),
  ('ai-variables',        'outreach-ai-variables',     '{}',                                  60,  true,  'pending AI values and routing decisions'),
  ('notes-emails',        'outreach-notes-worker',     '{"mode":"emails"}',                   60,  true,  '@mentions past their email delay'),
  ('transcribe',          'outreach-worker-channels',  '{"mode":"transcribe"}',               60,  true,  'voice notes in outreach_transcribe_queue'),
  ('webchat-continuity',  'outreach-webchat-worker',   '{"mode":"continuity"}',               60,  true,  'website chats with unread answers for a visitor who left'),
  ('webchat-review',      'outreach-webchat-worker',   '{"mode":"review"}',                   60,  true,  'website-agent suggestions to write or time out'),
  ('webchat-voice',       'outreach-webchat-worker',   '{"mode":"voice","sweep":false}',      60,  true,  'voice calls to poll, recordings to clean up'),
  ('webchat-voice-sweep', 'outreach-webchat-worker',   '{"mode":"voice","sweep":true}',       300, false, 'time-based voice sweeps (stale calls); was the minute-0/5 run')
on conflict (name) do update set fn = excluded.fn, body = excluded.body, guarded = excluded.guarded, note = excluded.note;

-- Is there anything for this worker to do right now? Mirrors (as a superset) what each worker's claim RPC selects.
create or replace function outreach_cron_has_work(p_name text) returns boolean
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  return case p_name
    when 'inbound' then exists (select 1 from outreach_inbound_events e where e.processed_at is null and e.dead = false and e.attempts < 5)
    when 'notify-push' then exists (select 1 from outreach_push_queue q where q.next_at <= now() and (q.claimed_until is null or q.claimed_until < now()))
    when 'ai-classify' then exists (select 1 from outreach_ai_classify_queue q where q.attempts < 3 and (q.locked_at is null or q.locked_at < now() - interval '5 minutes'))
    when 'ai-reply-worker' then exists (select 1 from outreach_ai_reply_runs x where x.status = 'debouncing'
                                           and least(x.debounce_until, x.debounce_hard_until) <= now() and (x.next_attempt_at is null or x.next_attempt_at <= now()))
    when 'ai-reply-lead-notes' then exists (select 1 from outreach_ai_lead_notes_queue q where q.next_attempt_at <= now() and q.attempts < 3)
    when 'outbound-hooks' then exists (select 1 from outreach_outbound_webhook_deliveries d where d.delivered_at is null and d.next_at <= now() and d.attempts < 5)
    when 'tick' then
         -- due actions on a sender that may act now (the claim adds per-sender gaps and budgets on top)
         exists (select 1 from outreach_actions a join outreach_senders s on s.id = a.sender_id
                  where a.status = 'queued' and a.scheduled_for <= now() and s.status = 'ok' and s.deleted_at is null
                    and (s.paused_until is null or s.paused_until < now())
                    and (a.action_type in ('reply', 'call_api', 'find_email') or outreach_in_schedule(s.id, now())))
         -- waits to release
         or exists (select 1 from outreach_enrollments e where e.status in ('waiting_delay', 'waiting_connection') and e.wait_until <= now())
         or exists (select 1 from outreach_enrollments e where e.status = 'waiting_task' and e.wait_reason = 'enrichment' and e.node_entered_at < now() - interval '72 hours')
         or exists (select 1 from outreach_ai_route_decisions d where d.decided_at is null
                     and (d.requested_at < now() - interval '6 hours' or (d.attempts >= 3 and d.requested_at < now() - interval '10 minutes')))
         -- review tasks still waiting for their AI draft
         or exists (select 1 from outreach_tasks t where t.kind = 'review_ai_draft' and t.completed_at is null and t.ai_draft is null)
    when 'ai-reply-dispatch' then exists (select 1 from outreach_ai_reply_runs x where x.status = 'scheduled' and x.scheduled_send_at <= now())
    when 'ai-reply-knowledge' then exists (select 1 from outreach_knowledge_sources k
                                            where k.status = 'pending'
                                               or (k.status = 'crawling' and k.updated_at < now() - interval '20 minutes')
                                               or (k.status = 'crawling' and k.kind = 'catalogue' and k.catalogue ? 'sync' and k.updated_at < now() - interval '45 seconds')
                                               or (k.status = 'ready' and k.refresh_days is not null and k.crawled_at < now() - make_interval(days => k.refresh_days)))
    when 'ai-variables' then exists (select 1 from outreach_ai_values x where x.status = 'pending' and x.attempts < 3 and (x.locked_at is null or x.locked_at < now() - interval '10 minutes'))
                          or exists (select 1 from outreach_ai_route_decisions d where d.decided_at is null and d.attempts < 3)
    when 'notes-emails' then exists (select 1 from outreach_chat_note_mentions m
                                      left join outreach_notification_prefs p on p.user_id = m.user_id and p.workspace_id = m.workspace_id and p.kind = 'note_mention'
                                     where m.read_at is null and m.emailed_at is null and coalesce(p.email, true)
                                       and m.created_at <= now() - make_interval(mins => coalesce(p.email_delay_min, 10)))
    when 'transcribe' then exists (select 1 from outreach_transcribe_queue q where q.attempts < 3 and (q.locked_at is null or q.locked_at < now() - interval '5 minutes'))
    when 'webchat-continuity' then exists (
           select 1 from outreach_chats c
             join outreach_webchat_visitors v on v.id = c.visitor_id
            where c.provider = 'WEBCHAT' and v.email is not null and not v.email_invalid and not c.continuity_stopped
              and coalesce(c.visitor_last_seen_at, c.created_at) < now() - interval '3 minutes'
              and (c.last_continuity_email_at is null or c.last_continuity_email_at < now() - interval '5 minutes')
              -- a chat whose email just failed (no transport, bounce) waits half an hour instead of every minute
              and not exists (select 1 from outreach_webchat_continuity_emails ce where ce.chat_id = c.id and ce.error is not null and ce.sent_at > now() - interval '30 minutes')
              and exists (select 1 from outreach_messages m where m.chat_id = c.id and m.direction = 'out' and m.sender_type in ('agent', 'bot')
                           and m.read_by_visitor_at is null and m.deleted_at is null and m.content_type in ('text', 'attachment') and m.text is not null
                           and m.created_at > coalesce(c.last_continuity_email_at, '-infinity'::timestamptz) and m.created_at < now() - interval '3 minutes'))
    when 'webchat-review' then exists (select 1 from outreach_webchat_ai_suggestions g where g.away_at is null and g.status <> 'used' and g.created_at > now() - interval '1 day')
    when 'webchat-voice' then exists (select 1 from outreach_webchat_voice_calls k where k.finalized_at is null)
                           or exists (select 1 from outreach_webchat_voice_cleanup q where q.done_at is null and q.next_at <= now() and q.attempts < 8)
    else true   -- unknown name: call the worker (fail open)
  end;
end $$;
revoke execute on function outreach_cron_has_work(text) from public, anon, authenticated;

-- The dispatcher. p_dry: decide but do not call anything and do not touch the rows (tests). Returns one line per job due.
create or replace function outreach_cron_tick(p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare j record; has_work boolean; err text; rid bigint; checked int := 0; invoked int := 0; rows_ jsonb := '[]'::jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('outreach_cron_tick')) then return jsonb_build_object('busy', true); end if;
  for j in select * from outreach_cron_jobs c where c.active and (c.last_run_at is null or c.last_run_at + make_interval(secs => c.every_s) <= now()) order by c.every_s, c.name loop
    checked := checked + 1; err := null; rid := null;
    if j.guarded then
      begin has_work := outreach_cron_has_work(j.name);
      exception when others then has_work := true; err := left(sqlerrm, 300); end;
    else has_work := true; end if;
    if has_work and not p_dry then
      begin rid := outreach_invoke(j.fn, j.body);
      exception when others then err := left(coalesce(err || ' | ', '') || 'invoke: ' || sqlerrm, 300); end;
      insert into outreach_cron_invocations (name, fn, request_id) values (j.name, j.fn, rid);
    end if;
    if has_work then invoked := invoked + 1; end if;
    rows_ := rows_ || jsonb_build_object('name', j.name, 'work', has_work, 'error', err);
    if not p_dry then
      update outreach_cron_jobs set last_run_at = now(), last_had_work = has_work, runs = runs + 1,
             last_invoked_at = case when has_work then now() else last_invoked_at end,
             invocations = invocations + case when has_work then 1 else 0 end,
             last_error = err
       where name = j.name;
    end if;
  end loop;
  -- keep a week of calls (once an hour, in the first tick of the hour)
  if not p_dry and extract(minute from now()) = 0 and extract(second from now()) < 10 then
    delete from outreach_cron_invocations where at < now() - interval '7 days';
  end if;
  return jsonb_build_object('checked', checked, 'invoked', invoked, 'jobs', rows_);
end $$;
revoke execute on function outreach_cron_tick(boolean) from public, anon, authenticated;

-- Health (081) measures functions the cron jobs call: give the dispatched ones their "slow" threshold too (fresh installs).
insert into ops.fn_config (fn, cron_job, slow_ms)
select distinct on (fn) fn, 'outreach-tick/' || name, least(60000, greatest(5000, every_s * 1000)) from outreach_cron_jobs order by fn, every_s
on conflict (fn) do nothing;

-- Swap the schedules: the 15 frequent jobs go, `outreach-tick` becomes the dispatcher.
do $$
declare j text;
begin
  foreach j in array array['outreach-tick', 'outreach-inbound', 'outreach-notify-push', 'outreach-ai-classify', 'outreach-ai-reply-worker',
                           'outreach-ai-reply-lead-notes', 'outreach-outbound-hooks', 'outreach-ai-reply-dispatch', 'outreach-ai-reply-knowledge',
                           'outreach-ai-variables', 'outreach-notes-emails', 'outreach-transcribe', 'outreach-webchat-continuity',
                           'outreach-webchat-review', 'outreach-webchat-voice'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('outreach-tick', '10 seconds', $$select outreach_cron_tick()$$);
