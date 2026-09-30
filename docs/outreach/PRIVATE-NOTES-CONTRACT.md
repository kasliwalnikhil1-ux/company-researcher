# Private notes — build contract

Implements `private-notes-PRD.md` (30 Sep 2026) for the `/outreach` inbox. Everything is namespaced `outreach_*` / `outreach-*`; note RPC names sit outside the prefixes that the 037/042 grant loops revoke (`outreach_note*`, `outreach_notes*`, `outreach_mentions*`, `outreach_notifications*`).

## 0. Deviations from the PRD (and why)

| PRD | Built | Why |
|---|---|---|
| §3/§11 migrate `messages.is_private` | Nothing to migrate | The column never existed on this platform; notes were never messages here. |
| §6.1 browser / PWA push | Not offered; the Notifications settings page says so | There is no Web Push infrastructure (no service worker, VAPID keys or subscriptions table) on the platform. In-app (bell + toast, Realtime) and email are built. |
| §9 `pgmq.create('note_notifications')` + F44 `note-notify` | No queue; `outreach_notifications` rows are written by the SQL functions in the same transaction and streamed by Realtime; the email job reads `outreach_chat_note_mentions` directly | pgmq is not used anywhere on the platform (AI replies use tables as queues). One fewer moving part. |
| §10 F43 `note-attachment-upload` | `outreach-note-attachment` with `upload_url` and `read_url` | Same function also issues the 10-minute signed read URLs (§8.3). |
| §10 F45/F46 separate functions | One worker `outreach-notes-worker` with modes `emails` (every minute) and `purge` (daily 03:40) | Matches how every other outreach cron job is laid out. |
| §12 unattended MCP tokens may not mention | Mentions allowed through `note_add` | The connector has no unattended tokens: every session is a signed-in member's OAuth grant. The 60 notes/hour cap per member stands (`author_type = 'agent'`). |
| §7.2 handoff summary "3-line summary of the conversation and lead notes" | Reason + rule, the AI lead-notes summary, and the prospect's last message | The lead-notes summary is the platform's own conversation summary; the last inbound message is quoted so the assignee sees where things stand without opening the thread. |
| §5 edit "revision history on hover" | History in a modal (author or manager) opened from the ⋯ menu or the *edited* label | Hover popovers are unreadable on touch and with long bodies. |
| §6.2 Unassigned tab | Not added | The inbox has All / Unread / Mine / Archived; Mentions was added beside them. |
| §16 metrics | Not built | Out of scope for the inbox build; the tables carry everything a report needs (`created_at`, mentions `read_at`). |

## 1. Data (migration `046_chat_notes.sql`)

- `outreach_chat_notes` (own table, never joined by any send/export/webhook path), `outreach_chat_note_revisions`, `outreach_chat_note_mentions`, `outreach_notifications`, `outreach_notification_prefs`; `outreach_chats.last_note_at`.
- Bucket `outreach-chat-notes` (private, 25 MB). Read policy: `outreach_note_attachment_readable(name)`. No insert policy: uploads go through signed upload URLs.
- RLS: select only. Notes: workspace member + `outreach_note_visible(chat_id, visibility)` (chat visible to the caller; client viewers only see `team_and_client`). Mentions: own rows or readable note (Seen by). Notifications / prefs: own rows. All writes are SQL functions.
- Realtime: `outreach_chat_notes`, `outreach_chat_note_mentions`, `outreach_notifications` are in `supabase_realtime`. The web app subscribes per workspace (notes, mentions) and per user (notifications → bell + toast).
- Cron (`047_chat_notes_cron.sql`, apply after deploying `outreach-notes-worker`): `outreach-notes-emails` every minute, `outreach-notes-purge` daily.

## 2. RPCs (all SECURITY DEFINER; `outreach_require(ws, 'client_viewer')` + `outreach_client_visible`)

| Function | Who | Does |
|---|---|---|
| `outreach_note_create(p_chat, p_body, p_visibility, p_attachments, p_author_type)` | any member who can read the chat (viewers forced to `team_and_client`) | Validates body (1–10,000) and attachments (≤10, ≤25 MB, path under `<ws>/<chat>/`), parses `@[Name](user:<uuid>)` tokens server-side, keeps only readers (dedupe, drops self, cap 20), writes mentions + notifications, sets `last_note_at`, audits without the body. Returns the note JSON + `dropped_mentions[{user_id,name,reason}]`. Rate: 240/h per user, 60/h for `agent`. |
| `outreach_note_update(p_note, p_body?, p_visibility?)` | body: author; visibility: author or manager (a viewer cannot set `team`) | Revision of the previous body, re-parse, notify **new** mentions only, remove mention rows of dropped people. |
| `outreach_note_delete(p_note)` | author or owner/manager | Soft delete (placeholder), mention rows removed, its notifications marked read. Purged after 30 days. |
| `outreach_note_mark_read(p_note)`, `outreach_mentions_mark_all_read(p_ws)`, `outreach_notifications_mark_read(p_ids)` | self | Read state on mentions + notifications. |
| `outreach_notes_list(p_chat)`, `outreach_notes_for_lead(p_lead, p_limit)`, `outreach_notes_search(p_ws, p_q, p_limit)`, `outreach_note_revisions(p_note)` | readers | Reads. Search = `search_tsv` (simple) + ilike fallback, `ts_headline` snippet. |
| `outreach_mentions_list(p_ws, p_unread_only, p_limit)`, `outreach_notifications_list(p_ws, p_limit)`, `outreach_notes_badge(p_ws)` | self | Mentions view (one row per chat, unread first), bell list, badge counts. |
| `outreach_notification_prefs_get(p_ws)` / `_set(p_ws, p_kind, p_email, p_email_delay_min, p_push)` | self | Kind `note_mention`; delay 10/30/60. |
| `outreach_note_system_create(p_chat, p_body, p_author_type, p_mentions, p_visibility)` | service | AI / system notes. Internal `outreach__note_system_create` is what `outreach_ai_handoff` calls (works from user context via the definer chain). |
| `outreach_note_mentions_due`, `outreach_note_mentions_mark_emailed`, `outreach_note_email_context`, `outreach_notes_purge` | service | Worker support. |
| `outreach__team_notes_for_ai(p_chat, p_limit)` | internal | Last 10 live notes minus `#no-ai`, as `{author, text, at}`; `outreach_ai_reply_gate_facts` returns them as `team_notes`. |

