-- 079: AI Auto replies no longer wait for the sender owner's approval.
-- A sender in a sequence's pool is approved by being there: once the sequence is on Auto, its senders reply on Auto.
-- outreach__ai_consent_valid is the one gate (outreach__ai_effective → consent_ok / can_autopilot), so it now always
-- passes; the consent table, links and RPCs stay in place but nothing depends on them any more.

create or replace function outreach__ai_consent_valid(p_sender uuid) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select true
$$;
