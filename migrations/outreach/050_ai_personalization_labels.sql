-- 050 — AI Personalization naming in server-side copy.
-- The app renamed its AI pages (2026-09-30): the AI review page is now "AI Personalization", separate from "AI Auto Replies".
-- Two functions still send the old page name to users:
--   1. outreach_why_not_sending(): the W_WAITING_AI_REVIEW remedies ("Open AI review…"), shown in the Why-not-sending dialog,
--      the sender diagnosis and through the MCP.
--   2. outreach_dashboard(): the ai_review attention reason, shown in the weekly/monthly digest email.
-- Codes, kinds and logic are unchanged; only the text is. Patched in place like 027/044 so nothing else in either function
-- changes. Note for later migrations: a full `create or replace` of either function copied from 026/013 would bring the old
-- text back; copy the live definition instead. Idempotent.
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/050_ai_personalization_labels.sql

do $$
declare def text := pg_get_functiondef('public.outreach_why_not_sending(uuid,uuid,uuid)'::regprocedure);
begin
  if position('Open AI Personalization' in def) = 0 then
    def := replace(def, $q$'remedy','Open AI review and approve, edit or skip it.'$q$,
                        $q$'remedy','Open AI Personalization and approve, edit or skip it.'$q$);
    def := replace(def, $q$'remedy','Open AI review.'$q$,
                        $q$'remedy','Open AI Personalization.'$q$);
    if position('Open AI review' in def) > 0 or position('Open AI Personalization and approve' in def) = 0
       or position($q$'Open AI Personalization.'$q$ in def) = 0 then
      raise exception 'outreach_why_not_sending: W_WAITING_AI_REVIEW remedies not found, patch not applied';
    end if;
    execute def;
  end if;
end $$;

do $$
declare def text := pg_get_functiondef('public.outreach_dashboard(uuid)'::regprocedure);
begin
  if position('AI Personalization lines are waiting for review' in def) = 0 then
    def := replace(def, $q$'AI lines are waiting for review'$q$, $q$'AI Personalization lines are waiting for review'$q$);
    if position('AI Personalization lines are waiting for review' in def) = 0 then
      raise exception 'outreach_dashboard: ai_review attention reason not found, patch not applied';
    end if;
    execute def;
  end if;
end $$;
