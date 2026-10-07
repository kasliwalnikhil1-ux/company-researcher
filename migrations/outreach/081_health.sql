-- 081_health.sql — the Health page's data and its in-database checks (health-page-PRD.md §4, §5, §10). Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/081_health.sql
--
-- Everything lives in the `ops` schema. Clients have no access to it: the page reads through security-definer RPCs in
-- 082 that call platform_require_admin() first; the edge-function wrapper writes through public.outreach_ops_run_done
-- (service role only). ops.health_run() is called by pg_cron every 5 minutes (083) and needs no Edge Function (D3).
--
-- Names: the specs say `actions`, `senders`, `ai_calls`; the build prefixes them `outreach_`. There is no pgmq here:
-- the "queues" of flow-2 are the five queue tables. docs/outreach/HEALTH.md lists every such deviation.

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;
grant usage on schema ops to postgres, service_role;

-- -----------------------------------------------------------------------------------------------------------------
-- Tables (PRD §10)
-- -----------------------------------------------------------------------------------------------------------------
create table if not exists ops.health_checks (
  key            text primary key,
  area           text not null check (area in ('database','jobs','functions','flow','services','ai','app','system')),
  name           text not null,
  question       text not null,
  unit           text,
  watch_at       numeric,
  act_at         numeric,
  immediate      boolean not null default false,
  urgent         boolean not null default false,
  guide          text not null,
  source         text not null check (source in ('sql','metrics','logs_api','advisors','manual')),
  every_minutes  int  not null default 5,
  enabled        boolean not null default true,
  snoozed_until  timestamptz,
  snooze_reason  text,
  sort_order     int not null default 100
);

create table if not exists ops.health_state (
  check_key      text primary key references ops.health_checks(key) on delete cascade,
  status         text not null check (status in ('ok','watch','act','unknown')),
  since          timestamptz not null default now(),
  value          numeric,
  summary        text,
  evidence       jsonb,
  pending        text,
  last_run_at    timestamptz,
  alerted_at     timestamptz,
  alerted_status text,                 -- what the last urgent email said: 'act' until the recovery email went out
  error          text                  -- why the check could not run (status unknown)
);

create table if not exists ops.health_results (
  id bigserial primary key,
  check_key text not null, at timestamptz not null default now(),
  value numeric, status text not null
);
create index if not exists health_results_key_at_idx on ops.health_results (check_key, at desc);

create table if not exists ops.health_daily (
  day date, check_key text, value numeric, worst_status text,
  primary key (day, check_key)
);

create table if not exists ops.fn_stats (
  fn text, bucket timestamptz,
  runs int not null default 0, failed int not null default 0, slow int not null default 0,
  total_ms bigint not null default 0, max_ms int not null default 0, items int not null default 0,
  primary key (fn, bucket)
);
create index if not exists fn_stats_bucket_idx on ops.fn_stats (bucket desc);

create table if not exists ops.fn_problems (
  id bigserial primary key, fn text not null, at timestamptz not null default now(),
  outcome text not null, duration_ms int, error_code text, error_text text, workspace_id uuid
);
create index if not exists fn_problems_at_idx on ops.fn_problems (at desc);

create table if not exists ops.job_last_start (          -- the last start per cron job, kept from each run's recent window
  jobid bigint primary key, jobname text, last_start timestamptz not null
);

create table if not exists ops.fn_config (
  fn text primary key, cron_job text, slow_ms int not null default 5000
);

create table if not exists ops.api_stats (
  provider text, endpoint_group text, bucket timestamptz,
  calls int not null default 0, failed int not null default 0,
  rate_limited int not null default 0, auth_failed int not null default 0,
  total_ms bigint not null default 0, max_ms int not null default 0,
  primary key (provider, endpoint_group, bucket)
);
create index if not exists api_stats_bucket_idx on ops.api_stats (bucket desc);

create table if not exists ops.api_problems (
  id bigserial primary key, provider text not null, endpoint_group text, at timestamptz not null default now(),
  status int, error_code text, error_text text, duration_ms int, fn text, workspace_id uuid
);
create index if not exists api_problems_at_idx on ops.api_problems (at desc);

create table if not exists ops.query_snapshots (
  at timestamptz, queryid bigint, query text, calls bigint, total_ms double precision,
  primary key (at, queryid)
);

create table if not exists ops.size_snapshots (
  day date, schema_name text, table_name text, bytes bigint,
  primary key (day, schema_name, table_name)
);

create table if not exists ops.client_errors (
  id bigserial primary key, at timestamptz not null default now(),
  user_id uuid, workspace_id uuid, route text, fingerprint text, message text, app_version text
);
create index if not exists client_errors_at_idx on ops.client_errors (at desc);

create table if not exists ops.product_events (
  id bigserial primary key, at timestamptz not null default now(),
  user_id uuid, workspace_id uuid, name text not null, route text, detail jsonb
);
create index if not exists product_events_at_idx on ops.product_events (at desc);

create table if not exists ops.limits (
  key text not null, grp text not null, label text not null,
  limit_value numeric, unit text, plan text not null default 'any',   -- free | pro | any
  note text,
  used_manual numeric, used_manual_at timestamptz,
  source_url text, checked_on date, measured_by text not null default 'sql', sort_order int not null default 100,
  primary key (key, plan)
);

create table if not exists ops.health_settings (
  id boolean primary key default true check (id),
  supabase_plan text not null default 'pro' check (supabase_plan in ('free','pro')),
  compute_size text not null default 'micro',
  email_to text[] not null default '{}', email_hour int not null default 9 check (email_hour between 0 and 23),
  time_zone text not null default 'Asia/Kolkata',
  urgent_email boolean not null default true,
  ai_monthly_budget_usd numeric,
  ai_price_in_per_m numeric not null default 0.50,     -- platform model price, $ per million input tokens (api-5)
  ai_price_out_per_m numeric not null default 3.00,
  has_paying_customers boolean not null default true,  -- for the Free → Pro rule (§7.3)
  last_daily_email_on date,
  last_recheck_reminder_on date,
  updated_at timestamptz not null default now()
);
insert into ops.health_settings (id) values (true) on conflict do nothing;

-- Small key/value store for what F49 works out once a day (the upgrade answer, the daily figures) and F48's cursors.
create table if not exists ops.health_kv (key text primary key, value jsonb not null, at timestamptz not null default now());

-- ai_calls: did the provider answer, and could the answer be used (PRD §5.2, D12)
alter table outreach_ai_calls
  add column if not exists outcome     text check (outcome in ('ok','provider_error','timeout','empty','cut_off','refused','bad_format')),
  add column if not exists http_status int,
  add column if not exists attempts    smallint not null default 1,
  add column if not exists own_key     boolean  not null default false;
update outreach_ai_calls set outcome = 'ok' where outcome is null and at < (select coalesce(min(bucket), now()) from ops.api_stats);   -- rows from before 081: the old helper logged successes only
create index if not exists outreach_ai_calls_bad_idx on outreach_ai_calls (at desc, purpose) where outcome is distinct from 'ok';
create index if not exists outreach_ai_calls_at_idx on outreach_ai_calls (at desc);

-- The website assistant's turn is recorded by SQL (outreach_webchat_v_turn_record / _suggest_record) after a successful
-- answer; the stream's failures are logged by the helper with their own outcome. Those SQL rows are therefore 'ok'.
create or replace function ops.trg_ai_calls_outcome() returns trigger language plpgsql as $$
begin
  if new.outcome is null and new.purpose = 'webchat_answer' then new.outcome := 'ok'; end if;
  return new;
end $$;
drop trigger if exists zz_ops_ai_calls_outcome on outreach_ai_calls;
create trigger zz_ops_ai_calls_outcome before insert on outreach_ai_calls for each row execute function ops.trg_ai_calls_outcome();

-- The job checks read cron.job_run_details, which pg_cron leaves without an index; with the 10- and 15-second jobs it holds
-- about 280,000 rows for 7 days and every scan costs seconds on a small compute size. Indexed here when we may.
do $$ begin
  create index if not exists ops_job_run_details_start_idx on cron.job_run_details (start_time desc);
  create index if not exists ops_job_run_details_job_start_idx on cron.job_run_details (jobid, start_time desc);
exception when insufficient_privilege then raise notice 'ops: could not index cron.job_run_details (owned by the extension); the job checks fall back to one scan per run';
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------------------------------------------
-- Emails, phone numbers, query strings and key-shaped runs replaced by [removed]; 300 characters at most (D7).
create or replace function ops.scrub(p text) returns text language sql immutable as $$
  select left(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(p, ''),
    '\s+', ' ', 'g'),
    '(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}|\m(sk|pk|rk|sbp|sb|ghp|gho)[-_][A-Za-z0-9_-]{8,}\M|\mAIza[0-9A-Za-z_-]{20,}\M|\m[a-f0-9]{32,}\M|\m[A-Za-z0-9+/]{40,}={0,2}\M', '[removed]', 'g'),
    '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[removed]', 'g'),
    '\?[^\s"''<>)]*', '?[removed]', 'g'),
    '(^|[^\w/.-])\+?\d[\d\s().-]{7,}\d([^\w/.-]|$)', '\1[removed]\2', 'g'), 300)
$$;

-- Seconds between two runs of a pg_cron schedule ('10 seconds', '*/5 * * * *', '5 * * * *', '30 4 * * *', '35 3 * * 1').
create or replace function ops.cron_interval_seconds(p_schedule text) returns int language plpgsql immutable as $$
declare s text := btrim(coalesce(p_schedule, '')); f text[]; m text[];
begin
  m := regexp_match(s, '^(\d+)\s+second', 'i'); if m is not null then return greatest(1, m[1]::int); end if;
  m := regexp_match(s, '^(\d+)\s+minute', 'i'); if m is not null then return m[1]::int * 60; end if;
  m := regexp_match(s, '^(\d+)\s+hour', 'i');   if m is not null then return m[1]::int * 3600; end if;
  f := regexp_split_to_array(s, '\s+');
  if array_length(f, 1) <> 5 then return 86400; end if;
  if f[5] <> '*' then return 604800; end if;
  if f[3] <> '*' or f[4] <> '*' then return 2592000; end if;
  if f[2] <> '*' then
    m := regexp_match(f[2], '^\*/(\d+)$'); if m is not null then return m[1]::int * 3600; end if;
    if f[2] ~ ',' then return 3600 * 24 / greatest(1, array_length(regexp_split_to_array(f[2], ','), 1)); end if;
    return 86400;
  end if;
  m := regexp_match(f[1], '^\*/(\d+)$'); if m is not null then return m[1]::int * 60; end if;
  if f[1] = '*' then return 60; end if;
  if f[1] ~ ',' then return 3600 / greatest(1, array_length(regexp_split_to_array(f[1], ','), 1)); end if;
  return 3600;
end $$;

-- The edge function a cron job invokes (from its command), or null for a job that runs SQL itself.
create or replace function ops.cron_job_fn(p_command text) returns text language sql immutable as $$
  select (regexp_match(coalesce(p_command, ''), 'outreach_invoke\(\s*''([a-z0-9_-]+)'''))[1]
$$;

-- Status from a value and a check's thresholds. Null value → unknown.
create or replace function ops.thr(p_key text, p_value numeric) returns text language sql stable as $$
  select case
    when p_value is null then 'unknown'
    when c.act_at is not null and p_value >= c.act_at then 'act'
    when c.watch_at is not null and p_value >= c.watch_at then 'watch'
    else 'ok' end
  from ops.health_checks c where c.key = p_key
$$;

-- How a provider is named on the page.
create or replace function ops.provider_label(p text) returns text language sql immutable as $$
  select case p when 'unipile' then 'Unipile' when 'ai' then 'AI provider' when 'resend' then 'Resend' when 'stripe' then 'Stripe' when 'elevenlabs' then 'ElevenLabs' else initcap(p) end
$$;

-- Status order for "worst of".
create or replace function ops.status_rank(p text) returns int language sql immutable as $$
  select case p when 'act' then 3 when 'watch' then 2 when 'unknown' then 1 else 0 end
$$;

-- -----------------------------------------------------------------------------------------------------------------
-- ops.health_apply: the two-in-a-row rule (D6, §3.4) and the history row
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.health_apply(p_key text, p_status text, p_value numeric, p_summary text, p_evidence jsonb, p_error text default null) returns void
language plpgsql as $$
declare c ops.health_checks%rowtype; st ops.health_state%rowtype; new_status text; new_since timestamptz;
begin
  select * into c from ops.health_checks where key = p_key;
  if not found then return; end if;
  select * into st from ops.health_state where check_key = p_key;
  if not found then
    insert into ops.health_state (check_key, status, since, value, summary, evidence, last_run_at, error)
    values (p_key, case when p_status = 'unknown' then 'unknown' else 'ok' end, now(), p_value, p_summary, p_evidence, now(), p_error);
    select * into st from ops.health_state where check_key = p_key;
  end if;
  new_status := st.status; new_since := st.since;
  if p_status = st.status then
    -- nothing changes; a half-seen different status is forgotten
    update ops.health_state set pending = null where check_key = p_key;
  elsif p_status = 'unknown' then
    -- a check that could not run is grey at once (D2)
    new_status := 'unknown'; new_since := now();
    update ops.health_state set pending = null where check_key = p_key;
  elsif p_status = 'act' and c.immediate then
    new_status := 'act'; new_since := now();
    update ops.health_state set pending = null where check_key = p_key;
  elsif st.status = 'unknown' and p_status = 'ok' then
    -- back from grey needs no confirmation: nothing was wrong
    new_status := 'ok'; new_since := now();
    update ops.health_state set pending = null where check_key = p_key;
  elsif st.pending = p_status then
    -- seen twice in a row
    new_status := p_status; new_since := now();
    update ops.health_state set pending = null where check_key = p_key;
  else
    update ops.health_state set pending = p_status where check_key = p_key;
  end if;
  update ops.health_state
     set status = new_status, since = new_since, value = p_value, summary = p_summary, evidence = p_evidence, last_run_at = now(),
         error = case when p_status = 'unknown' then p_error else null end
   where check_key = p_key;
  insert into ops.health_results (check_key, value, status) values (p_key, p_value, p_status);
