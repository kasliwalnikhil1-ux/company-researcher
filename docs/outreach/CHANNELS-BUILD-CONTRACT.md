# Build contract — Instagram & WhatsApp channels

Source: `instagram-whatsapp-channels-PRD.md` (25 Sep 2026). This contract is the shared interface between the SQL layer
(`migrations/outreach/024–026`), the engine (`supabase/functions/_shared/outreach/*`, workers), the web app and the MCP
connector. Every name here is final. The SQL is the source of truth for return shapes; TypeScript never re-implements a rule.

Rules carried over from `PLAN-BUILD-CONTRACT.md`: one RPC, three surfaces · safety in the database · nothing AI-written sends
unapproved · nothing deletes history · `outreach_` / `outreach-` / `/outreach` naming · `E_CODE: message` errors · plain UI copy
(never "node", "enrollment", "payload", "graph"; never name the connector vendor in customer-facing copy: say "the connected
account" / "the connector").

## 1. Enum values (024_channel_enums.sql — its own file, its own transaction)

```
outreach_provider_t      += 'INSTAGRAM', 'WHATSAPP'
outreach_action_type_t   += 'unfollow', 'new_chat', 'identifier_check', 'followers_poll', 'story_react'   ('follow' exists since 009)
outreach_consent_basis_t  = ('inbound','form_optin','existing_customer','linkedin_reply','explicit_share','imported_attested')
outreach_suppressions.kind check += 'phone', 'handle'
```

`message` keeps meaning "a message into a chat that already exists". `new_chat` = creating a conversation that did not exist,
on EVERY channel (LinkedIn included). The planner decides which one a `send_message` / `send_voice_note` step spends.

## 2. Tables (025_channels_schema.sql)

### outreach_channel_capabilities (seeded, service-role writable, `select` for authenticated)
| column | type | note |
|---|---|---|
| provider | outreach_provider_t PK | LINKEDIN, INSTAGRAM, WHATSAPP, GMAIL, OUTLOOK, IMAP |
| identifier_kind | text | slug \| handle \| phone_e164 \| email |
| has_connection_graph | bool | LI true, IG false, WA false |
| connection_is_permission | bool | LI true |
| acceptance_webhook | bool | LI only |
| can_validate_identifier | bool | WA only |
| supports | jsonb | `{invite, inmail, follow, post_react, post_comment, profile_view, voice_note, attachment, embed_video, search_people: 'full'|'partial'|'none'}` |
| ledger | jsonb | `{hourly: {scope:'all_metered', cap:10, types:[…]} | null, daily_scope: {scope:'all_metered', types:[…]} | null, min_gap_seconds:[lo,hi], post_connect_quiet_hours:int}` |
| consent | jsonb | `{required_for_first_contact: bool, accepted_bases: [...]}` |

Seed: LI `{min_gap [90,400], quiet 0, hourly null}`; IG `{hourly all_metered cap 10, daily_scope all_metered, min_gap [60,240], quiet 0}`;
WA `{hourly null, daily_scope null, min_gap [10,20] floor → planner uses [20,90], quiet 24, consent required}`; mail providers `{min_gap [30,120]}`.
IG metered types (`all_metered`): `follow, unfollow, new_chat, message, like, comment, profile_view, followers_poll, post_fetch`. `reply` is never metered.

### outreach_platform_ceilings / outreach_warmup_caps get a `provider` column
`provider outreach_provider_t not null default 'LINKEDIN'`; PK becomes `(provider, action_type)` / `(provider, level, action_type)`.
Existing rows = LINKEDIN. Seeds:
- LINKEDIN: `new_chat` = same numbers as `message` (ceiling 100; warmup 5/10/20/35/50/60). Nothing else changes.
- INSTAGRAM ceilings: profile_view 60, follow 30, unfollow 15, new_chat 25, message 50, like 40, comment 15, post_fetch 40, followers_poll 3, reply 100000, call_api 100000, find_email 100000. Warmup (levels 0–5) per PRD §7.6: new_chat 0/3/8/15/20/25 · follow 5/10/15/20/25/30 · like 8/15/25/30/35/40 · comment 0/3/6/10/12/15 · profile_view 10/20/30/40/50/60 · message 0/6/16/30/40/50 · unfollow 0/3/5/8/10/15 · post_fetch 8/15/25/30/35/40 · followers_poll 1/2/2/3/3/3. Daily `all_metered` totals 15/30/50/70/85/100 (stored in `outreach_warmup_caps` as action_type `call_api`? NO — stored in `outreach_channel_totals(provider, level, per_day)`, see below).
- WHATSAPP ceilings: new_chat 35, message 100, identifier_check 50, reply 100000, call_api 100000, find_email 100000. Warmup levels 0–4: new_chat 2/5/10/20/35 · message 100 all levels · identifier_check 50 all levels. Level 5 row = level 4 numbers (the sender check constraint allows 0–5).

### outreach_channel_totals (provider, level, per_day) — the daily `all_metered` cap per level (IG only seeded)

### outreach_sender_budgets_scoped
```
sender_id uuid FK, window text check (window in ('hour','day')), window_start timestamptz, scope text,
cap int, used int default 0, reserved int default 0,
pk (sender_id, window, window_start, scope), check (used + reserved <= cap)
```
`window_start` is UTC-truncated (`date_trunc('hour', p_at)` for hours; the sender-local day start for days). RLS select via sender.

### outreach_senders new columns
`outreach_allowed_from timestamptz` (quiet period end) · `provider_warning jsonb` (null | `{text, at, level_before, paused_until}`) ·
`account_age_attested_at timestamptz` · `account_age_attested_by uuid` · `account_age_months int`.
The WhatsApp governor level IS `warmup_level` (0–4). Instagram uses `warmup_level` 0–5.

### outreach_lead_identities
```
id uuid pk, workspace_id, lead_id, provider outreach_provider_t, identifier citext (slug | handle | E.164 '+…' | email),
provider_id text, verified bool default false, source text (import|inbound|profile_fetch|operator|enrichment|backfill),
is_valid bool, last_checked_at timestamptz, created_at
unique (workspace_id, provider, identifier); index (lead_id)
```
Backfill: every lead with `public_identifier` gets a LINKEDIN row (verified true, source 'backfill', provider_id = leads.provider_id).
RLS: select/insert/update/delete like outreach_lead_tags (via the lead). Writes from the UI go through RPCs anyway.

### outreach_lead_consent
As PRD §6.3 with the `outreach_` prefix: `id, workspace_id, lead_id, channel outreach_provider_t, basis outreach_consent_basis_t,
evidence jsonb, attested_by uuid, obtained_at, expires_at, revoked_at, revoked_reason, created_at`.
Unique partial index `(lead_id, channel) where revoked_at is null`. RLS select via lead; writes via RPC only.

### outreach_chats: `is_request boolean not null default false` (Instagram message request, not yet accepted)
### outreach_messages: `reactions jsonb not null default '[]'` (`[{emoji, by, at}]`), `read_at timestamptz`, `transcript text`, `transcript_status text` (null|pending|done|failed)
### outreach_transcribe_queue (message_id pk, attempts int, locked_at, created_at) — service only
### outreach_sequences: `sender_pools jsonb not null default '{}'` = `{"LINKEDIN":[ids],"INSTAGRAM":[ids],…}` kept in sync by trigger `outreach_trg_sequence_pools` from `sender_pool`. Settings key `channel_independent_continuation` (bool, default false).
### outreach_enrollments: `current_channel outreach_provider_t` (set at enrol from the sender; changed by `channel_switch`), `channel_sender_map jsonb not null default '{}'`.
### outreach_sender_followers (sender_id, provider_id text, username citext, first_seen_at, last_seen_at, pk(sender_id, provider_id)) — service only
### outreach_followers_poll_plan (sender_id, day, times timestamptz[], done int, pk) — service only

Block signals and provider warnings are `outreach_sender_events` rows: `kind = 'block'` data `{lead_id, code, action_id, action_type, preceding:[{at,type,lead_id}]}`; `kind = 'provider_warning'` data `{text, level_before, paused_until}`.

## 3. Functions (026_channels_functions.sql)

Grants: same footer as 023 (revoke from public/anon, grant service_role, internal ones revoked from authenticated). Every user RPC: `outreach_require()` then `outreach_client_visible()`.

### Identity
- `outreach_normalize_phone(p_raw text) returns text` immutable. Accepts `+CC…` or `00CC…` with 8–15 digits → `'+digits'`. Anything else (bare `9876543210`) → null. Never guesses a country code.
- `outreach_normalize_handle(p_raw text) returns text` immutable: lowercase, strip `@`, strip `instagram.com/`, trailing slash/query.
- `outreach_identity_add(p_lead uuid, p_provider outreach_provider_t, p_identifier text, p_source text default 'operator', p_verified boolean default true, p_provider_id text default null) returns uuid` (member). Raises `E_PAYLOAD_INVALID: phone needs a country code, e.g. +91 98765 43210` / `E_PAYLOAD_INVALID: not an Instagram handle`. Upserts on (ws, provider, identifier); conflicting owner lead → `E_IDENTITY_CONFLICT: this <handle|number> already belongs to <name>`.
- `outreach_identity_list(p_lead uuid) returns jsonb` `[{id, provider, identifier, provider_id, verified, source, is_valid, last_checked_at, created_at}]` (LinkedIn row synthesised from the lead when no row exists).
- `outreach_identity_verify(p_id uuid) returns void`, `outreach_identity_remove(p_id uuid) returns void` (member).
- `outreach_lead_identity(p_lead uuid, p_provider outreach_provider_t) returns jsonb` **internal** (service): the usable identity `{id, identifier, provider_id, verified, is_valid}` or null. Only `verified = true` rows; LINKEDIN falls back to `leads.public_identifier / provider_id`.
- `outreach_identity_set_check(p_id uuid, p_valid boolean, p_provider_id text) returns void` internal.

### Consent
- `outreach_consent_grant(p_lead uuid, p_channel outreach_provider_t, p_basis outreach_consent_basis_t, p_evidence jsonb default '{}', p_obtained_at timestamptz default now(), p_expires_at timestamptz default null) returns uuid` (member; `attested_by = auth.uid()`; revokes an older active row with reason 'replaced'; audit `consent.granted`; `form_optin`/`existing_customer` need evidence `url` or `note` → else `E_PAYLOAD_INVALID: evidence required for this basis`).
- `outreach_consent_grant_system(p_lead uuid, p_channel outreach_provider_t, p_basis outreach_consent_basis_t, p_evidence jsonb) returns uuid` (service; used by inbound).
- `outreach_consent_revoke(p_id uuid, p_reason text default 'manual') returns void` (member): sets revoked; exits live enrollments of that lead whose current channel = the consent channel (`exited_suppressed`, reason `consent_revoked`); cancels queued actions on senders of that provider; audit.
- `outreach_consent_revoke_stop(p_lead uuid, p_channel outreach_provider_t, p_message_id uuid) returns void` (service): revoke with reason `stop_request` + suppression row (`kind 'phone'` with the E.164 or `'handle'`, source `stop`) + exits, as above.
- `outreach_lead_has_consent(p_lead uuid, p_channel outreach_provider_t) returns boolean` internal (active, not expired).
- `outreach_consent_list(p_ws uuid, p_lead uuid default null, p_channel outreach_provider_t default null, p_basis outreach_consent_basis_t default null, p_include_revoked boolean default false, p_limit int default 200) returns jsonb` `[{id, lead_id, lead_name, channel, basis, evidence, attested_by, attested_by_email, obtained_at, expires_at, revoked_at, revoked_reason}]`.
- `outreach_consent_report(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null) returns jsonb` `{period, contacted: n, by_basis: {basis: {leads, share_pct}}, imported_attested_share_pct, alert: bool (share > 30), rows: [{lead_id, lead_name, basis, obtained_at, evidence, attested_by_email, first_new_chat_at, sender_name}]}`. "Contacted" = a `new_chat` action sent on a WHATSAPP sender in the period.

### Ledger
- `outreach_channel_caps(p_provider outreach_provider_t) returns jsonb` (authenticated): the descriptor row as json.
- `outreach_scoped_types(p_provider outreach_provider_t) returns text[]` internal.
- `outreach_effective_cap(p_sender uuid, p_type outreach_action_type_t) returns int` — reads ceilings/warmup for `sender.provider`; unchanged semantics otherwise.
- `outreach_effective_total_cap(p_sender uuid) returns int` — IG daily `all_metered` (from outreach_channel_totals × health multiplier); null when the provider has no daily scope.
- `outreach_plan_budgets(p_sender uuid, p_day date)` — daily rows for the provider's ceilings + a `('day', day_start, 'all_metered')` scoped row when the provider has a daily scope.
- `outreach_ensure_hour_budget(p_sender uuid, p_at timestamptz) returns void` internal: upsert `('hour', date_trunc('hour', p_at), scope, cap)`; cap = descriptor hourly cap, 0 when health < 50.
- `outreach_reserve_budget(p_sender uuid, p_day date, p_type outreach_action_type_t, p_at timestamptz) returns boolean` — daily row, then every scoped row the type belongs to (day scope, then hour scope); a failure releases what was taken. The 3-arg form stays and calls the 4-arg one with `now()`.
- `outreach_consume_budget(p_sender, p_day, p_type, p_at)` / `outreach_release_budget(p_sender, p_day, p_type, p_at)` — also touch the scoped rows. 3-arg forms stay (call with now()). `outreach_complete_action`, `outreach_fail_action`, `outreach_sweep_stale_reservations` pass `reserved_at`.
- `outreach_sender_hour(p_sender uuid) returns jsonb` (client_viewer): `{scope, hour_start, cap, used, reserved, remaining}` or `{}`; `outreach_sender_scopes_today(p_sender) returns jsonb` `{day: {...}|null, hour: {...}|null}`.
- `outreach_channel_capacity(p_ws uuid, p_client uuid default null) returns jsonb` `[{sender_id, name, provider, status, level, quiet_until, today: {type: remaining}, hour: {cap, remaining} | null}]`.
- `outreach_sender_min_gap(p_sender uuid) returns int` internal (seconds, `ledger.min_gap_seconds[0]`).
- `outreach_claim_due_actions(p_limit)` rewrite: any provider with status ok; skips a sender whose last executed action (any type but `reply`) is younger than its min gap; skips outbound types (`new_chat, message, follow, unfollow, like, comment, invite, inmail, profile_view, comment`) while `outreach_allowed_from > now()` (replies / call_api / find_email / identifier_check / relations_poll / followers_poll are not gated); reserves with `p_at = now()`; when the reservation fails because of the hour scope, `scheduled_for = date_trunc('hour', now()) + 1h + random minutes`, decision `hourly_deferred` (not `budget_deferred`).

### Node catalogue (SQL side)
`outreach_node_action_type`: `follow → 'follow'`, `unfollow → 'unfollow'`, `like_recent_posts → 'like'`, `comment_post → 'comment'`, `check_identifier → 'identifier_check'`; `follow_profile` keeps mapping to `follow`.
`outreach_is_executable_node` += `follow, unfollow, like_recent_posts, comment_post, check_identifier`.
`outreach_node_types` += `follow, unfollow, like_recent_posts, comment_post, wait_follow_back, check_identifier, require_consent, wait_for_reply, channel_switch`.

Node configs (the builder writes them, the engine reads them):
| type | config | exits |
|---|---|---|
| send_message / send_voice_note | + `channel?` (provider; default = the pool sender's), `new_chat_allowed: bool` (default true) | next, `no_chat` (optional branch; when absent and a new chat is not allowed the step is skipped) |
| follow / unfollow | `{}` | next |
| like_recent_posts | `count 1..3`, `max_age_days` | next |
| comment_post | `text`, `ai?`, `max_age_days` | next |
| wait_follow_back | `window_days` (default 5), `poll_budget 1..3` (default 2) | `followed_back`, `no_follow_back` |
| check_identifier | `{}` | `valid`, `invalid` |
| require_consent | `bases: consent_basis[]` (empty = any) | `has_consent`, `no_consent` |
| wait_for_reply | `window_hours` (default 96) | `replied`, `no_reply` |
| channel_switch | `to_channel` (provider), `require_identity: true` | next, `unavailable` |

### Engine (enter_node / planner / waits / triggers)
- `outreach_enter_node`: `require_consent` → branch by `outreach_lead_has_consent(lead, sender provider or cfg.channel)` filtered by `bases`; `wait_follow_back` → if `lss.relation = 'first'` (= follows us back) take `followed_back` with `p_not_before = now() + 2h`, else `status = waiting_connection`, `wait_until = now() + window_days`; `wait_for_reply` → `status = waiting_delay`, `wait_until = now() + window_hours` (release takes `no_reply`); `channel_switch` → needs `outreach_lead_identity(lead, to_channel)` verified, a pool sender of that provider (`sender_pools`) with status ok and no live enrollment for (lead, that sender), consent when the descriptor requires it; on success `update enrollments set sender_id, current_channel, channel_sender_map || {to_channel: sender}` + `insert lss`, continue on `next`; otherwise branch `unavailable` (skip when absent). Enrol sets `current_channel = sender.provider`.
- `outreach_release_waits`: `waiting_connection` timeout takes `no_follow_back` when the node is `wait_follow_back`, else `no_connect`; `waiting_delay` on a `wait_for_reply` node takes `no_reply`.
- `outreach_trg_relation`: branch = `followed_back` when the current node is `wait_follow_back`, else `connected`.
- `outreach_trg_reply_exit`: `last_replied_channel` = lower(provider) with mail providers → 'email'; when the current node is `wait_for_reply` the enrollment ADVANCES on `replied` instead of exiting (node stats `replied` +1); when the sequence setting `channel_independent_continuation` is true, only enrollments whose `current_channel` equals the replying sender's provider are stopped.
- `outreach_planner_demand`: adds column `provider outreach_provider_t`; for `send_message` / `send_voice_note` returns `action_type = 'new_chat'` when no chat exists for (lead, sender) (`lss.unipile_chat_id is null and no outreach_chats row`) and `cfg.new_chat_allowed <> false`; when a new chat is NOT allowed the row is skipped (the executor takes `no_chat`); WHATSAPP `new_chat` rows are omitted while `outreach_lead_has_consent` is false (throttle text: "Waiting for consent: <n> lead(s) have no recorded WhatsApp consent"); every outbound row is omitted while `outreach_allowed_from > now()`; `needs_profile` only for LINKEDIN, and for INSTAGRAM when the identity has no `provider_id` (the profile read fills it); nodes whose `config.channel` differs from the sender provider are skipped.
- `outreach__enroll_plan`: a sender is only eligible for a lead when `outreach_lead_identity(lead, sender.provider)` exists; when none of the free senders fits → reason `no_identity`; a WHATSAPP sender additionally needs consent when the graph has a `send_message`/`send_voice_note` → else reason `no_consent`. `outreach_enroll_leads` sets `current_channel`.
- `outreach_validate_graph(p_graph, p_pool, p_strict)` additions (pool providers from `outreach_senders`): errors `E_NO_CONSENT_GUARD` (WA send_message with `new_chat_allowed` and no `require_consent` ancestor), `E_LIKE_COUNT` (count > 3), `E_NO_CHANNEL_SENDER` (a channel step with no pool sender of that provider, strict), `E_QUIET_PERIOD` (strict: every WA pool sender has `outreach_allowed_from` in the future), `E_HOURLY_DEMAND` (IG: executable IG steps with no delay between more than 10 in a row… implement as: more than 10 consecutive executable IG steps without a delay/wait), `E_SWITCH_NO_IDENTITY` (channel_switch to a channel with no identity source: nothing before it can produce one and the step config `require_identity` is true → only warn); warnings `W_IG_DM_FIRST` (first executable step on an IG path is send_message), `W_WA_ATTESTED_ONLY` (require_consent bases = ['imported_attested'] only), `W_CHANNEL_INDEPENDENT` (setting on), `W_IG_COMMENT_PITCH` (comment text matches /(book a|demo|pricing|our (product|platform|tool)|sign up|free trial|dm me|link in bio)/i). Messages in plain words.
- `outreach__sender_causes`: `E_QUIET_PERIOD` (blocking, `next_capacity = outreach_allowed_from`, detail "X connected recently and waits until <date> before outreach (24 h quiet period)"), `E_PROVIDER_WARNING` (blocking while paused after a provider warning), `W_HOURLY_CAP` (hour scope exhausted, `next_capacity` = next hour), `W_MIN_GAP` (last action under the gap; informational). Enrollment causes in `outreach_why_not_sending`: `E_NO_CONSENT`, `E_NO_IDENTITY`, `E_IDENTIFIER_INVALID`.
- `outreach_reason_text` += `E_NO_CONSENT`, `E_NO_IDENTITY`, `E_IDENTIFIER_INVALID`, `E_HOURLY_CAP`, `E_QUIET_PERIOD`, `E_MIN_GAP`, `E_PROVIDER_WARNING`, `no_chat`, `hourly_deferred`, `not_on_whatsapp`, `no_follow_back`, `no_reply`, `unavailable`, `consent_revoked`, `stop_request`, `blocked`.

### Senders / health
- Trigger `outreach_trg_sender_quiet_period` (before update on outreach_senders): status → `ok` from `connecting|credentials|error` sets `outreach_allowed_from = now() + descriptor quiet hours` when hours > 0 (else null). Also inserts a sender_event `kind 'quiet_period'`.
- `outreach_sender_attest_account_age(p_sender uuid, p_months int) returns void` (manager): WhatsApp only; `< 6` → `E_ACCOUNT_TOO_NEW: WhatsApp numbers need at least 6 months of real use before outreach`; stores columns; audit.
- `outreach_sender_provider_warning(p_sender uuid, p_text text) returns void` (service): level −1 (min 0), `paused_until = now() + 48h`, `provider_warning` jsonb, event, `status_reason = 'provider_warning'`.
- `outreach_sender_resume_after_warning(p_sender uuid) returns void` (manager): clears `paused_until`, `provider_warning`, `status_reason`; audit `sender.resume_after_warning`.
- `outreach_record_block(p_sender uuid, p_lead uuid, p_code text, p_action uuid) returns void` (service): sender_event `kind 'block'` with the 5 preceding sent actions; `lss.relation = 'blocked'`; WHATSAPP: immediate one-level demotion (`warmup_level - 1`, event `kind 'warmup'` data `{reason:'block'}`).
- `outreach_health_inputs(p_sender)` new keys: `provider`, `blocks_30d`, `new_chats_14d`, `new_chats_replied_14d`, `new_chats_all`, `new_chats_replied_all`, `days_connected`, `inbound_conversations`, `account_age_attested` (bool), `disconnect_within_24h_of_outreach` (bool), `provider_warning` (bool).
- `outreach_wa_governor(p_sender uuid) returns jsonb` (service): applies PRD §7.4 — promotion (nightly) and demotion (any time); returns `{level_before, level_after, reason}`; writes a `warmup` event when it changes. Called by worker-health (nightly) and `outreach_record_block`.

### Reports
- `outreach__facts`: `channel` = `lower(provider)` for LINKEDIN/INSTAGRAM/WHATSAPP, `'email'` for mail providers (action volume, replies, inbound, email engagement all use the sender's/chat's provider); new metric `block` (sender_events kind 'block'). `outreach__totals_from` adds `new_chats`, `follows` (exists), `blocks`, `identifier_checks`, `followers_polls`; `touches` = messages + inmails + emails + notes + new_chats. `by_channel` keys in `outreach_report_overview` may now include `instagram` / `whatsapp`.
- `outreach_report_channels(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null) returns jsonb` `{period, rows: [{channel, senders, actions (metered outbound: invites+new_chats+messages+inmails+emails+likes+comments+follows), new_chats, replies, replies_per_100_actions, interested, blocks, reply_rate}]}`.
- `outreach_report_blocks(p_ws uuid, p_client uuid default null, p_from date default null, p_to date default null, p_sender uuid default null) returns jsonb` `{period, rows: [{at, sender_id, sender_name, provider, lead_id, lead_name, code, preceding:[…]}], by_sender: [{sender_id, name, blocks}]}`.
- `outreach_metric_definitions` += `new_chats`, `replies_per_100_actions`, `blocks`, `consent basis`.

### Templates (SQL none) — the web (`lib/outreach/templates.ts`) and MCP (`steps.ts`) ship:
1. `instagram_ladder` — follow → 1d → like_recent_posts(2) → 2d → wait_follow_back(5d, poll 2) { followed_back → send_message(new_chat) ; no_follow_back → comment_post → 3d → send_message(new_chat) } → wait_for_reply(96h) { replied → end ; no_reply → 5d → send_message → end }.
2. `linkedin_to_whatsapp` — visit → invite → wait_connection { connected → message → wait_for_reply(96h) { replied → end ; no_reply → 7d → message → end } ; no_connect → withdraw → end }. WhatsApp is reached through the inbox once a reply produced consent (the template's description says so); a second template `whatsapp_consented_followup`: require_consent { has_consent → check_identifier { valid → send_message(new_chat) → wait_for_reply(72h) { replied → end ; no_reply → 3d → send_message → end } ; invalid → end } ; no_consent → end }.

## 4. Engine (TypeScript)

- `_shared/outreach/channels.ts` (new): `type Provider`, `ChannelCapabilities` (mirrors the table), `capabilitiesFor(provider)` (cached 5 min from the table), `attendeeIdFor(provider, identity)` → LinkedIn `provider_id`; Instagram `provider_id` (the `provider_messaging_id` stored on the identity's `provider_id`); WhatsApp `<digits>@s.whatsapp.net`; `phoneDigits(e164)`; `isOutboundType(type)`; `minGapMs(caps)`.
- `unipile.ts` adds `users.followers(accountId, {user_id?, cursor?, limit?})` (`GET /users/followers`), `users.following(...)`, `users.follow(accountId, identifier)` (= `POST /users/invite` with `provider_id`; Instagram accepts the username), `chats.folder`? no. Everything else exists.
- `execute.ts`: resolves the lead identity for the sender's provider with `rpc('lead_identity')`; actions: `new_chat` (start a chat via `chats.start`; WhatsApp requires `rpc('lead_has_consent')` at send time → decision `{kind:'branch', name:'no_consent'}` when the node has that branch, else `skip_node` with code `E_NO_CONSENT`; WhatsApp requires `identity.is_valid !== false`; LinkedIn keeps the relation check), `message` (existing chat only; no chat → `no_chat` branch / skip), `follow` (INSTAGRAM via `users.follow`; LINKEDIN stays `unsupported_follow`), `unfollow` (skip `unsupported_unfollow` on every provider — no endpoint), `like` with `cfg.count` ≤ 3 (each extra like reserves/consumes a `like` budget; stop when no budget), `comment` (IG/LI), `identifier_check` (WA: `users.profile(account, phoneDigits)`; 200 → `identity_set_check(valid, provider_id)` + branch `valid`; 404 / `invalid_recipient` / `user_unreachable` → `invalid`, `lss.relation = 'invalid'`; never consumes `new_chat`), `profile_view` on INSTAGRAM (stores `provider_messaging_id` on the identity, `relationship_status.followed_by` → `lss.relation = 'first'`). Block detection: a `new_chat`/`message` failing with `blocked_recipient`, or a `message` failing after an earlier successful send to the same chat → `rpc('record_block')`. Decision kind `branch:'no_consent'` and `branch:'no_chat'` are ordinary branch decisions.
- `errors.ts`: `blocked_recipient` on WA/IG → `mark_lead_invalid` + block signal (executor records it before returning); `invalid_recipient`/`user_unreachable` on `identifier_check` → `branch invalid`; `403 account_restricted` on INSTAGRAM with a message matching /automated|suspect/i → executor calls `rpc('sender_provider_warning')`.
- `planner.ts`: `selectSenders` = every provider except mail providers (mail senders are planned through mailbox rotation as today); per-hour bucketing when `caps.ledger.hourly` exists: slots are drawn per working hour with at most `cap` per hour (existing queued actions in that hour count); min gap from the descriptor (`min_gap_seconds` × 1000, randomised in the range); senders inside the quiet period plan no outbound rows; `needs_profile` as the SQL says.
- `health.ts`: categories `block_signals` (0 blocks → 100, −30 each, floor 0) for IG/WA and `new_chat_reply_rate` (WA only: ≥25 new chats: rate ≥ 50% → 100, ≥ 40% → 85, ≥ 25% → 60, else 30; fewer → 100); nightly: `rpc('wa_governor')` for WHATSAPP senders instead of the LinkedIn level-up rule; INSTAGRAM level-up uses the existing 14-day rule with `maxLevel 5`.
- `inbound.ts`: `handleMessaging` handles `account_type` INSTAGRAM/WHATSAPP: attendee id → identity match (`outreach_lead_identities` by provider + identifier/provider_id; WA phone from `<digits>@s.whatsapp.net` → `+digits`; IG by `attendee_provider_id` or the handle in `attendee_profile_url`), creates the lead when the workspace allows and records the identity (`source 'inbound'`, verified); inbound on WHATSAPP → `rpc('consent_grant_system', basis 'inbound', evidence {chat_id, message_id})` when no active consent; stop-intent (multi-language regex `^\s*(stop|unsubscribe|remove me|no more|opt out|arr[êe]t|stopp|basta|para|detener|rok|band karo|बंद|nahi chahiye)\b`) → `rpc('consent_revoke_stop')`; Instagram: `chat.folder`/payload containing `request|pending` → `is_request = true`, cleared on our first outbound; events `message_reaction` / `message_read` / `message_delivered` update `reactions` / `read_at`; audio attachments (`type === 'audio'` or `mimetype` starts with `audio/`) → `attachments[i].voice_note = true` and a row in `outreach_transcribe_queue`. `backfillChats` and `resolveChatNames` work for INSTAGRAM/WHATSAPP too. `handleAccountStatus` → `PERMISSIONS`/`ERROR` on INSTAGRAM with text matching /automated|suspect/i → `rpc('sender_provider_warning')`.
- `reply.ts`: IG/WA send through `chats.send` (same as LinkedIn); after a WA reply clear nothing; after any IG outbound set `is_request = false`.
- `transcribe.ts` (new): `transcribeVoiceNote(messageId)` downloads the attachment through the connector (`messages.attachment`), sends it to Gemini (`generateContent` with `inlineData`, model from `OUTREACH_AI_MODEL` → `GEMINI_MODEL_ID` → `gemini-3-flash-preview`, key `GEMINI_API_KEY`), stores `transcript`, `transcript_status`, and re-queues the message for classification when it is inbound (`outreach_ai_classify_queue`). The classifier's input text = `text || transcript`.
- `channel_workers.ts` (new): `runFollowersPoll()` (1–3 polls/day/sender at random offsets inside working hours, `followers_poll` budget, pages `users.followers` newest first, stops after a page whose ids are all already in `outreach_sender_followers`, matches IG identities of leads in `wait_follow_back` → `lss.relation = 'first'` (the trigger advances with +2 h)); `runIdentifierCheck()` (WA senders: leads with a WHATSAPP identity `is_valid is null` that have a queued `new_chat` or are enrolled with a WA sender; `identifier_check` budget; max 20/sender/run); `runBlockDetect()` (one-way chats: our `new_chat` sent ≥ 7 days ago, no inbound ever, and a later `message` failed → `record_block`; plus `sent` chats whose later message failed with `blocked_recipient`); `runTranscribe(limit)`; `runWaGovernor()`.
- `outreach-worker-channels/index.ts` (new, cron): `{mode: 'followers_poll' | 'identifier_check' | 'block_detect' | 'transcribe' | 'wa_governor'}`; cron jobs `outreach-followers-poll` (`35 * * * *`), `outreach-identifier-check` (`*/30 * * * *`), `outreach-block-detect` (`55 * * * *`), `outreach-transcribe` (`* * * * *`). Add to `scripts/outreach-deploy-functions.sh` CRON_FUNCS.
- `outreach-sender-connect`: providers `INSTAGRAM`, `WHATSAPP` (hosted providers `["INSTAGRAM"]` / `["WHATSAPP"]`); WHATSAPP requires `account_age_months >= 6` in the body (else `E_ACCOUNT_TOO_NEW`), stored via `rpc('sender_attest_account_age')` after insert; both start at `warmup_level 0`; display_name default "Instagram account" / "WhatsApp number".
- `outreach-sender-manage`: actions `attest_account_age {months}` (→ RPC), `resume_after_warning` (→ RPC), `check_identifiers` (runs `runIdentifierCheck` for one sender).
- `outreach-unipile-setup`: messaging events += `message_reaction`, `message_read`, `message_delivered`.
- `syncOwnProfile`: INSTAGRAM → `users.me` gives `username` → `public_identifier`, `provider_id`, `display_name`, `picture_url`; WHATSAPP → `phone_number` → `public_identifier = '+digits'`, display_name from `name`.

## 5. Web

- `lib/outreach/types.ts` (already updated): `Provider`, `ActionType`, `NodeType`, `ConsentBasis`, `LeadConsent`, `LeadIdentity`, `ChannelCapabilities`, `SenderBudgetScoped`, sender/sequence/enrollment/chat/message fields.
- `lib/outreach/nodes.ts`: catalogue entries for the 9 new types with `channels: Provider[]` on `NodeMeta` (existing LinkedIn-only steps get `['LINKEDIN']`; channel-agnostic logic steps `[]` = any); `send_message` channels `['LINKEDIN','INSTAGRAM','WHATSAPP']`; groups: new group `'Instagram'` and `'WhatsApp'`; picker categories "Instagram actions", "WhatsApp actions"; `EXIT_LABELS` for the new exits; `TEXT_LIMITS` `ig_message 1000`, `wa_message 4096`, `ig_comment 2200`.
- `lib/outreach/graph.ts`: the validator mirrors §3 (needs `opts.poolProviders: Provider[]`); `humanizeIssue` translations for the new codes.
- `components/outreach/sequences/allowedNext.ts`: takes the pool providers; a channel step is greyed out with "Add a <channel> account to the sender pool first"; WhatsApp `send_message` needs `require_consent` above it ("Add “Check consent” first: WhatsApp messages need a recorded consent basis"); `wait_follow_back` needs `follow` above; `check_identifier` only on WhatsApp paths; `channel_switch` only when the pool has two channels.
- Forms in `FormsChannels.tsx`; `SendMessageForm` gains the channel selector (only when the pool has more than one channel) and the "Start a new conversation if none exists" toggle with the WhatsApp consent note; `StepPicker` icons and blurbs; `helpers.ts` `nodeSummary` + `exitTone` (`followed_back`, `has_consent`, `valid`, `replied` positive; `no_follow_back`, `no_consent`, `invalid`, `no_reply`, `no_chat`, `unavailable` negative).
- `lib/outreach/templates.ts`: the three templates of §3.
- `lib/outreach/reasons.ts`: the new codes in plain words.
- `lib/outreach/channels.ts` (new, web): hooks `useChannelCaps()`, `useLeadIdentities(leadId)`, `useLeadConsent(leadId)`, `useConsentList(ws, filters)`, `useSenderScopes(senderId)`, `useChannelCapacity(ws)`, `useReportChannels`, `useReportBlocks`, `useConsentReport`; constants `CONSENT_BASIS_LABELS`, `CONSENT_BASIS_TONE` (imported_attested = amber), `channelLabel(provider)`, `isMailProvider`, `CHANNEL_PROVIDERS = ['LINKEDIN','INSTAGRAM','WHATSAPP']`.
- Senders: connect wizard cards for Instagram and WhatsApp (WhatsApp card: QR / pairing hosted page, the 24-hour quiet period, the consent rule, the "number is at least 6 months old with real conversations" attestation — a required checkbox + months input); `PROVIDER_LABELS`, `ProviderLogo` (Instagram gradient glyph, WhatsApp green glyph); list page shows `New chats` / `Messages` for IG/WA and the hourly remaining for IG; detail header: quiet-period countdown badge ("Outreach starts <date>"), provider-warning banner with the verbatim text, our interpretation and "Resume anyway" (confirm modal, manager); Budgets tab: "This hour" card for IG, day `all_metered` row, ceilings/warmup filtered to the sender's provider, WhatsApp governor table (levels 0–4 with promotion conditions); Overview "Profile" card shows account-age attestation for WhatsApp with an "Attest" action.
- Inbox: channel filter includes Instagram and WhatsApp; row/thread icons per channel; "Message request" badge (`is_request`); MessageBubble renders voice notes with an `<audio>` player (attachment proxy) + transcript, reactions row, "Seen" when `read_at`; Compose: per-channel limits, WhatsApp/Instagram consent chip in the thread header (basis, date, evidence link, revoke with confirm) for WhatsApp threads; disabled reasons come from the sender status as today.
- Leads: `LeadIdentitiesCard` (list, add handle / phone with the E.164 rule shown, verify, remove) and `LeadConsentCard` (active consent per channel, grant with basis + evidence, revoke) on the lead page; `LeadHeader` chips ("WhatsApp consent: inbound", amber for imported_attested); CSV mapping fields `instagram_handle`, `whatsapp_phone` → identities (`identities` array on `upsert_lead`); the enrol preview shows `no_identity` / `no_consent` in words.
- Reports: new tab "Channels" (efficiency table + blocks log) and "Consent" (report + CSV export, amber share alert); `SendersTab` provider labels.
- Settings → Safety: per-channel ceilings / warmup tabs (LinkedIn, Instagram, WhatsApp) + a "Consent" card explaining the WhatsApp rule.
- MCP: `tools_channels.ts` with `consent_list`, `consent_grant` (gated; description says an agent may not attest on a human's behalf, the human must state the basis), `consent_revoke` (gated), `identity_list`, `identity_add` (unverified by default), `channel_capacity`, `report_channels`, `report_consent`, `report_blocks`; `senders_list` / `sender_get` / `sender_budgets` return `channel`, `quiet_until`, `hour` remaining; `inbox_list` channel enum += INSTAGRAM, WHATSAPP, filter `request`; `enroll_preview` reason meanings for `no_identity` / `no_consent`; `steps.ts` verbs `follow` (IG when the pool says so — the compiler keeps `follow_profile` for LinkedIn and emits `follow` when `channel: 'INSTAGRAM'`), `unfollow`, `like_posts`/`like_recent`, `comment`, `wait_follow_back`, `check_identifier`, `require_consent`, `wait_for_reply`, `channel_switch`; the compiler auto-inserts `require_consent` before a WhatsApp `message` with `new_chat`; templates `instagram_ladder`, `linkedin_to_whatsapp`, `whatsapp_consented_followup`; safety policy text gets a "Channels" section (WhatsApp consent gate, Instagram 10/hour, quiet period, governor).

## 6. Error codes (all surfaces)
`E_NO_CONSENT` · `E_NO_IDENTITY` · `E_IDENTITY_CONFLICT` · `E_IDENTIFIER_INVALID` · `E_HOURLY_CAP` · `E_QUIET_PERIOD` · `E_MIN_GAP` · `E_PROVIDER_WARNING` · `E_ACCOUNT_TOO_NEW` · `E_NO_CONSENT_GUARD` · `E_LIKE_COUNT` · `E_NO_CHANNEL_SENDER`.

## 7. Smoke test — `migrations/outreach/tests/smoke_06_channels.sql`
Fixtures: workspace, owner, IG sender (level 2), WA sender (level 0, attested), LI sender; leads with identities; asserts: phone normalisation (bare 10 digits rejected), identity add/conflict, consent grant/revoke/expiry, `lead_has_consent`, hourly reservation (11th IG reservation in the same hour fails and the daily row is released), day `all_metered` cap, quiet period trigger on WA status → ok, `claim_due_actions` skips outbound in the quiet period and honours min gap, planner_demand returns `new_chat` vs `message` and omits WA without consent, `require_consent` branching in enter_node, `wait_follow_back` → relation first advances on `followed_back`, `wait_for_reply` → reply advances on `replied` (not exit), `release_waits` takes `no_reply`, `channel_switch` unavailable branch, enroll_plan `no_identity` / `no_consent`, validator errors/warnings, `record_block` demotes a WA sender, `wa_governor` promotion refused without attestation, `consent_report` share alert, LinkedIn regression: LI budgets/effective caps unchanged for `invite`/`message`, LI `reserve_budget` untouched by scoped rows.
