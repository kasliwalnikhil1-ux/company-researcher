# PRD: Replies / Sent in the unified inbox

**Document:** Change PRD — the inbox gets two views, split by who wrote
**Version:** 1.0 · 6 October 2026
**Applies to:** the inbox as built (`/outreach/inbox`), including private notes (`private-notes-PRD.md`), the AI hub (`ai-hub-unified-ui-changes.md`), AI replies v1.2 (`ai-replies-v1_2-changes.md`), native email, website chat and the Instagram / WhatsApp channels.
**Migration:** `0NN_inbox_replies_sent` (next free number).
**Names:** tables and columns follow the specs (`chats`, `messages`, `actions`, `ai_reply_runs`). The build prefixes tables with `outreach_`; adjust.
**Checked:** GetSales API docs (emails endpoint) and help centre (FAQ, September 2025 release notes), 6 Oct 2026.

---

## 0. Summary

| # | Change |
|---|---|
| 1 | The inbox gets a view switch at the top of the list: **Replies** · **Sent** |
| 2 | **Replies** lists conversations where the other person has written. Today's tabs (Mine, Unassigned, All, Mentions) and filters live inside it, unchanged |
| 3 | Three new chips in Replies: **All · Needs reply · Waiting on them** |
| 4 | **Sent** lists one row per thing we sent, in three segments: **Sent · Scheduled · Failed** |
| 5 | Every Sent row shows who sent it (sequence step, teammate, AI, outside the app) and what happened to it (delivered, read, accepted, replied, bounced) |
| 6 | Conversations nobody has answered leave the main list. They stay reachable from Sent, search and the lead page |
| 7 | The AI feature currently labelled "Replies" becomes **AI replies**, so the two names don't collide (decision D1) |

No sending behaviour changes. This is a new way to look at data the platform already has.

---

## 1. Why

Today the inbox is one list of conversations. Every first message a sequence sends creates a conversation, so the few conversations where someone answered sit among the many where nobody has. Four questions are hard to answer from that list:

1. Who wrote to us and is waiting for an answer?
2. Did step 2 go out to Priya, from which account, with which text?
3. What goes out next, and when?
4. What failed to send, and why?

Replies answers the first. Sent answers the other three.

### 1.1 What GetSales does

| Verified | Source |
|---|---|
| Their emails API has a `type` field with two values, `inbox` and `outbox`, and a list endpoint (`GET /emails/api/emails`) that filters by type, status, mailbox, lead, flow, address and date | GetSales API docs |
| A newly sent email has status `waiting` | GetSales API docs |
| Their Messenger is one list with filters: Automation, List, Tag, Last message | Help centre, September 2025 release notes |
| LinkedIn messages sync almost at once (delays up to about 5 minutes); emails sync every 20 minutes | Help centre FAQ |

Not found in their docs: a separate Outbox screen in the app. As far as their documentation shows, inbox/outbox is a field on the message, and the app shows one list. So this PRD takes their data concept and makes it a visible split, which their app doesn't appear to do.

---

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| **D1** | Inbox views are named **Replies** and **Sent**. The AI feature that the AI hub named "Replies" is relabelled **AI replies** everywhere (sidebar AI pages, Needs you chips and cards, Setup card, notifications, MCP wording). Label change only, no data change | The two would otherwise mean opposite things: inbox Replies = what prospects wrote; AI "Replies" = what the AI writes, which belongs under Sent. See §12 Q1 if you'd prefer to keep the AI name and change something else |
| **D2** | Replies is a list of **conversations**. Sent is a list of **individual sends** | You answer a conversation. You audit a send. An email client works the same way |
| **D3** | Scheduled and Failed are segments inside Sent, not top-level views | Keeps the switch to the two names you picked. Both are "our side" of the conversation |
| **D4** | Website chat messages are not listed in Sent | A live chat is dozens of short bubbles; listing each one buries the outreach sends. The conversation itself is in Replies |
| **D5** | The data field stays `direction: in \| out`. The words "inbox" and "outbox" aren't used anywhere, in the app, the API or the MCP | One vocabulary: Replies / Sent in the UI, in / out in data |
| **D6** | Sent doesn't add a way to start a new conversation with someone | First contact stays in sequences, where the allowance, working hours and blacklist checks are. The composer still only replies inside an existing conversation |

---

## 3. What counts

### 3.1 Replies

A conversation is in Replies when **the other person has written at least one message in it**.

