-- 082_health_rpcs.sql — what the Health page reads and writes, stuck users, usage and limits, client events
-- (health-page-PRD.md §3, §7, §8, §10). Requires 081. Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/082_health_rpcs.sql
--
-- Every page RPC is security definer and calls platform_require_admin() first (D1, acceptance test 8). Writes go to
-- outreach_audit_log (workspace null, actor_type 'user', action 'health.*').

-- -----------------------------------------------------------------------------------------------------------------
-- Stuck users (§8.1): ten signals per workspace, today
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.stuck_signals() returns table (workspace_id uuid, code text, since timestamptz, route text, detail jsonb)
language sql stable set search_path = public, ops, extensions as $$
  -- S1 signed up over 24 h ago, no sender connected
  select w.id, 'S1', w.created_at, '/outreach/senders', jsonb_build_object('hours', round(extract(epoch from now() - w.created_at) / 3600))
  from outreach_workspaces w
  where w.created_at < now() - interval '24 hours' and w.created_at > now() - interval '60 days'
    and not exists (select 1 from outreach_senders s where s.workspace_id = w.id and s.deleted_at is null)
  union all
  -- S2 started connecting a sender twice or more in 7 days and never finished
  select s.workspace_id, 'S2', max(s.created_at), '/outreach/senders', jsonb_build_object('attempts', count(*))
  from outreach_senders s
  where s.status = 'connecting' and s.deleted_at is null and s.created_at > now() - interval '7 days'
  group by s.workspace_id
  having count(*) >= 2 and not exists (select 1 from outreach_senders o where o.workspace_id = s.workspace_id and o.status = 'ok' and o.deleted_at is null)
  union all
  -- S3 sequence created, not started after 48 h (and the workspace never started one)
  select q.workspace_id, 'S3', min(q.created_at), '/outreach/sequences', jsonb_build_object('drafts', count(*))
  from outreach_sequences q
  where q.status = 'draft' and q.archived_at is null and q.created_at < now() - interval '48 hours' and q.created_at > now() - interval '30 days'
  group by q.workspace_id
  having not exists (select 1 from outreach_sequences a where a.workspace_id = q.workspace_id and a.status in ('active', 'paused'))
  union all
  -- S4 sequence started, nothing sent after 24 h
  select q.workspace_id, 'S4', q.updated_at, '/outreach/sequences/' || q.id::text, jsonb_build_object('sequence', q.name, 'sequence_id', q.id)
  from outreach_sequences q
  where q.status = 'active' and q.archived_at is null and q.updated_at < now() - interval '24 hours'
    and exists (select 1 from outreach_enrollments e where e.sequence_id = q.id)
    and not exists (select 1 from outreach_actions a join outreach_enrollments e on e.id = a.enrollment_id where e.sequence_id = q.id and a.status = 'sent' and a.executed_at > now() - interval '24 hours')
  union all
  -- S5 opened "Why isn't it sending" three times or more today
  select e.workspace_id, 'S5', max(e.at), coalesce(max(e.route), '/outreach/sequences'), jsonb_build_object('times', count(*))
  from ops.product_events e where e.name = 'why_not_sending_opened' and e.at >= current_date group by e.workspace_id having count(*) >= 3
  union all
  -- S6 the same error three times or more today
  select c.workspace_id, 'S6', max(c.at), max(c.route), jsonb_build_object('times', count(*), 'error', left(max(c.message), 120))
  from ops.client_errors c where c.at >= current_date and c.workspace_id is not null group by c.workspace_id, c.fingerprint having count(*) >= 3
  union all
  -- S7 the same form rejected three times or more today
  select e.workspace_id, 'S7', max(e.at), max(e.route), jsonb_build_object('times', count(*), 'form', e.detail->>'form', 'fields', (array_agg(e.detail->'fields'))[1])
  from ops.product_events e where e.name = 'form_rejected' and e.at >= current_date and e.workspace_id is not null group by e.workspace_id, e.detail->>'form' having count(*) >= 3
  union all
  -- S8 an import failed, or brought in no leads, in the last 7 days
  select j.workspace_id, 'S8', max(coalesce(j.finished_at, j.created_at)), '/outreach/leads', jsonb_build_object('imports', count(*), 'failed', count(*) filter (where j.status = 'failed'))
  from outreach_import_jobs j
  where j.created_at > now() - interval '7 days' and (j.status = 'failed' or (j.status = 'done' and j.created_leads = 0 and j.updated_leads = 0))
  group by j.workspace_id
  union all
  -- S9 sender disconnected over 24 h, no reconnect attempt
  select s.workspace_id, 'S9', min(coalesce(s.disconnected_at, s.updated_at)), '/outreach/senders', jsonb_build_object('senders', count(*))
  from outreach_senders s
  where s.deleted_at is null and s.status in ('credentials', 'error', 'disconnected') and coalesce(s.disconnected_at, s.updated_at) < now() - interval '24 hours'
    and (s.last_reconnect_at is null or s.last_reconnect_at < coalesce(s.disconnected_at, s.updated_at))
  group by s.workspace_id
  union all
  -- S10 clicked the same control four times or more within two seconds (the app sends one rage_click event per burst)
  select e.workspace_id, 'S10', max(e.at), max(e.route), jsonb_build_object('bursts', count(*), 'control', max(e.detail->>'control'))
  from ops.product_events e where e.name = 'rage_click' and e.at >= current_date and e.workspace_id is not null group by e.workspace_id
$$;

-- One row per stuck workspace, sorted by how many signals it shows (§8.2 "Who is stuck").
create or replace function ops.stuck_users() returns table (workspace_id uuid, name text, signal_count int, signals jsonb, since timestamptz, route text)
language sql stable set search_path = public, ops, extensions as $$
  select s.workspace_id, w.name, count(*)::int, jsonb_agg(jsonb_build_object('code', s.code, 'since', s.since, 'route', s.route, 'detail', s.detail) order by s.code),
         min(s.since), (array_agg(s.route order by s.since))[1]
  from ops.stuck_signals() s join outreach_workspaces w on w.id = s.workspace_id
  group by s.workspace_id, w.name
  order by 3 desc, 5
