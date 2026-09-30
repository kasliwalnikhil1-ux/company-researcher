-- 048_webchat_enums.sql — Web chat (web-chat-PRD.md §3): the `webchat` channel.
-- Own file: a new enum value cannot be used in the transaction that adds it (same rule as 009 / 021 / 024 / 034 / 039).
-- Apply with: bash scripts/outreach-sql.sh migrations/outreach/048_webchat_enums.sql
--
-- A website inbox is represented in the existing model as a synthetic `outreach_senders` row with provider WEBCHAT
-- (no Unipile account). Every web-chat conversation is then an ordinary `outreach_chats` row on that sender, so the
-- unified inbox, RLS (workspace + client scope), notes, tasks, reports and the MCP tools work unchanged.

alter type outreach_provider_t add value if not exists 'WEBCHAT';
