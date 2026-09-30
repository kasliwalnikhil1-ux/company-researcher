# AI Replies v2 — build contract

Source: `ai-replies-changes.md` (everything decided after v1.1), applied on top of `AI-REPLIES-CONTRACT.md` (v1.1 as built:
migrations 034–038, functions `outreach-ai-reply` / `outreach-ai-reply-worker`). This file fixes every v2 name, signature
and payload. When code and this file disagree, fix one of them in the same change. Naming follows the platform:
tables / RPCs `outreach_*`, edge functions `outreach-*`, client calls `rpc('<name without outreach_>')` /
`callFn('<name without outreach->', body)`.

Migrations: `039_ai_replies_v2_enums.sql` (own call) → `040_ai_replies_v2_schema.sql` (tables, columns, backfill) →
`041_ai_replies_v2_engine.sql` (resolver, handoff, sessions, pause, warm-up, knowledge retrieval) →
`042_ai_replies_v2_rpcs.sql` (app / MCP RPCs + grants) → deploy functions → `043_ai_replies_v2_cron.sql`.
Tests: `tests/smoke_10_ai_replies_v2.sql` (48 assertions; replaces smoke_09, retired to `tests/retired/`), `_shared/outreach/ai_reply_engine_test.ts` (parity; run with stub env `SUPABASE_URL=http://localhost SUPABASE_SERVICE_ROLE_KEY=x SUPABASE_ANON_KEY=x deno test -A --node-modules-dir=none …`), `ai_reply_rules_test.ts` (extended). Local replay + real-model e2e recipe: memory `ai-replies` (`%TEMP%istack
eplay2.sh`, `replay_v11.sh`, `e2e2.ts`).

## 0. Deliberate deviations from `ai-replies-changes.md`

| Changes doc | Here | Why |
|---|---|---|
| `sequence_reply_settings`, `workspace_reply_settings`, `ops.scheduling_domains`, `lead_ai_notes`, … | `outreach_sequence_reply_settings`, `outreach_workspace_reply_settings`, `outreach_scheduling_domains`, `outreach_lead_ai_notes`, `outreach_master_prompt_scenarios`, `outreach_master_prompt_faqs`, `outreach_ai_unanswered_questions` | platform prefix |
| mode `auto` | enum value stays `autopilot` (v1.1 `outreach_reply_mode_t`); UI label **Auto** | no enum rewrite |
| `master_prompts.sequence_id` replaces `scope_id` | both: `sequence_id` (FK, cascade) is the source of truth for `scope = 'sequence'`; `scope_id` is kept equal to it so the v1.1 client-scope helpers and RLS keep working. `scope` ∈ `sequence \| library` | RLS / helpers |
| T1 = "a person sends any message" | T1 fires for a person's **own** text: origin `inbox_user` (a rewrite: edit distance > 0.5, or no AI draft) and `external_device`. Sending the AI draft (`ai_draft_sent` / `ai_edited`) is the AI's reply with a person's approval and does **not** hand off — otherwise Draft mode would stop after its first reply | Draft mode must keep drafting |
| `pgmq.create('lead_notes')` | table queue `outreach_ai_lead_notes_queue` claimed with `for update skip locked` (no pgmq on this project) | platform pattern |
| Knowledge "reuses the web-chat pipeline" | the web-chat pipeline does not exist. Own minimal pipeline: `outreach_knowledge_sources` (website crawl ≤ 60 same-host pages, text / markdown / html documents, pasted text) → `outreach_knowledge_chunks` (~1,200 chars, `tsvector`), retrieval = full-text rank + trigram fallback, top 5. **PDF / DOCX** upload is accepted but extraction is not built: the source ends `error: 'unsupported_type'` | scope |
| Unanswered grouping by embedding ≥ 0.85 | no embedding API on every supported LLM provider and no `vector` extension here. Grouping = `pg_trgm` similarity ≥ 0.6 on a normalised canonical question (the worker asks the model for the canonical form); nightly job merges near-duplicate groups | provider-neutral |
| `master_prompt_versions.scenarios / faqs` snapshots | kept, as jsonb snapshots written on every version | — |
| Re-engage as a real stage key | dormant session = `chats.ai_session_kind = 'dormant'` with `conversation_stage = null`; the drafter's STATE block says "Re-engage"; the UI shows **Re-engage** for that state. Stage keys in `settings.stages` are unchanged | validator / stage table unchanged |
| SSE streaming for Draft with AI | plain JSON; 25 s function timeout | no streaming helper on the platform |
| push notifications | in-app (task + realtime) + email | no push channel |
| `reply_policies` → `reply_policies_legacy` | renamed to `outreach_reply_policies_legacy`, revoked from `authenticated`; v1.1 policy RPCs and `ai_reply_set_chat_mode` are dropped | doc §12.1 |
| Regression "scenarios" (v1.1 `outreach_ai_reply_scenarios`) vs v2 situation "Scenarios" | the v1.1 regression rows are renamed in the UI / MCP to **test conversations** (`test_conversation_*`); **Scenarios** are the situation cards (`outreach_master_prompt_scenarios`) | one word, one meaning |
| "Duplicating a sequence does the same" | the app has no duplicate-sequence flow. A sequence created by any path gets its settings + prompt lazily (`outreach_ai_seq_settings_ensure`: workspace default prompt, else the template, mode Draft); **Copy from sequence** in the AI tab copies another sequence's prompt, cards, Q&A and knowledge links | no duplicate flow to hook |
| Guided / Raw toggle removed | new prompts are guided; an existing raw prompt stays editable as one textarea (`editor_mode` kept). Cards on a raw prompt are appended by the engine as `## Situations` only when the raw body has none | existing raw prompts keep working |
| graduation | `outreach__ai_graduated()` is no longer a gate; the daily refresh keeps writing `graduation` for reporting; the Graduation tab and the admin bypass switch go | doc §4.3 |

