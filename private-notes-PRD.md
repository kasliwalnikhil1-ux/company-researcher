# PRD: Private Notes in the unified inbox

**Document:** Product Requirements Document — internal notes and @mentions inside inbox conversations
**Version:** 1.0 · 30 September 2026
**Builds on:** `linkedin-outreach-platform-PRD.md` (inbox §11.4, `chats`/`messages`/`members`/`tasks`, roles §11.3, Realtime §11.5, F15 `send-reply`, F27 `notify`), `web-chat-PRD.md` (§8 composer and notifications, §10 `messages.is_private`), `native-email-PRD.md`, `instagram-whatsapp-channels-PRD.md`, `ai-replies-changes.md` (handoff, Draft with AI, lead notes). All assumed shipped.
**Reference:** Chatwoot Private Notes — notes inside the conversation, invisible to the customer, amber highlight, `Alt + P` to switch between reply and note, `@` to mention a teammate (searchable, grouped by team), instant notification to mentioned teammates, rich text, attachments.

---

## 1. What we're building

A second mode in the inbox composer: **Reply** goes to the prospect, **Private note** stays inside the team. Notes sit in the conversation timeline between the real messages, highlighted in amber, and can @mention teammates, who get notified straight away.

Uses in this product:
- "@Naman she asked about pricing for 3 films, can you quote?" — ask for help.
- "Spoke to him on a call, budget is ₹4L, decision after Diwali" — context the next person needs.
- "@Priya taking over from AI — calendar link was sent, please confirm the slot" — handoffs, including AI handoffs.
- Agency ↔ client: "@client-Ravi is this lead a fit?" on notes shared with the client viewer.

Works on every channel in the unified inbox: LinkedIn, email, WhatsApp, Instagram, web chat.

---

## 2. Goals, non-goals

### 2.1 Goals
- A note can **never** reach a prospect, on any channel, through any code path, including AI drafts, exports and webhooks.
- Writing a note is as fast as writing a reply: same composer, one shortcut to switch.
- A mentioned teammate knows within seconds and lands on the exact note.
- Notes don't distort anything that measures the conversation: unread state, reply detection, response times, reply rates, AI handoff rules.

### 2.2 Non-goals (v1)
- Threaded replies to a note (reply with another note that mentions them).
- Notes on leads or companies outside a conversation. Lead-level facts live in Lead notes (`ai-replies-changes.md` §9.4).
- Reactions/emoji on notes, pinned notes, note templates.
- Slack/Teams delivery of mentions (after web-chat P5 Slack integration).

---

## 3. Key decision: notes get their own table

The web-chat PRD added `messages.is_private` to mark notes. This PRD replaces that with a separate `chat_notes` table.

Why: `messages` is read by every path that talks to the outside world or measures the conversation — Unipile sends, reply detection (F2), `ai-classify`, the AI reply engine's thread builder, `inbox_pending` "their words", email continuity digests, transcript emails, the web-chat widget API, outbound webhooks, CSV exports, reply-rate reports, SLA first-response. Each of those would need a `where is_private = false`, and one missed filter sends an internal note to a prospect or skews a metric. A separate table means none of those paths can see a note unless someone writes code that deliberately joins it.

Same principle as the platform's consent and authority gates: an invariant the database enforces survives a bug; a filter everyone has to remember doesn't.

Migration of any existing `messages.is_private = true` rows is in §11.

---

## 4. Composer

### 4.1 Two modes