Note JSON: `{id, chat_id, lead_id, client_id, workspace_id, author{id,type,name,former}, body|null, visibility, mentions[{user_id,name,read_at,access}], attachments[], exclude_from_ai, edited_at, revisions, deleted_at, deleted_by, created_at}`.

## 3. AI replies

- `EngineInput.teamNotes` → prompt block `INTERNAL TEAM NOTES (… use as guidance, never quote … not facts you may state)` after THREAD, identical for auto and manual (parity test still passes). Notes are **not** added to the allowed-facts corpus or to the verifier: a link/price that exists only in a note is still an invented fact.
- Validator rule `note_overlap`: 8 consecutive words shared with any team note → auto run escalates (`validator`), Draft with AI shows a warning. The failure detail never quotes the note. `patchFromResult.context.team_notes_used` stores a count only (run rows are readable by client viewers).
- `outreach_ai_handoff()` (patched in place) adds an AI note mentioning the assignee next to the handoff task, for every reason except `human_replied` / `manual`.

## 4. Edge functions

- `outreach-note-attachment` (user JWT): `upload_url {chat_id,name,size,mime}` → `{path, token}` (client uploads with `uploadToSignedUrl`), `read_url {note_id, path}` → 10-minute URL when the note is readable through RLS.
- `outreach-notes-worker` (cron): `emails` groups due mentions per person + conversation, one email with the notes and the last 3 messages, marks `emailed_at` (also when Resend is not configured, so the queue stays bounded); `purge` calls `outreach_notes_purge()` and removes the returned files.
- `outreach-exports-create`: `include_notes: true` on the `messages` kind (managers only, audited, file `…-with-notes.csv`, rows `type = note`).
- `_shared/outreach/reply.ts` refuses any attachment path containing `chat-notes` (the send path only ever reads `outreach-attachments` anyway).
- CI: `node scripts/check-note-leaks.mjs` (part of `npm run lint`) fails when note identifiers appear in send / webhook / API / worker / report code.

## 5. MCP (`outreach-mcp`)

`note_add` (write, not gated, `author_type = 'agent'` → "Claude (via <member>)"), `notes_list`, `mentions_list`, `note_mark_read`. `inbox_thread` gains `notes[]` (`type:'note', private:true`), `inbox_pending` rows gain `notes_count` + `latest_note`; neither touches `their_words` / `recent`. Skill: `claude-skill/outreach/private-notes.md` (rebuild with `python scripts/skills-build.py`).

## 6. Web app

- Composer tabs **Reply / Private note**, Alt+P (`event.code === 'KeyP'`), separate drafts per chat and mode in localStorage, amber `--note-bg`, "Only your team sees this", **Add note** (Cmd/Ctrl+Enter; Enter = new line), @ picker grouped Team / Client (client viewers only when *Visible to client* is ticked), markdown toolbar, up to 10 files (paste works), *Improve my text* on LinkedIn chats. Notes are allowed when replies are locked (sender down, no reply permission, suspended is still read-only).
- Timeline: notes interleaved by time, `NoteBubble` (lock label, author, time, Visible to client / Hidden from AI tags, chips with your own mention stronger, attachments via signed URLs, Seen by, ⋯ Edit / Make task / Copy link / visibility / Edit history / Delete, deleted placeholder). Header eye toggle **Show notes** with a count; `?note=<id>` scrolls + flashes; an unread mention of yours is marked read after being in view for 1 s.
- List: **Mentions** tab (unread badge, Unread-only, Mark all read), **Has private notes** filter, bell next to Filters, "Private notes matching …" block on search. Toasts for fresh mentions (`MentionToast`, mounted in the Shell).
- Settings → Notifications: email on/off + delay. Lead page: **Team notes** card across the lead's conversations. Workspace settings: *Include private notes* on the messages export.

## 7. Tests

`migrations/outreach/tests/smoke_11_chat_notes.sql` (29 assertions: scope per persona, mention filtering, edit/delete rules, read state, search, attachments, AI context, handoff note, worker RPCs, grants, audit without body). Dry-run on live: `cat 046_chat_notes.sql tests/smoke_11_chat_notes.sql > t.sql; bash scripts/outreach-sql.sh t.sql` (rolls back). Deno: `ai_reply_rules_test.ts` (note_overlap), `ai_reply_engine_test.ts` (parity).

## 8. Rollout

1. `bash scripts/outreach-sql.sh migrations/outreach/046_chat_notes.sql` (retry on a deadlock: the `alter table outreach_chats` waits for the workers).
2. `bash scripts/outreach-deploy-functions.sh notes-worker note-attachment send-reply exports-create ai-reply ai-reply-worker mcp` (`OUTREACH_DEPLOY_EXTRA_ARGS=--use-api` without Docker).
3. `bash scripts/outreach-sql.sh migrations/outreach/047_chat_notes_cron.sql`.
4. `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_11_chat_notes.sql`, then `python scripts/skills-build.py` and deploy the web app.
