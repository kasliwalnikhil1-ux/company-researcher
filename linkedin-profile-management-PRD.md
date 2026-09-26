# PRD: Profile Studio — LinkedIn Profile Management

**Document:** Product Requirements Document — sender profile editing, experiments and governance
**Version:** 1.0 · 25 September 2026
**Builds on:** `linkedin-outreach-platform-PRD.md` (platform), `outreach-mcp-PRD.md` (MCP), `instagram-whatsapp-channels-PRD.md` (multi-channel). All assumed shipped.
**Component:** `profile-studio` — a feature area inside the platform, not a separate service.
**Sources:** Unipile API reference — Edit own profile (`PATCH /api/v1/users/me/edit`), Retrieve own profile (`GET /api/v1/users/me`), Retrieve a profile (`GET /api/v1/users/{identifier}`), provider limits page (28 Aug 2026).

---

## 1. The answer, and the constraint that shapes everything

**Yes.** Unipile exposes a substantial profile write surface on LinkedIn — considerably more than photo and headline.

### 1.1 What can be written

`PATCH /api/v1/users/me/edit`, `multipart/form-data`, requires `account_id` and `type: LINKEDIN`. Returns `{"object": "ProfileEdited"}`.

| Group | Fields |
|---|---|
| **Identity** | `headline` · `summary` (the About section) · `picture` (binary) · `cover_picture` (binary) |
| **Photo treatment** | `picture_settings[filter]` — ORIGINAL, STUDIO, SPOTLIGHT, PRIME, CLASSIC, EDGE, LUMINATE · `[layout][topLeft|topRight|bottomLeft|bottomRight][x|y]` crop coordinates · `[contrast]` `[brightness]` `[saturation]` `[vignette]` · same structure under `cover_picture_settings` |
| **Location** | `location[id]` (a LinkedIn ID, resolved via the search-parameters endpoint) · `location[postal_code]` |
| **Experience** | `experience[id]` to edit an existing entry, or `[role]` + `[company]` to create one · `[company_id]` · `[employment_type]` · `[location]` · `[presence]` ON_SITE/HYBRID/REMOTE · **`[description]`** · `[source_of_hire]` · `[seniority[start_date[month|year]]]`, `[end_date[…]]` · `[skills]` (repeated key) · `[attachment[type|title|description|url|file|thumbnail]]` for link or media |
| **Education** | `[id]` or `[school]` · `[degree]` · `[field_of_study]` · `[grade]` · `[activities]` · `[description]` · start/end dates · `[skills]` · attachments |
| **Skills** | `skills[]` (repeated) · `skills_follow` |
| **Open to work** | `open_to_work[job_title[name|id]]` · `[presence][]` · `[location[on_site]][]` · `[location[remote]][]` · `[employment_type][]` · `[start_date]` IMMEDIATELY/FLEXIBLE · `[visibility]` ALL / RECRUITERS_ONLY |
| **Custom link** | `custom_link[type]` STORE/WEBSITE/PORTFOLIO/BLOG/NEWSLETTER · `[url]` · `[display_on]` PROFILE_ONLY / EVERYWHERE |
| **Broadcast** | `experience[notify_network]`, `education[notify_network]` — booleans that push the change to the sender's network as an update |

So: photo, headline, About and job description are all editable, plus rather more.

### 1.2 The constraint: you can write more than you can read

This is the finding that determines the architecture.

| Read path | Returns |
|---|---|
| `GET /users/me` (own profile) | **Thin.** provider ids, first/last name, `profile_picture_url`, `public_profile_url`, `public_identifier`, `headline`, `location`, `email`, premium flag, open-profile flag, `occupation`, `organizations[]`, recruiter/sales-nav details. **No About text. No experience descriptions. No education. No skills. No open-to-work config. No custom link. No photo settings.** |
| `GET /users/{identifier}` with `linkedin_sections=*` | **Rich.** summary (About), experience with descriptions/skills/dates, education, skills with endorsement counts, languages, certifications, projects, recommendations, contact info, websites. Doc warns: *"LinkedIn may throttle heavy use of full data section requests"* — selective sections recommended. |

