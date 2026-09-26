# Numbers and report tools (one source of numbers)

Every figure comes from the same database functions the dashboard, the Reports page, the client portal and the public API call. For the same dates the numbers are identical everywhere, so **quote, never recompute**: no adding rows, no dividing, no "about 12%". If the user spots a mismatch with the app, check the dates and the timezone first.

## Periods

`period`: `7d` (default for `report_overview` / `report_client`), `14d`, `30d` (default elsewhere), `90d`, or `{from:"2026-09-01", to:"2026-09-14"}`. Inclusive calendar days in the workspace timezone. `7d` = today and the 6 days before it = the dashboard's `last_7_days`. Max range 2 years.

## The totals object (same keys in every report tool)

`enrolled, invites, invites_with_note, accepted, acceptance_rate, messages, inmails, emails, touches, replies, reply_rate, interested, interested_rate, positive_reply_rate, negative_reply_rate, intents{interested, question, not_now, not_interested, ooo, wrong_person, unclear, unclassified}, meetings, won, lost, won_value, inbound_messages, profile_views, likes, comments, endorsements, follows, withdrawn, post_fetches, failed, skipped, limit_hits, email_opened, email_clicked, email_bounced, open_rate, click_rate, bounce_rate`

Definitions worth knowing (full text: `metric_definitions`):
- **touches** = messages + InMails + emails + invitations that carried a note. The denominator of every reply rate.
- **replies** = threads where the lead answered an automated step for the first time in the period. One lead answering three times is one reply. Answers to a teammate's manual message are conversation, not replies.
- **positive / negative reply rate** = interested / not-interested replies ÷ replies, out-of-office left out.
- Rates are percentages with one decimal; `null` means nothing to divide by. Say "n/a".

## Which tool answers which question

| Question | Tool |
|---|---|
| "How did we do this week / vs last week?" | `report_overview` (`totals`, `previous`, `by_channel`, daily `series`) |
| "Where do leads drop off?" | `report_funnel` (cohort: leads enrolled in the period followed through enrolled → invited → accepted → messaged → replied → interested → meeting → won, with median hours between stages) |
| "Which message gets positive replies?" | `report_intents(group: "step" \| "variant" \| "sequence" \| "sender" \| "channel" \| "day")` |
| "Show me those 14 interested replies" | `report_reply_threads(intent:"interested", sequence_id?, node_id?, variant_id?)` → `chat_id`s → `inbox_thread` |
| "Which sequences / senders / clients carry the results?" | `report_sequences`, `report_senders`, `report_clients` |
| "How is this sequence doing, step by step?" | `report_sequence` (steps, `best_step`, `worst_step` with 20+ sends, `ab_tests`, exits, live) · `sequence_stats` for the lifetime view |
| "How is this sender doing?" | `report_sender` (totals, health trend, restrictions, failures in plain words) · `sender_insights` for advice |
| "What does a reply cost us?" | `report_cost` (needs a monthly cost per sender; return only when deal values exist) |
| "Email opens and bounces?" | `report_deliverability` |
| "How do Instagram / WhatsApp compare to LinkedIn?" | `report_channels` (per channel: senders, actions, new_chats, replies, `replies_per_100_actions`, interested, blocks, reply_rate). Lower volume, higher conversion is the expected shape; the answer to a low ceiling is better targeting, not more senders |
| "Who did we contact on WhatsApp and on what basis?" | `report_consent` (contacted leads by basis with evidence and attester; `alert: true` when `imported_attested`, the weakest basis, exceeds 30 %). This is the artefact if a client's number is challenged |
| "Did anyone block us?" | `report_blocks` (per sender, each block with the five preceding actions) |
| "Raw data" | `report_export` ⚠ (CSV, signed link, personal data) |

Filters on overview / funnel / intents: `client_id`, `sequence_id`, `sender_id`; plus `node_id`, `channel` (overview, intents), `list_id`, `tag_id` (funnel). `by_channel` in `report_overview` may include `instagram` and `whatsapp`; totals gain `new_chats` (conversations that did not exist yet, counted on every channel), `blocks`, `identifier_checks`, `followers_polls`, and `touches` includes new chats.

## Client write-up (agencies)

1. `report_client(client_id, period)`: the same numbers the client sees in their portal.
2. `report_intents(client_id, group:"sequence")` and `report_funnel(client_id)` for the story; `report_sequence` for the active sequences.
3. Write 3 short paragraphs (activity, results, next period) and one small table: invitations, acceptance rate, touches, replies, reply rate, interested, positive reply rate, meetings. No internal jargon (no node ids, no allowance talk); mention health only as "capacity" if it limited volume.
4. Offer `report_export(kind:"messages")` ⚠ if they want the raw conversations.

## Dashboard

`dashboard` returns `today` and `last_7_days` (full totals objects), counters (`replies_awaiting`, `unread`, `tasks_open`, `drafts_awaiting`, `ai_lines_awaiting`, `enrollments_live`, `sent_today`, `queued_today`, `leads_total`), senders with today's usage, and `attention` items, each with a `next`:

| kind | Means | Next |
|---|---|---|
| `sender` | disconnected, paused or invitations blocked | a person reconnects / resumes; `why_not_sending(sender_id)` |
| `sequence` | throttled: the pool cannot keep up | add a healthy sender or accept the projection |
| `sequence_stalled` | active, live leads, nothing sent in a full working window, nothing planned | `why_not_sending(sequence_id)` |
| `sender_running_dry` | under 2 days of new leads queued | enrol more leads or add an auto-enrol rule |
| `import_failed` | an import stopped | `import_status(job_id)` |
| `held_leads` | replied, held for review | `enrollment_hold_list` |
| `failed_leads` | need retry / skip / exit | `enrollments_failed` → `enrollment_recover` |
| `ai_review` | AI lines wait for a person | `ai_review_list` |
