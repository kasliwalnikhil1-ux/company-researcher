# PRD: Sequence stats — contacted, accepted, replied, positive, per channel

**Document:** Change PRD — replace the result columns on the Sequences list, add a per-channel funnel to the sequence page, and define every number once so the list, reports, MCP and API agree
**Version:** 1.0 · 26 October 2026
**Applies to:** the app as built (`/outreach/sequences`, `/outreach/sequences/:id`), per `linkedin-outreach-platform-PRD.md` (schema §7, F2, F3 `complete_action`, F18), `instagram-whatsapp-channels-PRD.md`, native email, AI replies, `sender-lifecycle-PRD.md`.
**Migration:** `0NN_sequence_stats` (next free number). **New function:** F54. **Changed:** F2, F3 (`complete_action`), F18, `report_sequences`, `report_sequence`, `metric_definitions`, MCP `sequences_list` / `sequence_stats`.
**Names:** tables and columns follow the specs. The build prefixes tables with `outreach_`; adjust.
**Reference:** Smartlead campaign row (Sent · Opened · Replied w/OOO with %, progress ring, NA ⓘ when a metric is off).

---

## 0. Summary

| # | What |
|---|---|
| 1 | The Sequences list shows results, counted in **people**, with a **%** next to each: **Contacted · Accepted · Replied · Positive**, plus a progress ring |
| 2 | **Accepted** = LinkedIn invites accepted and Instagram follow-backs, with **pending** shown beside the rate |
| 3 | A metric that doesn't apply shows **NA ⓘ** with the reason, never 0 |
| 4 | A channel shows only if the sequence has a step on it or had activity on it in the period |
| 5 | The sequence page gets one funnel block per channel, plus **Seen** (read receipts) and a "Replied on another channel" line |
| 6 | Every number comes from one set of database functions, used by the list, the sequence page, Reports, the MCP and the API |
| 7 | Queued, failed and actions sent move off the list into the sequence page and the hover |

---

## 1. Today and the gap

| Column today | Problem |
|---|---|
| **Sent** | Counts actions of every kind (invites, messages, visits). "113 sent" doesn't say how many people were invited or messaged |
| **Replied** | A count with no rate. Unclear whether out-of-office counts |
| **Live · Completed · Queued** | Progress, not results, and they take most of the row |
| — | No acceptance number, the main LinkedIn metric |
| — | No percentages, so two sequences can't be compared |
| — | Nothing says which channels a sequence uses |

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Count **people (leads)**, not actions, on the list | A lead messaged on three channels is one person. Rates only make sense per person |
| **D2** | One funnel for every channel: **Contacted → Accepted → Replied → Positive**. Each stage has a per-channel definition (§3.2) | One row layout for LinkedIn, Instagram, WhatsApp and email sequences |
| **D3** | Rates for a period use a **cohort**: leads first contacted in the period, and everything they did afterwards, up to today | Counting "accepted in October ÷ invited in October" mixes people from different months and can exceed 100% |
| **D4** | Accepted rate = accepted ÷ invited, with pending shown beside it, and greyed with "early" while more than half are pending | A sequence started yesterday would otherwise look like it has a 2% acceptance rate |
| **D5** | A reply is credited to **the sequence that last contacted the lead** before the reply. Counted once | A reply stops the lead everywhere, so it can only belong to one sequence |
| **D6** | Out-of-office and auto-replies are **not** replies. They show in the tooltip | Smartlead's "Replied w/OOO" inflates the number people act on |
| **D7** | Not applicable → **NA ⓘ** with a one-line reason. Never 0 | 0 means "nobody did it". NA means "this sequence can't do it" |
| **D8** | **Seen** (read receipts) only on the sequence page, labelled "at least" | People can turn read receipts off on LinkedIn and WhatsApp, so it undercounts |
| **D9** | Numbers are stored as **facts per enrolment**, updated when things happen, and checked nightly against the source tables | The list has to load fast for every sequence, and must never drift from Reports |

---

## 3. Definitions

### 3.1 Lead-level funnel (list row and sequence page header)

All counts are `count(distinct lead_id)` within the sequence. A lead enrolled twice in the same sequence (for example re-enrolled with another sender) counts once.

