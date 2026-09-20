# Outreach platform — frontend build brief (read fully before writing code)

Product: multi-sender LinkedIn/email outreach platform (Unipile-backed) built INSIDE the existing CapitalxAI Next.js 16 App Router app (React 18, TypeScript strict, Tailwind 3, lucide-react icons, TanStack Query v5, @xyflow/react v12, zod v3, papaparse). Full PRD: `linkedin-outreach-platform-PRD.md` at repo root (sections 11 Frontend, 12 Sequence engine, 13 Safety are most relevant). Naming rule: every DB object is prefixed `outreach_`, every edge function `outreach-`.

## Already built — reuse, do not duplicate
- `app/outreach/layout.tsx` — wraps every `/outreach/*` page with ProtectedRoute + MainLayout + QueryClientProvider + `OutreachWorkspaceProvider` + `OutreachShell` (sub-nav + workspace switcher + realtime subscription). Pages under `app/outreach/**` must be `'use client'` components and must NOT re-wrap with those providers.
- `contexts/OutreachWorkspaceContext.tsx` — `useWorkspace()` → `{ workspace, workspaces, role, isOwner, isManager, canWrite, canReply, suspended, switchWorkspace, refresh, createWorkspace }`. `workspace.id` is the tenant id for every query.
- `lib/outreach/types.ts` — all row types (Sender, Lead, Sequence, Graph, GraphNode, Chat, Message, Task, Enrollment, Action, …) and enums.
- `lib/outreach/nodes.ts` — `NODE_CATALOG` (label/group/description/exits/actionType/defaultConfig/color per node type), `NODE_GROUPS`, `EXECUTABLE_TYPES`, `TEXT_LIMITS`, `CONDITION_FIELDS`, `CONDITION_OPS`, `newNode(type, position)`, `TEMPLATE_VARIABLES`.
- `lib/outreach/graph.ts` — `validateGraph(graph, {hasFreeSender, hasMailbox, strict})` (client mirror of the SQL validator), `graphEdges(graph)`, `nodeExits(node)`, zod `graphSchema`.
- `lib/outreach/render.ts` — `renderTemplate(template, ctx)`, `templateVariables`, `missingVariables`, `spintaxInfo`, `buildContext`. See "Template syntax" below. **Do not edit it on its own**: it must stay identical to the Deno copy.
- `lib/outreach/api.ts` — `callFn(name, body)` calls edge function `outreach-<name>` with the user JWT (throws `OutreachError{code,message}`); `rpc(name, args)` calls SQL `outreach_<name>`; `parseError(e)` → OutreachError with human message; `fnUrl(name)`.
- `lib/outreach/queries.ts` — TanStack hooks: `useDashboard, useSenders, useSender, useSenderBudgets, useSenderEvents, useClients, useMembers, useInvitations, useLists, useStages, useTags, useLeads(ws, filters), useLead(id), useSequences, useSequence, useSequenceVersions, useNodeStats, useEnrollments, useChats(ws, filters), useChat, useMessages, useTasks, useImportJobs, useSuppressions, useWebhooks, useAudit, useCeilings, useWarmupCaps, useActions, useInvalidatingMutation`, query keys `qk`, and `useOutreachRealtime` (already mounted in the shell — it invalidates queries on realtime changes; you do not need to subscribe again). For anything not covered, query `supabase.from('outreach_*')` directly via `import { supabase } from '@/utils/supabase/client'` (RLS applies) and invalidate with `useQueryClient()`.
- `components/outreach/ui.tsx` — `Button, Card, Input, Textarea (with counter), Select, Toggle, Badge, StatusPill, EnrollmentBadge, IntentBadge, HealthBar, Spinner, ErrorBox, EmptyState, Modal, PageHeader, Table/Th/Td, Avatar, Stat, fmtDate, timeAgo, useToast`. Style: white cards, gray-200 borders, rounded-xl, indigo-600 primary, text-sm. Match the existing app look (see `components/MainLayout.tsx`). Mobile-friendly (stack columns under md).
- `components/outreach/Shell.tsx` + `components/outreach/OutreachNav.tsx` — sub-nav: Dashboard `/outreach`, Inbox `/outreach/inbox`, Senders `/outreach/senders`, Leads `/outreach/leads`, Sequences `/outreach/sequences`, Tasks `/outreach/tasks`, AI review `/outreach/ai-review`, Reports `/outreach/reports`, Clients `/outreach/clients`, Settings `/outreach/settings/workspace`. See "Routes added by the product plan" below.