Consequences, all load-bearing:

1. **Rollback cannot rely on reading current state.** The rich read is the only way to capture a true "before", it costs a metered profile action, and LinkedIn throttles it. So the platform maintains its **own snapshot ledger** and restores from what it recorded — not from what it can fetch on demand.
2. **There is no read-back for several writable fields at all** — `picture_settings`, `cover_picture_settings`, `open_to_work` config, `custom_link`, `skills_follow`. For these, *our last written value is the only record that exists.* If a human changes them in the LinkedIn UI, we will never know. Rollback of those fields is best-effort and must say so in the UI rather than implying fidelity it cannot deliver.
3. **Drift detection is expensive**, so it is scheduled and cheap-by-default: weekly, selective sections, never a `*` fetch on a cadence.

### 1.3 What is not writable
Name (first/last), pronouns, the public URL slug, recommendations, certifications, projects, languages, volunteering, endorsements received, and Creator-mode settings. Certifications/projects/languages are readable but not writable — the UI must present them read-only rather than as greyed-out inputs that imply a coming feature.

---

## 2. Why this belongs in the product

Not because profile editing is a feature people ask for. Because **the platform already measures the thing the profile drives.**

The health score tracks `acceptance_rate` per sender over a rolling 14 days. Acceptance is a function of three things: who you target, what the invite note says, and **what the prospect sees when they click the profile**. The platform optimises the first two and is blind to the third. A sender with a default-grey photo and a headline reading "Business Development at Acme" is losing acceptances no copy change recovers.

That gives Profile Studio a defensible shape no competitor has:

1. **Profile experiments.** Split a sender cohort, run two headlines, measure the acceptance-rate delta with real statistics against data the platform already collects. GetSales has no A/B report at all — their own FAQ says variant comparison is done by eye, node by node.
2. **Brand alignment at scale.** An agency onboarding a client with twelve sender profiles needs all twelve to corroborate one offer. Doing that by hand across twelve people's LinkedIn accounts is a half-day of nagging.
3. **Campaign-matched profiles.** When a sender switches to a new offer, the About section and banner should follow. Today that is a Slack message to a colleague.
4. **Profile hygiene.** Missing banner, no About, one-line headline, no custom link — each is a measurable drag on acceptance and a fixable one.

And one thing it must be prevented from becoming: a tool for fabricating professional histories at scale. §4 is that boundary.

---

## 3. Scope

### 3.1 In scope (v1)
Editing headline, About, profile photo + settings, cover photo + settings, location, experience entries (including description), education entries, skills, custom link — for LinkedIn senders. Templates with variables. Bulk apply across a cohort. Snapshot, diff, rollback. Profile QA scoring. Profile experiments with acceptance-rate readout. Field-level authority grants from the sender owner. MCP tools. WhatsApp (`headline`, `summary`, `picture`) and Instagram (`summary` ≤150 chars, `picture`) get the same pipeline on a reduced field set.

### 3.2 Out of scope
- **`open_to_work` is not exposed in v1** (§5.4). It is writable; we decline to write it.
- Fabricating experience at companies the sender never worked at — blocked by policy, not by capability (§4.4).
- Creator mode, featured section, recommendations, certifications, projects — not writable.
- Auto-applying AI-written profile copy without human approval. Never, in any version.
- Profile editing for leads. The endpoint is `users/me`; it edits the connected account only. Worth stating because it is the first thing someone asks.

---

## 4. Authority model

### 4.1 The problem

Sending a message on someone's behalf is delegated activity. **Rewriting their headline, About section and job history is editing their professional identity** — the artefact recruiters, peers and future employers read. The two require different permission, and folding the second into the first is the mistake to avoid.

A sender profile frequently belongs to a client's employee, not to the operator. The employee consented to outreach automation during hosted auth. They did not consent to an agency rewriting their About section.

### 4.2 Profile authority grants

Separate from outreach authorisation. Granted by the **sender owner** through a signed link, per field group, with an expiry.

