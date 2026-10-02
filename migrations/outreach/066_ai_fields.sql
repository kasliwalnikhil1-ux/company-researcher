-- 066_ai_fields.sql — AI fields: one AI call per lead returns several typed fields (ai-fields-json-changes.md, Part A;
-- as built: docs/outreach/AI-FIELDS.md). The PRD calls this file 065; 065 was taken by 065_webchat_video_languages.sql.
-- Requires 001–065. Idempotent. Additive: every existing variable stays output = 'text' and renders as before.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/066_ai_fields.sql
--
--   1. Schema      outreach_ai_variables.output ('text' | 'fields') + fields (the field list); outreach_ai_values.data
--                  (the typed object). A Fields value ALSO keeps a readable summary in `text`, so everything 063 built on
--                  `text` (Needs you, Activity, "is there anything to approve", blank / failed) works unchanged.
--   2. Functions   shape check, coercion, summary; the worker's result path; the user's typed edit.
--   3. Patches     existing functions changed in place (pg_get_functiondef + replace, like 063). Every anchor is
--                  asserted: a missing anchor aborts the migration.
--   4. Guard       a field that a sequence uses cannot be removed or change type; the output of a variable is fixed.
--
-- Names: the helpers a CHECK constraint or a user calls are outreach_hub_* on purpose. The grant loops of 037/042 revoke
-- `authenticated` from every outreach_ai_* function that is not in their lists, and a check constraint runs its function
-- as the user who writes the row.

-- ===============================================================================================================
-- 0. In-place patch helpers (dropped at the end of this file)
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
    if position(p_pairs[i] in def) = 0 then raise exception '066: % anchor not found: %', p_fn, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '066: % marker missing after the patch: %', p_fn, p_marker; end if;
  execute def;
  return true;
end $$;
revoke all on function outreach_hub__patch(text, text, text[]) from public, anon, authenticated;

-- The same for a security_invoker view (create or replace keeps its grants; the column list does not change).
create or replace function outreach_hub__patch_view(p_view text, p_marker text, p_pairs text[]) returns boolean
language plpgsql set search_path = public, extensions as $$
declare def text; i int := 1;
begin
  def := pg_get_viewdef(p_view::regclass, true);
  if position(p_marker in def) > 0 then return false; end if;
  while i < coalesce(array_length(p_pairs, 1), 0) loop
    if position(p_pairs[i] in def) = 0 then raise exception '066: view % anchor not found: %', p_view, left(p_pairs[i], 120); end if;
    def := replace(def, p_pairs[i], p_pairs[i + 1]);
    i := i + 2;
  end loop;
  if position(p_marker in def) = 0 then raise exception '066: view % marker missing after the patch: %', p_view, p_marker; end if;
  execute format('create or replace view %I with (security_invoker = true) as %s', p_view, def);
  return true;
end $$;
revoke all on function outreach_hub__patch_view(text, text, text[]) from public, anon, authenticated;

-- ===============================================================================================================
-- 1. Schema
-- ===============================================================================================================
alter table outreach_ai_variables add column if not exists output text not null default 'text';
alter table outreach_ai_variables add column if not exists fields jsonb not null default '[]';
comment on column outreach_ai_variables.output is 'text = one line per lead ({{ai.<key>}}); fields = several typed fields from one AI call ({{ai.<key>.<field>}}). Fixed once the variable exists.';
comment on column outreach_ai_variables.fields is 'Fields variables only: [{key, name, type: text | number | yes_no | choice, description, max_chars (text), options (choice)}], 1 to 8 entries.';