$$;

-- Screens ranked by stuck signals over the last 7 days (§8.2 "Where people get stuck"). Event-based signals keep 7 days of history; state-based ones count as today.
create or replace function ops.stuck_routes() returns table (route text, signals int, workspaces int, codes jsonb)
language sql stable set search_path = public, ops, extensions as $$
  with ev as (
    select coalesce(e.route, '?') route, e.workspace_id, case e.name when 'why_not_sending_opened' then 'S5' when 'form_rejected' then 'S7' when 'rage_click' then 'S10' end code
    from ops.product_events e where e.at > now() - interval '7 days' and e.name in ('why_not_sending_opened', 'form_rejected', 'rage_click')
    union all
    select coalesce(c.route, '?'), c.workspace_id, 'S6' from ops.client_errors c where c.at > now() - interval '7 days'
    union all
    select regexp_replace(s.route, '/[0-9a-f-]{36}$', ''), s.workspace_id, s.code from ops.stuck_signals() s where s.code in ('S1', 'S2', 'S3', 'S4', 'S8', 'S9')
  )
  select route, count(*)::int, count(distinct workspace_id)::int,
         (select jsonb_object_agg(code, c) from (select code, count(*) c from ev x where x.route = ev.route group by code) z)
  from ev group by route order by 2 desc limit 20
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- Usage and limits (§7.1, §7.2)
-- -----------------------------------------------------------------------------------------------------------------
-- Bytes per day over the last 7 days of table sizes (the 20 biggest tables), or null without history.
create or replace function ops.disk_rate_per_day() returns numeric language sql stable as $$
  select (sum(b.bytes) - sum(a.bytes)) / 7.0
  from ops.size_snapshots b join ops.size_snapshots a on a.schema_name = b.schema_name and a.table_name = b.table_name and a.day = b.day - 7
  where b.day = current_date
$$;

create or replace function ops.usage_rows() returns jsonb
language plpgsql stable set search_path = public, ops, extensions as $$
declare cfg ops.health_settings%rowtype; out jsonb := '[]'::jsonb; r record; used numeric; rate numeric; reached date; how text; link text; month_days numeric; day_of numeric;
begin
  select * into cfg from ops.health_settings where id;
  month_days := extract(day from (date_trunc('month', now()) + interval '1 month - 1 day'));
  day_of := extract(day from now());
  for r in select * from ops.limits l where l.plan in (cfg.supabase_plan, 'any') and l.grp in ('supabase', 'functions', 'cron', 'linkedin') order by l.sort_order, l.key loop
    used := null; rate := null; reached := null; how := r.measured_by; link := r.source_url;
    case r.key
      when 'db_disk' then
        used := pg_database_size(current_database()); rate := ops.disk_rate_per_day();
        how := 'pg_database_size, with the 7-day growth of the 20 biggest tables';
      when 'fn_invocations' then
        select coalesce(sum(runs), 0) into used from ops.fn_stats where bucket >= date_trunc('month', now());
        rate := case when day_of > 0 then used / day_of end;
        how := 'ops.fn_stats this month (runs that reached the wrapper)';
      when 'storage' then
        select coalesce(sum((metadata->>'size')::numeric), 0) into used from storage.objects;
        how := 'storage.objects metadata size';
      when 'mau' then
        select count(*) into used from auth.users where last_sign_in_at > now() - interval '30 days';
        how := 'auth.users signed in within 30 days';
      when 'fn_count' then
        select count(distinct fn) into used from ops.fn_stats where bucket > now() - interval '30 days';
        how := 'functions seen by the wrapper in 30 days';
      when 'cron_concurrent' then
        -- from the job-4 check (a scan of cron.job_run_details here cost seconds on a small compute size)
        select s.value into used from ops.health_state s where s.check_key = 'job-4';
        how := 'jobs running at the last check (job-4)';
      when 'cron_run_minutes' then
        select round(coalesce((s.evidence->>'longest_s')::numeric, 0) / 60, 1) into used from ops.health_state s where s.check_key = 'job-4';
        how := 'longest running job at the last check (job-4)';
      when 'egress', 'realtime_peak', 'realtime_messages' then
        used := r.used_manual; how := 'By hand: Supabase → Usage (G15)'; link := 'https://supabase.com/dashboard/org/{org}/usage';
      when 'li_invites_day', 'li_views_day', 'li_messages_day' then
        select coalesce(max(b.used + b.reserved), 0) into used from outreach_sender_budgets b
        where b.day = current_date and b.action_type = case r.key when 'li_invites_day' then 'invite' when 'li_views_day' then 'profile_view' else 'message' end::outreach_action_type_t;
        how := 'busiest sender today (outreach_sender_budgets)';
      else null;
    end case;
    if r.limit_value is not null and used is not null and rate is not null and rate > 0 and used < r.limit_value then
      reached := case when r.key = 'fn_invocations' then (date_trunc('month', now()) + make_interval(days => least(400, ceil(r.limit_value / rate))::int))::date
                      else (current_date + least(3650, ceil((r.limit_value - used) / rate))::int) end;
    end if;
    out := out || jsonb_build_object('key', r.key, 'grp', r.grp, 'label', r.label, 'limit', r.limit_value, 'unit', r.unit, 'plan', r.plan, 'note', r.note,
      'used', used, 'pct', case when r.limit_value is null or r.limit_value = 0 or used is null then null else round(100.0 * used / r.limit_value, 1) end,
      'reached_on', reached, 'month_estimate', case when r.key = 'fn_invocations' and rate is not null then round(rate * month_days) end,
      'measured_by', how, 'manual', r.measured_by = 'manual', 'used_manual_at', r.used_manual_at, 'source_url', link, 'checked_on', r.checked_on);
  end loop;
  return out;
end $$;

