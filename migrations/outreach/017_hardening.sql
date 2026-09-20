-- =============================================================================
-- Outreach Platform — 017 hardening (Supabase security advisor, 20 Sep 2026)
--   * No outreach function is executable by `anon` or through PUBLIC, except the three that must work before login
--     (invite page, custom-domain portal). Every function still checks membership itself; this removes the attack surface.
--   * Signed-in callers keep exactly the access they had (explicit grant replaces the PUBLIC grant).
--   * Every outreach function gets a fixed search_path.
-- Idempotent; safe to re-run after adding functions.
-- =============================================================================
do $$
declare f record; was_user boolean;
  public_fns text[] := array['outreach_branding_for_host','outreach_branding_for_invite','outreach_invitation_preview'];
begin
  for f in select p.oid, p.proname, p.oid::regprocedure::text as sig, p.proconfig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'outreach\_%' and p.prokind = 'f' loop
    was_user := has_function_privilege('authenticated', f.oid, 'execute');
    execute format('revoke execute on function %s from public, anon', f.sig);
    if f.proname like 'outreach\_trg\_%' then
      execute format('revoke execute on function %s from authenticated', f.sig);      -- trigger functions are never called directly
    elsif was_user then
      execute format('grant execute on function %s to authenticated', f.sig);
    end if;
    execute format('grant execute on function %s to service_role', f.sig);
    if f.proname = any(public_fns) then execute format('grant execute on function %s to anon', f.sig); end if;
    if f.proconfig is null or not exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%') then
      execute format('alter function %s set search_path = public, extensions', f.sig);
    end if;
  end loop;
end $$;
