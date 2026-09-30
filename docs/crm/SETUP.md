# Sales CRM — setup & runbook

The studio's sales standup CRM (built from `crm-master-prompt.md`). Everything is prefixed `crm_` / `crm-` / `/crm` so it stays separable from the investor product and the outreach platform.

## What exists

| Piece | Where |
|---|---|
| SQL (schema, rules, RPCs, seed) | `migrations/crm/001_schema.sql`, `002_functions.sql`, `003_seed.sql` |
| MCP connector (edge function) | `supabase/functions/crm-mcp/` → `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/crm-mcp/mcp` |
| Claude skill | `claude-skill/crm/` (+ `crm.zip`) |
| Web app | `app/crm/**`, `components/crm/**`, `lib/crm/**`, `contexts/CrmContext.tsx`; nav entry "Sales CRM" in `MainLayout` |
| Deploy script | `scripts/crm-deploy-functions.sh` |

## Access

Membership is the `crm_members` table; every active member sees and edits everything (RLS). Add people in **CRM → Settings → Team** (email of an existing CapitalxAI account) or with the connector tool `add_team_member`. Non-members see a "not on the team" screen and, in the connector, only `crm_whoami`.

## Rules enforced in the database (not just the UI)

1. A meeting becomes `held`/`no_show` only through `crm_capture_meeting` — a status update without a complete `crm_meeting_captures` row fails (`E_CAPTURE_REQUIRED`); an incomplete capture fails naming the missing fields (`E_CAPTURE_INCOMPLETE`).
2. Active deals without next step/date are surfaced as **stuck** (not blocked).
3. No activity for `stale_after_days` (default 14) → **stale** (computed in `crm_deals_v`).
4. Stage moves forward or to `lost`; backwards needs a reason (`E_STAGE_BACKWARD`). Every change writes `crm_stage_history` via trigger.
5. Values always carry a currency; unknown currency fails (`E_UNKNOWN_CURRENCY`). `crm_fx_rates` drives USD totals.

Verified with a rollback test block (T1–T12) on 2026-09-16; re-run it from the session notes if the triggers change.

## Applying SQL

```bash
# Management API (records nothing in supabase_migrations; idempotent files)
bash scripts/outreach-sql.sh migrations/crm/001_schema.sql
bash scripts/outreach-sql.sh migrations/crm/002_functions.sql
bash scripts/outreach-sql.sh migrations/crm/003_seed.sql      # seeds lookups/FX/team always, sample deals only on an empty CRM
```
Or paste each file into the Supabase MCP `apply_migration`. The seed's sample data is relative to "now" (3 meetings today, one uncaptured yesterday) — delete the `crm_companies` rows to remove it.

## Deploying the connector

```bash
CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/crm-deploy-functions.sh
# Docker not running? → OUTREACH_DEPLOY_EXTRA_ARGS="--use-api" bash scripts/crm-deploy-functions.sh
cd supabase/functions && deno check --node-modules-dir=none crm-mcp/index.ts   # type-check first
```
Connect in Claude (claude.ai connectors / Claude Desktop / Claude Code) with the URL above; OAuth goes through the project's Supabase Auth (consent page at `app.capitalxai.com/oauth/consent`). Upload `claude-skill/crm.zip` as the skill.

## Call recordings → capture + transcript

"I had a meeting with naman@domain.com today, here is the recording" runs with no questions. The flow lives in `claude-skill/crm/recording-pipeline.md`; transcription is the separate **get-transcript** skill (Deepgram Nova-3, speaker-diarized), which must be installed next to the `crm` skill.

