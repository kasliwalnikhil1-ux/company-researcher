# Campaign launch pipeline (brief → validated sequence → dry run → enrol → activate)

Managers only (sequence tools are absent for other roles — then build the list and stop, and tell the user a manager must create the sequence).

## 1. Capacity before ambition
1. `workspace_context` — client, stages, tags, lists.
2. `senders_list` (filter `client_id` for agencies). Pool candidates: `status: ok`, `health ≥ 70`, provider matching the channel (LinkedIn for invites/messages, a mailbox for email steps). Premium/Sales Nav senders get 300-char notes and InMail; free accounts cap notes at 200.
3. `senders_capacity(sender_ids, days:14)` → how many invites/messages the pool affords in two weeks. This bounds the audience size; do not plan more.

## 2. Audience
- Existing leads: `leads_search` with filters from the brief (`title`, `company`, `location`, `tag`, `list_id`, `has_email` for email steps, `not_enrolled_in` other sequences). Report the total and 5 sample names.
- New list from a file: follow [list-import-pipeline.md](list-import-pipeline.md), then tag/list them.
- From a LinkedIn search: `import_create(kind:"search_url", url, sender_id, max_results)` — gated; the estimate tells how many days the search budget needs. Enrol after `import_status` shows progress.

## 3. Draft the sequence as steps
- `sequence_templates` → start from the closest key (`connect_then_message`, `warm_then_connect`, `inmail_two_touch`, `ai_personalised_connect`, `email_three_touch`) and adapt the copy to the brief; or write steps from scratch (format in SKILL.md).
- Copy: first touch references something specific and asks nothing big; no links, no pitch; ≥ 2 days between follow-ups; last touch is a polite close. Use `{{first_name|there}}` and `{{company}}`; never invent facts about the prospect.
- `sequence_validate(steps, pool, ai:true)` → fix every error and every warning you can (W_PITCH_FIRST_TOUCH, W_GENERIC_OPENER, W_SHORT_DELAYS, W_NO_STOP…). Show the user the final steps + copy and wait for edits/approval.

## 4. Create and project
- `sequence_create(name, steps, pool, brief, settings?, client_id?)` → draft sequence id. Keep the brief: AI classification, drafting and QA use it.
- `sequence_project(sequence_id, lead_count)` → days + bottleneck. If the projection is too long, the honest levers are: smaller audience, more healthy senders in the pool, fewer invite-heavy steps — never higher caps.

## 5. Dry run and enrol
- `enroll_preview(sequence_id, lead_ids | filters, sender_id?)` → eligible vs excluded (already enrolled with a pool sender, suppressed, not in workspace), per-sender split, projection, `preview_token` (15 min). Report it as a short table.
- On approval: `enroll_commit(preview_token)` → returns the effect summary + `confirmation_token`; show it; on yes, call again with both tokens. Leads sit at the start node until the sequence is active.

## 6. Activate
`sequence_activate(sequence_id)` → effect summary (pool with health/level, live enrollments, projection) → confirm → active. First actions leave at the next planner run inside each sender's schedule window (planner: nightly + every 20 min top-up). If nothing has gone out one window later, `why_not_sending(sequence_id)`.

## 7. Editing a live sequence (later)
- Copy: `sequence_edit_copy(sequence_id, edits:[{node_id, text}])` — re-renders queued actions of that node; sent messages never change; reserved ones are skipped (`skipped_in_flight`).
- Timing: `sequence_edit_timing(sequence_id, edits:[{node_id, wait}])` — delay nodes reschedule waiting enrollments (report `rescheduled` / `due_now`); action-node waits apply on entry.
- Structure (add/remove/reorder nodes): `sequence_pause` → `sequence_update(steps)` → `sequence_activate`. `sequence_update` refuses to remove a node that live enrollments occupy (`E_NODE_OCCUPIED`): exit or wait for those first.
- `sequence_versions` / `sequence_restore` (gated) to roll back.
