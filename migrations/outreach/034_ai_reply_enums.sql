-- 034 — AI replies: enums (ai-auto-reply-PRD.md §11, docs/outreach/AI-REPLIES-CONTRACT.md §1).
-- Own file and own API call: a value added with ALTER TYPE … ADD VALUE cannot be used in the transaction that adds it,
-- so 035 / 036 must run after this one has committed. Idempotent.

alter type outreach_action_type_t add value if not exists 'ai_reply';
alter type outreach_task_kind_t   add value if not exists 'ai_escalation';

do $$ begin
  create type outreach_reply_mode_t as enum ('off', 'draft', 'autopilot');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_ai_reply_status_t as enum (
    'debouncing', 'drafting', 'draft_ready', 'scheduled', 'sending', 'sent',
    'escalated', 'no_reply', 'superseded', 'cancelled', 'failed', 'expired');
exception when duplicate_object then null; end $$;

do $$ begin
  create type outreach_ai_reply_decision_t as enum ('send', 'escalate', 'no_reply');
exception when duplicate_object then null; end $$;
