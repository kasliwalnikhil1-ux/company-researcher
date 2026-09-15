# Outreach platform — frontend build brief (read fully before writing code)

Product: multi-sender LinkedIn/email outreach platform (Unipile-backed) built INSIDE the existing CapitalxAI Next.js 16 App Router app (React 18, TypeScript strict, Tailwind 3, lucide-react icons, TanStack Query v5, @xyflow/react v12, zod v3, papaparse). Full PRD: `linkedin-outreach-platform-PRD.md` at repo root (sections 11 Frontend, 12 Sequence engine, 13 Safety are most relevant). Naming rule: every DB object is prefixed `outreach_`, every edge function `outreach-`.

## Already built — reuse, do not duplicate
- `app/outreach/layout.tsx` — wraps every `/outreach/*` page with ProtectedRoute + MainLayout + QueryClientProvider + `OutreachWorkspaceProvider` + `OutreachShell` (sub-nav + workspace switcher + realtime subscription). Pages under `app/outreach/**` must be `'use client'` components and must NOT re-wrap with those providers.
- `contexts/OutreachWorkspaceContext.tsx` — `useWorkspace()` → `{ workspace, workspaces, role, isOwner, isManager, canWrite, canReply, suspended, switchWorkspace, refresh, createWorkspace }`. `workspace.id` is the tenant id for every query.
- `lib/outreach/types.ts` — all row types (Sender, Lead, Sequence, Graph, GraphNode, Chat, Message, Task, Enrollment, Action, …) and enums.
- `lib/outreach/nodes.ts` — `NODE_CATALOG` (label/group/description/exits/actionType/defaultConfig/color per node type), `NODE_GROUPS`, `EXECUTABLE_TYPES`, `TEXT_LIMITS`, `CONDITION_FIELDS`, `CONDITION_OPS`, `newNode(type, position)`, `TEMPLATE_VARIABLES`.
- `lib/outreach/graph.ts` — `validateGraph(graph, {hasFreeSender, hasMailbox, strict})` (client mirror of the SQL validator), `graphEdges(graph)`, `nodeExits(node)`, zod `graphSchema`.
- `lib/outreach/render.ts` — `renderTemplate(template, {lead, sender})`, `templateVariables`, `missingVariables`.
- `lib/outreach/api.ts` — `callFn(name, body)` calls edge function `outreach-<name>` with the user JWT (throws `OutreachError{code,message}`); `rpc(name, args)` calls SQL `outreach_<name>`; `parseError(e)` → OutreachError with human message; `fnUrl(name)`.
- `lib/outreach/queries.ts` — TanStack hooks: `useDashboard, useSenders, useSender, useSenderBudgets, useSenderEvents, useClients, useMembers, useInvitations, useLists, useStages, useTags, useLeads(ws, filters), useLead(id), useSequences, useSequence, useSequenceVersions, useNodeStats, useEnrollments, useChats(ws, filters), useChat, useMessages, useTasks, useImportJobs, useSuppressions, useWebhooks, useAudit, useCeilings, useWarmupCaps, useActions, useInvalidatingMutation`, query keys `qk`, and `useOutreachRealtime` (already mounted in the shell — it invalidates queries on realtime changes; you do not need to subscribe again). For anything not covered, query `supabase.from('outreach_*')` directly via `import { supabase } from '@/utils/supabase/client'` (RLS applies) and invalidate with `useQueryClient()`.
- `components/outreach/ui.tsx` — `Button, Card, Input, Textarea (with counter), Select, Toggle, Badge, StatusPill, EnrollmentBadge, IntentBadge, HealthBar, Spinner, ErrorBox, EmptyState, Modal, PageHeader, Table/Th/Td, Avatar, Stat, fmtDate, timeAgo, useToast`. Style: white cards, gray-200 borders, rounded-xl, indigo-600 primary, text-sm. Match the existing app look (see `components/MainLayout.tsx`). Mobile-friendly (stack columns under md).
- `components/outreach/Shell.tsx` — sub-nav: Dashboard `/outreach`, Inbox `/outreach/inbox`, Senders `/outreach/senders`, Leads `/outreach/leads`, Sequences `/outreach/sequences`, Tasks `/outreach/tasks`, Clients `/outreach/clients`, Settings `/outreach/settings/workspace`.

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
  - Senders: `issue_sender_token(p_sender)→text` (show ONCE, extension pairing), `set_sender_schedule(p_sender,p_schedule,p_timezone)`, `set_manual_caps(p_sender,p_caps)` (raises E_CAP_ABOVE_CEILING), `pause_sender(p_sender,p_pause)`, `update_sender(p_sender,p_patch{display_name,client_id,owner_email})`, `sender_today(p_sender)→{type:{used,reserved,cap}}`, `weekly_invites_used(p_sender,p_day)`, `effective_cap(p_sender,p_type)`.
  - Leads: `upsert_lead(p_ws,p_lead,p_source)`, `bulk_leads(p_ws,p_lead_ids,p_op,p_value)` ops: add_tag|remove_tag|set_list|set_stage|set_client|set_dnc|clear_dnc|delete (≤10k), `lead_timeline(p_lead)→[{at,kind,title,data}]`.
  - Sequences: `create_sequence(p_workspace,p_name,p_client_id)→uuid`, `save_sequence(p_id,p_graph,p_pool,p_settings,p_name,p_assignment,p_use_sender_schedule,p_client_id,p_brief)→version` (raises E_GRAPH_INVALID: [json]), `validate_graph(p_graph,p_pool,p_strict)→{errors,warnings}`, `set_sequence_status(p_id,p_status,p_inflight)→{status,warnings}` (raises E_POOL_EMPTY / E_SENDER_NOT_OK / E_GRAPH_INVALID / E_INFLIGHT), `restore_sequence_version(p_id,p_version)`, `delete_node_inflight(p_sequence,p_node_id,p_mode 'skip'|'cancel')→count`, `project_sequence(p_sequence,p_lead_count)→[{estimated_days,bottleneck,details}]`, `sequence_summary(p_ws)→[{sequence_id,live,completed,replied,sent,queued}]`.
  - Enrollments: `enroll_leads(p_sequence,p_lead_ids,p_sender,p_priority)→[{enrolled,skipped_active,skipped_suppressed,skipped_other}]`, `exit_enrollment(p_id,p_reason)`, `pause_enrollment(p_id)`, `resume_enrollment(p_id)`.
  - Tasks: `complete_task(p_id,p_text,p_result)` — for review_ai_draft pass the (edited) text; `p_result:{decision:'reject'}` to reject a draft.
  - Client viewer: `client_stats(p_client)→json`.
