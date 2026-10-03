# AI hub — build contract

Source: `ai-hub-unified-ui-changes.md` ("One home for AI"), applied to the app as built on 1 Oct 2026. This file fixes
every name, route, signature and payload of the hub. When code and this file disagree, fix one of them in the same change.
Naming follows the platform: tables / RPCs `outreach_*`, edge functions `outreach-*`, client calls
`rpc('<name without outreach_>')` / `callFn('<name without outreach->', body)`.

Migrations: `063_ai_hub.sql` (schema, views, RPCs, in-place patches) → deploy functions (`outreach-webchat`,
`outreach-webchat-worker`, `outreach-ai-reply`, `outreach-ai-reply-worker`, `outreach-mcp`) → `064_ai_hub_cron.sql`.
Tests: `migrations/outreach/tests/smoke_15_ai_hub.sql`.

## 0. What the PRD assumed and what the build has

| PRD | The build | Here |
|---|---|---|
| Tables `ai_reply_runs`, `ai_variable_values`, `kb_sources`, `master_prompt_faqs`, `webchat_inboxes` … | `outreach_ai_reply_runs`, `outreach_ai_values`, `outreach_knowledge_sources`, `outreach_master_prompt_faqs`, `outreach_webchat_inboxes` … | platform prefix; views are `outreach_ai_outputs`, `outreach_ai_needs_you` |
| `ai-review-auto-approve-PRD.md` is built (Auto for lines, checks, spot checks, revoke) | it is not: `outreach_ai_variables` has no mode, no checks exist, every line is approved by a person | Personalized lines get **Off · Review**. **Auto is shown locked** ("not available yet") in the same three-way switch. Line cards have no check lines and no Spot check; they appear when a line is `generated`. Nothing here blocks building auto-approve later |
| `review_ai_draft` tasks are a second copy of a reply draft; closing them is harmless | they are the **AI draft + approval** sequence step: the task holds the AI-written message of that step and the lead's enrolment waits on it (`outreach_complete_task` queues the send or skips the step) | a fourth feature, **Step drafts**: card type `draft`, read straight from the open `review_ai_draft` task. The task is **not** closed by the migration (it would strand the enrolment). Hidden from the Tasks page |
| `ai_escalation` tasks duplicate the escalated run | true | open ones are completed with the note "Moved to AI → Needs you"; `outreach__ai_escalation_task` no longer creates them |
| Profile drafts "if built" | Profile Studio is built; an AI draft is an `outreach_profile_changes` row with `source = 'ai_draft'`, `status = 'draft'` | card type `profile`, feature **Profile drafts** (Review only) |
| Knowledge sources are per website / per sequence; `knowledge_links` makes them shared | sources are already workspace rows (`outreach_knowledge_sources`). A sequence links them in `outreach_master_prompts.knowledge_source_ids`, a website in `settings.ai.knowledge_source_ids`; both are versioned with the prompt / the website settings | no `knowledge_links` table. The library reads both lists (`outreach_hub_knowledge` → `used_in`), `outreach_hub_knowledge_link` attaches / detaches through the existing versioned RPCs, and deleting a source now also takes it off websites |
| `master_prompt_faqs` renamed to `knowledge_qa` | thirty functions and the prompt version snapshots read `outreach_master_prompt_faqs` | the table keeps its name. A row is either a sequence prompt's pair (as before) or a **library** pair (`master_prompt_id null`, `workspace_id` set). `outreach_knowledge_qa_links` limits a library pair; no rows = everywhere |
| Website FAQ entries move into the shared Q&A | the website assistant had no FAQ, only knowledge sources | the assistant now reads the library pairs that apply to its website (new) |
| Website "top unanswered questions" feed `ai_unanswered_questions` | they were computed in the report from low-confidence turns | a low-confidence answer or suggestion now adds to `outreach_ai_unanswered_questions` (`origins`, `inbox_id`); grouping is the same trigram rule, never across clients |
| Website modes `ai_mode` / `ai_when` in settings | `ai_enabled` + `settings.ai.mode` in `off \| first \| offline_only` | storage unchanged + new value `review`. Off = `ai_enabled false`; Review = `review`; Auto · Always = `first`; Auto · Outside business hours = `offline_only`; `settings.ai.review_timeout_min` (default 10) |
| Activity website rows = `messages where sender_type = 'bot'` | bot messages include greetings, forms and hand-off lines | `outreach_webchat_ai_turns` (the answers) + `outreach_webchat_ai_suggestions` |
| "Why did it say that?" link | never built as a link; the run drawer (validator, verifier, prompt snapshot) lived in Settings → AI Auto Replies → Activity | that Activity tab and its drawer are gone from the UI; Reports no longer link to a run. Nothing new is stored. The columns stay |
| `sendChatMessage` | the inbox sends through `callFn('send-reply', { chat_id, text, ai_run_id })` (LinkedIn / mail / …) and `rpc('webchat_agent_send', …)` (web chat) | Needs you calls exactly those |
| Badge = count with "Mine" | — | `outreach_hub_needs_you_counts(p_ws, true)`, refetched every 60 s and on focus; no Realtime channel |
| Sidebar "AI Website Chatbots" (1 Oct) | — | renamed **Website assistant**; it stays its own sidebar item (the widget, live chat and installation live there), and the AI part is also a card in AI → Setup |

