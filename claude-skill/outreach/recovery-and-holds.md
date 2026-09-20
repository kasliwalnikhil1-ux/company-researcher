# Failed leads, held leads, and what a reply does

## What happens when a lead replies

- **Lead-wide stop (default).** A reply to any sender, on LinkedIn or email, ends every live enrolment of that lead in the workspace and cancels queued touches on every sender. `stop_on_reply_scope: "sender"` restores the old per-sender behaviour; `send_always` steps and `stop_on_reply: false` still win.
- **`on_reply: "exit"` (default).** The lead leaves cleanly (`exited_replied`), the reply gets an intent, interested / question replies create a follow-up task. Continue in the inbox.
- **`on_reply: "hold"`.** The lead is paused for a person to decide. It shows on the dashboard attention list (`held_leads`), stops counting toward sender load after 14 days and the hold ends by itself after `hold_max_days` (30).
- **Out-of-office.** An `ooo` reply does not end the sequence: the lead re-opens after the return date the auto-reply names, else after `ooo_resume_days` (7).
- **Enrol guard.** `enroll_preview` leaves out leads who replied to anyone in the last 90 days and lists them under `replied_recently` with names and dates. Show them. Re-run with `include_replied: true` only when the user wants them enrolled anyway; the choice travels with the preview token into `enroll_commit`, which reports `skipped_replied` for anyone who replied in between.

## Held leads

1. `enrollment_hold_list(sequence_id?)` → lead, sender, step, `held_at`, `chat_id`, `task_id`.
2. Read what they wrote (`inbox_thread(chat_id)`), show the user.
3. The user decides per lead:
   - `enrollment_resume([ids])`: continue from the held step. Everything they wrote so far counts as handled, so the next automated message goes out although they replied. The result lists `holds_released`.
   - `enrollment_exit([ids], reason)` ⚠: ends as replied, history and chat kept.
   - or `task_complete(task_id, decision: "resume" | "exit")` on the `reply_hold` task: same effect.

Never resume a held lead on your own judgement.

## Failed leads

1. Find them: `dashboard.attention` kind `failed_leads`, `report_sequences[].failed_leads`, `report_sequence.steps[].failed_here`.
2. `enrollments_failed(sequence_id, node_id?)` → `by_reason` (step, plain reason, leads, `recoverable`) and a page of leads. `kind: "skipped"` lists skipped steps (information only).
3. Tell the user the reasons in their words ("14 leads: the sender was disconnected from LinkedIn", "3 leads: this person cannot be invited").
4. `enrollment_recover(enrollment_ids ≤500, action)` ⚠:
   - `retry`: re-queues the **same step** under a new key through the normal daily budget. Nothing already sent is sent again. Refused for blacklisted leads and invalid profiles.
   - `skip`: moves the lead past the failed step to the next one.
   - `exit`: ends the enrolment; lead, timeline and chat are kept.
5. Read `refused`: `not_failed`, `lead_suppressed`, `profile_invalid`, `already_enrolled_again`, `sender_gone`.

**There is no restart-from-top, on purpose.** It would re-send every message the lead already received. To run a lead through a sequence again, enrol it again with `enroll_preview`, which shows the already-contacted warnings.

Failures that fix themselves need nothing from you: when a sender reconnects, its leads that failed with a disconnect or network reason in the last 7 days re-queue automatically.

Good matches: disconnected sender, LinkedIn temporary error, rate limit → `retry` once the sender is healthy. "No usable text for this lead", "no recent post", "no InMail credit" → `skip`. Profile gone, cannot be invited, blacklisted → `exit`.