- Edge functions via `callFn(name, body)`:
  - `sender-connect {workspace_id, provider:'LINKEDIN'|'GMAIL'|'OUTLOOK'|'IMAP', client_id?, owner_email?, display_name?, recruiter?, timezone?} → {link, sender_id}` then `window.location.href = link` (hosted auth; never iframe).
  - `sender-manage {sender_id, action:'reconnect_link'|'reconnect_cookie'|'resync'|'checkpoint'(code)|'refresh_profile'|'backfill_inbox'|'recompute_health'|'plan_now'|'account_status'}`.
  - `sender-update-proxy {sender_id, country}`; `sender-disable {sender_id, delete_unipile?, purge_secrets?}`.
  - `send-reply {chat_id, text, attachments?:[storagePath], subject?} → {message}`; `edit-message {message_id, action:'edit'|'delete', text?}`; attachment URL: `fnUrl('attachment-proxy') + '?message_id=&attachment_id='` (needs Authorization header — fetch as blob with the JWT via `getValidAccessToken()` from `@/lib/api` and use an object URL).
  - `ai-draft {task_id}` regenerate | `{lead_id, sender_id, kind, brief}` ad-hoc; `ai-sequence-qa {sequence_id} → {errors, warnings, ai_available}`.
  - `imports-create {workspace_id, kind:'search_url'|'csv'|'relations', sender_id?, client_id?, list_id?, tag_ids?, url?, max_results?, storage_path?, mapping?, row_count?, dry_run?} → {job, estimate}` (dry_run returns the estimate without creating). CSV files upload to bucket `outreach-imports` at path `${workspace.id}/${Date.now()}-${file.name}` with `supabase.storage.from('outreach-imports').upload(path, file)`.
  - `exports-create {workspace_id, kind:'leads'|'messages'|'actions'|'audit', client_id?} → {url}` (signed URL, open in new tab).
  - `stripe-webhook {action:'checkout'|'portal', workspace_id, plan?}` → {url} (owner).
  - `invite-member {workspace_id, email, role, client_ids?} | {workspace_id, resend_id}` → {invitation, link, emailed}.
  - `unipile-setup {workspace_id, action:'status'|'register'}` → {status:{unipile, webhook_secret, cookie_key, ai, resend, stripe, webhook_url,…}, webhooks:[…]}.
- Realtime is already wired; after mutations call `queryClient.invalidateQueries({queryKey: ['outreach', workspace.id]})` or the specific `qk.*` key.

## Conventions
- File per route: `app/outreach/<route>/page.tsx` (client component). Put reusable pieces in `components/outreach/<area>/*.tsx`.
- Use `useToast()` for feedback; surface `parseError(e).message` on failures. Never `alert()`.
- Loading → `<Spinner/>`; empty → `<EmptyState/>`; errors → `<ErrorBox/>`.
- All dates via `fmtDate`/`timeAgo`. Sender-local times: senders have `timezone`; display with `Intl.DateTimeFormat(undefined, {timeZone})` where it matters (schedule editor, budgets).
- Accessibility: buttons have labels/titles, inputs have labels, keyboard-usable modals.
- Keep files under ~600 lines; split components when larger. No new npm dependencies beyond those installed (`@xyflow/react`, `@tanstack/react-query`, `zod`, `papaparse`, `lucide-react`, `framer-motion` available).
- Do not modify `layout.tsx`, `Shell.tsx`, `ui.tsx`, `queries.ts`, `api.ts`, `types.ts` except to ADD exports (append only; never rename/remove). If you need a new shared hook, add it to `lib/outreach/queries.ts` at the end.
- Run `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "app/outreach|components/outreach|lib/outreach"` before finishing and fix every error in files you own.