## Permission matrix (UI hides what the role cannot do; RLS enforces server-side)
| Capability | owner | manager | member | client_viewer |
|---|---|---|---|---|
| Billing, members, webhooks | ✔ | | | |
| Connect/disable senders, edit schedule/caps/proxy | ✔ | ✔ | | |
| Build/activate sequences | ✔ | ✔ | | |
| Import/enrol leads, tasks | ✔ | ✔ | ✔ (scoped) | |
| Inbox read | ✔ | ✔ | ✔ (scoped) | ✔ (own client) |
| Inbox reply | ✔ | ✔ | ✔ if can_reply | ✔ if can_reply |
| Export | ✔ | ✔ | | |
Use `useWorkspace()`: `isOwner`, `isManager`, `canWrite`, `canReply`, `suspended` (suspended ⇒ read-only everywhere; show nothing destructive).

## Data access rules
- Reads: PostgREST via hooks / `supabase.from(...)`. Tables users can UPDATE directly (RLS): `outreach_leads` (members), `outreach_lead_tags`, `outreach_lists/stages/tags` (members), `outreach_clients` (manager), `outreach_chats` (assigned_to, unread, unread_count, intent, archived — any member), `outreach_tasks` (members; but COMPLETE via RPC `complete_task`), `outreach_suppressions` (manager), `outreach_outbound_webhooks` (owner), `outreach_workspaces` (owner: name, settings), `outreach_members` (owner), `outreach_import_jobs` (status pause/cancel by members), `outreach_sequences` delete when draft/archived (manager).
- Everything else goes through RPCs (`rpc('name', {p_...})`, all `security definer`, error strings look like `E_CODE: detail`):
  - Workspace: `my_workspaces()`, `ensure_workspace(p_name)`, `create_workspace(p_name)`, `accept_invitation(p_token)→uuid`, `invitation_preview(p_token)→[{workspace_name,email,role,expired,accepted}]`, `workspace_members(p_ws)→Member[]`, `update_member(p_ws,p_user,p_role,p_client_ids,p_can_reply)`, `remove_member(p_ws,p_user)`, `dashboard(p_ws)→DashboardData`.
  - Senders: `issue_sender_token(p_sender)→text` (show ONCE, extension pairing), `set_sender_schedule(p_sender,p_schedule,p_timezone)`, `set_manual_caps(p_sender,p_caps)` (raises E_CAP_ABOVE_CEILING), `pause_sender(p_sender,p_pause)`, `update_sender(p_sender,p_patch{display_name,client_id,owner_email,alert_emails,booking_link,signature,bcc_address,monthly_cost,parent_sender_id,track_replies})`, `sender_today(p_sender)→{type:{used,reserved,cap}}`, `weekly_invites_used(p_sender,p_day)`, `effective_cap(p_sender,p_type)`.
  - Leads: `upsert_lead(p_ws,p_lead,p_source)`, `bulk_leads(p_ws,p_lead_ids,p_op,p_value)` ops: add_tag|remove_tag|set_list|set_stage|set_client|set_dnc|clear_dnc|delete (≤10k), `lead_timeline(p_lead)→[{at,kind,title,data}]`.
  - Sequences: `create_sequence(p_workspace,p_name,p_client_id)→uuid`, `save_sequence(p_id,p_graph,p_pool,p_settings,p_name,p_assignment,p_use_sender_schedule,p_client_id,p_brief)→version` (raises E_GRAPH_INVALID: [json]; only for sequences that were never activated, see "Draft graph and live graph"), `validate_graph(p_graph,p_pool,p_strict)→{errors,warnings}`, `set_sequence_status(p_id,p_status,p_inflight)→{status,warnings}` (raises E_POOL_EMPTY / E_SENDER_NOT_OK / E_GRAPH_INVALID / E_INFLIGHT), `restore_sequence_version(p_id,p_version)`, `delete_node_inflight(p_sequence,p_node_id,p_mode 'skip'|'cancel')→count`, `project_sequence(p_sequence,p_lead_count)→[{estimated_days,bottleneck,details}]`, `sequence_summary(p_ws)→[{sequence_id,live,completed,replied,sent,queued}]`.
  - Enrollments: always `enroll_preview(p_sequence,p_lead_ids,p_sender,p_include_replied)` first, then `enroll_leads(p_sequence,p_lead_ids,p_sender,p_priority,p_include_replied,p_rule,p_wait_enrichment)→[{enrolled,skipped_active,skipped_suppressed,skipped_other,skipped_replied,waiting}]`; `exit_enrollment(p_id,p_reason)`, `pause_enrollment(p_id)`, `resume_enrollment(p_id)` (also releases a reply hold), `enrollment_recover(p_enrollment_ids,p_action)`.
  - Tasks: `complete_task(p_id,p_text,p_result)` — for review_ai_draft pass the (edited) text; `p_result:{decision:'reject'}` to reject a draft; for a `call` task `p_result:{outcome:'connected'|'voicemail'|'no_answer'|'wrong_number'}` (required); for a `reply_hold` task `p_result:{decision:'resume'|'exit'}`.
  - Client viewer: `client_stats(p_client)→json`.