## 1. Enums (039)

`outreach_task_kind_t + 'ai_handoff'`. Nothing else.

## 2. Schema (040)

```
outreach_sequence_reply_settings
  sequence_id PK → outreach_sequences (cascade), workspace_id, mode outreach_reply_mode_t default 'draft',
  master_prompt_id → outreach_master_prompts (the sequence's own prompt), pitch_after_replies 0–5 (2),
  max_ai_replies_per_chat 1–10 (6), warmup_remaining ≥0 (20), handoff_stage_id → outreach_stages (set null),
  delay_min_s ≥60 (240), delay_max_s ≤3600 > min (1200), debounce_quiet_s 30–600 (120), debounce_max_s 60–1800 (600),
  stale_after_h (12), languages text[] ('{en}'), disclosure, blocked_countries text[] ('{}' = none; null = EU/EEA default),
  returning_after_days 1–30 (3), dormant_after_days 7–365 (30) > returning, inactivity_days null|1–60 (7),
  downgraded_at, downgrade_reason, breaker_reset_at, updated_by, updated_at
outreach_workspace_reply_settings
  workspace_id PK, max_ai_sends_per_sender_day 1–40 (25), default_prompt_id → outreach_master_prompts (library)
outreach_sequences + resumed_at
outreach_master_prompts: scope ∈ sequence|library; + sequence_id (FK cascade, = scope_id), name, copied_from_prompt_id,
  copied_from_version, knowledge_source_ids uuid[]; unique (sequence_id) where scope='sequence'
outreach_master_prompt_versions + scenarios jsonb, faqs jsonb
outreach_ai_reply_consent: master_prompt_id / _version nullable; unique (sender_id) where revoked_at is null
outreach_ai_reply_consent_links: master_prompt_id / _version nullable
outreach_chats + reply_sequence_id (→ sequences, set null), ai_handed_off_at, ai_handoff_reason
  (human_replied|meeting_confirmed|calendar_sent|stop_rule|max_replies|stage|booking|manual), ai_handoff_rule,
  ai_handoff_run_id, ai_session_started_at, ai_session_kind (normal|returning|dormant), ai_session_count (1),
  ai_quiet_task_at; − reply_mode_override
outreach_ai_reply_runs + trigger_kind (auto|manual; JSON key `trigger`), requested_by, requested_via (inbox|mcp), guidance ≤300,
  variants jsonb, stop_after_send bool, stop_rule, scenario_id (→ master_prompt_scenarios, set null), gap_days numeric(6,1),
  session_kind, warnings jsonb (manual runs: the checks as warnings)
outreach_tasks + source (user|ai|system)
outreach_scheduling_domains(host PK, path_prefix) — seeded with the 10 hosts of the changes doc
outreach_master_prompt_scenarios(id, master_prompt_id, position, title ≤80, when_text ≤500, do_text ≤1500, enabled, updated_by, updated_at)
outreach_master_prompt_faqs(id, master_prompt_id, question ≤500, answer ≤2000, source manual|unanswered|import, enabled, created_by, created_at)
outreach_ai_unanswered_questions(id, workspace_id, sequence_id, master_prompt_id, canonical, norm, examples jsonb[≤10 of
  {run_id, chat_id, message_id, text, at}], count_total, first_seen_at, last_seen_at, status open|answered|dismissed,
  answered_faq_id, dismissed_reason)
outreach_lead_ai_notes(lead_id PK, workspace_id, summary ≤400, items jsonb [{id, key, text, source_message_id, updated_at,
  edited_by, locked, history:[{text, at}]}], updated_at)
outreach_ai_lead_notes_queue(id, workspace_id, lead_id, chat_id, run_id, message_ids uuid[], attempts, next_attempt_at, created_at)
outreach_knowledge_sources(id, workspace_id, kind website|document|text, title, url, storage_path, content_type, text_inline,
  status pending|crawling|ready|error, error, pages, chunks, crawled_at, refresh_days, created_by, created_at, updated_at)
outreach_knowledge_chunks(id, source_id, workspace_id, seq, url, heading, text, tsv tsvector)
outreach_messages + translation jsonb {lang, text, at}
outreach_reply_policies → outreach_reply_policies_legacy (read-only)
```

