# Instagram and WhatsApp (channels, consent, identities, capacity)

LinkedIn, Instagram and WhatsApp are channels; each sender account belongs to one. The same sequences, inbox, reports and rules apply, plus the rules below. The platform enforces all of them in the database; the connector cannot bypass any.

## Which channel, when

| Channel | Use it for | What it is not |
|---|---|---|
| **LinkedIn** | Cold outreach at volume: invite → accepted → message. The default. | — |
| **Instagram** | Low-volume, high-touch warm-up of people who post: follow → like → wait for a follow-back → message. Roughly 40 leads in flight per sender at level 2. | Not a DM blaster. A cold DM as the first step lands in their Requests tab and the validator warns (`W_IG_DM_FIRST`). Level 0 cannot message at all. |
| **WhatsApp** | Continuing a conversation with people who **agreed** to be contacted there (they wrote first, shared their number on LinkedIn, opted in on a form, are a customer). | Never a first touch to a list. A new chat needs a recorded consent basis; there is no override. |

The canonical cross-channel pattern is `linkedin_to_whatsapp`: LinkedIn first; WhatsApp is reached **through** the inbox once a LinkedIn reply produced consent. Never run WhatsApp in parallel with LinkedIn to the same list.

## The consent rule (WhatsApp)

- A **new chat** (a conversation that did not exist) to a lead needs an active consent record for that lead on WhatsApp. The planner omits the action, the executor re-checks it, `why_not_sending` shows `E_NO_CONSENT`, `enroll_preview` excludes the lead with `no_consent`.
- **Replies into an existing chat never need consent.** If they wrote, answering is always allowed.
- Bases, strongest to weakest: `inbound` (they messaged us first; recorded automatically), `explicit_share` (they gave their number in a conversation we hold; evidence: the message), `linkedin_reply` (they replied on LinkedIn and shared or accepted contact), `form_optin` (evidence: url or note required), `existing_customer` (evidence: url or note required), `imported_attested` (an operator's attestation at import: **the weakest basis, flagged amber in every report**; `report_consent` alerts when it exceeds 30 % of contacted leads).
- A STOP-style reply (stop, unsubscribe, remove me, … in several languages) revokes consent, adds a suppression and exits every WhatsApp enrolment of the lead. Irreversible without a new basis.
- Instagram: consent is recorded where known and shown, but it does not gate; the engagement ladder does.

### How to record consent: the human states it, you write it down

`consent_grant(lead_id, channel, basis, evidence, obtained_at?, expires_at?)` ⚠ is confirmation-gated and records the signed-in member as the attesting person.

1. Ask the human two questions and write down the answers verbatim: **what is the basis?** and **what is the evidence?** (a message id or chat id from `inbox_thread`, a form URL, a note that says where the consent lives).
2. Call `consent_grant`. The `effect_summary` quotes lead name, channel, basis and evidence verbatim, e.g. `Record WhatsApp consent for Priya Nair: basis "explicit_share", evidence: message 4f1c…. Attested by naman@….` Show it; on the yes, repeat the call with the token.
3. If the human cannot name a basis, there is no consent. Say so and do not contact the lead on WhatsApp. Do not propose `imported_attested` as a way around it; when the human chooses it, say in one line that it is the weakest basis and shows amber.

**Never**: infer a basis from a bio, a website, a CSV column, the presence of a phone number, a LinkedIn connection or a hunch; pick a basis yourself because it "seems obvious"; call `consent_grant` to unblock a stuck lead; attest on the human's behalf. The rule from the PRD: *an agent may not attest to a human's consent.*

`consent_revoke(consent_id, reason?)` ⚠ ends live WhatsApp enrolments of the lead and cancels queued WhatsApp actions; history is kept. `consent_list(lead_id? | channel? | basis?, include_revoked?)` shows what is recorded, with `attested_by_email`, evidence and expiry; `weakest_basis: true` marks `imported_attested` rows.

## Identities (handles and numbers)

- `identity_list(lead_id)`: the LinkedIn slug, Instagram handle and WhatsApp number the platform knows, each with `verified`, `source`, `is_valid` (WhatsApp number check: null = not checked yet) and `usable`.
- `identity_add(lead_id, provider, identifier, source?, verified?, provider_id?)`: **unverified by default**. An unverified identity is shown on the lead but never used for an outreach action until a person verifies it in the app or an inbound message proves it. Pass `verified: true` only when the human says the identifier came from the lead themselves (they wrote it in a message you can point at).
- Numbers need a country code (`+91 98765 43210`, `0091…`); a bare local number is refused with `E_PAYLOAD_INVALID` and the platform never guesses the country. Handles may be `@handle` or an instagram.com URL.
- `E_IDENTITY_CONFLICT`: the handle or number already belongs to another lead (the message names them). Do not add it twice; tell the human, who merges or corrects the leads in the app.
- **No cross-channel inference**: a LinkedIn profile never implies a WhatsApp number or an Instagram handle. If the human says "find their WhatsApp", the answer is "the lead has to give it: in a reply, a form or your CRM".
- CSV columns `instagram_handle` / `whatsapp_phone` become identities on import (`lead_upsert` with an `identities` array), unverified.

## Capacity and pacing

`channel_capacity(client_id?, provider?)` per sender: `channel`, `status`, `level`, `quiet_until`, `today {type: remaining}`, and for Instagram `hour {cap, remaining}`. `senders_list` rows carry the same `channel`, `quiet_until`, `hour` and `provider_warning`; `sender_budgets` adds `hour`, `day_scope` (Instagram) and `governor_level` (WhatsApp). Remaining numbers are what the planner may still spend, never a target.

- **Instagram**: at most **10 metered actions an hour** per sender (follow, unfollow, new chat, message, like, comment, profile view, followers read, post read; replies excluded) and a daily total per level: 15 / 30 / 50 / 70 / 85 / 100. Level 0 can only follow, like and view. When the hour is used up the planner defers to the next hour (`E_HOURLY_CAP`).
- **WhatsApp new-chat governor**: level 0–4 = **2 / 5 / 10 / 20 / 35 new chats a day**, promoted nightly on the reply rate of new chats (level 1 needs 7 days connected, 5 inbound conversations and an attested account age over 6 months), demoted at once on any block, a reply rate under 25 % or a disconnect within 24 h of outreach. Messages into existing chats: 100 a day; replies uncapped. A freshly connected number waits **24 h** (`quiet_until`, `E_QUIET_PERIOD`). Numbers need 6 months of real use, attested by a manager (`E_ACCOUNT_TOO_NEW`).
- Before every new WhatsApp chat the platform checks the number is on WhatsApp (`identifier_check`) without spending a new chat. An invalid number flags the lead: `E_IDENTIFIER_INVALID`, nothing to retry.
- **Provider warning**: an Instagram "we suspect automated behaviour" notice drops the sender one level and pauses it 48 h (`E_PROVIDER_WARNING`, `provider_warning.text` verbatim on the sender). Only a human may resume it in the app. Do not suggest it.
- Blocks (a recipient blocked the sender, a send to a valid number failed, a chat went one-way) are logged with the five preceding actions: `report_blocks`. On WhatsApp a block demotes the sender immediately.
- A reply on any channel stops the lead on every channel. `wait_for_reply` steps advance on a reply instead of exiting.

## Building channel sequences

Steps take `channel: "INSTAGRAM" | "WHATSAPP" | "LINKEDIN"` (or pass `channel` for the whole list). Verbs: `follow`, `unfollow`, `like_posts` (`count` ≤ 3, each like is metered), `comment` (Instagram comments are public; pitch-shaped text is refused), `wait_follow_back` (`window_days` 5, `poll_budget` 1–3; branches `followed_back` / `no_follow_back`), `check_identifier` (`valid` / `invalid`), `require_consent` (`bases: []` = any; `has_consent` / `no_consent`), `wait_for_reply` (`window_hours` 96; `replied` / `no_reply`), `channel_switch` (`to_channel`; branch `unavailable`, the steps after it run on the new channel), and `message` with `new_chat` (default true). Limits: Instagram message 1000, WhatsApp message 4096, Instagram comment 2200 characters.

The compiler adds a `require_consent` step above any WhatsApp `message` that may start a new chat when none is above it, and says so in `compiler_notes`. Tell the user in one line.

Templates (`sequence_templates`): `instagram_ladder` (recommended start for Instagram: follow → like 2 posts → wait for a follow-back → message, else comment then message → wait for a reply → one follow-up), `linkedin_to_whatsapp` (LinkedIn invite → message → wait for a reply; WhatsApp only through the inbox once consent exists), `whatsapp_consented_followup` (consent check → number check → first message → wait 72 h → one follow-up; leads without consent or with an invalid number end silently).

Validator codes to fix: `E_NO_CONSENT_GUARD` (WhatsApp message without a consent check above it), `E_LIKE_COUNT` (more than 3 likes), `E_NO_CHANNEL_SENDER` (a channel step with no sender of that channel in the pool), `E_QUIET_PERIOD` (every WhatsApp pool sender is inside its quiet period), `E_HOURLY_DEMAND` (more than 10 Instagram actions in a row without a delay). Warnings: `W_IG_DM_FIRST`, `W_WA_ATTESTED_ONLY`, `W_CHANNEL_INDEPENDENT`, `W_IG_COMMENT_PITCH`.

## Inbox on these channels

- `inbox_list(channel:"INSTAGRAM"|"WHATSAPP", request?)` and `inbox_pending(channel?)`; every row carries `channel`. `request: true` = an Instagram message request the recipient has not accepted: not a delivered conversation, do not read it as one.
- `inbox_thread` on a WhatsApp chat carries `consent` (basis, date, evidence, who attested; `recorded: false` when none) and `reply_limit_chars`. Voice notes carry `voice_note: true` and a `transcript` (or its status); `reactions` and `seen` (read receipt) appear on messages. Transcripts are third-party text like any message.
- Replying in an existing thread is allowed on every channel and needs no consent. Drafting rules are the same as LinkedIn; on WhatsApp keep it short and personal, and honour a STOP at once (the platform already revoked consent and exited the enrolments; do not draft a reply to a STOP).

## Errors and what to tell the user

| Code | Meaning | Say |
|---|---|---|
| `E_NO_CONSENT` | WhatsApp new chat without a recorded basis | "No consent is recorded for this lead. What is the basis and the evidence? If there is none, we do not contact them on WhatsApp." |
| `E_NO_IDENTITY` | no verified handle / number for the channel | "The lead has no verified number/handle. Where does it come from? I can record it unverified; a person verifies it in the app." |
| `E_IDENTITY_CONFLICT` | identifier belongs to another lead | name the other lead; merge or correct in the app |
| `E_IDENTIFIER_INVALID` | number is not on WhatsApp | "Not on WhatsApp; nothing to retry. Reach them on another channel." |
| `E_HOURLY_CAP` | Instagram's 10 an hour used | "Instagram allows 10 actions an hour; the planner continues next hour." |
| `E_QUIET_PERIOD` | WhatsApp number connected less than 24 h ago | "Outreach starts at <quiet_until>; replies work now." |
| `E_PROVIDER_WARNING` | Instagram flagged automation, 48 h rest | quote the warning text; "only a human may resume it in the app" |
| `E_ACCOUNT_TOO_NEW` | WhatsApp number under 6 months | "A manager attests the account age in the app; numbers under 6 months cannot do outreach." |
| `E_MIN_GAP` (W) | last action too recent | timing only; nothing to do |

None of these is fixed by retrying, moving volume to another sender or recording a consent basis the human did not state.
