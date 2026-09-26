# PRD: Instagram & WhatsApp Channels

**Document:** Product Requirements Document — multi-channel expansion
**Version:** 1.0 · 25 September 2026
**Builds on:** `linkedin-outreach-platform-PRD.md` (platform, assumed shipped and stable) and `outreach-mcp-PRD.md` (MCP layer, assumed shipped)
**Component:** channel adapters + engine changes, not a separate product
**Sources:** Unipile provider limits page (updated 28 Aug 2026), provider feature matrix (updated 26 Aug 2026), WhatsApp and Instagram connection guides.

---

## 1. Premise and the one thing that must not be copied forward

The platform's LinkedIn model rests on an assumption that is **false for both new channels**: that outreach begins with a connection request, that acceptance is a discrete permission event, and that a message sent after acceptance is to someone who agreed to hear from you.

| | LinkedIn | Instagram | WhatsApp |
|---|---|---|---|
| Permission primitive | invitation → acceptance | follow (no acceptance needed to DM) | **none** |
| Identifier | public slug / provider id | handle / user id | **phone number** |
| Can you message a stranger? | only via InMail (paid) | yes, lands in Requests | yes, lands in their inbox |
| Does the platform meter it? | invites/day | actions/day **and per hour** | **new chats created** |
| What a stranger experiences | a request they can ignore | a message request tab | a notification on their phone |

That last row is the product decision. A LinkedIn invitation is a knock at a professional door. A WhatsApp message is a buzz in someone's pocket, in the same app their family uses, from a number they don't know. Treating them as the same "send a first touch" node would be technically easy and would be the wrong product.

**Therefore: WhatsApp ships as a consent-gated channel, not a prospecting channel** (§6). Instagram ships as a prospecting channel with an engagement ladder and a much tighter ledger. The platform's existing safety architecture — database-enforced budgets, schedule windows, warmup levels, reply-stop triggers — carries over unchanged and is extended, never relaxed.

---

## 2. Goals and non-goals

### 2.1 Goals
1. Add Instagram and WhatsApp as first-class channels: senders, sequences, unified inbox, reporting, MCP.
2. Extend the ledger to enforce **hourly** caps, which Instagram requires and LinkedIn never did.
3. Introduce a **consent ledger** so WhatsApp sends are provably justified per recipient.
4. Cross-channel sequences: a lead can be touched on LinkedIn, then WhatsApp once consent exists, inside one enrollment.
5. Identity resolution: one lead, many channel identities, one conversation history.
6. No regression to LinkedIn safety or throughput.

### 2.2 Non-goals (this phase)
- Meta's official WhatsApp Business Cloud API. Unipile connects the user's existing personal or Business **app** account by QR/pairing code, the way WhatsApp Web does; it is not a Meta partner integration. Template messages, verified sender tiers and the 24-hour window are Cloud API concepts that do not apply here — and their absence is a liability, not a feature (§6).
- WhatsApp broadcast or group messaging as an outreach mechanism.
- Instagram cold DM at volume as a default configuration. It is available; it is not the recommended setup and is not what onboarding steers people to.
- Facebook/Messenger, Telegram, X. The adapter interface accommodates them; they are not built.
- Instagram Stories, Reels publishing, or content scheduling. This is an outreach platform.

---

## 3. Provider capability matrix

From Unipile's feature matrix (26 Aug 2026). 🟢 available · 🟠 partial · — unavailable.

| Capability | LinkedIn | Instagram | WhatsApp |
|---|---|---|---|
| Hosted auth / custom auth | 🟢 | 🟢 | 🟢 |
| Send / reply / list messages, chats, attendees, sync history | 🟢 | 🟢 | 🟢 |
| Reactions, read receipts | 🟢 | 🟢 | 🟢 |
| File attachments, voice notes | 🟢 | 🟢 | 🟢 |
| Embedded video | 🟢 | — | 🟢 |
| Retrieve user profile | 🟢 | 🟢 | 🟢 |
| Retrieve own profile | 🟢 | 🟢 | 🟢 |
| **"Is this number on WhatsApp?"** | — | — | 🟢 |
| Invite / accept / decline / pending list | 🟢 | — | — |
| InMail + credit balance | 🟢 | — | — |
| Follow someone | 🟢 | 🟢 | — |
| List followers / following | — | 🟢 | — |
| List relations (contacts) | 🟢 | — | — |
| List user posts, retrieve post | 🟢 | 🟢 | — |
| React to post, comment, list comments/reactions | 🟢 | 🟢 | — |
| Create a post | 🟢 | 🟢 | — |
| Search people / posts | 🟢 | 🟠 | — |
| Company profiles, jobs, endorsements | 🟢 | — | — |
| Webhooks: account status, new message, reactions/read | 🟢 | 🟢 | 🟢 |
| **`new_relation` webhook (acceptance detection)** | 🟢 | — | — |

