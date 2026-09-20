# Build contract for `outreach-product-plan.md`

This is the shared contract for everyone building a surface (web app, connector, public API, workers) on top of the database layer in `migrations/outreach/009…016`. The database is **already applied to the live project** and smoke-tested (`migrations/outreach/tests/`). Do not change the SQL files; if you find a bug in one, report it in your final message with the exact fix instead.

Read first: `outreach-product-plan.md` (what and why), `docs/outreach/RPC-SIGNATURES.md` (every function, generated from the database), and the migration file of the feature you build (the SQL is the source of truth for return shapes).

## Rules that hold for every item

1. **One RPC, three surfaces.** A feature is an `outreach_*` SQL function. The web app calls it with `rpc('name', args)` from `lib/outreach/api.ts`, the connector with `urpc(ctx, 'name', args)`, the public API through `outreach_api_dispatch`. Never re-compute a number or re-implement a rule in TypeScript.
2. **Safety stays in the database.** No new code path calls Unipile outside the allowed functions (`worker-tick` via `execute.ts`, `send-reply`, imports, reconnect, `sender-*`, and the new `worker-enrich`). Every LinkedIn call reserves a budget first: `reserve_budget` → call → `consume_budget` (or `release_budget` on failure). Caps can never be switched off.
3. **Nothing AI-written sends without a person approving it.** `{{ai.<key>}}` resolves only to `outreach_ai_values.status = 'approved'` text (the render context already enforces this). AI drafts stay approval tasks.
4. **Nothing deletes history.** Blocking, suppressing, cancelling keep the lead, the timeline and the chat.
5. Naming: tables / RPCs `outreach_*`, edge functions `outreach-*`, routes `/outreach/*`. Errors are `E_CODE: message`; show `parseError(e).message`.
6. UI copy: plain words, short sentences, no em-dash chains, no "leverage / seamless / robust". Sentence case. Say what happened and what to do next.

## File ownership (do not edit files another workstream owns)