```
┌ Reply ┬ Private note ┐                                      ⌥P / Alt+P to switch
├───────┴──────────────┴────────────────────────────────────────────────────────┐
│ (amber background in note mode)                                               │
│ @Naman she asked for 3 films, can you quote before Friday?                    │
│                                                                               │
├───────────────────────────────────────────────────────────────────────────────┤
│ 🔒 Only your team sees this   [Visible to client ☐]   📎  B  I  •  🔗          │
│                                                            [ Add note ⌘↵ ]    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- Tabs **Reply** / **Private note** above the box. Shortcut **Alt + P** (⌥P on Mac, matched on `event.code === 'KeyP' && event.altKey` so it works on keyboard layouts where ⌥P types a symbol).
- In note mode: whole composer amber (`--note-bg` token, with a dark-mode value), the lock line *"Only your team sees this"*, and the button reads **Add note**, never Send. The button in Reply mode stays **Send**.
- Reply and note keep **separate drafts**; switching modes never moves text between them. Drafts are saved per chat, per mode, in local state (and restored on reload).
- `Cmd/Ctrl + Enter` adds the note. Plain Enter makes a new line in note mode (notes are often multi-line).
- Composer rules that apply to replies don't apply to notes: sending is allowed when the sender is disconnected, when `members.can_reply = false` (a viewer can still leave a note), and when the chat's sequence is paused or the AI is replying.
- AI buttons (Draft with AI, Improve, Translate) are hidden in note mode except **Improve my text**, which works on note text without the prospect-facing checks.

### 4.2 Formatting and attachments
- Markdown subset: bold, italic, bullet and numbered lists, links, inline code, line breaks. Rendered with the same sanitiser as the rest of the app; no raw HTML.
- Max 10,000 characters.
- Attachments: up to 10 files, 25 MB each, any type; images show as thumbnails; pasting an image adds it. Stored in a private bucket, never attached to anything sent out (§8).

### 4.3 @mentions
- Typing `@` opens a picker: workspace members **who can read this conversation** (role and `client_ids` scope), grouped **Team** / **Client** (client viewers appear only when *Visible to client* is ticked). Search by name or email; arrow keys + Enter.
- The mention is stored as a token `@[Naman Shah](user:<uuid>)` and shown as a chip.
- People who can't read the conversation never appear in the picker. If a mention is typed by hand for someone without access, it stays plain text and the author sees *"Naman can't see this conversation — they won't be notified."*
- Max 20 mentions per note.

### 4.4 Visibility
| Visibility | Who sees it |
|---|---|
| `team` (default) | Owner, manager, member with access to the conversation |
| `team_and_client` | The above plus `client_viewer` members of the conversation's client |

- The *Visible to client* checkbox only appears when the conversation belongs to a client that has at least one client viewer.
- Client viewers can add notes too; theirs are always `team_and_client` (they can't write something they can't read).
- Visibility can be changed later by the author or a manager; changing to `team` hides it from client viewers immediately.

---

## 5. In the conversation timeline

```
                                       ┌──────────────────────────────────────┐
  Priya Nair · 10:42                   │ 🔒 Private note · Aarushi · 10:51     │
  "Sounds interesting, what would      │ @Naman she asked for 3 films, can you │
   3 films cost?"                      │ quote before Friday?                  │
                                       │ Seen by Naman · 10:53                 │
                                       └──────────────────────────────────────┘
```

- Notes are placed by `created_at` among the messages, full-width-right, amber, with a 🔒 *Private note* label, author avatar and name, time, and *Visible to client* tag when shared.
- Mention chips are highlighted; your own mention is highlighted more strongly.
- **Seen by:** each mentioned person's read state (*Seen by Naman · 10:53* / *Not seen yet*).
- **Edit:** the author, any time; shows *edited* with a revision history on hover (managers see the history).
- **Delete:** the author, or an owner/manager for any note. Leaves a placeholder *"Note deleted by Aarushi · 11:02"*; content purged after 30 days.
- **Make task** (⋯ menu): opens the task form pre-filled with the note text, linked to the conversation and lead, assigned to the first person mentioned.
- **Copy link:** deep link `/inbox/{chat_id}?note={note_id}` that scrolls to and flashes the note.
- A toggle in the thread header **Show notes** (default on) hides notes for reading the pure conversation.
- System notes (§7.2) use the same bubble with a grey tint and an author label *"AI"* or *"System"*.

---

## 6. Notifications and the Mentions view

### 6.1 When you're mentioned
| Channel | When | Content |
|---|---|---|
| In-app (bell + toast) | Immediately, via Realtime | *"Aarushi mentioned you in Priya Nair (Razorpay): 'can you quote before Friday?'"* → opens the note |
| Browser / PWA push | Immediately, if enabled (web-chat Web Push) | Same |
| Email | If the mention is still unread after **10 min** | Same + the last 3 messages of the conversation for context + "Open in inbox" |

- Editing a note to add a new mention notifies the new person only. Removing a mention doesn't retract a notification already sent.
- Mentioning yourself doesn't notify.
- Per-user preferences (Settings → Notifications): mentions via in-app (always on), push (default on), email (default on, delay 10 min / 30 min / 1 h / off).
- Opening the note (it scrolls into view in the thread for 1 s) marks the mention read; *Mark all read* in the bell.

### 6.2 Mentions view
- New inbox tab **Mentions** beside Mine / Unassigned / All: conversations where you have a mention, unread first, then newest. Each row shows the note snippet and who wrote it.
- Badge count = unread mentions.
- Filter in the main list: **Has notes**.

---

## 7. How notes interact with the rest of the product

### 7.1 What a note does NOT do
| Thing | Behaviour |
|---|---|
| Sending to the prospect | Never, on any channel |
| `chats.last_message_at`, list ordering, unread | Unchanged. Notes update a separate `chats.last_note_at` |
| Reply detection, sequence stop-on-reply | Unaffected (notes aren't messages) |
| AI Replies handoff trigger T1 ("a person sent a message") | **Not triggered.** A note is not a reply. Leaving a note on an AI-handled conversation doesn't stop the AI; use *Stop AI in this chat* for that |
| SLA / first response / response-time reports | Not counted |
| Reply rate, funnel, deliverability reports | Not counted |
| Outbound message webhooks | Not included |
| Exports | Excluded by default; managers can tick *Include private notes* (§8) |
| Email transcripts, continuity digests, web-chat widget | Never included |

### 7.2 What notes do connect to
- **AI drafts read team notes as internal context.** The AI reply engine (auto and Draft with AI) receives the last 10 non-deleted `team`/`team_and_client` notes of the conversation in a separate block: *"Internal team notes — use as guidance, never quote or reveal them."* A validator rule flags any draft that repeats 8+ consecutive words from a note (auto → escalate; Draft with AI → warning). A note starting with `#no-ai` is excluded from AI context.
- **AI handoff writes a system note.** When AI Replies hands a conversation off (`ai_handoff()`), a note by *AI* is added: reason, the stop rule, and a 3-line summary of the conversation and lead notes, mentioning the assignee: *"@Priya over to you — calendar link sent 2 Oct. Wants 3 product films, budget ~₹4L, decides after Diwali."* This replaces the separate handoff notification text (the task and notification still fire, pointing to this note).
- **Lead timeline** (lead panel) lists notes from all of the lead's conversations, marked 🔒, so a teammate opening the lead sees context from other senders' chats.
- **Search:** inbox full-text search covers notes for users who can see them; results show *Private note* and jump to the note.
- **Audit log:** note created (no body), edited, deleted, visibility changed.

