-- =============================================================================
-- Outreach Platform — 024 enum values for the Instagram & WhatsApp channels
-- Source: docs/outreach/CHANNELS-BUILD-CONTRACT.md §1 (instagram-whatsapp-channels-PRD.md, 25 Sep 2026).
--
-- Kept in its own file on purpose: a value added with ALTER TYPE … ADD VALUE cannot be used in the
-- transaction that adds it, and the Management API runs one file as one transaction.
-- Apply this file BEFORE 025 and 026. Idempotent.
-- =============================================================================

-- Providers
alter type outreach_provider_t add value if not exists 'INSTAGRAM';
alter type outreach_provider_t add value if not exists 'WHATSAPP';

-- Action types ('follow' exists since 009)
--   unfollow          Instagram: undo a follow (metered)
--   new_chat          every channel: creating a conversation that did not exist ('message' keeps meaning "into an existing chat")
--   identifier_check  WhatsApp: "is this number on WhatsApp?" — runs before a new chat, never spends the new-chat budget
--   followers_poll    Instagram: one page of the sender's own followers list (follow-back detection)
--   story_react       Instagram, v2 (reserved)
alter type outreach_action_type_t add value if not exists 'unfollow';
alter type outreach_action_type_t add value if not exists 'new_chat';
alter type outreach_action_type_t add value if not exists 'identifier_check';
alter type outreach_action_type_t add value if not exists 'followers_poll';
alter type outreach_action_type_t add value if not exists 'story_react';

-- Consent bases (PRD §6.3)
do $$ begin
  create type outreach_consent_basis_t as enum ('inbound','form_optin','existing_customer','linkedin_reply','explicit_share','imported_attested');
exception when duplicate_object then null; end $$;

-- Suppression kinds: a stop request on WhatsApp suppresses the number, on Instagram the handle
alter table outreach_suppressions drop constraint if exists outreach_suppressions_kind_check;
alter table outreach_suppressions add constraint outreach_suppressions_kind_check
  check (kind in ('domain','public_identifier','email','company','phone','handle'));