| Workstream | Owns |
|---|---|
| ENGINE-SEND | `supabase/functions/_shared/outreach/{render,execute,planner,enrich,finder,drafts,unipile,errors,crypto}.ts`, `lib/outreach/render.cases.json`, `lib/outreach/render.ts`, `lib/outreach/render.test.ts`, `supabase/functions/outreach-worker-enrich`, `outreach-unsubscribe`, `outreach-worker-tick`, `outreach-worker-planner` |
| ENGINE-AI | `_shared/outreach/{ai,llm,prompts}.ts`, `supabase/functions/outreach-ai-variables`, `outreach-workspace-secrets`, `outreach-ai-draft`, `outreach-ai-sequence-qa` |
| ENGINE-OPS | `_shared/outreach/{workers,inbound,notify,health,reports_email,unipile_sources}.ts` (new Unipile endpoints go in `unipile_sources.ts` through the exported `unipileRequest`; do not edit `unipile.ts`), `outreach-worker-health`, `outreach-worker-reports`, `outreach-worker-imports`, `outreach-imports-create`, `outreach-booking-webhook`, `outreach-domain-check`, `outreach-stripe-webhook`, `outreach-billing-sync`, `outreach-send-reply`, `outreach-ai-classify`, `scripts/outreach-deploy-functions.sh`, `scripts/outreach-set-secrets.sh` |
| CONNECTOR | `supabase/functions/outreach-mcp/**`, `claude-skill/**` outreach skill, `scripts/outreach-parity-test.*` |
| API | `supabase/functions/outreach-api/**`, `docs/outreach/API.md`, `docs/outreach/openapi.json`, `docs/outreach/recipes/**` |
| CRM | `supabase/functions/outreach-crm-oauth/**`, `outreach-crm-sync/**`, `_shared/outreach/crm/**` |
| WEB-BUILDER | `components/outreach/sequences/{Builder,TopBar,Canvas,Modals,Projection,PoolSelector,EnrollmentsTable,hooks,helpers}.tsx/ts` + new files there prefixed `Publish*`, `Draft*`, `Queued*`, `Failed*`, `Rebalance*`, `WhyNotSending*`, `SequenceSettings*`, `AutoEnrol*`; `app/outreach/sequences/**` except `[id]/enroll` |
| WEB-NODES | `lib/outreach/{types,nodes,graph}.ts`, `components/outreach/sequences/{NodeConfigPanel,NodePalette,ConditionEditor,TemplateField,FormsOutreach,FormsLogic}.tsx` + new `Forms*`, `Variant*`, `Spintax*`, `VoiceClip*`, `AiRoute*`; `app/outreach/sequences/[id]/enroll/**`; `components/outreach/leads/EnrollModal.tsx` |
| WEB-REPORTS | `app/outreach/reports/**`, `components/outreach/reports/**`, `lib/outreach/reports.ts`, `app/outreach/page.tsx` (dashboard), `app/outreach/c/**` (client portal), `app/outreach/clients/**` |
| WEB-SENDERS | `app/outreach/senders/**`, `components/outreach/senders/**` |
| WEB-INBOX-LEADS | `components/outreach/inbox/**`, `app/outreach/inbox/**`, `components/outreach/leads/**` (except `EnrollModal.tsx`), `app/outreach/leads/**`, `app/outreach/tasks/**`, `components/outreach/tasks/**`, `app/outreach/ai-review/**`, `components/outreach/ai/**`, `lib/outreach/intel.ts` |
| WEB-SETTINGS | `app/outreach/settings/**`, `components/outreach/settings/**`, `components/outreach/{OutreachNav,Shell}.tsx`, `contexts/OutreachWorkspaceContext.tsx`, `lib/outreach/branding.ts`, `proxy.ts` (Next 16 renamed `middleware.ts` to `proxy.ts`; custom-domain host resolution), `app/outreach/invite/**` |
| DOCS | `docs/outreach/{SQL-REFERENCE,SETUP,FRONTEND-BRIEF}.md`, `docs/outreach/EXTENSION-UNPACKED-INSTALL.md`, `docs/outreach/POLICIES.md`, `outreach-vs-competitors.md` |

Shared, append-only with care: `lib/outreach/queries.ts` and `lib/outreach/api.ts` — **do not edit them**; put new hooks / helpers in a file your workstream owns. Web workstreams that need new TypeScript types define them in their own file (WEB-NODES owns `lib/outreach/types.ts`).

Routes that the nav (WEB-SETTINGS) links to: `/outreach/reports`, `/outreach/ai-review`, `/outreach/settings/{workspace,members,safety,suppressions,webhooks,billing,ai,email,api,integrations,branding}`.

## Feature → RPC map

### Item 1 — reply stop, hold, out-of-office
- Sequence `settings`: `stop_on_reply` (bool), `stop_on_reply_scope` `'lead'`(default)`|'sender'`, `on_reply` `'exit'`(default)`|'hold'`, `resume_after_ooo` (bool, default true), `ooo_resume_days` (int, 7), `hold_max_days` (30), `wait_for_enrichment` (bool), `hold_for_ai_review` (bool), `withdraw_after_days`.
- Executor: `outreach_enrollment_reply_blocked(p_enrollment, p_action_sender)` replaces every read of `lss.replied`. On true → settle with decision `replied`.
- Classifier: after writing the intent call `outreach_apply_reply_intent(p_message, p_intent, p_return_date)` (service). It re-opens OOO exits, auto-stages interested leads, records the milestone.
- Held leads: `enrollments.held_at is not null` (status `paused`). Task kind `reply_hold`; complete it with `complete_task(p_id, null, {decision:'resume'|'exit'})`, or call `resume_enrollment` / `exit_enrollment`.
- Enrol guard: `outreach_enroll_preview(p_sequence, p_lead_ids, p_sender, p_include_replied)` → `{requested, eligible, eligible_ids[], excluded:{reason:{count,sample_ids}}, replied_recently:[{id,name,company,last_replied_at,channel}], assignment:[{sender_id,name,status,leads}], assignment_rule, rule_effects:{note:count}, projection:{estimated_days,bottleneck}, warnings[]}`. Reasons: `not_in_workspace`, `suppressed:<why>`, `replied_recently`, `already_enrolled`, `no_fresh_sender`. Commit with `outreach_enroll_leads(p_sequence, p_lead_ids, p_sender, p_priority, p_include_replied, p_rule, p_wait_enrichment)` → one row `{enrolled, skipped_active, skipped_suppressed, skipped_other, skipped_replied, waiting}`.

