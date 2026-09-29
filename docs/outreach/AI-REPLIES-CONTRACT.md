# AI Replies — build contract

Source PRD: `ai-auto-reply-PRD.md` (v1.1, 29 Sept 2026). This file fixes every name, signature and payload so the database,
the engine, the inbox, Settings, the MCP connector and the public consent page can be built in parallel. When code and this
file disagree, fix one of them in the same change.

Naming follows the platform: tables / enums / RPCs `outreach_*`, edge functions `outreach-*`, web routes `/outreach/*`.
Client code calls RPCs through `rpc('<name without the outreach_ prefix>', args)` and edge functions through
`callFn('<name without the outreach- prefix>', body)` (`lib/outreach/api.ts`).

## 0. Deliberate deviations from the PRD

| PRD | Here | Why |
|---|---|---|
| `pgmq.create('ai_reply')` | none — `outreach_ai_reply_runs` is the queue | the platform has no pgmq; every queue is a table claimed with `for update skip locked` |
| Sonnet-class draft, Haiku-class verify | the workspace's LLM (`llm.ts`: platform Gemini or the workspace's own key). Verify uses `OUTREACH_AI_VERIFY_MODEL` when set on the platform key, else the same model at low thinking | the platform runs on Gemini; "model ids are workspace config" is already true through `outreach_workspace_secrets` |
| `draft` for every workspace at launch | `draft` becomes effective once the workspace has **saved a master prompt**. Until then `off`, reason `no_master_prompt` | the shipped template is full of `<placeholders>`; drafting from it writes nonsense into every composer |
| a cheap classify call re-infers the stage after a human send without a draft | the chat is flagged `stage_stale`; the next draft call is told to infer the stage from the thread and its `stage_before` is taken | same result, no extra model call |
| F34–F37 as separate functions | two functions: `outreach-ai-reply` (HTTP: user + public consent actions, simulator, regression) and `outreach-ai-reply-worker` (cron, modes `draft` / `dispatch` / `maintenance`) | shared code, one deploy unit per trigger type, same pattern as `outreach-worker-channels` |
| Workspace AI action pool | new: `outreach_ai_reply_workspace.monthly_limit` (null = platform default flag `ai_reply_monthly_limit`, null = unlimited). Workspaces on their own LLM key are never limited | the platform had no pool |
| Knowledge sources in the drafter (P3) | `settings.knowledge_source_ids` is stored; retrieval returns no chunks until the web-chat knowledge tables exist (`retrieveKnowledge()` is the hook) | web-chat PRD not built |
| Mobile push on escalation | in-app (task + realtime) + email | no push channel exists |
| Graduation bypass "manager toggle" | platform-admin only, in the localhost-only Settings → Admin tab, audited | an owner could otherwise self-graduate; it is for dogfooding only |
| v1 LinkedIn only | runs are created for LinkedIn chats only; the engine is channel-agnostic (`CHANNELS_V1 = ['LINKEDIN']` in `ai_reply.ts`) | PRD §2.2 |

## 1. Enums (migration 034, own file)

Migrations: `034_ai_reply_enums.sql` (own call), `035_ai_reply_schema.sql`, `036_ai_reply_engine.sql` (engine functions, triggers,
patches to existing functions), `037_ai_reply_rpcs.sql` (app RPCs + grants), `038_ai_reply_cron.sql` (apply after the functions are
deployed). Test: `tests/smoke_09_ai_replies.sql`.

```
outreach_action_type_t  + 'ai_reply'
outreach_task_kind_t    + 'ai_escalation'
outreach_reply_mode_t        = off | draft | autopilot
outreach_ai_reply_status_t   = debouncing | drafting | draft_ready | scheduled | sending | sent | escalated | no_reply
                               | superseded | cancelled | failed | expired
outreach_ai_reply_decision_t = send | escalate | no_reply
```
Active statuses: `debouncing, drafting, draft_ready, scheduled, sending` (one per chat, partial unique index).

## 2. Tables (migration 035)