| Included | Not included |
|---|---|
| Replies to a sequence step or to a teammate's message | Conversations that only contain our messages (they're in Sent) |
| A reply to a connection-request note, even if they didn't accept | Email bounces (shown on the Sent row instead) |
| People who wrote first: LinkedIn, WhatsApp, Instagram, email | Reactions with no message |
| Every website chat (the visitor always writes first), including voice calls | Private notes (never count as a message) |
| Auto-replies and out-of-office messages, tagged **Auto-reply** | |

"Replies" also holds people who wrote first, so the tooltip on the tab reads: *"Conversations where the other person has written."* A row where they wrote first shows a small **Wrote first** tag.

**Chips** (apply inside whichever tab is selected):

| Chip | Rule | Sort |
|---|---|---|
| **All** (default) | Everything in Replies | Latest message first, as today |
| **Needs reply** | Their message is the latest, the conversation is open (not resolved, not snoozed), and the AI isn't currently answering it | Longest waiting first, with the wait shown ("waiting 3 h") |
| **Waiting on them** | Our message is the latest | Latest message first |

- An auto-reply never moves a conversation into Needs reply.
- "The AI is currently answering it" = the conversation's sequence has AI replies on **Auto**, the conversation hasn't been handed off (`chats.ai_handed_off_at is null`), and the AI's run for their latest message is still in progress or waiting to send. A conversation shows in Needs reply as soon as the AI hands off, the run is escalated or fails, or the sequence is on Review or Off.
- The base rule (their message is the latest, conversation open) is the one the MCP's `inbox_pending` uses. `inbox_pending` also returns the conversations the AI is answering, marked `ai.state = 'replying'`; the chip leaves those out.

### 3.2 Sent

One row per thing a person on the other side receives from us.

