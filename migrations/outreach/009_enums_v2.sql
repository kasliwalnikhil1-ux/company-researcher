-- =============================================================================
-- Outreach Platform — 009 enum additions for the product plan (outreach-product-plan.md)
--
-- Kept in its own file on purpose: a value added with ALTER TYPE … ADD VALUE cannot be
-- used in the same transaction, and the Management API runs one file as one transaction.
-- Apply this file BEFORE 010+.
-- =============================================================================

-- Action types
--   post_fetch  (plan §3 checklist / item 13): every read of a lead's posts is budgeted
--   follow      (item 24): follow a profile, own budget row
--   find_email  (item 26): third-party finder call; unbudgeted like call_api (no LinkedIn traffic)
alter type outreach_action_type_t add value if not exists 'post_fetch';
alter type outreach_action_type_t add value if not exists 'follow';
alter type outreach_action_type_t add value if not exists 'find_email';

-- Import kinds (item 18)
alter type outreach_import_kind_t add value if not exists 'post_engagement';
alter type outreach_import_kind_t add value if not exists 'conversations';
alter type outreach_import_kind_t add value if not exists 'sn_saved_search';
alter type outreach_import_kind_t add value if not exists 'sn_lead_list';
alter type outreach_import_kind_t add value if not exists 'company_people';

-- Task kinds: reply_hold (item 1 "hold for review"), call (item 24 call task)
alter type outreach_task_kind_t add value if not exists 'reply_hold';
alter type outreach_task_kind_t add value if not exists 'call';