| Metric | A lead counts when | Rate shown |
|---|---|---|
| **Enrolled** | Has an enrolment in the sequence | — |
| **Contacted** | At least one of these was **sent** (`actions.status='sent'`) by this sequence: LinkedIn `invite`, `message`, `inmail`; Instagram `follow`, `new_chat`, `message`; WhatsApp `new_chat`, `message`; `email`. Profile visits, likes, comments, endorsements don't count | ÷ Enrolled, shown only in the tooltip |
| **Invited** | This sequence sent a LinkedIn invite or an Instagram follow | — (denominator) |
| **Accepted** | An invite this sequence sent was accepted, or a follow this sequence sent was followed back. Counts even if the lead later exited for another reason | ÷ Invited |
| **Pending** | Invited, not accepted, not withdrawn, not declined | shown beside the rate |
| **Replied** | A **human** inbound message arrived after this sequence's first touch, and §3.4 credits the reply to this sequence. Excludes OOO (`intent='ooo'`) and auto-replies (`messages.is_auto_reply`) | ÷ Contacted |
| **Auto-replied** | Only OOO or auto-replies arrived | tooltip only |
| **Positive** | A credited reply has intent `interested` or `question` (F18), **or** the lead reached a stage marked `is_meeting` while in or after this sequence | ÷ Replied |
| **Meetings** | Reached a stage marked `is_meeting` | tooltip of Positive |

Rates: one decimal, `null` when the denominator is 0 (shown "n/a"), never "0%".

### 3.2 Per channel (sequence page)

Counted per lead per channel. A stage the channel doesn't have is left out of that channel's block.

| Stage | LinkedIn | Instagram | WhatsApp | Email |
|---|---|---|---|---|
| **Contacted** | invite, message or InMail sent | follow or DM sent | chat started or message sent | email sent and not hard-bounced |
| **Invited / Accepted** | invite sent / accepted | follow sent / followed back | — | — |
| **Messaged** | message or InMail sent | DM sent | message sent | — (same as Contacted) |
| **Seen** (at least) | a message from us has a read receipt | same | same (blue ticks) | — (no open tracking) |
| **Replied** | human reply in a LinkedIn chat | human reply in an Instagram chat | human reply in a WhatsApp chat | human reply in the email thread |
| **Bounced** | — | — | number not on WhatsApp (`identifier_check`) | hard bounce |

Plus, below the blocks: **Replied on another channel: N** — leads who replied on a channel this sequence doesn't use (D5 still credits the reply here), split by channel.

LinkedIn block also shows **Replied ÷ Accepted** ("of people who accepted, 24% replied"): the clearest test of whether the messages work once people let you in.

### 3.3 Which channels show (D7)

`sequence_channels(sequence_id, period)` returns a channel when either:
- the **head version** of the sequence has a step on that channel, or
- the facts table has any activity on that channel for the period (older versions, cross-channel switches).

A channel present only through activity is marked `from_earlier_version: true` and shown with "from an earlier version".

**Accepted** on the list is NA when no returned channel has an invite or follow step and nothing was invited in the period. Reason text: "This sequence doesn't send connection requests or follows." When both LinkedIn and Instagram apply, the number is the sum and the tooltip splits it.

**Seen** is NA for email-only sequences: "Email opens aren't tracked."

### 3.4 Reply credit (D5)

When a human inbound message arrives from a lead:
1. Find the lead's most recent **sent** touch (as defined in §3.1) **before** the message, across all sequences and senders.
2. The enrolment that sent it gets `replied_at`, `reply_channel`, `reply_message_id`. Only that enrolment.
3. If there is no earlier touch from any sequence (they wrote first, or only manual messages), no sequence is credited.
4. Only the **first** human reply is credited. Later messages in the conversation don't change the funnel.
5. If the first reply was OOO/auto and a human reply comes later, the human reply is credited at its own time.

Positive is evaluated on the credited reply and on every later inbound in the same lead's conversations for 30 days (a "yes" often comes in message two), and on meeting stages.

### 3.5 Periods (D3)