Backfill `outreach_migrate_ai_replies_v2()` (runs once, idempotent): per workspace the cap from the v1.1 workspace policy,
the ex-workspace prompt → library `Workspace default` + `default_prompt_id`, client prompts → library `Client · <name>`;
per sequence (not deleted): settings from the old resolution (sequence → client → workspace policy), the sequence's own prompt
or an independent copy of the client / workspace one (`copied_from_*`), `pitch_after_replies` = `min_exchanges_before_pitch`,
`max_ai_replies_per_chat`, `handoff_stage_id`, `languages` from the prompt's `settings`; `warmup_remaining = 0` when already on
autopilot else 20; sequences with no prompt anywhere get one from the template; sender-scope policies that differed → one
alert `ai_reply_settings_moved` per sequence. Prompts without `## Stop when` get the default section (style version) and the
"Coming back after a gap" block; free-text Situations are kept (the editor offers **Convert to cards**). Chats with
`autopilot_state = 'paused_human'` → handed off (`human_replied`). Chats with a run in the last 30 days get
`reply_sequence_id` (latest run's sequence, else the §1.3 resolution), `ai_session_started_at`, `ai_session_kind = 'normal'`.
Consent: one live row per sender (latest kept, others `merged_to_sender_consent`).

## 3. Resolution (041)

`outreach__ai_effective(p_chat)` (unchanged name, new logic) →
```
{chat_id, mode, requested_mode, reason_code, reason, can_autopilot, sequence_id, sequence_name, sequence_status,
 handed_off: {at, reason, rule, run_id} | null, session: {kind, started_at, count}, autopilot_state, paused_reason,
 consent_valid, warmup_remaining, policy: {delay_min_s, delay_max_s, debounce_quiet_s, debounce_max_s, stale_after_h,
 max_ai_sends_per_sender_day, disclosure, blocked_countries}, master_prompt: {id, version, editor_mode, name} | null,
 settings: <prompt settings merged with the sequence numbers> | null, fallback: null | 'workspace_default' | 'template'}
```
Order: provider ≠ LINKEDIN → `off / channel_not_supported`; `chats.ai_handed_off_at` → `off / handed_off`;
`reply_sequence_id` null → `off / no_sequence` (Draft with AI still works: `fallback`); settings row missing → created lazily
by `outreach_ai_seq_settings_ensure(sequence)` (draft, workspace default prompt copy or template); mode = settings.mode;
sequence not active → `min(mode, draft)` with `sequence_paused | sequence_archived | sequence_draft`; autopilot without a live
sender consent → `draft / consent_missing`; `paused_escalated` / `paused_bot` chat states → `draft` (unchanged from v1.1).
Graduation is not consulted.

`outreach__ai_resolve_sequence(p_chat, p_message)` → `{sequence_id, switched}`: 1) the enrolment of the action the message
answers (`replied_to_action_id` → `outreach_actions.enrollment_id`), 2) else the lead's latest enrolment on the chat's sender,
3) else null. A resolved sequence different from `chats.reply_sequence_id` that the message **answers** switches the chat:
stage / exchanges / ai_replies_count reset, handoff cleared, session `normal`, audit `ai_reply.sequence_switched`.

