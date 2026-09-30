-- 039 — AI replies v2: enum values (ai-replies-changes.md §12.1 point 6, docs/outreach/AI-REPLIES-V2-CONTRACT.md §1).
-- Own call: a value added to an enum cannot be used in the transaction that adds it. Idempotent.
alter type outreach_task_kind_t add value if not exists 'ai_handoff';