- **All time** (default on the list): every enrolment in the sequence.
- **7d / 14d / 30d / 90d / custom** (workspace timezone, inclusive calendar days, same as Reports): the cohort is leads whose **first contact** by this sequence falls in the period. Their acceptances, replies and positives count whenever they happened, up to now.
- Header text on the list: "Leads first contacted 1–26 Oct, and what they did after."
- Enrolled and Progress ignore the period (they describe the sequence now).

---

## 4. Data model

### 4.1 Fact tables

```sql
-- 0NN_sequence_stats

-- One row per enrolment: the lead-level funnel.
create table sequence_lead_facts (
  enrollment_id        uuid primary key references enrollments(id) on delete cascade,
  workspace_id         uuid not null references workspaces(id) on delete cascade,
  sequence_id          uuid not null references sequences(id) on delete cascade,
  sequence_version     int  not null,
  lead_id              uuid not null references leads(id) on delete cascade,
  sender_id            uuid not null references senders(id),            -- no action, per sender-lifecycle PRD
  first_contacted_at   timestamptz,
  first_contact_channel provider_t,
  last_touch_at        timestamptz,                                     -- for reply credit (§3.4)
  invited_at           timestamptz,                                     -- LinkedIn invite or IG follow
  invite_channel       provider_t,
  accepted_at          timestamptz,
  invite_closed_at     timestamptz,                                     -- withdrawn or declined
  invite_closed_reason text check (invite_closed_reason in ('withdrawn','declined')),
  replied_at           timestamptz,
  reply_channel        provider_t,
  reply_message_id     uuid references messages(id) on delete set null,
  auto_replied_at      timestamptz,
  positive_at          timestamptz,
  meeting_at           timestamptz,
  updated_at           timestamptz not null default now()
);
create index on sequence_lead_facts(sequence_id, first_contacted_at);
create index on sequence_lead_facts(lead_id, last_touch_at desc);
create index on sequence_lead_facts(workspace_id, sequence_id);

-- One row per enrolment per channel used: the per-channel blocks.
create table sequence_channel_facts (
  enrollment_id   uuid not null references enrollments(id) on delete cascade,
  channel         provider_t not null,
  sequence_id     uuid not null,
  lead_id         uuid not null,
  contacted_at    timestamptz,
  invited_at      timestamptz,
  accepted_at     timestamptz,
  messaged_at     timestamptz,
  seen_at         timestamptz,
  replied_at      timestamptz,          -- a human reply on this channel (not only the credited one)
  bounced_at      timestamptz,
  primary key (enrollment_id, channel)
);
create index on sequence_channel_facts(sequence_id, channel);

-- Read receipts and auto-reply marking on messages.
alter table messages
  add column if not exists seen_at timestamptz,          -- from Unipile message_read on our outbound
  add column if not exists is_auto_reply boolean not null default false;  -- exists for email; now all channels

-- Meeting stages.
alter table stages add column if not exists is_meeting boolean not null default false;

-- All-time cache for the list (refreshed per sequence, §5.3).
create table sequence_stats_cache (
  sequence_id   uuid primary key references sequences(id) on delete cascade,
  workspace_id  uuid not null,
  stats         jsonb not null,         -- output of report_sequences for period 'all'
  refreshed_at  timestamptz not null default now()
);
```

`lead_sender_state` keeps relation state per sender as today. The fact tables record what **a sequence** did and got. They don't replace it.

### 4.2 Writing the facts