end $$;

-- For F48 / F49: a result from an outside source through the same rules. Status null → from the thresholds.
create or replace function ops.health_record(p_key text, p_value numeric, p_summary text, p_evidence jsonb, p_status text default null, p_error text default null) returns void
language plpgsql as $$
begin
  perform ops.health_apply(p_key, coalesce(p_status, ops.thr(p_key, p_value)), p_value, p_summary, p_evidence, p_error);
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- ops.run_done: what the wrapper writes, once per function run (PRD §5.1)
-- -----------------------------------------------------------------------------------------------------------------
-- The deployed name of a function from what it calls itself in serve(): outreach-* functions drop their prefix there.
create or replace function ops.fn_name(p text) returns text language sql immutable as $$
  select case when p like 'outreach-%' or p in ('capitalxai-mcp', 'crm-mcp', 'oauth-as', 'smartlead-mcp', 'cleanup-temp-bucket', 'unknown') then p else 'outreach-' || p end
$$;

create or replace function ops.run_done(p jsonb) returns void language plpgsql as $$
declare
  -- functions name themselves without the directory prefix ("worker-tick"); cron commands use the deployed name
  -- ("outreach-worker-tick"). One form everywhere: the deployed name.
  v_fn text := left(ops.fn_name(coalesce(p->>'fn', 'unknown')), 80);
  v_ms int := greatest(0, least(2147483647, coalesce((p->>'duration_ms')::bigint, 0)))::int;
  v_failed boolean := coalesce(p->>'outcome', 'ok') = 'failed';
  v_items int := greatest(0, coalesce((p->>'items')::int, 0));
  v_slow_ms int; v_slow boolean; v_bucket timestamptz := date_trunc('minute', now()) - make_interval(mins => extract(minute from now())::int % 5);
  c record; c_failed boolean; c_rl boolean; c_auth boolean;
begin
  select slow_ms into v_slow_ms from ops.fn_config where fn = v_fn;
  v_slow_ms := coalesce(v_slow_ms, 5000);
  v_slow := v_ms >= v_slow_ms;
  insert into ops.fn_stats as s (fn, bucket, runs, failed, slow, total_ms, max_ms, items)
  values (v_fn, v_bucket, 1, case when v_failed then 1 else 0 end, case when v_slow then 1 else 0 end, v_ms, v_ms, v_items)
  on conflict (fn, bucket) do update
    set runs = s.runs + 1, failed = s.failed + excluded.failed, slow = s.slow + excluded.slow,
        total_ms = s.total_ms + excluded.total_ms, max_ms = greatest(s.max_ms, excluded.max_ms), items = s.items + excluded.items;
  if v_failed or v_slow then
    insert into ops.fn_problems (fn, outcome, duration_ms, error_code, error_text, workspace_id)
    values (v_fn, case when v_failed then 'failed' else 'slow' end, v_ms, left(p->>'error_code', 60), ops.scrub(p->>'error_text'), nullif(p->>'workspace_id', '')::uuid);
  end if;
  for c in select * from jsonb_to_recordset(coalesce(p->'calls', '[]'::jsonb)) as x(provider text, "group" text, status int, ms int, error_code text, error_text text) loop
    c.status := coalesce(c.status, 0);
    c_rl := c.status = 429;
    c_auth := c.status in (401, 402, 403);
    c_failed := c.status = 0 or c.status >= 500 or c.status = 400;
    insert into ops.api_stats as a (provider, endpoint_group, bucket, calls, failed, rate_limited, auth_failed, total_ms, max_ms)
    values (left(coalesce(c.provider, 'unknown'), 40), left(coalesce(c."group", '?'), 120), v_bucket, 1,
            case when c_failed then 1 else 0 end, case when c_rl then 1 else 0 end, case when c_auth then 1 else 0 end, coalesce(c.ms, 0), coalesce(c.ms, 0))
    on conflict (provider, endpoint_group, bucket) do update
      set calls = a.calls + 1, failed = a.failed + excluded.failed, rate_limited = a.rate_limited + excluded.rate_limited, auth_failed = a.auth_failed + excluded.auth_failed,
          total_ms = a.total_ms + excluded.total_ms, max_ms = greatest(a.max_ms, excluded.max_ms);
    if c_failed or c_rl or c_auth then
      insert into ops.api_problems (provider, endpoint_group, status, error_code, error_text, duration_ms, fn, workspace_id)
      values (left(coalesce(c.provider, 'unknown'), 40), left(coalesce(c."group", '?'), 120), c.status, left(c.error_code, 60), ops.scrub(c.error_text), c.ms, v_fn, nullif(p->>'workspace_id', '')::uuid);
    end if;
  end loop;
end $$;

-- The wrapper calls this over PostgREST with the service key. Signed-in users may not.
create or replace function outreach_ops_run_done(payload jsonb) returns void
language plpgsql security definer set search_path = public, ops, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform ops.run_done(payload);
end $$;
revoke all on function outreach_ops_run_done(jsonb) from public, anon, authenticated;
grant execute on function outreach_ops_run_done(jsonb) to service_role;