-- Customers near their own limits, and workspaces whose AI has stopped (§7.2).
create or replace function ops.customers_near_limits() returns jsonb
language plpgsql stable set search_path = public, ops, extensions as $$
declare out jsonb := '[]'::jsonb; r record; pool jsonb; vpool jsonb; slots jsonb; senders int; seats int; lim_s int; lim_m int; flags text[]; key_bad boolean;
begin
  for r in select w.id, w.name, w.plan from outreach_workspaces w where w.deleted_at is null order by w.name loop
    flags := '{}'; lim_s := null; lim_m := null;
    -- sender slots from billing (outreach__slots: billed = the plan's accounts, used = connected senders); seats from the plan feature when one exists
    begin slots := outreach__slots(r.id); exception when others then slots := null; end;
    senders := coalesce((slots->>'used')::int, (select count(*) from outreach_senders s where s.workspace_id = r.id and s.deleted_at is null and s.status <> 'disabled'));
    lim_s := (slots->>'billed')::int;
    select count(*) into seats from outreach_members m where m.workspace_id = r.id;
    begin lim_m := outreach_plan_limit(r.id, 'members'); exception when others then lim_m := null; end;
    if lim_s is not null and lim_s > 0 and senders >= 0.8 * lim_s then flags := flags || format('senders %s of %s', senders, lim_s); end if;
    if lim_m is not null and lim_m > 0 and seats >= 0.8 * lim_m then flags := flags || format('seats %s of %s', seats, lim_m); end if;
    begin pool := outreach__ai_pool(r.id); exception when others then pool := null; end;
    if pool is not null and (pool->>'limit') is not null and (pool->>'limit')::numeric > 0 and (pool->>'used')::numeric >= 0.8 * (pool->>'limit')::numeric then
      flags := flags || format('AI allowance %s of %s', pool->>'used', pool->>'limit');
    end if;
    begin vpool := outreach__voice_pool(r.id); exception when others then vpool := null; end;
    if vpool is not null and (vpool->>'limit') is not null and (vpool->>'limit')::numeric > 0 and coalesce((vpool->>'used')::numeric, 0) >= 0.8 * (vpool->>'limit')::numeric then
      flags := flags || format('voice minutes %s of %s', vpool->>'used', vpool->>'limit');
    end if;
    -- AI has stopped: allowance used up, voice minutes used up, or their own key rejected (E_AI_KEY_INVALID in the last day)
    key_bad := exists (select 1 from outreach_ai_calls c where c.workspace_id = r.id and c.own_key and c.outcome = 'provider_error' and c.http_status in (400, 401, 403) and c.at > now() - interval '24 hours');
    if (pool is not null and (pool->>'ok')::boolean = false) then flags := flags || 'AI stopped: allowance used up'; end if;
    if (vpool is not null and (vpool->>'ok')::boolean = false) then flags := flags || 'voice stopped: minutes used up'; end if;
    if key_bad then flags := flags || 'AI stopped: their own key is rejected'; end if;
    if array_length(flags, 1) > 0 then
      out := out || jsonb_build_object('workspace_id', r.id, 'workspace', r.name, 'plan', r.plan, 'flags', to_jsonb(flags), 'ai_stopped', (pool is not null and (pool->>'ok')::boolean = false) or key_bad);
    end if;
  end loop;
  return out;
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- What the page reads (§3)
-- -----------------------------------------------------------------------------------------------------------------
-- 7-day line: one point per bucket (hours) from health_results.
create or replace function ops.spark(p_key text, p_bucket_hours int default 6) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('t', b, 'v', v, 's', s) order by b), '[]'::jsonb)
  from (
    select to_timestamp(floor(extract(epoch from at) / (p_bucket_hours * 3600)) * p_bucket_hours * 3600) b, round(avg(value)::numeric, 2) v,
           (array_agg(status order by ops.status_rank(status) desc))[1] s
    from ops.health_results where check_key = p_key and at > now() - interval '7 days' group by 1
  ) x
$$;

create or replace function ops.check_json(c ops.health_checks, s ops.health_state, p_full boolean) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'key', c.key, 'area', c.area, 'name', c.name, 'question', c.question, 'unit', c.unit, 'watch_at', c.watch_at, 'act_at', c.act_at,
    'immediate', c.immediate, 'urgent', c.urgent, 'guide', c.guide, 'source', c.source, 'every_minutes', c.every_minutes, 'enabled', c.enabled,
    'snoozed_until', case when c.snoozed_until > now() then c.snoozed_until end, 'snooze_reason', case when c.snoozed_until > now() then c.snooze_reason end,
    'status', coalesce(s.status, 'unknown'), 'since', s.since, 'value', s.value, 'summary', coalesce(s.summary, 'Not checked yet.'), 'error', s.error,
    'pending', s.pending, 'last_run_at', s.last_run_at, 'alerted_at', s.alerted_at,
    'evidence', case when p_full then s.evidence else null end,
    'spark', case when p_full then ops.spark(c.key, 1) else ops.spark(c.key, 6) end)
$$;

create or replace function outreach_health_overview() returns jsonb
language plpgsql stable security definer set search_path = public, ops, extensions as $$
declare last_run timestamptz; checks jsonb; counts jsonb; verdict text; cfg ops.health_settings%rowtype;
begin
  perform platform_require_admin();
  select * into cfg from ops.health_settings where id;
  select at into last_run from ops.health_kv where key = 'health_run';
  select coalesce(jsonb_agg(ops.check_json(c, s, false) order by c.sort_order, c.key), '[]'::jsonb) into checks
  from ops.health_checks c left join ops.health_state s on s.check_key = c.key;
  select jsonb_build_object(
    'act', count(*) filter (where s.status = 'act'), 'watch', count(*) filter (where s.status = 'watch'), 'ok', count(*) filter (where s.status = 'ok'),
    'unknown', count(*) filter (where s.status is null or s.status = 'unknown'), 'snoozed', (select count(*) from ops.health_checks x where x.enabled and x.snoozed_until > now()),
    'off', (select count(*) from ops.health_checks x where not x.enabled), 'total', count(*)) into counts
  from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now());
  select coalesce((select s.status from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) order by ops.status_rank(s.status) desc limit 1), 'unknown') into verdict;
  return jsonb_build_object(
    'last_run_at', last_run, 'stale', last_run is null or last_run < now() - interval '15 minutes',
    'run', (select value from ops.health_kv where key = 'health_run'),
    'verdict', verdict, 'counts', counts, 'checks', checks,
    'upgrade', (select value from ops.health_kv where key = 'upgrade'),
    'daily', (select value from ops.health_kv where key = 'daily'),
    'collect', (select jsonb_build_object('at', at, 'value', value) from ops.health_kv where key = 'collect'),
    'settings', to_jsonb(cfg) - 'id');