| Event | Where | Fact update |
|---|---|---|
| Action sent (touch types of §3.1) | `complete_action()` (F3) | lead facts: `first_contacted_at` (if null), `first_contact_channel`, `last_touch_at`; invite/follow → `invited_at`, `invite_channel`. Channel facts: `contacted_at`, `invited_at` or `messaged_at` |
| Invite withdrawn (`withdraw` sent) | `complete_action()` | `invite_closed_at`, `reason='withdrawn'` unless already accepted |
| Invite accepted (`new_relation` or note-chat path) / follow-back (`followers_poll`) | F2 / IG poll worker | The enrolment whose `invited_at` is the latest before acceptance for that lead + sender + channel: `accepted_at`. Channel facts: `accepted_at` |
| Invite declined (seen in invitations diff) | relations poll | `invite_closed_at`, `reason='declined'` |
| Our outbound message read (`message_read`) | F2 | `messages.seen_at`; channel facts `seen_at` (first only) for the enrolment that sent that message (`messages.action_id → actions.enrollment_id`) |
| Human inbound | F2, after the existing reply-stop | §3.4 credit → lead facts `replied_at`, `reply_channel`, `reply_message_id`. Channel facts `replied_at` on the credited enrolment's matching channel row (created if the channel is new to that enrolment) |
| OOO / auto-reply inbound | F2 (`is_auto_reply`) and F18 (`intent='ooo'`) | `auto_replied_at` (first only) |
| Classified `interested` / `question` within 30 days of the credited reply | F18 | `positive_at` (first only) |
| Lead moves to a stage with `is_meeting` | trigger on `leads.stage_id` | `meeting_at` and `positive_at` (if null) on the lead's most recently credited enrolment |
| Email hard bounce / WhatsApp number invalid | email handler / `identifier_check` | channel facts `bounced_at` |

All writes go through one SQL function, `stats_record(enrollment_id, channel, event, at, ref_id)`, which only ever fills a null timestamp (first event wins) and enqueues a cache refresh (§5.3). Idempotent: the same event twice changes nothing.

Messages from Unipile `message_read` events: F2 matches `message_id` to our `messages.unipile_message_id` (outbound only) and sets `seen_at` if null.

### 4.3 Backfill