## 4. Handoff, sessions, pause, warm-up (041)

- `outreach_ai_handoff(p_chat, p_reason, p_run, p_rule)` — §2.3 of the changes doc: chat columns, active runs → `cancelled`
  (`handed_off`), task `ai_handoff` (source `system`, due today, assignee = chat assignee else sequence owner) + email, tag
  `ai-handed-off`, lead moved to `handoff_stage_id` (forward only). No task / email for `human_replied`. Idempotent (a handed-off
  chat stays as it was; the reason is not overwritten).
- `outreach_ai_resume_chat(p_chat)` (manager, audited) clears the handoff and any escalation / bot pause.
- `outreach_ai_reply_on_human_send` / `_on_outbound_external`: T1 → `outreach_ai_handoff(chat, 'human_replied', run)` for the
  person's own text (deviation table). `human_takeover_pause_h` / `paused_human` are gone.
- `outreach_ai_reply_enqueue`: handed off → `{action:'skipped', why:'handed_off'}` and, when the gap ≥ `returning_after_days`,
  the handoff task is reopened and its assignee emailed (`ai_reply.returned`); resolve sequence; session start (`gap_days`,
  `session_kind` on the run and chat, counters reset for returning / dormant); complete open `follow_up` / `ai_handoff` tasks
  with `source in ('ai','system')` for the lead + chat (`result.completed_reason = 'they_replied'`), reset `ai_quiet_task_at`.
- `outreach_ai_reply_finalize` (`scheduled` / `draft_ready`): T3 — a scheduling-domain link in the draft forces
  `stop_after_send = true`, `stop_rule = 'calendar link'`; T5 / T6 are decided by the worker before drafting (gate) and end in
  `outreach_ai_handoff(chat, 'max_replies' | 'stage')` with no reply; T2 (`meeting_confirmed` flag) makes the reply final:
  `stop_after_send = true`, `stop_rule = 'meeting confirmed'`. Warm-up: while `warmup_remaining > 0` the worker schedules
  30–40 min out (inside working hours) and emails the assignee `ai_reply.warmup_hold`.
- `outreach_ai_reply_mark_sent`: `stop_after_send` → `outreach_ai_handoff(chat, calendar_sent | meeting_confirmed | stop_rule, run,
  stop_rule)`; autopilot send → `warmup_remaining = greatest(0, warmup_remaining − 1)`.
