# Master Prompt — Kaptured Sales CRM + MCP

Paste everything below the line into Claude Code in a fresh repo.

---

Build a sales CRM for a video production studio, plus an MCP server that drives it, so the whole sales operation runs through chat and a daily standup screen.

## Stack

- Supabase (Postgres + Row Level Security + Edge Functions)
- React frontend
- MCP server as a Supabase Edge Function at `/sales-mcp/mcp`, same pattern as a standard remote MCP server over HTTP
- No auth complexity: single internal team, email/password auth, everyone sees everything

## What this replaces

Today the sales standup depends on people remembering what happened. The CRM's job is to make the meeting read itself, and to make post-meeting capture take under a minute. Every design decision serves those two things. It is not a general-purpose CRM — do not build features that don't serve them.

## Core objects

**company** — name, website, country, icp_segment_id, source_channel_id, notes, created_at

**icp_segment** — a lookup table, not an enum. Columns: id, slug, label, is_active, sort_order, notes. New segments get added from the UI by a normal insert, never a migration. Seed it with: PocketFM / story, Info products + schools + app, Performance marketing (D2C), US agencies (outsource), Pharma, SMBs / coaches, Music labels. Expect this list to grow and to be reordered as priorities change, so nothing in the code may hardcode a slug or assume a fixed count. Deactivate with `is_active` rather than deleting, so historical deals keep their segment.

**source_channel** — same pattern, same reasons. Seed with: LinkedIn, cold call, email, SEO, referral, inbound social, Reddit. New channels will appear as growth experiments run.

Apply this rule anywhere else a list of business categories shows up: if the business could plausibly add a value to it next quarter, it's a lookup table with `is_active` and `sort_order`, not an enum. Deal stage is the deliberate exception — stages are workflow logic the code reasons about, so that one stays an enum.

**contact** — belongs to company; name, role, email, phone, linkedin_url, timezone

**deal** — belongs to company; stage, owner, value_monthly_usd, videos_per_month, currency, expected_close_date, next_step, next_step_date, lost_reason, created_at, closed_at

Stage enum, in order: `new`, `contacted`, `replied`, `meeting_booked`, `meeting_held`, `proposal_sent`, `negotiation`, `won`, `lost`.

Every stage change writes a row to **stage_history** (deal_id, from_stage, to_stage, changed_at). Velocity reporting depends on this, so never update stage without writing history.

**activity** — belongs to contact and optionally deal; activity_type_id (lookup table, seeded with call, LinkedIn message, LinkedIn connect, email, meeting — new types will appear as channels are added); direction `outbound`/`inbound`; occurred_at; source_channel_id; body; outcome

**meeting** — belongs to deal; scheduled_at, attendees, status enum `scheduled`, `held`, `no_show`, `cancelled`

**meeting_capture** — belongs to meeting, one row per meeting. Two shapes depending on outcome.

