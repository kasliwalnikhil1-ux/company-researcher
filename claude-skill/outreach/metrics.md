# Numbers and report tools (one source of numbers)

Every figure comes from the same database functions the dashboard, the Reports page, the client portal and the public API call. For the same dates the numbers are identical everywhere, so **quote, never recompute**: no adding rows, no dividing, no "about 12%". If the user spots a mismatch with the app, check the dates and the timezone first.

## Sequence results (people, counted once)

`sequences_list`, `sequence_stats`, `report_sequences` and `report_sequence` describe a sequence in **people**, not actions (a lead messaged on three channels is one person): **Contacted → Accepted → Replied → Positive**, each with a rate.

| Field | Means | Rate |
|---|---|---|
| `contacted` | people who got at least one LinkedIn invitation / message / InMail, Instagram follow / message, WhatsApp message or email from the sequence. Visits, likes, comments, endorsements don't count | — (÷ `progress.enrolled` in the tooltip) |
| `invited` | people sent a LinkedIn connection request or an Instagram follow | — (the denominator) |
| `accepted` · `pending` · `accepted_early` · `accepted_split` | invitations accepted / follows followed back, whenever that happened; `pending` = still open; `accepted_early` = more than half still pending, so say the rate will change; `accepted_split` = per channel | `accepted_rate` = accepted ÷ invited |
| `replied` · `auto_replied` | people who wrote back **as a person**. A reply belongs to the sequence that contacted the lead **last** before it, counted once at the first human reply. `auto_replied` = only an out-of-office / automatic reply came: say it, never count it | `replied_rate` = replied ÷ contacted |
| `positive` · `meetings` | the reply (or a later message within 30 days) classified interested / question, or a Meeting stage reached | `positive_rate` = positive ÷ replied |
| `na` | `{accepted: reason}` when the sequence has no invitation / follow step; `{seen: reason}` for email-only. Say **NA** with the reason, never 0 |
| `progress` · `ops` | `{enrolled, live, done, pct_done}` and `{queued, actions_sent, failed, failed_leads}`. `actions_sent` is the old "sent" (actions, not people) |

**Periods are cohorts** (`period` on `report_sequences` / `report_sequence`; `sequences_list` / `sequence_stats` are all time): the leads **first contacted** in the window, and everything they did afterwards up to today. Say "leads first contacted 1–26 Oct, and what they did after", never "accepted in October". Rates are `null` when nothing was invited / contacted / replied: say "n/a", never "0%"; call a rate "early" when fewer than 20 people stand behind it.

`sequence_stats` / `report_sequence` add `channels[]`: one block per channel with only the stages that channel has (LinkedIn: contacted → invited → accepted → messaged → seen → replied, plus `replied_of_accepted_rate` = "of people who accepted, N% replied"; Instagram: followed / followed back / DM'd; WhatsApp: contacted → seen → replied, `bounced` = not on WhatsApp; Email: contacted → replied, `bounced`). `seen` is **at least** (read receipts can be off; email has none), `seen_since` says from when receipts were kept. `replied_other_channel` = replies on a channel the sequence has no step on (still credited to it). `from_earlier_version: true` = the channel is gone from the current steps but had activity.

The `summary` string of these tools is the sentence to quote: "113 contacted, 38 accepted of 113 invited (34%, 41 pending), 9 replied (8%), 4 positive".

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
| "Which sequences carry the results?" / "How many people replied to X?" | `report_sequences` (people: contacted, accepted, replied, positive, per sequence; see "Sequence results" above), `report_senders`, `report_clients` |
| "How is this sequence doing?" | `sequence_stats` (all time: people-level funnel, one block per channel, steps, A/B, exits) · `report_sequence` for a cohort period (steps, `best_step`, `worst_step` with 20+ sends, `ab_tests`, exits, live) |
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
| `ai_review` | Personalized lines wait for a person (AI → Needs you) | `ai_review_list` |
| `ai_lines_auto_paused` | Auto-approve paused itself for a variable (people rejected too many of its lines) | show the reason and example lines; resuming is a manager's call with a note |