end $$;

create or replace function outreach_health_check(p_key text) returns jsonb
language plpgsql stable security definer set search_path = public, ops, extensions as $$
declare c ops.health_checks%rowtype; s ops.health_state%rowtype;
begin
  perform platform_require_admin();
  select * into c from ops.health_checks where key = p_key;
  if not found then raise exception 'E_NOT_FOUND: no such check'; end if;
  select * into s from ops.health_state where check_key = p_key;
  return ops.check_json(c, s, true) || jsonb_build_object(
    'recent', (select coalesce(jsonb_agg(jsonb_build_object('at', at, 'value', value, 'status', status) order by at desc), '[]'::jsonb) from (select * from ops.health_results where check_key = p_key order by at desc limit 24) z));
end $$;

create or replace function outreach_health_usage() returns jsonb
language plpgsql stable security definer set search_path = public, ops, extensions as $$
declare cfg ops.health_settings%rowtype;
begin
  perform platform_require_admin();
  select * into cfg from ops.health_settings where id;
  return jsonb_build_object(
    'plan', cfg.supabase_plan, 'compute_size', cfg.compute_size,
    'rows', ops.usage_rows(),
    'compute', (select coalesce(jsonb_agg(jsonb_build_object('key', key, 'label', label, 'connections', limit_value, 'note', note) order by sort_order), '[]'::jsonb) from ops.limits where grp = 'compute'),
    'connections', jsonb_build_object('max', current_setting('max_connections')::int, 'in_use', (select count(*) from pg_stat_activity where backend_type = 'client backend')),
    'customers', ops.customers_near_limits(),
    'upgrade', (select value from ops.health_kv where key = 'upgrade'),
    'manual_age_days', (select round(extract(epoch from now() - min(used_manual_at)) / 86400) from ops.limits where measured_by = 'manual' and plan in (cfg.supabase_plan, 'any')),
    'recheck_due', (select min(checked_on) < current_date - 30 from ops.limits));
end $$;

create or replace function outreach_health_stuck() returns jsonb
language plpgsql stable security definer set search_path = public, ops, extensions as $$
begin
  perform platform_require_admin();
  return jsonb_build_object(
    'who', (select coalesce(jsonb_agg(to_jsonb(u)), '[]'::jsonb) from ops.stuck_users() u),
    'where', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) from ops.stuck_routes() r));
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- What the page writes (each to outreach_audit_log)
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.audit(p_action text, p_entity text, p_diff jsonb) returns void language sql as $$
  insert into outreach_audit_log (workspace_id, actor, actor_type, action, entity, entity_id, diff) values (null, auth.uid(), 'user', p_action, 'health', p_entity, p_diff)
$$;