### Item 2 / 10 — numbers
All take inclusive **dates** (`YYYY-MM-DD`) in the workspace timezone (`settings.timezone`). Every totals object has the same keys (see `outreach__totals_from` in 013): `enrolled, invites, invites_with_note, accepted, acceptance_rate, messages, inmails, emails, touches, replies, reply_rate, interested, interested_rate, positive_reply_rate, negative_reply_rate, intents{interested,question,not_now,not_interested,ooo,wrong_person,unclear,unclassified}, meetings, won, lost, won_value, inbound_messages, profile_views, likes, comments, endorsements, follows, withdrawn, post_fetches, failed, skipped, limit_hits, email_opened, email_clicked, email_bounced, open_rate, click_rate, bounce_rate`. Rates are percentages with one decimal, `null` when the denominator is 0.
- `report_overview(p_ws, p_client, p_from, p_to, p_filters{sequence_id,sender_id,node_id,channel})` → `{period{from,to,days,timezone,previous_from,previous_to}, totals, previous, by_channel{linkedin,email}, series[{day,…totals}]}`
- `report_funnel(p_ws, p_client, p_from, p_to, p_filters{sequence_id,sender_id,list_id,tag_id})` → `{cohort, stages[{stage,count,pct_of_enrolled,pct_of_previous,median_hours_from_previous}]}` stages: enrolled, invited, accepted, messaged, replied, interested, meeting, won.
- `report_intents(p_ws, p_client, p_from, p_to, p_group 'day'|'sequence'|'step'|'sender'|'variant'|'channel', p_filters)` → `{replies,touches,reply_rate,positive_reply_rate,negative_reply_rate,intents,rows[{key,label,replies,touches,reply_rate,intents,…}]}`
- `report_reply_threads(p_ws, p_client, p_from, p_to, p_intent, p_filters{sequence_id,sender_id,node_id,variant_id})` → rows `{chat_id, lead_id, lead_name, sender_id, intent, replied_at, sequence_id, node_id, variant_id, preview}`. Clicking a number opens the inbox with exactly these `chat_id`s.
- `report_sequences`, `report_senders`, `report_clients` → arrays with `totals`. `report_sequence(p_sequence,…)` → `{sequence, totals, steps[], best_step, worst_step, ab_tests[], exits{}, live}`. `report_sender`, `report_client`, `report_cost` (see 013). `metric_definitions()` → tooltips.
- `dashboard(p_ws)` now also returns `today`, `last_7_days` (totals objects), `ai_lines_awaiting`, and attention kinds `sequence_stalled`, `sender_running_dry`, `import_failed`, `held_leads`, `failed_leads`, `ai_review`.
- Saved ranges: table `outreach_saved_ranges` (RLS: own rows) + `save_range(p_ws,p_name,p_preset,p_from,p_to)`. Schedules: table `outreach_report_schedules` (kind `digest|client_report|sender_report`, RLS manager write).