`outreach_master_prompts` — one per (workspace, scope, scope_id). scope `workspace | client | sequence`.
`id, workspace_id, scope, scope_id, editor_mode ('guided'|'raw'), version, body, sections jsonb, settings jsonb,
substantive_version int, substantive_at, graduated_at, graduation jsonb, graduation_checked_at, created_at, updated_by, updated_at`

`outreach_master_prompt_versions` — `(master_prompt_id, version)` PK, `editor_mode, body, sections, settings, change_kind ('style'|'substantive'), note, created_by, created_at`.

`outreach_reply_policies` — one per (workspace, scope, scope_id); scope `workspace | client | sequence | sender`. Every
field except the keys is nullable = inherit from the next scope (workspace row nulls fall back to the defaults below).
`mode, delay_min_s (≥60), delay_max_s (≤3600, > min), debounce_quiet_s (30–600), debounce_max_s (60–1800),
max_ai_sends_per_sender_day (1–40), stale_after_h (1–72), human_takeover_pause_h (1–720), disclosure text (≤200),
blocked_countries text[] (ISO-2), downgraded_at, downgrade_reason, note, updated_by, updated_at`.

Defaults (`outreach_ai_reply_defaults()`): mode `draft`, delays 240/1200 s, debounce 120/600 s, 25 sends/sender/day,
stale 12 h, takeover pause 72 h, disclosure null, blocked_countries = EU/EEA (applies only while disclosure is null).

`outreach_ai_reply_consent` — `id, workspace_id, sender_id, master_prompt_id, master_prompt_version, granted_by_email,
granted_via ('signed_link'|'owner_is_operator'), scope jsonb {daily_cap, delay_min_s, delay_max_s}, evidence jsonb,
granted_at, expires_at, revoked_at, revoked_reason, revoke_token_hash`. One live row per (sender, master prompt).
Valid = not revoked, not expired, and `master_prompt.substantive_version <= consent.master_prompt_version`.

`outreach_ai_reply_consent_links` — signed links (hash only): `id, workspace_id, sender_id, master_prompt_id,
master_prompt_version, email, token_hash, scope, examples jsonb, created_by, created_at, expires_at (7 d), used_at, cancelled_at`.

`outreach_ai_reply_runs` — PRD §11 columns plus: `client_id, sequence_id, provider, attempts, next_attempt_at,
followup_inbound_ids uuid[], sent_origin, facts_changed, reply_latency_s, drew_bot_question, drew_hostile, context jsonb
(thread + state snapshot the draft used), model, language, timings jsonb {inbound_at, drafted_at, scheduled_at, sent_at},
error, cancel_note, dispatched_by`.

`outreach_ai_reply_scenarios` — regression set: `id, workspace_id, master_prompt_id (null = workspace prompt), name,
turns jsonb, expected jsonb, last_result jsonb, last_version, last_run_at, passed, created_by, created_at, updated_at`.
`turns` = `[{from:'prospect'|'us', text}]` (the conversation; `us` lines are fixed earlier replies). `expected` =
`[{after_turn:int, decision:'send'|'escalate'|'no_reply', stage_after?:string}]`.

`outreach_ai_reply_workspace` — `workspace_id PK, graduation_bypass bool, monthly_limit int, note, updated_by, updated_at` (platform admin only).

Chats (+): `reply_mode_override, autopilot_state ('active'|'paused_human'|'paused_escalated'|'paused_bot'),
autopilot_paused_until, autopilot_paused_reason, conversation_stage, conversation_exchanges, ai_replies_count,
last_ai_move, stage_stale, is_group, ai_run_id, ai_run_status, ai_escalation_reason, ai_scheduled_send_at`.
The `ai_*` run columns are kept in sync by a trigger on runs (inbox filters + realtime use them).

Messages (+): `origin ('prospect'|'sequence'|'inbox_user'|'ai_autopilot'|'ai_draft_sent'|'ai_edited'|'external_device'|'unknown'),
ai_reply_run_id, ai_flags text[], classification jsonb, text_sha256`. `origin` and `text_sha256` are set by a BEFORE INSERT
trigger when the writer leaves them unset.

Realtime publication: `outreach_ai_reply_runs` added.

## 3. RPCs for the app, MCP and API (migration 037)