In the same migration, batched by workspace:
1. Lead facts from `actions` (sent touches, invites, withdrawals) joined to `enrollments`.
2. Acceptances from `lead_sender_state.invite_accepted_at` matched to the enrolment that sent the invite.
3. Replies from `messages` (inbound, human) with §3.4 credit, replayed in time order.
4. Positive from `messages.intent` and stage history.
5. Seen stays empty for history (read receipts weren't stored). The sequence page says "Seen from 26 Oct" for periods starting earlier.
6. Then fill `sequence_stats_cache` for every sequence.

---

## 5. Functions

### 5.1 Report functions (single source, D9)

| Function | Returns | Used by |
|---|---|---|
| `report_sequences(period, client_id?, channel?, status?)` | One row per sequence: `channels[]`, progress (`enrolled`, `live`, `done`, `pct_done`), `contacted`, `invited`, `accepted`, `accepted_rate`, `pending`, `accepted_early`, `accepted_split{linkedin,instagram}`, `replied`, `replied_rate`, `auto_replied`, `positive`, `positive_rate`, `meetings`, ops (`queued`, `failed`, `actions_sent`), and `na{accepted?: reason}` | Sequences list, Reports → Sequences, MCP `sequences_list`, `report_sequences`, API |
| `report_sequence(sequence_id, period)` | Header funnel (same fields), `channels[]` each with its stages (§3.2) and `from_earlier_version`, `replied_other_channel{channel: n}`, `li_replied_of_accepted`, `seen_since`, per-step and A/B stats (existing) | Sequence page, MCP `sequence_stats` / `report_sequence`, API |
| `sequence_channels(sequence_id, period)` | §3.3 | Both above |
| `metric_definitions()` | Updated text for Contacted, Accepted, Pending, Replied, Positive, Seen, cohort periods | Tooltips, MCP, API docs |

`period='all'` with no filters reads `sequence_stats_cache`. Everything else is computed from the fact tables (indexed by `sequence_id`).

### 5.2 Changed

- **F3 `complete_action()`** — calls `stats_record` for touch types, invites, follows, withdrawals.
- **F2 `process-inbound`** — acceptance, follow-back, `message_read`, human/auto inbound, reply credit.
- **F18 `ai-classify`** — `positive_at`, `auto_replied_at` for `ooo`.
- **IG followers poll / relations poll** — `accepted_at`, `declined`.
- **Stage change trigger** — `meeting_at`.

### 5.3 Cache refresh

`stats_record` sends `sequence_id` to a `pgmq` queue `stats_refresh`. A cron every 30 s takes distinct sequence ids from the queue and recomputes their `sequence_stats_cache` row. A busy sequence refreshes at most twice a minute; the list is never more than a minute behind.

### 5.4 New

| Fn | Trigger | Purpose |
|---|---|---|
| F54 `worker-stats-reconcile` | cron nightly (03:15 UTC) | For sequences with activity in the last 7 days, recompute the facts from `actions`, `messages`, `lead_sender_state` and stage history, compare with the stored facts, fix differences, log counts to `ops.stats_reconcile_log`. A difference on more than 1% of rows in a sequence raises a health alert |

```sql
select cron.schedule('stats-refresh',   '30 seconds',  $$select ops.invoke('stats-refresh')$$);
select cron.schedule('stats-reconcile', '15 3 * * *',  $$select ops.invoke('worker-stats-reconcile')$$);
```

---

## 6. Sequences list

### 6.1 Columns

| Column | Content | Example |
|---|---|---|
| Sequence | Name, then channel icons (in · ig · wa · ✉) for `channels[]`, then "49 steps · v4" | Kaptured.ai linkedin `in` |
| Status | As today: Active / Paused / Draft, throttled, **15 failed** | — |
| Client | As today | — |
| Senders | As today | 9 senders |
| **Progress** | Ring with `pct_done`, "549 live · 3 done" underneath | ◔ 1% |
| **Contacted** | Number | 113 |
| **Accepted** | Number, rate, pending; or NA ⓘ | 38 · 34% · 41 pending |
| **Replied** | Number, rate | 9 · 8% |
| **Positive** | Number, rate | 4 · 44% |

Live, Completed, Sent and Queued columns are removed. Queued and actions sent go to the hover (§6.3) and the sequence page.

Drafts: Progress, Contacted, Accepted, Replied, Positive show "—" (not started), not 0 or NA.

### 6.2 Controls

- **Period** selector above the table: All time (default) · 7d · 14d · 30d · 90d · Custom. A line under it explains the cohort (§3.5).
- **Channel** filter chips, showing only channels some sequence uses. Filtering by a channel shows sequences that use it; the numbers stay whole-sequence.
- **Sort** by any result column, by count or rate. Rates with a denominator under 20 sort last and show the rate greyed.

### 6.3 Tooltips (exact text)

| Element | Tooltip |
|---|---|
| Contacted | "113 people got at least one invite, follow or message from this sequence. That's 21% of the 549 enrolled. Visits and likes don't count." |
| Accepted | "38 of 113 connection requests accepted (34%). 41 still pending. LinkedIn 30 of 90 · Instagram 8 of 23." |
| Accepted, early | "Most requests are still pending, so this rate will change." |
| Accepted NA | "This sequence doesn't send connection requests or follows." |
| Replied | "9 of 113 people contacted replied (8%). Not counted: 2 out-of-office and auto-replies." |
| Positive | "4 of 9 replies were interested or asked a question. 1 meeting booked." |
| Progress | "549 live · 3 done · 37 actions queued · 113 actions sent" |
| Rate with small base | "Based on fewer than 20 people." |

---

## 7. Sequence page

### 7.1 Header funnel
Four tiles in a row: Contacted · Accepted · Replied · Positive, same numbers, rates and NA rules as the list, with the period selector. Under them: "Replied on another channel: 1 (email)" when non-zero.

### 7.2 Channel blocks
One block per channel from `sequence_channels`, in the order the sequence first uses them. Each block is a horizontal funnel with only the stages that exist for that channel (§3.2):

- **LinkedIn:** Contacted 113 → Invited 90 → Accepted 30 (33%) → Messaged 31 → Seen ≥ 22 → Replied 7 · "Of people who accepted, 23% replied"
- **Instagram:** Contacted 23 → Followed 23 → Followed back 8 → DM'd 12 → Seen ≥ 9 → Replied 2
- **WhatsApp:** Contacted 6 → Seen ≥ 5 → Replied 3 · Not on WhatsApp 1
- **Email:** Contacted 40 → Replied 2 · Bounced 3

"Seen" carries an ⓘ: "At least this many. People can turn read receipts off." For periods starting before Seen was recorded: "Seen counted from 26 Oct."

A block for a channel no longer in the current version shows the label "from an earlier version".

### 7.3 Existing per-step and A/B tables
Unchanged, below the blocks.

---

## 8. MCP and API

- `sequences_list` and `report_sequences` return the §5.1 row. `sequence_stats` and `report_sequence` return the §5.1 detail. All read the same functions (the outreach skill's "numbers come from one source" rule).
- Each response includes `na` reasons and `definitions_version`, and the `summary` string uses the new names ("113 contacted, 38 accepted of 113 invited (34%, 41 pending), 9 replied (8%), 4 positive").
- `metric_definitions` returns the §3 wording.
- Public API: same fields under `/v1/sequences` and `/v1/sequences/{id}/stats`. The old `sent` field stays for 90 days as `actions_sent`, marked deprecated.

---

## 9. Edge cases

| Case | Behaviour |
|---|---|
| Lead already connected before the sequence (no invite sent) | Counts in Contacted when messaged. Not in Invited, so doesn't affect the accept rate |
| Open Profile lead messaged by InMail | Contacted. Not invited |
| Lead re-enrolled in the same sequence with another sender | One person in every lead-level count. Accepted if either invite was accepted |
| Invite accepted after the lead exited (replied to another sequence) | Still counts as Accepted for the sequence that sent the invite |
| Invite sent manually, not by a sequence | No sequence gets the acceptance |
| Lead in two sequences replies | Credited to the one with the latest touch before the reply (§3.4) |
| Lead wrote first, before any sequence touch | No sequence credited |
| OOO first, real reply three days later | Replied at the real reply; OOO stays in the tooltip count |
| Reply on WhatsApp to a LinkedIn-only sequence | Replied; "Replied on another channel: 1 (WhatsApp)" |
| Sequence switches channels mid-flow (`channel_switch`) | Both channels' blocks show; the lead counts once in the header |
| Channel removed in a later version | Block stays for periods with activity, marked "from an earlier version" |
| Sender removed or erased (sender-lifecycle PRD) | Facts stay; numbers don't change |
| Action failed | Not a touch. Shows in the failed badge only |
| Sequence copied | New sequence starts with empty facts |
| Period with zero contacted | Rates "n/a", tiles "—" |

---

## 10. Rollout

| Phase | Contents |
|---|---|
| **1** | Migration, `stats_record`, writes from F2/F3/F18/polls, backfill, cache, F54 reconcile. Compare the backfilled Replied with today's Replied column for every sequence; differences must be explained by OOO/auto exclusion or reply credit |
| **2** | Sequences list: new columns, ring, tooltips, NA, period and channel filters, behind a flag on your own workspace first |
| **3** | Sequence page: header funnel, channel blocks, Seen, other-channel line |
| **4** | Reports → Sequences, MCP, API, outreach skill's `metrics.md` updated to the new names and definitions; deprecate `sent` |

---

## 11. Tests

- **Definitions:** one fixture workspace with a lead per edge case in §9; each metric asserted by name.
- **Same numbers everywhere:** list row = sequence page header = `report_sequences` = MCP `sequences_list` for every fixture sequence and period.
- **Cohort:** a lead contacted 30 Sep and accepted 2 Oct is in September's cohort as accepted and absent from October's.
- **Idempotency:** replaying a webhook doesn't change any count.
- **Reply credit:** two sequences, interleaved touches, one reply → exactly one credited.
- **NA:** email-only sequence → Accepted NA and Seen NA; LinkedIn invite-less sequence → Accepted NA.
- **Reconcile:** deleting a fact row is repaired by F54 and logged.
- **Performance:** list of 200 sequences under 300 ms from the cache; a sequence page with 50k enrolments and a 90-day period under 1 s.

---

## 12. Open questions

1. **Instagram follow in Contacted.** A follow has no message, but it's Instagram's version of a connection request, so it counts here, the same as a LinkedIn invite without a note. Confirm.
2. **Positive window.** 30 days after the credited reply for an `interested`/`question` message. Long enough for "message two" yeses without crediting a sale six months later.
3. **Declined invites.** LinkedIn doesn't say when an invite is declined; it just leaves the pending list. If the relations poll can't tell "declined" from "withdrawn by LinkedIn after expiry", both count as closed and pending drops; the rate stays accepted ÷ invited.
4. **Seen from Unipile.** Confirm `message_read` arrives for LinkedIn, Instagram and WhatsApp outbound sent through the API, and whether it carries our `message_id`.