-- For F48 / F49 (service role): record an outside-source result; read / write the small kv store.
create or replace function outreach_ops_health_record(p_key text, p_value numeric, p_summary text, p_evidence jsonb, p_status text default null, p_error text default null) returns void
language plpgsql security definer set search_path = public, ops, extensions as $$
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  perform ops.health_record(p_key, p_value, p_summary, p_evidence, p_status, p_error);
end $$;
revoke all on function outreach_ops_health_record(text, numeric, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function outreach_ops_health_record(text, numeric, text, jsonb, text, text) to service_role;

-- -----------------------------------------------------------------------------------------------------------------
-- Snapshots the checks compare against: hourly top queries, daily table sizes
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.take_snapshots() returns void language plpgsql as $$
declare h timestamptz := date_trunc('hour', now()); d date := current_date;
begin
  if not exists (select 1 from ops.query_snapshots where at = h limit 1) then
    begin
      insert into ops.query_snapshots (at, queryid, query, calls, total_ms)
      select h, s.queryid, left(s.query, 400), s.calls, s.total_exec_time
      from pg_stat_statements s
      where s.dbid = (select oid from pg_database where datname = current_database())
      order by s.total_exec_time desc limit 100
      on conflict do nothing;
    exception when others then null;   -- the extension may be off: db-3 then reports unknown
    end;
  end if;
  if not exists (select 1 from ops.size_snapshots where day = d limit 1) then
    insert into ops.size_snapshots (day, schema_name, table_name, bytes)
    select d, n.nspname, c.relname, pg_total_relation_size(c.oid)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p', 'm') and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
    order by pg_total_relation_size(c.oid) desc limit 20
    on conflict do nothing;
  end if;
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- ops.health_run: every check whose source is `sql` (PRD §4.1 to §4.8, step 1)
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.health_run() returns jsonb
language plpgsql security definer set search_path = ops, public, extensions as $$
declare
  v numeric; st text; summary text; ev jsonb; n int; n2 int; n3 int; t timestamptz; r record; w numeric; a numeric;
  limit_bytes numeric; days_to_full numeric; max_conn int; cfg ops.health_settings%rowtype;
  ran int := 0; errs text[] := '{}';
  prov text; worst_v numeric; worst_st text; worst_summary text; t_chk timestamptz; tm jsonb := '{}'::jsonb;
begin
  select * into cfg from ops.health_settings where id;
  insert into ops.health_kv (key, value, at) values ('health_first_run', 'true'::jsonb, now()) on conflict (key) do nothing;
  -- the last two hours of pg_cron history once, for job-2 .. job-4 (job-1 and sys-2 look further back)
  create temp table if not exists ops_recent_runs on commit drop as select runid, jobid, status, start_time, end_time, return_message from cron.job_run_details where false;
  truncate ops_recent_runs; insert into ops_recent_runs select runid, jobid, status, start_time, end_time, return_message from cron.job_run_details where start_time > now() - interval '3 hours';
  insert into ops.job_last_start (jobid, jobname, last_start)
  select rr.jobid, j.jobname, max(rr.start_time) from ops_recent_runs rr left join cron.job j on j.jobid = rr.jobid group by 1, 2
  on conflict (jobid) do update set last_start = greatest(ops.job_last_start.last_start, excluded.last_start), jobname = coalesce(excluded.jobname, ops.job_last_start.jobname);
  -- jobs never seen in a window (daily / weekly ones before their first run since Health started): one filtered scan, once each
  insert into ops.job_last_start (jobid, jobname, last_start)
  select d.jobid, j.jobname, max(d.start_time) from cron.job j join cron.job_run_details d on d.jobid = j.jobid
  where j.active and j.jobid not in (select jobid from ops.job_last_start) group by 1, 2
  on conflict (jobid) do nothing;
  t_chk := clock_timestamp(); perform ops.take_snapshots(); tm := tm || jsonb_build_object('snapshots', round(extract(epoch from clock_timestamp() - t_chk) * 1000));

  -- ============================================================ db-1 Database size
  begin
    t_chk := clock_timestamp();
    select limit_value into limit_bytes from ops.limits where key = 'db_disk' and plan = cfg.supabase_plan;
    v := pg_database_size(current_database());
    select * into w, a from (select watch_at, act_at from ops.health_checks where key = 'db-1') x;
    -- growth over 7 days from the daily table sizes (the 20 biggest tables stand in for the database)
    select (sum(b.bytes) - sum(a7.bytes)) / 7.0 into days_to_full   -- bytes per day
    from ops.size_snapshots b join ops.size_snapshots a7 on a7.schema_name = b.schema_name and a7.table_name = b.table_name and a7.day = b.day - 7
    where b.day = current_date;
    if days_to_full is not null and days_to_full > 0 and limit_bytes is not null then days_to_full := (limit_bytes - v) / days_to_full; else days_to_full := null; end if;
    v := case when limit_bytes is null or limit_bytes = 0 then null else round(100.0 * v / limit_bytes, 1) end;
    st := case when v is null then 'unknown' when v >= a or coalesce(days_to_full, 1e9) <= 7 then 'act' when v >= w or coalesce(days_to_full, 1e9) <= 30 then 'watch' else 'ok' end;
    select jsonb_agg(jsonb_build_object('schema', s.schema_name, 'table', s.table_name, 'bytes', s.bytes, 'grew_7d_pct',
             case when p.bytes is null or p.bytes = 0 then null else round(100.0 * (s.bytes - p.bytes) / p.bytes, 1) end) order by s.bytes desc) into ev
    from ops.size_snapshots s left join ops.size_snapshots p on p.schema_name = s.schema_name and p.table_name = s.table_name and p.day = s.day - 7
    where s.day = current_date;
    summary := format('%s of the disk is used (%s). %s', coalesce(v::text || '%', '?'), pg_size_pretty(pg_database_size(current_database())),
                      case when days_to_full is null then 'Not enough history yet to say when it fills.' when days_to_full > 365 then 'At this rate it fills in over a year.' else format('At this rate it is full in about %s days.', round(days_to_full)) end);
    perform ops.health_apply('db-1', st, v, summary, jsonb_build_object('tables', coalesce(ev, '[]'::jsonb), 'limit_bytes', limit_bytes, 'used_bytes', pg_database_size(current_database()), 'days_to_full', round(days_to_full)));
    ran := ran + 1; tm := tm || jsonb_build_object('db-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('db-1: ' || sqlerrm); perform ops.health_apply('db-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ db-2 Connections
  begin
    t_chk := clock_timestamp();
    select current_setting('max_connections')::int into max_conn;
    select count(*) into n from pg_stat_activity where backend_type = 'client backend';
    v := round(100.0 * n / greatest(1, max_conn), 1);
    select jsonb_agg(jsonb_build_object('who', usename, 'app', left(coalesce(application_name, ''), 40), 'state', coalesce(state, '?'), 'count', cnt) order by cnt desc) into ev
    from (select usename, application_name, state, count(*) cnt from pg_stat_activity where backend_type = 'client backend' group by 1, 2, 3 order by 4 desc limit 15) x;
    summary := format('%s of %s connections in use (%s%%).', n, max_conn, v);
    perform ops.health_apply('db-2', ops.thr('db-2', v), v, summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'max_connections', max_conn, 'in_use', n));
    ran := ran + 1; tm := tm || jsonb_build_object('db-2', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('db-2: ' || sqlerrm); perform ops.health_apply('db-2', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ db-3 Slow queries (hour against the hour before)
  begin
    t_chk := clock_timestamp();
    if not exists (select 1 from pg_extension where extname = 'pg_stat_statements') then raise exception 'pg_stat_statements is not installed'; end if;
    with snaps as (select distinct at from ops.query_snapshots order by at desc limit 3),
    cur as (select at from snaps order by at desc limit 1), prev as (select at from snaps order by at desc offset 1 limit 1), prev2 as (select at from snaps order by at desc offset 2 limit 1),
    delta as (
      select c.queryid, c.query, greatest(0, c.calls - p.calls) calls, greatest(0, c.total_ms - p.total_ms) total_ms,
             case when greatest(0, c.calls - p.calls) > 0 then greatest(0, c.total_ms - p.total_ms) / greatest(1, c.calls - p.calls) end mean_ms,
             case when p2.queryid is not null and greatest(0, p.calls - p2.calls) > 0 then greatest(0, p.total_ms - p2.total_ms) / greatest(1, p.calls - p2.calls) end prev_mean_ms
      from ops.query_snapshots c join cur on cur.at = c.at
      join ops.query_snapshots p on p.queryid = c.queryid and p.at = (select at from prev)
      left join ops.query_snapshots p2 on p2.queryid = c.queryid and p2.at = (select at from prev2)
    ),
    tot as (select nullif(sum(total_ms), 0) s from delta)
    select count(*) filter (where calls >= 20 and mean_ms >= 1000), count(*) filter (where calls >= 20 and mean_ms >= 100 and prev_mean_ms is not null and mean_ms >= 2 * prev_mean_ms),
           max(mean_ms) filter (where calls >= 20),
           (select jsonb_agg(jsonb_build_object('query', left(regexp_replace(query, '\s+', ' ', 'g'), 160), 'calls', calls, 'avg_ms', round(mean_ms::numeric, 1), 'share_pct', round((100.0 * total_ms / tot.s)::numeric, 1), 'prev_avg_ms', round(prev_mean_ms::numeric, 1)) order by total_ms desc)
            from (select * from delta order by total_ms desc limit 8) d, tot)
      into n, n2, v, ev
    from delta;
    if (select count(*) from (select distinct at from ops.query_snapshots) x) < 2 then
      st := 'unknown'; summary := 'Not enough history yet: the first comparison is possible one hour after the checks start.';
    else
      st := case when n > 0 then 'act' when n2 > 0 then 'watch' else 'ok' end;
      summary := case when n > 0 then format('%s %s averaging over 1 second in the last hour.', n, case when n = 1 then 'query is' else 'queries are' end)
                      when n2 > 0 then format('%s %s twice as slow as the hour before.', n2, case when n2 = 1 then 'query got' else 'queries got' end)
                      else format('No slow queries. The slowest frequent query averages %s ms.', coalesce(round(v::numeric)::text, '?')) end;
    end if;
    perform ops.health_apply('db-3', st, round(v::numeric, 1), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)), case when st = 'unknown' then summary end);
    ran := ran + 1; tm := tm || jsonb_build_object('db-3', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('db-3: ' || sqlerrm); perform ops.health_apply('db-3', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ db-4 Stuck or blocked queries
  begin
    t_chk := clock_timestamp();
    with act as (
      select pid, usename, left(coalesce(application_name, ''), 40) app, state, wait_event_type, pg_blocking_pids(pid) blocked_by,
             extract(epoch from now() - coalesce(state_change, query_start, backend_start)) age_s,
             extract(epoch from now() - query_start) query_age_s,
             left(regexp_replace(regexp_replace(coalesce(query, ''), '''[^'']*''', '''…''', 'g'), '\s+', ' ', 'g'), 200) q
      from pg_stat_activity
      where backend_type = 'client backend' and pid <> pg_backend_pid() and state is not null and state <> 'idle'
        and coalesce(query, '') not ilike 'autovacuum%'
    )
    select count(*) filter (where age_s > 30), count(*) filter (where cardinality(blocked_by) > 0 and age_s > 120), max(age_s),
           (select jsonb_agg(jsonb_build_object('pid', pid, 'who', usename, 'app', app, 'state', state, 'for_s', round(age_s), 'waiting_on', wait_event_type, 'blocked_by', blocked_by, 'query', q) order by age_s desc) from (select * from act where age_s > 10 order by age_s desc limit 10) z)
      into n, n2, v, ev from act;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    summary := case when n2 > 0 then format('%s %s blocking others for over 2 minutes.', n2, case when n2 = 1 then 'query is' else 'queries are' end)
                    when n > 0 then format('%s %s running or idle in a transaction for over 30 seconds.', n, case when n = 1 then 'query has been' else 'queries have been' end)
                    else 'Nothing is stuck.' end;
    perform ops.health_apply('db-4', st, round(coalesce(v, 0)::numeric), summary,
      jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'live_query', 'select pid, usename, state, now() - state_change as for, wait_event_type, pg_blocking_pids(pid) as blocked_by, left(query, 200) from pg_stat_activity where state <> ''idle'' and backend_type = ''client backend'' order by state_change'));
    ran := ran + 1; tm := tm || jsonb_build_object('db-4', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('db-4: ' || sqlerrm); perform ops.health_apply('db-4', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ db-5 Fast-growing tables
  begin
    t_chk := clock_timestamp();
    select count(*), max(case when p.bytes > 0 then round(100.0 * (s.bytes - p.bytes) / p.bytes, 1) end),
           jsonb_agg(jsonb_build_object('schema', s.schema_name, 'table', s.table_name, 'bytes', s.bytes, 'grew_7d_pct', case when p.bytes > 0 then round(100.0 * (s.bytes - p.bytes) / p.bytes, 1) end) order by s.bytes desc)
      into n, v, ev
    from ops.size_snapshots s left join ops.size_snapshots p on p.schema_name = s.schema_name and p.table_name = s.table_name and p.day = s.day - 7
    where s.day = current_date and s.bytes > 100 * 1024 * 1024 and p.bytes > 0 and (s.bytes - p.bytes) > 0.2 * p.bytes;
    if not exists (select 1 from ops.size_snapshots where day <= current_date - 7) then
      st := 'unknown'; summary := 'Not enough history yet: table growth needs 7 days of daily sizes.';
    else
      st := case when n > 0 then 'watch' else 'ok' end;
      summary := case when n > 0 then format('%s %s over 100 MB grew more than 20%% in 7 days.', n, case when n = 1 then 'table' else 'tables' end) else 'No table over 100 MB grew more than 20% in 7 days.' end;
    end if;
    perform ops.health_apply('db-5', st, coalesce(v, 0), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)), case when st = 'unknown' then summary end);
    ran := ran + 1; tm := tm || jsonb_build_object('db-5', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('db-5: ' || sqlerrm); perform ops.health_apply('db-5', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ job-1 Jobs running on time
  begin
    t_chk := clock_timestamp();
    with j as (
      select j.jobid, j.jobname, j.schedule, ops.cron_interval_seconds(j.schedule) iv, l.last_start
      from cron.job j left join ops.job_last_start l on l.jobid = j.jobid where j.active
      union all   -- the workers the dispatcher runs (084): "last start" is the last time the dispatcher looked at the job
      select null::bigint, 'outreach-tick/' || c.name, 'every ' || c.every_s || ' s', c.every_s, c.last_run_at
      from outreach_cron_jobs c where c.active
    ),
    late as (
      select *, extract(epoch from now() - coalesce(last_start, (select at from ops.health_kv where key = 'health_first_run'), now())) - iv late_s from j
    )
    select count(*) filter (where late_s > 3 * iv and late_s > 120),
           count(*) filter (where (jobname = 'outreach-tick' and late_s + iv > 180) or late_s > 10 * iv),
           max(late_s) filter (where late_s > 0),
           (select jsonb_agg(jsonb_build_object('job', jobname, 'schedule', schedule, 'last_start', last_start, 'late_s', round(greatest(0, late_s))) order by late_s desc) from (select * from late order by late_s desc limit 12) z),
           (select jobname from late order by late_s desc limit 1)
      into n, n2, v, ev, summary from late;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    summary := case when n2 > 0 then format('%s %s badly late: %s.', n2, case when n2 = 1 then 'job is' else 'jobs are' end, coalesce(summary, '?'))
                    when n > 0 then format('%s %s late by more than 3 times its interval.', n, case when n = 1 then 'job is' else 'jobs are' end)
                    else 'Every scheduled job started on time.' end;
    perform ops.health_apply('job-1', st, round(coalesce(v, 0)::numeric), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)));
    ran := ran + 1; tm := tm || jsonb_build_object('job-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('job-1: ' || sqlerrm); perform ops.health_apply('job-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ job-2 Jobs failing
  begin
    t_chk := clock_timestamp();
    with f as (
      select coalesce(j.jobname, d.jobid::text) jobname, count(*) cnt, max(d.start_time) last_at, ops.scrub(max(d.return_message)) msg
      from ops_recent_runs d left join cron.job j on j.jobid = d.jobid
      where d.status = 'failed' and d.start_time > now() - interval '1 hour' group by 1
    )
    select coalesce(sum(cnt), 0), count(*) filter (where cnt >= 3 or jobname in ('outreach-tick', 'outreach-inbound')),
           (select jsonb_agg(jsonb_build_object('job', jobname, 'failures', cnt, 'last_at', last_at, 'message', msg) order by cnt desc) from f),
           (select jobname from f order by cnt desc limit 1)
      into n, n2, ev, summary from f;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    summary := case when n = 0 then 'No scheduled job failed in the last hour.' else format('%s %s in the last hour (%s).', n, case when n = 1 then 'job run failed' else 'job runs failed' end, coalesce(summary, '?')) end;
    perform ops.health_apply('job-2', st, n, summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)));
    ran := ran + 1; tm := tm || jsonb_build_object('job-2', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('job-2: ' || sqlerrm); perform ops.health_apply('job-2', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ job-3 Jobs finishing their work (starts vs finished runs)
  begin
    t_chk := clock_timestamp();
    with jf as (select j.jobid, j.jobname, ops.cron_job_fn(j.command) fn from cron.job j where j.active and ops.cron_job_fn(j.command) is not null),
    starts as (
      select jf.fn, count(*) cnt from jf join ops_recent_runs d on d.jobid = jf.jobid
      where d.status = 'succeeded' and d.start_time between now() - interval '70 minutes' and now() - interval '10 minutes'
        and d.start_time >= (select coalesce(min(bucket), now()) + interval '5 minutes' from ops.fn_stats)   -- only since the wrapper has been live
        and coalesce(d.return_message, '') not like '0 rows%'   -- a guarded job ("where exists") that found nothing did not call the function
      group by 1
      union all   -- calls the dispatcher (084) made
      select i.fn, count(*) from outreach_cron_invocations i
      where i.at between now() - interval '70 minutes' and now() - interval '10 minutes'
        and i.at >= (select coalesce(min(bucket), now()) + interval '5 minutes' from ops.fn_stats)
      group by 1
    ),
    runs as (select fn, sum(runs) cnt from ops.fn_stats where bucket >= now() - interval '75 minutes' group by 1)
    select coalesce(sum(greatest(0, s.cnt - coalesce(rr.cnt, 0))), 0),
           jsonb_agg(jsonb_build_object('fn', s.fn, 'started', s.cnt, 'finished', coalesce(rr.cnt, 0), 'unfinished', greatest(0, s.cnt - coalesce(rr.cnt, 0))) order by greatest(0, s.cnt - coalesce(rr.cnt, 0)) desc)
      into n, ev
    from starts s left join runs rr on rr.fn = s.fn;
    st := ops.thr('job-3', n);
    summary := case when n = 0 then 'Every function a job started also finished.' else format('%s %s in the last hour did not finish (no record from the function).', n, case when n = 1 then 'run' else 'runs' end) end;
    perform ops.health_apply('job-3', st, n, summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)));
    ran := ran + 1; tm := tm || jsonb_build_object('job-3', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('job-3: ' || sqlerrm); perform ops.health_apply('job-3', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ job-4 Jobs piling up
  begin
    t_chk := clock_timestamp();
    select count(*), max(extract(epoch from now() - start_time)),
           (select jsonb_agg(jsonb_build_object('job', coalesce(j.jobname, d.jobid::text), 'started', d.start_time, 'running_s', round(extract(epoch from now() - d.start_time))) order by d.start_time)
            from ops_recent_runs d left join cron.job j on j.jobid = d.jobid where d.status = 'running')
      into n, v, ev
    from ops_recent_runs where status = 'running';
    st := case when n >= 24 then 'act' when n > 8 or coalesce(v, 0) > 600 then 'watch' else 'ok' end;
    summary := case when n = 0 then 'No job is running right now.' else format('%s %s running at once; the longest for %s minutes.', n, case when n = 1 then 'job is' else 'jobs are' end, round(coalesce(v, 0) / 60)) end;
    perform ops.health_apply('job-4', st, n, summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'longest_s', round(coalesce(v, 0))));
    ran := ran + 1; tm := tm || jsonb_build_object('job-4', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('job-4: ' || sqlerrm); perform ops.health_apply('job-4', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ job-5 Tomorrow's plan (healthy pooled senders past 06:00 local with no budget for today)
  begin
    t_chk := clock_timestamp();
    with pooled as (
      select distinct unnest(q.sender_pool) sender_id from outreach_sequences q where q.status = 'active' and q.archived_at is null
    ),
    hs as (
      select s.id, s.display_name, s.workspace_id, s.timezone
      from outreach_senders s join pooled p on p.sender_id = s.id
      where s.status = 'ok' and s.deleted_at is null and (s.paused_until is null or s.paused_until < now())
        and extract(hour from now() at time zone coalesce(nullif(s.timezone, ''), 'UTC')) >= 6
    ),
    missing as (
      select h.* from hs h where not exists (select 1 from outreach_sender_budgets b where b.sender_id = h.id and b.day = (now() at time zone coalesce(nullif(h.timezone, ''), 'UTC'))::date)
    )
    select (select count(*) from hs), (select count(*) from missing),
           (select jsonb_agg(jsonb_build_object('sender_id', m.id, 'sender', m.display_name, 'workspace', w.name) order by w.name) from (select * from missing limit 15) m left join outreach_workspaces w on w.id = m.workspace_id)
      into n, n2, ev;
    st := ops.thr('job-5', n2);
    summary := case when n = 0 then 'No healthy sender is in an active sequence yet.' when n2 = 0 then format('All %s healthy senders have a plan for today.', n) else format('%s of %s healthy senders %s no plan for today.', n2, n, case when n2 = 1 then 'has' else 'have' end) end;
    perform ops.health_apply('job-5', st, n2, summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'healthy', n));
    ran := ran + 1; tm := tm || jsonb_build_object('job-5', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('job-5: ' || sqlerrm); perform ops.health_apply('job-5', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ fn-1 A function is failing (15 min, per function)
  begin
    t_chk := clock_timestamp();
    with cur as (select fn, sum(runs) runs, sum(failed) failed from ops.fn_stats where bucket >= now() - interval '15 minutes' group by 1),
    prev as (select fn, sum(failed) failed from ops.fn_stats where bucket >= now() - interval '30 minutes' and bucket < now() - interval '15 minutes' group by 1),
    x as (select c.fn, c.runs, c.failed, coalesce(p.failed, 0) prev_failed, round(100.0 * c.failed / greatest(1, c.runs), 1) pct from cur c left join prev p on p.fn = c.fn where c.failed > 0)
    select count(*) filter (where failed >= 5 and pct >= 1), count(*) filter (where failed >= 20 and pct >= 1 and failed >= 2 * greatest(1, prev_failed)),
           max(pct), (select fn from x order by failed desc limit 1),
           (select jsonb_agg(jsonb_build_object('fn', fn, 'runs', runs, 'failed', failed, 'failed_pct', pct, 'failed_before', prev_failed) order by failed desc) from x)
      into n, n2, v, summary, ev from x;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    ev := jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'errors',
      coalesce((select jsonb_agg(jsonb_build_object('fn', fn, 'at', at, 'code', error_code, 'text', error_text) order by at desc) from (select * from ops.fn_problems where outcome = 'failed' and at > now() - interval '15 minutes' order by at desc limit 8) p), '[]'::jsonb));
    summary := case when summary is null then 'No function failed in the last 15 minutes.'
                    else format('%s is failing: %s%% of its runs in the last 15 minutes. %s', summary, v, coalesce((select 'Most common: ' || coalesce(error_code, left(error_text, 80)) from ops.fn_problems where outcome = 'failed' and at > now() - interval '15 minutes' group by coalesce(error_code, left(error_text, 80)) order by count(*) desc limit 1), '')) end;
    perform ops.health_apply('fn-1', st, coalesce(v, 0), summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('fn-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('fn-1: ' || sqlerrm); perform ops.health_apply('fn-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ fn-2 A function is slow
  begin
    t_chk := clock_timestamp();
    with hr as (select fn, sum(runs) runs, sum(slow) slow, round(100.0 * sum(slow) / greatest(1, sum(runs)), 1) pct, max(max_ms) max_ms from ops.fn_stats where bucket >= now() - interval '1 hour' group by 1),
    cronfn as (select ops.cron_job_fn(command) fn, min(ops.cron_interval_seconds(schedule)) iv from cron.job where active and ops.cron_job_fn(command) is not null group by 1),
    q as (select fn, max(max_ms) max_ms from ops.fn_stats where bucket >= now() - interval '15 minutes' group by 1),
    over_iv as (select q.fn, q.max_ms, c.iv from q join cronfn c on c.fn = q.fn where q.max_ms > c.iv * 1000)
    select count(*) filter (where pct >= 10), (select count(*) from over_iv), max(pct),
           (select jsonb_agg(jsonb_build_object('fn', fn, 'runs', runs, 'slow', slow, 'slow_pct', pct, 'longest_ms', max_ms) order by pct desc) from (select * from hr where slow > 0 order by pct desc limit 12) z),
           coalesce((select fn || ' took ' || round(max_ms / 1000.0) || ' s, longer than its ' || iv || ' s interval' from over_iv order by max_ms desc limit 1),
                    (select fn || ' was slow in ' || pct || '% of its runs this hour' from hr where pct >= 10 order by pct desc limit 1))
      into n, n2, v, ev, summary from hr;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    summary := case when n2 > 0 or n > 0 then summary || '.' else 'No function is slower than it should be.' end;
    perform ops.health_apply('fn-2', st, coalesce(v, 0), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)));
    ran := ran + 1; tm := tm || jsonb_build_object('fn-2', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('fn-2: ' || sqlerrm); perform ops.health_apply('fn-2', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ fn-3 Close to the time limit
  begin
    t_chk := clock_timestamp();
    select limit_value into limit_bytes from ops.limits where key = 'fn_wall_clock_ms' and plan = cfg.supabase_plan;
    with hr as (select fn, max(max_ms) max_ms from ops.fn_stats where bucket >= now() - interval '1 hour' group by 1)
    select max(round(100.0 * max_ms / greatest(1, limit_bytes), 1)), (select fn || ' took ' || round(max_ms / 1000.0) || ' s' from hr order by max_ms desc limit 1),
           jsonb_agg(jsonb_build_object('fn', fn, 'longest_ms', max_ms, 'of_limit_pct', round(100.0 * max_ms / greatest(1, limit_bytes), 1)) order by max_ms desc)
      into v, summary, ev from (select * from hr order by max_ms desc limit 10) z;
    st := case when limit_bytes is null then 'unknown' else ops.thr('fn-3', coalesce(v, 0)) end;
    summary := case when summary is null then 'No runs recorded in the last hour.' else format('%s (limit %s s).', summary, round(limit_bytes / 1000.0)) end;
    perform ops.health_apply('fn-3', st, coalesce(v, 0), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb), 'limit_ms', limit_bytes));
    ran := ran + 1; tm := tm || jsonb_build_object('fn-3', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('fn-3: ' || sqlerrm); perform ops.health_apply('fn-3', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-1 Incoming events waiting (immediate)
  begin
    t_chk := clock_timestamp();
    -- process-inbound stops at 5 attempts without marking the row dead: those are abandoned, not waiting, and are listed apart
    select count(*), extract(epoch from now() - min(received_at)) into n, v from outreach_inbound_events where processed_at is null and not dead and attempts < 5;
    select * into w, a from (select watch_at, act_at from ops.health_checks where key = 'flow-1') x;
    st := case when n > a or coalesce(v, 0) > 120 then 'act' when n > w or coalesce(v, 0) > 60 then 'watch' else 'ok' end;
    select jsonb_build_object('waiting', n, 'oldest_s', round(coalesce(v, 0)), 'dead', (select count(*) from outreach_inbound_events where dead and received_at > now() - interval '1 day'),
             'abandoned', (select count(*) from outreach_inbound_events where processed_at is null and not dead and attempts >= 5),
             'retrying', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'type', event_type, 'attempts', attempts, 'error', ops.scrub(error)) order by attempts desc) from (select * from outreach_inbound_events where processed_at is null and attempts >= 3 order by attempts desc limit 8) z), '[]'::jsonb),
             'last_received_at', (select max(received_at) from outreach_inbound_events)) into ev;
    summary := case when n = 0 then 'Nothing is waiting.' else format('%s %s waiting; the oldest for %s.', n, case when n = 1 then 'event is' else 'events are' end, case when v < 90 then round(v) || ' s' else round(v / 60) || ' min' end) end;
    perform ops.health_apply('flow-1', st, n, summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('flow-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-1: ' || sqlerrm); perform ops.health_apply('flow-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-2 Queues backing up (the queue tables; no pgmq here)
  begin
    t_chk := clock_timestamp();
    with q as (
      -- rows at 5 attempts are ones the worker gave up on: listed as abandoned, not counted as waiting (same as flow-1)
      select 'ai_classify' name, count(*) filter (where attempts < 5) len, extract(epoch from now() - min(created_at) filter (where attempts < 5)) / 60 oldest_min, count(*) filter (where attempts >= 5) abandoned from outreach_ai_classify_queue where locked_at is null or locked_at < now() - interval '10 minutes'
      union all select 'ai_lead_notes', count(*) filter (where attempts < 5), extract(epoch from now() - min(created_at) filter (where attempts < 5)) / 60, count(*) filter (where attempts >= 5) from outreach_ai_lead_notes_queue where next_attempt_at <= now()
      union all select 'push', count(*) filter (where attempts < 5), extract(epoch from now() - min(next_at) filter (where attempts < 5)) / 60, count(*) filter (where attempts >= 5) from outreach_push_queue where next_at <= now() and (claimed_until is null or claimed_until < now())
      union all select 'enrich', count(*) filter (where attempts < 5), extract(epoch from now() - min(next_at) filter (where attempts < 5)) / 60, count(*) filter (where attempts >= 5) from outreach_enrich_queue where next_at <= now()
      union all select 'transcribe', count(*) filter (where attempts < 5), extract(epoch from now() - min(created_at) filter (where attempts < 5)) / 60, count(*) filter (where attempts >= 5) from outreach_transcribe_queue where locked_at is null or locked_at < now() - interval '10 minutes'
    )
    select max(oldest_min), (select name from q order by oldest_min desc nulls last limit 1), jsonb_agg(jsonb_build_object('queue', name, 'length', len, 'oldest_min', round(coalesce(oldest_min, 0)::numeric, 1), 'abandoned', abandoned) order by oldest_min desc nulls last)
      into v, summary, ev from q;
    st := ops.thr('flow-2', coalesce(v, 0));
    summary := case when coalesce(v, 0) < 1 then 'Every queue is being emptied.' else format('The %s queue has an item waiting for %s minutes.', summary, round(v)) end;
    perform ops.health_apply('flow-2', st, round(coalesce(v, 0)::numeric, 1), summary, jsonb_build_object('rows', coalesce(ev, '[]'::jsonb)));
    ran := ran + 1; tm := tm || jsonb_build_object('flow-2', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-2: ' || sqlerrm); perform ops.health_apply('flow-2', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-3 Nothing arriving from Unipile
  begin
    t_chk := clock_timestamp();
    select count(*) into n from outreach_senders where status = 'ok' and deleted_at is null and unipile_account_id is not null;
    select max(received_at) into t from outreach_inbound_events where source = 'unipile';
    if t is null then select max(received_at) into t from outreach_inbound_events; end if;
    v := round((extract(epoch from now() - coalesce(t, now())) / 3600)::numeric, 1);
    st := case when n < 5 then 'ok' else ops.thr('flow-3', v) end;
    summary := case when n < 5 then format('Only %s senders are connected, so this check waits (it needs 5).', n) when t is null then 'No event has ever arrived.' else format('Last event from the channel provider %s ago; %s senders connected.', case when v < 1 then round(v * 60) || ' min' else v || ' h' end, n) end;
    perform ops.health_apply('flow-3', st, v, summary, jsonb_build_object('last_received_at', t, 'connected_senders', n));
    ran := ran + 1; tm := tm || jsonb_build_object('flow-3', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-3: ' || sqlerrm); perform ops.health_apply('flow-3', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-4 Sends failing (immediate)
  begin
    t_chk := clock_timestamp();
    with x as (select * from outreach_actions where executed_at > now() - interval '1 hour' and status in ('sent', 'failed'))
    select count(*), count(*) filter (where status = 'failed') into n, n2 from x;
    v := case when n >= 20 then round(100.0 * n2 / n, 1) else 0 end;
    select * into w, a from (select watch_at, act_at from ops.health_checks where key = 'flow-4') x;
    st := case when n < 20 then 'ok' when v >= a then 'act' when v >= w then 'watch' else 'ok' end;
    select jsonb_build_object('attempted', n, 'failed', n2,
      'by_code', coalesce((select jsonb_agg(jsonb_build_object('code', code, 'failures', c, 'senders', s) order by c desc) from (select coalesce(error_code, '?') code, count(*) c, count(distinct sender_id) s from outreach_actions where executed_at > now() - interval '1 hour' and status = 'failed' group by 1 order by 2 desc limit 6) z), '[]'::jsonb),
      'by_sender', coalesce((select jsonb_agg(jsonb_build_object('sender_id', sid, 'sender', nm, 'failures', c) order by c desc) from (select a.sender_id sid, s.display_name nm, count(*) c from outreach_actions a left join outreach_senders s on s.id = a.sender_id where a.executed_at > now() - interval '1 hour' and a.status = 'failed' group by 1, 2 order by 3 desc limit 6) z), '[]'::jsonb),
      'by_workspace', coalesce((select jsonb_agg(jsonb_build_object('workspace_id', wid, 'workspace', nm, 'failures', c) order by c desc) from (select a.workspace_id wid, w.name nm, count(*) c from outreach_actions a left join outreach_workspaces w on w.id = a.workspace_id where a.executed_at > now() - interval '1 hour' and a.status = 'failed' group by 1, 2 order by 3 desc limit 6) z), '[]'::jsonb)) into ev;
    summary := case when n < 20 then format('Only %s sends in the last hour (the check needs 20).', n) when n2 = 0 then format('All %s sends in the last hour went out.', n)
                    else format('%s%% of %s sends failed in the last hour. Most are "%s" on %s senders.', v, n, (select coalesce(error_code, '?') from outreach_actions where executed_at > now() - interval '1 hour' and status = 'failed' group by 1 order by count(*) desc limit 1),
                                (select count(distinct sender_id) from outreach_actions where executed_at > now() - interval '1 hour' and status = 'failed')) end;
    perform ops.health_apply('flow-4', st, v, summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('flow-4', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-4: ' || sqlerrm); perform ops.health_apply('flow-4', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-5 Sends running late (due > 15 min, sender able to send)
  begin
    t_chk := clock_timestamp();
    with late as (
      select a.id, a.scheduled_for, a.sender_id, a.workspace_id, a.action_type
      from outreach_actions a join outreach_senders s on s.id = a.sender_id
      where a.status = 'queued' and a.scheduled_for < now() - interval '15 minutes'
        and s.status = 'ok' and s.deleted_at is null and (s.paused_until is null or s.paused_until < now())
        and (a.action_type in ('reply', 'call_api', 'find_email') or outreach_in_schedule(s.id, now()))
        and not (a.action_type = 'invite' and s.invite_blocked_until is not null and s.invite_blocked_until > now())
    )
    select count(*), extract(epoch from now() - min(scheduled_for)) / 60,
           coalesce((select jsonb_agg(jsonb_build_object('sender', s.display_name, 'workspace', w.name, 'late', c, 'oldest_min', round(o)) order by c desc) from (select sender_id, workspace_id, count(*) c, extract(epoch from now() - min(scheduled_for)) / 60 o from late group by 1, 2 order by 3 desc limit 10) z left join outreach_senders s on s.id = z.sender_id left join outreach_workspaces w on w.id = z.workspace_id), '[]'::jsonb)
      into n, v, ev from late;
    select * into w, a from (select watch_at, act_at from ops.health_checks where key = 'flow-5') x;
    st := case when n > a or coalesce(v, 0) > 60 then 'act' when n > w then 'watch' else 'ok' end;
    summary := case when n = 0 then 'No due send is waiting.' else format('%s due %s not gone out; the oldest is %s minutes late.', n, case when n = 1 then 'send has' else 'sends have' end, round(v)) end;
    perform ops.health_apply('flow-5', st, n, summary, jsonb_build_object('rows', ev, 'oldest_min', round(coalesce(v, 0))));
    ran := ran + 1; tm := tm || jsonb_build_object('flow-5', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-5: ' || sqlerrm); perform ops.health_apply('flow-5', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-6 Senders disconnected (immediate on a mass drop)
  begin
    t_chk := clock_timestamp();
    select count(*) into n from outreach_senders where deleted_at is null and status in ('ok', 'credentials', 'error', 'disconnected');
    -- dropped in the last hour: a status event into a disconnected state
    select count(distinct sender_id) into n2 from outreach_sender_events e
    where e.kind = 'status' and e.at > now() - interval '1 hour' and coalesce(e.data->>'status', e.data->>'to', '') in ('credentials', 'error', 'disconnected');
    select count(*) into n3 from outreach_senders where deleted_at is null and status in ('credentials', 'error', 'disconnected') and coalesce(disconnected_at, updated_at) < now() - interval '24 hours';
    v := case when n = 0 then 0 else round(100.0 * n2 / n, 1) end;
    st := case when n >= 10 and v > 10 then 'act' when n3 > 0 then 'watch' else 'ok' end;
    select coalesce(jsonb_agg(jsonb_build_object('sender_id', s.id, 'sender', s.display_name, 'workspace', w.name, 'status', s.status, 'reason', left(s.status_reason, 120), 'since', coalesce(s.disconnected_at, s.updated_at)) order by coalesce(s.disconnected_at, s.updated_at)), '[]'::jsonb) into ev
    from (select * from outreach_senders where deleted_at is null and status in ('credentials', 'error', 'disconnected') order by coalesce(disconnected_at, updated_at) limit 15) s left join outreach_workspaces w on w.id = s.workspace_id;
    summary := case when n2 > 0 and v > 10 then format('%s of %s senders (%s%%) dropped off in the last hour.', n2, n, v) when n3 > 0 then format('%s %s been disconnected for over 24 hours.', n3, case when n3 = 1 then 'sender has' else 'senders have' end) else 'No sender is dropping off.' end;
    perform ops.health_apply('flow-6', st, v, summary, jsonb_build_object('rows', ev, 'dropped_1h', n2, 'disconnected_24h', n3, 'total', n));
    ran := ran + 1; tm := tm || jsonb_build_object('flow-6', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-6: ' || sqlerrm); perform ops.health_apply('flow-6', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ flow-7 Webhook receiver failing (immediate)
  begin
    t_chk := clock_timestamp();
    select coalesce(sum(failed), 0), coalesce(sum(runs), 0) into n, n2 from ops.fn_stats where fn = 'outreach-unipile-webhook' and bucket >= now() - interval '15 minutes';
    st := case when n > 0 then 'act' else 'ok' end;
    summary := case when n > 0 then format('%s of %s webhook calls failed in the last 15 minutes.', n, n2) else format('%s webhook calls in the last 15 minutes, none failed.', n2) end;
    ev := jsonb_build_object('failed', n, 'runs', n2, 'errors', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'code', error_code, 'text', error_text) order by at desc) from (select * from ops.fn_problems where fn = 'outreach-unipile-webhook' and outcome = 'failed' and at > now() - interval '1 hour' order by at desc limit 8) z), '[]'::jsonb));
    perform ops.health_apply('flow-7', st, n, summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('flow-7', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('flow-7: ' || sqlerrm); perform ops.health_apply('flow-7', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ api-1 .. api-4 per provider (15 min; customer keys counted apart)
  for prov in select unnest(array['unipile', 'ai', 'resend', 'stripe', 'elevenlabs']) loop
    begin
      t_chk := clock_timestamp();
      select coalesce(sum(calls), 0), coalesce(sum(failed), 0), coalesce(sum(rate_limited), 0), coalesce(sum(auth_failed), 0), coalesce(sum(total_ms), 0)
        into n, n2, n3, max_conn, v
      from ops.api_stats where provider = prov and bucket >= now() - interval '15 minutes';
      ev := jsonb_build_object('calls', n, 'failed', n2, 'rate_limited', n3, 'auth_failed', max_conn,
        'by_group', coalesce((select jsonb_agg(jsonb_build_object('group', endpoint_group, 'calls', c, 'failed', f, 'rate_limited', rl, 'auth_failed', au, 'avg_ms', ms) order by f desc, c desc) from (select endpoint_group, sum(calls) c, sum(failed) f, sum(rate_limited) rl, sum(auth_failed) au, round(sum(total_ms) / greatest(1, sum(calls))) ms from ops.api_stats where provider = prov and bucket >= now() - interval '15 minutes' group by 1 order by f desc, c desc limit 10) z), '[]'::jsonb),
        'errors', coalesce((select jsonb_agg(jsonb_build_object('at', at, 'group', endpoint_group, 'status', status, 'code', error_code, 'text', error_text, 'fn', fn) order by at desc) from (select * from ops.api_problems where provider = prov and at > now() - interval '15 minutes' order by at desc limit 8) z), '[]'::jsonb));
      -- api-1 calls failing
      w := case when n = 0 then 0 else round(100.0 * n2 / n, 1) end;
      st := case when n2 >= 20 and w >= 5 then 'act' when n2 >= 5 and w >= 2 then 'watch' else 'ok' end;
      summary := case when n = 0 then 'No calls in the last 15 minutes.' when n2 = 0 then format('%s calls in the last 15 minutes, none failed.', n) else format('%s of %s calls (%s%%) failed in the last 15 minutes%s.', n2, n, w, coalesce(' — most on ' || (select endpoint_group from ops.api_problems where provider = prov and at > now() - interval '15 minutes' and status <> 429 and status not in (401, 402, 403) group by 1 order by count(*) desc limit 1), '')) end;
      perform ops.health_apply('api-1.' || prov, st, w, summary, ev);
      -- api-2 rate-limited
      w := case when n = 0 then 0 else round(100.0 * n3 / n, 1) end;
      st := case when n3 >= 5 and w >= 5 then 'act' when n3 >= 5 then 'watch' else 'ok' end;
      summary := case when n3 = 0 then 'Not being rate-limited.' else format('%s of %s calls (%s%%) answered 429 in the last 15 minutes.', n3, n, w) end;
      perform ops.health_apply('api-2.' || prov, st, n3, summary, ev);
      -- api-3 key or billing (immediate)
      st := case when max_conn > 0 then 'act' else 'ok' end;
      summary := case when max_conn = 0 then 'The key is accepted.' else format('%s %s answered 401, 402 or 403 in the last 15 minutes: the key was rejected or credit has run out.', max_conn, case when max_conn = 1 then 'call' else 'calls' end) end;
      perform ops.health_apply('api-3.' || prov, st, max_conn, summary, ev);
      -- api-4 slower than usual (≥ 20 calls, against the 7-day average)
      select round(sum(total_ms) / greatest(1, sum(calls))) into a from ops.api_stats where provider = prov and bucket >= now() - interval '7 days' and bucket < now() - interval '15 minutes';
      w := case when n >= 20 then round(v / greatest(1, n)) end;
      st := case when n < 20 or a is null or a = 0 then 'ok' when w >= 2 * a then 'watch' else 'ok' end;
      summary := case when n < 20 then format('Only %s calls in the last 15 minutes (the check needs 20).', n) when a is null then 'No 7-day average yet.' else format('Calls take %s ms on average; usually %s ms.', w, a) end;
      perform ops.health_apply('api-4.' || prov, st, coalesce(w, 0), summary, ev || jsonb_build_object('avg_ms_7d', a));
      ran := ran + 4; tm := tm || jsonb_build_object('api.' || prov, round(extract(epoch from clock_timestamp() - t_chk) * 1000));
    exception when others then errs := errs || ('api-*.' || prov || ': ' || sqlerrm);
      perform ops.health_apply('api-1.' || prov, 'unknown', null, 'Couldn''t check', null, sqlerrm);
      perform ops.health_apply('api-2.' || prov, 'unknown', null, 'Couldn''t check', null, sqlerrm);
      perform ops.health_apply('api-3.' || prov, 'unknown', null, 'Couldn''t check', null, sqlerrm);
      perform ops.health_apply('api-4.' || prov, 'unknown', null, 'Couldn''t check', null, sqlerrm);
    end;
  end loop;

  -- ============================================================ api-5 AI spend this month (platform key only)
  begin
    t_chk := clock_timestamp();
    select coalesce(sum(tokens_in), 0), coalesce(sum(tokens_out), 0) into n, n2 from outreach_ai_calls where at >= date_trunc('month', now()) and not own_key;
    v := round((n * cfg.ai_price_in_per_m + n2 * cfg.ai_price_out_per_m) / 1e6, 2);
    if cfg.ai_monthly_budget_usd is null or cfg.ai_monthly_budget_usd <= 0 then
      st := 'unknown'; summary := format('About $%s spent this month. Set a monthly budget in Health settings to check it.', v);
    else
      w := round(100.0 * v / cfg.ai_monthly_budget_usd, 1);
      st := ops.thr('api-5', w);
      summary := format('$%s of the $%s budget (%s%%) used this month; on track for about $%s.', v, cfg.ai_monthly_budget_usd, w, round(v / greatest(1, extract(day from now())) * extract(day from (date_trunc('month', now()) + interval '1 month - 1 day'))));
    end if;
    perform ops.health_apply('api-5', st, case when st = 'unknown' then null else w end, summary,
      jsonb_build_object('spend_usd', v, 'budget_usd', cfg.ai_monthly_budget_usd, 'tokens_in', n, 'tokens_out', n2,
        'by_purpose', coalesce((select jsonb_agg(jsonb_build_object('purpose', purpose, 'calls', c, 'usd', u) order by u desc) from (select purpose, count(*) c, round((coalesce(sum(tokens_in), 0) * cfg.ai_price_in_per_m + coalesce(sum(tokens_out), 0) * cfg.ai_price_out_per_m) / 1e6, 2) u from outreach_ai_calls where at >= date_trunc('month', now()) and not own_key group by 1 order by 3 desc limit 10) z), '[]'::jsonb)),
      case when st = 'unknown' then 'No budget set' end);
    ran := ran + 1; tm := tm || jsonb_build_object('api-5', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('api-5: ' || sqlerrm); perform ops.health_apply('api-5', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-1 AI answers we can't use (per purpose, last hour, platform key)
  begin
    t_chk := clock_timestamp();
    with p as (
      select purpose, count(*) calls, count(*) filter (where outcome in ('bad_format', 'cut_off', 'empty', 'refused')) bad
      from outreach_ai_calls where at > now() - interval '1 hour' and not own_key group by 1
    ), x as (select *, round(100.0 * bad / greatest(1, calls), 1) pct from p where bad > 0)
    select count(*) filter (where bad >= 5 and pct >= 2), count(*) filter (where bad >= 20 and pct >= 10), max(pct), (select purpose from x order by bad desc limit 1),
           jsonb_build_object('by_purpose', coalesce((select jsonb_agg(jsonb_build_object('purpose', purpose, 'calls', calls, 'unusable', bad, 'pct', pct) order by bad desc) from x), '[]'::jsonb),
             'by_outcome', coalesce((select jsonb_agg(jsonb_build_object('outcome', outcome, 'count', c) order by c desc) from (select outcome, count(*) c from outreach_ai_calls where at > now() - interval '1 hour' and not own_key and outcome in ('bad_format', 'cut_off', 'empty', 'refused') group by 1) z), '[]'::jsonb),
             'by_model', coalesce((select jsonb_agg(jsonb_build_object('model', model, 'unusable', c) order by c desc) from (select model, count(*) c from outreach_ai_calls where at > now() - interval '1 hour' and not own_key and outcome in ('bad_format', 'cut_off', 'empty', 'refused') group by 1 order by 2 desc limit 5) z), '[]'::jsonb),
             'by_workspace', coalesce((select jsonb_agg(jsonb_build_object('workspace_id', wid, 'workspace', nm, 'unusable', c) order by c desc) from (select a.workspace_id wid, w.name nm, count(*) c from outreach_ai_calls a left join outreach_workspaces w on w.id = a.workspace_id where a.at > now() - interval '1 hour' and not a.own_key and a.outcome in ('bad_format', 'cut_off', 'empty', 'refused') group by 1, 2 order by 3 desc limit 6) z), '[]'::jsonb),
             'examples', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'purpose', purpose, 'outcome', outcome, 'model', model, 'at', at) order by at desc) from (select * from outreach_ai_calls where at > now() - interval '1 hour' and not own_key and outcome in ('bad_format', 'cut_off', 'empty', 'refused') order by at desc limit 5) z), '[]'::jsonb))
      into n, n2, v, summary, ev from x;
    st := case when n2 > 0 then 'act' when n > 0 then 'watch' else 'ok' end;
    summary := case when summary is null then 'Every AI answer in the last hour could be used.' else format('%s%% of %s answers could not be used in the last hour (%s).', v, summary, (select outcome from outreach_ai_calls where at > now() - interval '1 hour' and not own_key and outcome in ('bad_format', 'cut_off', 'empty', 'refused') group by 1 order by count(*) desc limit 1)) end;
    perform ops.health_apply('ai-1', st, coalesce(v, 0), summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('ai-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-1: ' || sqlerrm); perform ops.health_apply('ai-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-2.replies AI replies waiting
  begin
    t_chk := clock_timestamp();
    with x as (select rr.*, w.name wname from outreach_ai_reply_runs rr left join outreach_workspaces w on w.id = rr.workspace_id where rr.status = 'drafting' or (rr.status = 'debouncing' and rr.debounce_hard_until < now()))
    select count(*), extract(epoch from now() - min(case when status = 'drafting' then updated_at else debounce_hard_until end)) / 60,
           coalesce((select jsonb_agg(jsonb_build_object('workspace', wname, 'waiting', c, 'oldest_min', round(o)) order by c desc) from (select wname, count(*) c, extract(epoch from now() - min(case when status = 'drafting' then updated_at else debounce_hard_until end)) / 60 o from x group by 1 order by 2 desc limit 8) z), '[]'::jsonb)
      into n, v, ev from x;
    st := ops.thr('ai-2.replies', coalesce(v, 0));
    summary := case when n = 0 then 'No AI reply is waiting.' else format('%s %s waiting; the oldest for %s minutes.', n, case when n = 1 then 'reply is' else 'replies are' end, round(v)) end;
    perform ops.health_apply('ai-2.replies', st, round(coalesce(v, 0)::numeric, 1), summary, jsonb_build_object('rows', ev, 'waiting', n));
    ran := ran + 1; tm := tm || jsonb_build_object('ai-2.replies', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-2.replies: ' || sqlerrm); perform ops.health_apply('ai-2.replies', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-2.lines Personalized lines waiting (workspaces with allowance left)
  begin
    t_chk := clock_timestamp();
    with ws as (select distinct workspace_id from outreach_ai_values where status = 'pending' and created_at < now() - interval '5 minutes'),
    okws as (select workspace_id from ws where coalesce((outreach__ai_pool(workspace_id)->>'ok')::boolean, true)),
    x as (select v.workspace_id, w.name wname, count(*) c, extract(epoch from now() - min(v.created_at)) / 60 o from outreach_ai_values v join okws k on k.workspace_id = v.workspace_id left join outreach_workspaces w on w.id = v.workspace_id where v.status = 'pending' group by 1, 2)
    select coalesce(sum(c), 0), max(o), coalesce(jsonb_agg(jsonb_build_object('workspace', wname, 'waiting', c, 'oldest_min', round(o)) order by o desc), '[]'::jsonb) into n, v, ev from x;
    st := ops.thr('ai-2.lines', coalesce(v, 0));
    summary := case when n = 0 then 'No personalized line is waiting.' else format('%s %s waiting; the oldest for %s minutes.', n, case when n = 1 then 'line is' else 'lines are' end, round(v)) end;
    perform ops.health_apply('ai-2.lines', st, round(coalesce(v, 0)::numeric, 1), summary, jsonb_build_object('rows', ev, 'waiting', n));
    ran := ran + 1; tm := tm || jsonb_build_object('ai-2.lines', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-2.lines: ' || sqlerrm); perform ops.health_apply('ai-2.lines', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-2.website Website visitors waiting (assistant on, visitor's message unanswered after 30 s)
  begin
    t_chk := clock_timestamp();
    with x as (
      select c.id, c.workspace_id, w.name wname, c.last_message_at from outreach_chats c left join outreach_workspaces w on w.id = c.workspace_id
      where c.provider = 'WEBCHAT' and coalesce(c.ai_mode, 'off') not in ('off', 'review') and c.handed_off_at is null
        and c.last_direction = 'in' and c.last_message_at between now() - interval '15 minutes' and now() - interval '30 seconds'
    )
    select count(*), coalesce((select jsonb_agg(jsonb_build_object('workspace', wname, 'waiting', c, 'oldest_s', round(o)) order by c desc) from (select wname, count(*) c, extract(epoch from now() - min(last_message_at)) o from x group by 1 order by 2 desc limit 8) z), '[]'::jsonb) into n, ev from x;
    st := ops.thr('ai-2.website', n);
    summary := case when n = 0 then 'No visitor is waiting for the assistant.' else format('%s %s waiting for an answer in the last 15 minutes.', n, case when n = 1 then 'visitor is' else 'visitors are' end) end;
    perform ops.health_apply('ai-2.website', st, n, summary, jsonb_build_object('rows', ev));
    ran := ran + 1; tm := tm || jsonb_build_object('ai-2.website', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-2.website: ' || sqlerrm); perform ops.health_apply('ai-2.website', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-3.replies AI giving up more than usual (good handovers left out)
  begin
    t_chk := clock_timestamp();
    with fin as (
      select rr.id, rr.workspace_id, rr.status, rr.updated_at, rr.escalation_reasons, rr.master_prompt_version,
             (rr.status in ('escalated', 'failed') and not exists (select 1 from outreach_chats c where c.ai_handoff_run_id = rr.id and c.ai_handoff_reason in ('meeting_confirmed', 'calendar_sent', 'booking', 'human_replied', 'manual'))) gave_up
      from outreach_ai_reply_runs rr where rr.status in ('sent', 'escalated', 'failed', 'no_reply') and rr.updated_at > now() - interval '8 days'
    ),
    d1 as (select count(*) n, count(*) filter (where gave_up) g from fin where updated_at > now() - interval '24 hours'),
    d7 as (select count(*) n, count(*) filter (where gave_up) g from fin where updated_at <= now() - interval '24 hours'),
    h1 as (select count(*) n, count(*) filter (where gave_up) g, count(distinct workspace_id) filter (where gave_up) ws from fin where updated_at > now() - interval '1 hour')
    select d1.n, d1.g, case when d7.n > 0 then round(100.0 * d7.g / d7.n, 1) else null end, h1.n, h1.g, h1.ws
      into n, n2, a, n3, max_conn, limit_bytes from d1, d7, h1;
    v := case when n > 0 then round(100.0 * n2 / n, 1) else 0 end;
    w := case when n3 > 0 then round(100.0 * max_conn / n3, 1) else 0 end;
    st := case when n3 >= 20 and w >= 50 and limit_bytes >= 3 then 'act' when n >= 20 and a is not null and v >= 2 * greatest(a, 1) then 'watch' else 'ok' end;
    with fin as (
      select rr.id, rr.workspace_id, rr.status, rr.updated_at, rr.escalation_reasons, rr.master_prompt_version,
             (rr.status in ('escalated', 'failed') and not exists (select 1 from outreach_chats c where c.ai_handoff_run_id = rr.id and c.ai_handoff_reason in ('meeting_confirmed', 'calendar_sent', 'booking', 'human_replied', 'manual'))) gave_up
      from outreach_ai_reply_runs rr where rr.status in ('sent', 'escalated', 'failed', 'no_reply') and rr.updated_at > now() - interval '8 days'
    )
    select jsonb_build_object('finished_24h', n, 'gave_up_24h', n2, 'share_24h_pct', v, 'share_7d_pct', a, 'finished_1h', n3, 'gave_up_1h', max_conn,
      'by_workspace', coalesce((select jsonb_agg(jsonb_build_object('workspace', wn, 'finished', c, 'gave_up', g) order by g desc) from (select wk.name wn, count(*) c, count(*) filter (where gave_up) g from (select * from fin where updated_at > now() - interval '24 hours') f left join outreach_workspaces wk on wk.id = f.workspace_id group by 1 order by 3 desc limit 8) z), '[]'::jsonb),
      'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason', reason, 'count', c) order by c desc) from (select unnest(escalation_reasons) reason, count(*) c from fin where updated_at > now() - interval '24 hours' and gave_up group by 1 order by 2 desc limit 8) z), '[]'::jsonb),
      'by_prompt_version', coalesce((select jsonb_agg(jsonb_build_object('version', master_prompt_version, 'finished', c, 'gave_up', g) order by g desc) from (select master_prompt_version, count(*) c, count(*) filter (where gave_up) g from fin where updated_at > now() - interval '24 hours' group by 1 order by 3 desc limit 6) z), '[]'::jsonb)) into ev;
    summary := case when n < 20 then format('Only %s AI replies finished in the last 24 hours (the check needs 20).', n) else format('%s%% of %s finished replies were passed to a person or failed in the last 24 hours; the 7-day average is %s%%.', v, n, coalesce(a::text, '?')) end;
    perform ops.health_apply('ai-3.replies', st, v, summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('ai-3.replies', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-3.replies: ' || sqlerrm); perform ops.health_apply('ai-3.replies', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-3.website Website assistant stumped more than usual
  begin
    t_chk := clock_timestamp();
    select count(*) into n from outreach_ai_unanswered_questions where first_seen_at >= current_date;
    select round(count(*) / 7.0, 1) into a from outreach_ai_unanswered_questions where first_seen_at >= current_date - 7 and first_seen_at < current_date;
    st := case when n >= 10 and n >= 2 * greatest(a, 1) then 'watch' else 'ok' end;
    summary := case when n = 0 then 'No new unanswered question today.' else format('%s new unanswered %s today; the 7-day average is %s a day.', n, case when n = 1 then 'question' else 'questions' end, a) end;
    select coalesce(jsonb_agg(jsonb_build_object('workspace', wn, 'today', c) order by c desc), '[]'::jsonb) into ev from (select w.name wn, count(*) c from outreach_ai_unanswered_questions u left join outreach_workspaces w on w.id = u.workspace_id where u.first_seen_at >= current_date group by 1 order by 2 desc limit 8) z;
    perform ops.health_apply('ai-3.website', st, n, summary, jsonb_build_object('rows', ev, 'avg_7d', a));
    ran := ran + 1; tm := tm || jsonb_build_object('ai-3.website', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-3.website: ' || sqlerrm); perform ops.health_apply('ai-3.website', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ ai-4 Voice calls failing (platform account for the thresholds; own-key rows listed)
  begin
    t_chk := clock_timestamp();
    select count(*) filter (where account = 'platform'), count(*) filter (where account = 'platform' and (status = 'failed' or ended_reason = 'error')) into n, n2
    from outreach_webchat_voice_calls where started_at > now() - interval '1 hour' and not test;
    select count(*) into n3 from outreach_webchat_voice_calls where status in ('starting', 'in_progress') and started_at < now() - interval '30 minutes';
    select count(*) into max_conn from outreach_webchat_voice_agents where sync_error is not null and not archived and account = 'platform';
    v := case when n > 0 then round(100.0 * n2 / n, 1) else 0 end;
    st := case when n2 >= 10 and v >= 30 then 'act' when (n2 >= 3 and v >= 10) or n3 > 0 or max_conn > 0 then 'watch' else 'ok' end;
    select jsonb_build_object('calls_1h', n, 'failed_1h', n2, 'still_open', n3, 'sync_errors', max_conn,
      'by_workspace', coalesce((select jsonb_agg(jsonb_build_object('workspace', wn, 'calls', c, 'failed', f, 'account', acc) order by f desc) from (select w.name wn, h.account acc, count(*) c, count(*) filter (where h.status = 'failed' or h.ended_reason = 'error') f from outreach_webchat_voice_calls h left join outreach_workspaces w on w.id = h.workspace_id where h.started_at > now() - interval '1 hour' and not h.test group by 1, 2 order by 4 desc limit 8) z), '[]'::jsonb),
      'by_reason', coalesce((select jsonb_agg(jsonb_build_object('reason', rsn, 'count', c) order by c desc) from (select coalesce(ended_reason, status) rsn, count(*) c from outreach_webchat_voice_calls where started_at > now() - interval '1 hour' and not test and (status = 'failed' or ended_reason = 'error') group by 1 order by 2 desc limit 6) z), '[]'::jsonb),
      'open', coalesce((select jsonb_agg(jsonb_build_object('conversation_id', el_conversation_id, 'workspace', w.name, 'started_at', started_at, 'status', status) order by started_at) from (select * from outreach_webchat_voice_calls where status in ('starting', 'in_progress') and started_at < now() - interval '30 minutes' order by started_at limit 8) o left join outreach_workspaces w on w.id = o.workspace_id), '[]'::jsonb),
      'agents', coalesce((select jsonb_agg(jsonb_build_object('workspace', w.name, 'which', g.which, 'account', g.account, 'error', ops.scrub(g.sync_error), 'attempts', g.sync_attempts)) from (select * from outreach_webchat_voice_agents where sync_error is not null and not archived limit 8) g left join outreach_workspaces w on w.id = g.workspace_id), '[]'::jsonb),
      'tools_avg_ms', (select round(sum(total_ms) / greatest(1, sum(runs))) from ops.fn_stats where fn = 'outreach-voice-tools' and bucket > now() - interval '1 hour')) into ev;
    summary := case when n2 > 0 then format('%s of %s voice calls (%s%%) failed in the last hour.', n2, n, v) when n3 > 0 then format('%s %s still open 30 minutes after it started.', n3, case when n3 = 1 then 'call is' else 'calls are' end)
                    when max_conn > 0 then format('%s voice %s a sync error.', max_conn, case when max_conn = 1 then 'agent has' else 'agents have' end) else format('%s voice calls in the last hour, none failed.', n) end;
    perform ops.health_apply('ai-4', st, v, summary, ev);
    ran := ran + 1; tm := tm || jsonb_build_object('ai-4', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('ai-4: ' || sqlerrm); perform ops.health_apply('ai-4', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ app-1 Errors people see (last hour)
  begin
    t_chk := clock_timestamp();
    with e as (select fingerprint, max(message) message, max(route) route, count(distinct user_id) people, count(*) times, min(at) first_at, max(at) last_at, max(app_version) version from ops.client_errors where at > now() - interval '1 hour' group by 1),
    act as (select count(distinct user_id) cnt from (select user_id from ops.product_events where at > now() - interval '1 hour' union select user_id from ops.client_errors where at > now() - interval '1 hour') u where user_id is not null)
    select max(people), (select cnt from act), coalesce(jsonb_agg(jsonb_build_object('error', left(message, 160), 'screen', route, 'people', people, 'times', times, 'first_seen', first_at, 'last_seen', last_at, 'version', version) order by people desc, times desc), '[]'::jsonb),
           (select left(message, 100) from e order by people desc, times desc limit 1)
      into n, n2, ev, summary from (select * from e order by people desc, times desc limit 10) z;
    n := coalesce(n, 0);
    st := case when n >= 10 or (n2 >= 5 and n >= 0.2 * n2) then 'act' when n >= 3 then 'watch' else 'ok' end;
    summary := case when n = 0 then 'Nobody hit an error in the last hour.' else format('%s %s the same error in the last hour: "%s".', n, case when n = 1 then 'person hit' else 'people hit' end, coalesce(summary, '?')) end;
    perform ops.health_apply('app-1', st, n, summary, jsonb_build_object('rows', ev, 'active_people', n2));
    ran := ran + 1; tm := tm || jsonb_build_object('app-1', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('app-1: ' || sqlerrm); perform ops.health_apply('app-1', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ app-3 Stuck users (today)
  begin
    t_chk := clock_timestamp();
    select count(*), coalesce(jsonb_agg(jsonb_build_object('workspace', name, 'signals', signal_count) order by signal_count desc), '[]'::jsonb) into n, ev from (select * from ops.stuck_users() order by signal_count desc limit 10) z;
    st := ops.thr('app-3', n);
    summary := case when n = 0 then 'Nobody looks stuck today.' else format('%s %s stuck today.', n, case when n = 1 then 'workspace looks' else 'workspaces look' end) end;
    perform ops.health_apply('app-3', st, n, summary, jsonb_build_object('rows', ev));
    ran := ran + 1; tm := tm || jsonb_build_object('app-3', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('app-3: ' || sqlerrm); perform ops.health_apply('app-3', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ sys-2 Everything is being measured (24 h)
  begin
    t_chk := clock_timestamp();
    with cronfn as (select distinct ops.cron_job_fn(j.command) fn from cron.job j join ops.job_last_start l on l.jobid = j.jobid
                     where j.active and ops.cron_job_fn(j.command) is not null and ops.cron_interval_seconds(j.schedule) <= 86400 and l.last_start > now() - interval '24 hours'
                       and l.last_start > (select coalesce(min(bucket), now()) + interval '5 minutes' from ops.fn_stats)   -- the job ran since the wrapper has been live
                       -- a guarded job ("where exists") may start without calling its function: only count it when a run in the window did
                       and exists (select 1 from ops_recent_runs rr where rr.jobid = j.jobid and rr.status = 'succeeded' and coalesce(rr.return_message, '') not like '0 rows%')
                     union   -- functions the dispatcher (084) called in the window
                     select distinct i.fn from outreach_cron_invocations i
                      where i.at > now() - interval '24 hours' and i.at > (select coalesce(min(bucket), now()) + interval '5 minutes' from ops.fn_stats)),
    silent as (select fn from cronfn where not exists (select 1 from ops.fn_stats s where s.fn = cronfn.fn and s.bucket > now() - interval '24 hours')),
    aic as (select coalesce(sum(attempts), 0) cnt from outreach_ai_calls where at > now() - interval '24 hours' and at > (select coalesce(min(bucket), now()) from ops.api_stats)),
    aps as (select coalesce(sum(calls), 0) cnt from ops.api_stats where provider in ('ai', 'ai:own') and bucket > now() - interval '24 hours'),
    noout as (select count(*) cnt from outreach_ai_calls where at > now() - interval '24 hours' and outcome is null and at > (select coalesce(min(bucket), now()) from ops.api_stats))
    select (select coalesce(jsonb_agg(fn), '[]'::jsonb) from silent), (select cnt from aic), (select cnt from aps), (select cnt from noout) into ev, n, n2, n3;
    v := case when greatest(n, n2) = 0 then 0 else round(100.0 * abs(n - n2) / greatest(n, n2), 1) end;
    st := case when jsonb_array_length(ev) > 0 or v > 5 or n3 > 0 then 'watch' else 'ok' end;
    summary := case when jsonb_array_length(ev) > 0 then format('%s scheduled %s no record of its runs: %s.', jsonb_array_length(ev), case when jsonb_array_length(ev) = 1 then 'function has' else 'functions have' end, (select string_agg(x, ', ') from jsonb_array_elements_text(ev) x))
                    when v > 5 then format('The two counts of AI calls differ by %s%% (%s logged, %s measured).', v, n, n2)
                    when n3 > 0 then format('%s AI %s no outcome.', n3, case when n3 = 1 then 'call has' else 'calls have' end)
                    else 'Every scheduled function and every AI call is being measured.' end;
    perform ops.health_apply('sys-2', st, v, summary, jsonb_build_object('silent_functions', ev, 'ai_calls_logged', n, 'ai_calls_measured', n2, 'ai_calls_no_outcome', n3));
    ran := ran + 1; tm := tm || jsonb_build_object('sys-2', round(extract(epoch from clock_timestamp() - t_chk) * 1000));
  exception when others then errs := errs || ('sys-2: ' || sqlerrm); perform ops.health_apply('sys-2', 'unknown', null, 'Couldn''t check', null, sqlerrm); end;

  -- ============================================================ outside-source checks that stopped reporting go grey (D2)
  for r in select c.key, c.every_minutes, s.last_run_at from ops.health_checks c left join ops.health_state s on s.check_key = c.key where c.source <> 'sql' and c.enabled loop
    if r.last_run_at is null or r.last_run_at < now() - make_interval(mins => greatest(15, r.every_minutes * 3)) then
      perform ops.health_apply(r.key, 'unknown', null, 'The collector has not reported this check.', null, 'no result from the collector (health-collect / health-daily) in ' || greatest(15, r.every_minutes * 3) || ' minutes');
    end if;
  end loop;

  -- per-check time in ms (G16: when Health itself is among the top queries, this says which check)
  insert into ops.health_kv (key, value, at) values ('health_run', jsonb_build_object('ran', ran, 'errors', to_jsonb(errs), 'ms', tm), now())
  on conflict (key) do update set value = excluded.value, at = excluded.at;
  return jsonb_build_object('ran', ran, 'errors', to_jsonb(errs), 'ms', tm);
end $$;

-- A stub so health_run compiles before 082 defines the real stuck-users function (CREATE OR REPLACE keeps the signature).
create or replace function ops.stuck_users() returns table (workspace_id uuid, name text, signal_count int, signals jsonb, since timestamptz, route text)
language sql stable as $$ select null::uuid, null::text, 0, '[]'::jsonb, null::timestamptz, null::text where false $$;

-- For F50 health-ping: 'ok' when health_run ran in the last 15 minutes, else 'stale'.
create or replace function ops.health_ping() returns text language sql stable as $$
  select case when (select at from ops.health_kv where key = 'health_run') > now() - interval '15 minutes' then 'ok' else 'stale' end
$$;
create or replace function outreach_ops_health_ping() returns text
language sql stable security definer set search_path = ops, public, extensions as $$ select ops.health_ping() $$;
revoke all on function outreach_ops_health_ping() from public, anon, authenticated;
grant execute on function outreach_ops_health_ping() to service_role;

-- -----------------------------------------------------------------------------------------------------------------
-- Clean-up (the 04:00 cleanup job calls this; 083 schedules it)
-- -----------------------------------------------------------------------------------------------------------------
create or replace function ops.health_cleanup() returns jsonb language plpgsql as $$
declare a int; b int; c int; d int; e int; f int; g int; h int; i int;
begin
  delete from ops.health_results where at < now() - interval '14 days'; get diagnostics a = row_count;
  delete from ops.fn_stats where bucket < now() - interval '30 days'; get diagnostics b = row_count;
  delete from ops.fn_problems where at < now() - interval '14 days'; get diagnostics c = row_count;
  delete from ops.api_stats where bucket < now() - interval '30 days'; get diagnostics d = row_count;
  delete from ops.api_problems where at < now() - interval '14 days'; get diagnostics e = row_count;
  delete from ops.query_snapshots where at < now() - interval '7 days'; get diagnostics f = row_count;
  delete from ops.size_snapshots where day < current_date - 400; get diagnostics g = row_count;
  delete from ops.client_errors where at < now() - interval '30 days'; get diagnostics h = row_count;
  delete from ops.product_events where at < now() - interval '30 days'; get diagnostics i = row_count;
  -- PRD §10: nothing removed cron.job_run_details before; the 10- and 15-second jobs add about 40,000 rows a day
  delete from cron.job_run_details where end_time < now() - interval '7 days';
  return jsonb_build_object('health_results', a, 'fn_stats', b, 'fn_problems', c, 'api_stats', d, 'api_problems', e, 'query_snapshots', f, 'size_snapshots', g, 'client_errors', h, 'product_events', i);
end $$;

-- -----------------------------------------------------------------------------------------------------------------
-- Seed: the checks (PRD §4). Thresholds are rows, editable on the page (D5); the seed never overwrites an edit.
-- -----------------------------------------------------------------------------------------------------------------
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order) values
  ('db-1', 'database', 'Database size', 'Is the disk filling up?', '%', 70, 85, false, false, 'G4', 'sql', 5, 10),
  ('db-2', 'database', 'Connections in use', 'Is the database running out of room for new connections?', '%', 60, 80, false, false, 'G2', 'sql', 5, 11),
  ('db-3', 'database', 'Slow queries', 'Is a query taking the database''s time?', 'ms', 100, 1000, false, false, 'G3', 'sql', 5, 12),
  ('db-4', 'database', 'Stuck or blocked queries', 'Is something holding everything else up?', 'seconds', 30, 120, false, false, 'G5', 'sql', 5, 13),
  ('db-5', 'database', 'Fast-growing tables', 'Is a table growing faster than the business?', '%', 20, null, false, false, 'G4', 'sql', 5, 14),
  ('db-6', 'database', 'How busy the database is (CPU)', 'Is the database short of processing power?', '%', 70, 90, false, false, 'G1', 'metrics', 5, 15),
  ('db-7', 'database', 'Memory', 'Is the database short of memory?', '%', 80, 90, false, false, 'G1', 'metrics', 5, 16),
  ('db-8', 'database', 'Disk activity', 'Is the disk the bottleneck?', '%', 70, 90, false, false, 'G1', 'metrics', 5, 17),
  ('db-9', 'database', 'Supabase advisor findings', 'Has Supabase spotted a security or speed problem?', 'count', 1, 1, false, false, 'G6', 'advisors', 1440, 18),
  ('job-1', 'jobs', 'Jobs running on time', 'Did every scheduled job start when it should?', 'seconds', null, null, true, false, 'G7', 'sql', 5, 20),
  ('job-2', 'jobs', 'Jobs failing', 'Did a job end in an error?', 'count', 1, 3, false, false, 'G7', 'sql', 5, 21),
  ('job-3', 'jobs', 'Jobs finishing their work', 'Did the function behind each job finish?', 'count', 1, 5, false, false, 'G8', 'sql', 5, 22),
  ('job-4', 'jobs', 'Jobs piling up', 'Are too many jobs running at once, or too long?', 'count', 9, 24, false, false, 'G7', 'sql', 5, 23),
  ('job-5', 'jobs', 'Today''s plan', 'Does every healthy sender have a plan for today?', 'count', null, 1, false, false, 'G10', 'sql', 5, 24),
  ('fn-1', 'functions', 'A function is failing', 'Is any Edge Function erroring?', '%', 1, 1, false, false, 'G8', 'sql', 5, 30),
  ('fn-2', 'functions', 'A function is slow', 'Is a function taking longer than it should?', '%', 10, null, false, false, 'G8', 'sql', 5, 31),
  ('fn-3', 'functions', 'A function is close to its time limit', 'Will Supabase start stopping it?', '%', 50, 80, false, false, 'G8', 'sql', 5, 32),
  ('fn-4', 'functions', 'Functions stopped by Supabase', 'Did Supabase stop a function (codes 546, 504, 503)?', 'count', 1, 5, false, false, 'G8', 'logs_api', 5, 33),
  ('flow-1', 'flow', 'Incoming events waiting', 'Are replies and status changes being processed?', 'count', 100, 500, true, false, 'G9', 'sql', 5, 40),
  ('flow-2', 'flow', 'Queues backing up', 'Is a queue not being emptied?', 'minutes', 2, 10, false, false, 'G9', 'sql', 5, 41),
  ('flow-3', 'flow', 'Nothing arriving from the channel provider', 'Have webhooks stopped?', 'hours', 2, 6, false, false, 'G9', 'sql', 5, 42),
  ('flow-4', 'flow', 'Sends failing', 'Are messages and invites failing?', '%', 5, 15, true, false, 'G10', 'sql', 5, 43),
  ('flow-5', 'flow', 'Sends running late', 'Are due sends not going out?', 'count', 20, 200, false, false, 'G10', 'sql', 5, 44),
  ('flow-6', 'flow', 'Senders disconnected', 'Are accounts dropping off?', '%', null, 10, true, false, 'G11', 'sql', 5, 45),
  ('flow-7', 'flow', 'Webhook receiver failing', 'Is the function that takes the channel provider''s calls returning errors?', 'count', null, 1, true, false, 'G8', 'sql', 5, 46),
  ('api-5', 'services', 'AI spend', 'Is AI cost on track for the month?', '%', 80, 100, false, false, 'G15', 'sql', 5, 59),
  ('ai-1', 'ai', 'AI answers we can''t use', 'Is the AI answering with something broken?', '%', 2, 10, false, false, 'G17', 'sql', 5, 60),
  ('ai-2.replies', 'ai', 'AI replies waiting', 'Is a reply the AI should be writing stuck?', 'minutes', 5, 15, false, false, 'G18', 'sql', 5, 61),
  ('ai-2.lines', 'ai', 'Personalized lines waiting', 'Are leads waiting for a line nobody is writing?', 'minutes', 15, 60, false, false, 'G18', 'sql', 5, 62),
  ('ai-2.website', 'ai', 'Website visitors waiting', 'Is a visitor waiting for the assistant?', 'count', 3, 10, false, false, 'G18', 'sql', 5, 63),
  ('ai-3.replies', 'ai', 'AI giving up more than usual', 'Is the AI passing more conversations to people, or failing more?', '%', null, 50, false, false, 'G18', 'sql', 5, 64),
  ('ai-3.website', 'ai', 'Website assistant stumped more than usual', 'Are visitors asking things it can''t answer?', 'count', 10, null, false, false, 'G18', 'sql', 5, 65),
  ('ai-4', 'ai', 'Voice calls failing', 'Are voice calls failing to start, ending in an error, or never being closed?', '%', 10, 30, false, false, 'G19', 'sql', 5, 66),
  ('app-1', 'app', 'Errors people see', 'Are people hitting errors in the app?', 'count', 3, 10, false, false, 'G13', 'sql', 5, 70),
  ('app-2', 'app', 'Requests failing', 'Are requests to the backend failing (5xx)?', 'count', 5, 20, false, false, 'G13', 'logs_api', 5, 71),
  ('app-3', 'app', 'Stuck users', 'Is anyone stuck today?', 'count', 1, null, false, false, 'G14', 'sql', 5, 72),
  ('sys-2', 'system', 'Everything is being measured', 'Is any function or AI call skipping the measuring?', '%', 5, null, false, false, 'G16', 'sql', 5, 90)
on conflict (key) do nothing;

-- one set of provider checks each (§4.5). The AI provider's "calls failing" sends the urgent email (v1.1).
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order)
select 'api-1.' || p, 'services', ops.provider_label(p) || ': calls failing', 'Is the provider returning errors?', '%', 2, 5, false, p = 'ai', case when p = 'ai' then 'G17' else 'G12' end, 'sql', 5, 50 + i
from unnest(array['unipile', 'ai', 'resend', 'stripe', 'elevenlabs']) with ordinality as x(p, i) on conflict (key) do nothing;
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order)
select 'api-2.' || p, 'services', ops.provider_label(p) || ': being rate-limited', 'Is the provider telling us to slow down (429)?', 'count', 5, null, false, false, case when p = 'ai' then 'G17' else 'G12' end, 'sql', 5, 50 + i
from unnest(array['unipile', 'ai', 'resend', 'stripe', 'elevenlabs']) with ordinality as x(p, i) on conflict (key) do nothing;
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order)
select 'api-3.' || p, 'services', ops.provider_label(p) || ': key or billing problem', 'Has a key stopped working, or credit run out (401, 402, 403)?', 'count', null, 1, true, false, case when p = 'ai' then 'G17' else 'G12' end, 'sql', 5, 50 + i
from unnest(array['unipile', 'ai', 'resend', 'stripe', 'elevenlabs']) with ordinality as x(p, i) on conflict (key) do nothing;
insert into ops.health_checks (key, area, name, question, unit, watch_at, act_at, immediate, urgent, guide, source, every_minutes, sort_order)
select 'api-4.' || p, 'services', ops.provider_label(p) || ': slower than usual', 'Is the provider slow?', 'ms', null, null, false, false, case when p = 'ai' then 'G17' else 'G12' end, 'sql', 5, 50 + i
from unnest(array['unipile', 'ai', 'resend', 'stripe', 'elevenlabs']) with ordinality as x(p, i) on conflict (key) do nothing;

-- what "slow" means per function: the cron ones get their interval, the rest 5 s (PRD fn_config)
insert into ops.fn_config (fn, cron_job, slow_ms)
select ops.cron_job_fn(command), jobname, least(60000, greatest(5000, ops.cron_interval_seconds(schedule) * 1000)) from cron.job where ops.cron_job_fn(command) is not null
on conflict (fn) do nothing;
insert into ops.fn_config (fn, slow_ms) values ('outreach-unipile-webhook', 3000), ('outreach-webchat', 8000), ('outreach-voice-tools', 4000), ('outreach-imports-create', 20000) on conflict (fn) do nothing;

-- -----------------------------------------------------------------------------------------------------------------
-- Seed: limits (§7.1). Prices and quotas from Supabase's billing and compute docs, 7 Oct 2026.
-- -----------------------------------------------------------------------------------------------------------------
insert into ops.limits (key, grp, label, limit_value, unit, plan, note, source_url, checked_on, measured_by, sort_order) values
  ('db_disk', 'supabase', 'Database on disk', 500 * 1024.0^2, 'bytes', 'free', '500 MB on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 1),
  ('db_disk', 'supabase', 'Database on disk', 8 * 1024.0^3, 'bytes', 'pro', '8 GB included, then $0.125 per GB', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 1),
  ('egress', 'supabase', 'Egress a month', 5 * 1024.0^3, 'bytes', 'free', '5 GB on Free', 'https://supabase.com/docs/guides/platform/manage-your-usage/egress', '2026-10-07', 'manual', 2),
  ('egress', 'supabase', 'Egress a month', 250 * 1024.0^3, 'bytes', 'pro', '250 GB included, then $0.09 per GB', 'https://supabase.com/docs/guides/platform/manage-your-usage/egress', '2026-10-07', 'manual', 2),
  ('fn_invocations', 'supabase', 'Edge Function invocations a month', 500000, 'count', 'free', '500,000 on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 3),
  ('fn_invocations', 'supabase', 'Edge Function invocations a month', 2000000, 'count', 'pro', '2 million included, then $2 per million', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 3),
  ('realtime_peak', 'supabase', 'Realtime peak connections', 200, 'count', 'free', '200 on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'manual', 4),
  ('realtime_peak', 'supabase', 'Realtime peak connections', 500, 'count', 'pro', '500 included, then $10 per 1,000', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'manual', 4),
  ('realtime_messages', 'supabase', 'Realtime messages a month', 2000000, 'count', 'free', '2 million on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'manual', 5),
  ('realtime_messages', 'supabase', 'Realtime messages a month', 5000000, 'count', 'pro', '5 million included, then $2.50 per million', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'manual', 5),
  ('storage', 'supabase', 'File storage', 1 * 1024.0^3, 'bytes', 'free', '1 GB on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 6),
  ('storage', 'supabase', 'File storage', 100 * 1024.0^3, 'bytes', 'pro', '100 GB included, then $0.021 per GB', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 6),
  ('mau', 'supabase', 'Monthly active users', 50000, 'count', 'free', '50,000 on Free', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 7),
  ('mau', 'supabase', 'Monthly active users', 100000, 'count', 'pro', '100,000 included', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'sql', 7),
  ('log_history', 'supabase', 'Log history', 1, 'days', 'free', '1 day', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'fixed', 8),
  ('log_history', 'supabase', 'Log history', 7, 'days', 'pro', '7 days', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'fixed', 8),
  ('pause_idle', 'supabase', 'Project paused when idle', 7, 'days', 'free', 'After 1 week', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'fixed', 9),
  ('pause_idle', 'supabase', 'Project paused when idle', null, 'days', 'pro', 'Never', 'https://supabase.com/docs/guides/platform/billing-on-supabase', '2026-10-07', 'fixed', 9),
  ('fn_wall_clock_ms', 'functions', 'Total time a run may take', 150000, 'ms', 'free', '150 s on Free', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'sql', 20),
  ('fn_wall_clock_ms', 'functions', 'Total time a run may take', 400000, 'ms', 'pro', '400 s on paid plans', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'sql', 20),
  ('fn_memory_mb', 'functions', 'Memory', 256, 'MB', 'any', '256 MB', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'fixed', 21),
  ('fn_cpu_ms', 'functions', 'Processing time (CPU) per request', 2000, 'ms', 'any', '2 s', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'fixed', 22),
  ('fn_response_ms', 'functions', 'Time to send a response', 150000, 'ms', 'any', '150 s', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'fixed', 23),
  ('fn_count', 'functions', 'Number of functions', 100, 'count', 'free', '100 on Free', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'sql', 24),
  ('fn_count', 'functions', 'Number of functions', 1000, 'count', 'pro', '1,000 on Pro', 'https://supabase.com/docs/guides/functions/limits', '2026-10-07', 'sql', 24),
  ('fn_log_line', 'functions', 'Log line', 10000, 'chars', 'any', '10,000 characters; 100 log events per 10 s per function', 'https://supabase.com/docs/guides/functions/logging', '2026-10-07', 'fixed', 25),
  ('disk_iops', 'compute', 'Disk IOPS (baseline, gp3)', 3000, 'iops', 'any', 'Baseline IOPS for Micro to Large on gp3; larger sizes differ', 'https://supabase.com/docs/guides/platform/compute-and-disk', '2026-10-07', 'metrics', 49),
  ('cron_concurrent', 'cron', 'Scheduled jobs running at once', 32, 'count', 'any', '32 (hard). Supabase recommends 8 or fewer', 'https://supabase.com/docs/guides/cron', '2026-10-07', 'sql', 30),
  ('cron_run_minutes', 'cron', 'Length of one scheduled run', 10, 'minutes', 'any', 'Supabase recommends 10 minutes or less', 'https://supabase.com/docs/guides/cron', '2026-10-07', 'sql', 31),
  ('li_invites_day', 'linkedin', 'Invitations a day, per account', 100, 'count', 'any', '80–100 a day, about 200 a week', 'https://developer.unipile.com/docs/linkedin-limits', '2026-10-07', 'sql', 40),
  ('li_views_day', 'linkedin', 'Profile views a day, per account', 100, 'count', 'any', 'About 100 a day', 'https://developer.unipile.com/docs/linkedin-limits', '2026-10-07', 'sql', 41),
  ('li_messages_day', 'linkedin', 'Messages a day, per account', 100, 'count', 'any', '100 a day or fewer', 'https://developer.unipile.com/docs/linkedin-limits', '2026-10-07', 'sql', 42),
  ('compute_micro', 'compute', 'Micro: about $10 a month, 1 GB memory', 60, 'connections', 'any', '60 direct connections, 200 pooler', 'https://supabase.com/docs/guides/platform/compute-and-disk', '2026-10-07', 'fixed', 50),
  ('compute_small', 'compute', 'Small: about $15 a month, 2 GB memory', 90, 'connections', 'any', '90 direct connections, 400 pooler', 'https://supabase.com/docs/guides/platform/compute-and-disk', '2026-10-07', 'fixed', 51),
  ('compute_medium', 'compute', 'Medium: about $60 a month, 4 GB memory', 120, 'connections', 'any', '120 direct connections, 600 pooler', 'https://supabase.com/docs/guides/platform/compute-and-disk', '2026-10-07', 'fixed', 52),
  ('compute_large', 'compute', 'Large: about $110 a month, 8 GB memory, 2 dedicated CPUs', 160, 'connections', 'any', '160 direct connections, 800 pooler', 'https://supabase.com/docs/guides/platform/compute-and-disk', '2026-10-07', 'fixed', 53)
on conflict (key, plan) do nothing;