All security definer, `outreach_require()` + `outreach_client_visible()` (rule from the access audit). Errors raise `E_CODE: text`.
`RunSummary` = `{id, chat_id, status, decision, mode, draft_text, final_text, stage_before, stage_after, move, rule_applied,
escalation_reasons[], gate_failures[], side_effects[], facts_used[], draft_confidence, validator, verifier,
scheduled_send_at, master_prompt_id, master_prompt_version, sent_origin, cancel_reason, cancel_note, created_at, updated_at, timings}`.

| RPC (client name) | Role | Args → returns |
|---|---|---|
| `ai_reply_chat_state` | client_viewer (visible chat) | `p_chat` → `{chat_id, mode, requested_mode, source, source_label, reason_code, reason, can_autopilot, override, autopilot_state, paused_until, paused_reason, stage:{key,label,position,total}\|null, exchanges, ai_replies_count, max_ai_replies, master_prompt:{id,scope,version,editor_mode}\|null, run: RunSummary\|null (active), last_run: RunSummary\|null}` |
| `ai_reply_set_chat_mode` | member (autopilot: manager) | `p_chat, p_mode ('off'\|'draft'\|'autopilot'\|null=inherit)` → chat_state |
| `ai_reply_resume_chat` | manager | `p_chat, p_note` (required) → chat_state |
| `ai_reply_cancel` | member | `p_run, p_reason ('wrong_facts'\|'wrong_tone'\|'too_early_to_pitch'\|'shouldnt_reply'\|'answer_myself'\|'other'\|'dismissed'), p_note default null` → RunSummary. `scheduled` runs need a reason other than `dismissed` |
| `ai_reply_apply_no_reply` | member | `p_run` (draft-mode run whose decision is `no_reply`) → RunSummary; runs its side effects |
| `ai_reply_runs_list` | member | `p_ws, p_filters jsonb {status[], decision, mode, sequence_id, sender_id, chat_id, stage, reason, since}, p_limit default 50, p_before timestamptz` → `{items:[RunSummary + {sender_id, lead_id, lead_name, sender_name, sequence_id, sequence_name, inbound_text}], next_before}` |
| `ai_reply_run_get` | member | `p_run` → list item + `{context, policy_snapshot, master_prompt:{id,version,body,editor_mode}}` |
| `reply_policy_list` | member | `p_ws` → `{defaults, rows:[{id, scope, scope_id, scope_label, ...fields, downgraded_at, downgrade_reason, updated_at}]}` |
| `reply_policy_set` | manager | `p_ws, p_scope, p_scope_id, p_patch jsonb, p_note default null` → row. A `null` value in the patch = inherit. Re-enabling `autopilot` on a downgraded row needs `p_note` |
| `reply_policy_clear` | manager | `p_ws, p_scope, p_scope_id` (not workspace) |
| `master_prompt_template` | member | → `{editor_mode, body, sections, settings}` |
| `master_prompt_get` | member | `p_ws, p_scope default 'workspace', p_scope_id default null, p_version default null` → `{exists, id, scope, scope_id, scope_label, editor_mode, version, body, sections, settings, substantive_version, updated_at, updated_by_name, graduated, inherited:{scope,id,version}\|null, template}` |
| `master_prompt_save` | manager | `p_ws, p_scope, p_scope_id, p_editor_mode, p_body, p_sections, p_settings, p_change_kind, p_note default null, p_base_version default null` → get shape. Stale `p_base_version` → `E_CONFLICT`. First save is always substantive. **The app calls the edge action `master_prompt_save` instead (re-consent emails).** |
| `master_prompt_versions` | member | `p_mp` → `[{version, change_kind, note, editor_mode, body, sections, settings, created_at, created_by_name}]` |
| `master_prompt_list` | member | `p_ws` → `[{id, scope, scope_id, scope_label, version, editor_mode, updated_at, graduated_at, graduation}]` |
| `master_prompt_delete` | manager | `p_ws, p_scope, p_scope_id` (client / sequence only) |
| `ai_consent_list` | manager | `p_ws` → `[{sender_id, sender_name, provider, owner_email, owner_is_me, consents:[{id, master_prompt_id, scope_label, master_prompt_version, valid, needs_reconsent, granted_via, granted_by_email, granted_at, expires_at, scope}], pending_links:[{id, master_prompt_id, email, created_at, expires_at}]}]` |
| `ai_consent_revoke` | manager | `p_consent, p_reason` |
| `ai_consent_grant_operator` | the sender's owner | `p_sender, p_mp` → consent row |
| `ai_reply_graduation` | member | `p_ws, p_mp` → `{eligible, graduated_at, bypass, window_days, since_version, drafts_sent, light_edits, light_edit_share, facts_changed, regression:{total, passed, last_run_at}, requirements:{min_drafts, min_share}, missing:[text]}` |
| `ai_reply_metrics` | member | `p_ws, p_from date, p_to date, p_group ('none'\|'sequence'\|'sender'\|'stage'\|'master_prompt'\|'client')` → `{totals:{runs, sent_ai, sent_human_draft, escalated, no_reply, cancelled, expired, failed, superseded, draft_p50_s, draft_p95_s, send_p50_s, light_edit_share, bot_question_rate, hold_cancel_rate}, groups:[{key, label, ...totals}], escalation_reasons:[{reason, n}], cancel_reasons:[{reason, n}]}` |
| `ai_reply_cancel_report` | member | `p_ws, p_days default 30` → `[{rule_applied, reason, n, run_ids[]}]` |
| `ai_reply_scenarios_list` | member | `p_ws, p_mp default null` → rows |
| `ai_reply_scenario_save` | manager | `p_ws, p_id (null = new), p_mp, p_name, p_turns, p_expected` → row |
| `ai_reply_scenario_delete` | manager | `p_id` |
| `ai_reply_pool` | member | `p_ws` → `{month, used, limit, own_key, ok}` |
| `ai_reply_admin_list` / `ai_reply_admin_set` | platform admin | `()` → rows; `p_ws, p_bypass, p_monthly_limit, p_note` |