**Three consequences that shape everything below:**

1. **No `new_relation` for Instagram.** There is no webhook for "they followed you back." Any warm-signal detection on Instagram requires polling `list followers`, which is itself a metered action. Design accordingly (§9.3) — do not build a `wait_connection` analogue that silently burns the action budget.
2. **WhatsApp has a number-validity check.** `GET users/{phone}` (the "is number on?" route) tells you whether a number is registered before you create a chat. Since **new chat creation is the metric WhatsApp polices**, validating first is not an optimisation, it is a safety control (§7.4).
3. **Instagram has a full engagement surface.** Follow, like, comment, view profile, read followers. That is a real ladder — and a much better first touch than a cold DM.

---

## 4. Provider limits (authoritative, from Unipile 28 Aug 2026)

### 4.1 Instagram

> Limit each account to **a maximum of 100 actions per day and no more than 10 actions per hour**, particularly for following, outreach, liking and commenting. If you receive many inbound messages, you can reply to all of them safely, as on the UI. For new or inactive accounts, begin with lower activity and increase gradually. Space all actions randomly rather than at regular intervals, distributed across multiple slots during working hours.

Also documented: Instagram may show *"We suspect automated behavior on your account."* Unipile's position is that this warning can be continued through without observed further restriction. **We do not adopt that position as a product default** — see §7.5. We surface the warning, pause the sender, and let the operator decide.

**The hourly cap is the architectural change.** The existing planner allocates a daily budget across a working window. Instagram needs a rolling hourly ceiling enforced at reservation time.

### 4.2 WhatsApp

> **Connect accounts with old activity.** Avoid brand new accounts used exclusively for software. Fresh accounts can be blocked after only **2–3 new chats**. Warm up over several days with a few active, real conversations before outreach.
>
> **Wait after connecting or reconnecting.** WhatsApp may treat a new session that immediately starts outreach as suspicious. Wait **up to 24 hours** after connecting, reconnecting, or disconnecting/reconnecting before creating new chats or starting outreach.
>
> **Engage users in discussion.** The first message should prompt a response.
>
> **Respect delay between messages.** Never shorter than **10–20 seconds**.
>
> **Number of new chat creations is monitored.** Too many new chats without replies, or spam/block signals, may temporarily restrict the account. Keep new chats low, prioritise people likely to reply, avoid aggressive outbound.

There is no published daily number. Absence of a stated cap is not permission; it means the signal WhatsApp watches is qualitative — reply rate and block rate on chats you started. We therefore meter WhatsApp on **new chats created** and gate it on **reply rate**, not on a fixed volume (§7.4).

### 4.3 Comparison to LinkedIn's ceilings

| | LinkedIn | Instagram | WhatsApp |
|---|---|---|---|
| Documented daily ceiling | 80–100 invites, ~100 other actions | 100 actions | none stated |
| Hourly ceiling | none stated | **10 actions** | none stated (10–20s min gap) |
| Post-connect wait | none stated | none stated | **up to 24h** |
| New-account fragility | <150 connections → verification delays | "begin with lower activity" | **blocked after 2–3 chats** |
| Safe unlimited action | replying to inbound | replying to inbound | replying to inbound |

The pattern holds across all three: **replying to someone who wrote to you is always safe.** That is the strategic argument for the consent model.

---

## 5. Channel model and abstraction

### 5.1 Channel capability descriptor

Rather than branching on `provider` throughout the codebase, each channel registers a descriptor. The engine reads capabilities; it never hardcodes provider names outside the adapter.

