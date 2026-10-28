-- 007: one Google account belongs to ONE CRM login.
--
-- Before this, (member_id, email) was the only key, so the same Google account could be connected under two CRM logins,
-- and an account connected from the wrong login (e.g. a second login used in another client) showed up as a teammate's
-- view-only calendar with no way to take it back. Now the email is unique across the team; crm-mcp finishConnect moves
-- the row (same id, so linked meetings keep their event) to whoever completes a Google sign-in for it.
-- Idempotent. Emails are already lowercase + trimmed by the a0_normalize_emails trigger.

create unique index if not exists crm_calendar_accounts_email_key on crm_calendar_accounts (email);