- Edge functions via `callFn(name, body)`:
  - `sender-connect {workspace_id, provider:'LINKEDIN'|'GMAIL'|'OUTLOOK'|'IMAP', client_id?, owner_email?, display_name?, recruiter?, timezone?} → {link, sender_id}` then `window.location.href = link` (hosted auth; never iframe).
  - `sender-manage {sender_id, action:'reconnect_link'|'reconnect_cookie'|'resync'|'checkpoint'(code)|'refresh_profile'|'backfill_inbox'|'recompute_health'|'plan_now'|'account_status'}`.
  - `sender-update-proxy {sender_id, country}`; `sender-disable {sender_id, delete_unipile?, purge_secrets?}`.
  - `send-reply {chat_id, text, attachments?:[storagePath], subject?} → {message}`; `edit-message {message_id, action:'edit'|'delete', text?}`; attachment URL: `fnUrl('attachment-proxy') + '?message_id=&attachment_id='` (needs Authorization header — fetch as blob with the JWT via `getValidAccessToken()` from `@/lib/api` and use an object URL).
  - `ai-draft {task_id}` regenerate | `{lead_id, sender_id, kind, brief}` ad-hoc; `ai-sequence-qa {sequence_id} → {errors, warnings, ai_available}`.
  - `imports-create {workspace_id, kind:'search_url'|'csv'|'relations'|'post_engagement'|'conversations'|'sn_saved_search'|'sn_lead_list'|'company_people', sender_id?, client_id?, list_id?, tag_ids?, url?, max_results?, storage_path?, mapping?, row_count?, dry_run?} → {job, estimate}` (dry_run returns the estimate without creating). CSV files upload to bucket `outreach-imports` at path `${workspace.id}/${Date.now()}-${file.name}` with `supabase.storage.from('outreach-imports').upload(path, file)`.
  - `exports-create {workspace_id, kind:'leads'|'messages'|'actions'|'audit', client_id?} → {url}` (signed URL, open in new tab).
  - `stripe-webhook {action:'checkout'|'portal', workspace_id, plan?}` → {url} (owner).
  - `invite-member {workspace_id, email, role, client_ids?} | {workspace_id, resend_id}` → {invitation, link, emailed}.
  - `unipile-setup {workspace_id, action:'status'|'register'}` → {status:{unipile, webhook_secret, cookie_key, ai, resend, stripe, webhook_url,…}, webhooks:[…]}.
- Realtime is already wired; after mutations call `queryClient.invalidateQueries({queryKey: ['outreach', workspace.id]})` or the specific `qk.*` key.

## Product-plan additions (20 Sep 2026)

Read [PLAN-BUILD-CONTRACT.md](PLAN-BUILD-CONTRACT.md) for the return shape of every RPC named here, [RPC-SIGNATURES.md](RPC-SIGNATURES.md) for exact arguments, and [SQL-REFERENCE.md](SQL-REFERENCE.md) for behaviour and invariants.

### Rule 1: the UI never computes a metric or an eligibility rule

Call the RPC and show what it returns. This is what keeps the dashboard, the reports page, the Claude connector and the public API in agreement.

