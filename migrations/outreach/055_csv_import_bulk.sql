-- 055_csv_import_bulk.sql — CSV imports write their rows in batches.
-- Requires 002 (outreach_upsert_lead) and 015 (outreach_update_lead_fields). Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/055_csv_import_bulk.sql
--
-- Why: the import worker made one database call per CSV row. An edge function gets about two seconds of CPU per call, and a call per
-- row uses that up after roughly 4,400 rows: the worker was stopped (WORKER_RESOURCE_LIMIT) in the middle of a 10,000-row file.
-- These two functions take a batch of rows in one call and run the existing single-row function for each, so the rules for
-- matching, merging and identities stay in exactly one place.
--
--   outreach_csv_upsert_rows(ws, job, leads)          → [{id, created} | {error}]   one entry per lead, same order
--   outreach_csv_update_rows(ws, rows, allowed)       → [true | false | {error}]    rows = [{match, fields}], true = a lead was found
--
-- A row that fails (a phone without a country code, …) fails alone: its entry carries the error and the rest of the batch is written.
-- Service role only: the worker is the one caller. Naming: outreach_csv_* — outside the prefixes the 037/042 grant loops revoke.
--
-- Also here: the two email lookups of outreach_upsert_lead / outreach_update_lead_fields get an index. The only email index was
-- outreach_leads_ws_email, which covers leads WITHOUT a LinkedIn id, so "is this email already a lead?" read every lead of the
-- workspace for every new row: a 10,000-row import slowed down the further it got.
--
-- Measured on the live project, 2026-10-01, synthetic files in a throwaway workspace:
--   one call per row (before)             10,000 rows: worker stopped at 4,400 rows (WORKER_RESOURCE_LIMIT)
--   batches, no email index               10,000 rows: 61 s, 2 worker calls
--   batches + email indexes               25,000 rows: 74 s, 5 worker calls (about 340 rows a second, steady)
-- 25,000 rows is the limit of one import (CSV_MAX_ROWS in the worker and on the upload screen).

create index if not exists outreach_leads_ws_email_work_idx on outreach_leads (workspace_id, email_work) where email_work is not null;
create index if not exists outreach_leads_ws_email_personal_idx on outreach_leads (workspace_id, email_personal) where email_personal is not null;

create or replace function outreach_csv_upsert_rows(p_ws uuid, p_job uuid, p_leads jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare it jsonb; r record; res jsonb[] := '{}';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN: service only'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_leads, '[]'::jsonb)) loop
    begin
      select u.id, u.created into r from outreach_upsert_lead(p_ws, it, 'csv', p_job) u;
      res := res || jsonb_build_object('id', r.id, 'created', r.created);
    exception when others then
      res := res || jsonb_build_object('error', left(sqlerrm, 160));
    end;
  end loop;
  return to_jsonb(res);
end $$;

create or replace function outreach_csv_update_rows(p_ws uuid, p_rows jsonb, p_allowed text[]) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare it jsonb; ok boolean; res jsonb[] := '{}';
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN: service only'; end if;
  for it in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    begin
      ok := outreach_update_lead_fields(p_ws, coalesce(it->'match', '{}'::jsonb), coalesce(it->'fields', '{}'::jsonb), p_allowed);
      res := res || to_jsonb(ok);
    exception when others then
      res := res || jsonb_build_object('error', left(sqlerrm, 160));
    end;
  end loop;
  return to_jsonb(res);
end $$;

revoke all on function outreach_csv_upsert_rows(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function outreach_csv_update_rows(uuid, jsonb, text[]) from public, anon, authenticated;
grant execute on function outreach_csv_upsert_rows(uuid, uuid, jsonb) to service_role;
grant execute on function outreach_csv_update_rows(uuid, jsonb, text[]) to service_role;
