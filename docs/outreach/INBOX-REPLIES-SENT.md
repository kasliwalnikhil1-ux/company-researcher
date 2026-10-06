# Replies / Sent in the inbox — build contract

Source: `inbox-replies-sent-PRD.md` (6 Oct 2026). Migration `075_inbox_replies_sent.sql`, smoke test
`tests/smoke_20_inbox_replies_sent.sql` (20 assertions). This file is the contract every surface (app, demo, MCP, public
API, client portal) builds against, plus every place the build differs from the PRD.

## 1. Data (075)

`outreach_chats` (maintained by the database; a browser's direct `update outreach_chats` never changes them):

| Column | Meaning |
|---|---|
| `first_inbound_at` | null = nobody on the other side has written → the conversation is **not** in Replies. Auto-replies count, bounces do not. Every website chat has it (the visitor writes first). |
| `last_inbound_at` | their last **person** message (auto-replies and bounces excluded) |
| `first_outbound_at`, `last_outbound_at` | our first / last message (system events and CSAT surveys excluded) |
| `last_auto_reply_at` | their latest out-of-office; the row shows **Auto-reply** while `last_auto_reply_at > coalesce(last_inbound_at, -inf)` |
| `waiting_on` | generated: `'us'` their message is the latest · `'them'` ours is · null they never wrote (person) |
| `ai_answering` | the AI is answering their latest message: Auto, not handed off, run debouncing / drafting (Auto run) / scheduled / sending. Website chat: agent on (not Review), not handed off |

`outreach_messages`: `replied_at` (on ours: their next message arrived; also set on the step a reply is credited to, so
it matches the step statistics), `is_auto_reply` (classifier intent `ooo`, or an email auto-reply subject; correcting the
intent away from `ooo` clears it), `is_bounce` (same rule as the webhook's `email_bounced`), `bounced_at` (on our email).

Rules:
- **Replies** = `first_inbound_at is not null`. The **Mentions** tab ignores this rule (it is its own list).
- **Needs reply** = `waiting_on = 'us'` and `archived = false` and `status not in (resolved, snoozed)` and `not ai_answering`; sort `last_inbound_at asc, id asc`, show "waiting 3 h".
- **Waiting on them** = `waiting_on = 'them'`; sort as All (latest message first).
- `inbox_pending` (MCP) base rule = `waiting_on = 'us'` + open status (no `ai_answering` filter: those threads come back marked `ai.state = 'replying'` / `handled_by_ai`).
- **Wrote first** tag = `first_inbound_at` set and (`first_outbound_at` null or `first_inbound_at < first_outbound_at`), not website chat.
- **No reply yet** (thread header) = `first_inbound_at is null` and not website chat.

## 2. RPCs (all `security definer`, `outreach_require(ws, 'client_viewer')` + per-row `outreach_client_visible`)

### `outreach_inbox_sent_list(p_ws uuid, p_segment text = 'sent', p_filters jsonb = '{}', p_cursor jsonb = null, p_limit int = 50) → jsonb`

- `p_segment`: `sent` (newest first, default last 7 days) · `scheduled` (soonest first, everything upcoming) · `failed` (newest first, last 7 days).
- `p_filters`: `sender_ids uuid[]`, `my_senders bool`, `client_id`, `channel` (`LINKEDIN|EMAIL|WHATSAPP|INSTAGRAM`), `source`
  (`sequence|teammate|ai|outside_app`), `sequence_id`, `type` (`connection_request|message|inmail|email`), `replied bool`
  (sent only), `from` / `to` (ISO; max 90 days apart → `E_PAYLOAD_INVALID … 90 days`), `search` (≥ 2 chars: recipient, text, subject), `lead_id`.
- `p_cursor` = the previous page's `next_cursor` (`{at, id}`); limit 1–100.
- Returns `{ segment, items: SentItem[], next_cursor: {at,id} | null, range: {from,to} | null }`.
- Client viewer with workspace setting `settings.inbox_show_sent_to_clients = false` → `E_FORBIDDEN`.

`SentItem` (TypeScript: `lib/outreach/inboxSent.ts`): `id, src (message|invite|queued|ai_hold|failed|bounce), segment, at,
status (scheduled|held|sending|sent|delivered|read|accepted|replied|failed|bounced), status_reason, status_text, channel,
type, action_type, source, from_ai_draft, subject, preview (140), body (≤ 8000), deleted, edited, replied_at, chat_id,
message_id, action_id, ai_reply_run_id, enrollment_id, enrollment_status, recoverable, lead {id,name,company,headline,picture_url},
sender {id,name,provider,picture_url,status,identifier}, sequence {id,name,status}, step {node_id,number,label,variant,variant_label}, sent_by {id,name}`.

`status_reason` codes (held): `sender_reconnect`, `sender_paused`, `sequence_paused`, `allowance_used`, `hourly_allowance`,
`waiting_slot`; scheduled AI hold in warm-up: `warmup_hold`; failed: the action's error code; bounced: `email_bounced`.
`status_text` uses the "Why isn't it sending" wording (`outreach__sender_causes`) / `outreach_reason_text`.

### `outreach_inbox_counts(p_ws uuid, p_filters jsonb = '{}') → jsonb`

`{ replies_unread, needs_reply, scheduled, failed, show_sent }`. `p_filters`: `assigned_to`, `sender_id`, `client_id`,
`provider` (the Replies list filters; only `needs_reply` uses them). `replies_unread` = the sidebar badge count
(`unread and not archived`, all conversations). `failed` = last 7 days, not acted on (enrollment still failed / manual send;
bounce whose address is unchanged).

### View `outreach_sent_items` (`security_invoker`)

Same rows as the RPC (without the display joins), readable by `authenticated` under row security. Use it for ad-hoc reads;
paged UIs and the API use the RPC.

## 3. Row actions → existing functions (no new way to change a send)

| Segment / row | Action | Calls |
|---|---|---|
| Sent · any | Open conversation (`/outreach/inbox/<chat>?m=<message>&view=sent`) · Open lead (`/outreach/leads/<id>`) · Copy text | — |
| Scheduled · sequence step | Edit text (manager) · Pause this lead · Remove from sequence | `outreach_set_action_text` · `outreach_pause_enrollment` · `outreach_exit_enrollment` |
| Scheduled · AI hold | Send now · Edit (opens the conversation's hold banner) · Cancel (reason) | edge `outreach-ai-reply` `send_now` · — · `outreach_ai_reply_cancel` |
| Failed · sequence step (recoverable) | Retry · Skip this step · Remove from sequence | `outreach_enrollment_recover(ids, retry|skip|exit)` |
| Failed · bounced email | Open lead | — |

## 4. Routes

`/outreach/inbox` = Replies · `/outreach/inbox/sent[?segment=scheduled|failed]` = Sent · `/outreach/inbox/<chatId>` unchanged;
`?m=<message id>` scrolls to and flashes one message, `&view=sent` keeps the Sent list beside the thread.

## 5. Surfaces

| Surface | Where |
|---|---|
| App | `components/outreach/inbox/InboxViewSwitch.tsx`, `ChatList.tsx` (chips, Wrote first / Auto-reply / waiting tags, Sent search group), `sent/SentList.tsx`, `sent/SentDetail.tsx`, `sent/SentActions.tsx`, `Thread.tsx` (`?m=`, No reply yet), `app/outreach/inbox/sent/page.tsx`; data layer `lib/outreach/inboxSent.ts`, `applyRepliesView` in `lib/outreach/queries.ts` |
| Setting | Settings → White-label → Client portal → **Show Sent to clients** (`settings.inbox_show_sent_to_clients`, owner-only like every workspace setting) |
| Client portal | `/outreach/c/[clientId]`: Conversations card = Replies only; read-only **Sent** card |
| MCP | `inbox_list` (`view`, `chip`, row tags), new `inbox_sent_list`, `inbox_pending` on `waiting_on = 'us'`, `inbox_thread` message `status` / `replied_at` / `auto_reply` / `bounce`; skill wording "Replies / Sent" and "AI replies" |
| Public API | `GET /v1/sent` (075 §13 adds `inbox_sent_list` + `inbox_counts` to `outreach_api_dispatch`), thread messages carry `status`, `replied_at`, `is_auto_reply`, `is_bounce`; `/v1/threads?waiting_on_us` uses `waiting_on` |
| D1 | The AI feature is labelled **AI replies** (hub, sequence AI tab, inbox AI chip, settings, AI emails in `_shared/outreach/ai_reply.ts`, connector wording) |

Rollout: apply 075 (it backfills) → deploy `outreach-mcp`, `outreach-api` and the functions bundling `_shared/outreach/ai_reply.ts` (emails wording) → web app. Do **not** deploy `outreach-mcp` before 075: its selects name the new columns.

## 6. Deviations from the PRD

- Tabs: the PRD names "Mine · Unassigned · All · Mentions"; the build's tabs are **All · Unread · Mine · Mentions · Archived** (no Unassigned tab exists). They are kept unchanged inside Replies, as §4.2 asks.
- "Replies queued until working hours" do not exist in this build: a reply typed in the inbox goes out at once (an action that is `reserved` shows as **Sending** in Scheduled until it is sent).
- No `is_auto_reply` column existed: auto-replies are the classifier's `ooo` intent plus an email subject rule; `is_bounce` uses the webhook's bounce rule. A bounce notice that opened its own thread is matched to the email whose address it quotes (same mailbox, 72 h).
- `inbox_search(q)`: no new RPC; the search box shows conversation results and a **Sent** group from `outreach_inbox_sent_list(search)` (top 5, last 90 days, "Show all" opens Sent with the search).
- Sent rows exist only from the sender's `created_at` (the time the account was connected to us). Older synced history stays in the conversation.
- Delivered: only channels whose webhook sets `delivered_at` (WhatsApp / Instagram today); Read uses `read_at`. Email has neither.
- Failed AI replies: listed through their `ai_reply` action (the run is not listed twice).