| Do not do this in TypeScript | Call this instead |
|---|---|
| Add up counts into "replies", divide for a reply or acceptance rate, pick a denominator | `report_overview`, `report_sequence`, `report_sender`, `report_client`, `report_intents`, `dashboard`. Every totals object has the same keys. Rates arrive as percentages with one decimal, or `null` when the denominator is 0. Show `null` as "n/a", not as 0% |
| Write tooltip text for a metric | `metric_definitions()` |
| Decide which threads are behind a reply number | `report_reply_threads(...)`, then open the inbox with exactly those `chat_id`s |
| Decide who can be enrolled, or which sender a lead gets | `enroll_preview(...)`. Show its `excluded`, `replied_recently`, `assignment`, `rule_effects` and `warnings` as given. Commit with `enroll_leads` using the same arguments |
| Decide whether an A/B test has a winner, or compute confidence | `ab_results(...)`: `enough_data`, `leader`, `verdict_vs_leader`, `can_promote` |
| Work out how many leads a publish touches | `publish_impact(p_id, p_graph?)` |
| Work out which leads can move when the pool changes | `rebalance_preview(p_sequence, p_pool)` |
| Explain why something is not sending | `why_not_sending(...)`: show `reason`, then each cause's `detail` and `remedy` |
| Turn an error code into a sentence for a failed lead | `failed_leads(...)` returns `reason` already in plain words |
| Count the longest spintax combination | `spintax_info(text)` on the server, or `spintaxInfo` from `lib/outreach/render.ts` while typing. Both count the same way |
| Check whether a lead is blacklisted | the preview's `suppressed:<why>` reason |

If a number or a rule you need has no RPC, ask for one. Do not approximate it on the client.

### Rule 2: `outreach_node_stats` rows are per variant

The key is `(sequence_id, node_id, variant_id)`. `variant_id = ''` means "no variant". A step with two variants can have three rows. **Sum the rows per node** for the number on a canvas step (`queued`, `sent`, `failed`, `skipped`, `accepted`, `replied`, `interested`). Show the rows separately only in the variant breakdown. These counters are for the canvas. Reports use `report_sequence`, never these rows.

### Draft graph and live graph

| | Live graph `sequences.graph` | Draft `sequences.draft_graph` |
|---|---|---|
| Who reads it | The engine. Running leads follow it, or the version they are pinned to | Only the builder. Nothing in the engine reads it |
| How it changes | `publish_sequence(...)` for a sequence that has been activated; `save_sequence(...)` for one that never was | `save_draft(p_id, p_graph)`, a couple of seconds after each change (auto-save), with a local copy as the offline fallback. `discard_draft(p_id)` drops it |

* The top bar shows "Draft saved 10:42 · 3 unpublished changes" from the `save_draft` result (`saved_at`, `unpublished_changes`). When `stale` is true, someone published since this draft started: say so.
* **Publish** opens a dialog fed by `publish_impact`. The user picks **Everyone who hasn't reached the changed steps yet** (`p_mode: 'all'`, the default) or **New leads only** (`'new_only'`, which pins in-flight leads to their version). With `'all'`, offer "Update them too" when `queued_with_old_text > 0` (`p_update_queued`), "reschedule N waiting leads" when `waiting_on_changed_delay > 0` (`p_reschedule_delays`), and skip-or-exit for `removed_nodes` (`p_removed_mode`).
* `E_DRAFT_STALE` means a teammate published meanwhile. Show what changed and offer "Review and publish anyway" (`p_force: true`).
* The versions page uses `version_usage(p_sequence)` and `move_to_latest(p_sequence, p_version)`.
* When you need a lead's own graph (its step label, its next steps), call `enrollment_graph(p_enrollment)`. Do not read `sequences.graph` for a lead: the lead may be pinned to an older version.
* There is no "restart from top" anywhere. For failed leads offer **Retry this step**, **Skip this step** and **Exit** (`enrollment_recover`). To run a lead again, enrol it again through the preview.

### Template syntax

