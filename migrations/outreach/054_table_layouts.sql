-- 054_table_layouts.sql — Saved table layouts (column order + widths) and the custom-field columns of the leads table.
-- Requires 001–003. Idempotent. Apply with: bash scripts/outreach-sql.sh migrations/outreach/054_table_layouts.sql
--
--   1. outreach_table_layouts: one row per person, workspace and table. The leads table stores { order: [column id…], widths: { id: px } }
--      here every time a header is dragged, so the same layout comes back on every device. A layout is personal: one teammate
--      rearranging columns does not move them for everybody else.
--   2. outreach_lead_custom_keys: the custom-field names used by leads in a workspace, most used first. Each one is a column.
--
-- Naming: outreach_table_layout_* / outreach_lead_custom_* — outside the prefixes the 037/042 grant loops revoke.

create table if not exists outreach_table_layouts (
  user_id      uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references outreach_workspaces(id) on delete cascade,
  table_key    text not null,
  layout       jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (user_id, workspace_id, table_key)
);

alter table outreach_table_layouts enable row level security;
select outreach__policy('outreach_table_layouts', 'table_layouts_select', 'select', 'user_id = auth.uid()');

-- ----------------------------------------------------------------------------- layouts
create or replace function outreach_table_layout_get(p_ws uuid, p_table text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  return (select t.layout from outreach_table_layouts t where t.workspace_id = p_ws and t.user_id = auth.uid() and t.table_key = p_table);
end $$;

-- Null or {} clears the saved layout (back to the default order and widths).
create or replace function outreach_table_layout_set(p_ws uuid, p_table text, p_layout jsonb) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
begin
  perform outreach_require(p_ws, 'client_viewer');
  if p_table is null or p_table !~ '^[a-z][a-z0-9_]{0,39}$' then raise exception 'E_PAYLOAD_INVALID: table'; end if;
  if p_layout is null or p_layout = '{}'::jsonb then
    delete from outreach_table_layouts where workspace_id = p_ws and user_id = auth.uid() and table_key = p_table;
    return null;
  end if;
  if jsonb_typeof(p_layout) <> 'object' or length(p_layout::text) > 20000 then raise exception 'E_PAYLOAD_INVALID: layout'; end if;
  insert into outreach_table_layouts(user_id, workspace_id, table_key, layout)
  values (auth.uid(), p_ws, p_table, p_layout)
  on conflict (user_id, workspace_id, table_key) do update set layout = excluded.layout, updated_at = now();
  return p_layout;
end $$;

-- ----------------------------------------------------------------------------- custom-field columns
-- Runs with the caller's rights: row security on outreach_leads decides which leads are counted, so a member scoped to
-- some clients only sees the field names of those clients' leads.
create or replace function outreach_lead_custom_keys(p_ws uuid) returns text[]
language sql stable set search_path = public, extensions as $$
  select coalesce(array_agg(s.k order by s.n desc, s.k), '{}'::text[])
    from (select k, count(*) as n
            from outreach_leads l
           cross join lateral jsonb_object_keys(case when jsonb_typeof(l.custom) = 'object' then l.custom else '{}'::jsonb end) as k
           where l.workspace_id = p_ws and l.custom <> '{}'::jsonb
           group by k order by count(*) desc, k limit 40) s;
$$;

-- ----------------------------------------------------------------------------- grants
revoke execute on function outreach_table_layout_get(uuid, text) from public, anon;
revoke execute on function outreach_table_layout_set(uuid, text, jsonb) from public, anon;
revoke execute on function outreach_lead_custom_keys(uuid) from public, anon;
grant execute on function outreach_table_layout_get(uuid, text) to authenticated, service_role;
grant execute on function outreach_table_layout_set(uuid, text, jsonb) to authenticated, service_role;
grant execute on function outreach_lead_custom_keys(uuid) to authenticated, service_role;