create or replace function outreach_health_snooze(p_key text, p_until timestamptz, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
begin
  perform platform_require_admin();
  if p_until is not null and p_until > now() + interval '31 days' then raise exception 'E_PAYLOAD_INVALID: snooze for 30 days at most'; end if;
  if p_until is not null and coalesce(btrim(p_reason), '') = '' then raise exception 'E_PAYLOAD_INVALID: say why'; end if;
  update ops.health_checks set snoozed_until = p_until, snooze_reason = case when p_until is null then null else left(p_reason, 300) end where key = p_key;
  if not found then raise exception 'E_NOT_FOUND: no such check'; end if;
  perform ops.audit('health.snooze', p_key, jsonb_build_object('until', p_until, 'reason', left(p_reason, 300)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function outreach_health_set_threshold(p_key text, p_watch_at numeric, p_act_at numeric) returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
declare old ops.health_checks%rowtype;
begin
  perform platform_require_admin();
  select * into old from ops.health_checks where key = p_key;
  if not found then raise exception 'E_NOT_FOUND: no such check'; end if;
  if p_watch_at is not null and p_act_at is not null and p_act_at < p_watch_at then raise exception 'E_PAYLOAD_INVALID: the act line must be at or past the watch line'; end if;
  update ops.health_checks set watch_at = p_watch_at, act_at = p_act_at where key = p_key;
  perform ops.audit('health.threshold', p_key, jsonb_build_object('from', jsonb_build_object('watch_at', old.watch_at, 'act_at', old.act_at), 'to', jsonb_build_object('watch_at', p_watch_at, 'act_at', p_act_at)));
  return jsonb_build_object('ok', true);
end $$;

create or replace function outreach_health_set_enabled(p_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
begin
  perform platform_require_admin();
  update ops.health_checks set enabled = coalesce(p_enabled, true) where key = p_key;
  if not found then raise exception 'E_NOT_FOUND: no such check'; end if;
  perform ops.audit('health.enabled', p_key, jsonb_build_object('enabled', p_enabled));
  return jsonb_build_object('ok', true);
end $$;

create or replace function outreach_health_settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
declare cfg ops.health_settings%rowtype; emails text[];
begin
  perform platform_require_admin();
  select * into cfg from ops.health_settings where id;
  if p ? 'email_to' then
    select coalesce(array_agg(distinct lower(btrim(x))), '{}') into emails from jsonb_array_elements_text(p->'email_to') x where btrim(x) ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$';
  end if;
  update ops.health_settings set
    supabase_plan = coalesce(nullif(p->>'supabase_plan', ''), cfg.supabase_plan),
    compute_size = coalesce(nullif(lower(p->>'compute_size'), ''), cfg.compute_size),
    email_to = case when p ? 'email_to' then emails else cfg.email_to end,
    email_hour = coalesce((p->>'email_hour')::int, cfg.email_hour),
    time_zone = coalesce(nullif(p->>'time_zone', ''), cfg.time_zone),
    urgent_email = coalesce((p->>'urgent_email')::boolean, cfg.urgent_email),
    ai_monthly_budget_usd = case when p ? 'ai_monthly_budget_usd' then nullif(p->>'ai_monthly_budget_usd', '')::numeric else cfg.ai_monthly_budget_usd end,
    ai_price_in_per_m = coalesce((p->>'ai_price_in_per_m')::numeric, cfg.ai_price_in_per_m),
    ai_price_out_per_m = coalesce((p->>'ai_price_out_per_m')::numeric, cfg.ai_price_out_per_m),
    has_paying_customers = coalesce((p->>'has_paying_customers')::boolean, cfg.has_paying_customers),
    updated_at = now()
  where id;
  perform ops.audit('health.settings', 'settings', p - 'email_to' || jsonb_build_object('email_to_count', coalesce(array_length(emails, 1), array_length(cfg.email_to, 1), 0)));
  return (select to_jsonb(s) - 'id' from ops.health_settings s where id);
end $$;

create or replace function outreach_health_set_manual_usage(p_key text, p_value numeric) returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
declare cfg ops.health_settings%rowtype;
begin
  perform platform_require_admin();
  select * into cfg from ops.health_settings where id;
  update ops.limits set used_manual = p_value, used_manual_at = now() where key = p_key and measured_by = 'manual' and plan in (cfg.supabase_plan, 'any');
  if not found then raise exception 'E_NOT_FOUND: not a by-hand limit'; end if;
  perform ops.audit('health.manual_usage', p_key, jsonb_build_object('value', p_value));
  return jsonb_build_object('ok', true);
end $$;

create or replace function outreach_health_recheck_limits() returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
begin
  perform platform_require_admin();
  update ops.limits set checked_on = current_date;
  perform ops.audit('health.limits_rechecked', 'limits', '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $$;

-- "Check now": runs the database checks at once and asks health-collect to run too.
create or replace function outreach_health_run_now() returns jsonb
language plpgsql security definer set search_path = public, ops, extensions as $$
declare r jsonb;
begin
  perform platform_require_admin();
  r := ops.health_run();
  begin perform outreach_invoke('outreach-health-collect', '{"mode":"now"}'::jsonb); exception when others then r := r || jsonb_build_object('collect_error', sqlerrm); end;
  perform ops.audit('health.run_now', 'run', r);
  return r;
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- From the web app (§8.3): errors and a fixed list of events, 30 a minute per person
-- -----------------------------------------------------------------------------------------------------------------
create or replace function outreach_report_client_event(p_kind text, p_name text, p_route text, p_detail jsonb default '{}') returns void
language plpgsql security definer set search_path = public, ops, extensions as $$
declare uid uuid := auth.uid(); ws uuid; d jsonb := coalesce(p_detail, '{}'::jsonb);
begin
  if uid is null then raise exception 'E_UNAUTHORIZED'; end if;
  if not outreach_rate_limit('client_event:' || uid::text, 30, 60) then return; end if;   -- over the limit: dropped, never an error for the person
  ws := nullif(d->>'workspace_id', '')::uuid;
  if ws is not null and not exists (select 1 from outreach_members m where m.workspace_id = ws and m.user_id = uid) then ws := null; end if;
  if p_kind = 'error' then
    insert into ops.client_errors (user_id, workspace_id, route, fingerprint, message, app_version)
    values (uid, ws, left(p_route, 200), left(coalesce(d->>'fingerprint', md5(coalesce(d->>'message', ''))), 64), ops.scrub(d->>'message'), left(d->>'app_version', 40));
  elsif p_kind = 'event' then
    if p_name not in ('why_not_sending_opened', 'form_rejected', 'rage_click', 'help_opened', 'onboarding_step') then raise exception 'E_PAYLOAD_INVALID: unknown event'; end if;
    -- only what the fixed list allows is stored: never field values (D7)
    insert into ops.product_events (user_id, workspace_id, name, route, detail)
    values (uid, ws, p_name, left(p_route, 200), jsonb_strip_nulls(jsonb_build_object(
      'form', left(d->>'form', 60), 'fields', case when jsonb_typeof(d->'fields') = 'array' then (select jsonb_agg(left(x, 60)) from jsonb_array_elements_text(d->'fields') x limit 20) end,
      'control', left(d->>'control', 80), 'step', left(d->>'step', 60), 'count', (d->>'count')::int)));
  else
    raise exception 'E_PAYLOAD_INVALID: kind';
  end if;
end $$;

-- grants: the page RPCs are for signed-in users (the admin check is inside); nothing else in ops is reachable
do $$ declare f text; begin
  for f in select unnest(array[
    'outreach_health_overview()', 'outreach_health_check(text)', 'outreach_health_usage()', 'outreach_health_stuck()',
    'outreach_health_snooze(text,timestamptz,text)', 'outreach_health_set_threshold(text,numeric,numeric)', 'outreach_health_set_enabled(text,boolean)',
    'outreach_health_settings_set(jsonb)', 'outreach_health_set_manual_usage(text,numeric)', 'outreach_health_recheck_limits()', 'outreach_health_run_now()',
    'outreach_report_client_event(text,text,text,jsonb)']) loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- For the collectors (service role only): kv, settings, the urgent-email queue, the daily payload (F48 / F49)
-- -----------------------------------------------------------------------------------------------------------------
create or replace function outreach_ops_kv_get(p_key text) returns jsonb
language sql stable security definer set search_path = ops, public, extensions as $$
  select case when outreach_is_service() then (select value from ops.health_kv where key = p_key) else null end
$$;
create or replace function outreach_ops_kv_set(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = ops, public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  insert into ops.health_kv (key, value, at) values (p_key, coalesce(p_value, 'null'::jsonb), now()) on conflict (key) do update set value = excluded.value, at = excluded.at;
end $$;
create or replace function outreach_ops_settings() returns jsonb
language sql stable security definer set search_path = ops, public, extensions as $$
  select case when outreach_is_service() then (select to_jsonb(s) - 'id' || jsonb_build_object('disk_iops', (select limit_value from ops.limits where key = 'disk_iops' limit 1),
    'mem_watch', (select watch_at from ops.health_checks where key = 'db-7'), 'mem_act', (select act_at from ops.health_checks where key = 'db-7')) from ops.health_settings s where id) else null end
$$;
create or replace function outreach_ops_state(p_key text) returns jsonb
language sql stable security definer set search_path = ops, public, extensions as $$
  select case when outreach_is_service() then (select to_jsonb(s) from ops.health_state s where check_key = p_key) else null end
$$;

-- What the urgent email should carry right now (PRD 9.2): red immediate / urgent checks not yet emailed (or emailed over
-- 4 h ago), checks that recovered since the last email, and the AI-outage detail (failed replies and fallback lines by workspace).
create or replace function outreach_ops_alerts() returns jsonb
language plpgsql stable security definer set search_path = ops, public, extensions as $$
declare cfg ops.health_settings%rowtype; due jsonb; rec jsonb; ai jsonb; last_run timestamptz;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into cfg from ops.health_settings where id;
  select at into last_run from ops.health_kv where key = 'health_run';
  select coalesce(jsonb_agg(ops.check_json(c, s, true) order by c.sort_order), '[]'::jsonb) into due
  from ops.health_checks c join ops.health_state s on s.check_key = c.key
  where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) and s.status = 'act' and (c.immediate or c.urgent)
    and (s.alerted_status is distinct from 'act' or s.alerted_at < now() - interval '4 hours');
  select coalesce(jsonb_agg(ops.check_json(c, s, false) order by c.sort_order), '[]'::jsonb) into rec
  from ops.health_checks c join ops.health_state s on s.check_key = c.key
  where s.alerted_status = 'act' and s.status = 'ok';
  select jsonb_build_object(
    'failed_replies', coalesce((select jsonb_agg(jsonb_build_object('workspace', w.name, 'count', c) order by c desc) from (select r.workspace_id, count(*) c from outreach_ai_reply_runs r where r.status = 'failed' and r.updated_at > now() - interval '1 hour' group by 1 order by 2 desc limit 10) z left join outreach_workspaces w on w.id = z.workspace_id), '[]'::jsonb),
    'fallback_lines', coalesce((select jsonb_agg(jsonb_build_object('workspace', w.name, 'count', c) order by c desc) from (select v.workspace_id, count(*) c from outreach_ai_values v where v.status in ('failed', 'blank') and v.updated_at > now() - interval '1 hour' and v.error is not null group by 1 order by 2 desc limit 10) z left join outreach_workspaces w on w.id = z.workspace_id), '[]'::jsonb)) into ai;
  return jsonb_build_object('enabled', cfg.urgent_email, 'to', to_jsonb(cfg.email_to), 'time_zone', cfg.time_zone, 'due', due, 'recovered', rec, 'ai_outage', ai,
    'stale', last_run is null or last_run < now() - interval '15 minutes', 'last_run_at', last_run,
    'sys1_alerted_at', (select (value->>'at')::timestamptz from ops.health_kv where key = 'sys1_alert'));
end $$;

create or replace function outreach_ops_alerts_mark(p_keys text[], p_status text) returns void
language plpgsql security definer set search_path = ops, public, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  update ops.health_state set alerted_at = now(), alerted_status = p_status where check_key = any(p_keys);
end $$;

-- Yesterday against the 7-day average: the YESTERDAY table of the daily email (9.1)
create or replace function ops.daily_figures() returns jsonb
language sql stable set search_path = public, ops, extensions as $$
  with d as (select current_date - 1 y0, current_date - 8 y7),
  sent as (select count(*) filter (where executed_at::date = (select y0 from d)) y, round(count(*) / 7.0) a from outreach_actions where status = 'sent' and executed_at >= (select y7 from d) and executed_at < current_date),
  failed as (select round(100.0 * count(*) filter (where status = 'failed' and executed_at::date = (select y0 from d)) / greatest(1, count(*) filter (where executed_at::date = (select y0 from d))), 1) y,
                    round(100.0 * count(*) filter (where status = 'failed') / greatest(1, count(*)), 1) a from outreach_actions where status in ('sent', 'failed') and executed_at >= (select y7 from d) and executed_at < current_date),
  replies as (select count(*) filter (where sent_at::date = (select y0 from d)) y, round(count(*) / 7.0) a from outreach_messages where direction = 'in' and sent_at >= (select y7 from d) and sent_at < current_date),
  fn as (select sum(runs) filter (where bucket::date = (select y0 from d)) y, round(sum(runs) / 7.0) a, sum(failed) filter (where bucket::date = (select y0 from d)) fy, round(sum(failed) / 7.0) fa from ops.fn_stats where bucket >= (select y7 from d) and bucket < current_date),
  slow as (select fn, max_ms from ops.fn_stats where bucket::date = (select y0 from d) order by max_ms desc limit 1),
  uni as (select round(100.0 * sum(failed) filter (where bucket::date = (select y0 from d)) / greatest(1, sum(calls) filter (where bucket::date = (select y0 from d))), 1) y, round(100.0 * sum(failed) / greatest(1, sum(calls)), 1) a from ops.api_stats where provider = 'unipile' and bucket >= (select y7 from d) and bucket < current_date),
  ws as (select count(*) filter (where created_at::date = (select y0 from d)) y, round(count(*) / 7.0) a from outreach_workspaces where created_at >= (select y7 from d) and created_at < current_date),
  ai as (select count(*) filter (where at::date = (select y0 from d)) y, round(count(*) / 7.0) a,
                round(100.0 * count(*) filter (where at::date = (select y0 from d) and outcome in ('provider_error', 'timeout')) / greatest(1, count(*) filter (where at::date = (select y0 from d))), 1) fy,
                round(100.0 * count(*) filter (where outcome in ('provider_error', 'timeout')) / greatest(1, count(*)), 1) fa,
                round(100.0 * count(*) filter (where at::date = (select y0 from d) and outcome in ('bad_format', 'cut_off', 'empty', 'refused')) / greatest(1, count(*) filter (where at::date = (select y0 from d))), 1) uy,
                round(100.0 * count(*) filter (where outcome in ('bad_format', 'cut_off', 'empty', 'refused')) / greatest(1, count(*)), 1) ua
         from outreach_ai_calls where at >= (select y7 from d) and at < current_date and not own_key),
  rr as (select count(*) filter (where status = 'sent' and updated_at::date = (select y0 from d)) sy, round(count(*) filter (where status = 'sent') / 7.0) sa,
                count(*) filter (where status = 'escalated' and updated_at::date = (select y0 from d)) ey, round(count(*) filter (where status = 'escalated') / 7.0) ea
         from outreach_ai_reply_runs where updated_at >= (select y7 from d) and updated_at < current_date)
  select jsonb_build_array(
    jsonb_build_object('label', 'Messages and invites sent', 'y', sent.y, 'a', sent.a),
    jsonb_build_object('label', 'Replies received', 'y', replies.y, 'a', replies.a),
    jsonb_build_object('label', 'Sends that failed', 'y', failed.y, 'a', failed.a, 'unit', '%'),
    jsonb_build_object('label', 'Function runs', 'y', fn.y, 'a', fn.a),
    jsonb_build_object('label', 'Function runs that failed', 'y', fn.fy, 'a', fn.fa),
    jsonb_build_object('label', 'Slowest function', 'text', coalesce((select fn || ', ' || round(max_ms / 1000.0) || ' s' from slow), '-')),
    jsonb_build_object('label', 'Unipile calls that failed', 'y', uni.y, 'a', uni.a, 'unit', '%'),
    jsonb_build_object('label', 'New workspaces', 'y', ws.y, 'a', ws.a),
    jsonb_build_object('label', 'AI calls', 'y', ai.y, 'a', ai.a),
    jsonb_build_object('label', 'AI calls that failed', 'y', ai.fy, 'a', ai.fa, 'unit', '%'),
    jsonb_build_object('label', 'AI answers we could not use', 'y', ai.uy, 'a', ai.ua, 'unit', '%'),
    jsonb_build_object('label', 'AI replies sent', 'y', rr.sy, 'a', rr.sa),
    jsonb_build_object('label', 'AI replies passed to a person', 'y', rr.ey, 'a', rr.ea))
  from sent, failed, replies, fn, uni, ws, ai, rr
$$;

-- "Do I need to upgrade?" (7.3), from the check states and the metrics days F48 keeps in kv 'metrics_days'
create or replace function ops.upgrade_answer() returns jsonb
language plpgsql stable set search_path = public, ops, extensions as $$
declare cfg ops.health_settings%rowtype; fixfirst text; days jsonb; heavy_days int := 0; d record; reasons jsonb := '[]'::jsonb; answer text; detail text; over jsonb := '[]'::jsonb; u jsonb; r jsonb; free_over boolean := false;
begin
  select * into cfg from ops.health_settings where id;
  select string_agg(c.name, ', ') into fixfirst from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.key in ('db-3', 'db-4', 'db-9') and s.status in ('watch', 'act') and c.enabled and (c.snoozed_until is null or c.snoozed_until <= now());
  select value into days from ops.health_kv where key = 'metrics_days';
  -- a day counts when CPU was over 80% for more than an hour (13+ of the 5-minute samples), or memory over 85% / swap in use, or connections at 80%
  for d in select key as day, value as v from jsonb_each(coalesce(days, '{}'::jsonb)) where key >= (current_date - 7)::text loop
    if coalesce((d.v->>'cpu_over_80')::int, 0) >= 13 or coalesce((d.v->>'mem_over_85')::int, 0) > 0 or coalesce((d.v->>'conn_over_80')::int, 0) > 0 then heavy_days := heavy_days + 1; end if;
  end loop;
  u := ops.usage_rows();
  for r in select * from jsonb_array_elements(u) loop
    if (r->>'pct')::numeric >= 70 and cfg.supabase_plan = 'free' then free_over := true; end if;
    if r->>'key' in ('fn_invocations') and r->>'month_estimate' is not null and (r->>'month_estimate')::numeric > (r->>'limit')::numeric then over := over || jsonb_build_object('label', r->>'label', 'estimate', r->'month_estimate', 'limit', r->'limit'); end if;
    if r->>'key' in ('egress', 'realtime_messages', 'db_disk') and r->>'reached_on' is not null and (r->>'reached_on')::date <= (date_trunc('month', now()) + interval '1 month')::date then over := over || jsonb_build_object('label', r->>'label', 'reached_on', r->'reached_on', 'limit', r->'limit'); end if;
  end loop;
  reasons := jsonb_build_object('fix_first', fixfirst, 'heavy_days_of_7', heavy_days, 'metrics_days', days, 'plan', cfg.supabase_plan, 'compute_size', cfg.compute_size, 'has_paying_customers', cfg.has_paying_customers, 'free_limit_past_70', free_over, 'usage_over', over);
  if cfg.supabase_plan = 'free' and (cfg.has_paying_customers or free_over) then
    answer := 'move_to_pro'; detail := 'Move from Free to Pro: ' || case when cfg.has_paying_customers then 'there are paying customers' else 'a Free limit is past 70%' end || '. The polling in the specs alone is about 1.3 million invocations a month against 500,000 on Free.';
  elsif heavy_days >= 3 and fixfirst is not null then
    answer := 'fix_first'; detail := format('Fix first: %s. The database looks busy on %s of the last 7 days, but that check must be green before an upgrade is the answer.', fixfirst, heavy_days);
  elsif heavy_days >= 3 then
    answer := 'upgrade_compute'; detail := format('Go up one compute size from %s: the database was short of CPU, memory or connections on %s of the last 7 days, and the slow, stuck and advisor checks are green.', initcap(cfg.compute_size), heavy_days);
  elsif jsonb_array_length(over) > 0 then
    answer := 'higher_bill'; detail := 'Expect a higher bill, no action needed: ' || (select string_agg(x->>'label' || coalesce(' (about ' || (x->>'estimate') || ')', ''), ', ') from jsonb_array_elements(over) x) || ' will pass the included amount this month.';
  elsif fixfirst is not null then
    answer := 'no'; detail := format('Not yet. %s is amber or red; fix that, but nothing here calls for an upgrade.', fixfirst);
  else
    answer := 'no'; detail := 'No.';
  end if;
  -- the two numbers the box always quotes
  detail := detail || format(' The database is at %s%% of its disk and %s%% of its connections.',
    coalesce((select r2->>'pct' from jsonb_array_elements(u) r2 where r2->>'key' = 'db_disk'), '?'),
    (select round(100.0 * count(*) / greatest(1, current_setting('max_connections')::int), 1) from pg_stat_activity where backend_type = 'client backend'));
  return jsonb_build_object('answer', answer, 'text', detail, 'reasons', reasons, 'at', now());
end $$;

-- The daily run (F49): snapshot yesterday, work out the upgrade answer, build the email payload. Returns it.
create or replace function outreach_ops_daily(p_send boolean default true) returns jsonb
language plpgsql security definer set search_path = ops, public, extensions as $$
declare cfg ops.health_settings%rowtype; prev jsonb; now_bad jsonb; prev_bad jsonb; upg jsonb; payload jsonb; manual_age int;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select * into cfg from ops.health_settings where id;
  -- yesterday's row per check: worst status seen, average value (kept for good)
  insert into ops.health_daily (day, check_key, value, worst_status)
  select current_date - 1, check_key, round(avg(value)::numeric, 2), (array_agg(status order by ops.status_rank(status) desc))[1]
  from ops.health_results where at >= current_date - 1 and at < current_date group by check_key
  on conflict (day, check_key) do update set value = excluded.value, worst_status = excluded.worst_status;
  upg := ops.upgrade_answer();
  insert into ops.health_kv (key, value, at) values ('upgrade', upg, now()) on conflict (key) do update set value = excluded.value, at = excluded.at;
  insert into ops.health_kv (key, value, at) values ('daily', jsonb_build_object('figures', ops.daily_figures(), 'for', current_date - 1), now()) on conflict (key) do update set value = excluded.value, at = excluded.at;
  -- what changed since the last email
  select value into prev from ops.health_kv where key = 'daily_sent';
  select coalesce(jsonb_agg(c.key), '[]'::jsonb) into now_bad from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) and s.status in ('watch', 'act');
  prev_bad := coalesce(prev->'bad', '[]'::jsonb);
  select round(extract(epoch from now() - min(used_manual_at)) / 86400) into manual_age from ops.limits where measured_by = 'manual' and plan in (cfg.supabase_plan, 'any');
  payload := jsonb_build_object(
    'date', current_date, 'time_zone', cfg.time_zone, 'to', to_jsonb(cfg.email_to),
    'counts', (select jsonb_build_object('act', count(*) filter (where s.status = 'act'), 'watch', count(*) filter (where s.status = 'watch'), 'ok', count(*) filter (where s.status = 'ok'), 'unknown', count(*) filter (where s.status is null or s.status = 'unknown'), 'total', count(*))
               from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now())),
    'act', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'summary', s.summary, 'value', s.value, 'unit', c.unit, 'act_at', c.act_at, 'watch_at', c.watch_at) order by c.sort_order), '[]'::jsonb) from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) and s.status = 'act'),
    'watch', (select coalesce(jsonb_agg(jsonb_build_object('key', c.key, 'name', c.name, 'summary', s.summary, 'value', s.value, 'unit', c.unit, 'act_at', c.act_at, 'watch_at', c.watch_at) order by c.sort_order), '[]'::jsonb) from ops.health_checks c join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) and s.status = 'watch'),
    'unknown', (select coalesce(jsonb_agg(c.name order by c.sort_order), '[]'::jsonb) from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.enabled and (c.snoozed_until is null or c.snoozed_until <= now()) and (s.status is null or s.status = 'unknown')),
    'snoozed', (select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'until', c.snoozed_until, 'reason', c.snooze_reason) order by c.sort_order), '[]'::jsonb) from ops.health_checks c where c.enabled and c.snoozed_until > now()),
    'upgrade', upg,
    'yesterday', ops.daily_figures(),
    'usage', (select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(ops.usage_rows()) r where r->>'key' in ('db_disk', 'fn_invocations', 'egress', 'storage')),
    'ai_spend', (select jsonb_build_object('spend_usd', s.evidence->'spend_usd', 'budget_usd', s.evidence->'budget_usd', 'pct', s.value) from ops.health_state s where s.check_key = 'api-5'),
    'stuck', (select coalesce(jsonb_agg(jsonb_build_object('workspace', u.name, 'workspace_id', u.workspace_id, 'signals', u.signals, 'count', u.signal_count) order by u.signal_count desc), '[]'::jsonb) from (select * from ops.stuck_users() limit 10) u),
    'new_since', (select coalesce(jsonb_agg(c.name), '[]'::jsonb) from jsonb_array_elements_text(now_bad) k join ops.health_checks c on c.key = k where not prev_bad ? k),
    'fixed_since', (select coalesce(jsonb_agg(c.name), '[]'::jsonb) from jsonb_array_elements_text(prev_bad) k join ops.health_checks c on c.key = k where not now_bad ? k),
    'manual_age_days', manual_age, 'recheck_due', (select min(checked_on) < current_date - 30 from ops.limits),
    'remind_recheck', (select min(checked_on) < current_date - 30 from ops.limits) and (cfg.last_recheck_reminder_on is null or cfg.last_recheck_reminder_on < current_date - 30),
    'remind_manual', manual_age is null or manual_age >= 7);
  if p_send then
    insert into ops.health_kv (key, value, at) values ('daily_sent', jsonb_build_object('bad', now_bad, 'date', current_date), now()) on conflict (key) do update set value = excluded.value, at = excluded.at;
    update ops.health_settings set last_daily_email_on = current_date, last_recheck_reminder_on = case when (payload->>'remind_recheck')::boolean then current_date else last_recheck_reminder_on end where id;
  end if;
  return payload;
end $$;

do $$ declare f text; begin
  for f in select unnest(array['outreach_ops_kv_get(text)', 'outreach_ops_kv_set(text,jsonb)', 'outreach_ops_settings()', 'outreach_ops_state(text)', 'outreach_ops_alerts()', 'outreach_ops_alerts_mark(text[],text)', 'outreach_ops_daily(boolean)']) loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