```ts
type ChannelCapabilities = {
  provider: 'LINKEDIN' | 'INSTAGRAM' | 'WHATSAPP' | 'GMAIL' | 'OUTLOOK';
  identifier_kind: 'slug' | 'handle' | 'phone_e164' | 'email';
  has_connection_graph: boolean;      // LI true, IG false (follow ≠ permission), WA false
  connection_is_permission: boolean;  // LI true — acceptance grants messaging
  acceptance_webhook: boolean;        // LI only
  can_validate_identifier: boolean;   // WA only ("is number on?")
  supports: {
    invite: boolean; inmail: boolean; follow: boolean;
    post_react: boolean; post_comment: boolean; profile_view: boolean;
    voice_note: boolean; attachment: boolean; embed_video: boolean;
    search_people: 'full' | 'partial' | 'none';
  };
  ledger: {
    daily_ceiling: Record<ActionType, number>;
    hourly_ceiling?: Record<ActionType, number>;   // IG: 10 across all metered actions
    min_gap_seconds: [number, number];             // WA: [10, 20] floor
    post_connect_quiet_hours: number;              // WA: 24, LI: 0, IG: 0
  };
  consent: {
    required_for_first_contact: boolean;           // WA true
    accepted_bases: ConsentBasis[];
  };
};
```

Registered descriptors live in `channel_capabilities` (seeded table, service-role writable only) so the UI, the planner, the MCP and the sequence validator all read one source of truth.

### 5.2 Action type additions

Extend `action_type_t`:
```sql
alter type action_type_t add value 'follow';
alter type action_type_t add value 'unfollow';
alter type action_type_t add value 'new_chat';        -- WA/IG: creating a conversation that did not exist
alter type action_type_t add value 'identifier_check'; -- WA: is-number-on
alter type action_type_t add value 'followers_poll';   -- IG: list followers page
alter type action_type_t add value 'story_react';      -- IG, v2
```
`message` continues to mean "message into an existing chat." **`new_chat` is a distinct, separately metered action type on every channel** — on LinkedIn it was implicit in `message`; it now becomes explicit there too, which improves LinkedIn metering as a side effect.

---

## 6. Consent model (WhatsApp gate)

### 6.1 Why this exists

WhatsApp's own Business Messaging Policy prohibits unsolicited messaging. Unipile's integration is a session-based connection to a personal or Business app account, outside Meta's partner programme, so nothing in the transport enforces consent. Meanwhile the legal exposure is real and jurisdictional:

- **India (DPDP Act 2023)** — Aarushi's home jurisdiction and likely a large share of WhatsApp volume. Notice-and-consent obligations for processing personal data; phone numbers qualify.
- **EU (GDPR + ePrivacy)** — electronic direct marketing to individuals generally requires prior opt-in; the "soft opt-in" for existing customers is narrow.
- **US (TCPA)** — courts have treated app-based messaging inconsistently, but the safest reading treats prior express consent as required for marketing to mobile numbers. Statutory damages are per-message.
- **WhatsApp itself** — the practical enforcement is instant: blocks and reports lead to restriction regardless of legality.

Building an unconstrained WhatsApp blaster would work, would sell, and would produce banned client numbers and a legal question we do not want to answer. So:

### 6.2 The rule

**A WhatsApp `new_chat` action requires a recorded consent basis for that lead, on that workspace, before it can be planned.** No basis, no action — enforced in the planner and re-checked at execution, and backed by a database constraint.

### 6.3 Consent bases

```sql
create type consent_basis_t as enum (
  'inbound',            -- they messaged us first (on any channel)
  'form_optin',         -- opted in on a form; evidence URL + timestamp required
  'existing_customer',  -- prior commercial relationship; evidence required
  'linkedin_reply',     -- replied to us on LinkedIn and shared/accepted contact
  'explicit_share',     -- gave their number in a conversation we hold
  'imported_attested'   -- operator attests consent at import; attestation recorded
);

create table lead_consent (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  channel       provider_t not null,
  basis         consent_basis_t not null,
  evidence      jsonb not null default '{}',   -- {url, form_id, message_id, chat_id, imported_from, attested_by}
  attested_by   uuid references auth.users(id),
  obtained_at   timestamptz not null,
  expires_at    timestamptz,                   -- optional; some bases age out
  revoked_at    timestamptz,
  revoked_reason text,
  created_at    timestamptz not null default now()
);
create unique index lead_consent_active on lead_consent(lead_id, channel)
  where revoked_at is null;
create index on lead_consent(workspace_id, channel, basis);
```

`imported_attested` exists because operators will import lists regardless, and an attestation that names a user and a timestamp is materially better than a silent bypass. It is recorded in `audit_log`, shown in the client-facing consent report, and **flagged amber in the UI** — it is the weakest basis and the reports say so.

