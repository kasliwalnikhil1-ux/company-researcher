# Outreach platform — SQL function reference

Every function lives in `public`, is prefixed `outreach_`, and is defined in `migrations/outreach/002_functions.sql` (and `005_patches.sql` where noted). Call from the web app with `rpc('name', { p_... })` from `lib/outreach/api.ts` (which prefixes `outreach_`), or `supabase.rpc('outreach_name', {...})`.

Conventions
* All API functions are `security definer` with `search_path = public, extensions`; row access is decided **inside** the function, usually by `outreach_require(workspace, min_role)`. The role ladder is `owner > manager > member > client_viewer`.
* Errors are raised as exceptions whose message starts with a code: `E_FORBIDDEN`, `E_NOT_FOUND`, `E_PLAN_SUSPENDED`, `E_PAYLOAD_INVALID`, `E_GRAPH_INVALID: [json]`, `E_POOL_EMPTY`, `E_SENDER_NOT_OK`, `E_SENDER_NOT_IN_POOL`, `E_INFLIGHT`, `E_CAP_ABOVE_CEILING`, `E_TOO_MANY`, `E_INVITE_USED`, `E_INVITE_EXPIRED`, `E_INVITE_EMAIL_MISMATCH`, … (`parseError()` in the web app turns them into `OutreachError{code,message}`).
* `outreach_require` is a no-op for the service role (`outreach_is_service()`), so edge functions can call any API function; a suspended workspace (`plan='suspended'`) fails every `require` except `client_viewer`-level reads.
* **Service-only** functions have `execute` revoked from `public, anon, authenticated` (grant block at the end of 002 and in 005). They are listed here for completeness but cannot be called from the browser.
* Types: `outreach_action_type_t` = profile_view | invite | withdraw | message | inmail | like | comment | endorse | search_page | email | reply | relations_poll | call_api. `outreach_role_t` = owner | manager | member | client_viewer. `outreach_sequence_status_t` = draft | active | paused | archived. `outreach_enrollment_status_t` = active | waiting_connection | waiting_delay | waiting_task | paused | completed | exited_replied | exited_manual | exited_suppressed | exited_sender_disabled | failed | cancelled.

---

## 1. Workspace & membership

