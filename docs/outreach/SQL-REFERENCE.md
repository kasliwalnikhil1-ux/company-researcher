# Outreach platform: SQL function reference

Reader: an engineer joining the project. Last updated 20 Sep 2026.

Every function lives in `public` and is prefixed `outreach_`. Functions whose name starts with `outreach__` (two underscores) are internal building blocks and are not granted to `authenticated`.

| Where | What |
|---|---|
| `migrations/outreach/002_functions.sql`, `005`–`008` | The original engine and API |
| `migrations/outreach/009_enums_v2.sql` to `017_hardening.sql` | The product-plan build (`outreach-product-plan.md`). Several 002 functions are replaced here with `create or replace`; the latest file wins |
| [RPC-SIGNATURES.md](RPC-SIGNATURES.md) | Every function with arguments, return type and caller, generated from `pg_proc`. Use it for exact signatures. This document explains behaviour and invariants |
| [PLAN-BUILD-CONTRACT.md](PLAN-BUILD-CONTRACT.md) | Return shapes per plan item, written for the surface builders |

Call from the web app with `rpc('name', { p_... })` from `lib/outreach/api.ts` (it adds the `outreach_` prefix), from edge functions with `rpc()` (service role) or `urpc()` (as the user), and from the public API through `outreach_api_dispatch` (§21).

## Conventions

* All API functions are `security definer` with `search_path = public, extensions`. Row access is decided **inside** the function, usually by `outreach_require(workspace, min_role)`. The role ladder is `owner > manager > member > client_viewer`. The enum is declared in that order, so in SQL `owner < manager < member < client_viewer`; `greatest(a, b)` therefore returns the **weaker** role. The API key code relies on this.
* Errors are exceptions whose message starts with a code: `E_FORBIDDEN`, `E_NOT_FOUND`, `E_PLAN_SUSPENDED`, `E_PLAN_REQUIRED`, `E_PAYLOAD_INVALID`, `E_GRAPH_INVALID: [json]`, `E_VARIANT_INVALID`, `E_NOTE_TOO_LONG`, `E_NO_MAILBOX`, `E_DRAFT_STALE`, `E_POOL_EMPTY`, `E_SENDER_NOT_OK`, `E_SENDER_NOT_IN_POOL`, `E_INFLIGHT`, `E_CAP_ABOVE_CEILING`, `E_TOO_MANY`, `E_INVITE_USED`, `E_INVITE_EXPIRED`, `E_INVITE_EMAIL_MISMATCH`. `parseError()` in the web app turns them into `OutreachError{code,message}`.
* `outreach_require` is a no-op for the service role (`outreach_is_service()`), so edge functions can call any API function. A suspended workspace (`plan='suspended'`) fails every `require` except `client_viewer`-level reads.
* **Service-only** functions have `execute` revoked from `public, anon, authenticated`. Most also check `outreach_is_service()` and raise `E_FORBIDDEN`. They are listed here so operators can call them from the SQL editor. The browser cannot.
* Types. `outreach_action_type_t` = profile_view | invite | withdraw | message | inmail | like | comment | endorse | search_page | email | reply | relations_poll | call_api | post_fetch | follow | find_email. `outreach_role_t` = owner | manager | member | client_viewer. `outreach_sequence_status_t` = draft | active | paused | archived. `outreach_enrollment_status_t` = active | waiting_connection | waiting_delay | waiting_task | paused | completed | exited_replied | exited_manual | exited_suppressed | exited_sender_disabled | failed | cancelled. `outreach_import_kind_t` = search_url | csv | relations | post_engagement | conversations | sn_saved_search | sn_lead_list | company_people. `outreach_task_kind_t` gained `reply_hold` and `call`.
* "Live enrollment" in this document means status in (`active`, `waiting_connection`, `waiting_delay`, `waiting_task`), plus `paused` where a function says so.

## Migration order

| File | Contents |
|---|---|
| `009_enums_v2.sql` | New enum values only (action types, import kinds, task kinds) |
| `010_schema_v2.sql` | New columns and tables, RLS policies, realtime publication |
| `011_engine_v2.sql` | Engine: reply stop, version pinning, variants, new node types, InMail guard, attribution triggers |
| `012_editing_recovery_enrol.sql` | Drafts, publish, queued edits, recovery, rebalance, blacklists, the enrol plan, auto-enrol |
| `013_reports.sql` | Metric definitions, rollup, report functions, stall detection, dashboard |
| `014_intelligence.sql` | Enrichment, render context, AI variables, AI routing queue, thread attribution |
| `015_platform.sql` | API keys and dispatch, CRM plumbing, branding and domains, booking, email depth, lead sources |
| `016_seed_cron_v2.sql` | Budget rows for the new action types, new cron jobs, report schedule defaults |
| `017_hardening.sql` | Grants and `search_path` only. No outreach function stays executable by `anon` or through `PUBLIC`, except the three that must work before login: `outreach_branding_for_host`, `outreach_branding_for_invite`, `outreach_invitation_preview`. Signed-in callers keep the access they had. Trigger functions lose `authenticated`. Re-run it after adding functions |

**009 must be applied before 010 and later, in a separate run.** PostgreSQL does not allow a value added with `alter type … add value` to be used in the same transaction, and the Management API runs one file as one transaction. `010`+ use the new values (for example `'post_fetch'` in 016 and `'reply_hold'` in 011), so they fail if 009 shares their transaction. `scripts/outreach-apply-migrations.sh` sends one file per request and, with no arguments, applies 001 to 017 in order, so running it is enough. See [SETUP.md](SETUP.md) §9.5.

All files are idempotent (`create or replace`, `add column if not exists`, `on conflict`, unschedule-by-name before `cron.schedule`).

## Smoke tests

```bash
export CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_...
bash scripts/outreach-sql.sh migrations/outreach/tests/smoke_01_reply_stop.sql   # one test, full log
bash scripts/outreach-smoke.sh                                                   # every smoke_*.sql, PASS / FAIL per file
```

Each test is one `do $$ … $$` block. It builds its own workspace, senders, leads and sequences, runs the assertions, and then **raises an exception on purpose** with the log as the message. The exception rolls the whole block back, so nothing is left in the database. The script prints the message.

* A pass starts with `SMOKE OK (…)` followed by one `ok` line per assertion.
* A failure starts with `SMOKE FAIL (n)` and shows `FAIL` lines with the values found.
* The "Failed to run sql query: ERROR: P0001" prefix is expected. It is how the result comes back.
* `scripts/outreach-smoke.sh` runs each file through `outreach-sql.sh`, prints `PASS <file> (n assertions)` when the output contains `SMOKE OK`, prints the non-`ok` lines otherwise, and exits 1 if any file failed.

| Test | Asserts |
|---|---|
| `smoke_01_reply_stop.sql` (item 1) | A1 an email reply exits the LinkedIn enrollment. A2 the lead's enrollment on sender B in another sequence exits too. A3 every queued action for the lead is cancelled on all senders. A4 `last_replied_at` and `last_replied_channel` are stamped. B a `send_always` step stays live and keeps its queued action. C1/C2 scope `sender` behaves as before 011. D1 an out-of-office intent re-opens the enrollment with a wait of about 7 days. D2 the resumed enrollment is not reply-blocked. E1 hold mode pauses the lead and creates a `reply_hold` task. E2 resume closes the task and clears the block. F1 the enrol preview excludes leads who replied in the last 90 days. F2 "include" makes them eligible. F3 a deliberate re-enrol is not blocked by the old reply |
| `smoke_02_numbers_editing_recovery.sql` (items 2–11, 17, 19) | V1 a graph with variants and spintax validates. V2 `outreach_spintax_info` returns the longest combination and the count, and `{{var\|fallback}}` is not spintax. Variants are sticky. 4a inbound messages are stamped with the step they answer and only the first counts. 10a an interested reply moves the stage and records the milestone. 2a overview totals. 2b totals are identical before and after `outreach_rollup_daily`. 2c `outreach_dashboard().last_7_days` equals `outreach_report_overview().totals`. 2d/2e the sequences, senders and clients tables sum to the overview. 10b the intent breakdown equals `outreach_report_reply_threads`. 10c funnel counts. 10d cost per reply is computed, return is not guessed, a sender without a cost is flagged. 11 per-variant results, no winner under 100 sends. 5 a draft does not touch the live graph. 6a publish impact counts. 6b `new_only` pins in-flight leads and clears the draft. 6c a new lead runs the new version. 6d `move_to_latest` moves pinned leads and clears queued copy. 7 queued text is edited through the non-agent RPC. 8a/8b retry re-opens the lead and queues under a new idempotency key. 8c a reconnecting sender gets transient failures back. 9 rebalance moves exactly the previewed leads. 17 a company blacklisted for client A is still eligible for client B, and values are normalised. 19 the fresh-sender rule. 3a pausing every pool sender raises one alert with the reason. 3b the alert is on the dashboard attention list. 3c resuming clears it |
| `smoke_03_intelligence_platform.sql` (items 13–15, 18, 20, 21, 23, 24, 26, budgets) | B1 `post_fetch` has a ceiling and a warm-up cap. B2 the InMail guard allows at most 3 a day with no history. 13a "wait for enrichment" parks the lead and queues it with priority. 13b an all-empty answer stores nothing as enriched and raises the sender's streak. 13c a later empty section never overwrites stored data. 13d the `{{enrich.*}}` context and the sender's booking link. 13e conditions on time in role, past company, skill, posted recently, followers. 14a after enrichment the lead moves to `ai_review` when the sequence holds for review. 14b a generated line is **not** in the render context until approved. 14c approval records who and when, the line becomes usable and the lead starts. 15 a routing decision is stored once with reason and facts, shows on the timeline, and the lead moves to the chosen branch. 20a mailbox rotation splits evenly. 20b a contact emailed before keeps the same mailbox. 20c one-click unsubscribe sets the flag and exits the sequence; the lead and its history stay. 24 a booking marks the lead "Meeting", ends the sequence cleanly and fills the funnel stage. 18a auto-enrol respects the daily cap, never picks an unsubscribed lead, and logs its activity. 18b a due repeating import becomes an ordinary import job. 21a a key authenticates by hash and dispatch runs the same report RPC as the UI. 21b a viewer-role key is refused a member operation even though its member is an owner. 21c list endpoints paginate. 23 branding is saved (an `http` logo is rejected), a custom domain resolves to the workspace, and the public branding leaks no sender address. 26 a found email is stored lower-cased with its verification status |