- **Storage**: `crm_meeting_transcripts`, one row per meeting (`turns`, `speakers` with `role: prospect|team|unknown`, `full_text`, summary/topics, `low_confidence` words). Saving again replaces it. It never changes the capture.
- **Why a ticket, not a tool argument**: an hour of speech is ~10k words. `transcript_upload_ticket(meeting_id)` mints a single-use, 30-minute token bound to that meeting (only its SHA-256 is stored, in `crm_upload_tickets`); `claude-skill/crm/scripts/save_transcript.py` posts the get-transcript folder to `POST /crm-mcp/transcript` with it. That route is the one place the service-role client calls a CRM write RPC — `crm_save_transcript` verifies the ticket and writes as the member who minted it. `save_transcript` (turns as arguments) is the fallback when the script cannot reach the network.
- **Speaker indexes**: Deepgram's are 0-based; get-transcript prints them 1-based ("Speaker 1" = index 0). The script takes the printed label and does the mapping; the database and tools use the 0-based index.
- **Reading**: `get_transcript` (filter by `q` / `role` / time, with `context`), `transcripts_search` (across meetings; `role: "prospect"` = only what customers said), `set_transcript_speakers` to fix who is who. In the app: Companies → a company → **Transcript** on the meeting row.
- **Rebuild the skill zip** after editing the skill: `python scripts/crm-build-skill-zip.py` (Python zipfile — Compress-Archive's backslash paths are rejected by claude.ai).

## Call audio storage (Oracle Object Storage)

The call audio is kept too — one file per meeting, in the private `kaptured-storage` bucket (Mumbai) through Oracle's S3-compatible API, under `crm/recordings/<meeting_id>/`. `crm_meeting_recordings` holds the pointer. Background: `oracle-storage-setup.md`.

**Switch it on** (once): paste the real customer secret key pair into `oracle-storage.env` (git-ignored; access key 40 chars, secret 44), then
```bash
CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_... bash scripts/crm-set-storage-secrets.sh
```
It sets `CRM_S3_ENDPOINT / REGION / BUCKET / ACCESS_KEY_ID / SECRET_ACCESS_KEY` on the project and refuses placeholder values.

**A brand-new key is rejected for a few minutes.** Oracle creates a customer secret key in the tenancy's home region and replicates it; until it reaches Mumbai every request fails with `403 SignatureDoesNotMatch — "The secret key required to complete authentication could not be found"`. That message means *Oracle does not know this access key yet*, not that the signature is wrong (the official AWS SDK fails identically). On 2026-09-20 it took about four minutes. Wait and retry before touching any code or regenerating the key.

**If the secrets are ever missing** (a new environment, a rotated key not yet pushed), every recording route answers `E_STORAGE_NOT_CONFIGURED` and everything else keeps working: the skill prints `RECORDING_SKIPPED` and still saves the transcript.

- **The key never leaves crm-mcp.** `storage.ts` presigns SigV4 URLs itself (no AWS SDK; checked against the AWS documentation's worked example) — path-style, region `ap-mumbai-1`. Browser and script only get a short-lived URL for one object and talk to Oracle directly, so audio never passes through the function. Oracle answers CORS preflights with `allow-origin: *`, which is what lets the browser PUT.
- **One upload path, two callers** (`recordings.ts`): `POST /crm-mcp/recording/upload-url` → PUT to Oracle → `POST /recording/confirm` (HEADs the object, enforces the 300 MB cap — audio types only — then `crm_save_recording`; a replaced file's old object is deleted). Bearer is a member JWT (the app) or the upload ticket (the skill — peeked, not consumed; saving the transcript consumes it). `play-url` (6-hour link) and `delete` are JWT-only: a ticket can upload and nothing else. `crm_save_recording` refuses a key outside the meeting's own prefix.
- **Skill**: run get-transcript with `--keep-audio`; `save_transcript.py` finds `audio.flac`, shrinks it with ffmpeg to mono 32 kbps AAC `.m4a` (~15 MB per hour) and uploads it before the transcript. `get_recording_url` lets Claude transcribe audio that was uploaded from the app.
- **Audio only, never video.** A video is just a source: the skill pulls the audio track out (`ffmpeg -vn`) and, if it cannot, skips the audio rather than upload the video (`RECORDING_SKIPPED`). The app's picker takes audio files only, and `upload-url` refuses any non-audio content type (400) as a backstop. Reason: the bucket's free tier is 10 GiB — an hour of audio is ~15 MB, an hour of video is hundreds.
- **App**: Companies → a company → **Add recording** on a past meeting; the transcript view has the player, and each timestamp jumps the audio to that line.
- **Limits**: free tier is 10 GiB (≈ 650 hours at 15 MB). Deleting a meeting removes the row but not the object — orphans under `crm/recordings/` can be swept by listing the prefix against `crm_meeting_recordings.storage_key`.

## Hooks left for later (schema-ready, not built)

- `crm_deals.delivery_project_id` — join to the client portal.
- `crm_activities.external_ref` (unique) + `log_activity` upsert — machine-written LinkedIn/email activity from the outreach platform.
- `crm_company_brief` — clean JSON for a proposal/deck generator.

## Google Calendar (team calendars, Meet links, meeting ↔ event link)

What it is: every CRM member connects their own Google account(s) once — work, personal, or both, one of them the
default — and the whole team sees each other's events on `/crm/calendar` (only the owner books, moves or cancels on
theirs). Booking a CRM meeting (company page, `schedule_meeting`) also creates the Google event with a Meet link and
invites; an event booked on the Calendar screen (or `calendar_create_event` with `crm{…}`) can be attached to a
company/deal and becomes a CRM meeting; moving or cancelling either side updates the other. The connector tools
(`calendar_*`) and the screen share one service, `supabase/functions/crm-mcp/calendar.ts`; the skill's rules are in
`claude-skill/crm/calendar-pipeline.md`.

Where things live:
- SQL: `migrations/crm/004_calendar.sql` — `crm_calendar_accounts` (refresh token AES-256-GCM encrypted; **no RLS
  policy for authenticated**, members read it only through `crm_calendar_accounts_list()`), `crm_meeting_calendar_events`
  (one Google event per meeting), `crm_meetings_v` gained `has_calendar_event / meet_link / calendar_link /
  calendar_account` (appended last), `crm_whos_meeting_today` + `crm_company_brief` carry `meet_link`.
- SQL: `migrations/crm/005_invite_templates.sql` — two team settings decide what every invite the CRM books says: `invite_title_template` (default `{me} <> {who}`) and `invite_description_template` (default `{notes}

{company} · {contact}`). Placeholders `{me}` `{me_full}` `{who}` `{contact}` `{contact_first}` `{company}` `{studio}` `{notes}`; separators next to an empty value are dropped. Rendered by `crm-mcp/invite_template.ts` (mirror: `lib/crm/invite.ts`) in `createEventForMeeting` (schedule_meeting, calendar_event_for_meeting, Add to Google Calendar) and pre-filled on the Calendar screen's New event once a company is attached. Edited in **CRM → Settings → Calendar invites**. The Calendar screen also has a view-timezone toggle (team default / India / US / UK / any IANA zone, per browser) and a per-event time zone on the form; both just pass `tz` to the existing routes.
- Edge: `crm-mcp/calendar.ts` (service), `calendar_routes.ts` (`GET /calendar/callback`, `POST /calendar/*` for the app),
  `tools_calendar.ts` (connector tools). `schedule_meeting` / `update_meeting` call into it.
- App: `app/crm/calendar/page.tsx`, `components/crm/calendar.tsx`, `lib/crm/calendar.ts`; "Also create the Google
  Calendar event" on the Schedule-meeting modal; Join Meet on the standup and company page.

One-time setup (admin) — DONE 2026-09-30 with Desk's own client, no Google console work:
1. `CAPITALXAI_SUPABASE_ACCESS_TOKEN=sbp_… bash scripts/crm-set-calendar-secrets.sh ../recorder-app/CallRecorder/resources/google_oauth_client.json`
   sets `CRM_GOOGLE_CLIENT_ID/SECRET`, `CRM_GOOGLE_CLIENT_KIND=desktop` and a generated `CRM_TOKEN_KEY`, and keeps a copy
   in `google-calendar.env` (git-ignored; keep it — a lost key means everyone reconnects; re-runs reuse it).
2. Desk's client is a Desktop client: Google only returns to loopback addresses. So on `localhost`/`127.0.0.1` the app
   gets Google straight back at `/crm/calendar/google`; on the hosted app, and in Claude/ChatGPT
   (`calendar_connect_link` → `calendar_connect_finish`), Google lands on `http://127.0.0.1:53682/…` which does not load
   and the member pastes that address back once per account. If the consent screen is in Testing, each member's Google
   account must be a Test user (Desk's already are).
3. Optional, for a fully automatic hosted flow: create a **Web application** client in the same project with redirect URI
   `https://ktwqkvjuzsunssudqnrt.supabase.co/functions/v1/crm-mcp/calendar/callback` and re-run the script with its JSON
   (it detects `"web"` and sets `CRM_GOOGLE_CLIENT_KIND=web`). Existing connections keep working only if the client id
   stays the same, so members reconnect after switching clients.
4. Each member: CRM → Calendar → **Connect Google Calendar** (or ask the assistant). Allow every permission — a read-only
   grant is flagged on the chip. Repeat for a second account; label them (work / personal) from the pencil on the chip.

Without the secrets every calendar route/tool answers `E_CALENDAR_NOT_CONFIGURED`; the rest of the CRM is unaffected.
Scopes asked: exactly Desk's — `calendar.events`, `calendar.calendarlist.readonly`, `openid email`. Guests' free/busy is best effort (reported as not visible when Google refuses).
