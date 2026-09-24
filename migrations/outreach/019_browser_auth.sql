-- 019: "browser" auth method = sender connected through the hosted-auth browser extension sign-in
-- (the account already logged in to the owner's browser; we hold an account id, never cookies or a password).
-- Idempotent. A new enum value cannot be used in the same transaction that adds it, so this file only adds it.
alter type outreach_auth_method_t add value if not exists 'browser';