```sql
create type profile_field_group_t as enum (
  'headline','about','photo','cover','location',
  'experience','education','skills','custom_link'
);

create table profile_authority (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  sender_id     uuid not null references senders(id) on delete cascade,
  field_group   profile_field_group_t not null,
  mode          text not null check (mode in ('propose_only','direct')),
  granted_by_email citext not null,          -- the owner, who may not be a platform user
  granted_via   text not null,               -- 'signed_link' | 'owner_is_operator'
  evidence      jsonb not null default '{}', -- {token_id, ip, user_agent, signed_at}
  granted_at    timestamptz not null,
  expires_at    timestamptz,
  revoked_at    timestamptz,
  revoked_reason text,
  unique (sender_id, field_group) where revoked_at is null
);
```

- **`propose_only`** (default): the platform drafts the change; the owner receives it and applies it with one click. Nothing reaches LinkedIn without the owner's action.
- **`direct`**: the operator may apply changes to that field group without per-change approval. Still notified after every change (§4.3).

When the sender owner *is* the operator — the common case for a company running its own team, and for Kaptured's own use — the grant records `owner_is_operator` and both modes are available immediately.

**No authority, no write.** Enforced in the planner, re-checked at execution, and backed by a unique partial index plus a `CHECK` in the action-creation function. Same architecture as the WhatsApp consent gate, for the same reason: a database invariant is the only kind that survives a bug.

### 4.3 Owner notification — always, non-optional

Every applied profile change emails the sender owner within 60 seconds: a field-by-field diff, before and after, who made it, and a one-click **Revert** link valid for 30 days that requires no login. Not configurable, not suppressible, not batched. An agency that does not want its client's employee to see profile changes is describing a use case we decline.

### 4.4 Prohibited edits

Blocked by the validator, regardless of authority:

- Creating an `experience` entry at a company with `notify_network: true` — the broadcast is never automated (§5.3).
- Setting `experience[role]`/`[company]` to a position the platform has no record of the owner confirming, in **bulk** (>1 sender in one operation). Fabricating one person's job title is the operator's business; fabricating twelve is manufacturing a sales team that does not exist.
- Any edit to a sender flagged `identity_unverified` (a profile the workspace did not connect through a live owner-authenticated hosted-auth session).
- `open_to_work` — not exposed (§5.4).

---

## 5. Safety

### 5.1 Profile edits are an account-risk signal

LinkedIn treats rapid identity changes as a takeover indicator. Photo and name changes are the strongest. Nothing in Unipile's limits page addresses profile editing, which means there is no published ceiling — and per the reasoning applied to WhatsApp, **absence of a stated limit is not permission**. We set conservative ceilings ourselves.

New action type:
```sql
alter type action_type_t add value 'profile_edit';
```

Ceilings in `platform_ceilings`, per sender:

| Field group | Max frequency | Rationale |
|---|---|---|
| `photo` | 1 per 30 days | Strongest takeover signal |
| `cover` | 2 per 30 days | Visual, low semantic weight |
| `headline` | 2 per 7 days | The main experiment lever; needs room to test |
| `about` | 2 per 7 days | |
| `experience` (edit description) | 3 per 7 days | |
| `experience` (new entry) | 1 per 30 days | A person does not change jobs weekly |
| `education` | 1 per 30 days | |
| `location` | 1 per 90 days | People do not relocate quarterly |
| `skills` | 2 per 7 days | |
| `custom_link` | 2 per 7 days | |
| **All groups combined** | **4 per 7 days, 1 per day** | Prevents a full-profile rewrite in one sitting |

A profile edit consumes one `profile_edit` action from the daily ledger, so it competes with outreach volume — correctly, since both are account activity.

### 5.2 Warmup and quiet periods
- **Warmup level 0 senders cannot be edited at all.** A freshly connected account whose photo and headline change within days is the exact shape of a compromised account.
- `outreach_allowed_from` (from the multi-channel PRD) gates profile edits too: no edits within 72 hours of connection or reconnection — longer than the outreach quiet period, because profile changes shortly after a new session login is the specific pattern LinkedIn watches for.
- A sender in `credentials` or `paused` status accepts no profile writes.