Not built here (unchanged from before): auto-approve for lines; Mintlify help pages.

## 1. Names

| Feature | Name | One output | Stored as |
|---|---|---|---|
| AI Auto Replies / AI replies | **Replies** | Reply | `reply` |
| AI Personalization / AI variables | **Personalized lines** | Line | `line` |
| AI draft + approval step | **Step drafts** | Step draft | `draft` |
| AI Website Chatbots / AI assistant / Website assistant | **Website agents** (sidebar, feature); one website's is the **Website agent**, its tab **AI agent** (renamed 3 Oct) | Website | `website` |
| Profile Studio "Draft with AI" | **Profile drafts** | Profile | `profile` |

Modes are **Off · Review · Auto** everywhere. Replies keep the enum (`off | draft | autopilot`); the UI and the MCP say
Review / Auto and the MCP accepts `review` and `auto` as input. All of it is in `lib/outreach/aiHub.ts`
(`FEATURE_LABEL`, `HUB_MODE_LABEL`, `MODE_LINE`, `replyToHubMode`, `websiteHubMode`).

## 2. Routes

| Route | Page |
|---|---|
| `/outreach/ai` | → `/outreach/ai/needs-you` |
| `/outreach/ai/needs-you?type=&where=&mine=all` | Needs you |
| `/outreach/ai/activity?feature=&where=` | Activity |
| `/outreach/ai/knowledge?view=qa` | Knowledge: Sources · Q&A (unanswered questions link to Needs you) |
| `/outreach/ai/setup` | feature cards + General |
| `/outreach/ai/setup/replies?tab=consent\|reports` | Replies: sequences with their mode · Consent · Reports |
| `/outreach/ai/setup/lines?view=lines` | Personalized lines: variables · all lines (the old review table, every status, batches, Generate lines) |
| `/outreach/ai/setup/lines/[variableId]` | one variable: editor, mode, its lines in Activity |
| `/outreach/ai/setup/website` | websites with their mode and When |
| `/outreach/ai/setup/general` | AI provider and key · allowance · per-sender daily cap · default prompt and library prompts · email finder keys |

Redirects (kept for one release):

| Old | New |
|---|---|
| `/outreach/ai-review` | `/outreach/ai/needs-you?type=line` |
| `/outreach/ai-review?batch=…` / `?generate=1` / `?leads=` / `?selection=` | `/outreach/ai/setup/lines?view=lines&…` (same params) |
| `/outreach/settings/ai` | `/outreach/ai/setup/general` |
| `/outreach/settings/ai-replies` (`tab=defaults`) | `/outreach/ai/setup/general` |
| `/outreach/settings/ai-replies?tab=consent` / `reports` | `/outreach/ai/setup/replies?tab=…` |
| `/outreach/settings/ai-replies?tab=activity` | `/outreach/ai/activity?feature=reply` |
| `/outreach/websites/[id]?tab=ai` "Recent answers" | the same tab shows Activity filtered to the website |

## 3. Schema (063)

- `outreach_ai_variables.mode text not null default 'review'` check `off | review`. Trigger `outreach_hub_variable_mode`:
  switching off turns the variable's `pending` lines into `skipped` and releases the leads that wait for them.
  `outreach_ai_generate_request` and the `regenerate` action raise `E_AI_VARIABLE_OFF` for an off variable.
