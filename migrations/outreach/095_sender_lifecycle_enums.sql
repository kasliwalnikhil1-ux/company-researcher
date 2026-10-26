-- =============================================================================
-- Outreach Platform — 095 sender lifecycle enums (sender-lifecycle-PRD.md §6.1)
-- Run on its own, before 096: a new enum value cannot be used in the transaction that adds it.
--
-- 'removed' = the connector account is unlinked and deleted, stored credentials are wiped and the paid account slot is
--             freed; every conversation, the "already contacted" record and the report numbers stay. The owner can
--             reconnect later and the history comes back onto the same sender row (PRD D2, D10).
-- 'erased'  = conversations and personal data were deleted for good; the row is a tombstone that keeps report counts.
--
-- 'disconnected' (billing v2, 056) stays in the type because enum values cannot be dropped; 096 moves every such row
-- to 'removed' and nothing writes 'disconnected' any more.
-- =============================================================================
alter type outreach_sender_status_t add value if not exists 'removed';
alter type outreach_sender_status_t add value if not exists 'erased';