### 5.3 `notify_network` is always false

`experience[notify_network]` and `education[notify_network]` broadcast a "started a new position" update to the sender's entire network. The platform **hardcodes both to `false`** and does not expose them. There is no toggle.

Reasons, in order: an automated job-change announcement to a real person's professional network is a social act with consequences we cannot model; it generates congratulation replies the sender did not ask for; and an agency triggering it across twelve client profiles is a visible, embarrassing failure mode. If a sender genuinely changed jobs, they can announce it themselves.

### 5.4 `open_to_work` is not exposed

Writable, deliberately omitted. Three reasons:

1. **It is commercially self-defeating.** A prospect who clicks through an outreach invite and sees an Open To Work banner discounts everything the message said.
2. **It leaks something personal.** Whether someone is job-hunting is theirs to disclose. An operator with `direct` authority could set it — or clear it — on an employee's profile. Clearing it is arguably worse than setting it.
3. **`visibility: RECRUITERS_ONLY` is not a safe middle ground** — it is still a disclosure to a population the person did not choose.

Revisit only if a recruiting customer presents a concrete case, and only ever in `propose_only` mode.

### 5.5 Rate-limit and error handling

Extends the existing `handleUnipileError` table:

| Response | Decision |
|---|---|
| `429` / `500` on `PATCH users/me/edit` | `retry(+random(2..6h))`; max 2 attempts, then fail the change and notify — never hammer an identity endpoint |
| `422` invalid `location[id]` / `job_title[id]` | `fail('E_PROFILE_ID_UNRESOLVED')` with the search-params lookup as remedy |
| `422` image rejected | `fail('E_PROFILE_IMAGE_REJECTED')` with dimension/format detail |
| `401` / account disconnected | `sender_credentials`; change stays pending, re-applied only after explicit re-confirmation (never silently on reconnect) |
| Partial success (some fields applied, some not) | §7.3 |

---

## 6. Data model

```sql
-- A recorded state of a profile at a point in time.
create table profile_snapshots (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  sender_id     uuid not null references senders(id) on delete cascade,
  kind          text not null check (kind in ('baseline','pre_change','post_change','drift_check')),
  sections      text[] not null,              -- which linkedin_sections were fetched
  fidelity      text not null check (fidelity in ('full','partial','written_only')),
  data          jsonb not null,               -- normalised profile document
  unwritten_fields text[] not null default '{}', -- fields we set but cannot read back
  captured_at   timestamptz not null default now(),
  captured_by   uuid references auth.users(id),
  action_id     uuid references actions(id)
);
create index on profile_snapshots(sender_id, captured_at desc);

-- A requested change, its lifecycle, and its result.
create table profile_changes (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references workspaces(id) on delete cascade,
  sender_id      uuid not null references senders(id) on delete cascade,
  field_groups   profile_field_group_t[] not null,
  payload        jsonb not null,              -- normalised: {headline, summary, experience:{...}}
  assets         jsonb not null default '{}', -- {picture: storage_path, cover_picture: storage_path}
  source         text not null,               -- 'manual'|'template'|'experiment'|'ai_draft'|'rollback'|'mcp'
  template_id    uuid references profile_templates(id),
  experiment_id  uuid references profile_experiments(id),
  status         text not null default 'draft'
                 check (status in ('draft','awaiting_owner','approved','queued','applied',
                                   'partially_applied','failed','cancelled','reverted')),
  pre_snapshot_id  uuid references profile_snapshots(id),
  post_snapshot_id uuid references profile_snapshots(id),
  applied_fields   text[] not null default '{}',
  failed_fields    jsonb not null default '{}',   -- {field: error_code}
  action_id      uuid references actions(id),
  requested_by   uuid references auth.users(id),
  approved_by_email citext,
  owner_notified_at timestamptz,
  revert_token   text unique,
  applied_at     timestamptz,
  reverted_at    timestamptz,
  created_at     timestamptz not null default now()
);
create index on profile_changes(sender_id, created_at desc);
create index on profile_changes(status) where status in ('awaiting_owner','queued');

create table profile_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  client_id    uuid references clients(id) on delete set null,
  name         text not null,
  field_groups profile_field_group_t[] not null,
  body         jsonb not null,               -- values with {{variables}}
  variables    jsonb not null default '{}',  -- declared variables + defaults
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now()
);

create table profile_experiments (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references workspaces(id) on delete cascade,
  name          text not null,
  field_group   profile_field_group_t not null,   -- v1: headline | about | photo
  variants      jsonb not null,                    -- [{key:'A', value:...}, {key:'B', value:...}]
  sender_ids    uuid[] not null,
  assignment    jsonb not null,                    -- {sender_id: variant_key}
  metric        text not null default 'acceptance_rate',
  washout_days  int not null default 3,
  min_invites_per_variant int not null default 120,
  status        text not null default 'draft'
                check (status in ('draft','washout','running','ready','concluded','abandoned')),
  started_at    timestamptz, washout_until timestamptz, concluded_at timestamptz,
  result        jsonb,                             -- rates, lift, CI, p, verdict
  created_by    uuid references auth.users(id)
);

create table profile_qa (
  sender_id     uuid primary key references senders(id) on delete cascade,
  score         smallint not null check (score between 0 and 100),
  checks        jsonb not null,                    -- [{code, severity, pass, detail, fix_hint}]
  computed_at   timestamptz not null default now()
);
```