Not covered by a SQL smoke test on 20 Sep 2026: the CRM event stream and sync rule (item 22), tracking-domain status handling (item 20), voice clips (item 25), sender insights (item 12). The template renderer has its own test: `bash scripts/outreach-render-test.sh`.

---

## 1. Workspace and membership

| Function | Who | What |
|---|---|---|
| `outreach_my_workspaces()` | any signed-in user | workspaces the caller belongs to, with role and client scope |
| `outreach_ensure_workspace(p_name)` | any signed-in user | returns the caller's first workspace, creates one if none exists |
| `outreach_create_workspace(p_name)` | any signed-in user | creates a workspace, adds the caller as `owner`, seeds default stages. A trigger from 016 also inserts weekly `digest` and `sender_report` rows in `outreach_report_schedules` |
| `outreach_accept_invitation(p_token)` | signed-in user whose email matches | joins or updates membership. Errors: `E_NOT_FOUND`, `E_INVITE_USED`, `E_INVITE_EXPIRED`, `E_INVITE_EMAIL_MISMATCH` |
| `outreach_invitation_preview(p_token)` | anyone with the token | read-only preview for the invite page |
| `outreach_workspace_members(p_ws)` | member+ | member list joined with `auth.users` |
| `outreach_update_member(...)`, `outreach_remove_member(...)` | owner | change role, client scope, reply permission; remove a member |
| `outreach_dashboard(p_ws) → jsonb` *(013)* | client_viewer+ (client-scoped) | `{senders[…, running_dry, today], attention[{kind,id,label,reason}], replies_awaiting, unread, tasks_open, drafts_awaiting, ai_lines_awaiting, enrollments_live, sent_today, queued_today, leads_total, today, last_7_days, stats_7d}`. `today` and `last_7_days` are totals objects from the same facts as the reports (§10). `stats_7d` keeps the old key names for older callers and carries the same numbers. Attention kinds: `sender`, `sequence`, `sequence_stalled`, `sender_running_dry`, `import_failed`, `held_leads`, `failed_leads`, `ai_review` |
| `outreach_client_stats(p_client) → jsonb` *(013)* | client_viewer+ with visibility of that client | a 30-day summary built from `outreach_report_client`; the full report is under the `report` key |

Creating invitations is done by the edge function `outreach-invite-member` (owner), not by SQL.

## 2. Senders

| Function | Who | What |
|---|---|---|
| `outreach_issue_sender_token(p_sender) → text` | manager+ | pairing token for the Chrome extension. The sha256 is stored, the plaintext is returned once. See [EXTENSION-UNPACKED-INSTALL.md](EXTENSION-UNPACKED-INSTALL.md) |
| `outreach_set_sender_schedule(p_sender, p_schedule, p_timezone)` | manager+ | validates the timezone and the `{"mon":[["09:00","18:00"]],…}` shape |
| `outreach_set_manual_caps(p_sender, p_caps)` | manager+ | per-type daily caps, each at or below the platform ceiling (`E_CAP_ABOVE_CEILING`) |
| `outreach_pause_sender(p_sender, p_pause)` | manager+ | `ok ↔ paused` only |
| `outreach_update_sender(p_sender, p_patch)` *(015)* | manager+ | patch keys: `display_name`, `client_id`, `owner_email`, `alert_emails` (array, at most 10, validated), `booking_link` (must start with `https://`), `signature`, `bcc_address`, `monthly_cost`, `parent_sender_id` (a mailbox can only belong to a LinkedIn sender of the same workspace), `track_replies`. Only keys present in the patch are applied |
| `outreach_sender_today(p_sender)` | signed-in user | `{ "<action_type>": {used, reserved, cap} }` for the sender's local day |
| `outreach_weekly_invites_used`, `outreach_effective_cap`, `outreach_effective_cap_checked` | authenticated | `min(ceiling, warm-up cap, manual cap)` × health multiplier (0 below 50, 0.6 below 70). `reply`, `call_api`, `relations_poll` and `find_email` return the ceiling |
| `outreach_sender_insights(p_sender)` *(013)* | client_viewer+ | item 12, see §16 |
| `outreach_sender_local_date`, `_local_hour`, `outreach_in_schedule`, `outreach_schedule_windows` | authenticated | timezone and schedule helpers |

Connect, disable, proxy, reconnect, resync, checkpoint and "plan now" are edge functions.

## 3. Leads

| Function | Who | What |
|---|---|---|
| `outreach_upsert_lead(p_ws, p_lead, p_source, p_import_job)` | member+ | dedupes by `public_identifier` → `provider_id` → `email_work` → `email_personal`; never overwrites a filled field; merges `custom` |
| `outreach_bulk_leads(p_ws, p_lead_ids, p_op, p_value)` | member+ | `add_tag`, `remove_tag`, `set_list`, `set_stage`, `set_client`, `set_dnc`, `clear_dnc`, `delete`. At most 10 000 ids |
| `outreach_lead_timeline(p_lead)` *(014)* | client_viewer+ | actions (with the plain failure reason), messages, enrollment start and end, holds, tasks, AI routing verdicts with reason and facts, milestones, enrichment. Newest first, at most 400 rows |
| `outreach_lead_queued_actions(p_lead)` *(012)* | member+ | §6 |
| `outreach_request_enrichment(...)` *(014)* | member+ | §13 |
| `outreach_lead_is_suppressed(p_lead outreach_leads)` *(012)* | internal helper | true when `outreach_lead_suppression_reason(lead, lead.client_id, null)` is not null. Takes a row, not an id |

Lists, stages, tags and lead tags are edited through PostgREST (RLS). Suppressions are added with `outreach_add_suppressions` (§9) and deleted through PostgREST.

## 4. Sequences

| Function | Who | What |
|---|---|---|
| `outreach_create_sequence(p_workspace, p_name, p_client_id)` | manager+ | new draft with a `start → end` graph |
| `outreach_save_sequence(...)` | manager+ | validates, saves, bumps `head_version` when the graph changed. **Use it directly only for sequences that have never been activated.** Active sequences go through drafts and `outreach_publish_sequence` (§5), which calls it internally |
| `outreach_validate_graph(p_graph, p_pool, p_strict)` *(011)* | signed-in user | `{errors, warnings}`. Checks every text a step can send: the base copy and each variant. Length limits use the **longest spintax combination** (`outreach_template_max_len`): invite note 300, or 200 with a free sender in the pool (`E_NOTE_TOO_LONG`); message 8000; comment 1250; InMail body 1900 and subject 200. Variants: every variant needs a unique `id`, weight ≥ 0, at most 5 per step (`E_VARIANT_INVALID`); one variant warns `W_SINGLE_VARIANT`. `ab_split` needs at least two weighted branches, each connected. `ai_route` needs at least one described route and an `else` branch. Strict mode adds: a terminal path, a connection path before a message or voice note unless `send_always`, a mailbox for email steps (`E_NO_MAILBOX`), `W_NO_UNSUBSCRIBE` for an email without `{{unsubscribe_link}}`, `W_VOICE_CLIP`, `W_UNREACHABLE` |
| `outreach_set_sequence_status(p_id, p_status, p_inflight)` | manager+ | activate, pause, archive, back to draft |
| `outreach_restore_sequence_version(p_id, p_version)` | manager+ | re-saves an older graph as a new head version |
| `outreach_delete_node_inflight(p_sequence, p_node_id, p_mode)` | manager+ | kept from 002. The publish dialog now handles removed steps through `p_removed_mode` |
| `outreach_project_sequence(p_sequence, p_lead_count)` | signed-in user | capacity projection |
| `outreach_sequence_summary(p_ws)` | member | list-page counters |
| `outreach_node_types()`, `outreach_is_executable_node(p_type)`, `outreach_node_action_type(p_type)` *(011)* | anyone | node catalogue. New types: `refresh_profile` (→ `profile_view`), `follow_profile` (→ `follow`), `send_voice_note` (→ `message`, so it spends the message budget), `find_email` (→ `find_email`), `call_task`, `ab_split`, `ai_route` |