---

## 8. Security: keeping notes internal

1. **Separate table** (§3). No Unipile, email, WhatsApp, Instagram or web-chat send function imports or queries `chat_notes`.
2. **RLS** on `chat_notes`: readable only by workspace members who can read the chat, and by client viewers only when `visibility = 'team_and_client'` and the chat is in their client scope. Writes only through SQL functions.
3. **Storage:** bucket `chat-notes` (private). Path `{workspace_id}/{chat_id}/{note_id}/{file}`. Storage policy calls `can_read_note(note_id)`. Signed URLs expire in 10 min. Send functions reject any attachment path under `chat-notes/`.
4. **Widget/public API** service-role functions are explicitly written against `messages` only; a CI check (grep-based lint) fails the build if `chat_notes` appears in `/functions/webchat-*`, `/functions/send-*`, `/functions/mail-*`, `/packages/unipile/*`, or the outbound-webhook builder.
5. **Exports** with *Include private notes* are manager-only, audit-logged, and marked in the file name (`…-with-notes.csv`).
6. **MCP:** notes appear in `inbox_thread` as `{type:'note', private:true, …}` and never inside `their_words`, `recent` or anything a draft is built from other than the AI block in §7.2.

---

## 9. Data model

```sql
-- 0067_chat_notes  (0068 if you applied ai-replies-changes.md via the §12.2 reconcile path)
create table chat_notes (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  chat_id        uuid not null references chats(id) on delete cascade,
  lead_id        uuid references leads(id) on delete set null,       -- denormalised for the lead timeline
  client_id      uuid references clients(id) on delete set null,     -- denormalised for RLS
  author_id      uuid references auth.users(id) on delete set null,
  author_type    text not null default 'user' check (author_type in ('user','ai','system','agent')),
  body           text not null check (char_length(body) between 1 and 10000),   -- markdown with mention tokens
  visibility     text not null default 'team' check (visibility in ('team','team_and_client')),
  mentions       uuid[] not null default '{}',
  attachments    jsonb not null default '[]',      -- [{path, name, size, mime, width?, height?}]
  exclude_from_ai boolean generated always as (body like '#no-ai%') stored,
  edited_at      timestamptz,
  deleted_at     timestamptz,
  deleted_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  search_tsv     tsvector generated always as (to_tsvector('simple', coalesce(body,''))) stored
);
create index on chat_notes(chat_id, created_at);
create index on chat_notes(lead_id, created_at desc);
create index on chat_notes using gin(search_tsv);

create table chat_note_revisions (
  note_id    uuid not null references chat_notes(id) on delete cascade,
  revision   int not null,
  body       text not null,
  edited_by  uuid references auth.users(id),
  edited_at  timestamptz not null default now(),
  primary key (note_id, revision)
);

create table chat_note_mentions (
  note_id      uuid not null references chat_notes(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  chat_id      uuid not null references chats(id) on delete cascade,
  created_at   timestamptz not null default now(),
  read_at      timestamptz,
  emailed_at   timestamptz,
  primary key (note_id, user_id)
);
create index on chat_note_mentions(user_id, read_at, created_at desc);

-- Notification centre (reuse if the web-chat build already created one with this shape)
create table if not exists notifications (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  kind         text not null,                  -- 'note_mention' | 'ai_handoff' | 'assigned' | …
  chat_id      uuid references chats(id) on delete cascade,
  note_id      uuid references chat_notes(id) on delete cascade,
  title        text not null,
  body         text,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index on notifications(user_id, read_at, created_at desc);

create table if not exists notification_prefs (
  user_id      uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  kind         text not null,
  push         boolean not null default true,
  email        boolean not null default true,
  email_delay_min int not null default 10 check (email_delay_min in (10,30,60)),
  primary key (user_id, workspace_id, kind)
);

alter table chats add column last_note_at timestamptz;

select pgmq.create('note_notifications');
```