RLS follows the platform pattern. `profile_authority` is readable by owner/manager, writable only by the grant flow (service role). `profile_changes` writes go through SQL functions, never direct PostgREST.

---

## 7. Applying a change

### 7.1 Pipeline

```
draft → validate → [awaiting_owner if propose_only] → approved → queued
      → pre-snapshot → PATCH → post-verify → applied → notify owner
```

1. **Validate** — field lengths, authority present and unrevoked, ceilings not exhausted, warmup level ≥1, sender `ok`, outside quiet period, prohibited-edit rules, image dimensions/format, resolved `location[id]`.
2. **Pre-snapshot** — `GET /users/{own public_identifier}` with **only the sections being changed** (`linkedin_sections=about,experience` etc.), never `*`. Consumes one `profile_view` action. Stored with `fidelity` marked, and `unwritten_fields` listing anything in the payload that has no read path.
3. **Apply** — one `PATCH`, multipart, from `worker-tick` under the `profile_edit` budget.
4. **Post-verify** — a second selective read, ≥60s later (LinkedIn propagation is not instant), diffed against the intent. Populates `applied_fields` / `failed_fields`.
5. **Notify** — owner email with the diff and revert link.

### 7.2 Rollback

`POST` a change whose `payload` is reconstructed from `pre_snapshot_id`, `source='rollback'`. It is an ordinary profile change: it consumes a `profile_edit` action, obeys ceilings, and is itself snapshotted.

**Rollback fidelity is declared in the UI, honestly, per field:**

| Field | Fidelity | Why |
|---|---|---|
| headline, About, experience description, education, skills, location | **Full** | Readable via rich profile fetch |
| photo, cover image | **Full if we uploaded it** (original retained in Storage); **partial otherwise** — we can restore the URL's image but not LinkedIn's internal crop state |
| `picture_settings`, `cover_picture_settings` | **Written-only** — restorable to our last written value; if edited in the LinkedIn UI since, that state is unrecoverable |
| `custom_link`, `skills_follow` | **Written-only**, same caveat |

The revert screen shows a per-field fidelity badge. A "Revert" button implying restoration it cannot deliver would be worse than no button.

### 7.3 Partial application

`PATCH` may apply some fields and reject others. Post-verify is the source of truth, not the HTTP status. Status becomes `partially_applied`, `failed_fields` records what did not land, and the owner email says so explicitly. The system does **not** auto-retry the failed subset — a second identity write within minutes is exactly the pattern we are avoiding. It surfaces the failure and lets a human decide.