### 6.4 Automatic consent capture
- Any inbound WhatsApp message creates `basis='inbound'` automatically.
- A LinkedIn reply that contains a phone number, where the operator adds that number to the lead, offers one-click `basis='explicit_share'` with the message id as evidence.
- Revocation: any inbound message matching a stop-intent pattern (multi-language list, plus the classifier's `not_interested` with high confidence) sets `revoked_at`, adds a suppression row, and exits every active enrollment on that channel. Irreversible without a new basis.

### 6.5 What consent does *not* gate
Replies into an existing chat. If someone wrote to you, answering is always permitted and always safe. The gate is specifically on **creating a conversation that did not exist**.

### 6.6 Instagram: advisory, not gated
Instagram DMs to non-followers land in the Requests tab and carry lower harm and lower legal exposure than a phone notification. Consent is **recorded where known and displayed**, but does not block. Instead, Instagram is gated by the engagement ladder (§9.2) — which is a better product answer anyway, because a DM after a follow and a comment converts several times better than a cold one.

---

## 7. Safety engine changes

### 7.1 Hourly ledger (new)

The existing `sender_budgets` is per-day. Instagram needs per-hour. Rather than special-casing, add a generic hourly table used by any channel whose descriptor declares `hourly_ceiling`.

```sql
create table sender_budgets_hourly (
  sender_id   uuid not null references senders(id) on delete cascade,
  hour_start  timestamptz not null,        -- truncated to hour, sender-local
  scope       text not null,               -- 'all_metered' for IG, or a specific action_type
  cap         int not null,
  used        int not null default 0,
  reserved    int not null default 0,
  primary key (sender_id, hour_start, scope),
  check (used + reserved <= cap)
);
```

Instagram registers `scope='all_metered'` with `cap=10`, covering `follow`, `unfollow`, `new_chat`, `message`, `like`, `comment`, `profile_view`, `followers_poll` — because Instagram's documented limit is on *actions*, not per action type. Replies to inbound (`reply`) are excluded, per the documented "you can reply to all of them safely."

`private.reserve_budget` gains an hourly arm, reserving both rows in one statement so a failure on either releases the other:

```sql
create or replace function private.reserve_budget(
  p_sender uuid, p_day date, p_type action_type_t, p_at timestamptz
) returns boolean language plpgsql as $$
declare ok_day boolean; ok_hour boolean; v_scope text; v_hour timestamptz;
begin
  update sender_budgets set reserved = reserved + 1
   where sender_id=p_sender and day=p_day and action_type=p_type and used + reserved < cap
   returning true into ok_day;
  if not coalesce(ok_day,false) then return false; end if;

  select scope into v_scope from private.hourly_scope_for(p_sender, p_type);
  if v_scope is null then return true; end if;              -- channel has no hourly ceiling

  v_hour := date_trunc('hour', p_at);
  update sender_budgets_hourly set reserved = reserved + 1
   where sender_id=p_sender and hour_start=v_hour and scope=v_scope and used + reserved < cap
   returning true into ok_hour;

  if not coalesce(ok_hour,false) then
    update sender_budgets set reserved = reserved - 1
     where sender_id=p_sender and day=p_day and action_type=p_type;   -- release
    return false;
  end if;
  return true;
end $$;
```

Planner change: for channels with an hourly ceiling, slot allocation becomes **per-hour bucketed** — at most `cap` slots per working hour, distributed inside the hour with the min-gap rule, rather than a free distribution across the day. For Instagram at 10/hour across an 8-hour window that is a hard 80/day ceiling before the 100/day cap even binds, which is the correct conservatism.

### 7.2 Minimum gap enforcement

LinkedIn's min gap was a planner-time nicety. WhatsApp's 10–20 second floor is documented, so it becomes an **execution-time** check: `worker-tick` refuses to execute an action on a sender whose last executed action was less than `min_gap_seconds[0]` ago, and re-queues it. Per-sender serial execution (already the case) makes this cheap.

### 7.3 Post-connect quiet period

New sender column:
```sql
alter table senders add column outreach_allowed_from timestamptz;
```
Set on every transition into `ok` from `connecting`/`credentials` to `now() + descriptor.post_connect_quiet_hours`. WhatsApp: 24h. The planner will not schedule `new_chat` or `message` before it; replies are unaffected. The sender card shows a countdown with the reason, because otherwise support will be asked why a freshly connected WhatsApp does nothing all day.

### 7.4 WhatsApp new-chat governor

WhatsApp's monitored metric is new chats without replies. So rather than a fixed daily cap, the governor is a **rolling reply-rate gate**:

| Warmup level | New chats/day | Promotion condition |
|---|---|---|
| 0 (default on connect) | 2 | 7 days connected **and** ≥5 inbound conversations from real activity **and** account age attested >6 months |
| 1 | 5 | 14-day reply rate ≥ 40% over ≥10 new chats |
| 2 | 10 | reply rate ≥ 40% over ≥25 new chats |
| 3 | 20 | reply rate ≥ 45% over ≥50 new chats |
| 4 | 35 | reply rate ≥ 50%, zero blocks detected in 30d |

**Demotion is immediate and one level per trigger:** 14-day reply rate below 25%, any detected block, or a `credentials` disconnect within 24h of outreach. Demotion below level 1 requires a fresh warmup period.

Level 0 allowing 2 new chats/day is deliberate — Unipile documents fresh accounts being blocked after 2–3 new chats. A sender that cannot demonstrate history does not get to send a third.

`identifier_check` runs before every `new_chat`: if the number is not on WhatsApp, the action is skipped and the lead flagged, **without consuming the new-chat budget**. This is the single highest-value optimisation in the channel, since a failed chat creation to a dead number is pure risk for zero return.

### 7.5 Instagram automation warning

Unipile reports the "We suspect automated behavior" notice is survivable. We handle it as a signal rather than ignoring it:
- Detected via account status payload or a profile-fetch anomaly → `sender_events(kind='provider_warning')`.
- Sender drops one warmup level and `paused_until = +48h`.
- Operator sees the warning text verbatim, our interpretation, and a "resume anyway" action requiring confirmation.

Rationale: Unipile's observation is about *their* aggregate, not this client's account. The cost of a 48-hour pause is hours; the cost of a permanently disabled Instagram belonging to a client is the account and the relationship.

### 7.6 Warmup tables per channel

`warmup_caps` gains a `provider` column (existing rows backfilled to `LINKEDIN`).

**Instagram** (`per_day`, with hourly `all_metered` = 10 at every level; levels differ in daily allowance and which actions are unlocked):

| Level | Total actions/day | new_chat | follow | like | comment | profile_view |
|---|---|---|---|---|---|---|
| 0 | 15 | 0 | 5 | 8 | 0 | 10 |
| 1 | 30 | 3 | 10 | 15 | 3 | 20 |
| 2 | 50 | 8 | 15 | 25 | 6 | 30 |
| 3 | 70 | 15 | 20 | 30 | 10 | 40 |
| 4 | 85 | 20 | 25 | 35 | 12 | 50 |
| 5 | 100 | 25 | 30 | 40 | 15 | 60 |

Level 0 cannot DM at all — it can only follow, like and view, which is exactly the warmup Unipile describes. The total-actions cap is enforced as its own daily `all_metered` scope, so per-type caps cannot sum past it.

**WhatsApp**: `new_chat` per §7.4; `message` (into existing chats) 100/day at all levels; `reply` uncapped; `identifier_check` 50/day.

### 7.7 Health score additions

Two new categories, min-semantics preserved:
- `block_signals` (WhatsApp, Instagram): detected blocks, failed sends to previously-valid identifiers, chats going one-way after a single message. 0 blocks → 100; each detected block −30.
- `new_chat_reply_rate` (WhatsApp only): the governor input, surfaced as a health category so it appears in reports and drives the existing pause thresholds.

---

## 8. Identity resolution

One human, three identities. Get this wrong and the platform double-contacts people across channels, which is the fastest way to earn blocks.

### 8.1 Schema

```sql
create table lead_identities (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  lead_id      uuid not null references leads(id) on delete cascade,
  provider     provider_t not null,
  identifier   citext not null,              -- slug | handle | E.164 | email
  provider_id  text,                         -- resolved internal id
  verified     boolean not null default false,
  source       text,                         -- import|inbound|profile_fetch|operator|enrichment
  is_valid     boolean,                      -- WA: result of identifier_check
  last_checked_at timestamptz,
  created_at   timestamptz not null default now()
);
create unique index lead_identities_unique on lead_identities(workspace_id, provider, identifier);
create index on lead_identities(lead_id);
```

`leads.public_identifier` is retained for LinkedIn (and backfilled into `lead_identities`) to avoid a breaking migration; new code reads `lead_identities`.

### 8.2 Matching rules
- **Phone numbers** normalised to E.164 at write time; a bare 10-digit Indian number without a country code is rejected rather than guessed.
- **Instagram handles** lowercased, `@` stripped.
- Merging two leads merges identities; conflicting identities on the same provider block the merge and surface a review task.
- **No cross-channel inference.** A LinkedIn profile that lists an Instagram handle in its bio creates an *unverified* identity, usable for enrichment display but **never** for an outreach action until an operator confirms or an inbound message verifies it. Messaging the wrong person on WhatsApp because a bio string was parsed is a category of error we decline to introduce.

### 8.3 Cross-channel suppression
`lead_sender_state` becomes per-identity. A new view enforces the global rule: **a lead who replied, was suppressed, or said stop on any channel is suppressed on all channels.** Implemented as a trigger extension on the existing reply-exit trigger — reply on Instagram exits WhatsApp and LinkedIn enrollments too, unless the sequence explicitly opts into channel-independent continuation (off by default, and the validator warns when enabled).

---

## 9. Sequence engine changes

### 9.1 Channel-aware nodes

Existing nodes gain a `channel` field where ambiguous. New and changed node types:

| Node | Channels | Config | Notes |
|---|---|---|---|
| `send_message` | all | + `channel`, `new_chat_allowed: bool` | if no chat exists and `new_chat_allowed`, consumes `new_chat`; else skips to `no_chat` branch |
| `follow` / `unfollow` | IG, LI | — | IG: metered |
| `like_recent_posts` | IG, LI | `count: 1..3`, `max_age_days` | IG: each like is a metered action; count ≤3 enforced |
| `comment_post` | IG, LI | `text`, `ai?`, `max_age_days` | IG comments are public — QA blocks anything pitch-shaped |
| `wait_follow_back` | IG | `window_days`, `poll_budget: 1..3` | §9.3 |
| `check_identifier` | WA | — | is-number-on; branches `valid` / `invalid` |
| `require_consent` | WA | `bases[]` | branches `has_consent` / `no_consent`; **auto-inserted** by the compiler before any WA `new_chat` |
| `wait_for_reply` | all | `window_hours` | branches `replied` / `no_reply`; existing reply-stop still applies |
| `channel_switch` | all | `to_channel`, `require_identity: true` | moves the enrollment to another sender of that channel for the same lead |

### 9.2 Instagram engagement ladder (default template)

Shipped as the default Instagram sequence template, and the one onboarding steers to:

```
follow
  → delay 1d
  → like_recent_posts(count: 2)
  → delay 2d
  → wait_follow_back(window_days: 5, poll_budget: 2)
      ├ followed_back → send_message(new_chat_allowed: true)
      └ no_follow_back → comment_post  →  delay 3d  →  send_message(new_chat_allowed: true)
  → wait_for_reply(window_hours: 96)
      ├ replied → end (inbox takes over)
      └ no_reply → delay 5d → send_message → end
```

At level 2 (8 new chats/day, 10 actions/hour) this paces to roughly 40 leads in flight per sender. The projection tool must show that honestly — Instagram is a low-volume, high-touch channel and the UI should not let anyone believe otherwise.

### 9.3 `wait_follow_back` — polling without waste

No `new_relation` equivalent exists for Instagram. Options considered:

| Approach | Cost | Verdict |
|---|---|---|
| Poll `list followers` first page per lead | 1 metered action per check, per lead | Rejected — burns the 10/hour cap |
| Poll own followers list, diff against pending | 1–2 metered actions per sender per day, covers all pending leads at once | **Chosen** |
| Profile-fetch each lead to read relationship | 1 action per lead | Rejected |

Implementation: `followers_poll` runs 1–3 times/day per sender at random offsets, pages the sender's own followers list, and diffs against leads in `wait_follow_back`. Cost is per-sender, not per-lead. `poll_budget` on the node caps how many polls that sequence may request; the sender-level cap wins if several sequences compete.

Detection lag is therefore up to ~12 hours, the same class of problem as LinkedIn's 8-hour `new_relation` lag, and handled the same way: the `followed_back` branch schedules its first message at least 2 hours after detection, never instantly.

### 9.4 Cross-channel sequences

A sequence's `sender_pool` becomes `sender_pools: {channel: uuid[]}`. An enrollment gains `current_channel` and `channel_sender_map jsonb` recording which sender serves each channel for that lead.

`channel_switch` requires: a verified identity for the target channel, an available sender of that channel in the pool, consent where the channel demands it, and no active enrollment conflict. If any fails, it takes the `unavailable` branch rather than erroring — because a partially-reachable lead is the normal case, not an exception.

**Canonical cross-channel pattern** (and the one worth marketing):
```
LinkedIn: visit → invite → wait_connection
  connected → message → wait_for_reply
      replied → [inbox: human conversation; if they share a number, consent captured]
      no_reply → delay 7d → message → end
```
WhatsApp is reached **through** a LinkedIn reply that produced consent, never in parallel with it. That is both the compliant path and the one that actually works.

### 9.5 Validator additions

Blocking errors: WA `new_chat` without a reachable `require_consent` ancestor · IG `like_recent_posts` count >3 · node channel with no sender of that channel in the pool · WA node on a sender whose `outreach_allowed_from` is in the future at activation · IG sequence whose per-hour demand exceeds the hourly ceiling · `channel_switch` to a channel with no identity source in the sequence.

Warnings: IG DM as the first node (no ladder) · WA `new_chat` with basis `imported_attested` only · cross-channel sequence with channel-independent continuation enabled · IG comment text that reads as a pitch.

---

## 10. Inbox changes

- Channel filter and per-channel icons; one thread per chat, grouped under the lead so a human sees LinkedIn, Instagram and WhatsApp conversations with the same person in one place.
- **Voice notes** are first-class on WhatsApp and Instagram: playback inline, transcription via the existing audio pipeline, transcript indexed for search and fed to the classifier.
- Read receipts and reactions rendered (available on all three channels).
- WhatsApp chats show a **consent chip** — basis, date, evidence link, and a revoke control.
- Reply composer enforces channel-specific limits and disables `new_chat` when consent or budget is absent, with `why_not_sending` reasons inline.
- Instagram message requests (not yet accepted by the recipient) are visually distinct from accepted conversations — an unanswered request is not a delivered message and should not be read as one.

---

## 11. Platform changes by component

### 11.1 Database migrations
```
0042_channel_capabilities        seed table + descriptors for LI/IG/WA
0043_action_types                new enum values
0044_sender_budgets_hourly       + reserve_budget rewrite
0045_senders_outreach_window     outreach_allowed_from, provider on warmup_caps
0046_lead_identities             + backfill from leads.public_identifier
0047_lead_consent                + consent_basis_t + triggers
0048_lead_sender_state_identity  per-identity state, cross-channel suppression trigger
0049_sequences_channel_pools     sender_pools jsonb, enrollment.current_channel
0050_health_categories           block_signals, new_chat_reply_rate
```

### 11.2 Edge Functions

**New:** `worker-followers-poll` (F28, IG follow-back detection) · `worker-identifier-check` (F29, WA number validation batch) · `consent-capture` (F30, from inbound + operator actions) · `worker-block-detect` (F31, infers blocks from send failures and one-way chats).

**Changed:**
- `worker-tick` — min-gap enforcement, hourly reservation, channel adapter dispatch, `new_chat` vs `message` distinction.
- `worker-planner` — per-hour bucketing for hourly-capped channels; skips senders inside `outreach_allowed_from`; consults `lead_consent` before planning WA `new_chat`.
- `worker-health` — two new categories, WhatsApp governor promotion/demotion.
- `process-inbound` — per-channel payload handling; auto consent capture on inbound; voice-note transcription enqueue; Instagram request-vs-accepted distinction.
- `unipile-webhook` — unchanged (already source-agnostic).

### 11.3 Unipile client
Adapter per channel implementing `execute(action) → Result`, with the existing error-mapping table extended for channel-specific codes. WhatsApp and Instagram share most chat/message routes, so the adapters are thin — the divergence is in which actions exist and how they are metered, which lives in the descriptor, not in code.

### 11.4 MCP additions
New tools: `consent_list`, `consent_grant` (**confirmation-gated**, records attesting user), `consent_revoke`, `identity_list`, `identity_add` (unverified by default), `channel_capacity` (per-channel remaining today and this hour).

Changed: `senders_list` and `sender_budgets` return channel and hourly remaining · `enroll_preview` reports per-channel exclusions including "no consent" and "no identity" · `inbox_list` filters by channel · `why_not_sending` gains causes `E_NO_CONSENT`, `E_HOURLY_CAP`, `E_QUIET_PERIOD`, `E_IDENTIFIER_INVALID`, `E_MIN_GAP`.

**`consent_grant` is never available to `unattended` tokens.** An agent may not attest to a human's consent.

---

## 12. Reporting

Per-channel funnels, plus three additions that exist because these channels demand them:
- **Consent report** per client: leads contacted on WhatsApp by basis, with evidence links. Exportable — this is the artefact produced if a client's number is challenged.
- **Block and restriction log** per sender, with the action sequence preceding each event. This is how the governor's thresholds get tuned with real data rather than guesses.
- **Channel efficiency**: replies per 100 actions by channel, so operators can see what the numbers above imply — Instagram and WhatsApp are lower-volume and higher-conversion than LinkedIn, and the correct response to a low ceiling is better targeting, not more senders.

---

## 13. Rollout

| Phase | Weeks | Contents |
|---|---|---|
| **P0 — Foundations** | 1–2 | Channel descriptors, action types, hourly ledger + `reserve_budget` rewrite, `lead_identities` + backfill, adapter interface. No user-visible change; LinkedIn regression suite must stay green. |
| **P1 — Instagram read** | 3 | Connect IG senders, inbox, history sync, profile fetch. No outbound. Validates payloads and identity matching with zero risk. |
| **P2 — Instagram outbound** | 4–5 | Ladder nodes, `wait_follow_back` + followers poll, warmup table, provider-warning handling, validator rules. Internal senders only. |
| **P3 — WhatsApp read + consent** | 6–7 | QR connect, quiet period, inbox with voice notes, consent ledger and capture, revocation. Replies only — no new chats. |
| **P4 — WhatsApp outbound** | 8–9 | `identifier_check`, `require_consent`, new-chat governor, block detection. Level 0–1 only, internal numbers. |
| **P5 — Cross-channel** | 10–11 | `channel_switch`, channel pools, cross-channel suppression, canonical template. |
| **P6 — MCP + reporting + beta** | 12–13 | MCP tools, consent and block reports, 5 design-partner workspaces. |

**P3 before P4 is not negotiable.** Shipping WhatsApp receive-and-reply first gives real conversations, real consent records and real reply-rate data before the first cold chat is created — which is precisely the warmup Unipile prescribes, performed by the product rather than asked of the user.

---

## 14. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Client's personal WhatsApp number banned | Medium | **Severe** — it's their actual phone number, often their business line | Level 0 = 2 chats/day; 24h quiet period; consent gate; identifier check; reply-rate governor; onboarding refuses numbers under 6 months attested age |
| Instagram account of a client disabled | Medium | High | Ladder default, hourly ledger, warning → 48h pause, no DM at level 0 |
| Operator bypasses consent with blanket `imported_attested` | **High** | High (legal) | Attestation names a user; amber in UI; consent report exposes the mix; per-workspace cap on the share of WA sends from that basis, alerting above 30% |
| Cross-channel double-contact | Medium | Medium | Global suppression on reply; verified-identity requirement; no bio-parsed identifiers |
| Hourly ledger regresses LinkedIn throughput | Low | Medium | Hourly scope only registered for channels declaring it; LinkedIn descriptor omits it; regression suite asserts LinkedIn daily volumes unchanged |
| WhatsApp transport disrupted by Meta | Medium | High | Consent-first positioning means the channel is a conversation tool, not a volume tool — losing it hurts less than losing LinkedIn; adapter interface allows swapping to Cloud API for the template-messaging subset |
| Unipile changes IG/WA limits | Medium | Low | Descriptors are seeded data, not code; a limit change is a migration, not a release |

---

## 15. Open questions

1. **WhatsApp account-age attestation.** Level 0 promotion requires attesting the number is >6 months old with real history. Is there a programmatic signal, or is operator attestation the only option? Check whether `GET users/me` exposes anything on WhatsApp.
2. **Block detection fidelity.** Does Unipile surface a distinct error when a WhatsApp recipient has blocked the sender, or must it be inferred from send failure plus one-way chat? Determines whether §7.4 demotion is reliable or heuristic. Ask on the integration call.
3. **Instagram hourly cap scope.** Unipile says "100 actions per day and no more than 10 per hour" — confirm whether that 10 is across all action types (our assumption, conservative) or per type.
4. **Instagram search maturity.** The feature matrix marks people and post search 🟠. Establish what partial means before promising IG prospecting by search rather than by imported handles.
5. **Consent expiry.** Should `form_optin` and `existing_customer` age out at 12 or 24 months? Legal input needed; DPDP and GDPR guidance differ.
6. **Voice notes as outbound.** Available on both channels and dramatically higher-converting anecdotally. Deferred — an AI-generated voice note in someone's WhatsApp is a product decision with its own ethics discussion, not a feature to slip into a node config.