`outreach_node_stats` has one row per `(sequence_id, node_id, variant_id)`; `variant_id = ''` means no variant. It also has an `interested` counter. Sum the rows per node when showing a step total. These counters feed the canvas. Reports never read them (§10).

## 5. Draft, publish and version pinning (items 5 and 6)

Columns on `outreach_sequences`: `draft_graph`, `draft_updated_at`, `draft_updated_by`, `draft_base_version`. On `outreach_sequence_versions`: `note`, `publish_mode`. On `outreach_enrollments`: `pinned_version`.

| Function | Who | What |
|---|---|---|
| `outreach_save_draft(p_id, p_graph)` | manager+ | stores the draft (2 MB limit). Sets `draft_base_version` to the head version the first time. Returns `{saved_at, base_version, head_version, stale, unpublished_changes}` |
| `outreach_discard_draft(p_id)` | manager+ | clears the four draft columns, audits |
| `outreach_graph_diff(p_old, p_new)`, `outreach_graph_change_count(...)` | anyone | node-level diff: `added`, `removed`, `changed`, with `text_changed` and `delay_changed`. Moving a node or renaming its label is not a change |
| `outreach_publish_impact(p_id, p_graph?)` | manager+ | what a publish would touch, before anything changes. Counts exclude already-pinned leads where it matters. Includes the validation result |
| `outreach_publish_sequence(p_id, p_graph?, p_mode, p_note, p_force, p_update_queued, p_reschedule_delays, p_removed_mode, …)` | manager+ | see below |
| `outreach_version_usage(p_sequence)` | client_viewer+ | live leads per version (`coalesce(pinned_version, head_version)`) |
| `outreach_move_to_latest(p_sequence, p_version)` | manager+ | un-pins leads of one version whose current step still exists in the live graph, and clears the pre-rendered copy of their queued actions. Leads whose step is gone stay on the old version: `{moved, kept_on_old_version}` |

**Publish, in order:** refuse a stale draft (`E_DRAFT_STALE` unless `p_force`) → make sure the current head exists as a version row → mode `new_only`: set `pinned_version = head_version` on every live and paused lead that is not pinned yet; mode `all`: for each removed step, skip its leads forward (using the **old** graph, which still knows where `next` is) or exit them → `outreach_save_sequence` writes the new version → with mode `all`, optionally `outreach_refresh_queued_text` for steps whose text changed and `outreach_reschedule_delay` for changed delay nodes → clear the draft → audit and emit `sequence.published`.

**Invariants**

* Nothing in the engine reads `draft_graph`. A draft change cannot reach a lead before publish.
* Every graph read for a lead goes through `outreach_enrollment_graph(p_enrollment)`: the pinned version's graph if `pinned_version` is set and that version row exists, otherwise the live graph. Callers: `outreach_advance_enrollment`, `outreach_release_waits`, `outreach_trg_reply_exit`, `outreach_complete_task`, `outreach_why_not_sending`, `outreach_lead_queued_actions`, `outreach_ai_route_pending`. `outreach_enter_node`, `outreach_planner_demand` and `outreach_thread_attribution` inline the same lookup. New code must use the helper.
* A sequence-level edit of queued copy or delays (`refresh_queued_text`, `reschedule_delay`) skips pinned leads.
* `outreach_promote_variant` publishes the live graph with new weights and leaves an open draft as a draft.

## 6. Queued edits (item 7)

| Function | Who | What |
|---|---|---|
| `outreach_node_queued_actions(p_sequence, p_node_id)` | manager+ | queued (not reserved, not sent) actions of one step, at most 2000 |
| `outreach_set_action_text(p_action, p_text, p_subject?)` | manager+ | edits one **queued** action. Returns `false` once it is reserved or sent. Length limits per action type. Marks the payload `edited_by`, `edited_at` |
| `outreach_refresh_queued_text(p_sequence, p_node_id)` | manager+ | "Update them too": removes the pre-rendered `text`, `note`, `subject`, `html` and `variant_id` so the step re-renders from the published node at send time. It never touches hand-edited actions (`edited_by`), approved AI drafts (`approved_task_id`) or pinned leads |
| `outreach_reschedule_delay(p_sequence, p_node_id)` | manager+ | `wait_until = node_entered_at + new delay` for leads waiting in that delay node. `{rescheduled, due_now}` |
| `outreach_lead_queued_actions(p_lead)` | member+ | the lead panel list, with `body`, `subject`, `editable` |
| `outreach_skip_action(p_action)` | member+ | marks the queued action `skipped` (`user_skipped`) and advances the lead. A plain cancel would be re-planned, so skip is the honest operation |
| `outreach_reschedule_action(p_action, p_at)` | member+ | moves a queued action within the next 60 days. The schedule window and the daily budget still decide when it really sends |

The 008 names `outreach_agent_node_queued_actions`, `outreach_agent_set_action_text` and `outreach_agent_reschedule_delay` remain as thin wrappers for the connector.

## 7. Reply stop, hold and out-of-office (item 1)

Sequence `settings` keys: `stop_on_reply` (default true), `stop_on_reply_scope` `'lead'` (default) or `'sender'`, `on_reply` `'exit'` (default) or `'hold'`, `resume_after_ooo` (default true), `ooo_resume_days` (7), `hold_max_days` (30).

| Function | Caller | What |
|---|---|---|
| `outreach_trg_reply_exit()` | trigger `outreach_lss_reply_exit` on `outreach_lead_sender_state`, after update of `replied` or `last_inbound_at` | stamps `outreach_leads.last_replied_at` and `last_replied_channel`. For every live or paused enrollment of that **lead** in the workspace: skip when `stop_on_reply` is false, when scope is `sender` and the sender differs, when the reply is older than the enrollment (`reply_ignored_before`, else `created_at`), when the lead is already held, or when the current step has `send_always`. Otherwise hold (`on_reply = 'hold'`) or exit as `exited_replied`, remembering `prev_status`, `prev_wait_until` and `exited_by_message_at`. Then it cancels every queued or reserved action for the lead on **any sender** (`decision = 'reply_exit'`), except actions whose enrollment deliberately stayed live and except `reply` actions |
| `outreach_enrollment_reply_blocked(p_enrollment, p_action_sender)` | service: the executor, before every send | replaces every read of `lss.replied`. Scope `lead`: true when `leads.last_replied_at` is later than the enrollment's `reply_ignored_before` (else `created_at`). Scope `sender`: the old per-sender check. On true the executor settles the action with decision `replied` (`outreach_fail_action` exits the lead as `exited_replied`) |
| `outreach_hold_enrollment(p_id, p_reason)` | service: the trigger | status `paused`, `held_at`, `hold_reason`, a `reply_hold` task, event `enrollment.held` |
| `outreach_resume_enrollment(p_id)` | member+ | also releases a hold: sets `reply_ignored_before = now()`, clears `replied` on the lead's sender states, closes the task, emits `enrollment.resumed` |
| `outreach_exit_enrollment(p_id, p_reason)` | member+ | a held lead exits as `exited_replied`, others as `exited_manual` |
| `outreach_apply_reply_intent(p_message, p_intent, p_return_date)` | service: `outreach-ai-classify` after it writes the intent; also called by `outreach_set_intent` | **`ooo`**: re-opens enrollments that this exact message exited (`exited_by_message_at` within 5 s of the message, at most 30 days ago) and releases holds caused by a reply, unless `resume_after_ooo` is false. The lead resumes at `p_return_date + 1 day, 09:00` when the date is within 120 days, otherwise after `ooo_resume_days`. **`interested`**: moves the lead forward to the workspace's `interested` stage unless workspace setting `auto_stage_interested` is false, records the milestone, and bumps the per-variant `interested` counter. Returns `{resumed, staged}` |
| `outreach_set_intent(p_chat, p_intent)` | member+ | manual override. Runs the same consequences as the classifier, then updates the chat and the last inbound message |