### 7.4 The multipart serialiser

The endpoint takes `multipart/form-data` with bracket notation, and Unipile's own docs warn their interactive playground generates it incorrectly. This is a real implementation hazard: a silently wrong `experience[seniority[start_date[month]]]` writes garbage to a real person's work history.

`/packages/unipile/profile-serialiser.ts` owns this, with:
- a typed input model → form-data encoder handling nested brackets and repeated keys (`experience[skills]` once per value),
- golden-file tests covering every nested and array field in §1.1, asserting the exact encoded body,
- a strict mode that throws on any key not in the known field set, so a typo never becomes a silent no-op.

No other module constructs this payload.

---

## 8. Features

### 8.1 Profile Studio (editor)
Side-by-side editor with a live LinkedIn-accurate preview (desktop and mobile widths, since headlines truncate differently). Per-field: current value, proposed value, character count against LinkedIn's limits, authority status, ceiling remaining ("headline: 1 of 2 changes left this week"). Photo tools: upload, crop via `picture_settings[layout]`, filter picker with preview of all seven filters, brightness/contrast/saturation/vignette sliders. Everything unsaved until explicitly applied; nothing auto-saves to LinkedIn.

### 8.2 Templates and bulk apply
A template holds values with `{{variables}}` — `{{first_name}}`, `{{company}}`, `{{offer}}`, `{{custom.region}}`. Bulk apply to a cohort produces **one `profile_changes` row per sender**, each individually validated, authority-checked and ceiling-checked. The preview screen shows per-sender rendered output plus exclusions ("3 of 12 senders excluded: 2 lack About authority, 1 is in warmup"). Application is spread: at most one sender per hour, never more than 8 senders per day per workspace, because twelve profiles at one agency changing headline within an hour is a correlated pattern visible from LinkedIn's side.

### 8.3 Campaign-matched profiles
A sequence may reference a `profile_template_id`. On activation the platform checks whether pool senders match it and offers to apply — never applies automatically. On sequence pause/archive it offers to restore the prior profile. The link is advisory: sequences remain runnable with mismatched profiles, with a QA warning.

### 8.4 Profile QA score
Computed weekly and after every change, from the last snapshot. Checks, each with severity and a fix hint:

| Check | Severity |
|---|---|
| No custom profile photo (default avatar) | Critical |
| Headline is the bare default (`Role at Company`) | High |
| Headline under 40 chars, or over 200 (truncation) | Medium |
| About empty | High |
| About under 300 chars | Medium |
| About has no line breaks (wall of text) | Low |
| No cover image | Medium |
| Current experience has no description | Medium |
| Fewer than 5 skills | Low |
| No custom link | Low |
| Location unset | Medium |
| Connections under 150 | Critical (blocks warmup promotion; already enforced) |

The score is displayed beside the health score on the sender card and correlated against acceptance rate in reporting — which is how the checks get re-weighted with real evidence rather than opinion.

### 8.5 AI drafting
`ai_draft_profile(sender_id, field_group, brief)` proposes a headline or About section from the sender's existing profile, the client's positioning and the active offer. **Always lands in `profile_changes.status='draft'` for human editing.** Never auto-applied, never in `direct` mode, never available to unattended MCP tokens. Writing someone's professional self-description is not a task to hand to an unsupervised model.

---

## 9. Profile experiments

The differentiating feature, and the one that needs its statistics right.

### 9.1 Design

Randomisation is **at the sender level**, not the lead level — a profile has one state at a time, so the sender is the unit. That makes it a cluster-randomised design with few clusters, which has consequences the UI must not hide.

```
draft → assign variants → washout (N days) → running → ready → concluded
```

- **Washout** (default 3 days): invites sent before the change are still resolving — LinkedIn acceptances arrive over days, and the `new_relation` webhook adds up to 8 hours of lag. Invites sent during washout are excluded from both arms. Without this, the old profile's acceptances contaminate the new profile's numbers, which is the single most common way A/B tests in this category lie.
- **Running**: only invites sent after `washout_until` count. Acceptance attributed to the invite's send time, not the acceptance time.
- **Ready**: every variant has `min_invites_per_variant` (default 120) resolved invites, or a 14-day acceptance window has elapsed for the last invite.