Service-only (engine, migration 036): `ai_reply_enqueue`, `ai_reply_claim`, `ai_reply_gate_facts`, `ai_reply_finalize`,
`ai_reply_on_human_send`, `ai_reply_on_outbound_external`, `ai_reply_on_message_change`, `ai_reply_dispatch_claim(p_limit, p_run)`,
`ai_reply_prepare_send(p_run, p_ignore_window)` ("Send now" skips the working-hours check only), `ai_reply_mark_sent`,
`ai_reply_send_failed`, `ai_reply_reschedule`, `ai_reply_expire`, `ai_reply_breakers`, `ai_reply_graduation_refresh`,
`ai_reply_after_classify`, `ai_reply_digest_data`, `ai_reply_scenario_record`, `ai_consent_link_create / _view / _accept`,
`ai_consent_revoke_by_token`, `ai_consent_revoke_view`. `ai_reply_admin_list` rows also carry `default_limit` (the platform flag).

## 4. Edge functions

`outreach-ai-reply` — HTTP, `callFn('ai-reply', {action, ...})`:

| action | who | body → result |
|---|---|---|
| `send_now` | member | `{run_id}` → `{ok, message}` (a scheduled run is sent now, through the §7.3 recheck) |
| `simulate` | manager | `{workspace_id, scope?, scope_id?, sender_id?, lead?:{full_name,title,company,location}, draft_prompt?:{editor_mode, body, sections, settings}, version?, state?:{stage, exchanges, last_move, ai_replies_count}, thread:[{from:'prospect'\|'us'\|'teammate'\|'ai', text, at?}]}` → `{decision, final_decision, text, stage_before, stage_after, move, rule_applied, side_effects, facts_used, confidence, escalation_reasons, validator, verifier, classification:[...], gates:[{gate, ok, detail}], redrafted, state_after, model, ms}`. Never sends, never writes runs |
| `regression_run` | manager | `{workspace_id, master_prompt_id?, scope?, scope_id?, draft_prompt?}` → `{total, passed, results:[{scenario_id, name, passed, turns:[{after_turn, expected, got:{decision, stage_after, text}, prev_text, changed}]}]}`; records `last_result` unless `draft_prompt` is given |
| `master_prompt_save` | manager | RPC args as JSON (`workspace_id, scope, scope_id, editor_mode, body, sections, settings, change_kind, note, base_version`) → `{prompt, reconsent:{senders:n, links:[{sender_id, sender_name, url}]}}` (links returned only when email is not configured or the owner has no email) |
| `consent_request` | manager | `{workspace_id, sender_id, master_prompt_id}` → `{granted:true}` (caller owns the sender) or `{link, emailed, expires_at}` |
| `consent_view` | public | `{token}` → `{status:'pending'\|'accepted'\|'expired'\|'cancelled'\|'outdated', sender_name, workspace_name, branding, email, master_prompt:{body, version, scope_label}, scope:{daily_cap, delay_min_s, delay_max_s}, examples:[{prospect, reply, stage, stage_label, decision}], expires_at, consent_months}`. Unknown token → 404 `E_NOT_FOUND` |
| `consent_accept` | public | `{token}` → `{ok, revoke_url}` |
| `consent_revoke_view` | public | `{token}` → `{status:'active'\|'revoked', sender_name, workspace_name, branding, email}` (read only: mail scanners open links) |
| `consent_revoke` | public | `{token}` (the revoke token from the email) → `{ok, revoked}`; revokes every live consent of that sender and turns its scheduled sends into drafts |

