-- =============================================================================
-- Outreach Platform — 018 scope hardening (access audit, 21 Sep 2026)
--
-- Audit method: every outreach_* function a signed-in user can execute was called, inside a rolled-back transaction, as
--   (a) a user who belongs to no workspace, (b) a client_viewer limited to client A, (c) a member limited to client A —
--   each time with the real ids of another workspace's / client B's sender, sequence, lead, chat, enrollment, action, task.
--
-- Found and fixed:
--   1. Internal helpers that answered anybody who knew an id (caps, schedules, time zones, the suppression and condition
--      checks) and outreach_audit(), which let any signed-in user write rows into any workspace's audit log. Nothing calls
--      them from the app; every SQL caller is SECURITY DEFINER, so they keep working. Closed below.
--   2. RPCs that checked workspace membership but not the client. RLS and the reports already scope by client
--      (outreach_client_visible); these took an id and skipped that step, so a restricted viewer/member could read or act on
--      another client's lead, sequence, sender, enrollment, queued action or task. The check now sits right after
--      outreach_require() in each of them, in the file that defines the function (002, 005, 006, 011, 012, 014, 015).
--      Rule for new RPCs: after outreach_require(), check outreach_client_visible() for the row's client —
--      enrollment → its sequence's client, queued action → its sender's, AI line → its lead's, task → its own.
--
-- Must run after 017 (which re-grants whatever a signed-in user could already execute). Idempotent.
-- =============================================================================
do $$
declare f record;
  internal_fns text[] := array['outreach_effective_cap','outreach_eval_condition','outreach_eval_rule','outreach_in_schedule','outreach_schedule_windows',
    'outreach_sender_local_date','outreach_sender_local_hour','outreach_weekly_invites_used','outreach_ws_tz',
    'outreach_lead_is_suppressed','outreach_lead_suppression_reason','outreach_audit'];
begin
  for f in select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = any(internal_fns) loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