| Function | Who | What |
|---|---|---|
| `outreach_my_workspaces() → setof (id, name, slug, plan, role, client_ids, can_reply, settings, trial_ends_at, stripe_status, past_due_since)` | any signed-in user | workspaces the caller belongs to (non-deleted), with the caller's role/scope. Ordered by membership date. |
| `outreach_ensure_workspace(p_name text default null) → outreach_workspaces` | any signed-in user | returns the caller's first workspace (owner memberships first); creates one if none exists (name defaults to `<email local part>'s workspace`). |
| `outreach_create_workspace(p_name text) → outreach_workspaces` | any signed-in user | creates a workspace (unique slug), adds the caller as `owner`, seeds default stages (New … Lost), audits `workspace.created`. |
| `outreach_accept_invitation(p_token text) → uuid` | signed-in user whose email matches the invitation | joins/updates membership with the invited role and client scope, marks the invitation accepted, audits `member.joined`. Returns the workspace id. Errors: `E_NOT_FOUND`, `E_INVITE_USED`, `E_INVITE_EXPIRED`, `E_INVITE_EMAIL_MISMATCH`. |
| `outreach_invitation_preview(p_token text) → setof (workspace_name, email, role, expired, accepted)` | anyone with the token | read-only preview for the invite landing page. |
| `outreach_workspace_members(p_ws uuid) → setof (user_id, role, client_ids, can_reply, email, display_name, created_at)` | member+ | member list joined with `auth.users` for email / name. |
| `outreach_update_member(p_ws uuid, p_user uuid, p_role outreach_role_t, p_client_ids uuid[] default null, p_can_reply boolean default null) → void` | owner | change role / client scope / reply permission; null keeps the current value. Cannot demote yourself. |
| `outreach_remove_member(p_ws uuid, p_user uuid) → void` | owner | removes a member (not yourself). |
| `outreach_dashboard(p_ws uuid) → jsonb` | client_viewer+ (client-scoped) | `{senders:[{id, display_name, provider, status, status_reason, health_score, warmup_level, client_id, paused_until, today}], attention:[{kind, id, label, reason}], replies_awaiting, unread, tasks_open, drafts_awaiting, enrollments_live, sent_today, queued_today, leads_total, stats_7d:{invites, messages, accepted, replies}}`. |
| `outreach_client_stats(p_client uuid) → jsonb` *(005)* | client_viewer+ with visibility of that client | `{leads, senders, invites_30d, accepted_30d, messages_30d, replies_30d, interested_30d, enrollments_live}` for one client. |

Creating invitations is done by the edge function `outreach-invite-member` (owner), not by SQL.

## 2. Senders

| Function | Who | What |
|---|---|---|
| `outreach_issue_sender_token(p_sender uuid) → text` | manager+ | generates a 32-byte hex pairing token for the Chrome extension, stores its sha256 in `outreach_sender_tokens` (one per sender; replaces the previous), stamps `extension_token_issued_at`, audits. **The plaintext is returned once — show it, never store it.** |
| `outreach_set_sender_schedule(p_sender uuid, p_schedule jsonb, p_timezone text) → void` | manager+ | validates the timezone against `pg_timezone_names` and the schedule shape `{"mon":[["09:00","18:00"], …], …}` (keys mon…sun, `HH:MM` windows, start < end), saves, logs a `schedule` sender event. |
| `outreach_set_manual_caps(p_sender uuid, p_caps jsonb) → void` | manager+ | per-type daily caps `{"invite": 20, …}`; each must be ≤ the platform ceiling (`E_CAP_ABOVE_CEILING: invite max is 80`), unknown types rejected, negatives dropped. Replaces the whole object. |
| `outreach_pause_sender(p_sender uuid, p_pause boolean) → void` | manager+ | `true`: `ok → paused` (`status_reason='user_paused'`, emits `sender.paused`); `false`: `paused → ok`. Only those two transitions. |
| `outreach_update_sender(p_sender uuid, p_patch jsonb) → void` | manager+ | patch `display_name`, `client_id`, `owner_email` (keys present in the patch are applied; `client_id: null` clears). |
| `outreach_sender_today(p_sender uuid) → jsonb` | any signed-in user (no membership check; pass ids from RLS-visible senders) | `{ "<action_type>": {used, reserved, cap}, … }` for the sender's current local day. |
| `outreach_weekly_invites_used(p_sender uuid, p_day date) → int` | authenticated (revoked for anon) | `used + reserved` invites in the ISO week containing `p_day`. |
| `outreach_effective_cap(p_sender uuid, p_type outreach_action_type_t) → int` | authenticated | `min(ceiling, warmup cap, manual cap)` × health multiplier (0 below 50, 0.6 below 70). `reply`/`call_api`/`relations_poll` return the ceiling. |
| `outreach_sender_local_date(p_sender, p_at timestamptz) → date`, `outreach_sender_local_hour(p_sender, p_at) → int`, `outreach_in_schedule(p_sender, p_at) → boolean`, `outreach_schedule_windows(p_sender, p_day date) → setof (start_at, end_at)` | authenticated (revoked for anon) | timezone/schedule helpers used by the UI to display sender-local times and windows (`schedule_windows` returns the day's windows as UTC ranges). |

Everything else on senders (connect, disable, proxy, reconnect, resync, checkpoint, health recompute, plan now) is an edge function.

## 3. Leads

| Function | Who | What |
|---|---|---|
| `outreach_upsert_lead(p_ws uuid, p_lead jsonb, p_source text default null, p_import_job uuid default null) → setof (id uuid, created boolean)` | member+ (service bypass) | dedupes by `public_identifier` → `provider_id` → `email_work` → `email_personal` within the workspace; updates existing rows without overwriting filled fields (`custom` is merged); inserts otherwise and emits `lead.created`. Requires at least one identifier (`E_PAYLOAD_INVALID`). Accepted keys: `public_identifier, provider_id, profile_url, first_name, last_name, full_name, headline, company, company_id, title, location, picture_url, email_work, email_personal, is_open_profile, custom, list_id, stage_id, client_id, profile_fetched`. |
| `outreach_bulk_leads(p_ws uuid, p_lead_ids uuid[], p_op text, p_value text default null) → int` | member+ | ops: `add_tag` / `remove_tag` (value = tag id), `set_list`, `set_stage`, `set_client` (value = id or `''` to clear), `set_dnc`, `clear_dnc`, `delete`. Max 10 000 ids. Returns rows affected; audits `leads.bulk`. Setting DNC fires the suppression trigger (exits enrollments, cancels actions). |
| `outreach_lead_timeline(p_lead uuid) → setof (at, kind, title, data)` *(005)* | client_viewer+ | merged timeline (executed actions, messages in/out, enrollment start/end, tasks), newest first, max 300. |
| `outreach_lead_is_suppressed(p_lead outreach_leads) → boolean` | internal helper | DNC / unsubscribed / matches `outreach_suppressions` (public_identifier, email, email domain). Takes a row, not an id. |

Lists, stages, tags, lead tags and suppressions are edited directly through PostgREST (RLS).

## 4. Sequences

| Function | Who | What |
|---|---|---|
| `outreach_create_sequence(p_workspace uuid, p_name text, p_client_id uuid default null) → uuid` | manager+ | new draft with a `start → end` graph, version 1. |
| `outreach_save_sequence(p_id uuid, p_graph jsonb, p_pool uuid[] default null, p_settings jsonb default null, p_name text default null, p_assignment text default null, p_use_sender_schedule boolean default null, p_client_id uuid default null, p_brief text default null) → int` | manager+ | validates (strict when the sequence is `active`), checks pool senders belong to the workspace, saves; bumps `head_version` only when the graph changed and stores it in `outreach_sequence_versions`. Nulls keep current values. Returns the version. Errors `E_GRAPH_INVALID: [ {node_id, code, message}, … ]`, `E_SENDER_NOT_IN_POOL`. |
| `outreach_validate_graph(p_graph jsonb, p_pool uuid[] default '{}', p_strict boolean default false) → jsonb` | any signed-in user | `{errors:[…], warnings:[…]}`. Structural checks (start exists, node types, `next`/branches resolve, id match), limits (invite note 300 / 200 with a free sender in the pool, message 8000, comment 1250, InMail 200/1900), `wait_connection` needs a `connected` branch; strict adds: a terminal path exists, a message node needs an invite/wait_connection/InMail path unless `send_always`, email node needs a mailbox, unreachable-node warnings. |
| `outreach_set_sequence_status(p_id uuid, p_status outreach_sequence_status_t, p_inflight text default 'pause') → jsonb` | manager+ | `active`: pool non-empty (`E_POOL_EMPTY`), all pool senders `ok` (`E_SENDER_NOT_OK`), strict validation (`E_GRAPH_INVALID`), resumes enrollments paused by a previous pause, clears `throttled_reason`, emits `sequence.activated`. `paused`: parks live enrollments (`paused_from` remembered). `archived`: exits live enrollments (`exited_manual/sequence_archived`). `draft`: only when nothing is in flight (`E_INFLIGHT`). Returns `{status, warnings}`. |
| `outreach_restore_sequence_version(p_id uuid, p_version int) → int` | manager+ | re-saves an older graph as a new head version. |
| `outreach_delete_node_inflight(p_sequence uuid, p_node_id text, p_mode text) → int` | manager+ | before removing a node: `skip` cancels the node's queued actions and advances affected enrollments to `next`; `cancel` exits them (`node_deleted`). Returns the count. |
| `outreach_project_sequence(p_sequence uuid, p_lead_count int) → setof (estimated_days int, bottleneck outreach_action_type_t, details jsonb)` | any signed-in user (no membership check) | capacity projection from effective caps × schedule days, plus wait/delay days; `details` has per-type `{total, per_day, days}`, `wait_days`, `pool_size`. |
| `outreach_sequence_summary(p_ws uuid) → setof (sequence_id, live, completed, replied, sent, queued)` *(005)* | member of the workspace (filtered by `outreach_workspace_ids()`) | list-page counters from enrollments and `outreach_node_stats`. |
| `outreach_node_types() → text[]`, `outreach_is_executable_node(p_type) → boolean`, `outreach_node_action_type(p_type) → outreach_action_type_t` | anyone (immutable) | node catalogue helpers (mirror of `lib/outreach/nodes.ts`). |

## 5. Enrollments

| Function | Who | What |
|---|---|---|
| `outreach_enroll_leads(p_sequence uuid, p_lead_ids uuid[], p_sender uuid default null, p_priority int default 100) → setof (enrolled, skipped_active, skipped_suppressed, skipped_other)` | member+ | enrols up to 10 000 leads. Sender choice: `p_sender` (must be in the pool, `E_SENDER_NOT_IN_POOL`), else `least_loaded` or round-robin over the pool; a lead already live with that sender is skipped; suppressed leads skipped; leads outside the workspace counted as `skipped_other`. Emits `enrollment.started` and immediately enters the start node (chains through passive nodes). Errors `E_POOL_EMPTY`, `E_TOO_MANY`. |
| `outreach_exit_enrollment(p_id uuid, p_reason text default 'manual') → void` | member+ | → `exited_manual`; the exit trigger cancels its queued/reserved actions. |
| `outreach_pause_enrollment(p_id uuid) → void` | member+ | live → `paused` (remembers `paused_from`). |
| `outreach_resume_enrollment(p_id uuid) → void` | member+ | `paused` → previous status. |

## 6. Tasks

| Function | Who | What |
|---|---|---|
| `outreach_complete_task(p_id uuid, p_text text default null, p_result jsonb default null) → void` | member+ | marks complete (`completed_by`, `result` = `p_result` or `{text}`), emits `task.completed`, then resumes the enrollment if it is `waiting_task`: **`review_ai_draft`** — `p_result.decision='reject'` skips the node; otherwise queues the real action now with `payload.text = p_text ?? ai_draft` (type from `draft_kind`: `invite_note → invite`, `comment`, else `message`; for a `ai_draft_approval` node the kind comes from the node config). **`manual_node`** — executable node types are queued with the node config (+ `p_text` override), passive ones just advance. Idempotent for already-completed tasks. |

Task rows themselves (assign, edit title/body, delete) are updated via PostgREST; only completion goes through the RPC.

## 7. Client-viewer surface
`outreach_client_stats` (§1) and the RLS-scoped reads. Client viewers have no write RPCs.

---

## 8. Internal engine functions (service role only unless noted)

Listed so operators can call them from the SQL editor; the browser cannot.

| Function | What |
|---|---|
| `outreach_plan_budgets(p_sender, p_day) → setof outreach_sender_budgets` | upserts a cap for every action type for that sender-local day: `effective_cap × jitter(0.9–1.1)`, 0 when no schedule window, weekly invite ceiling applied; never lowers a cap below `used + reserved`. |
| `outreach_reserve_budget(p_sender, p_day, p_type) → boolean` | atomic `reserved+1` if `used+reserved < cap` (plans the day first if no row). |
| `outreach_release_budget(p_sender, p_day, p_type) → void` / `outreach_consume_budget(…)` *(005)* | `reserved-1` / `used+1, reserved-1`. |
| `outreach_queue_action(p_enrollment, p_node_id, p_type, p_scheduled_for, p_payload default '{}', p_sender, p_lead, p_import_job, p_workspace) → uuid` | inserts an action with a deterministic `idempotency_key` (sha256 of enrollment/job/sender ‖ node ‖ type ‖ lead ‖ prefetch/subtask ‖ attempt no.); nudges times that land exactly on :00/:30. Returns null on conflict. |
| `outreach_claim_due_actions(p_limit int default 200) → setof outreach_actions` | one due action per sender (`ok`, not paused, in schedule unless reply/call_api, invites not blocked, no reservation outstanding), `for update skip locked`; reserves budget or defers the action one day (`decision='budget_deferred'`). |
| `outreach_complete_action(p_id, p_response jsonb, p_branch text) → void` | `reserved → sent`, `used+1`, advances the enrollment (not for prefetch/subtask actions). |
| `outreach_fail_action(p_id, p_code, p_decision, p_retry_at, p_branch) → void` | releases budget and applies the decision: `retry` (requeue at `p_retry_at`, default +15 min), `skip_node`, `branch` (advance via named branch), `fail_enrollment`, `mark_lead_invalid`, `sender_cap_hit` (cancel this + cascade queued invites, `invite_blocked_until`), `sender_pause` (`paused_until`), `sender_credentials` (sender → `credentials`), `cancel`, else `failed`. Logs a `reject` sender event for most kinds. |
| `outreach_sweep_stale_reservations() → int` | reservations older than 10 min → `queued`, budget released (cron `outreach-sweep`). |
| `outreach_release_waits() → int` | expired `waiting_delay` → advance; expired `waiting_connection` → `no_connect` branch (active sequences only, 500 each per call). |
| `outreach_enter_node(p_enrollment, p_node_id, p_not_before) → void` | the engine: chains through start / condition / tags / list / stage / webhook / rotate / change_sender / send_to_sequence, stops at delay (`waiting_delay`), manual & AI-approval nodes (`waiting_task`), `wait_connection` (`waiting_connection`, or straight through when already `first`), or an executable node (`active`, optional per-node delay). 100-step loop guard. |
| `outreach_advance_enrollment(p_enrollment, p_from_node, p_branch, p_not_before) → void` | follow `branches[p_branch]` or `next` from a node, then `enter_node`. |
| `outreach_complete_enrollment(p_id, p_status, p_reason) → void` | terminal transition + `enrollment.completed` / `enrollment.exited` event. |
| `outreach_create_node_task(p_e outreach_enrollments, p_node jsonb, p_kind) → uuid` | task for manual / AI-approval nodes (`task.created`). |
| `outreach_eval_condition(p_config, p_lead_id, p_sender_id) → boolean` / `outreach_eval_rule(...)` | condition node evaluation (`match: all|any`, fields `replied, accepted, relation, email_bounced, has_email_work, has_email_personal, is_open_profile, has_tag, stage_is, sender_is_premium, custom.*, company, title, headline, location`; ops `eq, neq, contains, not_contains, exists, not_exists, gt, lt`). Callable by authenticated users but only useful to the engine. |
| `outreach_planner_demand(p_sender, p_until) → setof (...)` | enrollments needing an action before `p_until` (+ `wait_connection` subtasks every 2 days), with `needs_profile` flag. |
| `outreach_health_inputs(p_sender) → jsonb` | 14-day counters for the health scorer. |
| `outreach_verify_sender_token(p_token) → uuid` | sha256 lookup, stamps `last_used_at`. |
| `outreach_rate_limit(p_key, p_limit, p_window_secs) → boolean` | fixed-window counter in `outreach_rate_limits`. |
| `outreach_emit_event(p_ws, p_event, p_payload) → void` | fan out to matching `outreach_outbound_webhooks` (`events` contains the event or `*`) + audit row. |
| `outreach_audit(p_ws, p_action, p_entity, p_entity_id, p_diff, p_actor_type) → void` | audit insert with `auth.uid()` as actor. Callable by authenticated. |
| `outreach_invoke(p_name, p_body default '{}') → bigint` | cron → edge function via pg_net (see SETUP §3). |
| `outreach_seed_workspace_defaults(p_ws) → void` | default stages. |
| RLS helpers: `outreach_is_service()`, `outreach_workspace_ids()`, `outreach_role_in(ws)`, `outreach_client_visible(ws, cid)`, `outreach_plan_active(ws)`, `outreach_can_write(ws)`, `outreach_can_manage(ws)`, `outreach_require(ws, p_min)` | used by policies and API functions; safe to call from the client for UI hints (`select outreach_role_in('<ws>')`). |
| Trigger functions: `outreach_set_updated_at`, `outreach_trg_reply_exit`, `outreach_trg_relation`, `outreach_trg_enrollment_exit`, `outreach_trg_sender_status`, `outreach_trg_lead_dnc`, `outreach_trg_action_stats`, `outreach_trg_message_rollup`; `outreach__policy(...)` | not callable directly. |

## 8b. MCP agent layer (`008_agent_mcp.sql`, used by the `outreach-mcp` edge function)

| Function | Who | What |
|---|---|---|
| `outreach_agent_node_queued_actions(p_sequence uuid, p_node_id text) → setof (action_id, lead_id, sender_id, payload, scheduled_for)` | manager+ | queued (not reserved/sent) actions of one node, for re-rendering copy after a `sequence_edit_copy`. |
| `outreach_agent_set_action_text(p_action uuid, p_text text) → boolean` | manager+ | overwrite `payload.text` of a **queued** action; returns false (no change) once the action is reserved or sent. |
| `outreach_agent_reschedule_delay(p_sequence uuid, p_node_id text) → setof (rescheduled int, due_now int)` | manager+ | after a delay node's config changed: `wait_until = node_entered_at + new delay` for enrollments waiting in it; audits `sequence.timing_edited`. |
| `outreach_agent_gc() → void` | service only | deletes expired confirmation / preview / draft tokens and old call logs. |

Tables `outreach_agent_confirmations`, `outreach_agent_previews`, `outreach_agent_drafts`, `outreach_agent_calls` are service-role only (RLS enabled, no policies) and hold the MCP's two-step confirmation tokens, enrolment previews, reply drafts (with the last inbound message id for the staleness check) and the per-call log.

## 9. Events emitted (for outbound webhooks / audit)
`lead.created`, `lead.updated`, `enrollment.started`, `enrollment.completed`, `enrollment.exited`, `task.created`, `task.completed`, `sequence.activated`, `sequence.paused`, `sequence.webhook`, `sender.paused`, `sender.connected`, `sender.reconnected`, `sender.disconnected`, `sender.level_changed`, `sender.health`, `invite.sent`, `invite.accepted`, `invite.withdrawn`, `message.sent`, `message.received`, `message.classified`, `email.sent`, `email.opened`, `email.clicked`, `email.bounced`. Subscribe with `outreach_outbound_webhooks.events` (array; `'*'` for all).
