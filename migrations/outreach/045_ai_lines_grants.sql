-- 045 — Restore the AI-lines review grants.
-- The grant loops in 037 and 042 match every outreach_ai_% function and revoke `authenticated` from any function not on their
-- own app list. That list only covers AI replies, so the older AI-lines RPCs from 014 (generate lines, list lines to review,
-- approve/skip/edit) lost their grant and /outreach/ai-review failed with "permission denied for function outreach_ai_review_list".
-- Each of the three still enforces outreach_require() + outreach_client_visible() inside, so re-granting is safe.
-- Idempotent.

do $$
declare f text;
begin
  for f in select unnest(array['outreach_ai_generate_request(uuid,uuid,uuid[],uuid,boolean)','outreach_ai_review_list(uuid,uuid,text,int,int)','outreach_ai_review(uuid[],text,text)']) loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