**Invariants**

* After a reply on any channel or sender, no automated action for that lead stays queued unless its step is `send_always` or the sequence opted out.
* A reply never blocks an enrollment that started after it, a lead resumed from a hold, or a lead resumed after an out-of-office. That is what `reply_ignored_before` is for.
* A held lead is never stuck: it shows on the dashboard attention list, and `outreach_detect_stalls` exits it as `exited_replied / hold_expired` after `hold_max_days`.
* The enrol guard (§8) keeps leads who replied in the last 90 days out unless the user includes them.

## 8. Enrolment: one plan for preview and commit (items 1, 17, 19)

`outreach__enroll_plan(p_sequence, p_lead_ids, p_sender, p_include_replied)` returns one row per lead: `(lead_id, sender_id, reason, note)`. Both public functions below are built on it, so the preview and the commit cannot disagree.

| Function | Who | What |
|---|---|---|
| `outreach_enroll_preview(p_sequence, p_lead_ids, p_sender, p_include_replied)` | member+ | `{requested, eligible, eligible_ids, excluded{reason:{count,sample_ids}}, replied_recently[], assignment[], assignment_rule, rule_effects, projection, warnings}`. At most 10 000 leads |
| `outreach_enroll_leads(p_sequence, p_lead_ids, p_sender, p_priority, p_include_replied, p_rule, p_wait_enrichment)` | member+ | one row `{enrolled, skipped_active, skipped_suppressed, skipped_other, skipped_replied, waiting}`. Clears `lss.replied` for the chosen sender so "replied" in conditions means "replied during this enrolment" |