### 9.2 Readout

Two-proportion comparison with a 95% confidence interval on the difference, plus the absolute rates and counts. Reported in plain language:

> Variant B accepted at 31.2% (78/250) against A's 24.8% (62/250). Difference +6.4 points, 95% CI −0.9 to +13.7. **Not conclusive** — the interval crosses zero. To detect a 6-point lift reliably you would need roughly 800 invites per variant.

Rules the report enforces:
- **Never declare a winner on a crossing interval.** No "B is trending ahead" framing.
- **Minimum 2 senders per variant.** With one sender per arm, the sender and the variant are perfectly confounded, and the report says so instead of producing a number.
- **Cluster warning** whenever senders per arm < 5: between-sender variance (their networks, their seniority, their existing connections) is likely larger than the effect, and the interval understates uncertainty.
- Concluding an experiment offers to apply the winner to the losing arm — as an ordinary bulk change, ceilings and authority included.

### 9.3 Guards
- A sender may be in one experiment at a time.
- Experiments block other changes to the tested field group for their duration.
- Sequence copy changes on participating senders during an experiment raise a contamination warning and are recorded in the result.
- Experiments on `photo` require 21 days minimum given the 1-per-30-day ceiling, and the UI states that up front.

---

## 10. Implementation

### 10.1 Migrations
```
0051_profile_action_type        profile_edit enum value + ceilings seed
0052_profile_authority          field groups, grants, signed-link tokens
0053_profile_snapshots          snapshots + fidelity
0054_profile_changes            changes, revert tokens, partial-apply fields
0055_profile_templates          templates + variables
0056_profile_experiments        experiments + assignment
0057_profile_qa                 qa scores
0058_profile_ceilings           per-field-group frequency limits table
```

### 10.2 Edge Functions

**New**
| Fn | Trigger | Purpose |
|---|---|---|
| `profile-snapshot` | called by pipeline + weekly cron | Selective section fetch, normalise, store |
| `profile-apply` | from `worker-tick` | Serialise multipart, `PATCH`, record |
| `profile-verify` | scheduled +60s after apply | Post-read, diff, set applied/failed fields |
| `profile-authority-link` | HTTP (manager) | Create signed grant link, email owner |
| `profile-authority-accept` | HTTP (owner, no login) | Record grant with evidence |
| `profile-revert` | HTTP (owner via token, or operator) | Build rollback change |
| `profile-notify-owner` | from pipeline | Diff email with revert link |
| `worker-profile-qa` | weekly cron | Recompute QA scores |
| `worker-profile-experiments` | daily cron | Advance washout→running→ready, compute readout |
| `worker-profile-drift` | weekly cron, staggered | Selective re-read, flag external edits |
| `ai-draft-profile` | HTTP | Draft into `draft` status |

**Changed**
- `worker-tick` — dispatch `profile_edit` actions through `profile-apply`; enforce per-field-group frequency ceilings at reservation.
- `worker-planner` — schedule profile edits singly, never batched, one per sender per day, inside the schedule window.
- `worker-health` — QA score enters reporting; a critical QA failure (no photo) caps warmup promotion.

### 10.3 MCP tools

Read: `profile_get`, `profile_history`, `profile_qa`, `profile_authority_list`, `profile_templates_list`, `experiment_list`, `experiment_result`.

Write: `profile_draft_change` (creates a draft, never applies) · `profile_apply_change` (**confirmation-gated**, requires an existing draft id, refuses without authority) · `profile_revert` (**confirmation-gated**) · `profile_bulk_preview` / `profile_bulk_commit` (preview-token pattern, as `enroll_commit`) · `experiment_create` / `experiment_conclude` (**confirmation-gated**).

**Unattended tokens get read-only profile access.** No profile write of any kind, including drafts. An agent must never edit a person's professional identity without a human in the loop, and the cleanest way to guarantee that is to withhold the capability.