- `outreach_ai_values.generated_at` (set by `outreach_ai_value_result`; backfilled from `updated_at`).
- `outreach_webchat_ai_suggestions (id, workspace_id, inbox_id, chat_id, message_id unique, text, sources, confidence,
  model, status, attempts, locked_at, error, used_message_id, resolved_by, away_at, created_at, ready_at, resolved_at)`.
  `status`: `pending` (being written) → `waiting` → `used | stale | expired`; `failed` = nothing to suggest. RLS select by
  workspace + the inbox's client. In the realtime publication.
- `outreach_master_prompt_faqs`: `+ workspace_id`, `+ updated_at`, `master_prompt_id` nullable (library pair).
  `outreach_knowledge_qa_links (qa_id, target_kind 'website' | 'sequence', target_id)`.
- `outreach_ai_unanswered_questions`: `sequence_id` nullable, `+ inbox_id`, `+ origins text[]` (`reply`, `website`).
- Indexes for the date filter and the queue on `outreach_ai_values`, `outreach_tasks` (review_ai_draft),
  `outreach_webchat_ai_turns`, `outreach_profile_changes` (ai_draft).

## 4. Views (`security_invoker = true`; granted to `authenticated`)

### `outreach_ai_outputs` (Activity)

`id, workspace_id, feature, created_at, where_kind, where_id, where_name, who_kind, who_id, who_name, who_detail, text, chat_id`

| feature | from | where | who |
|---|---|---|---|
| `reply` | `outreach_ai_reply_runs` with `coalesce(final_text, draft_text)` | sequence | lead (`who_detail` = company) |
| `line` | `outreach_ai_values` with text | variable (`where_name` = key) | lead |
| `draft` | `outreach_tasks` kind `review_ai_draft` with `ai_draft` | sequence (through the enrolment) | lead |
| `website` | `outreach_webchat_ai_turns` with answer, `outreach_webchat_ai_suggestions` with text | website | visitor (`who_detail` = city); `chat_id` opens the chat |
| `profile` | `outreach_profile_changes` `source = 'ai_draft'` | sender | sender |

### `outreach_ai_needs_you` (Needs you + badge)

`id, workspace_id, type, state, where_kind, where_id, where_name, who_kind, who_id, who_name, who_detail, trigger_text,
ai_text, reason, assignee_id, created_at, chat_id, lead_id, send_at, priority, meta`

| type | rows | state | assignee | actions (client) |
|---|---|---|---|---|
| `reply` | auto runs of chats that are not handed off / archived: `draft_ready`; `scheduled` with `timings.warmup`; `escalated` while theirs is the last message (latest run of the chat, 30 days) | `review \| escalated \| no_reply \| warmup` | chat assignee | Send · Edit → `callFn('send-reply', {chat_id, text, ai_run_id})`; warm-up: Send now `callFn('ai-reply', {action:'send_now', run_id})`, Cancel `rpc('ai_reply_cancel', …)` with a reason; no_reply: Apply `rpc('ai_reply_apply_no_reply')`; Skip `rpc('hub_reply_dismiss')` |
| `line` | `outreach_ai_values.status = 'generated'` | `review` | — | `rpc('ai_review', {p_value_ids, p_action: approve \| skip \| edit \| regenerate, p_text})`; bulk approve / skip / regenerate |
| `draft` | open `review_ai_draft` tasks | `review \| drafting \| no_draft` | task assignee | Approve & send `rpc('complete_task', {p_id, p_text, p_result: null})`; Skip step `p_result: {decision:'reject'}`; Regenerate `callFn('ai-draft', {task_id})` |
| `website` | suggestions `waiting` | `review` | chat assignee | Send · Edit → `rpc('webchat_agent_send', {…, p_attrs: {internal: {suggestion_id}}})`; Open chat |
| `question` | `outreach_ai_unanswered_questions.status = 'open'`, managers only | `open` | — | Add answer `rpc('hub_question_answer')`; Dismiss `rpc('hub_question_dismiss')` |
| `profile` | AI profile drafts not applied | `review` | who asked for it | Edit and apply (Profile Studio) · Discard `rpc('profile_cancel_change')` |

`reason` is a code (`review`, `warmup`, `no_reply`, `low_confidence`, `drafting`, `no_draft`, `unanswered`, an escalation
reason or a gate); `needsYouReason()` in `lib/outreach/aiHub.ts` words it. `priority` 0 = a live website suggestion
(always first), 1 = the rest; the page orders by `priority, created_at`.
Skip / Dismiss are undoable for 5 seconds: the client removes the card at once and only then makes the call.

