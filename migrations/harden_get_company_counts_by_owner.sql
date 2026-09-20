-- get_company_counts_by_owner() was SECURITY DEFINER with no user filter and executable without login: it counted every
-- account's companies together and handed the owner names to anybody. `companies` is per-user (RLS: auth.uid() = user_id), so
-- the function only has to respect that — run it as the caller, and only for signed-in callers. (Access audit, 21 Sep 2026.)
alter function get_company_counts_by_owner(text) security invoker;
revoke execute on function get_company_counts_by_owner(text) from public, anon;
grant execute on function get_company_counts_by_owner(text) to authenticated, service_role;