### 9.1 Functions (SQL, `security definer`, all check the caller can read the chat)

| Function | Does |
|---|---|
| `note_create(chat_id, body, visibility, attachments)` | Validates length, visibility (client viewers forced to `team_and_client`), attachment paths belong to this chat's folder; parses mention tokens from `body` server-side, keeps only users who can read the chat (and, for `team`, excludes client viewers), caps at 20, drops self; inserts note, mentions, `notifications` rows; sets `chats.last_note_at`; enqueues `note_notifications`; audit log. Returns the note with `dropped_mentions[]` |
| `note_update(note_id, body?, visibility?)` | Author only (visibility: author or manager). Writes a revision, re-parses mentions, notifies **new** mentions only |
| `note_delete(note_id)` | Author or owner/manager; sets `deleted_at/by`; content purged by F46 after 30 days |
| `note_mark_read(note_id)` / `mentions_mark_all_read()` | Sets `read_at` on the caller's mentions and matching notifications |
| `can_read_note(note_id)` | Used by RLS and storage policy |
| `note_system_create(chat_id, body, author_type, mentions)` | Service role only; used by `ai_handoff()` (§7.2) |

RLS: `select` on `chat_notes` / `chat_note_mentions` / `notifications` per §8.2; no direct `insert/update/delete` grants — functions only.

---

## 10. Edge Functions and jobs

| Fn | Trigger | Purpose |
|---|---|---|
| F43 `note-attachment-upload` | HTTP (user JWT) | Returns a signed upload URL under `chat-notes/{ws}/{chat}/{pending-id}/` after checking access; max 25 MB |
| F44 `note-notify` | pgmq `note_notifications`, every 15 s | Push (web-chat Web Push) immediately; schedules the email check at `created_at + email_delay_min` |
| F45 `note-mention-email` | cron every minute | Mentions with `read_at is null and emailed_at is null` past their delay → one email per person per conversation (batched if several notes), via F27 `notify` |
| F46 `note-purge` | cron daily | Hard-delete note bodies and attachments deleted > 30 days ago |

Realtime subscriptions (added to platform §11.5):
- `chat_notes` insert/update filtered by `chat_id` for the open thread (RLS applies).
- `notifications` insert filtered by `user_id` → bell + toast.
- `chat_note_mentions` update → "Seen by" labels.

Changed:
- `ai_handoff()` → calls `note_system_create` with the summary and assignee mention (§7.2).
- AI reply engine `buildContext` → adds the notes block; validator adds the 8-word overlap rule.
- Inbox search RPC → unions `chat_notes.search_tsv` for readable notes.
- Export builder → optional notes sheet/column behind the manager toggle.

---

## 11. Migration from `messages.is_private`

If the web-chat build already created notes as `messages` rows with `is_private = true`:

```sql
-- part of 0067
insert into chat_notes (id, workspace_id, chat_id, lead_id, client_id, author_id, author_type, body, created_at)
select m.id, m.workspace_id, m.chat_id, c.lead_id, s.client_id, (m.content_attributes->>'author_id')::uuid,
       'user', coalesce(m.text,''), m.created_at
from messages m join chats c on c.id = m.chat_id left join senders s on s.id = c.sender_id
where m.is_private and coalesce(m.text,'') <> '';
delete from messages where is_private;
alter table messages add constraint messages_no_private check (is_private = false);
-- drop the column in the next release once no code writes it
```

The web-chat composer's note mode is switched to `note_create`. Mentions inside migrated notes are re-parsed but not re-notified.

---

## 12. MCP

| Tool | Behaviour |
|---|---|
| `inbox_thread` | Adds notes as `{type:'note', private:true, author, body, mentions, created_at}` interleaved by time |
| `inbox_pending` | Adds `notes_count` and the latest note snippet per thread; never mixed into `their_words` / `recent` |
| `note_add(chat_id, body, mentions?, visibility?)` | Write, not confirmation-gated (can't reach a prospect). `author_type = 'agent'`, shown as *"Claude (via Aarushi)"*. Unattended tokens may add notes but **may not mention** anyone (prevents notification spam); 60 notes/hour per token |
| `mentions_list(unread_only?)` | The caller's mentions |

---

## 13. Edge cases

| Case | Behaviour |
|---|---|
| Prospect message arrives while a note is being typed | Timeline updates; the note draft is untouched |
| User switches to Reply with note text in the box | Note draft kept; reply box shows its own draft |
| Mentioned person later loses access (removed, client scope changed) | They can't open it; the notification shows *"You no longer have access"*; chip shows the name without a link |
| Mentioned person removed from the workspace | Chip shows *"former member"* |
| Note visible to client, then changed to team | Hidden from client viewers immediately (RLS + Realtime delete event to their session) |
| Client viewer mentions an agency teammate | Allowed; note is `team_and_client` |
| Conversations merged (web chat) | Notes move with messages to the surviving chat |
| Chat deleted | Notes, mentions, attachments deleted (cascade + storage cleanup job) |
| Note added on an AI-handled conversation | AI keeps replying; the note is AI context unless it starts with `#no-ai` |
| AI draft repeats note wording | Auto: escalate; Draft with AI: warning |
| Sender disconnected / `can_reply = false` | Notes still allowed |
| Very long pasted text | Hard stop at 10,000 chars with a counter |
| Note with only an attachment | Allowed; body becomes the file name(s) |
| Someone opens a deep link to a deleted note | Scrolls to the placeholder |
| 50 mentions pasted | First 20 kept; author told the rest were dropped |

---

## 14. Rollout

| Phase | Contents |
|---|---|
| **P1** | Table, functions, RLS, composer modes + Alt+P, timeline rendering, edit/delete, @mentions with in-app notifications, Realtime, CI lint (§8.4), `is_private` migration |
| **P2** | Attachments, push + email notifications with preferences, Mentions tab, "Seen by", search, deep links, Make task |
| **P3** | Visible-to-client notes, AI context + overlap check, AI handoff summary notes, lead-timeline notes, MCP tools, export option |

---

## 15. Tests

- **Leak tests (must pass before P1 ships):** create notes with unique marker strings, then run every outbound path — LinkedIn/WhatsApp/Instagram send, email send, continuity digest, transcript email, widget history API, outbound webhooks, CSV export (default), public API, MCP `inbox_pending` — and assert the marker appears in none.
- RLS: member outside the client scope, client viewer on `team` note, client viewer on `team_and_client` note, removed member — read and write attempts.
- Mentions: picker lists only people with access; hand-typed mention of a no-access user doesn't notify; self-mention doesn't notify; edit adds a mention → only the new person notified; 20-mention cap.
- Notifications: in-app within 2 s; email only if unread after the delay; batching of several notes; preferences honoured.
- Metrics unaffected: adding notes doesn't change unread, `last_message_at`, reply detection, SLA or reply-rate numbers.
- AI: notes present in the context block; `#no-ai` excluded; 8-word overlap flagged; a note never triggers handoff.
- Composer: Alt+P on Mac and Windows layouts; separate drafts survive reload; Cmd/Ctrl+Enter adds the note; Send button never appears in note mode.
- Storage: attachment URLs fail for users without note access; send functions reject `chat-notes/` paths.

---

## 16. Metrics

Notes per 100 conversations, share of conversations with ≥ 1 note, mentions per day, **mention response time** (mention → the mentioned person's next note or reply in that conversation; p50/p90), unread mentions older than 24 h, share of AI handoffs picked up within 1 h of the handoff note.
