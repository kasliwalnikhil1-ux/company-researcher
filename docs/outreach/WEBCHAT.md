# Web chat — build notes and runbook

Implements `web-chat-PRD.md` (29 Sep 2026). Everything is namespaced `outreach_webchat_*` / `outreach-webchat*`; the widget is the loader + panel under `public/widget/v1/`.

## What ships (PRD phase → state)

| Phase | Scope | State |
|---|---|---|
| P0 | loader + panel, website inboxes, visitors, token + origin checks, live chat into the unified inbox with Realtime, basic settings, install snippet + verify | done |
| P1 | appearance desktop/mobile, launcher types, popup, pre-chat form, business hours, reply time, offline email capture, file/emoji, read receipts, typing both ways, canned responses, assignment + capacity, labels, snooze, priority | done (notes = existing private notes) |
| P2 | email continuity both ways, transcript, CSAT, contact panel with lead linking + outreach timeline | done (continuity sends through a connected mailbox; see below) |
| P3 | AI assistant on the workspace knowledge sources, handoff rules, AI metrics, AI-action accounting | done |
| P4 | SDK complete (identity enforcement, attributes, events, trackEvent), targeting rules, proactive campaigns, webhooks, reports | done; SLA targets not built |
| P5 | live visitors list, Slack, agent reply-by-email, white-label standalone domain, more locales | not built (standalone page is `<app>/chat/<token>`) |

Deviations from the PRD, all deliberate:

- **Data model.** No new `chats`/`messages` tables: a website inbox is a synthetic `outreach_senders` row (provider `WEBCHAT`, no connector account) and every conversation is an `outreach_chats` row on it. RLS, notes, tasks, reports, MCP and the inbox UI work unchanged. Private notes use migration 046's `outreach_chat_notes` rather than an `is_private` flag on messages.
- **Realtime for the widget** is a public broadcast channel per conversation, `webchat:<chat_id>:<stream_key>`, sent from triggers with `realtime.send()`. The 128-bit stream key is a capability handed only to the visitor who owns the chat. Private channels would need visitor JWTs signed with the project JWT secret, which the functions do not have; the widget also long-polls every 5 s when the socket is down.
- **Visitor tokens** are HS256 JWTs signed by the function itself (`OUTREACH_WEBCHAT_TOKEN_KEY`, or a key derived from the service role key when unset). They are never sent to Supabase; every public call goes through `outreach-webchat`.
- **AI answers** use the existing knowledge pipeline (`outreach_knowledge_sources` / `_chunks`, full-text + trigram, crawled by `outreach-ai-reply-worker`) and the platform Gemini key streamed over SSE (a workspace on its own Anthropic/OpenAI key gets a one-shot answer). No pgvector / OpenAI embeddings. Each answer inserts an `outreach_ai_calls` row with purpose `webchat_answer`; `outreach__ai_pool()` now counts those together with reply drafts.
- **Email continuity** goes out through the inbox's reply mailbox (a connected GMAIL/OUTLOOK/IMAP sender) via the connector; the `mail_sent` webhook links the thread and `handleMail` routes visitor replies back into the chat (`webchatMailHook`). Without a reply mailbox, digests use Resend when `RESEND_API_KEY` is set and cannot be replied to. No platform inbound domain (`reply.<domain>`).
- **Agent teams / SLA** are not modelled (no teams table). Slack, agent reply-by-email, mobile push: not built.
- **Country targeting** blocks server-side (block list + `countries_exclude` are applied to messages); the widget does not hide by country because the config response is cached per origin.

## Files

- SQL: `migrations/outreach/048_webchat_enums.sql` (own call), `049_webchat_schema.sql`, `051_webchat_functions.sql`, `052_webchat_cron.sql` (after the worker is deployed); test `tests/smoke_12_webchat.sql` (30 assertions).
- Functions: `outreach-webchat` (public API, see the route list in its header), `outreach-webchat-worker` (continuity every minute, maintenance every 5 min), shared `_shared/outreach/webchat.ts`; hooks in `reply.ts` (`sendReply` routes WEBCHAT to the RPC) and `inbound.ts` (`handleMail` → `webchatMailHook`).
- Widget: `public/widget/v1/loader.js` (7.6 KB gzip), `chat.js` (30 KB gzip), `demo.html`. Standalone page `app/chat/[token]/page.tsx`.
- App: `lib/outreach/webchat.ts`, `app/outreach/settings/websites/**`, `components/outreach/settings/websites/*`, `components/outreach/inbox/webchat/*` (thread bar, visitor panel), `components/outreach/WebchatPresence.tsx`, small hooks in Thread / Compose / InboxView / ChatList.
- MCP: `outreach-mcp/tools_webchat.ts`; skill `claude-skill/outreach/web-chat.md`.

## Rollout order (live)

1. `bash scripts/outreach-sql.sh migrations/outreach/048_webchat_enums.sql` (alone), then 049, then 051.
2. `bash scripts/outreach-smoke.sh migrations/outreach/tests/smoke_12_webchat.sql` (rolls back; needs three active app users).
3. Deploy: `bash scripts/outreach-deploy-functions.sh webchat webchat-worker send-reply process-inbound mcp` (`OUTREACH_DEPLOY_EXTRA_ARGS="--use-api"` when Docker is off). `outreach-webchat` must stay `--no-verify-jwt` (the script does that).
4. `bash scripts/outreach-sql.sh migrations/outreach/052_webchat_cron.sql`.
5. Deploy the Next.js app (widget files are static under `/widget/v1/`).
6. Optional secrets: `OUTREACH_WEBCHAT_TOKEN_KEY` (32+ random bytes; rotating it logs every visitor out), `OUTREACH_TURNSTILE_SECRET` (enables the Turnstile toggle). Both match `scripts/outreach-set-secrets.sh`'s allowlist (`OUTREACH_` prefix).

## Testing locally

- SQL: the throwaway stack recipe from `ai-replies` memory (`%TEMP%\aistack`, `replay3.sh` runs 001–051 twice + the smoke tests).
- Widget: allow localhost on the inbox (Security tab), open `http://localhost:3000/widget/v1/demo.html?token=<website_token>&api=<SUPABASE_URL>/functions/v1/outreach-webchat`. The page logs every SDK event.
- Origin checks: a `curl` without an `Origin` header is rejected (403, no body) except from the app's own origin (standalone page).

## Operational notes

- Blocked visitors get a 200 with their echo id: nothing tells them they are blocked (PRD §15).
- Rate limits: per visitor in SQL (10/10 s, 200/h), per IP + per inbox in the function; AI answers 30/h per visitor. All overridable per inbox under Security.
- Settings are versioned in `outreach_webchat_settings_history`; the Installation tab's "Seen on" comes from `installed_origins`, written at most once a minute per origin.
- Presence: the app pings `outreach_webchat_presence` every minute from any outreach page; "online" for the widget = a collaborator pinged within 10 minutes and inside business hours.