New `why_not_sending`-style causes: `E_NO_PROFILE_AUTHORITY`, `E_PROFILE_CEILING`, `E_PROFILE_WARMUP`, `E_PROFILE_QUIET_PERIOD`, `E_EXPERIMENT_LOCK`.

---

## 11. Rollout

| Phase | Weeks | Contents |
|---|---|---|
| **P0** | 1 | Serialiser + golden tests, action type, ceilings, snapshot store. No UI. |
| **P1** | 2 | Read-only: snapshots, QA score, drift detection, sender-card display. Zero write risk, immediate value. |
| **P2** | 3–4 | Authority grants, signed-link flow, owner notification, revert. |
| **P3** | 5–6 | Editor for headline / About / photo / cover, single-sender, `propose_only` default. Internal senders only. |
| **P4** | 7 | Experience, education, skills, location, custom link. |
| **P5** | 8–9 | Templates, bulk apply with pacing, campaign matching. |
| **P6** | 10–11 | Experiments with full statistical readout. |
| **P7** | 12 | MCP tools, AI drafting, reporting. |

**P1 before anything writable is deliberate.** QA scoring and drift detection deliver most of the visible value at zero account risk, and they generate the acceptance-rate correlation data that makes the experiment feature worth trusting when it ships.

---

## 12. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| A bad bulk apply writes wrong copy to 12 real profiles | Medium | **Severe** — reputational, on people who did not choose it | Per-sender validation, preview with rendered output, one-sender-per-hour pacing, 8/day workspace cap, owner notification with revert on each |
| Serialiser bug corrupts a work-history entry | Medium | High | Golden-file tests per field, strict unknown-key rejection, post-verify diff, snapshot before every write |
| Profile edits trigger a LinkedIn takeover flag | Low–Medium | High | Conservative ceilings, 72h post-connect quiet period, level-0 block, combined 4/week cap, single-field edits preferred |
| Operator edits a client employee's profile without real consent | Medium | **Severe** (legal, reputational) | Signed grant per field group from the owner's own email, `propose_only` default, unsuppressible notification, 30-day revert |
| Rollback advertised but not achievable for some fields | High without design | Medium | Per-field fidelity badges; written-only fields explicitly labelled |
| Experiment produces a false winner, operator rolls it out fleet-wide | **High** without design | Medium | No winner on a crossing CI, minimum senders per arm, cluster warning, required sample size stated up front |
| Unipile changes the field surface | Medium | Low | Field set is seeded data + a typed model in one module; a change is a migration |

---

## 13. Open questions

1. **Does `PATCH users/me/edit` return per-field results on partial success**, or only `{"object":"ProfileEdited"}`? If the latter, post-verify is the only signal — which is the assumption in §7.3. Confirm on the integration call.
2. **Image constraints** — Unipile documents `picture` and `cover_picture` as binary but not min/max dimensions, aspect or file-size limits. Establish empirically in P0 and encode in the validator, so an operator learns about a rejection in the editor rather than from a failed action.
3. **`location[id]` resolution** — confirm `GET linkedin/search/parameters` covers location IDs for profile editing, or whether a different parameter namespace applies.
4. **Experience `[id]` discovery** — editing an existing role needs its id. Confirm the rich profile fetch returns ids matching what the edit endpoint expects; if not, creating entries is possible but editing them is not, which materially reduces scope.
5. **Propagation delay** — how long before an applied change is visible to a `GET`? `profile-verify` assumes ≥60s; measure and tune.
6. **Does editing a profile notify connections implicitly**, even with `notify_network: false`? LinkedIn has historically surfaced some profile edits in feeds regardless. If so, cap headline experiments harder than §5.1 and say so in the UI.
7. **WhatsApp and Instagram authority** — a WhatsApp display name and About are lower-stakes than a LinkedIn work history. Should they share the full grant flow, or a lighter one? Leaning: same flow, fewer field groups, because the consistency is worth more than the saved clicks.