| Syntax | Meaning |
|---|---|
| `{{first_name\|there}}` | variable with an optional fallback. Bare names and `lead.*` are lead fields |
| `{{custom.x}}` | a lead custom field |
| `{{sender.first_name}}`, `{{sender.signature}}`, `{{sender.booking_link}}` | sender fields. `{{booking_link}}` is the same link. It carries `utm_content=<lead id>` so the booking webhook can find the lead |
| `{{enrich.about}}`, `{{enrich.recent_post}}`, `{{enrich.previous_company}}`, `{{enrich.years_in_role}}`, … | stored enrichment (full list: `render_context` in the contract). Empty when the profile has nothing, so always give a fallback |
| `{{ai.icebreaker\|fallback}}` | an AI variable. It resolves **only to text a person approved**. The render context carries nothing else, so an unapproved line renders the fallback. Never render text from `outreach_ai_values` directly in a message preview |
| `{{unsubscribe_link}}` | filled by the executor at send time. In previews it is empty, so show a placeholder. The validator warns (`W_NO_UNSUBSCRIBE`) when an email step has none |
| `{Hi\|Hello\|Hey}` | spintax: single braces with at least one pipe. An option cannot contain braces, so write `{Hi\|Hello} {{first_name}}`, not `{Hi {{first_name}}\|Hello}` |
| `{{#if company}}at {{company}}{{else}}…{{/if}}` | conditional text. True when the path resolves to a non-empty value. Nesting is allowed |

* **Preview equals send.** Get the context with `rpc('render_context', { p_lead, p_sender, p_enrollment })`, pass it through `buildContext(json, extras)` and render with `renderTemplate`. The `seed` in the context is the enrollment id, so the spintax pick in the preview is the one that will be sent. Without a seed the first option is shown.
* Length limits count the **longest** spintax combination. Show the character count from `spintaxInfo(text).maxLen` and the number of combinations. An invite note over the limit fails every request, so treat the validator's `E_NOTE_TOO_LONG` as blocking.
* Message variants live in the step config: `config.variants: [{id, label, text|note|html, subject?, weight}]`, at most 5. To show which variant a lead gets, call `pick_variant(p_enrollment, p_node_id, p_variants)`. Do not hash on the client.

**`lib/outreach/render.ts` must stay identical to `supabase/functions/_shared/outreach/render.ts`.** Everything below the leading `//` header comment is the same in both files. Both run the shared cases in `lib/outreach/render.cases.json` (`lib/outreach/render.test.ts` for the web copy, `_shared/outreach/render_test.ts` for the Deno copy).

```bash
bash scripts/outreach-render-test.sh   # 1) Deno copy passes  2) web copy passes  3) the two files are identical below the header
```

A change to template behaviour is three steps: add a case to `render.cases.json`, change **both** files the same way, run the script. The script fails when the copies drift. If you only own the web side, ask the owner of the Deno copy (workstream ENGINE-SEND) to make the change.

### Routes added by the product plan

The nav (`OutreachNav.tsx`) and the settings tabs (`SettingsTabs.tsx`) already link to all of these. On 20 Sep 2026 every route below had a `page.tsx` in the repo. None had been used against live data yet, so expect rough edges.