- `outreach_ai_reply_prepare_send` rechecks: not handed off, sequence active, consent live, then the v1.1 checks.
- `outreach_ai_reply_demote_scheduled(p_sequence, p_reason)`: scheduled → `draft_ready` (`gate_failures += reason`).
  `outreach_set_sequence_status` calls it on `paused` / `archived`; `active` sets `resumed_at` and returns
  `drafts_waiting` (draft_ready runs of the sequence's chats opened while paused). The worker leaves runs whose newest inbound
  predates `resumed_at` in `draft_ready` (`gate_failures += 'before_resume'`).
- `outreach_ai_reply_breakers`: per sequence (unchanged rules); a downgrade sets `outreach_sequence_reply_settings.mode = 'draft'`,
  `downgraded_at`, `downgrade_reason`. Re-enabling autopilot after a downgrade needs a note (`sequence_ai_replies_set`).
- `outreach_ai_reply_inactivity()` (daily): chats with AI active (sequence on, not handed off, not archived), our message last,
  no prospect message for `inactivity_days` → task `follow_up` source `system` "<Lead> went quiet after <stage> · N days",
  once per silence (`ai_quiet_task_at`).

## 5. RPCs (042) — app, MCP, API

All security definer, `outreach_require()` + `outreach_client_visible()`; errors `E_CODE: text`. `RunSummary` as v1.1 plus
`trigger, requested_by, guidance, stop_after_send, stop_rule, scenario_id, scenario_title, gap_days, session_kind, warnings`.

| RPC (client name) | Role | Args → returns |
|---|---|---|
| `sequence_ai_replies_get` | member | `p_sequence` → `{sequence_id, mode, effective_mode, master_prompt_id, prompt: MasterPrompt, pitch_after_replies, max_ai_replies_per_chat, warmup_remaining, handoff_stage_id, delay_min_s, delay_max_s, debounce_quiet_s, debounce_max_s, stale_after_h, languages, disclosure, blocked_countries, returning_after_days, dormant_after_days, inactivity_days, downgraded_at, downgrade_reason, senders:[{sender_id, sender_name, owner_email, owner_is_me, consent: 'granted'\|'pending'\|'missing', consent_id, pending_link_id}], open_conversations, open_by_stage:[{stage, label, n}], handed_off_7d, handed_off_open, drafts_waiting, unanswered_open, workspace_cap}` (the Stop section flag is `prompt.stop_present`) |
| `sequence_ai_replies_set` | manager | `p_sequence, p_patch jsonb {mode, pitch_after_replies, max_ai_replies_per_chat, handoff_stage_id, delay_min_s, delay_max_s, debounce_quiet_s, debounce_max_s, stale_after_h, languages, disclosure, blocked_countries, returning_after_days, dormant_after_days, inactivity_days}, p_note default null` → get shape + `applies_to` (open conversations). Off/draft demotes scheduled runs. **The app calls edge action `ai_replies_set`** (consent requests for the pool's senders) |
| `workspace_reply_settings_get` / `_set` | member / manager | `p_ws` → `{max_ai_sends_per_sender_day, default_prompt_id, default_prompt_name}`; `_set(p_ws, p_patch)` |
| `master_prompt_get` | member | `p_sequence` → `MasterPrompt` (v1.1 shape + `name, sequence_id, scenarios:[…], faqs:[…], knowledge:[{id, kind, title, url, status, chunks}], stop_present, situations_text_convertible`) |
| `master_prompt_update` | manager | `p_sequence, p_editor_mode, p_body, p_sections, p_settings, p_change_kind, p_note, p_base_version` → get shape + `change_kind, warmup_remaining, warnings:[text]`. Substantive → `warmup_remaining = greatest(warmup_remaining, 10)`, scheduled runs on the old version redrafted (`superseded`, `prompt_changed`). **The app calls edge action `master_prompt_save`** (same args + `sequence_id`) |
| `master_prompt_copy` | manager | `p_sequence, p_from_sequence default null, p_from_library default null` → get shape (prompt, scenarios, knowledge links, Q&A copied; `copied_from_*` set; substantive) |
| `master_prompt_versions` | member | `p_mp` → v1.1 rows + `scenarios, faqs` |
| `master_prompt_library_list` / `_get` / `_save` / `_delete` | member / manager | `p_ws` → `[{id, name, version, updated_at, is_default}]`; `_get(p_id)`; `_save(p_ws, p_id null=new, p_name, p_editor_mode, p_body, p_sections, p_settings, p_note)`; `_delete(p_id)` |
| `scenarios_list` / `scenario_save` / `scenario_toggle` / `scenario_delete` / `scenarios_reorder` | member / manager | `p_sequence` → rows; `_save(p_sequence, p_id null=new, p_title, p_when, p_do, p_enabled)`; `_toggle(p_id, p_enabled)`; `_delete(p_id)`; `_reorder(p_sequence, p_ids uuid[])`. Each write = a substantive prompt version |
| `scenarios_from_text` | member | `p_text` → `[{title, when_text, do_text}]` (pure parse of `- When → Do` bullets, nothing saved) |
| `faqs_list` / `faq_save` / `faq_delete` | member / manager | `p_sequence` → rows; `_save(p_sequence, p_id, p_question, p_answer, p_enabled)`; `_delete(p_id)` |
| `knowledge_sources_list` / `knowledge_source_add` / `knowledge_source_delete` / `knowledge_attach` / `knowledge_detach` | member / manager | `p_ws` → sources; `_add(p_ws, p_kind, p_title, p_url, p_storage_path, p_text)` → row (pending); `_delete(p_id)`; `_attach(p_sequence, p_source)`; `_detach(p_sequence, p_source)` |
| `unanswered_list` / `unanswered_answer` / `unanswered_dismiss` | member / manager | `p_sequence, p_status default 'open'` → `[{id, canonical, count_total, count_30d, first_seen_at, last_seen_at, status, examples, answered_faq_id}]`; `_answer(p_group, p_answer)` → faq row; `_dismiss(p_group, p_reason)` |
| `lead_notes_get` / `lead_notes_update` | client_viewer / member+can_reply | `p_lead` → `{lead_id, summary, items, updated_at}`; `_update(p_lead, p_items)` (person edits lock the item) |
| `chat_ai_stop` / `chat_ai_resume` | member / manager | `p_chat` → chat_state. Stop = `outreach_ai_handoff(chat, 'manual')`; Resume = `outreach_ai_resume_chat` |
| `ai_reply_chat_state` | client_viewer | `p_chat` → `outreach__ai_effective` (minus policy / settings / consent_valid) + `stage, exchanges, ai_replies_count, max_ai_replies, stages, run, last_run, lead_notes_summary` |
| `ai_reply_manual_open` | service | `p_chat, p_user, p_via, p_guidance, p_variants default 1, p_regenerate default false` → `{run_id, source: existing_auto\|existing_manual\|new, status, prompt:{sequence, version, fallback}, taken_over?}` (§5.4 of the changes doc: `draft_ready` → existing; `scheduled` → existing, `taken_manual` on regenerate; `debouncing`/`drafting` → cancelled `taken_manual`, new manual run) |
| `ai_reply_take_manual` | service | `p_run, p_user` → cancels a scheduled / pending auto run (`taken_manual`) before a regenerate / edit |
| `ai_reply_record_send` | service | used by send-reply: v1.1 `ai_reply_on_human_send` (name kept) |
| `sequence_ai_summary` | member | `p_sequence` → `{mode, effective_mode, warmup_remaining, downgraded_at, open_conversations, open_by_stage:[{stage, label, n}], handed_off_7d, handed_off_open, drafts_waiting, unanswered_open}` (embedded by `sequence_get` / `sequences_list` in MCP / API) |
| dropped | | `reply_policy_list/set/clear`, `ai_reply_set_chat_mode`, `ai_reply_resume_chat(p_chat, p_note)` (→ `chat_ai_resume`), `master_prompt_get(p_ws, scope…)`, `master_prompt_save(p_ws, scope…)`, `master_prompt_list`, `master_prompt_delete`, `ai_reply_graduation` (kept read-only for reports), `ai_consent_grant_operator(p_sender, p_mp)` → `ai_consent_grant_operator(p_sender)` |

## 6. Edge functions

`outreach-ai-reply` actions (user JWT unless noted):

| action | who | body → result |
|---|---|---|
| `draft_now` | member + `can_reply` | `{chat_id, guidance? ≤300, variants? 1–3, regenerate? bool}` → `{run_id, source: existing_auto\|existing_manual\|new, status, prompt:{sequence, version, fallback}, drafts:[{run_id, text, decision, stage_before, stage_after, move, rule_applied, scenario_id, scenario_title, facts_used, side_effects, warnings:[{code, text}], would_stop, stop_rule, escalation_reasons, version, status, scheduled_send_at, trigger, guidance, variant?}]}`. Without `regenerate` an existing `draft_ready` / `scheduled` run is returned as is (§5.4); with it the pending auto run is cancelled `taken_manual` and a new manual run drafted. 60 / hour / user. Never sends. The composer sends the chosen text through `send-reply` with `ai_run_id` |
| `take_manual` | member | `{run_id}` → `{ok, status, changed}` — a scheduled auto run becomes `draft_ready` before the person edits it (no double send) |
| `compose_assist` | member + `can_reply` | `{chat_id, kind: improve\|translate_out\|translate_in, text?, message_id?, language?}` → `{text, language, warnings:[{code, text}], cached?}`; `translate_in` caches on `messages.translation` |
| `ai_replies_set` | manager | `{sequence_id, patch, note?}` → `{settings, consent:{granted:[sender_id], requested:[{sender_id, sender_name, emailed, link?}]}}` |
| `master_prompt_save` | manager | `{sequence_id, editor_mode, body, sections, settings, change_kind, note, base_version}` → `{prompt, warnings}` (no re-consent) |
| `simulate` | manager | v1.1 body + `sequence_id?`, `draft_prompt?.scenarios?`, `draft_prompt?.faqs?` → v1.1 result + `scenario_id, scenario_title, would_stop, stop_rule, knowledge_used:[{title, url, heading, text}], faqs_used:[question], lead_notes_used, unanswered_question, session` (state accepts `session_kind`, `gap_days`) |
| `send_now`, `regression_run`, `consent_request {workspace_id, sender_id}`, public consent actions | as v1.1 (`master_prompt_id` no longer needed) |

`outreach-ai-reply-worker` modes: `draft`, `dispatch`, `maintenance`, `breakers`, `daily` (+ inactivity + unanswered merge),
`lead_notes` (every 30 s), `knowledge` (every minute: crawl / parse pending sources, refresh due ones).

`outreach-send-reply` unchanged (`ai_run_id`); the composer passes it for auto and manual drafts alike.

## 7. Engine (`_shared/outreach/ai_reply_engine.ts`)

`runEngine(run, facts, {trigger:'auto'|'manual', guidance?, variants?})` = buildContext → draft → validate → verify → decide.
The worker (`processRun`) and `draft_now` call the same function. **Parity rule:** for the same chat, inbound ids, prompt
version, scenarios, knowledge and lead notes, the two prompts are byte-identical except the `Trigger:` line of the STATE block
and the optional `GUIDANCE` block (`ai_reply_engine_test.ts`). Manual runs skip the gates, working hours, caps, stop / warm-up /
reply-count logic; floor / validator / verifier outcomes become `warnings` (an AI denial is never returned: the draft is
dropped and a retry asks for one without it). Model contract adds `stop_after_send`, `stop_rule`, `scenario_id`.

STATE block additions: `Trigger`, `Session (normal | returning after N days | dormant after N days → Re-engage)`,
`Previous stage`, `Lead notes` (summary + items), `Scenarios` (id · title, enabled only, compiled under `## Situations`),
`Stop when` rules. Knowledge retrieval runs when the classifier found a question or `asked_offer` / `pricing`: top 5 chunks +
matching Q&A (all Q&A when ≤ 30). Everything retrieved is allowed text for the validator / verifier.

## 7b. Client hooks

`lib/outreach/aiReplies.ts` keeps the inbox hooks (chat state, cancel, send now, draft now, take manual, compose assist, stop / resume, lead notes)
and the shared types; `lib/outreach/aiRepliesSequence.ts` holds the sequence-card hooks (settings get / set via the edge action,
prompt get / update / copy / versions, scenarios, Q&A, knowledge, unanswered, simulate, test conversations) and the settings-page
hooks (workspace defaults, library prompts, consent list). Query keys stay under `['outreach', ws, 'ai-…']` / `['outreach', 'chat', chatId, 'ai-state']`.

## 8. UI surfaces

| Surface | Files |
|---|---|
| Sequence builder → **AI replies** tab (the whole settings UI: mode, prompt, scenarios, knowledge, Q&A, numbers, stage strip, Test a conversation, Advanced, Copy from sequence, Unanswered questions, consent / warm-up notices) | `components/outreach/sequences/ai/*`, tab in `TabPanels.tsx` / `Builder.tsx`; `SequenceSettingsPanel.tsx` loses its AI links |
| Settings → AI replies: **Defaults** (per-sender cap, library prompts), **Consent**, **Activity**, **Reports** (graduation stats read-only). Prompt / Policies / Graduation tabs removed | `app/outreach/settings/ai-replies/page.tsx`, `components/outreach/settings/ai-replies/*` |
| Inbox: Draft with AI (⌘/Ctrl+J), Regenerate / Shorter / More formal / Instruction…, Improve my text, Translate ▾, composer meta (stage, scenario, version, warnings, "Ends the AI conversation when sent"), chat menu Stop AI / Resume AI, header "AI handed off · reason · date", filter **Handed off by AI**, Lead notes side panel, "Translate" under a received message, realtime "AI draft ready — View" | `components/outreach/inbox/ai/*`, `Compose.tsx`, `Thread.tsx`, `ChatList.tsx`, `InboxView.tsx`, `lib/outreach/queries.ts` (filter), `lib/outreach/aiReplies.ts` |
| Admin (localhost): monthly limit only (bypass switch removed) | `components/outreach/settings/admin/AiReplyAdmin.tsx` |
| MCP | `tools_ai_replies.ts` (§8 / §9.7 of the changes doc), `tools_inbox.ts` (`ai` block, `lead_notes_summary`), `tools_sequences.ts` (`ai_replies` block, `sequence_create.ai_replies`) |
| Skill | `claude-skill/outreach/ai-replies.md` |

Customer copy never names the connector vendor. Mode labels: Off · Draft · Auto.

## 9. Operations

Apply order: 039 (own call) → 040 → 041 → 042 → deploy every function bundling `_shared/outreach` (`scripts/outreach-deploy-functions.sh`)
→ 043. Kill switch unchanged. New cron jobs: `outreach-ai-reply-lead-notes` (30 s), `outreach-ai-reply-knowledge` (1 min);
`outreach-ai-reply-daily` now also runs inactivity + unanswered merge. Model calls logged with purposes `reply_draft`,
`reply_verify`, `reply_simulate`, `reply_simulate_verify`, `lead_notes`, `compose_assist`, `unanswered_canonical`; only
`reply_draft` and `compose_assist` count against the allowance (`draft_now` = 1 action per click).