### Item 3 — stall alerts
- `why_not_sending(p_sequence, p_sender, p_enrollment)` → `{target, blocked, reason (plain sentence), causes[{code,blocking,detail,remedy,sender,sender_id,next_capacity,partial?}], notes[], rule}`. The connector tool and the UI button both call this.
- `detect_stalls()` (service, health worker each cycle) → `{opened:[{alert_id,kind,workspace_id,entity_id,label,reason}], resolved}`; email owners + managers + `senders.alert_emails`, then `mark_alerts_notified(ids)`. Table `outreach_alerts` (realtime). `sequences.stalled_at/stalled_reason`, `senders.running_dry_at`. Events `sequence.stalled`, `sequence.recovered`, `sender.running_dry`.

### Item 4 — attribution
- `thread_attribution(p_chat)` → per message `{message_id, kind 'automated'|'manual'|'inbound', sequence_id, sequence_name, node_id, step_number, step_label, node_type, variant_id, variant_label, sender_name, sent_by_name, replying_to_message_id}`.
- `sequence_chat_ids(p_sequence)` → chat ids for the inbox filter. `messages.sent_by` must be set by `send-reply` (the teammate's user id).

### Items 5–7 — drafts, publish, queued edits
- `save_draft(p_id, p_graph)` → `{saved_at, base_version, head_version, stale, unpublished_changes}`; `discard_draft(p_id)`. Columns on `outreach_sequences`: `draft_graph, draft_updated_at, draft_updated_by, draft_base_version`.
- `publish_impact(p_id, p_graph?)` → `{head_version, draft_base_version, stale, changes, in_flight, already_pinned, on_changed_step, past_changed_step, on_or_after_changed, before_changed_step, queued_with_old_text, waiting_on_changed_delay, removed_nodes[], nodes[{node_id,change,type,text_changed,delay_changed,leads_here,queued}], validation{errors,warnings}}`.
- `publish_sequence(p_id, p_graph?, p_mode 'all'|'new_only', p_note, p_force, p_update_queued, p_reschedule_delays, p_removed_mode 'skip'|'exit', p_pool, p_settings, p_name, p_assignment, p_brief)` → `{version, mode, pinned, queued_updated, rescheduled, removed_step_leads}`. Raises `E_DRAFT_STALE` when someone else published meanwhile (offer "review and publish anyway" → `p_force`).
- Never-activated sequences keep using `save_sequence`.
- `version_usage(p_sequence)` → rows `{version, created_at, note, publish_mode, is_head, live_leads}`; `move_to_latest(p_sequence, p_version)` → `{moved, kept_on_old_version}`.
- Queued: `node_queued_actions(p_sequence,p_node_id)`, `set_action_text(p_action,p_text,p_subject?)`, `refresh_queued_text(p_sequence,p_node_id)` ("Update them too"), `reschedule_delay(p_sequence,p_node_id)`, `lead_queued_actions(p_lead)` → `{action_id,…,body,subject,editable}`, `skip_action(p_action)`, `reschedule_action(p_action,p_at)`.
- `outreach_node_stats` now has one row per `(sequence_id, node_id, variant_id)` (`''` = no variant) plus `interested`: **sum the rows per node** on the canvas.

### Item 8 — failed leads
`failed_leads(p_sequence, p_node_id?, p_kind 'failed'|'skipped', p_limit, p_offset)` → rows with plain `reason`; `failed_summary(p_sequence)` grouped by reason; `enrollment_recover(p_enrollment_ids[≤500], p_action 'retry'|'skip'|'exit')` → `{done, action, refused:[{id,reason}]}`. There is deliberately no "restart from top".

### Item 9 — rebalance
`rebalance_preview(p_sequence, p_pool[])` → `{pool_size, added[], removed[], untouched_total, would_move, target_per_sender, senders[{sender_id,name,status,in_pool,untouched,contacted,after}], contacted_on_removed, note}`; `set_pool(p_sequence, p_pool[], p_rebalance, p_contacted 'keep'|'exit')` → `{pool, moved, exited}`.

### Item 11 — A/B
- Message variants live in the step config: `config.variants: [{id, label, text|note|html, subject?, weight}]` (≤5). `outreach_pick_variant(enrollment, node_id, variants)` is sticky; preview it with the same call. The planner gets the variant-resolved config from `planner_demand` (`node.config` already merged, `variant_id` column) and must put `variant_id` in the action payload (and on direct email inserts set the `variant_id` column).
- `ab_split` node: `config.branches: [{id,label,weight}]`, `branches: {<id>: nodeId}`.
- `ab_results(p_sequence,p_node_id,p_from,p_to)` → `{judged_on, enough_data, min_sends_per_variant:100, variants[{variant_id,label,weight,sent,accepted,replies,interested,…rates,is_leading,confidence_vs_leader,verdict_vs_leader}], leader, can_promote}`; `promote_variant(p_sequence,p_node_id,p_variant)`.

### Item 12 — sender insights
`sender_insights(p_sender)` → `{sender, health_breakdown, recommendations[{severity,area,text}], warmup{level,max_level,locked_until,next_level_on,unlocks,caps_now,caps_next}, last_30_days{headroom_pct,limit_hits,acceptance_rate,acceptance_rate_previous,network_growth,…}, invites_vs_cap[{day,sent,cap}], inmail_guard{max_today,rule}}`. The health worker writes a daily `outreach_sender_events` row `kind='snapshot'`, `data.connections_count`.

### Item 13 — enrichment
- Tables `outreach_lead_profiles`, `outreach_enrich_queue`; `leads.enrich_status` (`none|waiting|done|failed`), `leads.enriched_at`.
- Free path (executor): every profile fetch requests the named sections `about,experience,education,skills,languages` with `notify:false` for prefetches, then `save_lead_profile(p_lead, p_profile, p_sender, p_source)` (empty sections never overwrite; returns `{saved, empty_sections, throttled}`). Skip full sections while `senders.enrich_backoff_until > now()`.
- Posts: action type `post_fetch` (own budget). `save_lead_posts(p_lead, p_posts[{id,text,date,reactions,comments,url}], p_sender)`. Fetch posts only when `planner_demand.needs_posts` is true (or a like / comment step needs them).
- Backlog worker: `enrich_allowance(p_sender, p_priority)` → how many views now; `enrich_next(p_sender, p_limit)`; `enrich_done(p_lead,p_sender,p_ok,p_error,p_background)`. UI: `request_enrichment(p_ws, p_lead_ids, p_want_posts, p_force, p_reason)`.
- Conditions: fields `enrich.is_enriched, enrich.months_in_role, enrich.past_company, enrich.skill, enrich.posted_within_days, enrich.follower_count, enrich.connections_count, enrich.language, enrich.about, enrich.education`; ops add `gte`, `lte`. Also `has_phone`, `call_outcome`.

### Items 14–16 — AI variables, routing, templates
- Render context for preview AND send: `render_context(p_lead, p_sender, p_enrollment)` → `{lead, sender{…,booking_link,signature}, enrich{about,current_title,current_company,years_in_role,months_in_role,previous_company,previous_title,school,degree,top_skill,skills,language,follower_count,connections_count,recent_post,recent_post_date}, ai{<key>: approved text}, seed}`.
- Template syntax (both renderers, identical, one shared test file): `{{var|fallback}}`, paths `lead.*` (bare names), `custom.x`, `sender.x`, `enrich.x`, `ai.x`, `unsubscribe_link`, `booking_link` (= sender.booking_link with `?utm_content=<lead id>` style tracking param); spintax `{a|b|c}` (single braces, ≥1 pipe, seeded by `seed` + position so preview == send); conditionals `{{#if path}}…{{else}}…{{/if}}`. `outreach_spintax_info(text)` → `{max_len, combinations}` is the validator's measure.
- AI variables: table `outreach_ai_variables` (RLS: manager write). `ai_generate_request(p_ws,p_variable,p_lead_ids,p_sequence,p_regenerate)` → `{batch_id,to_generate,kept_existing}`; worker: `ai_claim_pending(p_limit)` → rows, `lead_ai_facts(p_lead)`, `ai_value_result(p_id,p_text,p_facts,p_model,p_error)`; review: `ai_review_list(p_ws,p_batch,p_status,p_limit,p_offset)`, `ai_review(p_value_ids, 'approve'|'skip'|'edit'|'regenerate', p_text)`. Tables `outreach_ai_batches`, `outreach_ai_values` are in the realtime publication.
- BYO key: table `outreach_workspace_secrets` (service only). `workspace_ai_settings(p_ws)` returns provider / model / hints. The `outreach-workspace-secrets` edge function encrypts (`_shared/outreach/crypto.ts`) and stores keys.
- AI routing node `ai_route`: `config.routes: [{id,label,description}]`, `branches: {<id>: nodeId, else: nodeId}`. Worker: `ai_route_pending(p_limit)` → `ai_route_decide(p_enrollment,p_node_id,p_branch,p_reason,p_facts,p_model)`. "Test on 20 leads" is an edge-function call that returns the split without storing anything.

### Item 17 — blacklists
`outreach_suppressions` gained `client_id`, `sequence_id`, `source`, kind `company`. Add with `add_suppressions(p_ws, p_rows[{kind?,value,reason?}], p_client, p_sequence, p_source)` → `{added, skipped}` (kind is inferred when omitted). Delete rows directly (RLS). Send-time check: `enrollment_suppression_reason(p_enrollment)` → settle with decision `suppressed`.

### Item 18 — sources
Import kinds: `search_url, csv, relations, post_engagement, conversations, sn_saved_search, sn_lead_list, company_people`. `import_jobs.mode` (`upsert|update_only`), `update_fields[]`, `enrich`, `schedule_id`. Repeating: `save_import_schedule(p jsonb)`, table `outreach_import_schedules` (RLS update/delete). `import_conversations(p_job)` and `update_lead_fields(p_ws,p_match,p_fields,p_allowed)` are service helpers for the imports worker. Auto-enrol: `save_auto_enroll_rule(p_rule{id?,sequence_id,name,list_id?,filter{tag_ids,stage_id,client_id,title_contains,company_contains,location_contains,source,min_followers,posted_within_days},daily_cap,active})`, `delete_auto_enroll_rule`, `rule_match_count(p_rule)`, tables `outreach_auto_enroll_rules`, `outreach_auto_enroll_log`.

### Item 19 — assignment
`sequences.assignment` adds `fresh_sender`, `same_sender`.

### Item 20 — email
`pick_mailbox(p_enrollment, p_node)` (service; planner), step config `mailbox_pool: [senderId]`; `senders.parent_sender_id, signature, bcc_address, track_replies`; workspace `settings.track_replies` (default false); `tracking_domain_for(p_sender)`; `add_tracking_domain / remove_tracking_domain`, table `outreach_tracking_domains` (status `pending_dns → awaiting_approval → active`); `unsubscribe_lead(p_lead,p_source)` (service). Links carrying `data-disable-tracking` are not rewritten: add it to the unsubscribe and booking links.

### Item 21 — API
`create_api_key(p_ws,p_name,p_role,p_client_ids,p_expires_at)` → `{id,key,prefix}` (shown once), `revoke_api_key`, table `outreach_api_keys` (select without the hash). Edge: `api_authenticate(key)`, `api_dispatch(key_id, fn, args)`, `api_idempotent(...)`. Read RPCs `api_context, api_leads, api_lead, api_sequences, api_sequence, api_enrollments, api_threads, api_thread, api_senders, api_sender, api_webhooks, api_deliveries`; `create_webhook, delete_webhook, replay_delivery`.

### Item 22 — CRM
Tables `outreach_integrations` (+ `_secrets` service only), `outreach_integration_events` (the stream; filled by `emit_event` for workspaces with an active integration), `outreach_crm_links`, `outreach_crm_sync_log`. `integration_save(p_id,p_settings,p_field_mapping,p_stage_mapping)`, `integration_disconnect(p_id)`, `crm_should_sync(p_integration,p_lead)`. `settings.sync_rule`: `replied` (default) | `interested` | `enrolled`.

### Items 23–26
- Branding: `set_branding(p_ws, {product_name,logo_url,accent,support_email,help_url,docs_url,email_from_name,email_from_address,hide_platform_name})`, `branding(p_ws)`, `branding_for_host(hostname)` (anon), `branding_for_invite(token)` (anon). Domains: `add_domain(p_ws,p_hostname,p_client)` → DNS records, `domains(p_ws)`, `remove_domain(p_id)`; the `outreach-domain-check` worker verifies the TXT + CNAME and sets `status`.
- Booking: `senders.booking_link`; webhook edge function → `record_booking(p_ws,p_provider,p_external_id,p_lead,p_email,p_status,p_starts_at,p_payload,p_sender)`. Event `meeting.booked`.
- Call task node `call_task` (`config{title,script}`, branches `connected|voicemail|no_answer|wrong_number`, fallback `next`): task kind `call`, complete with `{outcome}`.
- `follow_profile` node → action `follow`. `send_voice_note` node → action `message` with `payload.voice = true`; clip per (sequence,node,sender) in `outreach_voice_clips`, stored at `outreach-attachments/<ws>/voice/<sequence>/<node>/<sender>.<ext>`, `save_voice_clip(...)`. No clip → skip with code `no_voice_clip`.
- `find_email` node (branches `found|not_found`) → action `find_email`; `set_lead_email(p_lead,p_email,p_status,p_source)`.
- `refresh_profile` node → action `profile_view` with full sections, `config.only_if_stale_days` (default 90; never-enriched leads are always refreshed).

## Cross-workstream TypeScript contracts (Deno, `_shared/outreach`)
- `render.ts`: `renderTemplate(template, ctx)` where `ctx = { lead, sender, enrich?, ai?, seed?, unsubscribe_link?, booking_link? }`; also `templateVariables`, `missingVariables`, `spintaxInfo(text) → {maxLen, combinations}`, `buildContext(renderCtxJson, extras)`.
- `ai.ts`: `classifyMessage(...) → { intent, confidence, summary, return_date: string | null }` (ISO date when an out-of-office names one). `llm.ts`: `llmCall({ workspaceId, purpose, system, user, maxTokens, temperature, json, thinking? }) → string`, resolving the workspace's own key/provider (gemini | anthropic | openai) and falling back to the platform Gemini key. When building Anthropic calls use model `claude-sonnet-5` by default.
- `notify.ts`: `notifyWorkspace(workspaceId, kind, data, opts?: { senderId?: string; clientId?: string })` sends to owners + managers (+ `senders.alert_emails`), branded with `workspaces.branding`.
- `crypto.ts`: `encrypt`, `decrypt`, `hmacSha256Hex` exist. ENGINE-SEND adds `unsubscribeToken(leadId)` / `verifyUnsubscribeToken(leadId, token)` (HMAC with `OUTREACH_CRON_SECRET`, prefix `unsub:`).
- `finder.ts`: `findEmail(workspaceId, lead) → { email, status: 'verified'|'unverified', source } | null`.

## Verify before you finish
- Deno: `deno check --node-modules-dir=none supabase/functions/<fn>/index.ts` for every function you touched (run from the repo root; `deno` is on PATH).
- Web: `npx tsc --noEmit -p .` must not report errors in files you touched (the repo has unrelated pre-existing errors elsewhere; ignore those but list them if they block you).
- SQL you need ad hoc: `bash scripts/outreach-sql.sh <file.sql>` (token is in the environment). Do not apply schema changes.
- Do not deploy, do not commit, do not run `npm install` of new dependencies without saying so in your final report (recharts, @xyflow/react, @tanstack/react-query, lucide-react, papaparse are already installed).