| Route | Purpose | Built on |
|---|---|---|
| `/outreach/reports` | Tabs: Overview, Funnel, Replies, Sequences, Senders, Clients, Cost. CSV export on every table, saved ranges, report schedules | `report_*`, `ab_results`, `metric_definitions`, `save_range`, tables `outreach_saved_ranges` and `outreach_report_schedules`. Components in `components/outreach/reports/`, hooks in `lib/outreach/reports.ts` |
| `/outreach/ai-review` | Review table for AI-written lines: lead, facts used, generated line; approve all, edit, regenerate, skip | `ai_review_list`, `ai_review`, `ai_generate_request`; realtime on `outreach_ai_batches` and `outreach_ai_values`. Hooks in `lib/outreach/intel.ts`. Hidden from client viewers |
| `/outreach/settings/ai` ("AI & data") | AI variables (key, prompt, fallback, needs posts, max characters), bring-your-own LLM key, enrichment setting | table `outreach_ai_variables` (manager write), `workspace_ai_settings`, edge function `outreach-workspace-secrets` for keys. A key is write-only: show the hint, never the key |
| `/outreach/settings/email` ("Email & booking") | Tracking domains with their status, tracking on manual replies, booking webhook URL | `add_tracking_domain`, `remove_tracking_domain`, table `outreach_tracking_domains`. Status `awaiting_approval` is a real waiting state: the operator activates the domain after Unipile approves it. Do not offer a button that implies the customer can finish this alone |
| `/outreach/settings/api` ("API & webhooks") | API keys: create (shown once), revoke, last used. Sub-tab Webhooks at `/outreach/settings/webhooks` with recent deliveries and replay | `create_api_key`, `revoke_api_key`, table `outreach_api_keys` (the hash column is not selectable), `api_webhooks`, `api_deliveries`, `create_webhook`, `delete_webhook`, `replay_delivery` |
| `/outreach/settings/integrations` | CRM connect, sync rule, field and stage mapping, sync log | edge function `outreach-crm-oauth` to start the connection, `integration_save`, `integration_disconnect`, tables `outreach_integrations`, `outreach_crm_sync_log`. A CRM whose OAuth app is not configured shows as not available |
| `/outreach/settings/branding` ("White-label", owner) | Logo, product name, accent colour, support email, help and docs links, email sender; custom portal domains with their DNS records | `set_branding`, `branding`, `add_domain`, `domains`, `remove_domain`. Helpers in `lib/outreach/branding.ts`. Host resolution for custom domains is in `proxy.ts` and uses `branding_for_host`, which is callable before login |
| `/outreach/settings/suppressions` (now labelled "Blacklists") | Scope picker (workspace, client, sequence), company kind, CSV upload | `add_suppressions`; delete rows through PostgREST |

Existing pages that gained plan features: the sequence builder (publish dialog, draft auto-save, queued notice, failed-leads drawer, rebalance dialog, variant editor and results, sequence settings, "Why isn't this sending?"), the sender page (insights, diagnosis, running-dry notice, tracking domain, and settings for booking link, signature, BCC, alert recipients and monthly cost), the lead page (enrichment card, held notice, queued actions with edit, skip and move), and the inbox (originating sequence and step under each bubble from `thread_attribution(p_chat)`, filter by sequence from `sequence_chat_ids`).

### Small rules that are easy to miss

* A held lead is `status = 'paused'` with `held_at` set. Show it as "Replied, held for review", not as "Paused". Resume with `resume_enrollment`, or complete its `reply_hold` task.
* `waiting_task` has a `wait_reason`: `enrichment`, `ai_review`, `ai_route`, or null (a person's task). Label each one differently. Only the last one needs a teammate.
* Alerts (`outreach_alerts`, realtime) resolve on their own. Do not add a "dismiss" that writes to the table.
* The client portal (`/outreach/c/...`) and the invite page use workspace branding and must not show the platform name when `hide_platform_name` is true.
* UI copy: plain words, short sentences, sentence case. Say what happened and what to do next.

## Conventions
- File per route: `app/outreach/<route>/page.tsx` (client component). Put reusable pieces in `components/outreach/<area>/*.tsx`.
- Use `useToast()` for feedback; surface `parseError(e).message` on failures. Never `alert()`.
- Loading → `<Spinner/>`; empty → `<EmptyState/>`; errors → `<ErrorBox/>`.
- All dates via `fmtDate`/`timeAgo`. Sender-local times: senders have `timezone`; display with `Intl.DateTimeFormat(undefined, {timeZone})` where it matters (schedule editor, budgets).
- Accessibility: buttons have labels/titles, inputs have labels, keyboard-usable modals.
- Keep files under ~600 lines; split components when larger. No new npm dependencies beyond those installed (`@xyflow/react`, `@tanstack/react-query`, `zod`, `papaparse`, `lucide-react`, `framer-motion` available).
- Do not modify `layout.tsx`, `Shell.tsx`, `ui.tsx`, `queries.ts`, `api.ts`, `types.ts` except to ADD exports (append only; never rename/remove). During the product-plan build, `queries.ts` and `api.ts` are frozen: put new hooks in a file your area owns (`lib/outreach/reports.ts`, `lib/outreach/intel.ts`, `lib/outreach/branding.ts`, `components/outreach/<area>/hooks.ts`). File ownership per workstream is in [PLAN-BUILD-CONTRACT.md](PLAN-BUILD-CONTRACT.md).
- Run `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "app/outreach|components/outreach|lib/outreach"` before finishing and fix every error in files you own.