`outreach-ai-reply-worker` — cron (`x-cron-secret`), body `{mode}`:
`draft` (every 15 s, `outreach-ai-reply-worker`), `dispatch` (every minute, `outreach-ai-reply-dispatch`),
`maintenance` (every 15 min: expire, stuck runs, breakers at :07, graduation + digests daily).

`outreach-send-reply` body gains `ai_run_id?: string`: the composer passes the run whose draft it pre-filled; the server
decides `ai_draft_sent` vs `ai_edited` from the text and stores `edit_distance`.

## 5. Conversation stages and moves

Stage keys come from `settings.stages[].key` (default `engage, relate, pitch, next_step`); `closing` is always allowed as a
terminal stage. Moves: `answer, ask, relate, insight, pitch, cta, schedule, close, acknowledge`.

Default `settings`: `{stages:[{key:'engage',label:'Engage',early:true},{key:'relate',label:'Relate',early:true},
{key:'pitch',label:'Pitch',pitch:true},{key:'next_step',label:'Next step'}], min_exchanges_before_pitch:2,
skip_to_pitch_when:['asked_offer','pricing','meeting_request','meeting_time_proposed','explicit_interest'],
vary_moves_in_early_stages:true, max_ai_replies_per_chat:6, languages:['en'], allow_language_switch:false,
bot_question:'escalate', handoff_stage_id:null, knowledge_source_ids:[], max_length:600}`.

Guided `sections`: `{who, flow, situations, handoff, facts, style}` (markdown text each); each stage also has
`instructions` in `settings.stages[]`. The body is compiled by `outreach__compile_master_prompt(sections, settings)`.

## 6. Classification (F18 extended)

`messages.classification` = `{intent, confidence, summary, language, flags[], questions[], dates[{text, iso}],
referred[{name, role, email, phone}], do_not_contact}`; `messages.ai_flags` = flags. Flags: `asked_offer, pricing,
meeting_request, meeting_time_proposed, explicit_interest, bot_question, legal_or_contract, hostile, complaint,
injection_suspected, competitor_mentioned, close_only, attachment_mentioned`.

## 7. UI surfaces (file ownership)

| Surface | Files |
|---|---|
| Shared client types + hooks | `lib/outreach/aiReplies.ts` |
| Inbox: header chip + override, composer draft, hold banner, badges, filters | `components/outreach/inbox/{Thread,Compose,MessageBubble,ChatList,InboxView}.tsx`, new `components/outreach/inbox/ai/*` |
| Settings → AI replies | `app/outreach/settings/ai-replies/page.tsx`, `components/outreach/settings/ai-replies/*`, tab entry in `SettingsTabs.tsx` |
| Sequence settings: policy + master-prompt override | `components/outreach/sequences/SequenceSettingsPanel.tsx` (link to Settings → AI replies with scope) |
| Admin (localhost only): graduation bypass + monthly limit | `components/outreach/settings/admin/AiReplyAdmin.tsx` |
| Public consent page | `app/ai-reply-consent/[token]/page.tsx`, `app/ai-reply-consent/revoke/[token]/page.tsx` |
| MCP | `supabase/functions/outreach-mcp/tools_ai_replies.ts`, `tools_inbox.ts` (`inbox_pending.ai_run`, `inbox_send_*` pass `ai_run_id`) |
| Skill | `claude-skill/outreach/ai-replies.md` + SKILL.md pointer |