Exclusion reasons: `not_in_workspace`, `suppressed:<why>` (from `outreach_lead_suppression_reason` with the sequence's client and id), `replied_recently` (90 days, unless included), `already_enrolled` (live with every free pool sender), `no_fresh_sender`.

Sender choice (`sequences.assignment`): `round_robin`, `least_loaded`, `fixed`, plus **`fresh_sender`** (a sender with no history with this lead in `outreach_lead_sender_state`; none left → the lead is skipped with `no_fresh_sender`) and **`same_sender`** (whoever spoke to the lead last, if free). Notes reported in `rule_effects`: `moved_to_fresh_sender`, `kept_with_previous_sender`, `contacted_before_by_this_sender`.

Waits at enrolment: `wait_for_enrichment` (or `p_wait_enrichment`) starts the lead as `waiting_task / enrichment` when its profile is missing or older than 90 days; `hold_for_ai_review` starts it as `waiting_task / ai_review` when the graph uses `{{ai.*}}` variables without an approved or settled value. Both are released by `outreach_release_waiting` and bounded by `outreach_release_waits` (§18).

## 9. Scoped blacklists (item 17)

`outreach_suppressions` gained `client_id`, `sequence_id` (never both), `source` and the kind `company`. Uniqueness is `(workspace, client, sequence, kind, value)`.

| Function | Who | What |
|---|---|---|
| `outreach_add_suppressions(p_ws, p_rows, p_client, p_sequence, p_source)` | manager+ | up to 20 000 rows `{kind?, value, reason?}`. Kind is inferred when omitted: email pattern → `email`, `linkedin.com/in/` → `public_identifier`, `linkedin.com/company/` → `company`, URL or bare domain → `domain`, anything else → `company`. Values are lower-cased and stripped to the identifier or the host. Returns `{added, skipped}` |
| `outreach_lead_suppression_reason(p_lead, p_client, p_sequence)` | anyone | `do_not_contact`, `unsubscribed`, or `<scope>_blacklist:<kind>` where scope is `sequence`, `client` or `workspace`. The narrowest matching scope wins. Company matches on lower-cased name or `company_id` |
| `outreach_enrollment_suppression_reason(p_enrollment)` | service: the executor at send time | same check with the enrollment's client and sequence. On a match the executor settles with decision `suppressed`: the action is cancelled and the lead exits as `exited_suppressed`, not `failed` |

**Invariant:** nothing here deletes a lead, a timeline or a chat. `outreach_integration_disconnect` removes only the blacklist rows that came from that CRM (`source = 'crm:<provider>'`).

## 10. Metric definitions (item 2)

**Every metric is defined once**, in `outreach__facts(p_ws, p_from, p_to)`. It returns long-format rows `(day, client_id, sequence_id, node_id, variant_id, sender_id, channel, metric, n)`. `outreach__totals_from(jsonb)` turns summed facts into the totals object with its rates. `outreach__rate(num, den)` is a percentage with one decimal, `null` when the denominator is 0.

`outreach_metric_definitions()` returns the tooltip wording. The reports page shows that text; do not retype it in the UI.

| Metric (totals key) | Exact definition | Numerator / denominator | Dated by | Fact no. | Rolled up or live |
|---|---|---|---|---|---|
| Day | A calendar day in the workspace timezone: `settings.timezone`, validated against `pg_timezone_names`, default `UTC` (`outreach_ws_tz`). Ranges are inclusive dates, at most 2 years | | | all | |
| Invites (`invites`) | `invite` actions with status `sent` | count | `actions.executed_at` | 1 | rolled up |
| Invites with note (`invites_with_note`) | sent invites whose `response.note_length > 0` | count | `executed_at` | 1 | rolled up |
| Messages, InMails, emails | sent actions of type `message` (voice notes included), `inmail`, `email` | count | `executed_at` | 1 | rolled up |
| Accepted (`accepted`) | `lead_sender_state.invite_accepted_at` falls in the period and an invite was sent. Attributed to the step and variant of the latest sent invite before the acceptance | count | the acceptance, whenever the invite was sent | 2 | live |
| Acceptance rate | accepted ÷ invites, **both in the period**. It is not a cohort rate, so a short range after a big send can exceed 100% | `accepted / invites` | | 1, 2 | |
| Touches (`touches`) | messages + InMails + emails + invites with a note. The denominator of every reply rate. An invite without a note is not a touch | sum | `executed_at` | 1 | rolled up |
| Replies (`replies`) | inbound messages flagged `is_first_reply`: the first inbound message in a chat that answers a given automated action (`replied_to_action_id`, stamped at ingest by `outreach_trg_message_stamp`). **One lead answering three times is one reply.** Replies to a teammate's manual message are conversation, not replies (see "Known defects" below) | count | the reply's `sent_at` | 3 | live |
| Reply rate | | `replies / touches` | | 1, 3 | |
| Interested (`interested`) and the other intents (`intents{…}`) | replies classified by the thread's **current** intent: `chats.intent` unless it is `unclassified`, then the message's own intent. An override therefore moves past replies between intents | count | the reply's `sent_at` | 3 | live |
| Interested rate | | `interested / touches` | | | |
| Positive reply rate | | `interested / (replies − ooo)` | | 3 | live |
| Negative reply rate | out-of-office auto-replies are left out of the denominator | `not_interested / (replies − ooo)` | | 3 | live |
| Inbound messages (`inbound_messages`) | every inbound message. Conversation volume, never a rate numerator | count | `sent_at` | 4 | live |
| Enrolled (`enrolled`) | enrollments created | count | `enrollments.created_at` | 5 | live |
| Meetings (`meetings`) | `outreach_lead_milestones` rows of kind `meeting`: the lead reached a stage of kind `meeting`, or booked through the booking webhook. Once per lead (`unique (lead_id, kind)`) | count | `milestones.at` | 6 | live |
| Won, lost (`won`, `lost`) | milestones of kind `won` / `lost`, once per lead | count | `milestones.at` | 6 | live |
| Won value (`won_value`) | sum of `value` on `won` milestones: `leads.custom.deal_value`, else the won stage's `deal_value`. Never guessed | sum | `milestones.at` | 6 | live |
| Email opened, clicked | outbound email messages with `opens > 0` / `clicks > 0`. Once per message | count; rates ÷ `emails` | the email's `sent_at` | 7 | live |
| Email bounced | `lead_sender_state.email_bounced` | count; rate ÷ `emails` | `lead_sender_state.updated_at` | 7 | live |
| Limit hits (`limit_hits`) | `sender_events` of kind `reject` with `decision = 'sender_cap_hit'` or `limit_hit = true`: LinkedIn refused further invitations | count | `events.at` | 8 | live |
| Failed, skipped | settled actions with that status, prefetch and subtask actions excluded | count | `executed_at` | 1 | rolled up |
| Profile views, likes, comments, endorsements, follows, withdrawn, post fetches | sent actions of that type | count | `executed_at` | 1 | rolled up |
| Funnel | **Cohort**: the leads **enrolled** in the period, followed through invited → accepted → messaged → replied → interested → meeting → won whenever that stage happened. `pct_of_previous` uses the nearest earlier stage with a non-zero count. Median hours between stages | `outreach_report_funnel` reads base tables with the same rules | enrolment date | not from facts | live |
| Cost per reply, per interested, per meeting | sender cost ÷ count. Sender cost = `monthly_cost` (else workspace `settings.sender_monthly_cost`) × days connected in the period ÷ 30, for senders not `disabled`. `return_multiple` appears only when won value > 0 | `outreach_report_cost` | | totals + senders | live |
| Headroom | share of the invite cap not used over the last 30 days | `(Σcap − Σused) / Σcap` from `outreach_sender_budgets`, days with `cap > 0` | budget day | `outreach_sender_insights` | live |

Channel is `email` for email actions and mailbox chats, otherwise `linkedin`.

### Rollup design

* Action volume (fact 1) is immutable once an action is executed, so it is rolled up. `outreach_rollup_daily(p_ws, p_from, p_to)` deletes and re-inserts `outreach_daily_stats` rows for whole days up to **yesterday** in the workspace timezone, then moves `outreach_rollup_state.rolled_through` forward. The stored rows are exactly the output of `outreach__action_facts_live`.
* Cron job `outreach-rollup` runs `outreach_rollup_all()` **hourly** at minute 25. Hourly, because each workspace's "yesterday" closes at its own midnight. Every run recomputes the trailing 35 days for every workspace, which heals late-settled actions, and deletes rows older than 800 days.
* `outreach__facts` reads `outreach_daily_stats` up to `rolled_through` and calls `outreach__action_facts_live` for the days after it. Today is always live.
* Replies, intents, acceptances, milestones, email engagement and limit hits are **always read live**. They are small and they change after the fact (an intent override, a late open). Reading them live is what keeps the intent breakdown equal to the inbox for the same range.
* Smoke test 2b proves totals are identical before and after a rollup.

### Parity guarantee

Dashboard, reports page, client page, connector tools and public API all reach the same code path:

`outreach_report_*` / `outreach_dashboard` / `outreach_client_stats` / `outreach_sender_insights` → `outreach__grouped(ws, client, from, to, group, filters)` → `outreach__facts` → `outreach__totals_from`.

`outreach__grouped` applies the caller's client visibility (`outreach_visible_clients`), so a client viewer or a client-scoped API key gets the same formulas over fewer rows. No TypeScript code may compute a metric. Two exceptions read base tables directly, with the same rules: `outreach_report_funnel` (cohort) and `outreach_ab_results` (per-action attribution).

### Known defects found while writing this document (20 Sep 2026)

Both were reproduced on the live database with a rolled-back test. The migrations are owned by another workstream, so they are recorded here until fixed.

1. **A teammate's manual reply is counted as a reply.** `outreach__action_facts_live` names a sent action's metric after its action type. A manual inbox reply is an action of type `reply`, and `outreach__totals_from` reads the key `reply` as inbound replies. Every manual reply sent adds 1 to `replies`. Fix: in `outreach__action_facts_live`, add `and x.action_type <> 'reply'` to the `where` clause of CTE `a` (or emit the metric as `manual_reply`). The next `outreach_rollup_all()` run repairs the trailing 35 days.
2. **A lead's answer to a manual message is flagged `is_first_reply`.** `outreach_trg_message_stamp` picks the last outbound message with any `action_id`, and manual replies carry a `reply` action. Fix: when the matched action has `action_type = 'reply'`, keep `replied_to_action_id` for attribution but set `is_first_reply := false`.

## 11. Report functions (items 2 and 10)

All take inclusive dates. `p_from` / `p_to` default to the last 7 days (overview) or 30 days (others) in the workspace timezone. All check `outreach__check_range`: role `client_viewer`+, client visible, `from <= to`, at most 2 years.

| Function | Returns |
|---|---|
| `outreach_report_overview(p_ws, p_client, p_from, p_to, p_filters{sequence_id,sender_id,node_id,channel})` | `{period, totals, previous, by_channel{linkedin,email}, series[]}`. `previous` is the period of equal length immediately before |
| `outreach_report_funnel(…, p_filters{sequence_id,sender_id,list_id,tag_id})` | `{cohort, stages[{stage,count,pct_of_enrolled,pct_of_previous,median_hours_from_previous}]}` |
| `outreach_report_intents(…, p_group, p_filters)` | group by `day`, `sequence`, `step`, `sender`, `variant`, `channel` |
| `outreach_report_reply_threads(…, p_intent, p_filters)` | the exact threads behind a reply count, at most 1000. The inbox opens these `chat_id`s when a number is clicked |
| `outreach_report_sequences`, `outreach_report_senders`, `outreach_report_clients` | arrays, each row with a `totals` object |
| `outreach_report_sequence(p_sequence, …)` | `{sequence, totals, steps[], best_step, worst_step, ab_tests[], exits{}, live}`. Best and worst step need at least 20 sends |
| `outreach_report_sender(p_sender, …)` | totals, daily series, health trend, restrictions, failures by plain reason |
| `outreach_report_client(p_client, …)` | the overview shape for one client, plus leads, senders and live enrollments. Used by the client portal and branded reports |
| `outreach_report_cost(p_ws, p_client, …)` | cost tab; `senders_without_cost` flags missing inputs |
| `outreach_metric_definitions()` | tooltips |
| `outreach_save_range(p_ws, p_name, p_preset, p_from, p_to)` | saved date ranges (`outreach_saved_ranges`, RLS: own rows) |

Scheduled emails are rows in `outreach_report_schedules` (`kind` = `digest` | `client_report` | `sender_report`, `cadence` weekly or monthly, `recipients`, `include_client_viewers`). RLS lets managers write. 016 seeds a weekly `digest` and `sender_report` for every workspace.

## 12. Stall alerts and diagnosis (item 3)

| Function | Caller | What |
|---|---|---|
| `outreach_why_not_sending(p_sequence, p_sender, p_enrollment)` | client_viewer+: the UI button, the connector tool, and `outreach_detect_stalls` | `{target, blocked, reason, causes[{code,blocking,detail,remedy,sender,sender_id,next_capacity,partial?}], notes, rule}`. `reason` is one plain sentence. With several pool senders, one blocked sender is marked `partial` and does not block the sequence. Waiting on a delay, on acceptance or on the schedule is reported as non-blocking |
| `outreach_detect_stalls()` | service: `outreach-worker-health`, every cycle | returns `{opened[], resolved}`. The worker emails the opened alerts and calls `outreach_mark_alerts_notified(ids)` |

**Stalled** = the sequence is active, has at least one lead that should be producing actions now (status `active`, entered its step more than 30 minutes ago), sent nothing in the last 26 hours, has nothing queued for the next 26 hours, and some pool sender had a schedule window yesterday or today. **Running dry** = a LinkedIn sender in an active sequence has fewer than 2 days of untouched leads left at its current invite cap; it clears at 3 days. Failed imports of the last 2 days raise `import_failed`.

`outreach_alerts` has a partial unique index on `(kind, entity_id) where resolved_at is null`, so each occurrence raises **one** alert. A new alert is only possible after the previous one resolved. Events: `sequence.stalled`, `sequence.recovered`, `sender.running_dry`. State columns: `sequences.stalled_at`, `stalled_reason`, `senders.running_dry_at`.

## 13. Enrichment (item 13)

Tables: `outreach_lead_profiles` (one row per lead), `outreach_enrich_queue` (background path). Columns: `leads.enrich_status` (`none | waiting | done | failed`), `leads.enriched_at`, `senders.enrich_empty_streak`, `senders.enrich_backoff_until`.

| Function | Caller | What |
|---|---|---|
| `outreach_save_lead_profile(p_lead, p_profile, p_sender, p_source)` | service: the executor after any profile fetch, and `outreach-worker-enrich` | upsert with `coalesce(new, old)` on every field. Returns `{saved, empty_sections, throttled}` |
| `outreach_save_lead_posts(p_lead, p_posts, p_sender)` | service | stores up to the posts passed, `posts_fetched_at`, `last_posted_at` |
| `outreach_request_enrichment(p_ws, p_lead_ids, p_want_posts, p_force, p_reason)` | member+ | queues up to 5000 leads. Skips leads enriched in the last 90 days unless forced. **A never-enriched lead is always taken.** Leads without a LinkedIn identifier and do-not-contact leads are skipped |
| `outreach_enrich_allowance(p_sender, p_priority)` | service | how many background profile views the sender may spend right now |
| `outreach_enrich_next(p_sender, p_limit)` | service | leads waiting at enrolment first (priority), then the queue |
| `outreach_enrich_done(p_lead, p_sender, p_ok, p_error, p_background)` | service | counts background views in `outreach_plans` (kind `enrich`); 3 failed attempts mark the lead `failed` and release its wait |
| `outreach_lead_enrich_ctx(p_lead)` | service, through `outreach_render_context` | the `{{enrich.*}}` values |

**An empty section means "unknown".** LinkedIn throttles full-section requests silently and returns empty sections with no error. So:

* An empty section never overwrites stored data, and never counts as "this person has no About".
* When every requested section is empty, `enriched_at` does not move, the result is `throttled: true`, and the sender's `enrich_empty_streak` goes up. Two in a row set `enrich_backoff_until = now() + 6 hours`. While it is set, the executor skips full sections and `outreach_enrich_allowance` returns 0.
* The sections that came back empty are kept in `empty_sections` for a later retry.

**Budget invariants**

* The free path costs nothing extra: the planner already queues a profile fetch before invite, message, voice note, InMail, comment, like, endorse and follow steps (`needs_profile`).
* The background path uses only profile views left after today's queued sequence work, at most 30% of the day's `profile_view` cap, at most 5 per run, inside working hours, never while the sender is paused or backing off, and **never at warm-up level 0–1**. Leads waiting at enrolment (`p_priority`) may use leftover views at any level, at most 5 per run.
* Posts are a separate budget (`post_fetch`, §17) and are fetched only when `outreach_planner_demand.needs_posts` is true: a like or comment step, `{{enrich.recent_post}}` in the step, or an AI variable with `needs_posts`.

Condition fields added to `outreach_eval_rule`: `enrich.is_enriched`, `enrich.months_in_role`, `enrich.past_company`, `enrich.skill`, `enrich.posted_within_days` (`eq` is read as `lte`), `enrich.follower_count`, `enrich.connections_count`, `enrich.language`, `enrich.about`, `enrich.education`; also `has_phone` and `call_outcome`. New operators: `gte`, `lte`.

## 14. Render context and AI variables (item 14)

`outreach_render_context(p_lead, p_sender, p_enrollment)` (client_viewer+, client-scoped) returns `{lead, sender{…, booking_link, signature}, enrich{…}, ai{<key>: text}, seed}`. The builder preview and the executor both call it, so they see the same values. `seed` is the enrollment id, which makes spintax picks identical in preview and send.

**Approval gate.** The `ai` object is built with `where status = 'approved'` and a non-empty text. A generated, skipped, blank or failed line is not in the context, so `{{ai.key|fallback}}` renders the fallback. There is no code path that renders unapproved AI text.

| Function | Who | What |
|---|---|---|
| `outreach_ai_generate_request(p_ws, p_variable, p_lead_ids, p_sequence, p_regenerate)` | member+ | up to 2000 leads per batch. Existing approved lines are kept unless `p_regenerate`. Leads without a profile go to the enrichment queue. `{batch_id, to_generate, kept_existing}` |
| `outreach_ai_claim_pending(p_limit)` | service: the `outreach-ai-variables` worker | claims pending values with a 10-minute lock. Waits for enrichment that is on its way, up to one day |
| `outreach_lead_ai_facts(p_lead)` | service | the only facts the writer and the router may use: profile, enrichment, up to 3 recent posts, custom fields |
| `outreach_ai_value_result(p_id, p_text, p_facts, p_model, p_error)` | service | status becomes `generated`, `blank` or `failed`. Blank and failed lines release the lead's `ai_review` wait, because the fallback needs no review |
| `outreach_ai_review_list(p_ws, p_batch, p_status, p_limit, p_offset)` | member+ | the review table |
| `outreach_ai_review(p_value_ids, p_action, p_text)` | member+ | `approve`, `skip`, `edit` (one id plus text; counts as approval by that person), `regenerate`. Up to 2000 ids. Records `approved_by`, `approved_at`. Releases `ai_review` waits |
| `outreach_workspace_ai_settings(p_ws)` | manager+ | provider, model, key hint, finder and verifier hints. The booking secret is returned to owners only. Keys themselves are in `outreach_workspace_secrets`, which has no RLS policy and is written only by the `outreach-workspace-secrets` edge function |

Tables: `outreach_ai_variables` (key `^[a-z][a-z0-9_]{1,39}$`, prompt, fallback, `needs_posts`, `max_chars`; manager write), `outreach_ai_batches`, `outreach_ai_values` (unique per lead and variable). Batches and values are in the realtime publication.

## 15. A/B testing (item 11) and AI routing (item 15)

**Message variants.** Step config `variants: [{id, label, text|note|html, subject?, weight}]`, at most 5.

| Function | What |
|---|---|
| `outreach_pick_variant(p_enrollment, p_node_id, p_variants)` | immutable. Takes the first 8 hex digits of `md5(enrollment_id \|\| '\|' \|\| node_id)` as a number, reduces it modulo 100 000, scales it to the total weight and walks the cumulative weights. **Sticky**: the same lead on the same step always gets the same variant, in previews, retries and sends. A weight of 0 switches a variant off. It also picks `ab_split` branches |
| `outreach_node_config_for(p_enrollment, p_node)` | the step config with the picked variant's text merged in, plus `variant_id` |
| `outreach_planner_demand` | returns the variant-resolved `node.config` and a `variant_id` column. The planner puts `variant_id` in the action payload; `outreach_queue_action` copies it to `actions.variant_id` |
| `outreach_ab_results(p_sequence, p_node_id, p_from, p_to)` | per variant: sent, accepted, replies, interested, rates. Judged on **interested** replies (invite steps: on acceptance). `enough_data` is false under 100 sends for any variant, and then no leader is named. Above that, each variant gets a two-proportion z-test against the leader (`outreach_norm_cdf`): ≥ 99 "Very confident", ≥ 95 "Confident", ≥ 90 "Likely". `can_promote` needs every other variant at ≥ 90 |
| `outreach_promote_variant(p_sequence, p_node_id, p_variant)` | manager+. Winner to weight 100, others to 0, new version, queued copy refreshed |

**`ab_split` step.** `config.branches: [{id,label,weight}]`, `branches: {<id>: nodeId}`. The pick is stored once in `outreach_split_assignments`, and `outreach_ab_results` reports branch-versus-branch funnels from it.

**`ai_route` step.** `config.routes: [{id,label,description}]`, `branches: {<id>: nodeId, else: nodeId}`. Entering the node inserts a pending row in `outreach_ai_route_decisions` and parks the lead as `waiting_task / ai_route`. The worker calls `outreach_ai_route_pending(p_limit)` (3 attempts per decision) and then `outreach_ai_route_decide(p_enrollment, p_node_id, p_branch, p_reason, p_facts, p_model)`. The decision is stored **once**, with its reason and the facts used, and shows in the lead timeline. No decision within 6 hours → `outreach_release_waits` sends the lead down `else`. Routing is not message text, so it needs no per-lead approval.

## 16. Sender insights and the InMail guard (item 12)

`outreach_sender_insights(p_sender)` → `{sender, health_breakdown, recommendations[{severity,area,text}], warmup{…}, last_30_days{headroom_pct, limit_hits, acceptance_rate, acceptance_rate_previous, network_growth, …}, invites_vs_cap[30 days], inmail_guard{max_today, rule}}`. Recommendations are rules over `health_breakdown` and `outreach_health_inputs`. No AI is involved. `network_growth` uses the daily `snapshot` sender events (`data.connections_count`) written by the health worker, and falls back to accepted invitations when there is no snapshot 29 days back.

**InMail guard.** `outreach_inmail_guard(p_sender, p_day)` = `greatest(3, ceil(1.5 × InMails used in the previous 7 days ÷ 7))`. `outreach_plan_budgets` applies it as `least(cap, guard)`. It lives in the budget, so no code path can out-send it, and it can only lower the cap the warm-up table allows.

## 17. Budgets for the new action types

Every LinkedIn call reserves a budget first: `outreach_reserve_budget` → call → `outreach_consume_budget`, or `outreach_release_budget` on failure. 016 adds the rows:

| Action type | Platform ceiling per day | Warm-up caps, level 0 → 5 | Notes |
|---|---|---|---|
| `post_fetch` | 100 | 5, 10, 15, 20, 30, 30 | every read of a lead's posts: like steps, comment steps, AI drafts, enrichment. In line with `like` |
| `follow` | 50 | 0, 3, 5, 8, 12, 15 | `follow_profile` step |
| `find_email` | 100 000 | none | a third-party finder call, not LinkedIn traffic. Treated like `call_api`: `outreach_effective_cap` returns the ceiling, and `outreach_claim_due_actions` ignores the schedule window for it |

A voice note is a `message` action with `payload.voice = true` and spends the message budget.

## 18. Engine functions (service role only unless noted)

| Function | What |
|---|---|
| `outreach_plan_budgets(p_sender, p_day)` *(011)* | one cap per action type per sender-local day: `effective_cap × jitter(0.9–1.1)`, 0 without a schedule window, weekly invite ceiling, InMail guard. Never lowers a cap below `used + reserved` |
| `outreach_reserve_budget`, `outreach_release_budget`, `outreach_consume_budget` | atomic budget accounting |
| `outreach_queue_action(...)` *(011)* | deterministic `idempotency_key` (sha256 of enrollment or job or sender ‖ node ‖ type ‖ lead ‖ prefetch/subtask ‖ attempt number). A retry gets a new attempt number and therefore a new key. Stores `variant_id` |
| `outreach_claim_due_actions(p_limit)` *(011)* | one due action per sender, `for update skip locked`. Reserves budget or defers one day (`budget_deferred`) |
| `outreach_complete_action(p_id, p_response, p_branch)` | `reserved → sent`, `used + 1`, advances the enrollment |
| `outreach_fail_action(p_id, p_code, p_decision, p_retry_at, p_branch)` *(011)* | decisions: `retry`, `skip_node`, `branch`, `fail_enrollment`, `mark_lead_invalid`, `sender_cap_hit` (also logs `limit_hit: true`), `sender_pause`, `sender_credentials`, `cancel`, and the two clean exits **`suppressed`** and **`replied`** |
| `outreach_sweep_stale_reservations()` | reservations older than 10 minutes go back to `queued` |
| `outreach_release_waits()` *(011)* | expired delays advance; expired connection waits take `no_connect`; an enrichment wait gives up after **72 hours** and starts anyway; an AI routing wait falls back to `else` after **6 hours** |
| `outreach_release_waiting(p_lead, p_reason)` | releases `enrichment` and `ai_review` waits. An enrichment release turns into an `ai_review` wait when the sequence has `hold_for_ai_review` and lines are still pending |
| `outreach_enter_node`, `outreach_advance_enrollment` *(011)* | the engine loop. New node types: `ab_split`, `ai_route`, `call_task`. A lead whose step was removed by a publish completes cleanly (`node_missing`) |
| `outreach_complete_enrollment`, `outreach_create_node_task` | terminal transition with event; task creation. A `call` task body starts with the phone number |
| `outreach_eval_condition`, `outreach_eval_rule` *(011)* | condition nodes, with the enrichment fields from §13 |
| `outreach_planner_demand(p_sender, p_until)` *(011)* | what needs an action, with `needs_profile`, `variant_id`, `needs_posts` |
| `outreach_pick_mailbox(p_enrollment, p_node)` *(015)* | §19 |
| `outreach_health_inputs`, `outreach_verify_sender_token`, `outreach_rate_limit`, `outreach_audit`, `outreach_invoke`, `outreach_seed_workspace_defaults` | unchanged in purpose. Seeded stages now carry a `kind` |
| `outreach_emit_event(p_ws, p_event, p_payload)` *(015)* | webhooks, audit, and the CRM stream (§22) |
| RLS helpers: `outreach_is_service()`, `outreach_workspace_ids()`, `outreach_role_in(ws)`, `outreach_client_visible(ws, cid)`, `outreach_visible_clients(ws)`, `outreach_plan_active(ws)`, `outreach_can_write(ws)`, `outreach_can_manage(ws)`, `outreach_require(ws, p_min)`, `outreach_ws_tz(ws)` | `role_in` and `client_visible` also honour an API key's narrower scope (§21) |
| Triggers: `outreach_trg_reply_exit`, `outreach_trg_relation`, `outreach_trg_enrollment_exit`, `outreach_trg_sender_status`, `outreach_trg_sender_reconnected`, `outreach_trg_lead_dnc` (also stage → milestone), `outreach_trg_lead_list_rule`, `outreach_trg_action_stats`, `outreach_trg_message_stamp`, `outreach_trg_message_reply_stat`, `outreach_trg_message_rollup`, `outreach_trg_workspace_report_defaults`, `outreach_set_updated_at` | not callable directly |

### Tasks

`outreach_complete_task(p_id, p_text, p_result)` (member+): `review_ai_draft` queues the real action with the approved text, or skips the step on `{decision:'reject'}`. `manual_node` queues or advances. **`call`** requires `p_result.outcome` in `connected | voicemail | no_answer | wrong_number` and advances down that branch. **`reply_hold`** resumes or exits on `{decision:'resume'|'exit'}`.

### Recovery (item 8)

| Function | Who | What |
|---|---|---|
| `outreach_failed_leads(p_sequence, p_node_id, p_kind, p_limit, p_offset)` | client_viewer+ | failed enrollments (or skipped actions) with a plain `reason` from `outreach_reason_text(code, decision)` and a `recoverable` flag |
| `outreach_failed_summary(p_sequence)` | client_viewer+ | grouped by step and reason |
| `outreach_enrollment_recover(p_enrollment_ids, p_action)` | member+ | at most 500 ids. `retry` re-opens the lead on the same step, `skip` re-opens and advances, `exit` closes it as `exited_manual`. Refused per lead with a reason: `not_failed`, `lead_suppressed`, `profile_invalid` (retry only), `already_enrolled_again`, `sender_gone`. Emits `enrollment.recovered` |
| `outreach_requeue_sender_failures(p_sender)` | service: trigger `outreach_sender_reconnected` | when a sender goes from `credentials` or `error` to `ok`, its enrollments that failed in the last 7 days for a transient reason (network, 401, 5xx, sender not ok) are retried |

**There is no "restart from top", on purpose.** It would re-send messages the lead already received. To run a lead again, enrol it again; the preview's warnings apply.

### Rebalance (item 9)

`outreach_rebalance_preview(p_sequence, p_pool[])` and `outreach_set_pool(p_sequence, p_pool[], p_rebalance, p_contacted 'keep'|'exit')`, manager+.

**Only untouched leads move.** `outreach__untouched_enrollments` = not held, relation `none`, no `last_outbound_at`, no `invite_sent_at`, and no sent or reserved action other than a prefetch. The destination must not have a live enrollment for that lead and must never have contacted it. Queued actions of a moved lead are cancelled (`rebalanced`) and re-planned on the new sender. So nothing is duplicated and the lead never sees two senders. Leads a removed sender already contacted stay with it, or exit with `p_contacted = 'exit'`.

### Auto-enrol rules (item 18)

| Function | Who | What |
|---|---|---|
| `outreach_save_auto_enroll_rule(p_rule)`, `outreach_delete_auto_enroll_rule(p_id)` | manager+ | a rule needs a `list_id` or at least one filter (`tag_ids`, `stage_id`, `client_id`, `title_contains`, `company_contains`, `location_contains`, `source`, `min_followers`, `posted_within_days`). `daily_cap` 1–1000, default 50 |
| `outreach_rule_match_count(p_rule)` | member+ | "matches N leads" hint, capped at 5000 |
| `outreach_run_auto_enroll(p_rule?)` | service: cron `outreach-auto-enroll`, every 10 minutes | for each active rule on an active sequence in a workspace with an active plan: take up to `daily_cap − enrolled today (UTC)` candidates and call `outreach_enroll_leads` with `p_rule`. Writes `outreach_auto_enroll_log` |

**Invariants:** a rule enrols through the same plan as a person (suppression, replied recently, already enrolled, assignment rule). A lead is picked at most once per sequence, ever. `outreach_trg_lead_list_rule` flags a rule when a lead joins its list.

Other lead-source helpers (service): `outreach_save_import_schedule(p)` (member+; repeating imports, at most 50 active), `outreach_run_import_schedules()` (cron, every 15 minutes; turns due schedules into ordinary import jobs under the same budgets), `outreach_import_conversations(p_job)` (creates leads from existing chats, no LinkedIn call), `outreach_update_lead_fields(p_ws, p_match, p_fields, p_allowed)` (CSV update mode: never creates a lead, an empty cell never blanks a field).

## 19. Email depth (item 20)

| Function | Caller | What |
|---|---|---|
| `outreach_pick_mailbox(p_enrollment, p_node)` | service: the planner | candidates: `config.mailbox_sender_id`, else `config.mailbox_pool`, else the LinkedIn sender's own mailboxes (`parent_sender_id`), else mailboxes in the sequence pool. Only `ok`, not paused. **A contact who was emailed before keeps the same mailbox.** Otherwise the mailbox with the fewest emails in the last 20 hours |
| `outreach_unsubscribe_lead(p_lead, p_source)` | service: the `outreach-unsubscribe` function | sets `unsubscribed`; the existing trigger exits every sequence and cancels queued actions. Emits `lead.unsubscribed` |
| `outreach_add_tracking_domain(p_ws, p_hostname, p_sender)`, `outreach_remove_tracking_domain(p_id)` | manager+ | agency plans, or a workspace with branding set (`E_PLAN_REQUIRED`). Returns the CNAME record to `s1.lnk-fllw.com` |
| `outreach_tracking_domain_for(p_sender)` | service: the executor at send time | returns a hostname **only when the row is `active`**; the mailbox's own domain wins over the workspace default. Anything else → the default tracking domain |

`outreach_tracking_domains.status`: `pending_dns → awaiting_approval → active` (or `failed`). The move to `active` is manual, after Unipile authorises the domain. See [SETUP.md](SETUP.md) §9.8.

Mailboxes are sender rows. Their own `schedule` is the email schedule; 011 drops the unused `email_schedule` column. `senders.track_replies` (null = workspace `settings.track_replies`, default false) controls tracking on manual replies. Links carrying `data-disable-tracking` are not rewritten; the unsubscribe and booking links carry it.

## 20. White-label and booking (items 23 and 24)

| Function | Who | What |
|---|---|---|
| `outreach_set_branding(p_ws, p_branding)` | owner | validates and stores `product_name`, `logo_url` (https), `accent` (`#rrggbb`), `support_email`, `help_url`, `docs_url`, `email_from_name`, `email_from_address`, `hide_platform_name` |
| `outreach_branding(p_ws)` | client_viewer+ | owners and managers get everything; others get the public subset |
| `outreach_branding_for_host(p_hostname)` | **anon** | public subset plus `workspace_id`, `client_id`, `portal_only`, only for a domain with status `active`. Used before login on a custom domain |
| `outreach_branding_for_invite(p_token)` | **anon** | public subset for the invite page |
| `outreach_add_domain(p_ws, p_hostname, p_client)` | owner | at most 10. Returns two DNS records: a CNAME to the value of flag `portal_cname_target` and a TXT `_outreach-verify.<hostname>` with the verification token |
| `outreach_domains(p_ws)`, `outreach_remove_domain(p_id)` | manager+ / owner | list with DNS records and last check; remove |

The public subset (`outreach__public_branding`) never contains `email_from_address` or `email_from_name`. The `outreach-domain-check` worker verifies TXT and CNAME and sets `status`.

**Booking.** `senders.booking_link` is rendered as `{{sender.booking_link}}` or `{{booking_link}}` with `utm_content=<lead id>` appended. `outreach_record_booking(p_ws, p_provider, p_external_id, p_lead, p_email, p_status, p_starts_at, p_payload, p_sender)` (service: the `outreach-booking-webhook` function) finds the lead by id, else by email; upserts `outreach_booking_events` on `(provider, external_id)`; and for status `booked` records the `meeting` milestone, moves the lead forward to the `meeting` stage, completes every live enrollment (`meeting_booked`) and emits `meeting.booked`. The webhook path secret is `outreach_workspace_secrets.booking_secret`.

Voice clips: `outreach_save_voice_clip(...)` (the sender's owner or a manager; at most 60 s; path under `<ws>/voice/`). A sender without a clip skips the step with `no_voice_clip`. Find-email: `outreach_set_lead_email(p_lead, p_email, p_status, p_source)` (service) never overwrites an existing `email_work`.

## 21. Public API: keys and dispatch (item 21)

| Function | Who | What |
|---|---|---|
| `outreach_create_api_key(p_ws, p_name, p_role, p_client_ids, p_expires_at)` | manager+ | the key (`ok_live_` + 48 hex) is returned **once**; only its sha256 is stored. A key cannot be `owner`, cannot have more rights than its creator, and a workspace has at most 25 active keys. `outreach_api_keys.key_hash` is not selectable by `authenticated` (column-level grant) |
| `outreach_revoke_api_key(p_id)` | manager+ | |
| `outreach_api_authenticate(p_key)` | service: `outreach-api` | returns `null` for a revoked or expired key, or when the member who created it has left. The effective role is the **weaker** of key and member |
| `outreach_api_dispatch(p_key_id, p_fn, p_args)` | service: `outreach-api` | runs one allow-listed RPC as the key's member |
| `outreach_api_idempotent(p_key_id, p_idem, p_hash, p_status, p_response)` | service | `fresh`, `replay` (stored response), `conflict` (same key, different body), `in_progress` |
| `outreach_api_context`, `_leads`, `_lead`, `_sequences`, `_sequence`, `_enrollments`, `_threads`, `_thread`, `_senders`, `_sender`, `_webhooks`, `_deliveries` | user | read RPCs for the API, also usable by the connector. All go through `outreach_require` and client visibility. Lists are paged: `{data, total, limit, offset, has_more}`, limit at most 200 |
| `outreach_create_webhook`, `outreach_delete_webhook`, `outreach_replay_delivery(p_delivery)` | manager+ | replay inserts a new delivery row with `replay_of` and `replayed: true` in the payload |

**How impersonation works.** `outreach_api_dispatch` looks up `outreach_<p_fn>` in `pg_proc`, builds a call with **named** arguments cast to the declared parameter types, and before executing it sets, for the current transaction only (`set_config(..., true)`):

* `request.jwt.claims` (and the legacy `request.jwt.claim.*`) to `{sub: <key's user id>, role: 'authenticated', email, aud}`. `auth.uid()` now resolves to the member who created the key, so `outreach_require`, RLS helpers and audit rows behave exactly as for that person in the web app.
* `outreach.key_role` to the key's role. `outreach_role_in()` returns `greatest(member role, key role)`, which in this enum is the weaker of the two.
* `outreach.key_clients` to the key's client ids. `outreach_client_visible()` and `outreach_visible_clients()` intersect with it.

After the call it resets all of them to empty strings.

**Why it is safe.**

* Only the service role can execute the function (`revoke … from public, anon, authenticated`, plus an `outreach_is_service()` check). A browser session cannot impersonate anyone.
* `p_fn` must be in a fixed allow-list inside the function. There is no way to reach an arbitrary function, and the name is never interpolated from user input beyond that check.
* Argument names come from `pg_proc`, not from the request. Values are passed as one bound jsonb parameter (`using p_args`) and cast, never concatenated into SQL.
* A key can only ever narrow what its member can do: role by `greatest`, clients by intersection. If the member loses access, the key stops working at the next request.
* The settings are transaction-local, so they cannot leak into another request on a pooled connection.
* The business rules are the same functions the UI calls. Caps stay in the budget tables, so the API cannot out-send the UI.

## 22. CRM event stream (item 22)

Tables: `outreach_integrations` (one per workspace and provider: `hubspot | pipedrive | salesforce`; `settings.sync_rule` = `replied` (default) | `interested` | `enrolled`), `outreach_integration_secrets` (service only; encrypted tokens), `outreach_integration_events` (the stream), `outreach_crm_links` (lead ↔ CRM ids), `outreach_crm_sync_log` (one row per push or pull, visible to members).

`outreach_emit_event` appends to `outreach_integration_events` when the event is one of `message.sent`, `message.received`, `message.classified`, `email.sent`, `invite.accepted`, `enrollment.started`, `lead.updated`, `meeting.booked`, `lead.created` **and** the workspace has an integration with status `active`. Workspaces without a CRM write nothing. The `outreach-crm-sync` worker reads the stream from `integrations.last_event_id`. Rows older than 14 days are deleted nightly.

| Function | Who | What |
|---|---|---|
| `outreach_integration_save(p_id, p_settings, p_field_mapping, p_stage_mapping)` | manager+ | validates `sync_rule` |
| `outreach_integration_disconnect(p_id)` | manager+ | status `disconnected`, deletes the secrets row and the blacklist rows that came from that CRM. Nothing else is deleted |
| `outreach_crm_should_sync(p_integration, p_lead)` | service | true when the lead meets the sync rule, **or is already linked** (once linked, it stays up to date). The default, `replied`, syncs only leads with `last_replied_at` |

## 23. MCP agent layer (`008_agent_mcp.sql`)

`outreach_agent_gc()` (service) deletes expired confirmation, preview and draft tokens and old call logs. Tables `outreach_agent_confirmations`, `outreach_agent_previews`, `outreach_agent_drafts`, `outreach_agent_calls` are service-role only. The three `outreach_agent_*` edit functions are wrappers (§6).

## 24. Events (outbound webhooks, audit)

`lead.created`, `lead.updated`, `lead.unsubscribed`, `enrollment.started`, `enrollment.completed`, `enrollment.exited`, `enrollment.held`, `enrollment.resumed`, `enrollment.recovered`, `task.created`, `task.completed`, `sequence.activated`, `sequence.paused`, `sequence.published`, `sequence.stalled`, `sequence.recovered`, `sequence.webhook`, `sender.paused`, `sender.connected`, `sender.reconnected`, `sender.disconnected`, `sender.level_changed`, `sender.health`, `sender.running_dry`, `invite.sent`, `invite.accepted`, `invite.withdrawn`, `message.sent`, `message.received`, `message.classified`, `email.sent`, `email.opened`, `email.clicked`, `email.bounced`, `meeting.booked`, `workspace.billing_recovered`.

Subscribe with `outreach_outbound_webhooks.events` (array; `'*'` for all). Deliveries are signed: `x-signature = HMAC-SHA256(secret, body)`.
