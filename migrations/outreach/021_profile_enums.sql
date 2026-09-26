-- =============================================================================
-- Outreach Platform — 021 Profile Studio enum values (linkedin-profile-management-PRD.md §5.1, §4.2)
-- Own file on purpose: a new enum value cannot be used in the transaction that adds it. Idempotent.
-- =============================================================================
alter type outreach_action_type_t add value if not exists 'profile_edit';

do $$ begin
  create type outreach_profile_field_group_t as enum ('headline','about','photo','cover','location','experience','education','skills','custom_link');
exception when duplicate_object then null; end $$;