| Listed | Not listed |
|---|---|
| Connection requests, with or without a note | Profile visits, likes, follows, endorsements, withdrawals (they're in the lead timeline) |
| LinkedIn messages and InMails | Public comments on posts (§12 Q3) |
| Emails | Website chat messages (D4) |
| WhatsApp and Instagram messages | Private notes |
| Replies typed in the inbox by a teammate | Anything sent before the account was connected to us (old history stays in the conversation only) |
| AI replies | |
| Messages the account owner sent from LinkedIn or their phone | |

**Segments:**

| Segment | Contains | Sort | Default range |
|---|---|---|---|
| **Sent** (default) | Everything that went out | Newest first | Last 7 days |
| **Scheduled** | Sends that have a planned time and haven't gone out: sequence steps planned for today and the next working day, AI replies in their hold, replies queued until working hours | Soonest first | All upcoming |
| **Failed** | Sends that didn't go out, and emails that bounced | Newest first | Last 7 days |

Scheduled only shows sends the planner has already given a time. Steps further out don't have a time yet; they stay in the sequence's own queue view.

### 3.3 By channel

| Channel | Appears in Replies when | Listed in Sent |
|---|---|---|
| LinkedIn | They message in a 1:1 chat, reply to a note, or answer an InMail | Connection requests, messages, InMails |
| Email | A person's reply is matched to a thread. Auto-replies are tagged. Bounces don't count | Emails from sequences and from the inbox |
| WhatsApp | Any message from them | Messages, including the first message of a new chat |
| Instagram | Any message from them, including message requests | Messages |
| Website chat | Always (visitor writes first) | Not listed |

---

## 4. UI

### 4.1 Layout

```
Inbox
┌─────────────────────────────────────────────┐
│ [ Replies  12 ]  [ Sent • ]                 │  ← view switch
├─────────────────────────────────────────────┤
│ Replies:                                    │
│  Mine · Unassigned · All · Mentions         │  ← today's tabs
│  (All) (Needs reply 5) (Waiting on them)    │  ← new chips
│  Filters ▾   Search…                        │  ← today's filters
│  ── conversation rows ──                    │
└─────────────────────────────────────────────┘

┌─────────────────────────────────────────────┐
│ [ Replies  12 ]  [ Sent • ]                 │
├─────────────────────────────────────────────┤
│ Sent:                                       │
│  Sent · Scheduled 38 · Failed 3             │  ← segments
│  Filters ▾   Last 7 days ▾   Search…        │
│  ── send rows, grouped by day ──            │
└─────────────────────────────────────────────┘
```

| Route | View |
|---|---|
| `/outreach/inbox` | Replies |
| `/outreach/inbox/sent` | Sent · Sent |
| `/outreach/inbox/sent?segment=scheduled` | Sent · Scheduled |
| `/outreach/inbox/sent?segment=failed` | Sent · Failed |
| `/outreach/inbox/[chatId]` | Conversation, unchanged. Add `?m=<message id>` to scroll to and flash one message |

The app remembers each person's last view, tab, chip and segment. A new user lands on Replies · Mine · All.

On narrow screens the view switch is a two-button control above the list; segments and chips scroll sideways.

### 4.2 Replies

- Rows, tabs, filters, assignment, labels, snooze, resolve and unread work exactly as today. The only change to the list is that conversations with no message from the other person are gone from it.
- New on the row: **Wrote first** tag, **Auto-reply** tag, and in Needs reply the waiting time.
- **Mentions** is the one tab that ignores the Replies rule. A note can mention someone on a conversation nobody has answered, and that mention must still be found.
- Filters added: none. *Handed off by AI*, *Has notes*, sequence, sender, client, channel and intent stay as they are.

### 4.3 Sent

**Row:**

```
To                        What                                      From                 Status        When
Priya Nair · Razorpay     "Thanks for connecting, Priya. Quick…"    Naman · LinkedIn     Replied       10:42
                          Fintech CFOs · Step 2 · B
Rahul Mehta · Loomcraft   Connection request · "Hi Rahul, saw…"     Naman · LinkedIn     Accepted      10:15
Karin Elwin · J.Lindeberg "Re: product films for AW26"              aarushi@… · Email    Sent          09:58
                          Sent by Naman
```

| Column | Content |
|---|---|
| To | Lead name and company. Click opens the lead panel |
| What | Type when it isn't a plain message (Connection request, InMail), the email subject, and the first line of the text. Second line: where it came from (below) |
| From | The sender it went out from, with the channel icon |
| Status | One status, the furthest reached (below) |
| When | Time sent, planned time, or time it failed. Workspace timezone |

**Where it came from** (second line, also a filter):

| Source | Shown as |
|---|---|
| Sequence | "Fintech CFOs · Step 2 · B" (sequence · step · A/B variant), linked to the sequence |
| Teammate | "Sent by Naman". With an **AI draft** tag when they sent or edited an AI draft |
| AI | "AI reply" |
| Outside the app | "Sent from LinkedIn" / "Sent from phone or another app" |

**Status** (one per row):

| Status | Meaning | Channels |
|---|---|---|
| Scheduled · 14:20 | Has a planned time | All |
| Held · *reason* | Past its planned time and blocked: outside working hours, daily allowance used, sender needs reconnecting, sequence paused | All |
| Sending | Going out now | All |
| Sent | Handed to LinkedIn, the mail server, WhatsApp or Instagram | All |
| Delivered · Read | The provider reported it | LinkedIn, WhatsApp, Instagram. Not email (no open tracking) |
| Accepted | Connection request accepted | LinkedIn |
| **Replied** | They answered this message | All |
| Failed · *reason* | Didn't go out | All |
| Bounced | Email came back | Email |

- Order when several apply: Replied, then Accepted, Read, Delivered, Sent.
- A send counts as **Replied** when the next message in that conversation is from the other person. This must give the same answer as the step statistics and the "answering" field in `inbox_pending`; if the build's rule differs, use the build's rule here.
- An auto-reply doesn't mark a send as Replied.
- Held reasons use the same causes and wording as *Why isn't it sending*.

**Filters:** sender (multi-select, plus **My senders**), client, channel, source, sequence, type (connection request / message / InMail / email), got a reply (yes / no), date range, search on recipient name and message text. Maximum range per query is 90 days.

**Row actions:**

| Segment | Row is | Actions |
|---|---|---|
| Sent | Any | Open conversation · Open lead · Copy text |
| Scheduled | Sequence step | Edit text · Pause this lead · Remove from sequence |
| Scheduled | AI reply in its hold | Send now · Edit · Cancel (the same three as the banner in the conversation) |
| Scheduled | Reply queued until working hours | Edit · Cancel |
| Failed | Sequence step | Retry · Skip this step · Remove from sequence, with the reason and what to do about it |
| Failed | Bounced email | Open lead (to fix the address) |

- These call the functions that already exist for the same actions (queued-step edit, lead pause / exit, failed-lead recovery, the AI hold actions). Sent adds no new way to change a send, and no "send now" for sequence steps: their timing is what keeps accounts safe.
- Bulk select in Scheduled and Failed for the lead-level actions, with the usual preview of who is affected before confirming.
- **Export CSV** (managers): the visible columns for the current filters.

### 4.4 Opening things

- Clicking a Sent row opens the conversation at that message. A connection request with no conversation yet opens the lead panel instead.
- A conversation nobody has answered opens normally. Its header shows **No reply yet** and the composer works as today.
- When someone answers, the conversation appears in Replies straight away and its queued steps leave Scheduled (stop-on-reply already cancels them).

### 4.5 Counts

| Where | Number |
|---|---|
| **Replies** tab | Unread conversations, counted the way the sidebar Inbox badge counts them today. A conversation nobody has answered can't be unread, so that number doesn't change |
| **Needs reply** chip | Conversations matching the chip rule |
| **Scheduled** segment | Sends waiting to go out |
| **Failed** segment | Failed sends in the last 7 days that nobody has acted on |
| **Sent** tab | No number. A red dot when Failed isn't empty |

The Replies badge is unread conversations. It isn't the "replies received" figure in reports, which counts replies in a date range.

### 4.6 Search

One search box. Results come in two groups, **Replies** (conversations) and **Sent** (individual sends), each showing its top 5 with "show all". Notes stay searchable as today.

### 4.7 Wording

| Place | Text |
|---|---|
| Tab tooltips | Replies: "Conversations where the other person has written." · Sent: "Everything that went out from your senders, and what's about to." |
| Replies, empty | "No replies yet. When someone answers, the conversation shows up here." |
| Needs reply, empty | "You're all caught up." |
| Sent, empty | "Nothing sent in this period." |
| Scheduled, empty | "Nothing is scheduled to go out." with a link to *Why isn't it sending* |
| Failed, empty | "No failed sends." |
| Conversation header, no inbound | "No reply yet" |

### 4.8 Who sees what

- Both views follow today's access rules: a member sees the clients and senders they're scoped to.
- Sent row actions need the same role as the action they call.
- **Client portal** (`/c/[clientId]`): client viewers get both views, read-only, limited to their client. Workspace setting **Show Sent to clients**, on by default.

---

## 5. Data

```sql
-- 0NN_inbox_replies_sent
alter table chats
  add column first_inbound_at timestamptz,   -- null = nobody has written back
  add column last_inbound_at  timestamptz,   -- last message from a person (auto-replies excluded)
  add column last_outbound_at timestamptz;

alter table chats
  add column waiting_on text generated always as (
    case when last_inbound_at is null then null
         when last_outbound_at is null or last_inbound_at > last_outbound_at then 'us'
         else 'them' end) stored;

alter table messages
  add column replied_at timestamptz;         -- set on our message when their next message arrives

create index chats_replies_idx     on chats (workspace_id, last_message_at desc)
  where first_inbound_at is not null and archived = false;
create index chats_needs_reply_idx on chats (workspace_id, last_inbound_at)
  where waiting_on = 'us' and archived = false;
create index messages_sent_idx     on messages (workspace_id, sent_at desc) where direction = 'out';
create index actions_scheduled_idx on actions  (workspace_id, scheduled_for) where status in ('queued','reserved');
create index actions_failed_idx    on actions  (workspace_id, executed_at desc) where status = 'failed';
create index actions_invites_idx   on actions  (workspace_id, executed_at desc)
  where status = 'sent' and action_type = 'invite';
```

**Trigger on `messages` insert** (`chat_direction_touch`):

| New message | Effect on the chat | Effect on messages |
|---|---|---|
| From them, a person | `first_inbound_at = least(existing, sent_at)`, `last_inbound_at = greatest(existing, sent_at)` | Our latest earlier message in the chat with `replied_at is null` gets `replied_at = sent_at` |
| From them, an auto-reply (`is_auto_reply`) | `first_inbound_at` only | None |
| From us | `last_outbound_at = greatest(existing, sent_at)` | None |

- `least` / `greatest` make it safe when messages arrive out of order (history sync, messages delivered after a reconnect).
- `waiting_on` is generated from the two timestamps, so it can't drift.
- `chat_direction_recompute(chat_id)` rebuilds the three timestamps and `replied_at` from the chat's messages. It runs when a message is deleted, and when the classifier marks a LinkedIn / WhatsApp / Instagram message as out-of-office after it was first counted as a person's reply.
- Notes are in their own table and never touch any of this.

**Backfill** (same migration, batched by workspace): set the three chat timestamps and `messages.replied_at` from existing messages. Run before the views are switched on.

### 5.1 `sent_items` view

One row per send. `security_invoker = true`, so each user sees only what the underlying tables already let them see.

```
id, workspace_id, client_id, sender_id, lead_id, chat_id, message_id, action_id, ai_reply_run_id,
channel,        -- LINKEDIN | EMAIL | WHATSAPP | INSTAGRAM
type,           -- connection_request | message | inmail | email
source,         -- sequence | teammate | ai | outside_app
sequence_id, step_label, variant_label, sent_by, from_ai_draft,
subject, preview,          -- first 140 characters
segment,        -- sent | scheduled | failed
status,         -- scheduled | held | sending | sent | delivered | read | accepted | replied | failed | bounced
status_reason,  -- error code or hold cause
at              -- sent time, planned time or failure time
```

Built from:

| Segment | Rows |
|---|---|
| Sent | `messages` where `direction = 'out'`, the chat isn't a website chat, the message isn't an accepted connection note, and `sent_at` is on or after the sender's `connected_at` |
| Sent | `actions` where `action_type = 'invite'` and `status = 'sent'` (a connection request has no message row; its note, once accepted, is not listed a second time) |
| Scheduled | `actions` where the type is a send (invite, message, InMail, email, first WhatsApp / Instagram message, queued reply) and `status in ('queued','reserved')` |
| Scheduled | `ai_reply_runs` where `status = 'scheduled'` |
| Failed | `actions` of a send type where `status = 'failed'`, and outbound emails marked bounced |

`source` comes from `messages.origin` (`sequence`, `inbox_user`, `ai_autopilot`, `ai_draft_sent`, `ai_edited`, `external_device`) or, for rows that are still actions, from the action's enrollment or AI run. `ai_draft_sent` and `ai_edited` are `source = 'teammate'` with `from_ai_draft = true`.

---

## 6. Functions

| Function | Does |
|---|---|
| Existing inbox list RPC | Gains `view = 'replies'` (adds `first_inbound_at is not null`; ignored for the Mentions tab) and `chip = 'all' \| 'needs_reply' \| 'waiting_on_them'`. `view` defaults to `'replies'` |
| `inbox_sent_list(segment, filters, cursor, limit)` | Reads `sent_items`. Each source is queried with the same `(at, id)` cursor and limit, then merged, so paging stays fast at any depth. Limit 50, maximum 100 |
| `inbox_counts(tab)` | Returns `{replies_unread, needs_reply, scheduled, failed}` in one call |
| `inbox_search(q)` | Gains the Sent group (§4.6) |

- Replies keeps today's Realtime subscriptions (new messages, chat updates), so a first reply makes the conversation appear without a refresh.
- Sent and the counts refetch every 60 seconds and on window focus. A reply sent from the composer is added to Sent optimistically.
- Target: first page of either view in under 300 ms at 20 million messages.

No new Edge Functions.

---

## 7. MCP and API

| Tool | Change |
|---|---|
| `inbox_list` | Accepts `view: 'replies'` (default) and `chip`. Passing `view: 'all'` returns every conversation, as before |
| `inbox_sent_list(segment?, filters?)` | New, read-only. Same rows as the page |
| `inbox_pending` | Unchanged. It is Replies · Needs reply, plus the conversations the AI is answering (marked `ai.state = 'replying'`) |
| `inbox_thread` | Our messages add `status` and `replied_at` |

- Public API: messages keep `direction: "in" | "out"`. Add a Sent list endpoint with the same filters as the page.
- The `/outreach` skill: say Replies and Sent for the inbox views and **AI replies** for the AI feature (D1).

---

## 8. Edge cases

| Case | Behaviour |
|---|---|
| Connection request with a note is accepted | One Sent row (the request), status Accepted. The note appears in the conversation and isn't listed twice |
| They reply to the note without accepting | Conversation appears in Replies. The Sent row shows Replied |
| Out-of-office comes back | Conversation appears in Replies tagged Auto-reply. Not in Needs reply. The send isn't marked Replied |
| Email bounces | Sent row moves to Failed as Bounced. Nothing appears in Replies |
| Account owner replies from their phone | Row appears in Sent as "Sent from phone or another app". The conversation moves to Waiting on them |
| Our own send comes back through the webhook before we saved it | Matched to the same row (existing rule), never listed twice |
| A sent message is edited or deleted within LinkedIn's 60 minutes | Row shows the edited text, or a **Deleted** tag |
| Someone replies while later steps are queued | The steps are cancelled and leave Scheduled. The conversation appears in Replies |
| Sequence paused | Its queued steps show Held · sequence paused. AI replies that were waiting to send go back to drafts (existing rule) and leave Scheduled |
| Lead blacklisted | Its queued sends are cancelled and leave Scheduled |
| Sender disconnected | Its rows show Held · sender needs reconnecting, with a link to the sender |
| AI is about to answer | The conversation isn't in Needs reply. The AI's reply is a row in Scheduled |
| AI hands off to a person | The conversation appears in Needs reply |
| Same lead on two senders | Two conversations and two sets of Sent rows, each under its own sender |
| A mention on a conversation nobody has answered | Found in the Mentions tab |
| Messages synced from before the sender was connected | In the conversation, not in Sent |
| Messages arrive out of order after a reconnect | Timestamps use least / greatest, so the chips stay right |
| The sender owner's personal chats that synced in | Unchanged from today (§12 Q4) |
| 100 senders sending all day | Sent is paged, defaults to 7 days and is capped at 90 days per query |

---

## 9. Rollout

| Step | Contents |
|---|---|
| 1 | Migration, trigger, backfill, `inbox_counts`. Replies view with the three chips behind a flag on your own workspace. Check the unread badge didn't change |
| 2 | Sent · Sent segment: rows, statuses, source line, filters, open-at-message link, search group |
| 3 | Scheduled and Failed segments with their actions and bulk select. Red dot on the Sent tab |
| 4 | D1 relabel to AI replies. MCP tools, public API, skill wording. Client portal views and setting. CSV export |
| 5 | Product tour demo: seed Sent, Scheduled and Failed from the simulator's actions so the demo inbox has the same two views |

Flag off = today's single list. Nothing in steps 1–3 changes what gets sent.

---

## 10. Tests

- A conversation with only our messages is absent from Replies and present in Sent. The first message from them moves it into Replies within 5 seconds.
- Needs reply returns the same conversations as `inbox_pending` minus the rows with `ai.state = 'replying'`, for the same user and filters.
- Auto-replies: tagged, never in Needs reply, never mark a send Replied.
- `waiting_on` is right after messages are inserted out of order, after a delete, and after an out-of-office reclassification.
- Every send type appears in Sent exactly once: request without note, request with note (before and after acceptance), message, InMail, email, inbox reply, AI reply, phone reply.
- Replied on a Sent row matches the step statistics for the same sequence and period.
- Scheduled: a row leaves on send, cancel, reply, blacklist and sequence archive. Held shows the same reason as *Why isn't it sending*.
- Failed actions call the existing recovery and produce the same result as doing it from the sequence.
- Website chat messages and notes never appear in Sent.
- Access: a member outside a client's scope and a client viewer see no rows from other clients in either view.
- The sidebar unread number is the same before and after the migration.
- Paging: no missing or duplicated rows across pages while new sends arrive.

---

## 11. Metrics

- Median time from a person's reply to our answer (should fall).
- Conversations in Needs reply older than 24 hours.
- Failed sends acted on within 24 hours.
- Share of inbox sessions that open Sent, and which segment.

---

## 12. Open questions

1. **The name clash (D1).** The AI hub named the AI feature "Replies". This PRD relabels it "AI replies". The alternative is to keep that name and call the inbox views "Received / Sent". Your pick of Replies / Sent is assumed here.
2. **Website chat in Sent (D4).** Left out. If agents want a record of what they sent in chats, add a channel filter option that includes it, off by default.
3. **Public comments.** A sequence can comment on a lead's post. It's something they see from us, but it isn't a message. Left out; say if it should be a type in Sent.
4. **Personal chats.** When a LinkedIn account connects, its owner's existing personal conversations sync in. Whether those show in the inbox today wasn't in the specs I could read. This PRD doesn't change it, but they would count in Replies if they show today.
5. **One row per person.** "Got a reply: no" lists every unanswered send, so someone on step 3 appears three times. A "latest send per person" toggle is a likely follow-up.
6. **Delivered / Read.** Unipile sends these events. Confirm the build stores them per message; if not, those two statuses wait until it does.