## 5. RPCs (063)

User RPCs (`authenticated`; role checked inside):

| RPC | Min role | Returns |
|---|---|---|
| `outreach_hub_needs_you_counts(p_ws, p_mine default true)` | member (invoker) | `{total, reply, line, draft, website, question, profile}` |
| `outreach_hub_setup(p_ws)` | member (invoker) | `{written_7d: {feature: n}, sequences: [{id, name, status, mode, warmup_remaining, downgraded_at, downgrade_reason, waiting}], variables: [{id, key, name, mode, needs_posts, waiting, approved}], websites: [{id, name, is_active, ai_enabled, mode, review_timeout_min, waiting}], drafts: {open}, profile: {open}, questions_open}` |
| `outreach_hub_variable_set_mode(p_variable, p_mode 'off' \| 'review')` | manager | `{id, key, name, mode, was}` |
| `outreach_hub_website_set_mode(p_inbox, p_mode 'off' \| 'review' \| 'auto', p_when 'always' \| 'outside_hours' default null, p_review_timeout_min default null)` | manager | the inbox json (`outreach_webchat_inbox_update`) |
| `outreach_hub_reply_dismiss(p_run)` | member | `{id, status}`; `draft_ready` / `escalated` → `cancelled · dismissed` |
| `outreach_hub_knowledge(p_ws)` | member | `{sources: [ks_json + used_in: [{kind, id, name}]], qa_total, questions_open, targets: {sequences, websites}}` |
| `outreach_hub_knowledge_link(p_source, p_kind 'sequence' \| 'website', p_target, p_on)` | manager | `{ok, …}` |
| `outreach_hub_qa_list(p_ws)` | member | `[{id, question, answer, enabled, source, created_at, updated_at, owner 'library' \| 'sequence', targets: [{kind, id, name}]}]` (`targets []` = everywhere) |
| `outreach_hub_qa_save(p_ws, p_id, p_question, p_answer, p_enabled default true, p_targets default null)` | manager | `{id, owner, targets}`. `p_targets` null = unchanged, `[]` = everywhere. A sequence's own pair moves to the library when its targets change |
| `outreach_hub_qa_delete(p_id)` | manager | `{ok}` |
| `outreach_hub_question_answer(p_group, p_answer, p_targets default null)` | manager | `{group_id, qa_id}`: a library pair + the group is answered |
| `outreach_hub_question_dismiss(p_group, p_reason default null)` | manager | `{ok, group_id}` |

Service functions: `outreach_knowledge_qa_for(p_ws, p_kind, p_target, p_question)`, `outreach_webchat_unanswered_add(p_chat,
p_message, p_text)`, `outreach_webchat__suggest_open`, `outreach_webchat_v_suggest_context(p_suggestion)`,
`outreach_webchat_v_suggest_take`, `outreach_webchat_v_suggest_record(p_suggestion, p_turn)`,
`outreach_webchat_v_suggest_fail(p_suggestion, p_error, p_final)`, `outreach_webchat_suggest_claim(p_limit)`,
`outreach_webchat_review_sweep()`.

Patched in place (anchors asserted): `outreach_ai_generate_request`, `outreach_ai_value_result`, `outreach_ai_review`,
`outreach_ai_reply_gate_facts`, `outreach_ai_unanswered_add`, `outreach_knowledge_source_delete`,
`outreach_webchat_default_settings`, `outreach_webchat_inbox_update`, `outreach_webchat__availability`,
`outreach_webchat_public_config`, `outreach_webchat_v_conversation_start`, `outreach_webchat_v_message`,
`outreach_webchat_v_ai_context`, `outreach_webchat_v_ai_record`, `outreach_webchat_trg_message_side_effects`,
`outreach_dashboard`, `outreach_why_not_sending`. Replaced: `outreach__ai_faqs_for`, `outreach__ai_escalation_task` (no-op),
`outreach__ks_json`.

## 6. Website assistant Review mode

1. `outreach_webchat_v_message` on a chat with `ai_mode = 'review'` (not handed off) returns `ai: false` (the widget shows
   the normal live-chat state) and `suggest: <suggestion id>`; the row is `pending`.