For a held meeting:
- pain_points (text array — capture them in the prospect's own words, not paraphrased)
- commercials_discussed (price quoted, volume, currency)
- objections (text array)
- next_step (text) and next_step_date (date)
- is_dead (boolean) and dead_reason

For a no-show:
- no_show_reason
- follow_up_action, follow_up_date
- is_repeat_no_show (computed from prior meetings for the same contact)

**pain_point_tag** — normalised tags linked to captures, so common pain points can be counted across deals over time.

**daily_numbers** — a daily roll-up per channel: dials, connects, linkedin_accepts, replies, meetings_booked, meetings_held, no_shows, proposals_sent, closes. Computed from activities, not hand-entered. Derive the channel rows from the source_channel table at query time so a newly added channel appears in the scoreboard automatically, with no code change.

## Hard rules to enforce in the database

1. A meeting cannot move to status `held` or `no_show` without a matching meeting_capture row. Enforce with a constraint or trigger, not just UI validation. This is the single most important rule in the system — without it the no-show half of the data ends up empty.
2. Every deal in an active stage must have a next_step and next_step_date. Surface violations as "stuck" rather than blocking the write.
3. A deal older than 14 days with no activity is flagged stale automatically.
4. Stage can only move forward, or to `lost`. Moving backwards requires an explicit reason written to stage_history.

## MCP tools

Name them plainly. Each returns structured data, not prose.

**Morning brief**
- `whos_meeting_today()` — every meeting scheduled today. For each: company, contact, role, ICP segment, source channel, deal stage, value, full activity history with that contact, last meeting's capture if any, and anything in company notes. This is the single call that runs before the daily sales meeting.
- `daily_scoreboard(date)` — yesterday's seven numbers per channel plus totals, and the same numbers for the trailing 7 days for comparison.
- `deals_needing_attention()` — three lists: stuck (no next step), stale (no activity in 14 days), and slipping (next_step_date in the past).

**In the meeting**
- `log_commitment(owner, date, targets)` — records what each person committed to today.
- `commitment_vs_actual(date_range)` — what was committed against what the activity log shows. Used to spot repeat misses.

**After a meeting**
- `capture_meeting(meeting_id, outcome, ...)` — the main write. If outcome is `held`, require pain_points, commercials_discussed and either next_step + date or is_dead + reason. If `no_show`, require reason and follow_up. Reject the call with a specific message naming what's missing rather than writing a partial row.
- `update_deal(deal_id, ...)` — stage, value, next step. Writes stage_history automatically.
- `log_activity(...)` — any touch on any channel.

**Pipeline and analysis**
- `pipeline(filters)` — deals by stage, with value and age in stage.
- `funnel(date_range, source_channel_id)` — leads, conversion at each stage, cost if entered, and the CAC/LTV columns left nullable for manual entry.
- `top_pain_points(date_range, icp_segment_id)` — ranked pain point tags. This feeds messaging and showreel decisions.
- `channel_quality(date_range)` — per channel: meetings booked, no-show rate, close rate, average deal value. No-show rate by channel is the lead-quality signal, so make it prominent.
- `company_brief(company_id)` — everything known about one company, formatted for building a proposal or deck.

## Frontend

Four screens only. Resist adding more.

1. **Standup** — the only screen open during the daily meeting. Yesterday's seven numbers at the top, then today's meetings, then stuck/stale/slipping deals, then today's commitments. One screen, no scrolling on a laptop, readable across a room.
2. **Pipeline** — kanban by stage, drag to move, card shows company, value, days in stage, next step. Stale cards visibly marked.
3. **Company** — everything about one account: contacts, deals, full activity timeline, every past meeting capture.
4. **Capture** — the post-meeting form. It must be fillable in under a minute: outcome first, then only the fields that outcome needs. Pain points as free text that tokenises into tags on save.

## Design constraints

- Fast over pretty, but not ugly. Dense tables, keyboard-navigable, no modal stacking.
- Timezone-aware throughout — deals span India, UK, Dubai and US.
- Currency stored with the value; never store a bare number.
- Everything the MCP can do, the UI can do, and the reverse. No MCP-only or UI-only paths.
- Add a small Settings screen for managing the lookup lists — add an ICP segment, add a channel, reorder, deactivate. It doesn't need to be pretty, but adding a new segment must never require a developer.
- Seed the database with 15 realistic sample deals spread across the seeded ICP segments so the screens can be judged with data in them.

## Build order

1. Schema, constraints and triggers, with the meeting-capture rule proven by a test that tries to violate it
2. MCP server with `whos_meeting_today`, `daily_scoreboard` and `capture_meeting` — the three that make the standup work
3. Standup screen
4. Capture screen
5. Pipeline and Company screens
6. The remaining analysis tools

Ship step 3 working before starting step 4. At each step, tell me what you built and what you chose not to build.

## Leave hooks for later

Do not build these now, but structure the schema so they drop in without migration pain:

- A `delivery_project_id` column on deal, for joining to the client portal later
- Activity ingestion from an external outreach tool, so LinkedIn and email activity can be written by machine rather than by hand
- A proposal/deck generator that reads `company_brief` — the reason for building rather than renting is this join between sales context and delivery data, so keep company_brief clean enough to feed it
