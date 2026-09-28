# Campaign launch pipeline (brief → validated sequence → dry run → enrol → activate)

Managers only (sequence tools are absent for other roles — then build the list and stop, and tell the user a manager must create the sequence).

## 1. Capacity before ambition
1. `workspace_context` — client, stages, tags, lists.
2. `senders_list` (filter `client_id` for agencies). Pool candidates: `status: ok`, `health ≥ 70`, provider matching the channel (LinkedIn for invites/messages, Instagram for the ladder, WhatsApp for consented follow-ups, a mailbox for email steps). Premium/Sales Nav senders get 300-char notes and InMail; free accounts cap notes at 200. Instagram / WhatsApp rows show `quiet_until`, `hour` and `provider_warning`: a sender inside its quiet period or resting after a warning contributes nothing.
3. `senders_capacity(sender_ids, days:14)` → how many invites/messages/new chats the pool affords in two weeks; `channel_capacity` for the per-channel view (Instagram: 10 actions an hour, daily total per level; WhatsApp: 2/5/10/20/35 new chats a day by governor level). This bounds the audience size; do not plan more. A sender the platform reports as blocked contributes 0 and carries the reason. `sender_insights` shows headroom and warm-up progress per sender. Instagram and WhatsApp are low-volume channels by design: say so when the audience is larger than the pool affords, and never suggest more senders as the fix.

## 2. Audience
- Existing leads: `leads_search` with filters from the brief (`title`, `company`, `location`, `tag`, `list_id`, `has_email` for email steps, `not_enrolled_in` other sequences). Report the total and 5 sample names.
- New list from a file: follow [list-import-pipeline.md](list-import-pipeline.md), then tag/list them.
- From LinkedIn: `import_create` ⚠ with `kind: "search_url"` (a people search), `"post_engagement"` (people who reacted to or commented on a post: high intent), `"sn_saved_search"` / `"sn_lead_list"` (Sales Navigator), `"relations"` or `"conversations"`. The estimate tells how many days the sender's search allowance needs. Enrol after `import_status` shows progress. Repeating imports (`import_schedules_list`) plus an auto-enrol rule (`auto_enroll_rules_save` ⚠) keep a sequence topped up.
- Personalisation needs data: leads in a sequence are enriched for free by the profile fetch the sequence already makes. For `{{ai.*}}` first lines before launch, see [ai-lines.md](ai-lines.md).
- Blacklists: `suppressions_add` ⚠ with `client_id` blocks a client's customers and competitors for that client only; `sequence_id` for one sequence. `enroll_preview` shows the counts by reason.

## 3. Draft the sequence as steps
- `sequence_templates` → start from the closest key (`connect_then_message`, `warm_then_connect`, `inmail_two_touch`, `ai_personalised_connect`, `email_three_touch`; Instagram: `instagram_ladder`; cross-channel: `linkedin_to_whatsapp`; WhatsApp: `whatsapp_consented_followup`) and adapt the copy to the brief; or write steps from scratch (format in SKILL.md). Instagram always starts with the ladder (follow → like → wait for a follow-back → message), never a cold DM. WhatsApp sequences only ever reach leads with a recorded consent basis and a verified number: `enroll_preview` excludes the rest as `no_consent` / `no_identity`; see [channels-pipeline.md](channels-pipeline.md).
- Copy: first touch references something specific and asks nothing big; no links, no pitch; ≥ 2 days between follow-ups; last touch is a polite close. Use `{{first_name|there}}` and `{{company}}`; never invent facts about the prospect. Spintax `{Hi|Hello}` and `{{#if company}}…{{/if}}` are fine; the validator counts the LONGEST spintax combination against the limit. To test two openers, give the step `variants` (2 to 5).
- `sequence_validate(steps, pool, ai:true)` → fix every error and every warning you can (W_PITCH_FIRST_TOUCH, W_GENERIC_OPENER, W_SHORT_DELAYS, W_NO_STOP…). Show the user the final steps + copy and wait for edits/approval.

## 4. Create and project
- `sequence_create(name, steps, pool, brief, settings?, assignment?, client_id?)` → draft sequence id. Keep the brief: AI classification, drafting and QA use it. Defaults: a reply stops the lead on every sender and channel and exits cleanly; out-of-office replies resume by themselves. `assignment: "fresh_sender"` avoids senders that already contacted a lead; `"same_sender"` keeps the conversation with whoever spoke to them last.
- `sequence_project(sequence_id, lead_count)` → days + bottleneck. If the projection is too long, the honest levers are: smaller audience, more healthy senders in the pool, fewer invite-heavy steps — never higher caps.

## 5. Dry run and enrol
- `enroll_preview(sequence_id, lead_ids | filters, sender_id?)` → eligible vs excluded with reasons (`already_enrolled`, `suppressed:<scope>_blacklist:<kind>`, `replied_recently`, `no_fresh_sender`, `not_in_workspace`, `no_identity` = no verified handle / number for the pool sender's channel, `no_consent` = WhatsApp without a recorded consent basis), the per-sender split under the assignment rule, `rule_effects` (how many leads the rule moved or flagged), projection, warnings, `preview_token` (15 min). Report it as a short table. For `no_consent` leads ask the human whether a basis exists; never record one to make the number go up.
- `replied_recently` lists leads who answered anyone in the last 90 days, with names and dates. They are left out. Show them; re-run with `include_replied: true` only if the user wants them in.
- On approval: `enroll_commit(preview_token)` → returns the effect summary + `confirmation_token`; show it; on yes, call again with both tokens. The commit runs the same plan as the preview and reports `enrolled`, `skipped_active`, `skipped_suppressed`, `skipped_replied`, `skipped_other` and `waiting` (parked until their profile is enriched or their AI line is approved). Leads sit at the start until the sequence is active.

## 6. Activate
`sequence_activate(sequence_id)` → effect summary (pool with health/level, live enrollments, projection) → confirm → active. First actions leave at the next planner run inside each sender's schedule window (planner: nightly + every 20 min top-up). If nothing has gone out one window later, `why_not_sending(sequence_id)`.

## 7. Editing a live sequence (later)
Read [live-editing.md](live-editing.md). In short: `sequence_edit_copy`, `sequence_edit_timing` and `sequence_update` first return the **publish impact** (who is on, past or before a changed step; what is already queued with the old text); show it, let the user choose `mode: all` or `new_only`, then confirm. No pause needed. Pool changes go through `sequence_pool_preview` → `sequence_pool_set`. `sequence_versions` shows who still runs an old version; `sequence_move_to_latest` / `sequence_restore` (both gated) move or roll back.

## 8. After launch
- `dashboard.attention` and `alerts_list`: stalled sequences, senders running dry, failed leads, held leads, AI lines to review.
- Failed leads: [recovery-and-holds.md](recovery-and-holds.md). Numbers: [metrics.md](metrics.md).