Customer-facing copy never names the connector vendor (see SETUP.md rule).

## 8. Operations

- **Apply order:** 034 (own call) → 035 → 036 → 037 → deploy `outreach-ai-reply`, `outreach-ai-reply-worker` and every function
  that bundles the changed shared files (inbound.ts, reply.ts, workers.ts, ai.ts, llm.ts, prompts.ts: process-inbound,
  send-reply, ai-classify, api, mcp, and the rest via `scripts/outreach-deploy-functions.sh`) → 038 (cron). The webhook
  handler writes `outreach_chats.is_group`, so the functions must not go out before 035.
- **Kill switch:** `select cron.unschedule(jobname) from cron.job where jobname like 'outreach-ai-reply%';` stops drafting and
  sending; runs stay where they are. Per workspace: set the workspace reply policy to `off`.
- **Optional secret:** `OUTREACH_AI_VERIFY_MODEL` (a cheaper model for the verifier on the platform key). Without it the
  verifier uses the platform model at low thinking.
- **Allowance:** `outreach_flags.ai_reply_monthly_limit` (number or null) is the platform default of draft calls a month per
  workspace on the platform key; the Admin tab sets per-workspace limits and the graduation bypass.
- **Model calls are logged** to `outreach_ai_calls` with purpose `classify`, `reply_draft`, `reply_verify`, `reply_simulate`,
  `reply_simulate_verify`. Only `reply_draft` counts against the allowance.
- **Tests:** `tests/smoke_09_ai_replies.sql` (SQL, rolls back) and `supabase/functions/_shared/outreach/ai_reply_rules_test.ts`
  (`deno test --node-modules-dir=none`).

## 9. Safety rules added after review (2026-09-29)

- **One mutator per chat:** every path that changes a chat's runs takes `outreach__ai_chat_lock(chat)` (advisory, per
  transaction); the claims skip a busy chat. Keeps lock order fixed (no deadlocks between worker, dispatcher, webhook, people).
- **People before the connector:** `send-reply` calls `ai_reply_before_human_send(chat, run)` BEFORE sending: refuses with
  `E_AI_SENDING` / `E_AI_ALREADY_SENT` when an AI send is in flight or done, holds the draft being sent back as `draft_ready`,
  cancels the chat's other pending runs. `prepare_send` also treats a teammate `reply` still `reserved` as a takeover.
- **No blind resend:** a connector timeout or 5xx may have delivered, so the run fails and a person is asked to check; only a
  429 is retried (`send_attempts`, separate from draft `attempts`). If the webhook later shows the text, the run becomes `sent`
  and the task closes. `mark_sent` is retried on its own and never turns a delivered send into "failed".
- **Rewrites:** a reply that differs from the AI draft by more than 0.5 (normalised edit distance) is the person's own:
  origin `inbox_user`, no AI side effects, no graduation credit.
- **Chat columns:** a BEFORE UPDATE trigger rejects direct writes to the AI columns of `outreach_chats` by signed-in users;
  only the RPCs and the service role change them. Clearing a chat override needs a manager.
- **Unlabelled messages:** a burst the classifier did not label (error, or no AI) stays in draft mode: the fixed safety
  checks depend on its flags.
- **Dispatch rechecks G13 / G14** (`prepare_send(p_run, p_ignore_window, p_country)`); follow-up messages that arrived during a
  send get their own run however that run ends; breakers judge only holds after `reply_policies.breaker_reset_at`.
- Table policies on prompts, versions, policies and scenarios are client-scoped (`outreach_ai_scope_client_of`).