2. `outreach-webchat` strips `suggest` from the response and writes the suggestion in the background
   (`writeSuggestion()` in `_shared/outreach/webchat.ts`: take → context → retrieve → answer → record). The worker
   (`outreach-webchat-worker`, mode `review`, every minute) retries what the request did not finish (3 tries) and runs
   `outreach_webchat_review_sweep()`.
3. The suggestion (`waiting`) pre-fills the agent's composer for that chat and is a Website card in Needs you.
4. An agent's message with `content_attributes.internal.suggestion_id` marks it `used`; any other agent message or a new
   visitor message marks it `stale`. In Review an agent's reply does not stop the assistant (it does in Auto); "Stop the
   AI" in the thread bar still does.
5. After `review_timeout_min` without an agent's reply: `expired`, and the visitor gets the website's offline hand-off
   message (with the email form when the visitor has no email and it was not asked yet). The suggestion is never sent.
6. The widget never learns the mode: `availability.ai_mode` and `settings.ai.mode` are `off` in Review, and the public
   `/chat` endpoint answers nothing for a Review chat.

## 7. App files

- `lib/outreach/aiHub.ts`: names, modes, types, hooks, card actions.
- `components/outreach/ai/hub/`: `HubFrame`, `ModeSwitch`, `ActivityTable`, Needs you, Knowledge, Setup pieces.
- `app/outreach/ai/**`: the routes of §2.
- Changed: `OutreachNav` (AI item + four sub-items, badge), `Shell`, Tasks page and drawer, Settings tabs (AI tabs gone),
  sequence AI tab, website assistant tab, inbox composer (web chat suggestion), dashboard links.

## 8. MCP

New tools, in `supabase/functions/outreach-mcp/tools_ai_hub.ts`:

| Tool | Class, role | Arguments |
| --- | --- | --- |
| `ai_needs_you_list` | read, member | `type?`, `where_id?`, `mine?` (default true), `limit?` (default 25, 100 at most) |
| `ai_activity_list` | read, member | `feature?`, `where_id?`, `from?` (default 7 days ago), `to?`, `q?`, `limit?` (default 25, 100 at most) |
| `website_assistant_set_mode` | gated, manager | `website_id`, `mode` (off / review / auto), `when?` (always / outside_hours, Auto only), `review_timeout_min?` (1 to 240, default 10), `confirmation_token?` |
| `ai_variable_set_mode` | gated, manager | `variable_id`, `mode` (off / review; auto is refused until auto-approve exists), `confirmation_token?` |

Changed tools: `sequence_ai_replies_set` and the `ai_replies` block of `sequence_create` accept `review` (stored as `draft`)
and `auto` (stored as `autopilot`); answers carry `mode_label`. `send-reply` takes an optional `suggestion_id` for a web
chat, which marks that suggestion `used` (same attribute the app sends: `content_attributes.internal.suggestion_id`).
The three gated web chat tools that lacked `confirmation_token` in their schema have it now. Wording uses the names of §1.

Profile drafts: the Needs you card links to `/outreach/senders/<id>?tab=Profile&change=<change id>`; Profile Studio opens
that draft in its editor.

## 9. Rollout

1. `063_ai_hub.sql` (dry-run first: `cat 063 smoke_15 > t.sql; bash scripts/outreach-sql.sh t.sql`). Every in-place patch
   asserts its anchor, so a function body that differs on live stops the migration with the function's name and nothing
   is changed.
2. Deploy `outreach-webchat`, `outreach-webchat-worker`, `outreach-ai-reply`, `outreach-ai-reply-worker`, `outreach-mcp`,
   `outreach-send-reply`, `outreach-worker-reports`.
3. `064_ai_hub_cron.sql`.
4. Deploy the web app.

The app and the migration go together: the hub pages read the new views, and the old pages only redirect.

The working tree is shared: a full function deploy by anyone ships the hub's function code before 063. That order does
not break sending or the widget (a chat gets no `suggest` without 063, the library Q&A lookup falls back to none), but
the four new connector tools fail with a missing-function error and the report / alert emails link to `/outreach/ai/…`
pages that exist only once the web app is deployed. Checked 2026-10-01 14:20 UTC: the live bundles of the seven
functions (deployed 12:53 to 12:56 UTC by another session) contain none of the hub code.

Status 2026-10-01: steps 1 to 3 done (live dry-run passed, 063 applied, 7 functions deployed, 064 cron running).
Step 4, the web app, not deployed yet.