-- Shape check of a field list, used by the constraint below. False (never an error) for anything malformed.
create or replace function outreach_hub_fields_valid(p jsonb) returns boolean
language plpgsql immutable set search_path = public, extensions as $$
declare f jsonb; n int; mc text; opt jsonb; seen text[] := '{}'; opts text[]; o text;
begin
  if p is null or jsonb_typeof(p) <> 'array' then return false; end if;
  n := jsonb_array_length(p);
  if n not between 1 and 8 then return false; end if;
  for f in select x from jsonb_array_elements(p) x loop
    if jsonb_typeof(f) <> 'object' then return false; end if;
    if coalesce(f->>'key', '') !~ '^[a-z][a-z0-9_]{1,29}$' or (f->>'key') = any(seen) then return false; end if;
    seen := array_append(seen, f->>'key');
    if length(btrim(coalesce(f->>'name', ''))) not between 1 and 40 then return false; end if;
    if length(coalesce(f->>'description', '')) > 300 then return false; end if;
    if coalesce(f->>'type', '') not in ('text', 'number', 'yes_no', 'choice') then return false; end if;
    if f->>'type' = 'text' and f ? 'max_chars' and jsonb_typeof(f->'max_chars') <> 'null' then
      mc := f->>'max_chars';
      if mc !~ '^[0-9]{1,4}$' or mc::int not between 20 and 1000 then return false; end if;
    end if;
    if f->>'type' = 'choice' then
      if jsonb_typeof(f->'options') is distinct from 'array' or jsonb_array_length(f->'options') not between 2 and 12 then return false; end if;
      opts := '{}';
      for opt in select x from jsonb_array_elements(f->'options') x loop
        if jsonb_typeof(opt) <> 'string' then return false; end if;
        o := lower(btrim(opt #>> '{}'));
        if length(o) not between 1 and 40 or o = any(opts) or o ~ '[{}|]' then return false; end if;
        opts := array_append(opts, o);
      end loop;
    end if;
  end loop;
  return true;
end $$;

do $$ begin
  alter table outreach_ai_variables add constraint outreach_ai_variables_output_chk
    check ((output = 'text' and fields = '[]'::jsonb) or (output = 'fields' and outreach_hub_fields_valid(fields)));
exception when duplicate_object then null; end $$;

alter table outreach_ai_values add column if not exists data jsonb;   -- Fields variables only; `text` keeps the summary
comment on column outreach_ai_values.data is 'Fields variables: the typed object {<field key>: text | number | boolean | null}. `text` holds its readable summary.';

-- ===============================================================================================================
-- 2. Functions
-- ===============================================================================================================
-- Coerce AI or human input to the declared fields. Keys that are not declared are dropped.
--   p_strict = false (AI output): a value that does not fit its type becomes null.
--   p_strict = true  (a person's edit): a value that does not fit raises E_PAYLOAD_INVALID naming the field.
create or replace function outreach_hub_fields_clean(p_fields jsonb, p_data jsonb, p_strict boolean default false) returns jsonb
language plpgsql immutable set search_path = public, extensions as $$
declare f jsonb; k text; t text; s text; o text; lim int; ok boolean; res jsonb := '{}'::jsonb; jt text;
begin
  for f in select x from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) x loop
    k := f->>'key'; t := f->>'type'; ok := true;
    jt := case when p_data is null or jsonb_typeof(p_data) <> 'object' then null else jsonb_typeof(p_data->k) end;
    s := case when jt in ('string', 'number', 'boolean') then btrim(regexp_replace(p_data->>k, '\s+', ' ', 'g')) else '' end;
    if jt is null or jt = 'null' or (jt = 'string' and (s = '' or lower(s) in ('null', 'none', 'n/a'))) then
      res := res || jsonb_build_object(k, null);
      continue;
    end if;
    if jt in ('object', 'array') then ok := false;                         -- nested values are not a field
    elsif t = 'text' then
      lim := coalesce(nullif(f->>'max_chars', '')::int, 200) * 2;          -- same slack as editing a line
      if s ~ '\{\{|\}\}' then ok := false;                                  -- a leftover placeholder is not a value
      elsif length(s) > lim then
        if p_strict then raise exception 'E_PAYLOAD_INVALID: "%" is longer than % characters', f->>'name', lim; end if;
        s := left(s, lim);
      end if;
      if ok then res := res || jsonb_build_object(k, s); end if;
    elsif t = 'number' then
      s := replace(s, ',', '');
      if s ~ '^-?[0-9]{1,15}(\.[0-9]{1,6})?$' then res := res || jsonb_build_object(k, s::numeric); else ok := false; end if;
    elsif t = 'yes_no' then
      if lower(s) in ('true', 'yes', 'y') then res := res || jsonb_build_object(k, true);
      elsif lower(s) in ('false', 'no', 'n') then res := res || jsonb_build_object(k, false);
      else ok := false; end if;
    elsif t = 'choice' then
      o := null;
      select x into o from jsonb_array_elements_text(f->'options') x where lower(btrim(x)) = lower(s) limit 1;
      if o is null then ok := false; else res := res || jsonb_build_object(k, o); end if;
    else ok := false;
    end if;
    if not ok then
      if p_strict then
        raise exception 'E_PAYLOAD_INVALID: "%" is not a valid %', f->>'name',
          case t when 'yes_no' then 'yes/no' when 'choice' then 'choice (' || (select string_agg(x, ', ') from jsonb_array_elements_text(f->'options') x) || ')' else t end;
      end if;
      res := res || jsonb_build_object(k, null);
    end if;
  end loop;
  return res;
end $$;

-- The readable line kept in outreach_ai_values.text, in the order of the field list:
-- "ICP fit: high · Pain: scaling outbound · Hiring sales: Yes · Team size: 40". Null when every field is empty (→ blank).
create or replace function outreach_hub_fields_summary(p_fields jsonb, p_data jsonb) returns text
language sql immutable set search_path = public, extensions as $$
  select nullif(string_agg((t.f->>'name') || ': ' ||
           case jsonb_typeof(p_data->(t.f->>'key')) when 'boolean' then case when (p_data->>(t.f->>'key'))::boolean then 'Yes' else 'No' end
                else p_data->>(t.f->>'key') end, ' · ' order by t.o), '')
    from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) with ordinality t(f, o)
   where p_data is not null and jsonb_typeof(p_data) = 'object' and coalesce(jsonb_typeof(p_data->(t.f->>'key')), 'null') <> 'null'
$$;

-- Service: store an AI result for a Fields variable, then go through the existing result path (status, batch, release).
create or replace function outreach_ai_value_result_fields(p_id uuid, p_data jsonb, p_facts jsonb, p_model text, p_error text default null) returns void
language plpgsql security definer set search_path = public, extensions as $$
declare flds jsonb; clean jsonb;
begin
  if not outreach_is_service() then raise exception 'E_FORBIDDEN'; end if;
  select av.fields into flds from outreach_ai_values x join outreach_ai_variables av on av.id = x.variable_id
   where x.id = p_id and x.status = 'pending' and av.output = 'fields';
  if not found then return; end if;
  clean := case when p_error is null then outreach_hub_fields_clean(flds, p_data, false) end;
  update outreach_ai_values set data = clean where id = p_id and status = 'pending';
  perform outreach_ai_value_result(p_id, outreach_hub_fields_summary(flds, clean), p_facts, p_model, p_error);
end $$;

-- User: edit the fields of one value (= approve with these values, like editing a line).
create or replace function outreach_hub_line_fields_edit(p_value uuid, p_data jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare x outreach_ai_values%rowtype; av outreach_ai_variables%rowtype; clean jsonb; summary text;
begin
  select * into x from outreach_ai_values where id = p_value for update;
  if not found then raise exception 'E_NOT_FOUND'; end if;
  select * into av from outreach_ai_variables where id = x.variable_id;
  perform outreach_require(x.workspace_id, 'member');
  if not outreach_client_visible(x.workspace_id, (select ld_.client_id from outreach_leads ld_ where ld_.id = x.lead_id)) then raise exception 'E_FORBIDDEN: client not visible'; end if;
  if av.output <> 'fields' then raise exception 'E_PAYLOAD_INVALID: this variable writes one line; edit it with ai_review(edit)'; end if;
  if p_data is null or jsonb_typeof(p_data) <> 'object' then raise exception 'E_PAYLOAD_INVALID: data is an object of field values'; end if;
  clean := outreach_hub_fields_clean(av.fields, p_data, true);
  summary := outreach_hub_fields_summary(av.fields, clean);
  if summary is null then raise exception 'E_PAYLOAD_INVALID: fill at least one field, or skip this lead'; end if;
  update outreach_ai_values set data = clean, text = summary, edited = true, status = 'approved', error = null, locked_at = null,
         approved_by = auth.uid(), approved_at = now(), updated_at = now() where id = p_value;
  if x.batch_id is not null then
    update outreach_ai_batches set status = 'done' where id = x.batch_id and status = 'review'
       and not exists (select 1 from outreach_ai_values y where y.batch_id = x.batch_id and y.status in ('generated', 'pending'));
  end if;
  perform outreach_release_waiting(x.lead_id, 'ai_review');
  return jsonb_build_object('updated', 1, 'data', clean, 'text', summary);
end $$;

-- ===============================================================================================================
-- 3. Patches to existing functions (in place)
-- ===============================================================================================================
-- ---- {{ai.<key>}} of a Fields variable is its object; a one-line variable stays text. Approved values only, as before.
select outreach_hub__patch('public.outreach_render_context(uuid,uuid,uuid)', $m$v.output = 'fields'$m$, array[
  $a$jsonb_object_agg(v.key, x.text)$a$,
  $b$jsonb_object_agg(v.key, case when v.output = 'fields' then coalesce(x.data, '{}'::jsonb) else to_jsonb(x.text) end)$b$]);

-- ---- Condition step: `ai.<key>.<field>` reads one field of the APPROVED value; `ai.<key>` is the line (or the summary of
-- a Fields value), for "has a value" / "is empty". No approved value → empty: every rule is false except "is empty".
select outreach_hub__patch('public.outreach_eval_rule(jsonb,outreach_leads,outreach_lead_sender_state,outreach_senders)', $m$f like 'ai.%'$m$, array[
  $a$  else actual := null; end if;$a$,
  $b$  elsif f like 'ai.%' then
    select case when av.output = 'fields' then case when split_part(f, '.', 3) <> '' then x.data ->> split_part(f, '.', 3) else x.text end
                else case when split_part(f, '.', 3) = '' then x.text end end
      into actual
      from outreach_ai_values x join outreach_ai_variables av on av.id = x.variable_id
     where x.lead_id = p_lead.id and av.workspace_id = p_lead.workspace_id
       and av.key = split_part(f, '.', 2) and x.status = 'approved';
  else actual := null; end if;$b$]);

-- ---- Review: regenerate clears the typed value too; a Fields value is edited field by field, not as one text.
select outreach_hub__patch('public.outreach_ai_review(uuid[],text,text)', 'var_output', array[
  $a$var.max_chars, var.mode as var_mode from outreach_ai_values v$a$,
  $b$var.max_chars, var.mode as var_mode, var.output as var_output from outreach_ai_values v$b$,
  $a$      lim := greatest(x.max_chars, 20) * 2;$a$,
  $b$      if x.var_output = 'fields' then raise exception 'E_PAYLOAD_INVALID: this variable writes fields; edit the fields with outreach_hub_line_fields_edit'; end if;
      lim := greatest(x.max_chars, 20) * 2;$b$,
  $a$update outreach_ai_values set status = 'pending', attempts = 0, text = null, facts = '[]'$a$,
  $b$update outreach_ai_values set status = 'pending', attempts = 0, text = null, data = null, facts = '[]'$b$]);

select outreach_hub__patch('public.outreach_ai_generate_request(uuid,uuid,uuid[],uuid,boolean)', 'data = null', array[
  $a$status = 'pending', attempts = 0, text = null, facts = '[]'$a$,
  $b$status = 'pending', attempts = 0, text = null, data = null, facts = '[]'$b$]);

-- ---- Which AI variables does a graph use? Now also the ones a Condition step reads ("field": "ai.<key>…") and the ones
-- inside {{#if ai.<key>…}}, so the lead's value is created and waited for exactly like a message variable.
create or replace function outreach_sequence_ai_keys(p_graph jsonb) returns text[]
language sql immutable set search_path = public, extensions as $$
  select coalesce(array_agg(distinct t.k), '{}') from (
    select m[1] as k from regexp_matches(coalesce(p_graph::text, ''), '\{\{\s*#?(?:if\s+)?ai\.([a-z][a-z0-9_]*)', 'g') m
    union
    select m[1] from regexp_matches(coalesce(p_graph::text, ''), '"field"\s*:\s*"ai\.([a-z][a-z0-9_]*)', 'g') m
  ) t
$$;

-- ---- Needs you: the Line card of a Fields value shows the fields as a table and edits them one by one.
select outreach_hub__patch_view('outreach_ai_needs_you', $m$'data', v.data$m$, array[
  $a$'edited', v.edited) AS meta$a$,
  $b$'edited', v.edited, 'output', av.output, 'fields', av.fields, 'data', v.data) AS meta$b$]);

-- ---- Setup: the variable list says which variables write fields.
select outreach_hub__patch('public.outreach_hub_setup(uuid)', $m$'output', v.output$m$, array[
  $a$'mode', v.mode, 'needs_posts', v.needs_posts,$a$,
  $b$'mode', v.mode, 'needs_posts', v.needs_posts, 'output', v.output,$b$]);

-- ===============================================================================================================
-- 4. Guard: the output of a variable is fixed; a field in use cannot be removed or change type
-- ===============================================================================================================
-- "In use" = named as ai.<key>.<field> in a sequence's live graph or draft (archived sequences aside), or in a version
-- that leads are still running on. Adding a field is always allowed.
create or replace function outreach_hub_trg_fields_guard() returns trigger
language plpgsql security definer set search_path = public, extensions as $$
declare f jsonb; pat text; used text;
begin
  if new.output is distinct from old.output then
    raise exception 'E_PAYLOAD_INVALID: the output of a variable cannot change; create a new variable';
  end if;
  if old.output = 'fields' and new.fields is distinct from old.fields then
    for f in select x from jsonb_array_elements(old.fields) x loop
      -- removed, or type changed?
      if not exists (select 1 from jsonb_array_elements(new.fields) n where n->>'key' = f->>'key' and n->>'type' = f->>'type') then
        pat := 'ai\.' || old.key || '\.' || (f->>'key') || '([^a-z0-9_]|$)';
        select string_agg(q.name, ', ' order by q.name) into used from (
          select distinct s.name from outreach_sequences s
           where s.workspace_id = old.workspace_id
             and ((s.status <> 'archived' and (s.graph::text ~ pat or coalesce(s.draft_graph::text, '') ~ pat))
                  or exists (select 1 from outreach_sequence_versions v
                              where v.sequence_id = s.id and v.graph::text ~ pat
                                and exists (select 1 from outreach_enrollments e
                                             where e.sequence_id = s.id and e.status in ('active', 'waiting_connection', 'waiting_delay', 'waiting_task', 'paused')
                                               and coalesce(e.pinned_version, s.head_version) = v.version)))) q;
        if used is not null then
          raise exception 'E_AI_FIELD_IN_USE: "%" is used in: %. Remove it from those sequences first', f->>'name', used;
        end if;
      end if;
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists outreach_hub_fields_guard on outreach_ai_variables;
create trigger outreach_hub_fields_guard before update of output, fields on outreach_ai_variables
  for each row execute function outreach_hub_trg_fields_guard();

-- ===============================================================================================================
-- 5. Grants
-- ===============================================================================================================
revoke all on function outreach_hub_line_fields_edit(uuid, jsonb) from public, anon;
grant execute on function outreach_hub_line_fields_edit(uuid, jsonb) to authenticated, service_role;
revoke all on function outreach_ai_value_result_fields(uuid, jsonb, jsonb, text, text) from public, anon, authenticated;
grant execute on function outreach_ai_value_result_fields(uuid, jsonb, jsonb, text, text) to service_role;
revoke all on function outreach_hub_trg_fields_guard() from public, anon, authenticated;
-- pure helpers: the check constraint runs outreach_hub_fields_valid as the user who saves a variable
revoke all on function outreach_hub_fields_valid(jsonb), outreach_hub_fields_clean(jsonb, jsonb, boolean), outreach_hub_fields_summary(jsonb, jsonb) from public, anon;
grant execute on function outreach_hub_fields_valid(jsonb), outreach_hub_fields_clean(jsonb, jsonb, boolean), outreach_hub_fields_summary(jsonb, jsonb) to authenticated, service_role;

drop function if exists outreach_hub__patch(text, text, text[]);
drop function if exists outreach_hub__patch_view(text, text, text[]);
